import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../config/database';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  clubId: string;
  iat: number;
  exp: number;
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Cookie-first: prefer HttpOnly access_token cookie (browser SPA).
    // Fall back to Authorization: Bearer <token> for API clients and WebSocket.
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.access_token;
    const authHeader  = req.headers.authorization;

    let token: string;
    if (cookieToken) {
      token = cookieToken;
    } else if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      throw new UnauthorizedError('No token provided');
    }
    let payload: JwtPayload;

    try {
      payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Verify user still exists and is active
    const user = await prisma.user.findFirst({
      where: { id: payload.sub, isActive: true },
      select: {
        id: true, email: true, role: true, clubId: true, isActive: true,
        // Phase A: active multi-tenant context
        currentClubId: true,
        currentTeamId: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('User not found or deactivated');
    }

    // Effective tenant: whatever the user picked in their context, falling
    // back to their legacy primary clubId. Existing code keeps working.
    const effectiveClubId = user.currentClubId ?? user.clubId;

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      clubId: effectiveClubId,
      // Phase A extensions (typed loosely so legacy callers ignore them)
      primaryClubId: user.clubId,
      currentClubId: user.currentClubId ?? null,
      currentTeamId: user.currentTeamId ?? null,
    } as Express.Request['user'];
    req.clubId = effectiveClubId;

    next();
  } catch (err) {
    next(err);
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }

    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `Role '${req.user.role}' is not authorized for this action`
        )
      );
    }

    next();
  };
}

// Verify club ownership — ensures tenant isolation
export function ensureClubAccess(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const { clubId: paramClubId } = req.params;

  if (
    req.user?.role !== UserRole.SUPER_ADMIN &&
    paramClubId &&
    paramClubId !== req.user?.clubId
  ) {
    return next(new ForbiddenError('Access denied to this club'));
  }

  next();
}
