// Familista — Vision Intelligence Engine
// File location: src/services/vision-ingest.service.ts
//
// Orchestrates the multi-stage ingest pipeline for a VideoAsset:
//
//   UPLOADED → DEMUXED → INFERRED → TRACKED → EVENTS_DETECTED
//             → ANALYTICS_COMPUTED → FUSED → COMPLETED   (or FAILED)
//
// Submission writes the VideoAsset, creates a VideoIngestJob + a sibling
// VisionAnalysisRun, dispatches to the configured inference adapter, and
// returns the job. Completion is delivered by the inference webhook
// (`ingestInferenceResults`) which transitions stage and persists tracks +
// events. Subsequent analytics + fusion are driven by their own services.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  VideoAsset,
  VideoIngestJob,
  VisionAnalysisRun,
  IngestStage,
  IngestStatus,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import { getInferenceAdapter } from './vision-inference.adapter';
import type {
  RegisterVideoInput,
  UpdateVideoInput,
  StartIngestInput,
  TransitionIngestInput,
  InferenceResultsInput,
} from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

const STAGE_TRANSITIONS: Record<IngestStage, ReadonlyArray<IngestStage>> = {
  UPLOADED:           ['DEMUXED', 'INFERRED', 'FAILED'],
  DEMUXED:            ['INFERRED', 'FAILED'],
  INFERRED:           ['TRACKED', 'FAILED'],
  TRACKED:            ['EVENTS_DETECTED', 'FAILED'],
  EVENTS_DETECTED:    ['ANALYTICS_COMPUTED', 'FAILED'],
  ANALYTICS_COMPUTED: ['FUSED', 'COMPLETED', 'FAILED'],
  FUSED:              ['COMPLETED', 'FAILED'],
  COMPLETED:          [],
  FAILED:             [],
};

