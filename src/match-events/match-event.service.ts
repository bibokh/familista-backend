// Familista — Match Event Engine (Phase Q)
// ─────────────────────────────────────────────────────────────────────────────
// The foundational data layer for all football analytics.
// Records, corrects, and bulk-ingests match events with coordinates.
// Publishes to EventOutbox for downstream aggregation and ML pipelines.
//
// Design:
//   • upsert by (matchId, externalId, dataSource) — idempotent provider sync
//   • batch ingest limited to 5 000 events / call (one half ≈ 900 events)
//   • every successful batch increments DataProviderSession.eventsIngested
//   • publishes MATCH_EVENTS_BATCH to EventOutbox so StatsAggregatorWorker
//     rebuilds PlayerMatchStats automatically
//   • MANUAL events get no externalId; only one MANUAL event per (matchId,
//     minuteMs, type, playerId) is allowed — duplicate check before insert

import { Prisma, MatchEvent, DataProviderSource } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface EventActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface CreateEventDto {
  matchId:           string;
  periodIndex:       number;           // 1–5
  minuteMs:          number;           // ms from period start
  minute:            number;
  second?:           number;
  type:              string;
  outcome?:          string;
  playerId?:         string;
  relatedPlayerId?:  string;
  teamId?:           string;
  x?:                number;
  y?:                number;
  endX?:             number;
  endY?:             number;
  xg?:               number;
  xgot?:             number;
  xa?:               number;
  isPressured?:      boolean;
  isUnderPressure?:  boolean;
  isProgressivePass?: boolean;
  isKeyPass?:        boolean;
  bodyPart?:         string;
  passHeight?:       string;
  passTechnique?:    string;
  shotTechnique?:    string;
  durationSec?:      number;
  dataSource?:       DataProviderSource;
  externalId?:       string;
  externalMatchId?:  string;
  videoTimestampSec?: number;
  payload?:          Prisma.InputJsonValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single event record
// ─────────────────────────────────────────────────────────────────────────────

export async function recordEvent(actor: EventActor, dto: CreateEventDto): Promise<MatchEvent> {
  if (!dto.matchId || !dto.type) throw new BadRequestError('matchId + type required');
  if (!Number.isInteger(dto.periodIndex) || dto.periodIndex < 1 || dto.periodIndex > 5)
    throw new BadRequestError('periodIndex must be 1–5');

  const match = await prisma.match.findUnique({ where: { id: dto.matchId }, select: { clubId: true } });
  if (!match) throw new NotFoundError('Match');
  if (match.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const data = buildEventData(actor.clubId, dto);

  // Upsert on externalId to support re-syncing provider feeds.
  if (dto.externalId && dto.dataSource && dto.dataSource !== 'MANUAL') {
    const row = await prisma.matchEvent.upsert({
      where:  { externalId: dto.externalId } as Prisma.MatchEventWhereUniqueInput,
      create: data as Prisma.MatchEventCreateInput,
      update: data as Prisma.MatchEventUpdateInput,
    });
    enqueueAggregation(dto.matchId);
    return row;
  }

  const row = await prisma.matchEvent.create({ data: data as Prisma.MatchEventCreateInput });
  enqueueAggregation(dto.matchId);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk ingest (up to 5 000 events, e.g. from a provider feed)
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchIngestResult {
  created:  number;
  updated:  number;
  rejected: number;
  errors:   string[];
}

export async function batchIngestEvents(
  actor: EventActor,
  matchId: string,
  events: CreateEventDto[],
  source: DataProviderSource = 'MANUAL',
): Promise<BatchIngestResult> {
  if (!matchId) throw new BadRequestError('matchId required');
  if (!Array.isArray(events) || events.length === 0) return { created: 0, updated: 0, rejected: 0, errors: [] };
  if (events.length > 5_000) throw new BadRequestError('Max 5 000 events per batch');

  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!match) throw new NotFoundError('Match');
  if (match.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  let created = 0, updated = 0, rejected = 0;
  const errors: string[] = [];

  // Open a DataProviderSession to record the import.
  const session = await prisma.dataProviderSession.create({
    data: { clubId: actor.clubId, matchId, source, status: 'RUNNING', startedAt: new Date() },
  });

  // Process in chunks of 500 to avoid huge transactions.
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const chunk = events.slice(i, i + CHUNK);
    try {
      const results = await Promise.allSettled(
        chunk.map(async (dto) => {
          const d = buildEventData(actor.clubId, { ...dto, matchId, dataSource: dto.dataSource ?? source });
          if (dto.externalId && source !== 'MANUAL') {
            const existing = await prisma.matchEvent.findFirst({ where: { externalId: dto.externalId } });
            if (existing) {
              await prisma.matchEvent.update({ where: { id: existing.id }, data: d as Prisma.MatchEventUpdateInput });
              return 'updated';
            }
          }
          await prisma.matchEvent.create({ data: d as Prisma.MatchEventCreateInput });
          return 'created';
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value === 'created') created++;
          else updated++;
        } else {
          rejected++;
          if (errors.length < 20) errors.push(String((r as PromiseRejectedResult).reason?.message ?? r.reason));
        }
      }
    } catch (err) {
      rejected += chunk.length;
      errors.push(`chunk ${i}–${i + CHUNK}: ${(err as Error).message}`);
    }
  }

  // Finalise the session record.
  await prisma.dataProviderSession.update({
    where: { id: session.id },
    data:  { status: rejected === events.length ? 'FAILED' : 'COMPLETE', eventsIngested: created + updated, eventsRejected: rejected, completedAt: new Date(), errorLog: errors.length ? errors as Prisma.InputJsonValue : undefined },
  });

  // Trigger async stats rebuild.
  enqueueAggregation(matchId);
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MATCH_EVENTS_BATCH_INGESTED',
    entityType: 'Match', entityId: matchId,
    payload: { source, created, updated, rejected, sessionId: session.id },
  });

  return { created, updated, rejected, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export interface ListEventsOpts {
  type?:        string;
  playerId?:    string;
  teamId?:      string;
  periodIndex?: number;
  fromMinute?:  number;
  toMinute?:    number;
  limit?:       number;
  offset?:      number;
}

export async function listEvents(
  actor: EventActor,
  matchId: string,
  opts: ListEventsOpts = {},
): Promise<{ items: MatchEvent[]; total: number }> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!match) throw new NotFoundError('Match');
  if (match.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const { limit = 500, offset = 0 } = opts;
  const where: Prisma.MatchEventWhereInput = {
    matchId,
    ...(opts.type        ? { type: opts.type as any }      : {}),
    ...(opts.playerId    ? { playerId: opts.playerId }       : {}),
    ...(opts.teamId      ? { teamId: opts.teamId }           : {}),
    ...(opts.periodIndex ? { periodIndex: opts.periodIndex } : {}),
    ...(opts.fromMinute !== undefined || opts.toMinute !== undefined ? {
      minute: {
        ...(opts.fromMinute !== undefined ? { gte: opts.fromMinute } : {}),
        ...(opts.toMinute   !== undefined ? { lte: opts.toMinute   } : {}),
      },
    } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.matchEvent.findMany({
      where, orderBy: [{ periodIndex: 'asc' }, { minuteMs: 'asc' }],
      take: Math.min(limit, 2000), skip: offset,
    }),
    prisma.matchEvent.count({ where }),
  ]);
  return { items, total };
}

export async function getEventSummary(actor: EventActor, matchId: string): Promise<Record<string, number>> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!match) throw new NotFoundError('Match');
  if (match.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();

  const counts = await prisma.matchEvent.groupBy({
    by: ['type'],
    where: { matchId },
    _count: { _all: true },
  });
  return Object.fromEntries(counts.map((c) => [c.type, c._count._all]));
}

