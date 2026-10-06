// Familista — what production monitoring measures, and where
// ─────────────────────────────────────────────────────────────────────────────
// For every registered algorithm (src/algorithms/registry.ts) this file says
// one of two things, and only what the code proves:
//
//   INSTRUMENTED       it runs in production, and each workflow it runs in is
//                      named here; every call site of it in the server is
//                      wrapped by the telemetry recorder (telemetry.ts)
//
//   NOT INSTRUMENTED   it does not run in production, and why — with the
//                      repository files the reason rests on
//
// tests/algorithms-monitoring.unit.test.ts re-proves both from the source on
// every pull request: a declared workflow with no wrapped call site fails it,
// a call site that is not wrapped fails it, and an algorithm declared "not in
// production" that gains a production caller fails it. Coverage here cannot be
// claimed, only shown.
//
// It also fixes WHAT is measured: each algorithm's output histogram bins and
// declared output contract, the latency bins, and the monitoring thresholds.
//
// THESE ARE MONITORING PARAMETERS, NOT ALGORITHM PARAMETERS. Nothing here is
// read by an algorithm, and changing a bin or a threshold changes what the
// Algorithms room reports — never what an algorithm computes. The bins follow
// each algorithm's own documented scale and break points so a shift is
// readable, but they are only ever used to count.

/** Monitoring windows and thresholds. Each one is shown in the room beside the result it produced. */
export const MONITORING = {
  /** Telemetry rows older than this are deleted. */
  retentionDays: 42,
  /** The window every current figure is read from. */
  recentDays: 7,
  /** The window before it that a distribution or a latency is compared with. */
  baselineDays: 28,
  /** Repeated failures are counted over this window. */
  failureWindowHours: 24,
  /** No production run for this long, after earlier runs, is a warning. */
  staleAfterDays: 7,
  /** Runs in the recent window before anything may read as Healthy. */
  minHealthySample: 20,
  /** Outputs needed in each window before two distributions are compared. */
  minDriftRecent: 50,
  minDriftBaseline: 100,
  /** Population stability index at or above which a distribution change is reported. */
  driftPsiWarn: 0.25,
  /** This many failures in the failure window, at this share of runs or more, is Failing. */
  repeatedFailures: 3,
  repeatedFailureRate: 0.05,
  /** Recent p95 latency at this multiple of the baseline p95, and above the floor, is a warning. */
  latencyRegressionRatio: 2,
  latencyRegressionFloorUs: 1000,
  minLatencySample: 50,
  /** How often each server process writes what it recorded. */
  flushIntervalSeconds: 60,
} as const;

/** Latency bins, in microseconds: [<10µs, <50µs, …, <5s, ≥5s]. */
export const LATENCY_EDGES_US: readonly number[] = [
  10, 50, 100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000,
];

// ── the workflows, as a closed list ──────────────────────────────────────────

export type SourceKind = 'REQUEST' | 'WORKER';

/**
 * Every production workflow an algorithm runs in. A telemetry row can only
 * ever carry one of these names: the recorder refuses anything else, and the
 * database refuses free text (migration 20261007100000).
 */
export const SOURCES = {
  'stats.aggregator': { kind: 'WORKER', entry: 'stats-aggregator worker · EventOutbox topic stats.aggregate', file: 'src/workers/stats-aggregator.worker.ts' },
  'stats.rebuild': { kind: 'REQUEST', entry: 'POST /api/v1/phase-q/stats/matches/:matchId/rebuild', file: 'src/controllers/phase-q.controller.ts' },
  'workload.gps-ingest': { kind: 'REQUEST', entry: 'POST /api/v1/phase-q/workload/gps', file: 'src/workload/workload-science.service.ts' },
  'workload.recompute': { kind: 'REQUEST', entry: 'POST /api/v1/phase-q/workload/players/:playerId/recompute', file: 'src/controllers/phase-q.controller.ts' },
  'matches.fusion-frame': { kind: 'REQUEST', entry: 'GET /api/v1/matches/:id/fusion', file: 'src/fusion/fusion.service.ts' },
  'intelligence.unified-player': { kind: 'REQUEST', entry: 'GET /api/v1/phase-q/transfer/intelligence/unified/:playerId', file: 'src/intelligence/unified.service.ts' },
  'intelligence.succession': { kind: 'REQUEST', entry: 'GET /api/v1/phase-q/transfer/intelligence/succession/:position', file: 'src/intelligence/succession.service.ts' },
  'league.manage-participants': { kind: 'REQUEST', entry: 'GET /api/v1/familista-league/manage', file: 'src/competition/familista-league.admin.service.ts' },
  'league.eligible-teams': { kind: 'REQUEST', entry: 'GET /api/v1/familista-league/manage/eligible-teams', file: 'src/competition/familista-league.admin.service.ts' },
  'league.add-participant': { kind: 'REQUEST', entry: 'POST /api/v1/familista-league/manage/participants', file: 'src/competition/familista-league.admin.service.ts' },
  'league.reschedule-fixture': { kind: 'REQUEST', entry: 'PATCH /api/v1/familista-league/manage/fixtures/:fixtureId', file: 'src/competition/familista-league.admin.service.ts' },
  'match-center.change-request': { kind: 'REQUEST', entry: 'POST /api/v1/match-center/fixtures/:fixtureId/change-requests', file: 'src/competition/match-center.service.ts' },
  'match-center.approve-change': { kind: 'REQUEST', entry: 'POST /api/v1/match-center/change-requests/:requestId/action', file: 'src/competition/match-center.service.ts' },
} as const satisfies Record<string, { kind: SourceKind; entry: string; file: string }>;

