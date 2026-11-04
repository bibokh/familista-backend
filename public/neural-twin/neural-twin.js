/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — NEURAL DIGITAL TWIN (Phase 1)

   The platform's real architecture as an explorable network, for the Platform
   Owner only. It reads one graph (GET /system/neural-twin, composed at build
   time from the repository's own authorities: src/platform/neural-twin) and
   draws it; it writes nothing and invents nothing. Every node and edge on the
   screen carries the evidence the composer recorded, and what is not known is
   said, never drawn as if it were.

   The graph and the drawing are separate: this file lays the graph out and
   renders it with the Babylon.js the application already vendors
   (/vendor/babylon.js, loaded on demand). The explorer beside it is the same
   graph as an outline, which is also the keyboard and screen-reader path, and
   the whole room still works when WebGL does not.

   Loaded on demand by public/app.js for the platform owner only, behind the
   same data-no-i18n boundary as every owner room, with its own English, German
   and Arabic catalogue under /neural-twin/i18n/. Names (systems, components,
   files, agents) are data and are never translated.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── localisation ──────────────────────────────────────────────────────────
  var NT_LOCALES = [['en', 'English', 'ltr', 'en-GB'], ['de', 'Deutsch', 'ltr', 'de-DE'], ['ar', 'العربية', 'rtl', 'ar']];
  var NT_DICT = {}, NT_LANG = 'en', NT_DIR = 'ltr';
  function localeOf(tag) {
    var t = String(tag || '').toLowerCase();
    for (var i = 0; i < NT_LOCALES.length; i++) if (t === NT_LOCALES[i][0] || t === NT_LOCALES[i][3].toLowerCase() || t.indexOf(NT_LOCALES[i][0] + '-') === 0) return NT_LOCALES[i];
    return NT_LOCALES[0];
  }
  function platformLocale() {
    try { if (window.I18N && typeof window.I18N.locale === 'function') return window.I18N.locale(); } catch (_) {}
    try { return localStorage.getItem('familista.locale') || 'en'; } catch (_) { return 'en'; }
  }
  function loadDict(tag) {
    if (tag === 'en') { NT_DICT = {}; return Promise.resolve(); }
    return fetch('/neural-twin/i18n/' + tag + '.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { NT_DICT = d || {}; }, function () { NT_DICT = {}; });
  }
  function setLocale(tag) { var l = localeOf(tag); NT_LANG = l[0]; NT_DIR = l[2]; return loadDict(NT_LANG); }
  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || NT_LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(NT_DICT, s) ? NT_DICT[s] : s;
  }
  function num(v) { try { return new Intl.NumberFormat(NT_LANG === 'ar' ? 'ar' : NT_LANG).format(v); } catch (_) { return String(v); } }
  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) { var a = Array.prototype.slice.call(arguments, 1), i = 0; return T(key).replace(/%d/g, function () { var v = a[i++]; return v == null ? '—' : num(v); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** A name or a path from the graph: data, kept as written, isolated from the page's direction. */
  function data(s) { return '<bdi dir="auto">' + esc(s) + '</bdi>'; }
  /** A sentence the composer or an authority wrote in English; translated where the catalogue holds it. */
  function prose(s) {
    var t = T(s);
    return t === s && NT_LANG !== 'en' ? '<span lang="en" dir="ltr">' + esc(s) + '</span>' : esc(t);
  }

  // ── what the kinds and relationships are, and how they are drawn ─────────
  var KINDS = {
    system:    { name: 'System',          plural: 'Systems',          shape: 'ico',     size: 3.0,  tok: '--fam-module-accent' },
    component: { name: 'Component',       plural: 'Components',       shape: 'box',     size: 1.2,  tok: '--fam-chart-categorical-1' },
    module:    { name: 'Code module',     plural: 'Code modules',     shape: 'sphere',  size: 1.3,  tok: '--fam-chart-categorical-2' },
    file:      { name: 'Source file',     plural: 'Source files',     shape: 'sphere',  size: 0.5,  tok: '--fam-text-secondary' },
    api:       { name: 'API router',      plural: 'API routers',      shape: 'octa',    size: 0.95, tok: '--fam-chart-categorical-3' },
    model:     { name: 'Data model',      plural: 'Data models',      shape: 'cyl',     size: 1.0,  tok: '--fam-chart-categorical-4' },
    agent:     { name: 'AI agent',        plural: 'AI agents',        shape: 'capsule', size: 1.1,  tok: '--fam-chart-categorical-5' },
    boundary:  { name: 'Trust boundary',  plural: 'Trust boundaries', shape: 'torus',   size: 1.0,  tok: '--fam-chart-categorical-6' },
    sysmodule: { name: 'SYSTEM module',   plural: 'SYSTEM modules',   shape: 'box',     size: 0.8,  tok: '--fam-chart-categorical-7' },
    planned:   { name: 'Planned',         plural: 'Planned',          shape: 'sphere',  size: 1.0,  tok: '--fam-status-unverified' },
  };
  var KIND_ORDER = ['system', 'component', 'module', 'api', 'file', 'model', 'agent', 'boundary', 'sysmodule', 'planned'];
  var EDGES = {
    IMPORTS:        { name: 'Imports',                     out: 'Imports',             inc: 'Imported by',          tok: '--fam-chart-categorical-2' },
    DATA:           { name: 'Data access',                 out: 'Reads or writes',     inc: 'Read or written by',   tok: '--fam-chart-categorical-4' },
    DEPENDS_ON:     { name: 'Depends on',                  out: 'Depends on',          inc: 'Needed by',            tok: '--fam-chart-categorical-1' },
    INFRA:          { name: 'Infrastructure relationship', out: 'Infrastructure: to',  inc: 'Infrastructure: from', tok: '--fam-chart-categorical-1' },
    IMPLEMENTED_BY: { name: 'Implemented by',              out: 'Implemented by',      inc: 'Implements',           tok: '--fam-text-secondary' },
    IN_BOUNDARY:    { name: 'In trust boundary',           out: 'In trust boundary',   inc: 'Contains',             tok: '--fam-chart-categorical-6' },
    USES_TOOLS:     { name: 'Uses tools',                  out: 'Uses tools from',     inc: 'Tools used by',        tok: '--fam-chart-categorical-5' },
  };
  var EDGE_ORDER = ['IMPORTS', 'DATA', 'DEPENDS_ON', 'INFRA', 'IMPLEMENTED_BY', 'USES_TOOLS', 'IN_BOUNDARY'];
  var MATURITY = { IMPLEMENTED: 'Implemented', PARTIAL: 'Partial', PLANNED: 'Planned', UNVERIFIED: 'Unverified' };
  var AUTHORITY = {
    'infrastructure-manifest': 'Infrastructure manifest', 'security-manifest': 'Security manifest', 'coverage-map': 'Coverage map',
    'posture-policy': 'Posture policy', 'system-modules': 'SYSTEM module registry', 'agent-catalog': 'Agent registry', 'tool-registry': 'Tool registry',
    'typescript-imports': 'TypeScript import', 'prisma-calls': 'Prisma call site', 'prisma-schema': 'Prisma schema', 'repository': 'Repository', 'composer-rule': 'Composer rule',
  };
  var FACTS = {
    zone: 'Zone', category: 'Category', status: 'Status', type: 'Type', repositoryPath: 'Repository path', healthSignal: 'Has a health signal in Infrastructure City',
    files: 'Files', lines: 'Lines', reachableFiles: 'Files reached from the server', alsoIn: 'Also has components in', path: 'Path',
    reachableFromEntry: 'Reached from the server or a start-up script', dormantRouter: 'Router module that no mount uses', mount: 'Mounted at',
    handlers: 'Handlers', publicHandlers: 'Public handlers', routerWideAuth: 'Sign-in required on every route', ownerOnly: 'Platform owner only',
    authorization: 'Handlers by authorisation', tenancy: 'Club id parameters', models: 'Prisma models', domain: 'Domain', scope: 'Scope',
    lifecycle: 'Lifecycle', autonomyCeiling: 'Autonomy ceiling', supervisor: 'Supervisor', tools: 'Tools', reads: 'Reads data classes', writes: 'Writes data classes',
    group: 'Group', readiness: 'Readiness', row: 'Coverage map row', flow: 'Flow', trustBoundary: 'Trust boundary', dataClass: 'Data class',
    boundaryType: 'Boundary type', coverage: 'Coverage', controls: 'Controls', modules: 'Modules',
  };
  var ROOMS = {
    'infrastructure-city': 'Open in Infrastructure City', cybersecurity: 'Open in Cybersecurity', 'agents-room': 'Open in the AI Agents Operations Room', system: 'Open in SYSTEM',
  };
  // The infrastructure manifest's zones, named for the reader. Where they sit is the layout's work.
  var ZONE_NAMES = { centre: 'Centre zone', north: 'North zone', east: 'East zone', south: 'South zone', west: 'West zone' };
  /** How each relationship is drawn, so no two kinds look alike even without colour: the arc's height over its
   *  length, its width in pixels, and its dash (on, off) in scene units, or none. */
  var EDGE_STYLE = {
    IMPORTS:        { lift: 0.10, px: 1.4, dash: null },
    DATA:           { lift: 0.15, px: 1.5, dash: [1.1, 0.7] },
    DEPENDS_ON:     { lift: 0.21, px: 2.2, dash: null },
    INFRA:          { lift: 0.25, px: 1.8, dash: [0.45, 0.55] },
    IMPLEMENTED_BY: { lift: 0.04, px: 1.3, dash: null },
    USES_TOOLS:     { lift: 0.17, px: 1.7, dash: [1.6, 0.6] },
    IN_BOUNDARY:    { lift: 0.07, px: 1.2, dash: [0.35, 0.75] },
  };
  var EDGE_BUDGET = 2400;      // lines drawn at once before the weakest give way; the selection's own are always drawn
  var HIGHLIGHT_BUDGET = 600;
  var FILE_LOD = 170;          // past this distance a source file is too small to see, and is not drawn
  var LOD_FAR = [150, 130];    // camera distance at which every body takes its coarse geometry, and takes the fine one back (hysteresis)
  var OPEN_SYSTEM = 0.55;      // an open node's own body shrinks to make room for its platform
  var VIEW = { alpha: -Math.PI / 2, beta: 0.96 };
  function L() { return window.FamilistaTwinLayout; }

  // ── state ─────────────────────────────────────────────────────────────────
  function fresh() {
    return {
      root: null, state: 'idle', error: null, graph: null, commit: null,
      byId: {}, kids: {}, out: {}, inc: {}, depth: {},
      sel: null, expanded: {}, kinds: {}, edges: {}, system: '', q: '', showAll: {},
      pos: {}, visible: {}, lifted: [], labels: [], labelSize: {}, labelPri: {}, labelsShown: 0,
      layout: null, layoutMs: null, near: {}, selSet: {}, path: null, pathTo: null, history: [], drawn: [], cut: 0, ambientTotal: 0, hiCount: { out: 0, inc: 0, path: 0 },
      intensity: 1, focusOnly: false, edgeRaf: 0,
      gl: { engine: null, scene: null, camera: null, meshes: {}, mats: {}, templates: {}, edgeMeshes: [], hiMeshes: [], arrows: [], platforms: [], inst: null,
        far: false, cw: 0, ch: 0,
        layoutKey: '', anim: null, tween: null, dirty: true, ok: false, failed: false, reason: '', awakeUntil: 0, frames: 0 },
      cleanup: [], firstFrameMs: null, t0: 0, babylonMs: null,
    };
  }
  var S = fresh();
  for (var k in KINDS) S.kinds[k] = true;
  for (var e in EDGES) S.edges[e] = e !== 'IN_BOUNDARY';
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

  // ── the API ───────────────────────────────────────────────────────────────
  function apiBase() { return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE) ? window.FAM_CONFIG.API_BASE : '/api/v1'; }
  function token() { try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) { return ''; } }
  /** GET only: this room has no other verb to call. */
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, { method: 'GET', headers: t ? { Authorization: 'Bearer ' + t } : {}, credentials: 'include', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open the Neural Digital Twin.'));
        if (r.status === 503) throw new Error(T('The architecture graph was not built with this release.'));
        if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
        return r.json();
      }).then(function (b) { return (b && b.data) || b; });
  }
  /** The fields this room cannot draw without. An absent field is reported, never drawn as empty. */
  var REQUIRED = ['schemaVersion', 'provenance', 'counts', 'nodes', 'edges', 'discrepancies'];

  // ── the graph, indexed ────────────────────────────────────────────────────
  function index(g) {
    S.graph = g; S.byId = {}; S.kids = {}; S.out = {}; S.inc = {}; S.depth = {};
    g.nodes.forEach(function (n) { S.byId[n.id] = n; });
    g.nodes.forEach(function (n) { if (n.parent) (S.kids[n.parent] = S.kids[n.parent] || []).push(n.id); });
    var order = function (a, b) {
      var x = S.byId[a], y = S.byId[b];
      return KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || (x.label < y.label ? -1 : x.label > y.label ? 1 : (a < b ? -1 : 1));
    };
    for (var p in S.kids) S.kids[p].sort(order);
    g.edges.forEach(function (e) { (S.out[e.from] = S.out[e.from] || []).push(e); (S.inc[e.to] = S.inc[e.to] || []).push(e); });
    g.nodes.forEach(function (n) { var d = 0, q = n.parent; while (q) { d++; q = S.byId[q] && S.byId[q].parent; } S.depth[n.id] = d; });
  }
  function ancestors(id) { var out = [], p = S.byId[id] && S.byId[id].parent; while (p) { out.unshift(p); p = S.byId[p] && S.byId[p].parent; } return out; }
  function systemOf(id) { var a = ancestors(id); return a.length ? a[0] : id; }
  function systems() { return (S.graph ? S.graph.nodes : []).filter(function (n) { return n.kind === 'system'; }).sort(function (a, b) { return a.label < b.label ? -1 : 1; }); }

  // ── what is on screen: expanded subtrees, filters, and edges lifted to what is shown ──
  function computeVisible() {
    var vis = {};
    function walk(id) {
      var n = S.byId[id];
      if (!S.kinds[n.kind] && n.kind !== 'system') return;
      vis[id] = true;
      if (S.expanded[id]) (S.kids[id] || []).forEach(walk);
    }
    systems().forEach(function (s) { if (!S.system || S.system === s.id) walk(s.id); });
    S.visible = vis;
    // an edge is drawn between the nearest shown ancestor-or-self of each end, and only then
    S.lifted = L().lift(S.graph.edges, vis, function (id) { return S.byId[id] && S.byId[id].parent; }, function (k) { return !!S.edges[k]; });
    S.path = S.sel && S.pathTo && vis[S.sel] && vis[S.pathTo] ? L().shortestPath(S.lifted, S.sel, S.pathTo) : null;
    // the selection is the node and whatever of it is open on screen: an open module's relationships are its files'
    S.selSet = {};
    if (S.sel && vis[S.sel]) Object.keys(subtree(S.sel)).forEach(function (id) { if (vis[id]) S.selSet[id] = true; });
    S.hiCount = { out: 0, inc: 0, inside: 0, path: S.path ? S.path.edges.length : 0 };
    S.lifted.forEach(function (e) {
      var a = S.selSet[e.from], b = S.selSet[e.to];
      if (a && b) S.hiCount.inside++; else if (a) S.hiCount.out++; else if (b) S.hiCount.inc++;
    });
  }

  // ── layout: deterministic, from the manifest's zones and the graph's own nesting ──
  function bodyOf(id) { var n = S.byId[id], s = KINDS[n.kind].size; return S.expanded[id] && (S.kids[id] || []).length ? s * OPEN_SYSTEM : s; }
  function layout() {
    var t = performance.now();
    var roots = systems().filter(function (s) { return S.visible[s.id]; }).map(function (s) { return { id: s.id, zone: (s.facts && s.facts.zone) || '' }; });
    S.layout = L().layout({
      roots: roots,
      kids: function (id) { return (S.kids[id] || []).filter(function (k) { return S.visible[k]; }); },
      open: function (id) { return !!S.expanded[id]; },
      body: bodyOf,
    });
    S.pos = S.layout.pos;
    S.layoutMs = Math.round((performance.now() - t) * 10) / 10;
  }

  // ── colours from the design tokens, never written here ────────────────────
  var probe = null, colourCache = {};
  /** A token's colour as the browser resolves it, as 0–1 channels: the scene never holds a colour of its own. */
  function tokenRGB(tok) {
    if (colourCache[tok]) return colourCache[tok];
    if (!probe || !probe.isConnected) { probe = document.createElement('span'); probe.className = 'nt-probe'; S.root.appendChild(probe); }
    probe.style.color = 'var(' + tok + ')';
    var c = getComputedStyle(probe).color || '', v = [0.75, 0.75, 0.8], m;
    if ((m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/))) v = [m[1] / 255, m[2] / 255, m[3] / 255];
    else if ((m = c.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/))) v = [Number(m[1]), Number(m[2]), Number(m[3])];
    colourCache[tok] = v;
    return v;
  }

  // ── Babylon, loaded on demand ─────────────────────────────────────────────
  var babylonLoading = null;
  function loadBabylon() {
    if (window.BABYLON && window.BABYLON.Engine) return Promise.resolve(true);
    if (babylonLoading) return babylonLoading;
    babylonLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/vendor/babylon.js'; s.async = true;
      s.onload = function () { resolve(!!(window.BABYLON && window.BABYLON.Engine)); };
      s.onerror = function () { babylonLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return babylonLoading;
  }
  function webglAvailable() {
    try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (_) { return false; }
  }

  function startScene() {
    var canvas = S.root.querySelector('#nt-canvas');
    var B = window.BABYLON, gl = S.gl;
    var engine = new B.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, antialias: true, powerPreference: 'high-performance' }, true);
    var scene = new B.Scene(engine);
    var bg = tokenRGB('--fam-surface-sunken');
    scene.clearColor = new B.Color4(bg[0], bg[1], bg[2], 1);
    scene.skipPointerMovePicking = true;   // nothing answers a hover: picking runs on a tap only
    // No fog, no glow layer and no translucent floors: measured on a software renderer they cost more than half
    // of every frame, and the selection already stands out by its own light, its ring and its arrowheads.
    var cam = new B.ArcRotateCamera('nt-cam', VIEW.alpha, VIEW.beta, 160, new B.Vector3(0, 0, 0), scene);
    cam.lowerRadiusLimit = 3; cam.upperRadiusLimit = 1600; cam.lowerBetaLimit = 0.08; cam.upperBetaLimit = 1.48;
    cam.wheelDeltaPercentage = 0.012; cam.pinchDeltaPercentage = 0.004; cam.panningSensibility = 60;
    cam.inertia = reduceMotion ? 0 : 0.82; cam.panningInertia = reduceMotion ? 0 : 0.82; cam.minZ = 0.3; cam.maxZ = 8000;
    cam.attachControl(canvas, true);
    var hemi = new B.HemisphericLight('nt-sky', new B.Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.85; hemi.groundColor = new B.Color3(bg[0], bg[1], bg[2]);
    var key = new B.DirectionalLight('nt-key', new B.Vector3(-0.4, -1, 0.3), scene); key.intensity = 0.45;
    gl.inst = new B.SceneInstrumentation(scene); gl.inst.captureFrameTime = true;
    gl.engine = engine; gl.scene = scene; gl.camera = cam; gl.ok = true;
    scene.onPointerObservable.add(function (pi) {
      var PT = B.PointerEventTypes;
      if (pi.type !== PT.POINTERTAP && pi.type !== PT.POINTERDOUBLETAP) return;
      var pick = pi.pickInfo, m = pick && pick.hit ? pick.pickedMesh : null, id = m && m.metadata && m.metadata.ntId;
      if (!id) return;
      if (pi.type === PT.POINTERDOUBLETAP) { enter(id); return; }
      if (pi.event && pi.event.shiftKey && S.sel && S.sel !== id) { tracePath(id); return; }
      select(id, { focus: false, reveal: false });
    });
    cam.onViewMatrixChangedObservable.add(function () { gl.dirty = true; });
    ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart', 'touchmove'].forEach(function (t) {
      canvas.addEventListener(t, wake, { passive: true });
      S.cleanup.push(function () { canvas.removeEventListener(t, wake); });
    });
    engine.runRenderLoop(function () {
      // Nothing on this map is live, so an idle scene is not drawn again: frames run while the reader
      // moves the camera, while it settles, while a change unfolds, and then stop.
      if (document.hidden || (!gl.anim && !gl.tween && performance.now() > gl.awakeUntil)) return;
      stepAnimation();
      stepTween();
      chooseDetail();
      scene.render();
      gl.frames++;
      if (gl.dirty) { placeLabels(); gl.dirty = false; }
      if (S.firstFrameMs == null) S.firstFrameMs = Math.round(performance.now() - S.t0);
    });
    // the canvas size is kept from the last resize: read every frame, it forced a style and layout pass each time (measured)
    var measure = function () { gl.cw = canvas.clientWidth; gl.ch = canvas.clientHeight; };
    var onResize = function () { engine.resize(); measure(); gl.dirty = true; wake(); };
    measure();
    window.addEventListener('resize', onResize);
    S.cleanup.push(function () { window.removeEventListener('resize', onResize); });
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(onResize); ro.observe(canvas.parentNode);
      S.cleanup.push(function () { ro.disconnect(); });
    }
  }

  /** Keep drawing for a moment: the camera's inertia settles inside it. */
  function wake() { S.gl.awakeUntil = performance.now() + 1600; }
  function disposeAll(list) { (list || []).forEach(function (m) { try { m.dispose(); } catch (_) {} }); }
  /** A token's colour taken toward the background by k: how strongly something is drawn, without blending. */
  function toward(c, k) {
    var b = tokenRGB('--fam-surface-sunken'), f = Math.max(0, k);
    return new window.BABYLON.Color3(Math.min(1, b[0] + (c[0] - b[0]) * f), Math.min(1, b[1] + (c[1] - b[1]) * f), Math.min(1, b[2] + (c[2] - b[2]) * f));
  }
  var LOOK = { hi: 1.0, near: 0.92, normal: 0.66, dim: 0.22 };
  function material(kind, look, maturity) {
    var B = window.BABYLON, gl = S.gl;
    var wire = maturity === 'PLANNED' || maturity === 'UNVERIFIED', partial = maturity === 'PARTIAL';
    var key = kind + '|' + look + '|' + (wire ? 'w' : partial ? 'p' : 's');
    if (gl.mats[key]) return gl.mats[key];
    var c = tokenRGB(KINDS[kind].tok), k = LOOK[look], m = new B.StandardMaterial('nt-m-' + key, gl.scene);
    m.diffuseColor = new B.Color3(c[0] * 0.3, c[1] * 0.3, c[2] * 0.3);
    m.emissiveColor = new B.Color3(c[0] * k * 0.62, c[1] * k * 0.62, c[2] * k * 0.62);
    m.specularColor = new B.Color3(0.3, 0.3, 0.3); m.specularPower = 64;
    if (!wire && look !== 'dim') {
      // a lit rim: the edge of each body glows in its own colour, its face stays darker
      var f = new B.FresnelParameters();
      f.bias = 0.18; f.power = 2.2;
      f.leftColor = new B.Color3(Math.min(1, c[0] * k * 1.3), Math.min(1, c[1] * k * 1.3), Math.min(1, c[2] * k * 1.3));
      f.rightColor = new B.Color3(c[0] * k * 0.5, c[1] * k * 0.5, c[2] * k * 0.5);
      m.emissiveFresnelParameters = f;
    }
    m.wireframe = wire;
    m.alpha = look === 'dim' ? (partial ? 0.1 : 0.16) : partial ? 0.62 : 1;
    m.freeze();
    gl.mats[key] = m;
    return m;
  }
  /** Each kind's body at two levels of detail, built once and never drawn itself; every node is a copy that shares
   *  its geometry. Shading the bodies' vertices was the largest single cost of a frame (measured: 89,671 vertices for
   *  the 209 bodies of the open systems), so the fine bodies are lighter than before and far views use coarse ones. */
  function template(kind, coarse) {
    var gl = S.gl, B = window.BABYLON, key = kind + (coarse ? '|lo' : '|hi');
    if (gl.templates[key]) return gl.templates[key];
    var kd = KINDS[kind], s = kd.size, m, name = 'nt-t-' + key;
    if (kd.shape === 'ico') m = B.MeshBuilder.CreateIcoSphere(name, { radius: s, subdivisions: coarse ? 1 : 2 }, gl.scene);
    else if (kd.shape === 'box') m = B.MeshBuilder.CreateBox(name, { size: s * 1.4 }, gl.scene);
    else if (kd.shape === 'octa') m = B.MeshBuilder.CreatePolyhedron(name, { type: 1, size: s }, gl.scene);
    else if (kd.shape === 'cyl') m = B.MeshBuilder.CreateCylinder(name, { height: s * 1.5, diameter: s * 1.6, tessellation: coarse ? 10 : 16 }, gl.scene);
    else if (kd.shape === 'capsule') m = B.MeshBuilder.CreateCapsule(name, { height: s * 2.2, radius: s * 0.55, tessellation: coarse ? 8 : 12, subdivisions: 1, capSubdivisions: coarse ? 3 : 5 }, gl.scene);
    else if (kd.shape === 'torus') m = B.MeshBuilder.CreateTorus(name, { diameter: s * 2, thickness: s * 0.45, tessellation: coarse ? 12 : 20 }, gl.scene);
    else m = B.MeshBuilder.CreateSphere(name, { diameter: s * 2, segments: kind === 'file' ? (coarse ? 3 : 6) : (coarse ? 5 : 9) }, gl.scene);
    m.isPickable = false; m.setEnabled(false);
    gl.templates[key] = m;
    return m;
  }
  function meshFor(id) {
    var gl = S.gl;
    if (gl.meshes[id]) return gl.meshes[id];
    var n = S.byId[id], m = template(n.kind, gl.far).clone('nt-n', null, true);
    m.metadata = { ntId: id, kind: n.kind };
    m.isPickable = true;
    // a source file is a speck from far away: past this distance it is not drawn, and its label is not shown
    if (n.kind === 'file') m.addLODLevel(FILE_LOD, null);
    gl.meshes[id] = m;
    return m;
  }
  /** Coarse bodies past one camera distance, fine ones again inside a shorter one, so the switch never flickers.
   *  A switch hands each body its kind's other shared geometry; nothing is created. */
  function chooseDetail() {
    var gl = S.gl, r = gl.camera.radius, far = gl.far ? r > LOD_FAR[1] : r > LOD_FAR[0];
    if (far === gl.far) return;
    gl.far = far;
    for (var id in gl.meshes) {
      var m = gl.meshes[id], t = template(m.metadata.kind, far);
      if (t.geometry) t.geometry.applyToMesh(m);
    }
  }
  /** Where a node is drawn now (mid-way through a move, the body's own position). */
  function nodePoint(id) {
    var m = S.gl.meshes[id];
    if (m && m.isEnabled()) return [m.position.x, m.position.y, m.position.z];
    return S.pos[id] || null;
  }
  function drawnRadius(id) { return bodyOf(id) * (id === S.sel ? 1.3 : 1) * 1.08; }

  /** Bring the scene in line with what is visible, selected and filtered. Nodes that moved slide to their new place. */
  function paintScene(prevPos) {
    var gl = S.gl;
    if (!gl.ok) return;
    S.near = neighbours();
    var focus = !!(S.sel && S.visible[S.sel]) || !!S.path, moves = [], unfold = 0;
    for (var id in gl.meshes) if (!S.visible[id]) gl.meshes[id].setEnabled(false);
    Object.keys(S.visible).forEach(function (id) {
      var m = meshFor(id), n = S.byId[id], p = S.pos[id];
      if (!p) { m.setEnabled(false); return; }
      var from = null;
      if (prevPos && !reduceMotion) {
        if (m.isEnabled() && prevPos[id]) from = [m.position.x, m.position.y, m.position.z];
        else { var a = ancestors(id).reverse(); for (var i = 0; i < a.length && !from; i++) if (prevPos[a[i]]) { from = prevPos[a[i]]; unfold++; } }
      }
      m.setEnabled(true);
      if (from && (Math.abs(from[0] - p[0]) + Math.abs(from[1] - p[1]) + Math.abs(from[2] - p[2])) > 0.01) {
        moves.push({ m: m, from: from, to: p });
        m.position.set(from[0], from[1], from[2]);
      } else m.position.set(p[0], p[1], p[2]);
      var look = !focus ? 'normal' : id === S.sel ? 'hi' : S.near[id] ? 'near' : 'dim';
      var scale = (S.expanded[id] && (S.kids[id] || []).length ? OPEN_SYSTEM : 1) * (id === S.sel ? 1.3 : 1);
      m.scaling.set(scale, scale, scale);
      m.material = material(n.kind, look, n.maturity);
    });
    var key = Object.keys(S.visible).sort().join('|') + '#' + Object.keys(S.expanded).filter(function (k) { return S.expanded[k]; }).sort().join('|');
    if (key !== gl.layoutKey) { gl.layoutKey = key; paintPlatforms(); }
    if (moves.length) {
      // lines are drawn again once the nodes have arrived: a line between two moving ends would be wrong mid-way
      disposeAll(gl.edgeMeshes); disposeAll(gl.hiMeshes); disposeAll(gl.arrows);
      gl.edgeMeshes = []; gl.hiMeshes = []; gl.arrows = [];
      gl.tween = { moves: moves, t0: performance.now(), ms: 460 };
    } else { gl.tween = null; paintEdges(); }
    gl.lastMove = { nodes: moves.length, unfold: unfold, ms: moves.length ? 460 : 0 };
    gl.dirty = true;
    wake();
  }
  function stepTween() {
    var gl = S.gl, tw = gl.tween;
    if (!tw) return;
    var t = Math.min(1, (performance.now() - tw.t0) / tw.ms), k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    tw.moves.forEach(function (mv) {
      mv.m.position.set(mv.from[0] + (mv.to[0] - mv.from[0]) * k, mv.from[1] + (mv.to[1] - mv.from[1]) * k, mv.from[2] + (mv.to[2] - mv.from[2]) * k);
    });
    gl.dirty = true;
    if (t >= 1) { gl.tween = null; paintEdges(); }
  }

  // ── platforms and zones: the nesting, drawn as floors and boundaries ──────
  function circle(x, y, z, r) {
    var n = Math.max(48, Math.min(160, Math.round(r * 5))), out = [];
    for (var i = 0; i <= n; i++) { var a = (i / n) * Math.PI * 2; out.push(x + Math.cos(a) * r, y, z + Math.sin(a) * r); }
    return out;
  }
  function platformMat(kind) {
    var gl = S.gl, B = window.BABYLON, key = 'pf|' + kind;
    if (gl.mats[key]) return gl.mats[key];
    var c = tokenRGB(KINDS[kind].tok), m = new B.StandardMaterial('nt-' + key, gl.scene);
    m.disableLighting = true; m.backFaceCulling = false;
    m.diffuseColor = new B.Color3(0, 0, 0); m.specularColor = new B.Color3(0, 0, 0);
    m.emissiveColor = toward(c, 0.1); m.alpha = 1;
    m.freeze();
    gl.mats[key] = m;
    return m;
  }
  function paintPlatforms() {
    var gl = S.gl, B = window.BABYLON, lay = S.layout;
    disposeAll(gl.platforms); gl.platforms = [];
    if (!gl.ok || !lay) return;
    var rings = { lines: [], cols: [] }, zones = { lines: [], cols: [] }, unplaced = { lines: [], cols: [] };
    lay.platforms.forEach(function (p) {
      var n = S.byId[p.id], c = tokenRGB(KINDS[n.kind].tok);
      var disc = B.MeshBuilder.CreateDisc('nt-pf', { radius: p.r, tessellation: 64 }, gl.scene);
      disc.rotation.x = Math.PI / 2; disc.position.set(p.x, p.y - 0.55, p.z);
      disc.isPickable = false; disc.material = platformMat(n.kind);
      gl.platforms.push(disc);
      var ring = circle(p.x, p.y - 0.52, p.z, p.r), col = toward(c, 0.55);
      rings.lines.push(ring); for (var i = 0; i < ring.length; i += 3) rings.cols.push(col);
    });
    lay.zones.forEach(function (z) {
      var pts = circle(z.x, -0.8, z.z, z.r), into = z.unplaced ? unplaced : zones;
      var col = z.unplaced ? toward(tokenRGB('--fam-status-unverified'), 0.8) : toward(tokenRGB('--fam-text-tertiary'), 0.55);
      dashes(pts, z.unplaced ? 2.2 : 3.2, z.unplaced ? 1.6 : 2.2).forEach(function (piece) {
        into.lines.push(piece); for (var i = 0; i < piece.length; i += 3) into.cols.push(col);
      });
    });
    [[rings, 1.4], [zones, 1.2], [unplaced, 1.8]].forEach(function (g, i) {
      var m = lineMesh('nt-ring-' + i, g[0].lines, g[0].cols, g[1]);
      if (m) gl.platforms.push(m);
    });
  }

  // ── relationships: lifted arcs, brighter toward the end they point to ────
  /** GreasedLine units per CSS pixel. With sizeAttenuation on, its width is a constant on screen (about 2.5 units
   *  to a device pixel, measured), so a line is as wide near the camera as far from it. */
  function pxUnit() {
    var gl = S.gl, c = S.root.querySelector('#nt-canvas'), w = gl.engine.getRenderWidth();
    return (w / ((c && c.clientWidth) || w)) * 2.5;
  }
  function lineMesh(name, lines, cols, px) {
    if (!lines.length) return null;
    var m = window.BABYLON.CreateGreasedLine(name, { points: lines }, { materialType: 2, width: px * pxUnit(), useColors: true, colors: cols, colorDistribution: 0, sizeAttenuation: true }, S.gl.scene);
    m.isPickable = false;
    return m;
  }
  /** A relationship's curve, from the surface of one body to the surface of the other, as a flat list of points. */
  function arc(a, b, lift, ra, rb, fine) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var h = Math.min(70, 0.4 + lift * d), t0 = Math.min(0.45, ra / d), t1 = Math.max(0.55, 1 - rb / d);
    // a shallow parabola reads as a curve with few points; the many unselected lines get fewer, the selection's keep more
    var seg = fine ? Math.max(6, Math.min(24, Math.round(d / 2.5))) : Math.max(5, Math.min(12, Math.round(d / 5))), out = [];
    for (var i = 0; i <= seg; i++) {
      var t = t0 + (t1 - t0) * (i / seg);
      out.push(a[0] + dx * t, a[1] + dy * t + 4 * h * t * (1 - t), a[2] + dz * t);
    }
    return out;
  }
  /** A curve cut into dashes [on] long with [off] between, each a curve of its own. */
  function dashes(pts, on, off) {
    // the distance left in the current dash or gap is carried along, never recomputed from a running total,
    // so rounding can neither stall the walk nor drift the pattern
    var out = [], drawing = true, left = on, cur = [pts[0], pts[1], pts[2]];
    for (var i = 0; i + 5 < pts.length; i += 3) {
      var ax = pts[i], ay = pts[i + 1], az = pts[i + 2], dx = pts[i + 3] - ax, dy = pts[i + 4] - ay, dz = pts[i + 5] - az;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz), s = 0;
      while (len - s > 1e-9) {
        var step = Math.min(left, len - s);
        s += step; left -= step;
        var f = s / len, x = ax + dx * f, y = ay + dy * f, z = az + dz * f;
        if (drawing && cur) cur.push(x, y, z);
        if (left <= 1e-9) {
          if (drawing) { if (cur && cur.length >= 6) out.push(cur); cur = null; }
          else cur = [x, y, z];
          drawing = !drawing; left = drawing ? on : off;
        }
      }
    }
    if (cur && cur.length >= 6) out.push(cur);
    return out;
  }
  function arrowTemplate(kind) {
    var gl = S.gl, B = window.BABYLON, key = 'arrow|' + kind;
    if (gl.templates[key]) return gl.templates[key];
    var m = B.MeshBuilder.CreateCylinder('nt-' + key, { height: 1.6, diameterTop: 0, diameterBottom: 0.85, tessellation: 14 }, gl.scene);
    var mat = new B.StandardMaterial('nt-m-' + key, gl.scene), c = tokenRGB(EDGES[kind].tok);
    mat.disableLighting = true; mat.emissiveColor = new B.Color3(c[0], c[1], c[2]); mat.freeze();
    m.material = mat; m.isPickable = false; m.setEnabled(false);
    gl.templates[key] = m;
    return m;
  }
  /** The head of a highlighted relationship: a cone at the end it points to, along the curve. */
  function arrowAt(pts, kind) {
    var B = window.BABYLON, n = pts.length;
    var ex = pts[n - 3], ey = pts[n - 2], ez = pts[n - 1], dx = ex - pts[n - 6], dy = ey - pts[n - 5], dz = ez - pts[n - 4];
    var l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1, cx = ex - pts[0], cy = ey - pts[1], cz = ez - pts[2];
    var s = Math.max(0.25, Math.min(0.85, Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.022));
    var dir = new B.Vector3(dx / l, dy / l, dz / l), m = arrowTemplate(kind).clone('nt-a', null, true);
    m.setEnabled(true); m.isPickable = false;
    m.scaling.set(s, s, s);
    m.rotationQuaternion = new B.Quaternion();
    B.Quaternion.FromUnitVectorsToRef(B.Vector3.Up(), dir, m.rotationQuaternion);
    m.position.set(ex - dir.x * s * 0.8, ey - dir.y * s * 0.8, ez - dir.z * s * 0.8);
    S.gl.arrows.push(m);
  }
  /** Draw the relationships: every line is a lifted graph edge, and nothing else is drawn as one. */
  function paintEdges() {
    var gl = S.gl;
    if (!gl.ok) return;
    disposeAll(gl.edgeMeshes); disposeAll(gl.hiMeshes); disposeAll(gl.arrows);
    gl.edgeMeshes = []; gl.hiMeshes = []; gl.arrows = [];
    var sel = S.sel && S.visible[S.sel] ? S.sel : null, onPath = {};
    if (S.path) S.path.edges.forEach(function (i) { onPath[i] = true; });
    var amb = [], hi = [];
    S.lifted.forEach(function (e, i) { if (onPath[i] || (sel && (S.selSet[e.from] || S.selSet[e.to]))) hi.push(i); else amb.push(i); });
    var byWeight = function (a, b) { return S.lifted[b].weight - S.lifted[a].weight || a - b; };
    if (hi.length > HIGHLIGHT_BUDGET) hi = hi.slice().sort(function (a, b) { return (onPath[b] ? 1 : 0) - (onPath[a] ? 1 : 0) || byWeight(a, b); }).slice(0, HIGHLIGHT_BUDGET).sort(function (a, b) { return a - b; });
    var focus = !!(sel || S.path), showAmb = S.intensity > 0 && !(S.focusOnly && focus);
    S.cut = 0; S.ambientTotal = amb.length;
    if (!showAmb) amb = [];
    else if (amb.length > EDGE_BUDGET) { var keep = amb.slice().sort(byWeight).slice(0, EDGE_BUDGET); S.cut = amb.length - keep.length; amb = keep.sort(function (a, b) { return a - b; }); }
    buildEdges(amb, false, S.intensity * (focus ? 0.3 : 1));
    buildEdges(hi, true, Math.max(0.85, Math.min(1.2, S.intensity + 0.4)));
    if (sel) {
      // the selection's own ring, on the floor under it
      var p = nodePoint(sel), col = toward(tokenRGB('--fam-focus-ring'), 1), ring = circle(p[0], p[1] - drawnRadius(sel) * 0.9, p[2], drawnRadius(sel) * 1.7), cols = [];
      for (var i = 0; i < ring.length; i += 3) cols.push(col);
      var rm = lineMesh('nt-sel-ring', [ring], cols, 2.2);
      if (rm) gl.hiMeshes.push(rm);
    }
    S.drawn = amb.concat(hi).sort(function (a, b) { return a - b; });
    paintStageNote();
    gl.dirty = true;
    wake();
  }
  function buildEdges(list, strong, k) {
    var groups = {};
    list.forEach(function (i) { var e = S.lifted[i]; (groups[e.kind] = groups[e.kind] || []).push(e); });
    EDGE_ORDER.forEach(function (kind) {
      var es = groups[kind];
      if (!es) return;
      var st = EDGE_STYLE[kind], c = tokenRGB(EDGES[kind].tok), lines = [], cols = [];
      es.forEach(function (e) {
        var a = nodePoint(e.from), b = nodePoint(e.to);
        if (!a || !b) return;
        var pts = arc(a, b, st.lift, drawnRadius(e.from), drawnRadius(e.to), strong);
        var ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ab2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1, len = Math.sqrt(ab2);
        var wk = strong ? 1 : Math.min(1, 0.5 + 0.14 * Math.log(1 + e.weight) / Math.LN2), base = strong ? 0.45 : 0.24;
        var pieces = st.dash ? dashes(pts, st.dash[0] * Math.max(1, len / 14), st.dash[1] * Math.max(1, len / 14)) : [pts];
        pieces.forEach(function (piece) {
          lines.push(piece);
          for (var j = 0; j < piece.length; j += 3) {
            var t = ((piece[j] - a[0]) * ab[0] + (piece[j + 1] - a[1]) * ab[1] + (piece[j + 2] - a[2]) * ab[2]) / ab2;
            cols.push(toward(c, k * wk * (base + (1 - base) * Math.max(0, Math.min(1, t)))));
          }
        });
        if (strong) arrowAt(pts, kind);
      });
      var m = lineMesh('nt-e-' + kind + (strong ? '-hi' : ''), lines, cols, st.px * (strong ? 1.9 : 1));
      if (m) (strong ? S.gl.hiMeshes : S.gl.edgeMeshes).push(m);
    });
  }
  /** The nodes joined to the selection by a drawn edge, its ancestors and children, and the path's nodes. */
  function neighbours() {
    var out = {};
    if (S.path) S.path.nodes.forEach(function (id) { out[id] = true; });
    if (!S.sel) return out;
    S.lifted.forEach(function (e) {
      var a = S.selSet[e.from], b = S.selSet[e.to];
      if (a && !b) out[e.to] = true;
      if (b && !a) out[e.from] = true;
    });
    Object.keys(S.selSet).forEach(function (id) { out[id] = true; });
    ancestors(S.sel).forEach(function (a) { out[a] = true; });
    (S.kids[S.sel] || []).forEach(function (k) { out[k] = true; });
    delete out[S.sel];
    return out;
  }

  // ── labels: names over the scene, kept apart so none covers another ─────
  function labelCandidates() {
    var out = {}, focus = !!(S.sel && S.visible[S.sel]) || !!S.path;
    Object.keys(S.visible).forEach(function (id) {
      var n = S.byId[id], pri = n.kind === 'system' ? 3 : S.expanded[id] && (S.kids[id] || []).length ? 4 : 5 + S.depth[id];
      if (focus && !S.near[id] && id !== S.sel) pri += 10;
      out[id] = pri;
    });
    Object.keys(S.near).forEach(function (id) { if (S.visible[id]) out[id] = S.path && S.path.nodes.indexOf(id) >= 0 ? 1 : 2; });
    if (S.sel && S.visible[S.sel]) out[S.sel] = 0;
    return out;
  }
  function paintLabels() {
    var host = S.root && S.root.querySelector('#nt-labels');
    if (!host) return;
    var want = labelCandidates(), html = '', focus = !!(S.sel && S.visible[S.sel]) || !!S.path;
    S.labelPri = want;
    Object.keys(want).forEach(function (id) {
      var n = S.byId[id], cls = id === S.sel ? ' is-sel' : S.near[id] ? ' is-near' : focus ? ' is-dim' : '';
      html += '<span class="nt-label nt-label--' + n.kind + cls + '" data-nt-label="' + esc(id) + '">' + data(n.label) + '</span>';
    });
    ((S.layout && S.layout.zones) || []).forEach(function (z) {
      if (!z.unplaced && ZONE_NAMES[z.zone]) html += '<span class="nt-label nt-label--zone" data-nt-zone="' + esc(z.zone) + '">' + esc(T(ZONE_NAMES[z.zone])) + '</span>';
    });
    host.innerHTML = html;
    S.labels = [].slice.call(host.querySelectorAll('.nt-label'));
    // measured once, while every label is laid out, so the declutter never reads the page while the camera moves
    S.labelSize = {};
    S.labels.forEach(function (el) { S.labelSize[labelKey(el)] = [el.offsetWidth, el.offsetHeight]; });
    S.labels.forEach(function (el) { el.hidden = true; });
    S.gl.dirty = true;
  }
  function labelKey(el) { var z = el.getAttribute('data-nt-zone'); return z != null ? 'zone:' + z : el.getAttribute('data-nt-label'); }
  function placeLabels() {
    var gl = S.gl, B = window.BABYLON;
    if (!gl.ok || !S.labels.length) return;
    var w = gl.engine.getRenderWidth(), h = gl.engine.getRenderHeight();
    var cw = gl.cw || w, ch = gl.ch || h, scale = cw / w;
    var tm = gl.scene.getTransformMatrix(), vp = gl.camera.viewport.toGlobal(w, h), I = B.Matrix.Identity(), v = new B.Vector3(0, 0, 0), eye = gl.camera.position;
    var boxes = [], at = {}, zones = {};
    ((S.layout && S.layout.zones) || []).forEach(function (z) { zones[z.zone] = z; });
    S.labels.forEach(function (el) {
      var k = labelKey(el), p = null, pri;
      if (k.indexOf('zone:') === 0) { var z = zones[k.slice(5)]; if (z) p = [z.x, -0.8, z.z + z.r]; pri = 3.5; }
      else {
        var m = gl.meshes[k];
        if (m && m.isEnabled()) p = [m.position.x, m.position.y, m.position.z];
        pri = S.labelPri[k];
        if (p && S.byId[k].kind === 'file' && k !== S.sel && !S.near[k] && B.Vector3.Distance(eye, m.position) > FILE_LOD) p = null;
      }
      if (!p) return;
      v.set(p[0], p[1], p[2]);
      var s = B.Vector3.Project(v, I, tm, vp);
      if (s.z < 0 || s.z > 1) return;
      var x = s.x * scale, y = s.y * scale, sz = S.labelSize[k] || [80, 18];
      if (x < 0 || x > cw || y < 0 || y > ch + sz[1]) return;
      // a label near the edge slides inward rather than being cut by it
      x = Math.max(sz[0] / 2 + 4, Math.min(cw - sz[0] / 2 - 4, x));
      boxes.push({ id: k, x: x - sz[0] / 2, y: y - sz[1] - 12, w: sz[0], h: sz[1], pri: pri + s.z * 0.5 });
      at[k] = [x, y];
    });
    var keep = L().declutter(boxes, 3), shown = 0;
    // the page is written only where a label appears, disappears or moves: a moving camera touches what changed
    S.labels.forEach(function (el) {
      var k = labelKey(el);
      if (!keep[k]) { if (!el.hidden) el.hidden = true; return; }
      shown++;
      if (el.hidden) el.hidden = false;
      var t = 'translate(' + Math.round(at[k][0]) + 'px,' + Math.round(at[k][1]) + 'px)';
      if (el.__ntT !== t) { el.__ntT = t; el.style.transform = t; }
    });
    S.labelsShown = shown;
  }

  // ── camera: framing, flights, and the way back ───────────────────────────
  function fitRadius(r) {
    var gl = S.gl, cam = gl.camera, w = gl.engine.getRenderWidth(), h = gl.engine.getRenderHeight();
    var half = Math.min(cam.fov / 2, Math.atan(Math.tan(cam.fov / 2) * (w / Math.max(1, h))));
    return Math.max(4, (r / Math.sin(half)) * 1.02);
  }
  /** The whole map, from the south, looking north. */
  function overviewView() {
    var zs = (S.layout && S.layout.zones) || [], x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    zs.forEach(function (z) { x0 = Math.min(x0, z.x - z.r); x1 = Math.max(x1, z.x + z.r); z0 = Math.min(z0, z.z - z.r); z1 = Math.max(z1, z.z + z.r); });
    if (!zs.length) { x0 = z0 = -20; x1 = z1 = 20; }
    var R = Math.max(x1 - x0, z1 - z0) / 2, e = S.gl.engine, tall = e.getRenderHeight() > e.getRenderWidth();
    // seen at an angle the floor is shorter than it is wide, so a wide screen can come closer than a tall one
    return { t: [(x0 + x1) / 2, 0, (z0 + z1) / 2], a: VIEW.alpha, b: VIEW.beta, r: fitRadius(R) * (tall ? 1.0 : 0.86) };
  }
  /** The view that frames one node: an open one with everything on its platform; a closed one with every node it is
   *  joined to by a drawn relationship, so the lines the selection lights up end on screen. */
  function viewFor(id) {
    var p = S.pos[id], cam = S.gl.camera, bub = (S.layout && S.layout.bubble) || {};
    if (!p) return null;
    if (S.expanded[id] && (S.kids[id] || []).length) return { t: [p[0], p[1], p[2]], a: cam.alpha, b: cam.beta, r: fitRadius(bub[id] || 10) * 0.86 };
    var x0 = p[0] - 6, x1 = p[0] + 6, z0 = p[2] - 6, z1 = p[2] + 6;
    S.lifted.forEach(function (e) {
      var o = e.from === id ? e.to : e.to === id ? e.from : null, q = o && S.pos[o];
      if (q) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
    });
    var R = Math.max(x1 - x0, z1 - z0) / 2 + 3;
    return { t: [(x0 + x1) / 2, p[1], (z0 + z1) / 2], a: cam.alpha, b: cam.beta, r: fitRadius(R) * 0.9 };
  }
  function cameraNow() {
    var c = S.gl.camera;
    return c ? { t: [c.target.x, c.target.y, c.target.z], a: c.alpha, b: c.beta, r: c.radius } : null;
  }
  function applyView(v) {
    var cam = S.gl.camera, B = window.BABYLON;
    cam.inertialAlphaOffset = cam.inertialBetaOffset = cam.inertialRadiusOffset = 0;
    cam.setTarget(new B.Vector3(v.t[0], v.t[1], v.t[2]), false, false, true);
    cam.alpha = v.a; cam.beta = v.b; cam.radius = v.r;
    S.gl.dirty = true;
  }
  function flyTo(v) {
    var gl = S.gl;
    if (!gl.ok || !v) return;
    wake();
    if (reduceMotion) { gl.anim = null; applyView(v); return; }
    var from = cameraNow(), da = v.a - from.a;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    gl.camera.inertialAlphaOffset = gl.camera.inertialBetaOffset = gl.camera.inertialRadiusOffset = 0;
    gl.anim = { from: from, to: { t: v.t, a: from.a + da, b: v.b, r: v.r }, t0: performance.now(), ms: 560 };
  }
  function stepAnimation() {
    var gl = S.gl, a = gl.anim;
    if (!a) return;
    var t = Math.min(1, (performance.now() - a.t0) / a.ms), k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    var f = a.from, to = a.to, lerp = function (x, y) { return x + (y - x) * k; };
    applyView({ t: [lerp(f.t[0], to.t[0]), lerp(f.t[1], to.t[1]), lerp(f.t[2], to.t[2])], a: lerp(f.a, to.a), b: lerp(f.b, to.b), r: lerp(f.r, to.r) });
    if (t >= 1) gl.anim = null;
  }
  function focusOn(id) { flyTo(viewFor(id)); }
  function resetView() { flyTo(overviewView()); }
  /** Where the reader is, kept before a move into the map, so Back returns to exactly here. */
  function pushHistory() {
    var ex = {};
    Object.keys(S.expanded).forEach(function (k) { if (S.expanded[k]) ex[k] = true; });
    S.history.push({ sel: S.sel, pathTo: S.pathTo, system: S.system, expanded: ex, cam: S.gl.ok ? cameraNow() : null });
    if (S.history.length > 40) S.history.shift();
  }
  function back() {
    var h = S.history.pop();
    if (!h) return;
    S.sel = h.sel; S.pathTo = h.pathTo; S.system = h.system; S.expanded = h.expanded; S.showAll = {};
    refresh({ view: h.cam });
    announce(T('Back to the previous view'));
  }

  // ── what the reader does ──────────────────────────────────────────────────
  function refresh(opts) {
    opts = opts || {};
    var prev = S.pos;
    computeVisible(); layout(); paintScene(prev); paintLabels();
    paintExplorer(); paintInspector(); paintTools();
    if (opts.focus && S.sel) focusOn(S.sel);
    else if (opts.view) flyTo(opts.view);
    else if (opts.overview) resetView();
  }
  function select(id, opts) {
    opts = opts || {};
    if (!S.byId[id]) return;
    var focus = opts.focus !== false;
    if (focus && S.gl.ok) pushHistory();
    if (opts.reveal !== false) ancestors(id).forEach(function (a) { S.expanded[a] = true; });
    if (S.system && systemOf(id) !== S.system) S.system = '';
    if (!S.kinds[S.byId[id].kind]) S.kinds[S.byId[id].kind] = true;
    S.sel = id; S.pathTo = null; S.showAll = {};
    refresh({ focus: focus });
    announce(T(KINDS[S.byId[id].kind].name) + ': ' + S.byId[id].label);
  }
  function toggle(id, open) {
    if (!(S.kids[id] || []).length) return;
    S.expanded[id] = open == null ? !S.expanded[id] : open;
    if (!S.expanded[id]) Object.keys(S.expanded).forEach(function (x) { if (ancestors(x).indexOf(id) >= 0) delete S.expanded[x]; });
    refresh();
  }
  /** Entering a node: keep where the reader was, then select it, open it and bring the camera onto its platform. */
  function enter(id) {
    if (!S.byId[id]) return;
    if (S.gl.ok) pushHistory();
    ancestors(id).forEach(function (a) { S.expanded[a] = true; });
    if ((S.kids[id] || []).length) S.expanded[id] = true;
    S.sel = id; S.pathTo = null; S.showAll = {};
    refresh({ focus: true });
    announce(T(KINDS[S.byId[id].kind].name) + ': ' + S.byId[id].label);
  }
  /** The fewest drawn relationships between the selection and another node, highlighted in the scene. */
  function tracePath(id) {
    if (!S.sel || !S.byId[id] || id === S.sel) return;
    ancestors(id).forEach(function (a) { S.expanded[a] = true; });
    S.pathTo = id;
    refresh();
    announce(!S.path ? T('No directed path between these two at this level.') : S.path.edges.length === 1 ? T('Path: 1 step') : tf('Path: %d steps', S.path.edges.length));
  }
  function paintTools() {
    if (!S.root) return;
    var b = S.root.querySelector('[data-nt-action="history-back"]');
    if (b) b.disabled = !S.history.length;
    var f = S.root.querySelector('[data-nt-action="focus-only"]');
    if (f) f.setAttribute('aria-pressed', String(!!S.focusOnly));
  }
  function paintStageNote() {
    var el = S.root && S.root.querySelector('#nt-stagenote');
    if (!el) return;
    if (S.cut > 0) { el.hidden = false; el.textContent = tf('Drawing the %d strongest of %d relationships at this level. Select a node to see every one of its own.', S.ambientTotal - S.cut, S.ambientTotal); }
    else { el.hidden = true; el.textContent = ''; }
  }
  function announce(msg) { var l = S.root && S.root.querySelector('#nt-live'); if (l) l.textContent = msg; }

  // ── the shell ─────────────────────────────────────────────────────────────
  function shellHtml() {
    var langs = NT_LOCALES.map(function (l) {
      return '<button type="button" class="nt-lang' + (l[0] === NT_LANG ? ' is-on' : '') + '" data-nt-lang="' + l[0] + '" lang="' + l[0] + '" aria-pressed="' + (l[0] === NT_LANG) + '">' + l[0].toUpperCase() + '</button>';
    }).join('');
    return '<div class="nt-shell">'
      + '<header class="nt-top">'
      + '<div class="nt-top-l"><button type="button" class="nt-back" data-nt-action="back"><span aria-hidden="true">←</span> ' + esc(T('Owner Control')) + '</button>'
      + '<div class="nt-brand"><span class="nt-mark" aria-hidden="true">' + markSvg() + '</span><div class="nt-brand-t">'
      + '<div class="nt-eyebrow">' + esc(T('Familista · Platform owner')) + '</div>'
      + '<h1 class="nt-title">' + esc(T('Neural Digital Twin')) + '</h1>'
      + '<p class="nt-sub">' + esc(T('The platform\'s architecture, drawn from its own evidence. Read-only.')) + '</p></div></div></div>'
      + '<div class="nt-top-r"><div class="nt-stats" id="nt-stats"></div>'
      + '<div class="nt-langs" role="group" aria-label="' + esc(T('Language')) + '">' + langs + '</div>'
      + '<button type="button" class="nt-btn" data-nt-action="reload">' + esc(T('Refresh')) + '</button></div>'
      + '</header>'
      + '<div class="nt-work">'
      + '<aside class="nt-explorer" aria-label="' + esc(T('Explorer')) + '">'
      + '<div class="nt-search"><label class="nt-sr" for="nt-q">' + esc(T('Search the architecture')) + '</label>'
      + '<input id="nt-q" class="nt-input" type="search" autocomplete="off" spellcheck="false" placeholder="' + esc(T('Search systems, files, APIs, agents…')) + '"></div>'
      + '<div class="nt-filters" id="nt-filters"></div>'
      + '<div class="nt-tree" id="nt-tree"></div>'
      + '</aside>'
      + '<section class="nt-stage" aria-label="' + esc(T('3D architecture view')) + '">'
      + '<canvas id="nt-canvas" class="nt-canvas" tabindex="0" aria-label="' + esc(T('3D view of the architecture graph. Drag to rotate, right-drag to pan, scroll to zoom. The explorer lists the same graph.')) + '"></canvas>'
      + '<div class="nt-labels" id="nt-labels" aria-hidden="true"></div>'
      + '<div class="nt-glmsg" id="nt-glmsg" hidden></div>'
      + '<div class="nt-tools" role="toolbar" aria-label="' + esc(T('View')) + '">'
      + '<button type="button" class="nt-tool nt-tool--wide nt-tool--back" data-nt-action="history-back" aria-keyshortcuts="Backspace" aria-label="' + esc(T('Back to the previous view')) + '"' + (S.history.length ? '' : ' disabled') + '><span aria-hidden="true">←</span> ' + esc(T('Back')) + '</button>'
      + '<button type="button" class="nt-tool" data-nt-action="zoom-in" aria-label="' + esc(T('Zoom in')) + '">+</button>'
      + '<button type="button" class="nt-tool" data-nt-action="zoom-out" aria-label="' + esc(T('Zoom out')) + '">−</button>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="reset">' + esc(T('Reset view')) + '</button>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="expand-all">' + esc(T('Open all systems')) + '</button>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="collapse-all">' + esc(T('Close all')) + '</button>'
      + '</div>'
      + '<div class="nt-edgectl" role="group" aria-label="' + esc(T('Connections')) + '">'
      + '<label class="nt-edgectl-l" for="nt-intensity">' + esc(T('Connections')) + '</label>'
      + '<input id="nt-intensity" class="nt-range" type="range" min="0" max="100" step="5" value="' + Math.round(S.intensity * 60) + '" aria-describedby="nt-intensity-d">'
      + '<span class="nt-sr" id="nt-intensity-d">' + esc(T('How strongly the relationships not touching the selection are drawn.')) + '</span>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="focus-only" aria-pressed="' + !!S.focusOnly + '">' + esc(T('Selection only')) + '</button>'
      + '</div>'
      + '<p class="nt-stagenote" id="nt-stagenote" role="status" hidden></p>'
      + '<details class="nt-legend" id="nt-legend" open></details>'
      + '</section>'
      + '<aside class="nt-inspector" id="nt-inspector" tabindex="0" aria-label="' + esc(T('Inspector')) + '"></aside>'
      + '</div>'
      + '<div class="nt-sr" id="nt-live" aria-live="polite"></div>'
      + '</div>';
  }
  function markSvg() {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">'
      + '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/>'
      + '<path d="M6.7 7.1l3.4 3.2M17.3 6.2l-3.5 4.1M6.6 16.8l3.5-3.1M17.4 16.9l-3.4-3.2"/></svg>';
  }
  function glyph(kind) {
    var s = KINDS[kind] ? KINDS[kind].shape : 'sphere', p;
    if (s === 'ico') p = '<polygon points="8,1 15,5 15,11 8,15 1,11 1,5"/>';
    else if (s === 'box') p = '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>';
    else if (s === 'octa') p = '<polygon points="8,1 15,8 8,15 1,8"/>';
    else if (s === 'cyl') p = '<ellipse cx="8" cy="3.5" rx="6" ry="2.2"/><path d="M2 3.5v9c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2v-9"/>';
    else if (s === 'capsule') p = '<rect x="4.5" y="1" width="7" height="14" rx="3.5"/>';
    else if (s === 'torus') p = '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2.6"/>';
    else p = '<circle cx="8" cy="8" r="6"/>';
    return '<svg class="nt-glyph nt-k-' + kind + '" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' + p + '</svg>';
  }

  // ── the explorer: filters, search, the outline ────────────────────────────
  function paintExplorer() {
    var f = S.root.querySelector('#nt-filters'), t = S.root.querySelector('#nt-tree');
    if (!f || !t || !S.graph) return;
    var counts = S.graph.counts || { nodes: {}, edges: {} };
    var sysOpts = '<option value="">' + esc(T('All systems')) + '</option>' + systems().map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (S.system === s.id ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    }).join('');
    f.innerHTML = '<label class="nt-flabel" for="nt-system">' + esc(T('System')) + '</label>'
      + '<select id="nt-system" class="nt-input" data-nt-filter="system">' + sysOpts + '</select>'
      + '<div class="nt-flabel">' + esc(T('Show')) + '</div><div class="nt-chips">' + KIND_ORDER.filter(function (k) { return k !== 'system'; }).map(function (k) {
        return '<button type="button" class="nt-chip" data-nt-kind="' + k + '" aria-pressed="' + !!S.kinds[k] + '">' + glyph(k) + '<span>' + esc(T(KINDS[k].plural)) + '</span><span class="nt-chip-n">' + num(counts.nodes[k] || 0) + '</span></button>';
      }).join('') + '</div>'
      + '<div class="nt-flabel">' + esc(T('Relationships')) + '</div><div class="nt-chips">' + EDGE_ORDER.map(function (k) {
        return '<button type="button" class="nt-chip nt-chip--edge nt-e-' + k + '" data-nt-edge="' + k + '" aria-pressed="' + !!S.edges[k] + '"><span class="nt-swatch" aria-hidden="true"></span><span>' + esc(T(EDGES[k].name)) + '</span><span class="nt-chip-n">' + num(counts.edges[k] || 0) + '</span></button>';
      }).join('') + '</div>';
    var q = S.q.trim().toLowerCase();
    if (q) {
      var hits = S.graph.nodes.filter(function (n) { return n.label.toLowerCase().indexOf(q) >= 0 || n.id.toLowerCase().indexOf(q) >= 0; }).slice(0, 60);
      t.innerHTML = '<div class="nt-flabel">' + esc(tf('%d matches', hits.length)) + '</div>' + (hits.length ? '<ul class="nt-results">' + hits.map(function (n) {
        return '<li><button type="button" class="nt-row' + (n.id === S.sel ? ' is-sel' : '') + '" data-nt-select="' + esc(n.id) + '">' + glyph(n.kind) + '<span class="nt-row-l">' + data(n.label) + '</span><span class="nt-row-k">' + esc(T(KINDS[n.kind].name)) + '</span></button></li>';
      }).join('') + '</ul>' : '<p class="nt-empty">' + esc(T('Nothing in the graph matches. Names, paths and ids are searched.')) + '</p>');
      return;
    }
    function rows(id, depth) {
      var n = S.byId[id];
      if (!S.visible[id]) return '';
      var kids = S.kids[id] || [], open = !!S.expanded[id];
      var r = '<li class="nt-li"><div class="nt-rowwrap nt-d' + Math.min(depth, 4) + '">'
        + (kids.length ? '<button type="button" class="nt-twist" data-nt-toggle="' + esc(id) + '" aria-expanded="' + open + '" aria-label="' + esc((open ? T('Close') : T('Open')) + ' ' + n.label) + '"><span aria-hidden="true">' + (open ? '▾' : '▸') + '</span></button>' : '<span class="nt-twist nt-twist--none" aria-hidden="true"></span>')
        + '<button type="button" class="nt-row' + (id === S.sel ? ' is-sel' : '') + '" data-nt-select="' + esc(id) + '"' + (id === S.sel ? ' aria-current="true"' : '') + '>' + glyph(n.kind) + '<span class="nt-row-l">' + data(n.label) + '</span>'
        + (kids.length ? '<span class="nt-row-n">' + num(kids.length) + '</span>' : '') + '</button></div>';
      if (open && kids.length) r += '<ul class="nt-ul">' + kids.map(function (k) { return rows(k, depth + 1); }).join('') + '</ul>';
      return r + '</li>';
    }
    t.innerHTML = '<ul class="nt-ul nt-ul--root">' + systems().map(function (s) { return rows(s.id, 0); }).join('') + '</ul>';
    var cur = t.querySelector('.nt-row.is-sel');
    if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
  }

  // ── the inspector: what a node is, and the evidence for it ────────────────
  function paintInspector() {
    var box = S.root.querySelector('#nt-inspector');
    if (!box || !S.graph) return;
    paintStats();
    if (!S.sel || !S.byId[S.sel]) { box.innerHTML = summaryHtml(); return; }
    var n = S.byId[S.sel], kids = S.kids[n.id] || [];
    var crumbs = ancestors(n.id).map(function (a) { return '<button type="button" class="nt-crumb" data-nt-select="' + esc(a) + '">' + data(S.byId[a].label) + '</button>'; }).join('<span class="nt-crumb-sep" aria-hidden="true">›</span>');
    var h = '<div class="nt-insp-h"><div class="nt-insp-kind">' + glyph(n.kind) + '<span>' + esc(T(KINDS[n.kind].name)) + '</span>'
      + '<span class="nt-mat nt-mat--' + n.maturity.toLowerCase() + '">' + esc(T(MATURITY[n.maturity])) + '</span></div>'
      + '<h2 class="nt-insp-t">' + data(n.label) + '</h2><code class="nt-id" dir="ltr">' + esc(n.id) + '</code>'
      + (crumbs ? '<nav class="nt-crumbs" aria-label="' + esc(T('Where it sits')) + '">' + crumbs + '</nav>' : '') + '</div>';
    h += '<div class="nt-insp-actions">'
      + '<button type="button" class="nt-btn" data-nt-action="focus">' + esc(T('Focus camera')) + '</button>'
      + (kids.length ? '<button type="button" class="nt-btn" data-nt-toggle="' + esc(n.id) + '" aria-expanded="' + !!S.expanded[n.id] + '">' + esc(S.expanded[n.id] ? tf('Close (%d inside)', kids.length) : tf('Open (%d inside)', kids.length)) + '</button>' : '')
      + (n.room && ROOMS[n.room] ? '<button type="button" class="nt-btn nt-btn--link" data-nt-room="' + esc(n.room) + '">' + esc(T(ROOMS[n.room])) + ' <span aria-hidden="true">→</span></button>' : '')
      + '<button type="button" class="nt-btn nt-btn--ghost" data-nt-action="clear">' + esc(T('Clear selection')) + '</button></div>';
    if (S.visible[n.id]) h += '<p class="nt-note nt-note--top">' + esc(tf('%d incoming and %d outgoing relationships drawn at this level.', S.hiCount.inc, S.hiCount.out)) + ' ' + esc(T('Shift-click another node to trace the shortest path to it.')) + '</p>';
    h += pathHtml();
    if (n.summary) h += section(T('Responsibility'), '<p class="nt-p">' + prose(n.summary) + '</p>');
    h += section(T('Classification'), '<dl class="nt-dl"><dt>' + esc(T('Maturity')) + '</dt><dd>' + esc(T(MATURITY[n.maturity])) + '</dd>'
      + '<dt>' + esc(T('Runtime health')) + '</dt><dd>' + esc(T('Not monitored in this view (Phase 1 shows structure only).')) + '</dd>' + factsHtml(n.facts) + '</dl>');
    h += section(T('Connections'), connectionsHtml(n));
    if (kids.length) {
      var shown = S.showAll['kids'] ? kids : kids.slice(0, 12);
      h += section(tf('Inside (%d)', kids.length), '<ul class="nt-links">' + shown.map(linkItem).join('') + '</ul>'
        + (kids.length > shown.length ? '<button type="button" class="nt-more" data-nt-more="kids">' + esc(tf('Show all %d', kids.length)) + '</button>' : ''));
    }
    h += section(T('Evidence'), '<ul class="nt-ev">' + n.evidence.map(evidenceItem).join('') + '</ul>'
      + commitNote());
    if (n.unknown && n.unknown.length) h += section(T('Not known'), '<ul class="nt-unknown">' + n.unknown.map(function (u) { return '<li>' + prose(u) + '</li>'; }).join('') + '</ul>');
    box.innerHTML = h;
  }
  function pathHtml() {
    if (!S.pathTo || !S.byId[S.pathTo]) return '';
    var body;
    if (!S.path) body = '<p class="nt-empty">' + esc(T('No directed path between these two at this level.')) + '</p>';
    else {
      body = (S.path.reversed ? '<p class="nt-note nt-note--top">' + esc(T('No path runs from the selection to that node; this one runs from that node to the selection.')) + '</p>' : '')
        + '<ol class="nt-path">' + S.path.nodes.map(function (id, i) {
          var e = i ? S.lifted[S.path.edges[i - 1]] : null;
          return '<li>' + (e ? '<span class="nt-path-e nt-e-' + e.kind + '"><span class="nt-swatch" aria-hidden="true"></span>' + esc(T(EDGES[e.kind].name)) + '</span>' : '') + linkItemInner(id) + '</li>';
        }).join('') + '</ol>';
    }
    return section(!S.path ? T('Path') : S.path.edges.length === 1 ? T('Path (1 step)') : tf('Path (%d steps)', S.path.edges.length), body + '<button type="button" class="nt-btn nt-btn--ghost" data-nt-action="clear-path">' + esc(T('Clear path')) + '</button>');
  }
  function commitNote() {
    return '<p class="nt-note">' + esc(T('Composed when this release was built.')) + (S.commit ? ' ' + esc(T('Commit')) + ' <code dir="ltr">' + esc(S.commit.slice(0, 7)) + '</code>' : '') + '</p>';
  }
  function section(title, body) { return '<section class="nt-sec"><h3 class="nt-sec-t">' + esc(title) + '</h3>' + body + '</section>'; }
  function factsHtml(facts) {
    if (!facts) return '';
    return Object.keys(facts).map(function (k) {
      var v = facts[k], shown;
      if (typeof v === 'boolean') shown = esc(v ? T('Yes') : T('No'));
      else if (typeof v === 'number') shown = esc(num(v));
      else if (Array.isArray(v)) shown = v.length ? v.map(function (x) { return '<code dir="ltr">' + esc(x) + '</code>'; }).join(' ') : '—';
      else shown = k === 'path' || k === 'repositoryPath' || k === 'mount' ? '<code dir="ltr">' + esc(v) + '</code>' : data(v);
      return '<dt>' + esc(T(FACTS[k] || k)) + '</dt><dd>' + shown + '</dd>';
    }).join('');
  }
  function linkItemInner(id) {
    var n = S.byId[id];
    return '<button type="button" class="nt-link" data-nt-select="' + esc(id) + '">' + glyph(n.kind) + '<span class="nt-row-l">' + data(n.label) + '</span><span class="nt-row-k">' + esc(T(KINDS[n.kind].name)) + '</span></button>';
  }
  function linkItem(id) { return '<li>' + linkItemInner(id) + '</li>'; }
  function evidenceItem(e) {
    var where = e.p + (e.l ? ':' + e.l : '');
    return '<li><span class="nt-ev-a">' + esc(T(AUTHORITY[e.a] || e.a)) + '</span><code dir="ltr">' + esc(where) + '</code>' + (e.n ? '<span class="nt-ev-n">' + prose(e.n) + '</span>' : '') + '</li>';
  }
  /** Everything inside a node, itself included. */
  function subtree(id) {
    var out = {}, stack = [id];
    while (stack.length) { var x = stack.pop(); out[x] = true; (S.kids[x] || []).forEach(function (k) { stack.push(k); }); }
    return out;
  }
  /** A node's relationships. A node with something inside it has none of its own: the evidence sits on its files, its
   *  components, its agents. So its relationships are every edge that crosses its edge, the far end raised to the same
   *  level (a module's to the module it lands in), counted. */
  function connectionsOf(n) {
    if (!(S.kids[n.id] || []).length) return { out: S.out[n.id] || [], inc: S.inc[n.id] || [], aggregated: false };
    var inside = subtree(n.id), depth = S.depth[n.id];
    function lift(id) { var a = ancestors(id).concat([id]); return a[Math.min(depth, a.length - 1)]; }
    var agg = { out: {}, inc: {} };
    S.graph.edges.forEach(function (e) {
      var fi = inside[e.from], ti = inside[e.to];
      if (fi === ti) return;
      var dir = fi ? 'out' : 'inc', other = lift(fi ? e.to : e.from);
      if (inside[other]) return;
      var k = other + '\u0000' + e.kind + '\u0000' + (e.sub || '');
      var x = agg[dir][k] || (agg[dir][k] = { from: fi ? n.id : other, to: fi ? other : n.id, kind: e.kind, sub: e.sub, weight: 0, evidence: [e.evidence[0]] });
      x.weight += e.weight;
    });
    var list = function (o) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (a, b) { return b.weight - a.weight || (a.from + a.to < b.from + b.to ? -1 : 1); }); };
    return { out: list(agg.out), inc: list(agg.inc), aggregated: true };
  }
  function connectionsHtml(n) {
    var groups = [], conn = connectionsOf(n);
    function collect(list, dir) {
      var by = {};
      (list || []).forEach(function (e) { var k = e.kind + (e.sub ? ':' + e.sub : ''); (by[k] = by[k] || []).push(e); });
      Object.keys(by).sort(function (a, b) { return EDGE_ORDER.indexOf(a.split(':')[0]) - EDGE_ORDER.indexOf(b.split(':')[0]) || (a < b ? -1 : 1); }).forEach(function (k) { groups.push({ key: dir + k, dir: dir, kind: k.split(':')[0], sub: k.split(':')[1] || '', edges: by[k] }); });
    }
    collect(conn.out, 'out'); collect(conn.inc, 'in');
    if (!groups.length) return '<p class="nt-empty">' + esc(T('No relationship is recorded for this node. That is what the evidence says, not a gap in the drawing.')) + '</p>';
    var note = conn.aggregated ? '<p class="nt-note nt-note--top">' + esc(T('Counted over everything inside it; the far end is shown at the same level.')) + '</p>' : '';
    return groups.map(function (g) {
      var ed = EDGES[g.kind], title = T(g.dir === 'out' ? ed.out : ed.inc) + (g.sub ? ' · ' + subName(g.sub) : '');
      var all = S.showAll[g.key], list = all ? g.edges : g.edges.slice(0, 8);
      return '<div class="nt-conn"><div class="nt-conn-h nt-e-' + g.kind + '"><span class="nt-swatch" aria-hidden="true"></span><span>' + esc(title) + '</span><span class="nt-chip-n">' + num(g.edges.length) + '</span></div><ul class="nt-links">'
        + list.map(function (e) {
          var other = g.dir === 'out' ? e.to : e.from, o = S.byId[other], ev = e.evidence[0];
          return '<li><button type="button" class="nt-link" data-nt-select="' + esc(other) + '">' + glyph(o.kind) + '<span class="nt-row-l">' + data(o.label) + '</span>'
            + (e.weight > 1 ? '<span class="nt-row-k">×' + esc(num(e.weight)) + '</span>' : '') + '</button>'
            + (ev ? '<code class="nt-ev-inline" dir="ltr">' + esc(ev.p + (ev.l ? ':' + ev.l : '')) + '</code>' : '') + '</li>';
        }).join('') + '</ul>'
        + (g.edges.length > list.length ? '<button type="button" class="nt-more" data-nt-more="' + esc(g.key) + '">' + esc(tf('Show all %d', g.edges.length)) + '</button>' : '') + '</div>';
    }).join('') + note;
  }
  function subName(sub) {
    var m = { READS: 'reads', WRITES: 'writes', READS_WRITES: 'reads and writes' };
    return esc(T(m[sub] || sub));
  }
  function summaryHtml() {
    var g = S.graph, c = g.counts;
    var kinds = KIND_ORDER.filter(function (k) { return c.nodes[k]; }).map(function (k) { return '<li>' + glyph(k) + '<span>' + esc(T(KINDS[k].plural)) + '</span><span class="nt-chip-n">' + num(c.nodes[k]) + '</span></li>'; }).join('');
    var edges = EDGE_ORDER.filter(function (k) { return c.edges[k]; }).map(function (k) { return '<li class="nt-e-' + k + '"><span class="nt-swatch" aria-hidden="true"></span><span>' + esc(T(EDGES[k].name)) + '</span><span class="nt-chip-n">' + num(c.edges[k]) + '</span></li>'; }).join('');
    var disc = g.discrepancies.length ? '<ul class="nt-unknown">' + g.discrepancies.map(function (d) { return '<li><strong>' + data(d.subject) + '</strong> — ' + prose(d.detail) + '</li>'; }).join('') + '</ul>' : '<p class="nt-empty">' + esc(T('The authorities agree.')) + '</p>';
    var prov = '<ul class="nt-ev">' + g.provenance.map(function (p) { return '<li><span class="nt-ev-a">' + esc(T(AUTHORITY[p.authority] || p.authority)) + '</span><code dir="ltr">' + esc(p.path) + '</code><code class="nt-sha" dir="ltr">' + esc(p.sha256.slice(0, 12)) + '</code></li>'; }).join('') + '</ul>';
    return '<div class="nt-insp-h"><h2 class="nt-insp-t">' + esc(T('The architecture at a glance')) + '</h2>'
      + '<p class="nt-p">' + esc(T('Choose a system in the scene or in the explorer to enter it. Every node and every line carries the evidence it came from; nothing here is measured at run time.')) + '</p></div>'
      + section(T('What the graph holds'), '<ul class="nt-tally">' + kinds + '</ul>')
      + section(T('Relationships'), '<ul class="nt-tally">' + edges + '</ul>')
      + section(T('Where the authorities disagree'), disc)
      + section(T('Composed from'), prov + commitNote());
  }
  function paintStats() {
    var el = S.root.querySelector('#nt-stats');
    if (!el || !S.graph) return;
    el.innerHTML = '<span class="nt-stat"><b>' + esc(num(S.graph.nodes.length)) + '</b> ' + esc(T('nodes')) + '</span>'
      + '<span class="nt-stat"><b>' + esc(num(S.graph.edges.length)) + '</b> ' + esc(T('relationships')) + '</span>'
      + '<span class="nt-stat"><b>' + esc(num(Object.keys(S.visible).length)) + '</b> ' + esc(T('shown')) + '</span>';
  }
  function paintLegend() {
    var el = S.root.querySelector('#nt-legend');
    if (!el) return;
    el.innerHTML = '<summary class="nt-legend-t">' + esc(T('Legend')) + '</summary>'
      + '<ul>' + KIND_ORDER.map(function (k) { return '<li>' + glyph(k) + '<span>' + esc(T(KINDS[k].name)) + '</span></li>'; }).join('') + '</ul>'
      + '<ul class="nt-legend-e">' + EDGE_ORDER.map(function (k) { return '<li class="nt-e-' + k + '"><span class="nt-swatch" aria-hidden="true"></span><span>' + esc(T(EDGES[k].name)) + '</span></li>'; }).join('') + '</ul>'
      + '<p class="nt-legend-m">' + esc(T('Solid: implemented · translucent: partial · wireframe: planned or unverified')) + '</p>'
      + '<p class="nt-legend-m">' + esc(T('Position shows nesting only. Each line is a recorded relationship, brightening toward the end it points to.')) + '</p>';
  }

  // ── events, delegated from the room's root ────────────────────────────────
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var q;
    if ((q = t.closest('[data-nt-select]'))) {
      var sid = q.getAttribute('data-nt-select');
      if (ev.shiftKey && S.sel && sid !== S.sel) tracePath(sid); else select(sid);
      return;
    }
    if ((q = t.closest('[data-nt-toggle]'))) {
      // opening a node from the inspector is a move into it; from the outline it only unfolds the list
      var tid = q.getAttribute('data-nt-toggle');
      if (q.closest('.nt-inspector') && !S.expanded[tid]) enter(tid); else toggle(tid);
      return;
    }
    if ((q = t.closest('[data-nt-kind]'))) { var k = q.getAttribute('data-nt-kind'); S.kinds[k] = !S.kinds[k]; refresh(); return; }
    if ((q = t.closest('[data-nt-edge]'))) { var e = q.getAttribute('data-nt-edge'); S.edges[e] = !S.edges[e]; refresh(); return; }
    if ((q = t.closest('[data-nt-more]'))) { S.showAll[q.getAttribute('data-nt-more')] = true; paintInspector(); return; }
    if ((q = t.closest('[data-nt-room]'))) { openRoom(q.getAttribute('data-nt-room')); return; }
    if ((q = t.closest('[data-nt-lang]'))) { changeLang(q.getAttribute('data-nt-lang')); return; }
    if ((q = t.closest('[data-nt-action]'))) {
      var a = q.getAttribute('data-nt-action'), gl = S.gl;
      if (a === 'back') { try { window.navTo('owner-home', null); } catch (_) {} }
      else if (a === 'history-back') back();
      else if (a === 'focus-only') { S.focusOnly = !S.focusOnly; paintTools(); paintEdges(); }
      else if (a === 'clear-path') { S.pathTo = null; refresh(); }
      else if (a === 'reload') { S.graph = null; load(); }
      else if (a === 'retry') { load(); }
      else if (a === 'zoom-in' && gl.ok) { gl.anim = null; wake(); gl.camera.radius = Math.max(gl.camera.lowerRadiusLimit, gl.camera.radius * 0.8); }
      else if (a === 'zoom-out' && gl.ok) { gl.anim = null; wake(); gl.camera.radius = Math.min(gl.camera.upperRadiusLimit, gl.camera.radius * 1.25); }
      else if (a === 'reset') resetView();
      else if (a === 'focus' && S.sel) focusOn(S.sel);
      else if (a === 'clear') { S.sel = null; S.pathTo = null; refresh(); }
      else if (a === 'expand-all') { if (gl.ok) pushHistory(); systems().forEach(function (s) { S.expanded[s.id] = true; }); refresh({ overview: true }); }
      else if (a === 'collapse-all') { if (gl.ok) pushHistory(); S.expanded = {}; refresh({ overview: true }); }
    }
  }
  function onInput(ev) {
    if (ev.target && ev.target.id === 'nt-q') { S.q = ev.target.value; paintExplorer(); }
    if (ev.target && ev.target.id === 'nt-intensity') {
      S.intensity = Math.max(0, Math.min(100, Number(ev.target.value) || 0)) / 60;
      if (!S.edgeRaf) S.edgeRaf = requestAnimationFrame(function () { S.edgeRaf = 0; paintEdges(); });
    }
  }
  function onChange(ev) {
    if (ev.target && ev.target.id === 'nt-system') {
      S.system = ev.target.value;
      if (S.gl.ok) pushHistory();
      if (S.system) { S.expanded[S.system] = true; S.sel = S.system; S.pathTo = null; }
      refresh(S.system ? { focus: true } : { overview: true });
    }
  }
  function onKey(ev) {
    var t = ev.target, typing = !!(t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
    if (!S.root || !S.graph) return;
    if (ev.key === 'Escape' && !typing) { if (S.pathTo) { S.pathTo = null; refresh(); } else if (S.sel) { S.sel = null; refresh(); } return; }
    var row = t && t.closest ? t.closest('[data-nt-select]') : null;
    if (ev.key === 'Enter' && ev.shiftKey && row && S.sel) { ev.preventDefault(); tracePath(row.getAttribute('data-nt-select')); return; }
    if (ev.key === 'Enter' && t && t.id === 'nt-canvas' && S.sel) { enter(S.sel); return; }
    var backKey = (ev.key === 'Backspace' && !typing) || (ev.altKey && ev.key === (NT_DIR === 'rtl' ? 'ArrowRight' : 'ArrowLeft'));
    if (backKey && S.history.length) { ev.preventDefault(); back(); }
  }
  function openRoom(room) {
    try {
      if (room === 'agents-room' && S.sel && S.sel.indexOf('agent:') === 0) window._famAgentsRoomOpen = S.sel.slice(6);
      window.navTo(room, null);
    } catch (_) {}
  }
  function changeLang(tag) {
    var l = localeOf(tag);
    var apply = (window.I18N_APPLY && typeof window.I18N_APPLY.change === 'function') ? window.I18N_APPLY.change(l[3]) : Promise.resolve();
    Promise.resolve(apply).catch(function () {}).then(function () { return setLocale(l[0]); }).then(function () { paintAll(); });
  }

  // ── drawing the room ──────────────────────────────────────────────────────
  function paintAll() {
    var root = S.root;
    if (!root) return;
    root.setAttribute('dir', NT_DIR); root.setAttribute('lang', NT_LANG);
    var glAlive = S.gl.ok && root.querySelector('#nt-canvas');
    if (!glAlive) root.innerHTML = shellHtml();
    else {
      // the canvas and its engine stay; only the words around them are drawn again
      var top = root.querySelector('.nt-top'), tmp = document.createElement('div');
      tmp.innerHTML = shellHtml();
      top.parentNode.replaceChild(tmp.querySelector('.nt-top'), top);
      ['.nt-search', '.nt-tools', '.nt-edgectl'].forEach(function (sel) { var a = root.querySelector(sel), b = tmp.querySelector(sel); if (a && b) a.parentNode.replaceChild(b, a); });
      ['.nt-explorer', '.nt-stage', '.nt-inspector'].forEach(function (sel) { var a = root.querySelector(sel), b = tmp.querySelector(sel); if (a && b) a.setAttribute('aria-label', b.getAttribute('aria-label')); });
      var cv = root.querySelector('#nt-canvas'), cvNew = tmp.querySelector('#nt-canvas');
      cv.setAttribute('aria-label', cvNew.getAttribute('aria-label'));
    }
    var q = root.querySelector('#nt-q'); if (q) q.value = S.q;
    if (S.state === 'loading') { root.querySelector('#nt-inspector').innerHTML = '<div class="nt-skel" aria-busy="true"><span></span><span></span><span></span><span></span></div>'; return; }
    if (S.state === 'error') {
      root.querySelector('#nt-inspector').innerHTML = '<div class="nt-err" role="alert"><h2 class="nt-insp-t">' + esc(T('The architecture graph could not be read')) + '</h2><p class="nt-p">' + esc(S.error) + '</p><button type="button" class="nt-btn" data-nt-action="retry">' + esc(T('Try again')) + '</button></div>';
      return;
    }
    paintLegend();
    if (S.gl.failed) { var m = root.querySelector('#nt-glmsg'); m.hidden = false; m.textContent = S.gl.reason; }
    refresh();
  }

  function load() {
    S.state = 'loading'; S.error = null; S.t0 = performance.now();
    paintAll();
    var tGraph = api('/system/neural-twin').then(function (g) {
      var miss = REQUIRED.filter(function (k) { return !g || g[k] === undefined; });
      if (miss.length) throw new Error(tf('The graph arrived without %d required fields.', miss.length) + ' ' + miss.join(', '));
      if (g.schemaVersion !== 1) throw new Error(tf('The graph has schema %d; this room reads schema %d.', g.schemaVersion, 1));
      return g;
    });
    var tGL = webglAvailable() ? loadBabylon().then(function (ok) { S.babylonMs = Math.round(performance.now() - S.t0); return ok; }) : Promise.resolve(false);
    return Promise.all([tGraph, tGL]).then(function (r) {
      var g = r[0], ok = r[1];
      S.commit = g.commit || null;
      index(g);
      S.state = 'ready';
      paintAll();
      if (!S.gl.ok && ok) {
        try { startScene(); paintScene(); paintLabels(); applyView(overviewView()); }
        catch (e) { S.gl.failed = true; S.gl.ok = false; S.gl.reason = T('The 3D view could not start on this device. The explorer and the inspector show the same graph.'); paintAll(); }
      } else if (!ok && !S.gl.ok) {
        S.gl.failed = true;
        S.gl.reason = webglAvailable() ? T('The 3D engine could not be loaded. The explorer and the inspector show the same graph.') : T('This browser has no WebGL, so the 3D view is off. The explorer and the inspector show the same graph.');
        paintAll();
      }
    }).catch(function (err) {
      S.state = 'error'; S.error = (err && err.message) || T('Unknown error');
      paintAll();
    });
  }

  // ── entry and exit ────────────────────────────────────────────────────────
  window.renderFamilistaNeuralTwin = function (root) {
    if (!root) return;
    if (S.root && S.root !== root) window.teardownFamilistaNeuralTwin();
    S.root = root;
    root.classList.add('nt-root');
    root.setAttribute('data-fam-context', 'owner');
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    S.cleanup.push(function () { root.removeEventListener('click', onClick); root.removeEventListener('input', onInput); root.removeEventListener('change', onChange); document.removeEventListener('keydown', onKey); });
    setLocale(platformLocale()).then(function () { return load(); });
  };
  window.teardownFamilistaNeuralTwin = function () {
    var gl = S.gl;
    try { if (gl.engine) { gl.engine.stopRenderLoop(); gl.scene && gl.scene.dispose(); gl.engine.dispose(); } } catch (_) {}
    S.cleanup.splice(0).forEach(function (f) { try { f(); } catch (_) {} });
    if (S.root) { S.root.innerHTML = ''; S.root.classList.remove('nt-root'); }
    probe = null; colourCache = {};
    var keep = { kinds: S.kinds, edges: S.edges, intensity: S.intensity, focusOnly: S.focusOnly };
    S = fresh(); S.kinds = keep.kinds; S.edges = keep.edges; S.intensity = keep.intensity; S.focusOnly = keep.focusOnly;
  };
  /** What the tests and the browser proof read: the room's own state, never the page's. */
  window.__familistaTwinMetrics = function () {
    var gl = S.gl;
    return {
      state: S.state, lang: NT_LANG, dir: NT_DIR, nodes: S.graph ? S.graph.nodes.length : 0, edges: S.graph ? S.graph.edges.length : 0,
      visible: Object.keys(S.visible).length, lifted: S.lifted.length, selected: S.sel, expanded: Object.keys(S.expanded).filter(function (k) { return S.expanded[k]; }).sort(),
      system: S.system, labels: S.labels.length, webgl: !!gl.ok, glFailed: !!gl.failed, meshes: Object.keys(gl.meshes).length, coarse: !!gl.far,
      vertices: Object.keys(gl.meshes).reduce(function (n, k) { return n + (gl.meshes[k].isEnabled() ? gl.meshes[k].getTotalVertices() : 0); }, 0),
      enabledMeshes: Object.keys(gl.meshes).filter(function (k) { return gl.meshes[k].isEnabled(); }).length,
      fps: gl.engine ? Math.round(gl.engine.getFps()) : null, frames: gl.frames, firstFrameMs: S.firstFrameMs, babylonMs: S.babylonMs,
      kinds: Object.keys(S.kinds).filter(function (k) { return S.kinds[k]; }).sort(), edgeKinds: Object.keys(S.edges).filter(function (k) { return S.edges[k]; }).sort(),
      layoutMs: S.layoutMs, extent: S.layout ? Math.round(S.layout.extent) : null, platforms: S.layout ? S.layout.platforms.length : 0, zones: S.layout ? S.layout.zones.map(function (z) { return z.zone || 'unplaced'; }) : [],
      drawnEdges: S.drawn.length, cut: S.cut, highlighted: { out: S.hiCount.out, inc: S.hiCount.inc, inside: S.hiCount.inside, path: S.hiCount.path }, near: Object.keys(S.near).length,
      path: S.path ? { nodes: S.path.nodes.slice(), reversed: S.path.reversed } : null, pathTo: S.pathTo, history: S.history.length,
      labelsShown: S.labelsShown, intensity: S.intensity, focusOnly: S.focusOnly, arrows: gl.arrows.length,
      drawCalls: gl.inst ? gl.inst.drawCallsCounter.current : null, frameMs: gl.inst ? Math.round(gl.inst.frameTimeCounter.average * 100) / 100 : null,
      activeMeshes: gl.scene ? gl.scene.getActiveMeshes().length : null, moving: !!(gl.anim || gl.tween), lastMove: gl.lastMove || null,
      camera: gl.ok ? cameraNow() : null,
    };
  };
  /** The relationships on screen, each a lifted graph edge: the browser proof maps every one back to the graph. */
  window.__familistaTwinDrawn = function () {
    return S.drawn.map(function (i) { var e = S.lifted[i]; return { from: e.from, to: e.to, kind: e.kind, n: e.n }; });
  };
  /** Each visible node's position and footprint, for the layout checks in the browser proof. */
  window.__familistaTwinLayout = function () {
    return S.layout ? { pos: S.layout.pos, bubble: S.layout.bubble, zones: S.layout.zones, platforms: S.layout.platforms } : null;
  };
  /** The scene position of a node on screen, for the browser proof's pointer tests. */
  window.__familistaTwinScreenOf = function (id) {
    var gl = S.gl, B = window.BABYLON, p = S.pos[id];
    if (!gl.ok || !p) return null;
    var w = gl.engine.getRenderWidth(), h = gl.engine.getRenderHeight(), c = S.root.querySelector('#nt-canvas'), r = c.getBoundingClientRect();
    var v = B.Vector3.Project(new B.Vector3(p[0], p[1], p[2]), B.Matrix.Identity(), gl.scene.getTransformMatrix(), gl.camera.viewport.toGlobal(w, h));
    return { x: r.left + v.x * (r.width / w), y: r.top + v.y * (r.height / h), z: v.z };
  };
})();
