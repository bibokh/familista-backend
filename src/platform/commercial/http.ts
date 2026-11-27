/**
 * Familista commercial plans and billing (P5, P6) — the HTTP side: the gates every feature route sits behind, a tenant's
 * own plan and invoices, and the Platform Owner's plans and billing. Validation here (zod, strict), rules in the services.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { ForbiddenError } from '../../utils/errors';
import { designActorOf } from '../product-design/scope-http';
import { clubTenant, creatorTenant, type Tenant } from '../tenancy/tenant';
import type { Feature } from './features';
import { PaymentsNotConfiguredError } from './payment-provider';
import { createPlan, listPlans, PlanFeatureRequiredError, PlanInvalidError, PlanLimitReachedError, requireFeature, requireUnderLimit, updatePlan } from './plans.service';
import { cancelPlan, checkout, myBilling, ownerEnd, ownerExpireDue, ownerGrant, ownerOverview, ownerVoid, requestPlan, SubscriptionRefusedError } from './subscription.service';
import { gettingStarted, ownerReadiness } from './readiness.service';
import { proExport, techPack } from './tech-pack';

function refusal(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof PlanFeatureRequiredError) { res.status(403).json({ success: false, code: err.code, feature: err.feature, message: err.message }); return; }
  if (err instanceof PlanLimitReachedError) { res.status(403).json({ success: false, code: err.code, limit: err.limit, max: err.max, message: err.message }); return; }
  if (err instanceof PlanInvalidError) { res.status(400).json({ success: false, code: err.code, reason: err.reason, path: err.path, message: err.message }); return; }
  if (err instanceof SubscriptionRefusedError) { res.status(409).json({ success: false, code: err.code, reason: err.reason, message: err.message }); return; }
  if (err instanceof PaymentsNotConfiguredError) { res.status(503).json({ success: false, code: err.code, message: err.message, problem: err.problem }); return; }
  next(err);
}
function handler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res, next) => { try { await work(req, res); } catch (err) { refusal(err, res, next); } };
}
const Id = z.string().guid();

// ── the gates ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const creatorOf = (req: Request): Tenant => creatorTenant((req.creator as { id: string }).id);
const clubOf = (req: Request): Tenant => clubTenant(req.user?.clubId ?? '');
/** A creator route the creator's plan must include (403 PLAN_FEATURE_REQUIRED with the feature otherwise). */
export function creatorFeature(f: Feature): RequestHandler {
  return async (req, res, next) => { try { await requireFeature(creatorOf(req), f); next(); } catch (err) { refusal(err, res, next); } };
}
/** A creator route that adds a project, collection or share: refused at the plan's limit (403 PLAN_LIMIT_REACHED). */
export function creatorLimit(limit: 'projects' | 'collections' | 'shares'): RequestHandler {
  return async (req, res, next) => { try { await requireUnderLimit(creatorOf(req), limit); next(); } catch (err) { refusal(err, res, next); } };
}
/** A club route a club plan must include: the professional tools. */
export function clubFeature(f: Feature): RequestHandler {
  return async (req, res, next) => { try { await requireFeature(clubOf(req), f); next(); } catch (err) { refusal(err, res, next); } };
}
function clubAdmin(req: Request): void { if (req.user?.role !== UserRole.CLUB_ADMIN) throw new ForbiddenError('Only a club administrator changes the club’s plan'); }

// ── the professional tools, for a creator or a club ───────────────────────────────────────────────────────────────
const TechQuery = z.object({ format: z.enum(['json', 'csv']).default('json') }).strict();
function techHandler(tenantOf: (req: Request) => Tenant): RequestHandler {
  return handler(async (req, res) => {
    const q = TechQuery.parse(req.query);
    const out = await techPack(tenantOf(req), designActorOf(req), Id.parse(req.params.id), q.format);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
    if (q.format === 'csv') { res.type('text/csv; charset=utf-8').send(out.csv); return; }
    res.json({ success: true, data: { techPack: out.pack, fileName: out.fileName } });
  });
}
export const creatorTechPack = techHandler(creatorOf);
export const clubTechPack = techHandler(clubOf);
export const creatorProExport = handler(async (req, res) => { res.status(201).json({ success: true, data: await proExport(creatorOf(req), designActorOf(req), Id.parse(req.params.id)) }); });
export const clubProExport = handler(async (req, res) => { res.status(201).json({ success: true, data: await proExport(clubOf(req), designActorOf(req), Id.parse(req.params.id)) }); });

