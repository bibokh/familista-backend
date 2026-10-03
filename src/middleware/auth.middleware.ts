import { recordOutcome } from '../infra/outcome-meter';
import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../config/database';
import { runAsSystem, runInClubContext } from '../security/db-context';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { assertActingClubOperable } from './club-lifecycle.middleware';
import { verifyToken } from '../security/jwt-tokens';
import { assertSessionMayProceed, resolveSessionMfaState } from '../auth-prod/admin-mfa';

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  clubId: string;
  iat: number;
  exp: number;
}

// ── identity cache ───────────────────────────────────────────────────────────
type Identity = {
  id: string; email: string; role: UserRole; clubId: string; isActive: boolean;
  currentClubId: string | null; currentTeamId: string | null;
  /** Bumped when every session this person holds must stop being trusted. */
  tokenVersion: number;
  /**
   * Platform authority, resolved once with the identity it belongs to.
   *
   * Familista's platform owner is an active `PlatformAdmin` row — not
   * necessarily `SUPER_ADMIN` on the account, and never a club membership. The
   * guards need that fact on every request, and reading it separately in each
   * of them would be a query per guard per request; it is one join here, held
   * for the same few seconds as the rest of the identity and dropped by the
   * same `forgetIdentity`.
   *
   * This RESOLVES platform authority. It does not decide what it permits: the
   * only thing that reads it is `hasPlatformAuthority`, and `assertPlatformOwner`
   * is untouched and still reads the row itself.
   */
  platformAdmin: { isActive: boolean } | null;
};
const IDENTITY_TTL_MS = parseInt(process.env.AUTH_IDENTITY_TTL_MS ?? '5000', 10);
const IDENTITY_MAX = 20000;
const identityCache = new Map<string, { at: number; row: Identity | null }>();
const identityInflight = new Map<string, Promise<Identity | null>>();

// The identity cache is per-process, and so was its invalidation. With more
// than one worker that is a tenant-isolation hole, not merely a stale read: a
// user switches from club A to club B, the POST is handled by worker 1, worker
// 1 forgets — and worker 2 keeps answering as club A for the rest of the TTL.
// Every request that lands there is scoped, authorised and written against the
// club the user just left.
//
// So a forget is announced to every process. The publisher is injected by the
// channel bridge rather than imported here, which keeps this middleware free of
// any dependency on Redis and leaves the local behaviour identical when there
// is one process and no bridge.
type RemoteForget = (userId: string | null) => void;
let remoteForget: RemoteForget | null = null;
export function setRemoteIdentityPublisher(fn: RemoteForget | null): void { remoteForget = fn; }

// Listeners told when an identity is dropped — in this process, whichever
// process the change was made in (the bridge calls forgetIdentityLocal
// everywhere). The realtime session watcher uses it to re-check the open
// streams of that person at once (Cyber Defense R1c).
type ForgetListener = (userId: string | null) => void;
const forgetListeners = new Set<ForgetListener>();
export function onIdentityForgotten(fn: ForgetListener): () => void {
  forgetListeners.add(fn);
  return () => { forgetListeners.delete(fn); };
}

/** Drop a cached identity in THIS process only. The bridge's receiving end. */
export function forgetIdentityLocal(userId?: string | null): void {
  if (userId) identityCache.delete(userId);
  else identityCache.clear();
  for (const fn of forgetListeners) {
    try { fn(userId ?? null); } catch { /* a listener never breaks a forget */ }
  }
}

/** Drop a cached identity — call after anything that changes who a user is. */
export function forgetIdentity(userId?: string | null): void {
  forgetIdentityLocal(userId);
  if (remoteForget) {
    try { remoteForget(userId ?? null); } catch { /* freshness only; never fail the request */ }
  }
}

async function loadIdentity(userId: string): Promise<Identity | null> {
  const now = Date.now();
  const hit = identityCache.get(userId);
  if (hit && now - hit.at < IDENTITY_TTL_MS) return hit.row;

  // Concurrent requests for the same user on a cold cache — which is exactly
  // what a workspace's parallel hydration looks like — share one read.
  const live = identityInflight.get(userId);
  if (live) return live;

  const run = prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: {
      id: true, email: true, role: true, clubId: true, isActive: true,
      currentClubId: true, currentTeamId: true, tokenVersion: true,
      platformAdmin: { select: { isActive: true } },
    },
  }).then((row) => {
    if (identityCache.size >= IDENTITY_MAX) {
      // Bounded: drop the oldest tenth rather than growing without limit.
      let i = 0;
      for (const k of identityCache.keys()) {
        identityCache.delete(k);
        if (++i >= IDENTITY_MAX / 10) break;
      }
    }
    identityCache.set(userId, { at: Date.now(), row: row as Identity | null });
    return row as Identity | null;
  }).finally(() => { identityInflight.delete(userId); });

  identityInflight.set(userId, run);
  return run;
}

