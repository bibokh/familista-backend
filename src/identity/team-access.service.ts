// Who may control which team, inside one club
// ─────────────────────────────────────────────────────────────────────────────
// A club is not one flat team space. It is a First Team and a set of academy age
// groups, each of which is a team in its own right with its own squad, its own
// training, its own fixtures and its own staff. This file is the ONE place that
// decides what a person may do with a given team, and every screen and every
// route asks it rather than deciding for itself.
//
// The rule, in one paragraph:
//
//   A membership says what it says. A membership with no team (`teamId = null`)
//   is club-wide and reaches every team in that club. A membership scoped to a
//   team reaches that team and no other — so a coach assigned to the First Team
//   does not thereby manage the Under-14s, and a coach assigned to the Under-14s
//   does not thereby manage the Under-17s. Whether the reach is CONTROL or only
//   SIGHT is the membership's role: the coaching and administrative roles
//   manage, everybody else on a team reads. Anyone with an active membership in
//   the club may read the club's shell and its other teams; only an assignment
//   grants control.
//
// Nothing here is advisory. `assertCanManageTeam` throws, and it is called on
// the write path, so a request that never went through the interface — a curl,
// a rewritten URL, a replayed body — is refused by exactly the same rule the
// screen used to hide the button.

import { MembershipRole, TeamKind, UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, NotFoundError } from '../utils/errors';

export type TeamAccessLevel = 'MANAGE' | 'VIEW' | 'NONE';

export interface TeamActor {
  userId: string;
  clubId: string;
  /** The account-level role. Only SUPER_ADMIN means anything here. */
  role?: UserRole | string;
}

export type TeamAccessReason =
  | 'PLATFORM_ADMIN'      // a platform administrator, above any one club
  | 'CLUB_WIDE'           // a membership with no team: the whole club
  | 'TEAM_ASSIGNMENT'     // assigned to this team specifically
  | 'CLUB_MEMBER'         // in the club, but not assigned to this team
  | 'OUTSIDE_CLUB';       // not this person's club at all

export interface TeamAccess {
  teamId: string;
  clubId: string;
  level: TeamAccessLevel;
  canView: boolean;
  /**
   * Whether this person may see the team's PRIVATE operational content — the
   * squad, a player's own record, the lineup, the formation, the tactics, the
   * training week, the match preparation, the analysis.
   *
   * `canView` and `canViewPrivate` are two different questions and the club
   * boundary is not the answer to the second one. Being in the club buys the
   * team's shell: its name, its age group, its crest, who is responsible for
   * it. Working on the team — an assignment to it, or a club-wide role that
   * runs the club's teams — buys what is inside. That is the separation the
   * business rule draws, and every private read goes through it.
   */
  canViewPrivate: boolean;
  canManage: boolean;
  reason: TeamAccessReason;
  /** The roles this person actually holds over this team, for the UI to show. */
  roles: MembershipRole[];
}

/**
 * The membership roles that CONTROL a team: they pick the squad, run the
 * training week, prepare the match and ask for a fixture to be moved.
 *
 * Everything else — an analyst, a scout, a physio, a parent, a player — is on
 * the team without running it, and reads. Adding a role to the platform adds it
 * here or it reads by default, which is the safe direction for a list to fail in.
 */
export const TEAM_MANAGING_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  MembershipRole.CLUB_OWNER,
  MembershipRole.CLUB_ADMIN,
  MembershipRole.HEAD_COACH,
  MembershipRole.ASSISTANT_COACH,
  MembershipRole.GOALKEEPING_COACH,
  MembershipRole.FITNESS_COACH,
  MembershipRole.TECHNICAL_COACH,
  MembershipRole.TACTICAL_COACH,
  MembershipRole.YOUTH_COACH,
  MembershipRole.PERFORMANCE_COACH,
]);

/**
 * The membership roles that are NOT club staff: the people a club carries on
 * its books without their working on any of its teams.
 *
 * A parent, a player and a device are in the club — they sign in, they see the
 * club's shell, they belong to it — and none of them thereby works on a team.
 * Everything else a club grants a person is staff of some kind: a coach, an
 * analyst, a scout, a physio, a finance manager. So a club-wide membership in
 * one of THOSE reaches the club's teams, and a club-wide membership in one of
 * these does not.
 *
 * Stated as an exclusion list on purpose: a role added to the platform is staff
 * by default, which is the direction that fails loudly (somebody sees a screen
 * they should not, and it is fixed) rather than silently (a coach is locked out
 * of their own team and nobody knows why).
 */
export const ORDINARY_MEMBER_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  MembershipRole.PARENT,
  MembershipRole.PLAYER,
  MembershipRole.DEVICE,
]);

export function isClubStaffRole(role: MembershipRole): boolean {
  return !ORDINARY_MEMBER_ROLES.has(role);
}

/** The kinds of team that are academy age groups rather than the first team. */
export function isAcademyKind(kind: TeamKind | string): boolean {
  return String(kind).startsWith('ACADEMY_');
}

interface MembershipRow { teamId: string | null; role: MembershipRole }

