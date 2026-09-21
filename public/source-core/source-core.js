/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA SOURCE CORE — where the platform's inputs come from

   THE FIFTH ROOM, AND THE ONE IN THE MIDDLE

   SYSTEM operates the platform. CLUBS operates the football organisations. The
   DATA VAULT is what the platform remembers. INFRASTRUCTURE CITY is what it is
   built from. SOURCE CORE is where everything the other four handle ORIGINATED,
   how it entered, what checked it, and who consumed it.

   It is the origin layer, so it is drawn at the centre and the other four are
   drawn around it as its consumers.

   IT DISCOVERS NOTHING AND OWNS NOTHING

   Every source on this screen is composed by the backend from registries that
   already exist — the Data Fabric's own source registry, the infrastructure
   manifest and the live health signals. This module fetches that composition
   and draws it. There is no list of sources in this file and there must never
   be one: a hand-written list is a second opinion, and the day it disagrees
   with the registry is the day somebody trusts the wrong one.

   FIVE LAYERS, LEFT TO RIGHT

     ORIGINS → INTAKE → VALIDATION → PROCESSING → CONSUMERS

   with the core in the middle. Every figure is measured or is an honest
   absence. A source nothing measures says NOT INSTRUMENTED; a provider with no
   credentials configured says NOT CONFIGURED; a plot with no code behind it
   says FUTURE. None of them is ever drawn as healthy.

   NO SECOND STREAM

   Source health IS infrastructure health joined onto sources, so this module
   subscribes to the stream Infrastructure City already runs rather than opening
   a second socket to carry the same thirteen readings.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var SC = {
    registry: null,
    flow: null,
    health: null,
    error: null,
    section: 'flow',
    view: 'flow',
    inspect: null,
    lineage: null,
    consumers: null,
    focusConsumer: null,
    focusSource: null,
    query: '',
    filters: {},
    langOpen: false,
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
    try { return n.toLocaleString(SC_LANG === 'ar' ? 'ar' : SC_LANG); } catch (_) { return String(n); }
  }
  function has(v) { return v !== null && v !== undefined; }

  function absent(why) {
    return '<span class="sc-none" title="' + esc(why || '') + '">—</span>';
  }

  function fmtInstant(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var local;
    try {
      local = new Intl.DateTimeFormat(SC_LANG === 'ar' ? 'ar' : SC_LANG, {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(d);
    } catch (_) { local = d.toISOString().replace('T', ' ').slice(0, 16); }
    return { local: local, utc: d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
  }

  // ── localisation ──────────────────────────────────────────────────────────
  //
  // This module's own three-language catalogue, behind `data-no-i18n` on the
  // page root — the same boundary SYSTEM, the Data Vault and Infrastructure
  // City keep, so these strings never enter the club product's locale files.

  var SC_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var SC_DICT = {};
  var SC_LANG = 'en';
  var SC_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < SC_LOCALES.length; i++) if (SC_LOCALES[i][0] === tag) return SC_LOCALES[i];
    return SC_LOCALES[0];
  }
  function initialLocale() {
    try {
      var v = localStorage.getItem('familista_sourcecore_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { SC_DICT = {}; return Promise.resolve(); }
    return fetch('/source-core/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { SC_DICT = d || {}; })
      .catch(function () { SC_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    SC_LANG = l[0]; SC_DIR = l[2];
    try { localStorage.setItem('familista_sourcecore_locale', SC_LANG); } catch (_) {}
    return loadDict(SC_LANG);
  }

  /** One string. A digit run becomes %d; a missing key falls through to English. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || SC_LANG === 'en') return s;
    if (Object.prototype.hasOwnProperty.call(SC_DICT, s)) return SC_DICT[s];
    var slot = s.replace(/\d[\d.,  ]*/g, '%d');
    if (slot !== s && Object.prototype.hasOwnProperty.call(SC_DICT, slot)) {
      var nums = s.match(/\d[\d.,  ]*/g) || [];
      var i = 0;
      return String(SC_DICT[slot]).replace(/%d/g, function () { return nums[i++] != null ? nums[i - 1] : '%d'; });
    }
    return s;
  }

  function scTranslate(root) {
    if (!root || SC_LANG === 'en') return;
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
    var active = localeOf(SC_LANG);
    return '<div class="sc-langs' + (SC.langOpen ? ' is-open' : '') + '">'
      + '<button class="sc-lang-pick" type="button" data-sc-langs'
      + ' aria-expanded="' + (SC.langOpen ? 'true' : 'false') + '" aria-label="Source Core language">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="sc-lang-ch">⌄</span></button>'
      + '<div class="sc-lang-menu" role="group">'
      + SC_LOCALES.map(function (l) {
        return '<button class="sc-lang' + (l[0] === SC_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-sc-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === SC_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // Eight health words and five connection words, each meaning one thing.
  // `stateKind` is the single place a state becomes a colour.

  function stateKind(s) {
    switch (String(s || '').toUpperCase()) {
      case 'HEALTHY': case 'LIVE': case 'CONNECTED': return 'ok';
      case 'WARNING': case 'DELAYED': return 'warn';
      case 'CRITICAL': return 'crit';
      case 'DISCONNECTED': case 'NOT_CONFIGURED': case 'NOT_CONNECTED': return 'off';
      case 'NOT_INSTRUMENTED': return 'none';
      case 'UNVERIFIED': return 'unver';
      case 'FUTURE': return 'future';
      default: return 'unknown';
    }
  }
  function stateLabel(s) {
    switch (String(s || '').toUpperCase()) {
      case 'HEALTHY': return T('Healthy');
      case 'LIVE': return T('Live');
      case 'CONNECTED': return T('Connected');
      case 'WARNING': return T('Warning');
      case 'DELAYED': return T('Delayed');
      case 'CRITICAL': return T('Critical');
      case 'DISCONNECTED': return T('Disconnected');
      case 'NOT_CONFIGURED': return T('Not configured');
      case 'NOT_CONNECTED': return T('Not connected');
      case 'NOT_INSTRUMENTED': return T('Not instrumented');
      case 'UNVERIFIED': return T('Unverified');
      case 'FUTURE': return T('Future');
      default: return T('Unknown');
    }
  }

  var TYPE_LABEL = {
    INTERNAL_PLATFORM: 'Internal platform', USER_GENERATED: 'User generated',
    SYSTEM_GENERATED: 'System generated', EXTERNAL_PROVIDER: 'External provider',
    TECHNOLOGY: 'Technology', DATABASE: 'Database', EVENT: 'Event',
    FILE_MEDIA: 'File & media', AI: 'AI', DEVICE: 'Device',
    UNREGISTERED_INTAKE: 'Unregistered intake', FUTURE: 'Future',
  };

  var INTAKE_LABEL = {
    REST_API: 'REST API', WEBHOOK: 'Webhook', SSE: 'Server-Sent Events',
    INTERNAL_EVENT: 'Internal event', DATABASE_WRITE: 'Database write',
    FILE_UPLOAD: 'File upload', BACKGROUND_WORKER: 'Background worker',
    OUTBOUND_CALL: 'Outbound call', BUILD_TIME: 'Build time',
    DEPLOY_HOOK: 'Deploy hook', NOT_APPLICABLE: 'Not applicable', UNKNOWN: 'Unknown',
  };

  function sources() { return (SC.registry && SC.registry.sources) || []; }

  // ── navigation ────────────────────────────────────────────────────────────

  var SECTIONS = [
    ['flow', 'Source Flow', '◉', 'CORE'],
    ['internal', 'Internal Sources', '▣', 'CORE'],
    ['external', 'External Sources', '⇄', 'CORE'],
    ['technology', 'Technology Origins', '⬡', 'ORIGINS'],
    ['intake', 'Unregistered Intake', '⚠', 'ORIGINS'],
    ['future', 'Future Sources', '◌', 'ORIGINS'],
    ['lineage', 'Data Lineage', '⟿', 'PROVENANCE'],
    ['evidence', 'Evidence', '⛨', 'PROVENANCE'],
  ];
  var GROUP_ORDER = ['CORE', 'ORIGINS', 'PROVENANCE'];
  var GROUP_LABEL = { CORE: 'Core', ORIGINS: 'Origins', PROVENANCE: 'Provenance' };

  function railHtml() {
    var groups = GROUP_ORDER.map(function (g) {
      var items = SECTIONS.filter(function (s) { return s[3] === g; });
      if (!items.length) return '';
      return '<div class="sc-rail-group"><div class="sc-rail-label">' + esc(T(GROUP_LABEL[g])) + '</div>'
        + items.map(function (s) {
          var badge = '';
          if (s[0] === 'intake' && SC.registry && SC.registry.counts.unregisteredIntake) {
            badge = '<span class="sc-rail-badge sc-rail-badge--warn" data-no-i18n>'
              + esc(num(SC.registry.counts.unregisteredIntake)) + '</span>';
          }
          return '<button class="sc-rail-item' + (SC.section === s[0] ? ' is-on' : '') + '"'
            + ' type="button" data-sc-nav="' + s[0] + '">'
            + '<span class="sc-rail-icon" aria-hidden="true">' + s[2] + '</span>'
            + '<span class="sc-rail-text">' + esc(T(s[1])) + '</span>' + badge + '</button>';
        }).join('') + '</div>';
    }).join('');

    return '<nav class="sc-rail" aria-label="Source Core">'
      + '<div class="sc-rail-head">'
      + '<button class="sc-rail-home" type="button" data-sc-home aria-label="Back to Familista home">'
      + '<span aria-hidden="true">←</span><span class="sc-rail-text" data-no-i18n>Familista</span></button>'
      + '<div class="sc-rail-brand"><span class="sc-rail-mark" aria-hidden="true">◉</span>'
      + '<span class="sc-rail-title">' + esc(T('Source Core')) + '</span></div>'
      + '</div>'
      + '<div class="sc-rail-body">' + groups + '</div>'
      + '<div class="sc-rail-foot">' + originChipHtml() + '</div>'
      + '</nav>';
  }

  function originChipHtml() {
    if (!SC.registry) return '<div class="sc-origin"><span class="sc-chip sc-chip--unknown">'
      + esc(T('Reading registry…')) + '</span></div>';
    var at = fmtInstant(SC.registry.measuredAt);
    return '<div class="sc-origin">'
      + '<span class="sc-chip sc-chip--ok"><span class="sc-dot"></span>'
      + esc(T('%d sources').replace('%d', num(SC.registry.counts.total))) + '</span>'
      + (at ? '<span class="sc-origin-at" data-no-i18n title="' + esc(at.utc) + '">' + esc(at.local) + '</span>' : '')
      + '</div>';
  }

  function topHtml() {
    var title = (SECTIONS.filter(function (s) { return s[0] === SC.section; })[0] || [null, 'Source Core'])[1];
    var overall = SC.health ? SC.health.overall : null;
    return '<header class="sc-top">'
      + '<div><div class="sc-top-eyebrow" data-no-i18n>FAMILISTA · SOURCE CORE</div>'
      + '<h1 class="sc-top-title">' + esc(T(title)) + '</h1></div>'
      + '<div class="sc-top-r">'
      + (overall ? '<span class="sc-chip sc-chip--' + stateKind(overall) + '">'
        + '<span class="sc-dot"></span>' + esc(stateLabel(overall)) + '</span>' : '')
      + languageSwitchHtml()
      + '</div></header>';
  }

  /**
   * A panel. `tag` is for a name that is DATA — a module, a club, an id — which
   * must sit beside the title without being composed into it: a title built by
   * concatenation is a key the catalogue can never hold, and it ships English
   * into a translated page the first time the data changes.
   */
  function panel(title, body, note, tag) {
    return '<section class="sc-panel">'
      + (title ? '<div class="sc-panel-head"><h2 class="sc-panel-title">' + esc(T(title))
        + (tag ? ' <span class="sc-panel-tag" data-no-i18n>' + esc(tag) + '</span>' : '')
        + '</h2>'
        + (note ? '<span class="sc-panel-note">' + esc(note) + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }

  function emptyState(title, detail) {
    return '<div class="sc-empty"><div class="sc-empty-mark" aria-hidden="true">∅</div>'
      + '<div class="sc-empty-title">' + esc(T(title)) + '</div>'
      + (detail ? '<div class="sc-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  function skeleton(n) {
    var rows = '';
    for (var i = 0; i < (n || 5); i++) rows += '<div class="sc-skel-row"></div>';
    return '<div class="sc-skel">' + rows + '</div>';
  }

  // ── a source, drawn ───────────────────────────────────────────────────────

  function sourceChip(s) {
    var focused = SC.focusSource === s.id;
    return '<button class="sc-src sc-src--' + stateKind(s.health) + (focused ? ' is-focus' : '') + '"'
      + ' type="button" data-sc-source="' + esc(s.id) + '"'
      + ' title="' + esc(s.name + ' · ' + stateLabel(s.health)) + '">'
      + '<span class="sc-src-dot" aria-hidden="true"></span>'
      + '<span class="sc-src-name">' + esc(T(s.name)) + '</span>'
      + (s.producesCount ? '<span class="sc-src-count" data-no-i18n>' + esc(num(s.producesCount)) + '</span>' : '')
      + '</button>';
  }

  // ── FLOW VIEW — the hero ──────────────────────────────────────────────────

  var LAYER_ORDER = ['INTERNAL_ORIGIN', 'EXTERNAL_ORIGIN', 'UNREGISTERED_INTAKE', 'TECHNOLOGY', 'FUTURE'];
  var LAYER_LABEL = {
    INTERNAL_ORIGIN: 'Internal origins', EXTERNAL_ORIGIN: 'External origins',
    UNREGISTERED_INTAKE: 'Unregistered intake', TECHNOLOGY: 'Technology origins',
    FUTURE: 'Future origins',
  };

  function flowHtml() {
    if (!SC.flow) return skeleton(8);
    var o = SC.flow.origins || {};

    var originCol = LAYER_ORDER.filter(function (k) { return (o[k] || []).length; }).map(function (k) {
      var list = o[k];
      var shown = list.slice(0, k === 'TECHNOLOGY' ? 8 : 12);
      return '<div class="sc-olayer" data-sc-layer="' + k + '">'
        + '<div class="sc-olayer-head"><span class="sc-olayer-name">' + esc(T(LAYER_LABEL[k])) + '</span>'
        + '<span class="sc-olayer-n" data-no-i18n>' + esc(num(list.length)) + '</span></div>'
        + '<div class="sc-srcs">' + shown.map(sourceChip).join('')
        + (list.length > shown.length
          ? '<button class="sc-more" type="button" data-sc-nav="'
            + (k === 'TECHNOLOGY' ? 'technology' : k === 'FUTURE' ? 'future'
              : k === 'UNREGISTERED_INTAKE' ? 'intake' : k === 'EXTERNAL_ORIGIN' ? 'external' : 'internal')
            + '">' + esc(T('+%d more').replace('%d', num(list.length - shown.length))) + '</button>'
          : '')
        + '</div></div>';
    }).join('');

    var intake = Object.keys(SC.flow.intake || {}).sort(function (a, b) {
      return SC.flow.intake[b] - SC.flow.intake[a];
    }).map(function (k) {
      return '<div class="sc-mech"><span class="sc-mech-name">' + esc(T(INTAKE_LABEL[k] || k)) + '</span>'
        + '<span class="sc-mech-n" data-no-i18n>' + esc(num(SC.flow.intake[k])) + '</span></div>';
    }).join('');

    var controls = (SC.flow.validation || []).map(function (c) {
      return '<div class="sc-ctl sc-ctl--' + (c.state === 'APPLIED' ? 'ok' : 'off') + '">'
        + '<span class="sc-ctl-name">' + esc(T(c.id)) + '</span>'
        + '<span class="sc-ctl-state">' + esc(c.state === 'APPLIED' ? T('Applied') : T('Not instrumented')) + '</span>'
        + '</div>';
    }).join('');

    var counts = SC.flow.counts || {};

    // The one moving thing in this module, and it moves only because a count
    // says so. `counts.live` is the number of sources the Fabric has seen an
    // event from inside the live window; when it is zero the conduits are
    // drawn idle and nothing travels them. There is no decorative flow.
    var carry = counts.live > 0 ? 'live' : 'idle';

    var consumers = ['SYSTEM', 'CLUBS', 'DATA_VAULT', 'INFRASTRUCTURE_CITY'].map(function (m) {
      var on = SC.focusConsumer === m;
      return '<button class="sc-consumer' + (on ? ' is-focus' : '') + '" type="button" data-sc-consumer="' + m + '">'
        + '<span class="sc-consumer-mark" aria-hidden="true">'
        + (m === 'SYSTEM' ? '⚙' : m === 'CLUBS' ? '⛨' : m === 'DATA_VAULT' ? '⛁' : '◈') + '</span>'
        + '<span class="sc-consumer-name" data-no-i18n>' + esc(m.replace(/_/g, ' ')) + '</span>'
        + '</button>';
    }).join('');

    return '<div class="sc-flow">'
      + '<div class="sc-flow-ground" aria-hidden="true"></div>'
      + '<div class="sc-flow-grid">'

      + '<div class="sc-stage sc-stage--origins">'
      + '<div class="sc-stage-tag">' + esc(T('Stage 1')) + '</div>'
      + '<div class="sc-stage-title">' + esc(T('Origins')) + '</div>'
      + '<div class="sc-stage-body">' + (originCol || emptyState('No origins resolved', '')) + '</div>'
      + '</div>'

      + conduit(carry)

      + '<div class="sc-stage sc-stage--intake">'
      + '<div class="sc-stage-tag">' + esc(T('Stage 2')) + '</div>'
      + '<div class="sc-stage-title">' + esc(T('Intake')) + '</div>'
      + '<div class="sc-stage-sub">' + esc(T('How an input actually enters')) + '</div>'
      + '<div class="sc-stage-body">' + (intake || absent(T('Not measured.'))) + '</div>'
      + '</div>'

      + conduit(carry)

      // ── THE CORE ──
      + '<div class="sc-core-wrap">'
      + '<section class="sc-core">'
      + '<span class="sc-core-halo" aria-hidden="true"></span>'
      + '<div class="sc-core-mark" aria-hidden="true">◉</div>'
      + '<div class="sc-core-title" data-no-i18n>Familista Source Core</div>'
      + '<div class="sc-core-sub">' + esc(T('Origin & Provenance Layer')) + '</div>'
      + '<div class="sc-core-stats">'
      + coreStat(T('Sources'), counts.total)
      + coreStat(T('Internal'), counts.internal)
      + coreStat(T('External'), counts.external)
      + coreStat(T('Live'), counts.live)
      + '</div>'
      + '<div class="sc-core-ctls">' + esc(T('Validation')) + '</div>'
      + '<div class="sc-ctls">' + controls + '</div>'
      + '</section></div>'

      + conduit(carry)

      + '<div class="sc-stage sc-stage--processing">'
      + '<div class="sc-stage-tag">' + esc(T('Stage 4')) + '</div>'
      + '<div class="sc-stage-title">' + esc(T('Processing')) + '</div>'
      + '<div class="sc-stage-body">'
      + '<div class="sc-mech"><span class="sc-mech-name" data-no-i18n>Data Fabric</span></div>'
      + '<div class="sc-mech"><span class="sc-mech-name" data-no-i18n>Durable Outbox</span></div>'
      + '<div class="sc-mech"><span class="sc-mech-name" data-no-i18n>Historical Event Store</span></div>'
      + '</div></div>'

      + conduit(carry)

      + '<div class="sc-stage sc-stage--consumers">'
      + '<div class="sc-stage-tag">' + esc(T('Stage 5')) + '</div>'
      + '<div class="sc-stage-title">' + esc(T('Consumers')) + '</div>'
      + '<div class="sc-stage-sub">' + esc(T('Click one to see what feeds it')) + '</div>'
      + '<div class="sc-stage-body"><div class="sc-consumers">' + consumers + '</div></div>'
      + '</div>'

      + '</div></div>'

      + (SC.focusConsumer ? panel('Feeding',
        feedingHtml(SC.focusConsumer),
        T('Sources that declare this module as a destination.'),
        SC.focusConsumer.replace(/_/g, ' ')) : '');
  }

  function coreStat(label, v) {
    return '<div class="sc-cstat"><span class="sc-cstat-v" data-no-i18n>'
      + (has(v) ? esc(num(v)) : absent(T('Not measured.'))) + '</span>'
      + '<span class="sc-cstat-l">' + esc(label) + '</span></div>';
  }

  function conduit(kind) {
    return '<div class="sc-conduit sc-conduit--' + kind + '" aria-hidden="true">'
      + '<span class="sc-conduit-line"></span><span class="sc-conduit-head"></span></div>';
  }

  function feedingHtml(mod) {
    var list = sources().filter(function (s) { return (s.destinationModules || []).indexOf(mod) >= 0; });
    if (!list.length) {
      return emptyState('Nothing declares this destination',
        T('No source in the registry names this module as a destination.'));
    }
    return '<div class="sc-srcs">' + list.map(sourceChip).join('') + '</div>';
  }

  // ── filtered lists ────────────────────────────────────────────────────────

  function matches(s) {
    var q = SC.query.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.provider, s.sourceType, s.category, s.origin, s.intake]
      .concat(s.consumers || [])
      .some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
  }

  function searchBar() {
    return '<div class="sc-search">'
      + '<input class="sc-search-in" type="search" data-sc-search value="' + esc(SC.query) + '"'
      + ' placeholder="' + esc(T('Search by name, provider, type, module or consumer')) + '"'
      + ' aria-label="' + esc(T('Search sources')) + '">'
      + (SC.query ? '<button class="sc-search-x" type="button" data-sc-clear aria-label="'
        + esc(T('Clear search')) + '">×</button>' : '')
      + '</div>';
  }

  function tableHtml(list) {
    if (!list.length) return emptyState('No source matches', T('Nothing in the registry matches this search.'));
    return '<div class="sc-table">'
      + '<div class="sc-tr sc-tr--head" aria-hidden="true">'
      + '<span>' + esc(T('Source')) + '</span><span>' + esc(T('Type')) + '</span>'
      + '<span>' + esc(T('Origin')) + '</span><span>' + esc(T('Intake')) + '</span>'
      + '<span>' + esc(T('Health')) + '</span><span>' + esc(T('Produces')) + '</span></div>'
      + list.map(function (s) {
        return '<button class="sc-tr" type="button" data-sc-source="' + esc(s.id) + '">'
          + '<span class="sc-td-name">' + esc(T(s.name)) + '</span>'
          + '<span>' + esc(T(TYPE_LABEL[s.sourceType] || s.sourceType)) + '</span>'
          + '<span class="sc-td-origin">' + esc(s.origin) + '</span>'
          + '<span>' + esc(T(INTAKE_LABEL[s.intake] || s.intake)) + '</span>'
          + '<span class="sc-chip sc-chip--' + stateKind(s.health) + ' sc-chip--sm">'
          + esc(stateLabel(s.health)) + '</span>'
          + '<span data-no-i18n>' + (s.producesCount ? esc(num(s.producesCount)) : '—') + '</span>'
          + '</button>';
      }).join('') + '</div>';
  }

  function listSection(pred, title, note) {
    var list = sources().filter(pred).filter(matches);
    return searchBar() + panel(title, tableHtml(list), note);
  }

  // ── lineage ───────────────────────────────────────────────────────────────

  var STAGE_LABEL = {
    ORIGIN: 'Origin', INTAKE: 'Intake', VALIDATION: 'Validation',
    PROCESSING: 'Processing', DESTINATION: 'Destination', HISTORY: 'History',
  };

  function lineageHtml() {
    if (!SC.registry) return skeleton(6);
    var chosen = SC.lineage;
    var picker = '<div class="sc-srcs sc-srcs--pick">'
      + sources().filter(function (s) { return s.producesCount > 0; }).map(sourceChip).join('')
      + '</div>';

    if (!chosen) {
      return panel('Data lineage',
        picker + emptyState('Choose a source',
          T('Its path is drawn from the repository: origin, intake, the controls that ran, and where it went.')),
        T('Only sources that publish a registered event have a recorded path.'));
    }

    var stages = (chosen.stages || []).map(function (st, i) {
      return '<div class="sc-lstage sc-lstage--' + (st.state === 'VERIFIED' ? 'ok' : st.state === 'NOT_INSTRUMENTED' ? 'none' : 'off') + '">'
        + '<div class="sc-lstage-n" data-no-i18n>' + (i + 1) + '</div>'
        + '<div class="sc-lstage-b">'
        + '<div class="sc-lstage-stage">' + esc(T(STAGE_LABEL[st.stage] || st.stage)) + '</div>'
        + '<div class="sc-lstage-label">' + esc(T(st.label)) + '</div>'
        + '<div class="sc-lstage-detail">' + esc(T(st.detail)) + '</div>'
        + '<div class="sc-lstage-ev" data-no-i18n>' + esc(st.evidence) + '</div>'
        + '</div></div>';
    }).join('<div class="sc-lgap" aria-hidden="true"></div>');

    return panel('Data lineage', picker + '<div class="sc-lineage">' + stages + '</div>',
      T('Every stage carries the repository evidence that proves it.'));
  }

  // ── inspector ─────────────────────────────────────────────────────────────

  function inspectorHtml() {
    if (!SC.inspect) return '';
    var s = sources().filter(function (x) { return x.id === SC.inspect; })[0];
    if (!s) return '';

    var row = function (k, v) {
      return '<div class="sc-insp-row"><div class="sc-insp-k">' + esc(T(k)) + '</div>'
        + '<div class="sc-insp-v">' + (has(v) && v !== '' ? esc(String(v)) : absent(T('Not recorded.'))) + '</div></div>';
    };
    var idRow = function (k, v) {
      return '<div class="sc-insp-row"><div class="sc-insp-k">' + esc(T(k)) + '</div>'
        + '<div class="sc-insp-v" data-no-i18n>' + (has(v) && v !== '' ? esc(String(v)) : '—') + '</div></div>';
    };

    var last = fmtInstant(s.lastEventAt);
    var impact = (SC.consumers && SC.consumers.impact) || [];
    var grade = function (r) {
      return r === 'DIRECTLY_AFFECTED' ? T('Directly affected')
        : r === 'DEPENDENT' ? T('Dependent') : T('Potentially affected');
    };

    return '<div class="sc-insp-scrim" data-sc-close-insp></div>'
      + '<aside class="sc-insp" role="dialog" aria-label="' + esc(T('Source details')) + '">'
      + '<div class="sc-insp-head"><div>'
      + '<div class="sc-insp-title">' + esc(T(s.name)) + '</div>'
      + '<div class="sc-insp-sub">' + esc(T(TYPE_LABEL[s.sourceType] || s.sourceType)) + '</div></div>'
      + '<button class="sc-insp-x" type="button" data-sc-close-insp aria-label="' + esc(T('Close')) + '">×</button>'
      + '</div>'
      + '<div class="sc-insp-body">'

      + '<div class="sc-insp-state">'
      + '<span class="sc-chip sc-chip--' + stateKind(s.health) + '">' + esc(stateLabel(s.health)) + '</span>'
      + '<span class="sc-chip sc-chip--' + stateKind(s.connectionState) + ' sc-chip--sm">'
      + esc(stateLabel(s.connectionState)) + '</span>'
      + '<span class="sc-insp-sum">' + esc(T(s.origin)) + '</span></div>'

      + '<div class="sc-insp-sec">' + esc(T('Origin')) + '</div>'
      + row('Internal or external', s.internalOrExternal === 'INTERNAL' ? T('Internal') : T('External'))
      + idRow('Provider', s.provider)
      + idRow('Version', s.version)
      + row('Intake method', T(INTAKE_LABEL[s.intake] || s.intake))
      + row('Update mode', T(s.updateMode.replace(/_/g, ' ').toLowerCase()))
      + idRow('Region', s.region)

      + '<div class="sc-insp-sec">' + esc(T('Activity')) + '</div>'
      + '<div class="sc-insp-row"><div class="sc-insp-k">' + esc(T('Last event')) + '</div>'
      + '<div class="sc-insp-v" data-no-i18n>'
      + (last ? esc(last.local) : absent(T('Nothing recorded from this source.'))) + '</div></div>'
      + '<div class="sc-insp-row"><div class="sc-insp-k">' + esc(T('Events per minute')) + '</div>'
      + '<div class="sc-insp-v" data-no-i18n>'
      + (has(s.eventsPerMinute) ? esc(num(s.eventsPerMinute)) : absent(T('Not measured for this source.'))) + '</div></div>'
      + idRow('Schema version', s.schemaVersion)
      + row('Data classification', s.dataClassification)

      + '<div class="sc-insp-sec">' + esc(T('Controls')) + '</div>'
      + (s.controls.length
        ? '<div class="sc-ctls">' + s.controls.map(function (c) {
          return '<div class="sc-ctl sc-ctl--' + (c.state === 'APPLIED' ? 'ok' : 'off') + '">'
            + '<span class="sc-ctl-name">' + esc(T(c.id)) + '</span>'
            + '<span class="sc-ctl-state" data-no-i18n>' + esc(c.evidence) + '</span></div>';
        }).join('') + '</div>'
        : '<div class="sc-insp-note">' + esc(T('No inbound control applies: nothing arrives unsolicited from this source.')) + '</div>')

      + '<div class="sc-insp-sec">' + esc(T('Produces')) + '</div>'
      + (s.produces.length
        ? '<div class="sc-types">' + s.produces.map(function (t) {
          return '<span class="sc-type" data-no-i18n>' + esc(t) + '</span>';
        }).join('') + '</div>'
        : '<div class="sc-insp-note">' + esc(T('This source publishes no registered event type, so the platform does not record what it contributed.')) + '</div>')

      + '<div class="sc-insp-sec">' + esc(T('If this fails')) + '</div>'
      + (impact.length
        ? '<div class="sc-impacts">' + impact.map(function (i) {
          return '<div class="sc-impact sc-impact--' + i.relation.toLowerCase().replace(/_/g, '-') + '">'
            + '<span class="sc-impact-name" data-no-i18n>' + esc(i.name) + '</span>'
            + '<span class="sc-impact-rel">' + esc(grade(i.relation)) + '</span>'
            + '<span class="sc-impact-ev" data-no-i18n>' + esc(i.evidence) + '</span></div>';
        }).join('') + '</div>'
        : '<div class="sc-insp-note">' + esc(T('Nothing in the registry records a dependency on this source.')) + '</div>')

      + (s.note ? '<div class="sc-insp-sec">' + esc(T('Note')) + '</div>'
        + '<div class="sc-insp-note">' + esc(T(s.note)) + '</div>' : '')

      + '<div class="sc-insp-sec">' + esc(T('Evidence')) + '</div>'
      + '<div class="sc-insp-ev" data-no-i18n>' + esc(s.evidence) + '</div>'

      + (s.crossLinks && s.crossLinks.length
        ? '<div class="sc-insp-sec">' + esc(T('Open in')) + '</div>'
          + '<div class="sc-links">' + s.crossLinks.map(function (l) {
            return '<button class="sc-link" type="button" data-sc-goto="' + esc(l.module) + '">'
              + esc(T(l.module.replace(/_/g, ' '))) + '</button>';
          }).join('') + '</div>'
        : '')

      + '</div>'
      + '<div class="sc-insp-foot">' + esc(T('Provenance metadata only. No environment value, credential or user data is available to this panel.')) + '</div>'
      + '</aside>';
  }

  // ── the body ──────────────────────────────────────────────────────────────

  function contentHtml() {
    if (SC.error && !SC.registry) {
      return panel('', emptyState('Source Core could not be read', SC.error));
    }
    if (!SC.registry) return skeleton(8);
    if (SC.registry.state === 'NOT_GENERATED') {
      return panel('', emptyState('The source registry has not been generated',
        SC.registry.reason) + '<div class="sc-notice"><code data-no-i18n>npm run infra:discover</code></div>');
    }

    switch (SC.section) {
      case 'flow': return flowHtml();
      case 'internal':
        return listSection(function (s) {
          return s.internalOrExternal === 'INTERNAL' && s.sourceType !== 'UNREGISTERED_INTAKE'
            && s.sourceType !== 'FUTURE';
        }, 'Internal sources', T('Registered platform domains and the components behind them.'));
      case 'external':
        return listSection(function (s) {
          return s.internalOrExternal === 'EXTERNAL' && s.sourceType !== 'TECHNOLOGY';
        }, 'External sources & providers', T('Reached over a network. A provider with no credentials configured says so.'));
      case 'technology':
        return listSection(function (s) { return s.sourceType === 'TECHNOLOGY'; },
          'Technology origins', T('Declared in package.json and pinned by the lockfile.'));
      case 'intake':
        return listSection(function (s) { return s.sourceType === 'UNREGISTERED_INTAKE'; },
          'Unregistered intake',
          T('Mounted routes that accept writes and own no registered event prefix.'));
      case 'future':
        return listSection(function (s) { return s.sourceType === 'FUTURE'; },
          'Future sources', T('Named by the repository, not built. Nothing is simulated.'));
      case 'lineage': return lineageHtml();
      case 'evidence': return evidenceHtml();
      default: return flowHtml();
    }
  }

  function evidenceHtml() {
    var r = SC.registry;
    var at = fmtInstant(r.generatedAt);
    return panel('Where this comes from',
      '<div class="sc-kv">'
      + kv(T('Composed from'), T('The Data Fabric source registry, the infrastructure manifest and the live health signals.'))
      + kv(T('Manifest generated'), at ? at.utc : '—')
      + kv(T('Sources total'), num(r.counts.total))
      + kv(T('Internal'), num(r.counts.internal))
      + kv(T('External'), num(r.counts.external))
      + kv(T('Not instrumented'), num(r.counts.notInstrumented))
      + kv(T('Unregistered intake'), num(r.counts.unregisteredIntake))
      + kv(T('Future'), num(r.counts.future))
      + '</div>',
      T('Source Core discovers nothing of its own. It composes registries that already exist.'));
  }

  function kv(k, v) {
    return '<div class="sc-kv-row"><span>' + esc(k) + '</span><b data-no-i18n>' + esc(v) + '</b></div>';
  }

  // ── loading ───────────────────────────────────────────────────────────────

  function apiBase() {
    return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE)
      ? window.FAM_CONFIG.API_BASE : '/api/v1';
  }
  function token() {
    try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; }
    catch (_) { return ''; }
  }
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
      credentials: 'include',
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (b) { return (b && b.data) || b; });
  }

  /**
   * The fields this screen cannot draw without.
   *
   * The same last line Infrastructure City keeps: if a payload reaches a
   * browser without them the module SAYS SO rather than drawing itself empty.
   * Absence only — a present-but-empty array is a real answer about a real
   * platform and is never reported as a fault.
   */
  var REQUIRED = { registry: ['sources', 'counts'], flow: ['origins', 'consumers', 'counts'] };

  function missingFields(payload, required) {
    var missing = [];
    for (var i = 0; i < required.length; i++) {
      var k = required[i];
      if (!payload || payload[k] === undefined || payload[k] === null) missing.push(k);
    }
    return missing;
  }
  function contractError(endpoint, missing) {
    return T('CONTRACT ERROR') + ' · ' + endpoint + ' · '
      + T('the response did not carry:') + ' ' + missing.join(', ');
  }

  function loadRegistry() {
    return api('/system/sources').then(function (d) {
      if (d && d.state === 'NOT_GENERATED') { SC.registry = d; SC.error = null; return; }
      var missing = missingFields(d, REQUIRED.registry);
      if (missing.length) { SC.registry = null; SC.error = contractError('/system/sources', missing); return; }
      SC.registry = d; SC.error = null;
    }).catch(function (e) { SC.error = e.message; });
  }
  function loadFlow() {
    return api('/system/sources/flow').then(function (d) {
      if (d && d.state === 'NOT_GENERATED') { SC.flow = null; return; }
      var missing = missingFields(d, REQUIRED.flow);
      if (missing.length) { SC.flow = null; SC.error = contractError('/system/sources/flow', missing); return; }
      SC.flow = d;
    }).catch(function () {});
  }
  function loadHealth() {
    return api('/system/sources/health').then(function (d) { SC.health = d; }).catch(function () {});
  }
  function loadSource(id) {
    return Promise.all([
      api('/system/sources/' + encodeURIComponent(id) + '/consumers').catch(function () { return null; }),
    ]).then(function (r) { SC.consumers = r[0]; });
  }
  function loadLineage(id) {
    return api('/system/sources/' + encodeURIComponent(id) + '/lineage')
      .then(function (d) { SC.lineage = d; }).catch(function () { SC.lineage = null; });
  }

  // ── paint ─────────────────────────────────────────────────────────────────

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', SC_DIR);
    host.setAttribute('lang', SC_LANG);
    host.innerHTML = '<div class="sc-shell">'
      + railHtml()
      + '<main class="sc-main">' + topHtml()
      + '<div class="sc-body" id="sc-body">' + contentHtml() + '</div></main>'
      + '</div>' + inspectorHtml();
    try { scTranslate(host); } catch (_) {}
  }

  function repaintBody(host) {
    var body = host.querySelector('#sc-body');
    if (!body) return paint(host);
    body.innerHTML = contentHtml();
    try { scTranslate(body); } catch (_) {}
    var old = host.querySelector('.sc-insp');
    var scrim = host.querySelector('.sc-insp-scrim');
    if (old) old.remove();
    if (scrim) scrim.remove();
    if (SC.inspect) {
      host.insertAdjacentHTML('beforeend', inspectorHtml());
      try { scTranslate(host.querySelector('.sc-insp')); } catch (_) {}
    }
    var foot = host.querySelector('.sc-rail-foot');
    if (foot) { foot.innerHTML = originChipHtml(); try { scTranslate(foot); } catch (_) {} }
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__scBound) return;
    host.__scBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;

      if (t.closest('[data-sc-home]')) { try { window.navTo('owner-home'); } catch (_) {} return; }

      var nav = t.closest('[data-sc-nav]');
      if (nav) { SC.section = nav.getAttribute('data-sc-nav'); SC.inspect = null; paint(host); return; }

      if (t.closest('[data-sc-langs]')) { SC.langOpen = !SC.langOpen; paint(host); return; }
      var lang = t.closest('[data-sc-lang]');
      if (lang) {
        SC.langOpen = false;
        setLocale(lang.getAttribute('data-sc-lang')).then(function () { paint(host); });
        return;
      }

      var consumer = t.closest('[data-sc-consumer]');
      if (consumer) {
        var m = consumer.getAttribute('data-sc-consumer');
        SC.focusConsumer = SC.focusConsumer === m ? null : m;
        repaintBody(host);
        return;
      }

      var src = t.closest('[data-sc-source]');
      if (src) {
        var id = src.getAttribute('data-sc-source');
        if (SC.section === 'lineage') {
          SC.focusSource = id;
          loadLineage(id).then(function () { repaintBody(host); });
          return;
        }
        SC.inspect = id; SC.consumers = null;
        repaintBody(host);
        loadSource(id).then(function () { repaintBody(host); });
        return;
      }

      if (t.closest('[data-sc-close-insp]')) { SC.inspect = null; SC.consumers = null; repaintBody(host); return; }
      if (t.closest('[data-sc-clear]')) { SC.query = ''; repaintBody(host); return; }

      var goto = t.closest('[data-sc-goto]');
      if (goto) {
        var mod = goto.getAttribute('data-sc-goto');
        var page = mod === 'DATA_VAULT' ? 'data-vault'
          : mod === 'INFRASTRUCTURE_CITY' ? 'infrastructure-city'
            : mod === 'SYSTEM' ? 'system' : 'clubs-picker';
        try { window.navTo(page); } catch (_) {}
        return;
      }
    });

    host.addEventListener('input', function (ev) {
      var s = ev.target.closest('[data-sc-search]');
      if (!s) return;
      SC.query = s.value;
      // Repaint the list only, and put the caret back where the reader left it.
      var at = s.selectionStart;
      repaintBody(host);
      var again = host.querySelector('[data-sc-search]');
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (_) {} }
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && SC.inspect) { SC.inspect = null; repaintBody(host); }
    });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaSourceCore = function (host) {
    // The page-render registry calls every renderer with NO argument, and the
    // navigation switch calls this one with the root element. Both have to
    // work, or the page mounts and stays empty — which is exactly what it did
    // the first time a browser opened it.
    host = host || document.getElementById('sc-root');
    if (!host) return;
    bind(host);
    setLocale(initialLocale()).then(function () {
      paint(host);
      return Promise.all([loadRegistry(), loadFlow(), loadHealth()]);
    }).then(function () { paint(host); });
  };

  window.teardownFamilistaSourceCore = function () { /* no stream of its own to close */ };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaSourceCoreStateKind = stateKind;
}());
