/**
 * tests/platform-kernel-identity.unit.test.ts
 *
 * The platform kernel: who a person is, how they join a club, and what stops
 * when they leave it.
 *
 * The properties under test are the ones a club owner is trusting Familista
 * with: that inviting somebody never gives the inviter their password, that a
 * link works once and then never again, that a club cannot be left ownerless,
 * and that leaving a club ends the session without ending the account.
 */

import { MembershipRole, MembershipStatus } from '@prisma/client';
import { createHash } from 'crypto';

const CLUB = 'club-a';
const OTHER_CLUB = 'club-b';

type Row = Record<string, unknown>;

const state = {
  invitations: [] as Row[],
  memberships: [] as Row[],
  audits: [] as Row[],
  refreshTokens: [] as Row[],
  users: [
    { id: 'u-owner', email: 'owner@club.test', clubId: CLUB, currentClubId: CLUB, currentTeamId: null, tokenVersion: 0, isActive: true },
    { id: 'u-coach', email: 'coach@club.test', clubId: CLUB, currentClubId: CLUB, currentTeamId: 'team-a', tokenVersion: 0, isActive: true },
    { id: 'u-newbie', email: 'new@person.test', clubId: CLUB, currentClubId: null, currentTeamId: null, tokenVersion: 0, isActive: true },
  ] as Row[],
  teams: [
    { id: 'team-a', clubId: CLUB, name: 'First Team' },
    { id: 'team-foreign', clubId: OTHER_CLUB, name: 'Their First Team' },
  ] as Row[],
  clubs: [{ id: CLUB, name: 'HARTA BERLIN' }, { id: OTHER_CLUB, name: 'Elsewhere FC' }] as Row[],
  platformAdmins: [] as Row[],
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;
const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in (v as Row)) return row[k] !== (v as Row).not;
    if (v && typeof v === 'object' && 'gt' in (v as Row)) return (row[k] as Date) > ((v as Row).gt as Date);
    return row[k] === v;
  });

const tx = {
  clubInvitation: {
    create: async ({ data }: any) => { const r = { id: id('inv'), status: 'PENDING', acceptedAt: null, revokedAt: null, message: null, ...data }; state.invitations.push(r); return r; },
    update: async ({ where, data }: any) => { const r = state.invitations.find((x) => x.id === where.id)!; Object.assign(r, data); return r; },
    updateMany: async ({ where, data }: any) => {
      const rows = state.invitations.filter((r) => match(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  membership: {
    create: async ({ data }: any) => { const r = { id: id('mem'), status: 'ACTIVE', leftAt: null, ...data }; state.memberships.push(r); return r; },
    update: async ({ where, data }: any) => { const r = state.memberships.find((x) => x.id === where.id)!; Object.assign(r, data); return r; },
  },
  membershipAuditLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } },
  user: {
    findUnique: async ({ where }: any) => state.users.find((u) => u.id === where.id) ?? null,
    update: async ({ where, data }: any) => {
      const u = state.users.find((x) => x.id === where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as Row)) u[k] = (u[k] as number) + ((v as Row).increment as number);
        else u[k] = v;
      }
      return u;
    },
  },
  refreshToken: { deleteMany: async ({ where }: any) => { const before = state.refreshTokens.length; state.refreshTokens = state.refreshTokens.filter((t) => t.userId !== where.userId); return { count: before - state.refreshTokens.length }; } },
};

jest.mock('../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn)),
    clubInvitation: {
      ...tx.clubInvitation,
      findFirst: async ({ where }: any) => state.invitations.find((r) => match(r, where)) ?? null,
      findUnique: async ({ where }: any) =>
        state.invitations.find((r) => (where.id ? r.id === where.id : r.tokenHash === where.tokenHash)) ?? null,
      findMany: async ({ where = {} }: any = {}) => state.invitations.filter((r) => match(r, where)),
    },
    membership: {
      ...tx.membership,
      findFirst: async ({ where }: any) => state.memberships.find((r) => match(r, where)) ?? null,
      findUnique: async ({ where }: any) => state.memberships.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where = {} }: any = {}) => state.memberships.filter((r) => match(r, where)),
      count: async ({ where = {} }: any = {}) => state.memberships.filter((r) => match(r, where)).length,
    },
    membershipAuditLog: tx.membershipAuditLog,
    user: { ...tx.user, findUnique: async ({ where }: any) => state.users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null },
    team: { findUnique: async ({ where }: any) => state.teams.find((t) => t.id === where.id) ?? null },
    club: { findUnique: async ({ where }: any) => state.clubs.find((c) => c.id === where.id) ?? null },
    platformAdmin: { findUnique: async ({ where }: any) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null },
    refreshToken: tx.refreshToken,
  },
}));

