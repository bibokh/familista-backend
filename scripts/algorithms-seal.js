#!/usr/bin/env node
// Familista — the build seal for algorithm code
// ─────────────────────────────────────────────────────────────────────────────
// Runs at the end of `npm run build`, after tsc has compiled src/ into dist/.
// For every registered algorithm it records two fingerprints side by side:
//
//   source     the TypeScript declarations, computed fresh — the fingerprint a
//              human approval names (src/algorithms/registry.ts)
//   compiled   the same declarations as tsc emitted them into dist/
//
// and writes them to dist/algorithms/generated/algorithm-runtime-seal.json.
//
// WHY
//
// The server runs dist/, not src/. When it starts, it fingerprints the compiled
// file it actually loaded (src/algorithms/runtime-fingerprint.ts) and looks for
// it here: equal means the running code is what this build compiled from that
// source, so the source fingerprint — and therefore the approval — carries over
// to the running code. A file changed after the build, or a build whose source
// was never approved, shows as a mismatch in the Algorithms room.
//
// What this protects against is drift and accident — a stale or partial deploy,
// a hand-edited file on a server. Somebody able to rewrite dist/ can rewrite
// this file too; that threat belongs to the deploy pipeline (deploy-gated-by-ci).
//
// Nothing here reads the environment or a database.
'use strict';

const fs = require('fs');
const path = require('path');
const { fingerprintText } = require('../src/algorithms/fingerprint-core.js');
const { registeredAlgorithms, fingerprintOf } = require('./algorithms-discover.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = 'dist/algorithms/generated/algorithm-runtime-seal.json';

/** dist/x/y.js for src/x/y.ts. */
const compiledPathOf = (file) => path.join('dist', file.replace(/^src\//, '').replace(/\.ts$/, '.js'));

function buildSeal() {
  const algorithms = {};
  for (const a of registeredAlgorithms()) {
    const source = fingerprintOf(a.file, a.symbols);
    const rel = compiledPathOf(a.file);
    const abs = path.join(ROOT, rel);
    const compiled = fs.existsSync(abs)
      ? fingerprintText(fs.readFileSync(abs, 'utf8'), a.symbols, { compiled: true })
      : { fingerprint: null, missing: a.symbols.slice(), error: 'COMPILED_MISSING' };
    algorithms[a.key] = {
      file: rel,
      source: source.fingerprint,
      compiled: compiled.fingerprint,
      error: source.error || compiled.error,
    };
  }
  return { schemaVersion: 1, generatedBy: 'scripts/algorithms-seal.js', algorithms };
}

module.exports = { buildSeal, compiledPathOf, OUT };

if (require.main === module) {
  const seal = buildSeal();
  const broken = Object.entries(seal.algorithms).filter(([, v]) => v.error);
  if (broken.length) {
    for (const [k, v] of broken) console.error(`  ${k}: ${v.error}`);
    console.error('algorithm seal NOT written — every registered algorithm must be readable in src/ and dist/');
    process.exit(1);
  }
  const outAbs = path.join(ROOT, OUT);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(seal, null, 2) + '\n');
  console.log(`algorithm seal written → ${OUT} (${Object.keys(seal.algorithms).length} algorithm(s))`);
}
