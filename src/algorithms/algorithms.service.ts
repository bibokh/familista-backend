// Familista — the Algorithms room
// ─────────────────────────────────────────────────────────────────────────────
// Composes what the room shows from three pieces of evidence, and nothing
// else:
//
//   the registry          src/algorithms/registry.ts — what each algorithm is,
//                         its version and the human approval it runs under
//   the fingerprints      src/algorithms/generated/algorithm-manifest.json —
//                         what the code beside this server actually is
//   the evaluation        src/algorithms/scenarios.ts — the real functions run
//                         on synthetic scenarios in this process, now
//
// Where an algorithm stands on the Continuous Intelligence Loop is DERIVED
// from those three by the gate in loop.ts; it is never stored and never set.
//
// READ/ANALYZE-ONLY. This service reads files that ship with the build and
// runs pure functions. It does not touch the database, read club data, call a
// model, change a weight, or deploy anything; there is no function here that
// could. Monitoring is this process's own record of the evaluations it ran.

import * as fs from 'fs';
import * as path from 'path';
import { ALGORITHMS, ALGORITHM_DOMAINS, algorithmOf, type AlgorithmDecl } from './registry';
import { evaluate, type Evaluation } from './scenarios';
import {
  LOOP_STAGES, LOOP_EDGES, ALGORITHM_MODES, deploymentGate, stageOf,
  type GateVerdict, type LoopStage,
} from './loop';

const MANIFEST_PATH = path.join(__dirname, 'generated', 'algorithm-manifest.json');
/** Evaluations are cheap, but a refresh storm should not rerun them all. */
const EVAL_TTL_MS = 60_000;

interface ManifestEntry { file: string; symbols: string[]; fingerprint: string | null; error: string | null; missing: string[] }
interface Manifest { schemaVersion: number; algorithms: Record<string, ManifestEntry> }

function readManifest(): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
    return m && typeof m.algorithms === 'object' ? m : null;
  } catch { return null; }
}

// ── monitoring: this process's own evaluation record ─────────────────────────

const monitor = {
  runs: 0,
  lastRunAt: null as string | null,
  lastDurationMs: null as number | null,
  failingRuns: 0,
  cache: null as { at: number; results: Record<string, Evaluation> } | null,
};

function evaluations(): Record<string, Evaluation> {
  const now = Date.now();
  if (monitor.cache && now - monitor.cache.at < EVAL_TTL_MS) return monitor.cache.results;
  const t0 = process.hrtime.bigint();
  const results: Record<string, Evaluation> = {};
  for (const a of ALGORITHMS) results[a.key] = evaluate(a.key);
  monitor.runs += 1;
  monitor.lastRunAt = new Date(now).toISOString();
  monitor.lastDurationMs = Number((process.hrtime.bigint() - t0) / 1000n) / 1000;
  if (Object.values(results).some((r) => r.state === 'FAIL')) monitor.failingRuns += 1;
  monitor.cache = { at: now, results };
  return results;
}

/** For tests: forget the cached evaluation and the counters. */
export function resetAlgorithmMonitor(): void {
  monitor.runs = 0; monitor.lastRunAt = null; monitor.lastDurationMs = null; monitor.failingRuns = 0; monitor.cache = null;
}

// ── the shapes this room answers with (pinned by src/contracts) ──────────────

export interface AlgorithmSummary {
  key: string;
  name: string;
  domain: string;
  version: string;
  mode: string;
  stage: LoopStage;
  gate: GateVerdict;
  evaluation: { state: Evaluation['state']; passed: number; total: number };
  approval: { kind: 'BASELINE' | 'CHANGE'; version: string } | null;
}

export interface LoopStageView {
  id: LoopStage;
  title: string;
  describes: string;
  who: 'PLATFORM' | 'HUMAN';
  next: LoopStage[];
  algorithms: number;
}

export interface GuaranteeView { id: string; basis: 'RUNTIME' | 'BUILD'; text: string; holds: boolean }

