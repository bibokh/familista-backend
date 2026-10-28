// The publication gate — CI's independent reproduction of every publication a change adds
// ─────────────────────────────────────────────────────────────────────────────
// Runs on every pull request and every push to main, as a step of the required
// `validate` check (.github/workflows/ci.yml). It fails closed. For the
// publications directory at the head (src/platform/agents/published/) it:
//
//   1. reads it exactly as the server will (readPublications): every dossier
//      v2, verified as a whole, approved once, with its provenance; nothing
//      stray beside it
//   2. finds the candidates: every publication whose entry, dossier or
//      provenance differs from the base. Nothing else is replayed: an older
//      publication was reproduced at its own commit when it was added
//   3. for each candidate, believes none of its provenance and re-derives all of it:
//        definition   the file it names is at the head, parses, and has the digest named
//        revision     the commit named exists and is already on the base branch:
//                     reviewed and merged code, never this change's own
//        at revision  the definition is that same file at that commit
//        source       the execution's source digest (source.ts) at the head AND at
//                     that commit is the digest named
//        replay       the definition, run again from nothing through the AI-0.4
//                     engine, reproduces the record digest and the dossier, byte for byte
//        provenance   the provenance record the replay implies is the file, byte for byte
//        reference    on a pull request, the entry names this pull request
//   4. when there is a candidate, requires the repository to ENFORCE the
//      Platform Owner's approval, as GitHub reports the rules active on main:
//      code-owner review, at least one approval, approval of the last push by
//      someone else, stale approvals dismissed, all four CI checks from GitHub
//      Actions, branches up to date, no force push or deletion; and a code
//      owner of the publications other than the pull request's author. GitHub
//      does not tell this token who may bypass the ruleset, so that is reported
//      as unverified, never as passed.
//
// With no candidate it passes, and still reports what the enforcement check
// would find, so the state of the rules is visible on every run.

import * as path from 'path';
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import {
  APPROVAL_RECORD_FILE, PUBLICATIONS_DIR, readPublications, type ApprovalEntry, type ApprovalRecord,
} from '../../src/platform/agents/execution-evidence';
import { provenanceFileFor, PROVENANCE_REPOSITORY, type ExecutionProvenance } from '../../src/platform/agents/execution-provenance';
import type { AgentRegistry } from '../../src/platform/agents/registry';
import type { FamilistaEnvironment } from '../../src/platform/environment';
import { parseDefinition } from './definition';
import { labExecutionOperations, type OperationCatalog } from './operations';
import { buildProvenance, serialisePublicationFile } from './publication';
import { replayDefinition } from './replay';
import { executionSource, type SourceReader } from './source';

/** The publications directory, as a repository path. */
export const PUBLISHED_PATH = path.relative(path.join(__dirname, '..', '..'), PUBLICATIONS_DIR).split(path.sep).join('/');
/** The checks every pull request must pass, as ci.yml names its jobs and the ruleset requires them, and GitHub Actions' app id. */
export const REQUIRED_CHECKS = Object.freeze([
  'validate (tsc + prisma + boot probe + contracts + tests)',
  'browser proof (isolation)',
  'browser proof (accessibility and focus)',
  'secret scan (gitleaks, full history)',
]);
export const GITHUB_ACTIONS_APP_ID = 15368;

/** What the gate needs of git; the CLI runs git, tests give it a map. */
export interface GateGit {
  /** The file at `rev`, or null if it has none. */
  show(rev: string, file: string): string | null;
  isCommit(rev: string): boolean;
  /** Whether `rev` is `of` or one of its ancestors. */
  isAncestor(rev: string, of: string): boolean;
}

export interface GateInput {
  /** Reads a file of the head's working tree, by repository path. */
  head: SourceReader;
  /** The head's publications directory on disk: the one `head` reads for src/platform/agents/published/. The repository's own by default. */
  publishedDir?: string;
  /** The commit the change is measured against: the pull request's base, or main before a push. */
  base: string;
  git: GateGit;
  /** Set on a pull request: its number and its author's login. */
  pullRequest: { number: number; author: string } | null;
  /** The rules GitHub reports active on main (GET /repos/{repo}/rules/branches/main); throws or rejects if they cannot be read. */
  rules: () => Promise<unknown>;
  registry?: AgentRegistry;
  operations?: OperationCatalog;
  /** Defaults to this process's own; the replay runs in the Lab only. */
  environment?: FamilistaEnvironment;
}

