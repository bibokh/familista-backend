#!/usr/bin/env node
// Every Stage 2a guarantee, checked in one place. Used by the Jest ratchet
// (tests/design-tokens.unit.test.ts) and runnable on its own.
//   node tools/tokens/scripts/verify.mjs                    human summary, exit 1 on any failure
//   node tools/tokens/scripts/verify.mjs --json             machine-readable result
//   node tools/tokens/scripts/verify.mjs --write-contrast-baseline
//                                                           record today's contrast failures

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, withVariants, resolvedCss, isRef, overrideLayers } from '../lib/dtcg.mjs';
import { scanCustomProperties } from '../lib/css-inventory.mjs';
import { inventoryProduction } from '../lib/production.mjs';
import { checkLegacyMap, contrastPairs, newContrastFailures } from '../lib/checks.mjs';
import { generate } from './build.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'));
const tree = read('familista.tokens.json');
const target = read('targets/web.json');
const BASELINE = join(HERE, 'contrast-baseline.json');

const checks = [];
const check = (id, fn) => {
  try { const detail = fn(); checks.push({ id, pass: !detail || !detail.length, detail: detail || [] }); }
  catch (e) { checks.push({ id, pass: false, detail: [String(e && e.message || e)] }); }
};

const { tokens, errors } = validate(tree);

check('dtcg-valid: every token is well-formed, every reference resolves, no reference loops', () => errors);

check('layering: reference tokens hold raw values; semantic colours reference the palette', () => {
  const bad = [];
  for (const t of tokens.values()) {
    if (t.path.startsWith('ref.') && /"\{[^"{}]+\}"/.test(JSON.stringify(t.value))) bad.push(`${t.path} is a reference token but references ${JSON.stringify(t.value)}`);
    if (t.path.startsWith('semantic.') && t.type === 'color' && !isRef(t.value)) bad.push(`${t.path} holds a raw colour; semantic colours must reference ref.color.*`);
  }
  return bad;
});

const built = generate();
check('deterministic: two builds are byte-identical and match the committed dist file', () => {
  const again = generate().css;
  const bad = [];
  if (again !== built.css) bad.push('two builds of the same source differ');
  if (!existsSync(built.out)) bad.push('dist/familista-tokens.css is missing');
  else if (readFileSync(built.out, 'utf8') !== built.css) bad.push('dist/familista-tokens.css is stale — run node tools/tokens/scripts/build.mjs');
  return bad;
});

