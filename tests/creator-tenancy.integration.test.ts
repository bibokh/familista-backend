/**
 * Creator Studio, P2 — personal creator accounts and the second kind of tenant, on real PostgreSQL.
 *
 * A freshly migrated database owned by a role that is not a superuser; the application sends each request's database
 * context as production does (DB_RLS_CONTEXT=on). Pinned, each refusal beside the admission it mirrors:
 *   · the schema: exactly one owner on every Design Studio and manufacturing row, a child held to its parent's owner by a
 *     composite key per kind of owner, and row-level security by either owner;
 *   · sign-up only with the Platform Owner's invitation (bound, single use, expiring), the age confirmed, a real password;
 *     only hashes of codes, refresh tokens and links are kept, and none reaches the audit;
 *   · a creator session is never a club session nor the reverse; refresh tokens rotate, and a replaced one presented
 *     again ends its family; a password reset ends every session;
 *   · one creator reaches none of another creator's records, nor a club's, nor a club any creator's — by id through the
 *     routes, and underneath in the database itself;
 *   · a quotation request needs a confirmed address, and reaches the Owner named as the creator's.
 * Runs when PRODUCT_DESIGN_DB_DATABASE_URL names a server it may create roles and databases on; CI requires it.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import request from 'supertest';
import type { Application } from 'express';
import { PrismaClient } from '@prisma/client';

const ADMIN_URL = process.env.PRODUCT_DESIGN_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.PRODUCT_DESIGN_DB_REQUIRED === '1') throw new Error('PRODUCT_DESIGN_DB_DATABASE_URL is required');
const suite = ADMIN_URL ? describe : describe.skip;

const tag = randomBytes(4).toString('hex');
const ROLE = `fam_cr_${tag}`, PASSWORD = `pw_${randomBytes(12).toString('hex')}`, DB = `fam_cr_${tag}`;
const ROOT = path.join(__dirname, '..');
const CR = '/api/v1/creator', CLUB = '/api/v1/club-design', OWNER = '/api/v1/system/product-design';
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function urlFor(database: string, user?: string, password?: string): string {
  const u = new URL(ADMIN_URL || 'postgresql://placeholder@localhost:5432/postgres');
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const SHIRT = C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/football-jersey.json'), 'utf8')));
const C1 = `club-cr-${tag}`;
const USERS = {
  owner: { id: `cr-owner-${tag}`, role: 'SUPER_ADMIN', clubId: C1 },
  admin: { id: `cr-admin-${tag}`, role: 'CLUB_ADMIN', clubId: C1 },
} as const;
const PW = 'correct horse battery';
const C_doc = () => C.createDocument(SHIRT, 'Taken');

suite('Creator Studio tenancy (P2), on real PostgreSQL', () => {
  let admin: PrismaClient, db: PrismaClient, app: Application;
  let signToken: (kind: string, claims: Row, opts: Row) => string;
  const mail: Array<{ to: string; text: string }> = [];
  const sys = <T = Row[]>(sql: string, ...p: unknown[]): Promise<T> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    return tx.$queryRawUnsafe<T>(sql, ...p);
  });
  const sysExec = (sql: string, ...p: unknown[]): Promise<number> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    return tx.$executeRawUnsafe(sql, ...p);
  });
  /** What the database itself shows a session of this kind, whatever the application asks. */
  const seenAs = (mode: 'club' | 'creator', id: string, sql: string): Promise<Row[]> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', ${mode}, true), set_config('familista.club_id', ${mode === 'club' ? id : ''}, true), set_config('familista.creator_id', ${mode === 'creator' ? id : ''}, true)`;
    return tx.$queryRawUnsafe<Row[]>(sql);
  });
  const user = (who: keyof typeof USERS) => `Bearer ${signToken('access', { sub: USERS[who].id, role: USERS[who].role, tv: 0 }, { expiresIn: '10m' })}`;
  const bearer = (auth: string) => ({
    get: (url: string) => request(app).get(url).set('Authorization', auth),
    post: (url: string, body: Row = {}) => request(app).post(url).set('Authorization', auth).send(body),
    put: (url: string, body: Row = {}) => request(app).put(url).set('Authorization', auth).send(body),
    patch: (url: string, body: Row = {}) => request(app).patch(url).set('Authorization', auth).send(body),
  });
  const owner = () => bearer(user('owner'));
  const club = () => bearer(user('admin'));
  const invite = async (body: Row = {}) => (await owner().post(`${OWNER}/creators/invites`, body)).body.data as { code: string; invite: Row };
  const signUp = (code: string, email: string, over: Row = {}) => request(app).post(`${CR}/auth/register`)
    .send({ inviteCode: code, email, password: PW, displayName: 'Alex Maker', locale: 'en-GB', ageConfirmed: true, ...over });
  const cookieOf = (res: request.Response, name: string) => ((res.headers['set-cookie'] as unknown as string[]) || []).find((c) => c.startsWith(`${name}=`)) ?? '';
  const valueOf = (cookie: string) => cookie.split(';')[0].split('=').slice(1).join('=');
  const linkIn = (to: string, kind: 'verify' | 'reset') => {
    const m = [...mail].reverse().find((x) => x.to === to && x.text.includes(`#${kind}=`));
    return m ? decodeURIComponent((m.text.match(new RegExp(`#${kind}=([^\\s]+)`)) || [])[1]) : '';
  };

  let A = { id: '', auth: '', refresh: '' }, B = { id: '', auth: '' };
  let aProject = '', aCollection = '', aRoster = '', clubProject = '';

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE ROLE "${ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD '${PASSWORD}'`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB}" OWNER "${ROLE}"`);
    const url = urlFor(DB, ROLE, PASSWORD);
    const m = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000 });
    if (m.status !== 0) throw new Error(`prisma migrate deploy failed: ${m.stderr}`);
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
      await tx.club.create({ data: { id: C1, name: 'Home FC', city: 'X' } });
      await tx.featureFlag.create({ data: { key: 'club_design_studio', name: 'Club Design Studio', defaultEnabled: false, enabledForPlans: [] } });
      await tx.organizationLimits.create({ data: { clubId: C1, featuresEnabled: ['club_design_studio'] } });
      for (const u of Object.values(USERS)) await tx.user.create({ data: { id: u.id, clubId: u.clubId, email: `${u.id}@test.invalid`, passwordHash: 'x', firstName: 'T', lastName: u.id, role: u.role } });
    });
    process.env.DATABASE_URL = url; process.env.DIRECT_URL = url; process.env.DB_RLS_CONTEXT = 'on';
    // This suite makes more than ten credential calls for one address on purpose; the per-account auth limit that would
    // stop the eleventh is the platform's own, unchanged, and tested where it is defined.
    process.env.RATE_ACCOUNT_CAPACITY = '200';
    /* eslint-disable @typescript-eslint/no-var-requires */
    signToken = require('../src/security/jwt-tokens').signToken;
    require('../src/platform/email/service').setEmailProvider({
      name: 'test', isConfigured: () => true, configurationProblem: () => null,
      send: async (msg: { to: { address: string }; text: string }) => { mail.push({ to: msg.to.address, text: msg.text }); return { ok: true, providerName: 'test', providerMessageId: 'm', failureClass: null, failureCode: null, latencyMs: 1 }; },
    });
    app = require('../src/app').createApp();
    /* eslint-enable @typescript-eslint/no-var-requires */
    clubProject = (await club().post(`${CLUB}/projects`, { document: C.createDocument(SHIRT, 'Club shirt'), origin: 'EDITOR' })).body.data.project.id;
    expect(clubProject).toBeTruthy();
  }, 240_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../src/platform/email/service').setEmailProvider(null);
    await db?.$disconnect();
    await require('../src/config/database').prisma.$disconnect().catch(() => undefined); // eslint-disable-line @typescript-eslint/no-var-requires
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin?.$disconnect();
  });

  it('every Design Studio and manufacturing table has exactly one owner and is isolated by either', async () => {
    const tables = ['DesignBrandKit', 'DesignBrandAsset', 'DesignRoster', 'DesignCollection', 'DesignCollectionItem', 'ManufacturingRequest',
      'ManufacturingRequestPerson', 'ManufacturingRequestEvent', 'ManufacturingQuote', 'DesignReviewComment', 'DesignApproval'];
    const checks = await sys(`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%\\_one\\_owner' ORDER BY 1`);
    expect(checks.map((c) => c.t.replace(/"/g, '')).sort()).toEqual([...tables].sort());
    const pol = await sys(`SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1::text[]) AND policyname LIKE '%\\_tenant\\_isolation' ORDER BY tablename`, [...tables, 'DesignProject']);
    // P4: what a live share adds beside the owner's isolation: reads, and a grantee's own review notes; nothing else.
    const shared = await sys(`SELECT tablename, policyname, cmd FROM pg_policies WHERE policyname LIKE '%\\_shared\\_%' OR tablename = 'DesignShare' ORDER BY tablename, policyname`);
    expect(shared.map((q) => [q.tablename, q.policyname, q.cmd])).toEqual([
      ['DesignApproval', 'DesignApproval_shared_read', 'SELECT'], ['DesignProject', 'DesignProject_shared_read', 'SELECT'],
      ['DesignReviewComment', 'DesignReviewComment_shared_read', 'SELECT'], ['DesignReviewComment', 'DesignReviewComment_shared_write', 'INSERT'],
      ['DesignRevision', 'DesignRevision_shared_read', 'SELECT'], ['DesignShare', 'DesignShare_grantee_read', 'SELECT'], ['DesignShare', 'DesignShare_tenant_isolation', 'ALL']]);
    expect(pol.map((p) => [p.tablename, p.policyname, p.qual, p.with_check])).toEqual([...tables, 'DesignProject'].sort()
      .map((t) => [t, `${t}_tenant_isolation`, 'familista_rls_owner_ok("clubId", "creatorId")', 'familista_rls_owner_ok("clubId", "creatorId")']));
    const fks = await sys(`SELECT conname FROM pg_constraint WHERE contype = 'f' AND conname LIKE '%\\_creatorId\\_fkey' AND conname NOT LIKE '%\\_creatorId\\_creatorId%' ORDER BY 1`);
    expect(fks.map((f) => f.conname)).toEqual(expect.arrayContaining([
      'DesignBrandAsset_kitId_creatorId_fkey', 'DesignCollectionItem_collectionId_creatorId_fkey', 'DesignCollectionItem_projectId_creatorId_fkey',
      'ManufacturingQuote_requestId_creatorId_fkey', 'ManufacturingRequestEvent_requestId_creatorId_fkey', 'ManufacturingRequestPerson_requestId_creatorId_fkey',
      'DesignReviewComment_projectId_creatorId_fkey', 'DesignApproval_projectId_creatorId_fkey', 'DesignProject_creatorId_fkey']));
  });

  it('opens an account only with the Owner’s invitation; keeps only hashes; confirms the age; refuses a weak password', async () => {
    expect((await request(app).get(`${CR}/auth/terms`)).body.data).toEqual({ signup: 'invitation', minimumAge: 18, email: true });
    expect((await signUp('FAM-NONE-NONE-NONE-NONE', 'a@example.com')).body).toMatchObject({ code: 'CREATOR_INVITE_REFUSED', reason: 'invalid' });
    const bound = await invite({ email: 'Alex@Example.com', note: 'first creator' });
    expect(bound.code).toMatch(/^FAM-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const [stored] = await sys(`SELECT "codeHash", "email" FROM "CreatorInvite" WHERE "id" = $1`, bound.invite.id);
    expect([stored.codeHash.length, stored.codeHash.includes(bound.code), stored.email]).toEqual([64, false, 'alex@example.com']);
    // bound to one address; the age must be confirmed; a short password or the address as password is refused
    expect((await signUp(bound.code, 'someone@example.com')).body).toMatchObject({ code: 'CREATOR_INVITE_REFUSED', reason: 'invalid' });
    expect((await signUp(bound.code, 'alex@example.com', { ageConfirmed: false })).body).toMatchObject({ code: 'CREATOR_INVALID', reason: 'age-not-confirmed' });
    expect((await signUp(bound.code, 'alex@example.com', { password: 'short' })).body).toMatchObject({ code: 'CREATOR_INVALID', reason: 'password-short' });
    expect((await signUp(bound.code, 'alex@example.com', { password: 'alex@example.com' })).body).toMatchObject({ reason: 'password-is-email' });
    expect(await sys(`SELECT count(*)::int AS n FROM "CreatorAccount"`)).toEqual([{ n: 0 }]);

    const ok = await signUp(` ${bound.code.toLowerCase()} `, 'ALEX@example.com');
    expect(ok.status).toBe(201);
    expect([ok.body.data.creator.email, ok.body.data.creator.emailVerified, ok.body.data.verification]).toEqual(['alex@example.com', false, { sent: true, configured: true, failure: null }]);
    const access = cookieOf(ok, 'creator_access'), refresh = cookieOf(ok, 'creator_refresh');
    expect(access).toMatch(/HttpOnly/); expect(access).toMatch(/Path=\/api\/v1\/creator(;|$)/);
    expect(refresh).toMatch(/HttpOnly/); expect(refresh).toMatch(/Path=\/api\/v1\/creator\/auth/);
    A = { id: ok.body.data.creator.id, auth: `Bearer ${ok.body.data.accessToken}`, refresh: valueOf(refresh) };
    const [acc] = await sys(`SELECT "passwordHash", "ageConfirmedMinimum", "inviteId" FROM "CreatorAccount" WHERE "id" = $1`, A.id);
    expect([acc.passwordHash.startsWith('$2'), acc.ageConfirmedMinimum, acc.inviteId]).toEqual([true, 18, bound.invite.id]);
    const [sess] = await sys(`SELECT "tokenHash" FROM "CreatorSession" WHERE "creatorId" = $1`, A.id);
    expect([sess.tokenHash.length, sess.tokenHash === A.refresh]).toEqual([64, false]);
    // single use: the same code again is refused, and so is the address
    expect((await signUp(bound.code, 'alex@example.com')).body.code).toBe('CREATOR_INVITE_REFUSED');
    // no code, password or token in the audit
    const audit = await sys(`SELECT "action", "creatorId", "userId", "clubId", "metadata"::text AS m FROM "PlatformAuditLog" WHERE "action" LIKE 'creator.%' ORDER BY "createdAt"`);
    expect(audit.map((a) => a.action)).toEqual(['creator.invite.created', 'creator.account.created']);
    expect(audit[1]).toMatchObject({ creatorId: A.id, userId: null, clubId: null });
    for (const a of audit) for (const secret of [bound.code, PW, A.refresh]) expect(a.m.includes(secret)).toBe(false);
  });

  it('a single-use invitation opens one account however many race for it; an expired one is refused', async () => {
    const one = await invite({});
    const results = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((n) => signUp(one.code, `${n}@example.com`)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
    B = { id: results.find((r) => r.status === 201)!.body.data.creator.id, auth: `Bearer ${results.find((r) => r.status === 201)!.body.data.accessToken}` };
    const late = await invite({});
    await sysExec(`UPDATE "CreatorInvite" SET "expiresAt" = now() - interval '1 minute' WHERE "id" = $1`, late.invite.id);
    expect((await signUp(late.code, 'late@example.com')).body).toMatchObject({ code: 'CREATOR_INVITE_REFUSED', reason: 'expired' });
  });

  it('a creator session is never a club session, nor a club session a creator one', async () => {
    expect((await bearer(A.auth).get(`${CR}/me`)).body.data.creator.id).toBe(A.id);
    expect((await bearer(A.auth).get(`${CLUB}/projects`)).status).toBe(401);
    expect((await club().get(`${CR}/me`)).status).toBe(401);
    expect((await owner().get(`${CR}/projects`)).status).toBe(401);
    expect((await request(app).get(`${CR}/me`)).status).toBe(401);
    // a forged creator token for an account that does not exist, or with an old version
    expect((await bearer(`Bearer ${signToken('creator', { sub: 'nobody', tv: 0 }, { expiresIn: 60 })}`).get(`${CR}/me`)).status).toBe(401);
    expect((await bearer(`Bearer ${signToken('creator', { sub: A.id, tv: 7 }, { expiresIn: 60 })}`).get(`${CR}/me`)).status).toBe(401);
  });

  it('signs in with the right password only; rotates the refresh token, and ends the family when a replaced one comes back', async () => {
    expect((await request(app).post(`${CR}/auth/login`).send({ email: 'alex@example.com', password: 'wrong password!' })).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/login`).send({ email: 'nobody@example.com', password: PW })).status).toBe(401);
    const ok = await request(app).post(`${CR}/auth/login`).send({ email: 'Alex@example.com', password: PW });
    expect(ok.status).toBe(200);
    const first = valueOf(cookieOf(ok, 'creator_refresh'));
    const r1 = await request(app).post(`${CR}/auth/refresh`).set('Cookie', `creator_refresh=${first}`);
    expect(r1.status).toBe(200);
    const second = valueOf(cookieOf(r1, 'creator_refresh'));
    expect(second).not.toBe(first);
    // the replaced token comes back after the grace window: only a copy could present it, so the family ends
    await sysExec(`UPDATE "CreatorSession" SET "revokedAt" = now() - interval '1 minute' WHERE "revokedAt" IS NOT NULL AND "creatorId" = $1`, A.id);
    expect((await request(app).post(`${CR}/auth/refresh`).set('Cookie', `creator_refresh=${first}`)).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/refresh`).set('Cookie', `creator_refresh=${second}`)).status).toBe(401);
    // the first session, opened at sign-up, is its own family and still works
    const own = await request(app).post(`${CR}/auth/refresh`).set('Cookie', `creator_refresh=${A.refresh}`);
    expect(own.status).toBe(200);
    A.refresh = valueOf(cookieOf(own, 'creator_refresh'));
    A.auth = `Bearer ${own.body.data.accessToken}`;
  });

  it('one creator reaches none of another creator’s records, nor a club’s, nor a club any creator’s — by id and underneath', async () => {
    aProject = (await bearer(A.auth).post(`${CR}/projects`, { document: C.createDocument(SHIRT, 'Alex shirt'), origin: 'EDITOR' })).body.data.project.id;
    aRoster = (await bearer(A.auth).post(`${CR}/rosters`, { name: 'Sunday team', entries: [{ name: 'KID', number: 7, top: '140', shorts: null, socks: null, qty: 1 }] })).body.data.roster.id;
    aCollection = (await bearer(A.auth).post(`${CR}/collections`, { name: 'Sunday kit', season: null, rosterId: aRoster, items: [{ projectId: aProject, role: 'HOME' }] })).body.data.collection.id;
    expect((await bearer(A.auth).put(`${CR}/brand-kit/colours`, { colours: [{ label: 'Sky', srgb: '#3b82f6' }] })).status).toBe(200);
    expect([aProject, aRoster, aCollection].every(Boolean)).toBe(true);
    const [p] = await sys(`SELECT "ownerKind"::text AS k, "clubId", "creatorId" FROM "DesignProject" WHERE "id" = $1`, aProject);
    expect(p).toEqual({ k: 'PERSONAL', clubId: null, creatorId: A.id });

    // creator B: lists are empty, every id of A's is refused before its handler
    for (const url of ['/projects', '/rosters', '/collections', '/requests']) {
      const r = await bearer(B.auth).get(`${CR}${url}`);
      expect([url, r.status, (Object.values(r.body.data)[0] as unknown[]).length]).toEqual([url, 200, 0]);
    }
    expect((await bearer(B.auth).get(`${CR}/brand-kit`)).body.data.colours).toEqual([]);
    // With row-level security on, another tenant's row is invisible even to the route's guard: the answer is 'not found',
    // which reveals nothing (without the database's line, the guard alone answers 403).
    for (const url of [`/projects/${aProject}`, `/projects/${aProject}/revisions`, `/rosters/${aRoster}`, `/collections/${aCollection}`, `/collections/${aCollection}/order-sheet`]) {
      expect([url, (await bearer(B.auth).get(`${CR}${url}`)).status]).toEqual([url, 404]);
    }
    expect((await bearer(B.auth).post(`${CR}/projects/${aProject}/revisions`, { baseRevision: 1, document: C.createDocument(SHIRT, 'Taken') })).status).toBe(404);
    // B cannot put A's design in B's own collection: the service does not find it (and the database would refuse it)
    expect((await bearer(B.auth).post(`${CR}/collections`, { name: 'Stolen', season: null, rosterId: null, items: [{ projectId: aProject, role: 'HOME' }] })).status).toBeGreaterThanOrEqual(400);
    // nor a club's design
    expect((await bearer(A.auth).get(`${CR}/projects/${clubProject}`)).status).toBe(404);
    // a club reaches no creator's design
    expect((await club().get(`${CLUB}/projects/${aProject}`)).status).toBe(404);
    expect((await club().get(`${CLUB}/projects`)).body.data.projects.map((x: Row) => x.id)).toEqual([clubProject]);
    // the Owner's platform room is the platform's own designs: not a creator's either
    expect((await owner().get(`${OWNER}/projects/${aProject}`)).status).toBe(404);

    // underneath: the database answers each session with its own rows only
    const q = 'SELECT "id" FROM "DesignProject" ORDER BY "id"';
    expect((await seenAs('creator', A.id, q)).map((r) => r.id)).toEqual([aProject]);
    expect(await seenAs('creator', B.id, q)).toEqual([]);
    expect((await seenAs('club', C1, q)).map((r) => r.id)).toEqual([clubProject]);
    expect(await seenAs('creator', B.id, 'SELECT "id" FROM "DesignRevision"')).toEqual([]);
    expect((await seenAs('creator', A.id, 'SELECT count(*)::int AS n FROM "DesignRevision"'))[0].n).toBe(1);
    // a creator session reaches no club-only table at all
    expect(await seenAs('creator', A.id, 'SELECT "id" FROM "Player"')).toEqual([]);
    // and writes only its own rows: a creator session cannot write a row for another owner
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'creator', true), set_config('familista.creator_id', ${B.id}, true)`;
      await tx.$executeRawUnsafe(`UPDATE "DesignRoster" SET "name" = 'Taken' WHERE "id" = $1`, aRoster).then((n) => { if (n === 0) throw new Error('row-level security: 0 rows'); });
    })).rejects.toThrow(/0 rows/);
  });

  it('the database itself holds every row to one owner and every child to its parent’s', async () => {
    const [{ kit }] = await sys(`SELECT "id" AS kit FROM "DesignBrandKit" WHERE "creatorId" = $1`, A.id);
    // neither owner, or both
    await expect(sysExec(`INSERT INTO "DesignRoster" ("id","name","entries","entryCount","createdById","updatedById") VALUES ('r-none','X','[]'::jsonb,0,'x','x')`)).rejects.toThrow(/DesignRoster_one_owner/);
    await expect(sysExec(`INSERT INTO "DesignRoster" ("id","clubId","creatorId","name","entries","entryCount","createdById","updatedById") VALUES ('r-both',$1,$2,'X','[]'::jsonb,0,'x','x')`, C1, A.id)).rejects.toThrow(/DesignRoster_one_owner/);
    // B's item in A's collection, a creator's item of a club's design, a club's asset in a creator's kit
    const bProject = (await bearer(B.auth).post(`${CR}/projects`, { document: C.createDocument(SHIRT, 'B shirt'), origin: 'EDITOR' })).body.data.project.id;
    await expect(sysExec(`INSERT INTO "DesignCollectionItem" ("id","creatorId","collectionId","projectId","role","position") VALUES ('i1',$1,$2,$3,'HOME',5)`, B.id, aCollection, bProject)).rejects.toThrow(/foreign key/);
    await expect(sysExec(`INSERT INTO "DesignCollectionItem" ("id","creatorId","collectionId","projectId","role","position") VALUES ('i2',$1,$2,$3,'AWAY',6)`, A.id, aCollection, clubProject)).rejects.toThrow(/foreign key/);
    await expect(sysExec(`INSERT INTO "DesignBrandAsset" ("id","clubId","kitId","kind","name","png","width","height","bytes","sha256","createdById") VALUES ('a1',$1,$2,'CREST','X','\\x89504e470d0a1a0a'::bytea,1,1,8,$3,'x')`, C1, kit, 'a'.repeat(64))).rejects.toThrow(/foreign key/);
    // a collection names a roster of its own owner only
    await sysExec(`INSERT INTO "DesignRoster" ("id","clubId","name","entries","entryCount","createdById","updatedById") VALUES ('r-club',$1,'Club roster','[]'::jsonb,0,'x','x')`, C1);
    await expect(sysExec(`UPDATE "DesignCollection" SET "rosterId" = 'r-club' WHERE "id" = $1`, aCollection)).rejects.toThrow(/DesignCollection_roster_club/);
    expect(await sys(`SELECT "rosterId" FROM "DesignCollection" WHERE "id" = $1`, aCollection)).toEqual([{ rosterId: aRoster }]);
  });

  it('P4: a design shared to see is seen and not written; to comment, a note is written as the collaborator; a revocation ends it — and the database holds each line', async () => {
    const [bAcc] = await sys(`SELECT "email" FROM "CreatorAccount" WHERE "id" = $1`, B.id);
    expect((await bearer(B.auth).patch(`${CR}/me`, { displayName: 'Bea Collaborator' })).body.data.creator.displayName).toBe('Bea Collaborator');
    const third = await invite({});
    const c = await signUp(third.code, 'outsider@example.com', { displayName: 'Outsider' });
    const C = { id: c.body.data.creator.id, auth: `Bearer ${c.body.data.accessToken}` };
    const S = `${CR}/projects/${aProject}/shares`;
    // refusals first: no such creator, oneself, a bad role
    expect([(await bearer(A.auth).post(S, { email: 'nobody@example.com', role: 'VIEW' })).body.reason, (await bearer(A.auth).post(S, { email: 'alex@example.com', role: 'VIEW' })).body.reason,
      (await bearer(A.auth).post(S, { email: bAcc.email, role: 'EDIT' })).status]).toEqual(['no-creator', 'self', 400]);
    const view = await bearer(A.auth).post(S, { email: bAcc.email, role: 'VIEW' });
    expect([view.status, view.body.data.share.role, view.body.data.share.grantee.id]).toEqual([201, 'VIEW', B.id]);
    expect((await bearer(A.auth).post(S, { email: bAcc.email, role: 'COMMENT' })).body.reason).toBe('exists');
    expect((await bearer(A.auth).get(S)).body.data.shares.map((x: Row) => [x.grantee.id, x.role])).toEqual([[B.id, 'VIEW']]);
    // only the owner manages shares
    expect((await bearer(B.auth).get(S)).status).toBe(403);
    expect((await bearer(C.auth).post(S, { email: 'outsider@example.com', role: 'VIEW' })).status).toBe(404);

    // the collaborator sees it, read only
    const mine = (await bearer(B.auth).get(`${CR}/shared`)).body.data.designs;
    expect(mine.map((x: Row) => [x.id, x.role, x.owner.displayName])).toEqual([[aProject, 'VIEW', 'Alex Maker']]);
    const opened = (await bearer(B.auth).get(`${CR}/shared/${aProject}`)).body.data.design;
    expect([opened.name, opened.role, opened.revision.document.name]).toEqual(['Alex shirt', 'VIEW', 'Alex shirt']);
    expect((await bearer(B.auth).get(`${CR}/shared/${aProject}/review`)).body.data.role).toBe('VIEW');
    const note = { revision: 1, surface: null, body: 'The collar could be thinner' };
    expect((await bearer(B.auth).post(`${CR}/shared/${aProject}/comments`, note)).body.code).toBe('SHARE_VIEW_ONLY');
    // and writes nothing of the owner's: not a version, not an approval, not the project's routes at all
    expect((await bearer(B.auth).post(`${CR}/projects/${aProject}/revisions`, { baseRevision: 1, document: C_doc() })).status).toBe(403);
    expect((await bearer(B.auth).post(`${CR}/projects/${aProject}/decisions`, { revision: 1, decision: 'APPROVED', note: null })).status).toBe(403);
    // a third creator and a club see nothing of it
    expect((await bearer(C.auth).get(`${CR}/shared/${aProject}`)).status).toBe(404);
    expect((await bearer(C.auth).get(`${CR}/shared`)).body.data.designs).toEqual([]);
    expect((await club().get(`${CLUB}/projects/${aProject}`)).status).toBe(404);
    expect(await seenAs('creator', C.id, 'SELECT "id" FROM "DesignProject" UNION ALL SELECT "id" FROM "DesignShare"')).toEqual([]);

    // to comment: the VIEW share is revoked and a COMMENT share made; the note is the collaborator's, on the owner's design
    const shareId = view.body.data.share.id;
    expect((await bearer(A.auth).post(`${S}/${shareId}/revoke`)).body.data).toEqual({ revoked: true });
    expect((await bearer(A.auth).post(S, { email: bAcc.email, role: 'COMMENT' })).status).toBe(201);
    const wrote = await bearer(B.auth).post(`${CR}/shared/${aProject}/comments`, note);
    expect(wrote.status).toBe(201);
    const [row] = await sys(`SELECT "creatorId", "authorId" FROM "DesignReviewComment" WHERE "projectId" = $1`, aProject);
    expect(row).toEqual({ creatorId: A.id, authorId: B.id });
    const seen = (await bearer(A.auth).get(`${CR}/projects/${aProject}/review`)).body.data.review.comments;
    expect(seen.map((x: Row) => [x.body, x.by])).toEqual([['The collar could be thinner', 'Bea Collaborator']]);
    const [audit] = await sys(`SELECT "creatorId", "metadata"->>'actorCreatorId' AS by FROM "PlatformAuditLog" WHERE "action" = 'design.review.commented' AND "resourceId" = $1`, aProject);
    expect(audit).toEqual({ creatorId: A.id, by: B.id });

    // underneath: the collaborator cannot write as the owner, change the design, or share it on
    const asB = (sql: string, ...p: unknown[]) => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'creator', true), set_config('familista.creator_id', ${B.id}, true)`;
      return tx.$executeRawUnsafe(sql, ...p);
    });
    await expect(asB(`INSERT INTO "DesignReviewComment" ("id","creatorId","projectId","revision","body","authorId") VALUES ('forged',$1,$2,1,'x',$1)`, A.id, aProject)).rejects.toThrow(/row-level security/);
    expect(await asB(`UPDATE "DesignProject" SET "name" = 'Taken' WHERE "id" = $1`, aProject)).toBe(0);
    await expect(asB(`INSERT INTO "DesignShare" ("id","projectId","creatorId","granteeId","role") VALUES ('s2',$1,$2,$3,'VIEW')`, aProject, A.id, C.id)).rejects.toThrow(/row-level security/);
    // a share is only ever revoked, on every path
    await expect(sysExec(`UPDATE "DesignShare" SET "role" = 'COMMENT' WHERE "id" = $1`, shareId)).rejects.toThrow(/DesignShare_revoke_only/);

    // revoked: gone at once, through the routes and underneath
    const live = (await bearer(A.auth).get(S)).body.data.shares[0].id;
    await bearer(A.auth).post(`${S}/${live}/revoke`);
    expect((await bearer(B.auth).get(`${CR}/shared/${aProject}`)).status).toBe(404);
    expect((await bearer(B.auth).post(`${CR}/shared/${aProject}/comments`, note)).status).toBe(404);
    expect((await bearer(B.auth).get(`${CR}/shared`)).body.data.designs).toEqual([]);
    expect(await seenAs('creator', B.id, 'SELECT "id" FROM "DesignProject" WHERE "creatorId" IS DISTINCT FROM \'' + B.id + '\'')).toEqual([]);
    const acts = await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "action" LIKE 'design.share.%' AND "creatorId" = $1 ORDER BY "createdAt"`, A.id);
    expect(acts.map((a) => a.action)).toEqual(['design.share.created', 'design.share.revoked', 'design.share.created', 'design.share.revoked']);
  });

  it('a quotation request needs a confirmed address; the link confirms it once; the Owner sees the creator as the requester', async () => {
    const refused = await bearer(A.auth).post(`${CR}/collections/${aCollection}/requests`, { rosterId: aRoster, note: null, neededBy: null });
    expect([refused.status, refused.body.code]).toEqual([403, 'CREATOR_EMAIL_UNVERIFIED']);
    const link = linkIn('alex@example.com', 'verify');
    expect(link.length).toBeGreaterThan(20);
    expect((await request(app).post(`${CR}/auth/verify-email`).send({ token: link })).body.data).toEqual({ verified: true });
    expect((await request(app).post(`${CR}/auth/verify-email`).send({ token: link })).body.code).toBe('CREATOR_LINK_REFUSED');
    const [t] = await sys(`SELECT "tokenHash" FROM "CreatorEmailToken" WHERE "creatorId" = $1`, A.id);
    expect(t.tokenHash).toBe(createHash('sha256').update('familista:creator:verify:v1:').update(link).digest('hex'));

    // a minor's name (a youth size) is kept only with the creator's own attestation
    const sent = await bearer(A.auth).post(`${CR}/collections/${aCollection}/requests`, { rosterId: aRoster, note: 'Sunday league', neededBy: null, minorsConsent: true });
    expect(sent.status).toBe(201);
    expect(sent.body.data.request.people).toEqual({ kept: 1, withheld: 0, erased: 0, minors: true, minorsConsent: true });
    const id = sent.body.data.request.id;
    const [r] = await sys(`SELECT "clubId", "creatorId" FROM "ManufacturingRequest" WHERE "id" = $1`, id);
    expect(r).toEqual({ clubId: null, creatorId: A.id });
    expect((await sys(`SELECT "creatorId" FROM "ManufacturingRequestPerson" WHERE "requestId" = $1`, id))).toEqual([{ creatorId: A.id }]);
    expect((await bearer(B.auth).get(`${CR}/requests/${id}`)).status).toBe(404);
    expect((await club().get(`${CLUB}/requests/${id}`)).status).toBe(404);
    const seen = (await owner().get(`/api/v1/system/manufacturing/requests`)).body.data.requests.find((x: Row) => x.id === id);
    expect([seen.requester, seen.club]).toEqual([{ kind: 'creator', id: A.id, name: 'Alex Maker' }, null]);
    const audit = await sys(`SELECT "creatorId", "userId", "clubId" FROM "PlatformAuditLog" WHERE "action" = 'manufacturing.request.submitted' AND "resourceId" = $1`, id);
    expect(audit).toEqual([{ creatorId: A.id, userId: null, clubId: null }]);
  });

  it('a password reset answers the same for every address, works once, and ends every session', async () => {
    const before = mail.length;
    expect((await request(app).post(`${CR}/auth/forgot-password`).send({ email: 'nobody@example.com' })).status).toBe(202);
    expect(mail.length).toBe(before);
    expect((await request(app).post(`${CR}/auth/forgot-password`).send({ email: 'alex@example.com' })).status).toBe(202);
    const link = linkIn('alex@example.com', 'reset');
    expect((await request(app).post(`${CR}/auth/reset-password`).send({ token: link, password: 'short' })).body.reason).toBe('password-short');
    expect((await request(app).post(`${CR}/auth/reset-password`).send({ token: link, password: 'a brand new passphrase' })).body.data).toEqual({ reset: true });
    expect((await request(app).post(`${CR}/auth/reset-password`).send({ token: link, password: 'another new passphrase' })).body.code).toBe('CREATOR_LINK_REFUSED');
    expect((await bearer(A.auth).get(`${CR}/me`)).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/refresh`).set('Cookie', `creator_refresh=${A.refresh}`)).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/login`).send({ email: 'alex@example.com', password: PW })).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/login`).send({ email: 'alex@example.com', password: 'a brand new passphrase' })).status).toBe(200);
  });

  it('the Owner suspends and reinstates an account, and confirms an address by hand, each with a note in the audit', async () => {
    expect((await owner().post(`${OWNER}/creators/${B.id}/suspend`, { note: 'no' })).body.code).toBe('CREATOR_INVALID');
    expect((await owner().post(`${OWNER}/creators/${B.id}/suspend`, { note: 'abuse report checked' })).body.data).toEqual({ status: 'SUSPENDED' });
    expect((await bearer(B.auth).get(`${CR}/me`)).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/login`).send({ email: 'r1@example.com', password: PW })).status).toBeGreaterThanOrEqual(401);
    expect((await owner().post(`${OWNER}/creators/${B.id}/reinstate`, { note: 'report resolved' })).body.data).toEqual({ status: 'ACTIVE' });
    const [b] = await sys(`SELECT "email" FROM "CreatorAccount" WHERE "id" = $1`, B.id);
    const back = await request(app).post(`${CR}/auth/login`).send({ email: b.email, password: PW });
    expect(back.status).toBe(200);
    B.auth = `Bearer ${back.body.data.accessToken}`;
    expect(back.body.data.creator.emailVerified).toBe(false);
    expect((await owner().post(`${OWNER}/creators/${B.id}/verify-email`, { note: 'confirmed by phone call' })).body.data.creator.emailVerified).toBe(true);
    // a club user is not the Owner
    expect((await club().post(`${OWNER}/creators/${B.id}/suspend`, { note: 'not mine to do' })).status).toBe(403);
    const audit = await sys(`SELECT "action", "metadata"->>'note' AS note FROM "PlatformAuditLog" WHERE "creatorId" = $1 AND "action" LIKE 'creator.%' ORDER BY "createdAt"`, B.id);
    expect(audit.map((a) => [a.action, a.note])).toEqual(expect.arrayContaining([['creator.account.suspended', 'abuse report checked'], ['creator.account.reinstated', 'report resolved'], ['creator.email.verified-by-owner', 'confirmed by phone call']]));
  });

  it('a creator downloads a copy of all their data, and deletes the account: refused while an order is with its maker', async () => {
    const signedIn = await request(app).post(`${CR}/auth/login`).send({ email: 'alex@example.com', password: 'a brand new passphrase' });
    const auth = `Bearer ${signedIn.body.data.accessToken}`;
    const ex = await bearer(auth).get(`${CR}/me/export`);
    expect(ex.headers['content-disposition']).toMatch(/attachment; filename="familista-creator-export-/);
    const e = ex.body.data.export;
    expect([e.format, e.account.email, e.designs.map((d: Row) => d.id), e.rosters.map((r: Row) => r.id), e.collections.map((c: Row) => c.id)])
      .toEqual(['familista.creator-export', 'alex@example.com', [aProject], [aRoster], [aCollection]]);
    expect(e.designs[0].revision.document.name).toBe('Alex shirt');
    expect(e.requests).toHaveLength(1);
    expect(e.requests[0].names).toEqual([{ position: 0, name: 'KID', state: 'KEPT' }]);
    expect(e.brandKit.colours).toEqual([{ label: 'Sky', srgb: '#3b82f6' }]);
    // nothing of B's or the club's
    expect(JSON.stringify(e)).not.toContain(clubProject);
    const reqId = e.requests[0].id;
    // an order with its maker holds the account
    await sysExec(`UPDATE "ManufacturingRequest" SET "status" = 'ORDERED' WHERE "id" = $1`, reqId);
    const held = await bearer(auth).post(`${CR}/me/delete`, { password: 'a brand new passphrase' });
    expect([held.status, held.body.code, held.body.data]).toEqual([409, 'CREATOR_DELETION_REFUSED', { orders: 1 }]);
    await sysExec(`UPDATE "ManufacturingRequest" SET "status" = 'SUBMITTED' WHERE "id" = $1`, reqId);
    expect((await bearer(auth).post(`${CR}/me/delete`, { password: 'wrong password!!' })).status).toBe(401);
    const gone = await bearer(auth).post(`${CR}/me/delete`, { password: 'a brand new passphrase' });
    expect(gone.body.data).toEqual({ deleted: true, cancelled: 1, namesErased: 1, designs: 1 });
    const [acc] = await sys(`SELECT "status"::text AS s, "email", "passwordHash", "displayName", "deletedAt" IS NOT NULL AS d FROM "CreatorAccount" WHERE "id" = $1`, A.id);
    expect(acc).toEqual({ s: 'DELETED', email: `deleted+${A.id}@invalid`, passwordHash: null, displayName: null, d: true });
    for (const t of ['DesignProject', 'DesignRoster', 'DesignCollection', 'DesignBrandKit', 'CreatorSession', 'CreatorEmailToken']) {
      expect([t, (await sys(`SELECT count(*)::int AS n FROM "${t}" WHERE "creatorId" = $1`, A.id))[0].n]).toEqual([t, 0]);
    }
    // the request stays, cancelled and nameless, as the record of what was asked
    expect(await sys(`SELECT "status"::text AS s FROM "ManufacturingRequest" WHERE "id" = $1`, reqId)).toEqual([{ s: 'CANCELLED' }]);
    expect(await sys(`SELECT "name", "state"::text AS state FROM "ManufacturingRequestPerson" WHERE "requestId" = $1`, reqId)).toEqual([{ name: null, state: 'ERASED' }]);
    expect((await bearer(auth).get(`${CR}/me`)).status).toBe(401);
    expect((await request(app).post(`${CR}/auth/login`).send({ email: 'alex@example.com', password: 'a brand new passphrase' })).status).toBe(401);
    const seen = (await owner().get(`/api/v1/system/manufacturing/requests`)).body.data.requests.find((x: Row) => x.id === reqId);
    expect(seen.requester).toEqual({ kind: 'creator', id: A.id, name: null });
    const [audit] = await sys(`SELECT "metadata" FROM "PlatformAuditLog" WHERE "action" = 'creator.account.deleted' AND "creatorId" = $1`, A.id);
    expect(audit.metadata).toMatchObject({ designs: 1, cancelled: 1, namesErased: 1 });
    expect(JSON.stringify(audit.metadata)).not.toContain('alex@example.com');
  });
});
