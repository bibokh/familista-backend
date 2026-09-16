// Crash-durable historical delivery, on the outbox that already exists
// ─────────────────────────────────────────────────────────────────────────────
// THE INSIGHT THIS FILE IS BUILT ON
//
// There is already a durable, recoverable record of every Fabric event, and it
// is written BEFORE the historical write is attempted:
//
//   emit()
//     → transport.append()          `EventOutbox` row, COMMITTED     ← durable
//     → noteFabricPublishOutcome()
//     → recordHistoryDetached()     `FabricEventHistory` row          ← may fail
//
// So when a historical write fails, the event is not lost. It is sitting in
// `EventOutbox` with its whole envelope in `payload.__familista_event`, and
// `eventFromRow` — which the live board and the replay window already use —
// reconstructs it exactly. The in-process retry queue is an OPTIMISATION that
// makes the common case fast; this is the guarantee that makes a crash
// survivable.
//
// WHY NOT A SECOND QUEUE, OR A DELIVERY COLUMN
//
// A second outbox would be a second thing to keep consistent with the first,
// and a `historyDeliveredAt` column on `EventOutbox` would be a migration that
// modifies a hot, shared table for one consumer's bookkeeping — and would make
// the outbox mutable on a path that is currently insert-only.
//
// Neither is needed. The two tables already carry the answer between them: an
// outbox row whose `eventId` has no `FabricEventHistory` row is, by
// definition, a delivery that has not happened. The set difference IS the
// pending state, it needs no column to maintain and no column to get wrong, and
// it is correct after any crash at any point because neither side was ever
// half-written.
//
// COMPLETION IS THE ROW ITSELF
//
// "Marking the delivery complete" is the historical row existing. There is no
// flag to clear and therefore no window in which the flag and the fact
// disagree. A second recovery pass over the same outbox row finds the history
// row present and does nothing.
//
// BOUNDED, AT THREE LEVELS
//
// A time window, a batch size, and a per-invocation pass. This sweeps recent
// history and returns; it does not walk the whole outbox, and it does not loop
// until the backlog is empty. A sweep that cannot finish its batch leaves the
// rest for the next one — which is the behaviour that keeps a degraded database
// from being hammered by the process that is meant to be recovering it.
//
// WHAT THIS CANNOT RECOVER, STATED PLAINLY
//
//   · An event whose OUTBOX append itself failed. There is no durable record of
//     it anywhere, by definition. That failure is already latched and reported
//     as `system.fabric.publisher.degraded`, which is the honest signal.
//   · An event whose outbox row has been deleted by the retention worker. The
//     recovery window is therefore bounded by outbox retention, which is a real
//     limit and is documented rather than hidden.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { eventFromRow, isFabricRow } from '../outbox-transport';
import { recordHistory } from './history-writer.service';

/** How far back one sweep looks. Not the whole outbox — a bounded window. */
const LOOKBACK_MS = Number(process.env.FABRIC_HISTORY_RECOVERY_LOOKBACK_MS ?? 24 * 60 * 60_000);
/** How many outbox rows one sweep examines. */
const BATCH = Number(process.env.FABRIC_HISTORY_RECOVERY_BATCH ?? 500);
/** How often the worker sweeps. Zero disables it. */
const SWEEP_MS = Number(process.env.FABRIC_HISTORY_RECOVERY_SWEEP_MS ?? 5 * 60_000);

export interface RecoveryResult {
  /** Outbox rows examined in this sweep. */
  examined: number;
  /** Rows that had no historical record and were delivered by this sweep. */
  recovered: number;
  /** Rows already present — a second pass over work a first pass finished. */
  alreadyPresent: number;
  /** Rows that could not be delivered this time. They stay recoverable. */
  failed: number;
  /** Rows skipped because they carry no Fabric envelope (legacy producers). */
  skipped: number;
}

const EMPTY: RecoveryResult = { examined: 0, recovered: 0, alreadyPresent: 0, failed: 0, skipped: 0 };

let lastSweepAt: string | null = null;
let lastResult: RecoveryResult = EMPTY;
let totalRecovered = 0;
let sweeping = false;
let timer: NodeJS.Timeout | null = null;

/**
 * One sweep.
 *
 * Reads a bounded window of outbox rows, asks the historical store which of
 * them it already holds, and delivers the difference.
 *
 * Idempotent at two levels, deliberately. The set difference means a row that
 * was delivered is not attempted again; and if two instances sweep the same
 * window at the same moment, the unique index on `eventId` makes the loser's
 * insert a `DUPLICATE` rather than a second row. Neither level alone would be
 * enough — the first is a race, the second is a guarantee.
 *
 * Never throws. A recovery sweep that fails is a sweep that will run again.
 */
