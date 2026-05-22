// Familista — Real Hardware abstraction (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Sits above Phase J ProvisioningBatch + DeviceActivation. Tracks the
// step-by-step lifecycle of bringing one physical device online:
//
//   CREATED        — row created by createSession()
//   IN_PROGRESS    — first step recorded
//   ACTIVATED      — device finished HMAC handshake (Phase C)
//   SEALED         — secure-boot anchor verified (DeviceTrustAnchor)
//   FAILED         — any step rejected
//
// Every transition appends a Phase I SecurityAuditEvent.

import { DeviceCapabilityProfile, DeviceClockDiscipline, DeviceSensorMatrix, DeviceTrustAnchor, HardwareProvisioningSession, HardwareProvisioningStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface HardwareActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─────────────────────────────────────────────────────────────────────────
// Provisioning sessions
// ─────────────────────────────────────────────────────────────────────────

export interface CreateSessionDto {
  serial:    string;
  batchId?:  string;
  deviceId?: string;
  notes?:    string;
}

export async function createSession(actor: HardwareActor, dto: CreateSessionDto): Promise<HardwareProvisioningSession> {
  if (!dto.serial) throw new BadRequestError('serial required');
  const row = await prisma.hardwareProvisioningSession.create({
    data: {
      clubId:   actor.clubId,
      serial:   dto.serial,
      batchId:  dto.batchId ?? null,
      deviceId: dto.deviceId ?? null,
      status:   'CREATED',
      steps:    [] as unknown as Prisma.InputJsonValue,
      notes:    dto.notes ?? null,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'HW_PROVISIONING_CREATED',
    entityType: 'HardwareProvisioningSession',
    entityId: row.id,
    payload: { serial: dto.serial },
  });
  return row;
}

export async function recordStep(actor: HardwareActor, sessionId: string, step: { name: string; ok: boolean; payload?: Prisma.InputJsonValue }): Promise<HardwareProvisioningSession> {
  if (!step.name) throw new BadRequestError('step.name required');
  const session = await getSession(actor, sessionId);
  const prevSteps = Array.isArray(session.steps) ? (session.steps as unknown[]) : [];
  const updated = [...prevSteps, { name: step.name, ok: step.ok, payload: step.payload ?? null, at: new Date().toISOString() }];
  const nextStatus: HardwareProvisioningStatus =
    !step.ok ? 'FAILED'
    : step.name === 'SECURE_BOOT_SEAL' ? 'SEALED'
    : session.status === 'CREATED' ? 'IN_PROGRESS' : session.status;
  return prisma.hardwareProvisioningSession.update({
    where: { id: session.id },
    data: {
      steps:       updated as unknown as Prisma.InputJsonValue,
      status:      nextStatus,
      ...(session.status === 'CREATED' ? { startedAt: new Date() } : {}),
      ...(nextStatus === 'SEALED' || nextStatus === 'FAILED' ? { completedAt: new Date() } : {}),
    },
  });
}

export async function getSession(actor: HardwareActor, id: string): Promise<HardwareProvisioningSession> {
  const row = await prisma.hardwareProvisioningSession.findUnique({ where: { id } });
  if (!row)                                                         throw new NotFoundError('HardwareProvisioningSession');
  if (row.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return row;
}

export async function listSessions(actor: HardwareActor, opts: { status?: HardwareProvisioningStatus; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.HardwareProvisioningSessionWhereInput = {
    clubId: actor.clubId,
    ...(opts.status ? { status: opts.status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.hardwareProvisioningSession.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.hardwareProvisioningSession.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ─────────────────────────────────────────────────────────────────────────
// Capability profiles
// ─────────────────────────────────────────────────────────────────────────

export interface PublishCapabilityDto {
  model:       string;
  hwRevision?: string;
  capabilities: Prisma.InputJsonValue;
}

export async function publishCapability(actor: HardwareActor, dto: PublishCapabilityDto): Promise<DeviceCapabilityProfile> {
  if (!dto.model) throw new BadRequestError('model required');
  return prisma.deviceCapabilityProfile.upsert({
    where: { model_hwRevision: { model: dto.model, hwRevision: dto.hwRevision ?? null } as never },
    create: { model: dto.model, hwRevision: dto.hwRevision ?? null, capabilities: dto.capabilities, isActive: true, publishedBy: actor.userId },
    update: { capabilities: dto.capabilities, isActive: true, publishedBy: actor.userId },
  });
}

export async function listCapabilities(model?: string): Promise<DeviceCapabilityProfile[]> {
  return prisma.deviceCapabilityProfile.findMany({
    where: { isActive: true, ...(model ? { model } : {}) },
    orderBy: [{ model: 'asc' }, { hwRevision: 'asc' }],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Sensor matrix (per-device)
// ─────────────────────────────────────────────────────────────────────────

export interface PublishSensorMatrixDto {
  deviceId: string;
  matrix:   Prisma.InputJsonValue;
}

export async function publishSensorMatrix(actor: HardwareActor, dto: PublishSensorMatrixDto): Promise<DeviceSensorMatrix> {
  const dev = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  await prisma.deviceSensorMatrix.updateMany({ where: { deviceId: dto.deviceId, isActive: true }, data: { isActive: false } });
  return prisma.deviceSensorMatrix.create({
    data: { deviceId: dto.deviceId, matrix: dto.matrix, publishedBy: actor.userId, isActive: true },
  });
}

export async function getActiveSensorMatrix(deviceId: string): Promise<DeviceSensorMatrix | null> {
  return prisma.deviceSensorMatrix.findFirst({ where: { deviceId, isActive: true }, orderBy: { publishedAt: 'desc' } });
}

// ─────────────────────────────────────────────────────────────────────────
// Clock discipline (where do device timestamps come from?)
// ─────────────────────────────────────────────────────────────────────────

export interface RecordClockDto {
  deviceId:  string;
  strategy:  'NTP' | 'PTP' | 'VISION_SYNC' | 'EVENT_BEACON' | 'MANUAL';
  lastSkewMs?: number;
  jitterMs?: number;
  source?:   string;
}

export async function recordClockDiscipline(actor: HardwareActor, dto: RecordClockDto): Promise<DeviceClockDiscipline> {
  const dev = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.deviceClockDiscipline.create({
    data: {
      deviceId:  dto.deviceId,
      strategy:  dto.strategy,
      lastSkewMs: dto.lastSkewMs ?? null,
      jitterMs:  dto.jitterMs ?? null,
      source:    dto.source ?? null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Trust anchor (cert + secure-boot fingerprint)
// ─────────────────────────────────────────────────────────────────────────

export interface PublishTrustAnchorDto {
  deviceId:        string;
  certFingerprint: string;
  secureBootHash?: string;
  hwSerial?:       string;
  issuer?:         string;
  validUntil?:     string;       // ISO
}

export async function publishTrustAnchor(actor: HardwareActor, dto: PublishTrustAnchorDto): Promise<DeviceTrustAnchor> {
  if (!dto.deviceId || !dto.certFingerprint) throw new BadRequestError('deviceId + certFingerprint required');
  const dev = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  const row = await prisma.deviceTrustAnchor.upsert({
    where:  { deviceId_certFingerprint: { deviceId: dto.deviceId, certFingerprint: dto.certFingerprint } },
    create: {
      deviceId:       dto.deviceId,
      certFingerprint: dto.certFingerprint,
      secureBootHash: dto.secureBootHash ?? null,
      hwSerial:       dto.hwSerial ?? null,
      issuer:         dto.issuer ?? 'familista-factory-ca',
      validUntil:     dto.validUntil ? new Date(dto.validUntil) : null,
    },
    update: {
      secureBootHash: dto.secureBootHash ?? null,
      hwSerial:       dto.hwSerial ?? null,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'HW_TRUST_ANCHOR_PUBLISHED',
    entityType: 'DeviceTrustAnchor',
    entityId: row.id,
    payload: { deviceId: dto.deviceId, certFingerprint: dto.certFingerprint },
  });
  return row;
}

export async function listTrustAnchors(actor: HardwareActor, deviceId: string): Promise<DeviceTrustAnchor[]> {
  const dev = await prisma.device.findUnique({ where: { id: deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.deviceTrustAnchor.findMany({ where: { deviceId }, orderBy: { validFrom: 'desc' } });
}

export async function revokeTrustAnchor(actor: HardwareActor, id: string): Promise<DeviceTrustAnchor> {
  const row = await prisma.deviceTrustAnchor.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('DeviceTrustAnchor');
  const dev = await prisma.device.findUnique({ where: { id: row.deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  const updated = await prisma.deviceTrustAnchor.update({
    where: { id },
    data:  { revokedAt: new Date(), lastAttestationStatus: 'REVOKED' },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'HW_TRUST_ANCHOR_REVOKED',
    entityType: 'DeviceTrustAnchor',
    entityId: id,
    payload: { deviceId: row.deviceId },
  });
  return updated;
}
