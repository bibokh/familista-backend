/**
 * tests/backup-trigger.unit.test.ts
 *
 * Cyber Defense, Step 10 — the €0/month backup trigger.
 *
 * POST /internal/backups/run and GET /internal/backups/runs/:id are the only
 * way the daily GitHub Actions schedule reaches the service. They take no
 * input, are closed without BACKUP_TRIGGER_SECRET, authenticate by HMAC over
 * method, path and timestamp inside a five-minute window, run one backup at a
 * time and none within 12 hours of a success, and answer with run state and
 * nothing else. The client the workflow runs (scripts/backup-trigger.js) is
 * driven end to end against the real handlers.
 *
 * Real advisory locking against PostgreSQL is in
 * tests/backup-restore-drill.integration.test.ts.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import {
  MAX_RUN_MS, MIN_INTERVAL_MS, TRIGGER_WINDOW_SECONDS, signTrigger, signingInput, startBackupRun, statusOf,
  triggerSecret, verifyTrigger, type BackupRunStore, type RunRow,
} from '../src/security/backup/backup-trigger';
import { internalBackupRoutes, type InternalBackupDeps } from '../src/controllers/internal-backup.controller';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require('../scripts/backup-trigger.js') as {
  sign(secret: string, method: string, path: string, ts: string): string;
  main(opts: Record<string, unknown>): Promise<number>;
};

// A test-only secret, built at runtime; it guards nothing.
const SECRET = ['test', 'trigger', 'secret', 'not', 'for', 'production', '0123456789'].join('-');
const KEY = Buffer.from(SECRET);
const NOW = 1_790_000_000; // a fixed "now", in seconds
const RUN = '/internal/backups/run';

// ── an in-memory store with a real mutex, so concurrency is observable ───────

type Row = RunRow & { ref?: string; notes?: string; sha256?: string };

function memoryStore(init: Row[] = []) {
  const rows: Row[] = [...init];
  let held = false;
  let seq = 0;
  const store: BackupRunStore = {
    async withLock(fn) {
      if (held) return fn(false);
      held = true;
      try { return await fn(true); } finally { held = false; }
    },
    async lastSuccessAt() {
      const ok = rows.filter((r) => r.ok && r.finishedAt).sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
      return ok[0]?.finishedAt ?? null;
    },
    async latestUnfinished() { return rows.filter((r) => !r.finishedAt).slice(-1)[0] ?? null; },
    async createRunning(startedAt) {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      rows.push({ id, startedAt, finishedAt: null, ok: false });
      return id;
    },
    async find(id) { return rows.find((r) => r.id === id) ?? null; },
  };
  return { store, rows, isHeld: () => held };
}

/** A runner stand-in that finishes when told to. */
function controllableRun(rows: Row[], now: () => Date) {
  const pending = new Map<string, (ok: boolean) => void>();
  const run = (id: string) => new Promise<void>((resolve, reject) => {
    pending.set(id, (ok) => {
      const r = rows.find((x) => x.id === id)!;
      r.finishedAt = now();
      r.ok = ok;
      // What the real runner writes, which must never reach a response.
      r.ref = 's3://familista-backups-2026-739261/familista/postgres/2026/09/29/familista-x.fbk';
      r.notes = JSON.stringify({ manifest: 'x.fbk.manifest.json', error: ok ? undefined : 'pg_dump failed: host db.internal' });
      if (ok) resolve(); else reject(new Error('pg_dump failed'));
    });
  });
  return { run, finish: (id: string, ok = true) => pending.get(id)!(ok) };
}

const signed = (req: request.Test, method: string, path: string, ts = NOW) =>
  req.set('x-backup-timestamp', String(ts)).set('x-backup-signature', signTrigger(KEY, method, path, String(ts)));

function appWith(deps: InternalBackupDeps) {
  const app = express();
  app.use(express.json());
  const r = internalBackupRoutes(deps);
  app.post(RUN, ...r.run);
  app.get('/internal/backups/runs/:id', ...r.status);
  return app;
}

