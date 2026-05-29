import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendPasswordResetEmail } from '../lib/email.adapter';
import { BadRequestError } from '../utils/errors';

const TOKEN_TTL_MS  = 60 * 60 * 1000; // 1 hour
const BCRYPT_ROUNDS = 12;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Initiate a password-reset request for the given email address.
 * Always returns successfully (anti-enumeration).
 * Returns the raw token only in non-production environments (dev log / response body).
 */
export async function requestPasswordReset(email: string): Promise<{ devResetUrl?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, firstName: true },
  });

  if (!user) {
    // Anti-enumeration: do not reveal whether the email exists
    logger.info({ msg: 'password-reset request for unknown email (suppressed)', email: normalizedEmail });
    return {};
  }

  // Invalidate any prior unused tokens for this user
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  const resetUrl = `${config.email.appUrl}/reset-password?token=${rawToken}`;

  try {
    await sendPasswordResetEmail({
      to:        user.email,
      firstName: user.firstName ?? 'there',
      resetUrl,
    });
  } catch (err) {
    // Log but don't surface transport errors to the caller
    logger.error({ msg: 'password-reset email dispatch failed', err });
  }

  logger.info({ msg: 'password-reset token issued', userId: user.id });

  // Expose resetUrl only outside production (useful for testing without a mailer)
  if (!config.isProd) {
    return { devResetUrl: resetUrl };
  }

  return {};
}

/**
 * Validate a raw reset token without consuming it.
 * Returns the associated email on success.
 * Throws BadRequestError if the token is invalid, expired, or already used.
 */
export async function validateResetToken(rawToken: string): Promise<{ email: string }> {
  const tokenHash = hashToken(rawToken);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { email: true } } },
  });

  if (!record) {
    throw new BadRequestError('Invalid or expired reset token');
  }

  if (record.usedAt) {
    throw new BadRequestError('Reset token has already been used');
  }

  if (record.expiresAt < new Date()) {
    throw new BadRequestError('Reset token has expired');
  }

  return { email: record.user.email };
}

/**
 * Consume a reset token and update the user's password.
 * Atomically: marks token used, updates password, revokes all refresh tokens.
 * Throws BadRequestError on invalid/expired/used tokens.
 */
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(rawToken);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!record) {
    throw new BadRequestError('Invalid or expired reset token');
  }

  if (record.usedAt) {
    throw new BadRequestError('Reset token has already been used');
  }

  if (record.expiresAt < new Date()) {
    throw new BadRequestError('Reset token has expired');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const now = new Date();

  await prisma.$transaction([
    // 1. Mark token as consumed
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data:  { usedAt: now },
    }),
    // 2. Update user password hash
    prisma.user.update({
      where: { id: record.userId },
      data:  { passwordHash },
    }),
    // 3. Revoke all active refresh tokens (force re-login on all devices)
    prisma.refreshToken.deleteMany({
      where: { userId: record.userId },
    }),
  ]);

  logger.info({ msg: 'password reset completed', userId: record.userId });
}
