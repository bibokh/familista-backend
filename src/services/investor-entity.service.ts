// Familista — Global Investor Layer
// File location: src/services/investor-entity.service.ts
//
// InvestmentEntity CRUD + ShareClass CRUD + valuation history. Entities are
// what gets invested in: PLATFORM (Familista holding), FRANCHISE_UNIT, CLUB,
// or ACADEMY. The franchise/club bridges keep the cross-system links explicit
// without duplicating data.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  InvestmentEntity,
  InvestmentEntityType,
  ShareClass,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeInvestorAudit } from './investor-audit.service';
import type {
  CreateInvestmentEntityInput,
  UpdateInvestmentEntityInput,
  SetValuationInput,
  CreateShareClassInput,
  UpdateShareClassInput,
} from '../utils/investor.validators';
import type { InvestorActor } from '../types/investor.types';

// ─────────────────────────────────────────────────────────────────────────────
// Entity CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createEntity(
  actor: InvestorActor,
  input: CreateInvestmentEntityInput,
): Promise<InvestmentEntity> {
  if (input.code) {
    const collision = await prisma.investmentEntity.findUnique({ where: { code: input.code } });
    if (collision) throw new ConflictError(`Entity code "${input.code}" is already in use`);
  }

  if (input.franchiseUnitId) {
    const exists = await prisma.franchiseUnit.findUnique({ where: { id: input.franchiseUnitId } });
    if (!exists) throw new NotFoundError('Franchise unit not found');
    const dup = await prisma.investmentEntity.findUnique({ where: { franchiseUnitId: input.franchiseUnitId } });
    if (dup) throw new ConflictError('Investment entity already exists for that franchise unit');
  }

  if (input.clubId) {
    const exists = await prisma.club.findUnique({ where: { id: input.clubId } });
    if (!exists) throw new NotFoundError('Club not found');
    const dup = await prisma.investmentEntity.findUnique({ where: { clubId: input.clubId } });
    if (dup) throw new ConflictError('Investment entity already exists for that club');
  }

  const created = await prisma.investmentEntity.create({
    data: {
      type: input.type,
      name: input.name,
      code: input.code ?? null,
      description: input.description ?? null,
      franchiseUnitId: input.franchiseUnitId ?? null,
      clubId: input.clubId ?? null,
      currency: input.currency ?? 'EUR',
      currentValuation: input.currentValuation ?? null,
      lastValuationAt: input.currentValuation ? new Date() : null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeInvestorAudit({
    entityId: created.id,
    userId: actor.userId,
    action: 'ENTITY_CREATED',
    category: 'ENTITY',
    resourceType: 'InvestmentEntity',
    resourceId: created.id,
    metadata: { type: created.type, name: created.name, code: created.code },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateEntity(
  actor: InvestorActor,
  id: string,
  input: UpdateInvestmentEntityInput,
): Promise<InvestmentEntity> {
  const existing = await prisma.investmentEntity.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Entity not found');

  const updated = await prisma.investmentEntity.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? undefined,
      currency: input.currency,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      isActive: input.isActive,
    },
  });

  await writeInvestorAudit({
    entityId: id,
    userId: actor.userId,
    action: 'ENTITY_UPDATED',
    category: 'ENTITY',
    resourceType: 'InvestmentEntity',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function getEntity(id: string) {
  const entity = await prisma.investmentEntity.findUnique({
    where: { id },
    include: {
      shareClasses: { orderBy: [{ seniority: 'desc' }, { name: 'asc' }] },
      _count: { select: { rounds: true, investments: true, capTableEntries: true, exitEvents: true } },
    },
  });
  if (!entity) throw new NotFoundError('Entity not found');
  return entity;
}

export async function getEntityByFranchiseUnit(franchiseUnitId: string): Promise<InvestmentEntity | null> {
  return await prisma.investmentEntity.findUnique({ where: { franchiseUnitId } });
}

export async function getEntityByClub(clubId: string): Promise<InvestmentEntity | null> {
  return await prisma.investmentEntity.findUnique({ where: { clubId } });
}

export async function listEntities(opts: {
  type?: InvestmentEntityType;
  search?: string;
  scopeEntityIds?: Set<string>;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.investmentEntity.findMany({
    where: {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.search ? { name: { contains: opts.search, mode: 'insensitive' as const } } : {}),
      ...(opts.scopeEntityIds ? { id: { in: Array.from(opts.scopeEntityIds) } } : {}),
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function setValuation(
  actor: InvestorActor,
  id: string,
  input: SetValuationInput,
): Promise<InvestmentEntity> {
  const existing = await prisma.investmentEntity.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Entity not found');

  const updated = await prisma.investmentEntity.update({
    where: { id },
    data: {
      currentValuation: input.valuation,
      lastValuationAt: input.valuationDate ? new Date(input.valuationDate) : new Date(),
    },
  });

  await writeInvestorAudit({
    entityId: id,
    userId: actor.userId,
    action: 'VALUATION_SET',
    category: 'ENTITY',
    resourceType: 'InvestmentEntity',
    resourceId: id,
    metadata: {
      previousValuation: existing.currentValuation,
      newValuation: input.valuation,
      notes: input.notes,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Share class CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createShareClass(
  actor: InvestorActor,
  entityId: string,
  input: CreateShareClassInput,
): Promise<ShareClass> {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  const collision = await prisma.shareClass.findFirst({ where: { entityId, code: input.code } });
  if (collision) throw new ConflictError(`Share class code "${input.code}" already exists for this entity`);

  const created = await prisma.shareClass.create({
    data: {
      entityId,
      name: input.name,
      code: input.code,
      category: input.category,
      seniority: input.seniority ?? 0,
      liquidationPreference: input.liquidationPreference ?? 1.0,
      participating: input.participating ?? false,
      participationCap: input.participationCap ?? null,
      votingMultiple: input.votingMultiple ?? 1.0,
      dividendRate: input.dividendRate ?? null,
      cumulativeDividends: input.cumulativeDividends ?? false,
      convertibleToCode: input.convertibleToCode ?? null,
      antiDilutionType: input.antiDilutionType ?? 'NONE',
      totalAuthorized: input.totalAuthorized ?? 0,
    },
  });

  await writeInvestorAudit({
    entityId,
    userId: actor.userId,
    action: 'SHARE_CLASS_CREATED',
    category: 'ENTITY',
    resourceType: 'ShareClass',
    resourceId: created.id,
    metadata: { code: created.code, category: created.category, seniority: created.seniority },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateShareClass(
  actor: InvestorActor,
  id: string,
  input: UpdateShareClassInput,
): Promise<ShareClass> {
  const existing = await prisma.shareClass.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Share class not found');

  if (input.code && input.code !== existing.code) {
    const collision = await prisma.shareClass.findFirst({
      where: { entityId: existing.entityId, code: input.code, NOT: { id } },
    });
    if (collision) throw new ConflictError(`Share class code "${input.code}" already exists for this entity`);
  }

  if (input.totalAuthorized != null && input.totalAuthorized < existing.totalIssued) {
    throw new BadRequestError(
      `Cannot reduce totalAuthorized (${input.totalAuthorized}) below totalIssued (${existing.totalIssued})`,
    );
  }

  const updated = await prisma.shareClass.update({
    where: { id },
    data: {
      name: input.name,
      code: input.code,
      category: input.category,
      seniority: input.seniority,
      liquidationPreference: input.liquidationPreference,
      participating: input.participating,
      participationCap: input.participationCap === undefined ? undefined : input.participationCap,
      votingMultiple: input.votingMultiple,
      dividendRate: input.dividendRate === undefined ? undefined : input.dividendRate,
      cumulativeDividends: input.cumulativeDividends,
      convertibleToCode: input.convertibleToCode === undefined ? undefined : input.convertibleToCode,
      antiDilutionType: input.antiDilutionType,
      totalAuthorized: input.totalAuthorized,
    },
  });

  await writeInvestorAudit({
    entityId: existing.entityId,
    userId: actor.userId,
    action: 'SHARE_CLASS_UPDATED',
    category: 'ENTITY',
    resourceType: 'ShareClass',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listShareClasses(entityId: string): Promise<ShareClass[]> {
  return await prisma.shareClass.findMany({
    where: { entityId },
    orderBy: [{ seniority: 'desc' }, { name: 'asc' }],
  });
}

export async function getShareClass(id: string): Promise<ShareClass> {
  const sc = await prisma.shareClass.findUnique({ where: { id } });
  if (!sc) throw new NotFoundError('Share class not found');
  return sc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap helper — ensure the Familista PLATFORM entity exists
// ─────────────────────────────────────────────────────────────────────────────

export async function ensurePlatformEntity(name = 'Familista OS'): Promise<InvestmentEntity> {
  let entity = await prisma.investmentEntity.findFirst({ where: { type: 'PLATFORM' } });
  if (entity) return entity;

  entity = await prisma.investmentEntity.create({
    data: {
      type: 'PLATFORM',
      name,
      code: 'FAMILISTA-PLATFORM',
      description: 'Familista OS platform holding company.',
      currency: 'EUR',
    },
  });

  await writeInvestorAudit({
    entityId: entity.id,
    action: 'PLATFORM_ENTITY_BOOTSTRAPPED',
    category: 'ENTITY',
    resourceType: 'InvestmentEntity',
    resourceId: entity.id,
    metadata: { name },
  });

  return entity;
}
