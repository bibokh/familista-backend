// How long analytics is kept — configurable, and never "forever"
// ─────────────────────────────────────────────────────────────────────────────
// Two tiers, two lifetimes, and the split is the point.
//
//   RAW EVENTS   the detail: which session, which module, which minute. Useful
//                for a few months and a growing privacy liability after that,
//                so it expires.
//   DAILY ROLLUPS the history: how many people, how much use, which trend.
//                Small, non-identifying at the row level, and worth keeping for
//                years — a year-on-year comparison is impossible without it.
//
// Both are configurable, because a retention period is a governance decision
// that belongs to whoever runs the platform and to the jurisdictions they
// operate in — not to whoever wrote the sweep.

export interface AnalyticsRetention {
  rawDays: number;
  rollupDays: number;
  /** Where each number came from, so the SYSTEM screen can say. */
  source: { raw: 'env' | 'default'; rollup: 'env' | 'default' };
}

export const DEFAULT_RAW_RETENTION_DAYS = 90;
export const DEFAULT_ROLLUP_RETENTION_DAYS = 1095;   // three years of history

const positive = (v: string | undefined, min: number, max: number): number | null => {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(Math.round(n), max));
};

export function analyticsRetention(env: NodeJS.ProcessEnv = process.env): AnalyticsRetention {
  const raw = positive(env.ANALYTICS_RAW_RETENTION_DAYS, 1, 3650);
  const rollup = positive(env.ANALYTICS_ROLLUP_RETENTION_DAYS, 30, 3650);
  return {
    rawDays: raw ?? DEFAULT_RAW_RETENTION_DAYS,
    rollupDays: rollup ?? DEFAULT_ROLLUP_RETENTION_DAYS,
    source: { raw: raw == null ? 'default' : 'env', rollup: rollup == null ? 'default' : 'env' },
  };
}

/**
 * The cutoffs, as dates.
 *
 * Rollups are always kept at least as long as raw events. A configuration that
 * said otherwise would delete the summary of data it still holds in detail,
 * which is not a policy anybody means.
 */
export function retentionCutoffs(now = new Date(), env: NodeJS.ProcessEnv = process.env) {
  const policy = analyticsRetention(env);
  const rollupDays = Math.max(policy.rollupDays, policy.rawDays);
  return {
    policy,
    raw: new Date(now.getTime() - policy.rawDays * 86400000),
    rollup: new Date(now.getTime() - rollupDays * 86400000),
  };
}
