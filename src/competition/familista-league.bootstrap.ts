// Familista League — starting the current season
// ─────────────────────────────────────────────────────────────────────────────
// Everything the League screen shows comes from a Competition with no owning
// club, its CompetitionTeam rows, its Fixtures and the Matches those fixtures
// are played as. Until that competition exists there is no season, and the
// screen correctly says so.
//
// Nothing in this repository created it. `familista-league.admin.service.ts`
// manages a league that already exists, and `scripts/familista-league-season.ts`
// rebuilds one — both refuse outright when there is none. So a fresh database
// has the League deployed and no season in it, which is exactly what production
// showed. This file is the missing step, and the only one that creates it.
//
// ── Safety
//
// It is idempotent, and it is additive. Run it once, run it ten times, run it on
// a season halfway through: it creates only what is absent and reports what it
// found. It never deletes a fixture, never touches a played match, and never
// invents a club, a team, a player or a result. If the season already has
// completed matches it does not regenerate the calendar at all.
//
// It is deliberately NOT wired into server startup. A server that rebuilds a
// competition every time it boots is a server that will one day rebuild one
// somebody was using. This runs when a person runs it.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  academyTeamWhere,
  ageBandOf,
  eligibilityFor,
  eligibleTeamWhereFor,
  normalizeBand,
  resolveAgeBand,
  type BandSource,
} from './league-eligibility';
import {
  generateRoundRobinFixtures,
  rebuildStandingsUnchecked,
  type CompActor,
} from './competition.service';
import { ensureFixtureMatches, type LeagueActor } from './familista-league.admin.service';

export const LEAGUE_CODE = 'FAMILISTA-LEAGUE';
export const LEAGUE_NAME = 'Familista League';

/**
 * The season a date falls in. A football season runs July to June, so August
 * 2026 is 2026/27 and February 2027 is still 2026/27. Derived rather than
 * configured so that "the current season" needs no annual edit, and overridable
 * for a platform whose calendar differs.
 */
