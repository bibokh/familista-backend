// Familista — Active-context service (Phase A)
//
// "Context" = which club + team the user is currently working inside.
// Read /me/context → list of available clubs/teams and the currently selected pair.
// Write /me/context → switch tenant (verified against active Memberships).

import { Prisma, MembershipAuditAction } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, BadRequestError } from '../utils/errors';
import { getActiveMembershipsForUser, hasActiveMembership } from './membership.service';

export async function getContext(userId: string) {
  const [user, memberships] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, role: true,
        clubId: true,
        currentClubId: true,
        currentTeamId: true,
        currentClub:   { select: { id: true, name: true, shortName: true, emblem: true, plan: true } },
        currentTeam:   { select: { id: true, name: true, kind: true } },
      },
    }),
    getActiveMembershipsForUser(userId),
  ]);
  if (!user) throw new ForbiddenError();

  // De-duplicate clubs from memberships, then group teams per club.
  const clubMap = new Map<string, { id: string; name: string; shortName: string | null; emblem: string | null; plan: string; teams: Array<{ id: string; name: string; kind: string }> }>();
  for (const m of memberships) {
    const c = m.club;
    if (!clubMap.has(c.id)) {
      clubMap.set(c.id, { ...c, teams: [] });
    }
    if (m.team && !clubMap.get(c.id)!.teams.find((t) => t.id === m.team!.id)) {
      clubMap.get(c.id)!.teams.push({ id: m.team.id, name: m.team.name, kind: m.team.kind });
    }
  }

  // Backward compat: if the user has no Memberships at all (legacy account),
  // fall back to their primary clubId so the UI still works.
  if (clubMap.size === 0 && user.clubId) {
    const club = await prisma.club.findUnique({
      where: { id: user.clubId },
      select: { id: true, name: true, shortName: true, emblem: true, plan: true },
    });
    if (club) clubMap.set(club.id, { ...club, teams: [] });
  }

  const clubs = Array.from(clubMap.values());

  return {
    userId:           user.id,
    legacyClubId:     user.clubId,
    legacyRole:       user.role,
    currentClubId:    user.currentClubId,
    currentTeamId:    user.currentTeamId,
    currentClub:      user.currentClub,
    currentTeam:      user.currentTeam,
    availableClubs:   clubs,
  };
}

export async function switchContext(
  actor: { userId: string; ipAddress?: string | null; userAgent?: string | null },
  clubId: string,
  teamId: string | null,
) {
  if (!clubId) throw new BadRequestError('clubId is required');

  // The user must have at least one active membership in the target club.
  const ok = await hasActiveMembership(actor.userId, clubId);
  if (!ok) {
    // Allow legacy accounts to switch to their primary club even without an
    // explicit Membership row (until backfill runs in production).
    const user = await prisma.user.findUnique({
      where: { id: actor.userId }, select: { clubId: true },
    });
    if (!user || user.clubId !== clubId) {
      throw new ForbiddenError('No active membership for the requested club');
    }
  }

  // If a team is requested, verify it belongs to the club AND the user
  // either has a club-wide membership (teamId=null) or a team-specific one.
  if (teamId) {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { clubId: true, isActive: true },
    });
    if (!team)                     throw new BadRequestError('Team not found');
    if (team.clubId !== clubId)    throw new ForbiddenError('Team does not belong to that club');
    if (!team.isActive)            throw new BadRequestError('Team is archived');

    const scoped = await prisma.membership.findFirst({
      where: {
        userId: actor.userId, clubId, isActive: true,
        OR: [{ teamId: null }, { teamId }],
      },
      select: { id: true },
    });
    if (!scoped) {
      // Final legacy fallback: primary clubId users can pick any team in their own club.
      const u = await prisma.user.findUnique({ where: { id: actor.userId }, select: { clubId: true } });
      if (!u || u.clubId !== clubId) {
        throw new ForbiddenError('No membership covers that team');
      }
    }
  }

  const before = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { currentClubId: true, currentTeamId: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: actor.userId },
      data:  { currentClubId: clubId, currentTeamId: teamId ?? null },
    });
    await tx.membershipAuditLog.create({
      data: {
        clubId,
        actorUserId: actor.userId,
        action: MembershipAuditAction.CONTEXT_SWITCH,
        before: (before ?? {}) as Prisma.InputJsonValue,
        after:  { currentClubId: clubId, currentTeamId: teamId ?? null } as Prisma.InputJsonValue,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
      },
    });
  });

  return getContext(actor.userId);
}
