// Familista — Vision Intelligence Engine
// File location: src/services/vision-analytics.service.ts
//
// Composes the pure analytics lib with the database: pulls tracks/events for
// an analysis run, computes the requested AnalyticsKinds, persists each as a
// row in AnalyticsResult, and writes the audit trail. Each AnalyticsKind has
// a fixed payload contract enforced application-side.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  AnalyticsKind,
  AnalyticsResult,
  TeamSide,
} from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import {
  buildHeatmap,
  buildPassingNetwork,
  detectFormation,
  detectPressing,
  computePossession,
  computeShapeCompactness,
  computeSprintProfile,
  computeTechnicalExecution,
  computeTransitionSpeed,
  detectBuildUpPatterns,
} from '../lib/vision-analytics.lib';
import type { RunAnalyticsInput } from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

export type RunOutcome = {
  produced: number;
  byKind: Record<string, number>;
};

export async function runAnalytics(
  actor: VisionActor,
  analysisId: string,
  input: RunAnalyticsInput,
): Promise<RunOutcome> {
  const analysis = await prisma.visionAnalysisRun.findUnique({ where: { id: analysisId } });
  if (!analysis) throw new NotFoundError('Analysis run not found');
  if (analysis.status !== 'COMPLETED') {
    throw new BadRequestError(`Analysis must be COMPLETED before analytics (current: ${analysis.status})`);
  }

  const [tracks, ballTracks, events] = await Promise.all([
    prisma.playerTrack.findMany({ where: { analysisId } }),
    prisma.ballTrack.findMany({ where: { analysisId } }),
    prisma.matchEvent.findMany({ where: { analysisId } }),
  ]);

  const windowStartMs = input.windowStartMs ?? 0;
  const windowEndMs = input.windowEndMs ?? Math.max(...tracks.map((t) => t.endMs), 0, ...events.map((e) => e.occurredAtMs));
  const sides: TeamSide[] = input.teamSide ? [input.teamSide] : ['HOME', 'AWAY'];

  const byKind: Record<string, number> = {};
  const created: AnalyticsResult[] = [];

  for (const kind of input.kinds) {
    switch (kind) {
      case 'HEATMAP': {
        for (const side of sides) {
          const filtered = input.playerId
            ? tracks.filter((t) => t.playerId === input.playerId)
            : tracks.filter((t) => t.teamSide === side);
          const payload = buildHeatmap(filtered);
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                trainingSessionId: analysis.trainingSessionId,
                playerId: input.playerId ?? null,
                teamSide: side,
                kind: 'HEATMAP',
                windowStartMs,
                windowEndMs,
                payload: payload as unknown as Prisma.InputJsonValue,
                confidence: 0.9,
              },
            }),
          );
          byKind['HEATMAP'] = (byKind['HEATMAP'] ?? 0) + 1;
        }
        break;
      }

      case 'PASSING_NETWORK': {
        for (const side of sides) {
          const payload = buildPassingNetwork(events, side);
          if (payload.nodes.length === 0) continue;
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                teamSide: side,
                kind: 'PASSING_NETWORK',
                windowStartMs,
                windowEndMs,
                payload: payload as unknown as Prisma.InputJsonValue,
                confidence: 0.85,
              },
            }),
          );
          byKind['PASSING_NETWORK'] = (byKind['PASSING_NETWORK'] ?? 0) + 1;
        }
        break;
      }

      case 'FORMATION_SNAPSHOT': {
        for (const side of sides) {
          const payload = detectFormation(tracks, side, { windowStartMs, windowEndMs });
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                teamSide: side,
                kind: 'FORMATION_SNAPSHOT',
                windowStartMs,
                windowEndMs,
                payload: payload as unknown as Prisma.InputJsonValue,
                confidence: 0.75,
              },
            }),
          );
          byKind['FORMATION_SNAPSHOT'] = (byKind['FORMATION_SNAPSHOT'] ?? 0) + 1;
        }
        break;
      }

      case 'PRESSING_EVENT': {
        const pressings = detectPressing(tracks, events);
        for (const p of pressings) {
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                kind: 'PRESSING_EVENT',
                windowStartMs: p.triggeredAtMs,
                windowEndMs: p.triggeredAtMs + p.durationMs,
                payload: p as unknown as Prisma.InputJsonValue,
                confidence: 0.7,
              },
            }),
          );
        }
        byKind['PRESSING_EVENT'] = (byKind['PRESSING_EVENT'] ?? 0) + pressings.length;
        break;
      }

      case 'POSSESSION_BLOCK': {
        const payload = computePossession(events, windowStartMs, windowEndMs);
        created.push(
          await prisma.analyticsResult.create({
            data: {
              analysisId,
              matchId: analysis.matchId,
              kind: 'POSSESSION_BLOCK',
              windowStartMs,
              windowEndMs,
              payload: payload as unknown as Prisma.InputJsonValue,
              confidence: 0.9,
            },
          }),
        );
        byKind['POSSESSION_BLOCK'] = (byKind['POSSESSION_BLOCK'] ?? 0) + 1;
        break;
      }

      case 'SHAPE_COMPACTNESS': {
        for (const side of sides) {
          const payload = computeShapeCompactness(tracks, side);
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                teamSide: side,
                kind: 'SHAPE_COMPACTNESS',
                windowStartMs,
                windowEndMs,
                payload: payload as unknown as Prisma.InputJsonValue,
                confidence: 0.8,
              },
            }),
          );
          byKind['SHAPE_COMPACTNESS'] = (byKind['SHAPE_COMPACTNESS'] ?? 0) + 1;
        }
        break;
      }

      case 'TRANSITION_SPEED': {
        for (const side of sides) {
          const out = computeTransitionSpeed(events, side);
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                teamSide: side,
                kind: 'TRANSITION_SPEED',
                windowStartMs,
                windowEndMs,
                payload: out as unknown as Prisma.InputJsonValue,
                confidence: out.samples > 5 ? 0.8 : 0.55,
              },
            }),
          );
          byKind['TRANSITION_SPEED'] = (byKind['TRANSITION_SPEED'] ?? 0) + 1;
        }
        break;
      }

      case 'BUILD_UP_PATTERN': {
        for (const side of sides) {
          const patterns = detectBuildUpPatterns(events, side);
          if (patterns.length === 0) continue;
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                teamSide: side,
                kind: 'BUILD_UP_PATTERN',
                windowStartMs,
                windowEndMs,
                payload: { patterns } as unknown as Prisma.InputJsonValue,
                confidence: 0.7,
              },
            }),
          );
          byKind['BUILD_UP_PATTERN'] = (byKind['BUILD_UP_PATTERN'] ?? 0) + 1;
        }
        break;
      }

      case 'SPRINT_PROFILE': {
        const playerIds = input.playerId
          ? [input.playerId]
          : Array.from(new Set(tracks.map((t) => t.playerId).filter((id): id is string => id != null)));
        for (const pid of playerIds) {
          const payload = computeSprintProfile(tracks, pid);
          created.push(
            await prisma.analyticsResult.create({
              data: {
                analysisId,
                matchId: analysis.matchId,
                trainingSessionId: analysis.trainingSessionId,
                playerId: pid,
                kind: 'SPRINT_PROFILE',
                windowStartMs,
                windowEndMs,
                payload: payload as unknown as Prisma.InputJsonValue,
                confidence: 0.85,
              },
            }),
          );
          byKind['SPRINT_PROFILE'] = (byKind['SPRINT_PROFILE'] ?? 0) + 1;
        }
        break;
      }

      case 'TECHNICAL_EXECUTION': {
        const metrics: Array<'PASSING' | 'SHOOTING' | 'DRIBBLING' | 'TACKLING' | 'AERIAL'> =
          ['PASSING', 'SHOOTING', 'DRIBBLING', 'TACKLING', 'AERIAL'];
        const playerIds = input.playerId
          ? [input.playerId]
          : Array.from(
              new Set(
                events
                  .map((e) => e.primaryPlayerId)
                  .filter((id): id is string => id != null),
              ),
            );
        for (const pid of playerIds) {
          for (const m of metrics) {
            const payload = computeTechnicalExecution(events, pid, m);
            if (payload.attempts === 0) continue;
            created.push(
              await prisma.analyticsResult.create({
                data: {
                  analysisId,
                  matchId: analysis.matchId,
                  playerId: pid,
                  kind: 'TECHNICAL_EXECUTION',
                  windowStartMs,
                  windowEndMs,
                  payload: payload as unknown as Prisma.InputJsonValue,
                  confidence: 0.8,
                },
              }),
            );
            byKind['TECHNICAL_EXECUTION'] = (byKind['TECHNICAL_EXECUTION'] ?? 0) + 1;
          }
        }
        break;
      }

      case 'ZONE_OCCUPATION':
      case 'DEFENSIVE_LINE':
      case 'REPETITION_QUALITY':
      case 'OFF_BALL_MOVEMENT': {
        // Surface a placeholder analytics row so downstream dashboards never miss
        // a requested kind; real computation hooks here when richer signal becomes available.
        created.push(
          await prisma.analyticsResult.create({
            data: {
              analysisId,
              matchId: analysis.matchId,
              kind,
              windowStartMs,
              windowEndMs,
              payload: { note: `${kind} stub — requires per-frame data, not aggregated tracks` } as unknown as Prisma.InputJsonValue,
              confidence: 0.4,
            },
          }),
        );
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        break;
      }
    }
  }

  // Mark the ingest job as ANALYTICS_COMPUTED if it isn't already past that stage.
  const job = await prisma.videoIngestJob.findFirst({
    where: { videoAssetId: analysis.videoAssetId, stage: { in: ['EVENTS_DETECTED', 'TRACKED', 'INFERRED'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (job) {
    await prisma.videoIngestJob.update({
      where: { id: job.id },
      data: { stage: 'ANALYTICS_COMPUTED', progress: 0.85 },
    });
  }

  void ballTracks;

  await writeVisionAudit({
    analysisId,
    matchId: analysis.matchId,
    userId: actor.userId,
    action: 'ANALYTICS_COMPUTED',
    category: 'ANALYTICS',
    resourceType: 'VisionAnalysisRun',
    resourceId: analysisId,
    metadata: { kinds: input.kinds, byKind, produced: created.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { produced: created.length, byKind };
}

export async function listAnalytics(opts: {
  analysisId?: string;
  matchId?: string;
  playerId?: string;
  kind?: AnalyticsKind;
  teamSide?: TeamSide;
  limit?: number;
}): Promise<AnalyticsResult[]> {
  return await prisma.analyticsResult.findMany({
    where: {
      ...(opts.analysisId ? { analysisId: opts.analysisId } : {}),
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.teamSide ? { teamSide: opts.teamSide } : {}),
    },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(opts.limit ?? 100, 1), 1000),
  });
}

export async function getAnalyticsLatest(opts: {
  matchId: string;
  kind: AnalyticsKind;
  teamSide?: TeamSide;
  playerId?: string;
}): Promise<AnalyticsResult | null> {
  return await prisma.analyticsResult.findFirst({
    where: {
      matchId: opts.matchId,
      kind: opts.kind,
      ...(opts.teamSide ? { teamSide: opts.teamSide } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}
