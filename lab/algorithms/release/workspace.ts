// Familista — writing a promotion into the repository, and taking it back out
// ─────────────────────────────────────────────────────────────────────────────
// `apply` turns a READY plan into the change a pull request carries. It
// refuses unless it is given the reference of that pull request, and unless
// nothing it reads has moved since the plan. Then, and only then, it writes:
//
//   src/algorithms/approvals/<id>.json   the dossier, never to be edited again
//   <algorithm's source file>            the changed declarations, nothing else
//   src/algorithms/registry.ts           the algorithm's entry: the new version,
//                                        a CHANGE approval bound to the dossier,
//                                        and a line of version history
//   lab/algorithms/candidates/           the candidate leaves the allow-list —
//                                        it is the approved version now
//   lab/algorithms/archive/              what rollback and reproduction need
//                                        (archive.ts)
//
// and regenerates the three files CI checks are current: the algorithm
// manifest, the candidate evidence, and the Cybersecurity manifest (whose list
// of files it read moves when a candidate file does). It commits nothing, pushes nothing and approves
// nothing: the approval takes effect only when the platform owner merges the
// reviewed pull request, and reaches production only through the CI-gated
// deploy.
//
// `rollback` is apply's exact inverse, for a promotion whose archive is still
// in the tree: it proves the files are as apply left them, restores the
// approved declarations from the archive (and, when nothing else in the file
// has moved, the file byte for byte), puts back the registry entry and the
// allow-list line, and removes what apply added. After a promotion has been
// merged, rolling back is a pull request too — reviewed, CI-gated, deployed —
// whether its diff came from this command or from `git revert`; the dossier and
// the promotion stay in the repository's history.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readDossier, digestOf } from '../../../src/algorithms/approval-dossier';
import { PULL_REQUEST_REFERENCE } from '../../../src/algorithms/release';
import { ALGORITHMS, algorithmOf } from '../../../src/algorithms/registry';
import { LAB_ROOT } from '../runner';
import { ArchiveMetaSchema, archivePaths, readArchive, ARCHIVE_SCHEMA_VERSION, type ArchiveMeta } from './archive';
import type { ReleasePlan } from './dossier';
import { ReleaseRefusal, changedSymbols, fingerprintOf, rewrite, sha256 } from './source';
import { APPROVALS_DIR, PROMOTION_NOTE } from './spec';

const REGISTRY = 'src/algorithms/registry.ts';
const ALLOW_LIST = 'lab/algorithms/candidates/index.ts';
const CANDIDATES = 'lab/algorithms/candidates';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface WriteReport { written: string[]; removed: string[]; regenerated: string[] }

export interface ApplyOptions {
  /** `<owner>/<repo>#<number>`: the pull request that carries this approval. */
  reference: string;
  /** The date the approval is recorded with, yyyy-mm-dd. */
  approvedAt: string;
  /** Regenerate the manifest and the candidate evidence. On by default. */
  regenerate?: boolean;
}

// ── the registry entry, as text ─────────────────────────────────────────────

const entryHead = (key: string) => `\n  {\n    key: '${key}',`;

/** The algorithm's entry in the registry's text: from its opening brace to its closing `},`. */
export function registryEntry(registry: string, key: string): { start: number; end: number; text: string } {
  const head = entryHead(key);
  const start = registry.indexOf(head);
  if (start < 0 || registry.indexOf(head, start + 1) >= 0) throw new ReleaseRefusal('REGISTRY_ENTRY_NOT_FOUND');
  const close = registry.indexOf('\n  },', start + head.length);
  if (close < 0) throw new ReleaseRefusal('REGISTRY_ENTRY_NOT_FOUND');
  const end = close + '\n  },'.length;
  return { start, end, text: registry.slice(start, end) };
}

