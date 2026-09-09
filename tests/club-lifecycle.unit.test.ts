/**
 * tests/club-lifecycle.unit.test.ts
 *
 * A club can be suspended without being lost.
 *
 * Familista needed a way to stop a club operating that is not deletion, and the
 * whole value of it is in one word: NOTHING IS REMOVED. Deactivating a club
 * moves one enum on one row. Every player, team, academy side, membership,
 * role, training session, match, transfer, engagement, record and relationship
 * is exactly where it was, and reactivating puts the club back into the state
 * it left — not into "active", which would be a different club for one that was
 * still waiting on its president.
 *
 * So these tests count rows before and after. That is the assertion that
 * matters: a suspension that quietly deleted something would pass every test
 * about permissions and still be the worst possible bug in this file.
 *
 * The rest is authorization, and it is checked at the SERVER, over HTTP,
 * through the real routers — because "the menu is hidden" is not a suspension,
 * and a president with curl is the case this exists to refuse.
 */

import express from 'express';
import request from 'supertest';
import { ClubLifecycle, MembershipRole, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMPTY = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';

const OWNER = 'u-platform-owner';   // PlatformAdmin row, account role CLUB_ADMIN
const PRESIDENT = 'u-president';    // CLUB_OWNER of CLUB
const COACH = 'u-coach';            // HEAD_COACH, one team

const state = {
  clubs: [] as Row[], users: [] as Row[], memberships: [] as Row[], teams: [] as Row[],
  players: [] as Row[], matches: [] as Row[], invitations: [] as Row[], sessions: [] as Row[],
  platformAdmins: [] as Row[], platformAudits: [] as Row[],
};

const cmp = (actual: unknown, expected: any): boolean => {
  if (expected === undefined) return true;
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('not' in expected) return !cmp(actual, expected.not);
    if ('in' in expected) return (expected.in as unknown[]).includes(actual);
    if ('notIn' in expected) return !(expected.notIn as unknown[]).includes(actual);
    if ('gt' in expected) return (actual as Date) > expected.gt;
  }
  return actual === expected;
};
const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    return cmp(row[k], v);
  });

// A GETTER, not the array: `beforeEach` replaces each list wholesale, and a
// closure over the array itself would go on counting the previous test's rows.
const countIn = (rows: () => Row[]) => async ({ where = {} }: Row = {}) =>
  rows().filter((r) => match(r, where)).length;

const db: Row = {
  club: {
    findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: Row) => {
      const c = state.clubs.find((x) => x.id === where.id);
      if (!c) throw new Error('not found');
      return c;
    },
    findMany: async ({ where = {}, take }: Row = {}) => {
      const rows = state.clubs.filter((c) => match(c, where));
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = state.clubs.filter((c) => match(c, where));
      for (const c of rows) Object.assign(c, data);
      return { count: rows.length };
    },
    update: async ({ where, data }: Row) => {
      const c = state.clubs.find((x) => x.id === where.id)!;
      Object.assign(c, data);
      return c;
    },
    delete: async ({ where }: Row) => {
      const i = state.clubs.findIndex((c) => c.id === where.id);
      const [gone] = state.clubs.splice(i, 1);
      // The real schema sets PlatformAuditLog.clubId to NULL rather than
      // deleting the row, which is exactly what keeps the record of a deletion.
      for (const a of state.platformAudits) if (a.clubId === where.id) a.clubId = null;
      return gone;
    },
    count: countIn(() => state.clubs),
    groupBy: async () => [],
  },
  user: {
    findUnique: async ({ where }: Row) => state.users.find((u) => u.id === where.id) ?? null,
    findFirst: async ({ where = {} }: Row = {}) => state.users.find((u) => match(u, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.users.filter((u) => match(u, where.id?.in ? { id: { in: where.id.in } } : where)),
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
    count: countIn(() => state.users),
  },
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships
      .filter((m) => match(m, where))
      .map((m) => ({
        ...m,
        club: state.clubs.find((c) => c.id === m.clubId) ?? null,
        team: state.teams.find((t) => t.id === m.teamId) ?? null,
        user: state.users.find((u) => u.id === m.userId) ?? null,
      })),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: countIn(() => state.memberships),
    groupBy: async () => [],
  },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.teams.filter((t) => match(t, where)),
    count: countIn(() => state.teams),
    groupBy: async () => [],
  },
  player: { count: countIn(() => state.players), groupBy: async () => [], findMany: async () => state.players },
  match: { count: countIn(() => state.matches) },
  clubInvitation: {
    count: countIn(() => state.invitations),
    findMany: async ({ where = {} }: Row = {}) => state.invitations.filter((i) => match(i, where)),
    findFirst: async ({ where = {} }: Row = {}) => state.invitations.find((i) => match(i, where)) ?? null,
  },
  trainingSession: { count: countIn(() => state.sessions) },
  announcement: { count: async () => 0 },
  staffEngagement: { count: async () => 0 },
  financial: { count: async () => 0 },
  gpsDevice: { count: async () => 0 },
  scoutReport: { count: async () => 0 },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  platformAuditLog: {
    create: async ({ data }: Row) => {
      // Monotonic, so two events recorded in the same millisecond still order
      // the way they happened. Real rows are ordered by a clock with more room
      // in it than a test that writes twice in a row.
      const r = {
        id: `pa-${state.platformAudits.length + 1}`,
        createdAt: new Date(Date.now() + state.platformAudits.length),
        ...data,
      };
      state.platformAudits.push(r);
      return r;
    },
    findMany: async ({ where = {}, take }: Row = {}) => {
      const rows = state.platformAudits
        .filter((a) => match(a, where))
        .sort((a, b) => b.createdAt - a.createdAt);
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
  },
  membershipAuditLog: { create: async ({ data }: Row) => data },
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));
jest.mock('../src/security/security-event.service', () => ({ logSecurityEvent: jest.fn() }));

