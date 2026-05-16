// Familista — Vision Intelligence Engine
// File location: src/services/vision-realtime.service.ts
//
// Real-time match-vision feed. Sideline dashboards subscribe via SSE to a
// match's live stream and receive events as they're detected (or published
// manually). Coach tablet recommendations are pulled separately from the AI
// engine — this service only manages the vision-event stream + state.

import type { Response } from 'express';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { LiveEvent, LiveMatchStream, LiveStreamStatus } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import type {
  UpsertLiveStreamInput,
  PublishLiveEventInput,
} from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

// ─────────────────────────────────────────────────────────────────────────────
// In-process subscriber registry
// ─────────────────────────────────────────────────────────────────────────────

type Subscriber = { res: Response; userId: string | null };

const subscribers = new Map<string, Set<Subscriber>>();
const HEARTBEAT_MS = 15_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const set of subscribers.values()) {
      for (const sub of set) {
        try {
          sub.res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
        } catch {
          /* dead connection — will be cleaned up on next publish */
        }
      }
    }
  }, HEARTBEAT_MS).unref?.() ?? setInterval(() => undefined, HEARTBEAT_MS);
}

function broadcast(matchId: string, event: string, payload: unknown): void {
  const set = subscribers.get(matchId);
  if (!set || set.size === 0) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const dead: Subscriber[] = [];
  for (const sub of set) {
    try {
      sub.res.write(line);
    } catch {
      dead.push(sub);
    }
  }
  for (const d of dead) set.delete(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertStream(
  actor: VisionActor,
  matchId: string,
  input: UpsertLiveStreamInput,
): Promise<LiveMatchStream> {
  const stream = await prisma.liveMatchStream.upsert({
    where: { matchId },
    create: {
      matchId,
      streamUrl: input.streamUrl ?? null,
      ingestJobId: input.ingestJobId ?? null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
    },
    update: {
      streamUrl: input.streamUrl ?? undefined,
      ingestJobId: input.ingestJobId ?? undefined,
      metadata:
        input.metadata === undefined
          ? undefined
          : input.metadata === null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
    },
  });

  await writeVisionAudit({
    matchId,
    userId: actor.userId,
    action: 'LIVE_STREAM_UPSERTED',
    category: 'REALTIME',
    resourceType: 'LiveMatchStream',
    resourceId: stream.id,
    metadata: { streamUrl: stream.streamUrl, status: stream.status },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return stream;
}

export async function transitionStream(
  actor: VisionActor,
  matchId: string,
  status: LiveStreamStatus,
): Promise<LiveMatchStream> {
  const existing = await prisma.liveMatchStream.findUnique({ where: { matchId } });
  if (!existing) throw new NotFoundError('Live stream not found');
  if (existing.status === status) return existing;

  const stream = await prisma.liveMatchStream.update({
    where: { matchId },
    data: {
      status,
      startedAt: status === 'LIVE' && existing.startedAt == null ? new Date() : existing.startedAt,
      endedAt: status === 'ENDED' ? new Date() : existing.endedAt,
    },
  });

  broadcast(matchId, 'stream-status', { matchId, status });

  await writeVisionAudit({
    matchId,
    userId: actor.userId,
    action: 'LIVE_STREAM_STATUS_CHANGED',
    category: 'REALTIME',
    resourceType: 'LiveMatchStream',
    resourceId: existing.id,
    metadata: { from: existing.status, to: status },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return stream;
}

export async function publishLiveEvent(
  actor: VisionActor | null,
  matchId: string,
  input: PublishLiveEventInput,
): Promise<LiveEvent> {
  const stream = await prisma.liveMatchStream.findUnique({ where: { matchId } });
  if (!stream) throw new NotFoundError('Live stream not found');
  if (stream.status === 'ENDED') throw new BadRequestError('Stream has ended');

  const event = await prisma.liveEvent.create({
    data: {
      streamId: stream.id,
      matchId,
      type: input.type,
      occurredAtMs: input.occurredAtMs,
      primaryPlayerId: input.primaryPlayerId ?? null,
      secondaryPlayerId: input.secondaryPlayerId ?? null,
      teamSide: input.teamSide,
      pitchX: input.pitchX ?? null,
      pitchY: input.pitchY ?? null,
      payload:
        input.payload === undefined || input.payload === null
          ? undefined
          : (input.payload as Prisma.InputJsonValue),
      confidence: input.confidence,
    },
  });

  await prisma.liveMatchStream.update({
    where: { id: stream.id },
    data: { lastEventAt: new Date(), status: stream.status === 'IDLE' ? 'LIVE' : stream.status },
  });

  broadcast(matchId, 'event', {
    id: event.id,
    type: event.type,
    occurredAtMs: event.occurredAtMs,
    primaryPlayerId: event.primaryPlayerId,
    secondaryPlayerId: event.secondaryPlayerId,
    teamSide: event.teamSide,
    pitchX: event.pitchX,
    pitchY: event.pitchY,
    payload: event.payload,
    confidence: event.confidence,
    createdAt: event.createdAt,
  });

  await writeVisionAudit({
    matchId,
    userId: actor?.userId ?? null,
    action: 'LIVE_EVENT_PUBLISHED',
    category: 'REALTIME',
    resourceType: 'LiveEvent',
    resourceId: event.id,
    metadata: { type: input.type, occurredAtMs: input.occurredAtMs, teamSide: input.teamSide, confidence: input.confidence },
    ipAddress: actor?.ipAddress ?? null,
    userAgent: actor?.userAgent ?? null,
  });

  return event;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE subscription
// ─────────────────────────────────────────────────────────────────────────────

export async function subscribeSse(actor: VisionActor, matchId: string, res: Response): Promise<void> {
  const stream = await prisma.liveMatchStream.findUnique({ where: { matchId } });
  if (!stream) throw new NotFoundError('Live stream not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  ensureHeartbeat();

  const set = subscribers.get(matchId) ?? new Set<Subscriber>();
  const sub: Subscriber = { res, userId: actor.userId };
  set.add(sub);
  subscribers.set(matchId, set);

  res.write(`event: hello\ndata: ${JSON.stringify({ matchId, status: stream.status })}\n\n`);

  await writeVisionAudit({
    matchId,
    userId: actor.userId,
    action: 'LIVE_SUBSCRIBED',
    category: 'REALTIME',
    resourceType: 'LiveMatchStream',
    resourceId: stream.id,
    metadata: { subscribers: set.size },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  res.on('close', () => {
    set.delete(sub);
    if (set.size === 0) subscribers.delete(matchId);
  });
}

export async function listLiveEvents(opts: {
  matchId: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}): Promise<LiveEvent[]> {
  return await prisma.liveEvent.findMany({
    where: {
      matchId: opts.matchId,
      ...(opts.fromMs != null ? { occurredAtMs: { gte: opts.fromMs } } : {}),
      ...(opts.toMs != null ? { occurredAtMs: { lte: opts.toMs } } : {}),
    },
    orderBy: { occurredAtMs: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 200, 1), 2000),
  });
}

export async function getStream(matchId: string): Promise<LiveMatchStream> {
  const stream = await prisma.liveMatchStream.findUnique({ where: { matchId } });
  if (!stream) throw new NotFoundError('Live stream not found');
  return stream;
}

// For tests / shutdown
export function _shutdownRealtime(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  for (const set of subscribers.values()) {
    for (const sub of set) {
      try {
        sub.res.end();
      } catch {
        /* ignore */
      }
    }
  }
  subscribers.clear();
}