function assertStageTransition(from: IngestStage, to: IngestStage): void {
  if (from === to) return;
  if (!STAGE_TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Ingest stage transition ${from} → ${to} not allowed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Video asset CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function registerVideo(
  actor: VisionActor,
  input: RegisterVideoInput,
): Promise<VideoAsset> {
  const created = await prisma.videoAsset.create({
    data: {
      source: input.source,
      format: input.format,
      url: input.url,
      durationMs: input.durationMs ?? null,
      fps: input.fps ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      fileBytes: input.fileBytes ?? null,
      checksum: input.checksum ?? null,
      clubId: input.clubId ?? null,
      matchId: input.matchId ?? null,
      trainingSessionId: input.trainingSessionId ?? null,
      title: input.title ?? null,
      description: input.description ?? null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
      createdBy: actor.userId,
    },
  });

  await writeVisionAudit({
    videoAssetId: created.id,
    matchId: created.matchId,
    userId: actor.userId,
    action: 'VIDEO_REGISTERED',
    category: 'INGEST',
    resourceType: 'VideoAsset',
    resourceId: created.id,
    metadata: { source: created.source, format: created.format, url: created.url },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function updateVideo(
  actor: VisionActor,
  id: string,
  input: UpdateVideoInput,
): Promise<VideoAsset> {
  const existing = await prisma.videoAsset.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Video asset not found');

  const updated = await prisma.videoAsset.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      description: input.description ?? undefined,
      clubId: input.clubId === undefined ? undefined : input.clubId,
      matchId: input.matchId === undefined ? undefined : input.matchId,
      trainingSessionId: input.trainingSessionId === undefined ? undefined : input.trainingSessionId,
      durationMs: input.durationMs ?? undefined,
      fps: input.fps ?? undefined,
      width: input.width ?? undefined,
      height: input.height ?? undefined,
      fileBytes: input.fileBytes ?? undefined,
      checksum: input.checksum ?? undefined,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeVisionAudit({
    videoAssetId: id,
    matchId: existing.matchId,
    userId: actor.userId,
    action: 'VIDEO_UPDATED',
    category: 'INGEST',
    resourceType: 'VideoAsset',
    resourceId: id,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listVideos(opts: {
  clubId?: string;
  matchId?: string;
  trainingSessionId?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.videoAsset.findMany({
    where: {
      ...(opts.clubId ? { clubId: opts.clubId } : {}),
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.trainingSessionId ? { trainingSessionId: opts.trainingSessionId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getVideo(id: string) {
  const video = await prisma.videoAsset.findUnique({
    where: { id },
    include: {
      ingestJobs: { orderBy: { createdAt: 'desc' } },
      analyses: { orderBy: { createdAt: 'desc' }, take: 10 },
      clips: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  if (!video) throw new NotFoundError('Video asset not found');
  return video;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest job lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function startIngest(
  actor: VisionActor,
  videoAssetId: string,
  input: StartIngestInput,
): Promise<{ job: VideoIngestJob; analysis: VisionAnalysisRun }> {
  const video = await prisma.videoAsset.findUnique({ where: { id: videoAssetId } });
  if (!video) throw new NotFoundError('Video asset not found');

  // Prevent duplicate active jobs for the same video.
  const active = await prisma.videoIngestJob.findFirst({
    where: { videoAssetId, status: { in: ['QUEUED', 'RUNNING'] } },
  });
  if (active) throw new ConflictError(`Active ingest job already exists (${active.id})`);

  const adapter = getInferenceAdapter();
  const submission = await adapter.submitVideo({
    videoAssetId,
    videoUrl: video.url,
    matchId: video.matchId ?? null,
    trainingSessionId: video.trainingSessionId ?? null,
    fps: video.fps ?? null,
    durationMs: video.durationMs ?? null,
    metadata: input.metadata ?? undefined,
  });

  const result = await prisma.$transaction(async (tx) => {
    const job = await tx.videoIngestJob.create({
      data: {
        videoAssetId,
        stage: 'UPLOADED',
        status: 'QUEUED',
        progress: 0,
        inferenceProvider: input.provider ?? adapter.kind,
        externalJobId: submission.externalJobId,
        startedAt: new Date(),
        notes: input.notes ?? null,
        metadata:
          input.metadata === undefined || input.metadata === null
            ? undefined
            : (input.metadata as Prisma.InputJsonValue),
        createdBy: actor.userId,
      },
    });

    const analysis = await tx.visionAnalysisRun.create({
      data: {
        videoAssetId,
        matchId: video.matchId ?? null,
        trainingSessionId: video.trainingSessionId ?? null,
        clubId: video.clubId ?? null,
        modelProvider: input.provider ?? adapter.kind,
        modelVersion: 'pending',
        status: 'QUEUED',
        framesTotal:
          video.durationMs != null && video.fps != null
            ? Math.round((video.durationMs / 1000) * video.fps)
            : null,
        createdBy: actor.userId,
      },
    });

    return { job, analysis };
  });

  await writeVisionAudit({
    analysisId: result.analysis.id,
    videoAssetId,
    matchId: video.matchId,
    userId: actor.userId,
    action: 'INGEST_STARTED',
    category: 'INGEST',
    resourceType: 'VideoIngestJob',
    resourceId: result.job.id,
    metadata: {
      provider: input.provider ?? adapter.kind,
      externalJobId: submission.externalJobId,
      estimatedDurationSec: submission.estimatedDurationSec,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

export async function transitionIngest(
  actor: VisionActor,
  jobId: string,
  input: TransitionIngestInput,
): Promise<VideoIngestJob> {
  const existing = await prisma.videoIngestJob.findUnique({ where: { id: jobId } });
  if (!existing) throw new NotFoundError('Ingest job not found');

  assertStageTransition(existing.stage, input.stage);

  const status: IngestStatus =
    input.status ??
    (input.stage === 'COMPLETED'
      ? 'COMPLETED'
      : input.stage === 'FAILED'
        ? 'FAILED'
        : existing.status === 'QUEUED'
          ? 'RUNNING'
          : existing.status);

  const updated = await prisma.videoIngestJob.update({
    where: { id: jobId },
    data: {
      stage: input.stage,
      status,
      progress: input.progress ?? existing.progress,
      error: input.error ?? existing.error,
      notes: input.notes ?? existing.notes,
      finishedAt: input.stage === 'COMPLETED' || input.stage === 'FAILED' ? new Date() : existing.finishedAt,
    },
  });

  await writeVisionAudit({
    videoAssetId: existing.videoAssetId,
    userId: actor.userId,
    action: 'INGEST_TRANSITIONED',
    category: 'INGEST',
    resourceType: 'VideoIngestJob',
    resourceId: jobId,
    metadata: { from: existing.stage, to: input.stage, status, error: input.error ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: input.stage === 'FAILED' ? 'FAILURE' : 'SUCCESS',
  });

  return updated;
}

export async function getIngestJob(id: string): Promise<VideoIngestJob> {
  const job = await prisma.videoIngestJob.findUnique({ where: { id } });
  if (!job) throw new NotFoundError('Ingest job not found');
  return job;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inference webhook — provider posts results here
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestInferenceResults(
  actor: VisionActor | null,
  jobId: string,
  results: InferenceResultsInput,
): Promise<VisionAnalysisRun> {
  return await prisma.$transaction(async (tx) => {
    const job = await tx.videoIngestJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError('Ingest job not found');

    const analysis = await tx.visionAnalysisRun.findFirst({
      where: { videoAssetId: job.videoAssetId },
      orderBy: { createdAt: 'desc' },
    });
    if (!analysis) throw new NotFoundError('Analysis run not found for job');
    if (analysis.status === 'COMPLETED') {
      throw new BadRequestError('Analysis already completed');
    }

    // Persist tracks
    if (results.playerTracks.length > 0) {
      await tx.playerTrack.createMany({
        data: results.playerTracks.map((t) => ({
          analysisId: analysis.id,
          playerId: t.playerId ?? null,
          jerseyNumber: t.jerseyNumber ?? null,
          teamSide: t.teamSide,
          startMs: t.startMs,
          endMs: t.endMs,
          avgX: t.avgX,
          avgY: t.avgY,
          topSpeedKmh: t.topSpeedKmh ?? null,
          avgSpeedKmh: t.avgSpeedKmh ?? null,
          totalDistanceM: t.totalDistanceM ?? null,
          sprintCount: t.sprintCount ?? null,
          accelerations: t.accelerations ?? null,
          decelerations: t.decelerations ?? null,
          pathUrl: t.pathUrl ?? null,
          confidence: t.confidence ?? 1,
        })),
      });
    }
    if (results.ballTracks.length > 0) {
      await tx.ballTrack.createMany({
        data: results.ballTracks.map((t) => ({
          analysisId: analysis.id,
          startMs: t.startMs,
          endMs: t.endMs,
          pathUrl: t.pathUrl ?? null,
          avgSpeedKmh: t.avgSpeedKmh ?? null,
          topSpeedKmh: t.topSpeedKmh ?? null,
          inPlayMs: t.inPlayMs ?? null,
          confidence: t.confidence ?? 1,
        })),
      });
    }
    if (results.events.length > 0) {
      await tx.matchEvent.createMany({
        data: results.events.map((e) => ({
          analysisId: analysis.id,
          matchId: analysis.matchId,
          type: e.type,
          occurredAtMs: e.occurredAtMs,
          frame: e.frame ?? null,
          durationMs: e.durationMs ?? null,
          primaryPlayerId: e.primaryPlayerId ?? null,
          secondaryPlayerId: e.secondaryPlayerId ?? null,
          teamSide: e.teamSide,
          pitchX: e.pitchX ?? null,
          pitchY: e.pitchY ?? null,
          confidence: e.confidence ?? 1,
          payload:
            e.payload === undefined || e.payload === null
              ? undefined
              : (e.payload as Prisma.InputJsonValue),
        })),
      });
    }

    const updatedAnalysis = await tx.visionAnalysisRun.update({
      where: { id: analysis.id },
      data: {
        modelProvider: results.modelProvider,
        modelVersion: results.modelVersion,
        status: 'COMPLETED',
        confidence: results.overallConfidence,
        durationMs: results.durationMs,
        framesProcessed: results.framesProcessed,
        framesTotal: results.framesTotal ?? analysis.framesTotal,
        startedAt: analysis.startedAt ?? job.startedAt ?? new Date(),
        finishedAt: new Date(),
      },
    });

    await tx.videoIngestJob.update({
      where: { id: job.id },
      data: {
        stage: 'EVENTS_DETECTED',
        status: 'RUNNING',
        progress: 0.6,
      },
    });

    return updatedAnalysis;
  }).then(async (updated) => {
    await writeVisionAudit({
      analysisId: updated.id,
      videoAssetId: updated.videoAssetId,
      matchId: updated.matchId,
      userId: actor?.userId ?? null,
      action: 'INFERENCE_RESULTS_INGESTED',
      category: 'INFERENCE',
      resourceType: 'VisionAnalysisRun',
      resourceId: updated.id,
      metadata: {
        modelProvider: results.modelProvider,
        modelVersion: results.modelVersion,
        playerTracks: results.playerTracks.length,
        ballTracks: results.ballTracks.length,
        events: results.events.length,
      },
      ipAddress: actor?.ipAddress ?? null,
      userAgent: actor?.userAgent ?? null,
    });
    return updated;
  });
}

export async function failIngest(
  actor: VisionActor | null,
  jobId: string,
  error: string,
): Promise<VideoIngestJob> {
  const existing = await prisma.videoIngestJob.findUnique({ where: { id: jobId } });
  if (!existing) throw new NotFoundError('Ingest job not found');

  const updated = await prisma.videoIngestJob.update({
    where: { id: jobId },
    data: { stage: 'FAILED', status: 'FAILED', error, finishedAt: new Date() },
  });

  await writeVisionAudit({
    videoAssetId: existing.videoAssetId,
    userId: actor?.userId ?? null,
    action: 'INGEST_FAILED',
    category: 'INGEST',
    resourceType: 'VideoIngestJob',
    resourceId: jobId,
    metadata: { error },
    ipAddress: actor?.ipAddress ?? null,
    userAgent: actor?.userAgent ?? null,
    result: 'FAILURE',
    message: error,
  });

  return updated;
}
