// Familista — the statistics LEARN uses (Algorithms Step 3)
// ─────────────────────────────────────────────────────────────────────────────
// Pure functions over predicted probabilities p and binary outcomes y. Nothing
// here reads a database, a file or a clock. Every quantity that can fail to
// exist — an infinite log, a fit that does not converge, a variance of zero —
// fails EXPLICITLY, with a reason, and the verdict then says Inconclusive or
// Unavailable instead of a number that would mislead.
//
//   accuracy       Brier score and log-loss, each with a 95% interval
//   calibration    observed vs expected goals (a z-test whose variance is the
//                  model's own, Σ p(1 − p)), and the calibration slope and
//                  intercept from a logistic recalibration of y on logit(p)
//   bins           observed rate per fixed probability bin, Wilson 95% interval
//   resolution     the smallest error in total goals detectable at 80% power

import { LEARNING, type LearnVerdict, type LearnSignal } from './learning-spec';

export interface Interval { value: number; low: number; high: number; level: number }

/** Running sums over one sample. Built in slices; never holds the sample itself. */
export interface Accumulator {
  n: number;
  /** Predictions that were not finite numbers in [0, 1]. Any one makes the result Unavailable. */
  invalid: number;
  /** Predictions moved to [ε, 1 − ε] before a log. */
  clipped: number;
  sumP: number; sumY: number; sumPQ: number;
  sumBrier: number; sumBrier2: number;
  sumLog: number; sumLog2: number;
  bins: Array<{ n: number; sumP: number; sumY: number }>;
}

export function newAccumulator(edges: readonly number[] = LEARNING.binEdges): Accumulator {
  return {
    n: 0, invalid: 0, clipped: 0, sumP: 0, sumY: 0, sumPQ: 0,
    sumBrier: 0, sumBrier2: 0, sumLog: 0, sumLog2: 0,
    bins: Array.from({ length: edges.length - 1 }, () => ({ n: 0, sumP: 0, sumY: 0 })),
  };
}

export const clip = (p: number, eps: number = LEARNING.probabilityEpsilon) => (p < eps ? eps : p > 1 - eps ? 1 - eps : p);
export const logit = (p: number) => Math.log(p / (1 - p));

/** Which fixed bin a probability falls in; the top edge is inclusive. */
export function binOf(p: number, edges: readonly number[] = LEARNING.binEdges): number {
  for (let i = 1; i < edges.length; i++) if (p < edges[i]) return i - 1;
  return edges.length - 2;
}

/** Add one prediction and its outcome. */
export function accumulate(acc: Accumulator, p: number, y: number, edges: readonly number[] = LEARNING.binEdges): void {
  if (!Number.isFinite(p) || p < 0 || p > 1 || (y !== 0 && y !== 1)) { acc.invalid += 1; return; }
  acc.n += 1;
  acc.sumP += p;
  acc.sumY += y;
  acc.sumPQ += p * (1 - p);
  const sq = (p - y) * (p - y);
  acc.sumBrier += sq;
  acc.sumBrier2 += sq * sq;
  const c = clip(p);
  if (c !== p) acc.clipped += 1;
  const ll = -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
  acc.sumLog += ll;
  acc.sumLog2 += ll * ll;
  const b = acc.bins[binOf(p, edges)];
  b.n += 1; b.sumP += p; b.sumY += y;
}

/** Mean with a normal-approximation interval; null when there is nothing to average. */
export function meanInterval(sum: number, sum2: number, n: number, z: number = LEARNING.ciZ): Interval | null {
  if (n < 2) return null;
  const mean = sum / n;
  const variance = Math.max(0, (sum2 - n * mean * mean) / (n - 1));
  const half = z * Math.sqrt(variance / n);
  if (!Number.isFinite(mean) || !Number.isFinite(half)) return null;
  return { value: mean, low: Math.max(0, mean - half), high: mean + half, level: levelOf(z) };
}