function depsFor(store: BackupRunStore, run: (id: string) => Promise<unknown>, opts: Partial<InternalBackupDeps> & { now?: () => Date } = {}): InternalBackupDeps {
  const now = opts.now ?? (() => new Date(NOW * 1000));
  return {
    secret: opts.secret ?? (() => KEY),
    store: () => store,
    nowSeconds: opts.nowSeconds ?? (() => Math.floor(now().getTime() / 1000)),
    start: opts.start ?? ((s) => startBackupRun({ store: s, run, now })),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// ── authentication ───────────────────────────────────────────────────────────

describe('trigger authentication', () => {
  it('signs method, path and timestamp, one per line', () => {
    expect(signingInput('post', '/internal/backups/run', '123')).toBe('POST\n/internal/backups/run\n123');
    expect(signTrigger(KEY, 'POST', RUN, '1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the workflow client and the server compute the same signature', () => {
    expect(client.sign(SECRET, 'POST', RUN, String(NOW))).toBe(signTrigger(KEY, 'POST', RUN, String(NOW)));
    expect(client.sign(SECRET, 'get', '/internal/backups/runs/x', '5')).toBe(signTrigger(KEY, 'GET', '/internal/backups/runs/x', '5'));
  });

  it('accepts a correct signature inside the window', () => {
    const sig = signTrigger(KEY, 'POST', RUN, String(NOW));
    expect(verifyTrigger(KEY, { method: 'POST', path: RUN, timestamp: String(NOW), signature: sig }, NOW)).toBe('ok');
    expect(verifyTrigger(KEY, { method: 'POST', path: RUN, timestamp: String(NOW), signature: sig }, NOW + TRIGGER_WINDOW_SECONDS)).toBe('ok');
  });

  it.each([
    ['another method', { method: 'GET' }],
    ['another path', { path: '/internal/backups/runs/1' }],
    ['another timestamp', { timestamp: String(NOW + 1) }],
  ])('rejects a signature replayed with %s', (_l, change) => {
    const sig = signTrigger(KEY, 'POST', RUN, String(NOW));
    const req = { method: 'POST', path: RUN, timestamp: String(NOW), signature: sig, ...change };
    expect(verifyTrigger(KEY, req, NOW)).toBe('unauthenticated');
  });

  it('rejects a replay after the window, and a timestamp from the future', () => {
    for (const ts of [NOW - TRIGGER_WINDOW_SECONDS - 1, NOW + TRIGGER_WINDOW_SECONDS + 1]) {
      const sig = signTrigger(KEY, 'POST', RUN, String(ts));
      expect(verifyTrigger(KEY, { method: 'POST', path: RUN, timestamp: String(ts), signature: sig }, NOW)).toBe('stale');
    }
  });

  it.each([
    ['no headers', {}],
    ['a malformed timestamp', { timestamp: '12a', signature: 'a'.repeat(64) }],
    ['a short signature', { timestamp: String(NOW), signature: 'abcd' }],
    ['an uppercase-hex signature', { timestamp: String(NOW), signature: signTrigger(KEY, 'POST', RUN, String(NOW)).toUpperCase() }],
    ['another secret\'s signature', { timestamp: String(NOW), signature: signTrigger(Buffer.from(SECRET + 'x'), 'POST', RUN, String(NOW)) }],
  ])('rejects %s', (_l, h) => {
    expect(verifyTrigger(KEY, { method: 'POST', path: RUN, ...h }, NOW)).toBe('unauthenticated');
  });

  it('compares signatures in constant time (timingSafeEqual on equal-length buffers)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/security/backup/backup-trigger.ts'), 'utf8');
    expect(src).toMatch(/given\.length === expected\.length && timingSafeEqual\(given, expected\)/);
    expect(src).not.toMatch(/sig\s*===|signature\s*===|===\s*sig\b/);
  });

  it('is closed without a secret, and with one shorter than 32 characters', () => {
    expect(triggerSecret({})).toBeNull();
    expect(triggerSecret({ BACKUP_TRIGGER_SECRET: '   ' })).toBeNull();
    expect(triggerSecret({ BACKUP_TRIGGER_SECRET: 'x'.repeat(31) })).toBeNull();
    expect(triggerSecret({ BACKUP_TRIGGER_SECRET: SECRET })).toEqual(KEY);
  });
});

// ── starting runs ────────────────────────────────────────────────────────────

describe('starting a backup', () => {
  const now = () => new Date(NOW * 1000);

  it('starts one run, holding the lock until the runner finishes', async () => {
    const m = memoryStore();
    const r = controllableRun(m.rows, now);
    const res = await startBackupRun({ store: m.store, run: r.run, now });
    expect(res).toEqual({ kind: 'started', id: expect.any(String) });
    expect(m.isHeld()).toBe(true);
    r.finish((res as { id: string }).id);
    await flush();
    expect(m.isHeld()).toBe(false);
  });

  it('refuses a second run while one holds the lock, naming the running one', async () => {
    const m = memoryStore();
    const r = controllableRun(m.rows, now);
    const [a, b] = await Promise.all([
      startBackupRun({ store: m.store, run: r.run, now }),
      startBackupRun({ store: m.store, run: r.run, now }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['running', 'started']);
    const started = [a, b].find((x) => x.kind === 'started') as { id: string };
    expect([a, b].find((x) => x.kind === 'running')).toEqual({ kind: 'running', id: started.id });
    expect(m.rows).toHaveLength(1);
    r.finish(started.id);
  });

  it('refuses a new run within 12 hours of a success, and allows one after', async () => {
    const lastOk = new Date(NOW * 1000 - MIN_INTERVAL_MS + 60_000);
    const m = memoryStore([{ id: 'prev', startedAt: lastOk, finishedAt: lastOk, ok: true }]);
    const runs: string[] = [];
    const res = await startBackupRun({ store: m.store, run: async (id) => { runs.push(id); }, now });
    expect(res).toEqual({ kind: 'recent', lastSuccessAt: lastOk.toISOString() });
    expect(runs).toEqual([]);

    const later = () => new Date(lastOk.getTime() + MIN_INTERVAL_MS);
    const res2 = await startBackupRun({ store: m.store, run: async (id) => { runs.push(id); }, now: later });
    expect(res2.kind).toBe('started');
  });

  it('does not count a failed run against the 12 hours', async () => {
    const t = new Date(NOW * 1000 - 60_000);
    const m = memoryStore([{ id: 'failed', startedAt: t, finishedAt: t, ok: false }]);
    expect((await startBackupRun({ store: m.store, run: async () => undefined, now })).kind).toBe('started');
  });

  it('reports an error when the store fails before deciding, and logs a failure after', async () => {
    const m = memoryStore();
    const broken = { ...m.store, lastSuccessAt: async () => { throw new Error('db down'); } };
    expect(await startBackupRun({ store: broken, run: async () => undefined, now })).toEqual({ kind: 'error' });

    const errors: unknown[] = [];
    const res = await startBackupRun({ store: m.store, run: async () => { throw new Error('boom'); }, now, onBackgroundError: (e) => errors.push(e) });
    expect(res.kind).toBe('started');
    await flush();
    expect(errors).toHaveLength(1);
  });
});

describe('run state', () => {
  const t0 = new Date(NOW * 1000);
  it.each([
    ['running', { finishedAt: null, ok: false }, t0, 'running'],
    ['succeeded', { finishedAt: t0, ok: true }, t0, 'succeeded'],
    ['failed', { finishedAt: t0, ok: false }, t0, 'failed'],
    ['lost to a restart', { finishedAt: null, ok: false }, new Date(t0.getTime() + MAX_RUN_MS + 1), 'failed'],
  ])('%s', (_l, row, now, state) => {
    const s = statusOf({ id: 'x', startedAt: t0, ...row } as RunRow, now as Date);
    expect(s.state).toBe(state);
    expect(s.ok).toBe(state === 'succeeded');
    expect(Object.keys(s).sort()).toEqual(['finishedAt', 'id', 'ok', 'startedAt', 'state']);
  });
});

// ── the HTTP doors ──────────────────────────────────────────────────────────

describe('POST /internal/backups/run and GET /internal/backups/runs/:id', () => {
  const now = () => new Date(NOW * 1000);

  it('is closed (503) when no secret is configured, whatever is sent', async () => {
    const m = memoryStore();
    const app = appWith(depsFor(m.store, async () => undefined, { secret: () => null }));
    const res = await signed(request(app).post(RUN), 'POST', RUN);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'backup trigger is not configured' });
    expect(m.rows).toHaveLength(0);
  });

  it.each([
    ['no signature', (r: request.Test) => r],
    ['a wrong signature', (r: request.Test) => r.set('x-backup-timestamp', String(NOW)).set('x-backup-signature', 'f'.repeat(64))],
    ['a stale timestamp', (r: request.Test) => signed(r, 'POST', RUN, NOW - 301)],
    ['a signature for the status path', (r: request.Test) => signed(r, 'GET', RUN)],
  ])('answers 401, the same way, for %s — and starts nothing', async (_l, prep) => {
    const m = memoryStore();
    const app = appWith(depsFor(m.store, async () => undefined));
    const res = await prep(request(app).post(RUN));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(m.rows).toHaveLength(0);
  });

  it.each([
    ['a JSON body', (r: request.Test) => r.send({ bucket: 'evil', databaseUrl: 'postgresql://x', command: 'rm -rf /' })],
    ['a query string', (r: request.Test) => r.query({ endpoint: 'https://evil.example' })],
  ])('refuses %s (400): nothing about the backup can come from the request', async (_l, prep) => {
    const m = memoryStore();
    const app = appWith(depsFor(m.store, async () => undefined));
    const res = await prep(signed(request(app).post(RUN), 'POST', RUN));
    expect(res.status).toBe(400);
    expect(m.rows).toHaveLength(0);
  });

  it('starts a run (202) with an id and a state, and nothing else', async () => {
    const m = memoryStore();
    const r = controllableRun(m.rows, now);
    const app = appWith(depsFor(m.store, r.run));
    const res = await signed(request(app).post(RUN), 'POST', RUN);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'state']);
    expect(res.body.state).toBe('running');
    expect(res.headers['cache-control']).toBe('no-store');
    r.finish(res.body.id);
  });

  it('answers 409 with the running id while a run holds the lock', async () => {
    const m = memoryStore();
    const r = controllableRun(m.rows, now);
    const app = appWith(depsFor(m.store, r.run));
    const first = await signed(request(app).post(RUN), 'POST', RUN);
    const second = await signed(request(app).post(RUN), 'POST', RUN);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ id: first.body.id, state: 'running' });
    r.finish(first.body.id);
  });

  it('answers 429 within 12 hours of a success', async () => {
    const t = new Date(NOW * 1000 - 3_600_000);
    const m = memoryStore([{ id: 'p', startedAt: t, finishedAt: t, ok: true }]);
    const app = appWith(depsFor(m.store, async () => undefined));
    const res = await signed(request(app).post(RUN), 'POST', RUN);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ state: 'recent', lastSuccessAt: t.toISOString() });
  });

  it('answers 503 without detail when the backup itself is not configured', async () => {
    const m = memoryStore();
    const app = appWith(depsFor(m.store, async () => undefined, {
      start: async () => { throw new Error('BACKUP_SIGNING_PRIVATE_KEY is required'); },
    }));
    const res = await signed(request(app).post(RUN), 'POST', RUN);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'backup is not configured' });
  });

  it('reports run state with only safe fields — no bucket, object, database or error text', async () => {
    const m = memoryStore();
    const r = controllableRun(m.rows, now);
    const app = appWith(depsFor(m.store, r.run));
    const { body: { id } } = await signed(request(app).post(RUN), 'POST', RUN);
    const path = `/internal/backups/runs/${id}`;

    const running = await signed(request(app).get(path), 'GET', path);
    expect(running.status).toBe(200);
    expect(running.body).toEqual({ id, state: 'running', startedAt: new Date(NOW * 1000).toISOString(), finishedAt: null, ok: false });

    r.finish(id, false);
    await flush();
    const failed = await signed(request(app).get(path), 'GET', path);
    expect(failed.body).toMatchObject({ id, state: 'failed', ok: false });
    expect(Object.keys(failed.body).sort()).toEqual(['finishedAt', 'id', 'ok', 'startedAt', 'state']);
    for (const leak of ['familista-backups', 's3://', '.fbk', 'manifest', 'db.internal', 'pg_dump', 'postgres']) {
      expect(failed.text).not.toContain(leak);
    }
  });

  it('needs its own signature: a signature for another run id, or for the start, is refused', async () => {
    const m = memoryStore();
    const r = controllableRun(m.rows, now);
    const app = appWith(depsFor(m.store, r.run));
    const { body: { id } } = await signed(request(app).post(RUN), 'POST', RUN);
    const path = `/internal/backups/runs/${id}`;
    expect((await request(app).get(path)).status).toBe(401);
    expect((await signed(request(app).get(path), 'GET', '/internal/backups/runs/00000000-0000-4000-8000-000000000999')).status).toBe(401);
    expect((await signed(request(app).get(path), 'POST', RUN)).status).toBe(401);
    r.finish(id);
  });

  it('answers 404 alike for an unknown id and a malformed one', async () => {
    const m = memoryStore();
    const app = appWith(depsFor(m.store, async () => undefined));
    for (const id of ['00000000-0000-4000-8000-000000000777', 'not-a-uuid', '..%2F..%2Fetc']) {
      const path = `/internal/backups/runs/${id}`;
      const res = await signed(request(app).get(path), 'GET', path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not found' });
    }
  });

  it('rate-limits the start door in front of the signature check', async () => {
    const m = memoryStore();
    const app = appWith(depsFor(m.store, async () => undefined));
    const codes: number[] = [];
    for (let i = 0; i < 13; i += 1) codes.push((await request(app).post(RUN)).status);
    expect(codes.slice(0, 12).every((c) => c === 401)).toBe(true);
    expect(codes[12]).toBe(429);
  });
});

