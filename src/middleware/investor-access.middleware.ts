// Familista — Global Investor Layer
// File location: src/middleware/investor-access.middleware.ts
//
// Derives an InvestorScope for the current user:
//   - Platform admin → unrestricted (read + write).
//   - Linked InvestorProfile → can see their own profile + entities they
//     have active investments or cap-table positions in.
//   - Otherwise → no investor-side access; only public-by-default routes pass.
//
// 30-second per-user cache keeps Stripe webhooks and dashboard loads cheap.

import type { Request, Response, NextFunction } from 'express';
import type { PlatformRole } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type {
  InvestorActor,
  InvestorScope,
  InvestorAccessMode,
} from '../types/investor.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      investorActor?: InvestorActor;
    }
  }
}

const SCOPE_CACHE_TTL_MS = 30 * 1000;
const scopeCache = new Map<string, { scope: InvestorScope; expiresAt: number }>();

function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]?.trim() ?? null;
  }
  return req.ip ?? null;
}

async function deriveScope(userId: string, platformRole: PlatformRole | null): Promise<InvestorScope> {
  const cacheKey = `${userId}:${platformRole ?? 'none'}`;
  const cached = scopeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  if (platformRole) {
    const scope: InvestorScope = {
      isPlatformAdmin: true,
      platformRole,
      investorId: null,
      ownedEntityIds: new Set(),
    };
    scopeCache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return scope;
  }

  const profile = await prisma.investorProfile.findUnique({ where: { userId } });
  if (!profile || !profile.isActive) {
    const empty: InvestorScope = {
      isPlatformAdmin: false,
      platformRole: null,
      investorId: null,
      ownedEntityIds: new Set(),
    };
    scopeCache.set(cacheKey, { scope: empty, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return empty;
  }

  const [investments, captable] = await Promise.all([
    prisma.investment.findMany({
      where: { investorId: profile.id, status: { in: ['COMMITTED', 'FUNDED', 'CONVERTED'] } },
      select: { entityId: true },
    }),
    prisma.capTableEntry.findMany({
      where: { investorId: profile.id, effectiveTo: null },
      select: { entityId: true },
    }),
  ]);

  const ownedEntityIds = new Set<string>();
  for (const i of investments) ownedEntityIds.add(i.entityId);
  for (const c of captable) ownedEntityIds.add(c.entityId);

  const scope: InvestorScope = {
    isPlatformAdmin: false,
    platformRole: null,
    investorId: profile.id,
    ownedEntityIds,
  };
  scopeCache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
  return scope;
}

export function clearInvestorScopeCacheForUser(userId: string): void {
  for (const key of scopeCache.keys()) {
    if (key.startsWith(`${userId}:`)) scopeCache.delete(key);
  }
}

export async function attachInvestorContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    const platformRole = req.platformActor?.role ?? null;
    const scope = await deriveScope(req.user.id, platformRole);

    req.investorActor = {
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

export function requireInvestorContext(req: Request, _res: Response, next: NextFunction): void {
  if (!req.investorActor) return next(new ForbiddenError('Investor context required'));
  return next();
}

export function assertEntityAccess(
  actor: InvestorActor,
  entityId: string,
  mode: InvestorAccessMode = 'read',
): void {
  if (actor.scope.isPlatformAdmin) return;

  if (mode === 'admin') {
    throw new ForbiddenError('Platform-admin access required');
  }
  if (mode === 'write') {
    throw new ForbiddenError('Only platform admins can mutate investor data here');
  }

  if (!actor.scope.ownedEntityIds.has(entityId)) {
    throw new ForbiddenError('Entity is outside your investor scope');
  }
}

export function assertInvestorAccess(
  actor: InvestorActor,
  investorId: string,
  mode: InvestorAccessMode = 'read',
): void {
  if (actor.scope.isPlatformAdmin) return;
  if (mode === 'admin' || mode === 'write') {
    throw new ForbiddenError('Only platform admins can mutate investor profiles here');
  }
  if (actor.scope.investorId !== investorId) {
    throw new ForbiddenError('Investor profile is outside your scope');
  }
}

export function effectiveEntityScope(actor: InvestorActor): Set<string> | undefined {
  if (actor.scope.isPlatformAdmin) return undefined;
  return actor.scope.ownedEntityIds;
}

export function effectiveInvestorScope(actor: InvestorActor): string | null | undefined {
  if (actor.scope.isPlatformAdmin) return undefined;
  return actor.scope.investorId;
}
