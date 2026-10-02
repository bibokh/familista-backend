import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { User, UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import {
  UnauthorizedError,
  ConflictError,
  NotFoundError,
  BadRequestError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import { publishUserCreated, publishUserLogin, publishUserLogout } from '../fabric/producers/users.producer';
import { tagSecuritySignal } from '../cyber-defense/collectors';
import { forgetIdentity } from '../middleware/auth.middleware';
import { hashPassword, verifyPassword } from '../utils/password';
import { hashRefreshToken } from '../security/refresh-token-hash';
import { signToken, verifyToken } from '../security/jwt-tokens';
import { assertNotLocked, recordAttempt } from '../security/login-attempt.service';
import {
  completeLoginSecondFactor, loginSecondFactor, LoginChallengeInvalidError, type LoginChallenge,
} from '../auth-prod/mfa-enforcement.service';
import { resolveSessionMfaState } from '../auth-prod/admin-mfa';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  clubId: string;
  clubName: string;
}

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  clubId: string;
  /**
   * The identity's token version at the moment this token was minted.
   *
   * `authenticate` compares it against the row and refuses a token minted
   * before a server-side session end — revoking somebody's last membership of
   * a club bumps the row. Optional so that a token issued by an older build,
   * which carries no version, is still accepted.
   */
  tv?: number;
  /**
   * Cyber Defense, R7: present (true) only on a session that passed a second
   * factor at sign-in. Set by `completeMfaLogin`, carried across refresh,
   * never set by the password step. The admin MFA rule reads it.
   */
  mfa?: true;
}

// ── Token generation ──────────────────────────────────────

function generateAccessToken(payload: JwtPayload): string {
  return signToken('access', payload, { expiresIn: config.jwt.expiresIn });
}

// The refresh token is stored, and RefreshToken.token is unique. A JWT's `iat`
// has one-second resolution, so signing this payload twice inside a second
// produces the identical string and the second login dies on the constraint —
// a double-clicked login, or a second tab, answering 409. `jti` is the claim
// JWTs already define for exactly this: a unique identifier for the token,
// making two tokens issued in the same second different tokens. Nothing else
// about the token changes — same claims, same secret, same expiry — and the
// access token, which is not stored and has no uniqueness requirement, is
// deliberately left alone.
function generateRefreshToken(payload: JwtPayload): string {
  // node:crypto's randomUUID, not the `uuid` package: it is the same RFC 4122
  // version 4 value from the same CSPRNG, it is what request-id.middleware.ts
  // already uses, and it is one fewer dependency to keep patched. Node 20 is
  // required by this project's engines, so it is always present.
  return signToken('refresh', { ...payload, jti: randomUUID() }, { expiresIn: config.jwt.refreshExpiresIn });
}

function getRefreshExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 7); // 7 days
  return d;
}

// ── Register ──────────────────────────────────────────────

export async function registerUser(data: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: UserRole;
  clubId: string;
}): Promise<{ user: AuthUser; tokens: TokenPair }> {
  // Check duplicate
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ConflictError('Email already registered');

  // Verify club exists
  const club = await prisma.club.findUnique({ where: { id: data.clubId } });
  if (!club) throw new NotFoundError('Club');

  // Hash password
  const passwordHash = await hashPassword(data.password);

  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase().trim(),
      passwordHash,
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      role: data.role ?? UserRole.HEAD_COACH,
      clubId: data.clubId,
    },
    include: { club: { select: { name: true } } },
  });

  const tokens = await issueTokens(user);
  logger.info('User registered', { userId: user.id, clubId: user.clubId });

  // After the account exists and a session was issued, never before. An event
  // announcing an account that a later failure rolls back is an event that is
  // wrong about whether the account exists.
  publishUserCreated(
    { userId: user.id, clubId: user.clubId, actorUserId: user.id },
    user.role,
    false,
  );

  return {
    user: mapAuthUser(user, user.club.name),
    tokens,
  };
}

/**
 * Create an account for somebody an invitation named — and only for them.
 *
 * The ordinary `registerUser` above takes a clubId and a role from the request,
 * which is fine for a club administrator creating an account inside their own
 * club and completely wrong for a stranger holding a link. An invited person
 * must not be able to name the club they land in, the role they arrive with, or
 * even the address the account is created for: all three come from the
 * invitation the caller proved they hold.
 *
 * So the ONLY things this accepts from the request are a name and a password —
 * and the password is theirs, chosen here, hashed here, and never seen by the
 * club that invited them or by anybody at Familista.
 *
 * It creates the account and nothing else. No membership is granted here: that
 * is `acceptInvitation`'s job, with its own single-use consumption and its own
 * audit row, and duplicating it would mean two paths into club authority.
 */
