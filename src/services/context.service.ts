// Familista — Active-context service (Phase A)
//
// "Context" = which club + team the user is currently working inside.
// Read /me/context → list of available clubs/teams and the currently selected pair.
// Write /me/context → switch tenant (verified against active Memberships).

import { Prisma, MembershipAuditAction, MembershipRole } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, BadRequestError } from '../utils/errors';
import { getActiveMembershipsForUser, hasActiveMembership } from './membership.service';
import {
  privateTeamScope, hasClubWideManageAuthority, isAcademyKind,
} from '../identity/team-access.service';
import { resolvePlatformAuthority } from '../platform/access-levels';
import { clubLifecycleOf, isOperableLifecycle, isSuspendedLifecycle } from '../platform/club-lifecycle.service';
import { meetsMembershipRank, strongestMembershipRole } from '../middleware/tenant.middleware';
import { forgetIdentity } from '../middleware/auth.middleware';

/**
 * How many clubs a platform owner's club picker offers.
 *
 * A bound rather than a permission: platform authority reaches every club, and
 * a picker that tried to render all of them on a platform with thousands would
 * be a slow screen rather than a safer one. Administering a club beyond the
 * bound goes through the platform console, which pages.
 */
const PLATFORM_CLUB_PICKER_LIMIT = 200;

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
  const clubMap = new Map<string, { id: string; name: string; shortName: string | null; emblem: string | null; crestUrl: string | null; plan: string; lifecycle?: string; teams: Array<{ id: string; name: string; kind: string }>; roles: string[]; viaPlatform?: boolean }>();
  for (const m of memberships) {
    const c = m.club;
    if (!clubMap.has(c.id)) {
      clubMap.set(c.id, { ...c, lifecycle: String(c.lifecycle), teams: [], roles: [] });
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

  const platformOwner = await resolvePlatformAuthority({ userId: user.id, role: user.role });

  // Backward compat: if the user has no Memberships at all (legacy account),
  // fall back to their primary clubId so the UI still works.
  //
  // Not for a platform owner. `User.clubId` is NOT NULL, so every account has
  // one whether or not it means anything, and for the platform owner it means
  // nothing at all — it is the club their account happened to be created
  // against. Presenting it as "their club" is the same mistake as the CLUB_OWNER
  // membership, one column further down. Their clubs come from platform
  // authority below, and are marked as such.
  if (!platformOwner && clubMap.size === 0 && user.clubId) {
    const club = await prisma.club.findUnique({
      where: { id: user.clubId },
      select: { id: true, name: true, shortName: true, emblem: true, crestUrl: true, plan: true },
    });
    // A legacy account with no membership row has no authoritative role to
    // report, and an empty list is the honest answer rather than a guess.
    if (club) clubMap.set(club.id, { ...club, teams: [], roles: [] });
  }

  // ── the clubs a PLATFORM owner may enter, as the platform ─────────────────
  //
  // Platform authority is not a membership, so none of these clubs appears
  // above — and until now the only way the platform owner could open a club at
  // all was to hold a CLUB_OWNER membership of it. That is exactly backwards:
  // it makes the person who administers Familista look like four clubs'
  // president, and it means removing that pretence would lock them out.
  //
  // So the clubs are listed here instead, from platform authority, and marked
  // `viaPlatform` with an EMPTY role list. The interface shows them as platform
  // access rather than as a club role, the audit trail records a context switch
  // by a platform administrator, and no club acquires an owner it did not
  // appoint. Bounded, because a platform picker is a picker and not an export.
  if (platformOwner) {
    const all = await prisma.club.findMany({
      where: { id: { notIn: [...clubMap.keys()] } },
      select: {
        id: true, name: true, shortName: true, emblem: true, crestUrl: true, plan: true,
        lifecycle: true,
      },
      orderBy: { name: 'asc' },
      take: PLATFORM_CLUB_PICKER_LIMIT,
    });
    for (const club of all) {
      clubMap.set(club.id, { ...club, lifecycle: String(club.lifecycle), teams: [], roles: [], viaPlatform: true });
    }
  }

  // ── what the picker offers ────────────────────────────────────────────────
  //
  // An archived club leaves the ordinary listings: that is what archiving IS,
  // as distinct from deactivating, which leaves the club where it is and shuts
  // the door. Nothing is removed from the database and no membership is
  // touched — the row simply stops being offered to the people who cannot use
  // it, and the platform owner, for whom SYSTEM is the authoritative view of
  // every club in every state, keeps seeing all of them.
  //
  // A DEACTIVATED club is still listed, deliberately. Somebody whose club has
  // been suspended should see it, with its state on it, rather than watch it
  // vanish and wonder whether they have lost their account.
  const clubs = Array.from(clubMap.values())
    .filter((c) => platformOwner || c.lifecycle !== 'ARCHIVED');

  // ── which club this context is about ──────────────────────────────────────
  //
  // `User.currentClubId` is set when somebody switches into a club, so it is
  // null for an account that has been invited, has accepted, and has not
  // switched yet — a brand-new staff member on their first sign-in. Reading it
  // alone meant that account got a context with no club: no team scope, and
  // capabilities computed as though they were in no club at all. Their
  // memberships said otherwise the whole time.
  //
  // So, in order: the club they have open; failing that the only club they
  // belong to; failing that their account's own club, when they belong to it —
  // the same `currentClubId ?? clubId` the authentication middleware has always
  // resolved, so one request cannot be scoped to a club the context denies.
  //
  // This GRANTS NOTHING. Every candidate is checked against `clubs`, which is
  // built from active memberships and nothing else, so the resolution can only
  // ever pick a club the memberships already prove. Somebody in several clubs
  // with no home club among them gets null, because choosing between them
  // would be inventing an answer rather than finding one.
  //
  // Nothing is written back: this is what the read returns, and switchContext
  // is what persists a choice.
  const belongsTo = (id: string | null | undefined) => !!id && clubs.some((c) => c.id === id);
  const currentClubId = belongsTo(user.currentClubId) ? user.currentClubId!
    : (clubs.length === 1 ? clubs[0].id
      : (belongsTo(user.clubId) ? user.clubId : null));

  // The strongest membership held in the club currently open, so "CLUB_OWNER
  // plus HEAD_COACH" reads as owner, which is what that person is.
  //
  // Ranked by the table `requireMembership` uses. It used to be ranked by a
  // list written out here, which had drifted: it carried MANAGER, which is not
  // a MembershipRole at all, and was missing the six technical-staff roles
  // added later — so a goalkeeping coach ranked below a device.
  const currentRoles = (currentClubId ? (clubMap.get(currentClubId)?.roles ?? []) : []) as MembershipRole[];
  const currentClubRole = strongestMembershipRole(currentRoles);

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
  const scope = currentClubId
    ? await privateTeamScope({
      userId: user.id, clubId: currentClubId, role: user.role, isPlatformOwner: platformOwner,
    })
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
  const clubWideManage = currentClubId
    ? await hasClubWideManageAuthority({
      userId: user.id, clubId: currentClubId, role: user.role, isPlatformOwner: platformOwner,
    })
    : false;

  // Running the club, as `requireMembership('CLUB_ADMIN')` means it: the same
  // ranking the middleware uses, asked of the same memberships. This is what
  // People & Access, the membership writes and the invitation routes require.
  //
  // Platform authority satisfies it too, because `requireMembership` bypasses
  // on platform authority and a capability that promised less than the route
  // allows is the same drift as one that promises more. It is a CAPABILITY,
  // not an identity: `accountIdentity` and `currentClubRole` below still say
  // that this person administers Familista and holds no role at this club.
  const canManageClub = platformOwner
    || meetsMembershipRank(currentRoles, MembershipRole.CLUB_ADMIN);

  // Working WITH a module and ADMINISTERING it are different questions, and
  // the modules that answer them differently now say so.
  //
  // A head coach hired for the first team scouts players, reads the league his
  // team plays in, and sees who works alongside him. He does not sell the
  // club's players, run its recruitment, or administer the competition. Both
  // halves are mirrored from the guards that actually decide, so a capability
  // cannot promise what a route will refuse:
  //
  //   transfers  · [requireMembership(HEAD_COACH), requireClubWideManage()]
  //   staff      · [requireMembership(CLUB_ADMIN),  requireClubWideManage()]
  //   league     · authorize(SUPER_ADMIN) + assertLeagueAdmin — the league is
  //                owned by no club, so no club administrator administers it.
  const canAdministerTransfers = platformOwner
    || (clubWideManage && meetsMembershipRank(currentRoles, MembershipRole.HEAD_COACH));
  const canAdministerStaff = clubWideManage && canManageClub;

  /**
   * The club's watchlist, on both markets.
   *
   * Marking somebody the club is watching sends nothing out of the club — no
   * bid, no offer, no approach, no money, and nothing the person or his club
   * can see — so `shortlistGuard` asks how senior the membership is and
   * deliberately not whether it is club-wide. This is that same question,
   * asked of the same rank table, so the interface and the server cannot
   * disagree about who may keep the list. SUPER_ADMIN short-circuits here
   * exactly as it does in the guard.
   */
  const canShortlist = platformOwner
    || meetsMembershipRank(currentRoles, MembershipRole.HEAD_COACH);

  // The academy is a workspace, not a label: it opens to somebody assigned to
  // an academy side, or to somebody who runs the club and therefore runs all
  // of them. A first-team coach holds neither.
  const myTeamKinds = memberships
    .filter((m) => m.clubId === currentClubId && m.team)
    .map((m) => m.team!.kind as string);
  const canAccessAcademy = clubWideManage || myTeamKinds.some((k) => isAcademyKind(k));

  const scopedTeams = (!scope.unrestricted && scope.teamIds.length)
    ? await prisma.team.findMany({
      where: { id: { in: scope.teamIds }, clubId: currentClubId! },
      select: { id: true, name: true, shortName: true, kind: true, isActive: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    })
    : [];

  return {
    userId:           user.id,
    legacyClubId:     user.clubId,
    /** User.role — the account-level field. NOT what somebody is in a club. */
    legacyRole:       user.role,
    /**
     * Who this account is to FAMILISTA, which is a different question from what
     * it is at the club it currently has open.
     *
     * Two fields, never one, and never collapsed into each other: a platform
     * owner with no membership is `PLATFORM_OWNER` with a null
     * `currentClubRole`, and the interface says "Account: Platform Owner ·
     * Club role: None" rather than inventing a club role to fill the gap. The
     * club's own president is `CLUB_MEMBER` with `currentClubRole:
     * CLUB_OWNER`, and one person may be both at different clubs without
     * either fact changing the other.
     */
    accountIdentity:  platformOwner ? 'PLATFORM_OWNER' as const : 'CLUB_MEMBER' as const,
    /**
     * The operational state of the club now open, so a screen can say what has
     * happened rather than only fail. PENDING_SETUP, PRESIDENT_INVITED and
     * ACTIVE are ordinary; DEACTIVATED and ARCHIVED mean the platform has
     * suspended it and every record in it has been kept.
     */
    currentClubLifecycle: currentClubId
      ? (clubMap.get(currentClubId)?.lifecycle ?? null) : null,
    /** True when the club now open has been suspended or archived. */
    currentClubSuspended: isSuspendedLifecycle(
      currentClubId ? (clubMap.get(currentClubId)?.lifecycle ?? null) : null,
    ),
    /**
     * True when the club now open is open through platform authority rather
     * than through a membership — so a screen can label it honestly instead of
     * presenting a platform administrator as one of the club's people.
     */
    inClubViaPlatform: platformOwner && currentRoles.length === 0 && !!currentClubId,
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
       * Offer CLUB_OWNER — the club's president — in the invite dialog.
       *
       * Narrower than `canManagePeople` on purpose, and mirrors the rule
       * `createInvitation` enforces: a president is appointed by a sitting
       * president or by Familista onboarding the club, never by an
       * administrator, because the role outranks the person handing it out.
       */
      canAppointPresident: platformOwner || currentRoles.includes(MembershipRole.CLUB_OWNER),
      /**
       * The transfer workspace: scouting, search, shortlists, comparison — the
       * football work of finding a player, which is a coach's job. Reading the
       * market is open to the whole club on the server; this asks the narrower
       * question the sidebar needs, which is whether they work with a team at
       * all.
       */
      canAccessTransfers: scope.unrestricted || scope.teamIds.length > 0,
      /** Listing, selling, bidding, contracts. Club-wide, and mirrored below. */
      canAdministerTransfers,

      /**
       * The coach market. Recruiting staff is the club's decision and every
       * control that commits it — an approach, an interview, an offer, a
       * counter, an acceptance, a published need — is `recruitGuard` on the
       * server and `canAdministerStaff` in the interface.
       *
       * Opening the module is not one of those. A head coach who may keep the
       * club's shortlist has to be able to reach the people he is shortlisting,
       * and reading who is available was never the club's secret. So the module
       * opens for anybody with either authority, and what is inside it is
       * governed one control at a time.
       */
      canAccessCoachMarket: clubWideManage || canShortlist,

      /**
       * Adding to and removing from the club's watchlist, on both markets.
       * Mirrors `shortlistGuard`.
       */
      canShortlist,

      /** Who works alongside them. Scoped to their teams by the directory. */
      canAccessStaffDirectory: scope.unrestricted || scope.teamIds.length > 0,
      /** Hiring, moving between teams, releasing. Club administration. */
      canAdministerStaff,

      /**
       * The competition their team plays in: fixtures, standings, results.
       * Reading a league table is open to every club by design — it is
       * competitive information about all of its participants.
       */
      canAccessLeague: scope.unrestricted || scope.teamIds.length > 0,
      /** Who is in the league, and when they play. The platform's, not a club's. */
      canAdministerLeague: platformOwner,
      /** An academy assignment, or the authority that covers every team. */
      canAccessAcademy,
      /** Any team at all: the football modules need one team to be about. */
      canAccessTeamWorkspace: scope.unrestricted || scope.teamIds.length > 0,
      /** The teams this person may work with. Empty with `unrestricted`. */
      authorizedTeamIds: scope.unrestricted ? [] : scope.teamIds,
    },
    currentClubId,
    currentTeamId:    user.currentTeamId,
    // The club named by `currentClubId` above, which is the resolved one — not
    // necessarily the relation loaded from the raw column. For an account that
    // has never switched, the column is null and the relation with it, while
    // the resolution has found the one club they belong to.
    currentClub:      user.currentClub ?? (() => {
      const c = currentClubId ? clubMap.get(currentClubId) : null;
      // Projected to the same shape the relation has, so one field never
      // arrives in two different forms depending on how it was resolved.
      return c ? {
        id: c.id, name: c.name, shortName: c.shortName,
        emblem: c.emblem, crestUrl: c.crestUrl, plan: c.plan,
      } : null;
    })(),
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

  // Platform authority enters a club AS THE PLATFORM.
  //
  // Requirement, stated plainly: the platform owner must be able to enter and
  // inspect any club without masquerading as its president. Before this, they
  // could not — `hasActiveMembership` was the only door — so the way it had
  // been made to work was a CLUB_OWNER membership of four clubs, which is the
  // thing being unwound. Recognising the authority here is what makes removing
  // those memberships safe rather than a lockout.
  //
  // It GRANTS NO CLUB ROLE. `getContext` reports `currentClubRole: null` and
  // `inClubViaPlatform: true` for such a session, the audit row below records
  // the switch, and every write inside the club is still decided by the guard
  // that owns it.
  const platformOwner = await resolvePlatformAuthority({ userId: actor.userId });

  // The user must have at least one active membership in the target club.
  if (platformOwner) {
    // A club id that names no club is a bad request whoever asks, and platform
    // authority is not a reason to skip checking that the row exists.
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
    if (!club) throw new BadRequestError('Club not found');
  }

  // A club the platform has suspended is not one its own people may enter.
  //
  // The request guard refuses every club-scoped read and write already, so this
  // is not what makes suspension work — it is what makes it legible. Without
  // it somebody switches successfully into a club whose every subsequent
  // request then fails, which reads as a broken platform rather than as a
  // suspended club.
  if (!platformOwner) {
    const lifecycle = await clubLifecycleOf(clubId);
    if (lifecycle && !isOperableLifecycle(lifecycle)) {
      throw new ForbiddenError(lifecycle === 'ARCHIVED'
        ? 'This club has been archived by Familista. Everything in it has been kept.'
        : 'This club has been deactivated by Familista. Everything in it has been kept.');
    }
  }

  const ok = platformOwner || await hasActiveMembership(actor.userId, clubId);
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
    if (!scoped && !platformOwner) {
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
