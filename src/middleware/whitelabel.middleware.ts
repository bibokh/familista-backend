// Familista — White-label Engine
// File location: src/middleware/whitelabel.middleware.ts
//
// Middleware: role + plan gating for white-label admin endpoints,
// and a public rate limiter for the unauthenticated theme resolver.
//
// Depends on the existing auth middleware populating `req.user` with
// `{ id, clubId, role }`. SUPER_ADMIN bypasses the plan check.

import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

const ALLOWED_ROLES = new Set(['SUPER_ADMIN', 'CLUB_ADMIN']);

// Plans permitted to use white-label. BASIC is excluded — entitlement is enforced
// here independent of the broader licensing engine to make this module self-contained.
// If the licensing engine exposes a richer `assertFeature(clubId, 'WHITE_LABEL')`,
// swap this check for that call.
const ALLOWED_PLANS = new Set(['PRO', 'ACADEMY', 'ENTERPRISE']);
const ALLOWED_STATUSES = new Set(['ACTIVE', 'TRIALING']);

export async function requireWhiteLabelAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');

    if (!ALLOWED_ROLES.has(req.user.role)) {
      throw new ForbiddenError('Only club admins can manage white-label configuration');
    }

    // SUPER_ADMIN bypasses plan check (used for support / impersonation flows).
    if (req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    const club = await prisma.club.findUnique({
      where: { id: req.user.clubId },
      select: { plan: true, subscriptionStatus: true },
    });
    if (!club) throw new ForbiddenError('Club not found');

    if (!ALLOWED_PLANS.has(club.plan)) {
      throw new ForbiddenError(`White-label requires plan PRO or higher (current: ${club.plan})`);
    }
    if (!ALLOWED_STATUSES.has(club.subscriptionStatus)) {
      throw new ForbiddenError(`Subscription must be ACTIVE or TRIALING (current: ${club.subscriptionStatus})`);
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

// Lightweight rate limiter for the unauthenticated public theme resolver.
// Tuned to allow normal SPA boot traffic while resisting cheap enumeration.
export const publicThemeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.ip ??
    'unknown',
  message: { success: false, message: 'Too many theme resolution requests' },
});
