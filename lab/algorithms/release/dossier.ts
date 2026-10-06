// Familista — the release plan: everything an approval would bind, before anything is written
// ─────────────────────────────────────────────────────────────────────────────
// `plan` answers one question for one candidate: could the platform owner
// approve THIS, and what exactly would the approval be bound to? It writes
// nothing in the repository. It refuses, with a reason, unless every one of
// these holds:
//
//   · the candidate is on the allow-list and judged against today's approved
//     version, whose code has not moved since it was approved
//   · its code changes something, and every declaration it is made of exists
//   · the promotion can be made as text: the changed declarations replaced,
//     nothing else touched, the result carrying exactly the candidate's
//     fingerprint and every other algorithm in the file keeping its own
//   · re-run now, in child processes, the comparison method passes its own
//     checks and the held-out Test passes
//   · that re-run agrees with the committed Step 4 evidence — the evidence the
//     owner saw in Algorithms → Proposals
//   · every registered algorithm whose code reaches the changed code is a
//     declared dependant, could be run, and broke nothing when it was
//
// When they all hold, the plan carries the dossier (src/algorithms/
// approval-dossier.ts) and its digest. `apply` (workspace.ts) writes it, with
// the promotion, only when asked and only with a pull-request reference.
//
// `reproduce` re-runs a committed dossier: with the archived approved file and
// candidate, the same jobs, and the dossier's own record of its dependants. It
// runs only while the engine is the one the dossier pinned; otherwise it says
// PINNED and runs nothing.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import {
  CandidateDeclarationSchema, CandidateEvidenceSchema, LabPhaseResultSchema,
  type CandidateDeclaration, type LabMethodCheck, type LabPhaseResult, type LabRun,
} from '../../../src/algorithms/candidate-evidence';
import {
  ApprovalDossierSchema, DOSSIER_SCHEMA_VERSION, DossierDependantSchema, DossierReproducibleSchema, digestOf,
  type ApprovalDossier, type DossierDependant, type DossierLimit, type DossierReproducible,
} from '../../../src/algorithms/approval-dossier';
import { ALGORITHMS, algorithmOf } from '../../../src/algorithms/registry';
import { MONITORING_SPECS } from '../../../src/algorithms/monitoring-spec';
import { CANDIDATE_INDEX, type CandidateIndexEntry } from '../candidates';
import { LAB_LIMITS, type LabLimits } from '../spec';
import {
  CANDIDATE_FILE, CHILD, MeasuredLine, childLimitsOf, deterministicView, firstDifference, heldRun, linesOf, methodChecksOf, refusals, specOf,
} from '../evidence';
import { LAB_ROOT, runChild } from '../runner';
import { codeOf } from '../engine/code';
import { judge } from '../engine/judge';
import { readArchive } from './archive';
import { classifyDependants, type DependantPlan } from './dependants';
import { enginePin, type EnginePin } from './engine';
import { ReleaseRefusal, fingerprintOf, rewrite, runtimeImports, sha256 } from './source';
import { RELEASE_DIR_PREFIX, RELEASE_FILES } from './spec';

export interface ReleaseTexts { approved: string; candidate: string; promoted: string }

export interface ReleaseRunRecord { job: string; state: string; wallMs: number; outputHeld: boolean }

export interface ReleasePlan {
  candidate: string;
  algorithm: string | null;
  state: 'READY' | 'REFUSED';
  /** Why it cannot be approved; empty exactly when READY. */
  refusals: string[];
  dossier: ApprovalDossier | null;
  digest: string | null;
  dependants: Array<DependantPlan & { declared: boolean }>;
  /** The approved file, the candidate and the promoted file — each checked by fingerprint. */
  texts: ReleaseTexts | null;
  runs: ReleaseRunRecord[];
}

export interface PlanOptions {
  /** For tests: an allow-list and the directory its files are in. */
  index?: readonly CandidateIndexEntry[];
  candidatesDir?: string;
  /** For tests: the committed evidence the plan must agree with. */
  evidenceFile?: string;
}

const DeclarationLine = z.object({ kind: z.literal('declaration'), declaration: z.unknown() });
const DependantRunSchema = z.object({
  key: z.string(),
  properties: DossierDependantSchema.shape.properties.unwrap(),
  scenarios: DossierDependantSchema.shape.scenarios.unwrap(),
});
const ReleaseLine = z.object({
  kind: z.literal('result'),
  results: z.object({ development: LabPhaseResultSchema, heldOut: LabPhaseResultSchema }),
  dependants: z.array(DependantRunSchema),
  measured: MeasuredLine,
});
type DependantRun = z.infer<typeof DependantRunSchema>;

