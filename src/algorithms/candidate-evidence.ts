// Familista — candidate evidence, the only thing production knows about a candidate
// ─────────────────────────────────────────────────────────────────────────────
// Algorithms Step 4 adds Propose → Simulate → Test. A CANDIDATE is a proposed
// new version of an approved algorithm: separate code with its own version and
// fingerprint, a reason, and a hypothesis written down before it is measured.
//
// The candidate's code, and the engine that compares it with the approved
// version, live in lab/algorithms/ — OUTSIDE src/, so outside the production
// build. They run only in CI and on a developer's machine, each candidate in a
// separate process the lab kills when it overruns. What they found is written
// to src/algorithms/generated/candidate-evidence.json and committed; CI
// recomputes it and fails when it is stale.
//
// This file is the evidence's schema and its reader. The server never runs a
// candidate: it reads that file, validates it here, and shows it. A file that
// is missing, too large or does not match this schema is reported as such and
// never drawn from.
//
// Every candidate is EXPERIMENTAL and NOT_APPROVED here, by type: the schema
// has no other value for either. Approval exists only in the registry
// (src/algorithms/registry.ts), as a reviewed record of an exact version and
// fingerprint — and no candidate is in it.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

export const CANDIDATE_EVIDENCE_SCHEMA_VERSION = 1;

/** Said on every view of a candidate. The lab writes the same sentence into the evidence. */
export const CANDIDATE_NOTICE = 'Synthetic data: shows how a candidate differs from the approved version and which properties it keeps, not which is more accurate on real matches. Candidates are experimental and never run in production.';
/** Far above any real evidence file; a file this large is refused unread. */
export const CANDIDATE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;

const Id = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,47}$/);
const Prose = z.string().min(1).max(800);
const Version = z.string().regex(/^v\d+\.\d+(?:\.\d+)?$/);
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const Instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Code = z.string().regex(/^[A-Z][A-Z_]*(?::[a-z0-9][a-z0-9.-]*)?$/);
const RepoPath = z.string().regex(/^[\w./-]{1,160}$/);
const Count = z.number().int().nonnegative();

export const LabIntervalSchema = z.object({ value: z.number(), low: z.number(), high: z.number() });
export const LabPhaseSchema = z.enum(['DEVELOPMENT', 'HELD_OUT']);
export const LabWorldSchema = z.enum(['APPROVED', 'CANDIDATE']);

// ── what was declared before anything was measured ──────────────────────────

export const LabSpecSchema = z.object({
  version: z.number().int().positive(),
  algorithms: z.array(Id),
  mixes: z.array(z.object({
    id: Id, title: Prose, purpose: Prose,
    x: z.tuple([z.number(), z.number()]), y: z.tuple([z.number(), z.number()]),
  })),
  worlds: z.array(z.object({ id: LabWorldSchema, title: Prose, meaning: Prose })),
  scenarios: z.array(z.object({ id: Id, phase: LabPhaseSchema, mix: Id, shots: Count, seed: z.number().int() })),
  probeSets: z.array(z.object({ phase: LabPhaseSchema, seed: z.number().int(), instances: Count })),
  properties: z.record(z.array(z.object({ id: Id, title: Prose, kind: z.enum(['RANDOM', 'FIXED']), stepOne: Prose }))),
  rules: z.object({
    minChangedShots: Count,
    minRegionProbes: Count,
    ciLevel: z.number(),
    alpha: z.number(),
    power: z.number(),
    bootstrapResamples: Count,
    nearGoalShare: z.number(),
    nearGoalRadius: z.number(),
    distanceBands: z.array(z.number()),
  }),
  justifications: z.object({
    minChangedShots: Prose, minRegionProbes: Prose, bracket: Prose, requiredShots: Prose, heldOut: Prose, probes: Prose,
  }),
  limits: z.object({
    shotsPerScenarioMax: Count, scenariosMax: Count, probeInstancesMax: Count, bootstrapResamples: Count,
    candidatesMax: Count, jobTimeoutMs: Count, childHeapMb: Count, maxStdoutBytes: Count, maxStderrBytes: Count,
  }),
  conditionalNote: Prose,
});

// ── one run of one child process ─────────────────────────────────────────────

