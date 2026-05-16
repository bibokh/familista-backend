// Familista — Franchise Expansion Engine
// File location: src/services/franchise-contract.service.ts
//
// Contracts, renewals, terminations. State machines enforce legal lifecycle:
//   Contract:       DRAFT → PENDING_SIGNATURE → ACTIVE → (RENEWED|EXPIRED|TERMINATED)
//   Renewal:        REQUESTED → (APPROVED|REJECTED), APPROVED → EXECUTED
//   Termination:    REQUESTED → (APPROVED|CANCELLED), APPROVED → EXECUTED

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  ContractStatus,
  FranchiseContract,
  FranchiseContractRenewal,
  FranchiseContractTermination,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import type {
  CreateContractInput,
  UpdateContractInput,
  SignContractInput,
  RequestRenewalInput,
  DecideRenewalInput,
  InitiateTerminationInput,
  DecideTerminationInput,
} from '../utils/franchise.validators';
import type { FranchiseActor } from '../types/franchise.types';

const CONTRACT_TRANSITIONS: Record<ContractStatus, ReadonlyArray<ContractStatus>> = {
  DRAFT:             ['PENDING_SIGNATURE', 'TERMINATED'],
  PENDING_SIGNATURE: ['ACTIVE', 'DRAFT', 'TERMINATED'],
  ACTIVE:            ['RENEWED', 'EXPIRED', 'TERMINATED'],
  RENEWED:           ['EXPIRED', 'TERMINATED'],
  EXPIRED:           ['TERMINATED'],
  TERMINATED:        [],
};

