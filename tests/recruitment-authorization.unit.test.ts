/**
 * tests/recruitment-authorization.unit.test.ts
 *
 * Recruitment is the club's decision, and the API now says so.
 *
 * The transfer market, the coach market and the club's own staff routes each
 * guarded their writes with `authorize('SUPER_ADMIN','CLUB_ADMIN','MANAGER',
 * 'HEAD_COACH')` — a check on `User.role`, the account-level field. An invited
 * head coach's account role IS HEAD_COACH, because that is what the invitation
 * flow assigns so the football routes work. So a coach hired to run the first
 * team could, with nothing but curl:
 *
 *   · list the club's players for transfer, delist them, bid at auction,
 *     publish to the open market, accept and counter offers, rewrite contracts;
 *   · open approaches to another club's staff, publish the club's recruitment
 *     needs, negotiate them and accept;
 *   · add staff to the club, move them between teams, and release them —
 *     membership changes, made through a different door than People & Access.
 *
 * Account role cannot tell a CLUB's head coach from ONE TEAM's head coach. The
 * membership can: a club-wide membership carries no teamId, a team-scoped one
 * does. So each guard now asks the two questions the codebase already has
 * mechanisms for — `requireMembership(minRole)` for how senior, and
 * `requireClubWideManage()` for whether it is the club's authority or a team's.
 *
 * These tests drive the REAL routers over HTTP. Nothing here reads the
 * frontend, and nothing here would pass because a screen hid a button.
 */

import express from 'express';
import request from 'supertest';
import { MembershipRole, MembershipStatus, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';

const state = { users: [] as Row[], memberships: [] as Row[], teams: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
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
    findMany: async ({ where = {} }: Row = {}) => {
      const ids: string[] | null = where.id && where.id.in ? where.id.in : null;
      return state.teams.filter((t) => (!ids || ids.includes(t.id)) && (!where.clubId || t.clubId === where.clubId));
    },
  },
  player: { groupBy: async () => [] },
  user: { findUnique: async ({ where }: Row) => state.users.find((u) => u.id === where.id) ?? null },
  // A refusal records itself. Fire-and-forget in the source, so a missing
  // model here surfaces as a 500 on the DENIAL path only — which is exactly
  // how it was found.
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

// The handlers are not under test — the guards in front of them are. Each one
// answers 200, so a 200 means "the request reached the controller" and nothing
// else. Anything a real controller would have done is irrelevant here.
const ok = (_req: express.Request, res: express.Response) => res.status(200).json({ reached: true });
const allOk = () => new Proxy({}, { get: () => ok });
jest.mock('../src/controllers/transfer-market.controller', () => allOk());
jest.mock('../src/controllers/staff-market.controller', () => allOk());
jest.mock('../src/controllers/coaches.controller', () => allOk());

// Authentication is not under test either. The identity arrives in a header so
// each case can be one line, and it is the SAME shape the real middleware sets.
jest.mock('../src/middleware/auth.middleware', () => {
  const actual = jest.requireActual('../src/middleware/auth.middleware');
  return {
    ...actual,
    authenticate: (req: Row, _res: Row, next: () => void) => {
      const id = req.headers['x-test-user'];
      if (id) {
        const u = state.users.find((x) => x.id === id);
        if (u) req.user = { id: u.id, email: u.email, role: u.role, clubId: CLUB, isActive: true };
      }
      next();
    },
  };
});

import transferRoutes from '../src/routes/transfer-market.routes';
import staffMarketRoutes from '../src/routes/staff-market.routes';
import coachesRoutes from '../src/routes/coaches.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/transfers', transferRoutes);
app.use('/staff-market', staffMarketRoutes);
app.use('/coaches', coachesRoutes);
app.use(errorHandler);

const COACH = 'u-coach';              // HEAD_COACH membership, First Team ONLY
const ACADEMY = 'u-academy';          // YOUTH_COACH membership, U15 only
const ASSISTANT = 'u-assistant';      // ASSISTANT_COACH, club-wide
const CLUB_HEAD = 'u-club-head';      // HEAD_COACH membership, club-wide
const ADMIN = 'u-admin';              // CLUB_ADMIN, club-wide
const PRESIDENT = 'u-president';      // CLUB_OWNER, club-wide
const OWNER = 'u-owner';              // SUPER_ADMIN account

