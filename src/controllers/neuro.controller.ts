// Familista — Phase K controller (neuromorphic vision + tactical engine).

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as streams   from '../vision/event-stream.service';
import * as rigs      from '../vision/camera-rig.service';
import * as edge      from '../vision/edge-vision-runtime.service';
import * as tactical  from '../vision/visual-tactical-engine';
import * as biomech   from '../vision/biomechanical-ingest.service';
import { neuroMetricSnapshot, NEURO_METRICS_VERSION } from '../vision/neuro-metrics';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const SUBJECT_KINDS = ['PLAYER','BALL','OBJECT','UNKNOWN'] as const;
const RIG_ROLES     = ['CORNER','FENCE','OVERHEAD','WEARABLE','PANORAMIC','AERIAL','GENERIC'] as const;
const RT_STATUS     = ['PROVISIONED','ACTIVE','DEGRADED','OFFLINE','RETIRED'] as const;
const STREAM_STATUS = ['ACTIVE','PAUSED','CLOSED'] as const;

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '));
}
function actor<A>(req: Request): A {
  if (!req.user) throw new BadRequestError('auth');
  return { userId: req.user.id, clubId: req.user.clubId, role: req.user.role } as unknown as A;
}

// ── Event streams ──────────────────────────────────────────────────────

const openStreamSchema = z.object({
  body: z.object({
    cameraId:   z.string().uuid(),
    sessionRef: z.string().trim().min(1).max(200),
    matchId:    z.string().uuid().nullable().optional(),
    metadata:   z.any().optional(),
  }),
});

export async function openStream(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = openStreamSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await streams.openStream(actor(req), parsed.data.body);
    return sendCreated(res, { ...out, packetsTotal: out.packetsTotal.toString(), eventsTotal: out.eventsTotal.toString() });
  } catch (err) { return next(err); }
}

