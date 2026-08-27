/**
 * Familista — Redis-backed rate-limit store.
 *
 * A token bucket implemented as a Lua script, so the read-refill-decrement is
 * one atomic round trip and two processes cannot both see the last token.
 *
 * ── Why this has to be shared
 *
 * A bucket that lives inside a process is a bucket per process. Put four
 * processes behind a load balancer and a client's requests are spread across
 * all four, so the configured 300-per-minute ceiling becomes 1200 — and nothing
 * anywhere says so. The limiter still looks like it is working. That is the
 * failure this file exists to prevent.
 *
 * ── What it does when Redis is unreachable
 *
 * It does NOT fail open. It used to: the catch returned `true`, which allowed
 * the request, which means a Redis outage silently removed rate limiting from
 * the entire platform at exactly the moment infrastructure was already unwell.
 *
 * It now falls through to the in-process store. The ceiling is still enforced —
 * it just degrades to per-process for the duration, so N processes allow at most
 * N × capacity rather than infinity. The degradation is bounded, it is logged at
 * error level on the transition, and `redisStatus()` reports it to the health
 * endpoint. Protection is weakened by a known factor and never disabled, and
 * nobody has to guess that it happened.
 */
import type Redis from 'ioredis';
import type { RateLimitStore } from './rate-limit-store';
import { memoryStore } from './rate-limit-memory.store';
import { getRedis, rkey, whenReady } from '../infra/redis';
import { logger } from '../utils/logger';

// A socket that is still opening is not a socket that is down. Without this,
// every boot logs a spurious "shared store unreachable" and counts its first
// requests locally. `whenReady` resolves immediately once connected, so this
// costs nothing after the first request.
const READY_WAIT_MS = parseInt(process.env.RATE_REDIS_READY_WAIT_MS ?? '1000', 10);

// KEYS[1] bucket · ARGV[1] capacity · ARGV[2] refillMs · ARGV[3] now
// Returns 1 when a token was consumed, 0 when the bucket was empty.
const TAKE_LUA = `
local key      = KEYS[1]
local cap      = tonumber(ARGV[1])
local refillMs = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or cap
local ts     = tonumber(data[2]) or now

local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(cap, tokens + (elapsed / refillMs) * cap)
end

if tokens < 1 then
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, refillMs * 2)
  return 0
end

tokens = tokens - 1
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, refillMs * 2)
return 1
`;

// The same refill, spending nothing. The credential bucket charges failed
// sign-ins only, so it must ask "is this address still allowed to try" before
// the attempt and charge afterwards once the outcome is known.
//
// This is not an optional nicety. `rateLimitAuth` treats a store without
// `peek` as "always has room", so a Redis store missing it would leave the
// per-address failed-attempt ceiling unenforced while appearing to be on.
const PEEK_LUA = `
local key      = KEYS[1]
local cap      = tonumber(ARGV[1])
local refillMs = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
if tokens == nil then return 1 end
local ts     = tonumber(data[2]) or now

local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(cap, tokens + (elapsed / refillMs) * cap)
end

if tokens < 1 then return 0 end
return 1
`;

/** Complain once per outage, not once per request. */
let degradedSince = 0;
let suppressed = 0;
function reportDegraded(op: string, err: Error): void {
  suppressed++;
  const now = Date.now();
  if (now - degradedSince < 30_000) return;
  degradedSince = now;
  logger.error(
    '[RateLimitRedis] shared store unreachable — rate limiting is now PER-PROCESS, not global',
    { op, err: err.message, suppressedSince: suppressed },
  );
  suppressed = 0;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: Redis | null;

  /**
   * `redisUrl` is accepted for backwards compatibility with the previous
   * constructor signature, but the connection itself comes from the shared
   * manager so that health, logging and shutdown are in one place.
   */
  constructor(_redisUrl?: string) {
    this.client = getRedis('cmd');
  }

  async take(key: string, capacity: number, refillMs: number): Promise<boolean> {
    if (!this.client) return memoryStore.take(key, capacity, refillMs);
    try {
      await whenReady(this.client, READY_WAIT_MS);
      const result = await this.client.eval(
        TAKE_LUA, 1, rkey('rl', key), capacity, refillMs, Date.now(),
      ) as number;
      return result === 1;
    } catch (err) {
      reportDegraded('take', err as Error);
      // Enforce locally rather than allow unconditionally.
      return memoryStore.take(key, capacity, refillMs);
    }
  }

  async peek(key: string, capacity: number, refillMs: number): Promise<boolean> {
    if (!this.client) return memoryStore.peek(key, capacity, refillMs);
    try {
      await whenReady(this.client, READY_WAIT_MS);
      const result = await this.client.eval(
        PEEK_LUA, 1, rkey('rl', key), capacity, refillMs, Date.now(),
      ) as number;
      return result === 1;
    } catch (err) {
      reportDegraded('peek', err as Error);
      return memoryStore.peek(key, capacity, refillMs);
    }
  }

  /** Has this store had to fall back recently? Surfaced on the ops endpoint. */
  get degraded(): boolean {
    return degradedSince > 0 && Date.now() - degradedSince < 60_000;
  }

  /** Cleanly close. The shared manager owns the socket, so this is a no-op
   *  kept for the previous call signature. */
  async quit(): Promise<void> {
    /* closeRedis() in infra/redis.ts closes every role at shutdown */
  }
}
