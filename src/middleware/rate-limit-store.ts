/**
 * Familista — Rate-Limit Store interface.
 *
 * Defines the contract that any rate-limit backend must satisfy.
 * The in-process memory implementation is used on Render (single process).
 * Drop in `RedisRateLimitStore` for multi-process / multi-region deployments
 * by setting the `RATE_STORE` env var to `redis` and providing `REDIS_URL`.
 *
 * Redis store sketch (not wired — implement when needed):
 *
 *   import Redis from 'ioredis';
 *   export class RedisRateLimitStore implements RateLimitStore {
 *     constructor(private readonly client: Redis) {}
 *     async take(key: string, capacity: number, refillMs: number): Promise<boolean> {
 *       // Lua script for atomic token-bucket refill + decrement.
 *       // Single round-trip; no race conditions across processes.
 *       const lua = `
 *         local key = KEYS[1]
 *         local cap  = tonumber(ARGV[1])
 *         local ms   = tonumber(ARGV[2])
 *         local now  = tonumber(ARGV[3])
 *         local data = redis.call('HMGET', key, 'tokens', 'ts')
 *         local tokens = tonumber(data[1]) or cap
 *         local ts     = tonumber(data[2]) or now
 *         local elapsed = now - ts
 *         tokens = math.min(cap, tokens + (elapsed / ms) * cap)
 *         if tokens < 1 then
 *           redis.call('HSET', key, 'tokens', tokens, 'ts', now)
 *           redis.call('PEXPIRE', key, ms * 2)
 *           return 0
 *         end
 *         tokens = tokens - 1
 *         redis.call('HSET', key, 'tokens', tokens, 'ts', now)
 *         redis.call('PEXPIRE', key, ms * 2)
 *         return 1
 *       `;
 *       const result = await this.client.eval(lua, 1, key, capacity, refillMs, Date.now());
 *       return result === 1;
 *     }
 *   }
 */

export interface RateLimitStore {
  /**
   * Attempt to consume one token from the named bucket.
   *
   * @param key       Unique bucket key — must include bucket type prefix to
   *                  avoid collisions (e.g. `ip:127.0.0.1`, `user:<uuid>`,
   *                  `tenant:<clubId>`, `auth:127.0.0.1`).
   * @param capacity  Maximum number of tokens (full bucket size).
   * @param refillMs  Duration in milliseconds for a full refill from empty.
   * @returns         `true` if the token was consumed (request is allowed),
   *                  `false` if the bucket is empty (request should be blocked).
   *                  May return a Promise — middleware awaits if needed.
   */
  take(key: string, capacity: number, refillMs: number): boolean | Promise<boolean>;
}
