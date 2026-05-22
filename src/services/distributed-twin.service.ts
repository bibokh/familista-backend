// Familista — Distributed Digital Twin extensions (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Composes Phase G (SpatialFrame + twinAt interpolator) with two new
// per-user / per-match constructs:
//
//   - TacticalGhost   : alternate-history overlay (what-if simulation).
//                       Append-only; deterministic projection from one
//                       source SpatialFrame.
//   - ReplayCursor    : per-user playback position so the SPA can resume
//                       a scrub session across devices.

import { Prisma, TacticalGhost, ReplayCursor } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

// ─────────────────────────────────────────────────────────────────────────
// Tactical ghost (what-if overlay)
// ─────────────────────────────────────────────────────────────────────────

export interface CreateGhostDto {
  matchId:              string;
  kind:                 string;       // "WHAT_IF" | "FORMATION_SIM" | "SUB_SCENARIO" | …
  payload:              Prisma.InputJsonValue;
  sourceSpatialFrameId?: string | null;
  createdById?:         string | null;
}

export interface TwinActor {
  userId:    string;
  clubId:    string;
  role?:     string;
}

async function assertMatchInClub(matchId: string, clubId: string): Promise<void> {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!m)                   throw new NotFoundError('Match');
  if (m.clubId !== clubId)  throw new ForbiddenError();
}

export async function createGhost(actor: TwinActor, dto: CreateGhostDto): Promise<TacticalGhost> {
  if (!dto.matchId || !dto.kind) throw new BadRequestError('matchId and kind required');
  await assertMatchInClub(dto.matchId, actor.clubId);
  return prisma.tacticalGhost.create({
    data: {
      clubId:               actor.clubId,
      matchId:              dto.matchId,
      sourceSpatialFrameId: dto.sourceSpatialFrameId ?? null,
      kind:                 dto.kind,
      payload:              dto.payload,
      createdById:          dto.createdById ?? actor.userId,
    },
  });
}

export async function listGhosts(actor: TwinActor, matchId: string, opts: { kind?: string; limit?: number } = {}): Promise<TacticalGhost[]> {
  await assertMatchInClub(matchId, actor.clubId);
  return prisma.tacticalGhost.findMany({
    where: { matchId, ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 500),
  });
}

export async function deleteGhost(actor: TwinActor, id: string): Promise<void> {
  const g = await prisma.tacticalGhost.findUnique({ where: { id } });
  if (!g)                                                       throw new NotFoundError('TacticalGhost');
  if (g.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  await prisma.tacticalGhost.delete({ where: { id } });
}

// ─────────────────────────────────────────────────────────────────────────
// Replay cursor — per-user playback position
// ─────────────────────────────────────────────────────────────────────────

export interface UpsertCursorDto {
  matchId: string;
  atMs:    number;
  rate?:   number;
}

export async function upsertCursor(actor: TwinActor, dto: UpsertCursorDto): Promise<ReplayCursor> {
  if (!dto.matchId) throw new BadRequestError('matchId required');
  await assertMatchInClub(dto.matchId, actor.clubId);
  return prisma.replayCursor.upsert({
    where:  { userId_matchId: { userId: actor.userId, matchId: dto.matchId } },
    create: {
      userId:  actor.userId,
      matchId: dto.matchId,
      atMs:    BigInt(dto.atMs),
      rate:    dto.rate ?? 1.0,
    },
    update: {
      atMs: BigInt(dto.atMs),
      rate: dto.rate ?? 1.0,
    },
  });
}

export async function getCursor(actor: TwinActor, matchId: string): Promise<ReplayCursor | null> {
  return prisma.replayCursor.findUnique({
    where: { userId_matchId: { userId: actor.userId, matchId } },
  });
}
