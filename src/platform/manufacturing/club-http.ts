/**
 * Familista Manufacturing (M4) — the club's handlers, mounted by src/routes/club-design.routes.ts behind its gate
 * (authenticate, the club roles that design kits, the club's entitlement). The club is the one the gate resolved from the
 * session; a handler reached without a club scope refuses, never serves.
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { DesignActor, DesignScope } from '../product-design/service';
import { refusals } from './errors';
import { acceptQuote, clubStep, getClubRequest, listClubRequests, submitRequest } from './request.service';

const Id = z.string().guid();
const Note = z.string().max(4000).nullable().default(null);
const SubmitBody = z.object({ rosterId: Id.nullable().default(null), note: Note, neededBy: z.string().max(10).nullable().default(null) }).strict();
const StepBody = z.object({ note: Note }).strict();

function clubOf(res: Response): string {
  const s = res.locals.designScope as DesignScope | undefined;
  if (!s || s.kind !== 'CLUB') throw new Error('A manufacturing route was reached without a club scope');
  return s.clubId;
}
function actorOf(req: Request): DesignActor {
  const ua = req.headers['user-agent'];
  return { userId: req.user?.id ?? '', ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function handler(work: (req: Request, res: Response, clubId: string) => Promise<void>): RequestHandler {
  return async (req, res, next) => { try { await work(req, res, clubOf(res)); } catch (err) { refusals(err, res, next); } };
}

export const submitManufacturingRequest = handler(async (req, res, clubId) => {
  const body = SubmitBody.parse(req.body);
  res.status(201).json({ success: true, data: await submitRequest(clubId, actorOf(req), { collectionId: Id.parse(req.params.collectionId), ...body }) });
});
export const listManufacturingRequests = handler(async (_req, res, clubId) => { res.json({ success: true, data: await listClubRequests(clubId) }); });
export const openManufacturingRequest = handler(async (req, res, clubId) => { res.json({ success: true, data: await getClubRequest(clubId, Id.parse(req.params.requestId)) }); });
const step = (action: 'cancel' | 'decline' | 'deliver') => handler(async (req, res, clubId) => {
  const { note } = StepBody.parse(req.body ?? {});
  res.json({ success: true, data: await clubStep(clubId, actorOf(req), Id.parse(req.params.requestId), action, note) });
});
export const cancelManufacturingRequest = step('cancel');
export const declineManufacturingQuotes = step('decline');
export const confirmManufacturingDelivery = step('deliver');
export const acceptManufacturingQuote = handler(async (req, res, clubId) => {
  res.json({ success: true, data: await acceptQuote(clubId, actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.quoteId)) });
});
