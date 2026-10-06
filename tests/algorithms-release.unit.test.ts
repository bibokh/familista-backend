/**
 * Algorithms, Step 5a — the release machinery: a human approval bound to the
 * exact evidence it was judged on, a pinned evaluation engine, and a rollback
 * that has been rehearsed. Nothing here approves or promotes a candidate.
 *
 * THE TESTS THIS FILE EXISTS FOR
 *
 *   1. A dossier's digest is canonical: key order never moves it; any value does.
 *   2. A CHANGE approval is valid only when every link closes, and each broken
 *      link is named — one reason per link.
 *   3. The engine pin moves with the engine and with nothing else: not with a
 *      comment, not with the registry, the candidates or the code under test.
 *   4. A promotion is exact text: only the changed declarations move, the
 *      result carries the candidate's fingerprint, and a neighbour in the same
 *      file is never touched.
 *   5. Dependants are classified from the code: CODE must be simulated, DATA
 *      says it was not, and a promotion a simulation does not cover is refused.
 *   6. The real repository approves no change: thirteen baselines, xg-v1.1
 *      still NOT_APPROVED, nothing to roll back — and a plan for xg-v1.1 is
 *      READY and writes nothing.
 *   7. The rehearsal: plan, apply, verify, roll back, byte-for-byte, verify —
 *      in a copy, with the repository untouched.
 *   8. The releases read is the platform owner's, a GET only, and never claims
 *      to know whether a deploy was requested or is live.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER = 'user-owner';
const PRESIDENT = 'user-president';
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

import { ALGORITHMS, algorithmOf, change, type AlgorithmDecl, type ChangeApproval } from '../src/algorithms/registry';
import {
  ApprovalDossierSchema, DOSSIER_REASONS, digestOf, readDossier, type ApprovalDossier, type DossierRead,
} from '../src/algorithms/approval-dossier';
import { BINDING_REASONS, algorithmReleases, checkBinding } from '../src/algorithms/release';
import { algorithmCandidates } from '../src/algorithms/candidates';
import { AlgorithmsReleasesSchema } from '../src/contracts/owner-api.contracts';
import algorithmsRoutes from '../src/routes/algorithms.routes';

import { LAB_ROOT } from '../lab/algorithms/runner';
import { LAB_SPEC_VERSION } from '../lab/algorithms/spec';
import { deterministicView, firstDifference, readCommittedEvidence } from '../lab/algorithms/evidence';
import { planRelease, type ReleasePlan } from '../lab/algorithms/release/dossier';
import { classifyDependants } from '../lab/algorithms/release/dependants';
import { engineCommit, engineFiles, engineFingerprint, enginePin, runtimeSpecifiers } from '../lab/algorithms/release/engine';
import {
  ReleaseRefusal, blankComments, changedSymbols, declarationSpan, fingerprintOf, rewrite, runtimeImports,
} from '../lab/algorithms/release/source';
import { ARCHIVE_DIR, ENGINE_ENTRIES, PROMOTION_NOTE } from '../lab/algorithms/release/spec';
import { applyRelease, promotedEntry, registryEntry, rollbackRelease } from '../lab/algorithms/release/workspace';
import { verifyReleases } from '../lab/algorithms/release/verify';
import { REHEARSAL_REFERENCE, rehearse } from '../lab/algorithms/release/rehearsal';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: { canonical(v: unknown): string; digestOf(v: unknown): string } = require('../src/algorithms/dossier-core.js');

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const XG_FILE = 'src/match-events/xg-model.service.ts';
const CANDIDATE_FILE = 'lab/algorithms/candidates/xg-v1.1.ts';

/** Every file a promotion of xg-v1.1 could touch, hashed: a "writes nothing" claim is checked on exactly these. */
function releaseSurface(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (rel: string) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { out.set(rel, 'ABSENT'); return; }
    if (fs.statSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs).sort()) add(`${rel}/${n}`); return; }
    out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
  };
  ['src/algorithms/approvals', ARCHIVE_DIR, 'lab/algorithms/candidates', 'src/algorithms/registry.ts', XG_FILE,
    'src/algorithms/generated', 'src/cyber-defense/generated/security-manifest.json'].forEach(add);
  return out;
}

// One real plan for xg-v1.1, made once: the binding tests mutate copies of its dossier.
let plan: ReleasePlan;
let before: Map<string, string>;
beforeAll(async () => {
  before = releaseSurface();
  plan = await planRelease('xg-v1.1');
}, 180_000);

// ─────────────────────────────────────────────────────────────────────────────
// 1 · the digest
// ─────────────────────────────────────────────────────────────────────────────

