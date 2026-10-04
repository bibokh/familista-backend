#!/usr/bin/env node
// Familista — algorithm fingerprints
// ─────────────────────────────────────────────────────────────────────────────
// Reads the declarations every registered algorithm is made of (its function,
// the weights and constants it uses) straight out of the source, normalises
// them — comments and whitespace removed, so rewording a comment is not a
// change to an algorithm — and writes one SHA-256 per algorithm to
// src/algorithms/generated/algorithm-manifest.json.
//
// The Algorithms room compares that fingerprint with the one the platform
// owner approved (src/algorithms/registry.ts). A difference means the code
// changed without a recorded human approval, and tests/algorithms.unit.test.ts
// fails on it — so no algorithmic change reaches main, and therefore
// production, without one.
//
//   node scripts/algorithms-discover.js            write the manifest
//   node scripts/algorithms-discover.js --check    fail if it is stale
//
// The list of what to fingerprint is read from the registry source itself, so
// it is written down once. Nothing here reads the environment or a database.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = 'src/algorithms/registry.ts';
const OUT = 'src/algorithms/generated/algorithm-manifest.json';

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

/**
 * The text of ONE top-level declaration — `function name`, `export function
 * name`, `const name`, `export const name` (async too) — from its keyword to
 * the end of its body or statement. Brackets are balanced over comment-free
 * source, skipping string contents. Returns null when the name is not
 * declared exactly once at the top level.
 */
function declarationOf(cleanSrc, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+)${name}\\b`, 'gm');
  const hits = [...cleanSrc.matchAll(re)];
  if (hits.length !== 1) return null;
  const start = hits[0].index;
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

/** Whitespace collapsed, so formatting is not a change either. */
const normalise = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * The fingerprint inputs declared in the registry: for every algorithm, its
 * key, its source file and the symbols it is made of. Parsed from the TS
 * source with a narrow pattern the registry is written to (and the unit test
 * proves it parsed every entry).
 */
function registeredAlgorithms() {
  const src = fs.readFileSync(path.join(ROOT, REGISTRY), 'utf8');
  const out = [];
  const re = /key:\s*'([a-z0-9-]+)'[\s\S]*?source:\s*\{\s*file:\s*'([^']+)',\s*symbols:\s*\[([^\]]*)\]/g;
  for (const m of src.matchAll(re)) {
    const symbols = [...m[3].matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((s) => s[1]);
    out.push({ key: m[1], file: m[2], symbols });
  }
  return out;
}

function fingerprintOf(file, symbols) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return { fingerprint: null, missing: symbols.slice(), error: 'SOURCE_MISSING' };
  const clean = stripComments(fs.readFileSync(abs, 'utf8'));
  const missing = [];
  const parts = [];
  for (const s of symbols) {
    const d = declarationOf(clean, s);
    if (d === null) missing.push(s); else parts.push(normalise(d));
  }
  if (missing.length) return { fingerprint: null, missing, error: 'SYMBOL_NOT_FOUND' };
  const fingerprint = crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  return { fingerprint, missing: [], error: null };
}

function buildManifest() {
  const algorithms = {};
  for (const a of registeredAlgorithms()) {
    const f = fingerprintOf(a.file, a.symbols);
    algorithms[a.key] = { file: a.file, symbols: a.symbols, fingerprint: f.fingerprint, error: f.error, missing: f.missing };
  }
  return { schemaVersion: 1, generatedBy: 'scripts/algorithms-discover.js', algorithms };
}

module.exports = { stripComments, declarationOf, fingerprintOf, registeredAlgorithms, buildManifest, OUT };

if (require.main === module) {
  const manifest = buildManifest();
  const body = JSON.stringify(manifest, null, 2) + '\n';
  const outAbs = path.join(ROOT, OUT);
  const broken = Object.entries(manifest.algorithms).filter(([, v]) => v.error);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(outAbs) ? fs.readFileSync(outAbs, 'utf8') : '';
    if (current !== body) {
      console.error('algorithm manifest is stale — run: node scripts/algorithms-discover.js');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, body);
    console.log(`algorithm manifest written → ${OUT} (${Object.keys(manifest.algorithms).length} algorithm(s))`);
  }
  if (broken.length) {
    for (const [k, v] of broken) console.error(`  ${k}: ${v.error} ${v.missing.join(', ')}`);
    process.exit(1);
  }
}