const VERSION_LINE = /\n {4}version: '([^']+)',\n/;
const APPROVAL = /\n {4}approval: (?:baseline\('[^'\n]*', '[0-9a-f]{64}'\)|change\(\{\n[\s\S]*?\n {4}\}\)),\n/;
const FIRST_VERSION = /\n {4}versions: firstVersion\('([^']+)'\),\n/;
const VERSION_LIST = /\n {4}versions: \[\n([\s\S]*?)\n {4}\],\n/;
const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export interface ChangeFields {
  version: string; fingerprint: string; candidate: string;
  baseline: { version: string; fingerprint: string };
  dossier: { file: string; digest: string };
  reference: string; approvedAt: string;
}

/**
 * The entry with the new version, a CHANGE approval in the shape the
 * registry's FORMAT NOTE fixes (version and fingerprint first — the change
 * gate reads them there), and one more line of history.
 */
export function promotedEntry(entry: string, c: ChangeFields): string {
  const v = VERSION_LINE.exec(entry);
  if (!v || entry.match(new RegExp(VERSION_LINE.source, 'g'))?.length !== 1) throw new ReleaseRefusal('REGISTRY_ENTRY_SHAPE');
  if (v[1] !== c.baseline.version) throw new ReleaseRefusal('REGISTRY_VERSION_IS_NOT_THE_BASELINE');
  if (!APPROVAL.test(entry)) throw new ReleaseRefusal('REGISTRY_ENTRY_SHAPE');
  const approval = [
    '\n    approval: change({',
    `      version: ${quote(c.version)}, fingerprint: ${quote(c.fingerprint)},`,
    `      candidate: ${quote(c.candidate)}, baseline: { version: ${quote(c.baseline.version)}, fingerprint: ${quote(c.baseline.fingerprint)} },`,
    `      dossier: { file: ${quote(c.dossier.file)}, digest: ${quote(c.dossier.digest)} },`,
    `      reference: ${quote(c.reference)}, approvedAt: ${quote(c.approvedAt)},`,
    '    }),\n',
  ].join('\n');
  const history = `      { version: ${quote(c.version)}, date: ${quote(c.approvedAt)}, note: ${quote(PROMOTION_NOTE)} },`;
  let out = entry.replace(VERSION_LINE, () => `\n    version: ${quote(c.version)},\n`).replace(APPROVAL, () => approval);
  if (FIRST_VERSION.test(out)) {
    out = out.replace(FIRST_VERSION, (_m, first: string) => `\n    versions: [\n      ...firstVersion(${quote(first)}),\n${history}\n    ],\n`);
  } else if (VERSION_LIST.test(out)) {
    out = out.replace(VERSION_LIST, (_m, body: string) => `\n    versions: [\n${body}\n${history}\n    ],\n`);
  } else throw new ReleaseRefusal('REGISTRY_ENTRY_SHAPE');
  return out;
}

// ── the allow-list, as text ─────────────────────────────────────────────────

const allowLine = (id: string) => new RegExp(`^ {2}\\{ id: '${id.replace(/\./g, '\\.')}', algorithm: '[a-z0-9-]+', file: '([a-z0-9][a-z0-9.-]*\\.ts)' \\},$`, 'm');

function allowListWithout(text: string, id: string): { text: string; line: string; after: string; file: string } {
  const m = allowLine(id).exec(text);
  if (!m) throw new ReleaseRefusal('NOT_IN_ALLOW_LIST');
  const lineStart = m.index;
  const prevEnd = lineStart - 1;
  const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
  return { text: text.slice(0, lineStart) + text.slice(lineStart + m[0].length + 1), line: m[0], after: text.slice(prevStart, prevEnd), file: m[1] };
}

function allowListWith(text: string, line: string, after: string): string {
  if (text.split('\n').includes(line)) return text;
  const anchor = text.indexOf(`\n${after}\n`);
  if (after && anchor >= 0) {
    const at = anchor + after.length + 2;
    return text.slice(0, at) + line + '\n' + text.slice(at);
  }
  const close = text.indexOf('\n];', text.indexOf('export const CANDIDATE_INDEX'));
  if (close < 0) throw new ReleaseRefusal('ALLOW_LIST_SHAPE');
  return text.slice(0, close + 1) + line + '\n' + text.slice(close + 1);
}

