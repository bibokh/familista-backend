/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — VISUAL EXPLORER — Stage 3.2.1

   THE RELATIONSHIPS BETWEEN THE PARTS OF THE DESIGN SYSTEM, DRAWN FROM THE
   FILES THAT STATE THEM

   Loaded on demand by public/design-system/design-system.js, the first time the
   platform owner opens the Visual Explorer section — never by the page, never
   by Owner Home. It draws one of three graphs the server generated from the
   repository (src/design-system/generated/design-system-graph.json) and serves
   read-only at /system/design-system/graph:

     Token architecture        reference → semantic → contexts and modules
     Legacy to canonical       legacy CSS variables → canonical tokens
     Stylesheets to surfaces   stylesheets → the pages that load them

   READ-ONLY, AND NOTHING INFERRED

   There is no control here that changes a token, a stylesheet or a theme. Every
   node and every edge arrives with the file it was read from and how it is
   known (Measured, or Recorded by a person); a relationship the files do not
   state is not on the screen. The layout is not computed here either: the
   server places every node once, deterministically, so the same files always
   draw the same picture and this file only moves a camera over it.

   ACCESSIBILITY

   Colour is never the only signal: every kind of node has its own shape, every
   column its own heading, every kind of edge its own line, and Recorded
   evidence has a dashed outline. The graph is keyboard-operable (arrows move
   between nodes, Enter selects, Shift+arrows pan, + − 0 zoom and fit), the
   zoom has buttons, and the Table view lists exactly the same nodes and
   relationships for a screen reader. Motion respects prefers-reduced-motion.

   This file paints with the canonical --fam-* tokens and declares none of its
   own. It writes no style attribute and no inline handler; positions are SVG
   attributes and states are classes, so the page's Content-Security-Policy is
   untouched.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var K = null;                 // the room's kit: T, tf, esc, num, ltr, code, chip, evChip, api, emptyState, skeleton
  function T(s) { return K.T(s); }
  function tf() { return K.tf.apply(null, arguments); }
  function esc(s) { return K.esc(s); }
  function num(n) { return K.num(n); }
  function code(s) { return K.code(s); }

  var KMIN = 0.05, KMAX = 3.5;

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // A shape and a heading for every kind, so colour is never the only signal.
  // tone a/b/c are the first three categorical chart tokens, in the order a
  // value flows; n is neutral text colour.

  var GLYPH = {
    circle: 'M-5,0a5,5 0 1,0 10,0a5,5 0 1,0 -10,0z',
    square: 'M-4.5,-4.5h9v9h-9z',
    diamond: 'M0,-6L6,0L0,6L-6,0z',
    hexagon: 'M-3,-5.2L3,-5.2L6,0L3,5.2L-3,5.2L-6,0z',
    triangle: 'M0,-5.5L5.5,4.5L-5.5,4.5z',
    page: 'M-4,-5.5h5.5l2.5,2.5v8.5h-8z',
    ring: 'M-5.5,0a5.5,5.5 0 1,0 11,0a5.5,5.5 0 1,0 -11,0zM-2.5,0a2.5,2.5 0 1,1 5,0a2.5,2.5 0 1,1 -5,0z',
  };
  var KIND = {
    reference: { label: 'Reference token', glyph: 'circle', tone: 'a' },
    semantic: { label: 'Semantic token', glyph: 'square', tone: 'b' },
    context: { label: 'Context', glyph: 'diamond', tone: 'c' },
    module: { label: 'Module', glyph: 'hexagon', tone: 'c' },
    legacy: { label: 'Legacy variable', glyph: 'triangle', tone: 'n' },
    stylesheet: { label: 'Stylesheet', glyph: 'page', tone: 'n' },
    surface: { label: 'Production surface', glyph: 'ring', tone: 'c' },
  };
  var EDGE = {
    alias: { label: 'Alias', meaning: 'The target takes its value from the source token.' },
    override: { label: 'Override', meaning: 'The context or module re-declares the source token.' },
    'maps-to': { label: 'Maps to', meaning: 'A person mapped the legacy variable to this canonical token.' },
    'loaded-by': { label: 'Loaded by', meaning: 'The page links or loads this stylesheet.' },
  };
  var PROP = {
    cssName: 'CSS name', type: 'Type', value: 'Value', description: 'Description', aliasOf: 'Alias of',
    productionVariable: 'Production variable', tokens: 'Tokens re-declared', reDeclares: 'Re-declares', isDefault: 'Default',
    appliesOn: 'Applies on', declarations: 'Declarations', files: 'Files', verdicts: 'Verdicts', surfaces: 'Surfaces',
    mapped: 'Mapped', variants: 'Variants', how: 'How it is found', listedIn: 'Listed in', stylesheets: 'Stylesheets',
    customProperties: 'Custom properties declared', canonicalTokenCss: 'Canonical token CSS',
    loadOrder: 'Load order',
  };
  var HOW = {
    link: 'A link tag in the page',
    directory: 'Every stylesheet in the built assets',
    declared: 'Named in tools/tokens/lib/production.mjs',
  };
  var VIEW_TAB = { 'token-architecture': 'Token architecture', 'legacy-to-canonical': 'Legacy to canonical', 'stylesheets-to-surfaces': 'Stylesheets to surfaces' };
  var VIEW_ORDER = ['token-architecture', 'legacy-to-canonical', 'stylesheets-to-surfaces'];
  var BASIS = { file: 'Read from the file', derived: 'Derived from the files' };

  // ── state ─────────────────────────────────────────────────────────────────

  function fresh() {
    return {
      index: null, indexError: null,
      models: Object.create(null), errors: Object.create(null), loading: Object.create(null),
      viewId: 'token-architecture',
      sel: null,                          // { type: 'node' | 'edge', id }
      q: '', hideKind: Object.create(null), hideEv: Object.create(null), group: 'all', isolated: false,
      focus: false, hops: 1, mode: 'graph', tab: 'nodes',
      cam: { k: 1, tx: 0, ty: 0 }, fitted: true, popOpen: false,
      matches: [], matchAt: -1, hiddenMatches: 0, rove: null,
    };
  }
  var S = fresh();
  var R = { crumbs: '', host: null, root: null, stage: null, canvas: null, svg: null, camG: null, scene: null, insp: null, live: null, ro: null, raf: 0, tween: 0 };
  var M = { drawMs: null, stateMs: null, fitMs: null, lastLoadMs: null, nodes: 0, edges: 0, domNodes: 0, bytes: null };

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function reduced() { try { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rtl() { return K && K.dir() === 'rtl'; }
  function model() { return S.models[S.viewId] || null; }
  function sourceOf(id) {
    var list = (S.index && S.index.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ── the model: lookups built once per view ────────────────────────────────

  function buildModel(view) {
    var m = {
      view: view, node: Object.create(null), edge: Object.create(null), out: Object.create(null), inn: Object.create(null),
      text: Object.create(null), seq: Object.create(null), groups: [], kinds: [], evidence: [],
      nodeEl: Object.create(null), edgeEl: Object.create(null), cls: Object.create(null),
      vis: null, visEdge: null, near: null, vbox: null, nVisible: 0, eVisible: 0,
    };
    view.nodes.forEach(function (n, i) {
      m.node[n.id] = n; m.out[n.id] = []; m.inn[n.id] = []; m.seq[n.id] = i;
      var t = [n.label, n.id, n.group];
      for (var k in n.props) if (n.props[k] !== null && typeof n.props[k] !== 'boolean') t.push(String(n.props[k]));
      m.text[n.id] = t.join(' ').toLowerCase();
      if (m.groups.indexOf(n.group) < 0) m.groups.push(n.group);
      if (m.kinds.indexOf(n.kind) < 0) m.kinds.push(n.kind);
      if (m.evidence.indexOf(n.evidence) < 0) m.evidence.push(n.evidence);
    });
    view.edges.forEach(function (e) {
      m.edge[e.id] = e;
      if (m.out[e.from]) m.out[e.from].push(e);
      if (m.inn[e.to]) m.inn[e.to].push(e);
    });
    return m;
  }

  // ── loading ───────────────────────────────────────────────────────────────

  function loadIndex() {
    return K.api('/system/design-system/graph').then(function (d) {
      var missing = ['state', 'sources', 'views'].filter(function (k) { return !d || d[k] === undefined || d[k] === null; });
      if (missing.length) { S.index = null; S.indexError = K.contractError('/system/design-system/graph', missing); return; }
      S.index = d; S.indexError = null;
    }).catch(function (e) { S.index = null; S.indexError = e.message; });
  }
  function loadView(id) {
    if (S.models[id] || S.loading[id]) return S.loading[id] || Promise.resolve();
    var t0 = now();
    S.loading[id] = K.api('/system/design-system/graph?view=' + encodeURIComponent(id)).then(function (d) {
      var missing = ['state', 'view'].filter(function (k) { return !d || d[k] === undefined; });
      if (missing.length) { S.errors[id] = K.contractError('/system/design-system/graph?view=' + id, missing); return; }
      if (d.state !== 'READY' || !d.view) { S.errors[id] = d.reason || T('The graph could not be read'); return; }
      S.models[id] = buildModel(d.view); delete S.errors[id];
      M.lastLoadMs = Math.round(now() - t0);
    }).catch(function (e) { S.errors[id] = e.message; })
      .then(function () { delete S.loading[id]; });
    return S.loading[id];
  }

  // ── markup ────────────────────────────────────────────────────────────────

  function glyphSvg(kind, cls) {
    var g = KIND[kind] || KIND.reference;
    return '<svg class="ex-gl ex-t-' + g.tone + (cls ? ' ' + cls : '') + '" viewBox="-8 -8 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
      + '<path d="' + GLYPH[g.glyph] + '" fill-rule="evenodd"/></svg>';
  }

  function shellHtml() {
    // Only the views the server lists are offered; before the index arrives, the three approved ones.
    var listed = S.index && S.index.views ? S.index.views.map(function (v) { return v.id; }) : VIEW_ORDER;
    var tabs = VIEW_ORDER.filter(function (id) { return listed.indexOf(id) >= 0; }).map(function (id) {
      var on = S.viewId === id;
      return '<button class="ds-tab ex-view' + (on ? ' is-on' : '') + '" type="button" role="tab" id="ex-tab-' + id + '"'
        + ' aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '" data-ex-view="' + id + '">' + esc(T(VIEW_TAB[id])) + '</button>';
    }).join('');
    return '<div class="ex">'
      + '<div class="ex-bar"><div class="ds-tabs ex-views" role="tablist" aria-label="' + esc(T('Graph views')) + '">' + tabs + '</div>'
      + '<div class="ex-tools">'
      + '<label class="ex-search"><span class="ds-sr">' + esc(T('Search the graph')) + '</span>'
      + '<input class="ds-input ex-q" id="ex-q" type="search" autocomplete="off" spellcheck="false" value="' + esc(S.q) + '" placeholder="' + esc(T('Search the graph')) + '"></label>'
      + '<span class="ex-hits" id="ex-hits" role="status" aria-live="polite"></span>'
      + '<div class="ex-popwrap"><button class="ds-btn ex-btn" type="button" id="ex-filters-b" data-ex-filters aria-haspopup="true" aria-expanded="false" aria-controls="ex-pop">'
      + esc(T('Filters')) + '<span class="ex-badge" id="ex-badge" hidden></span></button>'
      + '<div class="ex-pop" id="ex-pop" role="group" aria-label="' + esc(T('Filters')) + '"></div></div>'
      + '<button class="ds-btn ex-btn" type="button" id="ex-focus" data-ex-focus aria-pressed="false">' + esc(T('Focus neighbourhood')) + '</button>'
      + '<div class="ds-seg ex-hops" role="group" aria-label="' + esc(T('Neighbourhood depth')) + '">'
      + '<button class="ds-seg-b" type="button" data-ex-hops="1" aria-pressed="true">' + esc(T('1 hop')) + '</button>'
      + '<button class="ds-seg-b" type="button" data-ex-hops="2" aria-pressed="false">' + esc(T('2 hops')) + '</button></div>'
      + '<div class="ds-seg ex-modes" role="group" aria-label="' + esc(T('Display')) + '">'
      + '<button class="ds-seg-b is-on" type="button" data-ex-mode="graph" aria-pressed="true">' + esc(T('Graph')) + '</button>'
      + '<button class="ds-seg-b" type="button" data-ex-mode="table" aria-pressed="false">' + esc(T('Table')) + '</button></div>'
      + '</div></div>'
      + '<div class="ex-main"><div class="ex-stage" id="ex-stage">'
      + '<div class="ex-canvas" id="ex-canvas">'
      + '<svg class="ex-svg" id="ex-svg" role="group" aria-roledescription="' + esc(T('relationship graph')) + '" aria-describedby="ex-help" focusable="false">'
      + '<defs><marker id="ex-ah" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="ex-ah" d="M0 0L8 4L0 8z"/></marker>'
      + '<marker id="ex-ah-hot" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="ex-ah-hot" d="M0 0L8 4L0 8z"/></marker></defs>'
      + '<g class="ex-cam" id="ex-cam"><g class="ex-scene" id="ex-scene"></g></g></svg>'
      + '<div class="ds-seg ex-over ex-zoom" role="group" aria-label="' + esc(T('Zoom')) + '">'
      + '<button class="ds-seg-b" type="button" data-ex-zoom="out" aria-label="' + esc(T('Zoom out')) + '">−</button>'
      + '<span class="ex-zoomv" id="ex-zoomv" aria-hidden="true">100%</span>'
      + '<button class="ds-seg-b" type="button" data-ex-zoom="in" aria-label="' + esc(T('Zoom in')) + '">+</button>'
      + '<button class="ds-seg-b" type="button" data-ex-zoom="fit">' + esc(T('Fit')) + '</button></div>'
      + '<div class="ex-over ex-crumbs" id="ex-crumbs"></div>'
      + '<div class="ex-over ex-wait" id="ex-wait"></div>'
      + '</div>'
      + '<div class="ex-tablepane" id="ex-tablepane" hidden></div>'
      + '<div class="ex-foot"><div class="ex-legend" id="ex-legend" role="group" aria-label="' + esc(T('Legend')) + '"></div>'
      + '<div class="ex-status" id="ex-status" role="status"></div></div>'
      + '</div>'
      + '<aside class="ex-insp" id="ex-insp" aria-label="' + esc(T('Inspector')) + '"></aside></div>'
      + '<p class="ds-sr" id="ex-help">' + esc(T('Arrow keys move between nodes. Enter selects. Shift with an arrow pans. Plus and minus zoom. Zero fits the graph. Escape clears the selection.')) + '</p>'
      + '<div class="ds-sr" id="ex-live" aria-live="polite" aria-atomic="true"></div>'
      + '</div>';
  }

  function edgePath(a, b) {
    var ay = a.y + a.h / 2, by = b.y + b.h / 2, dx, sx, ex;
    if (b.x >= a.x + a.w + 8) {
      sx = a.x + a.w; dx = Math.max(36, (b.x - sx) * 0.5);
      return 'M' + sx + ' ' + ay + 'C' + (sx + dx) + ' ' + ay + ' ' + (b.x - dx) + ' ' + by + ' ' + b.x + ' ' + by;
    }
    if (b.x + b.w <= a.x - 8) {
      sx = a.x; ex = b.x + b.w; dx = Math.max(36, (sx - ex) * 0.5);
      return 'M' + sx + ' ' + ay + 'C' + (sx - dx) + ' ' + ay + ' ' + (ex + dx) + ' ' + by + ' ' + ex + ' ' + by;
    }
    sx = a.x + a.w; dx = 44 + Math.min(60, Math.abs(by - ay) * 0.12);
    return 'M' + sx + ' ' + ay + 'C' + (sx + dx) + ' ' + ay + ' ' + (sx + dx) + ' ' + by + ' ' + sx + ' ' + by;
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function nodeLabel(n, m) {
    var i = m.inn[n.id].length, o = m.out[n.id].length;
    return n.label + ', ' + T(KIND[n.kind].label) + ', ' + T(n.evidence === 'MEASURED' ? 'Measured' : 'Recorded') + ', '
      + tf('%d incoming, %d outgoing', i, o);
  }

  function sceneHtml(m) {
    var v = m.view, o = [];
    // Many-to-one views repeat one pattern in panels: a single heading over the first, reading left to right.
    var heads = v.layout.strategy === 'clusters' && v.columns.length >= 2
      ? [{ x: v.columns[0].x, y: v.columns[0].y, w: v.columns[1].x + v.columns[1].w - v.columns[0].x,
        label: T(v.columns[0].label) + ' → ' + T(v.columns[1].label), count: num(v.columns[0].count) + ' → ' + num(v.columns[1].count) }]
      : v.columns.map(function (c) { return { x: c.x, y: c.y, w: c.w, label: T(c.label), count: num(c.count) }; });
    heads.forEach(function (c) {
      o.push('<text class="ex-colhead" x="' + c.x + '" y="' + (c.y + 16) + '">' + esc(c.label) + '</text>'
        + '<text class="ex-colcount" x="' + (c.x + c.w) + '" y="' + (c.y + 16) + '" text-anchor="end">' + esc(c.count) + '</text>'
        + '<path class="ex-colrule" d="M' + c.x + ' ' + (c.y + 24) + 'h' + c.w + '"/>');
    });
    if (v.parked) {
      o.push('<g class="ex-park" id="ex-park"><text class="ex-colhead" x="' + v.parked.x + '" y="' + (v.parked.y + 16) + '">'
        + esc(tf('Unconnected · %d', v.parked.count)) + '</text><path class="ex-colrule" d="M' + v.parked.x + ' ' + (v.parked.y + 24) + 'h' + v.parked.w + '"/></g>');
    }
    o.push('<g class="ex-edges" aria-hidden="true">');
    v.edges.forEach(function (e) {
      var a = m.node[e.from], b = m.node[e.to];
      if (!a || !b) return;
      var d = edgePath(a, b);
      o.push('<g class="ex-e ex-e-' + e.kind + (e.evidence === 'RECORDED' ? ' is-rec' : '') + '" data-e="' + esc(e.id) + '">'
        + '<path class="ex-ehit" d="' + d + '"/><path class="ex-eline" d="' + d + '"/></g>');
    });
    o.push('</g><g class="ex-nodes">');
    v.nodes.forEach(function (n) {
      var g = KIND[n.kind];
      o.push('<g class="ex-n ex-k-' + n.kind + ' ex-t-' + g.tone + (n.evidence === 'RECORDED' ? ' is-rec' : '') + '" data-n="' + esc(n.id)
        + '" transform="translate(' + n.x + ' ' + n.y + ')" role="button" tabindex="-1" aria-pressed="false" aria-label="' + esc(nodeLabel(n, m)) + '">'
        + '<rect class="ex-nb" width="' + n.w + '" height="' + n.h + '" rx="6"/>'
        + '<path class="ex-ng" transform="translate(12 ' + (n.h / 2) + ')" d="' + GLYPH[g.glyph] + '" fill-rule="evenodd"/>'
        + '<text class="ex-nt" x="25" y="' + (n.h / 2 + 4) + '">' + esc(trunc(n.label, 23)) + '</text>'
        // A name cut short keeps its full form as a native tooltip.
        + (n.label.length > 23 ? '<title>' + esc(n.label) + '</title>' : '') + '</g>');
    });
    o.push('</g>');
    return o.join('');
  }

  // ── what is visible, and what is dimmed ───────────────────────────────────

  function passes(n) {
    if (S.hideKind[n.kind] || S.hideEv[n.evidence]) return false;
    if (S.group !== 'all' && n.group !== S.group) return false;
    if (!S.isolated && n.isolated) return false;
    return true;
  }
  function selectedNodeIds(m) {
    var ids = Object.create(null);
    if (!S.sel) return ids;
    if (S.sel.type === 'node') { if (m.node[S.sel.id]) ids[S.sel.id] = 1; }
    else { var e = m.edge[S.sel.id]; if (e) { ids[e.from] = 1; ids[e.to] = 1; } }
    return ids;
  }
  /** The selection and its neighbours `hops` away, through edges whose ends pass the filters. */
  function neighbourhood(m, hops, vis) {
    var seen = selectedNodeIds(m), frontier = Object.keys(seen);
    for (var h = 0; h < hops; h++) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var id = frontier[i], list = m.out[id].concat(m.inn[id]);
        for (var j = 0; j < list.length; j++) {
          var o = list[j].from === id ? list[j].to : list[j].from;
          if (!seen[o] && (!vis || vis[o])) { seen[o] = 1; next.push(o); }
        }
      }
      frontier = next;
    }
    return seen;
  }

  function search(m) {
    var terms = S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    S.matches = []; S.hiddenMatches = 0;
    if (!terms.length) { S.matchAt = -1; return null; }
    var hit = Object.create(null);
    m.view.nodes.forEach(function (n) {
      var t = m.text[n.id];
      if (!terms.every(function (x) { return t.indexOf(x) >= 0; })) return;
      if (m.vis[n.id]) { hit[n.id] = 1; S.matches.push(n.id); } else S.hiddenMatches++;
    });
    if (S.matchAt >= S.matches.length) S.matchAt = -1;
    return hit;
  }

  function computeVisible(m) {
    var vis = Object.create(null), visEdge = Object.create(null), n = 0, e = 0;
    m.view.nodes.forEach(function (x) { if (passes(x)) { vis[x.id] = 1; } });
    m.view.edges.forEach(function (x) { if (vis[x.from] && vis[x.to]) visEdge[x.id] = 1; });
    if (S.focus && S.sel) {
      var keep = neighbourhood(m, S.hops, vis);
      Object.keys(vis).forEach(function (id) { if (!keep[id]) delete vis[id]; });
      Object.keys(visEdge).forEach(function (id) { var x = m.edge[id]; if (!vis[x.from] || !vis[x.to]) delete visEdge[id]; });
    }
    m.vis = vis; m.visEdge = visEdge;
    var box = null;
    for (var id in vis) {
      var nd = m.node[id]; n++;
      if (!box) box = { x0: nd.x, y0: nd.y, x1: nd.x + nd.w, y1: nd.y + nd.h };
      else { box.x0 = Math.min(box.x0, nd.x); box.y0 = Math.min(box.y0, nd.y); box.x1 = Math.max(box.x1, nd.x + nd.w); box.y1 = Math.max(box.y1, nd.y + nd.h); }
    }
    for (var eid in visEdge) e++;
    if (box) {
      // Include the column headings when the whole graph is in view, so they are not cropped.
      box.y0 = Math.min(box.y0, m.view.columns.length && !S.focus ? m.view.columns[0].y : box.y0);
      m.vbox = { x: box.x0, y: box.y0, w: Math.max(1, box.x1 - box.x0), h: Math.max(1, box.y1 - box.y0) };
    } else m.vbox = null;
    m.nVisible = n; m.eVisible = e;
  }

  /** Class lists for every node and edge; an element is touched only when its classes changed. */
  function applyState() {
    var m = model(); if (!m || !R.scene) return;
    var t0 = now();
    computeVisible(m);
    var hit = search(m);
    var near = S.sel ? neighbourhood(m, 1, m.vis) : null;
    m.near = near;
    var dimming = !!(near || hit);
    var i, id, cls, el, st;

    for (i = 0; i < m.view.nodes.length; i++) {
      var n = m.view.nodes[i]; id = n.id; el = m.nodeEl[id]; if (!el) continue;
      cls = '';
      if (!m.vis[id]) cls = ' is-hidden';
      else {
        if (dimming && !((near && near[id]) || (hit && hit[id]))) cls += ' is-dim';
        if (hit && hit[id]) cls += ' is-hit';
        if (S.sel && S.sel.type === 'node' && S.sel.id === id) cls += ' is-sel';
        else if (near && near[id]) cls += ' is-near';
      }
      if (m.cls[id] !== cls) {
        m.cls[id] = cls;
        el.setAttribute('class', el.getAttribute('data-base') + cls);
        el.setAttribute('aria-pressed', S.sel && S.sel.type === 'node' && S.sel.id === id ? 'true' : 'false');
        if (cls.indexOf('is-hidden') >= 0) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
      }
    }
    for (i = 0; i < m.view.edges.length; i++) {
      var e = m.view.edges[i]; id = e.id; el = m.edgeEl[id]; if (!el) continue;
      cls = '';
      if (!m.visEdge[id]) cls = ' is-hidden';
      else if (S.sel) {
        var incident = S.sel.type === 'edge' ? S.sel.id === id : (e.from === S.sel.id || e.to === S.sel.id);
        if (S.sel.type === 'edge' && S.sel.id === id) cls = ' is-sel is-near';
        else if (incident) cls = ' is-near';
        else cls = ' is-dim';
      } else if (hit) cls = (hit[e.from] || hit[e.to]) ? ' is-near' : ' is-dim';
      st = m.cls['e:' + id];
      if (st !== cls) { m.cls['e:' + id] = cls; el.setAttribute('class', el.getAttribute('data-base') + cls); }
    }
    var park = R.scene.querySelector('#ex-park');
    if (park) park.setAttribute('class', 'ex-park' + (S.isolated ? '' : ' is-hidden'));

    // The focused rove target must be a visible node.
    if (!S.rove || !m.vis[S.rove]) S.rove = S.sel && S.sel.type === 'node' && m.vis[S.sel.id] ? S.sel.id : firstVisible(m);
    setRove(m, S.rove);
    M.stateMs = Math.round((now() - t0) * 10) / 10;
    renderChrome();
  }

  function firstVisible(m) {
    for (var i = 0; i < m.view.nodes.length; i++) if (m.vis[m.view.nodes[i].id]) return m.view.nodes[i].id;
    return null;
  }
  function setRove(m, id) {
    var prev = R.scene.querySelector('.ex-n[tabindex="0"]');
    if (prev && prev !== m.nodeEl[id]) prev.setAttribute('tabindex', '-1');
    if (id && m.nodeEl[id]) m.nodeEl[id].setAttribute('tabindex', '0');
    S.rove = id;
  }

  // ── camera ────────────────────────────────────────────────────────────────

  // The canvas size is kept by the ResizeObserver, so selecting, searching and
  // filtering never read the layout in the middle of writing to it. It is read
  // only when a view is drawn or the display mode changes (`force`).
  function measure(force) {
    if (!R.canvas) return;
    if (force || !S.size.w || !S.size.h) S.size = { w: R.canvas.clientWidth, h: R.canvas.clientHeight };
  }
  S.size = { w: 0, h: 0 };

  function applyCam() {
    var c = S.cam;
    R.camG.setAttribute('transform', 'translate(' + c.tx.toFixed(2) + ' ' + c.ty.toFixed(2) + ') scale(' + c.k.toFixed(4) + ')');
    var lod = c.k < 0.42 ? 'ex-lod-0' : c.k < 0.75 ? 'ex-lod-1' : 'ex-lod-2';
    if (R.canvas.getAttribute('data-lod') !== lod) {
      R.canvas.setAttribute('data-lod', lod);
      R.canvas.classList.remove('ex-lod-0', 'ex-lod-1', 'ex-lod-2');
      R.canvas.classList.add(lod);
    }
    var z = document.getElementById('ex-zoomv');
    if (z) z.textContent = Math.round(c.k * 100) + '%';
  }
  function clampCam(c) {
    var m = model(); if (!m) return c;
    var L = m.view.layout, keep = 96;
    var x0 = c.tx, x1 = c.tx + L.width * c.k, y0 = c.ty, y1 = c.ty + L.height * c.k;
    var dx = 0, dy = 0;
    if (x1 < keep) dx = keep - x1; else if (x0 > S.size.w - keep) dx = S.size.w - keep - x0;
    if (y1 < keep) dy = keep - y1; else if (y0 > S.size.h - keep) dy = S.size.h - keep - y0;
    return { k: c.k, tx: c.tx + dx, ty: c.ty + dy };
  }
  function setCam(target, animate) {
    if (R.tween) { cancelAnimationFrame(R.tween); R.tween = 0; }
    target = clampCam({ k: clamp(target.k, KMIN, KMAX), tx: target.tx, ty: target.ty });
    if (!animate || reduced()) { S.cam = target; applyCam(); return; }
    var from = { k: S.cam.k, tx: S.cam.tx, ty: S.cam.ty }, t0 = now(), dur = 240;
    (function step() {
      var p = clamp((now() - t0) / dur, 0, 1), e = 1 - Math.pow(1 - p, 3);
      S.cam = { k: from.k + (target.k - from.k) * e, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e };
      applyCam();
      R.tween = p < 1 ? requestAnimationFrame(step) : 0;
    }());
  }
  function fit(animate) {
    var m = model(); if (!m) return;
    measure(false);
    var b = m.vbox; if (!b || !S.size.w || !S.size.h) return;
    var t0 = now(), pad = 40;
    var k = clamp(Math.min((S.size.w - 2 * pad) / b.w, (S.size.h - 2 * pad) / b.h, 1.25), KMIN, KMAX);
    setCam({ k: k, tx: (S.size.w - b.w * k) / 2 - b.x * k, ty: (S.size.h - b.h * k) / 2 - b.y * k }, animate);
    S.fitted = true;
    M.fitMs = Math.round((now() - t0) * 10) / 10;
  }
  function zoomAt(factor, px, py, animate) {
    var c = S.cam, k2 = clamp(c.k * factor, KMIN, KMAX), f = k2 / c.k;
    if (px == null) { px = S.size.w / 2; py = S.size.h / 2; }
    S.fitted = false;
    setCam({ k: k2, tx: px - (px - c.tx) * f, ty: py - (py - c.ty) * f }, animate);
  }
  /** Bring a node into the middle of view if it is off screen (or nearly), keeping the zoom. */
  function reveal(id) {
    var m = model(), n = m && m.node[id]; if (!n) return;
    measure(false);
    var c = S.cam, m2 = 56;
    var x0 = n.x * c.k + c.tx, x1 = (n.x + n.w) * c.k + c.tx, y0 = n.y * c.k + c.ty, y1 = (n.y + n.h) * c.k + c.ty;
    if (x0 >= m2 && x1 <= S.size.w - m2 && y0 >= m2 && y1 <= S.size.h - m2) return;
    var k = Math.max(c.k, 0.8);
    S.fitted = false;
    setCam({ k: k, tx: S.size.w / 2 - (n.x + n.w / 2) * k, ty: S.size.h / 2 - (n.y + n.h / 2) * k }, true);
  }

  // ── chrome: the parts that follow the state ───────────────────────────────

  function activeFilters() {
    var n = 0;
    for (var k in S.hideKind) if (S.hideKind[k]) n++;
    for (var e in S.hideEv) if (S.hideEv[e]) n++;
    if (S.group !== 'all') n++;
    if (S.isolated) n++;
    return n;
  }

  function popHtml(m) {
    var v = m.view, o = [];
    o.push('<div class="ex-pop-sec"><div class="ex-pop-h">' + esc(T('Kinds')) + '</div><div class="ex-pop-row">'
      + m.kinds.map(function (k) {
        var on = !S.hideKind[k];
        return '<button class="ex-tog' + (on ? ' is-on' : '') + '" type="button" data-ex-kind="' + k + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
          + glyphSvg(k) + '<span>' + esc(T(KIND[k].label)) + '</span><span class="ex-tog-n">' + esc(num(v.stats.nodesByKind[k] || 0)) + '</span></button>';
      }).join('') + '</div></div>');
    if (m.evidence.length > 1) {
      o.push('<div class="ex-pop-sec"><div class="ex-pop-h">' + esc(T('How it is known')) + '</div><div class="ex-pop-row">'
        + m.evidence.map(function (ev) {
          var on = !S.hideEv[ev];
          return '<button class="ex-tog' + (on ? ' is-on' : '') + '" type="button" data-ex-ev="' + ev + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
            + '<span>' + esc(T(ev === 'MEASURED' ? 'Measured' : 'Recorded')) + '</span><span class="ex-tog-n">' + esc(num(v.stats.nodesByEvidence[ev] || 0)) + '</span></button>';
        }).join('') + '</div></div>');
    }
    if (m.groups.length > 1) {
      o.push('<div class="ex-pop-sec"><label class="ds-field"><span class="ds-field-l">' + esc(T('Group')) + '</span>'
        + '<select class="ds-input" id="ex-group"><option value="all">' + esc(T('All groups')) + '</option>'
        + m.groups.map(function (g) { return '<option value="' + esc(g) + '"' + (S.group === g ? ' selected' : '') + '>' + esc(g) + '</option>'; }).join('')
        + '</select></label></div>');
    }
    if (v.stats.isolated > 0) {
      o.push('<div class="ex-pop-sec"><button class="ex-tog ex-tog--wide' + (S.isolated ? ' is-on' : '') + '" type="button" data-ex-isolated aria-pressed="' + (S.isolated ? 'true' : 'false') + '">'
        + '<span>' + esc(T('Show nodes with no relationship')) + '</span><span class="ex-tog-n">' + esc(num(v.stats.isolated)) + '</span></button></div>');
    }
    o.push('<div class="ex-pop-sec ex-pop-foot"><button class="ds-btn ex-btn" type="button" data-ex-reset>' + esc(T('Reset filters')) + '</button></div>');
    return o.join('');
  }

  function legendHtml(m) {
    var v = m.view;
    var group = function (title, items) {
      return '<div class="ex-lg-g"><span class="ex-lg-h">' + esc(T(title)) + '</span><ul class="ex-lg-l">' + items + '</ul></div>';
    };
    var kinds = m.kinds.map(function (k) {
      return '<li class="ex-lg-i">' + glyphSvg(k) + '<span>' + esc(T(KIND[k].label)) + '</span></li>';
    }).join('');
    var edges = Object.keys(v.stats.edgesByKind).map(function (k) {
      return '<li class="ex-lg-i"><svg class="ex-lg-line ex-e-' + k + '" width="30" height="10" viewBox="0 0 30 10" aria-hidden="true" focusable="false"><path d="M1 5h28"/></svg><span>' + esc(T(EDGE[k].label)) + '</span></li>';
    }).join('');
    var box = function (cls, label) {
      return '<li class="ex-lg-i"><svg class="ex-lg-box' + cls + '" width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" focusable="false"><rect x="1" y="1" width="20" height="10" rx="3"/></svg><span>' + esc(T(label)) + '</span></li>';
    };
    var ev = box('', 'Measured')
      + (m.evidence.indexOf('RECORDED') >= 0 || v.stats.edgesByEvidence.RECORDED ? box(' is-rec', 'Recorded') : '')
      + box(' is-sel', 'Selected');
    return group('Nodes', kinds) + group('Relationships', edges) + group('Outline', ev);
  }

  function crumbsHtml(m) {
    var v = m.view, parts = [];
    parts.push('<button class="ex-cr" type="button" data-ex-crumb="root">' + esc(T('Visual Explorer')) + '</button>');
    parts.push('<button class="ex-cr" type="button" data-ex-crumb="view">' + esc(T(VIEW_TAB[v.id] || v.title)) + '</button>');
    var n = S.sel && S.sel.type === 'node' ? m.node[S.sel.id] : null;
    var e = S.sel && S.sel.type === 'edge' ? m.edge[S.sel.id] : null;
    if (n) {
      parts.push('<button class="ex-cr" type="button" data-ex-crumb="group" data-ex-group="' + esc(n.group) + '">' + code(n.group) + '</button>');
      parts.push('<span class="ex-cr ex-cr--now" aria-current="location">' + code(n.label) + '</span>');
    } else if (e) {
      parts.push('<span class="ex-cr ex-cr--now" aria-current="location">' + esc(T(EDGE[e.kind].label)) + '</span>');
    }
    return '<nav aria-label="' + esc(T('Explorer location')) + '"><ol class="ex-cr-l">'
      + parts.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ol></nav>';
  }

  function statusText(m) {
    var v = m.view;
    return tf('Showing %d of %d nodes · %d of %d relationships', m.nVisible, v.stats.nodes, m.eVisible, v.stats.edges);
  }

  function hitsText() {
    if (!S.q.trim()) return '';
    if (!S.matches.length) return S.hiddenMatches ? tf('No visible match · %d hidden by filters', S.hiddenMatches) : T('No match');
    var base = tf('%d matches', S.matches.length);
    return S.hiddenMatches ? base + ' · ' + tf('%d hidden by filters', S.hiddenMatches) : base;
  }

  function renderChrome() {
    var m = model(); if (!m) return;
    var set = function (id, text) { var el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
    set('ex-status', statusText(m));
    set('ex-hits', hitsText());
    var badge = document.getElementById('ex-badge'), n = activeFilters();
    if (badge) { badge.hidden = n === 0; badge.textContent = n ? String(n) : ''; }
    var f = document.getElementById('ex-focus');
    if (f) { f.setAttribute('aria-pressed', S.focus ? 'true' : 'false'); f.classList.toggle('is-on', S.focus); f.disabled = !S.sel && !S.focus; }
    var hs = R.host.querySelectorAll('[data-ex-hops]');
    for (var i = 0; i < hs.length; i++) {
      var on = String(S.hops) === hs[i].getAttribute('data-ex-hops');
      hs[i].setAttribute('aria-pressed', on ? 'true' : 'false'); hs[i].classList.toggle('is-on', on); hs[i].disabled = !S.focus;
    }
    var crumbs = document.getElementById('ex-crumbs');
    if (crumbs) { var ch = crumbsHtml(m); if (R.crumbs !== ch) { R.crumbs = ch; crumbs.innerHTML = ch; } }
    var ms = R.host.querySelectorAll('[data-ex-mode]');
    for (var j = 0; j < ms.length; j++) {
      var mo = ms[j].getAttribute('data-ex-mode') === S.mode;
      ms[j].classList.toggle('is-on', mo); ms[j].setAttribute('aria-pressed', mo ? 'true' : 'false');
    }
    if (S.mode === 'table') renderTable(m);
  }

  // ── inspector ─────────────────────────────────────────────────────────────

  function propValue(key, v) {
    if (v === null || v === undefined) return '<span class="ds-none" title="' + esc(T('Not recorded for this item.')) + '">—</span>';
    if (typeof v === 'boolean') return esc(T(v ? 'Yes' : 'No'));
    if (key === 'how') return esc(T(HOW[v] || v));
    if (typeof v === 'number') return '<bdi dir="ltr">' + esc(num(v)) + '</bdi>';
    return code(v);
  }
  function propsHtml(props) {
    var keys = Object.keys(props);
    if (!keys.length) return '';
    return '<div class="ds-kv-list">' + keys.map(function (k) {
      return K.kv(PROP[k] || k, propValue(k, props[k]));
    }).join('') + '</div>';
  }
  function sourceHtml(src, evidence) {
    var s = sourceOf(src.id);
    return '<div class="ex-ih">' + esc(T('Where it comes from')) + '</div><div class="ds-kv-list">'
      + K.kv('How it is known', K.evChip(evidence))
      + K.kv('File', s ? code(s.path) : '—')
      + K.kv('Located at', code(src.locator))
      + (s ? K.kv('Read as', esc(T(BASIS[s.basis] || s.basis))) : '')
      + '</div>';
  }
  function linkBtn(kind, id, label, extra) {
    return '<li><button class="ex-link" type="button" data-ex-go="' + kind + ':' + esc(id) + '">' + extra + '<span>' + code(label) + '</span></button></li>';
  }
  function relList(m, title, edges, dir) {
    if (!edges.length) return '';
    var cap = 40, shown = edges.slice(0, cap);
    return '<div class="ex-ih">' + esc(title) + ' <span class="ex-ih-n">' + esc(num(edges.length)) + '</span></div><ul class="ex-links">'
      + shown.map(function (e) {
        var other = m.node[dir === 'in' ? e.from : e.to];
        return linkBtn('n', other.id, other.label, glyphSvg(other.kind));
      }).join('') + '</ul>'
      + (edges.length > cap ? '<div class="ds-note">' + esc(tf('%d more are listed in the Table view.', edges.length - cap)) + '</div>' : '');
  }

  function inspectorHtml() {
    var m = model();
    if (!m) return '';
    var v = m.view, n = S.sel && S.sel.type === 'node' ? m.node[S.sel.id] : null, e = S.sel && S.sel.type === 'edge' ? m.edge[S.sel.id] : null;
    if (n) {
      return '<div class="ex-ihead"><div class="ex-ikind">' + glyphSvg(n.kind) + '<span>' + esc(T(KIND[n.kind].label)) + '</span></div>'
        + '<h2 class="ex-ititle" id="ex-ititle" tabindex="-1" data-no-i18n>' + esc(n.label) + '</h2>'
        + '<div class="ex-isub">' + code(n.id) + '</div></div>'
        + '<div class="ex-ibody"><div class="ds-kv-list">' + K.kv('Group', code(n.group)) + K.kv('Relationships', esc(tf('%d incoming, %d outgoing', m.inn[n.id].length, m.out[n.id].length))) + '</div>'
        + sourceHtml(n.source, n.evidence)
        + (Object.keys(n.props).length ? '<div class="ex-ih">' + esc(T('Details')) + '</div>' + propsHtml(n.props) : '')
        + relList(m, T('Incoming'), m.inn[n.id], 'in') + relList(m, T('Outgoing'), m.out[n.id], 'out')
        + (n.isolated ? '<div class="ds-note">' + esc(T('Nothing in the repository relates this to another node in this view.')) + '</div>' : '')
        + '</div>';
    }
    if (e) {
      var a = m.node[e.from], b = m.node[e.to];
      return '<div class="ex-ihead"><div class="ex-ikind"><span>' + esc(T('Relationship')) + '</span></div>'
        + '<h2 class="ex-ititle" id="ex-ititle" tabindex="-1">' + esc(T(EDGE[e.kind].label)) + '</h2>'
        + '<div class="ex-isub">' + esc(T(EDGE[e.kind].meaning)) + '</div></div>'
        + '<div class="ex-ibody"><div class="ex-ih">' + esc(T('From')) + '</div><ul class="ex-links">' + linkBtn('n', a.id, a.label, glyphSvg(a.kind)) + '</ul>'
        + '<div class="ex-ih">' + esc(T('To')) + '</div><ul class="ex-links">' + linkBtn('n', b.id, b.label, glyphSvg(b.kind)) + '</ul>'
        + '<div class="ds-kv-list">' + K.kv('Declarations behind it', '<bdi dir="ltr">' + esc(num(e.count)) + '</bdi>') + '</div>'
        + sourceHtml(e.source, e.evidence)
        + (Object.keys(e.props).length ? '<div class="ex-ih">' + esc(T('Details')) + '</div>' + propsHtml(e.props) : '')
        + '</div>';
    }
    var st = v.stats;
    var srcs = v.sources.map(sourceOf).filter(Boolean);
    return '<div class="ex-ihead"><div class="ex-ikind"><span>' + esc(T('This view')) + '</span></div>'
      + '<h2 class="ex-ititle" id="ex-ititle" tabindex="-1">' + esc(T(v.title)) + '</h2>'
      + '<div class="ex-isub">' + esc(T(v.summary)) + '</div></div>'
      + '<div class="ex-ibody"><div class="ds-kv-list">'
      + K.kv('Nodes', '<bdi dir="ltr">' + esc(num(st.nodes)) + '</bdi>')
      + K.kv('Relationships', '<bdi dir="ltr">' + esc(num(st.edges)) + '</bdi>')
      + K.kv('With no relationship', '<bdi dir="ltr">' + esc(num(st.isolated)) + '</bdi>')
      + '</div>'
      + '<div class="ex-ih">' + esc(T('Flow')) + '</div><ol class="ex-flow">' + v.flow.map(function (f) { return '<li>' + esc(T(f)) + '</li>'; }).join('') + '</ol>'
      + '<div class="ex-ih">' + esc(T('Read from')) + '</div><ul class="ex-srcs">' + srcs.map(function (s) {
        return '<li>' + code(s.path) + '<div class="ds-sub">' + esc(T(s.label)) + ' · ' + esc(T(BASIS[s.basis])) + '</div></li>';
      }).join('') + '</ul>'
      + (v.notes.length ? '<div class="ex-ih">' + esc(T('Notes')) + '</div><ul class="ex-notes">' + v.notes.map(function (x) { return '<li>' + esc(T(x)) + '</li>'; }).join('') + '</ul>' : '')
      + '<div class="ds-note">' + esc(T('Select a node or a relationship to see exactly where it comes from.')) + '</div>'
      + '<div class="ex-keys">' + esc(T('Arrows move · Enter selects · + − zoom · 0 fits')) + '</div></div>';
  }

  function renderInspector(focusTitle) {
    if (!R.insp) return;
    R.insp.innerHTML = inspectorHtml();
    // Back to the top, but not now: reading or writing a scroll position forces a layout in the middle of the handler.
    requestAnimationFrame(function () { if (R.insp) R.insp.scrollTop = 0; });
    if (focusTitle) { var t = document.getElementById('ex-ititle'); if (t) t.focus({ preventScroll: true }); }
  }

  // ── table alternative ─────────────────────────────────────────────────────

  function renderTable(m) {
    var pane = document.getElementById('ex-tablepane'); if (!pane || !m) return;
    var v = m.view, nodes = v.nodes.filter(function (n) { return m.vis[n.id] && (!S.q.trim() || S.matches.indexOf(n.id) >= 0); });
    var edges = v.edges.filter(function (e) { return m.visEdge[e.id] && (!S.q.trim() || S.matches.indexOf(e.from) >= 0 || S.matches.indexOf(e.to) >= 0); });
    var tabs = '<div class="ds-tabs ex-ttabs" role="tablist" aria-label="' + esc(T('Table views')) + '">'
      + [['nodes', 'Nodes'], ['edges', 'Relationships']].map(function (t) {
        var on = S.tab === t[0];
        return '<button class="ds-tab' + (on ? ' is-on' : '') + '" type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '" data-ex-tab="' + t[0] + '">'
          + esc(T(t[1])) + ' <span class="ex-ih-n">' + esc(num(t[0] === 'nodes' ? nodes.length : edges.length)) + '</span></button>';
      }).join('') + '</div>';
    var body;
    if (S.tab === 'nodes') {
      body = nodes.length ? '<table class="ds-table ex-table"><caption class="ds-sr">' + esc(T('Every node in this view')) + '</caption><thead><tr>'
        + '<th scope="col">' + esc(T('Name')) + '</th><th scope="col">' + esc(T('Kind')) + '</th><th scope="col">' + esc(T('Group')) + '</th>'
        + '<th scope="col">' + esc(T('Evidence')) + '</th><th scope="col" class="ds-num">' + esc(T('In')) + '</th><th scope="col" class="ds-num">' + esc(T('Out')) + '</th>'
        + '<th scope="col">' + esc(T('Located at')) + '</th></tr></thead><tbody>'
        + nodes.map(function (n) {
          var cur = S.sel && S.sel.type === 'node' && S.sel.id === n.id;
          return '<tr' + (cur ? ' class="is-cur"' : '') + '><td><button class="ex-link" type="button" data-ex-go="n:' + esc(n.id) + '"' + (cur ? ' aria-current="true"' : '') + '>' + glyphSvg(n.kind) + '<span>' + code(n.label) + '</span></button></td>'
            + '<td>' + esc(T(KIND[n.kind].label)) + '</td><td>' + code(n.group) + '</td><td>' + K.evChip(n.evidence) + '</td>'
            + '<td class="ds-num">' + esc(num(m.inn[n.id].length)) + '</td><td class="ds-num">' + esc(num(m.out[n.id].length)) + '</td>'
            + '<td>' + code(n.source.locator) + '</td></tr>';
        }).join('') + '</tbody></table>' : K.emptyState('No node matches', T('Clear the search or reset the filters.'));
    } else {
      body = edges.length ? '<table class="ds-table ex-table"><caption class="ds-sr">' + esc(T('Every relationship in this view')) + '</caption><thead><tr>'
        + '<th scope="col">' + esc(T('From')) + '</th><th scope="col">' + esc(T('Relationship')) + '</th><th scope="col">' + esc(T('To')) + '</th>'
        + '<th scope="col">' + esc(T('Evidence')) + '</th><th scope="col">' + esc(T('Located at')) + '</th></tr></thead><tbody>'
        + edges.map(function (e) {
          var a = m.node[e.from], b = m.node[e.to], cur = S.sel && S.sel.type === 'edge' && S.sel.id === e.id;
          return '<tr' + (cur ? ' class="is-cur"' : '') + '><td><button class="ex-link" type="button" data-ex-go="n:' + esc(a.id) + '">' + glyphSvg(a.kind) + '<span>' + code(a.label) + '</span></button></td>'
            + '<td><button class="ex-link" type="button" data-ex-go="e:' + esc(e.id) + '"' + (cur ? ' aria-current="true"' : '') + '>' + esc(T(EDGE[e.kind].label)) + '</button></td>'
            + '<td><button class="ex-link" type="button" data-ex-go="n:' + esc(b.id) + '">' + glyphSvg(b.kind) + '<span>' + code(b.label) + '</span></button></td>'
            + '<td>' + K.evChip(e.evidence) + '</td><td>' + code(e.source.locator) + '</td></tr>';
        }).join('') + '</tbody></table>' : K.emptyState('No relationship matches', T('Clear the search or reset the filters.'));
    }
    // Re-drawn whenever the selection or a filter changes: keep the reader's place and focus.
    var keep = document.activeElement, keepGo = keep && keep.getAttribute ? keep.getAttribute('data-ex-go') : null;
    var keepTab = keep && keep.getAttribute ? keep.getAttribute('data-ex-tab') : null;
    var oldTbl = pane.querySelector('.ex-tbl'), top = oldTbl ? oldTbl.scrollTop : 0;
    pane.innerHTML = tabs + '<div class="ex-tbl" tabindex="0" role="region" aria-label="' + esc(S.tab === 'nodes' ? T('Every node in this view') : T('Every relationship in this view')) + '">' + body + '</div>';
    var tbl = pane.querySelector('.ex-tbl'); if (tbl) tbl.scrollTop = top;
    var back = keepGo ? pane.querySelector('[data-ex-go="' + keepGo.replace(/["\\]/g, '\\$&') + '"]') : keepTab ? pane.querySelector('[data-ex-tab="' + keepTab + '"]') : null;
    if (back) back.focus({ preventScroll: true });
  }

  // ── selection ─────────────────────────────────────────────────────────────

  function announce(text) { var l = document.getElementById('ex-live'); if (l) l.textContent = text; }

  function select(type, id, opts) {
    opts = opts || {};
    var m = model(); if (!m) return;
    if (type === 'node' && !m.node[id]) return;
    if (type === 'edge' && !m.edge[id]) return;
    if (S.sel && S.sel.type === type && S.sel.id === id && !opts.force) {
      if (opts.toggle) { clearSelection(); return; }
    }
    S.sel = { type: type, id: id };
    // A selection that is not on screen (hidden by a filter, or parked) is revealed, not silently kept.
    if (type === 'node' && !m.vis[id]) { var n0 = m.node[id]; if (n0.isolated && !S.isolated) S.isolated = true; if (S.hideKind[n0.kind]) S.hideKind[n0.kind] = false; if (S.hideEv[n0.evidence]) S.hideEv[n0.evidence] = false; if (S.group !== 'all' && S.group !== n0.group) S.group = 'all'; refreshPop(); }
    applyState();
    renderInspector(opts.focusInspector);
    if (S.focus) fit(true);
    else if (opts.reveal && type === 'node') reveal(id);
    if (type === 'node') { S.rove = id; setRove(m, id); }
    var node = type === 'node' ? m.node[id] : null;
    announce(node ? T('Selected') + ' ' + node.label + ', ' + tf('%d incoming, %d outgoing', m.inn[id].length, m.out[id].length) : T('Selected') + ' ' + T(EDGE[m.edge[id].kind].label));
  }
  function clearSelection() {
    S.sel = null; applyState(); renderInspector(false);
    if (S.focus) { S.focus = false; applyState(); fit(true); }
    announce(T('Selection cleared'));
  }

  function refreshPop() {
    var m = model(), pop = document.getElementById('ex-pop');
    if (!m || !pop) return;
    // The popover is redrawn from state; the control the reader just used keeps the focus.
    var a = document.activeElement, keep = null;
    if (a && pop.contains(a)) {
      ['data-ex-kind', 'data-ex-ev', 'data-ex-isolated', 'data-ex-reset'].forEach(function (k) { if (a.hasAttribute(k)) keep = [k, a.getAttribute(k)]; });
    }
    pop.innerHTML = popHtml(m);
    if (keep) {
      var back = pop.querySelector('[' + keep[0] + (keep[1] ? '="' + keep[1] + '"' : '') + ']');
      if (back) back.focus({ preventScroll: true });
    }
  }
  function setPop(open) {
    S.popOpen = open;
    var pop = document.getElementById('ex-pop'), b = document.getElementById('ex-filters-b');
    if (pop) pop.classList.toggle('is-open', open);
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function filtersChanged() {
    applyState();
    if (S.sel && S.sel.type === 'node') {
      var m = model();
      if (m && !m.vis[S.sel.id]) { S.sel = null; applyState(); renderInspector(false); }
    }
    fit(true);
    announce(statusText(model()));
  }

  // ── drawing a view ────────────────────────────────────────────────────────

  function drawView() {
    var m = model(), wait = document.getElementById('ex-wait');
    if (!m) {
      var err = S.errors[S.viewId] || S.indexError;
      R.scene.innerHTML = '';
      if (wait) {
        wait.classList.add('is-on');
        wait.innerHTML = err ? K.emptyState('The graph could not be read', T(err)) : K.skeleton(6, 'row');
      }
      if (R.insp) R.insp.innerHTML = '';
      return;
    }
    if (wait) { wait.classList.remove('is-on'); wait.innerHTML = ''; }
    var t0 = now();
    R.scene.innerHTML = sceneHtml(m);
    R.svg.setAttribute('aria-label', T(m.view.title));
    var ne = R.scene.querySelectorAll('[data-n]'), ee = R.scene.querySelectorAll('[data-e]'), i;
    m.nodeEl = Object.create(null); m.edgeEl = Object.create(null); m.cls = Object.create(null);
    for (i = 0; i < ne.length; i++) { ne[i].setAttribute('data-base', ne[i].getAttribute('class')); m.nodeEl[ne[i].getAttribute('data-n')] = ne[i]; }
    for (i = 0; i < ee.length; i++) { ee[i].setAttribute('data-base', ee[i].getAttribute('class')); m.edgeEl[ee[i].getAttribute('data-e')] = ee[i]; }
    M.drawMs = Math.round((now() - t0) * 10) / 10;
    M.nodes = m.view.nodes.length; M.edges = m.view.edges.length; M.domNodes = R.scene.getElementsByTagName('*').length;
    var pop = document.getElementById('ex-pop'); if (pop) pop.innerHTML = popHtml(m);
    var lg = document.getElementById('ex-legend'); if (lg) lg.innerHTML = legendHtml(m);
    // A selection from another view means nothing here.
    if (S.sel && ((S.sel.type === 'node' && !m.node[S.sel.id]) || (S.sel.type === 'edge' && !m.edge[S.sel.id]))) S.sel = null;
    applyState();
    renderInspector(false);
    applyMode();
    measure(true);
    if (S.fitted || !m) fit(false); else applyCam();
  }

  function applyMode() {
    var table = S.mode === 'table';
    R.canvas.hidden = table;
    var pane = document.getElementById('ex-tablepane'); if (pane) pane.hidden = !table;
    var zoom = R.host.querySelector('.ex-zoom');
    if (zoom) { var bs = zoom.querySelectorAll('button'); for (var i = 0; i < bs.length; i++) bs[i].disabled = table; }
    var m = model(); if (m && table) renderTable(m);
    if (!table) { measure(true); if (S.fitted) fit(false); }
  }

  function showView(id) {
    S.viewId = id; S.sel = null; S.fitted = true; S.group = 'all'; S.hideKind = Object.create(null); S.hideEv = Object.create(null);
    S.isolated = false; S.focus = false; S.matchAt = -1;
    var tabs = R.host.querySelectorAll('[data-ex-view]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-ex-view') === id;
      tabs[i].classList.toggle('is-on', on); tabs[i].setAttribute('aria-selected', on ? 'true' : 'false'); tabs[i].setAttribute('tabindex', on ? '0' : '-1');
    }
    drawView();
    if (!S.models[id] && !S.errors[id]) {
      loadView(id).then(function () { if (S.viewId === id && R.root) drawView(); });
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  function nodeIdOf(el) { var g = el && el.closest ? el.closest('[data-n]') : null; return g ? g.getAttribute('data-n') : null; }
  function edgeIdOf(el) { var g = el && el.closest ? el.closest('[data-e]') : null; return g ? g.getAttribute('data-e') : null; }

  function nearest(m, fromId, dx, dy) {
    var a = m.node[fromId], best = null, bestScore = Infinity;
    for (var i = 0; i < m.view.nodes.length; i++) {
      var b = m.view.nodes[i];
      if (b.id === fromId || !m.vis[b.id]) continue;
      var vx = b.x - a.x, vy = b.y - a.y, along = vx * dx + vy * dy;
      if (along <= 1) continue;
      var perp = Math.abs(vx * dy - vy * dx);
      var score = along + perp * 2.5;
      if (score < bestScore) { bestScore = score; best = b.id; }
    }
    return best;
  }

  function onKey(ev) {
    var m = model(); if (!m) return;
    var t = ev.target, id = nodeIdOf(t);
    var pan = ev.shiftKey ? 90 : 0;
    var dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[ev.key];
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomAt(1.25, null, null, true); return; }
    if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomAt(0.8, null, null, true); return; }
    if (ev.key === '0') { ev.preventDefault(); fit(true); return; }
    if (ev.key === 'Escape') { if (S.popOpen) return; if (S.sel) { ev.preventDefault(); clearSelection(); } return; }
    if (!id) return;
    if (dir && pan) {
      ev.preventDefault(); S.fitted = false;
      setCam({ k: S.cam.k, tx: S.cam.tx - dir[0] * pan, ty: S.cam.ty - dir[1] * pan }, false);
      return;
    }
    if (dir) {
      ev.preventDefault();
      var next = nearest(m, id, dir[0], dir[1]);
      if (next) { setRove(m, next); m.nodeEl[next].focus({ preventScroll: true }); reveal(next); }
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select('node', id, { toggle: true }); }
  }

  var P = { down: null, pts: Object.create(null), n: 0, panning: false, pinch: null, swallow: false };

  function onPointerDown(ev) {
    if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;
    // A mouse is one pointer: a release outside the window must not leave a ghost that turns the next drag into a pinch.
    if (ev.pointerType === 'mouse') { P.pts = Object.create(null); P.n = 0; }
    P.pts[ev.pointerId] = { x: ev.clientX, y: ev.clientY }; P.n++;
    if (P.n === 1) P.down = { x: ev.clientX, y: ev.clientY, tx: S.cam.tx, ty: S.cam.ty, id: ev.pointerId };
    if (P.n === 2) {
      var ids = Object.keys(P.pts), a = P.pts[ids[0]], b = P.pts[ids[1]];
      P.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.cam.k, cx: null, cy: null };
      P.panning = true;
    }
  }
  function onPointerMove(ev) {
    var p = P.pts[ev.pointerId]; if (!p) return;
    p.x = ev.clientX; p.y = ev.clientY;
    if (P.n === 2 && P.pinch) {
      var ids = Object.keys(P.pts), a = P.pts[ids[0]], b = P.pts[ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y), box = R.canvas.getBoundingClientRect();
      var cx = (a.x + b.x) / 2 - box.left, cy = (a.y + b.y) / 2 - box.top;
      var target = clamp(P.pinch.k * (d / Math.max(1, P.pinch.d)), KMIN, KMAX);
      var f = target / S.cam.k;
      // Two fingers zoom around their midpoint and carry the graph with them when they move together.
      var mx = P.pinch.cx === null ? 0 : cx - P.pinch.cx, my = P.pinch.cy === null ? 0 : cy - P.pinch.cy;
      P.pinch.cx = cx; P.pinch.cy = cy;
      S.fitted = false;
      setCam({ k: target, tx: cx - (cx - S.cam.tx) * f + mx, ty: cy - (cy - S.cam.ty) * f + my }, false);
      return;
    }
    if (P.n === 1 && P.down && P.down.id === ev.pointerId) {
      var dx = ev.clientX - P.down.x, dy = ev.clientY - P.down.y;
      if (!P.panning && Math.hypot(dx, dy) > 5) {
        P.panning = true; R.canvas.classList.add('is-panning');
        try { R.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
      }
      if (P.panning) { S.fitted = false; setCam({ k: S.cam.k, tx: P.down.tx + dx, ty: P.down.ty + dy }, false); }
    }
  }
  function onPointerUp(ev) {
    if (!P.pts[ev.pointerId]) return;
    delete P.pts[ev.pointerId]; P.n = Math.max(0, P.n - 1);
    if (P.panning) P.swallow = true;
    if (P.n === 0) {
      P.down = null; P.pinch = null; P.panning = false; R.canvas.classList.remove('is-panning');
      // The click that ends a drag is not a selection.
      if (P.swallow) setTimeout(function () { P.swallow = false; }, 0);
    }
  }
  function onWheel(ev) {
    if (S.mode !== 'graph') return;
    ev.preventDefault();
    var box = R.canvas.getBoundingClientRect();
    var dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1);
    zoomAt(Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0016)), ev.clientX - box.left, ev.clientY - box.top, false);
  }

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest) return;
    var q;
    // Graph surface
    if (t.closest('#ex-canvas') && !t.closest('.ex-over')) {
      if (P.swallow) return;
      var nid = nodeIdOf(t), eid = edgeIdOf(t);
      if (nid) { select('node', nid, { toggle: true }); return; }
      if (eid) { select('edge', eid, {}); return; }
      if (S.sel) clearSelection();
      return;
    }
    var v = t.closest('[data-ex-view]');
    if (v) { showView(v.getAttribute('data-ex-view')); return; }
    if (t.closest('[data-ex-filters]')) { setPop(!S.popOpen); return; }
    q = t.closest('[data-ex-kind]');
    if (q) { var k = q.getAttribute('data-ex-kind'); S.hideKind[k] = !S.hideKind[k]; refreshPop(); filtersChanged(); return; }
    q = t.closest('[data-ex-ev]');
    if (q) { var e = q.getAttribute('data-ex-ev'); S.hideEv[e] = !S.hideEv[e]; refreshPop(); filtersChanged(); return; }
    if (t.closest('[data-ex-isolated]')) { S.isolated = !S.isolated; refreshPop(); filtersChanged(); return; }
    if (t.closest('[data-ex-reset]')) {
      S.hideKind = Object.create(null); S.hideEv = Object.create(null); S.group = 'all'; S.isolated = false;
      refreshPop(); filtersChanged(); return;
    }
    if (t.closest('[data-ex-focus]')) {
      if (!S.sel && !S.focus) return;
      S.focus = !S.focus; applyState(); fit(true); announce(statusText(model())); return;
    }
    q = t.closest('[data-ex-hops]');
    if (q && S.focus) { S.hops = parseInt(q.getAttribute('data-ex-hops'), 10) === 2 ? 2 : 1; applyState(); fit(true); return; }
    q = t.closest('[data-ex-mode]');
    if (q) { S.mode = q.getAttribute('data-ex-mode') === 'table' ? 'table' : 'graph'; applyMode(); renderChrome(); return; }
    q = t.closest('[data-ex-tab]');
    if (q) { S.tab = q.getAttribute('data-ex-tab') === 'edges' ? 'edges' : 'nodes'; renderTable(model()); var again = R.host.querySelector('[data-ex-tab="' + S.tab + '"]'); if (again) again.focus(); return; }
    q = t.closest('[data-ex-zoom]');
    if (q) {
      var z = q.getAttribute('data-ex-zoom');
      if (z === 'in') zoomAt(1.25, null, null, true); else if (z === 'out') zoomAt(0.8, null, null, true); else fit(true);
      return;
    }
    q = t.closest('[data-ex-crumb]');
    if (q) {
      var c = q.getAttribute('data-ex-crumb');
      if (c === 'group') { S.group = q.getAttribute('data-ex-group'); S.sel = null; S.focus = false; refreshPop(); filtersChanged(); renderInspector(false); }
      else { if (S.sel) { S.sel = null; S.focus = false; applyState(); renderInspector(false); } S.group = 'all'; refreshPop(); applyState(); fit(true); }
      return;
    }
    q = t.closest('[data-ex-go]');
    if (q) {
      var parts = q.getAttribute('data-ex-go'), kind = parts.charAt(0) === 'e' ? 'edge' : 'node', id = parts.slice(2);
      var inInspector = !!t.closest('#ex-insp');
      select(kind, id, { reveal: true, force: true, focusInspector: inInspector });
      return;
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t && t.id === 'ex-q') {
      S.q = t.value; S.matchAt = -1;
      if (R.raf) cancelAnimationFrame(R.raf);
      R.raf = requestAnimationFrame(function () { R.raf = 0; applyState(); });
    }
  }
  function onChange(ev) {
    var t = ev.target;
    if (t && t.id === 'ex-group') { S.group = t.value; filtersChanged(); }
  }
  function onHostKey(ev) {
    var t = ev.target;
    if (t && t.id === 'ex-q') {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!S.matches.length) return;
        S.matchAt = (S.matchAt + (ev.shiftKey ? -1 : 1) + S.matches.length) % S.matches.length;
        select('node', S.matches[S.matchAt], { reveal: true, force: true });
        announce(tf('Match %d of %d', S.matchAt + 1, S.matches.length));
      } else if (ev.key === 'Escape' && S.q) { ev.preventDefault(); S.q = ''; t.value = ''; applyState(); }
      return;
    }
    if (ev.key === 'Escape' && S.popOpen) { ev.preventDefault(); setPop(false); var b = document.getElementById('ex-filters-b'); if (b) b.focus(); return; }
    if (t && t.closest && t.closest('#ex-stage') && !t.closest('#ex-tablepane')) { onKey(ev); return; }
    // The two tablists: Arrow keys move between tabs.
    var tab = t && t.closest ? t.closest('[role="tab"]') : null;
    if (tab && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
      var list = tab.parentNode.querySelectorAll('[role="tab"]'), at = Array.prototype.indexOf.call(list, tab);
      var step = (ev.key === 'ArrowRight') === !rtl() ? 1 : -1, next = list[(at + step + list.length) % list.length];
      ev.preventDefault(); next.click(); var f = tab.parentNode.querySelector('[role="tab"][tabindex="0"]'); if (f) f.focus();
    }
  }
  function onFocusIn(ev) {
    // Keyboard focus on a node keeps the roving target, and brings the node into view.
    var id = nodeIdOf(ev.target);
    var m = model();
    if (id && m && S.rove !== id) setRove(m, id);
  }

  var bound = [];
  function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); bound.push([target, type, fn, opts]); }
  function unbind() {
    bound.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); });
    bound = [];
    if (R.ro) { R.ro.disconnect(); R.ro = null; }
    if (R.raf) { cancelAnimationFrame(R.raf); R.raf = 0; }
    if (R.tween) { cancelAnimationFrame(R.tween); R.tween = 0; }
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  function mount(host, kit) {
    K = kit;
    unbind();
    P.pts = Object.create(null); P.n = 0; P.down = null; P.panning = false; P.pinch = null; P.swallow = false;
    R.host = host; R.crumbs = ''; host.innerHTML = shellHtml();
    R.root = host.querySelector('.ex'); R.stage = document.getElementById('ex-stage'); R.canvas = document.getElementById('ex-canvas');
    R.svg = document.getElementById('ex-svg'); R.camG = document.getElementById('ex-cam'); R.scene = document.getElementById('ex-scene');
    R.insp = document.getElementById('ex-insp'); R.live = document.getElementById('ex-live');

    on(host, 'click', onClick);
    on(host, 'input', onInput);
    on(host, 'change', onChange);
    on(host, 'keydown', onHostKey);
    on(host, 'focusin', onFocusIn);
    on(R.canvas, 'pointerdown', onPointerDown);
    on(R.canvas, 'pointermove', onPointerMove);
    on(R.canvas, 'pointerup', onPointerUp);
    on(R.canvas, 'pointercancel', onPointerUp);
    on(R.canvas, 'wheel', onWheel, { passive: false });
    on(document, 'click', function (ev) {
      // Outside the Filters popover: close it. (The click handler above ignores clicks it does not own.)
      // composedPath is fixed when the click was dispatched, so a button the popover replaced while handling it still counts as inside.
      var path = ev.composedPath ? ev.composedPath() : [];
      var inside = path.some(function (el) { return el && el.classList && el.classList.contains('ex-popwrap'); });
      if (S.popOpen && !inside) setPop(false);
    });
    if (window.ResizeObserver) {
      R.ro = new ResizeObserver(function (entries) {
        var box = entries[0] && entries[0].contentRect;
        var w = box ? box.width : 0, h = box ? box.height : 0;
        if (!w || !h || (w === S.size.w && h === S.size.h)) return;
        S.size = { w: w, h: h };
        if (model() && S.mode === 'graph') { if (S.fitted) fit(false); else applyCam(); }
      });
      R.ro.observe(R.canvas);
    }

    var m = model();
    if (m) { drawView(); return; }
    drawView();   // shows the skeleton
    var first = S.index ? Promise.resolve() : loadIndex();
    first.then(function () {
      if (!S.index) { drawView(); return; }
      if (S.index.state !== 'READY') { S.errors[S.viewId] = S.index.reason || T('The graph could not be read'); drawView(); return; }
      return loadView(S.viewId).then(function () { if (R.root && R.host === host) drawView(); });
    });
  }

  function unmount() {
    unbind();
    R.root = null; R.host = null;
    S.sel = null; S.focus = false; S.popOpen = false; S.q = ''; S.mode = 'graph'; S.matchAt = -1;
  }
  /** Forget everything read from the server (the room's Refresh). */
  function reset() {
    var keep = { viewId: S.viewId };
    unbind(); S = fresh(); S.viewId = keep.viewId; S.size = { w: 0, h: 0 };
  }

  window.FamilistaDesignExplorer = { mount: mount, unmount: unmount, reset: reset };

  // Exposed for the test suite and the performance measurements: figures the page itself produced, nothing else.
  window.__familistaExplorerMetrics = function () {
    var m = model();
    return {
      drawMs: M.drawMs, stateMs: M.stateMs, fitMs: M.fitMs, loadMs: M.lastLoadMs, nodes: M.nodes, edges: M.edges, domNodes: M.domNodes,
      visibleNodes: m ? m.nVisible : null, visibleEdges: m ? m.eVisible : null, zoom: S.cam.k, view: S.viewId,
    };
  };
}());