const listStreamsSchema = z.object({
  query: z.object({
    matchId: z.string().uuid().optional(),
    status:  z.enum(STREAM_STATUS).optional(),
    page:    z.coerce.number().int().min(1).max(10_000).optional(),
    limit:   z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function listStreams(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listStreamsSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await streams.listStreams(actor(req), parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function closeStream(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await streams.closeStream(actor(req), req.params.id);
    return sendSuccess(res, { ...out, packetsTotal: out.packetsTotal.toString(), eventsTotal: out.eventsTotal.toString() });
  } catch (err) { return next(err); }
}

const eventBatchSchema = z.object({
  body: z.object({
    cameraTsUs: z.number().int().min(0),
    kind:       z.enum(['RAW','AGGREGATED','DOWNSAMPLED']).optional(),
    payload:    z.any(),
    sigB64:     z.string().trim().min(8).max(512),
    nonce:      z.string().trim().min(8).max(128),
    matchId:    z.string().uuid().nullable().optional(),
  }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }),
});

export async function ingestEventBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = eventBatchSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const out = await streams.ingestEventBatch(req.params.id, {
      cameraTsUs: body.cameraTsUs,
      kind:       body.kind,
      payload:    body.payload as never,
      sigB64:     body.sigB64,
      nonce:      body.nonce,
      matchId:    body.matchId,
    });
    return sendCreated(res, { id: out.id, monotonicMs: out.monotonicMs.toString(), eventCount: out.eventCount });
  } catch (err) { return next(err); }
}

export async function listBatches(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await streams.listBatches(actor(req), req.params.id, {
      fromMs: typeof req.query.fromMs === 'string' ? parseInt(req.query.fromMs, 10) : undefined,
      toMs:   typeof req.query.toMs   === 'string' ? parseInt(req.query.toMs, 10)   : undefined,
      limit:  typeof req.query.limit  === 'string' ? parseInt(req.query.limit, 10)  : undefined,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

const syncSchema = z.object({
  body: z.object({
    cameraId:   z.string().uuid(),
    sessionRef: z.string().trim().min(1).max(200),
    deviceUs:   z.number().int().min(0),
    jitterMs:   z.number().min(0).optional(),
  }),
});

export async function registerSync(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = syncSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await streams.registerSync(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

// ── Camera rigs ────────────────────────────────────────────────────────

const createRigSchema = z.object({
  body: z.object({
    label:        z.string().trim().min(1).max(200),
    syncStrategy: z.enum(['NTP','PTP','EVENT_BEACON','MANUAL']).optional(),
    geometry:     z.any().optional(),
    metadata:     z.any().optional(),
  }),
});

export async function createRig(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createRigSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await rigs.createRig(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function listRigs(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await rigs.listRigs(actor(req))); }
  catch (err) { return next(err); }
}

export async function getRig(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await rigs.getRig(actor(req), req.params.id)); }
  catch (err) { return next(err); }
}

const addMemberSchema = z.object({
  body: z.object({
    cameraId: z.string().uuid(),
    role:     z.enum(RIG_ROLES).optional(),
    position: z.any().optional(),
  }),
});

export async function addRigMember(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = addMemberSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await rigs.addMember(actor(req), req.params.id, parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function removeRigMember(req: Request, res: Response, next: NextFunction) {
  try {
    await rigs.removeMember(actor(req), req.params.id, req.params.memberId);
    return res.status(204).end();
  } catch (err) { return next(err); }
}

const startSyncSchema = z.object({
  body: z.object({
    matchId:    z.string().uuid().nullable().optional(),
    anchorTsUs: z.number().int().min(0).optional(),
    skews:      z.any().optional(),
  }),
});

export async function startSyncSession(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = startSyncSchema.safeParse({ body: req.body ?? {} });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await rigs.startSyncSession(actor(req), req.params.id, parsed.data.body as never);
    return sendCreated(res, { ...out, anchorTsUs: out.anchorTsUs?.toString() ?? null });
  } catch (err) { return next(err); }
}

const obsSchema = z.object({
  body: z.object({
    monotonicMs: z.number().int().min(0),
    subjectKind: z.enum(SUBJECT_KINDS),
    subjectId:   z.string().nullable().optional(),
    detections:  z.array(z.object({
      cameraId:  z.string(),
      x:         z.number(),
      y:         z.number(),
      z:         z.number().optional(),
      confidence: z.number().min(0).max(1),
      homography: z.array(z.number()).length(9).optional(),
      playerId:  z.string().optional(),
    })).min(1).max(16),
  }),
});

export async function recordObservation(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = obsSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await rigs.recordObservation(actor(req), {
      syncSessionId: req.params.sessionId,
      ...parsed.data.body,
    });
    return sendCreated(res, {
      observation: { ...out.observation, monotonicMs: out.observation.monotonicMs.toString() },
      triangulation: out.triangulation ? { ...out.triangulation, monotonicMs: out.triangulation.monotonicMs.toString() } : null,
    });
  } catch (err) { return next(err); }
}

// ── Edge vision runtime ────────────────────────────────────────────────

const provisionRtSchema = z.object({
  body: z.object({
    label:      z.string().trim().min(1).max(200),
    edgeNodeId: z.string().uuid().optional(),
    cameraId:   z.string().uuid().optional(),
    fwVersion:  z.string().trim().max(40).optional(),
    os:         z.string().trim().max(60).optional(),
    hwClass:    z.string().trim().max(60).optional(),
    metadata:   z.any().optional(),
  }),
});

export async function provisionRuntime(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = provisionRtSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await edge.provisionRuntime(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

export async function listRuntimes(req: Request, res: Response, next: NextFunction) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status as typeof RT_STATUS[number] : undefined;
    const out = await edge.listRuntimes(actor(req), { status: status as never });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

const publishManifestSchema = z.object({
  body: z.object({
    code:        z.string().trim().min(1).max(120),
    label:       z.string().trim().min(1).max(200),
    family:      z.string().trim().min(1).max(40),
    description: z.string().trim().max(2000).optional(),
  }),
});

export async function publishManifest(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = publishManifestSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await edge.publishManifest(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

const publishVersionSchema = z.object({
  body: z.object({
    manifestCode: z.string().trim().min(1).max(120),
    version:      z.string().trim().min(3).max(40),
    sha256:       z.string().trim().length(64),
    sizeBytes:    z.number().int().min(0).optional(),
    downloadUrl:  z.string().trim().url().max(800).optional(),
  }),
});

export async function publishModelVersion(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = publishVersionSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await edge.publishModelVersion(actor(req), parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

const inferenceSchema = z.object({
  body: z.object({
    matchId:        z.string().uuid().nullable().optional(),
    cameraId:       z.string().uuid().nullable().optional(),
    modelVersionId: z.string().uuid().nullable().optional(),
    monotonicMs:    z.number().int().min(0).optional(),
    kind:           z.string().trim().min(1).max(60),
    payload:        z.any(),
    confidence:     z.number().min(0).max(1).optional(),
    latencyMs:      z.number().int().min(0).optional(),
    sigB64:         z.string().optional(),
    nonce:          z.string().optional(),
  }).refine((v) => v.payload !== undefined, { message: 'payload required', path: ['payload'] }),
});

export async function recordInference(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = inferenceSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await edge.recordInference(actor(req), req.params.id, {
      ...parsed.data.body,
      payload: parsed.data.body.payload as never,
    });
    return sendCreated(res, { ...out, monotonicMs: out.monotonicMs.toString() });
  } catch (err) { return next(err); }
}

const healthSchema = z.object({
  body: z.object({
    score:           z.number().min(0).max(1),
    latencyP95Ms:    z.number().int().min(0).optional(),
    jobsPerMin:      z.number().min(0).optional(),
    failuresPerMin:  z.number().min(0).optional(),
  }),
});

export async function recordRuntimeHealth(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = healthSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await edge.recordHealth(actor(req), req.params.id, parsed.data.body);
    return sendCreated(res, out);
  } catch (err) { return next(err); }
}

// ── Tactical detectors ─────────────────────────────────────────────────

export async function runTacticalDetector(req: Request, res: Response, next: NextFunction) {
  try {
    const kind = String(req.params.kind || '').toUpperCase();
    const monotonicMs = typeof req.query.monotonicMs === 'string' ? parseInt(req.query.monotonicMs, 10) : undefined;
    const a = actor<tactical.TacticalActor>(req);
    switch (kind) {
      case 'FORMATION':            return sendSuccess(res, await tactical.detectFormation(a, req.params.id, monotonicMs));
      case 'PRESSING':             return sendSuccess(res, await tactical.detectPressing(a, req.params.id, monotonicMs));
      case 'DEFENSIVE_LINE':       return sendSuccess(res, await tactical.detectDefensiveLine(a, req.params.id, monotonicMs));
      case 'OVERLOAD_ZONE':        return sendSuccess(res, await tactical.detectOverloadZones(a, req.params.id, monotonicMs));
      case 'SPACE_CREATION':       return sendSuccess(res, await tactical.detectSpaceCreation(a, req.params.id, monotonicMs));
      case 'TRANSITION_MOMENT':    return sendSuccess(res, await tactical.detectTransitionMoment(a, req.params.id, monotonicMs));
      case 'COUNTERATTACK':        return sendSuccess(res, await tactical.detectCounterattack(a, req.params.id, monotonicMs));
      case 'POSITIONAL_COLLAPSE':  return sendSuccess(res, await tactical.detectPositionalCollapse(a, req.params.id, monotonicMs));
      case 'PATTERN':              return sendSuccess(res, await tactical.detectPattern(a, req.params.id, monotonicMs));
      default: throw new BadRequestError(`Unknown detector kind: ${kind}`);
    }
  } catch (err) { return next(err); }
}

// ── Biomechanical packet ingest ────────────────────────────────────────

const biomechSchema = z.object({
  body: z.object({
    payload: z.object({
      deviceTsMs:    z.number().int().min(0),
      lactateMmol:   z.number().optional(),
      glucoseMg:     z.number().optional(),
      hydrationPct:  z.number().optional(),
      cortisolProxy: z.number().optional(),
      extra:         z.any().optional(),
    }),
    playerId: z.string().uuid().nullable().optional(),
    matchId:  z.string().uuid().nullable().optional(),
    sigB64:   z.string().optional(),
    nonce:    z.string().optional(),
  }),
});

export async function ingestBiomech(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = biomechSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await biomech.ingestBiomechPacket(actor(req), req.params.deviceId, parsed.data.body);
    return sendCreated(res, { ...out, monotonicMs: out.monotonicMs.toString(), deviceTsMs: out.deviceTsMs.toString() });
  } catch (err) { return next(err); }
}

export async function listBiomech(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await biomech.listBiomechPackets(actor(req), {
      matchId:  typeof req.query.matchId  === 'string' ? req.query.matchId  : undefined,
      playerId: typeof req.query.playerId === 'string' ? req.query.playerId : undefined,
      deviceId: typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined,
      fromMs:   typeof req.query.fromMs   === 'string' ? parseInt(req.query.fromMs, 10) : undefined,
      toMs:     typeof req.query.toMs     === 'string' ? parseInt(req.query.toMs, 10)   : undefined,
      limit:    typeof req.query.limit    === 'string' ? parseInt(req.query.limit, 10)  : undefined,
    });
    return sendSuccess(res, out);
  } catch (err) { return next(err); }
}

// ── Metric snapshot (pure-function demo route) ─────────────────────────

const snapshotSchema = z.object({
  body: z.object({
    motion:    z.any(),
    reaction:  z.any(),
    visual:    z.any(),
    pressure:  z.any(),
    collapse:  z.any(),
    transition: z.any(),
    defense:    z.any(),
    synchrony:  z.any(),
  }),
});

export async function metricsSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = snapshotSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const out = neuroMetricSnapshot(parsed.data.body as never);
    return sendSuccess(res, { version: NEURO_METRICS_VERSION, metrics: out });
  } catch (err) { return next(err); }
}
