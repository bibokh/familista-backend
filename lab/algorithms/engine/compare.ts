// Familista — one candidate against the approved version, on identical shots
// ─────────────────────────────────────────────────────────────────────────────
// For a scenario: draw its shots from its seed, score every shot with BOTH
// versions, and report
//
//   divergence   how many shots change, by how much, and where (distance bands)
//   two worlds   outcomes drawn from each version in turn — with the same
//                uniform draws, so unchanged shots get the same outcome — and
//                the paired Brier and log-loss differences with 95% intervals
//   sample size  the conditional estimate of real shots a paired Brier test
//                would need (stats.ts), or why there is none
//
// A difference is candidate minus approved: positive Brier or log-loss means
// the candidate scored worse IN THAT WORLD, which is built to favour one side.
//
// Pure computation on its inputs. It runs inside a child process (runner.ts),
// never in the server.

import type { ShotFeatures } from '../../../src/match-events/xg-model.service';
import type { LabPhaseResult, LabScenarioResult, LabPropertyResult } from '../../../src/algorithms/candidate-evidence';
import {
  LAB_LIMITS, LAB_RULES, PROPERTIES, STREAM_OFFSET, WORLDS,
  type CandidateAlgorithm, type MixId, type Phase, type ProbeSet, type ScenarioDecl,
} from '../spec';
import { distanceToGoal, drawShot, seeded, type Fn } from './shots';
import { excludesZero, logLoss, pairedInterval, requiredShots, wilson } from './stats';
import { outcomeOf, runProperty, type PropertyRun } from './properties';

export class LabLimitError extends Error {}

export interface Counter { predictions: number }

const isValid = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

/** One scenario, both versions. `phase` labels the result; the seed decides it. */
export function compareScenario(
  decl: { id: string; mix: MixId; shots: number; seed: number }, phase: Phase,
  approved: Fn, candidate: Fn, counter: Counter,
): LabScenarioResult {
  const n = decl.shots;
  if (!(n > 0 && n <= LAB_LIMITS.shotsPerScenarioMax)) throw new LabLimitError(`scenario ${decl.id}: ${n} shots`);
  const shots = seeded(decl.seed + STREAM_OFFSET.shots);
  const outcomes = seeded(decl.seed + STREAM_OFFSET.outcomes);
  const b = new Float64Array(n);
  const c = new Float64Array(n);
  const u = new Float64Array(n);
  const dist = new Float64Array(n);
  const shot: ShotFeatures = { x: 0, y: 0 };
  let invalidA = 0; let invalidC = 0; let valid = 0;
  for (let i = 0; i < n; i += 1) {
    drawShot(decl.mix, shots, shot);
    const pa = approved(shot);
    const pc = candidate(shot);
    const draw = outcomes();
    if (!isValid(pa)) invalidA += 1;
    if (!isValid(pc)) invalidC += 1;
    if (!isValid(pa) || !isValid(pc)) continue;
    b[valid] = pa; c[valid] = pc; u[valid] = draw; dist[valid] = distanceToGoal(shot.x, shot.y);
    valid += 1;
  }
  counter.predictions += 2 * n;

  // ── divergence ──
  const edges = LAB_RULES.distanceBands;
  const bands = edges.map((from, k) => ({ from, to: k + 1 < edges.length ? edges[k + 1] : null, shots: 0, changed: 0, sumDelta: 0 }));
  let changed = 0; let sumAbs = 0; let maxUp = 0; let maxDown = 0;
  for (let i = 0; i < valid; i += 1) {
    const d = c[i] - b[i];
    let k = edges.length - 1;
    while (k > 0 && dist[i] < edges[k]) k -= 1;
    bands[k].shots += 1;
    if (d !== 0) {
      changed += 1; sumAbs += Math.abs(d);
      bands[k].changed += 1; bands[k].sumDelta += d;
      if (d > maxUp) maxUp = d;
      if (d < maxDown) maxDown = d;
    }
  }
  const w = wilson(changed, valid) ?? { low: 0, high: 0 };

  // ── the two worlds ──
  const worlds = WORLDS.map((world) => {
    const t = world.id === 'APPROVED' ? b : c;
    let goals = 0; let sB = 0; let sB2 = 0; let sL = 0; let sL2 = 0;
    for (let i = 0; i < valid; i += 1) {
      const y = u[i] < t[i] ? 1 : 0;
      goals += y;
      const dB = (c[i] - y) ** 2 - (b[i] - y) ** 2;
      const dL = logLoss(c[i], y) - logLoss(b[i], y);
      sB += dB; sB2 += dB * dB; sL += dL; sL2 += dL * dL;
    }
    const truth = t.subarray(0, valid);
    const required = requiredShots(b.subarray(0, valid), c.subarray(0, valid), truth, valid, changed, decl.seed + STREAM_OFFSET.bootstrap);
    if (changed === 0) {
      const zero = { value: 0, low: 0, high: 0 };
      return { world: world.id, goals, status: 'NO_DIFFERENCE' as const, brierDelta: zero, logLossDelta: zero, distinguishable: false, required };
    }
    if (changed < LAB_RULES.minChangedShots) {
      return { world: world.id, goals, status: 'NOT_ENOUGH_DATA' as const, brierDelta: null, logLossDelta: null, distinguishable: null, required };
    }
    const brierDelta = pairedInterval(sB, sB2, valid);
    const logLossDelta = pairedInterval(sL, sL2, valid);
    return {
      world: world.id, goals, status: 'COMPUTED' as const, brierDelta, logLossDelta,
      distinguishable: brierDelta ? excludesZero(brierDelta) : null, required,
    };
  });

  return {
    id: decl.id, phase, mix: decl.mix, shots: n, seed: decl.seed,
    invalid: { approved: invalidA, candidate: invalidC },
    divergence: {
      changed,
      share: { value: valid ? changed / valid : 0, low: w.low, high: w.high },
      meanAbsDelta: valid ? sumAbs / valid : 0,
      maxIncrease: maxUp,
      maxDecrease: maxDown,
      bands: bands.map((x) => ({ from: x.from, to: x.to, shots: x.shots, changed: x.changed, meanDelta: x.changed ? x.sumDelta / x.changed : null })),
    },
    worlds,
  };
}

