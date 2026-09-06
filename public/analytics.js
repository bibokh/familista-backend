/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — product analytics, in one place

   Every usage event in the product goes through this file. Not one page has
   its own tracking code, and none should ever gain any: scattered
   instrumentation is how an analytics layer becomes impossible to audit, to
   change, or to switch off.

   Three properties this file is built around.

   1. IT RECORDS METADATA, NEVER CONTENT.
      A module key, a feature key, a route SHAPE and a duration. There is no
      code here that reads an input value, a text node, a form field, a search
      term or a message, and the server drops anything that is not on its own
      allowlist regardless. "Search used" is an event; what was searched for is
      not.

   2. IT CANNOT COUNT TWICE.
      One sessionId per browser session, minted once and kept in sessionStorage
      — so a refresh continues the session rather than starting a second one.
      The navigation hook is installed once, guarded by a flag. A repeated
      navigation to the module already open is ignored. Together those are what
      make a re-render, a duplicate listener and a back button unable to inflate
      the numbers.

   3. IT NEVER GETS IN THE WAY.
      Events are queued and flushed in the background, at most every few
      seconds, with keepalive so a closing tab still delivers. A failed flush is
      dropped, not retried forever. Nothing in the product waits on this file,
      and nothing in the product breaks if the endpoint is down.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  if (window.FamilistaAnalytics) return;         // installed once, never twice

  var FLUSH_MS = 5000;
  var MAX_QUEUE = 50;
  var SESSION_KEY = 'familista_analytics_session';

  var queue = [];
  var timer = null;
  var started = false;

  // ── the session ───────────────────────────────────────────────────────────
  // sessionStorage, not localStorage: a session is one tab's visit, and it must
  // end when the tab does. A refresh keeps it, which is exactly right — a
  // refresh is not a new visit.
  function sessionId() {
    try {
      var id = sessionStorage.getItem(SESSION_KEY);
      if (id) return id;
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (_) {
      // Private mode with storage refused: a per-page id is still better than
      // no session at all, and nothing depends on it surviving.
      return 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  /** Three buckets. Never a user-agent string — that is a fingerprint. */
  function deviceCategory() {
    try {
      var w = window.innerWidth || 0;
      if (w && w < 768) return 'mobile';
      if (w && w < 1180) return 'tablet';
      return 'desktop';
    } catch (_) { return 'unknown'; }
  }

  function locale() {
    try { return (navigator.language || '').slice(0, 16) || null; } catch (_) { return null; }
  }
  function timezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { return null; }
  }

  /**
   * A route shape, built here as well as on the server.
   *
   * The server is the guard — it re-shapes whatever arrives — but sending a
   * populated route and trusting it to be stripped is a habit that survives
   * until the day something forgets. So it is stripped before it is sent.
   */
  function routeShape(path) {
    if (!path) return null;
    return String(path).split('?')[0].split('#')[0].split('/').map(function (seg) {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^\d+$/.test(seg)) return ':n';
      if (seg.length > 24) return ':id';
      return seg;
    }).join('/').slice(0, 200);
  }

  // ── the queue ─────────────────────────────────────────────────────────────
  function flush(sync) {
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_QUEUE);
    var base = (typeof FAM_CONFIG !== 'undefined' && FAM_CONFIG.API_BASE) ? FAM_CONFIG.API_BASE : '/api/v1';
    var token = '';
    try { token = (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) {}
    if (!token) return;                          // signed out: nothing to attribute

    try {
      fetch(base + '/telemetry/events', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' },
          token ? { Authorization: 'Bearer ' + token } : {}),
        credentials: 'include',
        body: JSON.stringify({ events: batch }),
        // A closing tab still delivers what it already recorded.
        keepalive: !!sync,
      }).catch(function () { /* dropped, never retried into a loop */ });
    } catch (_) { /* nothing in the product waits on this */ }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; flush(false); }, FLUSH_MS);
  }

  function record(eventName, fields) {
    if (!eventName) return;
    var event = {
      eventName: eventName,
      sessionId: sessionId(),
      occurredAt: new Date().toISOString(),
      deviceCategory: deviceCategory(),
      locale: locale(),
      timezone: timezone(),
      source: 'web',
      schemaVersion: 1,
    };
    if (fields) {
      if (fields.module) event.module = String(fields.module).slice(0, 64);
      if (fields.feature) event.feature = String(fields.feature).slice(0, 64);
      if (fields.route) event.route = routeShape(fields.route);
      if (fields.clubId) event.clubId = String(fields.clubId).slice(0, 80);
      if (fields.teamId) event.teamId = String(fields.teamId).slice(0, 80);
      if (typeof fields.durationMs === 'number') event.durationMs = Math.max(0, Math.round(fields.durationMs));
    }
    queue.push(event);
    if (queue.length >= MAX_QUEUE) flush(false); else schedule();
  }

  // ── module dwell time ─────────────────────────────────────────────────────
  // One module is open at a time. Opening the next closes the last and reports
  // how long it was open — which is how "time spent in each module" is measured
  // without a timer per screen.
  var openModule = null;
  var openedAt = 0;

  /** Pages that are the same module under different names. */
  var MODULE_ALIASES = {
    'owner-home': 'club-home',
    'dashboard': 'club-home',
  };

  function closeCurrent(now) {
    if (!openModule) return;
    record('module_closed', {
      module: openModule,
      durationMs: Math.max(0, (now || Date.now()) - openedAt),
    });
    openModule = null;
  }

  /** The one event a page open produces, plus its named sibling when it has one. */
  var NAMED_OPEN = {
    'first-team': 'first_team_opened',
    'academy': 'academy_opened',
    'training-centre': 'training_centre_opened',
    'training': 'training_centre_opened',
    'match-center': 'match_center_opened',
    'familista-league': 'familista_league_opened',
    'transfers': 'transfer_market_opened',
    'coach-market': 'coach_market_opened',
    'medical-center': 'medical_center_opened',
    'video-intelligence': 'video_intelligence_opened',
    'player-intelligence': 'player_profile_viewed',
    'ai-coach': 'ai_feature_opened',
    'ai-tactical-brain': 'ai_feature_opened',
    'ai-scouting': 'ai_feature_opened',
    'experiments': 'experiment_opened',
  };

  function openModuleNamed(page) {
    if (!page) return;
    var module = MODULE_ALIASES[page] || page;
    // Re-navigating to the module already open is a re-render, not a visit.
    if (module === openModule) return;

    var now = Date.now();
    closeCurrent(now);

    var club = null, team = null;
    try {
      club = (window.State && State.club && State.club.id) || null;
      team = (window.State && State.currentTeamId) || null;
    } catch (_) {}

    openModule = module;
    openedAt = now;
    record('module_opened', {
      module: module,
      route: (window.location && window.location.pathname) || null,
      clubId: club,
      teamId: team,
    });
    if (NAMED_OPEN[page]) record(NAMED_OPEN[page], { module: module, clubId: club, teamId: team });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  var sessionStartedAt = 0;

  function start() {
    if (started) return;                          // guarded: installed once
    started = true;
    sessionStartedAt = Date.now();
    record('session_started', { route: (window.location && window.location.pathname) || null });

    // A closing tab reports the module it was in and the session it ends.
    var ending = false;
    var end = function () {
      if (ending) return;
      ending = true;
      var now = Date.now();
      closeCurrent(now);
      record('session_ended', { durationMs: Math.max(0, now - sessionStartedAt) });
      flush(true);
    };
    try {
      window.addEventListener('pagehide', end);
      document.addEventListener('visibilitychange', function () {
        // Hidden is not ended — a backgrounded tab comes back. What it is, is
        // a good moment to deliver what has already been recorded.
        if (document.visibilityState === 'hidden') flush(true);
      });
    } catch (_) {}
  }

  window.FamilistaAnalytics = {
    start: start,
    /** Called by navTo, once per navigation. The only navigation hook. */
    page: openModuleNamed,
    /** A deliberate action worth a trend line. Never a click, never a keystroke. */
    feature: function (feature, module) {
      record('feature_used', { feature: feature, module: module || openModule });
    },
    /** Named events the product raises itself. */
    event: function (name, fields) { record(name, fields); },
    flush: function () { flush(true); },
    /** For tests and for anybody reading the console. */
    _state: function () {
      return { sessionId: sessionId(), openModule: openModule, queued: queue.length, started: started };
    },
  };
}());
