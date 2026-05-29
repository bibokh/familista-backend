// Familista — Player Statistics Engine (Phase Q)
// ─────────────────────────────────────────────────────────────────────────────
// Computes PlayerMatchStats from MatchEvent rows, then rolls up to
// PlayerSeasonStats. Called by StatsAggregatorWorker after every event batch
// and directly by the match-finalisation flow.
//
// Per-match stats take ~50ms for a 2 000-event match (all in Postgres,
// no external ML). Season rollup is O(n_matches) and runs nightly.

import { Prisma, PlayerMatchStats, PlayerSeasonStats } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';

export interface StatsActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-match stats computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild PlayerMatchStats for every player who touched the ball in this match.
 * Idempotent — upserts on (matchId, playerId). Safe to call repeatedly.
 */
export async function computeMatchStats(matchId: string): Promise<{ rebuilt: number }> {
  // Collect all distinct player IDs from events in this match.
  const playerIds = await prisma.matchEvent.findMany({
    where:   { matchId, playerId: { not: null } },
    select:  { playerId: true, clubId: true, teamId: true },
    distinct: ['playerId'],
  });

  let rebuilt = 0;
  for (const { playerId, clubId, teamId } of playerIds) {
    if (!playerId || !clubId) continue;
    await buildPlayerMatchStats(matchId, playerId, clubId, teamId ?? undefined);
    rebuilt++;
  }

  // Also include players in the starting XI who may have 0 events (injured off at 0).
  const startingXI = await prisma.matchEvent.findMany({
    where:  { matchId, type: 'STARTING_XI', playerId: { not: null } },
    select: { playerId: true, clubId: true, teamId: true },
  });
  for (const { playerId, clubId, teamId } of startingXI) {
    if (!playerId || !clubId) continue;
    // upsert — may already exist from the player-events loop
    await buildPlayerMatchStats(matchId, playerId, clubId, teamId ?? undefined, true);
    rebuilt++;
  }

  return { rebuilt };
}

