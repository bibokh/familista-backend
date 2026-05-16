// Familista — Global Investor Layer
// File location: src/services/investor-captable.service.ts
//
// Cap table queries (point-in-time positions, voting power, fully-diluted view)
// and the share-transfer state machine. Time-effective rows are the source of
// truth; equity percentages are computed at read time.

import { prisma } from '../lib/prisma';
import type {
  ShareTransfer,
  ShareTransferStatus,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  InitiateShareTransferInput,
  CancelShareTransferInput,
} from '../utils/investor.validators';
import type {
  InvestorActor,
  EntityCapTable,
  CapTablePosition,
  DilutionPreview,
} from '../types/investor.types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Point-in-time cap table
// ─────────────────────────────────────────────────────────────────────────────

export async function getCapTable(entityId: string, asOf?: Date): Promise<EntityCapTable> {
  const at = asOf ?? new Date();
  const entity = await prisma.investmentEntity.findUnique({
    where: { id: entityId },
    include: { shareClasses: true },
  });
  if (!entity) throw new NotFoundError('Entity not found');

  const rows = await prisma.capTableEntry.findMany({
    where: {
      entityId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    include: { investor: true, shareClass: true },
    orderBy: [{ shares: 'desc' }],
  });

  const totalShares = rows.reduce((s, r) => s + r.shares, 0);
  const totalVoting = rows.reduce((s, r) => s + r.shares * (r.shareClass.votingMultiple ?? 1), 0);
  const fdTotal = Math.max(totalShares, entity.fullyDilutedShares);

  const byInvestor: CapTablePosition[] = rows.map((r) => ({
    investor: r.investor,
    shareClass: r.shareClass,
    shares: r.shares,
    equityPercent: totalShares > 0 ? round2((r.shares / totalShares) * 100) : 0,
    fullyDilutedPercent: fdTotal > 0 ? round2((r.shares / fdTotal) * 100) : 0,
    votingPercent: totalVoting > 0 ? round2(((r.shares * (r.shareClass.votingMultiple ?? 1)) / totalVoting) * 100) : 0,
    totalCost: r.totalCost ?? 0,
    currency: r.currency,
    acquiredVia: r.acquisitionType,
    effectiveFrom: r.effectiveFrom,
  }));

  // Aggregate by share class
  const byClassMap = new Map<string, { sharesIssued: number; voting: number }>();
  for (const r of rows) {
    const existing = byClassMap.get(r.shareClassId) ?? { sharesIssued: 0, voting: 0 };
    existing.sharesIssued += r.shares;
    existing.voting += r.shares * (r.shareClass.votingMultiple ?? 1);
    byClassMap.set(r.shareClassId, existing);
  }
  const byShareClass = entity.shareClasses.map((sc) => {
    const agg = byClassMap.get(sc.id) ?? { sharesIssued: 0, voting: 0 };
    return {
      shareClass: sc,
      sharesIssued: agg.sharesIssued,
      sharesAuthorized: sc.totalAuthorized,
      equityPercent: totalShares > 0 ? round2((agg.sharesIssued / totalShares) * 100) : 0,
      votingPercent: totalVoting > 0 ? round2((agg.voting / totalVoting) * 100) : 0,
    };
  });

  return {
    entityId,
    entityName: entity.name,
    asOf: at,
    totalSharesIssued: totalShares,
    fullyDilutedShares: fdTotal,
    totalVotingShares: totalVoting,
    byInvestor,
    byShareClass,
    isFullyAllocated: Math.abs(rows.reduce((s, r) => s + r.shares, 0) - entity.totalSharesIssued) < 1,
    currentValuation: entity.currentValuation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dilution preview — what happens if N new shares are issued at $X
// ─────────────────────────────────────────────────────────────────────────────

export async function previewDilution(
  entityId: string,
  sharesToIssue: number,
  pricePerShare: number | null,
  roundId?: string,
): Promise<DilutionPreview> {
  if (sharesToIssue <= 0) throw new BadRequestError('sharesToIssue must be > 0');
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  const rows = await prisma.capTableEntry.findMany({
    where: { entityId, effectiveTo: null },
    include: { investor: { select: { id: true, displayName: true } } },
  });

  const preTotal = rows.reduce((s, r) => s + r.shares, 0);
  const newTotal = preTotal + sharesToIssue;
  if (newTotal <= 0) throw new BadRequestError('Resulting total shares would be zero');

  // Aggregate by investor (across share classes)
  const byInvestor = new Map<string, { name: string; shares: number }>();
  for (const r of rows) {
    const existing = byInvestor.get(r.investorId) ?? { name: r.investor.displayName, shares: 0 };
    existing.shares += r.shares;
    byInvestor.set(r.investorId, existing);
  }

  const positions = Array.from(byInvestor.entries()).map(([investorId, v]) => {
    const equityBefore = round2((v.shares / preTotal) * 100);
    const equityAfter = round2((v.shares / newTotal) * 100);
    return {
      investorId,
      investorName: v.name,
      sharesBefore: v.shares,
      equityBefore,
      sharesAfter: v.shares,
      equityAfter,
      dilutionPct: round2(equityBefore - equityAfter),
    };
  });

  const preMoneyValuation = pricePerShare != null ? pricePerShare * preTotal : null;
  const postMoneyValuation = pricePerShare != null ? pricePerShare * newTotal : null;

  return {
    roundId: roundId ?? null,
    entityId,
    preMoneyValuation,
    postMoneyValuation,
    sharesIssuedThisRound: sharesToIssue,
    newTotalShares: newTotal,
    pricePerShare,
    preRoundPositions: positions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Share transfer state machine
// ─────────────────────────────────────────────────────────────────────────────

const TRANSFER_TRANSITIONS: Record<ShareTransferStatus, ReadonlyArray<ShareTransferStatus>> = {
  PENDING:   ['APPROVED', 'CANCELLED', 'REJECTED'],
  APPROVED:  ['EXECUTED', 'CANCELLED'],
  EXECUTED:  [],
  CANCELLED: [],
  REJECTED:  [],
};

function assertTransferTransition(from: ShareTransferStatus, to: ShareTransferStatus): void {
  if (from === to) return;
  if (!TRANSFER_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Transfer status transition ${from} → ${to} not allowed`);
  }
}

export async function initiateShareTransfer(
  actor: InvestorActor,
  entityId: string,
  input: InitiateShareTransferInput,
): Promise<ShareTransfer> {
  if (input.fromInvestorId === input.toInvestorId) {
    throw new BadRequestError('From and to investors must differ');
  }

  const [from, to, shareClass, entity] = await Promise.all([
    prisma.investorProfile.findUnique({ where: { id: input.fromInvestorId } }),
    prisma.investorProfile.findUnique({ where: { id: input.toInvestorId } }),
    prisma.shareClass.findUnique({ where: { id: input.shareClassId } }),
    prisma.investmentEntity.findUnique({ where: { id: entityId } }),
  ]);
  if (!from) throw new NotFoundError('Source investor not found');
  if (!to) throw new NotFoundError('Destination investor not found');
  if (!to.isActive) throw new BadRequestError('Destination investor is inactive');
  if (!shareClass) throw new NotFoundError('Share class not found');
  if (shareClass.entityId !== entityId) throw new BadRequestError('Share class belongs to a different entity');
  if (!entity) throw new NotFoundError('Entity not found');

  // Verify seller holds enough shares in this class
  const heldRows = await prisma.capTableEntry.findMany({
    where: { entityId, investorId: input.fromInvestorId, shareClassId: input.shareClassId, effectiveTo: null },
    select: { shares: true },
  });
  const held = heldRows.reduce((s, r) => s + r.shares, 0);
  if (held < input.shares) {
    throw new BadRequestError(`Seller holds only ${held} shares of class "${shareClass.code}" (transfer requires ${input.shares})`);
  }

  const transfer = await prisma.shareTransfer.create({
    data: {
      entityId,
      fromInvestorId: input.fromInvestorId,
      toInvestorId: input.toInvestorId,
      shareClassId: input.shareClassId,
      shares: input.shares,
      pricePerShare: input.pricePerShare ?? null,
      totalAmount: input.totalAmount ?? (input.pricePerShare ? input.pricePerShare * input.shares : null),
      currency: input.currency ?? entity.currency,
      reason: input.reason,
      status: 'PENDING',
      notes: input.notes ?? null,
    },
  });

  await writeInvestorAudit({
    entityId,
    userId: actor.userId,
    action: 'SHARE_TRANSFER_INITIATED',
    category: 'TRANSFER',
    resourceType: 'ShareTransfer',
    resourceId: transfer.id,
    metadata: {
      fromInvestorId: input.fromInvestorId,
      toInvestorId: input.toInvestorId,
      shareClassId: input.shareClassId,
      shares: input.shares,
      reason: input.reason,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return transfer;
}

export async function approveShareTransfer(actor: InvestorActor, id: string): Promise<ShareTransfer> {
  const existing = await prisma.shareTransfer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Share transfer not found');
  assertTransferTransition(existing.status, 'APPROVED');

  const updated = await prisma.shareTransfer.update({
    where: { id },
    data: { status: 'APPROVED', approvedBy: actor.userId, approvedAt: new Date() },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'SHARE_TRANSFER_APPROVED',
    category: 'TRANSFER',
    resourceType: 'ShareTransfer',
    resourceId: id,
    metadata: { shares: existing.shares },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function executeShareTransfer(
  actor: InvestorActor,
  id: string,
): Promise<ShareTransfer> {
  return await prisma.$transaction(async (tx) => {
    const transfer = await tx.shareTransfer.findUnique({ where: { id } });
    if (!transfer) throw new NotFoundError('Share transfer not found');
    if (transfer.status !== 'APPROVED') {
      throw new BadRequestError(`Transfer must be APPROVED to execute (current: ${transfer.status})`);
    }

    const now = new Date();
    let remaining = transfer.shares;

    // Burn seller's holdings FIFO across active rows
    const sellerRows = await tx.capTableEntry.findMany({
      where: {
        entityId: transfer.entityId,
        investorId: transfer.fromInvestorId,
        shareClassId: transfer.shareClassId,
        effectiveTo: null,
      },
      orderBy: [{ effectiveFrom: 'asc' }],
    });

    for (const row of sellerRows) {
      if (remaining <= 0) break;
      const take = Math.min(row.shares, remaining);
      const leftover = row.shares - take;

      await tx.capTableEntry.update({ where: { id: row.id }, data: { effectiveTo: now } });

      if (leftover > 0) {
        await tx.capTableEntry.create({
          data: {
            entityId: row.entityId,
            investorId: row.investorId,
            shareClassId: row.shareClassId,
            shares: leftover,
            pricePerShare: row.pricePerShare,
            totalCost: row.pricePerShare ? row.pricePerShare * leftover : null,
            currency: row.currency,
            acquisitionType: 'REMAINDER',
            originalInvestmentId: row.originalInvestmentId,
            effectiveFrom: now,
          },
        });
      }

      remaining -= take;
    }

    if (remaining > 0) {
      throw new ConflictError('Seller equity insufficient at execution time');
    }

    // Open buyer's row
    const newEntry = await tx.capTableEntry.create({
      data: {
        entityId: transfer.entityId,
        investorId: transfer.toInvestorId,
        shareClassId: transfer.shareClassId,
        shares: transfer.shares,
        pricePerShare: transfer.pricePerShare,
        totalCost: transfer.totalAmount,
        currency: transfer.currency,
        acquisitionType: 'TRANSFER_IN',
        transferInId: transfer.id,
        effectiveFrom: now,
      },
    });

    const updated = await tx.shareTransfer.update({
      where: { id },
      data: { status: 'EXECUTED', executedAt: now },
    });

    void newEntry;
    return updated;
  }).then(async (updated) => {
    await writeInvestorAudit({
      entityId: updated.entityId,
      userId: actor.userId,
      action: 'SHARE_TRANSFER_EXECUTED',
      category: 'TRANSFER',
      resourceType: 'ShareTransfer',
      resourceId: updated.id,
      metadata: { shares: updated.shares, totalAmount: updated.totalAmount },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return updated;
  });
}

export async function cancelShareTransfer(
  actor: InvestorActor,
  id: string,
  input: CancelShareTransferInput,
): Promise<ShareTransfer> {
  const existing = await prisma.shareTransfer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Share transfer not found');
  if (existing.status === 'EXECUTED' || existing.status === 'CANCELLED') {
    throw new BadRequestError(`Cannot cancel transfer in status ${existing.status}`);
  }

  const updated = await prisma.shareTransfer.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: input.reason },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'SHARE_TRANSFER_CANCELLED',
    category: 'TRANSFER',
    resourceType: 'ShareTransfer',
    resourceId: id,
    metadata: { reason: input.reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listShareTransfers(opts: {
  entityId?: string;
  investorId?: string;
  status?: ShareTransferStatus;
  limit?: number;
}) {
  return await prisma.shareTransfer.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      ...(opts.investorId
        ? { OR: [{ fromInvestorId: opts.investorId }, { toInvestorId: opts.investorId }] }
        : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    include: {
      fromInvestor: { select: { id: true, displayName: true, type: true } },
      toInvestor: { select: { id: true, displayName: true, type: true } },
      shareClass: { select: { id: true, name: true, code: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}
