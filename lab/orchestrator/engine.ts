// The orchestrator — one plan, many agents, every step governed
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.2 (LAB). `startRun` takes a plan
// (contracts.ts) and, in this order, refuses it before anything runs unless:
//
//   1. this process is the Lab                (environment.ts — never a request)
//   2. it is a valid v1 plan                  (bounded, synthetic `lab-…` refs only)
//   3. its tasks form a DAG of known operations whose every edge is an exchange
//      the consuming operation declares
//   4. the requester belongs to the plan's scope: a club plan to its own club,
//      a platform plan to the Platform Owner
//   5. every task routes to a registry agent (routing.ts)
//   6. the requester may read everything those agents would write (the AI read
//      matrix, ai-read-policy.ts)
//
// Then it runs the tasks in a fixed topological order. For each one:
//
//   authorize   the tool registry decides, as the routed agent in the Lab
//               (authorizeTool: holdings, autonomy, environment, kill switch);
//               an action a person must approve stops here, AWAITING_APPROVAL
//   input       no other tenant's id, no health data outside a medical agent,
//               within its size, valid for the operation
//   handoffs    each upstream output it consumes is within what this agent may
//               read, and a medical record reaches a medical agent only
//   run         the operation's deterministic LAB simulation, on frozen copies
//   output      valid for the operation, within its size, health data only if
//               declared RESTRICTED, within what the agent may write
//
// A task that does not succeed takes every task that consumes it with it
// (SKIPPED); tasks that do not depend on it carry on. `decideApproval` records a
// person's decision — an approver role, of the plan's club, not the requester,
// able to read what the task writes — and continues the run. Every decision is
// in the trace (trace.ts). Nothing reaches a database, the AI Gateway, a model
// or the network, and no action is ever made: in the Lab an action operation
// describes the change a person approved.
//
// AI-0.4 adds two things a controlled execution (execution.ts) needs, both
// opt-in, so a run without them is exactly what it was: a `guard` the context
// may carry, asked before every task starts (the kill switch, an execution
// limit), which stops the run there; and `stopRun`, which ends a run that has
// not settled on its own. Either way every task not yet finished is CANCELLED,
// in the trace, and nothing that consumes it runs.

import { authorizeTool, killSwitchEngaged, tool, type AgentIdentity } from '../../src/platform/intelligence/agents';
import { currentEnvironment, type FamilistaEnvironment } from '../../src/platform/environment';
import { withinCeiling } from '../../src/platform/intelligence/data-classes';
import { deepFreeze, type AgentRegistry, type RegisteredAgent } from '../../src/platform/agents/registry';
import { holdsHealthData, tierFor, type AIRecordClass } from '../../src/security/ai-read-policy';
import { APPROVER_ROLES } from '../../src/security/approver-roles';
import {
  ApprovalDecisionSchema, LIMITS, ORCHESTRATION_CONTRACT, PlanRequestSchema, TERMINAL_FAILURES,
  type ApprovalRefusalCode, type PlanRefusalCode, type PlanRequest, type PlanScope, type Reason, type RunOutcome,
  type StopCode, type TaskOutcome, type TaskReasonCode, type TaskSpec,
} from './contracts';
import { frozenCopy, type Handoff, type OperationCatalog } from './operations';
import { readCeiling, recordClassOf, route, writeCeiling } from './routing';
import { digestOf, Trace, type TraceEvent } from './trace';

export interface RunContext {
  registry: AgentRegistry;
  operations: OperationCatalog;
  /** Defaults to this process's own environment. */
  environment?: FamilistaEnvironment;
  /**
   * AI-0.4: asked before every task starts, with how many have started in this
   * run (this one included). A reason stops the run there: HALTED.
   */
  guard?: (at: { taskId: string; step: number }) => Reason<StopCode> | null;
}

/** How a run was stopped before it settled on its own. */
export interface RunStop { outcome: 'HALTED' | 'CANCELLED'; code: StopCode; message: string }