async function buildPlayerMatchStats(
  matchId: string,
  playerId: string,
  clubId: string,
  teamId?: string,
  isStarting = false,
): Promise<PlayerMatchStats> {
  const events = await prisma.matchEvent.findMany({
    where: { matchId, OR: [{ playerId }, { relatedPlayerId: playerId }] },
    orderBy: [{ periodIndex: 'asc' }, { minuteMs: 'asc' }],
  });

  // Helper: count events where the player is the actor.
  const own   = (type: string) => events.filter((e) => e.playerId === playerId && e.type === type);
  const ownOk = (type: string) => events.filter((e) => e.playerId === playerId && e.type === type && e.outcome === 'COMPLETE');
  const recv  = (type: string) => events.filter((e) => e.relatedPlayerId === playerId && e.type === type);

  // Substitution — determine minutes played.
  const subOff   = own('SUBSTITUTION').find((e) => e.relatedPlayerId === playerId);
  const subOn    = recv('SUBSTITUTION').find((e) => e.playerId === playerId);
  const matchEnd = events.find((e) => e.type === 'MATCH_END');
  const lastMin  = matchEnd ? (matchEnd.minute + (matchEnd.second ?? 0) / 60) : 90;
  const minutesPlayed = isStarting
    ? subOff ? (subOff.minute + (subOff.second ?? 0) / 60) : lastMin
    : subOn  ? lastMin - (subOn.minute + (subOn.second ?? 0) / 60) : 0;

  const shots     = own('SHOT').concat(own('GOAL'));
  const passes    = own('PASS');
  const okPasses  = ownOk('PASS');
  const carries   = own('CARRY');

  // xG sum
  const xgTotal   = shots.reduce((s, e) => s + (e.xg ?? 0), 0);
  const xgotTotal = shots.filter((e) => e.outcome === 'SAVED').reduce((s, e) => s + (e.xgot ?? 0), 0);
  const xaTotal   = passes.reduce((s, e) => s + (e.xa ?? 0), 0);

  // Heatmap: 16×12 grid.
  const grid: number[][] = Array.from({ length: 12 }, () => new Array(16).fill(0));
  for (const e of events.filter((e) => e.playerId === playerId && e.x != null && e.y != null)) {
    const col = Math.min(15, Math.floor((e.x! / 120) * 16));
    const row = Math.min(11, Math.floor((e.y! / 80) * 12));
    grid[row][col]++;
  }

  const progressiveCarries = carries.filter((e) => {
    if (e.x == null || e.endX == null) return false;
    return e.endX > e.x && (e.endX - e.x) > 5;  // >5m toward goal
  }).length;

  const passAcc = passes.length > 0 ? okPasses.length / passes.length : 0;

  const data: Prisma.PlayerMatchStatsCreateInput = {
    match:               { connect: { id: matchId } },
    player:              { connect: { id: playerId } },
    clubId,
    teamId:              teamId ?? null,
    minutesPlayed:       Math.round(minutesPlayed),
    isStarting,
    goals:               own('GOAL').length,
    assists:             recv('GOAL').length,
    shots:               shots.length,
    shotsOnTarget:       shots.filter((e) => ['GOAL', 'SAVED'].includes(e.outcome ?? '')).length,
    shotsBlocked:        shots.filter((e) => e.outcome === 'BLOCKED').length,
    xg:                  +xgTotal.toFixed(4),
    xgot:                +xgotTotal.toFixed(4),
    xa:                  +xaTotal.toFixed(4),
    keyPasses:           passes.filter((e) => e.isKeyPass).length,
    bigChancesCreated:   passes.filter((e) => (e.xa ?? 0) > 0.35).length,
    passes:              passes.length,
    passesCompleted:     okPasses.length,
    passAccuracy:        +passAcc.toFixed(4),
    progressivePasses:   passes.filter((e) => e.isProgressivePass).length,
    carries:             carries.length,
    progressiveCarries,
    dribbles:            own('DRIBBLE').length,
    dribblesCompleted:   ownOk('DRIBBLE').length,
    pressures:           own('PRESSURE').length,
    pressuresSuccessful: own('PRESSURE').filter((e) => e.outcome === 'SUCCESS').length,
    tackles:             own('TACKLE').length,
    tacklesWon:          ownOk('TACKLE').length,
    interceptions:       own('INTERCEPTION').length,
    clearances:          own('CLEARANCE').length,
    blockedShots:        own('BLOCK').length,
    aerialDuels:         own('AERIAL_DUEL').length,
    aerialDuelsWon:      ownOk('AERIAL_DUEL').length,
    groundDuels:         own('GROUND_DUEL').length,
    groundDuelsWon:      ownOk('GROUND_DUEL').length,
    foulsCommitted:      own('FOUL_COMMITTED').length,
    foulsSuffered:       own('FOUL_WON').length,
    yellowCards:         own('YELLOW_CARD').length,
    redCards:            own('RED_CARD').concat(own('SECOND_YELLOW')).length,
    offsides:            own('OFFSIDE').length,
    heatmapGrid:         grid as Prisma.InputJsonValue,
    ratingFamilista:     computeRating({ goals: own('GOAL').length, assists: recv('GOAL').length, xg: xgTotal, xa: xaTotal, passAcc, pressures: own('PRESSURE').length }),
    computedAt:          new Date(),
  };

  return prisma.playerMatchStats.upsert({
    where:  { matchId_playerId: { matchId, playerId } },
    create: data as Prisma.PlayerMatchStatsCreateInput,
    update: data as Prisma.PlayerMatchStatsUpdateInput,
  });
}

