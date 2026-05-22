// Familista — Provisioning controller (Phase J)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../provisioning/provisioning.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

function actor(req: Request): svc.ProvisioningActor {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role };
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || 'body'}: ${e.message}`).join(', '));
}

const batchSchema = z.object({
  body: z.object({
    model:      z.string().trim().min(1).max(120),
    serials:    z.array(z.string().trim().min(1).max(120)).min(1).max(1000),
    hwRevision: z.string().trim().max(40).optional(),
    factoryRef: z.string().trim().max(200).optional(),
    manifestId: z.string().uuid().nullable().optional(),
    metadata:   z.any().optional(),
  }),
});

export async function createBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = batchSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.createBatch(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function listBatches(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listBatches(actor(req), {
      status: (typeof req.query.status === 'string' ? req.query.status : undefined) as svc.CreateBatchDto['model'] | undefined as never,
      model:  typeof req.query.model  === 'string' ? req.query.model  : undefined,
      page:   typeof req.query.page   === 'string' ? parseInt(req.query.page, 10)  : undefined,
      limit:  typeof req.query.limit  === 'string' ? parseInt(req.query.limit, 10) : undefined,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getBatch(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.getBatch(actor(req), req.params.id)); }
  catch (err) { return next(err); }
}

export async function materialiseBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.materialiseBatch(actor(req), req.params.id);
    return sendSuccess(res, out, `Materialised batch — ${out.created} created, ${out.skipped} skipped`);
  } catch (err) { return next(err); }
}

const certSchema = z.object({
  body: z.object({
    deviceId:    z.string().uuid(),
    fingerprint: z.string().trim().min(8).max(256),
    issuer:      z.string().trim().max(200).optional(),
    validUntil:  z.string().datetime().optional(),
  }),
});

export async function issueCert(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = certSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.issueCert(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function revokeCert(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.revokeCert(actor(req), req.params.certId)); }
  catch (err) { return next(err); }
}

export async function listCertsForDevice(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.listCertsForDevice(actor(req), req.params.deviceId)); }
  catch (err) { return next(err); }
}

const manifestSchema = z.object({
  body: z.object({
    model:        z.string().trim().min(1).max(120),
    channel:      z.string().trim().min(1).max(40).optional(),
    version:      z.string().trim().min(3).max(40),
    files:        z.any(),
    releaseNotes: z.string().trim().max(2000).optional(),
    minHwRev:     z.string().trim().max(40).optional(),
  }).refine((v) => v.files !== undefined, { message: 'files required', path: ['files'] }),
});

export async function publishManifest(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = manifestSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const out = await svc.publishManifest(actor(req), {
      model: body.model,
      channel: body.channel,
      version: body.version,
      files: body.files as never,
      releaseNotes: body.releaseNotes,
      minHwRev: body.minHwRev,
    });
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function listManifests(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listManifests({
      model:   typeof req.query.model   === 'string' ? req.query.model   : undefined,
      channel: typeof req.query.channel === 'string' ? req.query.channel : undefined,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

const releaseSchema = z.object({
  body: z.object({
    manifestId:  z.string().uuid(),
    rolloutPct:  z.number().int().min(0).max(100).optional(),
    scheduledAt: z.string().datetime().optional(),
  }),
});

export async function createOTARelease(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = releaseSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.createOTARelease(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function advanceRollout(req: Request, res: Response, next: NextFunction) {
  try {
    const pct = typeof req.body?.rolloutPct === 'number' ? req.body.rolloutPct : 0;
    return sendSuccess(res, await svc.advanceRollout(actor(req), req.params.releaseId, pct));
  } catch (err) { return next(err); }
}

export async function listReleases(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listReleases({
      model:  typeof req.query.model  === 'string' ? req.query.model  : undefined,
      status: typeof req.query.status === 'string' ? (req.query.status as never) : undefined,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}
