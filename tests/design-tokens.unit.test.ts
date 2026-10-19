/**
 * Familista Design Core — Stage 2a/2b.1 tokens & foundations ratchet.
 *
 * The canonical token source (tools/tokens/familista.tokens.json, W3C DTCG
 * format) is the single source of truth for Familista's design values. This
 * suite keeps it honest against production without touching production:
 *
 *   - the token file is valid DTCG, every reference resolves, nothing loops;
 *   - the generated CSS is deterministic, committed, and declares only --fam-*;
 *   - every custom property production declares is in the legacy map with its
 *     exact live value — a new or changed one fails until a person classifies
 *     it (node tools/tokens/scripts/inventory.mjs --write);
 *   - the names production references but never declares stay undefined;
 *   - no contrast failure beyond the recorded baseline appears;
 *   - Arabic tracking resolves to 0 and Noto Sans Arabic is in the stack;
 *   - and (Stage 2b.1) the token CSS is published under public/tokens/, linked
 *     once from the main app before every other stylesheet, and read by nothing.
 *
 * The checks run in tools/tokens/scripts/verify.mjs (dependency-free ES
 * modules shared with Storybook); this file runs it once and names each
 * guarantee so a red build says which one broke.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

// The Stage 2b.1 serving tests drive the real createApp(); only the database is stubbed.
jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const ROOT = join(__dirname, '..');
const TOKENS = join(ROOT, 'tools', 'tokens');

type Check = { id: string; pass: boolean; detail: string[] };
type Result = { pass: boolean; checks: Check[]; stats: Record<string, any> };

function runVerify(): Result {
  let out: string;
  try {
    out = execFileSync(process.execPath, [join(TOKENS, 'scripts', 'verify.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e: any) {
    // verify.mjs exits 1 when a check fails but still prints the JSON result.
    out = String(e.stdout || '');
    if (!out.trim().startsWith('{')) throw new Error('verify.mjs did not produce a result:\n' + String(e.stderr || e.message));
  }
  return JSON.parse(out);
}

const result = runVerify();
const byPrefix = (prefix: string): Check => {
  const c = result.checks.find((x) => x.id.startsWith(prefix));
  if (!c) throw new Error(`verify.mjs has no check "${prefix}"`);
  return c;
};
const expectPass = (prefix: string) => {
  const c = byPrefix(prefix);
  expect({ check: c.id, problems: c.detail }).toEqual({ check: c.id, problems: [] });
  expect(c.pass).toBe(true);
};

describe('Familista Design Core — token source', () => {
  it('is valid DTCG: every reference resolves and no reference loops', () => expectPass('dtcg-valid'));
  it('keeps raw values in the reference layer and references in the semantic layer', () => expectPass('layering'));
});

describe('Familista Design Core — generated CSS', () => {
  it('is deterministic and the committed file is current', () => expectPass('deterministic'));
  it('declares only --fam-* custom properties on bound selectors', () => expectPass('namespace'));

  it('is published byte-for-byte under public/tokens/ (Stage 2b.1)', () => expectPass('published'));

  it('is linked exactly once, from the main app only, before every other stylesheet', () => {
    expectPass('linked once');
    expectPass('main app only');
    // The pages Stage 2b.1 leaves alone, asserted directly as well.
    for (const page of ['public/familista-admin.html', 'public/invite/index.html', 'public/app/index.html']) {
      expect(readFileSync(join(ROOT, page), 'utf8')).not.toMatch(/familista-tokens/);
    }
  });

  it('is read only by the Design System Control room: no other production file references the --fam- namespace', () => {
    expectPass('unread');
    for (const f of ['public/app.css', 'public/app.js', 'public/index.html']) {
      expect(readFileSync(join(ROOT, f), 'utf8')).not.toMatch(/--fam-/);
    }
  });

  it('cannot change what production renders: it declares custom properties and nothing else', () => {
    const css = readFileSync(join(ROOT, 'public', 'tokens', 'familista-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const props = css.match(/[{;]\s*([a-zA-Z0-9-]+)\s*:/g) || [];
    expect(props.length).toBeGreaterThan(200);
    for (const p of props) expect(p.replace(/^[{;]\s*/, '')).toMatch(/^--fam-/);
  });
});

