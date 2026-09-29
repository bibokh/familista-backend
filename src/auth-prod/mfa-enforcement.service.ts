// Two-step sign-in, required at sign-in when the owner has asked for it
// ─────────────────────────────────────────────────────────────────────────────
// Cyber Defense, Step 7. Step 6 let the platform owner enrol an authenticator
// app and keep recovery codes; this makes the code part of signing in, for an
// account whose owner switched that on after proving both work.
//
// HOW SIGN-IN WORKS WHEN IT IS ON
//
//   1. POST /auth/login with the right password answers `mfaRequired` and a
//      sign-in challenge — no tokens, no cookies, nothing about the account.
//   2. POST /auth/login/mfa with that challenge and a code from the app (or a
//      recovery code) is the only way to a session.
//
// The challenge is a row, not process memory: 256 random bits handed to the
// browser once, stored only as a hash, valid for five minutes, good for five
// tries, and consumed atomically — so a restart, a second instance or two
// concurrent requests can neither reuse it nor stretch it. The code itself is
// checked by `mfa.service`, unchanged: its persistent wrong-code limit and its
// single-use rule for app codes apply here exactly as they do in Settings.
//
// FAILS CLOSED
//
// When enforcement is on and this server cannot check a code (no encryption
// key), sign-in answers 503 rather than skipping the second step. A database
// error answers 500 for the same reason. There is no path from "could not
// check" to "signed in".
//
// WHEN IT IS "ON"
//
// Only while enrolled, and only for the enrolment it was switched on under:
// `enforcedAt >= enabledAt`. Turning two-step sign-in off (any route) makes it
// inert, and enrolling again later does not quietly re-arm it.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { MFASetting } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, UnauthorizedError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { tagSecuritySignal } from '../cyber-defense/collectors';
import * as mfa from './mfa.service';

export const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;

/** Domain-separates a sign-in challenge from any other row in MFAChallenge. */
const HASH_PREFIX = 'familista:login-mfa:v1:';
const CHALLENGE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const APP_CODE_RE = /^\d{6}$/;

/** Every refusal of a challenge reads the same: which part failed is not said. */
export class LoginChallengeInvalidError extends UnauthorizedError {
  constructor() { super('Sign-in expired. Sign in again.'); }
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(HASH_PREFIX + token).digest();
}

/** On, for this enrolment. */
export function enforcementActive(s: MFASetting | null | undefined): boolean {
  if (!s || s.method === 'NONE' || !s.enabledAt || !s.secretEncrypted || !s.enforcedAt) return false;
  return s.enforcedAt.getTime() >= s.enabledAt.getTime();
}

export async function enforcementStatus(userId: string): Promise<{ enforced: boolean }> {
  const s = await prisma.mFASetting.findUnique({ where: { userId } });
  return { enforced: enforcementActive(s) };
}

// ── sign-in ──────────────────────────────────────────────────────────────────

export interface LoginChallenge {
  mfaRequired: true;
  /** `<id>.<secret>`; only its hash is stored. */
  challenge: string;
  expiresIn: number;
}

/**
 * Called after the password has been verified. Null when this account does not
 * require a code; otherwise a fresh challenge. Throws 503 when a code is
 * required and this server cannot check one.
 */
export async function loginSecondFactor(userId: string): Promise<LoginChallenge | null> {
  const s = await prisma.mFASetting.findUnique({ where: { userId } });
  if (!enforcementActive(s)) return null;
  if (!mfa.mfaConfigured()) throw new mfa.MfaUnavailableError();

  const token = randomBytes(32).toString('base64url');
  const row = await prisma.mFAChallenge.create({
    data: {
      userId,
      challengeHash: hashToken(token).toString('hex'),
      expiresAt: new Date(Date.now() + LOGIN_CHALLENGE_TTL_MS),
    },
  });
  return { mfaRequired: true, challenge: `${row.id}.${token}`, expiresIn: LOGIN_CHALLENGE_TTL_MS / 1000 };
}

/**
 * The second step. Returns the user id the challenge was issued to, once the
 * code has been accepted and the challenge consumed; throws otherwise.
 *
 *   401  the challenge is malformed, unknown, expired, used up or consumed,
 *        or the account no longer requires (or can take) a code
 *   400  the code was not accepted (tagged `security.mfa.failed`)
 *   429  the account's persistent wrong-code limit is reached
 *   503  this server cannot check a code
 */
