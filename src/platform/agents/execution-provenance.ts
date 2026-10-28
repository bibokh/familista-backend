// Execution provenance — what produced a published LAB dossier, and how that is checked
// ─────────────────────────────────────────────────────────────────────────────
// A v2 dossier (execution-evidence.ts) proves that it is internally
// consistent and that it is exactly the dossier whose digest was approved. Its
// chains are unkeyed, so it cannot prove where it came from: a dossier made up
// by hand, consistent in every part, would verify.
//
// Provenance closes that gap by REPRODUCTION, not by assertion. Every approved
// publication carries a provenance record beside its dossier,
// `<publication>.provenance.json`, which names:
//
//   definition  the canonical execution definition it ran: a reviewed file in
//               lab/orchestrator/definitions/ holding the synthetic request and
//               every operator step, by path and digest
//   source      the commit of this repository it ran at, and a digest over the
//               exact source of everything the run depends on: the engine, the
//               operations, the registry, the read matrix, the approver roles,
//               the roster, and the version of every package they import
//   replay      how it is checked: DETERMINISTIC_REPLAY
//
// None of that is believed. The publication gate (lab/orchestrator/
// publication-gate.ts, run by CI on every pull request and every push to main)
// re-checks each claim and replays the definition through the AI-0.4 engine:
// the definition must be that file, at that commit and at the head; the commit
// must already be on main; the source digest must be the source's at both; and
// the replay must reproduce the record digest and the dossier, byte for byte.
// The AI-0.4 record holds no clock and no random value, so a replay is exact or
// it is a difference; nothing is normalised away.
//
// What this server checks is narrower, because production runs nothing from
// the Lab: the record's shape and digest, and that it describes THIS dossier
// (publication, execution, record and dossier digests). A provenance record
// with the rehearsal revision is refused, as the rehearsal reference is.
//
// What it is not: it is not a signature. It proves the dossier is what the
// reviewed engine computes from a reviewed definition; it does not prove who
// ran it, and nothing here authenticates a person.

import { z } from 'zod';
import { EvidenceFields } from './orchestration-evidence';
import { digestOf, sha256 } from './trace-chain';

export const EXECUTION_PROVENANCE_CONTRACT = 'familista.evidence-provenance/v1' as const;
export const EXECUTION_DEFINITION_CONTRACT = 'familista.lab-definition/v1' as const;
export const PROVENANCE_REPOSITORY = 'bibokh/familista-backend' as const;
export const PROVENANCE_FILE = /^pub-[0-9a-f]{24}\.provenance\.json$/;
export const provenanceFileFor = (publicationId: string): string => `${publicationId}.provenance.json`;
export const DEFINITION_PATH = /^lab\/orchestrator\/definitions\/([a-z][a-z0-9-]{2,62})\.json$/;
export const PROVENANCE_MAX_BYTES = 16 * 1024;

/** A commit that cannot exist, which the Lab writes in a rehearsal. This server refuses it, so a rehearsal never stands as provenance. */
export const REHEARSAL_REVISION = '0'.repeat(40);
/** What a rehearsal writes for the source digest: it was never measured, so it is never a real one. */
export const REHEARSAL_SOURCE_DIGEST = sha256(`${EXECUTION_PROVENANCE_CONTRACT} rehearsal: no source was measured`);

export const PROVENANCE_STATEMENT = 'The publication gate replays this definition through the LAB execution engine at this source, and must reproduce this record and this dossier exactly, before the pull request that carries them can pass.';

const { Hex64 } = EvidenceFields;
const Name = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/);
const Package = z.object({ name: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/).max(80), version: z.string().regex(/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/).max(40) }).strict();

export const ExecutionProvenanceSchema = z.object({
  contract: z.literal(EXECUTION_PROVENANCE_CONTRACT),
  publicationId: z.string().regex(/^pub-[0-9a-f]{24}$/),
  executionId: z.string().regex(/^exec-[0-9a-f]{24}$/),
  /** The dossier and the record it was projected from, by digest. */
  dossierDigest: Hex64,
  recordDigest: Hex64,
  definition: z.object({
    contract: z.literal(EXECUTION_DEFINITION_CONTRACT),
    name: Name,
    path: z.string().regex(DEFINITION_PATH),
    /** digestOf the definition's JSON: what the gate replays. */
    digest: Hex64,
  }).strict(),
  source: z.object({
    repository: z.literal(PROVENANCE_REPOSITORY),
    /** The commit it ran at. The gate requires it to be on main already: reviewed and merged code. */
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    /** Over the exact bytes of every file the run imports, and every package version they load. */
    digest: Hex64,
    files: z.number().int().min(0).max(1000),
    packages: z.array(Package).max(40),
  }).strict(),
  replay: z.object({ method: z.literal('DETERMINISTIC_REPLAY'), steps: z.number().int().min(0).max(32) }).strict(),
  digest: Hex64,
}).strict();
export type ExecutionProvenance = z.infer<typeof ExecutionProvenanceSchema>;

/** The content a provenance record's digest covers: everything but the digest. */
export const provenanceDigest = (p: Omit<ExecutionProvenance, 'digest'> & { digest?: string }): string => {
  const { digest: _omit, ...rest } = p;
  return digestOf(rest);
};

/** The dossier a provenance record must describe. */
export interface ProvenanceSubject { publicationId: string; digest: string; source: { executionId: string; recordDigest: string } }

/**
 * Every reason this is not the provenance of `dossier`. Shape, digest, the
 * definition's name and path, and the binding to this one dossier; the
 * rehearsal revision is refused unless `rehearsal` (the Lab's read-back only).
 */
export function verifyProvenance(input: unknown, dossier: ProvenanceSubject, opts: { rehearsal?: boolean } = {}): { provenance: ExecutionProvenance | null; reasons: string[] } {
  const claimed = input && typeof input === 'object' ? (input as { contract?: unknown }).contract : undefined;
  if (claimed !== EXECUTION_PROVENANCE_CONTRACT) {
    return { provenance: null, reasons: [`provenance: ${typeof claimed === 'string' ? `"${claimed.slice(0, 60)}" is not a provenance version this server reads` : 'it names no contract'}; it must be ${EXECUTION_PROVENANCE_CONTRACT}`] };
  }
  const parsed = ExecutionProvenanceSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { provenance: null, reasons: [`provenance: ${i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'invalid'}`] };
  }
  const p = parsed.data;
  const reasons: string[] = [];
  if (provenanceDigest(p) !== p.digest) reasons.push('provenance: its digest is not the digest of its content');
  if (DEFINITION_PATH.exec(p.definition.path)?.[1] !== p.definition.name) reasons.push(`provenance: the definition ${p.definition.name} is not the file it names (${p.definition.path})`);
  if (p.publicationId !== dossier.publicationId) reasons.push(`provenance: it is the provenance of ${p.publicationId}, not of ${dossier.publicationId}`);
  if (p.executionId !== dossier.source.executionId) reasons.push('provenance: it names another execution');
  if (p.dossierDigest !== dossier.digest) reasons.push('provenance: it describes another dossier (digest)');
  if (p.recordDigest !== dossier.source.recordDigest) reasons.push('provenance: it describes another record (digest)');
  const rehearsed = p.source.revision === REHEARSAL_REVISION || p.source.digest === REHEARSAL_SOURCE_DIGEST;
  if (rehearsed && !opts.rehearsal) reasons.push('provenance: it names the rehearsal source, and a rehearsal is never provenance');
  return { provenance: reasons.length ? null : p, reasons };
}
