// Familista — Match service (Phase B)
// ─────────────────────────────────────────────────────────────────────────
// Club + team-scoped. Every privileged write writes one MatchAuditLog row
// in the same transaction as the mutation. Live-state transitions go
// through dedicated helpers so the rules stay in one place.

import {
  CompetitionType, MatchResult, MatchStatus, MatchAuditAction, Match, Prisma,
} from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { publish } from '../realtime/match-channel';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface MatchActor {
  userId:     string;
  clubId:     string;
  role?:      string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreateMatchDto {
  homeTeam:        string;
  awayTeam:        string;
  isHome:          boolean;
  competition:     CompetitionType;
  competitionName?: string;
  venue?:          string;
  scheduledAt:     string;
  // Phase B
  teamId?:         string | null;
  formationHome?:  string;
  formationAway?:  string;
  opponentNotes?:  string;
}

export interface UpdateMatchDto {
  homeScore?:      number;
  awayScore?:      number;
  result?:         MatchResult;
  playedAt?:       string;
  possession?:     number;
  shots?:          number;
  shotsOnTarget?:  number;
  corners?:        number;
  fouls?:          number;
  yellowCards?:    number;
  redCards?:       number;
  // Phase B
  teamId?:         string | null;
  status?:         MatchStatus;
  periodNow?:      number;
  liveMinute?:     number;
  formationHome?:  string;
  formationAway?:  string;
  opponentNotes?:  string;
  aiInsights?:     Prisma.JsonValue;
}

export interface MatchFilters {
  competition?: CompetitionType;
  status?:      MatchStatus;
  teamId?:      string | 'NULL';
  from?:        Date | null;
  to?:          Date | null;
  search?:      string;
  page?:        number;
  limit?:       number;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function snapshot(m: Match): Record<string, unknown> {
  return {
    id: m.id, clubId: m.clubId, teamId: m.teamId,
    homeTeam: m.homeTeam, awayTeam: m.awayTeam, isHome: m.isHome,
    competition: m.competition, competitionName: m.competitionName,
    status: m.status, periodNow: m.periodNow, liveMinute: m.liveMinute,
    homeScore: m.homeScore, awayScore: m.awayScore, result: m.result,
    venue: m.venue, scheduledAt: m.scheduledAt, playedAt: m.playedAt,
    possession: m.possession, shots: m.shots, shotsOnTarget: m.shotsOnTarget,
    corners: m.corners, fouls: m.fouls, yellowCards: m.yellowCards, redCards: m.redCards,
    formationHome: m.formationHome, formationAway: m.formationAway,
    opponentNotes: m.opponentNotes, deviceSessionId: m.deviceSessionId,
  };
}

// Validates teamId belongs to actor's club. Reused by create + update.
async function assertTeamInClub(clubId: string, teamId: string | null | undefined): Promise<void> {
  if (!teamId) return;
  const t = await prisma.team.findUnique({ where: { id: teamId }, select: { clubId: true } });
  if (!t)                        throw new NotFoundError('Team');
  if (t.clubId !== clubId)       throw new ForbiddenError();
}

// Allowed status transitions. Anything else throws BadRequestError.
const ALLOWED: Record<MatchStatus, MatchStatus[]> = {
  SCHEDULED: ['LIVE', 'POSTPONED', 'CANCELLED'],
  LIVE:      ['HALFTIME', 'FT', 'ABANDONED'],
  HALFTIME:  ['LIVE', 'FT', 'ABANDONED'],
  FT:        [],
  POSTPONED: ['SCHEDULED', 'CANCELLED'],
  ABANDONED: [],
  CANCELLED: [],
};

function assertStatusTransition(from: MatchStatus, to: MatchStatus): void {
  if (from === to) return;
  if (!ALLOWED[from].includes(to)) {
    throw new BadRequestError(`Illegal status transition: ${from} → ${to}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────

export async function getMatches(clubId: string, filters: MatchFilters = {}) {
  const { competition, status, teamId, from, to, search, page = 1, limit = 20 } = filters;
  const skip = (page - 1) * limit;

  const where: Prisma.MatchWhereInput = {
    clubId,
    ...(competition && { competition }),
    ...(status      && { status }),
    ...(teamId === 'NULL' ? { teamId: null } : teamId ? { teamId } : {}),
    ...((from || to) && {
      scheduledAt: {
        ...(from && { gte: from }),
        ...(to   && { lte: to }),
      },
    }),
    ...(search && {
      OR: [
        { homeTeam:        { contains: search, mode: 'insensitive' } },
        { awayTeam:        { contains: search, mode: 'insensitive' } },
        { competitionName: { contains: search, mode: 'insensitive' } },
        { venue:           { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const [matches, total] = await Promise.all([
    prisma.match.findMany({
      where,
      include: {
        playerStats: {
          include: { player: { select: { id: true, firstName: true, lastName: true, number: true, position: true } } },
        },
        team: { select: { id: true, name: true, kind: true } },
        _count: { select: { timeline: true, lineups: true, tacticalSnapshots: true } },
      },
      orderBy: { scheduledAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.match.count({ where }),
  ]);

  return { matches, total, page, limit };
}

export async function getMatchById(id: string, clubId: string) {
  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      playerStats: { include: { player: true } },
      team:        { select: { id: true, name: true, kind: true } },
      deviceSession: { select: { id: true, deviceModel: true, deviceSerial: true, startedAt: true, endedAt: true } },
      lineups:     true,
      timeline:    {
        where:   { isDeleted: false },
        orderBy: [{ occurredAtMin: 'asc' }, { occurredAtSec: 'asc' }, { createdAt: 'asc' }],
      },
      tacticalSnapshots: {
        orderBy: { takenAtMin: 'asc' },
      },
    },
  });

  if (!match)                  throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();
  return match;
}

export async function getMatchResults(clubId: string) {
  const matches = await prisma.match.findMany({
    where: { clubId, result: { not: null } },
    orderBy: { scheduledAt: 'desc' },
    take: 10,
    select: {
      id: true, homeTeam: true, awayTeam: true, isHome: true,
      homeScore: true, awayScore: true, result: true, status: true,
      competition: true, scheduledAt: true, playedAt: true, teamId: true,
    },
  });

  const summary = await prisma.match.groupBy({
    by: ['result'],
    where: { clubId, result: { not: null } },
    _count: { id: true },
  });

  return { recentMatches: matches, summary };
}

// Dashboard helper: next scheduled match in the future
export async function getNextMatch(clubId: string, teamId?: string | null) {
  return prisma.match.findFirst({
    where: {
      clubId,
      status: { in: ['SCHEDULED', 'POSTPONED'] },
      scheduledAt: { gte: new Date() },
      ...(teamId ? { teamId } : {}),
    },
    orderBy: { scheduledAt: 'asc' },
    include: { team: { select: { id: true, name: true } } },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// WRITE (each mutation writes one MatchAuditLog in the same tx)
// ─────────────────────────────────────────────────────────────────────────

export async function createMatch(actor: MatchActor, dto: CreateMatchDto) {
  await assertTeamInClub(actor.clubId, dto.teamId ?? null);
  return prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        clubId:          actor.clubId,
        teamId:          dto.teamId ?? null,
        homeTeam:        dto.homeTeam,
        awayTeam:        dto.awayTeam,
        isHome:          dto.isHome,
        competition:     dto.competition,
        competitionName: dto.competitionName,
        venue:           dto.venue,
        scheduledAt:     new Date(dto.scheduledAt),
        status:          MatchStatus.SCHEDULED,
        formationHome:   dto.formationHome,
        formationAway:   dto.formationAway,
        opponentNotes:   dto.opponentNotes,
      },
    });
    await tx.matchAuditLog.create({
      data: {
        matchId: match.id, clubId: actor.clubId, userId: actor.userId,
        action: MatchAuditAction.CREATE,
        after: snapshot(match) as Prisma.InputJsonValue,
        ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
    return match;
  });
}

export async function updateMatch(actor: MatchActor, id: string, dto: UpdateMatchDto) {
  const existing = await getMatchById(id, actor.clubId);

  if (dto.teamId !== undefined) await assertTeamInClub(actor.clubId, dto.teamId);
  if (dto.status !== undefined && dto.status !== existing.status) {
    assertStatusTransition(existing.status, dto.status);
  }

  return prisma.$transaction(async (tx) => {
    const data: Prisma.MatchUpdateInput = {
      ...(dto.homeScore     !== undefined && { homeScore:     dto.homeScore }),
      ...(dto.awayScore     !== undefined && { awayScore:     dto.awayScore }),
      ...(dto.result        !== undefined && { result:        dto.result }),
      ...(dto.playedAt      !== undefined && { playedAt:      dto.playedAt ? new Date(dto.playedAt) : null }),
      ...(dto.possession    !== undefined && { possession:    dto.possession }),
      ...(dto.shots         !== undefined && { shots:         dto.shots }),
      ...(dto.shotsOnTarget !== undefined && { shotsOnTarget: dto.shotsOnTarget }),
      ...(dto.corners       !== undefined && { corners:       dto.corners }),
      ...(dto.fouls         !== undefined && { fouls:         dto.fouls }),
      ...(dto.yellowCards   !== undefined && { yellowCards:   dto.yellowCards }),
      ...(dto.redCards      !== undefined && { redCards:      dto.redCards }),
      ...(dto.teamId        !== undefined && { teamId:        dto.teamId ?? null }),
      ...(dto.status        !== undefined && { status:        dto.status }),
      ...(dto.periodNow     !== undefined && { periodNow:     dto.periodNow }),
      ...(dto.liveMinute    !== undefined && { liveMinute:    dto.liveMinute }),
      ...(dto.formationHome !== undefined && { formationHome: dto.formationHome }),
      ...(dto.formationAway !== undefined && { formationAway: dto.formationAway }),
      ...(dto.opponentNotes !== undefined && { opponentNotes: dto.opponentNotes }),
      ...(dto.aiInsights    !== undefined && { aiInsights:    dto.aiInsights as Prisma.InputJsonValue }),
    };

    const updated = await tx.match.update({ where: { id }, data });

    let action: MatchAuditAction = MatchAuditAction.UPDATE;
    if (dto.status !== undefined && dto.status !== existing.status) action = MatchAuditAction.STATUS_CHANGED;

    await tx.matchAuditLog.create({
      data: {
        matchId: id, clubId: actor.clubId, userId: actor.userId,
        action,
        before: snapshot(existing as Match) as Prisma.InputJsonValue,
        after:  snapshot(updated)            as Prisma.InputJsonValue,
        ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
    return updated;
  }).then((updated) => {
    // Broadcast status / score changes so live subscribers refresh.
    if (dto.status !== undefined && dto.status !== existing.status) {
      publish({ kind: 'STATUS_CHANGED', matchId: id, clubId: actor.clubId,
        payload: { from: existing.status, to: updated.status, liveMinute: updated.liveMinute, periodNow: updated.periodNow } });
    }
    if ((dto.homeScore !== undefined && dto.homeScore !== existing.homeScore) ||
        (dto.awayScore !== undefined && dto.awayScore !== existing.awayScore)) {
      publish({ kind: 'SCORE_CHANGED', matchId: id, clubId: actor.clubId,
        payload: { homeScore: updated.homeScore, awayScore: updated.awayScore } });
    }
    return updated;
  });
}

export async function deleteMatch(actor: MatchActor, id: string, reason?: string): Promise<void> {
  const existing = await getMatchById(id, actor.clubId);
  await prisma.$transaction(async (tx) => {
    await tx.matchAuditLog.create({
      data: {
        matchId: id, clubId: actor.clubId, userId: actor.userId,
        action: MatchAuditAction.DELETE,
        before: snapshot(existing as Match) as Prisma.InputJsonValue,
        reason,
        ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
    await tx.match.delete({ where: { id } });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Live state transitions — explicit helpers > free-form PATCH
// ─────────────────────────────────────────────────────────────────────────

export async function startLive(actor: MatchActor, id: string) {
  const existing = await getMatchById(id, actor.clubId);
  assertStatusTransition(existing.status, MatchStatus.LIVE);
  return updateMatch(actor, id, {
    status:     MatchStatus.LIVE,
    periodNow:  1,
    liveMinute: 0,
  });
}

export async function setHalftime(actor: MatchActor, id: string) {
  const existing = await getMatchById(id, actor.clubId);
  assertStatusTransition(existing.status, MatchStatus.HALFTIME);
  return updateMatch(actor, id, { status: MatchStatus.HALFTIME });
}

export async function resumeSecondHalf(actor: MatchActor, id: string) {
  const existing = await getMatchById(id, actor.clubId);
  assertStatusTransition(existing.status, MatchStatus.LIVE);
  return updateMatch(actor, id, {
    status: MatchStatus.LIVE,
    periodNow: 2,
    liveMinute: existing.liveMinute ?? 45,
  });
}

export async function finalize(actor: MatchActor, id: string, scoreHome?: number, scoreAway?: number) {
  const existing = await getMatchById(id, actor.clubId);
  assertStatusTransition(existing.status, MatchStatus.FT);
  const home = scoreHome ?? existing.homeScore ?? 0;
  const away = scoreAway ?? existing.awayScore ?? 0;
  const result: MatchResult =
    existing.isHome
      ? (home > away ? MatchResult.WIN : home < away ? MatchResult.LOSS : MatchResult.DRAW)
      : (away > home ? MatchResult.WIN : away < home ? MatchResult.LOSS : MatchResult.DRAW);
  return updateMatch(actor, id, {
    status:   MatchStatus.FT,
    homeScore: home,
    awayScore: away,
    result,
    playedAt: new Date().toISOString(),
  });
}

export async function abandonMatch(actor: MatchActor, id: string, reason?: string) {
  const existing = await getMatchById(id, actor.clubId);
  assertStatusTransition(existing.status, MatchStatus.ABANDONED);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.match.update({ where: { id }, data: { status: MatchStatus.ABANDONED } });
    await tx.matchAuditLog.create({
      data: {
        matchId: id, clubId: actor.clubId, userId: actor.userId,
        action: MatchAuditAction.STATUS_CHANGED,
        before: snapshot(existing as Match) as Prisma.InputJsonValue,
        after:  snapshot(updated) as Prisma.InputJsonValue,
        reason,
        ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Audit reads
// ─────────────────────────────────────────────────────────────────────────

export async function listAudit(matchId: string, clubId: string, page = 1, limit = 50) {
  // ownership check
  await getMatchById(matchId, clubId);
  const where: Prisma.MatchAuditLogWhereInput = { matchId, clubId };
  const [items, total] = await Promise.all([
    prisma.matchAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.matchAuditLog.count({ where }),
  ]);
  return { items, total, page, limit };
}
