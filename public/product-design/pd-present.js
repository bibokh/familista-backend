/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — a collection's presentation sheet (M7b-2), in a
   club's studio.

   The kit as a page to show a board, a sponsor or a supplier: every design of
   the collection drawn from its saved version by the room's own renderer, in
   vectors, two views each, with its garment, its role, its version and the
   club's decision on it, and, when the collection names a roster, the sets per
   size. It is printed, or saved as a PDF, by the browser's own print: nothing
   is uploaded, generated on a server or kept anywhere.

   A floating sheet over the room (position: fixed, opacity and transform only),
   so opening it moves nothing beneath it; its body scrolls inside itself. The
   room hands it its builders, words, server client and renderer (shell);
   nothing here fetches anything but the club's own designs, and what people
   wrote is shown as written, never translated.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignPresent = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function L(text) { return text; }
  var FAILED = { gone: L('This design is no longer on the server.'), unreadable: L('This saved design cannot be opened by this version of the Design Studio.'), network: L('The server could not be reached.') };

  function create(shell) {
    var h = shell.h, btn = shell.btn, icon = shell.icon, T = shell.T, tf = shell.tf, api = shell.api;
    var st = { open: false, trigger: null, seq: 0, kit: null, sheet: null, designs: [], at: null };
    var el = h('section', { class: 'pd-present', id: 'pd-present', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pd-present-title', 'data-open': 'false' });

    function ready() { return st.designs.length > 0 && st.designs.every(function (d) { return d.state !== 'loading'; }); }
    function drawn() { return st.designs.filter(function (d) { return d.state === 'ready'; }).length; }

    /** Opens the sheet for a saved collection: { id, name, season, items[{ projectId, role, name, templateKey, approval }] }. */
    function open(kit, sheet, trigger) {
      var seq = ++st.seq;
      st.open = true; st.trigger = trigger || null; st.kit = kit; st.sheet = sheet || null; st.at = new Date();
      // The button pressed may be drawn again while the sheet is open (the panel behind it repaints): its key finds it again.
      st.triggerKey = trigger && trigger.getAttribute ? trigger.getAttribute('data-pd-team-key') || trigger.getAttribute('data-pd-act') : null;
      st.designs = kit.items.map(function (it) { return { item: it, state: 'loading', doc: null, tpl: null, revision: null, error: '' }; });
      st.scroll = null;
      el.setAttribute('data-open', 'true');
      shell.host().ownerDocument.body.classList.add('pd-presenting');
      render();
      // After the click that opened it has finished, and whatever the panel behind repainted with it.
      Promise.resolve().then(function () { var first = st.open && el.querySelector('[data-pd-act="present-close"]'); if (first) first.focus({ preventScroll: true }); });
      st.designs.forEach(function (d) {
        api.openProject(d.item.projectId).then(function (r) {
          if (seq !== st.seq) return null;
          if (!r.ok || !r.data || !r.data.revision) { d.state = 'error'; d.error = T(r.status === 404 ? FAILED.gone : r.status === 0 ? FAILED.network : FAILED.unreadable); return null; }
          var raw = r.data.revision.document, key = raw && raw.template && raw.template.key;
          d.revision = r.data.revision.number;
          return shell.template(key).then(function (tpl) {
            if (seq !== st.seq) return;
            var doc = shell.validate(raw, tpl);
            if (!doc) { d.state = 'error'; d.error = T(FAILED.unreadable); return; }
            d.doc = doc; d.tpl = tpl; d.state = 'ready';
          }, function () { if (seq === st.seq) { d.state = 'error'; d.error = T(FAILED.unreadable); } });
        }).then(function () { if (seq === st.seq) render(); });
      });
      shell.onToggle();
    }
    function close() {
      if (!st.open) return;
      st.open = false; st.seq++; st.scroll = null;
      el.setAttribute('data-open', 'false');
      shell.host().ownerDocument.body.classList.remove('pd-presenting');
      var back = st.trigger && st.trigger.isConnected ? st.trigger
        : st.triggerKey ? shell.host().querySelector('[data-pd-team-key="' + st.triggerKey + '"], [data-pd-act="' + st.triggerKey + '"]') : null;
      st.trigger = null; st.triggerKey = null;
      if (back) back.focus({ preventScroll: true });
      shell.onToggle();
    }
    function print() {
      if (!st.open || !ready() || !drawn()) return;
      shell.say(T('Opening the print dialog. Choose “Save as PDF” to keep a file.'));
      var w = shell.host().ownerDocument.defaultView;
      if (w && typeof w.print === 'function') w.print();
    }

    // ── the sheet ─────────────────────────────────────────────────────────
    /** The template's first two views: front and back of a top or shorts, outer and inner of socks. */
    function views(tpl) { return tpl.views.slice(0, 2); }
    function figure(d, i) {
      var out = h('div', { class: 'pd-present-views' });
      views(d.tpl).forEach(function (v, k) {
        var svg = shell.draw(d.doc, d.tpl, v.id, 'pdp' + i + '-' + k);
        out.appendChild(h('figure', { class: 'pd-present-fig' }, [svg, h('figcaption', { text: T(v.label) })]));
      });
      return out;
    }
    function card(d, i) {
      var it = d.item, kids = [];
      if (d.state === 'loading') kids.push(h('div', { class: 'pd-present-views is-skeleton', 'aria-hidden': 'true' }, [h('span', { class: 'pd-present-ghost' }), h('span', { class: 'pd-present-ghost' })]));
      else if (d.state === 'error') kids.push(h('div', { class: 'pd-present-views is-missing' }, [h('p', { class: 'pd-note pd-note--warn' }, [icon('alert', 14), h('span', { text: d.error })])]));
      else kids.push(figure(d, i));
      var meta = [shell.productLabel(it.templateKey), it.roleLabel];
      if (d.revision) meta.push(tf('version %d', d.revision));
      // The club's decision is on the newest version, which is the one drawn: a decision on another version is not shown as this one's.
      var decision = shell.approvalChip && d.revision ? shell.approvalChip(it.approval && it.approval.revision === d.revision ? it.approval : null) : null;
      kids.push(h('div', { class: 'pd-present-cap' }, [
        h('h2', { class: 'pd-present-name', 'data-user-content': '', dir: 'auto', text: it.name }),
        h('p', { class: 'pd-present-meta', text: meta.join(' · ') }),
        decision,
      ]));
      return h('article', { class: 'pd-present-card', 'data-pd-present-design': it.projectId, 'data-state': d.state }, kids);
    }
    function sizes() {
      var s = st.sheet;
      if (!s || !s.garments || !s.garments.length) return null;
      var tb = h('tbody');
      s.garments.forEach(function (g) {
        var cell = h('td');
        if (!g.sizes.length) cell.appendChild(document.createTextNode('—'));
        g.sizes.forEach(function (x, i) { if (i) cell.appendChild(document.createTextNode(' · ')); cell.appendChild(h('bdi', { dir: 'ltr', text: x.size + ' × ' + x.sets })); });
        if (g.unsized) { cell.appendChild(document.createTextNode(g.sizes.length ? ' · ' : '')); cell.appendChild(h('span', { text: tf('without a size: %d', g.unsized) })); }
        tb.appendChild(h('tr', null, [h('th', { scope: 'row' }, [h('span', { 'data-user-content': '', text: g.name })]), cell]));
      });
      return h('section', { class: 'pd-present-sizes', 'aria-labelledby': 'pd-present-sizes-h' }, [
        h('h2', { class: 'pd-present-h', id: 'pd-present-sizes-h', text: T('Sizes and sets') }),
        h('p', { class: 'pd-present-meta', text: tf('For %s: entries %d · sets %d.', s.roster.name, s.roster.entries, s.roster.sets) }),
        h('table', { class: 'pd-present-table' }, [h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: T('Design') }), h('th', { scope: 'col', text: T('Sizes and sets') })])]), tb]),
      ]);
    }
    /** The bar is made once a sheet opens, and only its status and its print button change: what has focus stays. */
    function bar() {
      var status = h('span', { class: 'pd-note', role: 'status', 'data-pd-present-status': '' });
      var printBtn = btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'present-print' }, [icon('export', 14), h('span', { text: T('Print or save as PDF') })]);
      st.bar = { status: status, print: printBtn };
      return h('div', { class: 'pd-present-bar' }, [
        h('h2', { class: 'pd-h2', id: 'pd-present-title' }, [icon('eye', 16), h('span', { text: T('Presentation') })]),
        status,
        h('div', { class: 'pd-dock-btns' }, [printBtn, btn({ class: 'pd-icbtn', 'data-pd-act': 'present-close', 'aria-label': T('Close') }, [icon('close')])]),
      ]);
    }
    function syncBar() {
      var can = ready() && drawn() > 0;
      st.bar.status.textContent = ready() ? tf('Designs drawn: %d of %d', drawn(), st.designs.length) : T('Drawing the designs…');
      if (can) { st.bar.print.removeAttribute('aria-disabled'); st.bar.print.removeAttribute('data-pd-why'); }
      else { st.bar.print.setAttribute('aria-disabled', 'true'); st.bar.print.setAttribute('data-pd-why', T('Drawing the designs…')); }
    }
    /** The sheet itself: the one region drawn again as designs arrive. */
    function render() {
      if (!st.open || !st.kit) { while (el.firstChild) el.removeChild(el.firstChild); st.scroll = null; return; }
      if (!st.scroll) { while (el.firstChild) el.removeChild(el.firstChild); el.appendChild(bar()); st.scroll = h('div', { class: 'pd-present-scroll', tabindex: '0', role: 'region', 'aria-label': T('Presentation') }); el.appendChild(st.scroll); }
      syncBar();
      var k = st.kit, keep = st.scroll.scrollTop;
      var head = h('header', { class: 'pd-present-head' }, [
        h('p', { class: 'pd-present-kicker', 'data-user-content': '', dir: 'auto', text: shell.clubName() }),
        h('h1', { class: 'pd-present-title', 'data-user-content': '', dir: 'auto', text: k.season ? k.name + ' · ' + k.season : k.name }),
        h('p', { class: 'pd-present-meta', text: tf('Designs: %d · prepared %s', st.designs.length, shell.date(st.at.toISOString())) }),
      ]);
      var sheet = h('div', { class: 'pd-present-sheet', 'data-pd-present-sheet': '' }, [
        head,
        h('div', { class: 'pd-present-grid' }, st.designs.map(card)),
        sizes(),
        h('footer', { class: 'pd-present-foot' }, [
          h('span', { text: T('Familista Design Studio') }),
          h('span', { text: T('Colours on screen and in print are approximate.') }),
        ]),
      ]);
      while (st.scroll.firstChild) st.scroll.removeChild(st.scroll.firstChild);
      st.scroll.appendChild(sheet);
      st.scroll.scrollTop = keep;
    }
    /** A brand-kit logo finished loading: draw the sheet again, where it is open. */
    function repaint() { if (st.open) render(); }

    function onAction(act) {
      if (act === 'present-close') { close(); return true; }
      if (act === 'present-print') { print(); return true; }
      return false;
    }
    /** Escape closes; Tab stays inside the sheet while it is open. */
    function onKey(ev) {
      if (!st.open) return false;
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return true; }
      if (ev.key === 'Tab') {
        var f = [].slice.call(el.querySelectorAll('button, [tabindex="0"]')).filter(function (n) { return !n.hasAttribute('disabled'); });
        if (!f.length) return false;
        var doc = el.ownerDocument, i = f.indexOf(doc.activeElement);
        if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); f[f.length - 1].focus(); return true; }
        if (!ev.shiftKey && (i === -1 || i === f.length - 1)) { ev.preventDefault(); f[0].focus(); return true; }
      }
      return false;
    }
    function metrics() {
      return { open: st.open, designs: st.designs.length, ready: ready(), drawn: drawn(), errors: st.designs.filter(function (d) { return d.state === 'error'; }).length, sizes: !!st.sheet };
    }

    return { el: el, open: open, close: close, isOpen: function () { return st.open; }, repaint: repaint, onAction: onAction, onKey: onKey, metrics: metrics };
  }

  return { create: create };
});
