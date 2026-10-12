/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — Stage 3.1

   WHAT THE DESIGN SYSTEM DECLARES, AND WHAT THE REPOSITORY RECORDS ABOUT IT

   An Owner-only room, loaded on demand by public/app.js the first time the
   platform owner opens it. It draws four sections — Overview, Design Tokens,
   the Visual Explorer (Stage 3.2.1) and the Components Library (Stage 3.2.2).
   The last two bring their own script and stylesheet, which load only when that
   section first opens (public/design-system/explorer.*, components.*) —
   from a manifest the server generated from tools/tokens/ (the Design Core, the
   one canonical token source) and serves read-only at /system/design-system.

   READ-ONLY

   There is no button here that changes a token, a stylesheet or a theme, and
   there must never be one: the design system changes by a reviewed change to
   tools/tokens/, approved in the pull request that carries it and released by
   the CI-gated deploy.

   HONESTY

   Every figure carries how it is known. MEASURED: counted or computed from the
   repository files by the generator. RECORDED: a person's classification
   committed to the repository (the legacy map's verdicts, the contrast
   baseline). Not recorded: the platform does not keep it, drawn as "—" with
   the reason, never as 0. A measured zero is drawn as 0.

   This room paints with the canonical --fam-* tokens (public/tokens/
   familista-tokens.css) and declares no token of its own.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var DS = {
    section: 'overview',   // overview | tokens | explorer | components
    tab: 'tokens',         // tokens | layers | contrast  (inside Design Tokens)
    data: null,            // GET /system/design-system
    error: null,
    tk: null,              // GET /system/design-system/tokens
    tkError: null,
    tkLoading: false,
    q: '',
    layer: 'all',
    type: 'all',
    cfilter: 'all',        // all | failing | text | ui
    langOpen: false,
    refreshing: false,
    assets: {},            // section → Promise<boolean>: a lazy section's script and stylesheet, loaded once
    mounted: null,         // the lazy section currently drawn, or null
  };

  // ── localisation ──────────────────────────────────────────────────────────
  //
  // This room's own three-language catalogue, behind `data-no-i18n` on the page
  // root — the boundary every owner room keeps, so these strings never enter the
  // club product's locale files. Token names, values, paths, hashes and enum
  // tokens are identifiers and are never translated.

  var DS_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var DS_DICT = {};
  var DS_LANG = 'en';
  var DS_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < DS_LOCALES.length; i++) if (DS_LOCALES[i][0] === tag) return DS_LOCALES[i];
    return DS_LOCALES[0];
  }
  function initialLocale() {
    try {
      var v = localStorage.getItem('familista_design_system_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { DS_DICT = {}; return Promise.resolve(); }
    return fetch('/design-system/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { DS_DICT = d || {}; })
      .catch(function () { DS_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    DS_LANG = l[0]; DS_DIR = l[2];
    try { localStorage.setItem('familista_design_system_locale', DS_LANG); } catch (_) {}
    return loadDict(DS_LANG);
  }

  /** Every key asked for, so the test suite can prove the catalogues cover what the screen really says. */
  var DS_SEEN = {};

  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s) return s;
    DS_SEEN[s] = 1;
    if (DS_LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(DS_DICT, s) ? DS_DICT[s] : s;
  }
  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var i = 0;
    return T(key).replace(/%d/g, function () { var v = args[i++]; return v == null ? '—' : num(v); });
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** A count, localised — or an em dash. `0` is an answer; absence is not. */
  function num(n, digits) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(DS_LANG, digits == null ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch (_) { return String(n); }
  }
  /** A figure with a unit, isolated left-to-right so it reads the same inside an Arabic sentence. */
  function ltr(text) { return '<bdi dir="ltr">' + esc(text) + '</bdi>'; }
  function kb(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return ltr(num(n / 1024, 1) + ' KB');
  }
  function has(v) { return v !== null && v !== undefined; }
  function code(v) { return '<code data-no-i18n>' + esc(v) + '</code>'; }
  function short(hash) { return hash ? String(hash).slice(0, 12) : '—'; }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // The only place a state becomes a colour. Green and red are results and
  // availability states and nothing else; how a figure is known is never green.
  //   MEASURED     counted or computed from the repository files — info blue
  //   RECORDED     a person's classification, committed — unverified violet
  //   Not recorded the platform does not keep it — dotted grey, drawn as "—"

  var EV_LABEL = { MEASURED: 'Measured', RECORDED: 'Recorded', NONE: 'Not recorded' };
  var EV_MEANING = {
    MEASURED: 'Counted or computed from the repository files by the generator.',
    RECORDED: 'A person’s classification, committed to the repository.',
    NONE: 'The platform does not keep this. It is drawn as “—”, never as 0.',
  };
  var EV_KIND = { MEASURED: 'info', RECORDED: 'rec', NONE: 'none' };

  function chip(kind, label, title, extra) {
    return '<span class="ds-chip ds-chip--' + kind + (extra ? ' ' + extra : '') + '"'
      + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<span class="ds-dot" aria-hidden="true"></span>' + esc(label) + '</span>';
  }
  function evChip(state) {
    var s = EV_LABEL[state] ? state : 'NONE';
    return chip(EV_KIND[s], T(EV_LABEL[s]), T(EV_MEANING[s]), 'ds-chip--sm');
  }

  var LAYER_ORDER = ['ref', 'semantic', 'context', 'module', 'theme', 'lang', 'dir', 'media'];
  var LAYER_LABEL = {
    ref: 'Reference', semantic: 'Semantic', context: 'Context', module: 'Module',
    theme: 'Theme', lang: 'Language', dir: 'Direction', media: 'Media',
  };
  var LAYER_MEANING = {
    ref: 'Raw values, named by family and step.',
    semantic: 'Meaning. The defaults are the live Club values.',
    context: 'The Owner context re-declares the semantic layer.',
    module: 'The identity accent of each module.',
    theme: 'Light and high-contrast. Reserved, empty.',
    lang: 'Arabic: every tracking step is 0.',
    dir: 'Right-to-left: the direction multiplier is −1.',
    media: 'Reduced motion: every duration is 0 ms.',
  };
  var STATUS_LABEL = {
    equal: 'Equal to a token', diverges: 'Diverges from its token', 'separate-surface': 'Separate surface',
    'dead-overridden': 'Dead, overridden', 'component-param': 'Component parameter', 'light-theme': 'Light theme',
    'dead-redeclared': 'Dead, redeclared', 'no-canonical-role': 'No canonical role',
  };
  var ROLE_LABEL = { text: 'Text', ui: 'Interface', exempt: 'Exempt' };
  var TYPE_LABEL = {
    color: 'Colour', dimension: 'Dimension', duration: 'Duration', cubicBezier: 'Easing', fontFamily: 'Font family',
    fontWeight: 'Font weight', number: 'Number', shadow: 'Shadow', gradient: 'Gradient',
  };
  var CTX_LABEL = { club: 'Club', owner: 'Owner' };
  var UNAVAILABLE_LABEL = {
    'component-adoption': 'Component and token adoption',
    'test-results': 'Test and Storybook results',
    'runtime-accessibility': 'Runtime accessibility audits',
    'usage-telemetry': 'Design-system usage telemetry',
  };
  var UNAVAILABLE_WHY = {
    'component-adoption': 'No record of which production screens use which shared component or token is kept; production reads no --fam-* token yet.',
    'test-results': 'Test and Storybook results are produced by CI per run and are not stored in the repository.',
    'runtime-accessibility': 'Runtime accessibility audits are not recorded; only token-pair contrast is computed here.',
    'usage-telemetry': 'No design-system usage telemetry exists.',
  };

  // ── pieces ────────────────────────────────────────────────────────────────

  function panel(title, body, note, extra) {
    return '<section class="ds-panel' + (extra ? ' ' + extra : '') + '">'
      + (title ? '<div class="ds-panel-head"><h2 class="ds-panel-title">' + esc(T(title)) + '</h2>'
        + (note ? '<span class="ds-panel-note">' + note + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }
  function kv(label, value) {
    return '<div class="ds-kv"><div class="ds-kv-k">' + esc(T(label)) + '</div><div class="ds-kv-v">' + value + '</div></div>';
  }
  function emptyState(title, why, extra) {
    return '<div class="ds-empty" role="status"><div class="ds-empty-mark" aria-hidden="true">—</div>'
      + '<div class="ds-empty-title">' + esc(T(title)) + '</div>'
      + (why ? '<div class="ds-empty-why">' + esc(why) + '</div>' : '') + (extra || '') + '</div>';
  }
  function sourceOf(id) {
    var list = (DS.data && DS.data.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function metric(label, value, ev, srcId, sub) {
    var s = sourceOf(srcId);
    return '<div class="ds-metric">'
      + '<div class="ds-metric-label">' + esc(T(label)) + '</div>'
      + '<div class="ds-metric-value">' + esc(value) + '</div>'
      + '<div class="ds-metric-sub">' + (sub || '&nbsp;') + '</div>'
      + '<div class="ds-metric-foot">' + evChip(ev) + '<span class="ds-metric-src">' + (s ? code(s.path) : '—') + '</span></div></div>';
  }
  /** A horizontal bar. Width is painted from data-ds-w through the CSSOM (the page's CSP forbids style="…"). */
  function bars(rows, total) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    return '<ul class="ds-bars">' + rows.map(function (r) {
      var pct = Math.round((r.value / max) * 1000) / 10;
      return '<li class="ds-bar"><div class="ds-bar-l"><span class="ds-bar-name">' + esc(r.label) + '</span>'
        + '<span class="ds-bar-n">' + ltr(num(r.value) + (total ? ' / ' + num(total) : '')) + '</span></div>'
        + (r.hint ? '<div class="ds-bar-hint">' + esc(r.hint) + '</div>' : '')
        + '<div class="ds-bar-track" aria-hidden="true"><div class="ds-bar-fill" data-ds-paint="w" data-ds-v="' + pct + '%"></div></div></li>';
    }).join('') + '</ul>';
  }
  function skeleton(n, cls) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="ds-skel-row ds-skel-row--' + cls + '" aria-hidden="true"></div>';
    return '<div class="ds-skel" role="status" aria-label="' + esc(T('Reading the manifest…')) + '">' + out + '</div>';
  }

  // ── shell ─────────────────────────────────────────────────────────────────

  function languageSwitchHtml() {
    var active = localeOf(DS_LANG);
    return '<div class="ds-langs' + (DS.langOpen ? ' is-open' : '') + '">'
      + '<button class="ds-lang-pick" type="button" data-ds-langs'
      + ' aria-haspopup="true" aria-expanded="' + (DS.langOpen ? 'true' : 'false') + '" aria-label="' + esc(active[1] + ' · ' + T('Design System language')) + '">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="ds-lang-ch" aria-hidden="true">⌄</span></button>'
      + '<div class="ds-lang-menu" role="group" aria-label="' + esc(T('Design System language')) + '">'
      + DS_LOCALES.map(function (l) {
        return '<button class="ds-lang' + (l[0] === DS_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-ds-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === DS_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  var SECTIONS = [['overview', 'Overview'], ['tokens', 'Design Tokens'], ['explorer', 'Visual Explorer'], ['components', 'Components'], ['lab', 'Specimen Lab']];
  var SECTION_TITLE = { overview: 'Overview', tokens: 'Design Tokens', explorer: 'Visual Explorer', components: 'Components', lab: 'Specimen Lab' };

  function railHtml() {
    var total = DS.data && DS.data.overview ? DS.data.overview.tokens.total : null;
    var commit = DS.data && DS.data.build ? DS.data.build.commit : null;
    return '<aside class="ds-rail"><div class="ds-rail-head">'
      + '<button class="ds-rail-home" type="button" data-ds-home><span aria-hidden="true">←</span> ' + esc(T('Owner Control')) + '</button>'
      + '<div class="ds-rail-brand"><span class="ds-rail-mark" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
      + '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/></svg></span>'
      + '<span class="ds-rail-title">' + esc(T('Design System')) + '</span></div></div>'
      + '<nav class="ds-rail-body" aria-label="' + esc(T('Design System sections')) + '"><div class="ds-rail-group">'
      + '<div class="ds-rail-label">' + esc(T('Sections')) + '</div>'
      + SECTIONS.map(function (s) {
        var on = DS.section === s[0];
        return '<button class="ds-rail-item' + (on ? ' is-on' : '') + '" type="button" data-ds-nav="' + s[0] + '"'
          + (on ? ' aria-current="page"' : '') + '><span class="ds-rail-text">' + esc(T(s[1])) + '</span>'
          + (s[0] === 'tokens' && has(total && total.value) ? '<span class="ds-rail-badge">' + esc(num(total.value)) + '</span>' : '')
          + '</button>';
      }).join('')
      + '</div></nav><div class="ds-rail-foot"><div class="ds-foot">'
      + chip('info', T('Platform Owner only'), '', 'ds-chip--sm')
      + '<span class="ds-foot-at" title="' + esc(T('The commit this server was built from')) + '">' + (commit ? code(commit.slice(0, 7)) : '—') + '</span>'
      + '</div></div></aside>';
  }

  function topHtml() {
    var title = SECTION_TITLE[DS.section] || 'Overview';
    return '<header class="ds-top"><div class="ds-top-l">'
      + '<div class="ds-top-eyebrow">' + esc(T('DESIGN SYSTEM CONTROL')) + '</div>'
      + '<h1 class="ds-top-title">' + esc(T(title)) + '</h1></div>'
      + '<div class="ds-top-r">' + chip('info', T('Read-only'), T('Nothing in this room changes the design system.'), 'ds-chip--sm')
      + languageSwitchHtml()
      + '<button class="ds-btn" type="button" data-ds-refresh' + (DS.refreshing ? ' disabled aria-busy="true"' : '') + '>'
      + esc(T(DS.refreshing ? 'Reading…' : 'Refresh')) + '</button></div></header>';
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  function overviewHtml() {
    var d = DS.data;
    var o = d.overview;
    var intro = '<p class="ds-intro">' + esc(T('The Design Core in tools/tokens is the only canonical source of Familista’s design values. This room shows what it declares and what the repository records about it. It reads a manifest generated from those files and changes nothing.')) + '</p>';

    var contrastNew = o.contrast.newFailures.value;
    var strip = '<div class="ds-strip">'
      + metric('Design tokens', num(o.tokens.total.value), o.tokens.total.state, 'tokens', esc(tf('%d layers', LAYER_ORDER.length)))
      + metric('CSS custom properties', num(o.css.declarations.value), o.css.declarations.state, 'token-css', kb(o.css.bytes.value))
      + metric('Production declarations mapped', num(o.legacyMap.declarations.value), o.legacyMap.declarations.state, 'legacy-map', esc(tf('%d names used but never declared', o.legacyMap.undefinedNames.value.css + o.legacyMap.undefinedNames.value.appJs)))
      + metric('Contrast pairs checked', num(o.contrast.pairs.value), o.contrast.pairs.state, 'tokens', esc(tf('%d recorded failures', o.contrast.baselineFailures.value)))
      + '</div>';

    var layers = LAYER_ORDER.map(function (l) {
      var v = o.tokens.byLayer.value[l];
      return { label: T(LAYER_LABEL[l]), hint: T(LAYER_MEANING[l]), value: typeof v === 'number' ? v : 0 };
    });
    var layersPanel = panel('Token layers', bars(layers, o.tokens.total.value)
      + '<div class="ds-note">' + evChip(o.tokens.byLayer.state) + ' ' + esc(T('A layer with no tokens is a measured 0.')) + '</div>',
      tf('%d contexts · %d modules', o.contexts.value, o.modules.value));

    var statusRows = Object.keys(o.legacyMap.byStatus.value).sort(function (a, b) {
      return o.legacyMap.byStatus.value[b] - o.legacyMap.byStatus.value[a] || (a < b ? -1 : 1);
    }).map(function (k) { return { label: T(STATUS_LABEL[k] || k), value: o.legacyMap.byStatus.value[k] }; });
    var legacyPanel = panel('Production custom properties', bars(statusRows, o.legacyMap.declarations.value)
      + '<div class="ds-note">' + evChip(o.legacyMap.byStatus.state) + ' '
      + esc(T('Each verdict was assigned by a person and is checked against the tokens by the test suite. Production reads no --fam-* token yet.')) + '</div>');

    var th = o.contrast.thresholds.value;
    var roleRows = Object.keys(o.contrast.byRole.value).sort().map(function (k) {
      return { label: T(ROLE_LABEL[k] || k), value: o.contrast.byRole.value[k] };
    });
    var contrastPanel = panel('Contrast', '<div class="ds-kv-list">'
      + kv('Pairs below their threshold', num(o.contrast.failing.value) + ' ' + evChip(o.contrast.failing.state))
      + kv('Recorded at Stage 2a', num(o.contrast.baselineFailures.value) + ' ' + evChip(o.contrast.baselineFailures.state))
      + kv('Failures beyond that record', chip(contrastNew === 0 ? 'ok' : 'crit', contrastNew === 0 ? T('None') : tf('%d new', contrastNew), '', 'ds-chip--sm') + ' ' + evChip(o.contrast.newFailures.state))
      + kv('Thresholds (WCAG 2.2)', esc(tf('Text %d : 1 · Interface %d : 1', th.text, th.ui)) + ' ' + evChip(o.contrast.thresholds.state))
      + '</div>' + bars(roleRows, o.contrast.pairs.value)
      + '<div class="ds-note">' + esc(T('Computed from the token values. Known failures keep their live production values; fixing one is a visual change that needs approval.')) + '</div>');

    var cssPanel = panel('Published token CSS', '<div class="ds-kv-list">'
      + kv('Prefix', code('--' + o.css.prefix + '-*'))
      + kv('Version', code(o.css.version))
      + kv('Custom properties declared', esc(num(o.css.declarations.value)) + ' ' + evChip(o.css.declarations.state))
      + kv('Size', kb(o.css.bytes.value) + ' ' + evChip(o.css.bytes.state))
      + kv('Published copy', chip(o.css.publishedIdentical.value ? 'ok' : 'crit',
        T(o.css.publishedIdentical.value ? 'Identical to the build output' : 'Differs from the build output'), '', 'ds-chip--sm') + ' ' + evChip(o.css.publishedIdentical.state))
      + '</div>');

    var sb = o.storybook;
    var sbPanel = panel('Storybook', '<div class="ds-kv-list">'
      + kv('Story files', esc(num(sb.storyFiles.value)) + ' ' + evChip(sb.storyFiles.state))
      + kv('Of which Foundations', esc(num(sb.foundationFiles.value)) + ' ' + evChip(sb.foundationFiles.state))
      + '</div><div class="ds-note">' + esc(T('Files are counted, not stories: one file can hold several.')) + '</div>');

    var notRec = panel('Not recorded', '<ul class="ds-unavail">' + o.unavailable.map(function (u) {
      return '<li class="ds-unavail-i"><div class="ds-unavail-h"><span class="ds-unavail-v" aria-label="' + esc(T('Not recorded')) + '">—</span>'
        + '<span class="ds-unavail-t">' + esc(T(UNAVAILABLE_LABEL[u.id] || u.id)) + '</span>' + evChip('NONE') + '</div>'
        + '<div class="ds-unavail-why">' + esc(T(UNAVAILABLE_WHY[u.id] || u.reason)) + '</div></li>';
    }).join('') + '</ul>');

    var prov = panel('Provenance', '<div class="ds-tablewrap" tabindex="0" role="region" aria-label="' + esc(T('The files this manifest was generated from')) + '"><table class="ds-table ds-table--prov">'
      + '<caption class="ds-sr">' + esc(T('The files this manifest was generated from')) + '</caption>'
      + '<thead><tr><th scope="col">' + esc(T('File')) + '</th><th scope="col">' + esc(T('What it is')) + '</th>'
      + '<th scope="col">SHA-256</th><th scope="col" class="ds-num">' + esc(T('Size')) + '</th></tr></thead><tbody>'
      + d.sources.map(function (s) {
        return '<tr><td>' + code(s.path) + '</td><td data-l="' + esc(T('What it is')) + '">' + esc(T(s.label)) + '</td>'
          + '<td data-l="SHA-256"><span class="ds-fp" title="' + esc(s.sha256) + '">' + code(short(s.sha256)) + '</span></td>'
          + '<td class="ds-num" data-l="' + esc(T('Size')) + '">' + kb(s.bytes) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="ds-note">' + esc(T('Generated by')) + ' ' + code(d.generator || '—') + ' · ' + esc(T('Deterministic: the same files always produce the same manifest.')) + '</div>',
      null);

    return intro + strip
      + '<div class="ds-grid">' + layersPanel + legacyPanel + '</div>'
      + '<div class="ds-grid ds-grid--3">' + contrastPanel + cssPanel + sbPanel + '</div>'
      + notRec + prov;
  }

  // ── Design Tokens ─────────────────────────────────────────────────────────

  function tabsHtml() {
    var tabs = [['tokens', 'Tokens'], ['layers', 'Layers'], ['contrast', 'Contrast']];
    return '<div class="ds-tabs" role="tablist" aria-label="' + esc(T('Design Tokens views')) + '">'
      + tabs.map(function (t) {
        var on = DS.tab === t[0];
        return '<button class="ds-tab' + (on ? ' is-on' : '') + '" type="button" role="tab" id="ds-tab-' + t[0] + '"'
          + ' aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="ds-tabpanel" tabindex="' + (on ? '0' : '-1') + '"'
          + ' data-ds-tab="' + t[0] + '">' + esc(T(t[1])) + '</button>';
      }).join('') + '</div>';
  }

  function swatchKind(t) {
    switch (t.type) {
      case 'color': return ['bg', t.resolved];
      case 'gradient': return ['img', t.resolved];
      case 'shadow': return ['shadow', t.resolved];
      case 'fontFamily': return ['ff', t.resolved];
      case 'fontWeight': return ['fw', t.resolved];
      case 'dimension': {
        var m = /^(-?[\d.]+)px$/.exec(t.resolved);
        return m ? ['w', Math.max(0, Math.min(64, parseFloat(m[1]))) + 'px'] : null;
      }
      default: return null;
    }
  }
  function swatchHtml(t) {
    var k = swatchKind(t);
    if (!k) return '<span class="ds-sw ds-sw--none" aria-hidden="true"></span>';
    if (k[0] === 'ff' || k[0] === 'fw') return '<span class="ds-sw ds-sw--text" aria-hidden="true" data-ds-paint="' + k[0] + '" data-ds-v="' + esc(k[1]) + '">Aa</span>';
    return '<span class="ds-sw ds-sw--' + k[0] + '" aria-hidden="true"><span class="ds-sw-i" data-ds-paint="' + k[0] + '" data-ds-v="' + esc(k[1]) + '"></span></span>';
  }

  function filteredTokens() {
    var q = DS.q.trim().toLowerCase();
    return DS.tk.tokens.filter(function (t) {
      if (DS.layer !== 'all' && t.layer !== DS.layer) return false;
      if (DS.type !== 'all' && t.type !== DS.type) return false;
      if (!q) return true;
      return (t.cssName + ' ' + t.path + ' ' + t.resolved + ' ' + (t.source || '') + ' ' + (t.description || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  function tokenRowsHtml(list) {
    if (!list.length) {
      return '<tr class="ds-tr-empty"><td colspan="6">' + emptyState('No token matches', T('Clear the search or choose another layer or type.')) + '</td></tr>';
    }
    return list.map(function (t) {
      var alias = t.aliasOf !== null && t.declared !== t.resolved;
      return '<tr><td class="ds-c-sw">' + swatchHtml(t) + '</td>'
        + '<td class="ds-c-name">' + code(t.cssName) + '<div class="ds-sub">' + code(t.path) + '</div></td>'
        + '<td class="ds-c-layer" data-l="' + esc(T('Layer')) + '"><span class="ds-tag">' + esc(T(LAYER_LABEL[t.layer] || t.layer)) + '</span></td>'
        + '<td class="ds-c-type" data-l="' + esc(T('Type')) + '">' + esc(T(TYPE_LABEL[t.type] || t.type)) + '</td>'
        + '<td class="ds-c-val" data-l="' + esc(T('Value')) + '">' + code(t.resolved) + (alias ? '<div class="ds-sub">' + esc(T('alias')) + ' ' + code(t.declared) + '</div>' : '') + '</td>'
        + '<td class="ds-c-src" data-l="' + esc(T('Production variable')) + '">' + (t.source ? code(t.source) : '<span class="ds-none" title="' + esc(T('No production variable is recorded for this token.')) + '">—</span>') + '</td></tr>';
    }).join('');
  }

  function tokensTabHtml() {
    var layers = LAYER_ORDER.filter(function (l) { return DS.tk.tokens.some(function (t) { return t.layer === l; }); });
    var types = []; DS.tk.tokens.forEach(function (t) { if (types.indexOf(t.type) < 0) types.push(t.type); });
    types.sort();
    var list = filteredTokens();
    return '<div class="ds-toolbar">'
      + '<label class="ds-field ds-field--q"><span class="ds-field-l">' + esc(T('Search tokens')) + '</span>'
      + '<input class="ds-input" type="search" id="ds-q" autocomplete="off" spellcheck="false" value="' + esc(DS.q) + '" placeholder="' + esc(T('Name, value or production variable')) + '"></label>'
      + '<label class="ds-field"><span class="ds-field-l">' + esc(T('Layer')) + '</span><select class="ds-input" id="ds-layer">'
      + '<option value="all">' + esc(T('All layers')) + '</option>'
      + layers.map(function (l) { return '<option value="' + l + '"' + (DS.layer === l ? ' selected' : '') + '>' + esc(T(LAYER_LABEL[l])) + '</option>'; }).join('')
      + '</select></label>'
      + '<label class="ds-field"><span class="ds-field-l">' + esc(T('Type')) + '</span><select class="ds-input" id="ds-type">'
      + '<option value="all">' + esc(T('All types')) + '</option>'
      + types.map(function (ty) { return '<option value="' + esc(ty) + '"' + (DS.type === ty ? ' selected' : '') + '>' + esc(T(TYPE_LABEL[ty] || ty)) + '</option>'; }).join('')
      + '</select></label>'
      + '<div class="ds-count" id="ds-count" role="status" aria-live="polite">' + esc(tf('Showing %d of %d tokens', list.length, DS.tk.tokens.length)) + '</div></div>'
      + '<div class="ds-tablewrap ds-tablewrap--tokens" tabindex="0" role="region" aria-label="' + esc(T('Every design token')) + '"><table class="ds-table ds-table--tokens">'
      + '<caption class="ds-sr">' + esc(T('Every design token')) + '</caption>'
      + '<thead><tr><th scope="col" class="ds-c-sw"><span class="ds-sr">' + esc(T('Preview')) + '</span></th><th scope="col">' + esc(T('Token')) + '</th>'
      + '<th scope="col">' + esc(T('Layer')) + '</th><th scope="col">' + esc(T('Type')) + '</th>'
      + '<th scope="col">' + esc(T('Value')) + '</th><th scope="col">' + esc(T('Production variable')) + '</th></tr></thead>'
      + '<tbody id="ds-rows">' + tokenRowsHtml(list) + '</tbody></table></div>'
      + '<div class="ds-note">' + evChip('MEASURED') + ' ' + esc(T('Values are read from the token file. A production variable is shown only where the token was taken from one.')) + '</div>';
  }

  function layersTabHtml() {
    var rows = DS.tk.layers.map(function (l) {
      return '<tr><td>' + code(l.layer + '.' + l.variant) + (l.isDefault ? ' <span class="ds-tag">' + esc(T('default')) + '</span>' : '')
        + (l.description ? '<div class="ds-sub">' + esc(T(l.description)) + '</div>' : '') + '</td>'
        + '<td data-l="' + esc(T('Re-declares')) + '">' + (l.base ? code(l.base) : '<span class="ds-none">—</span>') + '</td>'
        + '<td class="ds-num" data-l="' + esc(T('Tokens')) + '">' + esc(num(l.tokenCount)) + '</td>'
        + '<td class="ds-sels" data-l="' + esc(T('Applies on')) + '">' + (l.selectors.length ? l.selectors.map(code).join(' ') : '<span class="ds-none">—</span>') + '</td>'
        + '<td data-l="' + esc(T('Condition')) + '">' + (l.media ? code(l.media) : '<span class="ds-none">—</span>') + '</td></tr>';
    }).join('');
    return '<div class="ds-tablewrap" tabindex="0" role="region" aria-label="' + esc(T('Override layers and where each applies')) + '"><table class="ds-table ds-table--layers">'
      + '<caption class="ds-sr">' + esc(T('Override layers and where each applies')) + '</caption>'
      + '<thead><tr><th scope="col">' + esc(T('Layer')) + '</th><th scope="col">' + esc(T('Re-declares')) + '</th>'
      + '<th scope="col" class="ds-num">' + esc(T('Tokens')) + '</th><th scope="col">' + esc(T('Applies on')) + '</th>'
      + '<th scope="col">' + esc(T('Condition')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="ds-note">' + evChip('MEASURED') + ' ' + esc(T('An override layer takes the name of the base token it re-declares, and applies on the selectors listed.')) + '</div>';
  }

  function contrastResult(p) {
    if (p.role === 'exempt') return chip('none', T('Exempt'), T('Recorded, not enforced (disabled text).'), 'ds-chip--sm');
    if (p.pass) return chip('ok', T('Pass'), '', 'ds-chip--sm');
    return p.baseline
      ? chip('warn', T('Known failure'), T('Recorded at Stage 2a; the live value is preserved.'), 'ds-chip--sm')
      : chip('crit', T('New failure'), '', 'ds-chip--sm');
  }
  function contrastList() {
    return DS.tk.contrast.filter(function (p) {
      switch (DS.cfilter) {
        case 'failing': return p.role !== 'exempt' && !p.pass;
        case 'text': return p.role === 'text';
        case 'ui': return p.role === 'ui';
        default: return true;
      }
    });
  }
  function contrastRowsHtml(list) {
    if (!list.length) return '<tr class="ds-tr-empty"><td colspan="5">' + emptyState('No pair matches', '') + '</td></tr>';
    return list.map(function (p) {
      return '<tr><td class="ds-c-name">' + code(p.fg + ' → ' + p.bg) + '<div class="ds-sub">' + esc(T(CTX_LABEL[p.context] || p.context))
        + (p.module ? ' · ' + code(p.module) : '') + '</div></td>'
        + '<td data-l="' + esc(T('Role')) + '">' + esc(T(ROLE_LABEL[p.role] || p.role)) + '</td>'
        + '<td class="ds-num" data-l="' + esc(T('Ratio')) + '">' + ltr(num(p.ratio, 2) + ' : 1') + '</td>'
        + '<td class="ds-num" data-l="' + esc(T('Required')) + '">' + ltr(num(p.required, 1) + ' : 1') + '</td>'
        + '<td data-l="' + esc(T('Result')) + '">' + contrastResult(p) + '</td></tr>';
    }).join('');
  }
  function contrastTabHtml() {
    var filters = [['all', 'All pairs'], ['failing', 'Below threshold'], ['text', 'Text'], ['ui', 'Interface']];
    var list = contrastList();
    return '<div class="ds-toolbar"><div class="ds-seg" role="group" aria-label="' + esc(T('Filter pairs')) + '">'
      + filters.map(function (f) {
        var on = DS.cfilter === f[0];
        return '<button class="ds-seg-b' + (on ? ' is-on' : '') + '" type="button" data-ds-cf="' + f[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(T(f[1])) + '</button>';
      }).join('') + '</div>'
      + '<div class="ds-count" id="ds-count" role="status" aria-live="polite">' + esc(tf('Showing %d of %d pairs', list.length, DS.tk.contrast.length)) + '</div></div>'
      + '<div class="ds-tablewrap ds-tablewrap--tokens" tabindex="0" role="region" aria-label="' + esc(T('Contrast of every foreground and background pair')) + '"><table class="ds-table ds-table--contrast">'
      + '<caption class="ds-sr">' + esc(T('Contrast of every foreground and background pair')) + '</caption>'
      + '<thead><tr><th scope="col">' + esc(T('Pair')) + '</th><th scope="col">' + esc(T('Role')) + '</th>'
      + '<th scope="col" class="ds-num">' + esc(T('Ratio')) + '</th><th scope="col" class="ds-num">' + esc(T('Required')) + '</th>'
      + '<th scope="col">' + esc(T('Result')) + '</th></tr></thead><tbody id="ds-rows">' + contrastRowsHtml(list) + '</tbody></table></div>'
      + '<div class="ds-note">' + evChip('MEASURED') + ' ' + esc(T('Ratios are computed from the token values; a translucent surface is measured over its context’s canvas.')) + '</div>';
  }

  function tokensHtml() {
    if (DS.tkError && !DS.tk) return panel('', emptyState('The tokens could not be read', DS.tkError));
    if (!DS.tk) return panel('', skeleton(8, 'row'));
    if (DS.tk.state === 'NOT_GENERATED') return panel('', notGenerated(DS.tk.reason));
    var inner = DS.tab === 'layers' ? layersTabHtml() : DS.tab === 'contrast' ? contrastTabHtml() : tokensTabHtml();
    return tabsHtml() + '<div class="ds-tabpanel" id="ds-tabpanel" role="tabpanel" aria-labelledby="ds-tab-' + DS.tab + '">' + panel('', inner) + '</div>';
  }

  function notGenerated(reason) {
    return emptyState('The design-system manifest has not been generated', reason ? T(reason) : '',
      '<div class="ds-notice">' + code('node scripts/design-system-discover.js') + '</div>');
  }

  // ── content ───────────────────────────────────────────────────────────────

  function overviewSkeleton() {
    return '<div class="ds-skel-intro" aria-hidden="true"></div><div class="ds-skel-strip" aria-hidden="true"></div>'
      + '<div class="ds-skel-grid" aria-hidden="true"></div>';
  }
  function contentHtml() {
    if (LAZY[DS.section]) return '<div class="' + LAZY[DS.section].hostClass + '" id="' + LAZY[DS.section].host + '">' + skeleton(6, 'row') + '</div>';
    if (DS.section === 'tokens') return tokensHtml();
    if (DS.error && !DS.data) return panel('', emptyState('Design System Control could not be read', DS.error));
    if (!DS.data) return overviewSkeleton();
    if (DS.data.state === 'NOT_GENERATED') return panel('', notGenerated(DS.data.reason));
    return overviewHtml();
  }

  // ── loading ───────────────────────────────────────────────────────────────

  function apiBase() {
    return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE) ? window.FAM_CONFIG.API_BASE : '/api/v1';
  }
  function token() {
    try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) { return ''; }
  }
  /** GET only. This room has no other verb to call. */
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, {
      method: 'GET',
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      credentials: 'include',
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open Design System Control.'));
      if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
      return r.json();
    }).then(function (b) { return (b && b.data) || b; });
  }

  /** The fields this screen cannot draw without. An absent field is reported, never drawn as empty. */
  var REQUIRED = {
    overview: ['state', 'build', 'sources', 'layers'],
    tokens: ['state', 'tokens', 'layers', 'contrast'],
  };
  function missingFields(payload, required) {
    return required.filter(function (k) { return !payload || payload[k] === undefined || payload[k] === null; });
  }
  function contractError(endpoint, missing) {
    return T('CONTRACT ERROR') + ' · ' + endpoint + ' · ' + T('the response did not carry:') + ' ' + missing.join(', ');
  }

  function loadOverview() {
    return api('/system/design-system').then(function (d) {
      var missing = missingFields(d, REQUIRED.overview);
      if (!missing.length && d.state === 'READY' && !d.overview) missing = ['overview'];
      if (missing.length) { DS.data = null; DS.error = contractError('/system/design-system', missing); return; }
      DS.data = d; DS.error = null;
    }).catch(function (e) { DS.data = null; DS.error = e.message; });
  }
  function loadTokens() {
    DS.tkLoading = true;
    return api('/system/design-system/tokens').then(function (d) {
      var missing = missingFields(d, REQUIRED.tokens);
      if (missing.length) { DS.tk = null; DS.tkError = contractError('/system/design-system/tokens', missing); return; }
      DS.tk = d; DS.tkError = null;
    }).catch(function (e) { DS.tk = null; DS.tkError = e.message; })
      .then(function () { DS.tkLoading = false; });
  }

  // ── paint ─────────────────────────────────────────────────────────────────

  /**
   * Swatches, bars and font samples take their value from the CSSOM, never a
   * style="…" attribute: the page's Content-Security-Policy has no
   * 'unsafe-inline' for styles. Longhand properties only, with literal values.
   */
  function paintValues(scope) {
    var els = scope.querySelectorAll('[data-ds-paint]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], v = el.getAttribute('data-ds-v');
      var map = { bg: 'background-color', img: 'background-image', shadow: 'box-shadow', w: 'width', ff: 'font-family', fw: 'font-weight' };
      var prop = map[el.getAttribute('data-ds-paint')];
      if (prop && v) el.style.setProperty(prop, v);
    }
  }

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', DS_DIR);
    host.setAttribute('lang', DS_LANG);
    DS.mounted = null;
    host.innerHTML = '<div class="ds-shell">' + railHtml()
      + '<main class="ds-main">' + topHtml() + '<div class="ds-body' + (LAZY[DS.section] ? ' ds-body--workspace' : '') + '" id="ds-body" tabindex="0" role="region" aria-label="' + esc(T(SECTION_TITLE[DS.section] || 'Overview')) + '">' + contentHtml() + '</div></main></div>';
    paintValues(host);
    mountLazy(host);
  }

  // ── the lazy sections: Visual Explorer (3.2.1), Components Library (3.2.2) ──
  //
  // Each brings its own script and stylesheet, fetched the first time its section
  // opens and never before: Owner Home, the room's other sections and Familista's
  // startup do not pay for them. Each draws into a host element, and each
  // exposes mount / unmount / reset on a window object of its own.

  var LAZY = {
    explorer: {
      host: 'ex-host', hostClass: 'ds-ex-host', root: '.ex', api: 'FamilistaDesignExplorer', v: '20261012-explorer',
      css: '/design-system/explorer.css', js: '/design-system/explorer.js',
      failed: 'The Visual Explorer could not be loaded',
    },
    components: {
      host: 'cl-host', hostClass: 'cl-host', root: '.cl', api: 'FamilistaDesignComponents', v: '20261012-components',
      css: '/design-system/components.css', js: '/design-system/components.js',
      failed: 'The Components Library could not be loaded',
    },
    // `pre` are scripts the section's own script needs first (the Lab's shared sanitizer).
    lab: {
      host: 'lab-host', hostClass: 'lab-host', root: '.lab', api: 'FamilistaDesignLab', v: '20261012-lab',
      css: '/design-system/lab.css', js: '/design-system/lab.js', pre: ['/design-system/lab-sanitize.js'],
      failed: 'The Specimen Lab could not be loaded',
    },
  };
  function loadAssets(key) {
    if (DS.assets[key]) return DS.assets[key];
    var L = LAZY[key];
    DS.assets[key] = new Promise(function (resolve) {
      var pre = L.pre || [];
      var pending = 2 + pre.length, failed = false;
      function one(ok) { if (!ok) failed = true; if (--pending === 0) { if (failed) DS.assets[key] = null; resolve(!failed); } }
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = L.css + '?v=' + L.v;
      link.onload = function () { one(true); };
      link.onerror = function () { one(false); };
      document.head.appendChild(link);
      // Inserted in order and not async, so each runs after the ones before it.
      pre.forEach(function (src) {
        var dep = document.createElement('script');
        dep.src = src + '?v=' + L.v;
        dep.async = false;
        dep.onload = function () { one(true); };
        dep.onerror = function () { one(false); };
        document.head.appendChild(dep);
      });
      var script = document.createElement('script');
      script.src = L.js + '?v=' + L.v;
      script.async = false;
      script.onload = function () { one(true); };
      script.onerror = function () { one(false); };
      document.head.appendChild(script);
    });
    return DS.assets[key];
  }
  function mountLazy(host) {
    var key = DS.section, L = LAZY[key];
    if (!L || !host.querySelector('#' + L.host)) return;
    loadAssets(key).then(function (ok) {
      var slot = host.querySelector('#' + L.host);
      if (DS.section !== key || !slot) return;
      if (!ok || !window[L.api]) {
        slot.innerHTML = emptyState(L.failed, T('Reload the page and try again.'));
        return;
      }
      window[L.api].mount(slot, window.__familistaDesignSystemKit);
      DS.mounted = key;
    });
  }
  function leaveLazy() {
    var key = DS.mounted;
    if (key && window[LAZY[key].api]) window[LAZY[key].api].unmount();
    DS.mounted = null;
  }
  /** What a lazy section may borrow from this room: its vocabulary, its escaping and its GET-only reader. Nothing that writes. */
  window.__familistaDesignSystemKit = {
    T: T, tf: tf, esc: esc, num: num, code: code, kv: kv, evChip: evChip, chip: chip, emptyState: emptyState, skeleton: skeleton,
    ltr: ltr, short: short,
    api: function (path) { return api(path); }, contractError: contractError, dir: function () { return DS_DIR; },
  };

  /** Repaint the body, top bar and rail — never the shell, so nothing under the reader moves. */
  function repaintBody(host, keepScroll) {
    var body = host.querySelector('#ds-body');
    if (!body) return paint(host);
    var y = keepScroll ? body.scrollTop : 0;
    // A mounted lazy section is not redrawn because the overview finished loading behind it.
    var L = LAZY[DS.section];
    if (!(keepScroll && L && DS.mounted === DS.section && body.querySelector('#' + L.host + ' ' + L.root))) {
      if (!L || DS.mounted !== DS.section) leaveLazy();
      body.classList.toggle('ds-body--workspace', !!L);
      body.setAttribute('aria-label', T(SECTION_TITLE[DS.section] || 'Overview'));
      body.innerHTML = contentHtml();
      body.scrollTop = y;
      paintValues(body);
      DS.mounted = null;
      mountLazy(host);
    }
    var top = host.querySelector('.ds-top');
    if (top) top.outerHTML = topHtml();
    var rail = host.querySelector('.ds-rail');
    if (rail) rail.outerHTML = railHtml();
  }

  /** A filter changed: only the rows and the count are replaced, so the search box keeps its focus and caret. */
  function repaintRows(host) {
    var rows = host.querySelector('#ds-rows');
    var count = host.querySelector('#ds-count');
    if (!rows || !DS.tk) return;
    if (DS.tab === 'contrast') {
      var c = contrastList();
      rows.innerHTML = contrastRowsHtml(c);
      if (count) count.textContent = tf('Showing %d of %d pairs', c.length, DS.tk.contrast.length);
    } else {
      var l = filteredTokens();
      rows.innerHTML = tokenRowsHtml(l);
      if (count) count.textContent = tf('Showing %d of %d tokens', l.length, DS.tk.tokens.length);
    }
    paintValues(rows);
  }

  function ensureSection(host) {
    if (DS.section === 'tokens' && !DS.tk && !DS.tkLoading) {
      loadTokens().then(function () { if (DS.section === 'tokens') repaintBody(host, true); });
    }
  }
  function go(host, section) {
    if (LAZY[section] && DS.section === section) return;
    DS.section = section;
    repaintBody(host, false);
    ensureSection(host);
    var body = host.querySelector('#ds-body');
    if (body) body.focus({ preventScroll: true });
  }
  function refresh(host) {
    if (DS.refreshing) return;
    DS.refreshing = true;
    if (LAZY[DS.section] && window[LAZY[DS.section].api]) { leaveLazy(); window[LAZY[DS.section].api].reset(); }
    repaintBody(host, !LAZY[DS.section]);
    var jobs = [loadOverview()];
    if (DS.section === 'tokens') jobs.push(loadTokens());
    else DS.tk = null;
    Promise.all(jobs).then(function () { DS.refreshing = false; repaintBody(host, true); ensureSection(host); });
  }
  function closeLangs(host) {
    DS.langOpen = false;
    var box = host.querySelector('.ds-langs');
    if (box) box.classList.remove('is-open');
    var pick = host.querySelector('[data-ds-langs]');
    if (pick) pick.setAttribute('aria-expanded', 'false');
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__dsBound) return;
    host.__dsBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-ds-home]')) { try { window.navTo('owner-home'); } catch (_) {} return; }

      if (t.closest('[data-ds-langs]')) {
        DS.langOpen = !DS.langOpen;
        var box = host.querySelector('.ds-langs');
        if (box) box.classList.toggle('is-open', DS.langOpen);
        t.closest('[data-ds-langs]').setAttribute('aria-expanded', DS.langOpen ? 'true' : 'false');
        return;
      }
      var lang = t.closest('[data-ds-lang]');
      if (lang) {
        DS.langOpen = false;
        setLocale(lang.getAttribute('data-ds-lang')).then(function () {
          var body = host.querySelector('#ds-body');
          var y = body ? body.scrollTop : 0;
          paint(host);
          var again = host.querySelector('#ds-body');
          if (again) again.scrollTop = y;
        });
        return;
      }
      if (DS.langOpen && !t.closest('.ds-langs')) closeLangs(host);

      var nav = t.closest('[data-ds-nav]');
      if (nav) { go(host, nav.getAttribute('data-ds-nav')); return; }

      var tab = t.closest('[data-ds-tab]');
      if (tab) { DS.tab = tab.getAttribute('data-ds-tab'); repaintBody(host, false); var again2 = host.querySelector('#ds-tab-' + DS.tab); if (again2) again2.focus(); return; }

      var cf = t.closest('[data-ds-cf]');
      if (cf) {
        DS.cfilter = cf.getAttribute('data-ds-cf');
        var bar = host.querySelectorAll('[data-ds-cf]');
        for (var i = 0; i < bar.length; i++) {
          var on = bar[i] === cf;
          bar[i].classList.toggle('is-on', on);
          bar[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        repaintRows(host);
        return;
      }
      if (t.closest('[data-ds-refresh]')) { refresh(host); return; }
    });

    host.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t && t.id === 'ds-q') { DS.q = t.value; repaintRows(host); }
    });
    host.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.id === 'ds-layer') { DS.layer = t.value; repaintRows(host); }
      else if (t.id === 'ds-type') { DS.type = t.value; repaintRows(host); }
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && DS.langOpen) { closeLangs(host); var pick = host.querySelector('[data-ds-langs]'); if (pick) pick.focus(); return; }
      // Arrow keys move between the tabs of a tablist and activate the one they land on.
      var tab = ev.target && ev.target.closest ? ev.target.closest('[data-ds-tab]') : null;
      if (tab && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'Home' || ev.key === 'End')) {
        var order = ['tokens', 'layers', 'contrast'];
        var at = order.indexOf(DS.tab);
        var rtl = DS_DIR === 'rtl';
        var step = ev.key === 'ArrowRight' ? (rtl ? -1 : 1) : ev.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
        var next = ev.key === 'Home' ? 0 : ev.key === 'End' ? order.length - 1 : (at + step + order.length) % order.length;
        ev.preventDefault();
        DS.tab = order[next];
        repaintBody(host, false);
        var f = host.querySelector('#ds-tab-' + DS.tab);
        if (f) f.focus();
      }
    });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaDesignSystem = function (host) {
    // The page-render registry calls every renderer with NO argument, and the
    // navigation switch calls this one with the root element. Both must work.
    host = host || document.getElementById('ds-root');
    if (!host) return;
    bind(host);
    setLocale(initialLocale()).then(function () {
      paint(host);
      return loadOverview();
    }).then(function () {
      repaintBody(host, true);
      ensureSection(host);
    });
  };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaDesignSystemSeen = function () { return Object.keys(DS_SEEN).sort(); };
  window.__familistaDesignSystemMissing = function () {
    return DS_LANG === 'en' ? [] : Object.keys(DS_SEEN).filter(function (k) { return !Object.prototype.hasOwnProperty.call(DS_DICT, k); }).sort();
  };

  window.teardownFamilistaDesignSystem = function () {
    leaveLazy();
    // No stream or timer of its own. The section, filters and language menu are
    // dropped so the room opens clean next time.
    DS.section = 'overview'; DS.tab = 'tokens'; DS.q = ''; DS.layer = 'all'; DS.type = 'all'; DS.cfilter = 'all';
    DS.langOpen = false; DS.refreshing = false;
  };
}());
