// Files that must exist beside the compiled output but are not TypeScript.
//
// tsc emits .ts and leaves everything else where it is. The password worker is
// plain JavaScript on purpose — a worker is spawned by path, so it has to be a
// real file at runtime — which means the build has to put it in dist itself.
// Without this the pool finds no worker, falls back to hashing inline, and the
// event loop blocks again on every sign-in, silently.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The Design System manifest is generated from tools/tokens/ and committed
// (src/design-system/generated/design-system-manifest.json). This build copies
// whatever is committed, so a token change that did not regenerate it would ship
// outdated data to the Owner-only Design System Control room. Check it here,
// before anything is copied. The check only READS: it never rewrites the
// manifest, so a stale one fails the build rather than being fixed behind
// anybody's back. To fix it: node scripts/design-system-discover.js
{
  const generator = path.join(__dirname, 'design-system-discover.js');
  const r = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[assets] the Design System manifest is stale or cannot be checked; refusing to build.');
    console.error(((r.stderr || '') + (r.stdout || '')).trim());
    console.error('[assets] regenerate it, review the diff and commit it: node scripts/design-system-discover.js');
    process.exit(1);
  }
}

const ASSETS = [
  ['src/utils/password.worker.js', 'dist/utils/password.worker.js'],
  // The infrastructure manifest is generated from the repository by
  // scripts/infrastructure-discover.js and read at runtime by the
  // Infrastructure City API. tsc emits .ts and leaves .json where it is, so
  // without this the compiled server finds no manifest and the city is empty.
  ['src/infra/generated/infrastructure-manifest.json',
   'dist/infra/generated/infrastructure-manifest.json'],
  // The Cyber Defense coverage map, read by the same API to show each
  // component's coverage (src/infra/component-coverage.ts).
  ['src/cyber-defense/coverage-map.json',
   'dist/cyber-defense/coverage-map.json'],
  // The Cybersecurity Command Center reads the posture evidence beside the
  // compiled server (src/cyber-defense/control-plane/posture-source.ts): the
  // generated security manifest and the reviewed posture policy. Without them
  // the Command Center says NOT GENERATED rather than drawing a posture.
  ['src/cyber-defense/generated/security-manifest.json',
   'dist/cyber-defense/generated/security-manifest.json'],
  ['src/cyber-defense/posture-policy.json',
   'dist/cyber-defense/posture-policy.json'],
  // The Algorithms room compares each algorithm's approved fingerprint with
  // the fingerprint of the code that shipped (src/algorithms/
  // algorithms.service.ts). Without it the room says NOT GENERATED rather
  // than calling anything approved.
  ['src/algorithms/generated/algorithm-manifest.json',
   'dist/algorithms/generated/algorithm-manifest.json'],
  // The one fingerprint reader (plain JavaScript, so the build script can use
  // it before tsc runs). The running server requires it to fingerprint the
  // algorithm code it loaded (src/algorithms/runtime-fingerprint.ts); the seal
  // that code is compared with is written next, by scripts/algorithms-seal.js.
  ['src/algorithms/fingerprint-core.js',
   'dist/algorithms/fingerprint-core.js'],
  // What the algorithm lab found about each candidate: written by
  // lab/algorithms/ (which is NOT compiled into dist) and re-derived by CI.
  // The server validates and shows it (src/algorithms/candidate-evidence.ts);
  // it is the only thing of the lab's that ships, and it is data, never code.
  ['src/algorithms/generated/candidate-evidence.json',
   'dist/algorithms/generated/candidate-evidence.json'],
  // The one digest that binds a CHANGE approval to its dossier (plain
  // JavaScript, shared with the lab and the Cybersecurity scan). The server
  // requires it to check each approval's binding (src/algorithms/release.ts).
  ['src/algorithms/dossier-core.js',
   'dist/algorithms/dossier-core.js'],
  // The Design System Control room reads the manifest scripts/design-system-
  // discover.js generated from tools/tokens/ (src/design-system/
  // design-system.service.ts). Without it the room says NOT GENERATED rather
  // than drawing a token it did not read.
  ['src/design-system/generated/design-system-manifest.json',
   'dist/design-system/generated/design-system-manifest.json'],
];

// Approval dossiers (src/algorithms/approvals/*.json): the evidence each CHANGE
// approval is bound to. Data, never code; there is one per promoted version and
// none until a candidate is promoted, so the directory is copied as it is.
const DOSSIERS = ['src/algorithms/approvals', 'dist/algorithms/approvals'];

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = path.join(process.cwd(), from);
  const dst = path.join(process.cwd(), to);
  if (!fs.existsSync(src)) {
    console.error('[assets] missing source: ' + from);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}
{
  const [from, to] = DOSSIERS.map((p) => path.join(process.cwd(), p));
  const names = fs.existsSync(from) ? fs.readdirSync(from).filter((n) => /^[a-z0-9][a-z0-9.-]*\.json$/.test(n)) : [];
  fs.mkdirSync(to, { recursive: true });
  for (const n of names) { fs.copyFileSync(path.join(from, n), path.join(to, n)); copied++; }
}
console.log('[assets] copied ' + copied + ' runtime file(s) into dist');
