// Familista — Global Investor Layer
// File location: src/services/investor-exit.service.ts
//
// Exit events + liquidation waterfall. Walks the share-class seniority stack:
//   1. Pay liquidation preference top-down (highest seniority first).
//   2. For PARTICIPATING preferred, also include their pro-rata share of the
//      remaining pool (subject to participationCap if set).
//   3. Distribute the residual pro-rata across COMMON (and participating
//      preferred above their cap is settled in step 2).
//
// The result is computed in-memory first (waterfall preview) so it can be
// reviewed before EXECUTED writes ExitDistribution rows and CapTable closures.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  ExitEvent,
  ExitEventType,
  ExitStatus,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  CreateExitInput,
  DecideExitInput,
} from '../utils/investor.validators';
import type {
  InvestorActor,
  WaterfallAllocation,
  WaterfallResult,
} from '../types/investor.types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const STATUS_TRANSITIONS: Record<ExitStatus, ReadonlyArray<ExitStatus>> = {
  PROPOSED: ['APPROVED', 'CANCELLED'],
  APPROVED: ['EXECUTED', 'CANCELLED'],
  EXECUTED: [],
  CANCELLED: [],
};

function assertTransition(from: ExitStatus, to: ExitStatus): void {
  if (from === to) return;
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Exit status transition ${from} → ${to} not allowed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create + decide
// ─────────────────────────────────────────────────────────────────────────────

export async function createExit(
  actor: InvestorActor,
  entityId: string,
  input: CreateExitInput,
): Promise<ExitEvent> {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  const created = await prisma.exitEvent.create({
    data: {
      entityId,
      type: input.type,
      eventDate: input.eventDate ? new Date(input.eventDate) : null,
      proceedsAmount: input.proceedsAmount ?? null,
      currency: input.currency ?? entity.currency,
      pricePerShare: input.pricePerShare ?? null,
      acquirerName: input.acquirerName ?? null,
      terms:
        input.terms === undefined || input.terms === null
          ? undefined
          : (input.terms as Prisma.InputJsonValue),
      notes: input.notes ?? null,
      status: 'PROPOSED',
      createdBy: actor.userId,
    },
  });

  await writeInvestorAudit({
    entityId,
    userId: actor.userId,
    action: 'EXIT_PROPOSED',
    category: 'EXIT',
    resourceType: 'ExitEvent',
    resourceId: created.id,
    metadata: { type: created.type, proceedsAmount: created.proceedsAmount, currency: created.currency },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function decideExit(
  actor: InvestorActor,
  id: string,
  input: DecideExitInput,
): Promise<ExitEvent> {
  const existing = await prisma.exitEvent.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Exit event not found');

  const target: ExitStatus = input.decision === 'APPROVED' ? 'APPROVED' : 'CANCELLED';
  assertTransition(existing.status, target);

  const updated = await prisma.exitEvent.update({
    where: { id },
    data: {
      status: target,
      approvedBy: target === 'APPROVED' ? actor.userId : existing.approvedBy,
      approvedAt: target === 'APPROVED' ? new Date() : existing.approvedAt,
      cancelledAt: target === 'CANCELLED' ? new Date() : existing.cancelledAt,
      cancelledReason: target === 'CANCELLED' ? input.notes ?? null : existing.cancelledReason,
      notes: input.notes ?? existing.notes,
    },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: target === 'APPROVED' ? 'EXIT_APPROVED' : 'EXIT_CANCELLED',
    category: 'EXIT',
    resourceType: 'ExitEvent',
    resourceId: id,
    metadata: { notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Waterfall computation
// ─────────────────────────────────────────────────────────────────────────────

export async function computeWaterfall(exitId: string): Promise<WaterfallResult> {
  const exit = await prisma.exitEvent.findUnique({
    where: { id: exitId },
    include: { entity: true },
  });
  if (!exit) throw new NotFoundError('Exit event not found');
  if (exit.proceedsAmount == null || exit.proceedsAmount <= 0) {
    throw new BadRequestError('Exit proceedsAmount must be > 0');
  }
  return await runWaterfall(exit.entityId, exit.proceedsAmount, exit.currency, exit.id);
}

export async function previewWaterfall(entityId: string, proceeds: number, currency = 'EUR'): Promise<WaterfallResult> {
  return await runWaterfall(entityId, proceeds, currency, null);
}

async function runWaterfall(
  entityId: string,
  proceedsAmount: number,
  currency: string,
  exitId: string | null,
): Promise<WaterfallResult> {
  const rows = await prisma.capTableEntry.findMany({
    where: { entityId, effectiveTo: null },
    include: {
      investor: { select: { id: true, displayName: true } },
      shareClass: true,
    },
  });

  if (rows.length === 0) {
    return {
      exitId,
      entityId,
      proceedsAmount: round2(proceedsAmount),
      currency,
      totalDistributed: 0,
      remainingProceeds: round2(proceedsAmount),
      allocations: [],
    };
  }

  // Bucket holdings: per (investor, shareClass)
  type Bucket = {
    investorId: string;
    investorName: string;
    shareClassId: string;
    shareClassName: string;
    shareClassSeniority: number;
    shareClassCategory: string;
    liquidationPreference: number;
    participating: boolean;
    participationCap: number | null;
    shares: number;
    totalCost: number;
    liquidationPref: number;
    participation: number;
    common: number;
  };

  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const key = `${r.investorId}:${r.shareClassId}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.shares += r.shares;
      existing.totalCost += r.totalCost ?? 0;
    } else {
      buckets.set(key, {
        investorId: r.investorId,
        investorName: r.investor.displayName,
        shareClassId: r.shareClassId,
        shareClassName: r.shareClass.name,
        shareClassSeniority: r.shareClass.seniority,
        shareClassCategory: r.shareClass.category,
        liquidationPreference: r.shareClass.liquidationPreference ?? 1,
        participating: r.shareClass.participating,
        participationCap: r.shareClass.participationCap,
        shares: r.shares,
        totalCost: r.totalCost ?? 0,
        liquidationPref: 0,
        participation: 0,
        common: 0,
      });
    }
  }

  let remaining = proceedsAmount;

  // Step 1: pay liquidation preference, highest seniority first.
  // PREFERRED classes get totalCost × liquidationPreference; COMMON & FOUNDER get nothing here.
  const sortedBuckets = Array.from(buckets.values()).sort((a, b) => b.shareClassSeniority - a.shareClassSeniority);
  for (const b of sortedBuckets) {
    if (remaining <= 0) break;
    if (b.shareClassCategory === 'PREFERRED' || b.shareClassCategory === 'WARRANT') {
      const pref = b.totalCost * b.liquidationPreference;
      const paid = Math.min(pref, remaining);
      b.liquidationPref = paid;
      remaining -= paid;
    }
  }

  // Step 2 + 3: distribute the residual pro-rata across COMMON + participating PREFERRED
  // (subject to participationCap on the preferred).
  if (remaining > 0) {
    const participators = sortedBuckets.filter(
      (b) => b.shareClassCategory !== 'OPTION_POOL' && (b.shareClassCategory !== 'PREFERRED' || b.participating),
    );
    const totalShares = participators.reduce((s, b) => s + b.shares, 0);
    if (totalShares > 0) {
      // Pass 1: distribute pro-rata, respecting cap on participating preferred
      const proRataPerShare = remaining / totalShares;
      let excess = 0;
      for (const b of participators) {
        const rawShare = b.shares * proRataPerShare;
        if (b.shareClassCategory === 'PREFERRED' && b.participating && b.participationCap != null) {
          const cap = b.totalCost * b.participationCap - b.liquidationPref;
          if (rawShare > cap) {
            b.participation = cap;
            excess += rawShare - cap;
          } else {
            b.participation = rawShare;
          }
        } else if (b.shareClassCategory === 'PREFERRED' && b.participating) {
          b.participation = rawShare;
        } else {
          b.common = rawShare;
        }
      }

      // Pass 2: redistribute excess to non-capped participants
      if (excess > 0) {
        const eligible = participators.filter(
          (b) =>
            b.shareClassCategory === 'COMMON' ||
            b.shareClassCategory === 'FOUNDER' ||
            (b.shareClassCategory === 'PREFERRED' && b.participating && b.participationCap == null),
        );
        const eligibleShares = eligible.reduce((s, b) => s + b.shares, 0);
        if (eligibleShares > 0) {
          for (const b of eligible) {
            const add = excess * (b.shares / eligibleShares);
            if (b.shareClassCategory === 'PREFERRED') b.participation += add;
            else b.common += add;
          }
        }
      }

      remaining = 0;
    }
  }

  const allocations: WaterfallAllocation[] = sortedBuckets.map((b) => ({
    investorId: b.investorId,
    investorName: b.investorName,
    shareClassId: b.shareClassId,
    shareClassName: b.shareClassName,
    shares: b.shares,
    liquidationPrefAmount: round2(b.liquidationPref),
    participationAmount: round2(b.participation),
    commonAmount: round2(b.common),
    totalAmount: round2(b.liquidationPref + b.participation + b.common),
    currency,
  }));

  const distributed = allocations.reduce((s, a) => s + a.totalAmount, 0);

  return {
    exitId,
    entityId,
    proceedsAmount: round2(proceedsAmount),
    currency,
    totalDistributed: round2(distributed),
    remainingProceeds: round2(Math.max(0, proceedsAmount - distributed)),
    allocations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute — persist ExitDistribution rows + close cap-table
// ─────────────────────────────────────────────────────────────────────────────

export async function executeExit(actor: InvestorActor, exitId: string): Promise<ExitEvent> {
  return await prisma.$transaction(async (tx) => {
    const exit = await tx.exitEvent.findUnique({ where: { id: exitId } });
    if (!exit) throw new NotFoundError('Exit event not found');
    if (exit.status !== 'APPROVED') {
      throw new BadRequestError(`Exit must be APPROVED to execute (current: ${exit.status})`);
    }
    if (exit.proceedsAmount == null || exit.proceedsAmount <= 0) {
      throw new BadRequestError('Exit has no proceeds to distribute');
    }

    const waterfall = await runWaterfall(exit.entityId, exit.proceedsAmount, exit.currency, exit.id);

    // Aggregate by investor
    const byInvestor = new Map<string, {
      sharesPaidOut: number;
      liquidationPrefAmount: number;
      participationAmount: number;
      commonAmount: number;
      grossAmount: number;
    }>();
    for (const a of waterfall.allocations) {
      const existing = byInvestor.get(a.investorId) ?? {
        sharesPaidOut: 0,
        liquidationPrefAmount: 0,
        participationAmount: 0,
        commonAmount: 0,
        grossAmount: 0,
      };
      existing.sharesPaidOut += a.shares;
      existing.liquidationPrefAmount += a.liquidationPrefAmount;
      existing.participationAmount += a.participationAmount;
      existing.commonAmount += a.commonAmount;
      existing.grossAmount += a.totalAmount;
      byInvestor.set(a.investorId, existing);
    }

    // For BUYBACK / ACQUISITION / IPO / LIQUIDATION — close all cap-table entries
    const closesPositions =
      exit.type === 'BUYBACK' ||
      exit.type === 'ACQUISITION' ||
      exit.type === 'MERGER' ||
      exit.type === 'IPO' ||
      exit.type === 'LIQUIDATION';

    const now = new Date();

    for (const [investorId, agg] of byInvestor.entries()) {
      await tx.exitDistribution.create({
        data: {
          exitId,
          investorId,
          sharesPaidOut: agg.sharesPaidOut,
          liquidationPrefAmount: round2(agg.liquidationPrefAmount),
          participationAmount: round2(agg.participationAmount),
          commonAmount: round2(agg.commonAmount),
          grossAmount: round2(agg.grossAmount),
          netAmount: round2(agg.grossAmount),
          currency: exit.currency,
          status: 'COMPUTED',
        },
      });
    }

    if (closesPositions) {
      await tx.capTableEntry.updateMany({
        where: { entityId: exit.entityId, effectiveTo: null },
        data: { effectiveTo: now },
      });

      // Mark all active investments as EXITED
      await tx.investment.updateMany({
        where: { entityId: exit.entityId, status: { in: ['FUNDED', 'COMMITTED'] } },
        data: { status: 'EXITED', exitDate: now },
      });
    }

    const updated = await tx.exitEvent.update({
      where: { id: exitId },
      data: { status: 'EXECUTED', executedAt: now, eventDate: exit.eventDate ?? now },
    });

    return updated;
  }).then(async (updated) => {
    await writeInvestorAudit({
      entityId: updated.entityId,
      userId: actor.userId,
      action: 'EXIT_EXECUTED',
      category: 'EXIT',
      resourceType: 'ExitEvent',
      resourceId: updated.id,
      metadata: { type: updated.type, proceedsAmount: updated.proceedsAmount, currency: updated.currency },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return updated;
  });
}

export async function listExitEvents(opts: {
  entityId?: string;
  status?: ExitStatus;
  type?: ExitEventType;
  scopeEntityIds?: Set<string>;
  limit?: number;
}): Promise<ExitEvent[]> {
  return await prisma.exitEvent.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.scopeEntityIds ? { entityId: { in: Array.from(opts.scopeEntityIds) } } : {}),
    },
    orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

export async function getExitEvent(id: string) {
  const exit = await prisma.exitEvent.findUnique({
    where: { id },
    include: {
      distributions: { include: { investor: { select: { id: true, displayName: true } } } },
      entity: true,
    },
  });
  if (!exit) throw new NotFoundError('Exit event not found');
  return exit;
}
