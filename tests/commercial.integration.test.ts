/**
 * Premium plans (P5) and the provider-independent billing foundation (P6), on real PostgreSQL with row-level security.
 *
 *   · the Owner configures plans; a plan's features and limits are enforced on the server, route by route;
 *   · a free plan is active at once; a paid one stays PENDING with an OPEN invoice, and checkout says no payment provider is
 *     configured (nothing is charged); only a recorded successful payment of the exact total settles an invoice — the
 *     database refuses a PAID status written any other way, and a payment event is recorded once and never changed;
 *   · the professional tools (tech pack JSON/CSV, print export) open with a plan that includes them, for creators and clubs;
 *   · one tenant reaches none of another's subscription or invoices, through the routes or underneath.
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
const ROLE = `fam_cm_${tag}`, PASSWORD = `pw_${randomBytes(12).toString('hex')}`, DB = `fam_cm_${tag}`;
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
const C1 = `club-cm-${tag}`;
const USERS = {
  owner: { id: `cm-owner-${tag}`, role: 'SUPER_ADMIN', clubId: C1 },
  admin: { id: `cm-admin-${tag}`, role: 'CLUB_ADMIN', clubId: C1 },
  manager: { id: `cm-manager-${tag}`, role: 'MANAGER', clubId: C1 },
} as const;
const PW = 'correct horse battery';

suite('Premium plans and billing (P5, P6), on real PostgreSQL', () => {
  let admin: PrismaClient, db: PrismaClient, app: Application;
  let signToken: (kind: string, claims: Row, opts: Row) => string;
  let applyPaymentEvent: (e: Row) => Promise<{ applied: boolean; invoice: string | null }>;
  const sys = <T = Row[]>(sql: string, ...p: unknown[]): Promise<T> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    return tx.$queryRawUnsafe<T>(sql, ...p);
  });
  const sysExec = (sql: string, ...p: unknown[]): Promise<number> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    return tx.$executeRawUnsafe(sql, ...p);
  });
  const seenAs = (mode: 'club' | 'creator', id: string, sql: string): Promise<Row[]> => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', ${mode}, true), set_config('familista.club_id', ${mode === 'club' ? id : ''}, true), set_config('familista.creator_id', ${mode === 'creator' ? id : ''}, true)`;
    return tx.$queryRawUnsafe<Row[]>(sql);
  });
  const as = (auth: string) => ({
    get: (url: string) => request(app).get(url).set('Authorization', auth),
    post: (url: string, body: Row = {}) => request(app).post(url).set('Authorization', auth).send(body),
    put: (url: string, body: Row = {}) => request(app).put(url).set('Authorization', auth).send(body),
  });
  const user = (who: keyof typeof USERS) => as(`Bearer ${signToken('access', { sub: USERS[who].id, role: USERS[who].role, tv: 0 }, { expiresIn: '10m' })}`);
  async function creator(email: string) {
    const inv = (await user('owner').post(`${OWNER}/creators/invites`, { email })).body.data;
    const r = await request(app).post(`${CR}/auth/register`).send({ inviteCode: inv.code, email, password: PW, displayName: email.split('@')[0], ageConfirmed: true });
    return { id: r.body.data.creator.id as string, api: as(`Bearer ${r.body.data.accessToken}`) };
  }
  let A: { id: string; api: ReturnType<typeof as> }, B: { id: string; api: ReturnType<typeof as> };
  let invoiceId = '', invoiceNumber = '', aProject = '';

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
    process.env.DATABASE_URL = url; process.env.DIRECT_URL = url; process.env.DB_RLS_CONTEXT = 'on'; process.env.RATE_ACCOUNT_CAPACITY = '200';
    delete process.env.PAYMENT_PROVIDER;
    /* eslint-disable @typescript-eslint/no-var-requires */
    signToken = require('../src/security/jwt-tokens').signToken;
    applyPaymentEvent = require('../src/platform/commercial/subscription.service').applyPaymentEvent;
    app = require('../src/app').createApp();
    /* eslint-enable @typescript-eslint/no-var-requires */
    A = await creator('ana@example.com');
    B = await creator('ben@example.com');
  }, 240_000);

  afterAll(async () => {
    await db?.$disconnect();
    await require('../src/config/database').prisma.$disconnect().catch(() => undefined); // eslint-disable-line @typescript-eslint/no-var-requires
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin?.$disconnect();
  });

  it('the tables hold one owner each, row-level security, and the money guards', async () => {
    const rls = await sys(`SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('CommercialSubscription', 'CommercialInvoice', 'PaymentEvent') ORDER BY relname`);
    expect(rls).toEqual([{ relname: 'CommercialInvoice', f: true }, { relname: 'CommercialSubscription', f: true }, { relname: 'PaymentEvent', f: true }]);
    const trig = await sys(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('"CommercialInvoice"', '"PaymentEvent"') ORDER BY tgname`);
    expect(trig.map((t) => t.tgname)).toEqual(['CommercialInvoice_guard', 'PaymentEvent_immutable', 'PaymentEvent_no_truncate']);
  });

  it('without any plan a creator has the built-in features; the Owner configures plans, checked as configured', async () => {
    expect((await A.api.get(`${CR}/plan`)).body.data.entitlements).toMatchObject({ source: 'built-in', plan: null, features: ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing'] });
    const bad = async (body: Row) => (await user('owner').post(`${OWNER}/plans`, body)).body.reason;
    expect(await bad({ key: 'X Y', audience: 'CREATOR', name: 'n', features: [] })).toBe('bad-key');
    expect(await bad({ key: 'club-x', audience: 'CLUB', name: 'n', features: ['collaboration'] })).toBe('bad-features');
    expect(await bad({ key: 'priced', audience: 'CREATOR', name: 'n', features: [], priceMinor: 900 })).toBe('bad-price');
    expect((await user('admin').post(`${OWNER}/plans`, { key: 'mine', audience: 'CREATOR', name: 'n', features: [] })).status).toBe(403);
    const free = await user('owner').post(`${OWNER}/plans`, { key: 'creator-free', audience: 'CREATOR', name: 'Free', features: ['team_kit', 'brand_studio'], maxProjects: 1, isDefault: true });
    const prem = await user('owner').post(`${OWNER}/plans`, { key: 'creator-premium', audience: 'CREATOR', name: 'Premium', features: ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing', 'pro_export', 'manufacturing_prep'], priceMinor: 900, currency: 'EUR', interval: 'MONTH', sortOrder: 1 });
    const club = await user('owner').post(`${OWNER}/plans`, { key: 'club-pro', audience: 'CLUB', name: 'Club Pro tools', features: ['pro_export', 'manufacturing_prep'], priceMinor: 4900, currency: 'EUR', interval: 'MONTH' });
    expect([free.status, prem.status, club.status]).toEqual([201, 201, 201]);
    const e = (await A.api.get(`${CR}/plan`)).body.data;
    expect([e.entitlements.source, e.entitlements.plan.key, e.entitlements.features, e.offered.map((p: Row) => p.key), e.payments]).toEqual(
      ['default-plan', 'creator-free', ['team_kit', 'brand_studio'], ['creator-free', 'creator-premium'], { configured: false }]);
    const audit = await sys(`SELECT "action" FROM "PlatformAuditLog" WHERE "action" = 'commercial.plan.created'`);
    expect(audit).toHaveLength(3);
  });

  it('the free plan’s features and limits are enforced on the server, route by route', async () => {
    aProject = (await A.api.post(`${CR}/projects`, { document: C.createDocument(SHIRT, 'Ana shirt'), origin: 'EDITOR' })).body.data.project.id;
    expect(aProject).toBeTruthy();
    const second = await A.api.post(`${CR}/projects`, { document: C.createDocument(SHIRT, 'Second'), origin: 'EDITOR' });
    expect([second.status, second.body.code, second.body.limit, second.body.max]).toEqual([403, 'PLAN_LIMIT_REACHED', 'projects', 1]);
    for (const [verb, url, feature] of [
      ['get', `/projects/${aProject}/review`, 'reviews'], ['get', `/projects/${aProject}/shares`, 'collaboration'], ['get', '/requests', 'manufacturing'],
      ['get', `/projects/${aProject}/tech-pack`, 'manufacturing_prep'], ['post', `/projects/${aProject}/exports`, 'pro_export'],
    ] as Array<[string, string, string]>) {
      const r = verb === 'get' ? await A.api.get(`${CR}${url}`) : await A.api.post(`${CR}${url}`);
      expect([url, r.status, r.body.code, r.body.feature]).toEqual([url, 403, 'PLAN_FEATURE_REQUIRED', feature]);
    }
    expect((await A.api.get(`${CR}/rosters`)).status).toBe(200);
    expect((await A.api.get(`${CR}/brand-kit`)).status).toBe(200);
  });

  it('a paid plan waits for its payment: PENDING, an OPEN invoice, and a checkout that says no provider is configured', async () => {
    const r = await A.api.post(`${CR}/plan/request`, { planKey: 'creator-premium' });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect([d.subscription.status, d.subscription.plan.key, d.entitlements.plan.key]).toEqual(['PENDING', 'creator-premium', 'creator-free']);
    expect(d.invoices).toHaveLength(1);
    const inv = d.invoices[0];
    invoiceId = inv.id; invoiceNumber = inv.number;
    expect([inv.status, inv.currency, inv.subtotalMinor, inv.taxMinor, inv.totalMinor]).toEqual(['OPEN', 'EUR', 900, null, 900]);
    expect(inv.number).toMatch(new RegExp(`^FAM-${new Date().getUTCFullYear()}-0{5}1$`));
    const pay = await A.api.post(`${CR}/billing/invoices/${invoiceId}/checkout`);
    expect([pay.status, pay.body.code]).toEqual([503, 'PAYMENTS_NOT_CONFIGURED']);
    expect((await A.api.post(`${CR}/plan/request`, { planKey: 'club-pro' })).body.reason).toBe('wrong-audience');
    expect((await A.api.post(`${CR}/plan/request`, { planKey: 'creator-premium' })).body.reason).toBe('already-on-plan');
  });

  it('the database settles an invoice only from a recorded successful payment of its exact total, recorded once, never changed', async () => {
    await expect(sysExec(`UPDATE "CommercialInvoice" SET "status" = 'PAID', "paidAt" = now() WHERE "id" = $1`, invoiceId)).rejects.toThrow(/CommercialInvoice_unpaid/);
    await expect(sysExec(`UPDATE "CommercialInvoice" SET "totalMinor" = 1, "subtotalMinor" = 1 WHERE "id" = $1`, invoiceId)).rejects.toThrow(/CommercialInvoice_frozen/);
    const at = new Date();
    // a short payment is recorded, and settles nothing
    expect(await applyPaymentEvent({ provider: 'test', providerEventId: 'evt-short', invoiceId, status: 'SUCCEEDED', amountMinor: 800, currency: 'EUR', occurredAt: at })).toEqual({ applied: false, invoice: invoiceNumber });
    expect((await A.api.get(`${CR}/plan`)).body.data.subscription.status).toBe('PENDING');
    // the exact payment settles it and activates the plan for the invoice's period
    expect(await applyPaymentEvent({ provider: 'test', providerEventId: 'evt-ok', invoiceId, status: 'SUCCEEDED', amountMinor: 900, currency: 'EUR', occurredAt: at })).toEqual({ applied: true, invoice: invoiceNumber });
    expect(await applyPaymentEvent({ provider: 'test', providerEventId: 'evt-ok', invoiceId, status: 'SUCCEEDED', amountMinor: 900, currency: 'EUR', occurredAt: at })).toEqual({ applied: false, invoice: invoiceNumber });
    const d = (await A.api.get(`${CR}/plan`)).body.data;
    expect([d.subscription.status, d.entitlements.source, d.entitlements.plan.key, d.invoices[0].status]).toEqual(['ACTIVE', 'subscription', 'creator-premium', 'PAID']);
    expect(await sys(`SELECT count(*)::int AS n FROM "PaymentEvent" WHERE "invoiceId" = $1`, invoiceId)).toEqual([{ n: 2 }]);
    await expect(sysExec(`UPDATE "PaymentEvent" SET "amountMinor" = 1 WHERE "providerEventId" = 'evt-short'`)).rejects.toThrow(/PaymentEvent_immutable/);
    await expect(sysExec(`UPDATE "CommercialInvoice" SET "status" = 'VOID', "voidedAt" = now(), "paidAt" = NULL WHERE "id" = $1`, invoiceId)).rejects.toThrow(/CommercialInvoice_final/);
    const audit = await sys(`SELECT "action", "creatorId" FROM "PlatformAuditLog" WHERE "action" LIKE 'commercial.%' AND "creatorId" = $1 ORDER BY "createdAt"`, A.id);
    expect(audit.map((a) => a.action)).toEqual(['commercial.subscription.requested', 'commercial.payment.recorded', 'commercial.invoice.paid']);
  });

  it('with Premium, the professional tools open: a tech pack in JSON and CSV, and a print export, each recorded', async () => {
    const tp = await A.api.get(`${CR}/projects/${aProject}/tech-pack`);
    expect(tp.status).toBe(200);
    const pack = tp.body.data.techPack;
    expect([pack.format, pack.design.name, pack.design.revision, pack.garment.form, pack.surfaces.map((s: Row) => s.id)]).toEqual(['familista.tech-pack', 'Ana shirt', 1, 'top', ['front', 'back', 'sleeve-right', 'sleeve-left']]);
    expect(pack.surfaces[0].widthMm).toBeGreaterThan(0);
    expect(pack.elements.length).toBeGreaterThan(0);
    for (const el of pack.elements) expect(el.hex === null || /^#[0-9a-f]{6}$/.test(el.hex)).toBe(true);
    const csv = await A.api.get(`${CR}/projects/${aProject}/tech-pack?format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('﻿surface,element,type,text,font,colour,hex,x_mm,y_mm,width_mm,height_mm,rotation_deg,printed');
    const ex = await A.api.post(`${CR}/projects/${aProject}/exports`);
    expect([ex.status, ex.body.data.export.revision, ex.body.data.export.document.name]).toEqual([201, 1, 'Ana shirt']);
    const audit = await sys(`SELECT "action", "metadata"->>'format' AS f FROM "PlatformAuditLog" WHERE "resourceId" = $1 AND "action" IN ('design.tech-pack.exported', 'design.export.created') ORDER BY "createdAt"`, aProject);
    expect(audit.map((a) => [a.action, a.f])).toEqual([['design.tech-pack.exported', 'json'], ['design.tech-pack.exported', 'csv'], ['design.export.created', null]]);
    // and the limits are Premium's (none): a second project is accepted now
    expect((await A.api.post(`${CR}/projects`, { document: C.createDocument(SHIRT, 'Second'), origin: 'EDITOR' })).status).toBe(201);
  });

  it('one tenant reaches none of another’s subscription or invoices, through the routes or underneath', async () => {
    const b = (await B.api.get(`${CR}/plan`)).body.data;
    expect([b.subscription, b.invoices]).toEqual([null, []]);
    expect((await B.api.post(`${CR}/billing/invoices/${invoiceId}/checkout`)).status).toBeGreaterThanOrEqual(403);
    expect((await user('admin').get(`${CLUB}/plan`)).body.data.invoices).toEqual([]);
    expect(await seenAs('creator', B.id, 'SELECT "id" FROM "CommercialInvoice" UNION ALL SELECT "id" FROM "CommercialSubscription" UNION ALL SELECT "id" FROM "PaymentEvent"')).toEqual([]);
    expect(await seenAs('club', C1, 'SELECT "id" FROM "CommercialInvoice" UNION ALL SELECT "id" FROM "CommercialSubscription"')).toEqual([]);
    expect((await seenAs('creator', A.id, 'SELECT "id" FROM "CommercialInvoice"')).map((r) => r.id)).toEqual([invoiceId]);
  });

  it('a club: the professional tools need a club plan; its administrator, not a manager, changes it; the Owner can grant one', async () => {
    const proj = (await user('admin').post(`${CLUB}/projects`, { document: C.createDocument(SHIRT, 'Club shirt'), origin: 'EDITOR' })).body.data.project.id;
    expect((await user('admin').get(`${CLUB}/projects/${proj}/tech-pack`)).body).toMatchObject({ code: 'PLAN_FEATURE_REQUIRED', feature: 'manufacturing_prep' });
    expect((await user('manager').post(`${CLUB}/plan/request`, { planKey: 'club-pro' })).status).toBe(403);
    const asked = await user('admin').post(`${CLUB}/plan/request`, { planKey: 'club-pro' });
    expect([asked.body.data.subscription.status, asked.body.data.invoices[0].totalMinor]).toEqual(['PENDING', 4900]);
    const g = await user('owner').post(`${OWNER}/billing/grant`, { tenantKind: 'club', tenantId: C1, planKey: 'club-pro', months: 3, note: 'pilot club, agreed by phone' });
    expect(g.status).toBe(201);
    const after = (await user('admin').get(`${CLUB}/plan`)).body.data;
    expect([after.subscription.status, after.subscription.source, after.entitlements.features, after.invoices[0].status]).toEqual(['ACTIVE', 'OWNER_GRANT', ['pro_export', 'manufacturing_prep'], 'VOID']);
    expect((await user('admin').get(`${CLUB}/projects/${proj}/tech-pack`)).status).toBe(200);
    expect((await user('admin').post(`${CLUB}/plan/cancel`)).body.reason).toBe('owner-grant');
    const ov = (await user('owner').get(`${OWNER}/billing`)).body.data;
    expect(ov.payments.configured).toBe(false);
    expect(ov.subscriptions.find((s: Row) => s.source === 'OWNER_GRANT').tenant).toEqual({ kind: 'club', id: C1, name: 'Home FC' });
    const end = ov.subscriptions.find((s: Row) => s.source === 'OWNER_GRANT').id;
    expect((await user('owner').post(`${OWNER}/billing/subscriptions/${end}/end`, { note: 'pilot over' })).body.data).toEqual({ ended: true });
    expect((await user('admin').get(`${CLUB}/projects/${proj}/tech-pack`)).status).toBe(403);
  });

  it('a paid plan cancelled ends with its period; the Owner voids an open invoice and marks lapsed subscriptions expired', async () => {
    const c = (await A.api.post(`${CR}/plan/cancel`)).body.data.subscription;
    expect([c.status, c.cancelAtPeriodEnd]).toEqual(['ACTIVE', true]);
    const bp = (await B.api.post(`${CR}/plan/request`, { planKey: 'creator-premium' })).body.data.invoices[0];
    expect((await user('owner').post(`${OWNER}/billing/invoices/${bp.id}/void`)).body.data).toEqual({ voided: true });
    expect((await B.api.get(`${CR}/plan`)).body.data.subscription.status).toBe('CANCELED');
    await sysExec(`UPDATE "CommercialSubscription" SET "currentPeriodEnd" = now() - interval '1 day', "currentPeriodStart" = now() - interval '31 days' WHERE "creatorId" = $1 AND "status" = 'ACTIVE'`, A.id);
    expect((await A.api.get(`${CR}/plan`)).body.data.entitlements.plan.key).toBe('creator-free');
    expect((await user('owner').post(`${OWNER}/billing/expire`, { dryRun: true })).body.data).toEqual({ dryRun: true, due: 1 });
    expect((await user('owner').post(`${OWNER}/billing/expire`, { dryRun: false })).body.data).toEqual({ dryRun: false, due: 1 });
    expect((await A.api.get(`${CR}/plan`)).body.data.subscription.status).toBe('EXPIRED');
  });

  it('P8: the sign-in page shows anyone the creator plans on offer and which services are configured, and nothing about anyone', async () => {
    const t = await request(app).get(`${CR}/auth/terms`);
    expect(t.status).toBe(200);
    const offer = t.body.data.offer;
    expect([offer.plans.map((p: Row) => p.key), offer.services]).toEqual([['creator-free', 'creator-premium'], { email: false, payments: false, quotations: false }]);
    expect(offer.plans[1]).toMatchObject({ name: 'Premium', priceMinor: 900, currency: 'EUR', interval: 'MONTH', limits: { projects: null, collections: null, shares: null } });
    expect(JSON.stringify(t.body)).not.toMatch(/example\.com|club-cm|Home FC|createdById|"id"/);
  });

  it('P8: a workspace’s first steps come from its own records only; the Owner’s readiness view is the Owner’s alone', async () => {
    const a = (await A.api.get(`${CR}/getting-started`)).body.data;
    expect([a.steps, a.counts.designs]).toEqual([{ address: false, design: true, brand: false, roster: false, collection: false, request: false }, 2]);
    const b = (await B.api.get(`${CR}/getting-started`)).body.data;
    expect([b.steps.design, b.counts]).toEqual([false, { designs: 0, colours: 0, rosters: 0, collections: 0, requests: 0 }]);
    const c = (await user('manager').get(`${CLUB}/getting-started`)).body.data;
    expect([c.steps.address, c.steps.design, c.counts.designs]).toEqual([null, true, 1]);
    expect((await user('admin').get(`${OWNER}/readiness`)).status).toBe(403);
    const r = (await user('owner').get(`${OWNER}/readiness`)).body.data;
    expect([r.email.configured, r.payments.configured, r.suppliers, r.plans, r.creators, r.clubsReleased]).toEqual([
      false, false, { verified: 0, prospects: 0, suspended: 0 }, { creator: 2, club: 1, paid: 2, creatorDefault: true, clubDefault: false }, { active: 2, suspended: 0 }, 1]);
  });
});
