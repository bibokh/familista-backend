/**
 * tests/navigation-effective-access.unit.test.ts
 *
 * The sidebar is built from what somebody may reach, not from what they are called.
 *
 * A head coach hired for the first team was offered People & Access, the Coach
 * Market, the staff directory, the Academy and the transfer market — every club
 * module, because the workspace navigation was a fixed list and the only
 * question it asked was whether a club was open.
 *
 * The navigation now renders from capabilities the server derives, in
 * /me/context, from the same services that gate the matching requests:
 * `hasClubWideManageAuthority` and `privateTeamScope` from the team-access
 * service, `isPlatformOwner` from access-levels, and the CLUB_ADMIN membership
 * rank that `requireMembership` uses. No screen asks "is this a HEAD_COACH?".
 *
 * Two things this file is careful about.
 *
 * It is presentation. Every route behind every module still checks for itself,
 * and the direct-URL denials proved in team-scoped-coach-surfaces are re-proved
 * here unchanged — hiding a door is not locking it, and the lock is what keeps
 * people out.
 *
 * And an unknown capability reads as false. A sidebar drawn before the context
 * lands offers the one module everybody has, not all of them.
 */

import fs from 'fs';
import path from 'path';
import { MembershipRole, MembershipStatus, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const OTHER_CLUB = 'club-elsewhere';
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';
const T_U23 = 'team-u23';

const state = {
  users: [] as Row[],
  memberships: [] as Row[],
  clubs: [] as Row[],
  teams: [] as Row[],
  platformAdmins: [] as Row[],
  audits: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('in' in v) return ((v as Row).in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const clubOf = (id: string) => state.clubs.find((c) => c.id === id) ?? null;

const db: Row = {
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      return u ? { ...u, currentClub: clubOf(u.currentClubId), currentTeam: null } : null;
    },
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
  },
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships
      .filter((m) => match(m, where))
      .map((m) => ({ ...m, club: clubOf(m.clubId), team: state.teams.find((t) => t.id === m.teamId) ?? null })),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  club: { findUnique: async ({ where }: Row) => clubOf(where.id) },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => {
      const ids: string[] | null = where.id && where.id.in ? where.id.in : null;
      return state.teams.filter((t) => (!ids || ids.includes(t.id)) && (!where.clubId || t.clubId === where.clubId));
    },
  },
  player: { groupBy: async () => [] },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getContext, switchContext } from '../src/services/context.service';
import * as teamAccess from '../src/identity/team-access.service';
import { assertPlatformOwner } from '../src/platform/system.service';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const COACH = 'u-coach';          // HEAD_COACH, First Team only
const ACADEMY = 'u-academy';      // YOUTH_COACH, U15 only
const MULTI = 'u-multi';          // ANALYST, First Team + U23
const PRESIDENT = 'u-president';  // CLUB_OWNER, club-wide
const OWNER = 'u-owner';          // platform owner

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: OTHER_CLUB, name: 'Another Club', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true },
    { id: T_U15, clubId: CLUB, name: 'U15', shortName: null, kind: 'ACADEMY_U15', isActive: true },
    { id: T_U23, clubId: CLUB, name: 'U23', shortName: null, kind: 'ACADEMY_U23', isActive: true },
  ];
  const user = (id: string, role: UserRole) => ({
    id, email: `${id}@familista.test`, role, clubId: CLUB,
    currentClubId: CLUB, currentTeamId: null,
  });
  state.users = [
    user(COACH, UserRole.HEAD_COACH), user(ACADEMY, UserRole.COACH),
    user(MULTI, UserRole.COACH), user(PRESIDENT, UserRole.CLUB_ADMIN),
    user(OWNER, UserRole.CLUB_ADMIN),
  ];
  const m = (id: string, userId: string, teamId: string | null, role: MembershipRole) => ({
    id, userId, clubId: CLUB, teamId, role, isActive: true,
    status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null,
  });
  state.memberships = [
    m('m-coach', COACH, T_FIRST, MembershipRole.HEAD_COACH),
    m('m-academy', ACADEMY, T_U15, MembershipRole.YOUTH_COACH),
    m('m-multi-a', MULTI, T_FIRST, MembershipRole.ANALYST),
    m('m-multi-b', MULTI, T_U23, MembershipRole.ANALYST),
    m('m-president', PRESIDENT, null, MembershipRole.CLUB_OWNER),
  ];
  state.platformAdmins = [{ userId: OWNER, isActive: true, role: 'OWNER' }];
  state.audits = [];
});

