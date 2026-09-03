// Match Center — the club's whole calendar, and the workflow around one fixture
// ─────────────────────────────────────────────────────────────────────────────
// The Familista League is one competition. A club plays in more than one: a cup,
// a second tournament, a friendly, a pre-season game. The Match Center is the
// club's view of ALL of them, and it owns no fixtures of its own — every row it
// returns is a Fixture row that already existed, read through a different lens.
// One fixture is one record; the League and the Match Center are two readers of
// it, never two copies.
//
// Scope is a TEAM, not a club. A club is a First Team and a set of academy age
// groups, each of which is a team with its own squad and its own fixtures, and
// the calendar below is one team's. Naming no team means the First Team, which
// is what this module meant before the academy had one of its own — so nothing
// about the First Team changed when the academy arrived.
//
// Which team a caller may read, and which they may change, is decided in
// identity/team-access.service.ts and asked here. Nothing below names an age
// group, and nothing below excludes one by name either.

import { Prisma, TeamKind } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { FIRST_TEAM_KINDS } from './league-eligibility';
import {
  TeamAccess,
  TeamActor,
  accessForTeam,
  assertCanViewTeam,
  listTeamContexts,
} from '../identity/team-access.service';
import * as league from './familista-league.service';
import {
  DEFAULT_SCHEDULING_POLICY,
  SchedulingPolicy,
  readSchedulingPolicy,
  resolveVenueTimeZone,
  validateKickoff,
  localClockAt,
} from './match-scheduling';
import * as weather from './match-weather.service';

// ─────────────────────────────────────────────────────────────────────────────
// Who "we" are
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Match Center's actor is the team-access actor. One shape, so the module
 * cannot end up asking a different question than the one team-access answers.
 */
export type MatchCenterActor = TeamActor;

/**
 * The club's first teams. Plural because a club may keep more than one senior
 * side; the rule decides which kinds count, and nothing here second-guesses it.
 */
export async function firstTeamIdsForClub(clubId: string): Promise<string[]> {
  if (!clubId) return [];
  const teams = await prisma.team.findMany({
    where: { clubId, kind: { in: FIRST_TEAM_KINDS as TeamKind[] } },
    select: { id: true },
  });
  return teams.map((t) => t.id);
}

/**
 * The team context a request is about, and what this person may do with it.
 *
 * Named `teamId` and nothing else: the calendar is one team's calendar, and an
 * academy age group asking for its own fixtures asks the same way the First
 * Team does. Omitting it means the First Team, which is what the module meant
 * before academy teams had one — the default is preserved exactly.
 *
 * Every branch goes through team-access, so a team id typed into a URL is
 * refused here rather than filtered out somewhere downstream.
 */
export interface TeamScope {
  /** The teams whose fixtures this request may read. */
  teamIds: string[];
  /** The single team asked for, or null for the First Team default. */
  teamId: string | null;
  /** What the caller may do with that team. Null for the multi-team default. */
  access: TeamAccess | null;
}

