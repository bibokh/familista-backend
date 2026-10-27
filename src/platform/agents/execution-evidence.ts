// Approved LAB execution evidence — the orchestration evidence contract, version 2
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.5. AI-0.4 lets a LAB operator run a
// synthetic plan under governance and keeps an integrity-checked record of it,
// in the Lab and nowhere else (lab/orchestrator/execution.ts,
// familista.lab-execution/v1). This file is how one such record may become
// something production shows: one dossier per execution in the v2 evidence
// contract, verified here, and served to the AI Agents Operations Room only
// when the Platform Owner has approved it.
//
//   1. the Lab verifies its record and projects it into a v2 dossier, which
//      THIS verifier must accept         npm run lab:publish -- candidate <id>
//   2. the Lab writes the dossier and an entry in the approval record into a
//      working tree, for a named pull request; it commits nothing
//                                        npm run lab:publish -- prepare <id> --reference …
//   3. the Platform Owner reviews that pull request, and approves by merging it
//   4. the build that contains the merge carries both files; this server reads
//      them, verifies them again and shows them. It runs nothing, writes nothing
//      and imports nothing from the Lab.
//
// THE APPROVAL IS THE MERGE. published/approvals.json lists, for each
// publication, its id, its execution, its dossier's file and digest and the pull
// request that carries it — never who approved it. A name typed into a file
// proves nothing (the AI-0.4 operator name is not authenticated either), so an
// entry that names an approver is refused rather than believed. Nothing here is
// cryptographic owner authentication: the boundary is the reviewed pull request,
// its CODEOWNERS review and the Platform Owner's merge.
//
// A dossier is verified as a whole, and the record with it; anything that fails
// makes the whole read INVALID, says why, and shows nothing:
//
//   version     the v2 contract; any other version is refused by name
//   shape       strict: no field the contract does not name, so no operation
//               input or output, no payload, no timestamp it never recorded
//   integrity   the dossier's digest is its content's; its execution id and
//               publication id derive from what it records; its context digest
//               is its parts'
//   trace       the run's trace is an unbroken hash chain and its id is the head
//   log         the execution log is an unbroken chain of its own, it opens with
//               the submission, authorization, validation and assignment it must
//               record, and every step of it commits to a point of the trace
//   coherence   every state, agent, routing, handoff, decision, stop and outcome
//               shown is the one the chains record; a self-reported outcome is
//               never taken on its own word
//   governance  every decision was an eligible role's, none the submitter's, no
//               medical action was approved, every kill-switch refusal halted it
//   synthetic   LAB references only, no address or real id, no health field
//   identity    every agent and tool it names is one this server registers
//   approval    the record lists it once, with this digest, for a pull request

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { holdsHealthData } from '../../security/ai-read-policy';
import { TOOLS } from '../intelligence/agents';
import {
  EvidenceFields, holdsRealLookingIds, OperationSchema, ORCHESTRATION_EVIDENCE_CONTRACT, RUN_OUTCOMES, TaskSchema,
  TASK_STATES, TRACE_TYPES, TraceEventSchema,
} from './orchestration-evidence';
import type { AgentRegistry } from './registry';
import { digestOf, ORCHESTRATION_CONTRACT, sha256, verifyChain, verifyChainFrom } from './trace-chain';

export const EXECUTION_EVIDENCE_CONTRACT = 'familista.orchestration-evidence/v2' as const;
/** Every version of the evidence contract this server reads, each where it belongs: v1 the workflow evidence, v2 a publication. */
export const SUPPORTED_EVIDENCE_CONTRACTS = [ORCHESTRATION_EVIDENCE_CONTRACT, EXECUTION_EVIDENCE_CONTRACT] as const;
/** The AI-0.4 record a dossier is projected from. The Lab's writer imports these three, so the rule is one rule. */
export const LAB_EXECUTION_CONTRACT = 'familista.lab-execution/v1' as const;
/** The execution log's first `prev`: its own contract, so it can never be mistaken for a run trace. */
export const EXECUTION_GENESIS = sha256(LAB_EXECUTION_CONTRACT);
/** The same operator and key: the same execution, always. */
export const executionIdFor = (operatorId: string, requestId: string): string =>
  `exec-${digestOf({ contract: LAB_EXECUTION_CONTRACT, operator: operatorId, requestId }).slice(0, 24)}`;
/** One execution, as it stood when its record was sealed: one publication id. */
export const publicationIdFor = (executionId: string, recordDigest: string): string =>
  `pub-${digestOf({ contract: EXECUTION_EVIDENCE_CONTRACT, executionId, recordDigest }).slice(0, 24)}`;

