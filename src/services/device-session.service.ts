// Familista — Device Session + Sensor Packet ingest (Phase B)
// ─────────────────────────────────────────────────────────────────────────
// Hardware ecosystem data plane.
//
// PATENTABLE BOUNDARY: the device sends only `deviceSessionId` + signed
// packets. Tenant (clubId, teamId) is RESOLVED from the session row, never
// from the packet. The device cannot self-declare tenancy.
//
// Sessions reference (matchId | trainingSessionId) so every byte of sensor
// data has a temporal owner. SensorPacket is append-only.

import { DeviceSession, SensorPacket, SensorPacketKind, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { randomBytes } from 'crypto';
import { emitSensorPacket, emitSensorBatch } from '../fusion/realtime-ingest';

export interface DeviceSessionActor {
  userId:     string;
  clubId:     string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface OpenSessionDto {
  teamId?:           string | null;
  matchId?:          string | null;
  trainingSessionId?: string | null;
  deviceModel:       string;   // FAMILISTA_WEARABLE_V1 | FAMILISTA_TURF_NODE_V1 | FAMILISTA_AI_CAM_V1
  deviceSerial:      string;
  edgeFwVersion?:    string;
  metadata?:         Prisma.JsonValue;
}

export interface IngestPacketDto {
  kind:       SensorPacketKind;
  capturedAt: string;          // ISO
  payload:    Prisma.JsonValue;
  sigB64?:    string;
}

// ─────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────

async function assertTeamInClub(clubId: string, teamId?: string | null): Promise<void> {
  if (!teamId) return;
  const t = await prisma.team.findUnique({ where: { id: teamId }, select: { clubId: true } });
  if (!t)                  throw new NotFoundError('Team');
  if (t.clubId !== clubId) throw new ForbiddenError();
}
async function assertMatchInClub(clubId: string, matchId?: string | null): Promise<void> {
  if (!matchId) return;
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!m)                  throw new NotFoundError('Match');
  if (m.clubId !== clubId) throw new ForbiddenError();
}
async function assertTrainingInClub(clubId: string, trainingSessionId?: string | null): Promise<void> {
  if (!trainingSessionId) return;
  const s = await prisma.trainingSession.findUnique({ where: { id: trainingSessionId }, select: { clubId: true } });
  if (!s)                  throw new NotFoundError('TrainingSession');
  if (s.clubId !== clubId) throw new ForbiddenError();
}

export async function openSession(actor: DeviceSessionActor, dto: OpenSessionDto): Promise<DeviceSession> {
  await assertTeamInClub(actor.clubId, dto.teamId);
  await assertMatchInClub(actor.clubId, dto.matchId);
  await assertTrainingInClub(actor.clubId, dto.trainingSessionId);

  // Server-issued session key — the device receives this once at session open
  // and never sees the clubId/teamId. HMAC packets verified against this key.
  const sessionKey = randomBytes(32).toString('base64');

  return prisma.deviceSession.create({
    data: {
      clubId:           actor.clubId,
      teamId:           dto.teamId ?? null,
      matchId:          dto.matchId ?? null,
      trainingSessionId: dto.trainingSessionId ?? null,
      deviceModel:      dto.deviceModel,
      deviceSerial:     dto.deviceSerial,
      edgeFwVersion:    dto.edgeFwVersion,
      sessionKey,
      startedAt:        new Date(),
      metadata:         (dto.metadata ?? null) as Prisma.InputJsonValue,
    },
  });
}

export async function closeSession(actor: DeviceSessionActor, sessionId: string): Promise<DeviceSession> {
  const s = await prisma.deviceSession.findUnique({ where: { id: sessionId } });
  if (!s)                       throw new NotFoundError('DeviceSession');
  if (s.clubId !== actor.clubId) throw new ForbiddenError();
  if (s.endedAt) return s;
  return prisma.deviceSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
}

export async function listSessions(
  clubId: string,
  filters: {
    deviceModel?: string;
    teamId?:      string;
    matchId?:     string;
    activeOnly?:  boolean;
    page?:        number;
    limit?:       number;
  } = {},
) {
  const { deviceModel, teamId, matchId, activeOnly, page = 1, limit = 50 } = filters;
  const where: Prisma.DeviceSessionWhereInput = {
    clubId,
    ...(deviceModel && { deviceModel }),
    ...(teamId      && { teamId }),
    ...(matchId     && { matchId }),
    ...(activeOnly  && { endedAt: null }),
  };
  const [items, total] = await Promise.all([
    prisma.deviceSession.findMany({
      where,
      include: { _count: { select: { packets: true } } },
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.deviceSession.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getSession(sessionId: string, clubId: string) {
  const s = await prisma.deviceSession.findUnique({
    where: { id: sessionId },
    include: { _count: { select: { packets: true } } },
  });
  if (!s)                  throw new NotFoundError('DeviceSession');
  if (s.clubId !== clubId) throw new ForbiddenError();
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Sensor packets — ingest (append-only)
// ─────────────────────────────────────────────────────────────────────────

// Returns the session row IFF the caller (or device) is allowed to ingest
// into it. The "caller" path uses actor.clubId. The "device" path will use
// a separate device-token auth in Phase C; this stub validates ownership
// against the actor for now.
async function loadSessionForIngest(sessionId: string, actor: DeviceSessionActor): Promise<DeviceSession> {
  const s = await prisma.deviceSession.findUnique({ where: { id: sessionId } });
  if (!s)                        throw new NotFoundError('DeviceSession');
  if (s.clubId !== actor.clubId) throw new ForbiddenError();
  if (s.endedAt)                 throw new BadRequestError('Session is closed');
  return s;
}

export async function ingestPacket(
  actor: DeviceSessionActor,
  sessionId: string,
  packet: IngestPacketDto,
): Promise<SensorPacket> {
  const session = await loadSessionForIngest(sessionId, actor);
  const ts = new Date(packet.capturedAt);
  if (Number.isNaN(ts.getTime())) throw new BadRequestError('capturedAt is not a valid date');
  const row = await prisma.sensorPacket.create({
    data: {
      deviceSessionId: sessionId,
      kind:            packet.kind,
      capturedAt:      ts,
      payload:         packet.payload as Prisma.InputJsonValue,
      sigB64:          packet.sigB64 ?? null,
    },
  });
  // Phase D-IP: fan out to MatchChannel — best-effort, never throws back.
  emitSensorPacket(
    { clubId: actor.clubId, matchId: session.matchId },
    { id: row.id, kind: row.kind, capturedAt: row.capturedAt, payload: packet.payload },
  );
  return row;
}

// Batch ingest — array of packets in one request. Sessions with high event
// rates (IMU @ 100Hz) MUST use this path; we cap at 500 packets per call.
export async function ingestBatch(
  actor: DeviceSessionActor,
  sessionId: string,
  packets: IngestPacketDto[],
): Promise<{ accepted: number }> {
  if (!Array.isArray(packets) || packets.length === 0) {
    throw new BadRequestError('packets must be a non-empty array');
  }
  if (packets.length > 500) throw new BadRequestError('batch size capped at 500');
  const session = await loadSessionForIngest(sessionId, actor);

  const rows = packets.map((p) => {
    const ts = new Date(p.capturedAt);
    if (Number.isNaN(ts.getTime())) throw new BadRequestError('packet.capturedAt invalid');
    return {
      deviceSessionId: sessionId,
      kind:            p.kind,
      capturedAt:      ts,
      payload:         p.payload as Prisma.InputJsonValue,
      sigB64:          p.sigB64 ?? null,
    };
  });

  const result = await prisma.sensorPacket.createMany({ data: rows });
  // Phase D-IP: one summary fan-out per batch (NOT per packet) to avoid
  // saturating the channel during 100 Hz IMU bursts.
  emitSensorBatch(
    { clubId: actor.clubId, matchId: session.matchId },
    rows.map((r) => ({ kind: r.kind, capturedAt: r.capturedAt, payload: r.payload })),
  );
  return { accepted: result.count };
}

export async function listPackets(
  sessionId: string,
  clubId: string,
  opts: { kind?: SensorPacketKind; from?: Date | null; to?: Date | null; limit?: number } = {},
) {
  await getSession(sessionId, clubId); // ownership check
  const { kind, from, to, limit = 500 } = opts;
  const where: Prisma.SensorPacketWhereInput = {
    deviceSessionId: sessionId,
    ...(kind && { kind }),
    ...((from || to) && {
      capturedAt: { ...(from && { gte: from }), ...(to && { lte: to }) },
    }),
  };
  return prisma.sensorPacket.findMany({
    where,
    orderBy: { capturedAt: 'asc' },
    take:    Math.min(limit, 5000),
  });
}