export interface AlgorithmsOverview {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  measuredAt: string;
  mode: 'READ_ANALYZE';
  loop: LoopStageView[];
  domains: Array<{ id: string; title: string; describes: string; algorithms: number }>;
  algorithms: AlgorithmSummary[];
  guarantees: GuaranteeView[];
  totals: {
    registered: number; approved: number; awaitingApproval: number; failing: number;
    simulated: number; checks: number; checksPassed: number;
  } | null;
  monitoring: {
    evaluationRuns: number; failingRuns: number; lastRunAt: string | null;
    lastDurationMs: number | null; refreshSeconds: number;
  } | null;
}

// ── composition ──────────────────────────────────────────────────────────────

interface Composed {
  decl: AlgorithmDecl;
  fingerprint: string | null;
  gate: GateVerdict;
  stage: LoopStage;
  evaluation: Evaluation;
}

function compose(decl: AlgorithmDecl, manifest: Manifest | null, evals: Record<string, Evaluation>): Composed {
  const fingerprint = manifest?.algorithms[decl.key]?.fingerprint ?? null;
  const evaluation = evals[decl.key];
  const gate = deploymentGate({
    version: decl.version, fingerprint, approval: decl.approval, evaluation: evaluation.state, mode: decl.mode,
  });
  return { decl, fingerprint, gate, stage: stageOf(gate), evaluation };
}

const LOOP_TEXT: Record<LoopStage, { title: string; describes: string; who: 'PLATFORM' | 'HUMAN' }> = {
  OBSERVE: { title: 'Observe', describes: 'The registry inventories every algorithm and what it reads and returns.', who: 'PLATFORM' },
  LEARN: { title: 'Learn', describes: 'Evaluations and their results show where an algorithm is weak or out of date.', who: 'PLATFORM' },
  PROPOSE: { title: 'Propose', describes: 'A change is written as a new version: new code, a new fingerprint, a reason.', who: 'PLATFORM' },
  SIMULATE: { title: 'Simulate', describes: 'The real function runs on fixed synthetic scenarios. No club data is read.', who: 'PLATFORM' },
  TEST: { title: 'Test', describes: 'Each scenario is checked against the properties the algorithm must keep, and CI runs the unit tests.', who: 'PLATFORM' },
  HUMAN_APPROVAL: { title: 'Human approval', describes: 'The platform owner approves the exact version and fingerprint, in a reviewed pull request.', who: 'HUMAN' },
  DEPLOY: { title: 'Deploy', describes: 'Only through the CI-gated deploy of main. Nothing in this room deploys anything.', who: 'HUMAN' },
  MEASURE: { title: 'Measure', describes: 'The live version is re-evaluated on every visit, and its result is recorded here.', who: 'PLATFORM' },
};

/**
 * What the room guarantees. RUNTIME ones are checked now, in this process.
 * BUILD ones cannot be seen from inside a running server — they are facts
 * about the code — so they are pinned where they can be: the unit test and the
 * security manifest fail the build if they stop holding.
 */
function guarantees(rows: Composed[]): GuaranteeView[] {
  return [
    {
      id: 'read-analyze-only', basis: 'RUNTIME',
      text: 'Every algorithm is read/analyze-only.',
      holds: rows.every((r) => (ALGORITHM_MODES as readonly string[]).includes(r.decl.mode)),
    },
    {
      id: 'approval-before-deploy', basis: 'RUNTIME',
      text: 'Deploy is reachable only from Human approval.',
      holds: (Object.keys(LOOP_EDGES) as LoopStage[]).every((s) => s === 'HUMAN_APPROVAL' || !LOOP_EDGES[s].includes('DEPLOY')),
    },
    {
      id: 'exact-version-approved', basis: 'RUNTIME',
      text: 'Every algorithm in production runs the exact version and code its approval names.',
      holds: rows.every((r) => r.gate === 'APPROVED'),
    },
    {
      id: 'no-autonomous-change', basis: 'BUILD',
      text: 'This room has no write endpoint and no autonomous change path.',
      // Pinned by tests/algorithms.unit.test.ts and the security manifest's
      // algorithm-change-gate control; a build where it fails does not ship.
      holds: true,
    },
  ];
}