export const EXECUTION_EVIDENCE_NOTICE = 'Synthetic LAB evidence of a controlled execution, approved for publication when the Platform Owner merged the reviewed pull request that carries it. It ran in the Lab over invented clubs and people; nothing here ran in production, and no agent acted.';
export const EXECUTION_EVIDENCE_MAX_BYTES = 1024 * 1024;

const { Hex64, LabRef, Slug, OpKey, AgentId, Token, ToolKey, Text } = EvidenceFields;
const ExecutionId = z.string().regex(/^exec-[0-9a-f]{24}$/);
const PublicationId = z.string().regex(/^pub-[0-9a-f]{24}$/);
const RequestId = z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/);
const MAX_TASKS = 24;

// The vocabulary is v1's, extended by exactly what AI-0.4 added: a run an operator
// cancelled or governance halted, and the tasks that stop left unfinished.
export const EXECUTION_TASK_STATES = [...TASK_STATES, 'CANCELLED'] as const;
export const EXECUTION_OUTCOMES = [...RUN_OUTCOMES, 'CANCELLED', 'HALTED'] as const;
export const EXECUTION_TRACE_TYPES = [...TRACE_TYPES, 'RUN_HALTED', 'RUN_CANCELLED', 'TASK_CANCELLED'] as const;
export const STOP_CODES = ['KILL_SWITCH', 'EXECUTION_LIMIT', 'APPROVAL_CONTEXT_CHANGED', 'CANCELLED_BY_OPERATOR'] as const;
export const EXECUTION_EVENT_TYPES = [
  'EXECUTION_SUBMITTED', 'OPERATOR_AUTHORIZED', 'PLAN_VALIDATED', 'AGENTS_ASSIGNED', 'RUN_ADVANCED',
  'DECISION_SUBMITTED', 'DECISION_REFUSED', 'APPROVAL_INVALIDATED', 'EXECUTION_CANCELLED', 'CANCEL_REFUSED', 'EXECUTION_HALTED',
] as const;
/** What every execution log opens with, in this order: the submission, as AI-0.4 records it. */
const OPENING = ['EXECUTION_SUBMITTED', 'OPERATOR_AUTHORIZED', 'PLAN_VALIDATED', 'AGENTS_ASSIGNED', 'RUN_ADVANCED'] as const;

const Reason = z.object({ code: Token, message: Text(240) }).strict();
const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CLUB'), clubId: LabRef }).strict(),
  z.object({ kind: z.literal('PLATFORM') }).strict(),
]);

const ExecutionTaskSchema = TaskSchema.extend({ state: z.enum(EXECUTION_TASK_STATES) });
const ExecutionTraceEventSchema = TraceEventSchema.extend({ type: z.enum(EXECUTION_TRACE_TYPES) });
const LogEventSchema = z.object({
  seq: z.number().int().min(1),
  type: z.enum(EXECUTION_EVENT_TYPES),
  taskId: Slug.nullable(),
  agentId: z.null(),
  code: Token.nullable(),
  detail: Text(240),
  prev: Hex64,
  hash: Hex64,
}).strict();

export const ExecutionEvidenceSchema = z.object({
  contract: z.literal(EXECUTION_EVIDENCE_CONTRACT),
  orchestration: z.literal(ORCHESTRATION_CONTRACT),
  notice: z.literal(EXECUTION_EVIDENCE_NOTICE),
  environment: z.literal('LAB'),
  classification: z.literal('SYNTHETIC'),
  publicationId: PublicationId,
  /** The LAB record it was projected from. The record itself stays in the Lab: its digest is a commitment, not a copy. */
  source: z.object({ contract: z.literal(LAB_EXECUTION_CONTRACT), executionId: ExecutionId, requestId: RequestId, recordDigest: Hex64 }).strict(),
  /** The synthetic LAB operator who submitted it, as the record names them. Never the publication's approver. */
  operator: z.object({ userId: LabRef, role: Token }).strict(),
  plan: z.object({ id: Slug, title: Text(120), digest: Hex64, scope: Scope, requestedByRole: Token }).strict(),
  limits: z.object({ maxSteps: z.number().int().min(1).max(MAX_TASKS) }).strict(),
  context: z.object({ digest: Hex64, registryDigest: Hex64, operationsDigest: Hex64, policyDigest: Hex64 }).strict(),
  operations: z.array(OperationSchema).min(1).max(64),
  routing: z.array(z.object({
    taskId: Slug, operation: OpKey, tool: ToolKey, domain: Token.nullable(), selected: AgentId.nullable(),
    ranked: z.array(AgentId).max(64), passedOver: z.array(z.object({ agentId: AgentId, reason: Text(160) }).strict()).max(64),
  }).strict()).min(1).max(MAX_TASKS),
  decisions: z.array(z.object({ taskId: Slug, decision: z.enum(['APPROVED', 'REJECTED']), byRole: Token, accepted: z.boolean() }).strict()).max(32),
  run: z.object({
    outcome: z.enum(EXECUTION_OUTCOMES),
    refusal: Reason.nullable(),
    stop: z.object({ outcome: z.enum(['HALTED', 'CANCELLED']), code: z.enum(STOP_CODES), message: Text(240) }).strict().nullable(),
    steps: z.number().int().min(0).max(MAX_TASKS),
    order: z.array(Slug).max(MAX_TASKS),
    tasks: z.array(ExecutionTaskSchema).min(1).max(MAX_TASKS),
    trace: z.array(ExecutionTraceEventSchema).min(1).max(400),
    digest: Hex64,
  }).strict(),
  log: z.array(LogEventSchema).min(OPENING.length).max(200),
  digest: Hex64,
}).strict();

