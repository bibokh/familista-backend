/**
 * tests/club-onboarding.unit.test.ts
 *
 * Bringing a club onto Familista without coming to own it.
 *
 * The workflow has one property that matters more than all the others, and it
 * is the one that is easiest to break by accident: the platform owner creates
 * the club and never becomes its president. Not permanently, not temporarily,
 * not "just until the invitation is accepted". So the first thing these tests
 * do after every successful creation is look for a membership belonging to the
 * platform owner, and fail if one exists.
 *
 * The rest follows from that. A club with no owner cannot be a healthy active
 * club, so it is PENDING_SETUP; an invitation that has not been accepted is not
 * an owner, so the club stays PENDING; and activation is a fact checked against
 * membership rows rather than a step somebody remembered to call.
 *
 * The database is a small in-memory stand-in with real semantics for the parts
 * under test: unique invitation token hashes, conditional updates that consume
 * a row exactly once, and relation filters on club membership.
 */

import { ClubInvitationStatus, ClubLifecycle, MembershipRole } from '@prisma/client';
import { createHash } from 'crypto';

type Row = Record<string, any>;

const PLATFORM_OWNER = 'u-platform-owner';
const PRESIDENT_CANDIDATE = 'president@newclub.test';
const EXISTING_CLUB = 'club-existing';

const state = {
  clubs: [] as Row[],
  users: [] as Row[],
  memberships: [] as Row[],
  invitations: [] as Row[],
  memberAudits: [] as Row[],
  platformAudits: [] as Row[],
  platformAdmins: [] as Row[],
  /** Set to a message to make the next invitation create throw. */
  breakInvitationCreate: null as string | null,
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const cmp = (actual: unknown, expected: any): boolean => {
  if (expected === undefined) return true;
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('not' in expected) return !cmp(actual, expected.not);
    if ('in' in expected) return (expected.in as unknown[]).includes(actual);
    if ('gt' in expected) return (actual as Date) > expected.gt;
    if ('gte' in expected) return (actual as Date) >= expected.gte;
    if ('lt' in expected) return (actual as Date) < expected.lt;
    if ('lte' in expected) return (actual as Date) <= expected.lte;
  }
  return actual === expected;
};

const matchMembership = (m: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => cmp(m[k], v));

const matchInvitation = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => cmp(r[k], v));

const matchClub = (c: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'memberships') {
      const rows = state.memberships.filter((m) => m.clubId === c.id);
      if ((v as Row).some) return rows.some((m) => matchMembership(m, (v as Row).some));
      if ((v as Row).none) return !rows.some((m) => matchMembership(m, (v as Row).none));
      return true;
    }
    if (k === 'invitations') {
      const rows = state.invitations.filter((r) => r.clubId === c.id);
      if ((v as Row).some) return rows.some((r) => matchInvitation(r, (v as Row).some));
      if ((v as Row).none) return !rows.some((r) => matchInvitation(r, (v as Row).none));
      return true;
    }
    return cmp(c[k], v);
  });

const withUser = (m: Row) => ({
  ...m,
  user: state.users.find((u) => u.id === m.userId) ?? null,
});

