/**
 * Familista — In-memory token-bucket rate-limit store.
 *
 * Implements `RateLimitStore` using a single `Map<string, Bucket>`.
 * All bucket types (ip, user, tenant, auth) share one Map; bucket-type
 * isolation is provided by the key prefix convention enforced in
 * `rate-limit.middleware.ts`.
 *
 * Properties:
 *   - Sub-millisecond per-request overhead (pure JS, no I/O)
 *   - Bounded memory: evicts the oldest 5 % of entries once the map
 *     exceeds MAX_BUCKETS (default 50 000)
 *   - NOT shared across Node processes or server instances; use
 *     `RedisRateLimitStore` (see rate-limit-store.ts) for distributed setups
 */

import type { RateLimitStore } from './rate-limit-store';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const MAX_BUCKETS = 50_000;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  take(key: string, capacity: number, refillMs: number): boolean {
    const now = Date.now();

    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: capacity, lastRefillMs: now };

      // Bounded-size eviction: drop oldest 5 % when full.
      if (this.buckets.size >= MAX_BUCKETS) {
        const drop = Math.floor(MAX_BUCKETS * 0.05);
        let i = 0;
        for (const k of this.buckets.keys()) {
          this.buckets.delete(k);
          if (++i >= drop) break;
        }
      }

      this.buckets.set(key, b);
    }

    // Token refill (leaky-bucket approximation)
    const elapsed = now - b.lastRefillMs;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + (elapsed / refillMs) * capacity);
      b.lastRefillMs = now;
    }

    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Diagnostic helper for ops endpoints. */
  get size(): number {
    return this.buckets.size;
  }
}

/** Module-level singleton — shared across all middleware instantiations in a process. */
export const memoryStore = new MemoryRateLimitStore();
