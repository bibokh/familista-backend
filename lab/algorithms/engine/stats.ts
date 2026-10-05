// Familista — the lab's statistics: paired differences and a conditional sample size
// ─────────────────────────────────────────────────────────────────────────────
// Both versions see the same shots and the same outcomes, so every comparison
// is PAIRED: one difference per shot, and an interval on their mean. Learning's
// own helpers are reused where they fit (Wilson); its mean interval is not,
// because it clamps at zero and a difference can be negative.
//
// The sample-size estimate answers one conditional question — "if real shots
// looked like this synthetic mix, and real outcomes followed one of the two
// versions, how many shots would a paired Brier test need to tell them
// apart?" — and says when it cannot answer: UNDEFINED when the versions never
// differ, UNSTABLE when too few shots differ or a resample can show no
// difference at all.

import { wilson } from '../../../src/algorithms/learning-stats';
import { LAB_RULES } from '../spec';
import type { LabInterval, LabRequired } from '../../../src/algorithms/candidate-evidence';
import { seeded } from './shots';

export { wilson };

/** Mean of paired differences with a normal-approximation interval; null below two pairs. */
export function pairedInterval(sum: number, sum2: number, n: number, z: number = LAB_RULES.ciZ): LabInterval | null {
  if (n < 2) return null;
  const mean = sum / n;
  const variance = Math.max(0, (sum2 - n * mean * mean) / (n - 1));
  const half = z * Math.sqrt(variance / n);
  if (!Number.isFinite(mean) || !Number.isFinite(half)) return null;
  return { value: mean, low: mean - half, high: mean + half };
}

/** Does an interval exclude zero? */
export const excludesZero = (i: LabInterval) => i.low > 0 || i.high < 0;

const clip = (p: number) => (p < LAB_RULES.probabilityEpsilon ? LAB_RULES.probabilityEpsilon
  : p > 1 - LAB_RULES.probabilityEpsilon ? 1 - LAB_RULES.probabilityEpsilon : p);

/** Log-loss of one prediction, clipped as Learning clips it. */
export function logLoss(p: number, y: number): number {
  const c = clip(p);
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
}

/**
 * The shots a paired Brier test needs, from the exact per-shot conditional
 * moments of the difference d = (c − y)² − (b − y)² with y ~ Bernoulli(t):
 *
 *   E[d | shot] = (c − b)(c + b − 2t)      Var[d | shot] = 4(c − b)² t(1 − t)
 *
 * μ is the mean of E[d | shot]; σ² adds the mean conditional variance to the
 * variance of the conditional means. n = ((z_α + z_β) σ / |μ|)².
 */
export function requiredFromMoments(sumM: number, sumM2: number, sumV: number, n: number): number {
  if (n <= 0) return Infinity;
  const mu = sumM / n;
  if (mu === 0) return Infinity;
  const sigma2 = Math.max(0, sumV / n + sumM2 / n - mu * mu);
  const z = LAB_RULES.zAlpha + LAB_RULES.zPower;
  return (z * z * sigma2) / (mu * mu);
}

/**
 * The conditional sample-size estimate with its bootstrap interval. `b` and `c`
 * are the two versions' outputs on valid shots, `t` the world's truth (one of
 * them). Deterministic for a seed.
 */
export function requiredShots(
  b: Float64Array, c: Float64Array, t: Float64Array, n: number, changed: number, seed: number,
  resamples: number = LAB_RULES.bootstrapResamples,
): LabRequired {
  if (changed === 0) return { status: 'UNDEFINED', point: null, low: null, high: null, reasons: ['NO_DIFFERENCE'] };
  const m = new Float64Array(n);
  const v = new Float64Array(n);
  let sumM = 0; let sumM2 = 0; let sumV = 0;
  for (let i = 0; i < n; i += 1) {
    const d = c[i] - b[i];
    m[i] = d * (c[i] + b[i] - 2 * t[i]);
    v[i] = 4 * d * d * t[i] * (1 - t[i]);
    sumM += m[i]; sumM2 += m[i] * m[i]; sumV += v[i];
  }
  const point = requiredFromMoments(sumM, sumM2, sumV, n);
  const rng = seeded(seed);
  const draws: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let sM = 0; let sM2 = 0; let sV = 0;
    for (let k = 0; k < n; k += 1) {
      const i = Math.floor(rng() * n);
      sM += m[i]; sM2 += m[i] * m[i]; sV += v[i];
    }
    draws.push(requiredFromMoments(sM, sM2, sV, n));
  }
  draws.sort((x, y) => x - y);
  const low = draws[Math.floor(0.025 * resamples)];
  const high = draws[Math.ceil(0.975 * resamples) - 1];
  const reasons: string[] = [];
  if (changed < LAB_RULES.minChangedShots) reasons.push('FEW_CHANGED_SHOTS');
  if (!Number.isFinite(high)) reasons.push('RESAMPLE_WITHOUT_DIFFERENCE');
  if (!Number.isFinite(point)) reasons.push('NO_DIFFERENCE');
  return {
    status: reasons.length ? 'UNSTABLE' : 'ESTIMATED',
    point: Number.isFinite(point) ? point : null,
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
    reasons,
  };
}