export interface PlanRun {
  contract: typeof ORCHESTRATION_CONTRACT;
  planId: string | null;
  environment: FamilistaEnvironment;
  /** The registry the plan was routed over, so a run can be tied to the agents it used. */
  registryDigest: string;
  outcome: RunOutcome;
  refusal: Reason<PlanRefusalCode> | null;
  plan: PlanRequest | null;
  order: string[];
  tasks: TaskOutcome[];
  trace: readonly TraceEvent[];
  /** The trace's head: one hash for everything that was decided. */
  digest: string;
  /** How many tasks were started, across every call on this run. */
  steps: number;
  stop: RunStop | null;
}

/** The identity a registry agent acts as in the Lab: its manifest's tools and ceiling, and nothing else. */
export function labIdentity(agent: RegisteredAgent, scope: PlanScope): AgentIdentity {
  return {
    agentId: `lab:${agent.id}@${agent.version}`, type: agent.domain, name: agent.title, status: 'ACTIVE',
    environment: 'LAB', scope: { clubId: scope.kind === 'CLUB' ? scope.clubId : null },
    tools: [...agent.tools], autonomy: agent.autonomyCeiling, ownerUserId: null,
  };
}

/** The approver roles that may also read everything the task writes. */
export const eligibleApproverRoles = (recordClass: AIRecordClass): string[] =>
  APPROVER_ROLES.filter((r) => tierFor(r, recordClass) === 'FULL');

const cap = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstIssue = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'invalid';
};

/** The first `clubId` anywhere in `value` that is not the plan's own. */
function foreignClub(value: unknown, scope: PlanScope, depth = 0): string | null {
  if (value === null || typeof value !== 'object' || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const v of value) { const f = foreignClub(v, scope, depth + 1); if (f) return f; }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'clubId' && (scope.kind !== 'CLUB' || v !== scope.clubId)) return String(v);
    const f = foreignClub(v, scope, depth + 1);
    if (f) return f;
  }
  return null;
}

/** Kahn's algorithm, lexicographic among the ready: one order for one plan, always. */
function topological(tasks: TaskSpec[]): { order: string[]; stuck: string[] } {
  const indegree = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const order: string[] = [];
  const ready = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id).sort();
  while (ready.length) {
    const id = ready.shift() as string;
    order.push(id);
    for (const t of tasks) {
      if (!t.dependsOn.includes(id)) continue;
      const left = (indegree.get(t.id) as number) - 1;
      indegree.set(t.id, left);
      if (left === 0) { ready.push(t.id); ready.sort(); }
    }
  }
  return { order, stuck: tasks.map((t) => t.id).filter((id) => !order.includes(id)).sort() };
}

// ── the run, as mutable working state; what leaves this file is frozen ──────

class Working {
  readonly byId = new Map<string, TaskOutcome>();
  constructor(
    readonly ctx: RunContext,
    readonly environment: FamilistaEnvironment,
    readonly trace: Trace,
    readonly plan: PlanRequest,
    readonly order: string[],
    tasks: TaskOutcome[],
    public steps = 0,
    public stop: RunStop | null = null,
  ) { for (const t of tasks) this.byId.set(t.id, t); }

  spec(id: string): TaskSpec { return this.plan.tasks.find((t) => t.id === id) as TaskSpec; }

  private end(t: TaskOutcome, state: 'FAILED' | 'REFUSED' | 'SKIPPED' | 'REJECTED', code: TaskReasonCode, message: string): void {
    t.state = state;
    t.reason = { code, message: cap(message) };
    const type = state === 'FAILED' ? 'TASK_FAILED' : state === 'SKIPPED' ? 'TASK_SKIPPED' : 'TASK_REFUSED';
    this.trace.append(type, { taskId: t.id, agentId: t.agent?.id ?? null, code, detail: t.reason.message });
  }

