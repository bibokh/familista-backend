// Familista — Billing controller (Phase J, additive — does not replace
// Phase A billing.controller). Read-only and DTO-only — no payment gateway.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../billing/plans.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

function actor(req: Request): svc.BillingActor {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role };
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || 'body'}: ${e.message}`).join(', '));
}

export async function listTiers(req: Request, res: Response, next: NextFunction) {
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const out = await svc.listTiers({ kind: kind as never, activeOnly: req.query.activeOnly === 'true' });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

export async function getAccount(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.getAccount(actor(req))); }
  catch (err) { return next(err); }
}

const changeSchema = z.object({ body: z.object({ planCode: z.string().trim().min(1) }) });

export async function changePlan(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = changeSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    return sendSuccess(res, await svc.changePlan(actor(req), parsed.data.body.planCode));
  } catch (err) { return next(err); }
}

export async function cancelAccount(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.cancelAccount(actor(req))); }
  catch (err) { return next(err); }
}

const assignSchema = z.object({ body: z.object({ deviceId: z.string().uuid(), planCode: z.string().trim().min(1) }) });

export async function assignDevicePlan(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = assignSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, await svc.assignDevicePlan(actor(req), parsed.data.body.deviceId, parsed.data.body.planCode));
  } catch (err) { return next(err); }
}

export async function listDevicePlans(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.listDevicePlans(actor(req), req.params.deviceId)); }
  catch (err) { return next(err); }
}

export async function listUsage(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listUsage(actor(req), {
      period: typeof req.query.period === 'string' ? req.query.period : undefined,
      kind:   typeof req.query.kind   === 'string' ? req.query.kind   : undefined,
      limit:  typeof req.query.limit  === 'string' ? parseInt(req.query.limit, 10) : undefined,
    });
    // BigInt → string for JSON safety.
    return sendSuccess(res, out.map((r) => ({ ...r, count: r.count.toString() })));
  } catch (err) { return next(err); }
}

const invoiceSchema = z.object({
  body: z.object({
    periodFrom: z.string().datetime(),
    periodTo:   z.string().datetime(),
    amountCents: z.number().int().min(0).optional(),
    lineItems:   z.any().optional(),
  }),
});

export async function createInvoiceDraft(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = invoiceSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    return sendCreated(res, await svc.createInvoiceDraft(actor(req), parsed.data.body));
  } catch (err) { return next(err); }
}

export async function listInvoiceDrafts(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.listInvoiceDrafts(actor(req))); }
  catch (err) { return next(err); }
}
