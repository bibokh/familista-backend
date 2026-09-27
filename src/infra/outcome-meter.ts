// Outcome counters for the platform's own dependencies
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//
// One small, bounded counter per channel: how many real operations succeeded
// and how many failed, per minute, over the last few minutes, plus since-start
// totals and the time of the last success and the last failure. A channel is
// fed from the call site that actually performs the operation — the durable
// outbox append, an Anthropic call, an audit-chain append, a metric write — at
// the moment it succeeds or fails. Nothing here probes, samples or estimates.
//
// WHY A WINDOW
//
// Infrastructure City asks "is this failing NOW?". A since-start total cannot
// answer that — one bad minute at boot would colour a building until the next
// restart — so a state is judged from the window and the totals are reported
// beside it.
//
// WHAT IT KEEPS
//
// Counts and two timestamps per channel. No payload, no identifier, no message.
// Process-scoped, like every counter the health layer reads.

export const OUTCOME_WINDOW_MINUTES = 15;

interface Bucket { minute: number; ok: number; failed: number }
interface Channel {
  buckets: Bucket[];
  okSinceStart: number;
  failedSinceStart: number;
  lastOkAt: number | null;
  lastFailureAt: number | null;
  /** Consecutive successes since the last failure — the evidence of recovery. */
  okStreak: number;
}

const channels = new Map<string, Channel>();
const minuteOf = (ms: number): number => Math.floor(ms / 60_000);

function channel(name: string): Channel {
  let c = channels.get(name);
  if (!c) {
    c = { buckets: [], okSinceStart: 0, failedSinceStart: 0, lastOkAt: null, lastFailureAt: null, okStreak: 0 };
    channels.set(name, c);
  }
  return c;
}

function prune(c: Channel, nowMinute: number): void {
  while (c.buckets.length && c.buckets[0].minute <= nowMinute - OUTCOME_WINDOW_MINUTES) c.buckets.shift();
}

/** One real operation finished. Never throws: counting must not break the caller. */
export function recordOutcome(name: string, ok: boolean, now: number = Date.now()): void {
  try {
    const c = channel(name);
    const minute = minuteOf(now);
    prune(c, minute);
    let b = c.buckets[c.buckets.length - 1];
    if (!b || b.minute !== minute) { b = { minute, ok: 0, failed: 0 }; c.buckets.push(b); }
    if (ok) { b.ok += 1; c.okSinceStart += 1; c.lastOkAt = now; c.okStreak += 1; }
    else { b.failed += 1; c.failedSinceStart += 1; c.lastFailureAt = now; c.okStreak = 0; }
  } catch (_) { /* never let a counter fail an operation */ }
}

export interface OutcomeReading {
  windowMinutes: number;
  ok: number;
  failed: number;
  okSinceStart: number;
  failedSinceStart: number;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  okStreak: number;
}

export function outcomeReading(name: string, now: number = Date.now()): OutcomeReading {
  const c = channel(name);
  prune(c, minuteOf(now));
  let ok = 0;
  let failed = 0;
  for (const b of c.buckets) { ok += b.ok; failed += b.failed; }
  return {
    windowMinutes: OUTCOME_WINDOW_MINUTES,
    ok, failed,
    okSinceStart: c.okSinceStart,
    failedSinceStart: c.failedSinceStart,
    lastOkAt: c.lastOkAt === null ? null : new Date(c.lastOkAt).toISOString(),
    lastFailureAt: c.lastFailureAt === null ? null : new Date(c.lastFailureAt).toISOString(),
    okStreak: c.okStreak,
  };
}

/**
 * Wrap a promise so its outcome is counted, without changing what it resolves
 * or rejects with.
 */
export function countOutcome<T>(name: string, p: Promise<T>): Promise<T> {
  return p.then(
    (v) => { recordOutcome(name, true); return v; },
    (err) => { recordOutcome(name, false); throw err; },
  );
}

/** Clear every channel. Tests only. */
export function resetOutcomes(): void { channels.clear(); }
