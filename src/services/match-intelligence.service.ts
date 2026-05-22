// Familista — Match Intelligence service (Phase B)
// ─────────────────────────────────────────────────────────────────────────
// Three sub-modules:
//   1. Lineups            — squad + position grid per side (HOME/AWAY)
//   2. Timeline           — live human-entered events (goal/card/sub/note)
//   3. Tactical Snapshots — frozen state of pitch + formation + notes
//
// Tenancy: every write asserts ownership of the parent Match by the actor's
// clubId. Every write records one MatchAuditLog row in the same transaction.

import {
  Match,
  MatchAuditAction,
  MatchSide,
  MatchTimelineKind,
  MatchTacticalPhase,
  TacticalSource,
  Prisma,
} from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import type { MatchActor } from './match.service';
import { publish } from '../realtime/match-channel';
// Phase E — best-effort hooks. Imported lazily-safe (services do not throw).
import { evaluateAsync } from './rules-engine.service';
import { publishMatchEvent } from '../big-data/publisher';

// ─────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────

async function assertMatchInClub(matchId: string, clubId: string): Promise<Match> {
  const m = await prisma.match.findUnique({ where: { id: matchId } });
  if (!m)                       throw new NotFoundError('Match');
  if (m.clubId !== clubId)      throw new ForbiddenError();
  return m;
}

async function assertPlayerInClub(playerId: string, clubId: string): Promise<void> {
  const p = await prisma.player.findUnique({ where: { id: playerId }, select: { clubId: true } });
  if (!p)                  throw new NotFoundError('Player');
  if (p.clubId !== clubId) throw new ForbiddenError();
}

function writeAudit(
  tx: Prisma.TransactionClient,
  actor: MatchActor,
  matchId: string,
  action: MatchAuditAction,
  before?: Prisma.JsonValue,
  after?: Prisma.JsonValue,
  reason?: string,
) {
  return tx.matchAuditLog.create({
    data: {
      matchId,
      clubId:   actor.clubId,
      userId:   actor.userId,
      action,
      before:   before as Prisma.InputJsonValue | undefined,
      after:    after  as Prisma.InputJsonValue | undefined,
      reason,
      ipAddress: actor.ipAddress ?? undefined,
      userAgent: actor.userAgent ?? undefined,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 1. LINEUPS
// ─────────────────────────────────────────────────────────────────────────

export interface LineupPositionOwn {
  playerId:      string;
  position?:     string;     // 'GK','DC','MC','ST'…
  x?:            number;     // 0..100
  y?:            number;     // 0..100
  isStarter:     boolean;
  captainBand?:  boolean;
  jerseyNumber?: number;
}
export interface LineupPositionOpp {
  name:          string;
  position?:     string;
  x?:            number;
  y?:            number;
  isStarter:     boolean;
  jerseyNumber?: number;
}

export interface SetLineupDto {
  side:       MatchSide;
  formation?: string;
  notes?:     string;
  positions:  Array<LineupPositionOwn | LineupPositionOpp>;
}

// Validate the positions array against the actor's club.
// Own-team rows MUST reference players belonging to the same club.
async function validateLineupPositions(
  clubId: string,
  side: MatchSide,
  ownSide: MatchSide,
  positions: Array<LineupPositionOwn | LineupPositionOpp>,
): Promise<void> {
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new BadRequestError('Lineup must include at least one position');
  }
  if (side === ownSide) {
    // Validate every playerId belongs to club; check for duplicates
    const ids = new Set<string>();
    for (const p of positions as LineupPositionOwn[]) {
      if (!p.playerId) throw new BadRequestError('Own-team positions require playerId');
      if (ids.has(p.playerId)) throw new BadRequestError('Duplicate player in lineup');
      ids.add(p.playerId);
    }
    // Bulk-verify clubId in one query
    const found = await prisma.player.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, clubId: true },
    });
    if (found.length !== ids.size) throw new NotFoundError('One or more players not found');
    for (const p of found) if (p.clubId !== clubId) throw new ForbiddenError();
  } else {
    // Opponent side — free-text names
    for (const p of positions as LineupPositionOpp[]) {
      if (!p.name) throw new BadRequestError('Opponent positions require name');
    }
  }
}

// "Our side" = HOME if Match.isHome=true, else AWAY.
function ourSide(m: Match): MatchSide {
  return m.isHome ? MatchSide.HOME : MatchSide.AWAY;
}

