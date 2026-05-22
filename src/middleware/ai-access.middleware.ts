// Familista — AI Decision Engine
// File location: src/middleware/ai-access.middleware.ts
//
// Builds an AIAccessScope per request: derives the user's club, role,
// investor profile, franchise unit set, and investment entity set in one
// pass. Downstream handlers reject out-of-scope subjects via the helpers
// exposed here. Scope is cached per user for 30 s.

import type { Request, Response, NextFunction } from 'express';
import type { PlatformRole, UserRole } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { getDescendantUnitIds } from '../services/franchise-unit.service';
import type {
  AIActor,
  AIAccessScope,
  AIActorRole,
  AISubjectType,
} from '../types/ai-engine.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aiActor?: AIActor;
    }
  }
}

const SCOPE_CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { scope: AIAccessScope; expiresAt: number }>();

const USER_TO_AI_ROLE: Record<UserRole, AIActorRole> = {
  SUPER_ADMIN: 'PLATFORM_ADMIN',
  CLUB_ADMIN: 'CLUB_ADMIN',
  HEAD_COACH: 'HEAD_COACH',
  ASSISTANT_COACH: 'ASSISTANT_COACH',
  ANALYST: 'ANALYST',
  MEDICAL_STAFF: 'MEDICAL_STAFF',
  SCOUT: 'SCOUT',
  // Phase O additions — map to the closest existing AI access role.
  MANAGER: 'CLUB_ADMIN',
  COACH: 'ASSISTANT_COACH',
  PARENT: 'ANALYST',
  PLAYER: 'ANALYST',
};

function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]?.trim() ?? null;
  return req.ip ?? null;
}

async function deriveScope(userId: string, platformRole: PlatformRole | null): Promise<AIAccessScope> {
  const cacheKey = `${userId}:${platformRole ?? 'none'}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  if (platformRole) {
    const scope: AIAccessScope = {
      isPlatformAdmin: true,
      platformRole,
      userId,
      clubId: null,
      userRole: 'PLATFORM_ADMIN',
      investorId: null,
      franchiseUnitIds: new Set(),
      entityIds: new Set(),
    };
    cache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return scope;
  }

  const [user, investor, owner] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { clubId: true, role: true } }),
    prisma.investorProfile.findUnique({ where: { userId }, select: { id: true, isActive: true } }),
    prisma.franchiseOwner.findUnique({
      where: { userId },
      select: { id: true, isActive: true, ownerships: { where: { effectiveTo: null }, select: { unitId: true } } },
    }),
  ]);

  let franchiseUnitIds = new Set<string>();
  if (owner?.isActive) {
    const direct = owner.ownerships.map((o) => o.unitId);
    franchiseUnitIds = await getDescendantUnitIds(direct);
  }

  let entityIds = new Set<string>();
  if (investor?.isActive) {
    const [investments, captable] = await Promise.all([
      prisma.investment.findMany({
        where: { investorId: investor.id, status: { in: ['COMMITTED', 'FUNDED', 'CONVERTED'] } },
        select: { entityId: true },
      }),
      prisma.capTableEntry.findMany({
        where: { investorId: investor.id, effectiveTo: null },
        select: { entityId: true },
      }),
    ]);
    entityIds = new Set([...investments.map((i) => i.entityId), ...captable.map((c) => c.entityId)]);
  }

  const scope: AIAccessScope = {
    isPlatformAdmin: false,
    platformRole: null,
    userId,
    clubId: user?.clubId ?? null,
    userRole: user ? USER_TO_AI_ROLE[user.role] : null,
    investorId: investor?.isActive ? investor.id : null,
    franchiseUnitIds,
    entityIds,
  };
  cache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
  return scope;
}

export function clearAIScopeCacheForUser(userId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

export async function attachAIContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    const platformRole = req.platformActor?.role ?? null;
    const scope = await deriveScope(req.user.id, platformRole);
    req.aiActor = { userId: req.user.id, scope, ipAddress: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAIContext(req: Request, _res: Response, next: NextFunction): void {
  if (!req.aiActor) return next(new ForbiddenError('AI context required'));
  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject access helpers
// ─────────────────────────────────────────────────────────────────────────────

const PLAYER_ACTOR_ROLES: ReadonlySet<AIActorRole> = new Set([
  'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'PLATFORM_ADMIN',
]);
const CLUB_ACTOR_ROLES: ReadonlySet<AIActorRole> = new Set([
  'CLUB_ADMIN', 'PLATFORM_ADMIN',
]);
const COACH_ACTOR_ROLES: ReadonlySet<AIActorRole> = new Set([
  'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'PLATFORM_ADMIN',
]);

export async function assertSubjectAccess(
  actor: AIActor,
  subjectType: AISubjectType,
  subjectId: string,
): Promise<void> {
  if (actor.scope.isPlatformAdmin) return;
  const role = actor.scope.userRole;

  switch (subjectType) {
    case 'Player': {
      if (!role || !PLAYER_ACTOR_ROLES.has(role)) throw new ForbiddenError('Role cannot access player decisions');
      const player = await prisma.player.findUnique({ where: { id: subjectId }, select: { clubId: true } });
      if (!player) throw new ForbiddenError('Player not in scope');
      if (player.clubId !== actor.scope.clubId) throw new ForbiddenError('Player belongs to another club');
      return;
    }
    case 'Match': {
      if (!role || !COACH_ACTOR_ROLES.has(role)) throw new ForbiddenError('Role cannot access match decisions');
      const match = await prisma.match.findUnique({ where: { id: subjectId }, select: { clubId: true } });
      if (!match) throw new ForbiddenError('Match not in scope');
      if (match.clubId !== actor.scope.clubId) throw new ForbiddenError('Match belongs to another club');
      return;
    }
    case 'Club': {
      if (!role || !CLUB_ACTOR_ROLES.has(role)) throw new ForbiddenError('Role cannot access club decisions');
      if (subjectId !== actor.scope.clubId) throw new ForbiddenError('Club outside your scope');
      return;
    }
    case 'TrainingSession': {
      if (!role || !COACH_ACTOR_ROLES.has(role)) throw new ForbiddenError('Role cannot access training decisions');
      const session = await prisma.trainingSession.findUnique({ where: { id: subjectId }, select: { clubId: true } });
      if (!session) throw new ForbiddenError('Training session not in scope');
      if (session.clubId !== actor.scope.clubId) throw new ForbiddenError('Training session in another club');
      return;
    }
    case 'FranchiseUnit': {
      if (!actor.scope.franchiseUnitIds.has(subjectId)) throw new ForbiddenError('Franchise unit outside your scope');
      return;
    }
    case 'InvestorProfile': {
      if (subjectId !== actor.scope.investorId) throw new ForbiddenError('Investor profile outside your scope');
      return;
    }
    case 'InvestmentEntity': {
      if (!actor.scope.entityIds.has(subjectId)) throw new ForbiddenError('Investment entity outside your scope');
      return;
    }
    case 'Platform': {
      throw new ForbiddenError('Platform-level decisions require platform-admin access');
    }
  }
}

export function assertPlatformAdmin(actor: AIActor): void {
  if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
}
