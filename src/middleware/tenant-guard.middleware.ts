// Familista — Tenant Guard middleware (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// Defence-in-depth tenant assertion. Existing services already enforce
// clubId on every read/write; this middleware adds a second wall:
//
//   - For routes that carry a tenant-scoped param (matchId, playerId,
//     teamId, deviceSessionId, cameraId, jobId, alertId, recommendationId),
//     resolve the parent row's clubId once and compare to req.user.clubId.
//
//   - A mismatch is logged to SecurityEvent (TENANT_MISMATCH) and refused
//     with 403 BEFORE the service ever runs.
//
// SUPER_ADMIN bypasses the comparison but a TENANT_MISMATCH event is
// still emitted at INFO level for audit visibility.

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { logSecurityEvent } from '../security/security-event.service';

interface Lookup {
  param: string;
  loader: (id: string) => Promise<{ clubId: string } | null>;
}

// Resolvers keyed by the express route param. Add more as routes grow.
const LOOKUPS: Lookup[] = [
  { param: 'matchId',         loader: (id) => prisma.match.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'teamId',          loader: (id) => prisma.team.findUnique({  where: { id }, select: { clubId: true } }) },
  { param: 'playerId',        loader: (id) => prisma.player.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'deviceSessionId', loader: (id) => prisma.deviceSession.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'cameraId',        loader: (id) => prisma.camera.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'alertId',         loader: (id) => prisma.aIAlert.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'jobId',           loader: (id) => prisma.aIAgentJob.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'approvalId',      loader: (id) => prisma.aIApprovalRequest.findUnique({ where: { id }, select: { clubId: true } }) },
];

function ipOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  return typeof xff === 'string' ? xff.split(',')[0].trim() : (req.ip || 'unknown');
}

/**
 * Defence-in-depth tenant guard. NEVER mutates request data; only refuses.
 * Designed to be cheap: 0 DB hits when no tenant-scoped param is present,
 * 1 hit otherwise.
 */
export async function tenantGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = (req as Request & { user?: { id: string; clubId: string; role?: string } }).user;
  if (!u) return next();   // unauthenticated path — defer to authenticate

  try {
    for (const { param, loader } of LOOKUPS) {
      const value = req.params[param];
      if (!value) continue;
      const row = await loader(value);
      if (!row) continue;  // 404 will surface from the service
      if (row.clubId !== u.clubId && u.role !== 'SUPER_ADMIN') {
        logSecurityEvent({
          kind:      'TENANT_MISMATCH',
          severity:  'CRITICAL',
          clubId:    u.clubId,
          actorId:   u.id,
          ipAddress: ipOf(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          payload:   { route: req.originalUrl, param, value, attemptedClub: row.clubId },
        });
        res.status(403).json({ success: false, message: 'Forbidden — tenant mismatch' });
        return;
      }
      if (u.role === 'SUPER_ADMIN' && row.clubId !== u.clubId) {
        // Still log super-admin cross-club reads at INFO.
        logSecurityEvent({
          kind:      'TENANT_MISMATCH',
          severity:  'INFO',
          clubId:    u.clubId,
          actorId:   u.id,
          ipAddress: ipOf(req),
          payload:   { route: req.originalUrl, param, value, viaRole: 'SUPER_ADMIN', attemptedClub: row.clubId },
        });
      }
    }
    next();
  } catch (err) {
    // Never block on guard failure; log and continue. Underlying service
    // checks remain authoritative.
    logSecurityEvent({
      kind:    'SUSPICIOUS_PAYLOAD',
      severity:'INFO',
      payload: { source: 'tenant-guard', err: (err as Error).message },
    });
    next();
  }
}
