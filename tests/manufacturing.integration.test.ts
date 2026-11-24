/**
 * Manufacturing, M4 (owner-brokered), on real PostgreSQL: the whole journey and every guard around it.
 *
 * A freshly migrated database owned by a role that is not a superuser; the application sends its request's database
 * context as production does (DB_RLS_CONTEXT=on). Pinned, each refusal beside the admission it mirrors:
 *   · access: the club's routes serve an entitled club's administrators and managers; the Owner's console serves the
 *     Platform Owner alone;
 *   · suppliers: recorded as prospects, verified only with a note of what was checked; only a verified supplier's
 *     quotation is recorded, published or accepted (the service, and a trigger on every path);
 *   · a request is submitted only when its collection, roster and sizes are complete, and keeps a frozen specification
 *     (each design at its revision and hash) the database never lets change;
 *   · quotations are recorded with the supplier's reference and how they were received; a club sees a published one,
 *     never a draft, the evidence or the supplier's contact; a published quotation is never edited;
 *   · the journey SUBMITTED → IN_REVIEW → QUOTED → ACCEPTED → ORDERED → IN_PRODUCTION → SHIPPED → DELIVERED, each step the
 *     workflow's, each with its immutable event and audit entry; of two racing steps one lands;
 *   · a club reaches no other club's request, by id or underneath (row-level security).
 * Runs when PRODUCT_DESIGN_DB_DATABASE_URL names a server it may create roles and databases on; CI requires it.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import request from 'supertest';
import type { Application } from 'express';
import { PrismaClient } from '@prisma/client';

const ADMIN_URL = process.env.PRODUCT_DESIGN_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.PRODUCT_DESIGN_DB_REQUIRED === '1') throw new Error('PRODUCT_DESIGN_DB_DATABASE_URL is required');
const suite = ADMIN_URL ? describe : describe.skip;

const tag = randomBytes(4).toString('hex');
const ROLE = `fam_mf_${tag}`, PASSWORD = `pw_${randomBytes(12).toString('hex')}`, DB = `fam_mf_${tag}`;
const ROOT = path.join(__dirname, '..');
const CLUB = '/api/v1/club-design', OWNER = '/api/v1/system/manufacturing';
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function urlFor(database: string, user?: string, password?: string): string {
  const u = new URL(ADMIN_URL || 'postgresql://placeholder@localhost:5432/postgres');
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
const tpl = (f: string) => C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates', f), 'utf8')));
const SHIRT = tpl('football-jersey.json'), SHORTS = tpl('shorts.json');

const C1 = `club-mf-${tag}`, C2 = `club-mf2-${tag}`;
const USERS = {
  owner: { id: `mf-owner-${tag}`, role: 'SUPER_ADMIN', clubId: C1 },
  admin: { id: `mf-admin-${tag}`, role: 'CLUB_ADMIN', clubId: C1 },
  manager: { id: `mf-manager-${tag}`, role: 'MANAGER', clubId: C1 },
  coach: { id: `mf-coach-${tag}`, role: 'COACH', clubId: C1 },
  other: { id: `mf-admin2-${tag}`, role: 'CLUB_ADMIN', clubId: C2 },
} as const;
type Who = keyof typeof USERS;
const E = (over: Row = {}) => ({ name: 'SMITH', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1, ...over });
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

suite('Manufacturing (owner-brokered), on real PostgreSQL', () => {
  let admin: PrismaClient, db: PrismaClient, app: Application;
  let signToken: (kind: 'access', claims: Row, opts: Row) => string;
  const sys = <T = Row[]>(sql: string, ...p: unknown[]): Promise<T> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    return tx.$queryRawUnsafe<T>(sql, ...p);
  });
  const sysExec = (sql: string, ...p: unknown[]): Promise<number> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    return tx.$executeRawUnsafe(sql, ...p);
  });
  const as = (who: Who | null) => {
    const u = who ? USERS[who] : null;
    const auth = u ? `Bearer ${signToken('access', { sub: u.id, role: u.role, tv: 0 }, { expiresIn: '10m' })}` : '';
    const w = (r: request.Test) => (auth ? r.set('Authorization', auth) : r);
    return {
      get: (url: string) => w(request(app).get(url)),
      post: (url: string, body: Row = {}) => w(request(app).post(url)).send(body),
      put: (url: string, body: Row = {}) => w(request(app).put(url)).send(body),
      del: (url: string) => w(request(app).delete(url)),
    };
  };
  const rows = async () => Object.fromEntries(await Promise.all(['ManufacturingRequest', 'ManufacturingQuote', 'ManufacturingRequestEvent', 'ManufacturingSupplier']
    .map(async (t) => [t, Number((await sys(`SELECT count(*)::int AS n FROM "${t}"`))[0].n)])));

  let kit = '', roster = '', shirt = '', shorts = '', verified = '', prospect = '', req = '', draft = '', second = '';

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
      await tx.club.create({ data: { id: C2, name: 'Away FC', city: 'Y' } });
      await tx.featureFlag.create({ data: { key: 'club_design_studio', name: 'Club Design Studio', defaultEnabled: false, enabledForPlans: [] } });
      for (const c of [C1, C2]) await tx.organizationLimits.create({ data: { clubId: c, featuresEnabled: ['club_design_studio'] } });
      for (const u of Object.values(USERS)) await tx.user.create({ data: { id: u.id, clubId: u.clubId, email: `${u.id}@test.invalid`, passwordHash: 'x', firstName: 'T', lastName: u.id, role: u.role } });
    });
    process.env.DATABASE_URL = url; process.env.DIRECT_URL = url; process.env.DB_RLS_CONTEXT = 'on';
    /* eslint-disable @typescript-eslint/no-var-requires */
    signToken = require('../src/security/jwt-tokens').signToken;
    app = require('../src/app').createApp();
    /* eslint-enable @typescript-eslint/no-var-requires */
    // The club's kit: a shirt and shorts, a roster with every size, a collection for it.
    shirt = (await as('admin').post(`${CLUB}/projects`, { document: C.createDocument(SHIRT, 'Home shirt'), origin: 'EDITOR' })).body.data.project.id;
    shorts = (await as('admin').post(`${CLUB}/projects`, { document: C.createDocument(SHORTS, 'Home shorts'), origin: 'EDITOR' })).body.data.project.id;
    roster = (await as('admin').post(`${CLUB}/rosters`, { name: 'First team', entries: [E(), E({ name: 'JONES', number: 4, top: 'L', qty: 2 })] })).body.data.roster.id;
    kit = (await as('admin').post(`${CLUB}/collections`, { name: 'Home kit', season: '2026/27', rosterId: roster, items: [{ projectId: shirt, role: 'HOME' }, { projectId: shorts, role: 'HOME' }] })).body.data.collection.id;
    expect([shirt, shorts, roster, kit].every(Boolean)).toBe(true);
  }, 240_000);

  afterAll(async () => {
    await db?.$disconnect();
    await require('../src/config/database').prisma.$disconnect().catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin?.$disconnect();
  });

  it('the migration made the tables, their guards and their row-level security', async () => {
    const rls = await db.$queryRawUnsafe<Row[]>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname LIKE 'Manufacturing%' AND relkind = 'r' ORDER BY relname`);
    expect(rls).toEqual([
      { relname: 'ManufacturingQuote', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'ManufacturingRequest', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'ManufacturingRequestEvent', relrowsecurity: true, relforcerowsecurity: true },
      // platform data with no club: reached only on the Owner's routes
      { relname: 'ManufacturingSupplier', relrowsecurity: false, relforcerowsecurity: false },
    ]);
    const trig = await db.$queryRawUnsafe<Row[]>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE '"Manufacturing%' ORDER BY tgname`);
    expect(trig.map((t) => t.tgname)).toEqual(['ManufacturingQuote_guard', 'ManufacturingRequestEvent_immutable', 'ManufacturingRequestEvent_no_truncate', 'ManufacturingRequest_guard']);
  });

  it('access: the club’s routes for an entitled club’s administrators and managers; the console for the Platform Owner alone', async () => {
    const before = await rows();
    expect((await as(null).get(`${CLUB}/requests`)).status).toBe(401);
    expect((await as('coach').get(`${CLUB}/requests`)).status).toBe(403);
    expect((await as('manager').get(`${CLUB}/requests`)).status).toBe(200);
    for (const who of ['admin', 'manager', 'coach', 'other'] as Who[]) {
      expect([who, (await as(who).get(`${OWNER}/requests`)).status]).toEqual([who, 403]);
      expect([who, (await as(who).post(`${OWNER}/suppliers`, { name: 'X', country: 'DE' })).status]).toEqual([who, 403]);
    }
    expect((await as(null).get(`${OWNER}/suppliers`)).status).toBe(401);
    expect((await as('owner').get(`${OWNER}/suppliers`)).body.data.suppliers).toEqual([]); // none is seeded
    expect(await rows()).toEqual(before);
  });

  it('suppliers: recorded as prospects, verified only with a note of what was checked; malformed ones refused', async () => {
    const before = await rows();
    for (const [body, reason] of [
      [{ name: 'X', country: 'de' }, 'bad-country'], [{ name: '', country: 'DE' }, 'required'],
      [{ name: 'X', country: 'DE', website: 'http://plain.example' }, 'bad-website'], [{ name: 'X', country: 'DE', contactEmail: 'nope' }, 'bad-email'],
      [{ name: 'X', country: 'DE', methods: ['LASER'] }, 'bad-method'], [{ name: 'X', country: 'DE', forms: ['hat'] }, 'bad-form'],
    ] as Array<[Row, string]>) {
      const r = await as('owner').post(`${OWNER}/suppliers`, body);
      expect([r.status, r.body.code, r.body.reason]).toEqual([400, 'SUPPLIER_INVALID', reason]);
    }
    expect(await rows()).toEqual(before);
    const a = await as('owner').post(`${OWNER}/suppliers`, { name: 'Factory A (test record)', country: 'PT', forms: ['top', 'shorts'], methods: ['SUBLIMATION'], leadTimeDays: 30 });
    const b = await as('owner').post(`${OWNER}/suppliers`, { name: 'Factory B (test record)', country: 'TR', forms: ['top'], methods: ['SCREEN_PRINT'] });
    expect([a.status, a.body.data.supplier.status, b.body.data.supplier.status]).toEqual([201, 'PROSPECT', 'PROSPECT']);
    verified = a.body.data.supplier.id; prospect = b.body.data.supplier.id;
    expect((await as('owner').post(`${OWNER}/suppliers/${verified}/status`, { status: 'VERIFIED', note: 'short' })).body.reason).toBe('note-too-short');
    const v = await as('owner').post(`${OWNER}/suppliers/${verified}/status`, { status: 'VERIFIED', note: 'Business registration and sample garments checked' });
    expect([v.status, v.body.data.supplier.status]).toEqual([200, 'VERIFIED']);
    // and the database holds a verified supplier to its note, on the system path too
    await expect(sysExec(`UPDATE "ManufacturingSupplier" SET "status" = 'VERIFIED' WHERE "id" = $1`, prospect)).rejects.toThrow(/ManufacturingSupplier_shape/);
    const audit = (await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "resourceId" = $1 ORDER BY "createdAt"`, verified)).map((x) => x.action);
    expect(audit).toEqual(['manufacturing.supplier.created', 'manufacturing.supplier.verified']);
  });

  it('a request is submitted only when its collection, roster and sizes are complete, and freezes its specification', async () => {
    const noRoster = (await as('admin').post(`${CLUB}/collections`, { name: 'No roster', items: [{ projectId: shirt, role: 'AWAY' }] })).body.data.collection.id;
    const unsized = (await as('admin').post(`${CLUB}/rosters`, { name: 'Unsized', entries: [E({ shorts: null })] })).body.data.roster.id;
    const before = await rows();
    for (const [coll, body, reason] of [[noRoster, {}, 'no-roster'], [kit, { rosterId: unsized }, 'unsized']] as Array<[string, Row, string]>) {
      const r = await as('admin').post(`${CLUB}/collections/${coll}/requests`, body);
      expect([r.status, r.body.code, r.body.reason]).toEqual([409, 'REQUEST_INCOMPLETE', reason]);
    }
    expect(await rows()).toEqual(before);
    const r = await as('manager').post(`${CLUB}/collections/${kit}/requests`, { note: 'For the first home game', neededBy: inDays(60) });
    expect(r.status).toBe(201);
    req = r.body.data.request.id;
    const spec = r.body.data.request.spec;
    expect([r.body.data.request.status, r.body.data.request.sets, spec.garments.map((g: Row) => [g.form, g.revision, g.sha256.length])]).toEqual(['SUBMITTED', 3, [['top', 1, 64], ['shorts', 1, 64]]]);
    expect(spec.garments[0].sizes).toEqual([{ size: 'M', sets: 1 }, { size: 'L', sets: 2 }]);
    // the database never lets the specification change, on the system path either
    await expect(sysExec(`UPDATE "ManufacturingRequest" SET "spec" = '{}'::jsonb WHERE "id" = $1`, req)).rejects.toThrow(/ManufacturingRequest_frozen/);
    const [a] = await sys(`SELECT "metadata" FROM "PlatformAuditLog" WHERE "resourceId" = $1 AND "action" = 'manufacturing.request.submitted'`, req);
    expect(a.metadata).toMatchObject({ garments: 2, sets: 3, entries: 2 });
    expect(JSON.stringify(a)).not.toMatch(/SMITH|JONES/);
  });

  it('quotations: a verified supplier’s only, with its reference and evidence; the club sees a published one and nothing of the record', async () => {
    expect((await as('owner').post(`${OWNER}/requests/${req}/quotes`, {})).status).toBe(400);
    const base = { supplierId: verified, currency: 'EUR', totalMinor: 123450, lines: [], leadTimeDays: 28, validUntil: inDays(14), supplierReference: 'Q-2026-0042', evidence: 'Quotation PDF received by e-mail on 23 Nov 2026' };
    // recording needs the request in review
    expect((await as('owner').post(`${OWNER}/requests/${req}/quotes`, base)).body.reason).toBe('wrong-status');
    expect((await as('owner').post(`${OWNER}/requests/${req}/review`)).body.data.request.status).toBe('IN_REVIEW');
    const before = await rows();
    for (const [over, reason] of [
      [{ supplierId: prospect }, 'supplier-not-verified'], [{ currency: 'XYZ' }, 'bad-currency'], [{ totalMinor: 0 }, 'bad-amount'], [{ totalMinor: 12.5 }, undefined],
      [{ validUntil: inDays(-1) }, 'bad-valid-until'], [{ evidence: 'trust me' }, 'bad-evidence'], [{ supplierReference: '' }, 'bad-reference'],
      [{ lines: [{ projectId: '00000000-0000-4000-8000-000000000000', unitMinor: 100, sets: 1 }] }, 'unknown-design'],
    ] as Array<[Row, string | undefined]>) {
      const r = await as('owner').post(`${OWNER}/requests/${req}/quotes`, { ...base, ...over });
      expect([JSON.stringify(over), r.status, r.body.reason]).toEqual([JSON.stringify(over), 400, reason]);
    }
    expect(await rows()).toEqual(before);
    draft = (await as('owner').post(`${OWNER}/requests/${req}/quotes`, { ...base, lines: [{ projectId: shirt, unitMinor: 2900, sets: 3 }] })).body.data.request.quotes[0].id;
    second = (await as('owner').post(`${OWNER}/requests/${req}/quotes`, { ...base, totalMinor: 99900, supplierReference: 'Q-2026-0043' })).body.data.request.quotes[1].id;
    expect((await as('admin').get(`${CLUB}/requests/${req}`)).body.data.request.quotes).toEqual([]); // drafts are the Owner's
    const pub = await as('owner').post(`${OWNER}/requests/${req}/quotes/${draft}/publish`);
    expect([pub.status, pub.body.data.request.status]).toEqual([200, 'QUOTED']);
    await as('owner').post(`${OWNER}/requests/${req}/quotes/${second}/publish`);
    const seen = (await as('admin').get(`${CLUB}/requests/${req}`)).body.data.request.quotes;
    expect(seen.map((q: Row) => [q.status, q.currency, q.totalMinor, q.supplier])).toEqual([
      ['PUBLISHED', 'EUR', 123450, { name: 'Factory A (test record)', country: 'PT' }], ['PUBLISHED', 'EUR', 99900, { name: 'Factory A (test record)', country: 'PT' }]]);
    expect(JSON.stringify(seen)).not.toMatch(/evidence|supplierReference|Q-2026|contact|e-mail/);
    // a published quotation is never edited, and a prospect's is never published, on the system path either
    await expect(sysExec(`UPDATE "ManufacturingQuote" SET "totalMinor" = 1 WHERE "id" = $1`, draft)).rejects.toThrow(/ManufacturingQuote_frozen/);
    await expect(sysExec(`UPDATE "ManufacturingQuote" SET "supplierId" = $2, "status" = 'DRAFT' WHERE "id" = $1`, second, prospect)).rejects.toThrow(/ManufacturingQuote_frozen/);
    await expect(sysExec(`INSERT INTO "ManufacturingQuote" ("id","clubId","requestId","supplierId","status","currency","totalMinor","leadTimeDays","validUntil","supplierReference","evidence","recordedById","publishedAt","updatedAt")
      VALUES ($1,$2,$3,$4,'PUBLISHED','EUR',100,10,now()::date,'R','planted by hand','u',now(),now())`, '99999999-9999-4999-8999-999999999999', C1, req, prospect)).rejects.toThrow(/ManufacturingQuote_verified_supplier/);
  });

  it('the club steps it may take, and no other; another club reaches none of it', async () => {
    expect((await as('admin').post(`${CLUB}/requests/${req}/delivered`)).body).toMatchObject({ code: 'REQUEST_STEP_REFUSED', reason: 'wrong-status' });
    const before = await rows();
    for (const r of [await as('other').get(`${CLUB}/requests/${req}`), await as('other').post(`${CLUB}/requests/${req}/cancel`),
      await as('other').post(`${CLUB}/requests/${req}/quotes/${draft}/accept`)]) expect(r.status).toBe(404);
    expect((await as('other').get(`${CLUB}/requests`)).body.data.requests).toEqual([]);
    expect(await rows()).toEqual(before);
    // row-level security: in Away FC's context the database shows none of Home FC's requests, quotations or events
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'club', true), set_config('familista.club_id', ${C2}, true)`;
      return [await tx.manufacturingRequest.count(), await tx.manufacturingQuote.count(), await tx.manufacturingRequestEvent.count()];
    });
    expect(seen).toEqual([0, 0, 0]);
  });

  it('of two racing acceptances one lands; the other quotation is superseded; nothing is charged', async () => {
    const race = await Promise.all([as('admin').post(`${CLUB}/requests/${req}/quotes/${draft}/accept`), as('manager').post(`${CLUB}/requests/${req}/quotes/${second}/accept`)]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const won = race.find((r) => r.status === 200)!.body.data.request;
    expect(won.status).toBe('ACCEPTED');
    expect(won.quotes.map((q: Row) => q.status).sort()).toEqual(['ACCEPTED', 'SUPERSEDED']);
    expect(Number((await sys(`SELECT count(*)::int AS n FROM "OperationsPayment"`))[0].n)).toBe(0);
  });

  it('the Owner confirms the order (with a note), records production and shipping; the club confirms delivery; the history is whole and immutable', async () => {
    expect((await as('owner').post(`${OWNER}/requests/${req}/order`)).body).toMatchObject({ reason: 'note-required' });
    expect((await as('owner').post(`${OWNER}/requests/${req}/order`, { note: 'Confirmed with the supplier by e-mail; payment settled outside the platform' })).body.data.request.status).toBe('ORDERED');
    expect((await as('owner').post(`${OWNER}/requests/${req}/shipped`)).body.reason).toBe('wrong-status');
    expect((await as('owner').post(`${OWNER}/requests/${req}/production`)).body.data.request.status).toBe('IN_PRODUCTION');
    expect((await as('owner').post(`${OWNER}/requests/${req}/shipped`, { note: 'Carrier reference 0042' })).body.data.request.status).toBe('SHIPPED');
    expect((await as('manager').post(`${CLUB}/requests/${req}/delivered`, { note: 'Received in full' })).body.data.request.status).toBe('DELIVERED');
    expect((await as('admin').post(`${CLUB}/requests/${req}/cancel`)).body.reason).toBe('wrong-status');
    const events = (await as('admin').get(`${CLUB}/requests/${req}`)).body.data.request.events;
    expect(events.map((e: Row) => [e.action, e.toStatus, e.actorKind])).toEqual([
      ['submit', 'SUBMITTED', 'CLUB'], ['review', 'IN_REVIEW', 'OWNER'], ['quote', 'QUOTED', 'OWNER'], ['quote', 'QUOTED', 'OWNER'], ['accept', 'ACCEPTED', 'CLUB'],
      ['order', 'ORDERED', 'OWNER'], ['produce', 'IN_PRODUCTION', 'OWNER'], ['ship', 'SHIPPED', 'OWNER'], ['deliver', 'DELIVERED', 'CLUB']]);
    await expect(sysExec(`UPDATE "ManufacturingRequestEvent" SET "note" = 'rewritten' WHERE "requestId" = $1`, req)).rejects.toThrow(/ManufacturingRequestEvent_immutable/);
    await expect(sysExec(`DELETE FROM "ManufacturingRequestEvent" WHERE "requestId" = $1`, req)).rejects.toThrow(/ManufacturingRequestEvent_immutable/);
    const audit = (await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "resourceId" = $1 AND "action" LIKE 'manufacturing.request.%' ORDER BY "createdAt"`, req)).map((x) => x.action);
    expect(audit).toEqual(['manufacturing.request.submitted', 'manufacturing.request.review', 'manufacturing.request.order', 'manufacturing.request.produce', 'manufacturing.request.ship', 'manufacturing.request.deliver']);
  });

  it('the Owner reads a design exactly as the request froze it, and nothing else', async () => {
    const d = await as('owner').get(`${OWNER}/requests/${req}/designs/${shirt}`);
    expect([d.status, d.body.data.design.revision, d.body.data.design.document.name]).toEqual([200, 1, 'Home shirt']);
    expect((await as('owner').get(`${OWNER}/requests/${req}/designs/${roster}`)).status).toBe(404);
    expect((await as('admin').get(`${OWNER}/requests/${req}/designs/${shirt}`)).status).toBe(403);
  });

  it('refusal and cancellation; a suspended supplier’s quotation cannot be accepted; a withdrawn last quotation returns the request to review', async () => {
    const r2 = (await as('admin').post(`${CLUB}/collections/${kit}/requests`, {})).body.data.request.id;
    expect((await as('owner').post(`${OWNER}/requests/${r2}/refuse`)).body.reason).toBe('note-required');
    expect((await as('owner').post(`${OWNER}/requests/${r2}/refuse`, { note: 'No verified supplier makes socks yet' })).body.data.request.status).toBe('REFUSED');
    const r3 = (await as('admin').post(`${CLUB}/collections/${kit}/requests`, {})).body.data.request.id;
    await as('owner').post(`${OWNER}/requests/${r3}/review`);
    const q3 = (await as('owner').post(`${OWNER}/requests/${r3}/quotes`, { supplierId: verified, currency: 'GBP', totalMinor: 50000, lines: [], leadTimeDays: 20, validUntil: inDays(10), supplierReference: 'Q-3', evidence: 'Quotation PDF received by e-mail' })).body.data.request.quotes[0].id;
    await as('owner').post(`${OWNER}/requests/${r3}/quotes/${q3}/publish`);
    await as('owner').post(`${OWNER}/suppliers/${verified}/status`, { status: 'SUSPENDED', note: 'Quality issue under review' });
    expect((await as('admin').post(`${CLUB}/requests/${r3}/quotes/${q3}/accept`)).body).toMatchObject({ code: 'REQUEST_STEP_REFUSED', reason: 'supplier-not-verified' });
    const w = await as('owner').post(`${OWNER}/requests/${r3}/quotes/${q3}/withdraw`, { note: 'Supplier suspended' });
    expect(w.body.data.request.status).toBe('IN_REVIEW');
    expect((await as('admin').post(`${CLUB}/requests/${r3}/cancel`, { note: 'No longer needed' })).body.data.request.status).toBe('CANCELLED');
    const list = (await as('owner').get(`${OWNER}/requests`)).body.data.requests;
    expect(list.map((x: Row) => [x.club.name, x.status]).sort()).toEqual([['Home FC', 'CANCELLED'], ['Home FC', 'DELIVERED'], ['Home FC', 'REFUSED']]);
  });
});
