/**
 * Global Multi-Agent Intelligence, AI-0.5 — approved LAB execution evidence (v2).
 *
 * What a LAB execution must be, and what must have happened, before the AI Agents Operations Room shows it:
 *
 *  1. Valid v2: every gallery execution (one per outcome) projects into a dossier production's verifier accepts.
 *  2. Invalid, corrupted, modified: one change at a time — a state, a field, a byte of a chain, the digest, the
 *     log's commitment, a forged outcome with every hash recomputed — and each is refused for its own reason.
 *  3. Approval: a dossier no entry lists is never read or shown; an entry that names an approver is refused; a
 *     duplicate, a conflict, another repository's pull request and a rehearsal are refused; the Lab cannot approve.
 *  4. Governance: self-approval, a medical approval, a kill-switch refusal that did not halt — refused.
 *  5. Privacy and tenancy: no health field, no real-looking id, no club that is not `lab-…`; no club role reaches it.
 *  6. Versions: v1 is still the workflow evidence and verifies unchanged; v1, v3 and anything else offered as a
 *     publication are refused by name.
 *  7. The endpoint: the platform owner's alone, uncached, read-only, as its contract says.
 *  8. Isolation: production reads files and runs nothing; the Lab's tool writes only where it is told, in the Lab.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

type Row = Record<string, any>;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
};
jest.mock('../src/config/database', () => ({ prisma: db, basePrisma: db }));

let actingAs: Row | null = null;
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req: Row, res: Row, next: () => void) => {
    if (!actingAs) { res.status(401).json({ success: false, message: 'unauthenticated' }); return; }
    req.user = actingAs;
    next();
  },
  onIdentityForgotten: () => () => undefined,
  sessionStillValid: async () => true,
}));

import { platformAgentRegistry, PLATFORM_AGENT_MANIFESTS } from '../src/platform/agents/catalog';
import { AgentRegistry } from '../src/platform/agents/registry';
import { chainHash, GENESIS } from '../src/platform/agents/trace-chain';
import {
  APPROVAL_RECORD_CONTRACT, APPROVAL_RECORD_FILE, APPROVAL_RULE, EXECUTION_EVIDENCE_CONTRACT, EXECUTION_GENESIS, executionEvidenceDigest,
  publicationIdFor, publicationsRoomView, PUBLICATION_CHECKS, PUBLICATIONS_DIR, readPublications, readShippedPublications,
  REHEARSAL_REFERENCE, resetPublications, verifyApprovalRecord, verifyExecutionEvidence, SUPPORTED_EVIDENCE_CONTRACTS,
  type ApprovalEntry, type ExecutionEvidence,
} from '../src/platform/agents/execution-evidence';
import { readOrchestrationEvidence, verifyOrchestrationEvidence } from '../src/platform/agents/orchestration-evidence';
import { OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
import agentsRoomRoutes from '../src/routes/agents-room.routes';
import { labExecutionOperations } from '../lab/orchestrator/operations';
import { publicationCandidate, verifyExecution, EXECUTION_CONTRACT, EXECUTION_GENESIS as LAB_GENESIS, executionIdFor } from '../lab/orchestrator/execution';
import { buildProvenance, executionPublicationCandidate, preparePublication, toExecutionEvidence, type ProvenanceClaim, type PublicationDeps } from '../lab/orchestrator/publication';
import { provenanceFileFor } from '../src/platform/agents/execution-provenance';
import { galleryExecutions, matchdayExecution, rehearsedRoomView, runPublicationDemonstration } from '../lab/orchestrator/publication-demo';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const registry = platformAgentRegistry();
const pub: PublicationDeps = { registry, operations: labExecutionOperations() };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

let gallery: Array<{ slug: string; record: ReturnType<typeof matchdayExecution> }>;
const dossiers = new Map<string, ExecutionEvidence>();
beforeAll(() => {
  gallery = galleryExecutions();
  for (const { slug, record } of gallery) {
    const c = executionPublicationCandidate(record, pub);
    if (!c.evidence) throw new Error(`${slug}: ${c.reasons.join('; ')}`);
    dossiers.set(slug, c.evidence);
  }
});
const dossier = (slug = 'completed') => clone(dossiers.get(slug) as ExecutionEvidence);
/** Re-seal after an edit, as anyone editing a dossier could: the digest is unkeyed. */
const resign = (e: ExecutionEvidence): ExecutionEvidence => ({ ...e, digest: executionEvidenceDigest(e) });
/** Re-chain after an edit, every hash recomputed: what is left to catch it is coherence, not integrity. */
function rechain<T extends { seq: number; prev: string; hash: string }>(events: T[], genesis: string): T[] {
  let prev = genesis;
  return events.map((e, i) => {
    const base = { ...e, seq: i + 1, prev };
    const hash = chainHash(base as never);
    prev = hash;
    return { ...base, hash };
  });
}
const verify = (e: unknown) => verifyExecutionEvidence(e, registry);
const reasonOf = (e: unknown) => verify(e).reasons.join('; ');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'familista-pub-'));
const entryFor = (e: ExecutionEvidence, reference = 'bibokh/familista-backend#140'): ApprovalEntry => ({
  publicationId: e.publicationId, executionId: e.source.executionId, evidence: EXECUTION_EVIDENCE_CONTRACT,
  dossier: { file: `${e.publicationId}.json`, digest: e.digest }, reference,
});
/**
 * A provenance claim of the right shape. The server checks a provenance record's shape and that it describes its
 * dossier; whether the claim is TRUE is the publication gate's to establish (tests/publication-provenance.unit.test.ts).
 */
