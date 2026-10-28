/**
 * tests/publication-provenance.unit.test.ts
 *
 * Trusted execution provenance, and the gate that refuses a publication unless
 * CI reproduces it.
 *
 * AI-0.5's dossiers are internally consistent, and their digest pins what was
 * reviewed; their chains are unkeyed, so a dossier made up by hand and
 * consistent in every part verified. This file holds the line that closes
 * that gap:
 *
 *   1. a definition is inputs only, and replays to the same record, byte for
 *      byte, as the operator's own lab:execute run of it;
 *   2. the execution's source is measured exactly, and any change to it is a
 *      different digest;
 *   3. the server requires a provenance record that describes its dossier,
 *      and refuses the rehearsal source;
 *   4. the publication gate re-derives every claim and replays the
 *      definition. It refuses each of these, tested with valid and
 *      deliberately manipulated records:
 *        - an edited trace;
 *        - a consistent but fabricated dossier;
 *        - a changed agent definition;
 *        - an invalid approval;
 *        - medical data;
 *        - a duplicate publication;
 *        - an unsupported version;
 *        - an unmerged or unknown commit;
 *        - a definition changed after the fact;
 *        - another pull request's reference;
 *        - a stray file;
 *   5. a real publication is refused while the repository does not enforce
 *      the Platform Owner's approval. The rules on main as GitHub reported them
 *      on 2026-10-27 do not, and the gate says so.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { platformAgentRegistry, PLATFORM_AGENT_MANIFESTS } from '../src/platform/agents/catalog';
import { AgentRegistry } from '../src/platform/agents/registry';
import { holdsHealthData } from '../src/security/ai-read-policy';
import { engageKillSwitch, killSwitchEngaged, releaseKillSwitch } from '../src/platform/intelligence/agents';
import {
  APPROVAL_RECORD_CONTRACT, APPROVAL_RECORD_FILE, APPROVAL_RULE, EXECUTION_EVIDENCE_CONTRACT, executionEvidenceDigest, publicationsRoomView, readPublications,
  verifyExecutionEvidence,
  type ApprovalEntry, type ExecutionEvidence,
} from '../src/platform/agents/execution-evidence';
import {
  EXECUTION_PROVENANCE_CONTRACT, provenanceDigest, provenanceFileFor, REHEARSAL_REVISION, REHEARSAL_SOURCE_DIGEST, verifyProvenance,
  type ExecutionProvenance,
} from '../src/platform/agents/execution-provenance';
import { OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
import { applyDefinition, parseDefinition } from '../lab/orchestrator/definition';
import { decideExecution, FileExecutionStore, MemoryExecutionStore, submitExecution } from '../lab/orchestrator/execution';
import { healthDataPlan } from '../lab/orchestrator/execution-scenarios';
import { labExecutionOperations } from '../lab/orchestrator/operations';
import { buildProvenance, serialisePublicationFile, type ProvenanceClaim } from '../lab/orchestrator/publication';
import { CANONICAL_DEFINITION } from '../lab/orchestrator/publication-demo';
import { codeOwnersOf, PUBLISHED_PATH, runPublicationGate, type GateGit, type GateReport } from '../lab/orchestrator/publication-gate';
import { replayDefinition } from '../lab/orchestrator/replay';
import { executionSource, type ExecutionSource, type SourceReader } from '../lab/orchestrator/source';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const readOrNull: SourceReader = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'familista-prov-'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const LAB = { environment: 'LAB' as const };
const registry = platformAgentRegistry();
const operations = labExecutionOperations();

const DEF_TEXT = read(CANONICAL_DEFINITION);
const replayOk = (text = DEF_TEXT, at = CANONICAL_DEFINITION) => {
  const r = replayDefinition(text, at, LAB);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const canonical = replayOk();
const SOURCE = executionSource(readOrNull) as ExecutionSource;

/**
 * The first publication candidate, as this source computes it. CI reproduces these on another machine; a change
 * to the engine, the registry or the policies changes them, and the candidate is prepared again.
 */
const FIRST_CANDIDATE = {
  executionId: 'exec-4a69be628387d47063515727',
  publicationId: 'pub-b17756e1c9ac716ead4d3dea',
  recordDigest: '248305b5cb0fd39aecd220979f0f9883a54dbce36466fb9a83894c451598a5f8',
  dossierDigest: '08c940c009450b20633008304c40ef4d8ba3b215de8a132b008b7fe7b0e2b0b0',
};

afterEach(() => { if (killSwitchEngaged()) releaseKillSwitch(); });

