// Familista — the approval dossier: the evidence a CHANGE approval is bound to
// ─────────────────────────────────────────────────────────────────────────────
// Algorithms Step 5. When the platform owner approves a candidate (Step 4) as
// a new version of an algorithm, the reviewed pull request that carries the
// approval also carries ONE dossier in src/algorithms/approvals/: the exact
// candidate, the approved version it replaces, the synthetic evidence it was
// judged on, the evaluation engine that produced that evidence, what the
// promotion changed in src/, and what the change does to the algorithms that
// depend on it.
//
// The registry's approval names the dossier and the SHA-256 of its canonical
// content (dossier-core.js). Edit one value and the digest no longer matches;
// CI and the Algorithms room both say so. A dossier is history: it is never
// rewritten — a later change is a new version with a new dossier.
//
// The engine is PINNED, not re-run forever: the dossier records the lab spec
// version, a fingerprint of every engine module the evidence came from, and
// the commit they were at. While the engine is unchanged, CI re-runs it and
// the result must agree with the dossier (every figure within 1e-9, relatively
// — floating point may differ in the last bits between Node versions; the
// digest is what proves the dossier itself was not edited). Once the engine
// has moved on, the evidence stays as it was, reproducible by checking out the
// pinned commit.
//
// Everything in a dossier is SYNTHETIC. It says how the change behaves on
// invented shots and which properties it keeps — never that it is more
// accurate on real matches. This module reads and validates; it writes
// nothing and runs nothing.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  CandidateDeclarationSchema, LabMethodCheckSchema, LabPhaseResultSchema, LabPropertyResultSchema,
  LabSpecSchema, LabVerdictSchema,
} from './candidate-evidence';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: { canonical(v: unknown): string; digestOf(v: unknown): string } = require('./dossier-core.js');

export const DOSSIER_SCHEMA_VERSION = 1;
export const DOSSIER_MAX_BYTES = 2 * 1024 * 1024;
/** Where dossiers live, beside this module in src/ and in dist/. */
export const DOSSIER_DIR = 'approvals';
/** A dossier file is a plain name in that directory — never a path. */
export const DOSSIER_FILE = /^[a-z0-9][a-z0-9.-]*\.json$/;

const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const Commit = z.string().regex(/^[0-9a-f]{40}$/);
const Version = z.string().regex(/^v\d+(?:\.\d+){0,3}$/);
const Id = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,47}$/);
const Count = z.number().int().nonnegative();
const Text = z.string().min(1).max(600);

/** A registered algorithm that depends on the changed one, and what the change does to it. */
export const DossierDependantSchema = z.object({
  key: Id,
  /**
   * CODE — its own code calls the changed code in-process, so the promoted
   *        version changes its output; it must be simulated.
   * DATA — it only reads values that were stored by something else; the
   *        promotion changes none of them, so there is nothing to simulate.
   */
  path: z.enum(['CODE', 'DATA']),
  simulated: z.boolean(),
  /** The changed symbols its own code calls — empty exactly when the path is DATA. */
  calls: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).max(32),
  /** CODE only: the same held-out probes, run through its approved and its promoted form, under its own titles. */
  properties: z.array(LabPropertyResultSchema.extend({ title: Text }).strict()).nullable(),
  /** CODE only: how its output moved on the held-out shot sets. */
  scenarios: z.array(z.object({
    id: Id, shots: Count, changed: Count, maxIncrease: z.number(), maxDecrease: z.number(),
    invalid: z.object({ approved: Count, candidate: Count }).strict(),
  }).strict()).nullable(),
}).strict();

/**
 * What a dossier's evidence cannot show, said in the dossier itself:
 *   SYNTHETIC_ONLY               every input was invented
 *   NO_REAL_WORLD_ACCURACY       nothing here compares a version with real outcomes
 *   HELD_OUT_SEEDS_VISIBLE       the held-out seeds are in an open repository
 *   DATA_DEPENDANTS_NOT_SIMULATED  a dependant reads stored values only, so the
 *                                promotion changes none of its inputs today and
 *                                nothing was run for it
 *   NOT_OBSERVED_IN_PRODUCTION   production telemetry does not record this
 *                                algorithm, so after release nothing measures it
 */
export const DossierLimitSchema = z.enum([
  'SYNTHETIC_ONLY', 'NO_REAL_WORLD_ACCURACY', 'HELD_OUT_SEEDS_VISIBLE', 'DATA_DEPENDANTS_NOT_SIMULATED', 'NOT_OBSERVED_IN_PRODUCTION',
]);
export type DossierLimit = z.infer<typeof DossierLimitSchema>;

