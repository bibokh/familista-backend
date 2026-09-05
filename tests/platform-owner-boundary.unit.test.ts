/**
 * tests/platform-owner-boundary.unit.test.ts
 *
 * Who owns Familista, and who merely owns a club.
 *
 * Two things are proved here, and they are the same thing seen from two sides.
 *
 * The first is that SYSTEM cannot be reached by club authority. Owning the
 * largest club on the platform, administering it, or being its head coach are
 * not routes into SYSTEM; the only route is an explicit platform-level
 * assignment. The guard is the service, not the interface, so that is where it
 * is tested — a hidden button is not a permission.
 *
 * The second is that the assignment itself cannot be made by accident. It takes
 * one named account, refuses an ambiguous match, refuses anything that reads as
 * a demo or test fixture (this database holds 132 of them and one known test
 * address), writes audit evidence, and leaves the account's password and club
 * memberships exactly as it found them.
 *
 * The interface is checked too, but only for the property the server cannot
 * enforce: that SYSTEM and CLUBS are two products on screen, never one nested
 * in the other.
 */

import fs from 'fs';
import path from 'path';
import { PlatformRole } from '@prisma/client';

type Row = Record<string, unknown>;

const state = {
  users: [] as Row[],
  memberships: [] as Row[],
  platformAdmins: [] as Row[],
  audits: [] as Row[],
  /** Anything the bootstrap wrote that it had no business writing. */
  forbiddenWrites: [] as string[],
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const matchUser = (u: Row, where: any): boolean => {
  if (!where) return true;
  if (Array.isArray(where.AND)) return where.AND.every((w: any) => matchUser(u, w));
  return Object.entries(where).every(([k, v]) => u[k] === v);
};

const platformAdmin = {
  findUnique: async ({ where }: any) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  findMany: async ({ where = {} }: any = {}) =>
    state.platformAdmins
      .filter((a) => (where.isActive === undefined ? true : a.isActive === where.isActive))
      .map((a) => ({ ...a, user: { email: state.users.find((u) => u.id === a.userId)?.email ?? '' } })),
  create: async ({ data }: any) => { const r = { id: id('padmin'), isActive: true, ...data }; state.platformAdmins.push(r); return r; },
  update: async ({ where, data }: any) => {
    const r = state.platformAdmins.find((a) => a.userId === where.userId)!;
    Object.assign(r, data);
    return r;
  },
};

const db = {
  user: {
    findMany: async ({ where }: any) => state.users.filter((u) => matchUser(u, where)),
    findUnique: async ({ where }: any) =>
      state.users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
    // Nothing in the bootstrap may write a user row. If it ever does, the test
    // that reads forbiddenWrites fails rather than the write passing unnoticed.
    update: async () => { state.forbiddenWrites.push('user.update'); return {}; },
    updateMany: async () => { state.forbiddenWrites.push('user.updateMany'); return { count: 0 }; },
  },
  membership: {
    count: async ({ where = {} }: any = {}) =>
      state.memberships.filter((m) => Object.entries(where).every(([k, v]) => m[k] === v)).length,
    findMany: async ({ where = {} }: any = {}) =>
      state.memberships.filter((m) => Object.entries(where).every(([k, v]) => m[k] === v)),
    create: async () => { state.forbiddenWrites.push('membership.create'); return {}; },
    update: async () => { state.forbiddenWrites.push('membership.update'); return {}; },
    updateMany: async () => { state.forbiddenWrites.push('membership.updateMany'); return { count: 0 }; },
    deleteMany: async () => { state.forbiddenWrites.push('membership.deleteMany'); return { count: 0 }; },
  },
  platformAdmin,
  platformAuditLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } },
  club: { update: async () => { state.forbiddenWrites.push('club.update'); return {}; } },
  team: { update: async () => { state.forbiddenWrites.push('team.update'); return {}; } },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { bootstrapPlatformOwner, currentPlatformOwners } from '../src/platform/owner-bootstrap';
import { accessLevelOf, describeAuthority, isPlatformOwner } from '../src/platform/access-levels';
import { assertPlatformOwner } from '../src/platform/system.service';
import { SYSTEM_MODULES, CLUB_MODULES } from '../src/platform/system-modules';
import { ForbiddenError } from '../src/utils/errors';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SYS_JS = read('public/system/system.js');
const SYS_CSS = read('public/system/system.css');
const APP = read('public/app.js');
const START = read('scripts/render-start.sh');
const BOOTSTRAP_SRC = read('src/platform/owner-bootstrap.ts');

