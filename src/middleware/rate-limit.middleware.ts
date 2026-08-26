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
import jwt from 'jsonwebtoken';
import { config } from '../config';
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

/**
 * Who is asking, cheaply.
 *
 * This middleware runs BEFORE `authenticate`, so `req.user` is not populated
 * yet — which meant the per-user and per-tenant buckets were never reached for
 * an ordinary request and everything fell through to the shared per-IP one.
 * The token's own claims are enough to key a bucket, and verifying a signature
 * is a few microseconds of CPU with no database round trip. If the token is
 * absent, expired or forged the request is anonymous here and `authenticate`
 * rejects it a moment later on its own terms.
 */
interface Claims { sub?: string; role?: string; clubId?: string; currentClubId?: string }
function identify(req: Request): Claims | null {
  const known = (req as Request & { user?: Claims }).user;
  if (known?.sub || (known as { id?: string } | undefined)?.id) {
    const u = known as Claims & { id?: string };
    return { sub: u.sub ?? u.id, role: u.role, clubId: u.clubId };
  }
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.access_token;
  const header = req.headers.authorization;
  const token = cookieToken ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwt.secret) as Claims;
  } catch {
    return null;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * The key the edge guard counts against: the session's subject when the request
 * carries one, the address otherwise. Exported because app.ts mounts the edge
 * guard before the router and must key it the same way.
 */
export function edgeIdentity(req: Request): string {
  const who = identify(req);
  return who?.sub ? `u:${who.sub}` : `ip:${ipOf(req)}`;
}

/** A 429 that tells the caller when to come back, in the header HTTP defines. */
function deny(
  res: Response, message: string, refillMs: number,
  bucket: string,
): void {
  const retryAfterSec = Math.max(1, Math.ceil(refillMs / 1000));
  res.setHeader('Retry-After', String(retryAfterSec));
  res.setHeader('RateLimit-Policy', bucket);
  res.status(429).json({ success: false, message, retryAfterSec, retryAfterMs: refillMs });
}

/**
 * Generic limiter.
 *
 * The per-IP bucket applies to UNAUTHENTICATED traffic only. Once a request
 * carries a user, the user and tenant buckets are the meaningful scope, and
 * keeping a shared per-IP budget on top of them meant every user behind one
 * office NAT or one corporate proxy shared 300 requests a minute between them —
 * which is a scaling ceiling on the number of colleagues who may use the
 * product from the same building, not a security property. Anonymous traffic
 * has no better identity than its address, so there the IP bucket stays.
 */
export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = ipOf(req);
  const who = identify(req);
  const userId = who?.sub;
  const role   = who?.role;
  const clubId = who?.currentClubId ?? who?.clubId ?? (req as Request & { clubId?: string }).clubId;

  if (role === 'SUPER_ADMIN') return next();

  if (!userId) {
    if (!await Promise.resolve(store.take(`ip:${ip}`, IP_CAPACITY, IP_REFILL_MS))) {
      logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, payload: { bucket: 'ip' } });
      deny(res, 'Too many requests (ip)', IP_REFILL_MS, 'ip');
      return;
    }
    return next();
  }

  if (!await Promise.resolve(store.take(`user:${userId}`, USER_CAPACITY, USER_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, actorId: userId, payload: { bucket: 'user' } });
    deny(res, 'Too many requests (user)', USER_REFILL_MS, 'user');
    return;
  }
  // Tenant bucket — protects every OTHER club from one noisy club.
  if (clubId && !await Promise.resolve(store.take(`tenant:${clubId}`, TENANT_CAPACITY, TENANT_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, actorId: userId, clubId, payload: { bucket: 'tenant' } });
    deny(res, 'Too many requests for this club', TENANT_REFILL_MS, 'tenant');
    return;
  }
  next();
}

/**
 * The credential bucket — deliberately tight, and deliberately narrow.
 *
 * It used to cover all of /auth, which put /auth/refresh and /auth/me in the
 * same twenty-a-minute budget as /auth/login. Those two are ordinary session
 * traffic: a token refresh happens whenever an access token ages out, and
 * /auth/me runs on every cold entry. Spending a credential-stuffing budget on
 * them meant normal use competed with the defence that is meant to stop
 * attackers. Only the endpoints that actually take a credential are counted
 * here; the rest of /auth is normal application traffic and is limited as such.
 */
const CREDENTIAL_PATHS = new Set([
  '/login', '/register', '/forgot-password', '/reset-password',
]);
const ACCOUNT_CAPACITY = parseInt(process.env.RATE_ACCOUNT_CAPACITY ?? '10', 10);

export async function rateLimitAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // The generic limiter has already counted this request; only the credential
  // endpoints add the second, tighter bucket on top.
  const path = req.path.replace(/\/+$/, '') || '/';
  if (!CREDENTIAL_PATHS.has(path)) return next();

  const ip = ipOf(req);
  const email = String((req.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase().trim();

  // Per account, always. This is the bucket that actually describes the attack:
  // credential stuffing is many attempts against one account, or against many
  // accounts, and both are visible here regardless of how many addresses the
  // attacker sources from.
  if (email && !await Promise.resolve(store.take(`acct:${email}`, ACCOUNT_CAPACITY, AUTH_REFILL_MS))) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'CRITICAL', ipAddress: ip, payload: { bucket: 'account' } });
    deny(res, 'Too many attempts for this account. Try again later.', AUTH_REFILL_MS, 'account');
    return;
  }

  // Per address, but only for attempts that FAIL. A shared office address
  // legitimately produces a burst of sign-ins at nine in the morning, and
  // charging those to a credential-stuffing budget locked out the building.
  // A successful sign-in is not an attack, so it does not spend the budget;
  // a rejected one does, which is exactly the traffic the bucket exists for.
  const room = await Promise.resolve(store.peek
    ? store.peek(`auth:${ip}`, AUTH_CAPACITY, AUTH_REFILL_MS)
    : true);
  if (!room) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'CRITICAL', ipAddress: ip, payload: { bucket: 'auth' } });
    deny(res, 'Too many failed auth attempts. Try again later.', AUTH_REFILL_MS, 'auth');
    return;
  }
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      void Promise.resolve(store.take(`auth:${ip}`, AUTH_CAPACITY, AUTH_REFILL_MS));
    }
  });
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
    scope:     { ip: 'unauthenticated only', user: 'per authenticated user', tenant: 'per club', auth: 'credential endpoints only' },
  };
}
