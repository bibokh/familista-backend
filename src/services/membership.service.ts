// Familista — Membership service (Phase A)
//
// Every Membership write goes through a transaction that ALSO inserts a
// MembershipAuditLog row, so audit + state stay consistent under failure.
// Tenancy: every read/write is scoped by clubId of the calling actor.

import {
  Membership, MembershipRole, MembershipAuditAction, MembershipStatus, Prisma,
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

/**
 * A club must never be left without an owner.
 *
 * Revoking, suspending or demoting the last active CLUB_OWNER would leave a
 * club nobody can administer — nobody to invite staff, nobody to restore the
 * owner. The check is here rather than in a screen because a screen is not what
 * a curl request goes through.
 */
export async function assertNotLastOwner(clubId: string, membershipId: string): Promise<void> {
  const target = await prisma.membership.findUnique({
    where: { id: membershipId },
    select: { role: true, isActive: true, clubId: true },
  });
  if (!target || target.clubId !== clubId) return;
  if (target.role !== MembershipRole.CLUB_OWNER || !target.isActive) return;

  const others = await prisma.membership.count({
    where: { clubId, role: MembershipRole.CLUB_OWNER, isActive: true, id: { not: membershipId } },
  });
  if (others === 0) {
    throw new ConflictError(
      'That is the club\'s last active owner. Give the club another owner before removing or changing this one.',
    );
  }
}

/**
 * What must stop when somebody's last membership of a club ends.
 *
 * Team access disappears on its own — every private read asks team-access,
 * which reads live rows — but two things do not: an active context still
 * pointing at the club they have left, and refresh tokens that would mint new
 * access tokens. Both are closed here.
 *
 * The account itself is untouched. Leaving a club is not leaving Familista:
 * the person keeps their identity, their password and their public browsing.
 */
export async function endClubSession(userId: string, clubId: string): Promise<void> {
  const stillIn = await prisma.membership.count({ where: { userId, clubId, isActive: true } });
  if (stillIn > 0) return;

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { currentClubId: true, currentTeamId: true },
    });
    if (user?.currentClubId === clubId) {
      await tx.user.update({ where: { id: userId }, data: { currentClubId: null, currentTeamId: null } });
    }
    // Every refresh token this person holds stops working, and the access
    // tokens already issued stop being trusted at their next request. Their
    // password is not touched: this ends an employment, not an identity.
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
  });
}

export async function revokeMembership(
  actor: MembershipActor,
  id: string,
  reason?: string,
): Promise<void> {
  const existing = await getMembershipById(id, actor.clubId);
  if (!existing.isActive) return;
  await assertNotLastOwner(actor.clubId, id);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.membership.update({
      where: { id },
      data:  { isActive: false, status: MembershipStatus.REMOVED, leftAt: new Date() },
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

  // Outside the transaction on purpose: the membership is already gone, and a
  // failure to clear a session must not roll the revocation back.
  await endClubSession(existing.userId, actor.clubId);
}

/**
 * Suspend without removing.
 *
 * A season out, an investigation, a lapsed licence: the person stays on the
 * club's books and their access stops. Reactivating is one call, and their
 * history — every audit row — is continuous across it.
 */
export async function suspendMembership(
  actor: MembershipActor,
  id: string,
  reason?: string,
): Promise<Membership> {
  const existing = await getMembershipById(id, actor.clubId);
  if (!existing.isActive) throw new BadRequestError('That membership is not active');
  await assertNotLastOwner(actor.clubId, id);
  const before = snapshot(existing);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.membership.update({
      where: { id },
      data: { isActive: false, status: MembershipStatus.SUSPENDED, leftAt: new Date() },
    });
    await tx.membershipAuditLog.create({
      data: {
        membershipId: id, clubId: actor.clubId, actorUserId: actor.userId,
        action: MembershipAuditAction.SUSPEND,
        before: before as Prisma.InputJsonValue,
        after: snapshot(row) as Prisma.InputJsonValue,
        reason, ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
    return row;
  });

  await endClubSession(existing.userId, actor.clubId);
  return updated;
}

export async function reactivateMembership(
  actor: MembershipActor,
  id: string,
  reason?: string,
): Promise<Membership> {
  const existing = await getMembershipById(id, actor.clubId);
  if (existing.isActive) return existing;

  // Read before the write, not after it. Whether this was a suspension or a
  // removal decides which action the audit records, and asking the row again
  // once it has been updated would answer about the new state.
  const wasSuspended = existing.status === MembershipStatus.SUSPENDED;
  const before = snapshot(existing);

  return prisma.$transaction(async (tx) => {
    const row = await tx.membership.update({
      where: { id },
      data: { isActive: true, status: MembershipStatus.ACTIVE, leftAt: null },
    });
    await tx.membershipAuditLog.create({
      data: {
        membershipId: id, clubId: actor.clubId, actorUserId: actor.userId,
        action: wasSuspended ? MembershipAuditAction.UNSUSPEND : MembershipAuditAction.REACTIVATE,
        before: before as Prisma.InputJsonValue,
        after: snapshot(row) as Prisma.InputJsonValue,
        reason, ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
    return row;
  });
}

/**
 * Move a membership between teams, or between a team and the club as a whole.
 *
 * The destination is checked against the actor's own club, so a membership
 * cannot be pushed into another club's team by naming its id.
 */
export async function changeTeam(
  actor: MembershipActor,
  id: string,
  teamId: string | null,
  reason?: string,
): Promise<Membership> {
  const existing = await getMembershipById(id, actor.clubId);
  if (teamId) {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { clubId: true } });
    if (!team) throw new NotFoundError('Team');
    if (team.clubId !== actor.clubId) throw new ForbiddenError();
  }
  if ((existing.teamId ?? null) === (teamId ?? null)) return existing;
  const before = snapshot(existing);

  return prisma.$transaction(async (tx) => {
    const row = await tx.membership.update({ where: { id }, data: { teamId: teamId ?? null } });
    await tx.membershipAuditLog.create({
      data: {
        membershipId: id, clubId: actor.clubId, actorUserId: actor.userId,
        action: MembershipAuditAction.TEAM_CHANGED,
        before: before as Prisma.InputJsonValue,
        after: snapshot(row) as Prisma.InputJsonValue,
        reason, ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      },
    });
    return row;
  });
}

export async function changeRole(
  actor: MembershipActor,
  id: string,
  dto: ChangeRoleDto,
): Promise<Membership> {
  const existing = await getMembershipById(id, actor.clubId);
  if (existing.role === dto.role) return existing;
  // Demoting the last owner leaves the club ownerless just as surely as
  // removing them does.
  if (existing.role === MembershipRole.CLUB_OWNER && dto.role !== MembershipRole.CLUB_OWNER) {
    await assertNotLastOwner(actor.clubId, id);
  }

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
      club: { select: { id: true, name: true, shortName: true, emblem: true, crestUrl: true, plan: true } },
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
