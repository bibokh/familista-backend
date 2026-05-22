// Familista — Edge Node service (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Registers and tracks edge runtimes (camera box, wearable hub, turf node,
// smart ball, biochem patch). Each EdgeNode anchors to a Phase F Device
// or Phase G Camera by id-string (no FK; deletes don't cascade).
//
// Service responsibilities:
//   - register / list / get / retire EdgeNode rows
//   - record sync windows (one row per delayed-sync flush)
//   - record edge inference results (object detect, pose, ball)
//   - track buffered telemetry chunks awaiting upload
//
// Edge runtimes themselves run OUTSIDE Render — they sync via the
// canonical Phase F device-session ingest + Phase G vision ingest endpoints.

import { CompressionStrategy, EdgeBuffer, EdgeInferenceResult, EdgeNode, EdgeNodeKind, Prisma, RegionStatus, SyncWindow } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface EdgeActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── EdgeNode lifecycle ──────────────────────────────────────────────────

export interface RegisterEdgeNodeDto {
  kind:        EdgeNodeKind;
  deviceId?:   string | null;
  cameraId?:   string | null;
  label?:      string;
  fwVersion?:  string;
  teamId?:     string | null;
  compression?: CompressionStrategy;
  metadata?:   Prisma.InputJsonValue;
}

export async function registerEdgeNode(actor: EdgeActor, dto: RegisterEdgeNodeDto): Promise<EdgeNode> {
  if (!dto.kind) throw new BadRequestError('kind required');
  // Cross-tenant safety: if deviceId/cameraId provided, verify they belong to the club.
  if (dto.deviceId) {
    const d = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
    if (!d || d.clubId !== actor.clubId) throw new ForbiddenError('Device not in club');
  }
  if (dto.cameraId) {
    const c = await prisma.camera.findUnique({ where: { id: dto.cameraId }, select: { clubId: true } });
    if (!c || c.clubId !== actor.clubId) throw new ForbiddenError('Camera not in club');
  }
  return prisma.edgeNode.create({
    data: {
      clubId:      actor.clubId,
      teamId:      dto.teamId ?? null,
      kind:        dto.kind,
      deviceId:    dto.deviceId ?? null,
      cameraId:    dto.cameraId ?? null,
      label:       dto.label ?? null,
      fwVersion:   dto.fwVersion ?? null,
      compression: dto.compression ?? 'NONE',
      metadata:    (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listEdgeNodes(actor: EdgeActor, opts: { kind?: EdgeNodeKind; status?: RegionStatus; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.EdgeNodeWhereInput = {
    clubId: actor.clubId,
    ...(opts.kind   ? { kind:   opts.kind } : {}),
    ...(opts.status ? { status: opts.status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.edgeNode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
    }),
    prisma.edgeNode.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getEdgeNode(actor: EdgeActor, id: string): Promise<EdgeNode> {
  const n = await prisma.edgeNode.findUnique({ where: { id } });
  if (!n)                                                       throw new NotFoundError('EdgeNode');
  if (n.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return n;
}

export async function retireEdgeNode(actor: EdgeActor, id: string): Promise<EdgeNode> {
  const n = await getEdgeNode(actor, id);
  return prisma.edgeNode.update({
    where: { id: n.id },
    data:  { status: 'OFFLINE' },
  });
}

// ── Sync window writer ──────────────────────────────────────────────────

export interface RecordSyncWindowDto {
  edgeNodeId:   string;
  fromMs:       number;
  toMs:         number;
  packetsTotal: number;
  packetsOk:    number;
  ok:           boolean;
  notes?:       string;
}

export async function recordSyncWindow(actor: EdgeActor, dto: RecordSyncWindowDto): Promise<SyncWindow> {
  await getEdgeNode(actor, dto.edgeNodeId);
  return prisma.$transaction(async (tx) => {
    const row = await tx.syncWindow.create({
      data: {
        edgeNodeId:   dto.edgeNodeId,
        fromMs:       BigInt(dto.fromMs),
        toMs:         BigInt(dto.toMs),
        packetsTotal: dto.packetsTotal,
        packetsOk:    dto.packetsOk,
        ok:           dto.ok,
        notes:        dto.notes ?? null,
      },
    });
    await tx.edgeNode.update({
      where: { id: dto.edgeNodeId },
      data:  { lastSyncAt: new Date() },
    });
    return row;
  });
}

export async function listSyncWindows(actor: EdgeActor, edgeNodeId: string, opts: { limit?: number } = {}): Promise<SyncWindow[]> {
  await getEdgeNode(actor, edgeNodeId);
  return prisma.syncWindow.findMany({
    where: { edgeNodeId },
    orderBy: { fromMs: 'desc' },
    take: Math.min(opts.limit ?? 50, 500),
  });
}

// ── Edge buffer (pending sync) ──────────────────────────────────────────

export interface RecordBufferDto {
  edgeNodeId:   string;
  payloadHash:  string;
  sizeBytes:    number;
  capturedAt:   number;
  packetCount?: number;
  compression?: CompressionStrategy;
}

export async function recordBuffer(actor: EdgeActor, dto: RecordBufferDto): Promise<EdgeBuffer> {
  await getEdgeNode(actor, dto.edgeNodeId);
  return prisma.edgeBuffer.create({
    data: {
      edgeNodeId:  dto.edgeNodeId,
      payloadHash: dto.payloadHash,
      sizeBytes:   dto.sizeBytes,
      capturedAt:  new Date(dto.capturedAt),
      packetCount: dto.packetCount ?? 1,
      compression: dto.compression ?? 'NONE',
    },
  });
}

export async function ackBuffer(actor: EdgeActor, id: string): Promise<EdgeBuffer> {
  const b = await prisma.edgeBuffer.findUnique({ where: { id } });
  if (!b) throw new NotFoundError('EdgeBuffer');
  await getEdgeNode(actor, b.edgeNodeId);
  return prisma.edgeBuffer.update({ where: { id }, data: { syncedAt: new Date() } });
}

// ── Edge inference results ──────────────────────────────────────────────

export interface RecordInferenceDto {
  edgeNodeId:  string;
  matchId?:    string | null;
  kind:        string;
  payload:     Prisma.InputJsonValue;
  confidence?: number;
  capturedAt:  number;
}

export async function recordInference(actor: EdgeActor, dto: RecordInferenceDto): Promise<EdgeInferenceResult> {
  await getEdgeNode(actor, dto.edgeNodeId);
  return prisma.edgeInferenceResult.create({
    data: {
      edgeNodeId: dto.edgeNodeId,
      clubId:     actor.clubId,
      matchId:    dto.matchId ?? null,
      kind:       dto.kind,
      payload:    dto.payload,
      confidence: Math.max(0, Math.min(1, dto.confidence ?? 0.5)),
      capturedAt: new Date(dto.capturedAt),
    },
  });
}

export async function listInferences(actor: EdgeActor, opts: { edgeNodeId?: string; matchId?: string; kind?: string; limit?: number } = {}) {
  return prisma.edgeInferenceResult.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.edgeNodeId ? { edgeNodeId: opts.edgeNodeId } : {}),
      ...(opts.matchId    ? { matchId: opts.matchId } : {}),
      ...(opts.kind       ? { kind: opts.kind } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  });
}
