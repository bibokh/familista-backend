// Familista — Vision Intelligence Engine
// File location: src/services/vision-tracking.service.ts
//
// Read-side service for PlayerTrack / BallTrack data. Writes happen via the
// inference webhook in vision-ingest.service.ts.

import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import type {
  BallTrack,
  PlayerTrack,
  TeamSide,
  VisionAnalysisRun,
} from '@prisma/client';

export type AnalysisWithCounts = VisionAnalysisRun & {
  _count: { playerTracks: number; ballTracks: number; events: number; analyticsResults: number };
};

export async function getAnalysis(id: string): Promise<AnalysisWithCounts> {
  const analysis = await prisma.visionAnalysisRun.findUnique({
    where: { id },
    include: { _count: { select: { playerTracks: true, ballTracks: true, events: true, analyticsResults: true } } },
  });
  if (!analysis) throw new NotFoundError('Analysis run not found');
  return analysis;
}

export async function listAnalyses(opts: {
  matchId?: string;
  clubId?: string;
  trainingSessionId?: string;
  videoAssetId?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.visionAnalysisRun.findMany({
    where: {
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.clubId ? { clubId: opts.clubId } : {}),
      ...(opts.trainingSessionId ? { trainingSessionId: opts.trainingSessionId } : {}),
      ...(opts.videoAssetId ? { videoAssetId: opts.videoAssetId } : {}),
    },
    include: { _count: { select: { playerTracks: true, events: true, analyticsResults: true } } },
    orderBy: [{ createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function listPlayerTracks(opts: {
  analysisId: string;
  playerId?: string;
  teamSide?: TeamSide;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}): Promise<PlayerTrack[]> {
  return await prisma.playerTrack.findMany({
    where: {
      analysisId: opts.analysisId,
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.teamSide ? { teamSide: opts.teamSide } : {}),
      ...(opts.fromMs != null ? { endMs: { gte: opts.fromMs } } : {}),
      ...(opts.toMs != null ? { startMs: { lte: opts.toMs } } : {}),
    },
    orderBy: [{ startMs: 'asc' }],
    take: Math.min(Math.max(opts.limit ?? 500, 1), 5000),
  });
}

export async function listBallTracks(opts: { analysisId: string; limit?: number }): Promise<BallTrack[]> {
  return await prisma.ballTrack.findMany({
    where: { analysisId: opts.analysisId },
    orderBy: { startMs: 'asc' },
    take: Math.min(Math.max(opts.limit ?? 500, 1), 5000),
  });
}

export async function playerTrackSummary(opts: {
  analysisId: string;
  teamSide?: TeamSide;
}) {
  const rows = await prisma.playerTrack.findMany({
    where: {
      analysisId: opts.analysisId,
      ...(opts.teamSide ? { teamSide: opts.teamSide } : {}),
    },
    select: {
      playerId: true,
      jerseyNumber: true,
      teamSide: true,
      totalDistanceM: true,
      topSpeedKmh: true,
      avgSpeedKmh: true,
      sprintCount: true,
      accelerations: true,
      decelerations: true,
      confidence: true,
    },
  });

  // Aggregate per player
  type Agg = {
    playerId: string | null;
    jerseyNumber: number | null;
    teamSide: TeamSide;
    totalDistance: number;
    topSpeed: number;
    avgSpeedSum: number;
    avgSpeedCount: number;
    sprints: number;
    accelerations: number;
    decelerations: number;
    confidenceSum: number;
    samples: number;
  };
  const byPlayer = new Map<string, Agg>();
  for (const r of rows) {
    const key = r.playerId ?? `#${r.jerseyNumber ?? 'unknown'}`;
    const a = byPlayer.get(key) ?? {
      playerId: r.playerId,
      jerseyNumber: r.jerseyNumber,
      teamSide: r.teamSide,
      totalDistance: 0,
      topSpeed: 0,
      avgSpeedSum: 0,
      avgSpeedCount: 0,
      sprints: 0,
      accelerations: 0,
      decelerations: 0,
      confidenceSum: 0,
      samples: 0,
    };
    a.totalDistance += r.totalDistanceM ?? 0;
    a.topSpeed = Math.max(a.topSpeed, r.topSpeedKmh ?? 0);
    if (r.avgSpeedKmh != null) {
      a.avgSpeedSum += r.avgSpeedKmh;
      a.avgSpeedCount++;
    }
    a.sprints += r.sprintCount ?? 0;
    a.accelerations += r.accelerations ?? 0;
    a.decelerations += r.decelerations ?? 0;
    a.confidenceSum += r.confidence;
    a.samples++;
    byPlayer.set(key, a);
  }

  return Array.from(byPlayer.values()).map((a) => ({
    playerId: a.playerId,
    jerseyNumber: a.jerseyNumber,
    teamSide: a.teamSide,
    totalDistanceM: Math.round(a.totalDistance),
    topSpeedKmh: Math.round(a.topSpeed * 10) / 10,
    avgSpeedKmh: a.avgSpeedCount > 0 ? Math.round((a.avgSpeedSum / a.avgSpeedCount) * 10) / 10 : null,
    sprints: a.sprints,
    accelerations: a.accelerations,
    decelerations: a.decelerations,
    avgConfidence: a.samples > 0 ? Math.round((a.confidenceSum / a.samples) * 100) / 100 : null,
    samples: a.samples,
  }));
}
