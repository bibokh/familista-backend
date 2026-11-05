#!/usr/bin/env node
// Familista System Updates — write the release record at build time.
//
// Runs after tsc (npm run build). The compiled composer
// (dist/platform/system-updates/release-record.js) reads this checkout's commit,
// its recent history, a tag on it and the deployment path its render.yaml and
// deploy workflow declare, and this script writes the answer to
// dist/platform/system-updates/generated/release-record.json, which the
// owner-only API serves. It is therefore always the record of the commit being
// deployed.
//
// It never fails the build: a checkout without history (or without git) is
// recorded as such, and the room says "unknown" rather than guessing.
//
//   node scripts/system-updates-build.js            → write the record into dist/
//   node scripts/system-updates-build.js --stdout   → print a summary, write nothing
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'platform', 'system-updates', 'generated', 'release-record.json');
const { composeReleaseRecord } = require(path.join(ROOT, 'dist', 'platform', 'system-updates', 'release-record.js'));

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 1 << 20 });
  } catch (_) { return null; }
};
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; }
};

const r = composeReleaseRecord({ git, read });
const h = r.history.state === 'RECORDED' ? `${r.history.items.length} commits${r.history.shallow ? ' (shallow)' : ''}` : r.history.reason;
const d = r.deployPath.state === 'RECORDED' ? `${r.deployPath.facts.length} deploy facts` : r.deployPath.reason;
process.stdout.write(`[system-updates] commit ${r.commit ? r.commit.slice(0, 7) : 'unknown'}, ${h}, ${d}, tag ${r.tag || 'none'}\n`);
if (process.argv.includes('--stdout')) process.exit(0);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(r));
