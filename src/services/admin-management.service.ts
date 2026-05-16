// Familista — Platform Admin Management
// File location: src/services/admin-management.service.ts
//
// Cross-engine list/detail + targeted suspend/restore for the Admin Control
// Center. Every destructive call records a PlatformAuditLog entry via
// writePlatformAudit(). Idempotent — re-running suspend on a suspended
// entity is a no-op.
//
// Design boundary:
//   • Reads here are direct Prisma queries against existing models.
//   • Writes are minimal and never duplicate existing engine flows:
//       - Subscription plan/status changes go through admin-organization
//         service (SubscriptionOverride). NOT exposed here.
//       - User deactivation toggles User.isActive only.
//       - InvestorProfile deactivation toggles InvestorProfile.isActive only.
//       - FranchiseUnit suspend/restore toggles FranchiseUnit.status only.

import { prisma } from '../lib/prisma';
import type { Prisma, UserRole, FranchiseStatus, SubscriptionPlan, SubscriptionStatus, KycStatus, FranchiseLevel } from '@prisma/client';

import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import type { PlatformActor } from '../types/admin.types';
import { NotFoundError, BadRequestError } from '../utils/errors';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export type Pagination = { page: number; limit: number };
export type PaginatedResult<T> = { items: T[]; total: number; page: number; limit: number };

const COACH_ROLES: UserRole[] = ['HEAD_COACH', 'ASSISTANT_COACH'];
const MANAGER_ROLES: UserRole[] = ['CLUB_ADMIN'];

function clampPagination(p: Partial<Pagination> | undefined): Pagination {
  const page  = Math.max(1, Number(p?.page ?? 1) | 0);
  const limit = Math.min(200, Math.max(1, Number(p?.limit ?? 25) | 0));
  return { page, limit };
}

