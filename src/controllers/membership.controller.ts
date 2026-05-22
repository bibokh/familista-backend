// Familista — Membership controller (Phase A)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/membership.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const ROLES = [
  'CLUB_OWNER','CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST',
  'MEDICAL_STAFF','PHYSIO','SCOUT','FINANCE_MANAGER','PARENT','PLAYER','DEVICE',
] as const;

const grantSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
    teamId: z.string().uuid().nullable().optional(),
    role:   z.enum(ROLES),
  }),
});

const changeRoleSchema = z.object({
  body: z.object({
    role:   z.enum(ROLES),
    reason: z.string().max(500).optional(),
  }),
});

const listQuerySchema = z.object({
  query: z.object({
    userId:   z.string().uuid().optional(),
    teamId:   z.string().optional(),   // 'NULL' for club-wide
    role:     z.enum(ROLES).optional(),
    isActive: z.enum(['true','false']).optional(),
    page:     z.coerce.number().int().min(1).max(10_000).optional(),
    limit:    z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const auditQuerySchema = z.object({
  query: z.object({
    membershipId: z.string().uuid().optional(),
    page:         z.coerce.number().int().min(1).max(10_000).optional(),
    limit:        z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const revokeBodySchema = z.object({ body: z.object({ reason: z.string().max(500).optional() }) });

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

function actorOf(req: Request): svc.MembershipActor {
  if (!req.user) throw new BadRequestError('Authentication context missing');
  const xff = req.headers['x-forwarded-for'];
  const ip  = typeof xff === 'string' ? xff.split(',')[0]?.trim() : req.ip;
  return {
    userId:    req.user.id,
    clubId:    req.user.clubId,
    role:      req.user.role,
    ipAddress: ip ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
  };
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await svc.listMemberships(req.user!.clubId, {
      userId:   q.userId,
      teamId:   q.teamId,
      role:     q.role,
      isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
      page:     q.page,
      limit:    q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function grant(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = grantSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const m = await svc.grantMembership(actorOf(req), parsed.data.body);
    return sendCreated(res, m, 'Membership granted');
  } catch (err) { return next(err); }
}

export async function revoke(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = revokeBodySchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    await svc.revokeMembership(actorOf(req), req.params.id, reason);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function changeRole(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = changeRoleSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const m = await svc.changeRole(actorOf(req), req.params.id, parsed.data.body);
    return sendSuccess(res, m, 'Role changed');
  } catch (err) { return next(err); }
}

export async function listAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = auditQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.listAudit(req.user!.clubId, parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}
