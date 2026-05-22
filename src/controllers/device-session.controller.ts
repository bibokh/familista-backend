// Familista — Device Session + Sensor Packet controller (Phase B)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/device-session.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const SENSOR_KIND = ['GPS','IMU','ECG','HEART_RATE','HEALTH_BUNDLE','EVENT','VISION_FRAME','TURF_NODE','POWER','DIAGNOSTIC'] as const;
const DEVICE_MODELS = [
  'FAMILISTA_WEARABLE_V1',
  'FAMILISTA_TURF_NODE_V1',
  'FAMILISTA_AI_CAM_V1',
  'FAMILISTA_SMART_BALL_V1',
  'OTHER',
] as const;

const openSchema = z.object({
  body: z.object({
    teamId:           z.string().uuid().nullable().optional(),
    matchId:          z.string().uuid().nullable().optional(),
    trainingSessionId: z.string().uuid().nullable().optional(),
    deviceModel:      z.enum(DEVICE_MODELS),
    deviceSerial:     z.string().trim().min(1).max(120),
    edgeFwVersion:    z.string().trim().max(40).optional(),
    metadata:         z.any().optional(),
  }),
});

const packetSchema = z.object({
  kind:       z.enum(SENSOR_KIND),
  capturedAt: z.string(),
  payload:    z.any(),
  sigB64:     z.string().optional(),
});

const ingestOneSchema   = z.object({ body: packetSchema });
const ingestBatchSchema = z.object({ body: z.object({ packets: z.array(packetSchema).min(1).max(500) }) });

const listQuerySchema = z.object({
  query: z.object({
    deviceModel: z.enum(DEVICE_MODELS).optional(),
    teamId:      z.string().uuid().optional(),
    matchId:     z.string().uuid().optional(),
    activeOnly:  z.enum(['true','false']).optional(),
    page:        z.coerce.number().int().min(1).max(10_000).optional(),
    limit:       z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const packetsQuerySchema = z.object({
  query: z.object({
    kind:  z.enum(SENSOR_KIND).optional(),
    from:  z.string().optional(),
    to:    z.string().optional(),
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

function actorOf(req: Request): svc.DeviceSessionActor {
  if (!req.user) throw new BadRequestError('Authentication context missing');
  const xff = req.headers['x-forwarded-for'];
  const ip  = typeof xff === 'string' ? xff.split(',')[0]?.trim() : req.ip;
  return {
    userId:    req.user.id,
    clubId:    req.user.clubId,
    ipAddress: ip ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
  };
}

function parseDateMaybe(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Sessions ─────────────────────────────────────────────────────────────

export async function openSession(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = openSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const session = await svc.openSession(actorOf(req), parsed.data.body);
    // Echo the sessionKey ONCE on creation — caller must persist it on the device.
    return sendCreated(res, session, 'Device session opened');
  } catch (err) { return next(err); }
}

export async function closeSession(req: Request, res: Response, next: NextFunction) {
  try {
    const s = await svc.closeSession(actorOf(req), req.params.id);
    return sendSuccess(res, s, 'Device session closed');
  } catch (err) { return next(err); }
}

export async function listSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await svc.listSessions(req.user!.clubId, {
      deviceModel: q.deviceModel,
      teamId:      q.teamId,
      matchId:     q.matchId,
      activeOnly:  q.activeOnly === 'true',
      page:        q.page,
      limit:       q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getSession(req: Request, res: Response, next: NextFunction) {
  try {
    const s = await svc.getSession(req.params.id, req.user!.clubId);
    return sendSuccess(res, s);
  } catch (err) { return next(err); }
}

// ── Sensor packets ───────────────────────────────────────────────────────

export async function ingestPacket(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = ingestOneSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const p = await svc.ingestPacket(actorOf(req), req.params.id, parsed.data.body as never);
    return sendCreated(res, p);
  } catch (err) { return next(err); }
}

export async function ingestBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = ingestBatchSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.ingestBatch(actorOf(req), req.params.id, parsed.data.body.packets as never);
    return sendCreated(res, out, `${out.accepted} packets accepted`);
  } catch (err) { return next(err); }
}

export async function listPackets(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = packetsQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const items = await svc.listPackets(req.params.id, req.user!.clubId, {
      kind:  q.kind,
      from:  parseDateMaybe(q.from),
      to:    parseDateMaybe(q.to),
      limit: q.limit,
    });
    return sendSuccess(res, items);
  } catch (err) { return next(err); }
}