// ── 1. the definition, and its replay ─────────────────────────────────────────
describe('1. a definition is inputs only, and replays to exactly the execution it describes', () => {
  it('the canonical definition: Tactical → Training → Club Manager, synthetic, the file it says it is', () => {
    const parsed = parseDefinition(DEF_TEXT, CANONICAL_DEFINITION);
    if ('reason' in parsed) throw new Error(parsed.reason);
    const d = parsed.definition;
    expect(d.name).toBe('matchday-staff-notice');
    expect(canonical.record.run.tasks.map((t) => `${t.id}:${t.agent?.id}:${t.state}`)).toEqual([
      'opponent:club.tactical:SUCCEEDED', 'session:club.training:SUCCEEDED', 'briefing:club.club-manager:SUCCEEDED', 'notice:club.club-manager:SUCCEEDED',
    ]);
    expect(canonical.steps.map((s) => `${s.action}:${s.status}:${s.code}`)).toEqual(['submit:ACCEPTED:null', 'decide:REFUSED:SELF_APPROVAL', 'decide:UPDATED:null']);
    expect(canonical.record.run.outcome).toBe('COMPLETED');
    // Synthetic only: every person and club a lab- reference, no health field, no address or real id.
    expect(holdsHealthData(d.request.plan)).toBe(false);
    expect(DEF_TEXT).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    for (const m of DEF_TEXT.matchAll(/"(userId|clubId)": "([^"]+)"/g)) expect(m[2]).toMatch(/^lab-/);
  });

  it('is deterministic: two replays from nothing are the same record and dossier, byte for byte, and hold no clock', () => {
    const again = replayOk();
    expect(again.record.digest).toBe(canonical.record.digest);
    expect(again.dossierText).toBe(canonical.dossierText);
    expect(JSON.stringify(canonical.record)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|Date\.now|Math\.random/);
  });

  it('reproduces the operator\'s own execution: lab:execute run, and the same commands typed by hand, into a file store', () => {
    const viaRun = new FileExecutionStore(tmp(), 'LAB');
    const parsed = parseDefinition(DEF_TEXT, CANONICAL_DEFINITION);
    if ('reason' in parsed) throw new Error(parsed.reason);
    const ran = applyDefinition(parsed.definition, { registry, operations, store: viaRun, environment: 'LAB' });
    expect(ran.ok && ran.record.digest).toBe(canonical.record.digest);
    const byHand = { registry, operations, store: new FileExecutionStore(tmp(), 'LAB'), environment: 'LAB' as const };
    const id = submitExecution(parsed.definition.request, byHand).record?.executionId ?? '';
    for (const st of parsed.definition.steps) if (st.action === 'decide') decideExecution(id, st.decision, byHand);
    expect(byHand.store.get(id)?.digest).toBe(canonical.record.digest);
  });

  it('the first publication candidate is these digests, on every machine that replays it', () => {
    expect({
      executionId: canonical.record.executionId, publicationId: canonical.evidence.publicationId,
      recordDigest: canonical.record.digest, dossierDigest: canonical.evidence.digest,
    }).toEqual(FIRST_CANDIDATE);
  });

  it('refuses a definition that is not strict, not the file it names, or not answered as written', () => {
    const def = JSON.parse(DEF_TEXT);
    const bad = (mut: (d: typeof def) => void, at = CANONICAL_DEFINITION) => { const d = clone(def); mut(d); const r = replayDefinition(JSON.stringify(d), at, LAB); return r.ok ? 'replayed' : r.reason; };
    expect(bad((d) => { d.note = 'x'; })).toMatch(/^definition: \(root\)/);
    expect(bad((d) => { d.steps[0].action = 'approve'; })).toMatch(/^definition: steps\.0/);
    expect(bad((d) => { d.contract = 'familista.lab-definition/v2'; })).toMatch(/^definition: contract/);
    expect(bad(() => undefined, 'lab/orchestrator/definitions/other-name.json')).toContain('is not at lab/orchestrator/definitions/matchday-staff-notice.json');
    expect(bad((d) => { d.steps = Array.from({ length: 17 }, () => d.steps[1]); })).toMatch(/^definition: steps/);
    expect(bad((d) => { d.steps[0].expect = { status: 'UPDATED', code: null }; })).toBe('step 1 (decide) was answered REFUSED SELF_APPROVAL; the definition expects UPDATED');
    expect(bad((d) => { d.expect.outcome = 'PARTIAL'; })).toBe('the execution ended COMPLETED; the definition expects PARTIAL');
    expect(replayDefinition(DEF_TEXT, CANONICAL_DEFINITION, { environment: 'PRODUCTION' })).toMatchObject({ ok: false, reason: expect.stringContaining('in the Lab only') });
    engageKillSwitch('test');
    expect(replayDefinition(DEF_TEXT, CANONICAL_DEFINITION, LAB)).toMatchObject({ ok: false, reason: expect.stringContaining('kill switch is engaged') });
  });

  it('a definition that engages the kill switch halts its execution, and the replay leaves the switch released', () => {
    const def = JSON.parse(DEF_TEXT);
    def.steps = [
      { action: 'kill-switch-engage', operator: { userId: 'lab-user-head-coach', role: 'HEAD_COACH' }, reason: 'LAB test: engaged while an approval waits', expect: { status: 'ENGAGED', code: null } },
      { ...def.steps[1], expect: { status: 'REFUSED', code: 'EXECUTION_SETTLED' } },
    ];
    def.expect.outcome = 'HALTED';
    const r = replayOk(JSON.stringify(def));
    expect(r.record.run.stop).toMatchObject({ outcome: 'HALTED', code: 'KILL_SWITCH' });
    expect(killSwitchEngaged()).toBe(false);
  });

  it('medical data never reaches a non-medical agent: the training task handed a medical status is refused, and the record says so', () => {
    const def = JSON.parse(DEF_TEXT);
    def.request.plan = healthDataPlan();
    def.steps = [];
    def.expect.outcome = 'PARTIAL';
    const r = replayOk(JSON.stringify(def));
    const session = r.record.run.tasks.find((t) => t.id === 'session');
    expect(session).toMatchObject({ state: 'REFUSED', outputDigest: null });
    expect(session?.reason?.code).toMatch(/HEALTH|MEDICAL/);
    // The dossier carries the refusal, never the medical status itself.
    expect(r.dossierText).not.toContain('INJURED');
    expect(holdsHealthData(r.evidence)).toBe(false);
  });
});

