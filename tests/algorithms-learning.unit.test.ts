/**
 * Algorithms, Step 3 — learning, synthetic only.
 *
 * THE TESTS THIS FILE EXISTS FOR
 *
 *   1. The statistics are right: every figure is checked against a value
 *      worked out by hand, and every way a figure can fail to exist fails
 *      EXPLICITLY — Inconclusive or Unavailable with a reason, never a number
 *      that would mislead.
 *   2. The method is proven, not the model: a planted error is found, no error
 *      is reported where none was planted (and, over twenty more seeds, false
 *      alarms stay near the declared 5%), and under the sample floor the room
 *      says Not enough data — consistent with the declared rule by construction.
 *   3. Synthetic is never real: every synthetic object says so, the real-world
 *      lane is disabled, health data is never a learning outcome, and a
 *      synthetic run never touches production telemetry or a club record.
 *   4. It is bounded and measured: limits are enforced, the run yields to the
 *      event loop inside every scenario, and its time and memory are measured.
 *   5. The write path of THIS deployment is verified only by a write this
 *      process completed; stored rows are history, and unknown stays unknown.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import express from 'express';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER = 'user-owner';
const PRESIDENT = 'user-president';
const CLUB = 'club-1';
const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
  user: { findUnique: async () => null, findFirst: async () => null },
};
jest.mock('../src/config/database', () => ({ prisma: db, basePrisma: db }));

let actingAs: Row | null = null;
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req: Row, res: Row, next: () => void) => {
    if (!actingAs) { res.status(401).json({ success: false, message: 'unauthenticated' }); return; }
    req.user = actingAs;
    next();
  },
  onIdentityForgotten: () => () => undefined,
  sessionStillValid: async () => true,
}));

// What this process has done with its own writes is controlled per test; the
// rest of the store module is real.
const own = jest.fn();
jest.mock('../src/algorithms/telemetry-store', () => {
  const real = jest.requireActual('../src/algorithms/telemetry-store');
  return { ...real, ownWriteEvidence: (...a: unknown[]) => own(...a) };
});

import { ALGORITHMS } from '../src/algorithms/registry';
import {
  LEARN_SPECS, LEARNING, LEARNING_LIMITS, SYNTHETIC_SCENARIOS, SYNTHETIC_KEYS, REAL_WORLD, SYNTHETIC_NOTICE,
  JUSTIFICATIONS, type SyntheticScenarioDecl,
} from '../src/algorithms/learning-spec';
import {
  accumulate, newAccumulator, metricsOf, judge, wilson, fitCalibration, clip, logit, binOf, meanInterval,
} from '../src/algorithms/learning-stats';
import {
  runSyntheticEvaluation, syntheticEvaluation, resetSyntheticEvaluations, syntheticRunsStarted, seeded, scenarioBytes,
  RETRY_ABORTED_AFTER_MS,
} from '../src/algorithms/learning-synthetic';
import { algorithmsLearning, algorithmLearning } from '../src/algorithms/learning';
import { writePathOf } from '../src/algorithms/monitoring';
import { peekPending, recorderCounters, resetTelemetry } from '../src/algorithms/telemetry';
import {
  AlgorithmsLearningSchema, AlgLearningDetailSchema, AlgorithmsMonitoringSchema,
} from '../src/contracts/owner-api.contracts';
import algorithmsRoutes from '../src/routes/algorithms.routes';

const ROOT = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const rep = (n: number, v: number) => Array(n).fill(v) as number[];

/** Run the statistics over a hand-made sample, exactly as a scenario would. */
async function judgeSample(ps: number[], ys: number[]) {
  const acc = newAccumulator();
  const L = new Float64Array(ps.length);
  const y = new Uint8Array(ps.length);
  ps.forEach((p, i) => { accumulate(acc, p, ys[i]); L[i] = Number.isFinite(p) ? logit(clip(p)) : NaN; y[i] = ys[i]; });
  const fit = acc.invalid ? null : await fitCalibration(L, y, ps.length);
  const m = metricsOf(acc, fit);
  return { m, fit, j: judge(m) };
}