export type SourceName = keyof typeof SOURCES;

// ── outputs ───────────────────────────────────────────────────────────────────

/**
 * A numeric output: binned on `edges` (a value v falls in the first bin whose
 * upper edge is greater than v), and inside its contract when it is a finite
 * number between `min` and `max`.
 */
export interface NumericOutput {
  kind: 'NUMERIC';
  name: string;
  edges: readonly number[];
  /** One label per bin (edges.length + 1). Numbers only: shown untranslated. */
  labels: readonly string[];
  min: number;
  max: number | null;
}
/** A categorical output: one bin per category, in this order; anything else breaks the contract. */
export interface CategoricalOutput {
  kind: 'CATEGORICAL';
  name: string;
  categories: readonly string[];
}
export type OutputSpec = NumericOutput | CategoricalOutput;

export interface InstrumentedSpec {
  key: string;
  instrumented: true;
  sources: readonly SourceName[];
  output: OutputSpec;
  /** What the input-quality counts mean for this algorithm; null when it is not assessed. */
  quality: string | null;
  /** What the freshness counts mean; null when it is not assessed. */
  freshness: string | null;
}

export interface NotInstrumentedSpec {
  key: string;
  instrumented: false;
  /** Why it is not measured in production, in one or two sentences. */
  reason: string;
  /** The repository files the reason rests on (re-proven by the test). */
  evidence: readonly string[];
  /** The registered functions whose absence from production code is the proof. */
  entry: readonly string[];
}

export type MonitoringSpec = InstrumentedSpec | NotInstrumentedSpec;

const NOT_IN_PRODUCTION_EVIDENCE = [
  'src/match-events/xg-model.service.ts',
  'src/match-events/match-event.service.ts',
  'src/algorithms/scenarios.ts',
] as const;