export async function recoverHistory(options: {
  since?: Date; until?: Date; batch?: number;
} = {}): Promise<RecoveryResult> {
  if (sweeping) return EMPTY;          // one sweep at a time, per process
  sweeping = true;
  const result: RecoveryResult = { ...EMPTY };

  try {
    const until = options.until ?? new Date();
    const since = options.since ?? new Date(until.getTime() - LOOKBACK_MS);
    const take = Math.max(1, Math.min(Number(options.batch ?? BATCH), 5_000));

    const rows = await prisma.eventOutbox.findMany({
      where: { createdAt: { gte: since, lte: until } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      select: {
        id: true, clubId: true, kind: true, payload: true,
        source: true, createdAt: true, idempotencyKey: true,
      },
    });
    result.examined = rows.length;
    if (!rows.length) return result;

    // Only rows this transport wrote. A legacy row has no envelope, no schema
    // and no classification, and inventing a historical record for one would be
    // recording something the platform never actually knew.
    const fabric = rows.filter((r) => isFabricRow(r.payload));
    result.skipped = rows.length - fabric.length;

    const events = fabric
      .map((r) => eventFromRow(r as never))
      .filter((e): e is NonNullable<typeof e> => !!e && !!e.eventId);

    if (!events.length) return result;

    // One query for the whole batch, not one per row.
    const present = await prisma.fabricEventHistory.findMany({
      where: { eventId: { in: events.map((e) => String(e.eventId)) } },
      select: { eventId: true },
    });
    const delivered = new Set(present.map((p) => p.eventId));

    for (const event of events) {
      if (delivered.has(String(event.eventId))) { result.alreadyPresent += 1; continue; }
      // The outbox row exists, so the transport stored it. `STORED` is the
      // honest status for a record recovered from a row that is there.
      const outcome = await recordHistory(event, 'STORED');
      if (outcome === 'FAILED') result.failed += 1;
      else result.recovered += 1;
    }

    totalRecovered += result.recovered;
    if (result.recovered > 0 || result.failed > 0) {
      logger.info('[fabric-history] recovery sweep', { ...result });
    }
    return result;
  } catch (err) {
    logger.error('[fabric-history] recovery sweep failed', {
      err: (err as Error)?.message?.slice(0, 200),
    });
    return result;
  } finally {
    lastSweepAt = new Date().toISOString();
    lastResult = result;
    sweeping = false;
  }
}

/**
 * Start the recovery worker.
 *
 * Called at boot. The first sweep runs one interval in rather than immediately,
 * so a fresh instance is not competing with its own startup for the database —
 * and because anything that failed a moment ago is still in the in-process
 * queue, which is faster.
 */
export function startHistoryRecovery(): void {
  if (timer || SWEEP_MS <= 0) return;
  timer = setInterval(() => { void recoverHistory(); }, SWEEP_MS);
  // Never hold the process open for a recovery sweep.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('[fabric-history] recovery worker started', { sweepMs: SWEEP_MS, lookbackMs: LOOKBACK_MS });
}

export function stopHistoryRecovery(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** What recovery knows about itself. Real counters, no estimates. */
export function historyRecoveryHealth(): {
  enabled: boolean;
  sweepMs: number;
  lookbackMs: number;
  lastSweepAt: string | null;
  lastSweep: RecoveryResult;
  totalRecovered: number;
  /** Process counters, reset by a restart. The DURABILITY is in the two tables. */
  scope: 'PROCESS';
} {
  return {
    enabled: SWEEP_MS > 0,
    sweepMs: SWEEP_MS,
    lookbackMs: LOOKBACK_MS,
    lastSweepAt,
    lastSweep: lastResult,
    totalRecovered,
    scope: 'PROCESS',
  };
}

/** Clear the worker's state. Tests only. */
export function resetHistoryRecovery(): void {
  stopHistoryRecovery();
  lastSweepAt = null;
  lastResult = { ...EMPTY };
  totalRecovered = 0;
  sweeping = false;
}

/**
 * How many events in a window are recorded in the outbox but not in history.
 *
 * The real pending count, computed from the two tables rather than from a
 * counter a restart would reset — which is the point of the whole design. A
 * non-zero answer after a sweep means delivery is genuinely behind, and an
 * operator can act on it.
 */
export async function pendingHistoryDelivery(options: { since?: Date; until?: Date; batch?: number } = {}): Promise<{
  examined: number; pending: number; window: { since: string; until: string };
}> {
  const until = options.until ?? new Date();
  const since = options.since ?? new Date(until.getTime() - LOOKBACK_MS);
  const take = Math.max(1, Math.min(Number(options.batch ?? BATCH), 5_000));

  const rows = await prisma.eventOutbox.findMany({
    where: { createdAt: { gte: since, lte: until } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true, clubId: true, kind: true, payload: true,
      source: true, createdAt: true, idempotencyKey: true,
    },
  });

  const events = rows
    .filter((r) => isFabricRow(r.payload))
    .map((r) => eventFromRow(r as never))
    .filter((e): e is NonNullable<typeof e> => !!e && !!e.eventId);

  if (!events.length) {
    return { examined: rows.length, pending: 0, window: { since: since.toISOString(), until: until.toISOString() } };
  }

  const present = await prisma.fabricEventHistory.findMany({
    where: { eventId: { in: events.map((e) => String(e.eventId)) } },
    select: { eventId: true },
  });

  return {
    examined: rows.length,
    pending: events.length - present.length,
    window: { since: since.toISOString(), until: until.toISOString() },
  };
}
