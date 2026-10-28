// Controlled execution — a LAB operator runs a synthetic plan, on request, under governance
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.4 (LAB). The orchestrator (engine.ts)
// decides what a plan's agents may do; this file is how a plan comes to be run
// at all, and what is kept of it. An execution request (familista.lab-execution/v1)
// names an operator, an idempotency key, a plan and its limits, and is refused
// before anything runs unless:
//
//   1. this process is the Lab, and the global kill switch is not engaged
//   2. the request and its plan are valid and bounded (strict zod 4)
//   3. the operator is on the LAB roster (operators.ts) with SUBMIT for the
//      plan's scope, and may read every record class the plan's agents write
//   4. the plan passes the orchestrator's own checks: synthetic `lab-…` refs,
//      a bounded DAG of known operations, declared handoffs, a requester of the
//      plan's scope who may read what it produces, an agent for every task
//
// The same operator and key always name the same execution: the same plan
// again returns what was recorded and runs nothing; a different plan is
// refused. Then the plan runs under a guard asked before every task starts —
// the kill switch halts it there, and so does a task past its step limit.
//
// A person's decision (decideExecution) and an operator's cancellation
// (cancelExecution) continue or end it. An operator never decides an approval
// for an execution they submitted. A decision while the kill switch is
// engaged halts the workflow instead of continuing it, and so does one made
// after the security context it was submitted under changed (the registry,
// the operations, the approver roles, the read matrix, the tool registry or
// the roster): what was asked of the approvers no longer holds.
//
// Everything is recorded: the routing, every task transition and handoff (the
// run's chained trace), and every execution event in a second chain that
// commits to the trace's head at each step, sealed by a digest. A record stays
// in the Lab. It is a publication candidate only if production's own evidence
// verifier accepts it (publicationCandidate), and nothing here publishes it.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { killSwitchEngaged, killSwitchReason, TOOLS } from '../../src/platform/intelligence/agents';
import { currentEnvironment, type FamilistaEnvironment } from '../../src/platform/environment';
import { deepFreeze, type AgentRegistry } from '../../src/platform/agents/registry';
import { chainHash, digestOf, type ChainedEvent } from '../../src/platform/agents/trace-chain';
import { EXECUTION_GENESIS, executionIdFor, LAB_EXECUTION_CONTRACT } from '../../src/platform/agents/execution-evidence';
import {
  evidenceDigest, verifyOrchestrationEvidence, ORCHESTRATION_EVIDENCE_CONTRACT, ORCHESTRATION_EVIDENCE_NOTICE,
  type EvidenceRun, type OrchestrationEvidence,
} from '../../src/platform/agents/orchestration-evidence';
import { AI_READ_MATRIX, tierFor } from '../../src/security/ai-read-policy';
import { APPROVER_ROLES } from '../../src/security/approver-roles';
import {
  ApprovalDecisionSchema, LAB_REF, LIMITS, ORCHESTRATION_CONTRACT, PlanRequestSchema,
  type PlanRequest, type PlanScope, type Reason, type StopCode, type TaskState,
} from './contracts';
import { decideApproval, startRun, stopRun, type PlanRun, type RunContext } from './engine';
import { toEvidence } from './evidence';
import type { OperationCatalog } from './operations';
import { authorizeOperator, LAB_OPERATORS, type LabOperator, type OperatorRefusalCode } from './operators';
import { recordClassOf, route } from './routing';
import { verifyTrace } from './trace';

/** The record's contract, its log's genesis and its id rule are production's (execution-evidence.ts), which re-checks them on publication. */
export const EXECUTION_CONTRACT = LAB_EXECUTION_CONTRACT;
export { EXECUTION_GENESIS, executionIdFor };

export const EXECUTION_LIMITS = Object.freeze({
  maxRequestBytes: 65_536,
  maxRecordBytes: 1_048_576,
  maxLogEvents: 200,
  /** A step is a task starting; by default a plan may start each of its tasks once. */
  defaultMaxSteps: LIMITS.maxTasks,
});

const REQUEST_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
export const EXECUTION_ID = /^exec-[0-9a-f]{24}$/;

const Person = z.object({ userId: z.string().regex(LAB_REF), role: z.string().min(1).max(40) }).strict();
/** A LAB operator as a request, a cancellation or a kill-switch command names them. */
export const ExecutionOperatorSchema = Person;

