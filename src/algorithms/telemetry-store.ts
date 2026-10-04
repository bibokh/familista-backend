// Familista — algorithm runtime telemetry: the store
// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in src/algorithms that touches the database, and the only
// table it touches is "AlgorithmTelemetryBucket" (migration
// 20261007100000_algorithm_runtime_telemetry). tests/algorithms-monitoring.
// unit.test.ts holds it to both.
//
// WRITES — off the request path. Every server process records into its own
// memory (telemetry.ts); a timer in each process writes what it recorded once
// a minute, as ONE statement: an INSERT … ON CONFLICT that adds this process's
// counts to the hour's row. Atomic in PostgreSQL, so any number of processes
// can write the same hour at once without losing a count. Nothing is written
// when nothing ran: an idle server never wakes the database for telemetry. A
// failed write puts its counts back to be retried (bounded, telemetry.ts).
// Rows older than the retention window are deleted at most every six hours,
// and only by a process that is writing anyway.
//
// READS — three aggregate queries for the owner-only Algorithms room. A read
// never writes: what this process has recorded but not yet written is merged in
// memory by monitoring.ts, and other processes' last minute appears on their
// next write.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { recordOutcome } from '../infra/outcome-meter';
import { MONITORING } from './monitoring-spec';
import { takePending, restorePending, recorderCounters, failureKindOf, type TelemetryEntry } from './telemetry';
import { runtimeFingerprints } from './runtime-fingerprint';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PURGE_EVERY_MS = 6 * HOUR_MS;
/** Rows per INSERT. Far above what one minute produces; a backlog is written in slices. */
const ROWS_PER_STATEMENT = 200;

const status = {
  started: false,
  lastFlushAt: null as number | null,
  lastFlushOk: null as boolean | null,
  lastFlushFailure: null as string | null,
  rowsWritten: 0,
  flushes: 0,
  failedFlushes: 0,
  lastPurgeAt: null as number | null,
};

const iso = (ms: number) => new Date(ms).toISOString();

function valuesOf(e: TelemetryEntry): Prisma.Sql {
  // Every value is a bound parameter with an explicit type: an instant travels
  // as an ISO string with its zone, so a session TimeZone cannot move it.
  return Prisma.sql`(
    gen_random_uuid()::text, ${e.key}, ${e.version}, ${e.fingerprint}, ${e.source}, ${iso(e.bucketStart)}::timestamptz,
    ${e.executions}::int, ${e.failures}::int, ${e.outputs}::int, ${e.outOfContract}::int,
    ${String(Math.round(e.latencySumUs))}::bigint, ${e.latencyMaxUs}::int,
    ARRAY[${Prisma.join(e.latencyBins.map((v) => Prisma.sql`${v}::int`))}]::int[],
    ARRAY[${Prisma.join(e.outputBins.map((v) => Prisma.sql`${v}::int`))}]::int[],
    ${e.qualityOk}::int, ${e.qualityPartial}::int, ${e.qualityEmpty}::int, ${e.freshnessFresh}::int, ${e.freshnessStale}::int,
    ${iso(e.firstAt)}::timestamptz, ${iso(e.lastAt)}::timestamptz,
    ${e.lastFailureAt === null ? null : iso(e.lastFailureAt)}::timestamptz, ${e.lastFailureKind}::text,
    now()
  )`;
}

/** Element-wise sum of two integer arrays, in order. */
const addArrays = (col: string) => Prisma.raw(
  `ARRAY(SELECT COALESCE(u.a, 0) + COALESCE(u.b, 0) FROM unnest(t."${col}", EXCLUDED."${col}") WITH ORDINALITY AS u(a, b, i) ORDER BY u.i)`,
);

/**
 * One atomic INSERT … ON CONFLICT for these rows. Exported for the real
 * PostgreSQL proof that concurrent writers lose nothing; the server calls it
 * only through `flushAlgorithmTelemetry`.
 */
