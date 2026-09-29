// Platform authority as a route guard
// ─────────────────────────────────────────────────────────────────────────────
// Passes only the platform owner (the PlatformAdmin row `authenticate`
// resolved) or a SUPER_ADMIN account. No club role, however senior, gets
// through: what sits behind this guard is about the whole platform, not one
// club.

import { Request, Response, NextFunction } from 'express';
import { hasPlatformAuthority } from '../platform/access-levels';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

export function requirePlatformAuthority(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new UnauthorizedError());
  if (hasPlatformAuthority(req.user)) return next();
  next(new ForbiddenError('This action is limited to the platform owner'));
}
