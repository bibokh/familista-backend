// Familista — Vision Intelligence Engine
// File location: src/middleware/vision-access.middleware.ts
//
// Builds a VisionAccessScope per request. Vision is club-scoped data with a
// platform-admin override. Webhooks from the inference / clip workers carry a
// shared-secret header instead of a JWT — `requireWebhookAuth` validates that.

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { PlatformRole, UserRole } from '@prisma/client';

import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type {
  VisionActor,
  VisionAccessScope,
  VisionActorRole,
} from '../types/vision.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      visionActor?: VisionActor;
    }
  }
}

const SCOPE_CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { scope: VisionAccessScope; expiresAt: number }>();

const USER_TO_VISION_ROLE: Record<UserRole, VisionActorRole> = {
  SUPER_ADMIN: 'PLATFORM_ADMIN',
  CLUB_ADMIN: 'CLUB_ADMIN',
  HEAD_COACH: 'HEAD_COACH',
  ASSISTANT_COACH: 'ASSISTANT_COACH',
  ANALYST: 'ANALYST',
  MEDICAL_STAFF: 'MEDICAL_STAFF',
  SCOUT: 'SCOUT',
};

function clientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]?.trim() ?? null;
  return req.ip ?? null;
}

async function deriveScope(userId: string, platformRole: PlatformRole | null): Promise<VisionAccessScope> {
  const key = `${userId}:${platformRole ?? 'none'}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  if (platformRole) {
    const scope: VisionAccessScope = {
      isPlatformAdmin: true,
      platformRole,
      userId,
      clubId: null,
      userRole: 'PLATFORM_ADMIN',
    };
    cache.set(key, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    return scope;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { clubId: true, role: true } });
  const scope: VisionAccessScope = {
    isPlatformAdmin: false,
    platformRole: null,
    userId,
    clubId: user?.clubId ?? null,
    userRole: user ? USER_TO_VISION_ROLE[user.role] : null,
  };
  cache.set(key, { scope, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
  return scope;
}

export function clearVisionScopeCacheForUser(userId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

export async function attachVisionContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    const platformRole = req.platformActor?.role ?? null;
    const scope = await deriveScope(req.user.id, platformRole);
    req.visionActor = { userId: req.user.id, scope, ipAddress: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireVisionContext(req: Request, _res: Response, next: NextFunction): void {
  if (!req.visionActor) return next(new ForbiddenError('Vision context required'));
  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject-access helpers
// ─────────────────────────────────────────────────────────────────────────────

const VISION_READ_ROLES: ReadonlySet<VisionActorRole> = new Set([
  'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST',
  'MEDICAL_STAFF', 'SCOUT', 'PLATFORM_ADMIN',
]);
const VISION_WRITE_ROLES: ReadonlySet<VisionActorRole> = new Set([
  'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'PLATFORM_ADMIN',
]);

function ensureReadRole(actor: VisionActor): void {
  if (actor.scope.isPlatformAdmin) return;
  if (!actor.scope.userRole || !VISION_READ_ROLES.has(actor.scope.userRole)) {
    throw new ForbiddenError('Role cannot read vision data');
  }
}

function ensureWriteRole(actor: VisionActor): void {
  if (actor.scope.isPlatformAdmin) return;
  if (!actor.scope.userRole || !VISION_WRITE_ROLES.has(actor.scope.userRole)) {
    throw new ForbiddenError('Role cannot mutate vision data');
  }
}

export async function assertVideoAccess(
  actor: VisionActor,
  videoAssetId: string,
  mode: 'read' | 'write',
): Promise<void> {
  if (mode === 'read') ensureReadRole(actor);
  else ensureWriteRole(actor);
  if (actor.scope.isPlatformAdmin) return;

  const video = await prisma.videoAsset.findUnique({ where: { id: videoAssetId }, select: { clubId: true } });
  if (!video) throw new ForbiddenError('Video not in scope');
  if (video.clubId !== actor.scope.clubId) throw new ForbiddenError('Video belongs to another club');
}

export async function assertAnalysisAccess(
  actor: VisionActor,
  analysisId: string,
  mode: 'read' | 'write',
): Promise<void> {
  if (mode === 'read') ensureReadRole(actor);
  else ensureWriteRole(actor);
  if (actor.scope.isPlatformAdmin) return;

  const analysis = await prisma.visionAnalysisRun.findUnique({ where: { id: analysisId }, select: { clubId: true } });
  if (!analysis) throw new ForbiddenError('Analysis not in scope');
  if (analysis.clubId && analysis.clubId !== actor.scope.clubId) {
    throw new ForbiddenError('Analysis belongs to another club');
  }
}

export async function assertMatchAccess(
  actor: VisionActor,
  matchId: string,
  mode: 'read' | 'write',
): Promise<void> {
  if (mode === 'read') ensureReadRole(actor);
  else ensureWriteRole(actor);
  if (actor.scope.isPlatformAdmin) return;

  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!match) throw new ForbiddenError('Match not in scope');
  if (match.clubId !== actor.scope.clubId) throw new ForbiddenError('Match belongs to another club');
}

export async function assertTrainingSessionAccess(
  actor: VisionActor,
  trainingSessionId: string,
  mode: 'read' | 'write',
): Promise<void> {
  if (mode === 'read') ensureReadRole(actor);
  else ensureWriteRole(actor);
  if (actor.scope.isPlatformAdmin) return;

  const session = await prisma.trainingSession.findUnique({
    where: { id: trainingSessionId },
    select: { clubId: true },
  });
  if (!session) throw new ForbiddenError('Training session not in scope');
  if (session.clubId !== actor.scope.clubId) throw new ForbiddenError('Training session belongs to another club');
}

export function assertPlatformAdmin(actor: VisionActor): void {
  if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook authentication — shared-secret header check with constant-time compare
// ─────────────────────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function requireWebhookAuth(headerName: string, envName: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const expected = process.env[envName];
    if (!expected) return next(new ForbiddenError(`${envName} not configured`));
    const provided = req.headers[headerName.toLowerCase()] as string | undefined;
    if (!provided || !timingSafeEqual(provided, expected)) {
      return next(new UnauthorizedError('Invalid webhook signature'));
    }
    return next();
  };
}
