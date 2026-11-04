#!/usr/bin/env node
// Familista Neural Digital Twin — compose the architecture graph at build time.
//
// Runs after tsc (npm run build): the compiled composer reads the authorities
// and the source of this checkout and writes dist/platform/neural-twin/
// generated/neural-graph.json, which the owner-only API serves. The graph is
// therefore always the architecture of the commit being deployed, and it is
// reproducible from any commit. The composer refuses (and this build fails) if
// the graph breaks an invariant or the exposure rules.
//
//   node scripts/neural-twin-build.js            → write the graph into dist/
//   node scripts/neural-twin-build.js --stdout   → print counts, write nothing
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'platform', 'neural-twin', 'generated', 'neural-graph.json');
const { composeTwin } = require(path.join(ROOT, 'dist', 'platform', 'neural-twin', 'compose.js'));

const t0 = Date.now();
const g = composeTwin(ROOT);
const json = JSON.stringify(g);
const say = (s) => process.stdout.write(s + '\n');
say(`[neural-twin] ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.discrepancies.length} discrepancies, ${(json.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
if (process.argv.includes('--stdout')) process.exit(0);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
