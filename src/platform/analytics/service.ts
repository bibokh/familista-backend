// The one way anything is recorded, and the one way anything is read
// ─────────────────────────────────────────────────────────────────────────────
// Instrumentation calls `track`. Screens, and later AI agents, call the read
// functions. Nothing anywhere else touches the analytics tables — an agent that
// queries production tables directly is an agent nobody can reason about, and a
// screen that does it is a screen that breaks when the store changes.
//
// Three rules this file keeps:
//
//   1. Tracking never fails the caller. A training session was still created
//      even if the analytics write failed; an event is a record of something
//      that happened, not a step in making it happen.
//   2. Nothing is recorded that was not declared. `sanitize` drops unknown
//      events and unknown fields, so the vocabulary is the contract file's,
//      not the caller's.
//   3. Reads are aggregates, and reads are platform-owner-only. Cross-club
//      analytics is the platform owner's view by definition: no club may see
//      another club through it.

import { AnalyticsEnvironment } from '@prisma/client';
import { logger } from '../../utils/logger';
import { currentEnvironment } from '../environment';
import { assertPlatformOwner } from '../system.service';
import type { PlatformActor } from '../access-levels';
import { sanitize, type AnalyticsEventInput } from './contracts';
import { analyticsStore, type StoredEvent, type Window } from './store';
import { retentionCutoffs } from './retention';

export const ANALYTICS_ENVIRONMENTS: AnalyticsEnvironment[] = ['PRODUCTION', 'STAGING', 'LAB', 'PREVIEW'];

/**
 * The environment an event belongs to, resolved from the PROCESS.
 *
 * Never from a request header or a request body. A client that could name its
 * own environment could write Lab traffic into the production figures, which is
 * precisely the contamination the environment column exists to prevent.
 */
export function analyticsEnvironment(): AnalyticsEnvironment {
  const env = currentEnvironment();
  return (ANALYTICS_ENVIRONMENTS as string[]).includes(env)
    ? (env as AnalyticsEnvironment)
    : 'PREVIEW';
}

export interface TrackActor {
  userId?: string | null;
  platformRole?: string | null;
}

/** How many events one request may carry. A batch, not a firehose. */
export const MAX_BATCH = 50;

/**
 * Record what happened.
 *
 * Returns how many events were stored, which is not always how many were sent:
 * an unknown event name, a missing session or a payload carrying a forbidden
 * key is dropped here rather than stored. The caller is not told which — a
 * client that can probe the allowlist is a client that can map it.
 */
