// Prints SHA-256 fingerprints of the three production files this Storybook
// reads but must never change. Read-only.
//   node scripts/fingerprint.mjs            print
//   node scripts/fingerprint.mjs --check F  compare against a file of `sha256  path` lines
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/extract-lg.mjs';

const FILES = ['public/app.js', 'public/app.css', 'public/index.html'];
const sum = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex');
const now = Object.fromEntries(FILES.map((f) => [f, sum(f)]));
const i = process.argv.indexOf('--check');
if (i === -1) { for (const f of FILES) console.log(`${now[f]}  ${f}`); process.exit(0); }
const before = Object.fromEntries(fs.readFileSync(process.argv[i + 1], 'utf8').trim().split('\n')
  .map((l) => l.trim().split(/\s+/)).map(([h, f]) => [f, h]));
let ok = true;
for (const f of FILES) {
  const same = before[f] === now[f];
  ok = ok && same;
  console.log(`${same ? 'IDENTICAL' : 'CHANGED  '}  ${f}\n  before ${before[f]}\n  after  ${now[f]}`);
}
process.exit(ok ? 0 : 1);
