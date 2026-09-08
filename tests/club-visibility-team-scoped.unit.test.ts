/**
 * tests/club-visibility-team-scoped.unit.test.ts
 *
 * Belonging to a club and running one are different things.
 *
 * A head coach with an active membership in "familista mail test", scoped to
 * the first team, signed in to a fresh session and was told:
 *
 *     No club yet — this account is not a member of any club
 *
 * while the team selector beside it said "First Team" and the page named the
 * club. Both halves came from the same /me/context reply, so the data was
 * never in doubt; what differed was WHEN each half was read.
 *
 * The landing page is built from two independent reads fired at once:
 * GET /system/whoami decides which landing to draw, GET /me/context supplies
 * the clubs it draws with. Only the first was awaited. whoami is a tiny query
 * and /me/context had just grown — team scope, club-wide authority, platform
 * authority, two extra team reads — so whoami began winning that race, the
 * club member's landing was built against a context that did not exist yet,
 * found no clubs, and said so. Nothing repainted it afterwards: the clubs
 * picker had been given a repaint when the context lands, and owner home never
 * had one. Hence a permanent "no club" beside a working selector.
 *
 * It was NOT a membership filter. `availableClubs` has always been built from
 * every active membership regardless of teamId, and the tests below prove it
 * still is — a team-scoped membership makes the parent club visible, exactly
 * as a club-wide one does. That distinction was never the bug, and nothing
 * here widens it: the same team-scoped person still has no club-wide
 * authority, no other team, and no way into another club.
 *
 * A second, quieter fault is fixed with it. Everything in the context was keyed
 * off `User.currentClubId`, which is null until somebody switches into a club —
 * so a newly invited member's first sign-in produced a context with no club at
 * all: no team scope, and capabilities computed as though they were in no club.
 * The club is now resolved from the memberships when the column is empty, which
 * can only ever pick a club those memberships already prove.
 */

import fs from 'fs';
import path from 'path';
import { MembershipRole, MembershipStatus, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const CLUB_B = 'club-second';
const OTHER_CLUB = 'club-elsewhere';
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';
const T_B_FIRST = 'team-b-first';

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
      if (!u) return null;
      return {
        ...u,
        currentClub: u.currentClubId ? clubOf(u.currentClubId) : null,
        currentTeam: null,
      };
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

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const COACH = 'u-coach';        // First Team only, has never switched club
const MULTI = 'u-multi';        // two teams in one club
const TWO_CLUBS = 'u-two';      // team-scoped in one club, club-wide in another
const PRESIDENT = 'u-president';
const ADMIN = 'u-admin';
const NOBODY = 'u-nobody';      // no memberships at all
const GONE = 'u-gone';          // memberships, none of them active

const m = (id: string, userId: string, clubId: string, teamId: string | null, role: MembershipRole, over?: Row) => ({
  id, userId, clubId, teamId, role, isActive: true,
  status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null, ...over,
});

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: CLUB_B, name: 'Second Club', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: OTHER_CLUB, name: 'Somewhere Else', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true },
    { id: T_U15, clubId: CLUB, name: 'U15', shortName: null, kind: 'ACADEMY_U15', isActive: true },
    { id: T_B_FIRST, clubId: CLUB_B, name: 'Second Club First Team', shortName: null, kind: 'SENIOR', isActive: true },
  ];
  const user = (id: string, role: UserRole, over?: Row) => ({
    id, email: `${id}@familista.test`, role,
    // `clubId` is set by the invitation flow; `currentClubId` is null until
    // somebody switches, which is the state a first sign-in is actually in.
    clubId: CLUB, currentClubId: null, currentTeamId: null, ...over,
  });
  state.users = [
    user(COACH, UserRole.HEAD_COACH),
    user(MULTI, UserRole.COACH),
    user(TWO_CLUBS, UserRole.COACH),
    user(PRESIDENT, UserRole.CLUB_ADMIN),
    user(ADMIN, UserRole.CLUB_ADMIN),
    user(NOBODY, UserRole.COACH),
    user(GONE, UserRole.COACH),
  ];
  state.memberships = [
    m('m-coach', COACH, CLUB, T_FIRST, MembershipRole.HEAD_COACH),
    m('m-multi-a', MULTI, CLUB, T_FIRST, MembershipRole.ANALYST),
    m('m-multi-b', MULTI, CLUB, T_U15, MembershipRole.ANALYST),
    m('m-two-a', TWO_CLUBS, CLUB, T_FIRST, MembershipRole.ASSISTANT_COACH),
    m('m-two-b', TWO_CLUBS, CLUB_B, null, MembershipRole.CLUB_ADMIN),
    m('m-president', PRESIDENT, CLUB, null, MembershipRole.CLUB_OWNER),
    m('m-admin', ADMIN, CLUB, null, MembershipRole.CLUB_ADMIN),
    m('m-gone', GONE, CLUB, T_FIRST, MembershipRole.HEAD_COACH,
      { isActive: false, status: MembershipStatus.REMOVED }),
  ];
  state.platformAdmins = [];
  state.audits = [];
});