export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>;
type ExecutionTaskState = (typeof EXECUTION_TASK_STATES)[number];

/** The content a dossier's digest covers: everything but the digest itself. */
export const executionEvidenceDigest = (e: Omit<ExecutionEvidence, 'digest'> & { digest?: string }): string => {
  const { digest: _omit, ...rest } = e;
  return digestOf(rest);
};

/** What the server checked, in the order it checks it, as the room shows it beside each publication. */
export const PUBLICATION_CHECKS = Object.freeze([
  { id: 'version', detail: 'The evidence contract is version 2, the version this server reads for a publication.' },
  { id: 'shape', detail: 'Every field is one the contract names, within its bounds: no input, output or payload.' },
  { id: 'integrity', detail: 'The dossier digest is the digest of its content, and its execution and publication ids derive from what it records.' },
  { id: 'trace', detail: 'The run trace is an unbroken hash chain, and the run id is its head.' },
  { id: 'log', detail: 'The execution log is an unbroken hash chain of its own, and every step of it commits to the run trace.' },
  { id: 'coherence', detail: 'Every state, agent, handoff, decision and outcome shown is the one the chains record.' },
  { id: 'governance', detail: 'Every decision was an eligible role’s and never the submitter’s, and no medical action was approved.' },
  { id: 'synthetic', detail: 'Synthetic LAB data only: lab references, no address or real id, no health field.' },
  { id: 'identity', detail: 'Every agent and tool it names is registered on this server.' },
  { id: 'approval', detail: 'The approval record lists it once, with this digest, for a reviewed pull request.' },
] as const);

/** Each task's state, agent and decision as the run's chained trace records them. */
function traced(trace: ExecutionEvidence['run']['trace']) {
  const state = new Map<string, ExecutionTaskState>();
  const agent = new Map<string, string | null>();
  const decision = new Map<string, string>();
  for (const ev of trace) {
    if (!ev.taskId) continue;
    if (ev.type === 'TASK_ROUTED') agent.set(ev.taskId, ev.agentId);
    if (ev.type === 'APPROVAL_DECIDED' && ev.code) decision.set(ev.taskId, ev.code);
    const s: ExecutionTaskState | undefined =
      ev.type === 'TASK_ROUTED' ? 'PENDING'
        : ev.type === 'APPROVAL_REQUIRED' ? 'AWAITING_APPROVAL'
          : ev.type === 'APPROVAL_DECIDED' && ev.code === 'APPROVED' ? 'PENDING'
            : ev.type === 'TASK_SUCCEEDED' ? 'SUCCEEDED'
              : ev.type === 'TASK_FAILED' ? 'FAILED'
                : ev.type === 'TASK_SKIPPED' ? 'SKIPPED'
                  : ev.type === 'TASK_CANCELLED' ? 'CANCELLED'
                    : ev.type === 'TASK_REFUSED' ? (ev.code === 'REJECTED_BY_APPROVER' ? 'REJECTED' : 'REFUSED')
                      : undefined;
    if (s) state.set(ev.taskId, s);
  }
  return { state, agent, decision };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.key));
/** How AI-0.4 writes an accepted decision: what, on which task, by which role and LAB person. */
const DECIDED_BY = /^(approved|rejected) on "([a-z][a-z0-9-]{1,40})" by ([A-Z][A-Z0-9_]{0,40}) (lab-[a-z0-9][a-z0-9-]{0,40})$/;
const COMMITS_TO = /^run ([0-9a-f]{64}):/;

