// Familista — what a promotion keeps, so it can be reproduced and undone
// ─────────────────────────────────────────────────────────────────────────────
// For each promoted candidate, three files in lab/algorithms/archive/, written
// by `apply` and removed only by `rollback`:
//
//   <id>.approved.ts    the approved source file exactly as it was before the
//                       promotion — the version the candidate was judged
//                       against, and the one a rollback restores
//   <id>.candidate.ts   the candidate file exactly as it was judged
//   <id>.json           what apply changed, so rollback can prove it is undoing
//                       that and nothing else: both versions' fingerprints and
//                       file digests, the registry entry before and after, the
//                       allow-list line, and the dossier
//
// The two .ts files sit at the same depth as candidates/, so the candidate's
// type-only imports still resolve. They are never imported by anything: a
// reproduction copies them into a release job's own directory and runs them in
// a child process, exactly as a plan does.

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ARCHIVE_DIR } from './spec';

const Id = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,47}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Version = z.string().regex(/^v\d+(?:\.\d+){0,3}$/);
const RepoPath = z.string().regex(/^[a-z][\w./-]{0,159}$/);

export const ARCHIVE_SCHEMA_VERSION = 1;

export const ArchiveMetaSchema = z.object({
  schemaVersion: z.literal(ARCHIVE_SCHEMA_VERSION),
  kind: z.literal('PROMOTION_ARCHIVE'),
  candidate: Id,
  algorithm: Id,
  source: z.object({ file: RepoPath, symbols: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).min(1) }).strict(),
  /** The version the promotion replaced, as its approval recorded it, and the file's SHA-256. */
  approved: z.object({ version: Version, fingerprint: Hex64, sha256: Hex64 }).strict(),
  /** The version the promotion wrote, and the file's SHA-256 right after it. */
  promoted: z.object({ version: Version, fingerprint: Hex64, sha256: Hex64 }).strict(),
  candidateFile: z.object({ file: RepoPath, sha256: Hex64 }).strict(),
  /** The allow-list line apply removed, and the line it followed. */
  allowList: z.object({ line: z.string().min(1).max(240), after: z.string().max(240) }).strict(),
  /** The algorithm's registry entry, exactly, before and after. */
  registry: z.object({ before: z.string().min(1).max(20_000), after: z.string().min(1).max(20_000) }).strict(),
  dossier: z.object({ file: RepoPath, digest: Hex64 }).strict(),
}).strict();

export type ArchiveMeta = z.infer<typeof ArchiveMetaSchema>;

/** Repository-relative paths of one promotion's archive. */
export function archivePaths(candidate: string): { approved: string; candidate: string; meta: string } {
  if (!Id.safeParse(candidate).success) throw new Error('not a candidate id');
  return {
    approved: `${ARCHIVE_DIR}/${candidate}.approved.ts`,
    candidate: `${ARCHIVE_DIR}/${candidate}.candidate.ts`,
    meta: `${ARCHIVE_DIR}/${candidate}.json`,
  };
}

export type ArchiveRead =
  | { state: 'READY'; meta: ArchiveMeta; approved: string; candidate: string }
  | { state: 'MISSING' | 'INVALID'; reason: string };

export function readArchive(root: string, candidate: string): ArchiveRead {
  const p = archivePaths(candidate);
  const abs = (f: string) => path.join(root, f);
  if (![p.approved, p.candidate, p.meta].every((f) => fs.existsSync(abs(f)))) return { state: 'MISSING', reason: 'ARCHIVE_MISSING' };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(abs(p.meta), 'utf8')); } catch { return { state: 'INVALID', reason: 'ARCHIVE_NOT_JSON' }; }
  const meta = ArchiveMetaSchema.safeParse(raw);
  if (!meta.success || meta.data.candidate !== candidate) return { state: 'INVALID', reason: 'ARCHIVE_SCHEMA' };
  return { state: 'READY', meta: meta.data, approved: fs.readFileSync(abs(p.approved), 'utf8'), candidate: fs.readFileSync(abs(p.candidate), 'utf8') };
}

/** Every promotion archived in a repository, by candidate id. */
export function archivedCandidates(root: string): string[] {
  const dir = path.join(root, ARCHIVE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9.-]*\.json$/.test(n)).map((n) => n.slice(0, -'.json'.length)).sort();
}
