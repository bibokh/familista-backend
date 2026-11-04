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
  // Where each zone of the infrastructure manifest sits on the floor of the scene.
  var ZONES = { centre: [0, 0, 0], north: [0, 10, -120], south: [0, -10, 120], east: [120, 0, 0], west: [-120, 0, 0] };
  var UNZONED = [104, -8, 104];

  // ── state ─────────────────────────────────────────────────────────────────
  function fresh() {
    return {
      root: null, state: 'idle', error: null, graph: null, commit: null,
      byId: {}, kids: {}, out: {}, inc: {}, depth: {},
      sel: null, expanded: {}, kinds: {}, edges: {}, system: '', q: '', showAll: {},
      pos: {}, visible: {}, lifted: [], labels: [],
      gl: { engine: null, scene: null, camera: null, meshes: {}, mats: {}, lines: [], hiLines: null, anim: null, dirty: true, ok: false, failed: false, reason: '', awakeUntil: 0, frames: 0 },
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
    // an edge is drawn between the nearest shown ancestor-or-self of each end
    var rep = {};
    function repOf(id) {
      if (rep[id] !== undefined) return rep[id];
      var r = null, cur = id;
      while (cur) { if (vis[cur]) { r = cur; break; } cur = S.byId[cur] && S.byId[cur].parent; }
      rep[id] = r; return r;
    }
    var agg = {};
    S.graph.edges.forEach(function (e) {
      if (!S.edges[e.kind]) return;
      var a = repOf(e.from), b = repOf(e.to);
      if (!a || !b || a === b) return;
      var key = a + '\u0000' + b + '\u0000' + e.kind;
      var x = agg[key] || (agg[key] = { from: a, to: b, kind: e.kind, weight: 0, n: 0 });
      x.weight += e.weight; x.n += 1;
    });
    S.lifted = Object.keys(agg).sort().map(function (k) { return agg[k]; });
  }

  // ── layout: deterministic, from the manifest's zones and the graph's own nesting ──
  function layout() {
    var pos = {};
    var byZone = {};
    systems().forEach(function (s) { var z = (s.facts && s.facts.zone) || ''; (byZone[z] = byZone[z] || []).push(s.id); });
    Object.keys(byZone).forEach(function (z) {
      var list = byZone[z].sort(), anchor = ZONES[z] || UNZONED, r = list.length > 1 ? 18 + list.length * 5 : 0;
      list.forEach(function (id, i) {
        var a = (i / list.length) * Math.PI * 2 + (z === 'centre' ? Math.PI / 8 : 0);
        pos[id] = [anchor[0] + Math.cos(a) * r, anchor[1] + (i % 2 ? 4 : -4) * (list.length > 1 ? 1 : 0), anchor[2] + Math.sin(a) * r];
      });
    });
    // children on a sphere around their parent, in a fixed order, whatever is filtered
    function place(id) {
      var kids = S.kids[id] || [];
      if (!kids.length) return;
      var c = pos[id], n = kids.length, depth = S.depth[id];
      var R = depth === 0 ? 7 + 2.1 * Math.sqrt(n) : 2.6 + 1.05 * Math.sqrt(n);
      kids.forEach(function (k, i) {
        var y = 1 - (2 * (i + 0.5)) / n, rr = Math.sqrt(Math.max(0, 1 - y * y)), th = i * 2.399963;
        pos[k] = [c[0] + R * rr * Math.cos(th), c[1] + R * y * 0.8, c[2] + R * rr * Math.sin(th)];
        if (S.expanded[k]) place(k);
      });
    }
    systems().forEach(function (s) { if (S.expanded[s.id]) place(s.id); });
    S.pos = pos;
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
    var cam = new B.ArcRotateCamera('nt-cam', -Math.PI / 2.6, Math.PI / 3.1, 330, new B.Vector3(0, 0, 0), scene);
    cam.lowerRadiusLimit = 4; cam.upperRadiusLimit = 620; cam.wheelDeltaPercentage = 0.012; cam.panningSensibility = 60;
    cam.inertia = reduceMotion ? 0 : 0.82; cam.panningInertia = reduceMotion ? 0 : 0.82; cam.minZ = 0.5; cam.maxZ = 4000;
    cam.attachControl(canvas, true);
    var hemi = new B.HemisphericLight('nt-sky', new B.Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.9; hemi.groundColor = new B.Color3(0.12, 0.13, 0.18);
    var key = new B.DirectionalLight('nt-key', new B.Vector3(-0.4, -1, 0.3), scene); key.intensity = 0.5;
    gl.engine = engine; gl.scene = scene; gl.camera = cam; gl.ok = true;
    scene.onPointerObservable.add(function (pi) {
      if (pi.type !== B.PointerEventTypes.POINTERTAP && pi.type !== B.PointerEventTypes.POINTERDOUBLETAP) return;
      var pick = pi.pickInfo, m = pick && pick.hit ? pick.pickedMesh : null, id = m && m.metadata && m.metadata.ntId;
      if (!id) return;
      if (pi.type === B.PointerEventTypes.POINTERDOUBLETAP) { enter(id); return; }
      select(id, { focus: false, reveal: false });
    });
    cam.onViewMatrixChangedObservable.add(function () { gl.dirty = true; });
    ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart', 'touchmove'].forEach(function (t) {
      canvas.addEventListener(t, wake, { passive: true });
      S.cleanup.push(function () { canvas.removeEventListener(t, wake); });
    });
    engine.runRenderLoop(function () {
      // Nothing on this map is live, so an idle scene is not drawn again: frames run while the reader
      // moves the camera, while it settles, and after a change, then stop.
      if (document.hidden || (!gl.anim && performance.now() > gl.awakeUntil)) return;
      stepAnimation();
      scene.render();
      gl.frames++;
      if (gl.dirty) { placeLabels(); gl.dirty = false; }
      if (S.firstFrameMs == null) S.firstFrameMs = Math.round(performance.now() - S.t0);
    });
    var onResize = function () { engine.resize(); gl.dirty = true; wake(); };
    window.addEventListener('resize', onResize);
    S.cleanup.push(function () { window.removeEventListener('resize', onResize); });
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(onResize); ro.observe(canvas.parentNode);
      S.cleanup.push(function () { ro.disconnect(); });
    }
  }

  /** Keep drawing for a moment: the camera's inertia settles inside it. */
  function wake() { S.gl.awakeUntil = performance.now() + 1600; }
  function material(kind, look, maturity) {
    var B = window.BABYLON, gl = S.gl;
    var wire = maturity === 'PLANNED' || maturity === 'UNVERIFIED', partial = maturity === 'PARTIAL';
    var key = kind + '|' + look + '|' + (wire ? 'w' : partial ? 'p' : 's');
    if (gl.mats[key]) return gl.mats[key];
    var c = tokenRGB(KINDS[kind].tok), m = new B.StandardMaterial('nt-m-' + key, gl.scene);
    var k = look === 'hi' ? 1.0 : look === 'dim' ? 0.35 : 0.72;
    m.diffuseColor = new B.Color3(c[0] * 0.55, c[1] * 0.55, c[2] * 0.55);
    m.emissiveColor = new B.Color3(c[0] * k, c[1] * k, c[2] * k);
    m.specularColor = new B.Color3(0.15, 0.15, 0.15);
    m.wireframe = wire;
    m.alpha = look === 'dim' ? 0.16 : partial ? 0.62 : 1;
    m.freeze();
    gl.mats[key] = m;
    return m;
  }
  function meshFor(id) {
    var gl = S.gl, B = window.BABYLON;
    if (gl.meshes[id]) return gl.meshes[id];
    var n = S.byId[id], kd = KINDS[n.kind], s = kd.size, m;
    if (kd.shape === 'ico') m = B.MeshBuilder.CreateIcoSphere('n', { radius: s, subdivisions: 2 }, gl.scene);
    else if (kd.shape === 'box') m = B.MeshBuilder.CreateBox('n', { size: s * 1.4 }, gl.scene);
    else if (kd.shape === 'octa') m = B.MeshBuilder.CreatePolyhedron('n', { type: 1, size: s }, gl.scene);
    else if (kd.shape === 'cyl') m = B.MeshBuilder.CreateCylinder('n', { height: s * 1.5, diameter: s * 1.6, tessellation: 18 }, gl.scene);
    else if (kd.shape === 'capsule') m = B.MeshBuilder.CreateCapsule('n', { height: s * 2.2, radius: s * 0.55, tessellation: 12, subdivisions: 2 }, gl.scene);
    else if (kd.shape === 'torus') m = B.MeshBuilder.CreateTorus('n', { diameter: s * 2, thickness: s * 0.45, tessellation: 24 }, gl.scene);
    else m = B.MeshBuilder.CreateSphere('n', { diameter: s * 2, segments: 10 }, gl.scene);
    m.metadata = { ntId: id };
    m.isPickable = true;
    gl.meshes[id] = m;
    return m;
  }

  /** Bring the scene in line with what is visible, selected and filtered. Called after every change the reader makes. */
  function paintScene() {
    var gl = S.gl, B = window.BABYLON;
    if (!gl.ok) return;
    var near = neighbours();
    for (var id in gl.meshes) if (!S.visible[id]) gl.meshes[id].setEnabled(false);
    Object.keys(S.visible).forEach(function (id) {
      var m = meshFor(id), n = S.byId[id], p = S.pos[id];
      if (!p) { m.setEnabled(false); return; }
      m.setEnabled(true);
      m.position.set(p[0], p[1], p[2]);
      var look = !S.sel ? 'normal' : id === S.sel ? 'hi' : near[id] ? 'normal' : 'dim';
      var scale = n.kind === 'system' && S.expanded[id] ? 0.45 : 1;
      if (id === S.sel) scale *= 1.35;
      m.scaling.set(scale, scale, scale);
      m.material = material(n.kind, look, n.maturity);
    });
    // edges: one line system per relationship kind, and the selection's own edges brighter
    gl.lines.forEach(function (l) { l.dispose(); }); gl.lines = [];
    if (gl.hiLines) { gl.hiLines.dispose(); gl.hiLines = null; }
    var groups = {}, hi = [], hiCols = [];
    S.lifted.forEach(function (e) {
      var a = S.pos[e.from], b = S.pos[e.to];
      if (!a || !b) return;
      var on = S.sel && (e.from === S.sel || e.to === S.sel);
      var c = tokenRGB(EDGES[e.kind].tok);
      var seg = [new B.Vector3(a[0], a[1], a[2]), new B.Vector3(b[0], b[1], b[2])];
      if (on) { hi.push(seg); hiCols.push([new B.Color4(c[0], c[1], c[2], 1), new B.Color4(c[0], c[1], c[2], 1)]); return; }
      var g = groups[e.kind] || (groups[e.kind] = { lines: [], colors: [] });
      var alpha = S.sel ? 0.06 : Math.min(0.55, 0.16 + Math.log2(1 + e.weight) * 0.06);
      g.lines.push(seg); g.colors.push([new B.Color4(c[0], c[1], c[2], alpha), new B.Color4(c[0], c[1], c[2], alpha)]);
    });
    Object.keys(groups).forEach(function (k) {
      var l = B.MeshBuilder.CreateLineSystem('nt-e-' + k, { lines: groups[k].lines, colors: groups[k].colors, useVertexAlpha: true }, gl.scene);
      l.isPickable = false; l.alphaIndex = 1; gl.lines.push(l);
    });
    if (hi.length) {
      gl.hiLines = B.MeshBuilder.CreateLineSystem('nt-e-hi', { lines: hi, colors: hiCols, useVertexAlpha: true }, gl.scene);
      gl.hiLines.isPickable = false; gl.hiLines.alphaIndex = 2;
    }
    gl.dirty = true;
    wake();
  }

  /** The nodes joined to the selection by a drawn edge. */
  function neighbours() {
    var out = {};
    if (!S.sel) return out;
    S.lifted.forEach(function (e) { if (e.from === S.sel) out[e.to] = true; if (e.to === S.sel) out[e.from] = true; });
    ancestors(S.sel).forEach(function (a) { out[a] = true; });
    (S.kids[S.sel] || []).forEach(function (k) { out[k] = true; });
    return out;
  }

  // ── labels: names over the scene, as text the page can read and translate around ──
  function labelSet() {
    var ids = {}, near = neighbours(), count = 0;
    Object.keys(S.visible).forEach(function (id) {
      var n = S.byId[id];
      if (n.kind === 'system') { ids[id] = 1; return; }
      var p = n.parent, sibs = (S.kids[p] || []).filter(function (k) { return S.visible[k]; }).length;
      if (S.expanded[p] && sibs <= 24 && S.depth[id] <= 1) ids[id] = 1;
    });
    if (S.sel && S.visible[S.sel]) {
      ids[S.sel] = 2;
      Object.keys(near).forEach(function (id) { if (S.visible[id] && count < 28) { ids[id] = ids[id] || 1; count++; } });
    }
    return ids;
  }
  function paintLabels() {
    var host = S.root.querySelector('#nt-labels');
    if (!host) return;
    var want = labelSet(), html = '';
    Object.keys(want).forEach(function (id) {
      var n = S.byId[id];
      html += '<span class="nt-label nt-label--' + n.kind + (want[id] === 2 ? ' is-sel' : '') + '" data-nt-label="' + esc(id) + '">' + data(n.label) + '</span>';
    });
    host.innerHTML = html;
    S.labels = [].slice.call(host.querySelectorAll('[data-nt-label]'));
    S.gl.dirty = true;
  }
  function placeLabels() {
    var gl = S.gl, B = window.BABYLON;
    if (!gl.ok || !S.labels.length) return;
    var w = gl.engine.getRenderWidth(), h = gl.engine.getRenderHeight();
    var scale = (S.root.querySelector('#nt-canvas').clientWidth || w) / w;
    var tm = gl.scene.getTransformMatrix(), vp = gl.camera.viewport.toGlobal(w, h), id = B.Matrix.Identity();
    S.labels.forEach(function (el) {
      var p = S.pos[el.getAttribute('data-nt-label')];
      if (!p) { el.hidden = true; return; }
      var v = B.Vector3.Project(new B.Vector3(p[0], p[1], p[2]), id, tm, vp);
      if (v.z < 0 || v.z > 1 || v.x < -40 || v.y < -20 || v.x > w + 40 || v.y > h + 20) { el.hidden = true; return; }
      el.hidden = false;
      el.style.transform = 'translate(' + Math.round(v.x * scale) + 'px,' + Math.round(v.y * scale) + 'px)';
    });
  }

  // ── camera: focus and enter ───────────────────────────────────────────────
  function focusOn(id) {
    var gl = S.gl, B = window.BABYLON, p = S.pos[id];
    if (!gl.ok || !p) return;
    var n = S.byId[id], kids = (S.kids[id] || []).length;
    var radius = n.kind === 'system' ? (S.expanded[id] ? 34 + 3.4 * Math.sqrt(kids) : 46) : S.expanded[id] ? 14 + 2.2 * Math.sqrt(kids) : 18;
    var to = { target: new B.Vector3(p[0], p[1], p[2]), radius: radius };
    wake();
    if (reduceMotion) { gl.camera.setTarget(to.target, false, false, true); gl.camera.radius = to.radius; gl.dirty = true; return; }
    gl.anim = { from: { target: gl.camera.target.clone(), radius: gl.camera.radius }, to: to, t0: performance.now(), ms: 520 };
  }
  function stepAnimation() {
    var gl = S.gl, a = gl.anim;
    if (!a) return;
    var t = Math.min(1, (performance.now() - a.t0) / a.ms), k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    gl.camera.setTarget(window.BABYLON.Vector3.Lerp(a.from.target, a.to.target, k), false, false, true);
    gl.camera.radius = a.from.radius + (a.to.radius - a.from.radius) * k;
    gl.dirty = true;
    if (t >= 1) gl.anim = null;
  }
  function resetView() {
    var gl = S.gl;
    if (!gl.ok) return;
    gl.anim = null;
    gl.camera.setTarget(new window.BABYLON.Vector3(0, 0, 0), false, false, true);
    wake();
    gl.camera.alpha = -Math.PI / 2.6; gl.camera.beta = Math.PI / 3.1; gl.camera.radius = 330;
    gl.dirty = true;
  }

  // ── what the reader does ──────────────────────────────────────────────────
  function refresh(opts) {
    computeVisible(); layout(); paintScene(); paintLabels();
    paintExplorer(); paintInspector();
    if (opts && opts.focus && S.sel) focusOn(S.sel);
  }
  function select(id, opts) {
    opts = opts || {};
    if (!S.byId[id]) return;
    if (opts.reveal !== false) ancestors(id).forEach(function (a) { S.expanded[a] = true; });
    if (S.system && systemOf(id) !== S.system) S.system = '';
    if (!S.kinds[S.byId[id].kind]) S.kinds[S.byId[id].kind] = true;
    S.sel = id; S.showAll = {};
    refresh({ focus: opts.focus !== false });
    announce(T(KINDS[S.byId[id].kind].name) + ': ' + S.byId[id].label);
  }
  function toggle(id, open) {
    if (!(S.kids[id] || []).length) return;
    S.expanded[id] = open == null ? !S.expanded[id] : open;
    if (!S.expanded[id]) Object.keys(S.expanded).forEach(function (x) { if (ancestors(x).indexOf(id) >= 0) delete S.expanded[x]; });
    refresh();
  }
  /** Entering a node: select it, open it and bring the camera into its cluster. */
  function enter(id) {
    if (!S.byId[id]) return;
    ancestors(id).forEach(function (a) { S.expanded[a] = true; });
    if ((S.kids[id] || []).length) S.expanded[id] = true;
    S.sel = id; S.showAll = {};
    refresh({ focus: true });
    announce(T(KINDS[S.byId[id].kind].name) + ': ' + S.byId[id].label);
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
      + '<button type="button" class="nt-tool" data-nt-action="zoom-in" aria-label="' + esc(T('Zoom in')) + '">+</button>'
      + '<button type="button" class="nt-tool" data-nt-action="zoom-out" aria-label="' + esc(T('Zoom out')) + '">−</button>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="reset">' + esc(T('Reset view')) + '</button>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="expand-all">' + esc(T('Open all systems')) + '</button>'
      + '<button type="button" class="nt-tool nt-tool--wide" data-nt-action="collapse-all">' + esc(T('Close all')) + '</button>'
      + '</div>'
      + '<div class="nt-legend" id="nt-legend"></div>'
      + '</section>'
      + '<aside class="nt-inspector" id="nt-inspector" aria-label="' + esc(T('Inspector')) + '"></aside>'
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
  function linkItem(id) {
    var n = S.byId[id];
    return '<li><button type="button" class="nt-link" data-nt-select="' + esc(id) + '">' + glyph(n.kind) + '<span class="nt-row-l">' + data(n.label) + '</span><span class="nt-row-k">' + esc(T(KINDS[n.kind].name)) + '</span></button></li>';
  }
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
    el.innerHTML = '<div class="nt-legend-t">' + esc(T('Legend')) + '</div><ul>' + KIND_ORDER.map(function (k) { return '<li>' + glyph(k) + '<span>' + esc(T(KINDS[k].name)) + '</span></li>'; }).join('') + '</ul>'
      + '<p class="nt-legend-m">' + esc(T('Solid: implemented · translucent: partial · wireframe: planned or unverified')) + '</p>';
  }

  // ── events, delegated from the room's root ────────────────────────────────
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var q;
    if ((q = t.closest('[data-nt-select]'))) { select(q.getAttribute('data-nt-select')); return; }
    if ((q = t.closest('[data-nt-toggle]'))) { toggle(q.getAttribute('data-nt-toggle')); return; }
    if ((q = t.closest('[data-nt-kind]'))) { var k = q.getAttribute('data-nt-kind'); S.kinds[k] = !S.kinds[k]; refresh(); return; }
    if ((q = t.closest('[data-nt-edge]'))) { var e = q.getAttribute('data-nt-edge'); S.edges[e] = !S.edges[e]; refresh(); return; }
    if ((q = t.closest('[data-nt-more]'))) { S.showAll[q.getAttribute('data-nt-more')] = true; paintInspector(); return; }
    if ((q = t.closest('[data-nt-room]'))) { openRoom(q.getAttribute('data-nt-room')); return; }
    if ((q = t.closest('[data-nt-lang]'))) { changeLang(q.getAttribute('data-nt-lang')); return; }
    if ((q = t.closest('[data-nt-action]'))) {
      var a = q.getAttribute('data-nt-action'), gl = S.gl;
      if (a === 'back') { try { window.navTo('owner-home', null); } catch (_) {} }
      else if (a === 'reload') { S.graph = null; load(); }
      else if (a === 'retry') { load(); }
      else if (a === 'zoom-in' && gl.ok) { gl.anim = null; wake(); gl.camera.radius = Math.max(gl.camera.lowerRadiusLimit, gl.camera.radius * 0.8); }
      else if (a === 'zoom-out' && gl.ok) { gl.anim = null; wake(); gl.camera.radius = Math.min(gl.camera.upperRadiusLimit, gl.camera.radius * 1.25); }
      else if (a === 'reset') resetView();
      else if (a === 'focus' && S.sel) focusOn(S.sel);
      else if (a === 'clear') { S.sel = null; refresh(); }
      else if (a === 'expand-all') { systems().forEach(function (s) { S.expanded[s.id] = true; }); refresh(); }
      else if (a === 'collapse-all') { S.expanded = {}; refresh(); }
    }
  }
  function onInput(ev) {
    if (ev.target && ev.target.id === 'nt-q') { S.q = ev.target.value; paintExplorer(); }
  }
  function onChange(ev) {
    if (ev.target && ev.target.id === 'nt-system') {
      S.system = ev.target.value;
      if (S.system) { S.expanded[S.system] = true; S.sel = S.system; }
      refresh({ focus: !!S.system });
      if (!S.system) resetView();
    }
  }
  function onKey(ev) {
    if (ev.key === 'Escape' && S.sel && !(ev.target && ev.target.id === 'nt-q')) { S.sel = null; refresh(); }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'nt-canvas' && S.sel) enter(S.sel);
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
      ['.nt-search', '.nt-tools'].forEach(function (sel) { var a = root.querySelector(sel), b = tmp.querySelector(sel); if (a && b) a.parentNode.replaceChild(b, a); });
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
        try { startScene(); paintScene(); paintLabels(); }
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
    var keep = { kinds: S.kinds, edges: S.edges };
    S = fresh(); S.kinds = keep.kinds; S.edges = keep.edges;
  };
  /** What the tests and the browser proof read: the room's own state, never the page's. */
  window.__familistaTwinMetrics = function () {
    var gl = S.gl;
    return {
      state: S.state, lang: NT_LANG, dir: NT_DIR, nodes: S.graph ? S.graph.nodes.length : 0, edges: S.graph ? S.graph.edges.length : 0,
      visible: Object.keys(S.visible).length, lifted: S.lifted.length, selected: S.sel, expanded: Object.keys(S.expanded).filter(function (k) { return S.expanded[k]; }).sort(),
      system: S.system, labels: S.labels.length, webgl: !!gl.ok, glFailed: !!gl.failed, meshes: Object.keys(gl.meshes).length,
      enabledMeshes: Object.keys(gl.meshes).filter(function (k) { return gl.meshes[k].isEnabled(); }).length,
      fps: gl.engine ? Math.round(gl.engine.getFps()) : null, frames: gl.frames, firstFrameMs: S.firstFrameMs, babylonMs: S.babylonMs,
      kinds: Object.keys(S.kinds).filter(function (k) { return S.kinds[k]; }).sort(), edgeKinds: Object.keys(S.edges).filter(function (k) { return S.edges[k]; }).sort(),
    };
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
