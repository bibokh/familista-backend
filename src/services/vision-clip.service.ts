// Familista — Vision Intelligence Engine
// File location: src/services/vision-clip.service.ts
//
// Clip orchestration: queues clip renders via the configured ClipAdapter,
// auto-generates highlights from detected events, and reconciles render
// callbacks back into Clip rows.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { Clip, ClipPurpose, ClipStatus, VisionEventType } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import { getClipAdapter } from './vision-clip.adapter';
import type {
  RequestClipInput,
  GenerateHighlightsInput,
  ClipRenderCallbackInput,
} from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

export async function requestClip(
  actor: VisionActor,
  input: RequestClipInput,
): Promise<Clip> {
  const video = await prisma.videoAsset.findUnique({ where: { id: input.videoAssetId } });
  if (!video) throw new NotFoundError('Video asset not found');
  if (!video.url) throw new BadRequestError('Video asset has no source URL');
  if (input.endMs <= input.startMs) throw new BadRequestError('endMs must be greater than startMs');

  const adapter = getClipAdapter();
  const submission = await adapter.submit({
    videoUrl: video.url,
    startMs: input.startMs,
    endMs: input.endMs,
    format: 'MP4',
    thumbnail: true,
    watermarkText: input.watermarkText ?? null,
  });

  const clip = await prisma.clip.create({
    data: {
      videoAssetId: input.videoAssetId,
      matchId: input.matchId ?? video.matchId,
      trainingSessionId: input.trainingSessionId ?? video.trainingSessionId,
      playerId: input.playerId ?? null,
      sourceEventId: input.sourceEventId ?? null,
      purpose: input.purpose,
      status: 'RENDERING',
      startMs: input.startMs,
      endMs: input.endMs,
      renderProvider: adapter.kind,
      externalRenderId: submission.externalRenderId,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? [],
      requestedBy: actor.userId,
    },
  });

  await writeVisionAudit({
    videoAssetId: video.id,
    matchId: clip.matchId,
    userId: actor.userId,
    action: 'CLIP_REQUESTED',
    category: 'CLIP',
    resourceType: 'Clip',
    resourceId: clip.id,
    metadata: { purpose: clip.purpose, startMs: clip.startMs, endMs: clip.endMs, renderProvider: adapter.kind },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return clip;
}

export async function generateHighlights(
  actor: VisionActor,
  input: GenerateHighlightsInput,
): Promise<{ requested: number; clips: Clip[] }> {
  const video = await prisma.videoAsset.findUnique({ where: { id: input.videoAssetId } });
  if (!video) throw new NotFoundError('Video asset not found');
  if (!video.url) throw new BadRequestError('Video asset has no source URL');

  const events = await prisma.matchEvent.findMany({
    where: {
      analysis: { videoAssetId: input.videoAssetId },
      type: { in: input.eventTypes as VisionEventType[] },
      confidence: { gte: input.minConfidence ?? 0.6 },
      ...(input.matchId ? { matchId: input.matchId } : {}),
    },
    orderBy: { occurredAtMs: 'asc' },
    take: input.maxClips ?? 20,
  });

  const adapter = getClipAdapter();
  const clips: Clip[] = [];
  for (const e of events) {
    const startMs = Math.max(0, e.occurredAtMs - (input.perEventLeadMs ?? 5000));
    const endMs = e.occurredAtMs + (input.perEventTrailMs ?? 5000);

    try {
      const submission = await adapter.submit({
        videoUrl: video.url,
        startMs,
        endMs,
        format: 'MP4',
        thumbnail: true,
      });

      const clip = await prisma.clip.create({
        data: {
          videoAssetId: input.videoAssetId,
          matchId: input.matchId ?? video.matchId,
          playerId: e.primaryPlayerId ?? null,
          sourceEventId: e.id,
          purpose: 'HIGHLIGHT',
          status: 'RENDERING',
          startMs,
          endMs,
          renderProvider: adapter.kind,
          externalRenderId: submission.externalRenderId,
          title: `${e.type} @ ${Math.round(e.occurredAtMs / 1000)}s`,
          tags: [e.type.toLowerCase()],
          requestedBy: actor.userId,
        },
      });
      clips.push(clip);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('clip submit failed', err);
    }
  }

  await writeVisionAudit({
    videoAssetId: video.id,
    matchId: video.matchId,
    userId: actor.userId,
    action: 'HIGHLIGHTS_GENERATED',
    category: 'CLIP',
    metadata: { requested: clips.length, eventTypes: input.eventTypes, minConfidence: input.minConfidence },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { requested: clips.length, clips };
}

export async function applyRenderCallback(
  externalRenderId: string,
  input: ClipRenderCallbackInput,
): Promise<Clip> {
  const clip = await prisma.clip.findFirst({ where: { externalRenderId } });
  if (!clip) throw new NotFoundError('Clip not found for that render id');

  const updated = await prisma.clip.update({
    where: { id: clip.id },
    data: {
      status: input.status as ClipStatus,
      url: input.url ?? clip.url,
      thumbnailUrl: input.thumbnailUrl ?? clip.thumbnailUrl,
      durationMs: input.durationMs ?? clip.durationMs,
      bytes: input.bytes ?? clip.bytes,
      description:
        input.error
          ? `${clip.description ?? ''}\n[render error] ${input.error}`.trim()
          : clip.description,
    },
  });

  await writeVisionAudit({
    videoAssetId: clip.videoAssetId,
    matchId: clip.matchId,
    action: 'CLIP_RENDER_CALLBACK',
    category: 'CLIP',
    resourceType: 'Clip',
    resourceId: clip.id,
    metadata: { status: input.status, error: input.error ?? null },
    result: input.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
    message: input.error ?? null,
  });

  return updated;
}

export async function listClips(opts: {
  videoAssetId?: string;
  matchId?: string;
  trainingSessionId?: string;
  playerId?: string;
  purpose?: ClipPurpose;
  status?: ClipStatus;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.clip.findMany({
    where: {
      ...(opts.videoAssetId ? { videoAssetId: opts.videoAssetId } : {}),
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.trainingSessionId ? { trainingSessionId: opts.trainingSessionId } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getClip(id: string): Promise<Clip> {
  const clip = await prisma.clip.findUnique({ where: { id } });
  if (!clip) throw new NotFoundError('Clip not found');
  return clip;
}

void Prisma;
