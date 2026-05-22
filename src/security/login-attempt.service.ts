// Familista — Login attempt tracking + lockout (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// We never store the raw email — only SHA-256(email_lowercased_trimmed).
// Lockout heuristics:
//   - 5 failed attempts on the same emailHash within 15 minutes  → LOCKED
//   - 20 failed attempts from the same IP    within 5  minutes   → LOCKED
//   - successful login resets the per-email counter (we don't delete
//     history; the time window is what relaxes the lockout)

import { createHash } from 'crypto';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { logSecurityEvent } from './security-event.service';

const EMAIL_FAIL_WINDOW_MS   = 15 * 60_000;
const EMAIL_FAIL_THRESHOLD   = 5;
const IP_FAIL_WINDOW_MS      = 5  * 60_000;
const IP_FAIL_THRESHOLD      = 20;

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export interface RecordAttemptArgs {
  email:      string;
  success:    boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** When success=true, also persist the User.id for the audit trail. */
  actorId?:   string | null;
  clubId?:    string | null;
}

export function recordAttempt(args: RecordAttemptArgs): void {
  // Fire-and-forget; failure here never blocks login.
  prisma.loginAttempt.create({
    data: {
      emailHash: emailHash(args.email),
      success:   args.success,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    },
  }).catch((err) => {
    logger.warn('[login-attempt] write failed', { err: (err as Error).message });
  });

  logSecurityEvent({
    kind:      args.success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
    severity:  args.success ? 'INFO'           : 'WARN',
    actorId:   args.actorId  ?? null,
    clubId:    args.clubId   ?? null,
    ipAddress: args.ipAddress ?? null,
    userAgent: args.userAgent ?? null,
  });
}

/** Returns true if the email is currently locked out. */
export async function isLockedByEmail(email: string): Promise<boolean> {
  const fails = await prisma.loginAttempt.count({
    where: {
      emailHash: emailHash(email),
      success:   false,
      createdAt: { gte: new Date(Date.now() - EMAIL_FAIL_WINDOW_MS) },
    },
  });
  return fails >= EMAIL_FAIL_THRESHOLD;
}

/** Returns true if the IP is currently locked out. */
export async function isLockedByIp(ipAddress: string | null | undefined): Promise<boolean> {
  if (!ipAddress) return false;
  const fails = await prisma.loginAttempt.count({
    where: {
      ipAddress,
      success:   false,
      createdAt: { gte: new Date(Date.now() - IP_FAIL_WINDOW_MS) },
    },
  });
  return fails >= IP_FAIL_THRESHOLD;
}

/** Combined helper — call before issuing tokens. */
export async function assertNotLocked(email: string, ipAddress: string | null | undefined): Promise<void> {
  const [byEmail, byIp] = await Promise.all([
    isLockedByEmail(email),
    isLockedByIp(ipAddress),
  ]);
  if (byEmail || byIp) {
    logSecurityEvent({
      kind: 'LOGIN_LOCKED',
      severity: 'CRITICAL',
      ipAddress: ipAddress ?? null,
      payload: { reason: byEmail ? 'email_threshold' : 'ip_threshold' },
    });
    const err = new Error('Too many failed login attempts. Try again later.');
    (err as Error & { statusCode?: number }).statusCode = 429;
    throw err;
  }
}
