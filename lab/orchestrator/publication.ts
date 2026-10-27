// Publication — a verified LAB execution, prepared for the Platform Owner's review
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.5 (LAB). An AI-0.4 execution record
// stays in the Lab. This file is the only way any of it travels: as a v2
// dossier (src/platform/agents/execution-evidence.ts), and only as far as a
// working tree, for a pull request.
//
//   candidate   verify the record by the Lab's own rule (verifyExecution),
//               project it into a dossier — what was decided, never an input or
//               an output — and check that with production's verifier. Writes
//               nothing.
//   prepare     the same, then write the dossier and an entry in the approval
//               record into a publications directory, for the pull request
//               named, and read the directory back exactly as production
//               would. Commits nothing.
//
// There is no approve and no publish here, and no flag that names an approver:
// approval is the Platform Owner merging the reviewed pull request, and nothing
// in the Lab can do that or stand in for it. Until the merge, the build that
// production runs holds no entry, so it shows nothing.

import * as fs from 'fs';
import * as path from 'path';
import { currentEnvironment, type FamilistaEnvironment } from '../../src/platform/environment';
import type { AgentRegistry } from '../../src/platform/agents/registry';
import {
  APPROVAL_RECORD_CONTRACT, APPROVAL_RECORD_FILE, APPROVAL_RULE, EXECUTION_EVIDENCE_CONTRACT, EXECUTION_EVIDENCE_NOTICE,
  executionEvidenceDigest, publicationIdFor, PUBLICATION_REFERENCE, PUBLICATIONS_DIR, readPublications, REHEARSAL_REFERENCE, verifyApprovalRecord,
  verifyExecutionEvidence, type ApprovalEntry, type ApprovalRecord, type ExecutionEvidence, type PublicationsRead,
} from '../../src/platform/agents/execution-evidence';
import { ORCHESTRATION_CONTRACT } from './contracts';
import { securityContext, verifyExecution, type ExecutionRecord } from './execution';
import type { OperationCatalog } from './operations';
import { LAB_OPERATORS } from './operators';

export { PUBLICATIONS_DIR, REHEARSAL_REFERENCE };

export interface PublicationDeps { registry: AgentRegistry; operations: OperationCatalog }

export type PublicationRefusalCode =
  | 'ENVIRONMENT_NOT_LAB' | 'RECORD_INVALID' | 'OPERATIONS_CHANGED' | 'NOT_A_CANDIDATE' | 'REFERENCE_INVALID'
  | 'APPROVAL_RECORD_INVALID' | 'ALREADY_PUBLISHED' | 'PUBLICATION_CONFLICT' | 'READ_BACK_FAILED';

export interface PublicationCandidate { evidence: ExecutionEvidence | null; reasons: string[] }

export type PrepareResult =
  /** `read` is the directory read back by production's rules; for a rehearsal, with its reference let through, and `production` is what the server itself would say. */
  | { status: 'PREPARED'; entry: ApprovalEntry; evidence: ExecutionEvidence; files: string[]; read: PublicationsRead; production: PublicationsRead }
  | { status: 'REFUSED'; code: PublicationRefusalCode; message: string };

