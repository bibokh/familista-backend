// Familista — Membership service (Phase A)
//
// Every Membership write goes through a transaction that ALSO inserts a
// MembershipAuditLog row, so audit + state stay consistent under failure.
// Tenancy: every read/write is scoped by clubId of the calling actor.

import {
  Membership, MembershipRole, MembershipAuditAction, Prisma,
} from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ConflictError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface MembershipActor {
  userId:     string;
  clubId:     string;
  role?:      string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListMembershipFilters {
  userId?:   string;
  teamId?:   string | 'NULL';   // 'NULL' = club-wide memberships
  role?:     MembershipRole;
  isActive?: boolean;
  page?:     number;
  limit?:    number;
}

export interface GrantMembershipDto {
  userId: string;
  teamId?: string | null;
  role:   MembershipRole;
}

export interface ChangeRoleDto {
  role:   MembershipRole;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────

export async function listMemberships(clubId: string, filters: ListMembershipFilters = {}) {
  const { userId, teamId, role, isActive, page = 1, limit = 50 } = filters;
  const where: Prisma.MembershipWhereInput = {
    clubId,
    ...(userId && { userId }),
    ...(role   && { role }),
    ...(isActive !== undefined && { isActive }),
    ...(teamId === 'NULL' ? { teamId: null } : teamId ? { teamId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.membership.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { joinedAt: 'desc' }],
      skip:    (page - 1) * limit,
      take:    limit,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true } },
        team: { select: { id: true, name: true, kind: true } },
      },
    }),
    prisma.membership.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getMembershipById(id: string, clubId: string): Promise<Membership> {
  const m = await prisma.membership.findUnique({ where: { id } });
  if (!m)             throw new NotFoundError('Membership');
  if (m.clubId !== clubId) throw new ForbiddenError();
  return m;
}

// ─────────────────────────────────────────────────────────────────────────
// WRITE — every mutation writes one MembershipAuditLog inside the same tx
// ─────────────────────────────────────────────────────────────────────────

function snapshot(m: Membership): Record<string, unknown> {
  return {
    id: m.id, userId: m.userId, clubId: m.clubId, teamId: m.teamId,
    role: m.role, isActive: m.isActive, joinedAt: m.joinedAt, leftAt: m.leftAt,
  };
}

export async function grantMembership(
  actor: MembershipActor,
  dto: GrantMembershipDto,
): Promise<Membership> {
  // Sanity: the target user must exist
  const user = await prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true, isActive: true } });
  if (!user) throw new NotFoundError('User');
  if (!user.isActive) throw new BadRequestError('Cannot grant membership to a deactivated user');

  // If teamId provided, verify it belongs to the same club
  if (dto.teamId) {
    const team = await prisma.team.findUnique({ where: { id: dto.teamId }, select: { clubId: true } });
    if (!team)                        throw new NotFoundError('Team');
    if (team.clubId !== actor.clubId) throw new ForbiddenError();
  }

  // Reuse an existing row if present (re-grant after revoke)
  const existing = await prisma.membership.findFirst({
    where: { userId: dto.userId, clubId: actor.clubId, teamId: dto.teamId ?? null, role: dto.role },
  });

  return prisma.$transaction(async (tx) => {
    let membership: Membership;
    let action: MembershipAuditAction;
    let before: Record<string, unknown> | undefined;

    if (existing) {
      if (existing.isActive) throw new ConflictError('Membership already active');
      before = snapshot(existing);
      membership = await tx.membership.update({
        where: { id: existing.id },
        data:  { isActive: true, leftAt: null },
      });
      action = MembershipAuditAction.REACTIVATE;
    } else {
      membership = await tx.membership.create({
        data: {
          userId:   dto.userId,
          clubId:   actor.clubId,
          teamId:   dto.teamId ?? null,
          role:     dto.role,
          isActive: true,
        },
      });
      action = MembershipAuditAction.GRANT;
    }

    await tx.membershipAuditLog.create({
      data: {
        membershipId: membership.id,
        clubId:       actor.clubId,
        actorUserId:  actor.userId,
        action,
        before:       before as Prisma.InputJsonValue | undefined,
        after:        snapshot(membership) as Prisma.InputJsonValue,
        ipAddress:    actor.ipAddress ?? undefined,
        userAgent:    actor.userAgent ?? undefined,
      },
    });

    return membership;
  });
}

export async function revokeMembership(
  actor: MembershipActor,
  id: string,
  reason?: string,
): Promise<void> {
  const existing = await getMembershipById(id, actor.clubId);
  if (!existing.isActive) return;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.membership.update({
      where: { id },
      data:  { isActive: false, leftAt: new Date() },
    });
    await tx.membershipAuditLog.create({
      data: {
        membershipId: id,
        clubId:       actor.clubId,
        actorUserId:  actor.userId,
        action:       MembershipAuditAction.REVOKE,
        before:       snapshot(existing) as Prisma.InputJsonValue,
        after:        snapshot(updated)  as Prisma.InputJsonValue,
        reason,
        ipAddress:    actor.ipAddress ?? undefined,
        userAgent:    actor.userAgent ?? undefined,
      },
    });
  });
}

export async function changeRole(
  actor: MembershipActor,
  id: string,
  dto: ChangeRoleDto,
): Promise<Membership> {
  const existing = await getMembershipById(id, actor.clubId);
  if (existing.role === dto.role) return existing;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.membership.update({ where: { id }, data: { role: dto.role } });
    await tx.membershipAuditLog.create({
      data: {
        membershipId: id,
        clubId:       actor.clubId,
        actorUserId:  actor.userId,
        action:       MembershipAuditAction.ROLE_CHANGED,
        before:       snapshot(existing) as Prisma.InputJsonValue,
        after:        snapshot(updated)  as Prisma.InputJsonValue,
        reason:       dto.reason,
        ipAddress:    actor.ipAddress ?? undefined,
        userAgent:    actor.userAgent ?? undefined,
      },
    });
    return updated;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Audit reads
// ─────────────────────────────────────────────────────────────────────────

export async function listAudit(clubId: string, opts: { membershipId?: string; page?: number; limit?: number } = {}) {
  const { membershipId, page = 1, limit = 50 } = opts;
  const where: Prisma.MembershipAuditLogWhereInput = { clubId, ...(membershipId && { membershipId }) };
  const [items, total] = await Promise.all([
    prisma.membershipAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.membershipAuditLog.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers used by context.service
// ─────────────────────────────────────────────────────────────────────────

export async function getActiveMembershipsForUser(userId: string) {
  return prisma.membership.findMany({
    where:  { userId, isActive: true },
    include: {
      club: { select: { id: true, name: true, shortName: true, emblem: true, plan: true } },
      team: { select: { id: true, name: true, kind: true } },
    },
    orderBy: [{ joinedAt: 'desc' }],
  });
}

export async function hasActiveMembership(
  userId: string,
  clubId: string,
  teamId?: string | null,
): Promise<boolean> {
  const count = await prisma.membership.count({
    where: {
      userId, clubId, isActive: true,
      ...(teamId === undefined ? {} : { teamId: teamId ?? null }),
    },
  });
  return count > 0;
}