const CLAIM: ProvenanceClaim = {
  definition: { name: 'matchday-staff-notice', path: 'lab/orchestrator/definitions/matchday-staff-notice.json', digest: 'd'.repeat(64) },
  source: { revision: 'c'.repeat(40), digest: 'e'.repeat(64), files: 26, packages: [{ name: 'zod', version: '4.6.7' }] }, steps: 2,
};
function stage(files: { dossiers?: ExecutionEvidence[]; entries?: unknown[]; record?: unknown }): string {
  const dir = tmp();
  for (const d of files.dossiers ?? []) {
    fs.writeFileSync(path.join(dir, `${d.publicationId}.json`), JSON.stringify(d));
    fs.writeFileSync(path.join(dir, provenanceFileFor(d.publicationId)), JSON.stringify(buildProvenance(d, CLAIM)));
  }
  const record = files.record ?? { contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: files.entries ?? [] };
  fs.writeFileSync(path.join(dir, APPROVAL_RECORD_FILE), JSON.stringify(record));
  return dir;
}

// ── 1. valid v2 ──────────────────────────────────────────────────────────────
describe('1. a verified LAB execution projects into v2 evidence production accepts', () => {
  it('every gallery execution, one per outcome, is a candidate, and its record verifies by the Lab\'s own rule', () => {
    expect(gallery.map((g) => g.record.run.outcome)).toEqual(['COMPLETED', 'AWAITING_APPROVAL', 'PARTIAL', 'PARTIAL', 'CANCELLED', 'HALTED', 'HALTED']);
    for (const { slug, record } of gallery) {
      expect([slug, verifyExecution(record).ok]).toEqual([slug, true]);
      expect([slug, verify(dossiers.get(slug)).reasons]).toEqual([slug, []]);
    }
  });

  it('the matchday dossier records what the owner asked to see: Tactical → Training → Club Manager, decided and chained', () => {
    const e = dossier();
    expect(e.run.tasks.map((t) => `${t.id}:${t.agent?.id}:${t.state}`)).toEqual([
      'opponent:club.tactical:SUCCEEDED', 'session:club.training:SUCCEEDED', 'briefing:club.club-manager:SUCCEEDED', 'notice:club.club-manager:SUCCEEDED',
    ]);
    expect(e.routing.map((r) => r.selected)).toEqual(['club.tactical', 'club.training', 'club.club-manager', 'club.club-manager']);
    expect(e.run.tasks.flatMap((t) => t.inputs.map((i) => `${i.from}→${t.id}:${i.status}`))).toEqual(expect.arrayContaining(['opponent→session:ACCEPTED']));
    expect(e.decisions).toEqual([{ taskId: 'notice', decision: 'APPROVED', byRole: 'CLUB_ADMIN', accepted: true }]);
    expect(e.log.map((l) => l.type)).toEqual(['EXECUTION_SUBMITTED', 'OPERATOR_AUTHORIZED', 'PLAN_VALIDATED', 'AGENTS_ASSIGNED', 'RUN_ADVANCED', 'DECISION_REFUSED', 'DECISION_SUBMITTED', 'RUN_ADVANCED']);
    expect(e.log.find((l) => l.type === 'DECISION_REFUSED')?.code).toBe('SELF_APPROVAL');
    expect(e.publicationId).toBe(publicationIdFor(e.source.executionId, e.source.recordDigest));
    expect(e.source.executionId).toBe(executionIdFor(e.operator.userId, e.source.requestId));
  });

  it('is deterministic: the same execution again is the same dossier, byte for byte; the rehearsed room view is the committed fixture', () => {
    expect(JSON.stringify(executionPublicationCandidate(matchdayExecution(), pub).evidence)).toBe(JSON.stringify(dossier()));
    const dir = tmp();
    const view = rehearsedRoomView(dir);
    expect(`${JSON.stringify(view, null, 2)}\n`).toBe(read('tests/fixtures/agents/publications-room-view.json'));
    // Regenerate with: FAMILISTA_ENV=LAB npm run lab:publish -- gallery --out tests/fixtures/agents/publications-room-view.json
  });

  it('the Lab and production share one id rule and one log genesis', () => {
    expect(EXECUTION_CONTRACT).toBe('familista.lab-execution/v1');
    expect(LAB_GENESIS).toBe(EXECUTION_GENESIS);
    expect(EXECUTION_GENESIS).not.toBe(GENESIS);
  });
});

