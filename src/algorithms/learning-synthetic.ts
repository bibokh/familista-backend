// Familista — synthetic learning: testing the measuring method (Algorithms Step 3)
// ─────────────────────────────────────────────────────────────────────────────
// Draws invented shots, asks the APPROVED expected-goals functions — imported
// from where the platform keeps them, never a copy — what each shot is worth,
// then draws an outcome from a truth declared in learning-spec.ts. Because the
// truth is known, so is the right answer: a planted error must be found, and
// no error may be reported where none was planted.
//
// What this proves is that the MEASURING works. It proves nothing about how
// the algorithm performs in the real world, and every result carries
// `evidence: 'SYNTHETIC'` so that nothing downstream can forget it.
//
// Isolation, by construction:
//   · no database, no file, no network — and no club, player or match record;
//   · no telemetry: these calls are not production runs, so this file does not
//     import the recorder and the functions it calls are not wrapped;
//   · every input is generated here from a fixed seed, so a run is repeatable.
//
// Resource use is bounded and MEASURED rather than assumed: work runs in slices
// with a yield to the event loop between them (inside every scenario, and after
// every iteration of the calibration fit); the limits in learning-spec.ts are
// enforced; and the run reports its own wall time, busy time, longest slice and
// memory. One run per algorithm per code fingerprint, cached for the process.

import { performance } from 'perf_hooks';
import { computeXG, computeXGOT, type ShotFeatures } from '../match-events/xg-model.service';
import {
  LEARNING, LEARNING_LIMITS, LEARNING_SPEC_VERSION, SEED_OFFSET, SYNTHETIC_SCENARIOS, SYNTHETIC_SHOTS,
  type LearningLimits, type LearnSignal, type LearnVerdict, type SyntheticKey, type SyntheticScenarioDecl, type Truth,
} from './learning-spec';
import {
  accumulate, clip, fitCalibration, judge, logit, metricsOf, newAccumulator,
  type FitResult, type JudgementReason, type Metrics,
} from './learning-stats';
import { runtimeFingerprintOf, type RuntimeVerdict } from './runtime-fingerprint';

// ── types ────────────────────────────────────────────────────────────────────

export type RunReason = 'TIME_BUDGET_EXCEEDED' | 'LIMIT_EXCEEDED' | 'ERROR';
export type ScenarioReason = JudgementReason | RunReason;
export type MethodCheck = 'PASSED' | 'FAILED' | 'UNVERIFIED' | 'UNAVAILABLE';

export interface ScenarioMeasured {
  wallMs: number;
  busyMs: number;
  maxSliceMs: number;
  slices: number;
  /** Exact: the byte length of every typed array this scenario allocated. */
  allocatedBytes: number;
}

export interface SyntheticScenarioResult {
  evidence: 'SYNTHETIC';
  id: SyntheticScenarioDecl['id'];
  title: string;
  purpose: string;
  circular: boolean;
  truth: { kind: Truth['kind']; parameter: number | null };
  seed: number;
  verdict: LearnVerdict;
  signals: LearnSignal[];
  reasons: ScenarioReason[];
  expected: { verdict: LearnVerdict; signal: LearnSignal | null };
  methodCheck: MethodCheck;
  /** Null only when the scenario could not run at all. */
  metrics: Metrics | null;
  /** False when the scenario stopped below the floor, so no fit was attempted. */
  fitAttempted: boolean;
  measured: ScenarioMeasured;
}

export interface RunMeasured {
  computedAt: string;
  wallMs: number;
  busyMs: number;
  maxSliceMs: number;
  slices: number;
  yields: number;
  shots: number;
  allocatedBytes: number;
  /** Sampled at every slice boundary; garbage collection makes these approximate. */
  peakHeapDeltaBytes: number;
  peakArrayBuffersDeltaBytes: number;
}

export interface SyntheticEvaluation {
  evidence: 'SYNTHETIC';
  key: SyntheticKey;
  /** The code evaluated: its runtime verdict and the source fingerprint it is proven to be. */
  code: { verdict: RuntimeVerdict; fingerprint: string | null };
  state: 'COMPLETE' | 'ABORTED';
  abortReason: RunReason | null;
  methodChecks: { passed: number; total: number };
  scenarios: SyntheticScenarioResult[];
  measured: RunMeasured;
}

