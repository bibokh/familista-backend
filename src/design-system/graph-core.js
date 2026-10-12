// Familista Design System Control — the graph core (Stage 3.2.1, Visual Explorer).
//
// Plain JavaScript, no dependency, shared by three readers so they can never
// disagree about what a well-formed graph is:
//
//   scripts/design-system-graph.js   builds the graph and calls layoutView()
//   src/design-system/design-system.service.ts   calls validateGraph() before
//                                    it serves a single node
//   tests/design-system-graph.unit.test.ts       the same two, as evidence
//
// (The same pattern as src/algorithms/fingerprint-core.js.)
//
// WHAT A GRAPH IS HERE
//
// A view is a set of nodes and edges, every one of which names the repository
// file it came from (`source.id`, `source.locator`) and how it is known
// (`evidence`: MEASURED, computed from the files; RECORDED, a person's
// classification committed to the repository). A relationship that has no
// source, whose endpoints do not exist, or that this table does not allow
// between those two kinds of node is rejected — it is never drawn, and never
// repaired. Nothing is inferred.
//
// LAYOUT
//
// Computed here, once, at generation time, from the data alone: no random
// number, no clock, no measurement of the browser. The same files always give
// the same coordinates, so the manifest is reproducible byte for byte and the
// client never lays anything out.
'use strict';

const SCHEMA = 1;

const NODE_W = 188;
const NODE_H = 22;
const ROW = 28;          // pitch between two nodes in a column
const GROUP_GAP = 14;    // extra space where a group ends
const COL_GAP = 168;     // space between two columns
const PANEL_GAP = 72;    // space between two panels of the cluster layout
const LINK_GAP = 96;     // legacy → canonical distance inside one panel
const PAD = 40;          // margin around everything
const HEAD = 34;         // room above a column for its heading
const PARK_GAP = 72;     // space between the graph and its unconnected nodes
const PARK_HEAD = 30;
const LANE_ROWS = 34;     // a column taller than this is split into lanes side by side
const LANE_GAP = 12;

/**
 * The only three views, and for each the only things that may exist in it.
 * Adding a relationship means adding a row here, in review, with its evidence.
 */
const VIEW_SPECS = {
  'token-architecture': {
    title: 'Token architecture',
    summary: 'Reference tokens feed semantic tokens, and both feed the contexts and modules that re-declare them.',
    flow: ['Reference tokens', 'Semantic tokens', 'Contexts and modules'],
    strategy: 'layered',
    columns: [
      { id: 'reference', label: 'Reference tokens', kinds: ['reference'], anchor: true },
      { id: 'semantic', label: 'Semantic tokens', kinds: ['semantic'], anchor: false },
      { id: 'variant', label: 'Contexts and modules', kinds: ['context', 'module'], anchor: true },
    ],
    edges: [
      { kind: 'alias', from: ['reference', 'semantic'], to: ['semantic', 'context', 'module'] },
      { kind: 'override', from: ['semantic'], to: ['context', 'module'] },
    ],
    sources: ['tokens'],
  },
  'legacy-to-canonical': {
    title: 'Legacy to canonical',
    summary: 'Every custom property production declares, and the canonical token a person mapped it to.',
    flow: ['Legacy CSS variables', 'Canonical tokens'],
    strategy: 'clusters',
    columns: [
      { id: 'legacy', label: 'Legacy CSS variables', kinds: ['legacy'], anchor: false },
      { id: 'canonical', label: 'Canonical tokens', kinds: ['semantic'], anchor: true },
    ],
    edges: [{ kind: 'maps-to', from: ['legacy'], to: ['semantic'] }],
    sources: ['tokens', 'legacy-map'],
  },
  'stylesheets-to-surfaces': {
    title: 'Stylesheets to surfaces',
    summary: 'Which stylesheets each production page loads.',
    flow: ['Stylesheets', 'Production surfaces'],
    strategy: 'layered',
    columns: [
      { id: 'stylesheet', label: 'Stylesheets', kinds: ['stylesheet'], anchor: false },
      { id: 'surface', label: 'Production surfaces', kinds: ['surface'], anchor: true },
    ],
    edges: [{ kind: 'loaded-by', from: ['stylesheet'], to: ['surface'] }],
    sources: ['surface-loads'],
  },
};

