// Familista — Executive OS · Integration Layer
// File location: src/services/executive-audit.service.ts
//
// Board-grade audit log. Every workflow transition, attestation, board vote,
// sponsor stage change, forecast generation, risk alert lifecycle, and access
// denial writes a row here. Reads support filter + cursor pagination +
// summary aggregates.

import { prisma } from '../lib/prisma';
import type {
  ExecutiveAudit,
  ExecutiveAuditCategory,
  ExecutiveAuditResult,
  Prisma,
} from '@prisma/client';
import type { ExecutiveAuditQueryInput } from '../utils/executive.validators';

export type WriteExecutiveAuditOpts = {
  workflowId?: string | null;
  resolutionId?: string | null;
  alertId?: string | null;
  forecastId?: string | null;
  opportunityId?: string | null;
  userId?: string | null;
  action: string;
  category: ExecutiveAuditCategory;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  result?: ExecutiveAuditResult;
  message?: string | null;
};

export async function writeExecutiveAudit(opts: WriteExecutiveAuditOpts): Promise<void> {
  try {
    await prisma.executiveAudit.create({
      data: {
        workflowId: opts.workflowId ?? null,
        resolutionId: opts.resolutionId ?? null,
        alertId: opts.alertId ?? null,
        forecastId: opts.forecastId ?? null,
        opportunityId: opts.opportunityId ?? null,
        userId: opts.userId ?? null,
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
    console.error('executive audit write failed', err);
  }
}

export type ExecutiveAuditPage = {
  items: ExecutiveAudit[];
  nextCursor: string | null;
};

function buildWhere(q: ExecutiveAuditQueryInput): Prisma.ExecutiveAuditWhereInput {
  const where: Prisma.ExecutiveAuditWhereInput = {};
  if (q.workflowId) where.workflowId = q.workflowId;
  if (q.resolutionId) where.resolutionId = q.resolutionId;
  if (q.alertId) where.alertId = q.alertId;
  if (q.userId) where.userId = q.userId;
  if (q.action) where.action = q.action;
  if (q.category) where.category = q.category as ExecutiveAuditCategory;
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

export async function searchExecutiveAudit(q: ExecutiveAuditQueryInput): Promise<ExecutiveAuditPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const items = await prisma.executiveAudit.findMany({
    where: buildWhere(q),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function summarizeExecutiveAudit(q: ExecutiveAuditQueryInput) {
  const where = buildWhere(q);
  const [total, byCategory, byResult] = await Promise.all([
    prisma.executiveAudit.count({ where }),
    prisma.executiveAudit.groupBy({ where, by: ['category'], _count: { _all: true } }),
    prisma.executiveAudit.groupBy({ where, by: ['result'], _count: { _all: true } }),
  ]);
  return {
    total,
    byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])),
    byResult: Object.fromEntries(byResult.map((r) => [r.result, r._count._all])),
  };
}