const CLUB = 'club-harta-berlin';

const REAL_OWNER = 'u-founder';
const CLUB_OWNER = 'u-club-owner';
const CLUB_STAFF = 'u-head-coach';
const NOBODY = 'u-no-membership';

beforeEach(() => {
  seq = 0;
  state.users = [
    { id: REAL_OWNER, email: 'founder@familista.app', firstName: 'Real', lastName: 'Founder', isActive: true, role: 'CLUB_ADMIN' },
    { id: CLUB_OWNER, email: 'owner@hartaberlin.de', firstName: 'Club', lastName: 'Owner', isActive: true, role: 'CLUB_ADMIN' },
    { id: CLUB_STAFF, email: 'head.coach@hartaberlin.de', firstName: 'Head', lastName: 'Coach', isActive: true, role: 'COACH' },
    { id: NOBODY, email: 'someone@elsewhere.net', firstName: 'No', lastName: 'Membership', isActive: true, role: 'COACH' },
    // The seeded population this database really carries.
    { id: 'u-demo-coach', email: 'coach@familista.io', firstName: 'Demo', lastName: 'Coach', isActive: true, role: 'COACH' },
    { id: 'u-test-1', email: 'test.coach1@familista.io', firstName: 'Test', lastName: 'One', isActive: true, role: 'COACH' },
    { id: 'u-demo-2', email: 'demo@example.com', firstName: 'Sample', lastName: 'Two', isActive: true, role: 'COACH' },
    { id: 'u-retired', email: 'retired@familista.app', firstName: 'Was', lastName: 'Here', isActive: false, role: 'COACH' },
    // Two accounts that share nothing but a shape the caller might get wrong.
    { id: 'u-twin-a', email: 'twin@familista.app', firstName: 'Twin', lastName: 'A', isActive: true, role: 'COACH' },
  ];
  state.memberships = [
    { id: 'mem-founder', userId: REAL_OWNER, clubId: CLUB, teamId: null, role: 'CLUB_OWNER', isActive: true },
    { id: 'mem-owner', userId: CLUB_OWNER, clubId: CLUB, teamId: null, role: 'CLUB_OWNER', isActive: true },
    { id: 'mem-coach', userId: CLUB_STAFF, clubId: CLUB, teamId: 'team-first', role: 'HEAD_COACH', isActive: true },
  ];
  state.platformAdmins = [];
  state.audits = [];
  state.forbiddenWrites = [];
});

const owns = async (userId: string) =>
  bootstrapPlatformOwner({ userId, performedBy: 'test' });

// ─────────────────────────────────────────────────────────────────────────────
// 1–4 · who reaches SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