export interface RunOptions {
  scenarios?: readonly SyntheticScenarioDecl[];
  limits?: LearningLimits;
  /** For tests: replace the prediction (e.g. to inject NaN or a throw). Never set in production. */
  predict?: (f: ShotFeatures) => number;
  /** For tests: the code verdict to report. Defaults to the runtime fingerprint. */
  code?: { verdict: RuntimeVerdict; fingerprint: string | null };
}

// ── randomness: a small, seeded, repeatable generator ───────────────────────

/** mulberry32 — 32-bit state, uniform in [0, 1). Deterministic for a seed. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng: () => number, weighted: ReadonlyArray<readonly [string, number]>): string {
  let u = rng();
  for (const [v, w] of weighted) { if (u < w) return v; u -= w; }
  return weighted[weighted.length - 1][0];
}

/**
 * One invented shot, from the documented mix in SYNTHETIC_SHOTS. Written into
 * `into` when given: the model only reads it, so a run reuses one object
 * instead of leaving tens of thousands behind for the garbage collector.
 */
export function syntheticShot(rng: () => number, into: ShotFeatures = { x: 0, y: 0 }): ShotFeatures {
  const [x0, x1] = SYNTHETIC_SHOTS.x; const [y0, y1] = SYNTHETIC_SHOTS.y;
  into.x = x0 + rng() * (x1 - x0);
  into.y = y0 + rng() * (y1 - y0);
  into.bodyPart = pick(rng, SYNTHETIC_SHOTS.bodyPart);
  into.technique = pick(rng, SYNTHETIC_SHOTS.technique);
  into.situation = pick(rng, SYNTHETIC_SHOTS.situation);
  into.isPressured = rng() < SYNTHETIC_SHOTS.pressured;
  into.isCounter = rng() < SYNTHETIC_SHOTS.counter;
  return into;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** The declared truth: the probability a synthetic goal is drawn with. */
export function truthOf(p: number, truth: Truth): number {
  if (truth.kind === 'MODEL') return p;
  const l = logit(clip(p));
  return truth.kind === 'LOGIT_SHIFT' ? sigmoid(l + truth.delta) : sigmoid(truth.factor * l);
}

const PREDICT: Readonly<Record<SyntheticKey, (f: ShotFeatures) => number>> = {
  xg: (f) => computeXG(f),
  // The branch the platform's annotation uses: no shot-placement target.
  xgot: (f) => computeXGOT(f),
};

// ── the clock: slices, yields, budget and memory, all measured ──────────────

class BudgetExceeded extends Error { constructor() { super('learning time budget exceeded'); this.name = 'BudgetExceeded'; } }

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

class Clock {
  busyMs = 0; maxSliceMs = 0; slices = 0; yields = 0;
  peakHeapDelta = 0; peakArrayBuffersDelta = 0;
  private sliceStart = performance.now();
  private readonly base = process.memoryUsage();
  constructor(private readonly budgetMs: number) {}

  /** Close the current slice: measure it, check the budget, then give the event loop a turn. Returns the slice's length. */
  async pause(): Promise<number> {
    const d = this.close();
    if (this.busyMs > this.budgetMs) throw new BudgetExceeded();
    await yieldToEventLoop();
    this.yields += 1;
    this.sliceStart = performance.now();
    return d;
  }

  /** Measure the slice that just ended. Returns its length in milliseconds. */
  close(): number {
    const d = performance.now() - this.sliceStart;
    this.busyMs += d;
    if (d > this.maxSliceMs) this.maxSliceMs = d;
    this.slices += 1;
    const m = process.memoryUsage();
    this.peakHeapDelta = Math.max(this.peakHeapDelta, m.heapUsed - this.base.heapUsed);
    this.peakArrayBuffersDelta = Math.max(this.peakArrayBuffersDelta, m.arrayBuffers - this.base.arrayBuffers);
    this.sliceStart = performance.now();
    return d;
  }
}

// ── one scenario ─────────────────────────────────────────────────────────────

function shotBudgetOf(s: SyntheticScenarioDecl): number {
  return 'shots' in s.size ? s.size.shots : s.size.shotCap;
}

/** Bytes this scenario allocates: logit(p) as float64 and the outcome as uint8. */
export function scenarioBytes(s: SyntheticScenarioDecl): number {
  return shotBudgetOf(s) * (Float64Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT);
}

function unavailable(s: SyntheticScenarioDecl, seed: number, reason: RunReason, measured: ScenarioMeasured): SyntheticScenarioResult {
  return {
    evidence: 'SYNTHETIC', id: s.id, title: s.title, purpose: s.purpose, circular: s.circular,
    truth: truthView(s.truth), seed, verdict: 'UNAVAILABLE', signals: [], reasons: [reason],
    expected: { verdict: s.expect.verdict, signal: s.expect.signal }, methodCheck: 'UNAVAILABLE',
    metrics: null, fitAttempted: false, measured,
  };
}

const truthView = (t: Truth) => ({ kind: t.kind, parameter: t.kind === 'LOGIT_SHIFT' ? t.delta : t.kind === 'LOGIT_SCALE' ? t.factor : null });

const zeroMeasured = (): ScenarioMeasured => ({ wallMs: 0, busyMs: 0, maxSliceMs: 0, slices: 0, allocatedBytes: 0 });

async function runScenario(
  s: SyntheticScenarioDecl, seed: number, predict: (f: ShotFeatures) => number,
  clock: Clock, limits: LearningLimits, codeVerdict: RuntimeVerdict,
): Promise<SyntheticScenarioResult> {
  const cap = shotBudgetOf(s);
  if (cap > limits.shotsPerScenarioMax || scenarioBytes(s) > limits.scenarioBufferBytesMax) {
    return unavailable(s, seed, 'LIMIT_EXCEEDED', zeroMeasured());
  }
  const started = performance.now();
  const busy0 = clock.busyMs; const slices0 = clock.slices; let maxSlice = 0;
  const L = new Float64Array(cap);
  const y = new Uint8Array(cap);
  const allocatedBytes = L.byteLength + y.byteLength;
  const rng = seeded(seed);
  const acc = newAccumulator();
  const target = 'untilExpectedGoals' in s.size ? s.size.untilExpectedGoals : Infinity;

  let n = 0;
  const shot: ShotFeatures = { x: 0, y: 0 };
  const pause = async () => { maxSlice = Math.max(maxSlice, await clock.pause()); };
  while (n < cap && acc.sumP < target) {
    const end = Math.min(cap, n + limits.sliceShots);
    for (; n < end && acc.sumP < target; n++) {
      const p = predict(syntheticShot(rng, shot));
      const goal = rng() < truthOf(Number.isFinite(p) ? p : 0, s.truth) ? 1 : 0;
      accumulate(acc, p, goal);
      L[n] = Number.isFinite(p) ? logit(clip(p)) : NaN;
      y[n] = goal;
    }
    await pause();
  }

  // Under the floor, no fit is attempted: a slope from too little data would
  // only look like evidence.
  const belowFloor = acc.sumP < LEARNING.minExpectedEvents || acc.n - acc.sumP < LEARNING.minExpectedEvents;
  let fit: FitResult | null = null;
  if (!belowFloor && acc.invalid === 0) fit = await fitCalibration(L, y, n, pause);
  const metrics = metricsOf(acc, fit);
  const j = judge(metrics);
  maxSlice = Math.max(maxSlice, clock.close());

  const methodCheck: MethodCheck = codeVerdict !== 'MATCH' ? 'UNVERIFIED'
    : j.verdict === 'UNAVAILABLE' ? 'UNAVAILABLE'
      : j.verdict === s.expect.verdict && (s.expect.signal === null || j.signals.includes(s.expect.signal)) ? 'PASSED' : 'FAILED';

  return {
    evidence: 'SYNTHETIC', id: s.id, title: s.title, purpose: s.purpose, circular: s.circular,
    truth: truthView(s.truth), seed, verdict: j.verdict, signals: j.signals, reasons: j.reasons,
    expected: { verdict: s.expect.verdict, signal: s.expect.signal }, methodCheck,
    metrics, fitAttempted: fit !== null,
    measured: {
      wallMs: performance.now() - started, busyMs: clock.busyMs - busy0,
      maxSliceMs: maxSlice, slices: clock.slices - slices0, allocatedBytes,
    },
  };
}

// ── one algorithm ────────────────────────────────────────────────────────────

/** Run every synthetic scenario for one algorithm. Exported for tests; production goes through the cache below. */
export async function runSyntheticEvaluation(key: SyntheticKey, opts: RunOptions = {}): Promise<SyntheticEvaluation> {
  const scenarios = opts.scenarios ?? SYNTHETIC_SCENARIOS;
  const limits = opts.limits ?? LEARNING_LIMITS;
  const predict = opts.predict ?? PREDICT[key];
  const rf = opts.code ?? (() => { const f = runtimeFingerprintOf(key); return { verdict: f?.verdict ?? 'UNVERIFIED', fingerprint: f?.source ?? null }; })();
  const started = performance.now();
  const clock = new Clock(limits.busyBudgetMs);

  const results: SyntheticScenarioResult[] = [];
  let abortReason: RunReason | null = null;
  let shots = 0;
  const declaredShots = scenarios.reduce((sum, s) => sum + shotBudgetOf(s), 0);
  if (declaredShots > limits.shotsPerAlgorithmMax) abortReason = 'LIMIT_EXCEEDED';

  for (const s of scenarios) {
    const seed = s.seed + SEED_OFFSET[key];
    if (abortReason) { results.push(unavailable(s, seed, abortReason, zeroMeasured())); continue; }
    try {
      const r = await runScenario(s, seed, predict, clock, limits, rf.verdict);
      shots += r.metrics ? r.metrics.shots + r.metrics.invalid : 0;
      results.push(r);
    } catch (err) {
      abortReason = err instanceof BudgetExceeded ? 'TIME_BUDGET_EXCEEDED' : 'ERROR';
      results.push(unavailable(s, seed, abortReason, zeroMeasured()));
    }
  }
  clock.close();

  return {
    evidence: 'SYNTHETIC', key, code: { verdict: rf.verdict, fingerprint: rf.fingerprint },
    state: abortReason ? 'ABORTED' : 'COMPLETE', abortReason,
    methodChecks: { passed: results.filter((r) => r.methodCheck === 'PASSED').length, total: results.length },
    scenarios: results,
    measured: {
      computedAt: new Date().toISOString(),
      wallMs: performance.now() - started,
      busyMs: clock.busyMs, maxSliceMs: clock.maxSliceMs, slices: clock.slices, yields: clock.yields,
      shots, allocatedBytes: results.reduce((s, r) => s + r.measured.allocatedBytes, 0),
      peakHeapDeltaBytes: Math.max(0, clock.peakHeapDelta),
      peakArrayBuffersDeltaBytes: Math.max(0, clock.peakArrayBuffersDelta),
    },
  };
}

// ── the cache: one run per algorithm and code, shared by concurrent readers ──

const runs = new Map<string, Promise<SyntheticEvaluation>>();
let started = 0;

/**
 * A run stopped by its budget is kept only this long: long enough that a
 * loaded server is not asked again at once, short enough that "stopped" is
 * not the answer for the rest of the process's life.
 */
export const RETRY_ABORTED_AFTER_MS = 60_000;

/**
 * The synthetic evaluation of one algorithm for the code this process runs.
 * Computed on first request (never at boot), shared by every concurrent caller,
 * then served from memory: the inputs are fixed, so the answer cannot change
 * until the code does — and then the fingerprint, and so the key, changes too.
 */
export function syntheticEvaluation(
  key: SyntheticKey,
  runner: (k: SyntheticKey) => Promise<SyntheticEvaluation> = runSyntheticEvaluation,
): { run: Promise<SyntheticEvaluation>; cached: boolean } {
  const f = runtimeFingerprintOf(key);
  const cacheKey = `${key}|${LEARNING_SPEC_VERSION}|${f?.verdict ?? 'UNVERIFIED'}|${f?.source ?? 'none'}`;
  const hit = runs.get(cacheKey);
  if (hit) return { run: hit, cached: true };
  started += 1;
  const run = runner(key);
  runs.set(cacheKey, run);
  const forget = () => { if (runs.get(cacheKey) === run) runs.delete(cacheKey); };
  run.then((r) => {
    if (r.state !== 'ABORTED') return;
    const t = setTimeout(forget, RETRY_ABORTED_AFTER_MS);
    (t as { unref?: () => void }).unref?.();
  }, forget);
  return { run, cached: false };
}

/** How many runs this process has started — for tests of the single-flight rule. */
export function syntheticRunsStarted(): number { return started; }

/** For tests: forget cached runs. */
export function resetSyntheticEvaluations(): void { runs.clear(); started = 0; }
