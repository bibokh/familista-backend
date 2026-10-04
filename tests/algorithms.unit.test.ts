/**
 * Algorithms, Step 1 — the registry, the loop, the gate and the room.
 *
 * THE TEST THIS FILE EXISTS FOR
 *
 * "the code of every registered algorithm is the code its approval names". It
 * computes each algorithm's fingerprint FRESH from the source — not from the
 * committed manifest — and compares it with the fingerprint the platform
 * owner approved in src/algorithms/registry.ts. Change an algorithm and this
 * fails until the registry records a new version and a new approval; that
 * edit is itself a reviewed change to a code-owned file. So no algorithmic
 * change reaches main, and therefore production, without a human approval of
 * that exact code.
 *
 * The rest pins what that rule stands on: the loop admits Deploy only from
 * Human approval, every algorithm is read/analyze-only, the scenarios run the
 * real functions and pass, the room is owner-only and has no write, its
 * strings are translated, and Cybersecurity covers it.
 */

import fs from 'fs';
import path from 'path';
import { ALGORITHMS, ALGORITHM_DOMAINS, algorithmOf } from '../src/algorithms/registry';
import {
  LOOP_STAGES, LOOP_EDGES, ALGORITHM_MODES, deploymentGate, canAdvance, stageOf,
  type GateInput, type GateVerdict, type LoopStage,
} from '../src/algorithms/loop';
import { SCENARIOS, evaluate } from '../src/algorithms/scenarios';
import { algorithmsOverview, algorithmDetail, resetAlgorithmMonitor } from '../src/algorithms/algorithms.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const discover = require('../scripts/algorithms-discover.js');

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel: string) => JSON.parse(read(rel));
const CONTROL_FOR_TEST = 'algorithm-change-gate';

describe('the registry describes real code', () => {
  it('has unique keys, known domains and read/analyze-only modes', () => {
    const keys = ALGORITHMS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    const domains = new Set(ALGORITHM_DOMAINS.map((d) => d.id));
    for (const a of ALGORITHMS) {
      expect(`${a.key}: ${domains.has(a.domain)}`).toBe(`${a.key}: true`);
      expect(`${a.key}: ${a.mode}`).toBe(`${a.key}: READ_ANALYZE`);
    }
    expect(ALGORITHM_MODES).toEqual(['READ_ANALYZE']);
  });

  it('every source file and listed test exists, and every dependency is registered', () => {
    for (const a of ALGORITHMS) {
      expect(`${a.key}: ${fs.existsSync(path.join(ROOT, a.source.file))}`).toBe(`${a.key}: true`);
      for (const t of a.tests) expect(`${a.key} → ${t}: ${fs.existsSync(path.join(ROOT, t))}`).toBe(`${a.key} → ${t}: true`);
      for (const d of a.dependsOn) expect(`${a.key} → ${d}: ${!!algorithmOf(d)}`).toBe(`${a.key} → ${d}: true`);
    }
  });

  it('the fingerprint script read every registry entry, with every symbol found exactly once', () => {
    const parsed = discover.registeredAlgorithms();
    expect(parsed.map((p: { key: string }) => p.key)).toEqual(ALGORITHMS.map((a) => a.key));
    for (const a of ALGORITHMS) {
      const p = parsed.find((x: { key: string }) => x.key === a.key);
      expect(p.symbols).toEqual(a.source.symbols);
      expect(p.file).toBe(a.source.file);
    }
    const fresh = discover.buildManifest().algorithms;
    for (const a of ALGORITHMS) expect(`${a.key}: ${fresh[a.key].error}`).toBe(`${a.key}: null`);
  });

  it('says why when an algorithm has no simulation, and only then', () => {
    for (const a of ALGORITHMS) {
      const simulated = !!(SCENARIOS[a.key] && SCENARIOS[a.key].length);
      expect(`${a.key}: ${simulated ? 'simulated' : 'reason ' + !!a.notSimulatedBecause}`)
        .toBe(`${a.key}: ${simulated ? 'simulated' : 'reason true'}`);
      if (simulated) expect(a.notSimulatedBecause).toBeNull();
    }
  });

  it('reads nothing from a database: no file in src/algorithms imports one', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'src/algorithms')).filter((x) => x.endsWith('.ts'))) {
      const src = read(`src/algorithms/${f}`);
      expect(`${f}: ${/config\/database|@prisma\/client|rls-client|db-context/.test(src)}`).toBe(`${f}: false`);
    }
  });
});

