/**
 * tests/academy-league-and-team-permissions.unit.test.ts
 *
 * Two rules, held shut against the database rather than against the source.
 *
 *   1. An Academy team's Familista League is ITS OWN competition. It admits the
 *      teams of its own age group and no others, its fixtures belong to it, its
 *      Match Center reads those fixtures, and its player statistics are
 *      aggregated from those matches alone. A First Team never appears in it,
 *      and one age group never reads another's.
 *
 *   2. A club is not one flat permission space. Being in the club buys the
 *      shell of a team — its name, its age group, its crest, who is responsible
 *      for it. Working on the team buys what is inside it. Everything below
 *      feeds the mocked database real rows and reads what the services actually
 *      answer, because the answer is what leaves the server.
 */

import { MembershipRole, TeamKind } from '@prisma/client';

// ── the club, as rows ────────────────────────────────────────────────────────
const CLUB = 'club-harta-berlin';
const OTHER_CLUB = 'club-elsewhere';

const TEAMS = [
  { id: 'team-first', clubId: CLUB, name: 'First Team', shortName: 'FT', kind: TeamKind.SENIOR, isActive: true },
  { id: 'team-u17', clubId: CLUB, name: 'U17', shortName: 'U17', kind: TeamKind.ACADEMY_U17, isActive: true },
  { id: 'team-u15', clubId: CLUB, name: 'U15', shortName: 'U15', kind: TeamKind.ACADEMY_U15, isActive: true },
  { id: 'team-other-u17', clubId: OTHER_CLUB, name: 'U17', shortName: 'U17', kind: TeamKind.ACADEMY_U17, isActive: true },
  { id: 'team-other-first', clubId: OTHER_CLUB, name: 'First Team', shortName: 'FT', kind: TeamKind.SENIOR, isActive: true },
];

interface MembershipFixture { userId: string; clubId: string; teamId: string | null; role: MembershipRole; isActive: boolean }

const MEMBERSHIPS: MembershipFixture[] = [
  { userId: 'u-first-coach', clubId: CLUB, teamId: 'team-first', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-u17-coach', clubId: CLUB, teamId: 'team-u17', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-u15-assistant', clubId: CLUB, teamId: 'team-u15', role: MembershipRole.ASSISTANT_COACH, isActive: true },
  { userId: 'u-owner', clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true },
  { userId: 'u-parent', clubId: CLUB, teamId: null, role: MembershipRole.PARENT, isActive: true },
];

const PLAYERS = [
  { id: 'p-first-1', clubId: CLUB, teamId: 'team-first', firstName: 'Senior', lastName: 'One', position: 'ST' },
  { id: 'p-u17-1', clubId: CLUB, teamId: 'team-u17', firstName: 'Youth', lastName: 'Seventeen', position: 'MC' },
  { id: 'p-u15-1', clubId: CLUB, teamId: 'team-u15', firstName: 'Youth', lastName: 'Fifteen', position: 'DC' },
];

// Two competitions: the First Team's league and the U17 league. Same engine,
// different category — which is the whole of the separation being tested.
const COMPETITIONS = [
  { id: 'comp-first', clubId: null, code: 'FAMILISTA-LEAGUE', season: '2026/27', name: 'Familista League', format: 'LEAGUE', ageGroup: null, rules: null },
  { id: 'comp-u17', clubId: null, code: 'FAMILISTA-LEAGUE-U17', season: '2026/27', name: 'Familista League U17', format: 'LEAGUE', ageGroup: 'U17', rules: null },
];

const COMPETITION_TEAMS = [
  { competitionId: 'comp-first', teamId: 'team-first', clubId: CLUB },
  { competitionId: 'comp-first', teamId: 'team-other-first', clubId: OTHER_CLUB },
  { competitionId: 'comp-u17', teamId: 'team-u17', clubId: CLUB },
  { competitionId: 'comp-u17', teamId: 'team-other-u17', clubId: OTHER_CLUB },
];