/** Wilson score interval for an observed rate; null for an empty bin. */
export function wilson(successes: number, n: number, z: number = LEARNING.ciZ): { low: number; high: number } | null {
  if (n <= 0) return null;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const levelOf = (z: number) => (Math.abs(z - LEARNING.testZ) < 1e-9 ? 0.975 : Math.abs(z - LEARNING.ciZ) < 1e-9 ? 0.95 : 0);

// ── the calibration fit ──────────────────────────────────────────────────────

export type FitFailure =
  | 'NO_VARIATION_IN_OUTCOMES'      // every outcome is the same: no slope exists
  | 'NO_VARIATION_IN_PREDICTIONS'   // every prediction is the same: the slope is not identifiable
  | 'SINGULAR'                      // the information matrix cannot be inverted
  | 'NON_FINITE'                    // a value became infinite or NaN
  | 'SEPARATION'                    // coefficients diverge: outcomes are perfectly separated
  | 'NO_CONVERGENCE';               // did not settle within the iteration limit

export type FitResult =
  | { ok: true; intercept: number; slope: number; seIntercept: number; seSlope: number; iterations: number }
  | { ok: false; reason: FitFailure; iterations: number };

const softplus = (eta: number) => (eta > 0 ? eta + Math.log1p(Math.exp(-eta)) : Math.log1p(Math.exp(eta)));
const sigmoid = (eta: number) => (eta >= 0 ? 1 / (1 + Math.exp(-eta)) : Math.exp(eta) / (1 + Math.exp(eta)));

function logLikelihood(L: Float64Array, y: Uint8Array, n: number, a: number, b: number): number {
  let ll = 0;
  for (let i = 0; i < n; i++) {
    const eta = a + b * L[i];
    ll += y[i] * eta - softplus(eta);
  }
  return ll;
}

/**
 * Logistic recalibration: fit P(y = 1) = σ(a + b · logit p) by Newton–Raphson
 * with step halving, starting from the perfectly calibrated (a, b) = (0, 1).
 * `L` holds logit(clip(p)). `pause` is awaited after every iteration, so a
 * long fit never holds the event loop for more than one pass over the data.
 */
export async function fitCalibration(
  L: Float64Array, y: Uint8Array, n: number,
  pause: () => Promise<void> = async () => undefined,
  opts: { maxIterations: number; tolerance: number; maxStepHalvings: number; maxAbsCoefficient: number } = LEARNING.fit,
): Promise<FitResult> {
  let ones = 0; let lo = Infinity; let hi = -Infinity;
  let min0 = Infinity; let max0 = -Infinity; let min1 = Infinity; let max1 = -Infinity;
  for (let i = 0; i < n; i++) {
    ones += y[i];
    if (!Number.isFinite(L[i])) return { ok: false, reason: 'NON_FINITE', iterations: 0 };
    if (L[i] < lo) lo = L[i];
    if (L[i] > hi) hi = L[i];
    if (y[i]) { if (L[i] < min1) min1 = L[i]; if (L[i] > max1) max1 = L[i]; }
    else { if (L[i] < min0) min0 = L[i]; if (L[i] > max0) max0 = L[i]; }
  }
  if (n === 0 || ones === 0 || ones === n) return { ok: false, reason: 'NO_VARIATION_IN_OUTCOMES', iterations: 0 };
  if (hi - lo < 1e-12) return { ok: false, reason: 'NO_VARIATION_IN_PREDICTIONS', iterations: 0 };
  // With one predictor, the fit has no finite solution exactly when the
  // outcomes are separated by it — every non-goal at or below every goal, or
  // the reverse. Said plainly here rather than discovered as a diverging fit.
  if (max0 <= min1 || max1 <= min0) return { ok: false, reason: 'SEPARATION', iterations: 0 };

  let a = 0; let b = 1;
  let ll = logLikelihood(L, y, n, a, b);
  // Float sums over thousands of terms carry noise far above 1e-12, so "did not
  // get worse" is judged relative to the log-likelihood's own size.
  const noWorse = (next: number, prev: number) => next >= prev - 1e-9 * Math.max(1, Math.abs(prev));
  for (let it = 1; it <= opts.maxIterations; it++) {
    let g0 = 0; let g1 = 0; let i00 = 0; let i01 = 0; let i11 = 0;
    for (let i = 0; i < n; i++) {
      const mu = sigmoid(a + b * L[i]);
      const r = y[i] - mu;
      const w = mu * (1 - mu);
      g0 += r; g1 += r * L[i];
      i00 += w; i01 += w * L[i]; i11 += w * L[i] * L[i];
    }
    const det = i00 * i11 - i01 * i01;
    if (![g0, g1, i00, i01, i11, det].every(Number.isFinite)) return { ok: false, reason: 'NON_FINITE', iterations: it };
    if (det <= 1e-12 * Math.max(1e-300, i00 * i11)) return { ok: false, reason: 'SINGULAR', iterations: it };
    const da = (i11 * g0 - i01 * g1) / det;
    const db = (i00 * g1 - i01 * g0) / det;
    if (!Number.isFinite(da) || !Number.isFinite(db)) return { ok: false, reason: 'NON_FINITE', iterations: it };

    if (Math.max(Math.abs(da), Math.abs(db)) < opts.tolerance) {
      // Converged: standard errors from the information matrix at the solution.
      const seA = Math.sqrt(i11 / det); const seB = Math.sqrt(i00 / det);
      if (!Number.isFinite(seA) || !Number.isFinite(seB)) return { ok: false, reason: 'NON_FINITE', iterations: it };
      return { ok: true, intercept: a, slope: b, seIntercept: seA, seSlope: seB, iterations: it };
    }

    let step = 1; let na = a + da; let nb = b + db;
    let nll = logLikelihood(L, y, n, na, nb);
    let halvings = 0;
    while (!noWorse(nll, ll) && halvings < opts.maxStepHalvings) {
      step /= 2; halvings += 1;
      na = a + step * da; nb = b + step * db;
      nll = logLikelihood(L, y, n, na, nb);
    }
    if (!Number.isFinite(nll) || !Number.isFinite(na) || !Number.isFinite(nb)) return { ok: false, reason: 'NON_FINITE', iterations: it };
    if (Math.abs(na) > opts.maxAbsCoefficient || Math.abs(nb) > opts.maxAbsCoefficient) return { ok: false, reason: 'SEPARATION', iterations: it };
    if (!noWorse(nll, ll)) return { ok: false, reason: 'NO_CONVERGENCE', iterations: it };
    a = na; b = nb; ll = nll;
    await pause();
  }
  return { ok: false, reason: 'NO_CONVERGENCE', iterations: opts.maxIterations };
}

// ── the judgement ────────────────────────────────────────────────────────────

export type JudgementReason =
  | 'NO_SAMPLE'
  | 'NON_FINITE_PREDICTION'
  | 'EXPECTED_GOALS_BELOW_FLOOR'
  | 'EXPECTED_NON_GOALS_BELOW_FLOOR'
  | 'CITL_UNAVAILABLE'
  | `SLOPE_UNAVAILABLE:${FitFailure}`;

export interface BinView {
  from: number; to: number; shots: number;
  meanPredicted: number | null; observedRate: number | null;
  low: number | null; high: number | null;
  /** False below the display minimum: the interval is too wide to read. */
  readable: boolean;
}

export interface Metrics {
  shots: number;
  goals: number;
  expectedGoals: number;
  clipped: number;
  invalid: number;
  brier: Interval | null;
  /** Brier score of always predicting the observed goal rate — context, not a test. */
  brierReference: number | null;
  logLoss: Interval | null;
  /** Observed ÷ expected goals, with the interval the test uses (97.5%). */
  observedOverExpected: Interval | null;
  citl: { z: number; detected: boolean } | null;
  slope: Interval | null;
  intercept: Interval | null;
  slopeDetected: boolean | null;
  fit: { ok: boolean; reason: FitFailure | null; iterations: number };
  /** Average absolute gap between predicted and observed, over bins. Descriptive only. */
  ece: number | null;
  /** Smallest relative error in total goals detectable at 80% power, e.g. 0.065 = 6.5%. */
  minimumDetectableError: number | null;
  bins: BinView[];
}

export interface Judgement { verdict: LearnVerdict; signals: LearnSignal[]; reasons: JudgementReason[] }

export function metricsOf(acc: Accumulator, fit: FitResult | null, edges: readonly number[] = LEARNING.binEdges): Metrics {
  const n = acc.n;
  const E = acc.sumP; const O = acc.sumY; const V = acc.sumPQ;
  const tz = LEARNING.testZ;
  const citl = V > 0 && Number.isFinite(V) ? (() => { const z = (O - E) / Math.sqrt(V); return { z, detected: Math.abs(z) > tz }; })() : null;
  const oe = E > 0 && V > 0
    ? { value: O / E, low: Math.max(0, (O - tz * Math.sqrt(V)) / E), high: (O + tz * Math.sqrt(V)) / E, level: 0.975 }
    : null;
  const ybar = n > 0 ? O / n : null;
  const bins: BinView[] = acc.bins.map((b, i) => {
    const w = wilson(b.sumY, b.n);
    return {
      from: edges[i], to: edges[i + 1], shots: b.n,
      meanPredicted: b.n ? b.sumP / b.n : null,
      observedRate: b.n ? b.sumY / b.n : null,
      low: w ? w.low : null, high: w ? w.high : null,
      readable: b.n >= LEARNING.minBinShots,
    };
  });
  const ece = n > 0 ? acc.bins.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.sumY / b.n - b.sumP / b.n) : 0), 0) : null;
  const fitView = fit ? { ok: fit.ok, reason: fit.ok ? null : fit.reason, iterations: fit.iterations } : { ok: false, reason: null, iterations: 0 };
  const slope = fit && fit.ok ? { value: fit.slope, low: fit.slope - tz * fit.seSlope, high: fit.slope + tz * fit.seSlope, level: 0.975 } : null;
  const intercept = fit && fit.ok ? { value: fit.intercept, low: fit.intercept - tz * fit.seIntercept, high: fit.intercept + tz * fit.seIntercept, level: 0.975 } : null;
  return {
    shots: n, goals: O, expectedGoals: E, clipped: acc.clipped, invalid: acc.invalid,
    brier: meanInterval(acc.sumBrier, acc.sumBrier2, n),
    brierReference: ybar === null ? null : ybar * (1 - ybar),
    logLoss: meanInterval(acc.sumLog, acc.sumLog2, n),
    observedOverExpected: oe,
    citl,
    slope, intercept,
    slopeDetected: slope ? slope.low > 1 || slope.high < 1 : null,
    fit: fitView,
    ece,
    minimumDetectableError: E > 0 && V > 0 ? ((LEARNING.testZ + LEARNING.powerZ) * Math.sqrt(V)) / E : null,
    bins,
  };
}

