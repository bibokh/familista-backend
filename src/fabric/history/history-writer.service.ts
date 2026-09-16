// The historical writer
// ─────────────────────────────────────────────────────────────────────────────
// One write per event, central, and never on the caller's path.
//
// THREE GUARANTEES, IN ORDER OF IMPORTANCE
//
// 1. A HISTORY FAILURE NEVER FAILS A BUSINESS TRANSACTION. Nobody asked for
//    observability when they suspended a coach or deleted a club. This is
//    called detached from `emit()`, it catches everything, and it returns void
//    — there is no path by which a database hiccup here reaches a user.
//
// 2. AN EVENT IS NEVER SILENTLY LOST. A failure goes onto a BOUNDED retry
//    queue and is tried again on a timer, a fixed number of times. When the
//    attempts are spent, or the queue is full, the writer latches DEGRADED and
//    says so through `fabricHistoryHealth()` — which the Fabric status surface
//    reads. Losing an event is permitted; losing it quietly is not.
//
// 3. A RETRY NEVER DUPLICATES. `FabricEventHistory.eventId` is unique, and the
//    write is an upsert-by-absence: a duplicate key is success, not an error.
//    Ten retries of one event produce one row.
//
// WHY NOT AN INFINITE LOOP
//
// A queue that retries for ever is a queue that pins a CPU against a database
// that is down, and a memory leak against one that stays down. The queue has a
// hard size, each entry has a hard attempt count, and an entry that exhausts
// both is dropped and COUNTED. `fabricHistoryHealth().dropped` is the number
// this process could not store, which is a real number an operator can act on.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import type { FamilistaEvent } from '../event-envelope';
import { historicalRecord, type HistoricalRecord } from './history-record';

/** How many failed records the queue will hold before it starts dropping. */
const QUEUE_LIMIT = Number(process.env.FABRIC_HISTORY_QUEUE_LIMIT ?? 500);
/** How many times one record is retried before it is dropped and counted. */
const MAX_ATTEMPTS = Number(process.env.FABRIC_HISTORY_MAX_ATTEMPTS ?? 3);
/** How long between sweeps of the retry queue. */
const RETRY_MS = Number(process.env.FABRIC_HISTORY_RETRY_MS ?? 30_000);

interface Pending { record: HistoricalRecord; attempts: number }

const queue: Pending[] = [];
let timer: NodeJS.Timeout | null = null;

let written = 0;
let duplicates = 0;
let failures = 0;
let dropped = 0;
let degraded = false;
let lastError: string | null = null;
let lastWriteAt: string | null = null;

/** Whether a Prisma error is the unique constraint on `eventId`. */
function isDuplicate(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== 'P2002') return false;
  const target = e?.meta?.target;
  const named = Array.isArray(target) ? target.join(',') : String(target ?? '');
  // Any unique violation on this table can only be `eventId` — it is the only
  // unique constraint — but naming it keeps the check honest if that changes.
  return named.includes('eventId') || named === 'undefined' || named === '';
}

/**
 * One attempt at one record.
 *
 * Returns `STORED`, `DUPLICATE` (which is success — the record is already
 * there) or `FAILED`. Never throws.
 */
async function attempt(record: HistoricalRecord): Promise<'STORED' | 'DUPLICATE' | 'FAILED'> {
  try {
    await prisma.fabricEventHistory.create({
      data: {
        eventId: record.eventId,
        eventType: record.eventType,
        source: record.source,
        schemaVersion: record.schemaVersion,
        occurredAt: record.occurredAt,
        entityType: record.entityType,
        entityId: record.entityId,
        clubId: record.clubId,
        teamContext: record.teamContext ?? undefined,
        ageGroup: record.ageGroup,
        correlationId: record.correlationId,
        requestId: record.requestId,
        status: record.status,
        metadata: record.metadata ?? undefined,
        privacyClassification: record.privacyClassification,
        retentionClass: record.retentionClass,
      },
    });
    written += 1;
    lastWriteAt = new Date().toISOString();
    if (degraded && queue.length === 0) {
      degraded = false;
      lastError = null;
      logger.info('[fabric-history] writer recovered');
    }
    return 'STORED';
  } catch (err) {
    if (isDuplicate(err)) {
      // The record is already stored. A retry of an event that got through on
      // an earlier attempt lands here, and that is the idempotency guarantee
      // doing its job rather than an error.
      duplicates += 1;
      return 'DUPLICATE';
    }
    lastError = (err as Error)?.message?.slice(0, 200) ?? 'unknown';
    return 'FAILED';
  }
}