  /** One pass in topological order: everything that can move, moves. */
  advance(): void {
    for (const id of this.order) {
      if (this.stop) return;
      const t = this.byId.get(id) as TaskOutcome;
      if (t.state !== 'PENDING') continue;
      const deps = this.spec(id).dependsOn.map((d) => this.byId.get(d) as TaskOutcome);
      const failed = deps.find((d) => TERMINAL_FAILURES.has(d.state));
      if (failed) { this.end(t, 'SKIPPED', 'DEPENDENCY_NOT_SUCCEEDED', `"${failed.id}" ${failed.state.toLowerCase()}, so this never ran`); continue; }
      if (!deps.every((d) => d.state === 'SUCCEEDED')) continue;
      const stop = this.admit(id);
      if (stop) return this.halt('HALTED', stop.code, stop.message);
      this.execute(t, false);
    }
  }

  /** A task is about to start: count it, and ask the guard whether it may. */
  admit(taskId: string): Reason<StopCode> | null {
    this.steps += 1;
    return this.ctx.guard?.({ taskId, step: this.steps }) ?? null;
  }

  /** Stop the run: every task not yet finished is CANCELLED, and nothing more starts. */
  halt(outcome: RunStop['outcome'], code: StopCode, message: string): void {
    this.stop = { outcome, code, message: cap(message) };
    this.trace.append(outcome === 'HALTED' ? 'RUN_HALTED' : 'RUN_CANCELLED', { code, detail: this.stop.message });
    for (const id of this.order) {
      const t = this.byId.get(id) as TaskOutcome;
      if (t.state !== 'PENDING' && t.state !== 'AWAITING_APPROVAL') continue;
      t.state = 'CANCELLED';
      t.reason = { code, message: cap(`${outcome === 'HALTED' ? 'halted' : 'cancelled'} before it finished: ${message}`) };
      this.trace.append('TASK_CANCELLED', { taskId: t.id, agentId: t.agent?.id ?? null, code, detail: t.reason.message });
    }
  }