function assertContractTransition(from: ContractStatus, to: ContractStatus): void {
  if (from === to) return;
  if (!CONTRACT_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Contract status transition ${from} → ${to} not allowed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createContract(
  actor: FranchiseActor,
  unitId: string,
  input: CreateContractInput,
): Promise<FranchiseContract> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Unit not found');
  if (unit.status === 'TERMINATED') throw new BadRequestError('Cannot create contracts for terminated units');

  const latestVersion = await prisma.franchiseContract.aggregate({
    where: { unitId, type: input.type },
    _max: { version: true },
  });
  const nextVersion = (latestVersion._max.version ?? 0) + 1;

  const created = await prisma.franchiseContract.create({
    data: {
      unitId,
      type: input.type,
      version: nextVersion,
      status: 'DRAFT',
      documentUrl: input.documentUrl ?? null,
      documentChecksum: input.documentChecksum ?? null,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      autoRenew: input.autoRenew ?? false,
      renewalNoticeMonths: input.renewalNoticeMonths ?? 6,
      governingLaw: input.governingLaw ?? null,
      jurisdiction: input.jurisdiction ?? null,
      terms:
        input.terms === undefined || input.terms === null ? undefined : (input.terms as Prisma.InputJsonValue),
      createdBy: actor.userId,
    },
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'CONTRACT_CREATED',
    category: 'CONTRACT',
    resourceType: 'FranchiseContract',
    resourceId: created.id,
    metadata: { type: created.type, version: created.version },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateContract(
  actor: FranchiseActor,
  id: string,
  input: UpdateContractInput,
): Promise<FranchiseContract> {
  const existing = await prisma.franchiseContract.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Contract not found');
  if (existing.status !== 'DRAFT') {
    throw new BadRequestError('Only DRAFT contracts may be edited');
  }

  const updated = await prisma.franchiseContract.update({
    where: { id },
    data: {
      type: input.type,
      documentUrl: input.documentUrl ?? undefined,
      documentChecksum: input.documentChecksum ?? undefined,
      effectiveFrom: input.effectiveFrom === undefined ? undefined : input.effectiveFrom ? new Date(input.effectiveFrom) : null,
      effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo ? new Date(input.effectiveTo) : null,
      autoRenew: input.autoRenew,
      renewalNoticeMonths: input.renewalNoticeMonths,
      governingLaw: input.governingLaw ?? undefined,
      jurisdiction: input.jurisdiction ?? undefined,
      terms:
        input.terms === undefined
          ? undefined
          : input.terms === null
            ? Prisma.JsonNull
            : (input.terms as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'CONTRACT_UPDATED',
    category: 'CONTRACT',
    resourceType: 'FranchiseContract',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function submitForSignature(actor: FranchiseActor, id: string): Promise<FranchiseContract> {
  const existing = await prisma.franchiseContract.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Contract not found');
  assertContractTransition(existing.status, 'PENDING_SIGNATURE');
  if (!existing.documentUrl) throw new BadRequestError('Contract must have documentUrl before signature');

  const updated = await prisma.franchiseContract.update({
    where: { id },
    data: { status: 'PENDING_SIGNATURE' },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'CONTRACT_SUBMITTED_FOR_SIGNATURE',
    category: 'CONTRACT',
    resourceType: 'FranchiseContract',
    resourceId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function signContract(
  actor: FranchiseActor,
  id: string,
  input: SignContractInput,
): Promise<FranchiseContract> {
  const existing = await prisma.franchiseContract.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Contract not found');
  assertContractTransition(existing.status, 'ACTIVE');

  const updated = await prisma.franchiseContract.update({
    where: { id },
    data: {
      status: 'ACTIVE',
      signedAt: input.signedAt ? new Date(input.signedAt) : new Date(),
      signedByName: input.signedByName,
      signedByTitle: input.signedByTitle ?? null,
      effectiveFrom: existing.effectiveFrom ?? new Date(),
    },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'CONTRACT_SIGNED',
    category: 'CONTRACT',
    resourceType: 'FranchiseContract',
    resourceId: id,
    metadata: { signedByName: input.signedByName, signedByTitle: input.signedByTitle },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listContracts(opts: {
  unitId?: string;
  status?: ContractStatus;
  type?: import('@prisma/client').ContractType;
  scopeUnitIds?: Set<string>;
  limit?: number;
}) {
  return await prisma.franchiseContract.findMany({
    where: {
      ...(opts.unitId ? { unitId: opts.unitId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.scopeUnitIds ? { unitId: { in: Array.from(opts.scopeUnitIds) } } : {}),
    },
    include: {
      unit: { select: { id: true, code: true, name: true, level: true } },
      _count: { select: { renewals: true, terminations: true, violations: true } },
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

export async function getContract(id: string) {
  const contract = await prisma.franchiseContract.findUnique({
    where: { id },
    include: {
      unit: { select: { id: true, code: true, name: true, level: true, status: true } },
      renewals: { orderBy: { createdAt: 'desc' } },
      terminations: { orderBy: { createdAt: 'desc' } },
      violations: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });
  if (!contract) throw new NotFoundError('Contract not found');
  return contract;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renewals
// ─────────────────────────────────────────────────────────────────────────────

export async function requestRenewal(
  actor: FranchiseActor,
  contractId: string,
  input: RequestRenewalInput,
): Promise<FranchiseContractRenewal> {
  const contract = await prisma.franchiseContract.findUnique({ where: { id: contractId } });
  if (!contract) throw new NotFoundError('Contract not found');
  if (!['ACTIVE', 'RENEWED'].includes(contract.status)) {
    throw new BadRequestError(`Cannot renew a contract in status ${contract.status}`);
  }

  const open = await prisma.franchiseContractRenewal.findFirst({
    where: { contractId, status: { in: ['REQUESTED', 'APPROVED'] } },
  });
  if (open) throw new ConflictError(`Open renewal already exists (id=${open.id})`);

  const created = await prisma.franchiseContractRenewal.create({
    data: {
      contractId,
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      termsDelta:
        input.termsDelta === undefined || input.termsDelta === null
          ? undefined
          : (input.termsDelta as Prisma.InputJsonValue),
      notes: input.notes ?? null,
      status: 'REQUESTED',
    },
  });

  await writeFranchiseAudit({
    unitId: contract.unitId,
    userId: actor.userId,
    action: 'RENEWAL_REQUESTED',
    category: 'CONTRACT',
    resourceType: 'FranchiseContractRenewal',
    resourceId: created.id,
    metadata: { contractId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function decideRenewal(
  actor: FranchiseActor,
  renewalId: string,
  input: DecideRenewalInput,
): Promise<FranchiseContractRenewal> {
  const existing = await prisma.franchiseContractRenewal.findUnique({
    where: { id: renewalId },
    include: { contract: true },
  });
  if (!existing) throw new NotFoundError('Renewal not found');
  if (existing.status !== 'REQUESTED') {
    throw new BadRequestError(`Cannot decide a renewal in status ${existing.status}`);
  }

  const updated = await prisma.franchiseContractRenewal.update({
    where: { id: renewalId },
    data: {
      status: input.decision,
      approvedAt: input.decision === 'APPROVED' ? new Date() : null,
      decisionBy: actor.userId,
      notes: input.notes ?? existing.notes,
    },
  });

  await writeFranchiseAudit({
    unitId: existing.contract.unitId,
    userId: actor.userId,
    action: `RENEWAL_${input.decision}`,
    category: 'CONTRACT',
    resourceType: 'FranchiseContractRenewal',
    resourceId: renewalId,
    metadata: { contractId: existing.contractId, notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function executeRenewal(
  actor: FranchiseActor,
  renewalId: string,
): Promise<{ renewal: FranchiseContractRenewal; newContract: FranchiseContract }> {
  return await prisma.$transaction(async (tx) => {
    const renewal = await tx.franchiseContractRenewal.findUnique({
      where: { id: renewalId },
      include: { contract: true },
    });
    if (!renewal) throw new NotFoundError('Renewal not found');
    if (renewal.status !== 'APPROVED') {
      throw new BadRequestError(`Renewal must be APPROVED before execution (current: ${renewal.status})`);
    }
    if (renewal.renewedToContractId) {
      throw new ConflictError('Renewal already executed');
    }

    const original = renewal.contract;

    // Mark original as RENEWED
    await tx.franchiseContract.update({
      where: { id: original.id },
      data: { status: 'RENEWED', effectiveTo: renewal.effectiveFrom },
    });

    // Create a new contract version that inherits and applies term deltas
    const newContract = await tx.franchiseContract.create({
      data: {
        unitId: original.unitId,
        type: original.type,
        version: original.version + 1,
        status: 'ACTIVE',
        documentUrl: original.documentUrl,
        documentChecksum: original.documentChecksum,
        effectiveFrom: renewal.effectiveFrom,
        effectiveTo: renewal.effectiveTo,
        autoRenew: original.autoRenew,
        renewalNoticeMonths: original.renewalNoticeMonths,
        governingLaw: original.governingLaw,
        jurisdiction: original.jurisdiction,
        signedAt: new Date(),
        signedByName: original.signedByName,
        signedByTitle: original.signedByTitle,
        terms: (renewal.termsDelta ?? original.terms ?? undefined) as Prisma.InputJsonValue,
        createdBy: actor.userId,
      },
    });

    const updated = await tx.franchiseContractRenewal.update({
      where: { id: renewalId },
      data: { status: 'EXECUTED', executedAt: new Date(), renewedToContractId: newContract.id },
    });

    return { renewal: updated, newContract };
  }).then(async (r) => {
    await writeFranchiseAudit({
      unitId: r.newContract.unitId,
      userId: actor.userId,
      action: 'RENEWAL_EXECUTED',
      category: 'CONTRACT',
      resourceType: 'FranchiseContractRenewal',
      resourceId: r.renewal.id,
      metadata: { newContractId: r.newContract.id, version: r.newContract.version },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return r;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminations
// ─────────────────────────────────────────────────────────────────────────────

export async function initiateTermination(
  actor: FranchiseActor,
  contractId: string,
  input: InitiateTerminationInput,
): Promise<FranchiseContractTermination> {
  const contract = await prisma.franchiseContract.findUnique({ where: { id: contractId } });
  if (!contract) throw new NotFoundError('Contract not found');
  if (['TERMINATED', 'EXPIRED'].includes(contract.status)) {
    throw new BadRequestError(`Contract is already ${contract.status}`);
  }

  const open = await prisma.franchiseContractTermination.findFirst({
    where: { contractId, status: { in: ['REQUESTED', 'APPROVED'] } },
  });
  if (open) throw new ConflictError(`Open termination already exists (id=${open.id})`);

  const created = await prisma.franchiseContractTermination.create({
    data: {
      contractId,
      reason: input.reason,
      effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
      severance: input.severance ?? null,
      currency: input.currency ?? 'EUR',
      initiatedBy: actor.userId,
      notes: input.notes ?? null,
      status: 'REQUESTED',
    },
  });

  await writeFranchiseAudit({
    unitId: contract.unitId,
    userId: actor.userId,
    action: 'TERMINATION_REQUESTED',
    category: 'CONTRACT',
    resourceType: 'FranchiseContractTermination',
    resourceId: created.id,
    metadata: { reason: input.reason, severance: input.severance, effectiveDate: input.effectiveDate },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function decideTermination(
  actor: FranchiseActor,
  terminationId: string,
  input: DecideTerminationInput,
): Promise<FranchiseContractTermination> {
  const existing = await prisma.franchiseContractTermination.findUnique({
    where: { id: terminationId },
    include: { contract: true },
  });
  if (!existing) throw new NotFoundError('Termination not found');
  if (existing.status !== 'REQUESTED') {
    throw new BadRequestError(`Cannot decide a termination in status ${existing.status}`);
  }

  const updated = await prisma.franchiseContractTermination.update({
    where: { id: terminationId },
    data: {
      status: input.decision,
      approvedBy: input.decision === 'APPROVED' ? actor.userId : null,
      notes: input.notes ?? existing.notes,
    },
  });

  await writeFranchiseAudit({
    unitId: existing.contract.unitId,
    userId: actor.userId,
    action: `TERMINATION_${input.decision}`,
    category: 'CONTRACT',
    resourceType: 'FranchiseContractTermination',
    resourceId: terminationId,
    metadata: { contractId: existing.contractId, notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function executeTermination(
  actor: FranchiseActor,
  terminationId: string,
): Promise<{ termination: FranchiseContractTermination; contract: FranchiseContract }> {
  return await prisma.$transaction(async (tx) => {
    const termination = await tx.franchiseContractTermination.findUnique({
      where: { id: terminationId },
      include: { contract: true },
    });
    if (!termination) throw new NotFoundError('Termination not found');
    if (termination.status !== 'APPROVED') {
      throw new BadRequestError(`Termination must be APPROVED to execute (current: ${termination.status})`);
    }

    const effectiveDate = termination.effectiveDate ?? new Date();
    const contract = await tx.franchiseContract.update({
      where: { id: termination.contractId },
      data: { status: 'TERMINATED', effectiveTo: effectiveDate },
    });
    const updated = await tx.franchiseContractTermination.update({
      where: { id: terminationId },
      data: { status: 'EXECUTED', effectiveDate },
    });
    return { termination: updated, contract };
  }).then(async (r) => {
    await writeFranchiseAudit({
      unitId: r.contract.unitId,
      userId: actor.userId,
      action: 'TERMINATION_EXECUTED',
      category: 'CONTRACT',
      resourceType: 'FranchiseContractTermination',
      resourceId: r.termination.id,
      metadata: { contractId: r.contract.id, reason: r.termination.reason },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return r;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-expiry maintenance (run on cron)
// ─────────────────────────────────────────────────────────────────────────────

export async function expireDueContracts(): Promise<{ expired: number }> {
  const now = new Date();
  const due = await prisma.franchiseContract.findMany({
    where: {
      status: 'ACTIVE',
      effectiveTo: { lt: now, not: null },
      autoRenew: false,
    },
    take: 500,
    select: { id: true, unitId: true },
  });
  let expired = 0;
  for (const c of due) {
    await prisma.franchiseContract.update({
      where: { id: c.id },
      data: { status: 'EXPIRED' },
    });
    await writeFranchiseAudit({
      unitId: c.unitId,
      action: 'CONTRACT_EXPIRED',
      category: 'CONTRACT',
      resourceType: 'FranchiseContract',
      resourceId: c.id,
    });
    expired++;
  }
  return { expired };
}
