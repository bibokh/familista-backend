// LAB orchestration evidence — the only thing production knows about the orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.3. The Multi-Agent Orchestrator lives in
// lab/orchestrator, OUTSIDE src/ and so outside the production build. It runs
// only in the Lab and in CI, over synthetic clubs and people. What it decided
// is written to src/platform/agents/generated/orchestration-evidence.json and
// committed; tests/orchestration-evidence.unit.test.ts recomputes it and fails
// when it is stale.
//
// This file is the evidence's contract, its verifier and its reader, the same
// pattern as the algorithm lab's candidate evidence. The server never runs the
// orchestrator: it reads that file, and serves it to the AI Agents Operations
// Room only if ALL of this holds —
//
//   shape       the v1 schema, strictly: no field it does not name, so no
//               operation input or output, no person, no payload;
//   integrity   the file's digest is the digest of its content, every run's
//               trace is an unbroken hash chain (trace-chain.ts, the rule the
//               Lab wrote it with), and a run's id is its trace's head;
//   coherence   every task, dependency, handoff and operation it names exists
//               in the same run;
//   synthetic   every club is a `lab-…` reference, it was produced in the Lab,
//               and nothing in it looks like an e-mail address or a real id;
//   no health   no field anywhere is a health field (the AI read policy's).
//
// A file that fails any of them is INVALID, says which, and nothing in it is
// shown. The lab's writer applies the same function before it writes, so it
// cannot publish what this would refuse.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { holdsHealthData } from '../../security/ai-read-policy';
import type { AgentRegistry } from './registry';
import { digestOf, ORCHESTRATION_CONTRACT, verifyChain } from './trace-chain';

export const ORCHESTRATION_EVIDENCE_CONTRACT = 'familista.orchestration-evidence/v1' as const;
/** Said on every view of the evidence. The lab writes the same sentence into it. */
export const ORCHESTRATION_EVIDENCE_NOTICE = 'Synthetic LAB evidence: what the LAB orchestrator decided for invented clubs and people, over the Agent Registry. Nothing here ran in production, and no agent acted.';
/** Far above any real evidence file; a file this large is refused unread. */
export const ORCHESTRATION_EVIDENCE_MAX_BYTES = 1024 * 1024;
export const ORCHESTRATION_EVIDENCE_FILE = path.join(__dirname, 'generated', 'orchestration-evidence.json');

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const LabRef = z.string().regex(/^lab-[a-z0-9][a-z0-9-]{0,40}$/);
const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
const OpKey = z.string().regex(/^[a-z]+\.[a-z][a-z-]{1,40}@[1-9]\d*$/);
const AgentId = z.string().regex(/^(club|platform)\.[a-z][a-z0-9-]{1,40}$/);
const Token = z.string().regex(/^[A-Z][A-Z0-9_]{0,40}$/);
const ToolKey = z.string().regex(/^[a-z][A-Za-z]{1,40}$/);
const Semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const Text = (max: number) => z.string().min(1).max(max);
const DataClass = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const RecordClass = z.enum(['OPERATIONAL', 'SCOUTING', 'FINANCE', 'MEDICAL']);

