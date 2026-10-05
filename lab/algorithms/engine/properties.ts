// Familista — property probes: what every version of xG must keep
// ─────────────────────────────────────────────────────────────────────────────
// Each property is checked on BOTH versions with the SAME seeded probes, so
// the outcome compares like with like:
//
//   KEPT           both versions keep it
//   FIXED          the approved version breaks it, the candidate keeps it
//   BROKEN         the approved version keeps it, the candidate breaks it
//   STILL_FAILING  both break it — reported, and not the candidate's doing
//
// A probe is "in the region" when the two versions give different values
// anywhere on it; a random property needs LAB_RULES.minRegionProbes such
// probes before its result is trusted (the judge reads `inRegion`).
//
// The first violation each version produces is kept as an example — where the
// probe was and what came back — so a reviewer can reproduce it by hand.

import type { ShotFeatures } from '../../../src/match-events/xg-model.service';
import type { LabPropertyResult } from '../../../src/algorithms/candidate-evidence';
import { LAB_RULES, type PropertyDecl, type PropertyId } from '../spec';
import { GOAL, at2, openingAngle, polar, probeShot, type Fn, type Rng } from './shots';

type Example = NonNullable<LabPropertyResult['approved']['example']>;

interface Side { violations: number; invalid: number; example: Example | null }
export interface PropertyRun {
  id: PropertyId;
  instances: number;
  inRegion: number;
  approved: Side;
  candidate: Side;
}

const isValid = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
const same = (a: number, b: number) => Object.is(a, b);
const copy = (f: ShotFeatures): ShotFeatures => ({ ...f });
const pointOf = (f: ShotFeatures) => ({ x: at2(f.x), y: at2(f.y), bodyPart: f.bodyPart ?? 'FOOT' });
const valueOf = (v: number) => (Number.isFinite(v) ? v : null);

function side(): Side { return { violations: 0, invalid: 0, example: null }; }

/**
 * One probe, evaluated on both versions. `check` receives each version's
 * values at the probe's points and says whether the property was violated.
 */
function probe(
  run: PropertyRun, approved: Fn, candidate: Fn, points: ShotFeatures[],
  check: (values: number[]) => boolean, counter: { predictions: number },
): void {
  const a = points.map((p) => approved(p));
  const c = points.map((p) => candidate(p));
  counter.predictions += 2 * points.length;
  run.instances += 1;
  if (a.some((v, i) => !same(v, c[i]))) run.inRegion += 1;
  for (const [s, vals] of [[run.approved, a], [run.candidate, c]] as const) {
    const invalid = vals.some((v) => !isValid(v));
    if (invalid) s.invalid += 1;
    if (invalid || check(vals)) {
      s.violations += 1;
      if (!s.example) s.example = { points: points.map(pointOf), values: vals.map(valueOf) };
    }
  }
}

/** Fixed edge inputs the range property always includes: corners, the goal line, the posts' lines. */
const EDGE_X = [0, 60, 102, 108, 114, 118, 119, 119.9, 120];
const EDGE_Y = [0, 18, 36.34, 40, 43.66, 62, 80];

const PROBES: Readonly<Record<PropertyId, (run: PropertyRun, a: Fn, c: Fn, rng: Rng, n: number, counter: { predictions: number }) => void>> = {
  range(run, a, c, rng, n, counter) {
    const f: ShotFeatures = { x: 0, y: 0 };
    for (let i = 0; i < n; i += 1) {
      probeShot(rng, f);
      probe(run, a, c, [copy(f)], () => false, counter);
    }
    for (const x of EDGE_X) for (const y of EDGE_Y) for (const bodyPart of ['FOOT', 'HEAD']) {
      probe(run, a, c, [{ x, y, bodyPart }], () => false, counter);
    }
  },

  'closer-never-worse'(run, a, c, rng, n, counter) {
    const f: ShotFeatures = { x: 0, y: 0 };
    for (let i = 0; i < n; i += 1) {
      probeShot(rng, f);
      const points = LAB_RULES.rayFractions.map((r) => ({ ...f, x: GOAL.x + r * (f.x - GOAL.x), y: GOAL.y + r * (f.y - GOAL.y) }));
      // Far to near: a later (closer) value below an earlier one is a violation.
      probe(run, a, c, points, (v) => v.some((x, k) => k > 0 && x < v[k - 1]), counter);
    }
  },

  'wider-view-never-worse'(run, a, c, rng, n, counter) {
    const f: ShotFeatures = { x: 0, y: 0 };
    for (let i = 0; i < n; i += 1) {
      probeShot(rng, f);
      const r = rng() < LAB_RULES.nearGoalShare
        ? 0.05 + (LAB_RULES.nearGoalRadius - 0.05) * Math.sqrt(rng())
        : LAB_RULES.nearGoalRadius + rng() * 24;
      const p1 = polar(r, (rng() - 0.5) * Math.PI * 0.98);
      const p2 = polar(r, (rng() - 0.5) * Math.PI * 0.98);
      const w1 = openingAngle(p1.x, p1.y);
      const w2 = openingAngle(p2.x, p2.y);
      // Same distance, same shot otherwise; the point with the wider view first.
      const [wide, narrow] = w1 >= w2 ? [p1, p2] : [p2, p1];
      const tie = Math.abs(w1 - w2) < 1e-9;
      probe(run, a, c, [{ ...f, ...wide }, { ...f, ...narrow }], (v) => !tie && v[0] < v[1], counter);
    }
  },

  'header-never-above-foot'(run, a, c, rng, n, counter) {
    const f: ShotFeatures = { x: 0, y: 0 };
    for (let i = 0; i < n; i += 1) {
      probeShot(rng, f);
      probe(run, a, c, [{ ...f, bodyPart: 'FOOT' }, { ...f, bodyPart: 'HEAD' }], (v) => v[1] > v[0], counter);
    }
  },

  deterministic(run, a, c, rng, n, counter) {
    const f: ShotFeatures = { x: 0, y: 0 };
    for (let i = 0; i < n; i += 1) {
      probeShot(rng, f);
      probe(run, a, c, [copy(f), copy(f)], (v) => !same(v[0], v[1]), counter);
    }
  },

  'penalty-spot-plausible'(run, a, c, _rng, _n, counter) {
    probe(run, a, c, [{ x: 108, y: 40 }], (v) => !(v[0] >= 0.05 && v[0] <= 0.95), counter);
  },
};

/** Run one declared property on both versions, from its own seeded stream. */
export function runProperty(
  decl: PropertyDecl, approved: Fn, candidate: Fn, rng: Rng, instances: number, counter: { predictions: number },
): PropertyRun {
  const run: PropertyRun = { id: decl.id, instances: 0, inRegion: 0, approved: side(), candidate: side() };
  PROBES[decl.id](run, approved, candidate, rng, instances, counter);
  return run;
}

export const holds = (s: Side) => s.violations === 0 && s.invalid === 0;

/** KEPT / FIXED / BROKEN / STILL_FAILING, comparing like with like. */
export function outcomeOf(run: PropertyRun): LabPropertyResult['outcome'] {
  const a = holds(run.approved);
  const c = holds(run.candidate);
  if (a && c) return 'KEPT';
  if (!a && c) return 'FIXED';
  if (a && !c) return 'BROKEN';
  return 'STILL_FAILING';
}
