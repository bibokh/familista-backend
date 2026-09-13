/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — the interaction layer

   `analytics.js` records what the product is FOR: a module opened, a session
   started, a feature used. This file records what a person is DOING in it right
   now — navigating, opening, invoking, moving, scrolling, hovering — so that
   SYSTEM → Live Data Flow shows a platform in use rather than a platform that
   happens to have written a row.

   It is a second file and not a second pipeline. Every event here is handed to
   `FamilistaAnalytics.event`, queued by the same queue, flushed by the same
   flush, sanitised by the same server allow-list and stored in the same table.
   There is exactly one way telemetry leaves this browser, and this file is not
   a new one.

   ── THE THREE PROPERTIES THIS FILE IS BUILT AROUND ────────────────────────────

   1. IT CANNOT RECORD CONTENT, BY CONSTRUCTION.

      Every value that becomes a `feature` or `module` key passes `identifier()`
      below, which accepts a single token of at most 48 characters matching
      /^[A-Za-z][A-Za-z0-9_.:-]*$/ and rejects everything else. A sentence has
      spaces; a name has spaces; a search term has spaces; a typed password has
      whatever the person typed. None of them can pass. That is a stronger
      guarantee than "we are careful not to read text", because it holds even
      when somebody later writes `data-fam-action="<the label>"` by mistake.

      Beyond that: this file never reads `.value`, `.textContent`, `.innerText`,
      `.innerHTML`, `placeholder`, `title`, `alt` or `aria-label` from anything,
      and it registers no `keydown`, `keyup`, `keypress`, `input` VALUE reader,
      `paste` or `copy` listener. Grep for those names — they are not here, and
      `tests/fam-telemetry.unit.test.ts` fails if they appear.

   2. IT AGGREGATES, IT DOES NOT SAMPLE-AND-SEND.

      Pointer movement is a WINDOW, not a position: a window opens on the first
      movement, absorbs every subsequent movement, and closes into ONE event
      carrying the region and the duration. Scroll is a THRESHOLD, not an
      offset: each of 25/50/75/100% fires at most once per module visit, so
      scrolling a page up and down for a minute produces at most four events.
      Hover is a BUCKETED DWELL over opt-in regions, not a mouseenter: a region
      must be declared in the markup, the pointer must rest on it for 400ms, and
      the duration is rounded into a bucket rather than reported exactly.

      No coordinate is ever recorded — not a page offset, not a client x/y, not
      a scroll position, not an element rectangle.

   3. IT CANNOT FLOOD, AND IT CANNOT BREAK THE PRODUCT.

      Every class of event has a per-minute ceiling enforced here, before the
      queue. Every listener is passive where the platform allows it and every
      handler body is inside a try/catch that swallows. Nothing in Familista
      waits on this file, and a throw inside it cannot reach a click handler,
      a navigation or a render.

   ── HOW A CONTROL BECOMES INSTRUMENTED ───────────────────────────────────────

   Preferred, explicit, and what new markup should use:

       <button data-fam-action="squad.export">…</button>
       <button data-fam-tab="tactics">…</button>
       <div    data-fam-panel="depth-chart">…</div>
       <div    data-fam-modal="player">…</div>
       <button data-fam-card="player">…</button>
       <section data-fam-region="player-card">…</section>
       <form   data-fam-form="player-edit">…</form>

   Fallback, so that the sixty-odd existing screens are instrumented without
   sixty-odd edits: the app's own `data-action`, `data-nav`, `data-page`,
   `data-tab` and `data-match-tab` attributes already carry semantic CODE
   identifiers — `sqCmdTab`, `openPlayerModal`, `trArrange` — and those are
   read as the key when no `data-fam-*` is present. They are identifiers by
   construction (they name functions), so they pass the same guard.

   `data-fam-none` on an element or any ancestor opts that subtree out entirely.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  if (window.FamTelemetry) return;               // installed once, never twice

  // ── the dials ─────────────────────────────────────────────────────────────
  // Every number here is a deliberate trade between "the board looks alive" and
  // "the table stays affordable". They are exported on the public object so a
  // test can assert them rather than re-state them.

  var POINTER_SAMPLE_MS = 150;    // a movement is looked at 6-7 times a second
  var POINTER_IDLE_MS   = 1200;   // …and the window closes when it stops
  var POINTER_WINDOW_MS = 3000;   // …or after this long, so a long sweep still reports
  var POINTER_PER_MIN   = 20;     // ceiling: one every three seconds, sustained

  var SCROLL_THROTTLE_MS = 200;
  var SCROLL_THRESHOLDS  = [25, 50, 75, 100];   // each once per module visit
  var SCROLL_PER_MIN     = 12;

  var HOVER_MIN_MS  = 400;                       // below this it is passing through
  var HOVER_BUCKETS = [500, 1000, 2000, 5000, 10000, 30000];
  var HOVER_PER_MIN = 12;

  var ACTION_PER_MIN = 60;       // a deliberate click a second, sustained, is a lot
  var NAV_PER_MIN    = 40;
  var ERROR_PER_MIN  = 10;       // a failing screen must not become a DoS on the table

  var KEY_MAX = 48;

  // ── the guard that makes content impossible ───────────────────────────────

  /**
   * A single identifier token, or nothing at all.
   *
   * This is the ONLY door through which a string reaches an event field. It
   * accepts `sqCmdTab`, `player-card`, `depth_50`, `squad.export`, `U15:home`.
   * It rejects `Please enter email and password`, `Mohammed Al-Rashid`,
   * `hunter2 `, an empty string, a 200-character paragraph and anything with a
   * space, a quote, a slash or a newline in it.
   *
   * Rejecting is silent and total: the caller gets null and the field is simply
   * absent from the event. A missing key is a gap in a chart; a leaked one is a
   * breach, and the two are not comparable.
   */
  function identifier(v) {
    if (typeof v !== 'string') return null;
    if (!v || v.length > KEY_MAX) return null;
    // Deliberately NOT trimmed. Whitespace around a value means it did not come
    // from an author writing an attribute by hand, and refusing it costs a key
    // that would have been a gap in a chart while buying a guard that holds for
    // free. A missing key and a leaked value are not comparable mistakes.
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(v)) return null;
    return v;
  }

  /** `sqCmdTab` → `sq-cmd-tab`. Readable in a feed, still an identifier. */
  function kebab(v) {
    var id = identifier(v);
    if (!id) return null;
    return id
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[_.\s]+/g, '-')
      .toLowerCase()
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, KEY_MAX) || null;
  }

  // ── rate ceilings ─────────────────────────────────────────────────────────
  // A sliding one-minute count per class. Not a token bucket: the question is
  // "has this class already said enough this minute", and a count answers it in
  // two lines rather than twenty.

  var counts = Object.create(null);
  var countWindowStartedAt = 0;

  function allow(cls, perMinute) {
    var now = Date.now();
    if (now - countWindowStartedAt >= 60000) { counts = Object.create(null); countWindowStartedAt = now; }
    var n = (counts[cls] || 0) + 1;
    counts[cls] = n;
    return n <= perMinute;
  }

  // ── context ───────────────────────────────────────────────────────────────

  /**
   * The module on screen, from the shell rather than from a variable here.
   *
   * `navTo` activates exactly one `.page` and names it `pg-<module>`, so the DOM
   * already holds the answer and a second copy of it here could only ever drift.
   */
  function activeModule() {
    try {
      var el = document.querySelector('.page.active');
      if (!el || !el.id) return null;
      return kebab(el.id.replace(/^pg-/, '')) || null;
    } catch (_) { return null; }
  }

  function clubId() {
    try {
      return (window.State && State.context && State.context.clubId)
        || (window.State && State.club && State.club.id) || null;
    } catch (_) { return null; }
  }
  function teamId() {
    try {
      return (window.State && State.context && State.context.teamId)
        || (window.State && State.currentTeamId) || null;
    } catch (_) { return null; }
  }
  function routeNow() {
    try { return (window.location && window.location.pathname) || null; } catch (_) { return null; }
  }

  /** The single exit. Everything in this file goes through it or goes nowhere. */
  function emit(name, feature, extra) {
    try {
      if (!window.FamilistaAnalytics || !window.FamilistaAnalytics.event) return;
      var fields = {
        module: (extra && extra.module) || activeModule(),
        route: routeNow(),
        clubId: clubId(),
        teamId: teamId(),
      };
      var f = feature ? kebab(feature) : null;
      if (f) fields.feature = f;
      if (extra && typeof extra.durationMs === 'number') fields.durationMs = extra.durationMs;
      window.FamilistaAnalytics.event(name, fields);
    } catch (_) { /* telemetry never reaches the product */ }
  }

  // ── opt-out, and the one element kind that is never looked at ─────────────

  function optedOut(el) {
    try { return !!(el && el.closest && el.closest('[data-fam-none]')); } catch (_) { return false; }
  }

  /**
   * A password field's neighbourhood is not observed at all.
   *
   * Nothing in this file reads a value, so no password could leak through it
   * anyway. This exists so the guarantee does not rest on that reasoning alone:
   * hover regions, pointer regions and form keys all refuse to resolve inside
   * one, and the refusal is a line of code a reviewer can point at.
   */
  function nearPassword(el) {
    try {
      if (!el || !el.closest) return false;
      if (el.matches && el.matches('input[type="password"]')) return true;
      var host = el.closest('form, [data-fam-form], fieldset, section, div');
      return !!(host && host.querySelector && host.querySelector('input[type="password"]'));
    } catch (_) { return false; }
  }

  // ── STAGE 3 — semantic interaction ────────────────────────────────────────

  /**
   * The declared key on an element, preferring the explicit attribute.
   *
   * Returns `{ kind, key }` where kind is one of the semantic roles below. The
   * fallback chain reads the app's existing code identifiers, which is what
   * instruments sixty screens without sixty edits.
   */
  var FAM_ATTRS = [
    ['tab',    'data-fam-tab'],
    ['panel',  'data-fam-panel'],
    ['modal',  'data-fam-modal'],
    ['menu',   'data-fam-menu'],
    ['card',   'data-fam-card'],
    ['filter', 'data-fam-filter'],
    ['search', 'data-fam-search'],
    ['action', 'data-fam-action'],
  ];

  function declared(el) {
    for (var i = 0; i < FAM_ATTRS.length; i++) {
      var kind = FAM_ATTRS[i][0], attr = FAM_ATTRS[i][1];
      var host = el.closest('[' + attr + ']');
      if (host) {
        var key = kebab(host.getAttribute(attr));
        if (key) return { kind: kind, key: key, el: host };
      }
    }
    return null;
  }

  /**
   * What an undeclared control is, inferred from the action name it already has.
   *
   * These are the app's own conventions — `sqCmdTab`, `sqMxClose`, `trArrange`,
   * `openPlayerModal` — read as the vocabulary they already are. An explicit
   * `data-fam-*` always wins; this is what the rest of the product gets for
   * free until it grows one.
   */
  function inferred(name) {
    var n = String(name);
    var l = n.toLowerCase();
    if (/tab$/.test(l) || /^tab/.test(l))                      return 'tab_changed';
    if (/playermodal|playercard|openplayer/.test(l))           return 'player_card_opened';
    if (/matchmodal|matchcard|openmatch/.test(l))              return 'match_card_opened';
    if (/formation/.test(l))                                   return 'formation_changed';
    if (/(menu)/.test(l))                                      return 'menu_opened';
    if (/(filter|sort)/.test(l))                               return 'filter_changed';
    if (/search/.test(l))                                      return 'search_used';
    if (/(modal|dialog)/.test(l))                              return /close|cancel|dismiss/.test(l) ? 'modal_closed' : 'modal_opened';
    if (/(panel|overlay|drawer|window|win|sheet)/.test(l))     return /close|min|hide/.test(l) ? 'panel_closed' : 'panel_opened';
    if (/(save|submit|apply|confirm|create|update|publish)/.test(l)) return 'save_attempted';
    return 'action_invoked';
  }

  var DECLARED_EVENT = {
    tab: 'tab_changed',
    menu: 'menu_opened',
    filter: 'filter_changed',
    search: 'search_used',
  };

  function eventForDeclared(d) {
    if (DECLARED_EVENT[d.kind]) return DECLARED_EVENT[d.kind];
    if (d.kind === 'card') {
      return d.key === 'match' ? 'match_card_opened' : 'player_card_opened';
    }
    if (d.kind === 'panel' || d.kind === 'modal') {
      // `data-fam-open="0"` on the same element says this control CLOSES it.
      var closes = d.el.getAttribute('data-fam-open') === '0'
        || /(^|-)close$/.test(d.key) || /(^|-)cancel$/.test(d.key);
      return d.kind === 'panel'
        ? (closes ? 'panel_closed' : 'panel_opened')
        : (closes ? 'modal_closed' : 'modal_opened');
    }
    return inferred(d.key);
  }

  /**
   * One delegated click listener, in the capture phase, for the whole product.
   *
   * Capture rather than bubble so a handler that stops propagation — and this
   * app has several — cannot make an interaction invisible. Passive, so it can
   * never delay the gesture it is observing.
   *
   * A keyboard activation of a button fires `click` too, which is exactly why
   * there is no key listener anywhere in this file: the fact worth recording is
   * that the action was invoked, not which device invoked it.
   */
  function onClick(ev) {
    try {
      var t = ev && ev.target;
      if (!t || !t.closest) return;
      if (optedOut(t)) return;

      var d = declared(t);
      var name, key;
      if (d) {
        name = eventForDeclared(d);
        key = d.key;
      } else {
        var host = t.closest('[data-action],[data-nav],[data-page],[data-tab],[data-match-tab]');
        if (!host) return;
        var raw = host.getAttribute('data-tab') || host.getAttribute('data-match-tab');
        if (raw) { name = 'tab_changed'; }
        else {
          raw = host.getAttribute('data-action') || host.getAttribute('data-nav') || host.getAttribute('data-page');
          // Navigation is reported by `navTo`, which knows whether it happened.
          // Reporting the click as well would double every module open.
          if (!raw || host.hasAttribute('data-nav') || host.hasAttribute('data-page')) return;
          name = inferred(raw);
        }
        key = kebab(raw);
        if (!key) return;
      }

      // Club entry, sign-in and sign-out are reported by the functions that
      // perform them, because only those know whether they succeeded. A click
      // on the control is an intention, and the board shows facts.
      if (/^(open-club|do-login|do-logout)$/.test(key)) return;

      var cls = name === 'action_invoked' ? 'action' : 'ui';
      if (!allow(cls, cls === 'action' ? ACTION_PER_MIN : NAV_PER_MIN)) return;
      emit(name, key);
    } catch (_) { /* a click must never fail because of this */ }
  }

  // ── forms ─────────────────────────────────────────────────────────────────
  // `form_started` fires once per form per module visit, on the first focus
  // INSIDE it. The listener is `focusin`, which reports that a field was
  // entered; it is not `input`, which would fire per keystroke, and it reads
  // no value in either case.

  var startedForms = Object.create(null);

  function formKey(el) {
    try {
      var host = el.closest && el.closest('[data-fam-form], form');
      if (!host || nearPassword(host)) return null;
      return kebab(host.getAttribute('data-fam-form') || host.id || 'form');
    } catch (_) { return null; }
  }

  function onFocusIn(ev) {
    try {
      var t = ev && ev.target;
      if (!t || optedOut(t)) return;
      if (!t.matches || !t.matches('input, textarea, select')) return;
      var key = formKey(t);
      if (!key || startedForms[key]) return;
      startedForms[key] = 1;
      if (!allow('ui', NAV_PER_MIN)) return;
      emit('form_started', key);
    } catch (_) {}
  }

  function onSubmit(ev) {
    try {
      var key = formKey(ev && ev.target) || 'form';
      if (!allow('action', ACTION_PER_MIN)) return;
      emit('save_attempted', key);
    } catch (_) {}
  }

  // ── drag and drop ─────────────────────────────────────────────────────────
  // The destination SLOT, never a coordinate. "Player put in left-back" is a
  // tactical fact worth a trend line; "player released at 412,208" is a mouse
  // trace, and this file does not keep those.

  var draggingKey = null;

  function onDragStart(ev) {
    try {
      var t = ev && ev.target;
      var host = t && t.closest && t.closest('[data-fam-drag]');
      draggingKey = host ? kebab(host.getAttribute('data-fam-drag')) : null;
    } catch (_) { draggingKey = null; }
  }

  function onDrop(ev) {
    try {
      var t = ev && ev.target;
      var zone = t && t.closest && t.closest('[data-fam-drop]');
      var slot = zone ? kebab(zone.getAttribute('data-fam-drop')) : null;
      if (!allow('action', ACTION_PER_MIN)) return;
      if (draggingKey === 'player' && slot) emit('player_moved', slot);
      else if (draggingKey || slot) emit('drag_completed', slot || draggingKey);
    } catch (_) { } finally { draggingKey = null; }
  }

  // ── STAGE 4 — pointer, as windows ─────────────────────────────────────────
  /**
   * The pointer produces at most one event per window, and nothing at all when
   * it is still.
   *
   * A window opens on the first movement after a quiet period. Every subsequent
   * movement inside it is absorbed — counted towards the region tally and
   * nothing else. The window closes when the pointer has been still for
   * POINTER_IDLE_MS or when it has been open for POINTER_WINDOW_MS, whichever
   * comes first, and emits ONE `pointer_active` carrying the region the pointer
   * spent most of the window in and how long the window was.
   *
   * Consequences worth stating plainly: a person sweeping the mouse for a solid
   * minute produces twenty events, not four hundred samples and not sixty
   * thousand pixels. A person reading a page without touching the mouse
   * produces none, so the board goes quiet when the platform is quiet — which
   * is the entire point of it.
   */
  var pWindowOpenedAt = 0;
  var pLastSampleAt = 0;
  var pRegions = null;
  var pIdleTimer = null;
  var pMaxTimer = null;

  function regionOf(el) {
    try {
      if (!el || !el.closest || nearPassword(el)) return null;
      var host = el.closest('[data-fam-region]');
      if (host) return kebab(host.getAttribute('data-fam-region'));
      return null;
    } catch (_) { return null; }
  }

  function closePointerWindow() {
    try {
      if (pIdleTimer) { clearTimeout(pIdleTimer); pIdleTimer = null; }
      if (pMaxTimer) { clearTimeout(pMaxTimer); pMaxTimer = null; }
      if (!pWindowOpenedAt) return;

      var duration = Math.max(0, pLastSampleAt - pWindowOpenedAt);
      var dominant = null, best = 0;
      for (var k in pRegions) if (pRegions[k] > best) { best = pRegions[k]; dominant = k; }

      pWindowOpenedAt = 0;
      pRegions = null;

      // A window with a single sample in it is a twitch, not interaction.
      if (duration < POINTER_SAMPLE_MS) return;
      if (!allow('pointer', POINTER_PER_MIN)) return;
      emit('pointer_active', dominant, { durationMs: duration });
    } catch (_) {}
  }

  function onPointerMove(ev) {
    try {
      var now = Date.now();
      if (now - pLastSampleAt < POINTER_SAMPLE_MS) return;   // throttled, not queued
      pLastSampleAt = now;

      if (!pWindowOpenedAt) {
        pWindowOpenedAt = now;
        pRegions = Object.create(null);
        pMaxTimer = setTimeout(closePointerWindow, POINTER_WINDOW_MS);
      }
      var r = regionOf(ev && ev.target) || activeModule();
      if (r) pRegions[r] = (pRegions[r] || 0) + 1;

      if (pIdleTimer) clearTimeout(pIdleTimer);
      pIdleTimer = setTimeout(closePointerWindow, POINTER_IDLE_MS);
    } catch (_) {}
  }

  // ── STAGE 4 — scroll, as thresholds ───────────────────────────────────────
  /**
   * Four events per module visit, maximum, and usually fewer.
   *
   * Depth is computed from the element that actually scrolled — Familista's
   * workspaces scroll inside themselves rather than moving the page — and each
   * of 25/50/75/100% is reported once. Scrolling back up and down again crosses
   * no NEW threshold, so it produces nothing. A short page that is fully
   * visible reaches 100% on its first scroll and then goes silent.
   *
   * No offset, no pixel count, no direction history: a threshold is the whole
   * of what is recorded.
   */
  var reached = Object.create(null);
  var scrollModule = null;
  var lastScrollAt = 0;

  function depthOf(target) {
    try {
      var el = (target && target.nodeType === 1) ? target : document.scrollingElement || document.documentElement;
      var h = el.scrollHeight || 0;
      var view = el.clientHeight || 0;
      var scrollable = h - view;
      if (scrollable <= 8) return null;             // nothing to scroll: no depth exists
      var pct = ((el.scrollTop || 0) / scrollable) * 100;
      return Math.max(0, Math.min(100, pct));
    } catch (_) { return null; }
  }

  function onScroll(ev) {
    try {
      var now = Date.now();
      if (now - lastScrollAt < SCROLL_THROTTLE_MS) return;
      lastScrollAt = now;

      var mod = activeModule();
      if (mod !== scrollModule) { scrollModule = mod; reached = Object.create(null); }

      var pct = depthOf(ev && ev.target);
      if (pct === null) return;

      for (var i = 0; i < SCROLL_THRESHOLDS.length; i++) {
        var t = SCROLL_THRESHOLDS[i];
        if (pct + 0.5 >= t && !reached[t]) {
          reached[t] = 1;
          if (!allow('scroll', SCROLL_PER_MIN)) return;
          emit('scroll_depth', 'depth_' + t);
        }
      }
    } catch (_) {}
  }

  // ── STAGE 4 — hover, as bucketed dwell over declared regions ──────────────
  /**
   * Opt-in only, and never one event per `mouseenter`.
   *
   * A region must say so in the markup — `data-fam-region="player-card"` — and
   * the pointer must rest on it for at least HOVER_MIN_MS. What is recorded is
   * the region key and a BUCKET: 500ms, 1s, 2s, 5s, 10s, 30s. The exact dwell
   * is deliberately thrown away, because "this person looked at this card for
   * 3,417ms" is a behavioural fingerprint and "between 2 and 5 seconds" is the
   * attention signal the product actually wanted.
   *
   * Undeclared DOM produces nothing at all. There is no path here by which
   * moving over an arbitrary element records anything about it.
   */
  var hoverKey = null;
  var hoverStartedAt = 0;

  function bucket(ms) {
    for (var i = 0; i < HOVER_BUCKETS.length; i++) if (ms <= HOVER_BUCKETS[i]) return HOVER_BUCKETS[i];
    return HOVER_BUCKETS[HOVER_BUCKETS.length - 1];
  }

  function endHover() {
    try {
      if (!hoverKey) return;
      var dwell = Date.now() - hoverStartedAt;
      var key = hoverKey;
      hoverKey = null;
      hoverStartedAt = 0;
      if (dwell < HOVER_MIN_MS) return;                 // passing through, not attention
      if (!allow('hover', HOVER_PER_MIN)) return;
      emit('region_dwell', key, { durationMs: bucket(dwell) });
    } catch (_) {}
  }

  function onPointerOver(ev) {
    try {
      var t = ev && ev.target;
      if (optedOut(t)) return;
      var host = t && t.closest && t.closest('[data-fam-region]');
      var key = host && !nearPassword(host) ? kebab(host.getAttribute('data-fam-region')) : null;
      if (key === hoverKey) return;                     // same region, moving inside it
      endHover();
      if (!key) return;
      hoverKey = key;
      hoverStartedAt = Date.now();
    } catch (_) {}
  }

  // ── platform health, from the client's point of view ──────────────────────

  function onOffline() { if (allow('err', ERROR_PER_MIN)) emit('offline', 'network'); }
  function onOnline()   { if (allow('err', ERROR_PER_MIN)) emit('reconnected', 'network'); }

  function onWindowError(ev) {
    try {
      // The error's MESSAGE is not recorded. A thrown string can contain
      // anything a developer put in it, including a value from a form, so what
      // travels is the fact that a script error happened in this module and
      // nothing about what it said. The message belongs in the console, which
      // is where it already is.
      if (!allow('err', ERROR_PER_MIN)) return;
      emit('client_error', 'script');
    } catch (_) {}
  }

  function onRejection() {
    try {
      if (!allow('err', ERROR_PER_MIN)) return;
      emit('client_error', 'promise');
    } catch (_) {}
  }

  // ── mutating requests, as save outcomes ───────────────────────────────────
  /**
   * `save_succeeded` and `save_failed` from the one place that knows.
   *
   * A click can report that a save was ATTEMPTED; only the request knows
   * whether it worked. Rather than editing several hundred call sites, the
   * shared client is wrapped once: a resolved POST/PUT/PATCH/DELETE is a save
   * that succeeded, a rejected one is a save that failed, and the key is the
   * route SHAPE — `/players/:id`, never `/players/8f3a-…`.
   *
   * The wrapper is transparent. It returns the same promise, resolves the same
   * value and rethrows the same error; the telemetry hangs off the side of it
   * inside its own try/catch. Auth and telemetry routes are excluded — the
   * first is reported by the sign-in path, and the second would observe itself.
   */
  function routeKey(url) {
    try {
      return String(url || '')
        .split('?')[0]
        .split('/')
        .map(function (seg) {
          if (!seg) return seg;
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return 'id';
          if (/^\d+$/.test(seg)) return 'n';
          if (seg.length > 24) return 'id';
          return seg;
        })
        .filter(Boolean)
        .join('-')
        .replace(/[^A-Za-z0-9_.:-]+/g, '-')
        .slice(0, KEY_MAX) || null;
    } catch (_) { return null; }
  }

  function wrapApi() {
    try {
      var api = window.FamilistaAPI;
      if (!api || typeof api.request !== 'function' || api.__famTelemetryWrapped) return;
      var original = api.request.bind(api);
      api.request = function (path, options) {
        var method = String((options && options.method) || 'GET').toUpperCase();
        var url = String(path || '');
        var watched = /^(POST|PUT|PATCH|DELETE)$/.test(method)
          && !/\/auth\//.test(url) && !/\/telemetry/.test(url);
        var out = original(path, options);
        if (!watched || !out || typeof out.then !== 'function') return out;
        try {
          var key = routeKey(url);
          out.then(
            function () { try { if (allow('action', ACTION_PER_MIN)) emit('save_succeeded', key); } catch (_) {} },
            function () { try { if (allow('err', ERROR_PER_MIN)) emit('save_failed', key); } catch (_) {} }
          ).catch(function () {});
        } catch (_) {}
        return out;
      };
      api.__famTelemetryWrapped = true;
    } catch (_) { /* an unwrappable client is not a reason to break the page */ }
  }

  // ── installation ──────────────────────────────────────────────────────────

  var installed = false;

  function install() {
    if (installed) return;
    installed = true;
    countWindowStartedAt = Date.now();

    var passive = { passive: true, capture: true };
    try {
      document.addEventListener('click', onClick, { capture: true });
      document.addEventListener('focusin', onFocusIn, passive);
      document.addEventListener('submit', onSubmit, { capture: true });
      document.addEventListener('dragstart', onDragStart, passive);
      document.addEventListener('drop', onDrop, passive);
      document.addEventListener('pointermove', onPointerMove, passive);
      document.addEventListener('pointerover', onPointerOver, passive);
      // Scroll in the capture phase because Familista's workspaces scroll
      // INSIDE themselves and a scroll event on an inner element does not bubble.
      document.addEventListener('scroll', onScroll, passive);
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
      window.addEventListener('error', onWindowError);
      window.addEventListener('unhandledrejection', onRejection);
      // A window left open when the tab hides would otherwise report a duration
      // that includes the time the tab was in the background.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { closePointerWindow(); endHover(); }
      });
    } catch (_) {}

    wrapApi();
  }

  // ── the surface app.js calls ──────────────────────────────────────────────
  // Five facts a DOM listener cannot know: whether a sign-in succeeded, whether
  // a club was actually entered, which module a navigation landed on, which
  // player a modal opened, and what an API error was. Each is one guarded line
  // at the place that knows.

  window.FamTelemetry = {
    install: install,

    /** Sign-in and sign-out. `ok` decides which of the two AUTH facts is true. */
    auth: function (kind) {
      if (kind === 'in') emit('login_succeeded', 'password');
      else if (kind === 'failed') emit('login_failed', 'password');
      else if (kind === 'out') emit('logout', 'user');
      else if (kind === 'expired') emit('session_expired', 'token');
    },

    /** Club scope changing. Reported after the switch, not on the click. */
    club: function (enteredId, leftId) {
      if (leftId && leftId !== enteredId) emit('club_exited', 'club');
      if (enteredId) emit('club_entered', 'club');
    },

    /** One navigation, reported by `navTo` once it has decided where it went. */
    nav: function (page) {
      var key = kebab(page);
      if (!key) return;
      if (!allow('nav', NAV_PER_MIN)) return;
      // Leaving a module ends whatever the pointer and the hover were doing in
      // it; carrying those into the next module would attribute attention to
      // the wrong screen.
      closePointerWindow();
      endHover();
      reached = Object.create(null);
      startedForms = Object.create(null);
      emit('route_changed', key, { module: key });
      emit('page_viewed', key, { module: key });
    },

    /** The workspace or team context switching underneath an unchanged module. */
    workspace: function (key) {
      if (allow('nav', NAV_PER_MIN)) emit('workspace_changed', key || 'workspace');
    },

    /** A card that opened for real, from the function that opened it. */
    card: function (kind) {
      if (!allow('ui', NAV_PER_MIN)) return;
      emit(kind === 'match' ? 'match_card_opened' : 'player_card_opened', kind || 'player');
    },

    /** A save whose outcome the caller knows better than the request does. */
    save: function (key, ok) {
      if (!allow('action', ACTION_PER_MIN)) return;
      emit(ok ? 'save_succeeded' : 'save_failed', key);
    },

    /** A pitch change worth a trend line. `slot` is a position key, never a point. */
    moved: function (slot) {
      if (allow('action', ACTION_PER_MIN)) emit('player_moved', slot);
    },
    formation: function (key) {
      if (allow('action', ACTION_PER_MIN)) emit('formation_changed', key);
    },

    /**
     * An API error, by CODE.
     *
     * `NETWORK`, `AUTH`, `SERVER`, `VALIDATION` — the classification the client
     * already assigns. Never the server's message, which is text and may quote
     * a value the caller sent.
     */
    error: function (code) {
      if (!allow('err', ERROR_PER_MIN)) return;
      emit('api_error', code || 'unknown');
    },

    /** For tests, and for anybody reading the console. */
    _limits: function () {
      return {
        POINTER_SAMPLE_MS: POINTER_SAMPLE_MS, POINTER_IDLE_MS: POINTER_IDLE_MS,
        POINTER_WINDOW_MS: POINTER_WINDOW_MS, POINTER_PER_MIN: POINTER_PER_MIN,
        SCROLL_THROTTLE_MS: SCROLL_THROTTLE_MS, SCROLL_THRESHOLDS: SCROLL_THRESHOLDS,
        SCROLL_PER_MIN: SCROLL_PER_MIN,
        HOVER_MIN_MS: HOVER_MIN_MS, HOVER_BUCKETS: HOVER_BUCKETS, HOVER_PER_MIN: HOVER_PER_MIN,
        ACTION_PER_MIN: ACTION_PER_MIN, NAV_PER_MIN: NAV_PER_MIN, ERROR_PER_MIN: ERROR_PER_MIN,
        KEY_MAX: KEY_MAX,
      };
    },
    _identifier: identifier,
    _kebab: kebab,
    _state: function () {
      return { installed: installed, hoverKey: hoverKey, pointerOpen: !!pWindowOpenedAt, counts: counts };
    },
  };

  // Installed on load rather than on sign-in: the listeners are inert until
  // `FamilistaAnalytics` has a session and a token, and installing once here is
  // simpler than re-installing on every navigation.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
}());