// ── regeneration ────────────────────────────────────────────────────────────

/** The generated files a promotion moves, regenerated by their own tools in the tree being changed. */
export const REGENERATED = [
  'src/algorithms/generated/algorithm-manifest.json',
  'src/algorithms/generated/candidate-evidence.json',
  'src/cyber-defense/generated/security-manifest.json',
] as const;

function regenerate(root: string): string[] {
  const run = (args: string[]) => execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600_000 });
  run(['scripts/algorithms-discover.js']);
  run(['-r', 'ts-node/register/transpile-only', 'lab/algorithms/cli.ts']);
  run(['scripts/security-discover.js']);
  return [...REGENERATED];
}

const readText = (root: string, f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (root: string, f: string) => fs.existsSync(path.join(root, f));

// ── apply ───────────────────────────────────────────────────────────────────

export function applyRelease(plan: ReleasePlan, opts: ApplyOptions): WriteReport {
  const root = LAB_ROOT;
  if (plan.state !== 'READY' || !plan.dossier || !plan.digest || !plan.texts) throw new ReleaseRefusal('PLAN_NOT_READY');
  if (!PULL_REQUEST_REFERENCE.test(opts.reference)) throw new ReleaseRefusal('REFERENCE_NOT_A_PULL_REQUEST');
  if (!DAY.test(opts.approvedAt) || Number.isNaN(Date.parse(`${opts.approvedAt}T00:00:00Z`))) throw new ReleaseRefusal('DATE_INVALID');
  const d = plan.dossier;
  if (digestOf(d) !== plan.digest) throw new ReleaseRefusal('DOSSIER_CHANGED_SINCE_PLAN');
  const decl = algorithmOf(d.algorithm);
  if (!decl) throw new ReleaseRefusal('NO_APPROVED_BASELINE');
  const id = d.candidate.id;
  const dossierFile = `${APPROVALS_DIR}/${id}.json`;
  const archive = archivePaths(id);
  for (const f of [dossierFile, archive.approved, archive.candidate, archive.meta]) if (exists(root, f)) throw new ReleaseRefusal('ALREADY_PROMOTED');

  // Nothing apply reads may have moved since the plan.
  if (readText(root, decl.source.file) !== plan.texts.approved) throw new ReleaseRefusal('SOURCE_CHANGED_SINCE_PLAN');
  const index = allowListWithout(readText(root, ALLOW_LIST), id);
  const candidateFile = `${CANDIDATES}/${index.file}`;
  if (readText(root, candidateFile) !== plan.texts.candidate) throw new ReleaseRefusal('CANDIDATE_CHANGED_SINCE_PLAN');

  const registry = readText(root, REGISTRY);
  const entry = registryEntry(registry, d.algorithm);
  const after = promotedEntry(entry.text, {
    version: d.candidate.version, fingerprint: d.candidate.fingerprint, candidate: id,
    baseline: { ...d.baseline }, dossier: { file: dossierFile, digest: plan.digest },
    reference: opts.reference, approvedAt: opts.approvedAt,
  });
  const meta: ArchiveMeta = ArchiveMetaSchema.parse({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    kind: 'PROMOTION_ARCHIVE',
    candidate: id,
    algorithm: d.algorithm,
    source: { file: decl.source.file, symbols: [...decl.source.symbols] },
    approved: { version: d.baseline.version, fingerprint: d.baseline.fingerprint, sha256: sha256(plan.texts.approved) },
    promoted: { version: d.candidate.version, fingerprint: d.promotion.promotedFingerprint, sha256: sha256(plan.texts.promoted) },
    candidateFile: { file: candidateFile, sha256: sha256(plan.texts.candidate) },
    allowList: { line: index.line, after: index.after },
    registry: { before: entry.text, after },
    dossier: { file: dossierFile, digest: plan.digest },
  });

  const writes: Array<[string, string]> = [
    [dossierFile, `${JSON.stringify(d, null, 2)}\n`],
    [archive.approved, plan.texts.approved],
    [archive.candidate, plan.texts.candidate],
    [archive.meta, `${JSON.stringify(meta, null, 2)}\n`],
    [decl.source.file, plan.texts.promoted],
    [REGISTRY, registry.slice(0, entry.start) + after + registry.slice(entry.end)],
    [ALLOW_LIST, index.text],
  ];
  for (const [f, text] of writes) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  fs.rmSync(path.join(root, candidateFile));

  // What was written reads back as the plan made it.
  const back = readDossier(dossierFile, path.join(root, APPROVALS_DIR));
  if (back.state !== 'READY' || back.digest !== plan.digest) throw new ReleaseRefusal('DOSSIER_DID_NOT_READ_BACK');
  const regenerated = opts.regenerate === false ? [] : regenerate(root);
  return { written: writes.map(([f]) => f), removed: [candidateFile], regenerated };
}

// ── rollback ────────────────────────────────────────────────────────────────

export function rollbackRelease(candidateId: string, opts: { regenerate?: boolean } = {}): WriteReport {
  const root = LAB_ROOT;
  const archive = readArchive(root, candidateId);
  if (archive.state !== 'READY') throw new ReleaseRefusal(archive.reason);
  const meta = archive.meta;
  const symbols = meta.source.symbols;

  const current = readText(root, meta.source.file);
  if (fingerprintOf(current, symbols) !== meta.promoted.fingerprint) throw new ReleaseRefusal('SOURCE_NOT_AT_PROMOTED_VERSION');
  const neighbours = ALGORITHMS.filter((a) => a.key !== meta.algorithm && a.source.file === meta.source.file).map((a) => ({ key: a.key, symbols: a.source.symbols }));
  const restored = rewrite(current, archive.approved, symbols, changedSymbols(current, archive.approved, symbols), meta.approved.fingerprint, neighbours);
  // Untouched since apply: the file comes back byte for byte.
  if (sha256(current) === meta.promoted.sha256 && restored !== archive.approved) throw new ReleaseRefusal('ROLLBACK_NOT_EXACT');

  const registry = readText(root, REGISTRY);
  const entry = registryEntry(registry, meta.algorithm);
  if (entry.text !== meta.registry.after) throw new ReleaseRefusal('REGISTRY_ENTRY_CHANGED_SINCE_PROMOTION');

  const candidateFile = meta.candidateFile.file;
  if (exists(root, candidateFile)) throw new ReleaseRefusal('CANDIDATE_FILE_EXISTS');
  if (sha256(archive.candidate) !== meta.candidateFile.sha256) throw new ReleaseRefusal('ARCHIVED_CANDIDATE_DIFFERS');

  const dossier = readDossier(meta.dossier.file, path.join(root, APPROVALS_DIR));
  if (dossier.state === 'READY' && dossier.digest !== meta.dossier.digest) throw new ReleaseRefusal('DOSSIER_CHANGED_SINCE_PROMOTION');

  const writes: Array<[string, string]> = [
    [meta.source.file, restored],
    [REGISTRY, registry.slice(0, entry.start) + meta.registry.before + registry.slice(entry.end)],
    [ALLOW_LIST, allowListWith(readText(root, ALLOW_LIST), meta.allowList.line, meta.allowList.after)],
    [candidateFile, archive.candidate],
  ];
  for (const [f, text] of writes) fs.writeFileSync(path.join(root, f), text);
  const p = archivePaths(candidateId);
  const removed = [meta.dossier.file, p.approved, p.candidate, p.meta].filter((f) => exists(root, f));
  for (const f of removed) fs.rmSync(path.join(root, f));
  const regenerated = opts.regenerate === false ? [] : regenerate(root);
  return { written: writes.map(([f]) => f), removed, regenerated };
}