/** The version a document claims, when it claims one of this family's; null when it claims nothing recognisable. */
function claimedVersion(input: unknown): string | null {
  const c = input && typeof input === 'object' ? (input as { contract?: unknown }).contract : undefined;
  return typeof c === 'string' && /^familista\.orchestration-evidence\/v\d{1,3}$/.test(c) ? c : null;
}

/**
 * Every reason this is not a publishable v2 dossier. Empty means it is. With a
 * registry, also whether every agent it names is one the server registers.
 */
export function verifyExecutionEvidence(input: unknown, registry?: AgentRegistry): { evidence: ExecutionEvidence | null; reasons: string[] } {
  const claimed = claimedVersion(input);
  if (claimed && claimed !== EXECUTION_EVIDENCE_CONTRACT) {
    return { evidence: null, reasons: [`version: ${claimed} is not a publication; this server reads publications as ${EXECUTION_EVIDENCE_CONTRACT}`] };
  }
  const parsed = ExecutionEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { evidence: null, reasons: [`shape: ${i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'invalid'}`] };
  }
  const e = parsed.data;
  const { run, log } = e;
  const reasons: string[] = [];
  const add = (s: string) => { if (!reasons.includes(s)) reasons.push(s); };

  // integrity
  if (executionEvidenceDigest(e) !== e.digest) add('integrity: the dossier\'s digest is not the digest of its content');
  if (executionIdFor(e.operator.userId, e.source.requestId) !== e.source.executionId) add('integrity: the execution id is not its operator\'s and request\'s');
  if (publicationIdFor(e.source.executionId, e.source.recordDigest) !== e.publicationId) add('integrity: the publication id does not derive from its execution and record');
  if (digestOf({ registryDigest: e.context.registryDigest, operationsDigest: e.context.operationsDigest, policyDigest: e.context.policyDigest }) !== e.context.digest) {
    add('integrity: the security context digest is not the digest of its parts');
  }

  // trace
  const chain = verifyChain(run.trace);
  if (!chain.ok) add(`trace: the run trace breaks at event ${chain.brokenAt}`);
  const head = run.trace[run.trace.length - 1].hash;
  if (run.digest !== head) add('trace: the run id is not its trace\'s head');

  // log: its own chain, the opening AI-0.4 always records, and a commitment to the trace at every step
  const logChain = verifyChainFrom(log, EXECUTION_GENESIS);
  if (!logChain.ok) add(`log: the execution log breaks at event ${logChain.brokenAt}`);
  if (!sameList(log.slice(0, OPENING.length).map((ev) => ev.type), OPENING)) add('log: it does not open with the submission, authorization, validation and assignment an execution records');
  const [submitted, authorized, validated, assigned] = log;
  if (submitted.code !== 'SUBMIT' || !submitted.detail.startsWith(`request ${e.source.requestId} by ${e.operator.role} ${e.operator.userId}: plan ${e.plan.id} ${e.plan.digest.slice(0, 16)},`)
    || !submitted.detail.includes(`security context ${e.context.digest.slice(0, 16)}`)) add('log: the submission it records is not this execution\'s');
  if (authorized.code !== 'SUBMIT') add('log: it does not record the operator\'s authorization to submit');
  if (!validated.detail.endsWith(`order ${run.order.join(' → ')}`)) add('log: the validation it records is not of this run\'s order');
  if (assigned.detail !== e.routing.map((r) => `${r.taskId} → ${r.selected}`).join(', ')) add('log: the assignment it records is not this routing');
  const position = new Map(run.trace.map((ev, i) => [ev.hash, i] as const));
  let reached = -1;
  const advanced = log.filter((ev) => ev.type === 'RUN_ADVANCED');
  for (const ev of advanced) {
    const m = COMMITS_TO.exec(ev.detail);
    const at = m ? position.get(m[1]) : undefined;
    if (at === undefined || at < reached) { add('log: a step of it commits to no point of this run\'s trace'); break; }
    reached = at;
  }
  const last = advanced[advanced.length - 1];
  if (!last || !last.detail.startsWith(`run ${head}:`) || last.code !== run.outcome) add('log: its last step does not commit to the run as it settled');

  // coherence: what is shown is what the chains record
  const ids = run.tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) add('coherence: a task id repeats');
  if (run.order.length !== ids.length || run.order.some((id) => !ids.includes(id))) add('coherence: its order is not its tasks');
  const declared = new Map(e.operations.map((o) => [o.key, o] as const));
  const rec = traced(run.trace);
  for (const t of run.tasks) {
    const where = `task ${t.id}`;
    const op = declared.get(t.operation);
    if (!op || op.tool !== t.tool) add(`coherence: ${where} names an operation or tool the dossier does not declare`);
    if (t.dependsOn.some((d) => !ids.includes(d))) add(`coherence: ${where} depends on a task the run does not hold`);
    if (t.inputs.some((i) => !t.dependsOn.includes(i.from))) add(`coherence: ${where} received a handoff it does not depend on`);
    if (t.agent && !t.eligibleAgents.includes(t.agent.id)) add(`coherence: ${where} ran on an agent routing did not rank`);
    const s = rec.state.get(t.id) ?? 'PENDING';
    if (s !== t.state) add(`coherence: ${where} is shown as ${t.state}; its trace records ${s}`);
    if ((rec.agent.get(t.id) ?? null) !== (t.agent?.id ?? null)) add(`coherence: ${where} names an agent its trace did not route it to`);
    if ((rec.decision.get(t.id) ?? null) !== (t.approval?.decision ?? null)) add(`coherence: ${where} shows a decision its trace does not record`);
    const routed = e.routing.filter((r) => r.taskId === t.id);
    if (routed.length !== 1) { add(`coherence: ${where} does not have exactly one routing decision`); continue; }
    const r = routed[0];
    if (r.selected !== (t.agent?.id ?? null) || r.operation !== t.operation || r.tool !== t.tool || !sameList(r.ranked, t.eligibleAgents)) {
      add(`coherence: ${where} is not what its routing decision selected`);
    }
    if (r.passedOver.some((p) => p.agentId === r.selected || r.ranked.includes(p.agentId))) add(`coherence: ${where} passed over an agent its routing ranked`);
  }
  if (e.routing.length !== run.tasks.length) add('coherence: its routing is not one decision per task');
  const settled = run.trace.filter((ev) => ev.type === 'RUN_SETTLED').pop();
  if (!settled || settled.code !== run.outcome) add('coherence: its outcome is not the one its trace settled on');
  if (run.outcome === 'REFUSED' ? !run.refusal : run.refusal !== null) add('coherence: its outcome and refusal disagree');
  // The engine's own settlement rule: a stop decides it; else waiting, all done, some done, none.
  const n = (s: ExecutionTaskState) => run.tasks.filter((t) => t.state === s).length;
  if (run.outcome !== 'REFUSED') {
    const follows = run.stop ? run.stop.outcome
      : n('AWAITING_APPROVAL') + n('PENDING') ? 'AWAITING_APPROVAL'
        : n('SUCCEEDED') === run.tasks.length ? 'COMPLETED' : n('SUCCEEDED') ? 'PARTIAL' : 'FAILED';
    if (follows !== run.outcome) add('coherence: its outcome does not follow from its tasks\' states');
    const tally = `${n('SUCCEEDED')} succeeded, ${n('AWAITING_APPROVAL')} awaiting approval, ${n('FAILED')} failed, ${n('REFUSED')} refused, ${n('SKIPPED')} skipped, ${n('REJECTED')} rejected${n('CANCELLED') ? `, ${n('CANCELLED')} cancelled` : ''}`;
    if (settled && settled.detail !== tally) add('coherence: its settlement does not count its tasks as they are shown');
  }
  const accepted = e.decisions.filter((d) => d.accepted).length;
  const count = (type: string) => run.trace.filter((ev) => ev.type === type).length;
  if (accepted !== count('APPROVAL_DECIDED') || e.decisions.length - accepted !== count('APPROVAL_DECISION_REFUSED')) add('coherence: its decisions are not the ones its trace records');
  const submittedDecisions = log.filter((ev) => ev.type === 'DECISION_SUBMITTED');
  if (submittedDecisions.length !== e.decisions.length
    || submittedDecisions.some((ev, i) => ev.taskId !== e.decisions[i].taskId || ev.code !== (e.decisions[i].accepted ? e.decisions[i].decision : 'REFUSED'))) {
    add('coherence: its decisions are not the ones its execution log records');
  }
  // The stop: an operator's cancellation or governance's halt. The trace always records it. The log records
  // it too when it came after submission; a halt while the submitted plan first ran (the kill switch between
  // two tasks, a step limit) is in the trace only, and the log's last step commits to it.
  const stopped = run.outcome === 'HALTED' || run.outcome === 'CANCELLED';
  const stopEvents = run.trace.filter((ev) => ev.type === 'RUN_HALTED' || ev.type === 'RUN_CANCELLED');
  const logStops = log.filter((ev) => ev.type === 'EXECUTION_HALTED' || ev.type === 'EXECUTION_CANCELLED');
  if (stopped) {
    const s = run.stop;
    const traceType = run.outcome === 'HALTED' ? 'RUN_HALTED' : 'RUN_CANCELLED';
    const logType = run.outcome === 'HALTED' ? 'EXECUTION_HALTED' : 'EXECUTION_CANCELLED';
    const inLog = logStops.length === 1 && logStops[0].type === logType && logStops[0].code === s?.code;
    const atSubmission = logStops.length === 0 && run.outcome === 'HALTED' && advanced.length === 1;
    if (!s || s.outcome !== run.outcome || stopEvents.length !== 1 || stopEvents[0].type !== traceType || stopEvents[0].code !== s.code || !(inLog || atSubmission)) {
      add('coherence: the stop it shows is not the one its chains record');
    }
    if ((s?.code === 'CANCELLED_BY_OPERATOR') !== (run.outcome === 'CANCELLED')) add('coherence: only an operator cancels, and an operator only cancels');
  } else if (run.stop || stopEvents.length || logStops.length || count('TASK_CANCELLED')) {
    add('coherence: it records a stop its outcome does not show');
  }
  if (run.tasks.some((t) => t.state === 'CANCELLED') && !stopped) add('coherence: a task is cancelled in a run that was not stopped');

  // governance
  for (const t of run.tasks) {
    const a = t.approval;
    if (!a) continue;
    if (a.decision && (!a.decidedByRole || !a.eligibleRoles.includes(a.decidedByRole))) add(`governance: task ${t.id} was decided by a role that may not decide it`);
    if (t.recordClass === 'MEDICAL' && (a.eligibleRoles.length || a.decision === 'APPROVED')) add(`governance: task ${t.id} is a medical action, and no role may approve one`);
  }
  for (const ev of submittedDecisions) {
    if (ev.code === 'REFUSED') continue;
    const m = DECIDED_BY.exec(ev.detail);
    if (!m || m[2] !== ev.taskId || m[1].toUpperCase() !== ev.code) { add('governance: an accepted decision does not say who made it'); continue; }
    if (m[4] === e.operator.userId) add('governance: the operator who submitted it decided one of its approvals');
  }
  for (const ev of log) {
    if (ev.type === 'DECISION_REFUSED' && ev.code === 'KILL_SWITCH' && run.stop?.code !== 'KILL_SWITCH') add('governance: a decision refused by the kill switch did not halt it');
    if (ev.type === 'APPROVAL_INVALIDATED' && run.stop?.code !== 'APPROVAL_CONTEXT_CHANGED') add('governance: invalidated approvals did not halt it');
  }

  // synthetic, and no health data
  if (holdsRealLookingIds(e)) add('synthetic: it holds what looks like a real person\'s address or a real id');
  if (holdsHealthData(e)) add('no health data: a field in it is a health field');

  // identity
  const tools = new Set([...e.operations.map((o) => o.tool), ...run.tasks.map((t) => t.tool)]);
  if ([...tools].some((k) => !KNOWN_TOOLS.has(k))) add('identity: it names a tool this server does not register');
  if (registry) {
    const named = new Set<string>();
    for (const t of run.tasks) { if (t.agent) named.add(t.agent.id); t.eligibleAgents.forEach((id) => named.add(id)); }
    for (const r of e.routing) { if (r.selected) named.add(r.selected); r.ranked.forEach((id) => named.add(id)); r.passedOver.forEach((p) => named.add(p.agentId)); }
    for (const ev of run.trace) if (ev.agentId) named.add(ev.agentId);
    const unknown = [...named].filter((id) => !registry.get(id)).sort();
    if (unknown.length) add(`identity: it names agents this server does not register (${unknown.join(', ')})`);
  }
  return { evidence: reasons.length ? null : e, reasons };
}