export function currentSeason(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const start = now.getUTCMonth() + 1 >= 7 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The competition a run creates, as data.
 *
 * The First Team's league and an age group's league are the same competition
 * shape with a different category, and this is the difference between them.
 * There is no second engine, no second bootstrap and no second set of rules —
 * only a code, a name and an age group.
 */
export interface LeagueCategory {
  code: string;
  name: string;
  /** Null for the First Team's league; `U15` for an age group's. */
  ageGroup: string | null;
  description: string;
  /** What the participants are called in this run's notes and errors. */
  participantLabel: string;
}

export const FIRST_TEAM_CATEGORY: LeagueCategory = {
  code: LEAGUE_CODE,
  name: LEAGUE_NAME,
  ageGroup: null,
  description: 'The competition between the clubs on the Familista platform.',
  participantLabel: 'first team',
};

/**
 * `U11-U13` → the U11-U13 Familista League.
 *
 * The band is the team's own, not an age inferred from its kind, so a club that
 * runs U8-U10 and U11-U13 gets two competitions rather than one bucket holding
 * both. Derived from whatever bands actually exist, so a band nobody has yet —
 * or one added next season — needs no edit here.
 */
export function academyCategory(ageGroup: string): LeagueCategory {
  const band = normalizeBand(ageGroup);
  return {
    code: `${LEAGUE_CODE}-${band}`,
    name: `${LEAGUE_NAME} ${band}`,
    ageGroup: band,
    description: `The ${band} competition between the academies on the Familista platform.`,
    participantLabel: `${band} team`,
  };
}

export interface EligibleTeamRow {
  id: string;
  name: string;
  clubId: string;
  club: { name: string; crestUrl: string | null; emblem: string | null } | null;
}

/**
 * The teams that may play in one competition.
 *
 * With no band this is the first team's query, exactly as before. With a band
 * the academy sides are fetched and then filtered by `eligibilityFor`, because
 * a band is read off each row — a name a club typed, or a range it recorded —
 * and is therefore not a column SQL can compare. Pairing the two here is what
 * stops a caller using half the rule.
 */
export async function resolveEligibleTeams(
  category: LeagueCategory,
  teamIds?: string[],
): Promise<EligibleTeamRow[]> {
  const rows = await prisma.team.findMany({
    where: {
      ...eligibleTeamWhereFor(category.ageGroup),
      ...(teamIds?.length ? { id: { in: teamIds } } : {}),
    },
    select: {
      id: true, name: true, clubId: true, kind: true, isActive: true, ageMin: true, ageMax: true,
      club: { select: { name: true, crestUrl: true, emblem: true } },
    },
    orderBy: [{ club: { name: 'asc' } }, { name: 'asc' }],
  });
  return rows
    .filter((t) => eligibilityFor(category, {
      kind: t.kind, isActive: t.isActive, name: t.name, ageMin: t.ageMin, ageMax: t.ageMax,
    }).eligible)
    .map((t) => ({ id: t.id, name: t.name, clubId: t.clubId, club: t.club }));
}

export interface DiscoveredBandTeam {
  teamId: string;
  teamName: string;
  clubId: string;
  clubName: string;
  kind: string;
  /** How this team's band was decided — so a mis-grouping is visible, not guessed at. */
  bandSource: BandSource | null;
}

export interface DiscoveredBand {
  band: string;
  teams: DiscoveredBandTeam[];
  clubCount: number;
}

/**
 * The academy age bands that actually exist on the platform, with their teams.
 *
 * Discovered from the real Team rows — never from a fixed list of ages — so a
 * club that adds a band, renames one or removes one changes what this returns
 * without a line of code moving.
 */
export async function discoverAcademyBands(): Promise<DiscoveredBand[]> {
  const rows = await prisma.team.findMany({
    where: academyTeamWhere(),
    select: {
      id: true, name: true, clubId: true, kind: true, ageMin: true, ageMax: true,
      club: { select: { name: true } },
    },
    orderBy: [{ club: { name: 'asc' } }, { name: 'asc' }],
  });

  const byBand = new Map<string, DiscoveredBandTeam[]>();
  for (const t of rows) {
    const resolved = resolveAgeBand({ kind: t.kind, name: t.name, ageMin: t.ageMin, ageMax: t.ageMax });
    if (!resolved.band) continue;      // no band to place it in: never guessed at
    const band = normalizeBand(resolved.band);
    const list = byBand.get(band) ?? [];
    list.push({
      teamId: t.id,
      teamName: t.name,
      clubId: t.clubId,
      clubName: t.club?.name ?? t.name,
      kind: String(t.kind),
      bandSource: resolved.source,
    });
    byBand.set(band, list);
  }

  return [...byBand.entries()]
    .map(([band, teams]) => ({ band, teams, clubCount: new Set(teams.map((t) => t.clubId)).size }))
    .sort((a, b) => a.band.localeCompare(b.band));
}

export interface InitOptions {
  /** Defaults to the season the current date falls in. */
  season?: string;
  /** Enter exactly these teams. Omitted: every eligible first team on the platform. */
  teamIds?: string[];
  /** First matchday. Defaults to a week from today. */
  startDate?: string;
  /** Days between rounds. */
  intervalDays?: number;
  /**
   * Refuse to enter more than this many discovered teams. A platform with four
   * clubs has four eligible first teams; a number far above that means the
   * command is pointed at a database full of something else, and entering all of
   * it would be worse than stopping.
   */
  maxDiscovered?: number;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
}

export interface InitResult {
  season: string;
  competitionId: string | null;
  competitionCreated: boolean;
  participants: Array<{ teamId: string; teamName: string; clubId: string; clubName: string; hasCrest: boolean; entered: boolean }>;
  participantsEntered: number;
  participantsReused: number;
  fixturesCreated: number;
  fixturesReused: number;
  rounds: number;
  matchesLinked: number;
  standingsRows: number;
  playedFixtures: number;
  /** What it decided and why, in the order it decided it. */
  notes: string[];
}

/** The rules a new league starts with: what the standings engine already does,
 *  stated as data. No zones and no prizes — those are decisions for whoever runs
 *  the competition, not something to invent on their behalf. */
const INITIAL_RULES = {
  points: { win: 3, draw: 1, loss: 0 },
  tiebreakers: ['Points', 'Goal difference', 'Goals scored', 'Wins'],
  zones: [] as unknown[],
  prizes: { enabled: false },
};

/**
 * Start one league season, for one category.
 *
 * Everything below is category-agnostic: who is eligible comes from
 * league-eligibility asked about THIS competition, the calendar comes from the
 * competition engine's round-robin, and every fixture becomes the same Match
 * the Match Centre opens. The First Team's league and an academy age group's
 * league differ by their category argument and by nothing else.
 */
export async function initSeasonFor(category: LeagueCategory, opts: InitOptions = {}): Promise<InitResult> {
  const season = opts.season ?? currentSeason();
  const notes: string[] = [];
  const result: InitResult = {
    season,
    competitionId: null,
    competitionCreated: false,
    participants: [],
    participantsEntered: 0,
    participantsReused: 0,
    fixturesCreated: 0,
    fixturesReused: 0,
    rounds: 0,
    matchesLinked: 0,
    standingsRows: 0,
    playedFixtures: 0,
    notes,
  };

  // ── who plays ──────────────────────────────────────────────────────────────
  // The eligibility rule is not restated here. It comes from league-eligibility
  // through one resolver, so a first team is discovered because it is one and a
  // band's team because its band matches exactly — never because of an age
  // inferred from its kind.
  const eligible = await resolveEligibleTeams(category, opts.teamIds);

  if (opts.teamIds?.length && eligible.length !== opts.teamIds.length) {
    throw new Error(
      `${opts.teamIds.length} team(s) named but ${eligible.length} are eligible ${category.participantLabel}s. An ineligible team cannot be entered.`,
    );
  }
  if (eligible.length < 2) {
    // No invented opponent, ever. A category with one real team has no
    // competition, and the screen says exactly that.
    throw new Error(`A league needs at least two eligible ${category.participantLabel}s. Register the clubs first.`);
  }
  const cap = opts.maxDiscovered ?? 32;
  if (!opts.teamIds?.length && eligible.length > cap) {
    throw new Error(
      `${eligible.length} eligible ${category.participantLabel}s found, which is more than the safety limit of ${cap}. `
      + 'Name the participants explicitly, or raise the limit deliberately.',
    );
  }
  notes.push(`${eligible.length} eligible ${category.participantLabel}(s)${opts.teamIds?.length ? ' (named explicitly)' : ' (discovered)'}`);

  // ── the competition ────────────────────────────────────────────────────────
  let comp = await prisma.competition.findFirst({
    where: { clubId: null, code: category.code, season },
  });

  if (!comp) {
    if (opts.dryRun) {
      notes.push(`would create the ${category.name} competition for ${season}`);
    } else {
      comp = await prisma.competition.create({
        data: {
          // Null: the league belongs to the platform, not to any one club. That
          // is what makes it readable by every participant and editable by none
          // of them — see the ownership checks in competition.service.ts.
          clubId: null,
          code: category.code,
          season,
          name: category.name,
          format: 'LEAGUE',
          // The category, stored rather than inferred. Every eligibility
          // question about this competition is answered from this column.
          ageGroup: category.ageGroup,
          description: category.description,
          rules: INITIAL_RULES as Prisma.InputJsonValue,
        },
      });
      result.competitionCreated = true;
      notes.push(`created the competition (${comp.id})`);
    }
  } else {
    notes.push(`competition already exists (${comp.id}) — reused`);
  }

  result.participants = eligible.map((t) => ({
    teamId: t.id,
    teamName: t.name,
    clubId: t.clubId,
    clubName: t.club?.name ?? t.name,
    hasCrest: !!(t.club?.crestUrl ?? t.club?.emblem),
    entered: false,
  }));

  if (!comp) {
    // Dry run with no competition: nothing further can be inspected.
    notes.push('dry run — nothing was written');
    return result;
  }
  result.competitionId = comp.id;

  // ── participation ──────────────────────────────────────────────────────────
  const already = await prisma.competitionTeam.findMany({
    where: { competitionId: comp.id },
    select: { teamId: true },
  });
  const entered = new Set(already.map((e) => e.teamId));
  result.participantsReused = eligible.filter((t) => entered.has(t.id)).length;

  for (const team of eligible) {
    if (entered.has(team.id)) continue;
    if (opts.dryRun) { result.participantsEntered++; continue; }
    // A reference and a club attribution, and nothing else: no name, no crest,
    // no squad. Everything the League shows about this team is read from the
    // team and its club each time the screen draws.
    await prisma.competitionTeam.create({
      data: { competitionId: comp.id, teamId: team.id, clubId: team.clubId },
    });
    const row = result.participants.find((p) => p.teamId === team.id);
    if (row) row.entered = true;
    result.participantsEntered++;
  }
  notes.push(`participants: ${result.participantsEntered} entered, ${result.participantsReused} already there`);

  // Teams entered previously that are not in this run's list are left exactly
  // where they are. Removing a participant is a decision with consequences for
  // results already recorded, and it belongs to Manage Teams, not to a setup
  // command.
  const strangers = already.filter((e) => !eligible.some((t) => t.id === e.teamId));
  if (strangers.length) notes.push(`${strangers.length} other participant(s) already entered — left alone`);

  // ── the calendar ───────────────────────────────────────────────────────────
  const existingFixtures = await prisma.fixture.count({ where: { competitionId: comp.id } });
  result.playedFixtures = await prisma.fixture.count({ where: { competitionId: comp.id, status: 'PLAYED' } });

  if (result.playedFixtures > 0) {
    result.fixturesReused = existingFixtures;
    notes.push(`${result.playedFixtures} fixture(s) already played — the calendar is left untouched`);
  } else if (existingFixtures > 0) {
    result.fixturesReused = existingFixtures;
    notes.push(`${existingFixtures} fixture(s) already scheduled — not regenerated`);
  } else if (opts.dryRun) {
    notes.push('would generate the home-and-away calendar from the entered participants');
  } else {
    // The pairing arithmetic is the competition engine's, unchanged: every pair
    // meets twice, and the number of rounds and matches follows from how many
    // teams are entered rather than from anything written down here.
    const actor: CompActor = { userId: 'league-init', clubId: '', role: 'SUPER_ADMIN' };
    const start = opts.startDate ?? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const gen = await generateRoundRobinFixtures(actor, comp.id, start, opts.intervalDays ?? 7, false);
    result.fixturesCreated = gen.created;
    notes.push(`generated ${gen.created} fixture(s) from ${start}`);
  }

  // ── every fixture becomes a real Match ─────────────────────────────────────
  if (!opts.dryRun) {
    result.matchesLinked = await ensureFixtureMatches(comp.id);
    if (result.matchesLinked) notes.push(`${result.matchesLinked} fixture(s) given a Match in the Match Centre`);
    else notes.push('every fixture already has its Match');
  }

  // ── the table ──────────────────────────────────────────────────────────────
  // Rebuilt so that every entered team appears on zero before a ball is kicked.
  // A season with no results still has a table, and no team is missing from it
  // merely because it has not played.
  if (!opts.dryRun) {
    result.standingsRows = await rebuildStandingsUnchecked(comp.id);
  }

  const fixtures = await prisma.fixture.findMany({ where: { competitionId: comp.id }, select: { round: true } });
  result.rounds = new Set(fixtures.map((f) => f.round).filter((r) => r != null)).size;
  if (!result.fixturesCreated) result.fixturesReused = fixtures.length;

  return result;
}

/**
 * The Familista League — the First Team's competition.
 *
 * Unchanged in behaviour and in signature: the same discovery, the same
 * calendar, the same safety. It is now one call to the shared runner rather
 * than its own copy of it, which is what stops the academy's league and the
 * First Team's ever drifting apart.
 */
export async function initCurrentSeason(opts: InitOptions = {}): Promise<InitResult> {
  return initSeasonFor(FIRST_TEAM_CATEGORY, opts);
}

export interface AcademyGroupOutcome {
  ageGroup: string;
  /** Real teams of this age group on the platform. Never invented. */
  teamCount: number;
  /** Null when the group was skipped — there was no competition to create. */
  result: InitResult | null;
  skipped: boolean;
  /** Why it was skipped, as a sentence for the operator running this. */
  note: string;
}

export interface AcademyInitResult {
  season: string;
  groups: AcademyGroupOutcome[];
  competitionsCreated: number;
  fixturesCreated: number;
}

/**
 * Start the season for every academy age BAND that has a real competition to
 * play.
 *
 * "Real" is doing the work in that sentence. A band is given a league when at
 * least two teams of that exact band exist on the platform, and those teams are
 * the ones already in the database — no club is created, no opponent is
 * invented, and a band with one team is skipped and SAID to be skipped.
 *
 * The bands are discovered from the team rows themselves, so U8-U10 and
 * U11-U13 are two bands even though the schema files both under ACADEMY_U13.
 * Bands are never mixed and never merged: each competition carries its own
 * band, and `league-eligibility` refuses anything else at the door.
 */
export async function initAcademySeasons(
  opts: InitOptions & { ageGroups?: string[]; minTeams?: number } = {},
): Promise<AcademyInitResult> {
  const season = opts.season ?? currentSeason();
  const minTeams = Math.max(2, opts.minTeams ?? 2);
  const discovered = await discoverAcademyBands();
  const asked = opts.ageGroups?.length ? opts.ageGroups.map(normalizeBand) : null;
  const bands = asked ? discovered.filter((d) => asked.includes(d.band)) : discovered;

  const groups: AcademyGroupOutcome[] = [];
  for (const found of bands) {
    const category = academyCategory(found.band);
    if (found.teams.length < minTeams) {
      groups.push({
        ageGroup: found.band,
        teamCount: found.teams.length,
        result: null,
        skipped: true,
        note: `${found.teams.length} active ${found.band} team(s) on the platform — a competition needs ${minTeams}. Nothing was created.`,
      });
      continue;
    }
    const { ageGroups: _groups, minTeams: _min, ...base } = opts;
    // Every band runs for the SAME season, resolved once above, so a run that
    // straddles midnight on the 1st of July cannot file two of them differently.
    const result = await initSeasonFor(category, { ...base, season });
    groups.push({ ageGroup: found.band, teamCount: found.teams.length, result, skipped: false, note: result.notes.join('; ') });
  }

  // A band the caller named that no team belongs to is reported rather than
  // silently ignored: a typo must not look like an empty platform.
  if (asked) {
    for (const band of asked) {
      if (discovered.some((d) => d.band === band)) continue;
      groups.push({
        ageGroup: band,
        teamCount: 0,
        result: null,
        skipped: true,
        note: `no active team on the platform resolves to the band ${band}. Nothing was created.`,
      });
    }
  }

  return {
    season,
    groups,
    competitionsCreated: groups.filter((g) => g.result?.competitionCreated).length,
    fixturesCreated: groups.reduce((n, g) => n + (g.result?.fixturesCreated ?? 0), 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan, before anything is written
// ─────────────────────────────────────────────────────────────────────────────
//
// A dry run that reports "0 fixtures" for a band it has not created yet tells
// an operator nothing: it cannot be read as either safe or broken. This is the
// read-only pass that answers the question actually being asked — what exists
// now, what would be added, and whether any of it would touch something it
// must not.
//
// It performs NO writes. Every number below comes from a count or from the
// same arithmetic the generator uses, and the function is never called on the
// write path.

export interface AcademyBandPlan {
  band: string;
  /** The real teams of this exact band, with the club each belongs to. */
  teams: DiscoveredBandTeam[];
  clubCount: number;
  /** Null when no competition for this band and season exists yet. */
  competitionId: string | null;
  competitionCode: string;
  competitionExists: boolean;
  existingParticipants: number;
  participantsToAdd: number;
  existingFixtures: number;
  fixturesToCreate: number;
  existingRounds: number;
  roundsToCreate: number;
  existingStandingsRows: number;
  standingsRowsToCreate: number;
  playedFixtures: number;
  skipped: boolean;
  note: string;
  /** Participants already entered whose band is NOT this competition's. */
  crossBandParticipants: number;
  /** Participants that are first teams. Must always be zero. */
  seniorParticipants: number;
}

export interface AcademyPlan {
  season: string;
  minTeams: number;
  bands: AcademyBandPlan[];
  /** Academy competitions that exist but that no discovered band claims. */
  orphanCompetitions: Array<{ id: string; code: string; season: string; ageGroup: string | null; participants: number; fixtures: number }>;
  firstTeam: { competitionId: string | null; code: string; participants: number; fixtures: number; standingsRows: number; wouldChange: number };
  crossBandParticipants: number;
  duplicateParticipants: number;
  duplicateFixtures: number;
  safe: boolean;
  blockers: string[];
}

/** The calendar the generator would produce for n participants: every pair
 *  twice. Stated here as arithmetic rather than run, because a plan writes
 *  nothing — and it is the same arithmetic, so the two cannot disagree. */
export function plannedCalendar(participants: number): { fixtures: number; rounds: number } {
  if (participants < 2) return { fixtures: 0, rounds: 0 };
  const padded = participants % 2 === 0 ? participants : participants + 1;
  return { fixtures: participants * (participants - 1), rounds: 2 * (padded - 1) };
}

export async function planAcademySeasons(
  opts: { season?: string; ageGroups?: string[]; minTeams?: number } = {},
): Promise<AcademyPlan> {
  const season = opts.season ?? currentSeason();
  const minTeams = Math.max(2, opts.minTeams ?? 2);
  const discovered = await discoverAcademyBands();
  const asked = opts.ageGroups?.length ? opts.ageGroups.map(normalizeBand) : null;
  const wanted = asked ? discovered.filter((d) => asked.includes(d.band)) : discovered;

  const bands: AcademyBandPlan[] = [];
  let crossBandTotal = 0;
  let duplicateParticipants = 0;
  let duplicateFixtures = 0;
  const blockers: string[] = [];

  for (const found of wanted) {
    const category = academyCategory(found.band);
    const comp = await prisma.competition.findFirst({
      where: { clubId: null, code: category.code, season },
      select: { id: true },
    });

    let existingParticipants = 0;
    let existingFixtures = 0;
    let existingRounds = 0;
    let existingStandings = 0;
    let playedFixtures = 0;
    let crossBand = 0;
    let senior = 0;

    if (comp) {
      const entries = await prisma.competitionTeam.findMany({
        where: { competitionId: comp.id },
        select: { teamId: true },
      });
      existingParticipants = entries.length;
      // A participant already entered that does not belong to this band is the
      // mis-grouping this fix exists to end. Counted, and it blocks the run.
      if (entries.length) {
        const rows = await prisma.team.findMany({
          where: { id: { in: entries.map((e) => e.teamId) } },
          select: { id: true, name: true, kind: true, isActive: true, ageMin: true, ageMax: true },
        });
        for (const t of rows) {
          const verdict = eligibilityFor(category, {
            kind: t.kind, isActive: t.isActive, name: t.name, ageMin: t.ageMin, ageMax: t.ageMax,
          });
          if (!verdict.eligible) crossBand++;
          if (String(t.kind) === 'SENIOR') senior++;
        }
      }
      const fixtures = await prisma.fixture.findMany({
        where: { competitionId: comp.id },
        select: { round: true, status: true, homeTeamId: true, awayTeamId: true },
      });
      existingFixtures = fixtures.length;
      existingRounds = new Set(fixtures.map((f) => f.round).filter((r) => r != null)).size;
      playedFixtures = fixtures.filter((f) => f.status === 'PLAYED').length;
      existingStandings = await prisma.standingsEntry.count({ where: { competitionId: comp.id } });
      // Two fixtures for the same pair in the same round would be a duplicate
      // calendar. Counted so the verdict can refuse rather than add to one.
      const seen = new Set<string>();
      for (const f of fixtures) {
        const key = `${f.round}|${f.homeTeamId}|${f.awayTeamId}`;
        if (seen.has(key)) duplicateFixtures++;
        seen.add(key);
      }
    }

    crossBandTotal += crossBand;

    const entered = new Set<string>();
    if (comp) {
      const rows = await prisma.competitionTeam.findMany({
        where: { competitionId: comp.id },
        select: { teamId: true },
      });
      for (const r of rows) {
        if (entered.has(r.teamId)) duplicateParticipants++;
        entered.add(r.teamId);
      }
    }
    const toAdd = found.teams.filter((t) => !entered.has(t.teamId)).length;
    const participantsAfter = existingParticipants + toAdd;

    const skipped = found.teams.length < minTeams;
    const calendar = plannedCalendar(participantsAfter);
    // The calendar is only generated when there is none and none has been
    // played — the same condition the runner applies.
    const willGenerate = !skipped && existingFixtures === 0 && playedFixtures === 0;

    bands.push({
      band: found.band,
      teams: found.teams,
      clubCount: found.clubCount,
      competitionId: comp?.id ?? null,
      competitionCode: category.code,
      competitionExists: !!comp,
      existingParticipants,
      participantsToAdd: skipped ? 0 : toAdd,
      existingFixtures,
      fixturesToCreate: willGenerate ? calendar.fixtures : 0,
      existingRounds,
      roundsToCreate: willGenerate ? calendar.rounds : 0,
      existingStandingsRows: existingStandings,
      standingsRowsToCreate: skipped ? 0 : Math.max(0, participantsAfter - existingStandings),
      playedFixtures,
      skipped,
      note: skipped
        ? `${found.teams.length} active ${found.band} team(s) across ${found.clubCount} club(s) — a competition needs ${minTeams}. Nothing would be created.`
        : existingFixtures > 0
          ? `${existingFixtures} fixture(s) already scheduled — the calendar would not be regenerated.`
          : 'a full home-and-away calendar would be generated.',
      crossBandParticipants: crossBand,
      seniorParticipants: senior,
    });

    if (crossBand) {
      blockers.push(`${found.band}: ${crossBand} participant(s) already entered do not belong to this band`);
    }
    if (senior) {
      blockers.push(`${found.band}: ${senior} first-team participant(s) already entered`);
    }
  }

  if (asked) {
    for (const band of asked) {
      if (discovered.some((d) => d.band === band)) continue;
      bands.push({
        band, teams: [], clubCount: 0,
        competitionId: null, competitionCode: academyCategory(band).code, competitionExists: false,
        existingParticipants: 0, participantsToAdd: 0,
        existingFixtures: 0, fixturesToCreate: 0,
        existingRounds: 0, roundsToCreate: 0,
        existingStandingsRows: 0, standingsRowsToCreate: 0,
        playedFixtures: 0, skipped: true,
        note: `no active team on the platform resolves to the band ${band}. Nothing would be created.`,
        crossBandParticipants: 0, seniorParticipants: 0,
      });
    }
  }

  // ── academy competitions no band claims ────────────────────────────────────
  // A competition left by an earlier grouping. It is reported, and it is left
  // exactly where it is: nothing here deletes or renames one.
  const claimed = new Set(bands.map((b) => b.competitionCode));
  const academyComps = await prisma.competition.findMany({
    where: { clubId: null, code: { startsWith: `${LEAGUE_CODE}-` } },
    select: { id: true, code: true, season: true, ageGroup: true },
    orderBy: [{ code: 'asc' }, { season: 'asc' }],
  });
  const orphanCompetitions = [];
  for (const c of academyComps) {
    if (claimed.has(c.code) && c.season === season) continue;
    orphanCompetitions.push({
      id: c.id,
      code: c.code,
      season: c.season,
      ageGroup: c.ageGroup,
      participants: await prisma.competitionTeam.count({ where: { competitionId: c.id } }),
      fixtures: await prisma.fixture.count({ where: { competitionId: c.id } }),
    });
  }

  // ── the First Team's own league, read and left alone ───────────────────────
  // Read only so the plan can state the number it will not change. Nothing in
  // this run selects this competition: the academy runner only ever looks up
  // `FAMILISTA-LEAGUE-<band>`.
  const firstComp = await prisma.competition.findFirst({
    where: { clubId: null, code: LEAGUE_CODE },
    orderBy: [{ season: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  const firstTeam = {
    competitionId: firstComp?.id ?? null,
    code: LEAGUE_CODE,
    participants: firstComp ? await prisma.competitionTeam.count({ where: { competitionId: firstComp.id } }) : 0,
    fixtures: firstComp ? await prisma.fixture.count({ where: { competitionId: firstComp.id } }) : 0,
    standingsRows: firstComp ? await prisma.standingsEntry.count({ where: { competitionId: firstComp.id } }) : 0,
    // The plan touches this competition in no way at all, which is a fact about
    // the code rather than a measurement: no band's code can equal LEAGUE_CODE,
    // because every one of them carries a "-<band>" suffix.
    wouldChange: bands.filter((b) => b.competitionCode === LEAGUE_CODE).length,
  };

  if (firstTeam.wouldChange) blockers.push('a band resolved to the First Team competition code');
  if (duplicateParticipants) blockers.push(`${duplicateParticipants} duplicate participant row(s) already exist`);
  if (duplicateFixtures) blockers.push(`${duplicateFixtures} duplicate fixture(s) already exist`);

  return {
    season,
    minTeams,
    bands,
    orphanCompetitions,
    firstTeam,
    crossBandParticipants: crossBandTotal,
    duplicateParticipants,
    duplicateFixtures,
    safe: blockers.length === 0,
    blockers,
  };
}

/** The actor a command-line run acts as. There is no session to take it from,
 *  and an operator running this against the database is the platform
 *  administrator by definition. */
export const CLI_ACTOR: LeagueActor = { userId: 'league-init', clubId: '', role: 'SUPER_ADMIN' };
