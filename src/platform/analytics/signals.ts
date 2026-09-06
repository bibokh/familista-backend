// Deterministic signals — thresholds, not predictions
// ─────────────────────────────────────────────────────────────────────────────
// A platform that says "anomaly detected" without being able to say what it
// compared has told the operator nothing they can act on. So this layer is
// arithmetic on two windows, with the threshold written down, and every signal
// carries the two numbers it was derived from.
//
// Machine learning may later augment or replace these. It will not replace them
// with something less explainable: whatever comes next must still be able to
// say what it compared and why it fired.

import { AnalyticsEnvironment } from '@prisma/client';
import { analyticsStore } from './store';

const DAY = 86400000;
const startOfUTCDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export interface AnalyticsSignal {
  id: string;
  severity: 'INFO' | 'ATTENTION' | 'WARNING';
  title: string;
  detail: string;
  module: string;
  action: string;
}

/** How far a figure may fall before it is worth saying so. */
export const USAGE_DROP_THRESHOLD = 0.4;
/** How long a club may be quiet before it is worth saying so. */
export const CLUB_QUIET_DAYS = 14;
/** Below this many events, a "drop" is noise rather than a trend. */
export const MIN_EVENTS_FOR_TREND = 20;

export async function analyticsSignals(
  environment: AnalyticsEnvironment = 'PRODUCTION',
  now = new Date(),
): Promise<AnalyticsSignal[]> {
  const store = analyticsStore();
  const today = startOfUTCDay(now);
  const week = { environment, from: new Date(today.getTime() - 6 * DAY), to: new Date(now.getTime() + 1000) };
  const priorWeek = { environment, from: new Date(today.getTime() - 13 * DAY), to: week.from };

  const [current, previous, activeUsersNow, activeUsersBefore] = await Promise.all([
    store.byDimension(week, 'module', 60),
    store.byDimension(priorWeek, 'module', 60),
    store.uniqueUsers(week),
    store.uniqueUsers(priorWeek),
  ]);

  const signals: AnalyticsSignal[] = [];
  const before = new Map(previous.map((p) => [p.dimension, p.events]));

  for (const m of current) {
    const was = before.get(m.dimension) ?? 0;
    if (was < MIN_EVENTS_FOR_TREND) continue;
    const drop = (was - m.events) / was;
    if (drop >= USAGE_DROP_THRESHOLD) {
      signals.push({
        id: `analytics.module-drop.${m.dimension}`,
        severity: 'ATTENTION',
        module: 'product-analytics',
        action: 'Open product analytics',
        title: `${m.dimension} usage fell ${Math.round(drop * 100)}% this week`,
        detail: `${was} opens in the previous 7 days, ${m.events} in the last 7. Compared window to window; nothing is predicted.`,
      });
    }
  }

  // A module that existed last week and has no events at all this week.
  for (const [name, was] of before) {
    if (was < MIN_EVENTS_FOR_TREND) continue;
    if (current.some((c) => c.dimension === name)) continue;
    signals.push({
      id: `analytics.module-silent.${name}`,
      severity: 'WARNING',
      module: 'product-analytics',
      action: 'Open product analytics',
      title: `${name} has not been opened at all this week`,
      detail: `${was} opens in the previous 7 days and none since. Either nobody needs it, or something is stopping them.`,
    });
  }

  if (activeUsersBefore >= 5) {
    const drop = (activeUsersBefore - activeUsersNow) / activeUsersBefore;
    if (drop >= USAGE_DROP_THRESHOLD) {
      signals.push({
        id: 'analytics.wau-drop',
        severity: 'WARNING',
        module: 'platform-analytics',
        action: 'Open platform analytics',
        title: `Weekly active users fell ${Math.round(drop * 100)}%`,
        detail: `${activeUsersBefore} distinct users in the previous 7 days, ${activeUsersNow} in the last 7.`,
      });
    }
  }

  // Clubs that were using Familista and have stopped.
  const quietWindow = { environment, from: new Date(today.getTime() - CLUB_QUIET_DAYS * DAY), to: new Date(now.getTime() + 1000) };
  const longWindow = { environment, from: new Date(today.getTime() - 90 * DAY), to: quietWindow.from };
  const [recentClubs, formerClubs] = await Promise.all([
    store.byDimension(quietWindow, 'clubId', 500),
    store.byDimension(longWindow, 'clubId', 500),
  ]);
  const recent = new Set(recentClubs.map((c) => c.dimension));
  const quiet = formerClubs.filter((c) => !recent.has(c.dimension));
  if (quiet.length) {
    signals.push({
      id: 'analytics.clubs-quiet',
      severity: 'ATTENTION',
      module: 'clubs',
      action: 'Review clubs',
      title: `${quiet.length} club${quiet.length === 1 ? '' : 's'} inactive for ${CLUB_QUIET_DAYS}+ days`,
      detail: `${quiet.length} club${quiet.length === 1 ? ' was' : 's were'} active in the previous 90 days and ${quiet.length === 1 ? 'has' : 'have'} recorded nothing since.`,
    });
  }

  return signals;
}
