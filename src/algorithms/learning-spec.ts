// Familista — what LEARN may conclude, and from what (Algorithms Step 3)
// ─────────────────────────────────────────────────────────────────────────────
// Learning compares what an algorithm said with what happened. Two kinds of
// evidence exist, and this file keeps them apart:
//
//   SYNTHETIC    outcomes generated in this process from a truth declared here.
//                They test the MEASURING METHOD — that a planted error is found
//                and that no error is reported where none was planted. They say
//                nothing about how accurate an algorithm is in the real world.
//   REAL_WORLD   outcomes recorded by clubs. DISABLED: no reader of club data
//                ships with this step. Enabling it is its own reviewed change,
//                with its own approval and a per-club eligibility control.
//
// Health data is never a learning outcome: medical risk, training load and the
// two fusion indices would need injury or fatigue records, and are excluded.
//
// Every figure in this file is a learning parameter. No algorithm reads it, and
// nothing here changes an algorithm: a learning result is evidence for a person.

export type LearnStatus = 'SYNTHETIC_ONLY' | 'DERIVED' | 'NO_GROUND_TRUTH' | 'EXCLUDED_HEALTH';

export interface LearnDecl {
  key: string;
  status: LearnStatus;
  /** Why, in a sentence the owner can read. */
  reason: string;
  /** DERIVED only: the algorithm whose learning covers this one. */
  derivedFrom: string | null;
}

export const LEARN_SPECS: readonly LearnDecl[] = [
  { key: 'xg', status: 'SYNTHETIC_ONLY', derivedFrom: null,
    reason: 'A shot either becomes a goal or it does not, so expected goals can be checked against outcomes. Only synthetic outcomes are used in this step.' },
  { key: 'xgot', status: 'SYNTHETIC_ONLY', derivedFrom: null,
    reason: 'An on-target shot either becomes a goal or it does not, so it can be checked against outcomes. Only synthetic outcomes are used in this step.' },
  { key: 'xa', status: 'DERIVED', derivedFrom: 'xg',
    reason: 'Expected assists are the expected goals of the shot a pass leads to, so what is learned about expected goals covers them. No separate assist outcome is recorded.' },
  { key: 'match-rating', status: 'NO_GROUND_TRUTH', derivedFrom: null,
    reason: 'A rating is a judgement, not a prediction: nothing recorded says what the right rating was.' },
  { key: 'data-confidence', status: 'NO_GROUND_TRUTH', derivedFrom: null,
    reason: 'It describes how complete the data is; there is no later outcome to compare it with.' },
  { key: 'age-curve', status: 'NO_GROUND_TRUTH', derivedFrom: null,
    reason: 'The outcome it anticipates, how a player’s value develops with age, is not recorded.' },
  { key: 'form-trend', status: 'NO_GROUND_TRUTH', derivedFrom: null,
    reason: 'It does not run in production, and no outcome is recorded against its trends.' },
  { key: 'league-eligibility', status: 'NO_GROUND_TRUTH', derivedFrom: null,
    reason: 'A competition rule is correct by definition; whether it is the right rule is a human decision.' },
  { key: 'kickoff-window', status: 'NO_GROUND_TRUTH', derivedFrom: null,
    reason: 'A scheduling rule is correct by definition; whether it is the right rule is a human decision.' },
  { key: 'medical-risk', status: 'EXCLUDED_HEALTH', derivedFrom: null,
    reason: 'Learning it would need injury records, which are health data. Excluded.' },
  { key: 'training-load', status: 'EXCLUDED_HEALTH', derivedFrom: null,
    reason: 'Learning it would need injury records, which are health data. Excluded.' },
  { key: 'biomechanical-load', status: 'EXCLUDED_HEALTH', derivedFrom: null,
    reason: 'Learning it would need injury or fatigue records, which are health data. Excluded.' },
  { key: 'tactical-attrition', status: 'EXCLUDED_HEALTH', derivedFrom: null,
    reason: 'Learning it would need injury or fatigue records, which are health data. Excluded.' },
];

export const learnSpecOf = (key: string): LearnDecl | undefined => LEARN_SPECS.find((s) => s.key === key);

/** The algorithms with synthetic method checks. */
export type SyntheticKey = 'xg' | 'xgot';
export const SYNTHETIC_KEYS: readonly SyntheticKey[] = ['xg', 'xgot'];