describe('SYSTEM answers only to platform authority', () => {
  it('1 · the platform owner opens it', async () => {
    await owns(REAL_OWNER);
    await expect(assertPlatformOwner({ userId: REAL_OWNER, clubId: CLUB })).resolves.toBeUndefined();
    expect(await isPlatformOwner({ userId: REAL_OWNER, clubId: CLUB })).toBe(true);
    expect(await describeAuthority({ userId: REAL_OWNER, clubId: CLUB })).toMatchObject({
      level: 'PLATFORM_OWNER',
      isPlatformOwner: true,
    });
  });

  it('2 · a club owner without platform authority is refused, with 403', async () => {
    expect(await accessLevelOf({ userId: CLUB_OWNER, clubId: CLUB })).toBe('CLUB_OWNER');
    await expect(assertPlatformOwner({ userId: CLUB_OWNER, clubId: CLUB })).rejects.toThrow(ForbiddenError);
    await expect(assertPlatformOwner({ userId: CLUB_OWNER, clubId: CLUB }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('3 · club staff are refused, with 403', async () => {
    expect(await accessLevelOf({ userId: CLUB_STAFF, clubId: CLUB })).toBe('CLUB_STAFF');
    await expect(assertPlatformOwner({ userId: CLUB_STAFF, clubId: CLUB }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('4 · an account with no membership at all is refused, with 403', async () => {
    expect(await accessLevelOf({ userId: NOBODY, clubId: null })).toBe('VIEWER');
    await expect(assertPlatformOwner({ userId: NOBODY, clubId: null }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('9 · a direct SYSTEM URL changes nothing — the refusal is in the service', async () => {
    // The route is not the guard. Every SYSTEM read handler asks the service,
    // which asks the database, so arriving by deep link, by fetch or by curl
    // reaches the same refusal as clicking a button that was never drawn.
    const service = read('src/platform/system.service.ts');
    const exported = [...service.matchAll(/export async function (\w+)\(actor: PlatformActor/g)].map((m) => m[1]);
    const unguarded = exported.filter(
      (fn) => fn !== 'assertPlatformOwner'
        && !new RegExp(`export async function ${fn}\\(actor: PlatformActor[\\s\\S]{0,400}?assertPlatformOwner`).test(service),
    );
    expect(unguarded).toEqual([]);

    // And the shell's own reads are refused the same way for a club owner.
    await expect(assertPlatformOwner({ userId: CLUB_OWNER, clubId: CLUB })).rejects.toThrow(/platform owner/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · the two ownerships are different things
// ─────────────────────────────────────────────────────────────────────────────

describe('platform ownership and club ownership are separate grants', () => {
  it('5 · the platform owner keeps their club memberships, and they are not the grant', async () => {
    const before = state.memberships.filter((m) => m.userId === REAL_OWNER).length;
    const result = await owns(REAL_OWNER);

    expect(result.outcome).toBe('ASSIGNED');
    expect(result.membershipsPreserved).toBe(before);
    expect(state.memberships.filter((m) => m.userId === REAL_OWNER)).toHaveLength(before);
    expect(state.forbiddenWrites).toEqual([]);

    // They own a club AND the platform. Neither fact was derived from the other.
    expect(state.memberships.find((m) => m.userId === REAL_OWNER)!.role).toBe('CLUB_OWNER');
    expect(state.platformAdmins[0]).toMatchObject({ userId: REAL_OWNER, role: PlatformRole.PLATFORM_OWNER });

    // The other club owner, with an identical membership, still reaches nothing.
    await expect(assertPlatformOwner({ userId: CLUB_OWNER, clubId: CLUB })).rejects.toThrow(ForbiddenError);
  });

  it('a CLUB_OWNER membership never becomes platform authority on its own', async () => {
    const clubOwners = state.memberships.filter((m) => m.role === 'CLUB_OWNER');
    expect(clubOwners.length).toBeGreaterThan(1);
    for (const m of clubOwners) {
      expect(await isPlatformOwner({ userId: m.userId as string, clubId: CLUB, role: 'CLUB_ADMIN' })).toBe(false);
    }
    expect(state.platformAdmins).toHaveLength(0);
  });

  it('the assignment writes audit evidence and touches nothing else', async () => {
    await owns(REAL_OWNER);
    expect(state.audits).toHaveLength(1);
    const entry = state.audits[0] as any;
    expect(entry.action).toBe('PLATFORM_OWNER_ESTABLISHED');
    expect(entry.category).toBe('PLATFORM_ADMIN');
    expect(entry.metadata.untouched).toEqual(
      expect.arrayContaining(['password', 'memberships', 'clubs', 'teams', 'User.role']),
    );
    expect(state.forbiddenWrites).toEqual([]);
    // No secret is recorded, and none is available to record. The word
    // "password" appears once, in the list of things this run did NOT touch.
    const withoutTheDisclaimer = JSON.stringify({ ...entry, metadata: { ...entry.metadata, untouched: [] } });
    expect(withoutTheDisclaimer.toLowerCase()).not.toMatch(/password|hash|token|secret/);
    expect(BOOTSTRAP_SRC).not.toMatch(/passwordHash|refreshToken|tokenHash/);
  });

  it('running it again writes nothing', async () => {
    await owns(REAL_OWNER);
    state.audits = [];
    const again = await owns(REAL_OWNER);
    expect(again.outcome).toBe('ALREADY_OWNER');
    expect(state.audits).toHaveLength(0);
    expect(state.platformAdmins).toHaveLength(1);
  });

  it('a dry run reports and writes nothing at all', async () => {
    const plan = await bootstrapPlatformOwner({ email: 'founder@familista.app', dryRun: true });
    expect(plan).toMatchObject({ outcome: 'ASSIGNED', dryRun: true });
    expect(state.platformAdmins).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 · nothing seeded is ever promoted
// ─────────────────────────────────────────────────────────────────────────────

describe('no demo or test account can become the platform owner', () => {
  it('10 · the known test address is refused by name', async () => {
    const r = await bootstrapPlatformOwner({ email: 'coach@familista.io' });
    expect(r.outcome).toBe('REFUSED');
    expect(r.reason).toMatch(/demo or test/i);
    expect(state.platformAdmins).toHaveLength(0);
  });

  it('and so is every other fixture shape, by address or by name', async () => {
    for (const email of ['test.coach1@familista.io', 'demo@example.com']) {
      const r = await bootstrapPlatformOwner({ email });
      expect(`${email}:${r.outcome}`).toBe(`${email}:REFUSED`);
    }
    expect(state.platformAdmins).toHaveLength(0);
    expect(await currentPlatformOwners()).toEqual([]);
  });

  it('refuses an unnamed, unmatched, deactivated or ambiguous account', async () => {
    expect((await bootstrapPlatformOwner({})).reason).toMatch(/exactly one/i);
    expect((await bootstrapPlatformOwner({ email: 'nobody@nowhere.test' })).outcome).toBe('REFUSED');
    expect((await bootstrapPlatformOwner({ email: 'retired@familista.app' })).reason).toMatch(/deactivated/i);
    // Two rows for one address: no assignment, and a message that says why.
    state.users.push({ id: 'u-twin-b', email: 'twin@familista.app', firstName: 'Twin', lastName: 'B', isActive: true, role: 'COACH' });
    const ambiguous = await bootstrapPlatformOwner({ email: 'twin@familista.app' });
    expect(ambiguous.outcome).toBe('REFUSED');
    expect(ambiguous.reason).toMatch(/ambiguous|2 accounts/i);
    expect(state.platformAdmins).toHaveLength(0);
  });

  it('cannot promote in bulk — it takes one account and returns one result', async () => {
    // Not a stylistic point. The signature has no plural form, the boot hook
    // passes one value, and there is no findMany-then-promote anywhere in it.
    expect(BOOTSTRAP_SRC).not.toMatch(/createMany|updateMany|for\s*\(.*of\s+matches\)/);
    expect(/take:\s*5/.test(BOOTSTRAP_SRC)).toBe(true);   // reads a few only to detect ambiguity
    expect(START).toMatch(/PLATFORM_OWNER_BOOTSTRAP/);
    expect(START).toMatch(/--email=|--user-id=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6–8 · SYSTEM and CLUBS are two products
// ─────────────────────────────────────────────────────────────────────────────

describe('SYSTEM and CLUBS never appear inside one another', () => {
  it('6 · the SYSTEM shell offers no club navigation', () => {
    const clubOnly = ['squad', 'training', 'match-center', 'transfers', 'academy', 'medical', 'finance'];
    for (const page of clubOnly) {
      expect(`${page}:${SYS_JS.includes(`data-page="${page}"`)}`).toBe(`${page}:false`);
      expect(`${page}:${SYS_JS.includes(`navTo('${page}')`)}`).toBe(`${page}:false`);
    }
    // The one way out is the way back to Home, and it is explicit.
    expect(SYS_JS).toContain("navTo('owner-home')");
  });

  it('7 · the club shell offers no SYSTEM module, and the two catalogues are disjoint', () => {
    const systemKeys = new Set(SYSTEM_MODULES.map((m) => m.key));
    const overlap = CLUB_MODULES.filter((key) => systemKeys.has(key));
    expect(overlap).toEqual([]);
    // The only club-side entry point into SYSTEM is the Owner Home card.
    const entries = APP.match(/data-page="system"/g) || [];
    expect(entries).toHaveLength(1);
    expect(APP).toMatch(/oh-card--system[\s\S]{0,200}data-page="system"|data-page="system"[\s\S]{0,200}oh-card--system/);
  });

  it('8 · opening SYSTEM removes the club chrome from the layout entirely', () => {
    // The class is set on the one path every navigation takes, so a click, a
    // deep link and the back button cannot disagree.
    expect(APP).toMatch(/classList\.toggle\('sy-system-open',\s*page === 'system'\)/);
    for (const rule of ['body.sy-system-open .sidebar', 'body.sy-system-open .topbar']) {
      expect(`${rule}:${SYS_CSS.includes(rule)}`).toBe(`${rule}:true`);
    }
    expect(SYS_CSS).toMatch(/body\.sy-system-open[^{]*\{[^}]*display:\s*none\s*!important/);
    // And SYSTEM owns the viewport rather than sitting in the club's content column.
    expect(SYS_CSS).toMatch(/#pg-system\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/);
  });

  it('the SYSTEM identity states platform authority and never a club role', () => {
    expect(SYS_JS).toContain("who.isPlatformOwner ? 'Platform Owner'");
    expect(SYS_JS).not.toContain("'Club Owner'");
    expect(SYS_JS).not.toContain("'Club Staff'");
  });
});
