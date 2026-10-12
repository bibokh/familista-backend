#!/usr/bin/env node
// Familista — Design System manifest generator (Stage 3.1).
//
// Reads the Design Core (tools/tokens/) and writes
// src/design-system/generated/design-system-manifest.json, the evidence the
// Owner-only Design System Control room shows. Nothing here is typed in: every
// figure is counted or computed from a file in this repository, and every
// source is listed with its SHA-256 so a reader can see what was read.
//
//   node scripts/design-system-discover.js          write the manifest
//   node scripts/design-system-discover.js --check  exit 1 if the committed one is stale
//
// Stage 3.2.1 adds a second generated file from the same run,
// src/design-system/generated/design-system-graph.json (the relationships the
// Visual Explorer draws; scripts/design-system-graph.js builds it, and
// src/design-system/graph-core.js validates and lays it out). --check compares
// both, and fails if either is stale.
//
// Stage 3.2.2 adds a third, src/design-system/generated/design-system-components.json
// (the Components Registry, verified against the repository; built by
// scripts/design-system-components.js from tools/components/registry.json and
// validated by src/design-system/components-core.js). --check covers all three.
//
// Deterministic by construction: no timestamp, no host, no environment value;
// sources and tokens are sorted or kept in token-file order. Running it twice
// on the same tree produces the same bytes.
//
// Evidence states, used by the room exactly as the Algorithms room uses them:
//   MEASURED     counted or computed from the files, here, now
//   RECORDED     a person's classification committed to the repository
//                (the legacy map's verdicts, the contrast baseline)
//   UNAVAILABLE  the platform does not keep it — drawn as "—", never as 0
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { buildGraph, stringify } = require('./design-system-graph.js');
const components = require('./design-system-components.js');

const ROOT = path.resolve(__dirname, '..');
const TOKENS = path.join(ROOT, 'tools', 'tokens');
const OUT = path.join(ROOT, 'src', 'design-system', 'generated', 'design-system-manifest.json');
const GRAPH_OUT = path.join(ROOT, 'src', 'design-system', 'generated', 'design-system-graph.json');
const COMPONENTS_OUT = path.join(ROOT, 'src', 'design-system', 'generated', 'design-system-components.json');
const SCHEMA = 1;

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const imp = (f) => import(pathToFileURL(path.join(TOKENS, 'lib', f)).href);

