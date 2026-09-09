/**
 * tests/league-match-centre-handoff.unit.test.ts
 *
 * Familista League hands a fixture to the Match Centre, and says what happened.
 *
 * Two modules, one Fixture row. The League shows the competition — every round,
 * every club — and the Match Centre shows one team's private preparation. The
 * handoff between them was reported broken in production for a head coach
 * assigned to one team: "That match could not be opened. The fixture exists,
 * but the record behind it could not be read just now."
 *
 * Three separate faults met at that message.
 *
 * 1 · Every fixture in the competition was offered. `_flMine` answers with
 *     `myTeamIds`, which the server computes per CLUB — the club's entries in
 *     this competition — so for a coach scoped to one team it marks his club's
 *     other teams as his, and every other club's fixture was clickable anyway.
 *     `getFixtureDetail` refuses a fixture neither of whose sides the caller may
 *     read privately, and it is right to. The interface was offering a control
 *     whose only outcome was a 403.
 *
 * 2 · Every failure read as one. A refusal, a fixture that is gone and a read
 *     that failed all rendered the same sentence, so nobody could tell an
 *     intentional boundary from a broken server.
 *
 * 3 · A fixture with no Match staged behind it was refused before the request
 *     was made. The Match Centre is PREPARATION: an upcoming league fixture has
 *     no Match yet, and that is exactly the fixture a coach opens it for. The
 *     guard turned every upcoming fixture into a toast.
 *
 * None of this is authorization. `getFixtureDetail` is unchanged, and the tests
 * below drive the real one to prove it: the coach's own fixture opens, another
 * team's is refused server-side, and the opponent on the row changes nothing
 * about who he is.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const OTHER = 'club-elsewhere';
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';
const T_OPP = 'team-opp';
const COMP = 'comp-league';

const OURS = 'fix-ours';        // First Team v the opponent — his to prepare
const ACADEMY_FIX = 'fix-u15';  // the club's U15 v the opponent — not his
const STRANGERS = 'fix-others'; // two other clubs — nobody's business of his

const state = {
  fixtures: [] as Row[], teams: [] as Row[], memberships: [] as Row[],
  clubs: [] as Row[], comps: [] as Row[], matches: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('in' in v) return ((v as Row).in as unknown[]).includes(row[k]);
      if ('notIn' in v) return !((v as Row).notIn as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const db: Row = {
  fixture: {
    findUnique: async ({ where }: Row) => {
      const f = state.fixtures.find((x) => x.id === where.id) ?? null;
      return f ? { ...f, competition: state.comps.find((c) => c.id === f.competitionId) } : null;
    },
    findFirst: async ({ where = {} }: Row = {}) => state.fixtures.find((f) => match(f, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.fixtures.filter((f) => match(f, where)),
  },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.teams.filter((t) => match(t, where)),
  },
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  club: {
    findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null,
    findMany: async () => state.clubs,
  },
  competition: {
    findUnique: async ({ where }: Row) => state.comps.find((c) => c.id === where.id) ?? null,
    findFirst: async ({ where = {} }: Row = {}) => state.comps.find((c) => match(c, where)) ?? null,
  },
  match: { findUnique: async ({ where }: Row) => state.matches.find((m) => m.id === where.id) ?? null },
  competitionTeam: {
    findMany: async () => [
      { teamId: T_FIRST, clubId: CLUB }, { teamId: T_U15, clubId: CLUB },
      { teamId: T_OPP, clubId: OTHER }, { teamId: 'team-x', clubId: 'club-x' },
    ],
  },
  matchLineup: { findMany: async () => [] },
  matchTimeline: { findMany: async () => [] },
  playerMatchStats: { findMany: async () => [] },
  matchTacticalSnapshot: { count: async () => 0 },
  matchEvent: { count: async () => 0 },
  matchSquad: { findMany: async () => [] },
  standingsEntry: { findMany: async () => [] },
  staffProfile: { findMany: async () => [] },
  player: { findMany: async () => [], groupBy: async () => [], count: async () => 0 },
  fixtureChangeRequest: { findMany: async () => [] },
  securityEvent: { create: async () => ({}) },
  // No platform administrator among these accounts. Platform authority is
  // resolved from this table and nothing else, so an empty answer here is
  // what makes every actor below an ordinary club person.
  platformAdmin: { findUnique: async () => null },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getFixtureDetail } from '../src/competition/match-center.service';
import { getRound, getMatchDetail } from '../src/competition/familista-league.service';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

/** A slice of the shipped file, with anchors that must both exist. */
function between(from: string, to: string): string {
  const a = APP.indexOf(from);
  const b = APP.indexOf(to, a + 1);
  expect(`${from} found: ${a > -1}`).toBe(`${from} found: true`);
  expect(`${to} after it: ${b > a}`).toBe(`${to} after it: true`);
  return APP.slice(a, b);
}