import * as lifecycle from '../src/platform/club-lifecycle.service';
import { forgetPlatformAuthority } from '../src/platform/access-levels';
import { getContext, switchContext } from '../src/services/context.service';
import { listClubs } from '../src/platform/system.service';
import { requireOperableClub } from '../src/middleware/club-lifecycle.middleware';
import { errorHandler } from '../src/middleware/error.middleware';

const actor = (userId: string) => ({ userId, clubId: CLUB, role: UserRole.CLUB_ADMIN });

/** How much the club owns, counted the same way every time. */
const inventory = () => ({
  teams: state.teams.filter((t) => t.clubId === CLUB).length,
  memberships: state.memberships.filter((m) => m.clubId === CLUB).length,
  activeMemberships: state.memberships.filter((m) => m.clubId === CLUB && m.isActive).length,
  players: state.players.filter((p) => p.clubId === CLUB).length,
  matches: state.matches.filter((m) => m.clubId === CLUB).length,
  sessions: state.sessions.filter((s) => s.clubId === CLUB).length,
  invitations: state.invitations.filter((i) => i.clubId === CLUB).length,
  roles: state.memberships.filter((m) => m.clubId === CLUB).map((m) => `${m.userId}:${m.role}:${m.teamId ?? 'club'}:${m.isActive}`).sort(),
});

