// Familista — Vision controller (Phase G)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as registry from '../vision/camera-registry.service';
import * as ingest   from '../vision/vision-ingest.service';
import { listSports } from '../sports';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const CAMERA_KINDS  = ['RGB','DEPTH','EVENT','PANORAMIC','AERIAL'] as const;
const CAMERA_STATUS = ['REGISTERED','CALIBRATED','ACTIVE','OFFLINE','RETIRED'] as const;

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}

function actorOf(req: Request): registry.CameraActor {
  if (!req.user) throw new BadRequestError('Auth context missing');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role };
}

// ── Registry ────────────────────────────────────────────────────────────

const registerSchema = z.object({
  body: z.object({
    serial:     z.string().trim().min(1).max(120),
    label:      z.string().trim().min(1).max(200),
    kind:       z.enum(CAMERA_KINDS).optional(),
    vendor:     z.string().trim().max(120).optional(),
    model:      z.string().trim().max(120).optional(),
    hwRevision: z.string().trim().max(40).optional(),
    teamId:     z.string().uuid().nullable().optional(),
    metadata:   z.any().optional(),
  }),
});

export async function registerCamera(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = registerSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await registry.registerCamera(actorOf(req), parsed.data.body);
    return sendCreated(res, out, 'Camera registered — copy hmacSecretPlaintext to the edge node immediately. It will not be shown again.');
  } catch (err) { return next(err); }
}

const listSchema = z.object({
  query: z.object({
    kind:   z.enum(CAMERA_KINDS).optional(),
    status: z.enum(CAMERA_STATUS).optional(),
    teamId: z.string().uuid().optional(),
    page:   z.coerce.number().int().min(1).max(10_000).optional(),
    limit:  z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function listCameras(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await registry.listCameras(actorOf(req), parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getCamera(req: Request, res: Response, next: NextFunction) {
  try {
    const c = await registry.getCamera(actorOf(req), req.params.id);
    return sendSuccess(res, c);
  } catch (err) { return next(err); }
}

export async function retireCamera(req: Request, res: Response, next: NextFunction) {
  try {
    const c = await registry.retireCamera(actorOf(req), req.params.id);
    return sendSuccess(res, c, 'Camera retired');
  } catch (err) { return next(err); }
}

// ── Calibration ─────────────────────────────────────────────────────────

const calibSchema = z.object({
  body: z.object({
    intrinsics:          z.any(),
    extrinsics:          z.any(),
    frameOfReference:    z.string().trim().max(60).optional(),
    reprojectionErrorPx: z.number().min(0).max(100).optional(),
  }).refine((v) => v.intrinsics !== undefined && v.extrinsics !== undefined, { message: 'intrinsics + extrinsics required' }),
});

export async function applyCalibration(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = calibSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const out = await registry.applyCalibration(actorOf(req), req.params.id, {
      intrinsics: body.intrinsics as never,
      extrinsics: body.extrinsics as never,
      frameOfReference:    body.frameOfReference,
      reprojectionErrorPx: body.reprojectionErrorPx,
    });
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function getCalibration(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await registry.getActiveCalibration(req.params.id);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

// ── Frame ingest (HMAC) ─────────────────────────────────────────────────

const ingestSchema = z.object({
  body: z.object({
    cameraTsUs:         z.number().int().min(0),
    detections:         z.any(),
    kind:               z.string().trim().max(40).optional(),
    matchId:            z.string().uuid().nullable().optional(),
    calibrationVersion: z.number().int().min(1).optional(),
    sigB64:             z.string().trim().min(8).max(512),
    nonce:              z.string().trim().min(8).max(128),
  }).refine((v) => v.detections !== undefined, { message: 'detections required' }),
});

export async function ingestFrame(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = ingestSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const row = await ingest.ingestVisionFrame(req.params.id, {
      cameraTsUs:         body.cameraTsUs,
      detections:         body.detections as never,
      kind:               body.kind,
      matchId:            body.matchId,
      calibrationVersion: body.calibrationVersion,
      sigB64:             body.sigB64,
      nonce:              body.nonce,
    });
    return sendCreated(res, { id: row.id, monotonicMs: row.monotonicMs.toString(), kind: row.kind });
  } catch (err) { return next(err); }
}

export async function listFrames(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await ingest.listVisionFrames(req.params.id, req.user!.clubId, {
      fromMs:   typeof req.query.fromMs   === 'string' ? parseInt(req.query.fromMs, 10)   : undefined,
      toMs:     typeof req.query.toMs     === 'string' ? parseInt(req.query.toMs, 10)     : undefined,
      cameraId: typeof req.query.cameraId === 'string' ? req.query.cameraId               : undefined,
      limit:    typeof req.query.limit    === 'string' ? parseInt(req.query.limit, 10)    : undefined,
    });
    return sendSuccess(res, out.map((r) => ({ ...r, monotonicMs: r.monotonicMs.toString(), cameraTsUs: r.cameraTsUs.toString() })));
  } catch (err) { return next(err); }
}

// ── Sport directory ─────────────────────────────────────────────────────

export async function listSportAdapters(_req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, listSports()); }
  catch (err) { return next(err); }
}
