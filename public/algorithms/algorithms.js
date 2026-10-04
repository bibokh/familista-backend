/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA ALGORITHMS — the eighth room

   EVERY NUMBER THE PLATFORM COMPUTES, AND WHO LET IT

   Expected goals, training load, the load and attrition indices, medical risk,
   eligibility, the kickoff window: each is an algorithm somebody acts on. This
   room lists every one of them, the domain it belongs to, its version, what
   goes in and what comes out, how it behaves on fixed synthetic scenarios
   right now, and the human approval it runs under.

   THE CONTINUOUS INTELLIGENCE LOOP

     Observe → Learn → Propose → Simulate → Test → Human approval → Deploy
             → Measure → Learn

   Deploy is reachable only from Human approval, and an approval names the
   exact version and the exact code. Where each algorithm stands on the loop is
   derived on the server from evidence; this module draws it and decides
   nothing.

   READ/ANALYZE-ONLY

   There is no button here that changes an algorithm, a weight or a setting,
   and there must never be one: an algorithm changes only through a reviewed
   pull request that records the owner's approval, released by the CI-gated
   deploy.

   PRODUCTION MONITORING (Step 2)

   How each algorithm really ran in production — runs, failures, latency, the
   shape of its outputs, the code that was running — in five states and no
   others: Healthy, Warning, Failing, Not enough data, Not instrumented. Green
   is drawn only for what was measured; a finding is evidence for a person and
   changes nothing.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var AL = {
    data: null,
    error: null,
    section: 'overview',
    key: null,
    detail: null,
    detailError: null,
    langOpen: false,
    refreshing: false,
    mon: null,
    monError: null,
    monDetail: null,
    monDetailError: null,
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
    try { return n.toLocaleString(AL_LANG); } catch (_) { return String(n); }
  }
  function has(v) { return v !== null && v !== undefined; }

  function absent(why) {
    return '<span class="al-none" title="' + esc(why || '') + '">—</span>';
  }

  function fmtInstant(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var local;
    try {
      local = new Intl.DateTimeFormat(AL_LANG, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    } catch (_) { local = d.toISOString().replace('T', ' ').slice(0, 16); }
    return { local: local, utc: d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
  }

  function instantHtml(iso, why) {
    var at = fmtInstant(iso);
    if (!at) return absent(why || T('Not recorded yet.'));
    return '<time class="al-at" datetime="' + esc(iso) + '" title="' + esc(at.utc) + '" data-no-i18n>' + esc(at.local) + '</time>';
  }

  /** A fingerprint is shown short, and whole on hover. */
  function fp(hex) {
    if (!hex) return absent(T('Not available on this server.'));
    return '<code class="al-fp" title="' + esc(hex) + '" data-no-i18n>' + esc(hex.slice(0, 12)) + '…</code>';
  }

  // ── localisation ──────────────────────────────────────────────────────────
  //
  // This room's own three-language catalogue, behind `data-no-i18n` on the page
  // root — the boundary every owner room keeps, so these strings never enter
  // the club product's locale files. Registry keys, versions, file paths,
  // symbols and fingerprints are identifiers and are never translated.

  var AL_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var AL_DICT = {};
  var AL_LANG = 'en';
  var AL_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < AL_LOCALES.length; i++) if (AL_LOCALES[i][0] === tag) return AL_LOCALES[i];
    return AL_LOCALES[0];
  }
  function initialLocale() {
    try {
      var v = localStorage.getItem('familista_algorithms_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { AL_DICT = {}; return Promise.resolve(); }
    return fetch('/algorithms/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { AL_DICT = d || {}; })
      .catch(function () { AL_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    AL_LANG = l[0]; AL_DIR = l[2];
    try { localStorage.setItem('familista_algorithms_locale', AL_LANG); } catch (_) {}
    return loadDict(AL_LANG);
  }

  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || AL_LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(AL_DICT, s) ? AL_DICT[s] : s;
  }
  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var i = 0;
    return T(key).replace(/%d/g, function () { var v = args[i++]; return v == null ? '—' : num(v); });
  }

  function languageSwitchHtml() {
    var active = localeOf(AL_LANG);
    return '<div class="al-langs' + (AL.langOpen ? ' is-open' : '') + '">'
      + '<button class="al-lang-pick" type="button" data-al-langs'
      + ' aria-expanded="' + (AL.langOpen ? 'true' : 'false') + '" aria-label="' + esc(T('Algorithms language')) + '">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="al-lang-ch" aria-hidden="true">⌄</span></button>'
      + '<div class="al-lang-menu" role="group">'
      + AL_LOCALES.map(function (l) {
        return '<button class="al-lang' + (l[0] === AL_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-al-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === AL_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // These functions are the only place a state becomes a colour. Green: the
  // algorithm runs exactly what a person approved, or a check passed. Amber:
  // waiting for a person. Red: a check failed, or a mode no approval can
  // allow. Dotted grey: not simulated — never to be read as passing.

  function gateKind(g) {
    switch (g) {
      case 'APPROVED': return 'ok';
      case 'EVALUATION_FAILED': case 'MODE_NOT_ALLOWED': return 'crit';
      case 'NO_APPROVAL': case 'VERSION_NOT_APPROVED': case 'CHANGED_SINCE_APPROVAL': case 'FINGERPRINT_UNAVAILABLE': return 'warn';
      default: return 'unknown';
    }
  }
  var GATE_LABEL = {
    APPROVED: 'Approved',
    NO_APPROVAL: 'No approval',
    VERSION_NOT_APPROVED: 'Version not approved',
    CHANGED_SINCE_APPROVAL: 'Changed since approval',
    FINGERPRINT_UNAVAILABLE: 'Code not readable',
    EVALUATION_FAILED: 'Evaluation failed',
    MODE_NOT_ALLOWED: 'Mode not allowed',
  };
  var GATE_MEANING = {
    APPROVED: 'Runs exactly the version and the code its approval names.',
    NO_APPROVAL: 'No human approval is recorded for it.',
    VERSION_NOT_APPROVED: 'Its version is not the version that was approved.',
    CHANGED_SINCE_APPROVAL: 'Its code changed after it was approved.',
    FINGERPRINT_UNAVAILABLE: 'The fingerprint of its code is not available on this server.',
    EVALUATION_FAILED: 'It failed at least one of its own checks.',
    MODE_NOT_ALLOWED: 'It is set to act, and only read/analyze is allowed.',
  };
  function evalKind(s) { return s === 'PASS' ? 'ok' : s === 'FAIL' ? 'crit' : 'none'; }
  var EVAL_LABEL = { PASS: 'Passing', FAIL: 'Failing', NOT_SIMULATED: 'Not simulated' };

  var STAGE_LABEL = {
    OBSERVE: 'Observe', LEARN: 'Learn', PROPOSE: 'Propose', SIMULATE: 'Simulate', TEST: 'Test',
    HUMAN_APPROVAL: 'Human approval', DEPLOY: 'Deploy', MEASURE: 'Measure',
  };

  function chip(kind, label, title, extra) {
    return '<span class="al-chip al-chip--' + kind + (extra ? ' ' + extra : '') + '"'
      + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<span class="al-dot" aria-hidden="true"></span>' + esc(label) + '</span>';
  }
  function gateChip(g, extra) { return chip(gateKind(g), T(GATE_LABEL[g] || g), T(GATE_MEANING[g] || ''), extra); }
  function evalChip(e, extra) {
    var label = e.state === 'NOT_SIMULATED' ? T(EVAL_LABEL.NOT_SIMULATED) : T(EVAL_LABEL[e.state]) + ' · ' + num(e.passed) + '/' + num(e.total);
    return chip(evalKind(e.state), label, '', extra);
  }
  function stageTag(s) { return '<span class="al-stage-tag">' + esc(T(STAGE_LABEL[s] || s)) + '</span>'; }

  // ── the production vocabulary (Step 2) ────────────────────────────────────
  //
  // Five states, and the colour of each is a fact: green only for an
  // algorithm measured in production with every check passing; amber for
  // evidence a person should look at; red for something proven wrong; dotted
  // grey for "not enough runs to say" and "does not run in production" —
  // never to be read as healthy.

  function monKind(s) {
    switch (s) {
      case 'HEALTHY': return 'ok';
      case 'WARNING': return 'warn';
      case 'FAILING': return 'crit';
      case 'NOT_ENOUGH_DATA': return 'none';
      case 'NOT_INSTRUMENTED': return 'off';
      default: return 'unknown';
    }
  }
  var MON_LABEL = {
    HEALTHY: 'Healthy',
    WARNING: 'Warning',
    FAILING: 'Failing',
    NOT_ENOUGH_DATA: 'Not enough data',
    NOT_INSTRUMENTED: 'Not instrumented',
  };
  var MON_MEANING = {
    HEALTHY: 'Measured in production with enough runs, and every check passes.',
    WARNING: 'Production evidence a person should look at.',
    FAILING: 'Something is proven wrong: the code, its evaluation, its outputs or repeated failures.',
    NOT_ENOUGH_DATA: 'Instrumented, but too few production runs to call it anything yet.',
    NOT_INSTRUMENTED: 'It does not run in production, so there is nothing to measure.',
  };
  var MON_ORDER = ['FAILING', 'WARNING', 'HEALTHY', 'NOT_ENOUGH_DATA', 'NOT_INSTRUMENTED'];
  var FINDING_LABEL = {
    FINGERPRINT_MISMATCH: 'The running code is not the approved code',
    FINGERPRINT_UNVERIFIED: 'The running code could not be proven',
    EVALUATION_FAILED: 'Its evaluation fails in this server',
    CONTRACT_VIOLATIONS: 'An output broke its declared contract',
    REPEATED_FAILURES: 'Repeated failures',
    FAILURES: 'A production run failed',
    STALE: 'No production run for a week',
    NO_EXECUTIONS: 'No production run recorded yet',
    DISTRIBUTION_SHIFT: 'Its outputs shifted against their baseline',
    LATENCY_REGRESSION: 'It became slower than its baseline',
  };
  var VERDICT_LABEL = { MATCH: 'Approved code', MISMATCH: 'Not the approved code', UNVERIFIED: 'Not proven' };
  function verdictKind(v) { return v === 'MATCH' ? 'ok' : v === 'MISMATCH' ? 'crit' : 'warn'; }
  var REASON_LABEL = {
    OK: 'The running code is the code the approval names.',
    NOT_APPROVED: 'The loaded source is not the approved source.',
    CHANGED_AFTER_BUILD: 'The loaded file is not what the build compiled.',
    BUILD_NOT_APPROVED: 'This build was compiled from source that was not approved.',
    SEAL_MISSING: 'The build seal is missing beside the server, so nothing can be proven.',
    UNREADABLE: 'The loaded file could not be read.',
  };
  var BASIS_LABEL = { SOURCE: 'TypeScript source', COMPILED: 'Compiled build' };
  var STORE_LABEL = { OK: 'Writing', IDLE: 'Idle', FAILING: 'Write failing', NOT_STARTED: 'Not started in this server' };
  function storeKind(s) { return s === 'OK' ? 'ok' : s === 'FAILING' ? 'crit' : s === 'IDLE' ? 'info' : 'none'; }
  var CHECK_STATE = { PASS: ['ok', '✓'], WARN: ['warn', '!'], FAIL: ['crit', '✕'], NOT_ENOUGH_DATA: ['none', '·'], NOT_APPLICABLE: ['none', '–'] };
  var CHECK_STATE_LABEL = { PASS: 'Passing', WARN: 'Warning', FAIL: 'Failing', NOT_ENOUGH_DATA: 'Not enough data', NOT_APPLICABLE: 'Not applicable' };
  var KIND_LABEL = { REQUEST: 'Request', WORKER: 'Background worker' };

  function monChip(st, extra) { return chip(monKind(st), T(MON_LABEL[st] || st), T(MON_MEANING[st] || ''), extra); }
  function verdictChip(v, extra) { return chip(verdictKind(v), T(VERDICT_LABEL[v] || v), '', extra); }

  /** A duration in microseconds, as the room shows it. Data, not prose. */
  function dur(us) {
    if (typeof us !== 'number' || !isFinite(us)) return '—';
    if (us >= 1000000) return num(+(us / 1000000).toFixed(2)) + ' s';
    if (us >= 1000) return num(+(us / 1000).toFixed(1)) + ' ms';
    return num(us) + ' µs';
  }
  function atMost(us) { return typeof us === 'number' && isFinite(us) ? '≤ ' + dur(us) : '—'; }
  function pct(part, whole) { return whole ? num(+(100 * part / whole).toFixed(1)) + '%' : '—'; }
  /** A share as one of 21 width classes: the stylesheet draws it, never an inline style. */
  function wClass(part, whole) { return 'al-w-' + (whole ? Math.max(0, Math.min(20, Math.round(20 * part / whole))) : 0); }

  // ── the frame ─────────────────────────────────────────────────────────────

  var SECTIONS = [
    ['overview', 'Overview', '◎', 'COMMAND'],
    ['registry', 'Registry', '☰', 'COMMAND'],
    ['loop', 'Intelligence Loop', '↻', 'COMMAND'],
    ['evaluation', 'Evaluation', '✓', 'EVIDENCE'],
    ['approvals', 'Approvals & Audit', '◆', 'EVIDENCE'],
    ['monitoring', 'Monitoring', '∿', 'EVIDENCE'],
  ];
  var GROUP_ORDER = ['COMMAND', 'EVIDENCE'];
  var GROUP_LABEL = { COMMAND: 'Command', EVIDENCE: 'Evidence' };

  function algorithms() { return (AL.data && AL.data.algorithms) || []; }
  function domains() { return (AL.data && AL.data.domains) || []; }
  function domainTitle(id) {
    var d = domains().filter(function (x) { return x.id === id; })[0];
    return d ? T(d.title) : id;
  }
  function algorithmName(key) {
    var a = algorithms().filter(function (x) { return x.key === key; })[0];
    return a ? T(a.name) : key;
  }

  function railBadge(id) {
    var t = AL.data && AL.data.totals;
    if (!t) return '';
    var n = 0, kind = 'warn';
    if (id === 'registry') n = t.registered - t.approved;
    if (id === 'evaluation' && t.failing) { n = t.failing; kind = 'crit'; }
    if (id === 'monitoring' && AL.mon && AL.mon.states) {
      if (AL.mon.states.FAILING) { n = AL.mon.states.FAILING; kind = 'crit'; }
      else n = AL.mon.states.WARNING;
    }
    if (!n) return '';
    return '<span class="al-rail-badge al-rail-badge--' + kind + '" data-no-i18n>' + esc(num(n)) + '</span>';
  }

  function markSvg(size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" focusable="false" aria-hidden="true">'
      + '<path d="M12 3.6a8.4 8.4 0 1 1-7.5 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      + '<path d="M4.3 4.4v4h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.5"/>'
      + '</svg>';
  }

  function railHtml() {
    var current = AL.section === 'algorithm' ? 'registry' : AL.section;
    var groups = GROUP_ORDER.map(function (g) {
      return '<div class="al-rail-group"><div class="al-rail-label">' + esc(T(GROUP_LABEL[g])) + '</div>'
        + SECTIONS.filter(function (s) { return s[3] === g; }).map(function (s) {
          var on = current === s[0];
          return '<button class="al-rail-item' + (on ? ' is-on' : '') + '" type="button" data-al-nav="' + s[0] + '"'
            + (on ? ' aria-current="page"' : '') + '>'
            + '<span class="al-rail-icon" aria-hidden="true">' + s[2] + '</span>'
            + '<span class="al-rail-text">' + esc(T(s[1])) + '</span>' + railBadge(s[0]) + '</button>';
        }).join('') + '</div>';
    }).join('');
    return '<nav class="al-rail" aria-label="' + esc(T('Algorithms')) + '">'
      + '<div class="al-rail-head">'
      + '<button class="al-rail-home" type="button" data-al-home aria-label="' + esc(T('Back to Familista home')) + '">'
      + '<span aria-hidden="true">←</span><span data-no-i18n>Familista</span></button>'
      + '<div class="al-rail-brand"><span class="al-rail-mark" aria-hidden="true">' + markSvg(18) + '</span>'
      + '<span class="al-rail-title">' + esc(T('Algorithms')) + '</span></div>'
      + '</div>'
      + '<div class="al-rail-body">' + groups + '</div>'
      + '<div class="al-rail-foot">' + footHtml() + '</div>'
      + '</nav>';
  }

  function footHtml() {
    var d = AL.data;
    if (!d && AL.error) return '<div class="al-foot">' + chip('off', T('Unavailable')) + '</div>';
    if (!d) return '<div class="al-foot">' + chip('unknown', T('Reading evidence…')) + '</div>';
    var at = fmtInstant(d.measuredAt);
    return '<div class="al-foot">' + chip('info', T('Read/analyze only'), T('No algorithm can change from this room.'))
      + (at ? '<span class="al-foot-at" data-no-i18n title="' + esc(at.utc) + '">' + esc(at.local) + '</span>' : '')
      + '</div>';
  }

  function titleOf() {
    if (AL.section === 'algorithm') return algorithmName(AL.key);
    return T((SECTIONS.filter(function (s) { return s[0] === AL.section; })[0] || [null, 'Overview'])[1]);
  }

  function topHtml() {
    return '<header class="al-top">'
      + '<div class="al-top-l"><div class="al-top-eyebrow" data-no-i18n>FAMILISTA · ALGORITHMS</div>'
      + '<h1 class="al-top-title">' + esc(titleOf()) + '</h1></div>'
      + '<div class="al-top-r">'
      + '<button class="al-btn" type="button" data-al-refresh' + (AL.refreshing ? ' aria-busy="true" disabled' : '') + '>'
      + '<span aria-hidden="true">↻</span><span>' + esc(AL.refreshing ? T('Reading…') : T('Refresh')) + '</span></button>'
      + languageSwitchHtml()
      + '</div></header>';
  }

  function panel(title, body, note, cls) {
    return '<section class="al-panel' + (cls ? ' ' + cls : '') + '">'
      + (title ? '<div class="al-panel-head"><h2 class="al-panel-title">' + esc(T(title)) + '</h2>'
        + (note ? '<span class="al-panel-note">' + esc(note) + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }

  function emptyState(title, detail) {
    return '<div class="al-empty"><div class="al-empty-mark" aria-hidden="true">∅</div>'
      + '<div class="al-empty-title">' + esc(T(title)) + '</div>'
      + (detail ? '<div class="al-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  /** The skeleton is the size of what it stands in for. Heights are classes: CSP refuses inline styles. */
  function skeleton(n, size) {
    var rows = '';
    for (var i = 0; i < n; i++) rows += '<div class="al-skel-row al-skel-row--' + size + '"></div>';
    return '<div class="al-skel" aria-hidden="true">' + rows + '</div>';
  }

  function kv(k, v) {
    return '<div class="al-kv-row"><span>' + esc(k) + '</span><b>' + v + '</b></div>';
  }

  // ── OVERVIEW ──────────────────────────────────────────────────────────────

  function figure(value, label, kind) {
    return '<div class="al-fig' + (kind ? ' al-fig--' + kind : '') + '">'
      + '<div class="al-fig-v" data-no-i18n>' + value + '</div>'
      + '<div class="al-fig-l">' + esc(label) + '</div></div>';
  }

  function overviewHtml() {
    var d = AL.data, t = d.totals;
    var waiting = t.registered - t.approved;
    var hero = '<section class="al-hero">'
      + '<div class="al-hero-id"><span class="al-hero-mark" aria-hidden="true">' + markSvg(30) + '</span>'
      + '<div><div class="al-hero-k">' + esc(T('Continuous Intelligence Loop')) + '</div>'
      + '<div class="al-hero-t">' + esc(t.failing ? tf('%d algorithms are failing their own checks.', t.failing)
        : waiting ? tf('%d algorithms are waiting for a human approval.', waiting)
          : T('Every algorithm runs exactly the version a person approved.')) + '</div>'
      + '<div class="al-hero-s">' + esc(T('Read/analyze only. Nothing in this room changes an algorithm; a change reaches production only through a reviewed pull request that records the owner’s approval.')) + '</div>'
      + '</div></div>'
      + '<div class="al-figs">'
      + figure(esc(num(t.registered)), T('Algorithms registered'))
      + figure(esc(num(t.approved)) + '<small> / ' + esc(num(t.registered)) + '</small>', T('Running an approved version'), t.approved === t.registered ? 'ok' : 'warn')
      + figure(esc(num(t.checksPassed)) + '<small> / ' + esc(num(t.checks)) + '</small>', T('Evaluation checks passing'), t.checksPassed === t.checks ? 'ok' : 'crit')
      + figure(esc(num(t.registered - t.simulated)), T('Not simulated'), t.registered - t.simulated ? 'none' : '')
      + '</div></section>';

    var guarantees = panel('What this room guarantees', '<ul class="al-guar">' + d.guarantees.map(function (g) {
      return '<li class="al-guar-i">' + chip(g.holds ? 'ok' : 'crit', g.holds ? T('Holds') : T('Broken'), '', 'al-chip--sm')
        + '<span class="al-guar-t">' + esc(T(g.text)) + '</span>'
        + '<span class="al-guar-b">' + esc(g.basis === 'RUNTIME' ? T('Checked now') : T('Pinned at build')) + '</span></li>';
    }).join('') + '</ul>');

    var strip = panel('The loop', '<ol class="al-strip">' + d.loop.map(function (s) {
      return '<li class="al-strip-i' + (s.who === 'HUMAN' ? ' al-strip-i--human' : '') + '">'
        + '<span class="al-strip-n" data-no-i18n>' + esc(num(s.algorithms)) + '</span>'
        + '<span class="al-strip-t">' + esc(T(s.title)) + '</span></li>';
    }).join('') + '</ol>', T('Algorithms at each stage'));

    var byDomain = '<div class="al-dgrid">' + domains().map(function (dm) {
      var list = algorithms().filter(function (a) { return a.domain === dm.id; });
      return '<section class="al-panel al-dcard"><div class="al-dcard-h"><h2 class="al-panel-title">' + esc(T(dm.title)) + '</h2>'
        + '<span class="al-panel-note">' + esc(tf('%d algorithms', list.length)) + '</span></div>'
        + '<p class="al-dcard-d">' + esc(T(dm.describes)) + '</p>'
        + (list.length ? '<div class="al-dcard-l">' + list.map(function (a) {
          return '<button class="al-mini" type="button" data-al-open="' + esc(a.key) + '">'
            + '<span class="al-dot al-dot--' + gateKind(a.gate) + '" aria-hidden="true"></span>'
            + '<span class="al-mini-n">' + esc(T(a.name)) + '</span>'
            + '<span class="al-mini-v" data-no-i18n>' + esc(a.version) + '</span></button>';
        }).join('') + '</div>' : emptyState('No algorithm is registered in this domain yet', T('An algorithm joins a domain when it is added to the registry with its source, version and approval.')))
        + '</section>';
    }).join('') + '</div>';

    return hero + guarantees + strip + byDomain;
  }

  // ── REGISTRY ──────────────────────────────────────────────────────────────

  function registryHtml() {
    var list = algorithms();
    if (!list.length) return panel('Registry', emptyState('No algorithm is registered', T('Add an algorithm to src/algorithms/registry.ts with its source, version and approval.')));
    return '<div class="al-intro">' + esc(T('Every algorithm whose output somebody acts on. Open one for its inputs, outputs, source, fingerprint, approval and scenarios.')) + '</div>'
      + domains().map(function (dm) {
        var rows = list.filter(function (a) { return a.domain === dm.id; });
        if (!rows.length) return '';
        return panel(dm.title, '<div class="al-tbl" role="table">'
          + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
          + '<span role="columnheader">' + esc(T('Version')) + '</span><span role="columnheader">' + esc(T('Stage')) + '</span>'
          + '<span role="columnheader">' + esc(T('Approval')) + '</span><span role="columnheader">' + esc(T('Evaluation')) + '</span></div>'
          + rows.map(function (a) {
            return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
              + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b><code data-no-i18n>' + esc(a.key) + '</code></span>'
              + '<span role="cell"><code data-no-i18n>' + esc(a.version) + '</code></span>'
              + '<span role="cell">' + stageTag(a.stage) + '</span>'
              + '<span role="cell">' + gateChip(a.gate, 'al-chip--sm') + '</span>'
              + '<span role="cell">' + evalChip(a.evaluation, 'al-chip--sm') + '</span></button>';
          }).join('') + '</div>', tf('%d algorithms', rows.length));
      }).join('');
  }

  // ── THE LOOP ──────────────────────────────────────────────────────────────

  function loopHtml() {
    var d = AL.data;
    return '<div class="al-intro">' + esc(T('Every algorithm moves around one loop. Where each one stands is derived from evidence, never set by hand. Deploy is reachable only from Human approval.')) + '</div>'
      + '<ol class="al-loop">' + d.loop.map(function (s, i) {
        var next = s.next.map(function (n) { return T(STAGE_LABEL[n] || n); }).join(' · ');
        return '<li class="al-stage' + (s.who === 'HUMAN' ? ' al-stage--human' : '') + (s.id === 'HUMAN_APPROVAL' ? ' al-stage--gate' : '') + '">'
          + '<div class="al-stage-h"><span class="al-stage-n" data-no-i18n>' + esc('0' + (i + 1)) + '</span>'
          + '<span class="al-stage-who">' + esc(s.who === 'HUMAN' ? T('A person') : T('The platform')) + '</span></div>'
          + '<div class="al-stage-t">' + esc(T(s.title)) + '</div>'
          + '<div class="al-stage-d">' + esc(T(s.describes)) + '</div>'
          + '<div class="al-stage-f"><span><b data-no-i18n>' + esc(num(s.algorithms)) + '</b> ' + esc(T('here now')) + '</span>'
          + loopEvidence(s.id)
          + '<span class="al-stage-next">' + esc(T('Next')) + ': ' + esc(next) + '</span></div></li>';
      }).join('') + '</ol>'
      + panel('The approval gate', '<ol class="al-gate">'
        + '<li><b>' + esc(T('Only read/analyze')) + '</b><span>' + esc(T('An algorithm set to act is refused before anything else is looked at. No approval can allow it in Step 1.')) + '</span></li>'
        + '<li><b>' + esc(T('The exact version')) + '</b><span>' + esc(T('An approval of one version does not approve the next.')) + '</span></li>'
        + '<li><b>' + esc(T('The exact code')) + '</b><span>' + esc(T('The approval names a fingerprint of the algorithm’s source. One more edit and it no longer matches.')) + '</span></li>'
        + '<li><b>' + esc(T('Its own checks')) + '</b><span>' + esc(T('An algorithm failing its scenarios goes back to Test, whatever its approval says.')) + '</span></li>'
        + '<li><b>' + esc(T('A reviewed change')) + '</b><span>' + esc(T('The approval is recorded in the registry, which is code-owned: the edit that records it is itself reviewed. CI fails while any algorithm’s code differs from its approval.')) + '</span></li>'
        + '</ol>');
  }

  /**
   * What production evidence says at Measure, and what it hands to Learn.
   * Drawn only from the monitoring read; absent until it has answered.
   */
  function loopEvidence(stage) {
    var L = AL.mon && AL.mon.loop;
    if (!L) return '';
    if (stage === 'MEASURE') {
      return '<span class="al-stage-ev">' + esc(tf('%d measured in production · %d not instrumented', L.measured, L.notInstrumented)) + '</span>'
        + '<span class="al-stage-ev">' + esc(tf('%d healthy · %d warning · %d failing · %d not enough data', L.healthy, L.warning, L.failing, L.notEnoughData)) + '</span>';
    }
    if (stage === 'LEARN') {
      return '<span class="al-stage-ev">' + esc(tf('%d with production findings for a person', L.withFindings)) + '</span>';
    }
    return '';
  }

  // ── EVALUATION ────────────────────────────────────────────────────────────

  function evaluationHtml() {
    var list = algorithms();
    var simulated = list.filter(function (a) { return a.evaluation.state !== 'NOT_SIMULATED'; });
    var notSim = list.filter(function (a) { return a.evaluation.state === 'NOT_SIMULATED'; });
    return '<div class="al-intro">' + esc(T('Each algorithm runs on fixed synthetic scenarios, in this server, and is checked against the properties it must keep. No club, player or match data is read.')) + '</div>'
      + panel('Simulated', simulated.length ? '<div class="al-evl">' + simulated.map(function (a) {
        return '<button class="al-evl-i" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span class="al-evl-n">' + esc(T(a.name)) + '</span>'
          + evalChip(a.evaluation, 'al-chip--sm') + '</button>';
      }).join('') + '</div>' : emptyState('No algorithm has a scenario yet', T('A scenario runs the real function on synthetic inputs and checks what comes back.')),
      tf('%d algorithms', simulated.length))
      + panel('Not simulated', notSim.length ? '<div class="al-evl">' + notSim.map(function (a) {
        return '<button class="al-evl-i" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span class="al-evl-n">' + esc(T(a.name)) + '</span>' + evalChip(a.evaluation, 'al-chip--sm') + '</button>';
      }).join('') + '</div><div class="al-note">' + esc(T('Each one says why on its own page. Not simulated is never read as passing.')) + '</div>'
        : emptyState('Every registered algorithm has scenarios', ''), tf('%d algorithms', notSim.length));
  }

  // ── APPROVALS & AUDIT ─────────────────────────────────────────────────────

  function approvalsHtml() {
    var list = algorithms();
    return '<div class="al-intro">' + esc(T('The approval each algorithm runs under, and whether its code still matches it. A baseline approval records an algorithm exactly as it already ran in production when the registry was created; it takes effect when the platform owner merges the pull request that introduces it.')) + '</div>'
      + panel('Approvals', '<div class="al-tbl al-tbl--appr" role="table">'
        + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
        + '<span role="columnheader">' + esc(T('Approved version')) + '</span><span role="columnheader">' + esc(T('Kind')) + '</span>'
        + '<span role="columnheader">' + esc(T('Gate')) + '</span></div>'
        + list.map(function (a) {
          return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
            + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b></span>'
            + '<span role="cell">' + (a.approval ? '<code data-no-i18n>' + esc(a.approval.version) + '</code>' : absent(T('No approval recorded.'))) + '</span>'
            + '<span role="cell">' + (a.approval ? esc(a.approval.kind === 'BASELINE' ? T('Baseline') : T('Change')) : absent(T('No approval recorded.'))) + '</span>'
            + '<span role="cell">' + gateChip(a.gate, 'al-chip--sm') + '</span></button>';
        }).join('') + '</div>')
      + panel('Where the evidence lives', '<div class="al-kv">'
        + kv(T('Approval record'), '<code data-no-i18n>src/algorithms/registry.ts</code>')
        + kv(T('Code fingerprints'), '<code data-no-i18n>src/algorithms/generated/algorithm-manifest.json</code>')
        + kv(T('The loop and its gate'), '<code data-no-i18n>src/algorithms/loop.ts</code>')
        + kv(T('CI gate'), '<code data-no-i18n>tests/algorithms.unit.test.ts</code>')
        + kv(T('Cybersecurity control'), '<code data-no-i18n>algorithm-change-gate</code>')
        + '</div><div class="al-note">' + esc(T('Every approval is a change to a code-owned file, so it is reviewed and kept in the repository history with the pull request that carried it.')) + '</div>');
  }

  // ── MONITORING ────────────────────────────────────────────────────────────

  function evaluationRunsPanel() {
    var m = AL.data.monitoring;
    if (!m) return '';
    return panel('Synthetic evaluation in this server', '<div class="al-figs al-figs--4">'
      + figure(esc(num(m.evaluationRuns)), T('Evaluation runs since start'))
      + figure(esc(num(m.failingRuns)), T('Runs with a failing check'), m.failingRuns ? 'crit' : 'ok')
      + figure(has(m.lastDurationMs) ? esc(num(m.lastDurationMs)) + '<small> ms</small>' : absent(T('Not run yet.')), T('Last run took'))
      + figure(instantHtml(m.lastRunAt), T('Last run'))
      + '</div><div class="al-note">' + esc(T('This server re-runs every scenario when the room is read, at most once a minute, and keeps its own record of the runs since it started.')) + '</div>');
  }

  function monitoringSkeleton() {
    return '<div class="al-figs" aria-hidden="true">' + [0, 1, 2, 3].map(function () { return '<div class="al-skel-row al-skel-row--fig"></div>'; }).join('') + '</div>'
      + panel('Algorithms in production', skeleton(6, 'port'));
  }

  function monitoringHtml() {
    var intro = '<div class="al-intro">' + esc(T('How each algorithm really runs in production: how often, from which workflow, whether it failed, how long it took, what its outputs looked like and which code was running. Five states and no others; green only for what was measured. A finding is evidence for a person — nothing here changes an algorithm.')) + '</div>';
    if (AL.monError && !AL.mon) return intro + panel('', emptyState('Production monitoring could not be read', AL.monError)) + evaluationRunsPanel();
    var M = AL.mon;
    if (!M) return intro + monitoringSkeleton() + evaluationRunsPanel();

    var notice = M.state === 'STORE_UNAVAILABLE'
      ? '<div class="al-banner al-banner--warn" role="status">' + esc(T(M.reason || 'The telemetry store could not be read. Figures below are this server’s own unwritten runs only, and nothing reads as healthy.')) + '</div>' : '';

    var cov = M.coverage, tot = M.totals, rt = M.runtime;
    var figs = '<div class="al-figs">'
      + figure(esc(num(cov.instrumented)) + '<small> / ' + esc(num(cov.registered)) + '</small>', T('Algorithms measured in production'), cov.instrumented === cov.registered ? 'ok' : '')
      + figure(esc(num(tot.executions24h)), T('Production runs, last 24 hours'))
      + figure(esc(num(tot.failures24h)), T('Failed runs, last 24 hours'), tot.failures24h ? 'crit' : (tot.executions24h ? 'ok' : 'none'))
      + figure(esc(num(rt.verified)) + '<small> / ' + esc(num(cov.registered)) + '</small>', T('Running the approved code'), rt.mismatched ? 'crit' : rt.unverified ? 'warn' : 'ok')
      + '</div>';

    var states = panel('Production state', '<div class="al-mstates">' + MON_ORDER.map(function (st) {
      return '<div class="al-mstate al-mstate--' + monKind(st) + '">'
        + '<span class="al-mstate-n" data-no-i18n>' + esc(num(M.states[st])) + '</span>'
        + '<span class="al-mstate-l">' + esc(T(MON_LABEL[st])) + '</span>'
        + '<span class="al-mstate-d">' + esc(T(MON_MEANING[st])) + '</span></div>';
    }).join('') + '</div>', tot.lastExecutionAt ? T('Last production run') + ': ' + (fmtInstant(tot.lastExecutionAt) || {}).local : T('No production run recorded yet'));

    var rows = M.algorithms.slice().sort(function (a, b) { return MON_ORDER.indexOf(a.state) - MON_ORDER.indexOf(b.state); });
    var table = panel('Algorithms in production', '<div class="al-tbl al-tbl--mon" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
      + '<span role="columnheader">' + esc(T('State')) + '</span>'
      + '<span role="columnheader">' + esc(T('Runs · 7 days')) + '</span>'
      + '<span role="columnheader">' + esc(T('Failures · 7 days')) + '</span>'
      + '<span role="columnheader">' + esc(T('Latency p95')) + '</span>'
      + '<span role="columnheader">' + esc(T('Last run')) + '</span>'
      + '<span role="columnheader">' + esc(T('Code')) + '</span></div>'
      + rows.map(function (a) {
        return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b><code data-no-i18n>' + esc(a.key) + '</code></span>'
          + '<span role="cell">' + monChip(a.state, 'al-chip--sm') + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + (a.instrumented ? esc(num(a.executions7d)) : '—') + '</span>'
          + '<span role="cell" class="al-num' + (a.failures7d ? ' al-num--crit' : '') + '" data-no-i18n>' + (a.instrumented ? esc(num(a.failures7d)) : '—') + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(atMost(a.p95AtMostUs)) + '</span>'
          + '<span role="cell">' + (a.instrumented ? instantHtml(a.lastExecutionAt, T('No production run recorded yet')) : absent(T('It does not run in production.'))) + '</span>'
          + '<span role="cell">' + verdictChip(a.runtimeCode, 'al-chip--sm') + '</span></button>';
      }).join('') + '</div>', tf('%d of %d algorithms instrumented', cov.instrumented, cov.registered));

    var st = M.store;
    var code = panel('The code that is running', '<div class="al-kv">'
      + kv(T('Read from'), esc(T(BASIS_LABEL[rt.basis] || rt.basis)))
      + kv(T('Proven approved'), '<span class="al-val" data-no-i18n>' + esc(num(rt.verified)) + ' / ' + esc(num(cov.registered)) + '</span>')
      + kv(T('Not the approved code'), '<span class="al-val" data-no-i18n>' + esc(num(rt.mismatched)) + '</span>')
      + kv(T('Not proven'), '<span class="al-val" data-no-i18n>' + esc(num(rt.unverified)) + '</span>')
      + kv(T('Fingerprinted at'), instantHtml(rt.computedAt))
      + kv(T('Took'), '<span class="al-val" data-no-i18n>' + esc(num(rt.durationMs)) + ' ms</span>')
      + '</div><div class="al-note">' + esc(T('At start, this server fingerprints the file it loaded for every algorithm. Compiled, it must match the seal its build wrote, and that seal must name the approved source.')) + '</div>');
    var store = panel('Telemetry store', '<div class="al-kv">'
      + kv(T('State'), chip(storeKind(st.state), T(STORE_LABEL[st.state] || st.state), '', 'al-chip--sm'))
      + kv(T('Last write'), instantHtml(st.lastFlushAt, T('Nothing written by this server yet.')))
      + kv(T('Last write failure'), st.lastFlushFailure ? '<code data-no-i18n>' + esc(st.lastFlushFailure) + '</code>' : absent(T('None.')))
      + kv(T('Waiting to be written'), '<span class="al-val" data-no-i18n>' + esc(num(st.pendingEntries)) + '</span>')
      + kv(T('Runs dropped'), '<span class="al-val" data-no-i18n>' + esc(num(st.droppedRuns)) + '</span>')
      + kv(T('Writes every'), '<span class="al-val" data-no-i18n>' + esc(num(st.flushIntervalSeconds)) + ' s</span>')
      + '</div><div class="al-note">' + esc(T('Counts, histograms and times only — never a player, a club, a user, an input or a message. Each server writes its own runs once a minute, and only when something ran.')) + '</div>');

    var th = M.thresholds;
    var how = panel('How it is measured', '<ul class="al-rules">'
      + rule(tf('Current figures cover the last %d days; drift and latency compare them with the %d days before.', th.recentDays, th.baselineDays))
      + rule(tf('Healthy needs at least %d production runs in the window and every check passing.', th.minHealthySample))
      + rule(tf('Failing: %d or more failures in %d hours, or any output outside its declared contract, or code that is not the approved code.', th.repeatedFailures, th.failureWindowHours))
      + rule(tf('Warning: any failure, no run for %d days, or a population stability index of 0.25 or more against the baseline.', th.staleAfterDays))
      + rule(tf('A distribution is compared only with at least %d recent and %d baseline outputs.', th.minDriftRecent, th.minDriftBaseline))
      + rule(tf('Telemetry is kept %d days, then deleted.', th.retentionDays))
      + '</ul><div class="al-note">' + esc(T('These thresholds decide what this room reports. No algorithm reads them, and nothing here changes an algorithm.')) + '</div>');

    return intro + notice + figs + states + table + '<div class="al-dgrid">' + code + store + '</div>' + how + evaluationRunsPanel();
  }

  function rule(text) { return '<li>' + esc(text) + '</li>'; }

  // ── one algorithm, in production ──────────────────────────────────────────

  // compact: for a half-width panel, where observed and required sit beneath
  // the label instead of squeezing it into a narrow column.
  function checksHtml(checks, compact) {
    return '<ul class="al-checks' + (compact ? ' al-checks--compact' : '') + '">' + checks.map(function (c) {
      var k = CHECK_STATE[c.state] || ['none', '·'];
      return '<li class="al-check al-check--' + k[0] + '">'
        + '<span class="al-check-m" aria-hidden="true">' + k[1] + '</span>'
        + '<span class="al-check-l">' + esc(T(c.label)) + ' <span class="al-check-s">' + esc(T(CHECK_STATE_LABEL[c.state] || c.state)) + '</span></span>'
        + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Observed')) + '</span><code data-no-i18n>' + esc(c.observed) + '</code></span>'
        + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Required')) + '</span><code data-no-i18n>' + esc(c.required) + '</code></span>'
        + '</li>';
    }).join('') + '</ul>';
  }

  function distributionHtml(d) {
    if (!d) return '';
    var rt = d.recent.reduce(function (s, v) { return s + v; }, 0);
    var bt = d.baseline.reduce(function (s, v) { return s + v; }, 0);
    if (!rt && !bt) return panel('Output distribution', emptyState('No output recorded in production yet', T('Every production output is counted into these bins as it is produced.')));
    return panel('Output distribution', '<div class="al-dist">'
      + '<div class="al-dist-legend"><span class="al-key al-key--recent"></span>' + esc(tf('Last %d days', AL.mon ? AL.mon.thresholds.recentDays : 7)) + ' · <span data-no-i18n>' + esc(num(rt)) + '</span>'
      + '<span class="al-key al-key--base"></span>' + esc(tf('The %d days before', AL.mon ? AL.mon.thresholds.baselineDays : 28)) + ' · <span data-no-i18n>' + esc(num(bt)) + '</span></div>'
      + d.labels.map(function (label, i) {
        return '<div class="al-dist-row">'
          + '<code class="al-dist-l" data-no-i18n>' + esc(label) + '</code>'
          + '<div class="al-dist-bars">'
          + '<div class="al-bar"><div class="al-bar-fill al-bar-fill--recent ' + wClass(d.recent[i], rt) + '"></div></div>'
          + '<div class="al-bar al-bar--thin"><div class="al-bar-fill al-bar-fill--base ' + wClass(d.baseline[i], bt) + '"></div></div>'
          + '</div>'
          + '<span class="al-dist-v" data-no-i18n>' + esc(pct(d.recent[i], rt)) + '</span>'
          + '<span class="al-dist-v al-dist-v--base" data-no-i18n>' + esc(pct(d.baseline[i], bt)) + '</span>'
          + '</div>';
      }).join('') + '</div>'
      + '<div class="al-note">' + esc(d.psi === null
        ? T('Not compared yet: a distribution is compared with its baseline only once both windows hold enough outputs.')
        : T('Population stability index against the baseline: %s (a shift is reported from 0.25).').replace('%s', String(d.psi))) + '</div>',
      T(d.name));
  }

  function dailyHtml(days) {
    var max = days.reduce(function (m, d) { return Math.max(m, d.executions); }, 0);
    return '<div class="al-days" role="img" aria-label="' + esc(T('Production runs per day, last 14 days')) + '">' + days.map(function (d) {
      var h = max ? Math.max(d.executions ? 1 : 0, Math.round(10 * d.executions / max)) : 0;
      return '<div class="al-day" title="' + esc(d.day + ' · ' + num(d.executions) + (d.failures ? ' · ✕ ' + num(d.failures) : '')) + '">'
        + '<div class="al-day-col"><div class="al-day-bar al-h-' + h + (d.failures ? ' al-day-bar--fail' : '') + '"></div></div>'
        + '<span class="al-day-d" data-no-i18n>' + esc(d.day.slice(8)) + '</span></div>';
    }).join('') + '</div>';
  }

  function productionHtml() {
    var det = AL.monDetail;
    if (AL.monDetailError) return panel('In production', emptyState('Production monitoring could not be read', AL.monDetailError));
    if (!det || det.key !== AL.key) return panel('In production', skeleton(5, 'check'));

    var head = '<div class="al-prod-h">' + monChip(det.state)
      + (det.findingList.length ? '<span class="al-chips">' + det.findingList.map(function (f) {
        return chip(f.severity === 'FAILING' ? 'crit' : f.severity === 'WARNING' ? 'warn' : 'none', T(FINDING_LABEL[f.id] || f.id), '', 'al-chip--sm');
      }).join('') + '</span>' : '')
      + '</div>';
    var store = det.storeState === 'STORE_UNAVAILABLE'
      ? '<div class="al-banner al-banner--warn" role="status">' + esc(T('The telemetry store could not be read. Figures below are this server’s own unwritten runs only, and nothing reads as healthy.')) + '</div>' : '';

    var rf = det.fingerprint;
    var codePanel = panel('The code that is running', '<div class="al-kv">'
      + kv(T('Verdict'), verdictChip(rf.verdict, 'al-chip--sm'))
      + kv(T('Why'), esc(T(REASON_LABEL[rf.reason] || rf.reason)))
      + kv(T('Read from'), esc(T(BASIS_LABEL[rf.basis] || rf.basis)))
      + kv(T('Loaded file'), '<code data-no-i18n>' + esc(rf.file) + '</code>')
      + kv(T('Code approved'), fp(rf.approved))
      + kv(T('Code running'), fp(rf.source))
      + kv(T('Loaded file fingerprint'), fp(rf.runtime))
      + '</div><div class="al-note">' + esc(T('“Code running” is the source fingerprint the loaded code is proven to be. It must equal the approved one.')) + '</div>');

    if (!det.instrumented) {
      return head + store + panel('Why it is not measured', '<p class="al-reason">' + esc(T(det.coverage.reason || '')) + '</p>'
        + '<div class="al-kv">'
        + kv(T('Evidence in the repository'), '<span class="al-chips">' + det.coverage.evidence.map(function (f) { return '<code class="al-token" data-no-i18n>' + esc(f) + '</code>'; }).join('') + '</span>')
        + '</div><div class="al-note">' + esc(T('CI re-proves this on every pull request: if this algorithm gains a production caller, the build fails until that caller is measured.')) + '</div>')
        + '<div class="al-dgrid">' + codePanel + panel('Checks', checksHtml(det.checks, true)) + '</div>';
    }

    var c = det.counts;
    var lat = det.latency.recent;
    var figs = '<div class="al-figs">'
      + figure(esc(num(c.recent.executions)), T('Production runs, last 7 days'))
      + figure(esc(num(c.recent.failures)), T('Failed runs, last 7 days'), c.recent.failures ? 'crit' : (c.recent.executions ? 'ok' : 'none'))
      + figure(esc(num(c.recent.outOfContract)) + '<small> / ' + esc(num(c.recent.outputs)) + '</small>', T('Outputs outside their contract'), c.recent.outOfContract ? 'crit' : (c.recent.outputs ? 'ok' : 'none'))
      + figure(instantHtml(det.lastExecutionAt, T('No production run recorded yet')), T('Last production run'))
      + '</div>';

    var activity = panel('Activity', dailyHtml(det.daily)
      + '<div class="al-kv al-kv--tight">'
      + kv(T('Runs, last 24 hours'), '<span class="al-val" data-no-i18n>' + esc(num(c.last24h.executions)) + ' · ✕ ' + esc(num(c.last24h.failures)) + '</span>')
      + kv(T('Runs kept'), '<span class="al-val" data-no-i18n>' + esc(num(c.retained.executions)) + ' · ✕ ' + esc(num(c.retained.failures)) + '</span>')
      + kv(T('First seen'), instantHtml(det.firstSeenAt, T('No production run recorded yet')))
      + kv(T('Last failure'), det.lastFailureAt ? instantHtml(det.lastFailureAt) + ' <code data-no-i18n>' + esc(det.lastFailureKind || '') + '</code>' : absent(T('None.')))
      + '</div>');

    var latency = panel('Latency', lat ? '<div class="al-kv">'
      + kv(T('Mean'), '<span class="al-val" data-no-i18n>' + esc(dur(lat.meanUs)) + '</span>')
      + kv(T('Half of runs within'), '<span class="al-val" data-no-i18n>' + esc(atMost(lat.p50AtMostUs)) + '</span>')
      + kv(T('95% of runs within'), '<span class="al-val" data-no-i18n>' + esc(atMost(lat.p95AtMostUs)) + '</span>')
      + kv(T('Slowest run'), '<span class="al-val" data-no-i18n>' + esc(dur(lat.maxUs)) + '</span>')
      + kv(T('Baseline, 95% within'), det.latency.baseline ? '<span class="al-val" data-no-i18n>' + esc(atMost(det.latency.baseline.p95AtMostUs)) + '</span>' : absent(T('No baseline yet.')))
      + '</div><div class="al-note">' + esc(T('Measured around the algorithm call itself. Percentiles are read from fixed bins, so each is an upper bound.')) + '</div>'
      : emptyState('No production run recorded yet', T('Latency appears with the first measured run.')));

    var quality = det.quality || det.freshness ? panel('Input quality', (det.quality ? '<div class="al-kv">'
        + kv(T('OK'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.ok)) + '</span>')
        + kv(T('Partial'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.partial)) + '</span>')
        + kv(T('Empty'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.empty)) + '</span>')
        + kv(T('Not assessed'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.notAssessed)) + '</span>')
        + '</div><div class="al-note">' + esc(T(det.quality.describes)) + '</div>' : '')
      + (det.freshness ? '<div class="al-kv al-kv--sep">'
        + kv(T('Fresh'), '<span class="al-val" data-no-i18n>' + esc(num(det.freshness.fresh)) + '</span>')
        + kv(T('Stale'), '<span class="al-val" data-no-i18n>' + esc(num(det.freshness.stale)) + '</span>')
        + kv(T('Not assessed'), '<span class="al-val" data-no-i18n>' + esc(num(det.freshness.notAssessed)) + '</span>')
        + '</div><div class="al-note">' + esc(T(det.freshness.describes)) + '</div>' : ''), T('Last 7 days'))
      : panel('Input quality', emptyState('Not assessed for this algorithm', T('Its call sites cannot see the quality of its inputs without reading more data than the algorithm itself does.')));

    var flows = panel('Where it runs', '<div class="al-flows">' + det.bySource.map(function (f) {
      return '<div class="al-flow">'
        + '<div class="al-flow-h"><code data-no-i18n>' + esc(f.source) + '</code><span class="al-stage-tag">' + esc(T(KIND_LABEL[f.kind] || f.kind)) + '</span></div>'
        + '<code class="al-flow-e" data-no-i18n>' + esc(f.entry) + '</code>'
        + '<div class="al-flow-f"><span data-no-i18n>' + esc(num(f.executions7d)) + ' · ✕ ' + esc(num(f.failures7d)) + '</span>'
        + instantHtml(f.lastAt, T('No production run recorded yet')) + '</div></div>';
    }).join('') + '</div>', T('Last 7 days'));

    var fps = panel('Code fingerprints seen in production', det.fingerprintsSeen.length ? '<ul class="al-fps">' + det.fingerprintsSeen.map(function (f) {
      return '<li>' + fp(f.fingerprint === 'unavailable' ? null : f.fingerprint) + '<code data-no-i18n>' + esc(f.version) + '</code>'
        + (f.approved ? chip('ok', T('Approved'), '', 'al-chip--sm') : chip('crit', T('Not approved'), '', 'al-chip--sm'))
        + (f.current ? chip('info', T('Running now'), '', 'al-chip--sm') : '')
        + '<span class="al-num" data-no-i18n>' + esc(num(f.executions)) + '</span>' + instantHtml(f.lastAt) + '</li>';
    }).join('') + '</ul>' : emptyState('No production run recorded yet', T('Each run is recorded under the fingerprint of the code that ran it.')));

    return head + store + figs
      + panel('Checks', checksHtml(det.checks), T('Evidence only — a finding changes nothing.'))
      + distributionHtml(det.distribution)
      + '<div class="al-dgrid">' + activity + latency + '</div>'
      + '<div class="al-dgrid">' + quality + flows + '</div>'
      + '<div class="al-dgrid">' + codePanel + fps + '</div>';
  }

  // ── ONE ALGORITHM ─────────────────────────────────────────────────────────

  function ports(list) {
    if (!list.length) return emptyState('None declared', '');
    return '<ul class="al-ports">' + list.map(function (p) {
      return '<li><span>' + esc(T(p.name)) + '</span>' + (p.unit ? '<em>' + esc(T(p.unit)) + '</em>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function scenariosHtml(det) {
    if (!det.scenarios.length) {
      return emptyState('Not simulated', det.notSimulatedBecause ? T(det.notSimulatedBecause) : '');
    }
    return det.scenarios.map(function (s) {
      return '<div class="al-scn">'
        + '<div class="al-scn-h"><span class="al-scn-t">' + esc(T(s.title)) + '</span>'
        + chip(s.pass ? 'ok' : 'crit', s.pass ? T('Passing') : T('Failing'), '', 'al-chip--sm') + '</div>'
        + '<ul class="al-checks">' + s.checks.map(function (c) {
          return '<li class="al-check al-check--' + (c.pass ? 'ok' : 'crit') + '">'
            + '<span class="al-check-m" aria-hidden="true">' + (c.pass ? '✓' : '✕') + '</span>'
            + '<span class="al-check-l">' + esc(T(c.label)) + '</span>'
            + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Observed')) + '</span><code data-no-i18n>' + esc(c.observed) + '</code></span>'
            + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Required')) + '</span><code data-no-i18n>' + esc(c.expected) + '</code></span>'
            + '</li>';
        }).join('') + '</ul></div>';
    }).join('');
  }

  function algorithmHtml() {
    var head = '<button class="al-back" type="button" data-al-nav="registry"><span aria-hidden="true">←</span> ' + esc(T('Registry')) + '</button>';
    if (AL.detailError) return head + panel('', emptyState('This algorithm could not be read', AL.detailError));
    var det = AL.detail;
    if (!det || det.key !== AL.key) {
      return head + '<div class="al-skel-hero al-skel-hero--sm" aria-hidden="true"></div>'
        + panel('In production', skeleton(5, 'check'))
        + '<div class="al-dgrid">' + panel('Inputs', skeleton(4, 'port')) + panel('Outputs', skeleton(4, 'port')) + '</div>'
        + panel('Scenarios', skeleton(3, 'check'));
    }
    var a = det.approval;
    return head
      + '<section class="al-ahead">'
      + '<div class="al-ahead-l"><div class="al-ahead-k">' + esc(domainTitle(det.domain)) + '</div>'
      + '<p class="al-ahead-s">' + esc(T(det.summary)) + '</p>'
      + '<div class="al-chips">' + gateChip(det.gate) + evalChip(det.evaluation) + stageTag(det.stage)
      + chip('info', T('Read/analyze only')) + '</div></div>'
      + '<div class="al-kv al-ahead-r">'
      + kv(T('Version'), '<code data-no-i18n>' + esc(det.version) + '</code>')
      + kv(T('Key'), '<code data-no-i18n>' + esc(det.key) + '</code>')
      + kv(T('Used by'), esc(det.usedBy.map(T).join(' · ')))
      + kv(T('Built on'), det.dependsOn.length ? det.dependsOn.map(function (k) {
        return '<button class="al-link" type="button" data-al-open="' + esc(k) + '">' + esc(algorithmName(k)) + '</button>';
      }).join(' ') : esc(T('Nothing else')))
      + '</div></section>'
      + '<h2 class="al-sec">' + esc(T('In production')) + '</h2>'
      + productionHtml()
      + '<h2 class="al-sec">' + esc(T('Definition and approval')) + '</h2>'
      + '<div class="al-dgrid">' + panel('Inputs', ports(det.inputs)) + panel('Outputs', ports(det.outputs)) + '</div>'
      + panel('Scenarios', scenariosHtml(det), det.scenarios.length ? tf('%d of %d checks passing', det.evaluation.passed, det.evaluation.total) : '')
      + '<div class="al-dgrid">'
      + panel('Approval', a ? '<div class="al-kv">'
        + kv(T('Kind'), esc(a.kind === 'BASELINE' ? T('Baseline') : T('Change')))
        + kv(T('Approved version'), '<code data-no-i18n>' + esc(a.version) + '</code>')
        + kv(T('Approved by'), esc(T('Platform owner')))
        + kv(T('Recorded in'), '<span data-no-i18n>' + esc(a.reference) + '</span>')
        + kv(T('Date'), '<span data-no-i18n>' + esc(a.approvedAt) + '</span>')
        + '</div>' : emptyState('No approval is recorded', T('Until the platform owner approves a version, the algorithm stays at Observe.')))
      + panel('Source & fingerprint', '<div class="al-kv">'
        + kv(T('File'), '<code data-no-i18n>' + esc(det.source.file) + '</code>')
        + kv(T('Declarations'), '<span class="al-chips">' + det.source.symbols.map(function (s) { return '<code class="al-token" data-no-i18n>' + esc(s) + '</code>'; }).join('') + '</span>')
        + kv(T('Code now'), fp(det.fingerprint.current))
        + kv(T('Code approved'), fp(det.fingerprint.approved))
        + kv(T('Match'), det.fingerprint.matches ? chip('ok', T('Identical'), '', 'al-chip--sm') : chip('warn', T('Different'), '', 'al-chip--sm'))
        + '</div><div class="al-note">' + esc(T('The fingerprint covers the declarations listed, with comments and whitespace ignored — rewording a comment is not a change to an algorithm.')) + '</div>')
      + '</div>'
      + '<div class="al-dgrid">'
      + panel('Versions', '<ol class="al-vers">' + det.versions.map(function (v) {
        return '<li><code data-no-i18n>' + esc(v.version) + '</code><span data-no-i18n class="al-vers-d">' + esc(v.date) + '</span><span>' + esc(T(v.note)) + '</span></li>';
      }).join('') + '</ol>')
      + panel('Tests', det.tests.length ? '<div class="al-chips">' + det.tests.map(function (t) { return '<code class="al-token" data-no-i18n>' + esc(t) + '</code>'; }).join('') + '</div>'
        + '<div class="al-note">' + esc(T('Besides these, tests/algorithms.unit.test.ts runs every scenario on every pull request.')) + '</div>'
        : emptyState('No dedicated unit test', T('Its scenarios above are its tests: tests/algorithms.unit.test.ts runs them on every pull request.')))
      + '</div>';
  }

  // ── content ───────────────────────────────────────────────────────────────

  function overviewSkeleton() {
    return '<div class="al-skel-hero" aria-hidden="true"></div>'
      + panel('What this room guarantees', skeleton(4, 'guar'))
      + panel('The loop', '<div class="al-skel-strip" aria-hidden="true"></div>');
  }

  function contentHtml() {
    if (AL.error && !AL.data) return panel('', emptyState('The Algorithms room could not be read', AL.error));
    if (!AL.data) return overviewSkeleton();
    if (AL.data.state === 'NOT_GENERATED') {
      return panel('', emptyState('Algorithm evidence has not been generated', T(AL.data.reason || ''))
        + '<div class="al-notice"><code data-no-i18n>npm run algorithms:discover</code></div>');
    }
    switch (AL.section) {
      case 'registry': return registryHtml();
      case 'loop': return loopHtml();
      case 'evaluation': return evaluationHtml();
      case 'approvals': return approvalsHtml();
      case 'monitoring': return monitoringHtml();
      case 'algorithm': return algorithmHtml();
      default: return overviewHtml();
    }
  }

  // ── loading ───────────────────────────────────────────────────────────────

  function apiBase() {
    return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE) ? window.FAM_CONFIG.API_BASE : '/api/v1';
  }
  function token() {
    try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) { return ''; }
  }
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
      credentials: 'include',
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open the Algorithms room.'));
      if (r.status === 404) throw new Error(T('This algorithm is not in the registry.'));
      if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
      return r.json();
    }).then(function (b) { return (b && b.data) || b; });
  }

  /** The fields this screen cannot draw without. An absent field is reported, never drawn as empty. */
  var REQUIRED = {
    overview: ['state', 'measuredAt', 'loop', 'domains', 'algorithms', 'guarantees'],
    detail: ['summary', 'usedBy', 'inputs', 'outputs', 'dependsOn', 'source', 'fingerprint', 'versions', 'tests', 'scenarios'],
    monitoring: ['state', 'measuredAt', 'thresholds', 'coverage', 'states', 'totals', 'runtime', 'store', 'loop', 'algorithms'],
    production: ['storeState', 'coverage', 'fingerprint', 'counts', 'latency', 'bySource', 'fingerprintsSeen', 'daily', 'checks', 'findingList'],
  };
  function missingFields(payload, required) {
    return required.filter(function (k) { return !payload || payload[k] === undefined || payload[k] === null; });
  }
  function contractError(endpoint, missing) {
    return T('CONTRACT ERROR') + ' · ' + endpoint + ' · ' + T('the response did not carry:') + ' ' + missing.join(', ');
  }

  function loadOverview() {
    return api('/system/algorithms').then(function (d) {
      var missing = missingFields(d, REQUIRED.overview);
      if (!missing.length && d.state === 'READY' && (!d.totals || !d.monitoring)) missing = ['totals', 'monitoring'].filter(function (k) { return !d[k]; });
      if (missing.length) { AL.data = null; AL.error = contractError('/system/algorithms', missing); return; }
      if (d.reason && d.state === 'READY') d.reason = null;
      AL.data = d; AL.error = null;
    }).catch(function (e) { AL.error = e.message; });
  }

  function loadMonitoring() {
    return api('/system/algorithms/monitoring').then(function (d) {
      var missing = missingFields(d, REQUIRED.monitoring);
      if (missing.length) { AL.mon = null; AL.monError = contractError('/system/algorithms/monitoring', missing); return; }
      // Optional by design: present or null, never absent.
      if (d.reason === undefined) { AL.mon = null; AL.monError = contractError('/system/algorithms/monitoring', ['reason']); return; }
      AL.mon = d; AL.monError = null;
    }).catch(function (e) { AL.monError = e.message; });
  }

  function loadAlgorithmMonitoring(key) {
    AL.monDetailError = null;
    return api('/system/algorithms/' + encodeURIComponent(key) + '/monitoring').then(function (d) {
      var missing = missingFields(d, REQUIRED.production);
      if (!missing.length) {
        missing = ['firstSeenAt', 'lastFailureAt', 'lastFailureKind', 'distribution', 'quality', 'freshness']
          .filter(function (k) { return d[k] === undefined; });
      }
      if (missing.length) { AL.monDetail = null; AL.monDetailError = contractError('/system/algorithms/' + key + '/monitoring', missing); return; }
      AL.monDetail = d;
    }).catch(function (e) { AL.monDetail = null; AL.monDetailError = e.message; });
  }

  function loadAlgorithm(key) {
    AL.detailError = null;
    return api('/system/algorithms/' + encodeURIComponent(key)).then(function (d) {
      var missing = missingFields(d, REQUIRED.detail);
      if (missing.length) { AL.detail = null; AL.detailError = contractError('/system/algorithms/' + key, missing); return; }
      if (d.notSimulatedBecause === undefined || d.approval === undefined) { AL.detail = null; AL.detailError = contractError('/system/algorithms/' + key, ['notSimulatedBecause', 'approval']); return; }
      AL.detail = d;
    }).catch(function (e) { AL.detail = null; AL.detailError = e.message; });
  }

  // ── paint ─────────────────────────────────────────────────────────────────

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', AL_DIR);
    host.setAttribute('lang', AL_LANG);
    host.innerHTML = '<div class="al-shell">' + railHtml()
      + '<main class="al-main">' + topHtml() + '<div class="al-body" id="al-body">' + contentHtml() + '</div></main></div>';
  }

  /** Repaint the body, the top bar and the rail — never the shell, so nothing under the reader moves. */
  function repaintBody(host, keepScroll) {
    var body = host.querySelector('#al-body');
    if (!body) return paint(host);
    var y = keepScroll ? body.scrollTop : 0;
    body.innerHTML = contentHtml();
    body.scrollTop = y;
    var top = host.querySelector('.al-top');
    if (top) top.outerHTML = topHtml();
    var rail = host.querySelector('.al-rail');
    if (rail) rail.outerHTML = railHtml();
  }

  function go(host, section) {
    AL.section = section;
    repaintBody(host, false);
  }

  function openAlgorithm(host, key) {
    AL.section = 'algorithm';
    AL.key = key;
    if (!AL.detail || AL.detail.key !== key) AL.detail = null;
    if (!AL.monDetail || AL.monDetail.key !== key) AL.monDetail = null;
    AL.detailError = null;
    AL.monDetailError = null;
    repaintBody(host, false);
    // Two reads, drawn as each answers: the definition never waits on the
    // telemetry store, and the store never waits on the definition.
    var redraw = function () { if (AL.section === 'algorithm' && AL.key === key) repaintBody(host, true); };
    loadAlgorithm(key).then(redraw);
    loadAlgorithmMonitoring(key).then(redraw);
  }

  function refresh(host) {
    if (AL.refreshing) return;
    AL.refreshing = true;
    repaintBody(host, true);
    var jobs = [loadOverview(), loadMonitoring()];
    if (AL.section === 'algorithm' && AL.key) jobs.push(loadAlgorithm(AL.key), loadAlgorithmMonitoring(AL.key));
    Promise.all(jobs).then(function () { AL.refreshing = false; repaintBody(host, true); });
  }

  function closeLangs(host) {
    AL.langOpen = false;
    var box = host.querySelector('.al-langs');
    if (box) box.classList.remove('is-open');
    var pick = host.querySelector('[data-al-langs]');
    if (pick) pick.setAttribute('aria-expanded', 'false');
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__alBound) return;
    host.__alBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      if (t.closest('[data-al-home]')) { try { window.navTo('owner-home'); } catch (_) {} return; }

      if (t.closest('[data-al-langs]')) {
        AL.langOpen = !AL.langOpen;
        var box = host.querySelector('.al-langs');
        if (box) box.classList.toggle('is-open', AL.langOpen);
        t.closest('[data-al-langs]').setAttribute('aria-expanded', AL.langOpen ? 'true' : 'false');
        return;
      }
      var lang = t.closest('[data-al-lang]');
      if (lang) {
        AL.langOpen = false;
        setLocale(lang.getAttribute('data-al-lang')).then(function () {
          var body = host.querySelector('#al-body');
          var y = body ? body.scrollTop : 0;
          paint(host);
          var again = host.querySelector('#al-body');
          if (again) again.scrollTop = y;
        });
        return;
      }
      if (AL.langOpen && !t.closest('.al-langs')) closeLangs(host);

      var open = t.closest('[data-al-open]');
      if (open) { openAlgorithm(host, open.getAttribute('data-al-open')); return; }

      var nav = t.closest('[data-al-nav]');
      if (nav) { go(host, nav.getAttribute('data-al-nav')); return; }

      if (t.closest('[data-al-refresh]')) { refresh(host); return; }
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (AL.langOpen) { closeLangs(host); return; }
      if (AL.section === 'algorithm') go(host, 'registry');
    });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaAlgorithms = function (host) {
    // The page-render registry calls every renderer with NO argument, and the
    // navigation switch calls this one with the root element. Both must work.
    host = host || document.getElementById('al-root');
    if (!host) return;
    bind(host);
    setLocale(initialLocale()).then(function () {
      paint(host);
      // The overview first — it needs no database — and production monitoring
      // beside it; whichever answers second repaints the body, not the shell.
      loadMonitoring().then(function () { if (AL.data || AL.error) repaintBody(host, true); });
      return loadOverview();
    }).then(function () { paint(host); });
  };

  window.teardownFamilistaAlgorithms = function () {
    // No stream or timer of its own. The open algorithm and the language menu
    // are dropped so the room opens clean next time.
    AL.section = 'overview'; AL.key = null; AL.detail = null; AL.detailError = null; AL.langOpen = false;
    AL.monDetail = null; AL.monDetailError = null;
  };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaAlgorithmsGateKind = gateKind;
  window.__familistaAlgorithmsMonKind = monKind;
}());
