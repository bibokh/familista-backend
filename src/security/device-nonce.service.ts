// Familista — Device nonce replay protection (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// In-memory LRU keyed by (deviceSessionId|cameraId, nonce). One process,
// one cache. Process death loses recent nonces — but the TS skew gate
// (5 min) keeps the attack window tiny and the device just regenerates.
//
// Bounded memory:
//   - LRU cap = 50_000 entries (≈4 MB)
//   - TTL    = 1 hour (longer than the device JWT TTL of 4 h would still
//              be safe; 1 h matches the realistic HMAC re-issue cadence)
//
// `assertFreshAndRemember` returns true on first-seen, false on replay.
// Callers should log a DeviceSecurityEvent on false.

const MAX_ENTRIES = 50_000;
const TTL_MS      = 60 * 60_000;

interface Entry { ts: number; }

const cache: Map<string, Entry> = new Map();

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

/**
 * Returns true if the nonce is fresh (and remembers it for TTL). Returns
 * false if it was seen before within the TTL window.
 */
export function assertFreshAndRemember(scopeId: string, nonce: string): boolean {
  if (!scopeId || !nonce) return false;
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

/** Diagnostic helper. */
export function nonceCacheStats() {
  return { size: cache.size, capacity: MAX_ENTRIES, ttlMs: TTL_MS };
}