export async function writeTelemetryRows(rows: readonly TelemetryEntry[]): Promise<void> {
  if (!rows.length) return;
  await prisma.$executeRaw`
    INSERT INTO "AlgorithmTelemetryBucket" AS t (
      "id", "algorithmKey", "version", "fingerprint", "source", "bucketStart",
      "executions", "failures", "outputs", "outOfContract",
      "latencySumUs", "latencyMaxUs", "latencyBins", "outputBins",
      "qualityOk", "qualityPartial", "qualityEmpty", "freshnessFresh", "freshnessStale",
      "firstAt", "lastAt", "lastFailureAt", "lastFailureKind", "updatedAt"
    ) VALUES ${Prisma.join(rows.map(valuesOf))}
    ON CONFLICT ("algorithmKey", "version", "fingerprint", "source", "bucketStart") DO UPDATE SET
      "executions"      = t."executions" + EXCLUDED."executions",
      "failures"        = t."failures" + EXCLUDED."failures",
      "outputs"         = t."outputs" + EXCLUDED."outputs",
      "outOfContract"   = t."outOfContract" + EXCLUDED."outOfContract",
      "latencySumUs"    = t."latencySumUs" + EXCLUDED."latencySumUs",
      "latencyMaxUs"    = GREATEST(t."latencyMaxUs", EXCLUDED."latencyMaxUs"),
      "latencyBins"     = ${addArrays('latencyBins')},
      "outputBins"      = ${addArrays('outputBins')},
      "qualityOk"       = t."qualityOk" + EXCLUDED."qualityOk",
      "qualityPartial"  = t."qualityPartial" + EXCLUDED."qualityPartial",
      "qualityEmpty"    = t."qualityEmpty" + EXCLUDED."qualityEmpty",
      "freshnessFresh"  = t."freshnessFresh" + EXCLUDED."freshnessFresh",
      "freshnessStale"  = t."freshnessStale" + EXCLUDED."freshnessStale",
      "firstAt"         = LEAST(t."firstAt", EXCLUDED."firstAt"),
      "lastAt"          = GREATEST(t."lastAt", EXCLUDED."lastAt"),
      "lastFailureKind" = CASE WHEN EXCLUDED."lastFailureAt" IS NOT NULL
                                AND (t."lastFailureAt" IS NULL OR EXCLUDED."lastFailureAt" >= t."lastFailureAt")
                               THEN EXCLUDED."lastFailureKind" ELSE t."lastFailureKind" END,
      "lastFailureAt"   = GREATEST(t."lastFailureAt", EXCLUDED."lastFailureAt"),
      "updatedAt"       = now()`;
}

async function purgeIfDue(now: number): Promise<void> {
  if (status.lastPurgeAt !== null && now - status.lastPurgeAt < PURGE_EVERY_MS) return;
  const cutoff = iso(now - MONITORING.retentionDays * DAY_MS);
  await prisma.$executeRaw`DELETE FROM "AlgorithmTelemetryBucket" WHERE "bucketStart" < ${cutoff}::timestamptz`;
  status.lastPurgeAt = now;
}

export interface FlushResult { rows: number; ok: boolean }

async function doFlush(): Promise<FlushResult> {
  const list = takePending();
  if (!list.length) return { rows: 0, ok: true };
  let written = 0;
  try {
    for (let i = 0; i < list.length; i += ROWS_PER_STATEMENT) {
      await writeTelemetryRows(list.slice(i, i + ROWS_PER_STATEMENT));
      written = Math.min(list.length, i + ROWS_PER_STATEMENT);
    }
    const now = Date.now();
    status.flushes += 1;
    status.rowsWritten += written;
    status.lastFlushAt = now;
    status.lastFlushOk = true;
    status.lastFlushFailure = null;
    recordOutcome('algorithm-telemetry', true);
    try { await purgeIfDue(now); } catch (err) {
      logger.warn('[algorithms] telemetry retention purge failed (will retry)', { kind: failureKindOf(err) });
    }
    return { rows: written, ok: true };
  } catch (err) {
    restorePending(list.slice(written));
    status.failedFlushes += 1;
    status.lastFlushAt = Date.now();
    status.lastFlushOk = false;
    status.lastFlushFailure = failureKindOf(err);
    recordOutcome('algorithm-telemetry', false);
    logger.warn('[algorithms] telemetry write failed (kept in memory, will retry)', { kind: status.lastFlushFailure });
    return { rows: written, ok: false };
  }
}

let inFlight: Promise<FlushResult> | null = null;

