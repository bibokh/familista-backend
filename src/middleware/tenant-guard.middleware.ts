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
//      Team scope is decided by the MEMBERSHIP, not by the account role.
//      A club is a First Team and a set of academy age groups, and a person
//      assigned to one of them is not thereby assigned to the others — so
//      whichever role the account carries, a membership pinned to a team is
//      enforced as pinned. A role-name allow-list could only ever disagree
//      with the assignment it was meant to describe.
//
//      A user with NO team-scoped membership — a club-wide membership, or a
//      legacy user with only User.role — is club-wide and bypasses team
//      scope, so no existing behaviour breaks.
//
//      A mismatch logs TENANT_MISMATCH (severity HIGH) and refuses 403.
//
// SUPER_ADMIN bypasses both comparisons but is still logged at INFO.

import { recordOutcome } from '../infra/outcome-meter';
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

// Only the platform administrator stands outside a club's team structure.
// Everybody else is scoped by what their memberships actually say, which is
// what `loadTeamScope` reads: null for a club-wide membership, a set for
// assignments to particular teams.
function isTeamScoped(role: UserRole | undefined): boolean {
  return role !== ('SUPER_ADMIN' as UserRole);
}

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
    // So is a user with NO membership rows at all: a legacy account carrying
    // only User.role has never been assigned to a team, and refusing it every
    // team-scoped resource would be a migration breaking existing users rather
    // than a boundary protecting anybody. Only an ACTUAL assignment narrows.
    const hasClubWide = memberships.length === 0 || memberships.some((m) => !m.teamId);
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

interface GuardUser { id: string; clubId: string; role?: UserRole }

/**
 * The one comparison both guards make: is this row the caller's club's, and —
 * for a team-pinned membership — the caller's team's? Refuses with 403 and a
 * logged TENANT_MISMATCH when it is not. Returns true when the request may go on.
 */
function admitRow(
  req: Request, res: Response, u: GuardUser, teamScope: Set<string> | null | undefined,
  param: string, value: string, row: { clubId: string | null; teamId?: string | null },
): boolean {
  // A row with no club is platform-wide (a global competition, a public node):
  // there is no tenant to compare, and the service decides who may change it.
  if (row.clubId === null) return true;

  // ── 1. CLUB SCOPE ────────────────────────────────────────────────────
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
    return false;
  }
  if (u.role === 'SUPER_ADMIN' && row.clubId !== u.clubId) {
    logSecurityEvent({
      kind:      'TENANT_MISMATCH', severity: 'INFO',
      clubId:    u.clubId, actorId: u.id, ipAddress: ipOf(req),
      payload:   { route: req.originalUrl, param, value, scope: 'CLUB', viaRole: 'SUPER_ADMIN', attemptedClub: row.clubId },
    });
  }

  // ── 2. TEAM SCOPE ────────────────────────────────────────────────────
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
    return false;
  }
  return true;
}

/**
 * Defence-in-depth tenant guard. NEVER mutates request data; only refuses.
 * Designed to be cheap: 0 DB hits when no tenant-scoped param is present,
 * 1 hit otherwise.
 *
 * It reads `req.params`, which Express fills in only once a route has matched:
 * mounted with `router.use` it sees an empty object and checks nothing. On a
 * route, use `tenantParam` (below) or `guardTeamScopedRouter`.
 */
