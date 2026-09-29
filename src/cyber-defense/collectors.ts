// Cyber Defense — collectors
// ─────────────────────────────────────────────────────────────────────────────
// Step 4: turn five signals the platform already produces into `security.*`
// events on the Data Fabric (Security Event Schema v1). Additive only: no
// response, status, message, header, limit or decision changes because of
// anything in this file.
//
//   security.login.failed        a sign-in refused by `loginUser`
//   security.refresh.reused      a validly signed refresh token with no stored
//                                row — already rotated, or revoked
//   security.access.denied       a 403 raised anywhere in the request chain
//   security.origin.rejected     a browser origin refused by CORS
//   security.ratelimit.exceeded  a request refused by a rate-limit bucket
//   security.mfa.failed          a second-step code refused at sign-in
//                                (Step 7; tagged by the enforcement service)
//
// HOW EACH ONE IS SEEN
//
// The auth service only TAGS the error it already throws (`tagSecuritySignal`):
// same class, same message, same status. One error middleware,
// `securitySignalCollector`, mounted just ahead of the error reporter, reads the
// tag, a 403, or an `OriginNotAllowedError`, and adds the request context the
// service does not have. The rate limiter calls `recordRateLimitHit` from the
// one function that answers every 429.
//
// WHAT IS RECORDED ABOUT A PERSON
//
// The network prefix of the address (`ipPrefix`: IPv4 /24, IPv6 /48), taken
// from `req.ip` — the address the trusted proxy saw, not the client-supplied
// leftmost X-Forwarded-For entry. An authenticated user's id, from `req.user`,
// only for a refused request that user actually made. Never the e-mail that was
// tried, the password, the token, the user agent or the path's ids.
//
// A FLOOD CANNOT BECOME A WRITE FLOOD
//
// Every one of these can be triggered by a stranger at will. So per signal and
// per source (address prefix, or user) at most one event is written each
// minute, and the next one written carries `suppressedBefore`, the number held
// back in between. Per signal, at most `MAX_PER_TYPE_PER_MINUTE` are written
// across all sources; beyond that they are counted in `securityCollectorStats`
// and not written. Memory is bounded by `MAX_TRACKED_SOURCES`.
//
// NEVER FAILS A REQUEST
//
// Every entry point swallows its own errors, and publishing is detached.

import type { ErrorRequestHandler, Request } from 'express';
import { OriginNotAllowedError } from '../utils/errors';
import { publishSecurityEvent } from '../fabric/producers/security.producer';
import { ipPrefix, type SecurityEventPayloadV1 } from './security-event-schema';

export const WINDOW_MS = 60_000;
export const MAX_PER_TYPE_PER_MINUTE = 60;
export const MAX_TRACKED_SOURCES = 5_000;

// ── tagging, for code that knows WHAT happened but not the request ──────────

const SIGNAL = Symbol.for('familista.cyberDefense.signal');

export type SecuritySignal =
  | {
    type: 'security.login.failed';
    reason: 'UNKNOWN_ACCOUNT' | 'INACTIVE_ACCOUNT' | 'BAD_PASSWORD';
  }
  | {
    type: 'security.mfa.failed';
    /** The account whose password was right and whose second-step code was not. */
    userId: string;
  }
  | {
    type: 'security.refresh.reused';
    /** The subject of a token whose signature verified. Not a claimed identity. */
    userId: string;
  };

/**
 * Mark an error as a security signal and return it unchanged.
 *
 * The property is non-enumerable and keyed by a symbol, so it never reaches a
 * JSON body, a log line or an error reporter.
 */
export function tagSecuritySignal<E extends Error>(err: E, signal: SecuritySignal): E {
  try {
    Object.defineProperty(err, SIGNAL, { value: signal, enumerable: false });
  } catch { /* a frozen error stays untagged; the request is unaffected */ }
  return err;
}

function signalOf(err: unknown): SecuritySignal | undefined {
  return err && typeof err === 'object' ? (err as Record<symbol, SecuritySignal>)[SIGNAL] : undefined;
}

// ── the flood cap ───────────────────────────────────────────────────────────

