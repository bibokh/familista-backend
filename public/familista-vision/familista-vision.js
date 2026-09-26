/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA VISION — the workstation
   ─────────────────────────────────────────────────────────────────────────────

   WHAT THIS FILE IS

   The presentation layer for the Vision module: a global bar, a module row, a
   persistent rail of sections, and eighteen screens built around one rule —
   the football surface leads, the controls follow, the diagnostics come third
   and the table comes last.

   WHAT IT IS NOT

   It is not a dashboard. There is no grid of equal cards, and no screen opens
   with a table. The engine, its thresholds, its gates, the normaliser and
   every API this reads are untouched; only the composition above them is new.

   THE ONE RULE THAT OUTRANKS EVERY LAYOUT DECISION

   This layer may not decide anything the engine declined to decide.

     · A measured zero is `0`. A figure the platform does not hold is `—`.
     · OBSERVED and PROPAGATED are two findings and are never summed.
     · A trajectory breaks wherever the record breaks. A smooth line across
       frames nobody saw is a picture of an assumption.
     · Proximity is not possession, and this module never implies it is.
     · A reading with no validated value says so and says what it waits on.
       It does not borrow a number from somewhere else to look complete.

   WHAT THE DEPLOYMENT DOES NOT SERVE

   Video. The engine stores evidence, not media, so the stage draws the real
   detections at their real image coordinates over an empty frame and says on
   its face that the source video is not served here. A black rectangle
   labelled "live feed" would be a lie about a capability that does not exist.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /**
   * WHERE THE API IS, AND WHAT PROVES WHO IS ASKING.
   *
   * Both of these were wrong, and the module hung on "READING VISION SERVICE"
   * in production because of it.
   *
   * The base is the platform's, not a constant. `FAM_CONFIG.API_BASE` is an
   * absolute URL when the SPA and the API are different origins; a hard-coded
   * `/api/v1` points at the page's own host, which is the wrong host there.
   *
   * The credential is the platform's too. Familista authenticates with an
   * HttpOnly `access_token` cookie AND an in-memory access token, and the
   * second is not a fallback — it is what a session runs on after
   * `/auth/refresh`, because the cookie's TTL is fifteen minutes. Sending only
   * the cookie meant Vision worked for fifteen minutes after a sign-in and
   * 401ed for the rest of the session, while every other module — all of which
   * attach the bearer — kept working. That is exactly the shape of the bug: the
   * landing card read the Vision service fine, and the module behind it could
   * not.
   *
   * Source Core, the Data Vault and Infrastructure City all do what is below.
   * This is not a new convention; it is the one Vision was missing.
   */
  function apiBase() {
    return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE)
      ? window.FAM_CONFIG.API_BASE : '/api/v1';
  }

  function authToken() {
    try {
      return (window.State && window.State.token) || localStorage.getItem('familista_token') || '';
    } catch (_) { return ''; }
  }

  function authHeaders(extra) {
    var t = authToken();
    return Object.assign({ Accept: 'application/json' },
      t ? { Authorization: 'Bearer ' + t } : {}, extra || {});
  }

  /* A session holds ten thousand observations. A browser asked to lay out ten
     thousand rows stops being an instrument, so tables are windowed and say
     how many rows they did not lay out. */
  var TABLE_WINDOW = 300;

  var FV = {
    section: 'live',
    status: null, sessions: null, sources: null, models: null,
    device: null, integrations: null,
    sessionRef: null, session: null, timeline: null,
    frame: 0,
    mode: 'frame',
    layers: { boxes: true, ids: true, ball: true, trails: false, heat: false, lines: true, zones: false },
    filters: { track: '', team: '', role: '', conf: '', session: '', source: '' },
    selection: { track: null, event: null, node: null, heatTeam: '', heatPlayer: '' },

    /* ── lifecycle ────────────────────────────────────────────────────────────
       `booted` says the catalogue reads have run at least once, so a re-mount
       repaints what is already held instead of refetching and rebuilding.
       `loading` is the in-flight guard: a second boot while the first is still
       in the air used to start a second, racing openSession.
       `loadToken` orders session reads — a slow answer for a session the reader
       has already navigated away from must not overwrite a newer one.
       `sessionGone` records that a REMEMBERED session no longer exists, which
       is a different empty state from never having chosen one. */
    booted: false, loading: false, loadToken: 0, sessionGone: null, bound: false,
    inflightRef: null,
  };

  /* ═══════════════════════════════════════════════════════════════════════════
     THE SELECTION IS STATE, AND STATE THAT IS NOT WRITTEN DOWN IS LOST
     ═══════════════════════════════════════════════════════════════════════════

     Which session is open, and which section is being read, survived nothing:
     not a tab change, not leaving the module, not a refresh. There was no
     canonical record of the choice anywhere — the module re-derived it on every
     mount by opening `sessions[0]`, which is not the reader's selection, it is
     a guess that happens to be right once.

     It is written down now, in `sessionStorage`:

       · sessionStorage, not localStorage, because a Vision selection belongs to
         the tab the reader is working in. Two tabs on two sessions is a normal
         thing to want, and localStorage would make them fight.
       · keyed by user id, so a selection never restores under a different
         account on a shared machine.
       · holding a REFERENCE, never a payload. The session itself is always
         re-read from the API and re-authorised on restore; the browser
         remembers WHICH session, and the server remains the only thing that
         decides whether it may be opened.

     Every accessor is wrapped: storage throws in a private window, and a module
     that cannot remember a choice must still work, not fail to draw.
  */

  var STORE_VERSION = 'v1';

  function storeKey() {
    var u = (window.State && window.State.user) || {};
    return 'familista.vision.' + STORE_VERSION + '.' + (u.id || u.email || 'anon');
  }

  function readStore() {
    try {
      var raw = window.sessionStorage.getItem(storeKey());
      if (!raw) return {};
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : {};
    } catch (_) { return {}; }
  }

  function writeStore(patch) {
    try {
      var next = Object.assign(readStore(), patch);
      window.sessionStorage.setItem(storeKey(), JSON.stringify(next));
    } catch (_) { /* a forgotten choice is a lesser fault than a broken module */ }
  }

  function rememberSession(ref) { writeStore({ sessionRef: ref || null }); }
  function rememberSection(id) { writeStore({ section: id || null }); }

  /* ── primitives ──────────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** A measured zero is 0. A figure the platform does not hold is an em dash. */
  function n(v, digits) {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) {
      return '<span class="vx-none" title="not held by the platform">—</span>';
    }
    if (typeof v !== 'number') return esc(v);
    return esc(digits === undefined ? String(v) : v.toFixed(digits));
  }

  function pct(v, digits) {
    if (v === null || v === undefined) return '<span class="vx-none">—</span>';
    return esc((v * 100).toFixed(digits === undefined ? 1 : digits)) + '%';
  }

  /** The engine's `reasons` are clauses; joined to a sentence of ours they ran on. */
  function sentence(text) {
    var t = String(text || '').trim();
    if (!t) return t;
    return /[.!?…]$/.test(t) ? t : t + '.';
  }

  function words(s) { return String(s || '').replace(/_/g, ' '); }

  /* ── icons: one set, stroked, 24-grid ────────────────────────────────────── */

  var ICONS = {
    live:     '<path d="M4 4l14 8-14 8z"/>',
    sessions: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    sources:  '<rect x="3" y="6" width="18" height="11" rx="2"/><path d="M9 21h6M12 17v4"/>',
    device:   '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    track:    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8.5"/>',
    ball:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5l3.2 5-3.2 4.2-3.2-4.2z"/>',
    calib:    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 5v14"/>',
    teams:    '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1.5A4.5 4.5 0 017.5 14h3A4.5 4.5 0 0115 18.5V20"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14h.5a3.5 3.5 0 013.5 3.5V20"/>',
    events:   '<path d="M12 3l2.5 6.4 6.5.5-5 4.3 1.6 6.8L12 17.4 6.4 21l1.6-6.8-5-4.3 6.5-.5z"/>',
    tactical: '<path d="M12 3l9 5v8l-9 5-9-5V8z"/><path d="M12 8v8M8 10l8 4M16 10l-8 4"/>',
    heat:     '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10h3v3H7zM13 13h4v4h-4z"/>',
    timeline: '<path d="M3 12h18"/><circle cx="7" cy="12" r="2.2"/><circle cx="16" cy="12" r="2.2"/>',
    reports:  '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
    models:   '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    flow:     '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6.7 7.4L11 16M17.3 7.4L13 16"/>',
    health:   '<path d="M3 12h4l2-5 3 10 2.5-6 1.5 3h5"/>',
    logs:     '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    config:   '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.2 2.2M17.6 17.6l2.2 2.2M2 12h3M19 12h3M4.2 19.8l2.2-2.2M17.6 6.4l2.2-2.2"/>',
    ai:       '<rect x="4" y="5" width="16" height="13" rx="3"/><circle cx="9" cy="11" r="1.4"/><circle cx="15" cy="11" r="1.4"/><path d="M12 2v3M9 18v3M15 18v3"/>',
    insight:  '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 013.5 10.9V16h-7v-2.1A6 6 0 0112 3z"/>',
    perf:     '<path d="M4 18l5-6 4 3 7-9"/><path d="M14 6h6v6"/>',
    compare:  '<path d="M6 4v16M18 4v16M6 8h12M6 16h12"/>',
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    core:     '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8.6"/>',
    clubs:    '<path d="M4 20V9l8-5 8 5v11z"/><path d="M9 20v-6h6v6"/>',
    vault:    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    city:     '<path d="M12 3l9 5v13H3V8z"/><path d="M9 21v-6h6v6"/>',
    vision:   '<path d="M4 12V6.5A2.5 2.5 0 016.5 4H12M28 4h5.5" transform="scale(.6)"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
    search:   '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
    bell:     '<path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
    camera:   '<path d="M3 7h4l2-2h6l2 2h4v12H3z"/><circle cx="12" cy="13" r="3.4"/>',
    drone:    '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="18" r="2.4"/><rect x="9" y="9" width="6" height="6" rx="1.4"/>',
    node:     '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    pod:      '<rect x="7" y="3" width="10" height="18" rx="4.5"/><path d="M12 8v5"/>',
    sensor:   '<circle cx="12" cy="12" r="3.6"/><path d="M5.5 5.5a9 9 0 000 13M18.5 5.5a9 9 0 010 13"/>',
    cpu:      '<rect x="7" y="7" width="10" height="10" rx="1.6"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>',
    grid2d:   '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18M12 5v14"/>',
    cube3d:   '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    lines:    '<path d="M4 18c4-9 12-9 16 0"/><path d="M4 12h16"/>',
    zones:    '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>',
    play:     '<path d="M6 4l14 8-14 8z"/>',
    prev:     '<path d="M15 5l-8 7 8 7"/>',
    next:     '<path d="M9 5l8 7-8 7"/>',
    back10:   '<path d="M11 5l-6 5 6 5"/><path d="M5 10h9a5 5 0 110 10h-3"/>',
    fwd10:    '<path d="M13 5l6 5-6 5"/><path d="M19 10h-9a5 5 0 100 10h3"/>',
    stop:     '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    shot:     '<path d="M4 7h4l2-2h4l2 2h4v11H4z"/><circle cx="12" cy="12" r="3"/>',
    absent:   '<circle cx="12" cy="12" r="9" stroke-dasharray="2 3"/><path d="M12 8v5M12 16v.4"/>',
    future:   '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><path d="M12 7.5V12l3 2"/>',
    arrow:    '<path d="M5 12h14M13 6l6 6-6 6"/>',
    down:     '<path d="M12 4v12M6 12l6 6 6-6"/>',
  };

  function ico(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + (ICONS[name] || ICONS.node) + '</svg>';
  }

  /* ── atoms ───────────────────────────────────────────────────────────────── */

  function Tag(text, kind) {
    return '<span class="vx-tag' + (kind ? ' vx-tag--' + kind : '') + '">' + esc(text) + '</span>';
  }

  /** A status marker: a dot, a word, and never colour alone. */
  function Chip(label, state, title) {
    var s = String(state || 'NOT_AVAILABLE');
    return '<span class="vx-tag vx-s-' + esc(s) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<i class="vx-dot"></i>' + (label ? esc(label) + ' ' : '') + esc(words(s)) + '</span>';
  }

  /**
   * A panel: a hairline, a dense header, and content. It is the only container
   * in this module, and it is deliberately tight — 12px of padding, an 8px
   * radius, one line of chrome. A workstation is read, not admired.
   */
  function Panel(title, inner, o) {
    o = o || {};
    return '<section class="vx-panel' + (o.accent ? ' vx-panel--accent' : '')
      + (o.flat ? ' vx-panel--flat' : '') + (o.cls ? ' ' + o.cls : '') + '">'
      + (title === null ? '' :
        '<div class="vx-ph">'
        + (o.ico ? '<span class="vx-ph-ico">' + ico(o.ico) + '</span>' : '')
        + '<h3 class="vx-ph-t">' + esc(title) + '</h3>'
        + (o.actions ? '<div class="vx-ph-a">' + o.actions + '</div>' : '')
        + '</div>')
      + '<div class="vx-pb' + (o.flush ? ' vx-pb--flush' : '') + (o.tight ? ' vx-pb--tight' : '') + '">'
      + inner + '</div></section>';
  }

  /** A reading: label, figure, qualifier. No box of its own unless asked. */
  function Stat(k, v, s, o) {
    o = o || {};
    return '<div class="vx-stat' + (o.tone ? ' vx-stat--' + o.tone : '')
      + (o.ico ? ' vx-stat--icon' : '') + '">'
      + (o.ico ? '<span class="vx-stat-ico">' + ico(o.ico) + '</span>' : '')
      + '<span class="vx-stat-k">' + esc(k) + '</span>'
      + '<span class="vx-stat-v">' + v + '</span>'
      + '<span class="vx-stat-s">' + (s === undefined || s === null ? '' : s) + '</span></div>';
  }

  function Rows(pairs) {
    return '<div class="vx-rows">' + pairs.filter(Boolean).map(function (p) {
      return '<div class="vx-row"><span class="vx-row-k">' + p[0]
        + (p[2] ? '<span>' + esc(p[2]) + '</span>' : '') + '</span>'
        + '<span class="vx-row-v">' + p[1] + '</span></div>';
    }).join('') + '</div>';
  }

  function Bar(value, kind) {
    return '<div class="vx-bar' + (kind ? ' vx-bar--' + kind : '') + '"><i style="width:'
      + Math.max(0, Math.min(100, (value || 0) * 100)).toFixed(1) + '%"></i></div>';
  }

  /** Every absence names what is missing and what would fill it. */
  function Empty(kind, title, why, mark) {
    return '<div class="vx-empty vx-empty--' + kind + '" role="status">'
      + '<span class="vx-empty-m">' + ico(mark || (kind === 'future' ? 'future' : 'absent')) + '</span>'
      + '<span class="vx-empty-t">' + esc(title) + '</span>'
      + '<p class="vx-empty-w">' + esc(sentence(why)) + '</p></div>';
  }

  /**
   * Four different absences, and they are not the same answer.
   *
   * "Nothing is open" and "the thing you had open has gone" and "this account
   * has no sessions at all" and "it is still loading" were all one screen
   * saying NO SESSION LOADED, which is why a failure was indistinguishable from
   * an empty account.
   */
  function needSession() {
    if (FV.sessionRef && !FV.session && !FV.sessionGone) {
      return Empty('withheld', 'OPENING SESSION',
        'Reading ' + FV.sessionRef + ' from the Vision service', 'sessions');
    }
    if (FV.sessionGone) {
      return Empty('withheld', 'SESSION NOT AVAILABLE',
        'The session ' + FV.sessionGone.ref + ' could not be opened — '
        + FV.sessionGone.why + '. Choose another under Sessions', 'sessions')
        + '<div class="vx-rowgap"></div>'
        + '<div class="vx-legend" style="justify-content:center">'
        + '<button class="vx-btn" type="button" data-vx-section="sessions">'
        + ico('sessions') + 'Open Sessions</button></div>';
    }
    if (FV.sessions && FV.sessions.ok && !FV.sessions.sessions.length) {
      return Empty('withheld', 'NO SESSIONS RECORDED',
        'This account has no processed Vision sessions yet. A session appears here once '
        + 'a source has been processed by the Vision engine', 'sessions');
    }
    return Empty('withheld', 'NO SESSION LOADED',
      'Open one under Sessions. Every figure in this module belongs to one processed '
      + 'session and none of them is an average across sessions', 'sessions')
      + '<div class="vx-rowgap"></div>'
      + '<div class="vx-legend" style="justify-content:center">'
      + '<button class="vx-btn" type="button" data-vx-section="sessions">'
      + ico('sessions') + 'Open Sessions</button></div>';
  }

  /**
   * A table, windowed.
   *
   * Only the first `TABLE_WINDOW` rows are laid out; the footer says how many
   * were not, because a silently truncated table has lied about its own size.
   */
  function Table(caption, headers, rows, o) {
    o = o || {};
    var shown = rows.slice(0, o.window || TABLE_WINDOW);
    var hidden = rows.length - shown.length;
    return '<div class="vx-tablewrap"' + (o.tall ? ' style="max-height:none"' : '') + '>'
      + '<table class="vx-table"><caption>' + esc(caption) + '</caption><thead><tr>'
      + headers.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + shown.join('') + '</tbody></table></div>'
      + (hidden > 0 ? '<div class="vx-tablefoot">Showing ' + shown.length + ' of ' + rows.length
        + ' rows. The rest are in the export — nothing was dropped, only not laid out.</div>' : '');
  }

  /* ── the pitch, in metres. Law 1. ────────────────────────────────────────── */

  function pitchFrame() {
    var L = 105, W = 68, out = [];
    for (var i = 0; i < 6; i++) {
      out.push('<rect class="vx-pitch-mow" x="' + (i * 17.5) + '" y="0" width="8.75" height="' + W + '"/>');
    }
    out.push('<rect x="0" y="0" width="105" height="68" class="vx-pitch-line"/>');
    out.push('<line x1="52.5" y1="0" x2="52.5" y2="68" class="vx-pitch-line"/>');
    out.push('<circle cx="52.5" cy="34" r="9.15" class="vx-pitch-line"/>');
    out.push('<circle cx="52.5" cy="34" r="0.4" class="vx-pitch-line" fill="rgba(255,255,255,.22)"/>');
    out.push('<rect x="0" y="13.84" width="16.5" height="40.32" class="vx-pitch-line"/>');
    out.push('<rect x="88.5" y="13.84" width="16.5" height="40.32" class="vx-pitch-line"/>');
    out.push('<rect x="0" y="24.84" width="5.5" height="18.32" class="vx-pitch-line"/>');
    out.push('<rect x="99.5" y="24.84" width="5.5" height="18.32" class="vx-pitch-line"/>');
    out.push('<circle cx="11" cy="34" r="0.4" class="vx-pitch-line" fill="rgba(255,255,255,.22)"/>');
    out.push('<circle cx="94" cy="34" r="0.4" class="vx-pitch-line" fill="rgba(255,255,255,.22)"/>');
    return out.join('');
  }

  function Pitch(inner, o) {
    o = o || {};
    return '<svg class="vx-pitch" viewBox="-3 -3 111 74" preserveAspectRatio="xMidYMid meet"'
      + ' role="img" aria-label="' + esc(o.label || 'Pitch map in metres') + '"'
      + (o.style ? ' style="' + o.style + '"' : '') + '>'
      + (FV.layers.lines || o.forceLines ? pitchFrame() : '') + inner + '</svg>';
  }

  /** The colour a track is drawn in: role first, then team. Never a guess. */
  function trackTone(t) {
    if (t.role === 'GOALKEEPER') return 'var(--v-amber)';
    if (t.role === 'REFEREE') return '#ffffff';
    if (t.role === 'UNKNOWN' || !t.teamId) return 'var(--v-violet)';
    return t.teamId === 'team_a' ? 'var(--v-cyan)' : 'var(--v-green)';
  }
  function trackToneClass(t) {
    if (t.role === 'GOALKEEPER') return 'gk';
    if (t.role === 'REFEREE') return 'ref';
    if (!t.teamId || t.teamId === 'UNASSIGNED') return '';
    return t.teamId === 'team_a' ? 'a' : 'b';
  }

  window.__FV = FV;

  /* ═══════════════════════════════════════════════════════════════════════════
     NAVIGATION
     ═══════════════════════════════════════════════════════════════════════════

     THE MODULE ROW is the platform's own rooms, and ONLY those. Every entry
     routes through `window.navTo` to a page the shell already owns.

     It used to carry Reports, Models, Devices and AI Assistant as well, which
     were not platform rooms at all — they were Vision's OWN rail sections,
     duplicated onto the top row. One destination reachable from two places in
     the same chrome, one of them mislabelled as a peer of Clubs and the Data
     Vault, is a lie about what the platform is made of. Vision's sections
     belong to Vision's rail; the row above it belongs to the platform. Vision
     still INTEGRATES with those rooms — it publishes evidence to the Data
     Vault and reads its lineage through Source Core — but integration is an
     API, not a menu entry.

     THE RAIL is Vision's own sections and nothing else, grouped by what a
     reader is DOING. An entry with `planned: …` is a section whose architecture
     exists and whose implementation does not; it opens and says so. It is not
     disabled and it is not marked N/A, because "N/A" beside a working product
     reads as broken rather than unbuilt.
  */

  var MODULES = [
    { id: 'owner-home',          label: 'Overview',            ico: 'overview', platform: true },
    { id: 'source-core',         label: 'Source Core',         ico: 'core',     platform: true },
    { id: 'clubs',               label: 'Clubs',               ico: 'clubs',    platform: true },
    { id: 'data-vault',          label: 'Data Vault',          ico: 'vault',    platform: true },
    { id: 'infrastructure-city', label: 'Infrastructure City', ico: 'city',     platform: true },
    { id: 'familista-vision',    label: 'Familista Vision',    ico: 'vision',   current: true },
    { id: 'settings',            label: 'Settings',            ico: 'settings', platform: true },
  ];

  var SECTIONS = [
    { id: 'live',        group: 'VISION', ico: 'live',     label: 'Live Analysis' },
    { id: 'sessions',    group: 'VISION', ico: 'sessions', label: 'Sessions' },
    { id: 'sources',     group: 'VISION', ico: 'sources',  label: 'Sources' },
    { id: 'device',      group: 'VISION', ico: 'device',   label: 'Device / Vision Hub' },
    { id: 'tracking',    group: 'VISION', ico: 'track',    label: 'Player Tracking' },
    { id: 'ball',        group: 'VISION', ico: 'ball',     label: 'Ball Tracking' },
    { id: 'calibration', group: 'VISION', ico: 'calib',    label: 'Pitch Calibration' },
    { id: 'teams',       group: 'VISION', ico: 'teams',    label: 'Teams & Roles' },
    { id: 'events',      group: 'VISION', ico: 'events',   label: 'Events' },
    { id: 'tactical',    group: 'VISION', ico: 'tactical', label: 'Tactical View', badge: 'PENDING' },
    { id: 'heatmaps',    group: 'VISION', ico: 'heat',     label: 'Heatmaps' },
    { id: 'timeline',    group: 'VISION', ico: 'timeline', label: 'Timeline' },
    { id: 'reports',     group: 'VISION', ico: 'reports',  label: 'Reports' },

    { id: 'ai',          group: 'INTELLIGENCE', ico: 'ai',      label: 'AI Assistant',
      planned: {
        what: 'A Vision-scoped assistant that answers questions about the open session — '
          + 'which frames carry the evidence behind a figure, why a track was withheld, '
          + 'what changed between two calibration attempts',
        why: 'Vision publishes its evidence to Familista Intelligence today. The assistant '
          + 'that reads it back has an architecture and no implementation',
        needs: 'a validated question-to-evidence retrieval path over session records' } },
    { id: 'insights',    group: 'INTELLIGENCE', ico: 'insight', label: 'Insights',
      planned: {
        what: 'Automatically surfaced findings from a processed session — a coverage collapse, '
          + 'a calibration drift, a stretch of frames the tracker lost',
        why: 'An insight is a claim about football, and this engine confirms none beyond '
          + 'proximity. Publishing guesses as findings would put invented football in a '
          + 'panel that looks authoritative',
        needs: 'validated event semantics above the tracking layer' } },
    { id: 'tacticalai',  group: 'INTELLIGENCE', ico: 'tactical', label: 'Tactical AI',
      planned: {
        what: 'Formation detection, pressing triggers, defensive line height and phase '
          + 'classification computed from tracked positions',
        why: 'Tactical intelligence is not implemented in the validated engine. The pitch, '
          + 'the projection and the per-frame positions it would read are all in place',
        needs: 'team assignment stable enough to attribute a shape to a side' } },
    { id: 'performance', group: 'INTELLIGENCE', ico: 'perf',    label: 'Performance', badge: 'NOT VALIDATED' },
    { id: 'comparisons', group: 'INTELLIGENCE', ico: 'compare', label: 'Comparisons',
      planned: {
        what: 'Two sessions side by side — the same player, the same pitch region, the same '
          + 'metric, with the evidence behind each figure',
        why: 'Comparing two sessions needs a validated per-player measurement, and physical '
          + 'metrics have not passed validation. A comparison of two unvalidated numbers '
          + 'is two unvalidated numbers',
        needs: 'physical metrics to clear their validation gate' } },

    { id: 'health',       group: 'SYSTEM', ico: 'health', label: 'Health' },
    { id: 'models',       group: 'SYSTEM', ico: 'models', label: 'Models & Providers' },
    { id: 'integrations', group: 'SYSTEM', ico: 'flow',   label: 'Integrations' },
    { id: 'logs',         group: 'SYSTEM', ico: 'logs',   label: 'Logs',
      planned: {
        what: 'Vision’s own processing log — what ran, how long each stage took, what it '
          + 'rejected and why',
        why: 'Vision writes its FACTS to the Data Vault as events, which is the right place '
          + 'for them. Its processing DIARY has nowhere to go yet, and a log surface that '
          + 'replayed the event stream would be a second, weaker copy of the Vault',
        needs: 'a retained processing log the engine does not currently keep' } },
    { id: 'config',       group: 'SYSTEM', ico: 'config', label: 'Configuration',
      planned: {
        what: 'Per-club Vision settings — processing target, retention, which capabilities a '
          + 'club may run and the thresholds each one answers to',
        why: 'Vision reads its configuration from the deployment today, so there is one '
          + 'setting for everybody. Making it per-club is a data-model change, not a form',
        needs: 'club-scoped Vision configuration in the platform data model' } },
  ];

  /* ── the global bar ──────────────────────────────────────────────────────── */

  function platformUser() {
    var u = (window.State && window.State.user) || {};
    var c = (window.State && window.State.club) || {};
    var name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Signed in';
    var initials = ((u.firstName || u.email || 'U')[0] || 'U').toUpperCase();
    return { name: name, initials: initials, club: c.name || '', role: u.role ? words(u.role) : '' };
  }

  function globalBar() {
    var h = FV.status && FV.status.health;
    var me = platformUser();
    var engineLive = !!(h && h.service === 'LIVE');
    var badge = '';
    try {
      var b = document.getElementById('hdr-notif-badge');
      if (b && !b.hidden && b.textContent.trim()) badge = b.textContent.trim();
    } catch (_) {}

    return '<header class="vx-top">'
      + '<div class="vx-brand"><span class="vx-brand-mark" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round"><path d="M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3'
      + 'M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3"/><circle cx="12" cy="12" r="4.4"/>'
      + '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg></span>'
      + '<span><span class="vx-brand-n">FAMILISTA</span>'
      + '<span class="vx-brand-s">Football Intelligence Platform</span></span></div>'

      // Drives the platform's own `#global-search`. A second search box that
      // searches nothing would be a control with a lie in it.
      + '<label class="vx-search">' + ico('search')
      + '<input type="search" data-vx-search placeholder="Search players, teams, matches, sessions…"'
      + ' aria-label="Search Familista">'
      + '</label>'

      + '<div class="vx-top-right">'
      + '<span class="vx-live' + (engineLive ? '' : ' is-off') + '" title="the Vision engine’s own state">'
      + '<i></i>' + esc(h ? h.service : 'READING') + '</span>'
      + '<button class="vx-iconbtn" data-vx-notif type="button" aria-label="Notifications">' + ico('bell')
      + (badge ? '<span class="vx-iconbtn-badge">' + esc(badge) + '</span>' : '') + '</button>'
      + '<div class="vx-me"><span class="vx-me-av" aria-hidden="true">' + esc(me.initials) + '</span>'
      + '<span><span class="vx-me-n" data-user-content>' + esc(me.name) + '</span>'
      + '<span class="vx-me-r" data-user-content>' + esc(me.club || me.role) + '</span></span></div>'
      + '</div></header>';
  }

  function moduleRow() {
    return '<nav class="vx-modules" aria-label="Familista modules">' + MODULES.map(function (m) {
      var attrs = m.current
        ? ' aria-current="page"'
        : ' data-vx-module="' + esc(m.id) + '"';
      return '<button class="vx-mod" type="button"' + attrs + '>' + ico(m.ico)
        + '<span>' + esc(m.label) + '</span></button>';
    }).join('') + '</nav>';
  }

  /**
   * PLANNED IS NOT DISABLED.
   *
   * These sections used to be `disabled` with an "N/A" badge. Beside twelve
   * working sections that reads as broken — the reader's question becomes "what
   * went wrong here" rather than "what is coming". They are reachable now, they
   * carry a PLANNED badge, and opening one says what it will do, why it does
   * not do it yet and what has to exist first. Nothing about the architecture
   * is thrown away; it is stated instead of implied by a dead control.
   */
  function rail() {
    var last = '';
    return '<nav class="vx-side" aria-label="Familista Vision sections">'
      + '<div class="vx-side-scroll">' + SECTIONS.map(function (s) {
        var g = s.group !== last ? '<div class="vx-group">' + esc(s.group) + '</div>' : '';
        last = s.group;
        var badge = s.planned
          ? '<span class="vx-item-b vx-item-b--plan">PLANNED</span>'
          : s.badge ? '<span class="vx-item-b vx-item-b--warn">' + esc(s.badge) + '</span>' : '';
        var attrs = ' data-vx-section="' + esc(s.id) + '"'
          + (FV.section === s.id ? ' aria-current="page"' : '')
          + (s.planned ? ' data-vx-planned="1"' : '')
          + ' title="' + esc(s.label + (s.planned ? ' — planned, not yet built' : '')) + '"';
        return g + '<button class="vx-item' + (s.planned ? ' is-planned' : '') + '" type="button"' + attrs + '>'
          + '<span class="vx-item-ico">' + ico(s.ico) + '</span>'
          + '<span class="vx-item-l">' + esc(s.label) + '</span>'
          + badge
          + '</button>';
      }).join('') + '</div>'
      + '<div class="vx-side-foot"><b>FAMILISTA</b><i>VISION</i>'
      + '<span>See · Understand · Improve</span></div></nav>';
  }

  /** The screen a PLANNED section opens: what, why not yet, and what it waits on. */
  function secPlanned(s) {
    var p = s.planned;
    setWorkbar(s.label, Chip('', 'PLANNED', 'designed, not yet built'));

    // Prose, not figures. `Rows` right-aligns its value against the panel edge
    // because it exists for a label and a number; three sentences laid out that
    // way run the full width of a 1920px workspace and stop being readable.
    // This is a measured column with the label above the text.
    function para(k, v) {
      return '<div class="vx-plan-p"><div class="vx-plan-k">' + esc(k) + '</div>'
        + '<p class="vx-plan-v">' + esc(sentence(v)) + '</p></div>';
    }

    body('<div class="vx-plan">'
      + Empty('future', 'PLANNED — NOT YET BUILT',
        'This section produces no data today. Nothing on this screen is a measurement',
        'future')
      + '<div class="vx-plan-body">'
      + para('What it will do', p.what)
      + para('Why it is not here yet', p.why)
      + para('What it waits on', p.needs)
      + '<p class="vx-note">When this section is built it will read the same validated '
      + 'session records every other Vision section reads, through the same API. It is '
      + 'listed here so the shape of the product is visible — not to suggest a '
      + 'capability that exists.</p>'
      + '</div></div>');
  }

  /* ── the workbar: the state of the instrument, on one line ───────────────── */

  function rd(k, v, title) {
    return '<span class="vx-rd"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + esc(k) + ' <b>' + v + '</b></span>';
  }

  /**
   * What the workbar says is the same seven facts on every screen, because the
   * question "what am I looking at, off what, on what, how fast" does not
   * change when the panel below it does.
   */
  function workbarReadings() {
    var h = FV.status && FV.status.health;
    var s = FV.session && FV.session.summary;
    var out = [];
    out.push(rd('Session', s ? '<span data-user-content>' + esc(s.sessionRef) + '</span>'
      : '<span class="vx-none">none</span>', 'every figure on this screen belongs to this session'));
    out.push('<span class="vx-rd-sep"></span>');
    out.push(rd('Source', s ? esc(s.source.displayName) : '<span class="vx-none">—</span>'));
    out.push(rd('', s ? esc(s.source.width) + '×' + esc(s.source.height)
      : '<span class="vx-none">—</span>'));
    out.push(rd('Input', s ? n(s.source.fps, 2) + ' fps' : '<span class="vx-none">—</span>',
      'the source’s own frame rate'));
    out.push(rd('Processing', s ? n(s.processingFps, 2) + ' fps' : '<span class="vx-none">—</span>',
      'how fast this session was processed — not a live rate'));
    out.push('<span class="vx-rd-sep"></span>');
    out.push(rd('Target', h ? esc(words(h.processingTarget)) : '<span class="vx-none">—</span>',
      'where inference runs for this deployment'));
    // Latency is a live-pipeline figure. This deployment reads completed
    // sessions, so there is no latency to report and none is invented.
    out.push(rd('Latency', '<span class="vx-none" title="this deployment reads completed sessions;'
      + ' there is no live pipeline to measure">—</span>'));
    return out.join('');
  }

  function workbar(title, actions) {
    return '<div class="vx-workbar">'
      + '<h2 class="vx-title">' + esc(title) + '</h2>'
      + '<div class="vx-workbar-readings" role="status">' + workbarReadings() + '</div>'
      + '<div class="vx-workbar-actions">' + (actions || '') + '</div></div>';
  }

  function setWorkbar(title, actions) {
    var el = document.getElementById('vx-workbar');
    if (el) el.innerHTML = workbar(title, actions);
  }

  function body(html) {
    var el = document.getElementById('vx-body');
    if (el) { el.innerHTML = html; el.scrollTop = 0; }
  }

  /* ── the shell ───────────────────────────────────────────────────────────── */

  function renderShell() {
    var root = document.getElementById('fv-root');
    if (!root) return;
    root.innerHTML =
      globalBar() + moduleRow()
      + '<div class="vx-main">' + rail()
      + '<main class="vx-work"><div id="vx-workbar"></div>'
      + '<div class="vx-body" id="vx-body" tabindex="-1"></div></main></div>'
      + '<div class="vx-scrim" data-vx-drawer-close></div>'
      + '<aside class="vx-drawer" id="vx-drawer" role="dialog" aria-modal="false" aria-hidden="true">'
      + '<div class="vx-drawer-h"><div><div class="vx-drawer-t" id="vx-drawer-t"></div>'
      + '<div class="vx-drawer-s" id="vx-drawer-s"></div></div>'
      + '<button class="vx-iconbtn" data-vx-drawer-close type="button" aria-label="Close evidence">'
      + '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>'
      + '<div class="vx-drawer-b" id="vx-drawer-b"></div></aside>';

    // ONCE. `renderShell` replaces the root's CONTENTS, not the root itself, so
    // binding here bound another full set of handlers on every repaint — and
    // the shell repaints on every mount. After three visits a single click ran
    // `openSession` three times and a single keypress stepped the frame three
    // frames. The listeners are delegated from the root, so one set is all
    // there ever needed to be.
    if (!FV.bound) {
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('change', onInput);
      root.addEventListener('keydown', onKey);
      FV.bound = true;
    }
    renderSection();
  }

  /**
   * Acknowledge a selection without rebuilding the body.
   *
   * While a session is being fetched the rail's marker moves but the content
   * underneath stays exactly as it was. Throwing the body away and rebuilding
   * it is what made an ordinary load look like a failure.
   */
  function renderWorkbarOnly() {
    refreshRail();
  }

  /** Repaint the rail's current marker and the workbar, and nothing else. */
  function refreshRail() {
    var items = document.querySelectorAll('[data-vx-section]');
    for (var i = 0; i < items.length; i++) {
      if (!items[i].classList.contains('vx-item')) continue;
      if (items[i].getAttribute('data-vx-section') === FV.section) items[i].setAttribute('aria-current', 'page');
      else items[i].removeAttribute('aria-current');
    }
  }

  function goto(section) {
    FV.section = section;
    rememberSection(section);
    refreshRail();
    renderSection();
    var b = document.getElementById('vx-body');
    if (b) b.focus({ preventScroll: true });
  }

  function openDrawer(title, sub, html) {
    var d = document.getElementById('vx-drawer');
    var s = document.querySelector('.vx-scrim');
    if (!d) return;
    document.getElementById('vx-drawer-t').textContent = title;
    document.getElementById('vx-drawer-s').textContent = sub || '';
    document.getElementById('vx-drawer-b').innerHTML = html;
    d.classList.add('is-open'); d.setAttribute('aria-hidden', 'false');
    if (s) s.classList.add('is-open');
    var close = d.querySelector('[data-vx-drawer-close]');
    if (close) close.focus();
  }

  function closeDrawer() {
    var d = document.getElementById('vx-drawer');
    var s = document.querySelector('.vx-scrim');
    if (d) { d.classList.remove('is-open'); d.setAttribute('aria-hidden', 'true'); }
    if (s) s.classList.remove('is-open');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DERIVATIONS — unchanged from the validated build
     ═══════════════════════════════════════════════════════════════════════════ */

  function trackIndex(s) {
    var by = {};
    s.tracks.forEach(function (t) {
      var r = by[t.identity] || (by[t.identity] = {
        identity: t.identity, trackId: t.trackId, team: t.teamId, role: t.role,
        obs: 0, withCoords: 0, conf: 0, first: t.frameNumber, last: t.frameNumber,
        origins: {}, path: [],
      });
      r.obs += 1;
      if (t.pitchXM !== null) { r.withCoords += 1; r.path.push(t); }
      if (t.classificationConfidence) r.conf = Math.max(r.conf, t.classificationConfidence);
      r.origins[t.calibrationChain] = (r.origins[t.calibrationChain] || 0) + 1;
      r.last = t.frameNumber;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.obs - a.obs; });
  }

  function applyTrackFilters(list) {
    var f = FV.filters;
    return list.filter(function (r) {
      if (f.track && r.identity.toLowerCase().indexOf(f.track.toLowerCase()) < 0) return false;
      if (f.team && (r.team || 'UNASSIGNED') !== f.team) return false;
      if (f.role && r.role !== f.role) return false;
      if (f.conf === 'high' && !(r.conf >= 0.8)) return false;
      if (f.conf === 'low' && !(r.conf > 0 && r.conf < 0.8)) return false;
      if (f.conf === 'none' && r.conf > 0) return false;
      return true;
    });
  }

  /**
   * The ball's path, broken wherever the record breaks.
   *
   * A smooth line across thirty frames the tracker never saw would be a
   * picture of an assumption, so a gap of more than two frames ends the run.
   */
  function ballPath(ball) {
    var trail = ball.filter(function (b) { return b.pitchXM !== null; });
    var out = '', run = [];
    trail.forEach(function (b, i) {
      var prev = trail[i - 1];
      if (prev && b.frameNumber - prev.frameNumber > 2) {
        if (run.length > 1) out += '<polyline class="vx-trace vx-trace--ball" points="' + run.join(' ') + '"/>';
        run = [];
      }
      run.push(b.pitchXM.toFixed(2) + ',' + b.pitchYM.toFixed(2));
    });
    if (run.length > 1) out += '<polyline class="vx-trace vx-trace--ball" points="' + run.join(' ') + '"/>';
    return { path: out, trail: trail };
  }

  var HEAT_CX = 21, HEAT_CY = 14;

  function heatGrid(pool) {
    var grid = new Array(HEAT_CX * HEAT_CY).fill(0), max = 0;
    pool.forEach(function (t) {
      var cx = Math.min(HEAT_CX - 1, Math.max(0, Math.floor(t.pitchXM / (105 / HEAT_CX))));
      var cy = Math.min(HEAT_CY - 1, Math.max(0, Math.floor(t.pitchYM / (68 / HEAT_CY))));
      var i = cy * HEAT_CX + cx;
      grid[i] += 1;
      if (grid[i] > max) max = grid[i];
    });
    return { grid: grid, max: max };
  }

  function heatCells(grid, max, alpha) {
    var cells = [];
    for (var y = 0; y < HEAT_CY; y++) {
      for (var x = 0; x < HEAT_CX; x++) {
        var v = grid[y * HEAT_CX + x];
        if (!v) continue;
        var a = Math.pow(v / max, 0.58) * (alpha === undefined ? 1 : alpha);
        cells.push('<rect x="' + (x * (105 / HEAT_CX)) + '" y="' + (y * (68 / HEAT_CY))
          + '" width="' + (105 / HEAT_CX) + '" height="' + (68 / HEAT_CY)
          + '" fill="rgba(34,211,238,' + a.toFixed(3) + ')"><title>' + v
          + ' calibrated positions</title></rect>');
      }
    }
    return cells.join('');
  }

  /** Run-length spans for a timeline band. One span per run, not per frame. */
  function tlSpans(rows, frames, kindOf, titleOf) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var kind = kindOf(rows[i]), j = i;
      while (j + 1 < rows.length && kindOf(rows[j + 1]) === kind
             && rows[j + 1].frameNumber - rows[j].frameNumber <= 1) j++;
      var from = rows[i].frameNumber, to = rows[j].frameNumber;
      out.push('<div class="vx-tl-span vx-tl-span--' + kind + '" style="left:'
        + ((from / frames) * 100).toFixed(2) + '%;width:'
        + Math.max(0.25, (((to - from + 1) / frames) * 100)).toFixed(2) + '%"'
        + ' title="' + esc(titleOf(rows[i]) + ' · frames ' + from + '–' + to) + '"></div>');
      i = j;
    }
    return out.join('');
  }

  function tlBand(label, count, inner, marks) {
    return '<div class="vx-tl-band"><div class="vx-tl-k">' + esc(label)
      + (count === undefined ? '' : '<em>' + esc(count) + '</em>') + '</div>'
      + '<div class="vx-tl-track' + (marks ? ' vx-tl-track--marks' : '') + '">' + inner + '</div></div>';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     LIVE ANALYSIS — the hero
     ═══════════════════════════════════════════════════════════════════════════

     One stage that dominates, one instrument rail beside it, two operational
     rows beneath. At 1920×1080 all of it is on screen at once, which is the
     whole point of a workstation.
  */

  var MODES = [
    { id: 'frame',  ico: 'shot',   label: 'FRAME' },
    { id: 'pitch',  ico: 'grid2d', label: '2D' },
    { id: 'tracks', ico: 'lines',  label: 'PATHS' },
    { id: 'zones',  ico: 'zones',  label: 'ZONES',
      off: 'zone occupancy needs a possession attribution the engine does not produce' },
    { id: 'three',  ico: 'cube3d', label: '3D',
      off: 'a third dimension needs a camera height the calibration does not solve for' },
  ];

  function modeRail(caps) {
    return '<div class="vx-stage-modes" role="group" aria-label="Analysis surface">'
      + MODES.map(function (m) {
        var off = m.off || (m.id === 'pitch' && !caps.metricCoordinates
          ? 'this session published no metric coordinate' : null);
        return '<button class="vx-mode" type="button"'
          + (off ? ' disabled aria-disabled="true" title="' + esc(sentence(off)) + '"'
                 : ' data-vx-mode="' + m.id + '" aria-pressed="' + (FV.mode === m.id) + '"')
          + '>' + ico(m.ico) + '<b>' + esc(m.label) + '</b></button>';
      }).join('') + '</div>';
  }

  /** The annotated frame: real detections at their real image coordinates. */
  function stageFrame(s, frame) {
    var sm = s.summary, W = sm.source.width || 1024, H = sm.source.height || 576;
    var rows = s.tracks.filter(function (t) { return t.frameNumber === frame; });
    var ballRow = s.ball.filter(function (b) { return b.frameNumber === frame; })[0] || null;
    var evHere = s.events.filter(function (e) { return e.frameNumber === frame; });
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet"'
      + ' role="img" aria-label="Annotated frame ' + frame + '">'
      + '<rect width="' + W + '" height="' + H + '" fill="#080e1a"/>'
      + '<rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2)
      + '" fill="none" stroke="rgba(34,211,238,.22)" stroke-width="2"/>'];
    // A faint grid so a box has something to sit against, without pretending to
    // be a photograph of a pitch.
    for (var gx = 0; gx <= W; gx += Math.round(W / 16)) {
      svg.push('<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + H + '" stroke="rgba(255,255,255,.03)"/>');
    }
    for (var gy = 0; gy <= H; gy += Math.round(H / 9)) {
      svg.push('<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="rgba(255,255,255,.03)"/>');
    }
    rows.forEach(function (t) {
      var c = trackTone(t);
      if (FV.layers.boxes) {
        svg.push('<rect x="' + t.box.x1 + '" y="' + t.box.y1 + '" width="' + (t.box.x2 - t.box.x1)
          + '" height="' + (t.box.y2 - t.box.y1) + '" fill="' + c + '" fill-opacity=".08" stroke="' + c
          + '" stroke-width="2" rx="2"/>');
      }
      if (FV.layers.ids) {
        var label = '#' + t.identity;
        var w = label.length * 8 + 10;
        var ly = Math.max(16, t.box.y1 - 5);
        svg.push('<rect x="' + t.box.x1 + '" y="' + (ly - 14) + '" width="' + w + '" height="16" rx="3" fill="' + c + '"/>');
        svg.push('<text x="' + (t.box.x1 + 5) + '" y="' + (ly - 2) + '" fill="#04070d" font-size="12"'
          + ' font-weight="700" font-family="ui-monospace,monospace">' + esc(label) + '</text>');
      }
    });
    if (FV.layers.ball && ballRow && ballRow.imageX !== null) {
      var bc = ballRow.state === 'OBSERVED' ? '#ffffff' : 'var(--v-amber)';
      svg.push('<circle cx="' + ballRow.imageX + '" cy="' + ballRow.imageY + '" r="11" fill="none" stroke="'
        + bc + '" stroke-width="2"/>');
      svg.push('<circle cx="' + ballRow.imageX + '" cy="' + ballRow.imageY + '" r="3" fill="' + bc + '"/>');
    }
    if (evHere.length) {
      svg.push('<rect x="14" y="14" width="' + (evHere[0].type.length * 9 + 30) + '" height="24" rx="5"'
        + ' fill="rgba(34,211,238,.18)" stroke="rgba(34,211,238,.55)"/>');
      svg.push('<text x="26" y="31" fill="#22d3ee" font-size="13" font-weight="700"'
        + ' font-family="ui-monospace,monospace">' + esc(evHere[0].type) + '</text>');
    }
    svg.push('</svg>');
    return { svg: svg.join(''), rows: rows, ball: ballRow, events: evHere };
  }

  /** The same evidence, on a pitch, in metres. */
  function stagePitch(s, frame) {
    var rows = s.tracks.filter(function (t) { return t.frameNumber === frame && t.pitchXM !== null; });
    var ballRow = s.ball.filter(function (b) { return b.frameNumber === frame; })[0] || null;
    var inner = '';
    if (FV.layers.heat && s.summary.capabilities.heatmaps) {
      var all = s.tracks.filter(function (t) { return t.pitchXM !== null; });
      var g = heatGrid(all);
      inner += heatCells(g.grid, g.max, 0.55);
    }
    if (FV.layers.boxes) {
      inner += rows.map(function (t) {
        return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="1.5" fill="' + trackTone(t)
          + '" stroke="rgba(4,7,13,.7)" stroke-width=".25"><title>#' + esc(t.identity) + '</title></circle>'
          + (FV.layers.ids ? '<text x="' + t.pitchXM + '" y="' + (t.pitchYM - 2.3) + '" fill="#e9eefb"'
            + ' font-size="2.1" text-anchor="middle" font-family="ui-monospace,monospace">'
            + esc(t.identity) + '</text>' : '');
      }).join('');
    }
    if (FV.layers.ball && ballRow && ballRow.pitchXM !== null) {
      inner += '<circle cx="' + ballRow.pitchXM + '" cy="' + ballRow.pitchYM + '" r="1.1" class="vx-dot-ball"/>';
    }
    return Pitch(inner, { label: 'Frame ' + frame + ' in metres', forceLines: true,
      style: 'max-height:100%;width:auto;max-width:100%' });
  }

  /** Every identity's path, drawn only across the positions the engine published. */
  function stageTracks(s) {
    var idx = trackIndex(s).filter(function (r) { return r.withCoords > 1; });
    var inner = idx.map(function (r) {
      var c = trackTone({ role: r.role, teamId: r.team });
      var runs = [], run = [];
      r.path.forEach(function (t, i) {
        var prev = r.path[i - 1];
        if (prev && t.frameNumber - prev.frameNumber > 3) { if (run.length > 1) runs.push(run); run = []; }
        run.push(t.pitchXM.toFixed(2) + ',' + t.pitchYM.toFixed(2));
      });
      if (run.length > 1) runs.push(run);
      return runs.map(function (p) {
        return '<polyline points="' + p.join(' ') + '" fill="none" stroke="' + c
          + '" stroke-width=".38" stroke-linejoin="round" opacity=".75"/>';
      }).join('');
    }).join('');
    return Pitch(inner, { label: 'Every tracked path in metres', forceLines: true,
      style: 'max-height:100%;width:auto;max-width:100%' });
  }

  var LAYERS = [
    { k: 'boxes',  label: 'Players',      c: 'var(--v-cyan)' },
    { k: 'ball',   label: 'Ball',         c: '#ffffff' },
    { k: 'ids',    label: 'Player IDs',   c: 'var(--v-violet)' },
    { k: 'trails', label: 'Trajectories', c: 'var(--v-amber)', needs: 'metricCoordinates' },
    { k: 'heat',   label: 'Heatmap',      c: 'var(--v-green)', needs: 'heatmaps' },
    { k: 'lines',  label: 'Pitch Lines',  c: 'var(--v-tx-2)' },
    { k: 'zones',  label: 'Zones',        c: 'var(--v-grey)',
      off: 'no zone model exists; a zone needs a possession attribution the engine does not produce' },
  ];

  function layerBoard(caps) {
    return '<div class="vx-layers">' + LAYERS.map(function (l) {
      var off = l.off || (l.needs && !caps[l.needs]
        ? 'this session does not carry the evidence this layer draws' : null);
      return '<button class="vx-layer" type="button"'
        + (off ? ' disabled aria-disabled="true" title="' + esc(sentence(off)) + '"'
               : ' data-vx-layer="' + l.k + '" aria-pressed="' + !!FV.layers[l.k] + '"')
        + '><span class="vx-layer-sw" aria-hidden="true"></span>'
        + '<span class="vx-layer-k">' + esc(l.label) + '</span>'
        + '<span class="vx-layer-c" style="background:' + l.c + '"></span></button>';
    }).join('') + '</div>';
  }

  function secLive() {
    var h = FV.status && FV.status.health;
    var s = FV.session;

    var actions =
      '<button class="vx-btn" type="button" data-vx-section="calibration">' + ico('calib')
      + 'Calibrate Pitch</button>'
      + '<button class="vx-btn" type="button" data-vx-section="events">' + ico('events') + 'Analysis</button>'
      + '<button class="vx-btn" type="button" data-vx-export="tracks"' + (s ? '' : ' disabled')
      + '>' + ico('down') + 'Export</button>'
      + '<button class="vx-btn vx-btn--danger" type="button" disabled aria-disabled="true"'
      + ' title="this deployment reads completed sessions; there is no run to stop">'
      + ico('stop') + 'Stop</button>';
    setWorkbar('Live Analysis', actions);

    // ORDER MATTERS, AND IT WAS WRONG.
    //
    // `h` is `FV.status.health`, which is absent both while the request is in
    // flight AND when it came back an error. Testing `!h` first meant every
    // failure rendered as the LOADING state: a 401 in production showed
    // "READING VISION SERVICE — One moment" and sat there for ever, with the
    // real answer already in `FV.status.error` and nothing on screen saying so.
    // An error is checked before an absence, and a never-answered request is
    // the only thing that may still read as loading.
    if (FV.status && FV.status.ok === false) {
      body(Empty('withheld', 'VISION SERVICE UNAVAILABLE',
        FV.status.error || 'the service did not answer', 'absent')
        + '<div class="vx-rowgap"></div>'
        + '<div class="vx-legend" style="justify-content:center">'
        + '<button class="vx-btn" type="button" data-vx-retry>' + ico('arrow') + 'Try again</button>'
        + '</div>');
      return;
    }
    if (!h) { body(Empty('withheld', 'READING VISION SERVICE', 'One moment')); return; }
    if (!s) { body(needSession()); return; }

    var sm = s.summary, caps = sm.capabilities, frame = FV.frame;
    var frames = Math.max(1, sm.framesProcessed);
    var f = stageFrame(s, frame);
    var cal = s.calibration.filter(function (c) { return c.frameNumber === frame; })[0] || null;

    /* ── the stage ───────────────────────────────────────────────────────── */
    var view = FV.mode === 'pitch' ? '<div class="vx-surface">' + stagePitch(s, frame) + '</div>'
      : FV.mode === 'tracks' ? '<div class="vx-surface">' + stageTracks(s) + '</div>'
        : f.svg;

    var mapDots = s.tracks.filter(function (t) { return t.frameNumber === frame && t.pitchXM !== null; })
      .map(function (t) {
        return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="2" fill="' + trackTone(t) + '"/>';
      }).join('')
      + (f.ball && f.ball.pitchXM !== null
        ? '<circle cx="' + f.ball.pitchXM + '" cy="' + f.ball.pitchYM + '" r="1.5" class="vx-dot-ball"/>' : '');

    var stage = '<section class="vx-stage">'
      + '<div class="vx-stage-view">' + view
      + '<div class="vx-stage-src"><span class="vx-stage-src-ico">' + ico('camera') + '</span>'
      + '<span><span class="vx-stage-src-n" data-user-content>' + esc(sm.source.displayName) + '</span>'
      + '<span class="vx-stage-src-s"><i class="vx-dot vx-dot--ready"></i>'
      + esc(words(sm.source.sourceType)) + ' · ' + esc(sm.source.width) + '×'
      + esc(sm.source.height) + ' · ' + n(sm.source.fps, 2) + ' fps</span></span></div>'
      + '<div class="vx-stage-map">' + Pitch(mapDots, { label: 'This frame on the pitch', forceLines: true })
      + '</div>'
      + modeRail(caps)
      + '<div class="vx-stage-note">'
      + (FV.mode === 'frame'
        ? 'ANNOTATION LAYER · SOURCE VIDEO NOT SERVED BY THIS DEPLOYMENT'
        : FV.mode === 'pitch' ? 'METRIC PROJECTION · CALIBRATED POSITIONS ONLY'
          : 'EVERY PATH · BROKEN WHERE THE RECORD BREAKS')
      + '</div></div>'
      + '<div class="vx-transport">'
      + '<button class="vx-tp-btn" data-vx-step="-10" type="button" aria-label="Back ten frames">' + ico('back10') + '</button>'
      + '<button class="vx-tp-btn" data-vx-step="-1" type="button" aria-label="Previous frame">' + ico('prev') + '</button>'
      + '<button class="vx-tp-btn" data-vx-step="1" type="button" aria-label="Next frame">' + ico('next') + '</button>'
      + '<button class="vx-tp-btn" data-vx-step="10" type="button" aria-label="Forward ten frames">' + ico('fwd10') + '</button>'
      + '<input class="vx-scrub" type="range" min="0" max="' + (frames - 1) + '" value="' + frame
      + '" data-vx-scrub aria-label="Seek to frame" style="--v-pos:'
      + ((frame / Math.max(1, frames - 1)) * 100).toFixed(2) + '%">'
      + '<span class="vx-tp-time">frame <b>' + frame + '</b> / ' + (frames - 1)
      + ' · t <b>' + (f.rows.length ? f.rows[0].timestamp.toFixed(2)
        : (sm.source.fps ? (frame / sm.source.fps).toFixed(2) : '—')) + '</b> s</span>'
      + '</div></section>';

    /* ── the tracking rail ───────────────────────────────────────────────── */
    var teamsHere = {};
    f.rows.forEach(function (t) { if (t.teamId) teamsHere[t.teamId] = 1; });

    var overview = '<div class="vx-stats">'
      + Stat('Players', esc(f.rows.length), esc(sm.identities) + ' identities in session',
        { ico: 'teams', tone: 'cyan' })
      + Stat('Ball', f.ball ? esc(words(f.ball.state)) : '<span class="vx-none">—</span>',
        f.ball && f.ball.trackingConfidence !== null ? 'confidence ' + n(f.ball.trackingConfidence, 2)
          : 'no record at this frame',
        { ico: 'ball', tone: f.ball && f.ball.state === 'OBSERVED' ? 'green'
          : f.ball && f.ball.state === 'PROPAGATED' ? 'amber' : '' })
      + Stat('Teams', esc(Object.keys(teamsHere).length), 'clustered in this frame', { ico: 'track' })
      + '</div><div class="vx-rowgap"></div>'
      + '<div class="vx-stats">'
      + Stat('Input FPS', n(sm.source.fps, 2), 'source frame rate')
      + Stat('Processing', n(sm.processingFps, 2), 'wall clock ' + n(sm.processingSeconds, 0) + ' s')
      + Stat('Latency', '<span class="vx-none">—</span>', 'no live pipeline to measure')
      + '</div>';

    var railPitchDots = s.tracks.filter(function (t) { return t.frameNumber === frame && t.pitchXM !== null; })
      .map(function (t) {
        return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="1.7" fill="' + trackTone(t) + '"/>'
          + (FV.layers.ids ? '<text x="' + t.pitchXM + '" y="' + (t.pitchYM - 2.6) + '" fill="#cfd8ea"'
            + ' font-size="2.2" text-anchor="middle" font-family="ui-monospace,monospace">'
            + esc(t.identity) + '</text>' : '');
      }).join('');
    var railTrails = FV.layers.trails && caps.metricCoordinates
      ? trackIndex(s).filter(function (r) { return r.withCoords > 1; }).map(function (r) {
        return '<polyline points="' + r.path.map(function (t) {
          return t.pitchXM.toFixed(1) + ',' + t.pitchYM.toFixed(1); }).join(' ')
          + '" fill="none" stroke="' + trackTone({ role: r.role, teamId: r.team })
          + '" stroke-width=".3" opacity=".45"/>';
      }).join('') : '';
    var railHeat = '';
    if (FV.layers.heat && caps.heatmaps) {
      var pool = s.tracks.filter(function (t) { return t.pitchXM !== null; });
      var hg = heatGrid(pool);
      railHeat = heatCells(hg.grid, hg.max, 0.6);
    }
    var railBall = FV.layers.ball && f.ball && f.ball.pitchXM !== null
      ? '<circle cx="' + f.ball.pitchXM + '" cy="' + f.ball.pitchYM + '" r="1.2" class="vx-dot-ball"/>' : '';

    var railEl = '<div class="vx-ga-rail">'
      + Panel('Tracking Overview', overview,
        { ico: 'track', actions: Chip('', h.service), accent: true })
      + Panel('Pitch View',
        Pitch(railHeat + railTrails + (FV.layers.boxes ? railPitchDots : '') + railBall,
          { label: 'Tracked positions at frame ' + frame, forceLines: true })
        + '<div class="vx-rowgap"></div>' + layerBoard(caps),
        { ico: 'grid2d', actions: Tag(caps.metricCoordinates ? 'METRIC' : 'NO METRIC',
          caps.metricCoordinates ? 'measured' : 'withheld') })
      + '</div>';

    /* ── row 1 ───────────────────────────────────────────────────────────── */
    var trackRows = f.rows.slice(0, 40).map(function (t) {
      return '<button class="vx-pick" type="button" data-vx-track="' + esc(t.identity) + '">'
        + '<span class="vx-pick-n vx-pick-n--' + trackToneClass(t) + '">' + esc(t.identity) + '</span>'
        + '<span class="vx-pick-m"><b>' + esc(t.teamId ? words(t.teamId).toUpperCase() : 'NO TEAM')
        + ' · ' + esc(words(t.role).toLowerCase()) + '</b>'
        + '<span>' + (t.pitchXM === null ? 'no metric position'
          : n(t.pitchXM, 1) + ', ' + n(t.pitchYM, 1) + ' m · ' + esc(t.calibrationChain)) + '</span></span>'
        + '<span class="vx-pick-e">' + Tag(n(t.classificationConfidence, 2),
          t.classificationConfidence >= 0.8 ? 'measured' : 'propagated') + '</span></button>';
    }).join('');

    var playerPanel = Panel('Player Tracking',
      f.rows.length ? '<div class="vx-list">' + trackRows + '</div>'
        : Empty('withheld', 'NO TRACK IN THIS FRAME',
          'The engine observed nobody at frame ' + frame + '. Seek to another frame', 'track'),
      { ico: 'teams', flush: false, tight: true,
        actions: Tag(f.rows.length + ' IN FRAME', 'accent')
          + '<button class="vx-btn vx-btn--sm" type="button" data-vx-section="tracking">All</button>' });

    var b = f.ball;
    var ballVisual = '<div style="display:flex;align-items:center;gap:12px">'
      + '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">'
      + '<circle cx="32" cy="32" r="27" fill="none" stroke="'
      + (b && b.state === 'OBSERVED' ? 'var(--v-green)' : b && b.state === 'PROPAGATED'
        ? 'var(--v-amber)' : 'var(--v-grey)') + '" stroke-width="2.5"'
      + (b && b.state === 'OBSERVED' ? '' : ' stroke-dasharray="4 4"') + '/>'
      + '<path d="M32 12l9.5 7-3.6 11.2H27.1L23.5 19z" fill="'
      + (b && b.state === 'OBSERVED' ? 'var(--v-green)' : b && b.state === 'PROPAGATED'
        ? 'var(--v-amber)' : 'var(--v-grey)') + '" opacity=".85"/></svg>'
      + '<div style="min-width:0;flex:1 1 auto">'
      + '<div style="font-size:17px;font-weight:780;letter-spacing:-.02em">'
      + (b ? esc(words(b.state)) : '<span class="vx-none">NO RECORD</span>') + '</div>'
      + '<div style="font-size:10px;color:var(--v-tx-3);line-height:1.4">'
      + esc(b && b.reason ? b.reason : 'no reason recorded') + '</div></div></div>';

    var ballPanel = Panel('Ball Tracking',
      ballVisual + '<div class="vx-rowgap"></div>' + Rows([
        ['Confidence', b ? n(b.trackingConfidence, 3) : '<span class="vx-none">—</span>'],
        ['Nearest player', b && b.nearestPlayer ? '<b>#' + esc(b.nearestPlayer) + '</b>'
          : '<span class="vx-none">—</span>'],
        ['Distance', b && b.nearestDistanceM !== null ? n(b.nearestDistanceM, 2) + ' m'
          : '<span class="vx-none">—</span>', 'geometry, not possession'],
        ['Origin', b ? Tag(b.origin, b.origin === 'MEASURED' ? 'measured'
          : b.origin === 'PROPAGATED' ? 'propagated' : 'withheld') : '<span class="vx-none">—</span>'],
      ]),
      { ico: 'ball', tight: true,
        actions: b ? Tag(words(b.state), b.state === 'OBSERVED' ? 'measured'
          : b.state === 'PROPAGATED' ? 'propagated' : 'withheld') : '' });

    var heatPanel;
    if (caps.heatmaps) {
      var pool2 = s.tracks.filter(function (t) { return t.pitchXM !== null; });
      var g2 = heatGrid(pool2);
      heatPanel = Panel('Heatmap & Zones',
        Pitch(heatCells(g2.grid, g2.max), { label: 'Occupancy across the session', forceLines: true }),
        { ico: 'heat', tight: true,
          actions: Tag('MEASURED', 'measured')
            + '<button class="vx-btn vx-btn--sm" type="button" data-vx-section="heatmaps">Open</button>' });
    } else {
      heatPanel = Panel('Heatmap & Zones',
        '<div style="position:relative">'
        + Pitch('', { label: 'Pitch with no calibrated occupancy to draw', forceLines: true })
        + '<div class="vx-surface-over"><span class="vx-surface-t">INSUFFICIENT</span>'
        + '<span class="vx-surface-t2" style="font-size:16px">VALIDATED DATA</span></div></div>'
        + '<p class="vx-note">' + esc(sentence(caps.reasons.heatmaps
          || 'this session published too few calibrated positions to count into cells')) + '</p>',
        { ico: 'heat', tight: true, actions: Tag('NOT AVAILABLE', 'withheld') });
    }

    /* ── row 2 ───────────────────────────────────────────────────────────── */
    var recent = s.events.slice(-7).reverse().map(function (e) {
      return '<button class="vx-pick" type="button" data-vx-event="' + esc(e.eventId) + '">'
        + '<span class="vx-pick-n">' + esc((e.timestamp).toFixed(0)) + 's</span>'
        + '<span class="vx-pick-m"><b>' + esc(e.type) + '</b>'
        + '<span>frame ' + e.frameNumber + ' · track #'
        + esc(e.trackIds.join(', ') || '—') + '</span></span>'
        + '<span class="vx-pick-e">' + Tag(e.state, e.state === 'CONFIRMED' ? 'measured' : 'withheld')
        + '</span></button>';
    }).join('');

    var eventsPanel = Panel('Recent Events',
      s.events.length ? '<div class="vx-list">' + recent + '</div>'
        : Empty('withheld', 'NO EVENT CONFIRMED',
          sentence(caps.reasons.events || 'the engine confirmed no football event in this session'), 'events'),
      { ico: 'events', tight: true,
        actions: Tag(s.events.length + ' CONFIRMED', 'measured')
          + '<button class="vx-btn vx-btn--sm" type="button" data-vx-section="events">All</button>' });

    var sessionPanel = Panel('Session Information', Rows([
      ['Session', '<b data-user-content>' + esc(sm.sessionRef) + '</b>'],
      ['Generated', esc((sm.generatedAt || '').replace('T', ' ').replace('Z', ''))],
      ['Frames', esc(sm.framesProcessed)],
      ['Observations', esc(sm.observationsTotal)],
      ['Calibration coverage', pct(sm.calibrationCoverage)],
      ['Pipeline', '<span style="font-size:10px">' + esc(sm.pipelineVersion || '—') + '</span>'],
      ['Scope', sm.clubId ? Tag(sm.clubId, 'accent') : Tag('PLATFORM', 'withheld')],
    ]), { ico: 'sessions', tight: true,
      actions: '<button class="vx-btn vx-btn--sm" type="button" data-vx-section="sessions">Switch</button>' });

    var byKey = {};
    h.capabilities.forEach(function (c) { byKey[c.key] = c; });
    var linkRows = ['source-core', 'data-fabric', 'data-vault', 'infrastructure', 'model-registry']
      .map(function (k) { return byKey[k]; }).filter(Boolean).map(function (c) {
        return ['<b>' + esc(c.label) + '</b>', Chip('', c.status), c.detail];
      });
    var systemPanel = Panel('System & Intelligence', Rows(linkRows.concat([
      ['Vision Intelligence', Tag('EVIDENCE ONLY', 'unver'),
        'metric positions and confirmed findings; no rating of any kind'],
    ])), { ico: 'health', tight: true,
      actions: '<button class="vx-btn vx-btn--sm" type="button" data-vx-section="health">Health</button>' });

    var d = FV.device && FV.device.ok !== false ? FV.device.device : null;
    var devicePanel = Panel('Device / Source', Rows([
      ['Source', '<b data-user-content>' + esc(sm.source.displayName) + '</b>', words(sm.source.sourceType)],
      ['Resolution', esc(sm.source.width) + '×' + esc(sm.source.height)],
      ['Quality', esc(sm.source.qualityBand || 'UNKNOWN') + ' · ' + n(sm.source.qualityScore, 2)],
      ['Device', d ? esc(d.label) : '<span class="vx-none">—</span>', d ? d.deviceId : ''],
      ['Processing target', esc(words(h.processingTarget))],
    ]), { ico: 'device', tight: true,
      actions: '<button class="vx-btn vx-btn--sm" type="button" data-vx-section="device">Manage</button>' });

    body('<div class="vx-live-grid">'
      + '<div class="vx-ga-stage">' + stage + '</div>' + railEl
      + '<div class="vx-ga-r1">' + playerPanel + ballPanel + heatPanel + '</div>'
      + '<div class="vx-ga-r2">' + eventsPanel + sessionPanel + systemPanel + devicePanel + '</div>'
      + '</div>');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PLAYER TRACKING — the pitch is the subject; the table is the record
     ═══════════════════════════════════════════════════════════════════════════ */

  function trackFilters(all, list) {
    var teams = {}, roles = {};
    all.forEach(function (r) { teams[r.team || 'UNASSIGNED'] = 1; roles[r.role] = 1; });
    return '<div class="vx-filters">'
      + '<input class="vx-input" data-vx-filter="track" placeholder="Search track…" value="'
      + esc(FV.filters.track) + '" aria-label="Search track identity">'
      + '<select class="vx-select" data-vx-filter="team" aria-label="Filter by team">'
      + '<option value="">All teams</option>' + Object.keys(teams).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.filters.team === t ? ' selected' : '') + '>'
          + esc(words(t)) + '</option>'; }).join('') + '</select>'
      + '<select class="vx-select" data-vx-filter="role" aria-label="Filter by role">'
      + '<option value="">All roles</option>' + Object.keys(roles).sort().map(function (r) {
        return '<option value="' + esc(r) + '"' + (FV.filters.role === r ? ' selected' : '') + '>'
          + esc(words(r)) + '</option>'; }).join('') + '</select>'
      + '<select class="vx-select" data-vx-filter="conf" aria-label="Filter by confidence">'
      + ['', 'high', 'low', 'none'].map(function (v) {
        return '<option value="' + v + '"' + (FV.filters.conf === v ? ' selected' : '') + '>'
          + (v === '' ? 'Any confidence' : v === 'high' ? '≥ 0.80' : v === 'low' ? '< 0.80'
            : 'Not scored') + '</option>'; }).join('') + '</select>'
      + '</div>';
  }

  function secTracking() {
    setWorkbar('Player Tracking',
      '<button class="vx-btn" type="button" data-vx-section="live">' + ico('live') + 'Live Analysis</button>'
      + '<button class="vx-btn" type="button" data-vx-export="tracks-csv"'
      + (FV.session ? '' : ' disabled') + '>' + ico('down') + 'Tracking CSV</button>');
    if (!FV.session) { body(needSession()); return; }

    var s = FV.session, caps = s.summary.capabilities;
    var all = trackIndex(s);
    var list = applyTrackFilters(all);
    var sel = FV.selection.track
      ? all.filter(function (r) { return r.identity === FV.selection.track; })[0] : null;

    var inner = '';
    if (caps.metricCoordinates) {
      if (sel && sel.path.length) {
        inner = s.tracks.filter(function (t) { return t.pitchXM !== null; }).map(function (t) {
          return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.4" fill="rgba(255,255,255,.1)"/>';
        }).join('')
          + '<polyline class="vx-trace" points="' + sel.path.map(function (t) {
            return t.pitchXM.toFixed(2) + ',' + t.pitchYM.toFixed(2); }).join(' ') + '"/>'
          + sel.path.map(function (t) {
            return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.75" class="vx-dot-sel"/>';
          }).join('');
      } else {
        var keep = {};
        list.forEach(function (r) { keep[r.identity] = 1; });
        inner = s.tracks.filter(function (t) { return t.pitchXM !== null && keep[t.identity]; })
          .map(function (t) {
            return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.55" class="'
              + (t.calibrationChain === 'measured' ? 'vx-dot-m' : 'vx-dot-p') + '" opacity=".5"/>';
          }).join('');
      }
    }

    var stage = Panel(sel ? 'Trajectory · #' + sel.identity : 'Calibrated positions',
      caps.metricCoordinates
        ? '<div class="vx-surface" style="height:min(58vh,520px)">'
          + Pitch(inner, { label: 'Player positions in metres', forceLines: true,
            style: 'max-height:100%;width:auto;max-width:100%' }) + '</div>'
          + '<div class="vx-legend" style="padding:0 12px 4px">'
          + '<span class="vx-lg"><i style="background:var(--v-green)"></i>measured</span>'
          + '<span class="vx-lg"><i style="background:var(--v-amber)"></i>propagated</span>'
          + '<span class="vx-lg"><i style="background:var(--v-cyan)"></i>selected path</span></div>'
        : Empty('withheld', 'NO METRIC POSITIONS',
          caps.reasons.metricCoordinates || 'calibration published no coordinate for this session', 'track'),
      { accent: true, ico: 'track', flush: true,
        actions: Tag(s.summary.observationsWithPitchCoords + ' POSITIONS', 'measured') });

    var picker = list.map(function (r) {
      return '<button class="vx-pick" type="button" data-vx-track="' + esc(r.identity) + '"'
        + (sel && sel.identity === r.identity ? ' aria-current="true"' : '') + '>'
        + '<span class="vx-pick-n vx-pick-n--' + trackToneClass({ role: r.role, teamId: r.team })
        + '">' + esc(r.identity) + '</span>'
        + '<span class="vx-pick-m"><b>' + esc(r.team ? words(r.team).toUpperCase() : 'NO TEAM')
        + ' · ' + esc(words(r.role).toLowerCase()) + '</b>'
        + '<span>' + esc(r.withCoords) + ' of ' + esc(r.obs) + ' with metric position</span></span>'
        + '<span class="vx-pick-e">' + Tag(n(r.conf || null, 2),
          r.conf >= 0.8 ? 'measured' : r.conf > 0 ? 'propagated' : 'withheld') + '</span></button>';
    }).join('');

    var inspector = sel
      ? Panel('Selected track', Rows([
        ['Identity', '<b>#' + esc(sel.identity) + '</b>'],
        ['Track id', esc(sel.trackId)],
        ['Team', sel.team ? esc(words(sel.team)) : Tag('NONE', 'withheld')],
        ['Role', sel.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(words(sel.role))],
        ['Classification confidence', n(sel.conf || null, 2)],
        ['Observations', esc(sel.obs)],
        ['With metric position', esc(sel.withCoords) + ' of ' + esc(sel.obs)],
        ['Trajectory', sel.withCoords > 1 ? Tag('AVAILABLE', 'measured') : Tag('INSUFFICIENT', 'withheld')],
        ['Frames', esc(sel.first) + '–' + esc(sel.last)],
        ['Origin', (sel.origins.measured || 0) + ' measured · ' + (sel.origins.propagated || 0)
          + ' propagated · ' + (sel.origins.none || 0) + ' none'],
        ['Speed / distance', Tag('NOT VALIDATED', 'future'),
          'the engine measures implied speed only as a calibration guard'],
      ]) + '<div class="vx-rowgap"></div>'
        + '<button class="vx-btn" type="button" data-vx-seek="' + esc(sel.first) + '">'
        + ico('live') + 'Open at frame ' + esc(sel.first) + '</button>',
        { ico: 'track', accent: true, tight: true, actions: Tag('EVIDENCE', 'derived') })
      : Panel('No track selected',
        '<p class="vx-note" style="border:0;padding:0;margin:0">Choose a track to draw its trajectory '
        + 'on the pitch and read its evidence here. A trajectory is drawn only from positions the '
        + 'engine published — nothing is interpolated across a frame where calibration was NONE.</p>',
        { ico: 'track', tight: true });

    var rail = '<div class="vx-stack">'
      + Panel('Tracks', trackFilters(all, list)
        + '<div class="vx-rowgap"></div>'
        + (picker ? '<div class="vx-list" style="max-height:38vh;overflow:auto">' + picker + '</div>'
          : '<p class="vx-note">No track matches these filters.</p>'),
        { ico: 'teams', tight: true,
          actions: Tag(list.length + ' / ' + all.length, list.length === all.length ? 'measured' : 'accent') })
      + inspector + '</div>';

    var rows = list.map(function (r) {
      return '<tr class="is-clickable" data-vx-track="' + esc(r.identity) + '"'
        + (sel && sel.identity === r.identity ? ' aria-selected="true"' : '') + '>'
        + '<td><b>#' + esc(r.identity) + '</b><span class="vx-td-sub">track ' + esc(r.trackId) + '</span></td>'
        + '<td>' + (r.team ? esc(words(r.team)) : Tag('NONE', 'withheld')) + '</td>'
        + '<td>' + (r.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(words(r.role))) + '</td>'
        + '<td>' + n(r.conf || null, 2) + '</td><td>' + esc(r.obs) + '</td><td>' + esc(r.withCoords) + '</td>'
        + '<td>' + (r.withCoords > 1 ? Tag('YES', 'measured') : Tag('NO', 'withheld')) + '</td>'
        + '<td>' + esc(r.first) + '–' + esc(r.last) + '</td>'
        + '<td><button class="vx-btn vx-btn--sm" data-vx-seek="' + esc(r.first) + '" type="button">seek</button></td></tr>';
    });

    body('<div class="vx-2col--wide vx-2col">' + stage + rail + '</div><div class="vx-rowgap"></div>'
      + Panel('Evidence record', Table('Tracked identities in this session',
        ['Identity', 'Team', 'Role', 'Conf', 'Observations', 'With metric position', 'Trajectory', 'Frames', ''],
        rows) + '<p class="vx-note">Every row came from ' + esc(s.summary.source.displayName)
        + ', pipeline ' + esc(s.summary.pipelineVersion || '—')
        + '. Origin per observation is MEASURED where an anchor solved that frame and PROPAGATED '
        + 'where it was carried.</p>', { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BALL TRACKING — the warning opens the screen and stays on it
     ═══════════════════════════════════════════════════════════════════════════ */

  function secBall() {
    setWorkbar('Ball Tracking',
      '<button class="vx-btn" type="button" data-vx-section="live">' + ico('live') + 'Live Analysis</button>'
      + '<button class="vx-btn" type="button" data-vx-export="ball"' + (FV.session ? '' : ' disabled')
      + '>' + ico('down') + 'Ball JSON</button>');
    if (!FV.session) { body(needSession()); return; }

    var s = FV.session, sm = s.summary, st = sm.ballStates, total = s.ball.length || 1;
    var current = s.ball.filter(function (b) { return b.frameNumber === FV.frame; })[0] || null;
    var bp = ballPath(s.ball);
    var balls = bp.trail.map(function (b) {
      return '<circle cx="' + b.pitchXM + '" cy="' + b.pitchYM + '" r="0.75" class="'
        + (b.state === 'OBSERVED' ? 'vx-dot-ball' : 'vx-dot-p') + '"/>';
    }).join('');

    var warn = '<div class="vx-warn"><b>PROXIMITY ≠ POSSESSION.</b>&nbsp;The nearest player and the '
      + 'distance on this screen are geometry. Nothing here asserts a touch, a control or a possession, '
      + 'and the engine does not infer one from distance.</div><div class="vx-rowgap"></div>';

    var stage = Panel('Ball on the pitch',
      bp.trail.length
        ? '<div class="vx-surface" style="height:min(56vh,500px)">'
          + Pitch(bp.path + balls, { label: 'Ball positions in metres', forceLines: true,
            style: 'max-height:100%;width:auto;max-width:100%' }) + '</div>'
          + '<p class="vx-note" style="margin:0 12px 10px">The line breaks wherever the record does. '
          + 'A smooth path across frames the tracker never saw would be a picture of an assumption.</p>'
        : Empty('withheld', 'NO CALIBRATED BALL POSITIONS',
          'The ball was located in image space but calibration published no pitch coordinate for those '
          + 'frames, so no metric ball position exists', 'ball'),
      { accent: true, ico: 'ball', flush: true,
        actions: Tag(sm.calibratedBallFrames + ' CALIBRATED', 'measured') });

    var kinds = [
      ['OBSERVED', 'measured', 'green', 'the ball was directly detected'],
      ['PROPAGATED', 'propagated', 'amber', 'carried through measured camera motion, not observed'],
      ['UNKNOWN', 'withheld', '', 'the ball could not be located'],
      ['NOT_AVAILABLE', 'withheld', '', 'no ball evidence was produced for these frames'],
    ];
    var stateStrip = '<div class="vx-stats">' + kinds.map(function (k) {
      return Stat(words(k[0]), esc(st[k[0]] || 0), k[3], { tone: k[2] });
    }).join('') + '</div><div class="vx-rowgap"></div>'
      + '<div class="vx-split" role="img" aria-label="Ball state distribution">' + kinds.map(function (k) {
        var c = k[1] === 'measured' ? 'var(--v-green)' : k[1] === 'propagated' ? 'var(--v-amber)'
          : 'rgba(93,107,136,.55)';
        return '<i style="width:' + (((st[k[0]] || 0) / total) * 100).toFixed(2) + '%;background:' + c + '"></i>';
      }).join('') + '</div>'
      + '<p class="vx-note">' + esc(s.ball.length) + ' frames of ball record · observed coverage '
      + pct(sm.ballObservedCoverage) + ' · ' + esc(sm.calibratedBallFrames)
      + ' frames carry a metric position.</p>';

    var rail = '<div class="vx-stack">'
      + Panel('State at frame ' + FV.frame, current
        ? Rows([
          ['State', Tag(words(current.state), current.state === 'OBSERVED' ? 'measured'
            : current.state === 'PROPAGATED' ? 'propagated' : 'withheld'), current.reason || ''],
          ['Frame · time', esc(current.frameNumber) + ' · ' + n(current.timestamp, 3) + ' s'],
          ['Image position', current.imageX === null ? '<span class="vx-none">—</span>'
            : n(current.imageX, 0) + ', ' + n(current.imageY, 0)],
          ['Metric position', current.pitchXM === null ? Tag('WITHHELD', 'withheld')
            : n(current.pitchXM, 2) + ', ' + n(current.pitchYM, 2) + ' m'],
          ['Tracking confidence', n(current.trackingConfidence, 3)],
          ['Detection confidence', n(current.detectionConfidence, 3)],
          ['Frames since observation', n(current.framesSinceObservation, 0)],
          ['Nearest player', current.nearestPlayer ? '<b>#' + esc(current.nearestPlayer) + '</b>'
            : '<span class="vx-none">—</span>'],
          ['Distance', current.nearestDistanceM === null ? '<span class="vx-none">—</span>'
            : n(current.nearestDistanceM, 2) + ' m', 'geometry only'],
          ['Origin', Tag(current.origin, current.origin === 'MEASURED' ? 'measured'
            : current.origin === 'PROPAGATED' ? 'propagated' : 'withheld')],
          ['Source', esc(sm.source.displayName)],
        ])
        : Empty('withheld', 'NO BALL RECORD AT THIS FRAME',
          'The tracker published nothing for frame ' + FV.frame + '. Seek to another frame', 'ball'),
        { ico: 'ball', accent: true, tight: true,
          actions: current ? Tag(words(current.state), current.state === 'OBSERVED' ? 'measured'
            : current.state === 'PROPAGATED' ? 'propagated' : 'withheld') : '' })
      + Panel('Where the record stands', stateStrip, { ico: 'timeline', tight: true }) + '</div>';

    var rows = s.ball.filter(function (b) {
      return b.state === 'OBSERVED' || b.state === 'PROPAGATED';
    }).map(function (b) {
      return '<tr' + (current && current.frameNumber === b.frameNumber ? ' aria-selected="true"' : '') + '>'
        + '<td>' + esc(b.frameNumber) + '</td><td>' + n(b.timestamp, 2) + '</td>'
        + '<td>' + Tag(b.state, b.state === 'OBSERVED' ? 'measured' : 'propagated') + '</td>'
        + '<td>' + n(b.imageX, 0) + ', ' + n(b.imageY, 0) + '</td>'
        + '<td>' + (b.pitchXM === null ? '<span class="vx-none">—</span>'
          : n(b.pitchXM, 1) + ', ' + n(b.pitchYM, 1)) + '</td>'
        + '<td>' + n(b.trackingConfidence, 2) + '</td><td>' + n(b.detectionConfidence, 2) + '</td>'
        + '<td>' + n(b.framesSinceObservation, 0) + '</td>'
        + '<td>' + (b.nearestPlayer ? '#' + esc(b.nearestPlayer) : '<span class="vx-none">—</span>') + '</td>'
        + '<td>' + n(b.nearestDistanceM, 2) + '</td>'
        + '<td><button class="vx-btn vx-btn--sm" data-vx-seek="' + esc(b.frameNumber)
        + '" data-vx-stay type="button">go</button></td></tr>';
    });

    body(warn + '<div class="vx-2col--wide vx-2col">' + stage + rail + '</div>'
      + '<div class="vx-rowgap"></div>'
      + Panel('Ball samples', Table('Ball samples with evidence',
        ['Frame', 't (s)', 'State', 'Image x,y', 'Pitch x,y (m)', 'Track conf', 'Det conf',
          'Since obs', 'Nearest', 'Dist (m)', ''], rows), { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PITCH CALIBRATION — a calibration workstation, not a card wall
     ═══════════════════════════════════════════════════════════════════════════ */

  function secCalibration() {
    setWorkbar('Pitch Calibration',
      '<button class="vx-btn" type="button" data-vx-section="live">' + ico('live') + 'Live Analysis</button>'
      + '<button class="vx-btn" type="button" data-vx-export="calibration"'
      + (FV.session ? '' : ' disabled') + '>' + ico('down') + 'Calibration JSON</button>');
    if (!FV.session) { body(needSession()); return; }

    var s = FV.session, sm = s.summary;
    var frames = Math.max(1, sm.framesProcessed);
    var anchors = s.calibration.filter(function (c) { return c.isAnchor; });
    var none = s.calibration.filter(function (c) { return c.chain === 'none'; });
    var bands = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
    anchors.forEach(function (a) { bands[a.confidence] = (bands[a.confidence] || 0) + 1; });
    var errs = anchors.map(function (a) { return a.expectedErrorM; })
      .filter(function (e) { return e !== null; });
    var here = s.calibration.filter(function (c) { return c.frameNumber === FV.frame; })[0] || null;

    /* A SESSION-LEVEL verdict, and the engine does not publish one — it
       publishes a verdict per frame. This is therefore a summary of those
       per-frame verdicts and is labelled DERIVED wherever it appears.
         NONE      no anchor was accepted
         DEGRADED  an accepted anchor sits in the LOW band, or coverage < 25%
         VALID     otherwise                                                   */
    var state = anchors.length === 0 ? 'NONE'
      : (bands.LOW > 0 || (sm.calibrationCoverage || 0) < 0.25) ? 'DEGRADED' : 'VALID';
    var rule = state === 'NONE' ? 'no anchor was accepted'
      : state === 'DEGRADED'
        ? (bands.LOW > 0 ? bands.LOW + ' accepted anchor' + (bands.LOW === 1 ? '' : 's')
          + ' sit in the LOW band' : 'coverage is below 25%')
        : 'every accepted anchor is HIGH or MEDIUM, and coverage is above 25%';
    var stateTag = state === 'VALID' ? Tag('VALID', 'measured')
      : state === 'DEGRADED' ? Tag('DEGRADED', 'propagated') : Tag('REJECTED', 'crit');

    /* The projected field geometry, with this frame's own solve drawn over it.
       Nothing about an anchor's PITCH position is known, so none is drawn. */
    var solved = s.tracks.filter(function (t) { return t.frameNumber === FV.frame && t.pitchXM !== null; });
    var geometry = solved.map(function (t) {
      return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="1.1" class="'
        + (t.calibrationChain === 'measured' ? 'vx-dot-m' : 'vx-dot-p') + '"/>'
        + '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="'
        + Math.max(0.6, (t.calibrationErrorM || 0) * 2).toFixed(2)
        + '" fill="none" stroke="' + (t.calibrationChain === 'measured'
          ? 'var(--v-green)' : 'var(--v-amber)') + '" stroke-width=".18" opacity=".55"/>';
    }).join('');

    var stage = Panel('Projected field geometry · frame ' + FV.frame,
      '<div class="vx-surface" style="height:min(52vh,470px)">'
      + Pitch(geometry, { label: 'Solved ground plane at frame ' + FV.frame, forceLines: true,
        style: 'max-height:100%;width:auto;max-width:100%' })
      + (here && here.chain === 'none'
        ? '<div class="vx-surface-over"><span class="vx-surface-t">CALIBRATION</span>'
          + '<span class="vx-surface-t2" style="font-size:20px">NONE AT THIS FRAME</span>'
          + '<p class="vx-surface-p">No coordinate was published here, so nothing may be placed on a '
          + 'pitch and nothing is.</p></div>' : '')
      + '</div>'
      + '<div class="vx-legend" style="padding:0 12px 10px">'
      + '<span class="vx-lg"><i style="background:var(--v-green)"></i>measured solve</span>'
      + '<span class="vx-lg"><i style="background:var(--v-amber)"></i>propagated from an anchor</span>'
      + '<span class="vx-lg"><i style="background:transparent;box-shadow:inset 0 0 0 1px var(--v-tx-3)">'
      + '</i>ring = expected metric error</span></div>',
      { accent: true, ico: 'calib', flush: true,
        actions: stateTag + Tag('DERIVED', 'derived') });

    var coverageStrip = tlSpans(s.calibration, frames,
      function (c) { return c.chain === 'measured' ? 'valid' : c.chain === 'propagated' ? 'prop' : 'none'; },
      function (c) { return c.chain; });
    var anchorStrip = anchors.map(function (a) {
      var colour = a.confidence === 'HIGH' ? 'var(--v-green)'
        : a.confidence === 'LOW' ? 'var(--v-grey)' : 'var(--v-amber)';
      return '<button class="vx-tl-mark" style="left:' + ((a.frameNumber / frames) * 100).toFixed(2)
        + '%;background:' + colour + '" data-vx-seek="' + a.frameNumber + '" data-vx-stay type="button"'
        + ' title="Anchor at frame ' + a.frameNumber + ' · ' + a.confidence + ' · ±'
        + (a.expectedErrorM === null ? '—' : a.expectedErrorM.toFixed(3) + ' m')
        + '"><span class="vx-sr">Anchor at frame ' + a.frameNumber + '</span></button>';
    }).join('');
    var cursor = '<div class="vx-tl-cursor" style="left:' + ((FV.frame / frames) * 100).toFixed(2) + '%"></div>';

    var chain = Panel('Calibration chain across the session',
      '<div class="vx-tl">'
      + tlBand('Chain', s.calibration.length + ' frames', coverageStrip + cursor)
      + tlBand('Accepted anchors', anchors.length, anchorStrip + cursor, true)
      + '</div>'
      + '<div class="vx-tl-ruler"><span>frame 0</span><span class="vx-legend">'
      + '<span class="vx-lg"><i style="background:var(--v-green)"></i>MEASURED</span>'
      + '<span class="vx-lg"><i style="background:var(--v-amber)"></i>PROPAGATED</span>'
      + '<span class="vx-lg"><i style="background:rgba(93,107,136,.6)"></i>NONE</span>'
      + '</span><span>frame ' + frames + '</span></div>', { ico: 'timeline', tight: true });

    var g = sm.guards || {};
    var rail = '<div class="vx-stack">'
      + Panel('Validation', Rows([
        ['Validation state', stateTag + ' ' + Tag('DERIVED', 'derived'),
          'the engine publishes a verdict per FRAME and none for the session'],
        ['Reason', '<span style="font-size:11px;font-weight:500">' + esc(sentence(rule)) + '</span>'],
        ['Coverage', pct(sm.calibrationCoverage)],
        ['Expected error', errs.length ? n(Math.min.apply(null, errs), 3) + '–'
          + n(Math.max.apply(null, errs), 3) + ' m' : '<span class="vx-none">—</span>',
          'cross-validated across accepted anchors'],
        ['Anchor disagreement', n(sm.anchorDisagreementMedianM, 3) + ' m',
          'a fresh anchor against the chain it replaced'],
        ['On-pitch coordinates', pct(sm.coordsOnPitchRate),
          esc(sm.observationsWithPitchCoords) + ' published positions'],
        ['Provider', (function () {
          var p = (sm.providers || []).filter(function (x) { return /calib/i.test(x.role); })[0];
          return p ? '<span style="font-size:11px">' + esc(p.provider) + '</span>'
            : '<span class="vx-none">—</span>';
        }())],
        ['Failure reason', none.length
          ? esc(none.length) + ' frames NONE'
          : Tag('NONE', 'measured'), none.length ? 'no coordinate published; none may be inferred' : ''],
      ]), { ico: 'health', accent: true, tight: true })
      + Panel('Anchors accepted', '<div class="vx-stats">'
        + Stat('HIGH', esc(bands.HIGH || 0), 'accepted', { tone: 'green' })
        + Stat('MEDIUM', esc(bands.MEDIUM || 0), 'accepted', { tone: 'amber' })
        + Stat('LOW', esc(bands.LOW || 0), 'accepted', { tone: '' })
        + '</div>'
        + '<div class="vx-rowgap"></div>' + Rows([
          ['Frames withheld', esc(none.length), 'calibration NONE · no metric claim'],
          ['Speed guard spans', n(g.speedGuardSpans, 0), 'spans examined by the validity gate'],
          ['Spans withheld', n(g.speedGuardSpansWithheld, 0), 'physically impossible; rejected'],
        ]), { ico: 'calib', tight: true }) + '</div>';

    var rows = anchors.map(function (a) {
      return '<tr><td>' + esc(a.frameNumber) + '</td>'
        + '<td>' + Tag(a.confidence, a.confidence === 'HIGH' ? 'measured'
          : a.confidence === 'LOW' ? 'withheld' : 'propagated') + '</td>'
        + '<td>' + n(a.expectedErrorM, 3) + '</td><td>' + n(a.score, 4) + '</td>'
        + '<td>' + n(a.reprojectionErrorPx, 2) + '</td>'
        + '<td>' + (a.landmark ? esc(a.landmark) : '<span class="vx-none">—</span>') + '</td>'
        + '<td><button class="vx-btn vx-btn--sm" data-vx-seek="' + esc(a.frameNumber)
        + '" data-vx-stay type="button">go</button></td></tr>';
    });

    body('<div class="vx-2col--wide vx-2col">' + stage + rail + '</div>'
      + '<div class="vx-rowgap"></div>' + chain + '<div class="vx-rowgap"></div>'
      + Panel('Accepted anchors', rows.length
        ? Table('Accepted calibration anchors',
          ['Frame', 'Band', 'Expected error (m)', 'Score', 'Reprojection (px)', 'Landmark evidence', ''], rows)
          + '<p class="vx-note">Landmark evidence reads as an em dash because this engine schema records '
          + 'the landmark sentence on the calibration state rather than on each frame’s provenance. '
          + 'An em dash means the platform does not hold the figure — not that the anchor had no '
          + 'evidence.</p>'
        : Empty('withheld', 'NO ANCHOR ACCEPTED',
          'Every candidate failed the validity gate, so no metric claim is made anywhere in this session',
          'calib'), { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     TEAMS & ROLES — lanes, sized by the share of the session they hold
     ═══════════════════════════════════════════════════════════════════════════ */

  function secTeams() {
    setWorkbar('Teams & Roles',
      '<button class="vx-btn" type="button" data-vx-section="tracking">' + ico('track') + 'Player Tracking</button>');
    if (!FV.session) { body(needSession()); return; }

    var s = FV.session;
    var groups = { team_a: [], team_b: [], GOALKEEPERS: [], OFFICIALS: [], UNKNOWN: [] };
    var byId = trackIndex(s);
    byId.forEach(function (r) {
      if (r.role === 'GOALKEEPER') groups.GOALKEEPERS.push(r);
      else if (r.role === 'REFEREE') groups.OFFICIALS.push(r);
      else if (!r.team || r.role === 'UNKNOWN') groups.UNKNOWN.push(r);
      else if (groups[r.team]) groups[r.team].push(r);
      else groups.UNKNOWN.push(r);
    });
    var totalObs = s.tracks.length || 1;
    var roleReason = {};
    s.roles.forEach(function (r) { roleReason[r.identity] = r; });

    var LANES = [
      ['team_a', 'TEAM A', 'var(--v-cyan)', 'clustered on kit colour'],
      ['team_b', 'TEAM B', 'var(--v-green)', 'clustered on kit colour'],
      ['GOALKEEPERS', 'GOALKEEPERS', 'var(--v-amber)', 'decided on metric position, not on kit colour'],
      ['OFFICIALS', 'OFFICIALS', '#ffffff', 'neither kit, and not confined to a penalty area'],
      ['UNKNOWN', 'UNKNOWN', 'var(--v-violet)', 'evidence was insufficient to decide; nothing was forced'],
    ];

    var lanes = '<div class="vx-lanes">' + LANES.map(function (L) {
      var list = groups[L[0]];
      var obs = list.reduce(function (a, r) { return a + r.obs; }, 0);
      return '<div class="vx-lane" style="--v-lane:' + L[2] + '">'
        + '<div class="vx-lane-h"><span class="vx-lane-n">' + esc(L[1]) + '</span>'
        + (L[0] === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : Tag(list.length ? 'CLUSTERED' : 'NONE',
          list.length ? 'measured' : 'withheld')) + '</div>'
        + '<div class="vx-lane-v">' + list.length + '<small>tracks</small></div>'
        + Bar(obs / totalObs)
        + '<div class="vx-lane-s">' + esc(obs) + ' observations · ' + pct(obs / totalObs)
        + ' of the session</div>'
        + '<div class="vx-lane-ids">' + (list.length
          ? list.slice(0, 24).map(function (r) {
            return '<button class="vx-chipid" data-vx-role="' + esc(r.identity) + '" type="button"'
              + ' title="open the evidence for this track">#' + esc(r.identity) + '</button>';
          }).join('') + (list.length > 24 ? '<span class="vx-lane-s">+' + (list.length - 24) + '</span>' : '')
          : '<span class="vx-lane-s">none in this session</span>') + '</div>'
        + '<div class="vx-lane-s">' + esc(L[3]) + '</div></div>';
    }).join('') + '</div>';

    var rows = s.roles.map(function (r) {
      return '<tr class="is-clickable" data-vx-role="' + esc(r.identity) + '">'
        + '<td><b>#' + esc(r.identity) + '</b></td>'
        + '<td>' + (r.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(words(r.role))) + '</td>'
        + '<td>' + n(r.confidence, 2) + '</td><td>' + n(r.observations, 0) + '</td>'
        + '<td style="white-space:normal;max-width:70ch">' + esc(r.reason || '—') + '</td></tr>';
    });

    body(lanes + '<div class="vx-rowgap"></div>'
      + Panel('Assignment', '<div class="vx-stats">'
        + Stat('Team assignment', pct(s.summary.teamAssignmentRate),
          'given a team, not given the RIGHT team', { tone: 'cyan' })
        + Stat('Identities', esc(s.summary.identities), esc(s.summary.rawTrackIds) + ' raw track ids')
        + Stat('Role evidence', esc(s.roles.length), 'identities with a recorded reason')
        + '</div>', { ico: 'teams', tight: true })
      + '<div class="vx-rowgap"></div>'
      + Panel('Role evidence', rows.length
        ? Table('Per-identity role reasoning',
          ['Identity', 'Classification', 'Confidence', 'Observations', 'Reason'], rows)
          + '<p class="vx-note vx-note--warn">A role decided on METRIC POSITION requires calibration. '
          + 'Where the session had none, the honest answer is UNKNOWN, and UNKNOWN is what is stored '
          + 'and what is shown.</p>'
        : Empty('absent', 'NO ROLE EVIDENCE RECORDED',
          'This session produced no per-identity role reasoning', 'teams'), { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENTS — a three-column workstation: index, evidence, inspector
     ═══════════════════════════════════════════════════════════════════════════ */

  function secEvents() {
    setWorkbar('Events',
      '<button class="vx-btn" type="button" data-vx-section="live">' + ico('live') + 'Live Analysis</button>'
      + '<button class="vx-btn" type="button" data-vx-export="events"' + (FV.session ? '' : ' disabled')
      + '>' + ico('down') + 'Events JSON</button>');
    if (!FV.session) { body(needSession()); return; }

    var s = FV.session, frames = Math.max(1, s.summary.framesProcessed);
    if (!s.events.length) {
      body(Empty('withheld', 'NO EVENTS CONFIRMED',
        s.summary.capabilities.reasons.events
        || 'The engine confirmed no football event in this session', 'events'));
      return;
    }
    var sel = FV.selection.event
      ? s.events.filter(function (e) { return e.eventId === FV.selection.event; })[0] : null;

    var picker = s.events.map(function (e) {
      return '<button class="vx-pick" type="button" data-vx-event="' + esc(e.eventId) + '"'
        + (sel && sel.eventId === e.eventId ? ' aria-current="true"' : '') + '>'
        + '<span class="vx-pick-n">' + esc(e.timestamp.toFixed(1)) + '</span>'
        + '<span class="vx-pick-m"><b>' + esc(e.type) + '</b>'
        + '<span>frame ' + esc(e.frameNumber) + ' · track #'
        + esc(e.trackIds.join(', ') || '—') + '</span></span>'
        + '<span class="vx-pick-e">' + Tag(n(e.confidence, 2), 'withheld') + '</span></button>';
    }).join('');

    var left = Panel('Timeline', '<div class="vx-list" style="max-height:62vh;overflow:auto">'
      + picker + '</div>', { ico: 'timeline', tight: true,
        actions: Tag(s.events.length + ' CONFIRMED', 'measured') });

    /* The centre column is the evidence itself: where the selected finding sits
       on the pitch, and where every finding falls across the session. */
    var strip = s.events.map(function (e) {
      return '<button class="vx-tl-mark vx-tl-mark--event" data-vx-event="' + esc(e.eventId)
        + '" type="button" style="left:' + ((e.frameNumber / frames) * 100).toFixed(2) + '%"'
        + ' title="' + esc(e.type + ' · frame ' + e.frameNumber) + '">'
        + '<span class="vx-sr">' + esc(e.type) + ' at frame ' + esc(e.frameNumber) + '</span></button>';
    }).join('');

    var centreInner;
    if (sel && sel.pitchXM !== null) {
      centreInner = Pitch(
        '<circle cx="' + sel.pitchXM + '" cy="' + sel.pitchYM + '" r="5.5" fill="none"'
        + ' stroke="var(--v-cyan)" stroke-width=".28" opacity=".7"/>'
        + '<circle cx="' + sel.pitchXM + '" cy="' + sel.pitchYM + '" r="1.6" class="vx-dot-sel"/>'
        + s.tracks.filter(function (t) { return t.frameNumber === sel.frameNumber && t.pitchXM !== null; })
          .map(function (t) {
            return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="1.2" fill="' + trackTone(t)
              + '" opacity=".9"><title>#' + esc(t.identity) + '</title></circle>';
          }).join(''),
        { label: 'Pitch position of the selected finding', forceLines: true,
          style: 'max-height:100%;width:auto;max-width:100%' });
    } else if (sel) {
      centreInner = Empty('withheld', 'POSITION WITHHELD',
        'Calibration published no pitch coordinate at frame ' + sel.frameNumber
        + ', so this finding has no metric position', 'calib');
    } else {
      centreInner = Pitch('', { label: 'Pitch awaiting a selection', forceLines: true,
        style: 'max-height:100%;width:auto;max-width:100%;opacity:.5' });
    }

    var centre = Panel(sel ? 'Evidence · frame ' + sel.frameNumber : 'Evidence',
      '<div class="vx-surface" style="height:min(44vh,400px)">' + centreInner + '</div>'
      + '<div style="padding:0 12px 12px">'
      + '<div class="vx-tl">' + tlBand('Where they fall', s.events.length, strip
        + '<div class="vx-tl-cursor" style="left:' + ((FV.frame / frames) * 100).toFixed(2) + '%"></div>', true)
      + '</div>'
      + '<div class="vx-tl-ruler"><span>frame 0</span>'
      + '<span class="vx-lg"><i style="background:#fff"></i>one confirmed finding</span>'
      + '<span>frame ' + frames + '</span></div></div>',
      { accent: true, ico: 'events', flush: true,
        actions: sel ? '<button class="vx-btn vx-btn--sm" type="button" data-vx-seek="'
          + esc(sel.frameNumber) + '">Open in Live</button>' : '' });

    var right = sel
      ? Panel('Event inspector', Rows([
        ['Event id', '<span style="font-size:10px">' + esc(sel.eventId) + '</span>'],
        ['Type', '<b>' + esc(sel.type) + '</b>'],
        ['State', Tag(sel.state, sel.state === 'CONFIRMED' ? 'measured' : 'withheld')],
        ['Frame · time', esc(sel.frameNumber) + ' · ' + n(sel.timestamp, 3) + ' s'],
        ['Track IDs', sel.trackIds.length ? '#' + esc(sel.trackIds.join(', #'))
          : '<span class="vx-none">—</span>'],
        ['Team', sel.teamId ? esc(words(sel.teamId)) : '<span class="vx-none">—</span>'],
        ['Ball state', sel.ballState ? Tag(sel.ballState, sel.ballState === 'OBSERVED' ? 'measured'
          : 'propagated') : '<span class="vx-none">—</span>'],
        ['Pitch position', sel.pitchXM === null ? Tag('WITHHELD', 'withheld')
          : n(sel.pitchXM, 2) + ', ' + n(sel.pitchYM, 2) + ' m'],
        ['Confidence', n(sel.confidence, 3)],
        ['Origin', Tag(sel.origin, sel.origin === 'MEASURED' ? 'measured'
          : sel.origin === 'PROPAGATED' ? 'propagated' : 'withheld')],
        ['Distance to ball', sel.evidence && sel.evidence.distance_m !== undefined
          ? n(sel.evidence.distance_m, 2) + ' m' : '<span class="vx-none">—</span>',
          'geometry; no interaction is claimed'],
      ]) + (sel.reason ? '<p class="vx-note">' + esc(sentence(sel.reason)) + '</p>' : ''),
        { ico: 'events', accent: true, tight: true, actions: Tag('EVIDENCE', 'derived') })
      : Panel('No event selected',
        '<p class="vx-note" style="border:0;padding:0;margin:0">Choose a finding on the left, or a '
        + 'mark on the timeline, to read the evidence the engine recorded for it.</p>',
        { ico: 'events', tight: true });

    var counts = {};
    s.events.forEach(function (e) { counts[e.type + ' · ' + e.state] = (counts[e.type + ' · ' + e.state] || 0) + 1; });
    var countStrip = Panel('Findings by kind', '<div class="vx-stats">'
      + Object.keys(counts).map(function (k) {
        var isProx = k.indexOf('PROXIMITY') === 0;
        return Stat(k, esc(counts[k]), isProx
          ? 'distance only · asserts no touch and no possession'
          : 'confirmed against ball evidence, not from proximity', { tone: isProx ? '' : 'green' });
      }).join('') + '</div>', { ico: 'insight', tight: true,
        actions: Tag('NOT POSSESSION', 'withheld') });

    var rows = s.events.map(function (e) {
      return '<tr class="is-clickable" data-vx-event="' + esc(e.eventId) + '"'
        + (sel && sel.eventId === e.eventId ? ' aria-selected="true"' : '') + '>'
        + '<td><b>' + esc(e.type) + '</b><span class="vx-td-sub">' + esc(e.eventId) + '</span></td>'
        + '<td>' + Tag(e.state, e.state === 'CONFIRMED' ? 'measured' : 'withheld') + '</td>'
        + '<td>' + esc(e.frameNumber) + '</td><td>' + n(e.timestamp, 2) + '</td>'
        + '<td>' + (e.trackIds.length ? '#' + esc(e.trackIds.join(', #')) : '<span class="vx-none">—</span>') + '</td>'
        + '<td>' + (e.teamId ? esc(words(e.teamId)) : '<span class="vx-none">—</span>') + '</td>'
        + '<td>' + (e.ballState ? esc(e.ballState) : '<span class="vx-none">—</span>') + '</td>'
        + '<td>' + n(e.confidence, 2) + '</td>'
        + '<td>' + Tag(e.origin, e.origin === 'MEASURED' ? 'measured'
          : e.origin === 'PROPAGATED' ? 'propagated' : 'withheld') + '</td>'
        + '<td style="white-space:normal;max-width:64ch">' + esc(e.reason || '—') + '</td>'
        + '<td><button class="vx-btn vx-btn--sm" data-vx-seek="' + esc(e.frameNumber) + '" type="button">seek</button></td></tr>';
    });

    body('<div class="vx-3col">' + left + centre + right + '</div>'
      + '<div class="vx-rowgap"></div>' + countStrip + '<div class="vx-rowgap"></div>'
      + Panel('Evidence record', Table('Confirmed football events',
        ['Event', 'State', 'Frame', 't (s)', 'Tracks', 'Team', 'Ball', 'Conf', 'Origin', 'Reason', ''],
        rows), { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     TACTICAL VIEW — the pitch is the subject, even when it is empty
     ═══════════════════════════════════════════════════════════════════════════ */

  function secTactical() {
    setWorkbar('Tactical View',
      '<button class="vx-btn" type="button" data-vx-section="heatmaps">' + ico('heat') + 'Heatmaps</button>');
    var caps = FV.session && FV.session.summary.capabilities;

    var needs = [
      ['Team shape', 'a formation requires sustained metric coverage of both teams at once'],
      ['Zones', 'zone occupancy requires a possession attribution the engine does not produce'],
      ['Space', 'controlled space requires every player located in the same frame'],
      ['Passing lanes', 'a lane requires a pass, and no pass is confirmed by the engine'],
      ['Pressing', 'pressing requires possession, which proximity is not'],
      ['Transitions', 'a transition requires two possessions to move between'],
      ['Available actions', 'requires all of the above'],
    ].map(function (a) {
      return '<div class="vx-await"><span class="vx-await-k">' + esc(a[0]) + '</span>'
        + '<span class="vx-await-v vx-none">—</span>'
        + '<span class="vx-await-s">' + esc(a[1]) + '</span>'
        + Tag('PENDING', 'future') + '</div>';
    }).join('');

    var stage = Panel('Tactical surface',
      '<div class="vx-surface" style="height:min(62vh,560px)">'
      + Pitch('', { label: 'Pitch with no tactical result to draw', forceLines: true,
        style: 'max-height:100%;width:auto;max-width:100%' })
      + '<div class="vx-surface-over">'
      + '<span class="vx-surface-t">TACTICAL INTELLIGENCE</span>'
      + '<span class="vx-surface-t2">WAITING FOR VALIDATED EVIDENCE</span>'
      + '<p class="vx-surface-p">' + esc(sentence((caps && caps.reasons.tactical)
        || 'Tactical intelligence is not implemented in the validated engine. No formation, team '
          + 'shape, zone, controlled space, passing lane, pressing, overload or transition result '
          + 'exists to display, and drawing one from position data alone would be a diagram of an '
          + 'assumption rather than a finding')) + '</p></div></div>',
      { accent: true, ico: 'tactical', flush: true, actions: Tag('AWAITING EVIDENCE', 'future') });

    var rail = '<div class="vx-stack">'
      + Panel('What a tactical result would need', Rows([
        ['Sustained metric coverage across both teams',
          caps && caps.metricCoordinates ? Tag('PARTIAL', 'propagated') : Tag('NOT MET', 'future')],
        ['Possession attribution beyond confirmed control', Tag('NOT IMPLEMENTED', 'future')],
        ['Human-verified ground truth to validate against', Tag('NONE EXISTS', 'future')],
      ]) + '<p class="vx-note vx-note--warn">The contract is in place — a tactical result would '
        + 'arrive as its own evidence type, with its own confidence, through the same session API. '
        + 'Nothing about this screen would need rebuilding. What is missing is the finding, not the '
        + 'plumbing.</p>', { ico: 'health', accent: true, tight: true })
      + Panel('Every reading that is waiting', '<div class="vx-stack">' + needs + '</div>',
        { ico: 'tactical', tight: true }) + '</div>';

    body('<div class="vx-2col--wide vx-2col">' + stage + rail + '</div>');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HEATMAPS — pitch first, filters beside it
     ═══════════════════════════════════════════════════════════════════════════ */

  function secHeatmaps() {
    setWorkbar('Heatmaps',
      '<button class="vx-btn" type="button" data-vx-section="tracking">' + ico('track') + 'Player Tracking</button>');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session, caps = s.summary.capabilities;
    if (!caps.heatmaps) {
      body(Panel('Occupancy',
        '<div class="vx-surface" style="height:min(58vh,520px)">'
        + Pitch('', { label: 'Pitch with no calibrated occupancy', forceLines: true,
          style: 'max-height:100%;width:auto;max-width:100%' })
        + '<div class="vx-surface-over"><span class="vx-surface-t">OCCUPANCY</span>'
        + '<span class="vx-surface-t2">INSUFFICIENT VALIDATED DATA</span>'
        + '<p class="vx-surface-p">' + esc(sentence(caps.reasons.heatmaps
          || 'this session published too few calibrated positions to count into cells')) + '</p></div></div>',
        { accent: true, ico: 'heat', flush: true, actions: Tag('NOT AVAILABLE', 'withheld') }));
      return;
    }

    var teams = {}, players = {};
    s.tracks.forEach(function (t) {
      if (t.pitchXM === null) return;
      teams[t.teamId || 'UNASSIGNED'] = 1; players[t.identity] = 1;
    });
    var pool = s.tracks.filter(function (t) {
      if (t.pitchXM === null || t.pitchYM === null) return false;
      if (FV.selection.heatTeam && (t.teamId || 'UNASSIGNED') !== FV.selection.heatTeam) return false;
      if (FV.selection.heatPlayer && t.identity !== FV.selection.heatPlayer) return false;
      if (FV.filters.conf === 'high' && t.calibrationChain !== 'measured') return false;
      if (FV.filters.conf === 'low' && t.calibrationChain !== 'propagated') return false;
      return true;
    });

    var filters = '<div class="vx-filters">'
      + '<span class="vx-flabel">Team</span>'
      + '<select class="vx-select" data-vx-select="heatTeam" aria-label="Filter heatmap by team">'
      + '<option value="">All teams</option>' + Object.keys(teams).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.selection.heatTeam === t ? ' selected' : '') + '>'
          + esc(words(t)) + '</option>'; }).join('') + '</select>'
      + '<span class="vx-flabel">Player</span>'
      + '<select class="vx-select" data-vx-select="heatPlayer" aria-label="Filter heatmap by player">'
      + '<option value="">All players</option>' + Object.keys(players).sort(function (a, b) {
        return (+a || 0) - (+b || 0); }).map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.selection.heatPlayer === t ? ' selected' : '') + '>#'
          + esc(t) + '</option>'; }).join('') + '</select>'
      + '<span class="vx-flabel">Evidence quality</span>'
      + '<select class="vx-select" data-vx-filter="conf" aria-label="Filter by evidence quality">'
      + [['', 'Measured and propagated'], ['high', 'Measured only'], ['low', 'Propagated only']]
        .map(function (v) {
          return '<option value="' + v[0] + '"' + (FV.filters.conf === v[0] ? ' selected' : '') + '>'
            + esc(v[1]) + '</option>'; }).join('') + '</select>'
      + '</div>'
      + '<p class="vx-note">Time window is the whole session: the engine publishes one processing pass '
      + 'per session and no per-window aggregate, so a window control here would filter nothing.</p>';

    if (!pool.length) {
      body('<div class="vx-2col--wide vx-2col">'
        + Panel('Occupancy', '<div class="vx-surface" style="height:min(56vh,500px)">'
          + Pitch('', { label: 'No calibrated position for this selection', forceLines: true,
            style: 'max-height:100%;width:auto;max-width:100%' })
          + '<div class="vx-surface-over"><span class="vx-surface-t">SELECTION</span>'
          + '<span class="vx-surface-t2" style="font-size:19px">NO CALIBRATED POSITION</span></div></div>',
          { accent: true, ico: 'heat', flush: true })
        + Panel('Selection', filters, { ico: 'config', tight: true }) + '</div>');
      return;
    }

    var g = heatGrid(pool);
    var occupied = 0;
    for (var i = 0; i < g.grid.length; i++) if (g.grid[i]) occupied += 1;

    body('<div class="vx-2col--wide vx-2col">'
      + Panel('Occupancy', '<div class="vx-surface" style="height:min(58vh,520px)">'
        + Pitch(heatCells(g.grid, g.max), { label: 'Occupancy heatmap', forceLines: true,
          style: 'max-height:100%;width:auto;max-width:100%' }) + '</div>'
        + '<p class="vx-note" style="margin:0 12px 10px">Built from ' + pool.length + ' calibrated '
        + 'positions counted into five-metre cells. Nothing is smoothed and nothing is interpolated '
        + 'between observations, so an empty cell means no calibrated position landed there — not '
        + 'low activity.</p>',
        { accent: true, ico: 'heat', flush: true, actions: Tag('MEASURED', 'measured') })
      + '<div class="vx-stack">'
      + Panel('Selection', filters, { ico: 'config', tight: true })
      + Panel('What is on the pitch', '<div class="vx-stats">'
        + Stat('Positions', esc(pool.length), 'after the selection', { tone: 'cyan' })
        + Stat('Busiest cell', esc(g.max), 'positions in one five-metre cell')
        + Stat('Cells occupied', esc(occupied) + '<small> / ' + (HEAT_CX * HEAT_CY) + '</small>',
          'an empty cell is drawn empty, not dim')
        + '</div>' + '<div class="vx-rowgap"></div>' + Bar(occupied / (HEAT_CX * HEAT_CY), 'measured'),
        { ico: 'grid2d', tight: true })
      + '</div></div>');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     TIMELINE — the whole session at once, full width, one playhead
     ═══════════════════════════════════════════════════════════════════════════ */

  function secTimeline() {
    setWorkbar('Timeline',
      '<button class="vx-btn" type="button" data-vx-seek="' + FV.frame + '">' + ico('live')
      + 'Open frame ' + FV.frame + '</button>');
    if (!FV.session) { body(needSession()); return; }
    if (!FV.timeline) { body(Empty('withheld', 'READING TIMELINE', 'One moment')); return; }

    var tl = FV.timeline, total = Math.max(1, tl.frames);
    var cursor = '<div class="vx-tl-cursor" style="left:' + ((FV.frame / total) * 100).toFixed(3) + '%"></div>';

    function band(label, kinds, cls) {
      var spans = tl.spans.filter(function (x) { return kinds.indexOf(x.kind) >= 0; });
      var inner = spans.map(function (x) {
        var kind = /VALID|OBSERVED/.test(x.kind) ? (/OBSERVED/.test(x.kind) ? 'obs' : 'valid')
          : /PROPAGATED/.test(x.kind) ? 'prop' : /GAP/.test(x.kind) ? 'gap' : 'none';
        return '<div class="vx-tl-span vx-tl-span--' + kind + '" style="left:'
          + ((x.fromFrame / total) * 100).toFixed(3) + '%;width:'
          + Math.max(0.2, (x.frames / total) * 100).toFixed(3) + '%" title="' + esc(words(x.kind))
          + ' · frames ' + x.fromFrame + '–' + x.toFrame + '"></div>';
      }).join('');
      return tlBand(label, spans.length + ' spans', inner + cursor);
    }
    function marks(label, kind, cls) {
      var hits = tl.marks.filter(function (x) { return x.kind === kind; });
      var m = hits.map(function (x) {
        return '<button class="vx-tl-mark vx-tl-mark--' + cls + '" style="left:'
          + ((x.frame / total) * 100).toFixed(3) + '%" data-vx-seek="' + x.frame
          + '" data-vx-stay type="button" title="' + esc(x.label + (x.detail ? ' — ' + x.detail : ''))
          + '"><span class="vx-sr">' + esc(x.label) + ' at frame ' + x.frame + '</span></button>';
      }).join('');
      return tlBand(label, hits.length, (m || '<span class="vx-lane-s" style="padding-left:4px">'
        + 'none in this session</span>') + cursor, true);
    }

    var sm = FV.session.summary;
    var sourceBand = tlBand('Video / source', sm.framesProcessed + ' frames',
      '<div class="vx-tl-span vx-tl-span--src" style="left:0;width:100%" title="'
      + esc(sm.source.displayName) + '"></div>' + cursor);
    var unknownSpans = FV.session.ball.filter(function (b) { return b.state === 'UNKNOWN'; });
    var unknownBand = tlBand('Unknown', unknownSpans.length + ' frames',
      tlSpans(unknownSpans, total, function () { return 'none'; },
        function () { return 'ball UNKNOWN'; }) + cursor);

    var legend = Object.keys(tl.legend).map(function (k) {
      return ['<b>' + esc(words(k)) + '</b>', '<span style="font-size:10.5px;font-weight:500;'
        + 'color:var(--v-tx-3);text-align:left;display:block;max-width:64ch">'
        + esc(tl.legend[k]) + '</span>'];
    });

    body(Panel('Session timeline · ' + tl.durationSeconds + ' s · ' + tl.frames + ' frames',
      '<div class="vx-tl vx-tl--tall">'
      + sourceBand
      + band('Players', ['CALIBRATION_VALID', 'CALIBRATION_PROPAGATED'])
      + band('Ball', ['BALL_OBSERVED', 'BALL_PROPAGATED', 'BALL_GAP'])
      + band('Calibration', ['CALIBRATION_VALID', 'CALIBRATION_PROPAGATED', 'CALIBRATION_NONE'])
      + marks('Events', 'EVENT', 'event')
      + marks('Anchors', 'CALIBRATION_ANCHOR', 'anchor')
      + marks('Shot cuts', 'SHOT_BOUNDARY', 'cut')
      + unknownBand
      + '</div>'
      + '<div class="vx-tl-ruler"><span>0 s</span>'
      + '<span class="vx-legend">'
      + '<span class="vx-lg"><i style="background:var(--v-green)"></i>MEASURED</span>'
      + '<span class="vx-lg"><i style="background:#cbd5e1"></i>OBSERVED</span>'
      + '<span class="vx-lg"><i style="background:var(--v-amber)"></i>PROPAGATED</span>'
      + '<span class="vx-lg"><i style="background:rgba(93,107,136,.6)"></i>NO RECORD</span>'
      + '<span class="vx-lg"><i style="background:var(--v-violet)"></i>SHOT CUT</span>'
      + '</span><span>' + tl.durationSeconds + ' s</span></div>',
      { accent: true, ico: 'timeline' })
      + '<div class="vx-rowgap"></div>'
      + Panel('What each band means', Rows(legend), { ico: 'insight', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SESSIONS
     ═══════════════════════════════════════════════════════════════════════════ */

  function secSessions() {
    setWorkbar('Sessions', '');
    if (!FV.sessions) { body(Empty('withheld', 'READING SESSIONS', 'One moment')); return; }
    if (FV.sessions.ok === false) {
      body(Empty('withheld', 'SESSIONS UNAVAILABLE', FV.sessions.error || '')); return;
    }
    var list = FV.sessions.sessions || [];
    if (!list.length) {
      body(Empty('withheld', 'NO SESSION VISIBLE TO THIS ACCOUNT',
        'A session is visible to the club that owns it and to the platform owner. None is visible here',
        'sessions'));
      return;
    }
    var filtered = list.filter(function (x) {
      if (FV.filters.session && x.sessionRef.toLowerCase().indexOf(FV.filters.session.toLowerCase()) < 0) return false;
      if (FV.filters.source && x.source.sourceType !== FV.filters.source) return false;
      return true;
    });
    var types = {};
    list.forEach(function (x) { types[x.source.sourceType] = 1; });

    var tiles = filtered.map(function (x) {
      var on = x.sessionRef === FV.sessionRef;
      return '<div class="vx-bay ' + (on ? 'vx-bay--on' : '') + '">'
        + '<div class="vx-bay-h"><span class="vx-bay-ico">' + ico('shot') + '</span>'
        + '<div style="flex:1 1 auto;min-width:0">'
        + '<div class="vx-bay-n" data-user-content>' + esc(x.sessionRef) + '</div>'
        + '<div class="vx-bay-t" data-user-content>' + esc(x.source.displayName) + ' · '
        + esc(x.source.width) + '×' + esc(x.source.height) + ' · ' + n(x.source.fps, 2) + ' fps</div>'
        + '</div>' + (on ? Chip('', 'LIVE') : Chip('', 'READY')) + '</div>'
        + '<div class="vx-stats">'
        + Stat('Frames', esc(x.framesProcessed), '')
        + Stat('Observations', esc(x.observationsTotal), '')
        + Stat('Calibration', pct(x.calibrationCoverage), '')
        + Stat('Ball observed', pct(x.ballObservedCoverage), '')
        + '</div>'
        + Rows([
          ['Events confirmed', esc(x.eventsConfirmed !== undefined ? x.eventsConfirmed
            : Object.keys(x.eventCounts || {}).reduce(function (a, k) { return a + x.eventCounts[k]; }, 0))],
          ['Pipeline', '<span style="font-size:10px">' + esc(x.pipelineVersion || '—') + '</span>'],
          ['Scope', x.clubId ? Tag(x.clubId, 'accent') : Tag('PLATFORM', 'withheld')],
          ['Generated', '<span style="font-size:10.5px">'
            + esc((x.generatedAt || '').replace('T', ' ').replace('Z', '')) + '</span>'],
        ])
        + '<button class="vx-btn' + (on ? ' is-on' : '') + '" type="button" data-vx-open-session="'
        + esc(x.sessionRef) + '">' + ico(on ? 'live' : 'arrow')
        + (on ? 'Currently loaded' : 'Open session') + '</button></div>';
    }).join('');

    body(Panel('Processed sessions',
      '<div class="vx-filters" style="margin-bottom:10px">'
      + '<input class="vx-input" data-vx-filter="session" placeholder="Search session…" value="'
      + esc(FV.filters.session) + '" aria-label="Search session">'
      + '<select class="vx-select" data-vx-filter="source" aria-label="Filter by source type">'
      + '<option value="">All source types</option>' + Object.keys(types).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.filters.source === t ? ' selected' : '') + '>'
          + esc(words(t)) + '</option>'; }).join('') + '</select></div>'
      + '<div class="vx-bays">' + tiles + '</div>'
      + '<p class="vx-note">A session with no declared club is platform-scoped: the platform owner sees '
      + 'it and nobody else does. Ownership is declared beside the evidence, never guessed from a '
      + 'filename.</p>',
      { ico: 'sessions', accent: true,
        actions: Tag(filtered.length + ' / ' + list.length, 'accent') }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SOURCES — device bays
     ═══════════════════════════════════════════════════════════════════════════ */

  var SLOT_ICON = {
    main: 'camera', 'corner-1': 'camera', 'corner-2': 'camera', 'corner-3': 'camera',
    'corner-4': 'camera', drone: 'drone', 'field-nodes': 'node', 'player-pods': 'pod',
    'ball-sensor': 'sensor',
  };

  function secSources() {
    setWorkbar('Sources',
      '<button class="vx-btn" type="button" data-vx-section="device">' + ico('device') + 'Vision Hub</button>');
    if (!FV.sources) { body(Empty('withheld', 'READING SOURCES', 'One moment')); return; }
    if (FV.sources.ok === false) {
      body(Empty('withheld', 'SOURCES UNAVAILABLE', FV.sources.error || '')); return;
    }
    var connected = FV.sources.connected || [];

    var live = connected.map(function (c) {
      return '<div class="vx-bay vx-bay--on">'
        + '<div class="vx-bay-h"><span class="vx-bay-ico">' + ico('camera') + '</span>'
        + '<div style="flex:1 1 auto;min-width:0"><div class="vx-bay-n" data-user-content>'
        + esc(c.displayName) + '</div>'
        + '<div class="vx-bay-t">' + esc(words(c.sourceType)) + ' · session '
        + esc(c.sessionRef) + '</div></div>' + Chip('', 'READY') + '</div>'
        + '<div class="vx-bay-w">' + esc(c.width) + '×' + esc(c.height) + ' · '
        + n(c.fps, 2) + ' fps · quality ' + esc(c.qualityBand || 'UNKNOWN') + '</div></div>';
    }).join('');

    var slots = (FV.sources.slots || []).map(function (s) {
      return '<div class="vx-bay vx-bay--off">'
        + '<div class="vx-bay-h"><span class="vx-bay-ico">' + ico(SLOT_ICON[s.slot] || 'camera') + '</span>'
        + '<div style="flex:1 1 auto;min-width:0"><div class="vx-bay-n">' + esc(s.label) + '</div>'
        + '<div class="vx-bay-t">' + esc(words(s.intendedType)) + '</div></div>'
        + Chip('', 'NOT_IMPLEMENTED') + '</div>'
        + '<div class="vx-bay-w">Declared and empty. Waiting on '
        + esc(words(s.waitingOn).toLowerCase()) + '.</div></div>';
    }).join('');

    var types = (FV.sources.types || []).map(function (t) {
      return '<tr><td><b>' + esc(t.label) + '</b><span class="vx-td-sub">' + esc(t.type) + '</span></td>'
        + '<td>' + (t.implemented ? Tag('IMPLEMENTED', 'measured') : Tag('NOT IMPLEMENTED', 'future')) + '</td>'
        + '<td>' + (t.waitingOn === 'NOTHING' ? '<span class="vx-none">—</span>'
          : Tag(words(t.waitingOn), 'future')) + '</td>'
        + '<td style="white-space:normal;max-width:70ch">' + esc(t.describes) + '</td></tr>';
    });

    body(Panel('Sources in use', live
      ? '<div class="vx-bays">' + live + '</div>'
      : Empty('withheld', 'NO SOURCE ATTACHED',
        'The sessions in this deployment were produced by the engine from recorded video; a live '
        + 'source would appear here', 'sources'),
      { accent: true, ico: 'sources', actions: Tag(connected.length + ' RECORDED', 'measured') })
      + '<div class="vx-rowgap"></div>'
      + Panel('Rig bays', '<div class="vx-bays">' + slots + '</div>'
        + '<p class="vx-note vx-note--warn">Every bay above is empty and every one is drawn as empty. '
        + 'None of this hardware exists, and none of it is shown as connected, degraded or waiting for '
        + 'a signal — those would all imply something is there.</p>',
        { ico: 'device', actions: Tag('ALL EMPTY', 'future') })
      + '<div class="vx-rowgap"></div>'
      + Panel('Source type vocabulary', Table('Source types and their implementation state',
        ['Type', 'State', 'Waiting on', 'What is actually behind it'], types)
        + '<p class="vx-note">Camera manufacturer is metadata. Nothing in the Vision engine branches on '
        + 'brand — a Sony body is a video source with Sony on its label, and the day that stops '
        + 'being true is the day Familista Vision becomes a Sony product.</p>',
        { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DEVICE / VISION HUB — hardware-control software
     ═══════════════════════════════════════════════════════════════════════════ */

  function secDevice() {
    setWorkbar('Device / Vision Hub',
      '<button class="vx-btn" type="button" data-vx-section="sources">' + ico('sources') + 'Sources</button>');
    if (!FV.device) { body(Empty('withheld', 'READING DEVICE', 'One moment')); return; }
    if (FV.device.ok === false) {
      body(Empty('withheld', 'DEVICE UNAVAILABLE', FV.device.error || '')); return;
    }
    var d = FV.device.device, t = FV.device.telemetry;
    var h = FV.status && FV.status.health;
    var gb = function (v) { return v ? (v / 1073741824).toFixed(1) : null; };

    function absent(label, spec, what) {
      var st = (spec && spec.status) || 'NOT_AVAILABLE';
      return '<div class="vx-await"><span class="vx-await-k">' + esc(label) + '</span>'
        + '<span class="vx-await-v vx-none">—</span>'
        + '<span class="vx-await-s">' + esc(sentence((spec && spec.reason) || what || 'not measured'))
        + '</span>' + Chip('', st) + '</div>';
    }

    var faceplate = Panel(null,
      '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">'
      + '<span style="width:56px;height:56px;border-radius:12px;display:grid;place-items:center;'
      + 'background:linear-gradient(140deg,rgba(34,211,238,.22),rgba(139,92,246,.18));'
      + 'color:var(--v-cyan);border:1px solid rgba(34,211,238,.35)">'
      + '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6">' + ICONS.device + '</svg></span>'
      + '<div style="flex:1 1 260px;min-width:0">'
      + '<div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--v-tx-3)">'
      + 'Familista Vision Hub · current mode</div>'
      + '<div style="font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1.1">'
      + esc(d.label) + '</div>'
      + '<div style="font-size:11px;color:var(--v-tx-3);margin-top:3px">'
      + '<code>' + esc(d.deviceId) + '</code> · ' + esc(sentence(d.reason || 'the engine answered'))
      + '</div></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">' + Chip('', d.status)
      + Tag(words(d.processingTarget), 'accent') + '</div></div>',
      { accent: true });

    var dials = [];
    if (t && !t.status) {
      dials.push(Stat('CPU', n(t.cpuCores, 0) + '<small> cores</small>',
        'load average 1m ' + n(t.loadAverage1m, 2), { ico: 'cpu' }));
      dials.push(Stat('Memory', n(gb(t.memoryTotalBytes), 1) + '<small> GB</small>',
        gb(t.memoryFreeBytes) + ' GB free', { ico: 'vault' }));
      if (t.storageTotalBytes) {
        dials.push(Stat('Storage', n(gb(t.storageTotalBytes), 1) + '<small> GB</small>',
          gb(t.storageFreeBytes) + ' GB free', { ico: 'vault' }));
      }
      dials.push(Stat('Uptime', n(Math.round((t.uptimeSeconds || 0) / 3600), 0) + '<small> h</small>',
        'host uptime', { ico: 'timeline' }));
    }
    dials.push(Stat('Processing', FV.session ? n(FV.session.summary.processingFps, 2) + '<small> fps</small>'
      : '<span class="vx-none">—</span>',
      FV.session ? 'measured on ' + FV.session.summary.sessionRef : 'no session open', { ico: 'perf' }));
    dials.push(Stat('Network', h ? 'LIVE' : '<span class="vx-none">—</span>',
      'the platform served this request', { ico: 'flow', tone: 'green' }));
    dials.push(Stat('API', h ? esc(h.eventTypes) + '<small> types</small>' : '<span class="vx-none">—</span>',
      'Vision event types registered', { ico: 'node' }));

    var measured = (t && t.status)
      ? Panel('Host telemetry', '<div class="vx-stack">' + absent('Host telemetry', t, t.reason) + '</div>',
        { ico: 'cpu', tight: true })
      : Panel('Measured on this host', '<div class="vx-stats">' + dials.join('') + '</div>',
        { ico: 'cpu', tight: true, actions: Chip('', 'READY') });

    var absences = (t && !t.status)
      ? Panel('Not present on this host', '<div class="vx-stack">'
        + absent('GPU', t.gpu) + absent('Temperature', t.temperatureCelsius)
        + absent('Battery', t.batteryPercent) + absent('Camera link', t.cameraLink) + '</div>'
        + '<p class="vx-note">These are absences, not failures. A software device on a server has no '
        + 'battery and no camera link, and drawing a zero for either would be a reading this host never '
        + 'took.</p>', { ico: 'absent', tight: true, actions: Tag('NOT MEASURED', 'withheld') })
      : '';

    var loaded = Panel('Loaded now', Rows([
      ['Current session', FV.session ? '<b data-user-content>' + esc(FV.session.summary.sessionRef) + '</b>'
        : '<span class="vx-none">—</span>',
        FV.session ? FV.session.summary.framesProcessed + ' frames' : 'no session open'],
      ['Current source', FV.session ? esc(FV.session.summary.source.displayName)
        : '<span class="vx-none">—</span>',
        FV.session ? words(FV.session.summary.source.sourceType) : 'no source attached'],
      ['Processing target', h ? esc(words(h.processingTarget)) : '<span class="vx-none">—</span>'],
      ['Vision engine', Chip('', d.status)],
      ['Sessions stored', h && h.sessions.stored !== null ? esc(h.sessions.stored)
        : '<span class="vx-none">—</span>', h ? h.sessions.note : ''],
    ]), { ico: 'sessions', tight: true });

    body(faceplate + '<div class="vx-rowgap"></div>'
      + '<div class="vx-2col">' + measured + loaded + '</div>'
      + (absences ? '<div class="vx-rowgap"></div>' + absences : '')
      + '<div class="vx-rowgap"></div>'
      + Panel('Future hardware target', Rows([
        ['FAMILISTA VISION HUB', Chip('', 'NOT_IMPLEMENTED')],
        ['Current processing target', esc(words(d.processingTarget))],
        ['Adapter', 'addressable today; refuses every call'],
      ]) + '<p class="vx-note vx-note--warn">Selecting the VISION_HUB target today runs the entire '
        + 'platform against an adapter that refuses every call and says why. Nothing about the device '
        + 'is simulated — no invented temperature, no invented battery, no invented fan speed, no '
        + 'invented sensor count. When the hardware exists, one adapter changes and this screen does '
        + 'not.</p>', { ico: 'future', tight: true, actions: Tag('ARCHITECTURE TARGET', 'future') }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MODELS & PROVIDERS
     ═══════════════════════════════════════════════════════════════════════════ */

  function secModels() {
    setWorkbar('Models & Providers', '');
    if (!FV.models) { body(Empty('withheld', 'READING MODEL REGISTRY', 'One moment')); return; }
    if (FV.models.ok === false) {
      body(Empty('withheld', 'MODEL REGISTRY UNAVAILABLE', FV.models.error || '')); return;
    }
    var models = FV.models.models || [];
    var providers = (FV.session && FV.session.summary.providers) || FV.models.providers || [];
    var counts = { VERIFIED: 0, RESTRICTED: 0, UNKNOWN: 0 };
    models.forEach(function (m) { counts[m.commercialUse] = (counts[m.commercialUse] || 0) + 1; });

    var strip = '<div class="vx-stats">'
      + Stat('Cleared for commercial use', esc(counts.VERIFIED || 0) + '<small> models</small>',
        'licence read, and it permits proprietary use', { tone: 'green', ico: 'models' })
      + Stat('Restricted', esc(counts.RESTRICTED || 0) + '<small> models</small>',
        'licence read; it does not permit it without further action', { tone: 'amber', ico: 'models' })
      + Stat('Unknown', esc(counts.UNKNOWN || 0) + '<small> models</small>',
        'nobody has checked — not a milder restriction, an unpriced one',
        { tone: 'violet', ico: 'absent' })
      + Stat('Registered', esc(models.filter(function (m) { return m.registered; }).length)
        + '<small> of ' + models.length + '</small>', 'present in the Model Registry', { ico: 'node' })
      + '</div>';

    var roleTiles = '<div class="vx-bays">' + providers.map(function (p) {
      return '<div class="vx-bay vx-bay--on">'
        + '<div class="vx-bay-h"><span class="vx-bay-ico">' + ico('models') + '</span>'
        + '<div style="flex:1 1 auto;min-width:0"><div class="vx-bay-n">' + esc(words(p.role)) + '</div>'
        + '<div class="vx-bay-t">' + esc(p.provider) + '</div></div>' + Chip('', 'READY') + '</div>'
        + '<div class="vx-bay-w">' + esc((p.modelIds || []).join(', ')) + '</div>'
        + (p.fusesDetectionAndTracking ? Tag('FUSES DETECTION + TRACKING', 'accent') : '')
        + '</div>';
    }).join('') + '</div>';

    var rows = models.map(function (m) {
      return '<tr><td><b>' + esc(m.modelId) + '</b><span class="vx-td-sub">' + esc(m.name || '') + '</span></td>'
        + '<td>' + esc(words(m.task)) + '</td><td>' + esc(m.version || '—') + '</td>'
        + '<td>' + esc(m.framework || '—') + '</td>'
        + '<td>' + (m.weights ? '<span style="font-size:10px">' + esc(m.weights) + '</span>'
          : '<span class="vx-none">—</span>') + '</td>'
        + '<td>' + (m.checksumSha256 ? '<span style="font-size:10px">'
          + esc(String(m.checksumSha256).slice(0, 12)) + '…</span>'
          : '<span class="vx-none">—</span>') + '</td>'
        + '<td style="white-space:normal;max-width:36ch"><span style="font-size:10.5px">sw '
        + esc(m.licenceSoftware || '—') + '<br>weights ' + esc(m.licenceWeights || '—')
        + '</span></td>'
        + '<td>' + Tag(m.commercialUse, m.commercialUse === 'VERIFIED' ? 'measured'
          : m.commercialUse === 'RESTRICTED' ? 'propagated' : 'unver')
        + '<span class="vx-td-sub">' + esc(words(m.licenceVerification || '')) + '</span></td>'
        + '<td>' + (m.registered ? Tag('VALIDATED', 'measured') : Tag('UNVERIFIED', 'unver')) + '</td></tr>';
    });

    body(Panel('Licence posture', strip, { accent: true, ico: 'models', tight: true })
      + '<div class="vx-rowgap"></div>'
      + Panel('Providers by role', roleTiles
        + '<p class="vx-note">A role names what fills it. Swapping a model is configuration; nothing in '
        + 'this frontend names a checkpoint file.</p>', { ico: 'flow', tight: true })
      + '<div class="vx-rowgap"></div>'
      + Panel('Model registry', Table('Models behind this result',
        ['Model', 'Task', 'Version', 'Framework', 'Weights', 'Checksum', 'Licence', 'Commercial use',
          'Validation'], rows), { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     REPORTS
     ═══════════════════════════════════════════════════════════════════════════ */

  function secReports() {
    setWorkbar('Reports', '');
    if (!FV.session) { body(needSession()); return; }
    var sm = FV.session.summary;
    var REPORTS = [
      ['session', 'Session JSON', 'json', 'the whole normalised session as the API returns it'],
      ['summary', 'Session summary', 'json', 'counts, coverages and capabilities only'],
      ['tracks', 'Tracking JSON', 'json', 'every observation with its provenance'],
      ['tracks-csv', 'Tracking CSV', 'csv', 'the same rows, for a spreadsheet'],
      ['ball', 'Ball JSON', 'json', 'every ball sample, OBSERVED and PROPAGATED kept apart'],
      ['calibration', 'Calibration JSON', 'json', 'per-frame chain, band and expected error'],
      ['events', 'Events JSON', 'json', 'confirmed findings and their reasons'],
      ['evidence', 'Intelligence evidence bundle', 'json',
        'what Familista Intelligence is offered — positions and findings, and no rating'],
    ];
    var tiles = '<div class="vx-bays">' + REPORTS.map(function (r) {
      return '<div class="vx-bay">'
        + '<div class="vx-bay-h"><span class="vx-bay-ico">' + ico('reports') + '</span>'
        + '<div style="flex:1 1 auto;min-width:0"><div class="vx-bay-n">' + esc(r[1]) + '</div>'
        + '<div class="vx-bay-t">' + esc(r[2].toUpperCase()) + '</div></div></div>'
        + '<div class="vx-bay-w">' + esc(r[3]) + '</div>'
        + '<button class="vx-btn" type="button" data-vx-export="' + esc(r[0]) + '">'
        + ico('down') + 'Download</button></div>';
    }).join('') + '</div>';

    body(Panel('Exports', tiles, { accent: true, ico: 'reports',
      actions: Tag('ORIGINAL EVIDENCE', 'measured') })
      + '<div class="vx-rowgap"></div>'
      + Panel('Provenance carried by every export', Rows([
        ['Session', '<b data-user-content>' + esc(sm.sessionRef) + '</b>'],
        ['Session id', '<span style="font-size:10px">' + esc(sm.sessionId) + '</span>'],
        ['Source', esc(sm.source.displayName)],
        ['Source hash', '<span style="font-size:10px">'
          + esc(String(sm.source.sha256 || '—').slice(0, 20)) + '…</span>'],
        ['Pipeline', esc(sm.pipelineVersion || '—')],
        ['Schema', esc(sm.schema || '—')],
        ['Generated', esc((sm.generatedAt || '').replace('T', ' ').replace('Z', ''))],
        ['Imported', esc((sm.importedAt || '').replace('T', ' ').replace('Z', ''))],
      ]) + '<p class="vx-note">An export is the engine’s own evidence, not a rendering of this '
        + 'screen. It carries the source hash and the pipeline version so a figure can always be traced '
        + 'back to the run that produced it.</p>', { ico: 'flow', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     INTEGRATIONS — a graph, and the detail opens beside it
     ═══════════════════════════════════════════════════════════════════════════ */

  function secIntegrations() {
    setWorkbar('Integrations / Data Flow', '');
    if (!FV.integrations) { body(Empty('withheld', 'READING INTEGRATIONS', 'One moment')); return; }
    if (FV.integrations.ok === false) {
      body(Empty('withheld', 'INTEGRATIONS UNAVAILABLE', FV.integrations.error || '')); return;
    }
    var h = FV.status && FV.status.health;
    var byKey = {};
    if (h) h.capabilities.forEach(function (c) { byKey[c.key] = c; });

    var DETAIL = {
      SOURCE: function () {
        return Rows([
          ['Implemented source types', h ? esc(h.sources.implementedTypes) + ' of '
            + esc(h.sources.declaredTypes) : '—'],
          ['Future rig bays', h ? esc(h.sources.slots) + ', all empty' : '—'],
          ['Connected now', esc((FV.sources && FV.sources.connected || []).length) + ' recorded'],
        ]);
      },
      SOURCE_CORE: function () {
        return Rows([
          ['Fabric source id', '<code>vision</code>'],
          ['Event domain', '<code>vision</code>'],
          ['Registration', 'composed by Source Core from the Fabric registry'],
        ]) + '<p class="vx-note">A second description of Vision on a Source Core screen would be a '
          + 'second opinion, and the day it disagreed with this one somebody would trust the wrong one.</p>';
      },
      VISION: function () {
        return Rows([
          ['Sessions addressable', h && h.sessions.stored !== null ? esc(h.sessions.stored) : '—'],
          ['Processing target', h ? esc(words(h.processingTarget)) : '—'],
          ['Queue', h ? esc(h.sessions.processing) : '—', h ? h.sessions.note : ''],
        ]);
      },
      FABRIC: function () {
        var live = FV.integrations.events.filter(function (e) { return e.live; }).length;
        return Rows([
          ['Event types registered', esc(FV.integrations.events.length)],
          ['On the live board', esc(live)],
          ['Durable only', esc(FV.integrations.events.length - live),
            'per-observation names; withheld from the firehose, fully durable'],
          ['Schema version', 'v1, zod-validated at publish'],
        ]);
      },
      VAULT: function () {
        return Rows([
          ['Storage', 'the platform event history — no Vision table'],
          ['Original evidence', 'never rewritten when a later model disagrees'],
        ]) + '<p class="vx-note">A vision_session table would have been a second history beside the '
          + 'Vault and a second original beside the engine’s.</p>';
      },
      INTELLIGENCE: function () {
        return Rows([
          ['Interface', '<code>GET /sessions/:id/evidence</code>'],
          ['Carries', 'metric positions with error bars, and confirmed findings'],
          ['Does not carry', Tag('ANY RATING', 'future')],
        ]) + '<p class="vx-note vx-note--warn">There is no field for Quality, Vision, Decisions, '
          + 'Composure, Passing, Finishing, Stamina or any mental attribute. An interface with a field '
          + 'for something nobody measures is an invitation to fill it.</p>';
      },
      CONSUMERS: function () {
        return Rows([
          ['Clubs · Match Center · Video Intelligence', Tag('AUTHORISED READ', 'measured')],
          ['Training · Academy', Tag('AUTHORISED READ', 'measured')],
          ['Unvalidated metrics injected into players', Tag('NONE', 'withheld')],
        ]);
      },
    };

    var selNode = null;
    var flow = FV.integrations.flow.map(function (f, i) {
      var open = FV.selection.node === f.stage;
      if (open) selNode = f;
      var pipe = i ? '<div class="vx-pipe' + (f.status === 'LIVE' ? ' vx-pipe--live' : '')
        + '" aria-hidden="true"></div>' : '';
      // The conduit travels WITH the node it feeds, so a wrap never leaves an
      // arrow pointing at the end of a row.
      return '<div class="vx-nodewrap">' + pipe
        + '<button class="vx-node" type="button" data-vx-node="' + esc(f.stage) + '"'
        + ' aria-pressed="' + open + '">'
        + '<span class="vx-node-h"><span class="vx-node-s">' + esc(words(f.stage)) + '</span>'
        + Chip('', f.status) + '</span>'
        + '<span class="vx-node-n">' + esc(f.node) + '</span>'
        + '<span class="vx-node-d">' + esc(f.detail) + '</span></button></div>';
    }).join('');

    var nodePanel = selNode && DETAIL[selNode.stage]
      ? Panel(selNode.node, DETAIL[selNode.stage](),
        { accent: true, ico: 'node', tight: true, actions: Chip('', selNode.status) })
      : Panel('No node selected',
        '<p class="vx-note" style="border:0;padding:0;margin:0">Choose a stage in the graph to read '
        + 'its connection metadata — what it registers, what it carries, and what it deliberately '
        + 'does not.</p>', { ico: 'node', tight: true });

    var monitor = byKey.infrastructure
      ? Panel('Infrastructure City', Rows([
        ['Vision health signal', Chip('', byKey.infrastructure.status)],
        ['Joined by', '<code>healthKey</code>', 'like every other component'],
      ]) + '<p class="vx-note">Vision does not get a second monitoring surface. It gets a district in '
        + 'the one the platform already has, so an operator sees a Vision problem beside a database '
        + 'problem rather than having to know Vision exists and go and look.</p>',
        { ico: 'city', tight: true, actions: Tag('OBSERVES THE PATH', 'derived') })
      : '';

    var events = FV.integrations.events.map(function (e) {
      return '<tr><td><code style="font-size:10.5px;color:var(--v-tx)">' + esc(e.type) + '</code></td>'
        + '<td>v' + esc(e.schemaVersion) + '</td>'
        + '<td>' + (e.live ? Tag('LIVE VIEW', 'measured') : Tag('DURABLE ONLY', 'withheld')) + '</td>'
        + '<td style="white-space:normal;max-width:70ch">' + esc(e.describes) + '</td></tr>';
    });

    body('<div class="vx-2col--wide vx-2col">'
      + Panel('Nervous system', '<div class="vx-flow">' + flow + '</div>'
        + '<p class="vx-note">A conduit travels only where the link is LIVE. A diagram that flows while '
        + 'the platform is silent is a diagram telling a lie.</p>',
        { accent: true, ico: 'flow' })
      + '<div class="vx-stack">' + nodePanel + monitor + '</div></div>'
      + '<div class="vx-rowgap"></div>'
      + Panel('Vision events on the platform transport', Table('Registered Vision event types',
        ['Event type', 'Schema', 'Live board', 'What it says has happened'], events)
        + '<p class="vx-note">There is no Vision event bus. These names are registered on the '
        + 'Fabric’s own registry, travel through the same outbox, and land in the same Data Vault '
        + 'as every other domain’s facts.</p>', { ico: 'reports', tight: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HEALTH · PERFORMANCE
     ═══════════════════════════════════════════════════════════════════════════ */

  function secHealth() {
    setWorkbar('Health',
      '<button class="vx-btn" type="button" data-vx-section="integrations">' + ico('flow')
      + 'Integrations</button>');
    if (!FV.status || FV.status.ok === false) {
      body(Empty('withheld', 'VISION SERVICE UNAVAILABLE',
        (FV.status && FV.status.error) || 'the service did not answer'));
      return;
    }
    var h = FV.status.health;
    var evidence = ['source-input', 'player-tracking', 'ball-tracking', 'calibration', 'teams-roles', 'events'];
    var platform = ['source-core', 'data-fabric', 'data-vault', 'infrastructure'];

    function grid(keys) {
      return '<div class="vx-stack">' + h.capabilities.filter(function (c) {
        return keys.indexOf(c.key) >= 0;
      }).map(function (c) {
        return '<div class="vx-row"><span class="vx-row-k"><b>' + esc(c.label) + '</b>'
          + '<span>' + esc(c.detail) + '</span></span>'
          + '<span class="vx-row-v">' + Chip('', c.status) + '</span></div>';
      }).join('') + '</div>';
    }
    var others = h.capabilities.filter(function (c) {
      return evidence.indexOf(c.key) < 0 && platform.indexOf(c.key) < 0;
    });

    body('<div class="vx-stats">'
      + Stat('Service', esc(h.service), 'the Vision engine’s own state',
        { ico: 'health', tone: h.service === 'LIVE' ? 'green' : '' })
      + Stat('Processing target', esc(words(h.processingTarget)), 'where inference runs', { ico: 'cpu' })
      + Stat('Sessions stored', esc(h.sessions.stored), h.sessions.note, { ico: 'sessions' })
      + Stat('Event types', esc(h.eventTypes), 'registered on the Data Fabric', { ico: 'flow' })
      + Stat('Source types', esc(h.sources.implementedTypes) + '<small> of '
        + esc(h.sources.declaredTypes) + '</small>', esc(h.sources.slots) + ' bays declared, all empty',
        { ico: 'sources' })
      + '</div><div class="vx-rowgap"></div>'
      + '<div class="vx-2col">'
      + Panel('Evidence capabilities', grid(evidence),
        { accent: true, ico: 'track', tight: true,
          actions: Tag(h.capabilities.filter(function (c) {
            return evidence.indexOf(c.key) >= 0 && (c.status === 'READY' || c.status === 'LIVE');
          }).length + ' / ' + evidence.length + ' READY', 'measured') })
      + '<div class="vx-stack">'
      + Panel('Platform links', grid(platform), { ico: 'flow', tight: true })
      + Panel('Engine and rig', '<div class="vx-stack">' + others.map(function (c) {
        return '<div class="vx-row"><span class="vx-row-k"><b>' + esc(c.label) + '</b>'
          + '<span>' + esc(c.detail) + '</span></span>'
          + '<span class="vx-row-v">' + Chip('', c.status) + '</span></div>';
      }).join('') + '</div>', { ico: 'device', tight: true })
      + '</div></div>'
      + '<div class="vx-rowgap"></div>'
      + Panel('Checked at', Rows([
        ['Service answered', esc((h.checkedAt || '').replace('T', ' ').replace('Z', ''))],
        ['Device', esc(h.deviceId), words(h.deviceKind)],
      ]), { ico: 'timeline', tight: true }));
  }

  function secPerformance() {
    setWorkbar('Performance', '');
    var g = FV.session && FV.session.summary.guards;
    var reason = (FV.session && FV.session.summary.capabilities.reasons.physicalMetrics)
      || 'The engine measures implied speed only as a calibration guard, and it is deliberately not '
        + 'exposed as a player measurement';

    var READINGS = [
      ['Speed', 'm/s', 'a per-frame displacement over a calibrated interval, validated against ground truth'],
      ['Acceleration', 'm/s²', 'a second derivative of a measurement that is not yet validated'],
      ['Distance', 'm', 'a sum over frames, and a sum over gaps is not a distance'],
      ['High-speed running', 'm', 'a threshold on a speed that has no validated value'],
      ['Sprints', 'count', 'a count of crossings of that same threshold'],
      ['Stamina / load', 'AU', 'a model over all of the above'],
    ].map(function (k) {
      return '<div class="vx-await"><span class="vx-await-k">' + esc(k[0]) + '<em>' + esc(k[1])
        + '</em></span><span class="vx-await-v vx-none">—</span>'
        + '<span class="vx-await-s">' + esc(k[2]) + '</span>'
        + Tag('NOT YET VALIDATED', 'future') + '</div>';
    }).join('');

    body(Panel(null,
      '<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">'
      + '<div style="flex:0 0 auto"><div style="font-size:10px;letter-spacing:.2em;'
      + 'text-transform:uppercase;color:var(--v-tx-3)">Physical metrics</div>'
      + '<div style="font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1.05">'
      + '0 <small style="font-size:15px;font-weight:600;color:var(--v-tx-3)">of 6 ready</small></div></div>'
      + '<p style="flex:1 1 340px;min-width:0;font-size:12px;color:var(--v-tx-2);line-height:1.6;margin:0">'
      + esc(sentence(reason)) + ' Nothing on this screen is withheld to be cautious: there is no '
      + 'validated figure to withhold.</p>'
      + Tag('NOT YET VALIDATED', 'future') + '</div>', { accent: true })
      + '<div class="vx-rowgap"></div>'
      + '<div class="vx-2col">'
      + Panel('Readiness', '<div class="vx-stack">' + READINGS + '</div>', { ico: 'perf', tight: true })
      + (g ? Panel('What the engine does measure, and why it is not this', Rows([
        ['Worst p90 implied speed in a calibrated span', n(g.speedGuardP90MsMax, 1) + ' m/s'],
        ['Spans examined', n(g.speedGuardSpans, 0)],
        ['Spans withheld as physically impossible', n(g.speedGuardSpansWithheld, 0)],
        ['Frames whose coordinates were withheld', n(g.speedGuardFramesWithheld, 0)],
      ]) + '<p class="vx-note vx-note--warn">This is a GUARD statistic. It exists to reject a '
        + 'calibration whose metres imply people outrunning the world record, and it is computed over '
        + 'a whole span rather than per player. Presenting it as a player’s speed would be '
        + 'presenting a validation threshold as a performance measurement.</p>',
        { ico: 'health', tight: true, actions: Tag('GUARD, NOT A METRIC', 'propagated') })
        : Panel('Guard statistics', needSession(), { ico: 'health', tight: true }))
      + '</div>');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ROUTER
     ═══════════════════════════════════════════════════════════════════════════ */

  var ROUTES = {
    live: secLive, sessions: secSessions, sources: secSources, device: secDevice,
    tracking: secTracking, ball: secBall, calibration: secCalibration, teams: secTeams,
    events: secEvents, tactical: secTactical, heatmaps: secHeatmaps, timeline: secTimeline,
    reports: secReports, performance: secPerformance, health: secHealth,
    models: secModels, integrations: secIntegrations,
  };

  function sectionDef(id) {
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i];
    return null;
  }

  function renderSection() {
    var def = sectionDef(FV.section);
    if (def && def.planned) { secPlanned(def); return; }
    var r = ROUTES[FV.section];
    if (r) r(); else { FV.section = 'live'; rememberSection('live'); secLive(); }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PLUMBING
     ═══════════════════════════════════════════════════════════════════════════ */

  function get(path) {
    return fetch(apiBase() + '/familista-vision' + path, {
      credentials: 'include',
      headers: authHeaders(),
    })
      .then(function (r) {
        // 401 and 403 are different answers and the reader deserves to know
        // which. "Signed out" is fixed by signing in; "not yours" is not.
        if (r.status === 401) {
          return { ok: false, status: 401,
            error: 'Your session has expired. Reload the page to sign in again.' };
        }
        if (r.status === 403) {
          return { ok: false, status: 403,
            error: 'Familista Vision is not available to this account.' };
        }
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            return { ok: false, status: r.status,
              error: (b && (b.error || b.message)) || ('The Vision service answered HTTP ' + r.status + '.') };
          });
        }
        return r.json().catch(function () { return { ok: false, error: 'malformed response' }; });
      })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  function stepFrame(delta) {
    if (!FV.session) return;
    var frames = FV.session.summary.framesProcessed || 1;
    FV.frame = Math.max(0, Math.min(frames - 1, FV.frame + delta));
    renderSection();
  }

  /** The evidence drawer, for a track's role reasoning. */
  function showRole(identity) {
    if (!FV.session) return;
    var r = FV.session.roles.filter(function (x) { return x.identity === identity; })[0];
    var idx = trackIndex(FV.session).filter(function (x) { return x.identity === identity; })[0];
    if (!r && !idx) return;
    openDrawer('#' + identity, r ? words(r.role) : (idx ? words(idx.role) : ''),
      Rows([
        ['Classification', r ? (r.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(words(r.role)))
          : (idx ? esc(words(idx.role)) : '—')],
        ['Confidence', r ? n(r.confidence, 3) : (idx ? n(idx.conf || null, 3) : '—')],
        ['Observations', idx ? esc(idx.obs) : n(r && r.observations, 0)],
        ['With metric position', idx ? esc(idx.withCoords) + ' of ' + esc(idx.obs) : '—'],
        ['Team', idx && idx.team ? esc(words(idx.team)) : Tag('NONE', 'withheld')],
        ['Frames', idx ? esc(idx.first) + '–' + esc(idx.last) : '—'],
      ])
      + (r && r.reason ? '<p class="vx-note">' + esc(sentence(r.reason)) + '</p>'
        : '<p class="vx-note">The engine recorded no role reasoning for this identity.</p>')
      + '<div class="vx-rowgap"></div>'
      + '<button class="vx-btn" type="button" data-vx-track="' + esc(identity) + '">'
      + ico('track') + 'Open in Player Tracking</button>');
  }

  /**
   * An export is an authenticated read, so it goes through `fetch`.
   *
   * `window.open` cannot carry an Authorization header, so the download
   * inherited exactly the fault the rest of the module had: it worked while the
   * cookie was fresh and 401ed afterwards, and the browser rendered the 401
   * body as a blank tab. Fetching the bytes and handing the browser an object
   * URL keeps the credential on the request.
   */
  function exportReport(kind) {
    if (!FV.sessionRef) return;
    var ref = FV.sessionRef;
    var url = apiBase() + '/familista-vision/sessions/' + encodeURIComponent(ref)
      + '/export?kind=' + encodeURIComponent(kind);
    fetch(url, { credentials: 'include', headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error('The Vision service answered HTTP ' + r.status + '.');
        var cd = r.headers.get('content-disposition') || '';
        var m = /filename="?([^";]+)"?/i.exec(cd);
        return r.blob().then(function (b) {
          return { blob: b, name: m ? m[1] : ref + '-' + kind + '.json' };
        });
      })
      .then(function (f) {
        var href = URL.createObjectURL(f.blob);
        var a = document.createElement('a');
        a.href = href; a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(href); }, 30000);
      })
      .catch(function (e) {
        openDrawer('Export failed', kind,
          '<p class="vx-note" style="border:0;padding:0;margin:0">'
          + esc(String((e && e.message) || e)) + '</p>');
      });
  }

  /* ── events ──────────────────────────────────────────────────────────────── */

  function onClick(e) {
    var t = e.target;

    var mod = t.closest('[data-vx-module]');
    if (mod) {
      var page = mod.getAttribute('data-vx-module');
      if (typeof window.navTo === 'function') window.navTo(page);
      else window.location.hash = '#' + page;
      return;
    }
    var sec = t.closest('[data-vx-section]');
    if (sec) { goto(sec.getAttribute('data-vx-section')); return; }

    if (t.closest('[data-vx-notif]')) {
      // The platform's own notification surface, not a second one.
      var bell = document.querySelector('[data-tf-notif-open]');
      if (bell) bell.click();
      return;
    }
    if (t.closest('[data-vx-drawer-close]')) { closeDrawer(); return; }

    var open = t.closest('[data-vx-open-session]');
    if (open) { openSession(open.getAttribute('data-vx-open-session')); return; }

    var mode = t.closest('[data-vx-mode]');
    if (mode) { FV.mode = mode.getAttribute('data-vx-mode'); renderSection(); return; }

    var layer = t.closest('[data-vx-layer]');
    if (layer) {
      var k = layer.getAttribute('data-vx-layer');
      FV.layers[k] = !FV.layers[k];
      renderSection();
      return;
    }
    var seek = t.closest('[data-vx-seek]');
    if (seek) {
      FV.frame = parseInt(seek.getAttribute('data-vx-seek'), 10) || 0;
      if (seek.hasAttribute('data-vx-stay')) renderSection();
      else goto('live');
      return;
    }
    var step = t.closest('[data-vx-step]');
    if (step) { stepFrame(parseInt(step.getAttribute('data-vx-step'), 10)); return; }

    var role = t.closest('[data-vx-role]');
    if (role) { showRole(role.getAttribute('data-vx-role')); return; }

    var trk = t.closest('[data-vx-track]');
    if (trk) {
      FV.selection.track = trk.getAttribute('data-vx-track');
      closeDrawer();
      if (FV.section !== 'tracking') goto('tracking'); else renderSection();
      return;
    }
    var evt = t.closest('[data-vx-event]');
    if (evt) {
      FV.selection.event = evt.getAttribute('data-vx-event');
      if (FV.section !== 'events') goto('events'); else renderSection();
      return;
    }
    var node = t.closest('[data-vx-node]');
    if (node) {
      var id = node.getAttribute('data-vx-node');
      FV.selection.node = FV.selection.node === id ? null : id;
      renderSection();
      return;
    }
    var exp = t.closest('[data-vx-export]');
    if (exp) { exportReport(exp.getAttribute('data-vx-export')); return; }

    // A retry must actually go back to the service. `boot()` is deliberately
    // cheap on a re-entry, so retry clears the booted flag and reads again.
    if (t.closest('[data-vx-retry]')) {
      FV.booted = false; FV.loading = false; FV.sessionGone = null;
      loadCatalogue();
      return;
    }
  }

  function onInput(e) {
    var search = e.target.closest('[data-vx-search]');
    if (search) {
      // Forward to the platform's own search so its behaviour runs. A second
      // search box that searches nothing would be a control with a lie in it.
      var gs = document.getElementById('global-search');
      if (gs) {
        gs.value = search.value;
        try { gs.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      return;
    }
    var f = e.target.closest('[data-vx-filter]');
    if (f) { FV.filters[f.getAttribute('data-vx-filter')] = f.value; renderSection(); return; }
    var sel = e.target.closest('[data-vx-select]');
    if (sel) { FV.selection[sel.getAttribute('data-vx-select')] = sel.value; renderSection(); return; }
    var scrub = e.target.closest('[data-vx-scrub]');
    if (scrub) { FV.frame = parseInt(scrub.value, 10) || 0; renderSection(); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { closeDrawer(); return; }
    if (FV.section !== 'live') return;
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1); }
  }

  /* ── session and boot ────────────────────────────────────────────────────── */

  /**
   * Open a session, without blanking the screen to do it.
   *
   * The old version set `FV.session = null` and repainted BEFORE the fetch, so
   * every caller flashed "NO SESSION LOADED" — and any caller that fired while
   * a session was already open destroyed it. Combined with a `boot()` the shell
   * could re-enter at any moment, that is the whole of the reported fault: a
   * section showed real content and then went empty on its own.
   *
   * Now: re-opening the session already held is a no-op; opening a different
   * one keeps the current one on screen until its replacement has arrived; and
   * a stale answer cannot overwrite a newer one.
   */
  function openSession(ref, opts) {
    opts = opts || {};
    if (!ref) return;
    if (FV.sessionRef === ref && FV.session && !opts.force) { renderSection(); return; }

    // ONE READ PER SESSION AT A TIME. The shell can mount a module twice for a
    // single navigation — the switch draws it and `_famRenderPage` draws it
    // again — and a session body is megabytes. Without this, returning to
    // Vision fired two identical reads, the first was discarded by the token
    // below, and the screen waited on the slower of two requests for the same
    // bytes.
    if (FV.inflightRef === ref) return;

    var token = ++FV.loadToken;
    FV.inflightRef = ref;
    var changed = FV.sessionRef !== ref;
    FV.sessionRef = ref;
    FV.sessionGone = null;
    rememberSession(ref);

    if (changed) {
      // A different session's selections do not belong to this one. The frame
      // and the payload are held until the replacement lands.
      FV.selection.track = null; FV.selection.event = null;
    }
    renderWorkbarOnly();

    Promise.all([
      get('/sessions/' + encodeURIComponent(ref)),
      get('/sessions/' + encodeURIComponent(ref) + '/timeline'),
    ]).then(function (r) {
      if (FV.inflightRef === ref) FV.inflightRef = null;
      if (token !== FV.loadToken) return;          // a newer read has overtaken this one
      var loaded = r[0] && r[0].ok ? r[0].session : null;
      if (!loaded) {
        // Do not silently fall back to another session: the reader asked for
        // this one. Say what happened and leave the choice to them.
        FV.session = null; FV.timeline = null;
        FV.sessionGone = { ref: ref, why: (r[0] && r[0].error) || 'the service did not return it' };
        if (r[0] && r[0].status === 404) rememberSession(null);
        renderSection();
        return;
      }
      FV.session = loaded;
      FV.timeline = r[1] && r[1].ok ? r[1].timeline : null;
      if (changed || !FV.frame) {
        FV.frame = loaded.tracks.length ? loaded.tracks[0].frameNumber : 0;
      }
      renderSection();
    });
  }

  /**
   * Decide what should be open, from the catalogue the server just returned.
   *
   * The order is the point. A remembered choice outranks a convenience default,
   * and a remembered choice that no longer exists is reported rather than
   * quietly swapped for a different session — being shown another club's match
   * because yours was deleted is worse than being told yours is gone.
   */
  function restoreSelection() {
    var list = (FV.sessions && FV.sessions.ok && FV.sessions.sessions) || [];
    var saved = readStore();
    var wanted = saved.sessionRef;

    if (wanted) {
      var found = list.some(function (x) { return x.sessionRef === wanted; });
      if (found) { openSession(wanted); return; }
      if (list.length || FV.sessions) {
        // The catalogue answered and this session is not in it.
        FV.sessionRef = null; FV.session = null; FV.timeline = null;
        FV.sessionGone = { ref: wanted, why: 'it is no longer in this account’s session list' };
        rememberSession(null);
        renderSection();
        return;
      }
    }

    // No remembered choice. Opening the newest session is a convenience, not a
    // claim — and with no sessions at all the empty state is the honest answer.
    if (list.length) { openSession(list[0].sessionRef); return; }
    renderSection();
  }

  /**
   * DO NOT ASK BEFORE THERE IS ANYTHING TO ASK WITH.
   *
   * On a refresh the shell mounts this module while `/auth/refresh` is still in
   * flight, so the first reads went out with no credential at all and came back
   * 401 — and because a refresh is exactly when a reader expects their session
   * back, the module they returned to was the one screen that could not load.
   *
   * The wait is bounded and it never blocks for its own sake: it resolves the
   * moment a token exists, or as soon as the platform's context settles, and it
   * gives up after a short ceiling so a deployment that genuinely has no token
   * still reaches the 401 screen rather than waiting for ever.
   */
  function whenAuthReady() {
    if (authToken()) return Promise.resolve();
    var ceiling = 6000, step = 60, waited = 0;
    var settled = false;
    return new Promise(function (resolve) {
      function done() { if (!settled) { settled = true; resolve(); } }
      try {
        if (window._famContextReady && typeof window._famContextReady.then === 'function') {
          window._famContextReady.then(done, done);
        }
      } catch (_) { /* the poll below is the guarantee */ }
      (function poll() {
        if (settled) return;
        if (authToken() || waited >= ceiling) { done(); return; }
        waited += step;
        setTimeout(poll, step);
      })();
    });
  }

  /** Read the catalogue. Separated from `boot` so a refresh is not a rebuild. */
  function loadCatalogue() {
    if (FV.loading) return Promise.resolve();
    FV.loading = true;
    return whenAuthReady().then(function () { return Promise.all([
      get('/status'), get('/sessions'), get('/sources'), get('/models'),
      get('/device'), get('/integrations'),
    ]).then(function (r) {
      FV.status = r[0]; FV.sessions = r[1]; FV.sources = r[2];
      FV.models = r[3]; FV.device = r[4]; FV.integrations = r[5];
      FV.booted = true; FV.loading = false;
      renderShell();
      restoreSelection();
    }).catch(function () {
      FV.loading = false; FV.booted = true;
      renderShell();
    }); });
  }

  /**
   * MOUNTING MUST NOT DESTROY WHAT IS OPEN.
   *
   * `boot()` used to be the only entry point, and it refetched everything and
   * re-picked `sessions[0]` on every call. The shell calls the render hook far
   * more often than "the reader opened this module": `_famDataChanged` fires
   * when the club context hydrates and again when Layer B lands — both a second
   * or two AFTER Vision first paints — and each one re-entered boot and wiped
   * the session out from under whatever section was being read.
   *
   * So there are two paths now. The first mount reads the catalogue. Every
   * mount after that repaints from what is already held.
   */
  function boot() {
    var root = document.getElementById('fv-root');
    if (!root) return;

    // The section the reader was last in is restored before the first paint, so
    // a refresh returns them where they were rather than to Live Analysis. An
    // unknown id — a section removed since the choice was stored — falls back
    // rather than rendering nothing.
    if (!FV.booted) {
      var savedSection = readStore().section;
      if (savedSection && sectionDef(savedSection)) FV.section = savedSection;
    }

    renderShell();
    if (FV.booted) {
      // Already have the catalogue. Restore what was open if the payload was
      // released on the way out, and otherwise leave the screen exactly as it
      // was — a repaint is not a reload.
      if (FV.sessionRef && !FV.session && !FV.loading) openSession(FV.sessionRef, { force: true });
      return;
    }
    loadCatalogue();
  }

  /**
   * The platform mounts a module by calling its render hook.
   *
   * BOTH CALLERS, NOT ONE. The navigation switch passes the root element; the
   * page-render registry calls every renderer with NO argument at all, and that
   * second one is the path a navigation from Owner Home actually takes.
   */
  window.renderFamilistaVision = function (host) {
    host = host || document.getElementById('fv-root');
    if (!host) return;
    boot();
  };
  window.mountFamilistaVision = boot;

  /**
   * Leaving releases the PAYLOAD. It does not forget the CHOICE.
   *
   * A loaded session is tens of thousands of observations and there is no
   * reason to hold them behind a screen nobody is looking at — that part was
   * right. Nulling `sessionRef` with them was not: it threw away the one fact
   * that made returning to the same session possible, which is why coming back
   * always landed on `sessions[0]` and, if the refetch was slow or failed, on
   * "NO SESSION LOADED".
   *
   * The reference stays, in memory and in storage. The observations go.
   */
  window.teardownFamilistaVision = function () {
    FV.session = null; FV.timeline = null;
    FV.selection.track = null; FV.selection.event = null; FV.selection.node = null;
  };

  // Exposed for the regression tests and for diagnosis from the console.
  window.__FV_STATE = function () {
    return { section: FV.section, sessionRef: FV.sessionRef, hasSession: !!FV.session,
      booted: FV.booted, stored: readStore() };
  };
})();
