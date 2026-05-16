// Familista — Franchise Expansion Engine
// File location: src/services/franchise-revenue.service.ts
//
// Revenue distribution engine:
//  - Split rules per FranchiseUnit (category-aware, priority-ordered)
//  - Rule selection: exact category > ALL fallback, both active and in window
//  - Distribution computation: per-recipient amounts with deterministic rounding
//    (any rounding remainder is absorbed by the largest allocation)
//  - Execution dispatch to the pluggable payout adapter
//  - Reversal with audit trail
//
// External integration: your existing Stripe webhook calls
//   await computeAndRecordDistribution({ unitId, category, sourceAmount, ... })
// whenever a club payment is received.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  RevenueSplitRule,
  RevenueDistribution,
  RevenueDistributionAllocation,
  RevenueCategory,
  RevenueRecipientType,
} from '@prisma/client';

type RevenueSplitRuleWithRecipients = Prisma.RevenueSplitRuleGetPayload<{ include: { recipients: true } }>;
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import { dispatchPayout } from './franchise-payout.adapter';
import type {
  UpsertRevenueSplitRuleInput,
  RecordDistributionInput,
  ReverseDistributionInput,
  DistributionQueryInput,
} from '../utils/franchise.validators';
import type { FranchiseActor, DistributionPreview, DistributionInput } from '../types/franchise.types';

const TOLERANCE = 0.01;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Split rule CRUD (rule + recipients managed as one atomic shape)
// ─────────────────────────────────────────────────────────────────────────────

