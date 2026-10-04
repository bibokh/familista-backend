// Familista — the Algorithm Registry
// ─────────────────────────────────────────────────────────────────────────────
// Every algorithm that turns recorded football data into a number, a verdict
// or a rating somebody acts on is listed here: what it is, which domain it
// belongs to, its version, what goes in and what comes out, the source
// declarations it is made of, the tests that pin it, and the human approval
// that let its current form into production.
//
// THIS FILE IS THE APPROVAL RECORD
//
// An algorithm's `approval` names the version and the source fingerprint the
// platform owner approved, and the reviewed pull request that carried it. The
// fingerprint is computed from the declarations in `source.symbols` by
// scripts/algorithms-discover.js (comments and whitespace ignored). Change the
// code and the fingerprint moves; tests/algorithms.unit.test.ts then fails
// until this file records a new version and a new approval — and that edit is
// itself reviewed, because this file is code-owned. So an algorithmic change
// reaches main, and production, only with a human approval in its own diff.
//
// The first approvals below are BASELINES: the algorithms exactly as they were
// already running in production when the registry was created. They become
// approvals when the platform owner merges the pull request that introduces
// them, and they say so.
//
// Step 1 is READ/ANALYZE-ONLY. Every algorithm is `READ_ANALYZE`; the loop gate
// refuses any other mode, and nothing in src/algorithms changes a running
// algorithm, a weight or a setting.
//
// FORMAT NOTE — scripts/algorithms-discover.js reads `key:` and
// `source: { file: '…', symbols: [ … ] }` from this file with a narrow
// pattern. Keep each on the shape used below; the unit test proves every
// entry was read.

import type { AlgorithmMode, ApprovalRecord } from './loop';

export interface AlgorithmDomain {
  id: string;
  title: string;
  describes: string;
}

export interface AlgorithmPort {
  name: string;
  /** Unit or range, in plain words. Empty when there is none. */
  unit: string;
}

export interface AlgorithmVersion {
  version: string;
  date: string;
  note: string;
}

export interface AlgorithmDecl {
  key: string;
  name: string;
  domain: string;
  version: string;
  summary: string;
  /** Where in the product its output is read. */
  usedBy: string[];
  inputs: AlgorithmPort[];
  outputs: AlgorithmPort[];
  source: { file: string; symbols: string[] };
  /** Another registered algorithm whose output this one is built on. */
  dependsOn: string[];
  mode: AlgorithmMode;
  /** Unit tests that exercise it, beyond the registry's own evaluation. */
  tests: string[];
  /**
   * Why it has no registered simulation, when it has none. A simulation runs
   * the real function on fixed synthetic inputs; a routine whose arithmetic is
   * written inside a database transaction cannot be run that way.
   */
  notSimulatedBecause: string | null;
  approval: (ApprovalRecord & { kind: 'BASELINE' | 'CHANGE' }) | null;
  versions: AlgorithmVersion[];
}

export const ALGORITHM_DOMAINS: readonly AlgorithmDomain[] = [
  { id: 'match-analytics', title: 'Match analytics', describes: 'Chance quality and creation, from recorded match events.' },
  { id: 'performance-load', title: 'Performance & workload', describes: 'Training load, fatigue and readiness, from GPS and sensor sessions.' },
  { id: 'player-intelligence', title: 'Player intelligence', describes: 'Scores and verdicts that inform recruitment, medical and squad decisions.' },
  { id: 'competition-rules', title: 'Competition rules', describes: 'Who may play, and when a match may be scheduled.' },
];

// The pull request that introduces the registry. A baseline approval takes
// effect when the platform owner merges it.
const BASELINE_REF = 'bibokh/familista-backend — Algorithms Step 1 (baseline)';
const BASELINE_AT = '2026-10-04';
const baseline = (version: string, fingerprint: string) => ({
  kind: 'BASELINE' as const, version, fingerprint, approvedBy: 'PLATFORM_OWNER' as const,
  reference: BASELINE_REF, approvedAt: BASELINE_AT,
});
const firstVersion = (version: string): AlgorithmVersion[] => [
  { version, date: BASELINE_AT, note: 'Baseline: the algorithm as it already runs in production.' },
];

