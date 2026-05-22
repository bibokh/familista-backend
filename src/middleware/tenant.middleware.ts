// Familista — Tenant middleware (Phase A)
//
// Verifies that the caller has an active Membership for their currently
// selected club. Optionally enforces a minimum MembershipRole.
//
// Chain after `authenticate`. Example:
//
//   router.get('/teams', authenticate, requireMembership(), ctrl.list);
//   router.post('/teams', authenticate, requireMembership('CLUB_ADMIN'), ctrl.create);
//
// Notes:
// - The legacy User.role (CLUB_ADMIN/HEAD_COACH/...) still works via the
//   existing `authorize(...)` middleware. `requireMembership` is the new,
//   scope-aware gate. They can be combined.
// - SUPER_ADMIN bypasses every membership check.

import type { Request, Response, NextFunction } from 'express';
import { MembershipRole } from '@prisma/client';
import { prisma } from '../config/database';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

// Hierarchy used when caller passes a *minimum* required role.
// Higher number = more authority. SUPER_ADMIN handled separately.
const ROLE_RANK: Record<MembershipRole, number> = {
  CLUB_OWNER:      100,
  CLUB_ADMIN:       90,
  HEAD_COACH:       70,
  ASSISTANT_COACH:  60,
  ANALYST:          55,
  MEDICAL_STAFF:    50,
  PHYSIO:           50,
  SCOUT:            45,
  FINANCE_MANAGER:  60,
  PARENT:           20,
  PLAYER:           20,
  DEVICE:           10,
};

export function requireMembership(minRole?: MembershipRole) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) throw new UnauthorizedError('Authentication required');

      // SUPER_ADMIN bypasses tenancy entirely.
      if (req.user.role === 'SUPER_ADMIN') return next();

      const clubId = req.user.clubId;
      if (!clubId) throw new ForbiddenError('No active club context');

      const memberships = await prisma.membership.findMany({
        where:  { userId: req.user.id, clubId, isActive: true },
        select: { role: true, teamId: true },
      });

      if (memberships.length === 0) {
        throw new ForbiddenError('No active membership for the current club');
      }

      if (minRole) {
        const minRank = ROLE_RANK[minRole] ?? 0;
        const max     = Math.max(...memberships.map((m) => ROLE_RANK[m.role] ?? 0));
        if (max < minRank) {
          throw new ForbiddenError(`Insufficient membership role (need ${minRole} or higher)`);
        }
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Convenience helper: returns the strongest role the caller holds in their
// active club, or null. Useful inside services for fine-grained branching.
export async function effectiveMembershipRole(
  userId: string,
  clubId: string,
): Promise<MembershipRole | null> {
  const rows = await prisma.membership.findMany({
    where:  { userId, clubId, isActive: true },
    select: { role: true },
  });
  if (rows.length === 0) return null;
  return rows.sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))[0].role;
}