  execute(t: TaskOutcome, approved: boolean): void {
    const spec = this.spec(t.id);
    const agent = this.ctx.registry.get((t.agent as { id: string }).id) as RegisteredAgent;
    const op = this.ctx.operations.get(spec.operation) as NonNullable<ReturnType<OperationCatalog['get']>>;
    const scope = this.plan.scope;

    // authorize — the tool registry, as this agent, in this environment
    const decision = authorizeTool(labIdentity(agent, scope), op.tool, this.environment);
    if (!decision.allowed) {
      const stopped = killSwitchEngaged() && tool(op.tool)?.effect === 'WRITE';
      return this.end(t, 'REFUSED', stopped ? 'KILL_SWITCH' : 'AUTHORIZATION', decision.reason ?? 'refused');
    }
    if (decision.requiresApproval && !approved) {
      const roles = eligibleApproverRoles(t.recordClass as AIRecordClass);
      t.state = 'AWAITING_APPROVAL';
      t.approval = { eligibleRoles: roles, decision: null, decidedBy: null };
      this.trace.append('APPROVAL_REQUIRED', {
        taskId: t.id, agentId: agent.id, code: roles.length ? null : 'NO_ELIGIBLE_APPROVER',
        detail: roles.length
          ? `"${op.tool}" waits for a person: ${roles.join(', ')}`
          : `"${op.tool}" waits for a person, and no approver role may read ${t.recordClass} records`,
      });
      return;
    }

    // input
    if (JSON.stringify(spec.input).length > LIMITS.maxInputBytes) return this.end(t, 'REFUSED', 'INPUT_TOO_LARGE', `input exceeds ${LIMITS.maxInputBytes} bytes`);
    const foreign = foreignClub(spec.input, scope);
    if (foreign) return this.end(t, 'REFUSED', 'CROSS_TENANT', `input names club "${foreign}", outside this plan`);
    if (holdsHealthData(spec.input) && readCeiling(agent) !== 'RESTRICTED') {
      return this.end(t, 'REFUSED', 'INPUT_HEALTH_DATA', `input holds health data, and ${agent.id} may not read it`);
    }
    const input = op.input.safeParse(spec.input);
    if (!input.success) return this.end(t, 'FAILED', 'INPUT_INVALID', firstIssue(input.error));

    // handoffs — the approved exchange, checked against who receives it
    const upstream: Handoff[] = [];
    for (const depId of spec.dependsOn) {
      const p = this.byId.get(depId) as TaskOutcome;
      const blocked = !withinCeiling(p.dataClass ?? 'RESTRICTED', readCeiling(agent))
        ? `${p.dataClass} output of "${p.id}" is above what ${agent.id} may read (${readCeiling(agent)})`
        : p.recordClass === 'MEDICAL' && agent.domain !== 'MEDICAL'
          ? `"${p.id}" is a medical record, and ${agent.id} is not a medical agent`
          : null;
      if (blocked) {
        t.inputs.push({ from: p.id, status: 'BLOCKED' });
        this.trace.append('HANDOFF_BLOCKED', { taskId: t.id, agentId: agent.id, code: 'HANDOFF_BLOCKED', detail: blocked });
        return this.end(t, 'REFUSED', 'HANDOFF_BLOCKED', blocked);
      }
      t.inputs.push({ from: p.id, status: 'ACCEPTED' });
      this.trace.append('HANDOFF_ACCEPTED', {
        taskId: t.id, agentId: agent.id,
        detail: `"${p.id}" (${p.agent?.id}, ${p.dataClass} ${p.recordClass}, ${String(p.outputDigest).slice(0, 12)}) → "${t.id}"`,
      });
      upstream.push({ taskId: p.id, operation: p.operation, agentId: (p.agent as { id: string }).id, dataClass: p.dataClass as NonNullable<TaskOutcome['dataClass']>, recordClass: p.recordClass as AIRecordClass, output: p.output });
    }

    // run — the LAB simulation, on frozen copies
    let raw: unknown;
    try { raw = op.run(frozenCopy(input.data), frozenCopy(upstream)); }
    catch (e) { return this.end(t, 'FAILED', 'OPERATION_FAILED', e instanceof Error ? e.message : String(e)); }

    // output
    const out = op.result.safeParse(raw);
    if (!out.success) return this.end(t, 'FAILED', 'OUTPUT_INVALID', firstIssue(out.error));
    if (JSON.stringify(out.data).length > LIMITS.maxOutputBytes) return this.end(t, 'FAILED', 'OUTPUT_TOO_LARGE', `output exceeds ${LIMITS.maxOutputBytes} bytes`);
    if (holdsHealthData(out.data) && op.output !== 'RESTRICTED') {
      return this.end(t, 'FAILED', 'OUTPUT_MISLABELLED', `output holds health data but is declared ${op.output}`);
    }
    if (!withinCeiling(op.output, writeCeiling(agent))) {
      return this.end(t, 'FAILED', 'OUTPUT_ABOVE_CEILING', `${op.output} output is above what ${agent.id} may write (${writeCeiling(agent)})`);
    }
    t.state = 'SUCCEEDED';
    t.output = deepFreeze(out.data);
    t.outputDigest = digestOf(out.data);
    this.trace.append('TASK_SUCCEEDED', { taskId: t.id, agentId: agent.id, detail: `${op.output} output ${t.outputDigest.slice(0, 12)}` });
  }

  outcome(): RunOutcome {
    if (this.stop) return this.stop.outcome;
    const states = [...this.byId.values()].map((t) => t.state);
    if (states.some((s) => s === 'AWAITING_APPROVAL' || s === 'PENDING')) return 'AWAITING_APPROVAL';
    if (states.every((s) => s === 'SUCCEEDED')) return 'COMPLETED';
    return states.some((s) => s === 'SUCCEEDED') ? 'PARTIAL' : 'FAILED';
  }