// ── 2. invalid, corrupted, modified ──────────────────────────────────────────
describe('2. one change at a time, and each is refused for its own reason', () => {
  it('invalid states and outcomes the vocabulary does not hold', () => {
    const a = dossier(); (a.run.tasks[0] as Row).state = 'DONE';
    expect(reasonOf(resign(a))).toMatch(/^shape: run\.tasks\.0\.state/);
    const b = dossier(); (b.run as Row).outcome = 'BLOCKED';
    expect(reasonOf(resign(b))).toMatch(/^shape: run\.outcome/);
    const c = dossier(); (c.run as Row).stop = { outcome: 'PAUSED', code: 'KILL_SWITCH', message: 'x' };
    expect(reasonOf(resign(c))).toMatch(/^shape: run\.stop\.outcome/);
  });

  it('a state the trace does not record, even with every hash recomputed', () => {
    const e = dossier('pending-approval');
    e.run.tasks[3].state = 'SUCCEEDED';
    expect(reasonOf(resign(e))).toContain('coherence: task notice is shown as SUCCEEDED; its trace records AWAITING_APPROVAL');
  });

  it('a self-reported outcome is never taken on its word: AWAITING_APPROVAL relabelled COMPLETED, re-sealed', () => {
    const e = dossier('pending-approval');
    e.run.outcome = 'COMPLETED';
    e.run.tasks = e.run.tasks.map((t) => ({ ...t, state: 'SUCCEEDED' as const }));
    const r = reasonOf(resign(e));
    expect(r).toContain('coherence: its outcome is not the one its trace settled on');
    expect(r).toContain('log: its last step does not commit to the run as it settled');
  });

  it('a forged settlement, both chains recomputed end to end, still disagrees with what the trace recorded of each task', () => {
    const e = dossier('pending-approval');
    const settled = e.run.trace.map((x) => x.type).lastIndexOf('RUN_SETTLED');
    e.run.trace[settled] = { ...e.run.trace[settled], code: 'COMPLETED' };
    e.run.trace = rechain(e.run.trace, GENESIS);
    e.run.digest = e.run.trace[e.run.trace.length - 1].hash;
    e.run.outcome = 'COMPLETED';
    e.log = e.log.map((l) => (l.type === 'RUN_ADVANCED' ? { ...l, code: 'COMPLETED', detail: l.detail.replace(/^run [0-9a-f]{64}:/, `run ${e.run.digest}:`) } : l));
    e.log = rechain(e.log, EXECUTION_GENESIS);
    const r = verify(resign(e));
    expect(r.evidence).toBeNull();
    // Both chains are whole and committed; what is left is that the tasks it shows do not add up to what it claims.
    expect(r.reasons).toEqual(['coherence: its outcome does not follow from its tasks\' states']);
  });

  it('corrupted: the digest, a removed field, an added field, an input or output smuggled in', () => {
    const a = dossier(); a.digest = '0'.repeat(64);
    expect(reasonOf(a)).toBe('integrity: the dossier\'s digest is not the digest of its content');
    const b = dossier() as Row; delete b.log;
    expect(reasonOf(b)).toMatch(/^shape: log/);
    const c = dossier() as Row; c.approvedBy = 'bibokh';
    expect(reasonOf(c)).toMatch(/^shape: \(root\)/);
    const d = dossier() as Row; d.run.tasks[0].output = { opponent: 'lab-club-south' };
    expect(reasonOf(d)).toMatch(/^shape: run\.tasks\.0/);
    const f = dossier() as Row; f.run.tasks[0].input = { any: 1 };
    expect(reasonOf(f)).toMatch(/^shape: run\.tasks\.0/);
  });

  it('modified traces: a detail, a removed event, a reordered pair, a forged head', () => {
    const a = dossier(); a.run.trace[2] = { ...a.run.trace[2], detail: 'routed elsewhere' };
    expect(reasonOf(resign(a))).toContain('trace: the run trace breaks at event 3');
    const b = dossier(); b.run.trace.splice(4, 1);
    expect(reasonOf(resign(b))).toContain('trace: the run trace breaks at event 5');
    const c = dossier(); [c.run.trace[3], c.run.trace[4]] = [c.run.trace[4], c.run.trace[3]];
    expect(reasonOf(resign(c))).toContain('trace: the run trace breaks at event 4');
    const d = dossier(); d.run.digest = d.run.trace[1].hash;
    expect(reasonOf(resign(d))).toContain('trace: the run id is not its trace\'s head');
  });

  it('a modified execution log: a detail, a removed event, a commitment to another run', () => {
    const a = dossier(); a.log[1] = { ...a.log[1], detail: 'anyone may submit' };
    expect(reasonOf(resign(a))).toContain('log: the execution log breaks at event 2');
    const b = dossier(); b.log = rechain(b.log.filter((l) => l.type !== 'OPERATOR_AUTHORIZED'), EXECUTION_GENESIS);
    expect(reasonOf(resign(b))).toContain('log: it does not open with the submission, authorization, validation and assignment an execution records');
    const c = dossier();
    c.log = rechain(c.log.map((l) => (l.type === 'RUN_ADVANCED' ? { ...l, detail: l.detail.replace(/^run [0-9a-f]{64}:/, `run ${'a'.repeat(64)}:`) } : l)), EXECUTION_GENESIS);
    expect(reasonOf(resign(c))).toContain('log: a step of it commits to no point of this run\'s trace');
  });

  it('ids that do not derive from what it records: the execution, the publication, the context', () => {
    const a = dossier(); a.source.requestId = 'matchday-9999';
    expect(reasonOf(resign(a))).toContain('integrity: the execution id is not its operator\'s and request\'s');
    const b = dossier(); b.publicationId = 'pub-000000000000000000000000';
    expect(reasonOf(resign(b))).toContain('integrity: the publication id does not derive from its execution and record');
    const c = dossier(); c.context.policyDigest = 'b'.repeat(64);
    expect(reasonOf(resign(c))).toContain('integrity: the security context digest is not the digest of its parts');
  });

  it('routing that is not what ran: another agent selected, a ranked agent passed over', () => {
    const a = dossier(); a.routing[0].selected = 'club.training';
    expect(reasonOf(resign(a))).toContain('coherence: task opponent is not what its routing decision selected');
    const b = dossier(); b.routing[0].passedOver.push({ agentId: 'club.tactical', reason: 'domain TACTICS, not TACTICS' });
    expect(reasonOf(resign(b))).toContain('coherence: task opponent passed over an agent its routing ranked');
  });
});

