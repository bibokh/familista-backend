// Club invitations — HTTP shim over identity/invitation.service.ts
//
// The club's own club id comes from the session on every path here; it is never
// read from a body or a query. The raw token is returned exactly once, to the
// caller who created or resent the invitation, so it can be mailed — it is not
// stored, not logged and not returned by any list.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { MembershipRole, ClubInvitationStatus } from '@prisma/client';
import * as invites from '../identity/invitation.service';
import { sendSuccess, sendCreated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const ROLES = Object.values(MembershipRole) as [MembershipRole, ...MembershipRole[]];

function actorOf(req: Request): invites.InviteActor {
  const u = req.user as unknown as { id: string; clubId: string; role?: string; email?: string };
  return {
    userId: u.id,
    clubId: u.clubId,
    role: u.role,
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
  };
}

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}

const createSchema = z.object({
  email: z.string().trim().email().max(200),
  role: z.enum(ROLES),
  teamId: z.string().uuid().nullable().optional(),
  message: z.string().trim().max(1000).nullable().optional(),
});

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw zerr(parsed.error);
    const out = await invites.createInvitation(actorOf(req), parsed.data);
    return sendCreated(res, out, 'Invitation created');
  } catch (err) { return next(err); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const status = typeof req.query.status === 'string'
      ? (req.query.status as ClubInvitationStatus) : undefined;
    const rows = await invites.listInvitations(actorOf(req).clubId, { status });
    return sendSuccess(res, { invitations: rows });
  } catch (err) { return next(err); }
}

export async function resend(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await invites.resendInvitation(actorOf(req), String(req.params.id));
    return sendSuccess(res, out, 'Invitation resent');
  } catch (err) { return next(err); }
}

export async function revoke(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const row = await invites.revokeInvitation(actorOf(req), String(req.params.id), reason);
    return sendSuccess(res, row, 'Invitation revoked');
  } catch (err) { return next(err); }
}

/**
 * What the link shows before anybody signs in. No session required — the token
 * is the only thing the caller has proved, and the answer is scoped to that:
 * the club, the role, the team and when the offer lapses.
 */
export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const token = String(req.query.token ?? req.params.token ?? '');
    return sendSuccess(res, await invites.previewInvitation(token));
  } catch (err) { return next(err); }
}

/** Accept as the signed-in account. The invited address must be this account's. */
export async function accept(req: Request, res: Response, next: NextFunction) {
  try {
    const token = String(req.body?.token ?? '');
    const u = req.user as unknown as { id: string; email: string };
    const out = await invites.acceptInvitation(
      {
        userId: u.id,
        email: u.email,
        ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string) ?? null,
      },
      token,
    );
    return sendSuccess(res, out, 'Invitation accepted');
  } catch (err) { return next(err); }
}
