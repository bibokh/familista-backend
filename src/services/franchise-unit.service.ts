// Familista — Franchise Expansion Engine
// File location: src/services/franchise-unit.service.ts
//
// Franchise unit hierarchy (Master → Regional → Local → Academy) with parent-
// child rule enforcement, status transitions, club attachment, and ancestor /
// descendant traversal helpers used by the access-scope middleware.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  FranchiseLevel,
  FranchiseStatus,
  FranchiseUnit,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeFranchiseAudit } from './franchise-audit.service';
import type {
  CreateFranchiseUnitInput,
  UpdateFranchiseUnitInput,
  SetUnitStatusInput,
} from '../utils/franchise.validators';
import type { FranchiseActor, FranchiseNode } from '../types/franchise.types';

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy rules — strict containment
// ─────────────────────────────────────────────────────────────────────────────

const UNIT_PARENT_RULES: Record<FranchiseLevel, ReadonlyArray<FranchiseLevel> | null> = {
  MASTER: null,
  REGIONAL: ['MASTER'],
  LOCAL: ['REGIONAL', 'MASTER'],
  ACADEMY: ['LOCAL'],
};

function assertParentLevelAllowed(childLevel: FranchiseLevel, parentLevel: FranchiseLevel | null): void {
  const allowedParents = UNIT_PARENT_RULES[childLevel];
  if (allowedParents === null) {
    if (parentLevel !== null) throw new BadRequestError(`${childLevel} cannot have a parent unit`);
    return;
  }
  if (parentLevel === null) {
    throw new BadRequestError(`${childLevel} requires a parent of level ${allowedParents.join(' | ')}`);
  }
  if (!allowedParents.includes(parentLevel)) {
    throw new BadRequestError(
      `${childLevel} cannot be nested under ${parentLevel}; allowed parents: ${allowedParents.join(' | ')}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status transition matrix
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TRANSITIONS: Record<FranchiseStatus, ReadonlyArray<FranchiseStatus>> = {
  PENDING:     ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  ACTIVE:      ['SUSPENDED', 'IN_RENEWAL', 'TERMINATED'],
  SUSPENDED:   ['ACTIVE', 'TERMINATED'],
  IN_RENEWAL:  ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  TERMINATED:  [],
};

function assertStatusTransition(from: FranchiseStatus, to: FranchiseStatus): void {
  if (from === to) return;
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new BadRequestError(`Status transition ${from} → ${to} not allowed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createUnit(
  actor: FranchiseActor,
  input: CreateFranchiseUnitInput,
): Promise<FranchiseUnit> {
  const codeCollision = await prisma.franchiseUnit.findUnique({ where: { code: input.code } });
  if (codeCollision) throw new ConflictError(`Unit code "${input.code}" is already in use`);

  let parentLevel: FranchiseLevel | null = null;
  if (input.parentUnitId) {
    const parent = await prisma.franchiseUnit.findUnique({ where: { id: input.parentUnitId } });
    if (!parent) throw new NotFoundError('Parent unit not found');
    if (parent.status === 'TERMINATED') {
      throw new BadRequestError('Cannot attach a new unit under a terminated parent');
    }
    parentLevel = parent.level;
  }
  assertParentLevelAllowed(input.level, parentLevel);

  if (input.territoryId) {
    const territory = await prisma.territory.findUnique({ where: { id: input.territoryId } });
    if (!territory) throw new NotFoundError('Territory not found');
  }

  const created = await prisma.franchiseUnit.create({
    data: {
      code: input.code,
      name: input.name,
      level: input.level,
      ownershipModel: input.ownershipModel ?? 'SINGLE_OWNER',
      parentUnitId: input.parentUnitId ?? null,
      territoryId: input.territoryId ?? null,
      legalName: input.legalName ?? null,
      taxId: input.taxId ?? null,
      registrationNo: input.registrationNo ?? null,
      address: input.address ?? null,
      countryCode: input.countryCode ?? null,
      currency: input.currency ?? 'EUR',
      foundedAt: input.foundedAt ? new Date(input.foundedAt) : null,
      launchedAt: input.launchedAt ? new Date(input.launchedAt) : null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    unitId: created.id,
    userId: actor.userId,
    action: 'UNIT_CREATED',
    category: 'HIERARCHY',
    resourceType: 'FranchiseUnit',
    resourceId: created.id,
    metadata: { code: created.code, level: created.level, parentUnitId: created.parentUnitId, territoryId: created.territoryId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateUnit(
  actor: FranchiseActor,
  id: string,
  input: UpdateFranchiseUnitInput,
): Promise<FranchiseUnit> {
  const existing = await prisma.franchiseUnit.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Unit not found');
  if (existing.status === 'TERMINATED') {
    throw new BadRequestError('Terminated units cannot be modified');
  }

  if (input.parentUnitId !== undefined && input.parentUnitId !== existing.parentUnitId) {
    if (input.parentUnitId === id) throw new BadRequestError('A unit cannot be its own parent');
    let parentLevel: FranchiseLevel | null = null;
    if (input.parentUnitId) {
      // prevent cycles: walk up from the prospective parent and abort if we hit id
      let cursor: string | null = input.parentUnitId;
      let safety = 0;
      while (cursor && safety++ < 12) {
        if (cursor === id) throw new BadRequestError('Move would create a cycle in the hierarchy');
        const ancestor: { id: string; parentUnitId: string | null; level: FranchiseLevel } | null =
          await prisma.franchiseUnit.findUnique({
            where: { id: cursor },
            select: { id: true, parentUnitId: true, level: true },
          });
        if (!ancestor) break;
        if (!parentLevel) parentLevel = ancestor.level;
        cursor = ancestor.parentUnitId;
      }
    }
    assertParentLevelAllowed(existing.level, parentLevel);
  }

  if (input.status && input.status !== existing.status) {
    assertStatusTransition(existing.status, input.status);
  }

  const updated = await prisma.franchiseUnit.update({
    where: { id },
    data: {
      name: input.name,
      ownershipModel: input.ownershipModel,
      parentUnitId: input.parentUnitId === undefined ? undefined : input.parentUnitId,
      territoryId: input.territoryId === undefined ? undefined : input.territoryId,
      legalName: input.legalName ?? undefined,
      taxId: input.taxId ?? undefined,
      registrationNo: input.registrationNo ?? undefined,
      address: input.address ?? undefined,
      countryCode: input.countryCode ?? undefined,
      currency: input.currency,
      foundedAt: input.foundedAt === undefined ? undefined : input.foundedAt ? new Date(input.foundedAt) : null,
      launchedAt: input.launchedAt === undefined ? undefined : input.launchedAt ? new Date(input.launchedAt) : null,
      status: input.status,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeFranchiseAudit({
    unitId: id,
    userId: actor.userId,
    action: 'UNIT_UPDATED',
    category: 'HIERARCHY',
    resourceType: 'FranchiseUnit',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function setUnitStatus(
  actor: FranchiseActor,
  id: string,
  input: SetUnitStatusInput,
): Promise<FranchiseUnit> {
  const existing = await prisma.franchiseUnit.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Unit not found');
  assertStatusTransition(existing.status, input.status);

  const updated = await prisma.franchiseUnit.update({
    where: { id },
    data: { status: input.status },
  });

  await writeFranchiseAudit({
    unitId: id,
    userId: actor.userId,
    action: 'UNIT_STATUS_CHANGED',
    category: 'HIERARCHY',
    resourceType: 'FranchiseUnit',
    resourceId: id,
    metadata: { from: existing.status, to: input.status, reason: input.reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function getUnit(id: string) {
  const unit = await prisma.franchiseUnit.findUnique({
    where: { id },
    include: {
      parentUnit: { select: { id: true, code: true, name: true, level: true } },
      territory: true,
      ownerships: {
        where: { effectiveTo: null },
        include: { owner: true },
        orderBy: [{ isPrimary: 'desc' }, { equityPercent: 'desc' }],
      },
      _count: { select: { clubs: true, childUnits: true, violations: true, contracts: true } },
    },
  });
  if (!unit) throw new NotFoundError('Unit not found');
  return unit;
}

export async function listUnits(opts: {
  level?: FranchiseLevel;
  status?: FranchiseStatus;
  parentUnitId?: string | null;
  territoryId?: string;
  search?: string;
  scopeUnitIds?: Set<string>;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.franchiseUnit.findMany({
    where: {
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.parentUnitId === null
        ? { parentUnitId: null }
        : opts.parentUnitId
          ? { parentUnitId: opts.parentUnitId }
          : {}),
      ...(opts.territoryId ? { territoryId: opts.territoryId } : {}),
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search, mode: 'insensitive' as const } },
              { code: { contains: opts.search, mode: 'insensitive' as const } },
              { legalName: { contains: opts.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(opts.scopeUnitIds ? { id: { in: Array.from(opts.scopeUnitIds) } } : {}),
    },
    include: {
      territory: { select: { id: true, name: true, type: true, fullPath: true } },
      _count: { select: { clubs: true, childUnits: true } },
    },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy traversal — used by access scope and revenue resolution
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HIERARCHY_DEPTH = 8;

export async function getDescendantUnitIds(rootIds: Iterable<string>): Promise<Set<string>> {
  const result = new Set<string>();
  let frontier = new Set<string>();
  for (const r of rootIds) {
    result.add(r);
    frontier.add(r);
  }
  let depth = 0;
  while (frontier.size > 0 && depth++ < MAX_HIERARCHY_DEPTH) {
    const children = await prisma.franchiseUnit.findMany({
      where: { parentUnitId: { in: Array.from(frontier) } },
      select: { id: true },
    });
    const next = new Set<string>();
    for (const c of children) {
      if (!result.has(c.id)) {
        result.add(c.id);
        next.add(c.id);
      }
    }
    frontier = next;
  }
  return result;
}

export async function getAncestorUnitIds(unitId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = unitId;
  let safety = 0;
  while (cursor && safety++ < MAX_HIERARCHY_DEPTH) {
    const node: { id: string; parentUnitId: string | null } | null = await prisma.franchiseUnit.findUnique({
      where: { id: cursor },
      select: { id: true, parentUnitId: true },
    });
    if (!node) break;
    out.push(node.id);
    cursor = node.parentUnitId;
  }
  return out;
}

export async function getUnitTree(rootId: string, depth = 4): Promise<FranchiseNode> {
  const root = await prisma.franchiseUnit.findUnique({
    where: { id: rootId },
    include: {
      territory: true,
      ownerships: { where: { effectiveTo: null, isPrimary: true }, include: { owner: true }, take: 1 },
      _count: { select: { clubs: true, violations: { where: { status: 'OPEN' } } } },
    },
  });
  if (!root) throw new NotFoundError('Unit not found');

  type UnitWithIncludes = NonNullable<typeof root>;
  async function expand(node: UnitWithIncludes, level: number): Promise<FranchiseNode> {
    let children: FranchiseNode[] = [];
    if (level < depth) {
      const childRecords = await prisma.franchiseUnit.findMany({
        where: { parentUnitId: node.id },
        include: {
          territory: true,
          ownerships: { where: { effectiveTo: null, isPrimary: true }, include: { owner: true }, take: 1 },
          _count: { select: { clubs: true, violations: { where: { status: 'OPEN' } } } },
        },
        orderBy: [{ level: 'asc' }, { name: 'asc' }],
      });
      children = await Promise.all(childRecords.map((c) => expand(c, level + 1)));
    }

    return {
      ...node,
      children,
      territory: node.territory,
      primaryOwner: node.ownerships[0]?.owner ?? null,
      totalClubs: node._count.clubs,
      activeViolations: node._count.violations,
    } as FranchiseNode;
  }

  return await expand(root, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Club attachment
// ─────────────────────────────────────────────────────────────────────────────

export async function attachClub(
  actor: FranchiseActor,
  unitId: string,
  clubId: string,
): Promise<void> {
  const [unit, club] = await Promise.all([
    prisma.franchiseUnit.findUnique({ where: { id: unitId } }),
    prisma.club.findUnique({ where: { id: clubId } }),
  ]);
  if (!unit) throw new NotFoundError('Unit not found');
  if (!club) throw new NotFoundError('Club not found');
  if (unit.status === 'TERMINATED') throw new BadRequestError('Cannot attach club to terminated unit');

  // Cast for additive Prisma field added in the franchise schema fragment.
  await prisma.club.update({
    where: { id: clubId },
    data: ({ franchiseUnitId: unitId } as unknown) as Prisma.ClubUpdateInput,
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'CLUB_ATTACHED',
    category: 'HIERARCHY',
    resourceType: 'Club',
    resourceId: clubId,
    metadata: { clubName: club.name },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function detachClub(
  actor: FranchiseActor,
  unitId: string,
  clubId: string,
): Promise<void> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club not found');

  await prisma.club.update({
    where: { id: clubId },
    data: ({ franchiseUnitId: null } as unknown) as Prisma.ClubUpdateInput,
  });

  await writeFranchiseAudit({
    unitId,
    userId: actor.userId,
    action: 'CLUB_DETACHED',
    category: 'HIERARCHY',
    resourceType: 'Club',
    resourceId: clubId,
    metadata: { clubName: club.name },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}
