// Familista — Device Calibration service (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Per-device, per-sensor calibration store. Append-only — every new
// calibration creates a new row with `version = max(version) + 1`. Old
// rows stay in the table so historical packets can be reprocessed against
// the calibration they were captured with.
//
// Active calibration per (deviceId, sensorKind) = the row with the highest
// version whose `isActive` is true.

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import type { DeviceCalibration, Prisma } from '@prisma/client';
import type { DeviceActor } from './device-registry.service';

export interface ApplyCalibrationDto {
  sensorKind: string;
  payload:    Prisma.InputJsonValue;
  notes?:     string;
}

async function assertDeviceInClub(deviceId: string, actor: DeviceActor) {
  const d = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true, clubId: true } });
  if (!d)                                                          throw new NotFoundError('Device');
  if (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
}

export async function applyCalibration(actor: DeviceActor, deviceId: string, dto: ApplyCalibrationDto): Promise<DeviceCalibration> {
  if (!dto.sensorKind || !dto.payload) throw new BadRequestError('sensorKind and payload required');
  await assertDeviceInClub(deviceId, actor);

  // Determine next version for (deviceId, sensorKind).
  const last = await prisma.deviceCalibration.findFirst({
    where:   { deviceId, sensorKind: dto.sensorKind },
    orderBy: { version: 'desc' },
    select:  { version: true },
  });
  const next = (last?.version ?? 0) + 1;

  return prisma.$transaction(async (tx) => {
    // De-activate previous active row.
    await tx.deviceCalibration.updateMany({
      where: { deviceId, sensorKind: dto.sensorKind, isActive: true },
      data:  { isActive: false },
    });
    // Insert new row.
    return tx.deviceCalibration.create({
      data: {
        deviceId,
        sensorKind: dto.sensorKind,
        version:    next,
        payload:    dto.payload,
        appliedBy:  actor.userId,
        isActive:   true,
      },
    });
  });
}

export async function getActiveCalibration(deviceId: string, sensorKind?: string): Promise<DeviceCalibration[]> {
  return prisma.deviceCalibration.findMany({
    where:   { deviceId, isActive: true, ...(sensorKind ? { sensorKind } : {}) },
    orderBy: [{ sensorKind: 'asc' }],
  });
}

export async function listCalibrationHistory(deviceId: string, sensorKind?: string): Promise<DeviceCalibration[]> {
  return prisma.deviceCalibration.findMany({
    where:   { deviceId, ...(sensorKind ? { sensorKind } : {}) },
    orderBy: [{ sensorKind: 'asc' }, { version: 'desc' }],
    take:    200,
  });
}
