// Familista — the lab's invented shots
// ─────────────────────────────────────────────────────────────────────────────
// The Step 3 mix IS Learning's generator (src/algorithms/learning-synthetic.ts),
// imported, not copied. The close-range mix keeps that generator's body parts,
// techniques and situations and only redraws where the shot was taken.
// Geometry here — distance and opening angle — is computed independently of
// any model, so a property is never checked against the model's own notion of
// the angle.

import { seeded, syntheticShot } from '../../../src/algorithms/learning-synthetic';
import type { ShotFeatures } from '../../../src/match-events/xg-model.service';
import { LAB_RULES, SHOT_MIXES, type MixId } from '../spec';

export type Rng = () => number;
export type Fn = (f: ShotFeatures) => number;
export { seeded };

/** The goal on the model's 120 × 80 pitch. */
export const GOAL = { x: 120, y: 40, halfWidth: 3.66 } as const;

export function mixOf(id: MixId) {
  const m = SHOT_MIXES.find((x) => x.id === id);
  if (!m) throw new Error(`unknown shot mix ${id}`);
  return m;
}

/** One shot from a declared mix, written into `into`. */
export function drawShot(mix: MixId, rng: Rng, into: ShotFeatures): ShotFeatures {
  syntheticShot(rng, into);
  if (mix !== 'step3-mix') {
    const m = mixOf(mix);
    into.x = m.x[0] + rng() * (m.x[1] - m.x[0]);
    into.y = m.y[0] + rng() * (m.y[1] - m.y[0]);
  }
  return into;
}

export const distanceToGoal = (x: number, y: number) => Math.hypot(GOAL.x - x, GOAL.y - y);

/** The angle the goal mouth subtends at (x, y), from the two posts — no model involved. */
export function openingAngle(x: number, y: number): number {
  const a = Math.atan2(GOAL.y - GOAL.halfWidth - y, GOAL.x - x);
  const b = Math.atan2(GOAL.y + GOAL.halfWidth - y, GOAL.x - x);
  return Math.abs(b - a);
}

/** A point in front of the goal at distance r and bearing θ (θ = 0 is straight out). */
export const polar = (r: number, theta: number) => ({ x: GOAL.x - r * Math.cos(theta), y: GOAL.y + r * Math.sin(theta) });

/**
 * Where a property probe is placed: half within LAB_RULES.nearGoalRadius of the
 * goal centre (uniform over that half-disc), half across the attacking half.
 * The shot's other features come from the Step 3 generator.
 */
export function probeShot(rng: Rng, into: ShotFeatures): ShotFeatures {
  syntheticShot(rng, into);
  if (rng() < LAB_RULES.nearGoalShare) {
    const p = polar(LAB_RULES.nearGoalRadius * Math.sqrt(rng()), (rng() - 0.5) * Math.PI * 0.98);
    into.x = p.x; into.y = p.y;
  } else {
    into.x = 60 + rng() * 60;
    into.y = rng() * 80;
  }
  return into;
}

/** Two decimals: where a probe was, as evidence shows it. */
export const at2 = (v: number) => Math.round(v * 100) / 100;
