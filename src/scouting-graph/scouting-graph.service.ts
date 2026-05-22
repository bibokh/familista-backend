// Familista — Global Scouting Graph (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// Snapshot writers + ScoutNetwork directory. All graphs are JSON blobs.

import { CareerProjectionGraph, PlayerSimilarityGraph, Prisma, ScoutNetwork, TalentGraph } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface ScoutGraphActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'm1';

// ── TalentGraph ─────────────────────────────────────────────────────────

export async function recordTalentGraph(actor: ScoutGraphActor, snapshot: Prisma.InputJsonValue, monotonicMs?: number): Promise<TalentGraph> {
  if (snapshot === undefined) throw new BadRequestError('snapshot required');
  return prisma.talentGraph.create({
    data: {
      clubId:       actor.clubId,
      snapshot,
      modelVersion: VERSION,
      monotonicMs:  BigInt(monotonicMs ?? Date.now()),
    },
  });
}

export async function latestTalentGraph(actor: ScoutGraphActor): Promise<TalentGraph | null> {
  return prisma.talentGraph.findFirst({ where: { clubId: actor.clubId }, orderBy: { monotonicMs: 'desc' } });
}

// ── ScoutNetwork directory ──────────────────────────────────────────────

export interface RegisterScoutDto {
  scoutUserId:  string;
  regionCode?:  string;
  languages?:   Prisma.InputJsonValue;
  specialities?: Prisma.InputJsonValue;
  ratings?:     Prisma.InputJsonValue;
}

export async function registerScout(actor: ScoutGraphActor, dto: RegisterScoutDto): Promise<ScoutNetwork> {
  if (!dto.scoutUserId) throw new BadRequestError('scoutUserId required');
  return prisma.scoutNetwork.create({
    data: {
      clubId:       actor.clubId,
      scoutUserId:  dto.scoutUserId,
      regionCode:   dto.regionCode ?? null,
      languages:    (dto.languages   ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      specialities: (dto.specialities ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ratings:      (dto.ratings     ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listScouts(actor: ScoutGraphActor): Promise<ScoutNetwork[]> {
  return prisma.scoutNetwork.findMany({ where: { clubId: actor.clubId, isActive: true }, orderBy: { createdAt: 'desc' } });
}

export async function deactivateScout(actor: ScoutGraphActor, id: string): Promise<ScoutNetwork> {
  const s = await prisma.scoutNetwork.findUnique({ where: { id } });
  if (!s)                                                       throw new NotFoundError('ScoutNetwork');
  if (s.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.scoutNetwork.update({ where: { id }, data: { isActive: false } });
}

// ── PlayerSimilarityGraph ──────────────────────────────────────────────

export async function recordSimilarityGraph(actor: ScoutGraphActor, sourcePlayerId: string, snapshot: Prisma.InputJsonValue): Promise<PlayerSimilarityGraph> {
  if (!sourcePlayerId || snapshot === undefined) throw new BadRequestError('sourcePlayerId + snapshot required');
  return prisma.playerSimilarityGraph.create({
    data: { clubId: actor.clubId, sourcePlayerId, snapshot, modelVersion: VERSION },
  });
}

// ── CareerProjectionGraph ──────────────────────────────────────────────

export async function recordCareerProjectionGraph(actor: ScoutGraphActor, playerId: string, snapshot: Prisma.InputJsonValue): Promise<CareerProjectionGraph> {
  if (!playerId || snapshot === undefined) throw new BadRequestError('playerId + snapshot required');
  return prisma.careerProjectionGraph.create({
    data: { clubId: actor.clubId, playerId, snapshot, modelVersion: VERSION },
  });
}
