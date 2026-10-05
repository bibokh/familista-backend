// Familista — assembling candidate evidence, in the parent process
// ─────────────────────────────────────────────────────────────────────────────
// Starts one child per job (runner.ts) — the method checks first, then each
// candidate on the allow-list, one at a time — and builds
// src/algorithms/generated/candidate-evidence.json from what they report.
//
// The parent trusts nothing a child says until it has been validated against
// the same schema the server reads with. It then:
//
//   refuses   a declaration that does not match its allow-list entry, names a
//             baseline that is not the current approval, reuses a version,
//             targets a property that does not exist, or changes no code
//   reads     the candidate's code as text (engine/code.ts) — fingerprint,
//             changed declarations, dependants — without executing it
//   judges    the Test verdict from held-out results only (engine/judge.ts)
//
// Every figure is deterministic for its seeds except what a run cost, which
// sits under `measured` keys. The freshness check compares everything else, so
// a stale or hand-edited evidence file fails CI.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  CANDIDATE_EVIDENCE_SCHEMA_VERSION, CandidateDeclarationSchema, CandidateEvidenceSchema, LabMethodCheckSchema,
  LabPhaseResultSchema, type CandidateEntry, type CandidateEvidence, type LabMeasured, type LabRun,
} from '../../src/algorithms/candidate-evidence';
import { algorithmOf } from '../../src/algorithms/registry';
import { CANDIDATE_INDEX, type CandidateIndexEntry } from './candidates';
import {
  CANDIDATE_ALGORITHMS, CONDITIONAL_NOTE, LAB_JUSTIFICATIONS, LAB_LIMITS, LAB_NOTICE, LAB_RULES, LAB_SPEC_VERSION,
  PROBE_SETS, PROPERTIES, SCENARIOS, SHOT_MIXES, WORLDS, type LabLimits,
} from './spec';
import { LAB_ROOT, runChild, type ChildOutcome } from './runner';
import { codeOf } from './engine/code';
import { judge } from './engine/judge';

export const EVIDENCE_FILE = path.join(LAB_ROOT, 'src', 'algorithms', 'generated', 'candidate-evidence.json');
const CHILD = path.join(__dirname, 'child.ts');

export interface BuildOptions {
  /** The allow-list to run. Defaults to candidates/index.ts. */
  index?: readonly CandidateIndexEntry[];
  /** For tests: a fixture allow-list under tests/fixtures/lab/, repository-relative, for the children to load. */
  fixtureIndex?: string;
  /** For tests: tighter limits. */
  limits?: Partial<LabLimits>;
  now?: Date;
}

export interface BuildResult {
  evidence: CandidateEvidence;
  /** Every child the build started, with how it ended. */
  children: Array<{ job: string; outcome: ChildOutcome }>;
}

const MeasuredLine = z.object({
  wallMs: z.null(), startupMs: z.number(), evaluationMs: z.number(), cpuUserMs: z.number(), cpuSystemMs: z.number(),
  maxRssBytes: z.number(), heapUsedBytes: z.number(), predictions: z.number().int(),
  approvedNsPerCall: z.number().nullable(), candidateNsPerCall: z.number().nullable(),
});
const MethodLine = z.object({ kind: z.literal('result'), checks: z.array(LabMethodCheckSchema), measured: MeasuredLine });
const DeclarationLine = z.object({ kind: z.literal('declaration'), declaration: z.unknown() });
const ResultLine = z.object({
  kind: z.literal('result'),
  results: z.object({ development: LabPhaseResultSchema, heldOut: LabPhaseResultSchema }),
  measured: MeasuredLine,
});

const NO_MEASURE: LabMeasured = {
  wallMs: null, startupMs: null, evaluationMs: null, cpuUserMs: null, cpuSystemMs: null, maxRssBytes: null,
  heapUsedBytes: null, predictions: null, approvedNsPerCall: null, candidateNsPerCall: null,
};

/**
 * The complete JSON lines a child printed — a line cut off by a kill is not
 * one. Null when a complete line is not JSON.
 */
function linesOf(stdout: string): unknown[] | null {
  const out: unknown[] = [];
  const complete = stdout.split('\n').slice(0, -1);
  for (const line of complete) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { return null; }
  }
  return out;
}

/** An allow-list file is a plain name in the candidates directory — never a path. */
export const CANDIDATE_FILE = /^[a-z0-9][a-z0-9.-]*\.ts$/;

function runOf(outcome: ChildOutcome, timeoutMs: number, state: LabRun['state'] = outcome.state, reasons: string[] = []): LabRun {
  return { state, exitCode: outcome.exitCode, signal: outcome.signal, timeoutMs, reasons };
}