beforeEach(() => {
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', kind: 'SENIOR', isActive: true },
    { id: T_U15, clubId: CLUB, name: 'U15', kind: 'ACADEMY_U15', isActive: true },
  ];
  const user = (id: string, role: UserRole) => ({ id, email: `${id}@familista.test`, role, clubId: CLUB });
  state.users = [
    // Every one of these accounts carries an account role the OLD guard let
    // through. That is the point: the account role is unchanged and no longer
    // decides anything.
    user(COACH, UserRole.HEAD_COACH),
    user(ACADEMY, UserRole.HEAD_COACH),
    user(ASSISTANT, UserRole.HEAD_COACH),
    user(CLUB_HEAD, UserRole.HEAD_COACH),
    user(ADMIN, UserRole.CLUB_ADMIN),
    user(PRESIDENT, UserRole.CLUB_ADMIN),
    user(OWNER, UserRole.SUPER_ADMIN),
  ];
  const m = (id: string, userId: string, teamId: string | null, role: MembershipRole) => ({
    id, userId, clubId: CLUB, teamId, role, isActive: true,
    status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null,
  });
  state.memberships = [
    m('m-coach', COACH, T_FIRST, MembershipRole.HEAD_COACH),
    m('m-academy', ACADEMY, T_U15, MembershipRole.YOUTH_COACH),
    m('m-assistant', ASSISTANT, null, MembershipRole.ASSISTANT_COACH),
    m('m-club-head', CLUB_HEAD, null, MembershipRole.HEAD_COACH),
    m('m-admin', ADMIN, null, MembershipRole.CLUB_ADMIN),
    m('m-president', PRESIDENT, null, MembershipRole.CLUB_OWNER),
  ];
});

const call = (method: 'post' | 'patch' | 'put' | 'delete', url: string, as: string) =>
  (request(app) as Row)[method](url).set('x-test-user', as).send({});

/** Every write the transfer market exposes, as one representative per shape. */
const TRANSFER_WRITES: Array<[string, string]> = [
  ['post', '/transfers/listings'],
  ['delete', '/transfers/listings/l1'],
  ['post', '/transfers/bootstrap'],
  ['post', '/transfers/auctions'],
  ['post', '/transfers/auctions/l1/bids'],
  ['post', '/transfers/open-market'],
  ['post', '/transfers/listings/l1/purchase'],
  ['post', '/transfers/offers'],
  ['post', '/transfers/offers/o1/accept'],
  ['post', '/transfers/players/p1/contract/renew'],
  ['post', '/transfers/shortlist'],
  ['post', '/transfers/needs'],
  ['post', '/transfers/offer-to-clubs'],
];

const COACH_MARKET_WRITES: Array<[string, string]> = [
  ['post', '/staff-market/approaches'],
  ['post', '/staff-market/approaches/a1/counter'],
  ['post', '/staff-market/approaches/a1/accept'],
  ['post', '/staff-market/needs'],
  ['put', '/staff-market/shortlist/s1'],
  ['put', '/staff-market/notes/s1'],
  ['patch', '/staff-market/staff/s1'],
  ['post', '/staff-market/bootstrap'],
  ['post', '/staff-market/external'],
];