  settle(): PlanRun {
    const outcome = this.outcome();
    const count = (s: string) => [...this.byId.values()].filter((t) => t.state === s).length;
    // A run nothing stopped reads exactly as it did before AI-0.4.
    const cancelled = count('CANCELLED') ? `, ${count('CANCELLED')} cancelled` : '';
    this.trace.append('RUN_SETTLED', {
      code: outcome,
      detail: `${count('SUCCEEDED')} succeeded, ${count('AWAITING_APPROVAL')} awaiting approval, ${count('FAILED')} failed, ${count('REFUSED')} refused, ${count('SKIPPED')} skipped, ${count('REJECTED')} rejected${cancelled}`,
    });
    return deepFreeze({
      contract: ORCHESTRATION_CONTRACT, planId: this.plan.id, environment: this.environment,
      registryDigest: this.ctx.registry.digest(), outcome, refusal: null, plan: this.plan, order: this.order,
      tasks: this.order.map((id) => this.byId.get(id) as TaskOutcome), trace: this.trace.events, digest: this.trace.head,
      steps: this.steps, stop: this.stop,
    });
  }
}

function refused(ctx: RunContext, environment: FamilistaEnvironment, trace: Trace, planId: string | null, code: PlanRefusalCode, message: string): PlanRun {
  trace.append('PLAN_REFUSED', { code, detail: cap(message) });
  trace.append('RUN_SETTLED', { code: 'REFUSED', detail: 'nothing was routed or run' });
  return deepFreeze({
    contract: ORCHESTRATION_CONTRACT, planId, environment, registryDigest: ctx.registry.digest(), outcome: 'REFUSED',
    refusal: { code, message: cap(message) }, plan: null, order: [], tasks: [], trace: trace.events, digest: trace.head,
    steps: 0, stop: null,
  });
}

/** A run's tasks as working copies a call may change; the run itself stays frozen. */
const workingTasks = (run: PlanRun): TaskOutcome[] =>
  run.tasks.map((t) => ({ ...t, approval: t.approval ? { ...t.approval } : null, inputs: t.inputs.map((i) => ({ ...i })) })) as TaskOutcome[];