export async function setLineup(actor: MatchActor, matchId: string, dto: SetLineupDto) {
  const match = await assertMatchInClub(matchId, actor.clubId);
  await validateLineupPositions(actor.clubId, dto.side, ourSide(match), dto.positions);

  const existing = await prisma.matchLineup.findUnique({
    where: { matchId_side: { matchId, side: dto.side } },
  });

  return prisma.$transaction(async (tx) => {
    let lineup;
    if (existing) {
      lineup = await tx.matchLineup.update({
        where: { id: existing.id },
        data: {
          formation: dto.formation ?? existing.formation,
          notes:     dto.notes     ?? existing.notes,
          positions: dto.positions as unknown as Prisma.InputJsonValue,
        },
      });
    } else {
      lineup = await tx.matchLineup.create({
        data: {
          matchId, side: dto.side,
          formation: dto.formation,
          notes:     dto.notes,
          positions: dto.positions as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // Mirror formation onto Match for fast read.
    if (dto.formation) {
      await tx.match.update({
        where: { id: matchId },
        data:  dto.side === MatchSide.HOME ? { formationHome: dto.formation } : { formationAway: dto.formation },
      });
    }

    await writeAudit(tx, actor, matchId, MatchAuditAction.LINEUP_SET,
      existing ? { lineupId: existing.id, side: dto.side } : undefined,
      { lineupId: lineup.id, side: dto.side, formation: dto.formation, n: dto.positions.length },
    );
    return lineup;
  }).then((lineup) => {
    publish({ kind: 'LINEUP_SET', matchId, clubId: actor.clubId,
      payload: { side: dto.side, formation: dto.formation, n: dto.positions.length } });
    return lineup;
  });
}

export async function getLineups(matchId: string, clubId: string) {
  await assertMatchInClub(matchId, clubId);
  return prisma.matchLineup.findMany({ where: { matchId }, orderBy: { side: 'asc' } });
}

// ─────────────────────────────────────────────────────────────────────────
// 2. TIMELINE — append-only stream of human-entered events
// ─────────────────────────────────────────────────────────────────────────

export interface AddTimelineDto {
  occurredAtMin:     number;
  occurredAtSec?:    number;
  period?:           number;
  kind:              MatchTimelineKind;
  side:              MatchSide;
  primaryPlayerId?:  string | null;
  secondaryPlayerId?:string | null;
  opponentName?:     string | null;
  pitchX?:           number | null;
  pitchY?:           number | null;
  notes?:            string | null;
  payload?:          Prisma.JsonValue;
}

export async function addTimelineEvent(actor: MatchActor, matchId: string, dto: AddTimelineDto) {
  const match = await assertMatchInClub(matchId, actor.clubId);
  if (dto.primaryPlayerId)   await assertPlayerInClub(dto.primaryPlayerId,   actor.clubId);
  if (dto.secondaryPlayerId) await assertPlayerInClub(dto.secondaryPlayerId, actor.clubId);

  return prisma.$transaction(async (tx) => {
    const evt = await tx.matchTimeline.create({
      data: {
        matchId,
        occurredAtMin:     dto.occurredAtMin,
        occurredAtSec:     dto.occurredAtSec,
        period:            dto.period ?? match.periodNow ?? 1,
        kind:              dto.kind,
        side:              dto.side,
        primaryPlayerId:   dto.primaryPlayerId   ?? null,
        secondaryPlayerId: dto.secondaryPlayerId ?? null,
        opponentName:      dto.opponentName      ?? null,
        pitchX:            dto.pitchX            ?? null,
        pitchY:            dto.pitchY            ?? null,
        notes:             dto.notes             ?? null,
        payload:           (dto.payload ?? null) as Prisma.InputJsonValue,
        enteredByUserId:   actor.userId,
      },
    });

    // Score-bumping side effects (server-side so the client cannot lie):
    //   GOAL                → +1 to side's score
    //   PENALTY_SCORED      → +1 to side's score
    //   OWN_GOAL            → +1 to opposite side
    if (dto.kind === MatchTimelineKind.GOAL || dto.kind === MatchTimelineKind.PENALTY_SCORED) {
      const field = dto.side === MatchSide.HOME ? 'homeScore' : 'awayScore';
      await tx.match.update({ where: { id: matchId }, data: { [field]: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.OWN_GOAL) {
      const field = dto.side === MatchSide.HOME ? 'awayScore' : 'homeScore';
      await tx.match.update({ where: { id: matchId }, data: { [field]: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.YELLOW_CARD) {
      await tx.match.update({ where: { id: matchId }, data: { yellowCards: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.RED_CARD || dto.kind === MatchTimelineKind.SECOND_YELLOW) {
      await tx.match.update({ where: { id: matchId }, data: { redCards: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.CORNER) {
      await tx.match.update({ where: { id: matchId }, data: { corners: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.FOUL) {
      await tx.match.update({ where: { id: matchId }, data: { fouls: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.SHOT || dto.kind === MatchTimelineKind.SHOT_OFF_TARGET) {
      await tx.match.update({ where: { id: matchId }, data: { shots: { increment: 1 } } });
    } else if (dto.kind === MatchTimelineKind.SHOT_ON_TARGET) {
      await tx.match.update({ where: { id: matchId }, data: { shots: { increment: 1 }, shotsOnTarget: { increment: 1 } } });
    }

    await writeAudit(tx, actor, matchId, MatchAuditAction.TIMELINE_ADDED, undefined,
      { timelineId: evt.id, kind: dto.kind, side: dto.side, min: dto.occurredAtMin });
    return evt;
  }).then((evt) => {
    publish({ kind: 'TIMELINE_ADDED', matchId, clubId: actor.clubId, payload: evt });
    // Score-bumping kinds also emit a SCORE_CHANGED follow-up so dumb clients
    // that only listen for SCORE_CHANGED can refresh.
    if (['GOAL','OWN_GOAL','PENALTY_SCORED'].includes(evt.kind as unknown as string)) {
      publish({ kind: 'SCORE_CHANGED', matchId, clubId: actor.clubId,
        payload: { trigger: evt.kind, side: evt.side, min: evt.occurredAtMin } });
    }
    // Phase E — best-effort fan-out + rules eval. NEVER block return.
    publishMatchEvent(actor.clubId, matchId, evt);
    evaluateAsync(matchId, actor.clubId);
    return evt;
  });
}

export async function listTimeline(matchId: string, clubId: string, opts: { kind?: MatchTimelineKind; side?: MatchSide; includeDeleted?: boolean } = {}) {
  await assertMatchInClub(matchId, clubId);
  const where: Prisma.MatchTimelineWhereInput = {
    matchId,
    ...(opts.kind && { kind: opts.kind }),
    ...(opts.side && { side: opts.side }),
    ...(opts.includeDeleted ? {} : { isDeleted: false }),
  };
  return prisma.matchTimeline.findMany({
    where,
    orderBy: [{ occurredAtMin: 'asc' }, { occurredAtSec: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function editTimelineEvent(actor: MatchActor, matchId: string, eventId: string, dto: Partial<AddTimelineDto>) {
  await assertMatchInClub(matchId, actor.clubId);
  const existing = await prisma.matchTimeline.findUnique({ where: { id: eventId } });
  if (!existing || existing.matchId !== matchId) throw new NotFoundError('Timeline event');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.matchTimeline.update({
      where: { id: eventId },
      data: {
        ...(dto.occurredAtMin     !== undefined && { occurredAtMin:     dto.occurredAtMin }),
        ...(dto.occurredAtSec     !== undefined && { occurredAtSec:     dto.occurredAtSec }),
        ...(dto.period            !== undefined && { period:            dto.period }),
        ...(dto.kind              !== undefined && { kind:              dto.kind }),
        ...(dto.side              !== undefined && { side:              dto.side }),
        ...(dto.primaryPlayerId   !== undefined && { primaryPlayerId:   dto.primaryPlayerId }),
        ...(dto.secondaryPlayerId !== undefined && { secondaryPlayerId: dto.secondaryPlayerId }),
        ...(dto.opponentName      !== undefined && { opponentName:      dto.opponentName }),
        ...(dto.pitchX            !== undefined && { pitchX:            dto.pitchX }),
        ...(dto.pitchY            !== undefined && { pitchY:            dto.pitchY }),
        ...(dto.notes             !== undefined && { notes:             dto.notes }),
        ...(dto.payload           !== undefined && { payload:           dto.payload as Prisma.InputJsonValue }),
      },
    });
    await writeAudit(tx, actor, matchId, MatchAuditAction.TIMELINE_EDITED,
      { timelineId: existing.id, kind: existing.kind, side: existing.side },
      { timelineId: updated.id,  kind: updated.kind,  side: updated.side });
    return updated;
  }).then((updated) => {
    publish({ kind: 'TIMELINE_EDITED', matchId, clubId: actor.clubId, payload: updated });
    return updated;
  });
}

// Soft-delete a timeline event. Scores are NOT auto-rolled-back — coaches
// re-enter or use editTimelineEvent if a value is wrong.
export async function deleteTimelineEvent(actor: MatchActor, matchId: string, eventId: string, reason?: string): Promise<void> {
  await assertMatchInClub(matchId, actor.clubId);
  const existing = await prisma.matchTimeline.findUnique({ where: { id: eventId } });
  if (!existing || existing.matchId !== matchId) throw new NotFoundError('Timeline event');
  if (existing.isDeleted) return;
  await prisma.$transaction(async (tx) => {
    await tx.matchTimeline.update({ where: { id: eventId }, data: { isDeleted: true } });
    await writeAudit(tx, actor, matchId, MatchAuditAction.TIMELINE_DELETED,
      { timelineId: eventId, kind: existing.kind, side: existing.side, min: existing.occurredAtMin },
      undefined, reason);
  });
  publish({ kind: 'TIMELINE_DELETED', matchId, clubId: actor.clubId, payload: { timelineId: eventId } });
}

// ─────────────────────────────────────────────────────────────────────────
// 3. TACTICAL SNAPSHOTS
// ─────────────────────────────────────────────────────────────────────────

export interface SnapshotDto {
  takenAtMin: number;
  period?:    number;
  phase?:     MatchTacticalPhase;
  formation?: string;
  possession?: number;
  positions:   Prisma.JsonValue;
  notes?:      string;
  source?:     TacticalSource;
}

export async function takeSnapshot(actor: MatchActor, matchId: string, dto: SnapshotDto) {
  const match = await assertMatchInClub(matchId, actor.clubId);
  return prisma.$transaction(async (tx) => {
    const snap = await tx.matchTacticalSnapshot.create({
      data: {
        matchId,
        takenAtMin:  dto.takenAtMin,
        period:      dto.period     ?? match.periodNow ?? 1,
        phase:       dto.phase      ?? MatchTacticalPhase.OPEN_PLAY,
        formation:   dto.formation  ?? match.formationHome ?? null,
        possession:  dto.possession ?? null,
        positions:   dto.positions as Prisma.InputJsonValue,
        notes:       dto.notes     ?? null,
        source:      dto.source    ?? TacticalSource.MANUAL,
        authorUserId: actor.userId,
      },
    });
    await writeAudit(tx, actor, matchId, MatchAuditAction.SNAPSHOT_TAKEN, undefined,
      { snapshotId: snap.id, takenAtMin: dto.takenAtMin, phase: snap.phase });
    return snap;
  }).then((snap) => {
    publish({ kind: 'SNAPSHOT_TAKEN', matchId, clubId: actor.clubId,
      payload: { id: snap.id, takenAtMin: snap.takenAtMin, phase: snap.phase, formation: snap.formation } });
    return snap;
  });
}

export async function listSnapshots(matchId: string, clubId: string) {
  await assertMatchInClub(matchId, clubId);
  return prisma.matchTacticalSnapshot.findMany({
    where: { matchId },
    orderBy: { takenAtMin: 'asc' },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// AI / Big-Data hooks (placeholders — Phase C wires them up)
// ─────────────────────────────────────────────────────────────────────────

// Returns a feature bundle suitable for streaming to Kafka or feeding to an
// LLM. Pure read — no side effects.
export async function getMatchFeatureBundle(matchId: string, clubId: string) {
  const match = await assertMatchInClub(matchId, clubId);
  const [timeline, snapshots, lineups] = await Promise.all([
    listTimeline(matchId, clubId),
    listSnapshots(matchId, clubId),
    getLineups(matchId, clubId),
  ]);
  return {
    match,
    counts: { timeline: timeline.length, snapshots: snapshots.length, lineups: lineups.length },
    timeline,
    snapshots,
    lineups,
    // Phase C: device session + sensor packet aggregates land here.
  };
}