beforeEach(() => {
  own.mockReset();
  own.mockReturnValue({ running: true, lastAttemptOk: null, lastSuccessAt: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The statistics, against values worked out by hand
// ─────────────────────────────────────────────────────────────────────────────

describe('the statistics are right', () => {
  it('Brier score, log-loss, goals test and bins on a four-shot sample', () => {
    const acc = newAccumulator();
    [[0.2, 0], [0.8, 1], [0.5, 1], [0.1, 0]].forEach(([p, y]) => accumulate(acc, p, y));
    const m = metricsOf(acc, null);
    // Brier = (0.04 + 0.04 + 0.25 + 0.01) / 4
    expect(m.brier!.value).toBeCloseTo(0.085, 12);
    // log-loss = −(ln .8 + ln .8 + ln .5 + ln .9) / 4
    expect(m.logLoss!.value).toBeCloseTo(-(2 * Math.log(0.8) + Math.log(0.5) + Math.log(0.9)) / 4, 12);
    // O = 2, E = 1.6, V = .16 + .16 + .25 + .09 = .66
    expect(m.goals).toBe(2);
    expect(m.expectedGoals).toBeCloseTo(1.6, 12);
    expect(m.citl!.z).toBeCloseTo(0.4 / Math.sqrt(0.66), 12);
    expect(m.observedOverExpected!.value).toBeCloseTo(1.25, 12);
    // Brier of always forecasting the observed rate ½
    expect(m.brierReference).toBeCloseTo(0.25, 12);
    // the four probabilities fall in bins [.2,.3), [.7,1], [.5,.7), [.1,.15)
    expect(m.bins.map((b) => b.shots)).toEqual([0, 0, 1, 0, 1, 0, 0, 1, 1]);
    expect(binOf(1)).toBe(8);
    expect(binOf(0)).toBe(0);
  });

  it('Wilson interval for 5 of 10 is the textbook (0.2366, 0.7634)', () => {
    const w = wilson(5, 10)!;
    expect(w.low).toBeCloseTo(0.2366, 4);
    expect(w.high).toBeCloseTo(0.7634, 4);
    expect(wilson(0, 0)).toBeNull();
  });

  it('a mean interval needs two values, and never reports a negative error', () => {
    expect(meanInterval(1, 1, 1)).toBeNull();
    const i = meanInterval(0.02, 0.0002, 2)!;
    expect(i.low).toBeGreaterThanOrEqual(0);
  });

  it('the smallest detectable error follows (z₀.₉₈₇₅ + z₀.₈₀)·√V ÷ E', () => {
    const acc = newAccumulator();
    for (let i = 0; i < 20_000; i++) accumulate(acc, 0.1, i % 10 === 0 ? 1 : 0);
    const m = metricsOf(acc, null);
    const V = 20_000 * 0.1 * 0.9;
    expect(m.minimumDetectableError!).toBeCloseTo(((LEARNING.testZ + LEARNING.powerZ) * Math.sqrt(V)) / 2000, 10);
  });

  it('the calibration fit recovers a known intercept and slope', async () => {
    const rng = seeded(424242);
    const n = 40_000;
    const L = new Float64Array(n);
    const y = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = -4 + 4 * rng();
      y[i] = rng() < 1 / (1 + Math.exp(-(0.3 + 0.7 * L[i]))) ? 1 : 0;
    }
    const fit = await fitCalibration(L, y, n);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(Math.abs(fit.intercept - 0.3)).toBeLessThan(3 * fit.seIntercept);
    expect(Math.abs(fit.slope - 0.7)).toBeLessThan(3 * fit.seSlope);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Edge cases and failed fits: explicit, never a misleading verdict
// ─────────────────────────────────────────────────────────────────────────────

describe('a figure that cannot exist is said not to exist', () => {
  it('perfectly separated outcomes: no slope exists, so the verdict is Inconclusive', async () => {
    const { fit, j } = await judgeSample([...rep(200, 0.3), ...rep(200, 0.7)], [...rep(200, 0), ...rep(200, 1)]);
    expect(fit).toMatchObject({ ok: false, reason: 'SEPARATION' });
    expect(j).toEqual({ verdict: 'INCONCLUSIVE', signals: [], reasons: ['SLOPE_UNAVAILABLE:SEPARATION'] });
  });

  it('predictions of exactly 0 and 1: clipped and counted, log-loss finite, and both tests unavailable', async () => {
    const { m, j } = await judgeSample([...rep(100, 0), ...rep(100, 1)], [...rep(100, 0), ...rep(100, 1)]);
    expect(m.clipped).toBe(200);
    expect(Number.isFinite(m.logLoss!.value)).toBe(true);
    expect(m.citl).toBeNull();
    expect(j).toEqual({ verdict: 'INCONCLUSIVE', signals: [], reasons: ['CITL_UNAVAILABLE', 'SLOPE_UNAVAILABLE:SEPARATION'] });
  });

  it('every prediction the same: the slope is not identifiable — Inconclusive, not "none detected"', async () => {
    const { j } = await judgeSample(rep(1000, 0.1), [...rep(100, 1), ...rep(900, 0)]);
    expect(j).toEqual({ verdict: 'INCONCLUSIVE', signals: [], reasons: ['SLOPE_UNAVAILABLE:NO_VARIATION_IN_PREDICTIONS'] });
  });

  it('every outcome the same: no slope, but the goals test alone still detects 0 goals against 40 expected', async () => {
    const { j } = await judgeSample(rep(400, 0.1), rep(400, 0));
    expect(j).toEqual({ verdict: 'MISCALIBRATION_DETECTED', signals: ['CITL'], reasons: ['SLOPE_UNAVAILABLE:NO_VARIATION_IN_OUTCOMES'] });
  });

  it('a prediction that is not a number makes the whole result Unavailable', async () => {
    const { m, j } = await judgeSample([0.1, NaN, 0.2], [0, 1, 0]);
    expect(m.invalid).toBe(1);
    expect(j).toEqual({ verdict: 'UNAVAILABLE', signals: [], reasons: ['NON_FINITE_PREDICTION'] });
    expect(await fitCalibration(new Float64Array([0, NaN]), new Uint8Array([0, 1]), 2)).toMatchObject({ ok: false, reason: 'NON_FINITE' });
  });

  it('saturated predictions make the information matrix singular — said, not divided by zero', async () => {
    const fit = await fitCalibration(new Float64Array([-800, 800, -800, 800]), new Uint8Array([0, 1, 1, 0]), 4);
    expect(fit).toMatchObject({ ok: false, reason: 'SINGULAR' });
  });

  it('a fit that runs out of iterations says so', async () => {
    const rng = seeded(7);
    const n = 2000;
    const L = new Float64Array(n); const y = new Uint8Array(n);
    for (let i = 0; i < n; i++) { L[i] = -3 + 6 * rng(); y[i] = rng() < 0.3 ? 1 : 0; }
    const fit = await fitCalibration(L, y, n, async () => undefined, { ...LEARNING.fit, maxIterations: 1 });
    expect(fit).toMatchObject({ ok: false, reason: 'NO_CONVERGENCE' });
  });

  it('no shots, and the two floors, each with its own reason', async () => {
    expect(judge(metricsOf(newAccumulator(), null))).toEqual({ verdict: 'NOT_ENOUGH_DATA', signals: [], reasons: ['NO_SAMPLE'] });
    expect((await judgeSample(rep(100, 0.1), rep(100, 0))).j).toEqual({ verdict: 'NOT_ENOUGH_DATA', signals: [], reasons: ['EXPECTED_GOALS_BELOW_FLOOR'] });
    expect((await judgeSample(rep(30, 0.95), rep(30, 1))).j).toEqual({ verdict: 'NOT_ENOUGH_DATA', signals: [], reasons: ['EXPECTED_NON_GOALS_BELOW_FLOOR'] });
  });

  it('never calls anything "calibrated" or "accurate"', () => {
    const verdicts = ['MISCALIBRATION_DETECTED', 'NONE_DETECTED', 'NOT_ENOUGH_DATA', 'INCONCLUSIVE', 'UNAVAILABLE'];
    expect(AlgorithmsLearningSchema.shape.scenarios.element.shape.expected.shape.verdict.options).toEqual(verdicts);
    for (const f of ['src/algorithms/learning-spec.ts', 'src/algorithms/learning-stats.ts', 'src/algorithms/learning.ts']) {
      expect(code(f)).not.toMatch(/'(?:CALIBRATED|ACCURATE|VALIDATED|PROVEN)'/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · The method checks, and the floor scenario's consistency with the rule
// ─────────────────────────────────────────────────────────────────────────────

describe('the measuring method is proven on synthetic worlds', () => {
  beforeEach(() => { resetSyntheticEvaluations(); resetTelemetry(); });

  it.each(SYNTHETIC_KEYS.map((k) => [k]))('%s: all four method checks pass, on the approved code', async (key) => {
    const r = await runSyntheticEvaluation(key);
    expect(r.evidence).toBe('SYNTHETIC');
    expect(r.state).toBe('COMPLETE');
    expect(r.code.verdict).toBe('MATCH');
    expect(r.scenarios.map((s) => `${s.id}: ${s.verdict} → ${s.methodCheck}`)).toEqual([
      'consistent: NONE_DETECTED → PASSED',
      'shifted: MISCALIBRATION_DETECTED → PASSED',
      'overconfident: MISCALIBRATION_DETECTED → PASSED',
      'below-floor: NOT_ENOUGH_DATA → PASSED',
    ]);
    expect(r.scenarios.find((s) => s.id === 'shifted')!.signals).toContain('CITL');
    expect(r.scenarios.find((s) => s.id === 'overconfident')!.signals).toContain('SLOPE');
    for (const s of r.scenarios) expect(s.evidence).toBe('SYNTHETIC');
  });

  it.each(SYNTHETIC_KEYS.map((k) => [k]))('%s: the floor scenario stops below the declared floor — consistent by construction', async (key) => {
    const r = await runSyntheticEvaluation(key);
    const floor = r.scenarios.find((s) => s.id === 'below-floor')!;
    const decl = SYNTHETIC_SCENARIOS.find((s) => s.id === 'below-floor')!;
    const target = 'untilExpectedGoals' in decl.size ? decl.size.untilExpectedGoals : NaN;
    expect(target).toBeLessThan(LEARNING.minExpectedEvents);
    expect(floor.metrics!.expectedGoals).toBeGreaterThanOrEqual(target);
    expect(floor.metrics!.expectedGoals).toBeLessThan(LEARNING.minExpectedEvents);
    expect(floor.reasons).toEqual(['EXPECTED_GOALS_BELOW_FLOOR']);
    expect(floor.fitAttempted).toBe(false);
    expect(floor.metrics!.slope).toBeNull();
  });

  it('over twenty more seeds: false alarms near 5%, planted errors always found', async () => {
    let falseAlarms = 0; let shifted = 0; let slope = 0;
    for (let k = 1; k <= 20; k++) {
      const scenarios = SYNTHETIC_SCENARIOS.filter((s) => s.id !== 'below-floor').map((s) => ({ ...s, seed: s.seed + k * 7919 }));
      const r = await runSyntheticEvaluation('xg', { scenarios });
      if (r.scenarios[0].verdict !== 'NONE_DETECTED') falseAlarms += 1;
      if (r.scenarios[1].verdict === 'MISCALIBRATION_DETECTED' && r.scenarios[1].signals.includes('CITL')) shifted += 1;
      if (r.scenarios[2].verdict === 'MISCALIBRATION_DETECTED' && r.scenarios[2].signals.includes('SLOPE')) slope += 1;
    }
    // Binomial(20, 0.05): P(≥ 4) ≈ 1.6%; the seeds are fixed, so this is deterministic.
    expect(falseAlarms).toBeLessThanOrEqual(3);
    expect(shifted).toBe(20);
    expect(slope).toBe(20);
  }, 60_000);

  it('the same seed gives the same answer', async () => {
    const strip = (r: Awaited<ReturnType<typeof runSyntheticEvaluation>>) => r.scenarios.map((s) => ({ v: s.verdict, m: s.metrics }));
    expect(strip(await runSyntheticEvaluation('xgot'))).toEqual(strip(await runSyntheticEvaluation('xgot')));
  });

  it('code that is not the approved code makes every method check Unverified, never Passed', async () => {
    const r = await runSyntheticEvaluation('xg', { code: { verdict: 'MISMATCH', fingerprint: null } });
    expect(r.scenarios.map((s) => s.methodCheck)).toEqual(['UNVERIFIED', 'UNVERIFIED', 'UNVERIFIED', 'UNVERIFIED']);
    expect(r.methodChecks.passed).toBe(0);
  });

  it('a broken prediction makes a scenario Unavailable; a throwing one stops the run and says why', async () => {
    const nan = await runSyntheticEvaluation('xg', { predict: () => NaN });
    expect(nan.scenarios.every((s) => s.verdict === 'UNAVAILABLE' && s.methodCheck === 'UNAVAILABLE')).toBe(true);
    expect(nan.scenarios[0].reasons).toEqual(['NON_FINITE_PREDICTION']);
    const thrown = await runSyntheticEvaluation('xg', { predict: () => { throw new TypeError('boom'); } });
    expect(thrown.state).toBe('ABORTED');
    expect(thrown.abortReason).toBe('ERROR');
    expect(thrown.scenarios.every((s) => s.verdict === 'UNAVAILABLE' && s.reasons[0] === 'ERROR')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Bounded, yielding, measured
// ─────────────────────────────────────────────────────────────────────────────

describe('a run is bounded, yields, and measures itself', () => {
  beforeEach(() => resetSyntheticEvaluations());

  it('the declared scenarios fit the declared limits', () => {
    const shots = SYNTHETIC_SCENARIOS.reduce((s, d) => s + ('shots' in d.size ? d.size.shots : d.size.shotCap), 0);
    expect(shots).toBeLessThanOrEqual(LEARNING_LIMITS.shotsPerAlgorithmMax);
    for (const d of SYNTHETIC_SCENARIOS) {
      expect('shots' in d.size ? d.size.shots : d.size.shotCap).toBeLessThanOrEqual(LEARNING_LIMITS.shotsPerScenarioMax);
      expect(scenarioBytes(d)).toBeLessThanOrEqual(LEARNING_LIMITS.scenarioBufferBytesMax);
    }
  });

  it('a time budget that runs out stops the run and says so', async () => {
    const r = await runSyntheticEvaluation('xg', { limits: { ...LEARNING_LIMITS, busyBudgetMs: 0 } });
    expect(r.state).toBe('ABORTED');
    expect(r.abortReason).toBe('TIME_BUDGET_EXCEEDED');
    expect(r.scenarios.every((s) => s.verdict === 'UNAVAILABLE')).toBe(true);
  });

  it('a scenario over a limit is refused, and so is a run over the per-algorithm total', async () => {
    const big: SyntheticScenarioDecl = { ...SYNTHETIC_SCENARIOS[0], size: { shots: LEARNING_LIMITS.shotsPerScenarioMax + 1 } };
    const one = await runSyntheticEvaluation('xg', { scenarios: [big] });
    expect(one.scenarios[0]).toMatchObject({ verdict: 'UNAVAILABLE', reasons: ['LIMIT_EXCEEDED'] });
    const many = await runSyntheticEvaluation('xg', { scenarios: rep(4, 0).map(() => SYNTHETIC_SCENARIOS[0]) });
    expect(many.abortReason).toBe('LIMIT_EXCEEDED');
    expect(many.scenarios.every((s) => s.reasons[0] === 'LIMIT_EXCEEDED')).toBe(true);
  });

  it('yields inside every scenario: other work runs while it computes', async () => {
    let ticks = 0;
    let stop = false;
    const tick = () => { ticks += 1; if (!stop) setImmediate(tick); };
    setImmediate(tick);
    const r = await runSyntheticEvaluation('xg');
    stop = true;
    // 20,000 shots in slices of 1,000 is 20 slices of drawing alone, plus the fit's steps.
    for (const s of r.scenarios.filter((x) => x.id !== 'below-floor')) expect(s.measured.slices).toBeGreaterThanOrEqual(20);
    expect(r.measured.yields).toBeGreaterThanOrEqual(60);
    expect(ticks).toBeGreaterThanOrEqual(60);
  });

  it('reports what it measured: exact typed-array memory, and time it actually took', async () => {
    const r = await runSyntheticEvaluation('xg');
    const bytes = SYNTHETIC_SCENARIOS.reduce((s, d) => s + scenarioBytes(d), 0);
    expect(r.measured.allocatedBytes).toBe(bytes);
    expect(r.measured.allocatedBytes).toBe(549_000);
    expect(r.measured.wallMs).toBeGreaterThan(0);
    expect(r.measured.busyMs).toBeGreaterThan(0);
    expect(r.measured.busyMs).toBeLessThan(LEARNING_LIMITS.busyBudgetMs);
    expect(r.measured.maxSliceMs).toBeGreaterThan(0);
    // Generous for a shared CI runner; the measured figure is in the PR.
    expect(r.measured.maxSliceMs).toBeLessThan(250);
    expect(r.measured.shots).toBe(r.scenarios.reduce((s, x) => s + x.metrics!.shots, 0));
    expect(Number.isNaN(Date.parse(r.measured.computedAt))).toBe(false);
  });

  it('a run the budget stopped is not the answer for ever: it is retried after a minute', async () => {
    jest.useFakeTimers();
    try {
      const aborted = { ...(await runSyntheticEvaluation('xg', { limits: { ...LEARNING_LIMITS, busyBudgetMs: 0 } })) };
      expect(aborted.state).toBe('ABORTED');
      const first = syntheticEvaluation('xg', async () => aborted);
      await first.run;
      await Promise.resolve();
      expect(syntheticEvaluation('xg').cached).toBe(true);
      jest.advanceTimersByTime(RETRY_ABORTED_AFTER_MS + 1);
      expect(syntheticEvaluation('xg', async () => aborted).cached).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('computes once per algorithm and code, shared by concurrent callers', async () => {
    const a = syntheticEvaluation('xg');
    const b = syntheticEvaluation('xg');
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(await a.run).toBe(await b.run);
    expect(syntheticRunsStarted()).toBe(1);
    expect(syntheticEvaluation('xg').cached).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Synthetic is never real
// ─────────────────────────────────────────────────────────────────────────────

describe('synthetic evidence stays synthetic', () => {
  beforeEach(() => { resetSyntheticEvaluations(); resetTelemetry(); });

  it('a synthetic run never enters production telemetry', async () => {
    const before = recorderCounters();
    await runSyntheticEvaluation('xg');
    await runSyntheticEvaluation('xgot');
    expect(peekPending()).toEqual([]);
    expect(recorderCounters()).toEqual(before);
    for (const f of ['src/algorithms/learning-synthetic.ts', 'src/algorithms/learning.ts', 'src/algorithms/learning-stats.ts', 'src/algorithms/learning-spec.ts']) {
      expect(code(f)).not.toMatch(/from '\.\/telemetry(?:-store)?'|\bobserved(?:Async)?\(/);
    }
  });

  it('reads no database and names no club, match, injury or workload record', () => {
    for (const f of ['src/algorithms/learning-synthetic.ts', 'src/algorithms/learning.ts', 'src/algorithms/learning-stats.ts', 'src/algorithms/learning-spec.ts']) {
      const c = code(f);
      expect(c).not.toMatch(/config\/database|@prisma\/client|rls-client|db-context|\bprisma\./);
      expect(c).not.toMatch(/\b(?:MatchEvent|PlayerInjury|InjuryRecord|WorkloadRecord|PlayerMatchStats)\b/);
    }
  });

  it('declares every algorithm once; health-data learning is excluded; only xG and xGOT are synthetic', () => {
    expect(LEARN_SPECS.map((s) => s.key).sort()).toEqual(ALGORITHMS.map((a) => a.key).sort());
    const status = Object.fromEntries(LEARN_SPECS.map((s) => [s.key, s.status]));
    for (const k of ['medical-risk', 'training-load', 'biomechanical-load', 'tactical-attrition']) expect(status[k]).toBe('EXCLUDED_HEALTH');
    expect(LEARN_SPECS.filter((s) => s.status === 'SYNTHETIC_ONLY').map((s) => s.key)).toEqual([...SYNTHETIC_KEYS]);
    expect(status.xa).toBe('DERIVED');
    expect(LEARN_SPECS.find((s) => s.key === 'xa')!.derivedFrom).toBe('xg');
    for (const s of LEARN_SPECS) expect(s.reason.length).toBeGreaterThan(20);
  });

  it('the overview: two lanes, the real one disabled with every prerequisite unmet, and the contract holds', async () => {
    const o = await algorithmsLearning();
    expect(AlgorithmsLearningSchema.safeParse(o).success).toBe(true);
    expect(o.evidence).toEqual({ synthetic: 'SYNTHETIC', realWorld: 'DISABLED' });
    expect(o.notice).toBe(SYNTHETIC_NOTICE);
    expect(o.realWorld.state).toBe('DISABLED');
    expect(o.realWorld.prerequisites.map((p) => p.id)).toEqual(REAL_WORLD.prerequisites.map((p) => p.id));
    expect(o.realWorld.prerequisites.every((p) => p.met === false)).toBe(true);
    expect(o.counts).toEqual({ syntheticOnly: 2, derived: 1, noGroundTruth: 6, excludedHealth: 4 });
    expect(o.algorithms.map((a) => a.key)).toEqual(ALGORITHMS.map((a) => a.key));
    expect(o.algorithms.filter((a) => a.synthetic).map((a) => a.key)).toEqual(['xg', 'xgot']);
    for (const a of o.algorithms.filter((x) => x.synthetic)) expect(a.synthetic!.evidence).toBe('SYNTHETIC');
    expect(Object.keys(o.rules.justifications).sort()).toEqual(Object.keys(JUSTIFICATIONS).sort());
  });

  it('one algorithm: synthetic carries the notice; others carry none and say why; unknown is unknown', async () => {
    const xg = await algorithmLearning('xg');
    expect(xg.state).toBe('FOUND');
    if (xg.state !== 'FOUND') return;
    expect(AlgLearningDetailSchema.safeParse(xg.detail).success).toBe(true);
    expect(xg.detail).toMatchObject({ evidence: 'SYNTHETIC', notice: SYNTHETIC_NOTICE, realWorld: { state: 'DISABLED' } });
    const med = await algorithmLearning('medical-risk');
    if (med.state !== 'FOUND') throw new Error('medical-risk not found');
    expect(med.detail).toMatchObject({ status: 'EXCLUDED_HEALTH', evidence: 'NONE', notice: null, synthetic: null });
    expect(AlgLearningDetailSchema.safeParse(med.detail).success).toBe(true);
    expect((await algorithmLearning('not-an-algorithm')).state).toBe('UNKNOWN_ALGORITHM');
  });

  it('the approval gates, the allowed modes and the approved fingerprints are untouched', () => {
    expect(code('src/algorithms/loop.ts')).toMatch(/export const ALGORITHM_MODES = \['READ_ANALYZE'\] as const;/);
    // The learning spec records no approval and no fingerprint: approvals live
    // only in the code-owned registry, where Step 1's gate recomputes them.
    expect(code('src/algorithms/learning-spec.ts')).not.toMatch(/fingerprint:\s*'[0-9a-f]{64}'|approvedBy|ApprovalRecord|baseline\(/);
    for (const f of ['src/algorithms/learning-synthetic.ts', 'src/algorithms/learning.ts']) {
      expect(code(f)).not.toMatch(/registry'\)?\.ALGORITHMS\s*=|approval\s*=|deploymentGate|canAdvance/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · The write path of THIS deployment
// ─────────────────────────────────────────────────────────────────────────────

describe('only a write this server completed verifies the running deployment', () => {
  const OLD = Date.parse('2026-09-01T10:00:00Z');

  it('old rows in the store are history: this server stays Unverified', () => {
    own.mockReturnValue({ running: true, lastAttemptOk: null, lastSuccessAt: null });
    expect(writePathOf({ storeOk: true, storedNewestAt: OLD })).toMatchObject({
      thisServer: 'UNVERIFIED', verifiedAt: null, stored: 'ROWS_PRESENT', storedNewestRunAt: new Date(OLD).toISOString(),
    });
  });

  it('zero runs and no rows is evidence of nothing: Unverified, not failing and not working', () => {
    expect(writePathOf({ storeOk: true, storedNewestAt: null })).toMatchObject({ thisServer: 'UNVERIFIED', stored: 'NO_ROWS' });
  });

  it('a write this server completed verifies it', () => {
    own.mockReturnValue({ running: true, lastAttemptOk: true, lastSuccessAt: '2026-10-05T08:00:00.000Z' });
    expect(writePathOf({ storeOk: true, storedNewestAt: OLD })).toMatchObject({ thisServer: 'VERIFIED', verifiedAt: '2026-10-05T08:00:00.000Z' });
  });

  it('a failed last attempt is Failing, even after an earlier success', () => {
    own.mockReturnValue({ running: true, lastAttemptOk: false, lastSuccessAt: '2026-10-05T08:00:00.000Z' });
    expect(writePathOf({ storeOk: true, storedNewestAt: OLD }).thisServer).toBe('FAILING');
  });

  it('an unreadable store is Unknown — never "no rows"', () => {
    const w = writePathOf({ storeOk: false, storedNewestAt: null });
    expect(w.stored).toBe('UNKNOWN');
    expect(w.storedNewestRunAt).toBeNull();
  });

  it('a process where telemetry never started cannot vouch for anything', () => {
    own.mockReturnValue({ running: false, lastAttemptOk: null, lastSuccessAt: null });
    expect(writePathOf({ storeOk: true, storedNewestAt: OLD }).thisServer).toBe('NOT_RUNNING');
  });

  it('is part of the monitoring contract, with every state named', () => {
    const shape = AlgorithmsMonitoringSchema.shape.writePath.shape;
    expect(shape.thisServer.options).toEqual(['VERIFIED', 'FAILING', 'UNVERIFIED', 'NOT_RUNNING']);
    expect(shape.stored.options).toEqual(['ROWS_PRESENT', 'NO_ROWS', 'UNKNOWN']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Owner-only and read-only
// ─────────────────────────────────────────────────────────────────────────────

describe('learning is the platform owner\'s, and only to read', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/system/algorithms', algorithmsRoutes);
    a.use((err: Row, _req: Row, res: Row, _next: unknown) => {
      res.status(err?.statusCode || err?.status || 500).json({ success: false, message: err?.message });
    });
    return a;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest');
  const ROUTES = ['/system/algorithms/learning', '/system/algorithms/xg/learning', '/system/algorithms/medical-risk/learning'];
  beforeAll(() => resetSyntheticEvaluations());

  it('serves the owner, with no-store', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      const res = await request(app()).get(r);
      expect(`${r}: ${res.status}`).toBe(`${r}: 200`);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect((await request(app()).get('/system/algorithms/not-an-algorithm/learning')).status).toBe(404);
  });

  it('refuses a club administrator, and an unauthenticated caller', async () => {
    actingAs = { id: PRESIDENT, clubId: CLUB, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      const res = await request(app()).get(r);
      expect(`${r}: ${res.status}`).toBe(`${r}: 403`);
      expect(JSON.stringify(res.body)).not.toMatch(/SYNTHETIC|methodCheck/);
    }
    actingAs = null;
    for (const r of ROUTES) expect((await request(app()).get(r)).status).toBe(401);
  });

  it('answers no write, to anyone', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await request(app())[verb](r).send({ retrain: true });
        expect(`${verb} ${r}: ${res.status}`).toBe(`${verb} ${r}: 404`);
      }
    }
  });

  it('declares learning before the key route, so the word is never read as a key', () => {
    const routes = code('src/routes/algorithms.routes.ts');
    expect(routes.indexOf("router.get('/learning'")).toBeGreaterThan(0);
    expect(routes.indexOf("router.get('/learning'")).toBeLessThan(routes.indexOf("router.get('/:key'"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · The room says what synthetic results are, everywhere they appear
// ─────────────────────────────────────────────────────────────────────────────

describe('the room draws learning honestly', () => {
  const js = read('public/algorithms/algorithms.js');
  const css = read('public/algorithms/algorithms.css');

  it('every synthetic view carries the banner, which cannot be dismissed', () => {
    const view = js.slice(js.indexOf('function learningHtml()'), js.indexOf('function learnRulesPanel('));
    expect(view).toMatch(/syntheticBanner\(Lr\.notice\)/);
    const detail = js.slice(js.indexOf('function learningDetailHtml()'), js.indexOf('function scenarioDetailHtml('));
    expect(detail).toMatch(/head \+ syntheticBanner\(d\.notice\)/);
    expect(js).toMatch(/al-banner--synthetic" role="note"/);
    expect(js.slice(js.indexOf('function syntheticBanner('), js.indexOf('function syntheticBanner(') + 600)).not.toMatch(/close|dismiss|data-al-hide/i);
  });

  it('draws a verdict neutral, and colours only the method check and the write path as facts', () => {
    expect(js).toMatch(/function verdictTag\(v\) \{ return chip\('info'/);
    const sandbox: Row = { window: {} };
    vm.runInNewContext(js, sandbox);
    const method = sandbox.window.__familistaAlgorithmsMethodKind as (s: string) => string;
    expect(['PASSED', 'FAILED', 'UNVERIFIED', 'UNAVAILABLE'].map(method)).toEqual(['ok', 'crit', 'warn', 'none']);
    const write = sandbox.window.__familistaAlgorithmsWriteKind as (s: string) => string;
    expect(['VERIFIED', 'FAILING', 'UNVERIFIED', 'NOT_RUNNING'].map(write)).toEqual(['ok', 'crit', 'none', 'off']);
  });

  it('reads both learning endpoints and refuses a response that does not say which lane it is', () => {
    expect(js).toContain("api('/system/algorithms/learning')");
    expect(js).toContain("'/learning')");
    expect(js).toMatch(/d\.evidence\.synthetic !== 'SYNTHETIC' \|\| d\.evidence\.realWorld !== 'DISABLED'/);
    expect(js).toMatch(/d\.synthetic\.evidence !== 'SYNTHETIC'/);
  });

  it('keeps the design system: no inline style, logical properties, and an escape hatch for every new grid', () => {
    expect(js).not.toMatch(/style="/);
    expect(js).not.toMatch(/\.style\./);
    const hatch = css.slice(css.indexOf('@media (max-width: 980px), (max-height: 620px)'));
    for (const sel of ['.al-scn-tabs', '.al-bin', '.al-lane-list li']) expect(hatch).toContain(sel);
    expect(css).not.toMatch(/margin-left|margin-right|padding-left|padding-right|text-align:\s*(left|right)/);
  });
});