export const TASK_STATES = ['PENDING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'REFUSED', 'SKIPPED', 'REJECTED'] as const;
export const RUN_OUTCOMES = ['COMPLETED', 'PARTIAL', 'FAILED', 'AWAITING_APPROVAL', 'REFUSED'] as const;
export const TRACE_TYPES = [
  'PLAN_RECEIVED', 'PLAN_REFUSED', 'PLAN_ACCEPTED', 'TASK_ROUTED', 'TASK_REFUSED', 'APPROVAL_REQUIRED', 'APPROVAL_DECIDED',
  'APPROVAL_DECISION_REFUSED', 'HANDOFF_ACCEPTED', 'HANDOFF_BLOCKED', 'TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_SKIPPED', 'RUN_SETTLED',
] as const;

const OperationSchema = z.object({
  key: OpKey, title: Text(120), tool: ToolKey, domain: Token.nullable(), output: DataClass,
}).strict();

const TaskSchema = z.object({
  id: Slug,
  operation: OpKey,
  tool: ToolKey,
  state: z.enum(TASK_STATES),
  dependsOn: z.array(Slug).max(8),
  agent: z.object({ id: AgentId, version: Semver, digest: Hex64 }).strict().nullable(),
  eligibleAgents: z.array(AgentId).max(64),
  dataClass: DataClass.nullable(),
  recordClass: RecordClass.nullable(),
  outputDigest: Hex64.nullable(),
  approval: z.object({
    eligibleRoles: z.array(Token).max(16),
    decision: z.enum(['APPROVED', 'REJECTED']).nullable(),
    decidedByRole: Token.nullable(),
  }).strict().nullable(),
  reason: z.object({ code: Token, message: Text(240) }).strict().nullable(),
  inputs: z.array(z.object({ from: Slug, status: z.enum(['ACCEPTED', 'BLOCKED']) }).strict()).max(8),
}).strict();

const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('START') }).strict(),
  /** A person's decision as it was put to the run; `accepted` is false when the run refused to take it. */
  z.object({ kind: z.literal('DECISION'), taskId: Slug, decision: z.enum(['APPROVED', 'REJECTED']), byRole: Token, accepted: z.boolean() }).strict(),
]);

const TraceEventSchema = z.object({
  seq: z.number().int().min(1),
  type: z.enum(TRACE_TYPES),
  taskId: Slug.nullable(),
  agentId: AgentId.nullable(),
  code: Token.nullable(),
  detail: Text(320),
  prev: Hex64,
  hash: Hex64,
}).strict();

const RunSchema = z.object({
  id: Hex64,
  scenario: Slug,
  title: Text(120),
  planId: Slug.nullable(),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('CLUB'), clubId: LabRef }).strict(),
    z.object({ kind: z.literal('PLATFORM') }).strict(),
  ]),
  requestedByRole: Token,
  steps: z.array(StepSchema).min(1).max(8),
  outcome: z.enum(RUN_OUTCOMES),
  refusal: z.object({ code: Token, message: Text(240) }).strict().nullable(),
  order: z.array(Slug).max(24),
  tasks: z.array(TaskSchema).max(24),
  trace: z.array(TraceEventSchema).min(1).max(400),
  digest: Hex64,
}).strict();

export const OrchestrationEvidenceSchema = z.object({
  contract: z.literal(ORCHESTRATION_EVIDENCE_CONTRACT),
  orchestration: z.literal(ORCHESTRATION_CONTRACT),
  notice: z.literal(ORCHESTRATION_EVIDENCE_NOTICE),
  environment: z.literal('LAB'),
  registryDigest: Hex64,
  operations: z.array(OperationSchema).min(1).max(64),
  runs: z.array(RunSchema).min(1).max(32),
  digest: Hex64,
}).strict();

export type OrchestrationEvidence = z.infer<typeof OrchestrationEvidenceSchema>;
export type EvidenceRun = z.infer<typeof RunSchema>;

/** The content a digest covers: everything but the digest itself. */
export const evidenceDigest = (e: Omit<OrchestrationEvidence, 'digest'> & { digest?: string }): string => {
  const { digest: _omit, ...rest } = e;
  return digestOf(rest);
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) strings(v, out, depth + 1);
  return out;
}

type EvidenceTaskState = (typeof TASK_STATES)[number];
const STATE_OF_EVENT: Partial<Record<string, EvidenceTaskState>> = {
  APPROVAL_REQUIRED: 'AWAITING_APPROVAL', TASK_SUCCEEDED: 'SUCCEEDED', TASK_FAILED: 'FAILED', TASK_SKIPPED: 'SKIPPED',
};

/**
 * What a run's chained trace records for each task: where it ended, the agent it
 * was routed to, the decision a person made. The summary the room draws must be
 * exactly this, so the run id (the chain's head) commits to every colour shown.
 */