export async function registerInvitedUser(input: {
  /** From the invitation, never from the request body. */
  email: string;
  clubId: string;
  accountRole: UserRole;
  firstName: string;
  lastName: string;
  password: string;
}): Promise<{ user: AuthUser; tokens: TokenPair }> {
  const email = input.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ConflictError('Email already registered');

  const club = await prisma.club.findUnique({ where: { id: input.clubId } });
  if (!club) throw new NotFoundError('Club');

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      role: input.accountRole,
      clubId: input.clubId,
    },
    include: { club: { select: { name: true } } },
  });

  const tokens = await issueTokens(user);
  // The address is not logged: an invited person's address in a log is an
  // address in every backup of that log.
  logger.info('Invited user registered', { userId: user.id, clubId: user.clubId });

  // `invited: true` is the whole difference, and it is worth recording: an
  // account created from an invitation took its club and its role from the
  // invitation rather than from a request body.
  publishUserCreated(
    { userId: user.id, clubId: user.clubId, actorUserId: user.id },
    user.role,
    true,
  );

  return { user: mapAuthUser(user, user.club.name), tokens };
}

// ── Login ─────────────────────────────────────────────────

/** A signed-in session: what every successful sign-in ends with. */
export interface LoginSession {
  user: AuthUser;
  tokens: TokenPair;
  /**
   * R7: this administrator has not enrolled a second factor and the platform
   * requires one, so the session is setup-only until they do.
   */
  mfaEnrolmentRequired?: true;
}

/**
 * What the password step answers: a session, or — for an account whose owner
 * requires a code at sign-in (Cyber Defense, Step 7) — a challenge that only
 * `completeMfaLogin` can turn into one. A challenge carries no tokens and
 * nothing about the account.
 */
export type LoginOutcome = LoginSession | LoginChallenge;

export function isLoginChallenge(o: LoginOutcome): o is LoginChallenge {
  return (o as LoginChallenge).mfaRequired === true;
}

/** Where a sign-in came from, for the lockout and its audit trail. Never logged in full. */
export interface LoginContext { ipAddress?: string | null; userAgent?: string | null }

export async function loginUser(
  email: string,
  password: string,
  ctx: LoginContext = {},
): Promise<LoginOutcome> {
  // Cyber Defense R7: the lockout is enforced, before the password is even
  // checked — 5 failures on one account in 15 minutes, or 20 from one address
  // in 5 (security/login-attempt.service.ts). A locked attempt is refused with
  // 429 and recorded as a CRITICAL LOGIN_LOCKED security event, which reaches
  // the operator through the security alerts (R6). The window relaxes on its
  // own; nothing has to be unlocked by hand.
  await assertNotLocked(email, ctx.ipAddress);
  const failed = () => recordAttempt({ email, success: false, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { club: { select: { name: true } } },
  });

  // Each refusal is tagged for Cyber Defense (`tagSecuritySignal`); the class,
  // the message and the status are exactly what they were.
  if (!user || !user.isActive) {
    failed();
    throw tagSecuritySignal(new UnauthorizedError('Invalid email or password'), {
      type: 'security.login.failed', reason: user ? 'INACTIVE_ACCOUNT' : 'UNKNOWN_ACCOUNT',
    });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    failed();
    throw tagSecuritySignal(new UnauthorizedError('Invalid email or password'), {
      type: 'security.login.failed', reason: 'BAD_PASSWORD',
    });
  }

  // Cyber Defense, Step 7: a right password is not yet a session when this
  // account requires a code. Nothing below — last-login, tokens, the login
  // event — happens until `completeMfaLogin` accepts one. Fails closed: if the
  // requirement cannot be read or a code cannot be checked, this throws.
  recordAttempt({ email, success: true, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, actorId: user.id, clubId: user.clubId });

  const challenge = await loginSecondFactor(user.id, user.role);
  if (challenge) return challenge;

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const tokens = await issueTokens(user);
  logger.info('User logged in', { userId: user.id });

  // Only here. A failed password never reaches this line, so there is no path
  // on which a refused attempt is recorded as a login.
  publishUserLogin({ userId: user.id, clubId: user.clubId });

  const setupOnly = (await resolveSessionMfaState(user.id, user.role, false)) === 'setup-only';
  return { user: mapAuthUser(user, user.club.name), tokens, ...(setupOnly && { mfaEnrolmentRequired: true as const }) };
}

/**
 * The second step of a sign-in that requires a code. The challenge proves the
 * password step; the code is checked by the MFA service with its persistent
 * limit and single-use rule; the challenge is consumed once. Only then is this
 * a login — the same last-login, tokens and event as `loginUser`.
 */
