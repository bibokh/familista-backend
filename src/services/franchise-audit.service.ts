// Familista — Franchise Expansion Engine
// File location: src/services/franchise-audit.service.ts
//
// Domain-scoped audit log for the franchise stack. Distinct from PlatformAuditLog
// (which captures operator actions across all tenants). Writes are best-effort
// and never throw back into the calling path.

import { prisma } from '../lib/prisma';
import type {
  FranchiseAudit,
  FranchiseAuditCategory,
  FranchiseAuditResult,
  Prisma,
} from '@prisma/client';
import type { AuditQueryInput } from '../utils/franchise.validators';

export type WriteAuditOpts = {
  unitId?: string | null;
  userId?: string | null;
  ownerId?: string | null;
  action: string;
  category: FranchiseAuditCategory;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  result?: FranchiseAuditResult;
  message?: string | null;
};

export async function writeFranchiseAudit(opts: WriteAuditOpts): Promise<void> {
  try {
    await prisma.franchiseAudit.create({
      data: {
        unitId: opts.unitId ?? null,
        userId: opts.userId ?? null,
        ownerId: opts.ownerId ?? null,
        action: opts.action,
        category: opts.category,
        resourceType: opts.resourceType ?? null,
        resourceId: opts.resourceId ?? null,
        metadata:
          opts.metadata === undefined || opts.metadata === null
            ? undefined
            : (opts.metadata as Prisma.InputJsonValue),
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
        result: opts.result ?? 'SUCCESS',
        message: opts.message ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('franchise audit write failed', err);
  }
}

export type AuditPage = {
  items: FranchiseAudit[];
  nextCursor: string | null;
};

function buildWhere(q: AuditQueryInput): Prisma.FranchiseAuditWhereInput {
  const where: Prisma.FranchiseAuditWhereInput = {};
  if (q.unitId) where.unitId = q.unitId;
  if (q.userId) where.userId = q.userId;
  if (q.action) where.action = q.action;
  if (q.category) where.category = q.category as FranchiseAuditCategory;
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

export async function searchAudit(q: AuditQueryInput, scopeUnitIds?: Set<string>): Promise<AuditPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where = buildWhere(q);

  // If a scope is supplied (non-platform-admin caller), restrict to unitIds in scope
  if (scopeUnitIds) {
    where.unitId = { in: Array.from(scopeUnitIds) };
  }

  const items = await prisma.franchiseAudit.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function summarizeAudit(q: AuditQueryInput, scopeUnitIds?: Set<string>) {
  const where = buildWhere(q);
  if (scopeUnitIds) where.unitId = { in: Array.from(scopeUnitIds) };

  const [total, byCategory, byResult, recentFailures] = await Promise.all([
    prisma.franchiseAudit.count({ where }),
    prisma.franchiseAudit.groupBy({ where, by: ['category'], _count: { _all: true } }),
    prisma.franchiseAudit.groupBy({ where, by: ['result'], _count: { _all: true } }),
    prisma.franchiseAudit.findMany({
      where: { ...where, result: { in: ['FAILURE', 'REJECTED'] } },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
  ]);

  return {
    total,
    byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])),
    byResult: Object.fromEntries(byResult.map((r) => [r.result, r._count._all])),
    recentFailures,
  };
}
