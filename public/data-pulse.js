// Familista — Live Data Flow, the platform owner's operations cockpit
// ─────────────────────────────────────────────────────────────────────────────
// One screen that answers three questions at a glance: what is moving through
// the platform right now, what architecture it moves through, and where in the
// world it came from. Sources on the left, the Familista Data Fabric and the
// services around it in the middle, destinations on the right, and beneath them
// the event stream, the timeline and the global map.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP
//
// Nothing on this screen is invented. There is no particle loop, no decorative
// animation, no throughput this process did not observe and no destination that
// is not either genuinely consuming events or clearly marked FUTURE. Every dot
// is one event the server observed; when nothing is happening the screen says
// so and stays still. A visualiser that looks busy when the platform is idle is
// worse than no visualiser, because it cannot be used to answer the only
// question it is for.
//
// That rule is why a figure is either a measurement or an em dash. A trend
// arrow is the difference between two samples this panel actually received, a
// lane's rate is the events counted on that lane inside the chosen window, and
// the ecosystem card counts clubs, countries and people by reading them. Where
// nothing measures a number — processed, failed and pending have no consumer
// yet — the tile says so in words instead of showing a zero.
//
// HOW IT STREAMS
//
// `fetch` with a reader rather than `EventSource`, exactly as owner-trace does
// it: `EventSource` cannot set headers, so it would force the token into a
// query string where every proxy writes it to a log.
//
// HOW IT STAYS CHEAP
//
// The server batches frames on a tick and samples a burst, so this file
// receives at most a few frames per animation window. Live dots are capped
// independently of that, and a dot removes itself when its animation ends —
// nothing accumulates. Each region repaints its own slot: a metric tick redraws
// eleven numbers rather than the board, and the board is rebuilt only when the
// topology changes. There is no timer in this file; the only repeating work is
// a requestAnimationFrame loop that exists solely while replay is playing.
//
// NOTHING MOVES THAT THE READER DID NOT MOVE
//
// Dots are absolutely positioned inside a stage that is `pointer-events: none`
// and animate on `offset-distance` and `opacity` only, so a pulse cannot shift
// a single pixel of the panel underneath it. Every region is a fixed-height box
// that scrolls inside itself with a stable gutter, and the inspector and the
// storage panel are fixed overlays for the same reason.

