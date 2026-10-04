// Familista — production monitoring of the registered algorithms
// ─────────────────────────────────────────────────────────────────────────────
// Composes what the Algorithms room's Monitoring shows from four pieces of
// evidence, and nothing else:
//
//   the telemetry        how each algorithm ran in production (telemetry-store
//                        .ts), plus what this process recorded and has not
//                        written yet (telemetry.ts)
//   the runtime code     which code this process actually loaded
//                        (runtime-fingerprint.ts)
//   the evaluation       Step 1's synthetic scenarios, run in this process
//   the coverage         which algorithms run in production at all
//                        (monitoring-spec.ts)
//
// FIVE STATES, AND ONLY WHAT WAS MEASURED
//
//   Failing           something is proven wrong: the running code is not the
//                     approved code, its evaluation fails, an output broke its
//                     contract, or it failed repeatedly
//   Warning           evidence worth a person's look: a failure, no run for a
//                     week, a distribution or latency shift, unproven code
//   Not enough data   instrumented, but too few runs to call it anything
//   Not instrumented  it does not run in production, and that is said
//   Healthy           instrumented, enough runs in the window, every check
//                     passing — never granted on missing evidence
//
// EVIDENCE ONLY. A finding changes nothing: no algorithm is retrained, tuned,
// rolled back or switched off by anything here. It is shown to the platform
// owner, who decides — through the same reviewed, human-approved change path
// as Step 1.
//
// The English here is the interface's own copy; public/algorithms/i18n
// translates it.

import { ALGORITHMS, algorithmOf, type AlgorithmDecl } from './registry';
import {
  MONITORING, LATENCY_EDGES_US, SOURCES, MONITORING_SPECS, monitoringSpecOf, binCount,
  type MonitoringSpec, type SourceName,
} from './monitoring-spec';
import { peekPending, failureKindOf, type TelemetryEntry } from './telemetry';
import {
  readTelemetryAggregates, settledFlush, storeStatus, windowsAt, emptySums,
  type GroupAggregate, type DayAggregate, type TelemetryAggregates, type WindowSums, type StoreStatus,
} from './telemetry-store';
import { runtimeFingerprints, type RuntimeFingerprint, type RuntimeBasis, type RuntimeVerdict } from './runtime-fingerprint';
import { evaluationsNow } from './algorithms.service';
import { logger } from '../utils/logger';

export type MonitoringState = 'HEALTHY' | 'WARNING' | 'FAILING' | 'NOT_INSTRUMENTED' | 'NOT_ENOUGH_DATA';
export const MONITORING_STATES: readonly MonitoringState[] = ['HEALTHY', 'WARNING', 'FAILING', 'NOT_ENOUGH_DATA', 'NOT_INSTRUMENTED'];

export type FindingId =
  | 'FINGERPRINT_MISMATCH' | 'FINGERPRINT_UNVERIFIED' | 'EVALUATION_FAILED' | 'CONTRACT_VIOLATIONS'
  | 'REPEATED_FAILURES' | 'FAILURES' | 'STALE' | 'NO_EXECUTIONS' | 'DISTRIBUTION_SHIFT' | 'LATENCY_REGRESSION';
export type Severity = 'FAILING' | 'WARNING' | 'INFO';

export type CheckState = 'PASS' | 'WARN' | 'FAIL' | 'NOT_ENOUGH_DATA' | 'NOT_APPLICABLE';
export type CheckId = 'runtime-code' | 'evaluation' | 'output-contract' | 'failures' | 'activity' | 'distribution' | 'latency';

export interface MonitoringCheck {
  id: CheckId;
  /** What is checked, in a sentence a reviewer can read. */
  label: string;
  state: CheckState;
  /** Numbers, symbols and tokens only — shown untranslated. */
  observed: string;
  required: string;
}

export interface Finding { id: FindingId; severity: Severity }

/** What each check verifies — the room translates these. */
export const CHECK_LABEL: Readonly<Record<CheckId, string>> = {
  'runtime-code': 'The running code is the approved code',
  evaluation: 'Its synthetic evaluation passes in this server',
  'output-contract': 'Every production output kept its declared contract',
  failures: 'No repeated failures in the last 24 hours',
  activity: 'Ran in production within the last 7 days',
  distribution: 'Its output distribution is stable against its baseline',
  latency: 'Its latency is stable against its baseline',
};

// ── aggregation: stored rows plus this process's unwritten minute ────────────