/** Simple composite 0–10 rating inspired by Sofascore methodology. */
function computeRating(f: { goals: number; assists: number; xg: number; xa: number; passAcc: number; pressures: number }): number {
  const base = 6.0;
  const bonus =
    f.goals   * 1.5 +
    f.assists * 0.8 +
    Math.min(f.xg - f.goals, 0.5) * 0.8 +   // xG over goals (chance quality)
    f.passAcc * 0.6 +
    Math.min(f.pressures / 20, 0.4);
  return +Math.min(10, Math.max(1, base + bonus)).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Season rollup
// ─────────────────────────────────────────────────────────────────────────────

export async function rollupSeasonStats(
  playerId: string,
  clubId: string,
  season: string,
  competitionId?: string,
): Promise<PlayerSeasonStats> {
  const where: Prisma.PlayerMatchStatsWhereInput = {
    playerId,
    clubId,
    match: competitionId
      ? { fixtures: { some: { competitionId } } }
      : undefined,
  };

  const rows = await prisma.playerMatchStats.findMany({ where });
  if (rows.length === 0) {
    return prisma.playerSeasonStats.upsert({
      where:  { playerId_clubId_season_competitionId: { playerId, clubId, season, competitionId: competitionId ?? '' } } as any,
      create: { playerId, clubId, season, competitionId: competitionId ?? null, computedAt: new Date(), updatedAt: new Date() },
      update: { computedAt: new Date(), updatedAt: new Date() },
    });
  }

  const sum = <K extends keyof (typeof rows[0])>(key: K) =>
    rows.reduce((s, r) => s + ((r[key] as number) ?? 0), 0);
  const avg = <K extends keyof (typeof rows[0])>(key: K) => {
    const vals = rows.filter((r) => (r[key] as number) != null).map((r) => r[key] as number);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };

  const appearances   = rows.length;
  const starts        = rows.filter((r) => r.isStarting).length;
  const minutesPlayed = sum('minutesPlayed');
  const per90 = (v: number) => minutesPlayed > 0 ? +(v / (minutesPlayed / 90)).toFixed(4) : 0;

  const goals   = sum('goals');
  const assists = sum('assists');
  const xg      = +sum('xg').toFixed(4);
  const xa      = +sum('xa').toFixed(4);

  const passAcc      = avg('passAccuracy');
  const pressureSucc = rows.reduce((s, r) => s + r.pressuresSuccessful, 0) /
    Math.max(rows.reduce((s, r) => s + r.pressures, 0), 1);
  const aerialSucc   = rows.reduce((s, r) => s + r.aerialDuelsWon, 0) /
    Math.max(rows.reduce((s, r) => s + r.aerialDuels, 0), 1);
  const dribbleSucc  = rows.reduce((s, r) => s + r.dribblesCompleted, 0) /
    Math.max(rows.reduce((s, r) => s + r.dribbles, 0), 1);

  const data: Prisma.PlayerSeasonStatsCreateInput = {
    player:              { connect: { id: playerId } },
    clubId,
    competition:         competitionId ? { connect: { id: competitionId } } : undefined,
    season,
    appearances,
    starts,
    minutesPlayed,
    goals,
    assists,
    xg,
    xa,
    xgPer90:             per90(xg),
    xaPer90:             per90(xa),
    goalsPer90:          per90(goals),
    assistsPer90:        per90(assists),
    passAccuracy:        +passAcc.toFixed(4),
    pressureSuccessRate: +pressureSucc.toFixed(4),
    aerialSuccessRate:   +aerialSucc.toFixed(4),
    dribbleSuccessRate:  +dribbleSucc.toFixed(4),
    averageRating:       +avg('ratingFamilista' as any).toFixed(2),
    avgDistancePer90:    per90(sum('distanceCoveredKm' as any)),
    avgSprintsPer90:     per90(sum('sprintDistanceKm' as any)),
    computedAt:          new Date(),
    updatedAt:           new Date(),
  };

  return prisma.playerSeasonStats.upsert({
    where:  { playerId_clubId_season_competitionId: { playerId, clubId, season, competitionId: competitionId ?? '' } } as any,
    create: data as any,
    update: data as any,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Read APIs
// ─────────────────────────────────────────────────────────────────────────────

export async function getMatchStats(matchId: string, playerId: string): Promise<PlayerMatchStats | null> {
  return prisma.playerMatchStats.findUnique({ where: { matchId_playerId: { matchId, playerId } } });
}

export async function listMatchStats(matchId: string): Promise<PlayerMatchStats[]> {
  return prisma.playerMatchStats.findMany({
    where: { matchId }, orderBy: { minutesPlayed: 'desc' },
  });
}

export async function getSeasonStats(playerId: string, season: string, clubId?: string): Promise<PlayerSeasonStats[]> {
  return prisma.playerSeasonStats.findMany({
    where: { playerId, season, ...(clubId ? { clubId } : {}) },
    orderBy: { computedAt: 'desc' },
  });
}

export async function getPlayerProfile(playerId: string): Promise<{
  player: { id: string } | null;
  latestSeason: PlayerSeasonStats | null;
  careerStats: { totalGoals: number; totalAssists: number; totalAppearances: number };
}> {
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { id: true } });
  if (!player) throw new NotFoundError('Player');

  const seasons = await prisma.playerSeasonStats.findMany({ where: { playerId }, orderBy: { season: 'desc' } });
  const latestSeason = seasons[0] ?? null;

  const careerStats = {
    totalGoals:       seasons.reduce((s, r) => s + r.goals, 0),
    totalAssists:     seasons.reduce((s, r) => s + r.assists, 0),
    totalAppearances: seasons.reduce((s, r) => s + r.appearances, 0),
  };
  return { player, latestSeason, careerStats };
}