(function () {
  'use strict';

  var API = function () { return window.FamilistaAPI; };
  function esc(s) {
    return (typeof window._esc === 'function') ? window._esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }

  /** Everything this panel knows. One object, so a reconnect can reset it. */
  var DP = {
    open: false,
    connected: false,
    mode: 'LIVE',
    topology: null,
    metrics: null,
    limits: null,
    frames: [],        // newest first, bounded
    sampling: 1,
    lastError: null,
    // A refusal, as opposed to a network wobble. 401 and 403 do not fix
    // themselves, so retrying them forever just hides them behind
    // "Reconnecting…" — the exact failure that made this panel look idle
    // when it was actually unauthorised.
    fatal: false,
    /** One refresh per connection attempt, so an expired token cannot loop. */
    refreshed: false,
    reconnectAttempt: 0,
    inspecting: null,
    /**
     * The last outbox position this browser has rendered, as `<iso>|<id>`.
     *
     * Sent on reconnect so the tail resumes exactly there: no gap, and no
     * repeat of anything already on screen. Non-secret — a timestamp and a row
     * id — and never a credential.
     */
    cursor: null,
    /** The telemetry tail's own position. Two streams, two cursors. */
    uiCursor: null,
    /** Counted from telemetry, so they are null until the server says. */
    active: { activeUsers: null, activeSessions: null },
    /** Which categories the feed shows. Empty means all of them. */
    filter: '',
    /** Which lane the feed shows, as `source:Players`. Empty means all. */
    lane: '',
    replay: { minutes: 5, loading: false, counts: null, truncated: false },
    /**
     * Where Familista actually is: clubs, countries, continents and people,
     * every one of them a count over a real table. Null until the read lands,
     * and left null when it fails rather than filled with something friendlier.
     */
    eco: null,
    ecoError: null,
    /**
     * Metric samples this panel has received, newest last. The only source of a
     * trend arrow — a difference between two measurements, never a guess.
     */
    history: [],
    /** Replay playback. `at` is 0..1 across the loaded window. */
    play: { on: false, at: 1, speed: 1 },
    storage: false,
  };
  window._DP = DP;

  var FRAME_LIMIT = 200;     // what the inspector list can hold
  var DOT_LIMIT = 24;        // what may be in flight on screen at once
  var HISTORY_LIMIT = 240;   // four minutes of one-second metric samples
  var TREND_LAG_MS = 60000;  // a trend compares now against one minute ago
  var abort = null;
  var reconnectTimer = null;
  var playFrame = null;
  /** eventIds already rendered, and their arrival order so the set can be trimmed. */
  var seen = Object.create(null);
  var seenOrder = [];

  // ── the lanes ──────────────────────────────────────────────────────────────

  /**
   * The coarse kind a reader filters by.
   *
   * Domain events are DOMAIN; telemetry arrives already namespaced `ui.*` and
   * carries its own category in the name. Nine words a person can hold in
   * their head, against forty event names they cannot.
   */
  // The eight telemetry words, spelled exactly as the server spells them in
  // `telemetry-tail.service.ts`. Two derivations of one concept are tolerable —
  // the client must filter without a round trip — but two VOCABULARIES are not,
  // so a test pins this list against that one.
  //
  // UI is a surface changing; ACTION is somebody doing something. That is the
  // whole of the distinction, and it is the one an owner actually filters on.
  var UI_SURFACE = {
    tab_changed: 1, panel_opened: 1, panel_closed: 1, modal_opened: 1, modal_closed: 1,
    menu_opened: 1, player_card_opened: 1, match_card_opened: 1, form_started: 1,
  };

  /**
   * The filter chips, as a token and the word a reader sees.
   *
   * Written out rather than derived from the token: lower-casing `UI` produces
   * "Ui", and an interface that mangles its own vocabulary to save four lines
   * is not worth the four lines.
   */
  var CATEGORIES = [
    ['', 'All'], ['DOMAIN', 'Domain'], ['AUTH', 'Auth'], ['NAV', 'Navigation'],
    ['UI', 'Interface'], ['ACTION', 'Action'], ['POINTER', 'Pointer'],
    ['SCROLL', 'Scroll'], ['HOVER', 'Hover'], ['SYSTEM', 'System'],
  ];

  function categoryOf(f) {
    var t = String((f && f.eventType) || '');
    if (t.indexOf('ui.') !== 0) return 'DOMAIN';
    var n = t.slice(3);
    if (n === 'pointer_active') return 'POINTER';
    if (n === 'scroll_depth') return 'SCROLL';
    if (n === 'region_dwell') return 'HOVER';
    if (/^(login|logout|session)/.test(n)) return 'AUTH';
    if (/^(route|workspace|club_|team_|page_|module_)/.test(n)) return 'NAV';
    if (/^(api_error|client_error|reconnected|offline)/.test(n)) return 'SYSTEM';
    if (UI_SURFACE[n]) return 'UI';
    return 'ACTION';
  }

  /** The module/feature keys the server packed into `changedFields`. */
  function ctx(f, key) {
    var list = (f && f.changedFields) || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).indexOf(key + ':') === 0) return String(list[i]).slice(key.length + 1);
    }
    return null;
  }

  function laneId(kind, name) {
    var k = kind === 'source' ? 'src' : kind === 'dest' ? 'dst' : kind;
    return 'dp-' + k + '-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  // ── the icon set ───────────────────────────────────────────────────────────
  //
  // Drawn from `public/system/system-icons.js`, which the rail and the top bar
  // draw from too. There is one icon set in SYSTEM and this panel does not get
  // a second: an icon that means "governance" in the navigation must mean
  // governance on the board.

  function icon(name, cls) {
    try {
      if (typeof window.syIcon === 'function') return window.syIcon(name, 'sy-dp-i' + (cls ? ' ' + cls : ''));
    } catch (_) { /* the set is optional; a labelled panel still reads */ }
    return '';
  }

  /** The lane a source or destination pad draws its icon from. */
  var LANE_ICON = {
    Clubs: 'clubs', Users: 'users', Players: 'players', Training: 'training',
    Matches: 'matches', Transfers: 'transfers', Medical: 'medical', Media: 'media',
    AI: 'ai', System: 'system',
    'Operational Data': 'database', Audit: 'audit', Analytics: 'analytics',
    'ML Pipeline': 'pipeline', 'Feature Store': 'layers', 'Data Lake': 'database',
    Cameras: 'media', GPS: 'gps', Edge: 'edge',
  };

  // ── numbers, and the absence of them ───────────────────────────────────────

  /**
   * A metric cell's value.
   *
   * `null` is NOT zero. The server sends null for anything it cannot compute,
   * and this renders those words rather than a number nobody measured.
   */
  function num(v) {
    return (v === null || v === undefined) ? null : Number(v).toLocaleString();
  }

  /** 12428 → "12.4K". The exact figure travels in the tile's title attribute. */
  function compact(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e4) return Math.round(n / 1e3) + 'K';
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function clockOf(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (!t || isNaN(t)) return null;
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 2) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }

  /**
   * The trend chip, and the only thing that may produce one.
   *
   * Two samples this panel received, a minute apart, compared. No sample that
   * old, or a zero to divide by, means no chip at all — an arrow that cannot be
   * computed is simply absent rather than drawn flat.
   */
  function trendHtml(key) {
    var h = DP.history;
    if (h.length < 2) return '';
    var now = h[h.length - 1];
    var cur = now[key];
    if (cur === null || cur === undefined) return '';
    var want = now.t - TREND_LAG_MS;
    var past = null;
    for (var i = 0; i < h.length; i++) {
      if (h[i].t <= want) past = h[i]; else break;
    }
    if (!past) past = (now.t - h[0].t >= 20000) ? h[0] : null;
    if (!past) return '';
    var before = past[key];
    if (before === null || before === undefined || before === 0) return '';
    var pct = Math.round(((cur - before) / before) * 100);
    if (pct === 0) return '';
    var dir = pct > 0 ? 'up' : 'down';
    var arrow = pct > 0 ? '↑' : '↓';
    return '<em class="sy-dp-trend sy-dp-trend--' + dir + '" title="against the same figure one minute ago"'
      + ' data-no-i18n>' + arrow + ' ' + Math.abs(pct) + '%</em>';
  }

  function rememberMetrics(m) {
    if (!m) return;
    DP.history.push({
      t: Date.now(),
      eventsPerSecond: m.eventsPerSecond,
      eventsPerMinute: m.eventsPerMinute,
      activeClubs: m.activeClubs,
      totalObserved: m.totalObserved,
      averageLatencyMs: m.averageLatencyMs,
      activeUsers: DP.active ? DP.active.activeUsers : null,
      activeSessions: DP.active ? DP.active.activeSessions : null,
    });
    while (DP.history.length > HISTORY_LIMIT) DP.history.shift();
  }

  // ── the window every rate and every bar is counted inside ──────────────────

  function windowMs() {
    return Math.max(1, DP.replay.minutes) * 60000;
  }

  /** Frames inside the chosen window, newest first. The basis of every rate. */
  function framesInWindow() {
    var floor = Date.now() - windowMs();
    var out = [];
    for (var i = 0; i < DP.frames.length; i++) {
      var t = new Date(DP.frames[i].recordedAt).getTime();
      if (!t || isNaN(t)) continue;
      if (DP.mode === 'LIVE' && t < floor) break;
      out.push(DP.frames[i]);
    }
    return out;
  }

  /**
   * Events per minute on every lane, counted in one pass.
   *
   * One pass rather than one per pad: the rates are rewritten on every metrics
   * tick, and walking the buffer twenty-eight times a second to answer twenty-
   * eight questions about the same rows is the kind of cost that makes a
   * monitor more expensive than the thing it monitors.
   */
  function laneRates() {
    var rows = framesInWindow();
    var per = Math.max(1, DP.replay.minutes);
    var src = Object.create(null);
    var dst = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      src[rows[i].source] = (src[rows[i].source] || 0) + 1;
      dst[rows[i].destination] = (dst[rows[i].destination] || 0) + 1;
    }
    return {
      source: function (name) { return (src[name] || 0) / per; },
      dest: function (name) { return (dst[name] || 0) / per; },
    };
  }

  function rateLabel(perMinute) {
    if (perMinute >= 1) return esc(compact(Math.round(perMinute)) + '/min');
    // Escaped, because "less than" is a character the markup owns.
    return perMinute > 0 ? '&lt;1/min' : '0/min';
  }

  // ── the page header ────────────────────────────────────────────────────────

  function statusHtml() {
    var cls = DP.connected ? 'sy-dp-live' : (DP.lastError ? 'sy-dp-down' : 'sy-dp-connecting');
    var text = DP.connected ? 'Live' : (DP.lastError ? 'Reconnecting…' : 'Connecting…');
    // 401 and 403 are different problems and the difference is what tells the
    // owner whether to sign in again or to check their platform authority.
    if (!DP.connected && DP.fatalStatus === 401) text = 'Not signed in';
    else if (!DP.connected && DP.fatalStatus === 403) text = 'Not authorised';
    if (DP.mode === 'REPLAY') { cls = 'sy-dp-replaying'; text = 'Replay'; }
    // The status itself, verbatim, next to the label. "Reconnecting…" with no
    // number is what let a 404 masquerade as an idle platform for a whole
    // production test; the code is what makes the difference visible.
    var detail = (!DP.connected && DP.lastError && DP.mode === 'LIVE')
      ? '<em class="sy-dp-status-detail" data-no-i18n>' + esc(DP.lastError) + '</em>' : '';
    return '<span class="sy-dp-status ' + cls + '"><i></i>' + esc(text) + detail + '</span>';
  }

  function windowsHtml() {
    var list = (DP.topology && DP.topology.replayWindows) || [1, 5, 15];
    return '<label class="sy-dp-select">'
      + icon('clock')
      + '<select data-sy-dp-window-select aria-label="Time window">'
      + list.map(function (m) {
        return '<option value="' + m + '"' + (DP.replay.minutes === m ? ' selected' : '') + '>'
          + 'Last ' + m + (m === 1 ? ' minute' : ' minutes') + '</option>';
      }).join('')
      + '</select></label>';
  }

  function headHtml() {
    var mode = function (key, label, ic) {
      return '<button class="sy-dp-mode' + (DP.mode === key ? ' sy-dp-mode-on' : '') + '" type="button"'
        + ' data-sy-dp-mode="' + key + '" aria-pressed="' + (DP.mode === key ? 'true' : 'false') + '">'
        + icon(ic) + '<span>' + esc(label) + '</span></button>';
    };
    return '<div class="sy-dp-page">'
      + '<div class="sy-dp-page-txt">'
        + '<nav class="sy-dp-crumb" aria-label="Breadcrumb"><span>System</span><i>›</i>'
        + '<span>Infrastructure</span><i>›</i><b>Live Data Flow</b></nav>'
        + '<div class="sy-dp-page-title"><h1>Live Data Flow</h1>' + statusHtml() + '</div>'
        + '<p>Real-time and historical data flow across the Familista platform. '
        + 'A unified view of all systems, services and regions.</p>'
      + '</div>'
      + '<div class="sy-dp-page-ctl">'
        + '<div class="sy-dp-modes">' + mode('LIVE', 'Live', 'live') + mode('REPLAY', 'Replay', 'replay') + '</div>'
        + '<button class="sy-dp-ghost" type="button" data-sy-dp-storage="1">'
          + icon('storage') + '<span>Storage</span></button>'
        + windowsHtml()
      + '</div></div>';
  }

  // ── the metric tiles ───────────────────────────────────────────────────────

  /**
   * One tile.
   *
   * A measured figure renders as a figure. A figure nothing measures renders as
   * an em dash and the reason underneath — never as a zero, which would read as
   * "measured, and none".
   */
  function tile(opts) {
    var value = opts.value;
    var absent = (value === null || value === undefined);
    // The exact figure rides in a title only when it says something the visible
    // one does not — a tooltip repeating the number underneath it is noise.
    var exact = (opts.exact && String(opts.exact) !== String(value))
      ? ' title="' + esc(String(opts.exact)) + '"' : '';
    var body = absent
      ? '<b class="sy-dp-none">—</b>'
      : '<b' + exact + ' data-no-i18n>' + esc(String(value)) + '</b>'
        + (opts.unit ? '<u data-no-i18n>' + esc(opts.unit) + '</u>' : '');
    // The reason an absent figure is absent sits UNDER the label rather than
    // beside it: a tile six across has no room for a second column, and a
    // truncated "Not inst…" says less than nothing.
    return '<div class="sy-dp-tile' + (opts.tone ? ' sy-dp-tile--' + opts.tone : '')
      + (opts.small ? ' sy-dp-tile--sm' : '') + '">'
      + '<span class="sy-dp-tile-ic">' + icon(opts.icon) + '</span>'
      + '<span class="sy-dp-tile-b"><span class="sy-dp-tile-v">' + body + '</span>'
      + '<span class="sy-dp-tile-l">' + esc(opts.label) + '</span>'
      + (absent ? '<em class="sy-dp-unavailable" title="' + esc(opts.why || '') + '">Not instrumented</em>' : '')
      + '</span>'
      + (absent ? '' : (opts.trend || ''))
      + '</div>';
  }

  function metricsHtml() {
    var m = DP.metrics || {};
    var a = DP.active || {};
    var why = 'Nothing in Familista marks an outbox row processed, failed or pending yet, '
      + 'so these stay absent rather than showing a zero.';
    var last = m.lastEventAt ? clockOf(m.lastEventAt) : null;

    return '<div class="sy-dp-tiles">'
      + '<div class="sy-dp-tile-row">'
        + tile({ icon: 'rate', label: 'Events / sec', value: num(m.eventsPerSecond),
                 exact: num(m.eventsPerSecond), tone: 'cyan', trend: trendHtml('eventsPerSecond') })
        + tile({ icon: 'stream', label: 'Events / min', value: num(m.eventsPerMinute),
                 exact: num(m.eventsPerMinute), tone: 'blue', trend: trendHtml('eventsPerMinute') })
        + tile({ icon: 'users', label: 'Active Users', value: num(a.activeUsers),
                 exact: num(a.activeUsers), tone: 'blue', trend: trendHtml('activeUsers'),
                 why: 'Counted from telemetry sessions in the last five minutes.' })
        + tile({ icon: 'session', label: 'Active Sessions', value: num(a.activeSessions),
                 exact: num(a.activeSessions), tone: 'cyan', trend: trendHtml('activeSessions'),
                 why: 'Counted from telemetry sessions in the last five minutes.' })
        + tile({ icon: 'clubs', label: 'Active Clubs', value: num(m.activeClubs),
                 exact: num(m.activeClubs), tone: 'blue', trend: trendHtml('activeClubs'),
                 why: 'Clubs this process has seen an event from.' })
      + '</div>'
      + '<div class="sy-dp-tile-row sy-dp-tile-row--sm">'
        + tile({ small: true, icon: 'layers', label: 'Observed Events', value: num(m.totalObserved),
                 exact: num(m.totalObserved), tone: 'blue' })
        + tile({ small: true, icon: 'latency', label: 'Avg Write Latency', value: num(m.averageLatencyMs),
                 unit: 'ms', exact: num(m.averageLatencyMs), tone: 'cyan',
                 why: 'No event has carried a write latency in this window yet.' })
        + tile({ small: true, icon: 'clock', label: 'Last Event', value: last, tone: 'blue',
                 exact: m.lastEventAt || '', why: 'Nothing has moved through the fabric since this panel opened.' })
        + tile({ small: true, icon: 'processed', label: 'Processed', value: num(m.processed), tone: 'ok', why: why })
        + tile({ small: true, icon: 'failed', label: 'Failed', value: num(m.failed), tone: 'bad', why: why })
        + tile({ small: true, icon: 'pending', label: 'Pending', value: num(m.pending), tone: 'warn', why: why })
      + '</div></div>';
  }

  // ── the world, drawn once ──────────────────────────────────────────────────
  //
  // A 72×35 equirectangular land mask at five degrees of longitude and four of
  // latitude, covering +82° to −58° — the crop a world map uses when it is not
  // about Antarctica. It is rendered as ONE <path> of small squares rather than
  // two and a half thousand elements, and the string is built once and kept.

  var LAND = [
    '................######.#########........................................',
    '............####################.....................#####..............',
    '...........#####################...............##.############..........',
    '.....################...#######........###############################..',
    '..####################...####..##.....#...##############################',
    '..######################..##.........#...###############################',
    '...#.....###############...........#.#..############################....',
    '..........##############..........#################################.....',
    '...........##############..........##############################.......',
    '...........############...........########.####################.#.......',
    '...........###########............##..###.####################..........',
    '............#########.....................####################..........',
    '.............#######................#####.###################...........',
    '..............####.#..............##########################............',
    '..............##.................###############..##########............',
    '...............#..#..............##########.###...###.####..............',
    '.................##..............#############.....##..###..#...........',
    '..................##.............############......##..###..#...........',
    '....................#####.........############..........#...#...........',
    '....................######............########..........#..#............',
    '....................#######...........#######.............###...........',
    '.....................########.........######............#...#.###.......',
    '.....................########.........######.............##....####.....',
    '.....................#######...........#####..................##........',
    '......................######..........#####..#...............####.......',
    '......................#####............####..#.............######.......',
    '......................#####............####..#.............#######......',
    '......................####.............###.................########.....',
    '......................####..............##.................#######......',
    '......................###.......................................##......',
    '......................##................................................',
    '......................#.................................................',
    '.....................##.................................................',
    '.....................#..................................................',
    '........................................................................',
  ];
  var MAP_W = 720, MAP_H = 350, CELL = 10, LAT_TOP = 82, LAT_SPAN = 140;
  var landPath = null;

  function worldPath() {
    if (landPath) return landPath;
    var d = [];
    for (var r = 0; r < LAND.length; r++) {
      for (var c = 0; c < LAND[r].length; c++) {
        if (LAND[r].charAt(c) !== '#') continue;
        var x = c * CELL + 3, y = r * CELL + 3;
        d.push('M' + x + ' ' + y + 'h3.4v3.4h-3.4z');
      }
    }
    landPath = d.join('');
    return landPath;
  }

  function project(lat, lon) {
    var la = Math.max(-58, Math.min(LAT_TOP, Number(lat)));
    var lo = Math.max(-180, Math.min(180, Number(lon)));
    return {
      x: ((lo + 180) / 360) * MAP_W,
      y: ((LAT_TOP - la) / LAT_SPAN) * MAP_H,
    };
  }

  /**
   * The plotted clubs, largest first.
   *
   * A country the atlas cannot place is never given a coordinate — it is
   * counted in the figures and named in the card's footnote instead.
   */
  function plotted() {
    var eco = DP.eco;
    if (!eco || !eco.regions) return [];
    return eco.regions.filter(function (r) { return r.lat !== null && r.lon !== null; });
  }

  function worldSvg(cls, withPins, fit) {
    var pins = '';
    if (withPins) {
      var rows = plotted();
      var max = rows.reduce(function (n, r) { return Math.max(n, r.clubs); }, 1);
      pins = rows.map(function (r) {
        var p = project(r.lat, r.lon);
        var rad = 3.2 + Math.min(7, (r.clubs / max) * 7);
        var cx = p.x.toFixed(1), cy = p.y.toFixed(1);
        return '<g class="sy-dp-pin">'
          + '<circle class="sy-dp-pin-halo" cx="' + cx + '" cy="' + cy + '" r="' + (rad + 7).toFixed(1) + '"/>'
          + '<circle class="sy-dp-pin-ring" cx="' + cx + '" cy="' + cy + '" r="' + (rad + 3.5).toFixed(1) + '"/>'
          + '<circle class="sy-dp-pin-dot" cx="' + cx + '" cy="' + cy + '" r="' + rad.toFixed(1) + '">'
          + '<title data-user-content>' + esc(r.country) + ' · ' + esc(String(r.clubs))
          + '</title></circle></g>';
      }).join('');
    }
    // `slice` fills the card and crops the empty polar rows; `meet` letterboxes
    // and leaves half a card of nothing, which is what the panels were doing.
    return '<svg class="sy-dp-world ' + (cls || '') + '" viewBox="0 0 ' + MAP_W + ' ' + MAP_H + '"'
      + ' preserveAspectRatio="xMidYMid ' + (fit === 'slice' ? 'slice' : 'meet') + '"'
      + ' role="img" aria-label="World map">'
      + '<path class="sy-dp-land" d="' + worldPath() + '"/>' + pins + '</svg>';
  }

  // ── the ecosystem card ─────────────────────────────────────────────────────

  function ecoStat(label, value, exact) {
    if (value === null || value === undefined) {
      return '<div class="sy-dp-eco-stat"><b class="sy-dp-none">—</b>'
        + '<span>' + esc(label) + '</span></div>';
    }
    var title = (exact && String(exact) !== String(value)) ? ' title="' + esc(String(exact)) + '"' : '';
    return '<div class="sy-dp-eco-stat"><b' + title + ' data-no-i18n>' + esc(String(value)) + '</b>'
      + '<span>' + esc(label) + '</span></div>';
  }

  function ecoHtml() {
    var e = DP.eco;
    var foot = '';
    if (DP.ecoError) {
      foot = '<p class="sy-dp-eco-note sy-dp-unavailable" data-no-i18n>' + esc(DP.ecoError) + '</p>';
    } else if (e && e.unplaced && e.unplaced.length === 1) {
      foot = '<p class="sy-dp-eco-note">One country is counted but not plotted — '
        + 'the atlas has no coordinate for it.</p>';
    } else if (e && e.unplaced && e.unplaced.length) {
      foot = '<p class="sy-dp-eco-note">' + esc(String(e.unplaced.length))
        + ' countries are counted but not plotted — the atlas has no coordinate for them.</p>';
    }
    return '<section class="sy-dp-eco" aria-label="Global football ecosystem">'
      + '<h4>' + icon('globe') + '<span>Global Football Ecosystem</span></h4>'
      + '<div class="sy-dp-eco-map">' + worldSvg('sy-dp-world--sm', true, 'slice') + '</div>'
      + '<div class="sy-dp-eco-stats">'
        + ecoStat('Continents', e ? e.continents : null, e && e.how ? e.how.continents : '')
        + ecoStat('Countries', e ? e.countries : null, e && e.how ? e.how.countries : '')
        + ecoStat('Clubs', e ? compact(e.clubs) : null, e ? num(e.clubs) : '')
        + ecoStat('People', e ? compact(e.people) : null, e ? num(e.people) : '')
      + '</div>' + foot + '</section>';
  }

  // ── the board ──────────────────────────────────────────────────────────────
  //
  // The architecture, drawn as a board: sources on the left, the services and
  // the Data Fabric in the middle, destinations on the right. Every service
  // node is a real SYSTEM module and opens it — a label that navigates nowhere
  // would be a picture of an architecture rather than a way into it.

  var SERVICES = {
    top: [
      ['intelligence', 'AI Gateway', 'Secure Access', 'gateway'],
      ['intelligence', 'AI Engines', 'Multi-Model', 'engines'],
      ['agents', 'AI Agents', 'Task Automation', 'agents'],
      ['models', 'Model Registry', 'Version Control', 'registry'],
      ['governance', 'Global Governance', 'Policy & Compliance', 'governance'],
    ],
    mid: [
      ['governance', 'Compliance Engine', '', 'compliance'],
      ['governance', 'Consent & Age Rules', '', 'consent'],
      ['governance', 'Data Residency', '', 'residency'],
      ['notifications', 'Notifications', 'Multi-channel', 'notifications'],
      ['security', 'Security Center', 'Threat Protection', 'security'],
    ],
    low: [
      ['health', 'Platform Health', 'Real-time Monitoring', 'health'],
      ['audit', 'Audit Center', 'Immutable Records', 'audit'],
      ['backup', 'Backup & Recovery', 'Disaster Recovery', 'backup'],
    ],
  };

  function serviceHtml(row) {
    return row.map(function (s) {
      return '<button class="sy-dp-svc" type="button" data-sy-go="' + esc(s[0]) + '">'
        + '<span class="sy-dp-svc-ic">' + icon(s[3]) + '</span>'
        + '<span class="sy-dp-svc-t"><b>' + esc(s[1]) + '</b>'
        + (s[2] ? '<i>' + esc(s[2]) + '</i>' : '') + '</span></button>';
    }).join('');
  }

  /**
   * The substrate the board is printed on.
   *
   * Static etched routing and vias, drawn once as a constant and scaled with
   * the board. It is TEXTURE, not topology: nothing travels on it, no packet
   * is ever given one of these paths, and it is drawn dimmer than the live
   * copper precisely so the two cannot be confused. The real connections are
   * the measured `<path>`s in `#dp-traces`, and they are the only ones that
   * ever light.
   */
  var ETCH = '<svg class="sy-dp-etch" viewBox="0 0 1000 420" preserveAspectRatio="xMidYMid slice"'
    + ' aria-hidden="true" focusable="false">'
    + '<g class="sy-dp-etch-g">'
    + '<path d="M0 46h84l22 22h96M0 92h58l26-26h72M0 138h44l30 30h108M0 212h70l24 24h70"/>'
    + '<path d="M0 286h44l30-30h108M0 332h58l26 26h72M0 378h84l22-22h96"/>'
    + '<path d="M1000 46h-84l-22 22h-96M1000 92h-58l-26-26h-72M1000 138h-44l-30 30h-108"/>'
    + '<path d="M1000 212h-70l-24 24h-70M1000 286h-44l-30-30h-108M1000 332h-58l-26 26h-72"/>'
    + '<path d="M1000 378h-84l-22-22h-96"/>'
    + '<path d="M300 0v38l26 26v64M700 0v38l-26 26v64M300 420v-38l26-26v-64M700 420v-38l-26-26v-64"/>'
    + '<path d="M360 14h280M360 406h280"/>'
    + '</g>'
    + '<g class="sy-dp-etch-via">'
    + '<circle cx="202" cy="68" r="3"/><circle cx="156" cy="66" r="3"/><circle cx="182" cy="168" r="3"/>'
    + '<circle cx="164" cy="236" r="3"/><circle cx="182" cy="256" r="3"/><circle cx="156" cy="358" r="3"/>'
    + '<circle cx="202" cy="356" r="3"/><circle cx="798" cy="68" r="3"/><circle cx="844" cy="66" r="3"/>'
    + '<circle cx="818" cy="168" r="3"/><circle cx="836" cy="236" r="3"/><circle cx="818" cy="256" r="3"/>'
    + '<circle cx="844" cy="358" r="3"/><circle cx="798" cy="356" r="3"/>'
    + '<circle cx="326" cy="128" r="3"/><circle cx="674" cy="128" r="3"/>'
    + '<circle cx="326" cy="292" r="3"/><circle cx="674" cy="292" r="3"/>'
    + '</g></svg>';

  function mapHtml() {
    var t = DP.topology;
    if (!t) return '<div class="sy-dp-map sy-dp-map-loading" id="dp-map"></div>';

    // A pad, not a box: an LED, an icon, a label, the lane's counted rate and a
    // connector stub the trace meets. It filters the stream to its own lane,
    // so the pad is a control rather than a legend.
    var rates = laneRates();
    var pad = function (kind, name) {
      var on = DP.lane === kind + ':' + name;
      var rate = kind === 'source' ? rates.source(name) : rates.dest(name);
      return '<button class="sy-dp-node sy-dp-' + kind + (on ? ' sy-dp-node-on' : '') + '" type="button"'
        + ' id="' + laneId(kind === 'source' ? 'src' : 'dst', name) + '"'
        + ' data-sy-dp-lane="' + esc(kind + ':' + name) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
        + ' title="Events counted on this lane in the chosen window">'
        + '<i class="sy-dp-led"></i>'
        + '<span class="sy-dp-node-ic">' + icon(LANE_ICON[name] || 'system') + '</span>'
        + '<span class="sy-dp-node-n">' + esc(name) + '</span>'
        + '<b class="sy-dp-rate" data-no-i18n>' + rateLabel(rate) + '</b>'
        + '<u class="sy-dp-stub' + (kind === 'dest' ? ' sy-dp-stub-in' : '') + '"></u>'
        + '</button>';
    };

    var sources = t.sources.map(function (n) { return pad('source', n); }).join('');
    var dests = t.destinations.map(function (d) { return pad('dest', d.name); }).join('');

    // FUTURE lanes are drawn, dashed and labelled, with NO trace running to
    // them. An unconnected pad on a board is the honest picture of a
    // destination that consumes nothing.
    var future = t.future.map(function (d) {
      return '<div class="sy-dp-node sy-dp-dest sy-dp-future" title="' + esc(d.note) + '">'
        + '<i class="sy-dp-led"></i>'
        + '<span class="sy-dp-node-ic">' + icon(LANE_ICON[d.name] || 'layers') + '</span>'
        + '<span class="sy-dp-node-n">' + esc(d.name) + '</span>'
        + '<em>Future</em></div>';
    }).join('');

    return '<div class="sy-dp-map" id="dp-map">'
      // The board it is all printed on, then the copper on top of it.
      + ETCH
      // The copper. One <svg> above the substrate, sized to the board, holding a
      // real <path> per connection — measured from the pads once they are laid
      // out, so a packet follows the trace rather than a straight line between
      // two boxes.
      + '<svg class="sy-dp-traces" id="dp-traces" aria-hidden="true" focusable="false"></svg>'
      + '<div class="sy-dp-col sy-dp-col-src">'
        + '<h4>Data Sources<i>Real-time data from across the platform</i></h4>'
        + '<div class="sy-dp-pads">' + sources + '</div>'
      + '</div>'
      + '<div class="sy-dp-col sy-dp-col-fabric">'
        + '<div class="sy-dp-arch">'
          + '<b>Familista Platform Architecture</b>'
          + '<i>People · Data · Intelligence · A Better Football World</i>'
        + '</div>'
        + '<div class="sy-dp-tier sy-dp-tier-5">' + serviceHtml(SERVICES.top) + '</div>'
        + '<div class="sy-dp-core-wrap">'
          // A package, a die and the lettering on it — the three layers a chip
          // actually has. The pin rows down each edge are drawn by the package's
          // own pseudo-elements, so the die is one element and not fourteen.
          + '<div class="sy-dp-fabric" id="dp-fabric">'
            + '<div class="sy-dp-fabric-ring"></div>'
            + '<div class="sy-dp-core-die">'
              + '<span class="sy-dp-core-mark" data-no-i18n>F</span>'
              + '<b data-no-i18n>Familista<em>Data Fabric</em></b>'
              + '<span class="sy-dp-core-sub">Connects Football To The World</span>'
              // The outbox is its own lit element: it is the moment the row
              // becomes the truth, and the whole architecture now reads from it.
              + '<span class="sy-dp-outbox" id="dp-outbox"><i class="sy-dp-led"></i>Event Outbox</span>'
            + '</div>'
          + '</div>'
        + '</div>'
        + '<div class="sy-dp-tier sy-dp-tier-5">' + serviceHtml(SERVICES.mid) + '</div>'
        + '<div class="sy-dp-tier sy-dp-tier-3">' + serviceHtml(SERVICES.low) + '</div>'
      + '</div>'
      + '<div class="sy-dp-col sy-dp-col-dst">'
        + '<h4>Data Destinations<i>Consume, analyse and activate data</i></h4>'
        + '<div class="sy-dp-pads">' + dests + '</div>'
        + '<h5>Future Layers</h5>'
        + '<div class="sy-dp-pads sy-dp-future-group">' + future + '</div>'
      + '</div>'
      + '<div class="sy-dp-stage" id="dp-stage" aria-hidden="true"></div>'
      + '</div>';
  }

  // ── the copper ──────────────────────────────────────────────────────────────
  //
  // Traces are built ONCE from measured pad geometry and cached until the board
  // resizes. Rebuilding them per event would mean a layout read per packet, and
  // measuring during an animation is how a visualiser starts costing more than
  // the thing it watches.

  var traces = {};        // 'src:Players' -> SVGPathElement
  var traceBox = '';      // the geometry the current traces were built for

  /**
   * An L-shaped trace with a chamfered corner, the way copper actually turns.
   *
   * Out of the pad horizontally, a 45° break, then straight into the target's
   * edge. Two segments and one chamfer — enough to read as a circuit, cheap
   * enough to animate.
   */
  function tracePath(from, to, lane) {
    // Every pad on a column shares an x, so a single break point would stack
    // ten routes on one vertical bus. The break walks with the lane index, and
    // the board reads as routed copper rather than one trunk.
    var spread = 0.42 + ((lane || 0) % 6) * 0.045;
    var midX = from.x + (to.x - from.x) * spread;
    var c = Math.min(14, Math.abs(to.y - from.y) / 2);
    if (c < 2) return 'M' + from.x + ',' + from.y + ' L' + to.x + ',' + to.y;
    var dir = to.y > from.y ? 1 : -1;
    return 'M' + from.x + ',' + from.y
      + ' L' + (midX - c) + ',' + from.y
      + ' L' + midX + ',' + (from.y + c * dir)
      + ' L' + midX + ',' + (to.y - c * dir)
      + ' L' + (midX + c) + ',' + to.y
      + ' L' + to.x + ',' + to.y;
  }

  function buildTraces() {
    var svg = document.getElementById('dp-traces');
    var map = document.getElementById('dp-map');
    var fabric = document.getElementById('dp-fabric');
    var t = DP.topology;
    if (!svg || !map || !fabric || !t) return false;

    var box = map.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return false;

    var key = Math.round(box.width) + 'x' + Math.round(box.height) + ':' + t.sources.length;
    if (key === traceBox && svg.childElementCount) return true;   // already correct

    var point = function (el, side) {
      var r = el.getBoundingClientRect();
      return {
        x: (side === 'right' ? r.right : side === 'left' ? r.left : r.left + r.width / 2) - box.left,
        y: r.top - box.top + r.height / 2,
      };
    };

    svg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
    svg.setAttribute('width', String(box.width));
    svg.setAttribute('height', String(box.height));
    svg.innerHTML = '';
    traces = {};

    var add = function (id, from, to, lane) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', tracePath(from, to, lane));
      path.setAttribute('class', 'sy-dp-trace');
      path.setAttribute('id', id);
      svg.appendChild(path);
      traces[id] = path;
    };

    var fabL = point(fabric, 'left');
    var fabR = point(fabric, 'right');

    t.sources.forEach(function (name, i) {
      var el = document.getElementById(laneId('source', name));
      if (el) add('tr-src-' + slug(name), point(el, 'right'), fabL, i);
    });
    t.destinations.forEach(function (d, i) {
      var el = document.getElementById(laneId('dest', d.name));
      if (el) add('tr-dst-' + slug(d.name), fabR, point(el, 'left'), i);
    });

    traceBox = key;
    return true;
  }

  // ── the event stream ───────────────────────────────────────────────────────

  function visibleFrames() {
    var rows = DP.frames;
    if (DP.filter) rows = rows.filter(function (f) { return categoryOf(f) === DP.filter; });
    if (DP.lane) {
      var parts = DP.lane.split(':');
      rows = rows.filter(function (f) {
        return parts[0] === 'source' ? f.source === parts[1] : f.destination === parts[1];
      });
    }
    // In replay, the playhead is the clock: only what has already played is on
    // screen, so scrubbing shows the window as it happened rather than all of
    // it at once.
    if (DP.mode === 'REPLAY' && DP.frames.length) {
      var keep = Math.max(1, Math.round(rows.length * DP.play.at));
      rows = rows.slice(rows.length - keep);
    }
    return rows;
  }

  function statusDot(f) {
    var s = String((f && f.status) || '').toUpperCase();
    var tone = s === 'FAILED' ? 'bad' : s === 'PENDING' ? 'warn' : 'ok';
    return '<span class="sy-dp-st sy-dp-st--' + tone + '"><i></i><span data-no-i18n>'
      + esc(s || '—') + '</span></span>';
  }

  function emptyHtml() {
    if (DP.frames.length) return '';
    if (DP.mode === 'REPLAY') {
      return '<div class="sy-dp-empty"><b>No events in this window</b>'
        + '<span>The durable record holds nothing for the minutes selected. '
        + 'Choose a longer window, or switch back to Live.</span></div>';
    }
    return '<div class="sy-dp-empty">'
      + '<div class="sy-dp-empty-ring"></div>'
      + '<b>Listening for live platform activity…</b>'
      + '<span>Nothing has moved through the fabric since this panel opened. '
      + 'Update a player in any club and the event will appear here.</span>'
      + '</div>';
  }

  function streamHtml() {
    var rows = visibleFrames();
    // The lane's own name is interface vocabulary and goes through the
    // catalogue; the × beside it is a symbol and does not.
    var lane = DP.lane ? '<button class="sy-dp-clear" type="button" data-sy-dp-lane=""'
      + ' aria-label="Show every lane"><span>' + esc(DP.lane.split(':')[1])
      + '</span><i data-no-i18n>×</i></button>' : '';

    var body = rows.length ? rows.slice(0, 60).map(function (f) {
      var cat = categoryOf(f);
      var what = cat === 'DOMAIN' ? f.eventType : String(f.eventType).slice(3).replace(/_/g, ' ');
      var entity = f.subjectLabel || (f.subjectType ? String(f.subjectType).toLowerCase() : null);
      return '<button class="sy-dp-tr' + (f.registered ? '' : ' sy-dp-tr-unknown') + '"'
        + ' data-sy-dp-inspect="' + esc(f.eventId) + '">'
        + '<time data-no-i18n>' + esc(clockOf(f.recordedAt) || '—') + '</time>'
        + '<span class="sy-dp-ev"><i class="sy-dp-cat sy-dp-cat-' + esc(cat.toLowerCase()) + '"></i>'
        + '<code>' + esc(what) + '</code></span>'
        + '<span class="sy-dp-src-cell">' + esc(f.source || '—') + '</span>'
        + '<span class="sy-dp-ent"' + (f.subjectLabel ? ' data-user-content' : '') + '>'
        + esc(entity || '—') + '</span>'
        + statusDot(f)
        + '<span class="sy-dp-lat" data-no-i18n>' + esc(f.latencyMs === null || f.latencyMs === undefined
          ? '—' : f.latencyMs + ' ms') + '</span>'
        + '</button>';
    }).join('') : '';

    return '<section class="sy-dp-panel sy-dp-streamp" aria-label="Event stream">'
      + '<div class="sy-dp-panel-h">'
        + '<h4>' + icon('stream') + '<span>Event Stream</span></h4>'
        + lane
        + (DP.sampling > 1 ? '<span class="sy-dp-sampling" data-no-i18n>1 in ' + DP.sampling + '</span>' : '')
        + statusHtml()
      + '</div>'
      + '<div class="sy-dp-thead"><span>Time</span><span>Event Type</span><span>Source</span>'
      + '<span>Entity</span><span>Status</span><span>Latency</span></div>'
      + '<div class="sy-dp-tbody">' + (body || emptyHtml()) + '</div>'
      + '</section>';
  }

  // ── the timeline ───────────────────────────────────────────────────────────

  var BUCKETS = 44;

  /** Counts per bucket across the window. Real events, bucketed by arrival. */
  function histogram() {
    var span = windowMs();
    var end = Date.now();
    if (DP.mode === 'REPLAY' && DP.frames.length) {
      var newest = new Date(DP.frames[0].recordedAt).getTime();
      if (newest && !isNaN(newest)) end = newest;
    }
    var start = end - span;
    var bins = new Array(BUCKETS);
    for (var b = 0; b < BUCKETS; b++) bins[b] = 0;
    var rows = DP.filter
      ? DP.frames.filter(function (f) { return categoryOf(f) === DP.filter; })
      : DP.frames;
    for (var i = 0; i < rows.length; i++) {
      var t = new Date(rows[i].recordedAt).getTime();
      if (!t || isNaN(t) || t < start || t > end) continue;
      var idx = Math.min(BUCKETS - 1, Math.floor(((t - start) / span) * BUCKETS));
      bins[idx]++;
    }
    return { bins: bins, start: start, end: end };
  }

  function timelineHtml() {
    var h = histogram();
    var max = h.bins.reduce(function (a, b) { return Math.max(a, b); }, 0);
    var bars = h.bins.map(function (n, i) {
      // An empty bucket is empty. A floor applied to zero would draw activity
      // into a minute when nothing happened, which is the one thing this screen
      // must never do.
      var pct = n ? Math.max(6, Math.round((n / max) * 100)) : 0;
      var lit = (DP.play.at * BUCKETS) >= i;
      return '<i class="sy-dp-bar' + (lit ? ' sy-dp-bar-on' : '') + '" style="height:' + pct + '%"'
        + ' title="' + n + '"></i>';
    }).join('');

    var marks = [];
    for (var k = 0; k <= 4; k++) {
      marks.push('<span data-no-i18n>' + esc(clockOf(new Date(h.start + (h.end - h.start) * (k / 4)).toISOString()) || '') + '</span>');
    }

    var chips = CATEGORIES.map(function (c) {
      return '<button class="sy-dp-chip' + (DP.filter === c[0] ? ' sy-dp-chip-on' : '')
        + '" type="button" data-sy-dp-filter="' + esc(c[0]) + '">' + esc(c[1]) + '</button>';
    }).join('');

    var canPlay = DP.mode === 'REPLAY' && DP.frames.length > 0;
    return '<section class="sy-dp-panel sy-dp-timeline" aria-label="Timeline and replay">'
      + '<div class="sy-dp-panel-h">'
        + '<h4>' + icon('timeline') + '<span>Timeline &amp; Replay</span></h4>'
        + '<button class="sy-dp-mini' + (DP.mode === 'LIVE' ? ' sy-dp-mini-on' : '') + '" type="button"'
        + ' data-sy-dp-mode="LIVE">' + icon('live') + '<span>Live</span></button>'
        + '<button class="sy-dp-mini" type="button" data-sy-dp-speed="1" title="Playback speed"'
        + ' data-no-i18n>' + DP.play.speed + '×</button>'
        + '<button class="sy-dp-mini sy-dp-mini-ic" type="button" data-sy-dp-expand="1"'
        + ' aria-label="Open the event inspector list">' + icon('expand') + '</button>'
      + '</div>'
      + '<div class="sy-dp-tl-row">'
        + '<button class="sy-dp-playbtn' + (DP.play.on ? ' is-playing' : '') + '" type="button"'
        + ' data-sy-dp-play="1"' + (canPlay ? '' : ' disabled')
        + ' title="' + (canPlay ? 'Play this window' : 'Live is already at the present — switch to Replay to scrub')
        + '" aria-label="Play">' + (DP.play.on ? '❚❚' : '▶') + '</button>'
        + '<div class="sy-dp-track" data-sy-dp-seek="1">'
          + '<div class="sy-dp-track-fill" style="width:' + (DP.play.at * 100).toFixed(1) + '%"></div>'
          + '<div class="sy-dp-track-head" style="left:' + (DP.play.at * 100).toFixed(1) + '%"></div>'
        + '</div>'
      + '</div>'
      + '<div class="sy-dp-bars">' + bars + '</div>'
      + '<div class="sy-dp-marks">' + marks.join('') + '</div>'
      + '<div class="sy-dp-chips">' + chips + '</div>'
      + '</section>';
  }

  // ── the global activity map ────────────────────────────────────────────────

  function globeStat(label, value, why) {
    if (value === null || value === undefined) {
      return '<div class="sy-dp-gstat"><b class="sy-dp-none" title="' + esc(why || '') + '">—</b>'
        + '<span>' + esc(label) + '</span></div>';
    }
    return '<div class="sy-dp-gstat"><b data-no-i18n>' + esc(String(value)) + '</b>'
      + '<span>' + esc(label) + '</span></div>';
  }

  /**
   * The four numbers beside the map.
   *
   * Its own slot, because a metric tick arrives every second and the map it
   * sits next to is eight hundred static shapes — redrawing those once a
   * second to change four figures would be the most expensive thing on the
   * screen, and it would cost a repaint of a region nothing changed in.
   */
  function gstatsHtml() {
    var m = DP.metrics || {};
    var why = 'Nothing marks an outbox row processed or failed yet.';
    return globeStat('Events / sec', num(m.eventsPerSecond))
      + globeStat('Active Clubs', num(m.activeClubs))
      + globeStat('Processed', num(m.processed), why)
      + globeStat('Failed', num(m.failed), why);
  }

  function globeHtml() {
    var e = DP.eco;
    var continents = e && e.continents !== null && e.continents !== undefined ? e.continents : null;
    return '<section class="sy-dp-panel sy-dp-globe" aria-label="Global activity map">'
      + '<div class="sy-dp-panel-h">'
        + '<h4>' + icon('globe') + '<span>Global Activity Map</span></h4>'
        + '<span id="dp-gstatus">' + statusHtml() + '</span>'
      + '</div>'
      + '<div class="sy-dp-globe-body">'
        + '<div class="sy-dp-globe-map">' + worldSvg('', true, 'slice') + '</div>'
        + '<div class="sy-dp-gstats" id="dp-gstats">' + gstatsHtml() + '</div>'
      + '</div>'
      + '<div class="sy-dp-globe-foot">'
        + '<span>' + (continents === null ? 'Club locations are not available yet'
          : continents === 1 ? 'Live data flow across one continent'
            : 'Live data flow across ' + esc(String(continents)) + ' continents') + '</span>'
        + '<i>Familista Global Infrastructure</i>'
      + '</div>'
      + '</section>';
  }

  // ── the shell ──────────────────────────────────────────────────────────────

  function shell() {
    return '<div class="sy-dp-wrap" id="dp-wrap">'
      + '<div id="dp-head-slot">' + headHtml() + '</div>'
      + '<div class="sy-dp-strip">'
        + '<div id="dp-metrics-slot">' + metricsHtml() + '</div>'
        + '<div id="dp-eco-slot">' + ecoHtml() + '</div>'
      + '</div>'
      + '<div class="sy-dp-boardwrap" id="dp-map-slot">' + mapHtml() + '</div>'
      + '<div class="sy-dp-foot">'
        + '<div id="dp-body-slot">' + streamHtml() + '</div>'
        + '<div id="dp-timeline-slot">' + timelineHtml() + '</div>'
        + '<div id="dp-globe-slot">' + globeHtml() + '</div>'
      + '</div>'
      + '</div>';
  }

  /**
   * Translate what was just drawn, using SYSTEM's catalogue.
   *
   * This panel mounts AFTER SYSTEM has painted and translated, so its own
   * markup would otherwise stay English in an Arabic or German session. It
   * calls SYSTEM's translator rather than carrying a second one: one screen,
   * one catalogue.
   */
  function translate(el) {
    try { if (el && typeof window.sySyncTranslate === 'function') window.sySyncTranslate(el); }
    catch (_) { /* an untranslated panel still works */ }
  }

  function fill(id, html) {
    var slot = document.getElementById(id);
    if (slot) { slot.innerHTML = html; translate(slot); }
  }

  function paint(what) {
    if (what === 'metrics') {
      fill('dp-metrics-slot', metricsHtml());
      fill('dp-gstats', gstatsHtml());
      fill('dp-gstatus', statusHtml());
      var st = document.getElementById('dp-head-slot');
      if (st) {
        var live = st.querySelector('.sy-dp-status');
        if (live) live.outerHTML = statusHtml();
      }
      return;
    }
    if (what === 'body') {
      fill('dp-body-slot', streamHtml());
      fill('dp-timeline-slot', timelineHtml());
      return;
    }
    if (what === 'lanes') {
      // Only the rate readouts changed. Rewriting the pads would drop a packet
      // mid-flight, so each number is written in place.
      var t = DP.topology;
      if (!t) return;
      var rates = laneRates();
      var write = function (kind, name, rate) {
        var el = document.getElementById(laneId(kind === 'source' ? 'src' : 'dst', name));
        if (!el) return;
        var b = el.querySelector('.sy-dp-rate');
        if (b) b.innerHTML = rateLabel(rate);
      };
      t.sources.forEach(function (n) { write('source', n, rates.source(n)); });
      t.destinations.forEach(function (d) { write('dest', d.name, rates.dest(d.name)); });
      return;
    }
    if (what === 'replay' || what === 'head') { fill('dp-head-slot', headHtml()); return; }
    if (what === 'eco') { fill('dp-eco-slot', ecoHtml()); fill('dp-globe-slot', globeHtml()); return; }
    var host = document.getElementById('dp-host');
    if (host) {
      host.innerHTML = shell();
      translate(host);
      // After layout, so the pads have real boxes to measure.
      requestAnimationFrame(function () { traceBox = ''; buildTraces(); });
    }
  }

  // ── the dot ────────────────────────────────────────────────────────────────

  /**
   * Send one real event along the real copper, in two legs.
   *
   *   source pad → fabric      the event arriving
   *   Event Outbox lights      the row becoming the truth
   *   fabric → destination pad the event going where it is consumed
   *
   * The packet rides the actual `<path>` via `offset-path`, so it follows the
   * trace's corners instead of cutting across the board. A pad's LED is lit
   * only while its own traffic is passing and decays afterwards — a board with
   * everything permanently lit says nothing about what is happening.
   *
   * If either pad is missing — an event whose lane this build does not draw —
   * no packet is created rather than one being sent somewhere arbitrary.
   */
  function pulse(frame) {
    var stage = document.getElementById('dp-stage');
    if (!stage || !buildTraces()) return;
    if (stage.childElementCount >= DOT_LIMIT) return;   // hard cap; counters still move

    var inTrace = traces['tr-src-' + slug(frame.source)];
    var outTrace = traces['tr-dst-' + slug(frame.destination)];
    var srcPad = document.getElementById(laneId('source', frame.source));
    var dstPad = document.getElementById(laneId('dest', frame.destination));
    var outbox = document.getElementById('dp-outbox');
    var fabric = document.getElementById('dp-fabric');
    if (!inTrace || !outTrace || !srcPad || !dstPad) return;

    var cls = 'sy-dp-cl-' + String(frame.dataClassification || 'INTERNAL').toLowerCase();
    var IN_MS = 780;
    var OUT_MS = 620;

    // A packet: a small rounded bar, so direction of travel reads at a glance.
    var packet = function (trace, ms, delay) {
      var el = document.createElement('i');
      el.className = 'sy-dp-packet ' + cls;
      stage.appendChild(el);
      var anim = el.animate([
        { offsetDistance: '0%', opacity: 0 },
        { offsetDistance: '6%', opacity: 1, offset: 0.08 },
        { offsetDistance: '94%', opacity: 1, offset: 0.92 },
        { offsetDistance: '100%', opacity: 0 },
      ], { duration: ms, delay: delay || 0, easing: 'cubic-bezier(.45,0,.35,1)', fill: 'both' });
      // The path travels with the packet, so two events on different traces are
      // genuinely independent animations rather than one shared timeline.
      el.style.offsetPath = 'path("' + trace.getAttribute('d') + '")';
      el.style.offsetRotate = '0deg';
      var done = function () { try { el.remove(); } catch (_) {} };
      if (anim && anim.finished && anim.finished.then) anim.finished.then(done, done);
      else setTimeout(done, ms + (delay || 0) + 80);
      return anim;
    };

    // The trace itself lights along its length, on stroke-dashoffset — a
    // property that does not reflow.
    var energise = function (trace, ms, delay) {
      trace.classList.add('sy-dp-trace-hot');
      var len = 0;
      try { len = trace.getTotalLength(); } catch (_) { len = 600; }
      var a = trace.animate([
        { strokeDasharray: len + ' ' + len, strokeDashoffset: len },
        { strokeDasharray: len + ' ' + len, strokeDashoffset: 0 },
      ], { duration: ms, delay: delay || 0, easing: 'ease-out', fill: 'none' });
      var cool = function () { trace.classList.remove('sy-dp-trace-hot'); };
      if (a && a.finished && a.finished.then) a.finished.then(cool, cool);
      else setTimeout(cool, ms + (delay || 0) + 200);
    };

    /** Light a pad's LED for as long as its own traffic is passing. */
    var lightFor = function (el, ms, delay) {
      if (!el) return;
      setTimeout(function () {
        el.classList.add('sy-dp-hot');
        setTimeout(function () { el.classList.remove('sy-dp-hot'); }, ms);
      }, delay || 0);
    };

    // Leg one: the source announces itself, the trace lights, the packet runs.
    lightFor(srcPad, IN_MS + 300, 0);
    energise(inTrace, IN_MS, 0);
    packet(inTrace, IN_MS, 0);

    // Arrival: the fabric acknowledges once, and the OUTBOX lights, because
    // that is the instant the row exists and Live reads rows.
    setTimeout(function () {
      if (fabric) {
        fabric.classList.add('sy-dp-fabric-hit');
        setTimeout(function () { fabric.classList.remove('sy-dp-fabric-hit'); }, 420);
      }
      if (outbox) {
        outbox.classList.add('sy-dp-hot');
        setTimeout(function () { outbox.classList.remove('sy-dp-hot'); }, 520);
      }
    }, IN_MS);

    // Leg two: onward to whatever actually consumes it.
    energise(outTrace, OUT_MS, IN_MS);
    packet(outTrace, OUT_MS, IN_MS);
    lightFor(dstPad, OUT_MS + 300, IN_MS);
  }

  function accept(frames, sampling) {
    if (!frames || !frames.length) return;
    DP.sampling = sampling || 1;

    var fresh = [];
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var id = f && f.eventId;
      if (!id || seen[id]) continue;
      seen[id] = true;
      seenOrder.push(id);
      fresh.push(f);
      DP.frames.unshift(f);
    }
    if (!fresh.length) return;      // nothing new: no repaint, no dots

    while (DP.frames.length > FRAME_LIMIT) DP.frames.pop();
    while (seenOrder.length > FRAME_LIMIT * 2) { delete seen[seenOrder.shift()]; }
    frames = fresh;
    paint('body');
    paint('lanes');
    // Animated on the next frame, after the feed has laid out — measuring pad
    // geometry in the same tick as an innerHTML write reads a stale box.
    //
    // Two events sharing one trace are staggered so they read as two packets
    // rather than one; events on different traces start together, because they
    // genuinely happened together.
    requestAnimationFrame(function () {
      var perTrace = Object.create(null);
      for (var j = 0; j < frames.length && j < DOT_LIMIT; j++) {
        var f = frames[j];
        var lane = f.source + '>' + f.destination;
        var n = perTrace[lane] || 0;
        perTrace[lane] = n + 1;
        if (n === 0) pulse(f);
        else setTimeout(pulse.bind(null, f), n * 160);
      }
    });
  }

  // ── one way to reach the API, and it is Familista's ────────────────────────
  //
  // TWO FAILURES GOT US HERE, AND BOTH WERE THE SAME MISTAKE
  //
  // First this file built its own URL from `API().baseUrl` — a property that
  // does not exist — so every request lost the `/api/v1` prefix and 404'd.
  // Then it read the token from `API().getToken()`, which also does not exist:
  // `public/familista-api-client.js` defines one `FamilistaAPI` with
  // a token accessor and `app.js` defines another that REPLACES it and exposes
  // `request/get/post/refreshTokens/rawFetch` and no token accessor at all.
  // app.js loads last, so that accessor was undefined and the header was empty.
  // Cross-origin, with no cookie to fall back on, that is a 401.
  //
  // The lesson both times: do not reconstruct what the application already
  // does. So JSON requests now go through `FamilistaAPI.get`, the canonical
  // request path the whole SPA uses — which brings its own 401 → refresh →
  // retry, its cold-start timeout and its backoff with it. Nothing here
  // reimplements any of that.
  //
  // PRODUCTION IS CROSS-ORIGIN
  //
  // The SPA is served from familista-v5.onrender.com and the API answers on
  // familista-backend.onrender.com, so `FAM_CONFIG.API_BASE` is an absolute
  // URL and the `access_token` cookie does NOT travel by default. The bearer
  // token is therefore the credential that matters, and it lives where the
  // rest of the app keeps it — `State.token`, refreshed in place — never in a
  // query string, which every proxy between here and the server would log.

  /** The canonical client. `app.js`'s, which is the one that ends up on window. */
  function client() {
    try {
      var api = API();
      return (api && typeof api.get === 'function') ? api : null;
    } catch (_) { return null; }
  }

  /**
   * The access token, from the one place the application keeps it.
   *
   * The same expression SYSTEM's own `api()` uses, so there is exactly one
   * answer to "what is the current token" and this screen cannot disagree with
   * the screen around it.
   */
  function accessToken() {
    try {
      return (window.State && window.State.token) || localStorage.getItem('familista_token') || '';
    } catch (_) { return ''; }
  }

  function apiBase() {
    try {
      if (typeof FAM_CONFIG !== 'undefined' && FAM_CONFIG && FAM_CONFIG.API_BASE) return FAM_CONFIG.API_BASE;
    } catch (_) { /* fall through */ }
    return '/api/v1';
  }

  /** An error that carries the status, so the UI can name it rather than guess. */
  function httpError(status, message) {
    var e = new Error(message || ('HTTP ' + status));
    e.status = status;
    return e;
  }

  /**
   * A JSON read, through the application's own request path.
   *
   * `FamilistaAPI.get` handles the bearer header, the refresh-on-401 retry and
   * the cold-start timeout. When it is somehow absent — a page that loaded this
   * file without app.js — this falls back to a plain authenticated fetch rather
   * than failing silently, and the fallback uses the same token expression.
   */
  function dpJson(path) {
    var api = client();
    if (api) {
      return api.get('/system/data-pulse' + path).then(function (body) {
        return (body && body.data != null) ? body.data : body;
      });
    }
    var t = accessToken();
    return fetch(apiBase() + '/system/data-pulse' + path, {
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      credentials: 'include',
      cache: 'no-store',
    }).then(function (r) {
      if (!r.ok) throw httpError(r.status);
      return r.json();
    }).then(function (body) { return (body && body.data != null) ? body.data : body; });
  }

  /**
   * The stream, which cannot go through `FamilistaAPI.get`.
   *
   * That helper parses a JSON body; an SSE response is an open
   * `ReadableStream` and must not be consumed. So this is the one raw request
   * in the file — and it authenticates with the SAME token and refreshes
   * through the SAME `refreshTokens()` the rest of the app uses, rather than
   * inventing a second session.
   */
  function dpStream(signal) {
    var t = accessToken();
    // The cursor resumes the tail. It is a position, not a credential.
    // Both positions resume, so neither stream repeats or skips on reconnect.
    var parts = [];
    if (DP.cursor) parts.push('cursor=' + encodeURIComponent(DP.cursor));
    if (DP.uiCursor) parts.push('uiCursor=' + encodeURIComponent(DP.uiCursor));
    var q = parts.length ? '?' + parts.join('&') : '';
    return fetch(apiBase() + '/system/data-pulse/stream' + q, {
      method: 'GET',
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      credentials: 'include',
      cache: 'no-store',
      signal: signal,
    });
  }

  /** The application's refresh, used once before a 401 is called fatal. */
  function refreshOnce() {
    var api = client();
    if (!api || typeof api.refreshTokens !== 'function') return Promise.resolve(false);
    try { return Promise.resolve(api.refreshTokens()).catch(function () { return false; }); }
    catch (_) { return Promise.resolve(false); }
  }

  /** 401 is authentication; 403 is authority. They are not the same problem. */
  function isAuthStatus(code) {
    return code === 401 || code === 403;
  }

  /**
   * The footprint, read once per mount.
   *
   * Counts of clubs, countries and people change when somebody creates a club,
   * which is not something that happens twice a second — so this is a read, not
   * a subscription, and the server caches it for a minute besides.
   */
  function loadEcosystem() {
    dpJson('/ecosystem').then(function (d) {
      DP.eco = d || null;
      DP.ecoError = null;
      paint('eco');
    }).catch(function (err) {
      DP.eco = null;
      DP.ecoError = (err && err.message) || 'The ecosystem footprint could not be read';
      paint('eco');
    });
  }

  // ── the stream ─────────────────────────────────────────────────────────────

  function handle(event, data) {
    if (event === 'cursor') {
      DP.cursor = data.cursor || DP.cursor;
      DP.uiCursor = data.uiCursor || DP.uiCursor;
      return;
    }
    if (event === 'active') { DP.active = data || DP.active; paint('metrics'); return; }
    if (event === 'hello') {
      // Where the server started reading. Held so a reconnect resumes from what
      // this browser actually rendered rather than from wherever the new
      // instance happens to be.
      DP.cursor = data.cursor || null;
      DP.uiCursor = data.uiCursor || null;
      DP.connected = true;
      DP.lastError = null;
      DP.fatal = false;
      DP.refreshed = false;
      DP.reconnectAttempt = 0;
      DP.topology = data.topology || DP.topology;
      DP.metrics = data.metrics || DP.metrics;
      DP.limits = data.limits || DP.limits;
      if (DP.topology && data.replayWindows) DP.topology.replayWindows = data.replayWindows;
      paint();
      return;
    }
    if (event === 'backlog') { accept(data.frames, 1); return; }
    if (event === 'pulse') { accept(data.frames, data.sampling); return; }
    if (event === 'metrics') {
      DP.metrics = data;
      rememberMetrics(data);
      paint('metrics');
      paint('lanes');
      return;
    }
  }

  function connect() {
    if (DP.mode !== 'LIVE' || !DP.open) return;
    disconnect();
    abort = new AbortController();
    var signal = abort.signal;

    dpStream(signal).then(function (res) {
      // A 401 on a stream means the access token expired while the panel sat
      // open. The application's own refresh is asked once — not a second
      // session, not a login redirect — and the stream is reopened with the
      // new token. A second 401 is an answer.
      if (res.status === 401 && !DP.refreshed) {
        DP.refreshed = true;
        return refreshOnce().then(function (ok) {
          if (!ok || signal.aborted) throw httpError(401, 'Session expired — sign in again');
          return dpStream(signal);
        });
      }
      return res;
    }).then(function (res) {
      // The status travels with the error, so the screen can name it instead
      // of saying "Reconnecting…" forever about a 403 that will never change.
      if (!res.ok) throw httpError(res.status, res.status === 403
        ? 'Platform Owner authority required'
        : res.status === 401 ? 'Not signed in' : ('HTTP ' + res.status));
      if (!res.body) throw new Error('This browser cannot read a streamed response');
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      (function read() {
        reader.read().then(function (r) {
          if (r.done) throw new Error('stream ended');
          buf += decoder.decode(r.value, { stream: true });
          // SSE frames are separated by a blank line. Anything after the last
          // one is a partial frame and stays in the buffer.
          var parts = buf.split('\n\n');
          buf = parts.pop();
          parts.forEach(function (block) {
            var name = 'message'; var payload = '';
            block.split('\n').forEach(function (line) {
              if (line.indexOf('event:') === 0) name = line.slice(6).trim();
              else if (line.indexOf('data:') === 0) payload += line.slice(5).trim();
            });
            if (!payload) return;   // a comment line — the heartbeat
            try { handle(name, JSON.parse(payload)); } catch (_) { /* a truncated frame is skipped */ }
          });
          read();
        }).catch(fail);
      }());
    }).catch(fail);
  }

  /**
   * Reconnect with a backoff, and say so on screen while it happens.
   *
   * A silent reconnect would make a dead stream look like an idle platform,
   * which is the one confusion this screen must never create.
   */
  function fail(err) {
    if (err && err.name === 'AbortError') return;
    DP.connected = false;
    DP.lastError = (err && err.message) || 'disconnected';
    DP.fatal = isAuthStatus(err && err.status);
    DP.fatalStatus = (err && err.status) || null;
    paint('metrics');
    paint('head');
    if (!DP.open || DP.mode !== 'LIVE') return;
    // A 401 or 403 is an answer, not an outage. Retrying it on a timer burns
    // requests and — worse — presents a permission problem as a connection
    // problem, which is unactionable.
    if (DP.fatal) return;
    DP.reconnectAttempt = Math.min(DP.reconnectAttempt + 1, 6);
    var wait = Math.min(1000 * Math.pow(2, DP.reconnectAttempt - 1), 30000);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, wait);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    try { if (abort) abort.abort(); } catch (_) {}
    abort = null;
  }

  // ── replay ─────────────────────────────────────────────────────────────────

  function loadReplay(minutes) {
    DP.replay.minutes = minutes || DP.replay.minutes;
    DP.replay.loading = true;
    paint('head');

    dpJson('/replay?minutes=' + encodeURIComponent(DP.replay.minutes)).then(function (d) {
      d = d || {};
      // Replay owns its window, so it replaces rather than merges — and the
      // seen-set is reset with it so the same event may legitimately reappear
      // in a later window.
      seen = Object.create(null);
      seenOrder = [];
      DP.frames = (d.frames || []).slice().reverse();
      for (var i = 0; i < DP.frames.length; i++) {
        if (DP.frames[i] && DP.frames[i].eventId) {
          seen[DP.frames[i].eventId] = true;
          seenOrder.push(DP.frames[i].eventId);
        }
      }
      DP.replay.counts = d.counts || null;
      DP.replay.truncated = !!d.truncated;
      DP.replay.loading = false;
      DP.sampling = 1;
      DP.lastError = null;
      DP.play.at = 1;
      DP.play.on = false;
      paint();
    }).catch(function (err) {
      DP.replay.loading = false;
      DP.replay.counts = null;
      // Named, not swallowed. An empty replay and a refused replay look
      // identical otherwise, which is exactly how this bug survived a review.
      DP.lastError = (err && err.message) || 'replay failed';
      DP.fatal = isAuthStatus(err && err.status);
      DP.fatalStatus = (err && err.status) || null;
      paint();
    });
  }

  // ── playback ───────────────────────────────────────────────────────────────
  //
  // The only repeating work in this file, and it exists only while the owner is
  // playing a replay window. One requestAnimationFrame loop moves the playhead
  // and repaints the stream when — and only when — the number of revealed rows
  // actually changes.

  function stopPlayback() {
    DP.play.on = false;
    if (playFrame) { cancelAnimationFrame(playFrame); playFrame = null; }
  }

  function startPlayback() {
    if (DP.mode !== 'REPLAY' || !DP.frames.length) return;
    if (DP.play.at >= 1) DP.play.at = 0;
    DP.play.on = true;
    var last = null;
    var shown = -1;
    var duration = windowMs() / 6;    // a five-minute window plays in fifty seconds

    var step = function (ts) {
      if (!DP.play.on || !DP.open) { playFrame = null; return; }
      if (last === null) last = ts;
      var dt = ts - last;
      last = ts;
      DP.play.at = Math.min(1, DP.play.at + (dt / duration) * DP.play.speed);

      var head = document.querySelector('.sy-dp-track-head');
      var fillEl = document.querySelector('.sy-dp-track-fill');
      var pct = (DP.play.at * 100).toFixed(1) + '%';
      if (head) head.style.left = pct;
      if (fillEl) fillEl.style.width = pct;

      var count = Math.round(DP.play.at * DP.frames.length);
      if (count !== shown) { shown = count; paint('body'); }

      if (DP.play.at >= 1) { stopPlayback(); paint('body'); return; }
      playFrame = requestAnimationFrame(step);
    };
    playFrame = requestAnimationFrame(step);
    paint('body');
  }

  // ── the inspector ──────────────────────────────────────────────────────────

  function row(label, value) {
    if (value === null || value === undefined || value === '') {
      return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span>'
        + '<b class="sy-dp-unavailable">—</b></div>';
    }
    // The label is language; the value is a measurement, an identifier or an
    // enum token, so the translation pass is told to leave it alone. A
    // translated event id or a translated `STORED` would be a bug.
    return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span>'
      + '<b data-no-i18n>' + esc(String(value)) + '</b></div>';
  }

  /** A row whose right-hand side is a sentence rather than a value. */
  function note(label, text) {
    return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span><b>' + esc(text) + '</b></div>';
  }

  /**
   * A row holding a name somebody typed — a club's, a person's.
   *
   * Marked `data-user-content` so the translation pass does not translate a
   * name. A translated club name is a bug, not a feature.
   */
  function rowUser(label, value) {
    if (value === null || value === undefined || value === '') {
      return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span>'
        + '<b class="sy-dp-unavailable">—</b></div>';
    }
    return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span>'
      + '<b data-user-content>' + esc(String(value)) + '</b></div>';
  }

  function overlay(id, html) {
    var host = document.getElementById(id);
    if (!host) {
      host = document.createElement('div');
      host.id = id;
      document.body.appendChild(host);
    }
    host.className = 'sy-dp-i-open';
    host.innerHTML = html;
    translate(host);
  }

  window.dpInspect = function (eventId) {
    var f = null;
    for (var i = 0; i < DP.frames.length; i++) if (DP.frames[i].eventId === eventId) { f = DP.frames[i]; break; }
    if (!f) return;
    DP.inspecting = f;

    overlay('dp-inspector', '<div class="sy-dp-i-card" role="dialog" aria-label="Event detail">'
      + '<div class="sy-dp-i-head"><code>' + esc(f.eventType) + '</code>'
      + '<button class="sy-dp-i-close" type="button" data-sy-dp-close="1" aria-label="Close">×</button></div>'
      + '<div class="sy-dp-i-body">'
        // Discovered by the server from the outbox row alone — nothing here was
        // supplied by whoever opened this panel.
        + rowUser('Club', f.clubLabel)
        + rowUser(f.subjectType === 'PLAYER' ? 'Player' : 'Subject', f.subjectLabel)
        + row('Changed fields', f.changedFields && f.changedFields.length
          ? f.changedFields.join(', ') : null)
        + row('Event id', f.eventId)
        + row('Schema version', f.schemaVersion)
        + row('Occurred at', f.occurredAt)
        + row('Recorded at', f.recordedAt)
        + row('Write latency', f.latencyMs === null ? null : f.latencyMs + ' ms')
        + row('Club', f.clubId)
        + row('Team', f.teamId)
        + row('Source type', f.sourceType)
        + row('Subject type', f.subjectType)
        + row('Subject id', f.subjectId)
        + row('Correlation id', f.correlationId)
        + row('Causation id', f.causationId)
        + row('Classification', f.dataClassification)
        + row('Status', f.status)
        + row('Flow', f.source + ' → Data Fabric → ' + f.destination)
        + note('Registered type', f.registered ? 'Yes' : 'No — unknown to this build')
      + '</div>'
      // Said plainly, because an inspector that shows fifteen fields invites the
      // question "where is the rest of it".
      + '<p class="sy-dp-i-note">The event body is never sent to this screen. '
      + 'Live Data Flow shows how events move, not what they contain.</p>'
      + '</div>');
  };

  window.dpCloseInspector = function () {
    DP.inspecting = null;
    DP.storage = false;
    ['dp-inspector', 'dp-storage'].forEach(function (id) {
      var host = document.getElementById(id);
      if (host) { host.className = ''; host.innerHTML = ''; }
    });
  };

  /**
   * STORAGE — what the platform actually writes down.
   *
   * The durable record behind this board: the two tables it tails, the limits
   * the server reported on this connection, and the registered event types that
   * have no producer yet. All of it comes from the server; none of it is a
   * claim this file makes on its own.
   */
  window.dpStorage = function () {
    var t = DP.topology || {};
    var l = DP.limits || {};
    var gaps = t.notInstrumented || [];
    DP.storage = true;

    var lim = function (label, v, unit) {
      return row(label, v === null || v === undefined ? null : v + (unit ? ' ' + unit : ''));
    };

    overlay('dp-storage', '<div class="sy-dp-i-card sy-dp-i-card--wide" role="dialog" aria-label="Storage">'
      + '<div class="sy-dp-i-head"><code>Storage</code>'
      + '<button class="sy-dp-i-close" type="button" data-sy-dp-close="1" aria-label="Close">×</button></div>'
      + '<div class="sy-dp-i-body">'
        + '<p class="sy-dp-i-lead">Live Data Flow reads two durable tables and holds nothing of its own. '
        + 'Everything on the board comes from a row that already existed.</p>'
        + note('Durable record', 'EventOutbox — one row per domain event')
        + note('Behaviour record', 'AnalyticsEvent — telemetry, sanitised before it is written')
        + note('Event body', 'Never sent to the browser, from either table')
        + lim('In-memory buffer', l.bufferLimit, 'frames')
        + lim('Batch flush', l.flushMs, 'ms')
        + lim('Sampling threshold', l.sampleThreshold, 'frames per batch')
        + lim('Outbox tail batch', l.tailBatch, 'rows')
        + lim('Tail interval', l.tailIntervalMs, 'ms')
        + lim('Telemetry tail batch', l.telemetryBatch, 'rows')
        + row('Replay windows', ((t.replayWindows || [1, 5, 15]).join(', ')) + ' minutes')
        + '<div class="sy-dp-gaps"><b>' + (gaps.length === 1
          ? 'One registered event type has no producer yet'
          : esc(String(gaps.length)) + ' registered event types have no producer yet') + '</b>'
        + '<div class="sy-dp-gap-list">'
        + gaps.map(function (n) { return '<code>' + esc(n) + '</code>'; }).join('')
        + '</div><p>These names exist in the taxonomy so consumers can be written against them. '
        + 'Nothing in the platform emits them today, so no flow is drawn for them.</p></div>'
      + '</div></div>');
  };

  // ── open / close ───────────────────────────────────────────────────────────

  /**
   * Mount into a host SYSTEM has just drawn.
   *
   * SYSTEM repaints its whole body on navigation and again when its data
   * arrives, which replaces this host element. So mounting re-renders into the
   * fresh host — but only opens a stream if one is not already running.
   * Reconnecting on the second paint of one navigation would double every
   * frame and leave an orphaned connection open on the server.
   */
  window.dpMount = function (hostId) {
    var host = document.getElementById(hostId || 'dp-host');
    if (!host) return;
    host.id = 'dp-host';
    var wasOpen = DP.open;
    DP.open = true;
    paint();
    if (!wasOpen || !DP.eco) loadEcosystem();
    if (DP.mode === 'REPLAY') { if (!wasOpen) loadReplay(DP.replay.minutes); return; }
    if (!abort) connect();
  };

  window.dpUnmount = function () {
    DP.open = false;
    stopPlayback();
    disconnect();
    window.dpCloseInspector();
  };

  window.dpSetMode = function (mode) {
    if (mode !== 'LIVE' && mode !== 'REPLAY') return;
    if (DP.mode === mode) return;
    DP.mode = mode;
    DP.frames = [];
    DP.sampling = 1;
    DP.lastError = null;
    DP.fatal = false;
    DP.fatalStatus = null;
    DP.refreshed = false;
    stopPlayback();
    DP.play.at = 1;
    seen = Object.create(null);
    seenOrder = [];
    if (mode === 'LIVE') { DP.replay.counts = null; paint(); connect(); }
    else { disconnect(); DP.connected = false; paint(); loadReplay(DP.replay.minutes); }
  };

  /** The window applies to both modes: replay fetches it, live counts inside it. */
  function setWindow(minutes) {
    var m = Number(minutes) || 5;
    if (m === DP.replay.minutes) return;
    DP.replay.minutes = m;
    if (DP.mode === 'REPLAY') { loadReplay(m); return; }
    paint('head');
    paint('body');
    paint('lanes');
  }

  // One delegated listener for the whole panel, so repainting a slot never
  // leaves a dead handler behind.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest
      ? e.target.closest('[data-sy-dp-inspect],[data-sy-dp-mode],[data-sy-dp-window],[data-sy-dp-close],'
        + '[data-sy-dp-filter],[data-sy-dp-lane],[data-sy-dp-play],[data-sy-dp-speed],[data-sy-dp-seek],'
        + '[data-sy-dp-storage],[data-sy-dp-expand]')
      : null;
    if (!el) return;
    if (el.hasAttribute('data-sy-dp-filter')) {
      DP.filter = el.getAttribute('data-sy-dp-filter') || '';
      paint('body');
      return;
    }
    if (el.hasAttribute('data-sy-dp-lane')) {
      var want = el.getAttribute('data-sy-dp-lane') || '';
      DP.lane = (DP.lane === want) ? '' : want;
      paint('body');
      // The pads carry the pressed state, and only they change.
      var map = document.getElementById('dp-map-slot');
      if (map) {
        var pads = map.querySelectorAll('[data-sy-dp-lane]');
        for (var i = 0; i < pads.length; i++) {
          var on = pads[i].getAttribute('data-sy-dp-lane') === DP.lane;
          pads[i].classList.toggle('sy-dp-node-on', on);
          pads[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      }
      return;
    }
    if (el.hasAttribute('data-sy-dp-close')) { window.dpCloseInspector(); return; }
    if (el.hasAttribute('data-sy-dp-storage')) { window.dpStorage(); return; }
    if (el.hasAttribute('data-sy-dp-expand')) {
      var first = DP.frames[0];
      if (first) window.dpInspect(first.eventId);
      return;
    }
    if (el.hasAttribute('data-sy-dp-play')) {
      if (DP.play.on) { stopPlayback(); paint('body'); } else startPlayback();
      return;
    }
    if (el.hasAttribute('data-sy-dp-speed')) {
      DP.play.speed = DP.play.speed >= 4 ? 1 : DP.play.speed * 2;
      paint('body');
      return;
    }
    if (el.hasAttribute('data-sy-dp-seek')) {
      if (DP.mode !== 'REPLAY' || !DP.frames.length) return;
      var box = el.getBoundingClientRect();
      DP.play.at = Math.max(0, Math.min(1, (e.clientX - box.left) / Math.max(1, box.width)));
      stopPlayback();
      paint('body');
      return;
    }
    if (el.hasAttribute('data-sy-dp-inspect')) { window.dpInspect(el.getAttribute('data-sy-dp-inspect')); return; }
    if (el.hasAttribute('data-sy-dp-mode')) { window.dpSetMode(el.getAttribute('data-sy-dp-mode')); return; }
    if (el.hasAttribute('data-sy-dp-window')) { loadReplay(Number(el.getAttribute('data-sy-dp-window'))); }
  });

  document.addEventListener('change', function (e) {
    var sel = e.target && e.target.closest ? e.target.closest('[data-sy-dp-window-select]') : null;
    if (sel) setWindow(sel.value);
  });

  // Two seams, for a browser harness and for a test that wants to drive the
  // real renderer rather than reimplement it. Neither produces an event: they
  // render what they are given, which is the opposite of a generator.
  window.__repaint = function () { paint(); };
  window.__feed = function (frames) { accept(frames, 1); };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (DP.inspecting || DP.storage)) window.dpCloseInspector();
  });

  // The board's geometry changes with the viewport, and a trace measured at one
  // width sends packets to the wrong place at another. Rebuilt on a settle,
  // never mid-animation.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { traceBox = ''; buildTraces(); }, 180);
  });

  // A backgrounded tab does not need a live socket. Reconnecting on return is
  // cheaper than holding one open for a screen nobody is looking at.
  document.addEventListener('visibilitychange', function () {
    if (!DP.open || DP.mode !== 'LIVE') return;
    if (document.hidden) disconnect();
    else connect();
  });
}());
