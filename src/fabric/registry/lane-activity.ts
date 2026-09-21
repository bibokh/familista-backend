// What this instance has seen each source produce, recently
// ─────────────────────────────────────────────────────────────────────────────
// Lifted out of `fabric.routes.ts` when Source Core needed the same answer.
// Two callers computing "recent activity per lane" from the same buffer would
// be two opinions about one fact, and the day they disagreed would be the day
// somebody was debugging a missing lane.
//
// The scope is deliberately narrow and the field names say so: this is what
// THIS INSTANCE has seen in its bounded in-process buffer, not what the
// platform has ever recorded. For that, the question belongs to the Data Vault
// and the Historical Event Store behind it.

import { recentFrames } from '../pulse/pulse.service';

const MINUTE = 60_000;

export interface LaneActivity {
  /** Frames seen in the last sixty seconds. A measured zero is a zero. */
  count: number;
  /** The most recent arrival, or null when nothing has arrived. */
  lastAt: string | null;
}

/**
 * Per-lane counts from the live buffer, keyed by the source's DISPLAY NAME.
 *
 * Keyed by name because that is what `PulseFrame.source` carries — the same
 * join key the board filters a lane by. Callers holding a source id must map
 * it through the registry first.
 */
export function laneActivity(): Map<string, LaneActivity> {
  const now = Date.now();
  const byLane = new Map<string, LaneActivity>();

  for (const frame of recentFrames()) {
    const at = new Date(frame.recordedAt).getTime();
    if (!Number.isFinite(at)) continue;
    const entry = byLane.get(frame.source) ?? { count: 0, lastAt: null };
    if (now - at <= MINUTE) entry.count += 1;
    if (!entry.lastAt || at > new Date(entry.lastAt).getTime()) entry.lastAt = frame.recordedAt;
    byLane.set(frame.source, entry);
  }
  return byLane;
}
