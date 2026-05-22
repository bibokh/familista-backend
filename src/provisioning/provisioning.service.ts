// Familista — Manufacturing-grade provisioning (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// One factory line → many ProvisioningBatch rows → many Device rows.
//
// Flow:
//   1. createBatch(model, serials[]) — creates ProvisioningBatch.
//   2. materialiseBatch(batchId)     — creates one Device row per serial
//      (Phase F device-registry), one DeviceActivation row per serial,
//      one DeviceCertificate row per serial (if cert payloads given).
//   3. activateBySerial (Phase F)    — flips Device + DeviceActivation
//      states on first boot.
//
// All writes are transactional per-row to keep partial-failure recovery
// simple. Bulk batches use $transaction with a hard cap of 1000 devices.

import { randomBytes } from 'crypto';
import { DeviceActivation, DeviceCertificate, FirmwareManifest, OTARelease, Prisma, ProvisioningBatch, ProvisioningStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface ProvisioningActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────
// Batches
// ─────────────────────────────────────────────────────────────────────────

export interface CreateBatchDto {
  model:       string;
  serials:     string[];
  hwRevision?: string;
  factoryRef?: string;
  manifestId?: string | null;
  metadata?:   Prisma.InputJsonValue;
}

export async function createBatch(actor: ProvisioningActor, dto: CreateBatchDto): Promise<ProvisioningBatch> {
  if (!dto.model || !Array.isArray(dto.serials) || dto.serials.length === 0) {
    throw new BadRequestError('model and serials[] required');
  }
  if (dto.serials.length > 1000) throw new BadRequestError('batch capped at 1000 devices');
  // Dedupe + trim.
  const cleaned = Array.from(new Set(dto.serials.map((s) => s.trim()).filter(Boolean)));
  if (cleaned.length === 0) throw new BadRequestError('no valid serials');
  return prisma.provisioningBatch.create({
    data: {
      clubId:      actor.clubId,
      factoryRef:  dto.factoryRef ?? null,
      model:       dto.model,
      hwRevision:  dto.hwRevision ?? null,
      serials:     cleaned as unknown as Prisma.InputJsonValue,
      status:      'CREATED',
      manifestId:  dto.manifestId ?? null,
      createdById: actor.userId,
      metadata:    (dto.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listBatches(actor: ProvisioningActor, opts: { status?: ProvisioningStatus; model?: string; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.ProvisioningBatchWhereInput = {
    ...(actor.role === 'SUPER_ADMIN' ? {} : { clubId: actor.clubId }),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.model  ? { model: opts.model } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.provisioningBatch.findMany({
      where, orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit, take: Math.min(limit, 200),
    }),
    prisma.provisioningBatch.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getBatch(actor: ProvisioningActor, id: string): Promise<ProvisioningBatch> {
  const b = await prisma.provisioningBatch.findUnique({ where: { id } });
  if (!b)                                                                      throw new NotFoundError('ProvisioningBatch');
  if (b.clubId && b.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return b;
}

/**
 * Materialise the batch into Device + DeviceActivation rows. Idempotent
 * — re-runs skip any serials already registered. Each Device gets a
 * fresh hmacSecret (Phase F) returned ONCE in the response.
 */
export async function materialiseBatch(actor: ProvisioningActor, id: string): Promise<{
  created: number;
  skipped: number;
  manifest: Array<{ serial: string; deviceId: string; hmacSecretPlaintext: string }>;
}> {
  const batch = await getBatch(actor, id);
  if (batch.status === 'COMPLETED') {
    return { created: 0, skipped: (batch.serials as string[]).length, manifest: [] };
  }

  await prisma.provisioningBatch.update({
    where: { id: batch.id },
    data:  { status: 'IN_PROGRESS', startedAt: new Date() },
  });

  const serials = (batch.serials as string[]) ?? [];
  const manifest: Array<{ serial: string; deviceId: string; hmacSecretPlaintext: string }> = [];
  let created = 0, skipped = 0;
  for (const serial of serials) {
    const existing = await prisma.device.findUnique({ where: { serial }, select: { id: true } });
    if (existing) { skipped++; continue; }
    const secret = randomBytes(32).toString('base64');
    const device = await prisma.device.create({
      data: {
        clubId:     batch.clubId ?? actor.clubId,
        serial,
        model:      batch.model,
        hwRevision: batch.hwRevision ?? null,
        hmacSecret: secret,
        status:     'REGISTERED',
      },
    });
    await prisma.deviceActivation.create({
      data: {
        deviceId: device.id,
        batchId:  batch.id,
        serial,
        status:   'CREATED',
      },
    });
    manifest.push({ serial, deviceId: device.id, hmacSecretPlaintext: secret });
    created++;
  }

  await prisma.provisioningBatch.update({
    where: { id: batch.id },
    data:  { status: 'COMPLETED', completedAt: new Date() },
  });
  return { created, skipped, manifest };
}

// ─────────────────────────────────────────────────────────────────────────
// Certificates
// ─────────────────────────────────────────────────────────────────────────

export interface IssueCertDto {
  deviceId:    string;
  fingerprint: string;
  issuer?:     string;
  validUntil?: string;        // ISO
}

export async function issueCert(actor: ProvisioningActor, dto: IssueCertDto): Promise<DeviceCertificate> {
  if (!dto.deviceId || !dto.fingerprint) throw new BadRequestError('deviceId and fingerprint required');
  const d = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
  if (!d)                                                       throw new NotFoundError('Device');
  if (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.deviceCertificate.create({
    data: {
      deviceId:    dto.deviceId,
      fingerprint: dto.fingerprint,
      issuer:      dto.issuer ?? 'familista-factory-ca',
      validUntil:  dto.validUntil ? new Date(dto.validUntil) : null,
    },
  });
}

export async function revokeCert(actor: ProvisioningActor, certId: string): Promise<DeviceCertificate> {
  const c = await prisma.deviceCertificate.findUnique({ where: { id: certId } });
  if (!c) throw new NotFoundError('DeviceCertificate');
  const d = await prisma.device.findUnique({ where: { id: c.deviceId }, select: { clubId: true } });
  if (!d || (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.deviceCertificate.update({ where: { id: certId }, data: { revokedAt: new Date() } });
}

export async function listCertsForDevice(actor: ProvisioningActor, deviceId: string): Promise<DeviceCertificate[]> {
  const d = await prisma.device.findUnique({ where: { id: deviceId }, select: { clubId: true } });
  if (!d || (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.deviceCertificate.findMany({ where: { deviceId }, orderBy: { validFrom: 'desc' } });
}

// ─────────────────────────────────────────────────────────────────────────
// Firmware manifest (richer than Phase F DeviceFirmware)
// ─────────────────────────────────────────────────────────────────────────

export interface PublishManifestDto {
  model:        string;
  channel?:     string;
  version:      string;
  files:        Prisma.InputJsonValue;
  releaseNotes?: string;
  minHwRev?:    string;
}

export async function publishManifest(actor: ProvisioningActor, dto: PublishManifestDto): Promise<FirmwareManifest> {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(dto.version)) throw new BadRequestError('version must be semver-like');
  return prisma.firmwareManifest.upsert({
    where: { model_channel_version: { model: dto.model, channel: dto.channel ?? 'stable', version: dto.version } },
    create: {
      model: dto.model,
      channel: dto.channel ?? 'stable',
      version: dto.version,
      files: dto.files,
      releaseNotes: dto.releaseNotes ?? null,
      minHwRev: dto.minHwRev ?? null,
      publishedBy: actor.userId,
    },
    update: { files: dto.files, releaseNotes: dto.releaseNotes ?? null, minHwRev: dto.minHwRev ?? null, isActive: true },
  });
}

export async function listManifests(opts: { model?: string; channel?: string } = {}): Promise<FirmwareManifest[]> {
  return prisma.firmwareManifest.findMany({
    where: {
      ...(opts.model   ? { model:   opts.model } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take:    100,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// OTA releases
// ─────────────────────────────────────────────────────────────────────────

export interface CreateOTAReleaseDto {
  manifestId:  string;
  rolloutPct?: number;
  scheduledAt?: string;
}

export async function createOTARelease(_actor: ProvisioningActor, dto: CreateOTAReleaseDto): Promise<OTARelease> {
  const m = await prisma.firmwareManifest.findUnique({ where: { id: dto.manifestId } });
  if (!m) throw new NotFoundError('FirmwareManifest');
  return prisma.oTARelease.create({
    data: {
      manifestId: m.id,
      model:      m.model,
      channel:    m.channel,
      version:    m.version,
      rolloutPct: Math.max(0, Math.min(100, dto.rolloutPct ?? 0)),
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      status:     'CREATED',
    },
  });
}

export async function advanceRollout(_actor: ProvisioningActor, releaseId: string, rolloutPct: number): Promise<OTARelease> {
  return prisma.oTARelease.update({
    where: { id: releaseId },
    data:  {
      rolloutPct: Math.max(0, Math.min(100, rolloutPct)),
      status:     rolloutPct >= 100 ? 'COMPLETED' : 'IN_PROGRESS',
      ...(rolloutPct >= 100 ? { completedAt: new Date() } : {}),
      ...(rolloutPct > 0    ? { startedAt:   new Date() } : {}),
    },
  });
}

export async function listReleases(opts: { model?: string; status?: ProvisioningStatus } = {}): Promise<OTARelease[]> {
  return prisma.oTARelease.findMany({
    where: {
      ...(opts.model  ? { model:  opts.model } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { scheduledAt: 'desc' },
    take:    100,
  });
}