function skipOf(p: Pagination): number {
  return (p.page - 1) * p.limit;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIZATIONS / CLUBS / ACADEMIES — all backed by Club model
// ─────────────────────────────────────────────────────────────────────────────

export type OrganizationFilter = {
  q?: string;                                // substring on name / city / country
  plan?: SubscriptionPlan;
  status?: SubscriptionStatus;
  franchiseUnitId?: string | null;
  hasOverride?: boolean;
};

function buildClubWhere(f: OrganizationFilter): Prisma.ClubWhereInput {
  const where: Prisma.ClubWhereInput = {};
  if (f.q && f.q.trim()) {
    const q = f.q.trim();
    where.OR = [
      { name:    { contains: q, mode: 'insensitive' } },
      { city:    { contains: q, mode: 'insensitive' } },
      { country: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (f.plan)   where.plan = f.plan;
  if (f.status) where.subscriptionStatus = f.status;
  if (f.franchiseUnitId === null) where.franchiseUnitId = null;
  else if (f.franchiseUnitId)     where.franchiseUnitId = f.franchiseUnitId;
  if (f.hasOverride === true)  where.subscriptionOverrides = { some: { isActive: true, revokedAt: null } };
  if (f.hasOverride === false) where.subscriptionOverrides = { none: { isActive: true, revokedAt: null } };
  return where;
}

export async function listOrganizations(
  filter: OrganizationFilter,
  pag: Partial<Pagination>,
): Promise<PaginatedResult<{
  id: string;
  name: string;
  city: string;
  country: string;
  plan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus;
  planSource: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  franchiseUnitId: string | null;
  userCount: number;
  playerCount: number;
  createdAt: string;
}>> {
  const where = buildClubWhere(filter);
  const p = clampPagination(pag);

  const [rows, total] = await Promise.all([
    prisma.club.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true,
        name: true,
        city: true,
        country: true,
        plan: true,
        subscriptionStatus: true,
        planSource: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        franchiseUnitId: true,
        createdAt: true,
        _count: { select: { users: true, players: true } },
      },
    }),
    prisma.club.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      country: r.country,
      plan: r.plan,
      subscriptionStatus: r.subscriptionStatus,
      planSource: r.planSource,
      trialEndsAt:       r.trialEndsAt?.toISOString()      ?? null,
      currentPeriodEnd:  r.currentPeriodEnd?.toISOString() ?? null,
      franchiseUnitId: r.franchiseUnitId,
      userCount:   r._count.users,
      playerCount: r._count.players,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page: p.page,
    limit: p.limit,
  };
}

export async function getOrganizationDetail(clubId: string) {
  const c = await prisma.club.findUnique({
    where: { id: clubId },
    include: {
      _count: { select: { users: true, players: true, financials: true, matches: true, aiInsights: true } },
      franchiseUnit: { select: { id: true, code: true, name: true, status: true, level: true } },
      subscriptionOverrides: {
        where: { isActive: true, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
      limits: true,
      whiteLabel: { select: { id: true, productName: true, supportEmail: true } },
    },
  });
  if (!c) throw new NotFoundError('Organization not found');
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS — coaches, managers, full list
// ─────────────────────────────────────────────────────────────────────────────

export type UserFilter = {
  q?: string;
  role?: UserRole;
  clubId?: string;
  isActive?: boolean;
};

function buildUserWhere(f: UserFilter, roleOverride?: UserRole[]): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};
  if (f.q && f.q.trim()) {
    const q = f.q.trim();
    where.OR = [
      { email:     { contains: q, mode: 'insensitive' } },
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName:  { contains: q, mode: 'insensitive' } },
    ];
  }
  if (roleOverride && roleOverride.length > 0) where.role = { in: roleOverride };
  else if (f.role) where.role = f.role;
  if (f.clubId)              where.clubId = f.clubId;
  if (typeof f.isActive === 'boolean') where.isActive = f.isActive;
  return where;
}

async function listUsersImpl(where: Prisma.UserWhereInput, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, email: true, firstName: true, lastName: true,
        role: true, isActive: true, clubId: true, lastLoginAt: true,
        createdAt: true,
        club: { select: { id: true, name: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id, email: r.email, firstName: r.firstName, lastName: r.lastName,
      role: r.role, isActive: r.isActive,
      clubId: r.clubId, clubName: r.club?.name ?? null,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total, page: p.page, limit: p.limit,
  };
}

export const listUsers    = (f: UserFilter, p: Partial<Pagination>) => listUsersImpl(buildUserWhere(f),               p);
export const listCoaches  = (f: UserFilter, p: Partial<Pagination>) => listUsersImpl(buildUserWhere(f, COACH_ROLES),  p);
export const listManagers = (f: UserFilter, p: Partial<Pagination>) => listUsersImpl(buildUserWhere(f, MANAGER_ROLES), p);

export async function setUserActive(
  actor: PlatformActor,
  userId: string,
  isActive: boolean,
  reason: string | null,
): Promise<void> {
  const before = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, clubId: true } });
  if (!before) throw new NotFoundError('User not found');
  if (before.isActive === isActive) return;
  await prisma.user.update({ where: { id: userId }, data: { isActive } });
  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: before.clubId ?? null,
    action: isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
    category: 'OTHER',
    resourceType: 'User',
    resourceId: userId,
    metadata: { reason: reason ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYERS
// ─────────────────────────────────────────────────────────────────────────────

export type PlayerFilter = {
  q?: string;
  clubId?: string;
};

export async function listPlayers(filter: PlayerFilter, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.PlayerWhereInput = {};
  if (filter.q && filter.q.trim()) {
    const q = filter.q.trim();
    where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName:  { contains: q, mode: 'insensitive' } },
    ];
  }
  if (filter.clubId) where.clubId = filter.clubId;

  const [rows, total] = await Promise.all([
    prisma.player.findMany({
      where,
      orderBy: { lastName: 'asc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, firstName: true, lastName: true, number: true, position: true,
        clubId: true,
        club: { select: { name: true } },
      },
    }),
    prisma.player.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id, firstName: r.firstName, lastName: r.lastName,
      number: r.number, position: r.position,
      clubId: r.clubId, clubName: r.club?.name ?? null,
    })),
    total, page: p.page, limit: p.limit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INVESTORS
// ─────────────────────────────────────────────────────────────────────────────

export type InvestorFilter = {
  q?: string;
  kycStatus?: KycStatus;
  isActive?: boolean;
};

