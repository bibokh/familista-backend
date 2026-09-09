/**
 * tests/identity-separation.unit.test.ts
 *
 * Platform Owner, Club President and Head Coach are three different people.
 *
 * They were not, in production. The platform owner onboarded four clubs, and
 * `POST /clubs` granted the creator a CLUB_OWNER membership in the same
 * transaction — so the person who administers Familista was, in the database,
 * the president of four football clubs. Every screen that names somebody's role
 * then had to pick one of two true-looking answers for the same account, two
 * of those clubs had no real president and looked as though they did, and the
 * only way to unwind it would have locked the platform owner out of the
 * platform, because reaching a club at all depended on that membership.
 *
 * Three separations are pinned here, and each one has to hold for the next to
 * be safe:
 *
 *   1 · AUTHORITY. Platform authority is `SUPER_ADMIN` on the account OR an
 *       active PlatformAdmin row. The real owner has the second and not the
 *       first, and every guard used to test only for the first. Recognising
 *       both is what makes removing those four memberships survivable.
 *   2 · IDENTITY. `accountIdentity` and `currentClubRole` are two fields, and
 *       neither is ever computed from the other. A platform owner with no
 *       membership reads "Platform Owner" with no club role beside it.
 *   3 · CREATION. Creating a club grants the creator nothing, and a CLUB_OWNER
 *       membership now comes into existence by exactly one route: somebody
 *       accepting an invitation that a sitting president, or Familista,
 *       issued.
 *
 * Nothing here mutates production data, and nothing here widens what anybody
 * may do at a club: the head-coach expectations at the end are the existing
 * ones, restated so that a change made for the platform owner cannot quietly
 * move them.
 */