// ── 3. the approval boundary ─────────────────────────────────────────────────
describe('3. nothing is shown that the Platform Owner did not approve by merging it', () => {
  it('the record this build ships verifies, holds no entry, and names nobody', () => {
    const shipped = JSON.parse(read('src/platform/agents/published/approvals.json'));
    expect(shipped).toEqual({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: [] });
    resetPublications();
    expect(readShippedPublications(registry)).toEqual({ state: 'VERIFIED', recordDigest: expect.any(String), publications: [], unapproved: [] });
    expect(fs.readdirSync(PUBLICATIONS_DIR).sort()).toEqual([APPROVAL_RECORD_FILE]);
    expect(read('src/platform/agents/published/approvals.json')).not.toContain(REHEARSAL_REFERENCE);
  });

  it('missing approval: a dossier beside the record that no entry lists is never read and never shown, only counted', () => {
    const e = dossier();
    const dir = stage({ dossiers: [e], entries: [] });
    const r = readPublications(registry, dir);
    expect(r).toMatchObject({ state: 'VERIFIED', publications: [], unapproved: [e.publicationId, `${e.publicationId}.provenance`] });
    const v = publicationsRoomView(registry, r);
    expect(v.publications).toEqual([]);
    expect(JSON.stringify(v)).not.toContain(e.run.digest);
  });

  it('approved: listed once with its digest, for a pull request of this repository, it verifies and is shown', () => {
    const e = dossier();
    const r = readPublications(registry, stage({ dossiers: [e], entries: [entryFor(e)] }));
    expect(r.state).toBe('VERIFIED');
    const v = publicationsRoomView(registry, r);
    expect(v.publications.map((p) => [p.publicationId, p.reference, p.dossierDigest])).toEqual([[e.publicationId, 'bibokh/familista-backend#140', e.digest]]);
    expect(OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/agents/publications')!.schema.safeParse(clone(v)).success).toBe(true);
  });

  it.each(['approvedBy', 'approver', 'owner', 'by', 'signedBy', 'signature', 'approvedAt', 'userId'])(
    'forged owner identity: an entry that claims who approved it (%s) is refused, and nothing is shown', (field) => {
      const e = dossier();
      const r = readPublications(registry, stage({ dossiers: [e], entries: [{ ...entryFor(e), [field]: 'bibokh' }] }));
      expect(r.state).toBe('INVALID');
      expect(r.state === 'INVALID' && r.reason).toContain(`identity: an approval entry claims who approved it (${field})`);
      expect(publicationsRoomView(registry, r).publications).toEqual([]);
    });

  it('forged owner identity: the LAB Platform Owner operator\'s name proves nothing, anywhere', () => {
    // The AI-0.4 roster names a SUPER_ADMIN operator; that name is not authenticated and is never an approval.
    const e = dossier();
    const r = verifyApprovalRecord({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: [{ ...entryFor(e), operator: 'lab-operator-platform' }] });
    expect(r.reasons[0]).toContain('identity');
    const s = read('src/platform/agents/execution-evidence.ts');
    expect(s).not.toMatch(/lab-operator-platform|SUPER_ADMIN|PLATFORM_OWNER/);
  });

  it('duplicate publication: one execution twice, one publication twice, one dossier twice', () => {
    const e = dossier();
    const twice = verifyApprovalRecord({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: [entryFor(e), entryFor(e, 'bibokh/familista-backend#141')] });
    expect(twice.record).toBeNull();
    expect(twice.reasons).toEqual(expect.arrayContaining([`approval record: publication ${e.publicationId} is approved twice`, `approval record: execution ${e.source.executionId} is approved twice`]));
    const dir = tmp();
    const first = preparePublication(gallery[0].record, pub, { reference: 'bibokh/familista-backend#140', dir, environment: 'LAB', provenance: CLAIM });
    expect(first.status).toBe('PREPARED');
    const again = preparePublication(gallery[0].record, pub, { reference: 'bibokh/familista-backend#141', dir, environment: 'LAB', provenance: CLAIM });
    expect(again).toMatchObject({ status: 'REFUSED', code: 'ALREADY_PUBLISHED' });
  });

  it('conflicting publication ids: an entry for another dossier, a file named for another publication, a digest not approved', () => {
    const a = dossier(), b = dossier('cancelled');
    const swapped = readPublications(registry, stage({ dossiers: [a, b], entries: [{ ...entryFor(a), dossier: { file: `${b.publicationId}.json`, digest: a.digest } }] }));
    expect(swapped.state === 'INVALID' && swapped.reason).toContain(`approval record: ${a.publicationId} names another publication's dossier`);
    const dir = stage({ dossiers: [a], entries: [{ ...entryFor(a), dossier: { file: `${a.publicationId}.json`, digest: b.digest } }] });
    const wrong = readPublications(registry, dir);
    expect(wrong.state === 'INVALID' && wrong.reason).toContain('its dossier is not the one approved');
    const other = readPublications(registry, stage({ dossiers: [a], entries: [{ ...entryFor(a), executionId: b.source.executionId }] }));
    expect(other.state === 'INVALID' && other.reason).toContain('its dossier is another publication\'s');
    // A file planted under the approved name is not the approved dossier.
    fs.writeFileSync(path.join(dir, `${a.publicationId}.json`), JSON.stringify(b));
    expect(readPublications(registry, dir).state).toBe('INVALID');
  });

  it('unauthorized attempts: another repository, a rehearsal, outside the Lab, an unverified record', () => {
    const e = dossier();
    const elsewhere = verifyApprovalRecord({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: [entryFor(e, 'someone/familista-backend#140')] });
    expect(elsewhere.reasons[0]).toMatch(/^approval record: publications\.0\.reference/);
    const rehearsal = readPublications(registry, stage({ dossiers: [e], entries: [entryFor(e, REHEARSAL_REFERENCE)] }));
    expect(rehearsal.state === 'INVALID' && rehearsal.reason).toContain('was prepared in a rehearsal, and a rehearsal is never an approval');
    expect(preparePublication(gallery[0].record, pub, { reference: 'bibokh/familista-backend#140', dir: tmp(), environment: 'PRODUCTION', provenance: CLAIM }))
      .toMatchObject({ status: 'REFUSED', code: 'ENVIRONMENT_NOT_LAB' });
    expect(preparePublication(gallery[0].record, pub, { reference: 'bibokh/other#1', dir: tmp(), environment: 'LAB', provenance: CLAIM })).toMatchObject({ status: 'REFUSED', code: 'REFERENCE_INVALID' });
    const tampered = { ...clone(gallery[0].record), run: { ...clone(gallery[0].record.run), outcome: 'FAILED' } };
    expect(preparePublication(tampered, pub, { reference: 'bibokh/familista-backend#140', dir: tmp(), environment: 'LAB', provenance: CLAIM })).toMatchObject({ status: 'REFUSED', code: 'RECORD_INVALID' });
  });

  it('a malformed, oversized or missing record shows nothing', () => {
    const e = dossier();
    const bad = stage({ dossiers: [e] });
    fs.writeFileSync(path.join(bad, APPROVAL_RECORD_FILE), '{ not json');
    expect(readPublications(registry, bad)).toMatchObject({ state: 'INVALID', reason: 'approval record: A publication file is not valid JSON.' });
    fs.writeFileSync(path.join(bad, APPROVAL_RECORD_FILE), ' '.repeat(70 * 1024));
    expect(readPublications(registry, bad)).toMatchObject({ state: 'INVALID' });
    expect(readPublications(registry, tmp())).toMatchObject({ state: 'NOT_GENERATED' });
    const big = stage({ dossiers: [], entries: [entryFor(e)] });
    fs.writeFileSync(path.join(big, `${e.publicationId}.json`), ' '.repeat(1024 * 1024 + 1));
    expect(readPublications(registry, big)).toMatchObject({ state: 'INVALID' });
  });

  it('prepare writes the dossier and the entry for the pull request named, and production reads them back', () => {
    const dir = tmp();
    const r = preparePublication(gallery[0].record, pub, { reference: 'bibokh/familista-backend#140', dir, environment: 'LAB', provenance: CLAIM });
    if (r.status !== 'PREPARED') throw new Error(r.message);
    expect(fs.readdirSync(dir).sort()).toEqual([APPROVAL_RECORD_FILE, `${r.entry.publicationId}.json`, provenanceFileFor(r.entry.publicationId)].sort());
    expect(JSON.parse(fs.readFileSync(path.join(dir, APPROVAL_RECORD_FILE), 'utf8')).publications).toEqual([r.entry]);
    expect(Object.keys(r.entry).sort()).toEqual(['dossier', 'evidence', 'executionId', 'publicationId', 'reference']);
    expect(readPublications(registry, dir)).toMatchObject({ state: 'VERIFIED', publications: [{ entry: r.entry }] });
  });
});

// ── 4. governance ────────────────────────────────────────────────────────────
describe('4. governance the dossier must show it kept', () => {
  it('the submitter deciding their own approval is refused', () => {
    const e = dossier();
    const i = e.log.findIndex((l) => l.type === 'DECISION_SUBMITTED');
    e.log[i] = { ...e.log[i], detail: 'approved on "notice" by HEAD_COACH lab-user-head-coach' };
    e.log = rechain(e.log, EXECUTION_GENESIS);
    expect(reasonOf(resign(e))).toContain('governance: the operator who submitted it decided one of its approvals');
  });

  it('a decision by a role that may not decide it, and a medical action approved, are refused', () => {
    const a = dossier();
    const t = a.run.tasks.find((x) => x.approval)!;
    t.approval!.decidedByRole = 'ANALYST';
    expect(reasonOf(resign(a))).toContain(`governance: task ${t.id} was decided by a role that may not decide it`);
    const b = dossier();
    const m = b.run.tasks.find((x) => x.approval)!;
    m.recordClass = 'MEDICAL';
    expect(reasonOf(resign(b))).toContain(`governance: task ${m.id} is a medical action, and no role may approve one`);
  });

  it('kill switch: the halted execution verifies; a kill-switch refusal that did not halt it is refused', () => {
    const e = dossier('kill-switch');
    expect(e.run.stop).toMatchObject({ outcome: 'HALTED', code: 'KILL_SWITCH' });
    expect(e.log.map((l) => `${l.type}:${l.code ?? ''}`)).toEqual(expect.arrayContaining(['DECISION_REFUSED:KILL_SWITCH', 'EXECUTION_HALTED:KILL_SWITCH']));
    expect(verify(e).reasons).toEqual([]);
    const f = dossier('kill-switch');
    f.run.stop = { ...f.run.stop!, code: 'EXECUTION_LIMIT' };
    const r = reasonOf(resign(f));
    expect(r).toContain('governance: a decision refused by the kill switch did not halt it');
    expect(r).toContain('coherence: the stop it shows is not the one its chains record');
  });

  it('CANCELLED and HALTED: both verify, and neither may be shown as the other or without its stop', () => {
    for (const slug of ['cancelled', 'kill-switch', 'execution-limit']) expect([slug, verify(dossier(slug)).reasons]).toEqual([slug, []]);
    const a = dossier('cancelled'); a.run.outcome = 'HALTED'; a.run.stop = { ...a.run.stop!, outcome: 'HALTED' };
    expect(verify(resign(a)).evidence).toBeNull();
    const b = dossier('execution-limit'); b.run.stop = null;
    expect(reasonOf(resign(b))).toContain('coherence: the stop it shows is not the one its chains record');
    const c = dossier('completed'); c.run.tasks[3].state = 'CANCELLED';
    expect(reasonOf(resign(c))).toContain('coherence: a task is cancelled in a run that was not stopped');
  });
});

// ── 5. privacy and tenancy ───────────────────────────────────────────────────
describe('5. synthetic, no health data, no other tenant', () => {
  it('medical-data leakage: a health field anywhere is refused, and no dossier carries an input or output', () => {
    const e = dossier() as Row;
    e.routing[0].passedOver[0] = { ...e.routing[0].passedOver[0], injuryStatus: 'OUT' };
    expect(reasonOf(resign(e as ExecutionEvidence))).toMatch(/^shape/);
    // Where the schema leaves free text, a health field cannot be smuggled as a key; as a value it is just a word.
    for (const d of dossiers.values()) for (const t of d.run.tasks) expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['output', 'input', 'inputs.value']));
  });

  it('a real-looking id or address is refused; so is a club that is not a lab reference', () => {
    const a = dossier(); a.run.trace[0] = { ...a.run.trace[0], detail: 'plan for coach@example.com' };
    a.run.trace = rechain(a.run.trace, GENESIS); a.run.digest = a.run.trace[a.run.trace.length - 1].hash;
    expect(reasonOf(resign(a))).toContain('synthetic: it holds what looks like a real person\'s address or a real id');
    const b = dossier(); (b.plan.scope as Row).clubId = '3f8a2c1e-0000-4000-8000-000000000001';
    expect(reasonOf(resign(b))).toMatch(/^shape: plan\.scope/);
  });

  it('identity: an agent or tool this server does not register is refused', () => {
    const smaller = new AgentRegistry();
    for (const m of PLATFORM_AGENT_MANIFESTS) if (m.id !== 'club.training') smaller.register(m);
    expect(verifyExecutionEvidence(dossier(), smaller).reasons.join('; ')).toContain('identity: it names agents this server does not register (club.training)');
    const t = dossier(); t.operations[0].tool = 'launchRocket';
    expect(reasonOf(resign(t))).toContain('identity: it names a tool this server does not register');
  });
});