const VIEW_IDS = Object.keys(VIEW_SPECS);
const EVIDENCE = ['MEASURED', 'RECORDED'];
const NODE_KINDS = ['reference', 'semantic', 'context', 'module', 'legacy', 'stylesheet', 'surface'];
const EDGE_KINDS = ['alias', 'override', 'maps-to', 'loaded-by'];

const MAX_ID = 240;
const MAX_TEXT = 400;
const MAX_PROPS = 14;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= (max || MAX_TEXT);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function columnIndexOf(spec, kind) {
  for (let i = 0; i < spec.columns.length; i++) if (spec.columns[i].kinds.indexOf(kind) >= 0) return i;
  return -1;
}

// ── layout ──────────────────────────────────────────────────────────────────

/** Group order, then the order the nodes arrived in (the source files' own). */
function seqOf(nodes) {
  const seq = new Map();
  nodes.forEach((n, i) => seq.set(n.id, i));
  return seq;
}

function adjacency(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
  return adj;
}

/**
 * Order one column. Anchored columns keep the order of their source file (a
 * taxonomy: colour families and steps, groups of semantic tokens). A free
 * column orders whole groups by where their neighbours already sit, and keeps
 * each group contiguous; inside a group it keeps the source order, or, for a
 * flat list, orders by neighbour position.
 */
function orderColumn(nodes, seq, adj, placed, anchored) {
  const groups = new Map();
  for (const n of nodes) {
    if (!groups.has(n.group)) groups.set(n.group, []);
    groups.get(n.group).push(n);
  }
  const posOf = (n) => {
    const ps = [];
    for (const id of adj.get(n.id)) if (placed.has(id)) ps.push(placed.get(id));
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
  };
  const list = [...groups.entries()].map(([g, members]) => {
    const withPos = members.map((m) => ({ m, p: posOf(m) }));
    const known = withPos.filter((x) => x.p !== null);
    const gp = known.length ? known.reduce((a, x) => a + x.p, 0) / known.length : Infinity;
    return { g, members, withPos, gp, first: Math.min.apply(null, members.map((m) => seq.get(m.id))) };
  });
  if (!anchored) list.sort((a, b) => (a.gp - b.gp) || (a.first - b.first) || (a.g < b.g ? -1 : a.g > b.g ? 1 : 0));
  else list.sort((a, b) => a.first - b.first);
  const out = [];
  for (const grp of list) {
    const inner = grp.withPos.slice();
    if (!anchored && grp.members.length > 1 && inner.every((x) => x.p !== null)) {
      inner.sort((a, b) => (a.p - b.p) || (seq.get(a.m.id) - seq.get(b.m.id)));
    } else {
      inner.sort((a, b) => seq.get(a.m.id) - seq.get(b.m.id));
    }
    for (const x of inner) out.push(x.m);
  }
  return out;
}

/** y offsets for an ordered column, with a gap wherever the group changes. */
function stack(ordered) {
  let y = 0, last = null;
  const ys = [];
  for (const n of ordered) {
    if (last !== null && n.group !== last) y += GROUP_GAP;
    ys.push(y);
    y += ROW;
    last = n.group;
  }
  return { ys, height: ordered.length ? y - (ROW - NODE_H) : 0 };
}

/** Unconnected nodes sit in a grid below the graph, so hiding them moves nothing. */
function park(nodes, top, width) {
  const per = Math.max(1, Math.floor((width - 2 * PAD + 14) / (NODE_W + 14)));
  const ordered = nodes.slice();
  ordered.forEach((n, i) => {
    n.x = PAD + (i % per) * (NODE_W + 14);
    n.y = top + PARK_HEAD + Math.floor(i / per) * ROW;
  });
  const rows = Math.ceil(ordered.length / per);
  return { rows, height: PARK_HEAD + rows * ROW };
}