import * as invites from '../src/identity/invitation.service';
import * as members from '../src/services/membership.service';
import { accessLevelOf, isPlatformOwner, describeAuthority } from '../src/platform/access-levels';
import { classify, ceilingFor, levelMayReach, atLeast } from '../src/platform/data-classification';

const owner = { userId: 'u-owner', clubId: CLUB };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  state.invitations = [];
  state.memberships = [
    { id: 'mem-owner', userId: 'u-owner', clubId: CLUB, teamId: null, role: 'CLUB_OWNER', isActive: true, status: 'ACTIVE', leftAt: null },
    { id: 'mem-coach', userId: 'u-coach', clubId: CLUB, teamId: 'team-a', role: 'HEAD_COACH', isActive: true, status: 'ACTIVE', leftAt: null },
  ];
  state.audits = [];
  state.refreshTokens = [{ token: 't1', userId: 'u-coach' }, { token: 't2', userId: 'u-coach' }];
  state.users.forEach((u) => { u.tokenVersion = 0; });
  const coach = state.users.find((u) => u.id === 'u-coach')!;
  coach.currentClubId = CLUB; coach.currentTeamId = 'team-a';
  state.platformAdmins = [];
});

describe('an invitation carries no credential, and works once', () => {
  it('stores only the hash of a token it returns exactly once', async () => {
    const { invitation, token } = await invites.createInvitation(owner, { email: 'New@Person.test', role: MembershipRole.ASSISTANT_COACH });
    expect(token).toHaveLength(43);                       // 32 random bytes, base64url
    const stored = state.invitations[0];
    expect(stored.tokenHash).toBe(sha(token));
    expect(JSON.stringify(stored)).not.toContain(token);   // the token itself is nowhere
    expect(JSON.stringify(invitation)).not.toContain(token);
    // No password field exists anywhere in the invitation record or its view.
    expect(JSON.stringify(stored).toLowerCase()).not.toMatch(/password|passwordhash|secret/);
    // The address is normalised, so one person is one invitation.
    expect(stored.email).toBe('new@person.test');
  });

  it('refuses a second pending invitation for the same address', async () => {
    await invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.ANALYST });
    await expect(invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.ANALYST }))
      .rejects.toThrow(/pending invitation/i);
  });

  it('refuses a team belonging to another club', async () => {
    await expect(invites.createInvitation(owner, { email: 'x@y.test', role: MembershipRole.ANALYST, teamId: 'team-foreign' }))
      .rejects.toThrow();
  });

  it('is accepted once, by the invited person, and then never again', async () => {
    const { token } = await invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.YOUTH_COACH, teamId: 'team-a' });

    // Somebody else holding the link cannot attach it to their own account.
    await expect(invites.acceptInvitation({ userId: 'u-coach', email: 'coach@club.test' }, token))
      .rejects.toThrow(/different email/i);

    const out = await invites.acceptInvitation({ userId: 'u-newbie', email: 'new@person.test' }, token);
    expect(out.clubId).toBe(CLUB);
    const granted = state.memberships.find((m) => m.id === out.membershipId)!;
    expect(granted).toMatchObject({ userId: 'u-newbie', clubId: CLUB, teamId: 'team-a', role: 'YOUTH_COACH', isActive: true });

    // Single use: the same link a second time is refused.
    await expect(invites.acceptInvitation({ userId: 'u-newbie', email: 'new@person.test' }, token))
      .rejects.toThrow(/already been used/i);
    expect(state.audits.some((a) => a.action === 'INVITE_ACCEPTED')).toBe(true);
  });

  it('expires, and says so rather than saying it is invalid', async () => {
    const { token } = await invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.SCOUT });
    state.invitations[0].expiresAt = new Date(Date.now() - 1000);
    await expect(invites.previewInvitation(token)).rejects.toThrow(/expired/i);
    await expect(invites.acceptInvitation({ userId: 'u-newbie', email: 'new@person.test' }, token)).rejects.toThrow(/expired/i);
  });

  it('resending retires the previous link', async () => {
    const first = await invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.SCOUT });
    const second = await invites.resendInvitation(owner, first.invitation.id);
    expect(second.token).not.toBe(first.token);
    await expect(invites.acceptInvitation({ userId: 'u-newbie', email: 'new@person.test' }, first.token)).rejects.toThrow();
    await expect(invites.acceptInvitation({ userId: 'u-newbie', email: 'new@person.test' }, second.token)).resolves.toBeTruthy();
  });

  it('revoking stops the link immediately', async () => {
    const { invitation, token } = await invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.SCOUT });
    await invites.revokeInvitation(owner, invitation.id, 'hired elsewhere');
    await expect(invites.acceptInvitation({ userId: 'u-newbie', email: 'new@person.test' }, token)).rejects.toThrow(/withdrawn/i);
  });

  it('and the preview tells the recipient only what the link is for', async () => {
    const { token } = await invites.createInvitation(owner, { email: 'new@person.test', role: MembershipRole.ANALYST, teamId: 'team-a' });
    const preview = await invites.previewInvitation(token);
    expect(preview).toMatchObject({ clubName: 'HARTA BERLIN', role: 'ANALYST', teamName: 'First Team', accountExists: true });
    // No squad, no member list, no club private data.
    expect(Object.keys(preview).sort()).toEqual(
      ['accountExists', 'clubId', 'clubName', 'email', 'expiresAt', 'message', 'role', 'teamId', 'teamName'],
    );
  });
});

