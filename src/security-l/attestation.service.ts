// Familista — Device Attestation (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// One row per boot. Device proves it is running unmodified firmware and
// still controls its DeviceTrustAnchor secret. HMAC-signed; nonce
// replay-protected via Phase I LRU.

import { createHmac, timingSafeEqual } from 'crypto';
import { AttestationStatus, DeviceAttestation, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError, UnauthorizedError } from '../utils/errors';
import { assertFreshAndRemember } from '../security/device-nonce.service';
import { logDeviceSecurityEvent } from '../security/security-event.service';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface AttestationActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface RecordAttestationDto {
  deviceId:       string;
  fwVersion?:     string;
  secureBootHash?: string;
  nonce:          string;
  /// HMAC-SHA256(device.hmacSecret, `${nonce}|${secureBootHash ?? ''}`) base64.
  sigB64:         string;
}

export async function recordAttestation(_actor: AttestationActor, dto: RecordAttestationDto): Promise<DeviceAttestation> {
  if (!dto.deviceId || !dto.nonce || !dto.sigB64) throw new BadRequestError('deviceId + nonce + sigB64 required');

  const dev = await prisma.device.findUnique({ where: { id: dto.deviceId } });
  if (!dev)                                throw new NotFoundError('Device');
  if (dev.status === 'REVOKED' || dev.status === 'RETIRED') throw new ForbiddenError('Device retired/revoked');

  // Anti-replay.
  if (!assertFreshAndRemember(`attest:${dev.id}`, dto.nonce)) {
    logDeviceSecurityEvent({ kind: 'DEVICE_REPLAY', severity: 'CRITICAL', clubId: dev.clubId, payload: { deviceId: dev.id, reason: 'nonce_reused' } });
    throw new UnauthorizedError('Nonce already used');
  }

  // Verify HMAC over (nonce | secureBootHash ?? '').
  const message = `${dto.nonce}|${dto.secureBootHash ?? ''}`;
  const ok = verify(dev.hmacSecret, message, dto.sigB64);
  let status: AttestationStatus = ok ? 'VERIFIED' : 'FAILED';
  let reason: string | null = null;

  // Cross-check against the active DeviceTrustAnchor (if any).
  if (ok && dto.secureBootHash) {
    const anchor = await prisma.deviceTrustAnchor.findFirst({
      where:   { deviceId: dev.id, revokedAt: null },
      orderBy: { validFrom: 'desc' },
    });
    if (anchor?.secureBootHash && anchor.secureBootHash !== dto.secureBootHash) {
      status = 'FAILED';
      reason = 'secure_boot_hash_mismatch';
      logDeviceSecurityEvent({ kind: 'DEVICE_REJECTED', severity: 'CRITICAL', clubId: dev.clubId, payload: { deviceId: dev.id, reason } });
    }
  }
  if (!ok) {
    reason = reason ?? 'hmac_mismatch';
    logDeviceSecurityEvent({ kind: 'DEVICE_REJECTED', severity: 'CRITICAL', clubId: dev.clubId, payload: { deviceId: dev.id, reason } });
  }

  const row = await prisma.deviceAttestation.create({
    data: {
      deviceId:       dev.id,
      fwVersion:      dto.fwVersion ?? null,
      secureBootHash: dto.secureBootHash ?? null,
      nonce:          dto.nonce,
      sigB64:         dto.sigB64,
      status,
      reason,
    },
  });

  if (status === 'FAILED') {
    // Auto-revoke on any failure.
    await prisma.device.update({ where: { id: dev.id }, data: { status: 'REVOKED', revokedAt: new Date(), notes: `Auto-revoke: attestation ${reason}` } });
  } else {
    // Bump the trust anchor's last status.
    await prisma.deviceTrustAnchor.updateMany({
      where: { deviceId: dev.id, revokedAt: null },
      data:  { lastAttestationStatus: 'VERIFIED' },
    });
  }
  appendAuditEventAsync({
    actor: { userId: null, clubId: dev.clubId, ipAddress: null, userAgent: null },
    action: status === 'VERIFIED' ? 'DEVICE_ATTESTATION_VERIFIED' : 'DEVICE_ATTESTATION_FAILED',
    entityType: 'DeviceAttestation',
    entityId: row.id,
    payload: { deviceId: dev.id, status, reason },
  });
  return row;
}

export async function listAttestations(actor: AttestationActor, deviceId: string, limit = 100): Promise<DeviceAttestation[]> {
  const dev = await prisma.device.findUnique({ where: { id: deviceId }, select: { clubId: true } });
  if (!dev || (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  return prisma.deviceAttestation.findMany({ where: { deviceId }, orderBy: { capturedAt: 'desc' }, take: Math.min(limit, 500) });
}

function verify(secretB64: string, message: string, suppliedSigB64: string): boolean {
  try {
    const secret = Buffer.from(secretB64, 'base64');
    const expected = createHmac('sha256', secret).update(message).digest();
    const supplied = Buffer.from(suppliedSigB64, 'base64');
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
  } catch { return false; }
}