// ── the approval record ──────────────────────────────────────────────────────

export const APPROVAL_RECORD_CONTRACT = 'familista.evidence-approvals/v1' as const;
export const APPROVAL_RULE = 'An entry takes effect only when the Platform Owner merges the reviewed pull request its reference names. No entry names who approved it: the merge is the approval.';
/** The one repository whose pull requests carry these approvals. */
export const PUBLICATION_REFERENCE = /^bibokh\/familista-backend#[1-9]\d{0,6}$/;
/** A pull request that cannot exist: what the Lab prepares in a rehearsal. This server refuses it, so a rehearsal is never an approval. */
export const REHEARSAL_REFERENCE = 'bibokh/familista-backend#9999999';
export const PUBLICATIONS_DIR = path.join(__dirname, 'published');
export const APPROVAL_RECORD_FILE = 'approvals.json';
export const PUBLICATION_FILE = /^pub-[0-9a-f]{24}\.json$/;
const MAX_RECORD_BYTES = 64 * 1024;
/** Fields that claim an identity. An entry never holds one: who approved it is the merge, not a word in the file. */
const IDENTITY_CLAIMS = ['approvedBy', 'approver', 'approvers', 'owner', 'by', 'operator', 'signedBy', 'signature', 'approvedAt', 'user', 'userId'];

