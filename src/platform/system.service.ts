// SYSTEM — what the platform can honestly say about itself
// ─────────────────────────────────────────────────────────────────────────────
// Every number here is counted from a real table in this process. Where nothing
// measures a thing yet, the answer is `null` with a reason, never a plausible
// figure. A platform dashboard that invents a number is worse than a blank one,
// because somebody will make a decision on it.
//
// Reading any of this takes platform authority. That is checked at the route,
// and again here, because the two are not the same wall.

import { TeamKind } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError } from '../utils/errors';
import { isPlatformOwner, type PlatformActor } from './access-levels';
import { SYSTEM_MODULES, type SystemModule } from './system-modules';
import { CAPABILITIES, capabilitySummary, type Capability } from './capabilities';
import { listFlags, type FlagRule } from './innovation/flags';
import { listExperiments, type ExperimentRecord } from './innovation/experiments';
import { killSwitchEngaged, killSwitchReason, TOOLS } from './intelligence/agents';
import { listModels } from './intelligence/gateway';
import { currentEnvironment } from './environment';
import { decide, listPacks, type PolicyRequest } from './governance/policy';
import { RESOURCE_CLASSIFICATION } from './data-classification';
import { analyticsStore } from './analytics/store';

/**
 * Where a number came from, said on the number itself.
 *
 *   LIVE             one aggregate over one table. COUNT(User), and nothing else.
 *   DERIVED          a real count under a definition somebody chose — "a club
 *                    with at least one active membership" is a decision, not a
 *                    column, so the decision travels with the figure.
 *   NOT_INSTRUMENTED nothing measures it. The value is null and stays null.
 *
 * The classification is not decoration. An operator reading "Active Today"
 * needs to know it counts sign-ins rather than sessions before they act on it,
 * and the only reliable place to say so is next to the number.
 */
export type MetricSource = 'LIVE' | 'DERIVED' | 'NOT_INSTRUMENTED';

export interface Metric {
  /** The measured value, or null when nothing measures it yet. */
  value: number | null;
  source: MetricSource;
  /** The definition, in one line. Always present. */
  how: string;
  /** Present exactly when value is null. Rendered as the empty state. */
  unavailable?: string;
}

const live = (value: number, how: string): Metric => ({ value, source: 'LIVE', how });
const derived = (value: number, how: string): Metric => ({ value, source: 'DERIVED', how });
const notInstrumented = (why: string): Metric => ({ value: null, source: 'NOT_INSTRUMENTED', how: why, unavailable: why });

export interface PlatformOverview {
  generatedAt: string;
  environment: string;
  clubs: { total: Metric; active: Metric; withoutOwner: Metric };
  teams: { total: Metric; firstTeams: Metric; academy: Metric };
  people: {
    users: Metric; activeUsers: Metric; owners: Metric; staff: Metric;
    viewers: Metric; platformAdmins: Metric;
  };
  players: { total: Metric };
  access: {
    activeMemberships: Metric; suspendedMemberships: Metric;
    pendingInvitations: Metric; expiringInvitations: Metric; clubsWithoutOwner: Metric;
  };
  governance: { pendingApprovals: Metric };
  security: { alertsToday: Metric; alertsThisWeek: Metric };
  intelligence: { agents: Metric; jobsPending: Metric; jobsFailed: Metric };
  innovation: { flags: Metric; flagsOn: Metric; experiments: Metric; experimentsRunning: Metric };
  activity: {
    activeToday: Metric; signedInToday: Metric; activeThisWeek: Metric;
    sessionsToday: Metric; topModules: Metric;
  };
  /** The most-opened modules today, from product analytics. Empty until there is data. */
  topModules: Array<{ module: string; opens: number; uniqueUsers: number }>;
  modules: ReadonlyArray<SystemModule>;
}

export async function assertPlatformOwner(actor: PlatformActor): Promise<void> {
  if (!(await isPlatformOwner(actor))) {
    throw new ForbiddenError('SYSTEM is the platform owner\'s. A club membership does not reach it.');
  }
}

