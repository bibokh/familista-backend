/**
 * Familista Manufacturing (M4) — the Platform Owner's handlers, mounted by src/routes/manufacturing.routes.ts behind
 * authenticate and assertPlatformOwner, on the system path.
 */
import type { Request, RequestHandler, Response } from 'express';
import { ManufacturingRequestStatus, ManufacturingSupplierStatus } from '@prisma/client';
import { z } from 'zod';
import type { DesignActor } from '../product-design/service';
import { refusals } from './errors';
import { discardDraft, eraseRequestNames, getRequest, listAllRequests, ownerStep, productionSheet, productionTechPack, publishQuote, recordQuote, requestFit, specDesign, withdrawQuote } from './request.service';
import { createSupplier, getSupplier, listSuppliers, setSupplierStatus, updateSupplier } from './supplier.service';

const Id = z.string().guid();
const Text = (max: number) => z.string().max(max);
const SupplierFields = {
  name: Text(400), country: Text(2), city: Text(400).nullable().default(null), website: Text(400).nullable().default(null),
  contactEmail: Text(400).nullable().default(null), forms: z.array(Text(20)).max(3).default([]), methods: z.array(Text(20)).max(4).default([]),
  minOrderSets: z.number().int().min(1).max(100000).nullable().default(null), leadTimeDays: z.number().int().min(1).max(365).nullable().default(null),
};
const SupplierBody = z.object(SupplierFields).strict();
const SupplierSave = z.object({ ...SupplierFields, version: z.number().int().min(1) }).strict();
const SupplierStatusBody = z.object({ status: z.enum([ManufacturingSupplierStatus.PROSPECT, ManufacturingSupplierStatus.VERIFIED, ManufacturingSupplierStatus.SUSPENDED]), note: Text(2000) }).strict();
const SupplierQuery = z.object({ status: z.enum([ManufacturingSupplierStatus.PROSPECT, ManufacturingSupplierStatus.VERIFIED, ManufacturingSupplierStatus.SUSPENDED]).optional() }).strict();
const STATUSES = Object.values(ManufacturingRequestStatus) as [ManufacturingRequestStatus, ...ManufacturingRequestStatus[]];
const RequestQuery = z.object({ status: z.enum(STATUSES).optional() }).strict();
const StepBody = z.object({ note: Text(4000).nullable().default(null) }).strict();
const QuoteBody = z.object({
  supplierId: Id, currency: Text(3), totalMinor: z.number().int(), lines: z.array(z.object({ projectId: Id, unitMinor: z.number().int(), sets: z.number().int() }).strict()).max(24).default([]),
  leadTimeDays: z.number().int(), validUntil: Text(10), supplierReference: Text(400), evidence: Text(2000), terms: Text(2000).nullable().optional(),
}).strict();
const WithdrawBody = z.object({ note: Text(4000) }).strict();

function actorOf(req: Request): DesignActor {
  const ua = req.headers['user-agent'];
  return { userId: req.user?.id ?? '', ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function handler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res, next) => { try { await work(req, res); } catch (err) { refusals(err, res, next); } };
}

export const ownerListSuppliers = handler(async (req, res) => { res.json({ success: true, data: await listSuppliers(SupplierQuery.parse(req.query).status) }); });
export const ownerCreateSupplier = handler(async (req, res) => { res.status(201).json({ success: true, data: await createSupplier(actorOf(req), SupplierBody.parse(req.body)) }); });
export const ownerOpenSupplier = handler(async (req, res) => { res.json({ success: true, data: await getSupplier(Id.parse(req.params.supplierId)) }); });
export const ownerSaveSupplier = handler(async (req, res) => { res.json({ success: true, data: await updateSupplier(actorOf(req), Id.parse(req.params.supplierId), SupplierSave.parse(req.body)) }); });
export const ownerSetSupplierStatus = handler(async (req, res) => {
  const { status, note } = SupplierStatusBody.parse(req.body);
  res.json({ success: true, data: await setSupplierStatus(actorOf(req), Id.parse(req.params.supplierId), status, note) });
});

export const ownerListRequests = handler(async (req, res) => { res.json({ success: true, data: await listAllRequests(RequestQuery.parse(req.query).status) }); });
export const ownerOpenRequest = handler(async (req, res) => { res.json({ success: true, data: await getRequest(Id.parse(req.params.requestId)) }); });
const step = (action: 'review' | 'refuse' | 'order' | 'produce' | 'ship' | 'deliver') => handler(async (req, res) => {
  const { note } = StepBody.parse(req.body ?? {});
  res.json({ success: true, data: await ownerStep(actorOf(req), Id.parse(req.params.requestId), action, note) });
});
export const ownerReviewRequest = step('review');
export const ownerRefuseRequest = step('refuse');
export const ownerConfirmOrder = step('order');
export const ownerStartProduction = step('produce');
export const ownerRecordShipping = step('ship');
export const ownerRecordDelivery = step('deliver');
export const ownerRecordQuote = handler(async (req, res) => { res.status(201).json({ success: true, data: await recordQuote(actorOf(req), Id.parse(req.params.requestId), QuoteBody.parse(req.body)) }); });
export const ownerPublishQuote = handler(async (req, res) => { res.json({ success: true, data: await publishQuote(actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.quoteId)) }); });
export const ownerWithdrawQuote = handler(async (req, res) => {
  res.json({ success: true, data: await withdrawQuote(actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.quoteId), WithdrawBody.parse(req.body).note) });
});
export const ownerDiscardDraft = handler(async (req, res) => { res.json({ success: true, data: await discardDraft(actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.quoteId)) }); });
export const ownerRequestFit = handler(async (req, res) => { res.json({ success: true, data: await requestFit(Id.parse(req.params.requestId)) }); });
export const ownerSpecDesign = handler(async (req, res) => { res.json({ success: true, data: await specDesign(actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.projectId)) }); });
// P1: the production sheet, once the order is confirmed with its supplier; a closed request's names, erased.
export const ownerProductionSheet = handler(async (req, res) => { res.json({ success: true, data: await productionSheet(actorOf(req), Id.parse(req.params.requestId)) }); });
// P7: a design's tech pack as the request froze it, for the order's supplier, once the order is confirmed.
const TechQuery = z.object({ format: z.enum(['json', 'csv']).default('json') }).strict();
export const ownerProductionTechPack = handler(async (req, res) => {
  const { format } = TechQuery.parse(req.query);
  const out = await productionTechPack(actorOf(req), Id.parse(req.params.requestId), Id.parse(req.params.projectId), format);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
  if (format === 'csv') { res.type('text/csv; charset=utf-8').send(out.csv); return; }
  res.json({ success: true, data: { techPack: out.techPack, fileName: out.fileName, supplier: out.supplier } });
});
export const ownerEraseNames = handler(async (req, res) => {
  const { note } = WithdrawBody.parse(req.body ?? {});
  res.json({ success: true, data: await eraseRequestNames(actorOf(req), Id.parse(req.params.requestId), note) });
});