// ── 6. versions ──────────────────────────────────────────────────────────────
describe('6. versions: v1 unchanged, and only v2 is a publication', () => {
  it('v1 is still the workflow evidence and verifies byte for byte as it was', () => {
    const v1 = readOrchestrationEvidence();
    expect(v1.state).toBe('VERIFIED');
    expect(v1.state === 'VERIFIED' && v1.evidence.digest.slice(0, 16)).toBe('b777313d0dfcc39e');
    expect(SUPPORTED_EVIDENCE_CONTRACTS).toEqual(['familista.orchestration-evidence/v1', 'familista.orchestration-evidence/v2']);
    // AI-0.4's v1 projection of a record still works where v1 can say it, and still refuses a stopped run.
    expect(publicationCandidate(gallery[0].record, pub.operations).reasons).toEqual([]);
    expect(publicationCandidate(gallery[4].record, pub.operations).reasons[0]).toContain('a stopped run stays in the Lab');
  });

  it.each(['familista.orchestration-evidence/v1', 'familista.orchestration-evidence/v3', 'familista.orchestration-evidence/v99'])(
    'unsupported version: %s offered as a publication is refused by name', (contract) => {
      expect(reasonOf({ ...dossier(), contract })).toBe(`version: ${contract} is not a publication; this server reads publications as ${EXECUTION_EVIDENCE_CONTRACT}`);
    });

  it('v2 offered as v1 is refused by v1, and an entry approving another version or another record version is refused', () => {
    expect(verifyOrchestrationEvidence(dossier()).reasons[0]).toMatch(/^shape: contract/);
    const e = dossier();
    expect(verifyApprovalRecord({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: [{ ...entryFor(e), evidence: 'familista.orchestration-evidence/v3' }] }).record).toBeNull();
    expect(verifyApprovalRecord({ contract: 'familista.evidence-approvals/v2', rule: APPROVAL_RULE, publications: [] }).record).toBeNull();
    expect(verifyApprovalRecord({ contract: APPROVAL_RECORD_CONTRACT, rule: 'anything goes', publications: [] }).record).toBeNull();
  });
});

