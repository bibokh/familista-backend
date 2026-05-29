// Familista — Stats Aggregator Worker (Phase Q)
// Target: src/workers/stats-aggregator.worker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Drains the EventOutbox for 'stats.aggregate' messages, then:
//   1. Rebuilds PlayerMatchStats for every actor in the match.
//   2. Triggers a season rollup for each affected player.
//
// Designed to run as a long-lived sidecar process started from src/index.ts:
//   startStatsAggregatorWorker()
//
// Polling interval: configurable via STATS_WORKER_INTERVAL_MS (default 5 000 ms).
// Batch size: STATS_WORKER_BATCH (default 20 outbox events per tick).
//
// Error isolation: a single failing match does not block others in the batch.
// On permanent failure (retries >= MAX_RETRIES) the outbox row is marked FAILED
// so the dead-letter set can be inspected and replayed manually.
//
// Season rollup: after stats are rebuilt we resolve the season string from the
// Match row (match.season) and roll up for every (playerId, clubId, season)
// tuple seen in the match. Competition-scoped rollup fires if the match is
// linked to a Fixture with a competitionId.

import { prisma } from '../config/database';
import { computeMatchStats, rollupSeasonStats } from '../player-stats/player-stats.service';

const POLL_INTERVAL = parseInt(process.env.STATS_WORKER_INTERVAL_MS ?? '5000', 10);
const BATCH_SIZE    = parseInt(process.env.STATS_WORKER_BATCH       ?? '20',   10);
const MAX_RETRIES   = 3;

let _running = false;
let _timer:   NodeJS.Timeout | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export function startStatsAggregatorWorker(): void {
  if (_running) return;
  _running = true;
  _log('started');
  _schedule();
}

export function stopStatsAggregatorWorker(): void {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _log('stopped');
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function _tick(): Promise<void> {
  try {
    const rows = await prisma.eventOutbox.findMany({
      where: {
        topic:       'stats.aggregate',
        processedAt: null,
        failedAt:    null,
        retryCount:  { lt: MAX_RETRIES },
      },
      orderBy: { createdAt: 'asc' },
      take:    BATCH_SIZE,
    });

    if (rows.length === 0) return;
    _log(`processing ${rows.length} outbox events`);

    await Promise.allSettled(rows.map((row) => _processRow(row)));
  } catch (err) {
    _log(`tick error: ${(err as Error).message}`);
  } finally {
    if (_running) _schedule();
  }
}

async function _processRow(row: { id: string; payload: unknown; retryCount: number }): Promise<void> {
  const matchId: string | undefined = (row.payload as any)?.matchId;
  if (!matchId) {
    await _markFailed(row.id, 'missing matchId in payload');
    return;
  }

  try {
    // Step 1: rebuild per-match stats.
    const { rebuilt } = await computeMatchStats(matchId);
    _log(`match ${matchId}: rebuilt ${rebuilt} player-match-stats`);

    // Step 2: season rollup for every affected player.
    await _triggerSeasonRollups(matchId);

    // Step 3: mark processed.
    await prisma.eventOutbox.update({
      where: { id: row.id },
      data:  { processedAt: new Date() },
    });
  } catch (err) {
    const nextRetry = row.retryCount + 1;
    _log(`match ${matchId} failed (attempt ${nextRetry}): ${(err as Error).message}`);

    if (nextRetry >= MAX_RETRIES) {
      await _markFailed(row.id, (err as Error).message);
    } else {
      await prisma.eventOutbox.update({
        where: { id: row.id },
        data:  { retryCount: nextRetry },
      });
    }
  }
}

async function _triggerSeasonRollups(matchId: string): Promise<void> {
  // Resolve season and competitionId from the match → fixture → competition chain.
  const match = await prisma.match.findUnique({
    where:  { id: matchId },
    select: { season: true, clubId: true, fixtures: { select: { competitionId: true }, take: 1 } },
  });
  if (!match) return;

  const season        = match.season ?? new Date().getFullYear().toString();
  const competitionId = (match.fixtures?.[0] as any)?.competitionId ?? undefined;

  // Collect distinct (playerId, clubId) pairs from the rebuilt stats rows.
  const statsRows = await prisma.playerMatchStats.findMany({
    where:  { matchId },
    select: { playerId: true, clubId: true },
    distinct: ['playerId'],
  });

  await Promise.allSettled(
    statsRows.map(async ({ playerId, clubId }) => {
      try {
        await rollupSeasonStats(playerId, clubId, season, competitionId);
      } catch (err) {
        _log(`season rollup failed for player ${playerId}: ${(err as Error).message}`);
      }
    }),
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _markFailed(id: string, reason: string): Promise<void> {
  await prisma.eventOutbox.update({
    where: { id },
    data:  { failedAt: new Date(), errorLog: reason },
  }).catch(() => {});
}

function _schedule(): void {
  _timer = setTimeout(() => { _tick(); }, POLL_INTERVAL);
}

function _log(msg: string): void {
  // Structured log line — picked up by Render log drain / Datadog.
  console.log(JSON.stringify({ ts: new Date().toISOString(), worker: 'stats-aggregator', msg }));
}