/** Check a plan and run everything in it that may run now. */
export function startRun(request: unknown, ctx: RunContext): PlanRun {
  const environment = ctx.environment ?? currentEnvironment();
  const trace = new Trace();
  const claimedId = request && typeof request === 'object' && typeof (request as { id?: unknown }).id === 'string' ? cap(String((request as { id: string }).id), 41) : null;
  trace.append('PLAN_RECEIVED', { detail: `plan ${claimedId ?? '(no id)'} in ${environment}` });

  if (environment !== 'LAB') return refused(ctx, environment, trace, claimedId, 'ENVIRONMENT_NOT_LAB', `The orchestrator runs in the Lab only; this process is ${environment}`);
  const parsed = PlanRequestSchema.safeParse(request);
  if (!parsed.success) return refused(ctx, environment, trace, claimedId, 'CONTRACT_INVALID', firstIssue(parsed.error));
  const plan = frozenCopy(parsed.data);

  // structure
  const ids = plan.tasks.map((t) => t.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return refused(ctx, environment, trace, plan.id, 'TASK_DUPLICATE', `task "${dup}" appears twice`);
  for (const t of plan.tasks) {
    if (t.dependsOn.includes(t.id)) return refused(ctx, environment, trace, plan.id, 'DEPENDENCY_SELF', `task "${t.id}" depends on itself`);
    const unknown = t.dependsOn.find((d) => !ids.includes(d));
    if (unknown) return refused(ctx, environment, trace, plan.id, 'DEPENDENCY_UNKNOWN', `task "${t.id}" depends on "${unknown}", which is not in the plan`);
  }
  const { order, stuck } = topological(plan.tasks);
  if (stuck.length) return refused(ctx, environment, trace, plan.id, 'CYCLE', `tasks ${stuck.join(', ')} depend on each other in a cycle`);
  for (const t of plan.tasks) {
    const op = ctx.operations.get(t.operation);
    if (!op) return refused(ctx, environment, trace, plan.id, 'OPERATION_UNKNOWN', `task "${t.id}": no LAB operation is registered as "${t.operation}"`);
    for (const d of t.dependsOn) {
      const from = plan.tasks.find((x) => x.id === d) as TaskSpec;
      if (!op.consumes.includes(from.operation)) {
        return refused(ctx, environment, trace, plan.id, 'HANDOFF_UNDECLARED', `"${t.operation}" does not consume "${from.operation}" (task "${t.id}" ← "${d}")`);
      }
    }
  }

  // who is asking
  const by = plan.requestedBy;
  if (plan.scope.kind === 'CLUB' && by.clubId !== plan.scope.clubId) {
    return refused(ctx, environment, trace, plan.id, 'REQUESTER_SCOPE', `the requester belongs to ${by.clubId ?? 'no club'}, not ${plan.scope.clubId}`);
  }
  if (plan.scope.kind === 'PLATFORM' && (by.role !== 'SUPER_ADMIN' || by.clubId !== null)) {
    return refused(ctx, environment, trace, plan.id, 'REQUESTER_SCOPE', 'a platform plan is the Platform Owner\'s');
  }

  // routing, then whether the requester may read what the routed agents write
  const tasks: TaskOutcome[] = [];
  for (const id of order) {
    const spec = plan.tasks.find((t) => t.id === id) as TaskSpec;
    const op = ctx.operations.get(spec.operation) as NonNullable<ReturnType<OperationCatalog['get']>>;
    const r = route(ctx.registry, op, plan.scope);
    if (!r.agent) {
      const near = r.candidates.filter((c) => !c.eligible).slice(0, 3).map((c) => `${c.agentId}: ${c.reason}`).join('; ');
      return refused(ctx, environment, trace, plan.id, 'NO_ELIGIBLE_AGENT', `task "${id}" (${op.key}): no registry agent may perform it${near ? ` (${near})` : ''}`);
    }
    const recordClass = recordClassOf(r.agent);
    if (tierFor(by.role, recordClass) !== 'FULL') {
      return refused(ctx, environment, trace, plan.id, 'REQUESTER_CANNOT_READ', `${by.role} may not read ${recordClass} records, which task "${id}" (${r.agent.id}) writes`);
    }
    tasks.push({
      id, operation: op.key, tool: op.tool, state: 'PENDING',
      agent: { id: r.agent.id, version: r.agent.version, digest: r.agent.digest }, eligibleAgents: r.ranked,
      dataClass: op.output, recordClass, output: null, outputDigest: null, approval: null, reason: null, inputs: [],
    });
  }

  trace.append('PLAN_ACCEPTED', { detail: `${plan.tasks.length} tasks for ${plan.scope.kind === 'CLUB' ? plan.scope.clubId : 'the platform'}, requested by ${by.role}` });
  for (const t of tasks) trace.append('TASK_ROUTED', { taskId: t.id, agentId: t.agent?.id ?? null, detail: `${t.operation} via "${t.tool}"; ranked ${t.eligibleAgents.join(', ')}` });

  const w = new Working(ctx, environment, trace, plan, order, tasks);
  w.advance();
  return w.settle();
}

/** A person's decision on a task that waits for one; refused decisions are recorded and change nothing. */
export function decideApproval(run: PlanRun, decision: unknown, ctx: RunContext): PlanRun {
  const environment = ctx.environment ?? currentEnvironment();
  const trace = new Trace(run.trace);
  const tasks = workingTasks(run);
  const w = run.plan ? new Working(ctx, environment, trace, run.plan, run.order, tasks, run.steps, run.stop) : null;
  const refuse = (code: ApprovalRefusalCode | 'ENVIRONMENT_NOT_LAB', detail: string, taskId: string | null = null): PlanRun => {
    trace.append('APPROVAL_DECISION_REFUSED', { taskId, code, detail: cap(detail) });
    return deepFreeze({ ...run, tasks, trace: trace.events, digest: trace.head });
  };

  if (environment !== 'LAB') return refuse('ENVIRONMENT_NOT_LAB', `decisions are taken in the Lab only; this process is ${environment}`);
  const parsed = ApprovalDecisionSchema.safeParse(decision);
  if (!parsed.success || !w || !run.plan) return refuse('DECISION_INVALID', parsed.success ? 'the run has no plan' : firstIssue(parsed.error));
  const d = parsed.data;
  const t = w.byId.get(d.taskId);
  if (!t || t.state !== 'AWAITING_APPROVAL') return refuse('APPROVAL_NOT_PENDING', `task "${d.taskId}" is not waiting for a decision`, d.taskId);
  if (!APPROVER_ROLES.includes(d.by.role)) return refuse('APPROVER_ROLE', `${d.by.role} may not decide approvals`, t.id);
  const scope = run.plan.scope;
  if (scope.kind === 'CLUB' && d.by.clubId !== scope.clubId && d.by.role !== 'SUPER_ADMIN') return refuse('APPROVER_CLUB', `the approver belongs to ${d.by.clubId ?? 'no club'}, not ${scope.clubId}`, t.id);
  if (d.by.userId === run.plan.requestedBy.userId) return refuse('SEGREGATION_OF_DUTIES', 'the requester may not decide their own plan\'s action', t.id);
  if (tierFor(d.by.role, t.recordClass as AIRecordClass) !== 'FULL') return refuse('APPROVER_CANNOT_READ', `${d.by.role} may not read the ${t.recordClass} record this task writes`, t.id);

  // An approval starts the task, so the guard is asked first; a stop refuses the decision and ends the run.
  const stop = d.decision === 'APPROVED' ? w.admit(t.id) : null;
  if (stop) {
    trace.append('APPROVAL_DECISION_REFUSED', { taskId: t.id, code: stop.code, detail: cap(`not applied: ${stop.message}`) });
    w.halt('HALTED', stop.code, stop.message);
    return w.settle();
  }

  t.approval = { eligibleRoles: t.approval?.eligibleRoles ?? [], decision: d.decision, decidedBy: { userId: d.by.userId, role: d.by.role } };
  trace.append('APPROVAL_DECIDED', { taskId: t.id, agentId: t.agent?.id ?? null, code: d.decision, detail: `${d.decision.toLowerCase()} by ${d.by.role} ${d.by.userId}` });
  if (d.decision === 'REJECTED') {
    t.state = 'REJECTED';
    t.reason = { code: 'REJECTED_BY_APPROVER', message: `rejected by ${d.by.role}` };
    trace.append('TASK_REFUSED', { taskId: t.id, agentId: t.agent?.id ?? null, code: 'REJECTED_BY_APPROVER', detail: t.reason.message });
  } else {
    t.state = 'PENDING';
    w.execute(t, true);
  }
  w.advance();
  return w.settle();
}

/**
 * AI-0.4: end a run that has not settled on its own. Every task still PENDING
 * or AWAITING_APPROVAL is CANCELLED; a run already settled, refused or stopped
 * is returned as it is. Stopping is always allowed: it can only take work away.
 */
export function stopRun(run: PlanRun, outcome: RunStop['outcome'], reason: Reason<StopCode>, ctx: RunContext): PlanRun {
  const open = run.tasks.some((t) => t.state === 'PENDING' || t.state === 'AWAITING_APPROVAL');
  if (!run.plan || run.stop || !open) return run;
  const w = new Working(ctx, run.environment, new Trace(run.trace), run.plan, run.order, workingTasks(run), run.steps, null);
  w.halt(outcome, reason.code, reason.message);
  return w.settle();
}
