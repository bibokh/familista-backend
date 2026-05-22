// Familista — Edge controller (Phase J)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../edge/edge-node.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const KINDS = ['CAMERA','WEARABLE','TURF','SMART_BALL','BIOCHEM','EDGE_BOX'] as const;
const COMP  = ['NONE','ZSTD','LZ4','DELTA'] as const;

function actor(req: Request): svc.EdgeActor {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role };
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || 'body'}: ${e.message}`).join(', '));
}

const registerSchema = z.object({
  body: z.object({
    kind:        z.enum(KINDS),
    deviceId:    z.string().uuid().nullable().optional(),
    cameraId:    z.string().uuid().nullable().optional(),
    label:       z.string().trim().max(200).optional(),
    fwVersion:   z.string().trim().max(40).optional(),
    teamId:      z.string().uuid().nullable().optional(),
    compression: z.enum(COMP).optional(),
    metadata:    z.any().optional(),
  }),
});

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = registerSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.registerEdgeNode(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await svc.listEdgeNodes(actor(req), {
      kind:  (req.query.kind as svc.RegisterEdgeNodeDto['kind']) || undefined,
      page:  typeof req.query.page  === 'string' ? parseInt(req.query.page, 10)  : undefined,
      limit: typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.getEdgeNode(actor(req), req.params.id)); }
  catch (err) { return next(err); }
}

export async function retire(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.retireEdgeNode(actor(req), req.params.id)); }
  catch (err) { return next(err); }
}

const syncSchema = z.object({
  body: z.object({
    fromMs:       z.number().int().min(0),
    toMs:         z.number().int().min(0),
    packetsTotal: z.number().int().min(0),
    packetsOk:    z.number().int().min(0),
    ok:           z.boolean(),
    notes:        z.string().trim().max(2000).optional(),
  }),
});

export async function recordSync(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = syncSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.recordSyncWindow(actor(req), { edgeNodeId: req.params.id, ...parsed.data.body });
    return sendCreated(res, { ...out, fromMs: out.fromMs.toString(), toMs: out.toMs.toString() });
  } catch (err) { return next(err); }
}

const bufferSchema = z.object({
  body: z.object({
    payloadHash: z.string().trim().length(64),
    sizeBytes:   z.number().int().min(0),
    capturedAt:  z.number().int().min(0),
    packetCount: z.number().int().min(1).optional(),
    compression: z.enum(COMP).optional(),
  }),
});

export async function recordBuffer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = bufferSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.recordBuffer(actor(req), { edgeNodeId: req.params.id, ...parsed.data.body });
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

const inferenceSchema = z.object({
  body: z.object({
    matchId:    z.string().uuid().nullable().optional(),
    kind:       z.string().trim().min(1).max(60),
    payload:    z.any(),
    confidence: z.number().min(0).max(1).optional(),
    capturedAt: z.number().int().min(0),
  }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }),
});

export async function recordInference(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = inferenceSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const out = await svc.recordInference(actor(req), {
      edgeNodeId: req.params.id,
      matchId:    body.matchId,
      kind:       body.kind,
      payload:    body.payload as never,
      confidence: body.confidence,
      capturedAt: body.capturedAt,
    });
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}