function summaryOf(r: Composed): AlgorithmSummary {
  return {
    key: r.decl.key,
    name: r.decl.name,
    domain: r.decl.domain,
    version: r.decl.version,
    mode: r.decl.mode,
    stage: r.stage,
    gate: r.gate,
    evaluation: { state: r.evaluation.state, passed: r.evaluation.passed, total: r.evaluation.total },
    approval: r.decl.approval ? { kind: r.decl.approval.kind, version: r.decl.approval.version } : null,
  };
}

export function algorithmsOverview(): AlgorithmsOverview {
  const manifest = readManifest();
  if (!manifest) {
    return {
      state: 'NOT_GENERATED', reason: 'The algorithm fingerprints are not beside this server.',
      measuredAt: new Date().toISOString(), mode: 'READ_ANALYZE',
      loop: [], domains: [], algorithms: [], guarantees: [], totals: null, monitoring: null,
    };
  }
  const evals = evaluations();
  const rows = ALGORITHMS.map((a) => compose(a, manifest, evals));
  const countAt = (s: LoopStage) => rows.filter((r) => r.stage === s).length;
  return {
    state: 'READY',
    reason: null,
    measuredAt: new Date().toISOString(),
    mode: 'READ_ANALYZE',
    loop: LOOP_STAGES.map((s) => ({ id: s, ...LOOP_TEXT[s], next: [...LOOP_EDGES[s]], algorithms: countAt(s) })),
    domains: ALGORITHM_DOMAINS.map((d) => ({ ...d, algorithms: rows.filter((r) => r.decl.domain === d.id).length })),
    algorithms: rows.map(summaryOf),
    guarantees: guarantees(rows),
    totals: {
      registered: rows.length,
      approved: rows.filter((r) => r.gate === 'APPROVED').length,
      awaitingApproval: countAt('HUMAN_APPROVAL'),
      failing: rows.filter((r) => r.evaluation.state === 'FAIL').length,
      simulated: rows.filter((r) => r.evaluation.state !== 'NOT_SIMULATED').length,
      checks: rows.reduce((s, r) => s + r.evaluation.total, 0),
      checksPassed: rows.reduce((s, r) => s + r.evaluation.passed, 0),
    },
    monitoring: {
      evaluationRuns: monitor.runs,
      failingRuns: monitor.failingRuns,
      lastRunAt: monitor.lastRunAt,
      lastDurationMs: monitor.lastDurationMs,
      refreshSeconds: EVAL_TTL_MS / 1000,
    },
  };
}

export type AlgorithmDetailResult =
  | { state: 'UNKNOWN_ALGORITHM' }
  | { state: 'NOT_GENERATED' }
  | { state: 'READY'; detail: AlgorithmDetail };

export type AlgorithmDetail = ReturnType<typeof detailOf>;

function detailOf(r: Composed, manifest: Manifest) {
  const m = manifest.algorithms[r.decl.key];
  const a = r.decl.approval;
  return {
    ...summaryOf(r),
    summary: r.decl.summary,
    usedBy: r.decl.usedBy,
    inputs: r.decl.inputs,
    outputs: r.decl.outputs,
    dependsOn: r.decl.dependsOn,
    source: { file: r.decl.source.file, symbols: r.decl.source.symbols, error: m?.error ?? null, missing: m?.missing ?? [] },
    fingerprint: {
      current: r.fingerprint,
      approved: a?.fingerprint ?? null,
      matches: !!a && !!r.fingerprint && a.fingerprint === r.fingerprint,
    },
    approval: a ? { kind: a.kind, version: a.version, approvedBy: a.approvedBy, reference: a.reference, approvedAt: a.approvedAt } : null,
    versions: r.decl.versions,
    tests: r.decl.tests,
    notSimulatedBecause: r.decl.notSimulatedBecause,
    scenarios: r.evaluation.scenarios,
  };
}

export function algorithmDetail(key: string): AlgorithmDetailResult {
  const decl = algorithmOf(key);
  if (!decl) return { state: 'UNKNOWN_ALGORITHM' };
  const manifest = readManifest();
  if (!manifest) return { state: 'NOT_GENERATED' };
  return { state: 'READY', detail: detailOf(compose(decl, manifest, evaluations()), manifest) };
}