/** The academy age bands, as the schema declares them. */
const ACADEMY_TEAM_KINDS: TeamKind[] = [
  'ACADEMY_U23', 'ACADEMY_U21', 'ACADEMY_U19', 'ACADEMY_U17',
  'ACADEMY_U15', 'ACADEMY_U13', 'ACADEMY_U11', 'ACADEMY_U9', 'ACADEMY_U7',
];

/**
 * A count that may not be available in this deployment.
 *
 * Some tables arrived later than some databases. A count that cannot be taken
 * answers null, which the caller turns into "not instrumented" — never into a
 * zero, which would read as "nothing is wrong".
 */
async function countOrNull(run: () => Promise<number>): Promise<number | null> {
  try { return await run(); } catch { return null; }
}

async function agentJobCounts(): Promise<{ pending: number; running: number; failed: number; succeeded: number } | null> {
  try {
    const [pending, running, failed, succeeded] = await Promise.all([
      prisma.aIAgentJob.count({ where: { status: 'PENDING' } }),
      prisma.aIAgentJob.count({ where: { status: 'RUNNING' } }),
      prisma.aIAgentJob.count({ where: { status: 'FAILED' } }),
      prisma.aIAgentJob.count({ where: { status: 'SUCCESS' } }),
    ]);
    return { pending, running, failed, succeeded };
  } catch { return null; }
}


/**
 * What product analytics can say about right now.
 *
 * Every read is an aggregate. A deployment with no analytics rows yet gets
 * nulls, and the caller turns those into "collecting data" rather than into a
 * zero — a dashboard that shows 0 active users when it means "nothing is
 * measuring yet" is the exact lie this whole surface avoids.
 */
async function analyticsSnapshot(now: Date): Promise<{
  activeToday: Metric | null;
  activeThisWeek: Metric | null;
  sessionsToday: Metric;
  topModules: Metric;
  topModuleRows: Array<{ module: string; opens: number; uniqueUsers: number }>;
}> {
  const collecting = 'Product analytics are instrumented, and no events have been recorded in this environment yet.';
  try {
    const store = analyticsStore();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = new Date(now.getTime() + 1000);
    const today = { environment: 'PRODUCTION' as const, from: startOfDay, to };
    const week = { environment: 'PRODUCTION' as const, from: new Date(startOfDay.getTime() - 6 * 86400000), to };

    const [earliest, active, activeWeek, sessions, modules] = await Promise.all([
      store.earliestEvent('PRODUCTION'),
      store.uniqueUsers(today),
      store.uniqueUsers(week),
      store.sessionStats(today),
      store.byDimension(today, 'module', 8),
    ]);

    if (!earliest) {
      return {
        activeToday: null, activeThisWeek: null,
        sessionsToday: notInstrumented(collecting),
        topModules: notInstrumented(collecting),
        topModuleRows: [],
      };
    }

    return {
      activeToday: derived(active, 'Distinct authenticated users with at least one production analytics event today (UTC)'),
      activeThisWeek: derived(activeWeek, 'Distinct authenticated users with a production analytics event in the last 7 days'),
      sessionsToday: live(sessions.sessions, 'COUNT(AnalyticsSession) started today (UTC), in PRODUCTION'),
      topModules: derived(modules.length, 'Distinct modules opened today (UTC), in PRODUCTION'),
      topModuleRows: modules.map((m) => ({ module: m.dimension, opens: m.events, uniqueUsers: m.uniqueUsers })),
    };
  } catch {
    const why = 'Analytics tables are not readable in this deployment.';
    return {
      activeToday: null, activeThisWeek: null,
      sessionsToday: notInstrumented(why), topModules: notInstrumented(why), topModuleRows: [],
    };
  }
}

/**
 * The Platform Command Center, counted.
 *
 * "Active club" is a club with at least one active membership — a definition
 * stated here rather than assumed, because every dashboard that shows an
 * "active" count without saying what it means eventually shows two different
 * ones. Every figure carries its definition for the same reason.
 */