const FIXTURES = [
  { id: 'fx-first-1', competitionId: 'comp-first', matchId: 'm-first-1', homeTeamId: 'team-first', awayTeamId: 'team-other-first', round: 1, leg: null, scheduledAt: new Date('2026-09-12T13:00:00Z'), playedAt: null, venue: 'Harta Arena', status: 'SCHEDULED', homeScore: null, awayScore: null },
  { id: 'fx-u17-1', competitionId: 'comp-u17', matchId: 'm-u17-1', homeTeamId: 'team-u17', awayTeamId: 'team-other-u17', round: 1, leg: null, scheduledAt: new Date('2026-09-13T09:00:00Z'), playedAt: null, venue: 'Harta Youth Pitch', status: 'SCHEDULED', homeScore: null, awayScore: null },
];

const MATCH_STATS = [
  { matchId: 'm-first-1', playerId: 'p-first-1', clubId: CLUB, teamId: 'team-first', goals: 3, assists: 1, ratingFamilista: 8, minutesPlayed: 90, isStarting: true, yellowCards: 0, redCards: 0, shots: 5, shotsOnTarget: 3, passes: 40, passesCompleted: 34, tackles: 2, interceptions: 1, xg: 1.2, xa: 0.3 },
  { matchId: 'm-u17-1', playerId: 'p-u17-1', clubId: CLUB, teamId: 'team-u17', goals: 2, assists: 2, ratingFamilista: 7.5, minutesPlayed: 80, isStarting: true, yellowCards: 1, redCards: 0, shots: 4, shotsOnTarget: 2, passes: 33, passesCompleted: 30, tackles: 3, interceptions: 2, xg: 0.8, xa: 0.6 },
];

// ── the mocked database ──────────────────────────────────────────────────────
// Small, honest implementations of the few operations the services use, driven
// by the fixtures above. Every `where` a service builds is applied here, so a
// query that forgets its scope returns rows it should not have and the test
// fails on the answer rather than on the shape of the code.

const idIn = (v: unknown, value: string) =>
  v == null ? true : typeof v === 'string' ? v === value
    : Array.isArray((v as { in?: string[] }).in) ? (v as { in: string[] }).in.includes(value)
    : (v as { not?: unknown }).not !== undefined ? value != null : true;

const lastPlayerFindMany: unknown[] = [];

