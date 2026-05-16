/*
 * Familista — Admin Control Center · UI primitives
 * File: public/familista-admin-ui.js
 *
 * Pure DOM helpers. No framework. No mock data. All HTML is escaped.
 * Exposes window.AdminUI with: el, esc, fmt*, kpi, badge, table, pager,
 * filterBar, drawer, toast, skeleton, statusBadgeFor*, exporters.
 */
(function () {
  'use strict';

  // ── DOM helpers ───────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class')      n.className = v;
        else if (k === 'html')  n.innerHTML = v;
        else if (k === 'text')  n.textContent = v;
        else if (k === 'data')  for (var dk in v) n.setAttribute('data-' + dk, v[dk]);
        else if (k === 'on')    for (var ev in v) n.addEventListener(ev, v[ev]);
        else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else                    n.setAttribute(k, v);
      }
    }
    if (children !== undefined && children !== null) {
      if (!Array.isArray(children)) children = [children];
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c === null || c === undefined || c === false) continue;
        if (typeof c === 'string' || typeof c === 'number') n.appendChild(document.createTextNode(String(c)));
        else n.appendChild(c);
      }
    }
    return n;
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function empty(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  // ── Formatters ────────────────────────────────────────────────────────
  function fmtNum(n, opts) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    opts = opts || {};
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: opts.minFrac || 0,
      maximumFractionDigits: opts.maxFrac === undefined ? 0 : opts.maxFrac,
    });
  }
  function fmtMoney(amt, cur) {
    if (amt === null || amt === undefined || isNaN(amt)) return '—';
    cur = (cur || 'EUR').toUpperCase();
    try {
      return Number(amt).toLocaleString(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 });
    } catch (e) {
      return cur + ' ' + fmtNum(amt, { maxFrac: 2 });
    }
  }
  function fmtDate(iso, opts) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    if (opts && opts.short) return d.toISOString().slice(0, 10);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtRel(iso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '—';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    var d = Math.floor(s / 86400);
    if (d < 30)   return d + 'd ago';
    return new Date(iso).toISOString().slice(0, 10);
  }

  // ── Badges ────────────────────────────────────────────────────────────
  function badge(text, tone) {
    var t = (tone || 'silver').toLowerCase();
    var span = el('span', { class: 'badge ' + t });
    span.appendChild(el('span', { class: 'dot' }));
    span.appendChild(document.createTextNode(String(text)));
    return span;
  }
  function badgeForSubStatus(s) {
    var map = { ACTIVE: 'ok', TRIALING: 'info', PAST_DUE: 'crit', CANCELED: 'silver', INCOMPLETE: 'warn' };
    return badge(s || '—', map[s] || 'silver');
  }
  function badgeForFranchiseStatus(s) {
    var map = { ACTIVE: 'ok', PENDING: 'warn', SUSPENDED: 'warn', IN_RENEWAL: 'info', TERMINATED: 'crit' };
    return badge(s || '—', map[s] || 'silver');
  }
  function badgeForIngestStatus(s) {
    var map = { QUEUED: 'info', RUNNING: 'info', COMPLETED: 'ok', FAILED: 'crit', CANCELLED: 'silver' };
    return badge(s || '—', map[s] || 'silver');
  }
  function badgeForKyc(s) {
    var map = { VERIFIED: 'ok', IN_REVIEW: 'info', PENDING: 'warn', REJECTED: 'crit', EXPIRED: 'crit' };
    return badge(s || '—', map[s] || 'silver');
  }
  function badgeForBool(b, on, off) {
    return badge(b ? (on || 'Active') : (off || 'Inactive'), b ? 'ok' : 'silver');
  }
  function badgeForAuditResult(s) {
    var map = { SUCCESS: 'ok', FAILURE: 'crit', REJECTED: 'crit' };
    return badge(s || '—', map[s] || 'silver');
  }

  // ── KPI ───────────────────────────────────────────────────────────────
  function kpi(label, value, sub, opts) {
    var cls = 'kpi' + (opts && opts.accent ? ' accent' : '');
    return el('div', { class: cls }, [
      el('div', { class: 'label', text: label }),
      el('div', { class: 'value', text: value === undefined || value === null ? '—' : String(value) }),
      sub ? el('div', { class: 'sub', text: sub }) : null,
    ]);
  }

  // ── Filter bar ────────────────────────────────────────────────────────
  // fields: [{ kind:'search', key, placeholder, value }, { kind:'select', key, options:[{value,label}], value, label } ...]
  function filterBar(fields, onChange) {
    var bar = el('div', { class: 'filter-bar' });
    var state = {};

    function emit() { onChange && onChange(Object.assign({}, state)); }

    for (var i = 0; i < fields.length; i++) {
      (function (f) {
        if (f.value !== undefined && f.value !== '') state[f.key] = f.value;
        if (f.kind === 'search') {
          var input = el('input', {
            class: 'input grow', type: 'search',
            placeholder: f.placeholder || 'Search…',
            value: f.value || '',
          });
          var timer;
          input.addEventListener('input', function () {
            var v = input.value.trim();
            if (v) state[f.key] = v; else delete state[f.key];
            clearTimeout(timer);
            timer = setTimeout(emit, 250);
          });
          bar.appendChild(input);
        } else if (f.kind === 'select') {
          var wrap = el('div', { class: 'row' });
          if (f.label) wrap.appendChild(el('span', { class: 'muted', style: 'font-size:12px;color:var(--text-3)', text: f.label }));
          var sel = el('select', { class: 'select' });
          sel.appendChild(el('option', { value: '' }, [f.placeholder || 'All']));
          for (var j = 0; j < f.options.length; j++) {
            var o = f.options[j];
            var opt = el('option', { value: o.value }, [o.label]);
            if (String(f.value || '') === String(o.value)) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', function () {
            if (sel.value) state[f.key] = sel.value; else delete state[f.key];
            emit();
          });
          wrap.appendChild(sel);
          bar.appendChild(wrap);
        } else if (f.kind === 'date') {
          var d = el('input', { class: 'input', type: 'date', value: f.value || '' });
          d.addEventListener('change', function () {
            if (d.value) state[f.key] = d.value; else delete state[f.key];
            emit();
          });
          bar.appendChild(el('div', { class: 'row' }, [
            f.label ? el('span', { class: 'muted', style: 'font-size:12px;color:var(--text-3)', text: f.label }) : null,
            d,
          ]));
        }
      }(fields[i]));
    }

    var reset = el('button', { class: 'btn ghost', text: 'Reset', type: 'button' });
    reset.addEventListener('click', function () {
      state = {};
      var inputs = bar.querySelectorAll('input, select');
      for (var i = 0; i < inputs.length; i++) inputs[i].value = '';
      emit();
    });
    bar.appendChild(reset);
    return bar;
  }

  // ── Table ─────────────────────────────────────────────────────────────
  // columns: [{ key, header, cls, render:(row)=>Node|string }]
  function table(columns, rows, opts) {
    opts = opts || {};
    var wrap = el('div', { class: 'tbl-wrap' });
    var t = el('table', { class: 'tbl' });
    var thead = el('thead');
    var trh = el('tr');
    for (var i = 0; i < columns.length; i++) {
      var c = columns[i];
      trh.appendChild(el('th', { class: c.cls || '' }, [c.header]));
    }
    thead.appendChild(trh);
    t.appendChild(thead);

    var tbody = el('tbody');
    if (!rows || rows.length === 0) {
      tbody.appendChild(el('tr', {}, [
        el('td', { colspan: String(columns.length) }, [
          el('div', { class: 'empty' }, [
            el('div', { class: 'em-title', text: opts.emptyTitle || 'No results' }),
            el('div', {}, [opts.emptyHint || 'Try adjusting your filters.']),
          ]),
        ]),
      ]));
    } else {
      for (var r = 0; r < rows.length; r++) {
        (function (row) {
          var tr = el('tr', { class: opts.onRow ? 'clickable' : '' });
          if (opts.onRow) tr.addEventListener('click', function (ev) {
            // ignore clicks on action buttons
            var tgt = ev.target;
            while (tgt && tgt !== tr) {
              if (tgt.tagName === 'BUTTON' || tgt.tagName === 'A') return;
              tgt = tgt.parentNode;
            }
            opts.onRow(row);
          });
          for (var ci = 0; ci < columns.length; ci++) {
            var col = columns[ci];
            var td = el('td', { class: col.cls || '' });
            var val = col.render ? col.render(row) : (row[col.key] === undefined ? '' : row[col.key]);
            if (val === null || val === undefined || val === '') {
              td.appendChild(document.createTextNode('—'));
              td.classList.add('muted');
            } else if (val && val.nodeType === 1) {
              td.appendChild(val);
            } else {
              td.appendChild(document.createTextNode(String(val)));
            }
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }(rows[r]));
      }
    }
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  // ── Pagination ────────────────────────────────────────────────────────
  function pager(state, onGo) {
    var total = state.total || 0;
    var page  = state.page  || 1;
    var limit = state.limit || 25;
    var pages = Math.max(1, Math.ceil(total / Math.max(limit, 1)));
    var bar = el('div', { class: 'pager' });

    var info = el('div', {}, [
      total === 0 ? '0 results' :
        (((page - 1) * limit + 1) + '–' + Math.min(page * limit, total) + ' of ' + total.toLocaleString()),
    ]);
    bar.appendChild(info);

    var nav = el('div', { class: 'pages' });
    function btn(label, p, dis, active) {
      var b = el('button', { class: 'page-btn' + (active ? ' active' : ''), type: 'button' }, [label]);
      if (dis) b.disabled = true;
      b.addEventListener('click', function () { if (!dis && onGo) onGo(p); });
      return b;
    }
    nav.appendChild(btn('‹', page - 1, page <= 1));
    var start = Math.max(1, page - 2), end = Math.min(pages, page + 2);
    if (start > 1)     { nav.appendChild(btn('1', 1, false, page === 1)); if (start > 2) nav.appendChild(btn('…', 1, true)); }
    for (var p = start; p <= end; p++) nav.appendChild(btn(String(p), p, false, p === page));
    if (end < pages)   { if (end < pages - 1) nav.appendChild(btn('…', pages, true)); nav.appendChild(btn(String(pages), pages, false, page === pages)); }
    nav.appendChild(btn('›', page + 1, page >= pages));
    bar.appendChild(nav);
    return bar;
  }

  // ── Drawer ────────────────────────────────────────────────────────────
  var drawerEl, drawerBackdropEl, drawerTitleEl, drawerBodyEl, drawerFootEl;
  function ensureDrawerRefs() {
    drawerEl         = document.getElementById('drawer');
    drawerBackdropEl = document.getElementById('drawer-backdrop');
    drawerTitleEl    = document.getElementById('drawer-title');
    drawerBodyEl     = document.getElementById('drawer-body');
    drawerFootEl     = document.getElementById('drawer-foot');
    if (drawerBackdropEl && !drawerBackdropEl._wired) {
      drawerBackdropEl.addEventListener('click', drawerClose);
      var closeBtn = document.getElementById('drawer-close');
      if (closeBtn) closeBtn.addEventListener('click', drawerClose);
      drawerBackdropEl._wired = true;
    }
  }
  function drawerOpen(opts) {
    ensureDrawerRefs();
    drawerTitleEl.textContent = opts.title || 'Detail';
    empty(drawerBodyEl);
    empty(drawerFootEl);
    if (opts.body && opts.body.nodeType === 1) drawerBodyEl.appendChild(opts.body);
    if (opts.foot && opts.foot.nodeType === 1) drawerFootEl.appendChild(opts.foot);
    drawerEl.classList.add('open');
    drawerBackdropEl.classList.add('open');
  }
  function drawerClose() {
    ensureDrawerRefs();
    drawerEl.classList.remove('open');
    drawerBackdropEl.classList.remove('open');
  }
  function dl(rows) {
    var dlEl = document.createElement('dl');
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i][0], v = rows[i][1];
      dlEl.appendChild(el('dt', { text: k }));
      var dd = document.createElement('dd');
      if (v && v.nodeType === 1) dd.appendChild(v);
      else dd.appendChild(document.createTextNode(v === null || v === undefined || v === '' ? '—' : String(v)));
      dlEl.appendChild(dd);
    }
    return dlEl;
  }

  // ── Toast ─────────────────────────────────────────────────────────────
  function toast(message, kind) {
    var host = document.getElementById('toast-host');
    if (!host) return;
    var t = el('div', { class: 'toast ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''), text: String(message) });
    host.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity 240ms ease'; t.style.opacity = '0'; }, 3200);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
  }

  // ── Skeleton ──────────────────────────────────────────────────────────
  function skeleton(rows, cols) {
    rows = rows || 6; cols = cols || 5;
    var wrap = el('div', { class: 'panel-body padded' });
    for (var i = 0; i < rows; i++) {
      var row = el('div', { class: 'row', style: 'gap:10px;margin-bottom:10px;' });
      for (var c = 0; c < cols; c++) row.appendChild(el('div', { class: 'skel', style: 'flex:1;' }));
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ── Confirm prompt ────────────────────────────────────────────────────
  // Lightweight async confirm using the drawer foot — falls back to confirm()
  function confirmAction(msg) {
    return Promise.resolve(window.confirm(msg));
  }

  // ── Empty state ───────────────────────────────────────────────────────
  function emptyState(title, hint) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'em-title', text: title || 'Nothing yet' }),
      hint ? el('div', { text: hint }) : null,
    ]);
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.AdminUI = {
    el: el, esc: esc, empty: empty,
    fmtNum: fmtNum, fmtMoney: fmtMoney, fmtDate: fmtDate, fmtRel: fmtRel,
    kpi: kpi, badge: badge,
    badgeForSubStatus: badgeForSubStatus,
    badgeForFranchiseStatus: badgeForFranchiseStatus,
    badgeForIngestStatus: badgeForIngestStatus,
    badgeForKyc: badgeForKyc,
    badgeForBool: badgeForBool,
    badgeForAuditResult: badgeForAuditResult,
    table: table, pager: pager,
    filterBar: filterBar,
    drawerOpen: drawerOpen, drawerClose: drawerClose, dl: dl,
    toast: toast,
    skeleton: skeleton,
    emptyState: emptyState,
    confirmAction: confirmAction,
  };
})();
