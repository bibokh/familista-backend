/**
 * Design Studio, DS-1b and M2 — saved designs, the platform's and a club's, on real PostgreSQL.
 *
 * Driven through the real application (authenticate, assertPlatformOwner, the
 * routes, the service, Prisma) against a freshly migrated database owned by a
 * role that is NOT a superuser and does not bypass row-level security, as in
 * production. What it proves:
 *
 *   ACCESS        only the platform owner reaches any route; a club admin, a
 *                 coach, a deactivated platform-admin row and no session are
 *                 refused on every route, a foreign origin is refused, and a
 *                 refused call writes nothing.
 *   DOCUMENTS     the server validates with the editor's own core: an invalid,
 *                 oversized or unknown-template document is refused and nothing
 *                 is written; what is stored is the canonical document with the
 *                 SHA-256 of its canonical text.
 *   REVISIONS     saves append; a stale save is refused with the head it lost
 *                 to (409) and writes nothing; of N saves racing from one base,
 *                 exactly one lands; a retried save answers the revision it
 *                 already made; a restore copies an old revision into a new one
 *                 and never changes a stored revision.
 *   OWNERSHIP     the database admits PLATFORM and CLUB projects (not PERSONAL
 *                 yet); a CLUB project is invisible to every platform route, and
 *                 the platform's to every club route (the service's own scope).
 *   CLUBS         the club routes serve a club's administrators and managers,
 *                 only while the club is entitled; a club reaches its own
 *                 designs and no other club's, by list or by id; its changes
 *                 are audited with its club.
 *   ROW SECURITY  both tables are forced under row-level security with the
 *                 pilot's fail-closed club policy: in a club's context the
 *                 database itself returns and accepts that club's rows only, and
 *                 nothing without a context. The application runs with
 *                 DB_RLS_CONTEXT=on, as production does.
 *   IMMUTABILITY  UPDATE, DELETE and TRUNCATE of a revision are refused by the
 *                 database; a project's owner cannot change and its head cannot
 *                 move back; deleting a project still removes its revisions.
 *   AUDIT         every change, and only a change, writes its PlatformAuditLog
 *                 entry, with numbers and a hash and never the document.
 *   RECOVERY      the backup's own pg_dump arguments, then pg_restore into an
 *                 empty database, bring back every project and revision with
 *                 the same hashes, and the immutability triggers with them.
 *
 * Runs when PRODUCT_DESIGN_DB_DATABASE_URL names a PostgreSQL server it may
 * create roles and databases on; CI sets PRODUCT_DESIGN_DB_REQUIRED=1 so a
 * missing URL fails instead of skipping. The recovery test needs pg_dump and
 * pg_restore of the server's major version on PATH.
 */
