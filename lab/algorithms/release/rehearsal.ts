// Familista — the rollback rehearsal: promote, verify and roll back, in a copy
// ─────────────────────────────────────────────────────────────────────────────
// Proves the release path end to end without approving anything. The
// repository's files are copied into a temporary directory (node_modules is
// linked, not copied), and the release tool is run THERE, by its own command
// line, step by step:
//
//   plan       READY, and the copy is byte-for-byte unchanged by it
//   apply      with a pull-request reference that cannot exist (#9999999)
//   verify     every gate APPROVED on the promoted code, the binding VALID,
//              the archive consistent, the evidence re-run and agreeing, Step 1
//              evaluation passing, Learning's method checks all passing with
//              the real-world lane disabled; the algorithm manifest, the
//              candidate evidence and the Cybersecurity manifest all current,
//              and every control the posture policy requires PRESENT
//   rollback   and then every file is byte-for-byte what it was before apply —
//              except two regenerated files, compared without what changes on
//              every run: the candidate evidence without what each run cost
//              (`measured`), the Cybersecurity manifest without `generatedAt`
//   verify     again: no CHANGE approval, every gate APPROVED
//
// The repository itself is hashed before and after and must not change. The
// copy is removed afterwards unless asked to keep it.

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deterministicView, firstDifference } from '../evidence';
import { LAB_ROOT } from '../runner';

/** A pull request that cannot exist: an approval rehearsed here can never be mistaken for a real one. */
export const REHEARSAL_REFERENCE = 'bibokh/familista-backend#9999999';
const EVIDENCE = 'src/algorithms/generated/candidate-evidence.json';
const SECURITY = 'src/cyber-defense/generated/security-manifest.json';
const POLICY = 'src/cyber-defense/posture-policy.json';

/** Two regenerated files carry what changes on every run; everything else must match byte for byte. */
function sameApartFromRun(root: string, ws: string, file: string): boolean {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(ws, file), 'utf8'));
    if (file === EVIDENCE) return firstDifference(deterministicView(a), deterministicView(b)) === null;
    if (file === SECURITY) { delete a.generatedAt; delete b.generatedAt; return JSON.stringify(a) === JSON.stringify(b); }
  } catch { /* unreadable: different */ }
  return false;
}

export interface RehearsalStep { step: string; ok: boolean; ms: number; detail: unknown }

export interface RehearsalReport {
  ok: boolean;
  candidate: string;
  steps: RehearsalStep[];
  /** Files apply changed, added or removed, as seen in the copy. */
  promotion: { changed: string[]; added: string[]; removed: string[] } | null;
  /** Files that differ after rollback (the candidate evidence only when its deterministic content differs). */
  leftovers: string[];
  repositoryUntouched: boolean;
  workspace: string | null;
}

function git(root: string, args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: the rehearsal copies the repository's files and needs git to list them`);
  return r.stdout;
}

/** Every file the repository has — committed or not, never ignored ones — that exists on disk. */
function repositoryFiles(root: string): string[] {
  return git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    .filter((f) => f && fs.existsSync(path.join(root, f)) && fs.lstatSync(path.join(root, f)).isFile());
}

const hashOf = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** sha256 of every file under `dir`, by relative path — node_modules and .git left out. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (e.name === 'node_modules' || e.name === '.git')) continue;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.set(r, hashOf(path.join(dir, r)));
    }
  };
  walk('');
  return out;
}

function compare(a: Map<string, string>, b: Map<string, string>): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = []; const added: string[] = []; const removed: string[] = [];
  for (const [f, h] of a) { if (!b.has(f)) removed.push(f); else if (b.get(f) !== h) changed.push(f); }
  for (const f of b.keys()) if (!a.has(f)) added.push(f);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/** Run a command in the copy; parse stdout as JSON when asked. */
