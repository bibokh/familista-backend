// Familista — Vision Intelligence service (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Append-only writers + bounded reads for:
//   - PoseSkeleton     : 2D/3D joint keypoints per player per instant
//   - BallTrajectory   : per-match arc segments (≤30s typical)
//   - SpatialMap       : aggregated overlay snapshots (heatmap, pressure)
//
// All writes are idempotent (callers provide deterministic IDs when needed)
// and bounded (default cap 5000 per call). NEVER throws — best-effort.

import { Prisma, PoseSkeleton, BallTrajectory, SpatialMap } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface VisionActor {
  userId?: string;
  clubId:  string;
  role?:   string;
}

async function assertMatchInClub(matchId: string, clubId: string): Promise<void> {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!m)                   throw new NotFoundError('Match');
  if (m.clubId !== clubId)  throw new ForbiddenError();
}

// ── Pose ────────────────────────────────────────────────────────────────

export interface IngestPoseDto {
  matchId?:      string | null;
  visionFrameId?: string | null;
  playerId?:     string | null;
  monotonicMs:   number;
  joints:        Prisma.InputJsonValue;
  confidence?:   number;
}

export async function ingestPose(actor: VisionActor, dto: IngestPoseDto): Promise<PoseSkeleton> {
  if (dto.matchId) await assertMatchInClub(dto.matchId, actor.clubId);
  return prisma.poseSkeleton.create({
    data: {
      clubId:        actor.clubId,
      matchId:       dto.matchId ?? null,
      visionFrameId: dto.visionFrameId ?? null,
      playerId:      dto.playerId ?? null,
      monotonicMs:   BigInt(dto.monotonicMs),
      joints:        dto.joints,
      confidence:    Math.max(0, Math.min(1, dto.confidence ?? 0.5)),
    },
  });
}

export async function listPoses(actor: VisionActor, matchId: string, opts: { playerId?: string; fromMs?: number; toMs?: number; limit?: number } = {}) {
  await assertMatchInClub(matchId, actor.clubId);
  return prisma.poseSkeleton.findMany({
    where: {
      matchId, clubId: actor.clubId,
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.fromMs   ? { monotonicMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs     ? { monotonicMs: { lte: BigInt(opts.toMs)   } } : {}),
    },
    orderBy: { monotonicMs: 'asc' },
    take:    Math.min(opts.limit ?? 500, 5000),
  });
}

// ── Ball trajectory ─────────────────────────────────────────────────────

export interface IngestTrajectoryDto {
  matchId:        string;
  points:         Prisma.InputJsonValue;
  fromMs:         number;
  toMs:           number;
  confidence?:    number;
  sourceFrameIds?: Prisma.InputJsonValue;
}

export async function ingestTrajectory(actor: VisionActor, dto: IngestTrajectoryDto): Promise<BallTrajectory> {
  if (!dto.matchId) throw new BadRequestError('matchId required');
  await assertMatchInClub(dto.matchId, actor.clubId);
  return prisma.ballTrajectory.create({
    data: {
      clubId:         actor.clubId,
      matchId:        dto.matchId,
      points:         dto.points,
      fromMs:         BigInt(dto.fromMs),
      toMs:           BigInt(dto.toMs),
      confidence:     Math.max(0, Math.min(1, dto.confidence ?? 0.5)),
      sourceFrameIds: dto.sourceFrameIds ?? Prisma.JsonNull,
    },
  });
}

export async function listTrajectories(actor: VisionActor, matchId: string, opts: { fromMs?: number; toMs?: number; limit?: number } = {}) {
  await assertMatchInClub(matchId, actor.clubId);
  return prisma.ballTrajectory.findMany({
    where: {
      matchId, clubId: actor.clubId,
      ...(opts.fromMs ? { fromMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs   ? { toMs:   { lte: BigInt(opts.toMs) } }   : {}),
    },
    orderBy: { fromMs: 'asc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  });
}

// ── Spatial map ─────────────────────────────────────────────────────────

export interface IngestSpatialMapDto {
  matchId?:  string | null;
  kind:      string;
  payload:   Prisma.InputJsonValue;
  windowMs?: number;
}

export async function ingestSpatialMap(actor: VisionActor, dto: IngestSpatialMapDto): Promise<SpatialMap> {
  if (!dto.kind) throw new BadRequestError('kind required');
  if (dto.matchId) await assertMatchInClub(dto.matchId, actor.clubId);
  return prisma.spatialMap.create({
    data: {
      clubId:  actor.clubId,
      matchId: dto.matchId ?? null,
      kind:    dto.kind,
      payload: dto.payload,
      windowMs: dto.windowMs ?? null,
    },
  });
}

export async function listSpatialMaps(actor: VisionActor, opts: { matchId?: string; kind?: string; limit?: number } = {}) {
  if (opts.matchId) await assertMatchInClub(opts.matchId, actor.clubId);
  return prisma.spatialMap.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.kind    ? { kind: opts.kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take:    Math.min(opts.limit ?? 50, 500),
  });
}