import { spawnSync } from 'child_process';
import { randomBytes, createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { Application } from 'express';

const ADMIN_URL = process.env.PRODUCT_DESIGN_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.PRODUCT_DESIGN_DB_REQUIRED === '1') {
  throw new Error('PRODUCT_DESIGN_DB_REQUIRED=1 but PRODUCT_DESIGN_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

const tag = randomBytes(4).toString('hex');
const ROLE = `fam_pd_owner_${tag}`;
const PASSWORD = `pw_${randomBytes(12).toString('hex')}`;
const DB = `fam_pd_${tag}`;
const RESTORED = `fam_pd_restored_${tag}`;
const API = '/api/v1/system/product-design';
const CLUB_API = '/api/v1/club-design';
const ROOT = path.join(__dirname, '..');

function urlFor(database: string, user?: string, password?: string): string {
  const u = new URL(ADMIN_URL || 'postgresql://placeholder@localhost:5432/postgres');
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const TEMPLATE = C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/football-jersey.json'), 'utf8')));
const doc = (name: string) => C.createDocument(TEMPLATE, name);
const sha = (d: unknown) => createHash('sha256').update(C.serializeDocument(d), 'utf8').digest('hex');

const C1 = `club-pd-${tag}`;
const C2 = `club-pd2-${tag}`;
const USERS = {
  owner: { id: `pd-owner-${tag}`, role: 'SUPER_ADMIN', clubId: C1 },
  clubAdmin: { id: `pd-admin-${tag}`, role: 'CLUB_ADMIN', clubId: C1 },
  coach: { id: `pd-coach-${tag}`, role: 'COACH', clubId: C1 },
  formerAdmin: { id: `pd-former-${tag}`, role: 'CLUB_ADMIN', clubId: C1 },
  manager: { id: `pd-manager-${tag}`, role: 'MANAGER', clubId: C1 },
  otherAdmin: { id: `pd-admin2-${tag}`, role: 'CLUB_ADMIN', clubId: C2 },
} as const;
type Who = keyof typeof USERS;

suite('Design Studio persistence, on real PostgreSQL', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let app: Application;
  let signToken: (kind: 'access', claims: Row, opts: Row) => string;

  const asSystem = <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
      return fn(tx as unknown as PrismaClient);
    });

  const as = (who: Who | null) => {
    const u = who ? USERS[who] : null;
    const auth = u ? `Bearer ${signToken('access', { sub: u.id, role: u.role, tv: 0 }, { expiresIn: '10m' })}` : '';
    const withAuth = (r: request.Test) => (auth ? r.set('Authorization', auth) : r);
    return {
      get: (url: string) => withAuth(request(app).get(API + url)),
      post: (url: string, body: Row = {}) => withAuth(request(app).post(API + url)).send(body),
      /** The same session on the club routes. */
      club: {
        get: (url: string) => withAuth(request(app).get(CLUB_API + url)),
        post: (url: string, body: Row = {}) => withAuth(request(app).post(CLUB_API + url)).send(body),
      },
    };
  };
  const owner = {
    get: (url: string) => as('owner').get(url),
    post: (url: string, body: Row = {}) => as('owner').post(url, body),
  };

  /** The test's own look at the tables: on the named system path, as backups and the restore drill read them. */
  const sys = <T = Row[]>(sql: string, ...params: unknown[]): Promise<T> => asSystem((tx) => tx.$queryRawUnsafe<T>(sql, ...params));
  const sysExec = (sql: string, ...params: unknown[]): Promise<number> => asSystem((tx) => tx.$executeRawUnsafe(sql, ...params));
  /** The same statement in one club's context, as the application sends it. */
  const inClub = <T>(clubId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'club', true), set_config('familista.club_id', ${clubId}, true)`;
      return fn(tx as unknown as PrismaClient);
    });
  const designRows = async () => ({
    projects: Number((await sys('SELECT count(*)::int AS n FROM "DesignProject"'))[0].n),
    revisions: Number((await sys('SELECT count(*)::int AS n FROM "DesignRevision"'))[0].n),
    audit: Number((await sys(`SELECT count(*)::int AS n FROM "PlatformAuditLog" WHERE "action" LIKE 'design.%'`))[0].n),
  });
  const revisionsOf = (projectId: string) => sys(
    'SELECT "number", "kind"::text AS kind, "restoredFrom", "sha256", "bytes", "document" FROM "DesignRevision" WHERE "projectId" = $1 ORDER BY "number"', projectId);

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE ROLE "${ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD '${PASSWORD}'`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB}" OWNER "${ROLE}"`);
    const url = urlFor(DB, ROLE, PASSWORD);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status}): ${migrate.stderr}`);
    db = new PrismaClient({ datasources: { db: { url } } });
    await asSystem(async (tx) => {
      await tx.club.create({ data: { id: C1, name: 'Home FC', city: 'X' } });
      await tx.club.create({ data: { id: C2, name: 'Away FC', city: 'Y' } });
      // The Club Design Studio as shipped: off for every club and plan; Home FC has it by the platform owner's override.
      await tx.featureFlag.create({ data: { key: 'club_design_studio', name: 'Club Design Studio', defaultEnabled: false, enabledForPlans: [] } });
      await tx.organizationLimits.create({ data: { clubId: C1, featuresEnabled: ['club_design_studio'] } });
      for (const u of Object.values(USERS)) {
        await tx.user.create({ data: { id: u.id, clubId: u.clubId, email: `${u.id}@test.invalid`, passwordHash: 'x', firstName: 'T', lastName: u.id, role: u.role } });
      }
      await tx.platformAdmin.create({ data: { userId: USERS.formerAdmin.id, role: 'PLATFORM_ADMIN', isActive: false } });
    });
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    // As production runs: the application sends its database context on every protected-table query.
    process.env.DB_RLS_CONTEXT = 'on';
    /* eslint-disable @typescript-eslint/no-var-requires */
    signToken = require('../src/security/jwt-tokens').signToken;
    app = require('../src/app').createApp();
    /* eslint-enable @typescript-eslint/no-var-requires */
  }, 240_000);

  afterAll(async () => {
    await db?.$disconnect();
    await require('../src/config/database').prisma.$disconnect().catch(() => undefined);
    for (const d of [DB, RESTORED]) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin?.$disconnect();
  });

  it('the migrations made the two tables and their guards, and hold both to row-level security', async () => {
    const checks = await db.$queryRawUnsafe<Row[]>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('"DesignProject"'::regclass, '"DesignRevision"'::regclass) ORDER BY conname`);
    expect(checks.map((c) => c.conname)).toEqual([
      'DesignProject_context_active', 'DesignProject_owner_shape', 'DesignProject_shape', 'DesignRevision_kind_shape', 'DesignRevision_shape',
    ]);
    const triggers = await db.$queryRawUnsafe<Row[]>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('"DesignProject"'::regclass, '"DesignRevision"'::regclass) ORDER BY tgname`);
    expect(triggers.map((t) => t.tgname)).toEqual(['DesignProject_guard', 'DesignRevision_immutable', 'DesignRevision_no_truncate']);
    const rls = await db.$queryRawUnsafe<Row[]>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('DesignProject', 'DesignRevision') ORDER BY relname`);
    expect(rls).toEqual(['DesignProject', 'DesignRevision'].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
    const policies = await db.$queryRawUnsafe<Row[]>(
      `SELECT tablename, policyname, cmd, permissive, qual, with_check FROM pg_policies WHERE tablename IN ('DesignProject', 'DesignRevision') ORDER BY tablename`);
    expect(policies.map((q) => [q.tablename, q.policyname, q.cmd, q.permissive])).toEqual([
      ['DesignProject', 'DesignProject_club_isolation', 'ALL', 'PERMISSIVE'], ['DesignRevision', 'DesignRevision_club_isolation', 'ALL', 'PERMISSIVE']]);
    expect(policies[0].qual).toBe('familista_rls_club_ok("clubId")');
    expect(policies[0].with_check).toBe('familista_rls_club_ok("clubId")');
    for (const q of [policies[1].qual, policies[1].with_check]) expect(q).toMatch(/^familista_rls_club_ok\(\( SELECT p\."clubId"/);
    const [{ enforced }] = await db.$queryRawUnsafe<Row[]>('SELECT public.familista_rls_enforced() AS enforced');
    expect(enforced).toBe(true);
  });

  describe('access: the platform owner alone, refused before anything is written', () => {
    const someId = '00000000-0000-4000-8000-000000000000';
    // Every row has all four values: a missing one would make Jest pass its `done` callback in its place.
    const routes: Array<[string, 'get' | 'post', string, Row]> = [
      ['list', 'get', '/projects', {}],
      ['create', 'post', '/projects', { document: {}, origin: 'EDITOR' }],
      ['open', 'get', `/projects/${someId}`, {}],
      ['save', 'post', `/projects/${someId}/revisions`, { baseRevision: 1, document: {} }],
      ['revisions', 'get', `/projects/${someId}/revisions`, {}],
      ['revision', 'get', `/projects/${someId}/revisions/1`, {}],
      ['restore', 'post', `/projects/${someId}/revisions/1/restore`, { baseRevision: 1 }],
      ['archive', 'post', `/projects/${someId}/archive`, {}],
      ['unarchive', 'post', `/projects/${someId}/unarchive`, {}],
    ];
    it.each(routes)('%s: no session 401; club admin, coach and a deactivated platform admin 403', async (_n, verb, url, body) => {
      const before = await designRows();
      const anon = verb === 'get' ? await as(null).get(url) : await as(null).post(url, body);
      expect(anon.status).toBe(401);
      for (const who of ['clubAdmin', 'coach', 'formerAdmin'] as const) {
        const r = verb === 'get' ? await as(who).get(url) : await as(who).post(url, { ...body, document: doc('Not yours') });
        expect({ who, status: r.status }).toEqual({ who, status: 403 });
      }
      expect(await designRows()).toEqual(before);
    });

    it('a request from a foreign origin is refused and writes nothing', async () => {
      const before = await designRows();
      const r = await owner.post('/projects', { document: doc('Cross-site'), origin: 'EDITOR' }).set('Origin', 'https://evil.example');
      expect(r.status).toBe(403);
      expect(await designRows()).toEqual(before);
    });
  });

  describe('documents are the editor core\'s, checked on the server', () => {
    it('refuses an invalid document, an unknown template, an oversized one and a body with extra keys — and writes nothing', async () => {
      const before = await designRows();
      const bad = doc('Bad'); bad.palette[0].srgb = 'blue';
      const r1 = await owner.post('/projects', { document: bad, origin: 'EDITOR' });
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('DESIGN_DOCUMENT_INVALID');
      expect(r1.body.errors).toContainEqual({ code: 'bad-colour', path: 'document.palette[0].srgb' });

      const other = doc('Other'); other.template = { key: 'football-jersey.unknown', version: 1 };
      const r2 = await owner.post('/projects', { document: other, origin: 'EDITOR' });
      expect(r2.body.errors).toContainEqual({ code: 'unknown-template', path: 'document.template' });

      const crowded = doc('Crowded'); crowded.surfaces[0].layers.push(...Array.from({ length: 60 }, (_, i) => ({ ...crowded.surfaces[0].layers[1], id: `x${i}` })));
      const r3 = await owner.post('/projects', { document: crowded, origin: 'EDITOR' });
      expect(r3.body.errors).toContainEqual({ code: 'bad-layers', path: 'document.surfaces[0].layers' });
      // Larger than any valid document can be: refused by the body parser before any handler runs. The shared
      // error handler answers that refusal 500 rather than 413 for every route in the application (it has no
      // case for the parser's entity.too.large); that predates this room and is reported, not changed, here.
      const huge = { ...doc('Huge'), padding: 'x'.repeat(3 * 1024 * 1024) };
      const tooBig = await owner.post('/projects', { document: huge, origin: 'EDITOR' });
      expect(tooBig.status).toBeGreaterThanOrEqual(400);
      expect(tooBig.body.success).not.toBe(true);

      const extra = await owner.post('/projects', { document: doc('Extra'), origin: 'EDITOR', ownerKind: 'CLUB', clubId: C1 });
      expect(extra.status).toBe(400);
      expect((await owner.post('/projects', { document: doc('Bad origin'), origin: 'SOMEWHERE' })).status).toBe(400);
      expect(await designRows()).toEqual(before);
    });
  });

  describe('a project, its revisions, conflicts and restores', () => {
    let id = '';
    const first = doc('Home kit 2027');
    const second = (() => { const d = doc('Home kit 2027'); d.palette[0].srgb = '#102a7a'; return d; })();

    it('creates a project as revision 1, stored canonically with the hash of its canonical text, and audited', async () => {
      const r = await owner.post('/projects', { document: first, origin: 'BROWSER_DRAFT' });
      expect(r.status).toBe(201);
      id = r.body.data.project.id;
      expect(r.body.data.project).toMatchObject({ name: 'Home kit 2027', headRevision: 1, origin: 'BROWSER_DRAFT', archivedAt: null, templateKey: TEMPLATE.key });
      expect(r.body.data.revision).toMatchObject({ number: 1, kind: 'CREATE', restoredFrom: null, sha256: sha(first) });
      const [row] = await revisionsOf(id);
      expect(sha(row.document)).toBe(row.sha256);
      expect(row.bytes).toBe(Buffer.byteLength(C.serializeDocument(first), 'utf8'));
      const audit = await sys(`SELECT "action", "category"::text AS category, "userId", "clubId", "resourceType", "resourceId", "metadata" FROM "PlatformAuditLog" WHERE "resourceId" = $1`, id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'design.project.created', category: 'ASSET', userId: USERS.owner.id, clubId: null, resourceType: 'DesignProject' });
      expect(audit[0].metadata).toMatchObject({ revision: 1, origin: 'BROWSER_DRAFT', sha256: sha(first) });
      expect(JSON.stringify(audit[0].metadata)).not.toContain('Home kit');
    });

    it('opens it: the newest document, exactly as saved', async () => {
      const r = await owner.get(`/projects/${id}`);
      expect(r.status).toBe(200);
      expect(C.serializeDocument(r.body.data.revision.document)).toBe(C.serializeDocument(first));
    });

    it('saves on the head; a save on a stale base is refused with the head it lost to and writes nothing', async () => {
      const ok = await owner.post(`/projects/${id}/revisions`, { baseRevision: 1, document: second });
      expect(ok.status).toBe(201);
      expect(ok.body.data.revision).toMatchObject({ number: 2, kind: 'SAVE', sha256: sha(second) });
      const before = await designRows();
      const stale = await owner.post(`/projects/${id}/revisions`, { baseRevision: 1, document: doc('Somebody else') });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'DESIGN_REVISION_CONFLICT', data: { headRevision: 2 } });
      expect(await designRows()).toEqual(before);
    });

    it('a retried save that already landed answers that revision instead of a conflict, and adds nothing', async () => {
      const before = await designRows();
      const again = await owner.post(`/projects/${id}/revisions`, { baseRevision: 1, document: second });
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ replayed: true, revision: { number: 2, sha256: sha(second) } });
      expect(await designRows()).toEqual(before);
    });

    it('of eight saves racing from one base, exactly one lands', async () => {
      const head = (await owner.get(`/projects/${id}`)).body.data.project.headRevision;
      const before = await designRows();
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => owner.post(`/projects/${id}/revisions`, { baseRevision: head, document: doc(`Racer ${i}`) })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
      const after = await designRows();
      expect(after).toEqual({ projects: before.projects, revisions: before.revisions + 1, audit: before.audit + 1 });
      const p = (await owner.get(`/projects/${id}`)).body.data.project;
      expect(p.headRevision).toBe(head + 1);
      const numbers = (await revisionsOf(id)).map((r) => r.number);
      expect(numbers).toEqual(Array.from({ length: head + 1 }, (_, i) => i + 1));
    });

    it('restores revision 1 as a new revision; every stored revision is unchanged', async () => {
      const stored = await revisionsOf(id);
      const head = stored.length;
      const r = await owner.post(`/projects/${id}/revisions/1/restore`, { baseRevision: head });
      expect(r.status).toBe(201);
      expect(r.body.data.revision).toMatchObject({ number: head + 1, kind: 'RESTORE', restoredFrom: 1, sha256: sha(first) });
      expect(r.body.data.project).toMatchObject({ headRevision: head + 1, name: 'Home kit 2027' });
      const now = await revisionsOf(id);
      expect(now.slice(0, head)).toEqual(stored);
      expect(C.serializeDocument(now[head].document)).toBe(C.serializeDocument(first));
      const stale = await owner.post(`/projects/${id}/revisions/2/restore`, { baseRevision: head });
      expect(stale.status).toBe(409);
      expect(stale.body.data.headRevision).toBe(head + 1);
    });

    it('lists revisions newest first without documents, and reads any one with its document', async () => {
      const list = await owner.get(`/projects/${id}/revisions`);
      expect(list.status).toBe(200);
      const numbers = list.body.data.revisions.map((r: Row) => r.number);
      expect(numbers).toEqual([...numbers].sort((a: number, b: number) => b - a));
      expect(list.body.data.revisions.every((r: Row) => !('document' in r))).toBe(true);
      const one = await owner.get(`/projects/${id}/revisions/2`);
      expect(one.body.data.revision).toMatchObject({ number: 2, sha256: sha(second) });
      expect((await owner.get(`/projects/${id}/revisions/999`)).status).toBe(404);
      expect((await owner.get('/projects/00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await owner.get('/projects/not-a-uuid')).status).toBe(400);
    });

    it('archives and returns a project; an archived project cannot be saved; each change is audited once', async () => {
      const head = (await owner.get(`/projects/${id}`)).body.data.project.headRevision;
      const auditBefore = (await designRows()).audit;
      expect((await owner.post(`/projects/${id}/archive`)).body.data.project.archivedAt).not.toBeNull();
      expect((await owner.post(`/projects/${id}/archive`)).status).toBe(200);
      const active = (await owner.get('/projects')).body.data.projects.map((p: Row) => p.id);
      const archived = (await owner.get('/projects?state=archived')).body.data.projects.map((p: Row) => p.id);
      expect(active).not.toContain(id);
      expect(archived).toContain(id);
      const refused = await owner.post(`/projects/${id}/revisions`, { baseRevision: head, document: doc('While archived') });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('DESIGN_PROJECT_ARCHIVED');
      expect((await owner.post(`/projects/${id}/unarchive`)).body.data.project.archivedAt).toBeNull();
      expect((await owner.post(`/projects/${id}/revisions`, { baseRevision: head, document: doc('Back again') })).status).toBe(201);
      const actions = await db.$queryRawUnsafe<Row[]>(`SELECT "action" FROM "PlatformAuditLog" WHERE "resourceId" = $1 ORDER BY "createdAt", "action"`, id);
      expect(actions.slice(-3).map((a) => a.action)).toEqual(['design.project.archived', 'design.project.unarchived', 'design.revision.saved']);
      expect((await designRows()).audit).toBe(auditBefore + 3);
    });
  });

  describe('ownership and immutability, in the database itself', () => {
    it('admits PLATFORM and CLUB projects, not PERSONAL yet; a CLUB project is invisible to every platform route', async () => {
      const insert = (id: string, kind: string, clubId: string | null, userId: string | null) => sysExec(
        `INSERT INTO "DesignProject" ("id","ownerKind","clubId","ownerUserId","name","templateKey","templateVersion","headRevision","origin","createdById") VALUES ($1,$2::"DesignOwnerKind",$3,$4,'Kit','${TEMPLATE.key}',1,1,'EDITOR','x')`,
        id, kind, clubId, userId);
      await expect(insert('22222222-2222-4222-8222-222222222222', 'PERSONAL', null, USERS.coach.id)).rejects.toThrow(/DesignProject_context_active/);
      await expect(insert('33333333-3333-4333-8333-333333333333', 'CLUB', null, null)).rejects.toThrow(/DesignProject_owner_shape/);
      const clubId = '11111111-1111-4111-8111-111111111111';
      await insert(clubId, 'CLUB', C1, null);
      await sysExec(
        `INSERT INTO "DesignRevision" ("id","projectId","number","kind","document","sha256","bytes","formatVersion","authorUserId") VALUES ('club-r1',$1,1,'CREATE',$2::jsonb,$3,10,1,'x')`,
        clubId, JSON.stringify(doc('Club kit')), sha(doc('Club kit')));
      expect((await owner.get('/projects')).body.data.projects.map((p: Row) => p.id)).not.toContain(clubId);
      expect((await owner.get('/projects?state=archived')).body.data.projects.map((p: Row) => p.id)).not.toContain(clubId);
      for (const [verb, url, body] of [
        ['get', `/projects/${clubId}`], ['get', `/projects/${clubId}/revisions`], ['get', `/projects/${clubId}/revisions/1`],
        ['post', `/projects/${clubId}/revisions`, { baseRevision: 1, document: doc('Taken') }],
        ['post', `/projects/${clubId}/revisions/1/restore`, { baseRevision: 1 }],
        ['post', `/projects/${clubId}/archive`],
      ] as Array<[string, string, Row?]>) {
        const r = verb === 'get' ? await owner.get(url) : await owner.post(url, body);
        expect({ url, status: r.status }).toEqual({ url, status: 404 });
      }
      const [p] = await sys('SELECT "headRevision", "archivedAt" FROM "DesignProject" WHERE "id" = $1', clubId);
      expect(p).toEqual({ headRevision: 1, archivedAt: null });
      await sysExec('DELETE FROM "DesignProject" WHERE "id" = $1', clubId);
    });

    it('refuses UPDATE, DELETE and TRUNCATE of a revision, an owner change and a head moved back or skipped — on the system path itself', async () => {
      const [r] = await sys('SELECT "id", "projectId" FROM "DesignRevision" ORDER BY "createdAt" LIMIT 1');
      await expect(sysExec('UPDATE "DesignRevision" SET "bytes" = "bytes" + 1 WHERE "id" = $1', r.id)).rejects.toThrow(/never changed/);
      await expect(sysExec('DELETE FROM "DesignRevision" WHERE "id" = $1', r.id)).rejects.toThrow(/never changed/);
      await expect(sysExec('TRUNCATE "DesignRevision"')).rejects.toThrow(/never changed/);
      await expect(sysExec(`UPDATE "DesignProject" SET "createdById" = 'someone' WHERE "id" = $1`, r.projectId)).rejects.toThrow(/refused/);
      await expect(sysExec('UPDATE "DesignProject" SET "headRevision" = "headRevision" - 1 WHERE "id" = $1', r.projectId)).rejects.toThrow(/refused/);
      await expect(sysExec('UPDATE "DesignProject" SET "headRevision" = "headRevision" + 2 WHERE "id" = $1', r.projectId)).rejects.toThrow(/refused/);
      // and without a database context the same statements reach nothing at all: fail closed
      expect(await db.$executeRawUnsafe('UPDATE "DesignProject" SET "name" = "name" WHERE "id" = $1', r.projectId)).toBe(0);
      expect(await db.$queryRawUnsafe<Row[]>('SELECT "id" FROM "DesignRevision"')).toEqual([]);
    });

    it('deleting a whole project still removes its revisions (the cascade is the one way out)', async () => {
      const made = await owner.post('/projects', { document: doc('Disposable'), origin: 'EDITOR' });
      const pid = made.body.data.project.id;
      await owner.post(`/projects/${pid}/revisions`, { baseRevision: 1, document: doc('Disposable 2') });
      await sysExec('DELETE FROM "DesignProject" WHERE "id" = $1', pid);
      expect(await revisionsOf(pid)).toEqual([]);
    });
  });

  describe('clubs: the Club Design Studio', () => {
    const someId = '00000000-0000-4000-8000-000000000000';
    let homeProject = '';

    it('serves a club’s administrators and managers alone, and only while the club is entitled — refusing before anything is written', async () => {
      const before = await designRows();
      expect((await as(null).club.get('/projects')).status).toBe(401);
      // A coach is refused by the platform's role guard (authorize), an administrator of a club not entitled by the entitlement.
      for (const [who, code] of [['coach', undefined], ['otherAdmin', 'DESIGN_STUDIO_NOT_ENABLED']] as const) {
        for (const r of [await as(who).club.get('/projects'), await as(who).club.post('/projects', { document: doc('Not yours'), origin: 'EDITOR' }),
          await as(who).club.get(`/projects/${someId}`)]) {
          expect({ who, status: r.status, code: r.body.code }).toEqual({ who, status: 403, code });
        }
      }
      // The platform owner works on the platform's routes, not inside a club's studio.
      expect((await as('owner').club.get('/projects')).status).toBe(403);
      expect(await designRows()).toEqual(before);
    });

    it('a club administrator creates, saves, restores and archives the club’s own design, audited with the club', async () => {
      const made = await as('clubAdmin').club.post('/projects', { document: doc('Home FC 2027 home'), origin: 'EDITOR' });
      expect(made.status).toBe(201);
      homeProject = made.body.data.project.id;
      const saved = await as('manager').club.post(`/projects/${homeProject}/revisions`, { baseRevision: 1, document: doc('Home FC 2027 home, v2') });
      expect(saved.status).toBe(201);
      expect((await as('manager').club.post(`/projects/${homeProject}/revisions/1/restore`, { baseRevision: 2 })).status).toBe(201);
      expect((await as('clubAdmin').club.get(`/projects/${homeProject}/revisions`)).body.data.revisions.map((r: Row) => r.number)).toEqual([3, 2, 1]);
      expect((await as('clubAdmin').club.get('/projects')).body.data.projects.map((p: Row) => p.id)).toEqual([homeProject]);
      const [row] = await sys('SELECT "ownerKind"::text AS kind, "clubId", "ownerUserId", "headRevision" FROM "DesignProject" WHERE "id" = $1', homeProject);
      expect(row).toEqual({ kind: 'CLUB', clubId: C1, ownerUserId: null, headRevision: 3 });
      const audit = await sys('SELECT "action", "clubId", "userId" FROM "PlatformAuditLog" WHERE "resourceId" = $1 ORDER BY "createdAt"', homeProject);
      expect(audit).toEqual([
        { action: 'design.project.created', clubId: C1, userId: USERS.clubAdmin.id },
        { action: 'design.revision.saved', clubId: C1, userId: USERS.manager.id },
        { action: 'design.revision.restored', clubId: C1, userId: USERS.manager.id },
      ]);
    });

    it('a club reaches no design but its own: not the platform’s, not another club’s, by list or by id', async () => {
      const platform = (await owner.get('/projects')).body.data.projects.map((p: Row) => p.id);
      expect(platform.length).toBeGreaterThan(0);
      expect(platform).not.toContain(homeProject);
      expect((await as('clubAdmin').club.get('/projects')).body.data.projects.map((p: Row) => p.id)).not.toContain(platform[0]);
      expect((await as('clubAdmin').club.get(`/projects/${platform[0]}`)).status).toBe(404);
      expect((await owner.get(`/projects/${homeProject}`)).status).toBe(404);
      // Away FC, entitled now, still sees nothing of Home FC's.
      await sysExec(`INSERT INTO "OrganizationLimits" ("id","clubId","featuresEnabled","updatedAt") VALUES ($1,$2,ARRAY['club_design_studio'],now())`, `ol-${tag}`, C2);
      const before = await designRows();
      expect((await as('otherAdmin').club.get('/projects')).body.data.projects).toEqual([]);
      for (const [verb, url, body] of [
        ['get', `/projects/${homeProject}`], ['get', `/projects/${homeProject}/revisions`], ['get', `/projects/${homeProject}/revisions/1`],
        ['post', `/projects/${homeProject}/revisions`, { baseRevision: 3, document: doc('Taken') }],
        ['post', `/projects/${homeProject}/revisions/1/restore`, { baseRevision: 3 }],
        ['post', `/projects/${homeProject}/archive`],
      ] as Array<[string, string, Row?]>) {
        const r = verb === 'get' ? await as('otherAdmin').club.get(url) : await as('otherAdmin').club.post(url, body);
        expect({ url, status: r.status }).toEqual({ url, status: 404 });
      }
      expect(await designRows()).toEqual(before);
    });

    it('row-level security: the database itself gives a club its own designs and revisions only, and accepts no write into another club’s', async () => {
      const count = (clubId: string, table: string) => inClub(clubId, (tx) => tx.$queryRawUnsafe<Row[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${table === 'DesignProject' ? 'id' : 'projectId'}" = $1`, homeProject)).then((r) => r[0].n);
      expect([await count(C1, 'DesignProject'), await count(C1, 'DesignRevision')]).toEqual([1, 3]);
      expect([await count(C2, 'DesignProject'), await count(C2, 'DesignRevision')]).toEqual([0, 0]);
      // A club sees none of the platform's designs (they have no club: the system path alone reaches them).
      expect(await inClub(C1, (tx) => tx.$queryRawUnsafe<Row[]>(`SELECT count(*)::int AS n FROM "DesignProject" WHERE "ownerKind" = 'PLATFORM'`)).then((r) => r[0].n)).toBe(0);
      // Away FC can neither change Home FC's project nor add a revision to it, nor create a project in Home FC's name.
      expect(await inClub(C2, (tx) => tx.$executeRawUnsafe('UPDATE "DesignProject" SET "name" = $2 WHERE "id" = $1', homeProject, 'Taken'))).toBe(0);
      await expect(inClub(C2, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO "DesignRevision" ("id","projectId","number","kind","document","sha256","bytes","formatVersion","authorUserId") VALUES ('x-r4',$1,4,'SAVE','{}'::jsonb,'x',2,1,'x')`, homeProject)))
        .rejects.toThrow(/row-level security/);
      await expect(inClub(C2, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO "DesignProject" ("id","ownerKind","clubId","name","templateKey","templateVersion","headRevision","origin","createdById") VALUES ('44444444-4444-4444-8444-444444444444','CLUB',$1,'Taken','${TEMPLATE.key}',1,1,'EDITOR','x')`, C1)))
        .rejects.toThrow(/row-level security/);
      const [p] = await sys('SELECT "name", "headRevision" FROM "DesignProject" WHERE "id" = $1', homeProject);
      expect(p).toEqual({ name: 'Home FC 2027 home', headRevision: 3 });
    });

    it('negative control: with FORCE removed by hand, the tables’ owner (the application’s role) reads across clubs — so the checks above see the database’s enforcement', async () => {
      await db.$executeRawUnsafe('ALTER TABLE "DesignProject" NO FORCE ROW LEVEL SECURITY');
      try {
        expect(await inClub(C2, (tx) => tx.$queryRawUnsafe<Row[]>('SELECT count(*)::int AS n FROM "DesignProject" WHERE "id" = $1', homeProject)).then((r) => r[0].n)).toBe(1);
      } finally {
        await db.$executeRawUnsafe('ALTER TABLE "DesignProject" FORCE ROW LEVEL SECURITY');
      }
      expect(await inClub(C2, (tx) => tx.$queryRawUnsafe<Row[]>('SELECT count(*)::int AS n FROM "DesignProject" WHERE "id" = $1', homeProject)).then((r) => r[0].n)).toBe(0);
    });
  });

  it('recovery: the backup\'s own pg_dump arguments and pg_restore bring back every design with the same hashes, and its guards', async () => {
    const { pgDumpArgs } = require('../src/security/backup/backup-runner'); // eslint-disable-line @typescript-eslint/no-var-requires
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-pd-'));
    const file = path.join(dir, 'dump');
    try {
      const out = fs.openSync(file, 'w');
      // The backup's own system path (PGOPTIONS), without which a dump of tables under row-level security holds none of their rows.
      const { BACKUP_PG_OPTIONS } = require('../src/security/backup/backup-config'); // eslint-disable-line @typescript-eslint/no-var-requires
      const dump = spawnSync('pg_dump', pgDumpArgs(urlFor(DB, ROLE, PASSWORD)), { stdio: ['ignore', out, 'pipe'], encoding: 'utf8', timeout: 120_000, env: { ...process.env, PGOPTIONS: BACKUP_PG_OPTIONS } });
      fs.closeSync(out);
      if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${RESTORED}" OWNER "${ROLE}"`);
      const restore = spawnSync('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${urlFor(RESTORED, ROLE, PASSWORD)}`, file], { encoding: 'utf8', timeout: 180_000 });
      if (restore.status !== 0) throw new Error(`pg_restore failed: ${restore.stderr}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    const back = new PrismaClient({ datasources: { db: { url: urlFor(RESTORED, ROLE, PASSWORD) } } });
    try {
      const q = 'SELECT p."id", p."headRevision", r."number", r."sha256", r."document" FROM "DesignProject" p JOIN "DesignRevision" r ON r."projectId" = p."id" ORDER BY p."id", r."number"';
      const original = await sys(q);
      const backSys = <T>(fn: (tx: PrismaClient) => Promise<T>) => back.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
        return fn(tx as unknown as PrismaClient);
      });
      const restored = await backSys((tx) => tx.$queryRawUnsafe<Row[]>(q));
      expect(original.length).toBe((await designRows()).revisions);
      expect(original.length).toBeGreaterThanOrEqual(5);
      expect(restored).toEqual(original);
      for (const row of restored) expect(sha(row.document)).toBe(row.sha256);
      await expect(backSys((tx) => tx.$executeRawUnsafe('UPDATE "DesignRevision" SET "bytes" = "bytes" + 1'))).rejects.toThrow(/never changed/);
      // and the restored copy holds the same row-level security
      expect(await back.$queryRawUnsafe<Row[]>(`SELECT relname FROM pg_class WHERE relname IN ('DesignProject','DesignRevision') AND relrowsecurity AND relforcerowsecurity ORDER BY relname`))
        .toEqual([{ relname: 'DesignProject' }, { relname: 'DesignRevision' }]);
    } finally { await back.$disconnect(); }
  }, 300_000);
});