interface ReleaseRun {
  refusal: string | null;
  runs: ReleaseRunRecord[];
  declaration: CandidateDeclaration | null;
  methodChecks: LabMethodCheck[];
  results: { development: LabPhaseResult; heldOut: LabPhaseResult } | null;
  dependants: DependantRun[];
}

const completed = (limits: LabLimits): LabRun => ({ state: 'COMPLETED', exitCode: 0, signal: null, timeoutMs: limits.jobTimeoutMs, reasons: [] });

/**
 * The method checks, then `release:<id>` on the three texts — each in its own
 * child, from a directory made for this run and removed after it.
 */
async function runRelease(id: string, texts: ReleaseTexts, limits: LabLimits): Promise<ReleaseRun> {
  const out: ReleaseRun = { refusal: null, runs: [], declaration: null, methodChecks: [], results: null, dependants: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), RELEASE_DIR_PREFIX));
  try {
    for (const k of Object.keys(RELEASE_FILES) as Array<keyof ReleaseTexts>) fs.writeFileSync(path.join(dir, RELEASE_FILES[k]), texts[k]);
    const { outcome: mo, methodChecks } = await methodChecksOf(limits);
    out.runs.push({ job: 'method-checks', state: methodChecks.run.state, wallMs: mo.wallMs, outputHeld: mo.outputHeld });
    if (methodChecks.run.state !== 'COMPLETED') { out.refusal = `METHOD_CHECKS_${methodChecks.run.state}`; return out; }
    out.methodChecks = methodChecks.checks;

    const job = `release:${id}`;
    const ro = await runChild(CHILD, [job], childLimitsOf(limits), { typescript: true, env: { LAB_RELEASE_DIR: dir } });
    const held = heldRun(ro, limits.jobTimeoutMs);
    out.runs.push({ job, state: held ? held.state : ro.state, wallMs: ro.wallMs, outputHeld: ro.outputHeld });
    if (held) { out.refusal = `RUN_${held.state}`; return out; }
    if (ro.state !== 'COMPLETED') { out.refusal = `RUN_${ro.state}`; return out; }
    const lines = linesOf(ro.stdout);
    const decl = lines && lines.length === 2 ? DeclarationLine.safeParse(lines[0]) : null;
    const parsedDecl = decl?.success ? CandidateDeclarationSchema.safeParse(decl.data.declaration) : null;
    const result = lines && lines.length === 2 ? ReleaseLine.safeParse(lines[1]) : null;
    if (!parsedDecl?.success || !result?.success) { out.refusal = 'RUN_INVALID_OUTPUT'; return out; }
    out.declaration = parsedDecl.data;
    out.results = result.data.results;
    out.dependants = result.data.dependants;
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The dossier's record of each dependant: what was decided statically, and what the run measured for the ones it ran. */
function dependantRecords(plans: ReadonlyArray<DependantPlan>, runs: readonly DependantRun[]): DossierDependant[] {
  return plans.map((p) => {
    const run = p.path === 'CODE' && p.simulated ? runs.find((r) => r.key === p.key) ?? null : null;
    return {
      key: p.key, path: p.path, simulated: run !== null, calls: [...p.calls],
      properties: run ? run.properties : null, scenarios: run ? run.scenarios : null,
    };
  });
}

const brokenBy = (d: DossierDependant) => !!d.properties?.some((p) => p.outcome === 'BROKEN')
  || !!d.scenarios?.some((s) => s.invalid.candidate > s.invalid.approved);

function limitsOf(algorithm: string, dependants: readonly DossierDependant[]): DossierLimit[] {
  const out: DossierLimit[] = ['SYNTHETIC_ONLY', 'NO_REAL_WORLD_ACCURACY', 'HELD_OUT_SEEDS_VISIBLE'];
  if (dependants.some((d) => d.path === 'DATA')) out.push('DATA_DEPENDANTS_NOT_SIMULATED');
  if (!MONITORING_SPECS.some((s) => s.key === algorithm && s.instrumented)) out.push('NOT_OBSERVED_IN_PRODUCTION');
  return out;
}

/** The candidate's entry in the committed Step 4 evidence, when the file is valid and has one. */
function committedEntry(file: string, id: string) {
  try {
    const parsed = CandidateEvidenceSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.candidates.find((c) => c.id === id) ?? null : null;
  } catch { return null; }
}

export async function planRelease(candidateId: string, opts: PlanOptions = {}): Promise<ReleasePlan> {
  // The tree this file lives in: the registry it imports and the files it reads are one tree.
  const root = LAB_ROOT;
  const limits: LabLimits = { ...LAB_LIMITS };
  const out: ReleasePlan = {
    candidate: candidateId, algorithm: null, state: 'REFUSED', refusals: [], dossier: null, digest: null, dependants: [], texts: null, runs: [],
  };
  const refuse = (code: string) => { if (!out.refusals.includes(code)) out.refusals.push(code); };

  // ── what can be decided by reading ──
  const entry = (opts.index ?? CANDIDATE_INDEX).find((e) => e.id === candidateId);
  if (!entry || !CANDIDATE_FILE.test(entry.file)) { refuse('NOT_IN_ALLOW_LIST'); return out; }
  out.algorithm = entry.algorithm;
  const decl = algorithmOf(entry.algorithm);
  if (!decl || !decl.approval) { refuse('NO_APPROVED_BASELINE'); return out; }
  const symbols = decl.source.symbols;
  const candidateFile = path.join(opts.candidatesDir ?? path.join(root, 'lab', 'algorithms', 'candidates'), entry.file);
  const approvedText = fs.readFileSync(path.join(root, decl.source.file), 'utf8');
  const candidateText = fs.readFileSync(candidateFile, 'utf8');
  const code = codeOf(root, entry.algorithm, candidateFile);
  if (code.approvedFingerprint !== decl.approval.fingerprint) refuse('APPROVED_CODE_CHANGED');
  for (const s of code.symbols) if (s.status === 'MISSING') refuse(`SYMBOL_MISSING:${s.name.toLowerCase()}`);
  const changed = code.symbols.filter((s) => s.status === 'CHANGED').map((s) => s.name);
  if (!changed.length || !code.fingerprint) refuse('NO_CODE_CHANGE');
  if (runtimeImports(approvedText).length) refuse('SOURCE_NOT_SELF_CONTAINED');
  if (runtimeImports(candidateText).length) refuse('CANDIDATE_NOT_SELF_CONTAINED');
  if (out.refusals.length) return out;

  const neighbours = ALGORITHMS.filter((a) => a.key !== decl.key && a.source.file === decl.source.file).map((a) => ({ key: a.key, symbols: a.source.symbols }));
  let promoted: string;
  try {
    promoted = rewrite(approvedText, candidateText, symbols, changed, code.fingerprint as string, neighbours);
  } catch (err) {
    if (!(err instanceof ReleaseRefusal)) throw err;
    refuse(err.code);
    return out;
  }
  out.dependants = classifyDependants(root, entry.algorithm, changed);
  for (const d of out.dependants) {
    if (!d.declared) refuse(`UNDECLARED_DEPENDANT:${d.key}`);
    else if (d.path === 'CODE' && !d.simulated) refuse(`CODE_DEPENDANT_NOT_SIMULATED:${d.key}`);
  }
  if (out.refusals.length) return out;
  out.texts = { approved: approvedText, candidate: candidateText, promoted };

  // ── what has to be run: in children, never here ──
  const run = await runRelease(candidateId, out.texts, limits);
  out.runs = run.runs;
  if (run.refusal || !run.declaration || !run.results) { refuse(run.refusal ?? 'RUN_INVALID_OUTPUT'); return out; }
  const { declaration, methodChecks, results } = run;
  for (const r of refusals(entry, declaration, code)) refuse(r);
  if (!methodChecks.length || methodChecks.some((m) => !m.passed)) refuse('METHOD_CHECKS_NOT_PASSED');
  const verdict = judge({ run: completed(limits), methodChecks, declaration, results });
  if (verdict.test !== 'PASSED' || !verdict.agreement) refuse(`TEST_${verdict.test}`);
  const dependants = dependantRecords(out.dependants, run.dependants);
  for (const d of dependants) {
    if (d.path === 'CODE' && !d.simulated) refuse(`CODE_DEPENDANT_NOT_SIMULATED:${d.key}`);
    if (brokenBy(d)) refuse(`CODE_DEPENDANT_BROKEN:${d.key}`);
  }
  const seen = committedEntry(opts.evidenceFile ?? path.join(root, 'src', 'algorithms', 'generated', 'candidate-evidence.json'), candidateId);
  if (!seen || seen.verdict.test !== 'PASSED' || seen.code.fingerprint !== code.fingerprint
    || firstDifference(deterministicView(seen.results), deterministicView(results)) !== null) refuse('EVIDENCE_NOT_CURRENT');
  if (out.refusals.length) return out;

  // Parsed before it is hashed: the digest is of exactly what the dossier holds.
  const reproducible = DossierReproducibleSchema.parse({ declaration, spec: specOf(limits), methodChecks, results, verdict, dependants });
  const dossier = ApprovalDossierSchema.parse({
    schemaVersion: DOSSIER_SCHEMA_VERSION,
    kind: 'CHANGE_APPROVAL_DOSSIER',
    evidence: 'SYNTHETIC',
    algorithm: entry.algorithm,
    candidate: { id: candidateId, version: declaration.version, fingerprint: code.fingerprint },
    baseline: { version: declaration.baseline.version, fingerprint: declaration.baseline.fingerprint },
    engine: enginePin(root),
    test: { verdict: 'PASSED', agreement: verdict.agreement, methodChecks: { passed: methodChecks.length, total: methodChecks.length } },
    evidenceDigest: digestOf(reproducible),
    reproducible,
    promotion: {
      file: decl.source.file,
      symbols: code.symbols.map((s) => ({ name: s.name, status: s.status })),
      diff: code.diff,
      promotedFingerprint: fingerprintOf(promoted, symbols),
    },
    limits: limitsOf(entry.algorithm, dependants),
  });
  out.state = 'READY';
  out.dossier = dossier;
  out.digest = digestOf(dossier);
  return out;
}

// ── reproducing a committed dossier ─────────────────────────────────────────

export type Reproduction =
  | { state: 'REPRODUCED'; engine: string; runs: ReleaseRunRecord[] }
  | { state: 'PINNED'; engine: string; pinned: { specVersion: number; fingerprint: string; commit: string | null } }
  | { state: 'DIFFERENT'; at: string; runs: ReleaseRunRecord[] }
  | { state: 'UNAVAILABLE'; reason: string };

/**
 * Re-run a committed dossier's evidence from its archive and compare it with
 * the dossier — only while the engine is the one it pinned.
 */
export async function reproduceDossier(root: string, dossier: ApprovalDossier, pin: EnginePin = enginePin(root)): Promise<Reproduction> {
  if (pin.fingerprint !== dossier.engine.fingerprint || pin.specVersion !== dossier.engine.specVersion) {
    return { state: 'PINNED', engine: pin.fingerprint, pinned: { specVersion: dossier.engine.specVersion, fingerprint: dossier.engine.fingerprint, commit: dossier.engine.commit } };
  }
  const archive = readArchive(root, dossier.candidate.id);
  if (archive.state !== 'READY') return { state: 'UNAVAILABLE', reason: archive.reason };
  const symbols = dossier.promotion.symbols.map((s) => s.name);
  const changed = dossier.promotion.symbols.filter((s) => s.status === 'CHANGED').map((s) => s.name);
  if (fingerprintOf(archive.approved, symbols) !== dossier.baseline.fingerprint) return { state: 'UNAVAILABLE', reason: 'ARCHIVED_APPROVED_FILE_DIFFERS' };
  if (fingerprintOf(archive.candidate, symbols) !== dossier.candidate.fingerprint) return { state: 'UNAVAILABLE', reason: 'ARCHIVED_CANDIDATE_DIFFERS' };
  let promoted: string;
  try { promoted = rewrite(archive.approved, archive.candidate, symbols, changed, dossier.promotion.promotedFingerprint, []); } catch (err) {
    if (err instanceof ReleaseRefusal) return { state: 'UNAVAILABLE', reason: err.code };
    throw err;
  }
  if (sha256(promoted) !== archive.meta.promoted.sha256) return { state: 'UNAVAILABLE', reason: 'PROMOTED_TEXT_DIFFERS' };

  const limits: LabLimits = { ...LAB_LIMITS };
  const run = await runRelease(dossier.candidate.id, { approved: archive.approved, candidate: archive.candidate, promoted }, limits);
  if (run.refusal || !run.declaration || !run.results) return { state: 'UNAVAILABLE', reason: run.refusal ?? 'RUN_INVALID_OUTPUT' };
  const verdict = judge({ run: completed(limits), methodChecks: run.methodChecks, declaration: run.declaration, results: run.results });
  const dependants = dossier.reproducible.dependants.map((d) => {
    const r = d.simulated ? run.dependants.find((x) => x.key === d.key) ?? null : null;
    return { ...d, properties: r ? r.properties : null, scenarios: r ? r.scenarios : null };
  });
  const again: DossierReproducible = DossierReproducibleSchema.parse({
    declaration: run.declaration, spec: specOf(limits), methodChecks: run.methodChecks, results: run.results, verdict, dependants,
  });
  const at = firstDifference(deterministicView(dossier.reproducible), deterministicView(again));
  return at ? { state: 'DIFFERENT', at, runs: run.runs } : { state: 'REPRODUCED', engine: pin.fingerprint, runs: run.runs };
}
