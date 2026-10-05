// Familista — candidates, as the room shows them (Algorithms Step 4)
// ─────────────────────────────────────────────────────────────────────────────
// Propose → Simulate → Test, read-only. Everything here comes from ONE file,
// the candidate evidence the lab wrote (CI re-derives it on every pull
// request), validated against its schema (candidate-evidence.ts). This module
// runs no candidate, imports nothing from lab/, reads no database or club
// record, and changes nothing.
//
// What it adds to the evidence is judged against TODAY's registry:
//
//   freshness   evidence built against an approval that has since changed is
//               STALE, and is shown as such rather than used
//   gate        the loop's own deploymentGate, asked about the candidate's
//               version and fingerprint. A candidate is not in the registry,
//               so the gate cannot say APPROVED — and if it ever did, the
//               candidate would be marked stale, never deployable
//   stage       where the candidate stands on the loop, every step of the way
//               there checked against LOOP_EDGES with canAdvance; no path
//               reaches Deploy
//
// Every candidate is EXPERIMENTAL and NOT_APPROVED — by type in the evidence,
// and `deployable` is the literal false here.

import { algorithmOf } from './registry';
import { canAdvance, deploymentGate, type GateVerdict, type LoopStage } from './loop';
import {
  CANDIDATE_NOTICE, readCandidateEvidence,
  type CandidateEntry, type LabMethodCheck, type LabRunState, type LabSpec, type LabVerdict,
} from './candidate-evidence';

export interface CandidateSummary {
  id: string;
  algorithm: string;
  version: string | null;
  baselineVersion: string | null;
  status: 'EXPERIMENTAL';
  approval: 'NOT_APPROVED';
  stage: LoopStage;
  gate: GateVerdict;
  /** Can this candidate reach Deploy? Never. */
  deployable: false;
  test: LabVerdict['test'];
  runState: LabRunState;
  freshness: 'CURRENT' | 'STALE';
  staleReasons: string[];
  /** Share of held-out Step 3 shots whose value changes; null without results. */
  changedShare: number | null;
  properties: { kept: number; fixed: number; broken: number; stillFailing: number };
}

export interface CandidatesOverview {
  state: 'READY' | 'NOT_GENERATED' | 'INVALID';
  reason: string | null;
  evidence: 'SYNTHETIC';
  production: 'NEVER_RUN';
  notice: string;
  generatedAt: string | null;
  spec: LabSpec | null;
  methodChecks: { passed: number; total: number; runState: LabRunState | null; checks: LabMethodCheck[] };
  counts: { candidates: number; awaitingApproval: number; returned: number; inTest: number; unavailable: number };
  candidates: CandidateSummary[];
}

export interface CandidateDetail extends CandidateSummary {
  evidence: 'SYNTHETIC';
  production: 'NEVER_RUN';
  notice: string;
  generatedAt: string;
  spec: LabSpec;
  methodChecks: { passed: number; total: number };
  /** The path to the stage, each step an edge of the loop. */
  path: LoopStage[];
  dependants: Array<{ key: string; name: string; simulated: boolean }>;
  /** What a human approval would have to name — recorded in the registry, by a reviewed change, never here. */
  approvalNeeds: { version: string | null; fingerprint: string | null; approvedVersion: string | null; approvedFingerprint: string | null };
  entry: CandidateEntry;
}

export type CandidateResult =
  | { state: 'FOUND'; detail: CandidateDetail }
  | { state: 'UNKNOWN_CANDIDATE' }
  | { state: 'NOT_GENERATED' | 'INVALID'; reason: string };

interface Judged { summary: CandidateSummary; path: LoopStage[] }

const STAGE_PATH: Readonly<Record<string, readonly LoopStage[]>> = {
  STALE: ['PROPOSE'],
  REFUSED: ['PROPOSE'],
  NOT_RUN: ['PROPOSE', 'SIMULATE'],
  PASSED: ['PROPOSE', 'SIMULATE', 'TEST', 'HUMAN_APPROVAL'],
  FAILED: ['PROPOSE', 'SIMULATE', 'TEST', 'PROPOSE'],
  INCONCLUSIVE: ['PROPOSE', 'SIMULATE', 'TEST'],
  UNAVAILABLE: ['PROPOSE', 'SIMULATE'],
};

/** A path is legal only if every step is an edge of the loop. Deploy is never on one. */
const legal = (path: readonly LoopStage[]) => path.every((s, i) => i === 0 || canAdvance(path[i - 1], s, null));