function run(ws: string, args: string[], json: boolean): { status: number | null; out: unknown; stderr: string } {
  const r = spawnSync(process.execPath, args, { cwd: ws, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  let out: unknown = r.stdout;
  if (json) { try { out = JSON.parse(r.stdout); } catch { out = null; } }
  return { status: r.status, out, stderr: (r.stderr ?? '').slice(-4000) };
}
const cli = (ws: string, args: string[]) => run(ws, ['-r', 'ts-node/register/transpile-only', 'lab/algorithms/release-cli.ts', ...args, '--json'], true);

export async function rehearse(candidate: string, opts: { keep?: boolean; approvedAt?: string } = {}): Promise<RehearsalReport> {
  const root = LAB_ROOT;
  const files = repositoryFiles(root);
  const repoBefore = new Map(files.map((f) => [f, hashOf(path.join(root, f))]));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-rehearsal-'));
  const report: RehearsalReport = { ok: false, candidate, steps: [], promotion: null, leftovers: [], repositoryUntouched: false, workspace: opts.keep ? ws : null };
  const step = (name: string, fn: () => { ok: boolean; detail: unknown }) => {
    const t = Date.now();
    let r: { ok: boolean; detail: unknown };
    try { r = fn(); } catch (err) { r = { ok: false, detail: err instanceof Error ? err.message : String(err) }; }
    report.steps.push({ step: name, ok: r.ok, ms: Date.now() - t, detail: r.detail });
    return r.ok;
  };
  try {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(ws, f));
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(ws, 'node_modules'), 'dir');
    const before = snapshot(ws);
    const date = opts.approvedAt ?? new Date().toISOString().slice(0, 10);

    const current = (label: string) => step(label, () => {
      const manifest = run(ws, ['scripts/algorithms-discover.js', '--check'], false);
      const evidence = run(ws, ['-r', 'ts-node/register/transpile-only', 'lab/algorithms/cli.ts', '--check'], false);
      const security = run(ws, ['scripts/security-discover.js', '--check'], false);
      const generated = JSON.parse(fs.readFileSync(path.join(ws, SECURITY), 'utf8')) as { controls: Array<{ id: string; status: string }> };
      const required = (JSON.parse(fs.readFileSync(path.join(ws, POLICY), 'utf8')) as { requiredControls: string[] }).requiredControls;
      const present = required.filter((id) => generated.controls.some((c) => c.id === id && c.status === 'PRESENT')).length;
      return {
        ok: manifest.status === 0 && evidence.status === 0 && security.status === 0 && required.length > 0 && present === required.length,
        detail: {
          algorithmManifest: manifest.status, candidateEvidence: evidence.status, securityManifest: security.status,
          requiredControls: { present, required: required.length },
          stderr: [manifest, evidence, security].map((x) => (x.status ? x.stderr : '')).join(''),
        },
      };
    });

    // Rollback is compared with the tree as it was, so the tree has to be current to begin with.
    const ran = current('generated files current (before)')
    && step('plan', () => {
      const r = cli(ws, ['plan', candidate]);
      const p = r.out as { state?: string; refusals?: string[] } | null;
      const untouched = compare(before, snapshot(ws));
      const writes = [...untouched.changed, ...untouched.added, ...untouched.removed];
      return { ok: r.status === 0 && p?.state === 'READY' && writes.length === 0, detail: { state: p?.state ?? null, refusals: p?.refusals ?? null, wrote: writes, stderr: r.status ? r.stderr : '' } };
    })
    && step('apply', () => {
      const r = cli(ws, ['apply', candidate, '--reference', REHEARSAL_REFERENCE, '--date', date]);
      report.promotion = compare(before, snapshot(ws));
      return { ok: r.status === 0, detail: { out: r.out, stderr: r.status ? r.stderr : '' } };
    })
    && step('verify (promoted)', () => {
      const r = cli(ws, ['verify', '--deep']);
      const v = r.out as { ok?: boolean; algorithms?: Array<{ key: string; approval: string; gate: string; binding: { state: string }; reproduction: { state: string } | null }> } | null;
      const changes = (v?.algorithms ?? []).filter((a) => a.approval === 'CHANGE');
      return {
        ok: r.status === 0 && v?.ok === true && changes.length === 1 && changes[0].binding.state === 'VALID' && changes[0].reproduction?.state === 'REPRODUCED',
        detail: v ?? r.stderr,
      };
    })
    && current('generated files current (promoted)')
    && step('rollback', () => {
      const r = cli(ws, ['rollback', candidate]);
      const after = snapshot(ws);
      const diff = compare(before, after);
      const regenerated = (f: string) => (f === EVIDENCE || f === SECURITY) && sameApartFromRun(root, ws, f);
      report.leftovers = [...diff.changed.filter((f) => !regenerated(f)), ...diff.added, ...diff.removed];
      return { ok: r.status === 0 && report.leftovers.length === 0, detail: { out: r.out, leftovers: report.leftovers, stderr: r.status ? r.stderr : '' } };
    })
    && step('verify (rolled back)', () => {
      const r = cli(ws, ['verify']);
      const v = r.out as { ok?: boolean; algorithms?: Array<{ approval: string }> } | null;
      return { ok: r.status === 0 && v?.ok === true && !(v.algorithms ?? []).some((a) => a.approval === 'CHANGE'), detail: v ?? r.stderr };
    });

    const repoAfter = new Map(files.map((f) => [f, fs.existsSync(path.join(root, f)) ? hashOf(path.join(root, f)) : '']));
    report.repositoryUntouched = [...repoBefore].every(([f, h]) => repoAfter.get(f) === h);
    report.ok = ran && report.repositoryUntouched;
    return report;
  } finally {
    if (!opts.keep) fs.rmSync(ws, { recursive: true, force: true });
  }
}
