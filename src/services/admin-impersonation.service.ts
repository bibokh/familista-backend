// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-impersonation.service.ts
//
// Operator impersonation: issue a short-lived, single-use scoped access token
// for a target user. The token carries an `impersonatedBy` claim that downstream
// auth middleware can surface for forced audit on every request.
//
// Integration note: this service expects `signImpersonationToken(payload, ttlSeconds)`
// from your auth module. If your existing auth service exposes a different name,
// adjust the import below.

import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { BadRequestError, NotFoundError, ConflictError, ForbiddenError } from '../utils/errors';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import { signImpersonationToken } from './auth.service';
import { isFeatureEnabled, getQuotaUsage } from './admin-organization.service';
import type { PlatformActor } from '../types/admin.types';
import type { StartImpersonationInput } from '../utils/admin.validators';
import type { ImpersonationSession } from '@prisma/client';

const MAX_DEFAULT_TTL_MINUTES = 60;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function startImpersonation(
  actor: PlatformActor,
  input: StartImpersonationInput,
): Promise<{ token: string; expiresAt: Date; session: ImpersonationSession }> {
  const target = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, email: true, clubId: true, role: true, isActive: true },
  });
  if (!target) throw new NotFoundError('Target user not found');
  if (!target.isActive) throw new BadRequestError('Target user is inactive');

  if (target.role === 'SUPER_ADMIN') {
    throw new ForbiddenError('Impersonating SUPER_ADMIN users is not permitted');
  }

  const overlapping = await prisma.impersonationSession.count({
    where: {
      targetUserId: target.id,
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
    },
  });
  if (overlapping > 0) {
    throw new ConflictError('Another active impersonation already targets this user');
  }

  const limitsEnabledMax = await prisma.organizationLimits.findUnique({
    where: { clubId: target.clubId },
    select: { maxImpersonationsPerDay: true },
  });
  if (limitsEnabledMax?.maxImpersonationsPerDay != null) {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dailyCount = await prisma.impersonationSession.count({
      where: { targetClubId: target.clubId, createdAt: { gte: oneDayAgo } },
    });
    if (dailyCount >= limitsEnabledMax.maxImpersonationsPerDay) {
      throw new ForbiddenError('Daily impersonation limit reached for this organization');
    }
  }

  const impersonationFeatureEnabled = await isFeatureEnabled(target.clubId, 'impersonation');
  if (!impersonationFeatureEnabled) {
    void impersonationFeatureEnabled;
  }

  const ttlMinutes = Math.min(input.ttlMinutes ?? MAX_DEFAULT_TTL_MINUTES, 240);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const token = await signImpersonationToken(
    {
      sub: target.id,
      clubId: target.clubId,
      role: target.role,
      impersonatedBy: { adminId: actor.adminId, userId: actor.userId },
    },
    ttlMinutes * 60,
  );

  const session = await prisma.impersonationSession.create({
    data: {
      adminId: actor.adminId,
      targetUserId: target.id,
      targetClubId: target.clubId,
      tokenHash: hashToken(token),
      reason: input.reason,
      expiresAt,
      status: 'ACTIVE',
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: target.clubId,
    action: 'IMPERSONATION_STARTED',
    category: 'IMPERSONATION',
    resourceType: 'ImpersonationSession',
    resourceId: session.id,
    metadata: {
      targetUserId: target.id,
      targetEmail: target.email,
      ttlMinutes,
      reason: input.reason,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { token, expiresAt, session };
}

export async function endImpersonation(
  actor: PlatformActor,
  sessionId: string,
  reason: string,
): Promise<ImpersonationSession> {
  const session = await prisma.impersonationSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new NotFoundError('Impersonation session not found');
  if (session.status !== 'ACTIVE') throw new BadRequestError('Session already ended');

  const updated = await prisma.impersonationSession.update({
    where: { id: sessionId },
    data: { status: 'ENDED', endedAt: new Date(), endedReason: reason },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: session.targetClubId,
    action: 'IMPERSONATION_ENDED',
    category: 'IMPERSONATION',
    resourceType: 'ImpersonationSession',
    resourceId: sessionId,
    metadata: { reason, targetUserId: session.targetUserId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function listImpersonations(opts: {
  status?: 'ACTIVE' | 'ENDED' | 'EXPIRED' | 'REVOKED';
  targetClubId?: string;
  limit?: number;
}) {
  return await prisma.impersonationSession.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.targetClubId ? { targetClubId: opts.targetClubId } : {}),
    },
    include: {
      admin: { select: { id: true, userId: true, role: true } },
      targetUser: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

export async function reapExpiredImpersonations(): Promise<{ expired: number }> {
  const result = await prisma.impersonationSession.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED', endedAt: new Date(), endedReason: 'expired' },
  });
  return { expired: result.count };
}

// Used by auth middleware when validating an inbound impersonation JWT.
export async function findActiveByToken(token: string): Promise<ImpersonationSession | null> {
  const hash = hashToken(token);
  const session = await prisma.impersonationSession.findUnique({ where: { tokenHash: hash } });
  if (!session) return null;
  if (session.status !== 'ACTIVE') return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  return session;
}

void getQuotaUsage;