export interface GateCheck { id: string; subject: string; ok: boolean; detail: string }
export interface EnforcementFinding { requirement: string; state: 'MET' | 'NOT_MET' | 'UNVERIFIED'; detail: string }
export interface GateReport {
  ok: boolean;
  candidates: string[];
  removed: string[];
  checks: GateCheck[];
  enforcement: { ok: boolean; findings: EnforcementFinding[] };
}

const recordPath = `${PUBLISHED_PATH}/${APPROVAL_RECORD_FILE}`;
const parseRecord = (text: string | null): ApprovalRecord | null => {
  if (text === null) return null;
  try { return JSON.parse(text) as ApprovalRecord; } catch { return null; }
};

/** Which head publications differ from the base, in their entry, dossier or provenance; and which the head removed. */
export function publicationChanges(head: SourceReader, git: GateGit, base: string, entries: readonly ApprovalEntry[]): { candidates: ApprovalEntry[]; removed: string[] } {
  const before = parseRecord(git.show(base, recordPath))?.publications ?? [];
  const candidates = entries.filter((e) => {
    const was = before.find((b) => b.publicationId === e.publicationId);
    const files = [e.dossier.file, provenanceFileFor(e.publicationId)].map((f) => `${PUBLISHED_PATH}/${f}`);
    return !was || JSON.stringify(was) !== JSON.stringify(e) || files.some((f) => git.show(base, f) !== head(f));
  });
  const removed = before.filter((b) => !entries.some((e) => e.publicationId === b.publicationId)).map((b) => b.publicationId);
  return { candidates, removed };
}

// ── enforcement of the Platform Owner's approval ────────────────────────────────
// The configuration this checks is the one docs/security/github-governance.md
// specifies for ruleset 25019943, in full: a weaker ruleset is not "enforced".

interface Rule { type?: string; parameters?: Record<string, unknown> }

/** The owners CODEOWNERS gives `file`: the last matching line wins, as GitHub reads it. Patterns used here: `*`, `/dir/`, `/file`. */
export function codeOwnersOf(codeowners: string, file: string): string[] {
  let owners: string[] = [];
  for (const raw of codeowners.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...who] = line.split(/\s+/);
    const p = pattern.replace(/^\//, '');
    const hit = pattern === '*' || (p.endsWith('/') ? file.startsWith(p) : file === p);
    if (hit) owners = who.map((w) => w.replace(/^@/, '').toLowerCase());
  }
  return owners;
}

/** Whether the rules GitHub reports, and the base's CODEOWNERS, enforce the Platform Owner's approval of a publication. */
export function enforcementOf(rules: unknown, codeowners: string | null, author: string | null): { ok: boolean; findings: EnforcementFinding[] } {
  const list: Rule[] = Array.isArray(rules) ? rules as Rule[] : [];
  const pr = list.find((r) => r.type === 'pull_request')?.parameters ?? null;
  const status = list.find((r) => r.type === 'required_status_checks')?.parameters ?? null;
  const checks = (status?.required_status_checks ?? []) as Array<{ context?: string; integration_id?: number }>;
  const findings: EnforcementFinding[] = [];
  const need = (requirement: string, met: boolean, detail: string) => findings.push({ requirement, state: met ? 'MET' : 'NOT_MET', detail });
  need('a pull request is required to change main', !!pr, pr ? 'the pull_request rule is active' : 'no active pull_request rule on main');
  need('review from Code Owners is required', pr?.require_code_owner_review === true, `require_code_owner_review: ${String(pr?.require_code_owner_review ?? 'absent')}`);
  need('at least one approving review is required', typeof pr?.required_approving_review_count === 'number' && (pr.required_approving_review_count as number) >= 1, `required_approving_review_count: ${String(pr?.required_approving_review_count ?? 'absent')}`);
  need('the last push must be approved by someone other than its author', pr?.require_last_push_approval === true, `require_last_push_approval: ${String(pr?.require_last_push_approval ?? 'absent')}`);
  need('stale approvals are dismissed when new commits are pushed', pr?.dismiss_stale_reviews_on_push === true, `dismiss_stale_reviews_on_push: ${String(pr?.dismiss_stale_reviews_on_push ?? 'absent')}`);
  const missing = REQUIRED_CHECKS.filter((name) => !checks.some((c) => c.context === name && c.integration_id === GITHUB_ACTIONS_APP_ID));
  need('every CI check, this gate\'s validate among them, is required from GitHub Actions', missing.length === 0,
    missing.length ? `not required from app ${GITHUB_ACTIONS_APP_ID}: ${missing.map((m) => `"${m}"`).join(', ')}` : `${REQUIRED_CHECKS.length} checks from app ${GITHUB_ACTIONS_APP_ID}`);
  need('branches must be up to date with main before merging', status?.strict_required_status_checks_policy === true, `strict_required_status_checks_policy: ${String(status?.strict_required_status_checks_policy ?? 'absent')}`);
  need('force pushes and deletion of main are blocked', list.some((r) => r.type === 'non_fast_forward') && list.some((r) => r.type === 'deletion'), 'non_fast_forward and deletion rules');
  const owners = codeowners === null ? [] : codeOwnersOf(codeowners, recordPath);
  if (author === null) {
    findings.push({ requirement: 'a code owner of the publications other than the author', state: 'UNVERIFIED', detail: `owners ${owners.map((o) => `@${o}`).join(' ') || 'none'}; checked on the pull request, where the author is known` });
  } else {
    const others = owners.filter((o) => o !== author.toLowerCase());
    need('a code owner of the publications other than the author', others.length > 0,
      `${recordPath} is owned by ${owners.map((o) => `@${o}`).join(' ') || 'nobody'}; the author is @${author}, and GitHub never counts an author's approval of their own pull request`);
  }
  findings.push({ requirement: 'no actor may bypass the ruleset', state: 'UNVERIFIED', detail: 'GitHub does not disclose bypass actors to this token; the Platform Owner confirms it in Settings → Rules' });
  return { ok: findings.every((f) => f.state !== 'NOT_MET'), findings };
}