describe('THE GATE — no algorithm runs code a person did not approve', () => {
  const fresh = discover.buildManifest().algorithms as Record<string, { fingerprint: string | null }>;

  it.each(ALGORITHMS.map((a) => [a.key]))('%s runs exactly the version and code its approval names', (key) => {
    const a = algorithmOf(key)!;
    const now = fresh[key].fingerprint;
    const verdict = deploymentGate({ version: a.version, fingerprint: now, approval: a.approval, evaluation: evaluate(key).state, mode: a.mode });
    if (verdict !== 'APPROVED') {
      throw new Error([
        `Algorithm "${key}" is ${verdict}.`,
        `  version   ${a.version}   approved ${a.approval?.version ?? '—'}`,
        `  code now  ${now ?? '—'}`,
        `  approved  ${a.approval?.fingerprint ?? '—'}`,
        '',
        'Its code changed without a recorded human approval. To change an algorithm:',
        '  1. bump its version and add an entry to `versions` in src/algorithms/registry.ts, with the reason;',
        '  2. run `npm run algorithms:discover` and record the new fingerprint as a CHANGE approval;',
        '  3. the platform owner approves it by reviewing and merging that pull request (the registry is code-owned).',
      ].join('\n'));
    }
    expect(verdict).toBe('APPROVED');
  });

  it('the committed fingerprint manifest is current', () => {
    const body = JSON.stringify(discover.buildManifest(), null, 2) + '\n';
    expect(read(discover.OUT)).toBe(body);
  });

  it('every approval is a platform-owner approval with a reference', () => {
    for (const a of ALGORITHMS) {
      expect(a.approval).not.toBeNull();
      expect(a.approval!.approvedBy).toBe('PLATFORM_OWNER');
      expect(a.approval!.reference.trim().length).toBeGreaterThan(0);
      expect(a.versions.map((v) => v.version)).toContain(a.version);
    }
  });

  it('the registry and its fingerprint script are code-owned', () => {
    const owners = read('.github/CODEOWNERS');
    expect(owners).toMatch(/^\/src\/algorithms\/\s+@/m);
    expect(owners).toMatch(/^\/scripts\/algorithms-discover\.js\s+@/m);
  });
});

describe('fingerprints change with code, not with comments', () => {
  const fnSrc = `// a header
const W = { a: 1, b: 2 };
export function score(x: number): number {
  // weigh it
  return x * W.a + W.b;
}
function oneLine(x: number): number { return x + 1; }
export function typed(x: number): { ok: boolean } {
  return { ok: x > 0 };
}
`;
  const fp = (src: string) => {
    const clean = discover.stripComments(src);
    return ['W', 'score', 'oneLine', 'typed'].map((s) => discover.declarationOf(clean, s));
  };

  it('extracts each declaration to its end, including one-line functions and object return types', () => {
    const [w, score, one, typed] = fp(fnSrc);
    expect(w).toBe('const W = { a: 1, b: 2 };');
    expect(score.trim().endsWith('}')).toBe(true);
    expect(score).toContain('return x * W.a + W.b;');
    expect(one).toBe('function oneLine(x: number): number { return x + 1; }');
    expect(typed).toContain('return { ok: x > 0 };');
  });

  it('ignores a reworded comment and reformatting', () => {
    const norm = (src: string) => fp(src).map((d: string) => d.replace(/\s+/g, ' ').trim());
    const reworded = fnSrc.replace('// weigh it', '// multiply by the weight').replace('return x * W.a + W.b;', 'return x  *  W.a +  W.b;');
    expect(norm(reworded)).toEqual(norm(fnSrc));
  });

  it('sees a changed weight', () => {
    expect(fp(fnSrc.replace('b: 2', 'b: 3'))[0]).not.toBe(fp(fnSrc)[0]);
  });

  it('refuses a symbol that is not declared exactly once', () => {
    expect(discover.declarationOf(discover.stripComments(fnSrc), 'missing')).toBeNull();
    expect(discover.declarationOf(discover.stripComments(fnSrc + fnSrc), 'score')).toBeNull();
  });
});

