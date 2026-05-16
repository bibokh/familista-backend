// Familista — Franchise Expansion Engine
// File location: src/middleware/franchise-access.middleware.ts
//
// Derives a hierarchical FranchiseScope for the current user:
//   - Platform admins (any role) get full read scope; PLATFORM_OWNER/ADMIN get
//     full write scope; READ_ONLY/SUPPORT/BILLING get read + narrow write.
//   - Otherwise: derive owned-unit set from FranchiseOwner.ownerships, then
//     expand via parent-child hierarchy. Primary owners get :primary access.
//
// Attaches `req.franchiseActor` for downstream handlers and `assertUnitAccess`
// helper for service guards.

import type { Request, Response, NextFunction } from 'express';
import type { PlatformRole } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { getDescendantUnitIds } from '../services/franchise-unit.service';
import type { FranchiseActor, FranchiseScope, AccessMode } from '../types/franchise.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      franchiseActor?: FranchiseActor;
    }
  }
}

const PLATFORM_WRITE_ROLES: ReadonlySet<PlatformRole> = new Set([
  'PLATFORM_OWNER',
  'PLATFORM_ADMIN',
]);
const PLATFORM_BILLING_WRITE_CATEGORIES = new Set(['REVENUE']);

const SCOPE_CACHE_TTL_MS = 30 * 1000;
const scopeCache = new Map<string, { scope: FranchiseScope; expiresAt: number }>();

function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]?.trim() ?? null;
  }
  return req.ip ?? null;
}

async function deriveScope(userId: string, platformRole: PlatformRole | null): Promise<FranchiseScope> {
  const cacheKey = `${userId}:${platformRole ?? 'none'}`;
  const cached = scopeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  if (platformRole) {
    const scope: FranchiseScope = {
      isPlatformAdmin: true,
      platformRole,
      readableUnitIds: new Set(),    // empty = unrestricted at platform level
      writableUnitIds: new Set(),
      primaryUnitIds: new Set(),
      ownerIds: new Set(),
    };
    scopeCache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return scope;
  }

  const owner = await prisma.franchiseOwner.findUnique({
    where: { userId },
    include: {
      ownerships: { where: { effectiveTo: null }, select: { unitId: true, isPrimary: true } },
    },
  });

  if (!owner || !owner.isActive || owner.ownerships.length === 0) {
    const empty: FranchiseScope = {
      isPlatformAdmin: false,
      platformRole: null,
      readableUnitIds: new Set(),
      writableUnitIds: new Set(),
      primaryUnitIds: new Set(),
      ownerIds: new Set(),
    };
    scopeCache.set(cacheKey, { scope: empty, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return empty;
  }

  const directUnitIds = new Set(owner.ownerships.map((o) => o.unitId));
  const primaryUnitIds = new Set(owner.ownerships.filter((o) => o.isPrimary).map((o) => o.unitId));

  // Expand to descendants for read; write is restricted to the directly-owned set.
  const descendants = await getDescendantUnitIds(directUnitIds);

  const scope: FranchiseScope = {
    isPlatformAdmin: false,
    platformRole: null,
    readableUnitIds: descendants,
    writableUnitIds: directUnitIds,
    primaryUnitIds,
    ownerIds: new Set([owner.id]),
  };
  scopeCache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
  return scope;
}

export async function attachFranchiseContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');

    const platformRole = req.platformActor?.role ?? null;
    const scope = await deriveScope(req.user.id, platformRole);

    req.franchiseActor = {
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

export function clearFranchiseScopeCacheForUser(userId: string): void {
  for (const key of scopeCache.keys()) {
    if (key.startsWith(`${userId}:`)) scopeCache.delete(key);
  }
}

export function requireFranchiseContext(req: Request, _res: Response, next: NextFunction): void {
  if (!req.franchiseActor) {
    return next(new ForbiddenError('Franchise context required'));
  }
  return next();
}

export function platformWriteAllowed(role: PlatformRole | null, category?: string): boolean {
  if (!role) return false;
  if (PLATFORM_WRITE_ROLES.has(role)) return true;
  if (role === 'PLATFORM_BILLING' && category && PLATFORM_BILLING_WRITE_CATEGORIES.has(category)) return true;
  return false;
}

export function assertUnitAccess(
  actor: FranchiseActor,
  unitId: string,
  mode: AccessMode,
  opts?: { category?: string },
): void {
  const { scope } = actor;

  if (scope.isPlatformAdmin) {
    if (mode === 'read') return;
    if (platformWriteAllowed(scope.platformRole, opts?.category)) return;
    throw new ForbiddenError(`Platform role ${scope.platformRole} cannot ${mode} franchise resources here`);
  }

  if (mode === 'read') {
    if (!scope.readableUnitIds.has(unitId)) {
      throw new ForbiddenError('Unit is outside your franchise scope');
    }
    return;
  }

  if (mode === 'write') {
    if (!scope.writableUnitIds.has(unitId)) {
      throw new ForbiddenError('You do not have write access to this unit');
    }
    return;
  }

  if (mode === 'primary') {
    if (!scope.primaryUnitIds.has(unitId)) {
      throw new ForbiddenError('Primary-owner access required for this operation');
    }
    return;
  }
}

export function effectiveScopeForReads(actor: FranchiseActor): Set<string> | undefined {
  if (actor.scope.isPlatformAdmin) return undefined; // unrestricted
  return actor.scope.readableUnitIds;
}