// ── the gate ───────────────────────────────────────────────────────────────────

export async function runPublicationGate(input: GateInput): Promise<GateReport> {
  const registry = input.registry ?? platformAgentRegistry();
  const operations = input.operations ?? labExecutionOperations();
  const checks: GateCheck[] = [];
  const check = (id: string, subject: string, ok: boolean, detail: string) => { checks.push({ id, subject, ok, detail }); return ok; };

  // 1. the directory, as the server will read it
  const dir = input.publishedDir ?? PUBLICATIONS_DIR;
  const read = readPublications(registry, dir);
  check('read', PUBLISHED_PATH, read.state === 'VERIFIED', read.state === 'VERIFIED' ? `${read.publications.length} approved publication(s), each verified with its provenance` : `${read.state}: ${read.reason}`);
  check('stray', PUBLISHED_PATH, read.unapproved.length === 0, read.unapproved.length ? `present without an approval entry: ${read.unapproved.join(', ')}` : 'no dossier or provenance without an entry');
  const entries = read.state === 'VERIFIED' ? read.publications.map((p) => p.entry) : (parseRecord(input.head(recordPath))?.publications ?? []);

  // 2. what this change adds or alters
  const { candidates, removed } = publicationChanges(input.head, input.git, input.base, entries);

  // 3. each candidate, reproduced
  for (const entry of candidates) {
    const id = entry.publicationId;
    const provText = input.head(`${PUBLISHED_PATH}/${provenanceFileFor(id)}`);
    const dossierText = input.head(`${PUBLISHED_PATH}/${entry.dossier.file}`);
    let prov: ExecutionProvenance | null = null;
    try { prov = provText ? JSON.parse(provText) as ExecutionProvenance : null; } catch { prov = null; }
    if (!check('provenance-present', id, !!prov && !!dossierText, prov ? 'provenance record and dossier present' : 'no readable provenance record')) continue;
    const p = prov as ExecutionProvenance;

    const defText = input.head(p.definition.path);
    const def = defText === null ? null : parseDefinition(defText, p.definition.path);
    const defOk = !!def && !('reason' in def) && def.digest === p.definition.digest;
    check('definition', id, defOk, defText === null ? `${p.definition.path} is not at the head` : def && 'reason' in def ? def.reason : defOk ? `${p.definition.path} ${p.definition.digest.slice(0, 16)}` : `${p.definition.path} has digest ${def && 'digest' in def ? def.digest.slice(0, 16) : '?'}, not ${p.definition.digest.slice(0, 16)}`);

    const rev = p.source.revision;
    const known = input.git.isCommit(rev);
    const onBase = known && input.git.isAncestor(rev, input.base);
    check('revision', id, onBase, !known ? `${rev} is not a commit of ${PROVENANCE_REPOSITORY}` : onBase ? `${rev.slice(0, 12)} is on the base ${input.base.slice(0, 12)}: reviewed and merged before this change` : `${rev.slice(0, 12)} is not on the base ${input.base.slice(0, 12)}: it ran on code that is not yet merged`);

    const atRev = known ? input.git.show(rev, p.definition.path) : null;
    const defAtRev = atRev === null ? null : parseDefinition(atRev, p.definition.path);
    check('definition-at-revision', id, !!defAtRev && !('reason' in defAtRev) && defAtRev.digest === p.definition.digest,
      atRev === null ? `${p.definition.path} is not in ${rev.slice(0, 12)}` : defAtRev && 'digest' in defAtRev && defAtRev.digest === p.definition.digest ? 'the same definition at that commit' : 'a different definition at that commit');

    const headSource = executionSource(input.head);
    const revSource = known ? executionSource((f) => input.git.show(rev, f)) : { reason: 'no such commit' };
    const srcOk = !('reason' in headSource) && !('reason' in revSource) && headSource.digest === p.source.digest && revSource.digest === p.source.digest
      && headSource.files.length === p.source.files && JSON.stringify(headSource.packages.map((x) => ({ name: x.name, version: x.version }))) === JSON.stringify(p.source.packages);
    check('source', id, srcOk, 'reason' in headSource ? headSource.reason : 'reason' in revSource ? `at ${rev.slice(0, 12)}: ${revSource.reason}`
      : `head ${headSource.digest.slice(0, 16)}, ${rev.slice(0, 12)} ${revSource.digest.slice(0, 16)}, named ${p.source.digest.slice(0, 16)} (${headSource.files.length} files; ${headSource.packages.map((x) => `${x.name}@${x.version}`).join(', ')})`);

    const replay = defText === null ? null : replayDefinition(defText, p.definition.path, { registry, operations, environment: input.environment });
    if (!replay || !replay.ok) { check('replay', id, false, replay ? `the definition does not replay: ${replay.reason}` : 'nothing to replay'); continue; }
    const sameRecord = replay.record.digest === p.recordDigest && replay.evidence.source.recordDigest === p.recordDigest;
    const sameDossier = replay.dossierText === dossierText && replay.evidence.digest === entry.dossier.digest && replay.evidence.publicationId === id;
    check('replay', id, sameRecord && sameDossier,
      `record ${replay.record.digest.slice(0, 16)} ${sameRecord ? '=' : '≠'} ${p.recordDigest.slice(0, 16)}; dossier ${replay.evidence.digest.slice(0, 16)} ${sameDossier ? '= the file, byte for byte' : `≠ the file (${entry.dossier.digest.slice(0, 16)})`}`);

    const implied = serialisePublicationFile(buildProvenance(replay.evidence, {
      definition: { name: replay.definition.name, path: p.definition.path, digest: replay.definitionDigest },
      source: { revision: rev, digest: 'reason' in headSource ? '' : headSource.digest, files: 'reason' in headSource ? 0 : headSource.files.length, packages: 'reason' in headSource ? [] : headSource.packages },
      steps: replay.definition.steps.length,
    }));
    check('provenance', id, implied === provText, implied === provText ? 'the provenance record is the one the replay implies, byte for byte' : 'the provenance record is not the one the replay implies');

    if (input.pullRequest) {
      const want = `${PROVENANCE_REPOSITORY}#${input.pullRequest.number}`;
      check('reference', id, entry.reference === want, entry.reference === want ? `names this pull request, ${want}` : `names ${entry.reference}, not this pull request (${want})`);
    }
  }

  // 4. the Platform Owner's approval, enforced by the repository
  let rules: unknown = null;
  let rulesError: string | null = null;
  try { rules = await input.rules(); } catch (e) { rulesError = e instanceof Error ? e.message : String(e); }
  const enforcement = rulesError
    ? { ok: false, findings: [{ requirement: 'the rules active on main can be read', state: 'NOT_MET' as const, detail: rulesError }] }
    : enforcementOf(rules, input.git.show(input.base, '.github/CODEOWNERS'), input.pullRequest?.author ?? null);
  if (candidates.length) check('owner-approval-enforced', PUBLISHED_PATH, enforcement.ok,
    enforcement.ok ? 'the repository enforces code-owner approval by someone other than the author' : `real publication is blocked: ${enforcement.findings.filter((f) => f.state === 'NOT_MET').map((f) => f.requirement).join('; ')}`);

  return { ok: checks.every((c) => c.ok), candidates: candidates.map((c) => c.publicationId), removed, checks, enforcement };
}
