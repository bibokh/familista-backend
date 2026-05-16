// Familista — Vision Intelligence Engine
// File location: src/services/vision-fusion.service.ts
//
// Sensor + vision fusion. Reads per-player tracks from a completed analysis
// run and the matching wearable rows from PlayerGpsData (existing model),
// reconciles them in fixed time windows, and persists FusedPlayerSample
// rows with a verdict + agreement score.
//
// Weighting policy (operator-tunable):
//   • Top speed / sprint count : prefer sensor (wearable), fall back to vision
//   • Distance covered          : average both, weighted 0.5/0.5 by default
//   • Player load / HR / risk   : sensor only (no vision equivalent)
//
// Verdict:
//   • CONSISTENT          delta < 5%
//   • MINOR_DRIFT         5%-15%
//   • MAJOR_DRIFT         15%-35%
//   • CONTRADICTION       >35% delta on top-speed or distance
//   • VISION_ONLY / SENSOR_ONLY / INSUFFICIENT_DATA when one stream is absent

import { prisma } from '../lib/prisma';
import type {
  FusedPlayerSample,
  FusionVerdict,
  PlayerTrack,
  PlayerGpsData,
} from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import type { RunFusionInput } from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

const VISION_DISTANCE_WEIGHT = Number(process.env.VISION_FUSION_DISTANCE_WEIGHT ?? 0.5);
const VISION_TOPSPEED_WEIGHT = Number(process.env.VISION_FUSION_TOPSPEED_WEIGHT ?? 0.3);