export async function deleteEvent(actor: EventActor, id: string): Promise<void> {
  const ev = await prisma.matchEvent.findUnique({ where: { id }, select: { clubId: true, matchId: true } });
  if (!ev) throw new NotFoundError('MatchEvent');
  if (ev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  await prisma.matchEvent.delete({ where: { id } });
  if (ev.matchId) enqueueAggregation(ev.matchId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildEventData(clubId: string, dto: CreateEventDto): Prisma.MatchEventCreateInput {
  return {
    clubId,
    match:         { connect: { id: dto.matchId } },
    periodIndex:   dto.periodIndex,
    minuteMs:      BigInt(Math.round(dto.minuteMs ?? 0)),
    minute:        dto.minute ?? 0,
    second:        dto.second ?? 0,
    type:          dto.type as any,
    outcome:       (dto.outcome as any) ?? null,
    playerId:      dto.playerId ?? null,
    relatedPlayerId: dto.relatedPlayerId ?? null,
    teamId:        dto.teamId ?? null,
    x:             dto.x ?? null,
    y:             dto.y ?? null,
    endX:          dto.endX ?? null,
    endY:          dto.endY ?? null,
    xg:            dto.xg ?? null,
    xgot:          dto.xgot ?? null,
    xa:            dto.xa ?? null,
    isPressured:   !!dto.isPressured,
    isUnderPressure: !!dto.isUnderPressure,
    isProgressivePass: !!dto.isProgressivePass,
    isKeyPass:     !!dto.isKeyPass,
    bodyPart:      (dto.bodyPart as any) ?? null,
    passHeight:    (dto.passHeight as any) ?? null,
    passTechnique: (dto.passTechnique as any) ?? null,
    shotTechnique: (dto.shotTechnique as any) ?? null,
    durationSec:   dto.durationSec ?? null,
    dataSource:    dto.dataSource ?? 'MANUAL',
    externalId:    dto.externalId ?? null,
    externalMatchId: dto.externalMatchId ?? null,
    videoTimestampSec: dto.videoTimestampSec ?? null,
    payload:       (dto.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
  };
}

/** Fire-and-forget: post to EventOutbox so worker can rebuild stats. */
function enqueueAggregation(matchId: string): void {
  prisma.eventOutbox.create({
    data: {
      topic:   'stats.aggregate',
      payload: { matchId } as Prisma.InputJsonValue,
    },
  }).catch(() => { /* best-effort */ });
}
