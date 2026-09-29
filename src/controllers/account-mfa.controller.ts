// The platform owner's two-step sign-in, as their Settings screen uses it
// ─────────────────────────────────────────────────────────────────────────────
// Cyber Defense, Step 6: enrolment and recovery codes. Step 7 adds the owner's
// switch to require a code at every sign-in (`auth-prod/mfa-enforcement`),
// switched on only with a working app code AND a working recovery code.
//
// Mounted under /auth/mfa, each route behind `authenticate` and the owner check
// below. The lifecycle itself is `auth-prod/mfa.service.ts`.
//
// A response that carries a secret or recovery codes is marked `no-store`, so
// no cache between here and the browser keeps a copy.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as mfa from '../auth-prod/mfa.service';
import * as mfaEnforcement from '../auth-prod/mfa-enforcement.service';
import { sendSuccess, sendCreated } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });

function codeOf(req: Request): string {
  const parsed = codeSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new BadRequestError('code: a 6-digit code or a recovery code is required');
  return parsed.data.code;
}

function actorOf(req: Request): mfa.MfaActor {
  return { userId: req.user!.id, clubId: req.user!.clubId, role: String(req.user!.role) };
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/** The platform owner only: SUPER_ADMIN or an active PlatformAdmin, as `authenticate` resolved it. */
export function requirePlatformOwner(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.isPlatformOwner) return next();
  next(new ForbiddenError('Two-step sign-in setup here is for the platform owner'));
}

export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const [st, enf] = await Promise.all([mfa.mfaStatus(req.user!.id), mfaEnforcement.enforcementStatus(req.user!.id)]);
    return sendSuccess(res, { ...st, enforced: enf.enforced });
  } catch (err) { return next(err); }
}

export async function enroll(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await mfa.enrollTOTP(actorOf(req), String(req.user!.email ?? 'Familista'));
    noStore(res);
    return sendCreated(res, out, 'Add this key to your authenticator app, then confirm with a code.');
  } catch (err) { return next(err); }
}

export async function confirm(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await mfa.confirmTOTP(actorOf(req), codeOf(req));
    noStore(res);
    return sendCreated(res, out, 'Two-step sign-in is on. Save the recovery codes now.');
  } catch (err) { return next(err); }
}

export async function recoveryCodes(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await mfa.regenerateRecoveryCodes(actorOf(req), codeOf(req));
    noStore(res);
    return sendCreated(res, out, 'New recovery codes issued. The previous ones no longer work.');
  } catch (err) { return next(err); }
}

export async function disable(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await mfa.disableMFA(actorOf(req), codeOf(req));
    // Off means off: no requirement is left stored behind it.
    await mfaEnforcement.clearEnforcement(actorOf(req));
    return sendSuccess(res, out, 'Two-step sign-in is off.');
  } catch (err) { return next(err); }
}

const enforcementSchema = z.discriminatedUnion('enabled', [
  z.object({
    enabled: z.literal(true),
    code: z.string().trim().min(6).max(32),
    recoveryCode: z.string().trim().min(6).max(32),
  }),
  z.object({ enabled: z.literal(false), code: z.string().trim().min(6).max(32) }),
]);

/**
 * POST /auth/mfa/enforcement — require (or stop requiring) a code at sign-in.
 * On: a current app code and one recovery code, both checked. Off: one code.
 */
export async function enforcement(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = enforcementSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError('enabled, code and (to switch on) recoveryCode are required');
    const b = parsed.data;
    const out = b.enabled
      ? await mfaEnforcement.enableEnforcement(actorOf(req), b.code, b.recoveryCode)
      : await mfaEnforcement.disableEnforcement(actorOf(req), b.code);
    noStore(res);
    return sendSuccess(res, out, b.enabled ? 'A code is now required at sign-in.' : 'A code is no longer required at sign-in.');
  } catch (err) { return next(err); }
}
