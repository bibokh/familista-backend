#!/usr/bin/env node
/* eslint-disable no-console */
// Apply Prisma migrations against a database that may be asleep
// ─────────────────────────────────────────────────────────────────────────────
// Production runs on Neon. A Neon compute suspends when idle and is woken by
// the first connection, and waking takes seconds — sometimes more than the five
// Prisma waits by default. `prisma migrate deploy` then fails with
//
//   P1002: The database server was reached but timed out
//
// which is not a migration error at all: nothing was applied, nothing was
// half-applied, and the same command a moment later succeeds. Retrying the
// deploy is therefore the correct response, and this file is the only place
// that decides when a failure is that kind of failure.
//
// ── What it does, in order
//
//   1. Chooses the URL migrations run on: MIGRATE_DATABASE_URL, then
//      DIRECT_URL, then DATABASE_URL. Neon's pooled endpoint (a "-pooler"
//      host, pgBouncer) cannot run migrations reliably — advisory locks and
//      session state do not survive a transaction pooler — so a pooled URL
//      with no direct alternative is called out loudly rather than silently
//      retried into the same wall.
//   2. Raises `connect_timeout` for the migration connection only, so waking a
//      suspended compute is not mistaken for an unreachable one. The
//      application's own pool is untouched.
//   3. Waits for the database to answer `SELECT 1` before running anything.
//      This is the step that actually wakes Neon, and it costs nothing when the
//      database is already awake.
//   4. Runs `prisma migrate deploy`, and retries ONLY when the failure is a
//      connection-level one. A genuine migration error — a failed statement, a
//      drifted history — is returned immediately and untouched, because
//      retrying those is how a database gets damaged.
//
// ── Why retrying cannot duplicate anything
//
// `migrate deploy` records each migration in `_prisma_migrations` in the same
// transaction that applies it, and takes a Postgres advisory lock for the run.
// A run that never connected applied nothing and recorded nothing; a run that
// connected and applied N migrations records those N and skips them next time.
// So a retry either resumes where the last one stopped or is a no-op. Nothing
// here resets, drops, seeds or force-marks anything: this file only ever calls
// `migrate deploy`.

const { spawnSync } = require('child_process');

const SCHEMA = '--schema=prisma/schema.prisma';

/**
 * Failures that mean "the database did not answer", as opposed to "the
 * migration is wrong". Only these are retried.
 *
 *   P1001 cannot reach the database server
 *   P1002 the server was reached but timed out          ← Neon waking up
 *   P1008 operation timed out
 *   P1017 the server closed the connection
 *   P2024 timed out fetching a connection from the pool
 *
 * Everything else — P3009 a failed migration in history, P3018 a migration
 * that errored, a syntax error in SQL — is a real problem that a retry would
 * only repeat.
 */
const TRANSIENT = /\b(P1001|P1002|P1008|P1017|P2024)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Timed out fetching|Can't reach database server|Connection terminated|server closed the connection/i;

function isTransientConnectionError(text) {
  if (!text) return false;
  // A genuine migration failure can quote a connection code in its own body;
  // the migration codes win, because those must never be retried.
  if (/\b(P3005|P3006|P3009|P3014|P3018|P3019)\b/.test(text)) return false;
  return TRANSIENT.test(text);
}

/** The URL migrations run on, and how it was chosen. */
function migrationUrl(env = process.env) {
  const direct = env.MIGRATE_DATABASE_URL || env.DIRECT_URL || null;
  const url = direct || env.DATABASE_URL || null;
  return {
    url,
    source: env.MIGRATE_DATABASE_URL ? 'MIGRATE_DATABASE_URL'
      : env.DIRECT_URL ? 'DIRECT_URL'
      : url ? 'DATABASE_URL' : null,
    pooled: !!url && /-pooler\./.test(url),
    direct: !!direct,
  };
}

/**
 * The same URL with a connection timeout long enough to wake a suspended
 * compute. An operator who set one already keeps it — this only fills a gap.
 * Nothing else about the URL is rewritten: not the host, not the credentials,
 * not sslmode.
 */