// ── 7. the endpoint ──────────────────────────────────────────────────────────
describe('GET /system/agents/publications', () => {
  const app = () => {
    const a = express();
    a.use('/system/agents', agentsRoomRoutes);
    a.use((err: Row, _req: Row, res: Row, _next: unknown) => res.status(err?.statusCode || 500).json({ success: false, message: err?.message }));
    return a;
  };
  const URL = '/system/agents/publications';
  afterEach(() => { actingAs = null; });

  it('answers the platform owner, uncached, exactly as its contract says: what this build approved, which is nothing', async () => {
    resetPublications();
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get(URL);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const contract = OWNER_API_CONTRACTS.find((c) => c.endpoint === URL);
    expect(contract?.consumer).toBe('public/agents-room/agents-room.js');
    expect(contract!.schema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'VERIFIED', contract: EXECUTION_EVIDENCE_CONTRACT, rule: APPROVAL_RULE, publications: [], unapproved: [] });
    expect(res.body.data.checks.map((c: { id: string }) => c.id)).toEqual(PUBLICATION_CHECKS.map((c) => c.id));
    expect(res.body.data.agent).toBeUndefined();
  });

  it('the contract holds for every outcome the room can be sent, and refuses an input or output in it', () => {
    const schema = OWNER_API_CONTRACTS.find((c) => c.endpoint === URL)!.schema;
    const v = JSON.parse(read('tests/fixtures/agents/publications-room-view.json'));
    expect(schema.safeParse(v).success).toBe(true);
    v.publications[0].evidence.run.tasks[0].output = { any: 'thing' };
    expect(schema.safeParse(v).success).toBe(false);
  });

  it.each(['CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'PARENT', 'PLAYER'])(
    'cross-tenant: a club %s reaches none of it', async (role) => {
      actingAs = { id: `u-${role}`, clubId: 'c-1', role };
      const res = await request(app()).get(URL);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/digest|publications|trace|lab-club|approval/);
    });

  it('an unauthenticated request is refused', async () => {
    expect((await request(app()).get(URL)).status).toBe(401);
  });

  it('there is no way to publish, approve or write anything through it', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app())[verb](URL).send({ publicationId: 'pub-000000000000000000000000', approvedBy: 'bibokh' });
      expect([verb, res.status]).toEqual([verb, 404]);
    }
    const src = read('src/routes/agents-room.routes.ts');
    expect(src).not.toMatch(/router\.(post|put|patch|delete)\(/);
    expect(src.indexOf("router.get('/publications'")).toBeLessThan(src.indexOf("router.get('/:agentId'"));
    const manifest = JSON.parse(read('src/cyber-defense/generated/security-manifest.json'));
    expect(JSON.stringify(manifest)).toContain('"GET /system/agents/publications":"platform-owner"');
  });
});

