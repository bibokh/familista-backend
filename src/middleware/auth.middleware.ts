import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../config/database';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { assertActingClubOperable } from './club-lifecycle.middleware';

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

/** Drop a cached identity in THIS process only. The bridge's receiving end. */
export function forgetIdentityLocal(userId?: string | null): void {
  if (userId) identityCache.delete(userId);
  else identityCache.clear();
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

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Cookie-first: prefer HttpOnly access_token cookie (browser SPA).
    // Fall back to Authorization: Bearer <token> for API clients and WebSocket.
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.access_token;
    const authHeader  = req.headers.authorization;

    let token: string;
    if (cookieToken) {
      token = cookieToken;
    } else if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      throw new UnauthorizedError('No token provided');
    }
    let payload: JwtPayload;

    try {
      payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
    } catch {
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

    // A club the platform has suspended cannot be OPERATED by its own people,
    // and this is the one place every authenticated request passes through, so
    // it is the one place the rule can be complete. The rule itself — what
    // counts as operating, who is exempt and why — is
    // `middleware/club-lifecycle.middleware.ts`; this only makes sure it is
    // asked. Hiding the controls in the interface is a courtesy; this is the
    // control.
    await assertActingClubOperable(req);

    next();
  } catch (err) {
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
