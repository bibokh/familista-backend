// Familista — the LEARN stage, as the room shows it (Algorithms Step 3)
// ─────────────────────────────────────────────────────────────────────────────
// Composes the learning view from the declarations in learning-spec.ts and the
// synthetic runs in learning-synthetic.ts. Two lanes, never merged:
//
//   synthetic    method checks on invented outcomes, labelled SYNTHETIC on every
//                object, with the sentence that says what they are not
//   real world   DISABLED, with the prerequisites that are not met
//
// There is no field anywhere that combines the two, no verdict called
// "calibrated" or "accurate", and nothing here reads a database or a club
// record, or changes an algorithm.

import { ALGORITHMS, algorithmOf } from './registry';
import {
  JUSTIFICATIONS, LEARNING, LEARNING_LIMITS, LEARN_SPECS, REAL_WORLD, SYNTHETIC_KEYS, SYNTHETIC_NOTICE,
  SYNTHETIC_SCENARIOS, SYNTHETIC_SHOTS, learnSpecOf,
  type LearnSignal, type LearnStatus, type LearnVerdict, type SyntheticKey, type Truth,
} from './learning-spec';
import { syntheticEvaluation, type MethodCheck, type RunMeasured, type SyntheticEvaluation } from './learning-synthetic';
import type { RuntimeVerdict } from './runtime-fingerprint';

export interface LearningRules {
  minExpectedEvents: number;
  alphaPerTest: number;
  familyAlpha: number;
  testZ: number;
  power: number;
  ciLevel: number;
  minBinShots: number;
  probabilityEpsilon: number;
  binEdges: number[];
  justifications: { sampleFloor: string; miscalibration: string; noneDetected: string; binDisplay: string; probabilityClip: string };
}

export interface LearningAlgorithmSummary {
  key: string;
  name: string;
  domain: string;
  version: string;
  status: LearnStatus;
  reason: string;
  derivedFrom: string | null;
  synthetic: {
    evidence: 'SYNTHETIC';
    state: 'COMPLETE' | 'ABORTED';
    codeVerdict: RuntimeVerdict;
    methodChecks: { passed: number; total: number };
    scenarios: Array<{ id: string; verdict: LearnVerdict; methodCheck: MethodCheck }>;
    measured: RunMeasured;
    servedFromCache: boolean;
  } | null;
}

export interface LearningOverview {
  evidence: { synthetic: 'SYNTHETIC'; realWorld: 'DISABLED' };
  notice: string;
  measuredAt: string;
  realWorld: { state: 'DISABLED'; reason: string; prerequisites: Array<{ id: string; label: string; met: boolean }> };
  rules: LearningRules;
  limits: {
    shotsPerScenarioMax: number; shotsPerAlgorithmMax: number; sliceShots: number;
    busyBudgetMs: number; scenarioBufferBytesMax: number;
  };
  generator: {
    x: number[]; y: number[];
    bodyPart: Array<{ value: string; share: number }>;
    technique: Array<{ value: string; share: number }>;
    situation: Array<{ value: string; share: number }>;
    pressured: number; counter: number;
  };
  scenarios: Array<{
    id: string; title: string; purpose: string; circular: boolean;
    truth: { kind: Truth['kind']; parameter: number | null };
    size: { shots: number | null; untilExpectedGoals: number | null; shotCap: number | null };
    seed: number;
    expected: { verdict: LearnVerdict; signal: LearnSignal | null };
  }>;
  counts: { syntheticOnly: number; derived: number; noGroundTruth: number; excludedHealth: number };
  algorithms: LearningAlgorithmSummary[];
}

export interface AlgorithmLearningDetail {
  key: string;
  name: string;
  domain: string;
  version: string;
  status: LearnStatus;
  reason: string;
  derivedFrom: string | null;
  evidence: 'SYNTHETIC' | 'NONE';
  notice: string | null;
  realWorld: { state: 'DISABLED' };
  synthetic: SyntheticEvaluation | null;
  servedFromCache: boolean;
}

export type AlgorithmLearningResult =
  | { state: 'FOUND'; detail: AlgorithmLearningDetail }
  | { state: 'UNKNOWN_ALGORITHM' };

const shares = (list: ReadonlyArray<readonly [string, number]>) => list.map(([value, share]) => ({ value, share }));
const isSynthetic = (key: string): key is SyntheticKey => (SYNTHETIC_KEYS as readonly string[]).includes(key);

