// Familista — Global Investor Layer
// File location: src/services/investor-round.service.ts
//
// Investment rounds — DRAFT → OPEN → CLOSED. On close, the round's price-per-
// share is locked, outstanding SAFEs/convertibles for the same entity are
// converted into the round's share class (delegated to investor-investment),
// and the entity's `currentValuation` is updated to postMoney.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  InvestmentRound,
  InvestmentRoundStatus,
  InvestmentRoundType,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  CreateRoundInput,
  UpdateRoundInput,
  CloseRoundInput,
  OpenRoundInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

const ROUND_TRANSITIONS: Record<InvestmentRoundStatus, ReadonlyArray<InvestmentRoundStatus>> = {
  DRAFT:     ['OPEN', 'CANCELLED'],
  OPEN:      ['CLOSED', 'CANCELLED'],
  CLOSED:    [],
  CANCELLED: [],
};

function assertRoundTransition(from: InvestmentRoundStatus, to: InvestmentRoundStatus): void {
  if (from === to) return;
  if (!ROUND_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Round transition ${from} → ${to} not allowed`);
  }
}

export async function createRound(
  actor: InvestorActor,
  entityId: string,
  input: CreateRoundInput,
): Promise<InvestmentRound> {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  if (input.shareClassId) {
    const sc = await prisma.shareClass.findUnique({ where: { id: input.shareClassId } });
    if (!sc) throw new NotFoundError('Share class not found');
    if (sc.entityId !== entityId) {
      throw new BadRequestError('Share class belongs to a different entity');
    }
  }

  if (input.preMoneyValuation && input.targetRaise) {
    const post = input.preMoneyValuation + input.targetRaise;
    if (input.pricePerShare && entity.totalSharesIssued > 0) {
      // sanity: pricePerShare should roughly match preMoney / fdShares
      const inferred = input.preMoneyValuation / entity.totalSharesIssued;
      const drift = Math.abs(inferred - input.pricePerShare) / inferred;
      if (drift > 0.5) {
        throw new BadRequestError(
          `pricePerShare (${input.pricePerShare}) is inconsistent with preMoneyValuation/${entity.totalSharesIssued} = ${inferred.toFixed(4)}`,
        );
      }
    }
    void post;
  }

  const created = await prisma.investmentRound.create({
    data: {
      entityId,
      type: input.type,
      name: input.name,
      currency: input.currency ?? entity.currency,
      targetRaise: input.targetRaise,
      preMoneyValuation: input.preMoneyValuation ?? null,
      postMoneyValuation: input.preMoneyValuation ? input.preMoneyValuation + input.targetRaise : null,
      pricePerShare: input.pricePerShare ?? null,
      sharesAuthorized: input.sharesAuthorized ?? null,
      shareClassId: input.shareClassId ?? null,
      leadInvestorId: input.leadInvestorId ?? null,
      terms:
        input.terms === undefined || input.terms === null
          ? undefined
          : (input.terms as Prisma.InputJsonValue),
      notes: input.notes ?? null,
      status: 'DRAFT',
    },
  });

  await writeInvestorAudit({
    entityId,
    userId: actor.userId,
    action: 'ROUND_CREATED',
    category: 'ROUND',
    resourceType: 'InvestmentRound',
    resourceId: created.id,
    metadata: { type: created.type, name: created.name, targetRaise: created.targetRaise },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateRound(
  actor: InvestorActor,
  id: string,
  input: UpdateRoundInput,
): Promise<InvestmentRound> {
  const existing = await prisma.investmentRound.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Round not found');
  if (existing.status !== 'DRAFT') {
    throw new BadRequestError('Only DRAFT rounds may be edited');
  }

  const updated = await prisma.investmentRound.update({
    where: { id },
    data: {
      type: input.type,
      name: input.name,
      currency: input.currency,
      targetRaise: input.targetRaise,
      preMoneyValuation: input.preMoneyValuation === undefined ? undefined : input.preMoneyValuation,
      postMoneyValuation:
        input.preMoneyValuation == null || input.targetRaise == null
          ? undefined
          : input.preMoneyValuation + input.targetRaise,
      pricePerShare: input.pricePerShare === undefined ? undefined : input.pricePerShare,
      sharesAuthorized: input.sharesAuthorized === undefined ? undefined : input.sharesAuthorized,
      shareClassId: input.shareClassId === undefined ? undefined : input.shareClassId,
      leadInvestorId: input.leadInvestorId === undefined ? undefined : input.leadInvestorId,
      terms:
        input.terms === undefined
          ? undefined
          : input.terms === null
            ? Prisma.JsonNull
            : (input.terms as Prisma.InputJsonValue),
      notes: input.notes ?? undefined,
    },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'ROUND_UPDATED',
    category: 'ROUND',
    resourceType: 'InvestmentRound',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function openRound(
  actor: InvestorActor,
  id: string,
  input: OpenRoundInput = {},
): Promise<InvestmentRound> {
  const existing = await prisma.investmentRound.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Round not found');
  assertRoundTransition(existing.status, 'OPEN');

  if (!existing.targetRaise || existing.targetRaise <= 0) {
    throw new BadRequestError('Round must have a positive targetRaise before opening');
  }
  if (!existing.preMoneyValuation && existing.type !== 'PRE_SEED' && existing.type !== 'SEED' && existing.type !== 'BRIDGE') {
    throw new BadRequestError('Priced rounds require preMoneyValuation before opening');
  }

  // Ensure no other round is already OPEN for this entity
  const openConflict = await prisma.investmentRound.findFirst({
    where: { entityId: existing.entityId, status: 'OPEN', NOT: { id } },
  });
  if (openConflict) {
    throw new ConflictError(`Entity already has an open round: ${openConflict.name} (${openConflict.id})`);
  }

  const updated = await prisma.investmentRound.update({
    where: { id },
    data: { status: 'OPEN', openedAt: input.openedAt ? new Date(input.openedAt) : new Date() },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'ROUND_OPENED',
    category: 'ROUND',
    resourceType: 'InvestmentRound',
    resourceId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function closeRound(
  actor: InvestorActor,
  id: string,
  input: CloseRoundInput = {},
): Promise<InvestmentRound> {
  const existing = await prisma.investmentRound.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Round not found');
  assertRoundTransition(existing.status, 'CLOSED');

  // Recompute postMoney based on actual raise
  const postMoney =
    existing.preMoneyValuation != null
      ? existing.preMoneyValuation + existing.actualRaise
      : existing.postMoneyValuation;

  const updated = await prisma.$transaction(async (tx) => {
    const round = await tx.investmentRound.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: input.closedAt ? new Date(input.closedAt) : new Date(),
        postMoneyValuation: postMoney,
        notes: input.notes ?? existing.notes,
      },
    });

    if (postMoney != null) {
      await tx.investmentEntity.update({
        where: { id: existing.entityId },
        data: { currentValuation: postMoney, lastValuationAt: new Date() },
      });
    }

    return round;
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'ROUND_CLOSED',
    category: 'ROUND',
    resourceType: 'InvestmentRound',
    resourceId: id,
    metadata: {
      actualRaise: updated.actualRaise,
      postMoneyValuation: updated.postMoneyValuation,
      notes: input.notes,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function cancelRound(actor: InvestorActor, id: string, reason: string): Promise<InvestmentRound> {
  const existing = await prisma.investmentRound.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Round not found');
  if (existing.status === 'CLOSED' || existing.status === 'CANCELLED') {
    throw new BadRequestError(`Cannot cancel round in status ${existing.status}`);
  }

  const updated = await prisma.investmentRound.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'ROUND_CANCELLED',
    category: 'ROUND',
    resourceType: 'InvestmentRound',
    resourceId: id,
    metadata: { reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listRounds(opts: {
  entityId?: string;
  status?: InvestmentRoundStatus;
  type?: InvestmentRoundType;
  scopeEntityIds?: Set<string>;
  limit?: number;
}) {
  return await prisma.investmentRound.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.scopeEntityIds ? { entityId: { in: Array.from(opts.scopeEntityIds) } } : {}),
    },
    include: {
      shareClass: true,
      entity: { select: { id: true, name: true, type: true } },
      _count: { select: { investments: true, agreements: true } },
    },
    orderBy: [{ openedAt: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

export async function getRound(id: string) {
  const round = await prisma.investmentRound.findUnique({
    where: { id },
    include: {
      shareClass: true,
      entity: true,
      investments: {
        include: { investor: { select: { id: true, displayName: true, type: true } } },
        orderBy: { committedAmount: 'desc' },
      },
      _count: { select: { agreements: true } },
    },
  });
  if (!round) throw new NotFoundError('Round not found');
  return round;
}