/** The real buildWorkspaceSidebar, run against one set of capabilities. */
function sidebarFor(effectiveAccess: Row | null): string[] {
  const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('(function () {\n  function _boot()'));
  const access = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));
  let html = '';
  const slot = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } };
  // The slice also carries the capability sweep, which installs an observer and a
  // capture-phase click backstop on load. Give it the two APIs it reaches for.
  const doc = {
    getElementById: (id: string) => (id === 'workspace-nav-items' ? slot : null),
    querySelectorAll: () => [] as unknown[],
    addEventListener: () => {},
    readyState: 'complete',
    body: null,
  };
  const St = { context: { effectiveAccess } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'State', 't',
    `${access}\n${config}\nreturn buildWorkspaceSidebar;`);
  fn(doc, { State: St }, St, (k: string) => k)();
  return [...html.matchAll(/data-nav="([^"]+)"/g)].map((mm) => mm[1]);
}

const sidebarOf = async (userId: string) => sidebarFor((await getContext(userId)).effectiveAccess as Row);

// ─────────────────────────────────────────────────────────────────────────────
describe('1-6 · a First-Team-only head coach', () => {
  it('sees the football modules for their team, and only those', async () => {
    // Transfers, the staff directory and the league were added deliberately in
    // the pass that followed this one: scouting, the colleagues beside them and
    // the competition their team plays in are a coach's work. What they still
    // do not get is administering any of it, which
    // head-coach-capability-model pins alongside this.
    expect(await sidebarOf(COACH)).toEqual([
      'club-home', 'squad', 'training', 'video-intelligence',
      'transfers', 'coach-market', 'coaches', 'familista-league', 'match-center',
    ]);
  });

  it('2 · does not see People & Access', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.canManagePeople).toBe(false);
    expect(await sidebarOf(COACH)).not.toContain('people-access');
  });

  it('3 · sees the Coach Market in limited mode, and administers no staff through it', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    // It was withheld until the shortlist was opened to him. Now the module is
    // reachable because he may keep the club's watchlist and has to be able to
    // reach the people on it — and everything that commits the club is
    // governed one control at a time, by the capability below.
    // coach-market-limited-mode pins what is drawn inside it.
    expect(a.canShortlist).toBe(true);
    expect(a.canAccessCoachMarket).toBe(true);
    expect(await sidebarOf(COACH)).toContain('coach-market');
    // The staff DIRECTORY is theirs, scoped to their own teams; hiring,
    // moving and releasing is not — through either door.
    expect(a.canAccessStaffDirectory).toBe(true);
    expect(a.canAdministerStaff).toBe(false);
    expect(a.hasClubWideManageAuthority).toBe(false);
  });

  it('and may scout in Transfers without trading on the club\'s behalf', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.canAccessTransfers).toBe(true);
    expect(a.canAdministerTransfers).toBe(false);
    expect(await sidebarOf(COACH)).toContain('transfers');
  });

  it('4 · does not see the Academy without an academy membership', async () => {
    expect((await getContext(COACH)).effectiveAccess.canAccessAcademy).toBe(false);
    expect(await sidebarOf(COACH)).not.toContain('academy');

    // And an academy coach does, from the assignment rather than a role name.
    const academy = await getContext(ACADEMY);
    expect(academy.effectiveAccess.canAccessAcademy).toBe(true);
    expect(await sidebarOf(ACADEMY)).toContain('academy');
    // Still not the club's screens, though: an academy side is a team.
    expect(await sidebarOf(ACADEMY)).not.toContain('people-access');
  });

  it('5 · is scoped to their own team, and named no other', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.effectiveAccess.authorizedTeamIds).toEqual([T_FIRST]);
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id)).toEqual([T_FIRST]);
    for (const other of [T_U15, T_U23]) {
      expect(`${other}: ${ctx.effectiveAccess.authorizedTeamIds.includes(other)}`).toBe(`${other}: false`);
    }
  });

  it('6 · has no all-teams scope with exactly one team assigned', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    expect(ctx.effectiveAccess.hasClubWideManageAuthority).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('7-9 · and everybody else keeps what is theirs', () => {
  it('7 · the president still gets the club-management navigation', async () => {
    const ctx = await getContext(PRESIDENT);
    expect(ctx.effectiveAccess.canManagePeople).toBe(true);
    expect(ctx.effectiveAccess.hasClubWideManageAuthority).toBe(true);
    expect(await sidebarOf(PRESIDENT)).toEqual([
      'club-home', 'squad', 'training', 'academy', 'video-intelligence',
      'transfers', 'coach-market', 'coaches', 'familista-league', 'match-center', 'people-access',
    ]);
    // And still no platform authority: owning a club is not owning Familista.
    expect(ctx.effectiveAccess.isPlatformOwner).toBe(false);
  });

  it('8 · the platform owner is still the platform owner', async () => {
    const ctx = await getContext(OWNER);
    expect(ctx.effectiveAccess.isPlatformOwner).toBe(true);
    await expect(assertPlatformOwner({ userId: OWNER, clubId: CLUB, role: UserRole.CLUB_ADMIN }))
      .resolves.toBeUndefined();
    // The SYSTEM door is on the landing page, drawn from whoami, and is not a
    // club module — it is in neither sidebar.
    expect(APP).toContain('function _ownerHomeForPlatformOwner');
    expect(sidebarFor(ctx.effectiveAccess as Row)).not.toContain('system');
  });

  it('9 · multi-team staff see exactly their teams', async () => {
    const ctx = await getContext(MULTI);
    expect(ctx.effectiveAccess.authorizedTeamIds.sort()).toEqual([T_FIRST, T_U23].sort());
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    expect(ctx.effectiveAccess.authorizedTeamIds).not.toContain(T_U15);
    // U23 is an academy side, so this analyst does reach the academy workspace
    // — from the assignment, which is the point.
    expect(ctx.effectiveAccess.canAccessAcademy).toBe(true);
    expect(ctx.effectiveAccess.canManagePeople).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('10 · and the server still refuses, exactly as it did', () => {
  const asCoach = () => ({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH });

  it('a hidden module is not a locked one — the lock is still the route', async () => {
    // People & Access: the route wants a CLUB_ADMIN-or-stronger membership.
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/membership.routes.ts'), 'utf8');
    expect(routes).toContain("requireMembership('CLUB_ADMIN')");
    // Club creation: platform owner only.
    await expect(assertPlatformOwner({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH }))
      .rejects.toThrow();
  });

  it('and the coach still cannot reach another team or another club', async () => {
    await expect(switchContext({ userId: COACH }, CLUB, T_U15)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, CLUB, T_U23)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, OTHER_CLUB, null)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, CLUB, T_FIRST)).resolves.toBeTruthy();

    for (const other of [T_U15, T_U23]) {
      await expect(teamAccess.assertCanViewTeamPrivate(asCoach(), other)).rejects.toThrow();
    }
    expect((await teamAccess.accessForTeam(asCoach(), T_FIRST)).canManage).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the navigation is derived, not declared', () => {
  it('no sidebar entry is decided by a role name', () => {
    const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar'));
    for (const role of ['HEAD_COACH', 'CLUB_OWNER', 'CLUB_ADMIN', 'ANALYST', 'SUPER_ADMIN']) {
      expect(`${role} in the nav config: ${config.includes(role)}`).toBe(`${role} in the nav config: false`);
    }
    // What it reads instead.
    expect(config).toContain("requires: 'canManagePeople',");
    expect(config).toContain("requires: 'canAccessAcademy',");
  });

  it('and every capability it asks for is one the server actually sends', async () => {
    const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar'));
    const asked = [...config.matchAll(/requires: '([^']+)'/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(0);
    const sent = Object.keys((await getContext(PRESIDENT)).effectiveAccess);
    expect([...new Set(asked)].filter((c) => !sent.includes(c))).toEqual([]);
  });

  it('and an unknown capability offers less rather than more', () => {
    // A cold session, or a context read that failed. Only the module every
    // club member has.
    expect(sidebarFor(null)).toEqual(['club-home']);
    expect(sidebarFor({})).toEqual(['club-home']);
    const helper = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));
    expect(helper).toContain('return !!(a && a[capability]);');
    expect(helper).toContain('catch (_) { return false; }');
  });

  it('and typing the URL of a hidden module does not open it either', () => {
    const nav = APP.slice(APP.indexOf('var _navItem = CLUB_NAV_ITEMS'), APP.indexOf('var _navItem = CLUB_NAV_ITEMS') + 600);
    expect(nav).toContain("!_access(_navItem.requires)");
    expect(nav).toContain("page = 'club-home';");
  });
});
