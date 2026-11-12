/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — DS-1a, DS-1b — the editor

   The Platform Owner's product designer: one football-jersey template, edited
   in millimetres on its real surfaces (front, back and both sleeves), drawn as
   SVG from the canonical document (pd-core.js) and shown flat (2D) or shaded
   (2.5D). Layers, text, player-number and name placeholders, palette colours,
   patterns, position, scale and rotation, undo and redo. The approved layout
   of the Familista Design Studio reference image, regions R1–R15.

   Loaded on demand by public/app.js for a reader whom GET /system/whoami names
   the Platform Owner — the same check as every owner room. That check is a
   convenience and NOT a security boundary: the server checks the platform owner
   on every design route (src/routes/product-design.routes.ts). The draft in the
   editor is kept in this browser (localStorage) after every change, as in DS-1a;
   Save design keeps it on the server as a new version of its project (DS-1b),
   through pd-server.js, the only file of this room that talks to the API. JSON
   export and import work as before.

   Everything this phase cannot do yet is on screen, unavailable, and says why:
   3D, artwork uploads, the Club and Creator contexts, the catalogue, quotations,
   production proofs, ordering and every supplier.

   HOW IT DRAWS

   · No markup strings. Elements are built with createElement and
     createElementNS, text is set with textContent, user text never becomes
     markup. The one exception is the shared Platform Owner navigation, which
     app.js builds and escapes (window.famOwnerNav) for every owner room.
   · Styles go through the stylesheet and the CSSOM only; colours that are the
     design's own (its palette) are SVG presentation attributes, validated by
     the core as #rrggbb before they can be drawn.
   · The garment is never mirrored: the canvas is left to right in every
     language, and a sleeve is named for the wearer's side.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var C = window.FamilistaProductDesignCore;
  var LIMITS = C.LIMITS;
  var VERSION = '20261112-product-design-1c';
  var TEMPLATE_URL = '/product-design/templates/football-jersey.json?v=' + VERSION;
  var STORE_KEY = 'familista_product_design_draft_v1';
  var STORE_UNREADABLE = 'familista_product_design_draft_v1_unreadable';
  var SVG = 'http://www.w3.org/2000/svg';
  var DRAG_THRESHOLD = 3;

  /** A label written in a constant table: returned as it is, translated where it is drawn. */
  function L(s) { return s; }

  // ── language ──────────────────────────────────────────────────────────────

  // Familista's official languages, from the locale registry (public/i18n/i18n.js, roomLocales):
  // [code, label, dir, tag]. This room holds no list of its own.
  var LOCALES = window.I18N && typeof window.I18N.roomLocales === 'function' ? window.I18N.roomLocales() : [['en', 'English (UK)', 'ltr', 'en-GB']];
  var DICT = {};
  var LANG = 'en';
  var DIR = 'ltr';

  function localeOf(code) {
    for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i][0] === code) return LOCALES[i];
    return LOCALES[0];
  }
  function initialLocale() {
    return window.I18N && typeof window.I18N.roomLocale === 'function' ? window.I18N.roomLocale() : 'en';
  }
  function setLocale(code) {
    var l = localeOf(code);
    LANG = l[0]; DIR = l[2];
    if (LANG === 'en') { DICT = {}; return Promise.resolve(); }
    return fetch('/product-design/i18n/' + LANG + '.json?v=' + VERSION)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { DICT = d && typeof d === 'object' ? d : {}; })
      .catch(function () { DICT = {}; });
  }
  /** This room's own switch: the room changes language, and the platform follows (public/i18n/i18n.js, roomChoose). */
  function chooseSetLocale(code) {
    var ready = setLocale(code);
    if (window.I18N && typeof window.I18N.roomChoose === 'function') window.I18N.roomChoose(localeOf(code)[0]);
    return ready;
  }
  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(DICT, s) ? DICT[s] : s;
  }
  function num(n, digits) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(LANG, { maximumFractionDigits: digits == null ? 1 : digits }); } catch (_) { return String(n); }
  }
  /** A sentence with numbers or names in it: %d takes a number, %s a name, in order. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1), i = 0;
    return T(key).replace(/%[ds]/g, function (m) { var v = args[i++]; return m === '%d' ? num(v) : String(v == null ? '' : v); });
  }

  // ── DOM helpers: no markup strings ────────────────────────────────────────

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    setAttrs(el, attrs);
    append(el, kids);
    return el;
  }
  function s(tag, attrs, kids) {
    var el = document.createElementNS(SVG, tag);
    setAttrs(el, attrs);
    append(el, kids);
    return el;
  }
  function setAttrs(el, attrs) {
    if (!attrs) return;
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function append(el, kids) {
    if (!kids) return;
    for (var i = 0; i < kids.length; i++) if (kids[i] != null) el.appendChild(typeof kids[i] === 'string' ? document.createTextNode(kids[i]) : kids[i]);
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  var ICONS = {
    home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
    twin: 'M12 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM5 16.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM19 16.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM11 7.3l-4.8 9.4M13 7.3l4.8 9.4M7 18.5h10',
    agents: 'M9 3h6M12 3v3M5 8h14a1 1 0 0 1 1 1v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a1 1 0 0 1 1-1zM9 13h.01M15 13h.01M9.5 16.5h5',
    shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
    shirt: 'M8 3l-5 3 2 5 3-1v11h8V10l3 1 2-5-5-3c-.5 1.6-2 2.6-4 2.6S8.5 4.6 8 3z',
    store: 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6',
    box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
    factory: 'M3 21V10l5 3V10l5 3V7l8 4v10zM3 21h18M8 17h2M13 17h2',
    card: 'M3 6h18v12H3zM3 10h18M7 15h3',
    select: 'M5 3l14 8-6.5 1.5L9 19z',
    text: 'M5 7V4h14v3M12 4v16M9 20h6',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5h.01',
    shape: 'M12 3l9 9-9 9-9-9z',
    pattern: 'M4 20L20 4M4 14L14 4M10 20L20 10M4 8l4-4M16 20l4-4',
    layers: 'M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5',
    components: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    grid: 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18',
    guides: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    expand: 'M4 10V4h6M20 10V4h-6M4 14v6h6M20 14v6h-6',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
    lock: 'M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    unlock: 'M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    duplicate: 'M9 9h11v11H9zM5 15H4V4h11v1',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    plus: 'M12 5v14M5 12h14',
    chevron: 'M6 9l6 6 6-6',
    save: 'M5 3h11l5 5v13H5zM8 3v6h8M8 21v-7h8v7',
    versions: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    import: 'M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
    export: 'M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
    cart: 'M3 4h2l2.4 11h10.2l2-8H6.2M10 20h.01M17 20h.01',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
    people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 20a6.5 6.5 0 0 0-3-5.5',
    pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
    truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-.01M17 19a2 2 0 1 0 0-.01',
    gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
    delivered: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l3 3 5-6',
    calc: 'M6 3h12v18H6zM9 7h6M9 11h.01M12 11h.01M15 11h.01M9 14h.01M12 14h.01M15 14h.01M9 17h.01M12 17h.01M15 17h.01',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    alignH: 'M12 3v18M7 7h10v3H7zM9 14h6v3H9z',
    alignV: 'M3 12h18M7 7v10h3V7zM14 9v6h3V9z',
    reset: 'M4 4v6h6M4.6 15A8 8 0 1 0 6 6.3L4 10',
    up: 'M12 19V5M6 11l6-6 6 6',
    down: 'M12 5v14M6 13l6 6 6-6',
    close: 'M6 6l12 12M18 6L6 18',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
    rotate: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    sun: 'M12 3V1.5M12 22.5V21M3 12H1.5M22.5 12H21M5.6 5.6L4.5 4.5M19.5 19.5l-1.1-1.1M5.6 18.4l-1.1 1.1M19.5 4.5l-1.1 1.1M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z',
    zoomIn: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8M10.5 8v5M8 10.5h5',
    compare: 'M4 5h6v14H4zM14 5h6v14h-6zM12 3v18',
    gkShirt: 'M8 3L3 6l1 13 3-.5V10M16 3l5 3-1 13-3-.5V10M8 3c.5 1.6 2 2.6 4 2.6S15.5 4.6 16 3M7 10v11h10V10',
    shorts: 'M5 4h14l1 15-6 1-2-8-2 8-6-1z',
    socks: 'M9 3h6v10l4 4a2.5 2.5 0 0 1-3.5 3.5L9 15z',
    jacket: 'M8 3L3 6l1 13h4V9M16 3l5 3-1 13h-4V9M8 3l4 4 4-4M12 7v14M8 21h8',
    hoodie: 'M8 4a4 4 0 0 1 8 0l5 3-1 12h-3V10M8 4L3 7l1 12h3V10M7 10v11h10V10M9 4.5c0 2 1.3 3.5 3 3.5s3-1.5 3-3.5',
    polo: 'M8 3l-5 3 2 5 3-1v11h8V10l3 1 2-5-5-3-2 2.5L12 9l-2-3.5zM12 9v3',
    cap: 'M3 15a9 6 0 0 1 18 0zM3 15h12l6 2',
    bag: 'M5 8h14l-1 12H6zM9 8a3 3 0 0 1 6 0',
    scarf: 'M6 3h5v18H6zM11 3l7 4-3 14',
    flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  };
  function icon(name, size) {
    var el = s('svg', { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor',
      'stroke-width': name === 'grip' ? '3' : '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'pd-ic' });
    el.appendChild(s('path', { d: ICONS[name] || ICONS.info }));
    return el;
  }
  /** A paging arrow, written once as a left-to-right reader sees it; app.css (.fam-dir-ic) turns it right to left. */
  function dirArrow(glyph) { return h('span', { class: 'fam-dir-ic', 'aria-hidden': 'true', text: glyph }); }

  // ── what this phase can and cannot do ─────────────────────────────────────
  //
  // One place for every unavailable control's reason. A control that cannot work
  // is shown, marked aria-disabled, carries data-pd-reason, and says why when it
  // is pressed — never a handler that pretends.

  var REASON = {
    'context-club': L('Club Design Studio is planned (DS-3): club designs, branding approval and team orders.'),
    'context-creator': L('Creator Studio is planned (DS-4) and needs personal accounts first (DS-ID).'),
    templates: L('More templates arrive with the product catalogue (DS-2).'),
    product: L('This product arrives with the product catalogue (DS-2).'),
    image: L('Uploading artwork waits for protected media storage with verified backups (planned).'),
    '3d': L('3D needs WebGL, which this browser or device does not provide. The 2.5D preview shows the same design.'),
    '360': L('The 360° turntable needs 3D, which needs WebGL in this browser.'),
    capture: L('Image export arrives with production proofs (DS-5).'),
    proof: L('Production proofs arrive with the manufacturing sandbox (DS-5).'),
    order: L('Ordering is not available yet (DS-6).'),
    method: L('Production methods come from a connected supplier (DS-5). This is the template’s reference.'),
    fabric: L('Fabrics come from a connected supplier (DS-5). This is the template’s reference.'),
    store: L('The Global Store is planned (DS-7).'),
    orders: L('Orders are planned (DS-6).'),
    suppliers: L('Supplier administration is planned (DS-5).'),
    payments: L('Payments are planned (DS-6), after business and legal approval.'),
  };

  // ── state ─────────────────────────────────────────────────────────────────

  var S = null;
  var TEMPLATE = null;
  var TEMPLATE_LOADING = null;

  function fresh(host) {
    return {
      host: host, doc: null, hist: C.createHistory(), view: 'front', sel: null, cam: null, autoFit: true,
      mode: '2.5d', grid: false, guides: true, focus: false, panel: null, libTab: 'products', inspTab: 'design', fit: 'men',
      open: { 'match-kits': true }, listeners: [], saveTimer: 0, thumbTimer: 0, saveState: 'saved', savedAt: null,
      drag: null, space: false, merge: null, el: {}, nodes: {}, findings: [], announced: 0,
      metrics: { mounts: 0, commits: 0, renders: 0, layerPaints: 0, renderMs: [], editMs: [], lastSaveBytes: 0 },
      srv: serverFresh(), v3: fresh3d(),
    };
  }
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    S.listeners.push([target, type, fn, opts]);
  }
  function unbind() {
    if (!S) return;
    for (var i = 0; i < S.listeners.length; i++) { var l = S.listeners[i]; l[0].removeEventListener(l[1], l[2], l[3]); }
    S.listeners.length = 0;
    if (S.resize) { try { S.resize.disconnect(); } catch (_) {} S.resize = null; }
  }
  function say(msg) {
    if (!S || !S.el.live) return;
    S.announced++;
    S.el.live.textContent = '';
    S.el.live.textContent = msg;
  }

  function viewOf(id) { for (var i = 0; i < TEMPLATE.views.length; i++) if (TEMPLATE.views[i].id === id) return TEMPLATE.views[i]; return TEMPLATE.views[0]; }
  function surfaceOfView() { return C.findSurface(S.doc, viewOf(S.view).surface); }
  function tSurface(id) { return C.templateSurface(TEMPLATE, id); }
  function colour(id) { var f = C.findSwatch(S.doc, id); return f ? f.swatch.srgb : '#000000'; }
  function selectedLayer() {
    if (!S.sel || S.sel.kind !== 'layer') return null;
    var f = C.findLayer(S.doc, S.sel.id);
    return f ? f.layer : null;
  }
  function isBox(n) { return n && C.BOX_TYPES.indexOf(n.type) !== -1; }

  // ── the draft, in this browser ────────────────────────────────────────────

  function loadStored() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); } catch (_) { return { doc: newDocument(), note: 'unavailable' }; }
    if (!raw) return { doc: newDocument(), note: 'new' };
    try { return { doc: C.parseDocument(raw, TEMPLATE), note: 'restored' }; }
    catch (_) {
      try { window.localStorage.setItem(STORE_UNREADABLE, raw); } catch (__) {}
      return { doc: newDocument(), note: 'unreadable' };
    }
  }
  function newDocument() {
    var names = {};
    ['Pattern', 'Brand mark', 'Club crest', 'Sponsor', 'Player name', 'Player number', 'Navy', 'Royal blue', 'Gold', 'White'].forEach(function (k) { names[k] = T(k); });
    return C.createDocument(TEMPLATE, T('Home kit design'), names);
  }
  /** The local draft's state: saved, pending, unavailable or too-large. What the screen says combines it with the server's. */
  function setSaveState(state) {
    if (!S) return;
    S.saveState = state;
    showSaveState();
  }
  function localStateText() {
    var state = S.saveState;
    return state === 'saved' ? (S.savedAt ? tf('Saved in this browser at %s', S.savedAt) : T('Saved in this browser'))
      : state === 'pending' ? T('Saving in this browser…')
      : state === 'unavailable' ? T('Not saved: this browser’s storage is unavailable')
      : T('Not saved: the draft is larger than this browser keeps');
  }
  function saveSoon() {
    if (!S) return;
    clearTimeout(S.saveTimer);
    setSaveState('pending');
    S.saveTimer = setTimeout(function () { saveNow(); }, 1200);
  }
  function saveNow(announce) {
    if (!S || !S.doc) return;
    clearTimeout(S.saveTimer);
    S.saveTimer = 0;
    var text = C.serializeDocument(S.doc);
    var bytes = C.byteLength(text);
    S.metrics.lastSaveBytes = bytes;
    if (bytes > LIMITS.bytes) { setSaveState('too-large'); return; }
    try { window.localStorage.setItem(STORE_KEY, text); }
    catch (_) { setSaveState('unavailable'); if (announce) say(T('Not saved: this browser’s storage is unavailable')); return; }
    try { S.savedAt = new Date().toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' }); } catch (_) { S.savedAt = null; }
    S.saveState = 'saved';
    syncServerState(text);
    if (announce) say(T('Saved in this browser only. Export the file to keep a copy elsewhere.'));
  }
  // ── saved on the Familista server (DS-1b) ─────────────────────────────────
  //
  // The draft in the editor is still kept in this browser after every change,
  // exactly as before. "Save design" also keeps it on the Familista server as a
  // new revision of its project; the first save creates the project, so a draft
  // DS-1a left in this browser becomes a saved design the moment it is saved,
  // and the draft itself is never moved or deleted. The server decides who may
  // save. A save never overwrites anything: one based on an older revision is
  // refused, and this room asks what to do. pd-server.js is the only file that
  // talks to the server.

  var P = window.FamilistaProductDesignServer;

  function serverFresh() {
    return {
      link: null, state: 'local', busy: false, error: '', conflict: null, origin: 'EDITOR', notice: '',
      open: false, tab: 'projects', filter: 'active', list: null, listState: 'idle', listError: '',
      revs: null, revState: 'idle', revError: '', confirm: null, trigger: null, seq: 0,
    };
  }
  function docText() { return C.serializeDocument(S.doc); }
  function setLink(link) {
    S.srv.link = link;
    if (link) P.writeLink(link); else P.clearLink();
    if (S.v3.compare && (!link || link.projectId !== S.v3.compare.projectId)) compareWith(0, true);
    if (S.el.bar3d) sync3d();
  }
  /** True when the editor holds something the server does not: changes since the linked revision, or an unsaved design that is not blank. */
  function isUnsaved() {
    var fp = P.fingerprint(docText());
    if (S.srv.link) return fp !== S.srv.link.fp;
    return fp !== P.fingerprint(C.serializeDocument(newDocument()));
  }
  /** Saved or unsaved, from the text the local save just wrote; a conflict or an error stays until the next save or open. */
  function syncServerState(text) {
    var sv = S.srv;
    if (!sv.busy && sv.state !== 'conflict' && sv.state !== 'error') {
      sv.state = !sv.link ? 'local' : P.fingerprint(text || docText()) === sv.link.fp ? 'saved' : 'dirty';
    }
    showSaveState();
  }
  function showSaveState() {
    var el = S && S.el.saveState;
    if (!el) return;
    var sv = S.srv, state, text;
    if (sv.busy) { state = 'busy'; text = T('Saving to Familista…'); }
    else if (sv.state === 'conflict' && sv.conflict) { state = 'conflict'; text = tf('A newer version (%d) is on the server', sv.conflict.head); }
    else if (sv.state === 'error') { state = 'error'; text = T('Not saved'); }
    else if (S.saveState === 'unavailable' || S.saveState === 'too-large') { state = S.saveState; text = localStateText(); }
    else if (sv.state === 'saved') { state = 'saved'; text = tf('Saved · version %d', sv.link.revision); }
    else if (sv.state === 'dirty') { state = 'dirty'; text = T('Unsaved changes'); }
    else { state = 'local'; text = T('Not on the Familista server yet'); }
    el.setAttribute('data-state', state);
    el.textContent = text;
    el.title = text + (S.saveState === 'saved' || S.saveState === 'pending' ? ' — ' + localStateText() : '');
    // The line beneath says where the design is kept; when a save failed it says why instead, in full.
    var line = S.el.localLine, note = S.el.local;
    if (line && note) {
      if (state === 'error') { line.setAttribute('data-state', 'error'); note.textContent = tf('Not saved: %s', sv.error); }
      else { line.removeAttribute('data-state'); note.textContent = T('Saved on the Familista server · draft kept in this browser'); }
    }
  }
  /** What went wrong, as the end of a sentence that begins "Not saved: ". */
  function serverProblem(r) {
    if (r.status === 0) return T('the Familista server could not be reached. The draft is kept in this browser.');
    if (r.status === 401) return T('the session has ended. Sign in again, then save.');
    if (r.status === 403) return T('only the platform owner can save designs on the server.');
    if (r.code === 'DESIGN_PROJECT_ARCHIVED') return T('this design is archived. Return it to the list in Projects to save it.');
    if (r.code === 'DESIGN_DOCUMENT_INVALID') return T('the server refused the design as invalid.');
    if (r.status === 404) return T('this design is no longer on the server.');
    if (r.status === 429) return T('too many requests. Wait a moment and save again.');
    return tf('the server answered HTTP %d.', r.status);
  }

  /** Save the editor's design on the server: a new project, or the next revision on `base` (default: the linked one). */
  function serverSave(base, after) {
    if (!S || !S.doc) return;
    var sv = S.srv;
    if (sv.busy) { say(T('Saving to Familista…')); return; }
    saveNow(false);
    var mine = S, link = sv.link, text = docText(), fp = P.fingerprint(text);
    var on = link ? (base || link.revision) : 0;
    sv.busy = true;
    showSaveState();
    var req = link ? P.api.saveRevision(link.projectId, on, S.doc) : P.api.createProject(S.doc, sv.origin);
    req.then(function (r) {
      if (S !== mine) return;
      sv.busy = false;
      if (r.ok && r.data && r.data.project && r.data.revision) {
        setLink({ projectId: r.data.project.id, revision: r.data.revision.number, fp: fp });
        sv.state = 'saved'; sv.conflict = null; sv.error = ''; sv.origin = 'EDITOR'; sv.notice = ''; sv.confirm = null;
        syncServerState();
        say(r.data.replayed ? tf('Already saved as version %d.', r.data.revision.number) : tf('Saved on the Familista server as version %d.', r.data.revision.number));
        sv.revs = null;
        renderDock();
        if (sv.open) loadDockTab();
        if (after) after();
        return;
      }
      if (r.status === 409 && r.code === 'DESIGN_REVISION_CONFLICT' && link) {
        sv.state = 'conflict';
        sv.conflict = { head: (r.data && r.data.headRevision) || 0, base: on };
        showSaveState();
        openDock('versions');
        say(tf('Not saved: a newer version (%d) is on the server. Nothing was overwritten.', sv.conflict.head));
        return;
      }
      sv.state = 'error';
      sv.error = serverProblem(r);
      if (r.status === 404 && link) { setLink(null); sv.notice = T('This design is no longer on the server. Save design keeps it as a new design.'); }
      showSaveState();
      renderDock();
      say(tf('Not saved: %s', sv.error));
    });
  }

  /** Put a saved document into the editor: a fresh undo history, the local draft rewritten, the link set. */
  function loadServerDoc(project, revision) {
    var doc;
    try { doc = C.validateDocument(revision.document, TEMPLATE); }
    catch (e) { say(T('This saved design cannot be opened by this version of the Design Studio.')); return false; }
    S.doc = doc;
    S.hist = C.createHistory();
    S.sel = null;
    S.merge = null;
    var sv = S.srv;
    setLink({ projectId: project.id, revision: revision.number, fp: P.fingerprint(C.serializeDocument(doc)) });
    sv.state = 'saved'; sv.conflict = null; sv.error = ''; sv.notice = project.archivedAt ? T('This design is archived. Return it to the list in Projects to save it.') : '';
    sv.origin = 'EDITOR'; sv.revs = null; sv.confirm = null;
    changed();
    buildProps();
    saveNow();
    return true;
  }
  function openProject(id) {
    var mine = S, sv = S.srv;
    sv.busy = true; showSaveState();
    P.api.openProject(id).then(function (r) {
      if (S !== mine) return;
      sv.busy = false;
      if (r.ok && r.data && r.data.project && r.data.revision) {
        if (loadServerDoc(r.data.project, r.data.revision)) {
          say(tf('Opened %s, version %d.', r.data.project.name, r.data.revision.number));
          closeDock();
        }
        return;
      }
      sv.listError = serverProblem(r);
      showSaveState();
      renderDock();
      say(tf('Not opened: %s', sv.listError));
    });
  }
  function startNew() {
    S.doc = newDocument();
    S.hist = C.createHistory();
    S.sel = null;
    S.merge = null;
    setLink(null);
    var sv = S.srv;
    sv.state = 'local'; sv.conflict = null; sv.error = ''; sv.notice = ''; sv.origin = 'EDITOR'; sv.revs = null; sv.confirm = null;
    changed();
    buildProps();
    saveNow();
    say(T('A new design was started. Save design keeps it on the Familista server.'));
    renderDock();
  }
  function restoreVersion(number) {
    var mine = S, sv = S.srv, link = sv.link;
    if (!link) return;
    sv.busy = true; showSaveState();
    P.api.restoreRevision(link.projectId, number, link.revision).then(function (r) {
      if (S !== mine) return;
      if (r.ok && r.data && r.data.revision) {
        var made = r.data.revision.number;
        return P.api.openProject(link.projectId).then(function (o) {
          if (S !== mine) return;
          sv.busy = false;
          if (o.ok && o.data && loadServerDoc(o.data.project, o.data.revision)) say(tf('Version %d was restored as version %d.', number, made));
          else { sv.state = 'error'; sv.error = serverProblem(o); showSaveState(); }
          renderDock();
          loadDockTab();
        });
      }
      sv.busy = false;
      if (r.status === 409 && r.code === 'DESIGN_REVISION_CONFLICT') {
        sv.state = 'conflict'; sv.conflict = { head: (r.data && r.data.headRevision) || 0, base: link.revision };
      } else { sv.state = 'error'; sv.error = serverProblem(r); }
      showSaveState();
      renderDock();
      say(sv.state === 'conflict' ? tf('Not restored: a newer version (%d) is on the server.', sv.conflict.head) : tf('Not restored: %s', sv.error));
    });
  }
  function setArchived(id, archived) {
    var mine = S, sv = S.srv;
    (archived ? P.api.archive(id) : P.api.unarchive(id)).then(function (r) {
      if (S !== mine) return;
      if (r.ok) {
        say(archived ? T('The design was archived. Its versions are kept.') : T('The design is back in the list.'));
        if (sv.link && sv.link.projectId === id) { sv.notice = archived ? T('This design is archived. Return it to the list in Projects to save it.') : ''; if (!archived && sv.error) { sv.state = 'dirty'; sv.error = ''; syncServerState(); } }
        loadProjects();
        return;
      }
      sv.listError = serverProblem(r);
      renderDock();
      say(tf('Not changed: %s', sv.listError));
    });
  }
  /** Run an action that replaces the editor's design, asking first when that would lose unsaved changes. */
  function replacing(kind, arg, run) {
    if (!isUnsaved()) { run(); return; }
    S.srv.confirm = { kind: kind, arg: arg, run: run };
    renderDock();
    var first = S.el.dock && S.el.dock.querySelector('.pd-dock-confirm button');
    if (first) first.focus();
  }

  /** On opening the room: is the linked design still there, and is the editor based on its newest revision? */
  function checkLink() {
    var mine = S, sv = S.srv, link = sv.link;
    if (!link) return;
    P.api.openProject(link.projectId).then(function (r) {
      if (S !== mine || sv.link !== link) return;
      if (r.status === 404) { setLink(null); sv.notice = T('This design is no longer on the server. Save design keeps it as a new design.'); syncServerState(); renderDock(); return; }
      if (!r.ok || !r.data || !r.data.project) return;
      if (r.data.project.archivedAt) sv.notice = T('This design is archived. Return it to the list in Projects to save it.');
      if (r.data.project.headRevision > link.revision) {
        sv.state = 'conflict';
        sv.conflict = { head: r.data.project.headRevision, base: link.revision };
      }
      showSaveState();
      renderDock();
    });
  }

  // ── the saved-designs panel: projects and versions ────────────────────────
  //
  // A floating panel (position: fixed, opacity and transform only), so opening
  // it moves nothing beneath it. Its body scrolls inside itself. Every list has
  // a loading state the size of its rows, an empty state that says what would
  // fill it, and an error state that says what failed and offers to try again.

  function openDock(tab, trigger) {
    var sv = S.srv, d = S.el.dock;
    if (!d) return;
    if (tab) sv.tab = tab;
    // Focus goes back where it came from: the button pressed, or, when the room opened the panel itself (a conflict), its own button.
    if (trigger) sv.trigger = trigger;
    else if (!sv.open) sv.trigger = S.host.querySelector('.pd-actions [data-pd-dock="' + sv.tab + '"]');
    sv.open = true;
    d.setAttribute('data-open', 'true');
    syncDockTriggers();
    renderDock();
    loadDockTab();
    var t = d.querySelector('[data-pd-docktab="' + sv.tab + '"]');
    if (t) t.focus({ preventScroll: true });
  }
  function closeDock() {
    var sv = S.srv, d = S.el.dock;
    if (!d || !sv.open) return;
    sv.open = false;
    sv.confirm = null;
    d.setAttribute('data-open', 'false');
    syncDockTriggers();
    var back = sv.trigger && S.host.contains(sv.trigger) ? sv.trigger : null;
    sv.trigger = null;
    if (back) back.focus({ preventScroll: true });
  }
  function syncDockTriggers() {
    var bs = S.host.querySelectorAll('[data-pd-dock]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-expanded', S.srv.open && bs[i].getAttribute('data-pd-dock') === S.srv.tab ? 'true' : 'false');
  }
  function loadDockTab() { if (S.srv.tab === 'projects') loadProjects(); else loadVersions(); }
  function loadProjects() {
    var mine = S, sv = S.srv, seq = ++sv.seq;
    sv.listState = 'loading'; sv.listError = '';
    renderDock();
    P.api.listProjects(sv.filter).then(function (r) {
      if (S !== mine || seq !== sv.seq) return;
      if (r.ok && r.data && Array.isArray(r.data.projects)) { sv.list = { projects: r.data.projects, truncated: !!r.data.truncated, limit: r.data.limit, filter: sv.filter }; sv.listState = 'ready'; }
      else { sv.listState = 'error'; sv.listError = serverProblem(r); }
      renderDock();
    });
  }
  function loadVersions() {
    var mine = S, sv = S.srv, link = sv.link, seq = ++sv.seq;
    if (!link) { sv.revState = 'idle'; renderDock(); return; }
    sv.revState = 'loading'; sv.revError = '';
    renderDock();
    P.api.listRevisions(link.projectId).then(function (r) {
      if (S !== mine || seq !== sv.seq) return;
      if (r.ok && r.data && Array.isArray(r.data.revisions)) { sv.revs = { projectId: link.projectId, revisions: r.data.revisions, truncated: !!r.data.truncated, limit: r.data.limit, head: r.data.project ? r.data.project.headRevision : null }; sv.revState = 'ready'; }
      else { sv.revState = 'error'; sv.revError = serverProblem(r); }
      renderDock();
    });
  }
  function when(iso) {
    try { return new Intl.DateTimeFormat(LANG, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch (_) { return String(iso).slice(0, 16); }
  }
  function skeleton(n) {
    var ul = h('ul', { class: 'pd-dock-list', role: 'list', 'aria-hidden': 'true' });
    for (var i = 0; i < n; i++) ul.appendChild(h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]));
    return ul;
  }
  function failed(message, act) {
    return h('div', { class: 'pd-dock-state', role: 'alert' }, [
      h('p', { class: 'pd-empty', text: message }),
      btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': act }, [h('span', { text: T('Try again') })]),
    ]);
  }
  function confirmBlock() {
    var c = S.srv.confirm;
    if (!c) return null;
    return h('div', { class: 'pd-dock-alert pd-dock-confirm', role: 'alert' }, [
      h('strong', { text: T('The design in the editor has unsaved changes.') }),
      h('p', { class: 'pd-note', text: T('Save it first, or continue and replace it in the editor. Export keeps a copy as a file.') }),
      h('div', { class: 'pd-dock-btns' }, [
        btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'confirm-save' }, [h('span', { text: T('Save first') })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'confirm-go' }, [h('span', { text: T('Replace it') })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'confirm-cancel' }, [h('span', { text: T('Cancel') })]),
      ]),
    ]);
  }
  function conflictBlock() {
    var sv = S.srv, c = sv.conflict;
    if (sv.state !== 'conflict' || !c || !sv.link) return null;
    return h('div', { class: 'pd-dock-alert pd-dock-conflict', role: 'alert' }, [
      h('strong', { text: tf('A newer version (%d) is on the server', c.head) }),
      h('p', { class: 'pd-note', text: tf('The design in the editor is based on version %d. It has not been saved, and nothing was overwritten.', c.base) }),
      h('div', { class: 'pd-dock-btns' }, [
        btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'conflict-keep' }, [h('span', { text: tf('Save mine as version %d', c.head + 1) })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'conflict-open' }, [h('span', { text: tf('Open version %d', c.head) })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'export' }, [h('span', { text: T('Export mine') })]),
      ]),
    ]);
  }
  function projectsBody() {
    var sv = S.srv, link = sv.link, body = [];
    var current = h('div', { class: 'pd-dock-current' }, [
      h('div', { class: 'pd-dock-text' }, [
        h('span', { class: 'pd-dock-kicker', text: T('In the editor') }),
        h('strong', { class: 'pd-dock-name', 'data-user-content': '', text: S.doc.name }),
        h('span', { class: 'pd-note', text: link ? (sv.state === 'saved' ? tf('Saved · version %d', link.revision) : tf('Unsaved changes since version %d', link.revision)) : T('Not on the Familista server yet') }),
      ]),
      h('div', { class: 'pd-dock-btns' }, [
        !link || sv.state !== 'saved' ? btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'save' }, [icon('save', 14), h('span', { text: T('Save design') })]) : null,
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'new-design' }, [icon('plus', 14), h('span', { text: T('New design') })]),
      ]),
    ]);
    body.push(current);
    var filter = h('div', { class: 'pd-seg', role: 'group', 'aria-label': T('Show') }, [
      btn({ class: 'pd-seg-btn', 'data-pd-filter': 'active', 'aria-pressed': sv.filter === 'active' ? 'true' : 'false', text: T('Active') }),
      btn({ class: 'pd-seg-btn', 'data-pd-filter': 'archived', 'aria-pressed': sv.filter === 'archived' ? 'true' : 'false', text: T('Archived') }),
    ]);
    body.push(h('div', { class: 'pd-dock-bar-row' }, [h('h3', { class: 'pd-dock-h', text: T('Saved designs') }), filter]));
    if (sv.listState === 'loading' && !(sv.list && sv.list.filter === sv.filter)) body.push(skeleton(4));
    else if (sv.listState === 'error') body.push(failed(tf('The saved designs could not be loaded: %s', sv.listError), 'dock-retry'));
    else if (sv.list && sv.list.filter === sv.filter) {
      var rows = sv.list.projects;
      if (!rows.length) body.push(h('p', { class: 'pd-empty', text: sv.filter === 'archived' ? T('No archived designs. An archived design keeps all its versions and can be returned to the list.') : T('No saved designs yet. Save design keeps the design in the editor on the Familista server.') }));
      else {
        var ul = h('ul', { class: 'pd-dock-list', role: 'list' });
        rows.forEach(function (p) {
          var here = link && link.projectId === p.id;
          ul.appendChild(h('li', { class: 'pd-dock-row' + (here ? ' is-current' : '') }, [
            h('div', { class: 'pd-dock-text' }, [
              h('strong', { class: 'pd-dock-name', 'data-user-content': '', text: p.name }),
              h('span', { class: 'pd-note', text: tf('Version %d · %s', p.headRevision, when(p.updatedAt)) }),
            ]),
            h('div', { class: 'pd-dock-btns' }, [
              here ? chip(T('In the editor'), 'accent') : sv.filter === 'active' ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'open-project', 'data-pd-id': p.id, 'aria-label': tf('Open %s', p.name) }, [h('span', { text: T('Open') })]) : null,
              sv.filter === 'archived'
                ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'unarchive', 'data-pd-id': p.id, 'aria-label': tf('Return %s to the list', p.name) }, [h('span', { text: T('Return to list') })])
                : btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'archive', 'data-pd-id': p.id, 'aria-label': tf('Archive %s', p.name) }, [h('span', { text: T('Archive') })]),
            ]),
          ]));
        });
        body.push(ul);
        if (sv.list.truncated) body.push(h('p', { class: 'pd-note', text: tf('Showing the %d most recent.', sv.list.limit) }));
      }
    }
    return body;
  }
  function versionsBody() {
    var sv = S.srv, link = sv.link, body = [];
    if (!link) {
      body.push(h('p', { class: 'pd-empty', text: T('Versions appear once this design is saved on the Familista server.') }));
      body.push(btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'save' }, [icon('save', 14), h('span', { text: T('Save design') })]));
      return body;
    }
    body.push(h('p', { class: 'pd-note' }, [h('span', { 'data-user-content': '', text: S.doc.name }), h('span', { text: ' · ' + tf('version %d in the editor', link.revision) })]));
    body.push(h('p', { class: 'pd-note', text: T('Restoring copies an earlier version into a new one. No version is ever changed or removed.') }));
    if (sv.revState === 'loading' && !(sv.revs && sv.revs.projectId === link.projectId)) body.push(skeleton(5));
    else if (sv.revState === 'error') body.push(failed(tf('The versions could not be loaded: %s', sv.revError), 'dock-retry'));
    else if (sv.revs && sv.revs.projectId === link.projectId) {
      var ul = h('ul', { class: 'pd-dock-list', role: 'list' });
      var newest = sv.revs.revisions.length ? sv.revs.revisions[0].number : 0;
      sv.revs.revisions.forEach(function (v) {
        var kind = v.kind === 'CREATE' ? T('Created') : v.kind === 'RESTORE' ? tf('Restored from version %d', v.restoredFrom) : T('Saved');
        ul.appendChild(h('li', { class: 'pd-dock-row' + (v.number === link.revision ? ' is-current' : '') }, [
          h('div', { class: 'pd-dock-text' }, [
            h('strong', { class: 'pd-dock-name', text: tf('Version %d', v.number) }),
            h('span', { class: 'pd-note', text: kind + ' · ' + when(v.createdAt) }),
          ]),
          h('div', { class: 'pd-dock-btns' }, [
            v.number === newest ? chip(T('Newest'), 'muted') : null,
            v.number === link.revision ? chip(T('In the editor'), 'accent') : null,
            can3d() ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'compare-version', 'data-pd-n': String(v.number), 'aria-label': tf('Compare version %d in 3D', v.number), title: tf('Compare version %d in 3D', v.number) }, [icon('compare', 14)]) : null,
            v.number !== newest ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'restore', 'data-pd-n': String(v.number), 'aria-label': tf('Restore version %d', v.number) }, [h('span', { text: T('Restore') })]) : null,
          ]),
        ]));
      });
      body.push(ul);
      if (sv.revs.truncated) body.push(h('p', { class: 'pd-note', text: tf('Showing the %d most recent.', sv.revs.limit) }));
    }
    return body;
  }
  function renderDock() {
    var d = S && S.el.dock;
    if (!d) return;
    var sv = S.srv, keep = d.querySelector('.pd-dock-body');
    var scroll = keep ? keep.scrollTop : 0;
    clear(d);
    var tabs = h('div', { class: 'pd-tabs', role: 'tablist', 'aria-label': T('Saved designs') });
    [['projects', L('Projects')], ['versions', L('Versions')]].forEach(function (t) {
      tabs.appendChild(btn({ class: 'pd-tab', role: 'tab', id: 'pd-docktab-' + t[0], 'data-pd-docktab': t[0], 'aria-controls': 'pd-dock-body', 'aria-selected': sv.tab === t[0] ? 'true' : 'false', tabindex: sv.tab === t[0] ? '0' : '-1', text: T(t[1]) }));
    });
    var notice = sv.notice ? h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: sv.notice })]) : null;
    var body = h('div', { class: 'pd-dock-body', id: 'pd-dock-body', role: 'tabpanel', 'aria-labelledby': 'pd-docktab-' + sv.tab, tabindex: '0' },
      [conflictBlock(), confirmBlock(), notice].concat(sv.tab === 'projects' ? projectsBody() : versionsBody()));
    append(d, [
      h('div', { class: 'pd-dock-head' }, [
        h('h2', { class: 'pd-h2', id: 'pd-dock-title' }, [icon('folder', 16), h('span', { text: T('Saved designs') })]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'close-dock', 'aria-label': T('Close') }, [icon('close')]),
      ]),
      tabs, body,
    ]);
    body.scrollTop = scroll;
  }
  function onDockAction(act, t) {
    var sv = S.srv;
    switch (act) {
      case 'projects': case 'versions':
        if (sv.open && sv.tab === act) closeDock(); else openDock(act, t);
        return true;
      case 'close-dock': closeDock(); return true;
      case 'dock-retry': loadDockTab(); return true;
      case 'new-design': replacing('new', null, startNew); return true;
      case 'open-project': { var id = t.getAttribute('data-pd-id'); replacing('open', id, function () { openProject(id); }); return true; }
      case 'archive': setArchived(t.getAttribute('data-pd-id'), true); return true;
      case 'unarchive': setArchived(t.getAttribute('data-pd-id'), false); return true;
      case 'restore': { var n = Number(t.getAttribute('data-pd-n')); replacing('restore', n, function () { restoreVersion(n); }); return true; }
      case 'compare-version': compareFromDock(Number(t.getAttribute('data-pd-n'))); return true;
      case 'confirm-save': { var c = sv.confirm; if (c) serverSave(null, function () { sv.confirm = null; c.run(); }); return true; }
      case 'confirm-go': { var c2 = sv.confirm; sv.confirm = null; if (c2) c2.run(); renderDock(); return true; }
      case 'confirm-cancel': sv.confirm = null; renderDock(); return true;
      case 'conflict-keep': if (sv.conflict) { var head = sv.conflict.head; sv.state = 'dirty'; serverSave(head); } return true;
      case 'conflict-open': if (sv.link) { var pid = sv.link.projectId; sv.state = 'dirty'; sv.conflict = null; openProject(pid); } return true;
      default: return false;
    }
  }

  // ── changing the document ─────────────────────────────────────────────────

  /** Apply one operation as one undo step, then repaint what it touched. */
  /** The one layer an operation changes, when it changes only one layer's properties; else null. */
  function opLayer(op) {
    if (op.op === 'set' && op.target && op.target.kind === 'layer') return op.target.id;
    if (op.op === 'batch') {
      var id = null;
      for (var i = 0; i < op.ops.length; i++) { var one = opLayer(op.ops[i]); if (!one || (id && one !== id)) return null; id = one; }
      return id;
    }
    return null;
  }
  function commitOp(op, label, mergeKey) {
    try {
      var top = S.hist.past[S.hist.past.length - 1];
      if (mergeKey && top && top.mergeKey === mergeKey && S.merge === mergeKey) {
        C.applyOp(S.doc, op);
        top.op = C.clone(op);
        S.hist.future.length = 0;
      } else {
        C.commit(S.doc, S.hist, op, label);
        S.hist.past[S.hist.past.length - 1].mergeKey = mergeKey || null;
        S.merge = mergeKey || null;
      }
    } catch (e) {
      say(problemText(e));
      return false;
    }
    S.metrics.commits++;
    changed(opLayer(op));
    return true;
  }
  function setLayer(id, key, value, label, mergeKey) {
    return commitOp({ op: 'set', target: { kind: 'layer', id: id }, key: key, value: value }, label, mergeKey);
  }
  function batch(ops, label) { return ops.length ? commitOp(ops.length === 1 ? ops[0] : { op: 'batch', ops: ops }, label) : false; }
  /** After any change: the canvas, the panels that show the document, the thumbnails, the draft. */
  function changed(layerId) {
    if (S.sel && S.sel.kind === 'layer' && !C.findLayer(S.doc, S.sel.id)) { S.sel = null; buildProps(); }
    var t0 = window.performance && performance.now ? performance.now() : 0;
    var f = layerId && C.findLayer(S.doc, layerId);
    if (f && S.nodes[layerId] && f.surface.id === viewOf(S.view).surface) repaintLayer(layerId); else renderCanvas();
    if (S.v3.ctl) { S.v3.ctl.invalidate(f ? [f.surface.id] : null); syncTrims3d(); }
    if (t0) { S.metrics.editMs.push(performance.now() - t0); if (S.metrics.editMs.length > 100) S.metrics.editMs.shift(); }
    renderLayers();
    syncProps();
    renderProduct();
    renderCheck();
    syncHistory();
    syncName();
    scheduleThumbs();
    saveSoon();
  }
  function problemText(e) {
    var code = e && e.code ? e.code : '';
    var map = {
      'too-large': T('The file is larger than 512 KB.'),
      'not-json': T('The file is not a design file.'),
      'bad-format': T('The file is not a Familista product design.'),
      'unknown-template': T('The design is for a template this studio does not have.'),
      'too-many-layers': tf('A surface holds at most %d layers.', LIMITS.layers),
      'too-many-colours': tf('A design holds at most %d colours.', LIMITS.palette),
      'colour-in-use': T('This colour is in use. Change what uses it first.'),
      'last-colour': T('A design keeps at least one colour.'),
      'bad-text': tf('Text is 1 to %d characters, without control characters.', LIMITS.text),
      'bad-name': tf('A name is 1 to %d characters.', LIMITS.name),
    };
    return map[code] || T('That change is not allowed.');
  }

  // ── geometry helpers ──────────────────────────────────────────────────────

  function polygonBox(poly) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < poly.length; i++) { x0 = Math.min(x0, poly[i][0]); y0 = Math.min(y0, poly[i][1]); x1 = Math.max(x1, poly[i][0]); y1 = Math.max(y1, poly[i][1]); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function canvasSize() {
    // The drawing itself: inside the canvas's border, the box the ResizeObserver reports.
    var r = (S.el.svg && S.el.svg.parentNode ? S.el.svg : S.el.canvas).getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height), left: r.left, top: r.top };
  }
  /** The canvas's size for drawing: what the ResizeObserver last reported, measured only when nothing has been. */
  function drawSize() { return S.size || canvasSize(); }
  function pointerWorld(ev) {
    var c = canvasSize();
    return C.toWorld(S.cam, c.w, c.h, { x: ev.clientX - c.left, y: ev.clientY - c.top });
  }
  function fitView(size) {
    var c = size || drawSize();
    S.cam = C.fitCamera(viewOf(S.view).viewBox, c.w, c.h, 8);
    S.autoFit = true;
  }

  // ── drawing the garment ───────────────────────────────────────────────────

  var FONT = {
    'sans-black': ['var(--fam-font-family-sans)', '900', '--fam-font-family-sans'],
    'sans-bold': ['var(--fam-font-family-sans)', '700', '--fam-font-family-sans'],
    'mono-bold': ['var(--fam-font-family-mono)', '700', '--fam-font-family-mono'],
  };
  // Lettering is measured on an offscreen canvas, with the same font stack the SVG draws in: measuring the drawn text
  // instead (getComputedTextLength) forces the browser to lay out the whole page, on every repaint.
  var MEASURE = null, FAMILY = {};
  /** The font stack a lettering style draws in, read from the design tokens once per build. */
  function familyOf(f) {
    if (!FAMILY[f[2]]) FAMILY[f[2]] = (S && S.host ? getComputedStyle(S.host).getPropertyValue(f[2]).trim() : '') || 'sans-serif';
    return FAMILY[f[2]];
  }
  function textWidth(text, f, size) {
    if (!MEASURE) { try { MEASURE = document.createElement('canvas').getContext('2d'); } catch (_) { MEASURE = null; } }
    if (!MEASURE) return 0;
    MEASURE.font = f[1] + ' 100px ' + familyOf(f);
    return MEASURE.measureText(text).width * size / 100;
  }
  var RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

  /** A shape's outline, centred on 0, in millimetres. Numbers only. */
  function shapePath(shape, w, h) {
    function P(x, y) { return (x * w).toFixed(2) + ' ' + (y * h).toFixed(2); }
    switch (shape) {
      case 'shield': return 'M' + P(-0.5, -0.42) + ' Q' + P(0, -0.58) + ' ' + P(0.5, -0.42) + ' L' + P(0.46, 0.05) + ' Q' + P(0.4, 0.36) + ' ' + P(0, 0.5) + ' Q' + P(-0.4, 0.36) + ' ' + P(-0.46, 0.05) + ' Z';
      case 'circle': return 'M' + P(-0.5, 0) + ' A' + (w / 2).toFixed(2) + ' ' + (h / 2).toFixed(2) + ' 0 1 0 ' + P(0.5, 0) + ' A' + (w / 2).toFixed(2) + ' ' + (h / 2).toFixed(2) + ' 0 1 0 ' + P(-0.5, 0) + ' Z';
      case 'star': {
        var d = '';
        for (var i = 0; i < 10; i++) {
          var a = (-90 + i * 36) * Math.PI / 180, r = i % 2 ? 0.2 : 0.5;
          d += (i ? ' L' : 'M') + P(Math.cos(a) * r, Math.sin(a) * r + 0.03);
        }
        return d + ' Z';
      }
      case 'band': return 'M' + P(-0.5, -0.5) + ' L' + P(0.5, -0.5) + ' L' + P(0.5, 0.5) + ' L' + P(-0.5, 0.5) + ' Z';
      case 'chevron': return 'M' + P(-0.5, -0.5) + ' L' + P(0, 0.1) + ' L' + P(0.5, -0.5) + ' L' + P(0.5, -0.1) + ' L' + P(0, 0.5) + ' L' + P(-0.5, -0.1) + ' Z';
      default: return 'M' + P(0, -0.5) + ' L' + P(0.5, 0) + ' L' + P(0, 0.5) + ' L' + P(-0.5, 0) + ' Z';
    }
  }

  /** The fill a pattern layer paints with: a definition added to `defs`, named under `prefix`. */
  function patternFill(defs, prefix, n) {
    var id = prefix + '-p-' + n.id, c = colour(n.color), sc = n.scale, rot = 'rotate(' + n.angle + ')';
    var p;
    switch (n.pattern) {
      case 'gradient': {
        var g = s('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1', gradientTransform: 'rotate(' + n.angle + ' 0.5 0.5)' }, [
          s('stop', { offset: '0', 'stop-color': c, 'stop-opacity': '1' }), s('stop', { offset: '1', 'stop-color': c, 'stop-opacity': '0' }),
        ]);
        defs.appendChild(g);
        return 'url(#' + id + ')';
      }
      case 'diagonal': case 'vertical':
        p = s('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: sc, height: sc, patternTransform: rot }, [s('rect', { x: 0, y: 0, width: sc * (n.pattern === 'diagonal' ? 0.42 : 0.5), height: sc, fill: c })]);
        break;
      case 'hoops':
        p = s('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: sc, height: sc, patternTransform: rot }, [s('rect', { x: 0, y: 0, width: sc, height: sc * 0.5, fill: c })]);
        break;
      case 'pinstripe':
        p = s('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: sc, height: sc, patternTransform: rot }, [s('rect', { x: 0, y: 0, width: Math.max(1.2, sc * 0.07), height: sc, fill: c })]);
        break;
      case 'chevron':
        p = s('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: sc, height: sc * 0.6, patternTransform: rot }, [
          s('path', { d: 'M0 ' + (sc * 0.15) + ' L' + (sc / 2) + ' ' + (sc * 0.45) + ' L' + sc + ' ' + (sc * 0.15), fill: 'none', stroke: c, 'stroke-width': sc * 0.14 }),
        ]);
        break;
      case 'halftone':
        p = s('pattern', { id: id, patternUnits: 'userSpaceOnUse', width: sc, height: sc, patternTransform: rot }, [s('circle', { cx: sc / 2, cy: sc / 2, r: sc * 0.24, fill: c })]);
        break;
      default: return null;
    }
    defs.appendChild(p);
    return 'url(#' + id + ')';
  }

  /** One layer, drawn in its surface's millimetres. `sample` words a roster placeholder. */
  function layerNode(defs, prefix, n, bounds) {
    var g = s('g', { 'data-pd-node': n.id });
    if (!n.visible) g.setAttribute('visibility', 'hidden');
    if (n.type === 'pattern') {
      var op = String(n.opacity / 100);
      if (n.pattern === 'sash') {
        g.appendChild(s('rect', { x: -n.scale / 2, y: -2000, width: n.scale, height: 4000, fill: colour(n.color), opacity: op,
          transform: 'translate(' + (bounds.x + bounds.w / 2) + ' ' + (bounds.y + bounds.h / 2) + ') rotate(' + n.angle + ')' }));
      } else {
        var fill = patternFill(defs, prefix, n);
        if (fill) g.appendChild(s('rect', { x: bounds.x - 60, y: bounds.y - 60, width: bounds.w + 120, height: bounds.h + 120, fill: fill, opacity: op }));
      }
      return g;
    }
    g.setAttribute('transform', 'translate(' + n.x + ' ' + n.y + ') rotate(' + n.r + ')');
    if (n.type === 'shape') {
      var sw = Math.max(1, Math.min(n.w, n.h) * 0.05);
      g.appendChild(s('path', { d: shapePath(n.shape, n.w, n.h), fill: colour(n.color), stroke: n.outline ? colour(n.outline) : null, 'stroke-width': n.outline ? sw : null, 'stroke-linejoin': 'round' }));
      return g;
    }
    var text = n.type === 'roster' ? (n.field === 'number' ? '10' : T('NAME')) : n.text;
    var f = FONT[n.font] || FONT['sans-black'], size = n.h * 0.82;
    // Lettering is fitted into its box the way kit lettering is: condensed, never overflowing.
    var fit = textWidth(text, f, size) > n.w;
    var t = s('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: colour(n.color), 'font-size': size.toFixed(2), 'font-weight': f[1],
      textLength: fit ? n.w : null, lengthAdjust: fit ? 'spacingAndGlyphs' : null, direction: RTL_SCRIPT.test(text) ? 'rtl' : null,
      stroke: n.outline ? colour(n.outline) : null, 'stroke-width': n.outline ? (n.h * 0.05).toFixed(2) : null, 'paint-order': n.outline ? 'stroke' : null, 'stroke-linejoin': 'round' });
    t.style.setProperty('font-family', f[0]);
    t.textContent = text;
    g.appendChild(t);
    return g;
  }

  /** A darker step of a design colour, for the inside of the collar. */
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    function c(v) { var x = Math.round(v * f).toString(16); return x.length < 2 ? '0' + x : x; }
    return '#' + c(r) + c(g) + c(b);
  }

  /**
   * One view of the garment as an SVG element. `o.prefix` keeps its definitions
   * apart from every other SVG on the page; `o.shaded` draws the 2.5D shading;
   * `o.guides` the printable area and safe zone. The main canvas also keeps the
   * element of each layer, so a drag repaints one node.
   */
  function garment(viewId, o) {
    var view = viewOf(viewId), surf = C.findSurface(S.doc, view.surface), ts = tSurface(view.surface);
    var prefix = o.prefix, defs = s('defs'), root = s('g', { class: 'pd-garment' });
    var svg = s('svg', { xmlns: SVG, class: o.cls || 'pd-svg', 'aria-hidden': 'true', focusable: 'false', viewBox: view.viewBox.join(' '), preserveAspectRatio: 'xMidYMid meet' }, [defs]);
    var bodyPath = C.outlinePath(ts.outline);
    var silhouette = s('clipPath', { id: prefix + '-sil' }, [s('path', { d: bodyPath })]);
    (view.context || []).forEach(function (c) { silhouette.appendChild(s('path', { d: C.outlinePath(c.outline) })); });
    defs.appendChild(silhouette);

    if (o.shaded) {
      defs.appendChild(s('filter', { id: prefix + '-blur', x: '-30%', y: '-30%', width: '160%', height: '160%' }, [s('feGaussianBlur', { stdDeviation: '7' })]));
      root.appendChild(view.context ? s('ellipse', { cx: ts.width / 2, cy: ts.height + 6, rx: ts.width * 0.62, ry: 16, fill: '#000000', opacity: '0.45', filter: 'url(#' + prefix + '-blur)' })
        : s('ellipse', { cx: ts.width / 2, cy: ts.height + 12, rx: ts.width * 0.5, ry: 12, fill: '#000000', opacity: '0.4', filter: 'url(#' + prefix + '-blur)' }));
    }

    // the sleeves this view shows beside the body: their colour and patterns, as context
    (view.context || []).forEach(function (c, i) {
      var cs = C.findSurface(S.doc, c.surface), cid = prefix + '-ctx' + i;
      defs.appendChild(s('clipPath', { id: cid }, [s('path', { d: C.outlinePath(c.outline) })]));
      var poly = C.flatten(c.outline), b = polygonBox(poly);
      var g = s('g', { 'clip-path': 'url(#' + cid + ')', 'data-pd-context': c.surface }, [s('rect', { x: b.x - 10, y: b.y - 10, width: b.w + 20, height: b.h + 20, fill: colour(cs.base) })]);
      cs.layers.forEach(function (n) { if (n.type === 'pattern' && n.visible) g.appendChild(layerNode(defs, prefix + '-c' + i, n, b)); });
      if (c.cuff) g.appendChild(s('line', { x1: c.cuff[0][0], y1: c.cuff[0][1], x2: c.cuff[1][0], y2: c.cuff[1][1], stroke: colour(S.doc.parts.cuffs), 'stroke-width': '26' }));
      root.appendChild(g);
      root.appendChild(s('path', { d: C.outlinePath(c.outline), class: 'pd-seam', fill: 'none' }));
    });

    // the surface being edited
    var clip = s('clipPath', { id: prefix + '-surf' }, [s('path', { d: bodyPath })]);
    defs.appendChild(clip);
    var bounds = { x: 0, y: 0, w: ts.width, h: ts.height };
    var body = s('g', { 'clip-path': 'url(#' + prefix + '-surf)' }, [s('rect', { x: -60, y: -60, width: ts.width + 120, height: ts.height + 120, fill: colour(surf.base) })]);
    surf.layers.forEach(function (n) {
      var node = layerNode(defs, prefix, n, bounds);
      if (o.nodes) o.nodes[n.id] = node;
      body.appendChild(node);
    });
    if (view.cuff) body.appendChild(s('line', { x1: view.cuff[0][0], y1: view.cuff[0][1], x2: view.cuff[1][0], y2: view.cuff[1][1], stroke: colour(S.doc.parts.cuffs), 'stroke-width': '28' }));
    root.appendChild(body);
    if (view.inner) root.appendChild(s('path', { d: C.outlinePath(view.inner), fill: shade(colour(surf.base), 0.45) }));
    if (view.collar) {
      var d = C.outlinePath(view.collar).replace(/ Z$/, '');
      root.appendChild(s('path', { d: d, fill: 'none', stroke: colour(S.doc.parts.collar), 'stroke-width': '16', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    root.appendChild(s('path', { d: bodyPath, class: 'pd-seam', fill: 'none' }));

    if (o.shaded) root.appendChild(shading(defs, prefix, view, ts));
    svg.appendChild(root);
    if (o.guides) svg.appendChild(guides(ts));
    return svg;
  }

  /** The 2.5D shading: light across the cloth, the folds a shirt makes, and its edges turning away. */
  function shading(defs, prefix, view, ts) {
    var g = s('g', { 'clip-path': 'url(#' + prefix + '-sil)', class: 'pd-shading', 'pointer-events': 'none' });
    var W = ts.width, H = ts.height;
    defs.appendChild(s('linearGradient', { id: prefix + '-lx', x1: '0', y1: '0', x2: '1', y2: '0' }, [
      s('stop', { offset: '0', 'stop-color': '#000000', 'stop-opacity': '0.6' }), s('stop', { offset: '0.2', 'stop-color': '#000000', 'stop-opacity': '0.16' }),
      s('stop', { offset: '0.4', 'stop-color': '#ffffff', 'stop-opacity': '0.13' }), s('stop', { offset: '0.52', 'stop-color': '#ffffff', 'stop-opacity': '0.04' }),
      s('stop', { offset: '0.78', 'stop-color': '#000000', 'stop-opacity': '0.16' }), s('stop', { offset: '1', 'stop-color': '#000000', 'stop-opacity': '0.62' }),
    ]));
    defs.appendChild(s('linearGradient', { id: prefix + '-ly', x1: '0', y1: '0', x2: '0', y2: '1' }, [
      s('stop', { offset: '0', 'stop-color': '#ffffff', 'stop-opacity': '0.12' }), s('stop', { offset: '0.22', 'stop-color': '#ffffff', 'stop-opacity': '0' }),
      s('stop', { offset: '0.8', 'stop-color': '#000000', 'stop-opacity': '0.08' }), s('stop', { offset: '1', 'stop-color': '#000000', 'stop-opacity': '0.42' }),
    ]));
    var vb = view.viewBox;
    g.appendChild(s('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: 'url(#' + prefix + '-lx)' }));
    g.appendChild(s('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: 'url(#' + prefix + '-ly)' }));
    defs.appendChild(s('pattern', { id: prefix + '-mesh', patternUnits: 'userSpaceOnUse', width: 3.2, height: 3.2 }, [s('circle', { cx: 1.6, cy: 1.6, r: 0.55, fill: '#000000', 'fill-opacity': '0.16' })]));
    g.appendChild(s('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: 'url(#' + prefix + '-mesh)' }));
    var folds = view.context
      ? ['M70 250 Q120 340 150 430', 'M470 250 Q420 340 390 430', 'M110 610 Q160 660 190 720', 'M430 610 Q380 660 350 720', 'M-70 190 Q-40 240 -30 290', 'M610 190 Q580 240 570 290']
      : ['M60 170 Q150 150 230 190', 'M360 180 Q300 210 260 240'];
    // One blurred group per tone, not one blur per stroke.
    var dark = s('g', { filter: 'url(#' + prefix + '-blur)', fill: 'none' }), light = s('g', { filter: 'url(#' + prefix + '-blur)', fill: 'none' });
    folds.forEach(function (d) { dark.appendChild(s('path', { d: d, stroke: '#000000', 'stroke-opacity': '0.34', 'stroke-width': '20' })); });
    var lights = view.context ? ['M200 200 Q215 400 205 640', 'M345 210 Q330 420 340 650', 'M-60 120 Q-20 150 10 200', 'M600 120 Q560 150 530 200'] : ['M120 120 Q210 100 300 120'];
    lights.forEach(function (d) { light.appendChild(s('path', { d: d, stroke: '#ffffff', 'stroke-opacity': '0.11', 'stroke-width': '34' })); });
    if (view.collar) dark.appendChild(s('path', { d: C.outlinePath(view.collar).replace(/ Z$/, ''), stroke: '#000000', 'stroke-opacity': '0.4', 'stroke-width': '14', transform: 'translate(0 9)' }));
    g.appendChild(dark);
    g.appendChild(light);
    if (!view.context) g.appendChild(s('rect', { x: 0, y: H - 40, width: W, height: 40, fill: '#000000', opacity: '0.12' }));
    return g;
  }

  /** The printable area, the safe zone, the centre line and the grid: a guide is never printed. */
  function guides(ts) {
    var g = s('g', { class: 'pd-guides', 'pointer-events': 'none' });
    if (S.grid) {
      var grid = s('g', { class: 'pd-grid' });
      for (var x = 0; x <= ts.width; x += 10) grid.appendChild(s('line', { x1: x, y1: 0, x2: x, y2: ts.height, class: x % 50 ? 'pd-grid-minor' : 'pd-grid-major' }));
      for (var y = 0; y <= ts.height; y += 10) grid.appendChild(s('line', { x1: 0, y1: y, x2: ts.width, y2: y, class: y % 50 ? 'pd-grid-minor' : 'pd-grid-major' }));
      g.appendChild(grid);
    }
    if (S.guides) {
      g.appendChild(s('path', { d: C.outlinePath(ts.outline), class: 'pd-g-print', fill: 'none' }));
      g.appendChild(s('polygon', { points: ts.safe.map(function (p) { return p.join(','); }).join(' '), class: 'pd-g-safe', fill: 'none' }));
      g.appendChild(s('line', { x1: ts.width / 2, y1: 0, x2: ts.width / 2, y2: ts.height, class: 'pd-g-centre' }));
    }
    g.appendChild(s('g', { class: 'pd-snap' }));
    return g;
  }

  // ── the canvas ────────────────────────────────────────────────────────────

  function renderCanvas() {
    if (!S || !S.el.canvas) return;
    // In 3D the garment is the picture; the 2.5D drawing beneath it is kept only until the garment is ready.
    if (S.mode === '3d' && S.el.svg && S.v3.state === 'ready') { S.el.canvas.setAttribute('data-mode', '3d'); syncCanvasLabel(); return; }
    var t0 = (window.performance && performance.now) ? performance.now() : 0;
    var c = drawSize();
    if (!S.cam || S.autoFit) fitView(c);
    S.nodes = {};
    var svg = garment(S.view, { prefix: 'pdm', nodes: S.nodes, shaded: S.mode !== '2d', guides: S.mode === '2d', cls: 'pd-svg' });
    svg.setAttribute('viewBox', C.viewBoxOf(S.cam, c.w, c.h).join(' '));
    svg.setAttribute('preserveAspectRatio', 'none');
    S.el.selection = s('g', { class: 'pd-sel' });
    svg.appendChild(S.el.selection);
    if (S.el.svg && S.el.svg.parentNode) S.el.svg.parentNode.replaceChild(svg, S.el.svg);
    else S.el.canvas.insertBefore(svg, S.el.canvas.firstChild);
    S.el.svg = svg;
    renderSelection();
    S.metrics.renders++;
    if (t0) { S.metrics.renderMs.push(performance.now() - t0); if (S.metrics.renderMs.length > 50) S.metrics.renderMs.shift(); }
    S.el.canvas.setAttribute('data-mode', S.mode);
    syncCanvasLabel();
  }
  /** Move the camera without rebuilding the drawing. */
  function applyCamera() {
    if (!S.el.svg) return;
    var c = drawSize();
    S.el.svg.setAttribute('viewBox', C.viewBoxOf(S.cam, c.w, c.h).join(' '));
    renderSelection();
    if (S.el.zoom) S.el.zoom.textContent = num(Math.round(S.cam.z / C.fitCamera(viewOf(S.view).viewBox, c.w, c.h, 8).z * 100), 0) + '%';
  }
  /** Repaint one layer — a drag, a slider — and its selection box. */
  function repaintLayer(id) {
    var old = S.nodes[id], f = C.findLayer(S.doc, id);
    if (!old || !f) { renderCanvas(); return; }
    var defs = S.el.svg.querySelector('defs');
    var stale = defs.querySelector('[id="pdm-p-' + id + '"]');
    if (stale) defs.removeChild(stale);
    var node = layerNode(defs, 'pdm', f.layer, { x: 0, y: 0, w: tSurface(f.surface.id).width, h: tSurface(f.surface.id).height });
    old.parentNode.replaceChild(node, old);
    S.nodes[id] = node;
    S.metrics.layerPaints++;
    renderSelection();
  }

  function renderSelection() {
    var g = S.el.selection;
    if (!g) return;
    clear(g);
    var n = selectedLayer();
    if (!n || !isBox(n) || !n.visible || viewOf(S.view).surface !== C.findLayer(S.doc, n.id).surface.id) return;
    var z = S.cam.z, hs = 9 / z, rot = 26 / z;
    var box = s('g', { transform: 'translate(' + n.x + ' ' + n.y + ') rotate(' + n.r + ')' });
    box.appendChild(s('rect', { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, class: 'pd-sel-box' + (n.locked ? ' is-locked' : ''), 'vector-effect': 'non-scaling-stroke' }));
    if (!n.locked) {
      box.appendChild(s('line', { x1: 0, y1: -n.h / 2, x2: 0, y2: -n.h / 2 - rot, class: 'pd-sel-stem', 'vector-effect': 'non-scaling-stroke' }));
      box.appendChild(s('circle', { cx: 0, cy: -n.h / 2 - rot, r: hs * 0.62, class: 'pd-handle pd-handle--rot', 'data-pd-handle': 'rot', 'vector-effect': 'non-scaling-stroke' }));
      [[-1, -1, 'nw'], [0, -1, 'n'], [1, -1, 'ne'], [1, 0, 'e'], [1, 1, 'se'], [0, 1, 's'], [-1, 1, 'sw'], [-1, 0, 'w']].forEach(function (k) {
        box.appendChild(s('rect', { x: k[0] * n.w / 2 - hs / 2, y: k[1] * n.h / 2 - hs / 2, width: hs, height: hs, class: 'pd-handle', 'data-pd-handle': k[2], 'vector-effect': 'non-scaling-stroke' }));
      });
    }
    g.appendChild(box);
  }
  function syncCanvasLabel() {
    var n = selectedLayer(), v = viewOf(S.view);
    if (S.mode === '3d') S.el.canvas.setAttribute('aria-label', n ? tf('3D preview, %s. Selected: %s.', T(v.label), n.name) : tf('3D preview, %s.', T(v.label)));
    else S.el.canvas.setAttribute('aria-label', n ? tf('Design canvas, %s. Selected: %s.', T(v.label), n.name) : tf('Design canvas, %s.', T(v.label)));
  }

  // ── thumbnails: the view rail, the kit preview, the product card ──────────

  function scheduleThumbs() {
    if (!S) return;
    clearTimeout(S.thumbTimer);
    S.thumbTimer = setTimeout(renderThumbs, 160);
  }
  function renderThumbs() {
    if (!S || !S.doc) return;
    var sw = S.el.strip ? S.el.strip.querySelectorAll('[data-pd-pattern]') : [];
    for (var k = 0; k < sw.length; k++) { clear(sw[k]); sw[k].appendChild(patternSwatch(sw[k].getAttribute('data-pd-pattern'))); }
    var slots = S.host.querySelectorAll('[data-pd-thumb]');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i], view = slot.getAttribute('data-pd-thumb');
      var svg = garment(view, { prefix: 'pdt' + i, shaded: true, cls: 'pd-thumb-svg' });
      clear(slot);
      slot.appendChild(svg);
    }
  }

  // ── selection, views, camera ──────────────────────────────────────────────

  function select(sel, announce) {
    var before = surfaceOfSelection();
    S.sel = sel;
    S.merge = null;
    if (S.v3.ctl) S.v3.ctl.invalidate([before, surfaceOfSelection()].filter(function (x, i, a) { return x && a.indexOf(x) === i; }));
    renderSelection();
    renderLayers();
    buildProps();
    syncCanvasLabel();
    if (S.el.bar3d) sync3d();
    if (announce) {
      var n = selectedLayer();
      say(n ? tf('Selected %s.', n.name) : sel && sel.kind === 'base' ? T('Selected the shirt base colour.') : T('Nothing selected.'));
    }
  }
  function setView(id) {
    if (id === S.view) { if (S.mode === '3d') reset3d(); return; }
    S.view = id;
    if (S.v3.ctl) { S.v3.ctl.preset(id); S.v3.turntable = false; sync3d(); }
    var n = selectedLayer();
    if (n && C.findLayer(S.doc, n.id).surface.id !== viewOf(id).surface) S.sel = null;
    S.autoFit = true;
    renderCanvas();
    renderLayers();
    buildProps();
    syncViews();
    say(tf('Showing %s.', T(viewOf(id).label)));
  }
  function zoomBy(f, at) {
    var c = canvasSize();
    S.cam = C.zoomAt(S.cam, c.w, c.h, S.cam.z * f, at || { x: c.w / 2, y: c.h / 2 });
    S.autoFit = false;
    applyCamera();
  }

  // ── elements ──────────────────────────────────────────────────────────────

  var ELEMENTS = [
    { kind: 'text', icon: 'text', label: L('Text') },
    { kind: 'name', icon: 'text', label: L('Player name') },
    { kind: 'number', icon: 'text', label: L('Player number') },
    { kind: 'shield', icon: 'shield', label: L('Shield') },
    { kind: 'circle', icon: 'shape', label: L('Circle') },
    { kind: 'star', icon: 'shape', label: L('Star') },
    { kind: 'band', icon: 'shape', label: L('Band') },
    { kind: 'chevron', icon: 'shape', label: L('Chevron') },
    { kind: 'diamond', icon: 'shape', label: L('Diamond') },
  ];
  /** A new element at the middle of the safe zone, in the design's lightest-contrast colour. */
  function addElement(kind) {
    var surf = surfaceOfView(), ts = tSurface(surf.id), b = polygonBox(ts.safe);
    var small = ts.width < 500 ? 0.45 : 1;
    var cx = C.mm(b.x + b.w / 2), cy = C.mm(b.y + b.h * (ts.width < 500 ? 0.5 : 0.36));
    var col = S.doc.palette[S.doc.palette.length - 1].id, layer, size;
    var base = { id: C.nextId(S.doc, 'l'), visible: true, locked: false };
    if (kind === 'text') { size = [220, 54]; layer = { type: 'text', name: T('Text'), text: T('Text'), font: 'sans-black', color: col, outline: null }; }
    else if (kind === 'name') { size = [300, 46]; layer = { type: 'roster', name: T('Player name'), field: 'name', font: 'sans-black', color: col, outline: null }; }
    else if (kind === 'number') { size = [200, 220]; layer = { type: 'roster', name: T('Player number'), field: 'number', font: 'sans-black', color: col, outline: null }; }
    else {
      size = kind === 'band' ? [300, 40] : kind === 'shield' ? [64, 76] : [70, 70];
      var label = (ELEMENTS.filter(function (e) { return e.kind === kind; })[0] || ELEMENTS[3]).label;
      layer = { type: 'shape', name: T(label), shape: kind, color: col, outline: null };
    }
    var w = C.mm(size[0] * small), hh = C.mm(size[1] * small);
    for (var k in base) layer[k] = base[k];
    layer.x = cx; layer.y = cy; layer.w = w; layer.h = hh; layer.r = 0; layer.w0 = w; layer.h0 = hh;
    if (commitOp({ op: 'insert', surface: surf.id, index: surf.layers.length, layer: layer }, T('Add element'))) {
      select({ kind: 'layer', id: layer.id });
      say(tf('Added %s to the %s.', layer.name, T(tSurface(surf.id).label)));
    }
  }
  function addPattern(pattern) {
    var surf = surfaceOfView();
    var existing = surf.layers.filter(function (n) { return n.type === 'pattern'; });
    var sel = selectedLayer();
    var target = sel && sel.type === 'pattern' ? sel : existing[existing.length - 1];
    if (target) {
      setLayer(target.id, 'pattern', pattern, T('Pattern'));
      select({ kind: 'layer', id: target.id });
    } else {
      var layer = { id: C.nextId(S.doc, 'l'), type: 'pattern', name: T('Pattern'), visible: true, locked: false, pattern: pattern,
        color: S.doc.palette[Math.min(1, S.doc.palette.length - 1)].id, scale: 84, angle: pattern === 'hoops' ? 0 : pattern === 'vertical' || pattern === 'pinstripe' ? 0 : 35, opacity: 70 };
      if (commitOp({ op: 'insert', surface: surf.id, index: 0, layer: layer }, T('Pattern'))) select({ kind: 'layer', id: layer.id });
    }
    say(tf('Pattern: %s.', T(PATTERN_LABEL[pattern])));
  }
  function duplicateSel() {
    var n = selectedLayer();
    if (!n) return;
    var f = C.findLayer(S.doc, n.id), copy = C.clone(n);
    copy.id = C.nextId(S.doc, 'l');
    copy.name = tf('%s copy', n.name).slice(0, LIMITS.name);
    if (isBox(copy)) { copy.x = C.mm(copy.x + 10); copy.y = C.mm(copy.y + 10); }
    if (commitOp({ op: 'insert', surface: f.surface.id, index: f.index + 1, layer: copy }, T('Duplicate'))) {
      select({ kind: 'layer', id: copy.id });
      say(tf('Duplicated %s.', n.name));
    }
  }
  function deleteSel() {
    var n = selectedLayer();
    if (!n) return;
    if (commitOp({ op: 'remove', id: n.id }, T('Delete'))) { select(null); say(tf('Deleted %s. Undo brings it back.', n.name)); }
  }
  function reorder(delta) {
    var n = selectedLayer();
    if (!n) return;
    var f = C.findLayer(S.doc, n.id), to = f.index + delta;
    if (to < 0 || to >= f.surface.layers.length) return;
    if (commitOp({ op: 'move', id: n.id, index: to }, delta > 0 ? T('Bring forward') : T('Send backward'))) say(delta > 0 ? tf('%s brought forward.', n.name) : tf('%s sent backward.', n.name));
  }
  function nudge(dx, dy) {
    var n = selectedLayer();
    if (!n || !isBox(n) || n.locked) return;
    batch([
      { op: 'set', target: { kind: 'layer', id: n.id }, key: 'x', value: C.mm(Math.max(-LIMITS.coord, Math.min(LIMITS.coord, n.x + dx))) },
      { op: 'set', target: { kind: 'layer', id: n.id }, key: 'y', value: C.mm(Math.max(-LIMITS.coord, Math.min(LIMITS.coord, n.y + dy))) },
    ], T('Move'));
    say(tf('%s at %s mm, %s mm.', n.name, num(n.x), num(n.y)));
  }
  function rotateBy(d) {
    var n = selectedLayer();
    if (!n || !isBox(n) || n.locked) return;
    setLayer(n.id, 'r', C.normAngle(n.r + d), T('Rotate'));
    say(tf('%s rotated to %d°.', n.name, n.r));
  }
  function undoRedo(which) {
    var e = which === 'undo' ? C.undo(S.doc, S.hist) : C.redo(S.doc, S.hist);
    S.merge = null;
    if (!e) { say(which === 'undo' ? T('Nothing to undo.') : T('Nothing to redo.')); return; }
    changed();
    buildProps();
    say(which === 'undo' ? tf('Undid: %s', e.label) : tf('Redid: %s', e.label));
  }
  function syncHistory() {
    if (!S.el.undo) return;
    S.el.undo.setAttribute('aria-disabled', S.hist.past.length ? 'false' : 'true');
    S.el.redo.setAttribute('aria-disabled', S.hist.future.length ? 'false' : 'true');
  }

  // ── pointer input on the canvas ───────────────────────────────────────────

  function onPointerDown(ev) {
    if (S.mode === '3d') { if (S.el.host3d && S.el.host3d.contains(ev.target)) S.el.canvas.focus({ preventScroll: true }); return; }
    if (ev.button !== 0 && ev.button !== 1) return;
    S.el.canvas.focus({ preventScroll: true });
    var p = pointerWorld(ev), handle = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-pd-handle') : null;
    var n = selectedLayer();
    if (ev.button === 1 || S.space) { S.drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, cam: S.cam, moved: false }; }
    else if (handle && n && !n.locked) {
      S.drag = { kind: handle === 'rot' ? 'rotate' : 'resize', handle: handle, id: n.id, start: C.clone(n), p0: p, moved: false };
    } else {
      var hit = C.hitTest(surfaceOfView(), p);
      if (hit) {
        if (!n || n.id !== hit) select({ kind: 'layer', id: hit }, true);
        var l = selectedLayer();
        S.drag = { kind: 'move', id: hit, start: C.clone(l), p0: p, sx: ev.clientX, sy: ev.clientY, moved: false };
      } else {
        if (S.sel) select(null);
        S.drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, cam: S.cam, moved: false };
      }
    }
    try { S.el.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.preventDefault();
  }
  function onPointerMove(ev) {
    var d = S.drag;
    if (!d) return;
    if (!d.moved && d.sx != null && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < DRAG_THRESHOLD) return;
    d.moved = true;
    if (d.kind === 'pan') {
      S.cam = C.panBy(d.cam, ev.clientX - d.sx, ev.clientY - d.sy);
      S.autoFit = false;
      applyCamera();
      return;
    }
    var p = pointerWorld(ev), f = C.findLayer(S.doc, d.id), n = f.layer, ts = tSurface(f.surface.id);
    var vals;
    if (d.kind === 'move') {
      var m = C.moveBox(d.start, p.x - d.p0.x, p.y - d.p0.y, { centerX: ev.altKey ? null : ts.width / 2, threshold: 6 / S.cam.z, grid: S.grid && !ev.altKey ? 5 : 0 });
      vals = { x: m.x, y: m.y };
      showSnap(m.guides, ts);
    } else if (d.kind === 'resize') {
      var hx = /e/.test(d.handle) ? 1 : /w/.test(d.handle) ? -1 : 0, hy = /s/.test(d.handle) ? 1 : /n/.test(d.handle) ? -1 : 0;
      vals = C.resizeBox(d.start, hx, hy, p, ev.shiftKey);
    } else vals = { r: C.rotateToward(d.start, p, ev.shiftKey ? 15 : 0) };
    for (var k in vals) if (Object.prototype.hasOwnProperty.call(vals, k)) C.applyOp(S.doc, { op: 'set', target: { kind: 'layer', id: n.id }, key: k, value: vals[k] });
    repaintLayer(n.id);
    syncProps();
  }
  function onPointerUp(ev) {
    var d = S.drag;
    S.drag = null;
    try { S.el.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    showSnap([], null);
    if (!d || !d.moved || d.kind === 'pan') return;
    recordDrag(d);
  }
  /** A finished drag, 2D or 3D: the values it reached become one undo step. */
  function recordDrag(d) {
    var f = C.findLayer(S.doc, d.id);
    if (!f) return;
    var n = f.layer, ops = [], inv = [];
    ['x', 'y', 'w', 'h', 'r'].forEach(function (k) {
      if (n[k] !== d.start[k]) {
        ops.push({ op: 'set', target: { kind: 'layer', id: n.id }, key: k, value: n[k] });
        inv.unshift({ op: 'set', target: { kind: 'layer', id: n.id }, key: k, value: d.start[k] });
      }
    });
    if (!ops.length) return;
    C.record(S.hist, { op: 'batch', ops: ops }, { op: 'batch', ops: inv }, d.kind === 'move' ? T('Move') : d.kind === 'resize' ? T('Resize') : T('Rotate'));
    S.merge = null;
    S.metrics.commits++;
    changed(n.id);
    say(d.kind === 'move' ? tf('%s at %s mm, %s mm.', n.name, num(n.x), num(n.y)) : d.kind === 'resize' ? tf('%s is %s × %s mm.', n.name, num(n.w), num(n.h)) : tf('%s rotated to %d°.', n.name, n.r));
  }
  function showSnap(list, ts) {
    var g = S.el.svg && S.el.svg.querySelector('.pd-snap');
    if (!g) return;
    clear(g);
    (list || []).forEach(function (gd) { if (gd.axis === 'x') g.appendChild(s('line', { x1: gd.at, y1: -20, x2: gd.at, y2: ts.height + 20, class: 'pd-snap-line', 'vector-effect': 'non-scaling-stroke' })); });
  }
  function onWheel(ev) {
    if (S.mode === '3d') return;
    ev.preventDefault();
    var c = canvasSize(), at = { x: ev.clientX - c.left, y: ev.clientY - c.top };
    if (ev.ctrlKey || ev.metaKey) zoomBy(Math.exp(-ev.deltaY * 0.0022), at);
    else { S.cam = C.panBy(S.cam, -ev.deltaX, -ev.deltaY); S.autoFit = false; applyCamera(); }
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  function typing(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
  function onKeyDown(ev) {
    var mod = ev.ctrlKey || ev.metaKey, k = ev.key;
    if (mod && (k === 'z' || k === 'Z') && !typing(ev.target)) { ev.preventDefault(); undoRedo(ev.shiftKey ? 'redo' : 'undo'); return; }
    if (mod && (k === 'y' || k === 'Y') && !typing(ev.target)) { ev.preventDefault(); undoRedo('redo'); return; }
    if (mod && (k === 's' || k === 'S')) { ev.preventDefault(); serverSave(); return; }
    if (k === 'Escape' && S.srv.open) { ev.preventDefault(); closeDock(); return; }
    if (k === 'Escape' && S.panel) { setPanel(null); return; }
    if (ev.target !== S.el.canvas) return;
    var n = selectedLayer(), step = ev.shiftKey ? 10 : 1;
    if (S.mode === '3d' && S.v3.ctl && key3d(ev, n)) return;
    if (k === ' ') { S.space = true; ev.preventDefault(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      if (!n) return;
      ev.preventDefault();
      nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
    } else if (k === ',' || k === '<') { if (n) { ev.preventDefault(); rotateBy(ev.shiftKey ? -15 : -1); } }
    else if (k === '.' || k === '>') { if (n) { ev.preventDefault(); rotateBy(ev.shiftKey ? 15 : 1); } }
    else if (k === 'Delete' || k === 'Backspace') { if (n) { ev.preventDefault(); deleteSel(); } }
    else if (mod && (k === 'd' || k === 'D')) { ev.preventDefault(); duplicateSel(); }
    else if (k === 'Escape') { if (S.sel) { ev.preventDefault(); select(null, true); } }
    else if (k === 'Tab' && n) {
      var list = surfaceOfView().layers.filter(function (x) { return isBox(x) && x.visible; });
      var i = list.map(function (x) { return x.id; }).indexOf(n.id);
      var next = list[i + (ev.shiftKey ? -1 : 1)];
      if (next) { ev.preventDefault(); select({ kind: 'layer', id: next.id }, true); }
    } else if (k === '+' || k === '=') { ev.preventDefault(); zoomBy(1.2); }
    else if (k === '-' || k === '_') { ev.preventDefault(); zoomBy(1 / 1.2); }
    else if (k === '0') { ev.preventDefault(); fitView(); applyCamera(); }
  }
  function onKeyUp(ev) { if (ev.key === ' ') S.space = false; }

  // ── the 3D view (DS-1c) ───────────────────────────────────────────────────
  //
  // pd-3d.js draws the garment with the platform's Babylon.js; this side paints
  // it. Each surface's artwork is drawn by the same layerNode the 2D canvas uses,
  // in the surface's own millimetres, and what a pointer does on the garment
  // comes back as the same operations, the same snapping and the same undo
  // history. One document drives 2D, 3D and every saved version.

  var D3 = window.FamilistaProductDesign3D || null;
  var G3 = window.FamilistaProductDesignGarment || null;
  var LIGHT_LABEL = { studio: L('Studio'), daylight: L('Daylight'), stadium: L('Stadium') };
  var FABRIC_LABEL = { smooth: L('Smooth polyester (simulated)'), mesh: L('Mesh knit (simulated)') };
  var FABRIC_SHORT = { smooth: L('Smooth'), mesh: L('Mesh') };
  var QUALITY_LABEL = { high: L('High'), balanced: L('Balanced'), low: L('Low') };
  var SIM_NOTE = L('A procedural prototype of the garment, drawn from the template’s flat panels. Fabric, light and colour are simulated on a screen: this is not a colour proof, a production pattern or manufacturing approval.');
  var FAIL_3D = {
    webgl: L('3D could not start: this browser or device does not provide WebGL. The 2.5D preview shows the same design.'),
    babylon: L('3D could not start: the 3D engine could not be loaded. Check the connection and choose 3D again.'),
    engine: L('3D could not start on this device. The 2.5D preview shows the same design.'),
    texture: L('The 3D view could not draw the design on this device, so it was closed. The 2.5D preview shows the same design.'),
  };

  function fresh3d() {
    // A phone, or a device with little memory, starts at the lighter quality; the reader can change it.
    var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches), mem = navigator.deviceMemory;
    return { ctl: null, state: 'off', token: 0, quality: coarse || (mem && mem <= 4) ? 'low' : 'balanced', lighting: 'studio', fabric: 'smooth',
      check: false, turntable: false, compare: null, pendingCompare: 0, drag: null, failed: '', trims: '' };
  }
  function can3d() { return !!(D3 && G3 && D3.webglAvailable()); }
  /** A control that needs 3D: live where WebGL is, otherwise unavailable and saying why. */
  function live3d(el, reasonKey) { return can3d() ? el : planned(el, reasonKey); }
  function surfaceOfSelection() {
    var f = S.sel && S.sel.kind === 'layer' ? C.findLayer(S.doc, S.sel.id) : null;
    return f ? f.surface.id : null;
  }
  function viewForSurface(id) {
    for (var i = 0; i < TEMPLATE.views.length; i++) if (TEMPLATE.views[i].surface === id) return TEMPLATE.views[i].id;
    return S.view;
  }
  function trimColours() { return { collar: colour(S.doc.parts.collar), cuffs: colour(S.doc.parts.cuffs) }; }
  /** Run fn with another document in the editor's place, synchronously: how a saved version is drawn without opening it. */
  function withDoc(doc, fn) {
    var keep = S.doc;
    S.doc = doc;
    try { return fn(); } finally { S.doc = keep; }
  }

  // The overlay colours, from the design tokens: an image of SVG sees none of the page's styles.
  var INK = null;
  function tokenHex(tok, fallback) {
    var probe = h('span', { class: 'pd-probe', 'aria-hidden': 'true' });
    S.host.appendChild(probe);
    probe.style.color = 'var(' + tok + ')';
    var c = getComputedStyle(probe).color || '', m, v = null;
    S.host.removeChild(probe);
    if ((m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/))) v = [Number(m[1]), Number(m[2]), Number(m[3])];
    else if ((m = c.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/))) v = [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
    if (!v) return fallback;
    return '#' + v.map(function (x) { var y = Math.max(0, Math.min(255, Math.round(x))).toString(16); return y.length < 2 ? '0' + y : y; }).join('');
  }
  function ink() {
    if (!INK) INK = {
      focus: tokenHex('--fam-focus-ring', '#8fb2ff'), safe: tokenHex('--fam-module-accent', '#7c5cff'), print: tokenHex('--fam-text-primary', '#eef1fa'),
      critical: tokenHex('--fam-status-critical', '#ef4444'), warning: tokenHex('--fam-status-warning', '#f59e0b'), seam: tokenHex('--fam-text-tertiary', '#9aa4c4'),
    };
    return INK;
  }

  /**
   * One surface's artwork for the garment, w × h pixels: what the 2D canvas draws
   * on it, without the 2D view's shading or neighbouring sleeves. With `overlay`,
   * the selection and, when asked for, the print check and the grid.
   */
  function texture3d(surfaceId, w, hgt, overlay) {
    var ts = tSurface(surfaceId), surf = C.findSurface(S.doc, surfaceId), prefix = 'pd3s-' + surfaceId;
    var defs = s('defs'), outline = C.outlinePath(ts.outline), base = colour(surf.base);
    var svg = s('svg', { xmlns: SVG, width: w, height: hgt, viewBox: '0 0 ' + ts.width + ' ' + ts.height, preserveAspectRatio: 'none' }, [defs]);
    defs.appendChild(s('clipPath', { id: prefix + '-clip' }, [s('path', { d: outline })]));
    // A hairline of the base colour beyond the outline keeps the garment's edge whole where the artwork is sampled.
    svg.appendChild(s('path', { d: outline, fill: base, stroke: base, 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
    var bounds = { x: 0, y: 0, w: ts.width, h: ts.height };
    var body = s('g', { 'clip-path': 'url(#' + prefix + '-clip)' }, [s('rect', { x: -60, y: -60, width: ts.width + 120, height: ts.height + 120, fill: base })]);
    surf.layers.forEach(function (n) {
      var node = layerNode(defs, prefix, n, bounds), t = node.querySelector('text');
      // Written out in full: the token the 2D canvas uses means nothing inside an image.
      if (t) { t.style.removeProperty('font-family'); t.setAttribute('font-family', familyOf(FONT[n.font] || FONT['sans-black'])); }
      body.appendChild(node);
    });
    TEMPLATE.views.forEach(function (v) {
      if (v.surface !== surfaceId) return;
      if (v.cuff) body.appendChild(s('line', { x1: v.cuff[0][0], y1: v.cuff[0][1], x2: v.cuff[1][0], y2: v.cuff[1][1], stroke: colour(S.doc.parts.cuffs), 'stroke-width': '28' }));
      if (v.collar) body.appendChild(s('path', { d: C.outlinePath(v.collar).replace(/ Z$/, ''), fill: 'none', stroke: colour(S.doc.parts.collar), 'stroke-width': '16', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    });
    svg.appendChild(body);
    if (overlay) svg.appendChild(overlay3d(surfaceId, ts));
    return new XMLSerializer().serializeToString(svg);
  }
  function boxOutline(n, stroke, width, dash) {
    return s('rect', { x: -n.w / 2 - 2, y: -n.h / 2 - 2, width: n.w + 4, height: n.h + 4, rx: 1.5, transform: 'translate(' + n.x + ' ' + n.y + ') rotate(' + n.r + ')',
      fill: 'none', stroke: stroke, 'stroke-width': width, 'stroke-dasharray': dash || null });
  }
  /** What is drawn on the artwork but never printed: the grid, the print check and the selection. */
  function overlay3d(surfaceId, ts) {
    var g = s('g', { fill: 'none' }), c = ink();
    if (S.grid) {
      for (var x = 10; x < ts.width; x += 10) g.appendChild(s('line', { x1: x, y1: 0, x2: x, y2: ts.height, stroke: c.print, 'stroke-opacity': x % 50 ? '0.14' : '0.3', 'stroke-width': x % 50 ? '0.45' : '0.8' }));
      for (var y = 10; y < ts.height; y += 10) g.appendChild(s('line', { x1: 0, y1: y, x2: ts.width, y2: y, stroke: c.print, 'stroke-opacity': y % 50 ? '0.14' : '0.3', 'stroke-width': y % 50 ? '0.45' : '0.8' }));
    }
    if (S.v3.check) {
      // Drawn to be read on the whole garment, not only close up: a light outline and a light dashed safe zone over a dark edge.
      g.appendChild(s('path', { d: C.outlinePath(ts.outline), stroke: c.print, 'stroke-opacity': '0.85', 'stroke-width': '2.4' }));
      var safe = ts.safe.map(function (p) { return p.join(','); }).join(' ');
      g.appendChild(s('polygon', { points: safe, stroke: '#000000', 'stroke-opacity': '0.35', 'stroke-width': '3.6' }));
      g.appendChild(s('polygon', { points: safe, stroke: c.print, 'stroke-width': '2.2', 'stroke-dasharray': '9 6' }));
      // The same deterministic check the Product panel lists: outside the printable area, across the safe zone, lettering too small.
      C.checkDesign(S.doc, TEMPLATE).forEach(function (f) {
        if (f.surface !== surfaceId) return;
        var n = C.findLayer(S.doc, f.layer);
        if (n) g.appendChild(boxOutline(n.layer, f.severity === 'blocker' ? c.critical : c.warning, 3.2, '8 4'));
      });
    }
    var sel = selectedLayer();
    if (sel && isBox(sel) && sel.visible && surfaceOfSelection() === surfaceId) g.appendChild(boxOutline(sel, c.focus, 1.6, sel.locked ? '4 3' : null));
    return g;
  }

  // ── opening, closing, failing ────────────────────────────────────────────
  function setMode(mode) {
    if (mode === S.mode) return;
    if (mode === '3d' && !can3d()) { say(T(REASON['3d'])); return; }
    S.mode = mode;
    S.v3.failed = '';
    syncModes();
    if (mode === '3d') open3d();
    else { close3d(); renderCanvas(); syncViews(); say(mode === '2d' ? T('Flat panels, with the printable area and safe zone') : T('Shaded preview')); }
  }
  function syncModes() {
    var ms = S.el.modes ? S.el.modes.querySelectorAll('[data-pd-mode]') : [];
    for (var i = 0; i < ms.length; i++) if (ms[i].getAttribute('aria-disabled') !== 'true') ms[i].setAttribute('aria-pressed', ms[i].getAttribute('data-pd-mode') === S.mode ? 'true' : 'false');
    var guides = S.host.querySelector('[data-pd-act="guides"]');
    if (guides) {
      guides.setAttribute('aria-pressed', (S.mode === '3d' ? S.v3.check : S.guides) ? 'true' : 'false');
      guides.setAttribute('title', S.mode === '3d' ? T('Print check: printable area, safe zone, seams and findings') : T('Printable area and safe zone'));
    }
    S.el.canvas.setAttribute('data-mode', S.mode);
    syncCanvasLabel();
    sync3d();
  }
  function open3d() {
    var v = S.v3, token = ++v.token, mine = S, first = true, started = Date.now();
    v.state = 'loading';
    sync3d();
    D3.open(S.el.host3d, {
      template: TEMPLATE, quality: v.quality, colours: trimColours(), seam: ink().seam, font: familyOf(FONT['sans-bold']), dir: DIR,
      texture: function (id, w, hgt) { return texture3d(id, w, hgt, true); },
      onPick: pick3d, onDrag: drag3d, onDrop: drop3d,
      onError: function (code) { if (S === mine && v.token === token) fail3d(code); },
    }).then(function (ctl) {
      if (S !== mine || v.token !== token || S.mode !== '3d') { if (ctl && ctl.dispose) ctl.dispose(); return; }
      if (!ctl || ctl.error) { fail3d(ctl ? ctl.error : 'engine'); return; }
      v.ctl = ctl;
      v.trims = JSON.stringify(trimColours());
      ctl.setLighting(v.lighting);
      ctl.setFabric(v.fabric);
      ctl.setCheck(v.check);
      ctl.preset(S.view, true);
      if (v.turntable) v.turntable = ctl.setTurntable(true);
      // The garment is shown once its artwork is painted, not before: until then the 2.5D drawing stays.
      (function ready() {
        if (S !== mine || v.token !== token || !v.ctl) return;
        if (v.ctl.pending() && first) {
          if (Date.now() - started > 15000) { fail3d('texture'); return; }
          window.requestAnimationFrame(ready);
          return;
        }
        first = false;
        v.state = 'ready';
        sync3d();
        renderCanvas();
        say(T('3D view ready. Drag to turn the garment, pinch or use the wheel to zoom, and drag an element to move it.'));
        if (v.pendingCompare) { var n = v.pendingCompare; v.pendingCompare = 0; compareWith(n); }
      }());
    });
  }
  function close3d() {
    if (!S || !S.v3) return;
    var v = S.v3;
    v.token++;
    if (v.ctl) { v.ctl.dispose(); v.ctl = null; }
    v.state = 'off';
    v.drag = null;
    v.compare = null;
    v.pendingCompare = 0;
    if (S.el.canvas) sync3d();
  }
  function fail3d(code) {
    close3d();
    S.v3.failed = FAIL_3D[code] ? code : 'engine';
    S.mode = '2.5d';
    syncModes();
    renderCanvas();
    syncViews();
    say(T(FAIL_3D[S.v3.failed]));
  }

  // ── the garment, as the reader handles it ─────────────────────────────────
  function pick3d(surfaceId, mm) {
    S.el.canvas.focus({ preventScroll: true });
    // A press beside an element turns the garment and keeps the selection; Escape or the list clears it.
    if (!surfaceId) return false;
    var hit = C.hitTest(C.findSurface(S.doc, surfaceId), mm);
    if (!hit) return false;
    if (viewOf(S.view).surface !== surfaceId) { S.view = viewForSurface(surfaceId); renderLayers(); syncViews(); }
    if (!S.sel || S.sel.id !== hit) select({ kind: 'layer', id: hit }, true);
    var n = selectedLayer();
    if (!n) return false;
    S.v3.drag = { kind: 'move', id: n.id, surface: surfaceId, start: C.clone(n), p0: { x: mm.x, y: mm.y }, moved: false };
    return true;
  }
  function drag3d(surfaceId, mm) {
    var d = S.v3.drag;
    if (!d || d.surface !== surfaceId || !C.findLayer(S.doc, d.id)) return;
    var ts = tSurface(surfaceId);
    // The same move, snapping and grid as on the flat panel: a millimetre here is a millimetre there.
    var m = C.moveBox(d.start, mm.x - d.p0.x, mm.y - d.p0.y, { centerX: ts.width / 2, threshold: 4, grid: S.grid ? 5 : 0 });
    d.moved = true;
    C.applyOp(S.doc, { op: 'set', target: { kind: 'layer', id: d.id }, key: 'x', value: m.x });
    C.applyOp(S.doc, { op: 'set', target: { kind: 'layer', id: d.id }, key: 'y', value: m.y });
    if (S.v3.ctl) S.v3.ctl.invalidate([surfaceId]);
    syncProps();
  }
  function drop3d(moved) {
    var d = S.v3.drag;
    S.v3.drag = null;
    if (d && moved) recordDrag(d);
  }
  function key3d(ev, n) {
    var k = ev.key, ctl = S.v3.ctl, step = ev.shiftKey ? 0.3 : 0.1;
    if (!n && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown')) {
      ev.preventDefault();
      ctl.orbit(k === 'ArrowLeft' ? step : k === 'ArrowRight' ? -step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
      if (S.v3.turntable) { S.v3.turntable = false; sync3d(); }
      return true;
    }
    if (k === '+' || k === '=') { ev.preventDefault(); ctl.zoom(0.88); return true; }
    if (k === '-' || k === '_') { ev.preventDefault(); ctl.zoom(1 / 0.88); return true; }
    if (k === '0') { ev.preventDefault(); reset3d(); return true; }
    if (/^[1-9]$/.test(k) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      var v = TEMPLATE.views[Number(k) - 1];
      if (v) { ev.preventDefault(); setView(v.id); return true; }
    }
    return false;
  }
  function reset3d() {
    if (!S.v3.ctl) return;
    S.v3.ctl.preset(S.view);
    S.v3.turntable = false;
    sync3d();
    say(tf('Showing %s.', T(viewOf(S.view).label)));
  }
  function toggleTurntable() {
    var v = S.v3;
    if (S.mode !== '3d') { v.turntable = true; setMode('3d'); return; }
    if (!v.ctl) return;
    var want = !v.turntable;
    v.turntable = v.ctl.setTurntable(want);
    sync3d();
    say(v.turntable ? T('Turning the garment. Press 360° again to stop.') : want ? T('The turntable stays still because this device asks for reduced motion.') : T('Turning stopped.'));
  }
  function closeUp() {
    var n = selectedLayer();
    if (!S.v3.ctl || !n || !isBox(n)) { say(T('Select an element on the garment to look at it close up.')); return; }
    S.v3.ctl.focus(surfaceOfSelection(), n.x, n.y);
    S.v3.turntable = false;
    sync3d();
    say(tf('Close-up on %s.', n.name));
  }
  function setCheck3d(on) {
    S.v3.check = on;
    if (S.v3.ctl) { S.v3.ctl.setCheck(on); S.v3.ctl.invalidate(); }
    syncModes();
    say(on ? T('Print check shown: the printable area, the safe zone, the seams and every finding. It is a check against the template, not manufacturing approval.') : T('Print check hidden.'));
  }
  function syncTrims3d() {
    var key = JSON.stringify(trimColours());
    if (S.v3.ctl && key !== S.v3.trims) { S.v3.trims = key; S.v3.ctl.setColours(trimColours()); }
  }
  /** Light, fabric and quality are short lists: a press moves to the next, and says which it is. */
  function cycle3d(what) {
    var v = S.v3, ctl = v.ctl;
    function next(list, cur) { return list[(list.indexOf(cur) + 1) % list.length]; }
    if (what === 'light') { v.lighting = next(D3.LIGHTS, v.lighting); if (ctl) ctl.setLighting(v.lighting); say(tf('Light: %s. Colours on a screen are a simulation, not the printed colour.', T(LIGHT_LABEL[v.lighting]))); }
    else if (what === 'fabric') { v.fabric = next(D3.FABRICS, v.fabric); if (ctl) ctl.setFabric(v.fabric); say(tf('Fabric: %s.', T(FABRIC_LABEL[v.fabric]))); }
    else if (what === 'quality') {
      v.quality = next(D3.QUALITY, v.quality);
      if (ctl && ctl.setQuality(v.quality)) { v.compare = null; ctl.setCheck(v.check); }
      say(tf('Quality: %s.', T(QUALITY_LABEL[v.quality])));
    }
    sync3d();
  }

  // ── comparing with a saved version, which is read and never changed ───────
  /** The 3D bar's compare button: stop comparing, or open the Versions panel, where each version can be compared. */
  function compareButton(t) {
    if (S.v3.compare) { compareWith(0); return; }
    openDock('versions', t);
  }
  /** Compare in 3D from the Versions panel: in 3D at once, otherwise once 3D is ready. */
  function compareFromDock(number) {
    closeDock();
    if (S.mode === '3d' && S.v3.ctl) { compareWith(number); return; }
    if (!can3d()) { say(T(REASON['3d'])); return; }
    S.v3.pendingCompare = number;
    setMode('3d');
  }
  function compareWith(number, quiet) {
    var v = S.v3, link = S.srv.link, mine = S;
    if (!number) {
      var was = v.compare;
      v.compare = null;
      if (v.ctl && was) v.ctl.setCompare(null);
      sync3d();
      if (was && !quiet) say(T('Comparison closed.'));
      return;
    }
    if (!link || !v.ctl) return;
    v.compare = { number: number, projectId: link.projectId, state: 'loading' };
    sync3d();
    P.api.getRevision(link.projectId, number).then(function (r) {
      if (S !== mine || !v.ctl || !v.compare || v.compare.number !== number) return;
      var doc = null;
      try { doc = r.ok && r.data && r.data.revision ? C.validateDocument(r.data.revision.document, TEMPLATE) : null; } catch (_) { doc = null; }
      if (!doc) { v.compare = null; sync3d(); say(r.ok ? T('This saved design cannot be opened by this version of the Design Studio.') : tf('That version could not be opened: %s', serverProblem(r))); return; }
      v.compare = { number: number, projectId: link.projectId, state: 'ready' };
      v.ctl.setCompare(function (id, w, hgt) { return withDoc(doc, function () { return texture3d(id, w, hgt, false); }); },
        withDoc(doc, trimColours), { current: T('This design'), other: tf('Version %d', number) });
      v.turntable = false;
      sync3d();
      say(tf('Comparing with version %d, on the right. The saved version is not changed.', number));
    });
  }

  // ── the 3D chrome: drawn once with the canvas, kept in step by sync3d ─────
  function cycleBtn(what, ic) {
    return btn({ class: 'pd3-cycle', 'data-pd-act': 'cycle-' + what }, [icon(ic, 14), h('span', { class: 'pd3-cycle-value' })]);
  }
  function chrome3d(E) {
    E.host3d = h('div', { class: 'pd3-host' });
    E.sim3d = h('p', { class: 'pd3-sim', title: T(SIM_NOTE) }, [icon('info', 13), h('span', { text: T('Visual simulation') })]);
    E.status3d = h('p', { class: 'pd3-status', role: 'status' });
    E.bar3d = h('div', { class: 'pd3-bar', role: 'toolbar', 'aria-label': T('3D view'), dir: DIR }, [
      cycleBtn('light', 'sun'), cycleBtn('fabric', 'shirt'), cycleBtn('quality', 'gear'),
      h('span', { class: 'pd3-sep', 'aria-hidden': 'true' }),
      btn({ class: 'pd-icbtn pd3-btn', 'data-pd-act': 'closeup', 'aria-label': T('Close-up on the selection'), title: T('Close-up on the selection'), 'data-pd-why': T('Select an element on the garment to look at it close up.') }, [icon('zoomIn')]),
      btn({ class: 'pd-icbtn pd3-btn', 'data-pd-act': 'compare3d', 'aria-pressed': 'false', 'data-pd-why': T('Save the design to compare it with its saved versions.') }, [icon('compare')]),
    ]);
    [E.host3d, E.sim3d, E.status3d, E.bar3d].forEach(function (el) { E.canvas.appendChild(el); });
  }
  function sync3d() {
    var E = S.el, v = S.v3;
    if (!E.canvas || !E.bar3d) return;
    E.canvas.setAttribute('data-3d', S.mode === '3d' ? v.state : 'off');
    E.status3d.textContent = S.mode !== '3d' ? '' : v.state === 'loading' ? T('Preparing the 3D view…')
      : v.compare && v.compare.state === 'loading' ? tf('Opening version %d…', v.compare.number) : '';
    E.help.textContent = S.mode === '3d'
      ? T('3D view of the design. Drag the garment to turn it, pinch or use the wheel to zoom, and drag an element to move it across its surface, in millimetres. Arrow keys turn the garment when nothing is selected and move the selection when something is; plus and minus zoom; 0 returns to the current view; 1 to 4 show the front, the back, the right and the left side.') + ' ' + T(SIM_NOTE)
      : T('Design canvas. Click an element to select it, drag to move it, drag its handles to resize or rotate it; drag the empty canvas to pan, Control and the wheel to zoom. Arrow keys move the selection 1 mm, Shift and an arrow 10 mm; comma and full stop rotate it; Tab moves to the next element; Delete removes it; Escape clears the selection.');
    [['light', L('Light'), LIGHT_LABEL[v.lighting], LIGHT_LABEL[v.lighting]], ['fabric', L('Fabric (simulated)'), FABRIC_SHORT[v.fabric], FABRIC_LABEL[v.fabric]],
      ['quality', L('Quality'), QUALITY_LABEL[v.quality], QUALITY_LABEL[v.quality]]].forEach(function (c) {
      var el = E.bar3d.querySelector('[data-pd-act="cycle-' + c[0] + '"]');
      if (!el) return;
      el.querySelector('.pd3-cycle-value').textContent = T(c[2]);
      var said = tf('%s: %s. Press to change.', T(c[1]), T(c[3]));
      el.setAttribute('aria-label', said);
      el.setAttribute('title', said);
    });
    var turn = S.host.querySelector('[data-pd-act="turntable"]');
    if (turn && turn.getAttribute('aria-disabled') !== 'true') turn.setAttribute('aria-pressed', S.mode === '3d' && v.turntable ? 'true' : 'false');
    var close = E.bar3d.querySelector('[data-pd-act="closeup"]'), n = selectedLayer();
    if (close) close.setAttribute('aria-disabled', n && isBox(n) ? 'false' : 'true');
    var cmp = E.bar3d.querySelector('[data-pd-act="compare3d"]');
    if (cmp) {
      var on = !!v.compare, label = on ? tf('Stop comparing with version %d', v.compare.number) : T('Compare with a saved version');
      cmp.setAttribute('aria-pressed', on ? 'true' : 'false');
      cmp.setAttribute('aria-disabled', S.srv.link || on ? 'false' : 'true');
      cmp.setAttribute('aria-label', label);
      cmp.setAttribute('title', label);
    }
    if (E.canvasNote) E.canvasNote.textContent = v.failed ? T(FAIL_3D[v.failed]) : S.mode !== '3d' && viewOf(S.view).context ? T('Sleeves show their colour and pattern here; artwork on a sleeve is edited in its side view.') : '';
  }

  // ── panels: drawers and sheets on smaller screens ─────────────────────────

  function setPanel(p) {
    S.panel = S.panel === p ? null : p;
    S.el.shell.setAttribute('data-panel', S.panel || '');
    var bs = S.host.querySelectorAll('[data-pd-panel]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-expanded', bs[i].getAttribute('data-pd-panel') === S.panel ? 'true' : 'false');
  }

  // ── building the room ─────────────────────────────────────────────────────

  function btn(attrs, kids) { var a = { type: 'button' }; for (var k in attrs) a[k] = attrs[k]; return h('button', a, kids); }
  /** A control this phase does not have yet: visible, unavailable, and able to say why. */
  function planned(el, reasonKey) {
    el.setAttribute('aria-disabled', 'true');
    el.setAttribute('data-pd-reason', reasonKey);
    var why = T(REASON[reasonKey]);
    el.setAttribute('title', why);
    return el;
  }
  function chip(text, kind) { return h('span', { class: 'pd-chip' + (kind ? ' pd-chip--' + kind : ''), text: text }); }

  function buildTop() {
    var langs = h('div', { class: 'pd-langs', role: 'group', 'aria-label': T('Language') });
    LOCALES.forEach(function (l) {
      langs.appendChild(btn({ class: 'pd-lang', 'data-pd-lang': l[0], lang: l[0], 'aria-pressed': l[0] === LANG ? 'true' : 'false', title: l[1], text: l[0].toUpperCase() }));
    });
    var nav = h('nav', { class: 'pd-ownernav', 'aria-label': T('Platform owner') });
    // The shared Platform Owner navigation: built and escaped by app.js for every owner room.
    if (typeof window.famOwnerNav === 'function') nav.innerHTML = window.famOwnerNav('product-design', T, 'pd-ownernav');
    return h('header', { class: 'pd-top', 'data-ds-region': 'R1' }, [
      h('div', { class: 'pd-brand' }, [
        h('img', { class: 'pd-brand-mark', src: '/familista-icon.svg', alt: '', width: '34', height: '34', decoding: 'async' }),
        h('span', { class: 'pd-brand-text' }, [h('strong', { text: 'Familista' }), h('span', { text: T('Design Studio') })]),
      ]),
      nav,
      h('div', { class: 'pd-top-end' }, [
        langs,
        h('span', { class: 'pd-owner' }, [h('span', { class: 'pd-owner-av', 'aria-hidden': 'true' }, [icon('crown', 14)]), h('span', { text: T('Platform Owner') })]),
      ]),
    ]);
  }

  var SIDE = [
    { page: 'owner-home', icon: 'home', label: L('Owner Control') },
    { page: 'neural-twin', icon: 'twin', label: L('Neural Digital Twin') },
    { page: 'agents-room', icon: 'agents', label: L('AI Agents Operations Room') },
    { page: 'clubs', icon: 'shield', label: L('Clubs') },
    { page: 'product-design', icon: 'shirt', label: L('Design Studio'), current: true },
    { reason: 'store', icon: 'store', label: L('Global Store') },
    { reason: 'orders', icon: 'box', label: L('Orders') },
    { reason: 'suppliers', icon: 'factory', label: L('Factories & suppliers') },
    { reason: 'payments', icon: 'card', label: L('Payments') },
  ];
  function buildSide() {
    var list = h('ul', { class: 'pd-side-list', role: 'list' });
    var plannedShown = false;
    SIDE.forEach(function (it) {
      if (it.reason && !plannedShown) { plannedShown = true; list.appendChild(h('li', { class: 'pd-side-group', text: T('Planned') })); }
      var b = it.current ? btn({ class: 'pd-side-btn is-current', 'aria-current': 'page' })
        : it.reason ? planned(btn({ class: 'pd-side-btn is-planned' }), it.reason)
        : btn({ class: 'pd-side-btn', 'data-action': 'navTo', 'data-page': it.page });
      append(b, [icon(it.icon, 18), h('span', { class: 'pd-side-label', text: T(it.label) })]);
      list.appendChild(h('li', null, [b]));
    });
    return h('nav', { class: 'pd-side', 'data-ds-region': 'R2', 'aria-label': T('Owner navigation') }, [list]);
  }

  function buildHead() {
    function ctx(key, ic, title, sub, active) {
      var b = btn({ class: 'pd-ctx' + (active ? ' is-active' : ''), 'aria-pressed': active ? 'true' : 'false' }, [
        h('span', { class: 'pd-ctx-ic' }, [icon(ic, 22)]),
        h('span', { class: 'pd-ctx-text' }, [h('strong', { text: T(title) }), h('span', { text: T(sub) })]),
      ]);
      if (!active) { planned(b, key); b.appendChild(chip(T('Planned'), 'muted')); }
      return b;
    }
    return h('section', { class: 'pd-head', 'data-ds-region': 'R3', 'aria-label': T('Design Studio') }, [
      h('div', { class: 'pd-title' }, [
        h('span', { class: 'pd-title-ic', 'aria-hidden': 'true' }, [icon('shirt', 30)]),
        h('div', null, [h('h1', { text: T('Design Studio') }), h('p', { text: T('Professional sportswear design, measured in millimetres') })]),
      ]),
      h('div', { class: 'pd-ctxs', role: 'group', 'aria-label': T('Design context') }, [
        ctx('context-club', 'shield', L('Club'), L('Club Design Studio'), false),
        ctx('context-creator', 'people', L('Individuals & public'), L('Creator Studio'), false),
        ctx('platform', 'crown', L('Platform'), L('Design Studio Control'), true),
      ]),
      h('div', { class: 'pd-ctxcard' }, [
        h('img', { class: 'pd-ctxcard-mark', src: '/familista-icon.svg', alt: '', width: '40', height: '40', decoding: 'async' }),
        h('span', { class: 'pd-ctxcard-text' }, [h('strong', { text: T('Familista Platform') }), h('span', { text: T('Platform drafts, in this browser') })]),
      ]),
    ]);
  }

  var CATALOGUE = [
    { id: 'match-kits', label: L('Match kits'), icon: 'shirt', items: [
      { id: 'match-shirt', label: L('Match shirt'), icon: 'shirt', live: true },
      { id: 'gk-shirt', label: L('Goalkeeper shirt'), icon: 'gkShirt' },
      { id: 'shorts', label: L('Shorts'), icon: 'shorts' },
      { id: 'socks', label: L('Socks'), icon: 'socks' },
      { id: 'training-top', label: L('Training top'), icon: 'gkShirt' },
      { id: 'jacket', label: L('Jacket'), icon: 'jacket' },
      { id: 'hoodie', label: L('Hoodie'), icon: 'hoodie' },
      { id: 't-shirt', label: L('T-shirt'), icon: 'shirt' },
      { id: 'polo', label: L('Polo shirt'), icon: 'polo' },
    ] },
    { id: 'everyday', label: L('Everyday wear'), icon: 'shirt', items: [
      { id: 'sweatshirt', label: L('Sweatshirt'), icon: 'hoodie' }, { id: 'casual-jacket', label: L('Casual jacket'), icon: 'jacket' },
    ] },
    { id: 'accessories', label: L('Accessories'), icon: 'cap', items: [
      { id: 'cap', label: L('Cap'), icon: 'cap' }, { id: 'bag', label: L('Bag'), icon: 'bag' }, { id: 'scarf', label: L('Scarf'), icon: 'scarf' }, { id: 'flag', label: L('Flag'), icon: 'flag' },
    ] },
  ];
  function buildLib() {
    var tabs = h('div', { class: 'pd-tabs', role: 'tablist', 'aria-label': T('Library') });
    [['products', L('Products')], ['templates', L('Templates')], ['elements', L('Elements')]].forEach(function (t) {
      var b = btn({ class: 'pd-tab', role: 'tab', 'data-pd-libtab': t[0], 'aria-selected': S.libTab === t[0] ? 'true' : 'false', text: T(t[1]) });
      if (t[0] === 'templates') planned(b, 'templates');
      tabs.appendChild(b);
    });
    var body = h('div', { class: 'pd-lib-body', role: 'tabpanel' });
    if (S.libTab === 'elements') {
      var grid = h('div', { class: 'pd-elements' });
      ELEMENTS.forEach(function (e) { grid.appendChild(btn({ class: 'pd-element', 'data-pd-add': e.kind }, [icon(e.icon, 20), h('span', { text: T(e.label) })])); });
      append(body, [h('p', { class: 'pd-note', text: T('Adds the element to the surface on screen.') }), grid]);
    } else {
      CATALOGUE.forEach(function (group) {
        var open = !!S.open[group.id];
        var head = btn({ class: 'pd-acc', 'data-pd-acc': group.id, 'aria-expanded': open ? 'true' : 'false' }, [
          icon(group.icon, 18), h('span', { class: 'pd-acc-label', text: T(group.label) }), h('span', { class: 'pd-acc-chev' }, [icon('chevron', 16)]),
        ]);
        var panel = h('div', { class: 'pd-acc-panel', hidden: !open });
        var cards = h('ul', { class: 'pd-cards', role: 'list' });
        group.items.forEach(function (it) {
          var b = btn({ class: 'pd-card' + (it.live ? ' is-current' : ''), 'aria-current': it.live ? 'true' : null }, [
            h('span', { class: 'pd-card-art' }, it.live ? [h('span', { class: 'pd-card-thumb', 'data-pd-thumb': 'front' })] : [icon(it.icon, 34)]),
            h('span', { class: 'pd-card-label', text: T(it.label) }),
          ]);
          if (!it.live) { planned(b, 'product'); b.appendChild(chip(T('Planned'), 'muted')); }
          cards.appendChild(h('li', null, [b]));
        });
        panel.appendChild(cards);
        append(body, [head, panel]);
      });
      body.appendChild(h('p', { class: 'pd-note', text: T('One template is available in this phase. The full catalogue arrives in DS-2.') }));
    }
    return h('section', { class: 'pd-lib', 'data-ds-region': 'R4', 'aria-label': T('Library') }, [
      h('div', { class: 'pd-sheet-head' }, [h('strong', { text: T('Library') }), btn({ class: 'pd-icbtn', 'data-pd-act': 'close-panel', 'aria-label': T('Close') }, [icon('close')])]),
      tabs, body,
    ]);
  }

  var PATTERN_LABEL = {
    diagonal: L('Diagonal stripes'), vertical: L('Vertical stripes'), hoops: L('Hoops'), pinstripe: L('Pinstripes'),
    gradient: L('Gradient'), chevron: L('Chevrons'), sash: L('Sash'), halftone: L('Halftone'),
  };
  var SHAPE_LABEL = { shield: L('Shield'), circle: L('Circle'), star: L('Star'), band: L('Band'), chevron: L('Chevron'), diamond: L('Diamond') };
  var FONT_LABEL = { 'sans-black': L('Sans, black'), 'sans-bold': L('Sans, bold'), 'mono-bold': L('Mono, bold') };

  function buildEditor() {
    var E = S.el;
    function tool(act, ic, label, key) {
      return btn({ class: 'pd-tool', 'data-pd-act': act, 'aria-label': T(label) + (key ? ' (' + key + ')' : ''), title: T(label) + (key ? ' (' + key + ')' : ''), 'aria-keyshortcuts': key || null }, [icon(ic, 20)]);
    }
    var image = tool('image', 'image', L('Image'));
    planned(image, 'image');
    var tools = h('div', { class: 'pd-tools', 'data-ds-region': 'R5', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': T('Tools') }, [
      tool('select', 'select', L('Select'), 'V'), tool('add-text', 'text', L('Text'), 'T'), image, tool('add-shape', 'shape', L('Shape'), 'S'),
      tool('patterns', 'pattern', L('Patterns'), 'P'), tool('layers', 'layers', L('Layers'), 'L'), tool('elements', 'components', L('Elements')),
    ]);
    tools.querySelector('[data-pd-act="select"]').setAttribute('aria-pressed', 'true');
    E.undo = btn({ class: 'pd-icbtn', 'data-pd-act': 'undo', 'aria-label': T('Undo'), title: T('Undo') + ' (Ctrl+Z)', 'aria-keyshortcuts': 'Control+Z' }, [icon('undo')]);
    E.redo = btn({ class: 'pd-icbtn', 'data-pd-act': 'redo', 'aria-label': T('Redo'), title: T('Redo') + ' (Ctrl+Shift+Z)', 'aria-keyshortcuts': 'Control+Shift+Z' }, [icon('redo')]);
    var capture = btn({ class: 'pd-icbtn', 'data-pd-act': 'capture', 'aria-label': T('Capture image') }, [icon('camera')]);
    planned(capture, 'capture');
    E.modes = h('div', { class: 'pd-seg', role: 'group', 'aria-label': T('View mode') }, [
      btn({ class: 'pd-seg-btn', 'data-pd-mode': '2d', 'aria-pressed': S.mode === '2d' ? 'true' : 'false', title: T('Flat panels, with the printable area and safe zone'), text: '2D' }),
      btn({ class: 'pd-seg-btn', 'data-pd-mode': '2.5d', 'aria-pressed': S.mode === '2.5d' ? 'true' : 'false', title: T('Shaded preview'), text: '2.5D' }),
      live3d(btn({ class: 'pd-seg-btn', 'data-pd-mode': '3d', 'aria-pressed': S.mode === '3d' ? 'true' : 'false', title: T('3D garment, a visual simulation'), text: '3D' }), '3d'),
    ]);
    E.zoom = h('span', { class: 'pd-zoom', 'aria-live': 'off' });
    var bar = h('div', { class: 'pd-bar', 'data-ds-region': 'R6', role: 'toolbar', 'aria-label': T('Canvas') }, [
      h('div', { class: 'pd-bar-group', role: 'group', 'aria-label': T('History') }, [E.undo, E.redo]),
      h('div', { class: 'pd-bar-group', role: 'group', 'aria-label': T('Guides') }, [
        btn({ class: 'pd-icbtn', 'data-pd-act': 'grid', 'aria-pressed': S.grid ? 'true' : 'false', 'aria-label': T('Grid'), title: T('Grid (10 mm)') }, [icon('grid')]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'guides', 'aria-pressed': S.guides ? 'true' : 'false', 'aria-label': T('Printable area and safe zone'), title: T('Printable area and safe zone') }, [icon('guides')]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'fit', 'aria-label': T('Fit to view'), title: T('Fit to view') + ' (0)' }, [icon('fit')]),
        capture,
      ]),
      E.modes,
      h('div', { class: 'pd-bar-group pd-bar-end' }, [E.zoom,
        btn({ class: 'pd-icbtn', 'data-pd-act': 'focus', 'aria-pressed': S.focus ? 'true' : 'false', 'aria-label': T('Focus on the canvas'), title: T('Focus on the canvas') }, [icon('expand')])]),
    ]);
    E.help = h('p', { class: 'pd-sr', id: 'pd-help', text: T('Design canvas. Click an element to select it, drag to move it, drag its handles to resize or rotate it; drag the empty canvas to pan, Control and the wheel to zoom. Arrow keys move the selection 1 mm, Shift and an arrow 10 mm; comma and full stop rotate it; Tab moves to the next element; Delete removes it; Escape clears the selection.') });
    E.canvas = h('div', { class: 'pd-canvas', 'data-ds-region': 'R7', tabindex: '0', role: 'application', 'aria-roledescription': T('design canvas'), 'aria-describedby': 'pd-help', dir: 'ltr' });
    E.canvasNote = h('p', { class: 'pd-canvas-note' });
    E.canvas.appendChild(E.canvasNote);
    chrome3d(E);
    var views = h('nav', { class: 'pd-views', 'data-ds-region': 'R8', 'aria-label': T('Views') });
    TEMPLATE.views.forEach(function (v) {
      views.appendChild(btn({ class: 'pd-view', 'data-pd-view': v.id, 'aria-pressed': v.id === S.view ? 'true' : 'false' }, [
        h('span', { class: 'pd-view-thumb', 'data-pd-thumb': v.id }), h('span', { class: 'pd-view-label', text: T(v.label) }),
      ]));
    });
    views.appendChild(live3d(btn({ class: 'pd-view pd-view--360', 'data-pd-act': 'turntable', 'aria-pressed': 'false', title: T('Turn the garment all the way round') }, [h('span', { class: 'pd-view-thumb' }, [icon('rotate', 26)]), h('span', { class: 'pd-view-label', text: '360°' })]), '360'));
    E.views = views;
    var strip = h('div', { class: 'pd-strip', role: 'list' });
    C.PATTERNS.forEach(function (p) {
      strip.appendChild(h('div', { role: 'listitem' }, [btn({ class: 'pd-swatch', 'data-pd-pattern': p, title: T(PATTERN_LABEL[p]), 'aria-label': T(PATTERN_LABEL[p]) }, [patternSwatch(p)])]));
    });
    E.strip = strip;
    var patterns = h('div', { class: 'pd-patterns', 'data-ds-region': 'R9', role: 'group', 'aria-label': T('Patterns') }, [
      btn({ class: 'pd-icbtn pd-strip-nav', 'data-pd-act': 'strip-prev', 'aria-label': T('Previous patterns') }, [dirArrow('‹')]),
      strip,
      btn({ class: 'pd-icbtn pd-strip-nav', 'data-pd-act': 'strip-next', 'aria-label': T('Next patterns') }, [dirArrow('›')]),
    ]);
    return h('div', { class: 'pd-editor' }, [bar, tools, h('div', { class: 'pd-stage' }, [E.canvas, views]), patterns, E.help]);
  }
  /** A small picture of a pattern, in the design's first two colours. */
  var SWATCH_N = 0;
  function patternSwatch(p) {
    var prefix = 'pdsw' + (++SWATCH_N);
    var svg = s('svg', { viewBox: '0 0 60 40', width: '60', height: '40', 'aria-hidden': 'true', focusable: 'false', class: 'pd-swatch-svg' });
    var defs = s('defs');
    svg.appendChild(defs);
    var base = S.doc.palette[0].id, top = S.doc.palette[Math.min(1, S.doc.palette.length - 1)].id;
    svg.appendChild(s('rect', { x: 0, y: 0, width: 60, height: 40, fill: colour(base) }));
    var n = { id: 'sw-' + p, type: 'pattern', visible: true, pattern: p, color: top, scale: p === 'halftone' ? 9 : p === 'pinstripe' ? 8 : 16, angle: p === 'diagonal' || p === 'sash' ? 35 : p === 'gradient' ? 90 : 0, opacity: 90 };
    svg.appendChild(layerNode(defs, prefix, n, { x: 0, y: 0, w: 60, h: 40 }));
    return svg;
  }

  // ── the inspector: layers, the selected element, colour, material, sizes ──

  function buildInsp() {
    var E = S.el;
    var tabs = h('div', { class: 'pd-tabs', role: 'tablist', 'aria-label': T('Inspector') });
    [['design', L('Design')], ['colour', L('Colour')], ['material', L('Material')], ['sizes', L('Sizes')]].forEach(function (t) {
      tabs.appendChild(btn({ class: 'pd-tab', role: 'tab', 'data-pd-insptab': t[0], 'aria-selected': S.inspTab === t[0] ? 'true' : 'false', text: T(t[1]) }));
    });
    E.inspBody = h('div', { class: 'pd-insp-body', role: 'tabpanel' });
    var sec = h('section', { class: 'pd-insp', 'data-ds-region': 'R10', 'aria-label': T('Inspector') }, [
      h('div', { class: 'pd-sheet-head' }, [h('strong', { text: T('Inspector') }), btn({ class: 'pd-icbtn', 'data-pd-act': 'close-panel', 'aria-label': T('Close') }, [icon('close')])]),
      tabs, E.inspBody,
    ]);
    fillInsp();
    return sec;
  }
  function fillInsp() {
    var E = S.el, body = E.inspBody;
    clear(body);
    E.layers = null; E.props = null;
    if (S.inspTab === 'design') {
      E.layers = h('ul', { class: 'pd-layers', role: 'list', 'aria-label': T('Layers') });
      E.props = h('div', { class: 'pd-props' });
      append(body, [h('h2', { class: 'pd-h2', text: T('Elements (layers)') }), E.layers, h('h2', { class: 'pd-h2', text: T('Element properties') }), E.props]);
      renderLayers();
      buildProps();
    } else if (S.inspTab === 'colour') body.appendChild(colourEditor());
    else if (S.inspTab === 'material') body.appendChild(materialPanel());
    else body.appendChild(sizesPanel(true));
  }

  function renderLayers() {
    var ul = S.el.layers;
    if (!ul) return;
    clear(ul);
    var surf = surfaceOfView();
    for (var i = surf.layers.length - 1; i >= 0; i--) {
      var n = surf.layers[i], on = S.sel && S.sel.kind === 'layer' && S.sel.id === n.id;
      var row = h('li', { class: 'pd-layer' + (on ? ' is-selected' : '') + (n.visible ? '' : ' is-hidden'), draggable: 'true', 'data-pd-row': n.id }, [
        h('span', { class: 'pd-layer-grip', 'aria-hidden': 'true' }, [icon('grip', 14)]),
        h('span', { class: 'pd-layer-thumb', 'aria-hidden': 'true' }, [layerThumb(n)]),
        btn({ class: 'pd-layer-name', 'data-pd-select': n.id, 'aria-pressed': on ? 'true' : 'false', 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' }, [h('span', { text: n.name, 'data-user-content': '' })]),
        btn({ class: 'pd-icbtn pd-layer-flag', 'data-pd-lock': n.id, 'aria-pressed': n.locked ? 'true' : 'false', 'aria-label': n.locked ? tf('Unlock %s', n.name) : tf('Lock %s', n.name) }, [icon(n.locked ? 'lock' : 'unlock', 15)]),
        btn({ class: 'pd-icbtn pd-layer-flag', 'data-pd-vis': n.id, 'aria-pressed': n.visible ? 'false' : 'true', 'aria-label': n.visible ? tf('Hide %s', n.name) : tf('Show %s', n.name) }, [icon(n.visible ? 'eye' : 'eyeOff', 15)]),
      ]);
      ul.appendChild(row);
    }
    var baseOn = S.sel && S.sel.kind === 'base';
    ul.appendChild(h('li', { class: 'pd-layer pd-layer--base' + (baseOn ? ' is-selected' : '') }, [
      h('span', { class: 'pd-layer-grip', 'aria-hidden': 'true' }),
      h('span', { class: 'pd-layer-thumb', 'aria-hidden': 'true' }, [colourDot(surf.base)]),
      btn({ class: 'pd-layer-name', 'data-pd-select': ':base', 'aria-pressed': baseOn ? 'true' : 'false' }, [h('span', { text: T('Shirt base colour') })]),
    ]));
  }
  function colourDot(id) {
    var svg = s('svg', { viewBox: '0 0 20 20', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(s('rect', { x: 1, y: 1, width: 18, height: 18, rx: 4, fill: colour(id), class: 'pd-dot' }));
    return svg;
  }
  function layerThumb(n) {
    if (n.type === 'pattern') return patternSwatch(n.pattern);
    if (n.type === 'shape') {
      var svg = s('svg', { viewBox: '-12 -12 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' });
      svg.appendChild(s('path', { d: shapePath(n.shape, 20, 20), fill: colour(n.color), stroke: n.outline ? colour(n.outline) : null, 'stroke-width': n.outline ? 1.5 : null }));
      return svg;
    }
    var t = s('svg', { viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' });
    var txt = s('text', { x: 12, y: 13, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': n.type === 'roster' && n.field === 'number' ? 14 : 16, 'font-weight': '900', fill: 'currentColor' });
    txt.textContent = n.type === 'roster' ? (n.field === 'number' ? '10' : 'Aa') : 'T';
    t.appendChild(txt);
    return t;
  }

  /** The properties of whatever is selected. Built when the selection changes; kept in step by syncProps. */
  function buildProps() {
    var box = S.el.props;
    if (!box) return;
    clear(box);
    var n = selectedLayer();
    if (S.sel && S.sel.kind === 'base') {
      var surf = surfaceOfView();
      append(box, [h('p', { class: 'pd-prop-title', text: tf('Base colour of the %s', T(tSurface(surf.id).label)) }), swatchPicker('base', surf.base, false)]);
      return;
    }
    if (!n) { box.appendChild(h('p', { class: 'pd-empty', text: T('Select an element on the shirt or in the list.') })); return; }
    var nameIn = h('input', { class: 'pd-input pd-prop-name', type: 'text', maxlength: String(LIMITS.name), 'data-pd-field': 'name', 'aria-label': T('Element name'), 'data-user-content': '' });
    nameIn.value = n.name;
    box.appendChild(h('div', { class: 'pd-prop-head' }, [
      nameIn,
      btn({ class: 'pd-icbtn', 'data-pd-act': 'duplicate', 'aria-label': T('Duplicate'), title: T('Duplicate') + ' (Ctrl+D)' }, [icon('duplicate')]),
      btn({ class: 'pd-icbtn', 'data-pd-act': 'delete', 'aria-label': T('Delete'), title: T('Delete') + ' (Delete)' }, [icon('trash')]),
    ]));
    if (n.locked) box.appendChild(h('p', { class: 'pd-note', text: T('This element is locked. Unlock it in the list to move or change it.') }));
    if (n.type === 'text') {
      var tIn = h('input', { class: 'pd-input', type: 'text', maxlength: String(LIMITS.text), 'data-pd-field': 'text', 'aria-label': T('Text'), 'data-user-content': '', dir: 'auto' });
      tIn.value = n.text;
      box.appendChild(row(T('Text'), tIn));
    }
    if (n.type === 'roster') box.appendChild(h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: n.field === 'number'
      ? T('Number placeholder. Real numbers come from a team roster (planned, DS-3); the design keeps no player data.')
      : T('Name placeholder. Real names come from a team roster (planned, DS-3); the design keeps no player data.') })]));
    if (n.type === 'shape') box.appendChild(row(T('Shape'), selectField('shape', C.SHAPES, SHAPE_LABEL, n.shape)));
    if (n.type === 'text' || n.type === 'roster') box.appendChild(row(T('Font'), selectField('font', C.FONTS, FONT_LABEL, n.font)));
    if (n.type === 'pattern') {
      box.appendChild(row(T('Pattern'), selectField('pattern', C.PATTERNS, PATTERN_LABEL, n.pattern)));
      box.appendChild(sliderRow('scale', T('Repeat'), LIMITS.scaleMin, LIMITS.scaleMax, 1, 'mm'));
      box.appendChild(sliderRow('angle', T('Angle'), -179, 180, 1, '°'));
      box.appendChild(sliderRow('opacity', T('Opacity'), 5, 100, 1, '%'));
    }
    box.appendChild(h('p', { class: 'pd-prop-sub', text: T('Colour') }));
    box.appendChild(swatchPicker('color', n.color, false));
    if (n.type !== 'pattern') {
      box.appendChild(h('p', { class: 'pd-prop-sub', text: T('Outline') }));
      box.appendChild(swatchPicker('outline', n.outline, true));
      box.appendChild(h('div', { class: 'pd-prop-tools', role: 'group', 'aria-label': T('Alignment') }, [
        btn({ class: 'pd-icbtn', 'data-pd-act': 'align-h', 'aria-label': T('Centre on the surface, left to right'), title: T('Centre on the surface, left to right') }, [icon('alignH')]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'align-v', 'aria-label': T('Centre in the safe zone, top to bottom'), title: T('Centre in the safe zone, top to bottom') }, [icon('alignV')]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'reset-box', 'aria-label': T('Original size, no rotation'), title: T('Original size, no rotation') }, [icon('reset')]),
      ]));
      box.appendChild(sliderRow('scale%', T('Scale'), 10, 400, 1, '%'));
      box.appendChild(sliderRow('r', T('Rotation'), -179, 180, 1, '°'));
      box.appendChild(h('div', { class: 'pd-pair' }, [numberField('x', 'X', 'mm'), numberField('y', 'Y', 'mm')]));
      box.appendChild(h('div', { class: 'pd-pair' }, [numberField('w', T('Width'), 'mm'), numberField('h', T('Height'), 'mm')]));
    }
    box.appendChild(h('div', { class: 'pd-prop-tools', role: 'group', 'aria-label': T('Order') }, [
      btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'forward' }, [icon('up', 14), h('span', { text: T('Bring forward') })]),
      btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'backward' }, [icon('down', 14), h('span', { text: T('Send backward') })]),
    ]));
    syncProps();
  }
  function row(label, control) { return h('label', { class: 'pd-row' }, [h('span', { class: 'pd-row-label', text: label }), control]); }
  function selectField(field, values, labels, current) {
    var sel = h('select', { class: 'pd-input', 'data-pd-field': field });
    values.forEach(function (v) { var o = h('option', { value: v, text: T(labels[v]) }); if (v === current) o.selected = true; sel.appendChild(o); });
    return sel;
  }
  function sliderRow(field, label, min, max, step, unit) {
    var range = h('input', { class: 'pd-range', type: 'range', min: String(min), max: String(max), step: String(step), 'data-pd-field': field, 'aria-label': label });
    var box = h('input', { class: 'pd-input pd-input--num', type: 'number', min: String(min), max: String(max), step: String(step), 'data-pd-field': field, 'aria-label': label + ' (' + unit + ')' });
    return h('div', { class: 'pd-slider' }, [h('span', { class: 'pd-row-label', text: label }), range, h('span', { class: 'pd-num' }, [box, h('span', { class: 'pd-unit', text: unit })])]);
  }
  function numberField(field, label, unit) {
    var input = h('input', { class: 'pd-input pd-input--num', type: 'number', step: '0.1', 'data-pd-field': field, 'aria-label': label + ' (' + unit + ')' });
    return h('label', { class: 'pd-numfield' }, [h('span', { class: 'pd-row-label', text: label }), input, h('span', { class: 'pd-unit', text: unit })]);
  }
  function swatchPicker(field, current, allowNone) {
    var wrap = h('div', { class: 'pd-swatches', role: 'group', 'data-pd-for': field });
    if (allowNone) wrap.appendChild(btn({ class: 'pd-sw pd-sw--none', 'data-pd-colour': ':none', 'data-pd-field': field, 'aria-pressed': current === null ? 'true' : 'false', 'aria-label': T('No outline'), title: T('No outline') }));
    S.doc.palette.forEach(function (c) {
      var b = btn({ class: 'pd-sw', 'data-pd-colour': c.id, 'data-pd-field': field, 'aria-pressed': c.id === current ? 'true' : 'false', 'aria-label': c.label, title: c.label + ' ' + c.srgb }, [colourDot(c.id)]);
      wrap.appendChild(b);
    });
    return wrap;
  }
  /** Put the selection's current values into the inspector, leaving alone the field the reader is typing in. */
  function syncProps() {
    var box = S.el.props, n = selectedLayer();
    if (!box || !n) return;
    var active = document.activeElement;
    var fields = box.querySelectorAll('[data-pd-field]');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], key = f.getAttribute('data-pd-field');
      if (f === active) continue;
      var v = key === 'scale%' ? C.scaleOf(n) : n[key];
      if (f.tagName === 'BUTTON') continue;
      if (v === undefined) continue;
      f.value = v == null ? '' : String(v);
      if (key !== 'name') { if (n.locked) f.setAttribute('disabled', ''); else f.removeAttribute('disabled'); }
    }
    var pickers = box.querySelectorAll('.pd-sw');
    for (var j = 0; j < pickers.length; j++) {
      var p = pickers[j], fk = p.getAttribute('data-pd-field'), id = p.getAttribute('data-pd-colour');
      var cur = fk === 'base' ? surfaceOfView().base : n[fk];
      p.setAttribute('aria-pressed', (id === ':none' ? cur === null : id === cur) ? 'true' : 'false');
    }
  }

  function colourEditor() {
    var wrap = h('div', { class: 'pd-colours' });
    var list = h('ul', { class: 'pd-palette', role: 'list' });
    S.doc.palette.forEach(function (c) {
      var pick = h('input', { class: 'pd-colorpick', type: 'color', 'data-pd-swatch': c.id, 'aria-label': tf('Colour of %s', c.label) });
      pick.value = c.srgb;
      var label = h('input', { class: 'pd-input', type: 'text', maxlength: String(LIMITS.label), 'data-pd-swatch-label': c.id, 'aria-label': T('Colour name'), 'data-user-content': '' });
      label.value = c.label;
      var used = C.swatchInUse(S.doc, c.id);
      var rm = btn({ class: 'pd-icbtn', 'data-pd-swatch-remove': c.id, 'aria-label': tf('Remove %s', c.label), title: used ? T('This colour is in use. Change what uses it first.') : tf('Remove %s', c.label) }, [icon('trash', 15)]);
      if (used || S.doc.palette.length <= 1) { rm.setAttribute('aria-disabled', 'true'); rm.setAttribute('data-pd-why', used ? T('This colour is in use. Change what uses it first.') : T('A design keeps at least one colour.')); }
      list.appendChild(h('li', { class: 'pd-palette-row' }, [pick, label, h('code', { class: 'pd-hex', text: c.srgb }), rm]));
    });
    var add = btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'add-colour' }, [icon('plus', 14), h('span', { text: T('Add colour') })]);
    if (S.doc.palette.length >= LIMITS.palette) { add.setAttribute('aria-disabled', 'true'); add.setAttribute('data-pd-why', tf('A design holds at most %d colours.', LIMITS.palette)); }
    append(wrap, [
      h('h2', { class: 'pd-h2', text: T('Design palette') }), list, add,
      h('h2', { class: 'pd-h2', text: T('Trims') }),
      h('p', { class: 'pd-prop-sub', text: T('Collar') }), partPicker('collar'),
      h('p', { class: 'pd-prop-sub', text: T('Cuffs') }), partPicker('cuffs'),
      h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: T('Colours on screen are sRGB previews. The printed colour depends on the fabric and the process; physical samples settle it.') })]),
    ]);
    return wrap;
  }
  function partPicker(part) {
    var wrap = h('div', { class: 'pd-swatches', role: 'group', 'aria-label': T(part === 'collar' ? 'Collar' : 'Cuffs') });
    S.doc.palette.forEach(function (c) {
      wrap.appendChild(btn({ class: 'pd-sw', 'data-pd-part': part, 'data-pd-colour': c.id, 'aria-pressed': S.doc.parts[part] === c.id ? 'true' : 'false', 'aria-label': c.label, title: c.label }, [colourDot(c.id)]));
    });
    return wrap;
  }

  function materialPanel() {
    var wrap = h('div', { class: 'pd-material' });
    append(wrap, [
      h('h2', { class: 'pd-h2', text: T('Production information') }),
      productionInfo(),
      h('h2', { class: 'pd-h2', text: T('Design check') }),
      checkList(),
    ]);
    return wrap;
  }
  function productionInfo(compact) {
    function ro(label, value, reason) {
      var sel = h('select', { class: 'pd-input', 'aria-label': label });
      sel.appendChild(h('option', { text: value }));
      planned(sel, reason);
      sel.setAttribute('disabled', '');
      return h('label', { class: 'pd-row' }, [h('span', { class: 'pd-row-label', text: label }), sel]);
    }
    var ref = TEMPLATE.reference;
    var out = h('div', { class: 'pd-prodinfo' }, [
      ro(T('Production method'), T(ref.method), 'method'),
      ro(T('Fabric'), T(ref.fabric), 'fabric'),
    ]);
    S.el.checkLine = h('p', { class: 'pd-checkline' });
    out.appendChild(S.el.checkLine);
    out.appendChild(h('p', { class: 'pd-note', text: compact ? T('Reference values: no supplier connected') : T('Checked against the template’s own rules. No supplier is connected, so nothing here says a design can be manufactured.') }));
    return out;
  }
  function checkList() {
    S.el.checkList = h('ul', { class: 'pd-findings', role: 'list' });
    return S.el.checkList;
  }
  function findingText(f) {
    var l = C.findLayer(S.doc, f.layer), name = l ? l.layer.name : '', where = T(tSurface(f.surface).label);
    if (f.code === 'outside-print-area') return tf('%s is outside the printable area of the %s.', name, where);
    if (f.code === 'crosses-safe-zone') return tf('%s crosses the safe zone of the %s: seams, collar or cuffs may cut it.', name, where);
    return tf('%s is lower than the template’s %d mm minimum for lettering.', name, TEMPLATE.rules.minTextHeight);
  }
  function renderCheck() {
    S.findings = C.checkDesign(S.doc, TEMPLATE);
    var blockers = S.findings.filter(function (f) { return f.severity === 'blocker'; }).length, warnings = S.findings.length - blockers;
    var lines = S.host.querySelectorAll('.pd-checkline');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      clear(line);
      line.setAttribute('data-state', blockers ? 'blocker' : warnings ? 'warning' : 'ok');
      append(line, [icon(blockers || warnings ? 'alert' : 'check', 16), h('span', { text: blockers || warnings
        ? tf('Design check: %d outside the printable area, %d to review', blockers, warnings)
        : T('Design check: every element is inside the safe zones') })]);
    }
    var list = S.el.checkList;
    if (!list) return;
    clear(list);
    if (!S.findings.length) { list.appendChild(h('li', { class: 'pd-empty', text: T('Nothing to report against the template’s rules.') })); return; }
    S.findings.forEach(function (f) {
      list.appendChild(h('li', { class: 'pd-finding', 'data-severity': f.severity }, [
        icon('alert', 15), h('span', { text: findingText(f) }),
        btn({ class: 'pd-link', 'data-pd-goto': f.layer, 'data-pd-goto-view': f.surface }, [h('span', { text: T('Show') })]),
      ]));
    });
  }

  function sizesPanel(full) {
    var fits = TEMPLATE.reference.fits, order = ['women', 'youth', 'men', 'kids'];
    var tabs = h('div', { class: 'pd-fits', role: 'group', 'aria-label': T('Fit') });
    order.forEach(function (id) {
      var f = fits.filter(function (x) { return x.id === id; })[0];
      if (f) tabs.appendChild(btn({ class: 'pd-fit', 'data-pd-fit': id, 'aria-pressed': S.fit === id ? 'true' : 'false', text: T(f.label) }));
    });
    var fit = fits.filter(function (x) { return x.id === S.fit; })[0] || fits[0];
    var sizes = h('ul', { class: 'pd-sizes', role: 'list', 'aria-label': T('Reference sizes') });
    fit.sizes.forEach(function (z) {
      var ref = fit.id === 'men' && z === TEMPLATE.referenceSize;
      sizes.appendChild(h('li', { class: 'pd-size' + (ref ? ' is-ref' : ''), title: ref ? T('The design’s reference size') : null, text: z }));
    });
    var out = h('div', { class: 'pd-sizes-panel' }, [tabs, sizes, h('p', { class: 'pd-note', text: full ? T('Reference sizes, not purchasable. Sizes and measurements come from a supplier’s product data (DS-5).') : T('Reference sizes, not purchasable') })]);
    if (full) out.appendChild(h('p', { class: 'pd-note', text: tf('The design is placed on size %s. Grading to other sizes arrives with the catalogue (DS-2).', TEMPLATE.referenceSize) }));
    return out;
  }

  // ── the product column ────────────────────────────────────────────────────

  function buildProduct() {
    var E = S.el;
    E.prodPalette = h('div', { class: 'pd-prod-palette' });
    E.prodSizes = h('div');
    var sec = h('section', { class: 'pd-prod', 'data-ds-region': 'R11', 'aria-label': T('Product') }, [
      h('div', { class: 'pd-sheet-head' }, [h('strong', { text: T('Product') }), btn({ class: 'pd-icbtn', 'data-pd-act': 'close-panel', 'aria-label': T('Close') }, [icon('close')])]),
      h('div', { class: 'pd-card-panel' }, [
        h('h2', { class: 'pd-h2' }, [icon('shirt', 16), h('span', { text: T('Kit preview') })]),
        h('div', { class: 'pd-kit' }, [
          h('figure', { class: 'pd-kit-item pd-kit-item--planned' }, [h('span', { class: 'pd-kit-art' }, [icon('shirt', 40)]), h('figcaption', { text: T('Away kit') }), chip(T('Planned'), 'muted')]),
          h('figure', { class: 'pd-kit-item is-current' }, [h('span', { class: 'pd-kit-art', 'data-pd-thumb': 'front' }), h('figcaption', { class: 'pd-kit-name', 'data-user-content': '', 'data-pd-docname': '' })]),
          h('figure', { class: 'pd-kit-item pd-kit-item--planned' }, [h('span', { class: 'pd-kit-art' }, [icon('gkShirt', 40)]), h('figcaption', { text: T('Goalkeeper kit') }), chip(T('Planned'), 'muted')]),
        ]),
      ]),
      h('div', { class: 'pd-card-panel' }, [h('h2', { class: 'pd-h2' }, [icon('ruler', 16), h('span', { text: T('Available sizes') })]), E.prodSizes]),
      h('div', { class: 'pd-card-panel' }, [h('h2', { class: 'pd-h2' }, [icon('pattern', 16), h('span', { text: T('Colours') })]), E.prodPalette]),
      h('div', { class: 'pd-card-panel' }, [h('h2', { class: 'pd-h2' }, [icon('layers', 16), h('span', { text: T('Production information') })]), productionInfo(true)]),
    ]);
    renderProduct();
    return sec;
  }
  function renderProduct() {
    var E = S.el;
    if (E.prodSizes) { clear(E.prodSizes); E.prodSizes.appendChild(sizesPanel(false)); }
    if (E.prodPalette) {
      clear(E.prodPalette);
      var n = selectedLayer(), field = S.sel && S.sel.kind === 'base' ? 'base' : n ? 'color' : null;
      var wrap = h('div', { class: 'pd-swatches pd-swatches--lg', role: 'group', 'aria-label': T('Design palette') });
      S.doc.palette.forEach(function (c) {
        wrap.appendChild(btn({ class: 'pd-sw pd-sw--lg', 'data-pd-colour': c.id, 'data-pd-field': field || ':palette', 'aria-label': field ? tf('Apply %s', c.label) : c.label, title: c.label + ' ' + c.srgb }, [colourDot(c.id)]));
      });
      var add = btn({ class: 'pd-sw pd-sw--add', 'data-pd-act': 'add-colour', 'aria-label': T('Add colour'), title: T('Add colour') }, [icon('plus', 16)]);
      if (S.doc.palette.length >= LIMITS.palette) { add.setAttribute('aria-disabled', 'true'); add.setAttribute('data-pd-why', tf('A design holds at most %d colours.', LIMITS.palette)); }
      wrap.appendChild(add);
      E.prodPalette.appendChild(wrap);
      E.prodPalette.appendChild(h('p', { class: 'pd-note', text: field ? T('Pick a colour to apply it to the selection.') : T('Select an element, then pick a colour.') }));
    }
    if (S.inspTab === 'colour' && E.inspBody && !E.inspBody.contains(document.activeElement)) fillInsp();
    var parts = S.host.querySelectorAll('[data-pd-part]');
    for (var i = 0; i < parts.length; i++) parts[i].setAttribute('aria-pressed', S.doc.parts[parts[i].getAttribute('data-pd-part')] === parts[i].getAttribute('data-pd-colour') ? 'true' : 'false');
  }

  // ── the action bar and the workflow, integration and supplier panels ──────

  function buildActions() {
    var E = S.el;
    E.docName = h('input', { class: 'pd-docname', type: 'text', maxlength: String(LIMITS.name), 'aria-label': T('Design name'), 'data-user-content': '' });
    E.docName.value = S.doc.name;
    E.saveState = h('span', { class: 'pd-savestate', role: 'status' });
    E.file = h('input', { class: 'pd-sr', type: 'file', accept: '.json,application/json', tabindex: '-1', 'aria-hidden': 'true' });
    var projects = btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'projects', 'data-pd-dock': 'projects', 'aria-controls': 'pd-dock', 'aria-expanded': 'false' }, [icon('folder', 16), h('span', { text: T('Projects') })]);
    var versions = btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'versions', 'data-pd-dock': 'versions', 'aria-controls': 'pd-dock', 'aria-expanded': 'false' }, [icon('versions', 16), h('span', { text: T('Versions') })]);
    var proof = planned(btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'proof' }, [icon('eye', 16), h('span', { text: T('Production preview') })]), 'proof');
    var order = planned(btn({ class: 'pd-btn pd-btn--order', 'data-pd-act': 'order' }, [icon('cart', 18), h('span', { text: T('Continue to order') })]), 'order');
    var bar = h('footer', { class: 'pd-actions', 'data-ds-region': 'R12' }, [
      h('div', { class: 'pd-actions-start' }, [
        btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'save', 'aria-keyshortcuts': 'Control+S' }, [icon('save', 16), h('span', { text: T('Save design') })]),
        projects,
        versions,
        h('div', { class: 'pd-file', role: 'group', 'aria-label': T('File') }, [
          btn({ class: 'pd-icbtn', 'data-pd-act': 'import', 'aria-label': T('Import a design file'), title: T('Import a design file') }, [icon('import')]),
          btn({ class: 'pd-icbtn', 'data-pd-act': 'export', 'aria-label': T('Export the design file'), title: T('Export the design file') }, [icon('export')]),
          E.file,
        ]),
      ]),
      h('div', { class: 'pd-actions-mid' }, [
        h('div', { class: 'pd-namefield' }, [h('span', { class: 'pd-namefield-ic', 'aria-hidden': 'true' }, [icon('pencil', 14)]), E.docName, E.saveState]),
        (E.localLine = h('p', { class: 'pd-local' }, [icon('info', 14), (E.local = h('span', { text: T('Saved on the Familista server · draft kept in this browser') }))])),
      ]),
      h('div', { class: 'pd-cost' }, [
        h('span', { class: 'pd-cost-label', text: T('Estimated cost') }),
        h('strong', { class: 'pd-cost-value', text: '—' }),
        h('span', { class: 'pd-cost-sub', text: T('No quotation: no supplier connected') }),
      ]),
      h('div', { class: 'pd-actions-end' }, [proof, order]),
    ]);
    return bar;
  }

  var FLOW = [
    { icon: 'shirt', label: L('Product design'), state: 'available' },
    { icon: 'ruler', label: L('Sizes & quantity'), state: 'planned' },
    { icon: 'calc', label: L('Price'), state: 'planned' },
    { icon: 'card', label: L('Secure payment'), state: 'planned' },
    { icon: 'factory', label: L('Send to factory'), state: 'not-connected' },
    { icon: 'gear', label: L('Manufacturing'), state: 'not-connected' },
    { icon: 'truck', label: L('Shipping & tracking'), state: 'planned' },
    { icon: 'delivered', label: L('Delivery'), state: 'planned' },
  ];
  var STATE_LABEL = { available: L('Available'), planned: L('Planned'), 'not-connected': L('Not connected') };
  var INTEGRATION = [
    { ok: true, label: L('Part of Owner Control, in the Platform Owner navigation') },
    { ok: true, label: L('Holds no club or personal data: platform designs only') },
    { ok: false, label: L('Supervised by AI agents'), state: L('Planned, DS-8') },
    { ok: true, label: L('Visible in the Neural Digital Twin') },
  ];
  var SUPPLIERS = [
    { name: 'Printful', state: L('Under evaluation') },
    { name: 'Printify', state: L('Under evaluation') },
    { name: 'Gelato', state: L('Under evaluation') },
    { label: L('Specialised sportswear factories'), state: L('Not researched') },
  ];
  function buildFoot() {
    // A pipeline advancing: it reads left to right in every language, and its arrows keep their direction.
    var steps = h('ol', { class: 'pd-flow-steps', dir: 'ltr' });
    FLOW.forEach(function (f, i) {
      if (i) steps.appendChild(h('li', { class: 'pd-flow-arrow', 'aria-hidden': 'true', text: '→' }));
      steps.appendChild(h('li', { class: 'pd-flow-step', 'data-state': f.state }, [
        h('span', { class: 'pd-flow-ic' }, [icon(f.icon, 22)]),
        h('span', { class: 'pd-flow-label', dir: 'auto', text: T(f.label) }),
        h('span', { class: 'pd-flow-state', dir: 'auto', text: T(STATE_LABEL[f.state]) }),
      ]));
    });
    var integ = h('ul', { class: 'pd-integ-list', role: 'list' });
    INTEGRATION.forEach(function (it) {
      integ.appendChild(h('li', { class: 'pd-integ', 'data-ok': it.ok ? 'true' : 'false' }, [
        h('span', { class: 'pd-integ-ic' }, [icon(it.ok ? 'check' : 'info', 15)]),
        h('span', null, [T(it.label), it.state ? ' ' : null, it.state ? chip(T(it.state), 'muted') : null]),
      ]));
    });
    var sup = h('ul', { class: 'pd-sup-list', role: 'list' });
    SUPPLIERS.forEach(function (x) {
      sup.appendChild(h('li', { class: 'pd-sup' }, [
        h('span', { class: 'pd-sup-name', text: x.name || T(x.label) }),
        chip(T(x.state), 'muted'),
      ]));
    });
    // Focusable and named: on a narrower screen it scrolls sideways, and a keyboard must be able to scroll it too.
    return h('div', { class: 'pd-foot', tabindex: '0', role: 'region', 'aria-label': T('Workflow, integration and suppliers') }, [
      h('section', { class: 'pd-foot-card pd-flow', 'data-ds-region': 'R13', 'aria-label': T('Workflow: from design to delivery') }, [
        h('h2', { class: 'pd-h2', text: T('Workflow: from design to delivery') }), steps,
      ]),
      h('section', { class: 'pd-foot-card pd-integ-card', 'data-ds-region': 'R14', 'aria-label': T('Familista integration') }, [
        h('h2', { class: 'pd-h2' }, [icon('link', 16), h('span', { text: T('Familista integration') })]), integ,
      ]),
      h('section', { class: 'pd-foot-card pd-sup-card', 'data-ds-region': 'R15', 'aria-label': T('Factories and suppliers (example)') }, [
        h('h2', { class: 'pd-h2' }, [icon('factory', 16), h('span', { text: T('Factories and suppliers (example)') })]), sup,
        h('p', { class: 'pd-note', text: T('Names only. No supplier is connected and none is shown as connected until it is.'), title: T('Names only. No supplier is connected and none is shown as connected until it is.') }),
      ]),
    ]);
  }

  function buildTabbar() {
    return h('nav', { class: 'pd-tabbar', 'aria-label': T('Panels') }, [
      btn({ class: 'pd-tabbar-btn', 'data-pd-panel': 'library', 'aria-expanded': 'false' }, [icon('components', 18), h('span', { text: T('Library') })]),
      btn({ class: 'pd-tabbar-btn', 'data-pd-panel': 'inspector', 'aria-expanded': 'false' }, [icon('layers', 18), h('span', { text: T('Layers') })]),
      btn({ class: 'pd-tabbar-btn', 'data-pd-panel': 'product', 'aria-expanded': 'false' }, [icon('ruler', 18), h('span', { text: T('Product') })]),
    ]);
  }

  function build() {
    var host = S.host, E = S.el;
    close3d();
    unbind();
    FAMILY = {};
    INK = null;
    clear(host);
    host.setAttribute('lang', LANG);
    host.setAttribute('dir', DIR);
    E.live = h('div', { class: 'pd-sr', role: 'status', 'aria-live': 'polite' });
    E.lib = buildLib();
    var editor = buildEditor();
    E.insp = buildInsp();
    E.prod = buildProduct();
    E.shell = h('div', { class: 'pd-shell', 'data-panel': S.panel || '', 'data-focus': S.focus ? 'true' : 'false' }, [
      buildTop(), buildSide(),
      h('main', { class: 'pd-main' }, [buildHead(), h('div', { class: 'pd-work' }, [E.lib, editor, E.insp, E.prod]), buildActions()]),
      buildFoot(), buildTabbar(),
      h('div', { class: 'pd-scrim', 'data-pd-act': 'close-panel', 'aria-hidden': 'true' }),
      (E.dock = h('section', { class: 'pd-dock', id: 'pd-dock', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pd-dock-title', 'data-open': S.srv.open ? 'true' : 'false' })),
      E.live,
    ]);
    host.appendChild(E.shell);
    bind();
    S.el.svg = null;
    renderCanvas();
    renderCheck();
    syncHistory();
    syncName();
    syncViews();
    setSaveState(S.saveState);
    syncServerState();
    renderDock();
    syncDockTriggers();
    renderThumbs();
    sync3d();
    if (S.mode === '3d') { if (can3d()) open3d(); else { S.mode = '2.5d'; syncModes(); renderCanvas(); } }
    var mine = S;
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S === mine) { FAMILY = {}; renderCanvas(); scheduleThumbs(); if (S.v3.ctl) S.v3.ctl.invalidate(); } });
  }
  function syncName() {
    if (S.el.docName && S.el.docName !== document.activeElement) S.el.docName.value = S.doc.name;
    var names = S.host.querySelectorAll('[data-pd-docname]');
    for (var i = 0; i < names.length; i++) names[i].textContent = S.doc.name;
  }
  function syncViews() {
    var bs = S.host.querySelectorAll('[data-pd-view]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', bs[i].getAttribute('data-pd-view') === S.view ? 'true' : 'false');
    sync3d();
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind() {
    var host = S.host, E = S.el;
    listen(host, 'click', onClick);
    listen(host, 'input', onInput);
    listen(host, 'change', onChange);
    listen(host, 'keydown', onRowKey);
    listen(host, 'dragstart', onDragStart);
    listen(host, 'dragover', onDragOver);
    listen(host, 'drop', onDrop);
    listen(E.canvas, 'pointerdown', onPointerDown);
    listen(E.canvas, 'pointermove', onPointerMove);
    listen(E.canvas, 'pointerup', onPointerUp);
    listen(E.canvas, 'pointercancel', onPointerUp);
    listen(E.canvas, 'wheel', onWheel, { passive: false });
    listen(document, 'keydown', onKeyDown);
    listen(document, 'keyup', onKeyUp);
    listen(E.file, 'change', onFile);
    if (typeof window.ResizeObserver === 'function') {
      S.resize = new window.ResizeObserver(function (entries) {
        if (!S) return;
        var r = entries && entries[0] && entries[0].contentRect;
        if (r) S.size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
        if (S.autoFit) fitView();
        applyCamera();
      });
      S.resize.observe(E.canvas);
    }
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('button, [data-pd-act]') : null;
    if (!t || !S.host.contains(t)) return;
    if (t.getAttribute('aria-disabled') === 'true') {
      ev.preventDefault();
      var r = t.getAttribute('data-pd-reason'), act = t.getAttribute('data-pd-act');
      if (r) say(T(REASON[r]));
      else if (act === 'undo' || act === 'redo') undoRedo(act);
      else say(t.getAttribute('data-pd-why') || T('Not available.'));
      return;
    }
    var a;
    if ((a = t.getAttribute('data-pd-docktab'))) { if (S.srv.tab !== a) { S.srv.tab = a; S.srv.confirm = null; syncDockTriggers(); renderDock(); loadDockTab(); } var tb = S.el.dock.querySelector('[data-pd-docktab="' + a + '"]'); if (tb) tb.focus(); return; }
    if ((a = t.getAttribute('data-pd-filter'))) { if (S.srv.filter !== a) { S.srv.filter = a; loadProjects(); } return; }
    if ((a = t.getAttribute('data-pd-act')) && onDockAction(a, t)) return;
    if ((a = t.getAttribute('data-pd-lang'))) { chooseSetLocale(a).then(function () { if (S) build(); }); return; }
    if ((a = t.getAttribute('data-pd-view'))) { setView(a); return; }
    if ((a = t.getAttribute('data-pd-mode'))) { setMode(a); return; }
    if ((a = t.getAttribute('data-pd-libtab'))) { S.libTab = a; var lib = buildLib(); S.el.lib.parentNode.replaceChild(lib, S.el.lib); S.el.lib = lib; renderThumbs(); lib.querySelector('[data-pd-libtab="' + a + '"]').focus(); return; }
    if ((a = t.getAttribute('data-pd-insptab'))) { S.inspTab = a; var tabs = S.el.insp.querySelectorAll('[data-pd-insptab]'); for (var j = 0; j < tabs.length; j++) tabs[j].setAttribute('aria-selected', tabs[j].getAttribute('data-pd-insptab') === a ? 'true' : 'false'); fillInsp(); renderCheck(); return; }
    if ((a = t.getAttribute('data-pd-acc'))) { S.open[a] = !S.open[a]; t.setAttribute('aria-expanded', S.open[a] ? 'true' : 'false'); var p = t.nextSibling; if (p) { if (S.open[a]) p.removeAttribute('hidden'); else p.setAttribute('hidden', ''); } return; }
    if ((a = t.getAttribute('data-pd-add'))) { addElement(a); return; }
    if ((a = t.getAttribute('data-pd-pattern'))) { addPattern(a); return; }
    if ((a = t.getAttribute('data-pd-fit'))) { S.fit = a; renderProduct(); if (S.inspTab === 'sizes') fillInsp(); return; }
    if ((a = t.getAttribute('data-pd-panel'))) { setPanel(a); return; }
    if ((a = t.getAttribute('data-pd-select'))) { select(a === ':base' ? { kind: 'base' } : { kind: 'layer', id: a }, true); return; }
    if ((a = t.getAttribute('data-pd-vis'))) { var f = C.findLayer(S.doc, a); if (f) { setLayer(a, 'visible', !f.layer.visible, f.layer.visible ? T('Hide') : T('Show')); say(f.layer.visible ? tf('%s shown.', f.layer.name) : tf('%s hidden: it is not printed.', f.layer.name)); } return; }
    if ((a = t.getAttribute('data-pd-lock'))) { var g = C.findLayer(S.doc, a); if (g) { setLayer(a, 'locked', !g.layer.locked, g.layer.locked ? T('Unlock') : T('Lock')); buildProps(); say(g.layer.locked ? tf('%s locked.', g.layer.name) : tf('%s unlocked.', g.layer.name)); } return; }
    if ((a = t.getAttribute('data-pd-goto'))) { setView(t.getAttribute('data-pd-goto-view')); select({ kind: 'layer', id: a }, true); S.el.canvas.focus({ preventScroll: true }); return; }
    if ((a = t.getAttribute('data-pd-part'))) { commitOp({ op: 'set', target: { kind: 'part', id: a }, key: 'color', value: t.getAttribute('data-pd-colour') }, a === 'collar' ? T('Collar') : T('Cuffs')); return; }
    if ((a = t.getAttribute('data-pd-swatch-remove'))) { var sw = C.findSwatch(S.doc, a); if (commitOp({ op: 'paletteRemove', id: a }, T('Remove colour'))) say(tf('Removed %s.', sw.swatch.label)); return; }
    if ((a = t.getAttribute('data-pd-colour'))) { applyColour(t.getAttribute('data-pd-field'), a); return; }
    switch (t.getAttribute('data-pd-act')) {
      case 'undo': undoRedo('undo'); return;
      case 'redo': undoRedo('redo'); return;
      case 'grid': S.grid = !S.grid; t.setAttribute('aria-pressed', S.grid ? 'true' : 'false'); renderCanvas(); if (S.v3.ctl) S.v3.ctl.invalidate(); return;
      case 'guides': if (S.mode === '3d') { setCheck3d(!S.v3.check); return; } S.guides = !S.guides; t.setAttribute('aria-pressed', S.guides ? 'true' : 'false'); renderCanvas(); return;
      case 'fit': if (S.mode === '3d') { reset3d(); return; } fitView(); applyCamera(); return;
      case 'turntable': toggleTurntable(); return;
      case 'closeup': closeUp(); return;
      case 'compare3d': compareButton(t); return;
      case 'cycle-light': cycle3d('light'); return;
      case 'cycle-fabric': cycle3d('fabric'); return;
      case 'cycle-quality': cycle3d('quality'); return;
      case 'focus': S.focus = !S.focus; S.el.shell.setAttribute('data-focus', S.focus ? 'true' : 'false'); t.setAttribute('aria-pressed', S.focus ? 'true' : 'false'); return;
      case 'select': S.el.canvas.focus({ preventScroll: true }); return;
      case 'add-text': addElement('text'); return;
      case 'add-shape': addElement('shield'); return;
      case 'patterns': { var first = S.el.strip.querySelector('button'); if (first) first.focus(); return; }
      case 'layers': if (S.inspTab !== 'design') { S.inspTab = 'design'; fillInsp(); } setPanel(window.matchMedia && window.matchMedia('(max-width: 980px)').matches ? 'inspector' : S.panel); var row1 = S.el.layers && S.el.layers.querySelector('button'); if (row1) row1.focus(); return;
      case 'elements': S.libTab = 'elements'; var lib2 = buildLib(); S.el.lib.parentNode.replaceChild(lib2, S.el.lib); S.el.lib = lib2; setPanel(window.matchMedia && window.matchMedia('(max-width: 1279px)').matches ? 'library' : S.panel); return;
      case 'strip-prev': S.el.strip.scrollBy({ left: (DIR === 'rtl' ? 1 : -1) * 140, behavior: 'smooth' }); return;
      case 'strip-next': S.el.strip.scrollBy({ left: (DIR === 'rtl' ? -1 : 1) * 140, behavior: 'smooth' }); return;
      case 'duplicate': duplicateSel(); return;
      case 'delete': deleteSel(); return;
      case 'forward': reorder(1); return;
      case 'backward': reorder(-1); return;
      case 'align-h': alignSel('h'); return;
      case 'align-v': alignSel('v'); return;
      case 'reset-box': { var n = selectedLayer(); if (n && !n.locked) batch([['w', n.w0], ['h', n.h0], ['r', 0]].map(function (kv) { return { op: 'set', target: { kind: 'layer', id: n.id }, key: kv[0], value: kv[1] }; }), T('Reset')); return; }
      case 'add-colour': addColour(); return;
      case 'save': serverSave(); return;
      case 'import': S.el.file.value = ''; S.el.file.click(); return;
      case 'export': exportFile(); return;
      case 'close-panel': setPanel(null); return;
      default: return;
    }
  }
  function applyColour(field, id) {
    var n = selectedLayer();
    if (field === 'base' || (field === 'color' && S.sel && S.sel.kind === 'base')) { var surf = surfaceOfView(); commitOp({ op: 'set', target: { kind: 'surface', id: surf.id }, key: 'base', value: id }, T('Base colour')); return; }
    if (field === ':palette' || !n) { say(T('Select an element, then pick a colour.')); return; }
    if (n.locked) { say(T('This element is locked. Unlock it in the list to move or change it.')); return; }
    if (field === 'outline') { setLayer(n.id, 'outline', id === ':none' ? null : id, T('Outline')); return; }
    setLayer(n.id, 'color', id, T('Colour'));
  }
  function alignSel(axis) {
    var n = selectedLayer();
    if (!n || !isBox(n) || n.locked) return;
    var ts = tSurface(C.findLayer(S.doc, n.id).surface.id), b = polygonBox(ts.safe);
    if (axis === 'h') setLayer(n.id, 'x', C.mm(ts.width / 2), T('Align'));
    else setLayer(n.id, 'y', C.mm(b.y + b.h / 2), T('Align'));
  }
  function addColour() {
    if (S.doc.palette.length >= LIMITS.palette) return;
    var id = C.nextId(S.doc, 'c');
    if (commitOp({ op: 'paletteInsert', index: S.doc.palette.length, swatch: { id: id, label: tf('Colour %d', S.doc.palette.length + 1), srgb: '#9aa4b2' } }, T('Add colour'))) {
      if (S.inspTab !== 'colour') { S.inspTab = 'colour'; var tabs = S.el.insp.querySelectorAll('[data-pd-insptab]'); for (var i = 0; i < tabs.length; i++) tabs[i].setAttribute('aria-selected', tabs[i].getAttribute('data-pd-insptab') === 'colour' ? 'true' : 'false'); }
      fillInsp();
      var pick = S.el.inspBody.querySelector('[data-pd-swatch="' + id + '"]');
      if (pick) pick.focus();
      say(T('Colour added. Choose its value in the palette.'));
    }
  }

  /** A typed or dragged value: committed live, one undo step per field while the reader keeps editing it. */
  function onInput(ev) {
    var t = ev.target;
    if (t === S.el.docName) { if (t.value.trim()) commitOp({ op: 'set', target: { kind: 'doc' }, key: 'name', value: t.value.slice(0, LIMITS.name) }, T('Design name'), 'doc-name'); return; }
    var sid = t.getAttribute('data-pd-swatch');
    if (sid) { commitOp({ op: 'set', target: { kind: 'swatch', id: sid }, key: 'srgb', value: String(t.value).toLowerCase() }, T('Colour'), 'swatch-' + sid); refreshColourRow(t, sid); return; }
    var lid = t.getAttribute('data-pd-swatch-label');
    if (lid) { if (t.value.trim()) commitOp({ op: 'set', target: { kind: 'swatch', id: lid }, key: 'label', value: t.value.slice(0, LIMITS.label) }, T('Colour name'), 'swatch-label-' + lid); return; }
    var field = t.getAttribute('data-pd-field');
    if (!field || t.tagName === 'SELECT' || t.tagName === 'BUTTON') return;
    if (t.type === 'range' || t.type === 'number') { fieldValue(t, field, true); return; }
    var n = selectedLayer();
    if (!n) return;
    if ((field === 'name' || field === 'text') && t.value.trim()) setLayer(n.id, field, t.value.slice(0, field === 'name' ? LIMITS.name : LIMITS.text), field === 'name' ? T('Element name') : T('Text'), field + '-' + n.id);
  }
  function refreshColourRow(input, id) {
    var row = input.closest('.pd-palette-row');
    var code = row && row.querySelector('.pd-hex');
    if (code) code.textContent = C.findSwatch(S.doc, id).swatch.srgb;
  }
  function onChange(ev) {
    var t = ev.target, field = t.getAttribute('data-pd-field');
    if (t.tagName === 'SELECT' && field) { var n = selectedLayer(); if (n) { setLayer(n.id, field, t.value, T(field === 'font' ? 'Font' : field === 'shape' ? 'Shape' : 'Pattern')); renderLayers(); } return; }
    if (field && (t.type === 'range' || t.type === 'number')) { fieldValue(t, field, false); S.merge = null; return; }
    if (t === S.el.docName || field === 'name' || field === 'text' || t.hasAttribute('data-pd-swatch') || t.hasAttribute('data-pd-swatch-label')) {
      S.merge = null;
      if (t.hasAttribute('data-pd-swatch-label') || t.hasAttribute('data-pd-swatch')) { renderProduct(); }
      if (!t.value.trim() && t === S.el.docName) t.value = S.doc.name;
    }
  }
  /** A number from a slider or a field, clamped to what the core accepts. */
  function fieldValue(t, field, live) {
    var n = selectedLayer(), v = Number(t.value);
    if (!n || !isFinite(v) || n.locked) return;
    var ops;
    if (field === 'scale%') {
      var sz = C.scaleBox(n, v);
      ops = [{ op: 'set', target: { kind: 'layer', id: n.id }, key: 'w', value: sz.w }, { op: 'set', target: { kind: 'layer', id: n.id }, key: 'h', value: sz.h }];
    } else {
      var val;
      if (field === 'r' || field === 'angle') val = C.normAngle(v);
      else if (field === 'opacity') val = Math.round(Math.max(5, Math.min(100, v)));
      else if (field === 'scale') val = C.mm(Math.max(LIMITS.scaleMin, Math.min(LIMITS.scaleMax, v)));
      else if (field === 'w' || field === 'h') val = C.mm(Math.max(LIMITS.minSize, Math.min(LIMITS.size, v)));
      else val = C.mm(Math.max(-LIMITS.coord, Math.min(LIMITS.coord, v)));
      ops = [{ op: 'set', target: { kind: 'layer', id: n.id }, key: field, value: val }];
    }
    var key = 'field-' + field + '-' + n.id;
    commitOp(ops.length === 1 ? ops[0] : { op: 'batch', ops: ops }, T('Change'), key);
    if (!live) say(tf('%s: %s', t.getAttribute('aria-label') || field, t.value));
  }

  // Layers: Alt and an arrow on a row moves it; a row can also be dragged.
  function onRowKey(ev) {
    var t = ev.target;
    if (!t.getAttribute || !t.getAttribute('data-pd-select') || !ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    var id = t.getAttribute('data-pd-select');
    if (id === ':base') return;
    ev.preventDefault();
    if (!S.sel || S.sel.id !== id) select({ kind: 'layer', id: id });
    reorder(ev.key === 'ArrowUp' ? 1 : -1);
    var again = S.el.layers && S.el.layers.querySelector('[data-pd-select="' + id + '"]');
    if (again) again.focus();
  }
  function onDragStart(ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest('[data-pd-row]') : null;
    if (!row) return;
    S.rowDrag = row.getAttribute('data-pd-row');
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', S.rowDrag); } catch (_) {}
  }
  function onDragOver(ev) { if (S.rowDrag && ev.target.closest && ev.target.closest('[data-pd-row]')) ev.preventDefault(); }
  function onDrop(ev) {
    var row = ev.target.closest ? ev.target.closest('[data-pd-row]') : null, id = S.rowDrag;
    S.rowDrag = null;
    if (!row || !id) return;
    ev.preventDefault();
    var target = C.findLayer(S.doc, row.getAttribute('data-pd-row')), moving = C.findLayer(S.doc, id);
    if (!target || !moving || target.surface !== moving.surface || target.layer.id === id) return;
    commitOp({ op: 'move', id: id, index: target.index }, T('Reorder'));
    say(tf('%s moved in the list.', moving.layer.name));
  }

  // ── files: export and import ──────────────────────────────────────────────

  function exportFile() {
    var text = C.serializeDocument(S.doc);
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = h('a', { href: url, download: C.exportFileName(S.doc.name) });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    say(tf('Exported %s.', C.exportFileName(S.doc.name)));
  }
  function onFile() {
    var file = S.el.file.files && S.el.file.files[0];
    // Cleared at once, so that choosing the same file again is a new choice the browser reports.
    S.el.file.value = '';
    if (!file) return;
    if (file.size > LIMITS.bytes) { say(tf('Not imported: %s', T('The file is larger than 512 KB.'))); return; }
    var mine = S;
    file.text().then(function (text) {
      if (S !== mine) return;
      try {
        var doc = C.parseDocument(text, TEMPLATE);
        S.doc = doc;
        S.hist = C.createHistory();
        S.sel = null;
        S.merge = null;
        setLink(null);
        S.srv.state = 'local'; S.srv.conflict = null; S.srv.error = ''; S.srv.notice = ''; S.srv.origin = 'FILE_IMPORT'; S.srv.revs = null;
        changed();
        buildProps();
        saveNow();
        renderDock();
        say(tf('Imported %s. The undo history starts again from here.', doc.name) + ' ' + T('Save design keeps it on the Familista server as a new design.'));
      } catch (e) {
        say(tf('Not imported: %s', problemText(e)));
      }
    }).catch(function () { if (S) say(tf('Not imported: %s', T('The file is not a design file.'))); });
  }

  // ── entry points ──────────────────────────────────────────────────────────

  function loadTemplate() {
    if (TEMPLATE) return Promise.resolve(TEMPLATE);
    if (!TEMPLATE_LOADING) {
      TEMPLATE_LOADING = fetch(TEMPLATE_URL).then(function (r) { if (!r.ok) throw new Error('template'); return r.json(); })
        .then(function (t) { TEMPLATE = C.validateTemplate(t); return TEMPLATE; })
        .catch(function (e) { TEMPLATE_LOADING = null; throw e; });
    }
    return TEMPLATE_LOADING;
  }

  window.renderFamilistaProductDesign = function (host) {
    if (!host) return;
    if (S) window.teardownFamilistaProductDesign();
    S = fresh(host);
    var mine = S;
    host.setAttribute('aria-busy', 'true');
    clear(host);
    host.appendChild(h('div', { class: 'pd-shell pd-shell--loading' }, [h('div', { class: 'pd-loading', role: 'status', text: 'Familista Design Studio' })]));
    Promise.all([setLocale(initialLocale()), loadTemplate()]).then(function () {
      if (S !== mine) return;
      var stored = loadStored();
      S.doc = stored.doc;
      S.saveState = stored.note === 'unavailable' ? 'unavailable' : 'saved';
      S.srv.link = P.readLink();
      // A draft DS-1a kept in this browser, not yet on the server: its first save is recorded as coming from it.
      if (!S.srv.link && stored.note === 'restored') S.srv.origin = 'BROWSER_DRAFT';
      S.metrics.mounts++;
      build();
      checkLink();
      host.removeAttribute('aria-busy');
      if (stored.note === 'restored') say(tf('Opened %s, saved in this browser.', S.doc.name));
      else if (stored.note === 'unreadable') say(T('The draft saved in this browser could not be read, so a new design was started. The unreadable copy was kept aside.'));
      else if (stored.note === 'unavailable') say(T('Not saved: this browser’s storage is unavailable'));
      else say(T('A new design was started. Save design keeps it on the Familista server.'));
    }).catch(function () {
      if (S !== mine) return;
      host.removeAttribute('aria-busy');
      clear(host);
      host.appendChild(h('div', { class: 'pd-shell pd-shell--loading' }, [h('p', { class: 'pd-loading', role: 'alert', text: T('The product template could not be loaded. Check the connection and open the Design Studio again.') })]));
    });
  };

  window.teardownFamilistaProductDesign = function () {
    if (!S) return;
    if (S.doc && S.saveTimer) saveNow(false);
    close3d();
    unbind();
    clearTimeout(S.saveTimer);
    clearTimeout(S.thumbTimer);
    var host = S.host;
    S = null;
    clear(host);
  };

  /** Read-only figures for the browser proof: counts, timings and editor state. It changes nothing. */
  window.__familistaProductDesignMetrics = function () {
    if (!S || !S.doc) return null;
    var ms = S.metrics.renderMs.slice().sort(function (a, b) { return a - b; });
    var ed = S.metrics.editMs.slice().sort(function (a, b) { return a - b; });
    return {
      mounts: S.metrics.mounts, commits: S.metrics.commits, renders: S.metrics.renders, layerPaints: S.metrics.layerPaints,
      renderMsMedian: ms.length ? ms[Math.floor(ms.length / 2)] : null, renderMsMax: ms.length ? ms[ms.length - 1] : null,
      edits: S.metrics.editMs.length, editMsMedian: ed.length ? ed[Math.floor(ed.length / 2)] : null, editMsP95: ed.length ? ed[Math.floor(ed.length * 0.95)] : null,
      view: S.view, mode: S.mode, selected: S.sel, undo: S.hist.past.length, redo: S.hist.future.length,
      layers: S.doc.surfaces.map(function (x) { return x.layers.length; }), findings: S.findings.length,
      saveState: S.saveState, lastSaveBytes: S.metrics.lastSaveBytes, announced: S.announced, lang: LANG, dir: DIR,
      server: { state: S.srv.state, busy: S.srv.busy, linked: !!S.srv.link, projectId: S.srv.link ? S.srv.link.projectId : null, revision: S.srv.link ? S.srv.link.revision : null,
        conflict: S.srv.conflict, dockOpen: S.srv.open, tab: S.srv.tab, list: S.srv.listState, versions: S.srv.revState, origin: S.srv.origin },
      camera: S.cam ? { cx: S.cam.cx, cy: S.cam.cy, z: S.cam.z } : null,
      three: { state: S.v3.state, failed: S.v3.failed, quality: S.v3.quality, lighting: S.v3.lighting, fabric: S.v3.fabric, check: S.v3.check, turntable: S.v3.turntable,
        compare: S.v3.compare, versions: Array.isArray(S.v3.versions) ? S.v3.versions.length : S.v3.versions, engine: S.v3.ctl ? S.v3.ctl.metrics() : null },
    };
  };
  /** Where a point of a surface appears in the 3D view, in CSS pixels of the canvas: for the browser proof. It changes nothing. */
  window.__familistaProductDesignProject = function (surface, x, y) {
    return S && S.v3.ctl ? S.v3.ctl.project(surface, x, y) : null;
  };
})();
