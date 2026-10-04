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

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = 'src/algorithms/registry.ts';
const OUT = 'src/algorithms/generated/algorithm-manifest.json';

// The reader itself — comment stripping, declaration extraction, normalising
// and hashing — lives in src/algorithms/fingerprint-core.js, the one
// implementation this script, the build seal (scripts/algorithms-seal.js) and
// the running server (src/algorithms/runtime-fingerprint.ts) all use.
const { stripComments, declarationOf, fingerprintText } = require('../src/algorithms/fingerprint-core.js');

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
  return fingerprintText(fs.readFileSync(abs, 'utf8'), symbols);
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
