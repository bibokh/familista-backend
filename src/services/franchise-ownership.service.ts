// Familista — Franchise Expansion Engine
// File location: src/services/franchise-ownership.service.ts
//
// Franchise owners (individuals / entities / investor groups), time-effective
// ownership records (cap table), and the transfer state machine
// (PENDING → APPROVED → EXECUTED, or CANCELLED/REJECTED).
//
// Cap-table invariant enforced on every write: active equity for a unit at any
// point in time sums to ≤ 100% (± 0.01 rounding tolerance).

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  FranchiseOwner,
  FranchiseOwnership,
  FranchiseOwnershipTransfer,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import type {
  CreateOwnerInput,
  UpdateOwnerInput,
  GrantOwnershipInput,
  RevokeOwnershipInput,
  InitiateTransferInput,
  CancelTransferInput,
} from '../utils/franchise.validators';
import type { FranchiseActor, CapTable, CapTableEntry } from '../types/franchise.types';

const CAP_TABLE_TOLERANCE = 0.01;

// ─────────────────────────────────────────────────────────────────────────────
// Owner CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createOwner(actor: FranchiseActor, input: CreateOwnerInput): Promise<FranchiseOwner> {
  if (input.userId) {
    const collision = await prisma.franchiseOwner.findUnique({ where: { userId: input.userId } });
    if (collision) throw new ConflictError('A franchise owner already exists for that user');
  }

  const created = await prisma.franchiseOwner.create({
    data: {
      type: input.type,
      displayName: input.displayName,
      userId: input.userId ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      legalName: input.legalName ?? null,
      taxId: input.taxId ?? null,
      legalAddress: input.legalAddress ?? null,
      countryCode: input.countryCode ?? null,
      notes: input.notes ?? null,
    },
  });

  await writeFranchiseAudit({
    userId: actor.userId,
    ownerId: created.id,
    action: 'OWNER_CREATED',
    category: 'OWNERSHIP',
    resourceType: 'FranchiseOwner',
    resourceId: created.id,
    metadata: { type: created.type, displayName: created.displayName },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateOwner(actor: FranchiseActor, id: string, input: UpdateOwnerInput): Promise<FranchiseOwner> {
  const existing = await prisma.franchiseOwner.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Owner not found');

  if (input.userId && input.userId !== existing.userId) {
    const collision = await prisma.franchiseOwner.findUnique({ where: { userId: input.userId } });
    if (collision && collision.id !== id) {
      throw new ConflictError('That user is already linked to another owner record');
    }
  }

  const updated = await prisma.franchiseOwner.update({
    where: { id },
    data: {
      type: input.type,
      displayName: input.displayName,
      userId: input.userId === undefined ? undefined : input.userId,
      contactEmail: input.contactEmail ?? undefined,
      contactPhone: input.contactPhone ?? undefined,
      legalName: input.legalName ?? undefined,
      taxId: input.taxId ?? undefined,
      legalAddress: input.legalAddress ?? undefined,
      countryCode: input.countryCode ?? undefined,
      notes: input.notes ?? undefined,
      isActive: input.isActive,
    },
  });

  await writeFranchiseAudit({
    userId: actor.userId,
    ownerId: id,
    action: 'OWNER_UPDATED',
    category: 'OWNERSHIP',
    resourceType: 'FranchiseOwner',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function getOwner(id: string) {
  const owner = await prisma.franchiseOwner.findUnique({
    where: { id },
    include: {
      ownerships: {
        where: { effectiveTo: null },
        include: { unit: { select: { id: true, code: true, name: true, level: true, status: true } } },
      },
      _count: { select: { ownerships: true, transfersIn: true, transfersOut: true } },
    },
  });
  if (!owner) throw new NotFoundError('Owner not found');
  return owner;
}

export async function listOwners(opts: {
  type?: 'INDIVIDUAL' | 'ENTITY' | 'INVESTOR_GROUP';
  search?: string;
  activeOnly?: boolean;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.franchiseOwner.findMany({
    where: {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.activeOnly !== false ? { isActive: true } : {}),
      ...(opts.search
        ? {
            OR: [
              { displayName: { contains: opts.search, mode: 'insensitive' as const } },
              { legalName: { contains: opts.search, mode: 'insensitive' as const } },
              { contactEmail: { contains: opts.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ displayName: 'asc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cap table — active ownerships at a point in time
// ─────────────────────────────────────────────────────────────────────────────

export async function getCapTable(unitId: string, asOf?: Date): Promise<CapTable> {
  const at = asOf ?? new Date();
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');

  const rows = await prisma.franchiseOwnership.findMany({
    where: {
      unitId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    include: { owner: true },
    orderBy: [{ isPrimary: 'desc' }, { equityPercent: 'desc' }],
  });

  const entries: CapTableEntry[] = rows.map((r) => ({ ownership: r, owner: r.owner }));
  const totalEquityPercent = entries.reduce((s, e) => s + e.ownership.equityPercent, 0);
  const totalControlPercent = entries.reduce((s, e) => s + (e.ownership.controlPercent ?? e.ownership.equityPercent), 0);
  const primary = entries.find((e) => e.ownership.isPrimary);

  return {
    unitId,
    asOf: at,
    entries,
    totalEquityPercent: round2(totalEquityPercent),
    totalControlPercent: round2(totalControlPercent),
    primaryOwnerId: primary?.owner.id ?? null,
    isFullyAllocated: Math.abs(totalEquityPercent - 100) < CAP_TABLE_TOLERANCE,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function assertEquityRoom(
  tx: Prisma.TransactionClient,
  unitId: string,
  equityPercent: number,
  effectiveFrom: Date,
  excludeOwnershipId?: string,
): Promise<void> {
  const rows = await tx.franchiseOwnership.findMany({
    where: {
      unitId,
      ...(excludeOwnershipId ? { NOT: { id: excludeOwnershipId } } : {}),
      effectiveFrom: { lte: effectiveFrom },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
    },
    select: { equityPercent: true },
  });
  const occupied = rows.reduce((s, r) => s + r.equityPercent, 0);
  if (occupied + equityPercent > 100 + CAP_TABLE_TOLERANCE) {
    throw new ConflictError(
      `Cap table overflow: ${round2(occupied)}% already allocated, cannot add ${round2(equityPercent)}%`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership grant / revoke
// ─────────────────────────────────────────────────────────────────────────────

export async function grantOwnership(
  actor: FranchiseActor,
  unitId: string,
  input: GrantOwnershipInput,
): Promise<FranchiseOwnership> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');
  if (unit.status === 'TERMINATED') throw new BadRequestError('Cannot grant ownership in a terminated unit');

  const owner = await prisma.franchiseOwner.findUnique({ where: { id: input.ownerId } });
  if (!owner) throw new NotFoundError('Owner not found');
  if (!owner.isActive) throw new BadRequestError('Owner is inactive');

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();

  const created = await prisma.$transaction(async (tx) => {
    await assertEquityRoom(tx, unitId, input.equityPercent, effectiveFrom);

    if (input.isPrimary) {
      // unseat any existing primary as of effectiveFrom
      await tx.franchiseOwnership.updateMany({
        where: { unitId, isPrimary: true, effectiveTo: null },
        data: { isPrimary: false },
      });
    }

    return await tx.franchiseOwnership.create({
      data: {
        unitId,
        ownerId: input.ownerId,
        equityPercent: input.equityPercent,
        controlPercent: input.controlPercent ?? null,
        isPrimary: input.isPrimary ?? false,
        effectiveFrom,
        acquiredVia: input.acquiredVia ?? 'INITIAL',
      },
    });
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    ownerId: input.ownerId,
    action: 'OWNERSHIP_GRANTED',
    category: 'OWNERSHIP',
    resourceType: 'FranchiseOwnership',
    resourceId: created.id,
    metadata: {
      equityPercent: created.equityPercent,
      controlPercent: created.controlPercent,
      isPrimary: created.isPrimary,
      acquiredVia: created.acquiredVia,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function revokeOwnership(
  actor: FranchiseActor,
  ownershipId: string,
  input: RevokeOwnershipInput,
): Promise<FranchiseOwnership> {
  const existing = await prisma.franchiseOwnership.findUnique({ where: { id: ownershipId } });
  if (!existing) throw new NotFoundError('Ownership record not found');
  if (existing.effectiveTo) throw new BadRequestError('Ownership already closed');

  const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : new Date();
  if (effectiveTo <= existing.effectiveFrom) {
    throw new BadRequestError('effectiveTo must be after effectiveFrom');
  }

  const updated = await prisma.franchiseOwnership.update({
    where: { id: ownershipId },
    data: { effectiveTo, isPrimary: false },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    ownerId: existing.ownerId,
    action: 'OWNERSHIP_REVOKED',
    category: 'OWNERSHIP',
    resourceType: 'FranchiseOwnership',
    resourceId: ownershipId,
    metadata: { reason: input.reason, effectiveTo: updated.effectiveTo },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfer state machine
// ─────────────────────────────────────────────────────────────────────────────

export async function initiateTransfer(
  actor: FranchiseActor,
  unitId: string,
  input: InitiateTransferInput,
): Promise<FranchiseOwnershipTransfer> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');
  if (unit.status === 'TERMINATED') throw new BadRequestError('Cannot transfer ownership of a terminated unit');

  if (input.fromOwnerId === input.toOwnerId) {
    throw new BadRequestError('From and to owners must differ');
  }

  const [fromOwner, toOwner] = await Promise.all([
    prisma.franchiseOwner.findUnique({ where: { id: input.fromOwnerId } }),
    prisma.franchiseOwner.findUnique({ where: { id: input.toOwnerId } }),
  ]);
  if (!fromOwner) throw new NotFoundError('Source owner not found');
  if (!toOwner) throw new NotFoundError('Destination owner not found');
  if (!toOwner.isActive) throw new BadRequestError('Destination owner is inactive');

  // Verify the seller actually holds enough active equity at this unit
  const sellerActive = await prisma.franchiseOwnership.findMany({
    where: { unitId, ownerId: input.fromOwnerId, effectiveTo: null },
    select: { equityPercent: true },
  });
  const sellerEquity = sellerActive.reduce((s, r) => s + r.equityPercent, 0);
  if (sellerEquity + CAP_TABLE_TOLERANCE < input.equityPercent) {
    throw new BadRequestError(
      `Seller holds only ${round2(sellerEquity)}% in this unit; cannot transfer ${round2(input.equityPercent)}%`,
    );
  }

  const transfer = await prisma.franchiseOwnershipTransfer.create({
    data: {
      unitId,
      fromOwnerId: input.fromOwnerId,
      toOwnerId: input.toOwnerId,
      equityPercent: input.equityPercent,
      controlPercent: input.controlPercent ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? 'EUR',
      reason: input.reason,
      acquisitionRequestId: input.acquisitionRequestId ?? null,
      notes: input.notes ?? null,
      status: 'PENDING',
    },
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'TRANSFER_INITIATED',
    category: 'TRANSFER',
    resourceType: 'FranchiseOwnershipTransfer',
    resourceId: transfer.id,
    metadata: {
      fromOwnerId: input.fromOwnerId,
      toOwnerId: input.toOwnerId,
      equityPercent: input.equityPercent,
      amount: input.amount,
      reason: input.reason,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return transfer;
}

export async function approveTransfer(
  actor: FranchiseActor,
  transferId: string,
): Promise<FranchiseOwnershipTransfer> {
  const existing = await prisma.franchiseOwnershipTransfer.findUnique({ where: { id: transferId } });
  if (!existing) throw new NotFoundError('Transfer not found');
  if (existing.status !== 'PENDING') {
    throw new BadRequestError(`Transfer cannot be approved from status ${existing.status}`);
  }

  const updated = await prisma.franchiseOwnershipTransfer.update({
    where: { id: transferId },
    data: { status: 'APPROVED', approvedBy: actor.userId, approvedAt: new Date() },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'TRANSFER_APPROVED',
    category: 'TRANSFER',
    resourceType: 'FranchiseOwnershipTransfer',
    resourceId: transferId,
    metadata: { equityPercent: existing.equityPercent },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function executeTransfer(
  actor: FranchiseActor,
  transferId: string,
): Promise<{ transfer: FranchiseOwnershipTransfer; newOwnership: FranchiseOwnership }> {
  return await prisma.$transaction(async (tx) => {
    const transfer = await tx.franchiseOwnershipTransfer.findUnique({ where: { id: transferId } });
    if (!transfer) throw new NotFoundError('Transfer not found');
    if (transfer.status !== 'APPROVED') {
      throw new BadRequestError(`Transfer must be APPROVED to execute (current: ${transfer.status})`);
    }

    const now = new Date();
    let remaining = transfer.equityPercent;

    // Burn seller's active equity proportionally across their open ownership rows.
    const sellerRows = await tx.franchiseOwnership.findMany({
      where: { unitId: transfer.unitId, ownerId: transfer.fromOwnerId, effectiveTo: null },
      orderBy: [{ effectiveFrom: 'asc' }],
    });
    for (const row of sellerRows) {
      if (remaining <= CAP_TABLE_TOLERANCE) break;
      const take = Math.min(row.equityPercent, remaining);
      const leftover = row.equityPercent - take;
      // Close current row
      await tx.franchiseOwnership.update({
        where: { id: row.id },
        data: { effectiveTo: now },
      });
      // If seller retains a remainder, open a new row for that
      if (leftover > CAP_TABLE_TOLERANCE) {
        await tx.franchiseOwnership.create({
          data: {
            unitId: row.unitId,
            ownerId: row.ownerId,
            equityPercent: round2(leftover),
            controlPercent: row.controlPercent,
            isPrimary: row.isPrimary,
            effectiveFrom: now,
            acquiredVia: 'REMAINDER',
          },
        });
      }
      remaining = round2(remaining - take);
    }
    if (remaining > CAP_TABLE_TOLERANCE) {
      throw new ConflictError('Seller equity insufficient at execution time');
    }

    // Open new ownership for the buyer
    const newOwnership = await tx.franchiseOwnership.create({
      data: {
        unitId: transfer.unitId,
        ownerId: transfer.toOwnerId,
        equityPercent: transfer.equityPercent,
        controlPercent: transfer.controlPercent,
        isPrimary: false,
        effectiveFrom: now,
        acquiredVia: transfer.reason === 'ACQUISITION' ? 'ACQUISITION' : 'TRANSFER',
        acquisitionRequestId: transfer.acquisitionRequestId,
        transferInId: transfer.id,
      },
    });

    const updated = await tx.franchiseOwnershipTransfer.update({
      where: { id: transferId },
      data: { status: 'EXECUTED', executedAt: now },
    });

    if (transfer.acquisitionRequestId) {
      await tx.franchiseAcquisitionRequest.update({
        where: { id: transfer.acquisitionRequestId },
        data: { status: 'COMPLETED', executedAt: now, transferId: transfer.id },
      });
    }

    return { transfer: updated, newOwnership };
  }).then(async (result) => {
    await writeFranchiseAudit({
      unitId: result.transfer.unitId,
      userId: actor.userId,
      action: 'TRANSFER_EXECUTED',
      category: 'TRANSFER',
      resourceType: 'FranchiseOwnershipTransfer',
      resourceId: result.transfer.id,
      metadata: {
        fromOwnerId: result.transfer.fromOwnerId,
        toOwnerId: result.transfer.toOwnerId,
        equityPercent: result.transfer.equityPercent,
        newOwnershipId: result.newOwnership.id,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return result;
  });
}

export async function cancelTransfer(
  actor: FranchiseActor,
  transferId: string,
  input: CancelTransferInput,
): Promise<FranchiseOwnershipTransfer> {
  const existing = await prisma.franchiseOwnershipTransfer.findUnique({ where: { id: transferId } });
  if (!existing) throw new NotFoundError('Transfer not found');
  if (existing.status === 'EXECUTED') throw new BadRequestError('Executed transfers cannot be cancelled');
  if (existing.status === 'CANCELLED') throw new BadRequestError('Transfer is already cancelled');

  const updated = await prisma.franchiseOwnershipTransfer.update({
    where: { id: transferId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: input.reason },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'TRANSFER_CANCELLED',
    category: 'TRANSFER',
    resourceType: 'FranchiseOwnershipTransfer',
    resourceId: transferId,
    metadata: { reason: input.reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listTransfers(opts: {
  unitId?: string;
  ownerId?: string;
  status?: 'PENDING' | 'APPROVED' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
  limit?: number;
}) {
  return await prisma.franchiseOwnershipTransfer.findMany({
    where: {
      ...(opts.unitId ? { unitId: opts.unitId } : {}),
      ...(opts.ownerId ? { OR: [{ fromOwnerId: opts.ownerId }, { toOwnerId: opts.ownerId }] } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    include: {
      fromOwner: { select: { id: true, displayName: true, type: true } },
      toOwner: { select: { id: true, displayName: true, type: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}