describe('a club can never be left without an owner', () => {
  it('the last active owner cannot be removed, suspended or demoted', async () => {
    await expect(members.revokeMembership(owner, 'mem-owner')).rejects.toThrow(/last active owner/i);
    await expect(members.suspendMembership(owner, 'mem-owner')).rejects.toThrow(/last active owner/i);
    await expect(members.changeRole(owner, 'mem-owner', { role: MembershipRole.ANALYST })).rejects.toThrow(/last active owner/i);
  });

  it('but a second owner makes the first removable', async () => {
    state.memberships.push({ id: 'mem-owner2', userId: 'u-newbie', clubId: CLUB, teamId: null, role: 'CLUB_OWNER', isActive: true, status: 'ACTIVE', leftAt: null });
    await expect(members.revokeMembership(owner, 'mem-owner')).resolves.toBeUndefined();
    expect(state.memberships.find((m) => m.id === 'mem-owner')).toMatchObject({ isActive: false, status: 'REMOVED' });
  });
});

describe('leaving a club ends the session, not the account', () => {
  it('revocation clears the context and every refresh token, and bumps the token version', async () => {
    await members.revokeMembership(owner, 'mem-coach', 'contract ended');
    const coach = state.users.find((u) => u.id === 'u-coach')!;
    expect(coach.currentClubId).toBeNull();
    expect(coach.currentTeamId).toBeNull();
    expect(state.refreshTokens).toHaveLength(0);
    expect(coach.tokenVersion).toBe(1);
    // The identity survives: still a user, still active, password untouched.
    expect(coach.isActive).toBe(true);
    expect(Object.keys(coach)).not.toContain('passwordHash');
  });

  it('suspension does the same and keeps the row for reactivation', async () => {
    await members.suspendMembership(owner, 'mem-coach', 'season out');
    expect(state.memberships.find((m) => m.id === 'mem-coach')).toMatchObject({ isActive: false, status: MembershipStatus.SUSPENDED });
    expect(state.refreshTokens).toHaveLength(0);

    await members.reactivateMembership(owner, 'mem-coach');
    expect(state.memberships.find((m) => m.id === 'mem-coach')).toMatchObject({ isActive: true, status: MembershipStatus.ACTIVE, leftAt: null });
    expect(state.audits.some((a) => a.action === 'UNSUSPEND')).toBe(true);
  });

  it('a second membership in the same club keeps the session alive', async () => {
    state.memberships.push({ id: 'mem-coach2', userId: 'u-coach', clubId: CLUB, teamId: null, role: 'ANALYST', isActive: true, status: 'ACTIVE', leftAt: null });
    await members.revokeMembership(owner, 'mem-coach');
    const coach = state.users.find((u) => u.id === 'u-coach')!;
    expect(coach.currentClubId).toBe(CLUB);       // they still work here
    expect(state.refreshTokens).toHaveLength(2);
  });

  it('and a team can be moved without touching the person', async () => {
    await members.changeTeam(owner, 'mem-coach', null, 'promoted to club-wide');
    expect(state.memberships.find((m) => m.id === 'mem-coach')!.teamId).toBeNull();
    await expect(members.changeTeam(owner, 'mem-coach', 'team-foreign')).rejects.toThrow();
  });
});

