// LAB execution scenarios — the AI-0.4 demonstration, as requests and one runner
// ─────────────────────────────────────────────────────────────────────────────
// Every club, person and player is a `lab-…` reference, and every plan routes
// over the platform's real Agent Registry, tool registry, read matrix, approver
// roles and the LAB operator roster, so what the demonstration shows is what
// the platform's own rules decide. `runDemonstration` runs each scenario in a
// store of its own, restores the kill switch it found, and returns what each
// step was answered; the CLI prints it, and a test holds it to what it must be.

import { platformAgentRegistry, PLATFORM_AGENT_MANIFESTS } from '../../src/platform/agents/catalog';
import { AgentRegistry } from '../../src/platform/agents/registry';
import { AutonomyLevel, engageKillSwitch, killSwitchEngaged, releaseKillSwitch } from '../../src/platform/intelligence/agents';
import type { ApprovalDecision, PlanRequest } from './contracts';
import {
  cancelExecution, decideExecution, EXECUTION_CONTRACT, haltOpenExecutions, MemoryExecutionStore, submitExecution, verifyExecution,
  type ExecutionDeps, type ExecutionOperator, type ExecutionRecord, type ExecutionResult,
} from './execution';
import { labExecutionOperations } from './operations';
import * as S from './scenarios';

export const NORTH_OPERATOR: ExecutionOperator = { userId: 'lab-user-head-coach', role: 'HEAD_COACH' };
export const MEDICAL_OPERATOR: ExecutionOperator = { userId: 'lab-user-physio', role: 'MEDICAL_STAFF' };
export const PLATFORM_OPERATOR: ExecutionOperator = { userId: 'lab-operator-platform', role: 'SUPER_ADMIN' };
export const ANALYST: ExecutionOperator = { userId: 'lab-user-analyst', role: 'ANALYST' };
export const SOUTH_OPERATOR: ExecutionOperator = { userId: 'lab-operator-south', role: 'HEAD_COACH' };
export const SOUTH_CLUB_ADMIN = { userId: 'lab-user-south-admin', role: 'CLUB_ADMIN', clubId: S.OTHER_LAB_CLUB } as const;

/** Tactical → Training → Club Manager, and the club manager's notice to the staff, which waits for a person. */
export const matchdayPlan = (): PlanRequest => {
  const base = S.matchPreparation();
  return {
    ...base, id: 'matchday-workflow', title: 'Matchday: analyse, plan, brief and inform the staff',
    tasks: [...base.tasks, { id: 'notice', operation: 'operations.staff-notice@1', input: { audience: 'STAFF', subject: 'Saturday: briefing and training plan' }, dependsOn: ['briefing'] }],
  };
};

/** A training task whose input carries a player's medical status. */
export const healthDataPlan = (): PlanRequest => {
  const base = S.matchPreparation();
  return {
    ...base, id: 'health-data-input', title: 'A training draft handed a medical status',
    tasks: [base.tasks[0], { ...base.tasks[1], input: { minutes: 90, squadSize: 22, players: [{ ref: 'lab-player-2', medicalStatus: 'INJURED' }] } }],
  };
};

export const executionRequest = (requestId: string, plan: unknown, operator: ExecutionOperator = NORTH_OPERATOR, limits?: { maxSteps: number }) => ({
  contract: EXECUTION_CONTRACT, requestId, operator: { ...operator }, plan, ...(limits ? { limits } : {}),
});

export const approveNotice = (by: ApprovalDecision['by'] = { ...S.CLUB_ADMIN }): ApprovalDecision => ({ taskId: 'notice', decision: 'APPROVED', by });

/** One more agent, registered while an execution waits: the registry it was submitted under has changed. */
export function changedRegistry(): AgentRegistry {
  const r = new AgentRegistry();
  for (const m of PLATFORM_AGENT_MANIFESTS) r.register(m);
  r.register({
    id: 'club.lab-set-piece-analyst', version: '0.1.0', title: 'LAB Set-Piece Analyst', domain: 'TACTICS', scope: 'CLUB', lifecycle: 'LAB',
    autonomyCeiling: AutonomyLevel.RECOMMEND, supervisor: 'HEAD_COACH', purpose: 'SYNTHETIC. Reviews set pieces from recorded matches.',
    tools: ['getMatch', 'analyzeOpponent'], data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] }, outputs: [],
  });
  return r;
}

// ── the demonstration ────────────────────────────────────────────────────────