export async function tenantGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = (req as Request & { user?: GuardUser }).user;
  if (!u) return next();   // unauthenticated path — defer to authenticate

  try {
    // Load team scope ONCE per request — if the user has no team-bound role,
    // skip the call entirely so the guard adds zero DB hits for admins.
    const teamScope: Set<string> | null | undefined =
      isTeamScoped(u.role)
        ? await loadTeamScope(u.id, u.clubId)
        : undefined;

    for (const { param, loader } of LOOKUPS) {
      const value = req.params[param];
      if (!value) continue;
      const row = await loader(value);
      if (!row) continue;  // 404 will surface from the service
      if (!admitRow(req, res, u, teamScope, param, value, row)) return;
    }
    recordOutcome('rbac', true);
    next();
  } catch (err) {
    // Never block on guard failure; log and continue. Underlying service
    // checks remain authoritative. It is still a guard that could not decide,
    // and the Authorization & RBAC building counts it.
    recordOutcome('rbac', false);
    logSecurityEvent({
      kind:    'SUSPICIOUS_PAYLOAD',
      severity:'INFO',
      payload: { source: 'tenant-guard', err: (err as Error).message },
    });
    next();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-route tenant guard (Cyber Defense R2)
// ─────────────────────────────────────────────────────────────────────────
//
// A parameter name does not say what it names: `:id` is an edge node on one
// router and a camera rig on the next, and `:jobId` is an AI agent job here
// and a federated training job there. So the route says which resource its
// parameter is, and the guard resolves THAT row's club:
//
//   router.get('/nodes/:id', tenantParam('edgeNode'), ctrl.getOne);
//
// Each owner below reads the club from the row itself or, where the row has
// none, from the parent that does. `scripts/security-discover.js` requires
// every id parameter on every mounted route to carry this guard (or the
// router-wide `guardTeamScopedRouter` / `router.param` hook), or a written
// exemption in `src/cyber-defense/posture-policy.json`.

type Owner = { clubId: string | null; teamId?: string | null } | null;
const ownerVia = async (parentClub: Promise<{ clubId: string } | null>): Promise<Owner> => {
  const p = await parentClub;
  return p ? { clubId: p.clubId } : null;
};

export const TENANT_RESOURCES = {
  match:                    (id: string): Promise<Owner> => prisma.match.findUnique({ where: { id }, select: { clubId: true, teamId: true } }),
  device:                   (id: string): Promise<Owner> => prisma.device.findUnique({ where: { id }, select: { clubId: true } }),
  camera:                   (id: string): Promise<Owner> => prisma.camera.findUnique({ where: { id }, select: { clubId: true } }),
  edgeNode:                 (id: string): Promise<Owner> => prisma.edgeNode.findUnique({ where: { id }, select: { clubId: true } }),
  eventCameraStream:        (id: string): Promise<Owner> => prisma.eventCameraStream.findUnique({ where: { id }, select: { clubId: true } }),
  cameraRig:                (id: string): Promise<Owner> => prisma.cameraRig.findUnique({ where: { id }, select: { clubId: true } }),
  cameraSyncSession:        async (id: string): Promise<Owner> => {
    const s = await prisma.cameraSyncSession.findUnique({ where: { id }, select: { rigId: true } });
    return s ? ownerVia(prisma.cameraRig.findUnique({ where: { id: s.rigId }, select: { clubId: true } })) : null;
  },
  edgeVisionRuntime:        (id: string): Promise<Owner> => prisma.edgeVisionRuntime.findUnique({ where: { id }, select: { clubId: true } }),
  decisionCouncil:          (id: string): Promise<Owner> => prisma.decisionCouncil.findUnique({ where: { id }, select: { clubId: true } }),
  marketplaceItem:          (id: string): Promise<Owner> => prisma.marketplaceItem.findUnique({ where: { id }, select: { clubId: true } }),
  cryptographicGraphAnchor: (id: string): Promise<Owner> => prisma.cryptographicGraphAnchor.findUnique({ where: { id }, select: { clubId: true } }),
  aIApprovalRequest:        (id: string): Promise<Owner> => prisma.aIApprovalRequest.findUnique({ where: { id }, select: { clubId: true } }),
  twinSimulationSession:    (id: string): Promise<Owner> => prisma.twinSimulationSession.findUnique({ where: { id }, select: { clubId: true } }),
  hardwareProvisioningSession: (id: string): Promise<Owner> => prisma.hardwareProvisioningSession.findUnique({ where: { id }, select: { clubId: true } }),
  invoiceDraft:             async (id: string): Promise<Owner> => {
    const d = await prisma.invoiceDraft.findUnique({ where: { id }, select: { billingAccountId: true } });
    return d ? ownerVia(prisma.billingAccount.findUnique({ where: { id: d.billingAccountId }, select: { clubId: true } })) : null;
  },
  // A competition with no club is a platform competition, open to every club.
  competition:              (id: string): Promise<Owner> => prisma.competition.findUnique({ where: { id }, select: { clubId: true } }),
} as const;

export type TenantResource = keyof typeof TENANT_RESOURCES;

/**
 * Refuses the request unless the row named by `req.params[param]` belongs to
 * the caller's club (and, for a team-pinned membership, the caller's team).
 *
 * Unlike the router-wide `tenantGuard` it FAILS CLOSED: a lookup that throws
 * is an error response, not a pass. A route carries this guard because the
 * question matters there, and "could not check" is not "checked".
 * Unauthenticated requests pass through untouched — `authenticate` (or a
 * device signature) decides those.
 */
export function tenantParam(resource: TenantResource, param = 'id') {
  const loader = TENANT_RESOURCES[resource];
  return async function tenantParamGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const u = (req as Request & { user?: GuardUser }).user;
    const value = req.params[param];
    if (!u || !value) return next();
    try {
      const row = await loader(value);
      if (!row) return next();  // 404 will surface from the service
      const teamScope = isTeamScoped(u.role) ? await loadTeamScope(u.id, u.clubId) : undefined;
      if (!admitRow(req, res, u, teamScope, param, value, row)) { recordOutcome('rbac', true); return; }
      recordOutcome('rbac', true);
      next();
    } catch (err) {
      recordOutcome('rbac', false);
      next(err);
    }
  };
}
