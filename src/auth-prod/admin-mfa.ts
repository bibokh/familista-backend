// Cyber Defense, R7 — administrators sign in with a second factor
// ─────────────────────────────────────────────────────────────────────────────
// Step 7 let one person (the platform owner) choose to require a code at
// sign-in. An administrator account — SUPER_ADMIN, CLUB_ADMIN — can change a
// club's members, roles and data, so for those accounts the choice is the
// platform's, not the person's. It is behind one switch the operator turns on:
//
//   MFA_REQUIRED_FOR_ADMINS=true
//
// Off (the default), nothing here changes anything. On:
//
//   · an administrator who has enrolled must give a code at every sign-in —
//     the same challenge Step 7 uses (`loginSecondFactor`);
//   · an administrator who has NOT enrolled still signs in, but the session is
//     SETUP-ONLY: it can read who it is, sign out and enrol, and every other
//     request answers 403 MFA_ENROLMENT_REQUIRED. Refusing the sign-in instead
//     would leave no way to enrol;
//   · an administrator session that did not pass a code (minted before the
//     switch, or setup-only and since enrolled) is refused with 401, so the
//     next sign-in asks for the code;
//   · an administrator cannot turn their own two-step sign-in off.
//
// "Passed a code" is the token's `mfa: true` claim, set only by
// `completeMfaLogin` and carried by refresh — never by the password step.

import { UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

export const ADMIN_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.CLUB_ADMIN];

/** Read on every call, so the switch needs no code path of its own. */
export function adminMfaRequired(): boolean {
  return process.env.MFA_REQUIRED_FOR_ADMINS === 'true';
}

export function isAdminRole(role: UserRole | string | null | undefined): boolean {
  return ADMIN_ROLES.includes(role as UserRole);
}

/** True when the platform requires a second factor of this account's role. */
export function roleRequiresMfa(role: UserRole | string | null | undefined): boolean {
  return adminMfaRequired() && isAdminRole(role);
}

interface EnrolmentShape { method: string; enabledAt: Date | null; secretEncrypted?: string | null }

export function isEnrolled(s: EnrolmentShape | null | undefined): boolean {
  return !!(s && s.enabledAt && s.method !== 'NONE');
}

/**
 * What a session may do:
 *   full        anything its role allows
 *   setup-only  enrol, read itself, sign out — nothing else
 *   reauth      nothing: sign in again, with the code
 */
export type SessionMfaState = 'full' | 'setup-only' | 'reauth';

export function sessionMfaState(role: UserRole | string, passedCode: boolean, enrolled: boolean): SessionMfaState {
  if (!roleRequiresMfa(role) || passedCode) return 'full';
  return enrolled ? 'reauth' : 'setup-only';
}

/** Reads the enrolment only when the answer depends on it. */
export async function resolveSessionMfaState(userId: string, role: UserRole | string, passedCode: boolean): Promise<SessionMfaState> {
  if (!roleRequiresMfa(role) || passedCode) return 'full';
  const s = await prisma.mFASetting.findUnique({ where: { userId }, select: { method: true, enabledAt: true } });
  return sessionMfaState(role, passedCode, isEnrolled(s));
}

/**
 * The requests a setup-only session may make, as `METHOD path` below the API
 * prefix (/api/<version>). Exact matches only.
 */
export const SETUP_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'GET /auth/me',
  'POST /auth/logout',
  'GET /auth/mfa',
  'POST /auth/mfa/enroll',
  'POST /auth/mfa/confirm',
]);

export const MFA_ENROLMENT_REQUIRED = 'MFA_ENROLMENT_REQUIRED';
export const MFA_REAUTH_REQUIRED = 'MFA_REAUTH_REQUIRED';

export class MfaEnrolmentRequiredError extends ForbiddenError {
  public readonly code = MFA_ENROLMENT_REQUIRED;
  constructor() { super('Set up two-step sign-in to continue. It is required for administrator accounts.'); }
}

export class MfaReauthRequiredError extends UnauthorizedError {
  public readonly code = MFA_REAUTH_REQUIRED;
  constructor() { super('Sign in again with your authentication code.'); }
}

/** Throws unless a session in `state` may make `method path`. */
export function assertSessionMayProceed(state: SessionMfaState, method: string, path: string): void {
  if (state === 'full') return;
  if (state === 'reauth') throw new MfaReauthRequiredError();
  const clean = path.split('?')[0].replace(/^\/api\/[^/]+/, '').replace(/\/+$/, '');
  if (!SETUP_ONLY_ROUTES.has(`${method.toUpperCase()} ${clean}`)) throw new MfaEnrolmentRequiredError();
}
