// Familista — the comparison method checks itself before it judges a candidate
// ─────────────────────────────────────────────────────────────────────────────
// Planted versions with KNOWN differences go through exactly the code a real
// candidate goes through, on seeds no candidate is ever judged on. If the
// method misses a planted difference, invents one between identical versions,
// or misses a planted property breach, no candidate verdict is given at all
// (judge.ts: METHOD_CHECKS_FAILED → Unavailable).
//
// The planted versions are built here from the approved function; none of
// them is a candidate and none is ever proposed.

import { computeXG, type ShotFeatures } from '../../../src/match-events/xg-model.service';
import type { LabMethodCheck } from '../../../src/algorithms/candidate-evidence';
import { METHOD_SEEDS, PROPERTIES, type PropertyId } from '../spec';
import { compareScenario, probeProperties, type Counter } from './compare';
import { distanceToGoal, type Fn } from './shots';
import { outcomeOf } from './properties';

const round4 = (v: number) => +v.toFixed(4);
const logistic = (z: number) => 1 / (1 + Math.exp(-z));
const logitOf = (p: number) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(q / (1 - q)); };

/** Planted: every shot half a log-odds lower — a difference large enough that any working method sees it. */
const shifted: Fn = (f) => round4(logistic(logitOf(computeXG(f)) - 0.5));
/** Planted: an impossible value beyond x = 115. */
const rangeBreach: Fn = (f) => (f.x > 115 ? 1.2 : computeXG(f));
/** Planted: xG halved within 5 m of the goal, so closer is worse there. */
const nearGoalDrop: Fn = (f) => (distanceToGoal(f.x, f.y) < 5 ? round4(computeXG(f) * 0.5) : computeXG(f));
/** Planted: a change on so few shots (x beyond 117.98) that no bracket should be drawn. */
const fewChanges: Fn = (f: ShotFeatures) => (f.x > 117.98 ? round4(Math.min(1, computeXG(f) + 0.05)) : computeXG(f));

export const METHOD_CHECKS: readonly { id: string; title: string; purpose: string; expected: string }[] = [
  { id: 'identical', title: 'Identical versions', purpose: 'The approved version compared with itself: no shot may change, every difference must be exactly zero, and no property may be reported fixed or broken.', expected: 'NO_CHANGE' },
  { id: 'planted-cost', title: 'A planted cost is seen', purpose: 'A version half a log-odds lower everywhere, with outcomes drawn from the approved version: the Brier difference must be positive and its interval clear of zero.', expected: 'COST_SEEN' },
  { id: 'planted-gain', title: 'A planted gain is seen', purpose: 'The same planted version, with outcomes drawn from it: the Brier difference must be negative and its interval clear of zero.', expected: 'GAIN_SEEN' },
  { id: 'probes-catch', title: 'The probes catch planted breaches', purpose: 'One planted version returns 1.2 beyond x = 115 and another halves xG within 5 m of goal: the range and closer-never-worse probes must catch both.', expected: 'CAUGHT' },
  { id: 'below-floor', title: 'Too few changed shots', purpose: 'A planted change on only a handful of shots: no score bracket may be drawn and the sample-size estimate must be marked unstable.', expected: 'NOT_ENOUGH_DATA' },
];

const scenario = { id: 'method', mix: 'step3-mix' as const, shots: 20_000, seed: METHOD_SEEDS.scenario };
const probes = { seed: METHOD_SEEDS.probes, instances: 1_000 };

function violationsOf(fn: Fn, id: PropertyId, counter: Counter): number {
  return probeProperties('xg', probes, computeXG, fn, counter).find((r) => r.id === id)?.candidate.violations ?? 0;
}

/** Run every method check. Deterministic: the same seeds, the same answers. */
export function runMethodChecks(counter: Counter): LabMethodCheck[] {
  const observed: Record<string, string> = {};

  const same = compareScenario(scenario, 'DEVELOPMENT', computeXG, computeXG, counter);
  const sameProps = probeProperties('xg', probes, computeXG, computeXG, counter).map(outcomeOf);
  observed.identical = same.divergence.changed === 0
    && same.worlds.every((w) => w.status === 'NO_DIFFERENCE' && w.brierDelta?.value === 0 && w.required.status === 'UNDEFINED')
    && !sameProps.some((o) => o === 'FIXED' || o === 'BROKEN') ? 'NO_CHANGE' : 'CHANGE_REPORTED';

  const moved = compareScenario(scenario, 'DEVELOPMENT', computeXG, shifted, counter);
  const inApproved = moved.worlds.find((w) => w.world === 'APPROVED');
  const inPlanted = moved.worlds.find((w) => w.world === 'CANDIDATE');
  observed['planted-cost'] = inApproved?.brierDelta && inApproved.brierDelta.low > 0 ? 'COST_SEEN' : 'NOT_SEEN';
  observed['planted-gain'] = inPlanted?.brierDelta && inPlanted.brierDelta.high < 0 ? 'GAIN_SEEN' : 'NOT_SEEN';

  observed['probes-catch'] = violationsOf(rangeBreach, 'range', counter) > 0
    && violationsOf(nearGoalDrop, 'closer-never-worse', counter) > 0 ? 'CAUGHT' : 'MISSED';

  const few = compareScenario(scenario, 'DEVELOPMENT', computeXG, fewChanges, counter);
  observed['below-floor'] = few.divergence.changed > 0
    && few.worlds.every((w) => w.status === 'NOT_ENOUGH_DATA' && w.brierDelta === null && w.required.status === 'UNSTABLE')
    ? 'NOT_ENOUGH_DATA' : 'BRACKET_DRAWN';

  return METHOD_CHECKS.map((m) => ({ ...m, observed: observed[m.id] ?? null, passed: observed[m.id] === m.expected }));
}

// The property set the checks lean on must exist for the algorithm they plant into.
void PROPERTIES.xg;
