/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — Slice 1a — the editor

   The platform owner's design tool: an infinite canvas of freely positioned
   frames, with rectangles and text drawn inside them, moved and resized with the
   mouse or the keyboard, styled from the design tokens, undone and redone, saved
   in this browser and exchanged as a validated JSON file.

   Loaded on demand by public/app.js for a reader whom GET /system/whoami names
   the platform owner (the same check Design System Control uses), after
   studio-core.js. It asks the server for nothing: no route, no write, no data.

   HOW IT DRAWS

   · Every frame is its own document: an <iframe> with no src (about:blank) and
     sandbox="allow-same-origin" and nothing else, so no script can ever run in
     it, and the page's Content-Security-Policy is inherited unchanged. Media
     queries inside a frame answer to the frame's own width, as they will in
     production. The editor writes into it from here; it never receives events.
   · Nothing is written as markup. Elements are built with createElement, text is
     set with textContent, and every style goes through the CSSOM
     (style.setProperty), which the policy allows and inline style attributes
     are not. Colours, radii and type are var(--fam-*) references to names on
     the core's closed token lists.
   · Pointer input lands on the canvas element only (frames ignore the pointer),
     and is resolved against the document's own geometry, so a drag is exact at
     any zoom: the canvas moves by the screen distance divided by the zoom,
     rounded to whole pixels.
   · A change repaints the node it changed. A drag repaints one element and the
     selection box on each animation frame and records one undo step at the end.

   This room keeps its own English, German and Arabic catalogue behind
   `data-no-i18n`, like every owner room. Token names, ids and numbers are
   identifiers and are never translated; what a person typed is data.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var C = window.FamilistaStudioCore;
  var LIMITS = C.LIMITS;
  var STORE_KEY = 'familista_design_studio_document';
  var STORE_UNREADABLE = 'familista_design_studio_document_unreadable';
  var LOCALE_KEY = 'familista_design_studio_locale';
  var DRAG_THRESHOLD = 3;
  var SVG = 'http://www.w3.org/2000/svg';

  // ── language ──────────────────────────────────────────────────────────────

  var LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var DICT = {};
  var LANG = 'en';
  var DIR = 'ltr';
  var SEEN = {};

  function localeOf(tag) {
    for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i][0] === tag) return LOCALES[i];
    return LOCALES[0];
  }
  function initialLocale() {
    try { var v = localStorage.getItem(LOCALE_KEY); if (v && localeOf(v)[0] === v) return v; } catch (_) {}
    return 'en';
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    LANG = l[0]; DIR = l[2];
    try { localStorage.setItem(LOCALE_KEY, LANG); } catch (_) {}
    if (LANG === 'en') { DICT = {}; return Promise.resolve(); }
    return fetch('/design-studio/i18n/' + LANG + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { DICT = d && typeof d === 'object' ? d : {}; })
      .catch(function () { DICT = {}; });
  }
  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s) return s;
    SEEN[s] = 1;
    if (LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(DICT, s) ? DICT[s] : s;
  }
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(LANG); } catch (_) { return String(n); }
  }
  /** A sentence with numbers or names in it: %d takes a number, %s a name, in order. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1), i = 0;
    return T(key).replace(/%[ds]/g, function (m) { var v = args[i++]; return m === '%d' ? num(v) : String(v == null ? '' : v); });
  }

  // ── DOM helpers: no markup strings, ever ──────────────────────────────────

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i] != null) el.appendChild(typeof kids[i] === 'string' ? document.createTextNode(kids[i]) : kids[i]);
    return el;
  }
  var ICONS = {
    select: 'M5 3l14 8-6.5 1.5L9 19z',
    hand: 'M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v7c0 4-2.6 7-6.5 7S5.3 17.5 4.2 14.6L3 11.4a1.5 1.5 0 0 1 2.6-1.4L8 12.5',
    frame: 'M8 3v18M16 3v18M3 8h18M3 16h18',
    rect: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    text: 'M5 7V4h14v3M12 4v16M9 20h6',
    undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    minus: 'M5 12h14',
    plus: 'M12 5v14M5 12h14',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    import: 'M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
    export: 'M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
    duplicate: 'M9 9h11v11H9zM5 15H4V4h11v1',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    back: 'M15 18l-6-6 6-6',
    mark: 'M12 19l7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  };
  function icon(name) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONS[name]);
    s.appendChild(p);
    return s;
  }
  /** One CSSOM write, skipped when the value is already there. */
  function css(el, prop, value) {
    var c = el.__stc || (el.__stc = {});
    if (c[prop] === value) return;
    c[prop] = value;
    if (value === '') el.style.removeProperty(prop); else el.style.setProperty(prop, value);
  }
  /** A token reference, but only for a name on the core's list for that role. */
  function tokenVar(list, name) { return list.indexOf(name) !== -1 ? 'var(--fam-' + name + ')' : ''; }
  function isField(t) {
    if (!t || t.nodeType !== 1) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  var S = null;
  function fresh(host) {
    return {
      host: host, el: {}, doc: null, hist: C.createHistory(), cam: { x: 80, y: 80, z: 1 }, tool: 'select',
      sel: null, hover: null, frames: {}, drag: null, raf: 0, pending: null, space: false, editing: null,
      saveTimer: 0, saveState: 'saved', view: { w: 0, h: 0 }, ro: null, off: [], announced: '', sayTimer: 0,
      metrics: { mounts: 0, moves: 0, moveMs: [], commits: 0, nodePaints: 0, lastSaveBytes: 0 },
    };
  }
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    S.off.push(function () { target.removeEventListener(type, fn, opts); });
  }

  // ── announcements ─────────────────────────────────────────────────────────

  function say(text) {
    if (!S || !S.el.live) return;
    S.announced = text;
    var live = S.el.live;
    live.textContent = '';
    clearTimeout(S.sayTimer);
    S.sayTimer = setTimeout(function () { if (S && S.el.live === live) live.textContent = text; }, 30);
  }
  var TYPE_LABEL = { frame: 'Frame', rect: 'Rectangle', text: 'Text' };
  function nodeName(id) { var l = C.locate(S.doc, id); return l ? l.node.name : ''; }

  // ── persistence: this browser only ────────────────────────────────────────

  function loadStored() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (_) { return { doc: C.createDocument(T('Untitled design')), note: 'unavailable' }; }
    if (!raw) return { doc: C.createDocument(T('Untitled design')), note: '' };
    var r = C.parseDocument(raw);
    if (r.ok) return { doc: r.doc, note: 'restored' };
    try { localStorage.setItem(STORE_UNREADABLE, raw); } catch (_) {}
    return { doc: C.createDocument(T('Untitled design')), note: 'unreadable' };
  }
  function saveNow(announce) {
    if (!S) return false;
    clearTimeout(S.saveTimer); S.saveTimer = 0;
    var ok = false;
    try {
      var text = C.serializeDocument(S.doc);
      var bytes = C.byteLength(text);
      if (bytes > LIMITS.bytes) throw new Error('too-large');
      localStorage.setItem(STORE_KEY, text);
      S.metrics.lastSaveBytes = bytes;
      ok = true;
    } catch (_) { ok = false; }
    setSaveState(ok ? 'saved' : 'failed');
    if (announce) say(ok ? T('Saved in this browser.') : T('Not saved: this browser’s storage is unavailable.'));
    return ok;
  }
  function scheduleSave() {
    if (!S) return;
    setSaveState('saving');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(function () { saveNow(false); }, 400);
  }
  function setSaveState(state) {
    if (!S) return;
    S.saveState = state;
    if (!S.el.save) return;
    S.el.save.textContent = state === 'saved' ? T('Saved in this browser') : state === 'saving' ? T('Saving…') : T('Not saved');
    S.el.save.setAttribute('data-state', state);
  }

  // ── changing the document ─────────────────────────────────────────────────

  /** Apply one operation through the history, repaint, save. Returns the entry or null. */
  function run(op, label) {
    var e;
    try { e = C.commit(S.doc, S.hist, op, label); } catch (err) { say(problemText(err && err.code)); return null; }
    S.metrics.commits++;
    afterChange();
    return e;
  }
  function afterChange() {
    if (S.sel && !C.locate(S.doc, S.sel)) S.sel = null;
    if (S.hover && !C.locate(S.doc, S.hover)) S.hover = null;
    paintAll();
    scheduleSave();
  }
  function doUndo() {
    var e = C.undo(S.doc, S.hist);
    if (!e) { say(T('Nothing to undo.')); return; }
    afterChange();
    say(tf('Undone: %s', e.label));
  }
  function doRedo() {
    var e = C.redo(S.doc, S.hist);
    if (!e) { say(T('Nothing to redo.')); return; }
    afterChange();
    say(tf('Redone: %s', e.label));
  }

  var PROBLEM = {
    'too-large': 'The file is larger than 1 MB.',
    'not-json': 'The file is not valid JSON.',
    'not-object': 'The file is not a Familista design.',
    'format': 'The file is not a Familista design.',
    'version': 'The file was made by a version of the Studio this one cannot read.',
    'unknown-field': 'The design contains a field the Studio does not know.',
    'missing-field': 'The design is missing a required field.',
    'bad-id': 'The design contains an invalid element id.',
    'duplicate-id': 'The design uses the same element id twice.',
    'bad-type': 'The design contains an element of an unknown type.',
    'bad-name': 'A name is empty, too long or contains control characters.',
    'bad-number': 'A position is not a whole number inside the canvas.',
    'bad-size': 'A size is not a whole number between 1 and 20,000.',
    'bad-text': 'A text is too long or contains control characters.',
    'bad-token': 'A colour, radius or text style is not one of the design tokens.',
    'bad-children': 'The design’s frames or elements are not a list.',
    'too-many-frames': 'The design has more than 50 frames.',
    'too-many-nodes': 'The design has more than 2,000 elements.',
  };
  function problemText(code) { return T(PROBLEM[code] || 'That change could not be made.'); }

  // ── frames: one sandboxed document each ───────────────────────────────────

  function tokenSheetHref() {
    var l = document.querySelector('link[rel="stylesheet"][href*="/tokens/familista-tokens.css"]');
    return l ? l.getAttribute('href') : '/tokens/familista-tokens.css';
  }
  function frameSheetHref() {
    var s = document.querySelector('script[src*="/design-studio/studio.js"]');
    var v = s ? /\?v=([A-Za-z0-9._-]+)/.exec(s.getAttribute('src') || '') : null;
    return '/design-studio/studio-frame.css' + (v ? '?v=' + v[1] : '');
  }
  function fontSheetHref() {
    var l = document.querySelector('link[rel="stylesheet"][href^="https://fonts.googleapis.com/css2"]');
    return l ? l.getAttribute('href') : null;
  }
  function makeFrameView(f, before) {
    var box = h('div', { class: 'st-frame', 'data-st-frame': f.id });
    var ifr = h('iframe', { class: 'st-frame-doc', sandbox: 'allow-same-origin', title: f.name, 'aria-hidden': 'true', tabindex: '-1' });
    box.appendChild(ifr);
    S.el.world.insertBefore(box, before || null);
    var fd = ifr.contentDocument;
    var head = fd.head || fd.documentElement.appendChild(fd.createElement('head'));
    var hrefs = [tokenSheetHref(), frameSheetHref(), fontSheetHref()];
    for (var i = 0; i < hrefs.length; i++) {
      if (!hrefs[i]) continue;
      var link = fd.createElement('link');
      link.rel = 'stylesheet';
      link.href = hrefs[i];
      head.appendChild(link);
    }
    var body = fd.body || fd.documentElement.appendChild(fd.createElement('body'));
    var rootEl = fd.createElement('div');
    rootEl.className = 'st-root';
    body.appendChild(rootEl);
    return { id: f.id, box: box, ifr: ifr, fd: fd, root: rootEl, nodes: {} };
  }
  function paintElement(fv, n, g) {
    var el = fv.nodes[n.id];
    if (!el) {
      el = fv.fd.createElement('div');
      el.className = 'st-el st-' + n.type;
      el.setAttribute('data-st-id', n.id);
      fv.nodes[n.id] = el;
    }
    S.metrics.nodePaints++;
    css(el, 'left', g.x + 'px'); css(el, 'top', g.y + 'px');
    css(el, 'width', g.w + 'px'); css(el, 'height', g.h + 'px');
    if (n.type === 'rect') {
      css(el, 'background', tokenVar(C.TOKENS.fill, n.fill));
      css(el, 'border-radius', n.radius ? tokenVar(C.TOKENS.radius, n.radius) : '0');
    } else {
      if (el.__stText !== n.text) { el.textContent = n.text; el.__stText = n.text; }
      var ts = C.TEXT_STYLES[n.style] || C.TEXT_STYLES.body;
      css(el, 'color', tokenVar(C.TOKENS.color, n.color));
      css(el, 'font-size', 'var(--fam-' + ts.size + ')');
      css(el, 'font-weight', 'var(--fam-' + ts.weight + ')');
      css(el, 'line-height', 'var(--fam-' + ts.lineHeight + ')');
    }
    return el;
  }
  /** Bring every frame and element on screen into line with the document, writing only what changed. */
  function paintWorld() {
    var seen = {}, prevBox = null;
    for (var i = 0; i < S.doc.frames.length; i++) {
      var f = S.doc.frames[i];
      seen[f.id] = 1;
      var fv = S.frames[f.id];
      if (!fv) {
        var next = prevBox ? prevBox.nextSibling : S.el.world.firstChild;
        fv = S.frames[f.id] = makeFrameView(f, next);
      }
      prevBox = fv.box;
      paintFrameBox(fv, f, f);
      var kids = {};
      for (var j = 0; j < f.children.length; j++) {
        var c = f.children[j];
        kids[c.id] = 1;
        var el = paintElement(fv, c, c);
        // Keep the drawing order: an element belongs right after the one before it.
        var want = j === 0 ? fv.root.firstChild : fv.nodes[f.children[j - 1].id].nextSibling;
        if (el.parentNode !== fv.root || (want !== el)) fv.root.insertBefore(el, want);
      }
      for (var id in fv.nodes) if (!kids[id]) { var gone = fv.nodes[id]; if (gone.parentNode) gone.parentNode.removeChild(gone); delete fv.nodes[id]; }
    }
    for (var fid in S.frames) if (!seen[fid]) { var v = S.frames[fid]; if (v.box.parentNode) v.box.parentNode.removeChild(v.box); delete S.frames[fid]; }
  }
  function paintFrameBox(fv, f, g) {
    css(fv.box, 'left', g.x + 'px'); css(fv.box, 'top', g.y + 'px');
    css(fv.box, 'width', g.w + 'px'); css(fv.box, 'height', g.h + 'px');
    css(fv.root, 'background', tokenVar(C.TOKENS.fill, f.fill));
    if (fv.ifr.getAttribute('title') !== f.name) fv.ifr.setAttribute('title', f.name);
  }
  /** During a drag: the one node under the pointer, at a geometry the document does not hold yet. */
  function preview(id, g) {
    var l = C.locate(S.doc, id);
    if (!l) return;
    if (!l.frame) paintFrameBox(S.frames[id], l.node, g);
    else paintElement(S.frames[l.frame.id], l.node, g);
    paintOverlay(id, g);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  function applyCamera() {
    var c = S.cam;
    css(S.el.world, 'transform', 'translate(' + c.x + 'px, ' + c.y + 'px) scale(' + c.z + ')');
    var grid = 24 * c.z;
    css(S.el.canvas, 'background-size', grid + 'px ' + grid + 'px');
    css(S.el.canvas, 'background-position', c.x + 'px ' + c.y + 'px');
    if (S.el.zoomLabel) {
      S.el.zoomLabel.textContent = pctText(c.z);
      S.el.zoomLabel.setAttribute('aria-label', tf('Zoom %s. Select to reset to 100%.', pctText(c.z)));
    }
    if (S.el.zoomOut) S.el.zoomOut.disabled = c.z <= C.ZOOM.min + 1e-6;
    if (S.el.zoomIn) S.el.zoomIn.disabled = c.z >= C.ZOOM.max - 1e-6;
    paintOverlay();
  }
  function pctText(z) { return num(Math.round(z * 100)) + '%'; }
  function centre() { return { x: S.view.w / 2, y: S.view.h / 2 }; }
  function zoomTo(z, at) {
    var before = S.cam.z;
    S.cam = C.zoomAt(S.cam, z, at || centre());
    applyCamera();
    if (S.cam.z !== before) say(tf('Zoom %s', pctText(S.cam.z)));
  }
  function fit(silent) {
    S.cam = C.fitCamera(C.bounds(S.doc), S.view.w, S.view.h, 48);
    applyCamera();
    if (!silent) say(tf('Zoom %s', pctText(S.cam.z)));
  }

  // ── overlay: selection, handles, frame names, hover, rubber band ──────────

  function screenRect(r) {
    var a = C.toScreen(S.cam, { x: r.x, y: r.y });
    return { x: a.x, y: a.y, w: r.w * S.cam.z, h: r.h * S.cam.z };
  }
  function place(el, r) {
    css(el, 'left', r.x + 'px'); css(el, 'top', r.y + 'px');
    css(el, 'width', Math.max(0, r.w) + 'px'); css(el, 'height', Math.max(0, r.h) + 'px');
  }
  /** `pid`/`pg`: a node shown at a preview geometry (its own frame-relative geometry). */
  function paintOverlay(pid, pg) {
    if (!S.el.overlay) return;
    var doc = S.doc;
    function rectOf(id) {
      var r = C.worldRect(doc, id);
      if (!r) return null;
      if (id === pid && pg) {
        var l = C.locate(doc, id);
        r = l.frame ? { x: l.frame.x + pg.x, y: l.frame.y + pg.y, w: pg.w, h: pg.h } : { x: pg.x, y: pg.y, w: pg.w, h: pg.h };
      } else if (pid && pg) {
        // A frame being dragged carries its children with it.
        var lp = C.locate(doc, pid), lc = C.locate(doc, id);
        if (lp && !lp.frame && lc && lc.frame && lc.frame.id === pid) r = { x: pg.x + lc.node.x, y: pg.y + lc.node.y, w: r.w, h: r.h };
      }
      return r;
    }
    // frame names
    var labels = S.el.labels, have = {};
    for (var i = 0; i < doc.frames.length; i++) {
      var f = doc.frames[i];
      have[f.id] = 1;
      var lab = labels.querySelector('[data-st-label="' + f.id + '"]');
      if (!lab) { lab = h('div', { class: 'st-flabel', 'data-st-label': f.id }); labels.appendChild(lab); }
      if (lab.textContent !== f.name) lab.textContent = f.name;
      var fr = screenRect(rectOf(f.id));
      css(lab, 'left', fr.x + 'px'); css(lab, 'top', fr.y + 'px'); css(lab, 'max-width', Math.max(40, fr.w) + 'px');
      lab.classList.toggle('is-selected', S.sel === f.id);
    }
    var all = labels.querySelectorAll('[data-st-label]');
    for (var j = 0; j < all.length; j++) if (!have[all[j].getAttribute('data-st-label')]) labels.removeChild(all[j]);
    // selection
    var sr = S.sel ? rectOf(S.sel) : null;
    S.el.sel.hidden = !sr || !!S.editing;
    if (sr) place(S.el.sel, screenRect(sr));
    // hover
    var hr = S.hover && S.hover !== S.sel && !S.drag ? rectOf(S.hover) : null;
    S.el.hover.hidden = !hr;
    if (hr) place(S.el.hover, screenRect(hr));
  }

  // ── selection and the properties panel ────────────────────────────────────

  function select(id, quiet) {
    var changed = S.sel !== id;
    S.sel = id;
    paintOverlay();
    if (changed) paintPanel();
    if (changed && !quiet) {
      if (id) {
        var l = C.locate(S.doc, id), n = l.node;
        say(tf('%s selected: %s, %d by %d at %d, %d', T(TYPE_LABEL[n.type]), n.name, n.w, n.h, n.x, n.y));
      } else say(T('Selection cleared.'));
    }
  }
  function setTool(tool, quiet) {
    S.tool = tool;
    var bs = S.el.tools ? S.el.tools.querySelectorAll('[data-st-tool]') : [];
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', bs[i].getAttribute('data-st-tool') === tool ? 'true' : 'false');
    S.el.canvas.classList.toggle('is-draw', tool === 'frame' || tool === 'rect' || tool === 'text');
    S.el.canvas.classList.toggle('is-hand', tool === 'hand');
    if (!quiet) say(tf('%s tool', T(TOOL_LABEL[tool])));
  }
  var TOOL_LABEL = { select: 'Select', hand: 'Hand', frame: 'Frame', rect: 'Rectangle', text: 'Text' };

  function field(label, input) {
    if (input.tagName === 'INPUT') backToCanvas(input);
    return h('label', { class: 'st-field' }, [h('span', { class: 'st-field-label', text: label }), input]);
  }
  /** Enter commits a field and gives the keyboard back to the canvas; Escape puts the value back first. */
  function backToCanvas(input) {
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && S.sel) {
        var n = C.locate(S.doc, S.sel).node, k = input.getAttribute('data-st-prop');
        input.value = n[k] == null ? '' : String(n[k]);
      }
      try { S.el.canvas.focus({ preventScroll: true }); } catch (_) {}
    });
  }
  function numberInput(key, value, min, max) {
    var inp = h('input', { class: 'st-input st-input--num', type: 'number', inputmode: 'numeric', step: '1', min: String(min), max: String(max), 'data-st-prop': key });
    inp.value = String(value);
    inp.addEventListener('change', function () {
      var v = Number(inp.value);
      if (!S.sel) return;
      var n = C.locate(S.doc, S.sel).node;
      if (!(isFinite(v) && Math.floor(v) === v && v >= min && v <= max)) {
        inp.value = String(n[key]);
        say(key === 'w' || key === 'h' ? T('Enter a whole number between 1 and 20,000.') : T('Enter a whole number between −100,000 and 100,000.'));
        return;
      }
      if (v === n[key]) return;
      var props = {}; props[key] = v;
      if (run({ kind: 'set', id: S.sel, props: props }, tf('Change %s', n.name))) say(tf('%s: %s set to %d', n.name, key.toUpperCase(), v));
    });
    return inp;
  }
  function tokenSelect(key, list, value, labels, allowNone) {
    var sel = h('select', { class: 'st-input st-select', 'data-st-prop': key });
    if (allowNone) sel.appendChild(h('option', { value: '', text: T('None') }));
    for (var i = 0; i < list.length; i++) sel.appendChild(h('option', { value: list[i], text: labels ? T(labels[list[i]]) : list[i] }));
    sel.value = value == null ? '' : value;
    sel.addEventListener('change', function () {
      if (!S.sel) return;
      var n = C.locate(S.doc, S.sel).node;
      var v = sel.value === '' && allowNone ? null : sel.value;
      if (v === n[key]) return;
      var props = {}; props[key] = v;
      if (run({ kind: 'set', id: S.sel, props: props }, tf('Change %s', n.name))) say(tf('%s: %s', n.name, v == null ? T('None') : (labels ? T(labels[v]) : v)));
    });
    return sel;
  }
  function swatch(list, value) {
    var s = h('span', { class: 'st-swatch', 'aria-hidden': 'true' });
    css(s, 'background', value ? tokenVar(list, value) : '');
    return s;
  }
  var STYLE_LABEL = { display: 'Display', title: 'Title', heading: 'Heading', subheading: 'Subheading', body: 'Body', label: 'Label', caption: 'Caption' };

  function paintPanel() {
    var p = S.el.panel;
    if (!p) return;
    while (p.firstChild) p.removeChild(p.firstChild);
    var sl = S.sel ? C.locate(S.doc, S.sel) : null;
    p.setAttribute('data-st-for', sl ? sl.node.id + ':' + sl.node.type : '');
    if (!S.sel) {
      p.appendChild(h('h2', { class: 'st-panel-title', text: T('Properties') }));
      p.appendChild(h('p', { class: 'st-panel-empty', text: T('Select a frame, rectangle or text to see its properties.') }));
      var keys = [['V', 'Select'], ['H', 'Hand'], ['F', 'Frame'], ['R', 'Rectangle'], ['T', 'Text'], ['Space', 'Pan while held'],
        ['←↑→↓', 'Move 1 px'], ['Shift + ←↑→↓', 'Move 10 px'], ['Alt + ←↑→↓', 'Resize'], ['Ctrl/⌘ + D', 'Duplicate'],
        ['Delete', 'Delete'], ['Ctrl/⌘ + Z', 'Undo'], ['Ctrl/⌘ + Shift + Z', 'Redo'], ['Ctrl/⌘ + S', 'Save']];
      var dl = h('dl', { class: 'st-keys' });
      for (var i = 0; i < keys.length; i++) { dl.appendChild(h('dt', null, [h('kbd', { text: keys[i][0] })])); dl.appendChild(h('dd', { text: T(keys[i][1]) })); }
      p.appendChild(h('h3', { class: 'st-panel-sub', text: T('Keyboard') }));
      p.appendChild(dl);
      return;
    }
    var n = C.locate(S.doc, S.sel).node;
    p.appendChild(h('h2', { class: 'st-panel-title', text: T(TYPE_LABEL[n.type]) }));
    var name = h('input', { class: 'st-input', type: 'text', maxlength: String(LIMITS.name), 'data-st-prop': 'name', 'data-user-content': '' });
    name.value = n.name;
    name.addEventListener('change', function () {
      var cur = S.sel ? C.locate(S.doc, S.sel) : null;
      if (!cur) return;
      var v = name.value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, LIMITS.name);
      if (!v) { name.value = cur.node.name; return; }
      if (v !== cur.node.name && run({ kind: 'set', id: cur.node.id, props: { name: v } }, T('Rename'))) say(tf('Renamed to %s', v));
    });
    p.appendChild(field(T('Name'), name));
    var geo = h('div', { class: 'st-grid' });
    geo.appendChild(field('X', numberInput('x', n.x, -LIMITS.coord, LIMITS.coord)));
    geo.appendChild(field('Y', numberInput('y', n.y, -LIMITS.coord, LIMITS.coord)));
    geo.appendChild(field(T('Width'), numberInput('w', n.w, 1, LIMITS.size)));
    geo.appendChild(field(T('Height'), numberInput('h', n.h, 1, LIMITS.size)));
    p.appendChild(h('h3', { class: 'st-panel-sub', text: T('Position and size') }));
    p.appendChild(geo);
    p.appendChild(h('h3', { class: 'st-panel-sub', text: T('Style') }));
    if (n.type === 'frame' || n.type === 'rect') {
      p.appendChild(field(T('Fill'), h('span', { class: 'st-row' }, [swatch(C.TOKENS.fill, n.fill), tokenSelect('fill', C.TOKENS.fill, n.fill)])));
    }
    if (n.type === 'rect') p.appendChild(field(T('Corner radius'), tokenSelect('radius', C.TOKENS.radius, n.radius, null, true)));
    if (n.type === 'text') {
      p.appendChild(field(T('Text style'), tokenSelect('style', Object.keys(C.TEXT_STYLES), n.style, STYLE_LABEL)));
      p.appendChild(field(T('Colour'), h('span', { class: 'st-row' }, [swatch(C.TOKENS.color, n.color), tokenSelect('color', C.TOKENS.color, n.color)])));
      var edit = h('button', { class: 'st-btn st-btn--wide', type: 'button', 'data-st-act': 'edit-text' }, [icon('edit'), h('span', { text: T('Edit text') })]);
      p.appendChild(edit);
    }
    p.appendChild(h('h3', { class: 'st-panel-sub', text: T('Actions') }));
    p.appendChild(h('div', { class: 'st-actions' }, [
      h('button', { class: 'st-btn', type: 'button', 'data-st-act': 'duplicate' }, [icon('duplicate'), h('span', { text: T('Duplicate') })]),
      h('button', { class: 'st-btn st-btn--danger', type: 'button', 'data-st-act': 'delete' }, [icon('trash'), h('span', { text: T('Delete') })]),
    ]));
  }
  /** After a change that kept the same selection: refresh the panel's values, never the field being typed in. */
  function refreshPanel() {
    if (!S.sel || !S.el.panel) return;
    var n = C.locate(S.doc, S.sel).node;
    if (S.el.panel.getAttribute('data-st-for') !== n.id + ':' + n.type) { paintPanel(); return; }
    var inputs = S.el.panel.querySelectorAll('[data-st-prop]');
    for (var i = 0; i < inputs.length; i++) {
      var k = inputs[i].getAttribute('data-st-prop');
      if (inputs[i] === document.activeElement || !Object.prototype.hasOwnProperty.call(n, k)) continue;
      var v = n[k] == null ? '' : String(n[k]);
      if (inputs[i].value !== v) inputs[i].value = v;
    }
    var sw = S.el.panel.querySelectorAll('.st-swatch');
    for (var j = 0; j < sw.length; j++) {
      var list = n.type === 'text' ? C.TOKENS.color : C.TOKENS.fill;
      css(sw[j], 'background', tokenVar(list, n.type === 'text' ? n.color : n.fill));
    }
  }

  function paintAll() {
    paintWorld();
    paintOverlay();
    refreshPanel();
    if (!S.sel) paintPanelIfStale();
    S.el.undo.disabled = !S.hist.past.length;
    S.el.redo.disabled = !S.hist.future.length;
    S.el.undo.setAttribute('title', S.hist.past.length ? tf('Undo %s', S.hist.past[S.hist.past.length - 1].label) + ' (Ctrl/⌘ + Z)' : T('Undo') + ' (Ctrl/⌘ + Z)');
    S.el.redo.setAttribute('title', S.hist.future.length ? tf('Redo %s', S.hist.future[S.hist.future.length - 1].label) + ' (Ctrl/⌘ + Shift + Z)' : T('Redo') + ' (Ctrl/⌘ + Shift + Z)');
    S.el.empty.hidden = S.doc.frames.length > 0;
    if (S.el.docName && S.el.docName !== document.activeElement && S.el.docName.value !== S.doc.name) S.el.docName.value = S.doc.name;
  }
  function paintPanelIfStale() {
    if (S.el.panel.getAttribute('data-st-for') !== '') paintPanel();
  }

  // ── creating things ───────────────────────────────────────────────────────

  function create(type, frameId, geom, editAfter) {
    var name = C.nextName(S.doc, type, T(TYPE_LABEL[type]));
    var node = C.makeNode(S.doc, type, geom, name, type === 'text' ? { text: T('Text') } : null);
    var e = run(C.insertOp(S.doc, type === 'frame' ? null : frameId, node), tf('Add %s', name));
    if (!e) return null;
    setTool('select', true);
    select(node.id, true);
    say(tf('%s added, %d by %d at %d, %d', name, node.w, node.h, node.x, node.y));
    if (editAfter && type === 'text') editText(node.id, true);
    return node.id;
  }
  /** The frame a new rectangle or text goes into from the keyboard: the selected one, else the one at the centre of the view. */
  function targetFrame() {
    if (S.sel) { var l = C.locate(S.doc, S.sel); if (l) return l.frame ? l.frame.id : l.node.id; }
    return C.frameAt(S.doc, C.toWorld(S.cam, centre()));
  }
  function createAtCentre(type) {
    var c = C.toWorld(S.cam, centre()), d = C.DEFAULTS[type];
    if (type === 'frame') return create('frame', null, { x: c.x - d.w / 2, y: c.y - d.h / 2 });
    var fid = targetFrame();
    if (!fid) { say(T('Rectangles and text go inside a frame. Draw a frame first.')); return null; }
    var f = C.locate(S.doc, fid).node;
    var lx = Math.max(0, Math.min(f.w - d.w, c.x - f.x - d.w / 2)), ly = Math.max(0, Math.min(f.h - d.h, c.y - f.y - d.h / 2));
    return create(type, fid, { x: lx, y: ly }, true);
  }
  function removeSelected() {
    if (!S.sel) return;
    var name = nodeName(S.sel), id = S.sel;
    S.sel = null;
    if (run({ kind: 'remove', id: id }, tf('Delete %s', name))) { paintPanel(); say(tf('%s deleted.', name)); }
  }
  function duplicateSelected() {
    if (!S.sel) return;
    var op;
    try { op = C.duplicateOp(S.doc, S.sel); } catch (err) { say(problemText(err.code)); return; }
    var name = nodeName(S.sel);
    if (run(op, tf('Duplicate %s', name))) { select(op.node.id, true); say(tf('%s duplicated.', name)); }
  }
  function nudge(dx, dy, resize) {
    if (!S.sel) return;
    var n = C.locate(S.doc, S.sel).node;
    var g = resize ? { x: n.x, y: n.y, w: Math.max(1, Math.min(LIMITS.size, n.w + dx)), h: Math.max(1, Math.min(LIMITS.size, n.h + dy)) } : C.moveBy(n, dx, dy);
    var props = {};
    ['x', 'y', 'w', 'h'].forEach(function (k) { if (g[k] !== n[k]) props[k] = g[k]; });
    if (!Object.keys(props).length) return;
    if (run({ kind: 'set', id: n.id, props: props }, resize ? tf('Resize %s', n.name) : tf('Move %s', n.name))) {
      say(resize ? tf('%s resized to %d by %d', n.name, n.w, n.h) : tf('%s moved to %d, %d', n.name, n.x, n.y));
    }
  }

  // ── text editing ──────────────────────────────────────────────────────────

  function editText(id, justCreated) {
    var l = C.locate(S.doc, id);
    if (!l || l.node.type !== 'text') return;
    var n = l.node, ta = S.el.textEdit;
    S.editing = { id: id, created: !!justCreated };
    var r = screenRect(C.worldRect(S.doc, id));
    place(ta, { x: r.x, y: r.y, w: Math.max(180, r.w), h: Math.max(64, r.h) });
    ta.value = n.text;
    ta.hidden = false;
    paintOverlay();
    ta.focus();
    ta.select();
  }
  function finishText() {
    if (!S || !S.editing) return;
    var ed = S.editing, ta = S.el.textEdit;
    S.editing = null;
    ta.hidden = true;
    var l = C.locate(S.doc, ed.id);
    if (l) {
      var v = ta.value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, LIMITS.text);
      if (!v.trim() && ed.created) {
        // An empty text that was just added leaves nothing behind, and no undo step.
        C.undo(S.doc, S.hist); S.hist.future.pop();
        S.sel = null; afterChange(); paintPanel();
        say(T('Empty text removed.'));
      } else if (v !== l.node.text) {
        if (run({ kind: 'set', id: ed.id, props: { text: v } }, tf('Edit %s', l.node.name))) say(tf('%s: text changed.', l.node.name));
      }
    }
    paintOverlay();
    try { S.el.canvas.focus({ preventScroll: true }); } catch (_) {}
  }

  // ── pointer ───────────────────────────────────────────────────────────────

  function local(e) {
    var r = S.el.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onPointerDown(e) {
    if (e.target === S.el.textEdit) return;
    if (S.editing) finishText();
    if (e.target.closest && e.target.closest('.st-empty')) return;
    var p = local(e), w = C.toWorld(S.cam, p);
    var pan = e.button === 1 || S.space || S.tool === 'hand';
    if (!pan && e.button !== 0) return;
    e.preventDefault();
    try { S.el.canvas.focus({ preventScroll: true }); } catch (_) {}
    var d = null;
    if (pan) d = { kind: 'pan', cam0: S.cam };
    else {
      // Handles and frame names answer to the Select tool only: with a drawing tool, a press anywhere draws.
      var picking = S.tool === 'select';
      var handle = picking && e.target.closest && e.target.closest('[data-st-handle]');
      var label = picking && e.target.closest && e.target.closest('[data-st-label]');
      if (handle && S.sel) {
        var hn = C.locate(S.doc, S.sel).node;
        d = { kind: 'resize', id: S.sel, handle: handle.getAttribute('data-st-handle'), g0: { x: hn.x, y: hn.y, w: hn.w, h: hn.h } };
      } else if (label) {
        var fid = label.getAttribute('data-st-label'), fn = C.locate(S.doc, fid).node;
        select(fid);
        d = { kind: 'move', id: fid, g0: { x: fn.x, y: fn.y, w: fn.w, h: fn.h } };
      } else if (S.tool === 'select') {
        var hit = C.hitTest(S.doc, w);
        if (!hit) { select(null); return; }
        select(hit.id);
        var mn = C.locate(S.doc, hit.id).node;
        d = { kind: 'move', id: hit.id, g0: { x: mn.x, y: mn.y, w: mn.w, h: mn.h } };
      } else if (S.tool === 'frame') d = { kind: 'draw', type: 'frame', frame: null, a: w };
      else {
        var target = C.frameAt(S.doc, w);
        if (!target) { say(T('Rectangles and text go inside a frame. Draw a frame first.')); return; }
        d = { kind: 'draw', type: S.tool, frame: target, a: w };
      }
    }
    d.pointer = e.pointerId; d.s0 = p; d.moved = false; d.last = p; d.mods = { shift: e.shiftKey, alt: e.altKey };
    S.drag = d;
    S.hover = null;
    try { S.el.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    S.el.canvas.classList.toggle('is-panning', d.kind === 'pan');
    paintOverlay();
  }
  function onPointerMove(e) {
    if (!S.drag) {
      if (S.tool !== 'select' || S.space) return;
      var hit = C.hitTest(S.doc, C.toWorld(S.cam, local(e)));
      var id = hit ? hit.id : null;
      if (id !== S.hover) { S.hover = id; paintOverlay(); }
      return;
    }
    if (e.pointerId !== S.drag.pointer) return;
    S.pending = { p: local(e), shift: e.shiftKey, alt: e.altKey };
    if (!S.raf) S.raf = requestAnimationFrame(flushMove);
  }
  function flushMove() {
    if (!S) return;
    S.raf = 0;
    var m = S.pending;
    S.pending = null;
    if (!m || !S.drag) return;
    var t0 = performance.now();
    stepDrag(m.p, m.shift, m.alt);
    var ms = performance.now() - t0;
    S.metrics.moves++;
    if (S.metrics.moveMs.length < 2000) S.metrics.moveMs.push(Math.round(ms * 100) / 100);
  }
  function stepDrag(p, shift, alt) {
    var d = S.drag;
    d.last = p; d.mods = { shift: shift, alt: alt };
    var sdx = p.x - d.s0.x, sdy = p.y - d.s0.y;
    if (!d.moved && Math.abs(sdx) < DRAG_THRESHOLD && Math.abs(sdy) < DRAG_THRESHOLD) return;
    d.moved = true;
    if (d.kind === 'pan') { S.cam = C.panBy(d.cam0, sdx, sdy); applyCamera(); return; }
    var wd = C.worldDelta(sdx, sdy, S.cam.z);
    if (d.kind === 'move') { d.g = C.moveBy(d.g0, wd.dx, wd.dy); preview(d.id, d.g); return; }
    if (d.kind === 'resize') { d.g = C.resize(d.g0, d.handle, wd.dx, wd.dy, { keepRatio: shift, fromCenter: alt }); preview(d.id, d.g); return; }
    if (d.kind === 'draw') {
      d.b = C.band(d.a, C.toWorld(S.cam, p));
      S.el.band.hidden = false;
      place(S.el.band, screenRect(d.b));
    }
  }
  function onPointerUp(e) {
    var d = S.drag;
    if (!d || e.pointerId !== d.pointer) return;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    stepDrag(local(e), e.shiftKey, e.altKey);
    S.pending = null;
    S.drag = null;
    S.el.canvas.classList.remove('is-panning');
    S.el.band.hidden = true;
    try { S.el.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.kind === 'pan') return;
    if (d.kind === 'move' || d.kind === 'resize') {
      if (!d.moved || !d.g) { paintAll(); return; }
      var n = C.locate(S.doc, d.id).node, props = {};
      ['x', 'y', 'w', 'h'].forEach(function (k) { if (d.g[k] !== n[k]) props[k] = d.g[k]; });
      if (!Object.keys(props).length) { paintAll(); return; }
      if (run({ kind: 'set', id: d.id, props: props }, d.kind === 'move' ? tf('Move %s', n.name) : tf('Resize %s', n.name))) {
        say(d.kind === 'move' ? tf('%s moved to %d, %d', n.name, n.x, n.y) : tf('%s resized to %d by %d', n.name, n.w, n.h));
      } else paintAll();
      return;
    }
    if (d.kind === 'draw') {
      var def = C.DEFAULTS[d.type];
      var b = d.moved && d.b ? d.b : { x: Math.round(d.a.x), y: Math.round(d.a.y), w: def.w, h: def.h };
      if (d.type === 'frame') { create('frame', null, b); return; }
      var f = C.locate(S.doc, d.frame);
      if (!f) return;
      create(d.type, d.frame, { x: b.x - f.node.x, y: b.y - f.node.y, w: b.w, h: b.h }, true);
    }
  }
  function cancelDrag() {
    if (!S.drag) return false;
    var d = S.drag;
    S.drag = null;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.el.band.hidden = true;
    S.el.canvas.classList.remove('is-panning');
    try { S.el.canvas.releasePointerCapture(d.pointer); } catch (_) {}
    if (d.kind === 'pan') { S.cam = d.cam0; applyCamera(); }
    paintAll();
    say(T('Cancelled.'));
    return true;
  }
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      var factor = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.01);
      S.cam = C.zoomAt(S.cam, S.cam.z * factor, local(e));
      applyCamera();
      return;
    }
    S.cam = C.panBy(S.cam, -e.deltaX, -e.deltaY);
    applyCamera();
  }
  function onDblClick(e) {
    if (S.tool !== 'select') return;
    var hit = C.hitTest(S.doc, C.toWorld(S.cam, local(e)));
    if (hit && C.locate(S.doc, hit.id).node.type === 'text') editText(hit.id, false);
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  function onKeyDown(e) {
    if (!S || S.editing || !S.el.shell) return;
    // The Studio is the whole page: a key pressed with focus nowhere in particular is the Studio's too.
    if (!(S.el.shell.contains(e.target) || e.target === document.body || e.target === document.documentElement)) return;
    var mod = e.ctrlKey || e.metaKey, k = e.key, inField = isField(e.target);
    var inCanvas = e.target === S.el.canvas;
    if (mod && !e.altKey && (k === 'z' || k === 'Z')) { if (inField) return; e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && !e.altKey && (k === 'y' || k === 'Y')) { if (inField) return; e.preventDefault(); doRedo(); return; }
    if (mod && (k === 's' || k === 'S')) { e.preventDefault(); saveNow(true); return; }
    if (inField) return;
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomTo(C.zoomStep(S.cam.z, 1)); return; }
    if (mod && k === '-') { e.preventDefault(); zoomTo(C.zoomStep(S.cam.z, -1)); return; }
    if (mod && k === '0') { e.preventDefault(); zoomTo(1); return; }
    if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); duplicateSelected(); return; }
    if (e.shiftKey && !mod && e.code === 'Digit1') { e.preventDefault(); fit(); return; }
    if (!mod && !e.altKey && !e.shiftKey) {
      var tool = { v: 'select', h: 'hand', f: 'frame', r: 'rect', t: 'text' }[k];
      if (tool) { e.preventDefault(); setTool(tool); return; }
    }
    if (!inCanvas) return;
    if (k === ' ') { e.preventDefault(); if (!S.space) { S.space = true; S.el.canvas.classList.add('is-hand'); } return; }
    if (k === 'Escape') { e.preventDefault(); if (!cancelDrag() && S.sel) select(null); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeSelected(); return; }
    if (k === 'Enter') {
      e.preventDefault();
      if (S.tool === 'frame' || S.tool === 'rect' || S.tool === 'text') { createAtCentre(S.tool); return; }
      if (S.sel && C.locate(S.doc, S.sel).node.type === 'text') editText(S.sel, false);
      return;
    }
    if (k === 'Tab' && S.sel) {
      e.preventDefault();
      var ids = C.orderedIds(S.doc), i = ids.indexOf(S.sel);
      select(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
      return;
    }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (arrows && S.sel) {
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1;
      nudge(arrows[0] * step, arrows[1] * step, e.altKey);
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    if (e.key === ' ' && S.space) { S.space = false; S.el.canvas.classList.toggle('is-hand', S.tool === 'hand'); }
  }

  // ── import and export ─────────────────────────────────────────────────────

  function exportFile() {
    var text = C.serializeDocument(S.doc);
    var name = C.exportFileName(S.doc.name);
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = h('a', { href: url, download: name, class: 'st-sr' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    say(tf('Exported %s.', name));
  }
  function importFile(file) {
    if (!file) return;
    if (file.size > LIMITS.bytes) { say(tf('Not imported: %s', problemText('too-large'))); return; }
    file.text().then(function (text) {
      if (!S) return;
      var r = C.parseDocument(text);
      if (!r.ok) { say(tf('Not imported: %s', problemText(r.errors[0].code)) + ' (' + r.errors[0].path + ')'); return; }
      S.sel = null;
      if (run({ kind: 'replace', doc: r.doc }, T('Import design'))) {
        paintPanel();
        fit(true);
        say(tf('Imported %s: %d frames, %d elements.', S.doc.name, S.doc.frames.length, C.countNodes(S.doc) - S.doc.frames.length));
      }
    }).catch(function () { if (S) say(tf('Not imported: %s', problemText('not-json'))); });
  }

  // ── building the room ─────────────────────────────────────────────────────

  function toolButton(tool, key) {
    return h('button', { class: 'st-btn st-tool', type: 'button', 'data-st-tool': tool, 'aria-pressed': 'false',
      'aria-keyshortcuts': key, title: T(TOOL_LABEL[tool]) + ' (' + key + ')' }, [icon(tool), h('span', { class: 'st-btn-label', text: T(TOOL_LABEL[tool]) })]);
  }
  function iconButton(act, iconName, label, keys) {
    return h('button', { class: 'st-btn st-btn--icon', type: 'button', 'data-st-act': act, 'aria-label': label, title: label + (keys ? ' (' + keys + ')' : ''), 'aria-keyshortcuts': keys || null }, [icon(iconName)]);
  }
  function build() {
    var host = S.host;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.setAttribute('lang', LANG);
    host.setAttribute('dir', DIR);
    var E = S.el;
    E.live = h('div', { class: 'st-sr', role: 'status', 'aria-live': 'polite', id: 'st-live' });
    E.help = h('p', { class: 'st-sr', id: 'st-help', text: T('Design canvas. V selects, H pans, F draws frames, R rectangles and T text; Enter adds the active tool’s shape at the centre of the view. Arrow keys move the selection 1 pixel, Shift and an arrow 10 pixels, Alt and an arrow resize it. Tab and Shift Tab move between elements while one is selected; Escape clears the selection, and Tab then leaves the canvas.') });
    E.docName = h('input', { class: 'st-docname', type: 'text', maxlength: String(LIMITS.name), 'aria-label': T('Design name'), 'data-user-content': '' });
    E.docName.value = S.doc.name;
    E.save = h('span', { class: 'st-save', 'data-state': 'saved' });
    var langs = h('div', { class: 'st-langs', role: 'group', 'aria-label': T('Language') });
    for (var i = 0; i < LOCALES.length; i++) {
      langs.appendChild(h('button', { class: 'st-lang', type: 'button', 'data-st-lang': LOCALES[i][0], lang: LOCALES[i][0], 'aria-pressed': LOCALES[i][0] === LANG ? 'true' : 'false', text: LOCALES[i][1] }));
    }
    var top = h('header', { class: 'st-top' }, [
      h('button', { class: 'st-home', type: 'button', 'data-st-act': 'home' }, [icon('back'), h('span', { text: T('Owner Control') })]),
      h('div', { class: 'st-brand' }, [h('span', { class: 'st-mark' }, [icon('mark')]), h('h1', { class: 'st-title', text: T('Design Studio') }), h('span', { class: 'st-badge', text: T('Preview') })]),
      E.docName,
      h('div', { class: 'st-top-end' }, [E.save, langs]),
    ]);
    E.tools = h('div', { class: 'st-group', role: 'group', 'aria-label': T('Tools') }, [
      toolButton('select', 'V'), toolButton('hand', 'H'), toolButton('frame', 'F'), toolButton('rect', 'R'), toolButton('text', 'T'),
    ]);
    E.undo = iconButton('undo', 'undo', T('Undo'), 'Control+Z');
    E.redo = iconButton('redo', 'redo', T('Redo'), 'Control+Shift+Z');
    E.zoomOut = iconButton('zoom-out', 'minus', T('Zoom out'), 'Control+-');
    E.zoomIn = iconButton('zoom-in', 'plus', T('Zoom in'), 'Control+=');
    E.zoomLabel = h('button', { class: 'st-btn st-zoom', type: 'button', 'data-st-act': 'zoom-reset' });
    E.file = h('input', { class: 'st-sr', type: 'file', accept: '.json,application/json', tabindex: '-1', 'aria-hidden': 'true' });
    var bar = h('div', { class: 'st-bar' }, [
      E.tools,
      h('div', { class: 'st-group', role: 'group', 'aria-label': T('History') }, [E.undo, E.redo]),
      h('div', { class: 'st-group', role: 'group', 'aria-label': T('Zoom') }, [E.zoomOut, E.zoomLabel, E.zoomIn, iconButton('fit', 'fit', T('Fit to screen'), 'Shift+1')]),
      h('div', { class: 'st-group st-group--end', role: 'group', 'aria-label': T('File') }, [
        h('button', { class: 'st-btn', type: 'button', 'data-st-act': 'import' }, [icon('import'), h('span', { class: 'st-btn-label', text: T('Import') })]),
        h('button', { class: 'st-btn', type: 'button', 'data-st-act': 'export' }, [icon('export'), h('span', { class: 'st-btn-label', text: T('Export') })]),
        E.file,
      ]),
    ]);
    E.world = h('div', { class: 'st-world' });
    E.labels = h('div', { class: 'st-labels' });
    E.hover = h('div', { class: 'st-hover', hidden: true });
    E.sel = h('div', { class: 'st-sel', hidden: true });
    for (var j = 0; j < C.HANDLES.length; j++) E.sel.appendChild(h('div', { class: 'st-h st-h-' + C.HANDLES[j], 'data-st-handle': C.HANDLES[j] }));
    E.band = h('div', { class: 'st-band', hidden: true });
    E.overlay = h('div', { class: 'st-overlay', 'aria-hidden': 'true' }, [E.labels, E.hover, E.sel, E.band]);
    E.textEdit = h('textarea', { class: 'st-textedit', hidden: true, maxlength: String(LIMITS.text), 'aria-label': T('Edit text'), 'data-user-content': '', spellcheck: 'true' });
    E.empty = h('div', { class: 'st-empty' }, [
      h('h2', { class: 'st-empty-title', text: T('Start with a frame') }),
      h('p', { class: 'st-empty-text', text: T('Choose Frame (F) and drag on the canvas, or add one here. Rectangles and text are drawn inside frames.') }),
      h('button', { class: 'st-btn st-btn--primary', type: 'button', 'data-st-act': 'add-frame' }, [icon('frame'), h('span', { text: T('Add a frame') })]),
    ]);
    E.canvas = h('div', { class: 'st-canvas', tabindex: '0', role: 'application', 'aria-roledescription': T('design canvas'),
      'aria-label': T('Design canvas'), 'aria-describedby': 'st-help', dir: 'ltr' }, [E.world, E.overlay, E.empty, E.textEdit]);
    E.panel = h('aside', { class: 'st-panel', 'aria-label': T('Properties'), 'data-st-for': '' });
    var shell = h('div', { class: 'st-shell' }, [top, bar, h('div', { class: 'st-work' }, [E.canvas, E.panel]), E.help, E.live]);
    host.appendChild(shell);
    E.shell = shell;
    S.frames = {};

    listen(shell, 'click', onClick);
    listen(document, 'keydown', onKeyDown);
    listen(window, 'keyup', onKeyUp);
    listen(window, 'blur', function () { if (S) { S.space = false; if (S.el.canvas) S.el.canvas.classList.toggle('is-hand', S.tool === 'hand'); } });
    listen(E.canvas, 'pointerdown', onPointerDown);
    listen(E.canvas, 'pointermove', onPointerMove);
    listen(E.canvas, 'pointerup', onPointerUp);
    listen(E.canvas, 'pointercancel', function (e) { if (S.drag && e.pointerId === S.drag.pointer) cancelDrag(); });
    listen(E.canvas, 'pointerleave', function () { if (S.hover && !S.drag) { S.hover = null; paintOverlay(); } });
    listen(E.canvas, 'wheel', onWheel, { passive: false });
    listen(E.canvas, 'dblclick', onDblClick);
    listen(E.docName, 'change', function () {
      var v = E.docName.value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, LIMITS.name);
      if (!v) { E.docName.value = S.doc.name; return; }
      if (v !== S.doc.name && run({ kind: 'meta', props: { name: v } }, T('Rename design'))) say(tf('Design renamed to %s', v));
    });
    listen(E.docName, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); E.docName.blur(); } });
    listen(E.textEdit, 'keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishText(); }
    });
    listen(E.textEdit, 'blur', function () { finishText(); });
    listen(E.file, 'change', function () { var f = E.file.files && E.file.files[0]; E.file.value = ''; importFile(f); });

    S.view = { w: E.canvas.clientWidth, h: E.canvas.clientHeight };
    if (typeof ResizeObserver === 'function') {
      S.ro = new ResizeObserver(function () { if (S && S.el.canvas) { S.view = { w: S.el.canvas.clientWidth, h: S.el.canvas.clientHeight }; paintOverlay(); } });
      S.ro.observe(E.canvas);
    }
    setTool(S.tool, true);
    applyCamera();
    paintAll();
    paintPanel();
    setSaveState(S.saveState);
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-st-act],[data-st-tool],[data-st-lang]') : null;
    if (!t || !S.el.shell.contains(t)) return;
    var tool = t.getAttribute('data-st-tool');
    if (tool) { setTool(tool); try { S.el.canvas.focus({ preventScroll: true }); } catch (_) {} return; }
    var lang = t.getAttribute('data-st-lang');
    if (lang) { if (lang !== LANG) switchLanguage(lang); return; }
    switch (t.getAttribute('data-st-act')) {
      case 'home': try { if (typeof window.navTo === 'function') window.navTo('owner-home'); } catch (_) {} return;
      case 'undo': doUndo(); return;
      case 'redo': doRedo(); return;
      case 'zoom-in': zoomTo(C.zoomStep(S.cam.z, 1)); return;
      case 'zoom-out': zoomTo(C.zoomStep(S.cam.z, -1)); return;
      case 'zoom-reset': zoomTo(1); return;
      case 'fit': fit(); return;
      case 'import': S.el.file.click(); return;
      case 'export': exportFile(); return;
      case 'add-frame': createAtCentre('frame'); try { S.el.canvas.focus({ preventScroll: true }); } catch (_) {} return;
      case 'duplicate': duplicateSelected(); return;
      case 'delete': removeSelected(); try { S.el.canvas.focus({ preventScroll: true }); } catch (_) {} return;
      case 'edit-text': if (S.sel) editText(S.sel, false); return;
      default: return;
    }
  }
  function switchLanguage(tag) {
    saveNow(false);
    var keep = S;
    setLocale(tag).then(function () {
      if (S !== keep) return;
      unbind();
      build();
      var on = S.el.shell.querySelector('[data-st-lang="' + LANG + '"]');
      if (on) on.focus();
      say(tf('Language: %s', localeOf(LANG)[1]));
    });
  }
  function unbind() {
    if (!S) return;
    for (var i = 0; i < S.off.length; i++) { try { S.off[i](); } catch (_) {} }
    S.off = [];
    if (S.ro) { try { S.ro.disconnect(); } catch (_) {} S.ro = null; }
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    clearTimeout(S.sayTimer);
  }

  // ── entry and exit ────────────────────────────────────────────────────────

  window.renderFamilistaDesignStudio = function (host) {
    if (!host || !C) return;
    if (S) window.teardownFamilistaDesignStudio();
    S = fresh(host);
    var mine = S;
    host.setAttribute('aria-busy', 'true');
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(h('div', { class: 'st-shell st-shell--loading' }));
    setLocale(initialLocale()).then(function () {
      if (S !== mine) return;
      var stored = loadStored();
      S.doc = stored.doc;
      S.metrics.mounts++;
      build();
      host.removeAttribute('aria-busy');
      if (S.doc.frames.length) fit(true);
      if (stored.note === 'restored') say(tf('Opened %s, saved in this browser.', S.doc.name));
      else if (stored.note === 'unreadable') say(T('The design saved in this browser could not be read, so a new design was started. The unreadable copy was kept aside.'));
      else if (stored.note === 'unavailable') { setSaveState('failed'); say(T('This browser’s storage is unavailable: designs will not be kept after you leave.')); }
    });
  };

  window.teardownFamilistaDesignStudio = function () {
    if (!S) return;
    if (S.editing) finishText();
    if (S.doc && S.saveTimer) saveNow(false);
    unbind();
    clearTimeout(S.saveTimer);
    var host = S.host;
    S = null;
    if (host) while (host.firstChild) host.removeChild(host.firstChild);
  };

  /** Read-only figures for the browser proof, as the Specimen Lab has: counts, timings and editor state. It changes nothing. */
  window.__familistaStudioMetrics = function () {
    if (!S) return null;
    var ms = S.metrics.moveMs.slice().sort(function (a, b) { return a - b; });
    return {
      mounts: S.metrics.mounts, commits: S.metrics.commits, moves: S.metrics.moves, nodePaints: S.metrics.nodePaints,
      moveMsMedian: ms.length ? ms[Math.floor(ms.length / 2)] : null, moveMsP95: ms.length ? ms[Math.floor(ms.length * 0.95)] : null,
      moveMsMax: ms.length ? ms[ms.length - 1] : null,
      frames: S.doc ? S.doc.frames.length : 0, nodes: S.doc ? C.countNodes(S.doc) : 0,
      undo: S.hist.past.length, redo: S.hist.future.length, zoom: S.cam.z, camera: { x: S.cam.x, y: S.cam.y, z: S.cam.z },
      tool: S.tool, selected: S.sel, saveState: S.saveState, lastSaveBytes: S.metrics.lastSaveBytes, announced: S.announced,
      lang: LANG, dir: DIR,
    };
  };
})();