export const ApprovalEntrySchema = z.object({
  publicationId: PublicationId,
  executionId: ExecutionId,
  /** The evidence version approved. A dossier in any other version is not what was approved. */
  evidence: z.literal(EXECUTION_EVIDENCE_CONTRACT),
  dossier: z.object({ file: z.string().regex(PUBLICATION_FILE), digest: Hex64 }).strict(),
  /** The pull request that carries this entry: its merge by the Platform Owner is the approval. */
  reference: z.string().regex(PUBLICATION_REFERENCE),
}).strict();
export const ApprovalRecordSchema = z.object({
  contract: z.literal(APPROVAL_RECORD_CONTRACT),
  rule: z.literal(APPROVAL_RULE),
  publications: z.array(ApprovalEntrySchema).max(64),
}).strict();
export type ApprovalEntry = z.infer<typeof ApprovalEntrySchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/**
 * Every reason this is not an approval record the server may act on: shape, identity claims, duplicates,
 * conflicts, rehearsals. Only the Lab's rehearsal read-back passes `rehearsal`; nothing that serves the room does.
 */
export function verifyApprovalRecord(input: unknown, opts: { rehearsal?: boolean } = {}): { record: ApprovalRecord | null; reasons: string[] } {
  const entries = input && typeof input === 'object' && Array.isArray((input as { publications?: unknown }).publications)
    ? (input as { publications: unknown[] }).publications : [];
  for (const entry of entries) {
    const claims = entry && typeof entry === 'object' ? IDENTITY_CLAIMS.filter((k) => k in (entry as object)) : [];
    if (claims.length) return { record: null, reasons: [`identity: an approval entry claims who approved it (${claims.join(', ')}); none may, because the approval is the Platform Owner's merge`] };
  }
  const parsed = ApprovalRecordSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { record: null, reasons: [`approval record: ${i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'invalid'}`] };
  }
  const record = parsed.data;
  const reasons: string[] = [];
  const once = (key: (e: ApprovalEntry) => string, what: string) => {
    const seen = new Set<string>();
    for (const e of record.publications) {
      const k = key(e);
      if (seen.has(k)) { reasons.push(`approval record: ${what} ${k} is approved twice`); return; }
      seen.add(k);
    }
  };
  once((e) => e.publicationId, 'publication');
  once((e) => e.executionId, 'execution');
  once((e) => e.dossier.file, 'dossier');
  once((e) => e.dossier.digest, 'dossier digest');
  for (const e of record.publications) {
    if (e.dossier.file !== `${e.publicationId}.json`) reasons.push(`approval record: ${e.publicationId} names another publication's dossier (${e.dossier.file})`);
    if (e.reference === REHEARSAL_REFERENCE && !opts.rehearsal) reasons.push(`approval record: ${e.publicationId} was prepared in a rehearsal, and a rehearsal is never an approval`);
  }
  return { record: reasons.length ? null : record, reasons };
}

