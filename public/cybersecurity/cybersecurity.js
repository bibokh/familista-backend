/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA CYBERSECURITY — the Command Center

   THE SEVENTH ROOM, AND THE ONE AROUND THE OTHERS

   SYSTEM operates the platform. CLUBS operates the football organisations. The
   DATA VAULT remembers, INFRASTRUCTURE CITY is what it is built from, SOURCE
   CORE is where its inputs came from and VISION is what it can see. This room
   answers one question about all of them: WHAT is protected, WHERE, HOW, and
   what the evidence says about it right now.

   IT DISCOVERS NOTHING AND DECIDES NOTHING

   Every state on this screen is composed by the backend from evidence the
   Cyber Defense work already maintains — the coverage map, the generated
   security manifest, the posture policy — and from counts the running
   platform recorded. This module fetches that composition and draws it. There
   is no list of controls or statuses in this file and there must never be
   one: a hand-written status is a second opinion, and the day it disagrees
   with the evidence is the day somebody trusts the wrong one.

   It is read-only. Nothing here changes a setting, a mode or a policy: RLS
   mode, enforcement, MFA requirements and alert delivery are changed where
   they always were, in reviewed code and the hosting provider's settings.

   TWO QUESTIONS, NEVER ONE

     PROTECTION   what the evidence proves: Protected, Partial, Observing,
                  At risk, Unknown. Nothing is protected by default.
     LIVE LAYER   what the running platform measures: Live, Warning, Not
                  instrumented, Not applicable, Unavailable. A domain nobody
                  measures at runtime says so — it is never drawn green.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var CS = {
    data: null,
    error: null,
    section: 'overview',
    domainId: null,
    detail: null,
    detailError: null,
    lens: null,
    preview: null,
    inspect: null,
    inspectFrom: null,
    rowFilter: 'all',
    langOpen: false,
    refreshing: false,
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
    try { return n.toLocaleString(CS_LANG === 'ar' ? 'ar' : CS_LANG); } catch (_) { return String(n); }
  }
  function has(v) { return v !== null && v !== undefined; }

  /** An em dash that can say why it is an em dash. */
  function absent(why) {
    return '<span class="cs-none" title="' + esc(why || '') + '">—</span>';
  }

  function fmtInstant(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var local;
    try {
      local = new Intl.DateTimeFormat(CS_LANG === 'ar' ? 'ar' : CS_LANG, {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(d);
    } catch (_) { local = d.toISOString().replace('T', ' ').slice(0, 16); }
    return { local: local, utc: d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
  }

  function instantHtml(iso, why) {
    var at = fmtInstant(iso);
    if (!at) return absent(why || T('Not recorded.'));
    return '<time class="cs-at" datetime="' + esc(iso) + '" title="' + esc(at.utc) + '" data-no-i18n>' + esc(at.local) + '</time>';
  }

  // ── localisation ──────────────────────────────────────────────────────────
  //
  // This module's own three-language catalogue, behind `data-no-i18n` on the
  // page root — the same boundary SYSTEM, the Data Vault, Infrastructure City
  // and Source Core keep, so these strings never enter the club product's
  // locale files.
  //
  // Repository evidence — a boundary's reason, a control's evidence note, a
  // known gap as the posture policy records it — is QUOTED, never paraphrased:
  // it is shown as recorded, marked `lang="en"`, under a caption that says so.
  // Translating an audit record is how its meaning drifts.

  var CS_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var CS_DICT = {};
  var CS_LANG = 'en';
  var CS_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < CS_LOCALES.length; i++) if (CS_LOCALES[i][0] === tag) return CS_LOCALES[i];
    return CS_LOCALES[0];
  }
  function initialLocale() {
    try {
      var v = localStorage.getItem('familista_cybersecurity_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { CS_DICT = {}; return Promise.resolve(); }
    return fetch('/cybersecurity/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { CS_DICT = d || {}; })
      .catch(function () { CS_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    CS_LANG = l[0]; CS_DIR = l[2];
    try { localStorage.setItem('familista_cybersecurity_locale', CS_LANG); } catch (_) {}
    return loadDict(CS_LANG);
  }

  /** One string. A digit run becomes %d; a missing key falls through to English. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || CS_LANG === 'en') return s;
    if (Object.prototype.hasOwnProperty.call(CS_DICT, s)) return CS_DICT[s];
    var slot = s.replace(/\d[\d.,  ]*/g, '%d');
    if (slot !== s && Object.prototype.hasOwnProperty.call(CS_DICT, slot)) {
      var nums = s.match(/\d[\d.,  ]*/g) || [];
      var i = 0;
      return String(CS_DICT[slot]).replace(/%d/g, function () { return nums[i++] != null ? nums[i - 1] : '%d'; });
    }
    return s;
  }

  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var i = 0;
    return T(key).replace(/%d/g, function () { var v = args[i++]; return v == null ? '—' : num(v); });
  }

  function csTranslate(root) {
    if (!root || CS_LANG === 'en') return;
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
    var active = localeOf(CS_LANG);
    return '<div class="cs-langs' + (CS.langOpen ? ' is-open' : '') + '">'
      + '<button class="cs-lang-pick" type="button" data-cs-langs'
      + ' aria-expanded="' + (CS.langOpen ? 'true' : 'false') + '" aria-label="Cybersecurity language">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="cs-lang-ch" aria-hidden="true">⌄</span></button>'
      + '<div class="cs-lang-menu" role="group">'
      + CS_LOCALES.map(function (l) {
        return '<button class="cs-lang' + (l[0] === CS_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-cs-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === CS_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // Five protection words and five live-layer words, each meaning one thing.
  // These two functions are the only place a state becomes a colour. Green is
  // proven or measured; amber is partial or a named warning; red is at risk;
  // blue is a rollout stage under observation. Three greys say "do not read
  // this as working", told apart by border style: dotted for NOT INSTRUMENTED,
  // dashed for NOT APPLICABLE, solid for UNAVAILABLE and UNKNOWN.

  function stateKind(s) {
    switch (String(s || '').toUpperCase()) {
      case 'PROTECTED': case 'LIVE': case 'PRESENT': case 'C': case 'READ': return 'ok';
      case 'PARTIAL': case 'WARNING': case 'P': return 'warn';
      case 'AT_RISK': case 'U': case 'CRITICAL': return 'crit';
      case 'OBSERVING': return 'obs';
      case 'NOT_INSTRUMENTED': return 'none';
      case 'NOT_APPLICABLE': return 'na';
      case 'INFO': return 'info';
      case 'UNAVAILABLE': return 'off';
      default: return 'unknown';
    }
  }
  function stateLabel(s) {
    switch (String(s || '').toUpperCase()) {
      case 'PROTECTED': return T('Protected');
      case 'PARTIAL': return T('Partial');
      case 'OBSERVING': return T('Observing');
      case 'AT_RISK': return T('At risk');
      case 'LIVE': return T('Live');
      case 'WARNING': return T('Warning');
      case 'NOT_INSTRUMENTED': return T('Not instrumented');
      case 'NOT_APPLICABLE': return T('Not applicable');
      case 'UNAVAILABLE': return T('Unavailable');
      case 'INFO': return T('Informational');
      default: return T('Unknown');
    }
  }

  /** What each state means, in one sentence, for the legend and the tooltips. */
  var STATE_MEANING = {
    PROTECTED: 'Every boundary it answers for is covered and every control on them is present.',
    PARTIAL: 'Some of its boundaries or controls are only partly in place.',
    OBSERVING: 'A rollout is switched on and being watched; enforcement is not on yet.',
    AT_RISK: 'A boundary is uncovered or a required control is absent.',
    UNKNOWN: 'The evidence for it could not be read.',
    LIVE: 'The running platform measures it and no warning is raised.',
    WARNING: 'The running platform raised a named warning.',
    NOT_INSTRUMENTED: 'Nothing measures it at runtime yet. Never read as working.',
    NOT_APPLICABLE: 'Enforced at build time; there is nothing to measure at runtime.',
    UNAVAILABLE: 'The platform could not read it just now.',
  };

  function chip(state, extra, label) {
    return '<span class="cs-chip cs-chip--' + stateKind(state) + (extra ? ' ' + extra : '') + '"'
      + ' title="' + esc(T(STATE_MEANING[state] || '')) + '">'
      + '<span class="cs-dot" aria-hidden="true"></span>' + esc(label || stateLabel(state)) + '</span>';
  }

  function controlStatusLabel(c) {
    switch (c) {
      case 'PRESENT': return T('Present');
      case 'PARTIAL': return T('Partial');
      case 'ABSENT': return T('Absent');
      default: return T('Not in the manifest');
    }
  }
  function controlKind(c, required) {
    if (c === 'PRESENT') return 'ok';
    if (c === 'PARTIAL') return 'warn';
    if (c === 'ABSENT') return required ? 'crit' : 'warn';
    return 'unknown';
  }
  function coverageLabel(c) {
    return c === 'C' ? T('Covered') : c === 'P' ? T('Partially covered') : T('Uncovered');
  }

  var SOURCE_LABEL = { build: 'Build evidence', runtime: 'Runtime', process: 'This instance' };
  var TEXT_VALUE = { on: 'On', observe: 'Observe', off: 'Off' };
  var CONFIG_KIND = {
    'On': 'ok', 'Running': 'ok', 'Configured': 'ok', 'Enforced': 'ok', 'Open — signed callbacks only': 'ok',
    'Observe': 'obs', 'Not enforced': 'obs',
    'Off': 'off', 'Not running': 'warn', 'Not configured': 'warn', 'Closed — no secret configured': 'off',
    'Unknown': 'unknown',
  };

  // ── navigation ────────────────────────────────────────────────────────────

  var SECTIONS = [
    ['overview', 'Command Center', '◈', 'COMMAND'],
    ['domains', 'Security Domains', '⬢', 'COMMAND'],
    ['rls', 'Row-Level Security', '▦', 'ROLLOUT'],
    ['lifecycle', 'Security Lifecycle', '↻', 'ROLLOUT'],
    ['coverage', 'Coverage & Gaps', '◫', 'EVIDENCE'],
    ['events', 'Events & Alerts', '⚑', 'EVIDENCE'],
    ['evidence', 'Evidence', '§', 'EVIDENCE'],
  ];
  var GROUP_ORDER = ['COMMAND', 'ROLLOUT', 'EVIDENCE'];
  var GROUP_LABEL = { COMMAND: 'Command', ROLLOUT: 'Rollout & lifecycle', EVIDENCE: 'Evidence' };

  function domains() { return (CS.data && CS.data.domains) || []; }
  function areas() { return (CS.data && CS.data.areas) || []; }
  function domainOf(id) { return domains().filter(function (d) { return d.id === id; })[0] || null; }
  function areaOf(id) { return areas().filter(function (a) { return a.id === id; })[0] || null; }

  function railBadge(id) {
    var d = CS.data;
    if (!d || d.state !== 'READY') return '';
    var n = 0, kind = 'warn';
    if (id === 'domains') n = domains().filter(function (x) { return x.warnings.length; }).length;
    if (id === 'coverage' && d.posture) n = d.posture.boundaries.P + d.posture.boundaries.U;
    if (id === 'events' && d.events && d.events.critical24h) { n = d.events.critical24h; kind = 'crit'; }
    if (id === 'rls' && d.rls && d.rls.warnings.length) n = d.rls.warnings.length;
    if (!n) return '';
    return '<span class="cs-rail-badge cs-rail-badge--' + kind + '" data-no-i18n>' + esc(num(n)) + '</span>';
  }

  function railHtml() {
    var current = CS.section === 'domain' ? 'domains' : CS.section;
    var groups = GROUP_ORDER.map(function (g) {
      var items = SECTIONS.filter(function (s) { return s[3] === g; });
      return '<div class="cs-rail-group"><div class="cs-rail-label">' + esc(T(GROUP_LABEL[g])) + '</div>'
        + items.map(function (s) {
          var on = current === s[0];
          return '<button class="cs-rail-item' + (on ? ' is-on' : '') + '"'
            + ' type="button" data-cs-nav="' + s[0] + '"' + (on ? ' aria-current="page"' : '') + '>'
            + '<span class="cs-rail-icon" aria-hidden="true">' + s[2] + '</span>'
            + '<span class="cs-rail-text">' + esc(T(s[1])) + '</span>' + railBadge(s[0]) + '</button>';
        }).join('') + '</div>';
    }).join('');

    return '<nav class="cs-rail" aria-label="Cybersecurity">'
      + '<div class="cs-rail-head">'
      + '<button class="cs-rail-home" type="button" data-cs-home aria-label="Back to Familista home">'
      + '<span aria-hidden="true">←</span><span class="cs-rail-text" data-no-i18n>Familista</span></button>'
      + '<div class="cs-rail-brand"><span class="cs-rail-mark" aria-hidden="true">' + shieldSvg(18) + '</span>'
      + '<span class="cs-rail-title">' + esc(T('Cybersecurity')) + '</span></div>'
      + '</div>'
      + '<div class="cs-rail-body">' + groups + '</div>'
      + '<div class="cs-rail-foot">' + footHtml() + '</div>'
      + '</nav>';
  }

  function footHtml() {
    var d = CS.data;
    // A refused or failed read is not "still reading": say it is unavailable.
    if (!d && CS.error) return '<div class="cs-foot">' + chip('UNAVAILABLE', 'cs-chip--sm') + '</div>';
    if (!d) return '<div class="cs-foot"><span class="cs-chip cs-chip--unknown">' + esc(T('Reading evidence…')) + '</span></div>';
    var at = fmtInstant(d.measuredAt);
    return '<div class="cs-foot">'
      + (d.posture ? chip(d.posture.verdict, 'cs-chip--sm', T('Posture: %s').replace('%s', stateLabel(d.posture.verdict))) : '')
      + (at ? '<span class="cs-foot-at" data-no-i18n title="' + esc(at.utc) + '">' + esc(at.local) + '</span>' : '')
      + '</div>';
  }

  function shieldSvg(size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" focusable="false" aria-hidden="true">'
      + '<path d="M12 2.6 4.6 5.5v5.8c0 4.5 3.1 8.6 7.4 10 4.3-1.4 7.4-5.5 7.4-10V5.5L12 2.6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<circle cx="12" cy="10.4" r="2.1" stroke="currentColor" stroke-width="1.5"/>'
      + '<path d="M12 12.5v3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
      + '</svg>';
  }

  function titleOf() {
    if (CS.section === 'domain') {
      var d = domainOf(CS.domainId);
      return d ? T(d.title) : T('Security domain');
    }
    return T((SECTIONS.filter(function (s) { return s[0] === CS.section; })[0] || [null, 'Command Center'])[1]);
  }

  function topHtml() {
    var d = CS.data;
    return '<header class="cs-top">'
      + '<div class="cs-top-l"><div class="cs-top-eyebrow" data-no-i18n>FAMILISTA · CYBERSECURITY</div>'
      + '<h1 class="cs-top-title">' + esc(titleOf()) + '</h1></div>'
      + '<div class="cs-top-r">'
      + (d && d.posture ? chip(d.posture.verdict, '', T('Posture: %s').replace('%s', stateLabel(d.posture.verdict))) : '')
      + '<button class="cs-btn" type="button" data-cs-refresh' + (CS.refreshing ? ' aria-busy="true" disabled' : '') + '>'
      + '<span class="cs-btn-icon" aria-hidden="true">↻</span>'
      + '<span>' + esc(CS.refreshing ? T('Reading…') : T('Refresh')) + '</span></button>'
      + languageSwitchHtml()
      + '</div></header>';
  }

  /**
   * A panel. `tag` is for a name that is DATA — an identifier — which sits
   * beside the title without being composed into it: a title built by
   * concatenation is a key the catalogue can never hold.
   */
  function panel(title, body, note, tag, cls) {
    return '<section class="cs-panel' + (cls ? ' ' + cls : '') + '">'
      + (title ? '<div class="cs-panel-head"><h2 class="cs-panel-title">' + esc(T(title))
        + (tag ? ' <span class="cs-panel-tag" data-no-i18n>' + esc(tag) + '</span>' : '')
        + '</h2>'
        + (note ? '<span class="cs-panel-note">' + esc(note) + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }

  function emptyState(title, detail) {
    return '<div class="cs-empty"><div class="cs-empty-mark" aria-hidden="true">∅</div>'
      + '<div class="cs-empty-title">' + esc(T(title)) + '</div>'
      + (detail ? '<div class="cs-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  /**
   * The skeleton is the size of the content it stands in for. Heights are
   * classes, not inline styles: the platform's CSP refuses a style attribute.
   * `size` is one of event (34), attention (46), control (58), boundary (74).
   */
  function skeleton(n, size) {
    var rows = '';
    for (var i = 0; i < (n || 5); i++) rows += '<div class="cs-skel-row' + (size ? ' cs-skel-row--' + size : '') + '"></div>';
    return '<div class="cs-skel" aria-hidden="true">' + rows + '</div>';
  }

  function kv(k, v, raw) {
    return '<div class="cs-kv-row"><span>' + esc(k) + '</span><b data-no-i18n>' + (raw ? v : esc(v)) + '</b></div>';
  }

  /** Repository evidence, quoted as recorded. */
  function quote(text, caption) {
    if (!text) return '';
    return '<figure class="cs-quote">'
      + '<figcaption class="cs-quote-cap">' + esc(T(caption || 'As recorded in the evidence')) + '</figcaption>'
      + '<blockquote class="cs-quote-body" lang="en" dir="ltr" data-no-i18n>' + esc(text) + '</blockquote>'
      + '</figure>';
  }

  // ── figures ───────────────────────────────────────────────────────────────

  function figureValue(f) {
    if (!has(f.value)) return absent(T(f.why || 'Not measured.'));
    switch (f.kind) {
      case 'flag': return esc(f.value ? T('Yes') : T('No'));
      case 'instant': return instantHtml(f.value, T(f.why || 'Not recorded.'));
      case 'text': return esc(T(TEXT_VALUE[f.value] || String(f.value)));
      default: return esc(num(f.value));
    }
  }

  function figuresHtml(figs) {
    if (!figs || !figs.length) return '';
    return '<div class="cs-figs">' + figs.map(function (f) {
      return '<div class="cs-fig">'
        + '<div class="cs-fig-v" data-no-i18n>' + figureValue(f) + '</div>'
        + '<div class="cs-fig-l">' + esc(T(f.label)) + '</div>'
        + '<div class="cs-fig-s cs-fig-s--' + esc(f.source) + '">' + esc(T(SOURCE_LABEL[f.source] || f.source)) + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  function configHtml(items) {
    if (!items || !items.length) return '';
    return '<div class="cs-cfg">' + items.map(function (c) {
      return '<div class="cs-cfg-row"><span class="cs-cfg-l">' + esc(T(c.label)) + '</span>'
        + '<span class="cs-chip cs-chip--sm cs-chip--' + (CONFIG_KIND[c.value] || 'unknown') + '">'
        + '<span class="cs-dot" aria-hidden="true"></span>' + esc(T(c.value)) + '</span></div>';
    }).join('') + '</div>';
  }

  function warningsHtml(ws) {
    if (!ws || !ws.length) return '';
    return '<div class="cs-warns">' + ws.map(function (w) {
      return '<div class="cs-warn" role="note"><span class="cs-warn-mark" aria-hidden="true">!</span>'
        + '<span>' + esc(T(w.text)) + '</span></div>';
    }).join('') + '</div>';
  }

  /**
   * How much of a set is in place, drawn as a bar that IS the figure: each
   * segment's width is its count, in a viewBox the length of the whole set.
   * SVG geometry is attributes, not style, so it is drawn under the platform's
   * CSP — which refuses an inline style attribute.
   */
  function bar(parts, total) {
    if (!total) return '<div class="cs-bar cs-bar--empty"></div>';
    var x = 0;
    var shown = parts.filter(function (p) { return p[1] > 0; });
    var rects = shown.map(function (p, i) {
      var r = '<rect class="cs-bar-seg cs-bar-seg--' + p[0] + '" x="' + x + '" y="0" width="' + p[1] + '" height="1"/>';
      x += p[1];
      // A hairline between two segments, so adjacent counts read as two.
      if (i < shown.length - 1) r += '<line class="cs-bar-gap" x1="' + x + '" y1="0" x2="' + x + '" y2="1"/>';
      return r;
    }).join('');
    return '<svg class="cs-bar" viewBox="0 0 ' + total + ' 1" preserveAspectRatio="none" role="img" focusable="false"'
      + ' aria-label="' + esc(parts.map(function (p) { return p[2] + ': ' + p[1]; }).join(', ')) + '">' + rects + '</svg>';
  }

  // ── OVERVIEW — the hero, the attention list, the map ──────────────────────

  function overviewHtml() {
    var d = CS.data;
    return heroHtml(d) + legendHtml() + attentionHtml(d) + mapHtml(d);
  }

  function heroHtml(d) {
    var p = d.posture;
    var b = p.boundaries, c = p.controls, r = p.required, dm = p.domains;
    var totalDomains = domains().length;
    var rls = d.rls;
    var ev = d.events;

    var metric = function (label, value, of, parts, total) {
      return '<div class="cs-hm">'
        + '<div class="cs-hm-v" data-no-i18n><b>' + esc(num(value)) + '</b><span>/ ' + esc(num(of)) + '</span></div>'
        + '<div class="cs-hm-l">' + esc(label) + '</div>'
        + bar(parts, total) + '</div>';
    };

    return '<section class="cs-hero">'
      + '<div class="cs-hero-id">'
      + '<div class="cs-hero-mark" aria-hidden="true">' + shieldSvg(34) + '</div>'
      + '<div class="cs-hero-txt">'
      + '<div class="cs-hero-eyebrow">' + esc(T('Security posture')) + '</div>'
      + '<div class="cs-hero-verdict">' + chip(p.verdict, 'cs-chip--lg') + '</div>'
      + '<div class="cs-hero-sum">' + esc(tf('%d of %d trust boundaries fully covered', b.C, b.total)) + '</div>'
      + '<div class="cs-hero-why">' + esc(T('The verdict is the weakest boundary. It turns green only when every boundary is fully covered.')) + '</div>'
      + '</div></div>'

      + '<div class="cs-hero-metrics">'
      + metric(T('Trust boundaries covered'), b.C, b.total, [['ok', b.C, T('Covered')], ['warn', b.P, T('Partially covered')], ['crit', b.U, T('Uncovered')]], b.total)
      + metric(T('Controls present'), c.present, c.total, [['ok', c.present, T('Present')], ['warn', c.partial, T('Partial')], ['crit', c.absent, T('Absent')]], c.total)
      + metric(T('Required controls present'), r.present, r.total, [['ok', r.present, T('Present')], ['crit', r.total - r.present, T('Absent')]], r.total)
      + metric(T('Domains fully protected'), dm.PROTECTED, totalDomains,
        [['ok', dm.PROTECTED, T('Protected')], ['obs', dm.OBSERVING, T('Observing')], ['warn', dm.PARTIAL, T('Partial')], ['crit', dm.AT_RISK, T('At risk')], ['unknown', dm.UNKNOWN, T('Unknown')]], totalDomains)
      + '</div>'

      + '<div class="cs-hero-live">'
      + (rls ? '<button class="cs-hl cs-hl--rls" type="button" data-cs-nav="rls">'
        + '<div class="cs-hl-head"><span class="cs-hl-title">' + esc(T('Row-level security')) + '</span>' + chip(rls.state, 'cs-chip--sm') + '</div>'
        + '<div class="cs-hl-rows">'
        + '<div class="cs-hl-row"><span>' + esc(T('Application context')) + '</span><b>' + esc(T(TEXT_VALUE[rls.mode] || rls.mode)) + '</b></div>'
        + '<div class="cs-hl-row"><span>' + esc(T('Database enforcement')) + '</span><b>'
        + esc(rls.enforced === true ? T('Enforced') : rls.enforced === false ? T('Not enforced') : T('Unknown')) + '</b></div>'
        + '<div class="cs-hl-row"><span>' + esc(T('Rollout stage')) + '</span><b>' + esc(tf('%d of %d', rls.stage.index + 1, rls.stages.length)) + ' · ' + esc(T(rls.stage.title)) + '</b></div>'
        + '</div></button>' : '')
      + '<button class="cs-hl" type="button" data-cs-nav="events">'
      + '<div class="cs-hl-head"><span class="cs-hl-title">' + esc(T('Security events')) + '</span>' + chip(ev.state, 'cs-chip--sm') + '</div>'
      + '<div class="cs-hl-rows">'
      + '<div class="cs-hl-row"><span>' + esc(T('Last 24 hours')) + '</span><b data-no-i18n>' + (has(ev.total24h) ? esc(num(ev.total24h)) : absent(T(ev.why || 'Not measured.'))) + '</b></div>'
      + '<div class="cs-hl-row"><span>' + esc(T('Critical, last 24 hours')) + '</span><b data-no-i18n>' + (has(ev.critical24h) ? esc(num(ev.critical24h)) : absent(T(ev.why || 'Not measured.'))) + '</b></div>'
      + '<div class="cs-hl-row"><span>' + esc(T('Alert delivery')) + '</span><b>'
      + esc(ev.alerts.recipientConfigured ? (ev.alerts.dispatcherRunning ? T('Running') : T('Not running')) : T('No recipient configured')) + '</b></div>'
      + '</div></button>'
      + '</div>'
      + '</section>';
  }

  function legendHtml() {
    var group = function (title, states) {
      return '<div class="cs-legend-g"><span class="cs-legend-t">' + esc(T(title)) + '</span>'
        + states.map(function (s) { return chip(s, 'cs-chip--sm'); }).join('') + '</div>';
    };
    return '<div class="cs-legend" aria-label="Legend">'
      + group('Protection, from evidence', ['PROTECTED', 'PARTIAL', 'OBSERVING', 'AT_RISK', 'UNKNOWN'])
      + group('Live layer, from the running platform', ['LIVE', 'WARNING', 'NOT_INSTRUMENTED', 'NOT_APPLICABLE', 'UNAVAILABLE'])
      + '</div>';
  }

  /** What needs the owner, ordered by what it would cost to ignore it. */
  function attentionHtml(d) {
    var items = [];
    domains().forEach(function (dm) {
      dm.warnings.forEach(function (w) {
        items.push({ kind: 'warn', text: T(w.text), where: T(dm.title), open: dm.id });
      });
    });
    (d.rls ? d.rls.warnings : []).forEach(function (w) {
      if (!items.some(function (x) { return x.text === T(w.text); })) items.push({ kind: 'warn', text: T(w.text), where: T('Row-level security'), nav: 'rls' });
    });
    domains().filter(function (dm) { return dm.state === 'AT_RISK'; }).forEach(function (dm) {
      items.unshift({ kind: 'crit', text: T('A boundary is uncovered or a required control is absent.'), where: T(dm.title), open: dm.id });
    });

    var gaps = d.posture.knownGaps;
    var partial = d.posture.boundaries.P + d.posture.boundaries.U;

    var list = items.length
      ? '<div class="cs-att-list">' + items.map(function (it) {
        return '<button class="cs-att cs-att--' + it.kind + '" type="button"'
          + (it.open ? ' data-cs-open-domain="' + esc(it.open) + '"' : ' data-cs-nav="' + esc(it.nav) + '"') + '>'
          + '<span class="cs-att-mark" aria-hidden="true">' + (it.kind === 'crit' ? '!!' : '!') + '</span>'
          + '<span class="cs-att-body"><span class="cs-att-text">' + esc(it.text) + '</span>'
          + '<span class="cs-att-where">' + esc(it.where) + '</span></span>'
          + '<span class="cs-att-go" aria-hidden="true">→</span></button>';
      }).join('') + '</div>'
      : '<div class="cs-att-none">' + chip('LIVE', 'cs-chip--sm', T('No live warning')) + '<span>' + esc(T('The running platform raised no warning.')) + '</span></div>';

    var standing = '<div class="cs-att-standing">'
      + '<button class="cs-att-s" type="button" data-cs-nav="coverage">'
      + '<b data-no-i18n>' + esc(num(partial)) + '</b><span>' + esc(T('Trust boundaries not fully covered')) + '</span></button>'
      + '<button class="cs-att-s" type="button" data-cs-nav="coverage">'
      + '<b data-no-i18n>' + esc(num(gaps.length)) + '</b><span>' + esc(T('Known gaps in the posture policy')) + '</span></button>'
      + '<button class="cs-att-s" type="button" data-cs-nav="coverage">'
      + '<b data-no-i18n>' + esc(num(domains().filter(function (x) { return x.live === 'NOT_INSTRUMENTED'; }).length)) + '</b><span>' + esc(T('Domains not instrumented at runtime')) + '</span></button>'
      + '</div>';

    return panel('Needs attention', list + standing, T('Warnings first, then what the evidence says is not yet complete.'));
  }

  // ── the platform security map ─────────────────────────────────────────────
  //
  // Two columns of one picture. On the inline start, the Control Plane and the
  // eighteen security domains it is made of. On the inline end, the platform:
  // every Familista area, in its district. Wires are drawn between them only
  // for what the reader points at — a domain lights the areas it protects, an
  // area lights the domains that protect it — so the map never becomes the
  // hairball a full bipartite graph of this platform would be. Nothing on it
  // moves unless the reader moved it.

  function mapHtml(d) {
    var groups = d.groups.map(function (g) {
      var list = areas().filter(function (a) { return a.group === g.id; });
      if (!list.length) return '';
      var worst = worstOf(list.map(function (a) { return a.state; }));
      return '<section class="cs-district" data-cs-group="' + esc(g.id) + '">'
        + '<div class="cs-district-head" data-cs-district-head>'
        + '<span class="cs-district-name">' + esc(T(g.title)) + '</span>'
        + '<span class="cs-district-n" data-no-i18n>' + esc(num(list.length)) + '</span>'
        + '<span class="cs-dot cs-dot--' + stateKind(worst) + '" title="' + esc(stateLabel(worst)) + '"></span>'
        + '</div>'
        + '<div class="cs-district-body">' + list.map(areaChip).join('') + '</div>'
        + '</section>';
    }).join('');

    var doms = domains().map(function (dm) {
      return '<button class="cs-mdom cs-mdom--' + stateKind(dm.state) + (CS.lens === dm.id ? ' is-locked' : '') + '" type="button"'
        + ' data-cs-dom="' + esc(dm.id) + '" aria-pressed="' + (CS.lens === dm.id ? 'true' : 'false') + '"'
        + ' title="' + esc(T(dm.protects)) + '">'
        + '<span class="cs-dot" aria-hidden="true"></span>'
        + '<span class="cs-mdom-name">' + esc(T(dm.title)) + '</span>'
        + '<span class="cs-live cs-live--' + stateKind(dm.live) + '" title="' + esc(stateLabel(dm.live)) + '" aria-label="' + esc(stateLabel(dm.live)) + '"></span>'
        + '</button>';
    }).join('');

    return panel('Platform security map',
      lensBarHtml()
      + '<div class="cs-map" data-cs-map>'
      + '<svg class="cs-wires" aria-hidden="true" focusable="false"></svg>'
      + '<div class="cs-map-plane">'
      + '<div class="cs-map-cp">'
      + '<div class="cs-cp" data-cs-cp>'
      + '<span class="cs-cp-halo" aria-hidden="true"></span>'
      + '<div class="cs-cp-mark" aria-hidden="true">' + shieldSvg(26) + '</div>'
      + '<div class="cs-cp-title">' + esc(T('Cybersecurity Control Plane')) + '</div>'
      + '<div class="cs-cp-sub">' + esc(tf('%d security domains · %d platform areas', domains().length, areas().length)) + '</div>'
      + '<div class="cs-cp-state">' + chip(d.posture.verdict, 'cs-chip--sm') + '</div>'
      + '</div>'
      + '<div class="cs-mdoms" role="group" aria-label="Security domains">' + doms + '</div>'
      + '</div>'
      + '<div class="cs-map-areas">' + groups + '</div>'
      + '</div></div>',
      T('Point at a domain to see what it protects; select an area to inspect it.'));
  }

  function areaChip(a) {
    var gaps = a.gaps.length;
    return '<button class="cs-area cs-area--' + stateKind(a.state) + '" type="button" data-cs-area="' + esc(a.id) + '"'
      + ' title="' + esc(stateLabel(a.state) + (gaps ? ' · ' + a.gaps.map(function (g) { return T(g.name); }).join(' · ') : '')) + '">'
      + '<span class="cs-dot" aria-hidden="true"></span>'
      + '<span class="cs-area-name">' + esc(T(a.title)) + '</span>'
      + (gaps ? '<span class="cs-area-gaps" data-no-i18n aria-label="' + esc(tf('%d partial boundaries', gaps)) + '">' + esc(num(gaps)) + '</span>' : '')
      + '</button>';
  }

  function lensBarHtml() {
    var dm = CS.lens ? domainOf(CS.lens) : null;
    if (!dm) {
      return '<div class="cs-lens" data-cs-lens><span class="cs-lens-hint">'
        + esc(T('Showing every domain. Select one to lock its view.')) + '</span></div>';
    }
    return '<div class="cs-lens is-on" data-cs-lens>'
      + '<span class="cs-lens-label">' + esc(T('Showing the protection of')) + '</span>'
      + '<span class="cs-lens-name">' + esc(T(dm.title)) + '</span>'
      + '<span class="cs-lens-n">' + esc(tf('%d of %d areas', dm.areas.length, areas().length)) + '</span>'
      + '<span class="cs-lens-actions">'
      + '<button class="cs-link" type="button" data-cs-open-domain="' + esc(dm.id) + '">' + esc(T('Open domain')) + '</button>'
      + '<button class="cs-link cs-link--quiet" type="button" data-cs-lens-clear>' + esc(T('Show all')) + '</button>'
      + '</span></div>';
  }

  var RANK = { AT_RISK: 0, UNKNOWN: 1, PARTIAL: 2, OBSERVING: 3, PROTECTED: 4 };
  function worstOf(states) {
    var w = 'PROTECTED';
    states.forEach(function (s) { if ((RANK[s] != null ? RANK[s] : 1) < RANK[w]) w = s; });
    return w;
  }

  /** Light what the reader points at. Classes only: nothing is re-laid out. */
  function applyFocus(host) {
    var map = host.querySelector('[data-cs-map]');
    if (!map) return;
    var f = focusOf();
    var litAreas = null, litDoms = null;
    if (f && f.kind === 'domain') {
      var dm = domainOf(f.id);
      litAreas = dm ? dm.areas : [];
      litDoms = [f.id];
    } else if (f && f.kind === 'area') {
      var a = areaOf(f.id);
      litDoms = a ? a.domains : [];
      litAreas = [f.id];
    }
    map.classList.toggle('is-focused', !!f);
    map.querySelectorAll('[data-cs-area]').forEach(function (el) {
      var id = el.getAttribute('data-cs-area');
      el.classList.toggle('is-lit', !!litAreas && litAreas.indexOf(id) >= 0);
      el.classList.toggle('is-dim', !!litAreas && litAreas.indexOf(id) < 0);
    });
    map.querySelectorAll('[data-cs-group]').forEach(function (g) {
      var any = !!litAreas && Array.prototype.some.call(g.querySelectorAll('[data-cs-area]'), function (el) {
        return litAreas.indexOf(el.getAttribute('data-cs-area')) >= 0;
      });
      g.classList.toggle('is-lit', any);
      g.classList.toggle('is-dim', !!litAreas && !any);
    });
    map.querySelectorAll('[data-cs-dom]').forEach(function (el) {
      var id = el.getAttribute('data-cs-dom');
      el.classList.toggle('is-lit', !!litDoms && litDoms.indexOf(id) >= 0);
      el.classList.toggle('is-dim', !!litDoms && litDoms.indexOf(id) < 0);
      el.classList.toggle('is-locked', CS.lens === id);
      el.setAttribute('aria-pressed', CS.lens === id ? 'true' : 'false');
    });
    drawWires(host);
  }

  var NARROW = '(max-width: 980px), (max-height: 620px)';

  function drawWires(host) {
    var map = host.querySelector('[data-cs-map]');
    if (!map) return;
    var svg = map.querySelector('.cs-wires');
    if (!svg) return;
    if (window.matchMedia && window.matchMedia(NARROW).matches) { svg.innerHTML = ''; return; }
    var box = map.getBoundingClientRect();
    if (!box.width || !box.height) return;
    svg.setAttribute('viewBox', '0 0 ' + Math.round(box.width) + ' ' + Math.round(box.height));
    var rtl = CS_DIR === 'rtl';
    var s = rtl ? -1 : 1;
    // A wire leaves the edge of the Control Plane column that faces the
    // platform, and plugs into the edge of a district that faces back. It never
    // crosses a district, because the districts are one stacked bus.
    var out = function (el) { var r = el.getBoundingClientRect(); return { x: (rtl ? r.left : r.right) - box.left, y: r.top + r.height / 2 - box.top }; };
    var plug = function (district, y) {
      var r = district.getBoundingClientRect();
      var top = r.top - box.top + 10, bottom = r.bottom - box.top - 10;
      return { x: (rtl ? r.right : r.left) - box.left, y: Math.max(top, Math.min(bottom, y == null ? (r.top + r.height / 2 - box.top) : y)) };
    };
    var midY = function (els) {
      if (!els.length) return null;
      var sum = 0;
      els.forEach(function (el) { var r = el.getBoundingClientRect(); sum += r.top + r.height / 2 - box.top; });
      return sum / els.length;
    };
    var wire = function (a, b, kind, strong) {
      var dx = Math.max(28, Math.abs(b.x - a.x) * 0.5);
      return '<path class="cs-wire cs-wire--' + kind + (strong ? ' is-strong' : '') + '" d="M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1)
        + ' C' + (a.x + s * dx).toFixed(1) + ' ' + a.y.toFixed(1) + ' ' + (b.x - s * dx).toFixed(1) + ' ' + b.y.toFixed(1)
        + ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1) + '"/>'
        + '<circle class="cs-wire-end cs-wire--' + kind + '" cx="' + b.x.toFixed(1) + '" cy="' + b.y.toFixed(1) + '" r="2.6"/>';
    };
    var districtState = function (g) {
      return worstOf(areas().filter(function (a) { return a.group === g.getAttribute('data-cs-group'); }).map(function (a) { return a.state; }));
    };
    var paths = [];
    var f = focusOf();
    var q = function (sel) { return map.querySelector(sel); };
    var districts = Array.prototype.slice.call(map.querySelectorAll('[data-cs-group]'));
    if (f && f.kind === 'domain') {
      var from = q('[data-cs-dom="' + cssId(f.id) + '"]');
      var dm = domainOf(f.id);
      if (from && dm) districts.forEach(function (g) {
        var lit = Array.prototype.slice.call(g.querySelectorAll('[data-cs-area]')).filter(function (el) {
          return dm.areas.indexOf(el.getAttribute('data-cs-area')) >= 0;
        });
        if (!lit.length) return;
        var st = worstOf(lit.map(function (el) { var a = areaOf(el.getAttribute('data-cs-area')); return a ? a.state : 'UNKNOWN'; }));
        paths.push(wire(out(from), plug(g, midY(lit)), stateKind(st), true));
      });
    } else if (f && f.kind === 'area') {
      var target = q('[data-cs-area="' + cssId(f.id) + '"]');
      var ar = areaOf(f.id);
      var home = target ? target.closest('[data-cs-group]') : null;
      if (target && ar && home) ar.domains.forEach(function (id) {
        var src = q('[data-cs-dom="' + cssId(id) + '"]');
        var dd = domainOf(id);
        if (src && dd) paths.push(wire(out(src), plug(home, midY([target])), stateKind(dd.state), true));
      });
    } else {
      // At rest: one conduit from the Control Plane into each district.
      var cp = q('[data-cs-cp]');
      if (cp) districts.forEach(function (g) { paths.push(wire(out(cp), plug(g, null), stateKind(districtState(g)), false)); });
    }
    svg.innerHTML = paths.join('');
  }

  /** What the map is showing: a pointed-at element, else the locked lens. */
  function focusOf() {
    return CS.preview || (CS.lens ? { kind: 'domain', id: CS.lens } : null);
  }

  function cssId(id) { return String(id).replace(/["\\]/g, '\\$&'); }

  // ── DOMAINS — eighteen drill-down cards ───────────────────────────────────

  function domainsHtml() {
    var cards = domains().map(function (dm) {
      var lead = dm.figures.length ? dm.figures[0] : null;
      var rows = (CS.data.boundaries || []).filter(function (b) { return dm.rows.indexOf(b.id) >= 0; });
      return '<button class="cs-dcard cs-dcard--' + stateKind(dm.state) + '" type="button" data-cs-open-domain="' + esc(dm.id) + '">'
        + '<div class="cs-dcard-head"><span class="cs-dcard-title">' + esc(T(dm.title)) + '</span>' + chip(dm.state, 'cs-chip--sm') + '</div>'
        + '<div class="cs-dcard-protects">' + esc(T(dm.protects)) + '</div>'
        + '<div class="cs-dcard-ctl">'
        + '<span class="cs-dcard-k">' + esc(T('Controls present')) + '</span>'
        + '<span class="cs-dcard-v" data-no-i18n>' + esc(num(dm.controls.present)) + ' / ' + esc(num(dm.controls.total)) + '</span>'
        + bar([['ok', dm.controls.present, T('Present')], ['warn', dm.controls.partial, T('Partial')], ['crit', dm.controls.absent, T('Absent')]], dm.controls.total)
        + '</div>'
        + '<div class="cs-dcard-rows">' + rows.map(function (b) {
          return '<span class="cs-rowtag cs-rowtag--' + stateKind(b.coverage) + '" title="' + esc(T(b.name) + ' · ' + coverageLabel(b.coverage)) + '" data-no-i18n>#' + esc(b.id) + '</span>';
        }).join('') + '</div>'
        + '<div class="cs-dcard-live">' + chip(dm.live, 'cs-chip--sm')
        + (lead ? '<span class="cs-dcard-fig"><b data-no-i18n>' + figureValue(lead) + '</b> ' + esc(T(lead.label)) + '</span>'
          : '<span class="cs-dcard-fig cs-dcard-fig--why">' + esc(T(dm.liveWhy || '')) + '</span>')
        + '</div>'
        + (dm.warnings.length ? '<div class="cs-dcard-warn">' + esc(tf('%d warnings', dm.warnings.length)) + '</div>' : '')
        + '<div class="cs-dcard-go">' + esc(T('Open domain')) + ' <span aria-hidden="true">→</span></div>'
        + '</button>';
    }).join('');
    return '<div class="cs-intro">' + esc(T('Each domain is a kind of protection. Its state comes from the trust boundaries it answers for and the controls on them; its live layer from what the running platform records.')) + '</div>'
      + '<div class="cs-dcards">' + cards + '</div>';
  }

  // ── A DOMAIN, in full ─────────────────────────────────────────────────────

  function domainHtml() {
    var dm = domainOf(CS.domainId);
    if (!dm) return emptyState('This security domain does not exist', T('Return to the list of domains.'));
    var det = CS.detail && CS.detail.id === dm.id ? CS.detail : null;

    var head = '<section class="cs-dhead">'
      + '<button class="cs-back" type="button" data-cs-nav="domains"><span aria-hidden="true">←</span> ' + esc(T('All domains')) + '</button>'
      + '<div class="cs-dhead-main">'
      + '<div class="cs-dhead-txt"><h2 class="cs-dhead-title">' + esc(T(dm.title)) + '</h2>'
      + '<p class="cs-dhead-protects">' + esc(T(dm.protects)) + '</p></div>'
      + '<div class="cs-dhead-states">'
      + '<div class="cs-dhead-s"><span class="cs-dhead-k">' + esc(T('Protection')) + '</span>' + chip(dm.state, 'cs-chip--lg') + '</div>'
      + '<div class="cs-dhead-s"><span class="cs-dhead-k">' + esc(T('Live layer')) + '</span>' + chip(dm.live, 'cs-chip--lg') + '</div>'
      + '</div></div>'
      + (dm.id === 'rls' ? '<button class="cs-link" type="button" data-cs-nav="rls">' + esc(T('Open the RLS rollout')) + ' →</button>' : '')
      + '</section>';

    var live = figuresHtml(dm.figures) + configHtml(dm.config) + warningsHtml(dm.warnings)
      + (dm.liveWhy ? '<div class="cs-why">' + chip(dm.live, 'cs-chip--sm') + '<span>' + esc(T(dm.liveWhy)) + '</span></div>' : '');

    var controls = det ? controlsHtml(det.controlList)
      : CS.detailError ? emptyState('This domain could not be read', CS.detailError) : skeleton(Math.max(3, dm.controls.total), 'control');
    var rows = det ? rowsHtml(det.rowList)
      : CS.detailError ? '' : skeleton(dm.rows.length || 2, 'boundary');
    var events = det ? recentHtml(det) : CS.detailError ? '' : skeleton(3, 'event');

    var areasList = dm.areas.map(function (id) { return areaOf(id); }).filter(Boolean);

    return head
      + '<div class="cs-dgrid">'
      + '<div class="cs-dcol">'
      + panel('Live state', live || emptyState('Nothing is measured for this domain', T(dm.liveWhy || '')),
        T('Values only. No setting, secret or address is ever shown.'))
      + panel('Controls and their evidence', controls, tf('%d of %d present', dm.controls.present, dm.controls.total))
      + panel('Trust boundaries', rows, T('From the coverage map, enforced in CI.'))
      + '</div>'
      + '<div class="cs-dcol">'
      + panel('Protected areas', areasList.length
        ? '<div class="cs-chips">' + areasList.map(areaChip).join('') + '</div>'
        : emptyState('No platform area depends on these boundaries', ''),
        tf('%d of %d areas', areasList.length, areas().length))
      + panel('Latest security events', events, T('Kind, severity and time only.'))
      + panel('Signals', signalsHtml(dm.events), T('Security event types this domain is evidenced by.'))
      + '</div></div>';
  }

  function controlsHtml(list) {
    if (!list.length) return emptyState('No control is mapped to this domain', '');
    return '<div class="cs-ctls">' + list.map(function (c) {
      var kind = controlKind(c.status, c.required);
      return '<div class="cs-ctl cs-ctl--' + kind + '">'
        + '<div class="cs-ctl-head">'
        + '<span class="cs-chip cs-chip--sm cs-chip--' + kind + '"><span class="cs-dot" aria-hidden="true"></span>' + esc(controlStatusLabel(c.status)) + '</span>'
        + '<code class="cs-ctl-id" data-no-i18n>' + esc(c.id) + '</code>'
        + (c.required ? '<span class="cs-req">' + esc(T('Required')) + '</span>' : '')
        + '</div>'
        + (c.evidence ? '<div class="cs-ctl-ev"><span class="cs-ctl-k">' + esc(T('Evidence')) + '</span><code data-no-i18n>' + esc(c.evidence) + '</code></div>' : '')
        + (c.note ? quote(c.note, 'Evidence note, as recorded') : '')
        + (c.knownGap ? quote(c.knownGap, 'Known gap, as the posture policy records it') : '')
        + '</div>';
    }).join('') + '</div>';
  }

  function rowsHtml(list) {
    if (!list.length) return emptyState('This domain answers for no trust boundary', '');
    return '<div class="cs-rows">' + list.map(rowCard).join('') + '</div>';
  }

  function rowCard(b) {
    return '<div class="cs-row cs-row--' + stateKind(b.coverage) + '">'
      + '<div class="cs-row-head"><span class="cs-row-id" data-no-i18n>#' + esc(b.id) + '</span>'
      + '<span class="cs-row-name">' + esc(T(b.name)) + '</span>'
      + '<span class="cs-chip cs-chip--sm cs-chip--' + stateKind(b.coverage) + '"><span class="cs-dot" aria-hidden="true"></span>' + esc(coverageLabel(b.coverage)) + '</span></div>'
      + '<div class="cs-row-meta">'
      + '<span><i>' + esc(T('Flow')) + '</i><code data-no-i18n>' + esc(b.flow) + '</code></span>'
      + '<span><i>' + esc(T('Boundary type')) + '</i><code data-no-i18n>' + esc(b.boundaryType) + '</code></span>'
      + '<span><i>' + esc(T('Data class')) + '</i><code data-no-i18n>' + esc(b.dataClass) + '</code></span>'
      + '<span><i>' + esc(T('Controls')) + '</i><code data-no-i18n>' + esc(num(b.controls.length)) + '</code></span>'
      + '</div>'
      + (b.coverage !== 'C' && b.reason ? quote(b.reason, 'Why it is not fully covered, as recorded') : '')
      + (b.coverage !== 'C' && b.plannedIn ? quote(b.plannedIn, 'What closes it, as recorded') : '')
      + '</div>';
  }

  function recentHtml(det) {
    var e = det.recentEvents, s = det.recentSignals;
    var block = function (r, render, emptyTitle) {
      if (r.state !== 'READ') {
        return '<div class="cs-why">' + chip(r.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NOT_INSTRUMENTED', 'cs-chip--sm') + '<span>' + esc(T(r.why || '')) + '</span></div>';
      }
      if (!r.items.length) return '<div class="cs-why">' + chip('LIVE', 'cs-chip--sm', T('Measured')) + '<span>' + esc(T(emptyTitle)) + '</span></div>';
      return '<div class="cs-evs">' + r.items.map(render).join('') + '</div>';
    };
    return '<div class="cs-sub">' + esc(T('Security events')) + '</div>'
      + block(e, function (x) {
        return '<div class="cs-ev"><span class="cs-chip cs-chip--sm cs-chip--' + (x.severity === 'CRITICAL' ? 'crit' : x.severity === 'WARN' ? 'warn' : 'info') + '">'
          + esc(x.severity === 'CRITICAL' ? T('Critical') : x.severity === 'WARN' ? T('Warning') : T('Information')) + '</span>'
          + '<span class="cs-ev-l">' + esc(T(x.label)) + '</span><code class="cs-ev-k" data-no-i18n>' + esc(x.kind) + '</code>'
          + instantHtml(x.at) + '</div>';
      }, 'No event of these kinds is recorded.')
      + '<div class="cs-sub">' + esc(T('Security signals')) + '</div>'
      + block(s, function (x) {
        return '<div class="cs-ev"><code class="cs-ev-k" data-no-i18n>' + esc(x.type) + '</code>' + instantHtml(x.at) + '</div>';
      }, 'No signal of these types is recorded.');
  }

  function signalsHtml(ev) {
    var kinds = ev.kinds || [];
    var sigs = ev.signals || [];
    if (!kinds.length && !sigs.length) {
      return '<div class="cs-why">' + chip(ev.state, 'cs-chip--sm') + '<span>' + esc(T(ev.why || 'No security event is recorded for this domain yet.')) + '</span></div>';
    }
    var cell = function (v) { return has(v) ? esc(num(v)) : absent(T(ev.why || 'Not measured.')); };
    return (ev.why ? '<div class="cs-why">' + chip(ev.state, 'cs-chip--sm') + '<span>' + esc(T(ev.why)) + '</span></div>' : '')
      + (kinds.length ? '<div class="cs-tbl cs-tbl--kinds" role="table">'
        + '<div class="cs-tr cs-tr--head" role="row"><span role="columnheader">' + esc(T('Event')) + '</span><span role="columnheader">' + esc(T('24 h')) + '</span><span role="columnheader">' + esc(T('7 days')) + '</span><span role="columnheader">' + esc(T('Critical')) + '</span></div>'
        + kinds.map(function (k) {
          return '<div class="cs-tr" role="row"><span role="cell" class="cs-tname">' + esc(T(k.label)) + ' <code data-no-i18n>' + esc(k.kind) + '</code></span>'
            + '<span role="cell" data-no-i18n>' + cell(k.count24h) + '</span><span role="cell" data-no-i18n>' + cell(k.count7d) + '</span>'
            + '<span role="cell" data-no-i18n>' + cell(k.critical24h) + '</span></div>';
        }).join('') + '</div>' : '')
      + (sigs.length ? '<div class="cs-tbl cs-tbl--sigs" role="table">'
        + '<div class="cs-tr cs-tr--head" role="row"><span role="columnheader">' + esc(T('Signal')) + '</span><span role="columnheader">' + esc(T('Collector')) + '</span><span role="columnheader">' + esc(T('24 h')) + '</span><span role="columnheader">' + esc(T('7 days')) + '</span></div>'
        + sigs.map(function (x) {
          return '<div class="cs-tr" role="row"><span role="cell" class="cs-tname">' + esc(T(x.describes)) + ' <code data-no-i18n>' + esc(x.type) + '</code></span>'
            + '<span role="cell">' + (x.produced ? chip('LIVE', 'cs-chip--sm', T('Produced')) : chip('NOT_INSTRUMENTED', 'cs-chip--sm', T('Declared only'))) + '</span>'
            + '<span role="cell" data-no-i18n>' + cell(x.count24h) + '</span><span role="cell" data-no-i18n>' + cell(x.count7d) + '</span></div>';
        }).join('') + '</div>' : '');
  }

  // ── ROW-LEVEL SECURITY — the rollout, with its two switches kept apart ────

  function rlsHtml() {
    var r = CS.data.rls;
    if (!r) return emptyState('Row-level security evidence is not available', T(CS.data.reason || ''));
    var at = fmtInstant(r.windowStart);

    var track = '<ol class="cs-track">' + r.stages.map(function (s, i) {
      return '<li class="cs-step' + (s.reached ? ' is-reached' : '') + (s.current ? ' is-current' : '') + '"'
        + (s.current ? ' aria-current="step"' : '') + '>'
        + '<span class="cs-step-n" data-no-i18n>' + esc(num(i + 1)) + '</span>'
        + '<span class="cs-step-t">' + esc(T(s.title)) + '</span>'
        + '<span class="cs-step-d">' + esc(T(s.describes)) + '</span>'
        + (s.current ? '<span class="cs-step-now">' + esc(T('Current stage')) + '</span>' : '')
        + '</li>';
    }).join('') + '</ol>';

    var sw = function (title, token, value, kind, explains) {
      return '<div class="cs-switch">'
        + '<div class="cs-switch-head"><span class="cs-switch-t">' + esc(T(title)) + '</span><code data-no-i18n>' + esc(token) + '</code></div>'
        + '<div class="cs-switch-v"><span class="cs-chip cs-chip--lg cs-chip--' + kind + '"><span class="cs-dot" aria-hidden="true"></span>' + esc(value) + '</span></div>'
        + '<div class="cs-switch-x">' + esc(T(explains)) + '</div></div>';
    };

    var enforcedText = r.enforced === true ? T('Enforced') : r.enforced === false ? T('Not enforced') : T('Unknown');
    var enforcedKind = r.enforced === true ? 'ok' : r.enforced === false ? 'obs' : 'unknown';
    var modeKind = r.mode === 'on' ? 'ok' : r.mode === 'observe' ? 'obs' : 'off';

    var obs = r.observations.length
      ? '<div class="cs-tbl cs-tbl--obs" role="table">'
        + '<div class="cs-tr cs-tr--head" role="row"><span role="columnheader">' + esc(T('Table')) + '</span><span role="columnheader">' + esc(T('Operation')) + '</span><span role="columnheader">' + esc(T('First seen')) + '</span></div>'
        + r.observations.map(function (o) {
          return '<div class="cs-tr" role="row"><span role="cell"><code data-no-i18n>' + esc(o.model) + '</code></span>'
            + '<span role="cell"><code data-no-i18n>' + esc(o.operation) + '</code></span><span role="cell">' + instantHtml(o.firstSeenAt) + '</span></div>';
        }).join('') + '</div>'
      : '<div class="cs-why">' + chip('LIVE', 'cs-chip--sm', T('Measured')) + '<span>' + esc(T('No pilot-table query has run without a context since this instance started.')) + '</span></div>';

    return '<section class="cs-rls-hero">'
      + '<div class="cs-rls-id"><div class="cs-rls-eyebrow">' + esc(T('PostgreSQL row-level security')) + '</div>'
      + '<div class="cs-rls-stage">' + esc(tf('Stage %d of %d', r.stage.index + 1, r.stages.length)) + ' · <b>' + esc(T(r.stage.title)) + '</b></div>'
      + '<div class="cs-rls-d">' + esc(T(r.stage.describes)) + '</div></div>'
      + '<div class="cs-rls-state">' + chip(r.state, 'cs-chip--lg') + '</div>'
      + '</section>'
      + warningsHtml(r.warnings)
      + panel('Two switches, kept apart',
        '<div class="cs-switches">'
        + sw('Application context', 'DB_RLS_CONTEXT', T(TEXT_VALUE[r.mode] || r.mode), modeKind,
          'What the application sends with every pilot-table query: the club it is acting for, or a named system path. Set in the hosting provider’s settings.')
        + sw('Database enforcement', 'familista_rls_enforced()', enforcedText, enforcedKind,
          'Whether PostgreSQL itself refuses a pilot-table query outside its club. Changed only by the reviewed enforcement migration.')
        + '</div>',
        T('A context that is sent is not a wall that is enforced. The two are reported separately.'))
      + panel('Rollout', track, T('Each stage is reached only after the one before it has been watched in production.'))
      + '<div class="cs-dgrid">'
      + '<div class="cs-dcol">'
      + panel('Pilot tables', '<div class="cs-chips">' + r.tables.map(function (t) {
        return '<span class="cs-token" data-no-i18n>' + esc(t) + '</span>';
      }).join('') + '</div><div class="cs-note">' + esc(T('Every other club table relies on the application’s tenancy checks.')) + '</div>',
        tf('%d tables', r.tables.length))
      + panel('Named cross-club paths', r.systemPaths.length ? '<div class="cs-paths">' + r.systemPaths.map(function (p) {
        return '<div class="cs-path"><code class="cs-path-id" data-no-i18n>' + esc(p.reason) + '</code>' + quote(p.review, 'Review, as recorded') + '</div>';
      }).join('') + '</div>' : emptyState('No cross-club path is named', ''),
        T('The only paths allowed to act across clubs, each reviewed by name.'))
      + '</div>'
      + '<div class="cs-dcol">'
      + panel('Queries without a context', obs,
        at ? T('Since this instance started: %s').replace('%s', at.local) : T('Since this instance started'))
      + panel('What this screen does not do', '<div class="cs-note">'
        + esc(T('The Command Center reads the rollout. It does not change the context mode, enable enforcement, or alter any policy or role.'))
        + '</div>')
      + '</div></div>';
  }

  // ── LIFECYCLE — every change, through every gate ──────────────────────────

  function lifecycleHtml() {
    var stages = CS.data.lifecycle || [];
    return '<div class="cs-intro">' + esc(T('Every change to Familista passes through these stages. Each one shows the controls that prove it, measured from the repository.')) + '</div>'
      + '<ol class="cs-life">' + stages.map(function (s, i) {
        return '<li class="cs-stage cs-stage--' + stateKind(s.state) + '">'
          + '<div class="cs-stage-head"><span class="cs-stage-n" data-no-i18n>' + esc(i < 9 ? '0' + (i + 1) : String(i + 1)) + '</span>'
          + chip(s.state, 'cs-chip--sm') + '</div>'
          + '<div class="cs-stage-t">' + esc(T(s.title)) + '</div>'
          + '<div class="cs-stage-d">' + esc(T(s.describes)) + '</div>'
          + (s.figures.length ? '<div class="cs-stage-figs">' + s.figures.map(function (f) {
            return '<span><b data-no-i18n>' + figureValue(f) + '</b> ' + esc(T(f.label)) + '</span>';
          }).join('') + '</div>' : '')
          + stageControlsHtml(s.controls)
          + (s.outsideView ? '<div class="cs-outside"><span class="cs-outside-t">' + esc(T('Outside the platform’s view')) + '</span>'
            + '<span>' + esc(T(s.outsideView)) + '</span></div>' : '')
          + '</li>';
      }).join('') + '</ol>'
      + panel('How a new part of Familista joins', '<ol class="cs-join">'
        + '<li><b>' + esc(T('Register its threat surface')) + '</b><span>' + esc(T('Its router, model, worker or setting is mapped onto a trust boundary in the coverage map, or CI fails.')) + '</span></li>'
        + '<li><b>' + esc(T('Place it on the map')) + '</b><span>' + esc(T('Its router is placed in a platform area. The Command Center test fails while any mounted router belongs to no area.')) + '</span></li>'
        + '<li><b>' + esc(T('Name its protection')) + '</b><span>' + esc(T('A new kind of risk gets a security domain naming its boundaries; a new runtime signal gets an adapter. The map, the cards and the drill-downs follow.')) + '</span></li>'
        + '</ol>');
  }

  /**
   * A stage's controls. A handful are listed by name; a long list — the
   * required controls are every control the build must keep — is summarised as
   * a count and a bar, with any control that is NOT present still named, so the
   * summary can never hide the one that matters. Each control and its evidence
   * is on the domain pages.
   */
  var STAGE_LIST_MAX = 8;
  function stageControlsHtml(list) {
    if (!list.length) return '';
    var item = function (c) {
      return '<span class="cs-sctl cs-sctl--' + controlKind(c.status, true) + '" title="' + esc(controlStatusLabel(c.status)) + '">'
        + '<span class="cs-dot" aria-hidden="true"></span><code data-no-i18n>' + esc(c.id) + '</code></span>';
    };
    if (list.length <= STAGE_LIST_MAX) return '<div class="cs-stage-ctls">' + list.map(item).join('') + '</div>';
    var present = list.filter(function (c) { return c.status === 'PRESENT'; }).length;
    var partial = list.filter(function (c) { return c.status === 'PARTIAL'; }).length;
    var open = list.filter(function (c) { return c.status !== 'PRESENT'; });
    return '<div class="cs-stage-sum"><b data-no-i18n>' + esc(num(present)) + ' / ' + esc(num(list.length)) + '</b> '
      + esc(T('Controls present')) + '</div>'
      + bar([['ok', present, T('Present')], ['warn', partial, T('Partial')], ['crit', list.length - present - partial, T('Absent')]], list.length)
      + (open.length ? '<div class="cs-stage-ctls">' + open.map(item).join('') + '</div>'
        : '<div class="cs-stage-note">' + esc(T('Every required control is present. Each one, with its evidence, is on the domain pages.')) + '</div>');
  }

  // ── COVERAGE & GAPS ───────────────────────────────────────────────────────

  function coverageHtml() {
    var d = CS.data, p = d.posture;
    var b = p.boundaries, c = p.controls;

    var summary = '<div class="cs-covsum">'
      + '<div class="cs-cov"><div class="cs-cov-head"><span>' + esc(T('Trust boundaries')) + '</span><b data-no-i18n>' + esc(num(b.total)) + '</b></div>'
      + bar([['ok', b.C, T('Covered')], ['warn', b.P, T('Partially covered')], ['crit', b.U, T('Uncovered')]], b.total)
      + '<div class="cs-cov-leg"><span class="k-ok">' + esc(tf('%d covered', b.C)) + '</span><span class="k-warn">' + esc(tf('%d partial', b.P)) + '</span><span class="k-crit">' + esc(tf('%d uncovered', b.U)) + '</span></div></div>'
      + '<div class="cs-cov"><div class="cs-cov-head"><span>' + esc(T('Controls')) + '</span><b data-no-i18n>' + esc(num(c.total)) + '</b></div>'
      + bar([['ok', c.present, T('Present')], ['warn', c.partial, T('Partial')], ['crit', c.absent, T('Absent')]], c.total)
      + '<div class="cs-cov-leg"><span class="k-ok">' + esc(tf('%d present', c.present)) + '</span><span class="k-warn">' + esc(tf('%d partial', c.partial)) + '</span><span class="k-crit">' + esc(tf('%d absent', c.absent)) + '</span></div></div>'
      + '</div>';

    var gaps = p.knownGaps.length ? '<div class="cs-gaps">' + p.knownGaps.map(function (g) {
      var kind = controlKind(g.status, false);
      return '<div class="cs-gap"><div class="cs-gap-head"><span class="cs-chip cs-chip--sm cs-chip--' + kind + '"><span class="cs-dot" aria-hidden="true"></span>' + esc(controlStatusLabel(g.status)) + '</span>'
        + '<code data-no-i18n>' + esc(g.id) + '</code></div>' + quote(g.text, 'As the posture policy records it') + '</div>';
    }).join('') + '</div>' : emptyState('The posture policy names no known gap', '');

    var groupsHtml = d.groups.map(function (g) {
      var list = areas().filter(function (a) { return a.group === g.id; });
      if (!list.length) return '';
      return '<div class="cs-agroup"><div class="cs-agroup-t">' + esc(T(g.title)) + '</div>'
        + list.map(function (a) {
          return '<button class="cs-arow" type="button" data-cs-area="' + esc(a.id) + '">'
            + chip(a.state, 'cs-chip--sm')
            + '<span class="cs-arow-name">' + esc(T(a.title)) + '</span>'
            + '<span class="cs-arow-gaps">' + (a.gaps.length ? a.gaps.map(function (x) {
              return '<span class="cs-rowtag cs-rowtag--' + stateKind(x.coverage) + '" data-no-i18n title="' + esc(T(x.name)) + '">#' + esc(x.id) + '</span>';
            }).join('') : '<span class="cs-arow-ok">' + esc(T('Every boundary covered')) + '</span>') + '</span>'
            + '</button>';
        }).join('') + '</div>';
    }).join('');

    var rows = (d.boundaries || []).filter(function (r) {
      return CS.rowFilter === 'all' ? true : CS.rowFilter === 'open' ? r.coverage !== 'C' : r.coverage === 'C';
    });
    var filter = '<div class="cs-filter" role="group" aria-label="Filter">'
      + [['all', 'All'], ['open', 'Not fully covered'], ['covered', 'Covered']].map(function (f) {
        return '<button class="cs-fbtn' + (CS.rowFilter === f[0] ? ' is-on' : '') + '" type="button" data-cs-filter="' + f[0] + '"'
          + ' aria-pressed="' + (CS.rowFilter === f[0] ? 'true' : 'false') + '">' + esc(T(f[1])) + '</button>';
      }).join('') + '</div>';

    var noLive = domains().filter(function (x) { return x.live === 'NOT_INSTRUMENTED' || x.live === 'NOT_APPLICABLE' || x.live === 'UNAVAILABLE'; });
    var outside = (d.lifecycle || []).filter(function (s) { return s.outsideView; });

    return summary
      + '<div class="cs-dgrid">'
      + '<div class="cs-dcol">'
      + panel('Known gaps', gaps, T('Named in the posture policy; each stays visible until it is closed.'))
      + panel('Not measured at runtime', (noLive.length ? '<div class="cs-nolive">' + noLive.map(function (x) {
        return '<button class="cs-nl" type="button" data-cs-open-domain="' + esc(x.id) + '">' + chip(x.live, 'cs-chip--sm')
          + '<span class="cs-nl-t">' + esc(T(x.title)) + '</span><span class="cs-nl-w">' + esc(T(x.liveWhy || '')) + '</span></button>';
      }).join('') + '</div>' : emptyState('Every domain is measured at runtime', ''))
        + (outside.length ? '<div class="cs-sub">' + esc(T('Outside the platform’s view')) + '</div>' + outside.map(function (s) {
          return '<div class="cs-why">' + chip('NOT_INSTRUMENTED', 'cs-chip--sm', T(s.title)) + '<span>' + esc(T(s.outsideView)) + '</span></div>';
        }).join('') : ''),
        T('Protected by evidence, but not watched while the platform runs.'))
      + panel('Registration', (d.unassignedRouters.length
        ? warningsHtml([{ text: 'A mounted router belongs to no platform area.' }]) + '<div class="cs-chips">' + d.unassignedRouters.map(function (r) {
          return '<span class="cs-token" data-no-i18n>' + esc(r) + '</span>';
        }).join('') + '</div>'
        : '<div class="cs-why">' + chip('PROTECTED', 'cs-chip--sm', T('Complete')) + '<span>' + esc(T('Every mounted router belongs to a platform area.')) + '</span></div>'),
        T('New development joins the map automatically or fails CI.'))
      + '</div>'
      + '<div class="cs-dcol">'
      + panel('Platform areas', '<div class="cs-agroups">' + groupsHtml + '</div>', tf('%d areas', areas().length))
      + '</div></div>'
      + panel('Trust boundaries', filter + (rows.length ? '<div class="cs-rows cs-rows--grid">' + rows.map(rowCard).join('') + '</div>'
        : emptyState('No boundary matches this filter', '')),
        tf('%d of %d shown', rows.length, (d.boundaries || []).length));
  }

  // ── EVENTS & ALERTS ───────────────────────────────────────────────────────

  function eventsHtml() {
    var e = CS.data.events;
    var tile = function (label, v) {
      return '<div class="cs-fig"><div class="cs-fig-v" data-no-i18n>' + (has(v) ? esc(num(v)) : absent(T(e.why || 'Not measured.'))) + '</div>'
        + '<div class="cs-fig-l">' + esc(T(label)) + '</div></div>';
    };
    var cell = function (v) { return has(v) ? esc(num(v)) : absent(T(e.why || 'Not measured.')); };
    var alertCfg = [
      { label: 'Alert dispatcher', value: e.alerts.dispatcherRunning ? 'Running' : 'Not running' },
      { label: 'Alert recipient', value: e.alerts.recipientConfigured ? 'Configured' : 'Not configured' },
    ];
    var alertWarn = !e.alerts.recipientConfigured ? [{ text: 'No alert recipient is configured: security alerts cannot reach the owner.' }]
      : !e.alerts.dispatcherRunning ? [{ text: 'The security alert dispatcher is not running in this instance.' }] : [];

    return '<div class="cs-evhead">' + chip(e.state, 'cs-chip--lg')
      + (e.why ? '<span class="cs-evhead-why">' + esc(T(e.why)) + '</span>' : '<span class="cs-evhead-why">' + esc(T('Counted from the security event log and the Data Fabric. Never who, from where, or what was sent.')) + '</span>')
      + '</div>'
      + '<div class="cs-figs cs-figs--4">'
      + tile('Security events, last 24 hours', e.total24h)
      + tile('Critical, last 24 hours', e.critical24h)
      + tile('Warnings, last 24 hours', e.warning24h)
      + tile('Security events, last 7 days', e.total7d)
      + '</div>'
      + '<div class="cs-dgrid">'
      + '<div class="cs-dcol">'
      + panel('Security events by kind', '<div class="cs-tbl cs-tbl--kinds" role="table">'
        + '<div class="cs-tr cs-tr--head" role="row"><span role="columnheader">' + esc(T('Event')) + '</span><span role="columnheader">' + esc(T('24 h')) + '</span><span role="columnheader">' + esc(T('7 days')) + '</span><span role="columnheader">' + esc(T('Critical')) + '</span></div>'
        + e.kinds.map(function (k) {
          return '<div class="cs-tr" role="row"><span role="cell" class="cs-tname">' + esc(T(k.label)) + ' <code data-no-i18n>' + esc(k.kind) + '</code></span>'
            + '<span role="cell" data-no-i18n>' + cell(k.count24h) + '</span><span role="cell" data-no-i18n>' + cell(k.count7d) + '</span>'
            + '<span role="cell" data-no-i18n>' + cell(k.critical24h) + '</span></div>';
        }).join('') + '</div>', T('A measured zero is shown as 0.'))
      + '</div>'
      + '<div class="cs-dcol">'
      + panel('Alert delivery', configHtml(alertCfg) + warningsHtml(alertWarn)
        + '<div class="cs-note">' + esc(T('The recipient address is never shown here.')) + '</div>')
      + panel('Security signals', signalsHtml({ state: e.state, why: null, kinds: [], signals: e.signals }),
        T('Declared in the Security Event Schema; a signal no collector produces says so.'))
      + '</div></div>';
  }

  // ── EVIDENCE — where every figure comes from ──────────────────────────────

  function evidenceHtml() {
    var d = CS.data;
    var gen = fmtInstant(d.generatedAt);
    var meas = fmtInstant(d.measuredAt);
    var start = fmtInstant(d.instance.startedAt);
    var src = function (title, file, what) {
      return '<div class="cs-src"><div class="cs-src-t">' + esc(T(title)) + '</div>'
        + (file ? '<code class="cs-src-f" data-no-i18n>' + esc(file) + '</code>' : '')
        + '<div class="cs-src-d">' + esc(T(what)) + '</div></div>';
    };
    return '<div class="cs-dgrid">'
      + '<div class="cs-dcol">'
      + panel('Where this comes from', '<div class="cs-kv">'
        + kv(T('Security evidence generated'), gen ? gen.utc : '—')
        + kv(T('Generator'), d.posture ? d.posture.generator : '—')
        + kv(T('Live layer measured'), meas ? meas.utc : '—')
        + kv(T('This instance started'), start ? start.utc : '—')
        + kv(T('Hours this instance has been watching'), num(d.instance.uptimeHours))
        + '</div>', T('Build evidence changes only with a reviewed commit; the live layer is read on request.'))
      + panel('Evidence sources', '<div class="cs-srcs">'
        + src('Coverage map', 'src/cyber-defense/coverage-map.json', 'The trust boundaries, their coverage and controls, and every discovered component mapped onto them. CI fails when a component is unmapped.')
        + src('Security manifest', 'src/cyber-defense/generated/security-manifest.json', 'Each control’s measured status and the file that proves it, regenerated from the repository and checked in CI.')
        + src('Posture policy', 'src/cyber-defense/posture-policy.json', 'The required controls, the known gaps, the RLS pilot tables and the named cross-club paths — each a reviewed decision.')
        + src('Runtime records', null, 'Counts and times from the security event log, Data Fabric security signals, device security events, AI calls and approvals, the security audit chain, backup records, administrator MFA enrolment and the database’s RLS switch.')
        + src('This instance', null, 'Collector counters, the alert dispatcher, the RLS context mode and the queries seen without a context — since this instance started.')
        + '</div>')
      + '</div>'
      + '<div class="cs-dcol">'
      + panel('What this screen never shows', '<ul class="cs-never">'
        + '<li>' + esc(T('No secret, key, token or password — not even its length.')) + '</li>'
        + '<li>' + esc(T('No environment value or connection string; a setting is reported only as on, off or configured.')) + '</li>'
        + '<li>' + esc(T('No IP address, user, club or row identifier.')) + '</li>'
        + '<li>' + esc(T('No query, request body or anything a user typed.')) + '</li>'
        + '</ul>', T('Owner-only, read-only, and never cached by the browser.'))
      + panel('How to read a state', '<div class="cs-meanings">'
        + ['PROTECTED', 'PARTIAL', 'OBSERVING', 'AT_RISK', 'UNKNOWN', 'LIVE', 'WARNING', 'NOT_INSTRUMENTED', 'NOT_APPLICABLE', 'UNAVAILABLE'].map(function (s) {
          return '<div class="cs-meaning">' + chip(s, 'cs-chip--sm') + '<span>' + esc(T(STATE_MEANING[s])) + '</span></div>';
        }).join('') + '</div>')
      + '</div></div>';
  }

  // ── the inspector — one area, without leaving the map ─────────────────────

  function inspectorHtml() {
    var a = CS.inspect ? areaOf(CS.inspect) : null;
    if (!a) return '';
    var group = (CS.data.groups || []).filter(function (g) { return g.id === a.group; })[0];
    var rows = (CS.data.boundaries || []).filter(function (b) { return a.rows.indexOf(b.id) >= 0; });
    var api = a.api;
    var authzOrder = [['roles', 'Limited to named roles'], ['scoped', 'Scoped to a resource'], ['member', 'Open to any club member'], ['platform-owner', 'Platform owner only'], ['public', 'Public, reviewed']];
    return '<div class="cs-insp-scrim" data-cs-close-insp></div>'
      + '<aside class="cs-insp" role="dialog" aria-modal="true" aria-labelledby="cs-insp-title" dir="' + CS_DIR + '" lang="' + CS_LANG + '">'
      + '<div class="cs-insp-head"><div><div class="cs-insp-title" id="cs-insp-title">' + esc(T(a.title)) + '</div>'
      + '<div class="cs-insp-sub">' + esc(group ? T(group.title) : '') + '</div></div>'
      + '<button class="cs-insp-x" type="button" data-cs-close-insp aria-label="Close">×</button></div>'
      + '<div class="cs-insp-body">'
      + '<div class="cs-insp-state">' + chip(a.state, 'cs-chip--lg') + '<span class="cs-insp-sum">'
      + esc(a.gaps.length ? tf('%d of %d boundaries are not fully covered.', a.gaps.length, a.rows.length) : T('Every boundary this area depends on is fully covered.'))
      + '</span></div>'
      + (a.note ? '<div class="cs-note">' + esc(T(a.note)) + '</div>' : '')
      + (a.gaps.length ? '<div class="cs-insp-sec">' + esc(T('Why it is not fully protected')) + '</div>' + a.gaps.map(function (g) {
        return '<div class="cs-gaprow"><div class="cs-row-head"><span class="cs-row-id" data-no-i18n>#' + esc(g.id) + '</span><span class="cs-row-name">' + esc(T(g.name)) + '</span>'
          + '<span class="cs-chip cs-chip--sm cs-chip--' + stateKind(g.coverage) + '"><span class="cs-dot" aria-hidden="true"></span>' + esc(coverageLabel(g.coverage)) + '</span></div>'
          + quote(g.reason, 'Why it is not fully covered, as recorded') + quote(g.plannedIn, 'What closes it, as recorded') + '</div>';
      }).join('') : '')
      + '<div class="cs-insp-sec">' + esc(T('Protected by')) + '</div>'
      + '<div class="cs-chips">' + a.domains.map(function (id) {
        var dm = domainOf(id);
        return dm ? '<button class="cs-dchip cs-dchip--' + stateKind(dm.state) + '" type="button" data-cs-open-domain="' + esc(id) + '"><span class="cs-dot" aria-hidden="true"></span>' + esc(T(dm.title)) + '</button>' : '';
      }).join('') + '</div>'
      + '<div class="cs-insp-sec">' + esc(T('Trust boundaries')) + '</div>'
      + '<div class="cs-chips">' + rows.map(function (b) {
        return '<span class="cs-btag cs-btag--' + stateKind(b.coverage) + '" title="' + esc(coverageLabel(b.coverage)) + '"><b data-no-i18n>#' + esc(b.id) + '</b> ' + esc(T(b.name)) + '</span>';
      }).join('') + '</div>'
      + (api ? '<div class="cs-insp-sec">' + esc(T('API surface')) + '</div>'
        + '<div class="cs-kv">'
        + kv(T('Routers'), num(api.routers))
        + kv(T('Handlers'), num(api.handlers))
        + kv(T('Public handlers'), num(api.publicHandlers))
        + kv(T('Routers authenticated as a whole'), num(api.routerWideAuth))
        + authzOrder.filter(function (k) { return has(api.authz[k[0]]); }).map(function (k) { return kv(T(k[1]), num(api.authz[k[0]])); }).join('')
        + kv(T('Route ids checked against the caller’s club'), num(api.tenancy.guarded))
        + kv(T('Exempt by review'), num(api.tenancy.exempt))
        + kv(T('Unguarded'), num(api.tenancy.unguarded))
        + '</div>' : '')
      + (a.routers.length ? '<div class="cs-insp-sec">' + esc(T('Routers')) + '</div><div class="cs-chips">'
        + a.routers.map(function (r) { return '<span class="cs-token" data-no-i18n>' + esc(r) + '</span>'; }).join('') + '</div>' : '')
      + '</div>'
      + '<div class="cs-insp-foot">' + esc(T('From the coverage map and the security manifest. Read-only.')) + '</div>'
      + '</aside>';
  }

  // ── content ───────────────────────────────────────────────────────────────

  function contentHtml() {
    if (CS.error && !CS.data) {
      return emptyState('The Cybersecurity Command Center could not be read', CS.error);
    }
    if (!CS.data) return overviewSkeleton();
    if (CS.data.state === 'NOT_GENERATED') {
      return emptyState('Security evidence has not been generated', T(CS.data.reason || ''))
        + '<div class="cs-notice"><code data-no-i18n>npm run security:discover</code></div>';
    }
    switch (CS.section) {
      case 'domains': return domainsHtml();
      case 'domain': return domainHtml();
      case 'rls': return rlsHtml();
      case 'lifecycle': return lifecycleHtml();
      case 'coverage': return coverageHtml();
      case 'events': return eventsHtml();
      case 'evidence': return evidenceHtml();
      default: return overviewHtml();
    }
  }

  /** The shape of the overview, before the answer arrives. */
  function overviewSkeleton() {
    return '<div class="cs-skel-hero" aria-hidden="true"></div>'
      + '<div class="cs-skel-legend" aria-hidden="true"></div>'
      + panel('Needs attention', skeleton(3, 'attention'))
      + panel('Platform security map', '<div class="cs-skel-map" aria-hidden="true"></div>');
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
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open the Cybersecurity Command Center.'));
      if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
      return r.json();
    }).then(function (b) { return (b && b.data) || b; });
  }

  /**
   * The fields this screen cannot draw without.
   *
   * The same last line Infrastructure City and Source Core keep: if a payload
   * reaches a browser without them the module SAYS SO rather than drawing
   * itself empty. Absence only — a present-but-empty array is a real answer
   * about a real platform and is never reported as a fault.
   */
  var REQUIRED = {
    overview: ['state', 'measuredAt', 'instance', 'groups', 'domains', 'areas', 'events'],
    domain: ['controlList', 'rowList', 'recentEvents', 'recentSignals'],
  };

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

  function loadOverview() {
    return api('/system/cybersecurity').then(function (d) {
      var missing = missingFields(d, REQUIRED.overview);
      if (missing.length) { CS.data = null; CS.error = contractError('/system/cybersecurity', missing); return; }
      if (d.state === 'READY' && (!d.posture || !d.rls || !d.boundaries || !d.lifecycle || !d.unassignedRouters)) {
        CS.data = null;
        CS.error = contractError('/system/cybersecurity', ['posture', 'rls', 'boundaries', 'lifecycle', 'unassignedRouters']
          .filter(function (k) { return d[k] === undefined || d[k] === null; }));
        return;
      }
      CS.data = d; CS.error = null;
      if (CS.lens && !domainOf(CS.lens)) CS.lens = null;
    }).catch(function (e) { CS.error = e.message; });
  }

  function loadDomain(id) {
    CS.detailError = null;
    return api('/system/cybersecurity/domains/' + encodeURIComponent(id)).then(function (d) {
      var missing = missingFields(d, REQUIRED.domain);
      if (missing.length) { CS.detail = null; CS.detailError = contractError('/system/cybersecurity/domains/' + id, missing); return; }
      CS.detail = d;
    }).catch(function (e) { CS.detail = null; CS.detailError = e.message; });
  }

  // ── paint ─────────────────────────────────────────────────────────────────

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', CS_DIR);
    host.setAttribute('lang', CS_LANG);
    host.innerHTML = '<div class="cs-shell">'
      + railHtml()
      + '<main class="cs-main">' + topHtml()
      + '<div class="cs-body" id="cs-body">' + contentHtml() + '</div></main>'
      + '</div>';
    try { csTranslate(host); } catch (_) {}
    syncInspector(host);
    afterPaint(host);
  }

  /** Repaint what changed: the body, the top bar and the rail state — never the shell. */
  function repaintBody(host, keepScroll) {
    var body = host.querySelector('#cs-body');
    if (!body) return paint(host);
    var y = keepScroll ? body.scrollTop : 0;
    body.innerHTML = contentHtml();
    body.scrollTop = y;
    try { csTranslate(body); } catch (_) {}
    var top = host.querySelector('.cs-top');
    if (top) { top.outerHTML = topHtml(); try { csTranslate(host.querySelector('.cs-top')); } catch (_) {} }
    var rail = host.querySelector('.cs-rail');
    if (rail) { rail.outerHTML = railHtml(); try { csTranslate(host.querySelector('.cs-rail')); } catch (_) {} }
    syncInspector(host);
    afterPaint(host);
  }

  function afterPaint(host) {
    // Wires are measured from the laid-out page, so they are drawn once the
    // browser has placed everything — never guessed from the markup.
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { applyFocus(host); });
  }

  /** The inspector is added and removed on its own; the page under it never moves. */
  function syncInspector(host) {
    var old = host.querySelector('.cs-insp');
    var scrim = host.querySelector('.cs-insp-scrim');
    if (old) old.remove();
    if (scrim) scrim.remove();
    if (!CS.inspect || !CS.data) return;
    host.insertAdjacentHTML('beforeend', inspectorHtml());
    try { csTranslate(host.querySelector('.cs-insp')); } catch (_) {}
  }

  function openInspector(host, id, from) {
    CS.inspect = id;
    CS.inspectFrom = from || null;
    syncInspector(host);
    var x = host.querySelector('.cs-insp-x');
    if (x) try { x.focus(); } catch (_) {}
  }
  function closeInspector(host) {
    var back = CS.inspectFrom;
    CS.inspect = null; CS.inspectFrom = null;
    syncInspector(host);
    if (back) {
      var el = host.querySelector('[data-cs-area="' + cssId(back) + '"]');
      if (el) try { el.focus(); } catch (_) {}
    }
  }

  function go(host, section) {
    CS.section = section;
    CS.inspect = null;
    CS.preview = null;
    repaintBody(host, false);
  }

  function openDomain(host, id) {
    CS.section = 'domain';
    CS.domainId = id;
    CS.inspect = null;
    CS.preview = null;
    if (!CS.detail || CS.detail.id !== id) CS.detail = null;
    CS.detailError = null;
    repaintBody(host, false);
    loadDomain(id).then(function () {
      if (CS.section === 'domain' && CS.domainId === id) repaintBody(host, true);
    });
  }

  function refresh(host) {
    if (CS.refreshing) return;
    CS.refreshing = true;
    repaintBody(host, true);
    var jobs = [loadOverview()];
    if (CS.section === 'domain' && CS.domainId) jobs.push(loadDomain(CS.domainId));
    Promise.all(jobs).then(function () { CS.refreshing = false; repaintBody(host, true); });
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__csBound) return;
    host.__csBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      if (t.closest('[data-cs-home]')) { try { window.navTo('owner-home'); } catch (_) {} return; }

      if (t.closest('[data-cs-langs]')) {
        CS.langOpen = !CS.langOpen;
        var box = host.querySelector('.cs-langs');
        if (box) box.classList.toggle('is-open', CS.langOpen);
        var pick = host.querySelector('[data-cs-langs]');
        if (pick) pick.setAttribute('aria-expanded', CS.langOpen ? 'true' : 'false');
        return;
      }
      var lang = t.closest('[data-cs-lang]');
      if (lang) {
        CS.langOpen = false;
        setLocale(lang.getAttribute('data-cs-lang')).then(function () {
          var body = host.querySelector('#cs-body');
          var y = body ? body.scrollTop : 0;
          paint(host);
          var again = host.querySelector('#cs-body');
          if (again) again.scrollTop = y;
        });
        return;
      }
      if (CS.langOpen && !t.closest('.cs-langs')) {
        CS.langOpen = false;
        var open = host.querySelector('.cs-langs');
        if (open) open.classList.remove('is-open');
      }

      if (t.closest('[data-cs-close-insp]')) { closeInspector(host); return; }

      var od = t.closest('[data-cs-open-domain]');
      if (od) { openDomain(host, od.getAttribute('data-cs-open-domain')); return; }

      var nav = t.closest('[data-cs-nav]');
      if (nav) { go(host, nav.getAttribute('data-cs-nav')); return; }

      if (t.closest('[data-cs-refresh]')) { refresh(host); return; }

      var dom = t.closest('[data-cs-dom]');
      if (dom) {
        var id = dom.getAttribute('data-cs-dom');
        CS.lens = CS.lens === id ? null : id;
        CS.preview = null;
        var bar = host.querySelector('[data-cs-lens]');
        if (bar) { bar.outerHTML = lensBarHtml(); try { csTranslate(host.querySelector('[data-cs-lens]')); } catch (_) {} }
        applyFocus(host);
        return;
      }
      if (t.closest('[data-cs-lens-clear]')) {
        CS.lens = null; CS.preview = null;
        var lb = host.querySelector('[data-cs-lens]');
        if (lb) { lb.outerHTML = lensBarHtml(); try { csTranslate(host.querySelector('[data-cs-lens]')); } catch (_) {} }
        applyFocus(host);
        return;
      }

      var area = t.closest('[data-cs-area]');
      if (area) { openInspector(host, area.getAttribute('data-cs-area'), area.getAttribute('data-cs-area')); return; }

      var f = t.closest('[data-cs-filter]');
      if (f) { CS.rowFilter = f.getAttribute('data-cs-filter'); repaintBody(host, true); return; }
    });

    // Pointing previews; it never re-lays anything out.
    var point = function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var inMap = t.closest('[data-cs-map]');
      var d = inMap ? t.closest('[data-cs-dom]') : null;
      var a = inMap ? t.closest('[data-cs-area]') : null;
      var next = d ? { kind: 'domain', id: d.getAttribute('data-cs-dom') } : a ? { kind: 'area', id: a.getAttribute('data-cs-area') } : null;
      // A locked lens is the reader's choice; pointing does not override it.
      if (CS.lens) next = null;
      var same = (!next && !CS.preview) || (next && CS.preview && next.kind === CS.preview.kind && next.id === CS.preview.id);
      if (same) return;
      CS.preview = next;
      applyFocus(host);
    };
    host.addEventListener('mouseover', point);
    host.addEventListener('focusin', point);
    host.addEventListener('mouseleave', function () { if (CS.preview) { CS.preview = null; applyFocus(host); } });

    host.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (CS.inspect) { closeInspector(host); return; }
      if (CS.langOpen) { CS.langOpen = false; var b = host.querySelector('.cs-langs'); if (b) b.classList.remove('is-open'); return; }
      if (CS.lens) {
        CS.lens = null; CS.preview = null;
        var lb = host.querySelector('[data-cs-lens]');
        if (lb) { lb.outerHTML = lensBarHtml(); try { csTranslate(host.querySelector('[data-cs-lens]')); } catch (_) {} }
        applyFocus(host);
      }
    });
  }

  var resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () {
      resizeQueued = false;
      if (!document.body.classList.contains('cs-cyber-open')) return;
      var host = document.getElementById('cs-root');
      if (host) drawWires(host);
    });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaCybersecurity = function (host) {
    // The page-render registry calls every renderer with NO argument, and the
    // navigation switch calls this one with the root element. Both must work.
    host = host || document.getElementById('cs-root');
    if (!host) return;
    bind(host);
    if (!window.__csResizeBound) { window.__csResizeBound = true; window.addEventListener('resize', onResize); }
    setLocale(initialLocale()).then(function () {
      paint(host);
      return loadOverview();
    }).then(function () { paint(host); });
  };

  window.teardownFamilistaCybersecurity = function () {
    // No stream or timer of its own. The open inspector and the pointing state
    // are dropped so the room opens clean next time.
    CS.inspect = null; CS.inspectFrom = null; CS.preview = null; CS.langOpen = false;
  };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaCybersecurityStateKind = stateKind;
}());