export const ExecutionRequestSchema = z.object({
  contract: z.literal(EXECUTION_CONTRACT),
  /** The idempotency key: the same operator and key are always the same execution. */
  requestId: z.string().regex(REQUEST_ID),
  operator: Person,
  /** A familista.orchestration/v1 plan, validated strictly below. */
  plan: z.unknown(),
  limits: z.object({ maxSteps: z.number().int().min(1).max(LIMITS.maxTasks) }).strict().optional(),
}).strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export type ExecutionOperator = z.infer<typeof Person>;

// ── the execution log: a second chain, committing to the run's at every step ─

export type ExecutionEventType =
  | 'EXECUTION_SUBMITTED' | 'OPERATOR_AUTHORIZED' | 'PLAN_VALIDATED' | 'AGENTS_ASSIGNED' | 'RUN_ADVANCED'
  | 'DECISION_SUBMITTED' | 'DECISION_REFUSED' | 'APPROVAL_INVALIDATED'
  | 'EXECUTION_CANCELLED' | 'CANCEL_REFUSED' | 'EXECUTION_HALTED';

export interface ExecutionEvent extends ChainedEvent { type: ExecutionEventType }

class Log {
  private readonly list: ExecutionEvent[];
  constructor(events: readonly ExecutionEvent[] = []) { this.list = [...events]; }

  append(type: ExecutionEventType, at: { taskId?: string | null; code?: string | null; detail: string }): void {
    if (this.list.length >= EXECUTION_LIMITS.maxLogEvents) throw new Error('The execution log is full: the execution exceeded its bound');
    const prev = this.list.length ? this.list[this.list.length - 1].hash : EXECUTION_GENESIS;
    const base = { seq: this.list.length + 1, type, taskId: at.taskId ?? null, agentId: null, code: at.code ?? null, detail: cap(at.detail), prev };
    this.list.push(Object.freeze({ ...base, hash: chainHash(base) }));
  }

  /** Commit the log to the run as it now stands: its trace head and outcome. */
  advanced(run: PlanRun, what: string): void {
    this.append('RUN_ADVANCED', { code: run.outcome, detail: `run ${run.digest}: ${what}` });
  }

  get events(): ExecutionEvent[] { return [...this.list]; }
}

/** Whether an execution log is the chain it claims to be; the first event that is not, if any. */
export function verifyLog(events: readonly ExecutionEvent[]): { ok: boolean; brokenAt: number | null } {
  let prev = EXECUTION_GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1 || e.prev !== prev || e.hash !== chainHash(e)) return { ok: false, brokenAt: i + 1 };
    prev = e.hash;
  }
  return { ok: true, brokenAt: null };
}

// ── what is recorded ─────────────────────────────────────────────────────────

/** Why each task went to the agent it did, and why every other registry agent did not get it. */
export interface RoutingDecision {
  taskId: string;
  operation: string;
  tool: string;
  domain: string | null;
  selected: string | null;
  ranked: string[];
  passedOver: Array<{ agentId: string; reason: string }>;
}

/**
 * Everything an approval and a routing decision depend on, as digests. If any
 * part changes while an execution waits, what was asked of its approvers no
 * longer holds.
 */
export interface SecurityContext { digest: string; registryDigest: string; operationsDigest: string; policyDigest: string }

/** A decision that reached the orchestrator, accepted or refused there. */
export interface RecordedDecision { taskId: string; decision: 'APPROVED' | 'REJECTED'; byRole: string; accepted: boolean }

export interface ExecutionRecord {
  contract: typeof EXECUTION_CONTRACT;
  executionId: string;
  requestId: string;
  operator: ExecutionOperator;
  planId: string;
  planDigest: string;
  scope: PlanScope;
  limits: { maxSteps: number };
  context: SecurityContext;
  validation: { ok: true; tasks: number; order: string[] };
  routing: RoutingDecision[];
  decisions: RecordedDecision[];
  run: PlanRun;
  log: ExecutionEvent[];
  digest: string;
}

export type ExecutionRefusalCode =
  | 'ENVIRONMENT_NOT_LAB' | 'KILL_SWITCH' | 'REQUEST_TOO_LARGE' | 'REQUEST_INVALID' | 'PLAN_INVALID'
  | OperatorRefusalCode | 'OPERATOR_CANNOT_READ' | 'IDEMPOTENCY_CONFLICT'
  | 'EXECUTION_UNKNOWN' | 'EXECUTION_TAMPERED' | 'EXECUTION_SETTLED'
  | 'DECISION_INVALID' | 'SELF_APPROVAL' | 'APPROVAL_CONTEXT_CHANGED' | 'DECISION_REFUSED';

