/**
 * Familista Creator Studio (P2) — the creator's twin of tenantParam: before a creator route's handler runs, a row its
 * path names is checked against the signed-in creator. A row of another creator, or of any club, is refused (403, and a
 * TENANT_MISMATCH security event); a row that does not exist is left to the service, which answers 404. The service
 * filters by the creator as well, and row-level security holds the same line underneath.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../config/database';
import { logSecurityEvent } from '../../security/security-event.service';

type Owned = Promise<{ clubId: string | null; creatorId: string | null } | null>;
const RESOURCES = {
  designProject: (id: string): Owned => prisma.designProject.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
  designBrandAsset: (id: string): Owned => prisma.designBrandAsset.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
  designRoster: (id: string): Owned => prisma.designRoster.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
  designCollection: (id: string): Owned => prisma.designCollection.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
  manufacturingRequest: (id: string): Owned => prisma.manufacturingRequest.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
  manufacturingQuote: (id: string): Owned => prisma.manufacturingQuote.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
  designReviewComment: (id: string): Owned => prisma.designReviewComment.findUnique({ where: { id }, select: { clubId: true, creatorId: true } }),
} as const;
export type CreatorResource = keyof typeof RESOURCES;

/** A `router.param` hook: the row the parameter names must be the signed-in creator's own. */
export function creatorOwns(resource: CreatorResource) {
  const load = RESOURCES[resource];
  return async (req: Request, res: Response, next: NextFunction, value: string): Promise<void> => {
    try {
      const me = req.creator?.id;
      if (!me) { res.status(401).json({ success: false, message: 'Sign in to the Creator Studio' }); return; }
      if (typeof value !== 'string' || !value) return next();
      const row = await load(value);
      if (row && row.creatorId !== me) {
        logSecurityEvent({ kind: 'TENANT_MISMATCH', severity: 'CRITICAL', actorId: me, ipAddress: req.ip ?? null,
          userAgent: req.headers['user-agent'] as string | undefined, payload: { route: req.originalUrl, resource, value, scope: 'CREATOR' } });
        res.status(403).json({ success: false, message: 'Forbidden — tenant mismatch' });
        return;
      }
      next();
    } catch (err) { next(err); }
  };
}

/** Steps that reach outside the platform (a quotation request) need an address the Owner can answer. */
export function requireVerifiedEmail(req: Request, res: Response, next: NextFunction): void {
  if (!req.creator?.emailVerified) {
    res.status(403).json({ success: false, code: 'CREATOR_EMAIL_UNVERIFIED', message: 'Confirm your email address first' });
    return;
  }
  next();
}
