/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — SPECIMEN LAB — Stage 3.2.3 M1 — Fixture Plate

   THE VERIFIED PRIMITIVES, DRAWN BY THE PRODUCTION STYLESHEET

   Loaded on demand by public/design-system/design-system.js, the first time the
   platform owner opens the Specimen Lab section — never by the page, never by Owner
   Home — together with the shared sanitizer (lab-sanitize.js). It draws fixtures
   the server generated from the repository
   (src/design-system/generated/design-system-previews.json) and serves read-only at
   /system/design-system/components/preview.

   WHAT A SPECIMEN IS

   Markup a production render function produced for a fixed input, run once in the
   Storybook golden test and stored. It is NOT rendered by running the component
   here: nothing in this file calls a production function, evaluates a string or
   imports the application. The markup is checked again by the shared sanitizer
   (the server has already checked it, and so did the build) and the page is given
   nodes built from the checked tree — createElement, setAttribute, createTextNode —
   never a string of HTML. The styles are production's own, from the app.css the
   room already runs inside, so nothing is loaded twice.

   WHAT KEEPS A SPECIMEN IN ITS STAGE

   - Events: the specimen's root stops every event at its own boundary, so no
     document-level production handler ever sees a click, key or pointer event that
     started inside it. The sanitizer has already removed the attribute those
     handlers key on (data-action); this is a second, independent wall.
   - Layout: the stage is a paint- and layout-contained box, so a position:fixed
     overlay (the modal the lg-float primitive draws) is anchored to the stage and
     clipped by it, and cannot cover the application.
   - Language: the stage is marked data-no-i18n, so the application's translator
     leaves a fixture exactly as recorded.
   - Assistive technology: aria-modal is removed, so a specimen never hides the
     rest of the page from a screen reader.
   - Zoom: the stage is viewport → frame → canvas. The canvas (#lab-specimen) keeps
     every wall above and is the one element scaled, with a CSSOM transform; the frame
     is sized to the scaled canvas; the viewport is a second contained box and the
     only one that scrolls. At exactly 100% there is no transform at all, so the
     unzoomed stage is the M1 stage. Every number comes from lab-view.js, clamped.
   These are claims, and tools/components/lab-browser-proof.cjs proves each one in a
   real browser; the Jest suite checks that this file wires them.

   WHAT IS NOT HERE

   No state simulation, no hover or focus emulation, no anatomy overlay, no width
   control, no light theme: the stage is one surface, dark, with a left-to-right or
   right-to-left direction, and a zoom (M2 / S1) that scales the specimen inside it. Viewport @media rules respond to the browser window, not
   to the stage, and the inspector says so for the two primitives that have them.

   READ-ONLY, CSP-SAFE

   The only reader is the room's GET-only api(). No style attribute and no inline
   handler is written. The one inline-style-free width the primitives need
   (data-mc-width, and the crest size data-lg-size) is applied with the CSSOM,
   exactly as production does.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var K = null;                 // the room's kit
  var Z = null;                 // the shared sanitizer
  var V = null;                 // the view maths (lab-view.js)
  function T(s) { return K.T(s); }
  function tf() { return K.tf.apply(null, arguments); }
  function esc(s) { return K.esc(s); }
  function num(n) { return K.num(n); }
  function code(s) { return K.code(s); }

  // ── the vocabulary ────────────────────────────────────────────────────────

  var REASON_ORDER = ['no-fixtures', 'css-only', 'application-shell', 'utility', 'css-family', 'page-specific', 'candidate'];
  var REASON_LABEL = {
    'no-fixtures': 'No fixtures yet', 'css-only': 'CSS only', 'application-shell': 'Application shell', utility: 'Utility class',
    'css-family': 'Style family', 'page-specific': 'Page styles', candidate: 'Candidate',
  };
  var REASON_WHY = {
    'no-fixtures': 'A render function exists, but no fixtures are recorded for it yet.',
    'css-only': 'Its markup is written inside page templates. There is no render function and no fixture to draw.',
    'application-shell': 'It only draws inside the application shell, which the Lab does not load.',
    utility: 'A page-level or utility class. It draws nothing of its own.',
    'css-family': 'A family of page styles, not one component.',
    'page-specific': 'Styles that belong to a single page.',
    candidate: 'Nobody has verified that this is a shared component.',
  };
  var REASON_FIX = {
    'no-fixtures': 'It becomes previewable when reviewed fixtures are recorded for it. This stage records none.',
    'css-only': 'It would need a reviewed markup fixture. This stage adds none.',
    'application-shell': 'Previewing it would mean running the application, which the Lab never does.',
    utility: 'Nothing to preview: the class changes how a page is laid out.',
    'css-family': 'Nothing to preview: each page draws its own.',
    'page-specific': 'Nothing to preview outside its page.',
    candidate: 'It stays unavailable until it is reviewed and registered as a component.',
  };
  var NEUTRAL_WHY = {
    'data-action': 'The application listens for it at document level; a click in a specimen must not reach a production handler.',
    'data-i18n-aria': 'The application translates elements that carry it; a specimen shows the fixture as recorded.',
    'aria-modal': 'A live modal hides the rest of the page from a screen reader; a specimen is not a modal.',
    tabindex: 'A button in a specimen does nothing, so it is taken out of the tab order.',
  };
  var NEUTRAL_ACTION = {
    removed: 'Removed', 'set to -1 on buttons': 'Set to -1 on buttons',
  };
  var OWNER_LABEL = { css: 'Production CSS, not in the registry', inert: 'No production rule' };
  var TABS = [['provenance', 'Provenance'], ['source', 'Source'], ['sanitization', 'Sanitization'], ['variants', 'Variants']];

  // Events that stop at the specimen's boundary.
  var BOUNDARY = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'contextmenu', 'focusin', 'focusout'];

  // ── state ─────────────────────────────────────────────────────────────────

  function fresh() {
    return {
      comps: null, byId: Object.create(null),     // the registry's components index
      pv: null, avail: Object.create(null),        // the previews index
      detail: Object.create(null), detailError: Object.create(null), detailLoading: Object.create(null),
      sel: null, fixture: null, dir: 'ltr', tab: 'provenance', q: '', open: { preview: true },
      zoom: 1, fit: false,
      loading: false, error: null, check: null, focus: null,
    };
  }
  var S = fresh();
  var R = { host: null, root: null, bound: [], specimenBound: null, ro: null, raf: 0, nat: null };
  var M = { loadMs: null, renderMs: null, switchMs: null, zoomMs: null, specimenNodes: 0, fixtures: 0, components: 0 };

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function rtl() { return K && K.dir() === 'rtl'; }
  function live(text) { var l = document.getElementById('lab-live'); if (l) l.textContent = text; }
  function countText(n, one, many) { return n === 1 ? tf('%d ' + one, n) : tf('%d ' + many, n); }

  // ── loading ───────────────────────────────────────────────────────────────

  function loadIndexes() {
    var t0 = now();
    S.loading = true;
    return Promise.all([K.api('/system/design-system/components'), K.api('/system/design-system/components/preview')]).then(function (r) {
      var c = r[0], p = r[1];
      var miss = ['state', 'components'].filter(function (k) { return !c || c[k] === undefined || c[k] === null; });
      if (miss.length) { S.error = K.contractError('/system/design-system/components', miss); return; }
      miss = ['state', 'availability', 'components'].filter(function (k) { return !p || p[k] === undefined || p[k] === null; });
      if (miss.length) { S.error = K.contractError('/system/design-system/components/preview', miss); return; }
      if (c.state !== 'READY') { S.error = c.reason || T('The components could not be read'); return; }
      if (p.state !== 'READY') { S.error = p.reason || T('The previews could not be read'); return; }
      S.comps = c; S.pv = p;
      S.byId = Object.create(null); c.components.forEach(function (x) { S.byId[x.id] = x; });
      S.avail = Object.create(null); p.availability.forEach(function (a) { S.avail[a.id] = a; });
      M.components = p.coverage ? p.coverage.previewable : 0; M.fixtures = p.coverage ? p.coverage.fixtures : 0;
    }).catch(function (e) { S.error = e.message; }).then(function () { S.loading = false; M.loadMs = Math.round((now() - t0) * 10) / 10; });
  }

  function loadDetail(id) {
    if (S.detail[id]) return Promise.resolve();
    if (S.detailLoading[id]) return S.detailLoading[id];
    S.detailLoading[id] = K.api('/system/design-system/components/preview?id=' + encodeURIComponent(id)).then(function (d) {
      var miss = ['state', 'component'].filter(function (k) { return !d || d[k] === undefined; });
      if (miss.length) { S.detailError[id] = K.contractError('/system/design-system/components/preview?id=' + id, miss); return; }
      if (d.state !== 'READY' || !d.component) { S.detailError[id] = d.reason || T('The fixtures could not be read'); return; }
      S.detail[id] = d.component; delete S.detailError[id];
    }).catch(function (e) { S.detailError[id] = e.message; }).then(function () { delete S.detailLoading[id]; });
    return S.detailLoading[id];
  }

  function classSet(f) { var o = Object.create(null); f.classes.forEach(function (c) { o[c.name] = true; }); return o; }

  /** The browser's own check of a fixture. Returns { ok, problems, tree, stats }. */
  function checkFixture(f) {
    var allowed = classSet(f);
    var out = Z.sanitize(f.html, { classOk: function (n) { return allowed[n] === true; } });
    if (out.ok && out.html !== f.html) return { ok: false, problems: ['the markup is not the canonical form the server checked'], tree: null, stats: out.stats };
    return out;
  }

  // ── helpers over the data ─────────────────────────────────────────────────

  function allIds() { return S.comps ? S.comps.components.map(function (c) { return c.id; }) : []; }
  function groupOf(id) { var a = S.avail[id]; return a && a.state === 'preview' ? 'preview' : (a ? a.reason : 'css-only'); }
  function matches(c, q) {
    if (!q) return true;
    var hay = [c.name, c.id, c.symbol || '', c.kind, T(REASON_LABEL[groupOf(c.id)] || '')].join(' ').toLowerCase();
    return q.split(/\s+/).every(function (t) { return hay.indexOf(t) >= 0; });
  }
  function current() { return S.sel ? S.detail[S.sel] || null : null; }
  function curFixture() {
    var c = current();
    if (!c) return null;
    for (var i = 0; i < c.fixtures.length; i++) if (c.fixtures[i].id === S.fixture) return c.fixtures[i];
    return null;
  }
  function fixtureIndex(c) { for (var i = 0; i < c.fixtures.length; i++) if (c.fixtures[i].id === S.fixture) return i; return -1; }

  // ── drawing: the rail ─────────────────────────────────────────────────────

  function itemHtml(c) {
    var g = groupOf(c.id), on = c.id === S.sel, na = g !== 'preview';
    return '<li class="lab-li"><button type="button" class="lab-item' + (na ? ' is-na' : '') + (on ? ' is-sel' : '') + '" data-lab-id="' + esc(c.id) + '"'
      + (na ? ' aria-disabled="true"' : '') + (on ? ' aria-current="true"' : '') + ' tabindex="-1">'
      + '<span class="lab-item-n" data-no-i18n>' + esc(c.name) + '</span>'
      + (na ? '<span class="lab-item-r">' + esc(T(REASON_LABEL[g] || '')) + '</span>'
        : '<span class="lab-item-r lab-item-r--ok">' + esc(countText(S.pv.components.filter(function (x) { return x.id === c.id; })[0].fixtures, 'fixture', 'fixtures')) + '</span>')
      + '</button></li>';
  }

  function railHtml() {
    if (!S.comps) return S.error ? '' : K.skeleton(10, 'row');
    var q = S.q.trim().toLowerCase();
    var groups = {};
    S.comps.components.forEach(function (c) { if (matches(c, q)) (groups[groupOf(c.id)] = groups[groupOf(c.id)] || []).push(c); });
    var total = S.comps.components.length;
    var keys = ['preview'].concat(REASON_ORDER);
    var shown = 0;
    var html = keys.map(function (k) {
      var list = groups[k] || [];
      shown += list.length;
      if (!list.length) return '';
      var open = q ? true : (S.open[k] === true || list.some(function (c) { return c.id === S.sel; }));
      var title = k === 'preview' ? 'Live previews' : REASON_LABEL[k];
      return '<section class="lab-grp"><h2 class="lab-grp-h"><button type="button" class="lab-grp-b" data-lab-grp="' + k + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="lab-g-' + k + '" tabindex="-1">'
        + '<span class="lab-grp-t">' + esc(T(title)) + '</span><span class="lab-grp-n">' + esc(num(list.length)) + '</span></button></h2>'
        + '<ul class="lab-list" id="lab-g-' + k + '"' + (open ? '' : ' hidden') + '>' + list.map(itemHtml).join('') + '</ul></section>';
    }).join('');
    var count = document.getElementById('lab-count');
    if (count) count.textContent = tf('%d of %d components', shown, total);
    return html || '<div class="lab-none">' + K.emptyState('No component matches', T('Clear the search.')) + '</div>';
  }

  function drawRail() {
    var rail = document.getElementById('lab-rail-body');
    if (!rail) return;
    var keep = document.activeElement && rail.contains(document.activeElement) ? (document.activeElement.getAttribute('data-lab-id') || document.activeElement.getAttribute('data-lab-grp')) : null;
    rail.innerHTML = railHtml();
    setRove(keep);
    if (keep) { var again = rail.querySelector('[data-lab-id="' + cssq(keep) + '"], [data-lab-grp="' + cssq(keep) + '"]'); if (again) again.focus(); }
  }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function railButtons() { return R.host ? [].slice.call(R.host.querySelectorAll('#lab-rail-body button')).filter(function (b) { var ul = b.closest('ul'); return !ul || !ul.hidden; }) : []; }
  function setRove(prefer) {
    var list = railButtons(), want = null, i;
    for (i = 0; i < list.length; i++) if (prefer && (list[i].getAttribute('data-lab-id') === prefer || list[i].getAttribute('data-lab-grp') === prefer)) want = list[i];
    if (!want) for (i = 0; i < list.length; i++) if (list[i].getAttribute('data-lab-id') === S.sel) want = list[i];
    if (!want) want = list[0];
    list.forEach(function (b) { b.setAttribute('tabindex', b === want ? '0' : '-1'); });
  }

  // ── drawing: the stage ────────────────────────────────────────────────────

  function benchHtml() {
    if (S.error) return '<div class="lab-na">' + K.emptyState('The Specimen Lab could not be read', T(S.error)) + '</div>';
    if (!S.comps) return '<div class="lab-na">' + K.skeleton(6, 'row') + '</div>';
    var id = S.sel;
    if (!id) return '<div class="lab-na">' + K.emptyState('Choose a component', T('Select a component on the left to see its fixtures.')) + '</div>';
    var sum = S.byId[id];
    var a = S.avail[id];
    var head = '<header class="lab-bench-h"><div class="lab-bench-id"><h2 class="lab-title" id="lab-title" tabindex="-1" data-no-i18n>' + esc(sum.name) + '</h2>'
      + '<div class="lab-sub">' + code(sum.symbol || sum.id) + '<span class="lab-sub-f" id="lab-fixture-name" data-no-i18n></span></div></div>';
    if (!a || a.state !== 'preview') {
      return head + '</header><div class="lab-plate lab-plate--na"><div class="lab-na">' + K.emptyState('Not previewable', T(REASON_WHY[a ? a.reason : 'css-only']),
        '<div class="ds-note">' + esc(T(REASON_FIX[a ? a.reason : 'css-only'])) + '</div>') + '</div></div>';
    }
    if (!S.detail[id]) {
      return head + '</header><div class="lab-plate lab-plate--na">' + (S.detailError[id] ? '<div class="lab-na">' + K.emptyState('The fixtures could not be read', T(S.detailError[id])) + '</div>' : '<div class="lab-wait">' + K.skeleton(4, 'row') + '</div>') + '</div>';
    }
    return head
      + '<div class="lab-tools">' + zoomHtml()
      + '<div class="ds-seg lab-dir" role="group" aria-label="' + esc(T('Stage direction')) + '">'
      + ['ltr', 'rtl'].map(function (d) {
        return '<button type="button" class="ds-seg-b' + (S.dir === d ? ' is-on' : '') + '" data-lab-dir="' + d + '" aria-pressed="' + (S.dir === d ? 'true' : 'false') + '" aria-label="' + esc(d.toUpperCase() + ' · ' + T(d === 'ltr' ? 'Left to right' : 'Right to left')) + '"><span data-no-i18n>' + d.toUpperCase() + '</span></button>';
      }).join('') + '</div></div></header>'
      + '<div class="lab-evrow" id="lab-evrow"></div>'
      + '<div class="lab-plate" id="lab-plate" role="tabpanel" aria-labelledby="lab-tab-current">'
      + '<div class="lab-viewport" id="lab-viewport"><div class="lab-frame" id="lab-frame" dir="' + S.dir + '">'
      + '<div class="lab-specimen" id="lab-specimen" dir="' + S.dir + '" data-no-i18n data-lab-stage role="group" aria-label="' + esc(T('Specimen')) + '"></div>'
      + '</div></div>'
      + '<div class="lab-void" id="lab-void" hidden>' + K.emptyState('This input draws nothing', T('The production function returned no markup for this input, which is the answer it gives.')) + '</div>'
      + '<div class="lab-refuse" id="lab-refuse" hidden></div>'
      + '</div>'
      + '<div class="lab-strip" id="lab-strip" role="tablist" aria-label="' + esc(T('Fixtures')) + '"></div>';
  }

  // ── zoom (M2 / S1) ────────────────────────────────────────────────────────

  var ZOOM_KEYS = { out: '-', 'in': '=', fit: 'F', reset: '0' };
  function zoomOff(act) {
    if (act === 'out') return !S.fit && S.zoom <= V.MIN;
    if (act === 'in') return !S.fit && S.zoom >= V.MAX;
    if (act === 'reset') return !S.fit && S.zoom === 1;
    return false;
  }
  function zoomBtn(act, label, inner) {
    var off = zoomOff(act);
    return '<button type="button" class="ds-seg-b lab-zoom-b' + (act === 'fit' && S.fit ? ' is-on' : '') + '" data-lab-zoom="' + act + '" aria-label="' + esc(label) + '"'
      + (act === 'fit' ? ' aria-pressed="' + (S.fit ? 'true' : 'false') + '"' : '')
      + ' aria-disabled="' + (off ? 'true' : 'false') + '" aria-keyshortcuts="' + ZOOM_KEYS[act] + '">' + inner + '</button>';
  }
  function zoomHtml() {
    return '<div class="ds-seg lab-zoom" role="group" aria-label="' + esc(T('Zoom')) + '">'
      + zoomBtn('out', T('Zoom out'), '<span aria-hidden="true">&minus;</span>')
      + '<span class="lab-zoom-v" id="lab-zoom-v" data-no-i18n>' + esc(num(V.percent(S.zoom))) + '%</span>'
      + zoomBtn('in', T('Zoom in'), '<span aria-hidden="true">+</span>')
      + zoomBtn('fit', T('Fit to stage'), '<span>' + esc(T('Fit')) + '</span>')
      + zoomBtn('reset', tf('Reset to %d%', 100), '<span data-no-i18n>' + esc(num(100)) + '%</span>')
      + '</div>';
  }
  /** Bring the controls in line with the state without redrawing them, so focus stays where it is. */
  function syncZoom() {
    var v = document.getElementById('lab-zoom-v'); if (v) v.textContent = num(V.percent(S.zoom)) + '%';
    if (!R.host) return;
    [].forEach.call(R.host.querySelectorAll('[data-lab-zoom]'), function (b) {
      var act = b.getAttribute('data-lab-zoom');
      b.setAttribute('aria-disabled', zoomOff(act) ? 'true' : 'false');
      if (act === 'fit') { b.setAttribute('aria-pressed', S.fit ? 'true' : 'false'); b.classList.toggle('is-on', S.fit); }
    });
  }
  function unsetStyle(el, prop) { if (el && el.style && typeof el.style.removeProperty === 'function') el.style.removeProperty(prop); }
  function px(el, side) {
    if (!el || typeof window.getComputedStyle !== 'function') return 0;
    var v = parseFloat(window.getComputedStyle(el)[side]); return isFinite(v) ? v : 0;
  }
  /** The scale at which the whole specimen is visible in the viewport, measured at 100%; never above 100%. */
  function fitScale(vp, spec) {
    var col = spec.firstElementChild;
    if (!col) return 1;
    return V.fit(vp.clientWidth, vp.clientHeight,
      col.offsetWidth + px(spec, 'paddingLeft') + px(spec, 'paddingRight'),
      col.offsetHeight + px(spec, 'paddingTop') + px(spec, 'paddingBottom'));
  }
  function clearZoom(fr, spec) {
    ['width', 'height'].forEach(function (p) { unsetStyle(fr, p); });
    ['width', 'min-height', 'transform', 'transform-origin'].forEach(function (p) { unsetStyle(spec, p); });
    if (fr.classList) fr.classList.remove('is-zoomed');
  }
  /**
   * Lay the stage out at the current zoom. The specimen's natural (100%) size is measured once,
   * with the stage back at 100%, whenever what it depends on changes (`measure`: a new fixture,
   * a new direction, a resized viewport); a zoom step reuses it and only writes, so stepping never
   * forces a layout. The canvas is held at its natural size, scaled through the CSSOM, and the frame
   * is given the scaled size so the viewport scrolls exactly as far as the scaled specimen reaches.
   */
  function applyZoom(measure) {
    var vp = document.getElementById('lab-viewport'), fr = document.getElementById('lab-frame'), spec = document.getElementById('lab-specimen');
    if (!vp || !fr || !spec || !V) return;
    if (measure && !S.fit && V.clamp(S.zoom) === 1) { R.nat = null; clearZoom(fr, spec); return; }   // unzoomed: nothing to measure yet
    if (measure || !R.nat || R.nat.spec !== spec) {
      clearZoom(fr, spec);
      R.nat = { spec: spec, w: spec.offsetWidth, h: Math.max(spec.offsetHeight || 0, spec.scrollHeight || 0), fit: fitScale(vp, spec) };
    }
    var s = S.fit ? R.nat.fit : V.clamp(S.zoom);
    S.zoom = s;
    var size = V.frameSize(R.nat.w, R.nat.h, s);
    if (s === 1 || !size.width || !size.height) { clearZoom(fr, spec); return; }   // 100%, or nothing measurable (a hidden stage): no transform at all
    spec.style.setProperty('width', R.nat.w + 'px');
    spec.style.setProperty('min-height', R.nat.h + 'px');
    spec.style.setProperty('transform-origin', V.origin(S.dir));
    spec.style.setProperty('transform', V.transform(s));
    fr.classList.add('is-zoomed');
    fr.style.setProperty('width', size.width + 'px');
    fr.style.setProperty('height', size.height + 'px');
  }
  function zoomable() { var c = current(); return !!(c && S.avail[S.sel] && S.avail[S.sel].state === 'preview' && document.getElementById('lab-specimen')); }
  function zoomAction(act) {
    if (!V || !zoomable() || zoomOff(act)) return;
    if (act === 'in') { S.fit = false; S.zoom = V.zoomIn(S.zoom); }
    else if (act === 'out') { S.fit = false; S.zoom = V.zoomOut(S.zoom); }
    else if (act === 'reset') { S.fit = false; S.zoom = 1; }
    else if (act === 'fit') { S.fit = true; }
    else return;
    var t0 = now();
    applyZoom();
    M.zoomMs = Math.round((now() - t0) * 10) / 10;
    syncZoom();
    live(S.fit ? tf('Fit to stage: %d%', V.percent(S.zoom)) : tf('Zoom %d%', V.percent(S.zoom)));
  }
  /** The viewport is watched for size changes (window, sidebar, escape hatch) and the zoom is laid out again. */
  function observeStage() {
    stopObserving();
    var vp = document.getElementById('lab-viewport');
    if (!vp || typeof window.ResizeObserver !== 'function') return;
    var last = '';
    R.ro = new window.ResizeObserver(function () {
      var k = vp.clientWidth + 'x' + vp.clientHeight;
      if (k === last) return;
      last = k;
      if (!(S.fit || S.zoom !== 1) || typeof window.requestAnimationFrame !== 'function') return;
      if (R.raf) window.cancelAnimationFrame(R.raf);
      R.raf = window.requestAnimationFrame(function () { R.raf = 0; applyZoom(true); syncZoom(); });
    });
    R.ro.observe(vp);
  }
  function stopObserving() {
    if (R.ro) { R.ro.disconnect(); R.ro = null; }
    if (R.raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(R.raf);
    R.raf = 0;
  }

  function stripHtml(c) {
    return c.fixtures.map(function (f, i) {
      var on = f.id === S.fixture;
      return '<button type="button" class="lab-fx' + (on ? ' is-on' : '') + '" role="tab" id="' + (on ? 'lab-tab-current' : 'lab-tab-' + i) + '" aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '" data-lab-fx="' + esc(f.id) + '">'
        + '<span class="lab-fx-i" data-no-i18n>' + esc(i < 9 ? '0' + (i + 1) : String(i + 1)) + '</span><span class="lab-fx-l" data-no-i18n>' + esc(f.label) + '</span></button>';
    }).join('');
  }

  function evRowHtml() {
    return '<span class="lab-ev">' + K.evChip('MEASURED') + '<span>' + esc(T('Markup from the production render function')) + '</span></span>'
      + '<span class="lab-ev">' + K.evChip('RECORDED') + '<span>' + esc(T('The call that produced it')) + '</span></span>';
  }

  /** Builds the specimen from the checked tree, inside the contained root. Returns false if the fixture is refused. */
  function paintSpecimen(f) {
    var t0 = now();
    var spec = document.getElementById('lab-specimen');
    var refuse = document.getElementById('lab-refuse');
    var voidEl = document.getElementById('lab-void');
    if (!spec) return false;
    while (spec.firstChild) spec.removeChild(spec.firstChild);
    var res = checkFixture(f);
    S.check = { id: f.id, ok: res.ok, problems: res.problems, stats: res.stats };
    refuse.hidden = true; voidEl.hidden = true;
    if (!res.ok) {
      // Fail closed: nothing is drawn, and the reason is shown as text.
      refuse.hidden = false;
      refuse.innerHTML = K.emptyState('This fixture failed the browser’s check', res.problems.slice(0, 3).join(' · '));
      M.specimenNodes = 0;
      return false;
    }
    if (!res.tree.kids.length) { voidEl.hidden = false; M.specimenNodes = 0; M.renderMs = Math.round((now() - t0) * 10) / 10; return true; }
    var col = document.createElement('div');
    col.className = 'lab-col';
    col.appendChild(Z.toDom(res.tree, document));
    spec.appendChild(col);
    // Production applies bar widths and crest sizes after render, because its security
    // policy forbids inline styles. These are the same lines as public/app.js
    // (_mcPaintComputed); through the CSSOM they are not inline styles.
    col.querySelectorAll('[data-mc-width]').forEach(function (el) {
      el.style.setProperty('width', el.getAttribute('data-mc-width'));
    });
    col.querySelectorAll('[data-lg-size]').forEach(function (el) {
      var px = el.getAttribute('data-lg-size') + 'px';
      el.style.setProperty('width', px); el.style.setProperty('height', px);
    });
    M.specimenNodes = spec.getElementsByTagName('*').length;
    M.renderMs = Math.round((now() - t0) * 10) / 10;
    applyZoom(true); syncZoom();
    return true;
  }

  function drawBench() {
    var bench = document.getElementById('lab-bench');
    if (!bench) return;
    stopObserving();
    bench.innerHTML = benchHtml();
    var c = current();
    if (!c || !S.avail[S.sel] || S.avail[S.sel].state !== 'preview') { drawInspector(); return; }
    var f = curFixture() || c.fixtures[0];
    S.fixture = f.id;
    var strip = document.getElementById('lab-strip'); if (strip) strip.innerHTML = stripHtml(c);
    var ev = document.getElementById('lab-evrow'); if (ev) ev.innerHTML = evRowHtml();
    var nm = document.getElementById('lab-fixture-name'); if (nm) nm.textContent = ' · ' + f.label;
    bindSpecimen();
    paintSpecimen(f);
    observeStage();
    drawInspector();
  }

  function showFixture(id, opts) {
    var c = current(); if (!c) return;
    var t0 = now();
    S.fixture = id;
    var f = curFixture(); if (!f) return;
    var strip = document.getElementById('lab-strip');
    if (strip) {
      [].forEach.call(strip.querySelectorAll('[data-lab-fx]'), function (b) {
        var on = b.getAttribute('data-lab-fx') === id;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false'); b.setAttribute('tabindex', on ? '0' : '-1');
        b.id = on ? 'lab-tab-current' : 'lab-tab-x-' + b.getAttribute('data-lab-fx');
      });
      if (opts && opts.focus) { var cur = strip.querySelector('.is-on'); if (cur) cur.focus(); }
    }
    var nm = document.getElementById('lab-fixture-name'); if (nm) nm.textContent = ' · ' + f.label;
    paintSpecimen(f);
    drawInspector();
    M.switchMs = Math.round((now() - t0) * 10) / 10;
    live(tf('Fixture %d of %d', fixtureIndex(c) + 1, c.fixtures.length) + ': ' + f.label);
  }

  function setDir(d) {
    if (d !== 'ltr' && d !== 'rtl') return;
    S.dir = d;
    var spec = document.getElementById('lab-specimen'); if (spec) spec.setAttribute('dir', d);
    var fr = document.getElementById('lab-frame'); if (fr) fr.setAttribute('dir', d);
    applyZoom(true);
    [].forEach.call(R.host.querySelectorAll('[data-lab-dir]'), function (b) { var on = b.getAttribute('data-lab-dir') === d; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    live(T(d === 'ltr' ? 'Left to right' : 'Right to left'));
  }

  // The specimen's boundary: bound once per specimen element, removed with it.
  function bindSpecimen() {
    var spec = document.getElementById('lab-specimen');
    if (!spec) return;
    BOUNDARY.forEach(function (type) { spec.addEventListener(type, stopAtBoundary); });
  }
  function stopAtBoundary(ev) { ev.stopPropagation(); }

  // ── drawing: the inspector ────────────────────────────────────────────────

  function sectionHead(title, ev) { return '<div class="lab-sechead"><span class="lab-sec-t">' + esc(T(title)) + '</span>' + (ev || '') + '</div>'; }
  function notInstrumented(text) {
    return '<div class="lab-ni" role="status"><div class="lab-ni-t">' + esc(T('Not instrumented')) + '</div><div class="lab-ni-d">' + esc(T(text)) + '</div></div>';
  }
  function niChip() { return K.chip('none', T('Not instrumented'), T('The repository records nothing for this. It is not filled in.'), 'ds-chip--sm'); }

  function overviewHtml() {
    var cov = S.pv && S.pv.coverage;
    if (!cov) return '';
    var neutral = Object.keys(cov.neutralised).map(function (k) { return '<li>' + code(k) + ' <span class="lab-n">' + esc(num(cov.neutralised[k])) + '</span></li>'; }).join('');
    return '<div class="lab-ihead"><div class="lab-ikind"><span>' + esc(T('The Specimen Lab')) + '</span></div>'
      + '<h2 class="lab-ititle" id="lab-ititle" tabindex="-1">' + esc(T('Specimen Lab')) + '</h2>'
      + '<div class="lab-isub">' + esc(T('Select a component to see what the repository can show about its fixtures.')) + '</div></div>'
      + '<div class="lab-ibody"><div class="lab-pane">'
      + sectionHead('What is here', K.evChip('MEASURED'))
      + K.kv('Registered components', esc(num(cov.registered)))
      + K.kv('Previewable', esc(num(cov.previewable)))
      + K.kv('Fixtures', esc(num(cov.fixtures)))
      + K.kv('Unavailable', esc(num(cov.unavailable)))
      + '<div class="lab-ih">' + esc(T('Removed from every fixture')) + '</div><ul class="lab-plain">' + neutral + '</ul>'
      + '<div class="ds-note">' + esc(T('A specimen is markup the production render function produced for a fixed input. It is checked three times and never run.')) + '</div>'
      + '</div></div>';
  }

  function unavailableHtml(sum, a) {
    return '<div class="lab-ihead"><div class="lab-ikind"><span>' + esc(T(REASON_LABEL[a.reason] || '')) + '</span></div>'
      + '<h2 class="lab-ititle" id="lab-ititle" tabindex="-1" data-no-i18n>' + esc(sum.name) + '</h2>'
      + '<div class="lab-isub">' + code(sum.symbol || sum.id) + '</div></div>'
      + '<div class="lab-ibody"><div class="lab-pane">'
      + sectionHead('Not previewable', niChip())
      + '<p class="lab-p">' + esc(T(REASON_WHY[a.reason])) + '</p>'
      + '<p class="lab-p lab-dim">' + esc(T(REASON_FIX[a.reason])) + '</p>'
      + K.kv('Kind', esc(T(kindLabel(sum.kind))))
      + K.kv('Registry tier', esc(T(tierLabel(sum.tier))))
      + '</div></div>';
  }
  function kindLabel(k) { return ({ component: 'Production UI component', primitive: 'Shared UI primitive', pattern: 'Reusable design pattern', 'css-family': 'CSS family', 'layout-utility': 'Layout utility', 'page-specific': 'Page-specific styles', candidate: 'Unverified candidate' })[k] || k; }
  function tierLabel(t) { return ({ verified: 'Verified', catalogued: 'Catalogued', listed: 'Listed' })[t] || t; }

  function paneProvenance(c, f) {
    var mq = c.mediaQueries.length
      ? '<div class="lab-ih">' + esc(T('Viewport rules')) + '</div><ul class="lab-plain">' + c.mediaQueries.map(function (q) { return '<li>' + code(q) + '</li>'; }).join('') + '</ul>'
        + '<div class="ds-note">' + esc(T('These rules respond to the browser window, not to the stage.')) + '</div>' : '';
    var classes = '<table class="ds-table lab-tbl"><caption class="ds-sr">' + esc(T('Classes this fixture uses')) + '</caption><thead><tr><th scope="col">' + esc(T('Class')) + '</th><th scope="col">' + esc(T('Owner')) + '</th><th scope="col" class="ds-num">' + esc(T('Rules')) + '</th></tr></thead><tbody>'
      + f.classes.map(function (x) {
        var own = OWNER_LABEL[x.owner] ? '<span>' + esc(T(OWNER_LABEL[x.owner])) + '</span>' : code(x.owner);
        return '<tr><td>' + code(x.name) + '</td><td>' + own + '</td><td class="ds-num">' + esc(num(x.rules)) + '</td></tr>';
      }).join('') + '</tbody></table>';
    return sectionHead('Where this specimen comes from', K.evChip('MEASURED'))
      + K.kv('Render function', code(c.symbol))
      + K.kv('Fixture', code(f.id))
      + K.kv('Fixture sha256', '<span class="lab-hash" dir="ltr">' + esc(f.sha256) + '</span>')
      + K.kv('Golden snapshot sha256', '<span class="lab-hash" dir="ltr">' + esc(f.goldenSha256) + '</span>')
      + K.kv('Size', esc(tf('%d bytes', f.bytes)) + ' · ' + esc(countText(f.elements, 'element', 'elements')) + ' · ' + esc(tf('depth %d', f.depth)))
      + sectionHead('The call', K.evChip('RECORDED'))
      + '<pre class="lab-call" dir="ltr" data-no-i18n>' + esc(f.call) + '</pre>'
      + '<div class="ds-note">' + esc(T('The inputs are the fixed ones in the Storybook case file. The markup is what the production function returned for them.')) + '</div>'
      + sectionHead('Stage', K.evChip('RECORDED'))
      + K.kv('Surface', esc(T('The room’s dark surface, with production’s own stylesheet')))
      + K.kv('Column', esc(T('One column, 640px at most')))
      + K.kv('After render', code('data-mc-width') + ' ' + code('data-lg-size'))
      + '<div class="ds-note">' + esc(T('Production applies these two attributes after it draws, through the CSSOM, because its security policy forbids inline styles. The stage does the same.')) + '</div>'
      + '<div class="lab-ih">' + esc(T('Classes this fixture uses')) + '</div>' + classes
      + mq;
  }

  function paneSource(c) {
    var srcs = (S.pv.sources || []).map(function (s) {
      return '<li><span class="lab-src-l">' + esc(T(s.label)) + '</span>' + code(s.path) + '<span class="lab-hash" dir="ltr">' + esc(s.sha256) + '</span></li>';
    }).join('');
    return sectionHead('Render function', K.evChip('MEASURED'))
      + K.kv('File', code(c.source.js.file)) + K.kv('Symbol', code(c.source.js.symbol))
      + K.kv('Slice sha256', '<span class="lab-hash" dir="ltr">' + esc(c.source.js.sha256) + '</span>') + K.kv('Size', esc(tf('%d bytes', c.source.js.bytes)))
      + '<div class="ds-note">' + esc(T('Only a hash of the function is shown. The Lab never shows or runs the source.')) + '</div>'
      + '<div class="lab-ih">' + esc(T('CSS slices')) + '</div>'
      + c.source.css.map(function (x) {
        return '<div class="lab-slice">' + K.kv('File', code(x.file)) + K.kv('Rules', esc(num(x.rules))) + K.kv('Slice sha256', '<span class="lab-hash" dir="ltr">' + esc(x.sha256) + '</span>') + '</div>';
      }).join('')
      + '<div class="lab-ih">' + esc(T('Everything this preview was built from')) + '</div><ul class="lab-srcs">' + srcs + '</ul>'
      + '<div class="ds-note">' + esc(T('A change to the render function or its CSS changes a hash here, and the build refuses the stale manifest.')) + '</div>';
  }

  function paneSanitization(c, f) {
    var pol = S.pv.policy, lim = pol.limits;
    var chk = S.check && S.check.id === f.id ? S.check : null;
    var rows = f.neutralised.length ? '<ul class="lab-neutral">' + f.neutralised.map(function (n) {
      return '<li><div class="lab-neutral-h">' + code(n.code) + ' <span class="lab-n">' + esc(num(n.count)) + '</span> <span class="lab-dim">' + esc(T(NEUTRAL_ACTION[n.action] || n.action)) + '</span></div>'
        + '<div class="lab-dim">' + esc(T(NEUTRAL_WHY[n.code] || '')) + '</div></li>';
    }).join('') + '</ul>' : '<p class="lab-p lab-dim">' + esc(T('Nothing had to be removed from this fixture.')) + '</p>';
    var verdict = chk ? (chk.ok ? 'Passed in this browser' : 'Refused in this browser') : 'Not checked';
    return sectionHead('Checked three times', K.evChip('MEASURED'))
      + K.kv('Build', esc(T('Passed')))
      + K.kv('Server', esc(T('Passed')))
      + K.kv('This browser', esc(T(verdict)) + (chk && chk.stats ? ' · ' + esc(countText(chk.stats.nodes, 'node', 'nodes')) : ''))
      + '<div class="lab-ih">' + esc(T('Neutralised for embedding')) + '</div>' + rows
      + '<div class="lab-ih">' + esc(T('Limits')) + '</div>'
      + K.kv('Nodes', esc(num(f.nodes)) + ' / ' + esc(num(lim.nodes)))
      + K.kv('Depth', esc(num(f.depth)) + ' / ' + esc(num(lim.depth)))
      + K.kv('Bytes', esc(num(f.bytes)) + ' / ' + esc(num(lim.bytes)))
      + '<div class="lab-ih">' + esc(T('Tags this fixture uses')) + '</div><div class="lab-tags">' + f.tags.map(function (t) { return code(t); }).join(' ') + '</div>'
      + '<div class="ds-note">' + esc(tf('The allowlist has %d tags. Anything else, any event attribute, any URL that is not a small image, and any unapproved class makes the whole fixture invalid.', Object.keys(pol.tags).length)) + '</div>';
  }

  function paneVariants(c) {
    if (!c.variants.length) return sectionHead('Verified variants', niChip()) + notInstrumented('This component declares no variants.');
    return sectionHead('Verified variants', K.evChip('MEASURED'))
      + '<ul class="lab-vars">' + c.variants.map(function (v) {
        var by = v.exercisedBy.map(function (id) {
          var fx = c.fixtures.filter(function (x) { return x.id === id; })[0];
          return '<button type="button" class="lab-link" data-lab-fx-go="' + esc(id) + '"><span data-no-i18n>' + esc(fx ? fx.label : id) + '</span></button>';
        }).join(' ');
        return '<li class="lab-var"><div class="lab-var-h">' + code(v.class) + ' <span class="lab-dim">' + esc(countText(v.rules, 'rule', 'rules')) + '</span></div>'
          + (v.exercisedBy.length ? '<div class="lab-var-b">' + by + '</div>' : '<div class="lab-dim">' + esc(T('No fixture shows this variant.')) + '</div>') + '</li>';
      }).join('') + '</ul>'
      + '<div class="ds-note">' + esc(T('A variant is listed only if it has a CSS rule. It is shown only through a fixture that carries its class.')) + '</div>';
  }

  function inspectorHtml() {
    if (S.error || !S.comps) return '';
    if (!S.sel) return overviewHtml();
    var sum = S.byId[S.sel], a = S.avail[S.sel];
    if (!a || a.state !== 'preview') return unavailableHtml(sum, a || { reason: 'css-only' });
    var c = current();
    if (!c) return S.detailError[S.sel] ? '<div class="lab-ibody"><div class="lab-pane">' + K.emptyState('The fixtures could not be read', T(S.detailError[S.sel])) + '</div></div>' : '<div class="lab-ibody"><div class="lab-pane">' + K.skeleton(6, 'row') + '</div></div>';
    var f = curFixture() || c.fixtures[0];
    var head = '<div class="lab-ihead"><div class="lab-ikind"><span>' + esc(T(kindLabel(sum.kind))) + '</span><span class="lab-tier">' + esc(T(tierLabel(sum.tier))) + '</span></div>'
      + '<h2 class="lab-ititle" id="lab-ititle" tabindex="-1" data-no-i18n>' + esc(sum.name) + '</h2>'
      + '<div class="lab-isub">' + esc(sum.summary ? T(sum.summary) : '') + '</div></div>';
    var tabs = '<div class="lab-tabs" role="tablist" aria-label="' + esc(T('Inspector sections')) + '">' + TABS.map(function (t) {
      var on = S.tab === t[0];
      return '<button type="button" class="lab-tab' + (on ? ' is-on' : '') + '" role="tab" id="lab-itab-' + t[0] + '" aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="lab-ipane" tabindex="' + (on ? '0' : '-1') + '" data-lab-tab="' + t[0] + '">' + esc(T(t[1])) + '</button>';
    }).join('') + '</div>';
    var pane = S.tab === 'source' ? paneSource(c) : S.tab === 'sanitization' ? paneSanitization(c, f) : S.tab === 'variants' ? paneVariants(c) : paneProvenance(c, f);
    return head + tabs + '<div class="lab-ibody"><div class="lab-pane" id="lab-ipane" role="tabpanel" aria-labelledby="lab-itab-' + S.tab + '" tabindex="0">' + pane + '</div></div>';
  }

  function drawInspector() {
    var insp = document.getElementById('lab-insp');
    if (insp) insp.innerHTML = inspectorHtml();
  }

  // ── selection ─────────────────────────────────────────────────────────────

  function select(id, opts) {
    if (!S.byId[id]) return;
    var t0 = now();
    var changed = S.sel !== id;
    S.sel = id;
    if (changed) { S.fixture = null; S.tab = 'provenance'; }
    var a = S.avail[id];
    var go = function () {
      if (S.sel !== id) return;
      drawRail();
      drawBench();
      M.switchMs = Math.round((now() - t0) * 10) / 10;
      var t = document.getElementById('lab-title');
      if (opts && opts.focusTitle && t) t.focus({ preventScroll: true });
      var c = current();
      if (a && a.state === 'preview' && c) live(S.byId[id].name + ' · ' + tf('Fixture %d of %d', fixtureIndex(c) + 1, c.fixtures.length));
      else live(S.byId[id].name + ' · ' + T('Not previewable'));
    };
    if (a && a.state === 'preview' && !S.detail[id]) {
      drawRail(); drawBench();           // the plate and the inspector show a skeleton meanwhile
      loadDetail(id).then(go);
    } else go();
  }

  // ── events ────────────────────────────────────────────────────────────────

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest) return;
    var q = t.closest('[data-lab-id]');
    if (q) { select(q.getAttribute('data-lab-id'), { focusTitle: true }); return; }
    q = t.closest('[data-lab-grp]');
    if (q) { var g = q.getAttribute('data-lab-grp'); S.open[g] = !(q.getAttribute('aria-expanded') === 'true'); drawRail(); var again = R.host.querySelector('[data-lab-grp="' + g + '"]'); if (again) again.focus(); return; }
    q = t.closest('[data-lab-fx]');
    if (q) { showFixture(q.getAttribute('data-lab-fx'), { focus: true }); return; }
    q = t.closest('[data-lab-fx-go]');
    if (q) { showFixture(q.getAttribute('data-lab-fx-go'), { focus: false }); return; }
    q = t.closest('[data-lab-dir]');
    if (q) { setDir(q.getAttribute('data-lab-dir')); return; }
    q = t.closest('[data-lab-zoom]');
    if (q) { zoomAction(q.getAttribute('data-lab-zoom')); return; }
    q = t.closest('[data-lab-tab]');
    if (q) { S.tab = q.getAttribute('data-lab-tab'); drawInspector(); var f = document.getElementById('lab-itab-' + S.tab); if (f) f.focus(); return; }
  }
  function onInput(ev) {
    var t = ev.target;
    if (t && t.id === 'lab-q') { S.q = t.value; drawRail(); }
  }
  function step(list, from, key) {
    var at = list.indexOf(from), n = list.length;
    if (key === 'Home') return 0;
    if (key === 'End') return n - 1;
    var back = key === 'ArrowUp' || key === 'ArrowLeft';
    return (at + (back ? -1 : 1) + n) % n;
  }
  function onKey(ev) {
    var t = ev.target;
    if (t && t.id === 'lab-q') {
      if (ev.key === 'Escape' && S.q) { ev.preventDefault(); S.q = ''; t.value = ''; drawRail(); }
      else if (ev.key === 'ArrowDown') { var first = R.host.querySelector('#lab-rail-body button[tabindex="0"]'); if (first) { ev.preventDefault(); first.focus(); } }
      return;
    }
    var inRail = t && t.closest && t.closest('#lab-rail-body');
    if (inRail && ['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(ev.key) >= 0) {
      var list = railButtons(), next = list[step(list, t, ev.key)];
      if (next) { ev.preventDefault(); list.forEach(function (b) { b.setAttribute('tabindex', b === next ? '0' : '-1'); }); next.focus(); }
      return;
    }
    var fx = t && t.closest ? t.closest('[role="tab"][data-lab-fx]') : null;
    if (fx && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(ev.key) >= 0) {
      var tabs = [].slice.call(fx.parentNode.querySelectorAll('[role="tab"]')), at = tabs.indexOf(fx);
      var s = (ev.key === 'ArrowRight') === !rtl() ? 1 : -1;
      var to = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (at + s + tabs.length) % tabs.length;
      ev.preventDefault(); showFixture(tabs[to].getAttribute('data-lab-fx'), { focus: true });
      return;
    }
    var it = t && t.closest ? t.closest('[role="tab"][data-lab-tab]') : null;
    if (it && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(ev.key) >= 0) {
      var itabs = [].slice.call(it.parentNode.querySelectorAll('[role="tab"]')), ia = itabs.indexOf(it);
      var is = (ev.key === 'ArrowRight') === !rtl() ? 1 : -1;
      var ito = ev.key === 'Home' ? 0 : ev.key === 'End' ? itabs.length - 1 : (ia + is + itabs.length) % itabs.length;
      ev.preventDefault(); S.tab = itabs[ito].getAttribute('data-lab-tab'); drawInspector(); var nt = document.getElementById('lab-itab-' + S.tab); if (nt) nt.focus();
    }
  }
  function bind(target, type, fn) { target.addEventListener(type, fn); R.bound.push([target, type, fn]); }
  function unbind() { R.bound.forEach(function (b) { b[0].removeEventListener(b[1], b[2]); }); R.bound = []; }

  // ── focus survives a repaint of the room ──────────────────────────────────
  //
  // The room redraws its whole shell when something it was waiting for arrives (a
  // language catalogue, the overview), and mounts the Lab again into the new host.
  // That happens within moments of opening and, on a slow machine, can land while the
  // reader is already typing. The Lab remembers what had focus for a few seconds and
  // puts it back; after that a remount is a visit, and nothing is focused for it.

  var FOCUS_MS = 2500;
  function focusKey(el) {
    if (!el || !el.getAttribute) return null;
    if (el.id === 'lab-q') return 'q';
    var m = [['data-lab-id', 'i'], ['data-lab-grp', 'g'], ['data-lab-fx', 'f'], ['data-lab-tab', 't'], ['data-lab-dir', 'd'], ['data-lab-zoom', 'z']];
    for (var i = 0; i < m.length; i++) { var v = el.getAttribute(m[i][0]); if (v) return m[i][1] + ':' + v; }
    return null;
  }
  function trackFocus(ev) { var k = focusKey(ev.target); if (k) S.focus = { key: k, at: now() }; }
  function restoreFocus() {
    var f = S.focus;
    if (!f || !R.host || now() - f.at > FOCUS_MS) return;
    var a = document.activeElement;
    if (a && a !== document.body && R.host.contains(a)) return;
    var sel = f.key === 'q' ? '#lab-q' : '[data-lab-' + ({ i: 'id', g: 'grp', f: 'fx', t: 'tab', d: 'dir', z: 'zoom' })[f.key.charAt(0)] + '="' + cssq(f.key.slice(2)) + '"]';
    var el = R.host.querySelector(sel);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (f.key === 'q' && el.setSelectionRange) { var n = (el.value || '').length; el.setSelectionRange(n, n); }
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  function shellHtml() {
    return '<div class="lab">'
      + '<div class="lab-bar"><label class="lab-search"><span class="ds-sr">' + esc(T('Search components')) + '</span>'
      + '<input class="ds-input lab-q" id="lab-q" type="search" autocomplete="off" spellcheck="false" value="' + esc(S.q) + '" placeholder="' + esc(T('Search by name, symbol or reason')) + '" aria-keyshortcuts="/">'
      + '<kbd class="lab-kbd" aria-hidden="true">/</kbd></label>'
      + '<span class="lab-count" id="lab-count" role="status" aria-live="polite"></span></div>'
      + '<div class="lab-main">'
      + '<nav class="lab-rail" aria-label="' + esc(T('Components')) + '"><div class="lab-rail-body" id="lab-rail-body"></div></nav>'
      + '<section class="lab-bench" id="lab-bench" aria-label="' + esc(T('Preview stage')) + '"></section>'
      + '<aside class="lab-insp" id="lab-insp" aria-label="' + esc(T('Component inspector')) + '"></aside>'
      + '</div><div class="ds-sr" id="lab-live" aria-live="polite" aria-atomic="true"></div></div>';
  }

  function drawAll() { drawRail(); drawBench(); if (!S.sel) drawInspector(); }

  function firstPreviewId() {
    if (!S.comps) return null;
    var ids = allIds();
    for (var i = 0; i < ids.length; i++) if (S.avail[ids[i]] && S.avail[ids[i]].state === 'preview') return ids[i];
    return null;
  }

  function mount(host, kit) {
    K = kit; Z = window.FamilistaLabSanitize; V = window.FamilistaLabView;
    unbind();
    R.host = host;
    if (!Z || !V) { host.innerHTML = K.emptyState('The Specimen Lab could not be loaded', T('Reload the page and try again.')); return; }
    host.innerHTML = shellHtml();
    R.root = host.querySelector('.lab');
    bind(host, 'click', onClick);
    bind(host, 'input', onInput);
    bind(host, 'keydown', onKey);
    bind(host, 'focusin', trackFocus);
    bind(document, 'keydown', function (ev) {
      // "/" jumps to the search, as long as the reader is not already typing.
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var a = document.activeElement, tag = a && a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
      var q = document.getElementById('lab-q'); if (q && R.host && R.host.contains(q)) { ev.preventDefault(); q.focus(); q.select(); }
    });
    bind(document, 'keydown', function (ev) {
      // "[" and "]" step through the fixtures of the chosen component.
      if ((ev.key !== '[' && ev.key !== ']') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var a = document.activeElement, tag = a && a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
      var c = current(); if (!c || !R.host || !R.host.contains(document.getElementById('lab-bench'))) return;
      var at = fixtureIndex(c); if (at < 0) return;
      ev.preventDefault(); showFixture(c.fixtures[(at + (ev.key === ']' ? 1 : -1) + c.fixtures.length) % c.fixtures.length].id, { focus: false });
    });
    bind(document, 'keydown', function (ev) {
      // Zoom: "-" and "=" (or "+"), "0" for 100%, "F" to fit. Never with Ctrl, Cmd or Alt: those
      // are the browser's own zoom and stay the reader's. Never while the reader is typing.
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var act = ({ '-': 'out', '_': 'out', '=': 'in', '+': 'in', '0': 'reset', f: 'fit', F: 'fit' })[ev.key];
      if (!act) return;
      var a = document.activeElement, tag = a && a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
      if (!R.host || !zoomable()) return;
      ev.preventDefault(); zoomAction(act);
    });
    if (S.comps) { drawAll(); restoreFocus(); if (S.sel && !S.detail[S.sel]) loadDetail(S.sel).then(function () { if (R.root) { drawRail(); drawBench(); restoreFocus(); } }); return; }
    drawRail(); drawBench(); drawInspector();
    loadIndexes().then(function () {
      if (!R.root || R.host !== host) return;
      var first = S.error ? null : firstPreviewId();
      if (first) { S.sel = first; S.fixture = null; }
      drawRail(); drawBench(); restoreFocus();
      if (S.sel && !S.detail[S.sel]) loadDetail(S.sel).then(function () { if (R.root) { drawRail(); drawBench(); restoreFocus(); live(tf('%d of %d components', S.pv.coverage.previewable, S.pv.coverage.registered) + ' · ' + T('previewable')); } });
      else if (!S.sel) drawInspector();
    });
  }
  function unmount() {
    unbind();
    stopObserving();
    R.root = null; R.host = null;
  }
  /** Forget everything read from the server (the room's Refresh). */
  function reset() { unbind(); stopObserving(); var keep = { dir: S.dir, zoom: S.zoom, fit: S.fit }; S = fresh(); S.dir = keep.dir; S.zoom = keep.zoom; S.fit = keep.fit; }

  window.FamilistaDesignLab = { mount: mount, unmount: unmount, reset: reset };

  // Figures the page itself produced, for the test suite and the performance record. Nothing else.
  window.__familistaLabMetrics = function () {
    var spec = document.getElementById('lab-specimen');
    return { loadMs: M.loadMs, renderMs: M.renderMs, switchMs: M.switchMs, specimenNodes: spec ? spec.getElementsByTagName('*').length : 0, components: M.components, fixtures: M.fixtures, selected: S.sel, fixture: S.fixture, dir: S.dir, zoom: S.zoom, fit: S.fit, zoomMs: M.zoomMs };
  };
}());
