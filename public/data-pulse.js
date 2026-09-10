// Familista — Data Pulse, the platform owner's live data flow
// ─────────────────────────────────────────────────────────────────────────────
// A map of where events come from, where they go, and a dot travelling the
// path each real event actually took.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP
//
// Nothing on this screen is invented. There is no particle loop, no decorative
// animation, no synthetic throughput and no destination that is not either
// genuinely consuming events or clearly marked FUTURE. Every dot is one event
// the server observed; when nothing is happening the screen says so and stays
// still. A visualiser that looks busy when the platform is idle is worse than
// no visualiser, because it cannot be used to answer the only question it is
// for.
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
// nothing accumulates. The metrics row repaints its own numbers rather than
// re-rendering the map, and the map is only rebuilt when the topology changes.
//
// NOTHING MOVES THAT THE READER DID NOT MOVE
//
// Dots are absolutely positioned inside a fixed-height stage and animate on
// `transform` and `opacity` only, so a pulse cannot shift a single pixel of the
// panel underneath it. The inspector is a fixed overlay for the same reason.

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
    replay: { minutes: 5, loading: false, counts: null, truncated: false },
  };
  window._DP = DP;

  var FRAME_LIMIT = 200;     // what the inspector list can hold
  var DOT_LIMIT = 24;        // what may be in flight on screen at once
  var abort = null;
  var reconnectTimer = null;
  /** eventIds already rendered, and their arrival order so the set can be trimmed. */
  var seen = Object.create(null);
  var seenOrder = [];

  // ── the lanes ──────────────────────────────────────────────────────────────

  function laneId(kind, name) {
    var k = kind === 'source' ? 'src' : kind === 'dest' ? 'dst' : kind;
    return 'dp-' + k + '-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  /**
   * A metric cell.
   *
   * `null` is NOT zero. The server sends null for anything it cannot compute,
   * and this renders those words rather than a number nobody measured.
   */
  function metric(label, value, unit) {
    var body = (value === null || value === undefined)
      ? '<span class="sy-dp-unavailable">Not instrumented yet</span>'
      : '<b>' + esc(String(value)) + '</b>' + (unit ? '<i>' + esc(unit) + '</i>' : '');
    return '<div class="sy-dp-metric"><span>' + esc(label) + '</span><div>' + body + '</div></div>';
  }

  function metricsHtml() {
    var m = DP.metrics;
    if (!m) return '<div class="sy-dp-metrics sy-dp-metrics-idle"></div>';
    var last = m.lastEventAt ? timeAgo(m.lastEventAt) : null;
    return '<div class="sy-dp-metrics">'
      + metric('Events / sec', m.eventsPerSecond)
      + metric('Events / min', m.eventsPerMinute)
      + metric('Active clubs', m.activeClubs)
      + metric('Observed', m.totalObserved)
      + metric('Avg write latency', m.averageLatencyMs, 'ms')
      + metric('Last event', last)
      + metric('Processed', m.processed)
      + metric('Failed', m.failed)
      + metric('Pending', m.pending)
      + '</div>';
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

  function mapHtml() {
    var t = DP.topology;
    if (!t) return '<div class="sy-dp-map sy-dp-map-loading"></div>';

    // A pad, not a box: an LED, a label, and a connector stub the trace meets.
    var pad = function (kind, name, extra) {
      return '<div class="sy-dp-node sy-dp-' + kind + (extra || '') + '" id="' + laneId(kind === 'source' ? 'src' : 'dst', name) + '">'
        + '<i class="sy-dp-led"></i><span>' + esc(name) + '</span>'
        + (kind === 'source' ? '<u class="sy-dp-stub"></u>' : '<u class="sy-dp-stub sy-dp-stub-in"></u>')
        + '</div>';
    };

    var sources = t.sources.map(function (n) { return pad('source', n); }).join('');
    var dests = t.destinations.map(function (d) { return pad('dest', d.name); }).join('');

    // FUTURE lanes are drawn, dashed and labelled, with NO trace running to
    // them. An unconnected pad on a board is the honest picture of a
    // destination that consumes nothing.
    var future = t.future.map(function (d) {
      return '<div class="sy-dp-node sy-dp-dest sy-dp-future" title="' + esc(d.note) + '">'
        + '<i class="sy-dp-led"></i><span>' + esc(d.name) + '</span><em>Future</em></div>';
    }).join('');

    return '<div class="sy-dp-map" id="dp-map">'
      // The copper. One <svg> behind everything, sized to the board, holding a
      // real <path> per connection — measured from the pads once they are laid
      // out, so a packet follows the trace rather than a straight line between
      // two boxes.
      + '<svg class="sy-dp-traces" id="dp-traces" aria-hidden="true" focusable="false"></svg>'
      + '<div class="sy-dp-col sy-dp-col-src"><h4>Sources</h4>' + sources + '</div>'
      + '<div class="sy-dp-col sy-dp-col-fabric">'
        + '<h4>Familista Data Fabric</h4>'
        + '<div class="sy-dp-fabric" id="dp-fabric">'
          + '<div class="sy-dp-fabric-ring"></div>'
          + '<b>Event Envelope</b>'
          // The outbox is its own lit element: it is the moment the row becomes
          // the truth, and the whole architecture now reads from it.
          + '<span class="sy-dp-outbox" id="dp-outbox"><i class="sy-dp-led"></i>Event Outbox</span>'
        + '</div>'
      + '</div>'
      + '<div class="sy-dp-col sy-dp-col-dst"><h4>Destinations</h4>' + dests
        + '<div class="sy-dp-future-group">' + future + '</div>'
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
  function tracePath(from, to) {
    var midX = from.x + (to.x - from.x) * 0.55;
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

    var add = function (id, from, to) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', tracePath(from, to));
      path.setAttribute('class', 'sy-dp-trace');
      path.setAttribute('id', id);
      svg.appendChild(path);
      traces[id] = path;
    };

    var fabL = point(fabric, 'left');
    var fabR = point(fabric, 'right');

    t.sources.forEach(function (name) {
      var el = document.getElementById(laneId('source', name));
      if (el) add('tr-src-' + slug(name), point(el, 'right'), fabL);
    });
    t.destinations.forEach(function (d) {
      var el = document.getElementById(laneId('dest', d.name));
      if (el) add('tr-dst-' + slug(d.name), fabR, point(el, 'left'));
    });

    traceBox = key;
    return true;
  }

  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function emptyHtml() {
    var idle = !DP.frames.length;
    if (!idle) return '';
    return '<div class="sy-dp-empty">'
      + '<div class="sy-dp-empty-ring"></div>'
      + '<b>Listening for live platform activity…</b>'
      + '<span>Nothing has moved through the fabric since this panel opened. '
      + 'Update a player in any club and the event will appear here.</span>'
      + '</div>';
  }

  function feedHtml() {
    if (!DP.frames.length) return '';
    var rows = DP.frames.slice(0, 40).map(function (f) {
      var cls = 'sy-dp-row' + (f.registered ? '' : ' sy-dp-row-unknown');
      return '<button class="' + cls + '" data-sy-dp-inspect="' + esc(f.eventId) + '">'
        + '<code>' + esc(f.eventType) + '</code>'
        // The resolved names, when the server could resolve them. `data-user-content`
        // so the catalogue pass leaves a person's name and a club's name alone.
        + (f.subjectLabel
          ? '<span class="sy-dp-row-who" data-user-content>' + esc(f.subjectLabel) + '</span>' : '')
        + (f.clubLabel
          ? '<span class="sy-dp-row-club" data-user-content>' + esc(f.clubLabel) + '</span>' : '')
        + '<span class="sy-dp-row-lane">' + esc(f.source) + ' → ' + esc(f.destination) + '</span>'
        + '<span class="sy-dp-row-cls sy-dp-cls-' + esc(String(f.dataClassification).toLowerCase()) + '">'
        + esc(f.dataClassification) + '</span>'
        + '<time>' + esc(timeAgo(f.recordedAt) || '') + '</time>'
        + (f.registered ? '' : '<em title="This build does not know this event name">Unknown type</em>')
        + '</button>';
    }).join('');
    return '<div class="sy-dp-feed"><h4>Recent events'
      + (DP.sampling > 1 ? '<span class="sy-dp-sampling">showing 1 in ' + DP.sampling + '</span>' : '')
      + '</h4><div class="sy-dp-feed-rows">' + rows + '</div></div>';
  }

  function notInstrumentedHtml() {
    var t = DP.topology;
    if (!t || !t.notInstrumented || !t.notInstrumented.length) return '';
    return '<details class="sy-dp-gaps"><summary>'
      + esc(String(t.notInstrumented.length)) + ' registered event types have no producer yet'
      + '</summary><div class="sy-dp-gap-list">'
      + t.notInstrumented.map(function (n) { return '<code>' + esc(n) + '</code>'; }).join('')
      + '</div><p>These names exist in the taxonomy so consumers can be written against them. '
      + 'Nothing in the platform emits them today, so no flow is drawn for them.</p></details>';
  }

  function statusHtml() {
    var cls = DP.connected ? 'sy-dp-live' : (DP.lastError ? 'sy-dp-down' : 'sy-dp-connecting');
    var text = DP.connected ? 'Live' : (DP.lastError ? 'Reconnecting…' : 'Connecting…');
    // 401 and 403 are different problems and the difference is what tells the
    // owner whether to sign in again or to check their platform authority.
    if (!DP.connected && DP.fatalStatus === 401) text = 'Not signed in';
    else if (!DP.connected && DP.fatalStatus === 403) text = 'Not authorised';
    // The status itself, verbatim, next to the label. "Reconnecting…" with no
    // number is what let a 404 masquerade as an idle platform for a whole
    // production test; the code is what makes the difference visible.
    var detail = (!DP.connected && DP.lastError)
      ? '<em class="sy-dp-status-detail">' + esc(DP.lastError) + '</em>' : '';
    return '<span class="sy-dp-status ' + cls + '"><i></i>' + esc(text) + detail + '</span>';
  }

  function replayHtml() {
    if (DP.mode !== 'REPLAY') return '';
    var r = DP.replay;
    var buttons = [1, 5, 15].map(function (m) {
      return '<button class="sy-dp-win' + (r.minutes === m ? ' sy-dp-win-on' : '') + '" data-sy-dp-window="' + m + '">'
        + 'Last ' + m + 'm</button>';
    }).join('');
    var note = r.loading ? '<span class="sy-dp-unavailable">Loading…</span>'
      : r.counts ? esc(String(r.counts.total)) + ' events in window'
        + (r.truncated ? ' (showing the most recent ' + DP.frames.length + ')' : '')
      : '';
    return '<div class="sy-dp-replay">' + buttons + '<span class="sy-dp-replay-note">' + note + '</span></div>';
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  //
  // Split so a metric tick repaints nine numbers rather than the whole map, and
  // so a new frame never rebuilds the nodes a dot is currently travelling
  // between. Repainting the map mid-flight would cancel every animation.

  function shell() {
    return '<div class="sy-dp-wrap" id="dp-wrap">'
      + '<div class="sy-dp-head">'
        + '<div class="sy-dp-title"><b>Live Data Flow</b>'
        + '<span>Real events moving through the Familista Data Fabric</span></div>'
        + '<div class="sy-dp-head-right">'
          + '<div class="sy-dp-modes">'
            + '<button class="sy-dp-mode' + (DP.mode === 'LIVE' ? ' sy-dp-mode-on' : '') + '" data-sy-dp-mode="LIVE">Live</button>'
            + '<button class="sy-dp-mode' + (DP.mode === 'REPLAY' ? ' sy-dp-mode-on' : '') + '" data-sy-dp-mode="REPLAY">Replay</button>'
          + '</div>'
          + '<span id="dp-status-slot">' + statusHtml() + '</span>'
        + '</div>'
      + '</div>'
      + '<div id="dp-replay-slot">' + replayHtml() + '</div>'
      + '<div id="dp-metrics-slot">' + metricsHtml() + '</div>'
      + '<div id="dp-map-slot">' + mapHtml() + '</div>'
      + '<div id="dp-body-slot">' + emptyHtml() + feedHtml() + '</div>'
      + notInstrumentedHtml()
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

  function paint(what) {
    var slot;
    if (what === 'metrics') {
      slot = document.getElementById('dp-metrics-slot');
      if (slot) { slot.innerHTML = metricsHtml(); translate(slot); }
      slot = document.getElementById('dp-status-slot');
      if (slot) { slot.innerHTML = statusHtml(); translate(slot); }
      return;
    }
    if (what === 'body') {
      slot = document.getElementById('dp-body-slot');
      if (slot) { slot.innerHTML = emptyHtml() + feedHtml(); translate(slot); }
      return;
    }
    if (what === 'replay') {
      slot = document.getElementById('dp-replay-slot');
      if (slot) { slot.innerHTML = replayHtml(); translate(slot); }
      return;
    }
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
    // Animate on the next frame, after the feed has laid out — measuring node
    // positions in the same tick as an innerHTML write would read a stale box.
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
  // `getToken`, and `app.js` defines another that REPLACES it and exposes
  // `request/get/post/refreshTokens/rawFetch` and no token accessor at all.
  // app.js loads last, so `getToken` was undefined and the header was empty.
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
    var q = DP.cursor ? '?cursor=' + encodeURIComponent(DP.cursor) : '';
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

  // ── the stream ─────────────────────────────────────────────────────────────

  function handle(event, data) {
    if (event === 'cursor') { DP.cursor = data.cursor || DP.cursor; return; }
    if (event === 'hello') {
      // Where the server started reading. Held so a reconnect resumes from what
      // this browser actually rendered rather than from wherever the new
      // instance happens to be.
      DP.cursor = data.cursor || null;
      DP.connected = true;
      DP.lastError = null;
      DP.fatal = false;
      DP.refreshed = false;
      DP.reconnectAttempt = 0;
      DP.topology = data.topology || DP.topology;
      DP.metrics = data.metrics || DP.metrics;
      paint();
      return;
    }
    if (event === 'backlog') { accept(data.frames, 1); return; }
    if (event === 'pulse') { accept(data.frames, data.sampling); return; }
    if (event === 'metrics') { DP.metrics = data; paint('metrics'); return; }
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
    paint('replay');

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

  // ── the inspector ──────────────────────────────────────────────────────────

  function row(label, value) {
    if (value === null || value === undefined || value === '') {
      return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span>'
        + '<b class="sy-dp-unavailable">—</b></div>';
    }
    return '<div class="sy-dp-i-row"><span>' + esc(label) + '</span><b>' + esc(String(value)) + '</b></div>';
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

  window.dpInspect = function (eventId) {
    var f = null;
    for (var i = 0; i < DP.frames.length; i++) if (DP.frames[i].eventId === eventId) { f = DP.frames[i]; break; }
    if (!f) return;
    DP.inspecting = f;

    var host = document.getElementById('dp-inspector');
    if (!host) {
      host = document.createElement('div');
      host.id = 'dp-inspector';
      document.body.appendChild(host);
    }
    host.className = 'sy-dp-i-open';
    host.innerHTML = '<div class="sy-dp-i-card" role="dialog" aria-label="Event detail">'
      + '<div class="sy-dp-i-head"><code>' + esc(f.eventType) + '</code>'
      + '<button class="sy-dp-i-close" data-sy-dp-close="1" aria-label="Close">×</button></div>'
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
        + row('Registered type', f.registered ? 'Yes' : 'No — unknown to this build')
      + '</div>'
      // Said plainly, because an inspector that shows fifteen fields invites the
      // question "where is the rest of it".
      + '<p class="sy-dp-i-note">The event body is never sent to this screen. '
      + 'Data Pulse shows how events move, not what they contain.</p>'
      + '</div>';
    translate(host);
  };

  window.dpCloseInspector = function () {
    DP.inspecting = null;
    var host = document.getElementById('dp-inspector');
    if (host) { host.className = ''; host.innerHTML = ''; }
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
    if (DP.mode === 'REPLAY') { if (!wasOpen) loadReplay(DP.replay.minutes); return; }
    if (!abort) connect();
  };

  window.dpUnmount = function () {
    DP.open = false;
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
    seen = Object.create(null);
    seenOrder = [];
    if (mode === 'LIVE') { DP.replay.counts = null; paint(); connect(); }
    else { disconnect(); DP.connected = false; paint(); loadReplay(DP.replay.minutes); }
  };

  // One delegated listener for the whole panel, so repainting a slot never
  // leaves a dead handler behind.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-sy-dp-inspect],[data-sy-dp-mode],[data-sy-dp-window],[data-sy-dp-close]') : null;
    if (!el) return;
    if (el.hasAttribute('data-sy-dp-close')) { window.dpCloseInspector(); return; }
    if (el.hasAttribute('data-sy-dp-inspect')) { window.dpInspect(el.getAttribute('data-sy-dp-inspect')); return; }
    if (el.hasAttribute('data-sy-dp-mode')) { window.dpSetMode(el.getAttribute('data-sy-dp-mode')); return; }
    if (el.hasAttribute('data-sy-dp-window')) { loadReplay(Number(el.getAttribute('data-sy-dp-window'))); }
  });

  // Two seams, for a browser harness and for a test that wants to drive the
  // real renderer rather than reimplement it. Neither produces an event: they
  // render what they are given, which is the opposite of a demo mode.
  window.__repaint = function () { paint(); };
  window.__feed = function (frames) { accept(frames, 1); };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && DP.inspecting) window.dpCloseInspector();
  });

  // A backgrounded tab does not need a live socket. Reconnecting on return is
  // cheaper than holding one open for a screen nobody is looking at.
  // The board's geometry changes with the viewport, and a trace measured at one
  // width sends packets to the wrong place at another. Rebuilt on a settle,
  // never mid-animation.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { traceBox = ''; buildTraces(); }, 180);
  });

  document.addEventListener('visibilitychange', function () {
    if (!DP.open || DP.mode !== 'LIVE') return;
    if (document.hidden) disconnect();
    else connect();
  });
}());