/** Why a run's report was refused when its output was still held open after it ended. */
export const OUTPUT_HELD = 'OUTPUT_HELD_BY_DESCENDANT';

/**
 * A child whose output a process it started still held open after the child
 * exited (runner.ts, outputHeld) is never accepted, whatever it reported: the
 * run is refused with OUTPUT_HELD, so the verdict is Unavailable. Null when the
 * output closed with the child.
 */
export function heldRun(outcome: ChildOutcome, timeoutMs: number): LabRun | null {
  if (!outcome.outputHeld) return null;
  return runOf(outcome, timeoutMs, outcome.state === 'COMPLETED' ? 'INVALID_OUTPUT' : outcome.state, [OUTPUT_HELD]);
}

function spec(limits: LabLimits): CandidateEvidence['spec'] {
  return {
    version: LAB_SPEC_VERSION,
    algorithms: [...CANDIDATE_ALGORITHMS],
    mixes: SHOT_MIXES.map((m) => ({ id: m.id, title: m.title, purpose: m.purpose, x: [m.x[0], m.x[1]], y: [m.y[0], m.y[1]] })),
    worlds: WORLDS.map((w) => ({ ...w })),
    scenarios: SCENARIOS.map((s) => ({ ...s })),
    probeSets: PROBE_SETS.map((p) => ({ ...p })),
    properties: Object.fromEntries(Object.entries(PROPERTIES).map(([k, list]) => [k, list.map((p) => ({ ...p }))])),
    rules: {
      minChangedShots: LAB_RULES.minChangedShots,
      minRegionProbes: LAB_RULES.minRegionProbes,
      ciLevel: LAB_RULES.ciLevel,
      alpha: LAB_RULES.alpha,
      power: LAB_RULES.power,
      bootstrapResamples: LAB_RULES.bootstrapResamples,
      nearGoalShare: LAB_RULES.nearGoalShare,
      nearGoalRadius: LAB_RULES.nearGoalRadius,
      distanceBands: [...LAB_RULES.distanceBands],
    },
    justifications: { ...LAB_JUSTIFICATIONS },
    limits: { ...limits },
    conditionalNote: CONDITIONAL_NOTE,
  };
}

/** Why a declaration cannot be evaluated against today's approved version; empty when it can. */
function refusals(entry: CandidateIndexEntry, declaration: z.infer<typeof CandidateDeclarationSchema>, code: CandidateEntry['code']): string[] {
  const out: string[] = [];
  const decl = algorithmOf(entry.algorithm);
  if (declaration.id !== entry.id || declaration.algorithm !== entry.algorithm) out.push('DECLARATION_MISMATCH');
  if (!decl || !decl.approval) return [...out, 'NO_APPROVED_BASELINE'];
  if (declaration.baseline.version !== decl.approval.version || declaration.baseline.fingerprint !== decl.approval.fingerprint) out.push('BASELINE_NOT_CURRENT');
  if (declaration.version === decl.version || decl.versions.some((v) => v.version === declaration.version)) out.push('VERSION_ALREADY_USED');
  const known = new Set<string>(PROPERTIES[entry.algorithm].map((p) => p.id));
  for (const t of declaration.hypothesis.targets) if (!known.has(t)) out.push(`UNKNOWN_TARGET:${t}`);
  if (!code.fingerprint) out.push('FINGERPRINT_UNAVAILABLE');
  else if (code.fingerprint === code.approvedFingerprint) out.push('NO_CODE_CHANGE');
  if (code.approvedFingerprint !== decl.approval.fingerprint) out.push('APPROVED_CODE_CHANGED');
  return out;
}

