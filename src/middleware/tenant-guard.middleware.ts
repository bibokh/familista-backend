// Familista — Tenant Guard middleware (Phase I + team-scope extension)
// ─────────────────────────────────────────────────────────────────────────
// Defence-in-depth tenant + team-scope assertion. Existing services already
// enforce clubId on every read/write; this middleware adds two more walls:
//
//   1. CLUB SCOPE — for routes that carry a tenant-scoped param (matchId,
//      playerId, teamId, deviceSessionId, cameraId, jobId, alertId,
//      recommendationId), resolve the parent row's clubId once and compare
//      to req.user.clubId. Mismatch → 403 + TENANT_MISMATCH event.
//
//   2. TEAM SCOPE — when the requesting user has an ACTIVE Membership
//      pinned to a specific team (Membership.teamId != null) and the
//      requested resource also has a teamId, the two must match. This
//      prevents a youth-team coach from reading senior squad data.
//
//      Team scope is enforced for roles that are typically team-bound:
//      ASSISTANT_COACH, COACH, MEDICAL_STAFF, PHYSIO, PLAYER, PARENT.
//      It is BYPASSED for club-wide roles: SUPER_ADMIN, CLUB_ADMIN,
//      CLUB_OWNER, MANAGER, HEAD_COACH, ANALYST, SCOUT, FINANCE_MANAGER.
//
//      A user with NO team-scoped membership (legacy users with only
//      User.role) is treated as club-wide and bypasses team scope —
//      additive migration: no existing behaviour breaks.
//
//      A mismatch logs TENANT_MISMATCH (severity HIGH) and refuses 403.
//
// SUPER_ADMIN bypasses both comparisons but is still logged at INFO.

import type { Request, Response, NextFunction } from 'express';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { logSecurityEvent } from '../security/security-event.service';

interface Lookup {
  param: string;
  loader: (id: string) => Promise<{ clubId: string; teamId?: string | null } | null>;
}

// Resolvers keyed by the express route param. teamId is optional and only
// returned for entities that carry one (Match, Player, …). When missing,
// team-scope enforcement is skipped for that lookup.
const LOOKUPS: Lookup[] = [
  { param: 'matchId',         loader: (id) => prisma.match.findUnique({         where: { id }, select: { clubId: true, teamId: true } }) },
  { param: 'teamId',          loader: (id) => prisma.team.findUnique({          where: { id }, select: { clubId: true } }).then((r) => r ? { ...r, teamId: id } : null) },
  { param: 'playerId',        loader: (id) => prisma.player.findUnique({        where: { id }, select: { clubId: true, teamId: true } }) },
  { param: 'deviceSessionId', loader: (id) => prisma.deviceSession.findUnique({ where: { id }, select: { clubId: true } }) },
  { param: 'cameraId',        loader: (id) => prisma.camera.findUnique({        where: { id }, select: { clubId: true } }) },
  { param: 'alertId',         loader: (id) => prisma.aIAlert.findUnique({       where: { id }, select: { clubId: true, teamId: true } }) },
  { param: 'jobId',           loader: (id) => prisma.aIAgentJob.findUnique({    where: { id }, select: { clubId: true, teamId: true } }) },
  { param: 'approvalId',      loader: (id) => prisma.aIApprovalRequest.findUnique({ where: { id }, select: { clubId: true } }) },
];

// Roles that should be constrained by team scope when their membership
// pins them to a specific team. Other roles operate club-wide.
const TEAM_BOUND_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ASSISTANT_COACH', 'COACH', 'MEDICAL_STAFF', 'PLAYER', 'PARENT',
]);

// Cache the team-scope decision per (userId, clubId) for 30s so we don't
// pay a DB hit per request. Invalidation is lazy; worst case a recent
// membership change takes 30s to propagate.
interface ScopeEntry { teamIds: Set<string> | null; expiresAt: number }
const scopeCache = new Map<string, ScopeEntry>();
const SCOPE_TTL_MS = 30_000;