export async function platformOverview(actor: PlatformActor): Promise<PlatformOverview> {
  await assertPlatformOwner(actor);

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  // Every entry below is an aggregate. Nothing here reads a row it does not
  // count — `count` with a relation filter compiles to EXISTS, so "clubs with
  // no active owner" is one query over an index rather than a table scan and a
  // set difference in JavaScript. That is what makes this page survive
  // thousands of clubs and hundreds of thousands of memberships.
  const [
    clubs, activeClubs, clubsWithoutOwner,
    teams, firstTeams, academyTeams,
    users, activeUsers, viewers, platformAdmins,
    players,
    activeMemberships, ownerMemberships, staffMemberships, suspendedMemberships,
    pendingInvites, expiringInvites,
    pendingApprovals,
    alertsToday, alertsWeek,
    loggedInDay, loggedInWeek,
  ] = await Promise.all([
    prisma.club.count(),
    prisma.club.count({ where: { memberships: { some: { isActive: true } } } }),
    prisma.club.count({ where: { memberships: { none: { isActive: true, role: 'CLUB_OWNER' } } } }),

    prisma.team.count(),
    prisma.team.count({ where: { kind: 'SENIOR' } }),
    prisma.team.count({ where: { kind: { in: ACADEMY_TEAM_KINDS } } }),

    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.user.count({ where: { isActive: true, memberships: { none: { isActive: true } } } }),
    prisma.platformAdmin.count({ where: { isActive: true } }),

    prisma.player.count({ where: { isActive: true } }),

    prisma.membership.count({ where: { isActive: true } }),
    prisma.membership.count({ where: { isActive: true, role: 'CLUB_OWNER' } }),
    prisma.membership.count({ where: { isActive: true, role: { not: 'CLUB_OWNER' } } }),
    prisma.membership.count({ where: { status: 'SUSPENDED' } }),

    prisma.clubInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: now } } }),
    prisma.clubInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: now, lt: soon } } }),

    countOrNull(() => prisma.aIApprovalRequest.count({ where: { status: 'PENDING', expiresAt: { gt: now } } })),

    countOrNull(() => prisma.securityEvent.count({ where: { createdAt: { gte: dayAgo }, severity: { in: ['WARN', 'CRITICAL'] } } })),
    countOrNull(() => prisma.securityEvent.count({ where: { createdAt: { gte: weekAgo }, severity: { in: ['WARN', 'CRITICAL'] } } })),

    prisma.user.count({ where: { lastLoginAt: { gte: dayAgo } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: weekAgo } } }),
  ]);

  // Product analytics, if any has been recorded. Every figure is an aggregate
  // over the analytics tables; a deployment that has recorded nothing yet gets
  // nulls and says "collecting", never a zero dressed as a measurement.
  const usage = await analyticsSnapshot(now);

  // Agent jobs are optional history: a deployment that has never run one has
  // the table and no rows, and a deployment whose client predates it has
  // neither. Both answer "not instrumented" rather than zero.
  const jobs = await agentJobCounts();

  // Flags and experiments live in this process, not in a table. That is a real
  // reading of a real registry — it is what the running API will actually do —
  // and it is DERIVED rather than LIVE because it describes this instance.
  const flags = listFlags();
  const experiments = listExperiments();
  const env = currentEnvironment();

  return {
    generatedAt: now.toISOString(),
    environment: env,
    clubs: {
      total: live(clubs, 'COUNT(Club)'),
      active: derived(activeClubs, 'Clubs with at least one active membership'),
      withoutOwner: derived(clubsWithoutOwner, 'Clubs with no active CLUB_OWNER membership'),
    },
    teams: {
      total: live(teams, 'COUNT(Team)'),
      firstTeams: live(firstTeams, "COUNT(Team) where kind = 'SENIOR'"),
      academy: derived(academyTeams, 'COUNT(Team) across the academy age bands'),
    },
    people: {
      users: live(users, 'COUNT(User)'),
      activeUsers: live(activeUsers, 'COUNT(User) where isActive'),
      owners: derived(ownerMemberships, "Active memberships with role CLUB_OWNER"),
      staff: derived(staffMemberships, 'Active memberships with any other role'),
      viewers: derived(viewers, 'Active accounts with no active membership anywhere'),
      platformAdmins: live(platformAdmins, 'COUNT(PlatformAdmin) where isActive'),
    },
    players: { total: live(players, 'COUNT(Player) where isActive') },
    access: {
      activeMemberships: live(activeMemberships, 'COUNT(Membership) where isActive'),
      suspendedMemberships: live(suspendedMemberships, "COUNT(Membership) where status = 'SUSPENDED'"),
      pendingInvitations: live(pendingInvites, 'Invitations still PENDING and not expired'),
      expiringInvitations: derived(expiringInvites, 'Pending invitations lapsing within 48 hours'),
      clubsWithoutOwner: derived(clubsWithoutOwner, 'Clubs with no active CLUB_OWNER membership'),
    },
    governance: {
      pendingApprovals: pendingApprovals == null
        ? notInstrumented('Approval requests are not readable in this deployment.')
        : live(pendingApprovals, 'AI approval requests PENDING and unexpired'),
    },
    security: {
      alertsToday: alertsToday == null
        ? notInstrumented('Security events are not readable in this deployment.')
        : derived(alertsToday, 'Security events of severity WARN or CRITICAL, last 24 hours'),
      alertsThisWeek: alertsWeek == null
        ? notInstrumented('Security events are not readable in this deployment.')
        : derived(alertsWeek, 'Security events of severity WARN or CRITICAL, last 7 days'),
    },
    intelligence: {
      agents: derived(TOOLS.length, 'Tools registered in the agent tool registry of this instance'),
      jobsPending: jobs ? live(jobs.pending, "COUNT(AIAgentJob) where status = 'PENDING'") : notInstrumented('Agent job history is not readable in this deployment.'),
      jobsFailed: jobs ? live(jobs.failed, "COUNT(AIAgentJob) where status = 'FAILED'") : notInstrumented('Agent job history is not readable in this deployment.'),
    },
    innovation: {
      flags: derived(flags.length, 'Feature flags defined in this instance'),
      flagsOn: derived(
        flags.filter((f) => f.enabled && (!f.environments || f.environments.includes(env))).length,
        `Flags enabled and reaching ${env}`,
      ),
      experiments: derived(experiments.length, 'Experiments registered in this instance'),
      experimentsRunning: derived(
        experiments.filter((e) => e.status === 'RUNNING').length,
        'Experiments in the RUNNING state',
      ),
    },
    activity: {
      // lastLoginAt is a real column, so these are real — but they count
      // sign-ins, not sessions, and the definition says exactly that.
      // Two different questions, both answered, never conflated. Sign-ins say
      // who authenticated; active users say who actually did something. The
      // analytics-backed figure is the one that means "used Familista today".
      activeToday: usage.activeToday ?? derived(loggedInDay, 'Accounts whose lastLoginAt is within 24 hours — sign-ins, not live sessions'),
      signedInToday: derived(loggedInDay, 'Accounts whose lastLoginAt is within 24 hours — sign-ins, not live sessions'),
      activeThisWeek: usage.activeThisWeek ?? derived(loggedInWeek, 'Accounts whose lastLoginAt is within 7 days'),
      sessionsToday: usage.sessionsToday,
      topModules: usage.topModules,
    },
    modules: SYSTEM_MODULES,
    topModules: usage.topModuleRows,
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
  /** PENDING_SETUP | PRESIDENT_INVITED | ACTIVE — see Club.lifecycle. */
  lifecycle: string;
  activatedAt: Date | null;
  /** The address a president invitation is outstanding for, when one is. */
  pendingPresidentEmail: string | null;
}

