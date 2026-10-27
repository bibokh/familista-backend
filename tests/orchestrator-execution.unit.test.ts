/**
 * Global Multi-Agent Intelligence, AI-0.4 — controlled LAB workflow execution
 * (lab/orchestrator/execution.ts, operators.ts, execute-cli.ts).
 *
 * 1. Submission: LAB only, strict and bounded, a named operator who may operate
 *    the plan's scope and read what its agents write, the orchestrator's plan
 *    checks, and idempotency.
 * 2. Registry-driven selection: every task to the least-privileged eligible
 *    agent, with the reason for every agent passed over; a new agent joins
 *    through the registry, a DRAFT one never runs.
 * 3. Multi-agent execution: dependency order, validated handoffs, contained
 *    failures, an execution limit, cancellation.
 * 4. Human approval: no self-approval, approver roles of the plan's club only,
 *    read rights, medical actions still blocked, invalidation when the security
 *    context changes.
 * 5. The kill switch: before submission, between transitions, while an approval
 *    waits, and for every open execution; nothing resumes on release.
 * 6. Observability and integrity: what is recorded, verified, and what
 *    tampering of each part is caught; publication only as a candidate.
 * 7. Isolation: no endpoint, no production import, a LAB-only store, a valid
 *    roster, the AI-0.3 evidence untouched.
 * 8. The demonstration and the CLI, end to end.
 *
 * Each guard has a negative control: the same request with one thing changed,
 * refused or contained for exactly that reason.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import net from 'net';
import { spawnSync } from 'child_process';
import { PLATFORM_AGENT_MANIFESTS, platformAgentRegistry } from '../src/platform/agents/catalog';
import { AgentRegistry } from '../src/platform/agents/registry';
import type { AgentManifest } from '../src/platform/agents/manifest';
import { AutonomyLevel, engageKillSwitch, killSwitchEngaged, releaseKillSwitch } from '../src/platform/intelligence/agents';
import { verifyOrchestrationEvidence } from '../src/platform/agents/orchestration-evidence';
import { digestOf } from '../src/platform/agents/trace-chain';
import { tierFor } from '../src/security/ai-read-policy';
import { APPROVER_ROLES } from '../src/security/approver-roles';
import { ORCHESTRATION_CONTRACT, type PlanRequest } from '../lab/orchestrator/contracts';
import {
  cancelExecution, decideExecution, EXECUTION_CONTRACT, EXECUTION_GENESIS, executionIdFor, FileExecutionStore, haltOpenExecutions,
  MemoryExecutionStore, publicationCandidate, securityContext, submitExecution, verifyExecution, verifyLog,
  type ExecutionDeps, type ExecutionRecord, type ExecutionResult,
} from '../lab/orchestrator/execution';
import {
  ANALYST, approveNotice, changedRegistry, executionRequest, healthDataPlan, matchdayPlan, MEDICAL_OPERATOR, NORTH_OPERATOR,
  PLATFORM_OPERATOR, runDemonstration, SOUTH_CLUB_ADMIN, SOUTH_OPERATOR,
} from '../lab/orchestrator/execution-scenarios';
import { buildEvidence, readCommittedEvidence, serialise } from '../lab/orchestrator/evidence';
import { labExecutionOperations, labOperations } from '../lab/orchestrator/operations';
import { LAB_OPERATORS, validateOperators } from '../lab/orchestrator/operators';
import { verifyTrace } from '../lab/orchestrator/trace';
import * as S from '../lab/orchestrator/scenarios';

const ROOT = path.join(__dirname, '..');
type Row = Record<string, any>;

const deps = (over: Partial<ExecutionDeps> = {}): ExecutionDeps => ({
  registry: platformAgentRegistry(), operations: labExecutionOperations(), store: new MemoryExecutionStore(), environment: 'LAB', ...over,
});
const submit = (d: ExecutionDeps, requestId = 'matchday-0001', plan: unknown = matchdayPlan(), operator = NORTH_OPERATOR, limits?: { maxSteps: number }) =>
  submitExecution(executionRequest(requestId, plan, operator, limits), d);
const accepted = (r: ExecutionResult): ExecutionRecord => {
  if (r.status === 'REFUSED') throw new Error(`refused ${r.refusal.code}: ${r.refusal.message}`);
  return r.record;
};
const task = (r: ExecutionRecord, id: string) => {
  const t = r.run.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
const states = (r: ExecutionRecord) => Object.fromEntries(r.run.tasks.map((t) => [t.id, t.state]));
const refusal = (r: ExecutionResult) => (r.status === 'REFUSED' ? { code: r.refusal.code, cause: r.refusal.cause } : null);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const plan = (over: Partial<PlanRequest>, tasks: PlanRequest['tasks']): PlanRequest => ({
  contract: ORCHESTRATION_CONTRACT, id: 'lab-plan', title: 'A LAB plan', scope: { kind: 'CLUB', clubId: S.LAB_CLUB },
  requestedBy: { ...S.HEAD_COACH }, tasks, ...over,
});
const opponentTask = (id = 'opponent', dependsOn: string[] = []) => ({ ...S.matchPreparation().tasks[0], id, dependsOn });

afterEach(() => { if (killSwitchEngaged()) releaseKillSwitch(); });

// ── 1. submission ────────────────────────────────────────────────────────────

describe('submission', () => {
  it('accepts the matchday request, runs everything that may run, and keeps one record', () => {
    const d = deps();
    const r = submit(d);
    expect(r.status).toBe('ACCEPTED');
    const rec = accepted(r);
    expect(rec.executionId).toMatch(/^exec-[0-9a-f]{24}$/);
    expect(rec).toMatchObject({ contract: EXECUTION_CONTRACT, requestId: 'matchday-0001', operator: NORTH_OPERATOR, planId: 'matchday-workflow', limits: { maxSteps: 24 } });
    expect(rec.validation).toEqual({ ok: true, tasks: 4, order: ['opponent', 'session', 'briefing', 'notice'] });
    expect(rec.run.outcome).toBe('AWAITING_APPROVAL');
    expect(d.store.list()).toEqual([rec.executionId]);
  });

  it('refuses outside the Lab, before it reads the plan or keeps anything', () => {
    for (const environment of ['PRODUCTION', 'STAGING', 'PREVIEW'] as const) {
      const d = deps({ environment });
      expect([environment, refusal(submit(d))]).toEqual([environment, { code: 'ENVIRONMENT_NOT_LAB', cause: null }]);
      expect(d.store.list()).toEqual([]);
    }
  });

  it('negative: a request that is not exactly a v1 request is refused, and nothing is kept', () => {
    const good = executionRequest('matchday-0001', matchdayPlan());
    const cases: Array<[string, unknown]> = [
      ['another contract', { ...good, contract: 'familista.lab-execution/v2' }],
      ['no plan', (({ plan: _p, ...rest }) => rest)(good)],
      ['an unknown key', { ...good, priority: 'HIGH' }],
      ['a request id too short', { ...good, requestId: 'abc' }],
      ['a request id with capitals', { ...good, requestId: 'Matchday-0001' }],
      ['a limit of zero steps', { ...good, limits: { maxSteps: 0 } }],
      ['a limit past the plan bound', { ...good, limits: { maxSteps: 25 } }],
      ['an operator who is not synthetic', { ...good, operator: { userId: 'coach@example.com', role: 'HEAD_COACH' } }],
      ['not an object', 'submit everything'],
    ];
    for (const [name, req] of cases) {
      const d = deps();
      expect([name, refusal(submitExecution(req, d))?.code]).toEqual([name, 'REQUEST_INVALID']);
      expect(d.store.list()).toEqual([]);
    }
    const huge = { ...good, plan: { ...matchdayPlan(), title: 'x'.repeat(70_000) } };
    expect(refusal(submitExecution(huge, deps()))?.code).toBe('REQUEST_TOO_LARGE');
  });

  it('negative: an invalid plan is refused with the orchestrator\'s reason, and nothing runs or is kept', () => {
    const tasks = S.matchPreparation().tasks;
    const cases: Array<[string, unknown, string]> = [
      ['a real-looking tenant id', { ...matchdayPlan(), scope: { kind: 'CLUB', clubId: '3f8a2c1e-0000-4000-8000-000000000001' } }, 'CONTRACT_INVALID'],
      ['too many tasks', plan({}, Array.from({ length: 25 }, (_, i) => opponentTask(`opponent-${i}`))), 'CONTRACT_INVALID'],
      ['a cycle', plan({}, [opponentTask('first', ['second']), opponentTask('second', ['first'])]), 'CYCLE'],
      ['an unknown dependency', plan({}, [opponentTask('first', ['ghost'])]), 'DEPENDENCY_UNKNOWN'],
      ['a self dependency', plan({}, [opponentTask('first', ['first'])]), 'DEPENDENCY_SELF'],
      ['an undeclared handoff', plan({}, [tasks[0], { ...tasks[1], id: 'session', dependsOn: [] }, { ...tasks[0], id: 'second', dependsOn: ['session'] }]), 'HANDOFF_UNDECLARED'],
      ['an unknown operation', plan({}, [{ ...tasks[0], operation: 'tactics.unknown@1' }]), 'OPERATION_UNKNOWN'],
      ['a requester of another club', { ...matchdayPlan(), requestedBy: { userId: 'lab-user-x', role: 'HEAD_COACH', clubId: S.OTHER_LAB_CLUB } }, 'REQUESTER_SCOPE'],
    ];
    for (const [name, p, cause] of cases) {
      const d = deps();
      expect([name, refusal(submit(d, 'plan-check-0001', p))]).toEqual([name, { code: 'PLAN_INVALID', cause }]);
      expect(d.store.list()).toEqual([]);
    }
  });

  it('only a rostered operator, as their own role, with SUBMIT, for their own scope', () => {
    const cases: Array<[string, { userId: string; role: string }, string]> = [
      ['not on the roster', { userId: 'lab-user-stranger', role: 'HEAD_COACH' }, 'OPERATOR_UNKNOWN'],
      ['a role they do not hold', { userId: 'lab-user-head-coach', role: 'CLUB_ADMIN' }, 'OPERATOR_ROLE_MISMATCH'],
      ['no SUBMIT', ANALYST, 'OPERATOR_NOT_PERMITTED'],
      ['another club\'s operator', SOUTH_OPERATOR, 'OPERATOR_SCOPE'],
    ];
    for (const [name, op, code] of cases) {
      const d = deps();
      expect([name, refusal(submit(d, 'operator-0001', matchdayPlan(), op))?.code]).toEqual([name, code]);
      expect(d.store.list()).toEqual([]);
    }
    // negative control: the same plan, by the club's operator and by the Platform Owner's
    expect(submit(deps(), 'operator-0001', matchdayPlan(), NORTH_OPERATOR).status).toBe('ACCEPTED');
    expect(submit(deps(), 'operator-0001', matchdayPlan(), PLATFORM_OPERATOR).status).toBe('ACCEPTED');
  });

  it('an operator may not run a plan whose agents write records they may not read: a head coach and the medical plan', () => {
    const r = submit(deps(), 'medical-0001', S.medicalBoundary(), NORTH_OPERATOR);
    expect(refusal(r)?.code).toBe('OPERATOR_CANNOT_READ');
    // negative control: medical staff may
    expect(submit(deps(), 'medical-0001', S.medicalBoundary(), MEDICAL_OPERATOR).status).toBe('ACCEPTED');
  });

  it('idempotent: the same request again runs nothing; the same key for another plan or limit is refused; another operator\'s key is theirs', () => {
    const d = deps();
    const first = accepted(submit(d, 'matchday-0001'));
    const again = submit(d, 'matchday-0001');
    expect(again.status).toBe('REPLAYED');
    expect(accepted(again).digest).toBe(first.digest);
    expect(d.store.list()).toHaveLength(1);
    expect(refusal(submit(d, 'matchday-0001', S.partialFailure()))?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(refusal(submit(d, 'matchday-0001', matchdayPlan(), NORTH_OPERATOR, { maxSteps: 3 }))?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(d.store.get(first.executionId)?.digest).toBe(first.digest);
    const other = accepted(submit(d, 'matchday-0001', matchdayPlan(), PLATFORM_OPERATOR));
    expect(other.executionId).not.toBe(first.executionId);
    expect(executionIdFor(NORTH_OPERATOR.userId, 'matchday-0001')).toBe(first.executionId);
  });

  it('is deterministic: the same request in two stores is the same record, byte for byte', () => {
    expect(accepted(submit(deps())).digest).toBe(accepted(submit(deps())).digest);
  });
});

// ── 2. registry-driven selection ─────────────────────────────────────────────

describe('registry-driven agent selection', () => {
  it('Tactical → Training → Club Manager, each the least-privileged eligible agent, every other one passed over with a reason', () => {
    const rec = accepted(submit(deps()));
    expect(rec.routing.map((r) => [r.taskId, r.selected])).toEqual([
      ['opponent', 'club.tactical'], ['session', 'club.training'], ['briefing', 'club.club-manager'], ['notice', 'club.club-manager'],
    ]);
    for (const r of rec.routing) {
      expect(task(rec, r.taskId).agent?.id).toBe(r.selected);
      expect(r.passedOver.length + r.ranked.length).toBe(PLATFORM_AGENT_MANIFESTS.length);
      for (const p of r.passedOver) expect(p.reason.length).toBeGreaterThan(5);
    }
    const opponent = rec.routing[0];
    expect(opponent.passedOver.find((p) => p.agentId === 'club.medical')?.reason).toBe('domain MEDICAL, not TACTICS');
  });

  const setPiece = (lifecycle: AgentManifest['lifecycle']): AgentManifest => ({
    id: 'club.lab-set-piece-analyst', version: '0.1.0', title: 'LAB Set-Piece Analyst', domain: 'TACTICS', scope: 'CLUB', lifecycle,
    autonomyCeiling: AutonomyLevel.RECOMMEND, supervisor: 'HEAD_COACH', purpose: 'SYNTHETIC.', tools: ['getMatch', 'analyzeOpponent'],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] }, outputs: [],
  });
  const registryWith = (m: AgentManifest) => { const r = new AgentRegistry(); for (const x of PLATFORM_AGENT_MANIFESTS) r.register(x); r.register(m); return r; };

  it('a new LAB agent joins through the registry and, holding fewer tools, wins the task: no list of agents to change', () => {
    const rec = accepted(submit(deps({ registry: registryWith(setPiece('LAB')) })));
    expect(rec.routing[0]).toMatchObject({ selected: 'club.lab-set-piece-analyst', ranked: ['club.lab-set-piece-analyst', 'club.tactical'] });
    expect(task(rec, 'opponent').state).toBe('SUCCEEDED');
  });

  it('negative: as a DRAFT it is passed over for its lifecycle, and the tactical agent runs', () => {
    const rec = accepted(submit(deps({ registry: registryWith(setPiece('DRAFT')) })));
    expect(rec.routing[0].selected).toBe('club.tactical');
    expect(rec.routing[0].passedOver.find((p) => p.agentId === 'club.lab-set-piece-analyst')?.reason).toBe('lifecycle DRAFT is never routed to');
  });

  it('negative: a registry with no agent for a task refuses the plan before anything runs', () => {
    const r = submit(deps({ registry: new AgentRegistry() }));
    expect(refusal(r)).toEqual({ code: 'PLAN_INVALID', cause: 'NO_ELIGIBLE_AGENT' });
  });
});

// ── 3. multi-agent execution ─────────────────────────────────────────────────

describe('controlled multi-agent execution', () => {
  it('runs in dependency order, each handoff checked and accepted, each output validated', () => {
    const rec = accepted(submit(deps()));
    expect(states(rec)).toEqual({ opponent: 'SUCCEEDED', session: 'SUCCEEDED', briefing: 'SUCCEEDED', notice: 'AWAITING_APPROVAL' });
    expect(task(rec, 'session').inputs).toEqual([{ from: 'opponent', status: 'ACCEPTED' }]);
    expect(task(rec, 'briefing').inputs).toEqual([{ from: 'opponent', status: 'ACCEPTED' }, { from: 'session', status: 'ACCEPTED' }]);
    expect(rec.run.trace.filter((e) => e.type === 'HANDOFF_ACCEPTED')).toHaveLength(3);
    for (const id of ['opponent', 'session', 'briefing']) expect(task(rec, id).outputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(task(rec, 'notice').output).toBeNull();
  });

  it('contains a failure: what consumes it is skipped, the other branch completes', () => {
    const rec = accepted(submit(deps(), 'failure-0001', S.partialFailure()));
    expect(states(rec)).toEqual({ 'opponent-a': 'SUCCEEDED', 'opponent-b': 'FAILED', 'session-b': 'SKIPPED' });
    expect(task(rec, 'opponent-b').reason?.code).toBe('INPUT_INVALID');
    expect(rec.run.outcome).toBe('PARTIAL');
  });

  it('an execution limit halts the run at the step past it; nothing after it starts', () => {
    const rec = accepted(submit(deps(), 'limit-0001', matchdayPlan(), NORTH_OPERATOR, { maxSteps: 2 }));
    expect(rec.run.outcome).toBe('HALTED');
    expect(rec.run.stop?.code).toBe('EXECUTION_LIMIT');
    expect(states(rec)).toEqual({ opponent: 'SUCCEEDED', session: 'SUCCEEDED', briefing: 'CANCELLED', notice: 'CANCELLED' });
    // negative control: a limit the plan fits in
    expect(accepted(submit(deps(), 'limit-0001', matchdayPlan(), NORTH_OPERATOR, { maxSteps: 4 })).run.outcome).toBe('AWAITING_APPROVAL');
  });

  it('cancellation: by its operator or the Platform Owner\'s; refused and recorded for anyone else; final', () => {
    const d = deps();
    const rec = accepted(submit(d));
    const analyst = cancelExecution(rec.executionId, ANALYST, d);
    expect(refusal(analyst)?.code).toBe('OPERATOR_NOT_PERMITTED');
    expect(refusal(cancelExecution(rec.executionId, SOUTH_OPERATOR, d))?.code).toBe('OPERATOR_SCOPE');
    const kept = d.store.get(rec.executionId) as ExecutionRecord;
    expect(kept.log.filter((e) => e.type === 'CANCEL_REFUSED').map((e) => e.code)).toEqual(['OPERATOR_NOT_PERMITTED', 'OPERATOR_SCOPE']);
    expect(kept.run.outcome).toBe('AWAITING_APPROVAL');

    const cancelled = accepted(cancelExecution(rec.executionId, PLATFORM_OPERATOR, d));
    expect(cancelled.run.outcome).toBe('CANCELLED');
    expect(task(cancelled, 'notice')).toMatchObject({ state: 'CANCELLED', reason: { code: 'CANCELLED_BY_OPERATOR' } });
    expect(states(cancelled)).toMatchObject({ opponent: 'SUCCEEDED', session: 'SUCCEEDED', briefing: 'SUCCEEDED' });
    expect(refusal(cancelExecution(rec.executionId, NORTH_OPERATOR, d))?.code).toBe('EXECUTION_SETTLED');
    expect(refusal(decideExecution(rec.executionId, approveNotice(), d))?.code).toBe('EXECUTION_SETTLED');
  });

  it('runs every scenario with the network refused: no model, gateway or external call', () => {
    const refuse = () => { throw new Error('network refused in the Lab'); };
    const saved = { hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, f: (globalThis as { fetch?: unknown }).fetch };
    Object.assign(http, { request: refuse, get: refuse });
    Object.assign(https, { request: refuse, get: refuse });
    Object.assign(net, { connect: refuse });
    (globalThis as { fetch?: unknown }).fetch = refuse;
    try {
      expect(runDemonstration().every((s) => s.verified !== false)).toBe(true);
    } finally {
      Object.assign(http, { request: saved.hr, get: saved.hg });
      Object.assign(https, { request: saved.sr, get: saved.sg });
      Object.assign(net, { connect: saved.nc });
      (globalThis as { fetch?: unknown }).fetch = saved.f;
    }
  });
});

// ── 4. human approval ────────────────────────────────────────────────────────

describe('human approval', () => {
  it('the staff notice waits for a person; once a club admin approves, it runs, and only describes the notice', () => {
    const d = deps();
    const rec = accepted(submit(d));
    expect(task(rec, 'notice').approval).toEqual({ eligibleRoles: ['SUPER_ADMIN', 'CLUB_ADMIN', 'HEAD_COACH'], decision: null, decidedBy: null });
    const done = accepted(decideExecution(rec.executionId, approveNotice(), d));
    expect(done.run.outcome).toBe('COMPLETED');
    expect(task(done, 'notice').output).toMatchObject({ audience: 'STAFF', sent: false, simulated: true });
    expect(done.decisions).toEqual([{ taskId: 'notice', decision: 'APPROVED', byRole: 'CLUB_ADMIN', accepted: true }]);
  });

  it('no self-approval: neither the operator who submitted it nor the person who requested it may decide it', () => {
    const d = deps();
    // The Platform Owner's operator submits a plan the head coach requested.
    const rec = accepted(submit(d, 'matchday-0001', matchdayPlan(), PLATFORM_OPERATOR));
    const bySubmitter = decideExecution(rec.executionId, approveNotice({ userId: PLATFORM_OPERATOR.userId, role: 'SUPER_ADMIN', clubId: null }), d);
    expect(refusal(bySubmitter)?.code).toBe('SELF_APPROVAL');
    const byRequester = decideExecution(rec.executionId, approveNotice({ ...S.HEAD_COACH }), d);
    expect(refusal(byRequester)).toEqual({ code: 'DECISION_REFUSED', cause: 'SEGREGATION_OF_DUTIES' });
    const kept = d.store.get(rec.executionId) as ExecutionRecord;
    expect(kept.run.outcome).toBe('AWAITING_APPROVAL');
    expect(kept.log.filter((e) => e.type === 'DECISION_REFUSED').map((e) => e.code)).toEqual(['SELF_APPROVAL']);
    // negative control: somebody else, of the club, who may decide it
    expect(accepted(decideExecution(rec.executionId, approveNotice(), d)).run.outcome).toBe('COMPLETED');
  });

  it('an approver role of the plan\'s own club only', () => {
    const d = deps();
    const rec = accepted(submit(d));
    expect(refusal(decideExecution(rec.executionId, approveNotice({ userId: 'lab-user-analyst', role: 'ANALYST', clubId: S.LAB_CLUB }), d))).toEqual({ code: 'DECISION_REFUSED', cause: 'APPROVER_ROLE' });
    expect(refusal(decideExecution(rec.executionId, approveNotice({ ...SOUTH_CLUB_ADMIN }), d))).toEqual({ code: 'DECISION_REFUSED', cause: 'APPROVER_CLUB' });
    expect(refusal(decideExecution(rec.executionId, { taskId: 'notice', decision: 'MAYBE', by: { ...S.CLUB_ADMIN } }, d))?.code).toBe('DECISION_INVALID');
    expect(refusal(decideExecution(rec.executionId, { ...approveNotice(), taskId: 'briefing' }, d))).toEqual({ code: 'DECISION_REFUSED', cause: 'APPROVAL_NOT_PENDING' });
    expect((d.store.get(rec.executionId) as ExecutionRecord).run.outcome).toBe('AWAITING_APPROVAL');
  });

  it('a rejection ends the action there', () => {
    const d = deps();
    const rec = accepted(submit(d));
    const done = accepted(decideExecution(rec.executionId, { ...approveNotice(), decision: 'REJECTED' }, d));
    expect(task(done, 'notice').state).toBe('REJECTED');
    expect(done.run.outcome).toBe('PARTIAL');
  });

  it('a medical action still finds no eligible approver: every approver role is refused, and it never runs', () => {
    const d = deps();
    const rec = accepted(submit(d, 'medical-0001', S.medicalBoundary(), MEDICAL_OPERATOR));
    expect(task(rec, 'recommendation').approval?.eligibleRoles).toEqual([]);
    for (const role of APPROVER_ROLES) {
      expect(tierFor(role, 'MEDICAL')).toBe('NONE');
      const r = decideExecution(rec.executionId, { taskId: 'recommendation', decision: 'APPROVED', by: { userId: `lab-user-${role.toLowerCase().replace(/_/g, '-')}`, role, clubId: role === 'SUPER_ADMIN' ? null : S.LAB_CLUB } }, d);
      expect([role, refusal(r)]).toEqual([role, { code: 'DECISION_REFUSED', cause: 'APPROVER_CANNOT_READ' }]);
    }
    const kept = d.store.get(rec.executionId) as ExecutionRecord;
    expect(task(kept, 'recommendation')).toMatchObject({ state: 'AWAITING_APPROVAL', output: null });
  });

  it('medical data stays with medical agents: a health field in a training input is refused, and a medical handoff to training is blocked', () => {
    const health = accepted(submit(deps(), 'medical-0002', healthDataPlan()));
    expect(task(health, 'session')).toMatchObject({ state: 'REFUSED', reason: { code: 'INPUT_HEALTH_DATA' } });
    const handoff = accepted(submit(deps(), 'medical-0003', S.medicalHandoff(), MEDICAL_OPERATOR));
    expect(task(handoff, 'load')).toMatchObject({ state: 'REFUSED', reason: { code: 'HANDOFF_BLOCKED' }, inputs: [{ from: 'availability', status: 'BLOCKED' }] });
  });

  it('a task input that names another club is refused, and its sibling still completes', () => {
    const rec = accepted(submit(deps(), 'tenant-0001', S.crossTenantInput()));
    expect(task(rec, 'foreign')).toMatchObject({ state: 'REFUSED', reason: { code: 'CROSS_TENANT' } });
    expect(task(rec, 'own').state).toBe('SUCCEEDED');
  });

  describe('a changed security context invalidates what was asked of the approvers', () => {
    const changes: Array<[string, () => Partial<ExecutionDeps>, string]> = [
      ['the registry', () => ({ registry: changedRegistry() }), 'registry'],
      ['the operations', () => {
        const c = labExecutionOperations();
        c.register({ ...labOperations().get('tactics.opponent-profile@1')!, key: 'tactics.opponent-profile@2' });
        return { operations: c };
      }, 'operations'],
      ['the roster', () => ({ operators: [...LAB_OPERATORS, { userId: 'lab-user-new', role: 'HEAD_COACH', scope: { kind: 'CLUB', clubId: S.LAB_CLUB }, permissions: ['SUBMIT'] }] as typeof LAB_OPERATORS }), 'policy'],
    ];
    it.each(changes)('%s', (_name, change, part) => {
      const d = deps();
      const rec = accepted(submit(d));
      const r = decideExecution(rec.executionId, approveNotice(), { ...d, ...change() });
      expect(refusal(r)?.code).toBe('APPROVAL_CONTEXT_CHANGED');
      expect(r.status === 'REFUSED' && r.refusal.message).toContain(`(${part})`);
      const kept = d.store.get(rec.executionId) as ExecutionRecord;
      expect(kept.run).toMatchObject({ outcome: 'HALTED', stop: { code: 'APPROVAL_CONTEXT_CHANGED' } });
      expect(task(kept, 'notice').state).toBe('CANCELLED');
      expect(kept.log.map((e) => e.type)).toContain('APPROVAL_INVALIDATED');
    });

    it('negative control: the same context, and the approval holds', () => {
      const d = deps();
      const rec = accepted(submit(d));
      expect(securityContext(d.registry, d.operations, LAB_OPERATORS).digest).toBe(rec.context.digest);
      expect(accepted(decideExecution(rec.executionId, approveNotice(), d)).run.outcome).toBe('COMPLETED');
    });
  });
});

// ── 5. the kill switch ───────────────────────────────────────────────────────

describe('the global kill switch', () => {
  it('engaged before submission: nothing starts and nothing is kept; released, the same request runs', () => {
    const d = deps();
    engageKillSwitch('test');
    expect(refusal(submit(d))?.code).toBe('KILL_SWITCH');
    expect(d.store.list()).toEqual([]);
    releaseKillSwitch();
    expect(submit(d).status).toBe('ACCEPTED');
  });

  it.each([2, 3, 4])('engaged as task %i is about to start: the run halts there, and nothing after it runs', (at) => {
    const d = deps({ beforeTransition: ({ step }) => { if (step === at) engageKillSwitch('test: between transitions'); } });
    const rec = accepted(submit(d));
    expect(rec.run).toMatchObject({ outcome: 'HALTED', stop: { code: 'KILL_SWITCH' } });
    const order = rec.validation.order;
    for (const [i, id] of order.entries()) expect([id, task(rec, id).state]).toEqual([id, i < at - 1 ? 'SUCCEEDED' : 'CANCELLED']);
    const types = rec.run.trace.map((e) => e.type);
    const halted = types.indexOf('RUN_HALTED');
    expect(halted).toBeGreaterThan(0);
    expect(types.slice(halted).filter((t) => t === 'TASK_SUCCEEDED' || t === 'APPROVAL_REQUIRED')).toEqual([]);
  });

  it('engaged while an approval waits: the decision is not applied, the workflow halts, and releasing resumes nothing', () => {
    const d = deps();
    const rec = accepted(submit(d));
    engageKillSwitch('test: while waiting');
    const r = decideExecution(rec.executionId, approveNotice(), d);
    expect(refusal(r)?.code).toBe('KILL_SWITCH');
    const kept = d.store.get(rec.executionId) as ExecutionRecord;
    expect(kept.run).toMatchObject({ outcome: 'HALTED', stop: { code: 'KILL_SWITCH' } });
    expect(task(kept, 'notice')).toMatchObject({ state: 'CANCELLED', output: null, approval: { decision: null } });
    releaseKillSwitch();
    expect(refusal(decideExecution(rec.executionId, approveNotice(), d))?.code).toBe('EXECUTION_SETTLED');
  });

  it('engaged between an approval and the task it starts: the orchestrator refuses the decision and halts', () => {
    const d = deps();
    const rec = accepted(submit(d));
    const late = { ...d, beforeTransition: () => engageKillSwitch('test: at the approved task') };
    const r = decideExecution(rec.executionId, approveNotice(), late);
    expect(refusal(r)).toEqual({ code: 'DECISION_REFUSED', cause: 'KILL_SWITCH' });
    expect((d.store.get(rec.executionId) as ExecutionRecord).run.outcome).toBe('HALTED');
  });

  it('halts every execution that has not settled, and leaves settled ones as they were', () => {
    const d = deps();
    const a = accepted(submit(d, 'sweep-0001'));
    const b = accepted(submit(d, 'sweep-0002'));
    const done = accepted(submit(d, 'sweep-0003', S.matchPreparation()));
    expect(() => haltOpenExecutions(d)).toThrow(/not engaged/);
    engageKillSwitch('test: sweep');
    expect(haltOpenExecutions(d)).toEqual({ halted: [a.executionId, b.executionId].sort(), unreadable: [] });
    expect((d.store.get(done.executionId) as ExecutionRecord).digest).toBe(done.digest);
    for (const id of [a.executionId, b.executionId]) expect((d.store.get(id) as ExecutionRecord).run.outcome).toBe('HALTED');
  });
});

// ── 6. observability and integrity ───────────────────────────────────────────

describe('what is recorded, and that it is the record that was written', () => {
  const completed = () => {
    const d = deps();
    const rec = accepted(submit(d));
    return { d, rec: accepted(decideExecution(rec.executionId, approveNotice(), d)) };
  };

  it('records the validation, assignments, routing, every transition and handoff, the approval, and both chains', () => {
    const { rec } = completed();
    expect(rec.log.map((e) => e.type)).toEqual([
      'EXECUTION_SUBMITTED', 'OPERATOR_AUTHORIZED', 'PLAN_VALIDATED', 'AGENTS_ASSIGNED', 'RUN_ADVANCED', 'DECISION_SUBMITTED', 'RUN_ADVANCED',
    ]);
    expect(rec.log[0].prev).toBe(EXECUTION_GENESIS);
    const types = rec.run.trace.map((e) => e.type);
    for (const t of ['PLAN_RECEIVED', 'PLAN_ACCEPTED', 'TASK_ROUTED', 'HANDOFF_ACCEPTED', 'APPROVAL_REQUIRED', 'APPROVAL_DECIDED', 'TASK_SUCCEEDED', 'RUN_SETTLED']) expect(types).toContain(t);
    expect(verifyLog(rec.log).ok).toBe(true);
    expect(verifyTrace(rec.run.trace).ok).toBe(true);
    expect(rec.log[rec.log.length - 1].detail.startsWith(`run ${rec.run.digest}:`)).toBe(true);
    expect(verifyExecution(rec)).toEqual({ ok: true, reasons: [] });
  });

  it('negative: tampering with any part is caught, and names the part', () => {
    const { rec } = completed();
    const cases: Array<[string, (r: Row) => void, RegExp]> = [
      ['the digest', (r) => { r.digest = '0'.repeat(64); }, /record's digest/],
      ['a task state', (r) => { r.run.tasks[3].state = 'REJECTED'; }, /record's digest|coherence/],
      ['a trace event', (r) => { r.run.trace[2].detail = 'edited'; }, /run trace breaks at event 3/],
      ['the execution log', (r) => { r.log[1].detail = 'edited'; }, /execution log breaks at event 2/],
      ['the routing', (r) => { r.routing[0].selected = 'club.medical'; }, /routing record did not select/],
      ['the plan digest', (r) => { r.planDigest = 'f'.repeat(64); }, /not of the plan that was submitted/],
      ['the operator', (r) => { r.operator.userId = 'lab-operator-platform'; }, /execution id is not its operator's/],
    ];
    for (const [name, edit, reason] of cases) {
      const t = clone(rec) as Row;
      edit(t);
      const v = verifyExecution(t);
      expect([name, v.ok, v.reasons.some((x) => reason.test(x))]).toEqual([name, false, true]);
    }
    // An edit re-sealed with a fresh digest is still caught: the trace records something else.
    const resealed = clone(rec) as Row;
    resealed.run.tasks[3].state = 'REJECTED';
    const { digest: _d, ...rest } = resealed;
    resealed.digest = digestOf(rest);
    expect(verifyExecution(resealed).reasons).toEqual(['coherence: task notice is REJECTED; its trace records SUCCEEDED']);
  });

  it('a tampered record in the store is refused for every later step', () => {
    const d = deps();
    const rec = accepted(submit(d));
    const t = clone(rec) as Row;
    t.run.tasks[3].state = 'SUCCEEDED';
    d.store.put(t as ExecutionRecord);
    expect(refusal(decideExecution(rec.executionId, approveNotice(), d))?.code).toBe('EXECUTION_TAMPERED');
    expect(refusal(cancelExecution(rec.executionId, NORTH_OPERATOR, d))?.code).toBe('EXECUTION_TAMPERED');
    expect(refusal(submit(d))?.code).toBe('EXECUTION_TAMPERED');
  });

  it('a completed record is a publication candidate production\'s verifier accepts; a stopped one is not; nothing is published', () => {
    const before = readCommittedEvidence();
    const { d, rec } = completed();
    const candidate = publicationCandidate(rec, d.operations);
    expect(candidate.reasons).toEqual([]);
    expect(verifyOrchestrationEvidence(candidate.evidence).reasons).toEqual([]);
    expect(candidate.evidence?.runs[0]).toMatchObject({ scenario: rec.executionId, outcome: 'COMPLETED', id: rec.run.digest });
    const halted = accepted(submit(deps(), 'limit-0001', matchdayPlan(), NORTH_OPERATOR, { maxSteps: 1 }));
    const refusedCandidate = publicationCandidate(halted, d.operations);
    expect(refusedCandidate.evidence).toBeNull();
    expect(refusedCandidate.reasons.join(' ')).toMatch(/stopped run stays in the Lab/);
    expect(readCommittedEvidence()).toBe(before);
  });
});

// ── 7. isolation ─────────────────────────────────────────────────────────────

describe('isolation', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it('there is no production way in: nothing in src/ names controlled execution, and no route serves it', () => {
    const files = walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|js)$/.test(f));
    const offenders = files.filter((f) => /execute-cli|submitExecution|decideExecution|cancelExecution|haltOpenExecutions/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    // AI-0.5: the record's contract is named once, by the verifier of approved publications, which re-derives ids from it.
    const naming = files.filter((f) => /lab-execution/.test(fs.readFileSync(f, 'utf8')));
    expect(naming.map((f) => path.relative(ROOT, f))).toEqual(['src/platform/agents/execution-evidence.ts']);
  });

  it('the store refuses to exist outside the Lab, and refuses an id that is not an execution\'s', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-exec-'));
    try {
      for (const env of ['PRODUCTION', 'STAGING', 'PREVIEW'] as const) expect(() => new FileExecutionStore(dir, env)).toThrow(/Lab only/);
      const store = new FileExecutionStore(dir, 'LAB');
      expect(store.get('../../etc/passwd')).toBeNull();
      expect(() => store.put({ executionId: '../escape' } as ExecutionRecord)).toThrow(/not an execution id/);
      const rec = accepted(submit(deps({ store })));
      expect(fs.readdirSync(dir)).toEqual([`${rec.executionId}.json`]);
      expect(verifyExecution(store.get(rec.executionId)).ok).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('records are git-ignored where the CLI keeps them', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).toMatch(/^lab\/orchestrator\/\.executions\/$/m);
  });

  it('the roster is valid, synthetic and least-privileged; an invalid one is refused', () => {
    expect(validateOperators(LAB_OPERATORS)).toEqual([]);
    for (const o of LAB_OPERATORS) expect(o.userId).toMatch(/^lab-/);
    expect(LAB_OPERATORS.filter((o) => o.scope.kind === 'PLATFORM').map((o) => o.role)).toEqual(['SUPER_ADMIN']);
    const bad = validateOperators([
      { userId: 'lab-x', role: 'HEAD_COACH', scope: { kind: 'PLATFORM' }, permissions: ['SUBMIT'] },
      { userId: 'lab-x', role: 'HEAD_COACH', scope: { kind: 'CLUB', clubId: 'lab-c' }, permissions: ['SUBMIT', 'SUBMIT'] },
      { userId: 'person@example.com', role: 'HEAD_COACH', scope: { kind: 'PLATFORM' }, permissions: [] },
      { userId: 'lab-y', role: 'HEAD_COACH', scope: { kind: 'CLUB', clubId: 'lab-c' }, permissions: ['DEPLOY'] },
    ]);
    expect(bad.join(' | ')).toMatch(/only the Platform Owner operates the platform scope/);
    expect(bad.join(' | ')).toMatch(/listed twice/);
    expect(bad).toHaveLength(5);
  });

  it('the published AI-0.3 evidence is exactly as it was: built from the first slice\'s operations, byte for byte', () => {
    expect(serialise(buildEvidence({ environment: 'LAB' }))).toBe(readCommittedEvidence());
    expect(labOperations().get('operations.staff-notice@1')).toBeUndefined();
  });
});

// ── 8. the demonstration and the CLI ─────────────────────────────────────────

describe('the demonstration', () => {
  it('every scenario ends as the platform\'s rules require, and every record verifies', () => {
    const demo = runDemonstration();
    const summary = Object.fromEntries(demo.map((s) => [s.slug, s.steps.map((st) => `${st.status}${st.code ? ` ${st.code}` : ''}${st.outcome ? ` ${st.outcome}` : ''}`)]));
    expect(summary).toEqual({
      'matchday': ['ACCEPTED AWAITING_APPROVAL', 'REFUSED SELF_APPROVAL AWAITING_APPROVAL', 'UPDATED COMPLETED'],
      'idempotency': ['ACCEPTED COMPLETED', 'REPLAYED COMPLETED', 'REFUSED IDEMPOTENCY_CONFLICT COMPLETED'],
      'failure': ['ACCEPTED PARTIAL'],
      'cancellation': ['ACCEPTED AWAITING_APPROVAL', 'REFUSED OPERATOR_NOT_PERMITTED AWAITING_APPROVAL', 'UPDATED CANCELLED', 'REFUSED EXECUTION_SETTLED CANCELLED'],
      'unauthorized': [
        'REFUSED OPERATOR_UNKNOWN', 'REFUSED OPERATOR_NOT_PERMITTED', 'REFUSED OPERATOR_SCOPE', 'REFUSED OPERATOR_ROLE_MISMATCH',
        'REFUSED PLAN_INVALID (CONTRACT_INVALID)', 'ACCEPTED PARTIAL', 'ACCEPTED AWAITING_APPROVAL', 'REFUSED DECISION_REFUSED (APPROVER_CLUB) AWAITING_APPROVAL',
      ],
      'medical': [
        'REFUSED OPERATOR_CANNOT_READ', 'ACCEPTED PARTIAL', 'ACCEPTED PARTIAL', 'ACCEPTED AWAITING_APPROVAL',
        'REFUSED DECISION_REFUSED (APPROVER_CANNOT_READ) AWAITING_APPROVAL',
      ],
      'kill-switch-before': ['REFUSED KILL_SWITCH'],
      'kill-switch-between': ['ACCEPTED HALTED'],
      'kill-switch-waiting': ['ACCEPTED AWAITING_APPROVAL', 'REFUSED KILL_SWITCH HALTED', 'REFUSED EXECUTION_SETTLED HALTED'],
      'kill-switch-sweep': ['ACCEPTED AWAITING_APPROVAL', 'ACCEPTED AWAITING_APPROVAL', 'OBSERVED KILL_SWITCH HALTED'],
      'limit': ['ACCEPTED HALTED'],
      'context-change': ['ACCEPTED AWAITING_APPROVAL', 'REFUSED APPROVAL_CONTEXT_CHANGED HALTED'],
    });
    const matchday = demo.find((s) => s.slug === 'matchday')!;
    expect(matchday.tasks.map((t) => [t.id, t.state, t.agent])).toEqual([
      ['opponent', 'SUCCEEDED', 'club.tactical'], ['session', 'SUCCEEDED', 'club.training'],
      ['briefing', 'SUCCEEDED', 'club.club-manager'], ['notice', 'SUCCEEDED', 'club.club-manager'],
    ]);
    for (const s of demo) expect([s.slug, s.verified]).toEqual([s.slug, s.executionId ? true : null]);
    expect(killSwitchEngaged()).toBe(false);
  });

  it('refuses to start with the kill switch engaged', () => {
    engageKillSwitch('test');
    expect(() => runDemonstration()).toThrow(/kill switch is engaged/);
  });

  it('the committed example request is the demonstration\'s matchday request', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'lab/orchestrator/requests/matchday.json'), 'utf8'));
    expect(committed).toEqual(executionRequest('matchday-example-0001', matchdayPlan()));
  });
});

describe('the LAB CLI, end to end, against a store of its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-exec-cli-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = (args: string[], env: Record<string, string> = { FAMILISTA_ENV: 'LAB' }) => spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'lab/orchestrator/execute-cli.ts', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { PATH: String(process.env.PATH), HOME: String(process.env.HOME ?? ''), FAMILISTA_LAB_EXECUTIONS_DIR: dir, ...env },
  });
  const request = path.join(ROOT, 'lab/orchestrator/requests/matchday.json');
  const id = executionIdFor(NORTH_OPERATOR.userId, 'matchday-example-0001');

  it('refuses outside the Lab, and touches nothing', () => {
    const other = path.join(dir, 'untouched');
    const r = cli(['submit', request], { FAMILISTA_ENV: 'PRODUCTION', FAMILISTA_LAB_EXECUTIONS_DIR: other });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ENVIRONMENT_NOT_LAB/);
    expect(fs.existsSync(other)).toBe(false);
  }, 150_000);

  it('submit, a refused self-approval, an approval, verify, show without outputs, and a replay', () => {
    const s = cli(['submit', request]);
    expect([s.status, s.stdout.split('\n')[0]]).toEqual([0, 'accepted']);
    expect(s.stdout).toContain(`${id}  AWAITING_APPROVAL`);
    const self = cli(['decide', id, 'notice', 'APPROVED', '--by', 'lab-user-head-coach', '--role', 'HEAD_COACH', '--club', 'lab-club-north']);
    expect([self.status, self.stdout.split('\n')[0]]).toEqual([2, 'refused SELF_APPROVAL: lab-user-head-coach submitted this execution and may not decide its approvals']);
    const ok = cli(['decide', id, 'notice', 'APPROVED', '--by', 'lab-user-club-admin', '--role', 'CLUB_ADMIN', '--club', 'lab-club-north']);
    expect([ok.status, ok.stdout.split('\n')[0]]).toEqual([0, 'updated']);
    const v = cli(['verify', id]);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/verified \(record digest/);
    expect(v.stdout).toMatch(/publication: a candidate production's verifier accepts; not published/);
    const show = cli(['show', id, '--trace']);
    expect(show.status).toBe(0);
    expect(show.stdout).toMatch(/integrity verified/);
    // An operation's output never reaches the terminal: the session draft's focus line is in the record, not the screen.
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).run.tasks)).toContain('Play out under a high press');
    expect(show.stdout).not.toContain('Play out under a high press');
    expect(cli(['submit', request]).stdout.split('\n')[0]).toBe('replayed');
  }, 600_000);

  it('the kill switch holds across commands; only the Platform Owner\'s operator releases it', () => {
    const engage = cli(['kill-switch', 'engage', '--reason', 'cli test', '--operator', 'lab-user-head-coach', '--role', 'HEAD_COACH']);
    expect(engage.status).toBe(0);
    const req = path.join(dir, 'other.json');
    fs.writeFileSync(req, JSON.stringify(executionRequest('matchday-example-0002', matchdayPlan())));
    const blocked = cli(['submit', req]);
    expect([blocked.status, blocked.stdout]).toEqual([2, expect.stringMatching(/^refused KILL_SWITCH/)]);
    const notOwner = cli(['kill-switch', 'release', '--operator', 'lab-user-head-coach', '--role', 'HEAD_COACH']);
    expect([notOwner.status, notOwner.stderr]).toEqual([2, expect.stringMatching(/OPERATOR_SCOPE/)]);
    const release = cli(['kill-switch', 'release', '--operator', 'lab-operator-platform', '--role', 'SUPER_ADMIN']);
    expect(release.status).toBe(0);
    expect(cli(['submit', req]).status).toBe(0);
  }, 600_000);
});
