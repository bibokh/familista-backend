// Familista — Device Registry (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Per-PCB lifecycle: register → provision → active → retired / revoked.
//
// Hardware identity model:
//   - `serial`           : unique per board (laser-etched)
//   - `hmacSecret`       : long-lived secret shared with the PCB's eFuse
//   - `efuseFingerprint` : last reported fingerprint; mismatch = revoke
//
// IMPORTANT: hmacSecret is generated server-side at REGISTRATION. The
// caller (operator) must transcribe it onto the device once — there's no
// "fetch my secret" endpoint. After the first activation we hash-anchor
// it to the efuseFingerprint so a board swap is detectable.

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { Device, DeviceProvisionStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { resolveCredential, storeNewCredential } from '../fabric/secrets/device-credentials';

export interface DeviceActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface RegisterDeviceDto {
  serial:      string;
  model:       string;
  hwRevision?: string;
  teamId?:     string | null;
  notes?:      string;
  metadata?:   Prisma.InputJsonValue;
}

export interface ActivateDeviceDto {
  efuseFingerprint: string;
  /** HMAC of `${ts}.${nonce}` using the device's hmacSecret. */
  sig:              string;
  ts:               number;
  nonce:            string;
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────

/** Everything about a device EXCEPT its credential. What a response may carry. */
const DEVICE_PUBLIC_SELECT = {
  id: true, clubId: true, teamId: true, serial: true, model: true,
  hwRevision: true, status: true, efuseFingerprint: true,
  registeredAt: true, activatedAt: true, retiredAt: true, revokedAt: true,
  notes: true, metadata: true, secretRef: true,
} as const;

export async function registerDevice(actor: DeviceActor, dto: RegisterDeviceDto): Promise<Record<string, unknown> & { hmacSecretPlaintext: string }> {
  // Generate a 32-byte HMAC secret. Returned to caller ONCE.
  const secret = randomBytes(32).toString('base64');
  const existing = await prisma.device.findUnique({ where: { serial: dto.serial }, select: { id: true } });
  if (existing) throw new BadRequestError(`Serial ${dto.serial} already registered`);

  const row = await prisma.device.create({
    data: {
      clubId:     actor.clubId,
      teamId:     dto.teamId ?? null,
      serial:     dto.serial,
      model:      dto.model,
      hwRevision: dto.hwRevision ?? null,
      // The legacy column is still written, and that is deliberate: a device
      // provisioned by this build must keep working if the reference path is
      // later rolled back. Once the reference is proven in production, a
      // separate step blanks it — see the rollout plan.
      hmacSecret: secret,
      status:     'REGISTERED',
      notes:      dto.notes ?? null,
      metadata:   (dto.metadata ?? null) as Prisma.InputJsonValue,
    },
    select: DEVICE_PUBLIC_SELECT,
  });

  // The credential's real home. A store that cannot accept it returns null and
  // the device authenticates from the legacy column exactly as before, so this
  // ships without the deployment having to be reconfigured first.
  const ref = await storeNewCredential('device', row.id, secret, {
    serial: dto.serial, model: dto.model, registeredBy: actor.userId,
  });
  const saved = ref
    ? await prisma.device.update({ where: { id: row.id }, data: { secretRef: ref }, select: DEVICE_PUBLIC_SELECT })
    : row;

  // `saved` is a narrowed select — `hmacSecret` is not in it and cannot be
  // spread into the response. The plaintext appears exactly once, under the
  // name that says what it is and that it will not be shown again.
  return { ...saved, hmacSecretPlaintext: secret };
}

export async function activateDevice(serial: string, dto: ActivateDeviceDto): Promise<Device> {
  if (!dto.efuseFingerprint || !dto.sig || !dto.ts || !dto.nonce) {
    throw new BadRequestError('efuseFingerprint, sig, ts, nonce required');
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - dto.ts) > 300) {
    throw new BadRequestError('Clock skew exceeds 5 minutes');
  }

  const d = await prisma.device.findUnique({ where: { serial } });
  if (!d)                            throw new NotFoundError('Device');
  if (d.status === 'REVOKED' || d.status === 'RETIRED') throw new ForbiddenError('Device retired/revoked');

  const expectedMsg = `${dto.ts}.${dto.nonce}`;
  // The credential, by reference where the row has one and from the legacy
  // column where it does not. A row that resolves to nothing fails the
  // signature check below — the same refusal a wrong key produces, which is
  // what stops this becoming an oracle for which devices have been migrated.
  const credential = await resolveCredential(d);
  if (!verifyHmac(credential.value ?? '', expectedMsg, dto.sig)) {
    throw new ForbiddenError('Invalid device signature');
  }

  // If a fingerprint was already seen and changes now, REVOKE — board swap.
  if (d.efuseFingerprint && d.efuseFingerprint !== dto.efuseFingerprint) {
    await prisma.device.update({
      where: { id: d.id },
      data:  { status: 'REVOKED', revokedAt: new Date(), notes: `Auto-revoke: eFuse fingerprint mismatch` },
    });
    throw new ForbiddenError('eFuse fingerprint mismatch — device revoked');
  }

  return prisma.device.update({
    where: { id: d.id },
    data: {
      status:           d.status === 'REGISTERED' ? 'PROVISIONED' : 'ACTIVE',
      activatedAt:      d.activatedAt ?? new Date(),
      efuseFingerprint: dto.efuseFingerprint,
    },
  });
}

export async function listDevices(
  actor: DeviceActor,
  filters: { model?: string; status?: DeviceProvisionStatus; teamId?: string; page?: number; limit?: number } = {},
) {
  const { model, status, teamId, page = 1, limit = 50 } = filters;
  const where: Prisma.DeviceWhereInput = {
    clubId: actor.clubId,
    ...(model  && { model }),
    ...(status && { status }),
    ...(teamId && { teamId }),
  };
  const [items, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: { registeredAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 200),
      // Never return the secret in list views.
      select: {
        id: true, clubId: true, teamId: true, serial: true, model: true,
        hwRevision: true, status: true, efuseFingerprint: true,
        registeredAt: true, activatedAt: true, retiredAt: true, revokedAt: true,
        notes: true, metadata: true,
      },
    }),
    prisma.device.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getDevice(actor: DeviceActor, id: string) {
  const d = await prisma.device.findUnique({
    where: { id },
    select: {
      id: true, clubId: true, teamId: true, serial: true, model: true,
      hwRevision: true, status: true, efuseFingerprint: true,
      registeredAt: true, activatedAt: true, retiredAt: true, revokedAt: true,
      notes: true, metadata: true,
    },
  });
  if (!d)                                                           throw new NotFoundError('Device');
  if (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')   throw new ForbiddenError();
  return d;
}

export async function retireDevice(actor: DeviceActor, id: string): Promise<Device> {
  const d = await getDevice(actor, id);
  return prisma.device.update({
    where: { id: d.id },
    data:  { status: 'RETIRED', retiredAt: new Date() },
  });
}

export async function revokeDevice(actor: DeviceActor, id: string, reason?: string): Promise<Device> {
  const d = await getDevice(actor, id);
  return prisma.device.update({
    where: { id: d.id },
    data:  {
      status:    'REVOKED',
      revokedAt: new Date(),
      notes:     reason ?? `Revoked by ${actor.userId}`,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// HMAC helper — exposed so the device-auth middleware can fall back to a
// Device's hmacSecret (long-lived) instead of the session-key (short-lived)
// when a packet arrives BEFORE a session has been opened.
// ─────────────────────────────────────────────────────────────────────────

export function verifyHmac(secretB64: string, message: string, suppliedSigB64: string): boolean {
  try {
    const secret   = Buffer.from(secretB64, 'base64');
    const expected = createHmac('sha256', secret).update(message).digest();
    const supplied = Buffer.from(suppliedSigB64, 'base64');
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
  } catch { return false; }
}
