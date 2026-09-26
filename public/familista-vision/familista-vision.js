/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA VISION — the instrument

   WHAT THIS FILE IS ALLOWED TO DO

   Draw what the API returned. That is the whole contract, and it is stricter
   than it sounds:

     · It never computes a football figure. Not an average position, not a
       possession share, not a distance covered. Every number on every screen
       arrived from `/api/v1/familista-vision/...`, which got it from a session
       the validated engine produced. If a figure is not in the response, the
       screen says so rather than deriving one.

     · It never fills an empty panel. A session with no confirmed events draws
       an empty state that names what is missing and why; it does not draw a
       zero that could be read as "we checked and there were none" when the real
       answer is "this was not examined".

     · It never merges OBSERVED with PROPAGATED, and never shows a metric
       coordinate the engine withheld. Those two rules are why five validation
       phases were spent on the engine, and a presentation layer that quietly
       relaxed either would undo all of it.

   HOW IT IS BUILT

   A component layer, then seventeen sections that use it. `Panel`, `Metric`,
   `Chip`, `Tag`, `Table`, `Empty`, `Pitch`, `Timeline`, `SourceCard`, `Drawer`,
   `Health` — every section composes those. A section that needs something new
   extends the component rather than writing its own CSS, because the day two
   panels disagree about their padding is the day this stops looking like one
   product.

   WHY THE PITCH IS DRAWN FROM COORDINATES AND NOT FROM A BACKGROUND IMAGE

   Because a pitch drawn as a picture with dots on top invites the dots to be
   placed anywhere. Here the pitch is an SVG in METRES — 105 by 68, Law 1 — and
   a dot's position is its own pitch coordinate. A coordinate the engine did not
   publish therefore has nowhere to go, which is exactly the property wanted.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var API = '/api/v1/familista-vision';

  // Long tables are windowed rather than fully rendered: a session holds ten
  // thousand observations and a browser asked to lay out ten thousand rows
  // stops being an instrument.
  var TABLE_WINDOW = 300;

  var FV = {
    section: 'overview',
    status: null, sessions: null, sources: null, models: null,
    device: null, integrations: null,
    sessionRef: null, session: null, timeline: null,
    frame: 0, feed: 'annotated',
    overlays: { boxes: true, ids: true, teams: true, roles: true, ball: true,
                confidence: false, calibration: true, coords: true, events: true },
    filters: { track: '', team: '', role: '', conf: '', session: '', source: '' },
    selection: { track: null, event: null, node: null, heatTeam: '', heatPlayer: '' },
    drawer: null,
  };

  // ── primitives ────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** A measured zero is 0. A figure the platform does not hold is an em dash. */
  function n(v, digits) {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) {
      return '<span class="fv-none" title="not held by the platform">—</span>';
    }
    if (typeof v !== 'number') return esc(v);
    return esc(digits === undefined ? String(v) : v.toFixed(digits));
  }

  function pct(v, digits) {
    if (v === null || v === undefined) return '<span class="fv-none">—</span>';
    return esc((v * 100).toFixed(digits === undefined ? 1 : digits)) + '%';
  }

  function icon(name) {
    var P = {
      overview: '<path d="M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z"/>',
      live: '<path d="M4 4l14 8-14 8z"/>',
      sessions: '<path d="M4 6h16M4 12h16M4 18h16"/>',
      sources: '<path d="M4 7h16v10H4z"/><path d="M9 21h6M12 17v4"/>',
      device: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
      track: '<circle cx="8" cy="8" r="2"/><circle cx="17" cy="15" r="2"/><path d="M9.5 9.5l6 4"/>',
      ball: '<circle cx="12" cy="12" r="8"/><path d="M12 4l3 5-3 4-3-4z"/>',
      teams: '<path d="M4 20v-2a4 4 0 014-4h2"/><circle cx="9" cy="7" r="3"/><path d="M15 20v-2a4 4 0 014-4"/><circle cx="17" cy="7" r="2.5"/>',
      calib: '<path d="M3 5h18v14H3z"/><path d="M12 5v14M3 12h4M17 12h4"/>',
      events: '<path d="M12 3l2.4 6.3L21 10l-5 4 1.6 7L12 17l-5.6 4L8 14l-5-4 6.6-.7z"/>',
      tactical: '<path d="M12 3l9 5v8l-9 5-9-5V8z"/><path d="M12 8v8M8 10l8 4M16 10l-8 4"/>',
      heat: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h3v3H8zM13 13h3v3h-3z"/>',
      physical: '<path d="M4 18l5-6 4 3 7-9"/><path d="M14 6h6v6"/>',
      timeline: '<path d="M3 12h18"/><circle cx="7" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>',
      reports: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
      models: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
      flow: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6.7 7.4L11 16M17.3 7.4L13 16"/>',
      camera: '<path d="M3 7h4l2-2h6l2 2h4v12H3z"/><circle cx="12" cy="13" r="3.5"/>',
      drone: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
      node: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
      pod: '<rect x="7" y="3" width="10" height="18" rx="4"/><path d="M12 8v5"/>',
      sensor: '<circle cx="12" cy="12" r="4"/><path d="M5 5a10 10 0 000 14M19 5a10 10 0 010 14"/>',
      none: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
      future: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><path d="M12 8v4l3 2"/>',
      absent: '<circle cx="12" cy="12" r="9" stroke-dasharray="2 3"/><path d="M12 8v5M12 16v.5"/>',
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || P.none) + '</svg>';
  }

  var GLYPH = {
    LIVE: '●', READY: '○', PROCESSING: '◐', DEGRADED: '▲',
    OFFLINE: '■', ERROR: '✕', NOT_AVAILABLE: '⊘', NOT_IMPLEMENTED: '◌',
  };

  /** Status never depends on colour alone: a glyph and a word ride with it. */
  function Chip(label, state, title) {
    var s = String(state || 'NOT_AVAILABLE');
    return '<span class="fv-chip fv-s-' + esc(s) + '"' + (title ? ' title="' + esc(title) + '"' : '')
      + '><span class="fv-dot"></span>'
      + (label ? '<b>' + esc(label) + '</b>' : '')
      + '<span class="fv-chip-glyph" aria-hidden="true">' + (GLYPH[s] || '○') + '</span>'
      + '<span class="fv-chip-state">' + esc(s.replace(/_/g, ' ')) + '</span></span>';
  }

  /**
   * ONE READING ON THE COMMAND BAR.
   *
   * A chip says whether a subsystem is up. A reading says what the instrument
   * is currently DOING — which session, off which source, at what rate, on
   * which device — and it is the difference between a status page and a
   * console. Seven of them ride the bar and they are the same seven at every
   * section, because the question "what am I looking at?" does not change when
   * the panel below it does.
   *
   * The state only ever colours the dot. A reading is read for its value.
   */
  function Reading(key, value, sub, state, title) {
    var st = String(state || 'READY');
    return '<div class="fv-read fv-s-' + esc(st) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<span class="fv-read-k">' + esc(key) + '</span>'
      + '<span class="fv-read-v"><i class="fv-dot" aria-hidden="true"></i><b>' + esc(value) + '</b></span>'
      + '<span class="fv-read-s">' + esc(sub || '') + '</span></div>';
  }

  /** A satellite figure: one number the hero's headline is read against. */
  function Sat(value, caption, sub) {
    return '<div class="fv-sat"><span class="fv-sat-v">' + value + '</span>'
      + '<span class="fv-sat-k">' + esc(caption) + '</span>'
      + (sub ? '<span class="fv-sat-s">' + esc(sub) + '</span>' : '') + '</div>';
  }

  /** One dial on an instrument: a figure, what it measures, and its qualifier. */
  function Dial(value, caption, sub, bar) {
    return '<div class="fv-dial"><span class="fv-dial-v">' + value + '</span>'
      + '<span class="fv-dial-k">' + esc(caption) + '</span>'
      + (bar === undefined || bar === null ? ''
        : '<div class="fv-bar fv-bar--measured"><i style="width:'
          + Math.max(0, Math.min(100, bar * 100)).toFixed(1) + '%"></i></div>')
      + '<span class="fv-dial-s">' + esc(sub) + '</span></div>';
  }

  /**
   * A sentence that ends like one.
   *
   * The engine's `reasons` are written as clauses and do not all carry a full
   * stop. Concatenated with a sentence of this screen's own, two statements
   * ran into each other as one ungrammatical line.
   */
  function sentence(text) {
    var t = String(text || '').trim();
    if (!t) return t;
    return /[.!?\u2026]$/.test(t) ? t : t + '.';
  }

  function Tag(text, kind) {
    return '<span class="fv-tag' + (kind ? ' fv-tag--' + kind : '') + '">' + esc(text) + '</span>';
  }

  function Panel(title, inner, opts) {
    opts = opts || {};
    var cls = 'fv-panel' + (opts.flush ? ' fv-panel--flush' : '') + (opts.accent ? ' fv-panel--accent' : '');
    var head = title
      ? '<div class="fv-panel-head"><h3 class="fv-panel-title">' + esc(title) + '</h3>'
        + (opts.aside ? '<div class="fv-panel-aside">' + opts.aside + '</div>' : '') + '</div>'
      : '';
    return '<section class="' + cls + '">' + head + inner + '</section>';
  }

  function Metric(value, unit, caption, opts) {
    opts = opts || {};
    return '<div class="fv-metric"><span class="fv-metric-v' + (opts.small ? ' fv-metric-v--sm' : '') + '">'
      + value + '</span>' + (unit ? '<span class="fv-metric-u">' + esc(unit) + '</span>' : '') + '</div>'
      + (caption ? '<div class="fv-metric-k">' + caption + '</div>' : '')
      + (opts.bar !== undefined && opts.bar !== null
        ? '<div class="fv-bar' + (opts.barKind ? ' fv-bar--' + opts.barKind : '') + '"><i style="width:'
          + Math.max(0, Math.min(100, opts.bar * 100)).toFixed(1) + '%"></i></div>' : '');
  }

  /** The four absences. Each names what is missing and what would fill it. */
  function Empty(kind, title, why, mark) {
    return '<div class="fv-empty fv-empty--' + kind + '" role="status">'
      + '<div class="fv-empty-mark">' + icon(mark || (kind === 'future' ? 'future' : 'absent')) + '</div>'
      + '<div class="fv-empty-title">' + esc(title) + '</div>'
      + '<p class="fv-empty-why">' + esc(why) + '</p></div>';
  }

  function Rows(pairs) {
    return '<div class="fv-rows">' + pairs.map(function (p) {
      if (!p) return '';
      return '<div class="fv-row"><span class="fv-row-k">' + p[0]
        + (p[2] ? '<span class="fv-row-sub">' + esc(p[2]) + '</span>' : '')
        + '</span><span class="fv-row-v">' + p[1] + '</span></div>';
    }).join('') + '</div>';
  }

  /**
   * A table, windowed.
   *
   * `rows` is an array of HTML strings. Only the first `TABLE_WINDOW` are laid
   * out; the footer says how many were withheld, because a silently truncated
   * table is a table that has lied about its own size.
   */
  function Table(caption, headers, rows, opts) {
    opts = opts || {};
    var shown = rows.slice(0, opts.window || TABLE_WINDOW);
    var hidden = rows.length - shown.length;
    return '<div class="fv-table-wrap"' + (opts.tall ? ' style="max-height:none"' : '') + '>'
      + '<table class="fv-table"><caption>' + esc(caption) + '</caption><thead><tr>'
      + headers.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + shown.join('') + '</tbody></table>'
      + (hidden > 0
        ? '<div class="fv-table-foot">Showing ' + shown.length + ' of ' + rows.length
          + ' rows. The rest are in the export — nothing was dropped, only not laid out.</div>'
        : '')
      + '</div>';
  }

  function needSession() {
    return Empty('withheld', 'NO SESSION SELECTED',
      'Choose a session under Sessions. Every figure in this module belongs to one '
      + 'processed session and none of them is a platform average.', 'sessions');
  }

  // ── pitch ─────────────────────────────────────────────────────────────────

  /** Law 1, in metres. A dot's position is its own pitch coordinate. */
  function pitchFrame() {
    var L = 105, W = 68, out = [];
    for (var i = 0; i < 6; i++) {
      out.push('<rect class="fv-pitch-mow" x="' + (i * 17.5) + '" y="0" width="8.75" height="' + W + '"/>');
    }
    out.push('<rect x="0" y="0" width="' + L + '" height="' + W + '" class="fv-pitch-line"/>');
    out.push('<line x1="52.5" y1="0" x2="52.5" y2="' + W + '" class="fv-pitch-line"/>');
    out.push('<circle cx="52.5" cy="34" r="9.15" class="fv-pitch-line"/>');
    out.push('<circle cx="52.5" cy="34" r="0.4" class="fv-pitch-line" fill="rgba(255,255,255,.2)"/>');
    out.push('<rect x="0" y="13.84" width="16.5" height="40.32" class="fv-pitch-line"/>');
    out.push('<rect x="88.5" y="13.84" width="16.5" height="40.32" class="fv-pitch-line"/>');
    out.push('<rect x="0" y="24.84" width="5.5" height="18.32" class="fv-pitch-line"/>');
    out.push('<rect x="99.5" y="24.84" width="5.5" height="18.32" class="fv-pitch-line"/>');
    out.push('<circle cx="11" cy="34" r="0.4" class="fv-pitch-line" fill="rgba(255,255,255,.2)"/>');
    out.push('<circle cx="94" cy="34" r="0.4" class="fv-pitch-line" fill="rgba(255,255,255,.2)"/>');
    return out.join('');
  }

  function Pitch(inner, opts) {
    opts = opts || {};
    return '<div class="fv-pitch-wrap"><svg class="fv-pitch'
      + (opts.small ? ' fv-pitch--sm' : '') + (opts.tall ? ' fv-pitch--tall' : '')
      + '" viewBox="-4 -4 113 76" role="img" aria-label="'
      + esc(opts.label || 'Pitch map in metres') + '">'
      + pitchFrame() + inner + '</svg></div>';
  }

  /** The same two words as LEGEND_ORIGIN, sized for a caption rather than a row. */
  var LEGEND_INLINE = '<span class="fv-lgd"><i class="fv-lgd-m"></i>measured</span>'
    + '<span class="fv-lgd"><i class="fv-lgd-p"></i>propagated</span>';

  var LEGEND_ORIGIN = '<div class="fv-legend">'
    + Chip('MEASURED', 'READY', 'solved from landmarks on this frame')
    + Chip('PROPAGATED', 'DEGRADED', 'carried from an anchor through measured camera motion')
    + '</div>';

  // ── plumbing ──────────────────────────────────────────────────────────────

  function get(path) {
    return fetch(API + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          return { ok: false, error: 'Familista Vision is not available to this account.' };
        }
        return r.json().catch(function () { return { ok: false, error: 'malformed response' }; });
      })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  function head(title, sub, actions) {
    var el = document.getElementById('fv-work-head');
    if (el) {
      el.innerHTML = '<div class="fv-work-titles"><h2 class="fv-work-title">' + esc(title) + '</h2>'
        + '<p class="fv-work-sub">' + esc(sub) + '</p></div>'
        + (actions ? '<div class="fv-work-actions">' + actions + '</div>' : '');
    }
  }

  function body(html) {
    var el = document.getElementById('fv-work-body');
    if (el) { el.innerHTML = html; el.scrollTop = 0; }
  }

  window.__FV = FV;

  // ── navigation ────────────────────────────────────────────────────────────

  /**
   * THE FOUR THINGS A READER CAN BE DOING HERE.
   *
   * The groups used to be VISION / TRACKING / ANALYSIS / SYSTEM, which named
   * the code that produced each screen rather than the job it serves. These
   * name the job:
   *
   *   COMMAND      — what is running right now, and what to watch it on.
   *   EVIDENCE     — what the engine MEASURED, and how well.
   *   INTELLIGENCE — what can be READ OFF that evidence, including the
   *                  readings that are not validated yet and say so.
   *   OPERATIONS   — the rig, the models, the exports, the wiring.
   *
   * A section belongs to exactly one, and this list is the only place the
   * order is decided.
   */
  var SECTIONS = [
    { id: 'overview',     group: 'COMMAND',      ico: 'overview',  label: 'Overview' },
    { id: 'live',         group: 'COMMAND',      ico: 'live',      label: 'Live Analysis' },
    { id: 'sessions',     group: 'COMMAND',      ico: 'sessions',  label: 'Sessions' },

    { id: 'tracking',     group: 'EVIDENCE',     ico: 'track',     label: 'Player Tracking' },
    { id: 'ball',         group: 'EVIDENCE',     ico: 'ball',      label: 'Ball Tracking' },
    { id: 'calibration',  group: 'EVIDENCE',     ico: 'calib',     label: 'Pitch Calibration' },
    { id: 'teams',        group: 'EVIDENCE',     ico: 'teams',     label: 'Teams & Roles' },
    { id: 'events',       group: 'EVIDENCE',     ico: 'events',    label: 'Events' },

    { id: 'tactical',     group: 'INTELLIGENCE', ico: 'tactical',  label: 'Tactical View', badge: 'PENDING' },
    { id: 'heatmaps',     group: 'INTELLIGENCE', ico: 'heat',      label: 'Heatmaps' },
    { id: 'physical',     group: 'INTELLIGENCE', ico: 'physical',  label: 'Physical Metrics', badge: 'NOT VALIDATED' },
    { id: 'timeline',     group: 'INTELLIGENCE', ico: 'timeline',  label: 'Timeline' },

    { id: 'sources',      group: 'OPERATIONS',   ico: 'sources',   label: 'Sources' },
    { id: 'device',       group: 'OPERATIONS',   ico: 'device',    label: 'Device / Vision Hub' },
    { id: 'models',       group: 'OPERATIONS',   ico: 'models',    label: 'Models & Providers' },
    { id: 'reports',      group: 'OPERATIONS',   ico: 'reports',   label: 'Reports' },
    { id: 'integrations', group: 'OPERATIONS',   ico: 'flow',      label: 'Integrations / Data Flow' },
  ];

  /**
   * THE EVIDENCE CAPABILITIES, as one counted reading.
   *
   * These are the rows the service publishes about what it can currently
   * produce. The command bar reports HOW MANY of them are ready and colours
   * itself by the worst one — it counts, it does not judge. The rows
   * themselves, each with its own status and its own reason, are on Overview
   * where there is room to read them.
   */
  var EVIDENCE_CAPS = ['source-input', 'player-tracking', 'ball-tracking',
    'calibration', 'teams-roles', 'events'];

  var STATE_RANK = { LIVE: 0, READY: 0, PROCESSING: 1, DEGRADED: 2, NOT_IMPLEMENTED: 3,
    NOT_AVAILABLE: 3, OFFLINE: 4, ERROR: 5 };

  /**
   * The seven readings, built from whatever the module currently knows.
   *
   * Its own function because the bar has to be repainted when a session opens
   * — four of the seven are about that session — and repainting the whole
   * shell to say so would throw away the reader's nav position and scroll.
   * `refreshBar` writes this into the one element that changed.
   */
  function commandReadings() {
    var h = FV.status && FV.status.health;
    if (!h) return '';
    var caps = h.capabilities || [];
    var byKey = {};
    caps.forEach(function (c) { byKey[c.key] = c; });
    var s = FV.session && FV.session.summary;

    var evRows = EVIDENCE_CAPS.map(function (k) { return byKey[k]; })
      .filter(function (c) { return !!c; });
    var evReady = evRows.filter(function (c) { return c.status === 'READY' || c.status === 'LIVE'; }).length;
    var evWorst = evRows.reduce(function (acc, c) {
      return (STATE_RANK[c.status] || 0) > (STATE_RANK[acc] || 0) ? c.status : acc;
    }, 'READY');

    return [
      Reading('Current session', s ? s.sessionRef : 'NONE SELECTED',
        s ? (s.source.displayName + ' · ' + s.source.width + '\u00d7' + s.source.height) : 'choose one under Sessions',
        s ? 'LIVE' : 'NOT_AVAILABLE',
        'every figure in this module belongs to this session and to no other'),
      Reading('Source', s ? s.source.sourceType.replace(/_/g, ' ') : '\u2014',
        s ? (s.source.qualityBand ? 'quality ' + s.source.qualityBand + ' \u00b7 ' + n(s.source.qualityScore, 2) : 'quality not scored') : 'no source in view',
        s ? 'READY' : 'NOT_AVAILABLE',
        'what the engine read this session off'),
      Reading('Engine', h.service, h.deviceKind.replace(/_/g, ' ').toLowerCase(),
        h.service, 'the Vision engine behind this deployment'),
      Reading('Processing target', h.processingTarget.replace(/_/g, ' '),
        'where inference runs', h.processingTarget === 'VISION_HUB' ? 'NOT_IMPLEMENTED' : 'READY',
        'LOCAL_SERVER reads the engine\u2019s artefacts; VISION_HUB is declared and refuses everything'),
      Reading('Rate', s ? n(s.processingFps, 2) + ' fps' : '\u2014',
        s ? ('source ' + n(s.source.fps, 2) + ' fps \u00b7 wall clock ' + n(s.processingSeconds, 0) + ' s') : 'nothing processed in view',
        s ? 'READY' : 'NOT_AVAILABLE',
        'how fast this session was processed, not a live frame rate'),
      Reading('Evidence health', evReady + ' / ' + evRows.length,
        'capability rows ready', evWorst,
        'a count of the service\u2019s own capability rows \u2014 the rows themselves are on Overview'),
      Reading('Device', h.deviceKind.replace(/_/g, ' '), h.deviceId,
        byKey['vision-hub'] ? byKey['vision-hub'].status : 'READY',
        'the device this deployment is running as'),
    ].join('');
  }

  /** Repaint the command bar and nothing else. */
  function refreshBar() {
    var rail = document.querySelector('.fv-cmd-rail');
    if (rail) rail.innerHTML = commandReadings();
  }

  function renderShell() {
    var root = document.getElementById('fv-root');
    if (!root) return;
    var bar = commandReadings();

    var lastGroup = '';
    var nav = SECTIONS.map(function (s) {
      var g = s.group !== lastGroup ? '<div class="fv-nav-group">' + esc(s.group) + '</div>' : '';
      lastGroup = s.group;
      return g + '<button class="fv-nav-item" data-fv-section="' + esc(s.id) + '" type="button"'
        + (FV.section === s.id ? ' aria-current="page"' : '') + ' title="' + esc(s.label) + '">'
        + '<span class="fv-nav-ico">' + icon(s.ico) + '</span>'
        + '<span class="fv-nav-label">' + esc(s.label) + '</span>'
        + (s.badge ? '<span class="fv-nav-badge">' + esc(s.badge) + '</span>' : '')
        + '</button>';
    }).join('');

    root.innerHTML =
      // ── ONE command bar. No second topbar, no second navigation. ──────────
      '<header class="fv-cmd">'
      + '<div class="fv-cmd-id">'
      + '<span class="fv-cmd-mark" aria-hidden="true">'
      + '<svg viewBox="0 0 40 40" width="24" height="24" fill="none" focusable="false">'
      + '<path d="M4 12V6.5A2.5 2.5 0 0 1 6.5 4H12M28 4h5.5A2.5 2.5 0 0 1 36 6.5V12M36 28v5.5a2.5 2.5 0 0 1-2.5 2.5H28M12 36H6.5A2.5 2.5 0 0 1 4 33.5V28" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
      + '<circle cx="20" cy="20" r="8" stroke="currentColor" stroke-width="2"/>'
      + '<circle cx="20" cy="20" r="3" fill="currentColor"/></svg></span>'
      + '<span class="fv-cmd-names"><span class="fv-cmd-name">FAMILISTA VISION</span>'
      + '<span class="fv-cmd-sub">Computer vision \u00b7 evidence \u00b7 provenance</span></span>'
      + '</div>'
      + '<div class="fv-cmd-rail" role="status" aria-label="Familista Vision instrument state">' + bar + '</div>'
      + '<div class="fv-cmd-end"><button class="fv-btn" data-fv-back type="button">\u2190 Familista</button></div>'
      + '</header>'
      + '<div class="fv-body">'
      + '<nav class="fv-nav" aria-label="Familista Vision sections">' + nav + '</nav>'
      + '<main class="fv-work"><div class="fv-work-head" id="fv-work-head"></div>'
      + '<div class="fv-work-body" id="fv-work-body" tabindex="-1"></div></main>'
      + '</div>'
      + '<div class="fv-scrim" data-fv-drawer-close></div>'
      + '<aside class="fv-drawer" id="fv-drawer" role="dialog" aria-modal="false" aria-hidden="true">'
      + '<div class="fv-drawer-head"><div><div class="fv-drawer-title" id="fv-drawer-title"></div>'
      + '<div class="fv-drawer-sub" id="fv-drawer-sub"></div></div>'
      + '<button class="fv-btn" data-fv-drawer-close type="button" aria-label="Close evidence">\u2715</button></div>'
      + '<div class="fv-drawer-body" id="fv-drawer-body"></div></aside>';

    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    root.addEventListener('keydown', onKey);
    renderSection();
  }

  function refreshNav() {
    var items = document.querySelectorAll('[data-fv-section]');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-fv-section') === FV.section;
      if (on) items[i].setAttribute('aria-current', 'page');
      else items[i].removeAttribute('aria-current');
    }
  }

  function goto(section) {
    FV.section = section;
    refreshNav();
    renderSection();
    var b = document.getElementById('fv-work-body');
    if (b) b.focus({ preventScroll: true });
  }

  // ── drawer ────────────────────────────────────────────────────────────────

  function openDrawer(title, sub, html) {
    var d = document.getElementById('fv-drawer');
    var s = document.querySelector('.fv-scrim');
    if (!d) return;
    document.getElementById('fv-drawer-title').textContent = title;
    document.getElementById('fv-drawer-sub').textContent = sub || '';
    document.getElementById('fv-drawer-body').innerHTML = html;
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    if (s) s.classList.add('is-open');
    var close = d.querySelector('[data-fv-drawer-close]');
    if (close) close.focus();
  }

  function closeDrawer() {
    var d = document.getElementById('fv-drawer');
    var s = document.querySelector('.fv-scrim');
    if (d) { d.classList.remove('is-open'); d.setAttribute('aria-hidden', 'true'); }
    if (s) s.classList.remove('is-open');
    FV.selection.track = null;
    FV.selection.event = null;
  }

  // ── events ────────────────────────────────────────────────────────────────

  function onClick(e) {
    var t = e.target;
    var nav = t.closest('[data-fv-section]');
    if (nav) { goto(nav.getAttribute('data-fv-section')); return; }

    if (t.closest('[data-fv-back]')) {
      if (typeof window.navTo === 'function') window.navTo('owner-home');
      else window.location.hash = '#owner-home';
      return;
    }
    if (t.closest('[data-fv-drawer-close]')) { closeDrawer(); return; }

    var open = t.closest('[data-fv-open-session]');
    if (open) { openSession(open.getAttribute('data-fv-open-session')); return; }

    var ov = t.closest('[data-fv-overlay]');
    if (ov) {
      var key = ov.getAttribute('data-fv-overlay');
      FV.overlays[key] = !FV.overlays[key];
      renderSection();
      return;
    }
    var feed = t.closest('[data-fv-feed]');
    if (feed) { FV.feed = feed.getAttribute('data-fv-feed'); renderSection(); return; }

    var seek = t.closest('[data-fv-seek]');
    if (seek) {
      FV.frame = parseInt(seek.getAttribute('data-fv-seek'), 10) || 0;
      if (seek.hasAttribute('data-fv-stay')) renderSection();
      else goto('live');
      return;
    }
    var step = t.closest('[data-fv-step]');
    if (step) { stepFrame(parseInt(step.getAttribute('data-fv-step'), 10)); return; }

    var trk = t.closest('[data-fv-track]');
    if (trk) { FV.selection.track = trk.getAttribute('data-fv-track'); showTrack(); return; }

    var evt = t.closest('[data-fv-event]');
    if (evt) { FV.selection.event = evt.getAttribute('data-fv-event'); showEvent(); return; }

    var node = t.closest('[data-fv-node]');
    if (node) {
      var id = node.getAttribute('data-fv-node');
      FV.selection.node = FV.selection.node === id ? null : id;
      renderSection();
      return;
    }
  }

  function onInput(e) {
    var f = e.target.closest('[data-fv-filter]');
    if (f) { FV.filters[f.getAttribute('data-fv-filter')] = f.value; renderSection(); return; }
    var sel = e.target.closest('[data-fv-select]');
    if (sel) { FV.selection[sel.getAttribute('data-fv-select')] = sel.value; renderSection(); return; }
    var scrub = e.target.closest('[data-fv-scrub]');
    if (scrub) {
      FV.frame = parseInt(scrub.value, 10) || 0;
      renderSection();
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { closeDrawer(); return; }
    if (FV.section !== 'live') return;
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1); }
  }

  function stepFrame(delta) {
    if (!FV.session) return;
    var frames = FV.session.summary.framesProcessed || 1;
    FV.frame = Math.max(0, Math.min(frames - 1, FV.frame + delta));
    renderSection();
  }

  // ═══ OVERVIEW — the command centre ══════════════════════════════════════

  /**
   * OVERVIEW — three zones, in order of what a reader needs first.
   *
   *   1 · THE HERO. What is loaded, off what, running on what, at what rate,
   *       and how much of it is measured rather than carried. It dominates,
   *       because on arrival every other number on the screen is meaningless
   *       until this one is read.
   *   2 · THE FOOTBALL STATE. Where the evidence actually is on a pitch, what
   *       happened in it, and how good the evidence is.
   *   3 · SYSTEM HEALTH. One compact strip. It matters, it is not what the
   *       reader came for, and it used to be eight panels arguing otherwise.
   *
   * What this replaced was nine equal tiles in a wrapping grid: nine boxes of
   * the same size, so nothing led, and a reader had to assemble the state of
   * the instrument out of parts instead of being told it.
   */
  function secOverview() {
    head('Overview', 'Every figure below came from a processed session or from the running '
      + 'service. None of it is a platform average and none of it is decorative.');
    if (!FV.status) { body(Empty('withheld', 'READING VISION SERVICE', 'One moment.')); return; }
    if (FV.status.ok === false) {
      body(Empty('withheld', 'VISION SERVICE UNAVAILABLE',
        FV.status.error || 'the service did not answer'));
      return;
    }
    var h = FV.status.health;
    var s = FV.session && FV.session.summary;

    // ── ZONE 1 · the hero ───────────────────────────────────────────────────
    var hero;
    if (s) {
      var observed = s.ballStates.OBSERVED || 0;
      var propagated = s.ballStates.PROPAGATED || 0;
      var evTotal = Object.keys(s.eventCounts).reduce(function (a, k) { return a + s.eventCounts[k]; }, 0);
      var tracksNow = FV.session.tracks.filter(function (t) { return t.frameNumber === FV.frame; }).length;

      hero = '<section class="fv-hero">'
        + '<div class="fv-hero-main">'
        + '<div class="fv-hero-eyebrow">' + Tag('MEASURED', 'measured')
        + '<span>session loaded · every figure on this screen belongs to it</span></div>'
        + '<h3 class="fv-hero-name">' + esc(s.sessionRef) + '</h3>'
        + '<p class="fv-hero-src">' + esc(s.source.displayName) + ' · '
        + esc(s.source.width) + '×' + esc(s.source.height) + ' · '
        + esc(s.source.sourceType.replace(/_/g, ' ')) + ' · ' + n(s.source.fps, 2) + ' fps</p>'
        + '<div class="fv-sats">'
        + Sat(esc(s.framesProcessed), 'frames processed', esc(s.observationsTotal) + ' observations')
        + Sat(esc(s.identities), 'identities', esc(s.rawTrackIds) + ' raw track ids')
        + Sat(esc(tracksNow), 'tracks in frame ' + FV.frame, 'at the frame in view')
        // The types the engine actually named, not a claim about them. `PROXIMITY`
        // is a proximity, and calling a screenful of them "confirmed events"
        // would be this layer deciding something the engine did not.
        + Sat(esc(evTotal), 'football events',
          Object.keys(s.eventCounts).map(function (k) {
            return k.replace(/_/g, ' ').toLowerCase() + ' ' + s.eventCounts[k];
          }).join(' \u00b7 ') || 'none confirmed')
        + '</div></div>'

        + '<div class="fv-hero-side">'
        + '<div class="fv-gauge">'
        + '<div class="fv-gauge-k">Calibration coverage</div>'
        + '<div class="fv-gauge-v">' + pct(s.calibrationCoverage) + '</div>'
        + '<div class="fv-bar fv-bar--measured"><i style="width:'
        + Math.max(0, Math.min(100, s.calibrationCoverage * 100)).toFixed(1) + '%"></i></div>'
        + '<div class="fv-gauge-s">' + esc(s.anchorsAccepted) + ' anchors · '
        + esc(s.calibrationMeasuredFrames) + ' measured, ' + esc(s.calibrationPropagatedFrames)
        + ' propagated</div></div>'
        // OBSERVED and PROPAGATED are drawn as two figures because they are two
        // figures. Adding them would invent a ball position the engine never saw.
        + '<div class="fv-gauge">'
        + '<div class="fv-gauge-k">Ball ' + Tag('PROPAGATED ≠ OBSERVED', 'propagated') + '</div>'
        + '<div class="fv-duo"><span class="fv-duo-a">' + esc(observed) + '<small>observed</small></span>'
        + '<span class="fv-duo-b">' + esc(propagated) + '<small>propagated</small></span></div>'
        + '<div class="fv-gauge-s">' + esc(s.ballStates.UNKNOWN || 0) + ' unknown · '
        + esc(s.ballStates.NOT_AVAILABLE || 0) + ' not available</div></div>'
        + '</div></section>';
    } else {
      hero = '<section class="fv-hero fv-hero--empty">' + needSession() + '</section>';
    }

    // ── ZONE 2 · the football state ─────────────────────────────────────────
    var football = '';
    if (s) {
      var dots = FV.session.tracks.filter(function (t) { return t.pitchXM !== null; })
        .filter(function (_, i) { return i % 3 === 0; })
        .map(function (t) {
          return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.55" class="'
            + (t.calibrationChain === 'measured' ? 'fv-dotm' : 'fv-dotp') + '" opacity=".55"/>';
        }).join('');

      var recent = FV.session.events.slice(-8).reverse().map(function (e) {
        return '<div class="fv-row"><span class="fv-row-k">' + esc(e.type)
          + '<span class="fv-row-sub">frame ' + e.frameNumber + ' · ' + e.timestamp.toFixed(2) + ' s</span></span>'
          + Tag(e.state, e.state === 'CONFIRMED' ? 'measured' : 'withheld') + '</div>';
      }).join('');

      football = '<div class="fv-zone2">'
        + Panel('Where the evidence is',
          Pitch(dots, { label: 'Calibrated positions across the session' })
          + '<div class="fv-metric-k">' + esc(s.observationsWithPitchCoords)
          + ' calibrated positions · on-pitch rate ' + pct(s.coordsOnPitchRate)
          + ' · ' + LEGEND_INLINE + '</div>',
          { aside: Tag(s.capabilities.metricCoordinates ? 'METRIC' : 'NONE',
            s.capabilities.metricCoordinates ? 'measured' : 'withheld') })
        + '<div class="fv-stack">'
        + Panel('Recent events', recent
          ? '<div class="fv-rows">' + recent + '</div>'
          : '<p class="fv-metric-k">' + esc(s.capabilities.reasons.events || 'none confirmed') + '</p>')
        + Panel('Session evidence', Rows([
          ['Team assignment', pct(s.teamAssignmentRate), 'given a team, not given the RIGHT team'],
          ['Source quality', esc(s.source.qualityBand || '—') + ' · ' + n(s.source.qualityScore, 2)],
          ['Coordinates on pitch', pct(s.coordsOnPitchRate)],
          ['Anchor disagreement', n(s.anchorDisagreementMedianM, 3) + ' m'],
        ]))
        + '</div></div>';
    }

    // ── ZONE 3 · system health, compact ─────────────────────────────────────
    var healthRows = h.capabilities.map(function (c) {
      return '<div class="fv-hcell fv-s-' + esc(c.status) + '" title="' + esc(c.detail) + '">'
        + '<i class="fv-dot" aria-hidden="true"></i>'
        + '<span class="fv-hcell-k">' + esc(c.label) + '</span>'
        + '<span class="fv-hcell-v">' + esc(String(c.status).replace(/_/g, ' ')) + '</span></div>';
    }).join('');

    var sessionsRows = (FV.sessions && FV.sessions.ok ? FV.sessions.sessions : []).map(function (x) {
      return '<div class="fv-row"><span class="fv-row-k">'
        + '<button class="fv-btn" data-fv-open-session="' + esc(x.sessionRef) + '" type="button">'
        + esc(x.sessionRef) + '</button>'
        + '<span class="fv-row-sub">' + esc(x.framesProcessed) + ' frames · calibration '
        + pct(x.calibrationCoverage) + '</span></span>'
        + Tag(x.clubId ? x.clubId : 'PLATFORM', x.clubId ? 'accent' : 'withheld') + '</div>';
    }).join('');

    var health = '<div class="fv-zone3">'
      + Panel('System health', '<div class="fv-hgrid">' + healthRows + '</div>',
        { aside: Tag(h.processingTarget.replace(/_/g, ' '), 'accent') })
      + '<div class="fv-stack">'
      + Panel('Sessions available to you', sessionsRows
        ? '<div class="fv-rows">' + sessionsRows + '</div>'
        : '<p class="fv-metric-k">No session is visible to this account.</p>')
      + Panel('Rig', Rows([
        ['Device', esc(h.deviceId)],
        ['Kind', esc(h.deviceKind.replace(/_/g, ' '))],
        ['Source types implemented', esc(h.sources.implementedTypes) + ' of ' + esc(h.sources.declaredTypes)],
        ['Future rig slots', esc(h.sources.slots) + ' declared, all empty'],
      ]))
      + '</div></div>';

    body(hero + football + health);
  }

  // ═══ LIVE ANALYSIS — the centrepiece ════════════════════════════════════

  /** Overlays whose underlying data this session genuinely has. */
  function availableOverlays(s) {
    var caps = s.summary.capabilities;
    return [
      { key: 'boxes', label: 'Player boxes', ok: caps.tracking },
      { key: 'ids', label: 'Track IDs', ok: caps.tracking },
      { key: 'teams', label: 'Teams', ok: caps.teams },
      { key: 'roles', label: 'Roles', ok: caps.roles },
      { key: 'ball', label: 'Ball', ok: caps.ball },
      { key: 'confidence', label: 'Confidence', ok: caps.tracking },
      { key: 'calibration', label: 'Calibration', ok: true },
      { key: 'coords', label: 'Pitch coordinates', ok: caps.metricCoordinates },
      { key: 'events', label: 'Event markers', ok: caps.events },
    ].filter(function (o) { return o.ok; });
  }

  /**
   * A RUN-LENGTH LANE for the module's existing timeline primitive.
   *
   * `rows` are per-frame records already in frame order; `kindOf` says which
   * of the five span vocabularies each one belongs to. Consecutive records of
   * the same kind become ONE span — which is both how the calibration band
   * has always been drawn and, at three hundred frames a lane, three hundred
   * nodes fewer than a rect per frame.
   *
   * It records; it does not smooth. A frame with no record contributes no
   * span, so a gap in the evidence stays a gap on the screen.
   */
  function tlSpans(rows, frames, kindOf, titleOf) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var kind = kindOf(rows[i]);
      var j = i;
      while (j + 1 < rows.length && kindOf(rows[j + 1]) === kind
             && rows[j + 1].frameNumber - rows[j].frameNumber <= 1) j++;
      var from = rows[i].frameNumber, to = rows[j].frameNumber;
      out.push('<div class="fv-tl-span fv-tl-span--' + kind + '" style="left:'
        + ((from / frames) * 100).toFixed(2) + '%;width:'
        + Math.max(0.2, (((to - from + 1) / frames) * 100)).toFixed(2) + '%"'
        + ' title="' + esc(titleOf(rows[i]) + ' · frames ' + from + '–' + to) + '"></div>');
      i = j;
    }
    return out.join('');
  }

  function tlBand(label, inner, opts) {
    opts = opts || {};
    return '<div class="fv-tl-band"><div class="fv-tl-label">' + esc(label) + '</div>'
      + '<div class="fv-tl-track' + (opts.marks ? ' fv-tl-track--marks' : '') + '">'
      + inner + '</div></div>';
  }

  /**
   * THE EVIDENCE TIMELINE — three bands under the canvas.
   *
   * The canvas shows one frame. This shows the whole session at once, and it
   * answers the question a single frame cannot: is this frame typical? The
   * bands are calibration, ball and events, in the same three vocabularies
   * used everywhere else in the module, so a long amber run reads as
   * "carried, not seen" without a legend.
   */
  function EvidenceTimeline(s, frame) {
    var frames = Math.max(1, s.summary.framesProcessed);

    var calBand = tlSpans(s.calibration, frames,
      function (c) { return c.chain === 'measured' ? 'valid' : c.chain === 'propagated' ? 'prop' : 'none'; },
      function (c) { return c.chain; });

    var ballBand = tlSpans(s.ball, frames,
      function (b) { return b.state === 'OBSERVED' ? 'obs' : b.state === 'PROPAGATED' ? 'prop' : 'gap'; },
      function (b) { return b.state; });

    var evBand = s.events.map(function (e) {
      return '<button class="fv-tl-mark fv-tl-mark--event" data-fv-seek="' + esc(e.frameNumber)
        + '" data-fv-stay type="button" style="left:' + ((e.frameNumber / frames) * 100).toFixed(2)
        + '%" title="' + esc(e.type + ' · frame ' + e.frameNumber)
        + '"><span class="fv-sr">' + esc(e.type) + ' at frame ' + esc(e.frameNumber) + '</span></button>';
    }).join('');

    var cursor = '<div class="fv-tl-cursor" style="left:' + ((frame / frames) * 100).toFixed(2) + '%"></div>';

    return '<div class="fv-tl">'
      + tlBand('Calibration', calBand + cursor)
      + tlBand('Ball', ballBand + cursor)
      + tlBand('Events · ' + s.events.length, evBand + cursor, { marks: true })
      + '</div>'
      + '<div class="fv-tl-ruler"><span>frame 0</span>'
      + '<span>' + Chip('MEASURED / OBSERVED', 'READY') + Chip('PROPAGATED', 'DEGRADED')
      + Chip('NO RECORD', 'NOT_AVAILABLE') + '</span>'
      + '<span>frame ' + frames + '</span></div>';
  }

  function secLive() {
    head('Live Analysis', 'The annotated frame, drawn from this session\'s own observations. '
      + 'Where calibration is NONE the metric readout is suppressed, not estimated.',
      '<button class="fv-btn" data-fv-feed="original" type="button" aria-pressed="'
      + (FV.feed === 'original') + '">Original feed</button>'
      + '<button class="fv-btn" data-fv-feed="annotated" type="button" aria-pressed="'
      + (FV.feed === 'annotated') + '">Annotated feed</button>');
    if (!FV.session) { body(needSession()); return; }

    var s = FV.session, sm = s.summary, frame = FV.frame;
    var rows = s.tracks.filter(function (t) { return t.frameNumber === frame; });
    var cal = s.calibration.filter(function (c) { return c.frameNumber === frame; })[0] || null;
    var ballRow = s.ball.filter(function (b) { return b.frameNumber === frame; })[0] || null;
    var evHere = s.events.filter(function (e) { return e.frameNumber === frame; });
    var W = sm.source.width || 1024, H = sm.source.height || 576;

    var feedInner;
    if (FV.feed === 'original') {
      // The original video is not served by this deployment. Saying so is the
      // feature: a black rectangle labelled "live feed" would be a lie about a
      // capability that does not exist.
      feedInner = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Original feed unavailable">'
        + '<rect width="' + W + '" height="' + H + '" fill="#070b14"/></svg>'
        + '<div class="fv-feed-note">ORIGINAL FEED NOT SERVED BY THIS DEPLOYMENT</div>';
    } else {
      var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Annotated frame '
        + frame + '"><rect width="' + W + '" height="' + H + '" fill="#080d18"/>'];
      // A faint grid, so a box has something to sit against without pretending
      // to be a photograph of a pitch.
      for (var gx = 0; gx < W; gx += Math.round(W / 16)) {
        svg.push('<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + H + '" stroke="rgba(255,255,255,.028)" stroke-width="1"/>');
      }
      for (var gy = 0; gy < H; gy += Math.round(H / 9)) {
        svg.push('<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="rgba(255,255,255,.028)" stroke-width="1"/>');
      }
      rows.forEach(function (t) {
        var colour = t.role === 'GOALKEEPER' ? '#fbbf24' : t.role === 'REFEREE' ? '#e2e8f0'
          : t.role === 'UNKNOWN' ? '#a78bfa' : (t.teamId === 'team_a' ? '#22d3ee' : '#34d399');
        if (FV.overlays.boxes) {
          svg.push('<rect x="' + t.box.x1 + '" y="' + t.box.y1 + '" width="' + (t.box.x2 - t.box.x1)
            + '" height="' + (t.box.y2 - t.box.y1) + '" fill="' + colour + '" fill-opacity=".07" stroke="'
            + colour + '" stroke-width="2" rx="3"/>');
        }
        var label = [];
        if (FV.overlays.ids) label.push(t.identity);
        if (FV.overlays.teams && t.teamId) label.push(t.teamId.replace('team_', '').toUpperCase());
        if (FV.overlays.roles && t.role !== 'PLAYER') label.push(t.role);
        if (FV.overlays.confidence && t.classificationConfidence !== null) {
          label.push(t.classificationConfidence.toFixed(2));
        }
        if (FV.overlays.coords && t.pitchXM !== null) {
          label.push(t.pitchXM.toFixed(0) + ' · ' + t.pitchYM.toFixed(0) + ' m');
        }
        if (label.length) {
          var ly = Math.max(13, t.box.y1 - 6);
          svg.push('<rect x="' + t.box.x1 + '" y="' + (ly - 11) + '" width="' + (label.join(' ').length * 6.6 + 8)
            + '" height="14" fill="rgba(4,7,13,.82)" rx="3"/>');
          svg.push('<text x="' + (t.box.x1 + 4) + '" y="' + ly + '" fill="' + colour
            + '" font-size="11" font-family="ui-monospace,monospace">' + esc(label.join(' ')) + '</text>');
        }
      });
      if (FV.overlays.ball && ballRow && ballRow.imageX !== null) {
        var bc = ballRow.state === 'OBSERVED' ? '#ffffff' : '#fbbf24';
        svg.push('<circle cx="' + ballRow.imageX + '" cy="' + ballRow.imageY + '" r="9" fill="none" stroke="'
          + bc + '" stroke-width="2"/>');
        svg.push('<circle cx="' + ballRow.imageX + '" cy="' + ballRow.imageY + '" r="2.5" fill="' + bc + '"/>');
        svg.push('<text x="' + (ballRow.imageX + 13) + '" y="' + (ballRow.imageY - 10) + '" fill="' + bc
          + '" font-size="11" font-family="ui-monospace,monospace">' + esc(ballRow.state) + '</text>');
      }
      if (FV.overlays.events && evHere.length) {
        svg.push('<rect x="12" y="12" width="' + (evHere[0].type.length * 8 + 26) + '" height="22" rx="5" '
          + 'fill="rgba(34,211,238,.16)" stroke="rgba(34,211,238,.5)"/>');
        svg.push('<text x="22" y="27" fill="#22d3ee" font-size="12" font-family="ui-monospace,monospace">'
          + esc(evHere[0].type) + '</text>');
      }
      svg.push('</svg>');
      feedInner = svg.join('')
        + '<div class="fv-feed-note">ANNOTATION LAYER · drawn from stored observations, not from video</div>';
    }

    var toggles = availableOverlays(s).map(function (o) {
      return '<button class="fv-btn" data-fv-overlay="' + o.key + '" type="button" aria-pressed="'
        + !!FV.overlays[o.key] + '">' + esc(o.label) + '</button>';
    }).join('');

    var calLine = cal && cal.chain !== 'none'
      ? Tag(cal.chain.toUpperCase() + ' · ' + cal.confidence + ' · ±' + (cal.expectedErrorM === null
        ? '—' : cal.expectedErrorM.toFixed(3) + ' m'), cal.chain === 'measured' ? 'measured' : 'propagated')
      : Tag('CALIBRATION NONE — NO METRIC CLAIM', 'withheld');

    var transport = '<div class="fv-transport">'
      + '<button class="fv-btn" data-fv-step="-10" type="button" aria-label="Back ten frames">&#171;10</button>'
      + '<button class="fv-btn" data-fv-step="-1" type="button" aria-label="Previous frame">&#8249;</button>'
      + '<button class="fv-btn" data-fv-step="1" type="button" aria-label="Next frame">&#8250;</button>'
      + '<button class="fv-btn" data-fv-step="10" type="button" aria-label="Forward ten frames">10&#187;</button>'
      + '<input class="fv-scrub" type="range" min="0" max="' + Math.max(0, sm.framesProcessed - 1)
      + '" value="' + frame + '" data-fv-scrub aria-label="Seek to frame" '
      + 'style="--fv-pos:' + ((frame / Math.max(1, sm.framesProcessed - 1)) * 100).toFixed(2) + '%">'
      + '</div>'
      + '<div class="fv-readout" style="margin-top:8px">'
      + '<span>frame <b>' + frame + '</b></span>'
      + '<span>t <b>' + (rows.length ? rows[0].timestamp.toFixed(3) : (sm.source.fps
        ? (frame / sm.source.fps).toFixed(3) : '—')) + '</b> s</span>'
      + '<span>video <b>' + (sm.source.fps === null ? '—' : sm.source.fps.toFixed(2)) + '</b> fps</span>'
      + '<span>processing <b>' + (sm.processingFps === null ? '—' : sm.processingFps.toFixed(2)) + '</b> fps</span>'
      + '<span>source <b>' + esc(sm.source.displayName) + '</b></span>'
      + '</div>';

    var miniDots = rows.filter(function (t) { return t.pitchXM !== null; }).map(function (t) {
      var c = t.role === 'GOALKEEPER' ? '#fbbf24' : t.role === 'REFEREE' ? '#e2e8f0'
        : (t.teamId === 'team_a' ? '#22d3ee' : '#34d399');
      return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="1.5" fill="' + c + '"/>';
    }).join('')
      + (ballRow && ballRow.pitchXM !== null
        ? '<circle cx="' + ballRow.pitchXM + '" cy="' + ballRow.pitchYM + '" r="1.1" class="fv-dotball"/>' : '');

    // The three per-frame verdicts ride the rail, beside the frame they belong
    // to, rather than in a row of panels under it. A reader comparing "what is
    // in this frame" with "what the engine says about this frame" should not
    // have to look in two directions to do it.
    var verdicts = Rows([
      ['Ball', ballRow
        ? (Tag(ballRow.state, ballRow.state === 'OBSERVED' ? 'measured'
            : ballRow.state === 'PROPAGATED' ? 'propagated' : 'withheld')
           + (ballRow.origin ? ' ' + Tag(ballRow.origin, ballRow.origin === 'MEASURED' ? 'measured'
              : ballRow.origin === 'PROPAGATED' ? 'propagated' : 'withheld') : ''))
        : '<span class="fv-none">—</span>',
        ballRow && ballRow.reason ? ballRow.reason : 'no ball record for this frame'],
      ['Calibration', cal
        ? Tag(cal.chain.toUpperCase() + (cal.expectedErrorM === null ? ''
            : ' · ±' + cal.expectedErrorM.toFixed(3) + ' m'),
          cal.chain === 'measured' ? 'measured' : cal.chain === 'propagated' ? 'propagated' : 'withheld')
        : '<span class="fv-none">—</span>',
        cal ? 'band ' + cal.confidence : 'no verdict recorded at this frame'],
      ['Events', evHere.length
        ? Tag(String(evHere.length) + ' here', 'measured')
        : '<span class="fv-none">0</span>',
        evHere.length ? evHere.map(function (e) { return e.type; }).join(', ')
          : 'the engine confirmed none at this frame'],
    ]);

    var right = '<div class="fv-stack">'
      + Panel('This frame on the pitch',
        rows.filter(function (t) { return t.pitchXM !== null; }).length
          ? Pitch(miniDots, { small: true, label: 'Frame ' + frame + ' in metres' })
          : Empty('withheld', 'NO METRIC POSITIONS HERE',
            'Calibration published no coordinate for this frame, so nothing may be placed on a pitch.'),
        { aside: calLine })
      + Panel('What the engine says about this frame', verdicts)
      + Panel('Tracks in frame', rows.length
        ? '<div class="fv-rows">' + rows.slice(0, 14).map(function (t) {
          return '<div class="fv-row"><span class="fv-row-k"><b>' + esc(t.identity) + '</b>'
            + '<span class="fv-row-sub">' + esc(t.teamId || 'no team') + ' · ' + esc(t.role) + '</span></span>'
            + '<span class="fv-row-v">' + (t.pitchXM === null ? '<span class="fv-none">—</span>'
              : n(t.pitchXM, 1) + ', ' + n(t.pitchYM, 1)) + '</span></div>';
        }).join('') + '</div>'
        : '<p class="fv-metric-k">No track was observed in this frame.</p>')
      + '</div>';

    // 70 / 30. The canvas is the section; the rail explains it.
    body('<div class="fv-live">'
      + '<section class="fv-panel fv-panel--accent fv-canvas">'
      + '<div class="fv-panel-head"><h3 class="fv-panel-title">'
      + (FV.feed === 'original' ? 'Original feed' : 'Annotated feed') + '</h3>'
      + '<div class="fv-panel-aside">' + calLine + '</div></div>'
      + '<div class="fv-feed">' + feedInner + '</div>'
      + transport
      + EvidenceTimeline(s, frame)
      + '<div class="fv-legend">' + toggles + '</div>'
      + (FV.feed === 'original'
        ? '<p class="fv-note fv-note--warn">This deployment stores evidence, not media. The '
          + 'original video is not served here, so the original feed is an explicit absence '
          + 'rather than a black rectangle pretending to be a camera.</p>'
        : '<p class="fv-note">Every box, label and marker above was drawn from a stored '
          + 'observation. Nothing here was placed by hand, and an overlay whose data this '
          + 'session lacks is not offered as a toggle.</p>')
      + '</section>'
      + right + '</div>');
  }

  // ═══ PLAYER TRACKING ════════════════════════════════════════════════════

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

  function secTracking() {
    head('Player Tracking', 'Real tracks from this session. A pitch position appears only where '
      + 'calibration published one; a gap is left as a gap.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session, caps = s.summary.capabilities;
    var all = trackIndex(s);
    var list = applyTrackFilters(all);
    var sel = FV.selection.track ? all.filter(function (r) { return r.identity === FV.selection.track; })[0] : null;

    var teams = {}; var roles = {};
    all.forEach(function (r) { teams[r.team || 'UNASSIGNED'] = 1; roles[r.role] = 1; });

    var filters = '<div class="fv-filters">'
      + '<label class="fv-sr" for="fv-f-track">Search identity</label>'
      + '<input class="fv-input" id="fv-f-track" data-fv-filter="track" placeholder="Search identity…" value="'
      + esc(FV.filters.track) + '">'
      + '<span class="fv-filter-label">Team</span><select class="fv-select" data-fv-filter="team" aria-label="Filter by team">'
      + '<option value="">All</option>' + Object.keys(teams).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.filters.team === t ? ' selected' : '') + '>'
          + esc(t) + '</option>';
      }).join('') + '</select>'
      + '<span class="fv-filter-label">Role</span><select class="fv-select" data-fv-filter="role" aria-label="Filter by role">'
      + '<option value="">All</option>' + Object.keys(roles).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.filters.role === t ? ' selected' : '') + '>'
          + esc(t) + '</option>';
      }).join('') + '</select>'
      + '<span class="fv-filter-label">Confidence</span><select class="fv-select" data-fv-filter="conf" aria-label="Filter by confidence">'
      + ['', 'high', 'low', 'none'].map(function (v) {
        return '<option value="' + v + '"' + (FV.filters.conf === v ? ' selected' : '') + '>'
          + (v === '' ? 'All' : v === 'high' ? '≥ 0.80' : v === 'low' ? '< 0.80' : 'Not scored') + '</option>';
      }).join('') + '</select>'
      + '</div>';

    var dots = '';
    if (caps.metricCoordinates) {
      if (sel && sel.path.length) {
        dots = s.tracks.filter(function (t) { return t.pitchXM !== null; }).map(function (t) {
          return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.45" class="'
            + (t.calibrationChain === 'measured' ? 'fv-dotm' : 'fv-dotp') + '" opacity=".16"/>';
        }).join('')
          + '<polyline class="fv-trace" points="' + sel.path.map(function (t) {
            return t.pitchXM.toFixed(2) + ',' + t.pitchYM.toFixed(2);
          }).join(' ') + '"/>'
          + sel.path.map(function (t) {
            return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.7" class="fv-dotsel"/>';
          }).join('');
      } else {
        var keep = {};
        list.forEach(function (r) { keep[r.identity] = 1; });
        dots = s.tracks.filter(function (t) { return t.pitchXM !== null && keep[t.identity]; })
          .map(function (t) {
            return '<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.5" class="'
              + (t.calibrationChain === 'measured' ? 'fv-dotm' : 'fv-dotp') + '" opacity=".5"/>';
          }).join('');
      }
    }

    var left = Panel(sel ? 'Trajectory · ' + sel.identity : 'Calibrated positions',
      caps.metricCoordinates
        ? Pitch(dots, { tall: true, label: 'Player positions in metres' }) + LEGEND_ORIGIN
        : Empty('withheld', 'NO METRIC POSITIONS', caps.reasons.metricCoordinates || ''),
      { aside: Tag(s.summary.observationsWithPitchCoords + ' POSITIONS', 'measured'), accent: true });

    var detail = sel
      ? Panel('Selected track', Rows([
        ['Identity', '<b>' + esc(sel.identity) + '</b>'],
        ['Track id', esc(sel.trackId)],
        ['Team', sel.team ? esc(sel.team) : Tag('NONE', 'withheld')],
        ['Role', sel.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(sel.role)],
        ['Classification confidence', n(sel.conf || null, 2)],
        ['Observations', esc(sel.obs)],
        ['With metric position', esc(sel.withCoords) + ' of ' + esc(sel.obs)],
        ['Trajectory', sel.withCoords > 1 ? Tag('AVAILABLE', 'measured') : Tag('INSUFFICIENT', 'withheld')],
        ['Frames', esc(sel.first) + '–' + esc(sel.last)],
        ['Origin', (sel.origins.measured || 0) + ' measured · ' + (sel.origins.propagated || 0)
          + ' propagated · ' + (sel.origins.none || 0) + ' none'],
        ['Source', esc(s.summary.source.displayName)],
      ]) + '<div class="fv-legend"><button class="fv-btn" data-fv-seek="' + esc(sel.first)
        + '" type="button">Open at frame ' + esc(sel.first) + '</button></div>',
        { aside: Tag('EVIDENCE', 'derived') })
      : Panel('No track selected',
        '<p class="fv-metric-k">Choose an identity above to draw its trajectory on the pitch and '
        + 'read its evidence here. A trajectory is drawn only from positions the engine published '
        + '\u2014 nothing is interpolated across a frame where calibration was NONE.</p>');

    var rows = list.map(function (r) {
      return '<tr class="is-clickable" data-fv-track="' + esc(r.identity) + '"'
        + (sel && sel.identity === r.identity ? ' aria-selected="true"' : '') + '>'
        + '<td><b>' + esc(r.identity) + '</b><span class="fv-td-sub">track ' + esc(r.trackId) + '</span></td>'
        + '<td>' + (r.team ? esc(r.team) : Tag('NONE', 'withheld')) + '</td>'
        + '<td>' + (r.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(r.role)) + '</td>'
        + '<td>' + n(r.conf || null, 2) + '</td>'
        + '<td>' + esc(r.obs) + '</td>'
        + '<td>' + esc(r.withCoords) + '</td>'
        + '<td>' + (r.withCoords > 1 ? Tag('YES', 'measured') : Tag('NO', 'withheld')) + '</td>'
        + '<td>' + esc(r.first) + '–' + esc(r.last) + '</td>'
        + '<td><button class="fv-btn" data-fv-seek="' + esc(r.first) + '" type="button">seek</button></td></tr>';
    });

    // PITCH FIRST, INSPECTOR BESIDE IT, RECORD BELOW.
    //
    // The pitch is what a reader is here for — a trajectory is a shape, not a
    // row — so it takes the width. Choosing an identity is done in the rail,
    // an arm's length from the shape it draws, instead of in a nine-column
    // table two screens down. The table is still here, under the fold, as the
    // evidence record: every column it ever had, and nothing in it removed.
    var picker = list.map(function (r) {
      return '<button class="fv-pick is-clickable" data-fv-track="' + esc(r.identity) + '" type="button"'
        + (sel && sel.identity === r.identity ? ' aria-current="true"' : '') + '>'
        + '<span class="fv-pick-id">' + esc(r.identity) + '</span>'
        + '<span class="fv-pick-m">' + esc(r.team || 'no team') + ' · ' + esc(r.role.toLowerCase()) + '</span>'
        + '<span class="fv-pick-n">' + esc(r.withCoords) + '<em>/' + esc(r.obs) + '</em></span></button>';
    }).join('');

    var inspector = '<div class="fv-stack">'
      + Panel('Identities', filters
        + (picker ? '<div class="fv-picks">' + picker + '</div>'
          : '<p class="fv-metric-k">No identity matches these filters.</p>'),
        { aside: Tag(list.length + ' OF ' + all.length, list.length === all.length ? 'measured' : 'accent') })
      + detail + '</div>';

    body('<div class="fv-live">' + left + inspector + '</div>'
      + '<div class="fv-row-gap"></div>'
      + Panel('Evidence record', Table('Tracked identities in this session',
          ['Identity', 'Team', 'Role', 'Conf', 'Observations', 'With metric position',
            'Trajectory', 'Frames', ''], rows)
        + '<p class="fv-note">Provenance: every row came from ' + esc(s.summary.source.displayName)
        + ', pipeline ' + esc(s.summary.pipelineVersion || '—')
        + '. Origin per observation is MEASURED where an anchor solved that frame and PROPAGATED '
        + 'where it was carried.</p>', { flush: false }));
  }

  function showTrack() {
    if (!FV.session) return;
    renderSection();
  }

  // ═══ BALL TRACKING ══════════════════════════════════════════════════════

  function secBall() {
    head('Ball Tracking', 'OBSERVED and PROPAGATED are two different findings and are never merged.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session, st = s.summary.ballStates, total = s.ball.length || 1;
    var current = s.ball.filter(function (b) { return b.frameNumber === FV.frame; })[0] || null;

    var kinds = [
      ['OBSERVED', 'measured', 'the ball was directly detected'],
      ['PROPAGATED', 'propagated', 'carried through measured camera motion, not observed'],
      ['UNKNOWN', 'withheld', 'the ball could not be located'],
      ['NOT_AVAILABLE', 'withheld', 'no ball evidence was produced for these frames'],
    ];
    var stack = '<div class="fv-stackbar" role="img" aria-label="Ball state distribution">'
      + kinds.map(function (k) {
        var c = k[1] === 'measured' ? 'var(--fv-measured)' : k[1] === 'propagated'
          ? 'var(--fv-propagated)' : 'rgba(91,100,128,.55)';
        return '<i style="width:' + (((st[k[0]] || 0) / total) * 100).toFixed(2) + '%;background:' + c + '"></i>';
      }).join('') + '</div>';

    var currentPanel = Panel('Current state at frame ' + FV.frame,
      current
        ? Metric(esc(current.state), '',
          current.reason ? esc(current.reason) : 'no reason recorded')
          + Rows([
            ['Frame · time', esc(current.frameNumber) + ' · ' + n(current.timestamp, 3) + ' s'],
            ['Image position', current.imageX === null ? '<span class="fv-none">—</span>'
              : n(current.imageX, 0) + ', ' + n(current.imageY, 0)],
            ['Metric position', current.pitchXM === null ? Tag('WITHHELD', 'withheld')
              : n(current.pitchXM, 2) + ', ' + n(current.pitchYM, 2) + ' m'],
            ['Tracking confidence', n(current.trackingConfidence, 3)],
            ['Detection confidence', n(current.detectionConfidence, 3)],
            ['Frames since observation', n(current.framesSinceObservation, 0)],
            ['Nearest player', current.nearestPlayer ? esc(current.nearestPlayer)
              : '<span class="fv-none">—</span>'],
            ['Distance', n(current.nearestDistanceM, 2) + ' m'],
            ['Origin', Tag(current.origin, current.origin === 'MEASURED' ? 'measured'
              : current.origin === 'PROPAGATED' ? 'propagated' : 'withheld')],
            ['Source', esc(s.summary.source.displayName)],
          ])
        : Empty('withheld', 'NO BALL RECORD AT THIS FRAME',
          'The tracker published nothing for frame ' + FV.frame + '. Seek to another frame, or '
          + 'open the table below to jump to an observation.'),
      { aside: current ? Tag(current.state, current.state === 'OBSERVED' ? 'measured'
        : current.state === 'PROPAGATED' ? 'propagated' : 'withheld') : '', accent: true });

    var trail = s.ball.filter(function (b) { return b.pitchXM !== null; });
    var path = '';
    // The trajectory is drawn only across CONSECUTIVE evidence. A gap in the
    // record is a gap in the line — a long smooth path bridging thirty frames
    // the tracker never saw would be a picture of an assumption.
    var run = [];
    trail.forEach(function (b, i) {
      var prev = trail[i - 1];
      if (prev && b.frameNumber - prev.frameNumber > 2) {
        if (run.length > 1) path += '<polyline class="fv-trace" points="' + run.join(' ') + '"/>';
        run = [];
      }
      run.push(b.pitchXM.toFixed(2) + ',' + b.pitchYM.toFixed(2));
    });
    if (run.length > 1) path += '<polyline class="fv-trace" points="' + run.join(' ') + '"/>';
    var balls = trail.map(function (b) {
      return '<circle cx="' + b.pitchXM + '" cy="' + b.pitchYM + '" r="0.75" class="'
        + (b.state === 'OBSERVED' ? 'fv-dotball' : 'fv-dotp') + '"/>';
    }).join('');

    var rows = s.ball.filter(function (b) {
      return b.state === 'OBSERVED' || b.state === 'PROPAGATED';
    }).map(function (b) {
      return '<tr' + (current && current.frameNumber === b.frameNumber ? ' aria-selected="true"' : '') + '>'
        + '<td>' + esc(b.frameNumber) + '</td><td>' + n(b.timestamp, 2) + '</td>'
        + '<td>' + Tag(b.state, b.state === 'OBSERVED' ? 'measured' : 'propagated') + '</td>'
        + '<td>' + n(b.imageX, 0) + ', ' + n(b.imageY, 0) + '</td>'
        + '<td>' + (b.pitchXM === null ? '<span class="fv-none">—</span>'
          : n(b.pitchXM, 1) + ', ' + n(b.pitchYM, 1)) + '</td>'
        + '<td>' + n(b.trackingConfidence, 2) + '</td>'
        + '<td>' + n(b.detectionConfidence, 2) + '</td>'
        + '<td>' + n(b.framesSinceObservation, 0) + '</td>'
        + '<td>' + (b.nearestPlayer ? esc(b.nearestPlayer) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + n(b.nearestDistanceM, 2) + '</td>'
        + '<td><button class="fv-btn" data-fv-seek="' + esc(b.frameNumber)
        + '" data-fv-stay type="button">go</button></td></tr>';
    });

    // THE WARNING IS PERMANENT, AND IT IS FIRST.
    //
    // Nearest player and distance are geometry. Every football reading of them
    // — a touch, a control, a possession — is an inference the engine does not
    // make, and this section is where somebody would be most tempted to make
    // it on the engine's behalf. So the sentence is not a footnote under the
    // table it qualifies: it opens the section, and it stays on screen while
    // the table beside it is read.
    var banner = '<div class="fv-banner fv-banner--sticky" role="note">'
      + '<b>PROXIMITY ≠ POSSESSION.</b> The nearest player and the distance on this screen are '
      + 'geometry. Nothing here asserts a touch, a control or a possession, and the engine does '
      + 'not infer one from distance.</div>';

    var states = '<div class="fv-states">' + kinds.map(function (k) {
      return '<div class="fv-state-cell"><span class="fv-state-v fv-state-v--' + k[1] + '">'
        + esc(st[k[0]] || 0) + '</span>'
        + '<span class="fv-state-k">' + esc(k[0].replace(/_/g, ' ')) + '</span>'
        + '<span class="fv-state-s">' + esc(k[2]) + '</span></div>';
    }).join('') + '</div>' + stack
      + '<p class="fv-metric-k">' + esc(s.ball.length) + ' frames of ball record · observed coverage '
      + pct(s.summary.ballObservedCoverage) + ' · ' + esc(s.summary.calibratedBallFrames)
      + ' frames carry a metric position</p>';

    body(banner
      + '<div class="fv-live">'
      + Panel('Ball on the pitch', trail.length
        ? Pitch(path + balls, { tall: true, label: 'Ball positions in metres' })
          + '<p class="fv-note">The line breaks wherever the record does. A smooth path across '
          + 'frames the tracker never saw would be a picture of an assumption.</p>'
        : Empty('withheld', 'NO CALIBRATED BALL POSITIONS',
          'The ball was located in image space but calibration published no pitch coordinate for '
          + 'those frames, so no metric ball position exists.'),
        { aside: Tag(s.summary.calibratedBallFrames + ' CALIBRATED', 'measured'), accent: true })
      + '<div class="fv-stack">' + currentPanel
      + Panel('Where the record stands', states) + '</div>'
      + '</div><div class="fv-row-gap"></div>'
      + Panel('Ball samples', Table('Ball samples with evidence',
        ['Frame', 't (s)', 'State', 'Image x,y', 'Pitch x,y (m)', 'Track conf', 'Det conf',
          'Since obs', 'Nearest', 'Dist (m)', ''], rows)));
  }

  // ═══ PITCH CALIBRATION ══════════════════════════════════════════════════

  function secCalibration() {
    head('Pitch Calibration', 'What was accepted, what the guards withheld, and where no metric '
      + 'claim may be made at all.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session, sm = s.summary;
    var anchors = s.calibration.filter(function (c) { return c.isAnchor; });
    var none = s.calibration.filter(function (c) { return c.chain === 'none'; });
    var bands = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
    anchors.forEach(function (a) { bands[a.confidence] = (bands[a.confidence] || 0) + 1; });
    var errs = anchors.map(function (a) { return a.expectedErrorM; })
      .filter(function (e) { return e !== null; });
    var g = sm.guards || {};
    // A SESSION-LEVEL verdict, and the engine does not publish one — it
    // publishes a verdict per frame. This is therefore a UI summary of those
    // per-frame verdicts and is labelled DERIVED wherever it appears, so it is
    // never mistaken for something the engine decided. The rule is stated on
    // the card rather than buried here:
    //   NONE      no anchor was accepted
    //   DEGRADED  an accepted anchor sits in the LOW band, or coverage < 25%
    //   VALID     otherwise
    var state = anchors.length === 0 ? 'NONE'
      : (bands.LOW > 0 || (sm.calibrationCoverage || 0) < 0.25) ? 'DEGRADED' : 'VALID';
    var stateRule = state === 'NONE' ? 'no anchor was accepted'
      : state === 'DEGRADED'
        ? (bands.LOW > 0 ? bands.LOW + ' accepted anchor' + (bands.LOW === 1 ? '' : 's')
          + ' sit in the LOW band' : 'coverage is below 25%')
        : 'every accepted anchor is HIGH or MEDIUM, and coverage is above 25%';
    var stateTag = state === 'VALID' ? Tag('VALID', 'measured')
      : state === 'DEGRADED' ? Tag('DEGRADED', 'propagated') : Tag('NONE', 'withheld');

    // Anchors placed where the engine's own expected error puts them: a marker
    // per anchor along the frame axis, sized by its error band. Nothing about
    // an anchor's PITCH position is known, so none is drawn.
    var frames = Math.max(1, sm.framesProcessed);
    var anchorStrip = anchors.map(function (a) {
      var cls = a.confidence === 'HIGH' ? 'measured' : a.confidence === 'LOW' ? 'withheld' : 'propagated';
      var colour = cls === 'measured' ? 'var(--fv-measured)'
        : cls === 'propagated' ? 'var(--fv-propagated)' : 'var(--fv-withheld)';
      return '<button class="fv-tl-mark" style="left:' + ((a.frameNumber / frames) * 100).toFixed(2)
        + '%;background:' + colour + '" data-fv-seek="' + a.frameNumber + '" type="button" '
        + 'title="Anchor at frame ' + a.frameNumber + ' · ' + a.confidence + ' · ±'
        + (a.expectedErrorM === null ? '—' : a.expectedErrorM.toFixed(3) + ' m')
        + '" aria-label="Anchor at frame ' + a.frameNumber + '"></button>';
    }).join('');

    // The same run-length lane the Live canvas draws. One way of drawing a
    // calibration chain across a session, used in both places.
    var coverageStrip = tlSpans(s.calibration, frames,
      function (c) { return c.chain === 'measured' ? 'valid' : c.chain === 'propagated' ? 'prop' : 'none'; },
      function (c) { return c.chain; });

    var diagnostics = Rows([
      ['Calibration state', stateTag + ' ' + Tag('DERIVED', 'derived'),
        'a UI summary of the per-frame verdicts; the engine publishes no '
        + 'session-level state'],
      ['Coverage', pct(sm.calibrationCoverage)],
      ['Measured frames', esc(sm.calibrationMeasuredFrames)],
      ['Propagated frames', esc(sm.calibrationPropagatedFrames)],
      ['Frames with NONE', esc(none.length), 'no coordinate published, none may be inferred'],
      ['Accepted anchors', esc(anchors.length), 'HIGH ' + bands.HIGH + ' · MEDIUM ' + bands.MEDIUM
        + ' · LOW ' + bands.LOW],
      ['Expected metric error', errs.length
        ? n(Math.min.apply(null, errs), 3) + ' – ' + n(Math.max.apply(null, errs), 3) + ' m'
        : '<span class="fv-none">—</span>', 'cross-validated, not measured against ground truth'],
      ['Anchor disagreement', n(sm.anchorDisagreementMedianM, 3) + ' m',
        'a fresh anchor against the propagated chain it replaced'],
      ['Coordinates on pitch', pct(sm.coordsOnPitchRate)],
      ['Provider', esc((s.summary.providers.filter(function (p) {
        return p.role === 'pitch_calibrator';
      })[0] || {}).provider || '—')],
    ]);

    var guards = Rows([
      ['Speed-guard spans examined', n(g.speedGuardSpans)],
      ['Spans withheld as physically impossible', n(g.speedGuardSpansWithheld)],
      ['Frames whose coordinates were withheld', n(g.speedGuardFramesWithheld)],
      ['Worst p90 implied speed', n(g.speedGuardP90MsMax, 1) + ' m/s'],
    ]) + '<p class="fv-note fv-note--loud">The physical guard only ever WITHHOLDS. It never rescales '
      + 'or repairs a coordinate, because nothing in the system knows what the right scale would '
      + 'have been. A rejected span is drawn as NONE above, not as a lower-confidence estimate.</p>';

    var rows = anchors.map(function (a) {
      return '<tr><td>' + esc(a.frameNumber) + '</td>'
        + '<td>' + Tag(a.confidence, a.confidence === 'HIGH' ? 'measured'
          : a.confidence === 'NONE' ? 'withheld' : 'propagated') + '</td>'
        + '<td>' + n(a.expectedErrorM, 3) + '</td>'
        + '<td>' + n(a.score, 4) + '</td>'
        + '<td>' + (a.landmark ? esc(a.landmark) : '<span class="fv-none">—</span>') + '</td>'
        + '<td><button class="fv-btn" data-fv-seek="' + esc(a.frameNumber) + '" type="button">seek</button></td></tr>';
    });

    // CALIBRATION READS LIKE A BENCH INSTRUMENT.
    //
    // Six panels in a wrapping grid made six separate claims of equal weight.
    // A calibration report is not six claims: it is one verdict, qualified by
    // five figures. So the verdict leads at instrument scale and the five sit
    // beside it on one baseline, aligned and tabular, the way a reading is
    // printed on a meter rather than scattered across cards.
    body('<section class="fv-instr">'
      + '<div class="fv-instr-lead">'
      + '<div class="fv-instr-k">Calibration state ' + stateTag + ' ' + Tag('DERIVED', 'derived') + '</div>'
      + '<div class="fv-instr-v">' + esc(state) + '</div>'
      + '<p class="fv-instr-s">' + esc(stateRule) + '. '
      + (anchors.length ? esc(anchors.length) + ' anchors survived every gate.'
        : 'Every candidate failed the validity gate.')
      + ' The engine publishes a verdict per FRAME and no verdict for the session, so this word is '
      + 'this screen’s summary of those verdicts and is labelled DERIVED wherever it appears.</p>'
      + '</div>'
      + '<div class="fv-instr-dials">'
      + Dial(pct(sm.calibrationCoverage), 'Coverage',
        esc(sm.calibrationMeasuredFrames) + ' measured · ' + esc(sm.calibrationPropagatedFrames) + ' propagated',
        sm.calibrationCoverage)
      + Dial(errs.length ? n(Math.min.apply(null, errs), 3) + '–' + n(Math.max.apply(null, errs), 3)
          + '<small> m</small>' : '<span class="fv-none">—</span>',
        'Expected metric error', 'cross-validated across accepted anchors')
      + Dial(n(sm.anchorDisagreementMedianM, 3) + '<small> m</small>', 'Anchor disagreement',
        'fresh anchor against the chain it replaced')
      + Dial(esc(none.length), 'Frames withheld', 'calibration NONE · no metric claim')
      + Dial(pct(sm.coordsOnPitchRate), 'Coordinates on pitch',
        esc(sm.observationsWithPitchCoords) + ' published positions', sm.coordsOnPitchRate)
      + '</div></section><div class="fv-row-gap"></div>'
      + Panel('Calibration across the session',
        '<div class="fv-tl">'
        + '<div class="fv-tl-band"><div class="fv-tl-label">Chain</div>'
        + '<div class="fv-tl-track">' + coverageStrip + '</div></div>'
        + '<div class="fv-tl-band"><div class="fv-tl-label">Accepted anchors</div>'
        + '<div class="fv-tl-track fv-tl-track--marks">' + anchorStrip + '</div></div>'
        + '</div>'
        + '<div class="fv-tl-ruler"><span>frame 0</span><span>frame ' + frames + '</span></div>'
        + '<div class="fv-legend">'
        + Chip('MEASURED', 'READY') + Chip('PROPAGATED', 'DEGRADED')
        + Chip('NONE', 'NOT_AVAILABLE') + '</div>', { accent: true })
      + '<div class="fv-row-gap"></div>'
      + '<div class="fv-split">'
      + Panel('Accepted anchors', rows.length
        ? Table('Accepted calibration anchors',
          ['Frame', 'Band', 'Expected error (m)', 'Score', 'Landmark evidence', ''], rows)
          + '<p class="fv-note">Landmark evidence reads as an em dash because this engine schema '
          + 'records the landmark sentence on the calibration state rather than on each frame\'s '
          + 'provenance. An em dash means the platform does not hold the figure — it does not mean '
          + 'the anchor had no evidence.</p>'
        : Empty('withheld', 'NO ANCHOR ACCEPTED',
          'Every candidate failed the validity gate, so this session carries no metric geometry. '
          + 'That is a result, not a fault.'))
      + '<div class="fv-stack">' + Panel('Diagnostics', diagnostics)
      + Panel('Validation guards', guards) + '</div>'
      + '</div>');
  }

  // ═══ TEAMS & ROLES ══════════════════════════════════════════════════════

  function secTeams() {
    head('Teams & Roles', 'No classification is forced. UNKNOWN is an answer and it is kept — '
      + 'never folded into a team to make a card look complete.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var teams = {}; var roles = {};
    s.tracks.forEach(function (t) {
      var k = t.teamId || 'UNASSIGNED';
      (teams[k] || (teams[k] = { identities: {}, obs: 0 }));
      teams[k].identities[t.identity] = 1;
      teams[k].obs += 1;
      roles[t.role] = (roles[t.role] || 0) + 1;
    });
    var totalObs = s.tracks.length || 1;

    // TEAMS AS LANES, NOT AS CARDS.
    //
    // A squad is a group of people, and the question a reader asks here is how
    // the session's observations DIVIDED between the groups — including the
    // group that is "no group". Three cards in a wrapping grid answer that
    // badly: they are the same size whatever share they hold, so the share has
    // to be read off a number instead of seen. A lane per team, as wide as its
    // share, shows the division and keeps the number.
    var teamLane = Object.keys(teams).sort().map(function (k) {
      var isUnassigned = k === 'UNASSIGNED';
      var colour = k === 'team_a' ? 'var(--fv-accent)' : k === 'team_b' ? 'var(--fv-measured)'
        : 'var(--fv-withheld)';
      var ids = Object.keys(teams[k].identities);
      return '<div class="fv-lane" style="--fv-lane-c:' + colour + '">'
        + '<div class="fv-lane-head"><span class="fv-lane-n">'
        + esc(isUnassigned ? 'NO TEAM ASSIGNED' : k.toUpperCase()) + '</span>'
        + (isUnassigned ? Tag('UNKNOWN', 'withheld') : Tag('CLUSTERED', 'measured')) + '</div>'
        + '<div class="fv-lane-v">' + esc(ids.length) + '<small>identities</small></div>'
        + '<div class="fv-bar"><i style="width:' + ((teams[k].obs / totalObs) * 100).toFixed(1)
        + '%;background:' + colour + '"></i></div>'
        + '<div class="fv-lane-s">' + esc(teams[k].obs) + ' observations · '
        + pct(teams[k].obs / totalObs) + ' of the session</div>'
        + '<div class="fv-lane-ids">' + ids.slice(0, 26).map(function (id) {
          return '<button class="fv-chipid" data-fv-track="' + esc(id) + '" type="button">'
            + esc(id) + '</button>';
        }).join('') + (ids.length > 26 ? '<span class="fv-lane-more">+' + (ids.length - 26) + '</span>' : '')
        + '</div></div>';
    }).join('');
    var teamCards = '<div class="fv-lanes">' + teamLane + '</div>';

    var roleTotal = Object.keys(roles).reduce(function (a, r) { return a + roles[r]; }, 0) || 1;
    var roleCards = Panel('Roles across the session',
      '<div class="fv-lanes fv-lanes--roles">' + Object.keys(roles).sort().map(function (r) {
        var c = r === 'UNKNOWN' ? 'var(--fv-withheld)' : r === 'GOALKEEPER' ? 'var(--fv-propagated)'
          : r === 'REFEREE' ? 'var(--fv-tx)' : r === 'OFF_PITCH' ? 'var(--fv-unver)' : 'var(--fv-accent)';
        return '<div class="fv-lane fv-lane--sm" style="--fv-lane-c:' + c + '">'
          + '<div class="fv-lane-head"><span class="fv-lane-n">' + esc(r) + '</span>'
          + (r === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : '') + '</div>'
          + '<div class="fv-lane-v">' + esc(roles[r]) + '<small>observations</small></div>'
          + '<div class="fv-bar"><i style="width:' + ((roles[r] / roleTotal) * 100).toFixed(1)
          + '%;background:' + c + '"></i></div>'
          + '<div class="fv-lane-s">' + esc(
            r === 'UNKNOWN' ? 'evidence was insufficient to decide; nothing was forced'
              : r === 'GOALKEEPER' ? 'decided on metric position, not on kit colour'
                : r === 'REFEREE' ? 'neither kit, and not confined to a penalty area'
                  : r === 'OFF_PITCH' ? 'feet did not land on detected grass'
                    : 'kit matched a team cluster') + '</div></div>';
      }).join('') + '</div>');

    var rows = s.roles.map(function (r) {
      return '<tr class="is-clickable" data-fv-track="' + esc(r.identity) + '">'
        + '<td><b>' + esc(r.identity) + '</b></td>'
        + '<td>' + (r.role === 'UNKNOWN' ? Tag('UNKNOWN', 'withheld') : esc(r.role)) + '</td>'
        + '<td>' + n(r.confidence, 2) + '</td>'
        + '<td>' + n(r.observations) + '</td>'
        + '<td>' + esc(r.reason || '—') + '</td></tr>';
    });

    body(teamCards + '<div class="fv-row-gap"></div>' + roleCards + '<div class="fv-row-gap"></div>'
      + Panel('Role evidence', rows.length
        ? Table('Per-identity role reasoning',
          ['Identity', 'Classification', 'Confidence', 'Observations', 'Reason'], rows)
          + '<p class="fv-note fv-note--loud">A role decided on METRIC POSITION requires calibration. '
          + 'Where the session had none, the honest answer is UNKNOWN, and UNKNOWN is what is '
          + 'stored and what is shown.</p>'
        : Empty('absent', 'NO ROLE EVIDENCE RECORDED',
          'This session produced no per-identity role reasoning.')));
  }

  // ═══ EVENTS ═════════════════════════════════════════════════════════════

  function secEvents() {
    head('Events', 'Only findings the validated engine emitted. Selecting one shows its evidence '
      + 'and seeks the analysis to its frame.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    if (!s.events.length) {
      body(Empty('withheld', 'NO EVENTS CONFIRMED',
        s.summary.capabilities.reasons.events
        || 'The engine confirmed no football event in this session.', 'events'));
      return;
    }
    var sel = FV.selection.event
      ? s.events.filter(function (e) { return e.eventId === FV.selection.event; })[0] : null;
    var frames = Math.max(1, s.summary.framesProcessed);

    var counts = {};
    s.events.forEach(function (e) { counts[e.type + ' · ' + e.state] = (counts[e.type + ' · ' + e.state] || 0) + 1; });
    var cards = Object.keys(counts).map(function (k) {
      var isProx = k.indexOf('PROXIMITY') === 0;
      return Panel(k, Metric(esc(counts[k]), '', isProx
        ? 'distance only. This asserts no touch and no possession.'
        : 'confirmed against ball evidence, not from proximity'),
        { aside: isProx ? Tag('NOT POSSESSION', 'withheld') : Tag('CONFIRMED', 'measured') });
    }).join('');

    var strip = s.events.map(function (e) {
      return '<button class="fv-tl-mark fv-tl-mark--event" style="left:'
        + ((e.frameNumber / frames) * 100).toFixed(2) + '%" data-fv-event="' + esc(e.eventId)
        + '" type="button" title="' + esc(e.type + ' at frame ' + e.frameNumber)
        + '" aria-label="' + esc(e.type + ' at frame ' + e.frameNumber) + '"></button>';
    }).join('');

    var detail = sel
      ? Panel('Selected event', Rows([
        ['Event id', '<span style="font-size:11px">' + esc(sel.eventId) + '</span>'],
        ['Type', '<b>' + esc(sel.type) + '</b>'],
        ['State', Tag(sel.state, sel.state === 'CONFIRMED' ? 'measured' : 'withheld')],
        ['Frame · time', esc(sel.frameNumber) + ' · ' + n(sel.timestamp, 3) + ' s'],
        ['Track IDs', sel.trackIds.length ? esc(sel.trackIds.join(', ')) : '<span class="fv-none">—</span>'],
        ['Team', sel.teamId ? esc(sel.teamId) : '<span class="fv-none">—</span>'],
        ['Ball state', sel.ballState ? Tag(sel.ballState, sel.ballState === 'OBSERVED' ? 'measured'
          : 'propagated') : '<span class="fv-none">—</span>'],
        ['Pitch position', sel.pitchXM === null ? Tag('WITHHELD', 'withheld')
          : n(sel.pitchXM, 2) + ', ' + n(sel.pitchYM, 2) + ' m'],
        ['Confidence', n(sel.confidence, 3)],
        ['Origin', Tag(sel.origin, sel.origin === 'MEASURED' ? 'measured'
          : sel.origin === 'PROPAGATED' ? 'propagated' : 'withheld')],
        ['Source', esc(s.summary.source.displayName)],
      ]) + (sel.reason ? '<p class="fv-note">' + esc(sel.reason) + '</p>' : '')
        + '<div class="fv-legend"><button class="fv-btn" data-fv-seek="' + esc(sel.frameNumber)
        + '" type="button">Open at frame ' + esc(sel.frameNumber) + '</button></div>',
        { accent: true, aside: Tag('EVIDENCE', 'derived') })
      : Panel('No event selected',
        '<p class="fv-metric-k">Choose a finding on the left, or a mark on the timeline, to read '
        + 'the evidence the engine recorded for it.</p>');

    var rows = s.events.map(function (e) {
      return '<tr class="is-clickable" data-fv-event="' + esc(e.eventId) + '"'
        + (sel && sel.eventId === e.eventId ? ' aria-selected="true"' : '') + '>'
        + '<td><b>' + esc(e.type) + '</b><span class="fv-td-sub">' + esc(e.eventId) + '</span></td>'
        + '<td>' + Tag(e.state, e.state === 'CONFIRMED' ? 'measured' : 'withheld') + '</td>'
        + '<td>' + esc(e.frameNumber) + '</td><td>' + n(e.timestamp, 2) + '</td>'
        + '<td>' + (e.trackIds.length ? esc(e.trackIds.join(', ')) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + (e.teamId ? esc(e.teamId) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + (e.ballState ? esc(e.ballState) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + n(e.confidence, 2) + '</td>'
        + '<td>' + Tag(e.origin, e.origin === 'MEASURED' ? 'measured'
          : e.origin === 'PROPAGATED' ? 'propagated' : 'withheld') + '</td>'
        + '<td>' + esc(e.reason || '—') + '</td>'
        + '<td><button class="fv-btn" data-fv-seek="' + esc(e.frameNumber) + '" type="button">seek</button></td>'
        + '</tr>';
    });

    // A THREE-COLUMN WORKSTATION: index, subject, evidence.
    //
    // Reading an event is a loop — pick one, look at where and when it sits,
    // read what the engine recorded for it, pick the next. Laid out as a grid
    // of count cards over a timeline over a wide table, that loop crossed the
    // whole page twice per event. Here the three things the loop needs are
    // side by side: the list to pick from, the timeline and counts that place
    // the pick, and the evidence for it.
    var picker = s.events.map(function (e) {
      return '<button class="fv-pick is-clickable" data-fv-event="' + esc(e.eventId) + '" type="button"'
        + (sel && sel.eventId === e.eventId ? ' aria-current="true"' : '') + '>'
        + '<span class="fv-pick-id">' + esc(e.type) + '</span>'
        + '<span class="fv-pick-m">frame ' + esc(e.frameNumber) + ' · ' + n(e.timestamp, 2) + ' s'
        + (e.teamId ? ' · ' + esc(e.teamId) : '') + '</span>'
        + '<span class="fv-pick-n">' + (e.confidence === null ? '—' : n(e.confidence, 2)) + '</span>'
        + '</button>';
    }).join('');

    body('<div class="fv-work3">'
      + Panel('Findings', '<div class="fv-picks fv-picks--tall">' + picker + '</div>',
        { aside: Tag(s.events.length + ' CONFIRMED', 'measured') })
      + '<div class="fv-stack">'
      + Panel('Where they fall', '<div class="fv-tl"><div class="fv-tl-band">'
        + '<div class="fv-tl-label">Confirmed</div>'
        + '<div class="fv-tl-track fv-tl-track--marks">' + strip + '</div></div></div>'
        + '<div class="fv-tl-ruler"><span>frame 0</span><span>frame ' + frames + '</span></div>'
        + '<p class="fv-note">Each mark is one finding, at the frame the engine placed it.</p>')
      + (sel && sel.pitchXM !== null
        ? Panel('Where this one is', Pitch('<circle cx="' + sel.pitchXM + '" cy="' + sel.pitchYM
            + '" r="1.6" class="fv-dotsel"/><circle cx="' + sel.pitchXM + '" cy="' + sel.pitchYM
            + '" r="4" fill="none" stroke="var(--fv-accent)" stroke-width=".3" opacity=".7"/>',
            { small: true, label: 'Pitch position of the selected finding' }),
          { aside: Tag('MEASURED', 'measured') })
        : sel
          ? Panel('Where this one is', Empty('withheld', 'POSITION WITHHELD',
            'Calibration published no pitch coordinate at frame ' + sel.frameNumber + ', so this '
            + 'finding has no metric position.'))
          : '')
      + '<div class="fv-grid">' + cards + '</div>'
      + '</div>'
      + detail
      + '</div><div class="fv-row-gap"></div>'
      + Panel('Evidence record', Table('Confirmed football events',
        ['Event', 'State', 'Frame', 't (s)', 'Tracks', 'Team', 'Ball', 'Conf', 'Origin', 'Reason', ''],
        rows)));
  }

  function showEvent() { renderSection(); }

  // ═══ TACTICAL VIEW ══════════════════════════════════════════════════════

  function secTactical() {
    head('Tactical View', 'The architecture and the data contract exist. The evidence does not.');
    var caps = FV.session && FV.session.summary.capabilities;
    var areas = [
      ['Team shape', 'a formation requires sustained metric coverage of both teams at once'],
      ['Zones', 'zone occupancy requires a possession attribution the engine does not produce'],
      ['Space', 'controlled space requires every player located in the same frame'],
      ['Passing lanes', 'a lane requires a pass, and no pass is confirmed by the engine'],
      ['Pressing', 'pressing requires possession, which proximity is not'],
      ['Transitions', 'a transition requires two possessions to move between'],
      ['Available actions', 'requires all of the above'],
    ].map(function (a) {
      return '<div class="fv-await"><span class="fv-await-k">' + esc(a[0]) + '</span>'
        + '<span class="fv-await-v fv-none">—</span>'
        + '<span class="fv-await-s">' + esc(a[1]) + '</span></div>';
    }).join('');

    // THE PITCH IS THE SUBJECT, EVEN WHEN IT IS EMPTY.
    //
    // A screen that says "nothing here" with a small icon reads as a broken
    // screen. This one draws the pitch a tactical result would be drawn ON,
    // at full size, and says across it what is missing and why. The absence
    // is the finding, so the absence gets the hero.
    body('<div class="fv-live">'
      + '<section class="fv-panel fv-panel--accent">'
      + '<div class="fv-panel-head"><h3 class="fv-panel-title">Tactical surface</h3>'
      + '<div class="fv-panel-aside">' + Tag('AWAITING EVIDENCE', 'future') + '</div></div>'
      + '<div class="fv-await-hero">'
      + Pitch('', { tall: true, label: 'Pitch with no tactical result to draw' })
      + '<div class="fv-await-over">'
      + '<div class="fv-await-t">TACTICAL INTELLIGENCE</div>'
      + '<div class="fv-await-t2">WAITING FOR VALIDATED EVIDENCE</div>'
      + '<p class="fv-await-p">' + esc(sentence((caps && caps.reasons.tactical)
        || 'Tactical intelligence is not implemented in the validated engine. No formation, team '
          + 'shape, zone, controlled space, passing lane, pressing, overload or transition result '
          + 'exists to display, and drawing one from position data alone would be a diagram of an '
          + 'assumption rather than a finding.')) + '</p>'
      + '</div></div></section>'
      + '<div class="fv-stack">'
      + Panel('What a tactical result would need', Rows([
        ['Sustained metric coverage across both teams',
          caps && caps.metricCoordinates ? Tag('PARTIAL', 'propagated') : Tag('NOT MET', 'future')],
        ['Possession attribution beyond confirmed control', Tag('NOT IMPLEMENTED', 'future')],
        ['Human-verified ground truth to validate against', Tag('NONE EXISTS', 'future')],
      ]) + '<p class="fv-note fv-note--loud">The contract is in place — a tactical result would '
        + 'arrive as its own evidence type, with its own confidence, through the same session API. '
        + 'Nothing about this screen would need rebuilding. What is missing is the finding, not '
        + 'the plumbing.</p>')
      + Panel('Every reading that is waiting', '<div class="fv-awaits">' + areas + '</div>')
      + '</div></div>');
  }

  // ═══ HEATMAPS ═══════════════════════════════════════════════════════════

  var HEAT_CX = 21, HEAT_CY = 14;

  function secHeatmaps() {
    head('Heatmaps', 'Generated only from genuine calibrated history. Never decorative, never '
      + 'smoothed across an observation that was not made.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session, caps = s.summary.capabilities;
    if (!caps.heatmaps) {
      body(Empty('withheld', 'INSUFFICIENT CALIBRATED TRACKING DATA', caps.reasons.heatmaps || '', 'heat'));
      return;
    }

    var teams = {}; var players = {};
    s.tracks.forEach(function (t) {
      if (t.pitchXM === null) return;
      teams[t.teamId || 'UNASSIGNED'] = 1;
      players[t.identity] = 1;
    });

    var pool = s.tracks.filter(function (t) {
      if (t.pitchXM === null || t.pitchYM === null) return false;
      if (FV.selection.heatTeam && (t.teamId || 'UNASSIGNED') !== FV.selection.heatTeam) return false;
      if (FV.selection.heatPlayer && t.identity !== FV.selection.heatPlayer) return false;
      return true;
    });

    var grid = new Array(HEAT_CX * HEAT_CY).fill(0);
    var max = 0;
    pool.forEach(function (t) {
      var cx = Math.min(HEAT_CX - 1, Math.max(0, Math.floor(t.pitchXM / (105 / HEAT_CX))));
      var cy = Math.min(HEAT_CY - 1, Math.max(0, Math.floor(t.pitchYM / (68 / HEAT_CY))));
      var i = cy * HEAT_CX + cx;
      grid[i] += 1;
      if (grid[i] > max) max = grid[i];
    });

    var cells = [];
    for (var y = 0; y < HEAT_CY; y++) {
      for (var x = 0; x < HEAT_CX; x++) {
        var v = grid[y * HEAT_CX + x];
        if (!v) continue;
        var a = Math.pow(v / max, 0.58);
        cells.push('<rect x="' + (x * (105 / HEAT_CX)) + '" y="' + (y * (68 / HEAT_CY))
          + '" width="' + (105 / HEAT_CX) + '" height="' + (68 / HEAT_CY)
          + '" fill="rgba(34,211,238,' + a.toFixed(3) + ')"><title>' + v
          + ' calibrated positions</title></rect>');
      }
    }

    var controls = '<div class="fv-filters">'
      + '<span class="fv-filter-label">Team</span><select class="fv-select" data-fv-select="heatTeam" aria-label="Filter heatmap by team">'
      + '<option value="">All teams</option>' + Object.keys(teams).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.selection.heatTeam === t ? ' selected' : '') + '>'
          + esc(t) + '</option>';
      }).join('') + '</select>'
      + '<span class="fv-filter-label">Player</span><select class="fv-select" data-fv-select="heatPlayer" aria-label="Filter heatmap by player">'
      + '<option value="">All players</option>' + Object.keys(players).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (FV.selection.heatPlayer === t ? ' selected' : '') + '>'
          + esc(t) + '</option>';
      }).join('') + '</select>'
      + Tag('VALID CALIBRATED ONLY', 'measured')
      + '</div>';

    if (!pool.length) {
      body(controls + Empty('withheld', 'NO CALIBRATED POSITIONS FOR THIS SELECTION',
        'The filters above leave no calibrated position. Widen them, or accept that this '
        + 'player or team produced none in this session.', 'heat'));
      return;
    }

    // PITCH FIRST. The controls select what is on it; they do not precede it.
    var occupied = 0;
    for (var gi = 0; gi < grid.length; gi++) { if (grid[gi]) occupied += 1; }

    body('<div class="fv-live">'
      + Panel('Occupancy', Pitch(cells.join(''), { tall: true, label: 'Occupancy heatmap' })
        + '<p class="fv-note">Built from ' + pool.length + ' calibrated positions counted into '
        + 'five-metre cells. Nothing is smoothed and nothing is interpolated between observations, '
        + 'so an empty cell means no calibrated position landed there — not low activity.</p>',
        { accent: true, aside: Tag('MEASURED', 'measured') })
      + '<div class="fv-stack">'
      + Panel('Selection', controls)
      + Panel('What is on the pitch', '<div class="fv-instr-dials">'
        + Dial(esc(pool.length), 'Calibrated positions', 'after the selection above')
        + Dial(esc(max), 'Busiest cell', 'positions in one five-metre cell')
        + Dial(esc(occupied) + '<small> / ' + (HEAT_CX * HEAT_CY) + '</small>', 'Cells occupied',
          'a cell with no position is drawn empty, not dim', occupied / (HEAT_CX * HEAT_CY))
        + '</div>')
      + '</div></div>');
  }

  // ═══ PHYSICAL METRICS ═══════════════════════════════════════════════════

  function secPhysical() {
    head('Physical Metrics', 'The contract exists. The validated measurement does not.');
    var g = FV.session && FV.session.summary.guards;
    // A READINESS SCREEN, NOT SIX EMPTY GAUGES.
    //
    // Six panels each reading "—" said the same thing six times and looked
    // like six failures. What a reader needs to know is one thing — none of
    // these is validated yet — and then, per reading, what would have to be
    // true before it could be shown. That is a readiness list.
    var cards = [
      ['Speed', 'm/s', 'a per-frame displacement over a calibrated interval, validated against ground truth'],
      ['Acceleration', 'm/s²', 'a second derivative of a measurement that is not yet validated'],
      ['Distance', 'm', 'a sum over frames, and a sum over gaps is not a distance'],
      ['High-speed running', 'm', 'a threshold on a speed that has no validated value'],
      ['Sprints', 'count', 'a count of crossings of that same threshold'],
      ['Stamina / load', 'AU', 'a model over all of the above'],
    ].map(function (k) {
      return '<div class="fv-await"><span class="fv-await-k">' + esc(k[0])
        + '<em>' + esc(k[1]) + '</em></span>'
        + '<span class="fv-await-v fv-none">—</span>'
        + '<span class="fv-await-s">' + esc(k[2]) + '</span>'
        + Tag('NOT YET VALIDATED', 'future') + '</div>';
    }).join('');

    body('<section class="fv-instr">'
      + '<div class="fv-instr-lead">'
      + '<div class="fv-instr-k">Physical metrics ' + Tag('NOT YET VALIDATED', 'future') + '</div>'
      + '<div class="fv-instr-v">0 <small>of 6 ready</small></div>'
      + '<p class="fv-instr-s">' + esc(sentence((FV.session && FV.session.summary.capabilities.reasons.physicalMetrics)
        || 'The engine measures implied speed only as a calibration guard, and it is deliberately '
          + 'not exposed as a player measurement.'))
      + ' Nothing on this screen is withheld to be cautious: there is no validated figure to withhold.</p>'
      + '</div></section>'
      + '<div class="fv-row-gap"></div>'
      + Panel('Readiness', '<div class="fv-awaits fv-awaits--wide">' + cards + '</div>')
      + (g ? '<div class="fv-row-gap"></div>'
        + Panel('What the engine does measure, and why it is not this', Rows([
          ['Worst p90 implied speed in a calibrated span', n(g.speedGuardP90MsMax, 1) + ' m/s'],
          ['Spans examined', n(g.speedGuardSpans)],
          ['Spans withheld as physically impossible', n(g.speedGuardSpansWithheld)],
          ['Frames whose coordinates were withheld', n(g.speedGuardFramesWithheld)],
        ]) + '<p class="fv-note fv-note--loud">This is a GUARD statistic. It exists to reject a '
          + 'calibration whose metres imply people outrunning the world record, and it is computed '
          + 'over a whole span rather than per player. Presenting it as a player\'s speed would be '
          + 'presenting a validation threshold as a performance measurement.</p>',
          { aside: Tag('GUARD, NOT A METRIC', 'propagated') }) : ''));
  }

  // ═══ TIMELINE ═══════════════════════════════════════════════════════════

  function secTimeline() {
    head('Timeline', 'The session as a strip of time, with the gaps drawn as gaps. Click any mark '
      + 'to seek the analysis there.');
    if (!FV.session) { body(needSession()); return; }
    if (!FV.timeline) { body(Empty('withheld', 'READING TIMELINE', 'One moment.')); return; }
    var tl = FV.timeline, total = Math.max(1, tl.frames);

    function band(label, kinds) {
      var spans = tl.spans.filter(function (x) { return kinds.indexOf(x.kind) > -1; })
        .map(function (x) {
          var k = x.kind.indexOf('OBSERVED') > -1 ? 'obs'
            : x.kind.indexOf('VALID') > -1 ? 'valid'
              : x.kind.indexOf('PROPAGATED') > -1 ? 'prop'
                : x.kind.indexOf('GAP') > -1 ? 'gap' : 'none';
          return '<div class="fv-tl-span fv-tl-span--' + k + '" style="left:'
            + ((x.fromFrame / total) * 100).toFixed(3) + '%;width:'
            + Math.max(0.2, ((x.toFrame - x.fromFrame + 1) / total) * 100).toFixed(3)
            + '%" title="' + esc(x.kind.replace(/_/g, ' ') + ' · frames ' + x.fromFrame + '–'
              + x.toFrame + ' (' + x.frames + ')') + '"></div>';
        }).join('');
      var cursor = '<div class="fv-tl-cursor" style="left:' + ((FV.frame / total) * 100).toFixed(3) + '%"></div>';
      return '<div class="fv-tl-band"><div class="fv-tl-label">' + esc(label) + '</div>'
        + '<div class="fv-tl-track">' + spans + cursor + '</div></div>';
    }

    function marks(label, kind, cls) {
      var hits = tl.marks.filter(function (x) { return x.kind === kind; });
      var m = hits.map(function (x) {
        return '<button class="fv-tl-mark fv-tl-mark--' + cls + '" style="left:'
          + ((x.frame / total) * 100).toFixed(3) + '%" data-fv-seek="' + x.frame
          + '" data-fv-stay type="button" title="' + esc(x.label + (x.detail ? ' \u2014 ' + x.detail : ''))
          + '" aria-label="' + esc(x.label + ' at frame ' + x.frame) + '"></button>';
      }).join('');
      return '<div class="fv-tl-band"><div class="fv-tl-label">' + esc(label)
        + '<em>' + hits.length + '</em></div>'
        + '<div class="fv-tl-track fv-tl-track--marks">' + (m
          || '<span class="fv-metric-k" style="font-size:10px;margin:0">none in this session</span>')
        + '<div class="fv-tl-cursor" style="left:' + ((FV.frame / total) * 100).toFixed(3)
        + '%"></div></div></div>';
    }

    var sm = FV.session.summary;
    var sourceBand = '<div class="fv-tl-band"><div class="fv-tl-label">Source</div>'
      + '<div class="fv-tl-track"><div class="fv-tl-span fv-tl-span--obs" style="left:0;width:100%" '
      + 'title="' + esc(sm.source.displayName) + '"></div>'
      + '<div class="fv-tl-cursor" style="left:' + ((FV.frame / total) * 100).toFixed(3) + '%"></div></div></div>';

    var legend = Object.keys(tl.legend).map(function (k) {
      return '<div class="fv-row"><span class="fv-row-k">' + esc(k.replace(/_/g, ' '))
        + '</span><span class="fv-row-v" style="font-size:11px;color:var(--fv-tx-3);'
        + 'text-align:left;max-width:58ch;font-variant-numeric:normal">'
        + esc(tl.legend[k]) + '</span></div>';
    }).join('');

    // FULL WIDTH, AND EVERY LAYER THE SAME PLAYHEAD.
    //
    // This is the one screen whose subject is the whole session at once, so it
    // takes the whole width and the bands are drawn at reading height rather
    // than as hairlines. The cursor crosses every layer: a reader comparing
    // "was calibration measured here" with "was the ball seen here" is asking
    // about ONE instant, and an instant marked on one band only is an instant
    // they have to hold in their head.
    var cursorAll = '<div class="fv-tl-cursor" style="left:'
      + ((FV.frame / total) * 100).toFixed(3) + '%"></div>';

    body(Panel('Session timeline \u00b7 ' + tl.durationSeconds + ' s \u00b7 ' + tl.frames + ' frames',
      '<div class="fv-tl fv-tl--tall">'
      + sourceBand
      + band('Calibration', ['CALIBRATION_VALID', 'CALIBRATION_PROPAGATED', 'CALIBRATION_NONE'])
      + band('Ball', ['BALL_OBSERVED', 'BALL_PROPAGATED', 'BALL_GAP'])
      + marks('Anchors', 'CALIBRATION_ANCHOR', 'anchor')
      + marks('Shot cuts', 'SHOT_BOUNDARY', 'cut')
      + marks('Events', 'EVENT', 'event')
      + '</div>'
      + '<div class="fv-tl-ruler"><span>0 s</span><span>' + (tl.durationSeconds / 2).toFixed(1)
      + ' s</span><span>' + tl.durationSeconds + ' s</span></div>'
      + '<div class="fv-legend">' + Chip('MEASURED', 'READY') + Chip('PROPAGATED', 'DEGRADED')
      + Chip('WITHHELD', 'NOT_AVAILABLE')
      + '<button class="fv-btn" data-fv-seek="' + FV.frame + '" type="button">Open frame '
      + FV.frame + ' in Live Analysis</button></div>', { accent: true })
      + '<div class="fv-row-gap"></div>'
      + Panel('What each band means', '<div class="fv-rows">' + legend + '</div>'));
  }

  // ═══ SOURCES ════════════════════════════════════════════════════════════

  var SLOT_ICON = {
    main: 'camera', 'corner-1': 'camera', 'corner-2': 'camera', 'corner-3': 'camera',
    'corner-4': 'camera', drone: 'drone', 'field-nodes': 'node', 'player-pods': 'pod',
    'ball-sensor': 'sensor',
  };

  function secSources() {
    head('Sources', 'Fourteen source types are named. One is implemented. The difference is drawn '
      + 'rather than hidden, and no future hardware is shown as connected.');
    if (!FV.sources) { body(Empty('withheld', 'READING SOURCES', 'One moment.')); return; }
    if (FV.sources.ok === false) {
      body(Empty('withheld', 'SOURCES UNAVAILABLE', FV.sources.error || ''));
      return;
    }
    var connected = FV.sources.connected || [];

    var live = connected.map(function (c) {
      return '<article class="fv-source fv-source--live">'
        + '<div class="fv-source-top"><span class="fv-source-ico">' + icon('camera') + '</span>'
        + '<div><div class="fv-source-name">' + esc(c.displayName) + '</div>'
        + '<div class="fv-source-type">' + esc(c.sourceType) + ' · session ' + esc(c.sessionRef)
        + '</div></div></div>'
        + '<p class="fv-source-why">' + esc(c.width) + '×' + esc(c.height) + ' · '
        + (c.fps === null ? '—' : c.fps.toFixed(2)) + ' fps · quality '
        + esc(c.qualityBand || 'UNKNOWN') + '</p>'
        + Chip('', 'READY', 'a recorded source this deployment has processed')
        + '</article>';
    }).join('');

    var slots = (FV.sources.slots || []).map(function (s) {
      return '<article class="fv-source fv-source--future">'
        + '<div class="fv-source-top"><span class="fv-source-ico">'
        + icon(SLOT_ICON[s.slot] || 'camera') + '</span>'
        + '<div><div class="fv-source-name">' + esc(s.label) + '</div>'
        + '<div class="fv-source-type">' + esc(s.intendedType) + '</div></div></div>'
        + '<p class="fv-source-why">Declared and empty. Waiting on '
        + esc(s.waitingOn.replace(/_/g, ' ').toLowerCase()) + '.</p>'
        + Chip('', 'NOT_IMPLEMENTED', 'no adapter exists for this slot')
        + '</article>';
    }).join('');

    var types = (FV.sources.types || []).map(function (t) {
      return '<tr><td><b>' + esc(t.label) + '</b><span class="fv-td-sub">' + esc(t.type) + '</span></td>'
        + '<td>' + (t.implemented ? Tag('IMPLEMENTED', 'measured') : Tag('NOT IMPLEMENTED', 'future'))
        + '</td>'
        + '<td>' + (t.waitingOn === 'NOTHING' ? '<span class="fv-none">—</span>'
          : Tag(t.waitingOn.replace(/_/g, ' '), 'future')) + '</td>'
        + '<td>' + esc(t.describes) + '</td></tr>';
    });

    body(Panel('Sources in use', live
      ? '<div class="fv-source-bay">' + live + '</div>'
      : '<p class="fv-metric-k">No source is attached. The sessions in this deployment were '
        + 'produced by the engine from recorded video; a live source would appear here.</p>',
      { accent: true, aside: Tag(connected.length + ' RECORDED', 'measured') })
      + '<div class="fv-row-gap"></div>'
      + Panel('Future rig slots', '<div class="fv-source-bay">' + slots + '</div>'
        + '<p class="fv-note fv-note--warn">Every slot above is empty and every one is drawn as '
        + 'empty. None of this hardware exists, and none of it is shown as connected, degraded or '
        + 'waiting for a signal — those would all imply something is there.</p>',
        { aside: Tag('ALL EMPTY', 'future') })
      + '<div class="fv-row-gap"></div>'
      + Panel('Source type vocabulary',
        Table('Source types and their implementation state',
          ['Type', 'State', 'Waiting on', 'What is actually behind it'], types)
        + '<p class="fv-note fv-note--loud">Camera manufacturer is metadata. Nothing in the Vision '
        + 'engine branches on brand — a Sony body is a video source with Sony on its label, and the '
        + 'day that stops being true is the day Familista Vision becomes a Sony product.</p>'));
  }

  // ═══ SESSIONS ═══════════════════════════════════════════════════════════

  function secSessions() {
    head('Sessions', 'Each row is one processed session. Opening one loads its own evidence; '
      + 'nothing here is aggregated across sessions.');
    if (!FV.sessions) { body(Empty('withheld', 'READING SESSIONS', 'One moment.')); return; }
    if (FV.sessions.ok === false) {
      body(Empty('withheld', 'SESSIONS UNAVAILABLE',
        FV.sessions.reason || FV.sessions.error || 'the session store did not answer'));
      return;
    }
    var all = FV.sessions.sessions;
    if (!all.length) {
      body(Empty('absent', 'NO SESSIONS VISIBLE',
        'This account has access to no Vision session. A session with no declared club is '
        + 'platform-scoped and visible to the platform owner only.', 'sessions'));
      return;
    }
    var f = FV.filters;
    var list = all.filter(function (x) {
      if (f.session && (x.sessionRef + ' ' + x.sessionId).toLowerCase()
        .indexOf(f.session.toLowerCase()) < 0) return false;
      if (f.source && x.source.sourceType !== f.source) return false;
      return true;
    });

    var sourceTypes = {};
    all.forEach(function (x) { sourceTypes[x.source.sourceType] = 1; });

    var filters = '<div class="fv-filters">'
      + '<input class="fv-input" data-fv-filter="session" placeholder="Search session…" value="'
      + esc(f.session) + '" aria-label="Search sessions">'
      + '<span class="fv-filter-label">Source type</span>'
      + '<select class="fv-select" data-fv-filter="source" aria-label="Filter by source type">'
      + '<option value="">All</option>' + Object.keys(sourceTypes).sort().map(function (t) {
        return '<option value="' + esc(t) + '"' + (f.source === t ? ' selected' : '') + '>'
          + esc(t) + '</option>';
      }).join('') + '</select>'
      + '<span class="fv-filter-label">' + list.length + ' of ' + all.length + '</span>'
      + '</div>';

    var cards = list.map(function (x) {
      var open = FV.sessionRef === x.sessionRef;
      var duration = x.source.fps ? (x.framesProcessed / x.source.fps).toFixed(1) + ' s' : '—';
      var evTotal = Object.keys(x.eventCounts).reduce(function (a, k) { return a + x.eventCounts[k]; }, 0);
      return Panel(x.sessionRef,
        '<div class="fv-metric"><span class="fv-metric-v fv-metric-v--sm">'
        + esc(x.source.displayName) + '</span></div>'
        + '<div class="fv-metric-k">' + esc(x.source.width) + '×' + esc(x.source.height) + ' · '
        + n(x.source.fps, 2) + ' fps · ' + duration + ' · quality ' + esc(x.source.qualityBand || '—')
        + '</div>'
        + Rows([
          ['Frames', esc(x.framesProcessed)],
          ['Tracked observations', esc(x.observationsTotal)],
          ['Calibration coverage', pct(x.calibrationCoverage)],
          ['Ball observed coverage', pct(x.ballObservedCoverage)],
          ['Events confirmed', esc(evTotal)],
          ['Pipeline', '<span style="font-size:11px">' + esc(x.pipelineVersion || '—') + '</span>'],
          ['Scope', x.clubId ? esc(x.clubId) : Tag('PLATFORM', 'withheld')],
          ['Generated', '<span style="font-size:11px">' + esc((x.generatedAt || '—').slice(0, 19)) + '</span>'],
        ])
        + '<div class="fv-legend"><button class="fv-btn" data-fv-open-session="' + esc(x.sessionRef)
        + '" type="button" aria-pressed="' + open + '">'
        + (open ? 'Open — currently loaded' : 'Open session') + '</button></div>',
        { accent: open, aside: Chip('', open ? 'LIVE' : 'READY') });
    }).join('');

    body(filters + (cards ? '<div class="fv-grid fv-grid--wide">' + cards + '</div>'
      : Empty('absent', 'NO SESSION MATCHES THESE FILTERS',
        'Widen the search or the source-type filter.', 'sessions'))
      + '<p class="fv-note">A session with no declared club is platform-scoped: the platform owner '
      + 'sees it and nobody else does. Ownership is declared beside the evidence, never guessed '
      + 'from a filename.</p>');
  }

  // ═══ REPORTS ════════════════════════════════════════════════════════════

  function secReports() {
    head('Reports & Export', 'Every export carries the provenance needed to re-derive it. No '
      + 'filesystem path leaves the server.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session.summary;
    var kinds = [
      ['session', 'Session JSON', 'the whole normalised session', 'JSON'],
      ['summary', 'Session summary', 'counts, coverage, providers and guards', 'JSON'],
      ['tracks', 'Tracking export', 'every observation with its calibration state', 'JSON'],
      ['ball', 'Ball export', 'every sample with OBSERVED/PROPAGATED preserved', 'JSON'],
      ['events', 'Events export', 'confirmed findings only', 'JSON'],
      ['calibration', 'Calibration export', 'per-frame verdicts and accepted anchors', 'JSON'],
      ['evidence', 'Evidence references', 'what Familista Intelligence may consume', 'JSON'],
      ['tracks-csv', 'Tracking CSV', 'withheld coordinates are empty cells, never zeros', 'CSV'],
    ];
    var cards = kinds.map(function (k) {
      return '<article class="fv-source">'
        + '<div class="fv-source-top"><span class="fv-source-ico">' + icon('reports') + '</span>'
        + '<div><div class="fv-source-name">' + esc(k[1]) + '</div>'
        + '<div class="fv-source-type">' + esc(k[3]) + '</div></div></div>'
        + '<p class="fv-source-why">' + esc(k[2]) + '</p>'
        + '<a class="fv-btn" href="' + API + '/sessions/' + encodeURIComponent(s.sessionRef)
        + '/export?kind=' + encodeURIComponent(k[0]) + '" download>Download</a>'
        + '</article>';
    }).join('');

    body('<div class="fv-grid fv-grid--wide">' + cards + '</div><div class="fv-row-gap"></div>'
      + '<div class="fv-split--even fv-split">'
      + Panel('Provenance carried in every export', Rows([
        ['Session id', '<span style="font-size:11px">' + esc(s.sessionId) + '</span>'],
        ['Session ref', esc(s.sessionRef)],
        ['Source', esc(s.source.displayName)],
        ['Source SHA-256', '<span style="font-size:10.5px">' + esc((s.source.sha256 || '—').slice(0, 40))
          + '…</span>'],
        ['Pipeline version', esc(s.pipelineVersion || '—')],
        ['Generated', esc(s.generatedAt || '—')],
        ['Processing target', esc(s.processingTarget)],
        ['Device', esc(s.deviceId)],
        ['Club scope', s.clubId ? esc(s.clubId) : Tag('PLATFORM', 'withheld')],
      ]), { accent: true })
      + Panel('Model provenance', '<div class="fv-rows">' + s.models.map(function (m) {
        return '<div class="fv-row"><span class="fv-row-k">' + esc(m.modelId)
          + '<span class="fv-row-sub">' + esc((m.checksumSha256 || 'no checksum').slice(0, 24))
          + '…</span></span>' + Tag(m.commercialUse, m.commercialUse === 'VERIFIED' ? 'measured'
            : m.commercialUse === 'UNKNOWN' ? 'unverified' : 'restricted') + '</div>';
      }).join('') + '</div>'
        + '<p class="fv-note">A source is identified by its file NAME and its hash. An API that '
        + 'handed a client an absolute path would have told an attacker the shape of the server and '
        + 'told an honest reader nothing they can use.</p>')
      + '</div>');
  }

  // ═══ DEVICE ═════════════════════════════════════════════════════════════

  function secDevice() {
    head('Device / Vision Hub', 'What is actually running Vision. Readings this host does not '
      + 'have say so, rather than showing a zero a dashboard would draw as a value.');
    if (!FV.device) { body(Empty('withheld', 'READING DEVICE', 'One moment.')); return; }
    if (FV.device.ok === false) {
      body(Empty('withheld', 'DEVICE UNAVAILABLE', FV.device.error || ''));
      return;
    }
    var d = FV.device.device, t = FV.device.telemetry;
    var h = FV.status && FV.status.health;
    var gb = function (v) { return v ? (v / 1073741824).toFixed(1) : null; };

    // A CONSOLE, NOT A CARD WALL.
    //
    // This screen was fifteen equal panels in a wrapping grid, and four of
    // them read "—" because this host has no GPU, no thermometer, no battery
    // and no camera link. Fifteen equal boxes make an absence look like a
    // failure and a reading look like a footnote. A console separates the
    // three things that are actually different here: WHAT THIS IS, WHAT IT
    // MEASURES, and WHAT IT DOES NOT HAVE.
    function reading(label, value, unit, sub, bar) {
      return Dial(value + (unit ? '<small> ' + esc(unit) + '</small>' : ''), label, sub, bar);
    }
    function absentRow(label, spec, what) {
      var st = (spec && spec.status) || 'NOT_AVAILABLE';
      return '<div class="fv-await"><span class="fv-await-k">' + esc(label) + '</span>'
        + '<span class="fv-await-v fv-none">—</span>'
        + '<span class="fv-await-s">' + esc((spec && spec.reason) || what || 'not measured') + '</span>'
        + Chip('', st) + '</div>';
    }

    // ── the faceplate ───────────────────────────────────────────────────────
    var faceplate = '<section class="fv-instr">'
      + '<div class="fv-instr-lead">'
      + '<div class="fv-instr-k">Device ' + Tag(d.processingTarget.replace(/_/g, ' '), 'accent')
      + ' ' + Chip('', d.status) + '</div>'
      + '<div class="fv-instr-v">' + esc(d.label) + '</div>'
      + '<p class="fv-instr-s"><code>' + esc(d.deviceId) + '</code> · '
      + esc(d.reason || 'the engine answered') + '</p>'
      + '</div></section>';

    // ── what it measures ────────────────────────────────────────────────────
    var dials = [];
    if (t && !t.status) {
      // `cpuCores` — the name the engine contract publishes. Read as `cpuCount`
      // this dial rendered its unit and its caption with no figure between
      // them, which is the one thing an em dash is for and this was not one:
      // the host does report its core count.
      dials.push(reading('CPU', n(t.cpuCores, 0), 'cores', 'load average 1m ' + n(t.loadAverage1m, 2)));
      dials.push(reading('Memory', n(gb(t.memoryTotalBytes), 1), 'GB',
        gb(t.memoryFreeBytes) + ' GB free',
        t.memoryTotalBytes ? 1 - (t.memoryFreeBytes / t.memoryTotalBytes) : null));
      if (t.storageTotalBytes) {
        dials.push(reading('Storage', n(gb(t.storageTotalBytes), 1), 'GB',
          gb(t.storageFreeBytes) + ' GB free', 1 - (t.storageFreeBytes / t.storageTotalBytes)));
      }
      dials.push(reading('Uptime', n(Math.round((t.uptimeSeconds || 0) / 3600)), 'h', 'host uptime'));
    }
    dials.push(reading('Processing', FV.session ? n(FV.session.summary.processingFps, 2)
      : '<span class="fv-none">—</span>', FV.session ? 'fps' : '',
      FV.session ? 'measured on ' + FV.session.summary.sessionRef : 'no session open'));

    var measured = (t && t.status)
      ? Panel('Host telemetry', '<div class="fv-awaits">'
        + absentRow('Host telemetry', t, t.reason) + '</div>')
      : Panel('Measured on this host', '<div class="fv-instr-dials">' + dials.join('') + '</div>');

    // ── what it does not have ───────────────────────────────────────────────
    var absences = (t && !t.status)
      ? Panel('Not present on this host', '<div class="fv-awaits">'
        + absentRow('GPU', t.gpu) + absentRow('Temperature', t.temperatureCelsius)
        + absentRow('Battery', t.batteryPercent) + absentRow('Camera link', t.cameraLink)
        + '</div>'
        + '<p class="fv-note">These are absences, not failures. A software device on a server has '
        + 'no battery and no camera link, and drawing a zero for either would be a reading this '
        + 'host never took.</p>', { aside: Tag('NOT MEASURED', 'withheld') })
      : '';

    // ── what it is attached to ──────────────────────────────────────────────
    var links = h ? Panel('Attached to', '<div class="fv-hgrid">'
      + [['API', esc(h.eventTypes) + ' Vision event types registered'],
         ['Network', 'the platform served this request'],
         ['Source Core link', 'registered on the Fabric source registry'],
         ['Data Vault link', 'session facts persist as platform events']]
        .map(function (r) {
          return '<div class="fv-hcell fv-s-LIVE" title="' + esc(r[1]) + '">'
            + '<i class="fv-dot" aria-hidden="true"></i>'
            + '<span class="fv-hcell-k">' + esc(r[0]) + '</span>'
            + '<span class="fv-hcell-v">LIVE</span></div>';
        }).join('') + '</div>') : '';

    var loaded = Panel('Loaded now', Rows([
      ['Active session', FV.session ? '<b>' + esc(FV.session.summary.sessionRef) + '</b>'
        : '<span class="fv-none">—</span>',
        FV.session ? FV.session.summary.framesProcessed + ' frames' : 'no session open'],
      ['Active source', FV.session ? esc(FV.session.summary.source.displayName)
        : '<span class="fv-none">—</span>',
        FV.session ? FV.session.summary.source.sourceType : 'no source attached'],
      ['Vision engine', Chip('', d.status)],
    ]));

    body(faceplate + '<div class="fv-row-gap"></div>'
      + '<div class="fv-zone3">' + measured + '<div class="fv-stack">' + loaded + links + '</div></div>'
      + (absences ? '<div class="fv-row-gap"></div>' + absences : '')
      + '<div class="fv-row-gap"></div>'
      + Panel('Future hardware target', Rows([
        ['FAMILISTA VISION HUB', Chip('', 'NOT_IMPLEMENTED')],
        ['Current processing target', esc(d.processingTarget)],
        ['Adapter', 'addressable today; refuses every call'],
      ]) + '<p class="fv-note fv-note--loud">Selecting the VISION_HUB target today runs the entire '
        + 'platform against an adapter that refuses every call and says why. Nothing about the '
        + 'device is simulated — no invented temperature, no invented battery, no invented fan '
        + 'speed, no invented sensor count. When the hardware exists, one adapter changes and this '
        + 'screen does not.</p>', { aside: Tag('ARCHITECTURE TARGET', 'future') }));
  }

  // ═══ MODELS & PROVIDERS ═════════════════════════════════════════════════

  function secModels() {
    head('Models & Providers', 'From the Model Registry that travelled with the result. No model '
      + 'path is written in this frontend.');
    if (!FV.models) { body(Empty('withheld', 'READING MODELS', 'One moment.')); return; }
    if (FV.models.ok === false) {
      body(Empty('withheld', 'MODELS UNAVAILABLE', FV.models.error || ''));
      return;
    }
    if (!FV.models.models.length) {
      body(Empty('absent', 'NO MODELS RECORDED',
        'No session visible to this account carries model provenance.', 'models'));
      return;
    }

    var counts = { VERIFIED: 0, RESTRICTED: 0, UNKNOWN: 0 };
    FV.models.models.forEach(function (m) {
      counts[m.commercialUse] = (counts[m.commercialUse] || 0) + 1;
    });

    var verdicts = '<div class="fv-grid">'
      + Panel('Cleared for commercial use', Metric(esc(counts.VERIFIED || 0), 'models',
        'licence read, and it permits proprietary use'), { aside: Tag('VERIFIED', 'measured') })
      + Panel('Restricted', Metric(esc(counts.RESTRICTED || 0), 'models',
        'licence read, and it does not permit it without further action'),
        { aside: Tag('RESTRICTED', 'restricted') })
      + Panel('Unknown', Metric(esc(counts.UNKNOWN || 0), 'models',
        'nobody has checked. Not a milder restriction — an unpriced one'),
        { aside: Tag('UNKNOWN', 'unverified') })
      + '</div>';

    var provs = FV.models.providers.map(function (p) {
      return '<article class="fv-source">'
        + '<div class="fv-source-top"><span class="fv-source-ico">' + icon('models') + '</span>'
        + '<div><div class="fv-source-name">' + esc(p.role.replace(/_/g, ' ')) + '</div>'
        + '<div class="fv-source-type">' + esc(p.provider) + '</div></div></div>'
        + '<p class="fv-source-why">' + esc(p.modelIds.join(', ')) + '</p>'
        + (p.fusesDetectionAndTracking ? Tag('FUSES DETECTION + TRACKING', 'withheld')
          : Chip('', 'READY'))
        + '</article>';
    }).join('');

    var rows = FV.models.models.map(function (m) {
      var kind = m.commercialUse === 'VERIFIED' ? 'measured'
        : m.commercialUse === 'UNKNOWN' ? 'unverified' : 'restricted';
      return '<tr><td><b>' + esc(m.modelId) + '</b><span class="fv-td-sub">'
        + esc(m.name || '') + '</span></td>'
        + '<td>' + esc(m.task || '—') + '</td>'
        + '<td>' + esc(m.version || '—') + '</td>'
        + '<td>' + esc(m.framework || '—') + '</td>'
        + '<td><span style="font-size:10.5px">' + esc(m.weights || '—') + '</span></td>'
        + '<td><span style="font-size:10.5px">' + esc((m.checksumSha256 || '—').slice(0, 16))
        + '…</span></td>'
        + '<td><span style="font-size:11px">sw ' + esc(m.licenceSoftware || '—')
        + '<br>weights ' + esc(m.licenceWeights || '—') + '</span></td>'
        + '<td>' + Tag(m.commercialUse, kind) + '<span class="fv-td-sub">'
        + esc(m.licenceVerification || '') + '</span></td>'
        + '<td>' + Chip('', 'READY', 'this model produced a result in this deployment') + '</td></tr>';
    });

    body(verdicts + '<div class="fv-row-gap"></div>'
      + Panel('Providers by role', '<div class="fv-grid fv-grid--wide">' + provs + '</div>'
        + '<p class="fv-note">A role names what fills it. Swapping a model is configuration; '
        + 'nothing in this frontend names a checkpoint file.</p>', { accent: true })
      + '<div class="fv-row-gap"></div>'
      + Panel('Models', Table('Model registry entries behind these results',
        ['Model', 'Task', 'Version', 'Framework', 'Weights', 'Checksum', 'Licence',
          'Commercial use', 'State'], rows)
        + '<p class="fv-note fv-note--warn">UNKNOWN is not a milder RESTRICTED. RESTRICTED means '
        + 'the terms were read and they say no — that cost is known and can be budgeted. UNKNOWN '
        + 'means nobody has checked, which reads like the absence of a problem and is not.</p>'));
  }

  // ═══ INTEGRATIONS ═══════════════════════════════════════════════════════

  function secIntegrations() {
    head('Integrations / Data Flow', 'Where Vision sits in the Familista nervous system, and what '
      + 'it publishes. Select a node to read its connection metadata.');
    if (!FV.integrations) { body(Empty('withheld', 'READING INTEGRATIONS', 'One moment.')); return; }
    if (FV.integrations.ok === false) {
      body(Empty('withheld', 'INTEGRATIONS UNAVAILABLE', FV.integrations.error || ''));
      return;
    }
    var h = FV.status && FV.status.health;
    var byKey = {};
    if (h) h.capabilities.forEach(function (c) { byKey[c.key] = c; });

    var NODE_DETAIL = {
      SOURCE: function () {
        return Rows([
          ['Implemented source types', h ? esc(h.sources.implementedTypes) + ' of '
            + esc(h.sources.declaredTypes) : '—'],
          ['Future rig slots', h ? esc(h.sources.slots) + ', all empty' : '—'],
          ['Connected now', esc((FV.sources && FV.sources.connected || []).length) + ' recorded'],
        ]);
      },
      SOURCE_CORE: function () {
        return Rows([
          ['Fabric source id', '<code>vision</code>'],
          ['Event domain', '<code>vision</code>'],
          ['Registration', 'composed by Source Core from the Fabric registry — no entry of its own'],
        ]) + '<p class="fv-note">A second description of Vision on a Source Core screen would be a '
          + 'second opinion, and the day it disagreed with this one somebody would trust the wrong '
          + 'one.</p>';
      },
      VISION: function () {
        return Rows([
          ['Sessions addressable', h && h.sessions.stored !== null ? esc(h.sessions.stored) : '—'],
          ['Processing target', h ? esc(h.processingTarget) : '—'],
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
        ]) + '<p class="fv-note">A `vision_session` table would have been a second history beside '
          + 'the Vault and a second original beside the engine\'s.</p>';
      },
      INTELLIGENCE: function () {
        return Rows([
          ['Interface', '<code>GET /sessions/:id/evidence</code>'],
          ['Carries', 'metric positions with error bars, and confirmed findings'],
          ['Does not carry', Tag('ANY RATING', 'future')],
        ]) + '<p class="fv-note fv-note--loud">There is no field for Quality, Vision, Decisions, '
          + 'Composure, Passing, Finishing, Stamina or any mental attribute. An interface with a '
          + 'field for something nobody measures is an invitation to fill it.</p>';
      },
      CONSUMERS: function () {
        return Rows([
          ['Clubs · Match Center · Video Intelligence', Tag('AUTHORISED READ', 'measured')],
          ['Training · Academy', Tag('AUTHORISED READ', 'measured')],
          ['Unvalidated metrics injected into players', Tag('NONE', 'withheld')],
        ]);
      },
    };

    // A GRAPH, NOT A LIST, AND THE DETAIL DOES NOT MOVE IT.
    //
    // The stages used to stack vertically and open INLINE, which pushed every
    // node below the one selected — the reader's own diagram rearranged itself
    // under them each time they asked a question of it. Here the stages are
    // laid out as a graph, the conduits run between them, and the answer opens
    // in the rail beside it. Nothing on the graph moves when a node is chosen
    // except the node's own outline.
    var selNode = null;
    var flow = FV.integrations.flow.map(function (f, i) {
      var open = FV.selection.node === f.stage;
      if (open) selNode = f;
      var conduit = i ? '<div class="fv-conduit' + (f.status === 'LIVE' ? ' fv-conduit--live' : '')
        + '" aria-hidden="true"></div>' : '';
      return conduit
        + '<button class="fv-flow-node" data-fv-node="' + esc(f.stage) + '" type="button" '
        + 'aria-pressed="' + open + '">'
        + '<span class="fv-flow-top">'
        + '<span class="fv-flow-stage">' + esc(f.stage.replace(/_/g, ' ')) + '</span>'
        + Chip('', f.status === 'LIVE' ? 'LIVE' : 'READY') + '</span>'
        + '<span class="fv-flow-name">' + esc(f.node) + '</span>'
        + '<span class="fv-flow-detail">' + esc(f.detail) + '</span>'
        + '</button>';
    }).join('');

    var nodePanel = selNode && NODE_DETAIL[selNode.stage]
      ? Panel(selNode.node, NODE_DETAIL[selNode.stage](),
        { accent: true, aside: Chip('', selNode.status === 'LIVE' ? 'LIVE' : 'READY') })
      : Panel('No node selected',
        '<p class="fv-metric-k">Choose a stage in the graph to read its connection metadata — '
        + 'what it registers, what it carries, and what it deliberately does not.</p>');

    var monitor = byKey.infrastructure
      ? Panel('Infrastructure City — monitoring', Rows([
        ['Vision health signal', Chip('', byKey.infrastructure.status)],
        ['How', 'joined by healthKey, like every other component'],
      ]) + '<p class="fv-note">Vision does not get a second monitoring surface. It gets a district '
        + 'in the one the platform already has, so an operator sees a Vision problem beside a '
        + 'database problem rather than having to know Vision exists and go and look.</p>',
        { aside: Tag('MONITORING', 'derived') })
      : '';

    var events = FV.integrations.events.map(function (e) {
      return '<tr><td><code style="font-size:11px;color:var(--fv-tx)">' + esc(e.type) + '</code></td>'
        + '<td>v' + esc(e.schemaVersion) + '</td>'
        + '<td>' + (e.live ? Tag('LIVE VIEW', 'measured') : Tag('DURABLE ONLY', 'withheld')) + '</td>'
        + '<td>' + esc(e.describes) + '</td></tr>';
    });

    body('<div class="fv-live">'
      + Panel('Nervous system', '<div class="fv-flow fv-flow--graph">' + flow + '</div>'
        + '<p class="fv-note">A conduit travels only where the link is LIVE. A diagram that flows '
        + 'while the platform is silent is a diagram telling a lie.</p>', { accent: true })
      + '<div class="fv-stack">' + nodePanel + monitor + '</div>'
      + '</div><div class="fv-row-gap"></div>'
      + Panel('Vision events on the platform transport',
        Table('Registered Vision event types',
          ['Event type', 'Schema', 'Live board', 'What it says has happened'], events)
        + '<p class="fv-note">There is no Vision event bus. These names are registered on the '
        + 'Fabric\'s own registry, travel through the same outbox, and land in the same Data Vault '
        + 'as every other domain\'s facts. The three per-observation names are withheld from the '
        + 'LIVE board and remain fully durable — a ten-second clip holds four thousand '
        + 'observations, and putting them on a shared firehose would drown every other domain.</p>'));
  }

  // ═══ ROUTER & BOOT ══════════════════════════════════════════════════════

  var ROUTES = {
    overview: secOverview, live: secLive, sources: secSources, sessions: secSessions,
    tracking: secTracking, ball: secBall, calibration: secCalibration, teams: secTeams,
    events: secEvents, tactical: secTactical, heatmaps: secHeatmaps, physical: secPhysical,
    timeline: secTimeline, reports: secReports, device: secDevice, models: secModels,
    integrations: secIntegrations,
  };

  function renderSection() {
    var r = ROUTES[FV.section];
    if (r) r();
  }

  function openSession(ref) {
    FV.sessionRef = ref;
    FV.session = null; FV.timeline = null; FV.frame = 0;
    FV.selection.track = null; FV.selection.event = null;
    renderSection();
    Promise.all([
      get('/sessions/' + encodeURIComponent(ref)),
      get('/sessions/' + encodeURIComponent(ref) + '/timeline'),
    ]).then(function (r) {
      FV.session = r[0] && r[0].ok ? r[0].session : null;
      FV.timeline = r[1] && r[1].ok ? r[1].timeline : null;
      if (FV.session && FV.session.tracks.length) FV.frame = FV.session.tracks[0].frameNumber;
      // The bar and the open panel are the two regions a new session changes.
      // Rebuilding the whole shell repainted the navigation as well, which
      // dropped the reader's place in it for no reason.
      refreshBar();
      renderSection();
    });
  }

  function boot() {
    var root = document.getElementById('fv-root');
    if (!root) return;
    renderShell();
    Promise.all([
      get('/status'), get('/sessions'), get('/sources'), get('/models'),
      get('/device'), get('/integrations'),
    ]).then(function (r) {
      FV.status = r[0]; FV.sessions = r[1]; FV.sources = r[2];
      FV.models = r[3]; FV.device = r[4]; FV.integrations = r[5];
      renderShell();
      // Open the newest session automatically: a command centre that opens
      // empty when evidence exists is a command centre making the reader work.
      if (FV.sessions && FV.sessions.ok && FV.sessions.sessions.length) {
        openSession(FV.sessions.sessions[0].sessionRef);
      }
    });
  }

  // The platform mounts a module by calling its render hook with its host
  // element, exactly as it does for Source Core, the Vault and the City. There
  // is no second convention here.
  //
  // BOTH CALLERS, NOT ONE. The navigation switch passes the root element; the
  // page-render registry (`_FAM_PAGE_RENDER` → `_famRenderPage`) calls every
  // renderer with NO argument at all, and that second one is the path a
  // navigation from Owner Home actually takes. Guarding on `host` meant the
  // page mounted its empty `#fv-root` and stopped there — the module was
  // wired, allow-listed, styled and reachable, and opened to a blank screen.
  // Source Core solved this the same way, and its comment says why.
  window.renderFamilistaVision = function (host) {
    host = host || document.getElementById('fv-root');
    if (!host) return;
    boot();
  };
  window.mountFamilistaVision = boot;
  window.teardownFamilistaVision = function () {
    FV.session = null; FV.timeline = null; FV.sessionRef = null;
    FV.selection.track = null; FV.selection.event = null; FV.selection.node = null;
  };
})();