// ── sessions for long-lived connections (Cyber Defense R1c) ────────────────
//
// A WebSocket or an event stream is authenticated once, when it opens, and
// then stays open. It must be held to exactly the rule a request is held to:
// the same signature check, the same active-user check, the same token-version
// check that ends a session server-side — and it must keep being held to it
// while it is open, which is what `sessionStillValid` is for.

export interface RealtimeSession {
  userId: string;
  role: UserRole;
  /** The club the person is acting in: their chosen context, else their primary club. */
  clubId: string;
  /** The token's `tv` claim, or null for a token minted before the claim existed. */
  tokenVersion: number | null;
}

/** Verifies a token the way `authenticate` does, for a connection that cannot send headers. */
export async function verifySessionToken(token: string): Promise<RealtimeSession> {
  let verified: JwtPayload;
  try { verified = verifyToken<JwtPayload>('access', token); } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
  const claims = verified as unknown as { tv?: number; mfa?: unknown };
  return realtimeSessionFor(verified.sub, claims.tv, claims.mfa === true);
}

/**
 * The session rule for a long-lived connection, from the claims that opened
 * it: active user, token version. Shared by a verified token and a redeemed
 * WebSocket ticket (realtime/ws-ticket.ts), so the two cannot drift apart.
 */
export async function realtimeSessionFor(sub: string, claimed: number | undefined, passedCode = false): Promise<RealtimeSession> {
  const user = await loadIdentity(sub);
  if (!user) throw new UnauthorizedError('User not found or deactivated');
  if (typeof claimed === 'number' && claimed !== (user.tokenVersion ?? 0)) {
    throw new UnauthorizedError('Session ended. Please sign in again.');
  }
  // A live connection is never part of enrolment: only a full session opens one.
  if ((await resolveSessionMfaState(user.id, user.role, passedCode)) !== 'full') {
    throw new UnauthorizedError('Sign in again with your authentication code.');
  }
  return {
    userId: user.id,
    role: user.role,
    clubId: user.currentClubId ?? user.clubId,
    tokenVersion: typeof claimed === 'number' ? claimed : null,
  };
}

/**
 * Whether a session opened earlier would still be accepted now: the person is
 * still active and their token version has not moved on. Read through the
 * same short-lived identity cache as every request.
 */