// ─────────────────────────────────────────────────────────────────────────────
describe('1-4 · a team-scoped membership IS membership of the club', () => {
  it('1 · the parent club is visible with no club-wide membership anywhere', async () => {
    const ctx = await getContext(COACH);
    // The whole of the reported bug, at the layer that answers it.
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    expect(ctx.availableClubs[0].name).toBe('familista mail test');
    // And they hold no club-wide row: this is a team-scoped person.
    expect(state.memberships.filter((x) => x.userId === COACH && x.teamId === null)).toHaveLength(0);
  });

  it('2 · the context resolves to that club even before they have switched', async () => {
    // `User.currentClubId` is null — a first sign-in after accepting.
    expect(state.users.find((u) => u.id === COACH)!.currentClubId).toBeNull();
    const ctx = await getContext(COACH);
    expect(ctx.currentClubId).toBe(CLUB);
    expect(ctx.currentClub?.name).toBe('familista mail test');
    expect(ctx.currentClubRole).toBe(MembershipRole.HEAD_COACH);
    // And entering it works, which is the other half of "enters the club".
    await expect(switchContext({ userId: COACH }, CLUB, T_FIRST)).resolves.toBeTruthy();
  });

  it('3 · and they see exactly the team they were assigned', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id)).toEqual([T_FIRST]);
    expect(ctx.availableClubs[0].teams.map((t: Row) => t.id)).toEqual([T_FIRST]);
    expect(ctx.effectiveAccess.authorizedTeamIds).toEqual([T_FIRST]);
  });

  it('4 · while gaining no club-wide authority from being visible in the club', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.effectiveAccess.hasClubWideManageAuthority).toBe(false);
    expect(ctx.effectiveAccess.canManageClub).toBe(false);
    expect(ctx.effectiveAccess.canManagePeople).toBe(false);
    // The Coach Market opens — on the shortlist, which is the coach's own —
    // and administering staff through it does not. Access and authority are
    // separate answers, and only the second one is what this test is about.
    expect(ctx.effectiveAccess.canAccessCoachMarket).toBe(true);
    expect(ctx.effectiveAccess.canAdministerStaff).toBe(false);
    // Working in the transfer market is a coach's job; trading on the club's
    // behalf is not. The pair is what "no club-wide authority" means here.
    expect(ctx.effectiveAccess.canAdministerTransfers).toBe(false);
    expect(ctx.effectiveAccess.canAdministerStaff).toBe(false);
    expect(ctx.effectiveAccess.canAdministerLeague).toBe(false);
    expect(ctx.effectiveAccess.canAccessAcademy).toBe(false);
    expect(ctx.effectiveAccess.isPlatformOwner).toBe(false);
    // Visible ≠ unrestricted. The two must never be confused again.
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5-8 · and every other shape of membership still works', () => {
  it('5 · a club-wide CLUB_OWNER', async () => {
    const ctx = await getContext(PRESIDENT);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    expect(ctx.currentClubId).toBe(CLUB);
    expect(ctx.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
    expect(ctx.currentTeamScope.unrestricted).toBe(true);
    expect(ctx.effectiveAccess.canManagePeople).toBe(true);
  });

  it('6 · a club-wide CLUB_ADMIN', async () => {
    const ctx = await getContext(ADMIN);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    expect(ctx.currentClubRole).toBe(MembershipRole.CLUB_ADMIN);
    expect(ctx.currentTeamScope.unrestricted).toBe(true);
    expect(ctx.effectiveAccess.canManageClub).toBe(true);
  });

  it('7 · multi-team staff: one club, and only the teams they were given', async () => {
    const ctx = await getContext(MULTI);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id).sort()).toEqual([T_FIRST, T_U15].sort());
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    expect(ctx.effectiveAccess.hasClubWideManageAuthority).toBe(false);
  });

  it('8 · memberships in two clubs make both parent clubs visible', async () => {
    const ctx = await getContext(TWO_CLUBS);
    expect(ctx.availableClubs.map((c: Row) => c.id).sort()).toEqual([CLUB, CLUB_B].sort());
    // None chosen yet, so it falls to the account's own club — the same
    // `currentClubId ?? clubId` the authentication middleware resolves, and
    // only because they genuinely belong to it.
    expect(ctx.currentClubId).toBe(CLUB);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);   // team-scoped there

    // Somebody in several clubs, none of them their account's own, has nothing
    // to resolve to — and it stays null rather than picking one at random.
    state.users.find((u) => u.id === TWO_CLUBS)!.clubId = OTHER_CLUB;
    expect((await getContext(TWO_CLUBS)).currentClubId).toBeNull();
    state.users.find((u) => u.id === TWO_CLUBS)!.clubId = CLUB;

    // Choosing one gives that club's scope, and only that club's.
    await switchContext({ userId: TWO_CLUBS }, CLUB_B, null);
    const inB = await getContext(TWO_CLUBS);
    expect(inB.currentClubId).toBe(CLUB_B);
    expect(inB.currentTeamScope.unrestricted).toBe(true);      // club-wide there
    expect(inB.effectiveAccess.canManagePeople).toBe(true);

    await switchContext({ userId: TWO_CLUBS }, CLUB, T_FIRST);
    const inA = await getContext(TWO_CLUBS);
    expect(inA.currentClubId).toBe(CLUB);
    expect(inA.currentTeamScope.unrestricted).toBe(false);      // team-scoped here
    expect(inA.currentTeamScope.teams.map((t: Row) => t.id)).toEqual([T_FIRST]);
    expect(inA.effectiveAccess.canManagePeople).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('9-10 · and an empty list still means empty', () => {
  it('9 · no memberships at all is no club', async () => {
    // `User.clubId` still names a club — the legacy column, which is NOT NULL
    // and cannot be cleared. It must not conjure a membership.
    expect(state.users.find((u) => u.id === NOBODY)!.clubId).toBe(CLUB);
    const ctx = await getContext(NOBODY);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    // The legacy fallback is deliberate and predates memberships; what matters
    // is that it grants nothing beyond appearing.
    expect(ctx.availableClubs[0].roles).toEqual([]);
    expect(ctx.currentClubRole).toBeNull();
  });

  it('10 · a suspended or removed membership makes no club visible', async () => {
    const ctx = await getContext(GONE);
    // Their only membership is inactive, so it contributes no club. What is
    // left is the legacy column alone, with no role attached to it.
    expect(ctx.availableClubs[0]?.roles ?? []).toEqual([]);
    expect(ctx.currentClubRole).toBeNull();

    // And a suspension takes the club away again for somebody who had it.
    state.memberships.find((x) => x.id === 'm-multi-a')!.isActive = false;
    state.memberships.find((x) => x.id === 'm-multi-b')!.isActive = false;
    const after = await getContext(MULTI);
    expect(after.availableClubs[0]?.roles ?? []).toEqual([]);
    expect(after.currentTeamScope.teams).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('11 · and none of this opened anything', () => {
  const asCoach = () => ({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH });

  it('the coach still cannot reach another team, or another club', async () => {
    await expect(switchContext({ userId: COACH }, CLUB, T_U15)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, OTHER_CLUB, null)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, CLUB_B, null)).rejects.toThrow();

    await expect(teamAccess.assertCanViewTeamPrivate(asCoach(), T_U15)).rejects.toThrow();
    expect((await teamAccess.accessForTeam(asCoach(), T_FIRST)).canManage).toBe(true);
    expect(await teamAccess.hasClubWideManageAuthority(asCoach())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the landing page waits for the answer before it gives one', () => {
  it('is built from BOTH reads, not whichever returns first', () => {
    const render = APP.slice(APP.indexOf('function renderOwnerHome() {'), APP.indexOf('// ── CLUBS PICKER ──'));
    expect(render).toContain('Promise.all([_isPlatformOwner(), _famContextReady])');
    // The old shape — awaiting whoami alone — is what caused this.
    expect(render).not.toMatch(/_isPlatformOwner\(\)\.then\(\(yes\) =>/);
  });

  it('and the context signals when it has settled, success or failure', () => {
    // In a `finally`, so a failed read stops the wait too: a page stuck on
    // "Loading" is bad, but a page claiming "no club" is worse, and both are
    // avoided only if the signal is unconditional.
    const load = APP.slice(APP.indexOf('async function load() {'), APP.indexOf('async function loadTeams'));
    expect(load).toMatch(/\} finally \{[\s\S]{0,600}_famMarkContextSettled\(\);/);
    expect(APP).toContain('function _famMarkContextSettled()');
  });

  it('and owner home is repainted when the clubs arrive, as the picker already was', () => {
    const load = APP.slice(APP.indexOf('async function load() {'), APP.indexOf('async function loadTeams'));
    expect(load).toContain("document.getElementById('owner-home-content')");
    expect(load).toContain('renderOwnerHome();');
  });

  it('and never calls "not read yet" the same thing as "not a member"', () => {
    const member = APP.slice(APP.indexOf('function _ownerHomeForClubMember'), APP.indexOf('function renderOwnerHome() {'));
    expect(member).toContain('const answered = _famContextAnswered');
    // The two empty states are different sentences, and only one of them is a
    // statement about membership.
    expect(member).toContain('No club yet');
    expect(member).toContain('Your clubs could not be read');
    expect(member).toMatch(/answered\s*\n?\s*\?/);
  });
});
