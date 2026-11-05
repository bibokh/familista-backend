/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — SYSTEM UPDATES

   The Platform Owner's view of the platform's own evolution: what is running,
   how a change reaches production, what changed recently, and what waits for
   the owner's approval. Loaded on demand by public/app.js for the platform owner
   only, and drawn into #su-root.

   Read-only. One GET (/system/updates, guarded by assertPlatformOwner on the
   server), no other verb. Every figure is the server's, from a named source;
   where the server has none it sends a reason code, and this room words it as
   "Not connected" or "Unknown" and says why. Nothing is inferred to fill a gap.

   It keeps the owner-room rules: the same data-no-i18n boundary as every owner
   room, with its own English, German and Arabic catalogue under
   /system-updates/i18n/; commit messages, branch names and paths are data,
   shown as written and isolated from the page's direction.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── language ──────────────────────────────────────────────────────────────
  var SU_LOCALES = [['en', 'English', 'ltr', 'en-GB'], ['de', 'Deutsch', 'ltr', 'de-DE'], ['ar', 'العربية', 'rtl', 'ar']];
  var DICT = {}, LANG = 'en', DIR = 'ltr';
  function localeOf(tag) {
    var t = String(tag || '').toLowerCase();
    for (var i = 0; i < SU_LOCALES.length; i++) if (t === SU_LOCALES[i][0] || t === SU_LOCALES[i][3].toLowerCase() || t.indexOf(SU_LOCALES[i][0] + '-') === 0) return SU_LOCALES[i];
    return SU_LOCALES[0];
  }
  function platformLocale() {
    try { if (window.I18N && typeof window.I18N.locale === 'function') return window.I18N.locale(); } catch (_) {}
    try { return localStorage.getItem('familista.locale') || 'en'; } catch (_) { return 'en'; }
  }
  function loadDict(tag) {
    if (tag === 'en') { DICT = {}; return Promise.resolve(); }
    return fetch('/system-updates/i18n/' + tag + '.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { DICT = d || {}; }, function () { DICT = {}; });
  }
  function setLocale(tag) { var l = localeOf(tag); LANG = l[0]; DIR = l[2]; return loadDict(LANG); }
  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(DICT, s) ? DICT[s] : s;
  }
  function num(v) { try { return new Intl.NumberFormat(LANG === 'ar' ? 'ar' : LANG).format(v); } catch (_) { return String(v); } }
  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) { var a = Array.prototype.slice.call(arguments, 1), i = 0; return T(key).replace(/%d/g, function () { var v = a[i++]; return v == null ? '—' : num(v); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** Data — a commit message, a branch, a path: kept as written, isolated from the page's direction. */
  function data(s) { return '<bdi dir="auto">' + esc(s) + '</bdi>'; }
  function locale() { return LANG === 'ar' ? 'ar' : LANG === 'de' ? 'de-DE' : 'en-GB'; }
  function when(iso) {
    try { return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch (_) { return iso; }
  }
  function day(iso) {
    try { return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); } catch (_) { return iso; }
  }
  function clock(iso) {
    try { return new Intl.DateTimeFormat(locale(), { timeStyle: 'short' }).format(new Date(iso)); } catch (_) { return iso; }
  }
  function since(fromIso, toIso) {
    var m = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
    if (m < 60) return tf('%d min ago', m);
    if (m < 60 * 48) return tf('%d h %d min ago', Math.floor(m / 60), m % 60);
    return tf('%d days ago', Math.floor(m / 1440));
  }

  // ── what the server's codes mean ──────────────────────────────────────────
  /** Why there is no value. Every reason the contract can send (src/platform/system-updates/model.ts). */
  var REASONS = {
    NO_BUILD_RECORD: 'This server was not built with a release record, so this is not known here.',
    NO_REPOSITORY_HISTORY: 'The build that produced this release had no repository history to read.',
    NO_DEPLOY_CONFIGURATION: 'The build found neither render.yaml nor the deploy workflow.',
    NO_CI_CONNECTION: 'This server holds no credential for GitHub, so it cannot read CI results.',
    NO_PROVIDER_CONNECTION: 'This server holds no credential for the Render API, so it cannot read deployment history.',
    NO_CODE_REVIEW_CONNECTION: 'This server does not read pull requests, so it cannot list code changes waiting for review.',
    REGISTRY_UNAVAILABLE: 'The algorithms registry could not be read.',
  };
  /** How a change reaches production, as the repository's configuration declares it. */
  var FACTS = {
    AUTO_DEPLOY_OFF: 'A push alone deploys nothing: Render auto-deploy is off.',
    AUTO_DEPLOY_ON: 'Every push to the branch deploys: Render auto-deploy is on.',
    DEPLOY_AFTER_CI: 'A deploy is started by the deploy workflow when the ci workflow completes.',
    DEPLOY_MAIN_ONLY: 'Only for the main branch.',
    DEPLOY_REQUIRES_SUCCESS: 'Only when that ci run succeeded.',
    DEPLOY_REQUIRES_HEAD: 'Only for the commit still at the head of main.',
    MANUAL_DEPLOY: 'The deploy workflow can also be run by hand.',
  };
  /** The owner rooms that hold the rest of the picture. Each is guarded on the server like this one. */
  var ROOMS = [
    { page: 'neural-twin', name: 'Neural Digital Twin', says: 'The architecture, drawn from its own evidence' },
    { page: 'infrastructure-city', name: 'Infrastructure City', says: 'Live infrastructure, health and change history' },
    { page: 'cybersecurity', name: 'Cybersecurity', says: 'Security posture, controls and evidence' },
    { page: 'algorithms', name: 'Algorithms', says: 'Registry, evaluation and human approval' },
    { page: 'source-core', name: 'Source Core', says: 'Origins, provenance and lineage' },
  ];
  function reason(code) { return T(REASONS[code] || 'Unknown'); }

  // ── state ─────────────────────────────────────────────────────────────────
  var S = { root: null, state: 'idle', view: null, error: null, seq: 0, cleanup: [] };

  // ── the API ───────────────────────────────────────────────────────────────
  function apiBase() { return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE) ? window.FAM_CONFIG.API_BASE : '/api/v1'; }
  function token() { try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) { return ''; } }
  /** GET only: this room has no other verb to call. */
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, { method: 'GET', headers: t ? { Authorization: 'Bearer ' + t } : {}, credentials: 'include', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open System Updates.'));
        if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
        return r.json();
      }).then(function (b) { return (b && b.data) || b; });
  }
  /** The fields this room cannot draw without. An absent field is reported, never drawn as empty. */
  var REQUIRED = ['schemaVersion', 'measuredAt', 'mode', 'running', 'deployPath', 'ci', 'provider', 'changes', 'approvals'];

  function load() {
    var seq = ++S.seq;
    S.state = S.view ? 'refreshing' : 'loading';
    S.error = null;
    paintBody();
    api('/system/updates').then(function (v) {
      if (seq !== S.seq || !S.root) return;
      var missing = REQUIRED.filter(function (k) { return !v || !(k in v); });
      if (missing.length) throw new Error(T('The answer is missing fields this room needs:') + ' ' + missing.join(', '));
      if (v.mode !== 'READ_ONLY') throw new Error(T('The answer does not say it is read-only, so this room will not show it.'));
      S.view = v; S.state = 'ready';
      paintBody();
      announce(T('Updated') + ' · ' + clock(v.measuredAt));
    }).catch(function (err) {
      if (seq !== S.seq || !S.root) return;
      S.state = 'error'; S.error = (err && err.message) || T('Unknown error');
      paintBody();
    });
  }

  // ── pieces ────────────────────────────────────────────────────────────────
  function announce(msg) { var l = S.root && S.root.querySelector('#su-live'); if (l) l.textContent = msg; }
  function sha(s) { return '<code class="su-sha" dir="ltr" title="' + esc(s) + '">' + esc(String(s).slice(0, 7)) + '</code>'; }
  function unknown(text) { return '<span class="su-unknown">' + esc(text || T('Unknown')) + '</span>'; }
  function badge(kind, text) { return '<span class="su-badge su-badge--' + kind + '">' + esc(text) + '</span>'; }
  /** A link out, in a new tab. Its name is its visible text, then what assistive technology also needs to hear. */
  function ext(href, text, also) {
    return '<a class="su-ext" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + text
      + '<span class="su-sr"> ' + esc(also) + '</span><span aria-hidden="true" class="su-ext-mark">↗</span></a>';
  }
  /** github.com links, built only from the "owner/name" the server validated and an integer. */
  function github(repo, rest) { return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo || '') ? 'https://github.com/' + repo + rest : null; }
  function panel(id, title, body, opts) {
    opts = opts || {};
    return '<section class="su-panel su-panel--' + id + '" aria-labelledby="su-h-' + id + '">'
      + '<header class="su-panel-h"><h2 class="su-h" id="su-h-' + id + '">' + esc(title) + '</h2>' + (opts.badge || '') + '</header>'
      + '<div class="su-panel-b">' + body + '</div>'
      + (opts.foot ? '<p class="su-foot">' + opts.foot + '</p>' : '')
      + '</section>';
  }
  function fact(label, value, source) {
    return '<div class="su-fact"><dt class="su-fact-k">' + esc(label) + '</dt><dd class="su-fact-v">' + value + '</dd>'
      + (source ? '<dd class="su-src">' + esc(source) + '</dd>' : '') + '</div>';
  }

  // ── the sections ──────────────────────────────────────────────────────────
  function running(v) {
    var r = v.running, recorded = r.record === 'PRESENT';
    var differs = r.commit && r.builtCommit && r.commit !== r.builtCommit;
    var built = r.builtCommit ? sha(r.builtCommit) + (differs ? ' <span class="su-flag">' + esc(T('Differs from the deployed commit')) + '</span>' : '') : unknown(recorded ? T('Unknown') : T('Not recorded'));
    var tag = !recorded ? unknown(T('Not recorded')) : r.tag ? data(r.tag) : '<span class="su-none">' + esc(T('No release tag on this commit')) + '</span>';
    var body = '<dl class="su-facts">'
      + fact(T('Deployed commit'), r.commit ? sha(r.commit) : unknown(T('Unknown')), r.onRender ? T('Render build environment') : T('Not reported: this server is not on Render'))
      + fact(T('Branch'), r.branch ? data(r.branch) : unknown(T('Unknown')), T('Render build environment'))
      + fact(T('Built from'), built, T('Release record'))
      + fact(T('Built at'), r.builtAt ? '<time datetime="' + esc(r.builtAt) + '">' + esc(when(r.builtAt)) + '</time>' : unknown(T('Not recorded')), T('Release record'))
      + fact(T('Running since'), '<time datetime="' + esc(r.startedAt) + '">' + esc(when(r.startedAt)) + '</time> <span class="su-dim">' + esc(since(r.startedAt, v.measuredAt)) + '</span>', T('This server process'))
      + fact(T('Environment'), data(r.environment), T('This server process'))
      + fact(T('Release tag'), tag, T('Release record'))
      + fact(T('Node.js'), data(r.node), T('This server process'))
      + '</dl>';
    return panel('running', T('Running now'), body, {
      badge: r.commit ? badge('live', T('Answering')) : '',
      foot: (r.reason ? esc(reason(r.reason)) + ' ' : '') + esc(T('Measured by this server at')) + ' <time datetime="' + esc(v.measuredAt) + '">' + esc(when(v.measuredAt)) + '</time>',
    });
  }

  function approvals(v) {
    var a = v.approvals, repo = v.repository;
    function row(title, c, sentence, page) {
      var known = c.state === 'AVAILABLE';
      var wait = known && c.awaiting > 0;
      return '<li class="su-appr">'
        + '<span class="su-appr-n' + (wait ? ' is-wait' : '') + '">' + (known ? esc(num(c.awaiting)) : '—') + '</span>'
        + '<div class="su-appr-t"><h3 class="su-h3">' + esc(T(title)) + '</h3><p class="su-p">' + (known ? esc(tf(sentence, c.awaiting, c.total)) : esc(reason(c.reason))) + '</p></div>'
        + '<button type="button" class="su-link" data-action="navTo" data-page="' + page + '">' + esc(T('Open Algorithms')) + '</button>'
        + '</li>';
    }
    var pulls = github(repo, '/pulls');
    var code = '<li class="su-appr">'
      + '<span class="su-appr-n">—</span>'
      + '<div class="su-appr-t"><h3 class="su-h3">' + esc(T('Code changes')) + ' ' + badge('off', T('Not connected')) + '</h3><p class="su-p">' + esc(reason(a.code.reason)) + '</p></div>'
      + (pulls ? ext(pulls, esc(T('Pull requests')), T('(on GitHub, opens a new tab)')) : '')
      + '</li>';
    var both = a.algorithms.state === 'AVAILABLE' && a.candidates.state === 'AVAILABLE';
    var total = both ? a.algorithms.awaiting + a.candidates.awaiting : null;
    var head = total == null ? badge('off', T('Partly unknown')) : total > 0 ? badge('wait', tf('%d waiting', total)) : badge('quiet', T('None in the registry'));
    var body = '<ul class="su-list">'
      + row('Algorithm versions', a.algorithms, '%d of %d registered algorithms are at the human-approval stage.', 'algorithms')
      + row('Proposed algorithm changes', a.candidates, '%d of %d candidates are at the human-approval stage.', 'algorithms')
      + code + '</ul>';
    return panel('approvals', T('Awaiting your approval'), body, { badge: head, foot: esc(T('Approving happens where each change lives, never here.')) });
  }

  function connection(id, title, c, link, linkText, after) {
    var body = '<p class="su-p">' + esc(reason(c.reason)) + '</p>' + (after || '') + (link ? '<p class="su-p">' + ext(link, esc(linkText), T('(opens a new tab)')) + '</p>' : '');
    return panel(id, title, body, { badge: badge('off', T('Not connected')) });
  }

  function ci(v) {
    return connection('ci', T('Continuous integration'), v.ci, github(v.repository, '/actions'), T('Open GitHub Actions'));
  }

  function provider(v) {
    var r = v.running;
    var after = r.commit ? '<p class="su-p">' + esc(T('What this server can say: it is running the deployed commit shown above, and it answered this request.')) + '</p>' : '';
    return connection('provider', T('Deployment status'), v.provider, null, '', after);
  }

  function deployPath(v) {
    var d = v.deployPath;
    if (d.state !== 'RECORDED') return panel('path', T('How a change reaches production'), '<p class="su-empty">' + esc(reason(d.reason)) + '</p>', { badge: badge('off', T('Unknown')) });
    var items = d.facts.map(function (f) {
      return '<li class="su-step"><span class="su-step-dot" aria-hidden="true"></span><span class="su-step-t">' + esc(T(FACTS[f.fact] || f.fact)) + '</span>'
        + '<code class="su-ev" dir="ltr">' + esc(f.evidence.path) + ':' + esc(f.evidence.line) + '</code></li>';
    }).join('');
    var body = d.facts.length ? '<ol class="su-steps">' + items + '</ol>' : '<p class="su-empty">' + esc(T('The configuration was read, but none of the rules this room knows matched it.')) + '</p>';
    return panel('path', T('How a change reaches production'), body, {
      badge: badge('read', T('From the repository')),
      foot: esc(T('Read from the repository when this release was built. It says how a deploy can start, not that this one did.')),
    });
  }

  function changes(v) {
    var c = v.changes, repo = v.repository, running = v.running.commit;
    if (c.state !== 'RECORDED') return panel('changes', T('Recent changes'), '<p class="su-empty">' + esc(reason(c.reason)) + '</p>', { badge: badge('off', T('Unknown')) });
    var rows = c.items.map(function (it) {
      var href = it.pr ? github(repo, '/pull/' + it.pr) : null;
      var pr = it.pr ? (href ? ext(href, '#' + esc(it.pr), T('(pull request on GitHub, opens a new tab)')) : '<span class="su-pr">#' + esc(it.pr) + '</span>') : '';
      return '<li class="su-chg' + (it.sha === running ? ' is-running' : '') + '">'
        + '<time class="su-chg-d" datetime="' + esc(it.date) + '">' + esc(day(it.date)) + '</time>'
        + sha(it.sha)
        + '<span class="su-chg-s">' + data(it.subject) + '</span>'
        + '<span class="su-chg-m">' + (it.sha === running ? badge('live', T('Running')) : '') + pr + '</span>'
        + '</li>';
    }).join('');
    var foot = tf('The last %d commits of this release, recorded when it was built.', c.items.length) + (c.shallow ? ' ' + T('The build had only part of the history.') : '');
    return panel('changes', T('Recent changes'), c.items.length ? '<ol class="su-chgs">' + rows + '</ol>' : '<p class="su-empty">' + esc(T('No commits were recorded.')) + '</p>', {
      badge: badge('read', T('From the release record')), foot: esc(foot),
    });
  }

  function rooms() {
    var items = ROOMS.map(function (r) {
      return '<li><button type="button" class="su-room" data-action="navTo" data-page="' + r.page + '">'
        + '<span class="su-room-t"><span class="su-room-n">' + esc(T(r.name)) + '</span><span class="su-room-s">' + esc(T(r.says)) + '</span></span>'
        + '<span class="su-room-go" aria-hidden="true">→</span></button></li>';
    }).join('');
    return panel('rooms', T('Related owner rooms'), '<ul class="su-rooms">' + items + '</ul>');
  }

  function skeleton() {
    var block = function (id, h) { return '<section class="su-panel su-panel--' + id + '" aria-hidden="true"><div class="su-skel su-skel--' + h + '"><span></span><span></span><span></span></div></section>'; };
    return block('running', 'm') + block('approvals', 'l') + '<div class="su-stack">' + block('ci', 's') + block('provider', 's') + '</div>' + block('changes', 'xl') + block('path', 'l') + block('rooms', 's');
  }

  // ── drawing the room ──────────────────────────────────────────────────────
  function ownerNav() {
    if (typeof window.famOwnerNav !== 'function') return '';
    return '<nav class="su-ownernav" aria-label="' + esc(T('Platform owner')) + '">' + window.famOwnerNav('system-updates', T, 'su-ownernav') + '</nav>';
  }
  function shell() {
    var langs = SU_LOCALES.map(function (l) {
      return '<button type="button" class="su-lang' + (l[0] === LANG ? ' is-on' : '') + '" data-su-lang="' + l[0] + '" lang="' + l[0] + '" aria-pressed="' + (l[0] === LANG) + '" title="' + esc(l[1]) + '">' + l[0].toUpperCase() + '</button>';
    }).join('');
    var mark = typeof window.famOwnerNavIcon === 'function' ? window.famOwnerNavIcon('system-updates', 'su-mark-ico') : '';
    return '<div class="su-shell">'
      + '<header class="su-top">'
      + '<div class="su-top-l"><div class="su-rail"><button type="button" class="su-back" data-su-action="back"><span aria-hidden="true">←</span> ' + esc(T('Owner Control')) + '</button>' + ownerNav() + '</div>'
      + '<div class="su-brand"><span class="su-mark" aria-hidden="true">' + mark + '</span><div class="su-brand-t">'
      + '<div class="su-eyebrow">' + esc(T('Familista · Platform owner')) + '</div>'
      + '<h1 class="su-title">' + esc(T('System Updates')) + '</h1>'
      + '<p class="su-sub">' + esc(T('What is running, how a change reaches production, and what waits for you. Read-only.')) + '</p></div></div></div>'
      + '<div class="su-top-r">'
      + '<div class="su-langs" role="group" aria-label="' + esc(T('Language')) + '">' + langs + '</div>'
      + '<button type="button" class="su-btn" data-su-action="reload" id="su-reload">' + esc(T('Refresh')) + '</button></div>'
      + '</header>'
      + '<div class="su-work" id="su-work" role="region" tabindex="0" aria-label="' + esc(T('System Updates')) + '"><div class="su-grid" id="su-grid" aria-busy="true"></div></div>'
      + '<div class="su-sr" id="su-live" role="status" aria-live="polite"></div>'
      + '</div>';
  }
  function paintBody() {
    var grid = S.root && S.root.querySelector('#su-grid');
    if (!grid) return;
    var btn = S.root.querySelector('#su-reload');
    if (btn) { btn.disabled = S.state === 'loading' || S.state === 'refreshing'; }
    if (S.state === 'loading') { grid.setAttribute('aria-busy', 'true'); grid.innerHTML = skeleton(); return; }
    if (S.state === 'refreshing') { grid.setAttribute('aria-busy', 'true'); return; }
    grid.setAttribute('aria-busy', 'false');
    if (S.state === 'error') {
      grid.innerHTML = '<section class="su-panel su-panel--error" role="alert"><h2 class="su-h">' + esc(T('System Updates could not be read')) + '</h2>'
        + '<p class="su-p">' + esc(S.error) + '</p><p class="su-p"><button type="button" class="su-btn" data-su-action="reload">' + esc(T('Try again')) + '</button></p></section>';
      return;
    }
    var v = S.view;
    if (!v) return;
    grid.innerHTML = running(v) + approvals(v) + '<div class="su-stack">' + ci(v) + provider(v) + '</div>' + changes(v) + deployPath(v) + rooms();
  }
  function paintAll() {
    var root = S.root;
    if (!root) return;
    root.setAttribute('dir', DIR); root.setAttribute('lang', LANG);
    root.innerHTML = shell();
    paintBody();
  }
  function changeLang(tag) {
    var l = localeOf(tag);
    var apply = (window.I18N_APPLY && typeof window.I18N_APPLY.change === 'function') ? window.I18N_APPLY.change(l[3]) : Promise.resolve();
    Promise.resolve(apply).catch(function () {}).then(function () { return setLocale(l[0]); }).then(function () {
      paintAll();
      // the header is drawn again in the new language: the reader stays on the button they pressed
      var focus = S.root && S.root.querySelector('[data-su-lang="' + l[0] + '"]');
      if (focus) focus.focus();
    });
  }
  function onClick(e) {
    var t = e.target, q;
    if (!t || !t.closest) return;
    if ((q = t.closest('[data-su-lang]'))) { changeLang(q.getAttribute('data-su-lang')); return; }
    if ((q = t.closest('[data-su-action]'))) {
      var a = q.getAttribute('data-su-action');
      if (a === 'back') { try { window.navTo('owner-home', null); } catch (_) {} }
      if (a === 'reload') load();
    }
  }

  // ── entry and exit ────────────────────────────────────────────────────────
  window.renderFamilistaSystemUpdates = function (root) {
    if (!root) return;
    if (S.root && S.root !== root) window.teardownFamilistaSystemUpdates();
    if (S.root !== root) {
      S.root = root;
      root.classList.add('su-root');
      root.setAttribute('data-fam-context', 'owner');
      root.addEventListener('click', onClick);
      S.cleanup.push(function () { root.removeEventListener('click', onClick); });
    }
    S.view = null; S.state = 'loading';
    setLocale(platformLocale()).then(function () { paintAll(); load(); });
  };
  window.teardownFamilistaSystemUpdates = function () {
    S.seq++;
    S.cleanup.splice(0).forEach(function (f) { try { f(); } catch (_) {} });
    if (S.root) { S.root.innerHTML = ''; S.root.classList.remove('su-root'); S.root.__famDrawn = false; }
    S = { root: null, state: 'idle', view: null, error: null, seq: S.seq, cleanup: [] };
  };
  /** What the tests and the browser proof read: the room's own state, never the page's. */
  window.__familistaUpdatesMetrics = function () {
    var v = S.view;
    return {
      state: S.state, lang: LANG, dir: DIR,
      commit: v ? v.running.commit : null, record: v ? v.running.record : null,
      changes: v && v.changes.state === 'RECORDED' ? v.changes.items.length : 0,
      facts: v && v.deployPath.state === 'RECORDED' ? v.deployPath.facts.length : 0,
      ci: v ? v.ci.state : null, provider: v ? v.provider.state : null,
    };
  };
})();
