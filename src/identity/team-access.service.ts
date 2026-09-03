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