/**
 * Every active membership this person holds in this club. One query, and the
 * only read the decision needs.
 */
async function membershipsOf(actor: TeamActor): Promise<MembershipRow[]> {
  if (!actor.userId || !actor.clubId) return [];
  return prisma.membership.findMany({
    where: { userId: actor.userId, clubId: actor.clubId, isActive: true },
    select: { teamId: true, role: true },
  });
}

function levelFrom(rows: MembershipRow[]): { level: TeamAccessLevel; roles: MembershipRole[] } {
  if (!rows.length) return { level: 'NONE', roles: [] };
  const roles = rows.map((r) => r.role);
  const manages = roles.some((r) => TEAM_MANAGING_ROLES.has(r));
  return { level: manages ? 'MANAGE' : 'VIEW', roles };
}

function pack(teamId: string, clubId: string, level: TeamAccessLevel, reason: TeamAccessReason, roles: MembershipRole[]): TeamAccess {
  return {
    teamId,
    clubId,
    level,
    // Anyone in the club may look; only an assignment may act. That is the
    // difference the brief draws between club-wide visibility and team control,
    // and it is drawn here once rather than in every screen.
    canView: level !== 'NONE',
    // Derived rather than passed, so the two can never be set inconsistently
    // by a caller. Private sight comes from exactly two places: running the
    // team (a platform administrator, or a club-wide managing membership), or
    // being ON it (an assignment to this team, whatever the role). A club-wide
    // membership that does not manage — a parent, a player, an ordinary
    // member — is in the club and not on this team, and reads the shell only.
    canViewPrivate:
      level === 'MANAGE'
      || reason === 'TEAM_ASSIGNMENT'
      || (reason === 'CLUB_WIDE' && roles.some(isClubStaffRole)),
    canManage: level === 'MANAGE',
    reason,
    roles,
  };
}

/**
 * What this person may do with one team.
 *
 * Resolved from the team's own row, so a team id from another club is refused
 * on the club boundary before team scoping is even considered.
 */
export async function accessForTeam(actor: TeamActor, teamId: string): Promise<TeamAccess> {
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, clubId: true } });
  if (!team) throw new NotFoundError('Team');

  if (actor.role === 'SUPER_ADMIN') {
    return pack(team.id, team.clubId, 'MANAGE', 'PLATFORM_ADMIN', []);
  }
  if (team.clubId !== actor.clubId) {
    return pack(team.id, team.clubId, 'NONE', 'OUTSIDE_CLUB', []);
  }

  const rows = await membershipsOf(actor);
  if (!rows.length) return pack(team.id, team.clubId, 'NONE', 'CLUB_MEMBER', []);

  // A club-wide membership reaches every team, including this one.
  const clubWide = rows.filter((r) => !r.teamId);
  if (clubWide.length) {
    const { level, roles } = levelFrom(clubWide);
    // A club-wide reader still only reads; a club-wide manager manages.
    if (level === 'MANAGE') return pack(team.id, team.clubId, 'MANAGE', 'CLUB_WIDE', roles);
  }

  const onThisTeam = rows.filter((r) => r.teamId === teamId);
  if (onThisTeam.length) {
    const { level, roles } = levelFrom(onThisTeam);
    return pack(team.id, team.clubId, level, 'TEAM_ASSIGNMENT', roles);
  }

  // In the club, assigned elsewhere or nowhere: the club's shell and this
  // team's board are readable, and nothing about it is editable.
  return pack(team.id, team.clubId, 'VIEW', clubWide.length ? 'CLUB_WIDE' : 'CLUB_MEMBER',
    clubWide.map((r) => r.role));
}

export interface TeamContext {
  teamId: string;
  name: string;
  shortName: string | null;
  kind: TeamKind;
  isAcademy: boolean;
  isActive: boolean;
  playerCount: number;
  access: TeamAccess;
}

/**
 * Every team in the club, with what this person may do with each.
 *
 * This is what a workspace picker reads: it must show the teams that exist
 * — a locked card is information — and say which of them this person runs.
 */
