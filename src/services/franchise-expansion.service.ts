// Familista — Franchise Expansion Engine
// File location: src/services/franchise-expansion.service.ts
//
// Two coupled growth workflows:
//   1. ExpansionRequest — an existing unit asks to add a new unit in a
//      territory. Approval creates a new FranchiseUnit when COMPLETED.
//   2. FranchiseAcquisitionRequest — a buyer wants to acquire equity in an
//      existing unit. Approval creates a FranchiseOwnershipTransfer record
//      ready for execution.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  ExpansionRequest,
  FranchiseAcquisitionRequest,
  FranchiseUnit,
  FranchiseOwnershipTransfer,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import { checkExclusivityConflict } from './franchise-territory.service';
import { initiateTransfer, approveTransfer } from './franchise-ownership.service';
import type {
  CreateExpansionRequestInput,
  DecideExpansionRequestInput,
  CompleteExpansionRequestInput,
  CreateAcquisitionRequestInput,
  DecideAcquisitionInput,
} from '../utils/franchise.validators';
import type { FranchiseActor } from '../types/franchise.types';

// ─────────────────────────────────────────────────────────────────────────────
// ExpansionRequest
// ─────────────────────────────────────────────────────────────────────────────

export async function createExpansionRequest(
  actor: FranchiseActor,
  input: CreateExpansionRequestInput,
): Promise<ExpansionRequest> {
  const [requestingUnit, territory] = await Promise.all([
    prisma.franchiseUnit.findUnique({ where: { id: input.requestingUnitId } }),
    prisma.territory.findUnique({ where: { id: input.targetTerritoryId } }),
  ]);
  if (!requestingUnit) throw new NotFoundError('Requesting unit not found');
  if (!territory) throw new NotFoundError('Target territory not found');
  if (requestingUnit.status !== 'ACTIVE') {
    throw new BadRequestError(`Requesting unit must be ACTIVE (current: ${requestingUnit.status})`);
  }

  // Surface territory protection conflicts to the requester at creation time.
  const conflicts = await checkExclusivityConflict(input.targetTerritoryId, input.targetLevel, 'EXCLUSIVE');
  if (conflicts.length > 0 && !conflicts.some((c) => c.unitId === input.requestingUnitId)) {
    // Allow request creation but flag — operator review can override.
    await writeFranchiseAudit({
      unitId: input.requestingUnitId,
      userId: actor.userId,
      action: 'EXPANSION_PROTECTED_TERRITORY',
      category: 'EXPANSION',
      result: 'REJECTED',
      message: `Territory has ${conflicts.length} exclusive right(s) held by other unit(s)`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  if (input.proposedCode) {
    const codeClash = await prisma.franchiseUnit.findUnique({ where: { code: input.proposedCode } });
    if (codeClash) throw new ConflictError(`Proposed code "${input.proposedCode}" is already in use`);
  }

  const created = await prisma.expansionRequest.create({
    data: {
      requestingUnitId: input.requestingUnitId,
      targetTerritoryId: input.targetTerritoryId,
      targetLevel: input.targetLevel,
      proposedName: input.proposedName ?? null,
      proposedCode: input.proposedCode ?? null,
      businessPlan:
        input.businessPlan === undefined || input.businessPlan === null
          ? undefined
          : (input.businessPlan as Prisma.InputJsonValue),
      financialProjection:
        input.financialProjection === undefined || input.financialProjection === null
          ? undefined
          : (input.financialProjection as Prisma.InputJsonValue),
      status: 'PENDING',
      submittedBy: actor.userId,
    },
  });

  await writeFranchiseAudit({
    unitId: input.requestingUnitId,
    userId: actor.userId,
    action: 'EXPANSION_REQUEST_CREATED',
    category: 'EXPANSION',
    resourceType: 'ExpansionRequest',
    resourceId: created.id,
    metadata: {
      targetTerritoryId: input.targetTerritoryId,
      targetLevel: input.targetLevel,
      proposedName: input.proposedName,
      proposedCode: input.proposedCode,
      protectionConflicts: conflicts.length,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function decideExpansionRequest(
  actor: FranchiseActor,
  id: string,
  input: DecideExpansionRequestInput,
): Promise<ExpansionRequest> {
  const existing = await prisma.expansionRequest.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Expansion request not found');
  if (!['PENDING', 'UNDER_REVIEW', 'ESCALATED'].includes(existing.status)) {
    throw new BadRequestError(`Cannot decide a request in status ${existing.status}`);
  }

  const updated = await prisma.expansionRequest.update({
    where: { id },
    data: {
      status: input.decision,
      reviewedBy: actor.userId,
      decisionAt: new Date(),
      decisionNotes: input.notes,
    },
  });

  await writeFranchiseAudit({
    unitId: existing.requestingUnitId,
    userId: actor.userId,
    action: `EXPANSION_REQUEST_${input.decision}`,
    category: 'EXPANSION',
    resourceType: 'ExpansionRequest',
    resourceId: id,
    metadata: { notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function completeExpansionRequest(
  actor: FranchiseActor,
  id: string,
  input: CompleteExpansionRequestInput,
): Promise<{ request: ExpansionRequest; unit: FranchiseUnit }> {
  return await prisma.$transaction(async (tx) => {
    const existing = await tx.expansionRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Expansion request not found');
    if (existing.status !== 'APPROVED') {
      throw new BadRequestError(`Only APPROVED requests can be completed (current: ${existing.status})`);
    }

    const codeCollision = await tx.franchiseUnit.findUnique({ where: { code: input.unitCode } });
    if (codeCollision) throw new ConflictError(`Unit code "${input.unitCode}" is already in use`);

    const newUnit = await tx.franchiseUnit.create({
      data: {
        code: input.unitCode,
        name: input.unitName,
        level: existing.targetLevel,
        status: 'PENDING',
        parentUnitId: existing.requestingUnitId,
        territoryId: existing.targetTerritoryId,
      },
    });

    const updated = await tx.expansionRequest.update({
      where: { id },
      data: { status: 'COMPLETED', createdUnitId: newUnit.id },
    });

    return { request: updated, unit: newUnit };
  }).then(async (result) => {
    await writeFranchiseAudit({
      unitId: result.unit.id,
      userId: actor.userId,
      action: 'EXPANSION_REQUEST_COMPLETED',
      category: 'EXPANSION',
      resourceType: 'ExpansionRequest',
      resourceId: result.request.id,
      metadata: {
        createdUnitId: result.unit.id,
        createdUnitCode: result.unit.code,
        notes: input.notes,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return result;
  });
}

export async function listExpansionRequests(opts: {
  requestingUnitId?: string;
  status?: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ESCALATED' | 'COMPLETED' | 'WITHDRAWN';
  scopeUnitIds?: Set<string>;
  limit?: number;
}) {
  return await prisma.expansionRequest.findMany({
    where: {
      ...(opts.requestingUnitId ? { requestingUnitId: opts.requestingUnitId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.scopeUnitIds ? { requestingUnitId: { in: Array.from(opts.scopeUnitIds) } } : {}),
    },
    include: {
      requestingUnit: { select: { id: true, code: true, name: true, level: true } },
      targetTerritory: { select: { id: true, name: true, type: true, fullPath: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FranchiseAcquisitionRequest
// ─────────────────────────────────────────────────────────────────────────────

export async function createAcquisitionRequest(
  actor: FranchiseActor,
  input: CreateAcquisitionRequestInput,
): Promise<FranchiseAcquisitionRequest> {
  const target = await prisma.franchiseUnit.findUnique({ where: { id: input.targetUnitId } });
  if (!target) throw new NotFoundError('Target unit not found');
  if (target.status === 'TERMINATED') {
    throw new BadRequestError('Cannot create acquisition for a terminated unit');
  }

  if (input.acquirerOwnerId) {
    const owner = await prisma.franchiseOwner.findUnique({ where: { id: input.acquirerOwnerId } });
    if (!owner) throw new NotFoundError('Acquirer owner not found');
    if (!owner.isActive) throw new BadRequestError('Acquirer owner is inactive');
  }

  const created = await prisma.franchiseAcquisitionRequest.create({
    data: {
      targetUnitId: input.targetUnitId,
      acquirerOwnerId: input.acquirerOwnerId ?? null,
      acquirerName: input.acquirerName ?? null,
      acquirerEmail: input.acquirerEmail ?? null,
      proposedEquity: input.proposedEquity,
      proposedAmount: input.proposedAmount,
      currency: input.currency ?? 'EUR',
      status: 'DRAFT',
      dueDiligence:
        input.dueDiligence === undefined || input.dueDiligence === null
          ? undefined
          : (input.dueDiligence as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    unitId: input.targetUnitId,
    userId: actor.userId,
    action: 'ACQUISITION_CREATED',
    category: 'ACQUISITION',
    resourceType: 'FranchiseAcquisitionRequest',
    resourceId: created.id,
    metadata: {
      proposedEquity: input.proposedEquity,
      proposedAmount: input.proposedAmount,
      currency: input.currency ?? 'EUR',
      acquirerOwnerId: input.acquirerOwnerId,
      acquirerName: input.acquirerName,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function submitAcquisitionRequest(
  actor: FranchiseActor,
  id: string,
): Promise<FranchiseAcquisitionRequest> {
  const existing = await prisma.franchiseAcquisitionRequest.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Acquisition request not found');
  if (existing.status !== 'DRAFT') {
    throw new BadRequestError(`Only DRAFT requests can be submitted (current: ${existing.status})`);
  }

  const updated = await prisma.franchiseAcquisitionRequest.update({
    where: { id },
    data: { status: 'SUBMITTED', submittedAt: new Date(), submittedBy: actor.userId },
  });

  await writeFranchiseAudit({
    unitId: existing.targetUnitId,
    userId: actor.userId,
    action: 'ACQUISITION_SUBMITTED',
    category: 'ACQUISITION',
    resourceType: 'FranchiseAcquisitionRequest',
    resourceId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function decideAcquisition(
  actor: FranchiseActor,
  id: string,
  input: DecideAcquisitionInput,
): Promise<{ request: FranchiseAcquisitionRequest; transfer: FranchiseOwnershipTransfer | null }> {
  const existing = await prisma.franchiseAcquisitionRequest.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Acquisition request not found');
  if (!['SUBMITTED', 'UNDER_REVIEW'].includes(existing.status)) {
    throw new BadRequestError(`Cannot decide in status ${existing.status}`);
  }

  const updated = await prisma.franchiseAcquisitionRequest.update({
    where: { id },
    data: {
      status: input.decision,
      decisionAt: new Date(),
      decisionBy: actor.userId,
      decisionNotes: input.notes,
    },
  });

  let transfer: FranchiseOwnershipTransfer | null = null;
  if (input.decision === 'APPROVED' && existing.acquirerOwnerId) {
    const sellerOwnership = await prisma.franchiseOwnership.findFirst({
      where: { unitId: existing.targetUnitId, isPrimary: true, effectiveTo: null },
    });
    if (sellerOwnership) {
      transfer = await initiateTransfer(actor, existing.targetUnitId, {
        fromOwnerId: sellerOwnership.ownerId,
        toOwnerId: existing.acquirerOwnerId,
        equityPercent: existing.proposedEquity,
        amount: existing.proposedAmount,
        currency: existing.currency,
        reason: 'ACQUISITION',
        acquisitionRequestId: existing.id,
        notes: `Generated from acquisition ${existing.id}`,
      });
      transfer = await approveTransfer(actor, transfer.id);
    }
  }

  await writeFranchiseAudit({
    unitId: existing.targetUnitId,
    userId: actor.userId,
    action: `ACQUISITION_${input.decision}`,
    category: 'ACQUISITION',
    resourceType: 'FranchiseAcquisitionRequest',
    resourceId: id,
    metadata: { notes: input.notes, transferId: transfer?.id ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { request: updated, transfer };
}

export async function listAcquisitionRequests(opts: {
  targetUnitId?: string;
  acquirerOwnerId?: string;
  status?: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'COMPLETED' | 'WITHDRAWN';
  scopeUnitIds?: Set<string>;
  limit?: number;
}) {
  return await prisma.franchiseAcquisitionRequest.findMany({
    where: {
      ...(opts.targetUnitId ? { targetUnitId: opts.targetUnitId } : {}),
      ...(opts.acquirerOwnerId ? { acquirerOwnerId: opts.acquirerOwnerId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.scopeUnitIds ? { targetUnitId: { in: Array.from(opts.scopeUnitIds) } } : {}),
    },
    include: {
      targetUnit: { select: { id: true, code: true, name: true, level: true } },
      acquirerOwner: { select: { id: true, displayName: true, type: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}