jest.mock('../src/config/database', () => ({
  prisma: {
    team: {
      findUnique: async ({ where }: any) => TEAMS.find((t) => t.id === where.id) ?? null,
      findMany: async ({ where = {} }: any = {}) => TEAMS.filter((t) =>
        (where.clubId ? t.clubId === where.clubId : true)
        && (where.isActive === undefined || t.isActive === where.isActive)
        && (where.kind ? idIn(where.kind, t.kind) : true)
        && (where.id ? idIn(where.id, t.id) : true)),
      count: async ({ where = {} }: any = {}) => TEAMS.filter((t) =>
        (where.isActive === undefined || t.isActive === where.isActive)
        && (where.kind ? idIn(where.kind, t.kind) : true)).length,
    },
    membership: {
      findMany: async ({ where }: any) => MEMBERSHIPS.filter((m) =>
        m.userId === where.userId && m.clubId === where.clubId && m.isActive === where.isActive)
        .map((m) => ({ teamId: m.teamId, role: m.role })),
    },
    player: {
      groupBy: async () => [],
      findUnique: async ({ where }: any) => PLAYERS.find((p) => p.id === where.id) ?? null,
      findMany: async (args: any) => {
        lastPlayerFindMany.push(args);
        const w = args?.where ?? {};
        const scoped = (w.AND ?? []).flatMap((c: any) => c.OR ?? []);
        return PLAYERS.filter((p) =>
          (w.clubId ? p.clubId === w.clubId : true)
          && (scoped.length
            ? scoped.some((c: any) => (c.teamId === null ? p.teamId === null : idIn(c.teamId, p.teamId ?? '')))
            : true));
      },
      count: async () => PLAYERS.length,
    },
    competition: {
      findFirst: async ({ where }: any) => COMPETITIONS.find((c) =>
        (where.clubId === undefined || c.clubId === where.clubId)
        && (where.id ? c.id === where.id : true)
        && (where.code ? c.code === where.code : true)
        && (where.season ? c.season === where.season : true)
        && (where.format ? c.format === where.format : true)) ?? null,
      findMany: async ({ where = {} }: any = {}) => COMPETITIONS
        .filter((c) => (where.code ? c.code === where.code : true))
        .map((c) => ({ season: c.season })),
    },
    competitionTeam: {
      findMany: async ({ where = {} }: any = {}) => COMPETITION_TEAMS
        .filter((e) => (where.teamId ? e.teamId === where.teamId : true)
          && (where.competitionId ? e.competitionId === where.competitionId : true)
          && (where.competition
            ? COMPETITIONS.some((c) => c.id === e.competitionId
                && (where.competition.clubId === undefined || c.clubId === where.competition.clubId)
                && (where.competition.format ? c.format === where.competition.format : true)
                && (where.competition.season ? c.season === where.competition.season : true))
            : true))
        .map((e) => ({
          ...e,
          competition: (() => {
            const c = COMPETITIONS.find((x) => x.id === e.competitionId)!;
            return { id: c.id, code: c.code, season: c.season };
          })(),
        })),
      count: async ({ where = {} }: any = {}) =>
        COMPETITION_TEAMS.filter((e) => e.competitionId === where.competitionId).length,
    },
    fixture: {
      findMany: async ({ where = {} }: any = {}) => FIXTURES.filter((f) => {
        if (where.competitionId && f.competitionId !== where.competitionId) return false;
        if (where.matchId?.not !== undefined && !f.matchId) return false;
        if (where.OR) {
          const ok = where.OR.some((c: any) =>
            (c.homeTeamId && idIn(c.homeTeamId, f.homeTeamId))
            || (c.awayTeamId && idIn(c.awayTeamId, f.awayTeamId)));
          if (!ok) return false;
        }
        return true;
      }).map((f) => ({
        ...f,
        competition: COMPETITIONS.find((c) => c.id === f.competitionId),
      })),
      count: async () => 0,
    },
    fixtureChangeRequest: { findMany: async () => [] },
    club: {
      findMany: async ({ where = {} }: any = {}) => [
        { id: CLUB, name: 'HARTA BERLIN', crestUrl: null, emblem: null, city: 'Berlin', country: 'DE', timezone: 'Europe/Berlin' },
        { id: OTHER_CLUB, name: 'Elsewhere FC', crestUrl: null, emblem: null, city: 'Munich', country: 'DE', timezone: 'Europe/Berlin' },
      ].filter((c) => (where.id ? idIn(where.id, c.id) : true)),
      findUnique: async ({ where }: any) => (where.id === CLUB
        ? { id: CLUB, name: 'HARTA BERLIN', city: 'Berlin', country: 'DE', timezone: 'Europe/Berlin' }
        : null),
    },
    playerMatchStats: {
      findMany: async ({ where = {} }: any = {}) =>
        MATCH_STATS.filter((s) => idIn(where.matchId, s.matchId)),
    },
    standing: { findMany: async () => [] },
  },
}));

jest.mock('../src/competition/match-weather.service', () => ({
  isConfigured: () => false,
  describe: async () => null,
}));

import * as teamAccess from '../src/identity/team-access.service';
import * as mc from '../src/competition/match-center.service';
import * as league from '../src/competition/familista-league.service';
import {
  eligibilityFor, eligibleTeamWhereFor, isEligibleFor, kindsForAgeGroup, ageGroupOfKind, allAgeGroups,
} from '../src/competition/league-eligibility';
import { academyCategory, FIRST_TEAM_CATEGORY, initAcademySeasons } from '../src/competition/familista-league.bootstrap';
import { requireTeamPrivate, requirePlayerTeamAccess } from '../src/middleware/team-scope.middleware';
import { getPlayers } from '../src/services/player.service';

const actor = (userId: string, clubId = CLUB, role?: string) => ({ userId, clubId, role });
const FIRST_COACH = actor('u-first-coach');
const U17_COACH = actor('u-u17-coach');
const U15_ASSISTANT = actor('u-u15-assistant');
const OWNER = actor('u-owner');
const PARENT = actor('u-parent');

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — who may do what
// ─────────────────────────────────────────────────────────────────────────────