export const MONITORING_SPECS: readonly MonitoringSpec[] = [
  // ── match analytics ──
  {
    key: 'xg', instrumented: false,
    reason: 'It does not run in production: no request, worker or job calls it. Expected-goals values arrive with each match event, from the client or a data provider, and are stored as they arrive. On this server only this room calls it: its evaluation and its synthetic learning, both on invented shots.',
    evidence: NOT_IN_PRODUCTION_EVIDENCE,
    entry: ['computeXG', 'annotateXG'],
  },
  {
    key: 'xgot', instrumented: false,
    reason: 'It does not run in production: no request, worker or job calls it. Expected-goals-on-target values arrive with each match event and are stored as they arrive. On this server only this room calls it: its evaluation and its synthetic learning, both on invented shots.',
    evidence: NOT_IN_PRODUCTION_EVIDENCE,
    entry: ['computeXGOT', 'annotateXG'],
  },
  {
    key: 'xa', instrumented: false,
    reason: 'It does not run in production: no request, worker or job calls it. Expected-assist values arrive with each match event and are stored as they arrive. Its only caller is this room’s own evaluation.',
    evidence: NOT_IN_PRODUCTION_EVIDENCE,
    entry: ['backfillXA'],
  },
  {
    key: 'match-rating', instrumented: true,
    sources: ['stats.aggregator', 'stats.rebuild'],
    output: {
      kind: 'NUMERIC', name: 'Match rating',
      edges: [5, 6, 6.5, 7, 7.5, 8, 9],
      labels: ['< 5', '5 – 6', '6 – 6.5', '6.5 – 7', '7 – 7.5', '7.5 – 8', '8 – 9', '≥ 9'],
      min: 1, max: 10,
    },
    quality: 'Empty when a rebuild found no player to rate; OK otherwise.',
    freshness: null,
  },
  // ── performance & workload ──
  {
    key: 'training-load', instrumented: true,
    sources: ['workload.gps-ingest', 'workload.recompute'],
    output: {
      kind: 'NUMERIC', name: 'Acute:chronic ratio (ACWR)',
      edges: [0.8, 1.3, 1.5, 2],
      labels: ['< 0.8', '0.8 – 1.3', '1.3 – 1.5', '1.5 – 2', '≥ 2'],
      min: 0, max: null,
    },
    quality: 'Empty when the player had no session load in the last 28 days; OK otherwise.',
    freshness: 'After a GPS session is stored: fresh when the session started within 48 hours, stale when earlier. Not assessed on a manual recompute.',
  },
  {
    key: 'biomechanical-load', instrumented: true,
    sources: ['matches.fusion-frame'],
    output: {
      kind: 'NUMERIC', name: 'Load index (BLI)',
      edges: [-1, -0.25, 0.25, 1, 2],
      labels: ['< −1', '−1 – −0.25', '−0.25 – 0.25', '0.25 – 1', '1 – 2', '≥ 2'],
      min: -3, max: 3,
    },
    quality: 'OK when IMU, GPS and heart-rate data were all in the window; partial when only some were; empty when none were.',
    freshness: null,
  },
  {
    key: 'tactical-attrition', instrumented: true,
    sources: ['matches.fusion-frame'],
    output: {
      kind: 'NUMERIC', name: 'Attrition index (TAI)',
      edges: [0.2, 0.4, 0.6, 0.8],
      labels: ['0 – 0.2', '0.2 – 0.4', '0.4 – 0.6', '0.6 – 0.8', '0.8 – 1'],
      min: 0, max: 1,
    },
    quality: 'OK when the biochemical patch, the GPS track and timeline events were all available; partial when some fell back to defaults; empty when all did.',
    freshness: null,
  },
  // ── player intelligence ──
  {
    key: 'data-confidence', instrumented: true,
    sources: ['intelligence.unified-player'],
    output: { kind: 'CATEGORICAL', name: 'Confidence', categories: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
    quality: null,
    freshness: null,
  },
  {
    key: 'medical-risk', instrumented: true,
    sources: ['intelligence.unified-player'],
    output: {
      kind: 'NUMERIC', name: 'Risk score',
      edges: [1, 25, 50, 75],
      labels: ['0', '1 – 24', '25 – 49', '50 – 74', '75 – 100'],
      min: 0, max: 100,
    },
    quality: 'Partial when no workload ratio was available, so the load component was not assessed; OK otherwise.',
    freshness: null,
  },
  {
    key: 'form-trend', instrumented: false,
    reason: 'It does not run in production: no request, worker or job calls it. Its only caller is this room’s own evaluation.',
    evidence: ['src/intelligence/shared.utils.ts', 'src/algorithms/scenarios.ts'],
    entry: ['trendDirection'],
  },
  {
    key: 'age-curve', instrumented: true,
    sources: ['intelligence.succession'],
    output: {
      kind: 'NUMERIC', name: 'Value multiplier',
      edges: [0.5005, 0.9995],
      labels: ['0.5', '0.5 – 1', '1'],
      min: 0.5, max: 1,
    },
    quality: 'Partial when the player has no date of birth and the curve was read at the default age of 25; OK otherwise.',
    freshness: null,
  },
  // ── competition rules ──
  {
    key: 'league-eligibility', instrumented: true,
    sources: ['league.manage-participants', 'league.eligible-teams', 'league.add-participant'],
    output: { kind: 'CATEGORICAL', name: 'Verdict', categories: ['OK', 'NOT_FIRST_TEAM', 'INACTIVE'] },
    quality: null,
    freshness: null,
  },
  {
    key: 'kickoff-window', instrumented: true,
    sources: ['match-center.change-request', 'match-center.approve-change', 'league.reschedule-fixture'],
    output: {
      kind: 'CATEGORICAL', name: 'Verdict',
      categories: ['OK', 'UNCHANGED', 'IN_THE_PAST', 'BEFORE_EARLIEST', 'AFTER_LATEST', 'MALFORMED'],
    },
    quality: 'Partial when the venue’s time zone was unknown and the kickoff was judged in UTC; empty when the proposed kickoff was not a date; OK otherwise.',
    freshness: null,
  },
];

export type InstrumentedKey =
  | 'match-rating' | 'training-load' | 'biomechanical-load' | 'tactical-attrition'
  | 'data-confidence' | 'medical-risk' | 'age-curve' | 'league-eligibility' | 'kickoff-window';

const BY_KEY = new Map(MONITORING_SPECS.map((s) => [s.key, s]));

export function monitoringSpecOf(key: string): MonitoringSpec | null {
  return BY_KEY.get(key) ?? null;
}

export function instrumentedSpecOf(key: string): InstrumentedSpec | null {
  const s = BY_KEY.get(key);
  return s && s.instrumented ? s : null;
}

/** How many output bins an algorithm has. */
export function binCount(output: OutputSpec): number {
  return output.kind === 'NUMERIC' ? output.edges.length + 1 : output.categories.length;
}

/**
 * Where one output value goes: `{ bin, ok }`. `bin` is null for a value that
 * has no place in the histogram (NaN, an unknown category); `ok` says whether
 * it kept the declared contract.
 */
export function classifyOutput(output: OutputSpec, v: number | string): { bin: number | null; ok: boolean } {
  if (output.kind === 'CATEGORICAL') {
    const i = typeof v === 'string' ? output.categories.indexOf(v) : -1;
    return { bin: i >= 0 ? i : null, ok: i >= 0 };
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { bin: null, ok: false };
  let bin = 0;
  while (bin < output.edges.length && v >= output.edges[bin]) bin += 1;
  const ok = v >= output.min - 1e-9 && (output.max === null || v <= output.max + 1e-9);
  return { bin, ok };
}

/** Which latency bin a duration in microseconds falls in. */
export function latencyBinOf(us: number): number {
  let bin = 0;
  while (bin < LATENCY_EDGES_US.length && us >= LATENCY_EDGES_US[bin]) bin += 1;
  return bin;
}
