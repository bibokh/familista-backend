/**
 * Algorithms, Step 4 — a candidate never runs where it could do harm.
 *
 * THE TESTS THIS FILE EXISTS FOR
 *
 *   1. The parent stops a child, whatever the child does. A synchronous
 *      infinite loop cannot cooperate, so it is not asked to: past the time
 *      limit the parent sends SIGKILL to the child's whole process group, and
 *      afterwards no live process — child or grandchild — remains in it.
 *   2. The other limits hold too: a child that exhausts its heap, floods its
 *      output or crashes is recorded as such, and none of them leaks a live
 *      process or a pending timer.
 *   3. A child cannot see the parent's secrets: it starts with an empty
 *      environment.
 *   4. Through the real lab pipeline, a candidate that hangs is killed at the
 *      limit, still says what it proposed, and is judged Unavailable — never
 *      Passed.
 *   5. Production never contains or loads a candidate or the engine: the build
 *      compiles src/ only, nothing in src/ imports lab/, and the compiled read
 *      side loads no lab module when it serves candidates.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { runChild, liveGroupMembers, activeChildren, CHILD_ENV, LAB_ROOT, type ChildLimits } from '../lab/algorithms/runner';
import { buildEvidence } from '../lab/algorithms/evidence';
import { CandidateEvidenceSchema } from '../src/algorithms/candidate-evidence';

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'lab');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const limits = (over: Partial<ChildLimits> = {}): ChildLimits => ({
  timeoutMs: 1_500, heapMb: 64, maxStdoutBytes: 64 * 1024, maxStderrBytes: 8 * 1024, ...over,
});
const LINUX = process.platform === 'linux';

/** Is this pid a live (not zombie) process? */
function alive(pid: number): boolean {
  if (LINUX) {
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return false; }
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== 'Z' && state !== 'X';
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · termination, enforced by the parent
// ─────────────────────────────────────────────────────────────────────────────

describe('the parent stops a child that never stops itself', () => {
  it('kills a synchronous infinite loop at the time limit, and nothing of it survives', async () => {
    const started = Date.now();
    const out = await runChild(path.join(FIX, 'hang-child.js'), [], limits({ timeoutMs: 1_500 }));
    const elapsed = Date.now() - started;
    expect(out.state).toBe('TIMED_OUT');
    expect(out.signal).toBe('SIGKILL');
    // Stopped by the parent's clock — not by the test runner's, which is 30 s.
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(6_000);
    expect(out.pid).not.toBeNull();
    expect(alive(out.pid as number)).toBe(false);
    expect(out.groupGone).toBe(true);
    if (LINUX) expect(liveGroupMembers(out.pid as number)).toBe(0);
    expect(activeChildren()).toBe(0);
  });

  it('kills the whole process group, so a grandchild cannot outlive it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-pid-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    try {
      const out = await runChild(path.join(FIX, 'hang-grandchild-child.js'), [], limits({ timeoutMs: 2_000 }), { env: { LAB_TEST_PIDFILE: pidFile } });
      expect(out.state).toBe('TIMED_OUT');
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(grandchild).toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(false);
      expect(alive(out.pid as number)).toBe(false);
      expect(out.groupGone).toBe(true);
      expect(activeChildren()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not slowed by a child that ends early: a fast child is never held to its limit', async () => {
    const started = Date.now();
    const out = await runChild(path.join(FIX, 'crash-child.js'), [], limits({ timeoutMs: 20_000 }));
    expect(out.state).toBe('CRASHED');
    expect(out.exitCode).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.groupGone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · the other limits
// ─────────────────────────────────────────────────────────────────────────────

describe('memory and output are capped, and every end is named', () => {
  it('a child that exhausts its heap is recorded as MEMORY_LIMIT', async () => {
    const out = await runChild(path.join(FIX, 'alloc-child.js'), [], limits({ heapMb: 32, timeoutMs: 20_000 }));
    expect(out.state).toBe('MEMORY_LIMIT');
    expect(out.groupGone).toBe(true);
    expect(alive(out.pid as number)).toBe(false);
  });

  it('a child that floods stdout is killed at the cap, and the parent keeps no more than the cap', async () => {
    const out = await runChild(path.join(FIX, 'noisy-child.js'), [], limits({ maxStdoutBytes: 64 * 1024, timeoutMs: 20_000 }));
    expect(out.state).toBe('OUTPUT_LIMIT');
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(out.groupGone).toBe(true);
  });

  it('leaves no live child and no pending timer behind', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    // A 60 s limit on a child that ends at once: the runner must clear its timer, not leave it running.
    await runChild(path.join(FIX, 'crash-child.js'), [], limits({ timeoutMs: 60_000 }));
    expect(activeChildren()).toBe(0);
    expect(timers()).toBeLessThanOrEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · no secret reaches a child
// ─────────────────────────────────────────────────────────────────────────────

describe('a child starts with an empty environment', () => {
  it('sees none of the parent\'s variables — only what the runner gives it', async () => {
    process.env.LAB_SECRET_PROBE = 'must-not-leak';
    try {
      const out = await runChild(path.join(FIX, 'env-child.js'), [], limits());
      expect(out.state).toBe('COMPLETED');
      const seen = JSON.parse(out.stdout.trim()) as string[];
      for (const secret of ['LAB_SECRET_PROBE', 'DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ANTHROPIC_API_KEY', 'HOME', 'PATH']) {
        expect(`${secret}: ${seen.includes(secret)}`).toBe(`${secret}: false`);
      }
      expect(seen.every((k) => Object.keys(CHILD_ENV).includes(k))).toBe(true);
    } finally {
      delete process.env.LAB_SECRET_PROBE;
    }
  });

  it('is never given the parent\'s environment by the runner', () => {
    const runner = read('lab/algorithms/runner.ts').replace(/\/\/[^\n]*/g, '');
    expect(runner).toContain('env: { ...CHILD_ENV, ...(opts.env ?? {}) }');
    expect(runner).not.toMatch(/\.\.\.process\.env/);
    expect(Object.keys(CHILD_ENV).sort()).toEqual(['TS_NODE_PROJECT', 'TS_NODE_TRANSPILE_ONLY']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · a hanging candidate, through the real pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('a candidate that hangs is stopped, recorded and never passed', () => {
  jest.setTimeout(60_000);

  it('is killed at the limit, keeps its declaration, and is judged Unavailable', async () => {
    const started = Date.now();
    const { evidence, children } = await buildEvidence({
      index: [{ id: 'hang-v9.9', algorithm: 'xg', file: 'hang-v9.9.ts' }],
      fixtureIndex: 'tests/fixtures/lab/candidates/index.ts',
      limits: { jobTimeoutMs: 8_000 },
    });
    const elapsed = Date.now() - started;
    expect(CandidateEvidenceSchema.safeParse(evidence).success).toBe(true);

    const hang = children.find((c) => c.job === 'candidate:hang-v9.9');
    expect(hang?.outcome.state).toBe('TIMED_OUT');
    expect(hang?.outcome.signal).toBe('SIGKILL');
    expect(hang?.outcome.groupGone).toBe(true);
    expect(alive(hang?.outcome.pid as number)).toBe(false);
    // The method checks still ran, in their own process, before it.
    expect(children.find((c) => c.job === 'method-checks')?.outcome.state).toBe('COMPLETED');
    expect(elapsed).toBeLessThan(40_000);
    expect(activeChildren()).toBe(0);

    const entry = evidence.candidates[0];
    expect(entry.run).toMatchObject({ state: 'TIMED_OUT', signal: 'SIGKILL', timeoutMs: 8_000 });
    expect(entry.declaration?.id).toBe('hang-v9.9');
    expect(entry.results).toBeNull();
    expect(entry.verdict).toEqual({ test: 'UNAVAILABLE', reasons: ['RUN_TIMED_OUT'], agreement: null });
    expect(entry.status).toBe('EXPERIMENTAL');
    expect(entry.approval).toBe('NOT_APPROVED');
  });

  it('refuses an allow-list file that is a path rather than a name', async () => {
    await expect(buildEvidence({ index: [{ id: 'escape', algorithm: 'xg', file: '../../src/server.ts' }], limits: { jobTimeoutMs: 8_000 } }))
      .rejects.toThrow(/not a plain file name/);
    expect(activeChildren()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · production never contains or loads the lab
// ─────────────────────────────────────────────────────────────────────────────

describe('the production build has no candidate and no engine in it', () => {
  it('compiles src/ only', () => {
    const ts = JSON.parse(read('tsconfig.json'));
    expect(ts.compilerOptions.rootDir).toBe('./src');
    expect(ts.include).toEqual(['src/**/*']);
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.build).not.toMatch(/\blab\//);
    expect(pkg.scripts['algorithms:candidates']).toBe('ts-node --transpile-only lab/algorithms/cli.ts');
  });

  it('nothing under src/ imports the lab', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|js)$/.test(e.name) && /(?:from\s+|require\(\s*|import\(\s*)['"][^'"]*\blab\//.test(read(rel))) offenders.push(rel);
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('ships the evidence as data, and no lab code, in the compiled output', () => {
    const dist = path.join(ROOT, 'dist');
    if (!fs.existsSync(dist)) {
      // CI always builds before it tests, so there the build must be here.
      expect(process.env.CI ? 'dist missing in CI' : 'skipped locally').toBe('skipped locally');
      return;
    }
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith('.js') && /LAB_SPEC_VERSION|runMethodChecks|evaluatePhase|ENTRY_POINT|LAB_CANDIDATE_INDEX/.test(fs.readFileSync(abs, 'utf8'))) found.push(path.relative(dist, abs));
      }
    };
    walk(dist);
    expect(found).toEqual([]);
    expect(fs.existsSync(path.join(dist, 'lab'))).toBe(false);
    expect(fs.readFileSync(path.join(dist, 'algorithms', 'generated', 'candidate-evidence.json'), 'utf8'))
      .toBe(read('src/algorithms/generated/candidate-evidence.json'));
  });

  it('the compiled read side serves candidates without loading a single lab module', () => {
    const dist = path.join(ROOT, 'dist', 'algorithms', 'candidates.js');
    if (!fs.existsSync(dist)) {
      expect(process.env.CI ? 'dist missing in CI' : 'skipped locally').toBe('skipped locally');
      return;
    }
    const probe = [
      `const c = require(${JSON.stringify(dist)});`,
      'const list = c.algorithmCandidates();',
      "const one = c.algorithmCandidate('xg-v1.1');",
      "const lab = Object.keys(require.cache).filter((p) => p.split(require('path').sep).includes('lab'));",
      "const spawned = process.moduleLoadList.some((m) => /\\bchild_process\\b/.test(m));",
      'process.stdout.write(JSON.stringify({ state: list.state, n: list.candidates.length, found: one.state, deployable: one.detail && one.detail.deployable, lab, spawned }));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', probe], { cwd: ROOT, encoding: 'utf8', env: {} });
    expect(r.status).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res).toEqual({ state: 'READY', n: 1, found: 'FOUND', deployable: false, lab: [], spawned: false });
  });

  it('the lab root is the repository root, so the build and the lab never share a directory', () => {
    expect(LAB_ROOT).toBe(ROOT);
    expect(path.relative(path.join(ROOT, 'src'), path.join(ROOT, 'lab')).startsWith('..')).toBe(true);
  });
});
