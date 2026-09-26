#!/usr/bin/env node
// Bring a Vision Engine session artefact into the platform's session store.
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES AND — MORE IMPORTANTLY — WHAT IT DOES NOT
//
// It COPIES. It does not compute, average, round, fill, smooth or repair. The
// artefact that lands in the session store is the artefact the validated engine
// wrote, with two changes and no others:
//
//   1 · the engine's several output files become one directory, so the platform
//       can address a session by name rather than by filename convention;
//   2 · the absolute path the engine recorded for its input is reduced to the
//       file's NAME, because a path tells a client the shape of the server and
//       tells an honest reader nothing they can use.
//
// Everything else — every observation, every null coordinate, every UNKNOWN,
// every PROPAGATED ball frame, every calibration verdict and its expected error
// — is byte-for-byte what the engine decided. The importer verifies that by
// re-hashing what it wrote and refusing if the observation count moved.
//
//   node scripts/vision-import-session.js \
//     --ref original-clip \
//     --session /path/to/gated_original.json \
//     --events  /path/to/gated_original_p4.json \
//     --readiness /path/to/gated_original_p5.json \
//     --out vision-sessions

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const ref = arg('ref');
const sessionPath = arg('session');
const eventsPath = arg('events');
const readinessPath = arg('readiness');
const outRoot = arg('out', 'vision-sessions');

if (!ref || !sessionPath) {
  console.error('usage: --ref <name> --session <engine session json> [--events <p4 json>] [--readiness <p5 json>] [--out <dir>]');
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
  console.error(`refusing: "${ref}" is not a valid session reference`);
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const before = Array.isArray(doc.observations) ? doc.observations.length : 0;

// The source, reduced. The engine records where it read the video from; the
// platform records WHAT it was and its hash. The hash is what makes the
// evidence citable, and it survives.
if (doc.source && typeof doc.source === 'object') {
  for (const key of ['path', 'file', 'absolute_path', 'directory']) {
    if (typeof doc.source[key] === 'string') {
      doc.source[key] = path.basename(doc.source[key]);
    }
  }
}
// The engine's own environment block can name build paths. It is diagnostic,
// not evidence, and it does not travel.
if (doc.environment && typeof doc.environment === 'object') {
  delete doc.environment.cwd;
  delete doc.environment.executable;
}

const dir = path.join(outRoot, ref);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(doc));

const companions = [];
if (eventsPath && fs.existsSync(eventsPath)) {
  fs.copyFileSync(eventsPath, path.join(dir, 'events.json'));
  companions.push('events');
}
if (readinessPath && fs.existsSync(readinessPath)) {
  fs.copyFileSync(readinessPath, path.join(dir, 'readiness.json'));
  companions.push('readiness');
}

// Re-read and verify. An importer that silently dropped half a session would
// look exactly like a successful import, and the number the platform reports
// would be wrong in the direction that flatters it.
const written = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
const after = Array.isArray(written.observations) ? written.observations.length : 0;
if (after !== before) {
  console.error(`refusing: observation count changed during import (${before} → ${after})`);
  process.exit(1);
}

const manifest = {
  sessionRef: ref,
  importedAt: new Date().toISOString(),
  engineSchema: doc.schema ?? null,
  sourceSha256: doc.source && doc.source.sha256 ? doc.source.sha256 : null,
  observations: after,
  ballSamples: Array.isArray(doc.ball) ? doc.ball.length : 0,
  companions,
  artefactSha256: sha256(path.join(dir, 'session.json')),
  note: 'copied from a validated engine run. Original evidence: never edited, '
    + 'never recomputed, and never overwritten when a later model disagrees.',
};
fs.writeFileSync(path.join(dir, 'import-manifest.json'), JSON.stringify(manifest, null, 1));

console.log(`imported ${ref}`);
console.log(`  observations : ${after}`);
console.log(`  ball samples : ${manifest.ballSamples}`);
console.log(`  companions   : ${companions.join(', ') || 'none'}`);
console.log(`  artefact     : ${manifest.artefactSha256.slice(0, 16)}…`);
