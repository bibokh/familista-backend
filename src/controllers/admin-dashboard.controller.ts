// Familista — Platform Admin Dashboard
// File location: src/controllers/admin-dashboard.controller.ts
//
// HTTP handlers for the Admin Control Center. Thin shim — every handler:
//   1. Parses query / params with zod (no manual casts).
//   2. Pulls req.platformActor from the chained RBAC middleware.
//   3. Delegates to the dashboard or management service.
//   4. Returns via sendSuccess / sendPaginated.
//
// Destructive write paths call into admin-management.service which writes
// audit entries internally. Read paths are not audited (volume too high).

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as dash from '../services/admin-dashboard.service';
import * as mgmt from '../services/admin-management.service';
import { sendSuccess, sendPaginated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function actorOf(req: Request) {
  if (!req.platformActor) throw new ForbiddenError('Platform context required');
  return req.platformActor;
}

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.join('.') || 'query'}: ${e.message}`).join(', '),
  );
}

const paginationSchema = z.object({
  page:  z.coerce.number().int().min(1).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function parsePagination(req: Request) {
  const r = paginationSchema.safeParse(req.query);
  if (!r.success) throw zerr(r.error);
  return r.data;
}

function parseDateMaybe(s: unknown): Date | null {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — overview, engine status, subscriptions, alerts
// ─────────────────────────────────────────────────────────────────────────────

const overviewQuerySchema = z.object({
  window:   z.enum(['24h', '7d', '30d', '90d', 'all']).optional(),
  currency: z.string().min(3).max(8).optional(),
});

export async function getOverview(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const parsed = overviewQuerySchema.safeParse(req.query);
    if (!parsed.success) throw zerr(parsed.error);
    const result = await dash.getOverview(parsed.data.window ?? '30d', { defaultCurrency: parsed.data.currency });
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function getEngineStatus(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const result = await dash.getEngineStatus();
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function getSubscriptionBreakdown(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const result = await dash.getSubscriptionBreakdown();
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function getAiEngineDetail(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const result = await dash.getAiEngineDetail();
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function getVisionEngineDetail(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const result = await dash.getVisionEngineDetail();
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function getSystemAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const result = await dash.getSystemAlerts();
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — organizations / clubs / academies
// ─────────────────────────────────────────────────────────────────────────────

const orgFilterSchema = z.object({
  q:               z.string().optional(),
  plan:            z.enum(['BASIC', 'PRO', 'ACADEMY', 'ENTERPRISE']).optional(),
  status:          z.enum(['ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'INCOMPLETE']).optional(),
  franchiseUnitId: z.string().optional(),
  hasOverride:     z.enum(['true', 'false']).optional(),
});

function parseOrgFilter(req: Request) {
  const r = orgFilterSchema.safeParse(req.query);
  if (!r.success) throw zerr(r.error);
  const v = r.data;
  return {
    q: v.q,
    plan:   v.plan,
    status: v.status,
    franchiseUnitId: v.franchiseUnitId,
    hasOverride: v.hasOverride === 'true' ? true : v.hasOverride === 'false' ? false : undefined,
  };
}

export async function listOrganizations(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const out = await mgmt.listOrganizations(parseOrgFilter(req), pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function listAcademies(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const filter = parseOrgFilter(req);
    const out = await mgmt.listOrganizations({ ...filter, plan: 'ACADEMY' }, pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getOrganizationDetail(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const id = String(req.params.id ?? '');
    if (!id) throw new BadRequestError('id required');
    const detail = await mgmt.getOrganizationDetail(id);
    return sendSuccess(res, detail);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — users (general / coaches / managers)
// ─────────────────────────────────────────────────────────────────────────────

const userFilterSchema = z.object({
  q:        z.string().optional(),
  role:     z.enum(['SUPER_ADMIN', 'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT']).optional(),
  clubId:   z.string().optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

function parseUserFilter(req: Request) {
  const r = userFilterSchema.safeParse(req.query);
  if (!r.success) throw zerr(r.error);
  const v = r.data;
  return {
    q: v.q,
    role: v.role,
    clubId: v.clubId,
    isActive: v.isActive === 'true' ? true : v.isActive === 'false' ? false : undefined,
  };
}

export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const out = await mgmt.listUsers(parseUserFilter(req), pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function listCoaches(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const out = await mgmt.listCoaches(parseUserFilter(req), pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function listManagers(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const out = await mgmt.listManagers(parseUserFilter(req), pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const setActiveSchema = z.object({
  isActive: z.boolean(),
  reason:   z.string().max(500).optional(),
});

export async function setUserActive(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const id = String(req.params.id ?? '');
    if (!id) throw new BadRequestError('id required');
    const r = setActiveSchema.safeParse(req.body);
    if (!r.success) throw zerr(r.error);
    await mgmt.setUserActive(actor, id, r.data.isActive, r.data.reason ?? null);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — players
// ─────────────────────────────────────────────────────────────────────────────

const playerFilterSchema = z.object({ q: z.string().optional(), clubId: z.string().optional() });

export async function listPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = playerFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listPlayers(r.data, pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — investors
// ─────────────────────────────────────────────────────────────────────────────

const investorFilterSchema = z.object({
  q:         z.string().optional(),
  kycStatus: z.enum(['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']).optional(),
  isActive:  z.enum(['true', 'false']).optional(),
});

export async function listInvestors(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = investorFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listInvestors(
      {
        q: r.data.q,
        kycStatus: r.data.kycStatus,
        isActive: r.data.isActive === 'true' ? true : r.data.isActive === 'false' ? false : undefined,
      },
      pag,
    );
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function setInvestorActive(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const id = String(req.params.id ?? '');
    if (!id) throw new BadRequestError('id required');
    const r = setActiveSchema.safeParse(req.body);
    if (!r.success) throw zerr(r.error);
    await mgmt.setInvestorActive(actor, id, r.data.isActive, r.data.reason ?? null);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — subscriptions
// ─────────────────────────────────────────────────────────────────────────────

const subFilterSchema = z.object({
  q:      z.string().optional(),
  plan:   z.enum(['BASIC', 'PRO', 'ACADEMY', 'ENTERPRISE']).optional(),
  status: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'INCOMPLETE']).optional(),
});

export async function listSubscriptions(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = subFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listSubscriptions(r.data, pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — payments
// ─────────────────────────────────────────────────────────────────────────────

const paymentFilterSchema = z.object({
  clubId:   z.string().optional(),
  type:     z.enum(['INCOME', 'EXPENSE']).optional(),
  currency: z.string().min(3).max(8).optional(),
  category: z.string().optional(),
  from:     z.string().optional(),
  to:       z.string().optional(),
});

export async function listPayments(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = paymentFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listPayments(
      {
        clubId: r.data.clubId,
        type: r.data.type,
        currency: r.data.currency,
        category: r.data.category,
        from: parseDateMaybe(r.data.from),
        to: parseDateMaybe(r.data.to),
      },
      pag,
    );
    // sendPaginated drops totalsAmount; expose via a wrapper.
    return res.status(200).json({
      success: true,
      data: out.items,
      pagination: { total: out.total, page: out.page, limit: out.limit, pageCount: Math.ceil(out.total / Math.max(out.limit, 1)) },
      totals: { amount: out.totalsAmount },
    });
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — franchise units
// ─────────────────────────────────────────────────────────────────────────────

const franchiseFilterSchema = z.object({
  q:           z.string().optional(),
  status:      z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'IN_RENEWAL', 'TERMINATED']).optional(),
  level:       z.enum(['MASTER', 'REGIONAL', 'LOCAL', 'ACADEMY']).optional(),
  territoryId: z.string().optional(),
});

export async function listFranchiseUnits(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = franchiseFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listFranchiseUnits(r.data, pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const franchiseStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED']),
  reason: z.string().max(500).optional(),
});

export async function setFranchiseUnitStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const id = String(req.params.id ?? '');
    if (!id) throw new BadRequestError('id required');
    const r = franchiseStatusSchema.safeParse(req.body);
    if (!r.success) throw zerr(r.error);
    await mgmt.setFranchiseUnitStatus(actor, id, r.data.status, r.data.reason ?? null);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — AI engine
// ─────────────────────────────────────────────────────────────────────────────

const aiModelFilterSchema = z.object({
  activeOnly: z.enum(['true', 'false']).optional(),
  q:          z.string().optional(),
});

export async function listAiModels(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = aiModelFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listAiModels(
      { activeOnly: r.data.activeOnly === 'true', q: r.data.q },
      pag,
    );
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const aiDecisionFilterSchema = z.object({
  domain: z.enum(['PLAYER', 'COACH', 'CLUB', 'FRANCHISE', 'INVESTOR', 'EXECUTIVE']).optional(),
  clubId: z.string().optional(),
});

export async function listAiDecisions(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = aiDecisionFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listAiDecisions(r.data, pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — Vision engine
// ─────────────────────────────────────────────────────────────────────────────

const visionRunFilterSchema = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  clubId: z.string().optional(),
});

export async function listVisionRuns(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = visionRunFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listVisionRuns(r.data, pag);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Management — Audit logs
// ─────────────────────────────────────────────────────────────────────────────

const auditFilterSchema = z.object({
  adminId:      z.string().optional(),
  userId:       z.string().optional(),
  clubId:       z.string().optional(),
  action:       z.string().optional(),
  category:     z.string().optional(),
  result:       z.string().optional(),
  resourceType: z.string().optional(),
  resourceId:   z.string().optional(),
  from:         z.string().optional(),
  to:           z.string().optional(),
});

export async function listAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const pag = parsePagination(req);
    const r = auditFilterSchema.safeParse(req.query);
    if (!r.success) throw zerr(r.error);
    const out = await mgmt.listAuditLogs(
      {
        ...r.data,
        from: parseDateMaybe(r.data.from),
        to: parseDateMaybe(r.data.to),
      },
      pag,
    );
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}
