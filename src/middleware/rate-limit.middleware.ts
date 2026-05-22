// Familista — Rate limit middleware (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// Two-tier token bucket:
//   - Per-IP   : protects against unauthenticated abuse / scrapers
//   - Per-user : protects against compromised tokens fanning out
//
// In-memory implementation (one process). Sub-millisecond per-request.
// For multi-process or multi-region we drop in a Redis adapter — interface
// is the same as Phase F's big-data adapters; not wired here to keep
// Render-safe (single-process by default).
//
// SUPER_ADMIN bypasses limits. Auth routes get a much tighter bucket.

import type { Request, Response, NextFunction } from 'express';
import { logSecurityEvent } from '../security/security-event.service';

interface Bucket { tokens: number; lastRefillMs: number; }

const ipBuckets:   Map<string, Bucket> = new Map();
const userBuckets: Map<string, Bucket> = new Map();
const authBuckets: Map<string, Bucket> = new Map();

const IP_CAPACITY      = parseInt(process.env.RATE_IP_CAPACITY     ?? '300', 10);
const IP_REFILL_MS     = parseInt(process.env.RATE_IP_REFILL_MS    ?? '60000', 10);
const USER_CAPACITY    = parseInt(process.env.RATE_USER_CAPACITY   ?? '1200', 10);
const USER_REFILL_MS   = parseInt(process.env.RATE_USER_REFILL_MS  ?? '60000', 10);
const AUTH_CAPACITY    = parseInt(process.env.RATE_AUTH_CAPACITY   ?? '20', 10);
const AUTH_REFILL_MS   = parseInt(process.env.RATE_AUTH_REFILL_MS  ?? '60000', 10);
const MAX_BUCKETS      = 50_000;

function refill(bucket: Bucket, capacity: number, refillMs: number, now: number): void {
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  const tokensToAdd = (elapsed / refillMs) * capacity;
  bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
  bucket.lastRefillMs = now;
}

function take(map: Map<string, Bucket>, key: string, capacity: number, refillMs: number): boolean {
  const now = Date.now();
  let b = map.get(key);
  if (!b) {
    b = { tokens: capacity, lastRefillMs: now };
    if (map.size >= MAX_BUCKETS) {
      // Evict oldest 5%
      const drop = Math.floor(MAX_BUCKETS * 0.05);
      let i = 0;
      for (const k of map.keys()) { map.delete(k); if (++i >= drop) break; }
    }
    map.set(key, b);
  }
  refill(b, capacity, refillMs, now);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function ipOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.ip || 'unknown';
}

/** Generic per-IP + per-user limiter. */
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = ipOf(req);
  const userId = (req as Request & { user?: { id?: string; role?: string } }).user?.id;
  const role   = (req as Request & { user?: { id?: string; role?: string } }).user?.role;

  if (role === 'SUPER_ADMIN') return next();

  if (!take(ipBuckets, ip, IP_CAPACITY, IP_REFILL_MS)) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, payload: { bucket: 'ip' } });
    res.status(429).json({ success: false, message: 'Too many requests (ip)', retryAfterMs: IP_REFILL_MS });
    return;
  }
  if (userId && !take(userBuckets, userId, USER_CAPACITY, USER_REFILL_MS)) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'WARN', ipAddress: ip, actorId: userId, payload: { bucket: 'user' } });
    res.status(429).json({ success: false, message: 'Too many requests (user)', retryAfterMs: USER_REFILL_MS });
    return;
  }
  next();
}

/** Tight bucket for /auth/* — gives credential-stuffing very little room. */
export function rateLimitAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = ipOf(req);
  if (!take(authBuckets, ip, AUTH_CAPACITY, AUTH_REFILL_MS)) {
    logSecurityEvent({ kind: 'RATE_LIMITED', severity: 'CRITICAL', ipAddress: ip, payload: { bucket: 'auth' } });
    res.status(429).json({ success: false, message: 'Too many auth attempts. Try again later.', retryAfterMs: AUTH_REFILL_MS });
    return;
  }
  next();
}

/** Diagnostic for ops. */
export function rateLimitStats() {
  return {
    ipBuckets:   ipBuckets.size,
    userBuckets: userBuckets.size,
    authBuckets: authBuckets.size,
    capacity:    { ip: IP_CAPACITY, user: USER_CAPACITY, auth: AUTH_CAPACITY },
    refillMs:    { ip: IP_REFILL_MS, user: USER_REFILL_MS, auth: AUTH_REFILL_MS },
  };
}
