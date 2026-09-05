// SYSTEM — what the platform can honestly say about itself
// ─────────────────────────────────────────────────────────────────────────────
// Every number here is counted from a real table in this process. Where nothing
// measures a thing yet, the answer is `null` with a reason, never a plausible
// figure. A platform dashboard that invents a number is worse than a blank one,
// because somebody will make a decision on it.
//
// Reading any of this takes platform authority. That is checked at the route,
// and again here, because the two are not the same wall.

import { prisma } from '../config/database';
import { ForbiddenError } from '../utils/errors';
import { isPlatformOwner, type PlatformActor } from './access-levels';
import { SYSTEM_MODULES, type SystemModule } from './system-modules';

export interface Metric {
  /** The measured value, or null when nothing measures it yet. */
  value: number | null;
  /** Present exactly when value is null. Rendered as the empty state. */
  unavailable?: string;
}

const measured = (value: number): Metric => ({ value });
const notInstrumented = (why: string): Metric => ({ value: null, unavailable: why });

export interface PlatformOverview {
  generatedAt: string;
  clubs: { total: Metric; active: Metric };
  teams: { total: Metric; firstTeams: Metric; academy: Metric };
  people: { users: Metric; activeUsers: Metric; owners: Metric; staff: Metric; viewers: Metric };
  players: { total: Metric };
  access: { activeMemberships: Metric; pendingInvitations: Metric; clubsWithoutOwner: Metric };
  activity: { activeToday: Metric; activeThisWeek: Metric; sessionsToday: Metric; topModules: Metric };
  modules: ReadonlyArray<SystemModule>;
}

export async function assertPlatformOwner(actor: PlatformActor): Promise<void> {
  if (!(await isPlatformOwner(actor))) {
    throw new ForbiddenError('SYSTEM is the platform owner\'s. A club membership does not reach it.');
  }
}

/**
 * The Platform Command Center, counted.
 *
 * "Active club" is a club with at least one active membership — a definition
 * stated here rather than assumed, because every dashboard that shows an
 * "active" count without saying what it means eventually shows two different
 * ones.
 */