export async function completeLoginSecondFactor(challenge: string, code: string): Promise<string> {
  const m = CHALLENGE_RE.exec(String(challenge ?? ''));
  if (!m) throw new LoginChallengeInvalidError();
  const [, id, token] = m;

  const row = await prisma.mFAChallenge.findUnique({ where: { id } });
  const stored = row ? Buffer.from(row.challengeHash, 'hex') : Buffer.alloc(0);
  const given = hashToken(token);
  if (!row || stored.length !== given.length || !timingSafeEqual(stored, given)) {
    throw new LoginChallengeInvalidError();
  }

  // Cannot check a code: say so before spending one of the challenge's tries.
  if (!mfa.mfaConfigured()) throw new mfa.MfaUnavailableError();

  // One try reserved atomically: concurrent requests cannot exceed the cap, and
  // a consumed or expired challenge reserves nothing.
  const now = new Date();
  const reserved = await prisma.mFAChallenge.updateMany({
    where: { id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (reserved.count !== 1) throw new LoginChallengeInvalidError();

  const userId = row.userId;
  const user = await prisma.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true, clubId: true, role: true } });
  if (!user) throw new LoginChallengeInvalidError();

  // Still required? If enforcement was switched off or MFA removed since the
  // password step, this challenge is void: sign in again. Never a pass-through.
  const before = await prisma.mFASetting.findUnique({ where: { userId } });
  if (!enforcementActive(before)) throw new LoginChallengeInvalidError();

  const actor: mfa.MfaActor = { userId, clubId: user.clubId, role: String(user.role) };
  const ok = await mfa.verifyLogin(actor, String(code ?? '').trim());
  if (!ok) {
    throw tagSecuritySignal(new mfa.InvalidMfaCodeError(), { type: 'security.mfa.failed', userId });
  }
  // `verifyLogin` accepts anything for an account that is not enrolled. Read
  // again after it, so a removal racing this request cannot turn into a pass.
  const after = await prisma.mFASetting.findUnique({ where: { userId } });
  if (!enforcementActive(after)) throw new LoginChallengeInvalidError();

  const consumed = await prisma.mFAChallenge.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new LoginChallengeInvalidError();
  return userId;
}

// ── the owner's switch ───────────────────────────────────────────────────────

async function enrolled(userId: string): Promise<MFASetting> {
  const s = await prisma.mFASetting.findUnique({ where: { userId } });
  if (!s || !s.enabledAt || s.method === 'NONE' || !s.secretEncrypted) {
    throw new BadRequestError('Two-step sign-in is not on');
  }
  return s;
}

async function mustVerify(actor: mfa.MfaActor, code: string): Promise<void> {
  if (!(await mfa.verifyLogin(actor, code))) throw new mfa.InvalidMfaCodeError();
}

/**
 * Require a code at every sign-in. Proven with BOTH a current app code and one
 * recovery code — the roadmap's "only after you've enrolled and tested
 * recovery" — so nobody switches this on with a phone that is not set up or
 * codes that were never saved. The recovery code is used up, as any is; at
 * least one must remain afterwards.
 */
export async function enableEnforcement(actor: mfa.MfaActor, appCode: string, recoveryCode: string): Promise<{ enforced: true }> {
  const app = String(appCode ?? '').trim();
  const rec = String(recoveryCode ?? '').trim();
  if (!APP_CODE_RE.test(app)) throw new mfa.InvalidMfaCodeError();
  if (!rec || APP_CODE_RE.test(rec)) throw new mfa.InvalidMfaCodeError();

  const s = await enrolled(actor.userId);
  const remaining = Array.isArray(s.backupCodesHash) ? s.backupCodesHash.length : 0;
  if (remaining < 2) throw new BadRequestError('Issue new recovery codes before requiring a code at sign-in');

  await mustVerify(actor, app);
  await mustVerify(actor, rec);

  // Bound to the enrolment that was checked: if it changed meanwhile, nothing is set.
  const r = await prisma.mFASetting.updateMany({
    where: { userId: actor.userId, method: s.method, enabledAt: s.enabledAt },
    data: { enforcedAt: new Date() },
  });
  if (r.count !== 1) throw new BadRequestError('Two-step sign-in changed. Reload and try again.');
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_ENFORCEMENT_ENABLED', entityType: 'MFASetting', entityId: actor.userId,
  });
  return { enforced: true };
}

/** Stop requiring a code at sign-in. A session alone is not enough: a code is. */
export async function disableEnforcement(actor: mfa.MfaActor, code: string): Promise<{ enforced: false }> {
  await enrolled(actor.userId);
  await mustVerify(actor, String(code ?? '').trim());
  await clearEnforcement(actor);
  return { enforced: false };
}

/** Called after MFA itself was turned off, so no inert flag is left behind. */
export async function clearEnforcement(actor: mfa.MfaActor): Promise<void> {
  const r = await prisma.mFASetting.updateMany({
    where: { userId: actor.userId, enforcedAt: { not: null } },
    data: { enforcedAt: null },
  });
  if (r.count > 0) {
    appendAuditEventAsync({
      actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
      action: 'MFA_ENFORCEMENT_DISABLED', entityType: 'MFASetting', entityId: actor.userId,
    });
  }
}