/** The part of the evidence the engine can re-derive, and which CI reproduces while the engine is unchanged. */
export const DossierReproducibleSchema = z.object({
  declaration: CandidateDeclarationSchema,
  spec: LabSpecSchema,
  methodChecks: z.array(LabMethodCheckSchema).min(1),
  results: z.object({ development: LabPhaseResultSchema, heldOut: LabPhaseResultSchema }).strict(),
  verdict: LabVerdictSchema,
  dependants: z.array(DossierDependantSchema),
}).strict();

export const ApprovalDossierSchema = z.object({
  schemaVersion: z.literal(DOSSIER_SCHEMA_VERSION),
  kind: z.literal('CHANGE_APPROVAL_DOSSIER'),
  evidence: z.literal('SYNTHETIC'),
  algorithm: Id,
  candidate: z.object({ id: Id, version: Version, fingerprint: Fingerprint }).strict(),
  baseline: z.object({ version: Version, fingerprint: Fingerprint }).strict(),
  /** The evaluation engine the evidence came from, pinned. */
  engine: z.object({
    specVersion: z.number().int().positive(),
    fingerprint: Fingerprint,
    commit: Commit.nullable(),
    files: z.array(z.string().regex(/^[a-z][a-z0-9/._-]*\.(?:ts|js)$/)).min(1).max(64),
  }).strict(),
  /** The Test verdict a promotion needs, restated from the reproducible part. */
  test: z.object({
    verdict: z.literal('PASSED'),
    agreement: z.enum(['AGREE', 'DISAGREE']),
    methodChecks: z.object({ passed: Count, total: Count }).strict(),
  }).strict(),
  /** SHA-256 of `reproducible`'s canonical JSON — what a reproduction must arrive at. */
  evidenceDigest: Fingerprint,
  reproducible: DossierReproducibleSchema,
  /** What the promotion changed in src/: the approved file, symbol by symbol. */
  promotion: z.object({
    file: z.string().regex(/^src\/[a-z0-9/._-]+\.ts$/),
    symbols: z.array(z.object({ name: z.string().regex(/^[A-Za-z_$][\w$]*$/), status: z.enum(['SAME', 'CHANGED']) }).strict()).min(1),
    diff: z.array(z.object({ symbol: z.string(), removed: z.array(z.string()), added: z.array(z.string()) }).strict()).min(1),
    promotedFingerprint: Fingerprint,
  }).strict(),
  /** What the evidence cannot show. Recorded so nobody reads more into it than it holds. */
  limits: z.array(DossierLimitSchema).min(1),
}).strict();

export type ApprovalDossier = z.infer<typeof ApprovalDossierSchema>;
export type DossierDependant = z.infer<typeof DossierDependantSchema>;
export type DossierReproducible = z.infer<typeof DossierReproducibleSchema>;

/** SHA-256 of a value's canonical JSON — the one digest the registry, CI and this server use. */
export const digestOf = (value: unknown): string => core.digestOf(value);

export const DOSSIER_REASONS = {
  name: 'The dossier is not a plain file name in src/algorithms/approvals/.',
  missing: 'The dossier file is not on this server.',
  tooLarge: 'The dossier file is larger than allowed.',
  notJson: 'The dossier file is not valid JSON.',
  schema: 'The dossier file does not match its schema.',
} as const;

export type DossierRead =
  | { state: 'READY'; dossier: ApprovalDossier; digest: string }
  | { state: 'MISSING' | 'INVALID'; reason: string };

/**
 * Read and validate one dossier by its registry path
 * (`src/algorithms/approvals/<name>.json`), from beside this module: src/ when
 * run from TypeScript, dist/ when compiled. Never throws.
 */
export function readDossier(registryPath: string, dir: string = path.join(__dirname, DOSSIER_DIR)): DossierRead {
  const name = path.posix.basename(registryPath);
  if (registryPath !== `src/algorithms/${DOSSIER_DIR}/${name}` || !DOSSIER_FILE.test(name)) return { state: 'INVALID', reason: DOSSIER_REASONS.name };
  const file = path.join(dir, name);
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { state: 'MISSING', reason: DOSSIER_REASONS.missing }; }
  if (size > DOSSIER_MAX_BYTES) return { state: 'INVALID', reason: DOSSIER_REASONS.tooLarge };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { state: 'INVALID', reason: DOSSIER_REASONS.notJson }; }
  const parsed = ApprovalDossierSchema.safeParse(raw);
  if (!parsed.success) return { state: 'INVALID', reason: DOSSIER_REASONS.schema };
  return { state: 'READY', dossier: parsed.data, digest: digestOf(raw) };
}