beforeEach(() => {
  forgetPlatformAuthority();
  lifecycle.forgetClubState();
  state.clubs = [
    { id: CLUB, name: 'FC Familista', shortName: 'FCF', emblem: null, crestUrl: null, plan: 'BASIC', createdAt: new Date(), lifecycle: ClubLifecycle.ACTIVE, previousLifecycle: null, activatedAt: new Date(), deactivatedAt: null, archivedAt: null, reactivatedAt: null, restoredAt: null, lifecycleChangedAt: null, lifecycleChangedByUserId: null, lifecycleReason: null },
    { id: OTHER, name: 'BSC Marzahn', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', createdAt: new Date(), lifecycle: ClubLifecycle.PRESIDENT_INVITED, previousLifecycle: null, activatedAt: null, deactivatedAt: null, archivedAt: null, reactivatedAt: null, restoredAt: null, lifecycleChangedAt: null, lifecycleChangedByUserId: null, lifecycleReason: null },
    { id: EMPTY, name: 'Familista berlin', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', createdAt: new Date(), lifecycle: ClubLifecycle.PENDING_SETUP, previousLifecycle: null, activatedAt: null, deactivatedAt: null, archivedAt: null, reactivatedAt: null, restoredAt: null, lifecycleChangedAt: null, lifecycleChangedByUserId: null, lifecycleReason: null },
  ];
  state.users = [
    { id: OWNER, email: 'owner@familista.io', role: UserRole.CLUB_ADMIN, clubId: CLUB, isActive: true, currentClubId: null, currentTeamId: null, firstName: 'K', lastName: 'A' },
    { id: PRESIDENT, email: 'president@fcf.test', role: UserRole.CLUB_ADMIN, clubId: CLUB, isActive: true, currentClubId: CLUB, currentTeamId: null, firstName: 'P', lastName: 'R' },
    { id: COACH, email: 'coach@fcf.test', role: UserRole.HEAD_COACH, clubId: CLUB, isActive: true, currentClubId: CLUB, currentTeamId: TEAM, firstName: 'C', lastName: 'H' },
  ];
  state.teams = [{ id: TEAM, clubId: CLUB, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true }];
  state.memberships = [
    { id: 'm-pres', userId: PRESIDENT, clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true },
    { id: 'm-coach', userId: COACH, clubId: CLUB, teamId: TEAM, role: MembershipRole.HEAD_COACH, isActive: true },
  ];
  state.players = [
    { id: 'p1', clubId: CLUB, teamId: TEAM, isActive: true },
    { id: 'p2', clubId: CLUB, teamId: TEAM, isActive: true },
  ];
  state.matches = [{ id: 'mt1', clubId: CLUB, teamId: TEAM }];
  state.sessions = [{ id: 'ts1', clubId: CLUB, teamId: TEAM }];
  state.invitations = [{ id: 'inv1', clubId: CLUB, email: 'someone@fcf.test', role: MembershipRole.ANALYST, status: 'PENDING', expiresAt: new Date(Date.now() + 8.64e7), createdAt: new Date() }];
  state.platformAdmins = [{ userId: OWNER, role: 'PLATFORM_OWNER', isActive: true }];
  state.platformAudits = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Suspension keeps everything. This is the whole point.
// ─────────────────────────────────────────────────────────────────────────────

describe('deactivating a club deletes nothing', () => {
  test('every record the club owns is exactly where it was', async () => {
    const before = inventory();
    await lifecycle.deactivateClub(actor(OWNER), CLUB, 'Unpaid invoice');
    expect(inventory()).toEqual(before);
  });

  test('and archiving keeps just as much', async () => {
    const before = inventory();
    await lifecycle.archiveClub(actor(OWNER), CLUB, 'Season ended');
    expect(inventory()).toEqual(before);
  });

  test('the club row itself survives, with its state and its reason recorded', async () => {
    const out = await lifecycle.deactivateClub(actor(OWNER), CLUB, 'Unpaid invoice');
    expect(out.lifecycle).toBe(ClubLifecycle.DEACTIVATED);
    expect(out.previousLifecycle).toBe(ClubLifecycle.ACTIVE);
    expect(out.deactivatedAt).toBeInstanceOf(Date);
    expect(out.lifecycleChangedByUserId).toBe(OWNER);
    expect(out.lifecycleReason).toBe('Unpaid invoice');
    expect(state.clubs.find((c) => c.id === CLUB)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Coming back means coming back to what it was
// ─────────────────────────────────────────────────────────────────────────────

describe('reactivating and restoring', () => {
  test('reactivation returns the club and every membership untouched', async () => {
    const before = inventory();
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    const out = await lifecycle.reactivateClub(actor(OWNER), CLUB);
    expect(out.lifecycle).toBe(ClubLifecycle.ACTIVE);
    expect(out.previousLifecycle).toBeNull();
    expect(out.reactivatedAt).toBeInstanceOf(Date);
    // Nobody was re-invited and nothing was rebuilt: the same rows, the same
    // roles, the same team scopes.
    expect(inventory()).toEqual(before);
  });

  test('a club suspended while it was still awaiting a president comes back awaiting one', async () => {
    // The reason `previousLifecycle` exists. Coming back as ACTIVE would tell
    // the platform this club has an owner it does not have.
    await lifecycle.deactivateClub(actor(OWNER), OTHER);
    const out = await lifecycle.reactivateClub(actor(OWNER), OTHER);
    expect(out.lifecycle).toBe(ClubLifecycle.PRESIDENT_INVITED);
  });

  test('restoring an archived club returns it to the state it left', async () => {
    await lifecycle.archiveClub(actor(OWNER), EMPTY);
    const out = await lifecycle.restoreClub(actor(OWNER), EMPTY);
    expect(out.lifecycle).toBe(ClubLifecycle.PENDING_SETUP);
    expect(out.restoredAt).toBeInstanceOf(Date);
  });

  test('a club archived while deactivated restores to deactivated, not to active', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    await lifecycle.archiveClub(actor(OWNER), CLUB);
    const out = await lifecycle.restoreClub(actor(OWNER), CLUB);
    expect(out.lifecycle).toBe(ClubLifecycle.DEACTIVATED);
  });

  test('and the moves that make no sense are refused rather than guessed at', async () => {
    await expect(lifecycle.reactivateClub(actor(OWNER), CLUB)).rejects.toThrow(/not deactivated/i);
    await expect(lifecycle.restoreClub(actor(OWNER), CLUB)).rejects.toThrow(/not archived/i);
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    await expect(lifecycle.deactivateClub(actor(OWNER), CLUB)).rejects.toThrow(/already deactivated/i);
    await expect(lifecycle.restoreClub(actor(OWNER), CLUB)).rejects.toThrow(/not archived/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Only the platform may do any of it
// ─────────────────────────────────────────────────────────────────────────────

describe('a club role reaches none of this', () => {
  const everyAction = (userId: string) => [
    ['deactivate', () => lifecycle.deactivateClub(actor(userId), CLUB)],
    ['reactivate', () => lifecycle.reactivateClub(actor(userId), CLUB)],
    ['archive', () => lifecycle.archiveClub(actor(userId), CLUB)],
    ['restore', () => lifecycle.restoreClub(actor(userId), CLUB)],
    ['dependencies', () => lifecycle.clubDependencies(actor(userId), CLUB)],
    ['history', () => lifecycle.clubLifecycleHistory(actor(userId), CLUB)],
    ['delete', () => lifecycle.deleteClubForever(actor(userId), CLUB, { name: 'FC Familista' })],
  ] as const;

  test('the club president cannot deactivate, archive, restore or delete their own club', async () => {
    for (const [name, run] of everyAction(PRESIDENT)) {
      await expect(run()).rejects.toThrow(/platform owner/i);
      expect(`${name}: ${state.clubs.find((c) => c.id === CLUB)!.lifecycle}`).toBe(`${name}: ACTIVE`);
    }
  });

  test('nor can a head coach', async () => {
    for (const [, run] of everyAction(COACH)) await expect(run()).rejects.toThrow(/platform owner/i);
  });

  test('and being refused changes nothing at all', async () => {
    const before = inventory();
    for (const [, run] of everyAction(PRESIDENT)) await run().catch(() => null);
    expect(inventory()).toEqual(before);
    expect(state.platformAudits).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · A suspended club cannot be operated through the API either
// ─────────────────────────────────────────────────────────────────────────────
//
// The guard, driven over HTTP. Hiding the controls is not suspension; this is.

function guarded() {
  const app = express();
  app.use(express.json());
  app.use((req: Row, _res, next) => {
    const id = req.headers['x-test-user'];
    const u = state.users.find((x) => x.id === id);
    if (u) {
      req.user = {
        id: u.id, email: u.email, role: u.role, clubId: u.currentClubId ?? u.clubId,
        isPlatformOwner: state.platformAdmins.some((a) => a.userId === u.id && a.isActive),
      };
    }
    next();
  });
  app.use(requireOperableClub());
  app.all('*', (_req, res) => res.status(200).json({ reached: true }));
  app.use(errorHandler);
  return app;
}

describe('the API refuses a suspended club', () => {
  const call = (path: string, as: string) =>
    request(guarded()).get(path).set('x-test-user', as);

  test('a president is refused every club-scoped route once the club is deactivated', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    for (const path of ['/api/v1/players', '/api/v1/teams', '/api/v1/matches',
      '/api/v1/training', '/api/v1/transfer-market/bootstrap', '/api/v1/memberships']) {
      const res = await call(path, PRESIDENT);
      expect(`${path} → ${res.status}`).toBe(`${path} → 403`);
      expect(res.body.message || res.body.error).toMatch(/deactivated/i);
    }
  });

  test('and once it is archived', async () => {
    await lifecycle.archiveClub(actor(OWNER), CLUB);
    const res = await call('/api/v1/players', COACH);
    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error).toMatch(/archived/i);
  });

  test('but they can still sign in and read their own context, so they can be told why', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    for (const path of ['/api/v1/auth/me', '/api/v1/me/context', '/api/v1/me/settings']) {
      expect(`${path} → ${(await call(path, PRESIDENT)).status}`).toBe(`${path} → 200`);
    }
  });

  test('the platform owner still reaches everything, which is what inspection means', async () => {
    await lifecycle.archiveClub(actor(OWNER), CLUB);
    // Acting for the suspended club, with platform authority and no membership.
    state.users.find((u) => u.id === OWNER)!.currentClubId = CLUB;
    for (const path of ['/api/v1/players', '/api/v1/system/clubs', '/api/v1/teams']) {
      expect(`${path} → ${(await call(path, OWNER)).status}`).toBe(`${path} → 200`);
    }
  });

  test('and a healthy club is not touched by any of it', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    state.users.find((u) => u.id === PRESIDENT)!.currentClubId = OTHER;
    expect((await call('/api/v1/players', PRESIDENT)).status).toBe(200);
  });
});

describe('and cannot be entered', () => {
  test('switching into a deactivated club is refused, in words that say nothing was lost', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    await expect(switchContext({ userId: PRESIDENT }, CLUB, null)).rejects.toThrow(/deactivated/i);
  });

  test('the platform owner enters it anyway', async () => {
    await lifecycle.archiveClub(actor(OWNER), CLUB);
    const ctx: any = await switchContext({ userId: OWNER }, CLUB, null);
    expect(ctx.currentClubId).toBe(CLUB);
    expect(ctx.currentClubLifecycle).toBe('ARCHIVED');
    expect(ctx.currentClubSuspended).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · What each audience sees
// ─────────────────────────────────────────────────────────────────────────────

describe('what the listings show', () => {
  test('a deactivated club stays in its own people\'s list, with its state on it', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB);
    const ctx: any = await getContext(PRESIDENT);
    const here = ctx.availableClubs.find((c: Row) => c.id === CLUB);
    expect(here).toBeTruthy();
    expect(here.lifecycle).toBe('DEACTIVATED');
    expect(ctx.currentClubSuspended).toBe(true);
  });

  test('an archived club leaves the ordinary listing, and its memberships are untouched', async () => {
    const before = inventory();
    await lifecycle.archiveClub(actor(OWNER), CLUB);
    const ctx: any = await getContext(PRESIDENT);
    expect(ctx.availableClubs.map((c: Row) => c.id)).not.toContain(CLUB);
    expect(inventory()).toEqual(before);
  });

  test('and the platform owner sees every club in every state', async () => {
    await lifecycle.archiveClub(actor(OWNER), CLUB);
    await lifecycle.deactivateClub(actor(OWNER), OTHER);
    const ctx: any = await getContext(OWNER);
    expect(ctx.availableClubs.map((c: Row) => c.id).sort()).toEqual([CLUB, OTHER, EMPTY].sort());
  });
});

describe('SYSTEM is the authoritative view', () => {
  test('it reports the state, both timestamps, who changed it and why', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB, 'Unpaid invoice');
    const rows = await listClubs(actor(OWNER));
    const row = rows.find((r) => r.id === CLUB)!;
    expect(row.lifecycle).toBe('DEACTIVATED');
    expect(row.previousLifecycle).toBe('ACTIVE');
    expect(row.deactivatedAt).toBeInstanceOf(Date);
    expect(row.isOperable).toBe(false);
    expect(row.lifecycleChangedByUserId).toBe(OWNER);
    expect(row.lifecycleChangedByEmail).toBe('owner@familista.io');
    expect(row.lifecycleReason).toBe('Unpaid invoice');
    // And it still counts everything the club owns, which is the difference
    // between a suspended club and a deleted one.
    expect(row.teams).toBe(0); // groupBy is not emulated; the row is present
    expect(rows.map((r) => r.id).sort()).toEqual([CLUB, OTHER, EMPTY].sort());
  });

  test('the history says who moved it, when, from what, to what, and why', async () => {
    await lifecycle.deactivateClub(actor(OWNER), CLUB, 'Unpaid invoice');
    await lifecycle.reactivateClub(actor(OWNER), CLUB, 'Settled');
    const events = await lifecycle.clubLifecycleHistory(actor(OWNER), CLUB);
    expect(events.map((e) => `${e.from}→${e.to}`)).toEqual(['DEACTIVATED→ACTIVE', 'ACTIVE→DEACTIVATED']);
    expect(events[0].changedByEmail).toBe('owner@familista.io');
    expect(events[0].reason).toBe('Settled');
    expect(events[0].at).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Permanent deletion, which mostly refuses
// ─────────────────────────────────────────────────────────────────────────────

describe('permanent deletion', () => {
  test('the dependency preview counts real rows, and a zero is a zero', async () => {
    const deps = await lifecycle.clubDependencies(actor(OWNER), CLUB);
    expect(deps.counts.players).toBe(2);
    expect(deps.counts.memberships).toBe(2);
    expect(deps.counts.teams).toBe(1);
    expect(deps.counts.announcements).toBe(0);
    expect(deps.deletable).toBe(false);
    expect(deps.blockers.map((b) => b.kind)).toContain('players');
  });

  test('a club with anything in it is refused, and the refusal names what is in the way', async () => {
    await expect(lifecycle.deleteClubForever(actor(OWNER), CLUB, { name: 'FC Familista' }))
      .rejects.toThrow(/cannot be permanently deleted/i);
    await expect(lifecycle.deleteClubForever(actor(OWNER), CLUB, { name: 'FC Familista' }))
      .rejects.toThrow(/2 players|2 memberships/);
    expect(state.clubs.find((c) => c.id === CLUB)).toBeTruthy();
    expect(inventory().players).toBe(2);
  });

  test('the exact name is required, and the id is not a substitute for it', async () => {
    await expect(lifecycle.deleteClubForever(actor(OWNER), EMPTY, { name: '' }))
      .rejects.toThrow(/exact name/i);
    await expect(lifecycle.deleteClubForever(actor(OWNER), EMPTY, { name: 'familista berlin' }))
      .rejects.toThrow(/exact name/i);
    await expect(lifecycle.deleteClubForever(actor(OWNER), EMPTY, { name: EMPTY }))
      .rejects.toThrow(/exact name/i);
    expect(state.clubs.find((c) => c.id === EMPTY)).toBeTruthy();
  });

  test('an empty club, named exactly, by the platform owner, is deleted — and the record of it survives', async () => {
    const out = await lifecycle.deleteClubForever(actor(OWNER), EMPTY, { name: 'Familista berlin' });
    expect(out.deleted).toBe(true);
    expect(state.clubs.find((c) => c.id === EMPTY)).toBeUndefined();
    // The audit row outlives the club it describes.
    const record = state.platformAudits.find((a) => a.action === 'ClubDeletedPermanently')!;
    expect(record).toBeTruthy();
    expect(record.metadata.clubName).toBe('Familista berlin');
    expect(record.userId).toBe(OWNER);
  });

  test('every exported operation in the service asserts platform ownership itself', () => {
    // The SYSTEM router refuses a club role already, and the controllers pass
    // straight through to this service — so this is the wall that holds if any
    // of it is ever mounted somewhere else. `system-authority-gate` treats a
    // `lifecycle.*` call as guarded on the strength of this assertion, so it
    // has to be checked rather than assumed.
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'platform', 'club-lifecycle.service.ts'), 'utf8',
    );
    const exported = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    // The operations, as opposed to the predicates and the cache controls.
    const operations = exported.filter((n) => /^(deactivate|reactivate|archive|restore|delete|club)/.test(n));
    expect(operations.sort()).toEqual([
      'archiveClub', 'clubDependencies', 'clubLifecycleHistory', 'clubLifecycleOf',
      'clubLifecycleState', 'deactivateClub', 'deleteClubForever', 'reactivateClub', 'restoreClub',
    ]);
    for (const fn of operations) {
      // `clubLifecycleOf` is the guard's own read — it answers what state a
      // club is in and grants nothing, so it is the one that does not assert.
      if (fn === 'clubLifecycleOf') continue;
      const from = src.indexOf(`function ${fn}(`);
      const rest = src.indexOf('\nexport ', from + 1);
      const body = src.slice(from, rest > from ? rest : undefined);
      // Either it asserts, or it delegates to `transition`, which does.
      expect(`${fn}: ${/assertPlatformOwner|transition\(actor/.test(body)}`).toBe(`${fn}: true`);
    }
  });

  test('there is no force, no cascade and no way to ask for one', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'platform', 'club-lifecycle.service.ts'), 'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/force|cascade|deleteRelated|deleteMany/i);
    // Exactly one database delete in the whole file, and it is the club row.
    // (The memo's own `Map.delete` is not one, which is why this is anchored to
    // a Prisma model rather than to the word.)
    expect((code.match(/(?:tx|prisma)\.\w+\.delete\(/g) || []).length).toBe(1);
    expect(code).toContain('tx.club.delete({ where: { id: clubId } })');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · SYSTEM and the Clubs page report the same club the same way
// ─────────────────────────────────────────────────────────────────────────────
//
// Production found them disagreeing: a club whose `Club.lifecycle` in the
// database is ARCHIVED read ARCHIVED on the platform owner's CLUBS page and
// PENDING SETUP in SYSTEM > Clubs Management.
//
// The server was not the problem. `listClubs` selects `Club.lifecycle` and
// returns it verbatim, and `getContext` carries the same column into
// `availableClubs`; both are asserted below over the same club. The disagreement
// was one display default: SYSTEM's chip was a three-way ternary — ACTIVE,
// PRESIDENT_INVITED, and everything else — written when those were the only
// three states, and DEACTIVATED and ARCHIVED fell into "everything else",
// which was labelled PENDING SETUP.
//
// A status chip whose fallback names a state will eventually name the wrong
// one. These tests pin that it no longer does, and that the two surfaces agree.

describe('one club, one lifecycle, wherever it is read', () => {
  const ROOT = require('path').join(__dirname, '..');
  const read = (p: string) => require('fs').readFileSync(require('path').join(ROOT, p), 'utf8');

  /** The real `lifecycleChip` from SYSTEM, executed as it ships. */
  const systemChip = (() => {
    const src = read('public/system/system.js');
    const from = src.indexOf('var LIFECYCLE_CHIPS = {');
    const to = src.indexOf('// ── analytics ─');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const fn = new Function(`
      const esc = (v) => String(v == null ? '' : v);
      ${src.slice(from, to)}
      return lifecycleChip;
    `);
    return fn() as (life: unknown) => string;
  })();

  /** The real `_clubStateChip` from the owner's Clubs page, executed as it ships. */
  const ownerChip = (() => {
    const src = read('public/app.js');
    const from = src.indexOf('function _clubStateChip(c)');
    const to = src.indexOf('/**\n * The strongest membership role held in one club');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const fn = new Function(`${src.slice(from, to)} return _clubStateChip;`);
    return fn() as (c: Row) => { lifecycle: string; tone: string; label: string };
  })();

  const EVERY_STATE = [
    ClubLifecycle.PENDING_SETUP, ClubLifecycle.PRESIDENT_INVITED, ClubLifecycle.ACTIVE,
    ClubLifecycle.DEACTIVATED, ClubLifecycle.ARCHIVED,
  ];

  test('SYSTEM shows every lifecycle as itself, and never as another state', () => {
    for (const state of EVERY_STATE) {
      const html = systemChip(state);
      // The chip says the state it was given. ARCHIVED is the case that failed.
      expect(`${state} → ${html.replace(/<[^>]*>/g, '')}`)
        .toBe(`${state} → ${String(state).replace('_', ' ')}`);
    }
  });

  test('and a state it has never heard of shows as itself rather than as PENDING SETUP', () => {
    // The bug, in one line: the old chip named a state for values it did not
    // know. A future ClubLifecycle value must look wrong, not plausible.
    const html = systemChip('SOMETHING_NEW');
    expect(html).toContain('SOMETHING_NEW');
    expect(html).not.toContain('PENDING SETUP');
    expect(systemChip(null)).not.toContain('PENDING SETUP');
    expect(systemChip(undefined)).not.toContain('PENDING SETUP');
  });

  test('the two surfaces agree on every state', () => {
    for (const state of EVERY_STATE) {
      const inSystem = systemChip(state).replace(/<[^>]*>/g, '');
      const onClubsPage = ownerChip({ id: CLUB, lifecycle: state });
      // Different wording for different audiences — SYSTEM is an operator's
      // console and shouts the enum, the Clubs page reads as a product — but
      // they must be naming the SAME state.
      expect(`${state}: ${onClubsPage.lifecycle}`).toBe(`${state}: ${state}`);
      expect(`${state}: ${inSystem.replace(' ', '_')}`).toBe(`${state}: ${state}`);
    }
  });

  test('neither surface derives the lifecycle from ownership', () => {
    // Requirement, stated plainly: whether a club has a president is a
    // different fact, in a different column.
    const withPresident = ownerChip({ id: CLUB, lifecycle: 'ARCHIVED', hasOwner: true, isActive: true });
    const without = ownerChip({ id: CLUB, lifecycle: 'ARCHIVED', hasOwner: false });
    expect(withPresident.lifecycle).toBe('ARCHIVED');
    expect(without.lifecycle).toBe('ARCHIVED');

    const sys = read('public/system/system.js');
    const chip = sys.slice(sys.indexOf('var LIFECYCLE_CHIPS = {'), sys.indexOf('// ── analytics ─'));
    expect(chip).not.toMatch(/hasOwner|pendingPresidentEmail|membership/i);
    // And the ownership column is still its own column, beside the lifecycle one.
    expect(sys).toContain('<th>Club</th><th>Lifecycle</th>');
    expect(sys).toContain('<th>Ownership</th>');
    expect(sys).toContain("c.hasOwner");
  });

  test('the server hands both surfaces the same value for the same club', async () => {
    await lifecycle.archiveClub(actor(OWNER), CLUB, 'Season ended');

    // SYSTEM's read.
    const rows = await listClubs(actor(OWNER));
    const inSystem = rows.find((r) => r.id === CLUB)!.lifecycle;

    // The Clubs page's read, through the context that builds the picker.
    const ctx: any = await getContext(OWNER);
    const onClubsPage = ctx.availableClubs.find((c: Row) => c.id === CLUB).lifecycle;

    expect(inSystem).toBe('ARCHIVED');
    expect(onClubsPage).toBe('ARCHIVED');
    expect(inSystem).toBe(onClubsPage);
    // And it is the column, not a derivation: the club still has its president.
    expect(state.memberships.some((m) => m.clubId === CLUB && m.role === MembershipRole.CLUB_OWNER && m.isActive)).toBe(true);
  });

  test('every state the enum has agrees between the two reads', async () => {
    for (const target of [ClubLifecycle.DEACTIVATED, ClubLifecycle.ARCHIVED]) {
      state.clubs.find((c) => c.id === OTHER)!.lifecycle = target;
      lifecycle.forgetClubState();
      const rows = await listClubs(actor(OWNER));
      const ctx: any = await getContext(OWNER);
      const a = rows.find((r) => r.id === OTHER)!.lifecycle;
      const b = ctx.availableClubs.find((c: Row) => c.id === OTHER).lifecycle;
      expect(`${target}: ${a} / ${b}`).toBe(`${target}: ${target} / ${target}`);
    }
  });

  test("SYSTEM's cached club list is dropped when a lifecycle changes", () => {
    // `SY.clubs` is read once per SYSTEM session and reused. A club changed on
    // the Clubs page would otherwise keep reading here as whatever it was when
    // that list was fetched — stale rather than wrong, and indistinguishable
    // from the outside.
    const sys = read('public/system/system.js');
    const bind = sys.slice(sys.indexOf('function bind(host)'), sys.indexOf("host.addEventListener('click'"));
    expect(bind).toContain("familista:club-lifecycle-changed");
    expect(bind).toContain('SY.clubs = null;');

    const controls = read('public/club-lifecycle.js');
    expect(controls).toContain("new CustomEvent('familista:club-lifecycle-changed')");
    // Announced from the one place every lifecycle action funnels through.
    const refresh = controls.slice(controls.indexOf('function refresh()'), controls.indexOf('function post(path, body)'));
    expect(refresh).toContain('familista:club-lifecycle-changed');
  });
});