// ── the reader ───────────────────────────────────────────────────────────────

export interface ApprovedPublication { entry: ApprovalEntry; evidence: ExecutionEvidence }

export type PublicationsRead =
  | { state: 'VERIFIED'; recordDigest: string; publications: ApprovedPublication[]; unapproved: string[] }
  | { state: 'NOT_GENERATED' | 'INVALID'; reason: string; unapproved: string[] };

export const PUBLICATION_REASONS = {
  missing: 'No approval record is beside this server.',
  tooLarge: 'A publication file is larger than any real one, so it was not read.',
  notJson: 'A publication file is not valid JSON.',
} as const;

function readJson(file: string, max: number): { json: unknown } | { reason: string } | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size > max) return { reason: PUBLICATION_REASONS.tooLarge };
  try { return { json: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { reason: PUBLICATION_REASONS.notJson }; }
}

/** Dossier files beside the record that no entry approves. Listed, never read, never shown. */
function unapprovedIn(dir: string, record: ApprovalRecord | null): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const approved = new Set((record?.publications ?? []).map((e) => e.dossier.file));
  return names.filter((n) => PUBLICATION_FILE.test(n) && !approved.has(n)).map((n) => n.replace(/\.json$/, '')).sort();
}

/** Every approved publication in this directory, each verified, or why none is shown. Nothing is read that no entry names. */
export function readPublications(registry: AgentRegistry, dir: string = PUBLICATIONS_DIR, opts: { rehearsal?: boolean } = {}): PublicationsRead {
  const raw = readJson(path.join(dir, APPROVAL_RECORD_FILE), MAX_RECORD_BYTES);
  if (!raw) return { state: 'NOT_GENERATED', reason: PUBLICATION_REASONS.missing, unapproved: unapprovedIn(dir, null) };
  if ('reason' in raw) return { state: 'INVALID', reason: `approval record: ${raw.reason}`, unapproved: unapprovedIn(dir, null) };
  const { record, reasons } = verifyApprovalRecord(raw.json, opts);
  if (!record) return { state: 'INVALID', reason: reasons.join('; '), unapproved: unapprovedIn(dir, null) };
  const unapproved = unapprovedIn(dir, record);
  const publications: ApprovedPublication[] = [];
  for (const entry of record.publications) {
    const where = `publication ${entry.publicationId}`;
    const file = readJson(path.join(dir, entry.dossier.file), EXECUTION_EVIDENCE_MAX_BYTES);
    if (!file) return { state: 'INVALID', reason: `${where}: its dossier is not beside this server`, unapproved };
    if ('reason' in file) return { state: 'INVALID', reason: `${where}: ${file.reason}`, unapproved };
    const checked = verifyExecutionEvidence(file.json, registry);
    if (!checked.evidence) return { state: 'INVALID', reason: `${where}: ${checked.reasons.join('; ')}`, unapproved };
    const ev = checked.evidence;
    if (ev.digest !== entry.dossier.digest) return { state: 'INVALID', reason: `${where}: its dossier is not the one approved (digest ${ev.digest.slice(0, 16)}, approved ${entry.dossier.digest.slice(0, 16)})`, unapproved };
    if (ev.publicationId !== entry.publicationId || ev.source.executionId !== entry.executionId) return { state: 'INVALID', reason: `${where}: its dossier is another publication's`, unapproved };
    publications.push({ entry, evidence: ev });
  }
  return { state: 'VERIFIED', recordDigest: digestOf(record), publications, unapproved };
}