/** Every club on the platform, with what the platform can count about it. */
export async function listClubs(actor: PlatformActor, opts: { limit?: number } = {}): Promise<ClubRow[]> {
  await assertPlatformOwner(actor);
  const clubs = await prisma.club.findMany({
    select: { id: true, name: true, createdAt: true, lifecycle: true, activatedAt: true },
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

  // The address a club is still waiting on, so the list can say who rather
  // than only that somebody is pending.
  const pendingInvites = await prisma.clubInvitation.findMany({
    where: { clubId: { in: ids }, role: 'CLUB_OWNER', status: 'PENDING', expiresAt: { gt: new Date() } },
    select: { clubId: true, email: true },
    orderBy: { createdAt: 'desc' },
  });
  const pendingByClub = new Map<string, string>();
  for (const inv of pendingInvites) if (!pendingByClub.has(inv.clubId)) pendingByClub.set(inv.clubId, inv.email);

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
    lifecycle: String(c.lifecycle),
    activatedAt: c.activatedAt,
    pendingPresidentEmail: pendingByClub.get(c.id) ?? null,
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


// ─────────────────────────────────────────────────────────────────────────────
// The command centre
// ─────────────────────────────────────────────────────────────────────────────

export interface Signal {
  id: string;
  severity: 'INFO' | 'ATTENTION' | 'WARNING';
  title: string;
  detail: string;
  /** The SYSTEM module that can act on it. */
  module: string;
  /** How many rows the signal is about, when it is a count. */
  count?: number;
  /**
   * What the reader does about it, in two words.
   *
   * Every signal has one. A feed of things that need attention with no way to
   * attend to any of them is a worry list, not a control surface — so a signal
   * that cannot name an action is not raised at all.
   */
  action: string;
}

/**
 * "What is happening now?" — derived from rows, never invented.
 *
 * Every signal here is something the platform can actually see today: a club
 * with no owner, invitations about to lapse, the kill switch being engaged. A
 * signal that would need instrumentation Familista does not have is not shown
 * as a quiet zero — it is absent, and the module it would belong to says it is
 * not instrumented.
 */
export async function platformSignals(actor: PlatformActor): Promise<Signal[]> {
  await assertPlatformOwner(actor);
  const signals: Signal[] = [];
  const now = new Date();
  const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    ownerless, expiring, pending, expired, suspended, viewers,
    approvals, alerts, jobs,
  ] = await Promise.all([
    prisma.club.count({ where: { memberships: { none: { isActive: true, role: 'CLUB_OWNER' } } } }),
    prisma.clubInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: now, lt: soon } } }),
    prisma.clubInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: now } } }),
    prisma.clubInvitation.count({ where: { status: 'PENDING', expiresAt: { lte: now } } }),
    prisma.membership.count({ where: { status: 'SUSPENDED' } }),
    prisma.user.count({ where: { isActive: true, memberships: { none: { isActive: true } } } }),
    countOrNull(() => prisma.aIApprovalRequest.count({ where: { status: 'PENDING', expiresAt: { gt: now } } })),
    countOrNull(() => prisma.securityEvent.count({ where: { createdAt: { gte: dayAgo }, severity: { in: ['WARN', 'CRITICAL'] } } })),
    agentJobCounts(),
  ]);

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  if (ownerless > 0) {
    signals.push({
      id: 'clubs.ownerless', severity: 'WARNING', module: 'clubs', count: ownerless, action: 'Review clubs',
      title: `${ownerless} ${plural(ownerless, 'club', 'clubs')} without a president`,
      detail: 'Nobody can invite or remove staff there. Familista will not choose an owner for you — a person decides.',
    });
  }
  if (approvals && approvals > 0) {
    signals.push({
      id: 'ai.approvals', severity: 'ATTENTION', module: 'approvals', count: approvals, action: 'Review',
      title: `${approvals} AI ${plural(approvals, 'action is', 'actions are')} waiting for approval`,
      detail: 'A high-risk agent action does not run until a person approves it. These are queued and unexpired.',
    });
  }
  if (alerts && alerts > 0) {
    signals.push({
      id: 'security.alerts', severity: 'WARNING', module: 'security', count: alerts, action: 'Inspect',
      title: `${alerts} security ${plural(alerts, 'event', 'events')} in the last 24 hours`,
      detail: 'Access denials, suspicious sign-ins and rate-limit trips of severity WARN or CRITICAL.',
    });
  }
  if (jobs && jobs.failed > 0) {
    signals.push({
      id: 'ai.jobs-failed', severity: 'ATTENTION', module: 'agents', count: jobs.failed, action: 'Open AI control',
      title: `${jobs.failed} agent ${plural(jobs.failed, 'job has', 'jobs have')} failed`,
      detail: 'A failed job produced no result. Nothing was written on its behalf.',
    });
  }
  if (expired > 0) {
    signals.push({
      id: 'invitations.expired', severity: 'ATTENTION', module: 'people', count: expired, action: 'Open invitations',
      title: `${expired} ${plural(expired, 'invitation has', 'invitations have')} lapsed unaccepted`,
      detail: 'The link no longer works. Resending mints a new one and retires the old.',
    });
  }
  if (expiring > 0) {
    signals.push({
      id: 'invitations.expiring', severity: 'ATTENTION', module: 'people', count: expiring, action: 'Open invitations',
      title: `${expiring} ${plural(expiring, 'invitation expires', 'invitations expire')} within 48 hours`,
      detail: 'Resending mints a new link and retires the old one.',
    });
  }
  if (suspended > 0) {
    signals.push({
      id: 'memberships.suspended', severity: 'ATTENTION', module: 'people', count: suspended, action: 'Review people',
      title: `${suspended} ${plural(suspended, 'membership is', 'memberships are')} suspended`,
      detail: 'A suspended membership reaches no club data. The row is kept so the history survives.',
    });
  }
  if (pending > 0) {
    signals.push({
      id: 'invitations.pending', severity: 'INFO', module: 'people', count: pending, action: 'Open invitations',
      title: `${pending} ${plural(pending, 'invitation is', 'invitations are')} outstanding`,
      detail: 'Nobody has accepted these yet.',
    });
  }
  if (viewers > 0) {
    signals.push({
      id: 'people.viewers', severity: 'INFO', module: 'people', count: viewers, action: 'Review people',
      title: `${viewers} ${plural(viewers, 'account has', 'accounts have')} no club membership`,
      detail: 'They browse public data only, and reach no private team content anywhere.',
    });
  }

  // Registry state — read from this instance, and true of it.
  for (const e of listExperiments().filter((x) => x.status === 'RUNNING')) {
    signals.push({
      id: `experiment.${e.id}`, severity: 'INFO', module: 'experiments', action: 'Open experiment',
      title: `Experiment running: ${e.title}`,
      detail: e.hypothesis || 'Running in this environment. Pause or decide it from the Experiments module.',
    });
  }
  const env = currentEnvironment();
  for (const f of listFlags().filter((x) => x.enabled && (!x.environments || x.environments.includes(env)))) {
    signals.push({
      id: `flag.${f.key}`, severity: 'INFO', module: 'flags', action: 'Open flags',
      title: `Feature flag on: ${f.key}`,
      detail: `Reaching ${f.audience.replace(/_/g, ' ').toLowerCase()} in ${env}.`,
    });
  }
  if (killSwitchEngaged()) {
    signals.unshift({
      id: 'ai.killswitch', severity: 'WARNING', module: 'agents', action: 'Open AI control',
      title: 'Autonomous AI actions are stopped',
      detail: killSwitchReason() ?? 'The kill switch is engaged. Reading and recommending continue.',
    });
  }
  if (env !== 'PRODUCTION') {
    signals.push({
      id: 'environment.not-production', severity: 'INFO', module: 'settings', action: 'Open settings',
      title: `This instance is ${env}`,
      detail: 'Flags, experiments and agent autonomy are evaluated against this environment, not production.',
    });
  }
  return signals;
}