// ── 2. the source ─────────────────────────────────────────────────────────────
describe('2. the execution\'s source is measured exactly', () => {
  it('covers the engine, the execution layer, the registry, the policies and the roster, and the locked packages; not the published data', () => {
    const files = SOURCE.files.map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining([
      'lab/orchestrator/replay.ts', 'lab/orchestrator/engine.ts', 'lab/orchestrator/execution.ts', 'lab/orchestrator/operations.ts', 'lab/orchestrator/operators.ts',
      'lab/orchestrator/routing.ts', 'lab/orchestrator/definition.ts', 'lab/orchestrator/publication.ts', 'src/platform/agents/catalog.ts', 'src/platform/agents/registry.ts',
      'src/platform/intelligence/agents.ts', 'src/security/ai-read-policy.ts', 'src/security/approver-roles.ts', 'src/platform/agents/execution-evidence.ts',
      'src/platform/agents/execution-provenance.ts', 'src/config/zod.ts',
    ]));
    expect(files.some((f) => f.includes('/published/') || f.startsWith('tests/'))).toBe(false);
    expect(SOURCE.packages.map((p) => `${p.name}@${p.version}`)).toContain('zod@4.6.7');
    expect((executionSource(readOrNull) as ExecutionSource).digest).toBe(SOURCE.digest);
  });

  it('negative controls: one changed byte, an import that does not resolve, a package not in the lockfile', () => {
    const over = (o: Record<string, string>): SourceReader => (f) => (f in o ? o[f] : readOrNull(f));
    const engine = read('lab/orchestrator/engine.ts');
    expect((executionSource(over({ 'lab/orchestrator/engine.ts': `${engine} ` })) as ExecutionSource).digest).not.toBe(SOURCE.digest);
    expect(executionSource(over({ 'lab/orchestrator/engine.ts': `import './nowhere';\n${engine}` }))).toEqual({ reason: "source: lab/orchestrator/engine.ts imports ./nowhere, which does not resolve" });
    expect(executionSource(over({ 'lab/orchestrator/engine.ts': `import 'left-pad';\n${engine}` }))).toEqual({ reason: 'source: left-pad is imported but not locked in package-lock.json' });
  });
});

// ── fixtures for the server and the gate ─────────────────────────────────────
const R = '1'.repeat(40);         // the commit it ran at, on the base
const BASE = '2'.repeat(40);      // the pull request's base
const UNMERGED = '3'.repeat(40);  // a commit that exists and is not on the base
const PR = { number: 200, author: 'familista-agent' };

const claimOf = (over: Partial<ProvenanceClaim['source']> = {}, def = { name: 'matchday-staff-notice', path: CANONICAL_DEFINITION, digest: canonical.definitionDigest }): ProvenanceClaim => ({
  definition: def,
  source: { revision: R, digest: SOURCE.digest, files: SOURCE.files.length, packages: SOURCE.packages.map((p) => ({ name: p.name, version: p.version })), ...over },
  steps: 2,
});
const entryOf = (e: ExecutionEvidence, reference = `bibokh/familista-backend#${PR.number}`): ApprovalEntry => ({
  publicationId: e.publicationId, executionId: e.source.executionId, evidence: EXECUTION_EVIDENCE_CONTRACT,
  dossier: { file: `${e.publicationId}.json`, digest: e.digest }, reference,
});
const resign = (e: ExecutionEvidence): ExecutionEvidence => ({ ...e, digest: executionEvidenceDigest(e) });
const reseal = (p: ExecutionProvenance): ExecutionProvenance => ({ ...p, digest: provenanceDigest(p) });

