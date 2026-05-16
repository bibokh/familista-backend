// Familista — Global Investor Layer
// File location: src/services/investor-investment.service.ts
//
// Investment lifecycle: commit → fund (writes CapTableEntry for EQUITY), convert
// SAFE/note to equity at a priced round, cancel/refund. Instrument-specific
// invariants are enforced before any state change.
//
// SAFE conversion formula (per investment):
//   safePrice = MIN(valuationCap / fullyDilutedShares, roundPrice * (1 - discount))
//   sharesIssued = fundedAmount / safePrice  (rounded down to nearest integer)

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  Investment,
  InstrumentType,
  InvestmentStatus,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  CreateInvestmentInput,
  FundInvestmentInput,
  CancelInvestmentInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

const STATUS_TRANSITIONS: Record<InvestmentStatus, ReadonlyArray<InvestmentStatus>> = {
  COMMITTED: ['FUNDED', 'CANCELLED', 'DEFAULTED'],
  FUNDED:    ['CONVERTED', 'EXITED', 'CANCELLED'],
  CONVERTED: ['EXITED'],
  EXITED:    [],
  CANCELLED: [],
  DEFAULTED: ['CANCELLED'],
};

function assertStatusTransition(from: InvestmentStatus, to: InvestmentStatus): void {
  if (from === to) return;
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Investment status transition ${from} → ${to} not allowed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

export async function createInvestment(
  actor: InvestorActor,
  input: CreateInvestmentInput,
): Promise<Investment> {
  const [investor, entity, round, shareClass] = await Promise.all([
    prisma.investorProfile.findUnique({ where: { id: input.investorId } }),
    prisma.investmentEntity.findUnique({ where: { id: input.entityId } }),
    input.roundId ? prisma.investmentRound.findUnique({ where: { id: input.roundId } }) : Promise.resolve(null),
    input.shareClassId ? prisma.shareClass.findUnique({ where: { id: input.shareClassId } }) : Promise.resolve(null),
  ]);
  if (!investor) throw new NotFoundError('Investor not found');
  if (!investor.isActive) throw new BadRequestError('Investor profile is inactive');
  if (!entity) throw new NotFoundError('Entity not found');
  if (!entity.isActive) throw new BadRequestError('Entity is inactive');

  if (input.roundId) {
    if (!round) throw new NotFoundError('Round not found');
    if (round.entityId !== input.entityId) throw new BadRequestError('Round belongs to a different entity');
    if (round.status !== 'OPEN') throw new BadRequestError(`Round is ${round.status}, not OPEN`);
  }

  if (input.instrumentType === 'EQUITY') {
    if (!shareClass) throw new BadRequestError('shareClassId required for EQUITY');
    if (shareClass.entityId !== input.entityId) {
      throw new BadRequestError('Share class belongs to a different entity');
    }
    if (input.sharesIssued != null && input.pricePerShare != null) {
      const expected = input.sharesIssued * input.pricePerShare;
      if (Math.abs(expected - input.committedAmount) > Math.max(1, input.committedAmount * 0.001)) {
        throw new BadRequestError(
          `committedAmount (${input.committedAmount}) must equal sharesIssued × pricePerShare (${expected})`,
        );
      }
    }
  }

  if (input.instrumentType === 'SAFE' && !input.valuationCap && !input.discountPercent) {
    throw new BadRequestError('SAFE requires valuationCap and/or discountPercent');
  }
  if (input.instrumentType === 'CONVERTIBLE_NOTE') {
    if (input.interestRate == null) throw new BadRequestError('Convertible note requires interestRate');
  }
  if (input.instrumentType === 'REVENUE_SHARE' && (input.revenueSharePercent == null || input.revenueSharePercent <= 0)) {
    throw new BadRequestError('Revenue-share requires revenueSharePercent > 0');
  }

  const created = await prisma.investment.create({
    data: {
      investorId: input.investorId,
      entityId: input.entityId,
      roundId: input.roundId ?? null,
      instrumentType: input.instrumentType,
      status: 'COMMITTED',
      committedAmount: input.committedAmount,
      currency: input.currency ?? entity.currency,
      shareClassId: input.shareClassId ?? null,
      sharesIssued: input.sharesIssued ?? null,
      pricePerShare: input.pricePerShare ?? null,
      valuationCap: input.valuationCap ?? null,
      discountPercent: input.discountPercent ?? null,
      mostFavoredNation: input.mostFavoredNation ?? false,
      interestRate: input.interestRate ?? null,
      maturityDate: input.maturityDate ? new Date(input.maturityDate) : null,
      revenueSharePercent: input.revenueSharePercent ?? null,
      revenueShareCap: input.revenueShareCap ?? null,
      revenueShareUntil: input.revenueShareUntil ? new Date(input.revenueShareUntil) : null,
      revenueCategories: input.revenueCategories ?? [],
      linkedFranchiseUnitId: input.linkedFranchiseUnitId ?? null,
      linkedClubId: input.linkedClubId ?? null,
      notes: input.notes ?? null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeInvestorAudit({
    investorId: input.investorId,
    entityId: input.entityId,
    userId: actor.userId,
    action: 'INVESTMENT_COMMITTED',
    category: 'INVESTMENT',
    resourceType: 'Investment',
    resourceId: created.id,
    metadata: {
      instrumentType: created.instrumentType,
      committedAmount: created.committedAmount,
      currency: created.currency,
      roundId: created.roundId,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fund — money lands; EQUITY writes captable, SAFE/note stays as-is.
// ─────────────────────────────────────────────────────────────────────────────

export async function fundInvestment(
  actor: InvestorActor,
  id: string,
  input: FundInvestmentInput,
): Promise<Investment> {
  return await prisma.$transaction(async (tx) => {
    const inv = await tx.investment.findUnique({
      where: { id },
      include: { shareClass: true, round: true, entity: true },
    });
    if (!inv) throw new NotFoundError('Investment not found');

    if (inv.status === 'FUNDED') {
      const newFunded = inv.fundedAmount + input.amount;
      if (newFunded > inv.committedAmount + 0.01) {
        throw new BadRequestError(
          `funded ${newFunded} would exceed committed ${inv.committedAmount}`,
        );
      }
    } else {
      assertStatusTransition(inv.status, 'FUNDED');
    }

    const totalFunded = (inv.fundedAmount ?? 0) + input.amount;
    const isFullyFunded = totalFunded + 0.01 >= inv.committedAmount;

    // EQUITY: write the cap-table entry once funding completes
    if (inv.instrumentType === 'EQUITY' && isFullyFunded && inv.shareClassId && inv.sharesIssued != null) {
      const sc = inv.shareClass;
      if (!sc) throw new BadRequestError('Share class missing');

      if (sc.totalIssued + inv.sharesIssued > sc.totalAuthorized && sc.totalAuthorized > 0) {
        throw new ConflictError(
          `Share class "${sc.code}" has ${sc.totalAuthorized - sc.totalIssued} unissued shares; need ${inv.sharesIssued}`,
        );
      }

      await tx.capTableEntry.create({
        data: {
          entityId: inv.entityId,
          investorId: inv.investorId,
          shareClassId: inv.shareClassId,
          shares: inv.sharesIssued,
          pricePerShare: inv.pricePerShare,
          totalCost: inv.pricePerShare != null ? inv.sharesIssued * inv.pricePerShare : inv.committedAmount,
          currency: inv.currency,
          acquisitionType: inv.roundId ? 'ROUND_PURCHASE' : 'FOUNDING',
          originalInvestmentId: inv.id,
        },
      });

      await tx.shareClass.update({
        where: { id: inv.shareClassId },
        data: { totalIssued: { increment: inv.sharesIssued } },
      });

      await tx.investmentEntity.update({
        where: { id: inv.entityId },
        data: {
          totalSharesIssued: { increment: inv.sharesIssued },
          fullyDilutedShares: { increment: inv.sharesIssued },
        },
      });
    }

    if (inv.roundId) {
      await tx.investmentRound.update({
        where: { id: inv.roundId },
        data: {
          actualRaise: { increment: input.amount },
          ...(inv.sharesIssued && isFullyFunded ? { sharesIssued: { increment: inv.sharesIssued } } : {}),
        },
      });
    }

    return await tx.investment.update({
      where: { id },
      data: {
        fundedAmount: totalFunded,
        status: isFullyFunded ? 'FUNDED' : inv.status,
        fundedDate: isFullyFunded ? (input.fundedDate ? new Date(input.fundedDate) : new Date()) : inv.fundedDate,
      },
    });
  }).then(async (updated) => {
    await writeInvestorAudit({
      investorId: updated.investorId,
      entityId: updated.entityId,
      userId: actor.userId,
      action: 'INVESTMENT_FUNDED',
      category: 'INVESTMENT',
      resourceType: 'Investment',
      resourceId: updated.id,
      metadata: {
        amount: input.amount,
        totalFunded: updated.fundedAmount,
        status: updated.status,
        paymentRef: input.paymentRef,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return updated;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE / convertible conversion
// ─────────────────────────────────────────────────────────────────────────────

export async function convertOutstandingSafes(
  actor: InvestorActor,
  roundId: string,
): Promise<{ converted: number; newInvestments: string[] }> {
  return await prisma.$transaction(async (tx) => {
    const round = await tx.investmentRound.findUnique({
      where: { id: roundId },
      include: { shareClass: true, entity: true },
    });
    if (!round) throw new NotFoundError('Round not found');
    if (round.status !== 'OPEN' && round.status !== 'CLOSED') {
      throw new BadRequestError(`Round must be OPEN or CLOSED to convert SAFEs (current: ${round.status})`);
    }
    if (!round.shareClassId || !round.pricePerShare || round.pricePerShare <= 0) {
      throw new BadRequestError('Round needs a shareClass and pricePerShare to convert SAFEs');
    }

    const targetShareClassId = round.shareClassId;
    const roundPrice = round.pricePerShare;
    const fdShares = Math.max(round.entity.fullyDilutedShares, round.entity.totalSharesIssued, 1);

    const outstanding = await tx.investment.findMany({
      where: {
        entityId: round.entityId,
        instrumentType: { in: ['SAFE', 'CONVERTIBLE_NOTE'] },
        status: 'FUNDED',
        convertedToInvestmentId: null,
      },
      include: { shareClass: true },
    });

    const newInvestmentIds: string[] = [];
    for (const safe of outstanding) {
      const capPrice = safe.valuationCap != null && fdShares > 0 ? safe.valuationCap / fdShares : Infinity;
      const discountPrice = safe.discountPercent != null
        ? roundPrice * (1 - safe.discountPercent / 100)
        : roundPrice;
      const safePrice = Math.min(capPrice, discountPrice, roundPrice);

      if (!Number.isFinite(safePrice) || safePrice <= 0) continue;

      const shares = Math.floor(safe.fundedAmount / safePrice);
      if (shares <= 0) continue;

      const newInvestment = await tx.investment.create({
        data: {
          investorId: safe.investorId,
          entityId: safe.entityId,
          roundId: round.id,
          instrumentType: 'EQUITY',
          status: 'FUNDED',
          committedAmount: safe.fundedAmount,
          fundedAmount: safe.fundedAmount,
          currency: safe.currency,
          shareClassId: targetShareClassId,
          sharesIssued: shares,
          pricePerShare: safePrice,
          originalInvestmentId: safe.id,
          commitDate: safe.commitDate,
          fundedDate: new Date(),
          notes: `Converted from ${safe.instrumentType} ${safe.id}`,
        },
      });
      newInvestmentIds.push(newInvestment.id);

      await tx.investment.update({
        where: { id: safe.id },
        data: {
          status: 'CONVERTED',
          convertedDate: new Date(),
          convertedToInvestmentId: newInvestment.id,
        },
      });

      await tx.capTableEntry.create({
        data: {
          entityId: safe.entityId,
          investorId: safe.investorId,
          shareClassId: targetShareClassId,
          shares,
          pricePerShare: safePrice,
          totalCost: safe.fundedAmount,
          currency: safe.currency,
          acquisitionType: 'CONVERSION',
          originalInvestmentId: newInvestment.id,
          notes: `Converted from ${safe.instrumentType} at ${safePrice}/share`,
        },
      });

      await tx.shareClass.update({
        where: { id: targetShareClassId },
        data: { totalIssued: { increment: shares } },
      });

      await tx.investmentEntity.update({
        where: { id: safe.entityId },
        data: {
          totalSharesIssued: { increment: shares },
          fullyDilutedShares: { increment: shares },
        },
      });
    }

    return { converted: newInvestmentIds.length, newInvestments: newInvestmentIds };
  }).then(async (result) => {
    if (result.converted > 0) {
      await writeInvestorAudit({
        userId: actor.userId,
        action: 'SAFES_CONVERTED',
        category: 'INVESTMENT',
        metadata: { roundId, converted: result.converted, newInvestmentIds: result.newInvestments },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
    }
    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelInvestment(
  actor: InvestorActor,
  id: string,
  input: CancelInvestmentInput,
): Promise<Investment> {
  const existing = await prisma.investment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Investment not found');
  if (existing.status === 'CANCELLED' || existing.status === 'EXITED' || existing.status === 'CONVERTED') {
    throw new BadRequestError(`Cannot cancel investment in status ${existing.status}`);
  }

  // FUNDED EQUITY investments shouldn't be silently cancelled — operator must
  // route through ShareTransfer or repurchase. Block here to surface the case.
  if (existing.status === 'FUNDED' && existing.instrumentType === 'EQUITY') {
    throw new BadRequestError('Funded EQUITY cannot be cancelled — use a ShareTransfer/repurchase flow');
  }

  const updated = await prisma.investment.update({
    where: { id },
    data: { status: 'CANCELLED', notes: input.reason },
  });

  await writeInvestorAudit({
    investorId: existing.investorId,
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'INVESTMENT_CANCELLED',
    category: 'INVESTMENT',
    resourceType: 'Investment',
    resourceId: id,
    metadata: { reason: input.reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export async function listInvestments(opts: {
  investorId?: string;
  entityId?: string;
  roundId?: string;
  instrumentType?: InstrumentType;
  status?: InvestmentStatus;
  scopeInvestorId?: string | null;
  scopeEntityIds?: Set<string>;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: Prisma.InvestmentWhereInput = {
    ...(opts.investorId ? { investorId: opts.investorId } : {}),
    ...(opts.entityId ? { entityId: opts.entityId } : {}),
    ...(opts.roundId ? { roundId: opts.roundId } : {}),
    ...(opts.instrumentType ? { instrumentType: opts.instrumentType } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  };

  if (opts.scopeInvestorId !== undefined && opts.scopeInvestorId !== null) {
    // Investor-side scope: own investments OR investments in entities they have positions in
    const ors: Prisma.InvestmentWhereInput[] = [{ investorId: opts.scopeInvestorId }];
    if (opts.scopeEntityIds && opts.scopeEntityIds.size > 0) {
      ors.push({ entityId: { in: Array.from(opts.scopeEntityIds) } });
    }
    where.AND = [{ OR: ors }];
  }

  const items = await prisma.investment.findMany({
    where,
    include: {
      investor: { select: { id: true, displayName: true, type: true } },
      entity: { select: { id: true, name: true, type: true } },
      round: { select: { id: true, name: true, type: true } },
      shareClass: { select: { id: true, name: true, code: true } },
    },
    orderBy: [{ commitDate: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getInvestment(id: string) {
  const inv = await prisma.investment.findUnique({
    where: { id },
    include: {
      investor: true,
      entity: true,
      round: true,
      shareClass: true,
      capTableEntries: true,
      agreements: { orderBy: { createdAt: 'desc' } },
      distributions: { orderBy: { computedAt: 'desc' }, take: 50 },
    },
  });
  if (!inv) throw new NotFoundError('Investment not found');
  return inv;
}