const addSums = (into: WindowSums, from: WindowSums): void => {
  into.executions += from.executions; into.failures += from.failures;
  into.outputs += from.outputs; into.outOfContract += from.outOfContract;
  into.latencySumUs += from.latencySumUs; into.latencyMaxUs = Math.max(into.latencyMaxUs, from.latencyMaxUs);
  into.qualityOk += from.qualityOk; into.qualityPartial += from.qualityPartial; into.qualityEmpty += from.qualityEmpty;
  into.freshnessFresh += from.freshnessFresh; into.freshnessStale += from.freshnessStale;
  const n = Math.max(into.latencyBins.length, from.latencyBins.length);
  for (let i = 0; i < n; i++) into.latencyBins[i] = (into.latencyBins[i] ?? 0) + (from.latencyBins[i] ?? 0);
  const m = Math.max(into.outputBins.length, from.outputBins.length);
  for (let i = 0; i < m; i++) into.outputBins[i] = (into.outputBins[i] ?? 0) + (from.outputBins[i] ?? 0);
};

const sumsOfEntry = (e: TelemetryEntry): WindowSums => ({
  executions: e.executions, failures: e.failures, outputs: e.outputs, outOfContract: e.outOfContract,
  latencySumUs: e.latencySumUs, latencyMaxUs: e.latencyMaxUs,
  qualityOk: e.qualityOk, qualityPartial: e.qualityPartial, qualityEmpty: e.qualityEmpty,
  freshnessFresh: e.freshnessFresh, freshnessStale: e.freshnessStale,
  latencyBins: [...e.latencyBins], outputBins: [...e.outputBins],
});

