// Familista — the algorithm lab: what Step 4 measures, declared before it measures
// ─────────────────────────────────────────────────────────────────────────────
// Propose → Simulate → Test, for candidates: proposed new versions of an
// approved algorithm. Everything a candidate is judged by is written here,
// once, before any candidate is run — the shot mixes, the seeds, the
// properties, the rules and why each rule is what it is.
//
// THE LAB IS NOT PART OF PRODUCTION
//
// Nothing under lab/ is compiled into dist/ (tsconfig.json compiles src/ only),
// nothing under src/ imports it, and the production server never runs a
// candidate. The lab runs in CI and on a developer's machine, every candidate
// in a child process with a time limit the parent enforces, and writes what it
// found to src/algorithms/generated/candidate-evidence.json. The server reads
// that file and nothing else. The Cybersecurity control
// algorithm-candidate-isolation fails the build if any of this stops holding.
//
// WHAT SYNTHETIC DATA CAN AND CANNOT SAY
//
// Synthetic outcomes have to be drawn from some model. Drawn from the approved
// version, the approved version wins by construction; drawn from the
// candidate, the candidate wins. In expectation the Brier difference is exactly
// plus or minus the mean squared difference between the two versions' outputs.
// So a synthetic score comparison says how much is at stake, never which
// version is right. The lab therefore DECIDES only on what synthetic inputs can
// establish — properties, valid outputs, a comparison method that works, a run
// that finished — and REPORTS score differences as a bracket with their
// uncertainty, never as a winner.

import { LEARNING, SYNTHETIC_SHOTS, type SyntheticKey } from '../../src/algorithms/learning-spec';
import { CANDIDATE_NOTICE } from '../../src/algorithms/candidate-evidence';

export const LAB_SPEC_VERSION = 1;

/**
 * Algorithms a candidate may be proposed for in Step 4: those with a synthetic
 * shot generator AND a declared property set below. Never an algorithm that
 * reads health data (Learning's EXCLUDED_HEALTH list).
 */
export const CANDIDATE_ALGORITHMS = ['xg'] as const;
export type CandidateAlgorithm = typeof CANDIDATE_ALGORITHMS[number];
// A compile-time pin: every candidate algorithm has a synthetic generator.
const _onlySynthetic: readonly SyntheticKey[] = CANDIDATE_ALGORITHMS;
void _onlySynthetic;

/** The function a candidate file must export for each algorithm — the approved symbol's own name. */
export const ENTRY_POINT: Readonly<Record<CandidateAlgorithm, string>> = { xg: 'computeXG' };

export type Phase = 'DEVELOPMENT' | 'HELD_OUT';
export type WorldId = 'APPROVED' | 'CANDIDATE';
export type MixId = 'step3-mix' | 'close-range';

// ── the shots ────────────────────────────────────────────────────────────────

export interface ShotMix { id: MixId; title: string; purpose: string; x: readonly [number, number]; y: readonly [number, number] }

export const SHOT_MIXES: readonly ShotMix[] = [
  {
    id: 'step3-mix',
    title: 'Step 3 shot mix',
    purpose: 'The invented shots Learning uses: from the edge of the area to two metres from goal, with the same body parts, techniques and situations.',
    x: SYNTHETIC_SHOTS.x, y: SYNTHETIC_SHOTS.y,
  },
  {
    id: 'close-range',
    title: 'Close-range shots',
    purpose: 'Shots from inside 12 metres right up to the goal line, where a change near the goal shows most. Used only for the held-out test.',
    x: [108, 120], y: [30, 50],
  },
];

export const WORLDS: readonly { id: WorldId; title: string; meaning: string }[] = [
  {
    id: 'APPROVED',
    title: 'Outcomes drawn from the approved version',
    meaning: 'The approved version is right here by construction, so the candidate can only lose: this shows the most the change could cost.',
  },
  {
    id: 'CANDIDATE',
    title: 'Outcomes drawn from the candidate',
    meaning: 'The candidate is right here by construction, so it can only gain: this shows the most the change could gain.',
  },
];

// ── the seeds: development, held-out and the method's own, never shared ─────

export interface ScenarioDecl { id: string; phase: Phase; mix: MixId; shots: number; seed: number }

/**
 * Simulate works on DEVELOPMENT; the Test verdict reads HELD_OUT only. Every
 * seed here, and every stream derived from it (STREAM_OFFSET), is disjoint
 * from every other and from Learning's (tests pin it).
 */
export const SCENARIOS: readonly ScenarioDecl[] = [
  { id: 'dev-step3', phase: 'DEVELOPMENT', mix: 'step3-mix', shots: 20_000, seed: 40_410_001 },
  { id: 'held-step3', phase: 'HELD_OUT', mix: 'step3-mix', shots: 20_000, seed: 40_420_001 },
  { id: 'held-close', phase: 'HELD_OUT', mix: 'close-range', shots: 20_000, seed: 40_420_002 },
];

export interface ProbeSet { phase: Phase; seed: number; instances: number }
export const PROBE_SETS: readonly ProbeSet[] = [
  { phase: 'DEVELOPMENT', seed: 40_410_101, instances: 4_000 },
  { phase: 'HELD_OUT', seed: 40_420_101, instances: 4_000 },
];

/** The comparison method checks itself on seeds no candidate is ever judged on. */
export const METHOD_SEEDS = { scenario: 40_430_001, probes: 40_430_101 } as const;

/** Shots for the per-call timing only. A timing is measured, never evidence. */
export const TIMING_SEED = 40_440_001;

/** One seed, three independent streams: the shots, their outcomes, the bootstrap. */
export const STREAM_OFFSET = { shots: 0, outcomes: 1_000_000, bootstrap: 2_000_000 } as const;

