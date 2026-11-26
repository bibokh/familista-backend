/**
 * Familista Manufacturing (M4) — the club's handlers, mounted by src/routes/club-design.routes.ts behind its gate
 * (authenticate, the club roles that design kits, the club's entitlement). The club is the one the gate resolved from the
 * session; a handler reached without a club scope refuses, never serves.
 */
import type { Request, RequestHandler, Response } from 'express';
import { designActorOf as actorOf, tenantOfRes } from '../product-design/scope-http';
import type { Tenant } from '../tenancy/tenant';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import type { DesignActor, DesignScope } from '../product-design/service';
import { refusals } from './errors';
import { acceptQuote, assertMayDecide, clubStep, getClubRequest, listClubRequests, submitRequest } from './request.service';

const Id = z.string().guid();
const Note = z.string().max(4000).nullable().default(null);
const SubmitBody = z.object({ rosterId: Id.nullable().default(null), note: Note, neededBy: z.string().max(10).nullable().default(null), minorsConsent: z.boolean().default(false) }).strict();
const StepBody = z.object({ note: Note }).strict();

function handler(work: (req: Request, res: Response, tenant: Tenant) => Promise<void>): RequestHandler {
  return async (req, res, next) => { try { await work(req, res, tenantOfRes(res)); } catch (err) { refusals(err, res, next); } };
}

export const submitManufacturingRequest = handler(async (req, res, tenant) => {
  const body = SubmitBody.parse(req.body);
  res.status(201).json({ success: true, data: await submitRequest(tenant, actorOf(req), { collectionId: Id.parse(req.params.collectionId), ...body }) });
});
export const listManufacturingRequests = handler(async (_req, res, tenant) => { res.json({ success: true, data: await listClubRequests(tenant) }); });
export const openManufacturingRequest = handler(async (req, res, tenant) => { res.json({ success: true, data: await getClubRequest(tenant, Id.parse(req.params.requestId)) }); });
const step = (action: 'cancel' | 'decline' | 'deliver') => handler(async (req, res, tenant) => {
  const { note } = StepBody.parse(req.body ?? {});
  if (action === 'decline') assertMayDecide(tenant, req.user?.role);
  res.json({ success: true, data: await clubStep(tenant, actorOf(req), Id.parse(req.params.requestId), action, note) });
});
export const cancelManufacturingRequest = step('cancel');
export const declineManufacturingQuotes = step('decline');
export const confirmManufacturingDelivery = step('deliver');
export const acceptManufacturingQuote = handler(async (req, res, tenant) => {
  assertMayDecide(tenant, req.user?.role);
  res.json({ success: true, data: await acceptQuote(tenant, actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.quoteId)) });
});
