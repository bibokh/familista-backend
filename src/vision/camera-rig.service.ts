// Familista — Multi-camera rig service (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// CameraRig groups multiple Cameras (Phase G) into a tactical perception
// unit. CameraSyncSession is the "lock the rig" moment. MultiCameraObservation
// + SpatialTriangulationResult are append-only outputs of the fusion path.

import { CameraRig, CameraRigMember, CameraRigRole, CameraSyncSession, MultiCameraObservation, Prisma, SpatialTriangulationResult, VisionSubjectKind } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { triangulate, type CameraView } from './triangulation';
import type { MultiCameraSubjectObservation } from './neuromorphic-types';

export interface RigActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Rig CRUD ────────────────────────────────────────────────────────────

export interface CreateRigDto {
  label:        string;
  syncStrategy?: 'NTP' | 'PTP' | 'EVENT_BEACON' | 'MANUAL';
  geometry?:    Prisma.InputJsonValue;
  metadata?:    Prisma.InputJsonValue;
}

export async function createRig(actor: RigActor, dto: CreateRigDto): Promise<CameraRig> {
  if (!dto.label) throw new BadRequestError('label required');
  return prisma.cameraRig.create({
    data: {
      clubId:       actor.clubId,
      label:        dto.label,
      syncStrategy: dto.syncStrategy ?? 'NTP',
      geometry:     (dto.geometry ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      metadata:     (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listRigs(actor: RigActor): Promise<CameraRig[]> {
  return prisma.cameraRig.findMany({ where: { clubId: actor.clubId }, orderBy: { createdAt: 'desc' } });
}

export async function getRig(actor: RigActor, id: string): Promise<CameraRig & { members: CameraRigMember[] }> {
  const rig = await prisma.cameraRig.findUnique({ where: { id } });
  if (!rig)                                                        throw new NotFoundError('CameraRig');
  if (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const members = await prisma.cameraRigMember.findMany({ where: { rigId: id, isActive: true } });
  return { ...rig, members };
}

// ── Members ─────────────────────────────────────────────────────────────

export interface AddMemberDto {
  cameraId: string;
  role?:    CameraRigRole;
  position?: Prisma.InputJsonValue;
}

export async function addMember(actor: RigActor, rigId: string, dto: AddMemberDto): Promise<CameraRigMember> {
  const rig = await prisma.cameraRig.findUnique({ where: { id: rigId } });
  if (!rig)                                                        throw new NotFoundError('CameraRig');
  if (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const cam = await prisma.camera.findUnique({ where: { id: dto.cameraId }, select: { clubId: true } });
  if (!cam)                                                        throw new NotFoundError('Camera');
  if (cam.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError('Camera not in club');
  return prisma.cameraRigMember.upsert({
    where:  { rigId_cameraId: { rigId, cameraId: dto.cameraId } },
    create: { rigId, cameraId: dto.cameraId, role: dto.role ?? 'GENERIC', position: (dto.position ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
    update: { role: dto.role ?? 'GENERIC', position: (dto.position ?? Prisma.JsonNull) as Prisma.InputJsonValue, isActive: true },
  });
}

export async function removeMember(actor: RigActor, rigId: string, memberId: string): Promise<void> {
  const m = await prisma.cameraRigMember.findUnique({ where: { id: memberId } });
  if (!m) throw new NotFoundError('CameraRigMember');
  if (m.rigId !== rigId) throw new BadRequestError('Member does not belong to this rig');
  const rig = await prisma.cameraRig.findUnique({ where: { id: rigId }, select: { clubId: true } });
  if (!rig || (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  await prisma.cameraRigMember.update({ where: { id: memberId }, data: { isActive: false } });
}

// ── Sync sessions ───────────────────────────────────────────────────────

export interface StartSyncDto {
  matchId?:    string | null;
  anchorTsUs?: number;
  skews?:      Record<string, number>;
}

export async function startSyncSession(actor: RigActor, rigId: string, dto: StartSyncDto = {}): Promise<CameraSyncSession> {
  const rig = await prisma.cameraRig.findUnique({ where: { id: rigId } });
  if (!rig)                                                        throw new NotFoundError('CameraRig');
  if (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.cameraSyncSession.create({
    data: {
      rigId,
      matchId:    dto.matchId ?? null,
      anchorTsUs: typeof dto.anchorTsUs === 'number' ? BigInt(Math.round(dto.anchorTsUs)) : null,
      skews:      (dto.skews ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ok:         true,
    },
  });
}

export async function endSyncSession(actor: RigActor, sessionId: string, ok = true, notes?: string): Promise<CameraSyncSession> {
  const s = await prisma.cameraSyncSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new NotFoundError('CameraSyncSession');
  const rig = await prisma.cameraRig.findUnique({ where: { id: s.rigId }, select: { clubId: true } });
  if (!rig || (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.cameraSyncSession.update({ where: { id: sessionId }, data: { endedAt: new Date(), ok, notes: notes ?? null } });
}

// ── Multi-camera observation + triangulation ───────────────────────────

export interface RecordObservationDto {
  syncSessionId: string;
  monotonicMs:   number;
  subjectKind:   VisionSubjectKind;
  subjectId?:    string | null;
  /** Per-camera detections with world coords (already calibrated). */
  detections:    Array<{
    cameraId:   string;
    /** Pitch metres OR pixel coords if no calibration; per-view fallback. */
    x: number; y: number; z?: number;
    confidence: number;
    homography?: number[];
    /** Optional bound-to player. */
    playerId?: string;
  }>;
}

export async function recordObservation(actor: RigActor, dto: RecordObservationDto): Promise<{ observation: MultiCameraObservation; triangulation: SpatialTriangulationResult | null }> {
  const s = await prisma.cameraSyncSession.findUnique({ where: { id: dto.syncSessionId } });
  if (!s) throw new NotFoundError('CameraSyncSession');
  const rig = await prisma.cameraRig.findUnique({ where: { id: s.rigId }, select: { clubId: true } });
  if (!rig || (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();

  // Triangulate using the Phase G pure-function helper.
  const views: CameraView[] = [{
    cameraId:  'merged',
    version:   1,
    detections: dto.detections.map((d) => ({
      trackId:    d.cameraId,
      class:      String(dto.subjectKind),
      x: d.x, y: d.y,
      worldX: d.x, worldY: d.y, worldZ: d.z,
      confidence: d.confidence,
      playerId:   d.playerId ?? dto.subjectId ?? null,
    })),
  }];
  const triangulated = triangulate(views, { minConfidence: 0.35, outlierGateM: 8 });
  let tri: SpatialTriangulationResult | null = null;
  if (triangulated.length > 0) {
    const t = triangulated[0];
    tri = await prisma.spatialTriangulationResult.create({
      data: {
        syncSessionId: s.id,
        clubId:        rig.clubId,
        matchId:       s.matchId,
        monotonicMs:   BigInt(dto.monotonicMs),
        subjectKind:   dto.subjectKind,
        subjectId:     dto.subjectId ?? t.playerId ?? null,
        x:             t.x,
        y:             t.y,
        z:             t.z ?? 0,
        confidence:    t.confidence,
        votes:         t.votes,
      },
    });
  }
  const obs = await prisma.multiCameraObservation.create({
    data: {
      syncSessionId:        s.id,
      clubId:               rig.clubId,
      matchId:              s.matchId,
      monotonicMs:          BigInt(dto.monotonicMs),
      subjectKind:          dto.subjectKind,
      subjectId:            dto.subjectId ?? null,
      contributingCameras:  dto.detections.map((d) => d.cameraId) as unknown as Prisma.InputJsonValue,
      triangulationResultId: tri?.id ?? null,
    },
  });
  return { observation: obs, triangulation: tri };
}

export async function listObservations(actor: RigActor, sessionId: string, opts: { subjectKind?: VisionSubjectKind; limit?: number } = {}) {
  const s = await prisma.cameraSyncSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new NotFoundError('CameraSyncSession');
  const rig = await prisma.cameraRig.findUnique({ where: { id: s.rigId }, select: { clubId: true } });
  if (!rig || (rig.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.multiCameraObservation.findMany({
    where:   { syncSessionId: sessionId, ...(opts.subjectKind ? { subjectKind: opts.subjectKind } : {}) },
    orderBy: { monotonicMs: 'desc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  }).then((rows) => rows.map((r) => ({ ...r, monotonicMs: r.monotonicMs.toString() })));
}