/**
 * The approval queue: high-risk agent actions that have not run, and will not,
 * until a person decides. Read-only here — deciding one is a club action taken
 * in the club it belongs to, and SYSTEM does not reach past that boundary.
 */
export async function approvalsSurface(actor: PlatformActor, limit = 50) {
  await assertPlatformOwner(actor);
  try {
    const rows = await prisma.aIApprovalRequest.findMany({
      where: { status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      select: { id: true, clubId: true, agent: true, kind: true, status: true, expiresAt: true, createdAt: true },
    });
    return { requests: rows, unavailable: null as string | null };
  } catch {
    return { requests: [], unavailable: 'Approval requests are not readable in this deployment.' };
  }
}

export interface ControlSurface {
  environment: string;
  capabilities: ReadonlyArray<Capability>;
  summary: Record<string, number>;
  killSwitch: { engaged: boolean; reason: string | null };
}

export async function controlSurface(actor: PlatformActor): Promise<ControlSurface> {
  await assertPlatformOwner(actor);
  return {
    environment: currentEnvironment(),
    capabilities: CAPABILITIES,
    summary: capabilitySummary(),
    killSwitch: { engaged: killSwitchEngaged(), reason: killSwitchReason() },
  };
}

export interface IntelligenceSurface {
  environment: string;
  killSwitch: { engaged: boolean; reason: string | null };
  tools: typeof TOOLS;
  models: ReturnType<typeof listModels>;
  /** Recorded agent work, when the platform has recorded any. */
  jobs: { pending: number; running: number; failed: number; succeeded: number } | null;
  unavailable?: string;
}

export async function intelligenceSurface(actor: PlatformActor): Promise<IntelligenceSurface> {
  await assertPlatformOwner(actor);
  let jobs: IntelligenceSurface['jobs'] = null;
  let unavailable: string | undefined;
  try {
    // The states the schema actually declares — see enum AutomationStatus.
    const [pending, running, failed, succeeded] = await Promise.all([
      prisma.aIAgentJob.count({ where: { status: 'PENDING' } }),
      prisma.aIAgentJob.count({ where: { status: 'RUNNING' } }),
      prisma.aIAgentJob.count({ where: { status: 'FAILED' } }),
      prisma.aIAgentJob.count({ where: { status: 'SUCCESS' } }),
    ]);
    jobs = { pending, running, failed, succeeded };
  } catch {
    unavailable = 'Agent job history is not readable in this deployment.';
  }
  return {
    environment: currentEnvironment(),
    killSwitch: { engaged: killSwitchEngaged(), reason: killSwitchReason() },
    tools: TOOLS,
    models: listModels(),
    jobs,
    unavailable,
  };
}

export interface InnovationSurface {
  environment: string;
  flags: FlagRule[];
  experiments: ExperimentRecord[];
}

export async function innovationSurface(actor: PlatformActor): Promise<InnovationSurface> {
  await assertPlatformOwner(actor);
  return { environment: currentEnvironment(), flags: listFlags(), experiments: listExperiments() };
}

/**
 * Recent security events and the audit trail, for the two modules that read
 * them. Both are already recorded by the platform; this only presents them.
 */
export async function securitySurface(actor: PlatformActor, limit = 50) {
  await assertPlatformOwner(actor);
  const events = await prisma.securityEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: { id: true, kind: true, severity: true, clubId: true, actorId: true, ipAddress: true, createdAt: true },
  });
  return { events };
}

