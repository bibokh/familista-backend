// The execution's source — exactly what a replay of a definition depends on, as one digest
// ─────────────────────────────────────────────────────────────────────────────
// A definition replays to the same record only over the same code. "The same
// code" is made precise here: starting from replay.ts, every file it imports,
// and every file those import, transitively — the engine, the controlled
// execution layer, the operations, the routing, the roster, the Agent Registry
// and its catalogue, the tool registry and kill switch, the read matrix, the
// approver roles, the evidence contracts, zod's message map — byte for byte,
// and the locked version of every package any of them imports.
//
// The walk reads through a function, so the same rule measures the working
// tree and any commit (`git show <commit>:<path>`): the publication gate
// requires the digest at the provenance's commit and at the head to be the
// digest the provenance names. Nothing is excluded or normalised; a comment
// changed in engine.ts is a different source. An import that does not resolve
// is a refusal, not a gap.

import { builtinModules } from 'module';
import * as path from 'path';
import { digestOf, sha256 } from '../../src/platform/agents/trace-chain';

export const EXECUTION_SOURCE_CONTRACT = 'familista.execution-source/v1' as const;
/** Where the walk starts: the replay, which runs the definition through the AI-0.4 engine and projects the dossier. */
export const EXECUTION_SOURCE_ENTRIES = Object.freeze(['lab/orchestrator/replay.ts']);
const LOCKFILE = 'package-lock.json';
const MAX_FILES = 400;

/** A file's text at some revision, by repository-relative path; null if there is no such file. */
export type SourceReader = (repoPath: string) => string | null;

export interface ExecutionSource {
  digest: string;
  files: Array<{ path: string; digest: string }>;
  packages: Array<{ name: string; version: string; integrity: string }>;
}

const BUILTIN = new Set(builtinModules);
const SPECIFIER = /\bfrom\s+['"]([^'"\n]+)['"]|\bimport\s+['"]([^'"\n]+)['"]|\b(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** Block comments and whole-line comments, so a specifier written in prose is not an import. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of code(text).matchAll(SPECIFIER)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** The file a relative specifier names, as TypeScript would resolve it here. */
function resolve(from: string, spec: string, read: SourceReader): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const tries = /\.(json|js|ts)$/.test(base) ? [base] : [`${base}.ts`, `${base}/index.ts`, `${base}.json`, `${base}.js`];
  return tries.find((p) => read(p) !== null) ?? null;
}

/** The execution's source as `read` sees it, or why it cannot be measured. */
export function executionSource(read: SourceReader, entries: readonly string[] = EXECUTION_SOURCE_ENTRIES): ExecutionSource | { reason: string } {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    const text = read(file);
    if (text === null) return { reason: `source: ${file} is not there` };
    files.set(file, sha256(text));
    if (files.size > MAX_FILES) return { reason: `source: more than ${MAX_FILES} files; the walk is not what it should be` };
    if (file.endsWith('.json')) continue;
    for (const spec of specifiers(text)) {
      if (spec.startsWith('.')) {
        const target = resolve(file, spec, read);
        if (!target) return { reason: `source: ${file} imports ${spec}, which does not resolve` };
        queue.push(target);
      } else if (!spec.startsWith('node:') && !BUILTIN.has(packageOf(spec))) {
        packages.add(packageOf(spec));
      }
    }
  }
  const lockText = read(LOCKFILE);
  if (lockText === null) return { reason: `source: ${LOCKFILE} is not there, so no package version is known` };
  let lock: { packages?: Record<string, { version?: string; integrity?: string }> };
  try { lock = JSON.parse(lockText); } catch { return { reason: `source: ${LOCKFILE} is not JSON` }; }
  const locked: ExecutionSource['packages'] = [];
  for (const name of [...packages].sort()) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry?.version || !entry.integrity) return { reason: `source: ${name} is imported but not locked in ${LOCKFILE}` };
    locked.push({ name, version: entry.version, integrity: entry.integrity });
  }
  const list = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => ({ path: p, digest: d }));
  return { digest: digestOf({ contract: EXECUTION_SOURCE_CONTRACT, files: list, packages: locked }), files: list, packages: locked };
}