export async function sessionStillValid(userId: string, tokenVersion: number | null): Promise<boolean> {
  const user = await loadIdentity(userId);
  if (!user) return false;
  return tokenVersion === null || tokenVersion === (user.tokenVersion ?? 0);
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Cookie-first: prefer HttpOnly access_token cookie (browser SPA).
    // Fall back to Authorization: Bearer <token> for API clients and WebSocket.
    //
    // A STALE COOKIE MUST NOT BEAT A VALID BEARER.
    //
    // This used to pick the cookie whenever one existed and reject outright if
    // it did not verify — so a request carrying an expired `access_token`
    // cookie AND a freshly minted bearer was refused, with the valid credential
    // sitting unread in the same request.
    //
    // That is not a rare shape. The access cookie lives fifteen minutes; the
    // SPA mints a replacement through `/auth/refresh` and holds it in memory.
    // From that moment every call carries both, and the one the browser will
    // not let the page delete was the only one being looked at.
    //
    // Each candidate is now VERIFIED, in preference order, and the first that
    // holds up wins. This grants nothing new: both are checked against the same
    // secret and the same token version a line below. It stops a credential
    // that is valid from being refused because a dead one travelled with it.
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.access_token;
    const authHeader  = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    const candidates = [cookieToken, bearerToken].filter(Boolean) as string[];
    if (candidates.length === 0) {
      throw new UnauthorizedError('No token provided');
    }

    let payload: JwtPayload | null = null;
    for (const candidate of candidates) {
      try {
        payload = verifyToken<JwtPayload>('access', candidate);
        break;
      } catch {
        // try the next credential; the error is raised below if none verifies
      }
    }
    if (!payload) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Verify user still exists and is active.
    //
    // This ran on EVERY request. One navigation lap is about forty API calls,
    // so opening a club read the same unchanged row forty times — the largest
    // single source of repeated queries in a request cycle, multiplied by every
    // concurrent user. The row is held for a few seconds instead.
    //
    // The window is deliberately short and the invariant is stated plainly: a
    // user deactivated, moved between clubs or given a different role takes
    // effect within IDENTITY_TTL_MS rather than instantly. Anything that
    // changes an identity clears it immediately through `forgetIdentity`, so
    // the only case that waits is a change made outside this process — a direct
    // database edit, or another instance — and seconds is the right price for
    // removing forty round trips a lap.
    const user = await loadIdentity(payload.sub);

    if (!user) {
      throw new UnauthorizedError('User not found or deactivated');
    }

    // A session that was ended server-side stops here.
    //
    // Revoking somebody's last membership of a club bumps their tokenVersion
    // and deletes their refresh tokens; an access token minted before that
    // carries the older version and is refused now rather than in fifteen
    // minutes. A token issued by a build that predates this claim carries no
    // version at all and is accepted — so the deploy that introduces this logs
    // nobody out. Their password is untouched: signing in again works.
    const claimed = (payload as unknown as { tv?: number }).tv;
    if (typeof claimed === 'number' && claimed !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedError('Session ended. Please sign in again.');
    }

    // Effective tenant: whatever the user picked in their context, falling
    // back to their legacy primary clubId. Existing code keeps working.
    const effectiveClubId = user.currentClubId ?? user.clubId;

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      clubId: effectiveClubId,
      // Phase A extensions (typed loosely so legacy callers ignore them)
      primaryClubId: user.clubId,
      currentClubId: user.currentClubId ?? null,
      currentTeamId: user.currentTeamId ?? null,
      // Who this person is to FAMILISTA, carried beside — never merged into —
      // who they are to a club. A platform owner holds no club role by virtue
      // of this flag, and a club owner never acquires it.
      isPlatformOwner: user.role === UserRole.SUPER_ADMIN || user.platformAdmin?.isActive === true,
    } as Express.Request['user'];
    req.clubId = effectiveClubId;
    // The token version this request was accepted under, so an event stream it
    // opens can be re-checked against it for as long as it stays open (R1c).
    (req as Request & { sessionTokenVersion?: number | null }).sessionTokenVersion =
      typeof claimed === 'number' ? claimed : null;

    // R7: with MFA_REQUIRED_FOR_ADMINS on, an administrator session that did
    // not pass a code is setup-only (not enrolled) or refused (enrolled).
    const passedCode = (payload as unknown as { mfa?: unknown }).mfa === true;
    const mfaState = await resolveSessionMfaState(user.id, user.role, passedCode);
    assertSessionMayProceed(mfaState, req.method, req.baseUrl + req.path);
    (req as Request & { sessionPassedCode?: boolean; sessionMfaState?: string }).sessionPassedCode = passedCode;
    (req as Request & { sessionMfaState?: string }).sessionMfaState = mfaState;

    // A club the platform has suspended cannot be OPERATED by its own people,
    // and this is the one place every authenticated request passes through, so
    // it is the one place the rule can be complete. The rule itself — what
    // counts as operating, who is exempt and why — is
    // `middleware/club-lifecycle.middleware.ts`; this only makes sure it is
    // asked. Hiding the controls in the interface is a courtesy; this is the
    // control.
    await assertActingClubOperable(req);

    recordOutcome('auth', true);
    // R14: the rest of this request runs with its club as the database
    // context; a platform owner acts across clubs on an explicit, named path.
    const ctxUser = req.user as unknown as { id: string; clubId?: string | null; isPlatformOwner?: boolean };
    if (ctxUser.isPlatformOwner) runAsSystem('platform-owner', () => next());
    else runInClubContext(ctxUser.clubId ?? null, ctxUser.id, () => next());
  } catch (err) {
    // A refused credential is the middleware working. Only a server-side
    // failure — the identity lookup throwing, say — counts against it.
    const status = (err as { statusCode?: number })?.statusCode;
    if (!(typeof status === 'number' && status < 500)) recordOutcome('auth', false);
    next(err);
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }

    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `Role '${req.user.role}' is not authorized for this action`
        )
      );
    }

    next();
  };
}

// Verify club ownership — ensures tenant isolation
export function ensureClubAccess(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const { clubId: paramClubId } = req.params;

  if (
    req.user?.role !== UserRole.SUPER_ADMIN &&
    paramClubId &&
    paramClubId !== req.user?.clubId
  ) {
    return next(new ForbiddenError('Access denied to this club'));
  }

  next();
}
