/**
 * tests/club-people-access.unit.test.ts
 *
 * A club invites its own staff, and nobody gets a password from anybody else.
 *
 * This covers the whole path: a president invites by email, the invitation is
 * bound to that club and to the teams the club picked, the person accepts and
 * chooses their own password, and from then on they reach exactly what the
 * membership says and nothing more. Then it covers taking it away again —
 * suspension, removal, and the two ways stale data used to hand access back.
 *
 * The rules that matter most here are the negative ones, and they are the ones
 * a screen cannot enforce:
 *
 *   · a coach scoped to one team never reaches another team, another club, or
 *     SYSTEM, whatever the client sends;
 *   · a club's last active owner cannot be removed, suspended or demoted;
 *   · a removed member does not get the club back because `User.clubId` still
 *     names it;
 *   · a club role — any of them — is never platform authority.
 */

import fs from 'fs';
import path from 'path';
import {
  MembershipRole, MembershipStatus, UserRole, ClubInvitationStatus,
} from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const OTHER_CLUB = 'club-elsewhere';
const T_FIRST = 'team-first';
const T_U13 = 'team-u13';
const T_U20 = 'team-u20';
const T_OTHER = 'team-other-club';

const state = {
  users: [] as Row[],
  memberships: [] as Row[],
  clubs: [] as Row[],
  teams: [] as Row[],
  invitations: [] as Row[],
  audits: [] as Row[],
  refreshTokens: [] as Row[],
  platformAdmins: [] as Row[],
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (k === 'AND') return (v as Row[]).every((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('in' in v) return ((v as Row).in as unknown[]).includes(row[k]);
      if ('gt' in v) return row[k] > (v as Row).gt;
      if ('lt' in v) return row[k] < (v as Row).lt;
    }
    return row[k] === v;
  });

const clubOf = (clubId: string) => state.clubs.find((c) => c.id === clubId) ?? null;