function layeredLayout(view, spec, connected, isolated, seq, adj) {
  const cols = spec.columns.map(() => []);
  for (const n of connected) cols[columnIndexOf(spec, n.kind)].push(n);

  // Each column is ordered, then split into lanes if it is tall, so a column of
  // sixty nodes becomes two of thirty and the graph keeps a sensible shape.
  const placed = new Map(); // node id → height within its column, 0..1
  const lay = spec.columns.map(() => null);
  const place = (ci, anchored) => {
    const ordered = orderColumn(cols[ci], seq, adj, placed, anchored);
    const lanes = ordered.length > LANE_ROWS ? Math.ceil(ordered.length / LANE_ROWS) : 1;
    const per = Math.max(1, Math.ceil(ordered.length / lanes));
    const ys = [], laneOf = [];
    let height = 0;
    for (let l = 0; l < lanes; l++) {
      const slice = ordered.slice(l * per, (l + 1) * per);
      const st = stack(slice);
      st.ys.forEach((y) => { ys.push(y); laneOf.push(l); });
      height = Math.max(height, st.height);
    }
    ordered.forEach((n, i) => placed.set(n.id, height ? ys[i] / height : 0.5));
    lay[ci] = { ordered, lanes, ys, laneOf, height, width: lanes * NODE_W + (lanes - 1) * LANE_GAP };
  };
  spec.columns.forEach((c, ci) => { if (c.anchor) place(ci, true); });
  spec.columns.forEach((c, ci) => { if (!c.anchor) place(ci, false); });

  const tallest = Math.max.apply(null, lay.map((l) => l.height).concat([0]));
  let x = PAD;
  const columns = spec.columns.map((c, ci) => {
    const l = lay[ci];
    const offset = Math.round((tallest - l.height) / 2);
    l.ordered.forEach((n, i) => { n.x = x + l.laneOf[i] * (NODE_W + LANE_GAP); n.y = PAD + HEAD + offset + l.ys[i]; });
    const col = { id: c.id, label: c.label, x, y: PAD, w: l.width, count: l.ordered.length };
    x += l.width + COL_GAP;
    return col;
  });
  const width = x - COL_GAP + PAD;
  return { columns, width, height: PAD + HEAD + tallest + PAD };
}

/**
 * Many-to-one mapping (388 legacy names onto 100 tokens): a column pair would
 * be a hairball. Each canonical token takes the legacy names that map to it as
 * a stack beside it; clusters are packed into panels. A legacy name mapped to
 * several tokens stays with its first, and its other edges cross panels.
 */