export const LabRunStateSchema = z.enum([
  'COMPLETED', 'TIMED_OUT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'CRASHED', 'INVALID_OUTPUT', 'REFUSED',
]);
export const LabRunSchema = z.object({
  state: LabRunStateSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(),
  timeoutMs: Count,
  reasons: z.array(Code),
});
/** What a run cost. Measured, so it differs run to run and is left out of the freshness check. */
export const LabMeasuredSchema = z.object({
  wallMs: z.number().nullable(),
  startupMs: z.number().nullable(),
  evaluationMs: z.number().nullable(),
  cpuUserMs: z.number().nullable(),
  cpuSystemMs: z.number().nullable(),
  maxRssBytes: z.number().nullable(),
  heapUsedBytes: z.number().nullable(),
  predictions: z.number().int().nullable(),
  approvedNsPerCall: z.number().nullable(),
  candidateNsPerCall: z.number().nullable(),
});

export const LabMethodCheckSchema = z.object({
  id: Id, title: Prose, purpose: Prose,
  expected: Code, observed: Code.nullable(), passed: z.boolean(),
});

// ── the candidate as its author declared it ─────────────────────────────────

export const CandidateDeclarationSchema = z.object({
  id: Id,
  algorithm: Id,
  version: Version,
  baseline: z.object({ version: Version, fingerprint: Fingerprint }),
  rationale: Prose,
  hypothesis: z.object({ targets: z.array(Id), region: Prose }),
  evidence: z.array(z.object({
    kind: z.enum(['MEASUREMENT', 'GEOMETRY', 'PROPERTY']),
    ref: z.string().min(1).max(120),
    note: Prose,
  })).min(1),
  // A role, never a person.
  proposedBy: z.enum(['PLATFORM_OWNER', 'AI_ASSISTANT']),
  proposedAt: Day,
});

export const LabCodeSchema = z.object({
  file: RepoPath,
  approvedFile: RepoPath,
  fingerprint: Fingerprint.nullable(),
  approvedFingerprint: Fingerprint.nullable(),
  symbols: z.array(z.object({ name: z.string().regex(/^[A-Za-z_$][\w$]*$/), status: z.enum(['SAME', 'CHANGED', 'MISSING']) })),
  diff: z.array(z.object({ symbol: z.string(), removed: z.array(z.string().max(240)), added: z.array(z.string().max(240)) })),
  dependants: z.array(z.object({ key: Id, simulated: z.boolean() })),
});

// ── what was measured ───────────────────────────────────────────────────────

export const LabRequiredSchema = z.object({
  status: z.enum(['ESTIMATED', 'UNSTABLE', 'UNDEFINED']),
  point: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  reasons: z.array(Code),
});

export const LabScenarioResultSchema = z.object({
  id: Id,
  phase: LabPhaseSchema,
  mix: Id,
  shots: Count,
  seed: z.number().int(),
  invalid: z.object({ approved: Count, candidate: Count }),
  divergence: z.object({
    changed: Count,
    share: LabIntervalSchema,
    meanAbsDelta: z.number(),
    maxIncrease: z.number(),
    maxDecrease: z.number(),
    bands: z.array(z.object({ from: z.number(), to: z.number().nullable(), shots: Count, changed: Count, meanDelta: z.number().nullable() })),
  }),
  worlds: z.array(z.object({
    world: LabWorldSchema,
    goals: Count,
    status: z.enum(['COMPUTED', 'NOT_ENOUGH_DATA', 'NO_DIFFERENCE']),
    brierDelta: LabIntervalSchema.nullable(),
    logLossDelta: LabIntervalSchema.nullable(),
    distinguishable: z.boolean().nullable(),
    required: LabRequiredSchema,
  })),
});

const LabExampleSchema = z.object({
  points: z.array(z.object({ x: z.number(), y: z.number(), bodyPart: z.string().max(24) })),
  values: z.array(z.number().nullable()),
}).nullable();

export const LabPropertyResultSchema = z.object({
  id: Id,
  instances: Count,
  inRegion: Count,
  approved: z.object({ violations: Count, invalid: Count, example: LabExampleSchema }),
  candidate: z.object({ violations: Count, invalid: Count, example: LabExampleSchema }),
  outcome: z.enum(['KEPT', 'FIXED', 'BROKEN', 'STILL_FAILING']),
  covered: z.boolean(),
});

export const LabPhaseResultSchema = z.object({
  phase: LabPhaseSchema,
  scenarios: z.array(LabScenarioResultSchema),
  properties: z.array(LabPropertyResultSchema),
});

export const LabVerdictSchema = z.object({
  test: z.enum(['PASSED', 'FAILED', 'INCONCLUSIVE', 'UNAVAILABLE']),
  reasons: z.array(Code),
  agreement: z.enum(['AGREE', 'DISAGREE']).nullable(),
});

