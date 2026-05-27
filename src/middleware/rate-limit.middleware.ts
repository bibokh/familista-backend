// Familista — Rate limit middleware (Phase I + tenant-bucket extension)
// ─────────────────────────────────────────────────────────────────────────
// Three-tier token bucket:
//   - Per-IP     : protects against unauthenticated abuse / scrapers
//   - Per-user   : protects against compromised tokens fanning out
//   - Per-tenant : protects every OTHER club from a noisy-neighbour club —
//                  a single misbehaving integration on one tenant can no
//                  longer eat the global per-IP / per-user budget for
//                  unrelated tenants.
//
// Store selection (evaluated once at startup):
//   REDIS_URL set   → RedisRateLimitStore   (multi-process / multi-region)
//   otherwise       → MemoryRateLimitStore   (single-process, zero deps)
//
// SUPER_ADMIN bypasses limits. Auth routes get a much tighter bucket.

import type { Request, Response, NextFunction } from 'express';
import { logSecurityEvent } from '../security/security-event.service';
import type { RateLimitStore } from './rate-limit-store';
import { memoryStore } from './rate-limit-memory.store';

// ─── Store selection ──────────────────────────────────────────────────────────

function resolveStore(): RateLimitStore {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      // Dynamic require so the Redis client is only loaded when REDIS_URL is set.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RedisRateLimitStore } = require('./rate-limit-redis.store') as
        typeof import('./rate-limit-redis.store');
      const store = new RedisRateLimitStore(redisUrl);
      console.log('[RateLimit] Using Redis store:', redisUrl.replace(/\/\/.*@/, '//***@'));
      return store;
    } catch (err) {
      console.error('[RateLimit] Failed to init Redis store, falling back to memory:', (err as Error).message);
    }
  }
  console.log('[RateLimit] Using in-memory store');
  return memoryStore;
}

const store: RateLimitStore = resolveStore();

// ─── Bucket capacities (env-configurable) ────────────────────────────────────

const IP_CAPACITY      = parseInt(process.env.RATE_IP_CAPACITY       ?? '300',  10);
const IP_REFILL_MS     = parseInt(process.env.RATE_IP_REFILL_MS      ?? '60000',10);
const USER_CAPACITY    = parseInt(process.env.RATE_USER_CAPACITY     ?? '1200', 10);
const USER_REFILL_MS   = parseInt(process.env.RATE_USER_REFILL_MS    ?? '60000',10);
const TENANT_CAPACITY  = parseInt(process.env.RATE_TENANT_CAPACITY   ?? '6000', 10);
const TENANT_REFILL_MS = parseInt(process.env.RATE_TENANT_REFILL_MS  ?? '60000',10);
const AUTH_CAPACITY    = parseInt(process.env.RATE_AUTH_CAPACITY     ?? '20',   10);
const AUTH_REFILL_MS   = parseInt(process.env.RATE_AUTH_REFILL_MS    ?? '60000',10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ipOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.ip || 'unknown';
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/** Generic per-IP + per-user + per-tenant limiter. */
export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = ipOf(req);
  const user = (req as Request & { user?: { id?: string; role?: string; clubId?: string } }).user;
  const userId = user?.id;
  const role   = user?.role;
  const clubId = user?.clubId ?? (req as Request & { clubId?: string }).clubId;

  if (role === 'SUPER_ADMIN') return next();

  if (!await Promise.resolve(store.take(`ip:${ip}`, IP_CAPACITY, IP_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, payload: { bucket: 'ip' } });
    res.status(429).json({ success: false, message: 'Too many requests (ip)', retryAfterMs: IP_REFILL_MS });
    return;
  }
  if (userId && !await Promise.resolve(store.take(`user:${userId}`, USER_CAPACITY, USER_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, actorId: userId, payload: { bucket: 'user' } });
    res.status(429).json({ success: false, message: 'Too many requests (user)', retryAfterMs: USER_REFILL_MS });
    return;
  }
  // Tenant bucket — protects other tenants from one noisy club.
  // Only enforced once the request has been authenticated (clubId present).
  if (clubId && !await Promise.resolve(store.take(`tenant:${clubId}`, TENANT_CAPACITY, TENANT_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, actorId: userId, clubId, payload: { bucket: 'tenant' } });
    res.status(429).json({ success: false, message: 'Too many requests for this club', retryAfterMs: TENANT_REFILL_MS });
    return;
  }
  next();
}

/** Tight bucket for /auth/* — gives credential-stuffing very little room. */
export async function rateLimitAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = ipOf(req);
  if (!await Promise.resolve(store.take(`auth:${ip}`, AUTH_CAPACITY, AUTH_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'CRITICAL', ipAddress: ip, payload: { bucket: 'auth' } });
    res.status(429).json({ success: false, message: 'Too many auth attempts. Try again later.', retryAfterMs: AUTH_REFILL_MS });
    return;
  }
  next();
}

/** Diagnostic for ops endpoints. */
export function rateLimitStats() {
  const isRedis = store !== memoryStore;
  return {
    store:     isRedis ? 'redis' : 'memory',
    buckets:   isRedis ? 'n/a' : (store as typeof memoryStore).size,
    capacity:  { ip: IP_CAPACITY,    user: USER_CAPACITY,    tenant: TENANT_CAPACITY,    auth: AUTH_CAPACITY    },
    refillMs:  { ip: IP_REFILL_MS,   user: USER_REFILL_MS,   tenant: TENANT_REFILL_MS,   auth: AUTH_REFILL_MS   },
  };
}
