#!/usr/bin/env node
// Cyber Defense, Step 10 — the daily backup, from GitHub Actions
// ─────────────────────────────────────────────────────────────────────────────
// Run by .github/workflows/backup.yml. It holds one secret, BACKUP_TRIGGER_SECRET,
// and one address, BACKUP_SERVICE_URL. It never sees the database, the bucket or
// any key: the backup runs inside the service, which already has them.
//
//   1. wake     GET /healthz until the service answers (a free instance sleeps)
//   2. trigger  POST /internal/backups/run, signed; 202 gives the run id
//   3. wait     GET /internal/backups/runs/:id, signed, until it succeeds or fails
//
// Exit 0 when the run succeeded, or when a backup already succeeded within the
// last 12 hours; exit 1 otherwise, so a failed backup is a failed workflow run
// and GitHub emails the owner. Output is states and status codes only — never
// the secret, a signature or a response body beyond its state.

'use strict';

const { createHmac } = require('crypto');

function sign(secret, method, path, timestamp) {
  return createHmac('sha256', secret).update(`${method.toUpperCase()}\n${path}\n${timestamp}`).digest('hex');
}

const DEFAULTS = {
  wakeTimeoutMs: 8 * 60 * 1000,
  wakeIntervalMs: 15 * 1000,
  pollTimeoutMs: 60 * 60 * 1000,
  pollIntervalMs: 20 * 1000,
  requestTimeoutMs: 30 * 1000,
};

async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => process.stdout.write(`${line}\n`),
  nowSeconds = () => Math.floor(Date.now() / 1000),
  allowHttp = false,
  timings = {},
} = {}) {
  const t = { ...DEFAULTS, ...timings };
  const secret = String(env.BACKUP_TRIGGER_SECRET || '');
  const rawUrl = String(env.BACKUP_SERVICE_URL || '').trim();
  if (secret.length < 32) { log('backup: BACKUP_TRIGGER_SECRET is missing or too short'); return 1; }
  let base;
  try { base = new URL(rawUrl); } catch { log('backup: BACKUP_SERVICE_URL is not a valid URL'); return 1; }
  if (base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) { log('backup: BACKUP_SERVICE_URL must use https'); return 1; }
  const origin = base.origin;

  const request = async (method, path, signed) => {
    const headers = {};
    if (signed) {
      const ts = String(nowSeconds());
      headers['x-backup-timestamp'] = ts;
      headers['x-backup-signature'] = sign(secret, method, path, ts);
    }
    const res = await fetchImpl(`${origin}${path}`, { method, headers, signal: AbortSignal.timeout(t.requestTimeoutMs) });
    let body = {};
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body: body && typeof body === 'object' ? body : {} };
  };

  // 1 · wake
  const wakeUntil = Date.now() + t.wakeTimeoutMs;
  for (;;) {
    try {
      const r = await request('GET', '/healthz', false);
      if (r.status === 200) { log('backup: service is awake'); break; }
      log(`backup: waiting for the service (healthz ${r.status})`);
    } catch {
      log('backup: waiting for the service (no answer yet)');
    }
    if (Date.now() >= wakeUntil) { log('backup: the service did not wake up in time'); return 1; }
    await sleep(t.wakeIntervalMs);
  }

  // 2 · trigger
  let started;
  try {
    started = await request('POST', '/internal/backups/run', true);
  } catch {
    log('backup: the trigger request failed');
    return 1;
  }
  let id;
  switch (started.status) {
    case 202: id = started.body.id; log('backup: started'); break;
    case 409:
      id = started.body.id;
      if (!id) { log('backup: another backup holds the lock and its run is unknown'); return 1; }
      log('backup: a backup is already running; waiting for it');
      break;
    case 429: log('backup: a backup already succeeded in the last 12 hours; nothing to do'); return 0;
    case 401: log('backup: refused as unauthorized (check the secret and the runner clock)'); return 1;
    case 503: log('backup: the service is not configured for backups'); return 1;
    default: log(`backup: unexpected answer ${started.status}`); return 1;
  }
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) { log('backup: the service did not return a run id'); return 1; }

  // 3 · wait
  const pollUntil = Date.now() + t.pollTimeoutMs;
  for (;;) {
    await sleep(t.pollIntervalMs);
    let r;
    try {
      r = await request('GET', `/internal/backups/runs/${id}`, true);
    } catch {
      log('backup: status request failed; retrying');
      if (Date.now() >= pollUntil) { log('backup: timed out waiting for the result'); return 1; }
      continue;
    }
    if (r.status === 200 && r.body.state === 'succeeded') { log('backup: succeeded'); return 0; }
    if (r.status === 200 && r.body.state === 'failed') { log('backup: FAILED — see the service log and the BackupRecord'); return 1; }
    if (r.status === 404) { log('backup: the run is unknown to the service'); return 1; }
    if (r.status !== 200) log(`backup: status answered ${r.status}; retrying`);
    else log('backup: running');
    if (Date.now() >= pollUntil) { log('backup: timed out waiting for the result'); return 1; }
  }
}

module.exports = { main, sign };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