/** Put a failed record on the queue, or drop it and say so. */
function enqueue(pending: Pending): void {
  if (queue.length >= QUEUE_LIMIT) {
    dropped += 1;
    degraded = true;
    logger.error('[fabric-history] queue full, record dropped', {
      eventType: pending.record.eventType, dropped,
    });
    return;
  }
  queue.push(pending);
  degraded = true;
  ensureTimer();
}

function ensureTimer(): void {
  if (timer || RETRY_MS <= 0) return;
  timer = setTimeout(() => { timer = null; void drain(); }, RETRY_MS);
  // Never hold the process open for a retry queue.
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Sweep the queue once.
 *
 * Exported so a test can drive it deterministically rather than waiting on a
 * timer, and so an operator-facing job could call it on demand later.
 */
export async function drain(): Promise<{ stored: number; retrying: number; dropped: number }> {
  let stored = 0;
  const carry: Pending[] = [];
  const batch = queue.splice(0, queue.length);

  for (const pending of batch) {
    const outcome = await attempt(pending.record);
    if (outcome !== 'FAILED') { stored += 1; continue; }
    pending.attempts += 1;
    if (pending.attempts >= MAX_ATTEMPTS) {
      dropped += 1;
      logger.error('[fabric-history] gave up on a record', {
        eventType: pending.record.eventType, attempts: pending.attempts, dropped,
      });
      continue;
    }
    carry.push(pending);
  }

  queue.push(...carry);
  if (queue.length > 0) { degraded = true; ensureTimer(); }
  else if (dropped === 0) { degraded = false; lastError = null; }

  return { stored, retrying: queue.length, dropped };
}

/**
 * Record one event in history.
 *
 * Called from `emit()`, detached, for every event the publisher accepts —
 * which is what makes this automatic for producers that do not exist yet. A
 * producer registered next year needs no line of code here.
 *
 * Returns the outcome so a test can assert on it; no production caller awaits.
 */
export async function recordHistory(
  event: FamilistaEvent, status = 'STORED',
): Promise<'STORED' | 'DUPLICATE' | 'FAILED'> {
  let record: HistoricalRecord;
  try {
    record = historicalRecord(event, status);
  } catch (err) {
    // `historicalRecord` is written not to throw; if it ever does, that is a
    // bug in the redaction boundary and the event is not stored rather than
    // stored unredacted.
    failures += 1;
    degraded = true;
    lastError = `record build failed: ${(err as Error)?.message?.slice(0, 160)}`;
    logger.error('[fabric-history] could not build a record', { err: lastError });
    return 'FAILED';
  }

  if (!record.eventId) {
    // No id, no idempotency. Refused rather than stored as a row that a retry
    // would duplicate.
    failures += 1;
    return 'FAILED';
  }

  const outcome = await attempt(record);
  if (outcome === 'FAILED') {
    failures += 1;
    enqueue({ record, attempts: 1 });
  }
  return outcome;
}

/** Fire-and-forget. The shape `emit()` uses, so nothing there can await by accident. */
export function recordHistoryDetached(event: FamilistaEvent, status = 'STORED'): void {
  void recordHistory(event, status).catch(() => undefined);
}

/**
 * What the writer knows about itself.
 *
 * Real counters from this process, and nothing invented: `retryBacklog` is the
 * queue's actual length and `dropped` is the number of records this process
 * genuinely could not store. A restart resets them, which is stated rather than
 * papered over — these are process counters, not a persisted metric.
 */
export function fabricHistoryHealth(): {
  state: 'HEALTHY' | 'DEGRADED';
  written: number;
  duplicates: number;
  failures: number;
  dropped: number;
  retryBacklog: number;
  lastWriteAt: string | null;
  lastError: string | null;
  /** Process counters. Not persisted, and reset by a restart. */
  scope: 'PROCESS';
} {
  return {
    state: degraded || dropped > 0 ? 'DEGRADED' : 'HEALTHY',
    written, duplicates, failures, dropped,
    retryBacklog: queue.length,
    lastWriteAt, lastError,
    scope: 'PROCESS',
  };
}

/** Clear the writer's state. Tests only. */
export function resetFabricHistory(): void {
  queue.length = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  written = 0; duplicates = 0; failures = 0; dropped = 0;
  degraded = false; lastError = null; lastWriteAt = null;
}
