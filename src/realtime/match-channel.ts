// Familista — Realtime match channel (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// In-process pub/sub for match events. The "topic" is the matchId.
// Subscribers register a callback; publishers fan out events to every
// subscriber on that match.
//
// This is intentionally a thin abstraction. In Phase D we swap the impl
// behind the same publish()/subscribe() facade for a Redis or NATS adapter
// — no other code in the codebase needs to change.

export type MatchChannelEvent =
  | { kind: 'TIMELINE_ADDED';      matchId: string; clubId: string; payload: unknown }
  | { kind: 'TIMELINE_EDITED';     matchId: string; clubId: string; payload: unknown }
  | { kind: 'TIMELINE_DELETED';    matchId: string; clubId: string; payload: unknown }
  | { kind: 'STATUS_CHANGED';      matchId: string; clubId: string; payload: unknown }
  | { kind: 'LINEUP_SET';          matchId: string; clubId: string; payload: unknown }
  | { kind: 'SNAPSHOT_TAKEN';      matchId: string; clubId: string; payload: unknown }
  | { kind: 'SCORE_CHANGED';       matchId: string; clubId: string; payload: unknown }
  | { kind: 'AI_INSIGHT';          matchId: string; clubId: string; payload: unknown }
  // Phase E — realtime tactical twin + AI ops
  | { kind: 'RULES_ALERT';         matchId: string; clubId: string; payload: unknown }
  | { kind: 'AI_RECOMMENDATION';   matchId: string; clubId: string; payload: unknown }
  | { kind: 'AI_REPORT';           matchId: string; clubId: string; payload: unknown }
  | { kind: 'LIVE_STATE_UPDATE';   matchId: string; clubId: string; payload: unknown }
  | { kind: 'DEVICE_STATUS';       matchId: string; clubId: string; payload: unknown }
  | { kind: 'BIG_DATA_PUBLISH';    matchId: string; clubId: string; payload: unknown };

type Subscriber = (event: MatchChannelEvent) => void;

// matchId -> set of subscribers
const subscribers: Map<string, Set<Subscriber>> = new Map();

export function subscribe(matchId: string, fn: Subscriber): () => void {
  let set = subscribers.get(matchId);
  if (!set) {
    set = new Set();
    subscribers.set(matchId, set);
  }
  set.add(fn);
  return () => {
    const cur = subscribers.get(matchId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) subscribers.delete(matchId);
  };
}

export function publish(event: MatchChannelEvent): void {
  const set = subscribers.get(event.matchId);
  if (!set || set.size === 0) return;
  // Fan out — never let a single subscriber's exception poison the rest.
  for (const fn of set) {
    try { fn(event); } catch (_err) { /* swallow */ }
  }
}

export function subscriberCount(matchId?: string): number {
  if (matchId) return subscribers.get(matchId)?.size ?? 0;
  let n = 0;
  for (const s of subscribers.values()) n += s.size;
  return n;
}

// Inspect (used by realtime metrics / health endpoint)
export function snapshot() {
  const out: Record<string, number> = {};
  for (const [k, v] of subscribers.entries()) out[k] = v.size;
  return out;
}
