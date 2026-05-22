// Familista — Device authentication (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// HMAC handshake → short-lived device JWT.
//
// 1. Operator/coach opens a DeviceSession via POST /api/v1/devices/sessions.
//    Server issues sessionKey (32 random bytes, base64). Caller writes it
//    to the device at provisioning time.
//
// 2. The device authenticates itself by computing:
//       sig = base64( HMAC-SHA256(sessionKey, ts + "." + nonce) )
//    where ts is unix-seconds, nonce is a random 16-byte string.
//
// 3. The device posts { deviceSessionId, ts, nonce, sig } to
//    /api/v1/devices/auth/token. Server reproduces the HMAC and, if it
//    matches, issues a device JWT scoped to that session for up to 4h.
//
// 4. The device sends `Authorization: Bearer <deviceJwt>` on every
//    /devices/sessions/:id/packets call. Tenant (clubId, teamId) is loaded
//    server-side from the session — the device never sends them.
//
// Patentable boundary preserved.

import { createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { config } from '../config';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';

const MAX_HANDSHAKE_SKEW_SEC = 5 * 60;       // ±5 min clock skew
const DEVICE_JWT_TTL_SEC     = 60 * 60 * 4;  // 4 hours

export interface DeviceAuthRequest {
  deviceSessionId: string;
  ts:              number;   // unix seconds
  nonce:           string;   // ≥16 chars
  sig:             string;   // base64 HMAC
}

export interface DeviceAuthIssued {
  token:     string;
  expiresAt: string;
  sessionId: string;
  deviceModel:  string;
  deviceSerial: string;
}

export interface DeviceJwtPayload {
  sub:     string;            // deviceSessionId
  clubId:  string;
  teamId?: string | null;
  matchId?: string | null;
  trainingSessionId?: string | null;
  deviceModel:  string;
  deviceSerial: string;
  kind:    'device';
  iat:     number;
  exp:     number;
}

function verifyHmac(secretB64: string, message: string, suppliedSigB64: string): boolean {
  const secret = Buffer.from(secretB64, 'base64');
  const expected = createHmac('sha256', secret).update(message).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(suppliedSigB64, 'base64'); }
  catch { return false; }
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

export async function issueDeviceToken(req: DeviceAuthRequest): Promise<DeviceAuthIssued> {
  if (!req.deviceSessionId || !req.ts || !req.nonce || !req.sig) {
    throw new BadRequestError('deviceSessionId, ts, nonce, sig are all required');
  }
  if (typeof req.nonce !== 'string' || req.nonce.length < 16 || req.nonce.length > 128) {
    throw new BadRequestError('nonce must be 16..128 chars');
  }

  // Clock skew check — protect against stale replay.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - req.ts) > MAX_HANDSHAKE_SKEW_SEC) {
    throw new UnauthorizedError('Clock skew exceeds allowed window');
  }

  const session = await prisma.deviceSession.findUnique({
    where: { id: req.deviceSessionId },
    select: {
      id: true, clubId: true, teamId: true, matchId: true, trainingSessionId: true,
      deviceModel: true, deviceSerial: true,
      sessionKey: true, endedAt: true,
    },
  });
  if (!session)            throw new NotFoundError('DeviceSession');
  if (session.endedAt)     throw new ForbiddenError('Session is closed');
  if (!session.sessionKey) throw new ForbiddenError('Session has no key (legacy session — re-open)');

  const message = `${req.ts}.${req.nonce}`;
  if (!verifyHmac(session.sessionKey, message, req.sig)) {
    throw new UnauthorizedError('Invalid device signature');
  }

  const payload: DeviceJwtPayload = {
    sub:               session.id,
    clubId:            session.clubId,
    teamId:            session.teamId,
    matchId:           session.matchId,
    trainingSessionId: session.trainingSessionId,
    deviceModel:       session.deviceModel,
    deviceSerial:      session.deviceSerial,
    kind:              'device',
    iat:               now,
    exp:               now + DEVICE_JWT_TTL_SEC,
  };

  const token = jwt.sign(payload, config.jwt.secret, { algorithm: 'HS256' });

  return {
    token,
    expiresAt:    new Date((now + DEVICE_JWT_TTL_SEC) * 1000).toISOString(),
    sessionId:    session.id,
    deviceModel:  session.deviceModel,
    deviceSerial: session.deviceSerial,
  };
}

export function verifyDeviceToken(token: string): DeviceJwtPayload {
  try {
    const payload = jwt.verify(token, config.jwt.secret) as DeviceJwtPayload;
    if (payload.kind !== 'device') throw new UnauthorizedError('Not a device token');
    return payload;
  } catch (err) {
    if ((err as { name?: string })?.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Device token expired');
    }
    throw new UnauthorizedError('Invalid device token');
  }
}