function round2(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function classifyVerdict(
  visionDistance: number | null,
  sensorDistance: number | null,
  visionTopSpeed: number | null,
  sensorTopSpeed: number | null,
): { verdict: FusionVerdict; agreement: number | null; reasons: string[] } {
  const haveVision = visionDistance != null || visionTopSpeed != null;
  const haveSensor = sensorDistance != null || sensorTopSpeed != null;
  if (!haveVision && !haveSensor) return { verdict: 'INSUFFICIENT_DATA', agreement: null, reasons: ['No data from either source'] };
  if (!haveVision) return { verdict: 'SENSOR_ONLY', agreement: 1, reasons: [] };
  if (!haveSensor) return { verdict: 'VISION_ONLY', agreement: 1, reasons: [] };

  const reasons: string[] = [];
  const deltas: number[] = [];

  if (visionDistance != null && sensorDistance != null && (visionDistance > 0 || sensorDistance > 0)) {
    const denom = Math.max(visionDistance, sensorDistance, 1);
    const d = Math.abs(visionDistance - sensorDistance) / denom;
    deltas.push(d);
    if (d > 0.35) reasons.push(`Distance contradiction: vision ${visionDistance}m vs sensor ${sensorDistance}m`);
    else if (d > 0.15) reasons.push(`Distance drift: ${Math.round(d * 100)}%`);
  }

  if (visionTopSpeed != null && sensorTopSpeed != null && (visionTopSpeed > 0 || sensorTopSpeed > 0)) {
    const denom = Math.max(visionTopSpeed, sensorTopSpeed, 1);
    const d = Math.abs(visionTopSpeed - sensorTopSpeed) / denom;
    deltas.push(d);
    if (d > 0.35) reasons.push(`Top-speed contradiction: vision ${visionTopSpeed}km/h vs sensor ${sensorTopSpeed}km/h`);
    else if (d > 0.15) reasons.push(`Top-speed drift: ${Math.round(d * 100)}%`);
  }

  const maxDelta = deltas.length > 0 ? Math.max(...deltas) : 0;
  const agreement = round2(1 - maxDelta) ?? 0;

  let verdict: FusionVerdict;
  if (maxDelta > 0.35) verdict = 'CONTRADICTION';
  else if (maxDelta > 0.15) verdict = 'MAJOR_DRIFT';
  else if (maxDelta > 0.05) verdict = 'MINOR_DRIFT';
  else verdict = 'CONSISTENT';

  return { verdict, agreement, reasons };
}

function fuseDistance(vision: number | null, sensor: number | null): number | null {
  if (vision == null && sensor == null) return null;
  if (vision == null) return sensor;
  if (sensor == null) return vision;
  return round2(vision * VISION_DISTANCE_WEIGHT + sensor * (1 - VISION_DISTANCE_WEIGHT));
}

function fuseTopSpeed(vision: number | null, sensor: number | null): number | null {
  if (vision == null && sensor == null) return null;
  if (vision == null) return sensor;
  if (sensor == null) return vision;
  // Prefer sensor (wearable) but blend small amount of vision
  return round2(vision * VISION_TOPSPEED_WEIGHT + sensor * (1 - VISION_TOPSPEED_WEIGHT));
}

export type FusionOutcome = {
  windowMinutes: number;
  matchId: string | null;
  trainingSessionId: string | null;
  samplesCreated: number;
  byVerdict: Record<string, number>;
};

export async function runFusion(
  actor: VisionActor,
  input: RunFusionInput,
): Promise<FusionOutcome> {
  if (!input.matchId && !input.trainingSessionId) {
    throw new BadRequestError('matchId or trainingSessionId required');
  }

  const analyses = await prisma.visionAnalysisRun.findMany({
    where: {
      ...(input.matchId ? { matchId: input.matchId } : {}),
      ...(input.trainingSessionId ? { trainingSessionId: input.trainingSessionId } : {}),
      status: 'COMPLETED',
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  if (analyses.length === 0) throw new NotFoundError('No completed vision analysis for the given context');
  const analysis = analyses[0];

  const playerTracks = await prisma.playerTrack.findMany({
    where: { analysisId: analysis.id, playerId: { not: null } },
  });

  if (playerTracks.length === 0) {
    return { windowMinutes: input.windowMinutes ?? 1, matchId: input.matchId ?? null, trainingSessionId: input.trainingSessionId ?? null, samplesCreated: 0, byVerdict: {} };
  }

  const playerIds = Array.from(new Set(playerTracks.map((t) => t.playerId).filter((id): id is string => id != null)));

  // Pull sensor data overlapping the analysis time-range
  const minStart = Math.min(...playerTracks.map((t) => t.startMs));
  const maxEnd = Math.max(...playerTracks.map((t) => t.endMs));
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // sensor data is wall-clock — pull last 24h as a safe window
  const sensorRows = await prisma.playerGpsData.findMany({
    where: { playerId: { in: playerIds }, recordedAt: { gte: since } },
  });

  // Group sensor by player
  const sensorByPlayer = new Map<string, PlayerGpsData[]>();
  for (const s of sensorRows) {
    const arr = sensorByPlayer.get(s.playerId) ?? [];
    arr.push(s);
    sensorByPlayer.set(s.playerId, arr);
  }

  const windowMs = (input.windowMinutes ?? 1) * 60 * 1000;
  const byVerdict: Record<string, number> = {};
  let samplesCreated = 0;

  // Delete prior fusion samples for the (match|training, players) we're about to rewrite
  await prisma.fusedPlayerSample.deleteMany({
    where: {
      playerId: { in: playerIds },
      ...(input.matchId ? { matchId: input.matchId } : {}),
      ...(input.trainingSessionId ? { trainingSessionId: input.trainingSessionId } : {}),
    },
  });

  for (const playerId of playerIds) {
    const visionRows = playerTracks.filter((t) => t.playerId === playerId);
    const sensorAll = sensorByPlayer.get(playerId) ?? [];

    // Bucket vision rows by window
    for (let winStart = minStart; winStart < maxEnd; winStart += windowMs) {
      const winEnd = winStart + windowMs;
      const visionWin = visionRows.filter((t) => t.endMs >= winStart && t.startMs < winEnd);
      const sensorWin = sensorAll; // sensor rows aren't keyed to match ms — use all available as best-effort

      const visionDistance = visionWin.length > 0
        ? visionWin.reduce((s, t) => s + (t.totalDistanceM ?? 0), 0)
        : null;
      const visionTopSpeed = visionWin.length > 0
        ? Math.max(0, ...visionWin.map((t) => t.topSpeedKmh ?? 0))
        : null;
      const visionAvgSpeed = visionWin.length > 0
        ? (visionWin.reduce((s, t) => s + (t.avgSpeedKmh ?? 0), 0) / Math.max(visionWin.length, 1))
        : null;
      const visionSprintCount = visionWin.length > 0
        ? visionWin.reduce((s, t) => s + (t.sprintCount ?? 0), 0)
        : null;

      const sensorDistance = sensorWin.length > 0
        ? sensorWin.reduce((s, r) => s + r.distance, 0) / Math.max(sensorWin.length, 1)
        : null;
      const sensorTopSpeed = sensorWin.length > 0
        ? Math.max(0, ...sensorWin.map((r) => r.topSpeed))
        : null;
      const sensorPlayerLoad = sensorWin.length > 0
        ? sensorWin.reduce((s, r) => s + r.playerLoad, 0) / Math.max(sensorWin.length, 1)
        : null;
      const sensorHeartRateAvg = sensorWin.length > 0
        ? Math.round(sensorWin.reduce((s, r) => s + r.heartRateAvg, 0) / Math.max(sensorWin.length, 1))
        : null;
      const sensorRiskScore = sensorWin.length > 0
        ? sensorWin.reduce((s, r) => s + r.riskScore, 0) / Math.max(sensorWin.length, 1)
        : null;

      if (visionWin.length === 0 && sensorWin.length === 0) continue;

      const { verdict, agreement, reasons } = classifyVerdict(
        visionDistance,
        sensorDistance,
        visionTopSpeed,
        sensorTopSpeed,
      );

      const fusedDist = fuseDistance(visionDistance, sensorDistance);
      const fusedTop = fuseTopSpeed(visionTopSpeed, sensorTopSpeed);

      await prisma.fusedPlayerSample.create({
        data: {
          matchId: input.matchId ?? null,
          trainingSessionId: input.trainingSessionId ?? null,
          playerId,
          windowStartMs: winStart,
          windowEndMs: winEnd,
          visionDistanceM: round2(visionDistance),
          visionTopSpeedKmh: round2(visionTopSpeed),
          visionAvgSpeedKmh: round2(visionAvgSpeed),
          visionSprintCount,
          sensorDistanceM: round2(sensorDistance),
          sensorTopSpeedKmh: round2(sensorTopSpeed),
          sensorPlayerLoad: round2(sensorPlayerLoad),
          sensorHeartRateAvg,
          sensorRiskScore: round2(sensorRiskScore),
          fusedDistanceM: fusedDist,
          fusedTopSpeedKmh: fusedTop,
          fusedSprintCount: visionSprintCount,
          verdict,
          agreementScore: agreement,
          conflictReasons: reasons,
        },
      });

      byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
      samplesCreated++;
    }
  }

  // Move ingest job to FUSED if applicable
  const job = await prisma.videoIngestJob.findFirst({
    where: { videoAssetId: analysis.videoAssetId, stage: 'ANALYTICS_COMPUTED' },
    orderBy: { createdAt: 'desc' },
  });
  if (job) {
    await prisma.videoIngestJob.update({
      where: { id: job.id },
      data: { stage: 'FUSED', progress: 0.95 },
    });
  }

  await writeVisionAudit({
    analysisId: analysis.id,
    matchId: input.matchId ?? null,
    userId: actor.userId,
    action: 'FUSION_RUN',
    category: 'FUSION',
    resourceType: 'VisionAnalysisRun',
    resourceId: analysis.id,
    metadata: { samplesCreated, byVerdict, windowMinutes: input.windowMinutes ?? 1, players: playerIds.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return {
    windowMinutes: input.windowMinutes ?? 1,
    matchId: input.matchId ?? null,
    trainingSessionId: input.trainingSessionId ?? null,
    samplesCreated,
    byVerdict,
  };
}

export async function listFusedSamples(opts: {
  matchId?: string;
  trainingSessionId?: string;
  playerId?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}): Promise<FusedPlayerSample[]> {
  return await prisma.fusedPlayerSample.findMany({
    where: {
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.trainingSessionId ? { trainingSessionId: opts.trainingSessionId } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.fromMs != null ? { windowStartMs: { gte: opts.fromMs } } : {}),
      ...(opts.toMs != null ? { windowEndMs: { lte: opts.toMs } } : {}),
    },
    orderBy: [{ windowStartMs: 'asc' }, { playerId: 'asc' }],
    take: Math.min(Math.max(opts.limit ?? 500, 1), 5000),
  });
}