describe('the Continuous Intelligence Loop', () => {
  const FP = 'a'.repeat(64);
  const base: GateInput = {
    version: 'v1.1', fingerprint: FP, evaluation: 'PASS', mode: 'READ_ANALYZE',
    approval: { version: 'v1.1', fingerprint: FP, approvedBy: 'PLATFORM_OWNER', reference: 'PR', approvedAt: '2026-10-04' },
  };

  it('has the eight stages in order, and closes Measure back into Learn', () => {
    expect(LOOP_STAGES).toEqual(['OBSERVE', 'LEARN', 'PROPOSE', 'SIMULATE', 'TEST', 'HUMAN_APPROVAL', 'DEPLOY', 'MEASURE']);
    expect(LOOP_EDGES.MEASURE).toEqual(['LEARN']);
  });

  it('reaches Deploy only from Human approval, and only with an APPROVED gate', () => {
    const verdicts: GateVerdict[] = ['APPROVED', 'NO_APPROVAL', 'VERSION_NOT_APPROVED', 'CHANGED_SINCE_APPROVAL',
      'FINGERPRINT_UNAVAILABLE', 'EVALUATION_FAILED', 'MODE_NOT_ALLOWED'];
    for (const from of LOOP_STAGES) {
      for (const g of [...verdicts, null]) {
        const ok = canAdvance(from as LoopStage, 'DEPLOY', g);
        expect(`${from} + ${g}: ${ok}`).toBe(`${from} + ${g}: ${from === 'HUMAN_APPROVAL' && g === 'APPROVED'}`);
      }
    }
    for (const from of LOOP_STAGES) {
      if (from !== 'HUMAN_APPROVAL') expect(LOOP_EDGES[from as LoopStage]).not.toContain('DEPLOY');
    }
  });

  it('refuses every way around an approval', () => {
    expect(deploymentGate(base)).toBe('APPROVED');
    expect(deploymentGate({ ...base, approval: null })).toBe('NO_APPROVAL');
    expect(deploymentGate({ ...base, approval: { ...base.approval!, reference: '  ' } })).toBe('NO_APPROVAL');
    expect(deploymentGate({ ...base, approval: { ...base.approval!, fingerprint: 'nope' } })).toBe('NO_APPROVAL');
    expect(deploymentGate({ ...base, version: 'v1.2' })).toBe('VERSION_NOT_APPROVED');
    expect(deploymentGate({ ...base, fingerprint: 'b'.repeat(64) })).toBe('CHANGED_SINCE_APPROVAL');
    expect(deploymentGate({ ...base, fingerprint: null })).toBe('FINGERPRINT_UNAVAILABLE');
    expect(deploymentGate({ ...base, evaluation: 'FAIL' })).toBe('EVALUATION_FAILED');
    expect(deploymentGate({ ...base, evaluation: 'NOT_SIMULATED' })).toBe('APPROVED');
    // A mode that acts is refused first: no approval can allow it in Step 1.
    expect(deploymentGate({ ...base, mode: 'ACT' })).toBe('MODE_NOT_ALLOWED');
    expect(deploymentGate({ ...base, mode: 'ACT', approval: null })).toBe('MODE_NOT_ALLOWED');
  });

  it('derives each stage from the gate, never from a stored value', () => {
    expect(stageOf('APPROVED')).toBe('MEASURE');
    expect(stageOf('EVALUATION_FAILED')).toBe('TEST');
    expect(stageOf('CHANGED_SINCE_APPROVAL')).toBe('HUMAN_APPROVAL');
    expect(stageOf('VERSION_NOT_APPROVED')).toBe('HUMAN_APPROVAL');
    expect(stageOf('NO_APPROVAL')).toBe('OBSERVE');
    expect(stageOf('MODE_NOT_ALLOWED')).toBe('OBSERVE');
  });
});