/** The record as a v2 dossier: what was decided and recorded, never what an operation was given or produced. */
export function toExecutionEvidence(record: ExecutionRecord, operations: OperationCatalog): ExecutionEvidence {
  const { run } = record;
  const plan = run.plan;
  if (!plan) throw new Error('the run has no plan');
  const spec = (id: string) => plan.tasks.find((t) => t.id === id);
  const used = new Set(run.tasks.map((t) => t.operation));
  const body: Omit<ExecutionEvidence, 'digest'> = {
    contract: EXECUTION_EVIDENCE_CONTRACT, orchestration: ORCHESTRATION_CONTRACT, notice: EXECUTION_EVIDENCE_NOTICE,
    environment: 'LAB', classification: 'SYNTHETIC',
    publicationId: publicationIdFor(record.executionId, record.digest),
    source: { contract: record.contract, executionId: record.executionId, requestId: record.requestId, recordDigest: record.digest },
    operator: { userId: record.operator.userId, role: record.operator.role },
    plan: {
      id: record.planId, title: plan.title, digest: record.planDigest,
      scope: plan.scope.kind === 'CLUB' ? { kind: 'CLUB', clubId: plan.scope.clubId } : { kind: 'PLATFORM' },
      requestedByRole: plan.requestedBy.role,
    },
    limits: { maxSteps: record.limits.maxSteps },
    context: { digest: record.context.digest, registryDigest: record.context.registryDigest, operationsDigest: record.context.operationsDigest, policyDigest: record.context.policyDigest },
    operations: operations.list().filter((o) => used.has(o.key)).map((o) => ({ key: o.key, title: o.title, tool: o.tool, domain: o.domain, output: o.output })),
    routing: record.routing.map((r) => ({
      taskId: r.taskId, operation: r.operation, tool: r.tool, domain: r.domain, selected: r.selected, ranked: [...r.ranked],
      passedOver: r.passedOver.map((p) => ({ agentId: p.agentId, reason: p.reason })),
    })),
    decisions: record.decisions.map((d) => ({ taskId: d.taskId, decision: d.decision, byRole: d.byRole, accepted: d.accepted })),
    run: {
      outcome: run.outcome,
      refusal: run.refusal ? { code: run.refusal.code, message: run.refusal.message } : null,
      stop: run.stop ? { outcome: run.stop.outcome, code: run.stop.code, message: run.stop.message } : null,
      steps: run.steps,
      order: [...run.order],
      tasks: run.tasks.map((t) => ({
        id: t.id, operation: t.operation, tool: t.tool, state: t.state, dependsOn: [...(spec(t.id)?.dependsOn ?? [])],
        agent: t.agent ? { id: t.agent.id, version: t.agent.version, digest: t.agent.digest } : null,
        eligibleAgents: [...t.eligibleAgents], dataClass: t.dataClass, recordClass: t.recordClass, outputDigest: t.outputDigest,
        approval: t.approval ? { eligibleRoles: [...t.approval.eligibleRoles], decision: t.approval.decision, decidedByRole: t.approval.decidedBy?.role ?? null } : null,
        reason: t.reason ? { code: t.reason.code, message: t.reason.message } : null,
        inputs: t.inputs.map((i) => ({ from: i.from, status: i.status })),
      })),
      trace: run.trace.map((e) => ({ seq: e.seq, type: e.type, taskId: e.taskId, agentId: e.agentId, code: e.code, detail: e.detail, prev: e.prev, hash: e.hash })),
      digest: run.digest,
    },
    log: record.log.map((e) => ({ seq: e.seq, type: e.type, taskId: e.taskId, agentId: null, code: e.code, detail: e.detail, prev: e.prev, hash: e.hash })),
  };
  return { ...body, digest: executionEvidenceDigest(body) };
}

/**
 * Whether this record could be published, and as what. Its outcome is never taken
 * on its word: the record must verify by the Lab's rule, and its dossier by
 * production's, which re-derives every state, decision and stop from the chains.
 */
export function executionPublicationCandidate(record: unknown, deps: PublicationDeps): PublicationCandidate {
  const check = verifyExecution(record);
  if (!check.ok) return { evidence: null, reasons: check.reasons.map((r) => `record: ${r}`) };
  const r = record as ExecutionRecord;
  const now = securityContext(deps.registry, deps.operations, LAB_OPERATORS);
  if (now.operationsDigest !== r.context.operationsDigest) {
    return { evidence: null, reasons: ['operations: the LAB operations changed since this ran, so the titles a dossier would carry are not the ones it ran under'] };
  }
  let dossier: ExecutionEvidence;
  try { dossier = toExecutionEvidence(r, deps.operations); } catch (e) { return { evidence: null, reasons: [e instanceof Error ? e.message : String(e)] }; }
  return verifyExecutionEvidence(dossier, deps.registry);
}