// ── a tenant's own plan and invoices ──────────────────────────────────────────────────────────────────────────────
const PlanBody = z.object({ planKey: z.string().max(40) }).strict();
export const creatorBilling = handler(async (req, res) => { res.json({ success: true, data: await myBilling(creatorOf(req)) }); });
export const creatorRequestPlan = handler(async (req, res) => { res.json({ success: true, data: await requestPlan(creatorOf(req), designActorOf(req), PlanBody.parse(req.body).planKey) }); });
export const creatorCancelPlan = handler(async (req, res) => { res.json({ success: true, data: await cancelPlan(creatorOf(req), designActorOf(req)) }); });
export const creatorCheckout = handler(async (req, res) => { res.json({ success: true, data: await checkout(creatorOf(req), Id.parse(req.params.invoiceId)) }); });
export const clubBilling = handler(async (req, res) => { res.json({ success: true, data: await myBilling(clubOf(req)) }); });
export const clubRequestPlan = handler(async (req, res) => { clubAdmin(req); res.json({ success: true, data: await requestPlan(clubOf(req), designActorOf(req), PlanBody.parse(req.body).planKey) }); });
export const clubCancelPlan = handler(async (req, res) => { clubAdmin(req); res.json({ success: true, data: await cancelPlan(clubOf(req), designActorOf(req)) }); });
export const clubCheckout = handler(async (req, res) => { clubAdmin(req); res.json({ success: true, data: await checkout(clubOf(req), Id.parse(req.params.invoiceId)) }); });

// ── the Platform Owner's ──────────────────────────────────────────────────────────────────────────────────────────
const PlanInputBody = z.object({
  key: z.string().max(40).optional(), audience: z.enum(['CREATOR', 'CLUB']).optional(), name: z.string().max(120), description: z.string().max(800).nullable().optional(),
  features: z.array(z.string().max(40)).max(20), maxProjects: z.number().int().nullable().optional(), maxCollections: z.number().int().nullable().optional(),
  maxShares: z.number().int().nullable().optional(), priceMinor: z.number().int().nullable().optional(), currency: z.string().max(3).nullable().optional(),
  interval: z.enum(['MONTH', 'YEAR']).nullable().optional(), isDefault: z.boolean().optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional(),
}).strict();
const GrantBody = z.object({ tenantKind: z.enum(['club', 'creator']), tenantId: z.string().max(64), planKey: z.string().max(40), months: z.number().int().nullable().optional(), note: z.string().max(400) }).strict();
const NoteBody = z.object({ note: z.string().max(400) }).strict();
const DryRunBody = z.object({ dryRun: z.boolean().default(true) }).strict();
const owner = (req: Request) => designActorOf(req);
export const ownerListPlans = handler(async (_req, res) => { res.json({ success: true, data: await listPlans() }); });
export const ownerCreatePlan = handler(async (req, res) => { res.status(201).json({ success: true, data: await createPlan(owner(req), PlanInputBody.parse(req.body)) }); });
export const ownerUpdatePlan = handler(async (req, res) => { res.json({ success: true, data: await updatePlan(owner(req), Id.parse(req.params.planId), PlanInputBody.parse(req.body)) }); });
export const ownerBilling = handler(async (_req, res) => { res.json({ success: true, data: await ownerOverview() }); });
export const ownerGrantPlan = handler(async (req, res) => { res.status(201).json({ success: true, data: await ownerGrant(owner(req), GrantBody.parse(req.body)) }); });
export const ownerEndSubscription = handler(async (req, res) => { res.json({ success: true, data: await ownerEnd(owner(req), Id.parse(req.params.subscriptionId), NoteBody.parse(req.body).note) }); });
export const ownerVoidInvoice = handler(async (req, res) => { res.json({ success: true, data: await ownerVoid(owner(req), Id.parse(req.params.invoiceId)) }); });
export const ownerExpire = handler(async (req, res) => { res.json({ success: true, data: await ownerExpireDue(owner(req), DryRunBody.parse(req.body).dryRun) }); });

// ── P8: a workspace's first steps; the Owner's readiness view ─────────────────────────────────────────────────────
export const creatorGettingStarted = handler(async (req, res) => { res.json({ success: true, data: await gettingStarted(creatorOf(req)) }); });
export const clubGettingStarted = handler(async (req, res) => { res.json({ success: true, data: await gettingStarted(clubOf(req)) }); });
export const ownerReadinessView = handler(async (_req, res) => { res.json({ success: true, data: await ownerReadiness() }); });