describe('simulation and evaluation run the real functions', () => {
  it.each(Object.keys(SCENARIOS).map((k) => [k]))('%s passes every check of every scenario', (key) => {
    const e = evaluate(key);
    const failing = e.scenarios.flatMap((s) => s.checks.filter((c) => !c.pass).map((c) => `${s.id}: ${c.label} (observed ${c.observed}, required ${c.expected})`));
    expect(failing).toEqual([]);
    expect(e.state).toBe('PASS');
    expect(e.total).toBeGreaterThan(0);
  });

  it('a scenario that throws is a failed check, never a crash', () => {
    const real = SCENARIOS.xg;
    const mutable = SCENARIOS as Record<string, typeof real>;
    mutable.xg = [{ id: 'boom', title: 'Boom', run: () => { throw new TypeError('x'); } }];
    try {
      const e = evaluate('xg');
      expect(e.state).toBe('FAIL');
      expect(e.scenarios[0].checks[0]).toMatchObject({ pass: false, observed: 'TypeError' });
    } finally { mutable.xg = real; }
  });

  it('shows observed and required values as numbers, symbols or machine tokens — never untranslated prose', () => {
    // These cells are identifiers on screen (data-no-i18n); a sentence there
    // would render English into a German or Arabic session.
    for (const k of Object.keys(SCENARIOS)) {
      for (const sc of evaluate(k).scenarios) {
        for (const c of sc.checks) {
          for (const v of [c.observed, c.expected]) {
            expect(`${k}/${sc.id}: ${v.replace(/\bnull\b|\bv\d+(\.\d+)*\b/g, '')}`).not.toMatch(/: .*[a-z]{2,}/);
          }
        }
      }
    }
  });

  it('every scenario is keyed to a registered algorithm', () => {
    for (const k of Object.keys(SCENARIOS)) expect(`${k}: ${!!algorithmOf(k)}`).toBe(`${k}: true`);
  });
});