function recorded(run: EvidenceRun) {
  const state = new Map<string, EvidenceTaskState>();
  const agent = new Map<string, string | null>();
  const decision = new Map<string, string>();
  for (const ev of run.trace) {
    if (!ev.taskId) continue;
    if (ev.type === 'TASK_ROUTED') agent.set(ev.taskId, ev.agentId);
    if (ev.type === 'APPROVAL_DECIDED' && ev.code) decision.set(ev.taskId, ev.code);
    const s = ev.type === 'TASK_REFUSED' ? (ev.code === 'REJECTED_BY_APPROVER' ? 'REJECTED' : 'REFUSED') : STATE_OF_EVENT[ev.type];
    if (s) state.set(ev.taskId, s);
  }
  return { state, agent, decision };
}

/** Every reason this is not publishable evidence. Empty means it is. */
export function verifyOrchestrationEvidence(input: unknown): { evidence: OrchestrationEvidence | null; reasons: string[] } {
  const parsed = OrchestrationEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { evidence: null, reasons: [`shape: ${i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'invalid'}`] };
  }
  const e = parsed.data;
  const reasons: string[] = [];
  if (evidenceDigest(e) !== e.digest) reasons.push('integrity: the file\'s digest is not the digest of its content');
  const ops = new Set(e.operations.map((o) => o.key));
  const ids = new Set<string>();
  for (const run of e.runs) {
    const where = `run ${run.scenario}`;
    if (ids.has(run.id)) reasons.push(`${where}: its id repeats another run's`);
    ids.add(run.id);
    const chain = verifyChain(run.trace);
    if (!chain.ok) reasons.push(`integrity: ${where}: the trace chain breaks at event ${chain.brokenAt}`);
    const head = run.trace[run.trace.length - 1].hash;
    if (run.digest !== head || run.id !== head) reasons.push(`integrity: ${where}: its id and digest are not its trace's head`);
    const taskIds = run.tasks.map((t) => t.id);
    const rec = recorded(run);
    if (run.order.length !== taskIds.length || run.order.some((id) => !taskIds.includes(id))) reasons.push(`coherence: ${where}: its order is not its tasks`);
    for (const t of run.tasks) {
      if (!ops.has(t.operation)) reasons.push(`coherence: ${where}: task ${t.id} names an operation the evidence does not declare`);
      if (t.dependsOn.some((d) => !taskIds.includes(d))) reasons.push(`coherence: ${where}: task ${t.id} depends on a task the run does not hold`);
      if (t.inputs.some((i) => !t.dependsOn.includes(i.from))) reasons.push(`coherence: ${where}: task ${t.id} received a handoff it does not depend on`);
      if (t.agent && !t.eligibleAgents.includes(t.agent.id)) reasons.push(`coherence: ${where}: task ${t.id} ran on an agent routing did not rank`);
      const traced = rec.state.get(t.id) ?? 'PENDING';
      if (traced !== t.state) reasons.push(`coherence: ${where}: task ${t.id} is shown as ${t.state}; its trace records ${traced}`);
      if ((rec.agent.get(t.id) ?? null) !== (t.agent?.id ?? null)) reasons.push(`coherence: ${where}: task ${t.id} names an agent its trace did not route it to`);
      if ((rec.decision.get(t.id) ?? null) !== (t.approval?.decision ?? null)) reasons.push(`coherence: ${where}: task ${t.id} shows a decision its trace does not record`);
    }
    // A refused decision changes nothing, so it is recorded after the settlement it leaves standing.
    const settled = run.trace.filter((ev) => ev.type === 'RUN_SETTLED').pop();
    if (!settled || settled.code !== run.outcome) reasons.push(`coherence: ${where}: its outcome is not the one its trace settled on`);
    const decided = (ok: boolean) => run.steps.filter((st) => st.kind === 'DECISION' && st.accepted === ok).length;
    const events = (type: string) => run.trace.filter((ev) => ev.type === type).length;
    if (decided(true) !== events('APPROVAL_DECIDED') || decided(false) !== events('APPROVAL_DECISION_REFUSED')) reasons.push(`coherence: ${where}: its steps are not the decisions its trace records`);
    if (run.outcome === 'REFUSED' ? !run.refusal || run.tasks.length > 0 : run.refusal !== null) reasons.push(`coherence: ${where}: its outcome and refusal disagree`);
  }
  for (const s of strings(e)) {
    if (EMAIL.test(s) || UUID.test(s)) { reasons.push('synthetic: it holds what looks like a real person\'s address or a real id'); break; }
  }
  if (holdsHealthData(e)) reasons.push('no health data: a field in it is a health field');
  return { evidence: reasons.length ? null : e, reasons };
}

