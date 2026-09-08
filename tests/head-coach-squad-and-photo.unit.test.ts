/**
 * tests/head-coach-squad-and-photo.unit.test.ts
 *
 * A head coach scoped to one team could not save a photo, and was told his
 * squad had failed to load. One cause, and it was on this side of the wire.
 *
 * Hydration ran two things as one step. First `POST /transfer-market/bootstrap`
 * — which lifts a club's whole roster into real Player rows, a CLUB-wide write
 * the server guards with `tradeGuard`, and which a coach assigned to a single
 * team does not pass and should not. Then the roster read, which is team-scoped
 * on the server and answers him perfectly well.
 *
 * The 403 on the first failed the whole thing. So `_TH.state` never reached
 * 'ready', which produced "Switched club, but its squad could not be loaded —
 * retry" on every club entry, and — quietly — stopped every player write:
 * `_sqPersistPlayer` and `_atPersistPhoto` both decline to send a PATCH for a
 * session that is not hydrated. His photo never left the browser, and nothing
 * said so, because from the client's point of view nothing had failed.
 *
 * The President never saw it: club-wide authority passes `tradeGuard`, the seed
 * succeeded, and everything downstream worked.
 *
 * Nothing on the server changes. The seed is still refused — the tests below
 * prove it — and the coach's own team's players were always his to update. The
 * client no longer makes reading the roster depend on a write it was never
 * entitled to make.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { MembershipRole, MembershipStatus, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';

const state = {
  users: [] as Row[], memberships: [] as Row[], teams: [] as Row[], players: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (k === 'AND') return (v as Row[]).every((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('in' in v) return ((v as Row).in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const db: Row = {
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.teams.filter((t) => match(t, where)),
  },
  user: { findUnique: async ({ where }: Row) => state.users.find((u) => u.id === where.id) ?? null },
  player: {
    findUnique: async ({ where }: Row) => state.players.find((p) => p.id === where.id) ?? null,
    findFirst: async ({ where = {} }: Row = {}) => state.players.find((p) => match(p, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.players.filter((p) => match(p, where)),
    count: async ({ where = {} }: Row = {}) => state.players.filter((p) => match(p, where)).length,
    update: async ({ where, data }: Row) => {
      const p = state.players.find((x) => x.id === where.id)!;
      Object.assign(p, data);
      return p;
    },
    groupBy: async () => [],
  },
  playerAuditLog: { create: async () => ({}) },
  auditLog: { create: async () => ({}) },
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

jest.mock('../src/middleware/auth.middleware', () => {
  const actual = jest.requireActual('../src/middleware/auth.middleware');
  return {
    ...actual,
    authenticate: (req: Row, _res: Row, next: () => void) => {
      const id = req.headers['x-test-user'];
      const u = id ? state.users.find((x) => x.id === id) : null;
      if (u) req.user = { id: u.id, email: u.email, role: u.role, clubId: CLUB, currentClubId: CLUB, isActive: true };
      next();
    },
  };
});

import playerRoutes from '../src/routes/player.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/players', playerRoutes);
app.use(errorHandler);

const COACH = 'u-coach';          // HEAD_COACH membership, First Team ONLY
const PRESIDENT = 'u-president';  // CLUB_OWNER membership, club-wide
const P_FIRST = '11111111-1111-1111-1111-111111111111';
const P_U15 = '22222222-2222-2222-2222-222222222222';

const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(400);

beforeEach(() => {
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', kind: 'SENIOR', isActive: true },
    { id: T_U15, clubId: CLUB, name: 'U15', kind: 'ACADEMY_U15', isActive: true },
  ];
  state.users = [
    { id: COACH, email: 'c@familista.test', role: UserRole.HEAD_COACH, clubId: CLUB },
    { id: PRESIDENT, email: 'p@familista.test', role: UserRole.CLUB_ADMIN, clubId: CLUB },
  ];
  state.memberships = [
    { id: 'm1', userId: COACH, clubId: CLUB, teamId: T_FIRST, role: MembershipRole.HEAD_COACH, isActive: true, status: MembershipStatus.ACTIVE },
    { id: 'm2', userId: PRESIDENT, clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true, status: MembershipStatus.ACTIVE },
  ];
  state.players = [
    { id: P_FIRST, clubId: CLUB, teamId: T_FIRST, firstName: 'Own', lastName: 'Player', isActive: true, avatar: null },
    { id: P_U15, clubId: CLUB, teamId: T_U15, firstName: 'Other', lastName: 'Player', isActive: true, avatar: null },
  ];
});

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
function between(from: string, to: string): string {
  const a = APP.indexOf(from);
  const b = APP.indexOf(to, a + 1);
  expect(`${from} found: ${a > -1}`).toBe(`${from} found: true`);
  expect(`${to} after it: ${b > a}`).toBe(`${to} after it: true`);
  return APP.slice(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · the coach reads his own team\'s squad', () => {
  it('the roster read answers him, scoped to the team he works on', async () => {
    const res = await request(app).get('/players').set('x-test-user', COACH);
    expect(res.status).toBe(200);
    const ids = (res.body.data as Row[]).map((p) => p.id);
    expect(ids).toContain(P_FIRST);
    // And it is a team scope, not a club one: the U15 player is not in it.
    expect(ids).not.toContain(P_U15);
  });

  it('and the club-wide seed he is NOT entitled to is still refused', () => {
    // The cause of everything below. It is guarded, it stays guarded, and the
    // client stops treating a refusal as a failure to read.
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/transfer-market.routes.ts'), 'utf8');
    expect(routes).toContain("router.post('/bootstrap', tradeGuard, ctrl.bootstrapRoster);");
    expect(routes).toContain('const tradeGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2-4 · his own team\'s players are his; nobody else\'s are', () => {
  it('a photo on his own team\'s player is accepted', async () => {
    const res = await request(app).patch(`/players/${P_FIRST}`)
      .set('x-test-user', COACH).send({ avatar: PHOTO });
    expect(res.status).toBe(200);
    expect(res.body.data.avatar).toBe(PHOTO);
  });

  it('and a fresh read returns what was persisted', async () => {
    await request(app).patch(`/players/${P_FIRST}`).set('x-test-user', COACH).send({ avatar: PHOTO });
    const one = await request(app).get(`/players/${P_FIRST}`).set('x-test-user', COACH);
    expect(one.status).toBe(200);
    expect(one.body.data.avatar).toBe(PHOTO);
    const list = await request(app).get('/players').set('x-test-user', COACH);
    const row = (list.body.data as Row[]).find((p) => p.id === P_FIRST);
    expect(row && row.avatar).toBe(PHOTO);
  });

  it('another team\'s player is refused, and nothing about them changes', async () => {
    const res = await request(app).patch(`/players/${P_U15}`)
      .set('x-test-user', COACH).send({ avatar: PHOTO });
    expect(res.status).toBe(403);
    expect(state.players.find((p) => p.id === P_U15)!.avatar).toBeNull();
  });

  it('and the president keeps both, as she always had', async () => {
    for (const id of [P_FIRST, P_U15]) {
      const res = await request(app).patch(`/players/${id}`)
        .set('x-test-user', PRESIDENT).send({ avatar: PHOTO });
      expect(`${id} → ${res.status}`).toBe(`${id} → 200`);
    }
  });

  it('and the guards that decide all of this are untouched', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/player.routes.ts'), 'utf8');
    expect(routes).toContain("router.patch('/:id',            authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);");
    expect(routes).toContain("router.param('id', (req, res, next) => requirePlayerTeamAccess('id')(req, res, next));");
    const ctrl = fs.readFileSync(path.join(ROOT, 'src/controllers/player.controller.ts'), 'utf8');
    expect(ctrl).toContain('teamScope:     scope.unrestricted ? undefined : scope.teamIds,');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · a refused seed no longer fails the read', () => {
  /** The real `_thHydrate`, over a transport that answers as production did. */
  function hydrate(seedStatus: number | null) {
    const src = between('async function _thHydrate(opts) {', 'async function _thAllPlayers() {');
    const calls: string[] = [];
    const TH: Row = { state: 'idle', seedRefused: false };
    // eslint-disable-next-line no-new-func
    const fn = new Function('_TH', '_thApi', '_thUnwrap', '_thRefresh', '_thBootstrapPayload',
      '_thResetRoster', '_thCurrentClubId', 'window', `${src}\nreturn _thHydrate;`);
    return fn(
      TH,
      (method: string, url: string) => {
        calls.push(`${method} ${url}`);
        if (url.indexOf('/transfer-market/bootstrap') >= 0 && seedStatus) {
          const e: Row = new Error('Refused'); e.status = seedStatus;
          return Promise.reject(e);
        }
        return Promise.resolve({ data: { seeded: true } });
      },
      (r: Row) => (r && r.data !== undefined ? r.data : r),
      async () => { calls.push('refresh'); },
      () => [],
      () => { TH.byTeam = {}; },
      () => CLUB,
      {},
    )().then((out: unknown) => ({ out, calls, TH }));
  }

  it('a 403 on the seed still reaches the roster, and the session is ready', async () => {
    const { calls, TH } = await hydrate(403);
    expect(calls).toContain('refresh');
    expect(TH.state).toBe('ready');
    expect(TH.seedRefused).toBe(true);
    // Nothing was seeded, and it does not claim to have been.
    expect(TH.seeded).toBe(false);
  });

  it('and a session that IS entitled to seed still seeds', async () => {
    const { calls, TH } = await hydrate(null);
    expect(calls[0]).toBe('POST /transfer-market/bootstrap');
    expect(TH.seeded).toBe(true);
    expect(TH.state).toBe('ready');
    expect(TH.seedRefused).toBe(false);
  });

  it('a real failure is still a failure — only a refusal is tolerated', async () => {
    for (const status of [500, 502, 0]) {
      const { TH } = await hydrate(status || 1);
      expect(`status ${status} → ${TH.state}`).toBe(`status ${status} → failed`);
    }
  });

  it('and that is what unblocks the writes, which check exactly this', () => {
    // Both writers decline to send a PATCH for a session that is not ready. It
    // was the seed's 403 that made a legitimate coach never ready.
    expect(APP).toContain("function _thIsHydrated() { return !!(typeof _TH !== 'undefined' && _TH && _TH.state === 'ready'); }");
    const sq = between('function _sqPersistPlayer(p, patch) {', 'function sqDeleteConfirm(id) {');
    expect(sq).toContain("if (!(typeof _thIsHydrated === 'function' && _thIsHydrated())) return;");
    const at = between('function _atPersistPhoto(playerId, dataUrl) {', 'function _atOverlay(id) {');
    expect(at).toContain("_thIsHydrated()");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6-8 · the answer that is written is the one the server gave', () => {
  /** The real `_atPersistPhoto`, with the transport and the screen observed. */
  function persister(respond: (id: string) => Promise<Row>) {
    const src = between('var _AT_PHOTO_SEQ = {};', 'function _atOverlay(id) {');
    const toasts: string[] = [];
    const overlay: Row = { [P_FIRST]: { photo: 'old' } };
    const State: Row = { players: [{ id: P_FIRST, avatar: 'old' }] };
    // eslint-disable-next-line no-new-func
    const fn = new Function('_thApi', '_thIsHydrated', 'showToast', '_atOverlay', '_atSave',
      'AT', 'window', 'State',
      `${src}\nreturn _atPersistPhoto;`);
    const run = fn(
      (_m: string, url: string) => respond(url.split('/').pop() as string),
      () => true,
      (msg: string) => toasts.push(msg),
      () => overlay,
      () => {},
      { active: 'u15' },
      { State },
      State,
    );
    return { run, toasts, overlay, State };
  }

  it('the client is updated from the persisted row, not from what it sent', async () => {
    // The server normalises what it stores; the screen must show that, not the
    // payload the browser happened to send.
    const h = persister(async () => ({ data: { id: P_FIRST, avatar: 'STORED', number: 9 } }));
    await h.run(P_FIRST, 'SENT');
    expect(h.overlay[P_FIRST].photo).toBe('STORED');
    expect(h.State.players[0].avatar).toBe('STORED');
    expect(h.State.players[0].number).toBe(9);
    expect(h.toasts).toEqual(['Photo updated']);
  });

  it('a failed PATCH is surfaced and never reported as saved', async () => {
    const h = persister(async () => { const e: Row = new Error('Forbidden'); e.status = 403; throw e; });
    await h.run(P_FIRST, 'SENT');
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain('Photo not saved');
    expect(h.toasts[0]).not.toContain('updated');
    // And nothing was written from a write that did not happen.
    expect(h.overlay[P_FIRST].photo).toBe('old');
    expect(h.State.players[0].avatar).toBe('old');
  });

  it('a slower earlier save cannot land on top of a faster later one', async () => {
    const gates: Array<(v: Row) => void> = [];
    const h = persister(() => new Promise<Row>((resolve) => { gates.push(resolve); }));
    const first = h.run(P_FIRST, 'FIRST');
    const second = h.run(P_FIRST, 'SECOND');
    // The second answers first, then the stale first one arrives.
    gates[1]({ data: { id: P_FIRST, avatar: 'SECOND' } });
    await second;
    gates[0]({ data: { id: P_FIRST, avatar: 'FIRST' } });
    await first;
    expect(h.overlay[P_FIRST].photo).toBe('SECOND');
    expect(h.State.players[0].avatar).toBe('SECOND');
    // And only the winner spoke.
    expect(h.toasts).toEqual(['Photo updated']);
  });

  it('and a stale refusal cannot contradict a save that already succeeded', async () => {
    const gates: Array<{ ok: (v: Row) => void; no: (e: Row) => void }> = [];
    const h = persister(() => new Promise<Row>((ok, no) => { gates.push({ ok, no: no as (e: Row) => void }); }));
    const first = h.run(P_FIRST, 'FIRST');
    const second = h.run(P_FIRST, 'SECOND');
    gates[1].ok({ data: { id: P_FIRST, avatar: 'SECOND' } });
    await second;
    const e: Row = new Error('Forbidden'); e.status = 403;
    gates[0].no(e);
    await first;
    expect(h.overlay[P_FIRST].photo).toBe('SECOND');
    expect(h.toasts).toEqual(['Photo updated']);
  });

  it('and none of this decides anything about who may do it', () => {
    const at = between('var _AT_PHOTO_SEQ = {};', 'function _atOverlay(id) {');
    expect(at).not.toMatch(/CLUB_ADMIN|HEAD_COACH|SUPER_ADMIN|CLUB_OWNER|effectiveAccess|currentClubRole/);
    const hyd = between('async function _thHydrate(opts) {', 'async function _thAllPlayers() {');
    expect(hyd).not.toMatch(/CLUB_ADMIN|HEAD_COACH|SUPER_ADMIN|CLUB_OWNER|effectiveAccess|currentClubRole/);
  });
});
