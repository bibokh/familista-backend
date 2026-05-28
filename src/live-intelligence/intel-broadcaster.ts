// src/live-intelligence/intel-broadcaster.ts
// Phase 16 — Real-Time Match Event Engine
//
// Subscribes to the global MatchChannel, intercepts significant match events,
// re-computes the LiveIntelligenceBundle and publishes INTEL_UPDATE so every
// authenticated WS client receives the refreshed Intelligence tab payload
// without an extra HTTP round-trip.
//
// Design constraints:
//   • No DB writes — read-only analytics layer.
//   • One concurrent fetch per match (inflight guard).
//   • POSSESSION_TICK events throttled to 1 INTEL_UPDATE per 30 s per match.
//   • Timeline event de-duplication by payload.id (bounded Set, cap 500).
//   • subscribeAll() returns an unsubscribe fn → no leaked listeners on stop.

import { subscribeAll, publish, MatchChannelEvent } from '../realtime/match-channel';
import { getLiveIntelligence }                       from './live-intelligence.service';
import { logger }                                    from '../utils/logger';

// ── Constants ──────────────────────────────────────────────────────────────

/** Event kinds that cause an immediate INTEL_UPDATE after the DB write lands. */
const SIGNIFICANT_KINDS = new Set([
  'TIMELINE_ADDED',
  'SCORE_CHANGED',
  'STATUS_CHANGED',
  'LINEUP_SET',
  'SNAPSHOT_TAKEN',
]);

/** POSSESSION_TICK is noisy — cap updates to at most once per this interval. */
export const POSSESSION_THROTTLE_MS = 30_000;

// ── Per-match state ────────────────────────────────────────────────────────

interface MatchBroadcastState {
  /** epoch ms of last POSSESSION_TICK-triggered update */
  lastPossessionUpdate: number;
  /** processed timeline event IDs — prevents duplicate INTEL_UPDATE on retry */
  processedEventIds: Set<string>;
  /** true while getLiveIntelligence is running for this match */
  inflight: boolean;
}

// Exported for unit tests
export const matchState = new Map<string, MatchBroadcastState>();

export function getState(matchId: string): MatchBroadcastState {
  let s = matchState.get(matchId);
  if (!s) {
    s = { lastPossessionUpdate: 0, processedEventIds: new Set(), inflight: false };
    matchState.set(matchId, s);
  }
  return s;
}

// ── Filtering logic ────────────────────────────────────────────────────────

/** Returns true if this event should trigger an INTEL_UPDATE. */
export function shouldProcess(event: MatchChannelEvent, nowMs = Date.now()): boolean {
  if (SIGNIFICANT_KINDS.has(event.kind)) return true;
  if (event.kind === 'POSSESSION_TICK') {
    const s = getState(event.matchId);
    if (nowMs - s.lastPossessionUpdate < POSSESSION_THROTTLE_MS) return false;
    s.lastPossessionUpdate = nowMs;
    return true;
  }
  return false;
}

// ── Core handler ──────────────────────────────────────────────────────────

export async function handleMatchEvent(event: MatchChannelEvent): Promise<void> {
  if (!event.matchId || !event.clubId) return;

  // Skip INTEL_UPDATE itself to avoid feedback loop
  if (event.kind === 'INTEL_UPDATE') return;

  if (!shouldProcess(event)) return;

  // De-duplicate by timeline payload.id (prevents double-fire when match-intelligence
  // service emits both TIMELINE_ADDED and SCORE_CHANGED for the same goal)
  const payloadId = (event.payload as Record<string, unknown> | null)?.id;
  if (typeof payloadId === 'string') {
    const s = getState(event.matchId);
    if (s.processedEventIds.has(payloadId)) return;
    s.processedEventIds.add(payloadId);
    // Bound set to avoid unbounded memory growth over a 90-min match
    if (s.processedEventIds.size > 500) {
      const first = s.processedEventIds.values().next().value;
      if (first !== undefined) s.processedEventIds.delete(first);
    }
  }

  const s = getState(event.matchId);
  if (s.inflight) return; // skip — previous fetch still running for this match
  s.inflight = true;

  try {
    const bundle = await getLiveIntelligence(event.matchId, event.clubId);
    publish({ kind: 'INTEL_UPDATE', matchId: event.matchId, clubId: event.clubId, payload: bundle });
  } catch (err) {
    // Non-fatal — next event will retry
    logger.warn('[intel-broadcaster] compute failed', {
      matchId: event.matchId,
      kind:    event.kind,
      err:     (err as Error).message,
    });
  } finally {
    s.inflight = false;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

let _unsubscribeAll: (() => void) | null = null;

export function startIntelBroadcaster(): void {
  if (_unsubscribeAll) return; // idempotent
  _unsubscribeAll = subscribeAll((event) => {
    handleMatchEvent(event).catch(() => {});
  });
  logger.info('[intel-broadcaster] started');
}

export function stopIntelBroadcaster(): void {
  if (_unsubscribeAll) {
    _unsubscribeAll();
    _unsubscribeAll = null;
    matchState.clear();
    logger.info('[intel-broadcaster] stopped');
  }
}