const COACH = { userId: 'u-coach', clubId: CLUB, role: 'HEAD_COACH' };

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', city: 'Berlin', country: 'DE', timezone: 'Europe/Berlin' },
    { id: OTHER, name: 'Somewhere Else', city: 'Paris', country: 'FR', timezone: 'Europe/Paris' },
    { id: 'club-x', name: 'A Third Club', city: 'Rome', country: 'IT', timezone: 'Europe/Rome' },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', kind: 'SENIOR', isActive: true },
    { id: T_U15, clubId: CLUB, name: 'U15', kind: 'ACADEMY_U15', isActive: true },
    { id: T_OPP, clubId: OTHER, name: 'Their First', kind: 'SENIOR', isActive: true },
    { id: 'team-x', clubId: 'club-x', name: 'Third First', kind: 'SENIOR', isActive: true },
  ];
  state.comps = [{ id: COMP, clubId: null, code: 'FL-SEN', name: 'Familista League', season: '2026', rules: {} }];
  const fx = (id: string, home: string, away: string, matchId: string | null) => ({
    id, competitionId: COMP, clubId: null, homeTeamId: home, awayTeamId: away,
    scheduledAt: new Date('2026-03-01T18:00:00Z'), venue: 'Stadion', round: 3, leg: 1,
    status: 'SCHEDULED', homeScore: null, awayScore: null, playedAt: null, matchId,
  });
  state.fixtures = [
    // Deliberately no Match behind the coach's own fixture: it has not been
    // played, which is when preparation matters most.
    fx(OURS, T_FIRST, T_OPP, null),
    fx(ACADEMY_FIX, T_U15, T_OPP, null),
    fx(STRANGERS, T_OPP, 'team-x', null),
  ];
  state.matches = [];
  // One membership, one team. Nothing in this file changes it.
  state.memberships = [{
    id: 'm-coach', userId: 'u-coach', clubId: CLUB, teamId: T_FIRST,
    role: 'HEAD_COACH', isActive: true,
  }];
});

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · the authorized fixture opens', () => {
  it('the coach\'s own First Team fixture is readable, and answers from his side', async () => {
    const d = await getFixtureDetail(COACH as never, OURS);
    expect(d.teamId).toBe(T_FIRST);
    expect(d.access && (d.access as Row).canViewPrivate).toBe(true);
    // The competition's own context comes back with it, addressed by the same
    // fixture id the League handed over.
    expect(d.context.fixtureId).toBe(OURS);
  });

  it('and it opens with NO Match staged behind it, because preparation precedes the match', async () => {
    expect(state.fixtures.find((f) => f.id === OURS)!.matchId).toBeNull();
    const d = await getFixtureDetail(COACH as never, OURS);
    expect(d.match).toBeNull();
    // The fixture itself still carries the kickoff, the venue and both sides —
    // which is the whole of what an upcoming match is prepared against.
    expect(d.fixture.scheduledAt).toContain('2026-03-01');
    expect(d.fixture.venue).toBe('Stadion');
    expect(d.home && d.home.teamId).toBe(T_FIRST);
    expect(d.away && d.away.teamId).toBe(T_OPP);
  });

  it('and the interface no longer refuses that fixture before asking', () => {
    const branch = between("} else if (act === 'flMatch') {", "} else if (act === 'flManage') {");
    expect(branch).toContain("var fid = el.getAttribute('data-fixture-id');");
    // The guard that turned every unplayed league fixture into a toast is gone.
    expect(branch).not.toContain("data-match-id");
    expect(branch).not.toContain('has not been set up in the Match Centre yet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · the opponent on the row changes nothing about who he is', () => {
  it('reading his own fixture does not touch his membership or his team', async () => {
    const before = JSON.stringify(state.memberships);
    await getFixtureDetail(COACH as never, OURS);
    expect(JSON.stringify(state.memberships)).toBe(before);
    // Still one team, and it is still his.
    expect(state.memberships).toHaveLength(1);
    expect(state.memberships[0].teamId).toBe(T_FIRST);
  });

  it('and the handoff carries a fixture id and nothing about a club', () => {
    const fn = between('function _flOpenMatch(fixtureId) {', 'function _flTabTo(tab) {');
    expect(fn).toContain('_mccOpen(fixtureId, back)');
    // Not the opponent, not a club, not a team: opening a fixture is not a
    // context switch, and nothing here writes one.
    expect(fn).not.toMatch(/switchClub|switchTeam|_famSetClub|currentClubId|opponentClubId/);
  });

  it('and closing it returns to the League without re-entering a club or team', () => {
    const fn = between('function _mccClose() {', '// ── the workspace');
    expect(fn).toContain("navTo('familista-league')");
    expect(fn).not.toMatch(/switchClub|switchTeam|clubId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · another team\'s preparation is refused by the server', () => {
  it('his own club\'s U15 fixture is refused — the club is not the team', async () => {
    await expect(getFixtureDetail(COACH as never, ACADEMY_FIX)).rejects.toThrow(/access/i);
  });

  it('and a fixture between two other clubs is refused', async () => {
    await expect(getFixtureDetail(COACH as never, STRANGERS)).rejects.toThrow(/access/i);
  });

  it('while a club-wide member reads both of the club\'s, and still not the strangers\'', async () => {
    state.memberships = [{
      id: 'm-pres', userId: 'u-pres', clubId: CLUB, teamId: null,
      role: 'CLUB_OWNER', isActive: true,
    }];
    const pres = { userId: 'u-pres', clubId: CLUB, role: 'CLUB_ADMIN' };
    expect((await getFixtureDetail(pres as never, OURS)).teamId).toBe(T_FIRST);
    expect((await getFixtureDetail(pres as never, ACADEMY_FIX)).teamId).toBe(T_U15);
    await expect(getFixtureDetail(pres as never, STRANGERS)).rejects.toThrow(/access/i);
  });

  it('and the gate that refuses them asks the one resolver, and refuses the same way', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'src/competition/match-center.service.ts'), 'utf8');
    const from = svc.indexOf('async function fixtureAccess(');
    expect(from).toBeGreaterThan(-1);
    const fn = svc.slice(from, svc.indexOf('\n}', from));
    expect(fn).toContain('await viewerSideOfFixture(actor, homeTeamId, awayTeamId)');
    expect(fn).toContain("throw new ForbiddenError('That fixture does not belong to a team you have access to')");
    expect(fn).not.toMatch(/HEAD_COACH|CLUB_ADMIN|CLUB_OWNER/);

    // And the resolver it delegates to compares persisted team ids through
    // team-access, and nothing else. This is the one place the question lives.
    const ta = fs.readFileSync(path.join(ROOT, 'src/identity/team-access.service.ts'), 'utf8');
    const at = ta.indexOf('export async function viewerSideOfFixture(');
    expect(at).toBeGreaterThan(-1);
    const res = ta.slice(at, ta.indexOf('\n}', at));
    expect(res).toContain('await accessForTeam(actor, teamId)');
    expect(res).toContain('if (!access.canViewPrivate) continue;');
    // Never a name, a label, a club or an index.
    expect(res).not.toMatch(/clubName|teamName|shortName|\.name\b|indexOf\(/);
    expect(res).not.toMatch(/HEAD_COACH|CLUB_ADMIN|CLUB_OWNER/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · one canonical answer, and the interface reads it', () => {
  it('the League fills each row from the same function the Match Centre asks', async () => {
    const view = await getRound(COMP, 3, COACH as never);
    const byId = new Map(view.matches.map((m) => [m.fixtureId, m]));

    // THE PRODUCTION SHAPE: a team-scoped head coach, his authorized First
    // Team, a league fixture containing that same First Team.
    const ours = byId.get(OURS)!;
    expect(ours.canOpenMatchCentre).toBe(true);
    // And it names WHICH team of his it matched, by persisted id.
    expect(ours.viewerTeamId).toBe(T_FIRST);

    // His club's OTHER team's fixture. Same club, same crest, same name on
    // screen — and a different Team row, so not his.
    expect(byId.get(ACADEMY_FIX)!.canOpenMatchCentre).toBe(false);
    expect(byId.get(ACADEMY_FIX)!.viewerTeamId).toBeNull();

    // Two other clubs entirely.
    expect(byId.get(STRANGERS)!.canOpenMatchCentre).toBe(false);
    expect(byId.get(STRANGERS)!.viewerTeamId).toBeNull();
  });

  it('and the row the panel is built from carries the same answer', async () => {
    const d = await getMatchDetail(COMP, OURS, COACH as never);
    expect(d.fixture.canOpenMatchCentre).toBe(true);
    expect(d.fixture.viewerTeamId).toBe(T_FIRST);
    const other = await getMatchDetail(COMP, ACADEMY_FIX, COACH as never);
    expect(other.fixture.canOpenMatchCentre).toBe(false);
    expect(other.fixture.viewerTeamId).toBeNull();
  });

  it('and it agrees with the route that serves the fixture, on every row', async () => {
    // The two answers come from one function, so this cannot drift. Asserted
    // anyway, because drifting is precisely what happened when there were two.
    const view = await getRound(COMP, 3, COACH as never);
    for (const row of view.matches) {
      let served = true;
      try { await getFixtureDetail(COACH as never, row.fixtureId); } catch { served = false; }
      expect(`${row.fixtureId} · offered ${row.canOpenMatchCentre}, served ${served}`)
        .toBe(`${row.fixtureId} · offered ${served}, served ${served}`);
    }
  });

  it('and a club-wide member is offered both of the club\'s and neither stranger', async () => {
    state.memberships = [{
      id: 'm-pres', userId: 'u-pres', clubId: CLUB, teamId: null,
      role: 'CLUB_OWNER', isActive: true,
    }];
    const pres = { userId: 'u-pres', clubId: CLUB, role: 'CLUB_ADMIN' };
    const byId = new Map((await getRound(COMP, 3, pres as never)).matches.map((m) => [m.fixtureId, m]));
    expect(byId.get(OURS)!.viewerTeamId).toBe(T_FIRST);
    expect(byId.get(ACADEMY_FIX)!.viewerTeamId).toBe(T_U15);
    expect(byId.get(STRANGERS)!.canOpenMatchCentre).toBe(false);
  });

  it('and a caller with no session is offered nothing', async () => {
    const view = await getRound(COMP, 3, null);
    expect(view.matches.every((m) => m.canOpenMatchCentre === false)).toBe(true);
    expect(view.matches.every((m) => m.viewerTeamId === null)).toBe(true);
  });

  it('the client reads that answer and derives nothing of its own', () => {
    const src = between('function _flCanOpenMatchCentre(x) {', '/**\n * Why a fixture is not this reader');
    expect(src).toContain('return !!(x && x.canOpenMatchCentre);');
    // The two things it used to work out for itself, both gone.
    expect(src).not.toContain('myTeamIds');
    expect(src).not.toContain('currentTeamScope');
    expect(src).not.toMatch(/HEAD_COACH|CLUB_OWNER|CLUB_ADMIN|currentClubRole/);
  });

  it('and the preview offers the control, or says whose the match is', () => {
    const fn = between('function _flPreviewHtml() {', 'async function _flOpenPreview(fixtureId) {');
    expect(fn).toContain('_flCanOpenMatchCentre(d.fixture)');
    expect(fn).toContain('_flNotMineBecause(');
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(code).not.toContain('disabled');
  });

  it('and it says which of the two it is, without deciding anything by it', () => {
    const fn = between('function _flNotMineBecause(x) {', 'function _flRoot() {');
    // Read from the identities already on the row, for the sentence only.
    expect(fn).toContain('Another of your club’s teams plays this one');
    expect(fn).toContain('Match preparation is private to the teams playing');
    expect(fn).not.toContain('canOpenMatchCentre');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4b · and the canonical id is the only thing compared', () => {
  it('a club\'s SECOND senior team is a different team, however alike the rows look', async () => {
    // The trap this whole change is about. One club may field several teams in
    // one competition; the League row shows the CLUB's name and crest for both,
    // so two rows are indistinguishable on screen and are different Team rows.
    const T_SECOND = 'team-first-b';
    state.teams.push({ id: T_SECOND, clubId: CLUB, name: 'First Team', kind: 'SENIOR', isActive: true });
    state.fixtures.push({
      id: 'fix-second', competitionId: COMP, clubId: null,
      homeTeamId: T_SECOND, awayTeamId: T_OPP,
      scheduledAt: new Date('2026-03-01T18:00:00Z'), venue: 'Stadion', round: 3, leg: 1,
      status: 'SCHEDULED', homeScore: null, awayScore: null, playedAt: null, matchId: null,
    });

    const byId = new Map((await getRound(COMP, 3, COACH as never)).matches.map((m) => [m.fixtureId, m]));
    const mine = byId.get(OURS)!;
    const theirs = byId.get('fix-second')!;

    // Same club name, same crest, the same team NAME — and one is his, one is
    // not, because the ids differ and the ids are what is compared.
    expect(mine.home!.clubName).toBe(theirs.home!.clubName);
    expect(mine.home!.teamName).toBe(theirs.home!.teamName);
    expect(mine.home!.clubId).toBe(theirs.home!.clubId);
    expect(mine.home!.teamId).not.toBe(theirs.home!.teamId);

    expect(mine.canOpenMatchCentre).toBe(true);
    expect(mine.viewerTeamId).toBe(T_FIRST);
    expect(theirs.canOpenMatchCentre).toBe(false);
    expect(theirs.viewerTeamId).toBeNull();
    await expect(getFixtureDetail(COACH as never, 'fix-second')).rejects.toThrow(/access/i);
  });

  it('and a fixture naming a team that never registered is still identified', async () => {
    // `teamIdentities` was asked only about the competition's participants, so
    // a fixture naming an unregistered team came back with a nameless side —
    // and a row whose sides cannot be named is a row nothing can be decided
    // about. The fixture's own team ids are asked for now.
    const T_GUEST = 'team-guest';
    state.teams.push({ id: T_GUEST, clubId: 'club-x', name: 'Guest XI', kind: 'SENIOR', isActive: true });
    state.fixtures.push({
      id: 'fix-guest', competitionId: COMP, clubId: null,
      homeTeamId: T_FIRST, awayTeamId: T_GUEST,
      scheduledAt: new Date('2026-03-02T18:00:00Z'), venue: 'Stadion', round: 3, leg: 1,
      status: 'SCHEDULED', homeScore: null, awayScore: null, playedAt: null, matchId: null,
    });
    const row = (await getRound(COMP, 3, COACH as never)).matches.find((m) => m.fixtureId === 'fix-guest')!;
    expect(row.away).not.toBeNull();
    expect(row.away!.teamId).toBe(T_GUEST);
    // And it is still the coach's fixture, from his own side.
    expect(row.canOpenMatchCentre).toBe(true);
    expect(row.viewerTeamId).toBe(T_FIRST);
  });

  it('and the answer survives the id being the away side rather than the home one', async () => {
    state.fixtures.push({
      id: 'fix-away', competitionId: COMP, clubId: null,
      homeTeamId: T_OPP, awayTeamId: T_FIRST,
      scheduledAt: new Date('2026-03-03T18:00:00Z'), venue: 'Away', round: 3, leg: 1,
      status: 'SCHEDULED', homeScore: null, awayScore: null, playedAt: null, matchId: null,
    });
    const row = (await getRound(COMP, 3, COACH as never)).matches.find((m) => m.fixtureId === 'fix-away')!;
    expect(row.canOpenMatchCentre).toBe(true);
    expect(row.viewerTeamId).toBe(T_FIRST);
    expect((await getFixtureDetail(COACH as never, 'fix-away')).teamId).toBe(T_FIRST);
  });

  it('and none of it grants club-wide authority or changes the coach\'s scope', async () => {
    const before = JSON.stringify(state.memberships);
    await getRound(COMP, 3, COACH as never);
    await getFixtureDetail(COACH as never, OURS);
    expect(JSON.stringify(state.memberships)).toBe(before);
    // Still one membership, still team-scoped, still HEAD_COACH.
    expect(state.memberships).toHaveLength(1);
    expect(state.memberships[0].teamId).toBe(T_FIRST);
    expect(state.memberships[0].role).toBe('HEAD_COACH');
    // And the club's other team is still refused, which is what "no club-wide
    // authority" means here.
    await expect(getFixtureDetail(COACH as never, ACADEMY_FIX)).rejects.toThrow(/access/i);
  });

  it('and direct access to an unauthorized fixture is still refused at the route', async () => {
    // Offered or not, the server is the one refusing. Asking for the id
    // directly — which is all "the UI hid it" would ever be worth — is refused.
    for (const id of [ACADEMY_FIX, STRANGERS]) {
      await expect(getFixtureDetail(COACH as never, id)).rejects.toThrow(/access/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · and a failure says which failure it was', () => {
  it('the three answers are kept apart by status, not merged into one', () => {
    const fn = between('async function _mccOpen(fixtureId, returnTo) {', 'function _mccClose() {');
    expect(fn).toContain("st === 403 ? 'forbidden'");
    expect(fn).toContain("st === 404 ? 'missing'");
    expect(fn).toContain("'unreadable'");
  });

  it('and each one renders its own state', () => {
    const fn = between('function _mcWorkspaceHtml() {', 'function _mccRowFor(fixtureId) {');
    expect(fn).toContain('This match is another team’s');
    expect(fn).toContain('That fixture is no longer there');
    // The old sentence survives for the one case it was ever true of.
    expect(fn).toContain('The fixture exists, but the record behind it could not be read just now.');
    // And only that one is worth retrying.
    expect(fn).toContain("open.error === 'unreadable'");
    expect(fn).toContain('data-action="mccRetry"');
  });

  it('and a stale answer never lands on a newer one', () => {
    const fn = between('async function _mccOpen(fixtureId, returnTo) {', 'function _mccClose() {');
    expect(fn).toContain('var seq = (_MCC.seq = (_MCC.seq || 0) + 1);');
    expect(fn).toContain('if (seq !== _MCC.seq) return;');
  });

  it('and every one of those sentences is translated into every locale', () => {
    // en-US is deliberately sparse: it carries only what differs from the base,
    // and anything absent falls through to en-GB. Demanding an entry there
    // would be demanding the English twice.
    const locales = fs.readdirSync(path.join(ROOT, 'public/i18n/catalogue'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'en-US.json');
    expect(locales.length).toBeGreaterThan(1);
    const sentences = [
      'This match is another team’s',
      'That fixture is no longer there',
      'Match preparation is private to the teams playing',
      'Another of your club’s teams plays this one',
    ];
    for (const file of locales) {
      const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/catalogue', file), 'utf8'));
      for (const s of sentences) {
        expect(`${file} · ${s}: ${typeof cat[s] === 'string' && !!cat[s]}`)
          .toBe(`${file} · ${s}: true`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6 · and the fixture id is the only identifier that crosses', () => {
  it('the row carries the fixture id the server sent, and the handoff uses it', () => {
    const row = between('function _flMatchRow(x, compact) {', 'function _flPreviewHtml() {');
    expect(row).toContain("data-fixture-id=\"' + _esc(x.fixtureId) + '\"");
    const branch = between("} else if (act === 'flMatch') {", "} else if (act === 'flManage') {");
    expect(branch).toContain("_flOpenMatch(fid)");
    expect(branch).toContain("_flOpenPreview(fid)");
  });

  it('and the Match Centre asks for it by that id and no other', () => {
    const fn = between('async function _mccOpen(fixtureId, returnTo) {', 'function _mccClose() {');
    expect(fn).toContain("api('/match-center/fixtures/' + encodeURIComponent(fixtureId))");
  });

  it('and the server reads a Fixture by that id — the same row the League reads', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'src/competition/match-center.service.ts'), 'utf8');
    const from = svc.indexOf('export async function getFixtureDetail(');
    const fn = svc.slice(from, svc.indexOf('\n}\n', from));
    expect(fn).toContain('prisma.fixture.findUnique({');
    expect(fn).toContain('where: { id: fixtureId }');
    expect(fn).toContain('league.getMatchDetail(fixture.competitionId, fixture.id, actor)');
  });

  it('and the same fixture id answers the same way every time', async () => {
    const a = await getFixtureDetail(COACH as never, OURS);
    const b = await getFixtureDetail(COACH as never, OURS);
    expect(b.teamId).toBe(a.teamId);
    expect(b.context.fixtureId).toBe(a.context.fixtureId);
    expect(b.context.competitionId).toBe(a.context.competitionId);
  });
});