export const ALGORITHMS: readonly AlgorithmDecl[] = [
  // ── match analytics ──
  {
    key: 'xg',
    name: 'Expected goals (xG)',
    domain: 'match-analytics',
    version: 'v1.0',
    summary: 'The probability that a shot becomes a goal, from where it was taken and how. A logistic model with fixed, calibrated weights.',
    usedBy: ['Match Centre', 'Player statistics'],
    inputs: [
      { name: 'Shot position', unit: 'x, y on a 120 × 80 pitch' },
      { name: 'Body part', unit: '' },
      { name: 'Technique', unit: '' },
      { name: 'Under pressure', unit: 'yes / no' },
      { name: 'Counter-attack', unit: 'yes / no' },
      { name: 'Set-piece situation', unit: '' },
    ],
    outputs: [{ name: 'Goal probability', unit: '0 – 1' }],
    source: { file: 'src/match-events/xg-model.service.ts', symbols: ['WEIGHTS', 'GOAL_X', 'GOAL_Y', 'POST_HALF_WIDTH', 'sigmoid', 'computeXG'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: [],
    notSimulatedBecause: null,
    approval: baseline('v1.0', 'c9d12afe302d5d60f4966855a2287e4175b57397d64eed2c9fb4ad25a81dfbe5'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'xgot',
    name: 'Expected goals on target (xGOT)',
    domain: 'match-analytics',
    version: 'v1.0',
    summary: 'The goal probability of a shot that reached the goalkeeper, conditioned on it being on target.',
    usedBy: ['Match Centre'],
    inputs: [
      { name: 'Shot features', unit: 'as for xG' },
      { name: 'Target point', unit: 'optional' },
    ],
    outputs: [{ name: 'Goal probability on target', unit: '0 – 1' }],
    source: { file: 'src/match-events/xg-model.service.ts', symbols: ['computeXGOT'] },
    dependsOn: ['xg'],
    mode: 'READ_ANALYZE',
    tests: [],
    notSimulatedBecause: null,
    approval: baseline('v1.0', 'ee86488f712bb3883b79d779db0bebef852825ab281129b40cad00efa58bb05f'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'xa',
    name: 'Expected assists (xA)',
    domain: 'match-analytics',
    version: 'v1.0',
    summary: 'Credits the last pass before a shot with that shot’s xG, while possession is unbroken.',
    usedBy: ['Match Centre', 'Player statistics'],
    inputs: [{ name: 'Ordered match events', unit: 'with xG on shots' }],
    outputs: [{ name: 'xA on the key pass', unit: '0 – 1' }, { name: 'Key-pass flag', unit: 'yes / no' }],
    source: { file: 'src/match-events/xg-model.service.ts', symbols: ['backfillXA'] },
    dependsOn: ['xg'],
    mode: 'READ_ANALYZE',
    tests: [],
    notSimulatedBecause: null,
    approval: baseline('v1.0', 'fad1e834d9dad612191a2da4d68da94876565a59d7bc6c61846b38ac34124ad8'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'match-rating',
    name: 'Player match statistics & rating',
    domain: 'match-analytics',
    version: 'v1.0',
    summary: 'Rebuilds every player’s statistics for a match from its events, and rates the performance.',
    usedBy: ['Player statistics', 'Player Intelligence Center'],
    inputs: [{ name: 'Match events', unit: 'one match' }],
    outputs: [{ name: 'Per-player match statistics', unit: '' }, { name: 'Match rating', unit: '' }],
    source: { file: 'src/player-stats/player-stats.service.ts', symbols: ['computeRating', 'computeMatchStats'] },
    dependsOn: ['xg', 'xa'],
    mode: 'READ_ANALYZE',
    tests: ['tests/player-stats-assist-only.unit.test.ts', 'tests/stats-aggregation-race.unit.test.ts'],
    notSimulatedBecause: 'Its arithmetic runs inside the database transaction that stores the result, so it cannot be run on a synthetic scenario. Its unit tests cover it instead.',
    approval: baseline('v1.0', '39f41d381512a1c3dfdc00ae52c9042895c75b5d314ce80636b465408501f690'),
    versions: firstVersion('v1.0'),
  },
  // ── performance & workload ──
  {
    key: 'training-load',
    name: 'Training load (ATL · CTL · TSB · ACWR)',
    domain: 'performance-load',
    version: 'v1.0',
    summary: 'Acute and chronic load as exponentially weighted averages of 28 days of sessions, their balance and ratio, monotony, strain and a rule-based injury-risk score.',
    usedBy: ['Squad Readiness', 'Medical'],
    inputs: [{ name: 'GPS session load', unit: 'last 28 days' }],
    outputs: [
      { name: 'Acute load (ATL)', unit: '' },
      { name: 'Chronic load (CTL)', unit: '' },
      { name: 'Training stress balance (TSB)', unit: '' },
      { name: 'Acute:chronic ratio (ACWR)', unit: '' },
      { name: 'Injury-risk score', unit: '0 – 1' },
    ],
    source: { file: 'src/workload/workload-science.service.ts', symbols: ['recomputeWorkload', 'computeInjuryRiskScore'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: [],
    notSimulatedBecause: 'The load arithmetic is written inside the routine that reads sessions from the database and stores the result, so it cannot be run on a synthetic scenario. Moving it into a pure function is the change that would let it be simulated.',
    approval: baseline('v1.0', 'e6e25c9477251d23823be94972944c3fc632f452effa3b29cea635257d8c7675'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'biomechanical-load',
    name: 'Biomechanical Load Index (BLI)',
    domain: 'performance-load',
    version: 'v1.0',
    summary: 'A weighted sum of five load components, each a z-score against the player’s own seven-day baseline and capped at ±3.',
    usedBy: ['Sensor fusion', 'Squad Readiness'],
    inputs: [
      { name: 'Acceleration load', unit: '' },
      { name: 'Sprint load', unit: '' },
      { name: 'Heart-rate stress', unit: '' },
      { name: 'Joint strain', unit: '' },
      { name: 'Mechanical work', unit: '' },
      { name: 'Player baseline', unit: 'last 7 days' },
    ],
    outputs: [{ name: 'Load index', unit: 'about −3 to +3' }],
    source: { file: 'src/fusion/metrics.ts', symbols: ['FUSION_METRICS_VERSION', 'BLI_WEIGHTS', 'clamp', 'zscore', 'biomechanicalLoadIndex'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: [],
    notSimulatedBecause: null,
    approval: baseline('v1.0', '77e2526c81d7086da67b427bd09b8a1ac98e22ef7849cd5d137643c4e4259528'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'tactical-attrition',
    name: 'Tactical Attrition Index (TAI)',
    domain: 'performance-load',
    version: 'v1.0',
    summary: 'How close a player is to a substitution, an injury or a tactical breakdown: seven components mapped to 0–1 and weighted.',
    usedBy: ['Sensor fusion', 'Live match'],
    inputs: [
      { name: 'Load index (BLI)', unit: '' },
      { name: 'Biochemical fatigue', unit: 'optional' },
      { name: 'Tactical reaction delay', unit: 'seconds' },
      { name: 'Positional deviation', unit: 'metres' },
      { name: 'Recovery between sprints', unit: 'seconds' },
      { name: 'Sprint degradation', unit: 'ratio' },
    ],
    outputs: [{ name: 'Attrition index', unit: '0 – 1' }],
    source: { file: 'src/fusion/metrics.ts', symbols: ['FUSION_METRICS_VERSION', 'TAI_WEIGHTS', 'sigmoid', 'clamp', 'zscore', 'tacticalAttritionIndex'] },
    dependsOn: ['biomechanical-load'],
    mode: 'READ_ANALYZE',
    tests: [],
    notSimulatedBecause: null,
    approval: baseline('v1.0', 'cc896039b3a715e04c887aba0bce7d626799e1e8f569bd7435d325960f007e2f'),
    versions: firstVersion('v1.0'),
  },
  // ── player intelligence ──
  {
    key: 'data-confidence',
    name: 'Data confidence',
    domain: 'player-intelligence',
    version: 'v1.0',
    summary: 'How much a player assessment can be trusted, from how much evidence exists behind it.',
    usedBy: ['Player Intelligence Center', 'Scouting'],
    inputs: [
      { name: 'Scouting reports', unit: 'count' },
      { name: 'Contract known', unit: 'yes / no' },
      { name: 'Market value known', unit: 'yes / no' },
      { name: 'Workload data', unit: 'yes / no' },
      { name: 'Video clips', unit: 'yes / no' },
    ],
    outputs: [{ name: 'Confidence', unit: 'none · low · medium · high' }],
    source: { file: 'src/intelligence/shared.utils.ts', symbols: ['computeConfidence'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: ['tests/unified-intelligence.unit.test.ts'],
    notSimulatedBecause: null,
    approval: baseline('v1.0', '90640dd6fa2588f7c01f4f674ecc34bea49f90b54cd70021058c6ad7acc73685'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'medical-risk',
    name: 'Medical risk score',
    domain: 'player-intelligence',
    version: 'v1.0',
    summary: 'How unavailable or injury-prone a player is, from active and past injuries, the load ratio and recent returns to play.',
    usedBy: ['Player Intelligence Center', 'Medical'],
    inputs: [
      { name: 'Active injuries', unit: 'count' },
      { name: 'Past injuries', unit: 'count' },
      { name: 'Acute:chronic ratio (ACWR)', unit: 'optional' },
      { name: 'Days since return to play', unit: 'optional' },
    ],
    outputs: [{ name: 'Risk score', unit: '0 – 100' }],
    source: { file: 'src/intelligence/shared.utils.ts', symbols: ['computeMedicalRiskScore'] },
    dependsOn: ['training-load'],
    mode: 'READ_ANALYZE',
    tests: ['tests/unified-intelligence.unit.test.ts'],
    notSimulatedBecause: null,
    approval: baseline('v1.0', 'e0e3daa0c26e175ab2b8b2a8cc50a685a6510021be1e4745740369651b19dc21'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'form-trend',
    name: 'Form trend',
    domain: 'player-intelligence',
    version: 'v1.0',
    summary: 'Whether a series of ratings is rising, falling or flat, comparing the later half with the earlier one.',
    usedBy: ['Player Intelligence Center'],
    inputs: [{ name: 'Value series', unit: 'oldest first' }],
    outputs: [{ name: 'Direction', unit: 'up · down · flat' }],
    source: { file: 'src/intelligence/shared.utils.ts', symbols: ['trendDirection'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: ['tests/unified-intelligence.unit.test.ts'],
    notSimulatedBecause: null,
    approval: baseline('v1.0', '2a33bcbe5ed6572834d86ca516b5d769f5782dceda4214f94b7decde451921ea'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'age-curve',
    name: 'Age value curve',
    domain: 'player-intelligence',
    version: 'v1.0',
    summary: 'A future-value multiplier by age: full to 27, a linear decline to 33, and half from 34.',
    usedBy: ['Player Intelligence Center', 'Transfers'],
    inputs: [{ name: 'Age', unit: 'years' }],
    outputs: [{ name: 'Value multiplier', unit: '0.5 – 1' }],
    source: { file: 'src/intelligence/shared.utils.ts', symbols: ['ageDecayFactor'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: ['tests/unified-intelligence.unit.test.ts'],
    notSimulatedBecause: null,
    approval: baseline('v1.0', '9012ce4801462dbb7c488732a2ebfc2bc7ae96f60571093815f08d582f0942eb'),
    versions: firstVersion('v1.0'),
  },
  // ── competition rules ──
  {
    key: 'league-eligibility',
    name: 'Familista League eligibility',
    domain: 'competition-rules',
    version: 'v1.0',
    summary: 'Whether a team may play in the Familista League, and why not when it may not.',
    usedBy: ['Competition Center', 'Manage Teams'],
    inputs: [{ name: 'Team kind', unit: '' }, { name: 'Active', unit: 'yes / no' }],
    outputs: [{ name: 'Verdict', unit: 'eligible, or a reason' }],
    source: { file: 'src/competition/league-eligibility.ts', symbols: ['FIRST_TEAM_KINDS', 'eligibilityOf'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: ['tests/familista-league.unit.test.ts'],
    notSimulatedBecause: null,
    approval: baseline('v1.0', '4a46fb79e8251a527ff149af6b64830a8aa79af09200745e6a699c5db34c35bc'),
    versions: firstVersion('v1.0'),
  },
  {
    key: 'kickoff-window',
    name: 'Kickoff window check',
    domain: 'competition-rules',
    version: 'v1.0',
    summary: 'Whether a proposed kickoff is valid, in the future and inside the competition’s allowed hours at the venue’s own time.',
    usedBy: ['Competition Center', 'Match Centre'],
    inputs: [
      { name: 'Proposed kickoff', unit: 'instant' },
      { name: 'Venue time zone', unit: '' },
      { name: 'Scheduling policy', unit: 'earliest and latest kickoff' },
    ],
    outputs: [{ name: 'Verdict', unit: 'allowed, or a reason' }, { name: 'Local kickoff time', unit: 'HH:MM' }],
    source: { file: 'src/competition/match-scheduling.ts', symbols: ['DEFAULT_SCHEDULING_POLICY', 'minutesOf', 'validateKickoff'] },
    dependsOn: [],
    mode: 'READ_ANALYZE',
    tests: ['tests/match-center-module.unit.test.ts'],
    notSimulatedBecause: null,
    approval: baseline('v1.0', 'f42958301912b226fb602d8e5f56856ec37ddc20fac438d01698531e17dd6693'),
    versions: firstVersion('v1.0'),
  },
];

export function algorithmOf(key: string): AlgorithmDecl | null {
  return ALGORITHMS.find((a) => a.key === key) ?? null;
}