const emptyRecord = (): ApprovalRecord => ({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: [] });
const serialise = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function writeWhole(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Write the dossier and its approval entry into `dir`, for the pull request
 * `reference`, and read the directory back as production would. Nothing is
 * approved by this: the entry takes effect only when the Platform Owner merges
 * that pull request.
 */
export function preparePublication(
  record: unknown, deps: PublicationDeps,
  opts: { reference: string; dir?: string; environment?: FamilistaEnvironment },
): PrepareResult {
  const environment = opts.environment ?? currentEnvironment();
  if (environment !== 'LAB') return { status: 'REFUSED', code: 'ENVIRONMENT_NOT_LAB', message: `publications are prepared in the Lab only; this process is ${environment}` };
  if (!PUBLICATION_REFERENCE.test(opts.reference)) {
    return { status: 'REFUSED', code: 'REFERENCE_INVALID', message: `"${opts.reference.slice(0, 80)}" is not a pull request of bibokh/familista-backend (owner/repo#number)` };
  }
  const recordCheck = verifyExecution(record);
  if (!recordCheck.ok) return { status: 'REFUSED', code: 'RECORD_INVALID', message: recordCheck.reasons[0] };
  const candidate = executionPublicationCandidate(record, deps);
  if (!candidate.evidence) {
    const code = candidate.reasons[0]?.startsWith('operations:') ? 'OPERATIONS_CHANGED' : 'NOT_A_CANDIDATE';
    return { status: 'REFUSED', code, message: candidate.reasons.join('; ') };
  }
  const evidence = candidate.evidence;
  const dir = opts.dir ?? PUBLICATIONS_DIR;
  const recordFile = path.join(dir, APPROVAL_RECORD_FILE);

  const rehearsal = opts.reference === REHEARSAL_REFERENCE;
  let current: ApprovalRecord = emptyRecord();
  if (fs.existsSync(recordFile)) {
    let json: unknown;
    try { json = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return { status: 'REFUSED', code: 'APPROVAL_RECORD_INVALID', message: 'the approval record is not valid JSON' }; }
    const checked = verifyApprovalRecord(json, { rehearsal });
    if (!checked.record) return { status: 'REFUSED', code: 'APPROVAL_RECORD_INVALID', message: checked.reasons.join('; ') };
    current = checked.record;
  }
  const same = current.publications.find((e) => e.executionId === evidence.source.executionId);
  if (same) {
    return { status: 'REFUSED', code: 'ALREADY_PUBLISHED', message: `execution ${evidence.source.executionId} is already in the approval record as ${same.publicationId} (${same.reference}); an execution is published once` };
  }
  const file = `${evidence.publicationId}.json`;
  const dossierFile = path.join(dir, file);
  if (current.publications.some((e) => e.publicationId === evidence.publicationId) || fs.existsSync(dossierFile)) {
    return { status: 'REFUSED', code: 'PUBLICATION_CONFLICT', message: `a dossier named ${file} is already beside the approval record` };
  }

  const entry: ApprovalEntry = {
    publicationId: evidence.publicationId, executionId: evidence.source.executionId, evidence: EXECUTION_EVIDENCE_CONTRACT,
    dossier: { file, digest: evidence.digest }, reference: opts.reference,
  };
  const before = fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8') : null;
  fs.mkdirSync(dir, { recursive: true });
  writeWhole(dossierFile, serialise(evidence));
  writeWhole(recordFile, serialise({ ...current, publications: [...current.publications, entry] }));

  // Read it back exactly as production will, and undo both writes if that refuses it.
  const read = readPublications(deps.registry, dir, { rehearsal });
  if (read.state !== 'VERIFIED' || !read.publications.some((p) => p.entry.publicationId === entry.publicationId)) {
    fs.rmSync(dossierFile, { force: true });
    if (before === null) fs.rmSync(recordFile, { force: true }); else writeWhole(recordFile, before);
    return { status: 'REFUSED', code: 'READ_BACK_FAILED', message: read.state === 'VERIFIED' ? 'production would not show it' : read.reason };
  }
  return { status: 'PREPARED', entry, evidence, files: [dossierFile, recordFile], read, production: rehearsal ? readPublications(deps.registry, dir) : read };
}
