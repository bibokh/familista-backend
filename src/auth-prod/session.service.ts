// Familista — Production Auth Sessions (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Refresh token rotation + session revocation + device fingerprint.
//
// Flow:
//   1. login()             → issues access JWT + refresh token + AuthSession row
//   2. rotate(refresh)     → revokes old session, issues new pair, links via parentSessionId
//   3. revoke(sessionId)   → marks revoked + denies future rotation
//   4. revokeAllForUser    → "log out everywhere" for a user
//
// We NEVER store refresh tokens raw — only sha256 hashes in AuthSession.refreshHash.

import { createHash, randomBytes } from 'crypto';
import { AuthSession, AuthSessionStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface SessionActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const REFRESH_TTL_MS  = 7  * 24 * 60 * 60_000;     // 7 days
const MAX_SESSIONS_PER_USER = 20;                  // hard cap to prevent fan-out

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export interface IssueSessionDto {
  userId:      string;
  deviceLabel?: string;
  ipAddress?:  string;
  userAgent?:  string;
  mfaSatisfied?: boolean;
}

export interface IssuedSession {
  session:      AuthSession;
  /** Refresh token to return to the client (only shown once). */
  refreshToken: string;
}

export async function issueSession(dto: IssueSessionDto): Promise<IssuedSession> {
  if (!dto.userId) throw new BadRequestError('userId required');
  // Enforce per-user session cap by revoking oldest ACTIVE sessions.
  const activeCount = await prisma.authSession.count({ where: { userId: dto.userId, status: 'ACTIVE' } });
  if (activeCount >= MAX_SESSIONS_PER_USER) {
    const oldest = await prisma.authSession.findMany({
      where: { userId: dto.userId, status: 'ACTIVE' },
      orderBy: { lastUsedAt: 'asc' },
      take: activeCount - MAX_SESSIONS_PER_USER + 1,
      select: { id: true },
    });
    await prisma.authSession.updateMany({
      where: { id: { in: oldest.map((s) => s.id) } },
      data:  { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'cap_evicted' },
    });
  }

  const refreshToken = newRefreshToken();
  const refreshHash  = hashToken(refreshToken);
  const session = await prisma.authSession.create({
    data: {
      userId:       dto.userId,
      refreshHash,
      deviceLabel:  dto.deviceLabel ?? null,
      ipAddress:    dto.ipAddress ?? null,
      userAgent:    dto.userAgent ?? null,
      status:       'ACTIVE',
      mfaSatisfied: dto.mfaSatisfied ?? false,
      expiresAt:    new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  appendAuditEventAsync({
    actor: { userId: dto.userId, clubId: '', ipAddress: dto.ipAddress ?? null, userAgent: dto.userAgent ?? null },
    action: 'AUTH_SESSION_ISSUED',
    entityType: 'AuthSession', entityId: session.id,
    payload: { deviceLabel: dto.deviceLabel ?? null, mfaSatisfied: !!dto.mfaSatisfied },
  });
  return { session, refreshToken };
}

/**
 * Rotate a refresh token. Verifies the old token's hash is ACTIVE + not
 * expired, then issues a new pair and revokes the old one with
 * parentSessionId linkage.
 */
export async function rotateSession(refreshToken: string, ipAddress?: string, userAgent?: string): Promise<IssuedSession> {
  if (!refreshToken) throw new UnauthorizedError('refresh token required');
  const refreshHash = hashToken(refreshToken);
  const existing = await prisma.authSession.findUnique({ where: { refreshHash } });
  if (!existing)                          throw new UnauthorizedError('refresh token not found');
  if (existing.status !== 'ACTIVE')       throw new UnauthorizedError('session not active');
  if (existing.expiresAt < new Date())    throw new UnauthorizedError('session expired');

  const newToken = newRefreshToken();
  const newHash  = hashToken(newToken);
  const next = await prisma.$transaction(async (tx) => {
    const newSession = await tx.authSession.create({
      data: {
        userId:          existing.userId,
        refreshHash:     newHash,
        deviceLabel:     existing.deviceLabel,
        ipAddress:       ipAddress ?? existing.ipAddress,
        userAgent:       userAgent ?? existing.userAgent,
        status:          'ACTIVE',
        mfaSatisfied:    existing.mfaSatisfied,
        expiresAt:       new Date(Date.now() + REFRESH_TTL_MS),
        parentSessionId: existing.id,
      },
    });
    await tx.authSession.update({
      where: { id: existing.id },
      data:  { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'rotated', lastUsedAt: new Date() },
    });
    return newSession;
  });
  appendAuditEventAsync({
    actor: { userId: existing.userId, clubId: '', ipAddress: ipAddress ?? null, userAgent: userAgent ?? null },
    action: 'AUTH_SESSION_ROTATED',
    entityType: 'AuthSession', entityId: next.id,
    payload: { fromSessionId: existing.id },
  });
  return { session: next, refreshToken: newToken };
}

export async function revoke(actor: SessionActor, sessionId: string, reason = 'manual'): Promise<AuthSession> {
  const s = await prisma.authSession.findUnique({ where: { id: sessionId } });
  if (!s)                                                       throw new NotFoundError('AuthSession');
  if (s.userId !== actor.userId && actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN') throw new ForbiddenError();
  if (s.status !== 'ACTIVE') return s;
  const updated = await prisma.authSession.update({
    where: { id: sessionId },
    data:  { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'AUTH_SESSION_REVOKED',
    entityType: 'AuthSession', entityId: sessionId,
    payload: { reason },
  });
  return updated;
}

export async function revokeAllForUser(actor: SessionActor, userId: string, reason = 'logout_all'): Promise<{ revoked: number }> {
  if (actor.userId !== userId && actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN') throw new ForbiddenError();
  const res = await prisma.authSession.updateMany({
    where: { userId, status: 'ACTIVE' },
    data:  { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'AUTH_SESSIONS_REVOKED_ALL',
    entityType: 'User', entityId: userId,
    payload: { revoked: res.count, reason },
  });
  return { revoked: res.count };
}

export async function listSessions(actor: SessionActor, userId?: string): Promise<AuthSession[]> {
  const target = userId ?? actor.userId;
  if (target !== actor.userId && actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN') throw new ForbiddenError();
  return prisma.authSession.findMany({
    where:   { userId: target },
    orderBy: { lastUsedAt: 'desc' },
    take:    100,
  });
}

/** Background helper: mark expired sessions. Safe to call on a schedule. */
export async function sweepExpired(): Promise<{ swept: number }> {
  const res = await prisma.authSession.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    data:  { status: 'EXPIRED' },
  });
  return { swept: res.count };
}

/** Verify a refresh token without rotating (e.g. for read-only validation). */
export async function verifyRefresh(refreshToken: string): Promise<AuthSession | null> {
  if (!refreshToken) return null;
  const hash = hashToken(refreshToken);
  const s = await prisma.authSession.findUnique({ where: { refreshHash: hash } });
  if (!s || s.status !== 'ACTIVE' || s.expiresAt < new Date()) return null;
  return s;
}

/** Mark a session as touched (best-effort, no exceptions surfaced). */
export async function touch(sessionId: string): Promise<void> {
  await prisma.authSession.updateMany({
    where: { id: sessionId, status: 'ACTIVE' },
    data:  { lastUsedAt: new Date() },
  }).catch(() => undefined);
}

export { hashToken as _hashTokenForTest };