function count(items, key) {
  const out = {};
  for (const i of items) out[key(i)] = (out[key(i)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function listFiles(dir, re, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'storybook-static') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listFiles(p, re, acc);
    else if (re.test(name)) acc.push(p);
  }
  return acc;
}

async function build() {
  const dtcg = await imp('dtcg.mjs');
  const checks = await imp('checks.mjs');
  const cssInv = await imp('css-inventory.mjs');

  const tokenFile = path.join(TOKENS, 'familista.tokens.json');
  const targetFile = path.join(TOKENS, 'targets', 'web.json');
  const distFile = path.join(TOKENS, 'dist', 'familista-tokens.css');
  const pubFile = path.join(ROOT, 'public', 'tokens', 'familista-tokens.css');
  const mapFile = path.join(TOKENS, 'legacy-map.json');
  const baseFile = path.join(TOKENS, 'contrast-baseline.json');

  const tree = JSON.parse(read(tokenFile).toString('utf8'));
  const target = JSON.parse(read(targetFile).toString('utf8'));
  const legacy = JSON.parse(read(mapFile).toString('utf8'));
  const baseline = JSON.parse(read(baseFile).toString('utf8'));
  const dist = read(distFile);
  const published = read(pubFile);

  const { tokens } = dtcg.validate(tree);
  const prefix = target.prefix;
  const layerOf = (p) => p.split('.')[0];
  const refCss = (p) => `var(${dtcg.cssName(p, prefix)})`;

  // ── tokens ────────────────────────────────────────────────────────────────
  // An override token is named after the base token it re-declares.
  const overrideBase = new Map();
  for (const l of dtcg.overrideLayers(tree, tokens)) for (const e of l.entries) overrideBase.set(e.path, e.basePath);
  const list = [...tokens.values()].map((t) => {
    const layer = layerOf(t.path);
    const aliasOf = dtcg.isRef(t.value) ? dtcg.refPath(t.value) : null;
    return {
      path: t.path,
      cssName: dtcg.cssName(overrideBase.get(t.path) || t.path, prefix),
      layer,
      type: t.type,
      declared: dtcg.toCss(t.type, t.value, t.ext, refCss),
      resolved: dtcg.resolvedCss(tokens, t.path),
      aliasOf,
      description: t.description || null,
      source: t.ext.source || null,
    };
  });

  const layers = dtcg.overrideLayers(tree, tokens).map((l) => {
    const sel = (target.selectors[l.layer] || {})[l.variant];
    const selectors = Array.isArray(sel) ? sel : sel && sel.selector ? sel.selector : [];
    return {
      layer: l.layer, variant: l.variant, base: l.base || null, isDefault: l.isDefault,
      description: l.description || null, tokenCount: l.entries.length,
      selectors: [...selectors].sort(),
      media: sel && sel.media ? sel.media : null,
    };
  });

  // ── contrast (computed from the tokens; the baseline is a recorded list) ──
  const pairs = checks.contrastPairs(tree);
  const known = new Set(baseline.failures);
  const contrast = pairs.map((p) => ({
    id: p.id, context: p.context, module: p.module, fg: p.fg, bg: p.bg, role: p.role,
    ratio: p.ratio, required: p.required, pass: p.pass, baseline: known.has(p.id),
  }));
  const failing = contrast.filter((p) => p.role !== 'exempt' && !p.pass);

  // ── css ───────────────────────────────────────────────────────────────────
  const decls = cssInv.scanCustomProperties(dist.toString('utf8'));

  // ── legacy map (a person's classification, committed) ─────────────────────
  const legacyStatus = count(legacy.entries, (e) => e.status);

  // ── storybook (files counted, never "stories": a story is an export) ──────
  const sbDir = path.join(ROOT, 'tools', 'storybook', 'stories');
  const storyFiles = listFiles(sbDir, /\.stories\.js$/);
  const foundationFiles = storyFiles.filter((f) => rel(f).includes('/stories/foundations/'));

  const sources = [
    ['tokens', tokenFile, 'The canonical token source (W3C DTCG)'],
    ['web-target', targetFile, 'The web binding: prefix, selectors, version'],
    ['token-css', distFile, 'Generated token CSS (dist)'],
    ['token-css-published', pubFile, 'The copy production serves'],
    ['legacy-map', mapFile, 'Every custom property production declares, mapped to a token'],
    ['contrast-baseline', baseFile, 'Contrast failures recorded at Stage 2a'],
  ].map(([id, p, label]) => ({ id, path: rel(p), label, sha256: sha(read(p)), bytes: read(p).length }));

  const m = (value, source, extra) => ({ state: 'MEASURED', value, source, ...(extra || {}) });
  const r = (value, source, extra) => ({ state: 'RECORDED', value, source, ...(extra || {}) });

  const overview = {
    tokens: {
      total: m(list.length, 'tokens'),
      byLayer: m(count(list, (t) => t.layer), 'tokens'),
      byType: m(count(list, (t) => t.type), 'tokens'),
    },
    css: {
      prefix,
      version: target.version,
      declarations: m(decls.length, 'token-css'),
      bytes: m(dist.length, 'token-css'),
      publishedIdentical: m(Buffer.compare(dist, published) === 0, 'token-css-published'),
    },
    contexts: m(layers.filter((l) => l.layer === 'context').length, 'tokens'),
    modules: m(layers.filter((l) => l.layer === 'module').length, 'tokens'),
    legacyMap: {
      declarations: m(legacy.entries.length, 'legacy-map'),
      byStatus: r(legacyStatus, 'legacy-map'),
      undefinedNames: r({ css: legacy.undefinedNames.css.length, appJs: legacy.undefinedNames.appJs.length }, 'legacy-map'),
    },
    contrast: {
      pairs: m(contrast.length, 'tokens'),
      byRole: m(count(contrast, (p) => p.role), 'tokens'),
      failing: m(failing.length, 'tokens'),
      newFailures: m(failing.filter((p) => !p.baseline).length, 'contrast-baseline'),
      baselineFailures: r(baseline.failures.length, 'contrast-baseline'),
      thresholds: r(baseline.thresholds, 'contrast-baseline'),
    },
    storybook: {
      storyFiles: m(storyFiles.length, 'tools/storybook/stories'),
      foundationFiles: m(foundationFiles.length, 'tools/storybook/stories/foundations'),
    },
    unavailable: [
      { id: 'component-adoption', reason: 'No record of which production screens use which shared component or token is kept; production reads no --fam-* token yet.' },
      { id: 'test-results', reason: 'Test and Storybook results are produced by CI per run and are not stored in the repository.' },
      { id: 'runtime-accessibility', reason: 'Runtime accessibility audits are not recorded; only token-pair contrast is computed here.' },
      { id: 'usage-telemetry', reason: 'No design-system usage telemetry exists.' },
    ],
  };

  const graph = await buildGraph({
    ROOT, dtcg, tokens, tokenFile, mapFile, legacy,
    overrides: dtcg.overrideLayers(tree, tokens), layersOut: layers,
  });

  return { manifest: {
    schema: SCHEMA,
    generator: 'scripts/design-system-discover.js',
    description: 'Evidence for the Owner-only Design System Control room, derived from tools/tokens. Generated; do not edit.',
    sources,
    overview,
    layers,
    tokens: list,
    contrast,
  }, graph, components: components.build({ ROOT }) };
}

(async () => {
  const built = await build();
  const outputs = [
    [OUT, JSON.stringify(built.manifest, null, 1) + '\n', 'manifest'],
    [GRAPH_OUT, stringify(built.graph) + '\n', 'graph manifest'],
    [COMPONENTS_OUT, stringify(built.components) + '\n', 'components manifest'],
  ];
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, text]) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== text);
    for (const [file, , label] of stale) console.error('[design-system] ' + label + ' is stale (' + rel(file) + ') — run: node scripts/design-system-discover.js');
    if (stale.length) process.exit(1);
    console.log('[design-system] manifest, graph manifest and components manifest are current');
    return;
  }
  for (const [file, text] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log('[design-system] wrote ' + rel(file) + ' (' + text.length + ' bytes)');
  }
})().catch((e) => { console.error(e); process.exit(1); });