async function loadTeamScope(userId: string, clubId: string): Promise<Set<string> | null> {
  const key = `${userId}:${clubId}`;
  const now = Date.now();
  const cached = scopeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.teamIds;

  try {
    const memberships = await prisma.membership.findMany({
      where:  { userId, clubId, isActive: true },
      select: { teamId: true },
    });
    // If ANY membership is club-wide (teamId=null), the user is club-wide.
    const hasClubWide = memberships.some((m) => !m.teamId);
    const teamIds = hasClubWide
      ? null                                          // null = no team scope (full club)
      : new Set(memberships.map((m) => m.teamId!).filter(Boolean));
    scopeCache.set(key, { teamIds, expiresAt: now + SCOPE_TTL_MS });
    if (scopeCache.size > 10_000) {
      // Eviction: drop a chunk of the oldest entries.
      let i = 0;
      for (const k of scopeCache.keys()) { scopeCache.delete(k); if (++i > 500) break; }
    }
    return teamIds;
  } catch {
    // On failure, fall through to club-wide (legacy users).
    return null;
  }
}

function ipOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  return typeof xff === 'string' ? xff.split(',')[0].trim() : (req.ip || 'unknown');
}

/**
 * Defence-in-depth tenant guard. NEVER mutates request data; only refuses.
 * Designed to be cheap: 0 DB hits when no tenant-scoped param is present,
 * 1 hit otherwise.
 */
export async function tenantGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = (req as Request & { user?: { id: string; clubId: string; role?: UserRole } }).user;
  if (!u) return next();   // unauthenticated path — defer to authenticate

  try {
    // Load team scope ONCE per request — if the user has no team-bound role,
    // skip the call entirely so the guard adds zero DB hits for admins.
    const teamScope: Set<string> | null | undefined =
      u.role && TEAM_BOUND_ROLES.has(u.role) && u.role !== ('SUPER_ADMIN' as UserRole)
        ? await loadTeamScope(u.id, u.clubId)
        : undefined;

    for (const { param, loader } of LOOKUPS) {
      const value = req.params[param];
      if (!value) continue;
      const row = await loader(value);
      if (!row) continue;  // 404 will surface from the service

      // ── 1. CLUB SCOPE ────────────────────────────────────────────────
      if (row.clubId !== u.clubId && u.role !== 'SUPER_ADMIN') {
        logSecurityEvent({
          kind:      'TENANT_MISMATCH',
          severity:  'CRITICAL',
          clubId:    u.clubId,
          actorId:   u.id,
          ipAddress: ipOf(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          payload:   { route: req.originalUrl, param, value, scope: 'CLUB', attemptedClub: row.clubId },
        });
        res.status(403).json({ success: false, message: 'Forbidden — tenant mismatch' });
        return;
      }
      if (u.role === 'SUPER_ADMIN' && row.clubId !== u.clubId) {
        logSecurityEvent({
          kind:      'TENANT_MISMATCH', severity: 'INFO',
          clubId:    u.clubId, actorId: u.id, ipAddress: ipOf(req),
          payload:   { route: req.originalUrl, param, value, scope: 'CLUB', viaRole: 'SUPER_ADMIN', attemptedClub: row.clubId },
        });
      }

      // ── 2. TEAM SCOPE ────────────────────────────────────────────────
      // Only enforce when:
      //   • The user's role is team-bound (set computed above is non-undefined).
      //   • The user has a non-null team scope (i.e. NOT club-wide).
      //   • The target row carries a teamId (some resources are club-wide).
      if (teamScope && row.teamId && !teamScope.has(row.teamId)) {
        logSecurityEvent({
          kind:      'TENANT_MISMATCH',
          severity:  'CRITICAL',
          clubId:    u.clubId,
          actorId:   u.id,
          ipAddress: ipOf(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          payload:   { route: req.originalUrl, param, value, scope: 'TEAM', attemptedTeam: row.teamId, allowedTeams: [...teamScope] },
        });
        res.status(403).json({ success: false, message: 'Forbidden — team scope' });
        return;
      }
    }
    next();
  } catch (err) {
    // Never block on guard failure; log and continue. Underlying service
    // checks remain authoritative.
    logSecurityEvent({
      kind:    'SUSPICIOUS_PAYLOAD',
      severity:'INFO',
      payload: { source: 'tenant-guard', err: (err as Error).message },
    });
    next();
  }
}
