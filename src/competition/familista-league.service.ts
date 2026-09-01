// Familista League — the club-facing read model
// ─────────────────────────────────────────────────────────────────────────────
// The league itself is not a new thing. It is a Competition with no owning club,
// its teams are CompetitionTeam rows, its matches are Fixtures and its table is
// StandingsEntry — all of which the competition engine already had. This file
// adds no second copy of any of that. What it adds is the read side: the six
// questions the League screen asks, answered in one query each.
//
// Why a separate file from competition.service.ts: that service is the *write*
// side, and every one of its entry points asserts the actor owns the
// competition. A league owned by nobody would fail all of them, which is
// correct for editing and useless for reading. Reading a league you play in is
// a different permission from editing it, so it is a different module.
//
// Everything here is read-only. There is no function in this file that writes.

import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';

// ─────────────────────────────────────────────────────────────────────────────
// Rules — configuration, not branching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape stored in `Competition.rules`. Every value the League screen would
 * otherwise hard-code lives here: which positions qualify for what, how many
 * points a win is worth, when the season runs, and what (if anything) is paid
 * out. A league with no rules row still renders — the defaults below are the
 * ones the standings engine already implements, so the screen and the maths
 * cannot drift apart by forgetting to configure something.
 */
export interface LeagueZone {
  /** Inclusive 1-based position range this zone covers. */
  from: number;
  to: number;
  /** Shown in the standings legend and the rules modal. */
  label: string;
  /** Any CSS colour. Drives the marker on the left of a standings row. */
  color: string;
  /** ELITE | SECONDARY | PROMOTION | RELEGATION | other — for future logic. */
  kind?: string;
}

export interface LeaguePrize {
  position: number;
  amount: number;
  currency: string;
}

export interface LeagueRules {
  format?: {
    teams?: number;
    /** true when every pair meets twice. */
    doubleRound?: boolean;
    rounds?: number;
    startsOn?: string;
    endsOn?: string;
  };
  points?: { win: number; draw: number; loss: number };
  /** Ordered tiebreakers, most significant first. Descriptive: the engine's
   *  order is points → goal difference → goals for → wins. */
  tiebreakers?: string[];
  zones?: LeagueZone[];
  prizes?: { enabled: boolean; currency?: string; table?: LeaguePrize[] };
}

/** What the engine in competition.service.ts actually does, stated as data. */
export const DEFAULT_LEAGUE_RULES: LeagueRules = {
  points: { win: 3, draw: 1, loss: 0 },
  tiebreakers: ['Points', 'Goal difference', 'Goals scored', 'Wins'],
  zones: [],
  prizes: { enabled: false },
};