export interface DemoTask { id: string; state: string; agent: string | null; reason: string | null }
/** OBSERVED: not a call's answer, but what the store holds after something the scenario did. */
export interface DemoStep {
  action: string;
  status: ExecutionResult['status'] | 'OBSERVED';
  code: string | null;
  outcome: string | null;
  detail: string;
  /** For a step that started an execution: where its tasks stood. */
  tasks: DemoTask[];
}
export interface DemoScenario {
  slug: string;
  title: string;
  steps: DemoStep[];
  executionId: string | null;
  tasks: DemoTask[];
  verified: boolean | null;
  digest: string | null;
}

const tasksOf = (r: ExecutionRecord): DemoTask[] => r.run.tasks.map((t) => ({ id: t.id, state: t.state, agent: t.agent?.id ?? null, reason: t.reason?.code ?? null }));

interface Steps {
  /** Record a call's answer. */
  (action: string, r: ExecutionResult): ExecutionResult;
  /** Record what the store holds for an execution, after something that was not a call on it. */
  observe(action: string, executionId: string): void;
}

function scenario(slug: string, title: string, body: (deps: ExecutionDeps, step: Steps) => void, over: Partial<ExecutionDeps> = {}): DemoScenario {
  const deps: ExecutionDeps = { registry: platformAgentRegistry(), operations: labExecutionOperations(), store: new MemoryExecutionStore(), environment: 'LAB', ...over };
  const steps: DemoStep[] = [];
  let lastId: string | null = null;
  const step = ((action: string, r: ExecutionResult) => {
    steps.push({
      action, status: r.status, code: r.refusal ? (r.refusal.cause ? `${r.refusal.code} (${r.refusal.cause})` : r.refusal.code) : null,
      outcome: r.record?.run.outcome ?? null, detail: r.refusal?.message ?? '',
      tasks: r.status === 'ACCEPTED' && r.record ? tasksOf(r.record) : [],
    });
    if (r.record) lastId = r.record.executionId;
    return r;
  }) as Steps;
  step.observe = (action, executionId) => {
    const r = deps.store.get(executionId);
    steps.push({ action, status: 'OBSERVED', code: r?.run.stop?.code ?? null, outcome: r?.run.outcome ?? null, detail: '', tasks: [] });
    if (r) lastId = r.executionId;
  };
  try { body(deps, step); } finally { if (killSwitchEngaged()) releaseKillSwitch(); }
  const current = lastId ? deps.store.get(lastId) : null;
  return {
    slug, title, steps, executionId: current?.executionId ?? null, tasks: current ? tasksOf(current) : [],
    verified: current ? verifyExecution(current).ok : null, digest: current?.digest ?? null,
  };
}

