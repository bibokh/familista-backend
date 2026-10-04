/**
 * Algorithms Step 2 — production telemetry, proven on real PostgreSQL
 *
 * A freshly migrated database (every migration, including
 * 20261007100000_algorithm_runtime_telemetry), whose default TimeZone is
 * deliberately NOT UTC. Then, through the application's own store:
 *
 *   one hourly row per algorithm, workflow, version and fingerprint, and no
 *   write at all when nothing ran
 *   twenty writers at once add up exactly — the INSERT … ON CONFLICT is atomic
 *   the windows the room reads (24 hours, 7 days, the 28 before, 42 kept) are
 *   the right rows
 *   retention deletes what is older than 42 days, and only that
 *   a failed write keeps its counts, and the next one carries them
 *   the database itself refuses a name, an address or a sentence in any column
 *   nothing personal reaches the table, whatever the call site had in hand
 *   the monitoring room reads it end to end
 *
 * Runs when ALGO_TELEMETRY_DB_DATABASE_URL names a server where the test may
 * create and drop a database. CI sets ALGO_TELEMETRY_DB_REQUIRED=1, so a
 * missing URL fails there rather than skipping:
 *
 *   ALGO_TELEMETRY_DB_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/algorithm-telemetry.integration.test.ts
 */

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

const ADMIN_URL = process.env.ALGO_TELEMETRY_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.ALGO_TELEMETRY_DB_REQUIRED === '1') {
  throw new Error('ALGO_TELEMETRY_DB_REQUIRED=1 but ALGO_TELEMETRY_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TABLE = '"AlgorithmTelemetryBucket"';

suite('algorithm telemetry on real PostgreSQL', () => {
  const db = `fam_algo_${randomBytes(4).toString('hex')}`;
  const url = ADMIN_URL ? withDatabase(ADMIN_URL, db) : '';
  let admin: PrismaClient;
  let pg: PrismaClient;
  let telemetry: typeof import('../src/algorithms/telemetry');
  let store: typeof import('../src/algorithms/telemetry-store');
  let monitoring: typeof import('../src/algorithms/monitoring');
  let fingerprint: typeof import('../src/algorithms/runtime-fingerprint');

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    // A half-hour zone: date_trunc('hour') in this session would land on :30
    // UTC. The store must be immune to it.
    await admin.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'Asia/Kolkata'`);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status}): ${migrate.stderr}`);
    pg = new PrismaClient({ datasources: { db: { url } } });
    // The store uses the application's client: point it at this database.
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    /* eslint-disable @typescript-eslint/no-var-requires */
    telemetry = require('../src/algorithms/telemetry');
    store = require('../src/algorithms/telemetry-store');
    monitoring = require('../src/algorithms/monitoring');
    fingerprint = require('../src/algorithms/runtime-fingerprint');
    /* eslint-enable @typescript-eslint/no-var-requires */
  }, 240_000);

  afterAll(async () => {
    await pg?.$disconnect();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await require('../src/config/database').prisma.$disconnect().catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    telemetry.resetTelemetry();
    store.resetTelemetryStore();
    monitoring.resetMonitoringCache();
    await pg.$executeRawUnsafe(`DELETE FROM ${TABLE}`);
  });

  const rows = () => pg.$queryRawUnsafe<Row[]>(`SELECT * FROM ${TABLE} ORDER BY "algorithmKey", "source", "bucketStart"`);
  const risk = (n: number) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { computeMedicalRiskScore } = require('../src/intelligence/shared.utils');
    for (let i = 0; i < n; i++) {
      telemetry.observed('medical-risk', 'intelligence.unified-player',
        () => computeMedicalRiskScore({ activeInjuryCount: i % 2, totalInjuryCount: i % 4, recentReturnDays: null, acwr: i % 3 ? 1.1 : null }),
        (s: number) => ({ outputs: [s], quality: i % 3 ? 'OK' : 'PARTIAL' }));
    }
  };

  it('the migration made exactly the aggregate table: its columns, no row-level security, every guard', async () => {
    const cols = await pg.$queryRawUnsafe<Row[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'AlgorithmTelemetryBucket' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      'algorithmKey', 'bucketStart', 'executions', 'failures', 'fingerprint', 'firstAt', 'freshnessFresh', 'freshnessStale',
      'id', 'lastAt', 'lastFailureAt', 'lastFailureKind', 'latencyBins', 'latencyMaxUs', 'latencySumUs', 'outOfContract',
      'outputBins', 'outputs', 'qualityEmpty', 'qualityOk', 'qualityPartial', 'source', 'updatedAt', 'version',
    ].sort());
    const [rls] = await pg.$queryRawUnsafe<Row[]>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'AlgorithmTelemetryBucket'`);
    expect(rls.relrowsecurity).toBe(false);
    const checks = await pg.$queryRawUnsafe<Row[]>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"AlgorithmTelemetryBucket"'::regclass AND contype = 'c'`);
    expect(checks.length).toBe(8);
  });

  it('writes one hourly row for what ran, and nothing at all when nothing did', async () => {
    risk(30);
    expect(await store.flushAlgorithmTelemetry()).toEqual({ rows: 1, ok: true });
    const [r] = await rows();
    expect(r).toMatchObject({ algorithmKey: 'medical-risk', version: 'v1.0', source: 'intelligence.unified-player', executions: 30, failures: 0, outputs: 30, outOfContract: 0 });
    expect(r.fingerprint).toBe(fingerprint.telemetryFingerprintOf('medical-risk'));
    expect((r.latencyBins as number[]).reduce((a, b) => a + b, 0)).toBe(30);
    expect((r.outputBins as number[]).reduce((a, b) => a + b, 0)).toBe(30);
    expect(r.qualityOk + r.qualityPartial).toBe(30);
    // Hour-aligned in UTC, whatever the session's zone says.
    expect((r.bucketStart as Date).getTime() % HOUR).toBe(0);
    const [{ tz }] = await pg.$queryRawUnsafe<Row[]>(`SELECT current_setting('TimeZone') AS tz`);
    expect(tz).toBe('Asia/Kolkata');

    const before = (await rows())[0].updatedAt as Date;
    expect(await store.flushAlgorithmTelemetry()).toEqual({ rows: 0, ok: true });
    expect(((await rows())[0].updatedAt as Date).getTime()).toBe(before.getTime());
    expect(store.storeStatus()).toMatchObject({ state: 'OK', rowsWritten: 1, pendingEntries: 0 });
  });

  it('twenty processes writing the same hour at once lose nothing', async () => {
    // Twenty processes' worth of one minute each, written at the same moment:
    // the same statement each server process sends, on separate connections.
    const minutes = Array.from({ length: 20 }, () => {
      telemetry.resetTelemetry();
      for (let i = 0; i < 5; i++) telemetry.observed('age-curve', 'intelligence.succession', () => 0.85, (f: number) => ({ outputs: [f], quality: 'OK' }));
      telemetry.observed('age-curve', 'intelligence.succession', () => 1, (f: number) => ({ outputs: [f], quality: 'PARTIAL' }));
      return telemetry.takePending();
    });
    await Promise.all(minutes.map((m) => store.writeTelemetryRows(m)));
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ executions: 120, outputs: 120, qualityOk: 100, qualityPartial: 20 });
    expect(all[0].outputBins).toEqual([0, 100, 20]);
    expect((all[0].latencyBins as number[]).reduce((a, b) => a + b, 0)).toBe(120);
  });

  /** A row written straight into the table, the way the store would have. */
  async function put(over: Row) {
    const r: Row = {
      algorithmKey: 'kickoff-window', version: 'v1.0', fingerprint: 'a'.repeat(64), source: 'match-center.change-request',
      executions: 1, failures: 0, outputs: 1, outOfContract: 0, latencySumUs: 10, latencyMaxUs: 10,
      latencyBins: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], outputBins: [1, 0, 0, 0, 0, 0], ...over,
    };
    const at = new Date(r.bucketStart as number).toISOString();
    await pg.$executeRawUnsafe(
      `INSERT INTO ${TABLE} ("id","algorithmKey","version","fingerprint","source","bucketStart","executions","failures","outputs","outOfContract",
        "latencySumUs","latencyMaxUs","latencyBins","outputBins","firstAt","lastAt","lastFailureAt","lastFailureKind")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12::int[], $13::int[], $5::timestamptz, $5::timestamptz, $14::timestamptz, $15)`,
      r.algorithmKey, r.version, r.fingerprint, r.source, at, r.executions, r.failures, r.outputs, r.outOfContract,
      r.latencySumUs, r.latencyMaxUs, r.latencyBins, r.outputBins,
      r.lastFailureAt ? new Date(r.lastFailureAt as number).toISOString() : null, r.lastFailureKind ?? null);
  }

  it('reads the windows the room shows from the right rows', async () => {
    const now = Date.now();
    const hour = now - (now % HOUR);
    await put({ bucketStart: hour, executions: 3, outputs: 3, outputBins: [3, 0, 0, 0, 0, 0] });                     // last 24h
    await put({ bucketStart: hour - 30 * HOUR, executions: 5, failures: 1, outputs: 4, outputBins: [4, 0, 0, 0, 0, 0],  // this week
      lastFailureAt: hour - 30 * HOUR, lastFailureKind: 'TypeError' });
    await put({ bucketStart: hour - 10 * DAY, executions: 7, outputs: 7, outputBins: [0, 7, 0, 0, 0, 0] });          // baseline
    await put({ bucketStart: hour - 40 * DAY, executions: 11, outputs: 11, outputBins: [0, 0, 11, 0, 0, 0] });       // kept, outside both
    const agg = await store.readTelemetryAggregates(now);
    expect(agg.groups).toHaveLength(1);
    const g = agg.groups[0];
    expect(g.last24h).toEqual({ executions: 3, failures: 0 });
    expect(g.recent).toMatchObject({ executions: 8, failures: 1, outputs: 7 });
    expect(g.recent.outputBins).toEqual([7, 0, 0, 0, 0, 0]);
    expect(g.baseline).toMatchObject({ executions: 7, outputs: 7 });
    expect(g.baseline.outputBins).toEqual([0, 7, 0, 0, 0, 0]);
    expect(g.retained).toEqual({ executions: 26, failures: 1 });
    expect(g.lastFailureKind).toBe('TypeError');
    // The 14-day series holds this week and the baseline row from 10 days ago.
    expect(agg.daily.reduce((n, d) => n + d.executions, 0)).toBe(15);
  });

  it('deletes what is older than 42 days, and nothing younger', async () => {
    const now = Date.now();
    const hour = now - (now % HOUR);
    await put({ bucketStart: hour - 50 * DAY });
    await put({ bucketStart: hour - 41 * DAY });
    risk(1);
    await store.flushAlgorithmTelemetry();
    const left = await rows();
    expect(left.map((r) => r.algorithmKey).sort()).toEqual(['kickoff-window', 'medical-risk']);
    expect((left.find((r) => r.algorithmKey === 'kickoff-window')!.bucketStart as Date).getTime()).toBe(hour - 41 * DAY);
  });

  it('a failed write keeps its counts in memory, and the next write carries them', async () => {
    risk(4);
    // The table goes away for a moment: the write must fail, and keep its counts.
    await pg.$executeRawUnsafe(`ALTER TABLE ${TABLE} RENAME TO "AlgorithmTelemetryBucket_away"`);
    try {
      expect((await store.flushAlgorithmTelemetry()).ok).toBe(false);
      expect(store.storeStatus()).toMatchObject({ state: 'FAILING', pendingEntries: 1 });
      expect(store.storeStatus().lastFlushFailure).toMatch(/^[A-Za-z][A-Za-z0-9]*(:P\d{4})?$/);
    } finally {
      await pg.$executeRawUnsafe(`ALTER TABLE "AlgorithmTelemetryBucket_away" RENAME TO "AlgorithmTelemetryBucket"`);
    }
    risk(2);
    expect(await store.flushAlgorithmTelemetry()).toEqual({ rows: 1, ok: true });
    expect((await rows())[0].executions).toBe(6);
  });

  it('refuses a name, an address or a sentence in any column — the database itself', async () => {
    const hour = Date.now() - (Date.now() % HOUR);
    const refused = /violates check constraint/;
    const bad: Array<[string, Row]> = [
      ['a person as a workflow', { source: 'Lionel Messi' }],
      ['an address as a workflow', { source: 'coach@club.example' }],
      ['a sentence as a key', { algorithmKey: 'Medical risk for player 7' }],
      ['free text as a fingerprint', { fingerprint: 'the approved one' }],
      ['an error message as a failure kind', { lastFailureKind: 'TypeError: user anna@example.com not found', lastFailureAt: hour }],
      ['prose as a version', { version: 'version one' }],
      ['an instant that is not an hour', { bucketStart: hour + 17 * 60_000 }],
      ['more failures than runs', { executions: 1, failures: 2 }],
      ['more broken outputs than outputs', { outputs: 1, outOfContract: 2 }],
      ['an unbounded histogram', { outputBins: new Array(40).fill(1) }],
    ];
    for (const [what, over] of bad) {
      let err: unknown = null;
      try { await put({ bucketStart: hour, ...over }); } catch (e) { err = e; }
      expect(`${what}: ${refused.test(String((err as Error)?.message ?? ''))}`).toBe(`${what}: true`);
    }
    expect(await rows()).toEqual([]);
  });

  it('keeps nothing personal, whatever the call site held', async () => {
    const NAME = 'Anna Testspielerin';
    const EMAIL = 'anna.private@example.test';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { eligibilityFor } = require('../src/competition/league-eligibility');
    eligibilityFor({ ageGroup: null }, { kind: 'SENIOR', isActive: true, name: `${NAME} FC <${EMAIL}>` }, 'league.add-participant');
    try {
      telemetry.observed('medical-risk', 'intelligence.unified-player', () => { throw new TypeError(`${NAME} ${EMAIL}`); });
    } catch { /* expected */ }
    risk(3);
    await store.flushAlgorithmTelemetry();
    const dump = (await pg.$queryRawUnsafe<Row[]>(`SELECT row_to_json(t)::text AS j FROM ${TABLE} t`)).map((r) => r.j).join('\n');
    expect(dump.length).toBeGreaterThan(100);
    for (const s of [NAME, EMAIL, 'Testspielerin', 'example.test']) expect(`${s}: ${dump.includes(s)}`).toBe(`${s}: false`);
    expect(dump).toContain('"lastFailureKind":"TypeError"');
  });

  it('the Monitoring room reads it end to end, and calls nothing healthy it did not measure', async () => {
    risk(25);
    await store.flushAlgorithmTelemetry();
    risk(2); // this process's unwritten minute is read too
    const o = await monitoring.algorithmsMonitoring();
    expect(o.state).toBe('READY');
    const r = o.algorithms.find((a) => a.key === 'medical-risk')!;
    expect(r.executions7d).toBe(27);
    expect(r.state).toBe('HEALTHY');
    expect(o.states.HEALTHY).toBe(1);
    expect(o.states.NOT_INSTRUMENTED).toBe(4);
    expect(o.states.NOT_ENOUGH_DATA).toBe(8);
    const d = await monitoring.algorithmMonitoring('medical-risk');
    if (d.state !== 'READY') throw new Error('not ready');
    expect(d.detail.counts.recent.executions).toBe(27);
    expect(d.detail.distribution!.recent.reduce((a, b) => a + b, 0)).toBe(27);
    expect(d.detail.fingerprintsSeen).toEqual([expect.objectContaining({ current: true, approved: true, executions: 27 })]);
    expect(d.detail.storeState).toBe('READY');
  });

  it('rows an earlier deployment wrote are history: they never verify this server\'s write path', async () => {
    // A previous deployment wrote these rows.
    risk(5);
    await store.flushAlgorithmTelemetry();
    // Then this process starts afresh: its own record is empty, the rows remain.
    store.resetTelemetryStore();
    monitoring.resetMonitoringCache();
    store.startAlgorithmTelemetry();
    try {
      let o = await monitoring.algorithmsMonitoring();
      expect(o.writePath).toMatchObject({ thisServer: 'UNVERIFIED', verifiedAt: null, stored: 'ROWS_PRESENT' });
      expect(o.writePath.storedNewestRunAt).not.toBeNull();
      // Only a write this process completes verifies the running deployment.
      risk(1);
      await store.flushAlgorithmTelemetry();
      monitoring.resetMonitoringCache();
      o = await monitoring.algorithmsMonitoring();
      expect(o.writePath.thisServer).toBe('VERIFIED');
      expect(o.writePath.verifiedAt).not.toBeNull();
    } finally {
      await store.stopAlgorithmTelemetry();
    }
  });

  it('an empty store and a process that wrote nothing: Unverified and no rows — evidence of nothing', async () => {
    store.startAlgorithmTelemetry();
    try {
      const o = await monitoring.algorithmsMonitoring();
      expect(o.writePath).toMatchObject({ thisServer: 'UNVERIFIED', verifiedAt: null, stored: 'NO_ROWS', storedNewestRunAt: null });
    } finally {
      await store.stopAlgorithmTelemetry();
    }
  });
});