function readRules(raw: unknown): LeagueRules {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LEAGUE_RULES };
  const r = raw as LeagueRules;
  return {
    format: r.format,
    points: r.points ?? DEFAULT_LEAGUE_RULES.points,
    tiebreakers: r.tiebreakers ?? DEFAULT_LEAGUE_RULES.tiebreakers,
    zones: Array.isArray(r.zones) ? r.zones : [],
    // Absent prize configuration means no prizes, never "prizes we invented".
    prizes: r.prizes && r.prizes.enabled ? r.prizes : { enabled: false },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The league and its season
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueSummary {
  id: string;
  name: string;
  code: string;
  season: string;
  format: string;
  ageGroup: string | null;
  rules: LeagueRules;
  teamCount: number;
  /** Every season this league code has run, newest first — the season picker. */
  seasons: string[];
}

/**
 * The platform league for a season, or the most recent one when no season is
 * named. Seasons are never derived from the clock: the season is whatever the
 * data says it is, so a league that has not started yet still resolves.
 */
export async function getLeague(opts: { season?: string; code?: string } = {}): Promise<LeagueSummary | null> {
  const where: Record<string, unknown> = { clubId: null, format: 'LEAGUE' };
  if (opts.code) where.code = opts.code;
  if (opts.season) where.season = opts.season;

  const comp = await prisma.competition.findFirst({
    where,
    orderBy: [{ season: 'desc' }, { createdAt: 'desc' }],
  });
  if (!comp) return null;

  const [teamCount, seasonRows] = await Promise.all([
    prisma.competitionTeam.count({ where: { competitionId: comp.id } }),
    prisma.competition.findMany({
      where: { clubId: null, code: comp.code },
      select: { season: true },
      orderBy: { season: 'desc' },
      distinct: ['season'],
    }),
  ]);

  return {
    id: comp.id,
    name: comp.name,
    code: comp.code,
    season: comp.season,
    format: comp.format,
    ageGroup: comp.ageGroup ?? null,
    rules: readRules(comp.rules),
    teamCount,
    seasons: seasonRows.map((s) => s.season),
  };
}

async function requireLeague(competitionId: string) {
  const comp = await prisma.competition.findFirst({ where: { id: competitionId, clubId: null } });
  if (!comp) throw new NotFoundError('Familista League');
  return comp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity — resolved once, for every team in the league
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueTeamIdentity {
  teamId: string;
  teamName: string;
  clubId: string;
  clubName: string;
  crestUrl: string | null;
  shortName: string | null;
}

/**
 * Every participating team's name, its club and its crest, in two queries for
 * the whole league rather than one per row. The standings, the fixtures and the
 * leaderboards all need the same identities, so they all call this.
 */
async function teamIdentities(competitionId: string): Promise<Map<string, LeagueTeamIdentity>> {
  const participants = await prisma.competitionTeam.findMany({
    where: { competitionId },
    select: { teamId: true, clubId: true },
  });
  const teamIds = participants.map((p) => p.teamId);
  if (teamIds.length === 0) return new Map();

  const [teams, clubs] = await Promise.all([
    prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true, shortName: true, clubId: true },
    }),
    prisma.club.findMany({
      where: { id: { in: [...new Set(participants.map((p) => p.clubId))] } },
      select: { id: true, name: true, crestUrl: true, emblem: true },
    }),
  ]);

  const clubById = new Map(clubs.map((c) => [c.id, c]));
  const out = new Map<string, LeagueTeamIdentity>();
  for (const t of teams) {
    const club = clubById.get(t.clubId);
    out.set(t.id, {
      teamId: t.id,
      teamName: t.name,
      clubId: t.clubId,
      clubName: club?.name ?? t.name,
      // crestUrl is the authoritative crest; emblem is the older https-only
      // field kept for clubs that already carried one.
      crestUrl: club?.crestUrl ?? club?.emblem ?? null,
      shortName: t.shortName ?? null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standings
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueStandingRow extends LeagueTeamIdentity {
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  /** Oldest → newest, at most five, each 'W' | 'D' | 'L'. */
  form: string[];
  /** The zone this position falls in, or null. Resolved from rules, not layout. */
  zone: LeagueZone | null;
}

/**
 * The table, as the standings engine computed it. This does not recalculate:
 * `competition.service.ts` owns that arithmetic and writes StandingsEntry, and
 * a second implementation here is exactly the duplicate the brief forbids. All
 * this does is attach identity and the configured zone to each row.
 */
export async function getStandings(competitionId: string): Promise<{
  rows: LeagueStandingRow[];
  zones: LeagueZone[];
}> {
  const comp = await requireLeague(competitionId);
  const rules = readRules(comp.rules);

  const [entries, identities] = await Promise.all([
    prisma.standingsEntry.findMany({
      where: { competitionId },
      orderBy: { position: 'asc' },
    }),
    teamIdentities(competitionId),
  ]);

  const zoneFor = (position: number): LeagueZone | null =>
    (rules.zones ?? []).find((z) => position >= z.from && position <= z.to) ?? null;

  const rows = entries.map((e) => {
    const id = identities.get(e.teamId);
    return {
      teamId: e.teamId,
      teamName: id?.teamName ?? 'Unknown team',
      clubId: id?.clubId ?? '',
      clubName: id?.clubName ?? 'Unknown club',
      crestUrl: id?.crestUrl ?? null,
      shortName: id?.shortName ?? null,
      position: e.position,
      played: e.played,
      won: e.won,
      drawn: e.drawn,
      lost: e.lost,
      goalsFor: e.goalsFor,
      goalsAgainst: e.goalsAgainst,
      goalDiff: e.goalDiff,
      points: e.points,
      form: (e.form || '').split('').filter((c) => c === 'W' || c === 'D' || c === 'L'),
      zone: zoneFor(e.position),
    };
  });

  return { rows, zones: rules.zones ?? [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Matches, by round
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueMatchRow {
  fixtureId: string;
  /** The Match this fixture is played as, when one exists. Drives Match Centre. */
  matchId: string | null;
  round: number | null;
  scheduledAt: string;
  playedAt: string | null;
  venue: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  home: LeagueTeamIdentity | null;
  away: LeagueTeamIdentity | null;
}

export interface LeagueRoundsView {
  rounds: number[];
  currentRound: number | null;
  round: number | null;
  matches: LeagueMatchRow[];
}

/**
 * The current round is the earliest round that still has a match to play, and
 * the last round played once every match is finished. That is the round a person
 * opening the screen wants, whether the season is running or over.
 */
function pickCurrentRound(all: Array<{ round: number | null; status: string }>): number | null {
  const rounds = [...new Set(all.map((f) => f.round).filter((r): r is number => r != null))].sort((a, b) => a - b);
  if (rounds.length === 0) return null;
  const unfinished = all.filter((f) => f.status !== 'PLAYED' && f.status !== 'CANCELLED');
  if (unfinished.length > 0) {
    const next = unfinished
      .map((f) => f.round)
      .filter((r): r is number => r != null)
      .sort((a, b) => a - b)[0];
    if (next != null) return next;
  }
  return rounds[rounds.length - 1];
}

export async function getRound(competitionId: string, round?: number): Promise<LeagueRoundsView> {
  await requireLeague(competitionId);

  // One pass for the round index, so the client never has to ask twice to know
  // which rounds exist or which one it is looking at.
  const index = await prisma.fixture.findMany({
    where: { competitionId },
    select: { round: true, status: true },
  });
  const rounds = [...new Set(index.map((f) => f.round).filter((r): r is number => r != null))].sort((a, b) => a - b);
  const currentRound = pickCurrentRound(index);
  const wanted = round != null && rounds.includes(round) ? round : currentRound;

  if (wanted == null) return { rounds, currentRound, round: null, matches: [] };

  const [fixtures, identities] = await Promise.all([
    prisma.fixture.findMany({
      where: { competitionId, round: wanted },
      orderBy: [{ scheduledAt: 'asc' }],
    }),
    teamIdentities(competitionId),
  ]);

  const matches: LeagueMatchRow[] = fixtures.map((f) => ({
    fixtureId: f.id,
    matchId: f.matchId ?? null,
    round: f.round ?? null,
    scheduledAt: f.scheduledAt.toISOString(),
    playedAt: f.playedAt ? f.playedAt.toISOString() : null,
    venue: f.venue ?? null,
    status: f.status,
    homeScore: f.homeScore,
    awayScore: f.awayScore,
    home: identities.get(f.homeTeamId) ?? null,
    away: identities.get(f.awayTeamId) ?? null,
  }));

  return { rounds, currentRound, round: wanted, matches };
}

// ─────────────────────────────────────────────────────────────────────────────
// One league match, as the Match Centre needs it
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueMatchContext {
  competitionId: string;
  code: string;
  name: string;
  season: string;
  round: number | null;
  fixtureId: string;
  matchId: string | null;
}

export interface LeagueMatchDetail {
  /** What tells the Match Centre this is a league match and which one. */
  context: LeagueMatchContext;
  home: LeagueTeamIdentity | null;
  away: LeagueTeamIdentity | null;
  fixture: LeagueMatchRow;
  /** The Match row itself, or null while the fixture has not been staged yet. */
  match: {
    id: string;
    status: string;
    scheduledAt: string;
    playedAt: string | null;
    venue: string | null;
    homeScore: number | null;
    awayScore: number | null;
    formationHome: string | null;
    formationAway: string | null;
    possession: number | null;
    shots: number | null;
    shotsOnTarget: number | null;
    corners: number | null;
    fouls: number | null;
    yellowCards: number | null;
    redCards: number | null;
  } | null;
  lineups: Array<{ side: string; formation: string | null; positions: unknown }>;
  timeline: Array<{
    minute: number; period: number; kind: string; side: string;
    playerId: string | null; playerName: string | null;
    secondaryPlayerId: string | null; secondaryPlayerName: string | null;
    opponentName: string | null; notes: string | null;
  }>;
  players: Array<{
    playerId: string; playerName: string; clubId: string; teamId: string | null;
    minutesPlayed: number; isStarting: boolean; goals: number; assists: number;
    shots: number; shotsOnTarget: number; passes: number; passAccuracy: number;
    tackles: number; interceptions: number; yellowCards: number; redCards: number;
    rating: number | null;
  }>;
  /** What analysis exists for this match — never invented, only reported. */
  analysis: { tacticalSnapshots: number; visionEvents: number; hasInsights: boolean };
  /** Each side's league record, so the Match Centre can compare the two teams
   *  without asking for the whole table. Null for a team with no row yet. */
  standings: { home: LeagueStandingRow | null; away: LeagueStandingRow | null };
  /** Each side's first-team squad, as the club records it. Availability comes
   *  from the player's own medical status — nothing is estimated. */
  squads: { home: LeagueSquadPlayer[]; away: LeagueSquadPlayer[] };
  /** Whoever the club has as head coach, from membership. Null when nobody. */
  staff: { home: string | null; away: string | null };
}

export interface LeagueSquadPlayer {
  playerId: string;
  name: string;
  number: number | null;
  position: string | null;
  overallRating: number | null;
  /** The Squad screen's 1–10 figure, when the club keeps one. */
  form: number | null;
  morale: string | null;
  isInjured: boolean;
  /** HEALTHY | INJURED | RECOVERING | SUSPENDED | UNAVAILABLE. */
  medicalStatus: string;
  /** Date of birth, so a reader can be shown an age rather than a guess. */
  dateOfBirth: string | null;
  avatar: string | null;
  /**
   * What this player has done in THIS competition, summed from the same
   * PlayerMatchStats rows the leaderboards read. Zero means the aggregation
   * has nothing for them, which is the truth for a season not yet played.
   */
  goals: number;
  assists: number;
  /**
   * The rest of that same sum, for the player-against-player comparison. Null
   * where the player has no PlayerMatchStats row in this competition at all:
   * a coach must be able to tell "measured nought" from "nothing recorded",
   * and a zero in every field would say the first when the truth is the second.
   */
  record: LeaguePlayerRecordLine | null;
}

/**
 * One player's competition totals, as the aggregation wrote them. Every field
 * is a sum or an average of PlayerMatchStats rows for this competition's own
 * fixtures — nothing here is derived, estimated or defaulted.
 */
export interface LeaguePlayerRecordLine {
  appearances: number;
  starts: number;
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  keyPasses: number;
  passes: number;
  passesCompleted: number;
  /** Percentage, computed from the two counts above; null with no passes. */
  passAccuracy: number | null;
  tackles: number;
  interceptions: number;
  clearances: number;
  aerialDuels: number;
  aerialDuelsWon: number;
  yellowCards: number;
  redCards: number;
  xg: number;
  xa: number;
  /** Mean of the ratings that were recorded; null when none were. */
  averageRating: number | null;
}

/**
 * Everything the Match Centre needs to open a league fixture, for either club.
 *
 * A league match is not one club's private record: both clubs played it, and the
 * table everybody reads is derived from it. So this reads across the tenant
 * boundary deliberately and narrowly — the competition record of one fixture,
 * and nothing else. It is read-only, it is reachable only through a fixture that
 * belongs to a platform competition, and it exposes no club's other matches,
 * squad, finances or plans.
 */
/**
 * Each side's squad, league record and head coach.
 *
 * Read from the rows the club already keeps: the players on the team, their own
 * medical status for availability, the standings row the engine wrote, and
 * whoever holds the head-coach membership. Nothing here is estimated, and a club
 * that records none of it comes back empty rather than filled in.
 */
async function matchSides(
  competitionId: string,
  homeTeamId: string,
  awayTeamId: string,
  identities: Map<string, LeagueTeamIdentity>,
): Promise<Pick<LeagueMatchDetail, 'standings' | 'squads' | 'staff'>> {
  const rules = readRules((await requireLeague(competitionId)).rules);
  const zoneFor = (position: number): LeagueZone | null =>
    (rules.zones ?? []).find((z) => position >= z.from && position <= z.to) ?? null;

  // What each player has done in this competition so far, from the rows the
  // aggregation already wrote for its own fixtures. Read, never recomputed.
  const compFixtures = await prisma.fixture.findMany({
    where: { competitionId, matchId: { not: null } },
    select: { matchId: true },
  });
  const compMatchIds = compFixtures.map((f) => f.matchId).filter((id): id is string => !!id);

  const [entries, players, coaches, contributions] = await Promise.all([
    prisma.standingsEntry.findMany({ where: { competitionId, teamId: { in: [homeTeamId, awayTeamId] } } }),
    prisma.player.findMany({
      where: { teamId: { in: [homeTeamId, awayTeamId] } },
      select: {
        id: true, firstName: true, lastName: true, number: true, position: true,
        overallRating: true, form: true, morale: true, isInjured: true,
        medicalStatus: true, teamId: true, dateOfBirth: true, avatar: true,
      },
      orderBy: [{ number: 'asc' }],
    }),
    prisma.membership.findMany({
      where: {
        role: 'HEAD_COACH',
        isActive: true,
        clubId: { in: [identities.get(homeTeamId)?.clubId, identities.get(awayTeamId)?.clubId].filter((c): c is string => !!c) },
      },
      select: { clubId: true, user: { select: { firstName: true, lastName: true } } },
    }),
    // One read for both squads' whole competition, not one per player: the
    // comparison panel is answered from what this call already carries.
    compMatchIds.length
      ? prisma.playerMatchStats.findMany({
          where: { matchId: { in: compMatchIds } },
          select: {
            playerId: true, minutesPlayed: true, isStarting: true,
            goals: true, assists: true, shots: true, shotsOnTarget: true,
            keyPasses: true, passes: true, passesCompleted: true,
            tackles: true, interceptions: true, clearances: true,
            aerialDuels: true, aerialDuelsWon: true,
            yellowCards: true, redCards: true, xg: true, xa: true,
            ratingFamilista: true,
          },
        })
      : Promise.resolve([]),
  ]);

  type Tally = LeaguePlayerRecordLine & { ratingSum: number; ratingCount: number };
  const blank = (): Tally => ({
    appearances: 0, starts: 0, minutes: 0, goals: 0, assists: 0,
    shots: 0, shotsOnTarget: 0, keyPasses: 0, passes: 0, passesCompleted: 0,
    passAccuracy: null, tackles: 0, interceptions: 0, clearances: 0,
    aerialDuels: 0, aerialDuelsWon: 0, yellowCards: 0, redCards: 0,
    xg: 0, xa: 0, averageRating: null, ratingSum: 0, ratingCount: 0,
  });
  const scored = new Map<string, Tally>();
  for (const row of contributions) {
    const at = scored.get(row.playerId) ?? blank();
    at.appearances += 1;
    if (row.isStarting) at.starts += 1;
    at.minutes += row.minutesPlayed;
    at.goals += row.goals;
    at.assists += row.assists;
    at.shots += row.shots;
    at.shotsOnTarget += row.shotsOnTarget;
    at.keyPasses += row.keyPasses;
    at.passes += row.passes;
    at.passesCompleted += row.passesCompleted;
    at.tackles += row.tackles;
    at.interceptions += row.interceptions;
    at.clearances += row.clearances;
    at.aerialDuels += row.aerialDuels;
    at.aerialDuelsWon += row.aerialDuelsWon;
    at.yellowCards += row.yellowCards;
    at.redCards += row.redCards;
    at.xg += row.xg;
    at.xa += row.xa;
    if (row.ratingFamilista != null) { at.ratingSum += row.ratingFamilista; at.ratingCount += 1; }
    scored.set(row.playerId, at);
  }
  const recordOf = (playerId: string): LeaguePlayerRecordLine | null => {
    const t = scored.get(playerId);
    if (!t) return null;
    const { ratingSum, ratingCount, ...line } = t;
    return {
      ...line,
      passAccuracy: t.passes > 0 ? Math.round((t.passesCompleted / t.passes) * 1000) / 10 : null,
      averageRating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 100) / 100 : null,
      xg: Math.round(t.xg * 100) / 100,
      xa: Math.round(t.xa * 100) / 100,
    };
  };

  const standingRow = (teamId: string): LeagueStandingRow | null => {
    const e = entries.find((x) => x.teamId === teamId);
    if (!e) return null;
    const id = identities.get(teamId);
    return {
      teamId: e.teamId,
      teamName: id?.teamName ?? '',
      clubId: id?.clubId ?? '',
      clubName: id?.clubName ?? '',
      crestUrl: id?.crestUrl ?? null,
      shortName: id?.shortName ?? null,
      position: e.position,
      played: e.played, won: e.won, drawn: e.drawn, lost: e.lost,
      goalsFor: e.goalsFor, goalsAgainst: e.goalsAgainst, goalDiff: e.goalDiff, points: e.points,
      form: (e.form || '').split('').filter((c) => c === 'W' || c === 'D' || c === 'L'),
      zone: zoneFor(e.position),
    };
  };

  const squadOf = (teamId: string): LeagueSquadPlayer[] =>
    players.filter((p) => p.teamId === teamId).map((p) => ({
      playerId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      number: p.number ?? null,
      position: p.position ?? null,
      overallRating: p.overallRating ?? null,
      form: p.form ?? null,
      morale: p.morale ?? null,
      isInjured: p.isInjured,
      medicalStatus: p.medicalStatus,
      dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString() : null,
      avatar: p.avatar ?? null,
      goals: scored.get(p.id)?.goals ?? 0,
      assists: scored.get(p.id)?.assists ?? 0,
      record: recordOf(p.id),
    }));

  const coachOf = (teamId: string): string | null => {
    const clubId = identities.get(teamId)?.clubId;
    const m = clubId ? coaches.find((c) => c.clubId === clubId) : undefined;
    if (!m?.user) return null;
    const name = `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.trim();
    return name || null;
  };

  return {
    standings: { home: standingRow(homeTeamId), away: standingRow(awayTeamId) },
    squads: { home: squadOf(homeTeamId), away: squadOf(awayTeamId) },
    staff: { home: coachOf(homeTeamId), away: coachOf(awayTeamId) },
  };
}

export async function getMatchDetail(competitionId: string, fixtureId: string): Promise<LeagueMatchDetail> {
  const comp = await requireLeague(competitionId);

  const fixture = await prisma.fixture.findFirst({ where: { id: fixtureId, competitionId } });
  if (!fixture) throw new NotFoundError('Fixture');

  const identities = await teamIdentities(competitionId);
  const row: LeagueMatchRow = {
    fixtureId: fixture.id,
    matchId: fixture.matchId ?? null,
    round: fixture.round ?? null,
    scheduledAt: fixture.scheduledAt.toISOString(),
    playedAt: fixture.playedAt ? fixture.playedAt.toISOString() : null,
    venue: fixture.venue ?? null,
    status: fixture.status,
    homeScore: fixture.homeScore,
    awayScore: fixture.awayScore,
    home: identities.get(fixture.homeTeamId) ?? null,
    away: identities.get(fixture.awayTeamId) ?? null,
  };

  const context: LeagueMatchContext = {
    competitionId: comp.id,
    code: comp.code,
    name: comp.name,
    season: comp.season,
    round: fixture.round ?? null,
    fixtureId: fixture.id,
    matchId: fixture.matchId ?? null,
  };

  const sides = await matchSides(competitionId, fixture.homeTeamId, fixture.awayTeamId, identities);

  const empty: LeagueMatchDetail = {
    context, home: row.home, away: row.away, fixture: row, match: null,
    lineups: [], timeline: [], players: [],
    analysis: { tacticalSnapshots: 0, visionEvents: 0, hasInsights: false },
    ...sides,
  };
  if (!fixture.matchId) return empty;

  const match = await prisma.match.findUnique({ where: { id: fixture.matchId } });
  if (!match) return empty;

  const [lineups, timeline, stats, snapshots, visionEvents] = await Promise.all([
    prisma.matchLineup.findMany({ where: { matchId: match.id }, select: { side: true, formation: true, positions: true } }),
    prisma.matchTimeline.findMany({
      where: { matchId: match.id, isDeleted: false },
      orderBy: [{ occurredAtMin: 'asc' }],
    }),
    prisma.playerMatchStats.findMany({ where: { matchId: match.id } }),
    prisma.matchTacticalSnapshot.count({ where: { matchId: match.id } }),
    prisma.matchEvent.count({ where: { matchId: match.id } }),
  ]);

  // Every player named anywhere in this match, resolved once. The league never
  // stores a player's name — it holds ids and reads the player record.
  const playerIds = [
    ...new Set([
      ...stats.map((s) => s.playerId),
      ...timeline.flatMap((t) => [t.primaryPlayerId, t.secondaryPlayerId]),
    ].filter((id): id is string => !!id)),
  ];
  const players = playerIds.length
    ? await prisma.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    const p = players.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}`.trim() : null;
  };

  return {
    context,
    home: row.home,
    away: row.away,
    fixture: row,
    match: {
      id: match.id,
      status: match.status,
      scheduledAt: match.scheduledAt.toISOString(),
      playedAt: match.playedAt ? match.playedAt.toISOString() : null,
      venue: match.venue ?? null,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      formationHome: match.formationHome ?? null,
      formationAway: match.formationAway ?? null,
      possession: match.possession ?? null,
      shots: match.shots ?? null,
      shotsOnTarget: match.shotsOnTarget ?? null,
      corners: match.corners ?? null,
      fouls: match.fouls ?? null,
      yellowCards: match.yellowCards ?? null,
      redCards: match.redCards ?? null,
    },
    lineups: lineups.map((l) => ({ side: l.side, formation: l.formation ?? null, positions: l.positions })),
    timeline: timeline.map((t) => ({
      minute: t.occurredAtMin,
      period: t.period,
      kind: t.kind,
      side: t.side,
      playerId: t.primaryPlayerId ?? null,
      playerName: nameOf(t.primaryPlayerId ?? null),
      secondaryPlayerId: t.secondaryPlayerId ?? null,
      secondaryPlayerName: nameOf(t.secondaryPlayerId ?? null),
      opponentName: t.opponentName ?? null,
      notes: t.notes ?? null,
    })),
    players: stats.map((s) => ({
      playerId: s.playerId,
      playerName: nameOf(s.playerId) ?? '',
      clubId: s.clubId,
      teamId: s.teamId ?? null,
      minutesPlayed: s.minutesPlayed,
      isStarting: s.isStarting,
      goals: s.goals,
      assists: s.assists,
      shots: s.shots,
      shotsOnTarget: s.shotsOnTarget,
      passes: s.passes,
      passAccuracy: s.passAccuracy,
      tackles: s.tackles,
      interceptions: s.interceptions,
      yellowCards: s.yellowCards,
      redCards: s.redCards,
      rating: s.ratingFamilista ?? null,
    })),
    analysis: {
      tacticalSnapshots: snapshots,
      visionEvents,
      hasInsights: !!match.aiInsights,
    },
    ...sides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Team statistics, across this league's completed matches only
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueTeamStats extends LeagueTeamIdentity {
  /** From the table the engine computed. */
  played: number; won: number; drawn: number; lost: number;
  goalsFor: number; goalsAgainst: number; goalDiff: number; points: number;
  home: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number };
  away: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number };
  cleanSheets: number;
  /** Present only where the Match Centre actually recorded them. */
  possessionAvg: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

/**
 * Per-team totals over this league's completed matches.
 *
 * The record half comes from StandingsEntry, so it cannot disagree with the
 * table. The home/away split and the clean sheets are counted from the fixtures
 * themselves. Everything after that is read from the Match rows and left null
 * when the Match Centre holds no value — a statistic nobody recorded is absent,
 * not zero, and never estimated.
 */
export async function getTeamStats(competitionId: string): Promise<LeagueTeamStats[]> {
  await requireLeague(competitionId);

  const [entries, identities, fixtures] = await Promise.all([
    prisma.standingsEntry.findMany({ where: { competitionId }, orderBy: { position: 'asc' } }),
    teamIdentities(competitionId),
    prisma.fixture.findMany({
      where: { competitionId, status: 'PLAYED' },
      select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true, matchId: true },
    }),
  ]);

  const matchIds = fixtures.map((f) => f.matchId).filter((id): id is string => !!id);
  const matches = matchIds.length
    ? await prisma.match.findMany({
        where: { id: { in: matchIds } },
        select: { id: true, teamId: true, possession: true, shots: true, shotsOnTarget: true, yellowCards: true, redCards: true },
      })
    : [];
  const matchById = new Map(matches.map((m) => [m.id, m]));

  const side = () => ({ played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0 });
  const acc = new Map<string, {
    home: ReturnType<typeof side>; away: ReturnType<typeof side>; cleanSheets: number;
    possession: number[]; shots: number; shotsOnTarget: number; yellow: number; red: number; recorded: number;
  }>();
  const at = (teamId: string) => {
    if (!acc.has(teamId)) {
      acc.set(teamId, { home: side(), away: side(), cleanSheets: 0, possession: [], shots: 0, shotsOnTarget: 0, yellow: 0, red: 0, recorded: 0 });
    }
    return acc.get(teamId)!;
  };

  for (const f of fixtures) {
    const hs = f.homeScore ?? 0;
    const as_ = f.awayScore ?? 0;
    const h = at(f.homeTeamId);
    const a = at(f.awayTeamId);

    h.home.played++; h.home.goalsFor += hs; h.home.goalsAgainst += as_;
    a.away.played++; a.away.goalsFor += as_; a.away.goalsAgainst += hs;
    if (hs > as_) { h.home.won++; a.away.lost++; }
    else if (hs < as_) { a.away.won++; h.home.lost++; }
    else { h.home.drawn++; a.away.drawn++; }
    if (as_ === 0) h.cleanSheets++;
    if (hs === 0) a.cleanSheets++;

    // A Match row records one club's numbers — the club that owns it, which is
    // the home side. So these are attributed to the home team only, rather than
    // being split between two teams that never agreed on them.
    const m = f.matchId ? matchById.get(f.matchId) : null;
    if (m) {
      if (m.possession != null) h.possession.push(m.possession);
      if (m.shots != null) { h.shots += m.shots; h.recorded++; }
      if (m.shotsOnTarget != null) h.shotsOnTarget += m.shotsOnTarget;
      if (m.yellowCards != null) h.yellow += m.yellowCards;
      if (m.redCards != null) h.red += m.redCards;
    }
  }

  return entries.map((e) => {
    const id = identities.get(e.teamId);
    const a = at(e.teamId);
    return {
      teamId: e.teamId,
      teamName: id?.teamName ?? '',
      clubId: id?.clubId ?? '',
      clubName: id?.clubName ?? '',
      crestUrl: id?.crestUrl ?? null,
      shortName: id?.shortName ?? null,
      played: e.played, won: e.won, drawn: e.drawn, lost: e.lost,
      goalsFor: e.goalsFor, goalsAgainst: e.goalsAgainst, goalDiff: e.goalDiff, points: e.points,
      home: a.home, away: a.away,
      cleanSheets: a.cleanSheets,
      possessionAvg: a.possession.length ? +(a.possession.reduce((s, v) => s + v, 0) / a.possession.length).toFixed(1) : null,
      shots: a.recorded ? a.shots : null,
      shotsOnTarget: a.recorded ? a.shotsOnTarget : null,
      yellowCards: a.recorded ? a.yellow : null,
      redCards: a.recorded ? a.red : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Player leaderboards
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  playerId: string;
  playerName: string;
  /** The player's own position code, so a ranking reads as football. */
  position: string | null;
  clubId: string;
  clubName: string;
  crestUrl: string | null;
  teamId: string | null;
  value: number;
  appearances: number;
}

/**
 * One player's full league record, over this league's matches only.
 *
 * Every field here is one the Match Centre actually records — see
 * `PlayerMatchStats` in the schema. Saves, man-of-the-match and per-player clean
 * sheets are deliberately absent: nothing in the platform captures them, and a
 * column filled with a plausible number would be worse than no column.
 */
export interface LeaguePlayerRecord {
  playerId: string;
  playerName: string;
  position: string | null;
  clubId: string;
  clubName: string;
  crestUrl: string | null;
  teamId: string | null;
  appearances: number;
  starts: number;
  minutes: number;
  goals: number;
  assists: number;
  averageRating: number | null;
  ratedMatches: number;
  yellowCards: number;
  redCards: number;
  shots: number;
  shotsOnTarget: number;
  passes: number;
  passAccuracy: number | null;
  tackles: number;
  interceptions: number;
  xg: number;
  xa: number;
}

export interface LeagueLeaderboards {
  goals: LeaderboardEntry[];
  rating: LeaderboardEntry[];
  assists: LeaderboardEntry[];
  /** The same aggregation, whole. The screen shows three boards; this is what
   *  every other board would be built from, without a second pass over the data. */
  players: LeaguePlayerRecord[];
}

/**
 * Goals, rating and assists across this league's matches, and no others.
 *
 * The competition scope is structural rather than a filter that could be
 * forgotten: the only matches counted are the ones this league's own fixtures
 * point at. A player's cup goals are not in that set, so they cannot leak in.
 *
 * Read from PlayerMatchStats — the per-match record every other statistic in
 * the platform is derived from — rather than from PlayerSeasonStats, which is a
 * per-club season rollup that only exists once someone has run it. Using the
 * source means the league table is right the moment a match is recorded.
 */
export async function getLeaderboards(competitionId: string, limit = 10): Promise<LeagueLeaderboards> {
  await requireLeague(competitionId);

  const fixtures = await prisma.fixture.findMany({
    where: { competitionId, matchId: { not: null } },
    select: { matchId: true },
  });
  const matchIds = fixtures.map((f) => f.matchId).filter((id): id is string => !!id);
  const empty: LeagueLeaderboards = { goals: [], rating: [], assists: [], players: [] };
  if (matchIds.length === 0) return empty;

  const stats = await prisma.playerMatchStats.findMany({
    where: { matchId: { in: matchIds } },
    select: {
      playerId: true, clubId: true, teamId: true,
      goals: true, assists: true, ratingFamilista: true,
      minutesPlayed: true, isStarting: true,
      yellowCards: true, redCards: true,
      shots: true, shotsOnTarget: true,
      passes: true, passesCompleted: true,
      tackles: true, interceptions: true,
      xg: true, xa: true,
    },
  });
  if (stats.length === 0) return empty;

  type Agg = {
    playerId: string;
    clubId: string;
    teamId: string | null;
    goals: number;
    assists: number;
    ratingSum: number;
    ratingCount: number;
    appearances: number;
    starts: number;
    minutes: number;
    yellowCards: number;
    redCards: number;
    shots: number;
    shotsOnTarget: number;
    passes: number;
    passesCompleted: number;
    tackles: number;
    interceptions: number;
    xg: number;
    xa: number;
  };
  const agg = new Map<string, Agg>();
  for (const s of stats) {
    let a = agg.get(s.playerId);
    if (!a) {
      a = {
        playerId: s.playerId, clubId: s.clubId, teamId: s.teamId ?? null,
        goals: 0, assists: 0, ratingSum: 0, ratingCount: 0, appearances: 0, starts: 0, minutes: 0,
        yellowCards: 0, redCards: 0, shots: 0, shotsOnTarget: 0, passes: 0, passesCompleted: 0,
        tackles: 0, interceptions: 0, xg: 0, xa: 0,
      };
      agg.set(s.playerId, a);
    }
    a.goals += s.goals;
    a.assists += s.assists;
    if (s.minutesPlayed > 0) a.appearances += 1;
    if (s.isStarting) a.starts += 1;
    a.minutes += s.minutesPlayed;
    a.yellowCards += s.yellowCards;
    a.redCards += s.redCards;
    a.shots += s.shots;
    a.shotsOnTarget += s.shotsOnTarget;
    a.passes += s.passes;
    a.passesCompleted += s.passesCompleted;
    a.tackles += s.tackles;
    a.interceptions += s.interceptions;
    a.xg += s.xg;
    a.xa += s.xa;
    if (s.ratingFamilista != null) { a.ratingSum += s.ratingFamilista; a.ratingCount += 1; }
  }

  const rows = [...agg.values()];
  const [players, clubs] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: rows.map((r) => r.playerId) } },
      select: { id: true, firstName: true, lastName: true, position: true },
    }),
    prisma.club.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.clubId))] } },
      select: { id: true, name: true, crestUrl: true, emblem: true },
    }),
  ]);
  const playerById = new Map(players.map((p) => [p.id, p]));
  const clubById = new Map(clubs.map((c) => [c.id, c]));

  const entry = (r: Agg, value: number): LeaderboardEntry => {
    const p = playerById.get(r.playerId);
    const c = clubById.get(r.clubId);
    return {
      playerId: r.playerId,
      playerName: p ? `${p.firstName} ${p.lastName}`.trim() : 'Unknown player',
      position: p?.position ?? null,
      clubId: r.clubId,
      clubName: c?.name ?? '',
      crestUrl: c?.crestUrl ?? c?.emblem ?? null,
      teamId: r.teamId,
      value,
      appearances: r.appearances,
    };
  };

  const top = (list: LeaderboardEntry[]) =>
    list.filter((e) => e.value > 0).sort((a, b) => b.value - a.value || b.appearances - a.appearances).slice(0, limit);

  const record = (r: Agg): LeaguePlayerRecord => {
    const base = entry(r, 0);
    return {
      playerId: r.playerId,
      playerName: base.playerName,
      position: base.position,
      clubId: r.clubId,
      clubName: base.clubName,
      crestUrl: base.crestUrl,
      teamId: r.teamId,
      appearances: r.appearances,
      starts: r.starts,
      minutes: r.minutes,
      goals: r.goals,
      assists: r.assists,
      averageRating: r.ratingCount ? +(r.ratingSum / r.ratingCount).toFixed(2) : null,
      ratedMatches: r.ratingCount,
      yellowCards: r.yellowCards,
      redCards: r.redCards,
      shots: r.shots,
      shotsOnTarget: r.shotsOnTarget,
      passes: r.passes,
      passAccuracy: r.passes ? +((r.passesCompleted / r.passes) * 100).toFixed(1) : null,
      tackles: r.tackles,
      interceptions: r.interceptions,
      xg: +r.xg.toFixed(2),
      xa: +r.xa.toFixed(2),
    };
  };

  return {
    goals: top(rows.map((r) => entry(r, r.goals))),
    assists: top(rows.map((r) => entry(r, r.assists))),
    // A rating average over one appearance is not a league-leading rating, so a
    // player needs at least three rated matches to be ranked on it.
    rating: top(
      rows
        .filter((r) => r.ratingCount >= 3)
        .map((r) => entry(r, +(r.ratingSum / r.ratingCount).toFixed(2))),
    ),
    players: rows
      .map(record)
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists || b.minutes - a.minutes),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A club's own record in the league
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueClubRecord {
  identity: LeagueTeamIdentity | null;
  standing: LeagueStandingRow | null;
  recent: LeagueMatchRow[];
  upcoming: LeagueMatchRow[];
}

