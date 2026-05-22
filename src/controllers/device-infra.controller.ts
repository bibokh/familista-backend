// Familista — Device Infrastructure controllers (Phase F)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as registry    from '../services/device-registry.service';
import * as firmware    from '../services/firmware.service';
import * as calibration from '../services/calibration.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const DEVICE_MODELS = ['FAMILISTA_WEARABLE_V1','FAMILISTA_TURF_NODE_V1','FAMILISTA_AI_CAM_V1','FAMILISTA_SMART_BALL_V1','OTHER'] as const;
const PROV_STATUS = ['REGISTERED','PROVISIONED','ACTIVE','RETIRED','REVOKED'] as const;

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

function actorOf(req: Request): registry.DeviceActor {
  if (!req.user) throw new BadRequestError('Auth context missing');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role };
}

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  body: z.object({
    serial:     z.string().trim().min(1).max(120),
    model:      z.enum(DEVICE_MODELS),
    hwRevision: z.string().trim().max(40).optional(),
    teamId:     z.string().uuid().nullable().optional(),
    notes:      z.string().trim().max(2000).optional(),
    metadata:   z.any().optional(),
  }),
});

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = registerSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await registry.registerDevice(actorOf(req), parsed.data.body);
    // hmacSecretPlaintext is in the response ONCE — caller MUST burn into device.
    return sendCreated(res, out, 'Device registered — copy hmacSecretPlaintext to the PCB immediately. It will not be shown again.');
  } catch (err) { return next(err); }
}

const activateSchema = z.object({
  body: z.object({
    efuseFingerprint: z.string().trim().min(8).max(256),
    sig:              z.string().trim().min(8).max(512),
    ts:               z.number().int().min(0),
    nonce:            z.string().trim().min(16).max(128),
  }),
});

export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = activateSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const d = await registry.activateDevice(req.params.serial, parsed.data.body);
    // Echo without the hmacSecret.
    const { hmacSecret: _omit, ...safe } = d as unknown as Record<string, unknown>;
    return sendSuccess(res, safe, 'Device activated');
  } catch (err) { return next(err); }
}

const listSchema = z.object({
  query: z.object({
    model:  z.enum(DEVICE_MODELS).optional(),
    status: z.enum(PROV_STATUS).optional(),
    teamId: z.string().uuid().optional(),
    page:   z.coerce.number().int().min(1).max(10_000).optional(),
    limit:  z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await registry.listDevices(actorOf(req), parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const d = await registry.getDevice(actorOf(req), req.params.id);
    return sendSuccess(res, d);
  } catch (err) { return next(err); }
}

export async function retire(req: Request, res: Response, next: NextFunction) {
  try {
    const d = await registry.retireDevice(actorOf(req), req.params.id);
    return sendSuccess(res, d, 'Device retired');
  } catch (err) { return next(err); }
}

export async function revoke(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const d = await registry.revokeDevice(actorOf(req), req.params.id, reason);
    return sendSuccess(res, d, 'Device revoked');
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Firmware (OTA)
// ─────────────────────────────────────────────────────────────────────────

const fwCheckSchema = z.object({
  query: z.object({
    channel:    z.string().trim().max(40).optional(),
    currentVer: z.string().trim().max(40).optional(),
  }),
});

export async function fwCheck(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = fwCheckSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await firmware.checkFirmware(req.params.id, parsed.data.query);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

const fwPublishSchema = z.object({
  body: z.object({
    model:       z.enum(DEVICE_MODELS),
    channel:     z.string().trim().min(1).max(40).optional(),
    version:     z.string().trim().min(3).max(40),
    sha256:      z.string().trim().length(64),
    downloadUrl: z.string().trim().url().max(800),
    minHwRev:    z.string().trim().max(40).nullable().optional(),
    notes:       z.string().trim().max(2000).optional(),
  }),
});

export async function fwPublish(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = fwPublishSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const f = await firmware.publishFirmware({ ...parsed.data.body, publishedBy: req.user!.id });
    return sendCreated(res, f, 'Firmware published');
  } catch (err) { return next(err); }
}

export async function fwList(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await firmware.listFirmware({
      model:   typeof req.query.model   === 'string' ? req.query.model   : undefined,
      channel: typeof req.query.channel === 'string' ? req.query.channel : undefined,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Calibration
// ─────────────────────────────────────────────────────────────────────────

const calibSchema = z.object({
  body: z.object({
    sensorKind: z.string().trim().min(1).max(60),
    payload:    z.any(),
    notes:      z.string().trim().max(2000).optional(),
  }).refine((v) => v.payload !== undefined, { message: 'payload is required', path: ['payload'] }),
});

export async function calibrationApply(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = calibSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const out = await calibration.applyCalibration(actorOf(req), req.params.id, { ...body, payload: body.payload });
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function calibrationGet(req: Request, res: Response, next: NextFunction) {
  try {
    const kind = typeof req.query.sensorKind === 'string' ? req.query.sensorKind : undefined;
    const out = await calibration.getActiveCalibration(req.params.id, kind);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

export async function calibrationHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const kind = typeof req.query.sensorKind === 'string' ? req.query.sensorKind : undefined;
    const out = await calibration.listCalibrationHistory(req.params.id, kind);
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}
