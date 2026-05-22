// Familista — Security Event log (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// Lightweight, fire-and-forget feed of security signals. Distinct from
// the SecurityAuditEvent chain because volume is much higher and these
// rows are NOT chained — losing one is fine; tampering is the chain's job.
//
// Use cases:
//   - failed/locked logins, IP burst
//   - rate-limit hits
//   - device packet rejections (HMAC, replay, ts skew)
//   - prompt-injection suspects (heuristic flagged AI input)
//   - tenant-mismatch attempts
//
// NEVER throws back into the caller — every emit is best-effort.

import { Prisma, SecurityEventKind, SecuritySeverity } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export interface SecurityEventInput {
  kind:      SecurityEventKind;
  severity?: SecuritySeverity;
  clubId?:   string | null;
  actorId?:  string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  payload?:  unknown;
}

export function logSecurityEvent(input: SecurityEventInput): void {
  // Fire-and-forget — never block hot paths on this write.
  prisma.securityEvent.create({
    data: {
      kind:      input.kind,
      severity:  input.severity ?? 'INFO',
      clubId:    input.clubId ?? null,
      actorId:   input.actorId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      payload:   (input.payload ?? null) as Prisma.InputJsonValue,
    },
  }).catch((err) => {
    logger.warn('[security-event] write failed', { kind: input.kind, err: (err as Error).message });
  });
}

export interface ListEventsOpts {
  clubId?:   string;
  actorId?:  string;
  kind?:     SecurityEventKind;
  severity?: SecuritySeverity;
  fromTs?:   Date | null;
  toTs?:     Date | null;
  page?:     number;
  limit?:    number;
}

export async function listSecurityEvents(opts: ListEventsOpts = {}) {
  const { page = 1, limit = 100 } = opts;
  const where: Prisma.SecurityEventWhereInput = {
    ...(opts.clubId  ? { clubId:  opts.clubId }  : {}),
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
    ...(opts.kind    ? { kind:    opts.kind }    : {}),
    ...(opts.severity ? { severity: opts.severity } : {}),
    ...((opts.fromTs || opts.toTs) ? {
      createdAt: {
        ...(opts.fromTs ? { gte: opts.fromTs } : {}),
        ...(opts.toTs   ? { lte: opts.toTs }   : {}),
      },
    } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.securityEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 500),
    }),
    prisma.securityEvent.count({ where }),
  ]);
  return { items, total, page, limit };
}

/** Rate of events of `kind` in the trailing window for a given clubId. */
export async function recentRate(clubId: string | undefined, kind: SecurityEventKind, windowMs: number): Promise<number> {
  return prisma.securityEvent.count({
    where: {
      kind,
      ...(clubId ? { clubId } : {}),
      createdAt: { gte: new Date(Date.now() - windowMs) },
    },
  });
}

/** Same for device-side events. */
export function logDeviceSecurityEvent(input: SecurityEventInput & { deviceSessionId?: string | null; cameraId?: string | null }): void {
  prisma.deviceSecurityEvent.create({
    data: {
      kind:            input.kind,
      severity:        input.severity ?? 'WARN',
      clubId:          input.clubId ?? null,
      deviceSessionId: input.deviceSessionId ?? null,
      cameraId:        input.cameraId ?? null,
      payload:         (input.payload ?? null) as Prisma.InputJsonValue,
    },
  }).catch((err) => {
    logger.warn('[security-event:device] write failed', { kind: input.kind, err: (err as Error).message });
  });
}
