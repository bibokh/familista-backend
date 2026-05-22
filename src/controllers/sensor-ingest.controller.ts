// Familista — Match-scoped sensor packet aliases (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// Accept sensor/fusion packets keyed by matchId so callers without an
// explicit deviceSessionId can still ingest. We resolve an OPEN matching
// session under the caller's tenant scope, or 404 if there isn't one.
//
// This is a thin wrapper over device-session.service.ingestPacket — all
// ownership/tenant checks still happen there.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { sendCreated } from '../utils/response';
import { BadRequestError, NotFoundError } from '../utils/errors';
import * as ds from '../services/device-session.service';
import { publishFusionPacket, publishSensorPacket } from '../big-data/publisher';
import { evaluateAsync } from '../services/rules-engine.service';

const SENSOR_KIND = [
  'GPS','IMU','ECG','HEART_RATE','HEALTH_BUNDLE','EVENT','VISION_FRAME','TURF_NODE','POWER','DIAGNOSTIC',
] as const;

const packetSchema = z.object({
  body: z.object({
    kind:           z.enum(SENSOR_KIND),
    capturedAt:     z.string(),
    payload:        z.any(),
    sigB64:         z.string().optional(),
    // Optional explicit override; otherwise we resolve the open session.
    deviceSessionId: z.string().uuid().optional(),
  }).refine((v) => v.payload !== undefined, { message: 'payload is required', path: ['payload'] }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || 'body'}: ${e.message}`).join(', '),
  );
}

async function resolveSession(matchId: string, clubId: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const session = await prisma.deviceSession.findFirst({
    where:   { clubId, matchId, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select:  { id: true },
  });
  if (!session) {
    throw new NotFoundError('No open device session for this match — open a session first or pass deviceSessionId');
  }
  return session.id;
}

function actorOf(req: Request): ds.DeviceSessionActor {
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

export async function ingestMatchSensorPacket(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = packetSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const { deviceSessionId, ...packet } = parsed.data.body;
    const sessionId = await resolveSession(req.params.id, req.user!.clubId, deviceSessionId);
    const row = await ds.ingestPacket(actorOf(req), sessionId, packet as ds.IngestPacketDto);
    // Big-data fan-out + rules eval (best-effort).
    publishSensorPacket(req.user!.clubId, req.params.id, { sessionId, packet });
    evaluateAsync(req.params.id, req.user!.clubId);
    return sendCreated(res, row);
  } catch (err) { return next(err); }
}

/**
 * Fusion-packet alias — accepts the FusionPacket envelope shape but
 * stores it as a SensorPacket of `kind=EVENT` with the envelope in
 * payload. This lets the Phase D-IP TS engine stream pre-fused values
 * without a separate table.
 */
const fusionEnvelopeSchema = z.object({
  body: z.object({
    kind:            z.enum(SENSOR_KIND).default('EVENT'),
    capturedAt:      z.string(),
    payload:         z.any(),
    sigB64:          z.string().optional(),
    deviceSessionId: z.string().uuid().optional(),
  }).refine((v) => v.payload !== undefined, { message: 'payload is required', path: ['payload'] }),
});

export async function ingestMatchFusionPacket(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = fusionEnvelopeSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const { deviceSessionId, ...packet } = parsed.data.body;
    const sessionId = await resolveSession(req.params.id, req.user!.clubId, deviceSessionId);
    const row = await ds.ingestPacket(actorOf(req), sessionId, packet as ds.IngestPacketDto);
    publishFusionPacket(req.user!.clubId, req.params.id, { sessionId, packet });
    evaluateAsync(req.params.id, req.user!.clubId);
    return sendCreated(res, row);
  } catch (err) { return next(err); }
}
