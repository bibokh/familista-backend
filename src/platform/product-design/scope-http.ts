/**
 * Familista Design Studio — what every club or creator route handler needs from the request: the tenant the routes
 * resolved on the server (res.locals.designScope, set from the session, never from the request), and who is acting.
 */
import type { Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import type { Tenant } from '../tenancy/tenant';
import { tenantOfScope, type DesignActor, type DesignScope } from './service';

export function tenantOfRes(res: Response): Tenant {
  return tenantOfScope(res.locals.designScope as DesignScope | undefined);
}

/** The acting person: the club user, or the creator. `role` is a club user's role; a creator has none. */
export function designActorOf(req: Request): DesignActor & { role?: UserRole } {
  const ua = req.headers['user-agent'];
  return {
    userId: req.user?.id ?? req.creator?.id ?? '', role: req.user?.role as UserRole | undefined,
    ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null,
  };
}
