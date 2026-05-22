// Familista — Firmware OTA service (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Pull-only OTA. The PCB polls GET /devices/:id/firmware periodically.
// Server returns the version + sha256 + downloadUrl for the device's
// model and channel; if the device is already running that version, the
// response sets `upToDate: true`.
//
// We NEVER push firmware. This avoids hostile mid-match flashes and means
// the device controls the upgrade window (after match end, on charge, …).

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import type { DeviceFirmware, Prisma } from '@prisma/client';

export interface FirmwareCheckResult {
  deviceId:    string;
  model:       string;
  channel:     string;
  currentVer?: string | null;
  pinned:      {
    version:     string;
    sha256:      string;
    downloadUrl: string;
    publishedAt: string;
    minHwRev?:   string | null;
    notes?:      string | null;
  } | null;
  upToDate:    boolean;
  /** True if device's hwRevision is below pinned.minHwRev → must NOT upgrade. */
  blockedByHw: boolean;
}

export interface PublishFirmwareDto {
  model:       string;
  channel?:    string;
  version:     string;
  sha256:      string;
  downloadUrl: string;
  minHwRev?:   string | null;
  notes?:      string;
  publishedBy?: string;
}

export async function checkFirmware(deviceId: string, opts: { channel?: string; currentVer?: string }): Promise<FirmwareCheckResult> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new NotFoundError('Device');
  if (device.status === 'REVOKED' || device.status === 'RETIRED') {
    throw new ForbiddenError('Device retired/revoked');
  }

  const channel = opts.channel ?? 'stable';
  const pinned = await prisma.deviceFirmware.findFirst({
    where:   { model: device.model, channel, isActive: true },
    orderBy: { publishedAt: 'desc' },
  });

  if (!pinned) {
    return {
      deviceId:    device.id,
      model:       device.model,
      channel,
      currentVer:  opts.currentVer ?? null,
      pinned:      null,
      upToDate:    false,
      blockedByHw: false,
    };
  }

  const blockedByHw = !!(pinned.minHwRev && device.hwRevision && device.hwRevision < pinned.minHwRev);
  return {
    deviceId:    device.id,
    model:       device.model,
    channel,
    currentVer:  opts.currentVer ?? null,
    pinned: {
      version:     pinned.version,
      sha256:      pinned.sha256,
      downloadUrl: pinned.downloadUrl,
      publishedAt: pinned.publishedAt.toISOString(),
      minHwRev:    pinned.minHwRev,
      notes:       pinned.notes,
    },
    upToDate:    !!opts.currentVer && opts.currentVer === pinned.version,
    blockedByHw,
  };
}

export async function publishFirmware(dto: PublishFirmwareDto): Promise<DeviceFirmware> {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(dto.version)) {
    throw new BadRequestError('version must be semver-like (e.g. 1.2.3)');
  }
  if (!/^[a-f0-9]{64}$/i.test(dto.sha256)) {
    throw new BadRequestError('sha256 must be a 64-char hex digest');
  }
  return prisma.deviceFirmware.upsert({
    where:  { model_channel_version: { model: dto.model, channel: dto.channel ?? 'stable', version: dto.version } },
    update: { sha256: dto.sha256, downloadUrl: dto.downloadUrl, minHwRev: dto.minHwRev ?? null, notes: dto.notes ?? null, isActive: true },
    create: {
      model:       dto.model,
      channel:     dto.channel ?? 'stable',
      version:     dto.version,
      sha256:      dto.sha256,
      downloadUrl: dto.downloadUrl,
      minHwRev:    dto.minHwRev ?? null,
      notes:       dto.notes ?? null,
      publishedBy: dto.publishedBy ?? null,
    },
  });
}

export async function listFirmware(filters: { model?: string; channel?: string } = {}) {
  return prisma.deviceFirmware.findMany({
    where: {
      ...(filters.model   && { model:   filters.model }),
      ...(filters.channel && { channel: filters.channel }),
    },
    orderBy: { publishedAt: 'desc' },
    take:    100,
  });
}

export async function deactivateFirmware(model: string, channel: string, version: string): Promise<{ ok: boolean }> {
  await prisma.deviceFirmware.updateMany({
    where: { model, channel, version },
    data:  { isActive: false },
  });
  return { ok: true };
}