function rules(): LearningRules {
  return {
    minExpectedEvents: LEARNING.minExpectedEvents,
    alphaPerTest: LEARNING.alphaPerTest,
    familyAlpha: +(LEARNING.alphaPerTest * 2).toFixed(4),
    testZ: LEARNING.testZ,
    power: 0.8,
    ciLevel: 0.95,
    minBinShots: LEARNING.minBinShots,
    probabilityEpsilon: LEARNING.probabilityEpsilon,
    binEdges: [...LEARNING.binEdges],
    justifications: { ...JUSTIFICATIONS },
  };
}

export async function algorithmsLearning(now: number = Date.now()): Promise<LearningOverview> {
  // One algorithm at a time: each run yields to the event loop, and two at
  // once would only interleave the same work.
  const runs = new Map<SyntheticKey, { run: SyntheticEvaluation; cached: boolean }>();
  for (const key of SYNTHETIC_KEYS) {
    const s = syntheticEvaluation(key);
    runs.set(key, { run: await s.run, cached: s.cached });
  }
  const count = (st: LearnStatus) => LEARN_SPECS.filter((s) => s.status === st).length;
  return {
    evidence: { synthetic: 'SYNTHETIC', realWorld: 'DISABLED' },
    notice: SYNTHETIC_NOTICE,
    measuredAt: new Date(now).toISOString(),
    realWorld: {
      state: REAL_WORLD.state, reason: REAL_WORLD.reason,
      prerequisites: REAL_WORLD.prerequisites.map((p) => ({ id: p.id, label: p.label, met: false })),
    },
    rules: rules(),
    limits: { ...LEARNING_LIMITS },
    generator: {
      x: [...SYNTHETIC_SHOTS.x], y: [...SYNTHETIC_SHOTS.y],
      bodyPart: shares(SYNTHETIC_SHOTS.bodyPart), technique: shares(SYNTHETIC_SHOTS.technique),
      situation: shares(SYNTHETIC_SHOTS.situation), pressured: SYNTHETIC_SHOTS.pressured, counter: SYNTHETIC_SHOTS.counter,
    },
    scenarios: SYNTHETIC_SCENARIOS.map((s) => ({
      id: s.id, title: s.title, purpose: s.purpose, circular: s.circular,
      truth: { kind: s.truth.kind, parameter: s.truth.kind === 'LOGIT_SHIFT' ? s.truth.delta : s.truth.kind === 'LOGIT_SCALE' ? s.truth.factor : null },
      size: 'shots' in s.size
        ? { shots: s.size.shots, untilExpectedGoals: null, shotCap: null }
        : { shots: null, untilExpectedGoals: s.size.untilExpectedGoals, shotCap: s.size.shotCap },
      seed: s.seed,
      expected: { verdict: s.expect.verdict, signal: s.expect.signal },
    })),
    counts: {
      syntheticOnly: count('SYNTHETIC_ONLY'), derived: count('DERIVED'),
      noGroundTruth: count('NO_GROUND_TRUTH'), excludedHealth: count('EXCLUDED_HEALTH'),
    },
    algorithms: ALGORITHMS.map((a) => {
      const spec = learnSpecOf(a.key)!;
      const r = isSynthetic(a.key) ? runs.get(a.key) : undefined;
      return {
        key: a.key, name: a.name, domain: a.domain, version: a.version,
        status: spec.status, reason: spec.reason, derivedFrom: spec.derivedFrom,
        synthetic: r ? {
          evidence: 'SYNTHETIC' as const,
          state: r.run.state, codeVerdict: r.run.code.verdict, methodChecks: r.run.methodChecks,
          scenarios: r.run.scenarios.map((s) => ({ id: s.id, verdict: s.verdict, methodCheck: s.methodCheck })),
          measured: r.run.measured, servedFromCache: r.cached,
        } : null,
      };
    }),
  };
}

export async function algorithmLearning(key: string): Promise<AlgorithmLearningResult> {
  const decl = algorithmOf(key);
  const spec = learnSpecOf(key);
  if (!decl || !spec) return { state: 'UNKNOWN_ALGORITHM' };
  let synthetic: SyntheticEvaluation | null = null;
  let cached = false;
  if (isSynthetic(key)) {
    const s = syntheticEvaluation(key);
    synthetic = await s.run;
    cached = s.cached;
  }
  return {
    state: 'FOUND',
    detail: {
      key: decl.key, name: decl.name, domain: decl.domain, version: decl.version,
      status: spec.status, reason: spec.reason, derivedFrom: spec.derivedFrom,
      evidence: synthetic ? 'SYNTHETIC' : 'NONE',
      notice: synthetic ? SYNTHETIC_NOTICE : null,
      realWorld: { state: 'DISABLED' },
      synthetic,
      servedFromCache: cached,
    },
  };
}