// ── the rules a result is judged by ──────────────────────────────────────────

export const LEARNING = {
  /** Fewer expected goals, or expected non-goals, than this: Not enough data. */
  minExpectedEvents: 20,
  /** Each of the two tests runs at this level; together at most 5% (Bonferroni). */
  alphaPerTest: 0.025,
  /** Two-sided critical value for alphaPerTest: Φ⁻¹(1 − 0.025 / 2). */
  testZ: 2.2414,
  /** Power behind the smallest detectable error: Φ⁻¹(0.80). */
  powerZ: 0.8416,
  /** Descriptive intervals — Brier score, log-loss, bins: 95%. */
  ciZ: 1.96,
  /** A bin with fewer shots than this is shown as too few to read. */
  minBinShots: 30,
  /** Probabilities are clipped to [ε, 1 − ε] before a log or a log-odds. */
  probabilityEpsilon: 1e-6,
  /** Fixed bin edges, so results are comparable between runs. Most shots are under 0.3. */
  binEdges: [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1] as readonly number[],
  /** The calibration fit (logistic recalibration by Newton–Raphson). */
  fit: { maxIterations: 50, tolerance: 1e-9, maxStepHalvings: 30, maxAbsCoefficient: 50 },
} as const;

/** Why each rule is what it is — shown beside the rule, in the room. */
export const JUSTIFICATIONS = {
  sampleFloor: 'The calibration fit estimates two parameters; the usual minimum is about ten events per parameter (Peduzzi et al., 1996). The same floor keeps the normal approximation behind the goals test reasonable.',
  miscalibration: 'Each of the two tests runs at α = 0.025, so a perfectly calibrated model is flagged at most 5% of the time (Bonferroni). A standard convention, not tuned to the results.',
  noneDetected: 'Not finding an error is not proof that there is none. How large an error could still hide depends on the sample size, so the room says how large.',
  binDisplay: 'Below about 30 shots a bin’s 95% interval is wider than the differences it would show. A display rule only; no verdict uses the bins.',
  probabilityClip: 'The model rounds to four decimals, so 0 and 1 can occur, and their logarithms are infinite. Every clipped value is counted and shown.',
} as const;

// ── the synthetic world ──────────────────────────────────────────────────────

/** How synthetic outcomes are drawn from the model's own probability p. */
export type Truth =
  | { kind: 'MODEL' }                          // goal ~ Bernoulli(p)
  | { kind: 'LOGIT_SHIFT'; delta: number }     // goal ~ Bernoulli(σ(logit p + δ))
  | { kind: 'LOGIT_SCALE'; factor: number };   // goal ~ Bernoulli(σ(k · logit p))

export type LearnVerdict = 'MISCALIBRATION_DETECTED' | 'NONE_DETECTED' | 'NOT_ENOUGH_DATA' | 'INCONCLUSIVE' | 'UNAVAILABLE';
export type LearnSignal = 'CITL' | 'SLOPE';

export interface SyntheticScenarioDecl {
  id: 'consistent' | 'shifted' | 'overconfident' | 'below-floor';
  title: string;
  /** What a correct measuring method must show, and why that matters. */
  purpose: string;
  truth: Truth;
  /**
   * Fixed shot count, or — for the floor scenario — shots are drawn until the
   * expected goals reach `untilExpectedGoals`, which is set below the floor so
   * the scenario is consistent with the sample rule by construction, whatever
   * the algorithm's average probability.
   */
  size: { shots: number } | { untilExpectedGoals: number; shotCap: number };
  seed: number;
  expect: { verdict: LearnVerdict; signal: LearnSignal | null };
  /** True when the truth IS the model: the check can only prove the method, never the model. */
  circular: boolean;
}

