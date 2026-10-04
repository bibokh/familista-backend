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
   and there must never be one: in Step 1 an algorithm changes only through a
   reviewed pull request that records the owner's approval, released by the
   CI-gated deploy.
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

  function monitoringHtml() {
    var m = AL.data.monitoring;
    if (!m) return panel('Monitoring', emptyState('Nothing has been measured yet', ''));
    return '<div class="al-intro">' + esc(T('This server re-runs every scenario when the room is read, at most once a minute, and keeps its own record of the runs since it started.')) + '</div>'
      + '<div class="al-figs al-figs--4">'
      + figure(esc(num(m.evaluationRuns)), T('Evaluation runs since start'))
      + figure(esc(num(m.failingRuns)), T('Runs with a failing check'), m.failingRuns ? 'crit' : 'ok')
      + figure(has(m.lastDurationMs) ? esc(num(m.lastDurationMs)) + '<small> ms</small>' : absent(T('Not run yet.')), T('Last run took'))
      + figure(instantHtml(m.lastRunAt), T('Last run'))
      + '</div>'
      + panel('Not measured yet', emptyState('Live production outputs are not measured yet',
        T('This room evaluates each algorithm on synthetic scenarios. Measuring its outputs on real matches and sessions — drift, distribution, error against outcomes — is the next step, and it will be added read-only.')));
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
    AL.detailError = null;
    repaintBody(host, false);
    loadAlgorithm(key).then(function () {
      if (AL.section === 'algorithm' && AL.key === key) repaintBody(host, true);
    });
  }

  function refresh(host) {
    if (AL.refreshing) return;
    AL.refreshing = true;
    repaintBody(host, true);
    var jobs = [loadOverview()];
    if (AL.section === 'algorithm' && AL.key) jobs.push(loadAlgorithm(AL.key));
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
      return loadOverview();
    }).then(function () { paint(host); });
  };

  window.teardownFamilistaAlgorithms = function () {
    // No stream or timer of its own. The open algorithm and the language menu
    // are dropped so the room opens clean next time.
    AL.section = 'overview'; AL.key = null; AL.detail = null; AL.detailError = null; AL.langOpen = false;
  };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaAlgorithmsGateKind = gateKind;
}());
