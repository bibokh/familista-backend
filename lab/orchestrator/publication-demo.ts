// Publication, demonstrated — from an AI-0.4 execution to the Platform Owner's boundary
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.5 (LAB). One synthetic workflow,
// Tactical → Training → Club Manager, taken as far as the Lab can take it: run
// under governance, recorded, verified, made a candidate, refused every way a
// publication without the owner's approval could be attempted, then prepared
// for review in a rehearsal directory with a pull request that cannot exist.
// It stops there. Nothing here approves, and nothing it writes is in the tree
// production is built from.
//
// The gallery is the same pipeline over one execution of every outcome a
// publication can show. Its rehearsed room view is what the Operations Room's
// tests draw (tests/fixtures/publications-room-view.json): what the room WOULD
// show if each were approved, which none is.

import * as fs from 'fs';
import * as path from 'path';
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import { engageKillSwitch, killSwitchEngaged, releaseKillSwitch } from '../../src/platform/intelligence/agents';
import {
  APPROVAL_RECORD_FILE, EXECUTION_EVIDENCE_CONTRACT, executionEvidenceDigest, publicationsRoomView, readPublications, verifyExecutionEvidence,
  type PublicationsRoomView,
} from '../../src/platform/agents/execution-evidence';
import { readOrchestrationEvidence, verifyOrchestrationEvidence } from '../../src/platform/agents/orchestration-evidence';
import {
  cancelExecution, decideExecution, MemoryExecutionStore, submitExecution, verifyExecution,
  type ExecutionDeps, type ExecutionRecord,
} from './execution';
import { ANALYST, approveNotice, executionRequest, matchdayPlan, NORTH_OPERATOR, SOUTH_CLUB_ADMIN } from './execution-scenarios';
import { labExecutionOperations } from './operations';
import { executionPublicationCandidate, preparePublication, REHEARSAL_REFERENCE, type PublicationDeps } from './publication';
import * as S from './scenarios';

export interface DemoStep { n: number; step: string; result: 'DONE' | 'BLOCKED' | 'VERIFIED' | 'REFUSED' | 'SIMULATED'; detail: string }

const depsFor = (over: Partial<ExecutionDeps> = {}): ExecutionDeps => ({
  registry: platformAgentRegistry(), operations: labExecutionOperations(), store: new MemoryExecutionStore(), environment: 'LAB', ...over,
});

function only(deps: ExecutionDeps): ExecutionRecord {
  const ids = deps.store.list();
  const r = ids.length === 1 ? deps.store.get(ids[0]) : null;
  if (!r) throw new Error('the demonstration expected exactly one execution');
  return r;
}

/** The matchday workflow: the head coach submits, tries to approve their own notice (refused), the club admin approves. */
export function matchdayExecution(): ExecutionRecord {
  const deps = depsFor();
  const id = submitExecution(executionRequest('matchday-0001', matchdayPlan()), deps).record?.executionId ?? '';
  decideExecution(id, approveNotice({ ...S.HEAD_COACH }), deps);
  decideExecution(id, approveNotice(), deps);
  return only(deps);
}

/** One execution of every outcome a publication can show, each in a store of its own. */
export function galleryExecutions(): Array<{ slug: string; record: ExecutionRecord }> {
  if (killSwitchEngaged()) throw new Error('The kill switch is engaged: release it, so every execution starts from the same state');
  const out: Array<{ slug: string; record: ExecutionRecord }> = [{ slug: 'completed', record: matchdayExecution() }];
  const run = (slug: string, body: (deps: ExecutionDeps) => void, over: Partial<ExecutionDeps> = {}) => {
    const deps = depsFor(over);
    try { body(deps); } finally { if (killSwitchEngaged()) releaseKillSwitch(); }
    out.push({ slug, record: only(deps) });
  };
  run('pending-approval', (deps) => {
    const id = submitExecution(executionRequest('awaiting-0001', matchdayPlan()), deps).record?.executionId ?? '';
    decideExecution(id, approveNotice({ ...SOUTH_CLUB_ADMIN }), deps);
  });
  run('rejected', (deps) => {
    const id = submitExecution(executionRequest('rejected-0001', matchdayPlan()), deps).record?.executionId ?? '';
    decideExecution(id, { ...approveNotice(), decision: 'REJECTED' }, deps);
  });
  run('failure', (deps) => { submitExecution(executionRequest('failure-0001', S.partialFailure()), deps); });
  run('cancelled', (deps) => {
    const id = submitExecution(executionRequest('cancel-0001', matchdayPlan()), deps).record?.executionId ?? '';
    cancelExecution(id, ANALYST, deps);
    cancelExecution(id, NORTH_OPERATOR, deps);
  });
  run('kill-switch', (deps) => {
    const id = submitExecution(executionRequest('kill-0003', matchdayPlan()), deps).record?.executionId ?? '';
    engageKillSwitch('LAB demonstration: engaged while an approval waits');
    decideExecution(id, approveNotice(), deps);
  });
  run('execution-limit', (deps) => { submitExecution(executionRequest('limit-0001', matchdayPlan(), NORTH_OPERATOR, { maxSteps: 2 }), deps); });
  return out;
}