/** Every declared property of an algorithm, on one probe set. */
export function probeProperties(
  algorithm: CandidateAlgorithm, set: { seed: number; instances: number }, approved: Fn, candidate: Fn, counter: Counter,
): PropertyRun[] {
  if (!(set.instances > 0 && set.instances <= LAB_LIMITS.probeInstancesMax)) throw new LabLimitError(`probe set: ${set.instances} instances`);
  // Each property draws from its own stream, so adding one never moves another's probes.
  return PROPERTIES[algorithm].map((decl, k) => runProperty(decl, approved, candidate, seeded(set.seed + 1_000 * k), set.instances, counter));
}

/** A property run as evidence: its outcome and whether it reached the changed region often enough. */
export function propertyResult(run: PropertyRun, kind: 'RANDOM' | 'FIXED'): LabPropertyResult {
  return {
    id: run.id, instances: run.instances, inRegion: run.inRegion,
    approved: run.approved, candidate: run.candidate,
    outcome: outcomeOf(run),
    covered: kind === 'FIXED' || run.inRegion >= LAB_RULES.minRegionProbes,
  };
}

/** One phase — development or held-out — for one candidate. */
export function evaluatePhase(
  algorithm: CandidateAlgorithm, phase: Phase, scenarios: readonly ScenarioDecl[], probes: ProbeSet,
  approved: Fn, candidate: Fn, counter: Counter,
): LabPhaseResult {
  const mine = scenarios.filter((s) => s.phase === phase);
  if (mine.length > LAB_LIMITS.scenariosMax) throw new LabLimitError(`${mine.length} scenarios`);
  const kinds = new Map(PROPERTIES[algorithm].map((p) => [p.id, p.kind]));
  return {
    phase,
    scenarios: mine.map((s) => compareScenario(s, phase, approved, candidate, counter)),
    properties: probeProperties(algorithm, probes, approved, candidate, counter).map((r) => propertyResult(r, kinds.get(r.id) ?? 'RANDOM')),
  };
}