/** Every AI-0.4 scenario, each in a store of its own. Refuses to start while the kill switch is engaged. */
export function runDemonstration(): DemoScenario[] {
  if (killSwitchEngaged()) throw new Error('The kill switch is engaged: release it, so every scenario starts from the same state');
  const out: DemoScenario[] = [];

  out.push(scenario('matchday', 'Tactical → Training → Club Manager, and an approved staff notice', (deps, step) => {
    const r = step('the head coach submits the matchday plan', submitExecution(executionRequest('matchday-0001', matchdayPlan()), deps));
    const id = r.record?.executionId ?? '';
    step('the head coach approves their own notice', decideExecution(id, approveNotice({ ...S.HEAD_COACH }), deps));
    step('the club admin approves the notice', decideExecution(id, approveNotice(), deps));
  }));

  out.push(scenario('idempotency', 'The same request twice runs once; a different plan under it is refused', (deps, step) => {
    step('submit', submitExecution(executionRequest('matchday-0002', S.matchPreparation()), deps));
    step('submit the same request again', submitExecution(executionRequest('matchday-0002', S.matchPreparation()), deps));
    step('reuse the request id for another plan', submitExecution(executionRequest('matchday-0002', S.partialFailure()), deps));
  }));

  out.push(scenario('failure', 'One branch fails; what consumes it is skipped, the other completes', (deps, step) => {
    step('submit two opponents, one with no recorded matches', submitExecution(executionRequest('failure-0001', S.partialFailure()), deps));
  }));

  out.push(scenario('cancellation', 'An execution waiting for approval is cancelled by its operator', (deps, step) => {
    const r = step('submit the matchday plan', submitExecution(executionRequest('cancel-0001', matchdayPlan()), deps));
    const id = r.record?.executionId ?? '';
    step('the analyst tries to cancel it', cancelExecution(id, ANALYST, deps));
    step('the head coach cancels it', cancelExecution(id, NORTH_OPERATOR, deps));
    step('the club admin approves after the cancellation', decideExecution(id, approveNotice(), deps));
  }));

  out.push(scenario('unauthorized', 'Operators, tenants and approvers outside what they may do', (deps, step) => {
    step('an unknown operator submits', submitExecution(executionRequest('unauth-0001', matchdayPlan(), { userId: 'lab-user-stranger', role: 'HEAD_COACH' }), deps));
    step('the analyst (no SUBMIT) submits', submitExecution(executionRequest('unauth-0002', matchdayPlan(), ANALYST), deps));
    step('a south operator submits a north plan', submitExecution(executionRequest('unauth-0003', matchdayPlan(), SOUTH_OPERATOR), deps));
    step('an operator claims a role they do not hold', submitExecution(executionRequest('unauth-0004', matchdayPlan(), { userId: 'lab-user-head-coach', role: 'CLUB_ADMIN' }), deps));
    step('a plan names a real-looking tenant id', submitExecution(executionRequest('unauth-0005', { ...matchdayPlan(), scope: { kind: 'CLUB', clubId: '3f8a2c1e-0000-4000-8000-000000000001' } }), deps));
    step('a task input names another club', submitExecution(executionRequest('unauth-0006', S.crossTenantInput()), deps));
    const r = step('submit the matchday plan', submitExecution(executionRequest('unauth-0007', matchdayPlan()), deps));
    step('the south club admin approves the north notice', decideExecution(r.record?.executionId ?? '', approveNotice({ ...SOUTH_CLUB_ADMIN }), deps));
  }));

  out.push(scenario('medical', 'Medical data stays with medical agents, and a medical action finds no eligible approver', (deps, step) => {
    step('the head coach submits the medical plan', submitExecution(executionRequest('medical-0001', S.medicalBoundary(), NORTH_OPERATOR), deps));
    step('a training task is handed a medical status', submitExecution(executionRequest('medical-0002', healthDataPlan()), deps));
    step('the physio submits a training load built on the medical report', submitExecution(executionRequest('medical-0003', S.medicalHandoff(), MEDICAL_OPERATOR), deps));
    const r = step('the physio submits availability and recommendations', submitExecution(executionRequest('medical-0004', S.medicalBoundary(), MEDICAL_OPERATOR), deps));
    step('the club admin approves the medical recommendation', decideExecution(r.record?.executionId ?? '', { taskId: 'recommendation', decision: 'APPROVED', by: { ...S.CLUB_ADMIN } }, deps));
  }));

  out.push(scenario('kill-switch-before', 'Engaged before submission: nothing starts', (deps, step) => {
    engageKillSwitch('LAB demonstration: engaged before submission');
    step('submit the matchday plan', submitExecution(executionRequest('kill-0001', matchdayPlan()), deps));
  }));

  out.push(scenario('kill-switch-between', 'Engaged between two task transitions: the run halts there', (deps, step) => {
    step('submit; the switch is engaged as the second task is about to start', submitExecution(executionRequest('kill-0002', matchdayPlan()), deps));
  }, { beforeTransition: ({ step }) => { if (step === 2) engageKillSwitch('LAB demonstration: engaged between tasks'); } }));

  out.push(scenario('kill-switch-waiting', 'Engaged while an approval waits: the decision is not applied, and nothing resumes', (deps, step) => {
    const r = step('submit the matchday plan', submitExecution(executionRequest('kill-0003', matchdayPlan()), deps));
    const id = r.record?.executionId ?? '';
    engageKillSwitch('LAB demonstration: engaged while an approval waits');
    step('the club admin approves the notice', decideExecution(id, approveNotice(), deps));
    releaseKillSwitch();
    step('the club admin approves again, after the release', decideExecution(id, approveNotice(), deps));
  }));

  out.push(scenario('kill-switch-sweep', 'Engaging the switch halts every execution that has not settled', (deps, step) => {
    const a = step('submit one matchday plan', submitExecution(executionRequest('kill-0004', matchdayPlan()), deps));
    step('submit another', submitExecution(executionRequest('kill-0005', matchdayPlan()), deps));
    engageKillSwitch('LAB demonstration: sweep');
    const swept = haltOpenExecutions(deps);
    step.observe(`the switch is engaged and the open executions are halted (${swept.halted.length} of ${deps.store.list().length})`, a.record?.executionId ?? '');
  }));

  out.push(scenario('limit', 'An execution limit of two steps halts a four-task plan', (deps, step) => {
    step('submit the matchday plan, at most 2 steps', submitExecution(executionRequest('limit-0001', matchdayPlan(), NORTH_OPERATOR, { maxSteps: 2 }), deps));
  }));

  const changed = changedRegistry();
  out.push(scenario('context-change', 'The registry changes while an approval waits: the approval no longer holds', (deps, step) => {
    const r = step('submit the matchday plan', submitExecution(executionRequest('context-0001', matchdayPlan()), deps));
    step('a new agent is registered; the club admin approves', decideExecution(r.record?.executionId ?? '', approveNotice(), { ...deps, registry: changed }));
  }));

  return out;
}