import fs from 'fs';
import path from 'path';
import { ClubLifecycle, MembershipRole, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB_A = 'club-a';          // has a genuine president
const CLUB_B = 'club-b';          // president pending — nobody owns it
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';

const OWNER = 'u-platform-owner';   // PlatformAdmin row, account role CLUB_ADMIN
const PRESIDENT = 'u-president';    // genuine CLUB_OWNER of CLUB_A
const ADMIN = 'u-admin';            // CLUB_ADMIN of CLUB_A
const COACH = 'u-coach';            // HEAD_COACH, first team only

const state = {
  users: [] as Row[], memberships: [] as Row[], clubs: [] as Row[], teams: [] as Row[],
  platformAdmins: [] as Row[], audits: [] as Row[], invitations: [] as Row[],
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

const clubOf = (id: string) => state.clubs.find((c) => c.id === id) ?? null;

const db: Row = {
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      return u ? { ...u, currentClub: u.currentClubId ? clubOf(u.currentClubId) : null, currentTeam: null } : null;
    },
    findFirst: async ({ where = {} }: Row = {}) => state.users.find((u) => match(u, where)) ?? null,
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
    create: async ({ data }: Row) => { const r = { id: `m-${state.memberships.length + 1}`, ...data }; state.memberships.push(r); return r; },
  },
  club: {
    findUnique: async ({ where }: Row) => clubOf(where.id),
    findFirst: async ({ where = {} }: Row = {}) => state.clubs.find((c) => match(c, where)) ?? null,
    findMany: async ({ where = {}, take }: Row = {}) => {
      const rows = state.clubs.filter((c) => match(c, where));
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    create: async ({ data }: Row) => { const r = { id: `club-new-${state.clubs.length + 1}`, ...data }; state.clubs.push(r); return r; },
  },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => {
      const ids: string[] | null = where.id && where.id.in ? where.id.in : null;
      return state.teams.filter((t) => (!ids || ids.includes(t.id))
        && (where.clubId === undefined || t.clubId === where.clubId)
        && (where.isActive === undefined || t.isActive === where.isActive));
    },
  },
  player: { groupBy: async () => [] },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  clubInvitation: {
    findFirst: async ({ where = {} }: Row = {}) => state.invitations.find((i) => match(i, where)) ?? null,
    create: async ({ data }: Row) => { const r = { id: `inv-${state.invitations.length + 1}`, ...data }; state.invitations.push(r); return r; },
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  whiteLabelConfig: { findUnique: async () => null },
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import {
  hasPlatformAuthority, resolvePlatformAuthority, forgetPlatformAuthority,
} from '../src/platform/access-levels';
import { getContext, switchContext } from '../src/services/context.service';
import * as teamAccess from '../src/identity/team-access.service';
import { requireMembership } from '../src/middleware/tenant.middleware';
import { assertMayAppointPresident } from '../src/services/membership.service';
import { createClubAwaitingPresident } from '../src/services/club.service';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const PEOPLE = fs.readFileSync(path.join(ROOT, 'public/people-access.js'), 'utf8');
const CLUB_SERVICE = fs.readFileSync(path.join(ROOT, 'src/services/club.service.ts'), 'utf8');
const CLUB_CONTROLLER = fs.readFileSync(path.join(ROOT, 'src/controllers/club.controller.ts'), 'utf8');

/** Source with its comments removed, so a claim in prose never satisfies a test. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

beforeEach(() => {
  forgetPlatformAuthority();
  state.users = [
    { id: OWNER, email: 'owner@familista.test', role: UserRole.CLUB_ADMIN, clubId: CLUB_A, isActive: true, currentClubId: null, currentTeamId: null },
    { id: PRESIDENT, email: 'president@a.test', role: UserRole.CLUB_ADMIN, clubId: CLUB_A, isActive: true, currentClubId: CLUB_A, currentTeamId: null },
    { id: ADMIN, email: 'admin@a.test', role: UserRole.CLUB_ADMIN, clubId: CLUB_A, isActive: true, currentClubId: CLUB_A, currentTeamId: null },
    { id: COACH, email: 'coach@a.test', role: UserRole.HEAD_COACH, clubId: CLUB_A, isActive: true, currentClubId: CLUB_A, currentTeamId: T_FIRST },
  ];
  state.clubs = [
    { id: CLUB_A, name: 'FC Familista', shortName: 'FCF', emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.ACTIVE },
    { id: CLUB_B, name: 'BSC Marzahn', shortName: 'BSC', emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.PENDING_SETUP },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB_A, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true },
    { id: T_U15, clubId: CLUB_A, name: 'U15', shortName: null, kind: 'U15', isActive: true },
  ];
  state.memberships = [
    { id: 'm-pres', userId: PRESIDENT, clubId: CLUB_A, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true },
    { id: 'm-admin', userId: ADMIN, clubId: CLUB_A, teamId: null, role: MembershipRole.CLUB_ADMIN, isActive: true },
    { id: 'm-coach', userId: COACH, clubId: CLUB_A, teamId: T_FIRST, role: MembershipRole.HEAD_COACH, isActive: true },
  ];
  // The production shape exactly: an ACTIVE PlatformAdmin row, and an account
  // role that is NOT SUPER_ADMIN. Every guard that tested only for the account
  // role failed to recognise this account.
  state.platformAdmins = [{ userId: OWNER, role: 'PLATFORM_OWNER', isActive: true }];
  state.audits = [];
  state.invitations = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Authority: the PlatformAdmin row is recognised, and grants nothing at a club
// ─────────────────────────────────────────────────────────────────────────────

describe('platform authority', () => {
  test('a PlatformAdmin row grants it, without SUPER_ADMIN on the account', async () => {
    await expect(resolvePlatformAuthority({ userId: OWNER, role: UserRole.CLUB_ADMIN })).resolves.toBe(true);
  });

  test('an ordinary club administrator does not have it', async () => {
    await expect(resolvePlatformAuthority({ userId: ADMIN, role: UserRole.CLUB_ADMIN })).resolves.toBe(false);
  });

  test('a retired platform assignment does not grant it', async () => {
    state.platformAdmins = [{ userId: OWNER, role: 'PLATFORM_OWNER', isActive: false }];
    forgetPlatformAuthority();
    await expect(resolvePlatformAuthority({ userId: OWNER, role: UserRole.CLUB_ADMIN })).resolves.toBe(false);
  });

  test('a resolved answer on the request is trusted, in both directions', () => {
    expect(hasPlatformAuthority({ role: UserRole.CLUB_ADMIN, isPlatformOwner: true })).toBe(true);
    expect(hasPlatformAuthority({ role: UserRole.CLUB_ADMIN, isPlatformOwner: false })).toBe(false);
    expect(hasPlatformAuthority({ role: UserRole.SUPER_ADMIN })).toBe(true);
    expect(hasPlatformAuthority({ role: UserRole.HEAD_COACH })).toBe(false);
    expect(hasPlatformAuthority(null)).toBe(false);
  });

  test('a request that already answered "no" is not second-guessed against the table', async () => {
    // The flag `authenticate` resolved is the answer. A service must not be
    // able to re-open the question and get a different one.
    await expect(resolvePlatformAuthority({ userId: OWNER, role: UserRole.CLUB_ADMIN, isPlatformOwner: false }))
      .resolves.toBe(false);
  });

  test('requireMembership lets platform authority through a club it has no membership in', async () => {
    const next = jest.fn();
    await requireMembership(MembershipRole.CLUB_ADMIN)(
      { user: { id: OWNER, role: UserRole.CLUB_ADMIN, clubId: CLUB_B, isPlatformOwner: true } } as any,
      {} as any, next as any,
    );
    expect(next).toHaveBeenCalledWith();
  });

  test('requireMembership still refuses an account with neither membership nor platform authority', async () => {
    const next = jest.fn();
    await requireMembership(MembershipRole.CLUB_ADMIN)(
      { user: { id: ADMIN, role: UserRole.CLUB_ADMIN, clubId: CLUB_B, isPlatformOwner: false } } as any,
      {} as any, next as any,
    );
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('a team is reachable as the PLATFORM, and is never reported as a club role', async () => {
    const access = await teamAccess.accessForTeam(
      { userId: OWNER, clubId: CLUB_A, role: UserRole.CLUB_ADMIN, isPlatformOwner: true }, T_FIRST,
    );
    expect(access.canManage).toBe(true);
    expect(access.reason).toBe('PLATFORM_ADMIN');
    // The one that matters: platform authority names no membership, so nothing
    // downstream can print "President" from it.
    expect(access.roles).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Identity: two fields, never folded into one
// ─────────────────────────────────────────────────────────────────────────────

describe('account identity and club role are separate', () => {
  test('the platform owner holds no club role, and the context says both things', async () => {
    const ctx: any = await getContext(OWNER);
    expect(ctx.accountIdentity).toBe('PLATFORM_OWNER');
    expect(ctx.effectiveAccess.isPlatformOwner).toBe(true);
    // No membership anywhere. The four that used to exist are the bug.
    expect(state.memberships.filter((m) => m.userId === OWNER)).toEqual([]);
    expect(ctx.currentClubRole).toBeNull();
  });

  test('the clubs offered to the platform owner are marked as platform access, with no roles', async () => {
    const ctx: any = await getContext(OWNER);
    const ids = ctx.availableClubs.map((c: Row) => c.id).sort();
    expect(ids).toEqual([CLUB_A, CLUB_B]);
    for (const c of ctx.availableClubs) {
      expect(c.viaPlatform).toBe(true);
      expect(c.roles).toEqual([]);
    }
  });

  test('the genuine president is a club member, and is not the platform', async () => {
    const ctx: any = await getContext(PRESIDENT);
    expect(ctx.accountIdentity).toBe('CLUB_MEMBER');
    expect(ctx.effectiveAccess.isPlatformOwner).toBe(false);
    expect(ctx.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB_A]);
    expect(ctx.availableClubs[0].viaPlatform).toBeUndefined();
    // A club they are not a member of is not offered to them, platform-visible
    // or not.
    expect(ctx.availableClubs.map((c: Row) => c.id)).not.toContain(CLUB_B);
  });

  test('the platform owner may administer a club, and only the president may appoint one', async () => {
    const owner: any = await getContext(OWNER);
    expect(owner.effectiveAccess.canManagePeople).toBe(true);
    expect(owner.effectiveAccess.canAppointPresident).toBe(true);

    const president: any = await getContext(PRESIDENT);
    expect(president.effectiveAccess.canAppointPresident).toBe(true);

    const admin: any = await getContext(ADMIN);
    expect(admin.effectiveAccess.canManagePeople).toBe(true);
    expect(admin.effectiveAccess.canAppointPresident).toBe(false);
  });

  test('the platform owner enters a club without a membership, and without acquiring one', async () => {
    const before = state.memberships.length;
    const ctx: any = await switchContext({ userId: OWNER }, CLUB_B, null);
    expect(ctx.currentClubId).toBe(CLUB_B);
    expect(ctx.currentClubRole).toBeNull();
    expect(ctx.inClubViaPlatform).toBe(true);
    expect(state.memberships.length).toBe(before);
    // Entering a club as the platform is an audited act.
    expect(state.audits.some((a) => a.clubId === CLUB_B && a.actorUserId === OWNER)).toBe(true);
  });

  test('an ordinary account still cannot enter a club it has no membership in', async () => {
    await expect(switchContext({ userId: ADMIN }, CLUB_B, null)).rejects.toThrow(/membership/i);
  });

  test('platform authority is not a licence to name a club that does not exist', async () => {
    await expect(switchContext({ userId: OWNER }, 'club-nowhere', null)).rejects.toThrow(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Creation: a club is created owning nobody, and owned by nobody
// ─────────────────────────────────────────────────────────────────────────────

describe('creating a club grants the creator nothing', () => {
  test('no membership is created, and the club waits for a president', async () => {
    const before = state.memberships.length;
    const result = await createClubAwaitingPresident({ name: 'New Club', city: 'Berlin' }, OWNER);
    expect(result.membershipId).toBeNull();
    expect(result.lifecycle).toBe(ClubLifecycle.PENDING_SETUP);
    expect(state.memberships.length).toBe(before);
    expect(state.memberships.filter((m) => m.userId === OWNER)).toEqual([]);
  });

  test('the club-creation service contains no membership write at all', () => {
    expect(code(CLUB_SERVICE)).not.toMatch(/membership\s*\.\s*create/);
    expect(code(CLUB_SERVICE)).not.toMatch(/MembershipRole\s*\.\s*CLUB_OWNER/);
  });

  test('the function that granted the creator a membership is gone, not merely unused', () => {
    expect(CLUB_SERVICE).not.toContain('createClubWithOwnerMembership');
    expect(CLUB_CONTROLLER).not.toContain('createClubWithOwnerMembership');
  });

  test('naming a president routes through the onboarding service, which invites rather than grants', () => {
    expect(code(CLUB_CONTROLLER)).toContain('createClubWithPresidentInvite');
  });
});

describe('a president is appointed, never assumed', () => {
  test('a club administrator may not appoint one', async () => {
    await expect(assertMayAppointPresident({ userId: ADMIN, clubId: CLUB_A, role: UserRole.CLUB_ADMIN }))
      .rejects.toThrow(/president/i);
  });

  test('a sitting president of the same club may', async () => {
    await expect(assertMayAppointPresident({ userId: PRESIDENT, clubId: CLUB_A, role: UserRole.CLUB_ADMIN }))
      .resolves.toBeUndefined();
  });

  test('platform authority may, for a club it holds no membership in', async () => {
    await expect(assertMayAppointPresident({ userId: OWNER, clubId: CLUB_B, role: UserRole.CLUB_ADMIN }))
      .resolves.toBeUndefined();
  });

  test('a head coach may not', async () => {
    await expect(assertMayAppointPresident({ userId: COACH, clubId: CLUB_A, role: UserRole.HEAD_COACH }))
      .rejects.toThrow(/president/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The interface says both facts, and invents neither
// ─────────────────────────────────────────────────────────────────────────────

describe('what the sidebar prints', () => {
  const run = (context: Row) => {
    const src = APP.slice(
      APP.indexOf('function _myClubRoleLabel()'),
      APP.indexOf('const _ROLE_RANK ='),
    );
    const rank = APP.slice(APP.indexOf('const _ROLE_RANK ='), APP.indexOf('function _strongestRole('));
    const labelsAt = APP.indexOf('const _ROLE_LABELS =');
    const labels = APP.slice(labelsAt, APP.indexOf('}', APP.indexOf('function _roleLabel(', labelsAt)) + 1);
    const fn = new Function('State', 'document', `
      const window = { State };
      ${rank}
      function _strongestRole(roles) {
        if (!Array.isArray(roles) || !roles.length) return null;
        const at = (r) => { const i = _ROLE_RANK.indexOf(r); return i < 0 ? _ROLE_RANK.length : i; };
        return [...roles].sort((a, b) => at(a) - at(b))[0];
      }
      ${labels}
      ${src}
      return { _displayRole, _myClubRoleLabel };
    `);
    return fn({ context, user: { role: 'CLUB_ADMIN' } }, { getElementById: () => null });
  };

  test('the platform owner reads as the platform, with no club role invented for them', () => {
    const out = run({ accountIdentity: 'PLATFORM_OWNER', currentClubRole: null, clubId: CLUB_B, availableClubs: [{ id: CLUB_B, roles: [], viaPlatform: true }] });
    expect(out._displayRole()).toBe('Platform Owner');
    expect(out._myClubRoleLabel()).toBe('');
    expect(out._displayRole()).not.toMatch(/President/);
  });

  test('the club president reads as the president, and not as the platform', () => {
    const out = run({ accountIdentity: 'CLUB_MEMBER', currentClubRole: 'CLUB_OWNER', clubId: CLUB_A, availableClubs: [{ id: CLUB_A, roles: ['CLUB_OWNER'] }] });
    expect(out._displayRole()).toBe('President');
    expect(out._displayRole()).not.toMatch(/Platform/);
  });

  test('somebody who is genuinely both is printed as both, in that order', () => {
    const out = run({ accountIdentity: 'PLATFORM_OWNER', currentClubRole: 'HEAD_COACH', clubId: CLUB_A, availableClubs: [{ id: CLUB_A, roles: ['HEAD_COACH'] }] });
    expect(out._displayRole()).toBe('Platform Owner · Head coach');
  });

  test('a club opened through platform authority is labelled as that, not as a role', () => {
    const src = APP.slice(APP.indexOf('function _clubRoleLabel(club)'), APP.indexOf('function _clubRoleLabel(club)') + 400);
    expect(src).toContain('Platform access');
    expect(src).toContain('viaPlatform');
  });
});

describe('People & Access', () => {
  test('President is offered only when the server says this person may appoint one', () => {
    const src = PEOPLE.slice(PEOPLE.indexOf('function invitableRoles()'), PEOPLE.indexOf('function invitableRoles()') + 500);
    expect(src).toContain('canAppointPresident');
    // Never from a role name held by the client.
    expect(code(src)).not.toMatch(/currentClubRole/);
  });

  test('the screen opens on the server\'s capability, not on a role the client matched', () => {
    const src = PEOPLE.slice(PEOPLE.indexOf('function canManage()'), PEOPLE.indexOf('function canManage()') + 900);
    expect(src).toContain('canManagePeople');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Nothing at a club moved
// ─────────────────────────────────────────────────────────────────────────────

describe('club roles are exactly what they were', () => {
  test('a team-scoped head coach keeps his shortlist and gains no club administration', async () => {
    const ctx: any = await getContext(COACH);
    expect(ctx.accountIdentity).toBe('CLUB_MEMBER');
    expect(ctx.currentClubRole).toBe(MembershipRole.HEAD_COACH);
    expect(ctx.effectiveAccess.canShortlist).toBe(true);
    expect(ctx.effectiveAccess.canAccessCoachMarket).toBe(true);
    expect(ctx.effectiveAccess.canManagePeople).toBe(false);
    expect(ctx.effectiveAccess.canAppointPresident).toBe(false);
    expect(ctx.effectiveAccess.canAdministerStaff).toBe(false);
    expect(ctx.effectiveAccess.canAdministerTransfers).toBe(false);
    expect(ctx.effectiveAccess.canAdministerLeague).toBe(false);
    expect(ctx.effectiveAccess.authorizedTeamIds).toEqual([T_FIRST]);
  });

  test('a club administrator does not administer the platform', async () => {
    const ctx: any = await getContext(ADMIN);
    expect(ctx.accountIdentity).toBe('CLUB_MEMBER');
    expect(ctx.effectiveAccess.isPlatformOwner).toBe(false);
    expect(ctx.effectiveAccess.canAdministerLeague).toBe(false);
  });

  test('the club with no president has none, and none is invented for it', async () => {
    const owners = state.memberships.filter(
      (m) => m.clubId === CLUB_B && m.role === MembershipRole.CLUB_OWNER && m.isActive,
    );
    expect(owners).toEqual([]);
    await getContext(OWNER);
    await switchContext({ userId: OWNER }, CLUB_B, null);
    expect(state.memberships.filter((m) => m.clubId === CLUB_B)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · A club role never follows somebody out of the club it belongs to
// ─────────────────────────────────────────────────────────────────────────────
//
// Production found this after the separation shipped. The platform owner still
// holds the four legacy CLUB_OWNER memberships — deliberately, until the
// cleanup — so entering one of those clubs correctly reads "President". Then
// entering ANY other club still read "President", including clubs where this
// account holds nothing at all.
//
// The server was right the whole time. `openClub` writes the new club's id
// into `State.context` synchronously, before anything is fetched, so the
// workspace paints as the club being entered — and it left every other field
// describing the club being LEFT. The role was the one that showed. If the
// background switch was then superseded by a second click, or failed, the
// stale role was never corrected at all.
//
// So the role is cleared with the id it belonged to, and recomputed from
// `availableClubs`, which already carries this account's roles per club.

describe('entering a club recomputes the club role from that club alone', () => {
  const OWNED = 'club-legacy-owned';   // a legacy CLUB_OWNER membership survives here
  const NOT_MINE = 'club-b';           // no membership at all
  const OWNERLESS = 'club-ownerless';  // no membership, and no president either

  beforeEach(() => {
    state.clubs.push(
      { id: OWNED, name: 'FC Familista', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.ACTIVE },
      { id: OWNERLESS, name: 'fc nord marzhen', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.PENDING_SETUP },
    );
    // The production state exactly: platform authority AND one of the four
    // legacy memberships that have not been cleaned up yet.
    state.memberships.push({
      id: 'm-legacy', userId: OWNER, clubId: OWNED, teamId: null,
      role: MembershipRole.CLUB_OWNER, isActive: true,
    });
  });

  // ── the server ────────────────────────────────────────────────────────────

  test('A · the club with the legacy membership reports President', async () => {
    const ctx: any = await switchContext({ userId: OWNER }, OWNED, null);
    expect(ctx.accountIdentity).toBe('PLATFORM_OWNER');
    expect(ctx.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
    expect(ctx.inClubViaPlatform).toBe(false);
  });

  test('B · switching to a club with no membership reports no club role', async () => {
    await switchContext({ userId: OWNER }, OWNED, null);
    const ctx: any = await switchContext({ userId: OWNER }, NOT_MINE, null);
    expect(ctx.accountIdentity).toBe('PLATFORM_OWNER');
    expect(ctx.currentClubRole).toBeNull();
    expect(ctx.inClubViaPlatform).toBe(true);
    expect(ctx.availableClubs.find((c: Row) => c.id === NOT_MINE).roles).toEqual([]);
  });

  test('C · switching back reports President again, from that club alone', async () => {
    await switchContext({ userId: OWNER }, OWNED, null);
    await switchContext({ userId: OWNER }, NOT_MINE, null);
    const ctx: any = await switchContext({ userId: OWNER }, OWNED, null);
    expect(ctx.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
  });

  test('D · an ownerless club reports no club role, and no president is invented', async () => {
    const ctx: any = await switchContext({ userId: OWNER }, OWNERLESS, null);
    expect(ctx.currentClubRole).toBeNull();
    expect(state.memberships.filter((m) => m.clubId === OWNERLESS)).toEqual([]);
  });

  // ── the interface, driving the shipped functions ──────────────────────────
  //
  // `openClub` is executed as it ships. Everything it reaches for is stubbed,
  // and `AppContext` is left undefined so it returns after the synchronous
  // state write — which is the moment under test, before any server answer.

  const footer = () => {
    const roleSrc = APP.slice(
      APP.indexOf('function _myClubRoleLabel()'),
      APP.indexOf('function _accessibleClubs()'),
    );
    const openSrc = APP.slice(
      APP.indexOf('function openClub(clubId) {'),
      APP.indexOf('// ── Phase B.1 · Topbar brand hydration'),
    );
    const el = { textContent: '' };
    const fn = new Function('el', `
      const window = { State: { context: null, user: { role: 'CLUB_ADMIN' } } };
      const State = window.State;
      const document = { getElementById: (id) => (id === 'user-email' ? el : null) };
      let _famClubEntry = 0;
      const showToast = () => {};
      const navTo = () => {};
      const _famClubSwitchBegin = () => {};
      const _famClearClubScopedState = () => {};
      const _tfRtReset = () => {};
      ${roleSrc}
      ${openSrc}
      return {
        seed: (c) => { window.State.context = c; _paintUserRole(); },
        enter: (id) => { openClub(id); _paintUserRole(); },
        text: () => el.textContent,
      };
    `);
    return fn(el);
  };

  // Real UUIDs: `openClub` refuses an id that is not one, because an id that
  // never came from the server must not be allowed to rewrite the session's
  // scope. The client-side cases below go through that guard as they ship.
  const UI_OWNED = '11111111-1111-4111-8111-111111111111';
  const UI_NOT_MINE = '22222222-2222-4222-8222-222222222222';
  const UI_OWNERLESS = '33333333-3333-4333-8333-333333333333';

  /** What /me/context returns for this account, in the shape the client keeps. */
  const contextFor = (clubId: string | null, role: string | null) => ({
    clubId,
    teamId: null,
    accountIdentity: 'PLATFORM_OWNER',
    effectiveAccess: { isPlatformOwner: true },
    currentClubRole: role,
    availableClubs: [
      { id: UI_OWNED, name: 'FC Familista', roles: ['CLUB_OWNER'] },
      { id: UI_NOT_MINE, name: 'BSC Marzahn', roles: [], viaPlatform: true },
      { id: UI_OWNERLESS, name: 'fc nord marzhen', roles: [], viaPlatform: true },
    ],
  });

  test('A → B → C · the role changes with the club, at the first paint', () => {
    const ui = footer();

    // A · in the club the legacy membership covers.
    ui.seed(contextFor(UI_OWNED, 'CLUB_OWNER'));
    expect(ui.text()).toBe('Platform Owner · President');

    // B · the moment another club is entered, before any server answer.
    // This is the assertion that was failing in production.
    ui.enter(UI_NOT_MINE);
    expect(ui.text()).toBe('Platform Owner');

    // C · and back, from that club's own membership.
    ui.enter(UI_OWNED);
    expect(ui.text()).toBe('Platform Owner · President');
  });

  test('D · an ownerless club shows the account and nothing else', () => {
    const ui = footer();
    ui.seed(contextFor(UI_OWNED, 'CLUB_OWNER'));
    ui.enter(UI_OWNERLESS);
    expect(ui.text()).toBe('Platform Owner');
  });

  test('and the stale role is gone from the state, not merely unprinted', () => {
    const ui = footer();
    ui.seed(contextFor(UI_OWNED, 'CLUB_OWNER'));
    ui.enter(UI_NOT_MINE);
    // A background switch that is superseded or fails never writes again, so
    // "the next response will fix it" is not a fix.
    expect(ui.text()).not.toMatch(/President/);
  });

  test('re-entering the club already open disturbs nothing', () => {
    const ui = footer();
    ui.seed(contextFor(UI_OWNED, 'CLUB_OWNER'));
    ui.enter(UI_OWNED);
    expect(ui.text()).toBe('Platform Owner · President');
  });

  test('a club role is never read from the account field once the server has answered', () => {
    const ui = footer();
    // The server listed this account's clubs and this is not one of them: the
    // honest answer is no club role, not User.role dressed up as one.
    ui.seed({ ...contextFor('44444444-4444-4444-8444-444444444444', null), accountIdentity: null, effectiveAccess: null });
    expect(ui.text()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Entering a club that is not yet a going concern
// ─────────────────────────────────────────────────────────────────────────────
//
// Production reported one club that will not open for the platform owner while
// two others in the same state open fine. These pin the states that were
// suspected, so that "a club with no president" or "a club with no team" can be
// ruled in or out by evidence rather than by reading the code and agreeing with
// oneself. All three open.

describe('a platform owner enters a club whatever state it is in', () => {
  const ORDINARY = 'club-ordinary';     // active, has teams, no membership for the owner
  const OWNERLESS = 'club-no-president'; // PENDING_SETUP, nobody owns it
  const TEAMLESS = 'club-no-teams';      // exists, and has not been set up at all

  beforeEach(() => {
    state.clubs.push(
      { id: ORDINARY, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.ACTIVE },
      { id: OWNERLESS, name: 'Familista berlin', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.PENDING_SETUP },
      { id: TEAMLESS, name: 'ABDELHALIM ATIYA ABDELHALIM', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', lifecycle: ClubLifecycle.PENDING_SETUP },
    );
    state.teams.push(
      { id: 'team-ordinary', clubId: ORDINARY, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true },
      { id: 'team-owner-less', clubId: OWNERLESS, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true },
    );
    // TEAMLESS gets none, deliberately.
  });

  test('a normal club it holds no membership in', async () => {
    const ctx: any = await switchContext({ userId: OWNER }, ORDINARY, null);
    expect(ctx.currentClubId).toBe(ORDINARY);
    expect(ctx.currentClubRole).toBeNull();
    expect(ctx.inClubViaPlatform).toBe(true);
    expect(ctx.currentTeamScope.unrestricted).toBe(true);
    expect(ctx.effectiveAccess.canManagePeople).toBe(true);
  });

  test('an ownerless club that is still awaiting its president', async () => {
    const ctx: any = await switchContext({ userId: OWNER }, OWNERLESS, null);
    expect(ctx.currentClubId).toBe(OWNERLESS);
    expect(ctx.currentClubRole).toBeNull();
    // Awaiting a president is not a reason to refuse the platform. It is the
    // reason the platform is the only one who can get in.
    expect(ctx.effectiveAccess.canAppointPresident).toBe(true);
    expect(state.memberships.filter((m) => m.clubId === OWNERLESS)).toEqual([]);
  });

  test('a club with no team at all opens, and offers no team', async () => {
    const ctx: any = await switchContext({ userId: OWNER }, TEAMLESS, null);
    expect(ctx.currentClubId).toBe(TEAMLESS);
    expect(ctx.currentTeamId).toBeNull();
    // Unrestricted over a club with nothing in it is an empty list, not a
    // failure: the workspace opens on a club waiting to be set up.
    expect(ctx.currentTeamScope).toEqual({ unrestricted: true, teams: [] });
    expect(ctx.effectiveAccess.authorizedTeamIds).toEqual([]);
  });

  test('and every one of them is offered by the picker in the first place', async () => {
    const ctx: any = await getContext(OWNER);
    const ids = ctx.availableClubs.map((c: Row) => c.id);
    for (const id of [ORDINARY, OWNERLESS, TEAMLESS]) expect(ids).toContain(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · The one way a club entry can fail before it begins
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything `switchClub` does after the context call is wrapped: loadTeams
// swallows its own failure, _settleScopedTeam is a nicety, renderSwitcher is
// null-safe, _thHydrate is caught and only downgrades a toast, and
// _famEnsureClubData resolves rather than rejects. So a club entry that shows a
// toast AND never opens the workspace can only have been refused by openClub
// itself, before it navigates — and openClub refuses on exactly two things.

describe('what refuses a club entry, and what it says', () => {
  const openSrc = () => APP.slice(
    APP.indexOf('function openClub(clubId) {'),
    APP.indexOf('// ── Phase B.1 · Topbar brand hydration'),
  );

  test('the only refusals that precede navigation are a missing id and a non-server id', () => {
    const before = openSrc().slice(0, openSrc().indexOf("navTo('club-home'"));
    const toasts = before.match(/showToast\((?:'|")([^'"]+)/g) || [];
    expect(toasts.map((t) => t.replace(/showToast\(('|")/, ''))).toEqual([
      'Missing club id',
      'That club is still loading — one moment',
    ]);
  });

  test('and every step after the context call is wrapped, so none of them can strand the entry', () => {
    const sw = APP.slice(
      APP.indexOf('async function switchClub(clubId, opts)'),
      APP.indexOf('async function switchTeam(teamId)'),
    );
    // loadTeams cannot reject.
    const lt = APP.slice(APP.indexOf('async function loadTeams()'), APP.indexOf('function renderSwitcher()'));
    expect(lt).toContain('catch (_) { _teams = []; }');
    // The roster, the squad store and the stream are each guarded on their own.
    expect(sw).toMatch(/try \{ hydrated = \(await _thHydrate\(\)\) === 'ready'; \} catch \(_\) \{ hydrated = false; \}/);
    expect(sw).toMatch(/try \{ _sqLoad\(\); \} catch \(_\) \{\}/);
    expect(sw).toMatch(/try \{ _tfRtConnect\(\); \} catch \(_\) \{\}/);
    // And club data resolves rather than rejecting.
    const ecd = APP.slice(APP.indexOf('function _famEnsureClubData(opts)'), APP.indexOf('function _famActivePage()'));
    expect(ecd).toContain(".catch(function () { return { ok: false, failed: ['club data'] }; })");
  });
});
