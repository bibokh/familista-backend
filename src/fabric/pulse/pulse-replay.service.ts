// Replaying a window of the outbox, with the same reader Live uses
// ─────────────────────────────────────────────────────────────────────────────
// Live and Replay now read the SAME table through the SAME conversion. That was
// not true before: Live was fed by the in-process event bus and Replay by
// `EventOutbox`, which is why a `player.updated` row could exist in Postgres,
// show in Replay, and never appear Live. One source removes the whole class of
// disagreement between the two modes.
//
//   Replay  a bounded historical window,  ordered by (createdAt, id)
//   Live    everything after a cursor,    ordered by (createdAt, id)
//
// The rows go through `framesFromRows` in `outbox-tail.service.ts`, so there is
// one row→frame path. A second projection would be a second place for a payload
// to escape from, and a second chance for the two modes to describe the same
// event differently.
//
// WHY THIS IS NOT AN ANALYTICS ENGINE
//
// One query, one bounded window, one page, ordered by time, capped. No
// aggregation, no rollups, no time bucketing, no retention policy of its own.
// The brief asks for the client to be architected so replay can arrive later;
// this is the smallest server side that makes that true, and it deliberately
// stops there.
//
// LEGACY ROWS
//
// The outbox also holds pre-envelope rows written by `big-data/publisher` under
// `OutboxKind` names — `MATCH_EVENT`, `SENSOR_PACKET`. Those are real platform
// activity and they are shown, mapped through the taxonomy's own
// `canonicalNameForLegacyKind` so one occurrence keeps one name. What is NOT
// done is reading their payloads: a legacy row has no envelope, so its frame is
// built from the row's own columns and its payload is never opened.

import { prisma } from '../../config/database';
import { framesFromRows } from './outbox-tail.service';
import type { PulseFrame } from './pulse.service';

/** The windows the interface offers. Minutes. */
export const REPLAY_WINDOWS = Object.freeze([1, 5, 15]);

/** Never return more than this, whatever is asked for. */
export const REPLAY_MAX = 500;

export interface ReplayQuery {
  /** How far back, in minutes. Clamped to a day. */
  minutes?: number;
  /** Explicit range, when the interface offers "custom". Overrides `minutes`. */
  from?: Date | null;
  to?: Date | null;
  limit?: number;
}

export interface ReplayResult {
  frames: PulseFrame[];
  from: string;
  to: string;
  /** True when the cap was hit and older frames in the window were not returned. */
  truncated: boolean;
  /** Rows in the window that predate the envelope and were mapped by kind. */
  legacyCount: number;
}

const DAY_MINUTES = 24 * 60;

/**
 * The frames from one window of the real record, oldest first.
 *
 * Ordered ascending on return so the client can animate them in the order they
 * happened, but SELECTED descending and reversed — otherwise a window with more
 * rows than the cap would return the oldest and silently omit what just
 * happened, which is the opposite of what somebody watching a replay wants.
 */
export async function replayWindow(query: ReplayQuery = {}): Promise<ReplayResult> {
  const to = query.to instanceof Date ? query.to : new Date();
  const minutes = Math.min(Math.max(Number(query.minutes ?? 5), 1), DAY_MINUTES);
  const from = query.from instanceof Date ? query.from : new Date(to.getTime() - minutes * 60_000);
  const limit = Math.min(Math.max(Number(query.limit ?? REPLAY_MAX), 1), REPLAY_MAX);

  // Selected DESCENDING and reversed, so a window holding more rows than the
  // cap returns the most RECENT of them. Ascending would hand back the oldest
  // and silently omit what just happened, which is the opposite of what
  // somebody watching a replay wants.
  //
  // The secondary sort on `id` is the same tie-break the live cursor uses, so a
  // millisecond holding two events orders them identically in both modes.
  const rows = await prisma.eventOutbox.findMany({
    where: { createdAt: { gte: from, lte: to } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true, clubId: true, kind: true, payload: true, source: true,
      createdAt: true, idempotencyKey: true, processedAt: true, failedAt: true,
    },
  });

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  page.reverse();

  // The SAME conversion the tail uses — one row→frame path, so a payload has
  // one place to escape from rather than two, and a legacy row is read the
  // same way in both modes.
  const frames: PulseFrame[] = await framesFromRows(page as unknown as Array<Record<string, unknown>>);
  const legacyCount = page.filter((r) => {
    const p = r.payload as Record<string, unknown> | null;
    return !(p && typeof p === 'object' && '__familista_event' in p);
  }).length;

  return { frames, from: from.toISOString(), to: to.toISOString(), truncated, legacyCount };
}

/**
 * Outbox processing counts for the window — or an honest absence.
 *
 * `processedAt` and `failedAt` exist as columns and nothing in Familista sets
 * them, so a count of "0 failed" would be a statement about the column rather
 * than about the platform. This returns null for any counter whose column is
 * uniformly unset across the window, and the interface says "Not instrumented
 * yet" for those.
 */
export async function replayCounts(query: ReplayQuery = {}): Promise<{
  total: number; processed: number | null; failed: number | null; pending: number | null;
}> {
  const to = query.to instanceof Date ? query.to : new Date();
  const minutes = Math.min(Math.max(Number(query.minutes ?? 5), 1), DAY_MINUTES);
  const from = query.from instanceof Date ? query.from : new Date(to.getTime() - minutes * 60_000);
  const where = { createdAt: { gte: from, lte: to } };

  const [total, processed, failed] = await Promise.all([
    prisma.eventOutbox.count({ where }),
    prisma.eventOutbox.count({ where: { ...where, processedAt: { not: null } } }),
    prisma.eventOutbox.count({ where: { ...where, failedAt: { not: null } } }),
  ]);

  // Nothing marks these, so all-zero means "no consumer exists" rather than
  // "everything is fine". Reported as unknown until one of them is ever set.
  const instrumented = processed > 0 || failed > 0;
  return {
    total,
    processed: instrumented ? processed : null,
    failed: instrumented ? failed : null,
    pending: instrumented ? Math.max(total - processed - failed, 0) : null,
  };
}