/** Hourly entries — this process's unwritten ones — folded into the same shape the store returns. */
export function aggregateEntries(entries: readonly TelemetryEntry[], now: number): TelemetryAggregates {
  const w = windowsAt(now);
  const groups = new Map<string, GroupAggregate>();
  const days = new Map<string, DayAggregate>();
  for (const e of entries) {
    if (e.bucketStart < w.retained) continue;
    const id = `${e.key}|${e.version}|${e.fingerprint}|${e.source}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        key: e.key, version: e.version, fingerprint: e.fingerprint, source: e.source,
        last24h: { executions: 0, failures: 0 }, recent: emptySums(), baseline: emptySums(),
        retained: { executions: 0, failures: 0 },
        firstAt: null, lastAt: null, lastFailureAt: null, lastFailureKind: null,
      };
      groups.set(id, g);
    }
    g.retained.executions += e.executions; g.retained.failures += e.failures;
    if (e.bucketStart >= w.last24h) { g.last24h.executions += e.executions; g.last24h.failures += e.failures; }
    if (e.bucketStart >= w.recent) addSums(g.recent, sumsOfEntry(e));
    else if (e.bucketStart >= w.baseline) addSums(g.baseline, sumsOfEntry(e));
    g.firstAt = g.firstAt === null ? e.firstAt : Math.min(g.firstAt, e.firstAt);
    g.lastAt = g.lastAt === null ? e.lastAt : Math.max(g.lastAt, e.lastAt);
    if (e.lastFailureAt !== null && (g.lastFailureAt === null || e.lastFailureAt >= g.lastFailureAt)) {
      g.lastFailureAt = e.lastFailureAt; g.lastFailureKind = e.lastFailureKind;
    }
    if (e.bucketStart >= w.dailyFrom) {
      const day = new Date(e.bucketStart).toISOString().slice(0, 10);
      const dk = `${e.key}|${day}`;
      const d = days.get(dk) ?? { key: e.key, day, executions: 0, failures: 0 };
      d.executions += e.executions; d.failures += e.failures;
      days.set(dk, d);
    }
  }
  return { groups: [...groups.values()], daily: [...days.values()] };
}

/** Two aggregates of the same windows, added together. */
export function combineAggregates(a: TelemetryAggregates, b: TelemetryAggregates): TelemetryAggregates {
  const groups = new Map<string, GroupAggregate>();
  const clone = (g: GroupAggregate): GroupAggregate => ({
    ...g, last24h: { ...g.last24h }, retained: { ...g.retained },
    recent: { ...g.recent, latencyBins: [...g.recent.latencyBins], outputBins: [...g.recent.outputBins] },
    baseline: { ...g.baseline, latencyBins: [...g.baseline.latencyBins], outputBins: [...g.baseline.outputBins] },
  });
  for (const g of [...a.groups, ...b.groups]) {
    const id = `${g.key}|${g.version}|${g.fingerprint}|${g.source}`;
    const there = groups.get(id);
    if (!there) { groups.set(id, clone(g)); continue; }
    there.last24h.executions += g.last24h.executions; there.last24h.failures += g.last24h.failures;
    there.retained.executions += g.retained.executions; there.retained.failures += g.retained.failures;
    addSums(there.recent, g.recent); addSums(there.baseline, g.baseline);
    there.firstAt = there.firstAt === null ? g.firstAt : g.firstAt === null ? there.firstAt : Math.min(there.firstAt, g.firstAt);
    there.lastAt = there.lastAt === null ? g.lastAt : g.lastAt === null ? there.lastAt : Math.max(there.lastAt, g.lastAt);
    if (g.lastFailureAt !== null && (there.lastFailureAt === null || g.lastFailureAt >= there.lastFailureAt)) {
      there.lastFailureAt = g.lastFailureAt; there.lastFailureKind = g.lastFailureKind;
    }
  }
  const days = new Map<string, DayAggregate>();
  for (const d of [...a.daily, ...b.daily]) {
    const id = `${d.key}|${d.day}`;
    const there = days.get(id);
    if (there) { there.executions += d.executions; there.failures += d.failures; } else days.set(id, { ...d });
  }
  return { groups: [...groups.values()], daily: [...days.values()] };
}

// ── measures ─────────────────────────────────────────────────────────────────

const total = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0);

/**
 * Population stability index between two histograms over the same bins. Each
 * share is floored at 0.0001 so an empty bin is a large term, not an infinity.
 */
export function populationStability(recent: readonly number[], baseline: readonly number[]): number | null {
  const rt = total(recent), bt = total(baseline);
  if (!rt || !bt) return null;
  const n = Math.max(recent.length, baseline.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max((recent[i] ?? 0) / rt, 1e-4);
    const q = Math.max((baseline[i] ?? 0) / bt, 1e-4);
    s += (p - q) * Math.log(p / q);
  }
  return +s.toFixed(4);
}

/**
 * The latency at or below which a share q of runs finished, read from the
 * histogram: the upper edge of the bin the q-th run fell in (the slowest run
 * for the open-ended last bin). An upper bound, and said to be one.
 */
export function latencyAtMost(bins: readonly number[], q: number, maxUs: number): number | null {
  const n = total(bins);
  if (!n) return null;
  const target = Math.max(1, Math.ceil(q * n));
  // The slowest run recorded is itself an upper bound; a run that rounded to
  // 0µs still took some time, so the bound never reads below 1µs.
  const ceiling = Math.max(maxUs, 1);
  let cum = 0;
  for (let i = 0; i < bins.length; i++) {
    cum += bins[i] ?? 0;
    if (cum >= target) return i < LATENCY_EDGES_US.length ? Math.min(LATENCY_EDGES_US[i], ceiling) : ceiling;
  }
  return ceiling;
}

export interface LatencyView { samples: number; meanUs: number | null; p50AtMostUs: number | null; p95AtMostUs: number | null; maxUs: number | null; bins: number[] }

function latencyView(s: WindowSums, withMax: boolean): LatencyView | null {
  const samples = total(s.latencyBins);
  if (!samples) return null;
  return {
    samples,
    meanUs: s.executions ? Math.round(s.latencySumUs / s.executions) : null,
    p50AtMostUs: latencyAtMost(s.latencyBins, 0.5, s.latencyMaxUs),
    p95AtMostUs: latencyAtMost(s.latencyBins, 0.95, s.latencyMaxUs),
    maxUs: withMax ? s.latencyMaxUs : null,
    bins: [...s.latencyBins],
  };
}

const isoOrNull = (msv: number | null) => (msv === null ? null : new Date(msv).toISOString());
const fmtUs = (us: number | null) => (us === null ? '—' : us >= 1_000_000 ? `${+(us / 1_000_000).toFixed(2)}s` : us >= 1000 ? `${+(us / 1000).toFixed(1)}ms` : `${us}µs`);

// ── one algorithm ─────────────────────────────────────────────────────────────

export interface MonitoringSummary {
  key: string;
  name: string;
  domain: string;
  version: string;
  state: MonitoringState;
  instrumented: boolean;
  workflows: number;
  executions24h: number;
  failures24h: number;
  executions7d: number;
  failures7d: number;
  lastExecutionAt: string | null;
  p95AtMostUs: number | null;
  runtimeCode: RuntimeVerdict;
  evaluation: 'PASS' | 'FAIL' | 'NOT_SIMULATED';
  findings: FindingId[];
}

export interface AlgorithmMonitoringDetail extends MonitoringSummary {
  /** READY, or STORE_UNAVAILABLE when only this server's unwritten runs could be read. */
  storeState: 'READY' | 'STORE_UNAVAILABLE';
  coverage: {
    reason: string | null;
    evidence: string[];
    paths: Array<{ source: string; kind: 'REQUEST' | 'WORKER'; entry: string; file: string }>;
  };
  fingerprint: {
    basis: RuntimeBasis; file: string; approved: string | null; runtime: string | null;
    source: string | null; verdict: RuntimeVerdict; reason: string; computedAt: string;
  };
  counts: {
    last24h: { executions: number; failures: number };
    recent: { executions: number; failures: number; outputs: number; outOfContract: number };
    baseline: { executions: number; failures: number; outputs: number; outOfContract: number };
    retained: { executions: number; failures: number };
  };
  firstSeenAt: string | null;
  lastFailureAt: string | null;
  lastFailureKind: string | null;
  latency: { edgesUs: number[]; recent: LatencyView | null; baseline: LatencyView | null };
  distribution: {
    name: string; kind: 'NUMERIC' | 'CATEGORICAL'; labels: string[];
    recent: number[]; baseline: number[]; psi: number | null;
  } | null;
  quality: { describes: string; ok: number; partial: number; empty: number; notAssessed: number } | null;
  freshness: { describes: string; fresh: number; stale: number; notAssessed: number } | null;
  bySource: Array<{ source: string; kind: 'REQUEST' | 'WORKER'; entry: string; executions7d: number; failures7d: number; lastAt: string | null }>;
  fingerprintsSeen: Array<{ fingerprint: string; version: string; executions: number; lastAt: string | null; current: boolean; approved: boolean }>;
  daily: Array<{ day: string; executions: number; failures: number }>;
  checks: MonitoringCheck[];
  findingList: Finding[];
}

interface Context {
  now: number;
  agg: TelemetryAggregates;
  storeOk: boolean;
  runtime: Map<string, RuntimeFingerprint>;
  runtimeAt: string;
  evaluation: Record<string, { state: 'PASS' | 'FAIL' | 'NOT_SIMULATED'; passed: number; total: number }>;
}

function composeOne(decl: AlgorithmDecl, spec: MonitoringSpec, ctx: Context): AlgorithmMonitoringDetail {
  const rf = ctx.runtime.get(decl.key)!;
  const ev = ctx.evaluation[decl.key] ?? { state: 'NOT_SIMULATED' as const, passed: 0, total: 0 };
  const mine = ctx.agg.groups.filter((g) => g.key === decl.key);
  const current = mine.filter((g) => g.version === decl.version);

  const last24h = { executions: 0, failures: 0 };
  const retained = { executions: 0, failures: 0 };
  const recent = emptySums(), baseline = emptySums();
  let firstAt: number | null = null, lastAt: number | null = null, lastFailureAt: number | null = null;
  let lastFailureKind: string | null = null;
  for (const g of mine) {
    last24h.executions += g.last24h.executions; last24h.failures += g.last24h.failures;
    retained.executions += g.retained.executions; retained.failures += g.retained.failures;
    addSums(recent, g.recent); addSums(baseline, g.baseline);
    if (g.firstAt !== null) firstAt = firstAt === null ? g.firstAt : Math.min(firstAt, g.firstAt);
    if (g.lastAt !== null) lastAt = lastAt === null ? g.lastAt : Math.max(lastAt, g.lastAt);
    if (g.lastFailureAt !== null && (lastFailureAt === null || g.lastFailureAt >= lastFailureAt)) {
      lastFailureAt = g.lastFailureAt; lastFailureKind = g.lastFailureKind;
    }
  }
  // Distributions are compared within the version the registry names now: a
  // new version may bin differently, and its first week is not drift.
  const recentNow = emptySums(), baselineNow = emptySums();
  for (const g of current) { addSums(recentNow, g.recent); addSums(baselineNow, g.baseline); }

  const checks: MonitoringCheck[] = [];
  const findings: Finding[] = [];
  const find = (id: FindingId, severity: Severity) => findings.push({ id, severity });

  // 1 — the code that is running
  {
    const state: CheckState = rf.verdict === 'MATCH' ? 'PASS' : rf.verdict === 'MISMATCH' ? 'FAIL' : 'WARN';
    checks.push({ id: 'runtime-code', label: CHECK_LABEL['runtime-code'], state,
      observed: rf.verdict === 'MATCH' ? 'MATCH' : `${rf.verdict} · ${rf.reason}`, required: 'MATCH' });
    if (rf.verdict === 'MISMATCH') find('FINGERPRINT_MISMATCH', 'FAILING');
    if (rf.verdict === 'UNVERIFIED') find('FINGERPRINT_UNVERIFIED', 'WARNING');
  }
  // 2 — its own evaluation, in this process
  {
    const state: CheckState = ev.state === 'PASS' ? 'PASS' : ev.state === 'FAIL' ? 'FAIL' : 'NOT_APPLICABLE';
    checks.push({ id: 'evaluation', label: CHECK_LABEL.evaluation, state,
      observed: ev.state === 'NOT_SIMULATED' ? 'NOT_SIMULATED' : `${ev.passed}/${ev.total}`,
      required: ev.state === 'NOT_SIMULATED' ? '—' : `${ev.total}/${ev.total}` });
    if (ev.state === 'FAIL') find('EVALUATION_FAILED', 'FAILING');
  }

  const instrumented = spec.instrumented;
  if (instrumented) {
    // 3 — the output contract, on every production output of the window
    {
      const state: CheckState = recent.outputs === 0 ? 'NOT_ENOUGH_DATA' : recent.outOfContract > 0 ? 'FAIL' : 'PASS';
      checks.push({ id: 'output-contract', label: CHECK_LABEL['output-contract'], state,
        observed: `${recent.outOfContract}/${recent.outputs}`, required: `0/${recent.outputs}` });
      if (recent.outOfContract > 0) find('CONTRACT_VIOLATIONS', 'FAILING');
    }
    // 4 — failures
    {
      const repeated = last24h.failures >= MONITORING.repeatedFailures
        && last24h.failures / Math.max(1, last24h.executions) >= MONITORING.repeatedFailureRate;
      const state: CheckState = repeated ? 'FAIL' : recent.failures > 0 ? 'WARN' : recent.executions === 0 ? 'NOT_ENOUGH_DATA' : 'PASS';
      checks.push({ id: 'failures', label: CHECK_LABEL.failures, state,
        observed: `${last24h.failures}/${last24h.executions}`, required: `< ${MONITORING.repeatedFailures}` });
      if (repeated) find('REPEATED_FAILURES', 'FAILING');
      else if (recent.failures > 0) find('FAILURES', 'WARNING');
    }
    // 5 — activity
    {
      const staleMs = MONITORING.staleAfterDays * 86_400_000;
      const state: CheckState = lastAt === null ? 'NOT_ENOUGH_DATA' : ctx.now - lastAt > staleMs ? 'WARN' : 'PASS';
      checks.push({ id: 'activity', label: CHECK_LABEL.activity, state,
        observed: lastAt === null ? '—' : new Date(lastAt).toISOString().slice(0, 16).replace('T', ' '),
        required: `≤ ${MONITORING.staleAfterDays * 24} h` });
      if (lastAt === null) find('NO_EXECUTIONS', 'INFO');
      else if (ctx.now - lastAt > staleMs) find('STALE', 'WARNING');
    }
    // 6 — distribution against its baseline
    {
      const r = total(recentNow.outputBins), b = total(baselineNow.outputBins);
      const enough = r >= MONITORING.minDriftRecent && b >= MONITORING.minDriftBaseline;
      const psi = enough ? populationStability(recentNow.outputBins, baselineNow.outputBins) : null;
      const state: CheckState = !enough || psi === null ? 'NOT_ENOUGH_DATA' : psi >= MONITORING.driftPsiWarn ? 'WARN' : 'PASS';
      checks.push({ id: 'distribution', label: CHECK_LABEL.distribution, state,
        observed: enough && psi !== null ? `PSI ${psi}` : `${r}/${MONITORING.minDriftRecent} · ${b}/${MONITORING.minDriftBaseline}`,
        required: enough ? `< ${MONITORING.driftPsiWarn}` : `≥ ${MONITORING.minDriftRecent} · ≥ ${MONITORING.minDriftBaseline}` });
      if (state === 'WARN') find('DISTRIBUTION_SHIFT', 'WARNING');
    }
    // 7 — latency against its baseline
    {
      const rv = latencyView(recentNow, true), bv = latencyView(baselineNow, false);
      const enough = !!rv && !!bv && rv.samples >= MONITORING.minLatencySample && bv.samples >= MONITORING.minLatencySample;
      const regressed = enough && rv!.p95AtMostUs !== null && bv!.p95AtMostUs !== null
        && rv!.p95AtMostUs >= MONITORING.latencyRegressionFloorUs
        && rv!.p95AtMostUs >= MONITORING.latencyRegressionRatio * bv!.p95AtMostUs;
      const state: CheckState = !enough ? 'NOT_ENOUGH_DATA' : regressed ? 'WARN' : 'PASS';
      checks.push({ id: 'latency', label: CHECK_LABEL.latency, state,
        observed: enough ? `p95 ≤${fmtUs(rv!.p95AtMostUs)} / ≤${fmtUs(bv!.p95AtMostUs)}` : `${rv?.samples ?? 0}/${MONITORING.minLatencySample} · ${bv?.samples ?? 0}/${MONITORING.minLatencySample}`,
        required: enough ? `< ${MONITORING.latencyRegressionRatio}×` : `≥ ${MONITORING.minLatencySample} · ≥ ${MONITORING.minLatencySample}` });
      if (regressed) find('LATENCY_REGRESSION', 'WARNING');
    }
  }

  // The state, from the checks — the worst one decides, and nothing measured
  // too thinly is ever Healthy.
  let state: MonitoringState;
  const anyFail = checks.some((c) => c.state === 'FAIL');
  const anyWarn = checks.some((c) => c.state === 'WARN');
  if (anyFail) state = 'FAILING';
  else if (!instrumented) state = 'NOT_INSTRUMENTED';
  else if (anyWarn) state = 'WARNING';
  else if (!ctx.storeOk || recent.executions < MONITORING.minHealthySample) state = 'NOT_ENOUGH_DATA';
  else state = 'HEALTHY';

  const runtimeCode = rf.verdict;
  const paths = spec.instrumented
    ? spec.sources.map((s: SourceName) => ({ source: s, kind: SOURCES[s].kind, entry: SOURCES[s].entry, file: SOURCES[s].file }))
    : [];

  const bySource = spec.instrumented ? spec.sources.map((s: SourceName) => {
    const gs = mine.filter((g) => g.source === s);
    const lastSrc = gs.reduce<number | null>((m, g) => (g.lastAt === null ? m : m === null ? g.lastAt : Math.max(m, g.lastAt)), null);
    return {
      source: s, kind: SOURCES[s].kind, entry: SOURCES[s].entry,
      executions7d: gs.reduce((n, g) => n + g.recent.executions, 0),
      failures7d: gs.reduce((n, g) => n + g.recent.failures, 0),
      lastAt: isoOrNull(lastSrc),
    };
  }) : [];

  const fps = new Map<string, { fingerprint: string; version: string; executions: number; lastAt: number | null }>();
  for (const g of mine) {
    const id = `${g.version}|${g.fingerprint}`;
    const f = fps.get(id) ?? { fingerprint: g.fingerprint, version: g.version, executions: 0, lastAt: null };
    f.executions += g.retained.executions;
    if (g.lastAt !== null) f.lastAt = f.lastAt === null ? g.lastAt : Math.max(f.lastAt, g.lastAt);
    fps.set(id, f);
  }
  const currentFp = rf.source ?? rf.runtime ?? 'unavailable';
  const fingerprintsSeen = [...fps.values()]
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    .map((f) => ({
      fingerprint: f.fingerprint, version: f.version, executions: f.executions, lastAt: isoOrNull(f.lastAt),
      current: f.fingerprint === currentFp && f.version === decl.version,
      approved: !!decl.approval && f.fingerprint === decl.approval.fingerprint && f.version === decl.approval.version,
    }));

  const dayKeys: string[] = [];
  const w = windowsAt(ctx.now);
  for (let d = 0; d < 14; d++) dayKeys.push(new Date(w.dailyFrom + d * 86_400_000).toISOString().slice(0, 10));
  const daily = dayKeys.map((day) => {
    const ds = ctx.agg.daily.filter((x) => x.key === decl.key && x.day === day);
    return { day, executions: ds.reduce((n, x) => n + x.executions, 0), failures: ds.reduce((n, x) => n + x.failures, 0) };
  });

  const out = spec.instrumented ? spec.output : null;
  const bins = out ? binCount(out) : 0;
  const pad = (xs: number[]) => Array.from({ length: bins }, (_, i) => xs[i] ?? 0);
  const distribution = out ? {
    name: out.name, kind: out.kind,
    labels: out.kind === 'NUMERIC' ? [...out.labels] : [...out.categories],
    recent: pad(recentNow.outputBins), baseline: pad(baselineNow.outputBins),
    psi: (() => {
      const r = total(recentNow.outputBins), b = total(baselineNow.outputBins);
      return r >= MONITORING.minDriftRecent && b >= MONITORING.minDriftBaseline ? populationStability(recentNow.outputBins, baselineNow.outputBins) : null;
    })(),
  } : null;

  const assessedQuality = recent.qualityOk + recent.qualityPartial + recent.qualityEmpty;
  const assessedFresh = recent.freshnessFresh + recent.freshnessStale;
  const okRuns = Math.max(0, recent.executions - recent.failures);

  const summary: MonitoringSummary = {
    key: decl.key, name: decl.name, domain: decl.domain, version: decl.version,
    state, instrumented, workflows: paths.length,
    executions24h: last24h.executions, failures24h: last24h.failures,
    executions7d: recent.executions, failures7d: recent.failures,
    lastExecutionAt: isoOrNull(lastAt),
    p95AtMostUs: latencyView(recent, false)?.p95AtMostUs ?? null,
    runtimeCode,
    evaluation: ev.state,
    findings: findings.map((f) => f.id),
  };

  return {
    ...summary,
    storeState: ctx.storeOk ? 'READY' : 'STORE_UNAVAILABLE',
    coverage: {
      reason: spec.instrumented ? null : spec.reason,
      evidence: spec.instrumented ? [] : [...spec.evidence],
      paths,
    },
    fingerprint: {
      basis: rf.basis, file: rf.file, approved: rf.approved, runtime: rf.runtime, source: rf.source,
      verdict: rf.verdict, reason: rf.reason, computedAt: ctx.runtimeAt,
    },
    counts: {
      last24h,
      recent: { executions: recent.executions, failures: recent.failures, outputs: recent.outputs, outOfContract: recent.outOfContract },
      baseline: { executions: baseline.executions, failures: baseline.failures, outputs: baseline.outputs, outOfContract: baseline.outOfContract },
      retained,
    },
    firstSeenAt: isoOrNull(firstAt),
    lastFailureAt: isoOrNull(lastFailureAt),
    lastFailureKind,
    latency: { edgesUs: [...LATENCY_EDGES_US], recent: latencyView(recent, true), baseline: latencyView(baseline, false) },
    distribution,
    quality: spec.instrumented && spec.quality
      ? { describes: spec.quality, ok: recent.qualityOk, partial: recent.qualityPartial, empty: recent.qualityEmpty, notAssessed: Math.max(0, okRuns - assessedQuality) }
      : null,
    freshness: spec.instrumented && spec.freshness
      ? { describes: spec.freshness, fresh: recent.freshnessFresh, stale: recent.freshnessStale, notAssessed: Math.max(0, okRuns - assessedFresh) }
      : null,
    bySource,
    fingerprintsSeen,
    daily,
    checks,
    findingList: findings,
  };
}

// ── the whole room ────────────────────────────────────────────────────────────

export interface MonitoringOverview {
  state: 'READY' | 'STORE_UNAVAILABLE';
  reason: string | null;
  measuredAt: string;
  thresholds: {
    recentDays: number; baselineDays: number; retentionDays: number; failureWindowHours: number;
    staleAfterDays: number; minHealthySample: number; minDriftRecent: number; minDriftBaseline: number;
    driftPsiWarn: number; repeatedFailures: number; repeatedFailureRate: number;
    latencyRegressionRatio: number; flushIntervalSeconds: number;
  };
  coverage: { registered: number; instrumented: number; notInstrumented: number; workflows: number };
  states: Record<MonitoringState, number>;
  totals: {
    executions24h: number; failures24h: number; executions7d: number; failures7d: number;
    outOfContract7d: number; lastExecutionAt: string | null;
  };
  runtime: { basis: RuntimeBasis; computedAt: string; durationMs: number; verified: number; mismatched: number; unverified: number };
  store: StoreStatus;
  loop: {
    measured: number; notInstrumented: number;
    healthy: number; warning: number; failing: number; notEnoughData: number;
    /** Algorithms whose production evidence carries a finding for a person to learn from. */
    withFindings: number;
  };
  algorithms: MonitoringSummary[];
}

/** Said when the store cannot be read — and then nothing reads as healthy. */
export const STORE_UNAVAILABLE_REASON = 'The telemetry store could not be read. Figures below are this server’s own unwritten runs only, and nothing reads as healthy.';

/** Reads are cached briefly, so a refresh storm reads the database once. */
const CACHE_TTL_MS = 10_000;
let cache: { at: number; ctx: Context; storeOk: boolean } | null = null;

async function context(now: number): Promise<{ ctx: Context; storeOk: boolean }> {
  if (cache && now - cache.at < CACHE_TTL_MS) return { ctx: cache.ctx, storeOk: cache.storeOk };
  // A write in flight is either all in the database or all back in memory
  // once it settles — waiting keeps a minute from being read twice or not at all.
  await settledFlush();
  const local = aggregateEntries(peekPending(), now);
  let agg = local;
  let storeOk = true;
  try {
    agg = combineAggregates(await readTelemetryAggregates(now), local);
  } catch (err) {
    storeOk = false;
    logger.warn('[algorithms] telemetry store could not be read', { kind: failureKindOf(err) });
  }
  const rt = runtimeFingerprints();
  const evals = evaluationsNow();
  const ctx: Context = {
    now, agg, storeOk,
    runtime: new Map(rt.list.map((f) => [f.key, f])),
    runtimeAt: rt.at,
    evaluation: Object.fromEntries(Object.entries(evals).map(([k, e]) => [k, { state: e.state, passed: e.passed, total: e.total }])),
  };
  cache = { at: now, ctx, storeOk };
  return { ctx, storeOk };
}

/** For tests: forget the cached read. */
export function resetMonitoringCache(): void { cache = null; }

export async function algorithmsMonitoring(now: number = Date.now()): Promise<MonitoringOverview> {
  const { ctx, storeOk } = await context(now);
  const rows = ALGORITHMS.map((a) => composeOne(a, monitoringSpecOf(a.key)!, ctx));
  const countState = (s: MonitoringState) => rows.filter((r) => r.state === s).length;
  const rt = runtimeFingerprints();
  const lastExec = rows.reduce<string | null>((m, r) => (r.lastExecutionAt && (!m || r.lastExecutionAt > m) ? r.lastExecutionAt : m), null);
  const instrumented = MONITORING_SPECS.filter((s) => s.instrumented);
  return {
    state: storeOk ? 'READY' : 'STORE_UNAVAILABLE',
    reason: storeOk ? null : STORE_UNAVAILABLE_REASON,
    measuredAt: new Date(now).toISOString(),
    thresholds: {
      recentDays: MONITORING.recentDays, baselineDays: MONITORING.baselineDays, retentionDays: MONITORING.retentionDays,
      failureWindowHours: MONITORING.failureWindowHours, staleAfterDays: MONITORING.staleAfterDays,
      minHealthySample: MONITORING.minHealthySample, minDriftRecent: MONITORING.minDriftRecent,
      minDriftBaseline: MONITORING.minDriftBaseline, driftPsiWarn: MONITORING.driftPsiWarn,
      repeatedFailures: MONITORING.repeatedFailures, repeatedFailureRate: MONITORING.repeatedFailureRate,
      latencyRegressionRatio: MONITORING.latencyRegressionRatio, flushIntervalSeconds: MONITORING.flushIntervalSeconds,
    },
    coverage: {
      registered: ALGORITHMS.length,
      instrumented: instrumented.length,
      notInstrumented: ALGORITHMS.length - instrumented.length,
      workflows: new Set(instrumented.flatMap((s) => (s.instrumented ? [...s.sources] : []))).size,
    },
    states: {
      HEALTHY: countState('HEALTHY'), WARNING: countState('WARNING'), FAILING: countState('FAILING'),
      NOT_ENOUGH_DATA: countState('NOT_ENOUGH_DATA'), NOT_INSTRUMENTED: countState('NOT_INSTRUMENTED'),
    },
    totals: {
      executions24h: rows.reduce((n, r) => n + r.counts.last24h.executions, 0),
      failures24h: rows.reduce((n, r) => n + r.counts.last24h.failures, 0),
      executions7d: rows.reduce((n, r) => n + r.counts.recent.executions, 0),
      failures7d: rows.reduce((n, r) => n + r.counts.recent.failures, 0),
      outOfContract7d: rows.reduce((n, r) => n + r.counts.recent.outOfContract, 0),
      lastExecutionAt: lastExec,
    },
    runtime: {
      basis: rt.basis, computedAt: rt.at, durationMs: rt.durationMs,
      verified: rt.list.filter((f) => f.verdict === 'MATCH').length,
      mismatched: rt.list.filter((f) => f.verdict === 'MISMATCH').length,
      unverified: rt.list.filter((f) => f.verdict === 'UNVERIFIED').length,
    },
    store: storeStatus(),
    loop: {
      measured: rows.filter((r) => r.instrumented).length,
      notInstrumented: rows.filter((r) => !r.instrumented).length,
      healthy: countState('HEALTHY'), warning: countState('WARNING'), failing: countState('FAILING'),
      notEnoughData: countState('NOT_ENOUGH_DATA'),
      withFindings: rows.filter((r) => r.findingList.some((f) => f.severity !== 'INFO')).length,
    },
    algorithms: rows.map((r): MonitoringSummary => ({
      key: r.key, name: r.name, domain: r.domain, version: r.version, state: r.state,
      instrumented: r.instrumented, workflows: r.workflows,
      executions24h: r.executions24h, failures24h: r.failures24h,
      executions7d: r.executions7d, failures7d: r.failures7d,
      lastExecutionAt: r.lastExecutionAt, p95AtMostUs: r.p95AtMostUs,
      runtimeCode: r.runtimeCode, evaluation: r.evaluation, findings: r.findings,
    })),
  };
}

export type AlgorithmMonitoringResult =
  | { state: 'UNKNOWN_ALGORITHM' }
  | { state: 'READY'; detail: AlgorithmMonitoringDetail };

export async function algorithmMonitoring(key: string, now: number = Date.now()): Promise<AlgorithmMonitoringResult> {
  const decl = algorithmOf(key);
  const spec = monitoringSpecOf(key);
  if (!decl || !spec) return { state: 'UNKNOWN_ALGORITHM' };
  const { ctx } = await context(now);
  return { state: 'READY', detail: composeOne(decl, spec, ctx) };
}