const STAFF_WRITES: Array<[string, string]> = [
  ['post', '/coaches/staff'],
  ['post', '/coaches/staff/s1/move'],
  ['post', '/coaches/staff/s1/release'],
  ['put', '/coaches/staff/s1/career'],
  ['delete', '/coaches/staff/s1/career/c1'],
  ['post', '/coaches/demo-staff'],
];

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · a First-Team-only head coach is refused every recruitment write', () => {
  it('cannot trade on the club\'s behalf, on any transfer route', async () => {
    for (const [method, url] of TRANSFER_WRITES) {
      const res = await call(method as 'post', url, COACH);
      expect(`${method.toUpperCase()} ${url} → ${res.status}`).toBe(`${method.toUpperCase()} ${url} → 403`);
    }
  });

  it('cannot recruit staff, on any coach-market route', async () => {
    for (const [method, url] of COACH_MARKET_WRITES) {
      const res = await call(method as 'post', url, COACH);
      expect(`${method.toUpperCase()} ${url} → ${res.status}`).toBe(`${method.toUpperCase()} ${url} → 403`);
    }
  });

  it('cannot add, move or release the club\'s staff', async () => {
    for (const [method, url] of STAFF_WRITES) {
      const res = await call(method as 'post', url, COACH);
      expect(`${method.toUpperCase()} ${url} → ${res.status}`).toBe(`${method.toUpperCase()} ${url} → 403`);
    }
  });

  it('and an academy coach is refused exactly the same, on the same grounds', async () => {
    for (const [method, url] of [...TRANSFER_WRITES, ...COACH_MARKET_WRITES, ...STAFF_WRITES]) {
      const res = await call(method as 'post', url, ACADEMY);
      expect(`${url} → ${res.status}`).toBe(`${url} → 403`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · the tier the modules always had is the tier they still have', () => {
  it('a club-wide head coach still trades and still recruits', async () => {
    for (const [method, url] of [...TRANSFER_WRITES, ...COACH_MARKET_WRITES]) {
      const res = await call(method as 'post', url, CLUB_HEAD);
      expect(`${url} → ${res.status}`).toBe(`${url} → 200`);
    }
  });

  it('but does NOT run the club\'s staff — that is administration', async () => {
    // Adding, moving and releasing staff changes memberships. It takes what
    // People & Access takes, and a head coach is not a club administrator.
    for (const [method, url] of STAFF_WRITES) {
      const res = await call(method as 'post', url, CLUB_HEAD);
      expect(`${url} → ${res.status}`).toBe(`${url} → 403`);
    }
  });

  it('and a club-wide assistant coach is still kept out, as before', async () => {
    // The old guard listed exactly four account roles and excluded the
    // assistant. Being club-wide does not promote them.
    for (const [method, url] of [...TRANSFER_WRITES, ...COACH_MARKET_WRITES, ...STAFF_WRITES]) {
      const res = await call(method as 'post', url, ASSISTANT);
      expect(`${url} → ${res.status}`).toBe(`${url} → 403`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · and legitimate club authority is untouched', () => {
  it('the president keeps everything', async () => {
    for (const [method, url] of [...TRANSFER_WRITES, ...COACH_MARKET_WRITES, ...STAFF_WRITES]) {
      const res = await call(method as 'post', url, PRESIDENT);
      expect(`${url} → ${res.status}`).toBe(`${url} → 200`);
    }
  });

  it('a club administrator keeps everything a club administrator had', async () => {
    for (const [method, url] of [...TRANSFER_WRITES, ...COACH_MARKET_WRITES, ...STAFF_WRITES]) {
      const res = await call(method as 'post', url, ADMIN);
      expect(`${url} → ${res.status}`).toBe(`${url} → 200`);
    }
  });

  it('and the platform owner passes both guards, as SUPER_ADMIN always has', async () => {
    // No membership row at all for this account, deliberately: SUPER_ADMIN
    // short-circuits requireMembership and hasClubWideManageAuthority alike.
    // It is why SUPER_ADMIN was added to the old guard, and it still holds.
    expect(state.memberships.find((m) => m.userId === OWNER)).toBeUndefined();
    for (const [method, url] of [...TRANSFER_WRITES, ...COACH_MARKET_WRITES, ...STAFF_WRITES]) {
      const res = await call(method as 'post', url, OWNER);
      expect(`${url} → ${res.status}`).toBe(`${url} → 200`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · reading is unchanged, and so is the coach\'s own workspace', () => {
  it('the market is still readable by the whole club', async () => {
    for (const url of ['/transfers/market', '/transfers/discover', '/transfers/feed',
      '/staff-market/discover', '/staff-market/summary', '/coaches/directory']) {
      const res = await request(app).get(url).set('x-test-user', COACH);
      expect(`GET ${url} → ${res.status}`).toBe(`GET ${url} → 200`);
    }
  });

  it('and their own team\'s staff list is still theirs to read', async () => {
    const mine = await request(app).get(`/coaches/teams/${T_FIRST}/staff`).set('x-test-user', COACH);
    expect(`own team → ${mine.status}`).toBe('own team → 200');
    // While another team's is refused — by the team scope that was already
    // there, and is not what this change touched.
    const other = await request(app).get(`/coaches/teams/${T_U15}/staff`).set('x-test-user', COACH);
    expect(`other team → ${other.status}`).toBe('other team → 403');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · and no route decides this from the account field any more', () => {
  it('the three routers ask the membership, not User.role', () => {
    /* eslint-disable global-require */
    const fs = require('fs');
    const path = require('path');
    for (const file of ['transfer-market.routes.ts', 'staff-market.routes.ts', 'coaches.routes.ts']) {
      const src: string = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      // The old mechanism is gone from the code — it survives only in the
      // comments that explain why it went.
      expect(`${file} calls authorize(): ${/\bauthorize\s*\(/.test(code)}`).toBe(`${file} calls authorize(): false`);
      expect(`${file} asks the membership: ${code.includes('requireMembership(')}`).toBe(`${file} asks the membership: true`);
      expect(`${file} asks club-wide: ${code.includes('requireClubWideManage()')}`).toBe(`${file} asks club-wide: true`);
    }
  });

  it('and the club-wide guard adds no rule of its own', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'team-scope.middleware.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function requireClubWideManage'), src.indexOf('* The gate for a route addressed by PLAYER'));
    // It defers to the service. No roles listed, no ranks compared, no second
    // permission model beside the one that already exists.
    expect(fn).toContain('teamAccess.assertClubWideManageAuthority(actorOfRequest(req))');
    expect(fn).not.toMatch(/CLUB_ADMIN|HEAD_COACH|SUPER_ADMIN|MANAGER/);
  });
});
