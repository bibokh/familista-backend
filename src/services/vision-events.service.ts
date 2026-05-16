// Familista — Vision Intelligence Engine
// File location: src/services/vision-events.service.ts
//
// MatchEvent reads + the human-override path. Operators (typically coaches /
// analysts) can correct mis-detected events — every override is audited and
// preserved alongside the original AI-derived row.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  MatchEvent,
  TeamSide,
  VisionEventType,
} from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import type { OverrideEventInput } from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

export type EventListOpts = {
  analysisId?: string;
  matchId?: string;
  type?: VisionEventType;
  playerId?: string;
  teamSide?: TeamSide;
  fromMs?: number;
  toMs?: number;
  minConfidence?: number;
  cursor?: string;
  limit?: number;
};

export async function listEvents(opts: EventListOpts) {
  const take = Math.min(Math.max(opts.limit ?? 100, 1), 2000);
  const items = await prisma.matchEvent.findMany({
    where: {
      ...(opts.analysisId ? { analysisId: opts.analysisId } : {}),
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.playerId
        ? { OR: [{ primaryPlayerId: opts.playerId }, { secondaryPlayerId: opts.playerId }] }
        : {}),
      ...(opts.teamSide ? { teamSide: opts.teamSide } : {}),
      ...(opts.fromMs != null ? { occurredAtMs: { gte: opts.fromMs } } : {}),
      ...(opts.toMs != null ? { occurredAtMs: { lte: opts.toMs } } : {}),
      ...(opts.minConfidence != null ? { confidence: { gte: opts.minConfidence } } : {}),
    },
    orderBy: [{ occurredAtMs: 'asc' }, { id: 'asc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getEvent(id: string): Promise<MatchEvent> {
  const event = await prisma.matchEvent.findUnique({ where: { id } });
  if (!event) throw new NotFoundError('Event not found');
  return event;
}

export async function overrideEvent(
  actor: VisionActor,
  id: string,
  input: OverrideEventInput,
): Promise<MatchEvent> {
  const existing = await prisma.matchEvent.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Event not found');

  if (
    input.type === undefined &&
    input.primaryPlayerId === undefined &&
    input.secondaryPlayerId === undefined &&
    input.teamSide === undefined &&
    input.pitchX === undefined &&
    input.pitchY === undefined
  ) {
    throw new BadRequestError('No fields to override');
  }

  const updated = await prisma.matchEvent.update({
    where: { id },
    data: {
      type: input.type ?? existing.type,
      primaryPlayerId: input.primaryPlayerId === undefined ? undefined : input.primaryPlayerId,
      secondaryPlayerId: input.secondaryPlayerId === undefined ? undefined : input.secondaryPlayerId,
      teamSide: input.teamSide ?? existing.teamSide,
      pitchX: input.pitchX === undefined ? undefined : input.pitchX,
      pitchY: input.pitchY === undefined ? undefined : input.pitchY,
      overrideReason: input.reason,
      overriddenBy: actor.userId,
      overriddenAt: new Date(),
    },
  });

  await writeVisionAudit({
    analysisId: existing.analysisId,
    matchId: existing.matchId,
    userId: actor.userId,
    action: 'EVENT_OVERRIDDEN',
    category: 'OVERRIDE',
    resourceType: 'MatchEvent',
    resourceId: id,
    metadata: {
      reason: input.reason,
      from: {
        type: existing.type,
        primaryPlayerId: existing.primaryPlayerId,
        teamSide: existing.teamSide,
        pitchX: existing.pitchX,
        pitchY: existing.pitchY,
      },
      to: {
        type: updated.type,
        primaryPlayerId: updated.primaryPlayerId,
        teamSide: updated.teamSide,
        pitchX: updated.pitchX,
        pitchY: updated.pitchY,
      },
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function eventTypeCounts(opts: {
  analysisId?: string;
  matchId?: string;
  teamSide?: TeamSide;
}): Promise<Record<string, number>> {
  const where: Prisma.MatchEventWhereInput = {
    ...(opts.analysisId ? { analysisId: opts.analysisId } : {}),
    ...(opts.matchId ? { matchId: opts.matchId } : {}),
    ...(opts.teamSide ? { teamSide: opts.teamSide } : {}),
  };
  const groups = await prisma.matchEvent.groupBy({ where, by: ['type'], _count: { _all: true } });
  return Object.fromEntries(groups.map((g) => [g.type, g._count._all]));
}
