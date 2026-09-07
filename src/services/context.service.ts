// Familista — Active-context service (Phase A)
//
// "Context" = which club + team the user is currently working inside.
// Read /me/context → list of available clubs/teams and the currently selected pair.
// Write /me/context → switch tenant (verified against active Memberships).

import { Prisma, MembershipAuditAction } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, BadRequestError } from '../utils/errors';
import { getActiveMembershipsForUser, hasActiveMembership } from './membership.service';
import {
  privateTeamScope, hasClubWideManageAuthority, isAcademyKind,
} from '../identity/team-access.service';
import { isPlatformOwner } from '../platform/access-levels';
import { forgetIdentity } from '../middleware/auth.middleware';

export async function getContext(userId: string) {
  const [user, memberships] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, role: true,
        clubId: true,
        currentClubId: true,
        currentTeamId: true,
        currentClub:   { select: { id: true, name: true, shortName: true, emblem: true, crestUrl: true, plan: true } },
        currentTeam:   { select: { id: true, name: true, kind: true } },
      },
    }),
    getActiveMembershipsForUser(userId),
  ]);
  if (!user) throw new ForbiddenError();

  // De-duplicate clubs from memberships, then group teams per club.
  const clubMap = new Map<string, { id: string; name: string; shortName: string | null; emblem: string | null; crestUrl: string | null; plan: string; teams: Array<{ id: string; name: string; kind: string }>; roles: string[] }>();
  for (const m of memberships) {
    const c = m.club;
    if (!clubMap.has(c.id)) {
      clubMap.set(c.id, { ...c, teams: [], roles: [] });
    }
    // The AUTHORITATIVE role, per club.
    //
    // `legacyRole` below is User.role — an account-level field that predates
    // memberships and is what some older club routes still check. It is not
    // what somebody IS in a club: an invited president holds a CLUB_OWNER
    // membership and a CLUB_ADMIN account role, and showing the second one
    // labels the club's owner as its administrator. A screen that wants to
    // name somebody's role reads this.
    const entry = clubMap.get(c.id)!;
    if (!entry.roles.includes(m.role)) entry.roles.push(m.role);

    if (m.team && !entry.teams.find((t) => t.id === m.team!.id)) {
      entry.teams.push({ id: m.team.id, name: m.team.name, kind: m.team.kind });
    }
  }

  // Backward compat: if the user has no Memberships at all (legacy account),
  // fall back to their primary clubId so the UI still works.
  if (clubMap.size === 0 && user.clubId) {
    const club = await prisma.club.findUnique({
      where: { id: user.clubId },
      select: { id: true, name: true, shortName: true, emblem: true, crestUrl: true, plan: true },
    });
    // A legacy account with no membership row has no authoritative role to
    // report, and an empty list is the honest answer rather than a guess.
    if (club) clubMap.set(club.id, { ...club, teams: [], roles: [] });
  }

  const clubs = Array.from(clubMap.values());

  // The strongest membership held in the club currently open. Ordered by
  // authority so "CLUB_OWNER plus HEAD_COACH" reads as owner, which is what
  // that person is.
  const RANK = ['CLUB_OWNER', 'CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ASSISTANT_COACH',
    'ANALYST', 'SCOUT', 'MEDICAL_STAFF', 'PARENT', 'PLAYER', 'DEVICE'];
  const currentRoles = user.currentClubId ? (clubMap.get(user.currentClubId)?.roles ?? []) : [];
  const currentClubRole = currentRoles.length
    ? [...currentRoles].sort((a, b) => {
      const ia = RANK.indexOf(a); const ib = RANK.indexOf(b);
      return (ia < 0 ? RANK.length : ia) - (ib < 0 ? RANK.length : ib);
    })[0]
    : null;

  // ── which teams this person may actually work with ────────────────────────
  //
  // The context is what the topbar's team selector reads, and it used to read
  // GET /teams — every team in the club, unfiltered — and offer "All teams" on
  // top of it. A head coach assigned to the first team was therefore offered
  // the under-13s and an "all teams" scope they do not have.
  //
  // This is the authoritative answer instead, from the same team-access service
  // every private read is gated by. `unrestricted` means their access genuinely
  // covers the club's teams — a club-wide staff membership, or an account with
  // no memberships at all, which is the legacy case that has always been
  // club-wide. Otherwise `teams` is exactly what they may open, and there is no
  // "all teams" for them to pick.
  //
  // The server refuses an unauthorised team in switchContext regardless; this
  // is so the interface stops offering what the server would refuse.
  const scope = user.currentClubId
    ? await privateTeamScope({ userId: user.id, clubId: user.currentClubId, role: user.role })
    : { unrestricted: false, teamIds: [] as string[] };

  // ── what this person may actually reach, as capabilities ──────────────────
  //
  // The sidebar used to be a fixed list: every club module, for everybody who
  // could open a club. A head coach hired for one team was therefore offered
  // People & Access, the Coach Market and the Academy — screens that belong to
  // whoever runs the club, not to whoever runs a team.
  //
  // These are DERIVED, never declared: each one is the same question the
  // server already asks before it answers a request, so a capability cannot
  // drift away from the guard it stands for. Nothing here grants anything —
  // every route still checks for itself, and a client that lies about these
  // gets a 403 rather than a screen.
  const [platformOwner, clubWideManage] = await Promise.all([
    isPlatformOwner({ userId: user.id, role: user.role }),
    user.currentClubId
      ? hasClubWideManageAuthority({ userId: user.id, clubId: user.currentClubId, role: user.role })
      : Promise.resolve(false),
  ]);

  // Running the club, as `requireMembership('CLUB_ADMIN')` means it: the same
  // ranking the middleware uses, asked of the same memberships. This is what
  // People & Access, the membership writes and the invitation routes require.
  const MANAGE_CLUB_ROLES = ['CLUB_OWNER', 'CLUB_ADMIN'];
  const canManageClub = currentRoles.some((r) => MANAGE_CLUB_ROLES.includes(r));

  // The academy is a workspace, not a label: it opens to somebody assigned to
  // an academy side, or to somebody who runs the club and therefore runs all
  // of them. A first-team coach holds neither.
  const myTeamKinds = memberships
    .filter((m) => m.clubId === user.currentClubId && m.team)
    .map((m) => m.team!.kind as string);
  const canAccessAcademy = clubWideManage || myTeamKinds.some((k) => isAcademyKind(k));

  const scopedTeams = (!scope.unrestricted && scope.teamIds.length)
    ? await prisma.team.findMany({
      where: { id: { in: scope.teamIds }, clubId: user.currentClubId! },
      select: { id: true, name: true, shortName: true, kind: true, isActive: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    })
    : [];

  return {
    userId:           user.id,
    legacyClubId:     user.clubId,
    /** User.role — the account-level field. NOT what somebody is in a club. */
    legacyRole:       user.role,
    /** The authoritative membership role in the club currently open. */
    currentClubRole,
    /**
     * The teams this person may work with in the club currently open.
     *
     * `unrestricted: true` — their access covers the club's teams, and an
     * "all teams" context is theirs to pick. Otherwise `teams` is the whole
     * list they may choose between, and nothing outside it is offerable.
     */
    currentTeamScope: {
      unrestricted: scope.unrestricted,
      teams: scopedTeams,
    },
    /**
     * What this account may reach in the club now open.
     *
     * Read by the navigation, so the sidebar is built from effective access
     * rather than from a role name. Every value is derived from the services
     * that already gate the corresponding request; none of them grants
     * anything, and the routes behind each module check for themselves.
     */
    effectiveAccess: {
      /** SUPER_ADMIN or an active PlatformAdmin row. Never a club role. */
      isPlatformOwner: platformOwner,
      /** A club-wide managing membership — reaches every team in the club. */
      hasClubWideManageAuthority: clubWideManage,
      /** CLUB_OWNER or CLUB_ADMIN here: what requireMembership('CLUB_ADMIN') wants. */
      canManageClub,
      /** Invite, suspend, remove — the People & Access screen. */
      canManagePeople: canManageClub,
      /**
       * Recruitment. Club-level work, so it takes club-level authority: a
       * coach hired to run one team is not the club's recruiter.
       *
       * NOTE, and it is not a small one: the transfer and coach-market WRITE
       * routes still authorise on User.role, which includes HEAD_COACH. This
       * capability is deliberately narrower than that guard, so the module is
       * not offered — but it does not make the guard narrower, and only the
       * guard is security. See the report accompanying this change.
       */
      canAccessTransfers: clubWideManage,
      canAccessCoachMarket: clubWideManage,
      /** The club's staff directory — who works where, across every team. */
      canAccessStaffDirectory: clubWideManage,
      /** An academy assignment, or the authority that covers every team. */
      canAccessAcademy,
      /** Any team at all: the football modules need one team to be about. */
      canAccessTeamWorkspace: scope.unrestricted || scope.teamIds.length > 0,
      /** The teams this person may work with. Empty with `unrestricted`. */
      authorizedTeamIds: scope.unrestricted ? [] : scope.teamIds,
    },
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
    // Legacy accounts — the ones that predate memberships entirely — may still
    // switch to their primary club, until the backfill has run everywhere.
    //
    // But ONLY those. `User.clubId` is NOT NULL, so it cannot be cleared when
    // somebody is removed from a club, and without this check that column
    // would quietly hand a removed or suspended member their club back: the
    // membership says no, the legacy field says yes, and the legacy field
    // wins. So the fallback is refused to anybody this system has actually
    // managed. A membership row that exists and is not active is a decision
    // the club made, and a column that predates it does not overrule it.
    const [user, everManaged] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.userId }, select: { clubId: true } }),
      prisma.membership.count({ where: { userId: actor.userId, clubId } }),
    ]);
    if (!user || user.clubId !== clubId || everManaged > 0) {
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
      // Final legacy fallback: a primary-clubId account with no memberships at
      // all may pick any team in its own club.
      //
      // Emphatically NOT anybody who has memberships. A coach invited to the
      // under-13s holds one team-scoped membership, and `registerInvitedUser`
      // sets their `User.clubId` to the club they were invited to — so without
      // the second condition this fallback would let that coach switch context
      // into the first team, which is the whole thing team scoping exists to
      // prevent. Private reads ask team-access and would still refuse them,
      // but a context they were never granted must not be enterable in the
      // first place.
      const [u, everManaged] = await Promise.all([
        prisma.user.findUnique({ where: { id: actor.userId }, select: { clubId: true } }),
        prisma.membership.count({ where: { userId: actor.userId, clubId } }),
      ]);
      if (!u || u.clubId !== clubId || everManaged > 0) {
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

  // The club a user is acting for is part of their identity, and the very next
  // request will be scoped by it. It must not be answered from the club they
  // just switched away from.
  forgetIdentity(actor.userId);

  return getContext(actor.userId);
}