export const CandidateEntrySchema = z.object({
  id: Id,
  algorithm: Id,
  file: RepoPath,
  status: z.literal('EXPERIMENTAL'),
  approval: z.literal('NOT_APPROVED'),
  declaration: CandidateDeclarationSchema.nullable(),
  code: LabCodeSchema,
  run: LabRunSchema,
  results: z.object({ development: LabPhaseResultSchema, heldOut: LabPhaseResultSchema }).nullable(),
  verdict: LabVerdictSchema,
  measured: LabMeasuredSchema,
});

export const CandidateEvidenceSchema = z.object({
  schemaVersion: z.literal(CANDIDATE_EVIDENCE_SCHEMA_VERSION),
  generatedBy: z.literal('lab/algorithms'),
  evidence: z.literal('SYNTHETIC'),
  production: z.literal('NEVER_RUN'),
  notice: Prose,
  spec: LabSpecSchema,
  methodChecks: z.object({ run: LabRunSchema, checks: z.array(LabMethodCheckSchema), measured: LabMeasuredSchema }),
  candidates: z.array(CandidateEntrySchema).max(5),
  measured: z.object({ generatedAt: Instant, node: z.string().max(40), platform: z.string().max(40) }),
});

export type LabInterval = z.infer<typeof LabIntervalSchema>;
export type LabPhase = z.infer<typeof LabPhaseSchema>;
export type LabWorld = z.infer<typeof LabWorldSchema>;
export type LabSpec = z.infer<typeof LabSpecSchema>;
export type LabRun = z.infer<typeof LabRunSchema>;
export type LabRunState = z.infer<typeof LabRunStateSchema>;
export type LabMeasured = z.infer<typeof LabMeasuredSchema>;
export type LabMethodCheck = z.infer<typeof LabMethodCheckSchema>;
export type CandidateDeclaration = z.infer<typeof CandidateDeclarationSchema>;
export type LabCode = z.infer<typeof LabCodeSchema>;
export type LabRequired = z.infer<typeof LabRequiredSchema>;
export type LabScenarioResult = z.infer<typeof LabScenarioResultSchema>;
export type LabPropertyResult = z.infer<typeof LabPropertyResultSchema>;
export type LabPhaseResult = z.infer<typeof LabPhaseResultSchema>;
export type LabVerdict = z.infer<typeof LabVerdictSchema>;
export type CandidateEntry = z.infer<typeof CandidateEntrySchema>;
export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;

// ── the reader ───────────────────────────────────────────────────────────────

export const CANDIDATE_EVIDENCE_FILE = path.join(__dirname, 'generated', 'candidate-evidence.json');

export type CandidateEvidenceRead =
  | { state: 'READY'; evidence: CandidateEvidence }
  | { state: 'NOT_GENERATED' | 'INVALID'; reason: string };

export const EVIDENCE_REASONS = {
  missing: 'The candidate evidence is not beside this server.',
  tooLarge: 'The candidate evidence file is larger than any real one, so it was not read.',
  notJson: 'The candidate evidence file is not valid JSON.',
  schema: 'The candidate evidence file does not match its schema, so nothing in it is shown.',
} as const;

let cached: CandidateEvidenceRead | null = null;

/**
 * The evidence that shipped with this build, validated. Read once per process:
 * the file is part of the build and cannot change under a running server.
 */
export function readCandidateEvidence(file: string = CANDIDATE_EVIDENCE_FILE): CandidateEvidenceRead {
  const useCache = file === CANDIDATE_EVIDENCE_FILE;
  if (useCache && cached) return cached;
  const result = readFrom(file);
  if (useCache) cached = result;
  return result;
}

function readFrom(file: string): CandidateEvidenceRead {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { state: 'NOT_GENERATED', reason: EVIDENCE_REASONS.missing }; }
  if (size > CANDIDATE_EVIDENCE_MAX_BYTES) return { state: 'INVALID', reason: EVIDENCE_REASONS.tooLarge };
  let json: unknown;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { state: 'INVALID', reason: EVIDENCE_REASONS.notJson }; }
  const parsed = CandidateEvidenceSchema.safeParse(json);
  if (!parsed.success) return { state: 'INVALID', reason: EVIDENCE_REASONS.schema };
  return { state: 'READY', evidence: parsed.data };
}

/** For tests: forget the cached read. */
export function resetCandidateEvidence(): void { cached = null; }