describe('a dossier digest is canonical', () => {
  it('sorts keys at every depth and skips undefined', () => {
    expect(core.canonical({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, z: undefined }))
      .toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });

  it('refuses a value JSON cannot carry exactly', () => {
    expect(() => core.canonical({ a: NaN })).toThrow();
    expect(() => core.canonical({ a: Infinity })).toThrow();
  });

  it('does not move with key order, and moves with any value', () => {
    const d = plan.dossier as ApprovalDossier;
    /** The same value with every object's keys in reverse order. */
    const reversed = (v: unknown): unknown => (Array.isArray(v) ? v.map(reversed)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Row).reverse().map(([k, x]) => [k, reversed(x)])) : v);
    expect(digestOf(d)).toBe(plan.digest);
    expect(JSON.stringify(reversed(d))).not.toBe(JSON.stringify(d));
    expect(core.digestOf(reversed(d))).toBe(plan.digest);
    expect(core.digestOf(JSON.parse(JSON.stringify(d)))).toBe(plan.digest);
    const flipped = structuredClone(d);
    flipped.reproducible.results.heldOut.scenarios[0].divergence.changed += 1;
    expect(digestOf(flipped)).not.toBe(plan.digest);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · the binding
// ─────────────────────────────────────────────────────────────────────────────

describe('a change approval is bound to its evidence, link by link', () => {
  const xg = () => algorithmOf('xg') as AlgorithmDecl;
  const dossier = () => structuredClone(plan.dossier as ApprovalDossier);
  /** The dossier with its own evidence digest made consistent again after an edit. */
  const resealed = (d: ApprovalDossier) => ({ ...d, evidenceDigest: digestOf(d.reproducible) });
  const reader = (d: ApprovalDossier): ((f: string) => DossierRead) => () => ({ state: 'READY', dossier: d, digest: digestOf(d) });
  /** xG as a promotion would leave it, approving `d` — every field overridable. */
  function decl(d: ApprovalDossier, approval: Partial<ChangeApproval> = {}, over: Partial<AlgorithmDecl> = {}): AlgorithmDecl {
    return {
      ...xg(),
      version: 'v1.1',
      versions: [...xg().versions, { version: 'v1.1', date: '2026-10-06', note: PROMOTION_NOTE }],
      approval: change({
        version: 'v1.1', fingerprint: d.candidate.fingerprint, candidate: 'xg-v1.1',
        baseline: { ...d.baseline }, dossier: { file: 'src/algorithms/approvals/xg-v1.1.json', digest: digestOf(d) },
        reference: REHEARSAL_REFERENCE, approvedAt: '2026-10-06', ...approval,
      }),
      ...over,
    };
  }
  const reasons = (d: ApprovalDossier, approval: Partial<ChangeApproval> = {}, over: Partial<AlgorithmDecl> = {}) =>
    checkBinding(decl(d, approval, over), reader(d)).reasons;

  it('is VALID when every link closes, and says what it is bound to', () => {
    const d = dossier();
    const b = checkBinding(decl(d), reader(d));
    expect(b.state).toBe('VALID');
    expect(b.reasons).toEqual([]);
    expect(b.dossier).toMatchObject({
      candidate: 'xg-v1.1', digest: plan.digest, baseline: d.baseline,
      engine: { specVersion: LAB_SPEC_VERSION, fingerprint: d.engine.fingerprint },
      test: { verdict: 'PASSED', methodChecks: { passed: d.reproducible.methodChecks.length, total: d.reproducible.methodChecks.length } },
    });
    expect(b.dossier?.dependants.find((x) => x.key === 'xgot')).toEqual({ key: 'xgot', path: 'CODE', simulated: true, broken: 0 });
  });

  it('is not applicable to a baseline approval, and reads no dossier for it', () => {
    const r = jest.fn();
    expect(checkBinding(xg(), r)).toEqual({ state: 'NOT_APPLICABLE', reasons: [], dossier: null });
    expect(r).not.toHaveBeenCalled();
  });

  it('names each broken link', () => {
    const d = dossier();
    expect(reasons(d, { reference: 'bibokh/familista-backend — Algorithms Step 5' })).toEqual(['REFERENCE_NOT_A_PULL_REQUEST']);
    expect(reasons(d, {}, { version: 'v1.2' })).toEqual(['VERSION_MISMATCH']);
    expect(reasons(d, {}, { versions: [{ version: 'v1.1', date: '2026-10-06', note: PROMOTION_NOTE }] })).toEqual(['BASELINE_NOT_IN_HISTORY']);
    expect(reasons(d, { dossier: { file: 'src/algorithms/approvals/xg-v1.1.json', digest: 'f'.repeat(64) } })).toEqual(['DIGEST_MISMATCH']);
    expect(reasons(d, { candidate: 'xg-v1.2' })).toEqual(['CANDIDATE_MISMATCH']);
    expect(reasons(d, { fingerprint: 'a'.repeat(64) })).toEqual(['FINGERPRINT_MISMATCH']);
    expect(reasons(d, { baseline: { version: 'v1.0', fingerprint: 'b'.repeat(64) } })).toEqual(['BASELINE_MISMATCH']);
    expect(reasons(d, { version: 'v1.0' }, { version: 'v1.0' })).toContain('VERSION_REUSED');
  });

  it('names evidence that was edited after it was recorded', () => {
    const edited = dossier();
    edited.reproducible.results.heldOut.scenarios[0].divergence.changed += 1;
    expect(reasons(edited)).toEqual(['EVIDENCE_DIGEST_MISMATCH']);
    const other = resealed({ ...dossier(), algorithm: 'xgot' });
    expect(reasons(other)).toEqual(['ALGORITHM_MISMATCH']);
  });

  it('refuses evidence that did not pass, or a dependant that was not run or broke', () => {
    const failed = dossier();
    failed.reproducible.verdict.test = 'FAILED';
    expect(reasons(resealed(failed))).toEqual(['VERDICT_MISMATCH']);

    const method = dossier();
    method.reproducible.methodChecks[0].passed = false;
    expect(reasons(resealed(method))).toEqual(['METHOD_CHECKS_NOT_PASSED']);

    const unrun = dossier();
    const xgot = unrun.reproducible.dependants.find((x) => x.key === 'xgot')!;
    xgot.simulated = false; xgot.properties = null; xgot.scenarios = null;
    expect(reasons(resealed(unrun))).toEqual(['CODE_DEPENDANT_NOT_SIMULATED']);

    const broke = dossier();
    broke.reproducible.dependants.find((x) => x.key === 'xgot')!.properties![0].outcome = 'BROKEN';
    expect(reasons(resealed(broke))).toEqual(['CODE_DEPENDANT_BROKEN']);
  });

  it('is INVALID, with no summary, when the dossier cannot be read', () => {
    const d = dossier();
    const b = checkBinding(decl(d), () => ({ state: 'MISSING', reason: DOSSIER_REASONS.missing }));
    expect(b).toEqual({ state: 'INVALID', reasons: ['DOSSIER_UNREADABLE'], dossier: null });
  });

  it('reports reasons in one fixed order', () => {
    const d = dossier();
    const many = checkBinding(decl(d, { reference: 'x', fingerprint: 'a'.repeat(64), candidate: 'xg-v9' }), reader(d)).reasons;
    expect(many).toEqual(BINDING_REASONS.filter((r) => many.includes(r)));
  });
});

describe('a dossier is read only from its own directory, through its schema', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-dossiers-'));
    fs.writeFileSync(path.join(dir, 'xg-v1.1.json'), `${JSON.stringify(plan.dossier, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ ...plan.dossier, evidence: 'REAL' }));
    fs.writeFileSync(path.join(dir, 'huge.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (name: string) => readDossier(`src/algorithms/approvals/${name}`, dir);

  it('reads a written dossier back to the digest the plan made', () => {
    const r = at('xg-v1.1.json');
    expect(r.state).toBe('READY');
    expect(r.state === 'READY' && r.digest).toBe(plan.digest);
  });

  it('refuses anything that is not a plain name in src/algorithms/approvals/', () => {
    for (const p of ['src/algorithms/approvals/../registry.json', 'src/algorithms/approvals/sub/x.json', 'src/algorithms/x.json',
      '/etc/passwd', 'src/algorithms/approvals/X.JSON', 'src/algorithms/approvals/.json']) {
      expect(`${p}: ${JSON.stringify(readDossier(p, dir))}`).toBe(`${p}: ${JSON.stringify({ state: 'INVALID', reason: DOSSIER_REASONS.name })}`);
    }
  });

  it('says what is wrong with a missing, malformed, mis-shaped or oversized file', () => {
    expect(at('none.json')).toEqual({ state: 'MISSING', reason: DOSSIER_REASONS.missing });
    expect(at('bad.json')).toEqual({ state: 'INVALID', reason: DOSSIER_REASONS.notJson });
    expect(at('wrong.json')).toEqual({ state: 'INVALID', reason: DOSSIER_REASONS.schema });
    expect(at('huge.json')).toEqual({ state: 'INVALID', reason: DOSSIER_REASONS.tooLarge });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · the engine pin
// ─────────────────────────────────────────────────────────────────────────────

describe('the evaluation engine is pinned, and only the engine moves the pin', () => {
  it('follows runtime imports only', () => {
    const src = [
      "import type { A } from './a';",
      "import { b } from './b';",
      "export * from './c';",
      "export type { D } from './d';",
      "const e = require('./e.js');",
      "import './f';",
      "import z from 'zod';",
      "// import g from './g';",
    ].join('\n');
    expect(runtimeSpecifiers(src).sort()).toEqual(['./b', './c', './e.js', './f']);
  });

  it('holds the jobs, the assembly, the verdict and the release tool — and not what they run on', () => {
    const files = engineFiles(LAB_ROOT);
    for (const f of [...ENGINE_ENTRIES, 'lab/algorithms/spec.ts', 'lab/algorithms/release/spec.ts', 'lab/algorithms/engine/properties.ts',
      'src/algorithms/fingerprint-core.js', 'src/algorithms/dossier-core.js', 'src/algorithms/learning-synthetic.ts']) {
      expect(`${f}: ${files.includes(f)}`).toBe(`${f}: true`);
    }
    const underTest = new Set(ALGORITHMS.map((a) => a.source.file));
    expect(files.filter((f) => underTest.has(f) || /^lab\/algorithms\/(candidates|archive)\//.test(f)
      || /^src\/algorithms\/(registry|loop)\.ts$/.test(f) || /^lab\/algorithms\/(runner|child|cli|release-cli)\.ts$/.test(f))).toEqual([]);
  });

  it('is blind to comments and whitespace, and moves with any code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-engine-'));
    try {
      const fp = (text: string) => { fs.writeFileSync(path.join(tmp, 'a.ts'), text); return engineFingerprint(tmp, ['a.ts']); };
      const base = fp('export const A = 1; // one\n');
      expect(fp('/* reworded */\nexport  const A =   1;\n')).toBe(base);
      expect(fp('export const A = 2;\n')).not.toBe(base);
      expect(engineCommit(tmp, ['a.ts'])).toBeNull();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('is stable, and is what the plan recorded', () => {
    const a = enginePin(LAB_ROOT);
    expect(enginePin(LAB_ROOT).fingerprint).toBe(a.fingerprint);
    expect(a.specVersion).toBe(LAB_SPEC_VERSION);
    expect(plan.dossier?.engine).toMatchObject({ specVersion: a.specVersion, fingerprint: a.fingerprint, files: a.files });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · a promotion is exact text
// ─────────────────────────────────────────────────────────────────────────────

describe('a promotion changes the changed declarations and nothing else', () => {
  const approved = () => read(XG_FILE);
  const candidate = () => read(CANDIDATE_FILE);
  const xg = () => algorithmOf('xg') as AlgorithmDecl;
  const neighbours = () => ALGORITHMS.filter((a) => a.key !== 'xg' && a.source.file === XG_FILE).map((a) => ({ key: a.key, symbols: a.source.symbols }));

  it('blanks comments without moving a single offset', () => {
    const src = "const a = 1; // note\n/* two\nlines */ const b = '// not a comment';\n";
    const blank = blankComments(src);
    expect(blank).toHaveLength(src.length);
    expect(blank.split('\n')).toHaveLength(src.split('\n').length);
    expect(blank).not.toMatch(/note|two|lines/);
    expect(blank).toContain("'// not a comment'");
  });

  it('finds a declaration exactly once, or not at all', () => {
    const s = declarationSpan(approved(), 'computeXG')!;
    expect(approved().slice(s.start, s.end)).toMatch(/^export function computeXG\(/);
    expect(approved().slice(s.start, s.end).trimEnd().endsWith('}')).toBe(true);
    expect(declarationSpan(approved(), 'noSuchDeclaration')).toBeNull();
  });

  it('reaches the candidate’s fingerprint, keeps every neighbour’s, and leaves the rest of the file byte for byte', () => {
    const changed = changedSymbols(approved(), candidate(), xg().source.symbols);
    expect(changed).toEqual(['computeXG']);
    const want = fingerprintOf(candidate(), xg().source.symbols) as string;
    const out = rewrite(approved(), candidate(), xg().source.symbols, changed, want, neighbours());
    expect(fingerprintOf(out, xg().source.symbols)).toBe(want);
    expect(want).toBe(plan.dossier?.promotion.promotedFingerprint);
    for (const n of neighbours()) expect(fingerprintOf(out, n.symbols)).toBe(fingerprintOf(approved(), n.symbols));
    const a = declarationSpan(approved(), 'computeXG')!;
    const b = declarationSpan(out, 'computeXG')!;
    expect(out.slice(0, b.start)).toBe(approved().slice(0, a.start));
    expect(out.slice(b.end)).toBe(approved().slice(a.end));
    // And back: the approved file returns exactly.
    expect(rewrite(out, approved(), xg().source.symbols, changed, xg().approval!.fingerprint, neighbours())).toBe(approved());
  });

  it('refuses a promotion that would move a neighbour, or miss its fingerprint', () => {
    const want = fingerprintOf(candidate(), xg().source.symbols) as string;
    const refusal = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof ReleaseRefusal ? e.code : String(e); } };
    expect(refusal(() => rewrite(approved(), candidate(), xg().source.symbols, ['computeXG'], want, [{ key: 'shared', symbols: ['computeXG'] }])))
      .toBe('NEIGHBOUR_CHANGED:shared');
    expect(refusal(() => rewrite(approved(), candidate(), xg().source.symbols, ['computeXG'], 'f'.repeat(64), []))).toBe('FINGERPRINT_NOT_REACHED');
    expect(refusal(() => rewrite(approved(), candidate(), xg().source.symbols, [], want, []))).toBe('NO_CODE_CHANGE');
  });

  it('runs a promoted module only when it stands alone', () => {
    expect(runtimeImports(approved())).toEqual([]);
    expect(runtimeImports(candidate())).toEqual([]);
    expect(runtimeImports("import { prisma } from '../config/database';\nimport type { X } from './x';\n")).toEqual(['../config/database']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · dependants
// ─────────────────────────────────────────────────────────────────────────────

describe('what a promotion does to the algorithms that depend on it is read from the code', () => {
  it('xGOT calls the changed code and is simulated; xA and the match rating read stored values', () => {
    const deps = classifyDependants(LAB_ROOT, 'xg', ['computeXG']);
    expect(deps.map((d) => [d.key, d.path, d.calls, d.simulated, d.declared])).toEqual([
      ['xgot', 'CODE', ['computeXG'], true, true],
      ['xa', 'DATA', [], false, true],
      ['match-rating', 'DATA', [], false, true],
    ]);
  });

  it('refuses to call a dependant simulated when the change reaches code its simulation does not exercise', () => {
    // sigmoid also feeds xGOT's target-point path, which calling it with the shot alone never reaches.
    const xgot = classifyDependants(LAB_ROOT, 'xg', ['sigmoid']).find((d) => d.key === 'xgot')!;
    expect(xgot.path).toBe('CODE');
    expect(xgot.calls).toEqual(['computeXG', 'sigmoid']);
    expect(xgot.simulated).toBe(false);
  });

  describe('a dependant in another file that starts calling the changed code', () => {
    // A copy of every registered source file, with the match rating changed to call xG itself.
    let tmp: string;
    const RATING = 'src/player-stats/player-stats.service.ts';
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-deps-'));
      for (const f of new Set(ALGORITHMS.map((a) => a.source.file))) {
        fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
      }
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const callFrom = (importLine: string, use: string) => {
      const src = read(RATING).replace("import { NotFoundError } from '../utils/errors';", `import { NotFoundError } from '../utils/errors';\n${importLine}`)
        .replace(/(function computeRating\([^)]*\): number \{)/, `$1\n  void ${use};`);
      fs.writeFileSync(path.join(tmp, RATING), src);
      return classifyDependants(tmp, 'xg', ['computeXG']).find((d) => d.key === 'match-rating')!;
    };

    it('is CODE, by name or alias or namespace — and, with no simulation declared, not simulated', () => {
      // computeMatchStats reaches the changed code too, through the helper that calls computeRating:
      // the closure follows the dependant's own file, not only the declaration that names it.
      expect(callFrom("import { computeXG } from '../match-events/xg-model.service';", 'computeXG'))
        .toMatchObject({ path: 'CODE', calls: ['buildPlayerMatchStats', 'computeXG'], simulated: false, declared: true });
      expect(callFrom("import { computeXG as modelXG } from '../match-events/xg-model.service';", 'modelXG'))
        .toMatchObject({ path: 'CODE', calls: ['buildPlayerMatchStats', 'modelXG'], simulated: false });
      expect(callFrom("import * as model from '../match-events/xg-model.service';", 'model'))
        .toMatchObject({ path: 'CODE', calls: ['buildPlayerMatchStats', 'model'], simulated: false });
    });

    it('stays DATA for a type-only import, which runs nothing', () => {
      expect(callFrom("import type { ShotFeatures } from '../match-events/xg-model.service';", '0'))
        .toMatchObject({ path: 'DATA', calls: [], simulated: false });
    });
  });

  it('records, in the dossier, the held-out runs of xGOT and that nothing was run for the others', () => {
    const deps = plan.dossier!.reproducible.dependants;
    const xgot = deps.find((d) => d.key === 'xgot')!;
    expect(xgot).toMatchObject({ path: 'CODE', simulated: true, calls: ['computeXG'] });
    expect(xgot.properties!.map((p) => p.id)).toEqual(['range', 'closer-never-worse', 'wider-view-never-worse', 'header-never-above-foot', 'deterministic']);
    expect(xgot.properties!.some((p) => p.outcome === 'BROKEN')).toBe(false);
    expect(xgot.scenarios!.map((s) => s.id)).toEqual(['held-step3', 'held-close']);
    expect(xgot.scenarios!.every((s) => s.invalid.candidate === 0 && s.maxDecrease === 0)).toBe(true);
    for (const k of ['xa', 'match-rating']) expect(deps.find((d) => d.key === k)).toEqual({ key: k, path: 'DATA', simulated: false, calls: [], properties: null, scenarios: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · the real repository
// ─────────────────────────────────────────────────────────────────────────────

describe('the real repository approves no change', () => {
  it('has thirteen baseline approvals and no change approval', () => {
    expect(ALGORITHMS).toHaveLength(13);
    expect(ALGORITHMS.map((a) => a.approval?.kind)).toEqual(ALGORITHMS.map(() => 'BASELINE'));
    expect(algorithmOf('xg')).toMatchObject({ version: 'v1.0', approval: { version: 'v1.0', fingerprint: 'c9d12afe302d5d60f4966855a2287e4175b57397d64eed2c9fb4ad25a81dfbe5' } });
    const r = algorithmReleases(null);
    expect(r.totals).toMatchObject({ registered: 13, baseline: 13, change: 0, bindingValid: 0, bindingInvalid: 0 });
    expect(r.algorithms.every((a) => a.binding.state === 'NOT_APPLICABLE')).toBe(true);
  });

  it('holds no dossier and no archive, so there is nothing to roll back', () => {
    expect(fs.readdirSync(path.join(ROOT, 'src/algorithms/approvals'))).toEqual(['README.md']);
    expect(fs.existsSync(path.join(ROOT, ARCHIVE_DIR))).toBe(false);
    expect(() => rollbackRelease('xg-v1.1', { regenerate: false })).toThrow('ARCHIVE_MISSING');
  });

  it('still shows xg-v1.1 as an experimental candidate, not approved and not deployable', () => {
    const c = algorithmCandidates().candidates.find((x) => x.id === 'xg-v1.1')!;
    expect(c).toMatchObject({ status: 'EXPERIMENTAL', approval: 'NOT_APPROVED', deployable: false, gate: 'VERSION_NOT_APPROVED' });
  });

  it('passes verification: every gate approved, no binding to check, no orphan', async () => {
    const v = await verifyReleases({ reproduce: true });
    expect(v.ok).toBe(true);
    expect(v.algorithms.map((a) => a.gate)).toEqual(ALGORITHMS.map(() => 'APPROVED'));
    expect(v.orphans).toEqual([]);
  });

  it('says what it cannot know, and takes a build commit only as forty hex digits', () => {
    expect(algorithmReleases(null).deploy).toEqual({ requested: 'NOT_KNOWN_HERE', live: 'NOT_KNOWN_HERE' });
    expect(algorithmReleases('a'.repeat(40)).build.commit).toBe('a'.repeat(40));
    for (const bad of ['abc', 'A'.repeat(40), 'a'.repeat(41), 'main', ' '.repeat(40)]) expect(algorithmReleases(bad).build.commit).toBeNull();
  });
});

describe('a plan for xg-v1.1 is READY and writes nothing', () => {
  it('is READY with no refusal, from two child processes that completed', () => {
    expect(plan.state).toBe('READY');
    expect(plan.refusals).toEqual([]);
    expect(plan.runs.map((r) => [r.job, r.state, r.outputHeld])).toEqual([['method-checks', 'COMPLETED', false], ['release:xg-v1.1', 'COMPLETED', false]]);
  });

  it('wrote nothing a promotion could touch', () => {
    expect(releaseSurface()).toEqual(before);
  });

  it('binds the candidate, the version it replaces, the engine and what the evidence cannot show', () => {
    const d = ApprovalDossierSchema.parse(plan.dossier);
    const xg = algorithmOf('xg')!;
    expect(digestOf(d)).toBe(plan.digest);
    expect(d).toMatchObject({
      evidence: 'SYNTHETIC', algorithm: 'xg',
      candidate: { id: 'xg-v1.1', version: 'v1.1' },
      baseline: { version: xg.approval!.version, fingerprint: xg.approval!.fingerprint },
      test: { verdict: 'PASSED', agreement: 'AGREE' },
      promotion: { file: XG_FILE },
    });
    expect(d.promotion.symbols.filter((s) => s.status === 'CHANGED').map((s) => s.name)).toEqual(['computeXG']);
    expect(d.limits).toEqual(['SYNTHETIC_ONLY', 'NO_REAL_WORLD_ACCURACY', 'HELD_OUT_SEEDS_VISIBLE', 'DATA_DEPENDANTS_NOT_SIMULATED', 'NOT_OBSERVED_IN_PRODUCTION']);
    expect(digestOf(d.reproducible)).toBe(d.evidenceDigest);
  });

  it('is the evidence the owner saw in Proposals', () => {
    const committed = readCommittedEvidence() as { candidates: Array<{ id: string; results: unknown; code: { fingerprint: string } }> };
    const seen = committed.candidates.find((c) => c.id === 'xg-v1.1')!;
    expect(firstDifference(deterministicView(seen.results), deterministicView(plan.dossier!.reproducible.results))).toBeNull();
    expect(plan.dossier!.candidate.fingerprint).toBe(seen.code.fingerprint);
  });

  it('refuses what is not on the allow-list without running anything', async () => {
    const p = await planRelease('no-such-candidate');
    expect(p).toMatchObject({ state: 'REFUSED', refusals: ['NOT_IN_ALLOW_LIST'], dossier: null, runs: [] });
  });

  it('is never applied without a pull request, a valid date and a READY plan — and refusing writes nothing', () => {
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof ReleaseRefusal ? e.code : String(e); } };
    expect(code(() => applyRelease(plan, { reference: 'approved by the owner', approvedAt: '2026-10-06', regenerate: false }))).toBe('REFERENCE_NOT_A_PULL_REQUEST');
    expect(code(() => applyRelease(plan, { reference: REHEARSAL_REFERENCE, approvedAt: '06/10/2026', regenerate: false }))).toBe('DATE_INVALID');
    expect(code(() => applyRelease({ ...plan, state: 'REFUSED' }, { reference: REHEARSAL_REFERENCE, approvedAt: '2026-10-06', regenerate: false }))).toBe('PLAN_NOT_READY');
    expect(releaseSurface()).toEqual(before);
  });
});

describe('the registry entry a promotion writes', () => {
  const entry = () => registryEntry(read('src/algorithms/registry.ts'), 'xg').text;
  const fields = {
    version: 'v1.1', fingerprint: 'a'.repeat(64), candidate: 'xg-v1.1',
    baseline: { version: 'v1.0', fingerprint: 'c9d12afe302d5d60f4966855a2287e4175b57397d64eed2c9fb4ad25a81dfbe5' },
    dossier: { file: 'src/algorithms/approvals/xg-v1.1.json', digest: 'b'.repeat(64) },
    reference: REHEARSAL_REFERENCE, approvedAt: '2026-10-06',
  };

  it('records the new version, a change approval with its version and fingerprint first, and one line of history', () => {
    const out = promotedEntry(entry(), fields);
    expect(out).toContain("\n    version: 'v1.1',\n");
    expect(out).toContain([
      '\n    approval: change({',
      `      version: 'v1.1', fingerprint: '${'a'.repeat(64)}',`,
      `      candidate: 'xg-v1.1', baseline: { version: 'v1.0', fingerprint: '${fields.baseline.fingerprint}' },`,
      `      dossier: { file: 'src/algorithms/approvals/xg-v1.1.json', digest: '${'b'.repeat(64)}' },`,
      `      reference: '${REHEARSAL_REFERENCE}', approvedAt: '2026-10-06',`,
      '    }),\n',
    ].join('\n'));
    expect(out).toContain(`    versions: [\n      ...firstVersion('v1.0'),\n      { version: 'v1.1', date: '2026-10-06', note: '${PROMOTION_NOTE}' },\n    ],\n`);
    // Everything else in the entry is as it was.
    expect(out.replace(/\n {4}version: '[^']+',\n[\s\S]*$/, '')).toBe(entry().replace(/\n {4}version: '[^']+',\n[\s\S]*$/, ''));
  });

  it('appends history on the next promotion, and refuses a baseline that is not the registered version', () => {
    const once = promotedEntry(entry(), fields);
    const twice = promotedEntry(once, { ...fields, version: 'v1.2', candidate: 'xg-v1.2', baseline: { version: 'v1.1', fingerprint: 'a'.repeat(64) } });
    expect((twice.match(/\{ version: 'v1\.\d', date:/g) || [])).toHaveLength(2);
    expect(() => promotedEntry(entry(), { ...fields, baseline: { version: 'v0.9', fingerprint: fields.baseline.fingerprint } }))
      .toThrow('REGISTRY_VERSION_IS_NOT_THE_BASELINE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · the rehearsal
// ─────────────────────────────────────────────────────────────────────────────

describe('the rollback rehearsal', () => {
  it('promotes xg-v1.1 in a copy, verifies it, rolls it back byte for byte, and leaves the repository untouched', async () => {
    const r = await rehearse('xg-v1.1', { approvedAt: '2026-10-06' });
    const failed = r.steps.filter((s) => !s.ok);
    expect(failed.map((s) => `${s.step}: ${JSON.stringify(s.detail).slice(0, 1500)}`)).toEqual([]);
    expect(r.steps.map((s) => s.step)).toEqual([
      'generated files current (before)', 'plan', 'apply', 'verify (promoted)',
      'generated files current (promoted)', 'rollback', 'verify (rolled back)',
    ]);
    expect(r.promotion).toEqual({
      changed: [
        'lab/algorithms/candidates/index.ts', 'src/algorithms/generated/algorithm-manifest.json',
        'src/algorithms/generated/candidate-evidence.json', 'src/algorithms/registry.ts',
        'src/cyber-defense/generated/security-manifest.json', XG_FILE,
      ],
      added: [
        'lab/algorithms/archive/xg-v1.1.approved.ts', 'lab/algorithms/archive/xg-v1.1.candidate.ts',
        'lab/algorithms/archive/xg-v1.1.json', 'src/algorithms/approvals/xg-v1.1.json',
      ],
      removed: [CANDIDATE_FILE],
    });
    expect(r.leftovers).toEqual([]);
    expect(r.repositoryUntouched).toBe(true);
    expect(r.ok).toBe(true);
  }, 600_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · the releases read
// ─────────────────────────────────────────────────────────────────────────────

describe('the releases read', () => {
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
  const ROUTE = '/system/algorithms/releases';

  it('serves the owner the contract, with no-store, never claiming a deploy state', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    const res = await request(app()).get(ROUTE);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = AlgorithmsReleasesSchema.parse(res.body.data);
    expect(data.deploy).toEqual({ requested: 'NOT_KNOWN_HERE', live: 'NOT_KNOWN_HERE' });
    expect(data.totals.change).toBe(0);
  });

  it('refuses a club administrator, and an unauthenticated caller', async () => {
    actingAs = { id: PRESIDENT, clubId: 'club-1', role: 'CLUB_ADMIN' };
    const res = await request(app()).get(ROUTE);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/NOT_KNOWN_HERE|c9d12afe/);
    actingAs = null;
    expect((await request(app()).get(ROUTE)).status).toBe(401);
  });

  it('answers no write — nothing here approves, releases or rolls back', async () => {
    actingAs = { id: OWNER, clubId: null, role: 'CLUB_ADMIN' };
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app())[verb](ROUTE).send({ approve: true });
      expect(`${verb}: ${res.status}`).toBe(`${verb}: 404`);
    }
  });

  it('is declared before the key route, and reads the build commit only from the route layer', () => {
    const routes = read('src/routes/algorithms.routes.ts');
    expect(routes.indexOf("router.get('/releases'")).toBeLessThan(routes.indexOf("router.get('/:key'"));
    expect(routes).toContain('algorithmReleases(config.buildCommit)');
    for (const f of ['src/algorithms/release.ts', 'src/algorithms/approval-dossier.ts']) expect(read(f)).not.toMatch(/from '\.\.\/config'/);
  });
});

describe('the deploy run says what it requested, and that live is a person\'s check', () => {
  // The workflow's own step script, run with a stand-in curl that answers as Render's deploy hook does.
  function stepScript(name: string): string {
    const lines = read('.github/workflows/deploy.yml').split('\n');
    const step = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    const start = lines.findIndex((l, i) => i > step && /^\s+run: \|\s*$/.test(l));
    const indent = lines[start + 1].search(/\S/);
    const body: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (l.trim() && l.search(/\S/) < indent) break;
      body.push(l.slice(indent));
    }
    return body.join('\n');
  }
  const HOOK = 'https://api.render.invalid/deploy/srv-secret?key=hook-secret-value';

  function trigger(answer: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-summary-'));
    try {
      fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/bash\nprintf '%s' '${answer}'\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'step.sh'), stepScript('Trigger Render deploy hook'));
      const summary = path.join(dir, 'summary.md');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const out = require('child_process').execFileSync('bash', [path.join(dir, 'step.sh')], {
        cwd: dir, encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH}`, RENDER_DEPLOY_HOOK_URL: HOOK, DEPLOY_REASON: 'ci-success', DEPLOY_REF: 'c'.repeat(40), GITHUB_STEP_SUMMARY: summary },
      }) as string;
      return { out, summary: fs.readFileSync(summary, 'utf8') };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('records the commit and the deploy Render accepted, and says live is not confirmed — never the hook', () => {
    const r = trigger('{"deploy":{"id":"dep-d3adb33fc0ffee"}}');
    expect(r.out).toContain('Render accepted the deploy hook (deploy: dep-d3adb33fc0ffee)');
    expect(r.summary).toContain(`| Commit | \`${'c'.repeat(40)}\` |`);
    expect(r.summary).toContain('| Render deploy | `dep-d3adb33fc0ffee` |');
    expect(r.summary).toContain('**Not confirmed by this workflow.**');
    for (const text of [r.out, r.summary]) expect(text).not.toMatch(/hook-secret-value|srv-secret|api\.render\.invalid/);
  });

  it('says so when Render reports no deploy id, and keeps nothing else Render sent', () => {
    const r = trigger('{"note":"<script>x</script> `rm -rf` dep-"}');
    expect(r.summary).toContain('| Render deploy | `not reported` |');
    expect(r.summary).not.toMatch(/script|rm -rf/);
    const none = trigger('accepted');
    expect(none.summary).toContain('| Render deploy | `not reported` |');
  });
});