// ── the real application ─────────────────────────────────────────────────────

describe('mounted in the real app', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createApp } = require('../src/app');
  const before = process.env.BACKUP_TRIGGER_SECRET;
  afterEach(() => { if (before === undefined) delete process.env.BACKUP_TRIGGER_SECRET; else process.env.BACKUP_TRIGGER_SECRET = before; });

  it('is closed without the secret, and needs no user session to be refused by the HMAC', async () => {
    delete process.env.BACKUP_TRIGGER_SECRET;
    const app = createApp();
    expect((await request(app).post(RUN)).status).toBe(503);
    process.env.BACKUP_TRIGGER_SECRET = SECRET;
    const res = await request(app).post(RUN);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    const status = await request(app).get('/internal/backups/runs/00000000-0000-4000-8000-000000000001');
    expect(status.status).toBe(401);
  });

  it('does not answer other methods on the trigger path', async () => {
    process.env.BACKUP_TRIGGER_SECRET = SECRET;
    const app = createApp();
    for (const m of ['get', 'put', 'delete'] as const) {
      expect((await request(app)[m](RUN)).status).toBe(404);
    }
  });
});

// ── the workflow's client, end to end ────────────────────────────────────────

describe('scripts/backup-trigger.js against the real handlers', () => {
  async function serve(deps: InternalBackupDeps, healthzFailures = 0) {
    const app = appWith(deps);
    let failures = healthzFailures;
    app.get('/healthz', (_req, res) => { if (failures > 0) { failures -= 1; res.status(503).end(); } else res.json({ status: 'ok' }); });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  const realNow = () => Math.floor(Date.now() / 1000);
  const fast = { wakeIntervalMs: 5, pollIntervalMs: 5, wakeTimeoutMs: 2000, pollTimeoutMs: 2000, requestTimeoutMs: 2000 };

  async function drive(deps: InternalBackupDeps, env: Record<string, string>, healthzFailures = 0) {
    const s = await serve(deps, healthzFailures);
    const lines: string[] = [];
    try {
      const code = await client.main({ env: { BACKUP_SERVICE_URL: s.url, ...env }, allowHttp: true, timings: fast, log: (l: string) => lines.push(l) });
      return { code, lines };
    } finally { await s.close(); }
  }

  it('wakes the service, starts the backup, waits for success, and exits 0', async () => {
    const m = memoryStore();
    let polls = 0;
    const deps: InternalBackupDeps = {
      secret: () => KEY, store: () => m.store, nowSeconds: realNow,
      start: (st) => startBackupRun({ store: st, run: async (id) => {
        await new Promise((r) => setTimeout(r, 30));
        const row = m.rows.find((x) => x.id === id)!; row.finishedAt = new Date(); row.ok = true; polls += 1;
      } }),
    };
    const { code, lines } = await drive(deps, { BACKUP_TRIGGER_SECRET: SECRET }, 2);
    expect(code).toBe(0);
    expect(lines).toContain('backup: service is awake');
    expect(lines[lines.length - 1]).toBe('backup: succeeded');
    expect(polls).toBe(1);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('exits 1 when the backup fails', async () => {
    const m = memoryStore();
    const deps: InternalBackupDeps = {
      secret: () => KEY, store: () => m.store, nowSeconds: realNow,
      start: (st) => startBackupRun({ store: st, run: async (id) => {
        const row = m.rows.find((x) => x.id === id)!; row.finishedAt = new Date(); row.ok = false; throw new Error('x');
      }, onBackgroundError: () => undefined }),
    };
    const { code, lines } = await drive(deps, { BACKUP_TRIGGER_SECRET: SECRET });
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/FAILED/);
  });

  it('exits 0 without a new backup when one succeeded within 12 hours', async () => {
    const t = new Date(Date.now() - 3_600_000);
    const m = memoryStore([{ id: 'p', startedAt: t, finishedAt: t, ok: true }]);
    const deps: InternalBackupDeps = { secret: () => KEY, store: () => m.store, nowSeconds: realNow, start: (st) => startBackupRun({ store: st, run: async () => undefined }) };
    const { code } = await drive(deps, { BACKUP_TRIGGER_SECRET: SECRET });
    expect(code).toBe(0);
    expect(m.rows).toHaveLength(1);
  });

  it('exits 1 on a wrong secret, and refuses to start without one or over plain http', async () => {
    const m = memoryStore();
    const deps: InternalBackupDeps = { secret: () => KEY, store: () => m.store, nowSeconds: realNow, start: (st) => startBackupRun({ store: st, run: async () => undefined }) };
    expect((await drive(deps, { BACKUP_TRIGGER_SECRET: SECRET + '-wrong' })).code).toBe(1);
    expect(m.rows).toHaveLength(0);
    expect(await client.main({ env: { BACKUP_SERVICE_URL: 'https://example.invalid' }, log: () => undefined })).toBe(1);
    expect(await client.main({ env: { BACKUP_SERVICE_URL: 'http://example.invalid', BACKUP_TRIGGER_SECRET: SECRET }, log: () => undefined })).toBe(1);
  });
});
