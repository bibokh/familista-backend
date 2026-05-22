// Familista — Neuromorphic Event Stream service (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// Lifecycle:
//   1. POST /neuro/streams           → openStream(cameraId, sessionRef, matchId?)
//   2. POST /neuro/streams/:id/event-batch  → ingest (HMAC-verified)
//      Each batch carries up to 5_000 events; one DB row regardless.
//   3. POST /neuro/streams/:id/close → closeStream
//
// Security:
//   - HMAC verified against Camera.hmacSecret (Phase G)
//   - Nonce replay protection (Phase I device-nonce LRU)
//   - 5-min ts skew gate
// Tenant gate:
//   - Camera.clubId === actor.clubId
//
// Append-only — no batches mutated post-write.

import { createHash } from 'crypto';
import { EventCameraStream, Prisma, VisionEventBatch, VisionStreamStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError, UnauthorizedError } from '../utils/errors';
import { verifyCameraHmac } from './camera-registry.service';
import { assertFreshAndRemember } from '../security/device-nonce.service';
import { logDeviceSecurityEvent } from '../security/security-event.service';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import type { IngestEventBatchEnvelope } from './neuromorphic-types';
import { logger } from '../utils/logger';

const MAX_EVENTS_PER_BATCH = 5_000;
const TS_SKEW_LIMIT_MS     = 5 * 60_000;

export interface EventStreamActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────
// Open / list / close streams
// ─────────────────────────────────────────────────────────────────────────

export interface OpenStreamDto {
  cameraId:   string;
  sessionRef: string;
  matchId?:   string | null;
  metadata?:  Prisma.InputJsonValue;
}

