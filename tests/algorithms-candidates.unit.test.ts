/**
 * Algorithms, Step 4 — Propose → Simulate → Test, for candidates.
 *
 * THE TESTS THIS FILE EXISTS FOR
 *
 *   1. The statistics are right: paired intervals, log-loss and the
 *      conditional sample-size estimate against values worked out by hand —
 *      and an estimate that cannot exist is UNDEFINED or UNSTABLE, never a
 *      number that would mislead.
 *   2. The comparison is paired and honest: identical versions differ by
 *      exactly nothing, invalid outputs are counted, never averaged, and the
 *      method proves itself on planted differences before any verdict.
 *   3. Only properties decide, and only on held-out seeds: brackets and
 *      sample sizes never move a verdict; a property both versions break is
 *      not the candidate's doing; development and held-out never share a seed.
 *   4. The candidate is exactly what it says: one declaration changed, the
 *      fingerprint production would carry, a current baseline, EXPERIMENTAL
 *      and NOT_APPROVED — and the committed evidence is exactly what the lab
 *      produces today.
 *   5. The server judges the evidence against today's registry: stale evidence
 *      is shown as stale, the gate never says Approved for a candidate, no
 *      path on the loop reaches Deploy, and only the platform owner reads it.
 *   6. Nothing is called better, more accurate or calibrated; every view
 *      carries the synthetic banner.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import express from 'express';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER = 'user-owner';
const PRESIDENT = 'user-president';
const CLUB = 'club-1';
const db: Row = {
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === OWNER ? { isActive: true } : null) },
  user: { findUnique: async () => null, findFirst: async () => null },
};
jest.mock('../src/config/database', () => ({ prisma: db, basePrisma: db }));

let actingAs: Row | null = null;
jest.mock('../src/middleware/auth.middleware', () => ({
  authenticate: (req: Row, res: Row, next: () => void) => {
    if (!actingAs) { res.status(401).json({ success: false, message: 'unauthenticated' }); return; }
    req.user = actingAs;
    next();
  },
  onIdentityForgotten: () => () => undefined,
  sessionStillValid: async () => true,
}));

// The evidence the server reads can be replaced per test; by default it is the real, committed file.
let mockEvidence: (() => unknown) | null = null;
jest.mock('../src/algorithms/candidate-evidence', () => {
  const real = jest.requireActual('../src/algorithms/candidate-evidence');
  return { ...real, readCandidateEvidence: (...a: unknown[]) => (mockEvidence ? mockEvidence() : real.readCandidateEvidence(...a)) };
});

import { ALGORITHMS, algorithmOf } from '../src/algorithms/registry';
import { canAdvance, LOOP_STAGES, type LoopStage } from '../src/algorithms/loop';
import { evaluate } from '../src/algorithms/scenarios';
import { SYNTHETIC_SCENARIOS, SEED_OFFSET, SYNTHETIC_KEYS } from '../src/algorithms/learning-spec';
import { computeXG } from '../src/match-events/xg-model.service';
import {
  CandidateEvidenceSchema, CandidateDeclarationSchema, CANDIDATE_NOTICE, EVIDENCE_REASONS,
  readCandidateEvidence as realRead, resetCandidateEvidence,
  type CandidateEvidence, type LabPhaseResult, type LabPropertyResult, type LabScenarioResult, type LabRun,
} from '../src/algorithms/candidate-evidence';
import { algorithmCandidates, algorithmCandidate } from '../src/algorithms/candidates';
import { AlgorithmsCandidatesSchema, AlgCandidateDetailSchema } from '../src/contracts/owner-api.contracts';
import { peekPending, recorderCounters } from '../src/algorithms/telemetry';
import algorithmsRoutes from '../src/routes/algorithms.routes';

import {
  CANDIDATE_ALGORITHMS, LAB_RULES, LAB_LIMITS, METHOD_SEEDS, PROBE_SETS, PROPERTIES, SCENARIOS, SHOT_MIXES,
  STREAM_OFFSET, TIMING_SEED, LAB_NOTICE, CONDITIONAL_NOTE, LAB_JUSTIFICATIONS, WORLDS,
} from '../lab/algorithms/spec';
import { pairedInterval, logLoss, requiredFromMoments, requiredShots, excludesZero } from '../lab/algorithms/engine/stats';
import { compareScenario, probeProperties, LabLimitError } from '../lab/algorithms/engine/compare';
import { METHOD_CHECKS } from '../lab/algorithms/engine/method-checks';
import { outcomeOf } from '../lab/algorithms/engine/properties';
import { judge, agreementOf } from '../lab/algorithms/engine/judge';
import { codeOf, lineDiff, dependantsOf } from '../lab/algorithms/engine/code';
import { buildEvidence, deterministicView, firstDifference, readCommittedEvidence } from '../lab/algorithms/evidence';
import { CANDIDATE_INDEX } from '../lab/algorithms/candidates';
import { CANDIDATE, computeXG as candidateXG } from '../lab/algorithms/candidates/xg-v1.1';

const ROOT = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const committed = () => CandidateEvidenceSchema.parse(readCommittedEvidence()) as CandidateEvidence;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

beforeEach(() => { mockEvidence = null; resetCandidateEvidence(); });

// ─────────────────────────────────────────────────────────────────────────────
// 1 · the statistics, against values worked out by hand
// ─────────────────────────────────────────────────────────────────────────────

describe('the statistics are right', () => {
  it('a paired interval is mean ± 1.96·sd/√n, negative values allowed', () => {
    // d = 1, −1, 1, −1: mean 0, variance 4/3, half-width 1.96·√(4/3 / 4) = 1.13161.
    const i = pairedInterval(0, 4, 4)!;
    expect(i.value).toBe(0);
    expect(close(i.high, 1.96 * Math.sqrt(1 / 3), 1e-12)).toBe(true);
    expect(close(i.low, -i.high, 1e-12)).toBe(true);
    // All differences −2: mean −2, no spread.
    expect(pairedInterval(-8, 16, 4)).toEqual({ value: -2, low: -2, high: -2 });
    expect(pairedInterval(1, 1, 1)).toBeNull();
    expect(excludesZero({ value: 0.1, low: 0.01, high: 0.2 })).toBe(true);
    expect(excludesZero({ value: 0.1, low: -0.01, high: 0.2 })).toBe(false);
  });

  it('log-loss is clipped exactly as Learning clips it', () => {
    expect(close(logLoss(0.5, 1), Math.log(2))).toBe(true);
    expect(close(logLoss(0, 1), -Math.log(1e-6))).toBe(true);
    expect(close(logLoss(1, 0), -Math.log(1e-6))).toBe(true);
  });

  it('the shots a paired Brier test needs: ((z_α + z_β) σ / μ)², from exact per-shot moments', () => {
    // Two shots, each with E[d] = 0.01 and Var[d] = 0.0004: μ = 0.01, σ² = 0.0004.
    // n = (2.8016 × 0.02 / 0.01)² = 5.6032² = 31.3958…
    const n = requiredFromMoments(0.02, 0.0002, 0.0008, 2);
    expect(close(n, (2 * (1.96 + 0.8416)) ** 2, 1e-9)).toBe(true);
    expect(requiredFromMoments(0, 0, 0, 10)).toBe(Infinity);
  });

  it('says UNDEFINED when the versions never differ, rather than inventing a figure', () => {
    const b = new Float64Array([0.1, 0.2, 0.3]);
    expect(requiredShots(b, b, b, 3, 0, 1)).toEqual({ status: 'UNDEFINED', point: null, low: null, high: null, reasons: ['NO_DIFFERENCE'] });
  });

  it('says UNSTABLE, with why, when too few shots differ or a resample shows no difference', () => {
    const n = 1_000;
    const b = new Float64Array(n).fill(0.2);
    const c = new Float64Array(n).fill(0.2);
    c[0] = 0.4; c[1] = 0.4; // two changed shots out of a thousand
    const r = requiredShots(b, c, b, n, 2, 42);
    expect(r.status).toBe('UNSTABLE');
    expect(r.reasons).toEqual(expect.arrayContaining(['FEW_CHANGED_SHOTS', 'RESAMPLE_WITHOUT_DIFFERENCE']));
    expect(r.point).not.toBeNull();
    expect(r.high).toBeNull();
  });

  it('gives a bounded, deterministic estimate when enough shots differ', () => {
    const n = 4_000;
    const b = new Float64Array(n).fill(0.2);
    const c = new Float64Array(n).fill(0.2);
    for (let i = 0; i < 400; i += 1) c[i] = 0.3;
    const a = requiredShots(b, c, b, n, 400, 7);
    expect(a.status).toBe('ESTIMATED');
    expect(a.reasons).toEqual([]);
    expect(a.low! <= a.point! && a.point! <= a.high!).toBe(true);
    expect(requiredShots(b, c, b, n, 400, 7)).toEqual(a);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · the comparison is paired, and the method proves itself
// ─────────────────────────────────────────────────────────────────────────────

describe('a comparison is paired and honest', () => {
  const decl = { id: 't', mix: 'step3-mix' as const, shots: 5_000, seed: 99_000_001 };

  it('identical versions differ by exactly nothing', () => {
    const r = compareScenario(decl, 'DEVELOPMENT', computeXG, computeXG, { predictions: 0 });
    expect(r.divergence.changed).toBe(0);
    for (const w of r.worlds) {
      expect(w.status).toBe('NO_DIFFERENCE');
      expect(w.brierDelta).toEqual({ value: 0, low: 0, high: 0 });
      expect(w.required.status).toBe('UNDEFINED');
    }
  });

  it('in each world the expected Brier difference is ± the mean squared difference, and the 95% interval covers it', () => {
    // Lifting every shot by exactly 0.05 makes the mean squared difference 0.0025. In
    // the world built from the approved version the expected difference is +0.0025;
    // in the candidate's own, −0.0025. A 95% interval should cover it in about 19 of
    // 20 independent seeds — so the test asks for at least 17 of 20, on fixed seeds.
    const lift = (f: Parameters<typeof computeXG>[0]) => +Math.min(1, computeXG(f) + 0.05).toFixed(4);
    const msd = 0.05 * 0.05;
    let inApproved = 0; let inCandidate = 0;
    for (let k = 0; k < 20; k += 1) {
      const r = compareScenario({ ...decl, shots: 1_000, seed: 99_100_001 + k }, 'DEVELOPMENT', computeXG, lift, { predictions: 0 });
      const a = r.worlds.find((w) => w.world === 'APPROVED')!.brierDelta!;
      const c = r.worlds.find((w) => w.world === 'CANDIDATE')!.brierDelta!;
      if (a.low <= msd && msd <= a.high) inApproved += 1;
      if (c.low <= -msd && -msd <= c.high) inCandidate += 1;
      expect(r.divergence.maxDecrease).toBe(0);
    }
    expect(inApproved).toBeGreaterThanOrEqual(17);
    expect(inCandidate).toBeGreaterThanOrEqual(17);
  });

  it('counts invalid outputs and never averages them in', () => {
    const broken = (f: Parameters<typeof computeXG>[0]) => (f.x > 110 ? NaN : computeXG(f));
    const r = compareScenario(decl, 'DEVELOPMENT', computeXG, broken, { predictions: 0 });
    expect(r.invalid.approved).toBe(0);
    expect(r.invalid.candidate).toBeGreaterThan(0);
    for (const w of r.worlds) if (w.brierDelta) expect(Number.isFinite(w.brierDelta.value)).toBe(true);
  });

  it('is deterministic for its seed', () => {
    const small = { ...decl, mix: 'close-range' as const, shots: 2_000 };
    const a = compareScenario(small, 'HELD_OUT', computeXG, candidateXG, { predictions: 0 });
    const b = compareScenario(small, 'HELD_OUT', computeXG, candidateXG, { predictions: 0 });
    expect(a.divergence.changed).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('refuses a scenario beyond its limits', () => {
    expect(() => compareScenario({ ...decl, shots: LAB_LIMITS.shotsPerScenarioMax + 1 }, 'DEVELOPMENT', computeXG, computeXG, { predictions: 0 }))
      .toThrow(LabLimitError);
    expect(() => probeProperties('xg', { seed: 1, instances: LAB_LIMITS.probeInstancesMax + 1 }, computeXG, computeXG, { predictions: 0 }))
      .toThrow(LabLimitError);
  });

});

describe('properties compare like with like', () => {
  const runs = (a: typeof computeXG, c: typeof computeXG) => probeProperties('xg', { seed: 77_000_101, instances: 1_000 }, a, c, { predictions: 0 });

  it('catches the approved version\'s own reversal near goal, and finds none in the candidate', () => {
    const r = runs(computeXG, candidateXG);
    const by = (id: string) => r.find((x) => x.id === id)!;
    expect(by('closer-never-worse').approved.violations).toBeGreaterThan(0);
    expect(by('closer-never-worse').candidate.violations).toBe(0);
    expect(by('wider-view-never-worse').approved.violations).toBeGreaterThan(0);
    expect(by('wider-view-never-worse').candidate.violations).toBe(0);
    for (const id of ['range', 'header-never-above-foot', 'deterministic', 'penalty-spot-plausible']) {
      expect(`${id}: ${by(id).approved.violations + by(id).candidate.violations}`).toBe(`${id}: 0`);
    }
    // The example is evidence a reviewer can reproduce: closer, and lower.
    const ex = by('closer-never-worse').approved.example!;
    expect(ex.points.length).toBe(LAB_RULES.rayFractions.length);
  });

  it('names an outcome only from both sides', () => {
    const side = (v: number) => ({ violations: v, invalid: 0, example: null });
    const run = (a: number, c: number) => ({ id: 'range' as const, instances: 1, inRegion: 0, approved: side(a), candidate: side(c) });
    expect([run(0, 0), run(1, 0), run(0, 1), run(1, 1)].map(outcomeOf)).toEqual(['KEPT', 'FIXED', 'BROKEN', 'STILL_FAILING']);
  });

  it('generalises every one of Step 1\'s xG checks, verbatim, and leaves Step 1 untouched', () => {
    const stepOne = evaluate('xg').scenarios.flatMap((s) => s.checks.map((c) => c.label)).sort();
    expect(PROPERTIES.xg.map((p) => p.stepOne).sort()).toEqual(stepOne);
    // The approved version still passes every Step 1 check, as it did before Step 4.
    expect(evaluate('xg').state).toBe('PASS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · only properties decide, only on held-out seeds
// ─────────────────────────────────────────────────────────────────────────────

type Outcome = LabPropertyResult['outcome'];
const prop = (id: string, outcome: Outcome, over: Partial<LabPropertyResult> = {}): LabPropertyResult => ({
  id, instances: 4_000, inRegion: 500,
  approved: { violations: outcome === 'FIXED' || outcome === 'STILL_FAILING' ? 9 : 0, invalid: 0, example: null },
  candidate: { violations: outcome === 'BROKEN' || outcome === 'STILL_FAILING' ? 9 : 0, invalid: 0, example: null },
  outcome, covered: true, ...over,
});
const scen = (over: Partial<LabScenarioResult> = {}): LabScenarioResult => ({
  id: 'held-step3', phase: 'HELD_OUT', mix: 'step3-mix', shots: 100, seed: 1, invalid: { approved: 0, candidate: 0 },
  divergence: { changed: 5, share: { value: 0.05, low: 0.02, high: 0.1 }, meanAbsDelta: 0.001, maxIncrease: 0.01, maxDecrease: 0, bands: [] },
  worlds: [], ...over,
});
const phase = (p: 'DEVELOPMENT' | 'HELD_OUT', props: LabPropertyResult[], scenarios: LabScenarioResult[] = [scen()]): LabPhaseResult => ({ phase: p, scenarios, properties: props });
const ok: LabRun = { state: 'COMPLETED', exitCode: 0, signal: null, timeoutMs: 60_000, reasons: [] };
const passing = [{ id: 'x', title: 't', purpose: 'p', expected: 'NO_CHANGE', observed: 'NO_CHANGE', passed: true }];
const good = [prop('range', 'KEPT'), prop('closer-never-worse', 'FIXED'), prop('wider-view-never-worse', 'FIXED')];

describe('the verdict', () => {
  const verdict = (held: LabPropertyResult[], over: { run?: LabRun; dev?: LabPropertyResult[]; scenarios?: LabScenarioResult[]; checks?: typeof passing } = {}) => judge({
    run: over.run ?? ok, methodChecks: over.checks ?? passing, declaration: CANDIDATE,
    results: { development: phase('DEVELOPMENT', over.dev ?? held), heldOut: phase('HELD_OUT', held, over.scenarios) },
  });

  it('passes when every kept property is kept and every claimed fix is fixed', () => {
    expect(verdict(good)).toEqual({ test: 'PASSED', reasons: [], agreement: 'AGREE' });
  });

  it('fails a broken property, an unfixed target, and new invalid outputs', () => {
    expect(verdict([...good, prop('header-never-above-foot', 'BROKEN')]).test).toBe('FAILED');
    expect(verdict([prop('range', 'KEPT'), prop('closer-never-worse', 'KEPT'), prop('wider-view-never-worse', 'FIXED')]).reasons)
      .toContain('TARGET_NOT_FIXED:closer-never-worse');
    expect(verdict(good, { scenarios: [scen({ invalid: { approved: 0, candidate: 3 } })] }).reasons).toContain('NEW_INVALID_OUTPUTS');
  });

  it('is inconclusive when the held-out probes did not reach the changed region', () => {
    const v = verdict([...good, prop('header-never-above-foot', 'KEPT', { covered: false, inRegion: 12 })]);
    expect(v).toMatchObject({ test: 'INCONCLUSIVE', reasons: ['NOT_COVERED:header-never-above-foot'] });
  });

  it('does not blame the candidate for a property both versions break', () => {
    const v = verdict([...good, prop('deterministic', 'STILL_FAILING')]);
    expect(v).toEqual({ test: 'PASSED', reasons: ['SHARED_FAILURE:deterministic'], agreement: 'AGREE' });
  });

  it('gives no verdict without a completed run or a proven method', () => {
    expect(verdict(good, { run: { ...ok, state: 'TIMED_OUT', signal: 'SIGKILL' } })).toEqual({ test: 'UNAVAILABLE', reasons: ['RUN_TIMED_OUT'], agreement: null });
    expect(verdict(good, { checks: [{ ...passing[0], passed: false }] }).reasons).toEqual(['METHOD_CHECKS_FAILED']);
  });

  it('reads held-out only: a development failure does not decide, and is shown as disagreement', () => {
    const v = verdict(good, { dev: [prop('range', 'BROKEN'), prop('closer-never-worse', 'FIXED'), prop('wider-view-never-worse', 'FIXED')] });
    expect(v).toEqual({ test: 'PASSED', reasons: [], agreement: 'DISAGREE' });
    expect(agreementOf(phase('DEVELOPMENT', good), phase('HELD_OUT', good))).toBe('AGREE');
  });

  it('is never moved by a score bracket, however it falls', () => {
    const worse = scen({
      worlds: [{
        world: 'APPROVED', goals: 10, status: 'COMPUTED', brierDelta: { value: 0.5, low: 0.4, high: 0.6 }, logLossDelta: { value: 1, low: 0.9, high: 1.1 },
        distinguishable: true, required: { status: 'ESTIMATED', point: 10, low: 8, high: 12, reasons: [] },
      }],
    });
    expect(verdict(good, { scenarios: [worse] }).test).toBe('PASSED');
    expect(read('lab/algorithms/engine/judge.ts')).not.toMatch(/brierDelta|logLossDelta|required\./);
  });
});

describe('development and held-out never share a seed', () => {
  it('every derived stream is unique, and none is Learning\'s', () => {
    const offsets = Object.values(STREAM_OFFSET);
    const seeds: number[] = [];
    for (const s of SCENARIOS) for (const o of offsets) seeds.push(s.seed + o);
    for (const o of offsets) seeds.push(METHOD_SEEDS.scenario + o);
    const nProps = Math.max(...CANDIDATE_ALGORITHMS.map((a) => PROPERTIES[a].length));
    for (const p of [...PROBE_SETS.map((x) => x.seed), METHOD_SEEDS.probes]) for (let k = 0; k < nProps; k += 1) seeds.push(p + 1_000 * k);
    seeds.push(TIMING_SEED);
    expect(new Set(seeds).size).toBe(seeds.length);
    const learning = SYNTHETIC_SCENARIOS.flatMap((s) => SYNTHETIC_KEYS.map((k) => s.seed + SEED_OFFSET[k]));
    expect(seeds.filter((s) => learning.includes(s))).toEqual([]);
  });

  it('the held-out set has its own shot mix, which development never uses', () => {
    expect(SCENARIOS.filter((s) => s.phase === 'DEVELOPMENT').map((s) => s.mix)).toEqual(['step3-mix']);
    expect(SCENARIOS.filter((s) => s.phase === 'HELD_OUT').map((s) => s.mix).sort()).toEqual(['close-range', 'step3-mix']);
    expect(SHOT_MIXES.map((m) => m.id).sort()).toEqual(['close-range', 'step3-mix']);
    expect(PROBE_SETS.map((p) => p.phase).sort()).toEqual(['DEVELOPMENT', 'HELD_OUT']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · the candidate, and the evidence about it
// ─────────────────────────────────────────────────────────────────────────────

describe('the candidate is exactly what it declares', () => {
  const xg = algorithmOf('xg')!;

  it('is a valid declaration against today\'s approval, proposed by a role', () => {
    expect(CandidateDeclarationSchema.safeParse(CANDIDATE).success).toBe(true);
    expect(CANDIDATE.baseline).toEqual({ version: xg.approval!.version, fingerprint: xg.approval!.fingerprint });
    expect(xg.versions.map((v) => v.version)).not.toContain(CANDIDATE.version);
    expect(CANDIDATE.version).not.toBe(xg.version);
    expect(['PLATFORM_OWNER', 'AI_ASSISTANT']).toContain(CANDIDATE.proposedBy);
    const known = PROPERTIES.xg.map((p) => p.id as string);
    expect(CANDIDATE.hypothesis.targets.every((t) => known.includes(t))).toBe(true);
    expect(CANDIDATE_INDEX).toEqual([{ id: 'xg-v1.1', algorithm: 'xg', file: 'xg-v1.1.ts' }]);
  });

  it('changes one declaration by one line, and carries the fingerprint production would carry', () => {
    const code = codeOf(ROOT, 'xg', path.join(ROOT, 'lab/algorithms/candidates/xg-v1.1.ts'));
    expect(code.symbols.filter((s) => s.status !== 'SAME')).toEqual([{ name: 'computeXG', status: 'CHANGED' }]);
    expect(code.diff).toEqual([{
      symbol: 'computeXG',
      removed: ['+ WEIGHTS.angleSin * Math.sin(angleRad);'],
      added: ['+ WEIGHTS.angleSin * Math.sin(Math.min(angleRad, Math.PI / 2));'],
    }]);
    expect(code.approvedFingerprint).toBe(xg.approval!.fingerprint);
    expect(code.fingerprint).toBe('ab5c3f2dbdb0d60d6f9fa82b31e86f08ab59d90df2cbc5bce5a8d4086b94b42d');
    expect(code.dependants).toEqual([{ key: 'xgot', simulated: true }, { key: 'xa', simulated: true }, { key: 'match-rating', simulated: false }]);
  });

  it('agrees with the approved version wherever the angle is at most 90°, and is never lower', () => {
    for (let x = 60; x < 120; x += 0.5) {
      for (let y = 0; y <= 80; y += 2) {
        const a = computeXG({ x, y }); const c = candidateXG({ x, y });
        const r = Math.hypot(120 - x, 40 - y);
        if (r > 3.67) expect(c).toBe(a);
        expect(c).toBeGreaterThanOrEqual(a);
      }
    }
  });

  it('diffs lines by their longest common subsequence', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual({ removed: ['b'], added: ['x'] });
    expect(lineDiff([], ['n'])).toEqual({ removed: [], added: ['n'] });
    expect(dependantsOf('xa').map((d) => d.key)).toEqual(['match-rating']);
  });

  it('only algorithms with a synthetic generator, and never health data, may have candidates', () => {
    expect(CANDIDATE_ALGORITHMS.every((a) => (SYNTHETIC_KEYS as readonly string[]).includes(a))).toBe(true);
    for (const k of ['medical-risk', 'training-load', 'biomechanical-load', 'tactical-attrition']) {
      expect((CANDIDATE_ALGORITHMS as readonly string[]).includes(k)).toBe(false);
    }
  });
});

describe('the committed evidence is current, honest and synthetic', () => {
  jest.setTimeout(60_000);
  let fresh: CandidateEvidence;
  const before = recorderCounters();

  beforeAll(async () => { fresh = (await buildEvidence()).evidence; });

  it('the method passed every one of its own checks, in its own process, each against its declared expectation', () => {
    expect(fresh.methodChecks.run.state).toBe('COMPLETED');
    expect(fresh.methodChecks.checks.map((c) => [c.id, c.observed, c.passed])).toEqual(METHOD_CHECKS.map((m) => [m.id, m.expected, true]));
  });

  it('is exactly what the lab produces today, apart from what the run cost', () => {
    expect(firstDifference(deterministicView(readCommittedEvidence()), deterministicView(fresh))).toBeNull();
  });

  it('wrote no telemetry: the runs happened in other processes and the parent recorded nothing', () => {
    expect(peekPending()).toEqual([]);
    expect(recorderCounters()).toEqual(before);
    const lab = fs.readdirSync(path.join(ROOT, 'lab/algorithms'), { recursive: true }) as string[];
    for (const f of lab.filter((x) => x.endsWith('.ts'))) {
      expect(`${f}: ${/telemetry|@prisma\/client|config\/database/.test(read(path.join('lab/algorithms', f)).replace(/\/\/[^\n]*/g, ''))}`).toBe(`${f}: false`);
    }
  });

  it('reports what was found, as it was found', () => {
    const e = committed();
    expect(e).toMatchObject({ evidence: 'SYNTHETIC', production: 'NEVER_RUN', notice: CANDIDATE_NOTICE, generatedBy: 'lab/algorithms' });
    expect(e.methodChecks.checks.every((c) => c.passed)).toBe(true);
    const c = e.candidates[0];
    expect(c).toMatchObject({ id: 'xg-v1.1', status: 'EXPERIMENTAL', approval: 'NOT_APPROVED', run: { state: 'COMPLETED' } });
    const held = c.results!.heldOut;
    const outcome = Object.fromEntries(held.properties.map((p) => [p.id, p.outcome]));
    expect(outcome).toEqual({
      range: 'KEPT', 'closer-never-worse': 'FIXED', 'wider-view-never-worse': 'FIXED',
      'header-never-above-foot': 'KEPT', deterministic: 'KEPT', 'penalty-spot-plausible': 'KEPT',
    });
    expect(held.properties.every((p) => p.covered)).toBe(true);
    expect(c.verdict).toEqual({ test: 'PASSED', reasons: [], agreement: 'AGREE' });
    // Never a decrease, as declared; most change where the held-out mix reaches the goal line.
    for (const s of held.scenarios) expect(s.divergence.maxDecrease).toBe(0);
    const step3 = held.scenarios.find((s) => s.mix === 'step3-mix')!;
    const close = held.scenarios.find((s) => s.mix === 'close-range')!;
    expect(step3.divergence.share.value).toBeLessThan(0.01);
    expect(close.divergence.share.value).toBeGreaterThan(step3.divergence.share.value);
    // On the Step 3 mix the difference cannot be told apart at 20,000 shots, and the room says so.
    for (const w of step3.worlds) expect(w.distinguishable).toBe(false);
  });

  it('keeps a measured cost, labelled as measured, beside every run', () => {
    const c = committed().candidates[0];
    for (const k of ['wallMs', 'evaluationMs', 'maxRssBytes', 'predictions', 'approvedNsPerCall', 'candidateNsPerCall'] as const) {
      expect(`${k}: ${typeof c.measured[k]}`).toBe(`${k}: number`);
    }
    expect(c.measured.wallMs!).toBeLessThan(LAB_LIMITS.jobTimeoutMs);
  });

  it('cannot say a candidate is approved, ran in production, or is real', () => {
    const e = committed();
    for (const bad of [
      (x: Row) => { x.candidates[0].approval = 'APPROVED'; },
      (x: Row) => { x.candidates[0].status = 'APPROVED'; },
      (x: Row) => { x.production = 'RUN'; },
      (x: Row) => { x.evidence = 'REAL'; },
    ]) {
      const m = clone(e) as Row; bad(m);
      expect(CandidateEvidenceSchema.safeParse(m).success).toBe(false);
    }
  });

  it('a freshness check sees a changed figure, and ignores a changed measurement', () => {
    const a = deterministicView(committed()) as Row;
    const b = clone(a); b.candidates[0].results.heldOut.scenarios[0].divergence.changed += 1;
    expect(firstDifference(a, b)).toBe('$.candidates[0].results.heldOut.scenarios[0].divergence.changed');
    const m = clone(committed()) as Row; m.candidates[0].measured.wallMs += 999;
    expect(firstDifference(deterministicView(committed()), deterministicView(m))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · the server: freshness, the gate and the loop, against today's registry
// ─────────────────────────────────────────────────────────────────────────────

describe('the server judges the evidence against today\'s registry', () => {
  const ready = (mutate: (e: Row) => void) => {
    const e = clone(committed()) as Row; mutate(e);
    mockEvidence = () => ({ state: 'READY', evidence: e });
  };

  it('shows the real candidate waiting for a person, behind a gate that does not open', () => {
    const o = algorithmCandidates();
    expect(o).toMatchObject({ state: 'READY', evidence: 'SYNTHETIC', production: 'NEVER_RUN', counts: { candidates: 1, awaitingApproval: 1 } });
    expect(o.candidates[0]).toMatchObject({
      id: 'xg-v1.1', status: 'EXPERIMENTAL', approval: 'NOT_APPROVED', stage: 'HUMAN_APPROVAL', gate: 'VERSION_NOT_APPROVED',
      deployable: false, test: 'PASSED', freshness: 'CURRENT', properties: { kept: 4, fixed: 2, broken: 0, stillFailing: 0 },
    });
    const d = algorithmCandidate('xg-v1.1');
    expect(d.state).toBe('FOUND');
    if (d.state !== 'FOUND') return;
    expect(d.detail.path).toEqual(['PROPOSE', 'SIMULATE', 'TEST', 'HUMAN_APPROVAL']);
    expect(d.detail.approvalNeeds).toEqual({
      version: 'v1.1', fingerprint: 'ab5c3f2dbdb0d60d6f9fa82b31e86f08ab59d90df2cbc5bce5a8d4086b94b42d',
      approvedVersion: 'v1.0', approvedFingerprint: algorithmOf('xg')!.approval!.fingerprint,
    });
    expect(canAdvance('HUMAN_APPROVAL', 'DEPLOY', d.detail.gate)).toBe(false);
    expect(algorithmCandidate('no-such').state).toBe('UNKNOWN_CANDIDATE');
  });

  it('every path a candidate can take is legal on the loop, and none reaches Deploy', () => {
    const src = read('src/algorithms/candidates.ts');
    const block = src.slice(src.indexOf('const STAGE_PATH'), src.indexOf('};', src.indexOf('const STAGE_PATH')));
    const paths = [...block.matchAll(/\[([^\]]+)\]/g)].map((m) => [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1] as LoopStage));
    expect(paths.length).toBe(7);
    for (const p of paths) {
      expect(p.every((s) => (LOOP_STAGES as readonly string[]).includes(s))).toBe(true);
      expect(p.every((s, i) => i === 0 || canAdvance(p[i - 1], s, null))).toBe(true);
      expect(p).not.toContain('DEPLOY');
    }
  });

  it('marks evidence stale when the approval it compared against has moved', () => {
    ready((e) => { e.candidates[0].declaration.baseline.fingerprint = 'f'.repeat(64); });
    expect(algorithmCandidates().candidates[0]).toMatchObject({ freshness: 'STALE', staleReasons: ['BASELINE_NOT_CURRENT'], stage: 'PROPOSE' });
    ready((e) => { e.candidates[0].code.approvedFingerprint = 'e'.repeat(64); });
    expect(algorithmCandidates().candidates[0].staleReasons).toEqual(['APPROVED_CODE_CHANGED']);
  });

  it('never presents the approved code as a deployable candidate', () => {
    const fp = algorithmOf('xg')!.approval!.fingerprint;
    ready((e) => { e.candidates[0].declaration.version = 'v1.0'; e.candidates[0].code.fingerprint = fp; });
    const c = algorithmCandidates().candidates[0];
    expect(c.gate).toBe('APPROVED');
    expect(c).toMatchObject({ freshness: 'STALE', staleReasons: ['CANDIDATE_MATCHES_APPROVAL'], stage: 'PROPOSE', deployable: false });
  });

  it('places a candidate on the loop from its run and verdict', () => {
    ready((e) => { e.candidates[0].run.state = 'TIMED_OUT'; e.candidates[0].verdict = { test: 'UNAVAILABLE', reasons: ['RUN_TIMED_OUT'], agreement: null }; });
    expect(algorithmCandidates().candidates[0].stage).toBe('SIMULATE');
    ready((e) => { e.candidates[0].verdict = { test: 'FAILED', reasons: ['BROKEN:range'], agreement: 'AGREE' }; });
    const failed = algorithmCandidate('xg-v1.1');
    expect(failed.state === 'FOUND' && failed.detail.path).toEqual(['PROPOSE', 'SIMULATE', 'TEST', 'PROPOSE']);
    ready((e) => { e.candidates[0].verdict = { test: 'INCONCLUSIVE', reasons: ['NOT_COVERED:range'], agreement: 'AGREE' }; });
    expect(algorithmCandidates().candidates[0].stage).toBe('TEST');
    ready((e) => { e.candidates[0].run.state = 'REFUSED'; e.candidates[0].run.reasons = ['BASELINE_NOT_CURRENT']; e.candidates[0].results = null; });
    expect(algorithmCandidates().candidates[0].stage).toBe('PROPOSE');
  });

  it('reads nothing it cannot validate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-ev-'));
    try {
      expect(realRead(path.join(dir, 'missing.json'))).toEqual({ state: 'NOT_GENERATED', reason: EVIDENCE_REASONS.missing });
      fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
      expect(realRead(path.join(dir, 'bad.json'))).toEqual({ state: 'INVALID', reason: EVIDENCE_REASONS.notJson });
      fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ ...committed(), production: 'RUN' }));
      expect(realRead(path.join(dir, 'wrong.json'))).toEqual({ state: 'INVALID', reason: EVIDENCE_REASONS.schema });
      fs.writeFileSync(path.join(dir, 'huge.json'), ' '.repeat(2 * 1024 * 1024 + 1));
      expect(realRead(path.join(dir, 'huge.json'))).toEqual({ state: 'INVALID', reason: EVIDENCE_REASONS.tooLarge });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    mockEvidence = () => ({ state: 'INVALID', reason: EVIDENCE_REASONS.schema });
    expect(algorithmCandidates()).toMatchObject({ state: 'INVALID', candidates: [], spec: null, notice: CANDIDATE_NOTICE });
    expect(algorithmCandidate('xg-v1.1')).toEqual({ state: 'INVALID', reason: EVIDENCE_REASONS.schema });
  });

  it('answers in the shape its contract promises, and a contract that would allow approval fails', () => {
    expect(AlgorithmsCandidatesSchema.safeParse(algorithmCandidates()).success).toBe(true);
    const d = algorithmCandidate('xg-v1.1');
    expect(d.state === 'FOUND' && AlgCandidateDetailSchema.safeParse(d.detail).success).toBe(true);
    if (d.state !== 'FOUND') return;
    expect(AlgCandidateDetailSchema.safeParse({ ...d.detail, deployable: true }).success).toBe(false);
    expect(AlgCandidateDetailSchema.safeParse({ ...d.detail, approval: 'APPROVED' }).success).toBe(false);
  });
});

describe('candidates are the platform owner\'s, and only to read', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/system/algorithms', algorithmsRoutes);
    a.use((err: Row, _req: Row, res: Row, _next: unknown) => {
      res.status(err?.statusCode || err?.status || 500).json({ success: false, message: err?.message });
    });
    return a;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest');
  const ROUTES = ['/system/algorithms/candidates', '/system/algorithms/candidates/xg-v1.1'];

  it('serves the owner, with no-store', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      const res = await request(app()).get(r);
      expect(`${r}: ${res.status}`).toBe(`${r}: 200`);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect((await request(app()).get('/system/algorithms/candidates/not-a-candidate')).status).toBe(404);
    mockEvidence = () => ({ state: 'NOT_GENERATED', reason: EVIDENCE_REASONS.missing });
    expect((await request(app()).get('/system/algorithms/candidates/xg-v1.1')).status).toBe(503);
    expect((await request(app()).get('/system/algorithms/candidates')).body.data.state).toBe('NOT_GENERATED');
  });

  it('refuses a club administrator, and an unauthenticated caller', async () => {
    actingAs = { id: PRESIDENT, clubId: CLUB, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      const res = await request(app()).get(r);
      expect(`${r}: ${res.status}`).toBe(`${r}: 403`);
      expect(JSON.stringify(res.body)).not.toMatch(/xg-v1\.1|EXPERIMENTAL/);
    }
    actingAs = null;
    for (const r of ROUTES) expect((await request(app()).get(r)).status).toBe(401);
  });

  it('answers no write — there is no way to promote a candidate', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const r of ROUTES) {
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await request(app())[verb](r).send({ promote: true });
        expect(`${verb} ${r}: ${res.status}`).toBe(`${verb} ${r}: 404`);
      }
    }
  });

  it('declares the candidate routes before the key route', () => {
    const routes = read('src/routes/algorithms.routes.ts');
    expect(routes.indexOf("router.get('/candidates'")).toBeLessThan(routes.indexOf("router.get('/:key'"));
    expect(routes.indexOf("router.get('/candidates/:id'")).toBeLessThan(routes.indexOf("router.get('/:key/learning'"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · nothing is called better, and every view says synthetic
// ─────────────────────────────────────────────────────────────────────────────

describe('the room draws candidates honestly', () => {
  const js = read('public/algorithms/algorithms.js');
  const css = read('public/algorithms/algorithms.css');
  const table = (name: string) => {
    const i = js.indexOf(`var ${name} = {`);
    return [...js.slice(i, js.indexOf('};', i)).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  };
  const CLAIM = /\b(better|best|superior|improv\w*|accura\w*|calibrat\w*|winner|wins?|optimal)\b/i;
  const NEGATED = /\bnot\b|\bnever\b|\bnothing\b|rather than|by construction/i;

  it('no label, title or check name claims a version is better or more accurate', () => {
    const labels = [
      ...['CAND_TEST_LABEL', 'OUTCOME_LABEL', 'RUN_LABEL', 'ESTIMATE_LABEL', 'WORLD_STATUS_LABEL', 'PHASE_LABEL',
        'LAB_CHECK_LABEL', 'CAND_TAB_LABEL'].flatMap(table),
      ...Object.values(PROPERTIES).flat().map((p) => p.title),
      ...METHOD_CHECKS.map((m) => m.title), ...WORLDS.map((w) => w.title), ...SHOT_MIXES.map((m) => m.title),
    ];
    expect(labels.filter((l) => CLAIM.test(l))).toEqual([]);
  });

  it('any sentence of Step 4 that mentions accuracy or a winner says it is not one', () => {
    // Step 4's own code only: from its vocabulary to the end of its views.
    const step4 = js.slice(js.indexOf('// ── the proposals vocabulary (Step 4)'), js.indexOf('/** A statistic, localised'))
      + js.slice(js.indexOf('// ── PROPOSALS (Step 4)'), js.indexOf('// ── content ──'));
    const sentences = [
      LAB_NOTICE, CONDITIONAL_NOTE, ...Object.values(LAB_JUSTIFICATIONS), ...WORLDS.map((w) => w.meaning),
      ...table('CAND_TEST_MEANING'), ...table('CAND_REASON_LABEL'), CANDIDATE.rationale, CANDIDATE.hypothesis.region,
      ...[...step4.matchAll(/\bT\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]),
    ];
    expect(sentences.length).toBeGreaterThan(60);
    expect(sentences.filter((s) => CLAIM.test(s) && !NEGATED.test(s))).toEqual([]);
  });

  it('every view carries the synthetic banner, the browser\'s copy of the notice is the server\'s, and a verdict is coloured only as a result', () => {
    const list = js.slice(js.indexOf('function proposalsHtml()'), js.indexOf('function candRulesPanel('));
    expect(list).toMatch(/syntheticBanner\(C\.notice\)/);
    expect(list).toMatch(/syntheticBanner\(CAND_NOTICE\)/);
    const one = js.slice(js.indexOf('function candidateHtml()'), js.indexOf('function candTabHtml('));
    expect(one).toMatch(/syntheticBanner\(d\.notice\)/);
    expect((js.match(/var CAND_NOTICE = '((?:[^'\\]|\\.)*)';/) || [])[1]).toBe(CANDIDATE_NOTICE);
    const sandbox: Row = { window: {} };
    vm.runInNewContext(js, sandbox);
    const test = sandbox.window.__familistaAlgorithmsCandTestKind as (s: string) => string;
    expect(['PASSED', 'FAILED', 'INCONCLUSIVE', 'UNAVAILABLE'].map(test)).toEqual(['ok', 'crit', 'warn', 'none']);
    const outcome = sandbox.window.__familistaAlgorithmsOutcomeKind as (s: string) => string;
    expect(['KEPT', 'FIXED', 'BROKEN', 'STILL_FAILING'].map(outcome)).toEqual(['none', 'ok', 'crit', 'warn']);
    const run = sandbox.window.__familistaAlgorithmsRunKind as (s: string) => string;
    expect(['COMPLETED', 'TIMED_OUT', 'REFUSED'].map(run)).toEqual(['none', 'crit', 'warn']);
    // A score bracket or a sample-size estimate is never green or red.
    const req = js.slice(js.indexOf('function requiredHtml('), js.indexOf('function candScenarioPanel('));
    expect(req).not.toMatch(/'ok'|'crit'/);
  });

  it('refuses a response that does not say what a candidate is', () => {
    expect(js).toContain("api('/system/algorithms/candidates')");
    expect(js).toMatch(/d\.evidence !== 'SYNTHETIC' \|\| d\.production !== 'NEVER_RUN'/);
    expect(js).toMatch(/d\.deployable !== false/);
  });

  it('switches a candidate tab without repainting anything', () => {
    const fn = js.slice(js.indexOf('function selectCandTab('), js.indexOf('function closeLangs('));
    expect(fn).not.toMatch(/repaintBody|paint\(|innerHTML/);
    expect(js).toContain("<div class=\"al-scn-bodies\">' + CAND_TABS.map(");
  });

  it('keeps the design system: no inline style, logical properties, and an escape hatch for every new grid', () => {
    expect(js).not.toMatch(/style="/);
    expect(js).not.toMatch(/\.style\./);
    const hatch = css.slice(css.indexOf('@media (max-width: 980px), (max-height: 620px)'));
    for (const sel of ['.al-scn-tabs--cand', '.al-tbl--cand .al-tr', '.al-tbl--props .al-tr', '.al-tbl--worlds .al-tr', '.al-tbl--sets .al-tr', '.al-cell-l', '.al-bins--bands .al-bin']) {
      expect(`${sel}: ${hatch.includes(sel)}`).toBe(`${sel}: true`);
    }
    expect(css).not.toMatch(/margin-left|margin-right|padding-left|padding-right|text-align:\s*(left|right)/);
  });

  it('a state chip in the new tables stays inside its cell in every language', () => {
    // German and Arabic held-out verdicts are wider than half a phone-width card.
    expect(css).toMatch(/\.al-tbl--cand \.al-chip,[^{]*\{ max-width: 100%; white-space: normal; \}/);
    const hatch = css.slice(css.indexOf('@media (max-width: 980px), (max-height: 620px)'));
    expect(hatch).toContain('.al-tbl--cand .al-tr > :nth-child(2), .al-tbl--cand .al-tr > :nth-child(3) { grid-column: 1 / -1; }');
  });

  it('every registered algorithm is still exactly where it was on the loop', () => {
    // Candidates live beside the registry, never in it.
    expect(ALGORITHMS.length).toBe(13);
    expect(ALGORITHMS.every((a) => a.approval && a.approval.version === a.version)).toBe(true);
  });
});
