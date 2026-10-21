/**
 * AI read authorization, proven on real PostgreSQL
 *
 * The same hand-written expectations as tests/ai-read-authorization.unit.test.ts
 * (tests/helpers/ai-read-fixtures.ts), through the real app, against a freshly
 * migrated database: the conditions src/security/ai-read-policy.ts builds are
 * run by PostgreSQL itself, not by a model of it. For every role and every AI
 * list and detail route:
 *
 *   · role isolation      — exactly the records the matrix clears, each at its tier;
 *   · cross-club isolation — another club's records are never listed and are
 *                            not found by id, in both directions;
 *   · medical protection  — no medical record, nor any marker from one, reaches a
 *                            role other than medical staff;
 *   · NULL handling       — agentless alerts are included and excluded exactly,
 *                            where `agent IN (…)` alone would drop them (shown);
 *   · pagination totals   — every page reports the total of what may be seen,
 *                            and the pages add up to the list;
 *   · list/detail consistency — restricted in one is restricted in the other,
 *                            and what a list omits is not found.
 *
 * Runs against a database owned by a role that is neither a superuser nor
 * BYPASSRLS, with the application's RLS context on, as tests/security-closure-task1.
 *
 *   AI_READ_DB_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/ai-read-authorization.integration.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import request from 'supertest';
import {
  C1, C2, CANCEL_ROUTE_ROLES, DETAILS, ID, LISTS, MUTE_ROUTE_ROLES, NO_ACCESS, OPERATIONAL_CANCEL_ROLES, OPERATIONAL_MUTE_ROLES,
  READERS, ROLES, SPECS, SUMMARY_KEYS, buildRecords, expectTier, intelligenceOnly, itemsOf, mayAct, secret, spec, specsOf,
  totalOf, uid, type Role,
} from './helpers/ai-read-fixtures';

const ADMIN_URL = process.env.AI_READ_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.AI_READ_DB_REQUIRED === '1') {
  throw new Error('AI_READ_DB_REQUIRED=1 but AI_READ_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

const tag = randomBytes(4).toString('hex');
const ROLE = `fam_air_owner_${tag}`;
const PASSWORD = `pw_${randomBytes(12).toString('hex')}`;
const DB = `fam_air_${tag}`;

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
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);
  // Several thousand requests from one address and a handful of accounts, on purpose.
  for (const k of ['RATE_AUTH_CAPACITY', 'RATE_EDGE_MAX', 'RATE_IP_CAPACITY', 'RATE_USER_CAPACITY', 'RATE_TENANT_CAPACITY', 'RATE_ACCOUNT_CAPACITY']) process.env[k] = '1000000';
}

type Row = Record<string, any>;
const MODEL: Record<string, string> = { job: 'aIAgentJob', alert: 'aIAlert', rec: 'aIRecommendation', report: 'aIReport', coach: 'coachRecommendation' };
const MEDICAL_MARKERS = SPECS.filter((s) => s.needs.includes('MEDICAL') || s.health).map((s) => `SECRET:${s.type}:${s.label}:`);

suite('AI read authorization, on real PostgreSQL', () => {
  let admin: PrismaClient;
  let owner: PrismaClient;
  let app: Application;
  let signToken: (kind: 'access', claims: Row, opts: Row) => string;

  const asSystem = <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
      return fn(tx as unknown as PrismaClient);
    });

  const as = (role: Role, club = C1) => {
    const auth = `Bearer ${signToken('access', { sub: uid(role, club), role, tv: 0 }, { expiresIn: '10m' })}`;
    return {
      get: (url: string) => request(app).get(url).set('Authorization', auth),
      post: (url: string, payload: Row = {}) => request(app).post(url).set('Authorization', auth).send(payload),
    };
  };
  const text = (res: { body: unknown }) => JSON.stringify(res.body);

  async function reseed() {
    await asSystem(async (db) => {
      for (const m of Object.values(MODEL)) await (db as any)[m].deleteMany({});
      const recs = buildRecords();
      for (const [m, list] of Object.entries(recs)) await (db as any)[m].createMany({ data: list });
    });
  }

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

    await asSystem(async (db) => {
      for (const [id, name] of [[C1, 'Home FC'], [C2, 'Other FC']]) await db.club.create({ data: { id, name, city: 'X' } });
      for (const club of [C1, C2]) for (const r of ROLES) {
        await db.user.create({ data: { id: uid(r, club), clubId: club, email: `${uid(r, club)}@test.invalid`, passwordHash: 'x', firstName: 'T', lastName: r, role: r } });
      }
    });
    await reseed();

    /* eslint-disable @typescript-eslint/no-var-requires */
    signToken = require('../src/security/jwt-tokens').signToken;
    app = require('../src/app').createApp();
    /* eslint-enable @typescript-eslint/no-var-requires */
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

  it('(control) PostgreSQL drops a NULL agent from both IN and NOT, the hazard the conditions are written against', async () => {
    const rows = await owner.$queryRawUnsafe<Array<{ in_list: bigint; not_eq: bigint; is_null: bigint }>>(
      `SELECT count(*) FILTER (WHERE agent IN ('TACTICAL','CLUB_MANAGER')) AS in_list,
              count(*) FILTER (WHERE NOT (agent = 'MEDICAL'))            AS not_eq,
              count(*) FILTER (WHERE agent IS NULL)                      AS is_null
         FROM "AIAlert" WHERE "clubId" = $1`, C1);
    const agentless = specsOf('alert').filter((s) => s.agent === null).length;
    const nonMedicalAgents = specsOf('alert').filter((s) => s.agent && s.agent !== 'MEDICAL').length;
    expect(Number(rows[0].is_null)).toBe(agentless);
    expect(Number(rows[0].not_eq)).toBe(nonMedicalAgents);                   // the agentless rows are not there
    expect(Number(rows[0].in_list)).toBe(specsOf('alert').filter((s) => ['TACTICAL', 'CLUB_MANAGER'].includes(s.agent ?? '')).length);
  });

  describe.each(LISTS)('$name', ({ url, type, fullShows, listHides, paged }) => {
    const specs = specsOf(type).filter((s) => intelligenceOnly(url, s));

    it.each(NO_ACCESS)('negative: %s is refused', async (role) => {
      const res = await as(role).get(url);
      expect(res.status).toBe(403);
      expect(text(res)).not.toMatch(/SECRET:/);
    });

    it.each(READERS)('%s: exactly what it is cleared for, each at its tier, with the right total', async (role) => {
      const res = await as(role).get(url);
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      const expected = specs.filter((s) => expectTier(role, s) !== 'NONE');
      expect(items.map((x) => x.id).sort()).toEqual(expected.map((s) => ID(type, s.label)).sort());
      expect(text(res)).not.toMatch(/-c2:/);
      for (const s of specs) {
        const tier = expectTier(role, s);
        for (const f of listHides) expect(text(res)).not.toContain(secret(type, s.label, f));
        for (const f of fullShows) expect([s.label, f, text(res).includes(secret(type, s.label, f))]).toEqual([s.label, f, tier === 'FULL']);
        const item = items.find((x) => x.id === ID(type, s.label));
        if (tier === 'SUMMARY') {
          expect(item!.restricted).toBe(true);
          expect([s.label, Object.keys(item!).filter((k) => !SUMMARY_KEYS[type].includes(k))]).toEqual([s.label, []]);
        }
      }
      if (role !== 'MEDICAL_STAFF') for (const m of MEDICAL_MARKERS) expect(text(res)).not.toContain(m);
      const total = totalOf(res.body);
      if (total !== undefined) expect(total).toBe(expected.length);
    });

    if (paged) {
      it.each(READERS)('%s: every page reports the same total, and the pages add up to the list', async (role) => {
        const all = itemsOf((await as(role).get(url)).body).map((x) => x.id as string);
        const seen: string[] = [];
        for (let page = 1; page <= Math.ceil(all.length / 2) + 1; page++) {
          const res = await as(role).get(`${url}?page=${page}&limit=2`);
          expect([page, totalOf(res.body)]).toEqual([page, all.length]);
          seen.push(...itemsOf(res.body).map((x) => x.id as string));
        }
        expect(seen).toEqual(all);
      });
    }

    it('negative: another club’s administrator sees only its own club', async () => {
      const res = await as('CLUB_ADMIN', C2).get(url);
      expect(res.status).toBe(200);
      expect(itemsOf(res.body).every((x) => x.clubId === C2)).toBe(true);
      expect((text(res).match(/SECRET:[^"]*/g) ?? []).every((m) => m.includes('-c2:'))).toBe(true);
    });
  });

  it.each(READERS)('%s: agentless alerts are included and excluded exactly (NULL agent)', async (role) => {
    const ids = itemsOf((await as(role).get('/api/v1/ai-ops/alerts')).body).map((x) => x.id);
    for (const s of specsOf('alert').filter((x) => x.agent === null)) {
      expect([role, s.label, ids.includes(ID('alert', s.label))]).toEqual([role, s.label, expectTier(role, s) !== 'NONE']);
    }
  });

  describe.each(DETAILS)('$name', ({ url, type, fields, envelope }) => {
    const specs = specsOf(type).filter((s) => intelligenceOnly(url('x'), s));

    it.each(ROLES)('%s: FULL, SUMMARY or not found, as the matrix says', async (role) => {
      for (const s of specs) {
        const res = await as(role).get(url(ID(type, s.label)));
        if (NO_ACCESS.includes(role)) { expect([s.label, res.status]).toEqual([s.label, 403]); continue; }
        const tier = expectTier(role, s);
        if (tier === 'NONE') {
          expect([s.label, res.status]).toEqual([s.label, 404]);
          expect(text(res)).not.toMatch(/SECRET:|medical/i);
          continue;
        }
        expect([s.label, res.status]).toEqual([s.label, 200]);
        for (const f of fields) expect([s.label, f, text(res).includes(secret(type, s.label, f))]).toEqual([s.label, f, tier === 'FULL']);
        expect([s.label, !!envelope(res.body).restricted]).toEqual([s.label, tier === 'SUMMARY']);
      }
    });

    it('list and detail agree for every role', async () => {
      const list = LISTS.find((l) => l.type === type && l.url.includes('/phase-s/') === url('x').includes('/phase-s/'))!;
      for (const role of READERS) {
        const listed = new Map(itemsOf((await as(role).get(list.url)).body).map((x) => [x.id as string, x]));
        for (const s of specs) {
          const res = await as(role).get(url(ID(type, s.label)));
          const item = listed.get(ID(type, s.label));
          if (!item) { expect([role, s.label, res.status]).toEqual([role, s.label, 404]); continue; }
          expect([role, s.label, res.status, !!envelope(res.body).restricted]).toEqual([role, s.label, 200, !!item.restricted]);
        }
      }
    });

    it('negative: another club’s record is not found by id, in both directions', async () => {
      for (const role of ['CLUB_ADMIN', 'MEDICAL_STAFF', 'HEAD_COACH'] as Role[]) {
        expect([role, (await as(role).get(url(ID(type, 'ops', C2)))).status]).toEqual([role, 404]);
        expect([role, (await as(role, C2).get(url(ID(type, 'ops')))).status]).toEqual([role, 404]);
      }
      expect((await as('MEDICAL_STAFF').get(url(ID(type, 'medical', C2)))).status).toBe(404);
    });
  });

  describe('actions, written to PostgreSQL', () => {
    afterEach(reseed);
    const status = async (model: string, id: string): Promise<string> => (await asSystem<Row>((db) => (db as any)[model].findUnique({ where: { id } }))).status;

    it.each(READERS)('%s: mute and resolve on every alert follow the record’s class', async (role) => {
      for (const s of specsOf('alert')) {
        const id = ID('alert', s.label);
        const tier = expectTier(role, s);
        const mute = await as(role).post(`/api/v1/ai-ops/alerts/${id}/mute`);
        const muteOk = MUTE_ROUTE_ROLES.includes(role) && mayAct(role, s, OPERATIONAL_MUTE_ROLES);
        expect([s.label, mute.status]).toEqual([s.label, !MUTE_ROUTE_ROLES.includes(role) ? 403 : tier === 'NONE' ? 404 : muteOk ? 200 : 403]);
        expect([s.label, await status('aIAlert', id)]).toEqual([s.label, muteOk ? 'MUTED' : 'OPEN']);
        const resolve = await as(role).post(`/api/v1/ai-ops/alerts/${id}/resolve`);
        expect([s.label, resolve.status]).toEqual([s.label, tier === 'NONE' ? 404 : tier === 'FULL' ? 200 : 403]);
        if (!muteOk) expect([s.label, await status('aIAlert', id)]).toEqual([s.label, tier === 'FULL' ? 'RESOLVED' : 'OPEN']);
      }
    });

    it.each(CANCEL_ROUTE_ROLES)('%s: cancelling follows the job’s class', async (role) => {
      await asSystem((db) => db.aIAgentJob.updateMany({ where: {}, data: { status: 'PENDING' } }));
      for (const s of specsOf('job')) {
        const id = ID('job', s.label);
        const res = await as(role).post(`/api/v1/automation/agents/jobs/${id}/cancel`);
        const tier = expectTier(role, s);
        const ok = mayAct(role, s, OPERATIONAL_CANCEL_ROLES);
        expect([s.label, res.status]).toEqual([s.label, tier === 'NONE' ? 404 : ok ? 200 : 403]);
        expect([s.label, await status('aIAgentJob', id)]).toEqual([s.label, ok ? 'CANCELLED' : 'PENDING']);
      }
    });

    it('negative: nobody acts on another club’s records', async () => {
      await asSystem((db) => db.aIAgentJob.updateMany({ where: {}, data: { status: 'PENDING' } }));
      for (const p of [`/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/resolve`, `/api/v1/ai-ops/alerts/${ID('alert', 'ops', C2)}/mute`,
        `/api/v1/ai-ops/recommendations/${ID('rec', 'ops', C2)}/ack`, `/api/v1/automation/agents/jobs/${ID('job', 'ops', C2)}/cancel`]) {
        expect([p, (await as('CLUB_ADMIN').post(p)).status]).toEqual([p, 404]);
      }
      expect(await status('aIAlert', ID('alert', 'ops', C2))).toBe('OPEN');
      expect(await status('aIAgentJob', ID('job', 'ops', C2))).toBe('PENDING');
      expect(await status('aIRecommendation', ID('rec', 'ops', C2))).toBe('OPEN');
    });

    it('a hand-written record with a reserved kind is refused and nothing is written; with its own kind it is restricted', async () => {
      const before = await asSystem((db) => db.aIAlert.count());
      const refused = await as('HEAD_COACH').post('/api/v1/ai-ops/alerts', { agent: 'TACTICAL', kind: 'TACTICAL_COLLAPSE_RISK', title: 'x' });
      expect(refused.status).toBe(400);
      expect(await asSystem((db) => db.aIAlert.count())).toBe(before);
      const written = await as('HEAD_COACH').post('/api/v1/ai-ops/alerts', { agent: 'TACTICAL', kind: 'NOTE', title: 'SECRET:hand:title' });
      expect(written.status).toBe(201);
      for (const role of READERS) {
        const listed = itemsOf((await as(role).get('/api/v1/ai-ops/alerts')).body).some((x) => x.id === written.body.data.id);
        expect([role, listed]).toEqual([role, role === 'MEDICAL_STAFF']);
      }
    });
  });

  it('(control) the seed holds every record the expectations name, in both clubs', async () => {
    const recs = buildRecords();
    for (const [m, list] of Object.entries(recs)) {
      expect([m, await asSystem((db) => (db as any)[m].count())]).toEqual([m, list.length]);
    }
    expect(spec('alert', 'fatigue').agent).toBeNull();
  });
});
