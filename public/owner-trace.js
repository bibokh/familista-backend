// Familista — the platform owner's live request trace
// ═════════════════════════════════════════════════════════════════════════════
//
// One request, seen end to end: the click, the call, the guards it passed, the
// queries it ran, the answer, and the paint. It exists so that "why did that
// take three seconds" is a question with an answer that is read rather than
// guessed at.
//
// SYSTEM's, and only SYSTEM's. The drawer is built when the platform owner's
// shell asks for it; the server refuses every route behind it to anybody else,
// which is the actual guard. Hiding the button is a courtesy.
//
// It does not touch the application it watches. It draws into its own fixed
// drawer, it never repaints a page, it never navigates, and the stream is one
// long-lived request rather than a poll — so opening it cannot add a render
// loop, a reflow or a second copy of anything to the screen behind it.

(function () {
  'use strict';

  var API = function () { return window.FamilistaAPI; };
  var esc = function (s) {
    return (typeof window._esc === 'function') ? window._esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  };

  // ── state ──────────────────────────────────────────────────────────────────
  var OT = {
    open: false,
    on: false,             // is the SERVER tracing
    paused: false,         // is this panel accepting frames
    traces: [],            // newest last
    byId: {},
    expanded: {},
    filter: { category: '', status: '', route: '', q: '' },
    reader: null,          // the live stream's abort handle
    status: null,
    CONFIG: null,          // the server's thresholds — never a second copy
  };
  window._OT = OT;

  // The grading table comes from the server with the status, so a threshold is
  // stated once and read here rather than restated. Until it has arrived,
  // nothing is graded.
  function speedOf(ms) {
    var C = OT.CONFIG && OT.CONFIG.SPEED;
    if (!C || typeof ms !== 'number') return '';
    if (ms <= C.FAST) return 'FAST';
    if (ms <= C.NORMAL) return 'NORMAL';
    if (ms <= C.SLOW) return 'SLOW';
    return 'CRITICAL';
  }

  // ── the browser's own stages ───────────────────────────────────────────────
  //
  // The click, the state write and the paint happen where the server cannot see
  // them, and half of any latency question lives there. They are posted in small
  // batches under the SAME request id the call carried, which is what puts a
  // click and a query on one timeline.
  //
  // Batched rather than sent one at a time: a diagnostic that issues a request
  // per mouse click is a diagnostic that changes what it measures.
  var pending = [];
  var flushing = false;
  function flush() {
    if (flushing || !pending.length || !OT.on) { pending.length = 0; return; }
    flushing = true;
    var batch = pending.splice(0, 40);
    API().request('POST', '/system/trace/client', { body: { stages: batch } })
      .catch(function () { /* a diagnostic that fails is quiet */ })
      .then(function () { flushing = false; if (pending.length) flush(); });
  }

  /**
   * Report something the browser did. Public, so the application can call it.
   *
   * Free when tracing is off — it is a boolean test and a return, and the
   * application never learns whether anybody is watching.
   */
  window.famTrace = function (id, category, name, opts) {
    if (!OT.on || !id) return;
    try {
      opts = opts || {};
      pending.push({
        id: String(id).slice(0, 200),
        category: category,
        name: String(name || '').slice(0, 80),
        durationMs: opts.durationMs,
        outcome: opts.outcome || 'ok',
        detail: opts.detail,
      });
      if (pending.length >= 20) flush();
      else if (!flushing) setTimeout(flush, 250);
    } catch (_) { /* never let a diagnostic break the thing it watches */ }
  };

  // ── the live stream ────────────────────────────────────────────────────────
  //
  // `fetch` with a reader rather than `EventSource`, so the token travels in the
  // Authorization header like every other call. EventSource cannot set headers,
  // and the alternative — a credential in the query string — is written to every
  // proxy log between here and the browser.
  function connect() {
    if (OT.reader) return;
    var ctrl = new AbortController();
    OT.reader = ctrl;
    var base = (typeof FAM_CONFIG !== 'undefined' && FAM_CONFIG.API_BASE) || '/api/v1';
    var token = API().getToken ? API().getToken() : null;
    fetch(base + '/system/trace/stream', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      credentials: 'include',
      signal: ctrl.signal,
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('stream ' + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { OT.reader = null; return; }
          buf += decoder.decode(r.value, { stream: true });
          var frames = buf.split('\n\n');
          buf = frames.pop() || '';
          frames.forEach(handleFrame);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      OT.reader = null;
      // The stream ends when tracing is turned off, or when the connection
      // drops. Neither is an error worth a toast on a diagnostic panel.
    });
  }

  function disconnect() {
    if (!OT.reader) return;
    try { OT.reader.abort(); } catch (_) { /* already gone */ }
    OT.reader = null;
  }

  function handleFrame(frame) {
    if (!frame || frame.charAt(0) === ':') return;      // keepalive
    var event = '', data = '';
    frame.split('\n').forEach(function (line) {
      if (line.indexOf('event: ') === 0) event = line.slice(7);
      else if (line.indexOf('data: ') === 0) data += line.slice(6);
    });
    if (!data) return;
    var payload;
    try { payload = JSON.parse(data); } catch (_) { return; }
    if (event === 'hello') { OT.status = payload; OT.CONFIG = payload.config; paintHead(); return; }
    if (event !== 'trace' && event !== 'stage') return;
    if (OT.paused) return;
    ingest(payload);
  }

  function ingest(trace) {
    var known = OT.byId[trace.id];
    if (known) {
      // Replace the held object's contents rather than the row's node: the list
      // is repainted from state, and a paused panel simply stops ingesting.
      OT.byId[trace.id] = trace;
      for (var i = 0; i < OT.traces.length; i++) {
        if (OT.traces[i].id === trace.id) { OT.traces[i] = trace; break; }
      }
    } else {
      OT.byId[trace.id] = trace;
      OT.traces.push(trace);
      var cap = (OT.CONFIG && OT.CONFIG.BUFFER) || 200;
      while (OT.traces.length > cap) {
        var gone = OT.traces.shift();
        if (gone) delete OT.byId[gone.id];
      }
    }
    schedulePaint();
  }

  // One paint per frame at most, however many stages arrive in it. A stream can
  // deliver dozens of frames in a tick; repainting for each is how a panel
  // becomes the thing slowing the application down.
  var painting = false;
  function schedulePaint() {
    if (painting || !OT.open) return;
    painting = true;
    requestAnimationFrame(function () { painting = false; paintList(); });
  }

  // ── what a trace is worth saying ───────────────────────────────────────────
  function totals(t) {
    var by = {}, slowest = null;
    (t.stages || []).forEach(function (s) {
      var d = s.durationMs || 0;
      by[s.category] = (by[s.category] || 0) + d;
      if (!slowest || d > (slowest.durationMs || 0)) slowest = s;
    });
    var ui = (by.UI || 0) + (by.STATE || 0) + (by.RENDER || 0) + (by.FRONTEND || 0);
    return {
      total: t.totalMs,
      db: by.DB || 0,
      external: by.EXTERNAL || 0,
      frontend: ui,
      slowest: slowest,
    };
  }

  function matches(t) {
    var f = OT.filter;
    if (f.q && t.id.toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
    if (f.route && String(t.route || '').toLowerCase().indexOf(f.route.toLowerCase()) < 0) return false;
    if (f.status) {
      var s = t.status || 0;
      if (f.status === '2xx' && !(s >= 200 && s < 300)) return false;
      if (f.status === '4xx' && !(s >= 400 && s < 500)) return false;
      if (f.status === '5xx' && s < 500) return false;
    }
    if (f.category && !(t.stages || []).some(function (s) { return s.category === f.category; })) return false;
    return true;
  }

  // ── the drawer ─────────────────────────────────────────────────────────────
  function shell() {
    if (document.getElementById('ot-drawer')) return;
    var d = document.createElement('div');
    d.id = 'ot-drawer';
    d.className = 'ot-drawer';
    d.setAttribute('role', 'complementary');
    d.setAttribute('aria-label', 'Live request trace');
    d.innerHTML = '<div class="ot-head" id="ot-head"></div>'
      + '<div class="ot-filters" id="ot-filters"></div>'
      + '<div class="ot-list" id="ot-list"></div>';
    document.body.appendChild(d);
  }

  var CATEGORIES = ['UI', 'FRONTEND', 'API', 'AUTH', 'AUTHZ', 'SERVICE',
    'DB', 'CACHE', 'EXTERNAL', 'RESPONSE', 'STATE', 'RENDER', 'ERROR'];

  function paintHead() {
    var el = document.getElementById('ot-head');
    if (!el) return;
    var st = OT.status || {};
    el.innerHTML = '<div class="ot-title">'
      + '<span class="ot-dot' + (OT.on ? ' is-on' : '') + '"></span>'
      + '<b>' + (OT.on ? 'LIVE TRACE ON' : 'Live trace') + '</b>'
      + (OT.on && st.remainingMs
        ? '<i class="ot-exp">expires in ' + Math.max(1, Math.round(st.remainingMs / 60000)) + ' min</i>' : '')
      + '<button type="button" class="ot-x" data-ot="close" aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="ot-acts">'
      + '<button type="button" class="ot-btn' + (OT.on ? ' is-on' : '') + '" data-ot="toggle">'
      + (OT.on ? 'Stop tracing' : 'Start tracing') + '</button>'
      + '<button type="button" class="ot-btn" data-ot="pause"' + (OT.on ? '' : ' disabled') + '>'
      + (OT.paused ? 'Resume' : 'Pause') + '</button>'
      + '<button type="button" class="ot-btn" data-ot="clear">Clear</button>'
      + '<span class="ot-count">' + OT.traces.length + ' held</span>'
      + '</div>';
  }

  function paintFilters() {
    var el = document.getElementById('ot-filters');
    if (!el) return;
    var f = OT.filter;
    el.innerHTML = '<input class="ot-in" data-ot-f="q" placeholder="Request ID" value="' + esc(f.q) + '">'
      + '<input class="ot-in" data-ot-f="route" placeholder="Route or module" value="' + esc(f.route) + '">'
      + '<select class="ot-in" data-ot-f="category"><option value="">All stages</option>'
      + CATEGORIES.map(function (c) {
        return '<option value="' + c + '"' + (f.category === c ? ' selected' : '') + '>' + c + '</option>';
      }).join('') + '</select>'
      + '<select class="ot-in" data-ot-f="status"><option value="">Any status</option>'
      + ['2xx', '4xx', '5xx'].map(function (s) {
        return '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select>';
  }

  function paintList() {
    var el = document.getElementById('ot-list');
    if (!el) return;
    var rows = OT.traces.filter(matches);
    if (!rows.length) {
      el.innerHTML = '<div class="ot-empty">'
        + (OT.on ? 'Waiting for requests. Use Familista in another tab or below — every call appears here.'
          : 'Tracing is off. Start it above, and it will stop on its own after a while.')
        + '</div>';
      return;
    }
    el.innerHTML = rows.slice().reverse().map(row).join('');
  }

  function row(t) {
    var m = totals(t);
    var speed = speedOf(m.total);
    var bad = (t.status || 0) >= 400;
    var open = !!OT.expanded[t.id];
    var short = t.id.replace(/^fam-/, '').slice(0, 8).toUpperCase();
    return '<div class="ot-row' + (bad ? ' is-bad' : '') + (speed ? ' is-' + speed.toLowerCase() : '') + '">'
      + '<button type="button" class="ot-row-h" data-ot="expand" data-id="' + esc(t.id) + '" aria-expanded="' + open + '">'
      +   '<span class="ot-id">' + esc(short) + '</span>'
      +   '<span class="ot-m">' + esc(t.method || '') + '</span>'
      +   '<span class="ot-route">' + esc(t.route || '') + '</span>'
      +   '<span class="ot-st' + (bad ? ' is-bad' : '') + '">' + (t.status || '…') + '</span>'
      +   '<span class="ot-ms">' + (t.totalMs != null ? t.totalMs + ' ms' : '…') + '</span>'
      +   (speed ? '<span class="ot-speed ot-speed--' + speed.toLowerCase() + '">' + speed + '</span>' : '')
      + '</button>'
      + (open ? detail(t, m) : '')
      + '</div>';
  }

  function detail(t, m) {
    return '<div class="ot-detail">'
      + '<div class="ot-sums">'
      +   sum('Total', t.totalMs) + sum('Database', m.db) + sum('External', m.external)
      +   sum('Browser', m.frontend)
      +   (m.slowest ? '<span class="ot-sum"><i>Slowest</i><b>' + esc(m.slowest.category) + ' '
          + esc(m.slowest.name) + '</b></span>' : '')
      + '</div>'
      + '<ol class="ot-stages">'
      + (t.stages || []).map(function (s) {
        return '<li class="ot-stage ot-stage--' + s.outcome + '">'
          + '<span class="ot-at">' + s.at + ' ms</span>'
          + '<span class="ot-cat ot-cat--' + esc(s.category) + '">' + esc(s.category) + '</span>'
          + '<span class="ot-name">' + esc(s.name) + '</span>'
          + (s.durationMs != null ? '<span class="ot-dur">' + s.durationMs + ' ms</span>' : '')
          + '</li>';
      }).join('')
      + '</ol>'
      + '<div class="ot-foot">'
      +   '<span class="ot-ctx">' + esc(t.id) + (t.clubId ? ' · club ' + esc(t.clubId) : '')
      +     (t.actorRole ? ' · ' + esc(t.actorRole) : '') + '</span>'
      +   '<button type="button" class="ot-btn" data-ot="copy" data-id="' + esc(t.id) + '">Copy trace</button>'
      + '</div>'
      + '</div>';
  }

  function sum(label, ms) {
    return '<span class="ot-sum"><i>' + label + '</i><b>' + (ms != null ? ms + ' ms' : '—') + '</b></span>';
  }

  // ── control ────────────────────────────────────────────────────────────────
  function refreshStatus() {
    return API().request('GET', '/system/trace/status').then(function (r) {
      var d = (r && r.data) || {};
      OT.status = d;
      OT.on = !!d.enabled;
      OT.CONFIG = d.config || OT.CONFIG;
      paintHead();
      if (OT.on) connect(); else disconnect();
      return d;
    }).catch(function () { /* not the owner, or not reachable: the panel stays shut */ });
  }

  function setTracing(on) {
    return API().request('POST', '/system/trace/' + (on ? 'enable' : 'disable'), { body: {} })
      .then(function () {
        if (!on) { OT.traces = []; OT.byId = {}; }
        return refreshStatus();
      })
      .then(function () { paintList(); })
      .catch(function () { /* the server said no, and it is the one that decides */ });
  }

  window.openOwnerTrace = function () {
    shell();
    OT.open = true;
    document.getElementById('ot-drawer').classList.add('is-open');
    document.documentElement.classList.add('ot-drawer-open');
    paintHead(); paintFilters(); paintList();
    refreshStatus();
  };
  window.closeOwnerTrace = function () {
    OT.open = false;
    var d = document.getElementById('ot-drawer');
    if (d) d.classList.remove('is-open');
    document.documentElement.classList.remove('ot-drawer-open');
  };

  // One delegated listener for the drawer, registered once. The panel repaints
  // its own regions and never the application behind it.
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-ot]');
    if (!el) return;
    var what = el.getAttribute('data-ot');
    if (what === 'close') { window.closeOwnerTrace(); return; }
    if (what === 'toggle') { setTracing(!OT.on); return; }
    if (what === 'pause') { OT.paused = !OT.paused; paintHead(); return; }
    if (what === 'clear') { OT.traces = []; OT.byId = {}; OT.expanded = {}; paintHead(); paintList(); return; }
    if (what === 'expand') {
      var id = el.getAttribute('data-id');
      OT.expanded[id] = !OT.expanded[id];
      paintList();
      return;
    }
    if (what === 'copy') {
      var t = OT.byId[el.getAttribute('data-id')];
      if (!t) return;
      // What is copied is what was received, and what was received has already
      // been through the server's redaction. There is nothing here to strip.
      try { navigator.clipboard.writeText(JSON.stringify(t, null, 2)); } catch (_) { /* no clipboard */ }
      if (typeof window.showToast === 'function') window.showToast('Trace copied', 'success');
    }
  });

  document.addEventListener('input', function (e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-ot-f');
    if (!f) return;
    OT.filter[f] = e.target.value || '';
    paintList();                 // the list only — the filters keep their focus
  });
  document.addEventListener('change', function (e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-ot-f');
    if (!f) return;
    OT.filter[f] = e.target.value || '';
    paintList();
  });
})();