const db: Row = {
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      if (!u) return null;
      return { ...u, currentClub: clubOf(u.currentClubId), currentTeam: null, club: clubOf(u.clubId) };
    },
    findFirst: async ({ where = {} }: Row = {}) => state.users.find((u) => match(u, where)) ?? null,
    create: async ({ data }: Row) => {
      const u = { id: id('u'), isActive: true, tokenVersion: 0, lastLoginAt: null, avatar: null, ...data };
      state.users.push(u);
      // The real query includes the club, and the caller names it back.
      return { ...u, club: clubOf(u.clubId) };
    },
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as Row)) u[k] = (u[k] ?? 0) + (v as Row).increment;
        else u[k] = v;
      }
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
    findUnique: async ({ where }: Row) => state.memberships.find((m) => m.id === where.id) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
    create: async ({ data }: Row) => {
      const m = { id: id('m'), isActive: true, status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null, ...data };
      state.memberships.push(m);
      return m;
    },
    update: async ({ where, data }: Row) => {
      const m = state.memberships.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return m;
    },
  },
  club: { findUnique: async ({ where }: Row) => clubOf(where.id) },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.teams.filter((t) => match(t, where)),
  },
  clubInvitation: {
    findUnique: async ({ where }: Row) => state.invitations.find(
      (i) => (where.id ? i.id === where.id : i.tokenHash === where.tokenHash),
    ) ?? null,
    findFirst: async ({ where = {} }: Row = {}) => state.invitations.find((i) => match(i, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.invitations.filter((i) => match(i, where)),
    create: async ({ data }: Row) => {
      const i = {
        id: id('inv'), status: ClubInvitationStatus.PENDING, additionalTeamIds: [],
        deliveryState: 'CREATED', deliveryProvider: null, deliveryFailureCode: null,
        deliveryFailureClass: null, deliveryAttempts: 0, deliveryLocale: null,
        acceptedAt: null, acceptedByUserId: null, revokedAt: null, revokedByUserId: null,
        message: null, createdAt: new Date(), teamId: null, ...data,
      };
      state.invitations.push(i);
      return i;
    },
    update: async ({ where, data }: Row) => {
      const i = state.invitations.find((x) => x.id === where.id)!;
      Object.assign(i, data);
      return i;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = state.invitations.filter((i) => match(i, where));
      rows.forEach((i) => Object.assign(i, data));
      return { count: rows.length };
    },
  },
  membershipAuditLog: {
    create: async ({ data }: Row) => {
      const a = { id: id('a'), createdAt: new Date(), ...data };
      state.audits.push(a);
      return a;
    },
    findMany: async ({ where = {} }: Row = {}) => state.audits.filter((a) => match(a, where)),
    count: async ({ where = {} }: Row = {}) => state.audits.filter((a) => match(a, where)).length,
  },
  refreshToken: {
    deleteMany: async ({ where }: Row) => {
      const before = state.refreshTokens.length;
      state.refreshTokens = state.refreshTokens.filter((r) => !match(r, where));
      return { count: before - state.refreshTokens.length };
    },
    create: async ({ data }: Row) => { const r = { id: id('rt'), ...data }; state.refreshTokens.push(r); return r; },
  },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  player: { groupBy: async () => [] },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

// The mail adapter is not under test here; what IS under test is that the
// service records a delivery outcome and never hands the token to anything
// that stores it.
const delivered: Row[] = [];
jest.mock('../src/identity/invitation-mail.service', () => ({
  deliverInvitation: async (opts: Row) => {
    delivered.push({
      kind: opts.kind, email: opts.invitation.email, rawToken: opts.rawToken,
      teamId: opts.invitation.teamId, additionalTeamIds: opts.invitation.additionalTeamIds,
      resent: !!opts.resent,
    });
    return { state: 'SENT', provider: 'test', failureClass: null, failureCode: null, locale: 'en', notConfigured: false };
  },
  acceptanceUrl: (t: string) => `https://example.test/invite/accept?token=${encodeURIComponent(t)}`,
}));

import * as invites from '../src/identity/invitation.service';
import { resetInvitationThrottle } from '../src/identity/invitation-throttle';
import * as members from '../src/services/membership.service';
import * as ctx from '../src/services/context.service';
import * as teamAccess from '../src/identity/team-access.service';
import { isPlatformOwner } from '../src/platform/access-levels';
import { assertPlatformOwner } from '../src/platform/system.service';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PRESIDENT = 'u-president';
const OUTSIDER = 'u-outsider';

const actor = (userId: string, clubId = CLUB) => ({ userId, clubId, ipAddress: null, userAgent: null });

beforeEach(() => {
  seq = 0;
  delivered.length = 0;
  // The throttle is process-global by design — it is anti-abuse, not per
  // request. Left alone it carries one test's attempts into the next.
  resetInvitationThrottle();
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', defaultLocale: 'en-GB', isActive: true },
    { id: OTHER_CLUB, name: 'Another Club', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC', defaultLocale: 'en-GB', isActive: true },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', kind: 'FIRST_TEAM', isActive: true },
    { id: T_U13, clubId: CLUB, name: 'U13', kind: 'ACADEMY', isActive: true },
    { id: T_U20, clubId: CLUB, name: 'U20', kind: 'ACADEMY', isActive: true },
    { id: T_OTHER, clubId: OTHER_CLUB, name: 'Their First Team', kind: 'FIRST_TEAM', isActive: true },
  ];
  state.users = [
    { id: PRESIDENT, email: 'president@familista.test', role: UserRole.CLUB_ADMIN, clubId: CLUB, currentClubId: CLUB, currentTeamId: null, isActive: true, firstName: 'Test', lastName: 'President', tokenVersion: 0, lastLoginAt: null, avatar: null },
    { id: OUTSIDER, email: 'outsider@familista.test', role: UserRole.COACH, clubId: OTHER_CLUB, currentClubId: OTHER_CLUB, currentTeamId: null, isActive: true, firstName: 'Out', lastName: 'Sider', tokenVersion: 0, lastLoginAt: null, avatar: null },
  ];
  state.memberships = [
    { id: 'ms-president', userId: PRESIDENT, clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true, status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null },
  ];
  state.invitations = [];
  state.audits = [];
  state.refreshTokens = [];
  state.platformAdmins = [];
});

/** Invite somebody, and hand back the token the mail adapter was given. */
async function invite(dto: Row, by = PRESIDENT) {
  const out = await invites.createInvitation(actor(by), dto as any);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('a president invites staff, and only a president can', () => {
  it('creates a club-bound, team-bound invitation and sends it', async () => {
    const { invitation, token } = await invite({
      email: 'Coach@Example.COM ', role: MembershipRole.HEAD_COACH, teamIds: [T_U13],
    });

    // Normalised on the way in: one address is one invitation.
    expect(invitation.email).toBe('coach@example.com');
    expect(invitation.clubId).toBe(CLUB);
    expect(invitation.role).toBe(MembershipRole.HEAD_COACH);
    expect(invitation.teamIds).toEqual([T_U13]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].kind).toBe('STAFF');
    expect(delivered[0].rawToken).toBe(token);
  });

  it('stores only a hash of the token, never the token', async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    const row = state.invitations[0];

    expect(row.tokenHash).toBe(invites.hashInvitationToken(token));
    expect(row.tokenHash).not.toBe(token);
    // Nowhere on the row, under any column name.
    expect(JSON.stringify(row)).not.toContain(token);
    // Nor in anything the club can read back.
    const listed = await invites.listInvitations(CLUB);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(Object.keys(listed[0])).not.toContain('tokenHash');
    // Nor in the audit trail.
    expect(JSON.stringify(state.audits)).not.toContain(token);
  });

  it('refuses a team that belongs to another club', async () => {
    await expect(invite({ email: 'c@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_OTHER] }))
      .rejects.toThrow();
    expect(state.invitations).toHaveLength(0);
  });

  it('refuses a second live invitation to the same address', async () => {
    await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await expect(invite({ email: 'coach@example.com', role: MembershipRole.ANALYST, teamIds: [T_FIRST] }))
      .rejects.toThrow(/pending invitation/i);
  });

  it('and the route that creates one is closed to ordinary staff', () => {
    // The guard is the route's, not the screen's: club-admin authority on the
    // account AND a CLUB_ADMIN-or-stronger membership in the club now open.
    const routes = read('src/routes/invitation.routes.ts');
    for (const line of ['ctrl.create', 'ctrl.resend', 'ctrl.revoke', 'ctrl.list']) {
      const row = routes.split('\n').find((l) => l.includes(line))!;
      expect(`${line}: ${row.includes("authorize('CLUB_ADMIN'")}`).toBe(`${line}: true`);
      expect(`${line}: ${row.includes("requireMembership('CLUB_ADMIN')")}`).toBe(`${line}: true`);
    }
    // A head coach ranks below CLUB_ADMIN, so requireMembership refuses them.
    const tenant = read('src/middleware/tenant.middleware.ts');
    const rank = (r: string) => Number(tenant.match(new RegExp(`${r}:\\s*(\\d+)`))![1]);
    expect(rank('HEAD_COACH')).toBeLessThan(rank('CLUB_ADMIN'));
    expect(rank('CLUB_OWNER')).toBeGreaterThanOrEqual(rank('CLUB_ADMIN'));
  });

  it('and every membership write is closed to them too', () => {
    const routes = read('src/routes/membership.routes.ts');
    for (const line of ['ctrl.grant', 'ctrl.changeRole', 'ctrl.changeTeam', 'ctrl.suspend', 'ctrl.reactivate', 'ctrl.revoke']) {
      const row = routes.split('\n').find((l) => l.includes(line))!;
      expect(`${line}: ${row.includes("requireMembership('CLUB_ADMIN')")}`).toBe(`${line}: true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the token is single-use, expirable and revocable', () => {
  it('is consumed exactly once', async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await invites.registerAndAccept(token, { firstName: 'New', lastName: 'Coach', password: 'a-good-password' });

    await expect(invites.previewInvitation(token)).rejects.toThrow(/already been used/i);
  });

  it('is refused once expired', async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    state.invitations[0].expiresAt = new Date(Date.now() - 1000);
    await expect(invites.previewInvitation(token)).rejects.toThrow(/expired/i);
  });

  it('is refused once revoked', async () => {
    const { invitation, token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await invites.revokeInvitation(actor(PRESIDENT), invitation.id);
    await expect(invites.previewInvitation(token)).rejects.toThrow(/withdrawn/i);
  });

  it('and resending mints a new token that retires the old link', async () => {
    const { invitation, token: first } = await invite({
      email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13],
    });
    const { token: second } = await invites.resendInvitation(actor(PRESIDENT), invitation.id);

    expect(second).not.toBe(first);
    await expect(invites.previewInvitation(first)).rejects.toThrow();
    await expect(invites.previewInvitation(second)).resolves.toMatchObject({ clubId: CLUB });
    expect(delivered[1].resent).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('acceptance creates one account and the right memberships', () => {
  it('creates exactly one User, with a role that is not platform authority', async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    const before = state.users.length;
    await invites.registerAndAccept(token, { firstName: 'New', lastName: 'Coach', password: 'a-good-password' });

    expect(state.users.length).toBe(before + 1);
    const created = state.users.find((u) => u.email === 'coach@example.com')!;
    expect(created.role).not.toBe(UserRole.SUPER_ADMIN);
    expect(state.platformAdmins).toHaveLength(0);
  });

  it('creates the membership the invitation named, and only that', async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await invites.registerAndAccept(token, { firstName: 'New', lastName: 'Coach', password: 'a-good-password' });

    const coach = state.users.find((u) => u.email === 'coach@example.com')!;
    const mine = state.memberships.filter((m) => m.userId === coach.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ clubId: CLUB, teamId: T_U13, role: MembershipRole.HEAD_COACH, isActive: true });
  });

  it('creates one membership per team for a multi-team invitation, and no club-wide one', async () => {
    const { token } = await invite({
      email: 'analyst@example.com', role: MembershipRole.ANALYST, teamIds: [T_FIRST, T_U20],
    });
    await invites.registerAndAccept(token, { firstName: 'Multi', lastName: 'Team', password: 'a-good-password' });

    const u = state.users.find((x) => x.email === 'analyst@example.com')!;
    const mine = state.memberships.filter((m) => m.userId === u.id);
    expect(mine.map((m) => m.teamId).sort()).toEqual([T_FIRST, T_U20].sort());
    expect(mine.every((m) => m.role === MembershipRole.ANALYST)).toBe(true);
    // The escalation this must never take: a club-wide row "for convenience".
    expect(mine.some((m) => m.teamId === null)).toBe(false);
  });

  it('attaches to an existing account rather than making a second one', async () => {
    // The outsider already has a Familista account, from another club.
    const { token } = await invite({ email: 'outsider@familista.test', role: MembershipRole.SCOUT, teamIds: [T_U13] });
    const before = state.users.length;

    await invites.acceptInvitation(
      { userId: OUTSIDER, email: 'outsider@familista.test' }, token,
    );

    expect(state.users.length).toBe(before);
    expect(state.users.filter((u) => u.email === 'outsider@familista.test')).toHaveLength(1);
    // One person, two clubs — which is the point of a personal account.
    const mine = state.memberships.filter((m) => m.userId === OUTSIDER);
    expect(mine.map((m) => m.clubId)).toContain(CLUB);
  });

  it('and refuses a signed-in account whose address is not the invited one', async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await expect(invites.acceptInvitation(
      { userId: OUTSIDER, email: 'outsider@familista.test' }, token,
    )).rejects.toThrow(/different email/i);
  });

  it('and tells an existing account to sign in rather than registering twice', async () => {
    const { token } = await invite({ email: 'outsider@familista.test', role: MembershipRole.SCOUT, teamIds: [T_U13] });
    await expect(invites.registerAndAccept(token, { firstName: 'X', lastName: 'Y', password: 'a-good-password' }))
      .rejects.toThrow(/Sign in to accept/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a team-scoped coach reaches that team and nothing else', () => {
  let coachId: string;

  beforeEach(async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await invites.registerAndAccept(token, { firstName: 'New', lastName: 'Coach', password: 'a-good-password' });
    coachId = state.users.find((u) => u.email === 'coach@example.com')!.id;
  });

  const asCoach = () => ({ userId: coachId, clubId: CLUB, role: UserRole.HEAD_COACH });

  it('manages the team they were invited to', async () => {
    const a = await teamAccess.accessForTeam(asCoach(), T_U13);
    expect(a.canViewPrivate).toBe(true);
    expect(a.canManage).toBe(true);
    expect(a.reason).toBe('TEAM_ASSIGNMENT');
  });

  it('reaches no private content of any other team in the same club', async () => {
    for (const other of [T_FIRST, T_U20]) {
      const a = await teamAccess.accessForTeam(asCoach(), other);
      expect(`${other} private: ${a.canViewPrivate}`).toBe(`${other} private: false`);
      expect(`${other} manage: ${a.canManage}`).toBe(`${other} manage: false`);
      await expect(teamAccess.assertCanViewTeamPrivate(asCoach(), other)).rejects.toThrow();
      await expect(teamAccess.assertCanManageTeam(asCoach(), other)).rejects.toThrow();
    }
    // And the scope they get handed is exactly the one team.
    const scope = await teamAccess.privateTeamScope(asCoach());
    expect(scope.teamIds ?? []).toEqual([T_U13]);
  });

  it('reaches nothing in another club, even naming its team id', async () => {
    const a = await teamAccess.accessForTeam(asCoach(), T_OTHER);
    expect(a.level).toBe('NONE');
    expect(a.reason).toBe('OUTSIDE_CLUB');
    await expect(teamAccess.assertCanViewTeam(asCoach(), T_OTHER)).rejects.toThrow();
  });

  it('cannot switch context into a team they were not granted', async () => {
    // The escalation this closes: `registerInvitedUser` sets User.clubId to the
    // club, and the legacy fallback in switchContext used to let anybody whose
    // primary club matched pick ANY team in it.
    await expect(ctx.switchContext({ userId: coachId }, CLUB, T_FIRST))
      .rejects.toThrow(/No membership covers that team/i);
    await expect(ctx.switchContext({ userId: coachId }, CLUB, T_U13)).resolves.toBeTruthy();
  });

  it('cannot switch context into another club at all', async () => {
    await expect(ctx.switchContext({ userId: coachId }, OTHER_CLUB, null)).rejects.toThrow();
  });

  it('and is not the platform owner, whatever club role they hold', async () => {
    for (const role of [MembershipRole.CLUB_OWNER, MembershipRole.CLUB_ADMIN, MembershipRole.HEAD_COACH]) {
      state.memberships.push({
        id: id('m'), userId: coachId, clubId: CLUB, teamId: null, role,
        isActive: true, status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null,
      });
      expect(`${role}: ${await isPlatformOwner({ userId: coachId, role: UserRole.CLUB_ADMIN })}`).toBe(`${role}: false`);
      await expect(assertPlatformOwner({ userId: coachId, role: UserRole.CLUB_ADMIN })).rejects.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('taking access away actually takes it away', () => {
  let coachId: string;
  let membershipId: string;

  beforeEach(async () => {
    const { token } = await invite({ email: 'coach@example.com', role: MembershipRole.HEAD_COACH, teamIds: [T_U13] });
    await invites.registerAndAccept(token, { firstName: 'New', lastName: 'Coach', password: 'a-good-password' });
    coachId = state.users.find((u) => u.email === 'coach@example.com')!.id;
    membershipId = state.memberships.find((m) => m.userId === coachId)!.id;
    // They have signed in and entered the club: a session to end, and a
    // context pointing at the club. Both are what revocation has to clear.
    state.users.find((u) => u.id === coachId)!.currentClubId = CLUB;
    state.users.find((u) => u.id === coachId)!.currentTeamId = T_U13;
    state.refreshTokens.push({ userId: coachId, token: 'held' });
  });

  const asCoach = () => ({ userId: coachId, clubId: CLUB, role: UserRole.HEAD_COACH });

  it('suspension stops private team access and ends the session', async () => {
    await members.suspendMembership(actor(PRESIDENT), membershipId, 'season out');

    const a = await teamAccess.accessForTeam(asCoach(), T_U13);
    expect(a.canViewPrivate).toBe(false);
    expect(state.refreshTokens.filter((r) => r.userId === coachId)).toHaveLength(0);
    expect(state.users.find((u) => u.id === coachId)!.tokenVersion).toBe(1);
    expect(state.users.find((u) => u.id === coachId)!.currentClubId).toBeNull();
    // Suspended, not removed — the club can tell the two apart.
    expect(state.memberships.find((m) => m.id === membershipId)!.status).toBe(MembershipStatus.SUSPENDED);
  });

  it('reactivation gives it back, and the history is continuous', async () => {
    await members.suspendMembership(actor(PRESIDENT), membershipId);
    await members.reactivateMembership(actor(PRESIDENT), membershipId);

    const a = await teamAccess.accessForTeam(asCoach(), T_U13);
    expect(a.canManage).toBe(true);
    expect(state.audits.map((x) => x.action)).toEqual(
      expect.arrayContaining(['SUSPEND', 'UNSUSPEND']),
    );
  });

  it('removal stops access and leaves the personal account intact', async () => {
    await members.revokeMembership(actor(PRESIDENT), membershipId, 'left the club');

    const a = await teamAccess.accessForTeam(asCoach(), T_U13);
    expect(a.level).toBe('NONE');

    // The account is still there, still active, still theirs.
    const account = state.users.find((u) => u.id === coachId)!;
    expect(account).toBeTruthy();
    expect(account.isActive).toBe(true);
    expect(account.email).toBe('coach@example.com');
    expect(account.password ?? account.passwordHash).toBeDefined();
  });

  it('and a removed member does not get the club back from legacy data', async () => {
    // registerInvitedUser set User.clubId to this club, and that column is NOT
    // NULL so it cannot be cleared. It must not be a way back in.
    await members.revokeMembership(actor(PRESIDENT), membershipId);
    expect(state.users.find((u) => u.id === coachId)!.clubId).toBe(CLUB);

    await expect(ctx.switchContext({ userId: coachId }, CLUB, null))
      .rejects.toThrow(/No active membership/i);
    await expect(ctx.switchContext({ userId: coachId }, CLUB, T_U13))
      .rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a club cannot lose its last president by accident', () => {
  const lastOwner = () => state.memberships.find((m) => m.id === 'ms-president')!;

  it('refuses removal', async () => {
    await expect(members.revokeMembership(actor(PRESIDENT), 'ms-president')).rejects.toThrow(/last active owner/i);
    expect(lastOwner().isActive).toBe(true);
  });

  it('refuses suspension', async () => {
    await expect(members.suspendMembership(actor(PRESIDENT), 'ms-president')).rejects.toThrow(/last active owner/i);
    expect(lastOwner().isActive).toBe(true);
  });

  it('refuses a demotion, which empties the chair just as surely', async () => {
    await expect(members.changeRole(actor(PRESIDENT), 'ms-president', { role: MembershipRole.CLUB_ADMIN }))
      .rejects.toThrow(/last active owner/i);
    expect(lastOwner().role).toBe(MembershipRole.CLUB_OWNER);
  });

  it('and allows all three once the club has a second president', async () => {
    state.memberships.push({
      id: 'ms-second-owner', userId: OUTSIDER, clubId: CLUB, teamId: null,
      role: MembershipRole.CLUB_OWNER, isActive: true, status: MembershipStatus.ACTIVE,
      joinedAt: new Date(), leftAt: null,
    });
    await expect(members.changeRole(actor(PRESIDENT), 'ms-president', { role: MembershipRole.CLUB_ADMIN }))
      .resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the club screen shows what the server says, and offers only what it may', () => {
  const PA = read('public/people-access.js');
  const APP = read('public/app.js');

  it('is a club page, and reaches nothing platform-shaped', () => {
    // Not one SYSTEM route, page or platform control anywhere in the module.
    const code = PA.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const forbidden of ['/system', 'isPlatformOwner', 'PlatformAdmin', 'SUPER_ADMIN', 'Governance', 'Innovation Lab']) {
      expect(`${forbidden}: ${code.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    // And it is registered as an ordinary club page.
    expect(APP).toContain("'people-access': 1,");
    expect(APP).toContain("'people-access':               renderPeopleAccessHTML,");
    expect(APP).toContain("slug:    'people-access',");
  });

  it('takes the right to manage from the server, not from a client-set role', () => {
    const canManage = PA.slice(PA.indexOf('function canManage()'), PA.indexOf('function initials'));
    // The membership role the server reported for the club now open.
    expect(canManage).toContain('ctx.currentClubRole');
    expect(canManage).toContain('MANAGING.indexOf(role) >= 0');
    // Never User.role, which is the account field a client could hold anything in.
    expect(canManage).not.toMatch(/State\.user/);
    // Only two roles manage, and the list is written out rather than derived.
    expect(PA).toContain("var MANAGING = ['CLUB_OWNER', 'CLUB_ADMIN'];");
  });

  it('offers no management action to somebody who may not manage', () => {
    const row = PA.slice(PA.indexOf('function memberRow'), PA.indexOf('function btn'));
    // Every action is built inside `if (manage)`, so an ordinary staff member
    // gets a read-only list rather than disabled buttons.
    expect(row).toMatch(/var actions = '';\s*\n\s*if \(manage\) \{/);
    for (const action of ['paChangeRole', 'paChangeTeam', 'paSuspend', 'paRemove', 'paReactivate']) {
      const at = row.indexOf(action);
      expect(`${action} present: ${at > 0}`).toBe(`${action} present: true`);
      expect(`${action} inside the guard: ${at > row.indexOf('if (manage) {')}`).toBe(`${action} inside the guard: true`);
    }
    const invitesTab = PA.slice(PA.indexOf('function invitationsTab'), PA.indexOf('function teamsTab'));
    expect(invitesTab).toMatch(/if \(manage && v\.status === 'PENDING'\)/);
  });

  it('never shows a token, and never asks anybody for a password', () => {
    const code = PA.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    // The word "password" IS in this module — in the sentence promising the
    // invited person picks their own and nobody at the club sees it. What must
    // not exist is a field that collects one, or any use of a token value.
    for (const forbidden of ['tokenHash', '.token', 'rawToken', 'acceptUrl', 'invite/accept']) {
      expect(`${forbidden}: ${code.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    expect(code).not.toMatch(/type=.password|name=.password|\.password\b/);
    // The invite form collects a name, an address, a role and a scope. Nothing else.
    const form = PA.slice(PA.indexOf('function openInvite'), PA.indexOf('function field('));
    expect(form).toContain('name="firstName"');
    expect(form).toContain('name="email"');
    expect(form).toContain('name="role"');
    expect(form).toContain('name="scope"');
    expect(form).not.toMatch(/type="password"/);
  });

  it('uses Familista panels for destructive actions, never a browser dialog', () => {
    const code = PA.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(code).not.toMatch(/\bwindow\.confirm\(|[^.\w]confirm\(|[^.\w]alert\(|[^.\w]prompt\(/);
    expect(PA).toContain('function confirmAction(opts)');
    // And a destructive action is confirmed before it is sent.
    for (const handler of ['paSuspend', 'paRemove', 'paRevoke', 'paResend']) {
      const block = PA.slice(PA.indexOf(`    ${handler}: function`), PA.indexOf(`    ${handler}: function`) + 900);
      expect(`${handler} confirms: ${block.includes('confirmAction(')}`).toBe(`${handler} confirms: true`);
    }
  });

  it('has a loading state, an empty state and a skeleton for every tab', () => {
    const NEXT: Record<string, string> = {
      membersTab: 'function memberRow', invitationsTab: 'function teamsTab',
      teamsTab: 'function teamBlock', auditTab: 'var TABS',
    };
    for (const tab of ['membersTab', 'invitationsTab', 'teamsTab', 'auditTab']) {
      const from = PA.indexOf(`function ${tab}`);
      const to = PA.indexOf(NEXT[tab]);
      expect(`${tab} bounds: ${from >= 0 && to > from}`).toBe(`${tab} bounds: true`);
      const block = PA.slice(from, to);
      expect(`${tab} skeleton: ${block.includes('skeleton(')}`).toBe(`${tab} skeleton: true`);
      expect(`${tab} empty: ${block.includes('empty(')}`).toBe(`${tab} empty: true`);
    }
    const css = read('public/app.css');
    // A skeleton is the size of the row it stands in for, so nothing jumps.
    expect(css).toMatch(/\.pa-skel-row\{[\s\S]*?height:66px/);
    // The panel is fixed and animates on opacity and transform only.
    expect(css).toMatch(/\.pa-scrim\{[\s\S]*?position:fixed/);
    expect(css).toMatch(/\.pa-panel\{[\s\S]*?transition:transform/);
    // And it is responsive.
    expect(css).toContain('@media (max-width:680px)');
  });

  it('names club and person data as data, so nothing translates a name', () => {
    for (const marker of ['pa-name', 'pa-mail', 'pa-team-n', 'pa-tm-n', 'pa-subject']) {
      const at = PA.indexOf(`class="${marker}"`);
      expect(`${marker} present: ${at > 0}`).toBe(`${marker} present: true`);
    }
    // Every one of those cells carries data-user-content.
    expect((PA.match(/data-user-content/g) || []).length).toBeGreaterThanOrEqual(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the platform owner is untouched by any of this', () => {
  it('is still an explicit platform assignment and nothing else', async () => {
    state.platformAdmins.push({ userId: PRESIDENT, isActive: true, role: 'OWNER' });
    expect(await isPlatformOwner({ userId: PRESIDENT, role: UserRole.CLUB_ADMIN })).toBe(true);

    state.platformAdmins.length = 0;
    // Still the club's owner. Still not the platform's.
    expect(state.memberships.find((m) => m.id === 'ms-president')!.role).toBe(MembershipRole.CLUB_OWNER);
    expect(await isPlatformOwner({ userId: PRESIDENT, role: UserRole.CLUB_ADMIN })).toBe(false);
  });

  it('and no invitation can mint one', () => {
    const svc = read('src/identity/invitation.service.ts');
    expect(svc).toContain('function accountRoleFor');
    expect(svc).not.toMatch(/platformAdmin\.(create|upsert|update)/);
    // The one branch that could have produced it, explicitly closed.
    expect(svc).toMatch(/Nobody gets SUPER_ADMIN/);
    const acct = svc.slice(svc.indexOf('function accountRoleFor'));
    expect(acct).toContain("String(role) !== 'SUPER_ADMIN'");
  });
});
