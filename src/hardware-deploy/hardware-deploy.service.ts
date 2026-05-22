// Familista — Hardware Deployment (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Physical inventory + per-device diagnostic reports. Composes with
// Phase F Device registry + Phase L HardwareProvisioningSession +
// Phase J ProvisioningBatch (existing) — does not replace them.

import { DeviceDiagnosticReport, DeviceInventoryEntry, DeviceInventoryState, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface HwDeployActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Inventory ───────────────────────────────────────────────────────────

export interface UpsertInventoryDto {
  serial:    string;
  deviceId?: string;
  state?:    DeviceInventoryState;
  location?: string;
  shippedAt?: string;
  receivedAt?: string;
  rmaReason?: string;
  notes?:    string;
}

export async function upsertInventory(actor: HwDeployActor, dto: UpsertInventoryDto): Promise<DeviceInventoryEntry> {
  if (!dto.serial) throw new BadRequestError('serial required');
  // If deviceId provided, verify it belongs to caller's club.
  if (dto.deviceId) {
    const dev = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
    if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError('Device not in club');
  }
  const row = await prisma.deviceInventoryEntry.upsert({
    where:  { serial: dto.serial },
    create: {
      clubId:     actor.clubId,
      deviceId:   dto.deviceId ?? null,
      serial:     dto.serial,
      state:      dto.state ?? 'STOCK',
      location:   dto.location ?? null,
      shippedAt:  dto.shippedAt ? new Date(dto.shippedAt) : null,
      receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : null,
      rmaReason:  dto.rmaReason ?? null,
      notes:      dto.notes ?? null,
    },
    update: {
      clubId:     actor.clubId,
      deviceId:   dto.deviceId ?? null,
      state:      dto.state ?? undefined,
      location:   dto.location ?? null,
      shippedAt:  dto.shippedAt ? new Date(dto.shippedAt) : undefined,
      receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined,
      rmaReason:  dto.rmaReason ?? null,
      notes:      dto.notes ?? null,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'HW_INVENTORY_UPSERT', entityType: 'DeviceInventoryEntry', entityId: row.id,
    payload: { serial: dto.serial, state: row.state, deviceId: dto.deviceId ?? null },
  });
  return row;
}

export async function listInventory(actor: HwDeployActor, opts: { state?: DeviceInventoryState; limit?: number; page?: number } = {}) {
  const { page = 1, limit = 100 } = opts;
  const where: Prisma.DeviceInventoryEntryWhereInput = {
    clubId: actor.clubId,
    ...(opts.state ? { state: opts.state } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.deviceInventoryEntry.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 500) }),
    prisma.deviceInventoryEntry.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ── Diagnostics ─────────────────────────────────────────────────────────

export interface RecordDiagnosticDto {
  deviceId:   string;
  reportKind: string;
  payload:    Prisma.InputJsonValue;
  score?:     number;
}

export async function recordDiagnostic(actor: HwDeployActor, dto: RecordDiagnosticDto): Promise<DeviceDiagnosticReport> {
  if (!dto.deviceId || !dto.reportKind || dto.payload === undefined) throw new BadRequestError('deviceId + reportKind + payload required');
  const dev = await prisma.device.findUnique({ where: { id: dto.deviceId }, select: { clubId: true } });
  if (!dev)                                                          throw new NotFoundError('Device');
  if (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')   throw new ForbiddenError();
  return prisma.deviceDiagnosticReport.create({
    data: {
      deviceId:   dto.deviceId,
      reportKind: dto.reportKind,
      payload:    dto.payload,
      score:      Math.max(0, Math.min(1, dto.score ?? 1.0)),
    },
  });
}

export async function listDiagnostics(actor: HwDeployActor, deviceId: string, limit = 50): Promise<DeviceDiagnosticReport[]> {
  const dev = await prisma.device.findUnique({ where: { id: deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.deviceDiagnosticReport.findMany({ where: { deviceId }, orderBy: { capturedAt: 'desc' }, take: Math.min(limit, 500) });
}

// ── Real ESP32 provisioning workflow (composes with Phase F + L) ────────

export interface Esp32WorkflowStep {
  step: 'INVENTORY_RECEIVE' | 'HMAC_SECRET_BURN' | 'CERT_INSTALL' | 'FIRMWARE_INSTALL' | 'SECURE_BOOT_SEAL' | 'ACTIVATE';
  ok:   boolean;
  notes?: string;
}

/** Helper: stamp the next workflow step on the Phase L HardwareProvisioningSession. */
export async function recordEsp32Step(actor: HwDeployActor, sessionId: string, step: Esp32WorkflowStep): Promise<void> {
  if (!sessionId || !step?.step) throw new BadRequestError('sessionId + step required');
  // Re-use the Phase L helper rather than duplicating logic.
  const { recordStep } = await import('../hardware/hardware.service');
  await recordStep(actor, sessionId, { name: step.step, ok: !!step.ok, payload: step.notes ? { notes: step.notes } as never : undefined });
}