// ── the properties every version of an algorithm must keep ──────────────────

export type PropertyId =
  | 'range' | 'closer-never-worse' | 'wider-view-never-worse'
  | 'header-never-above-foot' | 'deterministic' | 'penalty-spot-plausible';

export interface PropertyDecl {
  id: PropertyId;
  title: string;
  /** RANDOM: seeded probes; FIXED: one declared input. */
  kind: 'RANDOM' | 'FIXED';
  /** The Step 1 check (src/algorithms/scenarios.ts) this property generalises, verbatim. */
  stepOne: string;
}

/**
 * xG's properties: Step 1's six checks, each generalised from one fixed pair of
 * shots to thousands of seeded probes. Step 1 itself is untouched — it still
 * decides the approved version's gate; these decide nothing about it.
 */
export const PROPERTIES: Readonly<Record<CandidateAlgorithm, readonly PropertyDecl[]>> = {
  xg: [
    { id: 'range', title: 'Every output is a number between 0 and 1', kind: 'RANDOM', stepOne: 'Every shot on a 13 × 9 grid stays between 0 and 1' },
    { id: 'closer-never-worse', title: 'Moving a shot straight towards the goal never lowers its xG', kind: 'RANDOM', stepOne: 'A shot from further out is worth less' },
    { id: 'wider-view-never-worse', title: 'At the same distance, a wider view of the goal is never worth less', kind: 'RANDOM', stepOne: 'A shot from a tight angle is worth less than one from the centre' },
    { id: 'header-never-above-foot', title: 'A header is never worth more than the same shot with the foot', kind: 'RANDOM', stepOne: 'A header is worth less than a shot with the foot' },
    { id: 'deterministic', title: 'The same shot always gets the same value', kind: 'RANDOM', stepOne: 'The same input gives the same output' },
    { id: 'penalty-spot-plausible', title: 'A penalty-spot shot is a likely but not certain goal', kind: 'FIXED', stepOne: 'A penalty-spot shot is a likely but not certain goal' },
  ],
};

// ── the rules, and why ──────────────────────────────────────────────────────

export const LAB_RULES = {
  /** A score bracket is computed only when at least this many shots differ. */
  minChangedShots: 30,
  /** A random property passes only with at least this many probes where the versions differ. */
  minRegionProbes: 100,
  ciZ: LEARNING.ciZ,
  ciLevel: 0.95,
  /** The conditional sample-size estimate: a paired Brier test at this size and power. */
  alpha: 0.05,
  zAlpha: LEARNING.ciZ,
  power: 0.8,
  zPower: LEARNING.powerZ,
  bootstrapResamples: 200,
  probabilityEpsilon: LEARNING.probabilityEpsilon,
  /** Half of every random property's probes fall within this radius of the goal centre. */
  nearGoalShare: 0.5,
  nearGoalRadius: 6,
  /** Distance bands, in metres from the goal centre; the last is open. */
  distanceBands: [0, 2, 4, 8, 16] as readonly number[],
  /** Remaining share of the distance to the goal centre at each point of a ray, far to near. */
  rayFractions: [1, 0.7, 0.5, 0.35, 0.25, 0.17, 0.12, 0.08, 0.05, 0.03, 0.015, 0.005] as readonly number[],
} as const;

export const LAB_JUSTIFICATIONS = {
  minChangedShots: 'Below 30 shots that differ, an average of the differences is too lumpy for a normal-approximation interval — the same 30 Learning requires before it reads a bin.',
  minRegionProbes: 'With 100 probes where the versions differ, a fault present in 3% or more of that region is found with 95% probability (1 − 0.97 to the power 100); with fewer, a pass would say little.',
  bracket: 'Synthetic outcomes have to be drawn from some model. Drawn from either version, that version wins by construction, so the two worlds bound what is at stake rather than name a winner.',
  requiredShots: 'A paired Brier test at 5% two-sided and 80% power, from the exact per-shot mean and variance of the difference; its interval resamples the synthetic shots 200 times.',
  heldOut: 'The verdict reads only held-out seeds and a held-out shot mix that a proposer does not work with. In an open repository they can still be read, so this guards against tuning to sample noise; it is not a blind test.',
  probes: 'Half of every property’s probes fall within 6 metres of the goal centre, so a change near the goal is exercised; the rest cover the attacking half.',
} as const;

/** Said wherever a sample-size estimate is shown. */
export const CONDITIONAL_NOTE = 'Conditional on the synthetic assumptions: if real shots looked like this mix and real outcomes followed one of the two versions. It is not a real-world requirement; real data could need far more shots or far fewer.';

/** The server's own sentence (src/algorithms/candidate-evidence.ts), so the two cannot drift. */
export const LAB_NOTICE = CANDIDATE_NOTICE;

// ── resource limits: declared, enforced, and measured beside each run ───────

export interface LabLimits {
  shotsPerScenarioMax: number;
  scenariosMax: number;
  probeInstancesMax: number;
  bootstrapResamples: number;
  candidatesMax: number;
  /** Wall-clock limit for one child process. The PARENT enforces it: SIGKILL to the process group. */
  jobTimeoutMs: number;
  /** V8 old-space limit for a child process. */
  childHeapMb: number;
  /** Bytes a child may write to stdout before the parent kills it. */
  maxStdoutBytes: number;
  /** Bytes of stderr the parent keeps (the tail); stderr never reaches the evidence. */
  maxStderrBytes: number;
}

export const LAB_LIMITS: Readonly<LabLimits> = {
  shotsPerScenarioMax: 20_000,
  scenariosMax: 6,
  probeInstancesMax: 4_000,
  bootstrapResamples: 200,
  candidatesMax: 5,
  jobTimeoutMs: 60_000,
  childHeapMb: 256,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
};