/** A publications directory: dossiers (as text), provenance records, and the approval record. */
function publish(items: Array<{ dossierText: string; evidence: ExecutionEvidence; provenance?: ExecutionProvenance | null; entry?: ApprovalEntry | null }>, extra: unknown[] = []): string {
  const dir = tmp();
  for (const it of items) {
    fs.writeFileSync(path.join(dir, `${it.evidence.publicationId}.json`), it.dossierText);
    if (it.provenance !== null) fs.writeFileSync(path.join(dir, provenanceFileFor(it.evidence.publicationId)), serialisePublicationFile(it.provenance ?? buildProvenance(it.evidence, claimOf())));
  }
  const entries = [...items.filter((i) => i.entry !== null).map((i) => i.entry ?? entryOf(i.evidence)), ...extra];
  fs.writeFileSync(path.join(dir, APPROVAL_RECORD_FILE), serialisePublicationFile({ contract: APPROVAL_RECORD_CONTRACT, rule: APPROVAL_RULE, publications: entries }));
  return dir;
}
const valid = () => ({ dossierText: canonical.dossierText, evidence: clone(canonical.evidence) });

// ── 3. the server: a provenance record that describes its dossier ─────────────
describe('3. the server shows a publication only with a provenance record that describes it', () => {
  const prov = () => buildProvenance(canonical.evidence, claimOf());

  it('a valid record verifies, and the room view carries it, within the owner API contract', () => {
    expect(verifyProvenance(prov(), canonical.evidence)).toEqual({ provenance: prov(), reasons: [] });
    const r = readPublications(registry, publish([valid()]));
    expect(r.state).toBe('VERIFIED');
    expect(r.state === 'VERIFIED' && r.publications[0].provenance.source.revision).toBe(R);
  });

  it.each([
    ['its digest', (p: ExecutionProvenance) => ({ ...p, source: { ...p.source, files: p.source.files + 1 } }), 'provenance: its digest is not the digest of its content'],
    ['another publication', (p: ExecutionProvenance) => reseal({ ...p, publicationId: 'pub-000000000000000000000000' }), 'it is the provenance of pub-000000000000000000000000'],
    ['another execution', (p: ExecutionProvenance) => reseal({ ...p, executionId: 'exec-000000000000000000000000' }), 'provenance: it names another execution'],
    ['another dossier', (p: ExecutionProvenance) => reseal({ ...p, dossierDigest: 'a'.repeat(64) }), 'provenance: it describes another dossier (digest)'],
    ['another record', (p: ExecutionProvenance) => reseal({ ...p, recordDigest: 'a'.repeat(64) }), 'provenance: it describes another record (digest)'],
    ['a definition not at its path', (p: ExecutionProvenance) => reseal({ ...p, definition: { ...p.definition, name: 'other-name' } }), 'is not the file it names'],
    ['the rehearsal revision', (p: ExecutionProvenance) => reseal({ ...p, source: { ...p.source, revision: REHEARSAL_REVISION } }), 'a rehearsal is never provenance'],
    ['the rehearsal source', (p: ExecutionProvenance) => reseal({ ...p, source: { ...p.source, digest: REHEARSAL_SOURCE_DIGEST } }), 'a rehearsal is never provenance'],
    ['another version', (p: ExecutionProvenance) => reseal({ ...p, contract: 'familista.evidence-provenance/v2' as never }), 'is not a provenance version this server reads'],
    ['a field it does not name', (p: ExecutionProvenance) => reseal({ ...p, approvedBy: 'bibokh' } as never), 'provenance: (root)'],
    ['an operator-supplied claim of verification', (p: ExecutionProvenance) => reseal({ ...p, replay: { ...p.replay, verified: true } } as never), 'provenance: replay'],
  ])('refuses %s', (_what, mut, reason) => {
    const r = verifyProvenance(mut(prov()), canonical.evidence);
    expect(r.provenance).toBeNull();
    expect(r.reasons.join('; ')).toContain(reason);
  });

  it('the rehearsal revision passes only the Lab\'s rehearsal read-back', () => {
    const p = reseal({ ...prov(), source: { ...prov().source, revision: REHEARSAL_REVISION } });
    expect(verifyProvenance(p, canonical.evidence, { rehearsal: true }).reasons).toEqual([]);
  });

  it('without its provenance record, an approved dossier makes the whole read INVALID; a provenance record with no entry is listed, never read', () => {
    expect(readPublications(registry, publish([{ ...valid(), provenance: null }]))).toMatchObject({ state: 'INVALID', reason: expect.stringContaining('no provenance record is beside its dossier') });
    const stray = readPublications(registry, publish([{ ...valid(), entry: null }]));
    expect(stray).toMatchObject({ state: 'VERIFIED', publications: [], unapproved: [canonical.evidence.publicationId, `${canonical.evidence.publicationId}.provenance`] });
    const big = publish([valid()]);
    fs.writeFileSync(path.join(big, provenanceFileFor(canonical.evidence.publicationId)), ' '.repeat(17 * 1024));
    expect(readPublications(registry, big)).toMatchObject({ state: 'INVALID', reason: expect.stringContaining('larger than any real one') });
  });

  it('the room view with provenance is within the owner API contract', () => {
    const view = publicationsRoomView(registry, readPublications(registry, publish([valid()])));
    expect(view.publications[0].provenance).toMatchObject({ contract: EXECUTION_PROVENANCE_CONTRACT, statement: expect.stringContaining('must reproduce') });
    expect(OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/agents/publications')!.schema.safeParse(clone(view)).success).toBe(true);
  });
});

// ── 4. the gate ────────────────────────────────────────────────────────────────
const RULES_OBSERVED = JSON.parse(read('tests/fixtures/agents/github-rules-main.json')) as Array<{ type: string; parameters?: Record<string, unknown> }>;
/** The rules the gate requires: the observed ruleset with code-owner review, one approval and last-push approval turned on. */
const RULES_ENFORCED = RULES_OBSERVED.map((r) => (r.type === 'pull_request'
  ? { ...r, parameters: { ...r.parameters, require_code_owner_review: true, required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews_on_push: true } } : r));
const CODEOWNERS_TODAY = read('.github/CODEOWNERS');
const CODEOWNERS_OWNER_REVIEWS = `${CODEOWNERS_TODAY}\n/src/platform/agents/published/ @bibokh\n`;

interface Harness {
  dir: string;
  head?: Record<string, string | null>;
  atRevision?: Record<string, string | null>;
  base?: Record<string, string | null>;
  codeowners?: string;
  rules?: unknown | Error;
  pullRequest?: { number: number; author: string } | null;
  registry?: AgentRegistry;
}

function gate(h: Harness): Promise<GateReport> {
  const pub = `${PUBLISHED_PATH}/`;
  const head: SourceReader = (f) => {
    if (f.startsWith(pub)) { try { return fs.readFileSync(path.join(h.dir, f.slice(pub.length)), 'utf8'); } catch { return null; } }
    return h.head && f in h.head ? h.head[f] : readOrNull(f);
  };
  const git: GateGit = {
    show: (rev, f) => {
      if (rev === BASE) {
        if (f === '.github/CODEOWNERS') return h.codeowners ?? CODEOWNERS_OWNER_REVIEWS;
        if (h.base && f in h.base) return h.base[f];
        return f.startsWith(pub) ? readOrNull(f) : readOrNull(f);
      }
      if (rev === R || rev === UNMERGED) return h.atRevision && f in h.atRevision ? h.atRevision[f] : (f.startsWith(pub) ? null : readOrNull(f));
      return null;
    },
    isCommit: (rev) => [R, BASE, UNMERGED].includes(rev),
    isAncestor: (rev, of) => rev === of || (rev === R && of === BASE),
  };
  return runPublicationGate({
    head, publishedDir: h.dir, base: BASE, git, pullRequest: h.pullRequest === undefined ? PR : h.pullRequest,
    rules: async () => { if (h.rules instanceof Error) throw h.rules; return h.rules ?? RULES_ENFORCED; },
    registry: h.registry, operations, environment: 'LAB',
  });
}
const failed = (r: GateReport) => r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('4. the publication gate reproduces every publication a change adds, and refuses what it cannot', () => {
  it('with no publication added, it passes, and reports that the rules on main do not enforce the owner\'s approval today', async () => {
    const r = await gate({ dir: path.join(ROOT, PUBLISHED_PATH), rules: RULES_OBSERVED, codeowners: CODEOWNERS_TODAY, pullRequest: { number: 200, author: 'bibokh' } });
    expect([r.ok, r.candidates, failed(r)]).toEqual([true, [], []]);
    expect(r.enforcement.ok).toBe(false);
    expect(r.enforcement.findings.filter((f) => f.state === 'NOT_MET').map((f) => f.requirement)).toEqual([
      'review from Code Owners is required', 'at least one approving review is required', 'the last push must be approved by someone other than its author',
      'a code owner of the publications other than the author',
    ]);
    expect(r.enforcement.findings.find((f) => f.requirement.startsWith('the validate check'))?.state).toBe('MET');
    expect(r.enforcement.findings.find((f) => f.requirement === 'no actor may bypass the ruleset')?.state).toBe('UNVERIFIED');
  });

  it('a genuine candidate, reproduced at a merged commit, under enforced rules and an independent code owner, passes every check', async () => {
    const r = await gate({ dir: publish([valid()]) });
    expect(failed(r)).toEqual([]);
    expect(r.candidates).toEqual([canonical.evidence.publicationId]);
    expect(r.checks.map((c) => c.id)).toEqual(['read', 'stray', 'provenance-present', 'definition', 'revision', 'definition-at-revision', 'source', 'replay', 'provenance', 'reference', 'owner-approval-enforced']);
    expect(r.ok).toBe(true);
  });

  it('the same genuine candidate is refused while the repository does not enforce the owner\'s approval (the rules on main today)', async () => {
    const today = await gate({ dir: publish([valid()]), rules: RULES_OBSERVED, codeowners: CODEOWNERS_TODAY, pullRequest: { number: 200, author: 'bibokh' } });
    expect(failed(today)).toEqual(['owner-approval-enforced']);
    expect(today.checks.find((c) => c.id === 'owner-approval-enforced')?.detail).toMatch(/^real publication is blocked: review from Code Owners is required; at least one approving review/);
    // The rules enforced, but the only code owner is the pull request's author: GitHub never counts their approval.
    const self = await gate({ dir: publish([valid()]), codeowners: CODEOWNERS_TODAY, pullRequest: { number: 200, author: 'bibokh' } });
    expect(failed(self)).toEqual(['owner-approval-enforced']);
    expect(self.enforcement.findings.find((f) => f.requirement.startsWith('a code owner'))?.state).toBe('NOT_MET');
    // The rules cannot be read: refused, never assumed.
    expect(failed(await gate({ dir: publish([valid()]), rules: new Error('GitHub answered 503') }))).toEqual(['owner-approval-enforced']);
  });

  it('refuses a dossier made up by hand, consistent in every part, that the definition it names does not produce', async () => {
    // Every chain, digest and id of this dossier is right: it is what the engine computes for another execution
    // (the notice REJECTED). Before the gate, it would have verified. Its provenance claims the canonical definition.
    const def = JSON.parse(DEF_TEXT);
    def.steps[1].decision.decision = 'REJECTED';
    def.expect.outcome = 'PARTIAL';
    const other = replayOk(JSON.stringify(def));
    const forged = { dossierText: other.dossierText, evidence: other.evidence, provenance: buildProvenance(other.evidence, claimOf()) };
    expect(readPublications(registry, publish([forged])).state).toBe('VERIFIED'); // the server alone cannot tell
    const r = await gate({ dir: publish([forged]) });
    expect(failed(r)).toEqual(['replay', 'provenance']);
    expect(r.ok).toBe(false);
  });

  it('refuses an edited trace and a forged outcome, even re-sealed', async () => {
    const e = clone(canonical.evidence);
    e.run.trace[3] = { ...e.run.trace[3], detail: `${e.run.trace[3].detail} (edited)` };
    const edited = resign(e);
    expect(failed(await gate({ dir: publish([{ dossierText: serialisePublicationFile(edited), evidence: edited, provenance: buildProvenance(edited, claimOf()) }]) }))).toContain('read');
    const f = clone(canonical.evidence);
    const outcome = resign({ ...f, run: { ...f.run, outcome: 'PARTIAL' } });
    expect(failed(await gate({ dir: publish([{ dossierText: serialisePublicationFile(outcome), evidence: outcome, provenance: buildProvenance(outcome, claimOf()) }]) }))).toContain('read');
  });

  it('refuses a self-approval presented as a valid decision, and a health field', async () => {
    const e = clone(canonical.evidence);
    const self = resign({ ...e, decisions: [{ ...e.decisions[0], byRole: 'HEAD_COACH' }] });
    // Before this change the server's verifier compared a decision's task and verdict with the log, not its role,
    // and accepted this re-sealed dossier; only the replay caught it. It is refused on both counts now.
    expect(verifyExecutionEvidence(self, registry).reasons).toContain('coherence: its decisions are not the ones its execution log records');
    expect(failed(await gate({ dir: publish([{ dossierText: serialisePublicationFile(self), evidence: self, provenance: buildProvenance(self, claimOf()) }]) }))).toEqual(['read', 'replay', 'provenance']);
    const decider = resign({ ...e, run: { ...e.run, tasks: e.run.tasks.map((t) => (t.approval ? { ...t, approval: { ...t.approval, decidedByRole: 'MEDICAL_STAFF' } } : t)) } });
    expect(verifyExecutionEvidence(decider, registry).reasons).toEqual(expect.arrayContaining(['coherence: task notice shows a decider its decisions do not record']));
    const m = clone(canonical.evidence);
    const medical = resign({ ...m, routing: m.routing.map((r, i) => (i ? r : { ...r, medicalStatus: 'INJURED' } as never)) });
    expect(failed(await gate({ dir: publish([{ dossierText: serialisePublicationFile(medical), evidence: medical, provenance: buildProvenance(medical, claimOf()) }]) }))).toContain('read');
  });

  it('refuses a changed agent definition: in the registry the head runs, or in the source the commit had', async () => {
    const changed = new AgentRegistry();
    for (const m of PLATFORM_AGENT_MANIFESTS) changed.register(m.id === 'club.training' ? { ...m, version: '9.9.9' } : m);
    expect(failed(await gate({ dir: publish([valid()]), registry: changed }))).toEqual(expect.arrayContaining(['replay']));
    const catalog = read('src/platform/agents/catalog.ts');
    expect(failed(await gate({ dir: publish([valid()]), atRevision: { 'src/platform/agents/catalog.ts': `${catalog}\n// a different registry at that commit\n` } }))).toEqual(['source']);
  });

  it('refuses provenance from code that is not merged, a commit that does not exist, and a definition changed after it ran', async () => {
    const at = (revision: string) => publish([{ ...valid(), provenance: buildProvenance(canonical.evidence, claimOf({ revision })) }]);
    expect(failed(await gate({ dir: at(UNMERGED) }))).toEqual(['revision']);
    expect(failed(await gate({ dir: at('4'.repeat(40)) }))).toEqual(['revision', 'definition-at-revision', 'source']);
    // The definition at the head is not the one at the commit: edited after it ran.
    const def = JSON.parse(DEF_TEXT);
    def.purpose = `${def.purpose} Edited afterwards.`;
    const r = await gate({ dir: publish([valid()]), head: { [CANONICAL_DEFINITION]: serialisePublicationFile(def) } });
    expect(failed(r)).toEqual(['definition', 'provenance']);
    // And a definition that was never merged at that commit.
    expect(failed(await gate({ dir: publish([valid()]), atRevision: { [CANONICAL_DEFINITION]: null } }))).toEqual(['definition-at-revision']);
  });

  it('refuses a provenance record that is not the one the replay implies, byte for byte, and one whose source digest is not the source\'s', async () => {
    const wrongFiles = buildProvenance(canonical.evidence, claimOf({ files: SOURCE.files.length - 1 }));
    expect(failed(await gate({ dir: publish([{ ...valid(), provenance: wrongFiles }]) }))).toEqual(['source', 'provenance']);
    const wrongDigest = buildProvenance(canonical.evidence, claimOf({ digest: 'f'.repeat(64) }));
    expect(failed(await gate({ dir: publish([{ ...valid(), provenance: wrongDigest }]) }))).toEqual(['source', 'provenance']);
  });

  it('refuses a dossier reformatted from the replay\'s bytes, another pull request\'s reference, and a stray file', async () => {
    const reformatted = { dossierText: `${JSON.stringify(canonical.evidence)}\n`, evidence: clone(canonical.evidence) };
    expect(failed(await gate({ dir: publish([reformatted]) }))).toEqual(['replay']);
    expect(failed(await gate({ dir: publish([{ ...valid(), entry: entryOf(canonical.evidence, 'bibokh/familista-backend#141') }]) }))).toEqual(['reference']);
    const dir = publish([valid()]);
    fs.writeFileSync(path.join(dir, 'pub-000000000000000000000000.json'), '{}');
    expect(failed(await gate({ dir }))).toEqual(['stray']);
  });

  it('refuses duplicate and conflicting publications, and unsupported versions', async () => {
    expect(failed(await gate({ dir: publish([valid()], [entryOf(canonical.evidence, 'bibokh/familista-backend#201')]) }))).toContain('read');
    const v3 = { ...clone(canonical.evidence), contract: 'familista.orchestration-evidence/v3' } as unknown as ExecutionEvidence;
    expect(failed(await gate({ dir: publish([{ dossierText: serialisePublicationFile(v3), evidence: v3, provenance: buildProvenance(canonical.evidence, claimOf()) }]) }))).toContain('read');
    const provV2 = reseal({ ...buildProvenance(canonical.evidence, claimOf()), contract: 'familista.evidence-provenance/v2' as never });
    expect(failed(await gate({ dir: publish([{ ...valid(), provenance: provV2 }]) }))).toContain('read');
  });

  it('replays only what the change adds or alters: a publication already on the base is not a candidate', async () => {
    const dir = publish([valid()]);
    const base: Record<string, string | null> = {};
    for (const f of fs.readdirSync(dir)) base[`${PUBLISHED_PATH}/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
    const r = await gate({ dir, base, rules: RULES_OBSERVED, codeowners: CODEOWNERS_TODAY });
    expect([r.ok, r.candidates]).toEqual([true, []]);
    // But altering its provenance on the base makes it a candidate again, replayed again.
    base[`${PUBLISHED_PATH}/${provenanceFileFor(canonical.evidence.publicationId)}`] = '{}';
    expect((await gate({ dir, base })).candidates).toEqual([canonical.evidence.publicationId]);
  });

  it('reads CODEOWNERS as GitHub does: the last matching line wins', () => {
    expect(codeOwnersOf(CODEOWNERS_TODAY, `${PUBLISHED_PATH}/${APPROVAL_RECORD_FILE}`)).toEqual(['bibokh']);
    expect(codeOwnersOf('*  @a\n/src/platform/agents/published/ @b @c\n', `${PUBLISHED_PATH}/x.json`)).toEqual(['b', 'c']);
    expect(codeOwnersOf('/src/platform/agents/published/ @b\n* @a\n', `${PUBLISHED_PATH}/x.json`)).toEqual(['a']);
    expect(codeOwnersOf('# * @a\n', 'x')).toEqual([]);
  });
});

// ── 5. wiring, isolation and the Lab's commands ───────────────────────────────
describe('5. the gate runs in the required check, the server imports nothing from the Lab, and the Lab cannot approve', () => {
  it('the gate is a step of the validate job, the check the ruleset requires, with the least privilege it already had', () => {
    const ci = read('.github/workflows/ci.yml');
    const validate = ci.slice(ci.indexOf('  validate:'), ci.indexOf('\n  browser-proof:'));
    expect(validate).toContain('run: npm run lab:publication-gate');
    expect(validate).toMatch(/FAMILISTA_ENV: LAB\n\s+GATE_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
    expect(validate).toContain('GATE_PR_NUMBER: ${{ github.event.pull_request.number }}');
    expect(validate).toContain('GATE_PR_AUTHOR: ${{ github.event.pull_request.user.login }}');
    expect(validate.indexOf('lab:publication-gate')).toBeGreaterThan(validate.indexOf('run: npm test'));
    expect(ci).toMatch(/^permissions:\n  contents: read\n/m);
    expect(RULES_OBSERVED.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ context: 'validate (tsc + prisma + boot probe + contracts + tests)', integration_id: 15368 })]),
    );
  });

  it('the server\'s provenance check imports only zod and the evidence modules, writes nothing and runs nothing', () => {
    const src = read('src/platform/agents/execution-provenance.ts');
    expect([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['zod', './orchestration-evidence', './trace-chain']);
    expect(/child_process|\bfetch\(|writeFile|\beval\(|new Function|lab\//.test(src.replace(/\/\/.*$/gm, ''))).toBe(false);
  });

  it('the definitions directory holds the canonical definition and nothing else; the shipped record publishes nothing', () => {
    expect(fs.readdirSync(path.join(ROOT, 'lab/orchestrator/definitions'))).toEqual(['matchday-staff-notice.json']);
    expect(JSON.parse(read(`${PUBLISHED_PATH}/${APPROVAL_RECORD_FILE}`)).publications).toEqual([]);
    expect(fs.readdirSync(path.join(ROOT, PUBLISHED_PATH))).toEqual([APPROVAL_RECORD_FILE]);
  });

  describe('the CLIs', () => {
    const run = (cli: string, args: string[], env: Record<string, string> = {}) => spawnSync(
      process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', cli, ...args],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FAMILISTA_ENV: 'LAB', FAMILISTA_LAB_EXECUTIONS_DIR: tmp(), FAMILISTA_LAB_PUBLICATIONS_DIR: tmp(), ...env }, timeout: 120_000 },
    );

    it('lab:execute run is the canonical execution; lab:publish replay reproduces it; prepare needs the definition, and still takes no approver', () => {
      const store = { FAMILISTA_LAB_EXECUTIONS_DIR: tmp() };
      const ran = run('lab/orchestrator/execute-cli.ts', ['run', CANONICAL_DEFINITION], store);
      expect([ran.status, ran.stdout]).toEqual([0, expect.stringContaining(`${FIRST_CANDIDATE.executionId}  COMPLETED`)]);
      expect(ran.stdout).toContain(`record ${FIRST_CANDIDATE.recordDigest.slice(0, 16)}`);
      const replayed = run('lab/orchestrator/publish-cli.ts', ['replay', CANONICAL_DEFINITION]);
      expect([replayed.status, replayed.stdout]).toEqual([0, expect.stringContaining(`dossier ${FIRST_CANDIDATE.dossierDigest}`)]);
      const noDef = run('lab/orchestrator/publish-cli.ts', ['prepare', FIRST_CANDIDATE.executionId, '--reference', 'bibokh/familista-backend#200'], store);
      expect([noDef.status, noDef.stderr]).toEqual([2, expect.stringContaining('DEFINITION_REQUIRED')]);
      const found = run('lab/orchestrator/publish-cli.ts', ['candidate', FIRST_CANDIDATE.executionId, '--definition', CANONICAL_DEFINITION], store);
      expect([found.status, found.stdout]).toEqual([0, expect.stringContaining('reproduced: the replay is this execution, byte for byte')]);
      const approver = run('lab/orchestrator/publish-cli.ts', ['prepare', FIRST_CANDIDATE.executionId, '--definition', CANONICAL_DEFINITION, '--reference', 'bibokh/familista-backend#200', '--approved-by', 'bibokh']);
      expect([approver.status, approver.stderr]).toEqual([2, expect.stringContaining('IDENTITY_NOT_ACCEPTED')]);
    }, 240_000);
  });
});

// A replay never writes: the store it runs in is its own, in memory.
it('a replay keeps nothing: it runs in a memory store of its own and writes no file', () => {
  const src = read('lab/orchestrator/replay.ts');
  expect(src).toContain('new MemoryExecutionStore()');
  expect(/FileExecutionStore|writeFile|mkdir|renameSync/.test(src)).toBe(false);
  expect(new MemoryExecutionStore().list()).toEqual([]);
});
