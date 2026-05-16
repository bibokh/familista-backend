// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-audit.service.ts
//
// Cross-tenant audit log reads (writes happen inline from each service through
// `writePlatformAudit`). Cursor-based pagination, broad filters, export.

import { prisma } from '../lib/prisma';
import type { AuditQueryInput } from '../utils/admin.validators';
import type {
  PlatformAuditLog,
  PlatformAuditCategory,
  PlatformAuditResult,
  Prisma,
} from '@prisma/client';

export type AuditPage = {
  items: PlatformAuditLog[];
  nextCursor: string | null;
};

function buildWhere(q: AuditQueryInput): Prisma.PlatformAuditLogWhereInput {
  const where: Prisma.PlatformAuditLogWhereInput = {};
  if (q.clubId) where.clubId = q.clubId;
  if (q.adminId) where.adminId = q.adminId;
  if (q.action) where.action = q.action;
  if (q.category) where.category = q.category as PlatformAuditCategory;
  if (q.result) where.result = q.result as PlatformAuditResult;
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

export async function searchAudit(q: AuditQueryInput): Promise<AuditPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const items = await prisma.platformAuditLog.findMany({
    where: buildWhere(q),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return {
    items: items.slice(0, take),
    nextCursor: hasMore ? items[take - 1].id : null,
  };
}

export async function summarizeAudit(q: AuditQueryInput) {
  const where = buildWhere(q);
  const [total, byCategory, byResult, recentFailures] = await Promise.all([
    prisma.platformAuditLog.count({ where }),
    prisma.platformAuditLog.groupBy({
      where,
      by: ['category'],
      _count: { _all: true },
    }),
    prisma.platformAuditLog.groupBy({
      where,
      by: ['result'],
      _count: { _all: true },
    }),
    prisma.platformAuditLog.findMany({
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

export async function exportAudit(q: AuditQueryInput, maxRows = 10_000): Promise<PlatformAuditLog[]> {
  return await prisma.platformAuditLog.findMany({
    where: buildWhere(q),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(maxRows, 1), 50_000),
  });
}
