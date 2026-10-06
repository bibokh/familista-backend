// Familista — pinning the evaluation engine a dossier's evidence came from
// ─────────────────────────────────────────────────────────────────────────────
// The engine is every module reachable from ENGINE_ENTRIES through runtime
// imports (release/spec.ts), minus what it is run ON: the code under test, the
// candidates and the archive, the approval records and the process plumbing.
// Its fingerprint is SHA-256 over each module's path and its text with comments
// removed and whitespace collapsed, in path order — rewording a comment does
// not move it; changing a seed, a property, a rule, the shot generator or the
// way a dossier is assembled does.
//
// Pinning says WHICH engine produced a dossier, so that "the evidence still
// reproduces" is asked only of the engine that made it. The commit is where
// that engine can be checked out again: the newest of main's merge base and
// HEAD at which every engine module is exactly as it is on disk, or null when
// neither holds (or there is no git) — never a commit that does not contain it.

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ALGORITHMS } from '../../../src/algorithms/registry';
import { LAB_SPEC_VERSION } from '../spec';
import { ENGINE_ENTRIES, ENGINE_EXCLUDED } from './spec';

interface FingerprintCore { stripComments(src: string): string; normalise(s: string): string }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: FingerprintCore = require('../../../src/algorithms/fingerprint-core.js');

export interface EnginePin {
  specVersion: number;
  fingerprint: string;
  commit: string | null;
  files: string[];
}

const posix = (p: string) => p.split(path.sep).join('/');

/** Repository-relative modules a file imports at run time. `import type` and `export type` are erased, so they are not. */
export function runtimeSpecifiers(text: string): string[] {
  const code = core.stripComments(text);
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) if (!m[1]) out.push(m[2]);
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out.filter((s) => s.startsWith('.'));
}

function resolve(root: string, fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(path.join(root, fromFile)), spec);
  for (const p of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    if (/\.(?:ts|js)$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile()) {
      const rel = posix(path.relative(root, p));
      if (rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`engine module outside the repository: ${spec} from ${fromFile}`);
      return rel;
    }
  }
  throw new Error(`engine import does not resolve: ${spec} from ${fromFile}`);
}

/** The engine's modules, repository-relative and sorted. */
export function engineFiles(root: string): string[] {
  const underTest = new Set(ALGORITHMS.map((a) => a.source.file));
  const excluded = (f: string) => underTest.has(f) || ENGINE_EXCLUDED.some((re) => re.test(f));
  const seen = new Set<string>();
  const queue = [...ENGINE_ENTRIES];
  while (queue.length) {
    const f = queue.shift() as string;
    if (seen.has(f) || excluded(f)) continue;
    seen.add(f);
    for (const s of runtimeSpecifiers(fs.readFileSync(path.join(root, f), 'utf8'))) queue.push(resolve(root, f, s));
  }
  return [...seen].sort();
}

export function engineFingerprint(root: string, files: readonly string[]): string {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${f}\n${core.normalise(core.stripComments(fs.readFileSync(path.join(root, f), 'utf8')))}\n\u0000\n`);
  return h.digest('hex');
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch { return null; }
}

/** The newest commit on main (or HEAD) that holds every engine module exactly as it is on disk; null if none does. */
export function engineCommit(root: string, files: readonly string[]): string | null {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top || fs.realpathSync(top) !== fs.realpathSync(root)) return null;
  const candidates = [git(root, ['merge-base', 'HEAD', 'origin/main']), git(root, ['rev-parse', 'HEAD'])];
  for (const c of candidates) {
    if (!c || !/^[0-9a-f]{40}$/.test(c)) continue;
    if (files.every((f) => git(root, ['cat-file', '-e', `${c}:${f}`]) !== null) && git(root, ['diff', '--quiet', c, '--', ...files]) !== null) return c;
  }
  return null;
}

export function enginePin(root: string): EnginePin {
  const files = engineFiles(root);
  return { specVersion: LAB_SPEC_VERSION, fingerprint: engineFingerprint(root, files), commit: engineCommit(root, files), files };
}
