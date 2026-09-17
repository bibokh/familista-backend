/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DATA VAULT — the platform's historical memory, as a product

   The third top-level Familista module, beside SYSTEM and CLUBS. SYSTEM
   operates the platform, CLUBS operates football organisations, and the DATA
   VAULT is where somebody asks what actually happened — on a day, in a month,
   to a club, along a correlation chain.

   It owns NO storage. Every figure on every screen below comes from the
   historical infrastructure that already exists behind the Data Fabric:

     GET /system/fabric/history            a page of history, cursor-paginated
     GET /system/fabric/history/count      how many, without moving rows
     GET /system/fabric/history/replay     the same rows, read-only, in order
     GET /system/fabric/history/health     writer, delivery, window, retention,
                                           archive
     GET /system/fabric/history/stats      aggregates, counted in SQL
     GET /system/fabric/history/clubs/:id/summary
     GET /system/fabric/history/entity-types

   This file writes nothing, anywhere, ever. There is no POST, PUT, PATCH or
   DELETE in it, and a test reads the source to keep it that way.

   THREE RULES, INHERITED FROM SYSTEM BECAUSE THEY ARE THE SAME PRODUCT

     1. Real or explicitly absent. A number the platform measures is shown; a
        number nothing measures renders as "—" with the reason underneath.
        A measured zero renders as `0`, because none is not the same answer as
        unknown. There is no third option and no decorative telemetry: no event
        counts, uptimes, byte totals or continent counts that the backend does
        not actually return.
     2. No dead controls. Every control either performs a real read through a
        real endpoint, or is disabled and labelled with why.
     3. The server decides. Every read is authorised by the platform. Hiding a
        control is a courtesy; /api/v1/system/fabric refuses a club account
        whatever is drawn here.

   AND ONE OF ITS OWN

     4. The Vault never reveals what the write path deliberately did not keep.
        The historical store persists an INDEX of what happened, never the
        payload — no passwords, tokens, addresses, medical notes, prompts,
        salaries or private text can reach it, because they were never written.
        The inspector therefore renders an EXPLICIT field list (VISIBLE_FIELDS
        below), not a spread of whatever the API returned, so a field added to
        the API tomorrow cannot appear on a screen nobody reviewed.

   LOCALISATION

     English, German and Arabic, in this module's own catalogue under
     /data-vault/i18n/ — the same boundary SYSTEM keeps. The page root carries
     `data-no-i18n`, so the platform's club-facing locale pass skips this
     subtree entirely and a Data Vault string never enters a club locale file.
     Arabic sets `dir="rtl"` on the shell and the layout follows.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var DV = {
    module: 'overview',
    loading: false,
    error: null,
    /** Answers from the backend. Null means "not asked yet", never "zero". */
    stats: null,
    health: null,
    entityTypes: null,
    /** Explorer */
    filters: null,
    page: null,
    pages: [],          // cursor stack, so "previous" is a real step back
    countTotal: null,
    inspect: null,
    /** Replay */
    replay: null,
    /** Club + entity sections */
    clubs: null,
    clubSummary: null,
    clubId: '',
    entityQuery: null,
    entityPage: null,
    /** Sources */
    sourceFocus: null,
    langOpen: false,
  };

  // ── plumbing ──────────────────────────────────────────────────────────────

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * A count, localised — or an em dash.
   *
   * `0` is a number and renders as `0`. `null` and `undefined` are the absence
   * of an answer and render as `—`. Conflating them is how a dashboard comes to
   * claim a quiet day where it actually has no instrumentation.
   */
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(DV_LANG === 'ar' ? 'ar' : DV_LANG); } catch (_) { return String(n); }
  }

  /** True when a value is a real measurement rather than an absent one. */
  function has(v) { return v !== null && v !== undefined; }

  /**
   * An instant, rendered for a reader.
   *
   * The stored value is UTC and stays UTC in every query; this is presentation
   * only. Both are shown — the reader's local rendering and the UTC instant —
   * because a historical timestamp that quietly shifted by a timezone is a
   * historical timestamp nobody can cite.
   */
  function fmtInstant(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var local;
    try {
      local = new Intl.DateTimeFormat(DV_LANG === 'ar' ? 'ar' : DV_LANG, {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(d);
    } catch (_) { local = d.toISOString().replace('T', ' ').slice(0, 16); }
    return { local: local, utc: d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
  }

  /** `—` with a reason, or the value. The one way an absent figure is drawn. */
  function absent(why) {
    return '<span class="dv-none" title="' + esc(why || '') + '">—</span>';
  }

  function metricHtml(value, why) {
    return has(value) ? esc(num(value)) : absent(why || T('Not measured by the platform.'));
  }

  // ── DATA VAULT localisation — three languages, and only three ─────────────
  //
  // The platform owner's workspace, read by one small group of people. English,
  // German and Arabic, in this module's own catalogue, so Data Vault strings
  // never enter the club product's locale files and the two passes can never
  // translate the same node. The mechanism is the house one: the English on
  // screen IS the key, and a run of digits becomes a %d slot.
  var DV_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var DV_DICT = {};
  var DV_LANG = 'en';
  var DV_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < DV_LOCALES.length; i++) if (DV_LOCALES[i][0] === tag) return DV_LOCALES[i];
    return DV_LOCALES[0];
  }

  /**
   * The stored choice.
   *
   * SYSTEM's key is reused deliberately: a platform owner who set SYSTEM to
   * German has said which language they read, and asking them again in the next
   * room would be the interface forgetting something it was told.
   */
  function storedLocale() {
    try {
      var v = localStorage.getItem('familista_system_locale')
        || localStorage.getItem('familista_datavault_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }

  function loadDict(tag) {
    if (tag === 'en') { DV_DICT = {}; return Promise.resolve(); }
    return fetch('/data-vault/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { DV_DICT = d || {}; })
      .catch(function () { DV_DICT = {}; });
  }

  function setLocale(tag) {
    var l = localeOf(tag);
    DV_LANG = l[0];
    DV_DIR = l[2];
    try { localStorage.setItem('familista_datavault_locale', DV_LANG); } catch (_) {}
    return loadDict(DV_LANG);
  }

  /**
   * One string.
   *
   * A digit run becomes `%d` so "3 events" and "1,204 events" are one entry,
   * and a missing key falls through to the English rather than to a blank or a
   * key path. A gap is a gap; it is not a break.
   */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s) return s;
    if (DV_LANG === 'en') return s;
    if (Object.prototype.hasOwnProperty.call(DV_DICT, s)) return DV_DICT[s];
    var slot = s.replace(/\d[\d.,  ]*/g, '%d');
    if (slot !== s && Object.prototype.hasOwnProperty.call(DV_DICT, slot)) {
      var nums = s.match(/\d[\d.,  ]*/g) || [];
      var i = 0;
      return String(DV_DICT[slot]).replace(/%d/g, function () { return nums[i++] != null ? nums[i - 1] : '%d'; });
    }
    return s;
  }

  /**
   * Translate a freshly drawn subtree.
   *
   * Text nodes and a short list of attributes, skipping anything marked
   * `data-no-i18n` or `data-user-content` — a club name, a person's name and an
   * event type are data, and translating data is a bug.
   */
  function dvTranslate(root) {
    if (!root || DV_LANG === 'en') return;
    var skip = function (el) {
      for (var n = el; n && n !== root.parentNode; n = n.parentNode) {
        if (n.nodeType === 1 && (n.hasAttribute('data-no-i18n') || n.hasAttribute('data-user-content'))) return true;
      }
      return false;
    };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (t) {
      var raw = t.nodeValue;
      if (!raw || !raw.trim()) return;
      if (t.parentNode && skip(t.parentNode)) return;
      var lead = raw.match(/^\s*/)[0];
      var tail = raw.match(/\s*$/)[0];
      var out = T(raw.trim());
      if (out !== raw.trim()) t.nodeValue = lead + out + tail;
    });
    ['title', 'aria-label', 'placeholder'].forEach(function (attr) {
      root.querySelectorAll('[' + attr + ']').forEach(function (el) {
        if (skip(el)) return;
        var v = el.getAttribute(attr);
        if (v && v.trim()) el.setAttribute(attr, T(v.trim()));
      });
    });
  }

  function languageSwitchHtml() {
    var active = localeOf(DV_LANG);
    return '<div class="dv-langs' + (DV.langOpen ? ' is-open' : '') + '">'
      + '<button class="dv-lang-pick" type="button" data-dv-langs'
      + ' aria-expanded="' + (DV.langOpen ? 'true' : 'false') + '" aria-label="Data Vault language">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="dv-lang-ch">⌄</span></button>'
      + '<div class="dv-lang-menu" role="group">'
      + DV_LOCALES.map(function (l) {
        return '<button class="dv-lang' + (l[0] === DV_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-dv-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === DV_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  // ── the one way this module talks to the platform ────────────────────────
  //
  // Read-only by construction: no `method` is ever passed, so every call is a
  // GET. The Data Vault has nothing to write.
  function api(path) {
    var base = (typeof FAM_CONFIG !== 'undefined' && FAM_CONFIG.API_BASE)
      ? FAM_CONFIG.API_BASE : '/api/v1';
    var token = '';
    try { token = (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) {}
    return fetch(base + path, {
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
      ),
      credentials: 'include',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error((body && (body.message || body.error)) || ('HTTP ' + r.status));
        return body.data != null ? body.data : body;
      });
    });
  }

  // ── navigation ────────────────────────────────────────────────────────────

  var MODULES = [
    ['overview', 'Overview', '◎', 'VAULT'],
    ['explorer', 'Historical Explorer', '⌕', 'VAULT'],
    ['replay', 'Timeline & Replay', '⏵', 'VAULT'],
    ['clubs', 'Club History', '⬢', 'CONTEXT'],
    ['entities', 'Entity History', '⚇', 'CONTEXT'],
    ['sources', 'Sources', '⇝', 'CONTEXT'],
    ['storage', 'Storage', '⛁', 'INFRASTRUCTURE'],
    ['archive', 'Long-Term Archive', '❄', 'INFRASTRUCTURE'],
    ['integrity', 'Integrity & Provenance', '⛨', 'GOVERNANCE'],
    ['retention', 'Retention & Governance', '⚖', 'GOVERNANCE'],
  ];
  var GROUP_ORDER = ['VAULT', 'CONTEXT', 'INFRASTRUCTURE', 'GOVERNANCE'];
  var GROUP_LABEL = {
    VAULT: 'Vault', CONTEXT: 'Context',
    INFRASTRUCTURE: 'Infrastructure', GOVERNANCE: 'Governance',
  };

  function railHtml() {
    var groups = GROUP_ORDER.map(function (g) {
      var items = MODULES.filter(function (m) { return m[3] === g; });
      if (!items.length) return '';
      return '<div class="dv-rail-group"><div class="dv-rail-label">' + esc(T(GROUP_LABEL[g])) + '</div>'
        + items.map(function (m) {
          return '<button class="dv-rail-item' + (DV.module === m[0] ? ' is-on' : '') + '"'
            + ' type="button" data-dv-nav="' + m[0] + '"'
            + ' aria-current="' + (DV.module === m[0] ? 'page' : 'false') + '">'
            + '<span class="dv-rail-icon" aria-hidden="true">' + m[2] + '</span>'
            + '<span class="dv-rail-text">' + esc(T(m[1])) + '</span></button>';
        }).join('')
        + '</div>';
    }).join('');

    return '<nav class="dv-rail" aria-label="Data Vault">'
      + '<div class="dv-rail-head">'
      + '<button class="dv-rail-home" type="button" data-dv-home aria-label="Back to Familista home">'
      + '<span aria-hidden="true">←</span><span class="dv-rail-text" data-no-i18n>Familista</span></button>'
      + '<div class="dv-rail-brand"><span class="dv-rail-mark" aria-hidden="true">⛁</span>'
      + '<span class="dv-rail-title" data-no-i18n>Data Vault</span></div>'
      + '</div>'
      + '<div class="dv-rail-body">' + groups + '</div>'
      + '<div class="dv-rail-foot"><span>' + esc(T('Historical Memory')) + '</span></div>'
      + '</nav>';
  }

  /** The state chip in the top bar. Real health, or the reason it is unknown. */
  function vaultStateHtml() {
    if (DV.error) return '<span class="dv-chip dv-chip--bad">' + esc(T('Unavailable')) + '</span>';
    if (!DV.health) return '<span class="dv-chip dv-chip--idle">' + esc(T('Loading…')) + '</span>';
    var w = DV.health.writer || {};
    var total = DV.health.window ? DV.health.window.total : null;
    if (w.state && String(w.state).toUpperCase() !== 'OK' && String(w.state).toUpperCase() !== 'HEALTHY') {
      return '<span class="dv-chip dv-chip--warn">' + esc(T('Writer degraded')) + '</span>';
    }
    if (total === 0) return '<span class="dv-chip dv-chip--idle">' + esc(T('No historical events yet')) + '</span>';
    return '<span class="dv-chip dv-chip--ok">' + esc(T('Historical store healthy')) + '</span>';
  }

  function topHtml() {
    var mod = MODULES.filter(function (m) { return m[0] === DV.module; })[0] || MODULES[0];
    return '<header class="dv-top">'
      + '<div class="dv-top-l">'
      + '<div class="dv-top-eyebrow" data-no-i18n>Familista · Data Vault</div>'
      + '<h1 class="dv-top-title">' + esc(T(mod[1])) + '</h1>'
      + '</div>'
      + '<div class="dv-top-r">' + vaultStateHtml() + languageSwitchHtml() + '</div>'
      + '</header>';
  }

  // ── shared fragments ──────────────────────────────────────────────────────

  function panel(title, body, note) {
    return '<section class="dv-panel">'
      + (title ? '<div class="dv-panel-head"><h2 class="dv-panel-title">' + esc(T(title)) + '</h2>'
        + (note ? '<span class="dv-panel-note">' + esc(note) + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }

  function emptyState(title, detail) {
    return '<div class="dv-empty"><div class="dv-empty-mark" aria-hidden="true">⌀</div>'
      + '<div class="dv-empty-title">' + esc(T(title)) + '</div>'
      + (detail ? '<div class="dv-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  /**
   * A skeleton the size of the content it stands in for.
   *
   * Not a spinner in the middle of an empty box: when the answer arrives the
   * panel must not change height, because a page that resettles under the
   * reader has moved something they did not move.
   */
  function skeleton(rows) {
    var out = '';
    for (var i = 0; i < (rows || 3); i++) out += '<div class="dv-skel-row"></div>';
    return '<div class="dv-skel" aria-hidden="true">' + out + '</div>';
  }

  function stat(label, value, why, hint) {
    return '<div class="dv-stat">'
      + '<div class="dv-stat-label">' + esc(T(label)) + '</div>'
      + '<div class="dv-stat-value">' + metricHtml(value, why) + '</div>'
      + (hint ? '<div class="dv-stat-hint">' + esc(hint) + '</div>' : '')
      + '</div>';
  }

  /** An instant, or an honest dash. Both renderings, so the UTC is citable. */
  function instantHtml(iso, absentWhy) {
    var t = fmtInstant(iso);
    if (!t) return '<div class="dv-stat-value">' + absent(absentWhy || T('Nothing recorded yet.')) + '</div>';
    return '<div class="dv-stat-value dv-stat-value--time" data-no-i18n>' + esc(t.local) + '</div>'
      + '<div class="dv-stat-hint" data-no-i18n>' + esc(t.utc) + '</div>';
  }

  // ── OVERVIEW ──────────────────────────────────────────────────────────────

  /**
   * The vault diagram.
   *
   * Three pillars under one core, and a rail beneath them — the actual shape of
   * the platform's historical path, not a decoration. Each pillar carries its
   * own real state, and the one that is not built says so on its face rather
   * than in a tooltip: an architecture drawing that implies a cold archive
   * exists is the drawing that gets somebody to delete the hot rows.
   *
   * The source chips are the REGISTRY's, fetched, never a list kept here.
   */
  function vaultDiagramHtml() {
    var s = DV.stats;
    var h = DV.health;
    var archive = h && h.archive ? h.archive : null;
    var total = s ? s.total : null;

    var chips = s && s.sources && s.sources.length
      ? s.sources.map(function (src) {
        var live = src.total > 0;
        return '<button class="dv-src-chip' + (live ? ' is-live' : '') + '" type="button"'
          + ' data-dv-source="' + esc(src.source) + '"'
          + ' title="' + esc(src.name + ' · ' + (live ? num(src.total) + ' recorded' : 'none recorded yet')) + '">'
          + '<span class="dv-src-dot" aria-hidden="true"></span>'
          + '<span class="dv-src-name" data-user-content>' + esc(src.name) + '</span>'
          + '<span class="dv-src-count" data-no-i18n>' + (live ? esc(num(src.total)) : '0') + '</span>'
          + '</button>';
      }).join('')
      : '<div class="dv-src-empty">' + esc(T('No sources registered.')) + '</div>';

    var pillar = function (key, title, sub, state, stateKind, detail) {
      return '<div class="dv-pillar dv-pillar--' + key + '" data-dv-pillar="' + key + '">'
        + '<div class="dv-pillar-state dv-pillar-state--' + stateKind + '">' + esc(state) + '</div>'
        + '<div class="dv-pillar-title">' + esc(title) + '</div>'
        + '<div class="dv-pillar-sub">' + esc(sub) + '</div>'
        + '<div class="dv-pillar-detail">' + detail + '</div>'
        + '</div>';
    };

    var liveDetail = '<span class="dv-pillar-figure">'
      + (s ? esc(num((s.sources || []).filter(function (x) { return x.total > 0; }).length)) : '—')
      + '</span><span class="dv-pillar-unit">' + esc(T('sources recorded')) + '</span>';

    var hotDetail = '<span class="dv-pillar-figure">' + metricHtml(total, T('The historical store has not answered yet.'))
      + '</span><span class="dv-pillar-unit">' + esc(T('events stored')) + '</span>';

    var coldDetail = '<span class="dv-pillar-unit">'
      + esc(archive && archive.missing && archive.missing.length
        ? T('Object storage is not configured.')
        : T('Not configured.'))
      + '</span>';

    return '<div class="dv-diagram">'
      + '<div class="dv-core">'
      + '<div class="dv-core-mark" aria-hidden="true">⛁</div>'
      + '<div class="dv-core-title" data-no-i18n>Familista Data Vault</div>'
      + '<div class="dv-core-sub">' + esc(T('Historical Memory of the Platform')) + '</div>'
      + '</div>'
      + '<div class="dv-feed" aria-label="Registered Data Fabric sources">' + chips + '</div>'
      + '<div class="dv-trunk" aria-hidden="true"></div>'
      + '<div class="dv-pillars">'
      + pillar('live', T('Live Data Fabric'), T('Publishes every platform event'), T('Active'), 'ok', liveDetail)
      + pillar('hot', T('Hot History Store'), T('PostgreSQL · queryable, append-only'),
        (total === 0 ? T('Empty') : T('Active')), (total === 0 ? 'idle' : 'ok'), hotDetail)
      + pillar('cold', T('Long-Term Archive'), T('Partitioned cold export'), T('Not configured'), 'off', coldDetail)
      + '</div>'
      + '<div class="dv-trunk dv-trunk--down" aria-hidden="true"></div>'
      + '<div class="dv-rail-out">'
      + '<button class="dv-out" type="button" data-dv-nav="explorer">' + esc(T('Query')) + '</button>'
      + '<button class="dv-out" type="button" data-dv-nav="replay">' + esc(T('Replay')) + '</button>'
      + '<button class="dv-out" type="button" data-dv-nav="integrity">' + esc(T('Audit')) + '</button>'
      + '</div>'
      + '</div>';
  }

  function overviewHtml() {
    if (DV.error) return panel('', emptyState(T('The Data Vault could not be read'), DV.error));

    var s = DV.stats;
    var h = DV.health;
    var w = (h && h.writer) || null;
    var d = (h && h.delivery) || null;
    var win = (h && h.window) || null;

    var head = '<section class="dv-hero">' + vaultDiagramHtml() + '</section>';

    if (!s || !h) {
      return head + panel(T('Overview'), skeleton(4));
    }

    var counts = '<div class="dv-stats dv-stats--4">'
      + stat(T('Total historical events'), s.total)
      + stat(T('Events today'), s.today, null, T('Since 00:00 UTC'))
      + stat(T('Events this month'), s.month)
      + stat(T('Events this year'), s.year)
      + '</div>';

    var range = '<div class="dv-stats dv-stats--2">'
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('History available from')) + '</div>'
      + instantHtml(win ? win.earliest : null, T('No event has been recorded yet.')) + '</div>'
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('History available until')) + '</div>'
      + (win && win.latest
        ? instantHtml(win.latest)
        : '<div class="dv-stat-value">' + absent(T('No event has been recorded yet.')) + '</div>')
      + '</div>'
      + '</div>';

    var activeSources = (s.sources || []).filter(function (x) { return x.total > 0; }).length;

    var writerState = w && w.state ? String(w.state) : null;
    var ops = '<div class="dv-stats dv-stats--4">'
      + stat(T('Active historical sources'), activeSources, null,
        T('of') + ' ' + num((s.sources || []).length) + ' ' + T('registered'))
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('Historical writer')) + '</div>'
      + '<div class="dv-stat-value">' + (writerState
        ? '<span class="dv-chip dv-chip--' + (writerState.toUpperCase() === 'OK' || writerState.toUpperCase() === 'HEALTHY' ? 'ok' : 'warn') + '" data-no-i18n>' + esc(writerState) + '</span>'
        : absent(T('The writer has not reported.'))) + '</div>'
      + '<div class="dv-stat-hint">' + esc(T('Counters reset on restart; durability is in the tables.')) + '</div></div>'
      + stat(T('Pending deliveries'), d && has(d.pending) ? d.pending : null,
        T('Delivery recovery has not reported.'), T('Outbox rows with no historical row'))
      + stat(T('Failed writes'), w && has(w.failures) ? w.failures : null,
        T('The writer has not reported.'))
      + '</div>';

    var archive = h.archive || {};
    var links = '<div class="dv-cards">'
      + '<button class="dv-card" type="button" data-dv-nav="explorer">'
      + '<div class="dv-card-title">' + esc(T('Historical Explorer')) + '</div>'
      + '<div class="dv-card-sub">' + esc(T('Search recorded history by date, source, club, entity or correlation.')) + '</div></button>'
      + '<button class="dv-card" type="button" data-dv-nav="replay">'
      + '<div class="dv-card-title">' + esc(T('Timeline & Replay')) + '</div>'
      + '<div class="dv-card-sub">' + esc(T('Watch a window of history in the order it happened. Read-only.')) + '</div></button>'
      + '<button class="dv-card" type="button" data-dv-nav="archive">'
      + '<div class="dv-card-title">' + esc(T('Long-Term Archive')) + '</div>'
      + '<div class="dv-card-sub">' + esc(archive.enabled ? T('Configured.') : T('Not configured. Nothing is exported and nothing is purged.')) + '</div></button>'
      + '</div>';

    return head
      + panel(T('Historical volume'), counts)
      + panel(T('Storage date range'), range,
        T('Reliable history begins at the first recorded event, not at deployment.'))
      + panel(T('Operational state'), ops)
      + panel(T('Go to'), links);
  }

  // ── date navigation ───────────────────────────────────────────────────────
  //
  // Every preset resolves to an explicit UTC [from, to). The arithmetic is UTC
  // so two readers in two zones agree what "today" counted; the rendering is
  // local so each of them can read it.

  function utcBounds(preset, now) {
    var n = now || new Date();
    var y = n.getUTCFullYear(), m = n.getUTCMonth(), d = n.getUTCDate();
    var day = function (yy, mm, dd) { return new Date(Date.UTC(yy, mm, dd, 0, 0, 0, 0)); };
    var end = new Date(n.getTime());
    switch (preset) {
      case 'today':      return { from: day(y, m, d), to: end };
      case 'yesterday':  return { from: day(y, m, d - 1), to: new Date(day(y, m, d).getTime() - 1) };
      case 'last7':      return { from: day(y, m, d - 6), to: end };
      case 'month':      return { from: day(y, m, 1), to: end };
      case 'lastMonth':  return { from: day(y, m - 1, 1), to: new Date(day(y, m, 1).getTime() - 1) };
      case 'year':       return { from: day(y, 0, 1), to: end };
      default:           return { from: null, to: null };
    }
  }

  /** A Y/M/D/hour drill-down resolved to the same explicit UTC pair. */
  function drillBounds(sel) {
    if (!sel || !has(sel.year)) return { from: null, to: null };
    var y = Number(sel.year);
    if (!has(sel.month)) {
      return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1) - 1) };
    }
    var m = Number(sel.month);
    if (!has(sel.day)) {
      return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1) - 1) };
    }
    var d = Number(sel.day);
    if (!has(sel.hour)) {
      return { from: new Date(Date.UTC(y, m, d)), to: new Date(Date.UTC(y, m, d + 1) - 1) };
    }
    var hh = Number(sel.hour);
    var span = has(sel.hourSpan) ? Number(sel.hourSpan) : 1;
    return { from: new Date(Date.UTC(y, m, d, hh)), to: new Date(Date.UTC(y, m, d, hh + span) - 1) };
  }

  function defaultFilters() {
    return {
      preset: 'last7', drill: null, from: null, to: null,
      source: '', eventType: '', clubId: '', entityType: '', entityId: '',
      correlationId: '', retentionClass: '', limit: 50,
    };
  }

  /** Filters → query string. Only supported, indexed fields ever travel. */
  function queryFrom(f, cursor) {
    var b = f.preset === 'custom' || f.drill
      ? (f.drill ? drillBounds(f.drill) : { from: f.from ? new Date(f.from) : null, to: f.to ? new Date(f.to) : null })
      : utcBounds(f.preset);
    var q = [];
    var put = function (k, v) { if (v) q.push(k + '=' + encodeURIComponent(v)); };
    if (b.from) put('from', b.from.toISOString());
    if (b.to) put('to', b.to.toISOString());
    put('source', f.source);
    put('eventType', f.eventType);
    put('clubId', f.clubId);
    put('entityType', f.entityType);
    put('entityId', f.entityId);
    put('correlationId', f.correlationId);
    put('retentionClass', f.retentionClass);
    put('limit', String(f.limit || 50));
    if (cursor) put('cursor', cursor);
    return q.length ? '?' + q.join('&') : '';
  }

  var PRESETS = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'],
    ['month', 'This month'], ['lastMonth', 'Last month'], ['year', 'This year'],
    ['custom', 'Custom range'],
  ];

  function dateNavHtml(f) {
    var chips = PRESETS.map(function (p) {
      return '<button class="dv-preset' + (f.preset === p[0] && !f.drill ? ' is-on' : '') + '"'
        + ' type="button" data-dv-preset="' + p[0] + '">' + esc(T(p[1])) + '</button>';
    }).join('');

    var custom = f.preset === 'custom'
      ? '<div class="dv-custom">'
        + '<label class="dv-field"><span>' + esc(T('From (UTC)')) + '</span>'
        + '<input type="datetime-local" data-dv-from value="' + esc(f.from || '') + '"></label>'
        + '<label class="dv-field"><span>' + esc(T('To (UTC)')) + '</span>'
        + '<input type="datetime-local" data-dv-to value="' + esc(f.to || '') + '"></label>'
        + '</div>'
      : '';

    var d = f.drill || {};
    var years = [];
    var thisYear = new Date().getUTCFullYear();
    for (var y = thisYear; y >= thisYear - 6; y--) years.push(y);
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];

    var drill = '<div class="dv-drill">'
      + '<div class="dv-drill-label">' + esc(T('Or pick a period')) + '</div>'
      + '<div class="dv-drill-row">'
      + '<select data-dv-drill="year" aria-label="' + esc(T('Year')) + '">'
      + '<option value="">' + esc(T('Year')) + '</option>'
      + years.map(function (yy) {
        return '<option value="' + yy + '"' + (String(d.year) === String(yy) ? ' selected' : '') + ' data-no-i18n>' + yy + '</option>';
      }).join('') + '</select>'
      + '<select data-dv-drill="month" aria-label="' + esc(T('Month')) + '"' + (has(d.year) ? '' : ' disabled') + '>'
      + '<option value="">' + esc(T('Month')) + '</option>'
      + months.map(function (mn, i) {
        return '<option value="' + i + '"' + (String(d.month) === String(i) ? ' selected' : '') + '>' + esc(T(mn)) + '</option>';
      }).join('') + '</select>'
      + '<select data-dv-drill="day" aria-label="' + esc(T('Day')) + '"' + (has(d.month) ? '' : ' disabled') + '>'
      + '<option value="">' + esc(T('Day')) + '</option>'
      + (function () {
        var out = '';
        var dim = has(d.year) && has(d.month) ? new Date(Date.UTC(Number(d.year), Number(d.month) + 1, 0)).getUTCDate() : 31;
        for (var i = 1; i <= dim; i++) out += '<option value="' + i + '"' + (String(d.day) === String(i) ? ' selected' : '') + ' data-no-i18n>' + i + '</option>';
        return out;
      })() + '</select>'
      + '<select data-dv-drill="hour" aria-label="' + esc(T('Time')) + '"' + (has(d.day) ? '' : ' disabled') + '>'
      + '<option value="">' + esc(T('All day')) + '</option>'
      + (function () {
        var out = '';
        for (var i = 0; i < 24; i++) {
          var lbl = (i < 10 ? '0' + i : i) + ':00';
          out += '<option value="' + i + '"' + (String(d.hour) === String(i) ? ' selected' : '') + ' data-no-i18n>' + lbl + '</option>';
        }
        return out;
      })() + '</select>'
      + (f.drill ? '<button class="dv-btn dv-btn--ghost" type="button" data-dv-drill-clear>' + esc(T('Clear')) + '</button>' : '')
      + '</div></div>';

    var b = f.drill ? drillBounds(f.drill) : (f.preset === 'custom'
      ? { from: f.from ? new Date(f.from) : null, to: f.to ? new Date(f.to) : null }
      : utcBounds(f.preset));
    var shown = b.from && b.to
      ? '<div class="dv-window" data-no-i18n>' + esc(b.from.toISOString().replace('T', ' ').slice(0, 19))
        + ' → ' + esc(b.to.toISOString().replace('T', ' ').slice(0, 19)) + ' UTC</div>'
      : '<div class="dv-window">' + esc(T('No time bound — the whole store.')) + '</div>';

    return '<div class="dv-datenav">'
      + '<div class="dv-presets">' + chips + '</div>' + custom + drill + shown + '</div>';
  }

  // ── HISTORICAL EXPLORER ───────────────────────────────────────────────────

  /**
   * THE FIELD ALLOW-LIST.
   *
   * What the inspector may draw, named one by one. Not a spread of the API
   * response and not "everything except": a field added to the historical API
   * next year must be reviewed by a person and added here before it can reach a
   * screen. This mirrors the explicit list in `history-record.ts`, which is the
   * boundary on the way in; this is the boundary on the way out.
   *
   * Nothing in this list is or can be a payload. The payload was never written.
   */
  var VISIBLE_FIELDS = [
    ['eventId', 'Event ID'],
    ['eventType', 'Event type'],
    ['source', 'Source'],
    ['schemaVersion', 'Schema version'],
    ['occurredAt', 'Occurred at'],
    ['persistedAt', 'Persisted at'],
    ['entityType', 'Entity type'],
    ['entityId', 'Entity ID'],
    ['clubId', 'Club'],
    ['teamContext', 'Team context'],
    ['ageGroup', 'Age group'],
    ['correlationId', 'Correlation ID'],
    ['requestId', 'Request ID'],
    ['status', 'Status'],
    ['privacyClassification', 'Privacy classification'],
    ['retentionClass', 'Retention class'],
    ['metadata', 'Changed fields'],
  ];

  function sourceLabel(id) {
    var s = DV.stats && DV.stats.sources
      ? DV.stats.sources.filter(function (x) { return x.source === id; })[0] : null;
    return s ? s.name : id;
  }

  function eventRowHtml(r, i) {
    var t = fmtInstant(r.occurredAt);
    return '<button class="dv-event" type="button" data-dv-event="' + i + '">'
      + '<span class="dv-event-time" data-no-i18n>' + esc(t ? t.local : '—') + '</span>'
      + '<span class="dv-event-src" data-user-content>' + esc(sourceLabel(r.source)) + '</span>'
      + '<span class="dv-event-type" data-no-i18n>' + esc(r.eventType) + '</span>'
      + '<span class="dv-event-ent" data-no-i18n>' + esc(r.entityType || '—') + '</span>'
      + '<span class="dv-event-status dv-event-status--' + esc(String(r.status || '').toLowerCase()) + '"'
      + ' data-no-i18n>' + esc(r.status || '—') + '</span>'
      + '</button>';
  }

  function timelineHtml(rows, emptyTitle, emptyDetail) {
    if (!rows) return skeleton(8);
    if (!rows.length) return emptyState(emptyTitle, emptyDetail);
    return '<div class="dv-timeline" role="list">'
      + '<div class="dv-event dv-event--head" aria-hidden="true">'
      + '<span>' + esc(T('Time')) + '</span><span>' + esc(T('Source')) + '</span>'
      + '<span>' + esc(T('Event type')) + '</span><span>' + esc(T('Entity')) + '</span>'
      + '<span>' + esc(T('Status')) + '</span></div>'
      + rows.map(eventRowHtml).join('') + '</div>';
  }

  function explorerHtml() {
    var f = DV.filters || (DV.filters = defaultFilters());
    var p = DV.page;

    var srcOptions = '<option value="">' + esc(T('All sources')) + '</option>'
      + ((DV.stats && DV.stats.sources) || []).map(function (s) {
        return '<option value="' + esc(s.source) + '"' + (f.source === s.source ? ' selected' : '')
          + ' data-user-content>' + esc(s.name) + '</option>';
      }).join('');

    var entOptions = '<option value="">' + esc(T('Any entity type')) + '</option>'
      + ((DV.entityTypes && DV.entityTypes.entityTypes) || []).map(function (e) {
        return '<option value="' + esc(e.entityType) + '"' + (f.entityType === e.entityType ? ' selected' : '')
          + ' data-no-i18n>' + esc(e.entityType) + '</option>';
      }).join('');

    var retOptions = '<option value="">' + esc(T('Any retention class')) + '</option>'
      + (((DV.health && DV.health.retention && DV.health.retention.classes) || []).map(function (c) {
        return '<option value="' + esc(c) + '"' + (f.retentionClass === c ? ' selected' : '')
          + ' data-no-i18n>' + esc(c) + '</option>';
      }).join(''));

    var filters = '<div class="dv-filters">'
      + '<label class="dv-field"><span>' + esc(T('Source')) + '</span><select data-dv-f="source">' + srcOptions + '</select></label>'
      + '<label class="dv-field"><span>' + esc(T('Event type')) + '</span>'
      + '<input type="text" data-dv-f="eventType" value="' + esc(f.eventType) + '" placeholder="club.created" data-no-i18n></label>'
      + '<label class="dv-field"><span>' + esc(T('Club ID')) + '</span>'
      + '<input type="text" data-dv-f="clubId" value="' + esc(f.clubId) + '" placeholder="' + esc(T('Exact ID')) + '"></label>'
      + '<label class="dv-field"><span>' + esc(T('Entity type')) + '</span><select data-dv-f="entityType">' + entOptions + '</select></label>'
      + '<label class="dv-field"><span>' + esc(T('Entity ID')) + '</span>'
      + '<input type="text" data-dv-f="entityId" value="' + esc(f.entityId) + '" placeholder="' + esc(T('Exact ID')) + '"></label>'
      + '<label class="dv-field"><span>' + esc(T('Correlation ID')) + '</span>'
      + '<input type="text" data-dv-f="correlationId" value="' + esc(f.correlationId) + '" placeholder="' + esc(T('Exact ID')) + '"></label>'
      + '<label class="dv-field"><span>' + esc(T('Retention class')) + '</span><select data-dv-f="retentionClass">' + retOptions + '</select></label>'
      + '<label class="dv-field"><span>' + esc(T('Page size')) + '</span>'
      + '<select data-dv-f="limit">'
      + [25, 50, 100, 200].map(function (n) {
        return '<option value="' + n + '"' + (Number(f.limit) === n ? ' selected' : '') + ' data-no-i18n>' + n + '</option>';
      }).join('') + '</select></label>'
      + '<div class="dv-filter-actions">'
      + '<button class="dv-btn dv-btn--primary" type="button" data-dv-run>' + esc(T('Search')) + '</button>'
      + '<button class="dv-btn dv-btn--ghost" type="button" data-dv-reset>' + esc(T('Reset')) + '</button>'
      + '</div></div>';

    var countLine = has(DV.countTotal)
      ? '<div class="dv-count" data-no-i18n>' + esc(num(DV.countTotal)) + ' <span>' + esc(T('matching events')) + '</span></div>'
      : '';

    var pager = p
      ? '<div class="dv-pager">'
        + '<button class="dv-btn dv-btn--ghost" type="button" data-dv-prev'
        + (DV.pages.length > 1 ? '' : ' disabled') + '>' + esc(T('Previous')) + '</button>'
        + '<span class="dv-pager-info" data-no-i18n>' + esc(num((p.rows || []).length)) + '</span>'
        + '<button class="dv-btn dv-btn--ghost" type="button" data-dv-next'
        + (p.more ? '' : ' disabled') + '>' + esc(T('Next')) + '</button>'
        + '</div>'
      : '';

    return panel(T('When'), dateNavHtml(f))
      + panel(T('What'), filters)
      + panel(T('Results'), countLine + timelineHtml(p ? p.rows : (DV.loading ? null : []),
        T('No events in this window'),
        T('Nothing was recorded for these filters. Widen the period, or clear a filter.')) + pager,
        has(DV.countTotal) ? null : T('Counted server-side; rows are paged by cursor.'));
  }

  // ── inspector ─────────────────────────────────────────────────────────────

  function inspectorHtml() {
    if (!DV.inspect) return '';
    var r = DV.inspect;
    var rows = VISIBLE_FIELDS.map(function (f) {
      var key = f[0], label = f[1];
      var v = r[key];
      var text;
      if (key === 'occurredAt' || key === 'persistedAt') {
        var t = fmtInstant(v);
        text = t ? (t.local + '  ·  ' + t.utc) : null;
      } else if (key === 'metadata') {
        var names = v && v.changedFields;
        text = Array.isArray(names) && names.length ? names.join(', ') : null;
      } else if (key === 'teamContext') {
        text = v && v.teamId ? String(v.teamId) : null;
      } else if (v === null || v === undefined || v === '') {
        text = null;
      } else {
        text = String(v);
      }
      return '<div class="dv-insp-row"><div class="dv-insp-k">' + esc(T(label)) + '</div>'
        + '<div class="dv-insp-v"' + (text ? ' data-no-i18n' : '') + '>'
        + (text ? esc(text) : absent(T('Not recorded for this event.'))) + '</div></div>';
    }).join('');

    return '<div class="dv-insp-scrim" data-dv-close-insp></div>'
      + '<aside class="dv-insp" role="dialog" aria-label="' + esc(T('Event details')) + '">'
      + '<div class="dv-insp-head">'
      + '<div><div class="dv-insp-title" data-no-i18n>' + esc(r.eventType || '') + '</div>'
      + '<div class="dv-insp-sub" data-user-content>' + esc(sourceLabel(r.source)) + '</div></div>'
      + '<button class="dv-insp-x" type="button" data-dv-close-insp aria-label="' + esc(T('Close')) + '">×</button>'
      + '</div>'
      + '<div class="dv-insp-body">' + rows + '</div>'
      + '<div class="dv-insp-foot">'
      + esc(T('The historical store keeps an index of what happened, never the event payload. Nothing further was recorded.'))
      + '</div></aside>';
  }

  // ── TIMELINE & REPLAY ─────────────────────────────────────────────────────

  function replayHtml() {
    var f = DV.filters || (DV.filters = defaultFilters());
    var rp = DV.replay;

    var transport = '<div class="dv-transport">'
      + '<button class="dv-tbtn" type="button" data-dv-rp="back" title="' + esc(T('Step back')) + '"'
      + (rp && rp.rows.length ? '' : ' disabled') + '>⏮</button>'
      + '<button class="dv-tbtn dv-tbtn--play" type="button" data-dv-rp="play"'
      + (rp && rp.rows.length ? '' : ' disabled') + '>'
      + (rp && rp.playing ? '⏸' : '⏵') + '</button>'
      + '<button class="dv-tbtn" type="button" data-dv-rp="fwd" title="' + esc(T('Step forward')) + '"'
      + (rp && rp.rows.length ? '' : ' disabled') + '>⏭</button>'
      + '<div class="dv-speeds">'
      + [0.5, 1, 2, 4, 8].map(function (s) {
        return '<button class="dv-speed' + (rp && rp.speed === s ? ' is-on' : '') + '" type="button"'
          + ' data-dv-speed="' + s + '" data-no-i18n>' + s + '×</button>';
      }).join('')
      + '</div>'
      + '<div class="dv-rp-pos" data-no-i18n>'
      + (rp && rp.rows.length ? esc(num(rp.index + 1) + ' / ' + num(rp.rows.length)) : '—')
      + '</div>'
      + '</div>';

    var scrub = '<input class="dv-scrub" type="range" min="0" step="1"'
      + ' max="' + (rp && rp.rows.length ? rp.rows.length - 1 : 0) + '"'
      + ' value="' + (rp ? rp.index : 0) + '"'
      + (rp && rp.rows.length ? '' : ' disabled')
      + ' aria-label="' + esc(T('Jump to timestamp')) + '" data-dv-scrub>';

    var guarantee = '<div class="dv-guarantee">'
      + '<span class="dv-chip dv-chip--ok">' + esc(T('Read-only')) + '</span>'
      + '<span>' + esc(T('Replay reads recorded events. It re-runs no business action, writes nothing, sends nothing and publishes nothing.')) + '</span>'
      + (rp && rp.meta
        ? '<span class="dv-guarantee-api" data-no-i18n>sideEffects: ' + esc(rp.meta.sideEffects || 'NONE') + '</span>'
        : '')
      + '</div>';

    var stage = '<div class="dv-stage' + (rp && rp.playing ? ' is-playing' : '') + '">'
      + vaultDiagramHtml() + '</div>';

    var current = rp && rp.rows.length ? rp.rows[rp.index] : null;
    var nowCard = current
      ? '<div class="dv-nowcard">'
        + '<div class="dv-nowcard-time" data-no-i18n>' + esc((fmtInstant(current.occurredAt) || {}).utc || '') + '</div>'
        + '<div class="dv-nowcard-type" data-no-i18n>' + esc(current.eventType) + '</div>'
        + '<div class="dv-nowcard-src" data-user-content>' + esc(sourceLabel(current.source)) + '</div>'
        + '</div>'
      : '';

    var loaded = rp
      ? timelineHtml(rp.rows, T('Nothing to replay'), T('No events were recorded in this window.'))
      : (DV.loading ? skeleton(6) : emptyState(T('Choose a window'), T('Pick a period and load it to replay.')));

    return panel(T('Replay window'), dateNavHtml(f)
      + '<div class="dv-filter-actions"><button class="dv-btn dv-btn--primary" type="button" data-dv-rp-load>'
      + esc(T('Load window')) + '</button></div>')
      + panel(T('Transport'), guarantee + transport + scrub + nowCard)
      + panel(T('Flow'), stage)
      + panel(T('Events in this window'), loaded);
  }

  // ── CLUB HISTORY ──────────────────────────────────────────────────────────

  function clubsHtml() {
    var list = DV.clubs;
    var sum = DV.clubSummary;

    var picker = '<div class="dv-filters">'
      + '<label class="dv-field dv-field--wide"><span>' + esc(T('Club')) + '</span>'
      + '<select data-dv-club>'
      + '<option value="">' + esc(T('Select a club')) + '</option>'
      + ((list || []).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (DV.clubId === c.id ? ' selected' : '')
          + ' data-user-content>' + esc(c.name || c.id) + '</option>';
      }).join(''))
      + '</select></label></div>';

    if (!list) return panel(T('Club'), skeleton(2));
    if (!list.length) {
      return panel(T('Club'), emptyState(T('No clubs'), T('The platform has no clubs to look up.')));
    }
    if (!DV.clubId) {
      return panel(T('Club'), picker)
        + panel(T('History'), emptyState(T('Select a club'), T('Pick a club to see only its recorded history.')));
    }
    if (!sum) return panel(T('Club'), picker) + panel(T('History'), skeleton(4));

    var counts = '<div class="dv-stats dv-stats--3">'
      + stat(T('Recorded events'), sum.total)
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('First recorded activity')) + '</div>'
      + instantHtml(sum.earliest, T('Nothing recorded for this club.')) + '</div>'
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('Latest activity')) + '</div>'
      + instantHtml(sum.latest, T('Nothing recorded for this club.')) + '</div>'
      + '</div>';

    var dist = sum.sources && sum.sources.length
      ? '<div class="dv-dist">' + sum.sources.map(function (s) {
        var pct = sum.total > 0 ? Math.round((s.total / sum.total) * 100) : 0;
        return '<div class="dv-dist-row">'
          + '<span class="dv-dist-name" data-user-content>' + esc(sourceLabel(s.source)) + '</span>'
          + '<span class="dv-dist-bar"><span style="width:' + pct + '%"></span></span>'
          + '<span class="dv-dist-n" data-no-i18n>' + esc(num(s.total)) + '</span></div>';
      }).join('') + '</div>'
      : emptyState(T('No source activity'), T('This club has no recorded history yet.'));

    return panel(T('Club'), picker)
      + panel(T('Summary'), counts)
      + panel(T('Source distribution'), dist)
      + panel(T('Timeline'), timelineHtml(DV.page ? DV.page.rows : null,
        T('No events'), T('Nothing recorded for this club in the default window.')));
  }

  // ── ENTITY HISTORY ────────────────────────────────────────────────────────

  function entitiesHtml() {
    var types = (DV.entityTypes && DV.entityTypes.entityTypes) || null;
    if (!types) return panel(T('Entity'), skeleton(3));

    if (!types.length) {
      return panel(T('Entity'), emptyState(T('No entity history yet'),
        T('No historical event has recorded an entity type.')));
    }

    var q = DV.entityQuery || { entityType: '', entityId: '' };
    var rows = types.map(function (t) {
      return '<button class="dv-etype' + (q.entityType === t.entityType ? ' is-on' : '') + '"'
        + ' type="button" data-dv-etype="' + esc(t.entityType) + '">'
        + '<span class="dv-etype-name" data-no-i18n>' + esc(t.entityType) + '</span>'
        + '<span class="dv-etype-n" data-no-i18n>' + esc(num(t.total)) + '</span>'
        + '<span class="dv-etype-flag">'
        + (t.idSearchable
          ? '<span class="dv-chip dv-chip--ok">' + esc(T('Searchable by ID')) + '</span>'
          : '<span class="dv-chip dv-chip--idle" title="'
            + esc(T('The historical store withholds identifiers for this kind, so individual lookup is not possible.'))
            + '">' + esc(T('Type only')) + '</span>')
        + '</span></button>';
    }).join('');

    var selected = types.filter(function (t) { return t.entityType === q.entityType; })[0];
    var lookup = selected
      ? (selected.idSearchable
        ? '<div class="dv-filters">'
          + '<label class="dv-field dv-field--wide"><span>' + esc(T('Entity ID')) + '</span>'
          + '<input type="text" data-dv-eid value="' + esc(q.entityId || '') + '" placeholder="' + esc(T('Exact ID')) + '"></label>'
          + '<div class="dv-filter-actions"><button class="dv-btn dv-btn--primary" type="button" data-dv-elookup>'
          + esc(T('Look up')) + '</button></div></div>'
        : '<div class="dv-notice">' + esc(T('This entity kind is recorded by type only. The historical store deliberately withholds identifiers for it, so there is no individual history to look up — by design, not by omission.')) + '</div>')
      : '';

    return panel(T('Entity kinds in history'), '<div class="dv-etypes">' + rows + '</div>',
      T('Derived from recorded rows, not from a list kept here.'))
      + (selected ? panel(T('Look up'), lookup) : '')
      + (selected && selected.idSearchable
        ? panel(T('History'), timelineHtml(DV.entityPage ? DV.entityPage.rows : (DV.loading ? null : []),
          T('No events'), T('No recorded event matches that identifier.')))
        : '');
  }

  // ── SOURCES ───────────────────────────────────────────────────────────────

  function sourcesHtml() {
    var s = DV.stats;
    if (!s) return panel(T('Sources'), skeleton(6));
    var list = s.sources || [];
    if (!list.length) return panel(T('Sources'), emptyState(T('No sources registered'), ''));

    var cards = list.map(function (src) {
      var e = fmtInstant(src.earliest);
      var l = fmtInstant(src.latest);
      return '<div class="dv-srccard' + (src.total > 0 ? ' is-live' : '') + '">'
        + '<div class="dv-srccard-head">'
        + '<span class="dv-srccard-name" data-user-content>' + esc(src.name) + '</span>'
        + (src.total > 0
          ? '<span class="dv-chip dv-chip--ok">' + esc(T('Recording')) + '</span>'
          : '<span class="dv-chip dv-chip--idle">' + esc(T('Nothing recorded')) + '</span>')
        + '</div>'
        + '<div class="dv-srccard-grid">'
        + '<div><span>' + esc(T('Historical events')) + '</span><b data-no-i18n>' + esc(num(src.total)) + '</b></div>'
        + '<div><span>' + esc(T('Today')) + '</span><b data-no-i18n>' + esc(num(src.today)) + '</b></div>'
        + '<div><span>' + esc(T('Registered types')) + '</span><b data-no-i18n>' + esc(num(src.registeredEventTypes)) + '</b></div>'
        + '<div><span>' + esc(T('Produced types')) + '</span><b data-no-i18n>' + esc(num(src.producedEventTypes)) + '</b></div>'
        + '</div>'
        + '<div class="dv-srccard-times">'
        + '<div><span>' + esc(T('First')) + '</span>' + (e ? '<b data-no-i18n>' + esc(e.utc) + '</b>' : absent(T('Nothing recorded yet.'))) + '</div>'
        + '<div><span>' + esc(T('Latest')) + '</span>' + (l ? '<b data-no-i18n>' + esc(l.utc) + '</b>' : absent(T('Nothing recorded yet.'))) + '</div>'
        + '</div>'
        + '<button class="dv-btn dv-btn--ghost" type="button" data-dv-source="' + esc(src.source) + '">'
        + esc(T('Open timeline')) + '</button>'
        + '</div>';
    }).join('');

    var orphans = (s.unregisteredSources || []).length
      ? panel(T('History from sources no longer registered'),
        '<div class="dv-dist">' + s.unregisteredSources.map(function (o) {
          return '<div class="dv-dist-row"><span class="dv-dist-name" data-no-i18n>' + esc(o.source) + '</span>'
            + '<span class="dv-dist-bar"><span style="width:100%"></span></span>'
            + '<span class="dv-dist-n" data-no-i18n>' + esc(num(o.total)) + '</span></div>';
        }).join('') + '</div>',
        T('These rows are real history whose source the registry no longer declares.'))
      : '';

    return panel(T('Registered sources'), '<div class="dv-srcgrid">' + cards + '</div>',
      T('From the Data Fabric registry. A source registered tomorrow appears here with no code change.'))
      + orphans;
  }

  // ── STORAGE (hot store + snapshots) ───────────────────────────────────────

  function storageHtml() {
    var h = DV.health;
    if (!h) return panel(T('Hot historical store'), skeleton(4));
    var w = h.writer || {};
    var d = h.delivery || {};
    var win = h.window || {};

    var hot = '<div class="dv-stats dv-stats--4">'
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('Engine')) + '</div>'
      + '<div class="dv-stat-value dv-stat-value--text" data-no-i18n>PostgreSQL</div>'
      + '<div class="dv-stat-hint">' + esc(T('Append-only historical table')) + '</div></div>'
      + stat(T('Historical events'), has(win.total) ? win.total : null)
      + stat(T('Pending delivery'), has(d.pending) ? d.pending : null,
        T('Delivery recovery has not reported.'))
      + stat(T('Failed writes'), has(w.failures) ? w.failures : null, T('The writer has not reported.'))
      + '</div>'
      + '<div class="dv-stats dv-stats--2">'
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('Earliest')) + '</div>'
      + instantHtml(win.earliest, T('Nothing recorded yet.')) + '</div>'
      + '<div class="dv-stat"><div class="dv-stat-label">' + esc(T('Latest')) + '</div>'
      + instantHtml(win.latest, T('Nothing recorded yet.')) + '</div>'
      + '</div>'
      + '<div class="dv-notice">' + esc(T('Connection details, credentials and infrastructure identifiers are never shown here and are not available to this interface.')) + '</div>';

    var writerRows = '<div class="dv-kv">'
      + [
        [T('Writer state'), w.state],
        [T('Written'), has(w.written) ? num(w.written) : null],
        [T('Duplicates ignored'), has(w.duplicates) ? num(w.duplicates) : null],
        [T('Retry backlog'), has(w.retryBacklog) ? num(w.retryBacklog) : null],
        [T('Dropped'), has(w.dropped) ? num(w.dropped) : null],
        [T('Recovery sweeps'), has(d.totalRecovered) ? num(d.totalRecovered) : null],
      ].map(function (r) {
        return '<div class="dv-kv-row"><span>' + esc(r[0]) + '</span>'
          + (has(r[1]) && r[1] !== '' ? '<b data-no-i18n>' + esc(r[1]) + '</b>' : absent(T('Not reported.'))) + '</div>';
      }).join('')
      + '</div>'
      + '<div class="dv-notice dv-notice--soft">' + esc(T('These counters belong to one server process and reset when it restarts. Durability lives in the tables, not in these numbers.')) + '</div>';

    var arch = '<div class="dv-lifecycle">'
      + [
        ['Familista modules', T('Every product surface that publishes'), 'ACTIVE'],
        ['Data Fabric', T('One central publisher, one schema registry'), 'ACTIVE'],
        ['Durable outbox', T('Committed before history is attempted'), 'ACTIVE'],
        ['Historical event store', T('Append-only, indexed, queryable'), 'ACTIVE'],
        ['Query / Replay', T('Cursor-paginated reads and read-only replay'), 'ACTIVE'],
        ['Long-term archive', T('Partitioned cold export'), 'NOT_CONFIGURED'],
        ['Snapshots', T('State reconstruction at an instant'), 'FUTURE'],
      ].map(function (s, i, all) {
        var kind = s[2] === 'ACTIVE' ? 'ok' : (s[2] === 'NOT_CONFIGURED' ? 'off' : 'future');
        var label = s[2] === 'ACTIVE' ? T('Active') : (s[2] === 'NOT_CONFIGURED' ? T('Not configured') : T('Future'));
        return '<div class="dv-lc-step dv-lc-step--' + kind + '">'
          + '<div class="dv-lc-mark" aria-hidden="true"></div>'
          + '<div class="dv-lc-body"><div class="dv-lc-title">' + esc(T(s[0])) + '</div>'
          + '<div class="dv-lc-sub">' + esc(s[1]) + '</div></div>'
          + '<div class="dv-lc-state dv-lc-state--' + kind + '">' + esc(label) + '</div>'
          + (i < all.length - 1 ? '<div class="dv-lc-link" aria-hidden="true"></div>' : '')
          + '</div>';
      }).join('')
      + '</div>';

    var snapshots = '<div class="dv-future">'
      + '<div class="dv-future-state">' + esc(T('Not implemented')) + '</div>'
      + '<p>' + esc(T('Snapshots will later allow reconstruction of the full platform state at a historical point in time.')) + '</p>'
      + '<p class="dv-future-note">' + esc(T('Replay currently returns the events that were recorded, in order. It does not reconstruct system state, and this build has no snapshot engine.')) + '</p>'
      + '</div>';

    return panel(T('Hot historical store'), hot)
      + panel(T('Storage lifecycle'), arch, T('What is active, what is not configured, and what is future.'))
      + panel(T('Historical writer'), writerRows)
      + panel(T('Snapshots'), snapshots);
  }

  // ── ARCHIVE ───────────────────────────────────────────────────────────────

  function archiveHtml() {
    var h = DV.health;
    if (!h) return panel(T('Long-term archive'), skeleton(3));
    var a = h.archive || {};

    var state = a.enabled
      ? '<span class="dv-chip dv-chip--ok">' + esc(T('Configured')) + '</span>'
      : '<span class="dv-chip dv-chip--off">' + esc(T('Not configured')) + '</span>';

    var missing = (a.missing || []).length
      ? '<div class="dv-kv">' + a.missing.map(function (m) {
        return '<div class="dv-kv-row"><span data-no-i18n>' + esc(m) + '</span>'
          + '<b class="dv-kv-missing">' + esc(T('not set')) + '</b></div>';
      }).join('') + '</div>'
      : '';

    var facts = '<div class="dv-kv">'
      + '<div class="dv-kv-row"><span>' + esc(T('Status')) + '</span><b data-no-i18n>' + esc(a.state || 'NOT_CONFIGURED') + '</b></div>'
      + '<div class="dv-kv-row"><span>' + esc(T('Format')) + '</span><b data-no-i18n>' + esc(a.format || 'parquet') + '</b></div>'
      + '<div class="dv-kv-row"><span>' + esc(T('Partitioning')) + '</span><b data-no-i18n>' + esc(a.partitioning || '') + '</b></div>'
      + '<div class="dv-kv-row"><span>' + esc(T('Storage port')) + '</span><b data-no-i18n>'
      + esc((a.objectStore && a.objectStore.port) || '—') + '</b></div>'
      + '<div class="dv-kv-row"><span>' + esc(T('Resolved provider')) + '</span><b data-no-i18n>'
      + esc((a.objectStore && a.objectStore.provider) || '—') + '</b></div>'
      + '<div class="dv-kv-row"><span>' + esc(T('Batches exported')) + '</span>'
      + (a.lastBatch ? '<b data-no-i18n>' + esc(String(a.lastBatch)) + '</b>'
        : '<b data-no-i18n>0</b>') + '</div>'
      + '</div>';

    var future = '<div class="dv-future">'
      + '<div class="dv-future-state">' + esc(T('Foundation only')) + '</div>'
      + '<p>' + esc(T('The archive contract, its manifest format and its partitioning are defined, and the bytes would travel through the platform\'s existing object-storage port. No exporter is implemented in this build.')) + '</p>'
      + '<ul class="dv-future-list">'
      + ['Long-term retention', 'Partitioned historical export', 'Archive integrity manifests', 'Cold retrieval']
        .map(function (x) { return '<li>' + esc(T(x)) + '</li>'; }).join('')
      + '</ul>'
      + '<p class="dv-future-note">' + esc(T('Nothing has been exported, no object exists, and no historical row is ever removed after an export. Export and purge are both refused in this build.')) + '</p>'
      + '</div>';

    return panel(T('Long-term archive'), '<div class="dv-archive-head">' + state + '</div>' + facts + missing)
      + panel(T('What exists, and what does not'), future);
  }

  // ── INTEGRITY ─────────────────────────────────────────────────────────────

  function integrityHtml() {
    var h = DV.health;
    if (!h) return panel(T('Integrity & provenance'), skeleton(4));
    var w = h.writer || {};
    var d = h.delivery || {};
    var a = h.archive || {};

    var rows = [
      [T('Append-only history'), T('Enforced'), 'ok',
        T('The historical layer contains no delete, update or upsert. Nothing rewrites a recorded event.')],
      [T('Event ID uniqueness'), T('Database constraint'), 'ok',
        T('A unique index on the event identifier. A duplicate insert is rejected by PostgreSQL, not by application code.')],
      [T('Duplicate prevention'), has(w.duplicates) ? num(w.duplicates) + ' ' + T('ignored') : T('Enforced'), 'ok',
        T('A repeated write of an event already stored is treated as success and creates no second row.')],
      [T('Schema versioning'), T('Recorded per event'), 'ok',
        T('Every historical row carries the schema version its contract was registered with.')],
      [T('Source provenance'), T('Registry-backed'), 'ok',
        T('Every row names the registered source that published it. Rows whose source is no longer registered are reported rather than hidden.')],
      [T('Historical writer health'), w.state || null, w.state && String(w.state).toUpperCase() === 'OK' ? 'ok' : 'warn',
        T('Live counters from the running process.')],
      [T('Outbox recovery'), d.enabled ? T('Enabled') : T('Disabled'), d.enabled ? 'ok' : 'warn',
        T('An outbox row with no historical row is an undelivered event. The difference between the two tables is the pending state, so a crash cannot lose it silently.')],
      [T('Archive verification'), T('Not configured'), 'off',
        T('No archive exists to verify. Integrity manifests are defined and unused.')],
    ];

    var body = '<div class="dv-integrity">' + rows.map(function (r) {
      return '<div class="dv-int-row">'
        + '<div class="dv-int-k">' + esc(r[0]) + '</div>'
        + '<div class="dv-int-v"><span class="dv-chip dv-chip--' + r[2] + '"' + (r[1] ? '' : '') + '>'
        + (r[1] ? esc(r[1]) : esc(T('Not reported'))) + '</span></div>'
        + '<div class="dv-int-d">' + esc(r[3]) + '</div>'
        + '</div>';
    }).join('') + '</div>';

    return panel(T('Integrity & provenance'), body,
      T('Only properties this build actually enforces are listed.'))
      + panel(T('Delivery'), '<div class="dv-kv">'
        + '<div class="dv-kv-row"><span>' + esc(T('Pending deliveries')) + '</span>'
        + (has(d.pending) ? '<b data-no-i18n>' + esc(num(d.pending)) + '</b>' : absent(T('Not reported.'))) + '</div>'
        + '<div class="dv-kv-row"><span>' + esc(T('Recovered since start')) + '</span>'
        + (has(d.totalRecovered) ? '<b data-no-i18n>' + esc(num(d.totalRecovered)) + '</b>' : absent(T('Not reported.'))) + '</div>'
        + '<div class="dv-kv-row"><span>' + esc(T('Last sweep')) + '</span>'
        + (d.lastSweepAt ? '<b data-no-i18n>' + esc((fmtInstant(d.lastSweepAt) || {}).utc || '') + '</b>' : absent(T('No sweep has run in this process.'))) + '</div>'
        + '</div>')
      + (a.enabled ? '' : panel(T('Archive integrity'),
        emptyState(T('Not configured'), T('Archive integrity manifests are defined but no archive has been written.'))));
  }

  // ── RETENTION ─────────────────────────────────────────────────────────────

  function retentionHtml() {
    var h = DV.health;
    if (!h) return panel(T('Retention & governance'), skeleton(3));
    var r = h.retention || {};
    var classes = r.classes || [];

    var chips = classes.length
      ? '<div class="dv-classes">' + classes.map(function (c) {
        return '<span class="dv-class" data-no-i18n>' + esc(c) + '</span>';
      }).join('') + '</div>'
      : emptyState(T('No classes exposed'), T('The platform did not report retention classes.'));

    var policy = '<div class="dv-kv">'
      + '<div class="dv-kv-row"><span>' + esc(T('Automatic deletion')) + '</span>'
      + '<b class="' + (r.policyConfigured ? '' : 'dv-kv-off') + '" >'
      + esc(r.policyConfigured ? T('Policy configured') : T('Disabled — no policy configured')) + '</b></div>'
      + '<div class="dv-kv-row"><span>' + esc(T('Retention durations')) + '</span>'
      + '<b class="dv-kv-off">' + esc(T('None defined')) + '</b></div>'
      + '</div>'
      + '<div class="dv-notice">'
      + esc(r.note || T('Records are classified, never purged.'))
      + '</div>'
      + '<div class="dv-notice dv-notice--soft">'
      + esc(T('A retention duration is a legal judgement that varies by jurisdiction and by the age of the person a record concerns. This interface reports the classification and does not offer deletion: historical deletion is a governed feature that does not exist in this build.'))
      + '</div>';

    return panel(T('Retention classes'), chips,
      T('Classification only. Assigned from what the platform already knows.'))
      + panel(T('Deletion policy'), policy);
  }

  // ── content switch ────────────────────────────────────────────────────────

  function contentHtml() {
    if (DV.error && DV.module !== 'overview') {
      return panel('', emptyState(T('The Data Vault could not be read'), DV.error));
    }
    switch (DV.module) {
      case 'overview':  return overviewHtml();
      case 'explorer':  return explorerHtml();
      case 'replay':    return replayHtml();
      case 'clubs':     return clubsHtml();
      case 'entities':  return entitiesHtml();
      case 'sources':   return sourcesHtml();
      case 'storage':   return storageHtml();
      case 'archive':   return archiveHtml();
      case 'integrity': return integrityHtml();
      case 'retention': return retentionHtml();
      default:          return overviewHtml();
    }
  }

  // ── painting ──────────────────────────────────────────────────────────────

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', DV_DIR);
    host.setAttribute('lang', DV_LANG);
    host.innerHTML = '<div class="dv-shell">'
      + railHtml()
      + '<main class="dv-main">' + topHtml()
      + '<div class="dv-body" id="dv-body">' + contentHtml() + '</div></main>'
      + '</div>' + inspectorHtml();
    try { dvTranslate(host); } catch (_) {}
  }

  /** Repaint only the body, so the rail keeps its scroll and nothing jumps. */
  function repaintBody(host) {
    var body = host.querySelector('#dv-body');
    if (!body) return paint(host);
    body.innerHTML = contentHtml();
    try { dvTranslate(body); } catch (_) {}
    // The inspector lives outside the body; redraw it separately.
    var old = host.querySelector('.dv-insp');
    var scrim = host.querySelector('.dv-insp-scrim');
    if (old) old.remove();
    if (scrim) scrim.remove();
    if (DV.inspect) {
      host.insertAdjacentHTML('beforeend', inspectorHtml());
      try { dvTranslate(host.querySelector('.dv-insp')); } catch (_) {}
    }
    var chip = host.querySelector('.dv-top-r .dv-chip');
    if (chip) {
      var wrap = document.createElement('div');
      wrap.innerHTML = vaultStateHtml();
      chip.replaceWith(wrap.firstChild);
      try { dvTranslate(host.querySelector('.dv-top-r')); } catch (_) {}
    }
  }

  // ── loading ───────────────────────────────────────────────────────────────

  /** The reads every section shares. Fetched once, reused. */
  function loadCore() {
    if (DV.stats && DV.health) return Promise.resolve();
    return Promise.all([
      api('/system/fabric/history/stats'),
      api('/system/fabric/history/health'),
      api('/system/fabric/history/entity-types').catch(function () { return { entityTypes: [] }; }),
    ]).then(function (r) {
      DV.stats = r[0]; DV.health = r[1]; DV.entityTypes = r[2]; DV.error = null;
    }).catch(function (e) { DV.error = e.message; });
  }

  function loadExplorer(cursor) {
    var f = DV.filters || (DV.filters = defaultFilters());
    DV.loading = true;
    var qs = queryFrom(f, cursor);
    return Promise.all([
      api('/system/fabric/history' + qs),
      api('/system/fabric/history/count' + queryFrom(f, null).replace(/[?&]limit=\d+/, '')),
    ]).then(function (r) {
      DV.page = r[0];
      DV.countTotal = r[1] && has(r[1].total) ? r[1].total : null;
      DV.loading = false;
    }).catch(function (e) { DV.error = e.message; DV.loading = false; });
  }

  function loadClubs() {
    if (DV.clubs) return Promise.resolve();
    return api('/system/clubs').then(function (d) {
      DV.clubs = (d && (d.clubs || d.items || d)) || [];
      if (!Array.isArray(DV.clubs)) DV.clubs = [];
    }).catch(function () { DV.clubs = []; });
  }

  function loadClubSummary(host) {
    if (!DV.clubId) return Promise.resolve();
    DV.clubSummary = null;
    return Promise.all([
      api('/system/fabric/history/clubs/' + encodeURIComponent(DV.clubId) + '/summary'),
      api('/system/fabric/history?clubId=' + encodeURIComponent(DV.clubId) + '&limit=50'),
    ]).then(function (r) {
      DV.clubSummary = r[0];
      DV.page = r[1];
      repaintBody(host);
    }).catch(function (e) { DV.error = e.message; repaintBody(host); });
  }

  function loadReplay(host) {
    var f = DV.filters || (DV.filters = defaultFilters());
    DV.loading = true;
    repaintBody(host);
    return api('/system/fabric/history/replay' + queryFrom(f, null)).then(function (d) {
      stopPlayback();
      DV.replay = {
        rows: (d && d.rows) || [],
        index: 0,
        playing: false,
        speed: 1,
        meta: { readOnly: d && d.readOnly, sideEffects: d && d.sideEffects },
      };
      DV.loading = false;
      repaintBody(host);
    }).catch(function (e) {
      DV.error = e.message; DV.loading = false; repaintBody(host);
    });
  }

  function loadEntity(host) {
    var q = DV.entityQuery;
    if (!q || !q.entityType || !q.entityId) return Promise.resolve();
    DV.loading = true;
    return api('/system/fabric/history?entityType=' + encodeURIComponent(q.entityType)
      + '&entityId=' + encodeURIComponent(q.entityId) + '&limit=100')
      .then(function (d) { DV.entityPage = d; DV.loading = false; repaintBody(host); })
      .catch(function (e) { DV.error = e.message; DV.loading = false; repaintBody(host); });
  }

  // ── replay playback ───────────────────────────────────────────────────────
  //
  // A timer that steps a cursor through rows already in memory. It issues no
  // request while playing, and there is no polling loop anywhere in this module.

  var playTimer = null;

  function stopPlayback() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (DV.replay) DV.replay.playing = false;
  }

  function pulseFor(host, row) {
    if (!row) return;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (_) {}
    var chip = host.querySelector('.dv-stage .dv-src-chip[data-dv-source="' + CSS.escape(String(row.source)) + '"]');
    if (chip) {
      chip.classList.remove('is-pulse');
      void chip.offsetWidth;   // restart the animation rather than queue it
      chip.classList.add('is-pulse');
    }
    var hot = host.querySelector('.dv-stage .dv-pillar--hot');
    if (hot) {
      hot.classList.remove('is-pulse');
      void hot.offsetWidth;
      hot.classList.add('is-pulse');
    }
  }

  function stepTo(host, index) {
    if (!DV.replay || !DV.replay.rows.length) return;
    var n = DV.replay.rows.length;
    DV.replay.index = Math.max(0, Math.min(index, n - 1));
    renderReplayPosition(host);
    pulseFor(host, DV.replay.rows[DV.replay.index]);
    if (DV.replay.index >= n - 1 && DV.replay.playing) stopPlayback(), renderReplayPosition(host);
  }

  /**
   * Update only the parts of the replay view that changed.
   *
   * Not a repaint: a full redraw on every tick would rebuild the diagram and
   * cancel the animation it is meant to be driving, and would move the page
   * under a reader who is watching it.
   */
  function renderReplayPosition(host) {
    var rp = DV.replay;
    if (!rp) return;
    var pos = host.querySelector('.dv-rp-pos');
    if (pos) pos.textContent = rp.rows.length ? (num(rp.index + 1) + ' / ' + num(rp.rows.length)) : '—';
    var scrub = host.querySelector('[data-dv-scrub]');
    if (scrub) scrub.value = String(rp.index);
    var play = host.querySelector('[data-dv-rp="play"]');
    if (play) play.textContent = rp.playing ? '⏸' : '⏵';
    var stage = host.querySelector('.dv-stage');
    if (stage) stage.classList.toggle('is-playing', !!rp.playing);
    var card = host.querySelector('.dv-nowcard');
    var row = rp.rows[rp.index];
    if (card && row) {
      var t = fmtInstant(row.occurredAt);
      var a = card.querySelector('.dv-nowcard-time');
      var b = card.querySelector('.dv-nowcard-type');
      var c = card.querySelector('.dv-nowcard-src');
      if (a) a.textContent = (t && t.utc) || '';
      if (b) b.textContent = row.eventType || '';
      if (c) c.textContent = sourceLabel(row.source);
    }
  }

  function togglePlay(host) {
    if (!DV.replay || !DV.replay.rows.length) return;
    if (DV.replay.playing) { stopPlayback(); renderReplayPosition(host); return; }
    DV.replay.playing = true;
    renderReplayPosition(host);
    var tick = function () {
      if (!DV.replay || !DV.replay.playing) return;
      if (DV.replay.index >= DV.replay.rows.length - 1) { stopPlayback(); renderReplayPosition(host); return; }
      stepTo(host, DV.replay.index + 1);
    };
    playTimer = setInterval(tick, Math.max(60, Math.round(700 / (DV.replay.speed || 1))));
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__dvBound) return;
    host.__dvBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;

      var home = t.closest('[data-dv-home]');
      if (home) { stopPlayback(); try { window.navTo('owner-home'); } catch (_) {} return; }

      var nav = t.closest('[data-dv-nav]');
      if (nav) {
        stopPlayback();
        DV.module = nav.getAttribute('data-dv-nav');
        DV.inspect = null;
        paint(host);
        afterNav(host);
        return;
      }

      var langs = t.closest('[data-dv-langs]');
      if (langs) { DV.langOpen = !DV.langOpen; paint(host); return; }

      var lang = t.closest('[data-dv-lang]');
      if (lang) {
        DV.langOpen = false;
        setLocale(lang.getAttribute('data-dv-lang')).then(function () { paint(host); });
        return;
      }

      var src = t.closest('[data-dv-source]');
      if (src) {
        DV.filters = DV.filters || defaultFilters();
        DV.filters.source = src.getAttribute('data-dv-source');
        DV.filters.preset = 'month';
        DV.filters.drill = null;
        DV.module = 'explorer';
        DV.pages = [];
        paint(host);
        loadExplorer(null).then(function () { repaintBody(host); });
        return;
      }

      var preset = t.closest('[data-dv-preset]');
      if (preset) {
        DV.filters = DV.filters || defaultFilters();
        DV.filters.preset = preset.getAttribute('data-dv-preset');
        DV.filters.drill = null;
        repaintBody(host);
        return;
      }

      if (t.closest('[data-dv-drill-clear]')) {
        DV.filters.drill = null; repaintBody(host); return;
      }

      if (t.closest('[data-dv-run]')) {
        DV.pages = []; DV.loading = true; repaintBody(host);
        loadExplorer(null).then(function () { repaintBody(host); });
        return;
      }
      if (t.closest('[data-dv-reset]')) {
        DV.filters = defaultFilters(); DV.page = null; DV.countTotal = null; DV.pages = [];
        repaintBody(host);
        return;
      }
      if (t.closest('[data-dv-next]')) {
        if (DV.page && DV.page.nextCursor) {
          DV.pages.push(DV.page.nextCursor);
          DV.loading = true; repaintBody(host);
          loadExplorer(DV.page.nextCursor).then(function () { repaintBody(host); });
        }
        return;
      }
      if (t.closest('[data-dv-prev]')) {
        DV.pages.pop();
        var back = DV.pages.length ? DV.pages[DV.pages.length - 1] : null;
        DV.loading = true; repaintBody(host);
        loadExplorer(back).then(function () { repaintBody(host); });
        return;
      }

      var evBtn = t.closest('[data-dv-event]');
      if (evBtn) {
        var i = Number(evBtn.getAttribute('data-dv-event'));
        var source = DV.module === 'entities' ? DV.entityPage
          : (DV.module === 'replay' ? { rows: (DV.replay || {}).rows } : DV.page);
        var rows = (source && source.rows) || [];
        DV.inspect = rows[i] || null;
        repaintBody(host);
        return;
      }
      if (t.closest('[data-dv-close-insp]')) { DV.inspect = null; repaintBody(host); return; }

      if (t.closest('[data-dv-rp-load]')) { loadReplay(host); return; }
      var rp = t.closest('[data-dv-rp]');
      if (rp) {
        var what = rp.getAttribute('data-dv-rp');
        if (what === 'play') togglePlay(host);
        if (what === 'fwd') { stopPlayback(); stepTo(host, (DV.replay || {}).index + 1); }
        if (what === 'back') { stopPlayback(); stepTo(host, (DV.replay || {}).index - 1); }
        return;
      }
      var sp = t.closest('[data-dv-speed]');
      if (sp && DV.replay) {
        DV.replay.speed = Number(sp.getAttribute('data-dv-speed'));
        var wasPlaying = DV.replay.playing;
        stopPlayback();
        repaintBody(host);
        if (wasPlaying) togglePlay(host);
        return;
      }

      var et = t.closest('[data-dv-etype]');
      if (et) {
        DV.entityQuery = { entityType: et.getAttribute('data-dv-etype'), entityId: '' };
        DV.entityPage = null;
        repaintBody(host);
        return;
      }
      if (t.closest('[data-dv-elookup]')) { loadEntity(host); return; }
    });

    host.addEventListener('change', function (ev) {
      var t = ev.target;

      var f = t.closest('[data-dv-f]');
      if (f) {
        DV.filters = DV.filters || defaultFilters();
        DV.filters[f.getAttribute('data-dv-f')] = f.value;
        return;
      }

      var drill = t.closest('[data-dv-drill]');
      if (drill) {
        DV.filters = DV.filters || defaultFilters();
        var d = DV.filters.drill || {};
        var which = drill.getAttribute('data-dv-drill');
        var v = drill.value === '' ? null : Number(drill.value);
        d[which] = v;
        // A coarser choice invalidates the finer ones below it.
        if (which === 'year') { d.month = null; d.day = null; d.hour = null; }
        if (which === 'month') { d.day = null; d.hour = null; }
        if (which === 'day') { d.hour = null; }
        DV.filters.drill = has(d.year) ? d : null;
        repaintBody(host);
        return;
      }

      var club = t.closest('[data-dv-club]');
      if (club) { DV.clubId = club.value; loadClubSummary(host); return; }

      var scrub = t.closest('[data-dv-scrub]');
      if (scrub) { stopPlayback(); stepTo(host, Number(scrub.value)); return; }
    });

    host.addEventListener('input', function (ev) {
      var t = ev.target;
      var f = t.closest('[data-dv-f]');
      if (f) {
        DV.filters = DV.filters || defaultFilters();
        DV.filters[f.getAttribute('data-dv-f')] = f.value;
        return;
      }
      if (t.closest('[data-dv-from]')) { DV.filters.from = t.value; return; }
      if (t.closest('[data-dv-to]')) { DV.filters.to = t.value; return; }
      if (t.closest('[data-dv-eid]')) { (DV.entityQuery || (DV.entityQuery = {})).entityId = t.value; return; }
      var scrub = t.closest('[data-dv-scrub]');
      if (scrub && DV.replay) { stopPlayback(); stepTo(host, Number(scrub.value)); }
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && DV.inspect) { DV.inspect = null; repaintBody(host); }
    });
  }

  /** Whatever the newly opened section needs, and nothing it does not. */
  function afterNav(host) {
    if (DV.module === 'clubs') {
      loadClubs().then(function () { repaintBody(host); });
    } else if (DV.module === 'explorer' && !DV.page) {
      DV.loading = true;
      loadExplorer(null).then(function () { repaintBody(host); });
    }
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  /** Mount point. app.js calls this with the page's host element. */
  window.renderFamilistaDataVault = function (host) {
    host = host || document.getElementById('dv-root');
    if (!host) return;
    bind(host);
    setLocale(storedLocale()).then(function () {
      paint(host);
      return loadCore();
    }).then(function () {
      paint(host);
      afterNav(host);
    });
  };

  /** Torn down when the reader leaves, so no timer survives the page. */
  window.teardownFamilistaDataVault = function () { stopPlayback(); };

  // Exposed for the test suite, which asserts the field allow-list and the
  // UTC bounds rather than trusting a comment about them.
  try {
    window.__DV_TEST__ = {
      VISIBLE_FIELDS: VISIBLE_FIELDS, utcBounds: utcBounds, drillBounds: drillBounds,
      queryFrom: queryFrom, MODULES: MODULES,
    };
  } catch (_) {}
}());