describe('Familista Design Core — production inventory ratchet', () => {
  it('maps every production custom property with its exact live value', () => expectPass('inventory'));
  it('keeps the names production references but never declares undefined', () => expectPass('undefined names'));

  it('protects the names recorded at Stage 2a', () => {
    const map = JSON.parse(readFileSync(join(TOKENS, 'legacy-map.json'), 'utf8'));
    const css = map.undefinedNames.css.map((u: { name: string }) => u.name);
    expect(css).toEqual(expect.arrayContaining(['--tx-1', '--lg-line', '--ac2', '--tf-ink1', '--v-tx-1']));
    expect(css.length).toBe(18);
  });
});

describe('Familista Design Core — accessibility, language and preference foundations', () => {
  it('introduces no contrast failure beyond the recorded baseline', () => expectPass('contrast'));
  it('resolves every tracking step to 0 for Arabic', () => expectPass('arabic: every tracking'));
  it('carries the Noto Sans Arabic fallback alongside Inter and JetBrains Mono', () => expectPass('arabic: Noto'));
  it('mirrors direction under dir="rtl"', () => expectPass('rtl'));
  it('stops motion under prefers-reduced-motion', () => expectPass('reduced motion'));
  it('reserves light and high-contrast theme layers', () => expectPass('themes'));
});

