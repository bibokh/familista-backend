// Candidate xg-v1.1 — EXPERIMENTAL, NOT APPROVED FOR PRODUCTION
// ─────────────────────────────────────────────────────────────────────────────
// The approved xG (v1.0, src/match-events/xg-model.service.ts) scores the view
// of the goal with sin(opening angle). The opening angle passes 90° inside the
// semicircle of radius 3.66 m drawn on the goal mouth, and past 90° its sine
// falls — so moving a shot closer to goal lowers its xG there. On the central
// line the approved version returns 0.4965 at 3 m, 0.4574 at 2 m, 0.335 at 1 m
// and 0.1927 at 0.1 m.
//
// This candidate clamps the angle at 90° before taking the sine. It is the
// approved code with ONE line changed; every other declaration is copied
// verbatim and keeps its name, so the fingerprint below is the one production
// would carry if this candidate were ever promoted. Outside that semicircle
// every shot keeps exactly the value it has today.
//
// It does not claim the new near-goal values are right. Close-range finishes
// are probably still undervalued, and only real outcomes could say by how
// much. Promotion is not part of Step 4: it would need a separately reviewed
// change recording a human approval of this exact version and fingerprint.
//
// Rules for a candidate file (lab/algorithms/README.md): type-only imports, no
// I/O, no randomness, no clock, no globals — a pure function of its input.

import type { ShotFeatures } from '../../../src/match-events/xg-model.service';
import type { CandidateDeclaration } from '../../../src/algorithms/candidate-evidence';

export const CANDIDATE: CandidateDeclaration = {
  id: 'xg-v1.1',
  algorithm: 'xg',
  version: 'v1.1',
  baseline: { version: 'v1.0', fingerprint: 'c9d12afe302d5d60f4966855a2287e4175b57397d64eed2c9fb4ad25a81dfbe5' },
  rationale: 'The approved model scores the view of the goal with the sine of the opening angle. Within 3.66 m of the goal centre that angle passes 90°, where its sine falls, so moving a shot closer lowers its xG. Clamping the angle at 90° removes that reversal and leaves every shot outside the semicircle exactly as it is.',
  hypothesis: {
    targets: ['closer-never-worse', 'wider-view-never-worse'],
    region: 'Only shots within 3.66 m of the goal centre change, and none of them goes down.',
  },
  evidence: [
    {
      kind: 'MEASUREMENT',
      ref: 'computeXG v1.0 on the central line',
      note: 'The approved version returns 0.4965 at 3 m, 0.4574 at 2 m, 0.335 at 1 m and 0.1927 at 0.1 m from the goal centre.',
    },
    {
      kind: 'GEOMETRY',
      ref: 'semicircle of radius 3.66 m on the goal mouth',
      note: 'Inside a semicircle drawn on the goal mouth the opening angle is wider than 90°, and there its sine shrinks as the angle grows.',
    },
    {
      kind: 'PROPERTY',
      ref: 'Moving a shot straight towards the goal never lowers its xG',
      note: 'Generalises the Step 1 check that a shot from further out is worth less, from one pair of shots to every line towards the goal.',
    },
  ],
  proposedBy: 'AI_ASSISTANT',
  proposedAt: '2026-10-04',
};

// ── the candidate code: the approved declarations, one line changed ─────────

const WEIGHTS = {
  intercept:         -1.523,
  distanceM:         -0.0991,
  angleSin:           1.842,
  headBonus:         -0.380,
  isWeakFoot:        -0.312,
  volleyBonus:       -0.155,
  overheadPenalty:   -0.509,
  isPressuredPenalty:-0.272,
  isCounterBonus:     0.148,
  fromCorner:        -0.294,
  fromFreeKick:      -0.118,
};

const GOAL_X  = 120;
const GOAL_Y  = 40;
const POST_HALF_WIDTH = 3.66;

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function computeXG(f: ShotFeatures): number {
  const dx = GOAL_X - f.x;
  const dy = GOAL_Y - f.y;
  const distanceM = Math.sqrt(dx * dx + dy * dy);

  const d1 = Math.sqrt(dx * dx + Math.pow(dy + POST_HALF_WIDTH, 2));
  const d2 = Math.sqrt(dx * dx + Math.pow(dy - POST_HALF_WIDTH, 2));
  const cosAngle = (d1 * d1 + d2 * d2 - (2 * POST_HALF_WIDTH) ** 2) / (2 * d1 * d2);
  const angleRad = Math.acos(Math.min(1, Math.max(-1, cosAngle)));

  const bp = (f.bodyPart ?? '').toUpperCase();
  const tech = (f.technique ?? '').toUpperCase();

  let logit = WEIGHTS.intercept
    + WEIGHTS.distanceM  * distanceM
    + WEIGHTS.angleSin   * Math.sin(Math.min(angleRad, Math.PI / 2));

  if (bp === 'HEAD')              logit += WEIGHTS.headBonus;
  if (tech === 'VOLLEY')          logit += WEIGHTS.volleyBonus;
  if (tech === 'OVERHEAD_KICK')   logit += WEIGHTS.overheadPenalty;
  if (f.isPressured)              logit += WEIGHTS.isPressuredPenalty;
  if (f.isCounter)                logit += WEIGHTS.isCounterBonus;
  if (f.situation === 'corner')   logit += WEIGHTS.fromCorner;
  if (f.situation === 'free_kick') logit += WEIGHTS.fromFreeKick;

  return +sigmoid(logit).toFixed(4);
}
