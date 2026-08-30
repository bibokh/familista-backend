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
// Player leaderboards
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  playerId: string;
  playerName: string;
  clubId: string;
  clubName: string;
  crestUrl: string | null;
  teamId: string | null;
  value: number;
  appearances: number;
}

export interface LeagueLeaderboards {
  goals: LeaderboardEntry[];
  rating: LeaderboardEntry[];
  assists: LeaderboardEntry[];
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
  const empty: LeagueLeaderboards = { goals: [], rating: [], assists: [] };
  if (matchIds.length === 0) return empty;

  const stats = await prisma.playerMatchStats.findMany({
    where: { matchId: { in: matchIds } },
    select: {
      playerId: true,
      clubId: true,
      teamId: true,
      goals: true,
      assists: true,
      ratingFamilista: true,
      minutesPlayed: true,
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
  };
  const agg = new Map<string, Agg>();
  for (const s of stats) {
    let a = agg.get(s.playerId);
    if (!a) {
      a = { playerId: s.playerId, clubId: s.clubId, teamId: s.teamId ?? null, goals: 0, assists: 0, ratingSum: 0, ratingCount: 0, appearances: 0 };
      agg.set(s.playerId, a);
    }
    a.goals += s.goals;
    a.assists += s.assists;
    if (s.minutesPlayed > 0) a.appearances += 1;
    if (s.ratingFamilista != null) { a.ratingSum += s.ratingFamilista; a.ratingCount += 1; }
  }

  const rows = [...agg.values()];
  const [players, clubs] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: rows.map((r) => r.playerId) } },
      select: { id: true, firstName: true, lastName: true },
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