describe('Familista Design Core — the whole result', () => {
  it('passes every guarantee', () => {
    expect(result.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

const app = createApp();
const PUBLISHED = readFileSync(join(ROOT, 'public', 'tokens', 'familista-tokens.css'), 'utf8');

describe('the published token CSS, served by the real app', () => {
  it('answers /tokens/familista-tokens.css as CSS, byte-for-byte what the generator produced', async () => {
    const res = await request(app).get('/tokens/familista-tokens.css?v=20261011-tokens-2b1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/css/);
    expect(res.text).toBe(PUBLISHED);
    expect(PUBLISHED).toBe(readFileSync(join(TOKENS, 'dist', 'familista-tokens.css'), 'utf8'));
  });

  it('is a same-origin stylesheet, which the Content-Security-Policy allows', async () => {
    const res = await request(app).get('/');
    const csp = String(res.headers['content-security-policy'] || '');
    expect(csp).toMatch(/style-src 'self'/);
    expect(csp).not.toMatch(/style-src[^;]*'unsafe-inline'/);
    // No inline style, no import, no url(): nothing for the policy to refuse.
    expect(PUBLISHED).not.toMatch(/@import|url\(|<style|javascript:/i);
  });

  it('is linked by the page the app serves at "/", once, ahead of app.css', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const links = res.text.match(/href="\/tokens\/familista-tokens\.css\?v=[^"]+"/g) || [];
    expect(links).toHaveLength(1);
    expect(res.text.indexOf('/tokens/familista-tokens.css')).toBeLessThan(res.text.indexOf('/app.css'));
  });

  it('is not served as the HTML document by any catch-all', async () => {
    const res = await request(app).get('/tokens/familista-tokens.css');
    expect(res.text).not.toMatch(/<!doctype html/i);
  });
});

// ── M3/S3.1 — static design-quality gates (L1a, L1b) ─────────────────────────

/**
 * Every var() reference in a stylesheet, nested ones included, and whether it
 * carries a fallback (a comma at its own depth). Comments and quoted strings
 * are not CSS values, so they are blanked first.
 */
function varReferences(css: string): { name: string; fallback: boolean }[] {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const out: { name: string; fallback: boolean }[] = [];
  const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    let depth = 0, fallback = false;
    for (let i = m.index + 4; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { if (depth === 0) break; depth--; }
      else if (s[i] === ',' && depth === 0) { fallback = true; break; }
    }
    out.push({ name: m[1], fallback });
  }
  return out;
}

/** The names a stylesheet declares in a block whose selector is exactly `:root`. */
function rootDeclarations(css: string): Set<string> {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const b of s.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (b[1].trim() !== ':root') continue;
    for (const d of b[2].matchAll(/(?:^|;)\s*(--[A-Za-z0-9_-]+)\s*:/g)) out.add(d[1]);
  }
  return out;
}

/**
 * The --fam-* names a stylesheet reads that are neither declared at :root by
 * the published token stylesheet nor written at run time by a proven source.
 * A fallback does not excuse an unknown name: var(--fam-txet, #fff) is a
 * misspelling that would quietly render the fallback.
 */
function unresolvedTokens(css: string, declared: Set<string>, runtime: Record<string, string>): string[] {
  const own = (n: string) => Object.prototype.hasOwnProperty.call(runtime, n);
  return [...new Set(varReferences(css).map((r) => r.name).filter((n) => n.startsWith('--fam-') && !declared.has(n) && !own(n)))].sort();
}

/**
 * --fam-* properties a page or script sets at run time, with the file that sets
 * each. Empty: at M3/S3.1 no public script or page writes one (no
 * setProperty('--fam-…') and no "--fam-…:" outside the token stylesheet). An
 * entry is accepted only while its file really writes that property.
 */
const RUNTIME_TOKENS: Record<string, string> = {};
const RUNTIME_WRITE = /setProperty\(\s*['"`](--fam-[A-Za-z0-9_-]+)|(--fam-[A-Za-z0-9_-]+)['"]?\s*:/g;

function publicPagesAndScripts(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) publicPagesAndScripts(p, acc);
    else if (/\.(m?js|html)$/.test(name)) acc.push(p);
  }
  return acc;
}

const TOKEN_CSS = readFileSync(join(ROOT, 'public', 'tokens', 'familista-tokens.css'), 'utf8');
const DECLARED = rootDeclarations(TOKEN_CSS);
const ROOM_DIR = join(ROOT, 'public', 'design-system');
const ROOM_SHEETS = readdirSync(ROOM_DIR).filter((f) => f.endsWith('.css')).sort();

describe('M3/S3.1 L1a — every --fam-* token the Design System room reads is published', () => {
  it('reads the room stylesheets the graph manifest says the room loads, and no others', () => {
    const graph = JSON.parse(readFileSync(join(ROOT, 'src', 'design-system', 'generated', 'design-system-graph.json'), 'utf8'));
    const view = graph.views.find((v: { id: string }) => v.id === 'stylesheets-to-surfaces');
    const lazy = view.edges.filter((e: { to: string }) => e.to === 'surface:lazy').map((e: { from: string }) => e.from.replace(/^css:public\/design-system\//, '')).sort();
    expect(ROOM_SHEETS).toEqual(lazy);
    expect(ROOM_SHEETS).toEqual(expect.arrayContaining(['components.css', 'design-system.css', 'explorer.css', 'lab.css']));
  });

  it('finds the published tokens at :root, the only block the room can rely on', () => {
    expect(DECLARED.size).toBeGreaterThan(200);
    for (const n of DECLARED) expect(n).toMatch(/^--fam-/);
  });

  it.each(ROOM_SHEETS)('%s reads only --fam-* names declared at :root by the published token stylesheet', (sheet) => {
    const css = readFileSync(join(ROOM_DIR, sheet), 'utf8');
    const names = varReferences(css).map((r) => r.name).filter((n) => n.startsWith('--fam-'));
    expect(names.length).toBeGreaterThan(0);
    expect({ sheet, unresolved: unresolvedTokens(css, DECLARED, RUNTIME_TOKENS) }).toEqual({ sheet, unresolved: [] });
  });

  it('accepts a runtime token only with source evidence, and every runtime write it finds is accounted for', () => {
    const writes = new Map<string, string>();
    for (const file of publicPagesAndScripts(join(ROOT, 'public'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(RUNTIME_WRITE)) writes.set(m[1] || m[2], file.slice(ROOT.length + 1));
    }
    expect([...writes.keys()].sort()).toEqual(Object.keys(RUNTIME_TOKENS).sort());
    for (const [name, file] of Object.entries(RUNTIME_TOKENS)) expect(writes.get(name)).toBe(file);
  });

  // Controls: the same function the gate runs, on stylesheets written to pass or to fail.
  const real = [...DECLARED].sort();
  const known = real.find((n) => n.slice(-1) !== n.slice(-2, -1)) as string, other = real[real.length - 1];
  const misspelt = known.slice(0, -2) + known.slice(-1) + known.slice(-2, -1);   // the last two letters swapped
  it.each([
    ['a published token', `.x{color:var(${known})}`, {}, []],
    ['a published token with a fallback', `.x{color:var(${known}, #fff)}`, {}, []],
    ['a published token whose fallback is another published token', `.x{color:var(${known}, var(${other}))}`, {}, []],
    ['a misspelt token', `.x{color:var(${misspelt})}`, {}, [misspelt]],
    ['an unknown token without a fallback', '.x{color:var(--fam-not-a-token)}', {}, ['--fam-not-a-token']],
    ['an unknown token hidden behind a fallback', '.x{color:var(--fam-not-a-token, #fff)}', {}, ['--fam-not-a-token']],
    ['an unknown token inside a published token’s fallback', `.x{color:var(${known}, var(--fam-not-a-token))}`, {}, ['--fam-not-a-token']],
    ['an approved runtime token', '.x{color:var(--fam-runtime-demo)}', { '--fam-runtime-demo': 'public/demo.js' }, []],
    ['the same token with no runtime source', '.x{color:var(--fam-runtime-demo)}', {}, ['--fam-runtime-demo']],
    ['a token named only in a comment', '/* var(--fam-not-a-token) */ .x{color:var(' + known + ')}', {}, []],
    ['a token named only in a string', '.x::after{content:"var(--fam-not-a-token)"}', {}, []],
    ['spacing inside var()', `.x{color:var( ${known} )}`, {}, []],
  ] as [string, string, Record<string, string>, string[]][])('control: %s', (_label, css, runtime, expected) => {
    expect(unresolvedTokens(css, DECLARED, runtime)).toEqual(expected);
  });

  it('control: records which references carry a fallback, nested ones included', () => {
    expect(varReferences('.x{a:var(--fam-a, var(--fam-b));b:var(--fam-c, calc(1px + var(--fam-d, 2px)))}')).toEqual([
      { name: '--fam-a', fallback: true }, { name: '--fam-b', fallback: false },
      { name: '--fam-c', fallback: true }, { name: '--fam-d', fallback: true },
    ]);
  });
});

/** Runs the existing DTCG validator (tools/tokens/lib/dtcg.mjs, unchanged) on each tree, in one process. */
function validateTrees(trees: Record<string, unknown>): Record<string, string[]> {
  const url = pathToFileURL(join(TOKENS, 'lib', 'dtcg.mjs')).href;
  const script = `import { validate } from ${JSON.stringify(url)};
let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const out = {};
  for (const [k, t] of Object.entries(JSON.parse(s))) out[k] = validate(t).errors;
  process.stdout.write(JSON.stringify(out));
});`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, input: JSON.stringify(trees), encoding: 'utf8' }));
}

describe('M3/S3.1 L1b — the token validator refuses each defect for its own reason', () => {
  const px = (value: number) => ({ value, unit: 'px' });
  const rgb = (components: number[], hex: string) => ({ colorSpace: 'srgb', components, hex });
  // A small tree with every shape the defects need: aliases, a composite, a duration and an override layer.
  const BASE = {
    ref: { color: { $type: 'color', ink: { $value: rgb([0, 0, 0], '#000000') }, paper: { $value: rgb([1, 1, 1], '#ffffff') } } },
    semantic: {
      color: { $type: 'color', text: { $value: '{ref.color.ink}' }, surface: { $value: '{ref.color.paper}' }, accent: { $value: '{ref.color.ink}' } },
      space: { $type: 'dimension', md: { $value: px(8) } },
      motion: { $type: 'duration', fast: { $value: { value: 120, unit: 'ms' } } },
      shadow: { $type: 'shadow', card: { $value: { offsetX: px(0), offsetY: px(1), blur: px(2), spread: px(0), color: '{semantic.color.text}' } } },
    },
    context: { $extensions: { 'com.familista': { overrides: 'semantic' } }, owner: { color: { surface: { $value: '{ref.color.ink}' } } } },
  };
  // A defect is a deep copy of BASE with one edit; the copy is untyped so an edit may add or delete a member.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutate = (f: (t: any) => void): unknown => { const t = JSON.parse(JSON.stringify(BASE)); f(t); return t; };

  // [label, the defect, the exact errors, the reason every one of those errors must give]
  const CASES: [string, unknown, string[], RegExp][] = [
    ['1. a direct cycle: a token that references itself', mutate((t) => { t.semantic.color.text.$value = '{semantic.color.text}'; }), [
      'semantic.color.text: reference loop semantic.color.text → semantic.color.text',
      'semantic.color.text: composite reference loop through {semantic.color.text}',
    ], /reference loop/],
    ['1. a direct cycle: two tokens that reference each other', mutate((t) => { t.semantic.color.text.$value = '{semantic.color.surface}'; t.semantic.color.surface.$value = '{semantic.color.text}'; }), [
      'semantic.color.text: reference loop semantic.color.text → semantic.color.surface → semantic.color.text',
      'semantic.color.text: composite reference loop through {semantic.color.surface}',
      'semantic.color.surface: reference loop semantic.color.surface → semantic.color.text → semantic.color.surface',
      'semantic.color.surface: composite reference loop through {semantic.color.text}',
    ], /reference loop/],
    ['2. an indirect cycle through three tokens', mutate((t) => { t.semantic.color.text.$value = '{semantic.color.surface}'; t.semantic.color.surface.$value = '{semantic.color.accent}'; t.semantic.color.accent.$value = '{semantic.color.text}'; }), [
      'semantic.color.text: reference loop semantic.color.text → semantic.color.surface → semantic.color.accent → semantic.color.text',
      'semantic.color.text: composite reference loop through {semantic.color.surface}',
      'semantic.color.surface: reference loop semantic.color.surface → semantic.color.accent → semantic.color.text → semantic.color.surface',
      'semantic.color.surface: composite reference loop through {semantic.color.accent}',
      'semantic.color.accent: reference loop semantic.color.accent → semantic.color.text → semantic.color.surface → semantic.color.accent',
      'semantic.color.accent: composite reference loop through {semantic.color.text}',
    ], /reference loop/],
    // A colour that points back at the shadow whose colour it is. DTCG types every member, so a loop
    // through a composite always also mistypes one reference: both reasons are asserted, nothing else.
    ['3. a cycle through a composite token', mutate((t) => { t.semantic.color.text.$value = '{semantic.shadow.card}'; }), [
      'semantic.color.text: reference {semantic.shadow.card} is shadow, expected color',
      'semantic.color.text: composite reference loop through {semantic.shadow.card}',
      'semantic.shadow.card: composite reference loop through {semantic.color.text}',
    ], /composite reference loop|is shadow, expected color/],
    ['4. an unresolved reference', mutate((t) => { t.semantic.color.text.$value = '{ref.color.missing}'; }), [
      'semantic.color.text: reference {ref.color.missing} does not resolve',
    ], /does not resolve/],
    ['5. an unsupported $type', mutate((t) => { t.semantic.space.$type = 'spacing'; }), [
      'semantic.space.md: unsupported $type "spacing"',
    ], /unsupported \$type/],
    ['5. a reference to a token of the wrong type', mutate((t) => { t.semantic.color.text.$value = '{semantic.space.md}'; }), [
      'semantic.color.text: reference {semantic.space.md} is dimension, expected color',
    ], /is dimension, expected color/],
    ['6. a dimension in a unit the platform does not use', mutate((t) => { t.semantic.space.md.$value = { value: 8, unit: 'pt' }; }), [
      'semantic.space.md: dimension must be { value: number, unit: px|rem }',
    ], /unit: px\|rem/],
    // The validator reuses its dimension check for durations, so the message says "dimension"; the unit list is the duration's.
    ['6. a duration in a unit that is not time', mutate((t) => { t.semantic.motion.fast.$value = { value: 120, unit: 'px' }; }), [
      'semantic.motion.fast: dimension must be { value: number, unit: ms|s }',
    ], /unit: ms\|s/],
    // With no base there is nothing to inherit a $type from, so that is reported too, for the same token.
    ['7. an override with no base token', mutate((t) => { t.context.owner.color.ghost = { $value: '{ref.color.ink}' }; }), [
      'context.owner.color.ghost: re-declares semantic.color.ghost, which does not exist',
      'context.owner.color.ghost: no $type on the token or any ancestor group',
    ], /^context\.owner\.color\.ghost: (re-declares semantic\.color\.ghost, which does not exist|no \$type)/],
    ['7. an override layer that names no base at all', mutate((t) => { delete t.context.$extensions; }), [
      'context: override layer has no $extensions["com.familista"].overrides',
      'context.owner.color.surface: no $type on the token or any ancestor group',
    ], /override layer has no|^context\.owner\.color\.surface: no \$type/],
  ];

  const real = JSON.parse(readFileSync(join(TOKENS, 'familista.tokens.json'), 'utf8'));
  const errors = validateTrees({ base: BASE, real, ...Object.fromEntries(CASES.map(([label, tree]) => [label, tree])) });

  it('control: the defect-free tree and the real token source both validate with no error', () => {
    expect(errors.base).toEqual([]);
    expect(errors.real).toEqual([]);
  });

  it.each(CASES)('%s', (label, _tree, expected, reason) => {
    expect(errors[label]).toEqual(expected);
    for (const e of errors[label]) expect(e).toMatch(reason);
  });

  it('runs the same defects to the same errors every time', () => {
    expect(validateTrees(Object.fromEntries(CASES.map(([label, tree]) => [label, tree])))).toEqual(
      Object.fromEntries(CASES.map(([label]) => [label, errors[label]])));
  });
});