export async function track(
  actor: TrackActor,
  events: AnalyticsEventInput[] | AnalyticsEventInput,
): Promise<{ accepted: number; rejected: number }> {
  const list = (Array.isArray(events) ? events : [events]).slice(0, MAX_BATCH);
  const environment = analyticsEnvironment();
  const stored: StoredEvent[] = [];

  for (const input of list) {
    const clean = sanitize({ ...input });
    if (!clean) continue;
    stored.push({
      ...clean,
      environment,
      userId: actor.userId ?? null,
      platformRole: actor.platformRole ?? null,
    });
  }

  const rejected = list.length - stored.length;
  if (!stored.length) return { accepted: 0, rejected };

  try {
    const store = analyticsStore();
    await store.writeEvents(stored);
    // Sessions are touched after the batch is safely written, in order, so a
    // session's counters reflect what was actually stored.
    for (const event of stored) await store.touchSession(event);
    return { accepted: stored.length, rejected };
  } catch (err) {
    // Rule 1. The product carries on; the failure is visible in the log.
    logger.warn('analytics write failed', { err: String(err), count: stored.length });
    return { accepted: 0, rejected: list.length };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads — every one of them the platform owner's
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyticsQuery {
  environment?: AnalyticsEnvironment;
  days?: number;
  clubId?: string | null;
  module?: string | null;
  role?: string | null;
}

const DAY = 86400000;
const startOfUTCDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The window a question is asked over.
 *
 * The environment defaults to PRODUCTION, deliberately and everywhere: the
 * business view of Familista is the production one, and an operator who has to
 * remember to exclude Lab traffic will one day forget.
 */
export function windowFor(q: AnalyticsQuery = {}, now = new Date()): Window & { days: number } {
  const days = Math.max(1, Math.min(Math.round(q.days ?? 30), 365));
  const to = new Date(now.getTime() + 1000);
  const from = new Date(startOfUTCDay(now).getTime() - (days - 1) * DAY);
  return { environment: q.environment ?? 'PRODUCTION', from, to, days };
}

export interface ActiveUsers {
  dau: number; wau: number; mau: number;
  dauPrevious: number; wauPrevious: number; mauPrevious: number;
  /** The definitions, carried with the numbers so a screen never invents one. */
  definitions: Record<string, string>;
}

/**
 * DAU, WAU, MAU — unique users, never event counts.
 *
 * A "user" is a distinct authenticated userId with at least one analytics event
 * in the window, in the chosen environment. A signed-out visitor has no id and
 * is therefore not a user here, which is the honest answer rather than an
 * inflated one.
 */
export async function activeUsers(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()): Promise<ActiveUsers> {
  await assertPlatformOwner(actor);
  const environment = q.environment ?? 'PRODUCTION';
  const store = analyticsStore();
  const today = startOfUTCDay(now);
  const span = (daysBack: number, offsetDays = 0) => ({
    environment,
    from: new Date(today.getTime() - (daysBack - 1 + offsetDays) * DAY),
    to: new Date(today.getTime() + DAY - offsetDays * DAY),
  });

  const [dau, wau, mau, dauPrev, wauPrev, mauPrev] = await Promise.all([
    store.uniqueUsers(span(1)), store.uniqueUsers(span(7)), store.uniqueUsers(span(30)),
    store.uniqueUsers(span(1, 1)), store.uniqueUsers(span(7, 7)), store.uniqueUsers(span(30, 30)),
  ]);

  return {
    dau, wau, mau, dauPrevious: dauPrev, wauPrevious: wauPrev, mauPrevious: mauPrev,
    definitions: {
      dau: 'Distinct authenticated users with at least one analytics event today (UTC), in this environment.',
      wau: 'Distinct authenticated users with at least one analytics event in the last 7 days, in this environment.',
      mau: 'Distinct authenticated users with at least one analytics event in the last 30 days, in this environment.',
      comparison: 'Each "previous" figure is the immediately preceding window of the same length.',
    },
  };
}

export interface ModuleUsage {
  module: string;
  opens: number;
  uniqueUsers: number;
  totalDurationMs: number;
  averageDurationMs: number | null;
  /** Share of active users who opened it at all, in this window. */
  adoption: number | null;
  /** Opens this window against the previous one of the same length, as a ratio. */
  trend: number | null;
}

export async function moduleUsage(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()): Promise<{
  window: { days: number; environment: string };
  activeUsers: number;
  modules: ModuleUsage[];
}> {
  await assertPlatformOwner(actor);
  const w = windowFor(q, now);
  const previous = { environment: w.environment, from: new Date(w.from.getTime() - w.days * DAY), to: w.from };
  const store = analyticsStore();

  const [current, prior, users] = await Promise.all([
    store.byDimension(w, 'module', 60),
    store.byDimension(previous, 'module', 60),
    store.uniqueUsers(w),
  ]);
  const priorBy = new Map(prior.map((p) => [p.dimension, p.events]));

  return {
    window: { days: w.days, environment: w.environment },
    activeUsers: users,
    modules: current.map((m) => {
      const before = priorBy.get(m.dimension) ?? 0;
      return {
        module: m.dimension,
        opens: m.events,
        uniqueUsers: m.uniqueUsers,
        totalDurationMs: m.totalDurationMs,
        averageDurationMs: m.events ? Math.round(m.totalDurationMs / m.events) : null,
        adoption: users ? Math.round((m.uniqueUsers / users) * 1000) / 10 : null,
        // No previous data is not a 100% rise. It is no comparison at all.
        trend: before ? Math.round(((m.events - before) / before) * 1000) / 10 : null,
      };
    }),
  };
}

export async function usageRhythm(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()) {
  await assertPlatformOwner(actor);
  const w = windowFor(q, now);
  const store = analyticsStore();
  const [hours, weekdays, daily] = await Promise.all([
    store.byHour(w), store.byWeekday(w), store.dailyUniqueUsers(w),
  ]);
  return {
    window: { days: w.days, environment: w.environment },
    // Bucketed in UTC, and said so: an hour histogram whose timezone is a guess
    // is worse than one whose timezone is stated.
    timezone: 'UTC',
    hours, weekdays, daily,
  };
}

export async function roleUsage(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()) {
  await assertPlatformOwner(actor);
  const w = windowFor(q, now);
  const roles = await analyticsStore().byDimension(w, 'platformRole', 20);
  return { window: { days: w.days, environment: w.environment }, roles };
}

export async function clubUsage(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()) {
  await assertPlatformOwner(actor);
  const w = windowFor(q, now);
  const store = analyticsStore();
  const today = { environment: w.environment, from: startOfUTCDay(now), to: new Date(now.getTime() + 1000) };
  const week = { environment: w.environment, from: new Date(startOfUTCDay(now).getTime() - 6 * DAY), to: today.to };
  const [overall, active1, active7] = await Promise.all([
    store.byDimension(w, 'clubId', 200),
    store.byDimension(today, 'clubId', 500),
    store.byDimension(week, 'clubId', 500),
  ]);
  return {
    window: { days: w.days, environment: w.environment },
    activeToday: active1.length,
    activeThisWeek: active7.length,
    // Metadata only: a club id, its counts. No club's content is reachable
    // through this surface, and no club can see another through it at all.
    clubs: overall,
  };
}

export async function journeys(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()) {
  await assertPlatformOwner(actor);
  const w = windowFor(q, now);
  return { window: { days: w.days, environment: w.environment }, paths: await analyticsStore().journeys(w, 15) };
}

export interface RetentionReport {
  cohortDay: string | null;
  cohortSize: number;
  day1: number | null;
  day7: number | null;
  day30: number | null;
  /** Present when a figure cannot be computed yet, rather than a zero. */
  collecting: string | null;
}

/**
 * Cohort retention, or an honest admission that there is not enough history.
 *
 * A Day-30 figure needs a cohort that is at least 30 days old. Until the
 * platform has been collecting that long, the answer is "collecting data" — a
 * retention percentage computed from four days of history is not a small
 * number, it is a wrong one.
 */
export async function retention(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()): Promise<RetentionReport> {
  await assertPlatformOwner(actor);
  const environment = q.environment ?? 'PRODUCTION';
  const store = analyticsStore();
  const earliest = await store.earliestEvent(environment);
  if (!earliest) {
    return { cohortDay: null, cohortSize: 0, day1: null, day7: null, day30: null, collecting: 'No analytics events have been recorded in this environment yet.' };
  }

  const daysOfHistory = Math.floor((startOfUTCDay(now).getTime() - startOfUTCDay(earliest).getTime()) / DAY);
  const offsets = [1, 7, 30].filter((o) => daysOfHistory >= o);
  if (!offsets.length) {
    return {
      cohortDay: null, cohortSize: 0, day1: null, day7: null, day30: null,
      collecting: `Collecting data — ${daysOfHistory} day(s) of history so far. Day 1 retention needs 1.`,
    };
  }

  // The oldest full cohort the longest offset allows: the earliest day, which
  // is where the first users are.
  const cohortDay = startOfUTCDay(earliest);
  const { cohortSize, retained } = await store.retentionCohort(environment, cohortDay, offsets);
  const pct = (o: number) => (offsets.includes(o) && cohortSize ? Math.round((retained[o] / cohortSize) * 1000) / 10 : null);

  return {
    cohortDay: cohortDay.toISOString().slice(0, 10),
    cohortSize,
    day1: pct(1), day7: pct(7), day30: pct(30),
    collecting: offsets.length === 3 ? null
      : `Collecting data — ${daysOfHistory} day(s) of history. Day ${[1, 7, 30].filter((o) => !offsets.includes(o)).join(', Day ')} needs more.`,
  };
}

export interface PlatformActivity {
  environment: string;
  sessions: number;
  averageSessionMs: number | null;
  events: number;
  activeToday: number;
  activeTodayDefinition: string;
  hourly: Array<{ hour: number; events: number; uniqueUsers: number }>;
  collecting: string | null;
}

/**
 * The last 24 hours, for the Overview.
 *
 * "Active today" here means exactly one thing, and it is stated with the
 * number: distinct authenticated users with at least one production analytics
 * event during the current UTC calendar day. It is not "live now" — nothing
 * here claims a live session, because nothing here measures one.
 */
export async function platformActivity(actor: PlatformActor, q: AnalyticsQuery = {}, now = new Date()): Promise<PlatformActivity> {
  await assertPlatformOwner(actor);
  const environment = q.environment ?? 'PRODUCTION';
  const store = analyticsStore();
  const today = { environment, from: startOfUTCDay(now), to: new Date(now.getTime() + 1000) };
  const last24 = { environment, from: new Date(now.getTime() - DAY), to: today.to };

  const [activeToday, stats, events, hourly, earliest] = await Promise.all([
    store.uniqueUsers(today),
    store.sessionStats(last24),
    store.eventCount(last24),
    store.byHour(last24),
    store.earliestEvent(environment),
  ]);

  return {
    environment,
    sessions: stats.sessions,
    averageSessionMs: stats.avgDurationMs,
    events,
    activeToday,
    activeTodayDefinition:
      'Distinct authenticated users with at least one analytics event during the current UTC calendar day, in this environment. Sign-ins are counted separately and are not this figure.',
    hourly,
    collecting: earliest ? null : 'No analytics events have been recorded in this environment yet.',
  };
}

/** What the platform keeps, and for how long. Read by the governance surface. */
export function retentionPolicy(now = new Date()) {
  const { policy, raw, rollup } = retentionCutoffs(now);
  return {
    rawDays: policy.rawDays,
    rollupDays: Math.max(policy.rollupDays, policy.rawDays),
    source: policy.source,
    rawCutoff: raw.toISOString(),
    rollupCutoff: rollup.toISOString(),
    note: 'Raw events expire; daily rollups are kept for history. Both are configurable through ANALYTICS_RAW_RETENTION_DAYS and ANALYTICS_ROLLUP_RETENTION_DAYS.',
  };
}