export interface ExecutionRefusal { code: ExecutionRefusalCode; message: string; cause: string | null }

export type ExecutionResult =
  | { status: 'ACCEPTED' | 'REPLAYED' | 'UPDATED'; record: ExecutionRecord; refusal: null }
  | { status: 'REFUSED'; record: ExecutionRecord | null; refusal: ExecutionRefusal };

// ── where records are kept: in the Lab, and nowhere else ─────────────────────

export interface ExecutionStore {
  get(executionId: string): ExecutionRecord | null;
  put(record: ExecutionRecord): void;
  list(): string[];
}

/** For tests and demonstrations: records as JSON, so what is read back is what a file would hold. */
export class MemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, string>();
  get(id: string): ExecutionRecord | null { const s = this.records.get(id); return s ? JSON.parse(s) as ExecutionRecord : null; }
  put(r: ExecutionRecord): void { this.records.set(r.executionId, JSON.stringify(r)); }
  list(): string[] { return [...this.records.keys()].sort(); }
}

/** Where the LAB CLI keeps records: a git-ignored directory beside this file. */
export const DEFAULT_EXECUTIONS_DIR = path.join(__dirname, '.executions');

/** One JSON file per execution, written whole or not at all. It refuses to exist outside the Lab. */
export class FileExecutionStore implements ExecutionStore {
  constructor(readonly dir: string = DEFAULT_EXECUTIONS_DIR, environment: FamilistaEnvironment = currentEnvironment()) {
    if (environment !== 'LAB') throw new Error(`LAB executions are kept in the Lab only; this process is ${environment}`);
  }

  private file(id: string): string {
    if (!EXECUTION_ID.test(id)) throw new Error(`"${cap(id, 60)}" is not an execution id`);
    return path.join(this.dir, `${id}.json`);
  }