/**
 * The verdict, in the order that keeps it honest:
 *   a broken input       → UNAVAILABLE
 *   under the floor      → NOT_ENOUGH_DATA (no test is read)
 *   either test fires    → MISCALIBRATION_DETECTED (each test alone is valid at its level)
 *   a test could not run → INCONCLUSIVE (one test is not enough to say "none")
 *   otherwise            → NONE_DETECTED — never "calibrated": shown with the
 *                          smallest error that could still hide
 */
export function judge(m: Metrics): Judgement {
  if (m.invalid > 0) return { verdict: 'UNAVAILABLE', signals: [], reasons: ['NON_FINITE_PREDICTION'] };
  if (m.shots === 0) return { verdict: 'NOT_ENOUGH_DATA', signals: [], reasons: ['NO_SAMPLE'] };
  const floor: JudgementReason[] = [];
  if (m.expectedGoals < LEARNING.minExpectedEvents) floor.push('EXPECTED_GOALS_BELOW_FLOOR');
  if (m.shots - m.expectedGoals < LEARNING.minExpectedEvents) floor.push('EXPECTED_NON_GOALS_BELOW_FLOOR');
  if (floor.length) return { verdict: 'NOT_ENOUGH_DATA', signals: [], reasons: floor };

  const signals: LearnSignal[] = [];
  if (m.citl?.detected) signals.push('CITL');
  if (m.slopeDetected) signals.push('SLOPE');
  const missing: JudgementReason[] = [];
  if (!m.citl) missing.push('CITL_UNAVAILABLE');
  if (!m.fit.ok) missing.push(`SLOPE_UNAVAILABLE:${m.fit.reason ?? 'NO_CONVERGENCE'}`);
  if (signals.length) return { verdict: 'MISCALIBRATION_DETECTED', signals, reasons: missing };
  if (missing.length) return { verdict: 'INCONCLUSIVE', signals: [], reasons: missing };
  return { verdict: 'NONE_DETECTED', signals: [], reasons: [] };
}
