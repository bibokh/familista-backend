// Familista — what a lab child process does: one job, reported as JSON lines
// ─────────────────────────────────────────────────────────────────────────────
// Runs ONLY inside a child process started by runner.ts. Three jobs exist:
//
//   method-checks       the comparison method checks itself on planted versions
//   candidate:<id>      one candidate from the allow-list, against the
//                       approved version, on the development and the held-out
//                       sets
//   release:<id>        the same evidence for a candidate being promoted
//                       (release/dossier.ts), plus what the promotion does to
//                       each dependant the release tool can run
//
// A job names an id, never a path: a candidate's file comes from the
// allow-list (candidates/index.ts). Tests may point at a fixture allow-list,
// and only one under tests/fixtures/lab/. A release job reads three modules
// from the one directory its parent made for it (RELEASE_DIR) — the approved
// file, the candidate and the promoted file, each checked by fingerprint
// before it was written there — and loads nothing else.
//
// For a candidate the child reports its declaration FIRST — so a run that is
// later killed still says what was proposed — then its results and what the
// run cost. The parent validates both and decides the verdict; nothing here
// judges.

import * as path from 'path';
import { performance } from 'perf_hooks';
import { computeXG, type ShotFeatures } from '../../src/match-events/xg-model.service';
import { CANDIDATE_INDEX, type CandidateIndexEntry } from './candidates';
import { CANDIDATE_ALGORITHMS, ENTRY_POINT, PROBE_SETS, SCENARIOS, TIMING_SEED, type CandidateAlgorithm, type Phase } from './spec';
import { dependantsOf } from './engine/code';
import { evaluatePhase, type Counter } from './engine/compare';
import { runMethodChecks } from './engine/method-checks';
import { drawShot, seeded, type Fn } from './engine/shots';
import { simulateDependant } from './release/dependants';
import { DEPENDANT_SIMULATIONS, RELEASE_DIR, RELEASE_FILES } from './release/spec';

const APPROVED: Readonly<Record<CandidateAlgorithm, Fn>> = { xg: computeXG };
const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'lab') + path.sep;

export type Emit = (message: Record<string, unknown>) => void;

/** The allow-list this process may load from, and the directory its files are in. */
function allowList(): { index: readonly CandidateIndexEntry[]; dir: string } {
  const fixture = process.env.LAB_CANDIDATE_INDEX;
  if (!fixture) return { index: CANDIDATE_INDEX, dir: path.join(__dirname, 'candidates') };
  const file = path.resolve(ROOT, fixture);
  if (!file.startsWith(FIXTURES)) throw new Error('a fixture allow-list must live under tests/fixtures/lab/');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(file) as { CANDIDATE_INDEX: readonly CandidateIndexEntry[] };
  return { index: mod.CANDIDATE_INDEX, dir: path.dirname(file) };
}

function releaseModules(): Record<keyof typeof RELEASE_FILES, Record<string, unknown>> {
  const dir = process.env.LAB_RELEASE_DIR ?? '';
  if (!path.isAbsolute(dir) || !RELEASE_DIR.test(path.basename(dir))) throw new Error('a release job reads only the directory its parent prepared');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const load = (name: string) => require(path.join(dir, name)) as Record<string, unknown>;
  return { approved: load(RELEASE_FILES.approved), candidate: load(RELEASE_FILES.candidate), promoted: load(RELEASE_FILES.promoted) };
}

const probeSet = (phase: Phase) => {
  const p = PROBE_SETS.find((s) => s.phase === phase);
  if (!p) throw new Error(`no ${phase} probe set`);
  return p;
};

/** Median nanoseconds per call for each version, alternating which goes first. */
function perCall(approved: Fn, candidate: Fn): { approved: number; candidate: number } {
  const rng = seeded(TIMING_SEED);
  const shots: ShotFeatures[] = [];
  for (let i = 0; i < 20_000; i += 1) shots.push(drawShot('step3-mix', rng, { x: 0, y: 0 }));
  let sink = 0;
  const time = (fn: Fn) => {
    const t = process.hrtime.bigint();
    for (const s of shots) sink += fn(s);
    return Number(process.hrtime.bigint() - t) / shots.length;
  };
  const a: number[] = []; const c: number[] = [];
  for (let r = 0; r < 5; r += 1) {
    if (r % 2) { c.push(time(candidate)); a.push(time(approved)); } else { a.push(time(approved)); c.push(time(candidate)); }
  }
  const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  if (!Number.isFinite(sink)) sink = 0;
  return { approved: median(a), candidate: median(c) };
}

