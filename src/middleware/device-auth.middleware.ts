// Familista — Device authentication middleware (Phase C)
//
// Two flavours:
//   * requireDevice         — REJECTS unless caller presents a valid DEVICE JWT.
//   * acceptUserOrDevice    — accepts EITHER a user JWT (Authorization: Bearer …)
//                              OR a device JWT. Inspects the token's `kind` field
//                              to pick the right verification path.
//                              On success populates either req.user OR req.device
//                              and req.clubId.

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyDeviceToken, DeviceJwtPayload } from '../services/device-auth.service';
import { prisma } from '../config/database';
import { config } from '../config';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import type { UserRole } from '@prisma/client';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: DeviceJwtPayload;
    }
  }
}

interface UserJwtPayload {
  sub: string; email: string; role: UserRole; clubId: string;
  iat: number; exp: number;
  kind?: string;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

async function verifyUserToken(tok: string, req: Request): Promise<void> {
  let payload: UserJwtPayload;
  try { payload = jwt.verify(tok, config.jwt.secret) as UserJwtPayload; }
  catch { throw new UnauthorizedError('Invalid or expired token'); }

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true },
    select: {
      id: true, email: true, role: true, clubId: true, isActive: true,
      currentClubId: true, currentTeamId: true,
    },
  });
  if (!user) throw new UnauthorizedError('User not found or deactivated');
  const effectiveClubId = user.currentClubId ?? user.clubId;

  req.user = {
    id: user.id,
    email: user.email,
    role: user.role,
    clubId: effectiveClubId,
    primaryClubId: user.clubId,
    currentClubId: user.currentClubId ?? null,
    currentTeamId: user.currentTeamId ?? null,
  } as Express.Request['user'];
  req.clubId = effectiveClubId;
}

async function verifyDeviceTokenAndAttach(tok: string, req: Request): Promise<void> {
  const payload = verifyDeviceToken(tok);
  const session = await prisma.deviceSession.findUnique({
    where: { id: payload.sub },
    select: { id: true, clubId: true, endedAt: true },
  });
  if (!session)                          throw new UnauthorizedError('Device session not found');
  if (session.endedAt)                   throw new ForbiddenError('Device session is closed');
  if (session.clubId !== payload.clubId) throw new ForbiddenError('Device session tenant mismatch');

  req.device = payload;
  req.clubId = payload.clubId;
}

export async function requireDevice(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const tok = extractToken(req);
    if (!tok) throw new UnauthorizedError('Device token required');
    await verifyDeviceTokenAndAttach(tok, req);
    next();
  } catch (err) { next(err); }
}

// User OR device. Detects the token type by decoding the payload first
// (cheap, no signature check) and then routes to the right verifier.
export async function acceptUserOrDevice(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (req.user) return next();                        // already authenticated upstream

    const tok = extractToken(req);
    if (!tok) throw new UnauthorizedError('Token required');

    // Peek at the payload to decide which verifier to use.
    let decoded: { kind?: string } | null = null;
    try { decoded = jwt.decode(tok) as { kind?: string } | null; } catch { /* ignore */ }
    if (decoded && decoded.kind === 'device') {
      await verifyDeviceTokenAndAttach(tok, req);
    } else {
      await verifyUserToken(tok, req);
    }
    next();
  } catch (err) { next(err); }
}
