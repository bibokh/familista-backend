// Familista — algorithm fingerprints, the one implementation
// ─────────────────────────────────────────────────────────────────────────────
// How an algorithm's code becomes one SHA-256: the declarations it is made of
// (its function, the weights and constants it uses) are read out of a source
// file, normalised — comments and whitespace removed, so rewording a comment is
// not a change to an algorithm — and hashed together.
//
// Three readers use it, and it is written once so they cannot disagree:
//
//   scripts/algorithms-discover.js   the TypeScript source, at build and in CI
//                                    (the fingerprint a human approval names)
//   scripts/algorithms-seal.js       the compiled JavaScript in dist/, right
//                                    after tsc (what the build turned it into)
//   src/algorithms/runtime-fingerprint.ts
//                                    the file the running server loaded
//
// Plain JavaScript on purpose, like src/utils/password.worker.js: the build
// script runs before tsc, so it cannot require compiled TypeScript. The build
// copies this file into dist/ beside the code that requires it.
//
// Pure: no environment, no database, no clock.
'use strict';

const crypto = require('crypto');

/** Blank out comments, keep strings and template literals intact. */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i++]; } out += src[i++]; }
      out += src[i++] || '';
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** From `start` to the end of the declaration that begins there, or null. */
function declarationFrom(cleanSrc, start) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < cleanSrc.length; i++) {
    const c = cleanSrc[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < cleanSrc.length && cleanSrc[i] !== q) { if (cleanSrc[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; opened = true; }
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      // A top-level function body closes with a brace at the start of its
      // line, or at the end of the line it began on (a one-line function).
      // An object return type (`): { ok: boolean } {`) closes mid-line, with
      // the body's brace still to come, so it is neither.
      const lineEnd = cleanSrc.indexOf('\n', i);
      const lastOnLine = !cleanSrc.slice(i + 1, lineEnd === -1 ? undefined : lineEnd).trim();
      const sameLine = !cleanSrc.slice(start, i).includes('\n');
      if (depth === 0 && c === '}' && (cleanSrc[i - 1] === '\n' || (sameLine && lastOnLine))
        && /^(export\s+)?(async\s+)?function/.test(cleanSrc.slice(start, start + 40))) {
        return cleanSrc.slice(start, i + 1);
      }
    } else if (c === ';' && depth === 0) {
      return cleanSrc.slice(start, i + 1);
    } else if (c === '\n' && depth === 0 && opened && /^(const|let|export)/.test(cleanSrc.slice(start, start + 10))) {
      // A const whose initialiser ended without a semicolon.
      const rest = cleanSrc.slice(i + 1).match(/^\s*(\S)/);
      if (!rest || !/[.?:+\-*/|&=,]/.test(rest[1])) return cleanSrc.slice(start, i);
    }
  }
  return null;
}

/**
 * The text of ONE top-level declaration — `function name`, `export function
 * name`, `const name`, `export const name` (async too) — from its keyword to
 * the end of its body or statement. Brackets are balanced over comment-free
 * source, skipping string contents. Returns null when the name is not
 * declared exactly once at the top level.
 *
 * `compiled` reads tsc's CommonJS output as well: an exported constant there is
 * `exports.NAME = …;` (after a hoisted `exports.A = exports.NAME = void 0;`,
 * which is not a declaration and is skipped). Off, this is exactly the reader
 * the approved TypeScript fingerprints were computed with.
 */
function declarationOf(cleanSrc, name, options) {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+)${name}\\b`, 'gm');
  const hits = [...cleanSrc.matchAll(re)];
  if (hits.length === 1) return declarationFrom(cleanSrc, hits[0].index);
  if (hits.length > 1 || !(options && options.compiled)) return null;
  // The guard sits right after `=` and swallows its own whitespace, so a
  // backtracking `\s*` cannot step around it onto ` void 0;`.
  const exp = new RegExp(`^exports\\.${name}\\s*=(?!\\s*(?:exports\\.|void 0;))`, 'gm');
  const exported = [...cleanSrc.matchAll(exp)];
  if (exported.length !== 1) return null;
  return declarationFrom(cleanSrc, exported[0].index);
}

/** Whitespace collapsed, so formatting is not a change either. */
const normalise = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * One fingerprint over the named declarations of one file's text.
 * `{ fingerprint, missing, error }` — never throws on a symbol it cannot find.
 */
function fingerprintText(text, symbols, options) {
  const clean = stripComments(text);
  const missing = [];
  const parts = [];
  for (const s of symbols) {
    const d = declarationOf(clean, s, options);
    if (d === null) missing.push(s); else parts.push(normalise(d));
  }
  if (missing.length) return { fingerprint: null, missing, error: 'SYMBOL_NOT_FOUND' };
  const fingerprint = crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  return { fingerprint, missing: [], error: null };
}

module.exports = { stripComments, declarationOf, normalise, fingerprintText };