export async function resolveTeamScope(actor: MatchCenterActor, teamId?: string | null): Promise<TeamScope> {
  if (teamId) {
    const access = await assertCanViewTeam(actor, teamId);
    return { teamIds: [teamId], teamId, access };
  }
  // No team named: the club's first teams, and only those the caller may read.
  const contexts = await listTeamContexts(actor);
  const teamIds = contexts
    .filter((c) => FIRST_TEAM_KINDS.includes(c.kind) && c.access.canView)
    .map((c) => c.teamId);
  return { teamIds, teamId: null, access: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The calendar
// ─────────────────────────────────────────────────────────────────────────────

export type MatchCenterCompetitionKind = 'LEAGUE' | 'CUP' | 'FRIENDLY' | 'PRESEASON' | 'PREPARATION' | 'OTHER';

export interface MatchCenterCompetition {
  id: string;
  name: string;
  code: string;
  season: string;
  format: string;
  /** Platform-owned (the Familista League) or a club's own competition. */
  ownedByClubId: string | null;
  /** What KIND of football this is, for the calendar's own grouping. */
  kind: MatchCenterCompetitionKind;
}

export interface MatchCenterFixtureRow {
  fixtureId: string;
  matchId: string | null;
  competition: MatchCenterCompetition;
  round: number | null;
  leg: number | null;
  /** ISO instant. The one canonical kickoff, shared by both clubs. */
  scheduledAt: string;
  playedAt: string | null;
  /** The kickoff as the venue's own clock reads it, and the zone that says so. */
  venueTimeZone: string;
  localKickoff: string;
  localDate: string;
  venue: string | null;
  city: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  home: league.LeagueTeamIdentity | null;
  away: league.LeagueTeamIdentity | null;
  /** Which side is ours, from the team ids — never from the club's name. */
  ourSide: 'home' | 'away' | null;
  isHome: boolean | null;
  /** WIN | DRAW | LOSS from our side, once a result exists. Null before. */
  outcome: 'WIN' | 'DRAW' | 'LOSS' | null;
  /** Null while no weather provider is configured. Never fabricated. */
  weather: weather.WeatherReading | null;
  /** The open reschedule request on this fixture, when there is one. */
  reschedule: { id: string; status: string; proposedKickoff: string } | null;
}

export interface MatchCenterCalendar {
  clubId: string;
  teamIds: string[];
  /** The team this calendar is scoped to, or null for the First Team default. */
  teamId: string | null;
  /** What the reader may do with that team — the UI draws its state from this. */
  access: TeamAccess | null;
  competitions: MatchCenterCompetition[];
  fixtures: MatchCenterFixtureRow[];
  /** Whether the platform can answer weather at all, so the UI can say why. */
  weatherAvailable: boolean;
}

/**
 * What kind of competition this is, from the record rather than from its name.
 *
 * `format` is the competition engine's own field and is preferred; the code and
 * name are consulted only for the shapes the engine does not yet distinguish
 * (a pre-season block, a preparation match). Nothing here hardcodes a
 * competition that does not exist: a new one classifies itself the moment its
 * record is created.
 */
export function classifyCompetition(input: { format: string; code: string; name: string }): MatchCenterCompetitionKind {
  const fmt = String(input.format || '').toUpperCase();
  const hay = `${input.code} ${input.name}`.toUpperCase();
  if (fmt === 'LEAGUE') return 'LEAGUE';
  if (fmt === 'CUP' || fmt === 'KNOCKOUT' || fmt === 'GROUP_KNOCKOUT') return 'CUP';
  if (fmt === 'FRIENDLY') return 'FRIENDLY';
  if (/PRE[-_ ]?SEASON/.test(hay)) return 'PRESEASON';
  if (/PREPARATION/.test(hay)) return 'PREPARATION';
  if (/FRIENDLY/.test(hay)) return 'FRIENDLY';
  if (/\bCUP\b|KNOCKOUT|TROPHY/.test(hay)) return 'CUP';
  return 'OTHER';
}

interface ClubZoneRow { id: string; city: string; country: string; timezone: string | null }

/** Every club that owns one of the venues in this set of fixtures, once. */
async function clubZones(clubIds: string[]): Promise<Map<string, ClubZoneRow>> {
  if (!clubIds.length) return new Map();
  const rows = await prisma.club.findMany({
    where: { id: { in: [...new Set(clubIds)] } },
    select: { id: true, city: true, country: true, timezone: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export interface CalendarQuery {
  /** ISO dates. Both optional — the default is the club's whole calendar. */
  from?: string;
  to?: string;
  competitionId?: string;
  /**
   * The team whose calendar this is. Omitted means the First Team, which is
   * what this module meant before academy teams had one of their own.
   */
  teamId?: string;
}

/**
 * Every fixture the club's first teams are in, across every competition.
 *
 * Read in one pass and returned whole: the calendar groups, filters and paints
 * on the client, and a coach scrolling from August to May must not fire a
 * request per month. Nothing is created, nothing is copied.
 */
export async function getCalendar(actor: MatchCenterActor, q: CalendarQuery = {}): Promise<MatchCenterCalendar> {
  const clubId = actor.clubId;
  if (!clubId) throw new ForbiddenError('No club is active for this session');

  // One team, or the First Team by default. Either way the scope is decided by
  // team-access before a single fixture is read, so a calendar can never carry
  // a team this person may not see.
  const scope = await resolveTeamScope(actor, q.teamId ?? null);
  const teamIds = scope.teamIds;
  if (!teamIds.length) {
    return {
      clubId, teamIds: [], teamId: scope.teamId, access: scope.access,
      competitions: [], fixtures: [], weatherAvailable: weather.isConfigured(),
    };
  }

  const where: Prisma.FixtureWhereInput = {
    OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }],
  };
  if (q.competitionId) where.competitionId = q.competitionId;
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw new BadRequestError('from and to must be dates');
  }
  if (from || to) {
    where.scheduledAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const fixtures = await prisma.fixture.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: { competition: { select: { id: true, name: true, code: true, season: true, format: true, clubId: true, rules: true } } },
  });
  if (!fixtures.length) {
    return {
      clubId, teamIds, teamId: scope.teamId, access: scope.access,
      competitions: [], fixtures: [], weatherAvailable: weather.isConfigured(),
    };
  }

  // Identity for every team on every fixture, in one read rather than one per
  // row. A team that is not a registered participant of its competition is
  // still identified — see teamIdentities' second argument.
  const allTeamIds = [...new Set(fixtures.flatMap((f) => [f.homeTeamId, f.awayTeamId]))];
  const teams = await prisma.team.findMany({
    where: { id: { in: allTeamIds } },
    select: { id: true, name: true, shortName: true, clubId: true },
  });
  const clubs = await clubZones(teams.map((t) => t.clubId));
  const clubNames = await prisma.club.findMany({
    where: { id: { in: [...new Set(teams.map((t) => t.clubId))] } },
    select: { id: true, name: true, crestUrl: true, emblem: true },
  });
  const clubById = new Map(clubNames.map((c) => [c.id, c]));
  const identityOf = (teamId: string): league.LeagueTeamIdentity | null => {
    const t = teams.find((x) => x.id === teamId);
    if (!t) return null;
    const c = clubById.get(t.clubId);
    return {
      teamId: t.id,
      teamName: t.name,
      clubId: t.clubId,
      clubName: c?.name ?? t.name,
      crestUrl: c?.crestUrl ?? c?.emblem ?? null,
      shortName: t.shortName ?? null,
    };
  };

  // The open request on each fixture, if any. One query for the whole calendar.
  const open = await prisma.fixtureChangeRequest.findMany({
    where: {
      fixtureId: { in: fixtures.map((f) => f.id) },
      status: { notIn: ['APPROVED', 'REJECTED', 'CANCELLED', 'OPPONENT_REJECTED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, fixtureId: true, status: true, proposedKickoff: true },
  });
  const openByFixture = new Map<string, (typeof open)[number]>();
  for (const r of open) if (!openByFixture.has(r.fixtureId)) openByFixture.set(r.fixtureId, r);

  const competitions = new Map<string, MatchCenterCompetition>();
  const rows: MatchCenterFixtureRow[] = [];
  // Asked once for the whole calendar rather than once per fixture: with no
  // provider there is nothing to ask, and a hundred rows should not each pay
  // for finding that out.
  const canReportWeather = weather.isConfigured();

  for (const f of fixtures) {
    const compRow: MatchCenterCompetition = {
      id: f.competition.id,
      name: f.competition.name,
      code: f.competition.code,
      season: f.competition.season,
      format: f.competition.format,
      ownedByClubId: f.competition.clubId,
      kind: classifyCompetition(f.competition),
    };
    competitions.set(compRow.id, compRow);

    const home = identityOf(f.homeTeamId);
    const away = identityOf(f.awayTeamId);
    const ourSide: 'home' | 'away' | null = teamIds.includes(f.homeTeamId) ? 'home'
      : teamIds.includes(f.awayTeamId) ? 'away' : null;

    // The venue is the home club's, so the clock that judges the kickoff is
    // the home club's too.
    const hostClub = home ? clubs.get(home.clubId) ?? null : null;
    const policy = readSchedulingPolicy(f.competition.rules);
    const zone = resolveVenueTimeZone({
      clubTimeZone: hostClub?.timezone ?? null,
      clubCountry: hostClub?.country ?? null,
      policy,
    });
    const clock = localClockAt(f.scheduledAt, zone.timeZone);

    let outcome: 'WIN' | 'DRAW' | 'LOSS' | null = null;
    if (ourSide && f.homeScore != null && f.awayScore != null) {
      const ours = ourSide === 'home' ? f.homeScore : f.awayScore;
      const theirs = ourSide === 'home' ? f.awayScore : f.homeScore;
      outcome = ours > theirs ? 'WIN' : ours < theirs ? 'LOSS' : 'DRAW';
    }

    const req = openByFixture.get(f.id);
    rows.push({
      fixtureId: f.id,
      matchId: f.matchId ?? null,
      competition: compRow,
      round: f.round ?? null,
      leg: f.leg ?? null,
      scheduledAt: f.scheduledAt.toISOString(),
      playedAt: f.playedAt ? f.playedAt.toISOString() : null,
      venueTimeZone: zone.timeZone,
      localKickoff: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      localDate: clock.date,
      venue: f.venue ?? null,
      city: hostClub?.city ?? null,
      status: f.status,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
      home,
      away,
      ourSide,
      isHome: ourSide == null ? null : ourSide === 'home',
      outcome,
      // Null until a provider is configured. The screen renders that null as
      // "Weather unavailable" rather than as a temperature nobody measured.
      weather: canReportWeather
        ? await weather.describe({
            venue: f.venue ?? null,
            city: hostClub?.city ?? null,
            country: hostClub?.country ?? null,
            timeZone: zone.timeZone,
            kickoffAt: f.scheduledAt,
          })
        : null,
      reschedule: req
        ? { id: req.id, status: req.status, proposedKickoff: req.proposedKickoff.toISOString() }
        : null,
    });
  }

  return {
    clubId,
    teamIds,
    teamId: scope.teamId,
    access: scope.access,
    competitions: [...competitions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    fixtures: rows,
    weatherAvailable: weather.isConfigured(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One fixture, in full
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Match Workspace's data, for a fixture in ANY competition.
 *
 * The reader is the League's — both squads, both standings rows, the lineups,
 * the timeline, the player statistics — because a match is a match whichever
 * competition it belongs to, and a second implementation of that reader is
 * exactly the duplicate this restructure exists to avoid.
 *
 * Access: the caller's own club must be one of the two sides, or the caller is
 * a platform administrator. A league match is readable by any participant
 * through the League's own route, which is unchanged; this route is the club's
 * own calendar and is scoped to it.
 */
export async function getFixtureDetail(actor: MatchCenterActor, fixtureId: string): Promise<league.LeagueMatchDetail & {
  scheduling: {
    timeZone: string;
    localKickoff: string;
    policy: SchedulingPolicy;
    city: string | null;
  };
  weather: weather.WeatherReading | null;
  weatherAvailable: boolean;
  requests: FixtureChangeRequestView[];
  /** The caller's own side of this fixture, and what they may do with it. */
  teamId: string | null;
  access: TeamAccess | null;
}> {
  const fixture = await prisma.fixture.findUnique({
    where: { id: fixtureId },
    include: { competition: { select: { id: true, rules: true } } },
  });
  if (!fixture) throw new NotFoundError('Fixture');

  const ours = await fixtureAccess(actor, fixture.homeTeamId, fixture.awayTeamId);

  const detail = await league.getMatchDetail(fixture.competitionId, fixture.id);

  const homeClubId = detail.home?.clubId ?? null;
  const hostClub = homeClubId
    ? await prisma.club.findUnique({ where: { id: homeClubId }, select: { city: true, country: true, timezone: true } })
    : null;
  const policy = readSchedulingPolicy(fixture.competition.rules);
  const zone = resolveVenueTimeZone({
    clubTimeZone: hostClub?.timezone ?? null,
    clubCountry: hostClub?.country ?? null,
    policy,
  });
  const clock = localClockAt(fixture.scheduledAt, zone.timeZone);

  return {
    ...detail,
    scheduling: {
      timeZone: zone.timeZone,
      localKickoff: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      policy,
      city: hostClub?.city ?? null,
    },
    weather: await weather.describe({
      venue: fixture.venue ?? null,
      city: hostClub?.city ?? null,
      country: hostClub?.country ?? null,
      timeZone: zone.timeZone,
      kickoffAt: fixture.scheduledAt,
    }),
    weatherAvailable: weather.isConfigured(),
    requests: await listRequests(fixtureId),
    teamId: ours.ourTeamId,
    access: ours.access,
  };
}

/**
 * Which side of this fixture is the caller's own, and what they may do with it.
 *
 * A fixture is readable when one of its two teams is one the caller may read,
 * and it is WRITABLE only through the team they are assigned to manage. That is
 * the whole of the separation the brief asks for: a First Team coach reading an
 * academy fixture gets the board and no controls, and an Under-14 coach may move
 * an Under-14 kickoff and nobody else's.
 *
 * Asked of the team rows, never of a club name.
 */
async function fixtureAccess(
  actor: MatchCenterActor,
  homeTeamId: string,
  awayTeamId: string,
): Promise<{ ourTeamId: string | null; access: TeamAccess | null }> {
  const sides = [homeTeamId, awayTeamId];
  let best: { ourTeamId: string; access: TeamAccess } | null = null;
  for (const teamId of sides) {
    let access: TeamAccess;
    try { access = await accessForTeam(actor, teamId); } catch { continue; }
    if (!access.canView) continue;
    // A team this person manages wins over one they merely read, so a fixture
    // between two of the club's own teams is writable from the right side.
    if (!best || (access.canManage && !best.access.canManage)) best = { ourTeamId: teamId, access };
  }
  if (!best) throw new ForbiddenError('That fixture does not belong to a team you have access to');
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking for a different kickoff
// ─────────────────────────────────────────────────────────────────────────────
//
// A club may ask. It may not take. The fixture row is written exactly once, at
// APPROVED, and until then both clubs read the same canonical kickoff — which is
// what stops two clubs turning up on different days because one of them edited
// a time in a screen.

export interface FixtureChangeRequestView {
  id: string;
  fixtureId: string;
  status: string;
  requestedByClubId: string;
  opponentClubId: string | null;
  currentKickoff: string;
  proposedKickoff: string;
  timeZone: string;
  reason: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  history: Array<{ status: string; note: string | null; actorClubId: string | null; actorRole: string | null; at: string }>;
}

const OPEN_STATES = ['DRAFT', 'REQUESTED', 'AWAITING_OPPONENT', 'OPPONENT_ACCEPTED', 'AWAITING_COMPETITION_APPROVAL'];

export async function listRequests(fixtureId: string): Promise<FixtureChangeRequestView[]> {
  const rows = await prisma.fixtureChangeRequest.findMany({
    where: { fixtureId },
    orderBy: { createdAt: 'desc' },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  return rows.map((r) => ({
    id: r.id,
    fixtureId: r.fixtureId,
    status: r.status,
    requestedByClubId: r.requestedByClubId,
    opponentClubId: r.opponentClubId,
    currentKickoff: r.currentKickoff.toISOString(),
    proposedKickoff: r.proposedKickoff.toISOString(),
    timeZone: r.timeZone,
    reason: r.reason,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    history: r.events.map((e) => ({
      status: e.status,
      note: e.note,
      actorClubId: e.actorClubId,
      actorRole: e.actorRole,
      at: e.createdAt.toISOString(),
    })),
  }));
}

export interface CreateRequestInput {
  fixtureId: string;
  /** ISO instant for the proposed kickoff. */
  proposedKickoff: string;
  reason: string;
  note?: string | null;
  /** A draft is saved without being sent; anything else is sent immediately. */
  submit?: boolean;
}

/**
 * The scheduling context one fixture is judged in — resolved once and used by
 * both the check and the write, so a proposal can never be validated against a
 * different policy than the one that stores it.
 */
export async function schedulingContextFor(fixtureId: string): Promise<{
  fixture: { id: string; scheduledAt: Date; status: string; homeTeamId: string; awayTeamId: string; competitionId: string };
  policy: SchedulingPolicy;
  timeZone: string;
  homeClubId: string | null;
  awayClubId: string | null;
}> {
  const fixture = await prisma.fixture.findUnique({
    where: { id: fixtureId },
    include: { competition: { select: { rules: true } } },
  });
  if (!fixture) throw new NotFoundError('Fixture');

  const teams = await prisma.team.findMany({
    where: { id: { in: [fixture.homeTeamId, fixture.awayTeamId] } },
    select: { id: true, clubId: true },
  });
  const homeClubId = teams.find((t) => t.id === fixture.homeTeamId)?.clubId ?? null;
  const awayClubId = teams.find((t) => t.id === fixture.awayTeamId)?.clubId ?? null;
  const hostClub = homeClubId
    ? await prisma.club.findUnique({ where: { id: homeClubId }, select: { country: true, timezone: true } })
    : null;

  const policy = readSchedulingPolicy(fixture.competition.rules);
  const zone = resolveVenueTimeZone({
    clubTimeZone: hostClub?.timezone ?? null,
    clubCountry: hostClub?.country ?? null,
    policy,
  });

  return {
    fixture: {
      id: fixture.id,
      scheduledAt: fixture.scheduledAt,
      status: fixture.status,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      competitionId: fixture.competitionId,
    },
    policy,
    timeZone: zone.timeZone,
    homeClubId,
    awayClubId,
  };
}

export async function createRequest(actor: MatchCenterActor, input: CreateRequestInput): Promise<FixtureChangeRequestView> {
  const ctx = await schedulingContextFor(input.fixtureId);
  // Asking for a fixture to be moved is a change to that team's calendar, so it
  // takes an assignment to that team — not merely membership of the club that
  // owns it. A curl from the wrong context is refused right here.
  const ours = await fixtureAccess(actor, ctx.fixture.homeTeamId, ctx.fixture.awayTeamId);
  if (!ours.access?.canManage) {
    throw new ForbiddenError('You are not assigned to manage either team in this fixture');
  }

  if (ctx.fixture.status === 'PLAYED' || ctx.fixture.status === 'CANCELLED') {
    throw new BadRequestError('That match can no longer be rescheduled');
  }

  // The same rule the client applied, applied again where it counts. A client
  // that skipped it, or was bypassed entirely, gets the same refusal.
  const check = validateKickoff({
    at: input.proposedKickoff,
    timeZone: ctx.timeZone,
    policy: ctx.policy,
    current: ctx.fixture.scheduledAt,
  });
  if (!check.ok) throw new BadRequestError(check.message);

  // One fixture may not carry two live proposals: the second would race the
  // first through the approvals and whichever landed last would win silently.
  const already = await prisma.fixtureChangeRequest.findFirst({
    where: { fixtureId: input.fixtureId, status: { in: OPEN_STATES as never[] } },
  });
  if (already) throw new BadRequestError('A change request for this fixture is already open');

  const reason = String(input.reason || '').trim();
  if (!reason) throw new BadRequestError('A reason is required');

  const opponentClubId = actor.clubId === ctx.homeClubId ? ctx.awayClubId : ctx.homeClubId;
  const status = input.submit === false ? 'DRAFT' : 'AWAITING_OPPONENT';

  const created = await prisma.fixtureChangeRequest.create({
    data: {
      fixtureId: input.fixtureId,
      requestedByClubId: actor.clubId,
      requestedByUserId: actor.userId || null,
      opponentClubId,
      currentKickoff: ctx.fixture.scheduledAt,
      proposedKickoff: new Date(input.proposedKickoff),
      timeZone: ctx.timeZone,
      reason,
      note: input.note?.trim() || null,
      status: status as never,
      events: {
        create: status === 'DRAFT'
          ? [{ status: 'DRAFT' as never, actorUserId: actor.userId || null, actorClubId: actor.clubId, actorRole: actor.role ?? null, note: reason }]
          : [
              { status: 'REQUESTED' as never, actorUserId: actor.userId || null, actorClubId: actor.clubId, actorRole: actor.role ?? null, note: reason },
              { status: 'AWAITING_OPPONENT' as never, actorClubId: actor.clubId, actorRole: actor.role ?? null, note: null },
            ],
      },
    },
  });

  const view = (await listRequests(input.fixtureId)).find((r) => r.id === created.id);
  if (!view) throw new NotFoundError('Change request');
  return view;
}

export type RequestAction = 'SUBMIT' | 'ACCEPT' | 'REJECT' | 'APPROVE' | 'DECLINE' | 'CANCEL';

/**
 * Move a request along. Who may make which move is the whole point of the
 * workflow, so it is decided here rather than in the screen:
 *
 *   SUBMIT   the club that raised it, from DRAFT
 *   ACCEPT   the opponent, from AWAITING_OPPONENT
 *   REJECT   the opponent, from AWAITING_OPPONENT
 *   APPROVE  a platform administrator, once the opponent has accepted
 *   DECLINE  a platform administrator, at the same point
 *   CANCEL   the club that raised it, at any point before it is decided
 *
 * The fixture is written on APPROVE and nowhere else.
 */
export async function actOnRequest(
  actor: MatchCenterActor,
  requestId: string,
  action: RequestAction,
  note?: string | null,
): Promise<FixtureChangeRequestView> {
  const req = await prisma.fixtureChangeRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new NotFoundError('Change request');

  const isAdmin = actor.role === 'SUPER_ADMIN';

  // Deciding a request changes a fixture, so it takes the same assignment
  // asking for one does. The club still says WHICH side of the request this
  // person is on; the team assignment says whether they may answer for it at
  // all. Without this a club-mate with no team could accept on the Under-14s'
  // behalf simply by being in the same club.
  let manages = isAdmin;
  if (!isAdmin) {
    const ctx = await schedulingContextFor(req.fixtureId);
    const ours = await fixtureAccess(actor, ctx.fixture.homeTeamId, ctx.fixture.awayTeamId);
    manages = !!ours.access?.canManage;
  }
  const isRequester = manages && actor.clubId === req.requestedByClubId;
  const isOpponent = manages && !!req.opponentClubId && actor.clubId === req.opponentClubId;

  let next: string;
  // A step the history records before the one the status moves to, when a
  // single action means two things.
  let alsoRecord: string | null = null;
  const now = new Date();
  const data: Prisma.FixtureChangeRequestUpdateInput = {};

  switch (action) {
    case 'SUBMIT':
      if (!isRequester) throw new ForbiddenError('Only the club that raised this may send it');
      if (req.status !== 'DRAFT') throw new BadRequestError('This request has already been sent');
      next = 'AWAITING_OPPONENT';
      break;
    case 'ACCEPT':
      if (!isOpponent && !isAdmin) throw new ForbiddenError('Only the opponent may accept this');
      if (req.status !== 'AWAITING_OPPONENT') throw new BadRequestError('This request is not waiting on the opponent');
      // Two things happen: the opponent accepted, and the request now waits on
      // the competition. The status is the second; the first is recorded in the
      // history as its own line so the trail says who agreed and when.
      next = 'AWAITING_COMPETITION_APPROVAL';
      alsoRecord = 'OPPONENT_ACCEPTED';
      data.decidedByOpponentAt = now;
      break;
    case 'REJECT':
      if (!isOpponent && !isAdmin) throw new ForbiddenError('Only the opponent may reject this');
      if (req.status !== 'AWAITING_OPPONENT') throw new BadRequestError('This request is not waiting on the opponent');
      next = 'OPPONENT_REJECTED';
      data.decidedByOpponentAt = now;
      break;
    case 'APPROVE':
      if (!isAdmin) throw new ForbiddenError('Only the competition may approve a change');
      if (req.status !== 'AWAITING_COMPETITION_APPROVAL' && req.status !== 'OPPONENT_ACCEPTED') {
        throw new BadRequestError('This request is not waiting on the competition');
      }
      next = 'APPROVED';
      data.decidedByCompetitionAt = now;
      data.appliedAt = now;
      break;
    case 'DECLINE':
      if (!isAdmin) throw new ForbiddenError('Only the competition may decline a change');
      if (req.status !== 'AWAITING_COMPETITION_APPROVAL' && req.status !== 'OPPONENT_ACCEPTED') {
        throw new BadRequestError('This request is not waiting on the competition');
      }
      next = 'REJECTED';
      data.decidedByCompetitionAt = now;
      break;
    case 'CANCEL':
      if (!isRequester && !isAdmin) throw new ForbiddenError('Only the club that raised this may cancel it');
      if (!OPEN_STATES.includes(req.status)) throw new BadRequestError('This request has already been decided');
      next = 'CANCELLED';
      break;
    default:
      throw new BadRequestError('Unknown action');
  }

  // Approving writes the fixture, and the proposal is re-checked against the
  // policy as it stands NOW rather than as it stood when the request was made:
  // a proposal that has since fallen into the past, or a competition whose
  // window has been narrowed since, must not be applied by an approval.
  if (next === 'APPROVED') {
    const ctx = await schedulingContextFor(req.fixtureId);
    const check = validateKickoff({ at: req.proposedKickoff, timeZone: ctx.timeZone, policy: ctx.policy });
    if (!check.ok) throw new BadRequestError(check.message);

    await prisma.$transaction(async (tx) => {
      await tx.fixture.update({
        where: { id: req.fixtureId },
        data: { scheduledAt: req.proposedKickoff },
      });
      const fixture = await tx.fixture.findUnique({ where: { id: req.fixtureId }, select: { matchId: true } });
      if (fixture?.matchId) {
        // One canonical kickoff. The Match row the fixture is played as moves
        // with it, so the League and the Match Center cannot disagree.
        await tx.match.update({ where: { id: fixture.matchId }, data: { scheduledAt: req.proposedKickoff } });
      }
    });
  }

  await prisma.fixtureChangeRequest.update({
    where: { id: requestId },
    data: {
      ...data,
      status: next as never,
      events: {
        create: [
          ...(alsoRecord
            ? [{
                status: alsoRecord as never,
                actorUserId: actor.userId || null,
                actorClubId: actor.clubId || null,
                actorRole: actor.role ?? null,
                note: note?.trim() || null,
              }]
            : []),
          {
            status: next as never,
            actorUserId: actor.userId || null,
            actorClubId: actor.clubId || null,
            actorRole: actor.role ?? null,
            note: alsoRecord ? null : (note?.trim() || null),
          },
        ],
      },
    },
  });

  const view = (await listRequests(req.fixtureId)).find((r) => r.id === requestId);
  if (!view) throw new NotFoundError('Change request');
  return view;
}

/**
 * The window a proposal will be judged against, so the screen can show it and
 * refuse early. The same policy the write path uses — asked, not duplicated.
 */
export async function policyFor(actor: MatchCenterActor, fixtureId: string): Promise<{
  policy: SchedulingPolicy;
  timeZone: string;
  currentKickoff: string;
  currentLocalKickoff: string;
  canManage: boolean;
}> {
  const ctx = await schedulingContextFor(fixtureId);
  const ours = await fixtureAccess(actor, ctx.fixture.homeTeamId, ctx.fixture.awayTeamId);
  const clock = localClockAt(ctx.fixture.scheduledAt, ctx.timeZone);
  return {
    policy: ctx.policy,
    timeZone: ctx.timeZone,
    currentKickoff: ctx.fixture.scheduledAt.toISOString(),
    currentLocalKickoff: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
    canManage: !!ours.access?.canManage,
  };
}

export { DEFAULT_SCHEDULING_POLICY };