// ── the reader ───────────────────────────────────────────────────────────────

export type OrchestrationEvidenceRead =
  | { state: 'VERIFIED'; evidence: OrchestrationEvidence }
  | { state: 'NOT_GENERATED' | 'INVALID'; reason: string };

export const ORCHESTRATION_EVIDENCE_REASONS = {
  missing: 'The LAB orchestration evidence is not beside this server.',
  tooLarge: 'The LAB orchestration evidence file is larger than any real one, so it was not read.',
  notJson: 'The LAB orchestration evidence file is not valid JSON.',
} as const;

let cached: OrchestrationEvidenceRead | null = null;

/** The evidence that shipped with this build, verified. Read once per process: it is part of the build. */
export function readOrchestrationEvidence(file: string = ORCHESTRATION_EVIDENCE_FILE): OrchestrationEvidenceRead {
  const useCache = file === ORCHESTRATION_EVIDENCE_FILE;
  if (useCache && cached) return cached;
  const result = readFrom(file);
  if (useCache) cached = result;
  return result;
}

function readFrom(file: string): OrchestrationEvidenceRead {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { state: 'NOT_GENERATED', reason: ORCHESTRATION_EVIDENCE_REASONS.missing }; }
  if (size > ORCHESTRATION_EVIDENCE_MAX_BYTES) return { state: 'INVALID', reason: ORCHESTRATION_EVIDENCE_REASONS.tooLarge };
  let json: unknown;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { state: 'INVALID', reason: ORCHESTRATION_EVIDENCE_REASONS.notJson }; }
  const { evidence, reasons } = verifyOrchestrationEvidence(json);
  return evidence ? { state: 'VERIFIED', evidence } : { state: 'INVALID', reason: reasons.join('; ') };
}

/** For tests: forget the cached read. */
export function resetOrchestrationEvidence(): void { cached = null; }

// ── what the Operations Room is given ───────────────────────────────────────

export interface OrchestrationRoomView {
  state: OrchestrationEvidenceRead['state'];
  reason: string | null;
  notice: string;
  contract: typeof ORCHESTRATION_EVIDENCE_CONTRACT;
  evidenceDigest: string | null;
  /** The registry the Lab routed over, against the one this server runs. */
  registry: { evidence: string | null; current: string; matches: boolean };
  /** Each agent the evidence names, and whether the registry still holds that exact manifest. */
  agents: Array<{ id: string; known: boolean; current: boolean }>;
  operations: OrchestrationEvidence['operations'];
  runs: EvidenceRun[];
}

/** Verified evidence, tied to the registry this server holds; nothing at all when it is not verified. */
export function orchestrationRoomView(registry: AgentRegistry, read: OrchestrationEvidenceRead = readOrchestrationEvidence()): OrchestrationRoomView {
  const base = { notice: ORCHESTRATION_EVIDENCE_NOTICE, contract: ORCHESTRATION_EVIDENCE_CONTRACT };
  if (read.state !== 'VERIFIED') {
    return { ...base, state: read.state, reason: read.reason, evidenceDigest: null, registry: { evidence: null, current: registry.digest(), matches: false }, agents: [], operations: [], runs: [] };
  }
  const e = read.evidence;
  const named = new Map<string, string>();
  for (const run of e.runs) for (const t of run.tasks) if (t.agent) named.set(t.agent.id, t.agent.digest);
  const agents = [...named.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, digest]) => {
    const now = registry.get(id);
    return { id, known: !!now, current: !!now && now.digest === digest };
  });
  return {
    ...base, state: 'VERIFIED', reason: null, evidenceDigest: e.digest,
    registry: { evidence: e.registryDigest, current: registry.digest(), matches: e.registryDigest === registry.digest() },
    agents, operations: e.operations, runs: e.runs,
  };
}
