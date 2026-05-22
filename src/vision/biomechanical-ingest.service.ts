// Familista — Biomechanical packet ingest (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// Biochem / wearable patch payloads. Anchored to a Phase F Device.
// HMAC-verified via Device.hmacSecret when sigB64 + nonce are provided.

import { createHash } from 'crypto';
import { BiomechanicalPacket, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError, UnauthorizedError } from '../utils/errors';
import { verifyHmac } from '../services/device-registry.service';
import { assertFreshAndRemember } from '../security/device-nonce.service';
import { logDeviceSecurityEvent } from '../security/security-event.service';
import type { IngestBiomechEnvelope } from './neuromorphic-types';

export interface BiomechActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export async function ingestBiomechPacket(actor: BiomechActor, deviceId: string, env: IngestBiomechEnvelope): Promise<BiomechanicalPacket> {
  if (!env || !env.payload) throw new BadRequestError('payload required');
  const dev = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!dev)                                                          throw new NotFoundError('Device');
  if (dev.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')   throw new ForbiddenError();
  if (dev.status === 'RETIRED' || dev.status === 'REVOKED')          throw new ForbiddenError('Device retired/revoked');

  // Optional HMAC + nonce. Strongly recommended in production; required
  // when env.sigB64 is present, optional otherwise (legacy callers).
  if (env.sigB64 || env.nonce) {
    if (!env.sigB64 || !env.nonce) throw new BadRequestError('sigB64 + nonce must come together');
    const payloadJson = JSON.stringify(env.payload);
    const digest = createHash('sha256').update(payloadJson).digest('hex');
    const msg = `${env.payload.deviceTsMs}.${env.nonce}.${digest}`;
    if (!verifyHmac(dev.hmacSecret, msg, env.sigB64)) {
      logDeviceSecurityEvent({ kind: 'DEVICE_REJECTED', severity: 'CRITICAL', clubId: dev.clubId, deviceSessionId: null, payload: { reason: 'hmac_mismatch', deviceId } });
      throw new ForbiddenError('Invalid device signature');
    }
    if (!assertFreshAndRemember(`biomech:${dev.id}`, env.nonce)) {
      logDeviceSecurityEvent({ kind: 'DEVICE_REPLAY', severity: 'CRITICAL', clubId: dev.clubId, payload: { reason: 'nonce_reused', deviceId } });
      throw new UnauthorizedError('Nonce already used');
    }
  }

  const ts = env.payload.deviceTsMs;
  if (typeof ts !== 'number' || ts < 0) throw new BadRequestError('payload.deviceTsMs required');
  if (Math.abs(Date.now() - ts) > 5 * 60_000) {
    logDeviceSecurityEvent({ kind: 'DEVICE_TS_SKEW', severity: 'WARN', clubId: dev.clubId, payload: { deviceId, skewMs: Date.now() - ts } });
    throw new ForbiddenError('Biomech clock skew exceeds 5 min');
  }

  return prisma.biomechanicalPacket.create({
    data: {
      clubId:        actor.clubId,
      matchId:       env.matchId ?? null,
      playerId:      env.playerId ?? null,
      deviceId:      dev.id,
      monotonicMs:   BigInt(Date.now()),
      deviceTsMs:    BigInt(ts),
      lactateMmol:   env.payload.lactateMmol ?? null,
      glucoseMg:     env.payload.glucoseMg ?? null,
      hydrationPct:  env.payload.hydrationPct ?? null,
      cortisolProxy: env.payload.cortisolProxy ?? null,
      payload:       (env.payload.extra ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      sigB64:        env.sigB64 ?? null,
      nonce:         env.nonce ?? null,
    },
  });
}

export async function listBiomechPackets(actor: BiomechActor, opts: { matchId?: string; playerId?: string; deviceId?: string; fromMs?: number; toMs?: number; limit?: number } = {}) {
  return prisma.biomechanicalPacket.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.matchId  ? { matchId: opts.matchId } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(opts.fromMs   ? { monotonicMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs     ? { monotonicMs: { lte: BigInt(opts.toMs) } }   : {}),
    },
    orderBy: { monotonicMs: 'desc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  }).then((rows) => rows.map((r) => ({ ...r, monotonicMs: r.monotonicMs.toString(), deviceTsMs: r.deviceTsMs.toString() })));
}