// ── 8. isolation ─────────────────────────────────────────────────────────────
describe('8. production reads approved files and runs nothing; the Lab prepares and cannot approve', () => {
  it('the reader reaches no database, provider, network or lab module, writes nothing, and never lets a rehearsal through', () => {
    const f = 'src/platform/agents/execution-evidence.ts';
    const src = read(f);
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => !['fs', 'path', 'zod', '../../security/ai-read-policy', '../intelligence/agents', './execution-provenance', './orchestration-evidence', './registry', './trace-chain'].includes(i))).toEqual([]);
    expect(/lab\/|child_process|\bfetch\(|https?\.request\(|\beval\(|new Function|require\(/.test(src.replace(/\/\/.*$/gm, ''))).toBe(false);
    expect(/writeFile|appendFile|mkdir|unlink|rmSync|renameSync/.test(src)).toBe(false);
    // Only the Lab's read-back passes `rehearsal`; what serves the room reads with the defaults.
    expect(src).toMatch(/export function readShippedPublications\(registry: AgentRegistry\): PublicationsRead \{\n {2}if \(!cached\) cached = readPublications\(registry\);/);
    expect(read('src/routes/agents-room.routes.ts')).not.toContain('rehearsal');
  });

  it('the build ships the approval record beside the reader, code-owned; the tool is a lab script only', () => {
    expect(read('scripts/copy-runtime-assets.js')).toContain("['src/platform/agents/published', 'dist/platform/agents/published']");
    const owners = read('.github/CODEOWNERS');
    expect(owners).toMatch(/^\/src\/platform\/agents\/published\/\s+@bibokh$/m);
    expect(owners).toMatch(/^\/src\/platform\/agents\/execution-evidence\.ts\s+@bibokh$/m);
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['lab:publish']).toBe('ts-node --transpile-only lab/orchestrator/publish-cli.ts');
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
      if (/^(start|build|postinstall|prestart|predeploy)/.test(name)) expect([name, /lab\//.test(cmd)]).toEqual([name, false]);
    }
  });

  it('the LAB tool has no approve, no publish, and no flag that names an approver', () => {
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const src = code('lab/orchestrator/publication.ts') + code('lab/orchestrator/publish-cli.ts');
    expect(src).not.toMatch(/approvedBy|approvedAt/);
    // The two words an approval would need appear once each: in the refusal that says there is no such command.
    expect(src.match(/'approve'/g)).toHaveLength(1);
    expect(src.match(/'publish'/g)).toHaveLength(1);
    expect(toExecutionEvidence.length).toBe(2);
  });

  describe('the CLI', () => {
    const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(
      process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'lab/orchestrator/publish-cli.ts', ...args],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FAMILISTA_ENV: 'LAB', FAMILISTA_LAB_EXECUTIONS_DIR: tmp(), FAMILISTA_LAB_PUBLICATIONS_DIR: tmp(), ...env }, timeout: 120_000 },
    );

    it.each([
      [['approve', 'exec-000000000000000000000000'], 'NO_APPROVAL_HERE'],
      [['publish', 'exec-000000000000000000000000'], 'NO_APPROVAL_HERE'],
      [['prepare', 'exec-000000000000000000000000', '--reference', 'bibokh/familista-backend#140', '--approved-by', 'bibokh'], 'IDENTITY_NOT_ACCEPTED'],
      [['prepare', 'exec-000000000000000000000000', '--owner', 'bibokh'], 'IDENTITY_NOT_ACCEPTED'],
      [['candidate', 'exec-000000000000000000000000', '--operator', 'lab-operator-platform'], 'IDENTITY_NOT_ACCEPTED'],
    ])('refuses %j before it reads anything (%s, exit 2)', (args, code) => {
      const r = cli(args as string[]);
      expect([r.status, r.stderr]).toEqual([2, expect.stringContaining(code as string)]);
    }, 130_000);

    it('refuses outside the Lab, and stops the demonstration at the Platform Owner\'s boundary', () => {
      const outside = cli(['verify'], { FAMILISTA_ENV: 'PRODUCTION' });
      expect([outside.status, outside.stderr]).toEqual([2, expect.stringContaining('ENVIRONMENT_NOT_LAB')]);
      const demo = cli(['demo']);
      expect(demo.status).toBe(0);
      expect(demo.stdout).toContain('Stopped at the Platform Owner\'s boundary');
      expect(demo.stdout).not.toContain('[REFUSED]');
    }, 260_000);
  });

  it('the demonstration blocks every unapproved path and approves nothing', () => {
    const steps = runPublicationDemonstration(tmp());
    expect(steps.filter((s) => s.result === 'REFUSED')).toEqual([]);
    expect(steps.filter((s) => s.result === 'BLOCKED').map((s) => s.n)).toEqual([6, 7, 8, 9, 10, 11, 15]);
    // The canonical definition, replayed from nothing, is the execution the demonstration ran, byte for byte.
    expect(steps[4]).toMatchObject({ n: 5, result: 'VERIFIED', step: expect.stringContaining('Deterministic replay') });
    expect(steps.filter((s) => s.result === 'SIMULATED').map((s) => s.step)).toEqual(['Read-only room presentation (SIMULATED: as if the pull request were merged)']);
    resetPublications();
    expect(readShippedPublications(registry)).toMatchObject({ state: 'VERIFIED', publications: [] });
  });
});
