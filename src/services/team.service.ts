// Familista — Team service (Phase A)
// A Team is a squad inside a Club. Tenancy: every read/write is scoped
// by clubId. Soft-delete via isActive.

import { Team, TeamKind, Gender, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ConflictError, ForbiddenError } from '../utils/errors';

export interface CreateTeamDto {
  name:      string;
  shortName?: string;
  kind?:     TeamKind;
  gender?:   Gender;
  ageMin?:   number;
  ageMax?:   number;
  color?:    string;
  emblem?:   string;
  notes?:    string;
  isActive?: boolean;
}

export type UpdateTeamDto = Partial<CreateTeamDto>;

export interface TeamFilters {
  search?:   string;
  kind?:     TeamKind;
  isActive?: boolean;
  page?:     number;
  limit?:    number;
}

export async function listTeams(clubId: string, filters: TeamFilters = {}) {
  const { search, kind, isActive, page = 1, limit = 50 } = filters;
  const where: Prisma.TeamWhereInput = {
    clubId,
    ...(kind && { kind }),
    ...(isActive !== undefined && { isActive }),
    ...(search && {
      OR: [
        { name:      { contains: search, mode: 'insensitive' } },
        { shortName: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const [items, total] = await Promise.all([
    prisma.team.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      skip:    (page - 1) * limit,
      take:    limit,
      include: {
        _count: { select: { players: true, memberships: true } },
      },
    }),
    prisma.team.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getTeam(id: string, clubId: string): Promise<Team> {
  const team = await prisma.team.findUnique({ where: { id } });
  if (!team)            throw new NotFoundError('Team');
  if (team.clubId !== clubId) throw new ForbiddenError();
  return team;
}

async function assertNameFree(clubId: string, name: string, excludeId?: string): Promise<void> {
  const where: Prisma.TeamWhereInput = {
    clubId,
    name: { equals: name, mode: 'insensitive' },
    ...(excludeId ? { NOT: { id: excludeId } } : {}),
  };
  const clash = await prisma.team.findFirst({ where, select: { id: true } });
  if (clash) throw new ConflictError(`Team "${name}" already exists in this club`);
}

export async function createTeam(clubId: string, dto: CreateTeamDto): Promise<Team> {
  await assertNameFree(clubId, dto.name);
  return prisma.team.create({
    data: {
      clubId,
      name:      dto.name,
      shortName: dto.shortName,
      kind:      dto.kind   ?? TeamKind.SENIOR,
      gender:    dto.gender ?? Gender.MIXED,
      ageMin:    dto.ageMin,
      ageMax:    dto.ageMax,
      color:     dto.color,
      emblem:    dto.emblem,
      notes:     dto.notes,
      isActive:  dto.isActive ?? true,
    },
  });
}

export async function updateTeam(id: string, clubId: string, dto: UpdateTeamDto): Promise<Team> {
  await getTeam(id, clubId);
  if (dto.name) await assertNameFree(clubId, dto.name, id);
  return prisma.team.update({
    where: { id },
    data: {
      ...(dto.name      !== undefined && { name:      dto.name }),
      ...(dto.shortName !== undefined && { shortName: dto.shortName }),
      ...(dto.kind      !== undefined && { kind:      dto.kind }),
      ...(dto.gender    !== undefined && { gender:    dto.gender }),
      ...(dto.ageMin    !== undefined && { ageMin:    dto.ageMin }),
      ...(dto.ageMax    !== undefined && { ageMax:    dto.ageMax }),
      ...(dto.color     !== undefined && { color:     dto.color }),
      ...(dto.emblem    !== undefined && { emblem:    dto.emblem }),
      ...(dto.notes     !== undefined && { notes:     dto.notes }),
      ...(dto.isActive  !== undefined && { isActive:  dto.isActive }),
    },
  });
}

// Soft-archive (sets isActive=false). Players keep their teamId but lists
// can filter by isActive.
export async function archiveTeam(id: string, clubId: string): Promise<void> {
  const team = await getTeam(id, clubId);
  if (!team.isActive) return;
  await prisma.team.update({ where: { id }, data: { isActive: false } });
}

export async function reactivateTeam(id: string, clubId: string): Promise<Team> {
  const team = await getTeam(id, clubId);
  if (team.isActive) return team;
  return prisma.team.update({ where: { id }, data: { isActive: true } });
}
