// Familista — Global Investor Layer
// File location: src/services/investor-distribution.service.ts
//
// Investor cash distributions: revenue-share accruals, dividends, interest,
// exit proceeds, return-of-capital. Reuses the franchise payout adapter so
// outbound money movement is consistent across the platform.
//
// Integration: your Stripe webhook (or any revenue event source) calls
// `computeRevenueShareAccruals` after each successful payment so that any
// active REVENUE_SHARE investments in the affected entity get their share.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  InvestorDistribution,
  InvestorDistributionStatus,
  InvestorDistributionType,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import { dispatchPayout } from './franchise-payout.adapter';
import type {
  RecordInvestorDistributionInput,
  ComputeRevenueShareInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual distribution recording
// ─────────────────────────────────────────────────────────────────────────────

export async function recordDistribution(
  actor: InvestorActor,
  input: RecordInvestorDistributionInput,
): Promise<InvestorDistribution> {
  const investor = await prisma.investorProfile.findUnique({ where: { id: input.investorId } });
  if (!investor) throw new NotFoundError('Investor not found');

  if (input.investmentId) {
    const inv = await prisma.investment.findUnique({ where: { id: input.investmentId } });
    if (!inv) throw new NotFoundError('Investment not found');
    if (inv.investorId !== input.investorId) {
      throw new BadRequestError('Investment does not belong to that investor');
    }
  }

  if (input.sourceRef) {
    const existing = await prisma.investorDistribution.findFirst({
      where: { investorId: input.investorId, sourceRef: input.sourceRef, type: input.type },
    });
    if (existing) return existing;
  }

  const created = await prisma.investorDistribution.create({
    data: {
      investorId: input.investorId,
      investmentId: input.investmentId ?? null,
      type: input.type,
      status: 'COMPUTED',
      period: input.period ?? null,
      periodStartAt: input.periodStartAt ? new Date(input.periodStartAt) : null,
      periodEndAt: input.periodEndAt ? new Date(input.periodEndAt) : null,
      amount: round2(input.amount),
      currency: input.currency ?? 'EUR',
      sourceRef: input.sourceRef ?? null,
      notes: input.notes ?? null,
    },
  });

  await writeInvestorAudit({
    investorId: input.investorId,
    userId: actor.userId,
    action: 'DISTRIBUTION_RECORDED',
    category: 'DISTRIBUTION',
    resourceType: 'InvestorDistribution',
    resourceId: created.id,
    metadata: {
      type: created.type,
      amount: created.amount,
      currency: created.currency,
      sourceRef: created.sourceRef,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue-share fan-out — called from Stripe webhook or franchise revenue
// ─────────────────────────────────────────────────────────────────────────────

export async function computeRevenueShareAccruals(
  actor: InvestorActor | null,
  input: ComputeRevenueShareInput,
): Promise<{ created: number; totalAccrued: number; currency: string }> {
  if (input.sourceAmount <= 0) throw new BadRequestError('sourceAmount must be > 0');

  const entity = await prisma.investmentEntity.findUnique({ where: { id: input.entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  // Active REVENUE_SHARE investments at this entity that aren't capped out and
  // haven't expired. We compute per-investment, even if multiple investors
  // share one entity — each gets their own InvestorDistribution row.
  const now = new Date();
  const active = await prisma.investment.findMany({
    where: {
      entityId: input.entityId,
      instrumentType: 'REVENUE_SHARE',
      status: { in: ['FUNDED'] },
      revenueSharePercent: { gt: 0 },
      OR: [{ revenueShareUntil: null }, { revenueShareUntil: { gt: now } }],
    },
  });

  if (active.length === 0) {
    return { created: 0, totalAccrued: 0, currency: input.currency ?? entity.currency };
  }

  // Idempotency: if any row already exists for this (entityId, sourceRef),
  // we treat the event as already processed.
  if (input.sourceRef) {
    const dup = await prisma.investorDistribution.findFirst({
      where: { sourceRef: input.sourceRef, type: 'REVENUE_SHARE' },
    });
    if (dup) {
      return { created: 0, totalAccrued: 0, currency: input.currency ?? entity.currency };
    }
  }

  let created = 0;
  let totalAccrued = 0;

  for (const inv of active) {
    // Category filter — if revenueCategories is non-empty, only certain
    // categories trigger payout
    if (inv.revenueCategories.length > 0 && !inv.revenueCategories.includes(input.category)) {
      continue;
    }

    const grossAccrual = round2((input.sourceAmount * (inv.revenueSharePercent ?? 0)) / 100);
    if (grossAccrual <= 0) continue;

    // Apply cap: total cumulative payouts for this investment must not exceed cap
    let amount = grossAccrual;
    if (inv.revenueShareCap != null) {
      const priorSum = await prisma.investorDistribution.aggregate({
        where: { investmentId: inv.id, type: 'REVENUE_SHARE', status: { not: 'REVERSED' } },
        _sum: { amount: true },
      });
      const priorTotal = priorSum._sum.amount ?? 0;
      const headroom = Math.max(0, inv.revenueShareCap - priorTotal);
      amount = Math.min(amount, headroom);
      if (amount <= 0) continue;
    }

    await prisma.investorDistribution.create({
      data: {
        investorId: inv.investorId,
        investmentId: inv.id,
        type: 'REVENUE_SHARE',
        status: 'COMPUTED',
        period: input.period ?? null,
        periodStartAt: input.periodStartAt ? new Date(input.periodStartAt) : null,
        periodEndAt: input.periodEndAt ? new Date(input.periodEndAt) : null,
        amount: round2(amount),
        currency: input.currency ?? entity.currency,
        sourceRef: input.sourceRef ?? null,
        notes: `Revenue share accrual: ${input.category} @ ${inv.revenueSharePercent}%`,
      },
    });
    created++;
    totalAccrued += amount;
  }

  if (created > 0) {
    await writeInvestorAudit({
      entityId: input.entityId,
      userId: actor?.userId ?? null,
      action: 'REVENUE_SHARE_ACCRUED',
      category: 'DISTRIBUTION',
      metadata: {
        sourceAmount: input.sourceAmount,
        currency: input.currency,
        category: input.category,
        sourceRef: input.sourceRef,
        accrualCount: created,
        totalAccrued: round2(totalAccrued),
      },
      ipAddress: actor?.ipAddress ?? null,
      userAgent: actor?.userAgent ?? null,
    });
  }

  return { created, totalAccrued: round2(totalAccrued), currency: input.currency ?? entity.currency };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout execution
// ─────────────────────────────────────────────────────────────────────────────

export async function payDistribution(
  actor: InvestorActor,
  id: string,
): Promise<InvestorDistribution> {
  const dist = await prisma.investorDistribution.findUnique({ where: { id } });
  if (!dist) throw new NotFoundError('Distribution not found');
  if (dist.status !== 'COMPUTED' && dist.status !== 'FAILED' && dist.status !== 'PENDING') {
    throw new BadRequestError(`Cannot pay distribution in status ${dist.status}`);
  }

  try {
    const result = await dispatchPayout({
      allocationId: dist.id,
      distributionId: dist.id,
      recipientType: 'INVESTOR',
      recipientUnitId: null,
      recipientOwnerId: null,
      recipientLabel: dist.investorId,
      amount: dist.amount,
      currency: dist.currency,
    });

    const updated = await prisma.investorDistribution.update({
      where: { id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paymentMethod: result.method,
        paymentRef: result.ref ?? null,
      },
    });

    await writeInvestorAudit({
      investorId: dist.investorId,
      userId: actor.userId,
      action: 'DISTRIBUTION_PAID',
      category: 'DISTRIBUTION',
      resourceType: 'InvestorDistribution',
      resourceId: id,
      metadata: { amount: dist.amount, currency: dist.currency, paymentRef: result.ref },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  } catch (err) {
    const reason = (err as Error).message.slice(0, 500);
    const failed = await prisma.investorDistribution.update({
      where: { id },
      data: { status: 'FAILED', failureReason: reason },
    });

    await writeInvestorAudit({
      investorId: dist.investorId,
      userId: actor.userId,
      action: 'DISTRIBUTION_PAYMENT_FAILED',
      category: 'DISTRIBUTION',
      resourceType: 'InvestorDistribution',
      resourceId: id,
      metadata: { reason },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      result: 'FAILURE',
    });

    return failed;
  }
}

export async function reverseDistribution(
  actor: InvestorActor,
  id: string,
  reason: string,
): Promise<InvestorDistribution> {
  const dist = await prisma.investorDistribution.findUnique({ where: { id } });
  if (!dist) throw new NotFoundError('Distribution not found');
  if (dist.status === 'REVERSED') throw new BadRequestError('Already reversed');

  const updated = await prisma.investorDistribution.update({
    where: { id },
    data: { status: 'REVERSED', notes: reason },
  });

  await writeInvestorAudit({
    investorId: dist.investorId,
    userId: actor.userId,
    action: 'DISTRIBUTION_REVERSED',
    category: 'DISTRIBUTION',
    resourceType: 'InvestorDistribution',
    resourceId: id,
    metadata: { reason, amount: dist.amount },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listDistributions(opts: {
  investorId?: string;
  investmentId?: string;
  type?: InvestorDistributionType;
  status?: InvestorDistributionStatus;
  from?: Date;
  to?: Date;
  scopeInvestorId?: string | null;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: Prisma.InvestorDistributionWhereInput = {
    ...(opts.investorId ? { investorId: opts.investorId } : {}),
    ...(opts.investmentId ? { investmentId: opts.investmentId } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.from || opts.to
      ? {
          computedAt: {
            ...(opts.from ? { gte: opts.from } : {}),
            ...(opts.to ? { lte: opts.to } : {}),
          },
        }
      : {}),
  };
  if (opts.scopeInvestorId !== undefined && opts.scopeInvestorId !== null) {
    where.investorId = opts.scopeInvestorId;
  }

  const items = await prisma.investorDistribution.findMany({
    where,
    include: {
      investor: { select: { id: true, displayName: true, type: true } },
      investment: { select: { id: true, instrumentType: true, entityId: true } },
    },
    orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}