export async function listSplitRules(opts: {
  unitId?: string;
  activeOnly?: boolean;
  category?: RevenueCategory;
  scopeUnitIds?: Set<string>;
}) {
  return await prisma.revenueSplitRule.findMany({
    where: {
      ...(opts.unitId ? { unitId: opts.unitId } : {}),
      ...(opts.activeOnly !== false ? { isActive: true } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.scopeUnitIds ? { unitId: { in: Array.from(opts.scopeUnitIds) } } : {}),
    },
    include: { recipients: true, _count: { select: { distributions: true } } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getSplitRule(id: string) {
  const rule = await prisma.revenueSplitRule.findUnique({
    where: { id },
    include: { recipients: true, unit: { select: { id: true, code: true, name: true } } },
  });
  if (!rule) throw new NotFoundError('Split rule not found');
  return rule;
}

export async function createSplitRule(
  actor: FranchiseActor,
  unitId: string,
  input: UpsertRevenueSplitRuleInput,
): Promise<RevenueSplitRule> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');

  const created = await prisma.$transaction(async (tx) => {
    const rule = await tx.revenueSplitRule.create({
      data: {
        unitId,
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? 'ALL',
        trigger: input.trigger ?? 'PAYMENT_RECEIVED',
        priority: input.priority ?? 0,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        isActive: input.isActive ?? true,
        createdBy: actor.userId,
      },
    });
    await tx.revenueSplitRecipient.createMany({
      data: input.recipients.map((r) => ({
        ruleId: rule.id,
        type: r.type,
        recipientUnitId: r.recipientUnitId ?? null,
        recipientOwnerId: r.recipientOwnerId ?? null,
        recipientLabel: r.recipientLabel ?? null,
        percent: r.percent,
      })),
    });
    return rule;
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'SPLIT_RULE_CREATED',
    category: 'REVENUE',
    resourceType: 'RevenueSplitRule',
    resourceId: created.id,
    metadata: { name: created.name, category: created.category, recipients: input.recipients.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateSplitRule(
  actor: FranchiseActor,
  id: string,
  input: UpsertRevenueSplitRuleInput,
): Promise<RevenueSplitRule> {
  const existing = await prisma.revenueSplitRule.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Split rule not found');

  const updated = await prisma.$transaction(async (tx) => {
    const rule = await tx.revenueSplitRule.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? 'ALL',
        trigger: input.trigger ?? 'PAYMENT_RECEIVED',
        priority: input.priority ?? 0,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
        effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo ? new Date(input.effectiveTo) : null,
        isActive: input.isActive,
      },
    });
    // Replace recipients atomically
    await tx.revenueSplitRecipient.deleteMany({ where: { ruleId: id } });
    await tx.revenueSplitRecipient.createMany({
      data: input.recipients.map((r) => ({
        ruleId: rule.id,
        type: r.type,
        recipientUnitId: r.recipientUnitId ?? null,
        recipientOwnerId: r.recipientOwnerId ?? null,
        recipientLabel: r.recipientLabel ?? null,
        percent: r.percent,
      })),
    });
    return rule;
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'SPLIT_RULE_UPDATED',
    category: 'REVENUE',
    resourceType: 'RevenueSplitRule',
    resourceId: id,
    metadata: { name: updated.name, recipients: input.recipients.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function deactivateSplitRule(actor: FranchiseActor, id: string): Promise<RevenueSplitRule> {
  const existing = await prisma.revenueSplitRule.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Split rule not found');
  const updated = await prisma.revenueSplitRule.update({
    where: { id },
    data: { isActive: false, effectiveTo: new Date() },
  });
  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'SPLIT_RULE_DEACTIVATED',
    category: 'REVENUE',
    resourceType: 'RevenueSplitRule',
    resourceId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule resolution + distribution computation
// ─────────────────────────────────────────────────────────────────────────────

async function resolveActiveRule(
  unitId: string,
  category: RevenueCategory,
  at: Date,
): Promise<RevenueSplitRuleWithRecipients | null> {
  const candidates = await prisma.revenueSplitRule.findMany({
    where: {
      unitId,
      isActive: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      AND: [{ OR: [{ category }, { category: 'ALL' }] }],
    },
    include: { recipients: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
  if (candidates.length === 0) return null;
  // Prefer exact category match, then ALL
  const exact = candidates.find((c) => c.category === category);
  return exact ?? candidates[0];
}

function computeAllocations(
  recipients: Array<{
    type: RevenueRecipientType;
    recipientUnitId: string | null;
    recipientOwnerId: string | null;
    recipientLabel: string | null;
    percent: number;
  }>,
  sourceAmount: number,
  currency: string,
): DistributionPreview['allocations'] {
  const raw = recipients.map((r) => ({
    recipientType: r.type,
    recipientUnitId: r.recipientUnitId,
    recipientOwnerId: r.recipientOwnerId,
    recipientLabel: r.recipientLabel,
    percent: r.percent,
    amount: round2((sourceAmount * r.percent) / 100),
  }));

  // Distribute rounding remainder to the largest allocation so the sum equals
  // exactly sourceAmount (within currency precision).
  const sum = raw.reduce((s, a) => s + a.amount, 0);
  const delta = round2(sourceAmount - sum);
  if (Math.abs(delta) > 0 && raw.length > 0) {
    const idx = raw.reduce((maxIdx, a, i) => (a.amount > raw[maxIdx].amount ? i : maxIdx), 0);
    raw[idx] = { ...raw[idx], amount: round2(raw[idx].amount + delta) };
  }

  void currency;
  return raw;
}

export async function previewDistribution(input: DistributionInput): Promise<DistributionPreview> {
  if (input.sourceAmount <= 0) throw new BadRequestError('sourceAmount must be > 0');
  const at = new Date();

  const rule = input.ruleId
    ? await prisma.revenueSplitRule.findUnique({ where: { id: input.ruleId }, include: { recipients: true } })
    : await resolveActiveRule(input.unitId, input.category, at);

  if (!rule || rule.recipients.length === 0) {
    return {
      ruleId: null,
      ruleName: null,
      category: input.category,
      sourceAmount: round2(input.sourceAmount),
      sourceCurrency: input.sourceCurrency ?? 'EUR',
      allocations: [],
      unallocated: round2(input.sourceAmount),
    };
  }

  const allocations = computeAllocations(
    rule.recipients.map((r) => ({
      type: r.type,
      recipientUnitId: r.recipientUnitId,
      recipientOwnerId: r.recipientOwnerId,
      recipientLabel: r.recipientLabel,
      percent: r.percent,
    })),
    input.sourceAmount,
    input.sourceCurrency ?? 'EUR',
  );
  const allocated = allocations.reduce((s, a) => s + a.amount, 0);

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    category: input.category,
    sourceAmount: round2(input.sourceAmount),
    sourceCurrency: input.sourceCurrency ?? 'EUR',
    allocations,
    unallocated: round2(input.sourceAmount - allocated),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute + record (called from Stripe webhook, manual entry, etc.)
// ─────────────────────────────────────────────────────────────────────────────

export async function computeAndRecordDistribution(
  actor: FranchiseActor | null,
  input: RecordDistributionInput,
): Promise<RevenueDistribution & { allocations: RevenueDistributionAllocation[] }> {
  if (input.sourceAmount <= 0) throw new BadRequestError('sourceAmount must be > 0');

  const unit = await prisma.franchiseUnit.findUnique({ where: { id: input.unitId } });
  if (!unit) throw new NotFoundError('Unit not found');

  // Idempotency: if a distribution with this (unitId, sourceRef) already exists, return it.
  if (input.sourceRef) {
    const existing = await prisma.revenueDistribution.findFirst({
      where: { unitId: input.unitId, sourceRef: input.sourceRef },
      include: { allocations: true },
    });
    if (existing) return existing;
  }

  const at = new Date();
  const rule = input.ruleId
    ? await prisma.revenueSplitRule.findUnique({ where: { id: input.ruleId }, include: { recipients: true } })
    : await resolveActiveRule(input.unitId, input.category, at);

  if (!rule || rule.recipients.length === 0) {
    throw new ConflictError(`No active split rule resolved for unit ${input.unitId} / ${input.category}`);
  }

  const allocations = computeAllocations(
    rule.recipients.map((r) => ({
      type: r.type,
      recipientUnitId: r.recipientUnitId,
      recipientOwnerId: r.recipientOwnerId,
      recipientLabel: r.recipientLabel,
      percent: r.percent,
    })),
    input.sourceAmount,
    input.sourceCurrency ?? 'EUR',
  );

  const distribution = await prisma.$transaction(async (tx) => {
    const dist = await tx.revenueDistribution.create({
      data: {
        unitId: input.unitId,
        ruleId: rule.id,
        clubId: input.clubId ?? null,
        category: input.category,
        sourceAmount: round2(input.sourceAmount),
        sourceCurrency: input.sourceCurrency ?? 'EUR',
        sourceFinancialId: input.sourceFinancialId ?? null,
        sourceRef: input.sourceRef ?? null,
        status: 'COMPUTED',
        notes: input.notes ?? null,
      },
    });
    await tx.revenueDistributionAllocation.createMany({
      data: allocations.map((a) => ({
        distributionId: dist.id,
        recipientType: a.recipientType,
        recipientUnitId: a.recipientUnitId,
        recipientOwnerId: a.recipientOwnerId,
        recipientLabel: a.recipientLabel,
        percent: a.percent,
        amount: a.amount,
        currency: input.sourceCurrency ?? 'EUR',
        status: 'PENDING',
      })),
    });
    return await tx.revenueDistribution.findUniqueOrThrow({
      where: { id: dist.id },
      include: { allocations: true },
    });
  });

  await writeFranchiseAudit({
    unitId: input.unitId,
    userId: actor?.userId ?? null,
    action: 'DISTRIBUTION_COMPUTED',
    category: 'REVENUE',
    resourceType: 'RevenueDistribution',
    resourceId: distribution.id,
    metadata: {
      ruleId: rule.id,
      ruleName: rule.name,
      sourceAmount: distribution.sourceAmount,
      sourceCurrency: distribution.sourceCurrency,
      category: input.category,
      allocations: allocations.length,
      sourceRef: input.sourceRef,
    },
    ipAddress: actor?.ipAddress ?? null,
    userAgent: actor?.userAgent ?? null,
  });

  return distribution;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution — dispatch payouts via adapter
// ─────────────────────────────────────────────────────────────────────────────

export async function executeDistribution(
  actor: FranchiseActor,
  distributionId: string,
): Promise<RevenueDistribution & { allocations: RevenueDistributionAllocation[] }> {
  const dist = await prisma.revenueDistribution.findUnique({
    where: { id: distributionId },
    include: { allocations: true },
  });
  if (!dist) throw new NotFoundError('Distribution not found');
  if (!['COMPUTED', 'FAILED'].includes(dist.status)) {
    throw new BadRequestError(`Cannot execute distribution in status ${dist.status}`);
  }

  await prisma.revenueDistribution.update({
    where: { id: distributionId },
    data: { status: 'EXECUTING' },
  });

  let anyFailure = false;
  for (const alloc of dist.allocations) {
    if (alloc.status === 'PAID' || alloc.status === 'CANCELLED') continue;
    try {
      const result = await dispatchPayout({
        allocationId: alloc.id,
        distributionId: dist.id,
        recipientType: alloc.recipientType,
        recipientUnitId: alloc.recipientUnitId,
        recipientOwnerId: alloc.recipientOwnerId,
        recipientLabel: alloc.recipientLabel,
        amount: alloc.amount,
        currency: alloc.currency,
      });
      await prisma.revenueDistributionAllocation.update({
        where: { id: alloc.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paymentMethod: result.method,
          paymentRef: result.ref ?? null,
        },
      });
    } catch (err) {
      anyFailure = true;
      await prisma.revenueDistributionAllocation.update({
        where: { id: alloc.id },
        data: { status: 'FAILED', failureReason: (err as Error).message.slice(0, 500) },
      });
    }
  }

  const final = await prisma.revenueDistribution.update({
    where: { id: distributionId },
    data: { status: anyFailure ? 'FAILED' : 'EXECUTED', executedAt: anyFailure ? undefined : new Date() },
    include: { allocations: true },
  });

  await writeFranchiseAudit({
    unitId: dist.unitId,
    userId: actor.userId,
    action: anyFailure ? 'DISTRIBUTION_EXECUTION_FAILED' : 'DISTRIBUTION_EXECUTED',
    category: 'REVENUE',
    resourceType: 'RevenueDistribution',
    resourceId: distributionId,
    metadata: { allocations: dist.allocations.length, anyFailure },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: anyFailure ? 'FAILURE' : 'SUCCESS',
  });

  return final;
}

export async function reverseDistribution(
  actor: FranchiseActor,
  distributionId: string,
  input: ReverseDistributionInput,
): Promise<RevenueDistribution> {
  const dist = await prisma.revenueDistribution.findUnique({
    where: { id: distributionId },
    include: { allocations: true },
  });
  if (!dist) throw new NotFoundError('Distribution not found');
  if (dist.status === 'REVERSED') throw new BadRequestError('Already reversed');

  await prisma.$transaction(async (tx) => {
    for (const alloc of dist.allocations) {
      if (alloc.status === 'PAID') {
        // Mark as cancelled — the adapter is responsible for any payment-side reversal
        await tx.revenueDistributionAllocation.update({
          where: { id: alloc.id },
          data: { status: 'CANCELLED' },
        });
      }
    }
    await tx.revenueDistribution.update({
      where: { id: distributionId },
      data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: input.reason },
    });
  });

  await writeFranchiseAudit({
    unitId: dist.unitId,
    userId: actor.userId,
    action: 'DISTRIBUTION_REVERSED',
    category: 'REVENUE',
    resourceType: 'RevenueDistribution',
    resourceId: distributionId,
    metadata: { reason: input.reason, sourceAmount: dist.sourceAmount },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return await prisma.revenueDistribution.findUniqueOrThrow({ where: { id: distributionId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export async function searchDistributions(q: DistributionQueryInput, scopeUnitIds?: Set<string>) {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where: Prisma.RevenueDistributionWhereInput = {
    ...(q.unitId ? { unitId: q.unitId } : {}),
    ...(q.clubId ? { clubId: q.clubId } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.from || q.to
      ? {
          computedAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        }
      : {}),
    ...(scopeUnitIds ? { unitId: { in: Array.from(scopeUnitIds) } } : {}),
  };

  const items = await prisma.revenueDistribution.findMany({
    where,
    include: { allocations: true, rule: { select: { id: true, name: true } } },
    orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getDistribution(id: string) {
  const dist = await prisma.revenueDistribution.findUnique({
    where: { id },
    include: {
      allocations: true,
      rule: { include: { recipients: true } },
      unit: { select: { id: true, code: true, name: true, level: true } },
      club: { select: { id: true, name: true } },
    },
  });
  if (!dist) throw new NotFoundError('Distribution not found');
  return dist;
}

export async function getUnitRevenueSummary(unitId: string, from: Date, to: Date) {
  const distributions = await prisma.revenueDistribution.findMany({
    where: {
      unitId,
      computedAt: { gte: from, lte: to },
      status: { in: ['COMPUTED', 'EXECUTED'] },
    },
    select: { sourceAmount: true, category: true, sourceCurrency: true },
  });

  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const d of distributions) {
    total += d.sourceAmount;
    byCategory[d.category] = round2((byCategory[d.category] ?? 0) + d.sourceAmount);
  }

  return {
    unitId,
    from,
    to,
    total: round2(total),
    byCategory,
    distributionCount: distributions.length,
  };
}

void TOLERANCE;