export async function platformOverview(actor: PlatformActor): Promise<PlatformOverview> {
  await assertPlatformOwner(actor);

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    clubs, teams, firstTeams, academyTeams, users, activeUsers, players,
    activeMemberships, ownerMemberships, staffMemberships, pendingInvites,
    clubsWithOwner, loggedInDay, loggedInWeek,
  ] = await Promise.all([
    prisma.club.count(),
    prisma.team.count(),
    prisma.team.count({ where: { kind: 'SENIOR' } }),
    prisma.team.count({ where: { kind: { in: ['ACADEMY_U23', 'ACADEMY_U21', 'ACADEMY_U19', 'ACADEMY_U17', 'ACADEMY_U15', 'ACADEMY_U13', 'ACADEMY_U11', 'ACADEMY_U9', 'ACADEMY_U7'] } } }),
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.player.count({ where: { isActive: true } }),
    prisma.membership.count({ where: { isActive: true } }),
    prisma.membership.count({ where: { isActive: true, role: 'CLUB_OWNER' } }),
    prisma.membership.count({ where: { isActive: true, role: { not: 'CLUB_OWNER' } } }),
    prisma.clubInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: new Date() } } }),
    prisma.membership.findMany({ where: { isActive: true, role: 'CLUB_OWNER' }, select: { clubId: true }, distinct: ['clubId'] }),
    prisma.user.count({ where: { lastLoginAt: { gte: dayAgo } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: weekAgo } } }),
  ]);

  // A person with an account and no active membership anywhere is a viewer;
  // a club with at least one active membership is an active club. Both are
  // counted from the same table, once each.
  const [withMembership, activeClubRows] = await Promise.all([
    prisma.membership.findMany({ where: { isActive: true }, select: { userId: true }, distinct: ['userId'] }),
    prisma.membership.findMany({ where: { isActive: true }, select: { clubId: true }, distinct: ['clubId'] }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    clubs: { total: measured(clubs), active: measured(activeClubRows.length) },
    teams: { total: measured(teams), firstTeams: measured(firstTeams), academy: measured(academyTeams) },
    people: {
      users: measured(users),
      activeUsers: measured(activeUsers),
      owners: measured(ownerMemberships),
      staff: measured(staffMemberships),
      viewers: measured(Math.max(0, activeUsers - withMembership.length)),
    },
    players: { total: measured(players) },
    access: {
      activeMemberships: measured(activeMemberships),
      pendingInvitations: measured(pendingInvites),
      clubsWithoutOwner: measured(Math.max(0, clubs - clubsWithOwner.length)),
    },
    activity: {
      // lastLoginAt is a real column, so these are real — but they count
      // sign-ins, not sessions, and the field says so.
      activeToday: measured(loggedInDay),
      activeThisWeek: measured(loggedInWeek),
      sessionsToday: notInstrumented('No session analytics are collected yet — see Phase 3, analytics events.'),
      topModules: notInstrumented('No feature-usage events are collected yet — see Phase 3, product analytics.'),
    },
    modules: SYSTEM_MODULES,
  };
}

export interface ClubRow {
  id: string;
  name: string;
  teams: number;
  players: number;
  activeMemberships: number;
  hasOwner: boolean;
  createdAt: Date;
}

/** Every club on the platform, with what the platform can count about it. */
export async function listClubs(actor: PlatformActor, opts: { limit?: number } = {}): Promise<ClubRow[]> {
  await assertPlatformOwner(actor);
  const clubs = await prisma.club.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { name: 'asc' },
    take: Math.min(opts.limit ?? 200, 500),
  });
  if (!clubs.length) return [];

  const ids = clubs.map((c) => c.id);
  const [teams, players, memberships, owners] = await Promise.all([
    prisma.team.groupBy({ by: ['clubId'], where: { clubId: { in: ids } }, _count: { _all: true } }),
    prisma.player.groupBy({ by: ['clubId'], where: { clubId: { in: ids }, isActive: true }, _count: { _all: true } }),
    prisma.membership.groupBy({ by: ['clubId'], where: { clubId: { in: ids }, isActive: true }, _count: { _all: true } }),
    prisma.membership.findMany({
      where: { clubId: { in: ids }, isActive: true, role: 'CLUB_OWNER' },
      select: { clubId: true }, distinct: ['clubId'],
    }),
  ]);

  const countOf = (rows: Array<{ clubId: string; _count: { _all: number } }>, id: string) =>
    rows.find((r) => r.clubId === id)?._count._all ?? 0;
  const owned = new Set(owners.map((o) => o.clubId));

  return clubs.map((c) => ({
    id: c.id,
    name: c.name,
    teams: countOf(teams, c.id),
    players: countOf(players, c.id),
    activeMemberships: countOf(memberships, c.id),
    hasOwner: owned.has(c.id),
    createdAt: c.createdAt,
  }));
}

export interface PersonRow {
  id: string;
  email: string;
  name: string;
  accountRole: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  memberships: Array<{ clubId: string; teamId: string | null; role: string; status: string }>;
  /** No membership anywhere: a viewer, not a staff member. */
  isViewer: boolean;
}

/**
 * People & Access, across the platform.
 *
 * The one place the platform sees a person as a person — their identity and
 * every club they work for — rather than as a row inside one club. No password
 * hash, no token, no reset material is selected: those columns are not in this
 * query and must never be added to it.
 */
export async function listPeople(
  actor: PlatformActor,
  opts: { search?: string; clubId?: string; limit?: number } = {},
): Promise<PersonRow[]> {
  await assertPlatformOwner(actor);
  const search = (opts.search ?? '').trim();

  const users = await prisma.user.findMany({
    where: {
      ...(search ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' } },
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
      ...(opts.clubId ? { memberships: { some: { clubId: opts.clubId, isActive: true } } } : {}),
    },
    select: {
      id: true, email: true, firstName: true, lastName: true, role: true,
      isActive: true, lastLoginAt: true,
      memberships: {
        where: { isActive: true },
        select: { clubId: true, teamId: true, role: true, status: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 500),
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: `${u.firstName} ${u.lastName}`.trim(),
    accountRole: String(u.role),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    memberships: u.memberships.map((m) => ({
      clubId: m.clubId, teamId: m.teamId, role: String(m.role), status: String(m.status),
    })),
    isViewer: u.memberships.length === 0,
  }));
}