export async function listInvestors(filter: InvestorFilter, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.InvestorProfileWhereInput = {};
  if (filter.q && filter.q.trim()) {
    const q = filter.q.trim();
    where.OR = [
      { displayName:  { contains: q, mode: 'insensitive' } },
      { legalName:    { contains: q, mode: 'insensitive' } },
      { contactEmail: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (filter.kycStatus) where.kycStatus = filter.kycStatus;
  if (typeof filter.isActive === 'boolean') where.isActive = filter.isActive;

  const [rows, total] = await Promise.all([
    prisma.investorProfile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, type: true, entityType: true,
        displayName: true, legalName: true,
        contactEmail: true, contactName: true, countryCode: true,
        kycStatus: true, accredited: true, isActive: true,
        aumUsd: true,
        createdAt: true,
      },
    }),
    prisma.investorProfile.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    total, page: p.page, limit: p.limit,
  };
}

export async function setInvestorActive(
  actor: PlatformActor,
  investorId: string,
  isActive: boolean,
  reason: string | null,
): Promise<void> {
  const before = await prisma.investorProfile.findUnique({
    where: { id: investorId },
    select: { id: true, isActive: true },
  });
  if (!before) throw new NotFoundError('Investor not found');
  if (before.isActive === isActive) return;
  await prisma.investorProfile.update({ where: { id: investorId }, data: { isActive } });
  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: isActive ? 'INVESTOR_REACTIVATED' : 'INVESTOR_DEACTIVATED',
    category: 'OTHER',
    resourceType: 'InvestorProfile',
    resourceId: investorId,
    metadata: { reason: reason ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTIONS — surfaces Club rows with subscription columns + overrides
// ─────────────────────────────────────────────────────────────────────────────

export async function listSubscriptions(
  filter: { q?: string; plan?: SubscriptionPlan; status?: SubscriptionStatus },
  pag: Partial<Pagination>,
) {
  const where = buildClubWhere({ q: filter.q, plan: filter.plan, status: filter.status });
  const p = clampPagination(pag);

  const [rows, total] = await Promise.all([
    prisma.club.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, name: true, plan: true, subscriptionStatus: true, planSource: true,
        trialEndsAt: true, currentPeriodEnd: true,
        stripeCustomerId: true, stripeSubscriptionId: true,
        subscriptionOverrides: {
          where: { isActive: true, revokedAt: null },
          select: { id: true, plan: true, status: true, reason: true, expiresAt: true, bypassStripe: true },
          take: 1,
        },
      },
    }),
    prisma.club.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      clubId: r.id, clubName: r.name,
      plan: r.plan,
      status: r.subscriptionStatus,
      planSource: r.planSource,
      trialEndsAt:      r.trialEndsAt?.toISOString()      ?? null,
      currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
      stripeCustomerId:     r.stripeCustomerId,
      stripeSubscriptionId: r.stripeSubscriptionId,
      activeOverride: r.subscriptionOverrides[0] ?? null,
    })),
    total, page: p.page, limit: p.limit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS — read-only Financial rows
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentFilter = {
  clubId?: string;
  type?: 'INCOME' | 'EXPENSE';
  currency?: string;
  category?: string;
  from?: Date | null;
  to?: Date | null;
};

export async function listPayments(filter: PaymentFilter, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.FinancialWhereInput = {};
  if (filter.clubId)   where.clubId = filter.clubId;
  if (filter.type)     where.type = filter.type;
  if (filter.currency) where.currency = filter.currency.toUpperCase();
  if (filter.category) where.category = filter.category;
  if (filter.from || filter.to) {
    where.date = {};
    if (filter.from) where.date.gte = filter.from;
    if (filter.to)   where.date.lte = filter.to;
  }

  const [rows, total, agg] = await Promise.all([
    prisma.financial.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, clubId: true, type: true, category: true,
        amount: true, currency: true, description: true, date: true,
        club: { select: { name: true } },
      },
    }),
    prisma.financial.count({ where }),
    prisma.financial.aggregate({ where, _sum: { amount: true } }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id, clubId: r.clubId, clubName: r.club?.name ?? null,
      type: r.type, category: r.category,
      amount: r.amount, currency: r.currency,
      description: r.description,
      date: r.date.toISOString(),
    })),
    total, page: p.page, limit: p.limit,
    totalsAmount: agg._sum.amount ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FRANCHISE UNITS
// ─────────────────────────────────────────────────────────────────────────────

export type FranchiseUnitFilter = {
  q?: string;
  status?: FranchiseStatus;
  level?: FranchiseLevel;
  territoryId?: string;
};

export async function listFranchiseUnits(filter: FranchiseUnitFilter, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.FranchiseUnitWhereInput = {};
  if (filter.q && filter.q.trim()) {
    const q = filter.q.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { code: { contains: q, mode: 'insensitive' } },
      { legalName: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (filter.status)      where.status = filter.status;
  if (filter.level)       where.level = filter.level;
  if (filter.territoryId) where.territoryId = filter.territoryId;

  const [rows, total] = await Promise.all([
    prisma.franchiseUnit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, code: true, name: true, level: true, status: true,
        ownershipModel: true, countryCode: true, currency: true,
        parentUnitId: true, territoryId: true,
        territory: { select: { name: true } },
        _count: { select: { clubs: true, ownerships: true } },
        createdAt: true,
      },
    }),
    prisma.franchiseUnit.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name,
      level: r.level, status: r.status,
      ownershipModel: r.ownershipModel,
      countryCode: r.countryCode, currency: r.currency,
      parentUnitId: r.parentUnitId,
      territoryId: r.territoryId, territoryName: r.territory?.name ?? null,
      clubCount: r._count.clubs, ownerCount: r._count.ownerships,
      createdAt: r.createdAt.toISOString(),
    })),
    total, page: p.page, limit: p.limit,
  };
}

