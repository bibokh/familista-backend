// Familista — Camera registry + calibration (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Same identity model as Device (Phase F): per-rig long-lived HMAC secret,
// CameraCalibration is append-only versioned. The edge node uses this row
// to sign frame batches with HMAC-SHA256.

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { Camera, CameraCalibration, CameraKind, CameraStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface CameraActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface RegisterCameraDto {
  serial:      string;
  label:       string;
  kind?:       CameraKind;
  vendor?:     string;
  model?:      string;
  hwRevision?: string;
  teamId?:     string | null;
  metadata?:   Prisma.InputJsonValue;
}

export interface ApplyCalibrationDto {
  intrinsics:           Prisma.InputJsonValue;
  extrinsics:           Prisma.InputJsonValue;
  frameOfReference?:    string;
  reprojectionErrorPx?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Registration & lifecycle
// ─────────────────────────────────────────────────────────────────────────

export async function registerCamera(actor: CameraActor, dto: RegisterCameraDto): Promise<Camera & { hmacSecretPlaintext: string }> {
  const existing = await prisma.camera.findUnique({ where: { serial: dto.serial } });
  if (existing) throw new BadRequestError(`Serial ${dto.serial} already registered`);
  const secret = randomBytes(32).toString('base64');

  const row = await prisma.camera.create({
    data: {
      clubId:     actor.clubId,
      teamId:     dto.teamId ?? null,
      serial:     dto.serial,
      label:      dto.label,
      kind:       dto.kind ?? 'RGB',
      vendor:     dto.vendor ?? null,
      model:      dto.model ?? null,
      hwRevision: dto.hwRevision ?? null,
      hmacSecret: secret,
      status:     'REGISTERED',
      metadata:   (dto.metadata ?? null) as Prisma.InputJsonValue,
    },
  });
  return { ...row, hmacSecretPlaintext: secret };
}

export async function listCameras(
  actor: CameraActor,
  filters: { kind?: CameraKind; status?: CameraStatus; teamId?: string; page?: number; limit?: number } = {},
) {
  const { kind, status, teamId, page = 1, limit = 50 } = filters;
  const where: Prisma.CameraWhereInput = {
    clubId: actor.clubId,
    ...(kind   && { kind }),
    ...(status && { status }),
    ...(teamId && { teamId }),
  };
  const [items, total] = await Promise.all([
    prisma.camera.findMany({
      where,
      orderBy: { registeredAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
      // Never return the secret in list views.
      select: {
        id: true, clubId: true, teamId: true, serial: true, label: true, kind: true,
        vendor: true, model: true, hwRevision: true, status: true,
        lastClockSkewMs: true, registeredAt: true, calibratedAt: true, retiredAt: true, metadata: true,
      },
    }),
    prisma.camera.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getCamera(actor: CameraActor, id: string) {
  const c = await prisma.camera.findUnique({
    where: { id },
    select: {
      id: true, clubId: true, teamId: true, serial: true, label: true, kind: true,
      vendor: true, model: true, hwRevision: true, status: true,
      lastClockSkewMs: true, registeredAt: true, calibratedAt: true, retiredAt: true, metadata: true,
    },
  });
  if (!c)                                                          throw new NotFoundError('Camera');
  if (c.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return c;
}

export async function retireCamera(actor: CameraActor, id: string): Promise<Camera> {
  const c = await getCamera(actor, id);
  return prisma.camera.update({
    where: { id: c.id },
    data:  { status: 'RETIRED', retiredAt: new Date() },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Calibration
// ─────────────────────────────────────────────────────────────────────────

export async function applyCalibration(actor: CameraActor, cameraId: string, dto: ApplyCalibrationDto): Promise<CameraCalibration> {
  if (!dto.intrinsics || !dto.extrinsics) throw new BadRequestError('intrinsics and extrinsics required');
  await getCamera(actor, cameraId);     // ownership guard

  const last = await prisma.cameraCalibration.findFirst({
    where:   { cameraId },
    orderBy: { version: 'desc' },
    select:  { version: true },
  });
  const next = (last?.version ?? 0) + 1;

  return prisma.$transaction(async (tx) => {
    await tx.cameraCalibration.updateMany({
      where: { cameraId, isActive: true },
      data:  { isActive: false },
    });
    const row = await tx.cameraCalibration.create({
      data: {
        cameraId,
        version:             next,
        intrinsics:          dto.intrinsics,
        extrinsics:          dto.extrinsics,
        frameOfReference:    dto.frameOfReference ?? 'PITCH',
        reprojectionErrorPx: dto.reprojectionErrorPx ?? null,
        appliedBy:           actor.userId,
        isActive:            true,
      },
    });
    await tx.camera.update({
      where: { id: cameraId },
      data:  { status: 'CALIBRATED', calibratedAt: new Date() },
    });
    return row;
  });
}

export async function getActiveCalibration(cameraId: string): Promise<CameraCalibration | null> {
  return prisma.cameraCalibration.findFirst({
    where:   { cameraId, isActive: true },
    orderBy: { version: 'desc' },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// HMAC verification — exposed so the ingest endpoint can validate batches.
// ─────────────────────────────────────────────────────────────────────────

export function verifyCameraHmac(secretB64: string, message: string, suppliedSigB64: string): boolean {
  try {
    const secret   = Buffer.from(secretB64, 'base64');
    const expected = createHmac('sha256', secret).update(message).digest();
    const supplied = Buffer.from(suppliedSigB64, 'base64');
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
  } catch { return false; }
}