const db: Row = {
  club: {
    create: async ({ data }: Row) => {
      const row = { id: id('club'), lifecycle: 'ACTIVE', activatedAt: null, createdAt: new Date(), ...data };
      state.clubs.push(row);
      return row;
    },
    findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null,
    findFirst: async ({ where }: Row) => state.clubs.find((c) => matchClub(c, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.clubs.filter((c) => matchClub(c, where)),
    count: async ({ where = {} }: Row = {}) => state.clubs.filter((c) => matchClub(c, where)).length,
    update: async ({ where, data }: Row) => {
      const c = state.clubs.find((x) => x.id === where.id)!;
      Object.assign(c, data);
      return c;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = state.clubs.filter((c) => matchClub(c, where));
      rows.forEach((c) => Object.assign(c, data));
      return { count: rows.length };
    },
  },
  membership: {
    create: async ({ data }: Row) => {
      const row = { id: id('mem'), status: 'ACTIVE', isActive: true, leftAt: null, createdAt: new Date(), ...data };
      state.memberships.push(row);
      return row;
    },
    findFirst: async ({ where }: Row) => {
      const hit = state.memberships.find((m) => matchMembership(m, where));
      return hit ? withUser(hit) : null;
    },
    findMany: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => matchMembership(m, where)).map(withUser),
    findUnique: async ({ where }: Row) => state.memberships.find((m) => m.id === where.id) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => matchMembership(m, where)).length,
    update: async ({ where, data }: Row) => {
      const m = state.memberships.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return m;
    },
  },
  clubInvitation: {
    create: async ({ data }: Row) => {
      if (state.breakInvitationCreate) throw new Error(state.breakInvitationCreate);
      if (state.invitations.some((r) => r.tokenHash === data.tokenHash)) throw new Error('unique tokenHash');
      const row = {
        id: id('inv'), status: 'PENDING', acceptedAt: null, acceptedByUserId: null,
        revokedAt: null, revokedByUserId: null, message: null, teamId: null,
        createdAt: new Date(), ...data,
      };
      state.invitations.push(row);
      return row;
    },
    findFirst: async ({ where, orderBy }: Row) => {
      let rows = state.invitations.filter((r) => matchInvitation(r, where));
      if (orderBy?.createdAt === 'desc') rows = [...rows].reverse();
      return rows[0] ?? null;
    },
    findUnique: async ({ where }: Row) =>
      state.invitations.find((r) => (where.id ? r.id === where.id : r.tokenHash === where.tokenHash)) ?? null,
    findMany: async ({ where = {}, orderBy }: Row = {}) => {
      let rows = state.invitations.filter((r) => matchInvitation(r, where));
      if (orderBy?.createdAt === 'desc') rows = [...rows].reverse();
      return rows;
    },
    count: async ({ where = {} }: Row = {}) => state.invitations.filter((r) => matchInvitation(r, where)).length,
    update: async ({ where, data }: Row) => {
      const r = state.invitations.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = state.invitations.filter((r) => matchInvitation(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  user: {
    findUnique: async ({ where }: Row) =>
      state.users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
    count: async () => state.users.length,
  },
  team: { findUnique: async () => null },
  membershipAuditLog: { create: async ({ data }: Row) => { state.memberAudits.push(data); return data; } },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
    count: async () => state.platformAdmins.filter((a) => a.isActive).length,
  },
  platformAuditLog: { create: async ({ data }: Row) => { state.platformAudits.push(data); return data; } },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import * as onboarding from '../src/platform/club-onboarding.service';
import * as invites from '../src/identity/invitation.service';
import { ForbiddenError } from '../src/utils/errors';

const OWNER = { userId: PLATFORM_OWNER, clubId: null, role: 'SUPER_ADMIN' };
const CLUB_PRESIDENT = { userId: 'u-club-president', clubId: EXISTING_CLUB, role: 'CLUB_ADMIN' };
const CLUB_STAFF = { userId: 'u-staff', clubId: EXISTING_CLUB, role: 'COACH' };
const NORMAL_USER = { userId: 'u-normal', clubId: null, role: 'COACH' };

const DTO = {
  name: 'SV Neustadt',
  city: 'Neustadt',
  country: 'Germany',
  timezone: 'Europe/Berlin',
  defaultLocale: 'de-DE',
  president: { firstName: 'Alina', lastName: 'Braun', email: PRESIDENT_CANDIDATE },
};

beforeEach(() => {
  seq = 0;
  state.breakInvitationCreate = null;
  state.clubs = [{ id: EXISTING_CLUB, name: 'HARTA BERLIN', city: 'Berlin', lifecycle: 'ACTIVE', activatedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') }];
  state.users = [
    { id: PLATFORM_OWNER, email: 'owner@familista.app', firstName: 'Platform', lastName: 'Owner', isActive: true },
    { id: 'u-club-president', email: 'president@harta.test', firstName: 'Club', lastName: 'President', isActive: true },
    { id: 'u-staff', email: 'coach@harta.test', firstName: 'Head', lastName: 'Coach', isActive: true },
    { id: 'u-normal', email: 'nobody@elsewhere.test', firstName: 'No', lastName: 'Body', isActive: true },
    { id: 'u-candidate', email: PRESIDENT_CANDIDATE, firstName: 'Alina', lastName: 'Braun', isActive: true },
  ];
  state.memberships = [
    { id: 'mem-existing-owner', userId: 'u-club-president', clubId: EXISTING_CLUB, teamId: null, role: 'CLUB_OWNER', isActive: true, status: 'ACTIVE', createdAt: new Date() },
    { id: 'mem-existing-staff', userId: 'u-staff', clubId: EXISTING_CLUB, teamId: 'team-a', role: 'HEAD_COACH', isActive: true, status: 'ACTIVE', createdAt: new Date() },
  ];
  state.invitations = [];
  state.memberAudits = [];
  state.platformAudits = [];
  state.platformAdmins = [{ id: 'padmin-1', userId: PLATFORM_OWNER, isActive: true, role: 'PLATFORM_OWNER' }];
});

const ownerMemberships = () => state.memberships.filter((m) => m.userId === PLATFORM_OWNER);
const auditActions = () => state.platformAudits.map((a) => a.action);

// ─────────────────────────────────────────────────────────────────────────────
// 1–5 · who may create a club, and what creating one does NOT do
// ─────────────────────────────────────────────────────────────────────────────

describe('only the platform owner brings a club onto the platform', () => {
  it('1 · the platform owner creates a club, and it is pending, not active', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);

    const club = state.clubs.find((c) => c.id === out.clubId)!;
    expect(club.lifecycle).toBe(ClubLifecycle.PRESIDENT_INVITED);
    expect(club.activatedAt).toBeNull();
    expect(club.defaultLocale).toBe('de-DE');
    expect(club.timezone).toBe('Europe/Berlin');

    expect(out.setup.steps).toEqual({
      clubCreated: true, presidentInvited: true, presidentAccepted: false, clubActivated: false,
    });
    expect(out.setup.blocking).toMatch(/has not accepted/i);
  });

  it('2 · a club president cannot create a club through SYSTEM', async () => {
    await expect(onboarding.createClubWithPresidentInvite(CLUB_PRESIDENT as never, DTO))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(state.clubs).toHaveLength(1);
  });

  it('3 · club staff cannot', async () => {
    await expect(onboarding.createClubWithPresidentInvite(CLUB_STAFF as never, DTO))
      .rejects.toThrow(ForbiddenError);
    expect(state.clubs).toHaveLength(1);
  });

  it('4 · a normal user with no membership cannot', async () => {
    await expect(onboarding.createClubWithPresidentInvite(NORMAL_USER as never, DTO))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(state.clubs).toHaveLength(1);
    expect(state.invitations).toHaveLength(0);
  });

  it('5 · the platform owner is NOT made the club owner — not even temporarily', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);

    // No membership of any kind, in the new club or anywhere else.
    expect(ownerMemberships()).toEqual([]);
    expect(state.memberships.filter((m) => m.clubId === out.clubId)).toEqual([]);

    // And the source has no path that could create one.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/platform/club-onboarding.service.ts'), 'utf8');
    expect(src).not.toMatch(/membership\.create|grantMembership/);
    expect(src).not.toContain('createClubWithOwnerMembership');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6–8 · the invitation, and what accepting it does
// ─────────────────────────────────────────────────────────────────────────────

describe('the president is invited, never appointed', () => {
  it('6 · the invitation is created for the named address, as CLUB_OWNER', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    expect(state.invitations).toHaveLength(1);
    const inv = state.invitations[0];
    expect(inv.clubId).toBe(out.clubId);
    expect(inv.email).toBe(PRESIDENT_CANDIDATE);
    expect(inv.role).toBe(MembershipRole.CLUB_OWNER);
    expect(inv.teamId).toBeNull();
    expect(inv.invitedByUserId).toBe(PLATFORM_OWNER);

    // Delivery tells the truth, and there are now three truths to tell rather
    // than one: SENT, FAILED, or nothing was even attempted. This suite runs
    // with no provider configured, so it is the third — and "not configured"
    // is deliberately a different answer from "we tried and it bounced".
    expect(out.delivery.status).toBe('NOT_CONFIGURED');
    expect(out.delivery.detail).toMatch(/EMAIL DELIVERY NOT CONFIGURED/);
    // And the invitation is untouched by that: valid, and its own link is
    // handed back precisely because no email carried it.
    expect(out.token).toHaveLength(43);
  });

  it('7 · the token is hashed, expiring, single-use and revocable', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    const inv = state.invitations[0];

    // Only the hash is stored. The raw token is returned once and nowhere else.
    expect(inv.tokenHash).toBe(createHash('sha256').update(out.token).digest('hex'));
    expect(JSON.stringify(state.invitations)).not.toContain(out.token);
    expect(JSON.stringify(out.invitation)).not.toContain(out.token);
    expect(out.token).toHaveLength(43);                       // 32 random bytes

    // Expiring.
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(inv.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 24 * 3600 * 1000 + 1000);

    // Single-use: the second acceptance of the same token is refused.
    await invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token);
    await expect(invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token))
      .rejects.toThrow(/already been used/i);
  });

  it('and a revoked invitation stops working immediately', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    await onboarding.revokePresidentInvite(OWNER, out.clubId, 'Wrong person');

    expect(state.invitations[0].status).toBe(ClubInvitationStatus.REVOKED);
    await expect(invites.previewInvitation(out.token)).rejects.toThrow(/withdrawn/i);
    // And the club is back to having nobody on the way.
    expect(state.clubs.find((c) => c.id === out.clubId)!.lifecycle).toBe(ClubLifecycle.PENDING_SETUP);
    expect(auditActions()).toContain('ClubPresidentInvitationRevoked');
  });

  it('resending mints a new link and retires the old one', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    const again = await onboarding.resendPresidentInvite(OWNER, out.clubId);

    expect(again.token).not.toBe(out.token);
    await expect(invites.previewInvitation(out.token)).rejects.toThrow();
    await expect(invites.previewInvitation(again.token)).resolves.toMatchObject({ email: PRESIDENT_CANDIDATE });
    expect(auditActions()).toContain('ClubPresidentInvitationResent');
  });

  it('8 · accepting creates an active CLUB_OWNER membership for that person', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    const accepted = await invites.acceptInvitation(
      { userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token);

    const membership = state.memberships.find((m) => m.id === accepted.membershipId)!;
    expect(membership).toMatchObject({
      userId: 'u-candidate', clubId: out.clubId, teamId: null,
      role: MembershipRole.CLUB_OWNER, isActive: true,
    });
    // The platform owner still owns nothing.
    expect(ownerMemberships()).toEqual([]);
  });

  it('and an invitation is an offer to one person, not a transferable ticket', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    await expect(invites.acceptInvitation({ userId: 'u-normal', email: 'nobody@elsewhere.test' }, out.token))
      .rejects.toThrow(/different email address/i);
    expect(state.memberships.filter((m) => m.clubId === out.clubId)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9–11 · activation, retries and failure
// ─────────────────────────────────────────────────────────────────────────────

describe('a club activates on a fact, not on a step somebody remembered', () => {
  it('9 · it activates only once there is an active CLUB_OWNER', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);

    // Before acceptance: activation is a no-op, and says why.
    const early = await onboarding.activateIfReady(out.clubId);
    expect(early.steps.clubActivated).toBe(false);
    expect(state.clubs.find((c) => c.id === out.clubId)!.lifecycle).toBe(ClubLifecycle.PRESIDENT_INVITED);
    expect(auditActions()).not.toContain('ClubActivated');

    await invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token);

    const after = await onboarding.activateIfReady(out.clubId);
    expect(after.steps).toEqual({
      clubCreated: true, presidentInvited: true, presidentAccepted: true, clubActivated: true,
    });
    expect(after.blocking).toBeNull();
    const club = state.clubs.find((c) => c.id === out.clubId)!;
    expect(club.lifecycle).toBe(ClubLifecycle.ACTIVE);
    expect(club.activatedAt).toBeInstanceOf(Date);
    expect(auditActions()).toContain('ClubActivated');
  });

  it('and a suspended president does not keep a club active-able', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    const accepted = await invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token);
    // Suspend the membership before anything reconciles.
    state.memberships.find((m) => m.id === accepted.membershipId)!.status = 'SUSPENDED';

    const setup = await onboarding.activateIfReady(out.clubId);
    expect(setup.steps.clubActivated).toBe(false);
    expect(state.clubs.find((c) => c.id === out.clubId)!.lifecycle).toBe(ClubLifecycle.PRESIDENT_INVITED);
  });

  it('10 · a retry creates no second club, no second invitation, no second owner', async () => {
    const first = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    const retry = await onboarding.createClubWithPresidentInvite(OWNER, DTO);

    expect(retry.idempotentHit).toBe(true);
    expect(retry.clubId).toBe(first.clubId);
    expect(state.clubs.filter((c) => c.name === DTO.name)).toHaveLength(1);
    expect(state.invitations).toHaveLength(1);
    // A retry mints nothing: the link that works is the one already issued.
    expect(retry.token).toBe('');

    // And activating twice writes one activation.
    await invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, first.token);
    await onboarding.activateIfReady(first.clubId);
    await onboarding.activateIfReady(first.clubId);
    expect(auditActions().filter((a) => a === 'ClubActivated')).toHaveLength(1);
    expect(state.memberships.filter((m) => m.clubId === first.clubId && m.role === 'CLUB_OWNER')).toHaveLength(1);
  });

  it('11 · a failed invitation never leaves a club looking healthy and active', async () => {
    state.breakInvitationCreate = 'mail table unavailable';
    await expect(onboarding.createClubWithPresidentInvite(OWNER, DTO)).rejects.toThrow(/mail table unavailable/);

    const club = state.clubs.find((c) => c.name === DTO.name);
    expect(club).toBeDefined();
    // It exists, and it is unmistakably incomplete: pending, unowned, no
    // invitation, and the failure is on the record.
    expect(club!.lifecycle).toBe(ClubLifecycle.PENDING_SETUP);
    expect(club!.activatedAt).toBeNull();
    expect(state.memberships.filter((m) => m.clubId === club!.id)).toEqual([]);
    expect(state.invitations).toEqual([]);
    expect(auditActions()).toContain('ClubPresidentInviteFailed');

    const setup = await onboarding.clubSetupState(club!.id);
    expect(setup.steps).toEqual({
      clubCreated: true, presidentInvited: false, presidentAccepted: false, clubActivated: false,
    });
    expect(setup.blocking).toMatch(/no president has been invited/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12–13 · boundaries, and everything that was already there
// ─────────────────────────────────────────────────────────────────────────────

describe('the boundaries hold', () => {
  it('12 · an active president cannot be replaced through the invitation controls', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    await invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token);
    await onboarding.activateIfReady(out.clubId);

    for (const attempt of [
      () => onboarding.replacePresidentInvite(OWNER, out.clubId, { firstName: 'Someone', lastName: 'Else', email: 'else@newclub.test' }),
      () => onboarding.revokePresidentInvite(OWNER, out.clubId),
      () => onboarding.resendPresidentInvite(OWNER, out.clubId),
    ]) {
      await expect(attempt()).rejects.toThrow(/already has an active president/i);
    }

    // Untouched: still one owner, still that person.
    const owners = state.memberships.filter((m) => m.clubId === out.clubId && m.role === 'CLUB_OWNER' && m.isActive);
    expect(owners).toHaveLength(1);
    expect(owners[0].userId).toBe('u-candidate');
  });

  it('a pending candidate CAN be replaced, and only the new link works', async () => {
    const out = await onboarding.createClubWithPresidentInvite(OWNER, DTO);
    const replaced = await onboarding.replacePresidentInvite(OWNER, out.clubId,
      { firstName: 'Mert', lastName: 'Yilmaz', email: 'mert@newclub.test' }, 'Wrong candidate');

    expect(replaced.invitation.email).toBe('mert@newclub.test');
    await expect(invites.previewInvitation(out.token)).rejects.toThrow(/withdrawn/i);
    await expect(invites.previewInvitation(replaced.token)).resolves.toMatchObject({ email: 'mert@newclub.test' });
    expect(auditActions()).toContain('ClubPresidentInvitationReplaced');
    expect(ownerMemberships()).toEqual([]);
  });

  it('creating one club touches no other club, and no existing membership', async () => {
    const before = JSON.stringify(state.memberships);
    const beforeClub = JSON.stringify(state.clubs.find((c) => c.id === EXISTING_CLUB));

    await onboarding.createClubWithPresidentInvite(OWNER, DTO);

    expect(JSON.stringify(state.memberships)).toBe(before);
    expect(JSON.stringify(state.clubs.find((c) => c.id === EXISTING_CLUB))).toBe(beforeClub);
    // The ownerless-club remediation is somebody's explicit decision, not a
    // side effect of creating a different club.
    expect(auditActions().every((a) => !/backfill|assignOwner/i.test(a))).toBe(true);
  });

  it('13 · clubs that predate the lifecycle column keep behaving exactly as before', async () => {
    // No lifecycle was written for HARTA BERLIN; the column default is ACTIVE
    // and the migration does not rewrite a single row.
    const existing = state.clubs.find((c) => c.id === EXISTING_CLUB)!;
    expect(existing.lifecycle).toBe('ACTIVE');

    const setup = await onboarding.clubSetupState(EXISTING_CLUB);
    expect(setup.steps.clubActivated).toBe(true);
    expect(setup.president.state).toBe('ACTIVE');
    expect(setup.president.userId).toBe('u-club-president');

    // Reconciling it is a no-op — no write, no audit row.
    const audits = state.platformAudits.length;
    await onboarding.activateIfReady(EXISTING_CLUB);
    expect(state.platformAudits).toHaveLength(audits);

    const migration = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'prisma/migrations/20260906090000_club_lifecycle/migration.sql'), 'utf8');
    expect(migration).toContain("DEFAULT 'ACTIVE'");
    expect(migration).not.toMatch(/\bUPDATE\b|\bDROP\b|\bDELETE\b/i);
  });
});