export const SYNTHETIC_SCENARIOS: readonly SyntheticScenarioDecl[] = [
  {
    id: 'consistent', title: 'Model-consistent world',
    purpose: 'Goals are drawn from the model’s own probabilities, so no error exists. A correct method must not report one. Circular by design: it proves the measuring works, not that the model is right.',
    truth: { kind: 'MODEL' }, size: { shots: 20_000 }, seed: 20_261_001,
    expect: { verdict: 'NONE_DETECTED', signal: null }, circular: true,
  },
  {
    id: 'shifted', title: 'Planted error: too few goals predicted',
    purpose: 'Goals are drawn from the model shifted upwards (+0.3 on the log-odds scale, roughly a quarter more goals). A correct method must find this error in the totals.',
    truth: { kind: 'LOGIT_SHIFT', delta: 0.3 }, size: { shots: 20_000 }, seed: 20_261_002,
    expect: { verdict: 'MISCALIBRATION_DETECTED', signal: 'CITL' }, circular: false,
  },
  {
    id: 'overconfident', title: 'Planted error: over-confident model',
    purpose: 'Goals are drawn from a world where the truth is less extreme than the model (log-odds × 0.75). A correct method must find this error in the calibration slope.',
    truth: { kind: 'LOGIT_SCALE', factor: 0.75 }, size: { shots: 20_000 }, seed: 20_261_003,
    expect: { verdict: 'MISCALIBRATION_DETECTED', signal: 'SLOPE' }, circular: false,
  },
  {
    id: 'below-floor', title: 'Below the sample floor',
    purpose: 'Shots are drawn only until 15 goals are expected, under the floor of 20. A correct method must say Not enough data rather than give a verdict.',
    truth: { kind: 'MODEL' }, size: { untilExpectedGoals: 15, shotCap: 1_000 }, seed: 20_261_004,
    expect: { verdict: 'NOT_ENOUGH_DATA', signal: null }, circular: true,
  },
];

/** Each synthetic algorithm draws its own shots: the seed is offset per algorithm. */
export const SEED_OFFSET: Readonly<Record<SyntheticKey, number>> = { xg: 0, xgot: 1_000_000 };

/**
 * The invented shots. Arbitrary, and documented as such: a different mix would
 * give different figures, which is one more reason synthetic results are not
 * evidence about the real world. Tokens are the ones the model reads.
 */
export const SYNTHETIC_SHOTS = {
  /** Uniform over the attacking area of the model's 120 × 80 pitch (goal at x = 120). */
  x: [84, 118] as readonly [number, number],
  y: [18, 62] as readonly [number, number],
  bodyPart: [['FOOT', 0.82], ['HEAD', 0.15], ['OTHER', 0.03]] as ReadonlyArray<readonly [string, number]>,
  technique: [['NORMAL', 0.85], ['VOLLEY', 0.12], ['OVERHEAD_KICK', 0.03]] as ReadonlyArray<readonly [string, number]>,
  situation: [['open_play', 0.8], ['corner', 0.12], ['free_kick', 0.08]] as ReadonlyArray<readonly [string, number]>,
  pressured: 0.4,
  counter: 0.15,
} as const;

// ── resource limits — enforced, and the measured figures shown beside them ──

export interface LearningLimits {
  shotsPerScenarioMax: number;
  shotsPerAlgorithmMax: number;
  sliceShots: number;
  busyBudgetMs: number;
  scenarioBufferBytesMax: number;
}

export const LEARNING_LIMITS: Readonly<LearningLimits> = {
  /** No scenario may draw more shots than this. */
  shotsPerScenarioMax: 20_000,
  /** Across one algorithm's scenarios. */
  shotsPerAlgorithmMax: 65_000,
  /** Work between two yields to the event loop. */
  sliceShots: 1_000,
  /** Busy computation allowed per algorithm; beyond it the run stops and says so. */
  busyBudgetMs: 3_000,
  /** Typed-array memory one scenario may allocate. */
  scenarioBufferBytesMax: 4 * 1024 * 1024,
};

/** Bumped when anything above changes, so a cached result is never reused across a change. */
export const LEARNING_SPEC_VERSION = 1;

/** The real-world lane: disabled, and what enabling it would take. None is met. */
export const REAL_WORLD = {
  state: 'DISABLED' as const,
  reason: 'No club data is evaluated. Real-world learning needs its own approval and eligibility controls, and health data is excluded in every lane.',
  prerequisites: [
    { id: 'owner-approval', label: 'A separate, reviewed approval to evaluate real club data' },
    { id: 'club-eligibility', label: 'A per-club eligibility control, off by default' },
    { id: 'real-data', label: 'Real, non-fictional match data in enough volume' },
    { id: 'security-control', label: 'A Cybersecurity control for cross-club aggregate reads' },
  ],
} as const;

/** The one sentence every synthetic view carries. */
export const SYNTHETIC_NOTICE = 'Synthetic data: these results test the measuring method, not the algorithm’s real-world accuracy.';