function clusterLayout(view, spec, connected, isolated, seq) {
  const canon = connected.filter((n) => n.kind === 'semantic').sort((a, b) => seq.get(a.id) - seq.get(b.id));
  const byId = new Map(connected.map((n) => [n.id, n]));
  const home = new Map(); // legacy id → canonical id
  const stacks = new Map(canon.map((c) => [c.id, []]));
  const legacy = connected.filter((n) => n.kind === 'legacy').sort((a, b) => seq.get(a.id) - seq.get(b.id));
  const first = new Map();
  for (const e of view.edges) {
    const prev = first.get(e.from);
    if (prev === undefined || seq.get(e.to) < seq.get(prev)) first.set(e.from, e.to);
  }
  for (const l of legacy) { const t = first.get(l.id); if (t && byId.has(t)) { home.set(l.id, t); stacks.get(t).push(l); } }

  // Pack clusters into panels of about equal height.
  const clusters = canon.map((c) => ({ c, rows: Math.max(1, stacks.get(c.id).length) }));
  const total = clusters.reduce((a, k) => a + k.rows, 0);
  const panelW = NODE_W * 2 + LINK_GAP;
  const panels = Math.max(1, Math.round(Math.sqrt((1.6 * total * ROW) / panelW)));
  const target = Math.ceil(total / panels);
  const packed = [[]];
  let rows = 0;
  for (const k of clusters) {
    if (rows > 0 && rows + k.rows > target * 1.12 && packed.length < panels) { packed.push([]); rows = 0; }
    packed[packed.length - 1].push(k);
    rows += k.rows;
  }

  const columns = [];
  let tallest = 0;
  const heights = [];
  packed.forEach((panel) => {
    let h = 0, last = null;
    for (const k of panel) { if (last !== null && k.c.group !== last) h += GROUP_GAP; h += k.rows * ROW; last = k.c.group; }
    heights.push(h - (ROW - NODE_H));
    tallest = Math.max(tallest, h - (ROW - NODE_H));
  });
  let x = PAD;
  packed.forEach((panel, pi) => {
    const lx = x, cx = x + NODE_W + LINK_GAP;
    let y = PAD + HEAD + Math.round((tallest - heights[pi]) / 2), last = null;
    for (const k of panel) {
      if (last !== null && k.c.group !== last) y += GROUP_GAP;
      stacks.get(k.c.id).forEach((l, i) => { l.x = lx; l.y = y + i * ROW; });
      k.c.x = cx;
      k.c.y = y + Math.round(((k.rows - 1) * ROW) / 2);
      y += k.rows * ROW;
      last = k.c.group;
    }
    // The panels repeat one pattern: only the first is headed, with the totals.
    if (pi === 0) {
      columns.push({ id: 'legacy', label: spec.columns[0].label, x: lx, y: PAD, w: NODE_W, count: legacy.filter((l) => home.has(l.id)).length });
      columns.push({ id: 'canonical', label: spec.columns[1].label, x: cx, y: PAD, w: NODE_W, count: canon.length });
    }
    x += panelW + PANEL_GAP;
  });
  const width = x - PANEL_GAP + PAD;
  return { columns, width, height: PAD + HEAD + tallest + PAD };
}

/**
 * Assign x, y, w, h to every node, and the view its `columns`, `layout` and
 * `stats`. Mutates and returns the view. Deterministic.
 */
function layoutView(view) {
  const spec = VIEW_SPECS[view.id];
  if (!spec) throw new Error('unknown view ' + view.id);
  const seq = seqOf(view.nodes);
  const adj = adjacency(view.nodes, view.edges);
  const connected = [], isolated = [];
  for (const n of view.nodes) (adj.get(n.id).length ? connected : isolated).push(n);
  for (const n of view.nodes) { n.w = NODE_W; n.h = NODE_H; n.isolated = adj.get(n.id).length === 0; }

  const base = spec.strategy === 'clusters'
    ? clusterLayout(view, spec, connected, isolated, seq)
    : layeredLayout(view, spec, connected, isolated, seq, adj);

  let height = base.height;
  const width = Math.max(base.width, 2 * PAD + NODE_W);
  let parked = null;
  if (isolated.length) {
    const top = base.height - PAD + PARK_GAP;
    const p = park(isolated.sort((a, b) => seq.get(a.id) - seq.get(b.id)), top, width);
    parked = { x: PAD, y: top, w: width - 2 * PAD, count: isolated.length };
    height = top + p.height + PAD;
  }
  view.columns = base.columns;
  view.parked = parked;
  view.layout = { strategy: spec.strategy, width, height, nodeW: NODE_W, nodeH: NODE_H };
  view.stats = statsOf(view);
  return view;
}