export async function auditSurface(actor: PlatformActor, limit = 50) {
  await assertPlatformOwner(actor);
  const rows = await prisma.membershipAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: { id: true, clubId: true, actorUserId: true, action: true, reason: true, createdAt: true },
  });
  return { rows };
}


export interface GovernanceSurface {
  packs: ReturnType<typeof listPacks>;
  classifications: Record<string, string>;
  /** The decision for a question the caller asked, when they asked one. */
  decision: ReturnType<typeof decide> | null;
}

/**
 * Governance, as the platform can answer it today: which jurisdiction packs are
 * loaded, how each resource family is classified, and — when the caller poses
 * one — what the engine decides about a specific question.
 *
 * The evaluation is a read. It changes nothing, and it is the honest way to
 * show an operator what the policy engine would do before it does it.
 */
export async function governanceSurface(
  actor: PlatformActor,
  question?: Partial<PolicyRequest>,
): Promise<GovernanceSurface> {
  await assertPlatformOwner(actor);
  const decision = question?.resource
    ? decide({
        actorLevel: (question.actorLevel ?? 'CLUB_STAFF') as PolicyRequest['actorLevel'],
        jurisdiction: question.jurisdiction ?? null,
        resource: question.resource,
        action: (question.action ?? 'READ') as PolicyRequest['action'],
        subjectIsMinor: question.subjectIsMinor,
        aiInvolved: question.aiInvolved,
        consentGiven: question.consentGiven,
      })
    : null;
  return {
    packs: listPacks(),
    classifications: RESOURCE_CLASSIFICATION as unknown as Record<string, string>,
    decision,
  };
}