function measured(startMs: number, counter: Counter, calls: { approved: number; candidate: number } | null) {
  const cpu = process.cpuUsage();
  return {
    wallMs: null,
    startupMs: startMs,
    evaluationMs: performance.now() - startMs,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    heapUsedBytes: process.memoryUsage().heapUsed,
    predictions: counter.predictions,
    approvedNsPerCall: calls ? calls.approved : null,
    candidateNsPerCall: calls ? calls.candidate : null,
  };
}

export async function runJob(job: string, emit: Emit): Promise<void> {
  // Everything before this line — Node, ts-node, every module — is start-up.
  const start = performance.now();
  const counter: Counter = { predictions: 0 };

  if (job === 'method-checks') {
    const checks = runMethodChecks(counter);
    emit({ kind: 'result', checks, measured: measured(start, counter, null) });
    return;
  }

  const r = /^release:([a-z0-9][a-z0-9.-]{0,47})$/.exec(job);
  if (r) {
    const mods = releaseModules();
    const declaration = (mods.candidate.CANDIDATE ?? null) as { id?: unknown; algorithm?: unknown } | null;
    emit({ kind: 'declaration', declaration });
    if (!declaration || declaration.id !== r[1]) throw new Error('the candidate is not the one the job names');
    const algorithm = CANDIDATE_ALGORITHMS.find((a) => a === declaration.algorithm);
    if (!algorithm) throw new Error('the candidate names no algorithm the lab can run');
    const entry = ENTRY_POINT[algorithm];
    const approved = mods.approved[entry];
    const candidate = mods.candidate[entry];
    if (typeof approved !== 'function' || typeof candidate !== 'function') throw new Error(`${entry} is not exported`);
    const development = evaluatePhase(algorithm, 'DEVELOPMENT', SCENARIOS, probeSet('DEVELOPMENT'), approved as Fn, candidate as Fn, counter);
    const heldOut = evaluatePhase(algorithm, 'HELD_OUT', SCENARIOS, probeSet('HELD_OUT'), approved as Fn, candidate as Fn, counter);
    const dependants = dependantsOf(algorithm)
      .filter((d) => DEPENDANT_SIMULATIONS[d.key])
      .map((d) => simulateDependant(algorithm, d.key, mods.approved, mods.promoted, counter));
    emit({ kind: 'result', results: { development, heldOut }, dependants, measured: measured(start, counter, null) });
    return;
  }

  const m = /^candidate:([a-z0-9][a-z0-9.-]{0,47})$/.exec(job);
  if (!m) throw new Error('unknown job');
  const { index, dir } = allowList();
  const entry = index.find((e) => e.id === m[1]);
  if (!entry) throw new Error('the candidate is not in the allow-list');
  if (!/^[a-z0-9][a-z0-9.-]*\.ts$/.test(entry.file)) throw new Error('an allow-list file must be a plain name');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join(dir, entry.file)) as Record<string, unknown>;
  emit({ kind: 'declaration', declaration: mod.CANDIDATE ?? null });
  const fn = mod[ENTRY_POINT[entry.algorithm]];
  if (typeof fn !== 'function') throw new Error('the candidate does not export its entry point');
  const approved = APPROVED[entry.algorithm];
  const candidate = fn as Fn;
  const development = evaluatePhase(entry.algorithm, 'DEVELOPMENT', SCENARIOS, probeSet('DEVELOPMENT'), approved, candidate, counter);
  const heldOut = evaluatePhase(entry.algorithm, 'HELD_OUT', SCENARIOS, probeSet('HELD_OUT'), approved, candidate, counter);
  const evaluated = measured(start, counter, null);
  const calls = perCall(approved, candidate);
  emit({ kind: 'result', results: { development, heldOut }, measured: { ...evaluated, approvedNsPerCall: calls.approved, candidateNsPerCall: calls.candidate } });
}
