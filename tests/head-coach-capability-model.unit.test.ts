/**
 * tests/head-coach-capability-model.unit.test.ts
 *
 * A head coach does football work across the club, and administers none of it.
 *
 * The previous pass drew the line in the wrong place. Transfers, the staff
 * directory and the Familista League were all gated on club-wide authority, so
 * a head coach hired for the first team lost the transfer market he scouts in,
 * the colleagues he works beside, and the league his team plays in. Those are
 * his job. What is not his job is selling the club's players, hiring its staff,
 * or administering the competition.
 *
 * So each of those three modules now answers two questions instead of one:
 *
 *     canAccessTransfers       any authorised team   ·  canAdministerTransfers
 *     canAccessStaffDirectory  any authorised team   ·  canAdministerStaff
 *     canAccessLeague          any authorised team   ·  canAdministerLeague
 *
 * and the right-hand column is mirrored from the guard that actually decides —
 * `[requireMembership(HEAD_COACH), requireClubWideManage()]` for the transfer
 * market, `[requireMembership(CLUB_ADMIN), requireClubWideManage()]` for staff,
 * and platform authority for the league, which belongs to no club at all.
 *
 * The Coach Market is the one module with no read-only tier, because browsing
 * staff IS how an approach begins, so it stays club-wide and a head coach is
 * not offered it.
 *
 * Nothing here is security. The write denials proved in
 * recruitment-authorization are re-proved below untouched, and the staff
 * directory — which used to ignore its actor entirely and return every team in
 * the club — is now scoped server-side, because a module you are shown must
 * not hand you another team's roster.
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
  users: [] as Row[], memberships: [] as Row[], clubs: [] as Row[], teams: [] as Row[],
  platformAdmins: [] as Row[], audits: [] as Row[], staffProfiles: [] as Row[],
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
      return u ? { ...u, currentClub: u.currentClubId ? clubOf(u.currentClubId) : null, currentTeam: null } : null;
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
      .map((m) => ({
        ...m,
        club: clubOf(m.clubId),
        team: state.teams.find((t) => t.id === m.teamId) ?? null,
        user: state.users.find((u) => u.id === m.userId) ?? null,
      })),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  club: {
    findUnique: async ({ where }: Row) => clubOf(where.id),
    findMany: async ({ where = {} }: Row = {}) => state.clubs.filter((c) => match(c, where)),
  },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => {
      const ids: string[] | null = where.id && where.id.in ? where.id.in : null;
      return state.teams
        .filter((t) =>
          (!ids || ids.includes(t.id))
          && (where.clubId === undefined || t.clubId === where.clubId)
          && (where.isActive === undefined || t.isActive === where.isActive))
        // The real select includes the club; the directory groups by it.
        .map((t) => ({ ...t, club: clubOf(t.clubId) }));
    },
  },
  player: { groupBy: async () => [] },
  staffProfile: { findMany: async () => state.staffProfiles },
  staffEngagement: { findMany: async () => [] },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getContext, switchContext } from '../src/services/context.service';
import * as teamAccess from '../src/identity/team-access.service';
import { coachesDirectory } from '../src/staff-market/staff-market.service';
import { assertPlatformOwner } from '../src/platform/system.service';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const COACH = 'u-coach';        // HEAD_COACH, First Team only
const ACADEMY = 'u-academy';    // YOUTH_COACH, U15 only
const MULTI = 'u-multi';        // ANALYST, First Team + U23
const PRESIDENT = 'u-president';
const OWNER = 'u-owner';
const U15_COACH = 'u-u15-coach';   // somebody else's staff, in the academy

const m = (id: string, userId: string, teamId: string | null, role: MembershipRole) => ({
  id, userId, clubId: CLUB, teamId, role, isActive: true,
  status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null,
});

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: OTHER_CLUB, name: 'Somewhere Else', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true, ageMin: null, ageMax: null, emblem: null, color: null },
    { id: T_U15, clubId: CLUB, name: 'U15', shortName: null, kind: 'ACADEMY_U15', isActive: true, ageMin: null, ageMax: 15, emblem: null, color: null },
    { id: T_U23, clubId: CLUB, name: 'U23', shortName: null, kind: 'ACADEMY_U23', isActive: true, ageMin: null, ageMax: 23, emblem: null, color: null },
  ];
  const user = (id: string, role: UserRole) => ({
    id, email: `${id}@familista.test`, role, clubId: CLUB,
    currentClubId: CLUB, currentTeamId: null, isActive: true,
    firstName: id, lastName: 'Test', avatar: null,
  });
  state.users = [
    user(COACH, UserRole.HEAD_COACH), user(ACADEMY, UserRole.COACH), user(MULTI, UserRole.COACH),
    user(PRESIDENT, UserRole.CLUB_ADMIN), user(OWNER, UserRole.CLUB_ADMIN), user(U15_COACH, UserRole.COACH),
  ];
  state.memberships = [
    m('m-coach', COACH, T_FIRST, MembershipRole.HEAD_COACH),
    m('m-academy', ACADEMY, T_U15, MembershipRole.YOUTH_COACH),
    m('m-multi-a', MULTI, T_FIRST, MembershipRole.ANALYST),
    m('m-multi-b', MULTI, T_U23, MembershipRole.ANALYST),
    m('m-president', PRESIDENT, null, MembershipRole.CLUB_OWNER),
    m('m-u15-coach', U15_COACH, T_U15, MembershipRole.HEAD_COACH),
  ];
  state.platformAdmins = [{ userId: OWNER, isActive: true, role: 'OWNER' }];
  state.audits = [];
  state.staffProfiles = [];
});

/** The real buildWorkspaceSidebar, run against one person's real capabilities. */
function sidebarFor(effectiveAccess: Row | null): string[] {
  const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('(function () {\n  function _boot()'));
  const access = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));
  let html = '';
  const slot = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } };
  const doc = { getElementById: (id: string) => (id === 'workspace-nav-items' ? slot : null) };
  const St = { context: { effectiveAccess } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'State', 't',
    `${access}\n${config}\nreturn buildWorkspaceSidebar;`);
  fn(doc, { State: St }, St, (k: string) => k)();
  return [...html.matchAll(/data-nav="([^"]+)"/g)].map((mm) => mm[1]);
}
const sidebarOf = async (userId: string) => sidebarFor((await getContext(userId)).effectiveAccess as Row);

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · the final navigation for a First-Team head coach', () => {
  it('is exactly Start, Squad, Training, Video, Transfers, Coaches, League, Match Center', async () => {
    expect(await sidebarOf(COACH)).toEqual([
      'club-home', 'squad', 'training', 'video-intelligence',
      'transfers', 'coaches', 'familista-league', 'match-center',
    ]);
  });

  it('and the three modules it gained are gained from the team, not the role', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.canAccessTransfers).toBe(true);
    expect(a.canAccessStaffDirectory).toBe(true);
    expect(a.canAccessLeague).toBe(true);
    // Each of them is the same question: do they work with any team here.
    expect(a.canAccessTeamWorkspace).toBe(true);
    expect(a.authorizedTeamIds).toEqual([T_FIRST]);

    // Somebody in the club with no team at all — a parent, a player — gains
    // none of them, which is what proves it is the team and not the club.
    state.memberships.push(m('m-parent', 'u-parent', null, MembershipRole.PARENT));
    state.users.push({
      id: 'u-parent', email: 'p@familista.test', role: UserRole.COACH, clubId: CLUB,
      currentClubId: CLUB, currentTeamId: null, isActive: true, firstName: 'P', lastName: 'T', avatar: null,
    });
    const parent = (await getContext('u-parent')).effectiveAccess;
    expect(parent.canAccessTransfers).toBe(false);
    expect(parent.canAccessLeague).toBe(false);
    expect(parent.canAccessStaffDirectory).toBe(false);
  });

  it('4 · and the Coach Market is not among them', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.canAccessCoachMarket).toBe(false);
    expect(await sidebarOf(COACH)).not.toContain('coach-market');
    // It follows club-wide authority, which they do not have — never the role.
    expect(a.hasClubWideManageAuthority).toBe(false);
  });

  it('5 · nor the Academy, People & Access, SYSTEM or club onboarding', async () => {
    const nav = await sidebarOf(COACH);
    for (const forbidden of ['academy', 'people-access', 'system', 'clubs']) {
      expect(`${forbidden}: ${nav.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.canAccessAcademy).toBe(false);
    expect(a.canManagePeople).toBe(false);
    expect(a.isPlatformOwner).toBe(false);
    await expect(assertPlatformOwner({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH })).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2-3 · access without administration', () => {
  it('the coach may work in the modules and administer none of them', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    expect({
      transfers: [a.canAccessTransfers, a.canAdministerTransfers],
      staff: [a.canAccessStaffDirectory, a.canAdministerStaff],
      league: [a.canAccessLeague, a.canAdministerLeague],
    }).toEqual({
      transfers: [true, false],
      staff: [true, false],
      league: [true, false],
    });
  });

  it('and every administer capability mirrors the guard that really decides', async () => {
    const president = (await getContext(PRESIDENT)).effectiveAccess;
    // Transfers: HEAD_COACH-or-stronger, club-wide. A president is both.
    expect(president.canAdministerTransfers).toBe(true);
    // Staff: CLUB_ADMIN-or-stronger, club-wide.
    expect(president.canAdministerStaff).toBe(true);
    // The league belongs to no club, so no club role administers it.
    expect(president.canAdministerLeague).toBe(false);
    expect((await getContext(OWNER)).effectiveAccess.canAdministerLeague).toBe(true);
  });

  it('a club-wide membership that is not senior enough administers neither', async () => {
    // An assistant coach across the club: club-wide, but below HEAD_COACH.
    state.memberships = [m('m-asst', COACH, null, MembershipRole.ASSISTANT_COACH)];
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.hasClubWideManageAuthority).toBe(true);   // they do run teams
    expect(a.canAdministerTransfers).toBe(false);      // but do not trade
    expect(a.canAdministerStaff).toBe(false);          // nor hire
  });

  it('and the write routes still refuse the coach, unchanged', async () => {
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/transfer-market.routes.ts'), 'utf8');
    const staff = fs.readFileSync(path.join(ROOT, 'src/routes/coaches.routes.ts'), 'utf8');
    expect(routes).toContain('const tradeGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
    expect(staff).toContain('const staffGuard = [requireMembership(MembershipRole.CLUB_ADMIN), requireClubWideManage()];');
    // The capability and the guard say the same thing about the same person.
    expect(await teamAccess.hasClubWideManageAuthority({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH }))
      .toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · the staff directory shows the coach their own team, and no other', () => {
  const actorOf = (userId: string, role: UserRole = UserRole.HEAD_COACH) => ({ userId, clubId: CLUB, role: role as string });

  it('a First-Team coach sees the first team and the club-wide group only', async () => {
    const out = await coachesDirectory(actorOf(COACH), { clubId: CLUB });
    const teams = out.groups.filter((g: Row) => g.teamId).map((g: Row) => g.teamId);
    expect(teams).toEqual([T_FIRST]);
    // The academy sides exist and are not in it — this is the whole point.
    expect(teams).not.toContain(T_U15);
    expect(teams).not.toContain(T_U23);
  });

  it('and no academy coach\'s name reaches them through it', async () => {
    const out = await coachesDirectory(actorOf(COACH), { clubId: CLUB });
    expect(JSON.stringify(out)).not.toContain(U15_COACH);
    expect(JSON.stringify(out)).not.toContain(ACADEMY);
  });

  it('multi-team staff see exactly their two teams', async () => {
    const out = await coachesDirectory(actorOf(MULTI, UserRole.COACH), { clubId: CLUB });
    const teams = out.groups.filter((g: Row) => g.teamId).map((g: Row) => g.teamId).sort();
    expect(teams).toEqual([T_FIRST, T_U23].sort());
    expect(teams).not.toContain(T_U15);
  });

  it('and somebody who runs the club still sees all of it', async () => {
    const out = await coachesDirectory(actorOf(PRESIDENT, UserRole.CLUB_ADMIN), { clubId: CLUB });
    const teams = out.groups.filter((g: Row) => g.teamId).map((g: Row) => g.teamId).sort();
    expect(teams).toEqual([T_FIRST, T_U15, T_U23].sort());
  });

  it('and the directory asks its actor, which it used not to', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/staff-market/staff-market.service.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function coachesDirectory'), src.indexOf('export async function coachesDirectory') + 2200);
    expect(fn).toContain('export async function coachesDirectory(actor: StaffActor');
    expect(fn).not.toContain('_actor: StaffActor');
    expect(fn).toContain('privateTeamScope(');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6-7 · and everyone else is where they were', () => {
  it('the president keeps the full club navigation', async () => {
    expect(await sidebarOf(PRESIDENT)).toEqual([
      'club-home', 'squad', 'training', 'academy', 'video-intelligence',
      'transfers', 'coach-market', 'coaches', 'familista-league', 'match-center', 'people-access',
    ]);
  });

  it('the platform owner is unchanged, and still the only league administrator', async () => {
    const a = (await getContext(OWNER)).effectiveAccess;
    expect(a.isPlatformOwner).toBe(true);
    expect(a.canAdministerLeague).toBe(true);
    await expect(assertPlatformOwner({ userId: OWNER, clubId: CLUB, role: UserRole.CLUB_ADMIN }))
      .resolves.toBeUndefined();
  });

  it('an academy coach gets the academy, and the same football modules', async () => {
    expect(await sidebarOf(ACADEMY)).toEqual([
      'club-home', 'squad', 'training', 'academy', 'video-intelligence',
      'transfers', 'coaches', 'familista-league', 'match-center',
    ]);
    expect((await getContext(ACADEMY)).effectiveAccess.canManagePeople).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('8 · and the server refuses everything it refused before', () => {
  const asCoach = () => ({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH });

  it('another team, another club, and another team\'s private content', async () => {
    await expect(switchContext({ userId: COACH }, CLUB, T_U15)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, CLUB, T_U23)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, OTHER_CLUB, null)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, CLUB, T_FIRST)).resolves.toBeTruthy();

    for (const other of [T_U15, T_U23]) {
      await expect(teamAccess.assertCanViewTeamPrivate(asCoach(), other)).rejects.toThrow();
      await expect(teamAccess.assertCanManageTeam(asCoach(), other)).rejects.toThrow();
    }
    expect((await teamAccess.accessForTeam(asCoach(), T_FIRST)).canManage).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the navigation is still derived rather than declared', () => {
  it('no role name decides a sidebar entry', () => {
    const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar'));
    for (const role of ['HEAD_COACH', 'CLUB_OWNER', 'CLUB_ADMIN', 'ANALYST', 'SUPER_ADMIN']) {
      expect(`${role}: ${config.includes(role)}`).toBe(`${role}: false`);
    }
  });

  it('and every capability the sidebar asks for is one the server sends', async () => {
    const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar'));
    const asked = [...config.matchAll(/requires: '([^']+)'/g)].map((mm) => mm[1]);
    const sent = Object.keys((await getContext(PRESIDENT)).effectiveAccess);
    expect([...new Set(asked)].filter((c) => !sent.includes(c))).toEqual([]);
    // And the league is no longer gated on running the club.
    expect(config).toContain("requires: 'canAccessLeague',");
    expect(config).not.toContain("requires: 'hasClubWideManageAuthority',");
  });

  it('and the ranking behind the capabilities is the one the guards use', () => {
    const ctx = fs.readFileSync(path.join(ROOT, 'src/services/context.service.ts'), 'utf8');
    // A second ranking table beside the middleware's is how a screen and its
    // route come to disagree. There was one; there is not now.
    expect(ctx).toContain("meetsMembershipRank");
    expect(ctx).not.toMatch(/const RANK = \[/);
  });
});
