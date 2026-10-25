// LAB evidence — what the orchestrator decided, published as data and nothing else
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.3. Runs every synthetic scenario over
// the platform's real Agent Registry and writes what was decided to
// src/platform/agents/generated/orchestration-evidence.json, the one file of
// the orchestrator's that ships. The server verifies it and shows it in the AI
// Agents Operations Room (src/platform/agents/orchestration-evidence.ts); it
// never runs anything here.
//
// What is published: each run's id (its trace head), its tasks' assignments,
// dependencies, routing, handoff decisions, approval states and outcomes, and
// the full hash-chained trace. What is never published: an operation's input
// or output, a person's id outside the trace's synthetic references, a
// timestamp. The same plans over the same registry give the same file, byte
// for byte, so a test can say when the committed one is stale.
//
// It writes nothing the server's verifier would refuse: verifyOrchestrationEvidence
// runs here first, and a failure stops the write.

import * as fs from 'fs';
import * as path from 'path';
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import { killSwitchEngaged, engageKillSwitch, releaseKillSwitch } from '../../src/platform/intelligence/agents';
import { currentEnvironment, type FamilistaEnvironment } from '../../src/platform/environment';
import {
  evidenceDigest, verifyOrchestrationEvidence, ORCHESTRATION_EVIDENCE_CONTRACT, ORCHESTRATION_EVIDENCE_FILE,
  ORCHESTRATION_EVIDENCE_NOTICE, type EvidenceRun, type OrchestrationEvidence,
} from '../../src/platform/agents/orchestration-evidence';
import { ORCHESTRATION_CONTRACT, type ApprovalDecision, type PlanRequest } from './contracts';
import { decideApproval, startRun, type PlanRun, type RunContext } from './engine';
import { labOperations } from './operations';
import * as S from './scenarios';

export const EVIDENCE_FILE = ORCHESTRATION_EVIDENCE_FILE;

interface Scenario { slug: string; plan: () => PlanRequest; decisions?: Array<() => ApprovalDecision>; killSwitch?: boolean }

/** Every scenario the evidence holds, in the order the room lists them. */
export const SCENARIOS: readonly Scenario[] = Object.freeze([
  { slug: 'match-preparation', plan: S.matchPreparation },
  { slug: 'live-adjustment-awaiting', plan: S.liveAdjustment },
  { slug: 'live-adjustment-approved', plan: S.liveAdjustment, decisions: [S.approveLiveChange] },
  { slug: 'live-adjustment-rejected', plan: S.liveAdjustment, decisions: [S.rejectLiveChange] },
  { slug: 'medical-boundary', plan: S.medicalBoundary, decisions: [S.attemptMedicalApproval] },
  { slug: 'partial-failure', plan: S.partialFailure },
  { slug: 'kill-switch-stop', plan: S.killSwitchStop, killSwitch: true },
  { slug: 'cross-tenant-input', plan: S.crossTenantInput },
  { slug: 'medical-handoff', plan: S.medicalHandoff },
  { slug: 'requester-refused', plan: S.requesterRefused },
]);

function toEvidence(slug: string, request: PlanRequest, run: PlanRun, steps: EvidenceRun['steps']): EvidenceRun {
  const spec = (id: string) => request.tasks.find((t) => t.id === id);
  return {
    id: run.digest, scenario: slug, title: request.title, planId: run.planId,
    scope: request.scope.kind === 'CLUB' ? { kind: 'CLUB', clubId: request.scope.clubId } : { kind: 'PLATFORM' },
    requestedByRole: request.requestedBy.role, steps, outcome: run.outcome,
    refusal: run.refusal ? { code: run.refusal.code, message: run.refusal.message } : null,
    order: [...run.order],
    tasks: run.tasks.map((t) => ({
      id: t.id, operation: t.operation, tool: t.tool, state: t.state, dependsOn: [...(spec(t.id)?.dependsOn ?? [])],
      agent: t.agent ? { ...t.agent } : null, eligibleAgents: [...t.eligibleAgents], dataClass: t.dataClass, recordClass: t.recordClass,
      outputDigest: t.outputDigest,
      approval: t.approval ? { eligibleRoles: [...t.approval.eligibleRoles], decision: t.approval.decision, decidedByRole: t.approval.decidedBy?.role ?? null } : null,
      reason: t.reason ? { code: t.reason.code, message: t.reason.message } : null,
      inputs: t.inputs.map((i) => ({ ...i })),
    })),
    trace: run.trace.map((e) => ({ seq: e.seq, type: e.type, taskId: e.taskId, agentId: e.agentId, code: e.code, detail: e.detail, prev: e.prev, hash: e.hash })),
    digest: run.digest,
  };
}

/** Every scenario, run in the Lab, as one verified evidence document. */
export function buildEvidence(opts: { environment?: FamilistaEnvironment } = {}): OrchestrationEvidence {
  const environment = opts.environment ?? currentEnvironment();
  if (environment !== 'LAB') throw new Error(`LAB evidence is produced in the Lab only; this process is ${environment}`);
  if (killSwitchEngaged()) throw new Error('The kill switch is engaged: release it, so every scenario runs from the same state');
  const registry = platformAgentRegistry();
  const operations = labOperations();
  const ctx: RunContext = { registry, operations, environment };

  const runs = SCENARIOS.map((s) => {
    if (s.killSwitch) engageKillSwitch('LAB evidence: the kill switch scenario');
    try {
      const request = s.plan();
      let run = startRun(request, ctx);
      const steps: EvidenceRun['steps'] = [{ kind: 'START' }];
      for (const make of s.decisions ?? []) {
        const d = make();
        const refusedBefore = run.trace.filter((e) => e.type === 'APPROVAL_DECISION_REFUSED').length;
        run = decideApproval(run, d, ctx);
        const accepted = run.trace.filter((e) => e.type === 'APPROVAL_DECISION_REFUSED').length === refusedBefore;
        steps.push({ kind: 'DECISION', taskId: d.taskId, decision: d.decision, byRole: d.by.role, accepted });
      }
      return toEvidence(s.slug, request, run, steps);
    } finally {
      if (s.killSwitch) releaseKillSwitch();
    }
  });

  const body: Omit<OrchestrationEvidence, 'digest'> = {
    contract: ORCHESTRATION_EVIDENCE_CONTRACT, orchestration: ORCHESTRATION_CONTRACT, notice: ORCHESTRATION_EVIDENCE_NOTICE,
    environment: 'LAB', registryDigest: registry.digest(),
    operations: operations.list().map((o) => ({ key: o.key, title: o.title, tool: o.tool, domain: o.domain, output: o.output })),
    runs,
  };
  const evidence: OrchestrationEvidence = { ...body, digest: evidenceDigest(body) };
  const { reasons } = verifyOrchestrationEvidence(evidence);
  if (reasons.length) throw new Error(`This evidence would not be published: ${reasons.join('; ')}`);
  return evidence;
}

export const serialise = (e: OrchestrationEvidence): string => `${JSON.stringify(e, null, 2)}\n`;

export function writeEvidence(e: OrchestrationEvidence, file: string = EVIDENCE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialise(e));
}

export function readCommittedEvidence(file: string = EVIDENCE_FILE): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