function withConnectTimeout(url, seconds) {
  if (!url) return url;
  if (/[?&]connect_timeout=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `connect_timeout=${seconds}`;
}

function sleep(ms) {
  const until = Date.now() + ms;
  // Synchronous on purpose: this script is a sequence of blocking steps and has
  // no event loop worth keeping free.
  while (Date.now() < until) { /* wait */ }
}

async function waitForDatabase(url, { deadlineMs, log = console.log }) {
  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); } catch (_) {
    log('==> @prisma/client not generated yet — skipping the reachability wait');
    return true;
  }
  const started = Date.now();
  let attempt = 0;
  let delay = 2000;
  for (;;) {
    attempt++;
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      await client.$queryRaw`SELECT 1`;
      await client.$disconnect();
      log(`==> database answered on attempt ${attempt} (${Date.now() - started}ms)`);
      return true;
    } catch (err) {
      try { await client.$disconnect(); } catch (_) { /* already gone */ }
      const text = String((err && err.message) || err);
      const transient = isTransientConnectionError(text);
      if (Date.now() - started + delay > deadlineMs || !transient) {
        log(`==> database did not answer after ${attempt} attempt(s): ${text.split('\n')[0]}`);
        return false;
      }
      log(`==> database asleep or unreachable (attempt ${attempt}) — waking, retry in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
}

function runDeploy(env, log = console.log) {
  const res = spawnSync('npx', ['prisma', 'migrate', 'deploy', SCHEMA], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (out.trim()) log(out.trimEnd());
  return { code: res.status == null ? 1 : res.status, out };
}

async function main() {
  const chosen = migrationUrl();
  if (!chosen.url) {
    console.error('==> no DATABASE_URL (or DIRECT_URL / MIGRATE_DATABASE_URL) is set');
    process.exit(1);
  }
  console.log(`==> migrations will run on ${chosen.source}`);
  if (chosen.pooled && !chosen.direct) {
    // Not fatal: some deployments do run migrations through the pooler. It is
    // said plainly because it is the most likely cause of a timeout that keeps
    // coming back, and the fix is one environment variable.
    console.log('==> WARNING: that URL is Neon\'s POOLED endpoint (-pooler). Migrations want a direct');
    console.log('==>          connection — set DIRECT_URL to the non-pooled host and redeploy.');
  }

  const timeout = Number(process.env.MIGRATE_CONNECT_TIMEOUT || 30);
  const url = withConnectTimeout(chosen.url, timeout);
  const deadline = Number(process.env.MIGRATE_WAIT_MS || 180000);

  console.log(`==> waiting for the database (up to ${Math.round(deadline / 1000)}s, connect_timeout=${timeout}s)`);
  await waitForDatabase(url, { deadlineMs: deadline });

  const env = { ...process.env, DATABASE_URL: url };
  const attempts = Number(process.env.MIGRATE_MAX_ATTEMPTS || 5);
  let delay = 5000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`==> prisma migrate deploy (attempt ${attempt}/${attempts})`);
    const { code, out } = runDeploy(env);
    if (code === 0) {
      console.log('==> migrations up to date');
      process.exit(0);
    }
    if (!isTransientConnectionError(out)) {
      // A real migration problem. Returned as-is so the caller's existing
      // recovery path — resolving baseline migrations — runs exactly as before.
      console.log('==> migrate deploy failed for a reason a retry cannot fix');
      process.exit(code);
    }
    if (attempt === attempts) {
      console.log('==> migrate deploy still timing out after every attempt');
      process.exit(code);
    }
    console.log(`==> connection-level failure — retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }
}

module.exports = { isTransientConnectionError, migrationUrl, withConnectTimeout, waitForDatabase, sleep };

if (require.main === module) {
  main().catch((err) => {
    console.error(`==> ${(err && err.message) || err}`);
    process.exit(1);
  });
}