export async function buildEvidence(opts: BuildOptions = {}): Promise<BuildResult> {
  const limits: LabLimits = { ...LAB_LIMITS, ...(opts.limits ?? {}) };
  const index = opts.index ?? CANDIDATE_INDEX;
  if (index.length > limits.candidatesMax) throw new Error(`${index.length} candidates exceed the limit of ${limits.candidatesMax}`);
  for (const e of index) if (!CANDIDATE_FILE.test(e.file)) throw new Error(`allow-list entry ${e.id}: ${e.file} is not a plain file name`);
  const childLimits = { timeoutMs: limits.jobTimeoutMs, heapMb: limits.childHeapMb, maxStdoutBytes: limits.maxStdoutBytes, maxStderrBytes: limits.maxStderrBytes };
  const env = opts.fixtureIndex ? { LAB_CANDIDATE_INDEX: opts.fixtureIndex } : undefined;
  const candidatesDir = opts.fixtureIndex ? path.dirname(path.resolve(LAB_ROOT, opts.fixtureIndex)) : path.join(__dirname, 'candidates');
  const children: BuildResult['children'] = [];

  // ── the method checks itself first ──
  const mo = await runChild(CHILD, ['method-checks'], childLimits, { typescript: true });
  children.push({ job: 'method-checks', outcome: mo });
  const mHeld = heldRun(mo, limits.jobTimeoutMs);
  const mLines = mo.state === 'COMPLETED' && !mHeld ? linesOf(mo.stdout) : null;
  const mParsed = mLines && mLines.length === 1 ? MethodLine.safeParse(mLines[0]) : null;
  const methodChecks = mParsed?.success
    ? { run: runOf(mo, limits.jobTimeoutMs), checks: mParsed.data.checks, measured: { ...mParsed.data.measured, wallMs: mo.wallMs } }
    : { run: mHeld ?? runOf(mo, limits.jobTimeoutMs, mo.state === 'COMPLETED' ? 'INVALID_OUTPUT' : mo.state), checks: [], measured: { ...NO_MEASURE, wallMs: mo.wallMs } };

  // ── each candidate, one at a time ──
  const candidates: CandidateEntry[] = [];
  for (const entry of index) {
    const job = `candidate:${entry.id}`;
    const outcome = await runChild(CHILD, [job], childLimits, { typescript: true, env });
    children.push({ job, outcome });
    const code = codeOf(LAB_ROOT, entry.algorithm, path.join(candidatesDir, entry.file));

    // A killed child may still have said what it proposed: its first line arrives before any work.
    const lines = linesOf(outcome.stdout) ?? [];
    const declLine = lines.length ? DeclarationLine.safeParse(lines[0]) : null;
    const declParsed = declLine?.success ? CandidateDeclarationSchema.safeParse(declLine.data.declaration) : null;
    const declaration = declParsed?.success ? declParsed.data : null;
    const resultLine = lines.length === 2 ? ResultLine.safeParse(lines[1]) : null;

    let run: LabRun;
    let results: CandidateEntry['results'] = null;
    let measured: LabMeasured = { ...NO_MEASURE, wallMs: outcome.wallMs };
    const held = heldRun(outcome, limits.jobTimeoutMs);
    if (held) run = held;
    else if (outcome.state !== 'COMPLETED') run = runOf(outcome, limits.jobTimeoutMs);
    else if (!declaration || !resultLine?.success) run = runOf(outcome, limits.jobTimeoutMs, 'INVALID_OUTPUT', declaration ? [] : ['DECLARATION_INVALID']);
    else {
      const refused = refusals(entry, declaration, code);
      if (refused.length) run = runOf(outcome, limits.jobTimeoutMs, 'REFUSED', refused);
      else { run = runOf(outcome, limits.jobTimeoutMs); results = resultLine.data.results; }
      measured = { ...resultLine.data.measured, wallMs: outcome.wallMs };
    }
    candidates.push({
      id: entry.id, algorithm: entry.algorithm, file: code.file,
      status: 'EXPERIMENTAL', approval: 'NOT_APPROVED',
      declaration, code, run, results,
      verdict: judge({ run, methodChecks: methodChecks.checks, declaration, results }),
      measured,
    });
  }

  const evidence = CandidateEvidenceSchema.parse({
    schemaVersion: CANDIDATE_EVIDENCE_SCHEMA_VERSION,
    generatedBy: 'lab/algorithms',
    evidence: 'SYNTHETIC',
    production: 'NEVER_RUN',
    notice: LAB_NOTICE,
    spec: spec(limits),
    methodChecks,
    candidates,
    measured: { generatedAt: (opts.now ?? new Date()).toISOString(), node: process.version, platform: `${process.platform}-${process.arch}` },
  });
  return { evidence, children };
}

// ── freshness: everything but what a run cost ───────────────────────────────

/** A copy without any `measured` key, at any depth. */
export function deterministicView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deterministicView);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'measured').map(([k, v]) => [k, deterministicView(v)]));
  }
  return value;
}

/** The first path at which two evidence views differ, or null. Numbers agree within 1e-9, relatively. */
export function firstDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : at;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return at;
    for (let i = 0; i < a.length; i += 1) { const d = firstDifference(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort(); const kb = Object.keys(b as object).sort();
    if (ka.join('\u0000') !== kb.join('\u0000')) return at;
    for (const k of ka) { const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : at;
}

export function readCommittedEvidence(file: string = EVIDENCE_FILE): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeEvidence(evidence: CandidateEvidence, file: string = EVIDENCE_FILE): void {
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
}
