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
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getFixtureDetail } from '../src/competition/match-center.service';

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

  it('and the gate that refuses them is untouched', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'src/competition/match-center.service.ts'), 'utf8');
    const from = svc.indexOf('async function fixtureAccess(');
    expect(from).toBeGreaterThan(-1);
    const fn = svc.slice(from, svc.indexOf('\n}', from));
    expect(fn).toContain('await accessForTeam(actor, teamId)');
    expect(fn).toContain('if (!access.canViewPrivate) continue;');
    expect(fn).toContain("throw new ForbiddenError('That fixture does not belong to a team you have access to')");
    // It asks team-access and no role name of its own.
    expect(fn).not.toMatch(/HEAD_COACH|CLUB_ADMIN|CLUB_OWNER/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · the interface offers only what it can open', () => {
  /** The real `_flCanOpenMatchCentre`, on one reader's real scope. */
  function canOpen(fixture: Row, ctx: Row | null): boolean {
    const src = between('function _flMine(teamId) {', 'function _flRoot() {');
    const St = { context: ctx };
    // eslint-disable-next-line no-new-func
    const fn = new Function('State', '_FL', `${src}\nreturn _flCanOpenMatchCentre;`);
    return fn(St, { myTeamIds: [T_FIRST, T_U15] })(fixture);
  }
  const side = (teamId: string) => ({ teamId });
  const OUR_ROW = { home: side(T_FIRST), away: side(T_OPP) };
  const U15_ROW = { home: side(T_U15), away: side(T_OPP) };
  const OTHERS_ROW = { home: side(T_OPP), away: side('team-x') };

  const coachScope = { currentTeamScope: { unrestricted: false, teams: [{ id: T_FIRST }] } };
  const clubWide = { currentTeamScope: { unrestricted: true, teams: [] } };

  it('a team-scoped coach is offered his own team\'s fixture', () => {
    expect(canOpen(OUR_ROW, coachScope)).toBe(true);
  });

  it('and not his club\'s other team\'s, which myTeamIds would have called his', () => {
    expect(canOpen(U15_ROW, coachScope)).toBe(false);
    expect(canOpen(OTHERS_ROW, coachScope)).toBe(false);
  });

  it('a club-wide reader is offered both of the club\'s and neither of the strangers\'', () => {
    expect(canOpen(OUR_ROW, clubWide)).toBe(true);
    expect(canOpen(U15_ROW, clubWide)).toBe(true);
    expect(canOpen(OTHERS_ROW, clubWide)).toBe(false);
  });

  it('and before the scope has arrived it offers nothing rather than guessing', () => {
    expect(canOpen(OUR_ROW, null)).toBe(false);
    expect(canOpen(OUR_ROW, {})).toBe(false);
  });

  it('and it asks the scope, never a role', () => {
    const src = between('function _flCanOpenMatchCentre(x) {', '// The element this League is drawn inside');
    expect(src).toContain('currentTeamScope');
    expect(src).not.toMatch(/HEAD_COACH|CLUB_OWNER|CLUB_ADMIN|currentClubRole/);
  });

  it('and the preview says whose the match is instead of offering a button that fails', () => {
    const fn = between('function _flPreviewHtml() {', 'async function _flOpenPreview(fixtureId) {');
    expect(fn).toContain('_flCanOpenMatchCentre(');
    expect(fn).toContain('Match preparation is private to the teams playing');
    // Not a disabled control: a disabled button says "later", and this is not
    // a later. Checked against the code, not the prose explaining it.
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(code).not.toContain('disabled');
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
    const locales = fs.readdirSync(path.join(ROOT, 'public/i18n/catalogue'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    expect(locales.length).toBeGreaterThan(1);
    const sentences = [
      'This match is another team’s',
      'That fixture is no longer there',
      'Match preparation is private to the teams playing',
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
    expect(fn).toContain('league.getMatchDetail(fixture.competitionId, fixture.id)');
  });

  it('and the same fixture id answers the same way every time', async () => {
    const a = await getFixtureDetail(COACH as never, OURS);
    const b = await getFixtureDetail(COACH as never, OURS);
    expect(b.teamId).toBe(a.teamId);
    expect(b.context.fixtureId).toBe(a.context.fixtureId);
    expect(b.context.competitionId).toBe(a.context.competitionId);
  });
});