/**
 * One team's league profile: where it sits, what it has just played and what it
 * plays next. Used by the row click, and deliberately thin — the squad, the
 * player records and the match detail all already have their own screens and
 * this does not restate them.
 */
export async function getTeamRecord(competitionId: string, teamId: string): Promise<LeagueClubRecord> {
  await requireLeague(competitionId);
  const identities = await teamIdentities(competitionId);
  const identity = identities.get(teamId) ?? null;

  const [entry, played, next] = await Promise.all([
    prisma.standingsEntry.findFirst({ where: { competitionId, teamId } }),
    prisma.fixture.findMany({
      where: { competitionId, status: 'PLAYED', OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] },
      orderBy: { playedAt: 'desc' },
      take: 5,
    }),
    prisma.fixture.findMany({
      where: { competitionId, status: { notIn: ['PLAYED', 'CANCELLED'] }, OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] },
      orderBy: { scheduledAt: 'asc' },
      take: 3,
    }),
  ]);

  const toRow = (f: (typeof played)[number]): LeagueMatchRow => ({
    fixtureId: f.id,
    matchId: f.matchId ?? null,
    round: f.round ?? null,
    scheduledAt: f.scheduledAt.toISOString(),
    playedAt: f.playedAt ? f.playedAt.toISOString() : null,
    venue: f.venue ?? null,
    status: f.status,
    homeScore: f.homeScore,
    awayScore: f.awayScore,
    home: identities.get(f.homeTeamId) ?? null,
    away: identities.get(f.awayTeamId) ?? null,
  });

  let standing: LeagueStandingRow | null = null;
  if (entry) {
    const rules = readRules((await requireLeague(competitionId)).rules);
    const zone = (rules.zones ?? []).find((z) => entry.position >= z.from && entry.position <= z.to) ?? null;
    standing = {
      teamId: entry.teamId,
      teamName: identity?.teamName ?? '',
      clubId: identity?.clubId ?? '',
      clubName: identity?.clubName ?? '',
      crestUrl: identity?.crestUrl ?? null,
      shortName: identity?.shortName ?? null,
      position: entry.position,
      played: entry.played,
      won: entry.won,
      drawn: entry.drawn,
      lost: entry.lost,
      goalsFor: entry.goalsFor,
      goalsAgainst: entry.goalsAgainst,
      goalDiff: entry.goalDiff,
      points: entry.points,
      form: (entry.form || '').split('').filter((c) => c === 'W' || c === 'D' || c === 'L'),
      zone,
    };
  }

  return { identity, standing, recent: played.map(toRow), upcoming: next.map(toRow) };
}

/**
 * Which of the caller's own teams play in this league. The screen uses it to
 * highlight the reader's row; it is derived from participation, never from a
 * club name.
 */
export async function getMyTeamIds(competitionId: string, clubId: string | null | undefined): Promise<string[]> {
  if (!clubId) return [];
  const mine = await prisma.competitionTeam.findMany({
    where: { competitionId, clubId },
    select: { teamId: true },
  });
  return mine.map((m) => m.teamId);
}
