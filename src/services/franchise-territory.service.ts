// Familista — Franchise Expansion Engine
// File location: src/services/franchise-territory.service.ts
//
// Territory hierarchy (country → state/region → city → district), territory
// rights (exclusivity / non-exclusive / first-refusal), conflict detection,
// and expansion-opportunity scoring.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  Territory,
  TerritoryType,
  TerritoryRight,
  TerritoryRightType,
  FranchiseLevel,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import type {
  CreateTerritoryInput,
  UpdateTerritoryInput,
  GrantTerritoryRightInput,
  UpdateTerritoryRightInput,
} from '../utils/franchise.validators';
import type { FranchiseActor, TerritoryNode, ExpansionOpportunity } from '../types/franchise.types';

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy rules — which parent types may contain which child types
// ─────────────────────────────────────────────────────────────────────────────

const TERRITORY_PARENT_RULES: Record<TerritoryType, ReadonlyArray<TerritoryType> | null> = {
  COUNTRY: null,
  STATE: ['COUNTRY'],
  REGION: ['COUNTRY', 'STATE'],
  CITY: ['STATE', 'REGION', 'COUNTRY'],
  DISTRICT: ['CITY'],
};

function assertParentTypeAllowed(childType: TerritoryType, parentType: TerritoryType | null): void {
  const allowedParents = TERRITORY_PARENT_RULES[childType];
  if (allowedParents === null) {
    if (parentType !== null) {
      throw new BadRequestError(`${childType} territories cannot have a parent`);
    }
    return;
  }
  if (parentType === null) {
    throw new BadRequestError(`${childType} requires a parent of type ${allowedParents.join(' | ')}`);
  }
  if (!allowedParents.includes(parentType)) {
    throw new BadRequestError(
      `${childType} cannot be nested under ${parentType}; allowed parents: ${allowedParents.join(' | ')}`,
    );
  }
}