describe('the audit trail can reconstruct how a club came to be owned', () => {
  it('records every step, with actor, club and environment — and no secret', async () => {
    const out = await onboarding.createClubWithPresidentInvite(
      { ...OWNER, ipAddress: '203.0.113.7', userAgent: 'jest', correlationId: 'corr-1' } as never, DTO);
    await invites.acceptInvitation({ userId: 'u-candidate', email: PRESIDENT_CANDIDATE }, out.token);
    await onboarding.activateIfReady(out.clubId);

    expect(auditActions()).toEqual(expect.arrayContaining(['ClubCreated', 'ClubPresidentInvited', 'ClubActivated']));
    // The club's own trail records the invitation and its acceptance.
    expect(state.memberAudits.map((a) => a.action)).toEqual(expect.arrayContaining(['INVITED', 'INVITE_ACCEPTED']));

    for (const row of state.platformAudits) {
      expect(row.clubId).toBe(out.clubId);
      expect(row.metadata.environment).toMatch(/PRODUCTION|STAGING|LAB|PREVIEW/);
    }
    const created = state.platformAudits.find((a) => a.action === 'ClubCreated')!;
    expect(created.userId).toBe(PLATFORM_OWNER);
    expect(created.ipAddress).toBe('203.0.113.7');
    expect(created.metadata.correlationId).toBe('corr-1');

    // No password, no raw token, no token hash — anywhere in the trail.
    const trail = JSON.stringify(state.platformAudits) + JSON.stringify(state.memberAudits);
    expect(trail).not.toContain(out.token);
    expect(trail.toLowerCase()).not.toMatch(/password|tokenhash|"token"/);
  });
});
