// Familista — Global Investor Layer
// File location: src/services/investor-governance.service.ts
//
// Investor rights (BOARD_SEAT, PRO_RATA, VETO, …) and board seats. Rights live
// against (investor, entity) pairs; board seats are tied to the entity but may
// reference an appointing investor.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  BoardSeat,
  BoardSeatRole,
  InvestorRight,
  InvestorRightType,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  GrantRightInput,
  UpdateRightInput,
  AppointBoardSeatInput,
  VacateBoardSeatInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

// ─────────────────────────────────────────────────────────────────────────────
// Investor rights
// ─────────────────────────────────────────────────────────────────────────────

export async function grantRight(
  actor: InvestorActor,
  entityId: string,
  input: GrantRightInput,
): Promise<InvestorRight> {
  const [entity, investor] = await Promise.all([
    prisma.investmentEntity.findUnique({ where: { id: entityId } }),
    prisma.investorProfile.findUnique({ where: { id: input.investorId } }),
  ]);
  if (!entity) throw new NotFoundError('Entity not found');
  if (!investor) throw new NotFoundError('Investor not found');

  const existingActive = await prisma.investorRight.findFirst({
    where: { entityId, investorId: input.investorId, type: input.type, isActive: true },
  });
  if (existingActive) {
    throw new ConflictError(`Investor already holds an active ${input.type} right on this entity`);
  }

  const right = await prisma.investorRight.create({
    data: {
      entityId,
      investorId: input.investorId,
      type: input.type,
      terms:
        input.terms === undefined || input.terms === null
          ? undefined
          : (input.terms as Prisma.InputJsonValue),
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      isActive: true,
    },
  });

  await writeInvestorAudit({
    investorId: input.investorId,
    entityId,
    userId: actor.userId,
    action: 'RIGHT_GRANTED',
    category: 'GOVERNANCE',
    resourceType: 'InvestorRight',
    resourceId: right.id,
    metadata: { type: input.type, terms: input.terms },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return right;
}

export async function updateRight(
  actor: InvestorActor,
  id: string,
  input: UpdateRightInput,
): Promise<InvestorRight> {
  const existing = await prisma.investorRight.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Right not found');

  const updated = await prisma.investorRight.update({
    where: { id },
    data: {
      terms:
        input.terms === undefined
          ? undefined
          : input.terms === null
            ? Prisma.JsonNull
            : (input.terms as Prisma.InputJsonValue),
      effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo ? new Date(input.effectiveTo) : null,
      isActive: input.isActive,
    },
  });

  await writeInvestorAudit({
    investorId: existing.investorId,
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'RIGHT_UPDATED',
    category: 'GOVERNANCE',
    resourceType: 'InvestorRight',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function revokeRight(actor: InvestorActor, id: string): Promise<void> {
  const existing = await prisma.investorRight.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Right not found');
  if (!existing.isActive) throw new BadRequestError('Right is already inactive');

  await prisma.investorRight.update({
    where: { id },
    data: { isActive: false, effectiveTo: new Date() },
  });

  await writeInvestorAudit({
    investorId: existing.investorId,
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'RIGHT_REVOKED',
    category: 'GOVERNANCE',
    resourceType: 'InvestorRight',
    resourceId: id,
    metadata: { type: existing.type },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function listRights(opts: {
  entityId?: string;
  investorId?: string;
  type?: InvestorRightType;
  activeOnly?: boolean;
}): Promise<InvestorRight[]> {
  return await prisma.investorRight.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      ...(opts.investorId ? { investorId: opts.investorId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.activeOnly !== false ? { isActive: true } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Board seats
// ─────────────────────────────────────────────────────────────────────────────

export async function appointBoardSeat(
  actor: InvestorActor,
  entityId: string,
  input: AppointBoardSeatInput,
): Promise<BoardSeat> {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  if (input.investorId) {
    const investor = await prisma.investorProfile.findUnique({ where: { id: input.investorId } });
    if (!investor) throw new NotFoundError('Investor not found');
  }

  const seat = await prisma.boardSeat.create({
    data: {
      entityId,
      investorId: input.investorId ?? null,
      holderName: input.holderName,
      holderEmail: input.holderEmail ?? null,
      holderUserId: input.holderUserId ?? null,
      role: input.role,
      votingPower: input.votingPower ?? 1.0,
      appointedAt: input.appointedAt ? new Date(input.appointedAt) : new Date(),
      notes: input.notes ?? null,
      isActive: true,
    },
  });

  await writeInvestorAudit({
    investorId: input.investorId ?? null,
    entityId,
    userId: actor.userId,
    action: 'BOARD_SEAT_APPOINTED',
    category: 'GOVERNANCE',
    resourceType: 'BoardSeat',
    resourceId: seat.id,
    metadata: { role: seat.role, holderName: seat.holderName, votingPower: seat.votingPower },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return seat;
}

export async function vacateBoardSeat(
  actor: InvestorActor,
  id: string,
  input: VacateBoardSeatInput,
): Promise<BoardSeat> {
  const existing = await prisma.boardSeat.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Board seat not found');
  if (!existing.isActive) throw new BadRequestError('Seat is already vacated');

  const updated = await prisma.boardSeat.update({
    where: { id },
    data: {
      isActive: false,
      departedAt: input.departedAt ? new Date(input.departedAt) : new Date(),
      notes: input.reason,
    },
  });

  await writeInvestorAudit({
    investorId: existing.investorId,
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'BOARD_SEAT_VACATED',
    category: 'GOVERNANCE',
    resourceType: 'BoardSeat',
    resourceId: id,
    metadata: { reason: input.reason, holderName: existing.holderName },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listBoardSeats(opts: {
  entityId?: string;
  investorId?: string;
  role?: BoardSeatRole;
  activeOnly?: boolean;
}): Promise<BoardSeat[]> {
  return await prisma.boardSeat.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      ...(opts.investorId ? { investorId: opts.investorId } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.activeOnly !== false ? { isActive: true } : {}),
    },
    orderBy: [{ appointedAt: 'desc' }],
  });
}

export async function getEntityGovernanceSummary(entityId: string) {
  const [activeSeats, activeRights, allSeats, allRights] = await Promise.all([
    prisma.boardSeat.count({ where: { entityId, isActive: true } }),
    prisma.investorRight.count({ where: { entityId, isActive: true } }),
    prisma.boardSeat.groupBy({ where: { entityId, isActive: true }, by: ['role'], _count: { _all: true } }),
    prisma.investorRight.groupBy({ where: { entityId, isActive: true }, by: ['type'], _count: { _all: true } }),
  ]);

  return {
    entityId,
    activeBoardSeats: activeSeats,
    activeRights: activeRights,
    seatsByRole: Object.fromEntries(allSeats.map((s) => [s.role, s._count._all])),
    rightsByType: Object.fromEntries(allRights.map((r) => [r.type, r._count._all])),
  };
}
