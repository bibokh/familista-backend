import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../config/database';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

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
};
const IDENTITY_TTL_MS = parseInt(process.env.AUTH_IDENTITY_TTL_MS ?? '5000', 10);
const IDENTITY_MAX = 20000;
const identityCache = new Map<string, { at: number; row: Identity | null }>();
const identityInflight = new Map<string, Promise<Identity | null>>();

/** Drop a cached identity — call after anything that changes who a user is. */
export function forgetIdentity(userId?: string | null): void {
  if (userId) identityCache.delete(userId);
  else identityCache.clear();
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
      currentClubId: true, currentTeamId: true,
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
    } as Express.Request['user'];
    req.clubId = effectiveClubId;

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
