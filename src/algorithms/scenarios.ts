// Familista — simulation and evaluation
// ─────────────────────────────────────────────────────────────────────────────
// Each scenario runs a REAL production function — the one imported from where
// the platform uses it, never a copy — on fixed synthetic inputs, and
// evaluates what comes back against properties the algorithm must keep: its
// range, its direction, its edge cases, its determinism, the agreement between
// its registered version and the version written in its code.
//
// Every input here is invented for the scenario. No player, club, match or
// sensor record is read: a simulation must be repeatable on any server, and
// must not turn the Algorithms room into a way of reading club data.
//
// Pure and synchronous: running every scenario takes well under a
// millisecond per algorithm and touches nothing outside this process.

import { computeXG, computeXGOT, backfillXA } from '../match-events/xg-model.service';
import {
  biomechanicalLoadIndex, tacticalAttritionIndex, defaultBaseline,
  BLI_WEIGHTS, TAI_WEIGHTS, FUSION_METRICS_VERSION,
} from '../fusion/metrics';
import { computeConfidence, computeMedicalRiskScore, trendDirection, ageDecayFactor } from '../intelligence/shared.utils';
import { eligibilityOf } from '../competition/league-eligibility';
import { validateKickoff, DEFAULT_SCHEDULING_POLICY } from '../competition/match-scheduling';
import type { BiomechanicalLoadIndex } from '../fusion/types';
import { algorithmOf } from './registry';

export interface CheckResult {
  /** What is being checked, in a sentence a reviewer can read. */
  label: string;
  pass: boolean;
  /** What the function returned, rendered as text. */
  observed: string;
  /** What the check required, rendered as text. */
  expected: string;
}

export interface Scenario {
  id: string;
  title: string;
  run: () => CheckResult[];
}

const fmt = (v: unknown): string => (typeof v === 'number' ? String(+v.toFixed(4)) : typeof v === 'string' ? v : JSON.stringify(v));
const between = (label: string, v: number, lo: number, hi: number): CheckResult =>
  ({ label, pass: Number.isFinite(v) && v >= lo && v <= hi, observed: fmt(v), expected: `${lo} – ${hi}` });
const equals = (label: string, v: unknown, want: unknown): CheckResult =>
  ({ label, pass: JSON.stringify(v) === JSON.stringify(want), observed: fmt(v), expected: fmt(want) });
const holds = (label: string, ok: boolean, observed: string, expected: string): CheckResult =>
  ({ label, pass: ok, observed, expected });
const sum = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + v, 0);

// ── shared fixtures (synthetic) ───────────────────────────────────────────────

const PENALTY_SPOT = { x: 108, y: 40 };
const EDGE_OF_BOX = { x: 102, y: 40 };
const LONG_RANGE = { x: 85, y: 40 };
const TIGHT_ANGLE = { x: 118, y: 10 };

function bliAt(scale: number): BiomechanicalLoadIndex {
  const b = defaultBaseline();
  return biomechanicalLoadIndex({
    playerId: 'scenario', windowMs: 60_000,
    accelMagSqSum: b.accelMagSqMean * scale,
    sprintVsqIntegral: b.sprintVsqMean * scale,
    hrStressIntegral: b.hrStressMean * scale,
    jointStrainIntegral: b.jointStrainMean * scale,
    mechanicalWork: b.mechanicalWorkMean * scale,
    baseline: b, computedAt: 0,
  });
}

function taiWith(bli: BiomechanicalLoadIndex, over: Partial<{ biochem: number; sprint: number }> = {}) {
  const b = defaultBaseline();
  return tacticalAttritionIndex({
    playerId: 'scenario', windowMs: 60_000, bli,
    biochemDeltaPerMin: over.biochem ?? b.biochemDeltaMean,
    tacticalDelaySec: b.tacticalDelayMean,
    positionalDeviationM: b.positionalDeviationMean,
    recoveryLagSec: b.recoveryLagMean,
    sprintMaxRatio: over.sprint ?? 1,
    baseline: b, computedAt: 0,
  });
}

// A fixed "now", so a kickoff scenario means the same thing on every run.
const NOW = new Date('2030-03-01T10:00:00Z');

// ── scenarios, per registered algorithm ───────────────────────────────────────

