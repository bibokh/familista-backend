// Algorithms Step 2 — the match rating, observed in production
// ─────────────────────────────────────────────────────────────────────────────
// The registered match-rating algorithm (computeRating inside
// computeMatchStats, player-stats.service.ts) does its arithmetic inside the
// transaction that stores it, so its outputs cannot be seen as it returns.
// This reads them back once that transaction has committed: the ratings of
// the match just rebuilt, as numbers, binned by the telemetry recorder and
// then forgotten. No player id, no club, no match id leaves this function.
//
// Observation only. It runs after the rebuild, is never awaited by it, and a
// failure here is swallowed: the rebuild, its result and its caller are
// exactly what they were without it. player-stats.service.ts is not changed.

import { prisma } from '../config/database';
import { recordOutputs } from '../algorithms/telemetry';

export type RatingWorkflow = 'stats.aggregator' | 'stats.rebuild';

export async function observeMatchRatings(matchId: string, workflow: RatingWorkflow): Promise<void> {
  try {
    const rows = await prisma.playerMatchStats.findMany({
      where: { matchId, ratingFamilista: { not: null } },
      select: { ratingFamilista: true },
    });
    recordOutputs('match-rating', workflow, { outputs: rows.map((r) => r.ratingFamilista as number) });
  } catch {
    /* observation only — never affects the rebuild */
  }
}