function judged(e: CandidateEntry): Judged {
  const decl = algorithmOf(e.algorithm);
  const approval = decl?.approval ?? null;
  const gate = deploymentGate({
    version: e.declaration?.version ?? '',
    fingerprint: e.code.fingerprint,
    approval,
    evaluation: e.verdict.test === 'FAILED' ? 'FAIL' : e.verdict.test === 'PASSED' ? 'PASS' : 'NOT_SIMULATED',
    mode: decl?.mode ?? 'READ_ANALYZE',
  });
  const stale: string[] = [];
  if (!decl) stale.push('UNKNOWN_ALGORITHM');
  if (e.declaration && approval
    && (e.declaration.baseline.version !== approval.version || e.declaration.baseline.fingerprint !== approval.fingerprint)) stale.push('BASELINE_NOT_CURRENT');
  if (approval && e.code.approvedFingerprint !== approval.fingerprint) stale.push('APPROVED_CODE_CHANGED');
  // A candidate the gate would pass is not a candidate: it is the approved code, mislabelled.
  if (gate === 'APPROVED') stale.push('CANDIDATE_MATCHES_APPROVAL');

  const key = stale.length ? 'STALE'
    : e.run.state === 'REFUSED' ? 'REFUSED'
      : e.run.state !== 'COMPLETED' ? 'NOT_RUN'
        : e.verdict.test;
  let path = [...STAGE_PATH[key]];
  if (!legal(path)) path = ['PROPOSE'];

  const held = e.results?.heldOut ?? null;
  const count = (o: string) => (held ? held.properties.filter((p) => p.outcome === o).length : 0);
  const step3 = held?.scenarios.find((s) => s.mix === 'step3-mix') ?? null;
  return {
    path,
    summary: {
      id: e.id,
      algorithm: e.algorithm,
      version: e.declaration?.version ?? null,
      baselineVersion: e.declaration?.baseline.version ?? null,
      status: 'EXPERIMENTAL',
      approval: 'NOT_APPROVED',
      stage: path[path.length - 1],
      gate,
      deployable: false,
      test: e.verdict.test,
      runState: e.run.state,
      freshness: stale.length ? 'STALE' : 'CURRENT',
      staleReasons: stale,
      changedShare: step3 ? step3.divergence.share.value : null,
      properties: { kept: count('KEPT'), fixed: count('FIXED'), broken: count('BROKEN'), stillFailing: count('STILL_FAILING') },
    },
  };
}

function countsOf(list: CandidateSummary[]): CandidatesOverview['counts'] {
  return {
    candidates: list.length,
    awaitingApproval: list.filter((c) => c.stage === 'HUMAN_APPROVAL').length,
    returned: list.filter((c) => c.freshness === 'CURRENT' && c.test === 'FAILED').length,
    inTest: list.filter((c) => c.freshness === 'CURRENT' && c.test === 'INCONCLUSIVE').length,
    unavailable: list.filter((c) => c.freshness === 'STALE' || c.test === 'UNAVAILABLE').length,
  };
}

export function algorithmCandidates(): CandidatesOverview {
  const read = readCandidateEvidence();
  if (read.state !== 'READY') {
    return {
      state: read.state, reason: read.reason, evidence: 'SYNTHETIC', production: 'NEVER_RUN', notice: CANDIDATE_NOTICE,
      generatedAt: null, spec: null, methodChecks: { passed: 0, total: 0, runState: null, checks: [] },
      counts: countsOf([]), candidates: [],
    };
  }
  const ev = read.evidence;
  const list = ev.candidates.map((e) => judged(e).summary);
  return {
    state: 'READY', reason: null, evidence: 'SYNTHETIC', production: 'NEVER_RUN', notice: ev.notice,
    generatedAt: ev.measured.generatedAt, spec: ev.spec,
    methodChecks: {
      passed: ev.methodChecks.checks.filter((c) => c.passed).length, total: ev.methodChecks.checks.length,
      runState: ev.methodChecks.run.state, checks: ev.methodChecks.checks,
    },
    counts: countsOf(list),
    candidates: list,
  };
}

export function algorithmCandidate(id: string): CandidateResult {
  const read = readCandidateEvidence();
  if (read.state !== 'READY') return { state: read.state, reason: read.reason };
  const ev = read.evidence;
  const e = ev.candidates.find((c) => c.id === id);
  if (!e) return { state: 'UNKNOWN_CANDIDATE' };
  const { summary, path } = judged(e);
  const approval = algorithmOf(e.algorithm)?.approval ?? null;
  return {
    state: 'FOUND',
    detail: {
      ...summary,
      evidence: 'SYNTHETIC',
      production: 'NEVER_RUN',
      notice: ev.notice,
      generatedAt: ev.measured.generatedAt,
      spec: ev.spec,
      methodChecks: { passed: ev.methodChecks.checks.filter((c) => c.passed).length, total: ev.methodChecks.checks.length },
      path,
      dependants: e.code.dependants.map((d) => ({ key: d.key, name: algorithmOf(d.key)?.name ?? d.key, simulated: d.simulated })),
      approvalNeeds: {
        version: e.declaration?.version ?? null,
        fingerprint: e.code.fingerprint,
        approvedVersion: approval?.version ?? null,
        approvedFingerprint: approval?.fingerprint ?? null,
      },
      entry: e,
    },
  };
}