function statsOf(view) {
  const count = (list, key) => {
    const out = {};
    for (const i of list) out[key(i)] = (out[key(i)] || 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  return {
    nodes: view.nodes.length,
    edges: view.edges.length,
    isolated: view.nodes.filter((n) => n.isolated).length,
    nodesByKind: count(view.nodes, (n) => n.kind),
    edgesByKind: count(view.edges, (e) => e.kind),
    nodesByEvidence: count(view.nodes, (n) => n.evidence),
    edgesByEvidence: count(view.edges, (e) => e.evidence),
  };
}

// ── validation ──────────────────────────────────────────────────────────────

function validProps(props, where, problems) {
  if (!isObj(props)) { problems.push(where + ': props must be an object'); return; }
  const keys = Object.keys(props);
  if (keys.length > MAX_PROPS) problems.push(where + ': more than ' + MAX_PROPS + ' props');
  for (const k of keys) {
    const v = props[k];
    const ok = v === null || typeof v === 'boolean' || isNum(v) || (typeof v === 'string' && v.length <= MAX_TEXT);
    if (!k || k.length > 60 || !ok) problems.push(where + ': prop "' + k + '" is not a short scalar');
  }
}

function validateSource(src, sourceIds, where, problems) {
  if (!isObj(src) || !isText(src.id, MAX_ID) || !isText(src.locator, MAX_TEXT)) {
    problems.push(where + ': has no source {id, locator}');
    return;
  }
  if (!sourceIds.has(src.id)) problems.push(where + ': source "' + src.id + '" is not a listed source');
}

/**
 * Every problem with one view, as strings. An empty array is a well-formed
 * view. Nothing is repaired: the caller refuses the whole manifest.
 */
function validateView(view, sourceIds) {
  const problems = [];
  const spec = VIEW_SPECS[view && view.id];
  if (!spec) return ['unknown view "' + (view && view.id) + '"'];
  const p = (m) => problems.push(view.id + ': ' + m);
  if (view.title !== spec.title || view.summary !== spec.summary) p('title or summary differs from the view table');
  if (JSON.stringify(view.flow) !== JSON.stringify(spec.flow)) p('flow differs from the view table');
  if (JSON.stringify(view.sources) !== JSON.stringify(spec.sources)) p('sources differ from the view table');
  for (const id of spec.sources) if (!sourceIds.has(id)) p('source "' + id + '" is not listed');
  if (!Array.isArray(view.nodes) || !Array.isArray(view.edges)) { p('nodes and edges must be arrays'); return problems; }

  const byId = new Map();
  view.nodes.forEach((n, i) => {
    const w = 'node #' + i;
    if (!isObj(n) || !isText(n.id, MAX_ID)) { p(w + ' has no id'); return; }
    if (byId.has(n.id)) { p('node id "' + n.id + '" is used twice'); return; }
    byId.set(n.id, n);
    const at = 'node "' + n.id + '"';
    if (NODE_KINDS.indexOf(n.kind) < 0) p(at + ' has unknown kind "' + n.kind + '"');
    else if (columnIndexOf(spec, n.kind) < 0) p(at + ' is a ' + n.kind + ', which this view does not draw');
    if (!isText(n.label, MAX_ID) || !isText(n.group, MAX_ID)) p(at + ' needs a label and a group');
    if (EVIDENCE.indexOf(n.evidence) < 0) p(at + ' has no evidence state');
    validateSource(n.source, sourceIds, at, problems);
    validProps(n.props, at, problems);
    for (const k of ['x', 'y', 'w', 'h']) if (!isNum(n[k])) p(at + ' has no ' + k);
    if (typeof n.isolated !== 'boolean') p(at + ' has no isolated flag');
  });

  const seen = new Set();
  const degree = new Map(view.nodes.map((n) => [n && n.id, 0]));
  view.edges.forEach((e, i) => {
    const w = 'edge #' + i;
    if (!isObj(e) || !isText(e.id, MAX_ID)) { p(w + ' has no id'); return; }
    if (seen.has(e.id)) { p('edge id "' + e.id + '" is used twice'); return; }
    seen.add(e.id);
    const at = 'edge "' + e.id + '"';
    if (EDGE_KINDS.indexOf(e.kind) < 0) { p(at + ' has unknown kind'); return; }
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) { p(at + ' joins a node that does not exist'); return; }
    if (e.from === e.to) p(at + ' joins a node to itself');
    const rule = spec.edges.filter((r) => r.kind === e.kind && r.from.indexOf(a.kind) >= 0 && r.to.indexOf(b.kind) >= 0)[0];
    if (!rule) p(at + ' (' + e.kind + ') is not allowed from a ' + a.kind + ' to a ' + b.kind + ' in this view');
    if (columnIndexOf(spec, a.kind) > columnIndexOf(spec, b.kind)) p(at + ' runs against the flow of the view');
    if (e.id !== e.from + ' > ' + e.to + ' : ' + e.kind) p(at + ' id is not from > to : kind');
    if (EVIDENCE.indexOf(e.evidence) < 0) p(at + ' has no evidence state');
    if (!Number.isInteger(e.count) || e.count < 1) p(at + ' has no count');
    validateSource(e.source, sourceIds, at, problems);
    validProps(e.props, at, problems);
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  });
  view.nodes.forEach((n) => { if (n && byId.has(n.id) && (degree.get(n.id) === 0) !== n.isolated) p('node "' + n.id + '" isolated flag is wrong'); });

  // Layout: finite, inside the canvas, and no two nodes on one another.
  const L = view.layout;
  if (!isObj(L) || !isNum(L.width) || !isNum(L.height) || !isNum(L.nodeW) || !isNum(L.nodeH)) p('layout is missing');
  else {
    const list = view.nodes.filter((n) => isObj(n) && ['x', 'y', 'w', 'h'].every((k) => isNum(n[k])));
    for (const n of list) {
      if (n.x < 0 || n.y < 0 || n.x + n.w > L.width || n.y + n.h > L.height) p('node "' + n.id + '" lies outside the canvas');
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { p('nodes "' + a.id + '" and "' + b.id + '" overlap'); break; }
      }
    }
  }
  const expect = statsOf(view);
  if (JSON.stringify(view.stats) !== JSON.stringify(expect)) p('stats do not match the nodes and edges');
  if (!Array.isArray(view.columns) || !view.columns.length) p('columns are missing');
  if (!Array.isArray(view.notes)) p('notes must be an array');
  return problems;
}