describe('a person assigned to one team runs that team and no other', () => {
  it('1 · the First Team coach manages the First Team', async () => {
    const a = await teamAccess.accessForTeam(FIRST_COACH, 'team-first');
    expect(a.canManage).toBe(true);
    expect(a.canViewPrivate).toBe(true);
    expect(a.reason).toBe('TEAM_ASSIGNMENT');
  });

  it('2 · and does not thereby reach an academy team\'s private content', async () => {
    const a = await teamAccess.accessForTeam(FIRST_COACH, 'team-u17');
    expect(a.canManage).toBe(false);
    expect(a.canViewPrivate).toBe(false);
    // The team still EXISTS for them: a locked card is information.
    expect(a.canView).toBe(true);
    await expect(teamAccess.assertCanViewTeamPrivate(FIRST_COACH, 'team-u17')).rejects.toThrow(/not assigned/i);
    await expect(teamAccess.assertCanManageTeam(FIRST_COACH, 'team-u17')).rejects.toThrow(/not assigned/i);
  });

  it('3 · the U17 coach manages the U17s', async () => {
    const a = await teamAccess.accessForTeam(U17_COACH, 'team-u17');
    expect(a.canManage).toBe(true);
    expect(a.canViewPrivate).toBe(true);
  });

  it('4 · and cannot read another age group\'s private content', async () => {
    const a = await teamAccess.accessForTeam(U17_COACH, 'team-u15');
    expect(a.canViewPrivate).toBe(false);
    expect(a.canManage).toBe(false);
    await expect(teamAccess.assertCanViewTeamPrivate(U17_COACH, 'team-u15')).rejects.toThrow();
    // And not the First Team's either — the boundary runs in both directions.
    expect((await teamAccess.accessForTeam(U15_ASSISTANT, 'team-first')).canViewPrivate).toBe(false);
  });

  it('5 · an unassigned club member sees the shell and nothing operational', async () => {
    const a = await teamAccess.accessForTeam(PARENT, 'team-u17');
    expect(a.canView).toBe(true);
    expect(a.canViewPrivate).toBe(false);
    expect(a.canManage).toBe(false);
    expect(await teamAccess.hasAnyTeamPrivateAccess(PARENT)).toBe(false);
    // Every team of the club is listed for them, and every one of them locked.
    const contexts = await teamAccess.listTeamContexts(PARENT);
    expect(contexts.map((c) => c.teamId).sort()).toEqual(['team-first', 'team-u15', 'team-u17']);
    expect(contexts.every((c) => c.access.canView && !c.access.canViewPrivate)).toBe(true);
  });

  it('6 · the club owner administers every team of the club', async () => {
    for (const teamId of ['team-first', 'team-u17', 'team-u15']) {
      const a = await teamAccess.accessForTeam(OWNER, teamId);
      expect(a.canManage).toBe(true);
      expect(a.canViewPrivate).toBe(true);
      expect(a.reason).toBe('CLUB_WIDE');
    }
    // And not another club's, whatever their role says.
    expect((await teamAccess.accessForTeam(OWNER, 'team-other-u17')).canView).toBe(false);
  });

  it('7 · changing the team id by hand does not change the answer', async () => {
    // A team of another club, and a team of this club they are not on: both
    // refused, and refused BEFORE anything is read on their behalf.
    await expect(mc.resolveTeamScope(U17_COACH, 'team-other-u17')).rejects.toThrow();
    await expect(mc.resolveTeamScope(U17_COACH, 'team-u15')).rejects.toThrow();
    const scope = await mc.resolveTeamScope(U17_COACH, 'team-u17');
    expect(scope.teamIds).toEqual(['team-u17']);
  });

  it('8 · a direct call to a private route is refused with 403, not answered', async () => {
    const run = (mw: ReturnType<typeof requireTeamPrivate>, req: unknown) =>
      new Promise<unknown>((resolve) => mw(req as never, {} as never, ((e?: unknown) => resolve(e)) as never));

    const denied = await run(requireTeamPrivate(), {
      user: { id: 'u-first-coach', clubId: CLUB }, params: {}, query: { teamId: 'team-u17' }, body: {},
    });
    expect((denied as { statusCode?: number })?.statusCode).toBe(403);

    // The same request from the team's own coach passes through.
    const allowed = await run(requireTeamPrivate(), {
      user: { id: 'u-u17-coach', clubId: CLUB }, params: {}, query: { teamId: 'team-u17' }, body: {},
    });
    expect(allowed).toBeUndefined();

    // And a player of that team, addressed directly by id.
    const player = await run(requirePlayerTeamAccess('id'), {
      user: { id: 'u-first-coach', clubId: CLUB }, method: 'GET', params: { id: 'p-u17-1' }, query: {}, body: {},
    });
    expect((player as { statusCode?: number })?.statusCode).toBe(403);
  });

  it('9 · a player search answers with the searcher\'s own teams', async () => {
    const scope = await teamAccess.privateTeamScope(FIRST_COACH);
    expect(scope.unrestricted).toBe(false);
    expect(scope.teamIds).toEqual(['team-first']);

    const result = await getPlayers(CLUB, { teamScope: scope.teamIds, search: 'Youth' });
    expect(result.players.map((p: { id: string }) => p.id)).toEqual(['p-first-1']);
    expect(result.players.some((p: { teamId: string | null }) => p.teamId === 'team-u17')).toBe(false);

    // The club owner is unrestricted, and the list is unscoped for them.
    const owner = await teamAccess.privateTeamScope(OWNER);
    expect(owner.unrestricted).toBe(true);
    const all = await getPlayers(CLUB, { teamScope: undefined });
    expect(all.players).toHaveLength(PLAYERS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the Academy league pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('an age group competes with its own age group', () => {
  it('10 · a First Team can never enter an Academy competition', () => {
    const u17 = academyCategory('U17');
    expect(isEligibleFor(u17, { kind: TeamKind.SENIOR, isActive: true })).toBe(false);
    expect(eligibilityFor(u17, { kind: TeamKind.SENIOR, isActive: true }).reason).toBe('WRONG_AGE_GROUP');
    expect(isEligibleFor(u17, { kind: TeamKind.ACADEMY_U17, isActive: true })).toBe(true);
    // And the reverse: an academy side cannot enter the First Team's league.
    expect(isEligibleFor(FIRST_TEAM_CATEGORY, { kind: TeamKind.ACADEMY_U17, isActive: true })).toBe(false);
  });

  it('11 · and never with a different age group', () => {
    const u17 = academyCategory('U17');
    expect(isEligibleFor(u17, { kind: TeamKind.ACADEMY_U15, isActive: true })).toBe(false);
    expect(isEligibleFor(academyCategory('U15'), { kind: TeamKind.ACADEMY_U17, isActive: true })).toBe(false);
    // The query says exactly what the verdict says, for every age group the
    // schema knows — the two cannot drift apart.
    for (const group of allAgeGroups()) {
      const where = eligibleTeamWhereFor(group) as { kind: { in: TeamKind[] } };
      expect(where.kind.in).toEqual(kindsForAgeGroup(group));
      for (const kind of Object.values(TeamKind)) {
        expect(where.kind.in.includes(kind)).toBe(isEligibleFor({ ageGroup: group }, { kind, isActive: true }));
      }
    }
    // An age group is read off the schema, never listed by hand.
    expect(ageGroupOfKind(TeamKind.ACADEMY_U15)).toBe('U15');
    expect(ageGroupOfKind(TeamKind.SENIOR)).toBeNull();
    // The category's competition is its own, by code and by stored age group.
    expect(academyCategory('U17').code).toBe('FAMILISTA-LEAGUE-U17');
    expect(academyCategory('U17').ageGroup).toBe('U17');
  });

  it('12 · the Academy Match Center reads that team\'s own fixtures', async () => {
    const cal = await mc.getCalendar(U17_COACH, { teamId: 'team-u17' });
    expect(cal.teamIds).toEqual(['team-u17']);
    expect(cal.fixtures.map((f) => f.fixtureId)).toEqual(['fx-u17-1']);
    const row = cal.fixtures[0];
    // The real fixture, carrying its competition, round, venue and kickoff.
    expect(row.competition.id).toBe('comp-u17');
    expect(row.competition.code).toBe('FAMILISTA-LEAGUE-U17');
    expect(row.round).toBe(1);
    expect(row.venue).toBe('Harta Youth Pitch');
    expect(row.matchId).toBe('m-u17-1');
    expect(row.home?.teamId).toBe('team-u17');
    expect(row.away?.teamId).toBe('team-other-u17');
    expect(row.ourSide).toBe('home');
    // No First Team fixture reaches it, and no other age group's.
    expect(cal.fixtures.some((f) => f.competition.id === 'comp-first')).toBe(false);
  });

  it('13 · the league a team plays is the one it was entered in', async () => {
    const u17 = await league.getLeagueForTeam('team-u17');
    expect(u17?.id).toBe('comp-u17');
    expect(u17?.ageGroup).toBe('U17');
    const first = await league.getLeagueForTeam('team-first');
    expect(first?.id).toBe('comp-first');
    // A team entered in nothing has no league, and that is an empty state
    // rather than somebody else's competition.
    expect(await league.getLeagueForTeam('team-u15')).toBeNull();
  });

  it('14 · Academy player statistics come from Academy matches only', async () => {
    const boards = await league.getLeaderboards('comp-u17');
    expect(boards.players.map((p) => p.playerId)).toEqual(['p-u17-1']);
    expect(boards.goals[0].playerId).toBe('p-u17-1');
    expect(boards.goals[0].value).toBe(2);
    // The First Team's top scorer is in the First Team's league and nowhere else.
    expect(boards.players.some((p) => p.teamId === 'team-first')).toBe(false);
    const firstBoards = await league.getLeaderboards('comp-first');
    expect(firstBoards.players.map((p) => p.playerId)).toEqual(['p-first-1']);
    // Every category the First Team's board carries, the Academy's carries too.
    const line = boards.players[0];
    expect(line.appearances).toBe(1);
    expect(line.minutes).toBe(80);
    expect(line.assists).toBe(2);
    expect(line.yellowCards).toBe(1);
    expect(line.shots).toBe(4);
    expect(line.passes).toBe(33);
    expect(line.tackles).toBe(3);
    expect(line.averageRating).toBe(7.5);
  });

  it('an age group with nobody to play is skipped and said to be skipped', async () => {
    // Two real U17 teams exist on the platform, so the U17 league is real. One
    // U15 team exists, so there is no U15 competition — and none is invented.
    const out = await initAcademySeasons({ dryRun: true });
    const u17 = out.groups.find((g) => g.ageGroup === 'U17')!;
    const u15 = out.groups.find((g) => g.ageGroup === 'U15')!;
    expect(u17.skipped).toBe(false);
    expect(u17.teamCount).toBe(2);
    expect(u15.skipped).toBe(true);
    expect(u15.teamCount).toBe(1);
    expect(u15.result).toBeNull();
    expect(u15.note).toMatch(/a competition needs 2/i);
    // Every other age group the schema knows has no team at all, and is
    // skipped for the same honest reason rather than filled with invented ones.
    expect(out.groups.filter((g) => !g.skipped).map((g) => g.ageGroup)).toEqual(['U17']);
    expect(out.competitionsCreated).toBe(0);
  });

  it('15 · and the First Team\'s own path is unchanged', async () => {
    // Naming no team is still the First Team: the canonical competition by
    // code, and the club's first-team calendar.
    const lg = await league.getLeague();
    expect(lg?.code).toBe('FAMILISTA-LEAGUE');
    const cal = await mc.getCalendar(FIRST_COACH, {});
    expect(cal.teamIds).toEqual(['team-first']);
    expect(cal.fixtures.map((f) => f.fixtureId)).toEqual(['fx-first-1']);
    expect(cal.fixtures[0].competition.code).toBe('FAMILISTA-LEAGUE');
  });
});
