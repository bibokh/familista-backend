/**
 * Familista commercial plans (P5) — the plans the Platform Owner configures, and what a tenant is entitled to.
 *
 * A tenant's entitlements come, in order, from: its live subscription's plan (ACTIVE, and within its period); else the
 * active default plan of its audience; else the built-in set (features.ts). Nothing is ever entitled by the browser:
 * every feature route asks entitlementsFor() on the server. A plan's price is configuration shown to a customer; it is
 * never charged here (P6 bills it, and only a payment provider can settle it).
 */
import { CommercialSubscriptionStatus as SS, PlanAudience, PlanInterval, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { ownerAudit } from '../manufacturing/supplier.service';
import type { DesignActor } from '../product-design/service';
import { tenantWhere, type Tenant } from '../tenancy/tenant';
import { BUILT_IN_CLUB, BUILT_IN_CREATOR, CLUB_PLAN_FEATURES, FEATURES, isFeature, type Feature } from './features';

export class PlanInvalidError extends Error {
  readonly code = 'PLAN_INVALID';
  constructor(readonly reason: string, readonly path: string) { super(`${reason} at ${path}`); this.name = 'PlanInvalidError'; }
}
export class PlanFeatureRequiredError extends Error {
  readonly code = 'PLAN_FEATURE_REQUIRED';
  constructor(readonly feature: Feature) { super('This is not included in your plan'); this.name = 'PlanFeatureRequiredError'; }
}
export class PlanLimitReachedError extends Error {
  readonly code = 'PLAN_LIMIT_REACHED';
  constructor(readonly limit: 'projects' | 'collections' | 'shares', readonly max: number) { super('Your plan’s limit is reached'); this.name = 'PlanLimitReachedError'; }
}

const PLAN_SELECT = { id: true, key: true, audience: true, name: true, description: true, features: true, maxProjects: true, maxCollections: true, maxShares: true,
  priceMinor: true, currency: true, interval: true, isDefault: true, active: true, sortOrder: true, updatedAt: true } as const;
export type PlanView = Prisma.CommercialPlanGetPayload<{ select: typeof PLAN_SELECT }>;

export interface Entitlements {
  source: 'subscription' | 'default-plan' | 'built-in';
  plan: PlanView | null;
  features: Feature[];
  limits: { projects: number | null; collections: number | null; shares: number | null };
}
const audienceOf = (t: Tenant): PlanAudience => (t.kind === 'club' ? PlanAudience.CLUB : PlanAudience.CREATOR);
const known = (list: string[], allowed: readonly Feature[]) => list.filter((f): f is Feature => isFeature(f) && allowed.includes(f));

/** What the tenant is entitled to, now. */
export async function entitlementsFor(t: Tenant, now = new Date()): Promise<Entitlements> {
  const allowed = t.kind === 'club' ? CLUB_PLAN_FEATURES : FEATURES;
  const live = await prisma.commercialSubscription.findFirst({
    where: { ...tenantWhere(t), status: SS.ACTIVE, OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
    orderBy: { createdAt: 'desc' }, select: { plan: { select: PLAN_SELECT } },
  });
  const plan = live?.plan ?? await prisma.commercialPlan.findFirst({ where: { audience: audienceOf(t), isDefault: true, active: true }, select: PLAN_SELECT });
  if (!plan) {
    return { source: 'built-in', plan: null, features: [...(t.kind === 'club' ? BUILT_IN_CLUB : BUILT_IN_CREATOR)], limits: { projects: null, collections: null, shares: null } };
  }
  return { source: live ? 'subscription' : 'default-plan', plan, features: known(plan.features, allowed),
    limits: { projects: plan.maxProjects, collections: plan.maxCollections, shares: plan.maxShares } };
}

export async function requireFeature(t: Tenant, f: Feature): Promise<void> {
  if (!(await entitlementsFor(t)).features.includes(f)) throw new PlanFeatureRequiredError(f);
}

/** Refuse a new project, collection or share beyond the plan's limit (archived projects and collections do not count). */
export async function requireUnderLimit(t: Tenant, limit: 'projects' | 'collections' | 'shares'): Promise<void> {
  const e = await entitlementsFor(t);
  const max = e.limits[limit];
  if (max === null) return;
  const n = limit === 'projects' ? await prisma.designProject.count({ where: { ...tenantWhere(t), archivedAt: null } })
    : limit === 'collections' ? await prisma.designCollection.count({ where: { ...tenantWhere(t), archivedAt: null } })
      : t.kind === 'creator' ? await prisma.designShare.count({ where: { creatorId: t.creatorId, revokedAt: null } }) : 0;
  if (n >= max) throw new PlanLimitReachedError(limit, max);
}

/** The plans offered to an audience: active ones, in the Owner's order. */
export async function offeredPlans(audience: PlanAudience): Promise<PlanView[]> {
  return prisma.commercialPlan.findMany({ where: { audience, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: PLAN_SELECT });
}

// ── the Platform Owner's configuration ────────────────────────────────────────────────────────────────────────────────

export interface PlanInput {
  key?: unknown; audience?: unknown; name?: unknown; description?: unknown; features?: unknown;
  maxProjects?: unknown; maxCollections?: unknown; maxShares?: unknown;
  priceMinor?: unknown; currency?: unknown; interval?: unknown; isDefault?: unknown; active?: unknown; sortOrder?: unknown;
}
const CONTROL = /[\u0000-\u001F\u007F]/;
function text(v: unknown, path: string, max: number, required: boolean): string | null {
  if (v === null || v === undefined || v === '') { if (required) throw new PlanInvalidError('required', path); return null; }
  const s = typeof v === 'string' ? v.normalize('NFC').trim() : '';
  if (!s || Array.from(s).length > max || CONTROL.test(s)) throw new PlanInvalidError('bad-text', path);
  return s;
}
function count(v: unknown, path: string, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new PlanInvalidError('bad-number', path);
  return v;
}
function clean(input: PlanInput, audience: PlanAudience) {
  const allowed = audience === PlanAudience.CLUB ? CLUB_PLAN_FEATURES : FEATURES;
  if (!Array.isArray(input.features) || !input.features.every((f) => isFeature(f) && allowed.includes(f))) throw new PlanInvalidError('bad-features', 'features');
  const priceMinor = count(input.priceMinor, 'priceMinor', 0, 100_000_000);
  const currency = priceMinor === null ? null : typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency) ? input.currency : null;
  const interval = priceMinor === null ? null : input.interval === 'MONTH' || input.interval === 'YEAR' ? input.interval as PlanInterval : null;
  if (priceMinor !== null && (!currency || !interval)) throw new PlanInvalidError('bad-price', currency ? 'interval' : 'currency');
  return {
    name: text(input.name, 'name', 60, true) as string, description: text(input.description, 'description', 400, false),
    features: [...new Set(input.features as Feature[])],
    maxProjects: count(input.maxProjects, 'maxProjects', 1, 100_000), maxCollections: count(input.maxCollections, 'maxCollections', 1, 100_000),
    maxShares: audience === PlanAudience.CREATOR ? count(input.maxShares, 'maxShares', 0, 1000) : null,
    priceMinor, currency, interval, isDefault: input.isDefault === true, active: input.active !== false, sortOrder: count(input.sortOrder, 'sortOrder', 0, 1000) ?? 0,
  };
}
async function clearOtherDefault(tx: Prisma.TransactionClient, audience: PlanAudience, keepId: string | null) {
  await tx.commercialPlan.updateMany({ where: { audience, isDefault: true, ...(keepId ? { id: { not: keepId } } : {}) }, data: { isDefault: false } });
}

export async function listPlans(): Promise<{ plans: PlanView[]; features: readonly Feature[]; clubFeatures: readonly Feature[] }> {
  const plans = await prisma.commercialPlan.findMany({ orderBy: [{ audience: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }], take: 200, select: PLAN_SELECT });
  return { plans, features: FEATURES, clubFeatures: CLUB_PLAN_FEATURES };
}

export async function createPlan(actor: DesignActor, input: PlanInput): Promise<{ plan: PlanView }> {
  const key = typeof input.key === 'string' ? input.key.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) throw new PlanInvalidError('bad-key', 'key');
  const audience = input.audience === 'CLUB' ? PlanAudience.CLUB : input.audience === 'CREATOR' ? PlanAudience.CREATOR : null;
  if (!audience) throw new PlanInvalidError('bad-audience', 'audience');
  const data = clean(input, audience);
  return prisma.$transaction(async (tx) => {
    if (data.isDefault && data.active) await clearOtherDefault(tx, audience, null);
    let plan: PlanView;
    try { plan = await tx.commercialPlan.create({ data: { ...data, key, audience, createdById: actor.userId }, select: PLAN_SELECT }); } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictError('A plan with this key already exists');
      throw err;
    }
    await ownerAudit(tx, actor, { action: 'commercial.plan.created', resourceType: 'CommercialPlan', resourceId: plan.id,
      metadata: { key, audience, features: plan.features, priceMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval, isDefault: plan.isDefault }, message: 'A plan was configured' });
    return { plan };
  });
}

/** Change a plan (its key and audience never change). A price change applies to subscriptions requested from then on. */
export async function updatePlan(actor: DesignActor, id: string, input: PlanInput): Promise<{ plan: PlanView }> {
  const cur = await prisma.commercialPlan.findUnique({ where: { id }, select: { audience: true } });
  if (!cur) throw new NotFoundError('Plan');
  const data = clean(input, cur.audience);
  return prisma.$transaction(async (tx) => {
    if (data.isDefault && data.active) await clearOtherDefault(tx, cur.audience, id);
    const plan = await tx.commercialPlan.update({ where: { id }, data, select: PLAN_SELECT });
    await ownerAudit(tx, actor, { action: 'commercial.plan.updated', resourceType: 'CommercialPlan', resourceId: id,
      metadata: { features: plan.features, priceMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval, isDefault: plan.isDefault, active: plan.active }, message: 'A plan was changed' });
    return { plan };
  });
}