function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function computeFullPath(name: string, code: string | null | undefined, parentId: string | null): Promise<string> {
  const segment = (code ?? slugify(name)).toLowerCase();
  if (!parentId) return segment;
  const parent = await prisma.territory.findUnique({ where: { id: parentId }, select: { fullPath: true } });
  if (!parent) throw new NotFoundError('Parent territory not found');
  return `${parent.fullPath}.${segment}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Territory CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createTerritory(
  actor: FranchiseActor,
  input: CreateTerritoryInput,
): Promise<Territory> {
  let parentType: TerritoryType | null = null;
  if (input.parentId) {
    const parent = await prisma.territory.findUnique({ where: { id: input.parentId } });
    if (!parent) throw new NotFoundError('Parent territory not found');
    parentType = parent.type;
  }
  assertParentTypeAllowed(input.type, parentType);

  const fullPath = await computeFullPath(input.name, input.code, input.parentId ?? null);

  const conflict = await prisma.territory.findUnique({ where: { fullPath } });
  if (conflict) throw new ConflictError(`Territory with path "${fullPath}" already exists`);

  const created = await prisma.territory.create({
    data: {
      type: input.type,
      code: input.code ?? null,
      name: input.name,
      fullPath,
      parentId: input.parentId ?? null,
      population: input.population ?? null,
      currency: input.currency ?? null,
      timezone: input.timezone ?? null,
      metadata: input.metadata === undefined || input.metadata === null
        ? undefined
        : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    userId: actor.userId,
    action: 'TERRITORY_CREATED',
    category: 'TERRITORY',
    resourceType: 'Territory',
    resourceId: created.id,
    metadata: { type: created.type, fullPath: created.fullPath, parentId: created.parentId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateTerritory(
  actor: FranchiseActor,
  id: string,
  input: UpdateTerritoryInput,
): Promise<Territory> {
  const existing = await prisma.territory.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Territory not found');

  let fullPath = existing.fullPath;
  if (input.name || input.code !== undefined || input.parentId !== undefined) {
    const newName = input.name ?? existing.name;
    const newCode = input.code === undefined ? existing.code : input.code;
    const newParentId = input.parentId === undefined ? existing.parentId : input.parentId;

    if (input.parentId !== undefined) {
      let parentType: TerritoryType | null = null;
      if (newParentId) {
        if (newParentId === id) throw new BadRequestError('Territory cannot be its own parent');
        const parent = await prisma.territory.findUnique({ where: { id: newParentId } });
        if (!parent) throw new NotFoundError('Parent territory not found');
        parentType = parent.type;
      }
      assertParentTypeAllowed(existing.type, parentType);
    }

    fullPath = await computeFullPath(newName, newCode, newParentId);
    if (fullPath !== existing.fullPath) {
      const collision = await prisma.territory.findUnique({ where: { fullPath } });
      if (collision && collision.id !== id) {
        throw new ConflictError(`Territory with path "${fullPath}" already exists`);
      }
    }
  }

  const updated = await prisma.territory.update({
    where: { id },
    data: {
      type: undefined, // immutable post-creation
      code: input.code === undefined ? undefined : input.code,
      name: input.name,
      parentId: input.parentId === undefined ? undefined : input.parentId,
      fullPath,
      population: input.population,
      currency: input.currency,
      timezone: input.timezone,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    userId: actor.userId,
    action: 'TERRITORY_UPDATED',
    category: 'TERRITORY',
    resourceType: 'Territory',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function deleteTerritory(actor: FranchiseActor, id: string): Promise<void> {
  const existing = await prisma.territory.findUnique({
    where: { id },
    include: { _count: { select: { children: true, units: true, territoryRights: true } } },
  });
  if (!existing) throw new NotFoundError('Territory not found');
  if (existing._count.children > 0) {
    throw new ConflictError(`Territory has ${existing._count.children} child territories`);
  }
  if (existing._count.units > 0) {
    throw new ConflictError(`Territory is referenced by ${existing._count.units} franchise units`);
  }
  if (existing._count.territoryRights > 0) {
    throw new ConflictError(`Territory has ${existing._count.territoryRights} territory rights granted`);
  }

  await prisma.territory.delete({ where: { id } });

  await writeFranchiseAudit({
    userId: actor.userId,
    action: 'TERRITORY_DELETED',
    category: 'TERRITORY',
    resourceType: 'Territory',
    resourceId: id,
    metadata: { fullPath: existing.fullPath },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function listTerritories(opts: {
  type?: TerritoryType;
  parentId?: string | null;
  search?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const items = await prisma.territory.findMany({
    where: {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.parentId === null
        ? { parentId: null }
        : opts.parentId
          ? { parentId: opts.parentId }
          : {}),
      ...(opts.search ? { name: { contains: opts.search, mode: 'insensitive' as const } } : {}),
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

const MAX_TREE_DEPTH = 6;

export async function getTerritoryTree(rootId: string | null): Promise<TerritoryNode[]> {
  const roots = await prisma.territory.findMany({
    where: rootId ? { id: rootId } : { parentId: null },
    orderBy: [{ name: 'asc' }],
  });

  async function expand(node: Territory, depth: number): Promise<TerritoryNode> {
    if (depth >= MAX_TREE_DEPTH) {
      return { ...node, children: [] };
    }
    const children = await prisma.territory.findMany({
      where: { parentId: node.id },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    const expanded = await Promise.all(children.map((c) => expand(c, depth + 1)));
    return { ...node, children: expanded };
  }

  return await Promise.all(roots.map((r) => expand(r, 0)));
}

export async function getTerritoryPath(id: string): Promise<Territory[]> {
  const ancestors: Territory[] = [];
  let currentId: string | null = id;
  let safety = 0;
  while (currentId && safety++ < MAX_TREE_DEPTH + 2) {
    const node: Territory | null = await prisma.territory.findUnique({ where: { id: currentId } });
    if (!node) break;
    ancestors.unshift(node);
    currentId = node.parentId;
  }
  if (ancestors.length === 0) throw new NotFoundError('Territory not found');
  return ancestors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Territory rights
// ─────────────────────────────────────────────────────────────────────────────

export async function checkExclusivityConflict(
  territoryId: string,
  level: FranchiseLevel | null,
  type: TerritoryRightType,
  excludeRightId?: string,
): Promise<TerritoryRight[]> {
  if (type !== 'EXCLUSIVE') return [];

  const conflicts = await prisma.territoryRight.findMany({
    where: {
      territoryId,
      isActive: true,
      type: 'EXCLUSIVE',
      ...(level ? { OR: [{ level }, { level: null }] } : {}),
      ...(excludeRightId ? { NOT: { id: excludeRightId } } : {}),
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
    },
    include: { unit: { select: { id: true, code: true, name: true } } },
  });

  return conflicts;
}

export async function grantTerritoryRight(
  actor: FranchiseActor,
  unitId: string,
  input: GrantTerritoryRightInput,
): Promise<TerritoryRight> {
  const unit = await prisma.franchiseUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw new NotFoundError('Franchise unit not found');

  const territory = await prisma.territory.findUnique({ where: { id: input.territoryId } });
  if (!territory) throw new NotFoundError('Territory not found');

  const rightType = input.type ?? 'NON_EXCLUSIVE';
  const conflicts = await checkExclusivityConflict(input.territoryId, input.level ?? null, rightType);
  if (conflicts.length > 0) {
    throw new ConflictError(
      `Exclusive right already held by unit(s): ${conflicts.map((c) => c.unitId).join(', ')}`,
    );
  }

  const right = await prisma.territoryRight.create({
    data: {
      unitId,
      territoryId: input.territoryId,
      type: rightType,
      level: input.level ?? null,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      notes: input.notes ?? null,
      isActive: true,
    },
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'TERRITORY_RIGHT_GRANTED',
    category: 'TERRITORY',
    resourceType: 'TerritoryRight',
    resourceId: right.id,
    metadata: { territoryId: input.territoryId, type: rightType, level: input.level ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return right;
}

export async function updateTerritoryRight(
  actor: FranchiseActor,
  rightId: string,
  input: UpdateTerritoryRightInput,
): Promise<TerritoryRight> {
  const existing = await prisma.territoryRight.findUnique({ where: { id: rightId } });
  if (!existing) throw new NotFoundError('Territory right not found');

  if (input.type === 'EXCLUSIVE' && existing.type !== 'EXCLUSIVE') {
    const conflicts = await checkExclusivityConflict(
      existing.territoryId,
      input.level === undefined ? existing.level : input.level,
      'EXCLUSIVE',
      rightId,
    );
    if (conflicts.length > 0) {
      throw new ConflictError('Cannot upgrade to EXCLUSIVE: conflicting active right exists');
    }
  }

  const updated = await prisma.territoryRight.update({
    where: { id: rightId },
    data: {
      type: input.type,
      level: input.level === undefined ? undefined : input.level,
      effectiveTo: input.effectiveTo === undefined ? undefined : (input.effectiveTo ? new Date(input.effectiveTo) : null),
      isActive: input.isActive,
      notes: input.notes ?? undefined,
    },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'TERRITORY_RIGHT_UPDATED',
    category: 'TERRITORY',
    resourceType: 'TerritoryRight',
    resourceId: rightId,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function revokeTerritoryRight(actor: FranchiseActor, rightId: string): Promise<void> {
  const existing = await prisma.territoryRight.findUnique({ where: { id: rightId } });
  if (!existing) throw new NotFoundError('Territory right not found');

  await prisma.territoryRight.update({
    where: { id: rightId },
    data: { isActive: false, effectiveTo: new Date() },
  });

  await writeFranchiseAudit({
    unitId: existing.unitId,
    userId: actor.userId,
    action: 'TERRITORY_RIGHT_REVOKED',
    category: 'TERRITORY',
    resourceType: 'TerritoryRight',
    resourceId: rightId,
    metadata: { territoryId: existing.territoryId, type: existing.type },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function listTerritoryRights(opts: {
  unitId?: string;
  territoryId?: string;
  type?: TerritoryRightType;
  activeOnly?: boolean;
}): Promise<TerritoryRight[]> {
  return await prisma.territoryRight.findMany({
    where: {
      ...(opts.unitId ? { unitId: opts.unitId } : {}),
      ...(opts.territoryId ? { territoryId: opts.territoryId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.activeOnly !== false ? { isActive: true } : {}),
    },
    orderBy: [{ effectiveFrom: 'desc' }],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Expansion opportunities — territories without active exclusive rights
// ─────────────────────────────────────────────────────────────────────────────

export async function listExpansionOpportunities(opts: {
  type?: TerritoryType;
  parentId?: string;
  limit?: number;
}): Promise<ExpansionOpportunity[]> {
  const territories = await prisma.territory.findMany({
    where: {
      isActive: true,
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
    orderBy: [{ population: 'desc' }],
  });

  const opportunities: ExpansionOpportunity[] = [];
  for (const t of territories) {
    const [activeRights, unitCount] = await Promise.all([
      prisma.territoryRight.findMany({
        where: {
          territoryId: t.id,
          isActive: true,
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
        },
      }),
      prisma.franchiseUnit.count({ where: { territoryId: t.id, status: 'ACTIVE' } }),
    ]);

    const exclusive = activeRights.find((r) => r.type === 'EXCLUSIVE');
    const competitionScore = Math.min(100, unitCount * 25);
    const populationScore = t.population ? Math.min(50, Math.log10(Math.max(1, t.population)) * 8) : 0;
    const protectionPenalty = exclusive ? 60 : activeRights.length * 5;
    const opportunityScore = Math.max(0, populationScore + 30 - competitionScore - protectionPenalty);

    const reasons: string[] = [];
    if (exclusive) reasons.push(`Exclusive right held by unit ${exclusive.unitId}`);
    if (unitCount > 0) reasons.push(`${unitCount} active unit(s) already present`);
    if (t.population && t.population > 1_000_000) reasons.push('Large population centre');
    if (activeRights.length === 0 && unitCount === 0) reasons.push('Greenfield — no rights or units');

    opportunities.push({
      territoryId: t.id,
      territoryName: t.name,
      territoryType: t.type,
      fullPath: t.fullPath,
      population: t.population,
      hasActiveUnits: unitCount > 0,
      hasExclusiveRight: !!exclusive,
      reservedByUnitId: exclusive?.unitId ?? null,
      competitionScore,
      opportunityScore: Math.round(opportunityScore * 10) / 10,
      reasons,
    });
  }

  opportunities.sort((a, b) => b.opportunityScore - a.opportunityScore);
  return opportunities;
}