export const SCENARIOS: Readonly<Record<string, readonly Scenario[]>> = {
  xg: [
    {
      id: 'xg-range', title: 'Shots from across the pitch',
      run: () => {
        const grid: number[] = [];
        for (let x = 60; x <= 120; x += 5) for (let y = 0; y <= 80; y += 10) grid.push(computeXG({ x, y }));
        return [
          between('A penalty-spot shot is a likely but not certain goal', computeXG(PENALTY_SPOT), 0.05, 0.95),
          holds('Every shot on a 13 × 9 grid stays between 0 and 1', grid.every((v) => v >= 0 && v <= 1),
            `${grid.filter((v) => v >= 0 && v <= 1).length} / ${grid.length}`, `${grid.length} / ${grid.length}`),
        ];
      },
    },
    {
      id: 'xg-direction', title: 'Distance, angle and body part',
      run: () => {
        const near = computeXG(EDGE_OF_BOX), far = computeXG(LONG_RANGE);
        const centre = computeXG(PENALTY_SPOT), tight = computeXG(TIGHT_ANGLE);
        const foot = computeXG(PENALTY_SPOT), head = computeXG({ ...PENALTY_SPOT, bodyPart: 'HEAD' });
        return [
          holds('A shot from further out is worth less', far < near, `${fmt(far)} < ${fmt(near)}`, '<'),
          holds('A shot from a tight angle is worth less than one from the centre', tight < centre, `${fmt(tight)} < ${fmt(centre)}`, '<'),
          holds('A header is worth less than a shot with the foot', head < foot, `${fmt(head)} < ${fmt(foot)}`, '<'),
        ];
      },
    },
    {
      id: 'xg-determinism', title: 'The same shot, twice',
      run: () => [equals('The same input gives the same output', computeXG(EDGE_OF_BOX), computeXG(EDGE_OF_BOX))],
    },
  ],
  xgot: [
    {
      id: 'xgot-on-target', title: 'A shot that reached the goalkeeper',
      run: () => {
        const xg = computeXG(EDGE_OF_BOX), xgot = computeXGOT(EDGE_OF_BOX);
        return [
          holds('On target is worth at least the pre-shot xG', xgot >= xg, `${fmt(xgot)} ≥ ${fmt(xg)}`, '≥'),
          between('It stays a probability', xgot, 0, 1),
        ];
      },
    },
  ],
  xa: [
    {
      id: 'xa-chain', title: 'A pass, then a shot',
      run: () => {
        const xg = computeXG(PENALTY_SPOT);
        const chain = backfillXA([{ type: 'PASS' as string, xa: null as number | null }, { type: 'SHOT', xg }]);
        const broken = backfillXA([{ type: 'PASS' as string, xa: null as number | null }, { type: 'TACKLE' }, { type: 'SHOT', xg }]);
        return [
          equals('The pass is credited with the shot’s xG', chain[0].xa, xg),
          equals('A tackle in between breaks the chain', broken[0].xa, null),
        ];
      },
    },
  ],
  'biomechanical-load': [
    {
      id: 'bli-baseline', title: 'A session exactly at the player’s baseline',
      run: () => [
        equals('Every component at its baseline mean scores zero', bliAt(1).value, 0),
        between('The weights sum to one', sum(BLI_WEIGHTS), 0.999, 1.001),
      ],
    },
    {
      id: 'bli-extremes', title: 'Extreme sessions',
      run: () => {
        const high = bliAt(50).value, none = bliAt(0).value;
        return [
          between('An extreme session is capped, not unbounded', high, 0, 3),
          holds('More load scores higher than none', high > none, `${fmt(high)} > ${fmt(none)}`, '>'),
        ];
      },
    },
    {
      id: 'bli-version', title: 'Registered version',
      run: () => [equals('The registered version matches the version in the code', FUSION_METRICS_VERSION, algorithmOf('biomechanical-load')?.version)],
    },
  ],
  'tactical-attrition': [
    {
      id: 'tai-range', title: 'Fresh and exhausted',
      run: () => {
        const fresh = taiWith(bliAt(0)).value, tired = taiWith(bliAt(50), { sprint: 0.6 }).value;
        return [
          between('A fresh player’s index is a fraction', fresh, 0, 1),
          between('An exhausted player’s index is a fraction', tired, 0, 1),
          holds('Exhaustion scores higher than freshness', tired > fresh, `${fmt(tired)} > ${fmt(fresh)}`, '>'),
          between('The weights sum to one', sum(TAI_WEIGHTS), 0.999, 1.001),
        ];
      },
    },
    {
      id: 'tai-missing-biochem', title: 'No biochemical patch',
      run: () => [between('A missing lactate reading falls back to a proxy, not to a broken number', taiWith(bliAt(1), { biochem: NaN }).value, 0, 1)],
    },
    {
      id: 'tai-version', title: 'Registered version',
      run: () => [equals('The registered version matches the version in the code', FUSION_METRICS_VERSION, algorithmOf('tactical-attrition')?.version)],
    },
  ],
  'data-confidence': [
    {
      id: 'confidence-levels', title: 'No evidence, and plenty',
      run: () => [
        equals('No evidence at all is no confidence', computeConfidence({ reportCount: 0, hasContract: false, hasMarketValue: false, hasWorkloadData: false, hasVideoClips: false }), 'NONE'),
        equals('Seven reports and every module is high confidence', computeConfidence({ reportCount: 7, hasContract: true, hasMarketValue: true, hasWorkloadData: true, hasVideoClips: true }), 'HIGH'),
      ],
    },
  ],
  'medical-risk': [
    {
      id: 'medical-bounds', title: 'Healthy, and everything at once',
      run: () => [
        equals('A never-injured player at a normal load ratio scores zero', computeMedicalRiskScore({ activeInjuryCount: 0, totalInjuryCount: 0, recentReturnDays: null, acwr: 1.0 }), 0),
        between('Every risk at once is capped at 100', computeMedicalRiskScore({ activeInjuryCount: 3, totalInjuryCount: 20, recentReturnDays: 2, acwr: 2.2 }), 0, 100),
        ((spike) => holds('A load spike raises the score', spike > 0, fmt(spike), '> 0'))(
          computeMedicalRiskScore({ activeInjuryCount: 0, totalInjuryCount: 0, recentReturnDays: null, acwr: 1.6 })),
      ],
    },
  ],
  'form-trend': [
    {
      id: 'trend-direction', title: 'Rising, falling and steady',
      run: () => [
        equals('Rising ratings read as up', trendDirection([60, 62, 66, 70, 75]), 'UP'),
        equals('Falling ratings read as down', trendDirection([75, 70, 66, 62, 60]), 'DOWN'),
        equals('Steady ratings read as flat', trendDirection([70, 70, 71, 70, 70]), 'FLAT'),
      ],
    },
  ],
  'age-curve': [
    {
      id: 'age-shape', title: 'Ages 18 to 40',
      run: () => {
        const ages = Array.from({ length: 23 }, (_, i) => 18 + i).map(ageDecayFactor);
        // Year-on-year rises across the range; there must be none.
        const rises = ages.filter((v, i) => i > 0 && v > ages[i - 1]).length;
        return [
          equals('Full value at 25', ageDecayFactor(25), 1),
          equals('Half value from 34', ageDecayFactor(34), 0.5),
          equals('It never rises with age', rises, 0),
        ];
      },
    },
  ],
  'league-eligibility': [
    {
      id: 'eligibility-verdicts', title: 'A first team, an inactive team and an academy side',
      run: () => [
        equals('An active first team may play', eligibilityOf({ kind: 'SENIOR', isActive: true }).reason, 'OK'),
        equals('An inactive team may not', eligibilityOf({ kind: 'SENIOR', isActive: false }).reason, 'INACTIVE'),
        equals('An academy side may not', eligibilityOf({ kind: 'ACADEMY_U18', isActive: true }).reason, 'NOT_FIRST_TEAM'),
      ],
    },
  ],
  'kickoff-window': [
    {
      id: 'kickoff-verdicts', title: 'Four proposed kickoffs',
      run: () => {
        const check = (at: string) => validateKickoff({ at, timeZone: 'UTC', policy: DEFAULT_SCHEDULING_POLICY, now: NOW }).verdict;
        return [
          equals('An afternoon kickoff next week is allowed', check('2030-03-08T15:00:00Z'), 'OK'),
          equals('A kickoff at three in the morning is refused', check('2030-03-08T03:00:00Z'), 'BEFORE_EARLIEST'),
          equals('A kickoff in the past is refused', check('2030-02-01T15:00:00Z'), 'IN_THE_PAST'),
          equals('Something that is not a date is refused, not guessed', check('next Saturday'), 'MALFORMED'),
        ];
      },
    },
  ],
};

export interface Evaluation {
  state: 'PASS' | 'FAIL' | 'NOT_SIMULATED';
  passed: number;
  total: number;
  scenarios: Array<{ id: string; title: string; pass: boolean; checks: CheckResult[] }>;
}

/** Run every scenario registered for one algorithm. A thrown error is a failed check, never a crash. */
export function evaluate(key: string): Evaluation {
  const list = SCENARIOS[key];
  if (!list || !list.length) return { state: 'NOT_SIMULATED', passed: 0, total: 0, scenarios: [] };
  const scenarios = list.map((s) => {
    let checks: CheckResult[];
    try { checks = s.run(); } catch (err) {
      checks = [{ label: 'The scenario ran without an error', pass: false, observed: (err as Error)?.name ?? 'Error', expected: 'no error' }];
    }
    return { id: s.id, title: s.title, pass: checks.every((c) => c.pass), checks };
  });
  const all = scenarios.flatMap((s) => s.checks);
  const passed = all.filter((c) => c.pass).length;
  return { state: passed === all.length ? 'PASS' : 'FAIL', passed, total: all.length, scenarios };
}
