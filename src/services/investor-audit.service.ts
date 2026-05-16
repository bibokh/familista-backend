// Familista — Global Investor Layer
// File location: src/services/investor-audit.service.ts
//
// Domain-scoped audit log + reader. Best-effort writes; never throw back into
// the caller. Reads can be scoped to a specific investor or entity (for the
// investor-facing dashboard) or unscoped (for platform admins).

import { prisma } from '../lib/prisma';
import type {
  InvestorAudit,
  InvestorAuditCategory,
  InvestorAuditResult,
  Prisma,
} from '@prisma/client';
import type { AuditQueryInput } from '../utils/investor.validators';

export type WriteAuditOpts = {
  investorId?: string | null;
  entityId?: string | null;
  userId?: string | null;
  action: string;
  category: InvestorAuditCategory;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  result?: InvestorAuditResult;
  message?: string | null;
};

export async function writeInvestorAudit(opts: WriteAuditOpts): Promise<void> {
  try {
    await prisma.investorAudit.create({
      data: {
        investorId: opts.investorId ?? null,
        entityId: opts.entityId ?? null,
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
    console.error('investor audit write failed', err);
  }
}

export type AuditPage = {
  items: InvestorAudit[];
  nextCursor: string | null;
};

function buildWhere(q: AuditQueryInput): Prisma.InvestorAuditWhereInput {
  const where: Prisma.InvestorAuditWhereInput = {};
  if (q.investorId) where.investorId = q.investorId;
  if (q.entityId) where.entityId = q.entityId;
  if (q.action) where.action = q.action;
  if (q.category) where.category = q.category as InvestorAuditCategory;
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

export async function searchAudit(
  q: AuditQueryInput,
  scope?: { investorId?: string | null; entityIds?: Set<string> },
): Promise<AuditPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where = buildWhere(q);

  if (scope) {
    // Combine OR semantics for read scope: rows where the investor matches OR
    // entity is in the readable set.
    const ors: Prisma.InvestorAuditWhereInput[] = [];
    if (scope.investorId) ors.push({ investorId: scope.investorId });
    if (scope.entityIds && scope.entityIds.size > 0) {
      ors.push({ entityId: { in: Array.from(scope.entityIds) } });
    }
    if (ors.length > 0) where.OR = ors;
    else {
      // No effective scope — return empty
      return { items: [], nextCursor: null };
    }
  }

  const items = await prisma.investorAudit.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}