/** The whole graph manifest. Returns every problem found; [] means well-formed. */
function validateGraph(graph) {
  if (!isObj(graph)) return ['the graph manifest is not an object'];
  const problems = [];
  if (graph.schema !== SCHEMA) problems.push('the graph manifest is not schema ' + SCHEMA);
  if (!Array.isArray(graph.sources) || !Array.isArray(graph.views)) return problems.concat('sources and views must be arrays');
  const ids = new Set();
  for (const s of graph.sources) {
    if (!isObj(s) || !isText(s.id, 80) || !isText(s.path) || !isText(s.label) || !/^[0-9a-f]{64}$/.test(s.sha256 || '')
      || !Number.isInteger(s.bytes) || s.bytes < 0 || ['file', 'derived'].indexOf(s.basis) < 0) problems.push('a source is malformed');
    else if (ids.has(s.id)) problems.push('source "' + s.id + '" is listed twice');
    else ids.add(s.id);
  }
  const seen = new Set();
  for (const v of graph.views) {
    if (seen.has(v && v.id)) problems.push('view "' + v.id + '" is listed twice');
    seen.add(v && v.id);
    for (const m of validateView(v, ids)) problems.push(m);
  }
  if (JSON.stringify([...seen]) !== JSON.stringify(VIEW_IDS)) problems.push('the views must be exactly: ' + VIEW_IDS.join(', '));
  return problems;
}

module.exports = {
  SCHEMA, VIEW_SPECS, VIEW_IDS, NODE_KINDS, EDGE_KINDS, EVIDENCE,
  NODE_W, NODE_H, ROW,
  layoutView, validateView, validateGraph, statsOf,
};
