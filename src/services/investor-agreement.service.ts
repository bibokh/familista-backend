// Familista — Global Investor Layer
// File location: src/services/investor-agreement.service.ts
//
// Legal agreements (SAFE, SPA, shareholder agreement, exit agreement, etc).
// State machine: DRAFT → PENDING_SIGNATURE → EXECUTED → (TERMINATED|SUPERSEDED).

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  AgreementStatus,
  AgreementType,
  InvestmentAgreement,
} from '@prisma/client';
import {
  BadRequestError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  CreateAgreementInput,
  UpdateAgreementInput,
  SignAgreementInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

const STATUS_TRANSITIONS: Record<AgreementStatus, ReadonlyArray<AgreementStatus>> = {
  DRAFT:             ['PENDING_SIGNATURE', 'TERMINATED'],
  PENDING_SIGNATURE: ['EXECUTED', 'DRAFT', 'TERMINATED'],
  EXECUTED:          ['TERMINATED', 'SUPERSEDED'],
  TERMINATED:        [],
  SUPERSEDED:        [],
};

function assertTransition(from: AgreementStatus, to: AgreementStatus): void {
  if (from === to) return;
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Agreement status transition ${from} → ${to} not allowed`);
  }
}

export async function createAgreement(
  actor: InvestorActor,
  entityId: string,
  input: CreateAgreementInput,
): Promise<InvestmentAgreement> {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  if (input.investmentId) {
    const inv = await prisma.investment.findUnique({ where: { id: input.investmentId } });
    if (!inv) throw new NotFoundError('Investment not found');
    if (inv.entityId !== entityId) throw new BadRequestError('Investment belongs to a different entity');
  }

  if (input.roundId) {
    const round = await prisma.investmentRound.findUnique({ where: { id: input.roundId } });
    if (!round) throw new NotFoundError('Round not found');
    if (round.entityId !== entityId) throw new BadRequestError('Round belongs to a different entity');
  }

  const latestVersion = await prisma.investmentAgreement.aggregate({
    where: { entityId, type: input.type, investmentId: input.investmentId ?? null },
    _max: { version: true },
  });

  const created = await prisma.investmentAgreement.create({
    data: {
      entityId,
      investmentId: input.investmentId ?? null,
      roundId: input.roundId ?? null,
      investorId: input.investorId ?? null,
      type: input.type,
      status: 'DRAFT',
      version: (latestVersion._max.version ?? 0) + 1,
      documentUrl: input.documentUrl ?? null,
      documentChecksum: input.documentChecksum ?? null,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      terms:
        input.terms === undefined || input.terms === null
          ? undefined
          : (input.terms as Prisma.InputJsonValue),
      governingLaw: input.governingLaw ?? null,
      jurisdiction: input.jurisdiction ?? null,
      notes: input.notes ?? null,
    },
  });

  await writeInvestorAudit({
    entityId,
    investorId: input.investorId ?? null,
    userId: actor.userId,
    action: 'AGREEMENT_CREATED',
    category: 'AGREEMENT',
    resourceType: 'InvestmentAgreement',
    resourceId: created.id,
    metadata: { type: created.type, version: created.version },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateAgreement(
  actor: InvestorActor,
  id: string,
  input: UpdateAgreementInput,
): Promise<InvestmentAgreement> {
  const existing = await prisma.investmentAgreement.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Agreement not found');
  if (existing.status !== 'DRAFT') {
    throw new BadRequestError('Only DRAFT agreements may be edited');
  }

  const updated = await prisma.investmentAgreement.update({
    where: { id },
    data: {
      type: input.type,
      investmentId: input.investmentId === undefined ? undefined : input.investmentId,
      roundId: input.roundId === undefined ? undefined : input.roundId,
      investorId: input.investorId === undefined ? undefined : input.investorId,
      documentUrl: input.documentUrl ?? undefined,
      documentChecksum: input.documentChecksum ?? undefined,
      effectiveFrom: input.effectiveFrom === undefined ? undefined : input.effectiveFrom ? new Date(input.effectiveFrom) : null,
      effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo ? new Date(input.effectiveTo) : null,
      terms:
        input.terms === undefined
          ? undefined
          : input.terms === null
            ? Prisma.JsonNull
            : (input.terms as Prisma.InputJsonValue),
      governingLaw: input.governingLaw ?? undefined,
      jurisdiction: input.jurisdiction ?? undefined,
      notes: input.notes ?? undefined,
    },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    investorId: existing.investorId,
    userId: actor.userId,
    action: 'AGREEMENT_UPDATED',
    category: 'AGREEMENT',
    resourceType: 'InvestmentAgreement',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function submitForSignature(actor: InvestorActor, id: string): Promise<InvestmentAgreement> {
  const existing = await prisma.investmentAgreement.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Agreement not found');
  assertTransition(existing.status, 'PENDING_SIGNATURE');
  if (!existing.documentUrl) throw new BadRequestError('Agreement must have documentUrl before signature');

  const updated = await prisma.investmentAgreement.update({
    where: { id },
    data: { status: 'PENDING_SIGNATURE' },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    investorId: existing.investorId,
    userId: actor.userId,
    action: 'AGREEMENT_SUBMITTED_FOR_SIGNATURE',
    category: 'AGREEMENT',
    resourceType: 'InvestmentAgreement',
    resourceId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function signAgreement(
  actor: InvestorActor,
  id: string,
  input: SignAgreementInput,
): Promise<InvestmentAgreement> {
  const existing = await prisma.investmentAgreement.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Agreement not found');
  assertTransition(existing.status, 'EXECUTED');

  const updated = await prisma.investmentAgreement.update({
    where: { id },
    data: {
      status: 'EXECUTED',
      signedAt: input.signedAt ? new Date(input.signedAt) : new Date(),
      signedByName: input.signedByName,
      signedByTitle: input.signedByTitle ?? null,
      effectiveFrom: existing.effectiveFrom ?? new Date(),
    },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    investorId: existing.investorId,
    userId: actor.userId,
    action: 'AGREEMENT_SIGNED',
    category: 'AGREEMENT',
    resourceType: 'InvestmentAgreement',
    resourceId: id,
    metadata: { signedByName: input.signedByName, signedByTitle: input.signedByTitle },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function terminateAgreement(
  actor: InvestorActor,
  id: string,
  reason: string,
): Promise<InvestmentAgreement> {
  const existing = await prisma.investmentAgreement.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Agreement not found');
  assertTransition(existing.status, 'TERMINATED');

  const updated = await prisma.investmentAgreement.update({
    where: { id },
    data: { status: 'TERMINATED', effectiveTo: new Date(), notes: reason },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    investorId: existing.investorId,
    userId: actor.userId,
    action: 'AGREEMENT_TERMINATED',
    category: 'AGREEMENT',
    resourceType: 'InvestmentAgreement',
    resourceId: id,
    metadata: { reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listAgreements(opts: {
  entityId?: string;
  investmentId?: string;
  investorId?: string;
  type?: AgreementType;
  status?: AgreementStatus;
  scopeEntityIds?: Set<string>;
  limit?: number;
}): Promise<InvestmentAgreement[]> {
  return await prisma.investmentAgreement.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      ...(opts.investmentId ? { investmentId: opts.investmentId } : {}),
      ...(opts.investorId ? { investorId: opts.investorId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.scopeEntityIds ? { entityId: { in: Array.from(opts.scopeEntityIds) } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

export async function getAgreement(id: string) {
  const agr = await prisma.investmentAgreement.findUnique({
    where: { id },
    include: {
      investment: { select: { id: true, instrumentType: true, committedAmount: true, currency: true } },
      round: { select: { id: true, name: true, type: true } },
      investor: { select: { id: true, displayName: true, type: true } },
    },
  });
  if (!agr) throw new NotFoundError('Agreement not found');
  return agr;
}