/** Write what this process recorded. One write at a time; a second caller shares the first. */
export function flushAlgorithmTelemetry(): Promise<FlushResult> {
  if (!inFlight) inFlight = doFlush().finally(() => { inFlight = null; });
  return inFlight;
}

/** Resolves when no write is in flight — so a read never sees a minute twice or not at all. */
export async function settledFlush(): Promise<void> {
  if (inFlight) await inFlight.catch(() => undefined);
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start this process's writer, and fingerprint the algorithm code it loaded
 * now — at start, before any request, so no request pays for it. Every server
 * process runs one (it is not a leased worker: each process writes only what
 * it recorded itself).
 */
export function startAlgorithmTelemetry(): void {
  if (status.started) return;
  status.started = true;
  try { runtimeFingerprints(); } catch (err) {
    logger.warn('[algorithms] runtime fingerprints could not be computed', { kind: failureKindOf(err) });
  }
  timer = setInterval(() => { void flushAlgorithmTelemetry(); }, MONITORING.flushIntervalSeconds * 1000);
  timer.unref();
}

/** Stop the writer and write what is left. Called on shutdown, before the database disconnects. */
export async function stopAlgorithmTelemetry(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  status.started = false;
  await flushAlgorithmTelemetry().catch(() => undefined);
}

export interface StoreStatus {
  state: 'OK' | 'FAILING' | 'NOT_STARTED' | 'IDLE';
  lastFlushAt: string | null;
  lastFlushFailure: string | null;
  rowsWritten: number;
  pendingEntries: number;
  droppedRuns: number;
  flushIntervalSeconds: number;
}

export function storeStatus(): StoreStatus {
  const c = recorderCounters();
  const state = status.lastFlushOk === false ? 'FAILING'
    : status.lastFlushOk === true ? 'OK'
      : status.started ? 'IDLE' : 'NOT_STARTED';
  return {
    state,
    lastFlushAt: status.lastFlushAt === null ? null : iso(status.lastFlushAt),
    lastFlushFailure: status.lastFlushFailure,
    rowsWritten: status.rowsWritten,
    pendingEntries: c.pendingEntries,
    droppedRuns: c.dropped,
    flushIntervalSeconds: MONITORING.flushIntervalSeconds,
  };
}

/** For tests: forget the writer's state. */
export function resetTelemetryStore(): void {
  if (timer) { clearInterval(timer); timer = null; }
  Object.assign(status, {
    started: false, lastFlushAt: null, lastFlushOk: null, lastFlushFailure: null,
    rowsWritten: 0, flushes: 0, failedFlushes: 0, lastPurgeAt: null,
  });
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Sums over one window for one group. */
export interface WindowSums {
  executions: number; failures: number; outputs: number; outOfContract: number;
  latencySumUs: number; latencyMaxUs: number;
  qualityOk: number; qualityPartial: number; qualityEmpty: number;
  freshnessFresh: number; freshnessStale: number;
  latencyBins: number[]; outputBins: number[];
}

/** One (algorithm, version, fingerprint, workflow), over every window the room reads. */
export interface GroupAggregate {
  key: string; version: string; fingerprint: string; source: string;
  last24h: { executions: number; failures: number };
  recent: WindowSums;
  baseline: WindowSums;
  retained: { executions: number; failures: number };
  firstAt: number | null; lastAt: number | null;
  lastFailureAt: number | null; lastFailureKind: string | null;
}

export interface DayAggregate { key: string; day: string; executions: number; failures: number }

export interface TelemetryAggregates { groups: GroupAggregate[]; daily: DayAggregate[] }

/** The boundaries every figure is read against, aligned to UTC hours like the rows. */
export function windowsAt(now: number) {
  const hour = now - (now % HOUR_MS);
  return {
    last24h: hour - 23 * HOUR_MS,
    recent: hour - (MONITORING.recentDays * 24 - 1) * HOUR_MS,
    baseline: hour - ((MONITORING.recentDays + MONITORING.baselineDays) * 24 - 1) * HOUR_MS,
    retained: hour - (MONITORING.retentionDays * 24 - 1) * HOUR_MS,
    dailyFrom: (now - (now % DAY_MS)) - 13 * DAY_MS,
  };
}

export const emptySums = (): WindowSums => ({
  executions: 0, failures: 0, outputs: 0, outOfContract: 0, latencySumUs: 0, latencyMaxUs: 0,
  qualityOk: 0, qualityPartial: 0, qualityEmpty: 0, freshnessFresh: 0, freshnessStale: 0,
  latencyBins: [], outputBins: [],
});

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const ms = (v: unknown): number | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
};
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.map(num) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface ScalarRow { [k: string]: unknown }

/**
 * Every window the room reads, aggregated in PostgreSQL. Rows that do not
 * carry what a group needs are skipped, never guessed at.
 */
export async function readTelemetryAggregates(now: number): Promise<TelemetryAggregates> {
  const w = windowsAt(now);
  const [w24, wRecent, wBase, wRet, wDay] = [w.last24h, w.recent, w.baseline, w.retained, w.dailyFrom].map((x) => iso(x));

  const [scalars, bins, days] = await Promise.all([
    prisma.$queryRaw<ScalarRow[]>`
      SELECT "algorithmKey" AS key, "version", "fingerprint", "source",
        COALESCE(SUM("executions") FILTER (WHERE "bucketStart" >= ${w24}::timestamptz), 0)::bigint      AS "exec24",
        COALESCE(SUM("failures")   FILTER (WHERE "bucketStart" >= ${w24}::timestamptz), 0)::bigint      AS "fail24",
        COALESCE(SUM("executions") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint  AS "execR",
        COALESCE(SUM("failures")   FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint  AS "failR",
        COALESCE(SUM("outputs")    FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint  AS "outR",
        COALESCE(SUM("outOfContract") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "oocR",
        COALESCE(SUM("latencySumUs") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "latSumR",
        COALESCE(MAX("latencyMaxUs") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "latMaxR",
        COALESCE(SUM("qualityOk")      FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "qOkR",
        COALESCE(SUM("qualityPartial") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "qPartR",
        COALESCE(SUM("qualityEmpty")   FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "qEmptyR",
        COALESCE(SUM("freshnessFresh") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "fFreshR",
        COALESCE(SUM("freshnessStale") FILTER (WHERE "bucketStart" >= ${wRecent}::timestamptz), 0)::bigint AS "fStaleR",
        COALESCE(SUM("executions") FILTER (WHERE "bucketStart" >= ${wBase}::timestamptz AND "bucketStart" < ${wRecent}::timestamptz), 0)::bigint AS "execB",
        COALESCE(SUM("failures")   FILTER (WHERE "bucketStart" >= ${wBase}::timestamptz AND "bucketStart" < ${wRecent}::timestamptz), 0)::bigint AS "failB",
        COALESCE(SUM("outputs")    FILTER (WHERE "bucketStart" >= ${wBase}::timestamptz AND "bucketStart" < ${wRecent}::timestamptz), 0)::bigint AS "outB",
        COALESCE(SUM("outOfContract") FILTER (WHERE "bucketStart" >= ${wBase}::timestamptz AND "bucketStart" < ${wRecent}::timestamptz), 0)::bigint AS "oocB",
        COALESCE(SUM("latencySumUs") FILTER (WHERE "bucketStart" >= ${wBase}::timestamptz AND "bucketStart" < ${wRecent}::timestamptz), 0)::bigint AS "latSumB",
        COALESCE(MAX("latencyMaxUs") FILTER (WHERE "bucketStart" >= ${wBase}::timestamptz AND "bucketStart" < ${wRecent}::timestamptz), 0)::bigint AS "latMaxB",
        COALESCE(SUM("executions"), 0)::bigint AS "execAll",
        COALESCE(SUM("failures"), 0)::bigint   AS "failAll",
        MIN("firstAt") AS "firstAt",
        MAX("lastAt")  AS "lastAt",
        MAX("lastFailureAt") AS "lastFailureAt",
        (array_agg("lastFailureKind" ORDER BY "lastFailureAt" DESC NULLS LAST))[1] AS "lastFailureKind"
      FROM "AlgorithmTelemetryBucket"
      WHERE "bucketStart" >= ${wRet}::timestamptz
      GROUP BY "algorithmKey", "version", "fingerprint", "source"`,
    prisma.$queryRaw<ScalarRow[]>`
      SELECT key, "version", "fingerprint", "source", win, kind, array_agg(total ORDER BY idx) AS bins FROM (
        SELECT b."algorithmKey" AS key, b."version", b."fingerprint", b."source",
               CASE WHEN b."bucketStart" >= ${wRecent}::timestamptz THEN 'recent' ELSE 'baseline' END AS win,
               'output' AS kind, u.idx, SUM(u.v)::bigint AS total
        FROM "AlgorithmTelemetryBucket" b
        CROSS JOIN LATERAL unnest(b."outputBins") WITH ORDINALITY AS u(v, idx)
        WHERE b."bucketStart" >= ${wBase}::timestamptz
        GROUP BY 1, 2, 3, 4, 5, 7
        UNION ALL
        SELECT b."algorithmKey" AS key, b."version", b."fingerprint", b."source",
               CASE WHEN b."bucketStart" >= ${wRecent}::timestamptz THEN 'recent' ELSE 'baseline' END AS win,
               'latency' AS kind, u.idx, SUM(u.v)::bigint AS total
        FROM "AlgorithmTelemetryBucket" b
        CROSS JOIN LATERAL unnest(b."latencyBins") WITH ORDINALITY AS u(v, idx)
        WHERE b."bucketStart" >= ${wBase}::timestamptz
        GROUP BY 1, 2, 3, 4, 5, 7
      ) x
      GROUP BY key, "version", "fingerprint", "source", win, kind`,
    prisma.$queryRaw<ScalarRow[]>`
      SELECT "algorithmKey" AS key,
             to_char(date_trunc('day', "bucketStart" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             SUM("executions")::bigint AS executions, SUM("failures")::bigint AS failures
      FROM "AlgorithmTelemetryBucket"
      WHERE "bucketStart" >= ${wDay}::timestamptz
      GROUP BY 1, 2`,
  ]);

  const groups = new Map<string, GroupAggregate>();
  const idOf = (r: ScalarRow) => `${r.key}|${r.version}|${r.fingerprint}|${r.source}`;
  for (const r of Array.isArray(scalars) ? scalars : []) {
    const key = str(r.key), version = str(r.version), fingerprint = str(r.fingerprint), source = str(r.source);
    if (!key || !version || !fingerprint || !source) continue;
    groups.set(idOf(r), {
      key, version, fingerprint, source,
      last24h: { executions: num(r.exec24), failures: num(r.fail24) },
      recent: {
        ...emptySums(),
        executions: num(r.execR), failures: num(r.failR), outputs: num(r.outR), outOfContract: num(r.oocR),
        latencySumUs: num(r.latSumR), latencyMaxUs: num(r.latMaxR),
        qualityOk: num(r.qOkR), qualityPartial: num(r.qPartR), qualityEmpty: num(r.qEmptyR),
        freshnessFresh: num(r.fFreshR), freshnessStale: num(r.fStaleR),
      },
      baseline: {
        ...emptySums(),
        executions: num(r.execB), failures: num(r.failB), outputs: num(r.outB), outOfContract: num(r.oocB),
        latencySumUs: num(r.latSumB), latencyMaxUs: num(r.latMaxB),
      },
      retained: { executions: num(r.execAll), failures: num(r.failAll) },
      firstAt: ms(r.firstAt), lastAt: ms(r.lastAt),
      lastFailureAt: ms(r.lastFailureAt), lastFailureKind: str(r.lastFailureKind),
    });
  }
  for (const r of Array.isArray(bins) ? bins : []) {
    const g = groups.get(idOf(r));
    if (!g || (r.win !== 'recent' && r.win !== 'baseline') || (r.kind !== 'output' && r.kind !== 'latency')) continue;
    const sums = r.win === 'recent' ? g.recent : g.baseline;
    if (r.kind === 'output') sums.outputBins = ints(r.bins); else sums.latencyBins = ints(r.bins);
  }
  const daily: DayAggregate[] = [];
  for (const r of Array.isArray(days) ? days : []) {
    const key = str(r.key), day = str(r.day);
    if (!key || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    daily.push({ key, day, executions: num(r.executions), failures: num(r.failures) });
  }
  return { groups: [...groups.values()], daily };
}
