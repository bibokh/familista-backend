// Familista — AI Decision Engine
// File location: src/services/ai-audit.service.ts
//
// AI audit log — separate table from AIDecision so that decision queries don't
// stall on the audit history volume. Every model registration, decision
// generation, review, feedback, and access denial writes a row here.

import { prisma } from '../lib/prisma';
import type {
  AIAudit,
  AIAuditCategory,
  AIAuditResult,
  Prisma,
} from '@prisma/client';
import type { AIAuditQueryInput } from '../utils/ai-engine.validators';

export type WriteAIAuditOpts = {
  decisionId?: string | null;
  modelId?: string | null;
  userId?: string | null;
  action: string;
  category: AIAuditCategory;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  result?: AIAuditResult;
  message?: string | null;
};

export async function writeAIAudit(opts: WriteAIAuditOpts): Promise<void> {
  try {
    await prisma.aIAudit.create({
      data: {
        decisionId: opts.decisionId ?? null,
        modelId: opts.modelId ?? null,
        userId: opts.userId ?? null,
        action: opts.action,
        category: opts.category,
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
    console.error('AI audit write failed', err);
  }
}

export type AIAuditPage = {
  items: AIAudit[];
  nextCursor: string | null;
};

function buildWhere(q: AIAuditQueryInput): Prisma.AIAuditWhereInput {
  const where: Prisma.AIAuditWhereInput = {};
  if (q.decisionId) where.decisionId = q.decisionId;
  if (q.modelId) where.modelId = q.modelId;
  if (q.action) where.action = q.action;
  if (q.category) where.category = q.category as AIAuditCategory;
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

export async function searchAIAudit(q: AIAuditQueryInput): Promise<AIAuditPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const items = await prisma.aIAudit.findMany({
    where: buildWhere(q),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function summarizeAIAudit(q: AIAuditQueryInput) {
  const where = buildWhere(q);
  const [total, byCategory, byResult, recentFailures] = await Promise.all([
    prisma.aIAudit.count({ where }),
    prisma.aIAudit.groupBy({ where, by: ['category'], _count: { _all: true } }),
    prisma.aIAudit.groupBy({ where, by: ['result'], _count: { _all: true } }),
    prisma.aIAudit.findMany({
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
