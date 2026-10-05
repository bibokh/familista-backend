// Familista — what a candidate changes in the code, read as text
// ─────────────────────────────────────────────────────────────────────────────
// Static analysis, in the PARENT process: the candidate file is read as text
// and never executed here. Uses the one fingerprint reader the registry, the
// build seal and the running server use (src/algorithms/fingerprint-core.js),
// over the approved algorithm's own symbol list — so the candidate's
// fingerprint is exactly the one production would carry if it were promoted.
//
// Also derives, from the registry, every algorithm whose inputs would change
// if the candidate were promoted.

import * as fs from 'fs';
import * as path from 'path';
import { ALGORITHMS, algorithmOf } from '../../../src/algorithms/registry';
import type { LabCode } from '../../../src/algorithms/candidate-evidence';

interface FingerprintCore {
  stripComments(src: string): string;
  declarationOf(cleanSrc: string, name: string): string | null;
  normalise(s: string): string;
  fingerprintText(text: string, symbols: string[]): { fingerprint: string | null; missing: string[]; error: string | null };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: FingerprintCore = require('../../../src/algorithms/fingerprint-core.js');

const MAX_DIFF_LINES = 40;
const MAX_LINE = 240;

const posix = (p: string) => p.split(path.sep).join('/');
const linesOf = (decl: string) => decl.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
const cut = (l: string) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l);

/** Lines only in `a` (removed) and only in `b` (added), by longest common subsequence. */
export function lineDiff(a: string[], b: string[]): { removed: string[]; added: string[] } {
  const n = a.length; const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const removed: string[] = []; const added: string[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; } else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { removed: removed.slice(0, MAX_DIFF_LINES).map(cut), added: added.slice(0, MAX_DIFF_LINES).map(cut) };
}

/** Every registered algorithm that reads this one's output, directly or through another. */
export function dependantsOf(key: string): Array<{ key: string; simulated: boolean }> {
  const seen = new Set<string>();
  const queue = [key];
  while (queue.length) {
    const k = queue.shift() as string;
    for (const a of ALGORITHMS) if (a.dependsOn.includes(k) && !seen.has(a.key)) { seen.add(a.key); queue.push(a.key); }
  }
  return ALGORITHMS.filter((a) => seen.has(a.key)).map((a) => ({ key: a.key, simulated: a.notSimulatedBecause === null }));
}

/** The candidate's code section of the evidence. `root` is the repository root. */
export function codeOf(root: string, algorithm: string, candidateFile: string): LabCode {
  const decl = algorithmOf(algorithm);
  if (!decl) throw new Error(`algorithm ${algorithm} is not registered`);
  const symbols = decl.source.symbols;
  const approvedText = fs.readFileSync(path.join(root, decl.source.file), 'utf8');
  const candidateText = fs.readFileSync(candidateFile, 'utf8');
  const a = core.stripComments(approvedText);
  const c = core.stripComments(candidateText);
  const statuses: LabCode['symbols'] = [];
  const diff: LabCode['diff'] = [];
  for (const name of symbols) {
    const da = core.declarationOf(a, name);
    const dc = core.declarationOf(c, name);
    if (da === null || dc === null) { statuses.push({ name, status: 'MISSING' }); continue; }
    if (core.normalise(da) === core.normalise(dc)) { statuses.push({ name, status: 'SAME' }); continue; }
    statuses.push({ name, status: 'CHANGED' });
    diff.push({ symbol: name, ...lineDiff(linesOf(da), linesOf(dc)) });
  }
  return {
    file: posix(path.relative(root, candidateFile)),
    approvedFile: decl.source.file,
    fingerprint: core.fingerprintText(candidateText, symbols).fingerprint,
    approvedFingerprint: core.fingerprintText(approvedText, symbols).fingerprint,
    symbols: statuses,
    diff,
    dependants: dependantsOf(algorithm),
  };
}