export async function completeMfaLogin(challenge: string, code: string): Promise<LoginSession> {
  const userId = await completeLoginSecondFactor(challenge, code);
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    include: { club: { select: { name: true } } },
  });
  if (!user) throw new LoginChallengeInvalidError();

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const tokens = await issueTokens(user, { passedCode: true });
  logger.info('User logged in', { userId: user.id, secondFactor: true });
  publishUserLogin({ userId: user.id, clubId: user.clubId });

  return { user: mapAuthUser(user, user.club.name), tokens };
}

// ── Refresh ───────────────────────────────────────────────

export async function refreshTokens(token: string): Promise<TokenPair> {
  let payload: JwtPayload;
  try {
    payload = verifyToken<JwtPayload>('refresh', token);
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  // The signature verified and the token has not expired, yet no row holds it
  // (or it belongs to somebody else): it was already rotated or revoked.
  // Presenting it again is the signal Cyber Defense records. Same error as before.
  const reused = () => {
    const err = new UnauthorizedError('Refresh token expired or revoked');
    return typeof payload?.sub === 'string'
      ? tagSecuritySignal(err, { type: 'security.refresh.reused', userId: payload.sub })
      : err;
  };

  const stored = await findStoredRefreshToken(token);
  if (!stored || stored.userId !== payload.sub) throw reused();
  if (stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token expired or revoked');
  }

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true },
    include: { club: { select: { name: true } } },
  });
  if (!user) throw new UnauthorizedError('User not found');

  // Rotate: claim the old row, then issue the new pair. The claim is one
  // conditional delete, so of two requests presenting the same token at once
  // exactly one wins; the other is a reuse, not a second session.
  const claimed = await prisma.refreshToken.deleteMany({ where: { id: stored.id } });
  if (claimed.count !== 1) throw reused();
  return issueTokens(user, { passedCode: payload.mfa === true });
}

/**
 * Cyber Defense, Step 8: the row for a presented refresh token, found by its
 * hash — or, for a row issued before this build (or by the previous build
 * while a deploy is switching over), by its raw value. That fallback is what
 * keeps everybody signed in across the change; such a row is rotated away the
 * first time it is used, and expires within a week in any case.
 */
async function findStoredRefreshToken(token: string) {
  const byHash = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
  if (byHash) return byHash;
  return prisma.refreshToken.findFirst({ where: { token, tokenHash: null } });
}

// ── Logout ────────────────────────────────────────────────

export async function logoutUser(refreshToken: string): Promise<void> {
  // Read before the delete, because `deleteMany` returns a count and a count
  // cannot say whose session ended. One indexed read on a token that is about
  // to be deleted anyway, and the delete below keeps its existing semantics
  // exactly — including being a no-op for a token that was never there.
  // By hash, and by raw value for a row issued before Step 8 (see
  // `findStoredRefreshToken`).
  const where = { OR: [{ tokenHash: hashRefreshToken(refreshToken) }, { token: refreshToken }] };
  const stored = await prisma.refreshToken.findFirst({
    where,
    select: { userId: true, user: { select: { clubId: true } } },
  });

  await prisma.refreshToken.deleteMany({ where });

  // A logout of a token that did not exist is not a logout. Presenting an
  // expired or forged token must not put a `user.logout` on the record.
  if (stored) {
    publishUserLogout({ userId: stored.userId, clubId: stored.user?.clubId ?? null });
  }
}

// ── Change password ───────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new BadRequestError('Current password is incorrect');

  const hash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });
  forgetIdentity(userId);

  // Revoke all refresh tokens
  await prisma.refreshToken.deleteMany({ where: { userId } });
  logger.info('Password changed', { userId });
}

// ── Helpers ───────────────────────────────────────────────

async function issueTokens(user: User, opts: { passedCode?: boolean } = {}): Promise<TokenPair> {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    clubId: user.clubId,
    // Stamped so a token can be told apart from one minted before a
    // server-side session end. Nothing else about the token changes.
    tv: user.tokenVersion ?? 0,
    ...(opts.passedCode && { mfa: true as const }),
  };

  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  // Cyber Defense, Step 8: only the hash is stored. The token itself goes to
  // the client and nowhere else.
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: getRefreshExpiry(),
    },
  });

  return { accessToken, refreshToken };
}

/**
 * The display half of a profile — names and the primary club's name — for
 * GET /auth/me. A client that keeps nothing in storage (R7) rebuilds the
 * signed-in person from this on every load.
 */
export async function profileOf(userId: string): Promise<{ firstName: string | null; lastName: string | null; clubName: string | null }> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, club: { select: { name: true } } },
  });
  return { firstName: u?.firstName ?? null, lastName: u?.lastName ?? null, clubName: u?.club?.name ?? null };
}

function mapAuthUser(
  user: User,
  clubName: string
): AuthUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    clubId: user.clubId,
    clubName,
  };
}
