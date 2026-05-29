/**
 * Familista — Redis-backed rate-limit store.
 *
 * Uses a token-bucket algorithm implemented as a Lua script executed atomically
 * in Redis. Single round-trip; no race conditions across processes or regions.
 *
 * Activated by setting REDIS_URL (and optionally RATE_STORE=redis) in env.
 * Falls back to the in-memory store when Redis is unavailable.
 */
import Redis from 'ioredis';
import type { RateLimitStore } from './rate-limit-store';

// ── Lua token-bucket script ────────────────────────────────────────────────────
// KEYS[1]  = bucket key
// ARGV[1]  = capacity  (maximum tokens)
// ARGV[2]  = refillMs  (ms for a full refill from empty)
// ARGV[3]  = now       (current time in ms)
// Returns 1 (allowed) or 0 (blocked)
const TOKEN_BUCKET_LUA = `
local key     = KEYS[1]
local cap     = tonumber(ARGV[1])
local refillMs= tonumber(ARGV[2])
local now     = tonumber(ARGV[3])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or cap
local ts     = tonumber(data[2]) or now

local elapsed = now - ts
tokens = math.min(cap, tokens + (elapsed / refillMs) * cap)

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

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      // Fail fast on startup — don't block the process
      lazyConnect:        false,
      connectTimeout:     4000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    this.client.on('error', (err: Error) => {
      // Log but don't crash — middleware falls back to memory store on Redis errors
      console.error('[RateLimitRedis] Redis error:', err.message);
    });
  }

  async take(key: string, capacity: number, refillMs: number): Promise<boolean> {
    try {
      const result = await this.client.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        capacity,
        refillMs,
        Date.now()
      ) as number;
      return result === 1;
    } catch (err) {
      // Redis unavailable — fail open (allow the request) to preserve availability
      console.error('[RateLimitRedis] eval error, failing open:', (err as Error).message);
      return true;
    }
  }

  /** Cleanly close the Redis connection (called on graceful shutdown). */
  async quit(): Promise<void> {
    await this.client.quit();
  }
}