describe('the room composes evidence and says so when it is missing', () => {
  beforeEach(() => resetAlgorithmMonitor());

  it('answers READY with every algorithm approved, every guarantee holding and every check passing', () => {
    const o = algorithmsOverview();
    expect(o.state).toBe('READY');
    expect(o.totals!.registered).toBe(ALGORITHMS.length);
    expect(o.totals!.approved).toBe(ALGORITHMS.length);
    expect(o.totals!.failing).toBe(0);
    expect(o.totals!.checksPassed).toBe(o.totals!.checks);
    expect(o.guarantees.every((g) => g.holds)).toBe(true);
    expect(o.loop.map((s) => s.id)).toEqual([...LOOP_STAGES]);
    expect(o.loop.find((s) => s.id === 'MEASURE')!.algorithms).toBe(ALGORITHMS.length);
    expect(o.monitoring!.evaluationRuns).toBe(1);
    expect(o.monitoring!.lastRunAt).not.toBeNull();
  });

  it('re-uses one evaluation for a minute, so a refresh storm reruns nothing', () => {
    algorithmsOverview(); algorithmsOverview(); algorithmDetail('xg');
    expect(algorithmsOverview().monitoring!.evaluationRuns).toBe(1);
  });

  it('describes one algorithm in full, and refuses a key that is not registered', () => {
    const d = algorithmDetail('xg');
    expect(d.state).toBe('READY');
    if (d.state !== 'READY') return;
    expect(d.detail.fingerprint.matches).toBe(true);
    expect(d.detail.fingerprint.current).toMatch(/^[0-9a-f]{64}$/);
    expect(d.detail.scenarios.length).toBeGreaterThan(0);
    expect(algorithmDetail('nope').state).toBe('UNKNOWN_ALGORITHM');
    expect(algorithmDetail('training-load').state === 'READY' && (algorithmDetail('training-load') as { detail: { notSimulatedBecause: string } }).detail.notSimulatedBecause).toBeTruthy();
  });

  it('says NOT GENERATED, rather than calling anything approved, when the fingerprints are missing', () => {
    jest.isolateModules(() => {
      jest.doMock('fs', () => {
        const real = jest.requireActual('fs');
        return { ...real, readFileSync: (p: string, ...rest: unknown[]) => {
          if (String(p).endsWith('algorithm-manifest.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return real.readFileSync(p, ...rest);
        } };
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const svc = require('../src/algorithms/algorithms.service');
      const o = svc.algorithmsOverview();
      expect(o.state).toBe('NOT_GENERATED');
      expect(o.algorithms).toEqual([]);
      expect(o.totals).toBeNull();
      expect(svc.algorithmDetail('xg').state).toBe('NOT_GENERATED');
    });
    jest.dontMock('fs');
  });

  it('puts a changed algorithm at Human approval, not at Measure', () => {
    const a = algorithmOf('xg')!;
    const verdict = deploymentGate({ version: a.version, fingerprint: 'f'.repeat(64), approval: a.approval, evaluation: 'PASS', mode: a.mode });
    expect(verdict).toBe('CHANGED_SINCE_APPROVAL');
    expect(stageOf(verdict)).toBe('HUMAN_APPROVAL');
  });
});

describe('the room is the platform owner’s, and it writes nothing', () => {
  const routes = read('src/routes/algorithms.routes.ts');
  const code = routes.replace(/\/\/[^\n]*/g, '');

  it('is mounted behind authenticate and assertPlatformOwner', () => {
    expect(code).toContain('router.use(authenticate);');
    expect(code).toMatch(/await assertPlatformOwner\(/);
    expect(read('src/routes/index.ts')).toContain("router.use('/system/algorithms', algorithmsRoutes);");
  });

  it('has exactly two reads and no write handler', () => {
    expect((code.match(/router\.get\(/g) || []).length).toBe(2);
    expect(code).not.toMatch(/router\.(post|put|patch|delete|all)\(/);
    expect(read('public/algorithms/algorithms.js')).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  });

  it('is a pinned owner room, and its key parameter is reviewed as platform-only', () => {
    const policy = json('src/cyber-defense/posture-policy.json');
    expect(policy.ownerRooms['algorithms.routes']).toEqual({ mount: '/system/algorithms' });
    expect(policy.tenancyExemptions['algorithms.routes :key'].basis).toBe('platform-only');
  });
});

describe('Cybersecurity covers the Algorithms module from the start', () => {
  const manifest = json('src/cyber-defense/generated/security-manifest.json');
  const policy = json('src/cyber-defense/posture-policy.json');
  const map = json('src/cyber-defense/coverage-map.json');

  it('the algorithm-change-gate control is present and required', () => {
    expect(manifest.controls.find((c: { id: string }) => c.id === CONTROL_FOR_TEST)?.status).toBe('PRESENT');
    expect(policy.requiredControls).toContain(CONTROL_FOR_TEST);
  });

  it('its router and source domain are mapped onto the algorithm change-control boundary', () => {
    expect(map.boundaries['39']).toMatchObject({ name: 'Algorithm change control', coverage: 'C', controls: [CONTROL_FOR_TEST] });
    expect(map.components.routers['algorithms.routes']).toContain(39);
    expect(map.components.srcDomains.algorithms).toEqual([39]);
  });

  it('appears on the Cybersecurity map as an AI area', () => {
    const reg = read('src/cyber-defense/control-plane/registry.ts');
    expect(reg).toContain("{ id: 'algorithms', title: 'Algorithms', group: 'AI', routers: ['algorithms.routes'], rows: [39] }");
    expect(reg).toContain("controls: ['codeowners', 'algorithm-change-gate'],");
  });
});

describe('the eighth room in the shell', () => {
  const app = read('public/app.js');
  const css = read('public/app.css');
  const index = read('public/index.html');

  it('is a top-level owner room of its own, not a page inside another', () => {
    expect(app).toContain("'algorithms':                  ['renderFamilistaAlgorithms'],");
    expect(app).toContain("case 'pg-algorithms':");
    expect(app).toContain("'algorithms': 1,");
    expect(app).toContain('<div class="page" id="pg-algorithms" data-no-i18n><div id="al-root"></div></div>');
    expect(app).toContain('data-page="algorithms"');
    expect(index).toContain('/algorithms/algorithms.js?v=');
    expect(index).toContain('/algorithms/algorithms.css?v=');
  });

  it('its card closes the top row, a peer the same size as every other', () => {
    expect(css).toContain('"system system cyber  cyber  clubs  clubs  algo   algo "');
    expect(app).toContain('<div class="oh-card-title">ALGORITHMS</div>');
    expect(app).toContain("fetch(base + '/system/algorithms'");
  });

  it('translates the card in every locale the platform ships', () => {
    const N = '\u0000';
    const keys = ['ALGORITHMS', 'Registry, Intelligence Loop, Evaluation & Human Approval',
      'Overview · Registry · Intelligence Loop · Evaluation · Approvals & Audit · Monitoring',
      'Reading algorithm evidence…', 'Enter Algorithms', 'Algorithm evidence not generated',
      `Algorithms failing evaluation: ${N}`, `Algorithms awaiting approval: ${N}`, `Algorithms approved: ${N} of ${N}`,
      'Algorithms unreachable'];
    const tags = fs.readdirSync(path.join(ROOT, 'public/i18n/catalogue')).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f));
    expect(tags.length).toBeGreaterThan(10);
    for (const f of tags) {
      if (f.startsWith('en-') && f !== 'en-GB.json') continue;
      const cat = JSON.parse(read(`public/i18n/catalogue/${f}`));
      for (const k of keys) expect(`${f} ${JSON.stringify(k)}: ${typeof cat[k]}`).toBe(`${f} ${JSON.stringify(k)}: string`);
    }
    // The status line says the worst thing first and green only when all are approved.
    const fn = app.slice(app.indexOf('function _fillAlgorithmsStatus'), app.indexOf('function _fillSourceCoreStatus'));
    expect(fn).toMatch(/if \(t\.failing > 0\) write\('bad'[\s\S]*else if \(t\.registered - t\.approved > 0\) write\('warn'[\s\S]*else write\('ok'/);
    expect(app).toContain('try { _fillAlgorithmsStatus(); } catch (_) {}');
  });

  it('keeps the workspace still: no inline style, a stable gutter, an escape hatch', () => {
    const js = read('public/algorithms/algorithms.js');
    const sheet = read('public/algorithms/algorithms.css');
    expect(js).not.toMatch(/style="/);
    expect(js).not.toMatch(/\.style\./);
    expect(sheet).toContain('scrollbar-gutter: stable');
    expect(sheet).toContain('@media (max-width: 980px), (max-height: 620px)');
    expect(sheet).not.toMatch(/@keyframes|animation:/);
  });
});

describe('the room speaks English, German and Arabic — every string it can show', () => {
  const en = json('public/algorithms/i18n/en.json');
  const de = json('public/algorithms/i18n/de.json');
  const ar = json('public/algorithms/i18n/ar.json');

  /** Every literal the module passes through T/tf/panel/emptyState, and its label tables. */
  function uiStrings(): Set<string> {
    const src = read('public/algorithms/algorithms.js');
    const out = new Set<string>();
    for (const m of src.matchAll(/(?:\bT|\btf|\bpanel|\bemptyState)\(\s*'((?:[^'\\]|\\.)*)'/g)) out.add(m[1].replace(/\\'/g, "'"));
    for (const name of ['GATE_LABEL', 'GATE_MEANING', 'EVAL_LABEL', 'STAGE_LABEL', 'GROUP_LABEL']) {
      const i = src.indexOf(`var ${name} = {`);
      for (const m of src.slice(i, src.indexOf('};', i)).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) out.add(m[1]);
    }
    const s = src.indexOf('var SECTIONS = [');
    for (const m of src.slice(s, src.indexOf('];', s)).matchAll(/\['\w+', '([^']+)'/g)) out.add(m[1]);
    out.delete('');
    return out;
  }

  /** Every string the server sends for the room to show. */
  function serverStrings(): Set<string> {
    const out = new Set<string>();
    const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.add(v); };
    const o = algorithmsOverview();
    o.loop.forEach((x) => { add(x.title); add(x.describes); });
    o.domains.forEach((x) => { add(x.title); add(x.describes); });
    o.algorithms.forEach((x) => add(x.name));
    o.guarantees.forEach((x) => add(x.text));
    add('The algorithm fingerprints are not beside this server.');
    add('The scenario ran without an error');
    for (const a of o.algorithms) {
      const d = algorithmDetail(a.key);
      if (d.state !== 'READY') continue;
      add(d.detail.summary); d.detail.usedBy.forEach(add);
      [...d.detail.inputs, ...d.detail.outputs].forEach((p) => { add(p.name); add(p.unit); });
      d.detail.versions.forEach((v) => add(v.note)); add(d.detail.notSimulatedBecause);
      d.detail.scenarios.forEach((sc) => { add(sc.title); sc.checks.forEach((c) => add(c.label)); });
    }
    return out;
  }

  it('has an entry for every string the module and the server can show', () => {
    const missing = [...uiStrings(), ...serverStrings()].filter((s) => !(s in en)).sort();
    expect(missing).toEqual([]);
  });

  it('carries the same keys in all three languages, each translated with its slots intact', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      expect(`${k}: ${en[k] === k}`).toBe(`${k}: true`);
      for (const [tag, d] of [['de', de], ['ar', ar]] as const) {
        expect(`${tag} ${k}: ${(d[k].match(/%d/g) || []).length}`).toBe(`${tag} ${k}: ${(k.match(/%d/g) || []).length}`);
      }
    }
  });

  it('sets the page direction from the language, so Arabic reads right to left', () => {
    const js = read('public/algorithms/algorithms.js');
    expect(js).toContain("['ar', 'العربية', 'rtl']");
    expect(js).toContain("host.setAttribute('dir', AL_DIR);");
  });
});