export async function setFranchiseUnitStatus(
  actor: PlatformActor,
  unitId: string,
  status: FranchiseStatus,
  reason: string | null,
): Promise<void> {
  const before = await prisma.franchiseUnit.findUnique({
    where: { id: unitId },
    select: { id: true, status: true },
  });
  if (!before) throw new NotFoundError('Franchise unit not found');
  if (before.status === status) return;

  // Guard: can only set to SUSPENDED, ACTIVE, or TERMINATED via this surface.
  if (!(status === 'SUSPENDED' || status === 'ACTIVE' || status === 'TERMINATED')) {
    throw new BadRequestError(`Status transition ${status} not permitted from admin dashboard`);
  }

  await prisma.franchiseUnit.update({ where: { id: unitId }, data: { status } });
  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    action: `FRANCHISE_UNIT_${status}`,
    category: 'OTHER',
    resourceType: 'FranchiseUnit',
    resourceId: unitId,
    metadata: { previousStatus: before.status, newStatus: status, reason: reason ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AI engine — list models + recent decisions
// ─────────────────────────────────────────────────────────────────────────────

export async function listAiModels(filter: { activeOnly?: boolean; q?: string }, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.AIModelWhereInput = {};
  if (filter.activeOnly) where.isActive = true;
  if (filter.q && filter.q.trim()) {
    const q = filter.q.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.aIModel.findMany({
      where,
      orderBy: [{ domain: 'asc' }, { name: 'asc' }],
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, slug: true, name: true, domain: true, decisionType: true,
        version: true, provider: true, isActive: true,
        releasedAt: true, deprecatedAt: true, createdAt: true,
      },
    }),
    prisma.aIModel.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      ...r,
      releasedAt:   r.releasedAt?.toISOString()   ?? null,
      deprecatedAt: r.deprecatedAt?.toISOString() ?? null,
      createdAt:    r.createdAt.toISOString(),
    })),
    total, page: p.page, limit: p.limit,
  };
}

export async function listAiDecisions(filter: { domain?: string; clubId?: string }, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.AIDecisionWhereInput = {};
  if (filter.domain) where.domain = filter.domain as Prisma.AIDecisionWhereInput['domain'];
  const [rows, total] = await Promise.all([
    prisma.aIDecision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, domain: true, decisionType: true, createdAt: true,
      },
    }),
    prisma.aIDecision.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    total, page: p.page, limit: p.limit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vision engine — list analysis runs
// ─────────────────────────────────────────────────────────────────────────────

export async function listVisionRuns(filter: { status?: string; clubId?: string }, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.VisionAnalysisRunWhereInput = {};
  if (filter.status)  where.status = filter.status as Prisma.VisionAnalysisRunWhereInput['status'];
  if (filter.clubId)  where.clubId = filter.clubId;
  const [rows, total] = await Promise.all([
    prisma.visionAnalysisRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
      select: {
        id: true, videoAssetId: true, clubId: true,
        modelProvider: true, modelVersion: true,
        status: true, confidence: true,
        framesProcessed: true, framesTotal: true,
        errorsCount: true, warningsCount: true,
        startedAt: true, finishedAt: true, durationMs: true,
        createdAt: true,
      },
    }),
    prisma.visionAnalysisRun.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      ...r,
      startedAt:  r.startedAt?.toISOString()  ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      createdAt:  r.createdAt.toISOString(),
    })),
    total, page: p.page, limit: p.limit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT — list with filters
// ─────────────────────────────────────────────────────────────────────────────

export type AuditFilter = {
  adminId?: string;
  userId?: string;
  clubId?: string;
  action?: string;
  category?: string;
  result?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date | null;
  to?: Date | null;
};

export async function listAuditLogs(filter: AuditFilter, pag: Partial<Pagination>) {
  const p = clampPagination(pag);
  const where: Prisma.PlatformAuditLogWhereInput = {};
  if (filter.adminId)      where.adminId      = filter.adminId;
  if (filter.userId)       where.userId       = filter.userId;
  if (filter.clubId)       where.clubId       = filter.clubId;
  if (filter.action)       where.action       = filter.action;
  if (filter.category)     where.category     = filter.category as Prisma.PlatformAuditLogWhereInput['category'];
  if (filter.result)       where.result       = filter.result   as Prisma.PlatformAuditLogWhereInput['result'];
  if (filter.resourceType) where.resourceType = filter.resourceType;
  if (filter.resourceId)   where.resourceId   = filter.resourceId;
  if (filter.from || filter.to) {
    where.createdAt = {};
    if (filter.from) where.createdAt.gte = filter.from;
    if (filter.to)   where.createdAt.lte = filter.to;
  }

  const [rows, total] = await Promise.all([
    prisma.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: skipOf(p),
      take: p.limit,
    }),
    prisma.platformAuditLog.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      adminId: r.adminId, userId: r.userId, clubId: r.clubId,
      action: r.action, category: r.category, result: r.result,
      resourceType: r.resourceType, resourceId: r.resourceId,
      metadata: r.metadata,
      ipAddress: r.ipAddress, userAgent: r.userAgent,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
    })),
    total, page: p.page, limit: p.limit,
  };
}
