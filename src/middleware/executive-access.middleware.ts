// Familista — Executive OS · Integration Layer
// File location: src/middleware/executive-access.middleware.ts
//
// Executive access derivation. Three classes of caller are recognised:
//   1. Platform admin (PLATFORM_OWNER / PLATFORM_ADMIN) — full executive scope.
//   2. ExecutiveAssignment holder — strategic roles (CEO, CFO, CHAIR, …).
//   3. Anyone else — rejected.
//
// Cached 30 s per user to keep the executive dashboard cheap to load.

import type { Request, Response, NextFunction } from 'express';
import type { ExecutiveRole, PlatformRole } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type {
  ExecutiveAccessScope,
  ExecutiveActor,
} from '../types/executive.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      executiveActor?: ExecutiveActor;
    }
  }
}

const SCOPE_CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { scope: ExecutiveAccessScope; expiresAt: number }>();

function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]?.trim() ?? null;
  return req.ip ?? null;
}

async function deriveScope(userId: string, platformRole: PlatformRole | null): Promise<ExecutiveAccessScope> {
  const cacheKey = `${userId}:${platformRole ?? 'none'}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  const [assignment, user] = await Promise.all([
    prisma.executiveAssignment.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { clubId: true } }),
  ]);

  const isPlatformAdmin = !!platformRole;
  const role: ExecutiveRole | null = assignment?.isActive ? assignment.role : null;

  const scope: ExecutiveAccessScope = {
    isPlatformAdmin,
    platformRole,
    userId,
    clubId: user?.clubId ?? null,
    executiveRole: role,
    voteWeight: assignment?.voteWeight ?? 1.0,
    executiveAssignmentId: assignment?.isActive ? assignment.id : null,
  };
  cache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
  return scope;
}

export function clearExecutiveScopeCacheForUser(userId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

export async function attachExecutiveContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    const platformRole = req.platformActor?.role ?? null;
    const scope = await deriveScope(req.user.id, platformRole);

    if (!scope.isPlatformAdmin && !scope.executiveRole) {
      throw new ForbiddenError('Executive assignment required');
    }

    req.executiveActor = {
      userId: req.user.id,
      scope,
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireExecutiveContext(req: Request, _res: Response, next: NextFunction): void {
  if (!req.executiveActor) return next(new ForbiddenError('Executive context required'));
  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Role-based guard helpers used inside controllers
// ─────────────────────────────────────────────────────────────────────────────

export function requireRoles(roles: ExecutiveRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = req.executiveActor;
    if (!actor) return next(new ForbiddenError('Executive context required'));
    if (actor.scope.isPlatformAdmin) return next();
    if (actor.scope.executiveRole && roles.includes(actor.scope.executiveRole)) return next();
    return next(new ForbiddenError(`Required role: ${roles.join(' | ')}`));
  };
}

export function requireBoardRole(req: Request, _res: Response, next: NextFunction): void {
  const actor = req.executiveActor;
  if (!actor) return next(new ForbiddenError('Executive context required'));
  if (actor.scope.isPlatformAdmin) return next();
  const role = actor.scope.executiveRole;
  if (role === 'CHAIR' || role === 'BOARD_MEMBER') return next();
  return next(new ForbiddenError('Board role required'));
}

export function requireExecutiveLeadership(req: Request, _res: Response, next: NextFunction): void {
  const actor = req.executiveActor;
  if (!actor) return next(new ForbiddenError('Executive context required'));
  if (actor.scope.isPlatformAdmin) return next();
  const role = actor.scope.executiveRole;
  if (role === 'CEO' || role === 'CFO' || role === 'COO') return next();
  return next(new ForbiddenError('CEO / CFO / COO role required'));
}
