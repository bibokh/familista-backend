/**
 * Final Security Closure, Task 1 — proven on real PostgreSQL
 *
 *   1. Open self-registration is closed. `POST /auth/register` used to create
 *      an account tied to whatever club the body named, with a staff role the
 *      body chose; since a request's club comes from the account and most
 *      routes authorise by role, that was a working membership of any club for
 *      anybody who knew its id. Now: refused, nothing written, no session, no
 *      roster — and the invitation path still creates an account, scoped to
 *      the inviting club only.
 *   2. Franchise `attachClub` / `detachClub` no longer trust a clubId from the
 *      request. Write access to a unit is authority over the unit; a club joins
 *      one only by its president or the platform, leaves another only with
 *      write access to that one too, and is detached only from the unit it is in.
 *
 * Runs against a freshly migrated database owned by a role that is neither a
 * superuser nor BYPASSRLS — the same shape as tests/rls-pilot — with the
 * application's RLS context on, so R14 Stage 4 is in force throughout.
 *
 *   RLS_DB_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/security-closure-task1.integration.test.ts
 */

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import request from 'supertest';

const ADMIN_URL = process.env.RLS_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.RLS_DB_REQUIRED === '1') {
  throw new Error('RLS_DB_REQUIRED=1 but RLS_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

const tag = randomBytes(4).toString('hex');
const ROLE = `fam_t1_owner_${tag}`;
const PASSWORD = `pw_${randomBytes(12).toString('hex')}`;
const DB = `fam_t1_${tag}`;

function urlFor(database: string, user?: string, password?: string): string {
  const u = new URL(ADMIN_URL || 'postgresql://placeholder@localhost:5432/postgres');
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
}

// The application under test reads these when it is first required, below.
if (ADMIN_URL) {
  process.env.DATABASE_URL = urlFor(DB, ROLE, PASSWORD);
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  process.env.DB_RLS_CONTEXT = 'on';
  // Refused registrations spend the per-address auth budget (20 failures a
  // minute) — as they should for an attacker. This suite sends more than that
  // on purpose, so it gets a larger budget; the limiter has its own tests.
  process.env.RATE_AUTH_CAPACITY = '500';
}

const VICTIM = '11111111-1111-4111-8111-111111111111';
const HOME = '22222222-2222-4222-8222-222222222222';
const ids = {
  victimPlayer: `victim-player-${tag}`, homePlayer: `home-player-${tag}`,
  president: `president-${tag}`, outsider: `outsider-${tag}`, victimPresident: `victim-president-${tag}`,
  unitA: `unit-a-${tag}`, unitB: `unit-b-${tag}`,
};
const STAFF_ROLES = ['HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'CLUB_ADMIN', 'SUPER_ADMIN'];
const API = '/api/v1';

suite('Final Security Closure, Task 1, on real PostgreSQL', () => {
  let admin: PrismaClient;
  let owner: PrismaClient;
  let app: Application;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let invites: any;
  let franchise: any;
  let dbContext: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const asSystem = <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  const player = (id: string, clubId: string, n: number) => ({
    id, clubId, firstName: 'Minor', lastName: id, number: n, position: 'ST' as const,
    nationality: 'XX', flag: 'xx', dateOfBirth: new Date('2011-05-05'), height: 160, weight: 50,
  });
  const userCount = () => owner.user.count();

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE ROLE "${ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD '${PASSWORD}'`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB}" OWNER "${ROLE}"`);
    const url = urlFor(DB, ROLE, PASSWORD);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status}): ${migrate.stderr}`);
    owner = new PrismaClient({ datasources: { db: { url } } });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { hashPassword } = require('../src/utils/password');
    const hash = await hashPassword('President-Pass-1!');
    await asSystem(async (db) => {
      await db.club.create({ data: { id: VICTIM, name: 'Victim FC', city: 'X' } });
      await db.club.create({ data: { id: HOME, name: 'Home FC', city: 'Y' } });
      await db.player.create({ data: player(ids.victimPlayer, VICTIM, 9) });
      await db.player.create({ data: player(ids.homePlayer, HOME, 10) });
      for (const [id, clubId] of [[ids.president, HOME], [ids.outsider, HOME], [ids.victimPresident, VICTIM]]) {
        await db.user.create({ data: { id, clubId, email: `${id}@test.invalid`, passwordHash: hash, firstName: 'T', lastName: id, role: 'CLUB_ADMIN' } });
      }
      await db.membership.create({ data: { userId: ids.president, clubId: HOME, role: 'CLUB_OWNER' } });
      await db.membership.create({ data: { userId: ids.victimPresident, clubId: VICTIM, role: 'CLUB_OWNER' } });
      await db.membership.create({ data: { userId: ids.outsider, clubId: HOME, role: 'HEAD_COACH' } });
      for (const id of [ids.unitA, ids.unitB]) {
        await db.franchiseUnit.create({ data: { id, code: id, name: id, level: 'LOCAL', status: 'ACTIVE' } });
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require('../src/app').createApp();
    invites = require('../src/identity/invitation.service');
    franchise = require('../src/services/franchise-unit.service');
    dbContext = require('../src/security/db-context');
  }, 240_000);

  afterAll(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      await require('../src/config/database').prisma.$disconnect();
    } catch { /* not connected */ }
    await owner?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin?.$disconnect();
  });

  describe('1 · open self-registration is closed', () => {
    it('refuses anonymous registration into an arbitrary club: 403, nothing written, no session', async () => {
      const before = await userCount();
      const res = await request(app).post(`${API}/auth/register`).send({
        email: `attacker-${tag}@evil.test`, password: 'Attacker-Pass-1!', firstName: 'A', lastName: 'B', clubId: VICTIM,
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, code: 'SELF_REGISTRATION_CLOSED' });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
      expect(await userCount()).toBe(before);
      expect(await owner.user.findUnique({ where: { email: `attacker-${tag}@evil.test` } })).toBeNull();
    });

    it.each(STAFF_ROLES)('naming another club with role %s creates no account and no access', async (role) => {
      const email = `attacker-${role.toLowerCase()}-${tag}@evil.test`;
      for (const clubId of [VICTIM, HOME]) {
        const res = await request(app).post(`${API}/auth/register`).send({
          email, password: 'Attacker-Pass-1!', firstName: 'A', lastName: 'B', clubId, role,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SELF_REGISTRATION_CLOSED');
      }
      expect(await owner.user.findUnique({ where: { email } })).toBeNull();
      // And there is nothing to sign in with.
      const login = await request(app).post(`${API}/auth/login`).send({ email, password: 'Attacker-Pass-1!' });
      expect(login.status).toBe(401);
    });

    it('leaves the attacker with no route to the victim club\'s roster', async () => {
      await request(app).post(`${API}/auth/register`).send({
        email: `roster-${tag}@evil.test`, password: 'Attacker-Pass-1!', firstName: 'A', lastName: 'B', clubId: VICTIM, role: 'MEDICAL_STAFF',
      });
      expect((await request(app).get(`${API}/players`)).status).toBe(401);
      expect((await request(app).get(`${API}/players/${ids.victimPlayer}`)).status).toBe(401);
      const login = await request(app).post(`${API}/auth/login`).send({ email: `roster-${tag}@evil.test`, password: 'Attacker-Pass-1!' });
      expect(login.status).toBe(401);
    });

    it('the invitation path still creates an account — in the inviting club, seeing only that club', async () => {
      const email = `invited-${tag}@example.test`;
      const { token } = await dbContext.runInClubContext(HOME, ids.president, async () =>
        await invites.createInvitation({ userId: ids.president, clubId: HOME, role: 'CLUB_ADMIN' }, { email, role: 'HEAD_COACH' }));
      expect(typeof token).toBe('string');

      const accepted = await request(app).post(`${API}/invitations/accept-with-account`)
        .send({ token, firstName: 'New', lastName: 'Coach', password: 'Invited-Pass-1!' });
      expect([200, 201]).toContain(accepted.status);
      const created = await owner.user.findUnique({ where: { email }, select: { clubId: true, role: true } });
      expect(created).toEqual({ clubId: HOME, role: 'HEAD_COACH' });
      expect(await owner.membership.count({ where: { user: { email }, clubId: HOME, isActive: true } })).toBe(1);

      const login = await request(app).post(`${API}/auth/login`).send({ email, password: 'Invited-Pass-1!' });
      expect(login.status).toBe(200);
      const access = login.body?.data?.tokens?.accessToken as string;
      const roster = await request(app).get(`${API}/players`).set('authorization', `Bearer ${access}`);
      expect(roster.status).toBe(200);
      const seen = (roster.body.data as Array<{ id: string }>).map((p) => p.id);
      expect(seen).toContain(ids.homePlayer);
      expect(seen).not.toContain(ids.victimPlayer);
      // The token is single-use.
      const again = await request(app).post(`${API}/invitations/accept-with-account`)
        .send({ token, firstName: 'New', lastName: 'Coach', password: 'Invited-Pass-1!' });
      expect(again.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('2 · franchise attach/detach trust nothing the request names', () => {
    const actor = (userId: string, writable: string[], isPlatformAdmin = false) => ({
      userId, ipAddress: null, userAgent: null,
      scope: {
        isPlatformAdmin, platformRole: isPlatformAdmin ? 'SUPER_ADMIN' : null,
        readableUnitIds: new Set(writable), writableUnitIds: new Set(writable), primaryUnitIds: new Set(writable), ownerIds: new Set<string>(),
      },
    });
    const unitOf = async (clubId: string) =>
      ((await owner.club.findUnique({ where: { id: clubId } })) as unknown as { franchiseUnitId: string | null }).franchiseUnitId;

    it('a unit writer cannot attach a club it has no authority over', async () => {
      await expect(franchise.attachClub(actor(ids.outsider, [ids.unitA]), ids.unitA, VICTIM)).rejects.toThrow(/president or the platform/);
      // Not even its own club, where it is staff but not president.
      await expect(franchise.attachClub(actor(ids.outsider, [ids.unitA]), ids.unitA, HOME)).rejects.toThrow(/president or the platform/);
      expect(await unitOf(VICTIM)).toBeNull();
      expect(await unitOf(HOME)).toBeNull();
    });

    it('the club\'s president, with write access to the unit, can attach it', async () => {
      await franchise.attachClub(actor(ids.president, [ids.unitA]), ids.unitA, HOME);
      expect(await unitOf(HOME)).toBe(ids.unitA);
    });

    it('nobody can move a club out of a unit they cannot write — not even its president', async () => {
      await expect(franchise.attachClub(actor(ids.president, [ids.unitB]), ids.unitB, HOME)).rejects.toThrow(/another franchise unit/);
      await expect(franchise.attachClub(actor(ids.victimPresident, [ids.unitB]), ids.unitB, HOME)).rejects.toThrow(/president or the platform/);
      expect(await unitOf(HOME)).toBe(ids.unitA);
    });

    it('a club is detached only from the unit that holds it', async () => {
      await expect(franchise.detachClub(actor(ids.outsider, [ids.unitB]), ids.unitB, HOME)).rejects.toThrow(/not attached to this unit/);
      await expect(franchise.detachClub(actor(ids.outsider, []), ids.unitA, HOME)).rejects.toThrow(/write access/);
      expect(await unitOf(HOME)).toBe(ids.unitA);
      await franchise.detachClub(actor(ids.outsider, [ids.unitA]), ids.unitA, HOME);
      expect(await unitOf(HOME)).toBeNull();
    });

    it('platform authority may place and move clubs, as designed', async () => {
      await franchise.attachClub(actor(ids.outsider, [], true), ids.unitA, VICTIM);
      expect(await unitOf(VICTIM)).toBe(ids.unitA);
      await franchise.attachClub(actor(ids.outsider, [], true), ids.unitB, VICTIM);
      expect(await unitOf(VICTIM)).toBe(ids.unitB);
    });
  });
});
