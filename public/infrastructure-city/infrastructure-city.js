/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA INFRASTRUCTURE CITY — the platform, drawn from its own repository

   The fourth top-level Familista module, beside SYSTEM, CLUBS and DATA VAULT.
   SYSTEM operates the platform, CLUBS operates the football organisations, the
   DATA VAULT holds what happened, and the INFRASTRUCTURE CITY is what the
   platform IS: its languages, services, databases, pipelines, providers and the
   roads between them.

   IT INVENTS NOTHING

   Every building on this map exists because a file in the repository proves it.
   The inventory is generated at build by `scripts/infrastructure-discover.js`
   from package.json, the lockfile, tsconfig, the Prisma schema, render.yaml,
   the GitHub workflows and the mounted routers, and every component carries the
   evidence that put it there. There is no hard-coded city in this file — search
   it for "PostgreSQL" and you will find the word only in a comment.

   TWO LAYERS, JOINED HERE

     GET /system/infrastructure          what exists   (build-time, cached)
     GET /system/infrastructure/stream   how it is     (live, Server-Sent)

   The manifest is fetched once; health arrives on a stream the SERVER paces.
   The browser cannot ask faster, so a struggling platform is not polled harder
   while it struggles.

   FOUR WORDS FOR "NO DATA", AND THEY ARE NOT THE SAME

     NOT INSTRUMENTED  nothing in this build measures it
     NOT CONFIGURED    it could be measured; this deployment has not set it up
     UNVERIFIED        it is real and this process cannot see it — Render deploys
     UNKNOWN           we asked and got no usable answer

   A dashboard that paints green over any of those converts absence of evidence
   into evidence of health, and the first time that matters is during an
   incident. So none of them is ever green here.

   WHAT IT WILL NOT DO

   No environment value, connection string, key or token reaches this screen —
   the discovery script refuses to write a manifest containing one, and the
   values are never read into the server at all. And nothing here changes
   anything: no restart, no upgrade, no deploy. The only write in the whole
   module is acknowledging an incident, which moves a flag in one server process
   and says so.

   LOCALISATION

   English, German and Arabic in this module's own catalogue under
   /infrastructure-city/i18n/, the same boundary SYSTEM and the Data Vault keep.
   The page root is `data-no-i18n`, so the platform's club-facing locale pass
   skips this subtree entirely. Product names — PostgreSQL, TypeScript, Node.js
   — are names and are never translated.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var IC = {
    section: 'city',
    view: 'city',              // city | map | topology | table
    manifest: null,
    health: null,
    incidents: null,
    technology: null,
    changes: null,
    loading: false,
    error: null,
    inspect: null,             // component id
    focusDistrict: null,       // set by clicking an alert
    focusComponent: null,
    focusPaths: [],            // relationship keys to highlight
    stream: { state: 'IDLE', lastAt: null, attempts: 0 },
    langOpen: false,
    techFocus: null,
  };


  // ── plumbing ──────────────────────────────────────────────────────────────

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** A count, localised — or an em dash. `0` is an answer; absence is not. */
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(IC_LANG === 'ar' ? 'ar' : IC_LANG); } catch (_) { return String(n); }
  }
  function has(v) { return v !== null && v !== undefined; }

  function fmtInstant(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var local;
    try {
      local = new Intl.DateTimeFormat(IC_LANG === 'ar' ? 'ar' : IC_LANG, {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(d);
    } catch (_) { local = d.toISOString().replace('T', ' ').slice(0, 16); }
    return { local: local, utc: d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
  }

  function absent(why) {
    return '<span class="ic-none" title="' + esc(why || '') + '">—</span>';
  }

  // ── localisation ──────────────────────────────────────────────────────────

  var IC_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var IC_DICT = {};
  var IC_LANG = 'en';
  var IC_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < IC_LOCALES.length; i++) if (IC_LOCALES[i][0] === tag) return IC_LOCALES[i];
    return IC_LOCALES[0];
  }
  function storedLocale() {
    try {
      var v = localStorage.getItem('familista_system_locale')
        || localStorage.getItem('familista_infracity_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { IC_DICT = {}; return Promise.resolve(); }
    return fetch('/infrastructure-city/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { IC_DICT = d || {}; })
      .catch(function () { IC_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    IC_LANG = l[0]; IC_DIR = l[2];
    try { localStorage.setItem('familista_infracity_locale', IC_LANG); } catch (_) {}
    return loadDict(IC_LANG);
  }

  /** One string. A digit run becomes %d; a missing key falls through to English. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || IC_LANG === 'en') return s;
    if (Object.prototype.hasOwnProperty.call(IC_DICT, s)) return IC_DICT[s];
    var slot = s.replace(/\d[\d.,  ]*/g, '%d');
    if (slot !== s && Object.prototype.hasOwnProperty.call(IC_DICT, slot)) {
      var nums = s.match(/\d[\d.,  ]*/g) || [];
      var i = 0;
      return String(IC_DICT[slot]).replace(/%d/g, function () { return nums[i++] != null ? nums[i - 1] : '%d'; });
    }
    return s;
  }

  function icTranslate(root) {
    if (!root || IC_LANG === 'en') return;
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
      var lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
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
    var active = localeOf(IC_LANG);
    return '<div class="ic-langs' + (IC.langOpen ? ' is-open' : '') + '">'
      + '<button class="ic-lang-pick" type="button" data-ic-langs'
      + ' aria-expanded="' + (IC.langOpen ? 'true' : 'false') + '" aria-label="Infrastructure City language">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="ic-lang-ch">⌄</span></button>'
      + '<div class="ic-lang-menu" role="group">'
      + IC_LOCALES.map(function (l) {
        return '<button class="ic-lang' + (l[0] === IC_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-ic-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === IC_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  // ── the one way this module talks to the platform ────────────────────────
  //
  // Read-only apart from a single acknowledgement, which moves a flag in one
  // server process and touches no infrastructure.

  function apiBase() {
    return (typeof FAM_CONFIG !== 'undefined' && FAM_CONFIG.API_BASE) ? FAM_CONFIG.API_BASE : '/api/v1';
  }
  function token() {
    try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; }
    catch (_) { return ''; }
  }
  function api(path, opts) {
    var t = token();
    return fetch(apiBase() + path, Object.assign({
      headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
      credentials: 'include',
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error((body && (body.message || body.error)) || ('HTTP ' + r.status));
        return body.data != null ? body.data : body;
      });
    });
  }

  // ── health vocabulary ─────────────────────────────────────────────────────
  //
  // Five states, five colours, and the four that are not green mean four
  // different things. `stateKind` is the single place that mapping lives.

  function stateKind(state) {
    switch (String(state || '').toUpperCase()) {
      case 'HEALTHY': return 'ok';
      case 'WARNING': return 'warn';
      case 'CRITICAL': return 'crit';
      case 'NOT_CONFIGURED': return 'off';
      case 'NOT_INSTRUMENTED': return 'off';
      case 'UNVERIFIED': return 'unver';
      case 'FUTURE': return 'future';
      default: return 'unknown';
    }
  }
  function stateLabel(state) {
    switch (String(state || '').toUpperCase()) {
      case 'HEALTHY': return T('Healthy');
      case 'WARNING': return T('Warning');
      case 'CRITICAL': return T('Critical');
      case 'NOT_CONFIGURED': return T('Not configured');
      case 'NOT_INSTRUMENTED': return T('Not instrumented');
      case 'UNVERIFIED': return T('Unverified');
      case 'FUTURE': return T('Future');
      default: return T('Unknown');
    }
  }

  function signalFor(healthKey) {
    if (!healthKey || !IC.health || !IC.health.signals) return null;
    for (var i = 0; i < IC.health.signals.length; i++) {
      if (IC.health.signals[i].key === healthKey) return IC.health.signals[i];
    }
    return null;
  }

  /** A component's live state, or NOT_INSTRUMENTED when nothing measures it. */
  function componentState(c) {
    if (!c) return 'UNKNOWN';
    if (c.status === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
    if (c.status === 'FUTURE') return 'FUTURE';
    var s = signalFor(c.healthKey);
    return s ? s.state : 'NOT_INSTRUMENTED';
  }

  function districtState(districtId) {
    var comps = componentsIn(districtId);
    var worst = 'NOT_INSTRUMENTED';
    var rank = { CRITICAL: 0, WARNING: 1, UNKNOWN: 2, HEALTHY: 3, UNVERIFIED: 4, NOT_CONFIGURED: 5, NOT_INSTRUMENTED: 6, FUTURE: 7 };
    comps.forEach(function (c) {
      var s = componentState(c);
      if (rank[s] < rank[worst]) worst = s;
    });
    return worst;
  }

  function componentsIn(districtId) {
    if (!IC.manifest) return [];
    return IC.manifest.components.filter(function (c) { return c.district === districtId; });
  }
  function futureIn(districtId) {
    if (!IC.manifest) return [];
    return (IC.manifest.future || []).filter(function (f) { return f.district === districtId; });
  }
  function componentById(id) {
    if (!IC.manifest) return null;
    for (var i = 0; i < IC.manifest.components.length; i++) {
      if (IC.manifest.components[i].id === id) return IC.manifest.components[i];
    }
    return null;
  }
  function districtById(id) {
    if (!IC.manifest) return null;
    for (var i = 0; i < IC.manifest.districts.length; i++) {
      if (IC.manifest.districts[i].id === id) return IC.manifest.districts[i];
    }
    return null;
  }

  // ── navigation ────────────────────────────────────────────────────────────

  var SECTIONS = [
    ['city', 'Infrastructure City', '◈', 'CITY'],
    ['incidents', 'Alerts & Incidents', '⚠', 'CITY'],
    ['capacity', 'Capacity & Growth', '▤', 'CITY'],
    ['technology', 'Technology Map', '⬡', 'ARCHITECTURE'],
    ['dependencies', 'Dependencies', '⇄', 'ARCHITECTURE'],
    ['changes', 'Change History', '⟳', 'ARCHITECTURE'],
    ['rules', 'Detection Rules', '⚖', 'GOVERNANCE'],
    ['evidence', 'Evidence & Sources', '⛨', 'GOVERNANCE'],
  ];
  var GROUP_ORDER = ['CITY', 'ARCHITECTURE', 'GOVERNANCE'];
  var GROUP_LABEL = { CITY: 'City', ARCHITECTURE: 'Architecture', GOVERNANCE: 'Governance' };

  function railHtml() {
    var groups = GROUP_ORDER.map(function (g) {
      var items = SECTIONS.filter(function (s) { return s[3] === g; });
      if (!items.length) return '';
      return '<div class="ic-rail-group"><div class="ic-rail-label">' + esc(T(GROUP_LABEL[g])) + '</div>'
        + items.map(function (s) {
          var badge = '';
          if (s[0] === 'incidents' && IC.health && IC.health.counts) {
            var n = IC.health.counts.critical + IC.health.counts.warning;
            if (n > 0) {
              badge = '<span class="ic-rail-badge ic-rail-badge--'
                + (IC.health.counts.critical > 0 ? 'crit' : 'warn') + '" data-no-i18n>' + esc(num(n)) + '</span>';
            }
          }
          return '<button class="ic-rail-item' + (IC.section === s[0] ? ' is-on' : '') + '"'
            + ' type="button" data-ic-nav="' + s[0] + '"'
            + ' aria-current="' + (IC.section === s[0] ? 'page' : 'false') + '">'
            + '<span class="ic-rail-icon" aria-hidden="true">' + s[2] + '</span>'
            + '<span class="ic-rail-text">' + esc(T(s[1])) + '</span>' + badge + '</button>';
        }).join('')
        + '</div>';
    }).join('');

    return '<nav class="ic-rail" aria-label="Infrastructure City">'
      + '<div class="ic-rail-head">'
      + '<button class="ic-rail-home" type="button" data-ic-home aria-label="Back to Familista home">'
      + '<span aria-hidden="true">←</span><span class="ic-rail-text" data-no-i18n>Familista</span></button>'
      + '<div class="ic-rail-brand"><span class="ic-rail-mark" aria-hidden="true">◈</span>'
      + '<span class="ic-rail-title">' + esc(T('Infrastructure City')) + '</span></div>'
      + '</div>'
      + '<div class="ic-rail-body">' + groups + '</div>'
      + '<div class="ic-rail-foot">' + streamChipHtml() + '</div>'
      + '</nav>';
  }

  /** The live indicator. Says what the connection is actually doing. */
  function streamChipHtml() {
    var s = IC.stream;
    var kind = s.state === 'LIVE' ? 'ok' : s.state === 'CONNECTING' ? 'warn' : s.state === 'POLLING' ? 'warn' : 'off';
    var label = s.state === 'LIVE' ? T('Live')
      : s.state === 'CONNECTING' ? T('Connecting…')
        : s.state === 'POLLING' ? T('Polling')
          : T('Offline');
    var at = fmtInstant(s.lastAt);
    return '<div class="ic-stream">'
      + '<span class="ic-chip ic-chip--' + kind + '"><span class="ic-dot"></span>' + esc(label) + '</span>'
      + (at ? '<span class="ic-stream-at" data-no-i18n title="' + esc(at.utc) + '">' + esc(at.local) + '</span>'
        : '<span class="ic-stream-at">' + esc(T('No frame yet')) + '</span>')
      + '</div>';
  }

  function topHtml() {
    var sec = SECTIONS.filter(function (s) { return s[0] === IC.section; })[0] || SECTIONS[0];
    var overall = IC.health ? IC.health.overall : null;
    return '<header class="ic-top">'
      + '<div class="ic-top-l">'
      + '<div class="ic-top-eyebrow" data-no-i18n>Familista · Infrastructure City</div>'
      + '<h1 class="ic-top-title">' + esc(T(sec[1])) + '</h1>'
      + '</div>'
      + '<div class="ic-top-r">'
      + (overall
        ? '<span class="ic-chip ic-chip--' + stateKind(overall) + '"><span class="ic-dot"></span>'
          + esc(stateLabel(overall)) + '</span>'
        : '<span class="ic-chip ic-chip--off"><span class="ic-dot"></span>' + esc(T('Loading…')) + '</span>')
      + languageSwitchHtml()
      + '</div></header>';
  }

  // ── shared fragments ──────────────────────────────────────────────────────

  function panel(title, body, note) {
    return '<section class="ic-panel">'
      + (title ? '<div class="ic-panel-head"><h2 class="ic-panel-title">' + esc(T(title)) + '</h2>'
        + (note ? '<span class="ic-panel-note">' + esc(note) + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }
  function emptyState(title, detail) {
    return '<div class="ic-empty"><div class="ic-empty-mark" aria-hidden="true">⌀</div>'
      + '<div class="ic-empty-title">' + esc(T(title)) + '</div>'
      + (detail ? '<div class="ic-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }
  function skeleton(rows) {
    var out = '';
    for (var i = 0; i < (rows || 3); i++) out += '<div class="ic-skel-row"></div>';
    return '<div class="ic-skel" aria-hidden="true">' + out + '</div>';
  }
  function stat(label, value, hint) {
    return '<div class="ic-stat">'
      + '<div class="ic-stat-label">' + esc(T(label)) + '</div>'
      + '<div class="ic-stat-value">' + (has(value) ? esc(typeof value === 'number' ? num(value) : String(value)) : absent(T('Not measured.'))) + '</div>'
      + (hint ? '<div class="ic-stat-hint">' + esc(hint) + '</div>' : '')
      + '</div>';
  }

  /** The manifest has not been generated. One honest screen. */
  function notGeneratedHtml() {
    return panel('Infrastructure City',
      emptyState('No infrastructure manifest',
        T('The architecture is generated from the repository at build time. Nothing is drawn until it exists.'))
      + '<div class="ic-notice"><code data-no-i18n>npm run infra:discover</code></div>');
  }

  // ── CITY VIEW ─────────────────────────────────────────────────────────────

  /**
   * A building, drawn with its name translated.
   *
   * The names in the manifest are of two kinds and the catalogue is what tells
   * them apart. A DESCRIPTION the discovery script composed — "Historical Event
   * Store", "Rate Limiting" — has a catalogue entry and is translated, because
   * an Arabic reader looking at an Arabic city should not be reading an English
   * diagram. A TECHNOLOGY or product name — PostgreSQL, Node.js, Stripe,
   * familista-backend, SYSTEM — has no entry, so `T` falls through and it
   * renders exactly as the repository spells it. Nothing can translate a
   * technology name by accident: this catalogue is closed and hand-authored,
   * and adding such an entry is the deliberate act that would do it.
   */
  /**
   * How connected a component is, from the manifest and nothing else.
   *
   * Its own declared dependencies, plus every relationship with either end on
   * it. This is the ONE thing that varies a building's height, and it is a
   * real, checkable property of the architecture: a thing many things lean on
   * stands taller than a leaf. No invented metric goes near this.
   */
  function linkCount(id) {
    if (!IC.manifest) return 0;
    var c = componentById(id);
    var n = c && c.dependencies ? c.dependencies.length : 0;
    (IC.manifest.relationships || []).forEach(function (e) {
      if (e.from === id || e.to === id) n += 1;
    });
    return n;
  }

  /** Five storeys, so the skyline has rhythm without pretending to precision. */
  function towerRank(n) {
    return n >= 6 ? 5 : n >= 4 ? 4 : n >= 2 ? 3 : n >= 1 ? 2 : 1;
  }

  function buildingHtml(c) {
    var state = componentState(c);
    var focused = IC.focusComponent === c.id;
    var links = linkCount(c.id);
    return '<button class="ic-building ic-building--' + stateKind(state) + (focused ? ' is-focus' : '') + '"'
      + ' type="button" data-ic-component="' + esc(c.id) + '"'
      + ' data-ic-rank="' + towerRank(links) + '"'
      + ' title="' + esc(c.name + ' · ' + stateLabel(state)) + '">'
      + '<span class="ic-tower" aria-hidden="true">'
      + '<span class="ic-tower-roof"><span class="ic-building-dot"></span></span>'
      + '<span class="ic-tower-body"></span>'
      + '</span>'
      + '<span class="ic-building-label">'
      + '<span class="ic-building-name">' + esc(T(c.name)) + '</span>'
      + (c.version ? '<span class="ic-building-ver" data-no-i18n>' + esc(c.version) + '</span>' : '')
      + '</span>'
      + '</button>';
  }

  /** A plot with no building on it. Drawn as ground, because that is what it is. */
  function futureHtml(f) {
    return '<span class="ic-building ic-building--future" title="' + esc(f.reason) + '">'
      + '<span class="ic-tower ic-tower--plot" aria-hidden="true">'
      + '<span class="ic-tower-roof"><span class="ic-building-dot"></span></span>'
      + '<span class="ic-tower-body"></span>'
      + '</span>'
      + '<span class="ic-building-label">'
      + '<span class="ic-building-name">' + esc(T(f.name)) + '</span>'
      + '<span class="ic-building-ver">' + esc(T('Future')) + '</span>'
      + '</span></span>';
  }

  function districtHtml(d) {
    var comps = componentsIn(d.id);
    var futures = futureIn(d.id);
    var state = districtState(d.id);
    var focused = IC.focusDistrict === d.id;
    return '<div class="ic-district ic-district--' + stateKind(state) + (focused ? ' is-focus' : '') + '"'
      + ' data-ic-district="' + esc(d.id) + '" data-ic-zone="' + esc(d.zone) + '">'
      + '<span class="ic-plot-edge" aria-hidden="true"></span>'
      + '<div class="ic-district-head">'
      + '<span class="ic-district-name">' + esc(T(d.name)) + '</span>'
      + '<span class="ic-chip ic-chip--' + stateKind(state) + ' ic-chip--sm">' + esc(stateLabel(state)) + '</span>'
      + '</div>'
      + '<div class="ic-buildings">'
      + comps.map(buildingHtml).join('')
      + futures.map(futureHtml).join('')
      + (comps.length || futures.length ? '' : '<span class="ic-building ic-building--off"><span class="ic-building-name">' + esc(T('Empty')) + '</span></span>')
      + '</div></div>';
  }

  function cityHtml() {
    if (!IC.manifest) return skeleton(8);
    var layout = IC.manifest.layout || { zones: [] };
    var zoneOf = {};
    layout.zones.forEach(function (z) { zoneOf[z.zone] = z.districts.map(function (d) { return d.id; }); });

    var render = function (zone, skip) {
      return (zoneOf[zone] || []).map(function (id) {
        if (skip && skip.indexOf(id) >= 0) return '';
        var d = districtById(id);
        return d ? districtHtml(d) : '';
      }).join('');
    };

    var core = IC.manifest.components.filter(function (c) { return c.district === 'core'; })[0];
    var coreState = core ? componentState(core) : 'UNKNOWN';

    // The plan is three layers in one stacking context: the GROUND it is built
    // on, the ROADS between buildings, and the districts themselves. The roads
    // are drawn after paint from measured positions — see `drawRoads` — and sit
    // beneath the buildings so a street runs under a tower, not over it.
    return '<div class="ic-city">'
      + '<div class="ic-ground" aria-hidden="true"></div>'
      + '<svg class="ic-roads" aria-hidden="true" focusable="false"></svg>'
      + '<div class="ic-plan">'
      + '<div class="ic-zone ic-zone--north">' + render('north') + '</div>'
      + '<div class="ic-mid">'
      + '<div class="ic-zone ic-zone--west">' + render('west') + '</div>'
      + '<div class="ic-centre">'
      + '<button class="ic-core ic-core--' + stateKind(coreState) + '" type="button"'
      + (core ? ' data-ic-component="' + esc(core.id) + '"' : '') + '>'
      + '<span class="ic-core-halo" aria-hidden="true"></span>'
      + '<span class="ic-core-mark" aria-hidden="true">◈</span>'
      + '<span class="ic-core-title" data-no-i18n>Familista Platform Core</span>'
      + '<span class="ic-core-sub">' + esc(T('Connected · Scalable · Impactful')) + '</span>'
      + '<span class="ic-chip ic-chip--' + stateKind(coreState) + ' ic-chip--sm">' + esc(stateLabel(coreState)) + '</span>'
      + '</button>'
      // The core district holds exactly the component the landmark above IS.
      // Drawing it again below would put the same building on the plan twice.
      + render('centre', ['core'])
      + '</div>'
      + '<div class="ic-zone ic-zone--east">' + render('east') + '</div>'
      + '</div>'
      + '<div class="ic-zone ic-zone--south">' + render('south') + '</div>'
      + '</div></div>';
  }

  // ── MAP VIEW ──────────────────────────────────────────────────────────────
  //
  // The same data, laid out as an architectural stack rather than a plan. Some
  // questions are easier read top-to-bottom than as a map.

  function mapHtml() {
    if (!IC.manifest) return skeleton(6);
    var order = ['frontend', 'realtime', 'backend', 'security', 'fabric', 'vault',
      'database', 'cache', 'storage', 'ai', 'integrations', 'monitoring',
      'cicd', 'testing', 'i18n', 'config', 'language', 'core'];
    var known = {};
    IC.manifest.districts.forEach(function (d) { known[d.id] = d; });
    var ordered = order.filter(function (id) { return known[id]; })
      .concat(IC.manifest.districts.map(function (d) { return d.id; })
        .filter(function (id) { return order.indexOf(id) < 0; }));

    return '<div class="ic-map">' + ordered.map(function (id) {
      var d = known[id];
      var comps = componentsIn(id);
      var futures = futureIn(id);
      var state = districtState(id);
      return '<div class="ic-map-row ic-map-row--' + stateKind(state) + (IC.focusDistrict === id ? ' is-focus' : '') + '">'
        + '<div class="ic-map-label">' + esc(T(d.name))
        + '<span class="ic-map-cat" data-no-i18n>' + esc(d.category) + '</span></div>'
        + '<div class="ic-map-nodes">'
        + comps.map(buildingHtml).join('') + futures.map(futureHtml).join('')
        + '</div>'
        + '<div class="ic-map-state"><span class="ic-chip ic-chip--' + stateKind(state) + ' ic-chip--sm">'
        + esc(stateLabel(state)) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
  }

  // ── TOPOLOGY VIEW ─────────────────────────────────────────────────────────
  //
  // The real dependency graph, laid out in depth columns. Edges are the
  // relationships the repository proves; both ends were verified at build, so a
  // road here always leads somewhere.

  function topologyHtml() {
    if (!IC.manifest) return skeleton(6);
    var comps = IC.manifest.components;
    var edges = IC.manifest.relationships || [];

    // Depth = how far a component is from something nothing depends on.
    //
    // Relaxed until it stops moving rather than for a fixed number of passes,
    // with a bound so a dependency cycle — which the repository should not
    // contain, but this code cannot assume — terminates instead of spinning.
    var depth = {};
    var byId = {};
    comps.forEach(function (c) { byId[c.id] = c; depth[c.id] = 0; });
    var limit = Math.min(comps.length + 1, 64);
    for (var pass = 0; pass < limit; pass++) {
      var moved = false;
      comps.forEach(function (c) {
        (c.dependencies || []).forEach(function (d) {
          if (byId[d] && depth[d] < depth[c.id] + 1) { depth[d] = depth[c.id] + 1; moved = true; }
        });
      });
      edges.forEach(function (e) {
        if (byId[e.from] && byId[e.to] && depth[e.to] < depth[e.from] + 1) {
          depth[e.to] = depth[e.from] + 1; moved = true;
        }
      });
      if (!moved) break;
    }

    // Raw depths are sparse — a long chain leaves gaps, and a reader counting
    // "Layer 0, Layer 1, Layer 2, Layer 11" is reading an implementation detail
    // of the relaxation rather than the shape of the graph. Rank them so the
    // labels are consecutive; the ORDER is what carries the meaning.
    var distinct = [];
    comps.forEach(function (c) { if (distinct.indexOf(depth[c.id] || 0) < 0) distinct.push(depth[c.id] || 0); });
    distinct.sort(function (a, b) { return a - b; });
    var rank = {};
    distinct.forEach(function (d, i) { rank[d] = i; });

    var columns = {};
    comps.forEach(function (c) {
      var k = rank[depth[c.id] || 0];
      (columns[k] = columns[k] || []).push(c);
    });

    var keys = Object.keys(columns).sort(function (a, b) { return Number(a) - Number(b); });

    var graph = '<div class="ic-topo">' + keys.map(function (k) {
      return '<div class="ic-topo-col">'
        + '<div class="ic-topo-depth" data-no-i18n>' + esc(T('Layer')) + ' ' + esc(k) + '</div>'
        + columns[k].sort(function (a, b) { return a.name.localeCompare(b.name); })
          .map(buildingHtml).join('')
        + '</div>';
    }).join('') + '</div>';

    var list = '<div class="ic-edges">' + edges.map(function (e, i) {
      var from = byId[e.from], to = byId[e.to];
      if (!from || !to) return '';
      var key = e.from + '>' + e.to;
      var hot = IC.focusPaths.indexOf(key) >= 0;
      return '<button class="ic-edge' + (hot ? ' is-focus' : '') + '" type="button" data-ic-edge="' + i + '">'
        + '<span class="ic-edge-from">' + esc(T(from.name)) + '</span>'
        + '<span class="ic-edge-kind" data-no-i18n>' + esc(e.kind) + '</span>'
        + '<span class="ic-edge-to">' + esc(T(to.name)) + '</span>'
        + '<span class="ic-edge-ev">' + esc(e.evidence) + '</span>'
        + '</button>';
    }).join('') + '</div>';

    return panel('Dependency graph', graph,
      T('Layers are computed from real dependencies, not drawn by hand.'))
      + panel('Connections', list,
        T('Every edge carries the repository evidence that proves it.'));
  }

  // ── TABLE VIEW ────────────────────────────────────────────────────────────

  function tableHtml() {
    if (!IC.manifest) return skeleton(8);
    var rows = IC.manifest.components.slice().sort(function (a, b) {
      return a.district.localeCompare(b.district) || a.name.localeCompare(b.name);
    });
    return '<div class="ic-table" role="table">'
      + '<div class="ic-tr ic-tr--head" aria-hidden="true">'
      + '<span>' + esc(T('Component')) + '</span><span>' + esc(T('District')) + '</span>'
      + '<span>' + esc(T('Type')) + '</span><span>' + esc(T('Version')) + '</span>'
      + '<span>' + esc(T('Provider')) + '</span><span>' + esc(T('State')) + '</span></div>'
      + rows.map(function (c) {
        var state = componentState(c);
        var d = districtById(c.district);
        return '<button class="ic-tr" type="button" data-ic-component="' + esc(c.id) + '">'
          + '<span class="ic-td-name">' + esc(T(c.name)) + '</span>'
          + '<span>' + esc(d ? T(d.name) : c.district) + '</span>'
          + '<span data-no-i18n>' + esc(c.type) + '</span>'
          + '<span data-no-i18n>' + (c.version ? esc(c.version) : '—') + '</span>'
          + '<span data-no-i18n>' + (c.provider ? esc(c.provider) : '—') + '</span>'
          + '<span><span class="ic-chip ic-chip--' + stateKind(state) + ' ic-chip--sm">'
          + esc(stateLabel(state)) + '</span></span>'
          + '</button>';
      }).join('') + '</div>';
  }

  function viewSwitchHtml() {
    var views = [['city', 'City View'], ['map', 'Map View'], ['topology', 'Topology'], ['table', 'Table']];
    return '<div class="ic-views">' + views.map(function (v) {
      return '<button class="ic-viewbtn' + (IC.view === v[0] ? ' is-on' : '') + '"'
        + ' type="button" data-ic-view="' + v[0] + '">' + esc(T(v[1])) + '</button>';
    }).join('') + '</div>';
  }

  function citySectionHtml() {
    if (!IC.manifest) {
      return IC.error ? panel('', emptyState('Infrastructure City could not be read', IC.error))
        : panel('Infrastructure City', skeleton(8));
    }
    if (IC.manifest.state === 'NOT_GENERATED') return notGeneratedHtml();

    var m = IC.manifest;
    var body = IC.view === 'map' ? mapHtml()
      : IC.view === 'topology' ? topologyHtml()
        : IC.view === 'table' ? tableHtml()
          : cityHtml();

    var head = '<div class="ic-cityhead">' + viewSwitchHtml()
      + '<div class="ic-cityhead-r">'
      + '<span class="ic-metaline" data-no-i18n>' + esc(num(m.counts.components)) + ' '
      + esc(T('components')) + ' · ' + esc(num(m.counts.districts)) + ' ' + esc(T('districts'))
      + ' · ' + esc(num(m.counts.technologies)) + ' ' + esc(T('technologies')) + '</span>'
      + '</div></div>';

    var legend = '<div class="ic-legend">'
      + ['HEALTHY', 'WARNING', 'CRITICAL', 'NOT_CONFIGURED', 'UNVERIFIED', 'FUTURE'].map(function (s) {
        return '<span class="ic-legend-item"><span class="ic-dot ic-dot--' + stateKind(s) + '"></span>'
          + esc(stateLabel(s)) + '</span>';
      }).join('') + '</div>';

    var focus = IC.focusDistrict
      ? '<div class="ic-focusbar"><span>' + esc(T('Focused on')) + ' <b data-no-i18n>'
        + esc((districtById(IC.focusDistrict) || {}).name || IC.focusDistrict) + '</b></span>'
        + '<button class="ic-btn ic-btn--ghost" type="button" data-ic-clearfocus>' + esc(T('Clear focus')) + '</button></div>'
      : '';

    return (IC.view === 'topology' ? head + focus + body
      : panel('', head + focus + body + legend));
  }

  // ── INCIDENTS ─────────────────────────────────────────────────────────────

  function incidentHtml(inc, resolvedRow) {
    var at = fmtInstant(inc.detectedAt);
    return '<div class="ic-incident ic-incident--' + inc.severity.toLowerCase() + (resolvedRow ? ' is-resolved' : '') + '">'
      + '<div class="ic-incident-bar" aria-hidden="true"></div>'
      + '<div class="ic-incident-body">'
      + '<div class="ic-incident-head">'
      + '<span class="ic-incident-title">' + esc(T(inc.title)) + '</span>'
      + '<span class="ic-chip ic-chip--' + (inc.severity === 'CRITICAL' ? 'crit' : inc.severity === 'WARNING' ? 'warn' : 'info')
      + ' ic-chip--sm">' + esc(T(inc.severity === 'CRITICAL' ? 'Critical' : inc.severity === 'WARNING' ? 'Warning' : 'Info')) + '</span>'
      + '<span class="ic-chip ic-chip--off ic-chip--sm">' + esc(T(
        inc.status === 'RESOLVED' ? 'Resolved' : inc.status === 'ACKNOWLEDGED' ? 'Acknowledged' : 'Open')) + '</span>'
      + '</div>'
      + '<div class="ic-incident-sum">' + esc(inc.summary) + '</div>'
      + '<div class="ic-incident-meta">'
      + '<span>' + esc(T('Where')) + ': <b data-no-i18n>' + esc((componentById(inc.componentId) || {}).name || inc.componentId) + '</b></span>'
      + (at ? '<span data-no-i18n title="' + esc(at.utc) + '">' + esc(at.local) + '</span>' : '')
      + (inc.occurrences > 1 ? '<span data-no-i18n>×' + esc(num(inc.occurrences)) + '</span>' : '')
      + '</div>'
      + '<div class="ic-incident-detail">'
      + '<div><span>' + esc(T('Impact')) + '</span><p>' + esc(inc.impact) + '</p></div>'
      + '<div><span>' + esc(T('What to check')) + '</span><p>' + esc(inc.nextStep) + '</p></div>'
      + '</div>'
      + '<div class="ic-incident-actions">'
      + '<button class="ic-btn ic-btn--primary" type="button" data-ic-locate="' + esc(inc.id) + '">'
      + esc(T('Locate in city')) + '</button>'
      + '<button class="ic-btn ic-btn--ghost" type="button" data-ic-component="' + esc(inc.componentId) + '">'
      + esc(T('Inspect component')) + '</button>'
      + (!resolvedRow && inc.status === 'OPEN'
        ? '<button class="ic-btn ic-btn--ghost" type="button" data-ic-ack="' + esc(inc.id) + '">'
          + esc(T('Acknowledge')) + '</button>' : '')
      + '</div></div></div>';
  }

  function incidentsHtml() {
    if (!IC.health) return panel('Alerts & Incidents', skeleton(4));
    var openList = IC.health.incidents || [];
    var res = (IC.incidents && IC.incidents.resolved) || IC.health.resolved || [];
    var c = IC.health.counts;

    var header = '<div class="ic-sevrow">'
      + '<div class="ic-sev ic-sev--crit"><b data-no-i18n>' + esc(num(c.critical)) + '</b><span>' + esc(T('Critical')) + '</span></div>'
      + '<div class="ic-sev ic-sev--warn"><b data-no-i18n>' + esc(num(c.warning)) + '</b><span>' + esc(T('Warning')) + '</span></div>'
      + '<div class="ic-sev ic-sev--info"><b data-no-i18n>' + esc(num(c.info)) + '</b><span>' + esc(T('Info')) + '</span></div>'
      + '<div class="ic-sev ic-sev--ok"><b data-no-i18n>' + esc(num(c.healthy)) + '</b><span>' + esc(T('Healthy')) + '</span></div>'
      + '<div class="ic-sev ic-sev--off"><b data-no-i18n>' + esc(num(c.notInstrumented)) + '</b><span>' + esc(T('Not measured')) + '</span></div>'
      + '</div>';

    return panel('Live alerts & incidents',
      header + (openList.length
        ? openList.map(function (i) { return incidentHtml(i, false); }).join('')
        : emptyState('No open incidents',
          T('Every rule that this build can evaluate is currently satisfied.'))),
      T('Derived from named rules. Nothing here is generated for effect.'))
      + panel('Recently resolved',
        res.length ? res.slice(0, 12).map(function (i) { return incidentHtml(i, true); }).join('')
          : emptyState('Nothing has resolved yet', T('Resolved incidents are kept, not deleted.')),
        T('Kept after recovery. A platform that forgets its bad nights cannot learn from them.'))
      + '<div class="ic-notice ic-notice--soft">' + esc(T('Acknowledgement is held in this server process and does not survive a restart. Incident transitions are published to the Data Fabric and persist in the Historical Event Store.')) + '</div>';
  }

  // ── CAPACITY ──────────────────────────────────────────────────────────────

  function capacityHtml() {
    if (!IC.health) return panel('Capacity & Growth', skeleton(4));
    var by = {};
    IC.health.signals.forEach(function (s) { by[s.key] = s; });

    var proc = (by.process || {}).measurements || {};
    var hist = (by.historicalStore || {}).measurements || {};
    var db = (by.database || {}).measurements || {};
    var fab = (by.fabric || {}).measurements || {};

    var bar = function (label, value, max, unit, why) {
      if (!has(value) || !has(max) || max <= 0) {
        return '<div class="ic-cap"><div class="ic-cap-top"><span>' + esc(T(label)) + '</span>'
          + absent(why || T('Not measured.')) + '</div></div>';
      }
      var pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
      var kind = pct >= 95 ? 'crit' : pct >= 85 ? 'warn' : 'ok';
      return '<div class="ic-cap"><div class="ic-cap-top"><span>' + esc(T(label)) + '</span>'
        + '<b data-no-i18n>' + esc(num(value)) + ' / ' + esc(num(max)) + ' ' + esc(unit || '') + '</b></div>'
        + '<div class="ic-cap-bar"><span class="ic-cap-fill ic-cap-fill--' + kind + '" style="width:' + pct + '%"></span></div>'
        + '<div class="ic-cap-pct" data-no-i18n>' + pct + '%</div></div>';
    };

    var measured = '<div class="ic-caps">'
      + bar('Process heap', proc.heapUsedMb, proc.heapTotalMb, 'MB')
      + bar('Historical delivery backlog', hist.pendingDeliveries, hist.pendingCriticalAt, T('events'))
      + '</div>'
      + '<div class="ic-stats ic-stats--4">'
      + stat('Stored historical events', hist.storedEvents)
      + stat('Database round trip', has(db.latencyMs) ? db.latencyMs + ' ms' : null)
      + stat('Registered event types', fab.registeredEventTypes)
      + stat('Process uptime', has(proc.uptimeSeconds) ? Math.floor(Number(proc.uptimeSeconds) / 60) + ' min' : null)
      + '</div>';

    // §18 — projection requires history this build does not keep. Saying so.
    var projection = '<div class="ic-future">'
      + '<div class="ic-future-state">' + esc(T('Not enough history')) + '</div>'
      + '<p>' + esc(T('Trend projection needs a stored series of capacity readings over time. This build measures capacity live and keeps no series, so no growth estimate can be made honestly.')) + '</p>'
      + '<p class="ic-future-note">' + esc(T('The Historical Event Store records event volume, not resource capacity. An estimate drawn from it would be a different measurement wearing the right label.')) + '</p>'
      + '</div>';

    return panel('Measured capacity', measured,
      T('Live readings only. A figure the platform does not measure is a dash, not a zero.'))
      + panel('Growth projection', projection);
  }

  // ── TECHNOLOGY MAP ────────────────────────────────────────────────────────

  function technologyHtml() {
    if (!IC.technology) return panel('Technology Map', skeleton(6));
    var t = IC.technology;
    var byCat = {};
    t.technologies.forEach(function (x) { (byCat[x.category] = byCat[x.category] || []).push(x); });

    var cats = Object.keys(byCat).sort();
    var grid = cats.map(function (cat) {
      return '<div class="ic-techcat">'
        + '<div class="ic-techcat-label" data-no-i18n>' + esc(cat) + '</div>'
        + '<div class="ic-techlist">' + byCat[cat].map(function (x) {
          var on = IC.techFocus === x.id;
          return '<button class="ic-tech' + (on ? ' is-on' : '') + '" type="button" data-ic-tech="' + esc(x.id) + '">'
            + '<span class="ic-tech-name" data-no-i18n>' + esc(x.name) + '</span>'
            + (x.version ? '<span class="ic-tech-ver" data-no-i18n>' + esc(x.version) + '</span>' : '')
            + '</button>';
        }).join('') + '</div></div>';
    }).join('');
    // Most categories hold one or two technologies. Stacked, that is a column of
    // labels down the left of an empty page; as a grid it is one readable block
    // that fits the width it is given.
    grid = '<div class="ic-techgrid">' + grid + '</div>';

    var focus = '';
    if (IC.techFocus) {
      var hit = t.technologies.filter(function (x) { return x.id === IC.techFocus; })[0];
      if (hit) {
        var used = (hit.usage && hit.usage.components) || [];
        focus = panel('Used by',
          (used.length
            ? '<div class="ic-buildings">' + used.map(function (id) {
              var c = componentById(id);
              return c ? buildingHtml(c) : '';
            }).join('') + '</div>'
            : emptyState('No component recorded', T('The manifest records no component in this technology’s districts.')))
          + '<div class="ic-kv"><div class="ic-kv-row"><span>' + esc(T('Evidence')) + '</span>'
          + '<b data-no-i18n>' + esc(hit.sourceEvidence) + '</b></div></div>',
          hit.name);
      }
    }

    var scanners = '<div class="ic-kv">'
      + [['Vulnerability scanning', t.vulnerabilityScanning], ['Lint', t.lint], ['Coverage', t.coverage]]
        .map(function (r) {
          return '<div class="ic-kv-row"><span>' + esc(T(r[0])) + '</span>'
            + '<b><span class="ic-chip ic-chip--off ic-chip--sm">' + esc(stateLabel(r[1].state)) + '</span></b></div>'
            + '<div class="ic-kv-note">' + esc(r[1].note) + '</div>';
        }).join('') + '</div>';

    var depRows = (t.dependencies || []).slice().sort(function (a, b) {
      return a.classification.localeCompare(b.classification) || a.name.localeCompare(b.name);
    });

    return panel('Verified technologies', grid,
      T('Every entry is proved by a file in the repository.'))
      + focus
      + panel('Quality instrumentation', scanners,
        T('Absence of findings is absence of a scanner, not a clean bill of health.'))
      + panel('Dependency inventory',
        '<div class="ic-table ic-table--deps">'
        + '<div class="ic-tr ic-tr--head" aria-hidden="true"><span>' + esc(T('Package')) + '</span>'
        + '<span>' + esc(T('Declared')) + '</span><span>' + esc(T('Resolved')) + '</span>'
        + '<span>' + esc(T('Classification')) + '</span></div>'
        + depRows.map(function (d) {
          return '<div class="ic-tr">'
            + '<span class="ic-td-name" data-no-i18n>' + esc(d.name) + '</span>'
            + '<span data-no-i18n>' + esc(d.declared) + '</span>'
            + '<span data-no-i18n>' + (d.resolved ? esc(d.resolved) : '—') + '</span>'
            + '<span>' + esc(T(d.classification === 'RUNTIME' ? 'Runtime' : 'Development')) + '</span>'
            + '</div>';
        }).join('') + '</div>',
        T('Declared range from package.json; resolved version from the lockfile.'));
  }

  // ── DEPENDENCIES (change impact) ──────────────────────────────────────────

  function dependenciesHtml() {
    if (!IC.manifest) return panel('Dependencies', skeleton(6));
    var target = IC.focusComponent || (IC.manifest.components[0] || {}).id;
    var c = componentById(target);
    if (!c) return panel('Dependencies', emptyState('Nothing selected', ''));

    var edges = IC.manifest.relationships || [];
    var deps = new Set();
    var dependents = new Set();
    (c.dependencies || []).forEach(function (d) { deps.add(d); });
    edges.forEach(function (e) {
      if (e.from === c.id) deps.add(e.to);
      if (e.to === c.id) dependents.add(e.from);
    });
    IC.manifest.components.forEach(function (x) {
      if ((x.dependencies || []).indexOf(c.id) >= 0) dependents.add(x.id);
    });

    var group = function (title, ids, note) {
      var list = [...ids].map(componentById).filter(Boolean);
      return panel(title, list.length
        ? '<div class="ic-buildings">' + list.map(buildingHtml).join('') + '</div>'
        : emptyState('None recorded', T('The manifest records no relationship in this direction.')), note);
    };

    var picker = '<div class="ic-picker">'
      + '<label class="ic-field"><span>' + esc(T('Component')) + '</span>'
      + '<select data-ic-depfocus>' + IC.manifest.components.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name);
      }).map(function (x) {
        return '<option value="' + esc(x.id) + '"' + (x.id === c.id ? ' selected' : '') + ' data-no-i18n>'
          + esc(x.name) + '</option>';
      }).join('') + '</select></label></div>';

    return panel('Change impact', picker
      + '<div class="ic-notice">' + esc(T('If this component changes, everything below it may be affected. These are repository relationships, not measured runtime impact.')) + '</div>')
      + group('Depends on', deps, T('What this component needs.'))
      + group('Depended on by', dependents, T('What would feel a change here.'));
  }

  // ── CHANGES ───────────────────────────────────────────────────────────────

  function changesHtml() {
    if (!IC.changes) return panel('Change History', skeleton(6));
    var rows = IC.changes.changes || [];
    var b = IC.changes.build;

    var build = '<div class="ic-kv">'
      + '<div class="ic-kv-row"><span>' + esc(T('Manifest generated')) + '</span>'
      + '<b data-no-i18n>' + esc((fmtInstant(b && b.manifestGeneratedAt) || {}).utc || '—') + '</b></div>'
      + '<div class="ic-kv-row"><span>' + esc(T('Platform version')) + '</span>'
      + '<b data-no-i18n>' + esc((b && b.platformVersion) || '—') + '</b></div>'
      + '<div class="ic-kv-row"><span>' + esc(T('Latest migration')) + '</span>'
      + '<b data-no-i18n>' + esc((b && b.latestMigration) || '—') + '</b></div>'
      + '<div class="ic-kv-row"><span>' + esc(T('Deployment')) + '</span>'
      + '<b><span class="ic-chip ic-chip--unver ic-chip--sm">' + esc(T('Unverified')) + '</span></b></div>'
      + '</div>'
      + '<div class="ic-notice ic-notice--soft">' + esc(IC.changes.deployment.note) + '</div>';

    var list = rows.length
      ? '<div class="ic-changes">' + rows.map(function (r) {
        var at = fmtInstant(r.occurredAt);
        return '<div class="ic-change">'
          + '<span class="ic-change-at" data-no-i18n>' + esc(at ? at.utc : '—') + '</span>'
          + '<span class="ic-change-type" data-no-i18n>' + esc(r.eventType) + '</span>'
          + '<span class="ic-change-ent" data-no-i18n>' + esc(r.entityId || r.entityType || '—') + '</span>'
          + '</div>';
      }).join('') + '</div>'
      : emptyState('No infrastructure changes recorded',
        T('Nothing matching a deployment, configuration or health transition is in the historical window.'));

    return panel('Current build', build)
      + panel('Recorded changes', list,
        T('Read from the Historical Event Store — the platform’s own record, not a file timestamp.'));
  }

  // ── RULES ─────────────────────────────────────────────────────────────────

  function rulesHtml() {
    if (!IC.incidents) return panel('Detection Rules', skeleton(6));
    var rules = IC.incidents.rules || [];
    return panel('Detection rules',
      '<div class="ic-rules">' + rules.map(function (r) {
        return '<div class="ic-rule">'
          + '<div class="ic-rule-head">'
          + '<span class="ic-rule-title">' + esc(T(r.title)) + '</span>'
          + '<span class="ic-chip ic-chip--' + (r.severity === 'CRITICAL' ? 'crit' : r.severity === 'WARNING' ? 'warn' : 'info')
          + ' ic-chip--sm">' + esc(T(r.severity === 'CRITICAL' ? 'Critical' : r.severity === 'WARNING' ? 'Warning' : 'Info')) + '</span>'
          + '<span class="ic-rule-id" data-no-i18n>' + esc(r.id) + '</span>'
          + '</div>'
          + '<div class="ic-rule-cond">' + esc(r.condition) + '</div>'
          + '<div class="ic-rule-meta"><span>' + esc(T('Component')) + ': <b data-no-i18n>'
          + esc((componentById(r.componentId) || {}).name || r.componentId) + '</b></span></div>'
          + '</div>';
      }).join('') + '</div>',
      T('Deterministic and inspectable. No scoring, no weighting, no model.'));
  }

  // ── EVIDENCE ──────────────────────────────────────────────────────────────

  function evidenceHtml() {
    if (!IC.manifest) return panel('Evidence & Sources', skeleton(5));
    var m = IC.manifest;
    var files = (m.evidence && m.evidence.filesRead) || [];

    return panel('How this map was built',
      '<div class="ic-kv">'
      + '<div class="ic-kv-row"><span>' + esc(T('Generator')) + '</span><b data-no-i18n>scripts/infrastructure-discover.js</b></div>'
      + '<div class="ic-kv-row"><span>' + esc(T('Generated at')) + '</span><b data-no-i18n>'
      + esc((fmtInstant(m.generatedAt) || {}).utc || '—') + '</b></div>'
      + '<div class="ic-kv-row"><span>' + esc(T('Components discovered')) + '</span><b data-no-i18n>' + esc(num(m.counts.components)) + '</b></div>'
      + '</div>'
      + '<div class="ic-filelist">' + files.map(function (f) {
        return '<span class="ic-file" data-no-i18n>' + esc(f) + '</span>';
      }).join('') + '</div>',
      T('An auditor can re-read exactly these files and get exactly this answer.'))
      + panel('What never reaches this screen',
        '<ul class="ic-bullets">'
        + [
          'Environment values, connection strings, keys and tokens.',
          'Anything a user typed.',
          'Private repository credentials.',
          'Database URLs and infrastructure hostnames.',
        ].map(function (x) { return '<li>' + esc(T(x)) + '</li>'; }).join('')
        + '</ul>'
        + '<div class="ic-kv"><div class="ic-kv-row"><span>' + esc(T('Declared variables')) + '</span>'
        + '<b data-no-i18n>' + esc(num(m.environment.total)) + '</b></div>'
        + '<div class="ic-kv-row"><span>' + esc(T('Secret-shaped names, reported as a count only')) + '</span>'
        + '<b data-no-i18n>' + esc(num(m.environment.secretShapedCount)) + '</b></div></div>',
        T('The discovery script refuses to write a manifest containing a secret-shaped value.'));
  }

  // ── INSPECTOR ─────────────────────────────────────────────────────────────

  function inspectorHtml() {
    if (!IC.inspect) return '';
    var c = componentById(IC.inspect);
    if (!c) return '';
    var d = districtById(c.district);
    var s = signalFor(c.healthKey);
    var state = componentState(c);
    var incidents = ((IC.health && IC.health.incidents) || []).filter(function (i) { return i.componentId === c.id; });

    var row = function (k, v, mono) {
      return '<div class="ic-insp-row"><div class="ic-insp-k">' + esc(T(k)) + '</div>'
        + '<div class="ic-insp-v"' + (mono ? ' data-no-i18n' : '') + '>'
        + (has(v) && v !== '' ? esc(String(v)) : absent(T('Not recorded.'))) + '</div></div>';
    };

    var measurements = s && s.measurements
      ? Object.keys(s.measurements).map(function (k) {
        var v = s.measurements[k];
        // The key is the API's own field name, so it is drawn as an identifier
        // rather than as a label: upper-casing `latencyMs` produces LATENCYMS,
        // which reads as neither the field nor English.
        return '<div class="ic-insp-row"><div class="ic-insp-k ic-insp-k--id" data-no-i18n>' + esc(k) + '</div>'
          + '<div class="ic-insp-v" data-no-i18n>' + (v === null || v === undefined ? '—' : esc(String(v))) + '</div></div>';
      }).join('')
      : '<div class="ic-insp-note">' + esc(T('Nothing in this build measures this component.')) + '</div>';

    var deps = (c.dependencies || []).map(componentById).filter(Boolean);
    var dependents = IC.manifest.components.filter(function (x) {
      return (x.dependencies || []).indexOf(c.id) >= 0;
    });

    return '<div class="ic-insp-scrim" data-ic-close-insp></div>'
      + '<aside class="ic-insp" role="dialog" aria-label="' + esc(T('Component details')) + '">'
      + '<div class="ic-insp-head">'
      + '<div><div class="ic-insp-title">' + esc(T(c.name)) + '</div>'
      + '<div class="ic-insp-sub">' + esc(d ? T(d.name) : c.district) + '</div></div>'
      + '<button class="ic-insp-x" type="button" data-ic-close-insp aria-label="' + esc(T('Close')) + '">×</button>'
      + '</div>'
      + '<div class="ic-insp-body">'

      + '<div class="ic-insp-state"><span class="ic-chip ic-chip--' + stateKind(state) + '">'
      + '<span class="ic-dot"></span>' + esc(stateLabel(state)) + '</span>'
      + (s ? '<span class="ic-insp-sum">' + esc(s.summary) + '</span>' : '') + '</div>'

      + '<div class="ic-insp-sec">' + esc(T('Overview')) + '</div>'
      + row('Type', c.type, true)
      + row('Category', c.category, true)
      + row('Version', c.version, true)
      + row('Provider', c.provider, true)
      + row('Region', c.region, true)
      + row('Repository path', c.repositoryPath, true)
      + (c.note ? '<div class="ic-insp-note">' + esc(c.note) + '</div>' : '')

      + '<div class="ic-insp-sec">' + esc(T('Health')) + '</div>'
      + measurements
      + (s ? '<div class="ic-insp-note">' + esc(T('Source')) + ': <span data-no-i18n>' + esc(s.evidence) + '</span></div>' : '')

      + '<div class="ic-insp-sec">' + esc(T('Dependencies')) + '</div>'
      + (deps.length ? '<div class="ic-buildings">' + deps.map(buildingHtml).join('') + '</div>'
        : '<div class="ic-insp-note">' + esc(T('None recorded.')) + '</div>')

      + '<div class="ic-insp-sec">' + esc(T('Depended on by')) + '</div>'
      + (dependents.length ? '<div class="ic-buildings">' + dependents.map(buildingHtml).join('') + '</div>'
        : '<div class="ic-insp-note">' + esc(T('None recorded.')) + '</div>')

      + '<div class="ic-insp-sec">' + esc(T('Incidents')) + '</div>'
      + (incidents.length ? incidents.map(function (i) { return incidentHtml(i, false); }).join('')
        : '<div class="ic-insp-note">' + esc(T('No open incident for this component.')) + '</div>')

      + '<div class="ic-insp-sec">' + esc(T('Evidence')) + '</div>'
      + '<div class="ic-insp-ev" data-no-i18n>' + esc(c.sourceEvidence) + '</div>'
      + '</div>'
      + '<div class="ic-insp-foot">'
      + esc(T('This panel shows architectural metadata and measured telemetry. No environment value, credential or user data is available to it.'))
      + '</div></aside>';
  }

  // ── content switch ────────────────────────────────────────────────────────

  function contentHtml() {
    if (IC.error && !IC.manifest) {
      return panel('', emptyState('Infrastructure City could not be read', IC.error));
    }
    switch (IC.section) {
      case 'city': return citySectionHtml();
      case 'incidents': return incidentsHtml();
      case 'capacity': return capacityHtml();
      case 'technology': return technologyHtml();
      case 'dependencies': return dependenciesHtml();
      case 'changes': return changesHtml();
      case 'rules': return rulesHtml();
      case 'evidence': return evidenceHtml();
      default: return citySectionHtml();
    }
  }

  // ── painting ──────────────────────────────────────────────────────────────

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', IC_DIR);
    host.setAttribute('lang', IC_LANG);
    host.innerHTML = '<div class="ic-shell">'
      + railHtml()
      + '<main class="ic-main">' + topHtml()
      + '<div class="ic-body" id="ic-body">' + contentHtml() + '</div></main>'
      + '</div>' + inspectorHtml();
    try { icTranslate(host); } catch (_) {}
    scheduleRoads(host);
    watchPlan(host);
  }

  /** Repaint the body only, so the rail keeps its scroll and nothing jumps. */
  function repaintBody(host) {
    var body = host.querySelector('#ic-body');
    if (!body) return paint(host);
    body.innerHTML = contentHtml();
    try { icTranslate(body); } catch (_) {}

    var old = host.querySelector('.ic-insp');
    var scrim = host.querySelector('.ic-insp-scrim');
    if (old) old.remove();
    if (scrim) scrim.remove();
    if (IC.inspect) {
      host.insertAdjacentHTML('beforeend', inspectorHtml());
      try { icTranslate(host.querySelector('.ic-insp')); } catch (_) {}
    }
    refreshChrome(host);
    // The body was replaced, so the plan element is new: re-measure, and point
    // the observer at the element that now exists rather than the detached one.
    if (host.__icPlanObserver) { try { host.__icPlanObserver.disconnect(); } catch (_) {} }
    host.__icPlanObserver = null;
    scheduleRoads(host);
    watchPlan(host);
  }

  /** The two places outside the body that carry live state. */
  function refreshChrome(host) {
    var foot = host.querySelector('.ic-rail-foot');
    if (foot) { foot.innerHTML = streamChipHtml(); try { icTranslate(foot); } catch (_) {} }
    var chip = host.querySelector('.ic-top-r .ic-chip');
    if (chip && IC.health) {
      var wrap = document.createElement('div');
      wrap.innerHTML = '<span class="ic-chip ic-chip--' + stateKind(IC.health.overall) + '">'
        + '<span class="ic-dot"></span>' + esc(stateLabel(IC.health.overall)) + '</span>';
      chip.replaceWith(wrap.firstChild);
    }
    var badgeHost = host.querySelector('[data-ic-nav="incidents"]');
    if (badgeHost && IC.health) {
      var existing = badgeHost.querySelector('.ic-rail-badge');
      if (existing) existing.remove();
      var n = IC.health.counts.critical + IC.health.counts.warning;
      if (n > 0) {
        badgeHost.insertAdjacentHTML('beforeend', '<span class="ic-rail-badge ic-rail-badge--'
          + (IC.health.counts.critical > 0 ? 'crit' : 'warn') + '" data-no-i18n>' + esc(num(n)) + '</span>');
      }
    }
  }

  // ── loading ───────────────────────────────────────────────────────────────

  /**
   * The fields this screen cannot draw without.
   *
   * Not a schema and not a validator — the contract lives in
   * `src/contracts/owner-api.contracts.ts` and is enforced by CI. This is the
   * last line: if a payload somehow reaches a browser without them, the city
   * must SAY SO rather than draw itself empty.
   *
   * That distinction is the entire lesson of the `relationships` defect. Every
   * read in this module is guarded with `|| []`, which is correct for an empty
   * platform and catastrophic for an absent field: both render a blank panel,
   * and a blank panel reads as "nothing here" rather than "I was not told".
   */
  var REQUIRED = {
    manifest: ['districts', 'components', 'relationships'],
    health: ['overall', 'signals', 'counts'],
  };

  /**
   * Which required fields a payload is missing.
   *
   * Absence only — a present-but-empty array is a real answer about a real
   * platform and is never reported here.
   */
  function missingFields(payload, required) {
    var missing = [];
    for (var i = 0; i < required.length; i++) {
      var k = required[i];
      if (!payload || payload[k] === undefined || payload[k] === null) missing.push(k);
    }
    return missing;
  }

  /** A contract failure, said in the words a reader can act on. */
  function contractError(endpoint, missing) {
    return T('CONTRACT ERROR') + ' · ' + endpoint + ' · '
      + T('the response did not carry:') + ' ' + missing.join(', ');
  }

  function loadManifest() {
    return api('/system/infrastructure').then(function (d) {
      var missing = missingFields(d, REQUIRED.manifest);
      if (missing.length) {
        IC.manifest = null;
        IC.error = contractError('/system/infrastructure', missing);
        return;
      }
      IC.manifest = d; IC.error = null;
    }).catch(function (e) { IC.error = e.message; });
  }
  function loadHealth() {
    return api('/system/infrastructure/health').then(function (d) {
      var missing = missingFields(d, REQUIRED.health);
      if (missing.length) {
        IC.health = null;
        IC.error = contractError('/system/infrastructure/health', missing);
        return;
      }
      IC.health = d; IC.stream.lastAt = new Date().toISOString();
    }).catch(function (e) { IC.error = e.message; });
  }
  function loadIncidents() {
    if (IC.incidents) return Promise.resolve();
    return api('/system/infrastructure/incidents').then(function (d) { IC.incidents = d; }).catch(function () {});
  }
  function loadTechnology() {
    if (IC.technology) return Promise.resolve();
    return api('/system/infrastructure/technology').then(function (d) { IC.technology = d; }).catch(function () {});
  }
  function loadChanges() {
    if (IC.changes) return Promise.resolve();
    return api('/system/infrastructure/changes').then(function (d) { IC.changes = d; }).catch(function () {});
  }

  // ── the live stream ───────────────────────────────────────────────────────
  //
  // Server-Sent Events, the transport the platform already runs for the live
  // data board. The server sets the pace; this module never polls faster than
  // it is told, and falls back to a bounded poll only if the stream cannot be
  // opened at all.

  var pollTimer = null;
  var streamAbort = null;
  var retryAt = 1000;

  function stopStream() {
    if (streamAbort) { try { streamAbort.abort(); } catch (_) {} streamAbort = null; }
    if (pollTimer) { clearTimeout(pollTimer); clearInterval(pollTimer); pollTimer = null; }
    IC.stream.state = 'IDLE';
  }

  /**
   * Open the stream with `fetch` and read it, rather than with the browser's
   * built-in event-source object.
   *
   * This is the house pattern, and `data-pulse.js` states the reason in its own
   * header: that object cannot set headers, so it would force the access token
   * into a query string where every proxy in the path writes it to a log. A
   * reader over `fetch` carries the Authorization header like any other call.
   */
  function startStream(host) {
    stopStream();
    if (typeof window.ReadableStream !== 'function' || !window.fetch) return startPolling(host);

    IC.stream.state = 'CONNECTING';
    refreshChrome(host);

    var ctl = null;
    try { ctl = new AbortController(); streamAbort = ctl; } catch (_) { return startPolling(host); }

    var t = token();
    fetch(apiBase() + '/system/infrastructure/stream', {
      headers: Object.assign({ Accept: 'text/event-stream' }, t ? { Authorization: 'Bearer ' + t } : {}),
      credentials: 'include',
      signal: ctl.signal,
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      IC.stream.attempts = 0;
      retryAt = 1000;

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      (function read() {
        reader.read().then(function (r) {
          if (r.done) throw new Error('stream ended');
          buf += decoder.decode(r.value, { stream: true });
          // Frames are separated by a blank line. Anything after the last one
          // is a partial frame and stays in the buffer.
          var parts = buf.split('\n\n');
          buf = parts.pop();
          parts.forEach(function (block) {
            var name = 'message'; var payload = '';
            block.split('\n').forEach(function (line) {
              if (line.indexOf('event:') === 0) name = line.slice(6).trim();
              else if (line.indexOf('data:') === 0) payload += line.slice(5).trim();
            });
            if (!payload) return;   // a retry or comment line
            try {
              var data = JSON.parse(payload);
              if (name === 'health') {
                // A frame missing what the screen needs is dropped, not
                // installed. Replacing a good frame with an unusable one would
                // blank a dashboard somebody is reading during an incident.
                if (missingFields(data, REQUIRED.health).length) return;
                IC.health = data;
                IC.stream.state = 'LIVE';
                IC.stream.lastAt = new Date().toISOString();
                onHealthFrame(host);
              }
            } catch (_) { /* a truncated frame is skipped, not fatal */ }
          });
          read();
        }).catch(fail);
      }());
    }).catch(fail);

    /**
     * Reconnect with a backoff, and say so on screen while it happens.
     *
     * A silent reconnect makes a dead stream look like an idle platform, which
     * is the one confusion an infrastructure screen must never create.
     */
    function fail(err) {
      if (ctl && ctl.signal && ctl.signal.aborted) return;   // we closed it
      IC.stream.attempts += 1;
      if (IC.stream.attempts >= 4) return startPolling(host);
      IC.stream.state = 'CONNECTING';
      refreshChrome(host);
      retryAt = Math.min(retryAt * 2, 20000);
      pollTimer = setTimeout(function () { startStream(host); }, retryAt);
      void err;
    }
  }

  /** The fallback. Bounded, and it says on screen that it is polling. */
  function startPolling(host) {
    if (streamAbort) { try { streamAbort.abort(); } catch (_) {} streamAbort = null; }
    if (pollTimer) { clearTimeout(pollTimer); clearInterval(pollTimer); }
    IC.stream.state = 'POLLING';
    refreshChrome(host);
    var tick = function () { loadHealth().then(function () { onHealthFrame(host); }); };
    tick();
    pollTimer = setInterval(tick, 20000);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  /**
   * A new health frame arrived.
   *
   * Repaints the body only when the reader is looking at something that health
   * actually changes. Redrawing the Technology Map because a heap reading moved
   * would move the page under somebody who is reading it.
   */
  function onHealthFrame(host) {
    var affected = IC.section === 'city' || IC.section === 'incidents' || IC.section === 'capacity';
    if (affected) repaintBody(host);
    else refreshChrome(host);
  }

  // ── the roads ─────────────────────────────────────────────────────────────
  //
  // Every street on the plan is one row of `manifest.relationships`. There is
  // no decorative line: if two buildings are joined, the repository proves they
  // are, and the evidence is in the Connections list under Topology.
  //
  // Drawn AFTER layout because a street needs to know where its two ends
  // landed, and only the browser knows that. The svg is absolutely positioned
  // and `pointer-events: none`, so adding it moves nothing and intercepts
  // nothing — the reader's scroll position is untouched by a redraw.

  var roadFrame = 0;

  function clearRoads(host) {
    var svg = host.querySelector('.ic-roads');
    if (svg) svg.innerHTML = '';
  }

  /**
   * Measure the plan, then lay the streets.
   *
   * Orthogonal with rounded corners rather than straight diagonals: a city has
   * streets, not sightlines, and a right-angled route reads as infrastructure
   * where a diagonal reads as a graph edge.
   */
  function drawRoads(host) {
    var svg = host.querySelector('.ic-roads');
    var plan = host.querySelector('.ic-plan');
    if (!svg || !plan || !IC.manifest) return;

    var edges = IC.manifest.relationships || [];
    if (!edges.length) { svg.innerHTML = ''; return; }

    var base = plan.getBoundingClientRect();
    if (!base.width || !base.height) return;
    svg.setAttribute('viewBox', '0 0 ' + Math.round(base.width) + ' ' + Math.round(base.height));
    svg.setAttribute('width', Math.round(base.width));
    svg.setAttribute('height', Math.round(base.height));

    var at = function (id) {
      var el = plan.querySelector('[data-ic-component="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
    };

    var parts = [];
    edges.forEach(function (e) {
      var a = at(e.from);
      var b = at(e.to);
      if (!a || !b) return;                       // one end is off-plan; draw nothing

      var from = componentById(e.from);
      var kind = stateKind(from ? componentState(from) : 'UNKNOWN');
      var hot = IC.focusPaths.indexOf(e.from + '>' + e.to) >= 0;

      // An L with a filleted corner, turning on whichever axis is the SHORT
      // one. Always turning on x sent a route that is mostly vertical out to a
      // midpoint far to the side and back — a detour across the plan that reads
      // as a mistake rather than as a street.
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var turn;
      if (Math.abs(dx) < 2 || Math.abs(dy) < 2) {
        turn = 'M' + a.x + ',' + a.y + ' L' + b.x + ',' + b.y;   // already straight
      } else if (Math.abs(dy) >= Math.abs(dx)) {
        var midY = a.y + dy / 2;
        var ry = Math.min(14, Math.abs(dy) / 4, Math.abs(dx) / 2);
        turn = 'M' + a.x + ',' + a.y
          + ' L' + a.x + ',' + (midY - Math.sign(dy) * ry)
          + ' Q' + a.x + ',' + midY + ' ' + (a.x + Math.sign(dx) * ry) + ',' + midY
          + ' L' + (b.x - Math.sign(dx) * ry) + ',' + midY
          + ' Q' + b.x + ',' + midY + ' ' + b.x + ',' + (midY + Math.sign(dy) * ry)
          + ' L' + b.x + ',' + b.y;
      } else {
        var midX = a.x + dx / 2;
        var rx = Math.min(14, Math.abs(dx) / 4, Math.abs(dy) / 2);
        turn = 'M' + a.x + ',' + a.y
          + ' L' + (midX - Math.sign(dx) * rx) + ',' + a.y
          + ' Q' + midX + ',' + a.y + ' ' + midX + ',' + (a.y + Math.sign(dy) * rx)
          + ' L' + midX + ',' + (b.y - Math.sign(dy) * rx)
          + ' Q' + midX + ',' + b.y + ' ' + (midX + Math.sign(dx) * rx) + ',' + b.y
          + ' L' + b.x + ',' + b.y;
      }

      parts.push('<path class="ic-road ic-road--' + kind + (hot ? ' is-hot' : '') + '" d="' + turn + '"/>');
      parts.push('<circle class="ic-road-node ic-road-node--' + kind + (hot ? ' is-hot' : '') + '" cx="'
        + b.x + '" cy="' + b.y + '" r="2.5"/>');
    });

    svg.innerHTML = parts.join('');
  }

  /** Redraw on the next frame, after the browser has laid the plan out. */
  function scheduleRoads(host) {
    if (roadFrame) cancelAnimationFrame(roadFrame);
    roadFrame = requestAnimationFrame(function () {
      roadFrame = 0;
      try { drawRoads(host); } catch (_) { clearRoads(host); }
    });
  }

  /**
   * Keep the streets attached to the buildings when the window changes.
   *
   * One observer for the life of the mount, on the plan itself, so a column
   * reflow at a breakpoint re-lays the roads rather than leaving them pointing
   * at where a building used to be.
   */
  function watchPlan(host) {
    if (host.__icPlanObserver || typeof ResizeObserver !== 'function') return;
    var obs = new ResizeObserver(function () { scheduleRoads(host); });
    host.__icPlanObserver = obs;
    var plan = host.querySelector('.ic-plan');
    if (plan) obs.observe(plan);
  }

  // ── alert → locate ────────────────────────────────────────────────────────

  /**
   * Take the reader to the problem.
   *
   * Focuses the district, highlights the building, lights the dependency paths
   * that touch it, and opens the inspector — so "where is the problem, what is
   * affected, why was it flagged, what do I check" are all answered on one
   * screen without another click.
   */
  function locate(host, incidentId) {
    var all = ((IC.health && IC.health.incidents) || []).concat((IC.health && IC.health.resolved) || []);
    var inc = all.filter(function (i) { return i.id === incidentId; })[0];
    if (!inc) return;

    IC.focusDistrict = inc.districtId;
    IC.focusComponent = inc.componentId;
    IC.focusPaths = ((IC.manifest && IC.manifest.relationships) || [])
      .filter(function (e) { return e.from === inc.componentId || e.to === inc.componentId; })
      .map(function (e) { return e.from + '>' + e.to; });
    IC.section = 'city';
    IC.view = 'city';
    IC.inspect = inc.componentId;

    paint(host);
    var el = host.querySelector('[data-ic-district="' + inc.districtId + '"]');
    if (el && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__icBound) return;
    host.__icBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;

      if (t.closest('[data-ic-home]')) {
        stopStream();
        try { window.navTo('owner-home'); } catch (_) {}
        return;
      }

      var nav = t.closest('[data-ic-nav]');
      if (nav) {
        IC.section = nav.getAttribute('data-ic-nav');
        IC.inspect = null;
        paint(host);
        afterNav(host);
        return;
      }

      if (t.closest('[data-ic-langs]')) { IC.langOpen = !IC.langOpen; paint(host); return; }
      var lang = t.closest('[data-ic-lang]');
      if (lang) {
        IC.langOpen = false;
        setLocale(lang.getAttribute('data-ic-lang')).then(function () { paint(host); });
        return;
      }

      var view = t.closest('[data-ic-view]');
      if (view) { IC.view = view.getAttribute('data-ic-view'); repaintBody(host); return; }

      var comp = t.closest('[data-ic-component]');
      if (comp) {
        IC.inspect = comp.getAttribute('data-ic-component');
        repaintBody(host);
        return;
      }
      if (t.closest('[data-ic-close-insp]')) { IC.inspect = null; repaintBody(host); return; }

      var loc = t.closest('[data-ic-locate]');
      if (loc) { locate(host, loc.getAttribute('data-ic-locate')); return; }

      if (t.closest('[data-ic-clearfocus]')) {
        IC.focusDistrict = null; IC.focusComponent = null; IC.focusPaths = [];
        repaintBody(host);
        return;
      }

      var ack = t.closest('[data-ic-ack]');
      if (ack) {
        var id = ack.getAttribute('data-ic-ack');
        api('/system/infrastructure/incidents/' + encodeURIComponent(id) + '/acknowledge', { method: 'POST' })
          .then(function () { return loadHealth(); })
          .then(function () { repaintBody(host); })
          .catch(function (e) { IC.error = e.message; repaintBody(host); });
        return;
      }

      var tech = t.closest('[data-ic-tech]');
      if (tech) {
        var tid = tech.getAttribute('data-ic-tech');
        IC.techFocus = IC.techFocus === tid ? null : tid;
        repaintBody(host);
        return;
      }

      var edge = t.closest('[data-ic-edge]');
      if (edge && IC.manifest) {
        var e = ((IC.manifest && IC.manifest.relationships) || [])[Number(edge.getAttribute('data-ic-edge'))];
        if (e) { IC.inspect = e.from; repaintBody(host); }
        return;
      }
    });

    host.addEventListener('change', function (ev) {
      var sel = ev.target.closest('[data-ic-depfocus]');
      if (sel) { IC.focusComponent = sel.value; repaintBody(host); }
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && IC.inspect) { IC.inspect = null; repaintBody(host); }
    });
  }

  function afterNav(host) {
    if (IC.section === 'technology') loadTechnology().then(function () { repaintBody(host); });
    else if (IC.section === 'changes') loadChanges().then(function () { repaintBody(host); });
    else if (IC.section === 'rules' || IC.section === 'incidents') {
      loadIncidents().then(function () { repaintBody(host); });
    }
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaInfrastructureCity = function (host) {
    host = host || document.getElementById('ic-root');
    if (!host) return;
    bind(host);
    setLocale(storedLocale()).then(function () {
      paint(host);
      return Promise.all([loadManifest(), loadHealth()]);
    }).then(function () {
      paint(host);
      startStream(host);
      afterNav(host);
    });
  };

  /** Torn down when the reader leaves, so no stream survives the page. */
  window.teardownFamilistaInfrastructureCity = function () {
    stopStream();
    if (roadFrame) { cancelAnimationFrame(roadFrame); roadFrame = 0; }
    var host = document.getElementById('ic-root');
    if (host && host.__icPlanObserver) {
      try { host.__icPlanObserver.disconnect(); } catch (_) {}
      host.__icPlanObserver = null;
    }
  };

  // Exposed for the test suite, which asserts the state vocabulary rather than
  // trusting a comment about it.
  try {
    window.__IC_TEST__ = { stateKind: stateKind, SECTIONS: SECTIONS, IC: IC };
  } catch (_) {}
}());