export async function listTeamContexts(actor: TeamActor): Promise<TeamContext[]> {
  if (!actor.clubId) return [];
  const [teams, rows, counts] = await Promise.all([
    prisma.team.findMany({
      where: { clubId: actor.clubId },
      select: { id: true, name: true, shortName: true, kind: true, isActive: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    }),
    actor.role === 'SUPER_ADMIN' ? Promise.resolve([] as MembershipRow[]) : membershipsOf(actor),
    prisma.player.groupBy({ by: ['teamId'], where: { clubId: actor.clubId }, _count: { _all: true } }),
  ]);

  const countOf = new Map<string, number>();
  for (const c of counts) if (c.teamId) countOf.set(c.teamId, c._count._all);

  const clubWide = rows.filter((r) => !r.teamId);
  const clubWideManage = clubWide.some((r) => TEAM_MANAGING_ROLES.has(r.role));

  return teams.map((t) => {
    let access: TeamAccess;
    if (actor.role === 'SUPER_ADMIN') {
      access = pack(t.id, actor.clubId, 'MANAGE', 'PLATFORM_ADMIN', []);
    } else if (clubWideManage) {
      access = pack(t.id, actor.clubId, 'MANAGE', 'CLUB_WIDE', clubWide.map((r) => r.role));
    } else {
      const mine = rows.filter((r) => r.teamId === t.id);
      if (mine.length) {
        const { level, roles } = levelFrom(mine);
        access = pack(t.id, actor.clubId, level, 'TEAM_ASSIGNMENT', roles);
      } else if (rows.length) {
        access = pack(t.id, actor.clubId, 'VIEW', clubWide.length ? 'CLUB_WIDE' : 'CLUB_MEMBER',
          clubWide.map((r) => r.role));
      } else {
        access = pack(t.id, actor.clubId, 'NONE', 'CLUB_MEMBER', []);
      }
    }
    return {
      teamId: t.id,
      name: t.name,
      shortName: t.shortName,
      kind: t.kind,
      isAcademy: isAcademyKind(t.kind),
      isActive: t.isActive,
      playerCount: countOf.get(t.id) ?? 0,
      access,
    };
  });
}

/** The team ids this person may read, for scoping a query rather than a screen. */
export async function viewableTeamIds(actor: TeamActor, opts: { kinds?: TeamKind[] } = {}): Promise<string[]> {
  const contexts = await listTeamContexts(actor);
  return contexts
    .filter((c) => c.access.canView)
    .filter((c) => !opts.kinds || opts.kinds.includes(c.kind))
    .map((c) => c.teamId);
}

export async function assertCanViewTeam(actor: TeamActor, teamId: string): Promise<TeamAccess> {
  const access = await accessForTeam(actor, teamId);
  if (!access.canView) throw new ForbiddenError('You do not have access to that team');
  return access;
}

/**
 * The private-read gate.
 *
 * Everything a team keeps to itself goes through this: the squad, a player's
 * record, the lineup, the formation, the tactics, the training week, the match
 * preparation and its analysis, the video, the private analytics, the medical
 * availability. Being in the same club is not enough — an assignment is.
 */
export async function assertCanViewTeamPrivate(actor: TeamActor, teamId: string): Promise<TeamAccess> {
  const access = await accessForTeam(actor, teamId);
  if (!access.canViewPrivate) {
    throw new ForbiddenError('You are not assigned to manage this team');
  }
  return access;
}

/**
 * The teams whose private content this person may read, as a query scope.
 *
 * `unrestricted` is not a convenience: it is the legacy path, and it must stay.
 * A platform administrator, and an account that has never been given a
 * membership at all, are club-wide — narrowing those would be a migration that
 * locks existing users out of their own club rather than a boundary that
 * protects anybody. Only an ACTUAL assignment narrows, which is the same
 * decision `tenant-guard` makes about the same question.
 */
export interface PrivateTeamScope {
  unrestricted: boolean;
  teamIds: string[];
}

export async function privateTeamScope(actor: TeamActor): Promise<PrivateTeamScope> {
  if (actor.role === 'SUPER_ADMIN') return { unrestricted: true, teamIds: [] };
  if (!actor.userId || !actor.clubId) return { unrestricted: false, teamIds: [] };

  const rows = await membershipsOf(actor);
  // Never assigned to anything: club-wide, as it has always been.
  if (!rows.length) return { unrestricted: true, teamIds: [] };
  // A club-wide staff membership works across the club's teams; a club-wide
  // parent or player is in the club without working on any of them.
  const clubWide = rows.filter((r) => !r.teamId);
  if (clubWide.some((r) => isClubStaffRole(r.role))) return { unrestricted: true, teamIds: [] };

  const teamIds = [...new Set(rows.filter((r) => r.teamId).map((r) => r.teamId as string))];
  return { unrestricted: false, teamIds };
}

/**
 * Whether this person works on ANY team of the club.
 *
 * The gate for a module that is private to the club's teams but which the
 * schema keeps against the club rather than against one team — the training
 * calendar is the case today. It refuses the ordinary club member, which is
 * the boundary that exists to be drawn, and it does not pretend to a per-team
 * separation the data cannot express.
 */
export async function hasAnyTeamPrivateAccess(actor: TeamActor): Promise<boolean> {
  const scope = await privateTeamScope(actor);
  return scope.unrestricted || scope.teamIds.length > 0;
}

export async function assertAnyTeamPrivateAccess(actor: TeamActor): Promise<void> {
  if (!(await hasAnyTeamPrivateAccess(actor))) {
    throw new ForbiddenError('You are not assigned to a team in this club');
  }
}

/**
 * The write gate. Called on every path that changes a team's data, so an action
 * sent from the wrong team context is refused by the server whatever the
 * interface did or did not show.
 */
export async function assertCanManageTeam(actor: TeamActor, teamId: string): Promise<TeamAccess> {
  const access = await accessForTeam(actor, teamId);
  if (!access.canManage) {
    throw new ForbiddenError('You are not assigned to manage that team');
  }
  return access;
}