interface SourceWindow { windowStart: number; suppressed: number }
const sources = new Map<string, SourceWindow>();
const perType = new Map<string, { windowStart: number; written: number }>();
const stats = { written: 0, suppressed: 0, overCap: 0, refused: 0 };

/**
 * Whether to write this occurrence, and how many were held back before it.
 * `null` means do not write.
 */
function admit(type: string, sourceKey: string, now: number): { suppressedBefore: number } | null {
  const t = perType.get(type);
  if (!t || now - t.windowStart >= WINDOW_MS) perType.set(type, { windowStart: now, written: 0 });
  const typeWindow = perType.get(type)!;

  const key = `${type}|${sourceKey}`;
  const w = sources.get(key);
  if (w && now - w.windowStart < WINDOW_MS) {
    w.suppressed += 1;
    stats.suppressed += 1;
    return null;
  }
  if (typeWindow.written >= MAX_PER_TYPE_PER_MINUTE) {
    stats.overCap += 1;
    if (w) w.suppressed += 1;
    return null;
  }
  if (!w && sources.size >= MAX_TRACKED_SOURCES) {
    for (const [k, v] of sources) if (now - v.windowStart >= WINDOW_MS) sources.delete(k);
    if (sources.size >= MAX_TRACKED_SOURCES) { stats.overCap += 1; return null; }
  }
  const suppressedBefore = w?.suppressed ?? 0;
  sources.set(key, { windowStart: now, suppressed: 0 });
  typeWindow.written += 1;
  return { suppressedBefore };
}

type Payload = Omit<SecurityEventPayloadV1, 'category'>;

/**
 * Publish one signal through the flood cap. Exported for the other Cyber
 * Defense evaluators (`lockout-shadow.ts`); not for general use.
 */
export function emit(
  type: string,
  req: Request,
  payload: Payload,
  opts: { actorUserId?: string | null; sourceKey?: string } = {},
): void {
  const now = Date.now();
  const sourceKey = opts.sourceKey ?? payload.source.ipPrefix ?? 'unknown';
  const admitted = admit(type, sourceKey, now);
  if (!admitted) return;
  const evidence = admitted.suppressedBefore > 0
    ? { ...payload.evidence, suppressedBefore: admitted.suppressedBefore }
    : payload.evidence;
  const ok = publishSecurityEvent(type, {
    actorUserId: opts.actorUserId ?? null,
    clubId: req.user?.clubId ?? null,
    correlationId: requestIdOf(req),
  }, { ...payload, evidence });
  if (ok) stats.written += 1; else stats.refused += 1;
}

// ── request context ─────────────────────────────────────────────────────────

const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

function requestIdOf(req: Request): string | null {
  const id = (req as Request & { requestId?: string }).requestId;
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(id) ? id : null;
}

function source(req: Request, component: SecurityEventPayloadV1['source']['component']) {
  return { component, requestId: requestIdOf(req), ipPrefix: ipPrefix(req.ip) };
}

/** `/api/v1/system/…` → `system`. A route family, never an id. */
function areaOf(req: Request): string | null {
  const parts = String(req.originalUrl ?? '').split('?')[0].split('/').filter(Boolean);
  const i = parts[0] === 'api' ? 2 : 0;
  const area = parts[i];
  return area && /^[a-z][a-z0-9-]{0,39}$/.test(area) ? area : null;
}

function method(req: Request): string {
  const m = String(req.method ?? '').toUpperCase();
  return TOKEN.test(m) ? m : 'OTHER';
}

function roleOf(req: Request): string | null {
  const r = req.user?.role;
  return typeof r === 'string' && TOKEN.test(r) ? r : null;
}

// ── the collectors ──────────────────────────────────────────────────────────

/**
 * Error middleware. Reads, publishes, and passes the error on untouched.
 * Mount after the routes and before the error reporter.
 */
export const securitySignalCollector: ErrorRequestHandler = (err, req, _res, next) => {
  try { collectFromError(err, req); } catch { /* never */ }
  next(err);
};