describe('the room draws release states honestly', () => {
  const js = read('public/algorithms/algorithms.js');
  const css = read('public/algorithms/algorithms.css');

  it('shows deploy requested and confirmed live only as not known here, and refuses a response that claims otherwise', () => {
    expect(js).toContain("row(T('Deploy requested'), notKnownHere(R.deploy.requested)");
    expect(js).toContain("row(T('Confirmed live'), notKnownHere(R.deploy.live)");
    expect(js).toMatch(/d\.deploy\.requested !== 'NOT_KNOWN_HERE' \|\| d\.deploy\.live !== 'NOT_KNOWN_HERE'/);
  });

  it('never moves the table under the reader: a loading chip is the size of the chip, and cells wrap inside themselves', () => {
    expect(js).toContain('<span class="al-chip al-chip--sm al-chip--skel" aria-hidden="true">&nbsp;</span>');
    expect(css).toMatch(/\.al-chip--skel \{[^}]*width: 104px; box-sizing: border-box; color: transparent;/);
    expect(css).toContain('.al-tbl--appr .al-chip, .al-tbl--rel .al-chip { max-width: 100%; white-space: normal; }');
    expect(css).toContain('.al-tbl--appr .al-tr > *, .al-tbl--rel .al-tr > * { overflow-wrap: anywhere; }');
  });
});