let cached: PublicationsRead | null = null;

/** The publications that shipped with this build, verified against the registry it runs. Read once per process. */
export function readShippedPublications(registry: AgentRegistry): PublicationsRead {
  if (!cached) cached = readPublications(registry);
  return cached;
}

/** For tests: forget the cached read. */
export function resetPublications(): void { cached = null; }

// ── what the Operations Room is given ───────────────────────────────────────

export interface PublicationsRoomView {
  state: PublicationsRead['state'];
  reason: string | null;
  notice: string;
  contract: typeof EXECUTION_EVIDENCE_CONTRACT;
  supported: string[];
  rule: string;
  record: { digest: string | null; entries: number };
  checks: Array<{ id: string; detail: string }>;
  /** Dossier files present without an approval entry: never read, never shown, listed so their presence is seen. */
  unapproved: string[];
  publications: Array<{
    publicationId: string;
    reference: string;
    dossierDigest: string;
    registry: { evidence: string; current: string; matches: boolean };
    agents: Array<{ id: string; known: boolean; current: boolean }>;
    evidence: ExecutionEvidence;
  }>;
}

/** Approved, verified publications, tied to the registry this server holds; nothing of any when they do not all verify. */
export function publicationsRoomView(registry: AgentRegistry, read: PublicationsRead = readShippedPublications(registry)): PublicationsRoomView {
  const base = {
    notice: EXECUTION_EVIDENCE_NOTICE, contract: EXECUTION_EVIDENCE_CONTRACT, supported: [...SUPPORTED_EVIDENCE_CONTRACTS],
    rule: APPROVAL_RULE, checks: PUBLICATION_CHECKS.map((c) => ({ ...c })), unapproved: [...read.unapproved],
  };
  if (read.state !== 'VERIFIED') return { ...base, state: read.state, reason: read.reason, record: { digest: null, entries: 0 }, publications: [] };
  const current = registry.digest();
  return {
    ...base, state: 'VERIFIED', reason: null, record: { digest: read.recordDigest, entries: read.publications.length },
    publications: read.publications.map(({ entry, evidence }) => {
      const named = new Map<string, string>();
      for (const t of evidence.run.tasks) if (t.agent) named.set(t.agent.id, t.agent.digest);
      const agents = [...named.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, digest]) => {
        const now = registry.get(id);
        return { id, known: !!now, current: !!now && now.digest === digest };
      });
      return {
        publicationId: entry.publicationId, reference: entry.reference, dossierDigest: entry.dossier.digest,
        registry: { evidence: evidence.context.registryDigest, current, matches: evidence.context.registryDigest === current },
        agents, evidence,
      };
    }),
  };
}