export async function openStream(actor: EventStreamActor, dto: OpenStreamDto): Promise<EventCameraStream> {
  if (!dto.cameraId || !dto.sessionRef) throw new BadRequestError('cameraId + sessionRef required');
  const cam = await prisma.camera.findUnique({ where: { id: dto.cameraId }, select: { id: true, clubId: true, status: true } });
  if (!cam)                                                       throw new NotFoundError('Camera');
  if (cam.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (cam.status === 'RETIRED' || cam.status === 'OFFLINE')        throw new ForbiddenError('Camera retired/offline');

  // If a row already exists for (cameraId, sessionRef) — return it.
  const existing = await prisma.eventCameraStream.findUnique({ where: { cameraId_sessionRef: { cameraId: dto.cameraId, sessionRef: dto.sessionRef } } });
  if (existing) return existing;

  const row = await prisma.eventCameraStream.create({
    data: {
      clubId:     actor.clubId,
      cameraId:   dto.cameraId,
      sessionRef: dto.sessionRef,
      matchId:    dto.matchId ?? null,
      status:     'ACTIVE',
      metadata:   (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
  appendAuditEventAsync({
    actor:      { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action:     'NEURO_STREAM_OPENED',
    entityType: 'EventCameraStream',
    entityId:   row.id,
    payload:    { cameraId: dto.cameraId, sessionRef: dto.sessionRef, matchId: dto.matchId ?? null },
  });
  return row;
}

export async function closeStream(actor: EventStreamActor, id: string): Promise<EventCameraStream> {
  const s = await prisma.eventCameraStream.findUnique({ where: { id } });
  if (!s)                                                       throw new NotFoundError('EventCameraStream');
  if (s.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (s.closedAt) return s;
  const closed = await prisma.eventCameraStream.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
  appendAuditEventAsync({
    actor:      { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action:     'NEURO_STREAM_CLOSED',
    entityType: 'EventCameraStream',
    entityId:   id,
    payload:    { packetsTotal: Number(s.packetsTotal), eventsTotal: Number(s.eventsTotal) },
  });
  return closed;
}

export async function listStreams(actor: EventStreamActor, opts: { matchId?: string; status?: VisionStreamStatus; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.EventCameraStreamWhereInput = {
    clubId: actor.clubId,
    ...(opts.matchId ? { matchId: opts.matchId } : {}),
    ...(opts.status  ? { status: opts.status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.eventCameraStream.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.eventCameraStream.count({ where }),
  ]);
  return { items: items.map(serialiseStream), total, page, limit };
}

export async function getStream(actor: EventStreamActor, id: string): Promise<EventCameraStream> {
  const s = await prisma.eventCameraStream.findUnique({ where: { id } });
  if (!s)                                                       throw new NotFoundError('EventCameraStream');
  if (s.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return s;
}

function serialiseStream(s: EventCameraStream) {
  return { ...s, packetsTotal: s.packetsTotal.toString(), eventsTotal: s.eventsTotal.toString() };
}

// ─────────────────────────────────────────────────────────────────────────
// Ingest event batch — HMAC verified, nonce-protected, replay-safe.
// ─────────────────────────────────────────────────────────────────────────

export async function ingestEventBatch(streamId: string, env: IngestEventBatchEnvelope): Promise<VisionEventBatch> {
  if (!env || !env.sigB64 || !env.nonce || typeof env.cameraTsUs !== 'number') {
    throw new BadRequestError('cameraTsUs, sigB64, nonce required');
  }
  if (!env.payload || !Array.isArray(env.payload.events)) {
    throw new BadRequestError('payload.events required');
  }
  if (env.payload.events.length > MAX_EVENTS_PER_BATCH) {
    throw new BadRequestError(`event count exceeds cap ${MAX_EVENTS_PER_BATCH}`);
  }

  const stream = await prisma.eventCameraStream.findUnique({ where: { id: streamId } });
  if (!stream)                          throw new NotFoundError('EventCameraStream');
  if (stream.status !== 'ACTIVE')       throw new ForbiddenError('Stream not ACTIVE');

  const cam = await prisma.camera.findUnique({ where: { id: stream.cameraId } });
  if (!cam)                             throw new NotFoundError('Camera');
  if (cam.status === 'RETIRED')         throw new ForbiddenError('Camera retired');

  // HMAC verify against camera secret. Message: cameraTsUs|nonce|sha256(payload).
  const payloadJson = JSON.stringify(env.payload);
  const digest = createHash('sha256').update(payloadJson).digest('hex');
  const msg = `${env.cameraTsUs}.${env.nonce}.${digest}`;
  if (!verifyCameraHmac(cam.hmacSecret, msg, env.sigB64)) {
    logDeviceSecurityEvent({ kind: 'DEVICE_REJECTED', severity: 'CRITICAL', clubId: cam.clubId, cameraId: cam.id, payload: { reason: 'hmac_mismatch' } });
    throw new ForbiddenError('Invalid camera signature');
  }
  // Nonce replay protection.
  if (!assertFreshAndRemember(`cam-event:${cam.id}`, env.nonce)) {
    logDeviceSecurityEvent({ kind: 'DEVICE_REPLAY', severity: 'CRITICAL', clubId: cam.clubId, cameraId: cam.id, payload: { reason: 'nonce_reused' } });
    throw new UnauthorizedError('Nonce already used');
  }
  // TS skew gate (camera μs → ms vs server).
  const nowMs    = Date.now();
  const cameraMs = Math.round(env.cameraTsUs / 1000);
  if (Math.abs(nowMs - cameraMs) > TS_SKEW_LIMIT_MS) {
    logDeviceSecurityEvent({ kind: 'DEVICE_TS_SKEW', severity: 'WARN', clubId: cam.clubId, cameraId: cam.id, payload: { skewMs: nowMs - cameraMs } });
    throw new ForbiddenError('Camera clock skew exceeds 5 min');
  }

  const eventCount = env.payload.events.length;
  const monotonicMs = BigInt(nowMs);

  // Insert + bump aggregate counters in one transaction (cheap).
  const [row] = await prisma.$transaction([
    prisma.visionEventBatch.create({
      data: {
        streamId:    stream.id,
        clubId:      stream.clubId,
        matchId:     env.matchId ?? stream.matchId,
        monotonicMs,
        cameraTsUs:  BigInt(Math.round(env.cameraTsUs)),
        kind:        env.kind ?? 'AGGREGATED',
        events:      env.payload as unknown as Prisma.InputJsonValue,
        eventCount,
        sigB64:      env.sigB64,
        nonce:       env.nonce,
      },
    }),
    prisma.eventCameraStream.update({
      where: { id: stream.id },
      data: {
        packetsTotal: { increment: BigInt(1) },
        eventsTotal:  { increment: BigInt(eventCount) },
      },
    }),
  ]);

  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Read batches
// ─────────────────────────────────────────────────────────────────────────

export async function listBatches(actor: EventStreamActor, streamId: string, opts: { fromMs?: number; toMs?: number; limit?: number } = {}) {
  const s = await getStream(actor, streamId);
  return prisma.visionEventBatch.findMany({
    where: {
      streamId: s.id,
      ...(opts.fromMs ? { monotonicMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs   ? { monotonicMs: { lte: BigInt(opts.toMs) } }   : {}),
    },
    orderBy: { monotonicMs: 'asc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  }).then((rows) => rows.map((r) => ({ ...r, monotonicMs: r.monotonicMs.toString(), cameraTsUs: r.cameraTsUs.toString() })));
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp sync (anchor + active-version lookup)
// ─────────────────────────────────────────────────────────────────────────

export interface RegisterSyncDto {
  cameraId:   string;
  sessionRef: string;
  deviceUs:   number;
  jitterMs?:  number;
}

export async function registerSync(actor: EventStreamActor, dto: RegisterSyncDto) {
  const cam = await prisma.camera.findUnique({ where: { id: dto.cameraId }, select: { clubId: true } });
  if (!cam || (cam.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();

  // Deactivate prior active anchors for this (camera, sessionRef).
  await prisma.visionTimestampSync.updateMany({
    where: { cameraId: dto.cameraId, sessionRef: dto.sessionRef, isActive: true },
    data:  { isActive: false },
  });

  // Determine the next version atomically.
  const last = await prisma.visionTimestampSync.findFirst({
    where:   { cameraId: dto.cameraId, sessionRef: dto.sessionRef },
    orderBy: { version: 'desc' },
    select:  { version: true },
  });
  const version    = (last?.version ?? 0) + 1;
  const serverRxMs = BigInt(Date.now());
  const deviceMs   = Math.round(dto.deviceUs / 1000);
  const skewMs     = Number(serverRxMs) - deviceMs;

  const row = await prisma.visionTimestampSync.create({
    data: {
      cameraId:   dto.cameraId,
      sessionRef: dto.sessionRef,
      deviceUs:   BigInt(Math.round(dto.deviceUs)),
      serverRxMs,
      skewMs,
      jitterMs:   dto.jitterMs ?? null,
      version,
      isActive:   true,
    },
  });
  return { ...row, deviceUs: row.deviceUs.toString(), serverRxMs: row.serverRxMs.toString() };
}

export async function activeSync(cameraId: string, sessionRef: string) {
  const s = await prisma.visionTimestampSync.findFirst({
    where:   { cameraId, sessionRef, isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!s) return null;
  return { ...s, deviceUs: s.deviceUs.toString(), serverRxMs: s.serverRxMs.toString() };
}

/** Convert device μs → global server ms using the active sync anchor. */
export async function globalMsFor(cameraId: string, sessionRef: string, deviceUs: number): Promise<number | null> {
  const s = await prisma.visionTimestampSync.findFirst({
    where:   { cameraId, sessionRef, isActive: true },
    orderBy: { version: 'desc' },
    select:  { deviceUs: true, serverRxMs: true },
  });
  if (!s) return null;
  const baseDeviceMs = Number(s.deviceUs) / 1000;
  const baseServerMs = Number(s.serverRxMs);
  const deltaMs      = deviceUs / 1000 - baseDeviceMs;
  return Math.round(baseServerMs + deltaMs);
}
