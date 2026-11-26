/**
 * Familista Creator Studio (P2) — the HTTP handlers of a creator's account: sign-up by invitation, sign-in, the session's
 * refresh and end, the address and password links, the profile; and the Platform Owner's invitations. Validation is here
 * (zod, strict), the rules are in account.service.ts. A token goes out in an HttpOnly cookie and in the body (for API
 * clients); the refresh token only in its HttpOnly cookie, restricted to the creator's auth path.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { emailConfiguration } from '../email/service';
import { publicOffer } from '../commercial/readiness.service';
import {
  changePassword, createInvite, CreatorEmailTakenError, CreatorInputError, CreatorInviteError, CreatorLinkError, listCreators, listInvites, login, logout,
  me, minimumAge, ownerSetStatus, ownerVerifyEmail, refresh, register, requestPasswordReset, requestVerification, resetPassword, revokeInvite, updateProfile, verifyEmail,
  type CreatorSessionTokens, type Ctx,
} from './account.service';
import { CREATOR_ACCESS_COOKIE, CREATOR_REFRESH_COOKIE } from './authenticate';
import { CreatorDeletionRefused, deleteAccount, exportAccount } from './privacy.service';

const SAME_SITE = config.isProd ? ('none' as const) : ('lax' as const);
const ACCESS_COOKIE = { httpOnly: true, secure: config.isProd, sameSite: SAME_SITE, path: '/api/v1/creator' };
const REFRESH_COOKIE = { httpOnly: true, secure: config.isProd, sameSite: SAME_SITE, path: '/api/v1/creator/auth' };

function ctxOf(req: Request): Ctx {
  const ua = req.headers['user-agent'];
  return { ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function signIn(res: Response, s: CreatorSessionTokens) {
  res.cookie(CREATOR_ACCESS_COOKIE, s.accessToken, { ...ACCESS_COOKIE, maxAge: s.expiresIn * 1000 });
  res.cookie(CREATOR_REFRESH_COOKIE, s.refreshToken, { ...REFRESH_COOKIE, expires: s.refreshExpiresAt });
  return { accessToken: s.accessToken, expiresIn: s.expiresIn };
}
function signOut(res: Response) {
  res.clearCookie(CREATOR_ACCESS_COOKIE, ACCESS_COOKIE);
  res.clearCookie(CREATOR_REFRESH_COOKIE, REFRESH_COOKIE);
}
const refreshOf = (req: Request): string | undefined => (req.cookies as Record<string, string> | undefined)?.[CREATOR_REFRESH_COOKIE];

function handler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await work(req, res); } catch (err) {
      if (err instanceof CreatorInputError) { res.status(400).json({ success: false, code: err.code, reason: err.reason, path: err.path }); return; }
      if (err instanceof CreatorInviteError || err instanceof CreatorLinkError) { res.status(403).json({ success: false, code: err.code, reason: (err as CreatorInviteError).reason ?? null, message: err.message }); return; }
      if (err instanceof CreatorEmailTakenError) { res.status(409).json({ success: false, code: err.code, message: err.message }); return; }
      if (err instanceof CreatorDeletionRefused) { res.status(409).json({ success: false, code: err.code, reason: err.reason, data: { orders: err.orders }, message: err.message }); return; }
      next(err);
    }
  };
}

const Str = (max: number) => z.string().max(max);
const RegisterBody = z.object({ inviteCode: Str(64), email: Str(254), password: Str(200), displayName: Str(200), locale: Str(16).optional(), ageConfirmed: z.boolean() }).strict();
const LoginBody = z.object({ email: Str(254), password: Str(200) }).strict();
const TokenBody = z.object({ token: Str(200) }).strict();
const ResetBody = z.object({ token: Str(200), password: Str(200) }).strict();
const EmailBody = z.object({ email: Str(254) }).strict();
const ProfileBody = z.object({ displayName: Str(200).optional(), locale: Str(16).optional() }).strict();
const PasswordBody = z.object({ currentPassword: Str(200), newPassword: Str(200) }).strict();
const DeleteBody = z.object({ password: Str(200) }).strict();
const InviteBody = z.object({ email: Str(254).nullable().optional(), note: Str(400).nullable().optional(), maxUses: z.number().int().optional(), days: z.number().int().optional() }).strict();
const Id = z.string().guid();
const NoteBody = z.object({ note: Str(400) }).strict();

/**
 * What a sign-up page needs before anyone has an account: it is open by invitation, the age to confirm, and whether the
 * platform can send email at all (so the page says so rather than promising a link that cannot come).
 */
