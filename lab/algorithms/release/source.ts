// Familista — promoting a candidate into its approved source file, as text
// ─────────────────────────────────────────────────────────────────────────────
// A promotion changes ONLY the declarations the candidate changed. Each one is
// cut out of the approved file at its exact span, and the candidate's
// declaration, as its author wrote it, goes in its place. Everything else in
// the file — other algorithms' declarations, imports, comments, blank lines —
// stays byte for byte. A rollback is the same operation the other way, from the
// archived approved file.
//
// Spans are found on a copy of the file whose comments are blanked with spaces
// (newlines kept), so an offset in the copy is an offset in the file. The
// declaration reader is the one every fingerprint uses (fingerprint-core.js).
//
// Nothing here is assumed: the result must carry exactly the fingerprint it is
// meant to, and every other algorithm that lives in the same file must keep its
// own. Pure text — no file is read or written here.

import * as crypto from 'crypto';

interface FingerprintCore {
  stripComments(src: string): string;
  declarationOf(cleanSrc: string, name: string): string | null;
  normalise(s: string): string;
  fingerprintText(text: string, symbols: string[]): { fingerprint: string | null; missing: string[]; error: string | null };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: FingerprintCore = require('../../../src/algorithms/fingerprint-core.js');

/** A promotion or rollback the tool will not make, with a stable code. */
export class ReleaseRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export const fingerprintOf = (text: string, symbols: readonly string[]): string | null => core.fingerprintText(text, [...symbols]).fingerprint;

/**
 * The source with every comment replaced by spaces and every newline kept: the
 * same length and the same offsets. It agrees with fingerprint-core's
 * stripComments on what is a comment — strings and template literals are left
 * exactly as they are.
 */
export function blankComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (c === '/' && n === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close === -1 ? src.length : close + 2;
      for (; i < stop; i += 1) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) { out += src[i]; i += 1; }
        out += src[i]; i += 1;
      }
      if (i < src.length) { out += src[i]; i += 1; }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** Where one top-level declaration sits in `src`: [start, end). Null unless it is declared exactly once. */
export function declarationSpan(src: string, name: string): { start: number; end: number } | null {
  const blank = blankComments(src);
  const decl = core.declarationOf(blank, name);
  if (decl === null) return null;
  const start = blank.indexOf(decl);
  if (start < 0 || blank.indexOf(decl, start + 1) >= 0) return null;
  return { start, end: start + decl.length };
}

/**
 * `target` with each named declaration replaced by the same declaration from
 * `source`, as `source` writes it (its own comments inside it included).
 */
export function replaceDeclarations(target: string, source: string, names: readonly string[]): string {
  const edits = names.map((name) => {
    const at = declarationSpan(target, name);
    const from = declarationSpan(source, name);
    if (!at || !from) throw new ReleaseRefusal(`SPAN_NOT_FOUND:${name.toLowerCase()}`);
    return { ...at, text: source.slice(from.start, from.end) };
  }).sort((a, b) => b.start - a.start);
  for (let k = 1; k < edits.length; k += 1) if (edits[k].end > edits[k - 1].start) throw new ReleaseRefusal('OVERLAPPING_DECLARATIONS');
  let out = target;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export interface Neighbour { key: string; symbols: readonly string[] }

/**
 * Replace `changed` in `current` with their form in `from`, then prove it: the
 * result carries `expect`, and every neighbour — another registered algorithm
 * in the same file — keeps the fingerprint it had in `current`.
 */
export function rewrite(
  current: string, from: string, symbols: readonly string[], changed: readonly string[], expect: string, neighbours: readonly Neighbour[],
): string {
  if (!changed.length) throw new ReleaseRefusal('NO_CODE_CHANGE');
  const out = replaceDeclarations(current, from, changed);
  if (fingerprintOf(out, symbols) !== expect) throw new ReleaseRefusal('FINGERPRINT_NOT_REACHED');
  for (const n of neighbours) {
    const before = fingerprintOf(current, n.symbols);
    if (!before || fingerprintOf(out, n.symbols) !== before) throw new ReleaseRefusal(`NEIGHBOUR_CHANGED:${n.key}`);
  }
  return out;
}

/**
 * Runtime imports a module would make. A promoted module is run from a copy in
 * a temporary directory, so it must stand alone: `import type` is erased, and
 * anything else — an import, a require, a dynamic import — is a dependency the
 * copy could not resolve.
 */
export function runtimeImports(src: string): string[] {
  const code = core.stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/gm)) {
    if (!/^\s+type\s/.test(m[2])) out.push(m[3]);
  }
  for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of code.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** The named declarations whose comment- and whitespace-free text differs between two versions of a file. */
export function changedSymbols(a: string, b: string, symbols: readonly string[]): string[] {
  const ca = core.stripComments(a);
  const cb = core.stripComments(b);
  return symbols.filter((s) => {
    const da = core.declarationOf(ca, s);
    const db = core.declarationOf(cb, s);
    return da === null || db === null || core.normalise(da) !== core.normalise(db);
  });
}