  get(id: string): ExecutionRecord | null {
    if (!EXECUTION_ID.test(id)) return null;
    let raw: string;
    try { raw = fs.readFileSync(this.file(id), 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (raw.length > EXECUTION_LIMITS.maxRecordBytes) throw new Error(`execution ${id} is larger than a record may be`);
    return JSON.parse(raw) as ExecutionRecord;
  }

  put(r: ExecutionRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(r.executionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  list(): string[] {
    try { return fs.readdirSync(this.dir).map((f) => f.replace(/\.json$/, '')).filter((id) => EXECUTION_ID.test(id)).sort(); } catch { return []; }
  }
}

// ── the parts ────────────────────────────────────────────────────────────────

export interface ExecutionDeps {
  registry: AgentRegistry;
  operations: OperationCatalog;
  store: ExecutionStore;
  /** Defaults to this process's own environment. */
  environment?: FamilistaEnvironment;
  /** Defaults to the LAB roster. */
  operators?: readonly LabOperator[];
  /** A test and demonstration seam: called before every task starts, before the kill switch is read. */
  beforeTransition?: (at: { taskId: string; step: number }) => void;
}

const cap = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstIssue = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'invalid';
};
const scopeText = (s: PlanScope) => (s.kind === 'CLUB' ? s.clubId : 'the platform');
const open = (run: PlanRun) => !run.stop && run.tasks.some((t) => t.state === 'PENDING' || t.state === 'AWAITING_APPROVAL');
const killSwitchMessage = () => `the global kill switch is engaged (${killSwitchReason() ?? 'no reason given'})`;

export function securityContext(registry: AgentRegistry, operations: OperationCatalog, operators: readonly LabOperator[]): SecurityContext {
  const registryDigest = registry.digest();
  const operationsDigest = digestOf(operations.list().map((o) => ({ key: o.key, tool: o.tool, domain: o.domain, output: o.output, consumes: [...o.consumes] })));
  const policyDigest = digestOf({
    approverRoles: [...APPROVER_ROLES], readMatrix: AI_READ_MATRIX,
    tools: TOOLS.map((t) => ({ key: t.key, effect: t.effect, minAutonomy: t.minAutonomy, classification: t.classification })),
    operators,
  });
  return { digest: digestOf({ registryDigest, operationsDigest, policyDigest }), registryDigest, operationsDigest, policyDigest };
}

/** Routing over the registry as it is now, for every task, with the reason for every agent passed over. */
export function explainRouting(plan: PlanRequest, registry: AgentRegistry, operations: OperationCatalog): RoutingDecision[] {
  return plan.tasks.map((t) => {
    const op = operations.get(t.operation);
    if (!op) return { taskId: t.id, operation: t.operation, tool: '', domain: null, selected: null, ranked: [], passedOver: [] };
    const r = route(registry, op, plan.scope);
    return {
      taskId: t.id, operation: op.key, tool: op.tool, domain: op.domain, selected: r.agent?.id ?? null, ranked: r.ranked,
      passedOver: r.candidates.filter((c) => !c.eligible).map((c) => ({ agentId: c.agentId, reason: c.reason })),
    };
  });
}

/** The guard a controlled execution runs under: the kill switch, then its step limit. */
function guardFor(deps: ExecutionDeps, limits: { maxSteps: number }): NonNullable<RunContext['guard']> {
  return (at) => {
    deps.beforeTransition?.(at);
    if (killSwitchEngaged()) return { code: 'KILL_SWITCH', message: killSwitchMessage() };
    if (at.step > limits.maxSteps) return { code: 'EXECUTION_LIMIT', message: `task "${at.taskId}" would be step ${at.step}, past this execution's limit of ${limits.maxSteps}` };
    return null;
  };
}

const contextOf = (deps: ExecutionDeps, environment: FamilistaEnvironment, limits: { maxSteps: number }): RunContext =>
  ({ registry: deps.registry, operations: deps.operations, environment, guard: guardFor(deps, limits) });

/** Seal a record: its digest is that of its JSON content, so a file read back verifies as it was written. */
function seal(body: Omit<ExecutionRecord, 'digest'>): ExecutionRecord {
  const plain = JSON.parse(JSON.stringify(body)) as Omit<ExecutionRecord, 'digest'>;
  return deepFreeze({ ...plain, digest: digestOf(plain) });
}

const body = (r: ExecutionRecord): Omit<ExecutionRecord, 'digest'> => {
  const { digest: _digest, ...rest } = r;
  return rest;
};

function refused(code: ExecutionRefusalCode, message: string, cause: string | null = null, record: ExecutionRecord | null = null): ExecutionResult {
  return { status: 'REFUSED', record, refusal: { code, message: cap(message, 240), cause } };
}

/** Write the next state of a record and return it. */
function persist(deps: ExecutionDeps, prior: ExecutionRecord, run: PlanRun, log: Log, decisions: RecordedDecision[] = prior.decisions): ExecutionRecord {
  const next = seal({ ...body(prior), run, decisions, log: log.events });
  deps.store.put(next);
  return next;
}

/** A record from the store, only if it is still the one that was written. */
function load(executionId: string, deps: ExecutionDeps): { record: ExecutionRecord } | { result: ExecutionResult } {
  let record: ExecutionRecord | null;
  try { record = EXECUTION_ID.test(executionId) ? deps.store.get(executionId) : null; } catch (e) {
    return { result: refused('EXECUTION_TAMPERED', `execution ${cap(executionId, 40)} cannot be read: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (!record) return { result: refused('EXECUTION_UNKNOWN', `no LAB execution is recorded as "${cap(executionId, 40)}"`) };
  const check = verifyExecution(record);
  if (!check.ok) return { result: refused('EXECUTION_TAMPERED', `execution ${executionId} is not the record that was written: ${check.reasons[0]}`) };
  return { record };
}

// ── submit, decide, cancel ───────────────────────────────────────────────────

/** Submit a synthetic plan for controlled execution. */
export function submitExecution(request: unknown, deps: ExecutionDeps): ExecutionResult {
  const environment = deps.environment ?? currentEnvironment();
  const operators = deps.operators ?? LAB_OPERATORS;
  if (environment !== 'LAB') return refused('ENVIRONMENT_NOT_LAB', `controlled execution runs in the Lab only; this process is ${environment}`);
  if (killSwitchEngaged()) return refused('KILL_SWITCH', `${killSwitchMessage()}: nothing starts`);

  let size: number;
  try { size = JSON.stringify(request ?? null).length; } catch { return refused('REQUEST_INVALID', 'the request is not JSON'); }
  if (size > EXECUTION_LIMITS.maxRequestBytes) return refused('REQUEST_TOO_LARGE', `the request is ${size} bytes; at most ${EXECUTION_LIMITS.maxRequestBytes}`);
  const parsed = ExecutionRequestSchema.safeParse(request);
  if (!parsed.success) return refused('REQUEST_INVALID', firstIssue(parsed.error));
  const req = parsed.data;
  const planParsed = PlanRequestSchema.safeParse(req.plan);
  if (!planParsed.success) return refused('PLAN_INVALID', `CONTRACT_INVALID: ${firstIssue(planParsed.error)}`, 'CONTRACT_INVALID');
  const plan = planParsed.data;

  // who is operating, and whether they may
  const denied = authorizeOperator(operators, req.operator, 'SUBMIT', plan.scope);
  if (denied) return refused(denied.code, denied.message);
  const routing = explainRouting(plan, deps.registry, deps.operations);
  for (const r of routing) {
    const agent = r.selected ? deps.registry.get(r.selected) : undefined;
    if (!agent) continue; // the orchestrator refuses an unroutable task itself, below
    const cls = recordClassOf(agent);
    if (tierFor(req.operator.role, cls) !== 'FULL') {
      return refused('OPERATOR_CANNOT_READ', `${req.operator.role} may not read the ${cls} records task "${r.taskId}" (${agent.id}) writes, so may not operate this execution`);
    }
  }

  // idempotency
  const executionId = executionIdFor(req.operator.userId, req.requestId);
  const planDigest = digestOf(plan);
  const limits = { maxSteps: req.limits?.maxSteps ?? EXECUTION_LIMITS.defaultMaxSteps };
  const existing = load(executionId, deps);
  if ('record' in existing) {
    const r = existing.record;
    if (r.planDigest === planDigest && r.limits.maxSteps === limits.maxSteps) return { status: 'REPLAYED', record: r, refusal: null };
    return refused('IDEMPOTENCY_CONFLICT', `request ${req.requestId} already started ${executionId}, for a different plan or limit; use a new request id`, null, r);
  }
  if (existing.result.refusal?.code === 'EXECUTION_TAMPERED') return existing.result;

  // run it
  const context = securityContext(deps.registry, deps.operations, operators);
  const run = startRun(plan, contextOf(deps, environment, limits));
  if (run.outcome === 'REFUSED') return refused('PLAN_INVALID', `${run.refusal?.code}: ${run.refusal?.message}`, run.refusal?.code ?? null);

  const log = new Log();
  log.append('EXECUTION_SUBMITTED', {
    code: 'SUBMIT',
    detail: `request ${req.requestId} by ${req.operator.role} ${req.operator.userId}: plan ${plan.id} ${planDigest.slice(0, 16)}, at most ${limits.maxSteps} steps, security context ${context.digest.slice(0, 16)}`,
  });
  log.append('OPERATOR_AUTHORIZED', { code: 'SUBMIT', detail: `${req.operator.userId} (${req.operator.role}) may submit for ${scopeText(plan.scope)}, and may read what its agents write` });
  log.append('PLAN_VALIDATED', { detail: `${plan.tasks.length} tasks: synthetic, bounded, acyclic, every handoff declared; order ${run.order.join(' → ')}` });
  log.append('AGENTS_ASSIGNED', { detail: routing.map((r) => `${r.taskId} → ${r.selected}`).join(', ') });
  log.advanced(run, `started, ${run.steps} of ${limits.maxSteps} steps`);

  const record = seal({
    contract: EXECUTION_CONTRACT, executionId, requestId: req.requestId, operator: { ...req.operator }, planId: plan.id, planDigest,
    scope: plan.scope, limits, context, validation: { ok: true, tasks: plan.tasks.length, order: [...run.order] },
    routing, decisions: [], run, log: log.events,
  });
  deps.store.put(record);
  return { status: 'ACCEPTED', record, refusal: null };
}

/** A person's decision on a task an execution waits on. */
export function decideExecution(executionId: string, decision: unknown, deps: ExecutionDeps): ExecutionResult {
  const environment = deps.environment ?? currentEnvironment();
  const operators = deps.operators ?? LAB_OPERATORS;
  if (environment !== 'LAB') return refused('ENVIRONMENT_NOT_LAB', `decisions are taken in the Lab only; this process is ${environment}`);
  const loaded = load(executionId, deps);
  if ('result' in loaded) return loaded.result;
  const record = loaded.record;
  const parsed = ApprovalDecisionSchema.safeParse(decision);
  if (!parsed.success) return refused('DECISION_INVALID', firstIssue(parsed.error), null, record);
  const d = parsed.data;
  if (!open(record.run)) return refused('EXECUTION_SETTLED', `execution ${executionId} has settled (${record.run.outcome}); nothing waits for a decision`, null, record);

  const ctx = contextOf(deps, environment, record.limits);
  const log = new Log(record.log);
  const who = `${d.decision.toLowerCase()} on "${d.taskId}" by ${d.by.role} ${d.by.userId}`;

  // The kill switch: a waiting workflow does not continue, and the decision is not applied.
  if (killSwitchEngaged()) {
    log.append('DECISION_REFUSED', { taskId: d.taskId, code: 'KILL_SWITCH', detail: `${who}, not applied: ${killSwitchMessage()}` });
    const run = stopRun(record.run, 'HALTED', { code: 'KILL_SWITCH', message: killSwitchMessage() }, ctx);
    log.append('EXECUTION_HALTED', { code: 'KILL_SWITCH', detail: killSwitchMessage() });
    log.advanced(run, 'halted by the kill switch while it waited for a decision');
    return refused('KILL_SWITCH', `${killSwitchMessage()}: the decision was not applied, and the execution is halted`, null, persist(deps, record, run, log));
  }

  // A changed security context: what was asked of the approvers no longer holds.
  const now = securityContext(deps.registry, deps.operations, operators);
  if (now.digest !== record.context.digest) {
    const changed = (['registryDigest', 'operationsDigest', 'policyDigest'] as const).filter((k) => now[k] !== record.context[k]).map((k) => k.replace('Digest', ''));
    const message = `the security context changed since submission (${changed.join(', ')}): its pending approvals no longer hold; submit it again`;
    log.append('APPROVAL_INVALIDATED', { taskId: d.taskId, code: 'APPROVAL_CONTEXT_CHANGED', detail: `${who}, not applied: ${message}` });
    const run = stopRun(record.run, 'HALTED', { code: 'APPROVAL_CONTEXT_CHANGED', message }, ctx);
    log.append('EXECUTION_HALTED', { code: 'APPROVAL_CONTEXT_CHANGED', detail: message });
    log.advanced(run, 'halted: its approvals were invalidated');
    return refused('APPROVAL_CONTEXT_CHANGED', message, null, persist(deps, record, run, log));
  }

  // No self-approval: the operator who submitted it does not decide it.
  if (d.by.userId === record.operator.userId) {
    log.append('DECISION_REFUSED', { taskId: d.taskId, code: 'SELF_APPROVAL', detail: `${who}, refused: ${d.by.userId} submitted this execution` });
    return refused('SELF_APPROVAL', `${d.by.userId} submitted this execution and may not decide its approvals`, null, persist(deps, record, record.run, log));
  }

  // The orchestrator's own rules: an approver role, of the plan's club, not the requester, who may read what it writes.
  const before = record.run.trace.length;
  const run = decideApproval(record.run, d, ctx);
  const refusedEvent = run.trace.slice(before).find((e) => e.type === 'APPROVAL_DECISION_REFUSED');
  const decisions = [...record.decisions, { taskId: d.taskId, decision: d.decision, byRole: d.by.role, accepted: !refusedEvent }];
  log.append('DECISION_SUBMITTED', { taskId: d.taskId, code: refusedEvent ? 'REFUSED' : d.decision, detail: refusedEvent ? `${who}, refused: ${refusedEvent.code} ${refusedEvent.detail}` : who });
  if (run.stop) log.append('EXECUTION_HALTED', { code: run.stop.code, detail: run.stop.message });
  log.advanced(run, refusedEvent ? 'decision refused; nothing changed' : `decision applied, ${run.steps} of ${record.limits.maxSteps} steps`);
  const next = persist(deps, record, run, log, decisions);
  if (refusedEvent) return refused('DECISION_REFUSED', refusedEvent.detail, refusedEvent.code, next);
  return { status: 'UPDATED', record: next, refusal: null };
}

/** An operator stops an execution that has not settled: everything not yet finished is CANCELLED. */
export function cancelExecution(executionId: string, operator: unknown, deps: ExecutionDeps): ExecutionResult {
  const environment = deps.environment ?? currentEnvironment();
  const operators = deps.operators ?? LAB_OPERATORS;
  if (environment !== 'LAB') return refused('ENVIRONMENT_NOT_LAB', `executions are cancelled in the Lab only; this process is ${environment}`);
  const loaded = load(executionId, deps);
  if ('result' in loaded) return loaded.result;
  const record = loaded.record;
  const parsed = Person.safeParse(operator);
  if (!parsed.success) return refused('REQUEST_INVALID', firstIssue(parsed.error), null, record);
  const who = parsed.data;
  const log = new Log(record.log);
  const denied = authorizeOperator(operators, who, 'CANCEL', record.scope);
  if (denied) {
    log.append('CANCEL_REFUSED', { code: denied.code, detail: `cancellation by ${who.role} ${who.userId} refused: ${denied.message}` });
    return refused(denied.code, denied.message, null, persist(deps, record, record.run, log));
  }
  if (!open(record.run)) return refused('EXECUTION_SETTLED', `execution ${executionId} has settled (${record.run.outcome}); there is nothing to cancel`, null, record);
  const message = `cancelled by ${who.role} ${who.userId}`;
  const run = stopRun(record.run, 'CANCELLED', { code: 'CANCELLED_BY_OPERATOR', message }, contextOf(deps, environment, record.limits));
  log.append('EXECUTION_CANCELLED', { code: 'CANCELLED_BY_OPERATOR', detail: message });
  log.advanced(run, 'cancelled');
  return { status: 'UPDATED', record: persist(deps, record, run, log), refusal: null };
}

/**
 * With the kill switch engaged, halt every execution that has not settled,
 * waiting for a decision or not. Nothing resumes when the switch is released:
 * a halted execution is settled, and continuing means submitting it again.
 */
export function haltOpenExecutions(deps: ExecutionDeps): { halted: string[]; unreadable: string[] } {
  const environment = deps.environment ?? currentEnvironment();
  if (environment !== 'LAB') throw new Error(`executions are halted in the Lab only; this process is ${environment}`);
  if (!killSwitchEngaged()) throw new Error('The kill switch is not engaged: nothing is halted');
  const halted: string[] = [];
  const unreadable: string[] = [];
  for (const id of deps.store.list()) {
    const loaded = load(id, deps);
    if ('result' in loaded) { unreadable.push(id); continue; }
    const record = loaded.record;
    if (!open(record.run)) continue;
    const reason: Reason<StopCode> = { code: 'KILL_SWITCH', message: killSwitchMessage() };
    const run = stopRun(record.run, 'HALTED', reason, contextOf(deps, environment, record.limits));
    const log = new Log(record.log);
    log.append('EXECUTION_HALTED', { code: 'KILL_SWITCH', detail: reason.message });
    log.advanced(run, 'halted by the kill switch');
    persist(deps, record, run, log);
    halted.push(id);
  }
  return { halted, unreadable };
}

// ── verification ─────────────────────────────────────────────────────────────

const EVENT_STATE: Partial<Record<string, TaskState>> = {
  TASK_ROUTED: 'PENDING', APPROVAL_REQUIRED: 'AWAITING_APPROVAL', TASK_SUCCEEDED: 'SUCCEEDED', TASK_FAILED: 'FAILED',
  TASK_SKIPPED: 'SKIPPED', TASK_CANCELLED: 'CANCELLED',
};

/** Each task's state as its run's trace records it. */
function tracedStates(run: PlanRun): Map<string, TaskState> {
  const states = new Map<string, TaskState>();
  for (const e of run.trace) {
    if (!e.taskId) continue;
    const s = e.type === 'TASK_REFUSED' ? (e.code === 'REJECTED_BY_APPROVER' ? 'REJECTED' : 'REFUSED')
      : e.type === 'APPROVAL_DECIDED' && e.code === 'APPROVED' ? 'PENDING' : EVENT_STATE[e.type];
    if (s) states.set(e.taskId, s);
  }
  return states;
}

const RecordShape = z.object({
  contract: z.literal(EXECUTION_CONTRACT),
  executionId: z.string().regex(EXECUTION_ID),
  requestId: z.string().regex(REQUEST_ID),
  operator: Person,
  planDigest: z.string().regex(/^[0-9a-f]{64}$/),
  limits: z.object({ maxSteps: z.number().int().min(1).max(LIMITS.maxTasks) }).strict(),
  log: z.array(z.object({ type: z.string() }).passthrough()).min(1).max(EXECUTION_LIMITS.maxLogEvents),
  run: z.object({ trace: z.array(z.object({ hash: z.string() }).passthrough()).min(1), tasks: z.array(z.unknown()) }).passthrough(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).passthrough();

/** Every reason this is not an execution record as it was written. Empty means it is. */
export function verifyExecution(input: unknown): { ok: boolean; reasons: string[] } {
  const shape = RecordShape.safeParse(input);
  if (!shape.success) return { ok: false, reasons: [`shape: ${firstIssue(shape.error)}`] };
  const r = input as ExecutionRecord;
  const reasons: string[] = [];
  if (digestOf(JSON.parse(JSON.stringify(body(r)))) !== r.digest) reasons.push('integrity: the record\'s digest is not the digest of its content');
  if (executionIdFor(r.operator.userId, r.requestId) !== r.executionId) reasons.push('integrity: the execution id is not its operator\'s and request\'s');
  const log = verifyLog(r.log);
  if (!log.ok) reasons.push(`integrity: the execution log breaks at event ${log.brokenAt}`);
  const trace = verifyTrace(r.run.trace);
  if (!trace.ok) reasons.push(`integrity: the run trace breaks at event ${trace.brokenAt}`);
  const head = r.run.trace[r.run.trace.length - 1].hash;
  if (r.run.digest !== head) reasons.push('integrity: the run\'s digest is not its trace\'s head');
  const committed = [...r.log].reverse().find((e) => e.type === 'RUN_ADVANCED');
  if (!committed || !committed.detail.startsWith(`run ${head}:`)) reasons.push('integrity: the execution log does not commit to this run');
  if (!r.run.plan || digestOf(r.run.plan) !== r.planDigest) reasons.push('integrity: the run is not of the plan that was submitted');

  const traced = tracedStates(r.run);
  for (const t of r.run.tasks) {
    const s = traced.get(t.id) ?? 'PENDING';
    if (s !== t.state) reasons.push(`coherence: task ${t.id} is ${t.state}; its trace records ${s}`);
    const routed = r.routing.find((x) => x.taskId === t.id);
    if (!routed || routed.selected !== (t.agent?.id ?? null)) reasons.push(`coherence: task ${t.id} ran on an agent its routing record did not select`);
  }
  const settled = r.run.trace.filter((e) => e.type === 'RUN_SETTLED').pop();
  if (!settled || settled.code !== r.run.outcome) reasons.push('coherence: the run\'s outcome is not the one its trace settled on');
  return { ok: reasons.length === 0, reasons };
}

/**
 * The record as AI-0.3 evidence, and whether production's own verifier would
 * accept it. Nothing here writes or publishes it: publication is a separate,
 * approved step. A stopped run is never a candidate (the v1 evidence contract
 * has no word for it).
 */
export function publicationCandidate(record: ExecutionRecord, operations: OperationCatalog): { evidence: OrchestrationEvidence | null; reasons: string[] } {
  const check = verifyExecution(record);
  if (!check.ok) return { evidence: null, reasons: check.reasons };
  if (!record.run.plan) return { evidence: null, reasons: ['the run has no plan'] };
  let run: EvidenceRun;
  try {
    const steps: EvidenceRun['steps'] = [{ kind: 'START' }, ...record.decisions.map((d) => ({ kind: 'DECISION' as const, ...d }))];
    run = toEvidence(record.executionId, record.run.plan, record.run, steps);
  } catch (e) {
    return { evidence: null, reasons: [e instanceof Error ? e.message : String(e)] };
  }
  const used = new Set(record.run.tasks.map((t) => t.operation));
  const evidenceBody: Omit<OrchestrationEvidence, 'digest'> = {
    contract: ORCHESTRATION_EVIDENCE_CONTRACT, orchestration: ORCHESTRATION_CONTRACT, notice: ORCHESTRATION_EVIDENCE_NOTICE,
    environment: 'LAB', registryDigest: record.run.registryDigest,
    operations: operations.list().filter((o) => used.has(o.key)).map((o) => ({ key: o.key, title: o.title, tool: o.tool, domain: o.domain, output: o.output })),
    runs: [run],
  };
  const evidence = { ...evidenceBody, digest: evidenceDigest(evidenceBody) };
  return verifyOrchestrationEvidence(evidence);
}