function collectFromError(err: unknown, req: Request): void {
  const signal = signalOf(err);
  if (signal?.type === 'security.login.failed') {
    emit(signal.type, req, {
      outcome: 'FAILURE',
      severity: 'LOW',
      actor: { type: 'ANONYMOUS', role: null },
      source: source(req, 'AUTH'),
      evidence: { reason: signal.reason, knownAccount: signal.reason !== 'UNKNOWN_ACCOUNT' },
      privacyClass: 'PERSONAL',
    });
    return;
  }
  if (signal?.type === 'security.mfa.failed') {
    // The password was right; the second step was not. The account is named
    // because the challenge proved which one it is — not because it was claimed.
    emit(signal.type, req, {
      outcome: 'FAILURE',
      severity: 'MEDIUM',
      actor: { type: 'USER', role: null },
      source: source(req, 'AUTH'),
      evidence: { stage: 'SIGN_IN' },
      privacyClass: 'PERSONAL',
    }, { actorUserId: signal.userId, sourceKey: `u:${signal.userId}` });
    return;
  }
  if (signal?.type === 'security.refresh.reused') {
    emit(signal.type, req, {
      outcome: 'BLOCKED',
      severity: 'MEDIUM',
      actor: { type: 'USER', role: null },
      source: source(req, 'AUTH'),
      evidence: {},
      privacyClass: 'PERSONAL',
    }, { actorUserId: signal.userId, sourceKey: `u:${signal.userId}` });
    return;
  }
  if (err instanceof OriginNotAllowedError) {
    const origin = String(req.headers?.origin ?? '');
    let host: string | null = null;
    try { host = new URL(origin).hostname.toLowerCase(); } catch { host = null; }
    emit('security.origin.rejected', req, {
      outcome: 'BLOCKED',
      severity: 'LOW',
      actor: { type: 'ANONYMOUS', role: null },
      source: source(req, 'CORS'),
      evidence: {
        method: method(req),
        preflight: method(req) === 'OPTIONS',
        ...(host && TOKEN.test(host) ? { originHost: host } : {}),
      },
      privacyClass: 'PERSONAL',
    });
    return;
  }
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  const status = Number(e?.statusCode ?? e?.status);
  if (status === 403) {
    const area = areaOf(req);
    const userId = req.user?.id ?? null;
    emit('security.access.denied', req, {
      outcome: 'BLOCKED',
      severity: 'LOW',
      actor: { type: userId ? 'USER' : 'ANONYMOUS', role: roleOf(req) },
      source: source(req, 'API'),
      evidence: { method: method(req), ...(area ? { area } : {}) },
      privacyClass: 'PERSONAL',
    }, userId ? { actorUserId: userId, sourceKey: `u:${userId}` } : {});
  }
}

/** The rate-limit buckets, as `rate-limit.middleware.ts` names them. */
export type RateLimitBucket = 'ip' | 'user' | 'tenant' | 'account' | 'auth';

/** A request refused with 429. Called from the limiter's single `deny`. */
export function recordRateLimitHit(req: Request, bucket: RateLimitBucket): void {
  try {
    const credential = bucket === 'account' || bucket === 'auth';
    emit('security.ratelimit.exceeded', req, {
      outcome: 'BLOCKED',
      severity: credential ? 'MEDIUM' : 'LOW',
      actor: { type: bucket === 'user' || bucket === 'tenant' ? 'USER' : 'ANONYMOUS', role: null },
      source: source(req, 'RATE_LIMIT'),
      evidence: { bucket, method: method(req) },
      privacyClass: 'PERSONAL',
    }, { sourceKey: `${bucket}|${ipPrefix(req.ip) ?? 'unknown'}` });
  } catch { /* never */ }
}

// ── for tests and a future status surface ───────────────────────────────────

export function securityCollectorStats(): Readonly<typeof stats> {
  return { ...stats };
}

/** Clear the windows and counters. Tests only. */
export function resetSecurityCollectors(): void {
  sources.clear();
  perType.clear();
  stats.written = 0; stats.suppressed = 0; stats.overCap = 0; stats.refused = 0;
}
