// Where analytics goes — one interface, one implementation, room for another
// ─────────────────────────────────────────────────────────────────────────────
// Familista's scale today is answered well by Postgres, and adding a warehouse
// before there is anything to warehouse buys latency and an operations burden
// for nothing. But the instrumentation above this file must never have to know
// that, because the day the answer changes, rewriting every call site is how a
// migration turns into a rewrite.
//
// So: product code calls `track()`. `track()` calls a store. The store is an
// interface, and swapping PostgresAnalyticsStore for a ClickHouse or BigQuery
// one is a change to this file and its neighbour — not to a single line of
// instrumentation.
//
// The interface is deliberately narrow. Writes are append-only and batched;
// reads are aggregates, never "give me the rows". A store that cannot answer an
// aggregate without fetching a million rows is not implementing this interface,
// it is defeating it.

import { AnalyticsEnvironment, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import type { SanitizedEvent } from './contracts';

export interface StoredEvent extends SanitizedEvent {
  environment: AnalyticsEnvironment;
  userId: string | null;
  platformRole: string | null;
}

export interface DailyMetricRow {
  day: Date;
  metric: string;
  dimension: string;
  value: number;
  uniqueUsers: number;
}

export interface Window {
  environment: AnalyticsEnvironment;
  from: Date;
  to: Date;
}

export interface CountedDimension {
  dimension: string;
  events: number;
  uniqueUsers: number;
  totalDurationMs: number;
}

export interface AnalyticsStore {
  /** Append. Never fails the caller — see track(). */
  writeEvents(events: StoredEvent[]): Promise<number>;
  /** One row per session, created once and updated after. */
  touchSession(event: StoredEvent): Promise<void>;
  closeIdleSessions(idleMs: number, now?: Date): Promise<number>;

  uniqueUsers(window: Window): Promise<number>;
  eventCount(window: Window): Promise<number>;
  sessionStats(window: Window): Promise<{ sessions: number; avgDurationMs: number | null; users: number }>;
  byDimension(window: Window, dimension: 'module' | 'feature' | 'clubId' | 'platformRole' | 'eventName', limit?: number): Promise<CountedDimension[]>;
  byHour(window: Window): Promise<Array<{ hour: number; events: number; uniqueUsers: number }>>;
  byWeekday(window: Window): Promise<Array<{ weekday: number; events: number; uniqueUsers: number }>>;
  dailyUniqueUsers(window: Window): Promise<Array<{ day: string; uniqueUsers: number; events: number }>>;
  journeys(window: Window, limit?: number): Promise<Array<{ path: string; sessions: number }>>;
  retentionCohort(environment: AnalyticsEnvironment, cohortDay: Date, offsets: number[]): Promise<{ cohortSize: number; retained: Record<number, number> }>;

  readDaily(environment: AnalyticsEnvironment, metric: string, from: Date, to: Date): Promise<DailyMetricRow[]>;
  writeDaily(environment: AnalyticsEnvironment, day: Date, rows: Array<Omit<DailyMetricRow, 'day'>>): Promise<number>;

  purgeRawBefore(cutoff: Date): Promise<number>;
  purgeDailyBefore(cutoff: Date): Promise<number>;
  earliestEvent(environment: AnalyticsEnvironment): Promise<Date | null>;
}

const utcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

/**
 * Postgres, queried the way a dashboard needs it.
 *
 * Every read below is an aggregate that comes back as a handful of rows. There
 * is no findMany over the event table anywhere in this file, and the tests
 * assert that — counting a million rows in JavaScript is exactly the failure
 * this design exists to avoid.
 */
export class PostgresAnalyticsStore implements AnalyticsStore {
  async writeEvents(events: StoredEvent[]): Promise<number> {
    if (!events.length) return 0;
    const rows = events.map((e) => ({
      eventName: e.eventName,
      occurredAt: e.occurredAt,
      environment: e.environment,
      sessionId: e.sessionId,
      userId: e.userId,
      platformRole: e.platformRole,
      clubId: e.clubId,
      teamId: e.teamId,
      module: e.module,
      feature: e.feature,
      route: e.route,
      durationMs: e.durationMs,
      deviceCategory: e.deviceCategory,
      locale: e.locale,
      timezone: e.timezone,
      source: e.source,
      schemaVersion: e.schemaVersion,
      day: utcDay(e.occurredAt),
      hourOfDay: e.occurredAt.getUTCHours(),
      weekday: e.occurredAt.getUTCDay(),
    }));
    const out = await prisma.analyticsEvent.createMany({ data: rows, skipDuplicates: true });
    return out.count;
  }

  /**
   * The session row, created once.
   *
   * `create` inside a catch rather than an upsert with a read first: the unique
   * primary key is what makes a refresh, a duplicate listener and a
   * re-rendering route unable to start a second session, and letting the
   * database enforce that is both correct under concurrency and one round trip.
   */
  async touchSession(event: StoredEvent): Promise<void> {
    const day = utcDay(event.occurredAt);
    const updated = await prisma.analyticsSession.updateMany({
      where: { id: event.sessionId },
      data: {
        lastActivityAt: event.occurredAt,
        eventCount: { increment: 1 },
        ...(event.eventName === 'module_opened' ? { moduleCount: { increment: 1 } } : {}),
        ...(event.eventName === 'session_ended'
          ? { endedAt: event.occurredAt, ...(event.durationMs != null ? { durationMs: event.durationMs } : {}) }
          : {}),
        ...(event.clubId ? { clubId: event.clubId } : {}),
      },
    });
    if (updated.count > 0) return;

    try {
      await prisma.analyticsSession.create({
        data: {
          id: event.sessionId,
          environment: event.environment,
          userId: event.userId,
          platformRole: event.platformRole,
          clubId: event.clubId,
          startedAt: event.occurredAt,
          lastActivityAt: event.occurredAt,
          eventCount: 1,
          moduleCount: event.eventName === 'module_opened' ? 1 : 0,
          deviceCategory: event.deviceCategory,
          locale: event.locale,
          timezone: event.timezone,
          day,
        },
      });
    } catch (_) {
      // Two events for a new session arriving together: the loser of the race
      // updates instead. Never an error the caller sees.
      await prisma.analyticsSession.updateMany({
        where: { id: event.sessionId },
        data: { lastActivityAt: event.occurredAt, eventCount: { increment: 1 } },
      });
    }
  }

  /**
   * A session nobody has touched for `idleMs` is over.
   *
   * Browsers do not reliably send a goodbye — a closed laptop sends nothing —
   * so a session that never received session_ended is closed here, with its
   * duration measured to its last real activity rather than to now. Counting
   * the idle time would make every abandoned tab look like engagement.
   */
  async closeIdleSessions(idleMs: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - idleMs);
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      WITH closed AS (
        UPDATE "AnalyticsSession"
           SET "endedAt" = "lastActivityAt",
               "durationMs" = GREATEST(0, LEAST(
                 EXTRACT(EPOCH FROM ("lastActivityAt" - "startedAt")) * 1000, 86400000))::int
         WHERE "endedAt" IS NULL AND "lastActivityAt" < ${cutoff}
         RETURNING 1
      ) SELECT COUNT(*)::bigint AS count FROM closed`);
    return num(rows[0]?.count);
  }

  async uniqueUsers({ environment, from, to }: Window): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT "userId")::bigint AS count FROM "AnalyticsEvent"
       WHERE "environment" = ${environment}::"AnalyticsEnvironment"
         AND "occurredAt" >= ${from} AND "occurredAt" < ${to} AND "userId" IS NOT NULL`);
    return num(rows[0]?.count);
  }

  async eventCount({ environment, from, to }: Window): Promise<number> {
    return prisma.analyticsEvent.count({
      where: { environment, occurredAt: { gte: from, lt: to } },
    });
  }

  async sessionStats({ environment, from, to }: Window) {
    const rows = await prisma.$queryRaw<Array<{ sessions: bigint; avgms: number | null; users: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS sessions,
             AVG("durationMs")::float AS avgms,
             COUNT(DISTINCT "userId")::bigint AS users
        FROM "AnalyticsSession"
       WHERE "environment" = ${environment}::"AnalyticsEnvironment"
         AND "startedAt" >= ${from} AND "startedAt" < ${to}`);
    const r = rows[0];
    return {
      sessions: num(r?.sessions),
      avgDurationMs: r?.avgms == null ? null : Math.round(r.avgms),
      users: num(r?.users),
    };
  }

  async byDimension({ environment, from, to }: Window, dimension: 'module' | 'feature' | 'clubId' | 'platformRole' | 'eventName', limit = 30): Promise<CountedDimension[]> {
    // The column is chosen from a fixed set above, never interpolated from a
    // request — Prisma.raw on a caller-supplied string would be an injection.
    const column = Prisma.raw(`"${dimension}"`);
    const rows = await prisma.$queryRaw<Array<{ dimension: string | null; events: bigint; users: bigint; duration: bigint | null }>>(Prisma.sql`
      SELECT ${column} AS dimension,
             COUNT(*)::bigint AS events,
             COUNT(DISTINCT "userId")::bigint AS users,
             COALESCE(SUM("durationMs"), 0)::bigint AS duration
        FROM "AnalyticsEvent"
       WHERE "environment" = ${environment}::"AnalyticsEnvironment"
         AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
         AND ${column} IS NOT NULL
       GROUP BY ${column}
       ORDER BY events DESC
       LIMIT ${limit}`);
    return rows.map((r) => ({
      dimension: r.dimension ?? '',
      events: num(r.events),
      uniqueUsers: num(r.users),
      totalDurationMs: num(r.duration),
    }));
  }

  async byHour({ environment, from, to }: Window) {
    const rows = await prisma.$queryRaw<Array<{ hour: number; events: bigint; users: bigint }>>(Prisma.sql`
      SELECT "hourOfDay" AS hour, COUNT(*)::bigint AS events, COUNT(DISTINCT "userId")::bigint AS users
        FROM "AnalyticsEvent"
       WHERE "environment" = ${environment}::"AnalyticsEnvironment"
         AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
       GROUP BY "hourOfDay" ORDER BY "hourOfDay"`);
    return rows.map((r) => ({ hour: Number(r.hour), events: num(r.events), uniqueUsers: num(r.users) }));
  }

  async byWeekday({ environment, from, to }: Window) {
    const rows = await prisma.$queryRaw<Array<{ weekday: number; events: bigint; users: bigint }>>(Prisma.sql`
      SELECT "weekday", COUNT(*)::bigint AS events, COUNT(DISTINCT "userId")::bigint AS users
        FROM "AnalyticsEvent"
       WHERE "environment" = ${environment}::"AnalyticsEnvironment"
         AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
       GROUP BY "weekday" ORDER BY "weekday"`);
    return rows.map((r) => ({ weekday: Number(r.weekday), events: num(r.events), uniqueUsers: num(r.users) }));
  }

  async dailyUniqueUsers({ environment, from, to }: Window) {
    const rows = await prisma.$queryRaw<Array<{ day: Date; users: bigint; events: bigint }>>(Prisma.sql`
      SELECT "day", COUNT(DISTINCT "userId")::bigint AS users, COUNT(*)::bigint AS events
        FROM "AnalyticsEvent"
       WHERE "environment" = ${environment}::"AnalyticsEnvironment"
         AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
       GROUP BY "day" ORDER BY "day"`);
    return rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      uniqueUsers: num(r.users),
      events: num(r.events),
    }));
  }

  /**
   * The shapes of visits, built from module keys only.
   *
   * A journey is the ordered list of modules one session opened. It contains no
   * page content, no ids and nothing a person typed — "club-home → academy →
   * match-center" is the whole record.
   */
  async journeys({ environment, from, to }: Window, limit = 15) {
    const rows = await prisma.$queryRaw<Array<{ path: string; sessions: bigint }>>(Prisma.sql`
      WITH steps AS (
        SELECT "sessionId", "module",
               ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "occurredAt") AS step
          FROM "AnalyticsEvent"
         WHERE "environment" = ${environment}::"AnalyticsEnvironment"
           AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
           AND "eventName" = 'module_opened' AND "module" IS NOT NULL
      ), paths AS (
        SELECT "sessionId", string_agg("module", ' → ' ORDER BY step) AS path
          FROM steps WHERE step <= 5 GROUP BY "sessionId"
      )
      SELECT path, COUNT(*)::bigint AS sessions FROM paths
       GROUP BY path ORDER BY sessions DESC LIMIT ${limit}`);
    return rows.map((r) => ({ path: r.path, sessions: num(r.sessions) }));
  }

  /**
   * Classic cohort retention: of the users first seen on one day, how many came
   * back on day N. "First seen" is genuinely first — a user with any earlier
   * event is not in the cohort — so a long-standing user cannot inflate it.
   */
  async retentionCohort(environment: AnalyticsEnvironment, cohortDay: Date, offsets: number[]) {
    const day = utcDay(cohortDay);
    const cohort = await prisma.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
      SELECT DISTINCT e."userId" FROM "AnalyticsEvent" e
       WHERE e."environment" = ${environment}::"AnalyticsEnvironment"
         AND e."day" = ${day}::date AND e."userId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "AnalyticsEvent" p
            WHERE p."environment" = e."environment" AND p."userId" = e."userId" AND p."day" < ${day}::date)`);
    const ids = cohort.map((c) => c.userId);
    const retained: Record<number, number> = {};
    if (!ids.length) return { cohortSize: 0, retained };

    for (const offset of offsets) {
      const target = new Date(day.getTime() + offset * 86400000);
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "userId")::bigint AS count FROM "AnalyticsEvent"
         WHERE "environment" = ${environment}::"AnalyticsEnvironment"
           AND "day" = ${target}::date AND "userId" IN (${Prisma.join(ids)})`);
      retained[offset] = num(rows[0]?.count);
    }
    return { cohortSize: ids.length, retained };
  }

  async readDaily(environment: AnalyticsEnvironment, metric: string, from: Date, to: Date): Promise<DailyMetricRow[]> {
    const rows = await prisma.analyticsDailyMetric.findMany({
      where: { environment, metric, day: { gte: utcDay(from), lte: utcDay(to) } },
      orderBy: [{ day: 'asc' }, { value: 'desc' }],
      take: 2000,
    });
    return rows.map((r) => ({
      day: r.day, metric: r.metric, dimension: r.dimension,
      value: num(r.value), uniqueUsers: r.uniqueUsers,
    }));
  }

  /** Idempotent by the unique key: re-running a day corrects it, never doubles it. */
  async writeDaily(environment: AnalyticsEnvironment, day: Date, rows: Array<Omit<DailyMetricRow, 'day'>>): Promise<number> {
    const d = utcDay(day);
    let written = 0;
    for (const row of rows) {
      await prisma.analyticsDailyMetric.upsert({
        where: { day_environment_metric_dimension: { day: d, environment, metric: row.metric, dimension: row.dimension } },
        create: { day: d, environment, metric: row.metric, dimension: row.dimension, value: BigInt(row.value), uniqueUsers: row.uniqueUsers },
        update: { value: BigInt(row.value), uniqueUsers: row.uniqueUsers, computedAt: new Date() },
      });
      written += 1;
    }
    return written;
  }

  async purgeRawBefore(cutoff: Date): Promise<number> {
    const out = await prisma.analyticsEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    await prisma.analyticsSession.deleteMany({ where: { startedAt: { lt: cutoff } } });
    return out.count;
  }

  async purgeDailyBefore(cutoff: Date): Promise<number> {
    const out = await prisma.analyticsDailyMetric.deleteMany({ where: { day: { lt: utcDay(cutoff) } } });
    return out.count;
  }

  async earliestEvent(environment: AnalyticsEnvironment): Promise<Date | null> {
    const row = await prisma.analyticsEvent.findFirst({
      where: { environment }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true },
    });
    return row?.occurredAt ?? null;
  }
}

let store: AnalyticsStore = new PostgresAnalyticsStore();

/** The one seam. Swapping the warehouse is this function, not the call sites. */
export function analyticsStore(): AnalyticsStore { return store; }
export function setAnalyticsStore(next: AnalyticsStore): void { store = next; }
