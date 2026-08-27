// Familista — Device nonce replay protection (Phase I)
// ─────────────────────────────────────────────────────────────────────────────
// A signed device request carries a nonce, and a nonce may be used once. This
// is what remembers which ones have been.
//
// ── Why this one had to move to Redis
//
// Every other piece of process-local state in this codebase degrades when it is
// fragmented across processes: a cache goes cold, a limit gets looser, a socket
// misses a refresh. This one does not degrade — it BREAKS. A replayed request
// that happens to land on a different process finds an empty cache, is judged
// fresh, and is accepted. The attacker does not need to do anything clever; the
// load balancer does it for them, and with four processes a captured request
// replays successfully three times out of four.
//
// So when Redis is configured the record is kept there, and the check is a
// single `SET key NX PX` — Redis's own atomic "create only if absent". Either
// this request created the key, in which case the nonce is new, or it did not,
// in which case the nonce has been seen. There is no read-then-write window for
// two concurrent replays to slip through.
//
// ── When Redis is unreachable, this FAILS CLOSED
//
// A store that cannot answer "have I seen this before" must not be allowed to
// answer "no". If Redis is configured and down, the nonce is rejected and the
// request is refused. That is deliberately the harsh direction: a device whose
// packet is refused retries and loses a reading, while a replay that is accepted
// is a signed request executing twice, and no later log can undo it.
//
// The one thing it must never do is fall back to the local map — that would be
// the fragmented cache above, reintroduced at precisely the moment the operator
// has been told the system is protected.
//
// ── When Redis is NOT configured
//
// There is exactly one process — `cluster.ts` refuses to fan out without Redis —
// so the in-memory LRU below is a complete and correct answer, and it stays.

import { getRedis, redisConfigured, rkey, whenReady } from '../infra/redis';
import { logger } from '../utils/logger';

const MAX_ENTRIES = 50_000;
const TTL_MS      = 60 * 60_000;
// How long a signed request will wait for a connecting socket before the
// shared store counts as unreachable. Long enough to cover a reconnect, short
// enough that a real outage does not hold the request open.
const READY_WAIT_MS = parseInt(process.env.NONCE_REDIS_READY_WAIT_MS ?? '2000', 10);

interface Entry { ts: number; }

const cache: Map<string, Entry> = new Map();

let redisFailures = 0;
let lastRedisFailureAt: number | null = null;

function key(scopeId: string, nonce: string): string {
  return scopeId + '|' + nonce;
}

function pruneIfNeeded(now: number): void {
  // Cheap pass: drop expired entries.
  if (cache.size < MAX_ENTRIES) return;
  let removed = 0;
  for (const [k, v] of cache) {
    if (now - v.ts > TTL_MS) {
      cache.delete(k); removed++;
      if (cache.size < MAX_ENTRIES * 0.85) break;
    }
  }
  // If still over capacity (no expired entries available), evict oldest
  // (Map preserves insertion order).
  if (cache.size >= MAX_ENTRIES) {
    const toDrop = cache.size - Math.floor(MAX_ENTRIES * 0.85);
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k); i++;
      if (i >= toDrop) break;
    }
  }
}

/** The single-process implementation. Correct when there is one process. */
function rememberLocally(scopeId: string, nonce: string): boolean {
  const now = Date.now();
  const k = key(scopeId, nonce);
  const existing = cache.get(k);
  if (existing && now - existing.ts <= TTL_MS) return false;
  // Re-insert to move to LRU tail (Map insertion order).
  if (existing) cache.delete(k);
  cache.set(k, { ts: now });
  pruneIfNeeded(now);
  return true;
}

/**
 * True if the nonce is fresh, and remembers it for the TTL. False if it was
 * seen before within the window — or if the shared store could not be reached,
 * because an unanswerable replay check is a failed replay check.
 *
 * Callers log a DeviceSecurityEvent and refuse the request on false.
 */
export async function assertFreshAndRemember(scopeId: string, nonce: string): Promise<boolean> {
  if (!scopeId || !nonce) return false;

  if (!redisConfigured()) return rememberLocally(scopeId, nonce);

  const client = getRedis('cmd');
  if (!client) {
    noteFailure('client unavailable');
    return false;
  }
  try {
    // "Still connecting" is not "down", and the difference matters here because
    // the consequence of getting it wrong is refusing a legitimate device.
    //
    // The socket opens once, at boot, and reopens briefly after a Redis restart.
    // A request arriving inside either window would otherwise be judged a replay
    // — a signed packet rejected while Redis is perfectly healthy a millisecond
    // later. So wait, briefly and boundedly, for the connection to settle.
    //
    // This does not soften the fail-closed rule: if the wait expires the nonce
    // is still refused. It costs nothing in steady state, where `whenReady`
    // returns already-resolved.
    await whenReady(client, READY_WAIT_MS);
    // SET ... NX succeeds only if the key did not exist. That IS the check.
    const created = await client.set(rkey('nonce', key(scopeId, nonce)), '1', 'PX', TTL_MS, 'NX');
    return created === 'OK';
  } catch (err) {
    noteFailure((err as Error).message);
    return false;
  }
}

function noteFailure(why: string): void {
  redisFailures++;
  const now = Date.now();
  // Every occurrence matters, but a flood of them must not be the outage. One
  // line every ten seconds, with the running count.
  if (lastRedisFailureAt && now - lastRedisFailureAt < 10_000) { lastRedisFailureAt = now; return; }
  lastRedisFailureAt = now;
  logger.error(
    '[device-nonce] shared replay store unreachable — REFUSING signed device requests (fail-closed)',
    { why, failures: redisFailures },
  );
}

/** Diagnostic helper. */
export function nonceCacheStats() {
  return {
    mode: redisConfigured() ? 'redis' : 'memory',
    shared: redisConfigured(),
    failClosed: true,
    size: cache.size,
    capacity: MAX_ENTRIES,
    ttlMs: TTL_MS,
    redisFailures,
    lastRedisFailureAt: lastRedisFailureAt ? new Date(lastRedisFailureAt).toISOString() : null,
  };
}
