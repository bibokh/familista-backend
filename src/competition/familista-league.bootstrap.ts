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
import { eligibleTeamWhere } from './league-eligibility';
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

export async function initCurrentSeason(opts: InitOptions = {}): Promise<InitResult> {
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
  // The eligibility rule is not restated here. It comes from league-eligibility,
  // so a first team is discovered because it is one — never because of its name.
  const where: Prisma.TeamWhereInput = {
    ...eligibleTeamWhere(),
    ...(opts.teamIds?.length ? { id: { in: opts.teamIds } } : {}),
  };
  const eligible = await prisma.team.findMany({
    where,
    select: {
      id: true, name: true, clubId: true,
      club: { select: { name: true, crestUrl: true, emblem: true } },
    },
    orderBy: [{ club: { name: 'asc' } }, { name: 'asc' }],
  });

  if (opts.teamIds?.length && eligible.length !== opts.teamIds.length) {
    throw new Error(
      `${opts.teamIds.length} team(s) named but ${eligible.length} are eligible first teams. An ineligible team cannot be entered.`,
    );
  }
  if (eligible.length < 2) {
    throw new Error('A league needs at least two eligible first teams. Register the clubs first.');
  }
  const cap = opts.maxDiscovered ?? 32;
  if (!opts.teamIds?.length && eligible.length > cap) {
    throw new Error(
      `${eligible.length} eligible first teams found, which is more than the safety limit of ${cap}. `
      + 'Name the participants explicitly, or raise the limit deliberately.',
    );
  }
  notes.push(`${eligible.length} eligible first team(s)${opts.teamIds?.length ? ' (named explicitly)' : ' (discovered)'}`);

  // ── the competition ────────────────────────────────────────────────────────
  let comp = await prisma.competition.findFirst({
    where: { clubId: null, code: LEAGUE_CODE, season },
  });

  if (!comp) {
    if (opts.dryRun) {
      notes.push(`would create the ${LEAGUE_NAME} competition for ${season}`);
    } else {
      comp = await prisma.competition.create({
        data: {
          // Null: the league belongs to the platform, not to any one club. That
          // is what makes it readable by every participant and editable by none
          // of them — see the ownership checks in competition.service.ts.
          clubId: null,
          code: LEAGUE_CODE,
          season,
          name: LEAGUE_NAME,
          format: 'LEAGUE',
          description: 'The competition between the clubs on the Familista platform.',
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

/** The actor a command-line run acts as. There is no session to take it from,
 *  and an operator running this against the database is the platform
 *  administrator by definition. */
export const CLI_ACTOR: LeagueActor = { userId: 'league-init', clubId: '', role: 'SUPER_ADMIN' };