check('namespace: the generated CSS declares only --fam-* custom properties, on bound selectors only', () => {
  const css = built.css;
  const bad = [];
  const decls = scanCustomProperties(css);
  const bodyDecls = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[{;]\s*[^{};]+:[^{};]+(?=;)/g) || [];
  for (const d of bodyDecls) if (!/^[{;]\s*--fam-[a-z0-9-]+\s*:/.test(d)) bad.push(`non --fam-* declaration: ${d.slice(1).trim().slice(0, 80)}`);
  for (const d of decls) if (!d.name.startsWith('--' + target.prefix + '-')) bad.push(`${d.name} is outside the --fam-* namespace`);
  const allowed = new Set([target.root]);
  for (const layer of Object.values(target.selectors)) for (const b of Object.values(layer)) for (const s of (b.selector || b)) allowed.add(s);
  for (const d of decls) for (const s of d.selector.split(',').map((x) => x.trim())) if (!allowed.has(s)) bad.push(`unexpected selector ${s}`);
  const atRules = new Set(decls.flatMap((d) => d.atRules));
  for (const a of atRules) if (a !== '@media (prefers-reduced-motion: reduce)') bad.push(`unexpected at-rule ${a}`);
  return bad;
});

const inv = inventoryProduction();
const map = read('legacy-map.json');
const mapResult = checkLegacyMap(map, inv, tree);
check('inventory: the legacy map covers every production custom property with its exact live value', () => {
  const bad = [...mapResult.errors];
  if (inv.unassigned.length) bad.push(`stylesheets no production page loads: ${inv.unassigned.join(', ')}`);
  return bad;
});

check('undefined names stay undefined: no stylesheet and no token declares them', () => {
  const bad = [];
  const recorded = map.undefinedNames.css.map((u) => u.name).sort();
  const now = inv.undefinedRefs.map((u) => u.name).sort();
  if (recorded.join() !== now.join()) bad.push(`undefined CSS names changed: recorded [${recorded.join(' ')}] now [${now.join(' ')}] — review, then inventory.mjs --write`);
  const recordedJs = map.undefinedNames.appJs.map((u) => u.name).sort();
  const nowJs = inv.undefinedInAppJs.map((u) => u.name).sort();
  if (recordedJs.join() !== nowJs.join()) bad.push(`undefined app.js names changed: recorded [${recordedJs.join(' ')}] now [${nowJs.join(' ')}]`);
  const declaredInDist = new Set(scanCustomProperties(built.css).map((d) => d.name));
  const declaredInProd = new Set(inv.declarations.map((d) => d.name));
  for (const n of [...recorded, ...recordedJs]) {
    if (declaredInDist.has(n)) bad.push(`${n} is declared by the generated token CSS`);
    if (declaredInProd.has(n)) bad.push(`${n} is now declared in production`);
  }
  return bad;
});

const pairs = contrastPairs(tree);
if (process.argv.includes('--write-contrast-baseline')) {
  const failures = pairs.filter((p) => p.role !== 'exempt' && !p.pass).map((p) => p.id);
  writeFileSync(BASELINE, JSON.stringify({
    $description: 'WCAG 2.2 contrast of every Familista token pair, recorded at Stage 2a. Live values are preserved, so known failures are recorded rather than fixed; the ratchet fails on any failure not listed here. Fixing one is a Stage 3 visual change that needs approval.',
    thresholds: { text: 4.5, ui: 3, exempt: 'recorded, not enforced (disabled text)' },
    failures, pairs,
  }, null, 1) + '\n');
}
check('contrast: no failure beyond the recorded baseline', () => {
  if (!existsSync(BASELINE)) return ['contrast-baseline.json is missing'];
  return newContrastFailures(pairs, JSON.parse(readFileSync(BASELINE, 'utf8'))).map((p) => `new failure: ${p.id} = ${p.ratio}:1 (needs ${p.required}:1)`);
});

check('arabic: every tracking step resolves to 0 under :lang(ar)', () => {
  const view = withVariants(tree, tokens, { lang: 'ar' });
  const steps = [...tokens.keys()].filter((p) => p.startsWith('semantic.font.tracking.'));
  const bad = steps.filter((p) => resolvedCss(view, p) !== '0').map((p) => `${p} = ${resolvedCss(view, p)} under :lang(ar)`);
  const arBlock = scanCustomProperties(built.css).filter((d) => d.selector === ':lang(ar)');
  for (const p of steps) {
    const name = '--fam-' + p.slice('semantic.'.length).split('.').join('-');
    const d = arBlock.find((x) => x.name === name);
    if (!d || d.value !== '0') bad.push(`generated CSS does not set ${name}: 0 under :lang(ar)`);
  }
  if (!steps.length) bad.push('no tracking tokens');
  return bad;
});

check('arabic: Noto Sans Arabic is in the sans stack and leads the Arabic stack', () => {
  const sans = tokens.get('semantic.font.family.sans').value;
  const ar = tokens.get('semantic.font.family.arabic').value;
  const bad = [];
  if (!sans.includes('Noto Sans Arabic')) bad.push('semantic.font.family.sans has no Noto Sans Arabic fallback');
  if (sans[0] !== 'Inter') bad.push('Inter must lead the sans stack (Latin digits stay consistent)');
  if (ar[0] !== 'Noto Sans Arabic') bad.push('semantic.font.family.arabic must start with Noto Sans Arabic');
  return bad;
});

check('rtl: direction multiplier is -1 under dir="rtl"', () => {
  const v = resolvedCss(withVariants(tree, tokens, { dir: 'rtl' }), 'semantic.direction.multiplier');
  return v === '-1' ? [] : [`multiplier under rtl is ${v}`];
});

check('reduced motion: every duration is 0ms under prefers-reduced-motion', () => {
  const view = withVariants(tree, tokens, { media: 'reduced-motion' });
  return [...tokens.keys()].filter((p) => p.startsWith('semantic.duration.')).filter((p) => resolvedCss(view, p) !== '0ms').map((p) => `${p} = ${resolvedCss(view, p)}`);
});

check('themes: light and high contrast are reserved layers with bound selectors', () => {
  const themes = overrideLayers(tree, tokens).filter((l) => l.layer === 'theme');
  const bad = [];
  for (const id of ['light', 'high-contrast']) if (!themes.some((t) => t.variant === id)) bad.push(`theme.${id} is missing`);
  return bad;
});

const layerStats = {};
for (const t of tokens.values()) {
  const s = t.path.split('.');
  const layer = s[0] === 'ref' || s[0] === 'semantic' ? s[0] : 'override:' + s[0];
  const cat = s[0] === 'ref' ? s[1] : s[0] === 'semantic' ? s[1] : s[1];
  layerStats[layer] = layerStats[layer] || { total: 0, byGroup: {} };
  layerStats[layer].total++;
  layerStats[layer].byGroup[cat] = (layerStats[layer].byGroup[cat] || 0) + 1;
}
const result = {
  pass: checks.every((c) => c.pass), checks,
  stats: {
    tokens: tokens.size, layers: layerStats, generatedCssBytes: built.css.length,
    generatedDeclarations: scanCustomProperties(built.css).length,
    legacyMap: mapResult.stats,
    contrast: { pairs: pairs.length, failing: pairs.filter((p) => p.role !== 'exempt' && !p.pass).length, exempt: pairs.filter((p) => p.role === 'exempt').length },
    undefinedNames: { css: map.undefinedNames.css.length, appJs: map.undefinedNames.appJs.length },
  },
};
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1));
else {
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id}`);
    for (const d of c.detail.slice(0, 20)) console.log('      ' + d);
  }
  console.log(`\n${result.pass ? 'all checks pass' : 'FAILED'} — ${tokens.size} tokens, ${mapResult.stats.entries} legacy declarations, ${pairs.length} contrast pairs`);
}
process.exit(result.pass ? 0 : 1);
