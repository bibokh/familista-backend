// Familista — AI Decision Engine
// File location: src/services/ai-decision-history.service.ts
//
// Query layer over the AIDecision table. Supports scope-filtered reads so
// tenants only see decisions in their scope, plus aggregates for dashboards.

import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { Prisma } from '@prisma/client';
import type {
  AIDecision,
  AIDomain,
  AIDecisionType,
  AIDecisionStatus,
  AIOutcome,
  AIUrgency,
} from '@prisma/client';
import type { HistoryQueryInput } from '../utils/ai-engine.validators';
import type { AIActor } from '../types/ai-engine.types';

export type HistoryPage = {
  items: AIDecision[];
  nextCursor: string | null;
};

function applyScopeFilter(
  where: Prisma.AIDecisionWhereInput,
  actor: AIActor,
): Prisma.AIDecisionWhereInput {
  if (actor.scope.isPlatformAdmin) return where;

  const ors: Prisma.AIDecisionWhereInput[] = [];
  if (actor.scope.clubId) ors.push({ clubId: actor.scope.clubId });
  if (actor.scope.investorId) ors.push({ investorId: actor.scope.investorId });
  if (actor.scope.franchiseUnitIds.size > 0) ors.push({ franchiseUnitId: { in: Array.from(actor.scope.franchiseUnitIds) } });
  if (actor.scope.entityIds.size > 0) ors.push({ entityId: { in: Array.from(actor.scope.entityIds) } });

  if (ors.length === 0) {
    // No legitimate scope — show nothing
    return { ...where, id: '__none__' };
  }
  return { ...where, OR: ors };
}

function buildWhere(q: HistoryQueryInput, actor: AIActor): Prisma.AIDecisionWhereInput {
  const where: Prisma.AIDecisionWhereInput = {};
  if (q.domain) where.domain = q.domain as AIDomain;
  if (q.decisionType) where.decisionType = q.decisionType as AIDecisionType;
  if (q.subjectType) where.subjectType = q.subjectType;
  if (q.subjectId) where.subjectId = q.subjectId;
  if (q.clubId) where.clubId = q.clubId;
  if (q.franchiseUnitId) where.franchiseUnitId = q.franchiseUnitId;
  if (q.investorId) where.investorId = q.investorId;
  if (q.entityId) where.entityId = q.entityId;
  if (q.status) where.status = q.status as AIDecisionStatus;
  if (q.outcome) where.outcome = q.outcome as AIOutcome;
  if (q.urgency) where.urgency = q.urgency as AIUrgency;
  if (q.minScore != null) where.score = { gte: q.minScore };
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return applyScopeFilter(where, actor);
}

export async function search(actor: AIActor, q: HistoryQueryInput): Promise<HistoryPage> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const items = await prisma.aIDecision.findMany({
    where: buildWhere(q, actor),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function summarize(actor: AIActor, q: HistoryQueryInput) {
  const where = buildWhere(q, actor);
  const [total, byDomain, byUrgency, byStatus, byOutcome] = await Promise.all([
    prisma.aIDecision.count({ where }),
    prisma.aIDecision.groupBy({ where, by: ['domain'], _count: { _all: true } }),
    prisma.aIDecision.groupBy({ where, by: ['urgency'], _count: { _all: true } }),
    prisma.aIDecision.groupBy({ where, by: ['status'], _count: { _all: true } }),
    prisma.aIDecision.groupBy({ where, by: ['outcome'], _count: { _all: true } }),
  ]);

  return {
    total,
    byDomain: Object.fromEntries(byDomain.map((d) => [d.domain, d._count._all])),
    byUrgency: Object.fromEntries(byUrgency.map((u) => [u.urgency, u._count._all])),
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    byOutcome: Object.fromEntries(byOutcome.map((o) => [o.outcome, o._count._all])),
  };
}

export async function getDecision(actor: AIActor, id: string): Promise<AIDecision> {
  const decision = await prisma.aIDecision.findUnique({
    where: { id },
    include: { feedbacks: { orderBy: { createdAt: 'desc' } } },
  });
  if (!decision) throw new NotFoundError('Decision not found');

  if (!actor.scope.isPlatformAdmin) {
    const inScope =
      (decision.clubId && decision.clubId === actor.scope.clubId) ||
      (decision.investorId && decision.investorId === actor.scope.investorId) ||
      (decision.franchiseUnitId && actor.scope.franchiseUnitIds.has(decision.franchiseUnitId)) ||
      (decision.entityId && actor.scope.entityIds.has(decision.entityId));
    if (!inScope) throw new NotFoundError('Decision not found');
  }

  return decision;
}

export async function expireStaleDecisions(): Promise<{ expired: number }> {
  const now = new Date();
  const result = await prisma.aIDecision.updateMany({
    where: {
      status: { in: ['GENERATED', 'REVIEWED'] },
      expiresAt: { lt: now, not: null },
    },
    data: { status: 'EXPIRED' },
  });
  return { expired: result.count };
}