export const creatorSignupTerms = handler(async (_req, res) => {
  // P8: the plans on offer to creators and the services configured now: what the sign-in page shows anyone, and nothing
  // about any account, club, supplier or person.
  const offer = await publicOffer();
  res.json({ success: true, data: { signup: 'invitation', minimumAge: minimumAge(), email: emailConfiguration().configured, offer } });
});
export const creatorRegister = handler(async (req, res) => {
  const out = await register(RegisterBody.parse(req.body), ctxOf(req));
  res.status(201).json({ success: true, data: { creator: out.creator, ...signIn(res, out.session), verification: out.verification } });
});
export const creatorLogin = handler(async (req, res) => {
  const out = await login(LoginBody.parse(req.body), ctxOf(req));
  res.json({ success: true, data: { creator: out.creator, ...signIn(res, out.session) } });
});
export const creatorRefresh = handler(async (req, res) => {
  try { res.json({ success: true, data: signIn(res, await refresh(refreshOf(req) ?? '')) }); } catch (err) { signOut(res); throw err; }
});
export const creatorLogout = handler(async (req, res) => {
  await logout(refreshOf(req));
  signOut(res);
  res.json({ success: true, data: { signedOut: true } });
});
export const creatorVerifyEmail = handler(async (req, res) => {
  res.json({ success: true, data: await verifyEmail(TokenBody.parse(req.body).token, ctxOf(req)) });
});
export const creatorForgotPassword = handler(async (req, res) => {
  res.status(202).json({ success: true, data: await requestPasswordReset(EmailBody.parse(req.body).email, ctxOf(req)) });
});
export const creatorResetPassword = handler(async (req, res) => {
  const b = ResetBody.parse(req.body);
  res.json({ success: true, data: await resetPassword(b.token, b.password, ctxOf(req)) });
});

// Behind authenticateCreator: req.creator is set.
const meId = (req: Request) => (req.creator as { id: string }).id;
export const creatorMe = handler(async (req, res) => { res.json({ success: true, data: await me(meId(req)) }); });
export const creatorUpdateProfile = handler(async (req, res) => {
  res.json({ success: true, data: await updateProfile(meId(req), ProfileBody.parse(req.body), ctxOf(req)) });
});
export const creatorChangePassword = handler(async (req, res) => {
  const out = await changePassword(meId(req), PasswordBody.parse(req.body), ctxOf(req));
  res.json({ success: true, data: signIn(res, out.session) });
});
export const creatorResendVerification = handler(async (req, res) => {
  res.json({ success: true, data: await requestVerification(meId(req), ctxOf(req)) });
});
/** P3: a copy of everything the platform keeps for the account, as one JSON file. */
export const creatorExport = handler(async (req, res) => {
  const out = await exportAccount(meId(req), ctxOf(req));
  res.setHeader('Content-Disposition', `attachment; filename="familista-creator-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ success: true, data: out });
});
/** P3: delete the account, confirmed with the password; signed out at once. */
export const creatorDeleteAccount = handler(async (req, res) => {
  const out = await deleteAccount(meId(req), DeleteBody.parse(req.body).password, ctxOf(req));
  signOut(res);
  res.json({ success: true, data: out });
});

// The Platform Owner's, behind authenticate + assertPlatformOwner.
const ownerId = (req: Request) => req.user?.id ?? '';
export const ownerListCreatorInvites = handler(async (_req, res) => { res.json({ success: true, data: await listInvites() }); });
export const ownerCreateCreatorInvite = handler(async (req, res) => {
  res.status(201).json({ success: true, data: await createInvite({ userId: ownerId(req) }, InviteBody.parse(req.body), ctxOf(req)) });
});
export const ownerRevokeCreatorInvite = handler(async (req, res) => {
  res.json({ success: true, data: await revokeInvite({ userId: ownerId(req) }, Id.parse(req.params.inviteId), ctxOf(req)) });
});
export const ownerListCreators = handler(async (_req, res) => { res.json({ success: true, data: await listCreators() }); });
export const ownerVerifyCreatorEmail = handler(async (req, res) => {
  res.json({ success: true, data: await ownerVerifyEmail({ userId: ownerId(req) }, Id.parse(req.params.creatorId), NoteBody.parse(req.body).note, ctxOf(req)) });
});
export const ownerSuspendCreator = handler(async (req, res) => {
  res.json({ success: true, data: await ownerSetStatus({ userId: ownerId(req) }, Id.parse(req.params.creatorId), 'SUSPENDED', NoteBody.parse(req.body).note, ctxOf(req)) });
});
export const ownerReinstateCreator = handler(async (req, res) => {
  res.json({ success: true, data: await ownerSetStatus({ userId: ownerId(req) }, Id.parse(req.params.creatorId), 'ACTIVE', NoteBody.parse(req.body).note, ctxOf(req)) });
});
