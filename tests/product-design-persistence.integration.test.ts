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
      put: (url: string, body: Row = {}) => withAuth(request(app).put(API + url)).send(body),
      /** The same session on any other route. */
      raw: (url: string) => withAuth(request(app).get(url)),
      /** The same session on the club routes. */
      club: {
        get: (url: string) => withAuth(request(app).get(CLUB_API + url)),
        post: (url: string, body: Row = {}) => withAuth(request(app).post(CLUB_API + url)).send(body),
        put: (url: string, body: Row = {}) => withAuth(request(app).put(CLUB_API + url)).send(body),
        del: (url: string) => withAuth(request(app).delete(CLUB_API + url)),
        /** Raw bytes, as the room uploads a logo. */
        upload: (url: string, bytes: Buffer, type: string) => withAuth(request(app).post(CLUB_API + url)).set('Content-Type', type).send(bytes),
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

  it('the migrations made the design tables and their guards, and hold them to row-level security', async () => {
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
      `SELECT tablename, policyname, cmd, permissive, qual, with_check FROM pg_policies WHERE tablename IN ('DesignProject', 'DesignRevision') AND policyname LIKE '%\\_tenant\\_isolation' ORDER BY tablename`);
    // P4: beside its owner's isolation, a design and its versions are readable through a live share, and only read.
    const shared = await db.$queryRawUnsafe<Row[]>(`SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN ('DesignProject', 'DesignRevision') AND policyname NOT LIKE '%\\_tenant\\_isolation' ORDER BY tablename`);
    expect(shared.map((q) => [q.tablename, q.policyname, q.cmd])).toEqual([['DesignProject', 'DesignProject_shared_read', 'SELECT'], ['DesignRevision', 'DesignRevision_shared_read', 'SELECT']]);
    expect(policies.map((q) => [q.tablename, q.policyname, q.cmd, q.permissive])).toEqual([
      ['DesignProject', 'DesignProject_tenant_isolation', 'ALL', 'PERMISSIVE'], ['DesignRevision', 'DesignRevision_tenant_isolation', 'ALL', 'PERMISSIVE']]);
    // P2: a project's owner is a club or a creator; its revisions follow the project's.
    expect(policies[0].qual).toBe('familista_rls_owner_ok("clubId", "creatorId")');
    expect(policies[0].with_check).toBe('familista_rls_owner_ok("clubId", "creatorId")');
    for (const q of [policies[1].qual, policies[1].with_check]) expect(q).toMatch(/familista_rls_owner_ok\(p\."clubId", p\."creatorId"\)/);
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
    it('admits each kind of project in its own shape only (a PERSONAL one is a creator’s, P2); a CLUB project is invisible to every platform route', async () => {
      const insert = (id: string, kind: string, clubId: string | null, userId: string | null) => sysExec(
        `INSERT INTO "DesignProject" ("id","ownerKind","clubId","ownerUserId","name","templateKey","templateVersion","headRevision","origin","createdById") VALUES ($1,$2::"DesignOwnerKind",$3,$4,'Kit','${TEMPLATE.key}',1,1,'EDITOR','x')`,
        id, kind, clubId, userId);
      // A personal project is owned by a creator account, never by a club user and never with a club.
      await expect(insert('22222222-2222-4222-8222-222222222222', 'PERSONAL', null, USERS.coach.id)).rejects.toThrow(/DesignProject_owner_shape/);
      await expect(insert('22222222-2222-4222-8222-222222222223', 'PERSONAL', C1, null)).rejects.toThrow(/DesignProject_owner_shape/);
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

    it('the session says what the routes do: canDesignClubKits for an entitled club’s administrator and manager, and nobody else', async () => {
      const cap = async (who: Who) => {
        const r = await as(who).raw('/api/v1/me/context');
        expect({ who, status: r.status }).toEqual({ who, status: 200 });
        return r.body.data.effectiveAccess.canDesignClubKits;
      };
      expect({ clubAdmin: await cap('clubAdmin'), manager: await cap('manager'), coach: await cap('coach'), owner: await cap('owner'), otherAdmin: await cap('otherAdmin') })
        .toEqual({ clubAdmin: true, manager: true, coach: false, owner: false, otherAdmin: false });
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

    describe('the brand kit (M2c)', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const image = (w: number, h: number, fmt: 'png' | 'jpeg') => sharp({ create: { width: w, height: h, channels: 3, background: '#1f4fd6' } })[fmt]().toBuffer() as Promise<Buffer>;
      let crest = '';

      it('keeps a club’s colours, refusing malformed ones and writing nothing for them', async () => {
        expect((await as('clubAdmin').club.get('/brand-kit')).body.data).toMatchObject({ colours: [], assets: [] });
        const ok = await as('manager').club.put('/brand-kit/colours', { colours: [{ label: ' Home blue ', srgb: '#1F4FD6' }, { label: 'Gold', srgb: '#d8ad3c' }] });
        expect(ok.status).toBe(200);
        expect(ok.body.data.colours).toEqual([{ label: 'Home blue', srgb: '#1f4fd6' }, { label: 'Gold', srgb: '#d8ad3c' }]);
        const before = await sys('SELECT "colours" FROM "DesignBrandKit" WHERE "clubId" = $1', C1);
        for (const bad of [[{ label: 'x', srgb: 'red' }], [{ label: '', srgb: '#000000' }], Array.from({ length: 25 }, (_, i) => ({ label: `c${i}`, srgb: '#000000' })), [{ label: 'x', srgb: '#000000', extra: 1 }]]) {
          const r = await as('clubAdmin').club.put('/brand-kit/colours', { colours: bad });
          expect([r.status, r.body.code]).toEqual([400, 'BRAND_COLOURS_INVALID']);
        }
        expect(await sys('SELECT "colours" FROM "DesignBrandKit" WHERE "clubId" = $1', C1)).toEqual(before);
      });

      it('keeps a logo only as the PNG the server re-encoded: never the uploaded bytes', async () => {
        const upload = Buffer.concat([await image(1600, 800, 'jpeg'), Buffer.from('<script>appended-marker</script>')]);
        const r = await as('clubAdmin').club.upload('/brand-kit/assets?kind=CREST&name=Home%20crest', upload, 'image/jpeg');
        expect(r.status).toBe(201);
        crest = r.body.data.asset.id;
        expect(r.body.data.asset).toMatchObject({ kind: 'CREST', name: 'Home crest', width: 1024, height: 512 });
        const img = await as('clubAdmin').club.get(`/brand-kit/assets/${crest}/image`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
        expect(img.status).toBe(200);
        expect(img.headers['content-type']).toBe('image/png');
        expect(img.headers['x-content-type-options']).toBe('nosniff');
        expect(img.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
        const served = img.body as Buffer;
        expect(served.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(served.includes(Buffer.from('appended-marker'))).toBe(false);
        const [row] = await sys('SELECT "sha256", "bytes", "clubId" FROM "DesignBrandAsset" WHERE "id" = $1', crest);
        expect(row).toEqual({ sha256: createHash('sha256').update(served).digest('hex'), bytes: served.length, clubId: C1 });
        const [audit] = await sys(`SELECT "action", "clubId", "metadata" FROM "PlatformAuditLog" WHERE "resourceId" = $1`, crest);
        expect(audit).toMatchObject({ action: 'design.brand.asset.added', clubId: C1, metadata: { kind: 'CREST', width: 1024, height: 512 } });
      });

      it('refuses SVG, a renamed text file, an oversized upload and a bad name — writing nothing', async () => {
        const before = Number((await sys('SELECT count(*)::int AS n FROM "DesignBrandAsset"'))[0].n);
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        for (const [bytes, type, reason, status] of [[svg, 'image/png', 'unsupported-type', 415], [Buffer.from('plain text'), 'application/octet-stream', 'unsupported-type', 415]] as Array<[Buffer, string, string, number]>) {
          const r = await as('clubAdmin').club.upload('/brand-kit/assets?kind=MARK&name=x', bytes, type);
          expect([r.status, r.body.code, r.body.reason]).toEqual([status, 'BRAND_IMAGE_REFUSED', reason]);
        }
        expect((await as('clubAdmin').club.upload('/brand-kit/assets?kind=MARK&name=x', Buffer.alloc(6 * 1024 * 1024, 1), 'image/png')).status).toBe(413);
        expect((await as('clubAdmin').club.upload('/brand-kit/assets?kind=LOGO&name=x', await image(64, 64, 'png'), 'image/png')).status).toBe(400);
        expect((await as('clubAdmin').club.upload('/brand-kit/assets?kind=MARK&name=', await image(64, 64, 'png'), 'image/png')).status).toBe(400);
        expect(Number((await sys('SELECT count(*)::int AS n FROM "DesignBrandAsset"'))[0].n)).toBe(before);
      });

      it('is the club’s alone: refused to a coach, invisible to another club by list and by id, and held so by the database', async () => {
        expect((await as('coach').club.get('/brand-kit')).status).toBe(403);
        expect((await as('otherAdmin').club.get('/brand-kit')).body.data.assets).toEqual([]);
        expect((await as('otherAdmin').club.get(`/brand-kit/assets/${crest}/image`)).status).toBe(404);
        expect((await as('otherAdmin').club.post(`/brand-kit/assets/${crest}/archive`)).status).toBe(404);
        expect(await inClub(C2, (tx) => tx.$queryRawUnsafe<Row[]>('SELECT count(*)::int AS n FROM "DesignBrandAsset" WHERE "id" = $1', crest)).then((r) => r[0].n)).toBe(0);
        expect(await inClub(C1, (tx) => tx.$queryRawUnsafe<Row[]>('SELECT count(*)::int AS n FROM "DesignBrandAsset" WHERE "id" = $1', crest)).then((r) => r[0].n)).toBe(1);
        await expect(inClub(C2, (tx) => tx.$executeRawUnsafe(`UPDATE "DesignBrandKit" SET "colours" = '[]'::jsonb WHERE "clubId" = $1`, C1)).then((n) => n)).resolves.toBe(0);
      });

      it('the database refuses an asset that is not a PNG, or whose club is not its kit’s — on the system path too', async () => {
        const [kit] = await sys('SELECT "id" FROM "DesignBrandKit" WHERE "clubId" = $1', C1);
        await expect(sysExec(`INSERT INTO "DesignBrandAsset" ("id","clubId","kitId","kind","name","png","width","height","bytes","sha256","createdById") VALUES ($1,$2,$3,'MARK','x',$4,1,1,9,$5,'x')`,
          '55555555-5555-4555-8555-555555555555', C1, kit.id, Buffer.from('GIF89a...'), 'a'.repeat(64))).rejects.toThrow(/DesignBrandAsset_shape/);
        await expect(sysExec(`INSERT INTO "DesignBrandAsset" ("id","clubId","kitId","kind","name","png","width","height","bytes","sha256","createdById") VALUES ($1,$2,$3,'MARK','x',$4,1,1,16,$5,'x')`,
          '66666666-6666-4666-8666-666666666666', C2, kit.id, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]), 'a'.repeat(64))).rejects.toThrow(/DesignBrandAsset_kitId_clubId_fkey/);
      });

      it('archives a logo out of the kit, still serving it to the club, and returns it', async () => {
        expect((await as('manager').club.post(`/brand-kit/assets/${crest}/archive`)).status).toBe(200);
        expect((await as('clubAdmin').club.get('/brand-kit')).body.data.assets.map((a: Row) => a.id)).not.toContain(crest);
        expect((await as('clubAdmin').club.get('/brand-kit?state=archived')).body.data.assets.map((a: Row) => a.id)).toEqual([crest]);
        expect((await as('clubAdmin').club.get(`/brand-kit/assets/${crest}/image`)).status).toBe(200);
        expect((await as('manager').club.post(`/brand-kit/assets/${crest}/unarchive`)).status).toBe(200);
        expect((await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "resourceId" = $1 ORDER BY "createdAt"`, crest)).map((a) => a.action))
          .toEqual(['design.brand.asset.added', 'design.brand.asset.archived', 'design.brand.asset.unarchived']);
      });

      it('a design may name its own club’s logo at its kept size — never another club’s, a wrong size, or any logo on the platform’s designs (M2c-2)', async () => {
        const withLogo = (name: string, asset: string, px: [number, number]) => {
          const d = doc(name) as Row;
          d.surfaces[0].layers.push({ id: 'logo', type: 'image', name: 'Home crest', visible: true, locked: false, asset, px, x: 270, y: 220, w: 60, h: 30, r: 0, w0: 60, h0: 30 });
          return d;
        };
        const ok = await as('clubAdmin').club.post('/projects', { document: withLogo('Crest kit', crest, [1024, 512]), origin: 'EDITOR' });
        expect(ok.status).toBe(201);
        const [rev] = await sys(`SELECT "document" FROM "DesignRevision" WHERE "projectId" = $1`, ok.body.data.project.id);
        expect(rev.document.surfaces[0].layers.find((l: Row) => l.id === 'logo')).toMatchObject({ type: 'image', asset: crest, px: [1024, 512] });
        const before = await designRows();
        const refused: Array<[string, Row, string]> = [
          ['otherAdmin', withLogo('Taken crest', crest, [1024, 512]), 'unknown-brand-asset'],
          ['clubAdmin', withLogo('Wrong size', crest, [512, 256]), 'brand-asset-size'],
          ['clubAdmin', withLogo('No such logo', '77777777-7777-4777-8777-777777777777', [10, 10]), 'unknown-brand-asset'],
        ];
        for (const [who, d, code] of refused) {
          const r = await as(who as Who).club.post('/projects', { document: d, origin: 'EDITOR' });
          expect([who, r.status, r.body.code, (r.body.errors || []).map((e: Row) => e.code)]).toEqual([who, 400, 'DESIGN_DOCUMENT_INVALID', [code]]);
        }
        const platform = await owner.post('/projects', { document: withLogo('Platform with a logo', crest, [1024, 512]), origin: 'EDITOR' });
        expect([platform.status, platform.body.errors.map((e: Row) => e.code)]).toEqual([400, ['image-not-allowed']]);
        // and a save of an existing club design is held to the same rule
        const save = await as('otherAdmin').club.post('/projects', { document: doc('Away kit'), origin: 'EDITOR' });
        const away = save.body.data.project.id;
        const r = await as('otherAdmin').club.post(`/projects/${away}/revisions`, { baseRevision: 1, document: withLogo('Away kit', crest, [1024, 512]) });
        expect([r.status, r.body.errors.map((e: Row) => e.code)]).toEqual([400, ['unknown-brand-asset']]);
        const after = await designRows();
        expect({ projects: after.projects - before.projects, revisions: after.revisions - before.revisions }).toEqual({ projects: 1, revisions: 1 });
      });
    });

    describe('team rosters (M3)', () => {
      const E = (over: Row = {}) => ({ name: 'SMITH', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1, ...over });
      const rosterRows = async () => Number((await sys('SELECT count(*)::int AS n FROM "DesignRoster"'))[0].n);
      const rosterOf = async (id: string) => (await sys('SELECT "name", "entries", "entryCount", "version", "archivedAt" FROM "DesignRoster" WHERE "id" = $1', id))[0];
      let home = '';
      // Away FC is entitled too, so what it cannot reach is held by the tenancy checks, not the entitlement.
      beforeAll(async () => {
        await sysExec(`INSERT INTO "OrganizationLimits" ("id","clubId","featuresEnabled","updatedAt") SELECT $1,$2,ARRAY['club_design_studio'],now()
          WHERE NOT EXISTS (SELECT 1 FROM "OrganizationLimits" WHERE "clubId" = $2)`, `ol-${tag}`, C2);
      });

      it('the migration made the table, its shape check and its row-level security', async () => {
        const [t] = await db.$queryRawUnsafe<Row[]>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'DesignRoster'`);
        expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const [pol] = await db.$queryRawUnsafe<Row[]>(`SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'DesignRoster'`);
        expect(pol).toEqual({ policyname: 'DesignRoster_tenant_isolation', cmd: 'ALL', qual: 'familista_rls_owner_ok("clubId", "creatorId")', with_check: 'familista_rls_owner_ok("clubId", "creatorId")' });
        const checks = await db.$queryRawUnsafe<Row[]>(`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = '"DesignRoster"'::regclass ORDER BY conname`);
        expect(checks.map((c) => c.conname)).toEqual(['DesignRoster_one_owner', 'DesignRoster_shape']);
      });

      it('serves a club’s administrators and managers alone, refusing before anything is written', async () => {
        const before = await rosterRows();
        expect((await as(null).club.get('/rosters')).status).toBe(401);
        for (const r of [await as('coach').club.get('/rosters'), await as('coach').club.post('/rosters', { name: 'Coach list', entries: [E()] }),
          await as('coach').club.get('/squad-names'), await as('owner').club.get('/rosters')]) expect(r.status).toBe(403);
        expect(await rosterRows()).toBe(before);
      });

      it('creates and opens a roster with the editor core’s checks, refusing what the core refuses and writing nothing for it', async () => {
        const r = await as('clubAdmin').club.post('/rosters', { name: '  First team  2026/27 ', entries: [E(), E({ name: 'MÜLLER', number: 4, top: 'XL', qty: 2 }), E({ name: '', number: 1, top: null, shorts: null, socks: null })] });
        expect(r.status).toBe(201);
        home = r.body.data.roster.id;
        expect(r.body.data.roster).toMatchObject({ name: 'First team 2026/27', entryCount: 3, version: 1, archivedAt: null });
        expect((await as('manager').club.get(`/rosters/${home}`)).body.data.roster.entries).toEqual(r.body.data.roster.entries);
        expect(await rosterOf(home)).toMatchObject({ entryCount: 3, version: 1 });
        const before = await rosterRows();
        const refused: Array<[Row, string, string]> = [
          [{ name: 'X', entries: [E({ number: 100 })] }, 'bad-number', 'entries[0].number'],
          [{ name: 'X', entries: [E({ name: '=HYPERLINK("x")' })] }, 'bad-name', 'entries[0].name'],
          [{ name: 'X', entries: [E({ name: 'A'.repeat(21) })] }, 'name-too-long', 'entries[0].name'],
          [{ name: 'X', entries: [{ ...E(), email: 'a@b.c' }] }, 'bad-entry', 'entries[0]'],
          [{ name: 'X', entries: [E({ top: 'XXL' })] }, 'bad-size', 'entries[0].top'],
          [{ name: 'X', entries: Array.from({ length: 151 }, () => E()) }, 'too-many-entries', 'entries'],
          [{ name: '   ', entries: [] }, 'bad-roster-name', 'name'],
        ];
        for (const [body, reason, at] of refused) {
          const x = await as('clubAdmin').club.post('/rosters', body);
          expect([x.status, x.body.code, x.body.reason, x.body.path]).toEqual([400, 'ROSTER_INVALID', reason, at]);
        }
        expect((await as('clubAdmin').club.post('/rosters', { name: 'X', entries: [], clubId: C2 })).status).toBe(400); // no request names a club
        expect(await rosterRows()).toBe(before);
      });

      it('saves on its version; a save on a stale one is refused with the version it lost to and writes nothing; of six racing saves one lands', async () => {
        const ok = await as('manager').club.put(`/rosters/${home}`, { name: 'First team 2026/27', entries: [E(), E({ name: 'JONES', number: 10 })], version: 1 });
        expect([ok.status, ok.body.data.roster.version, ok.body.data.roster.entryCount]).toEqual([200, 2, 2]);
        const stale = await as('clubAdmin').club.put(`/rosters/${home}`, { name: 'Overwrite', entries: [], version: 1 });
        expect([stale.status, stale.body.code, stale.body.data.version]).toEqual([409, 'ROSTER_CONFLICT', 2]);
        expect(await rosterOf(home)).toMatchObject({ name: 'First team 2026/27', entryCount: 2, version: 2 });
        const race = await Promise.all(Array.from({ length: 6 }, (_, i) => as('clubAdmin').club.put(`/rosters/${home}`, { name: 'First team 2026/27', entries: [E({ number: 20 + i })], version: 2 })));
        expect(race.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
        expect(await rosterOf(home)).toMatchObject({ entryCount: 1, version: 3 });
      });

      it('audits every change with the club, in counts: never a name, a number or a size', async () => {
        const rows = await sys(`SELECT "action", "clubId", "metadata", "message" FROM "PlatformAuditLog" WHERE "resourceType" = 'DesignRoster' AND "resourceId" = $1 ORDER BY "createdAt"`, home);
        expect(rows.map((a) => a.action)).toEqual(['design.roster.created', 'design.roster.saved', 'design.roster.saved']);
        expect(rows.every((a) => a.clubId === C1)).toBe(true);
        expect(rows[0].metadata).toMatchObject({ entries: 3, sets: 4 });
        const text = JSON.stringify(rows);
        for (const word of ['SMITH', 'MÜLLER', 'JONES', '39-42']) expect(text).not.toContain(word);
      });

      it('a club reaches no roster but its own: by list, by id, by every verb', async () => {
        const away = await as('otherAdmin').club.post('/rosters', { name: 'Away squad', entries: [E({ name: 'AWAY' })] });
        expect(away.status).toBe(201);
        expect((await as('otherAdmin').club.get('/rosters')).body.data.rosters.map((x: Row) => x.id)).toEqual([away.body.data.roster.id]);
        expect((await as('clubAdmin').club.get('/rosters')).body.data.rosters.map((x: Row) => x.id)).not.toContain(away.body.data.roster.id);
        const before = await rosterOf(home);
        for (const r of [await as('otherAdmin').club.get(`/rosters/${home}`), await as('otherAdmin').club.put(`/rosters/${home}`, { name: 'Taken', entries: [], version: 3 }),
          await as('otherAdmin').club.post(`/rosters/${home}/archive`), await as('otherAdmin').club.post(`/rosters/${home}/unarchive`), await as('otherAdmin').club.del(`/rosters/${home}`)]) {
          expect(r.status).toBe(404);
        }
        expect(await rosterOf(home)).toEqual(before);
      });

      it('row-level security: the database itself gives a club its own rosters only, and accepts no write into another club’s', async () => {
        const seen = await inClub(C2, (tx) => tx.designRoster.findMany({ select: { clubId: true } }));
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((x) => x.clubId === C2)).toBe(true);
        expect(await inClub(C2, (tx) => tx.designRoster.updateMany({ where: { id: home }, data: { name: 'Taken' } }))).toEqual({ count: 0 });
        await expect(inClub(C2, (tx) => tx.designRoster.create({ data: { clubId: C1, name: 'Planted', createdById: USERS.otherAdmin.id, updatedById: USERS.otherAdmin.id } })))
          .rejects.toThrow(/row-level security/);
        // and the shape is the database's own rule, on the system path too
        await expect(sysExec(`INSERT INTO "DesignRoster" ("id","clubId","name","entries","entryCount","createdById","updatedById","updatedAt") VALUES ($1,$2,'x','[{}]'::jsonb,0,'u','u',now())`,
          '88888888-8888-4888-8888-888888888888', C1)).rejects.toThrow(/DesignRoster_shape/);
      });

      it('archives a roster, refuses to save it while archived, deletes only an archived one, and then for good', async () => {
        expect((await as('clubAdmin').club.del(`/rosters/${home}`)).body.code).toBe('ROSTER_ARCHIVED');
        expect((await as('clubAdmin').club.post(`/rosters/${home}/archive`)).status).toBe(200);
        expect((await as('clubAdmin').club.get('/rosters')).body.data.rosters.map((x: Row) => x.id)).not.toContain(home);
        expect((await as('clubAdmin').club.get('/rosters?state=archived')).body.data.rosters.map((x: Row) => x.id)).toEqual([home]);
        const save = await as('clubAdmin').club.put(`/rosters/${home}`, { name: 'Late', entries: [], version: 3 });
        expect([save.status, save.body.code]).toEqual([409, 'ROSTER_ARCHIVED']);
        expect((await as('manager').club.del(`/rosters/${home}`)).status).toBe(200);
        expect(await rosterOf(home)).toBeUndefined();
        expect((await as('clubAdmin').club.get(`/rosters/${home}`)).status).toBe(404);
        const actions = (await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "resourceId" = $1 ORDER BY "createdAt"`, home)).map((a) => a.action);
        expect(actions.slice(-2)).toEqual(['design.roster.archived', 'design.roster.deleted']);
      });

      it('the squad’s names: the club’s own active players, surname and number only', async () => {
        const player = (id: string, clubId: string, lastName: string, number: number, isActive = true) => ({
          id: `${id}-${tag}`, clubId, firstName: 'First', lastName, number, isActive, position: 'MC' as const, nationality: 'X', flag: 'x',
          dateOfBirth: new Date('2008-04-01'), height: 170, weight: 60, parentName: 'A parent',
        });
        await asSystem(async (tx) => {
          for (const p of [player('p1', C1, 'Smith', 9), player('p2', C1, 'Ødegaard', 8), player('p3', C1, 'Gone', 5, false), player('p4', C1, 'Big', 120), player('p5', C2, 'Away', 7)]) {
            await tx.player.create({ data: p });
          }
        });
        const r = await as('manager').club.get('/squad-names');
        expect(r.status).toBe(200);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.body.data.players).toEqual([{ name: 'Ødegaard', number: 8 }, { name: 'Smith', number: 9 }, { name: 'Big', number: null }]);
        expect(JSON.stringify(r.body)).not.toMatch(/2008|parent|First/);
        expect((await as('otherAdmin').club.get('/squad-names')).body.data.players).toEqual([{ name: 'Away', number: 7 }]);
      });
    });

    describe('collections (M3b)', () => {
      const SHORTS = C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/shorts.json'), 'utf8')));
      const E = (over: Row = {}) => ({ name: 'SMITH', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1, ...over });
      const collectionRows = async () => ({
        collections: Number((await sys('SELECT count(*)::int AS n FROM "DesignCollection"'))[0].n),
        items: Number((await sys('SELECT count(*)::int AS n FROM "DesignCollectionItem"'))[0].n),
      });
      let shirt = '', shorts = '', away = '', roster = '', awayRoster = '', kit = '';

      beforeAll(async () => {
        await sysExec(`INSERT INTO "OrganizationLimits" ("id","clubId","featuresEnabled","updatedAt") SELECT $1,$2,ARRAY['club_design_studio'],now()
          WHERE NOT EXISTS (SELECT 1 FROM "OrganizationLimits" WHERE "clubId" = $2)`, `ol-${tag}`, C2);
        shirt = (await as('clubAdmin').club.post('/projects', { document: doc('Home shirt 26/27'), origin: 'EDITOR' })).body.data.project.id;
        shorts = (await as('clubAdmin').club.post('/projects', { document: C.createDocument(SHORTS, 'Home shorts 26/27'), origin: 'EDITOR' })).body.data.project.id;
        away = (await as('otherAdmin').club.post('/projects', { document: doc('Away FC shirt'), origin: 'EDITOR' })).body.data.project.id;
        roster = (await as('clubAdmin').club.post('/rosters', { name: 'First team', entries: [E(), E({ name: 'JONES', top: 'L', shorts: 'L', qty: 2 }), E({ name: 'KEEPER', top: null, shorts: 'XL' })] })).body.data.roster.id;
        awayRoster = (await as('otherAdmin').club.post('/rosters', { name: 'Away squad', entries: [E({ name: 'AWAY' })] })).body.data.roster.id;
        expect([shirt, shorts, away, roster, awayRoster].every(Boolean)).toBe(true);
      });

      it('the migration made both tables, their checks, the roster trigger and their row-level security', async () => {
        const rls = await db.$queryRawUnsafe<Row[]>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('DesignCollection', 'DesignCollectionItem') ORDER BY relname`);
        expect(rls).toEqual(['DesignCollection', 'DesignCollectionItem'].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
        const pol = await db.$queryRawUnsafe<Row[]>(`SELECT tablename, qual, with_check FROM pg_policies WHERE tablename IN ('DesignCollection', 'DesignCollectionItem') ORDER BY tablename`);
        expect(pol.map((q) => [q.tablename, q.qual, q.with_check])).toEqual(['DesignCollection', 'DesignCollectionItem'].map((t) => [t, 'familista_rls_owner_ok("clubId", "creatorId")', 'familista_rls_owner_ok("clubId", "creatorId")']));
        const trig = await db.$queryRawUnsafe<Row[]>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = '"DesignCollection"'::regclass`);
        expect(trig.map((t) => t.tgname)).toEqual(['DesignCollection_roster_club']);
      });

      it('creates a collection of the club’s own designs and roster, each design with its garment form; audited in counts', async () => {
        const r = await as('manager').club.post('/collections', { name: ' Home kit ', season: '2026/27', rosterId: roster, items: [{ projectId: shirt, role: 'HOME' }, { projectId: shorts, role: 'HOME' }] });
        expect(r.status).toBe(201);
        kit = r.body.data.collection.id;
        expect(r.body.data.collection).toMatchObject({ name: 'Home kit', season: '2026/27', rosterId: roster, version: 1 });
        expect(r.body.data.collection.items.map((i: Row) => [i.projectId, i.role, i.position, i.form, i.name])).toEqual([
          [shirt, 'HOME', 0, 'top', 'Home shirt 26/27'], [shorts, 'HOME', 1, 'shorts', 'Home shorts 26/27']]);
        const list = (await as('clubAdmin').club.get('/collections')).body.data.collections;
        expect(list.map((c: Row) => [c.id, c.items])).toEqual([[kit, 2]]);
        const [a] = await sys(`SELECT "action", "clubId", "metadata" FROM "PlatformAuditLog" WHERE "resourceId" = $1`, kit);
        expect([a.action, a.clubId, a.metadata.designs, a.metadata.roster]).toEqual(['design.collection.created', C1, 2, true]);
        expect(JSON.stringify(a)).not.toMatch(/Home shirt|Home kit|SMITH/);
      });

      it('refuses another club’s design or roster, a design twice, too many, or an unknown role — writing nothing', async () => {
        const before = await collectionRows();
        const refused: Array<[Row, number, string | undefined, string | undefined]> = [
          [{ name: 'X', items: [{ projectId: away, role: 'HOME' }] }, 400, 'unknown-design', 'items[0].projectId'],
          [{ name: 'X', rosterId: awayRoster, items: [] }, 400, 'unknown-roster', 'rosterId'],
          [{ name: 'X', items: [{ projectId: shirt, role: 'HOME' }, { projectId: shirt, role: 'AWAY' }] }, 400, 'duplicate-design', 'items[1].projectId'],
          [{ name: 'X', items: Array.from({ length: 13 }, () => ({ projectId: shirt, role: 'HOME' })) }, 400, 'too-many-designs', 'items'],
          [{ name: '   ', items: [] }, 400, 'bad-collection-name', 'name'],
          [{ name: 'X', season: 'S'.repeat(21), items: [] }, 400, 'bad-season', 'season'],
        ];
        for (const [body, status, reason, at] of refused) {
          const x = await as('clubAdmin').club.post('/collections', body);
          expect([x.status, x.body.code, x.body.reason, x.body.path]).toEqual([status, 'COLLECTION_INVALID', reason, at]);
        }
        expect((await as('clubAdmin').club.post('/collections', { name: 'X', items: [{ projectId: shirt, role: 'PLAYER' }] })).status).toBe(400);
        expect((await as('clubAdmin').club.post('/collections', { name: 'X', items: [], clubId: C2 })).status).toBe(400);
        expect(await collectionRows()).toEqual(before);
      });

      it('the order sheet: the roster’s sets per size for each design’s garment form, by the editor’s own rule', async () => {
        const r = await as('clubAdmin').club.get(`/collections/${kit}/order-sheet`);
        expect(r.status).toBe(200);
        expect(r.body.data.sheet.roster).toMatchObject({ id: roster, entries: 3, sets: 4 });
        expect(r.body.data.sheet.garments.map((g: Row) => [g.form, g.sizes, g.unsized, g.sets])).toEqual([
          ['top', [{ size: 'M', sets: 1 }, { size: 'L', sets: 2 }], 1, 4],
          ['shorts', [{ size: 'L', sets: 3 }, { size: 'XL', sets: 1 }], 0, 4],
        ]);
        // another club's roster cannot be asked for, by id
        expect((await as('clubAdmin').club.get(`/collections/${kit}/order-sheet?rosterId=${awayRoster}`)).status).toBe(404);
      });

      it('saves on its version; a stale save is refused and writes nothing; of four racing saves one lands', async () => {
        const ok = await as('clubAdmin').club.put(`/collections/${kit}`, { name: 'Home kit', season: '2026/27', rosterId: roster, items: [{ projectId: shorts, role: 'HOME' }, { projectId: shirt, role: 'HOME' }], version: 1 });
        expect([ok.status, ok.body.data.collection.version, ok.body.data.collection.items.map((i: Row) => i.projectId)]).toEqual([200, 2, [shorts, shirt]]);
        const stale = await as('manager').club.put(`/collections/${kit}`, { name: 'Lost', items: [], version: 1 });
        expect([stale.status, stale.body.code, stale.body.data.version]).toEqual([409, 'COLLECTION_CONFLICT', 2]);
        const race = await Promise.all(Array.from({ length: 4 }, (_, i) => as('clubAdmin').club.put(`/collections/${kit}`, { name: `Home kit ${i}`, rosterId: roster, items: [{ projectId: shirt, role: 'HOME' }], version: 2 })));
        expect(race.map((x) => x.status).sort()).toEqual([200, 409, 409, 409]);
        const [row] = await sys('SELECT "version" FROM "DesignCollection" WHERE "id" = $1', kit);
        expect(row.version).toBe(3);
        expect(Number((await sys('SELECT count(*)::int AS n FROM "DesignCollectionItem" WHERE "collectionId" = $1', kit))[0].n)).toBe(1);
      });

      it('a club reaches no collection but its own, by every verb', async () => {
        const before = await collectionRows();
        expect((await as('otherAdmin').club.get('/collections')).body.data.collections.map((c: Row) => c.id)).not.toContain(kit);
        for (const r of [await as('otherAdmin').club.get(`/collections/${kit}`), await as('otherAdmin').club.get(`/collections/${kit}/order-sheet`),
          await as('otherAdmin').club.put(`/collections/${kit}`, { name: 'Taken', items: [{ projectId: away, role: 'HOME' }], version: 3 }),
          await as('otherAdmin').club.post(`/collections/${kit}/archive`), await as('otherAdmin').club.del(`/collections/${kit}`)]) {
          expect(r.status).toBe(404);
        }
        expect(await collectionRows()).toEqual(before);
      });

      it('the database holds every item and roster to one club: row-level security, the composite keys and the trigger, on the system path too', async () => {
        const seen = await inClub(C2, (tx) => tx.designCollection.findMany({ select: { clubId: true } }));
        expect(seen.every((c) => c.clubId === C2)).toBe(true);
        expect(await inClub(C2, (tx) => tx.designCollectionItem.count({ where: { collectionId: kit } }))).toBe(0);
        // An item gathering another club's design into this club's collection: the composite key refuses it.
        await expect(sysExec(`INSERT INTO "DesignCollectionItem" ("id","clubId","collectionId","projectId","role","position") VALUES ($1,$2,$3,$4,'AWAY',5)`,
          '99999999-9999-4999-8999-999999999991', C1, kit, away)).rejects.toThrow(/DesignCollectionItem_projectId_clubId_fkey/);
        // The same item claiming the other club: the collection is not that club's.
        await expect(sysExec(`INSERT INTO "DesignCollectionItem" ("id","clubId","collectionId","projectId","role","position") VALUES ($1,$2,$3,$4,'AWAY',5)`,
          '99999999-9999-4999-8999-999999999992', C2, kit, away)).rejects.toThrow(/DesignCollectionItem_collectionId_clubId_fkey/);
        // Another club's roster, named on the system path: the trigger refuses it.
        await expect(sysExec(`UPDATE "DesignCollection" SET "rosterId" = $1 WHERE "id" = $2`, awayRoster, kit)).rejects.toThrow(/DesignCollection_roster_club/);
        // and in a club's own context, row-level security refuses the write outright
        await expect(inClub(C2, (tx) => tx.designCollection.create({ data: { clubId: C1, name: 'Planted', createdById: USERS.otherAdmin.id, updatedById: USERS.otherAdmin.id } })))
          .rejects.toThrow(/row-level security/);
      });

      it('deleting the roster clears it from the collection; archiving refuses saves; deleting removes the gathering, never the designs', async () => {
        expect((await as('clubAdmin').club.post(`/rosters/${roster}/archive`)).status).toBe(200);
        expect((await as('clubAdmin').club.del(`/rosters/${roster}`)).status).toBe(200);
        expect((await as('clubAdmin').club.get(`/collections/${kit}`)).body.data.collection.rosterId).toBeNull();
        expect((await as('clubAdmin').club.get(`/collections/${kit}/order-sheet`)).body.data.sheet.roster).toBeNull();
        expect((await as('clubAdmin').club.del(`/collections/${kit}`)).body.code).toBe('COLLECTION_ARCHIVED');
        expect((await as('clubAdmin').club.post(`/collections/${kit}/archive`)).status).toBe(200);
        const late = await as('clubAdmin').club.put(`/collections/${kit}`, { name: 'Late', items: [], version: 3 });
        expect([late.status, late.body.code]).toEqual([409, 'COLLECTION_ARCHIVED']);
        expect((await as('manager').club.del(`/collections/${kit}`)).status).toBe(200);
        expect(await collectionRows()).toMatchObject({ items: 0 });
        expect((await as('clubAdmin').club.get(`/projects/${shirt}`)).status).toBe(200);
        const actions = (await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "resourceId" = $1 ORDER BY "createdAt"`, kit)).map((a) => a.action);
        expect(actions).toEqual(['design.collection.created', 'design.collection.saved', 'design.collection.saved', 'design.collection.archived', 'design.collection.deleted']);
      });
    });

    describe('what the club’s plan includes (M7a)', () => {
      const parts = async (who: Who) => (await as(who).raw('/api/v1/me/context')).body.data.effectiveAccess.clubDesignParts;
      const someId = '00000000-0000-4000-8000-000000000000';
      const refusedFor = async (who: Who, url: string, verb: 'get' | 'post' = 'get') => {
        const r = verb === 'get' ? await as(who).club.get(url) : await as(who).club.post(url, {});
        return r.status === 403 && r.body.code === 'DESIGN_FEATURE_NOT_ENABLED' ? r.body.feature : r.status;
      };

      it('by default every part is included where the studio is: the parts change nothing until the Owner restricts one', async () => {
        for (const url of ['/rosters', '/brand-kit', '/requests', '/collections']) expect([url, (await as('manager').club.get(url)).status]).toEqual([url, 200]);
        expect(await parts('manager')).toEqual({ teamKit: true, brandKit: true, manufacturing: true, reviews: true });
        expect(await parts('coach')).toEqual({ teamKit: false, brandKit: false, manufacturing: false, reviews: false });
      });

      it('restricted to a plan: refused before anything is written for a club on another plan, served to one on it', async () => {
        await sysExec(`INSERT INTO "FeatureFlag" ("id","key","name","defaultEnabled","enabledForPlans","updatedAt") VALUES ($1,'club_design_manufacturing','Manufacturing',false,ARRAY['PRO']::"SubscriptionPlan"[],now())`, `ff-mf-${tag}`);
        const before = Number((await sys('SELECT count(*)::int AS n FROM "ManufacturingRequest"'))[0].n);
        expect(await refusedFor('clubAdmin', '/requests')).toBe('club_design_manufacturing');
        expect(await refusedFor('clubAdmin', `/collections/${someId}/requests`, 'post')).toBe('club_design_manufacturing');
        expect(Number((await sys('SELECT count(*)::int AS n FROM "ManufacturingRequest"'))[0].n)).toBe(before);
        expect((await as('clubAdmin').club.get('/rosters')).status).toBe(200); // the other parts are untouched
        expect(await parts('clubAdmin')).toEqual({ teamKit: true, brandKit: true, manufacturing: false, reviews: true });
        await sysExec(`UPDATE "Club" SET "plan" = 'PRO' WHERE "id" = $1`, C2);
        expect((await as('otherAdmin').club.get('/requests')).status).toBe(200);
        expect(await parts('otherAdmin')).toMatchObject({ manufacturing: true });
      });

      it('a club override wins over the plan, either way; the studio itself stays the gate', async () => {
        await sysExec(`UPDATE "OrganizationLimits" SET "featuresEnabled" = array_append("featuresEnabled", 'club_design_manufacturing'),
          "featuresDisabled" = array_append("featuresDisabled", 'club_design_brand_kit') WHERE "clubId" = $1`, C1);
        expect((await as('clubAdmin').club.get('/requests')).status).toBe(200);
        expect(await refusedFor('clubAdmin', '/brand-kit')).toBe('club_design_brand_kit');
        expect(await parts('clubAdmin')).toEqual({ teamKit: true, brandKit: false, manufacturing: true, reviews: true });
        // The studio switched off for a club: every route says so, whatever its parts.
        await sysExec(`UPDATE "OrganizationLimits" SET "featuresDisabled" = array_append("featuresDisabled", 'club_design_studio') WHERE "clubId" = $1`, C2);
        for (const url of ['/rosters', '/requests', '/brand-kit']) expect([url, (await as('otherAdmin').club.get(url)).body.code]).toEqual([url, 'DESIGN_STUDIO_NOT_ENABLED']);
        expect(await parts('otherAdmin')).toEqual({ teamKit: false, brandKit: false, manufacturing: false, reviews: false });
        // and back as it was, for the tests after these
        await sysExec(`UPDATE "OrganizationLimits" SET "featuresEnabled" = array_remove("featuresEnabled", 'club_design_manufacturing'),
          "featuresDisabled" = array_remove(array_remove("featuresDisabled", 'club_design_brand_kit'), 'club_design_studio') WHERE "clubId" IN ($1, $2)`, C1, C2);
        await sysExec(`DELETE FROM "FeatureFlag" WHERE "key" = 'club_design_manufacturing'`);
        await sysExec(`UPDATE "Club" SET "plan" = 'BASIC' WHERE "id" = $1`, C2);
        expect(await parts('clubAdmin')).toEqual({ teamKit: true, brandKit: true, manufacturing: true, reviews: true });
      });
    });

    describe('the Owner’s rollout control (M8a)', () => {
      const limitsOf = async (club: string) => (await sys('SELECT "featuresEnabled" AS on, "featuresDisabled" AS off FROM "OrganizationLimits" WHERE "clubId" = $1', club))[0];

      it('lists every club with its five settings and what they amount to, as the routes enforce them; the Owner’s alone', async () => {
        const r = await as('owner').get('/rollout');
        expect(r.status).toBe(200);
        expect(r.body.data.keys.map((k: Row) => k.feature)).toEqual(['club_design_studio', 'club_design_team_kit', 'club_design_brand_kit', 'club_design_manufacturing', 'club_design_reviews']);
        const mine = r.body.data.clubs.find((c: Row) => c.id === C1);
        expect(mine.settings).toEqual({ studio: 'on', teamKit: 'default', brandKit: 'default', manufacturing: 'default', reviews: 'default' });
        // the same answer the session gives the club's own administrator
        const ctx = (await as('clubAdmin').raw('/api/v1/me/context')).body.data.effectiveAccess.clubDesignParts;
        expect(mine.effective).toEqual({ studio: true, ...ctx });
        for (const who of ['clubAdmin', 'manager', 'otherAdmin'] as Who[]) expect((await as(who).get('/rollout')).status).toBe(403);
      });

      it('releases and withdraws the studio and its parts for one club, touching nothing else, each change audited', async () => {
        await sysExec(`UPDATE "OrganizationLimits" SET "featuresEnabled" = array_append("featuresEnabled", 'some_other_feature') WHERE "clubId" = $1`, C2);
        const off = await as('owner').put(`/rollout/${C2}`, { studio: 'off', reviews: 'off' });
        expect([off.status, off.body.data.club.settings.studio, off.body.data.club.effective]).toEqual([200, 'off', { studio: false, teamKit: false, brandKit: false, manufacturing: false, reviews: false }]);
        expect((await as('otherAdmin').club.get('/projects')).body.code).toBe('DESIGN_STUDIO_NOT_ENABLED');
        expect(await limitsOf(C2)).toEqual({ on: ['some_other_feature'], off: ['club_design_studio', 'club_design_reviews'] });
        const on = await as('owner').put(`/rollout/${C2}`, { studio: 'on', reviews: 'default' });
        expect(on.body.data.club.effective).toEqual({ studio: true, teamKit: true, brandKit: true, manufacturing: true, reviews: true });
        expect((await as('otherAdmin').club.get('/projects')).status).toBe(200);
        expect(await limitsOf(C2)).toEqual({ on: ['some_other_feature', 'club_design_studio'], off: [] });
        // setting what is already set changes nothing and audits nothing
        const n0 = Number((await sys(`SELECT count(*)::int AS n FROM "PlatformAuditLog" WHERE "action" = 'design.rollout.changed' AND "resourceId" = $1`, C2))[0].n);
        await as('owner').put(`/rollout/${C2}`, { studio: 'on' });
        const audit = await sys(`SELECT "metadata" FROM "PlatformAuditLog" WHERE "action" = 'design.rollout.changed' AND "resourceId" = $1 ORDER BY "createdAt"`, C2);
        expect(audit.length).toBe(n0);
        expect(audit.map((a) => a.metadata.changed)).toEqual([
          [{ key: 'club_design_studio', from: 'on', to: 'off' }, { key: 'club_design_reviews', from: 'default', to: 'off' }],
          [{ key: 'club_design_studio', from: 'off', to: 'on' }, { key: 'club_design_reviews', from: 'off', to: 'default' }],
        ]);
        await sysExec(`UPDATE "OrganizationLimits" SET "featuresEnabled" = array_remove("featuresEnabled", 'some_other_feature') WHERE "clubId" = $1`, C2);
      });

      it('two changes at once to different keys both land (one statement per key, never a read-modify-write)', async () => {
        await Promise.all([as('owner').put(`/rollout/${C2}`, { teamKit: 'off' }), as('owner').put(`/rollout/${C2}`, { brandKit: 'off' }), as('owner').put(`/rollout/${C2}`, { manufacturing: 'on' })]);
        expect(await limitsOf(C2)).toEqual({ on: ['club_design_studio', 'club_design_manufacturing'], off: expect.arrayContaining(['club_design_team_kit', 'club_design_brand_kit']) });
        await as('owner').put(`/rollout/${C2}`, { teamKit: 'default', brandKit: 'default', manufacturing: 'default' });
        expect(await limitsOf(C2)).toEqual({ on: ['club_design_studio'], off: [] });
      });

      it('refuses what it does not know: no setting, another key, another value, a club that does not exist', async () => {
        for (const body of [{}, { studio: 'maybe' }, { billing: 'on' }, { studio: 'on', extra: 1 }]) expect((await as('owner').put(`/rollout/${C2}`, body)).status).toBe(400);
        expect((await as('owner').put('/rollout/no-such-club', { studio: 'on' })).status).toBe(404);
        expect((await as('otherAdmin').put(`/rollout/${C2}`, { studio: 'off' })).status).toBe(403);
        expect((await limitsOf(C2)).on).toContain('club_design_studio');
      });
    });

    describe('reviews and approvals (M7b)', () => {
      let kitDesign = '';
      beforeAll(async () => {
        kitDesign = (await as('clubAdmin').club.post('/projects', { document: doc('Review kit'), origin: 'EDITOR' })).body.data.project.id;
        expect(kitDesign).toBeTruthy();
      });

      it('the migration made both tables, their checks, the decisions’ append-only trigger and their row-level security', async () => {
        const rls = await db.$queryRawUnsafe<Row[]>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('DesignReviewComment', 'DesignApproval') ORDER BY relname`);
        expect(rls).toEqual(['DesignApproval', 'DesignReviewComment'].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
        const trig = await db.$queryRawUnsafe<Row[]>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = '"DesignApproval"'::regclass ORDER BY tgname`);
        expect(trig.map((t) => t.tgname)).toEqual(['DesignApproval_immutable', 'DesignApproval_no_truncate']);
      });

      it('comments on a saved version, on the garment or one of its surfaces; refuses what is not there; resolves and reopens', async () => {
        const ok = await as('manager').club.post(`/projects/${kitDesign}/comments`, { revision: 1, surface: 'back', body: 'Make the number taller' });
        expect(ok.status).toBe(201);
        expect((await as('clubAdmin').club.post(`/projects/${kitDesign}/comments`, { revision: 1, surface: null, body: 'Looks good overall' })).status).toBe(201);
        for (const [body, reason] of [[{ revision: 1, surface: 'hood', body: 'x' }, 'unknown-surface'], [{ revision: 9, surface: null, body: 'x' }, 'unknown-revision'],
          [{ revision: 1, surface: null, body: '   ' }, 'required']] as Array<[Row, string]>) {
          const r = await as('manager').club.post(`/projects/${kitDesign}/comments`, body);
          expect([r.status, r.body.code, r.body.reason]).toEqual([400, 'REVIEW_INVALID', reason]);
        }
        const cid = ok.body.data.commentId;
        expect((await as('clubAdmin').club.post(`/projects/${kitDesign}/comments/${cid}/resolve`)).status).toBe(200);
        let review = (await as('manager').club.get(`/projects/${kitDesign}/review`)).body.data.review;
        expect(review.comments.map((c: Row) => [c.surface, c.body, !!c.resolvedAt, typeof c.by])).toEqual([['back', 'Make the number taller', true, 'string'], [null, 'Looks good overall', false, 'string']]);
        expect(review.surfaces).toEqual(['front', 'back', 'sleeve-right', 'sleeve-left']);
        expect((await as('manager').club.post(`/projects/${kitDesign}/comments/${cid}/reopen`)).status).toBe(200);
        review = (await as('manager').club.get(`/projects/${kitDesign}/review`)).body.data.review;
        expect(review.comments[0].resolvedAt).toBeNull();
        const audit = (await sys(`SELECT "action", "metadata" FROM "PlatformAuditLog" WHERE "resourceId" = $1 AND "action" LIKE 'design.review.%' ORDER BY "createdAt"`, kitDesign));
        expect(audit.map((a) => a.action)).toEqual(['design.review.commented', 'design.review.commented', 'design.review.resolved', 'design.review.reopened']);
        expect(JSON.stringify(audit)).not.toContain('taller'); // counts and places, never the text
      });

      it('a club administrator alone decides, on the newest version only; a new version needs its own approval', async () => {
        const manager = await as('manager').club.post(`/projects/${kitDesign}/decisions`, { revision: 1, decision: 'APPROVED' });
        expect(manager.status).toBe(403);
        expect((await as('clubAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 1, decision: 'CHANGES_REQUESTED' })).body.reason).toBe('required');
        expect((await as('clubAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 1, decision: 'APPROVED', note: 'Ready to order' })).status).toBe(201);
        let review = (await as('manager').club.get(`/projects/${kitDesign}/review`)).body.data.review;
        expect([review.headRevision, review.current.decision, review.current.revision, typeof review.current.by]).toEqual([1, 'APPROVED', 1, 'string']);
        // a new version is not approved by the old one's approval
        expect((await as('manager').club.post(`/projects/${kitDesign}/revisions`, { baseRevision: 1, document: doc('Review kit v2') })).status).toBe(201);
        review = (await as('manager').club.get(`/projects/${kitDesign}/review`)).body.data.review;
        expect([review.headRevision, review.current]).toEqual([2, null]);
        const stale = await as('clubAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 1, decision: 'APPROVED' });
        expect([stale.status, stale.body.code, stale.body.data.headRevision]).toEqual([409, 'REVIEW_STALE', 2]);
        expect((await as('clubAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 2, decision: 'CHANGES_REQUESTED', note: 'The sponsor is too small' })).status).toBe(201);
        review = (await as('manager').club.get(`/projects/${kitDesign}/review`)).body.data.review;
        expect([review.current.decision, review.decisions.map((d: Row) => d.decision)]).toEqual(['CHANGES_REQUESTED', ['CHANGES_REQUESTED', 'APPROVED']]);
        const [row] = await sys(`SELECT "sha256" FROM "DesignApproval" WHERE "projectId" = $1 AND "revision" = 2`, kitDesign);
        const [rev] = await sys(`SELECT "sha256" FROM "DesignRevision" WHERE "projectId" = $1 AND "number" = 2`, kitDesign);
        expect(row.sha256).toBe(rev.sha256); // pinned to the version's own hash
      });

      it('decisions are never changed or removed, on the system path too; another club reaches none of it', async () => {
        await expect(sysExec(`UPDATE "DesignApproval" SET "decision" = 'APPROVED' WHERE "projectId" = $1`, kitDesign)).rejects.toThrow(/DesignApproval_immutable/);
        await expect(sysExec(`DELETE FROM "DesignApproval" WHERE "projectId" = $1`, kitDesign)).rejects.toThrow(/DesignApproval_immutable/);
        const before = Number((await sys('SELECT count(*)::int AS n FROM "DesignReviewComment"'))[0].n);
        for (const r of [await as('otherAdmin').club.get(`/projects/${kitDesign}/review`), await as('otherAdmin').club.post(`/projects/${kitDesign}/comments`, { revision: 1, surface: null, body: 'Taken' }),
          await as('otherAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 2, decision: 'APPROVED' })]) expect(r.status).toBe(404);
        expect(Number((await sys('SELECT count(*)::int AS n FROM "DesignReviewComment"'))[0].n)).toBe(before);
        const seen = await inClub(C2, (tx) => tx.designApproval.count({ where: { projectId: kitDesign } }));
        expect(seen).toBe(0);
      });

      it('the reviews part off for a club: its review routes are refused before anything is written', async () => {
        await sysExec(`UPDATE "OrganizationLimits" SET "featuresDisabled" = array_append("featuresDisabled", 'club_design_reviews') WHERE "clubId" = $1`, C1);
        try {
          const before = Number((await sys('SELECT count(*)::int AS n FROM "DesignReviewComment"'))[0].n);
          for (const r of [await as('clubAdmin').club.get(`/projects/${kitDesign}/review`), await as('clubAdmin').club.post(`/projects/${kitDesign}/comments`, { revision: 1, surface: null, body: 'x' }),
            await as('clubAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 2, decision: 'APPROVED' })]) expect([r.status, r.body.feature]).toEqual([403, 'club_design_reviews']);
          expect(Number((await sys('SELECT count(*)::int AS n FROM "DesignReviewComment"'))[0].n)).toBe(before);
          expect((await as('clubAdmin').raw('/api/v1/me/context')).body.data.effectiveAccess.clubDesignParts).toMatchObject({ reviews: false, teamKit: true });
          expect((await as('clubAdmin').club.get(`/projects/${kitDesign}`)).status).toBe(200); // the studio itself is untouched
        } finally {
          await sysExec(`UPDATE "OrganizationLimits" SET "featuresDisabled" = array_remove("featuresDisabled", 'club_design_reviews') WHERE "clubId" = $1`, C1);
        }
      });

      it('a collection shows each design’s current decision on its newest version', async () => {
        const kit = (await as('clubAdmin').club.post('/collections', { name: 'Reviewed kit', items: [{ projectId: kitDesign, role: 'HOME' }] })).body.data.collection;
        expect(kit.items[0]).toMatchObject({ revision: 2, approval: { revision: 2, decision: 'CHANGES_REQUESTED' } });
        await as('clubAdmin').club.post(`/projects/${kitDesign}/decisions`, { revision: 2, decision: 'APPROVED' });
        expect((await as('manager').club.get(`/collections/${kit.id}`)).body.data.collection.items[0].approval).toMatchObject({ decision: 'APPROVED' });
      });
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