describe('the four access levels', () => {
  it('a person with no membership is a viewer, in any club', async () => {
    expect(await accessLevelOf({ userId: 'u-newbie', clubId: CLUB })).toBe('VIEWER');
    expect(await accessLevelOf({ userId: 'u-coach', clubId: OTHER_CLUB })).toBe('VIEWER');
  });

  it('membership decides owner and staff', async () => {
    expect(await accessLevelOf({ userId: 'u-owner', clubId: CLUB })).toBe('CLUB_OWNER');
    expect(await accessLevelOf({ userId: 'u-coach', clubId: CLUB })).toBe('CLUB_STAFF');
  });

  it('platform authority is separate from club ownership, in both directions', async () => {
    // A club owner is not a platform owner.
    expect(await isPlatformOwner({ userId: 'u-owner', clubId: CLUB, role: 'CLUB_ADMIN' })).toBe(false);
    // A platform owner is not a club owner.
    state.platformAdmins.push({ userId: 'u-newbie', isActive: true });
    const authority = await describeAuthority({ userId: 'u-newbie', clubId: CLUB });
    expect(authority).toMatchObject({ level: 'PLATFORM_OWNER', isPlatformOwner: true, isClubOwner: false });
    // SUPER_ADMIN remains the platform role, so nothing had to be renamed.
    expect(await isPlatformOwner({ userId: 'nobody', role: 'SUPER_ADMIN' })).toBe(true);
  });

  it('and a viewer may operate nothing', async () => {
    const authority = await describeAuthority({ userId: 'u-newbie', clubId: CLUB });
    state.platformAdmins = [];
    expect((await describeAuthority({ userId: 'u-newbie', clubId: CLUB })).canOperate).toBe(false);
    expect(authority.level).toBeDefined();
  });
});

describe('data classification', () => {
  it('places each family where the contract puts it', () => {
    expect(classify('competition.standings')).toBe('PUBLIC');
    expect(classify('training.attendance')).toBe('INTERNAL');
    expect(classify('contract.player')).toBe('CONFIDENTIAL');
    expect(classify('medical.record')).toBe('RESTRICTED');
    expect(classify('player.minor-detail')).toBe('RESTRICTED');
    // An unknown resource is INTERNAL, never PUBLIC: a lookup fails towards
    // more privacy, not less.
    expect(classify('something.nobody.registered')).toBe('INTERNAL');
  });

  it('a viewer reaches public data and nothing else', () => {
    expect(ceilingFor('VIEWER')).toBe('PUBLIC');
    expect(levelMayReach('VIEWER', 'competition.results')).toBe(true);
    for (const resource of ['squad.roster', 'training.session', 'contract.player', 'medical.record']) {
      expect(`${resource}:${levelMayReach('VIEWER', resource)}`).toBe(`${resource}:false`);
    }
  });

  it('and restricted data is above every level\'s ceiling', () => {
    for (const level of ['VIEWER', 'CLUB_STAFF', 'CLUB_OWNER', 'PLATFORM_OWNER']) {
      expect(`${level}:${levelMayReach(level, 'medical.record')}`).toBe(`${level}:false`);
    }
    expect(atLeast('RESTRICTED', 'CONFIDENTIAL')).toBe(true);
    expect(atLeast('PUBLIC', 'INTERNAL')).toBe(false);
  });
});
