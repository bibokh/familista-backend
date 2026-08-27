// Familista — shared store for the edge abuse guard
// ─────────────────────────────────────────────────────────────────────────────
// `express-rate-limit` defaults to its own `MemoryStore`, which is per-process.
// The edge guard is the thing that stops a flood before it reaches the router,
// and a per-process copy of it means N processes let N × EDGE_MAX through —
// while the configuration still reads 1200.
//
// This is the same fixed-window counter express-rate-limit implements, moved
// into Redis. INCR is atomic, so the window's count is a single number shared by
// every process, and the expiry is set only on the first increment (`NX`) so the
// window starts when the first request of it arrives rather than sliding forward
// on every hit.
//
// ── When Redis is unreachable
//
// It falls through to a process-local `MemoryStore`, exactly as the three-tier
// limiter falls through to its own memory store: the ceiling stays enforced and
// becomes per-process for the duration. It does not stop counting, and it does
// not start allowing everything.
//
// No new dependency: `rate-limit-redis` would do this, and this is the whole of
// what it does for a fixed window.

import { MemoryStore, type Store, type ClientRateLimitInfo, type Options } from 'express-rate-limit';
import { getRedis, rkey, whenReady } from '../infra/redis';
import { logger } from '../utils/logger';

let degradedAt = 0;
function reportDegraded(err: Error): void {
  const now = Date.now();
  if (now - degradedAt < 30_000) return;
  degradedAt = now;
  logger.error('[edge-limit] shared store unreachable — edge guard is now PER-PROCESS', {
    err: err.message,
  });
}

export class RedisEdgeStore implements Store {
  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();
  /** Keys are namespaced by this store, so express-rate-limit must not also
   *  prefix them per-instance. */
  localKeys = false;

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  private k(key: string): string {
    return rkey('edge', key);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const client = getRedis('cmd');
    if (!client) return this.fallback.increment(key);
    try {
      // Still-connecting is not down; see the note in rate-limit-redis.store.ts.
      await whenReady(client, 1000);
      const k = this.k(key);
      // One round trip: count this hit, and start the window's clock if this is
      // the hit that opened it. `PEXPIRE ... NX` is why the window is fixed
      // rather than sliding — a later hit must not push the reset out.
      const pipeline = client.multi();
      pipeline.incr(k);
      pipeline.pexpire(k, this.windowMs, 'NX');
      pipeline.pttl(k);
      const res = await pipeline.exec();
      if (!res) throw new Error('pipeline returned nothing');

      const totalHits = Number(res[0]?.[1] ?? 0);
      let ttl = Number(res[2]?.[1] ?? -1);
      // -1 means the key exists with no expiry, which should not happen; give it
      // one rather than leaking a counter that never resets.
      if (ttl < 0) { ttl = this.windowMs; void client.pexpire(k, this.windowMs); }

      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch (err) {
      reportDegraded(err as Error);
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    const client = getRedis('cmd');
    if (!client) return this.fallback.decrement(key);
    try { await client.decr(this.k(key)); }
    catch (err) { reportDegraded(err as Error); await this.fallback.decrement(key); }
  }

  async resetKey(key: string): Promise<void> {
    const client = getRedis('cmd');
    if (!client) return this.fallback.resetKey(key);
    try { await client.del(this.k(key)); }
    catch (err) { reportDegraded(err as Error); await this.fallback.resetKey(key); }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const client = getRedis('cmd');
    if (!client) return this.fallback.get?.(key);
    try {
      const k = this.k(key);
      const [hits, ttl] = await Promise.all([client.get(k), client.pttl(k)]);
      if (hits === null) return undefined;
      return {
        totalHits: Number(hits),
        resetTime: ttl >= 0 ? new Date(Date.now() + ttl) : undefined,
      };
    } catch (err) {
      reportDegraded(err as Error);
      return this.fallback.get?.(key);
    }
  }
}