const fresh = (dir: string) => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); };

/**
 * Every gallery execution prepared into `dir` with the rehearsal reference, and the room view production's
 * reader gives for it with that reference let through. SIMULATED: no entry in it is an approval.
 */
export function rehearsedRoomView(dir: string): PublicationsRoomView {
  const pub: PublicationDeps = { registry: platformAgentRegistry(), operations: labExecutionOperations() };
  fresh(dir);
  for (const { slug, record } of galleryExecutions()) {
    const r = preparePublication(record, pub, { reference: REHEARSAL_REFERENCE, dir, environment: 'LAB' });
    if (r.status !== 'PREPARED') throw new Error(`gallery ${slug}: ${r.code}: ${r.message}`);
  }
  return publicationsRoomView(pub.registry, readPublications(pub.registry, dir, { rehearsal: true }));
}

/** The demonstration, end to end, in `stagingDir` (emptied first). Returns every step; never approves. */
export function runPublicationDemonstration(stagingDir: string): DemoStep[] {
  const steps: DemoStep[] = [];
  const say = (step: string, result: DemoStep['result'], detail: string) => steps.push({ n: steps.length + 1, step, result, detail });
  const registry = platformAgentRegistry();
  const pub: PublicationDeps = { registry, operations: labExecutionOperations() };
  fresh(stagingDir);

  // 1–3: the execution, its record, the record verified
  const record = matchdayExecution();
  const tasks = record.run.tasks.map((t) => `${t.id} ${t.agent?.id ?? '-'} ${t.state}`).join(', ');
  say('AI-0.4 LAB execution: Tactical → Training → Club Manager', 'DONE', `${record.executionId} ${record.run.outcome}: ${tasks}`);
  const refusedSelf = record.log.find((e) => e.type === 'DECISION_REFUSED' && e.code === 'SELF_APPROVAL');
  say('Evidence generated', 'DONE', `record ${record.digest.slice(0, 16)}: ${record.run.trace.length} trace events, ${record.log.length} log events; self-approval ${refusedSelf ? 'refused and recorded' : 'NOT recorded'}`);
  const check = verifyExecution(record);
  say('Record verified by the Lab', check.ok ? 'VERIFIED' : 'REFUSED', check.ok ? 'digest, execution id, both chains, the log\'s commitment to the trace, the plan, every state' : check.reasons.join('; '));

  // 4: the candidate, checked by production's own verifier
  const candidate = executionPublicationCandidate(record, pub);
  if (!candidate.evidence) { say('Publication candidate', 'REFUSED', candidate.reasons.join('; ')); return steps; }
  const dossier = candidate.evidence;
  say('Publication candidate (v2), checked by production\'s verifier', 'VERIFIED', `${dossier.publicationId}, dossier digest ${dossier.digest}`);

  // 5: every way to publish it without the Platform Owner's approval, refused
  const shipped = readPublications(registry);
  const shown = shipped.state === 'VERIFIED' && shipped.publications.some((p) => p.entry.publicationId === dossier.publicationId);
  say('Blocked: the record this build ships holds no entry for it', shown ? 'REFUSED' : 'BLOCKED',
    shipped.state === 'VERIFIED' ? `${shipped.publications.length} approved publication(s); this candidate is not shown` : `${shipped.state}: ${shipped.reason}`);
  const loose = path.join(stagingDir, 'loose');
  fs.mkdirSync(loose, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'src', 'platform', 'agents', 'published', APPROVAL_RECORD_FILE), path.join(loose, APPROVAL_RECORD_FILE));
  fs.writeFileSync(path.join(loose, `${dossier.publicationId}.json`), `${JSON.stringify(dossier, null, 2)}\n`);
  const looseRead = readPublications(registry, loose);
  say('Blocked: its dossier placed beside the record without an entry', looseRead.state === 'VERIFIED' && looseRead.publications.length === 0 ? 'BLOCKED' : 'REFUSED',
    `${looseRead.state}, shown ${looseRead.state === 'VERIFIED' ? looseRead.publications.length : 0}, listed unapproved: ${looseRead.unapproved.join(', ') || 'none'}`);
  const forged = path.join(stagingDir, 'forged');
  fs.mkdirSync(forged, { recursive: true });
  fs.writeFileSync(path.join(forged, `${dossier.publicationId}.json`), `${JSON.stringify(dossier, null, 2)}\n`);
  fs.writeFileSync(path.join(forged, APPROVAL_RECORD_FILE), JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(loose, APPROVAL_RECORD_FILE), 'utf8')),
    publications: [{
      publicationId: dossier.publicationId, executionId: dossier.source.executionId, evidence: EXECUTION_EVIDENCE_CONTRACT,
      dossier: { file: `${dossier.publicationId}.json`, digest: dossier.digest }, reference: 'bibokh/familista-backend#1',
      approvedBy: 'bibokh',
    }],
  }));
  const forgedRead = readPublications(registry, forged);
  say('Blocked: an entry that types the owner\'s name as its approver', forgedRead.state === 'INVALID' ? 'BLOCKED' : 'REFUSED', forgedRead.state === 'INVALID' ? forgedRead.reason : 'it was accepted');
  // An execution still waiting for its approval, reported as completed with every task succeeded, and its digest
  // recomputed as anyone editing it could: the outcome it reports is not the one its chains record.
  const waiting = executionPublicationCandidate(galleryExecutions()[1].record, pub).evidence;
  const tampered = waiting && { ...waiting, run: { ...waiting.run, outcome: 'COMPLETED' as const, tasks: waiting.run.tasks.map((t) => ({ ...t, state: 'SUCCEEDED' as const })) } };
  const tamperedCheck = tampered ? verifyExecutionEvidence({ ...tampered, digest: executionEvidenceDigest(tampered) }, registry) : null;
  say(`Blocked: an execution still ${waiting?.run.outcome ?? '?'} reported as COMPLETED, its digest recomputed`, tamperedCheck && !tamperedCheck.evidence ? 'BLOCKED' : 'REFUSED',
    tamperedCheck?.reasons.join('; ') ?? 'no execution to tamper with');
  say('Blocked: the Lab has no approve or publish command, and refuses any flag that names an approver', 'BLOCKED',
    'npm run lab:publish -- approve | publish | prepare --approved-by … all exit 2 (lab/orchestrator/publish-cli.ts)');

  // 6–8: the owner-review boundary, rehearsed; the artifact; v2 validation
  const staged = path.join(stagingDir, 'rehearsal');
  const prepared = preparePublication(record, pub, { reference: REHEARSAL_REFERENCE, dir: staged, environment: 'LAB' });
  if (prepared.status !== 'PREPARED') { say('Prepare for review', 'REFUSED', `${prepared.code}: ${prepared.message}`); return steps; }
  say('Owner-review boundary: prepared for a pull request, approved by nobody', 'DONE',
    `entry ${JSON.stringify(prepared.entry)}; it takes effect only when the Platform Owner merges the pull request it names, and ${REHEARSAL_REFERENCE} cannot exist`);
  say('Publication artifact', 'DONE', prepared.files.map((f) => path.relative(stagingDir, f)).join(', '));
  say('V2 validation of the artifact, by production\'s reader', prepared.read.state === 'VERIFIED' ? 'VERIFIED' : 'REFUSED',
    prepared.read.state === 'VERIFIED' ? `record ${prepared.read.recordDigest.slice(0, 16)}, ${prepared.read.publications.length} publication(s), every check held` : prepared.read.reason);
  say('Blocked: production itself refuses a rehearsal entry', prepared.production.state === 'INVALID' ? 'BLOCKED' : 'REFUSED',
    prepared.production.state === 'INVALID' ? prepared.production.reason : 'it was accepted');

  // 9: what the room would draw, were it approved
  const view = publicationsRoomView(registry, prepared.read);
  const p = view.publications[0];
  say('Read-only room presentation (SIMULATED: as if the pull request were merged)', 'SIMULATED',
    p ? `${p.publicationId} ${p.evidence.run.outcome}: ${p.evidence.run.tasks.length} tasks on ${p.agents.map((a) => a.id).join(', ')}; ${p.evidence.decisions.length} decisions, ${p.evidence.log.length} log events; registry ${p.registry.matches ? 'current' : 'changed'}` : 'nothing to show');

  // 10: integrity and compatibility
  const v1 = readOrchestrationEvidence();
  const v1InV2 = v1.state === 'VERIFIED' ? verifyExecutionEvidence(v1.evidence, registry) : null;
  const v2InV1 = verifyOrchestrationEvidence(dossier);
  const v3 = verifyExecutionEvidence({ ...dossier, contract: 'familista.orchestration-evidence/v3' }, registry);
  const fine = v1.state === 'VERIFIED' && !!v1InV2 && !v1InV2.evidence && !v2InV1.evidence && !v3.evidence;
  say('Integrity and compatibility', fine ? 'VERIFIED' : 'REFUSED',
    `v1 evidence ${v1.state}${v1.state === 'VERIFIED' ? ` (${v1.evidence.digest.slice(0, 16)}, ${v1.evidence.runs.length} runs)` : ''}; v1 offered as a publication: ${v1InV2?.reasons[0] ?? '-'}; v2 offered as v1: ${v2InV1.reasons[0] ?? '-'}; v3: ${v3.reasons[0] ?? '-'}`);
  return steps;
}
