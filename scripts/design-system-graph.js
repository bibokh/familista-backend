// Familista — the Design System graph builder (Stage 3.2.1, Visual Explorer).
//
// Called by scripts/design-system-discover.js, which writes
// src/design-system/generated/design-system-graph.json beside the Stage 3.1
// manifest and checks both with --check.
//
// Three views, and only three. Every node and every edge is read from a file in
// this repository and names it; nothing is inferred, and a relationship the
// files do not state is not drawn. The shape rules, the layout and the
// validator are src/design-system/graph-core.js, shared with the server.
//
//   token-architecture        tools/tokens/familista.tokens.json   MEASURED
//   legacy-to-canonical       tools/tokens/legacy-map.json         RECORDED
//   stylesheets-to-surfaces   the pages' <link> tags and the built
//                             assets directory                      MEASURED
//                             (the on-demand list is a person's     RECORDED
//                             declaration in production.mjs)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const core = require('../src/design-system/graph-core.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const M = 'MEASURED';
const R = 'RECORDED';

/** "equal ×2, diverges ×1" — a count per label, most first, ties by name. */
function tally(items) {
  const n = new Map();
  for (const i of items) n.set(i, (n.get(i) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + ' ×' + v).join(', ');
}

// ── view 1: reference → semantic → contexts and modules ─────────────────────

function tokenArchitecture({ dtcg, tokens, overrides, layersOut }) {
  const nodes = [];
  const edges = new Map();
  const ids = new Set();
  const add = (n) => { nodes.push(n); ids.add(n.id); };
  const tokenProps = (t, extra) => ({
    cssName: dtcg.cssName(t.path, 'fam'),
    type: t.type,
    value: dtcg.resolvedCss(tokens, t.path),
    ...(extra || {}),
  });

  const list = [...tokens.values()];
  for (const t of list) {
    const parts = t.path.split('.');
    if (parts[0] === 'ref') {
      add({
        id: t.path, kind: 'reference',
        label: parts.slice(parts[1] === 'color' ? 2 : 1).join('.'),
        group: parts.slice(1, -1).join('.') || parts[1],
        evidence: M, source: { id: 'tokens', locator: t.path },
        props: tokenProps(t, { description: t.description || null }),
      });
    }
  }
  for (const t of list) {
    const parts = t.path.split('.');
    if (parts[0] === 'semantic') {
      add({
        id: t.path, kind: 'semantic', label: parts.slice(1).join('.'), group: parts[1],
        evidence: M, source: { id: 'tokens', locator: t.path },
        props: tokenProps(t, { aliasOf: dtcg.isRef(t.value) ? dtcg.refPath(t.value) : null, productionVariable: t.ext.source || null }),
      });
    }
  }
  for (const l of layersOut) {
    if (l.layer !== 'context' && l.layer !== 'module') continue;
    add({
      id: l.layer + '.' + l.variant, kind: l.layer, label: l.variant, group: l.layer,
      evidence: M, source: { id: 'tokens', locator: l.layer + '.' + l.variant },
      props: {
        tokens: l.tokenCount, reDeclares: l.base || null, isDefault: l.isDefault,
        appliesOn: l.selectors.length ? l.selectors.join(', ') : null,
      },
    });
  }

  const edge = (from, to, kind, locator, count, props) => {
    const id = from + ' > ' + to + ' : ' + kind;
    const prev = edges.get(id);
    if (prev) { prev.count += count; return; }
    edges.set(id, { id, kind, from, to, evidence: M, source: { id: 'tokens', locator }, count, props: props || {} });
  };

  // A base token whose value is a reference to another token.
  for (const t of list) {
    const root = t.path.split('.')[0];
    if (root !== 'semantic' || !dtcg.isRef(t.value)) continue;
    const to = dtcg.refPath(t.value);
    if (!ids.has(to)) throw new Error(t.path + ' references ' + to + ', which is not a drawn token');
    edge(to, t.path, 'alias', t.path + ' → ' + to, 1);
  }
  // A context or module re-declares a semantic token, and may do it by reference.
  for (const l of overrides) {
    if (l.layer !== 'context' && l.layer !== 'module') continue;
    const variantId = l.layer + '.' + l.variant;
    const firstOf = new Map();
    for (const e of l.entries) {
      if (!ids.has(e.basePath)) throw new Error(e.path + ' re-declares ' + e.basePath + ', which is not a token');
      edge(e.basePath, variantId, 'override', e.path, 1);
      const t = tokens.get(e.path);
      if (dtcg.isRef(t.value)) {
        const from = dtcg.refPath(t.value);
        if (!ids.has(from)) throw new Error(e.path + ' references ' + from + ', which is not a drawn token');
        if (!firstOf.has(from)) firstOf.set(from, e.path);
        edge(from, variantId, 'alias', firstOf.get(from), 1);
      }
    }
  }
  return {
    nodes, edges: [...edges.values()],
    notes: ['The theme, language, direction and media layers are not drawn in this view.'],
  };
}

// ── view 2: legacy CSS variables → canonical tokens ─────────────────────────

function legacyToCanonical({ dtcg, tokens, legacy }) {
  const byName = new Map();
  for (const e of legacy.entries) {
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const targets = new Set(legacy.entries.filter((e) => e.target).map((e) => e.target));
  const nodes = [];

  for (const [name, entries] of byName) {
    nodes.push({
      id: 'legacy:' + name, kind: 'legacy', label: name, group: entries[0].category || 'uncategorised',
      evidence: R, source: { id: 'legacy-map', locator: name },
      props: {
        declarations: entries.length,
        files: new Set(entries.map((e) => e.file)).size,
        verdicts: tally(entries.map((e) => e.status)),
        surfaces: [...new Set(entries.map((e) => e.surface))].sort().join(', '),
        mapped: entries.some((e) => !!e.target),
      },
    });
  }
  for (const t of tokens.values()) {
    if (!targets.has(t.path)) continue;
    const parts = t.path.split('.');
    nodes.push({
      id: t.path, kind: 'semantic', label: parts.slice(1).join('.'), group: parts[1],
      evidence: M, source: { id: 'tokens', locator: t.path },
      props: {
        cssName: dtcg.cssName(t.path, 'fam'), type: t.type, value: dtcg.resolvedCss(tokens, t.path),
        aliasOf: dtcg.isRef(t.value) ? dtcg.refPath(t.value) : null, productionVariable: t.ext.source || null,
      },
    });
  }
  for (const target of targets) if (!tokens.has(target)) throw new Error('the legacy map names ' + target + ', which is not a token');

  const pairs = new Map();
  for (const e of legacy.entries) {
    if (!e.target) continue;
    const id = 'legacy:' + e.name + ' > ' + e.target + ' : maps-to';
    if (!pairs.has(id)) pairs.set(id, { from: 'legacy:' + e.name, to: e.target, rows: [] });
    pairs.get(id).rows.push(e);
  }
  const edges = [...pairs].map(([id, p]) => ({
    id, kind: 'maps-to', from: p.from, to: p.to, evidence: R,
    source: { id: 'legacy-map', locator: p.rows[0].name + ' → ' + p.to },
    count: p.rows.length,
    props: {
      declarations: p.rows.length,
      verdicts: tally(p.rows.map((r) => r.status)),
      variants: tally(p.rows.map((r) => r.variant || 'base')),
    },
  }));
  return {
    nodes, edges,
    notes: ['A legacy variable mapped to several tokens is drawn once, beside its first token; its other mappings are the edges that cross.'],
  };
}

// ── view 3: stylesheets → production surfaces ───────────────────────────────

function stylesheetsToSurfaces({ ROOT, cssInv, loads }) {
  const nodes = [];
  const edges = [];
  const sheets = new Map();
  const facts = [];

  for (const s of loads) {
    nodes.push({
      id: 'surface:' + s.id, kind: 'surface', label: s.label, group: 'surface',
      evidence: M, source: { id: 'surface-loads', locator: s.origin },
      props: { how: s.via, listedIn: s.origin, stylesheets: s.files.length },
    });
  }
  const sheetNodes = [];
  for (const s of loads) {
    s.files.forEach((file, i) => {
      const key = cssInv.fileKeyOf(file);
      if (!sheets.has(key)) {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const rel = key.replace(/^public\//, '');
        sheets.set(key, true);
        const dir = path.posix.dirname(rel);
        sheetNodes.push({
          id: 'css:' + key, kind: 'stylesheet', label: rel, group: dir === '.' ? 'public' : dir,
          evidence: M, source: { id: 'surface-loads', locator: key },
          props: {
            customProperties: cssInv.scanCustomProperties(text).length,
            canonicalTokenCss: key === 'public/tokens/familista-tokens.css',
          },
        });
        facts.push([key, cssInv.scanCustomProperties(text).length]);
      }
      edges.push({
        id: 'css:' + key + ' > surface:' + s.id + ' : loaded-by', kind: 'loaded-by', from: 'css:' + key, to: 'surface:' + s.id,
        evidence: s.via === 'declared' ? R : M,
        source: { id: 'surface-loads', locator: s.origin + ' → ' + key },
        count: 1, props: { loadOrder: i + 1, how: s.via },
      });
    });
  }
  return {
    nodes: sheetNodes.concat(nodes), edges,
    facts: { loads: loads.map((s) => ({ id: s.id, via: s.via, origin: s.origin, files: s.files.map(cssInv.fileKeyOf) })), sheets: facts },
    notes: ['A stylesheet that two pages load is drawn once, with an edge to each.'],
  };
}

// ── the manifest ────────────────────────────────────────────────────────────

/**
 * Format: the skeleton indented, one node or edge per line. Reviewable in a
 * diff, and a third of the size of full indentation.
 */
function stringify(value, level) {
  level = level || 0;
  if (level >= 4 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = ' '.repeat(level + 1), end = ' '.repeat(level);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[\n' + value.map((v) => pad + stringify(v, level + 1)).join(',\n') + '\n' + end + ']';
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => pad + JSON.stringify(k) + ': ' + stringify(value[k], level + 1)).join(',\n') + '\n' + end + '}';
}

async function buildGraph(ctx) {
  const { ROOT, tokenFile, mapFile } = ctx;
  const cssInv = await import(pathToFileURL(path.join(ROOT, 'tools', 'tokens', 'lib', 'css-inventory.mjs')).href);
  const production = await import(pathToFileURL(path.join(ROOT, 'tools', 'tokens', 'lib', 'production.mjs')).href);
  const loads = production.surfaceLoads();
  const full = { ...ctx, cssInv, loads };

  const built = {
    'token-architecture': tokenArchitecture(full),
    'legacy-to-canonical': legacyToCanonical(full),
    'stylesheets-to-surfaces': stylesheetsToSurfaces(full),
  };

  const loadFacts = JSON.stringify(built['stylesheets-to-surfaces'].facts);
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const file = (id, p, label) => {
    const buf = fs.readFileSync(p);
    return { id, path: rel(p), label, sha256: sha(buf), bytes: buf.length, basis: 'file' };
  };
  const sources = [
    file('tokens', tokenFile, 'The canonical token source (W3C DTCG)'),
    file('legacy-map', mapFile, 'Every custom property production declares, mapped to a token'),
    {
      id: 'surface-loads', path: 'tools/tokens/lib/production.mjs',
      label: 'The stylesheets each production page loads (its link tags, the built assets and the on-demand list)',
      sha256: sha(Buffer.from(loadFacts)), bytes: Buffer.byteLength(loadFacts), basis: 'derived',
    },
  ];

  const views = core.VIEW_IDS.map((id) => {
    const spec = core.VIEW_SPECS[id];
    const b = built[id];
    const view = {
      id, title: spec.title, summary: spec.summary, flow: spec.flow, sources: spec.sources,
      notes: b.notes, columns: [], parked: null, layout: null, stats: null,
      nodes: b.nodes, edges: b.edges,
    };
    return core.layoutView(view);
  });

  const graph = {
    schema: core.SCHEMA,
    generator: 'scripts/design-system-discover.js',
    description: 'The relationships the Design System Control Visual Explorer draws, each read from a repository file. Generated; do not edit.',
    sources,
    views,
  };
  const problems = core.validateGraph(graph);
  if (problems.length) throw new Error('the design-system graph is malformed:\n  ' + problems.slice(0, 20).join('\n  '));
  return graph;
}

module.exports = { buildGraph, stringify };
