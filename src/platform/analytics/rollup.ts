// Raw events in, daily numbers out
// ─────────────────────────────────────────────────────────────────────────────
// The SYSTEM Overview must not count millions of raw events every time somebody
// opens it. So a day is summarised once — unique users, sessions, per-module
// opens and dwell time, per-role and per-club activity — and the dashboard
// reads the summary.
//
// Idempotent by construction: every row is upserted on
// (day, environment, metric, dimension), so re-running a day corrects it and
// never doubles it. That is what makes it safe to run on every boot, to
// re-run after a fix, and to backfill.

import { AnalyticsEnvironment } from '@prisma/client';
import { analyticsStore } from './store';
import { retentionCutoffs } from './retention';

const DAY = 86400000;
const startOfUTCDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export interface RollupResult {
  day: string;
  environment: AnalyticsEnvironment;
  rowsWritten: number;
}

/** Summarise one calendar day (UTC), in one environment. */
export async function rollupDay(environment: AnalyticsEnvironment, day: Date): Promise<RollupResult> {
  const from = startOfUTCDay(day);
  const to = new Date(from.getTime() + DAY);
  const window = { environment, from, to };
  const store = analyticsStore();

  const [users, events, sessions, modules, features, roles, clubs, names] = await Promise.all([
    store.uniqueUsers(window),
    store.eventCount(window),
    store.sessionStats(window),
    store.byDimension(window, 'module', 200),
    store.byDimension(window, 'feature', 200),
    store.byDimension(window, 'platformRole', 20),
    store.byDimension(window, 'clubId', 500),
    store.byDimension(window, 'eventName', 100),
  ]);

  const rows = [
    { metric: 'dau', dimension: '', value: users, uniqueUsers: users },
    { metric: 'events', dimension: '', value: events, uniqueUsers: users },
    { metric: 'sessions', dimension: '', value: sessions.sessions, uniqueUsers: sessions.users },
    { metric: 'session.avg_ms', dimension: '', value: sessions.avgDurationMs ?? 0, uniqueUsers: sessions.users },
    { metric: 'clubs.active', dimension: '', value: clubs.length, uniqueUsers: 0 },
    ...modules.flatMap((m) => [
      { metric: 'module.opens', dimension: m.dimension, value: m.events, uniqueUsers: m.uniqueUsers },
      { metric: 'module.duration_ms', dimension: m.dimension, value: m.totalDurationMs, uniqueUsers: m.uniqueUsers },
    ]),
    ...features.map((f) => ({ metric: 'feature.uses', dimension: f.dimension, value: f.events, uniqueUsers: f.uniqueUsers })),
    ...roles.map((r) => ({ metric: 'role.events', dimension: r.dimension, value: r.events, uniqueUsers: r.uniqueUsers })),
    ...clubs.map((c) => ({ metric: 'club.events', dimension: c.dimension, value: c.events, uniqueUsers: c.uniqueUsers })),
    ...names.map((n) => ({ metric: 'event.count', dimension: n.dimension, value: n.events, uniqueUsers: n.uniqueUsers })),
  ];

  const rowsWritten = await store.writeDaily(environment, from, rows);
  return { day: from.toISOString().slice(0, 10), environment, rowsWritten };
}

/**
 * Catch up: every day from the last one summarised to yesterday.
 *
 * Bounded, because an unbounded backfill on a boot is how a deploy times out.
 * Today is deliberately not summarised — it is not over, and a partial day
 * written as a final figure is a wrong figure that looks final.
 */
export async function rollupRecent(
  environment: AnalyticsEnvironment,
  opts: { maxDays?: number; now?: Date } = {},
): Promise<RollupResult[]> {
  const now = opts.now ?? new Date();
  const maxDays = Math.max(1, Math.min(opts.maxDays ?? 7, 90));
  const results: RollupResult[] = [];
  for (let back = 1; back <= maxDays; back++) {
    const day = new Date(startOfUTCDay(now).getTime() - back * DAY);
    results.push(await rollupDay(environment, day));
  }
  return results;
}

/** Apply the retention policy. Raw events expire; rollups outlive them. */
export async function sweepRetention(now = new Date(), env: NodeJS.ProcessEnv = process.env) {
  const { policy, raw, rollup } = retentionCutoffs(now, env);
  const store = analyticsStore();
  const [rawDeleted, rollupDeleted] = [await store.purgeRawBefore(raw), await store.purgeDailyBefore(rollup)];
  return {
    policy,
    rawCutoff: raw.toISOString(),
    rollupCutoff: rollup.toISOString(),
    rawDeleted,
    rollupDeleted,
  };
}
