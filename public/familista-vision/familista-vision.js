/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA VISION — the sixth room, and the only one that looks at a pitch

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
       coordinate the engine withheld. Those two rules are the reason five
       validation phases were spent on the engine, and a presentation layer that
       quietly relaxed either of them would undo all of it.

   WHY THE PITCH IS DRAWN FROM COORDINATES AND NOT FROM A BACKGROUND IMAGE

   Because a pitch drawn as a picture with dots on top invites the dots to be
   placed anywhere. Here the pitch is an SVG in METRES — 105 by 68, Law 1 — and
   a dot's position is its own pitch coordinate. A coordinate the engine did not
   publish therefore has nowhere to go, which is exactly the property wanted.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var API = '/api/v1/familista-vision';

  var FV = {
    section: 'overview',
    status: null,
    sessions: null,
    sessionRef: null,
    session: null,
    timeline: null,
    device: null,
    integrations: null,
    models: null,
    sources: null,
    error: null,
    loading: false,
    overlays: { boxes: true, ids: true, team: true, role: true, ball: true, calib: true, events: true },
    frame: 0,
  };

  // ── plumbing ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** A measured zero is 0. A figure the platform does not hold is an em dash. */
  function n(v, digits) {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) {
      return '<span class="fv-none">—</span>';
    }
    if (typeof v !== 'number') return esc(v);
    return esc(digits === undefined ? String(v) : v.toFixed(digits));
  }

  function pct(v) {
    if (v === null || v === undefined) return '<span class="fv-none">—</span>';
    return esc((v * 100).toFixed(1)) + '%';
  }

  function get(path) {
    return fetch(API + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          return { ok: false, error: 'Familista Vision is not available to this account.' };
        }
        return r.json().catch(function () { return { ok: false, error: 'malformed response' }; });
      })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // ── sections ──────────────────────────────────────────────────────────────

  var SECTIONS = [
    { id: 'overview', group: 'COMMAND', icon: '◎', label: 'Overview' },
    { id: 'live', group: 'COMMAND', icon: '▶', label: 'Live Analysis' },
    { id: 'sources', group: 'COMMAND', icon: '⛁', label: 'Sources' },
    { id: 'sessions', group: 'COMMAND', icon: '≡', label: 'Sessions' },

    { id: 'tracking', group: 'EVIDENCE', icon: '⁘', label: 'Player Tracking' },
    { id: 'ball', group: 'EVIDENCE', icon: '●', label: 'Ball Tracking' },
    { id: 'calibration', group: 'EVIDENCE', icon: '⌗', label: 'Pitch Calibration' },
    { id: 'teams', group: 'EVIDENCE', icon: '⚑', label: 'Teams & Roles' },
    { id: 'events', group: 'EVIDENCE', icon: '✦', label: 'Events' },

    { id: 'tactical', group: 'ANALYSIS', icon: '◇', label: 'Tactical View', badge: 'PENDING' },
    { id: 'heatmaps', group: 'ANALYSIS', icon: '▦', label: 'Heatmaps' },
    { id: 'physical', group: 'ANALYSIS', icon: '↗', label: 'Physical Metrics', badge: 'NOT VALIDATED' },
    { id: 'timeline', group: 'ANALYSIS', icon: '⎯', label: 'Timeline' },
    { id: 'reports', group: 'ANALYSIS', icon: '⤓', label: 'Reports' },

    { id: 'device', group: 'PLATFORM', icon: '▣', label: 'Device' },
    { id: 'models', group: 'PLATFORM', icon: '◈', label: 'Models & Providers' },
    { id: 'integrations', group: 'PLATFORM', icon: '⌁', label: 'Integrations' },
  ];

  // ── shell ─────────────────────────────────────────────────────────────────

  function renderShell() {
    var root = document.getElementById('fv-root');
    if (!root) return;
    var caps = (FV.status && FV.status.health && FV.status.health.capabilities) || [];
    var railHtml = caps.map(function (c) {
      return '<div class="fv-chip fv-s-' + esc(c.status) + '" title="' + esc(c.detail) + '">'
        + '<span class="fv-dot"></span><b>' + esc(c.label) + '</b> ' + esc(c.status.replace(/_/g, ' '))
        + '</div>';
    }).join('');

    var lastGroup = '';
    var navHtml = SECTIONS.map(function (s) {
      var head = s.group !== lastGroup ? '<div class="fv-nav-group">' + esc(s.group) + '</div>' : '';
      lastGroup = s.group;
      return head + '<button class="fv-nav-item' + (FV.section === s.id ? ' is-active' : '')
        + '" data-fv-section="' + esc(s.id) + '" type="button">'
        + '<span class="fv-nav-ico">' + s.icon + '</span><span>' + esc(s.label) + '</span>'
        + (s.badge ? '<span class="fv-nav-badge">' + esc(s.badge) + '</span>' : '')
        + '</button>';
    }).join('');

    root.innerHTML =
      '<div class="fv-head">'
      + '<div class="fv-brand"><span class="fv-brand-mark">◉</span>'
      + '<span><div class="fv-brand-name">FAMILISTA VISION</div>'
      + '<div class="fv-brand-sub">Football Computer Vision · Evidence &amp; Provenance</div></span></div>'
      + '<div class="fv-head-spacer"></div>'
      + '<button class="fv-back" data-fv-back type="button">← Familista</button>'
      + '</div>'
      + '<div class="fv-rail">' + (railHtml || '<div class="fv-chip">Reading Vision service…</div>') + '</div>'
      + '<div class="fv-body">'
      + '<nav class="fv-nav">' + navHtml + '</nav>'
      + '<section class="fv-work"><div class="fv-work-head" id="fv-work-head"></div>'
      + '<div class="fv-work-body" id="fv-work-body"></div></section>'
      + '</div>';

    root.addEventListener('click', onClick);
    renderSection();
  }

  function onClick(e) {
    var nav = e.target.closest('[data-fv-section]');
    if (nav) { FV.section = nav.getAttribute('data-fv-section'); refreshNav(); renderSection(); return; }
    if (e.target.closest('[data-fv-back]')) {
      if (typeof window.navTo === 'function') window.navTo('owner-home');
      else window.location.hash = '#owner-home';
      return;
    }
    var pick = e.target.closest('[data-fv-open-session]');
    if (pick) { openSession(pick.getAttribute('data-fv-open-session')); return; }
    var toggle = e.target.closest('[data-fv-overlay]');
    if (toggle) {
      var key = toggle.getAttribute('data-fv-overlay');
      FV.overlays[key] = !FV.overlays[key];
      renderSection();
      return;
    }
    var seek = e.target.closest('[data-fv-seek]');
    if (seek) {
      FV.frame = parseInt(seek.getAttribute('data-fv-seek'), 10) || 0;
      FV.section = 'live';
      refreshNav();
      renderSection();
    }
  }

  function refreshNav() {
    var items = document.querySelectorAll('[data-fv-section]');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-active', items[i].getAttribute('data-fv-section') === FV.section);
    }
  }

  function head(title, sub) {
    var el = document.getElementById('fv-work-head');
    if (el) el.innerHTML = '<div class="fv-work-title">' + esc(title) + '</div>'
      + '<div class="fv-work-sub">' + sub + '</div>';
  }

  function body(html) {
    var el = document.getElementById('fv-work-body');
    if (el) el.innerHTML = html;
  }

  /** The four absences. Each names what is missing and what would fill it. */
  function empty(kind, title, why) {
    return '<div class="fv-empty fv-empty--' + kind + '">'
      + '<div class="fv-empty-title">' + esc(title) + '</div>'
      + '<div class="fv-empty-why">' + esc(why) + '</div></div>';
  }

  function needSession() {
    return empty('withheld', 'NO SESSION SELECTED',
      'Choose a session under Sessions. Every figure in this module belongs to one '
      + 'processed session and none of them is a platform average.');
  }

  function panel(title, inner, tag) {
    return '<div class="fv-panel"><div class="fv-panel-title">' + esc(title)
      + (tag ? tag : '') + '</div>' + inner + '</div>';
  }

  function metric(value, unit, caption) {
    return '<div class="fv-metric"><span class="fv-metric-v">' + value + '</span>'
      + (unit ? '<span class="fv-metric-u">' + esc(unit) + '</span>' : '') + '</div>'
      + '<div class="fv-metric-k">' + esc(caption) + '</div>';
  }

  // ── section router ────────────────────────────────────────────────────────

  function renderSection() {
    var r = {
      overview: secOverview, live: secLive, sources: secSources, sessions: secSessions,
      tracking: secTracking, ball: secBall, calibration: secCalibration, teams: secTeams,
      events: secEvents, tactical: secTactical, heatmaps: secHeatmaps, physical: secPhysical,
      timeline: secTimeline, reports: secReports, device: secDevice, models: secModels,
      integrations: secIntegrations,
    }[FV.section];
    if (r) r();
  }

  window.__FV = FV;
  window.__fvRender = renderSection;
  window.__fvHelpers = { esc: esc, n: n, pct: pct, panel: panel, metric: metric, empty: empty, head: head, body: body, needSession: needSession, get: get };

  // ── OVERVIEW ──────────────────────────────────────────────────────────────

  function secOverview() {
    head('Overview', 'The command centre. Every figure below came from a processed session '
      + 'or from the running service; none of it is a platform average.');
    if (!FV.status) { body('<div class="fv-empty fv-empty--withheld">Reading Vision service…</div>'); return; }
    if (FV.status.ok === false) {
      body(empty('withheld', 'VISION SERVICE UNAVAILABLE', FV.status.error || 'the service did not answer'));
      return;
    }
    var h = FV.status.health;
    var s = FV.session && FV.session.summary;
    var cards = [];

    cards.push(panel('Vision Engine', metric(esc(h.service.replace(/_/g, ' ')), '',
      h.processingTarget + ' · ' + h.deviceKind.replace(/_/g, ' ').toLowerCase()),
      '<span class="fv-tag fv-tag--accent">' + esc(h.processingTarget) + '</span>'));

    cards.push(panel('Sessions stored',
      metric(h.sessions.stored === null ? '<span class="fv-none">—</span>' : esc(h.sessions.stored),
        '', h.sessions.note)));

    cards.push(panel('Sources',
      metric(esc(h.sources.implementedTypes) + '<span class="fv-metric-u"> of '
        + esc(h.sources.declaredTypes) + '</span>', '',
        'source types implemented. ' + h.sources.slots + ' future rig slots declared and empty.')));

    cards.push(panel('Event types on the Fabric',
      metric(esc(h.eventTypes), '', 'versioned Vision event names registered on the platform transport')));

    if (s) {
      cards.push(panel('Current session',
        '<div class="fv-metric"><span class="fv-metric-v" style="font-size:16px">'
        + esc(s.sessionRef) + '</span></div>'
        + '<div class="fv-metric-k">' + esc(s.source.displayName) + ' · '
        + esc(s.source.width) + '×' + esc(s.source.height) + ' · '
        + n(s.source.fps, 2) + ' fps · quality ' + esc(s.source.qualityBand || 'UNKNOWN') + '</div>',
        '<span class="fv-tag fv-tag--measured">MEASURED</span>'));

      cards.push(panel('Frames processed', metric(esc(s.framesProcessed), '',
        s.observationsTotal + ' tracked observations · ' + s.identities + ' identities')));

      cards.push(panel('Calibration coverage',
        metric(pct(s.calibrationCoverage), '', s.anchorsAccepted + ' accepted anchors · '
          + s.calibrationMeasuredFrames + ' measured, ' + s.calibrationPropagatedFrames + ' propagated frames')
        + '<div class="fv-bar"><i style="width:' + ((s.calibrationCoverage || 0) * 100) + '%"></i></div>'));

      cards.push(panel('Metric coordinates',
        metric(esc(s.observationsWithPitchCoords), '',
          'of ' + s.observationsTotal + ' observations · on-pitch rate ' + pct(s.coordsOnPitchRate)),
        '<span class="fv-tag fv-tag--measured">WITHHELD WHERE NONE</span>'));

      var observed = s.ballStates.OBSERVED || 0;
      var propagated = s.ballStates.PROPAGATED || 0;
      cards.push(panel('Ball',
        metric(esc(observed), 'observed', propagated + ' propagated · '
          + (s.ballStates.UNKNOWN || 0) + ' unknown · ' + (s.ballStates.NOT_AVAILABLE || 0) + ' not available'),
        '<span class="fv-tag fv-tag--propagated">PROPAGATED ≠ OBSERVED</span>'));

      var evTotal = Object.keys(s.eventCounts).reduce(function (a, k) { return a + s.eventCounts[k]; }, 0);
      cards.push(panel('Football events',
        metric(esc(evTotal), '', Object.keys(s.eventCounts).map(function (k) {
          return k.replace(/_/g, ' ').toLowerCase() + ' ' + s.eventCounts[k];
        }).join(' · ') || 'none confirmed')));

      cards.push(panel('Team assignment', metric(pct(s.teamAssignmentRate), '',
        'fraction of observations given a team. Not a measure of whether the team is right.')));

      cards.push(panel('Processing', metric(n(s.processingFps, 2), 'fps',
        'wall clock ' + n(s.processingSeconds, 0) + ' s for ' + s.framesProcessed + ' frames')));

      cards.push(panel('Models in this result',
        '<div class="fv-rows">' + s.models.map(function (m) {
          return '<div class="fv-row"><span class="fv-row-k">' + esc(m.modelId) + '</span>'
            + '<span class="fv-tag ' + (m.commercialUse === 'VERIFIED' ? 'fv-tag--measured'
              : m.commercialUse === 'UNKNOWN' ? 'fv-tag--unverified' : 'fv-tag--restricted')
            + '">' + esc(m.commercialUse) + '</span></div>';
        }).join('') + '</div>'));
    } else {
      cards.push('<div class="fv-panel">' + needSession() + '</div>');
    }

    var nerve = panel('Nervous-system links',
      '<div class="fv-rows">' + h.capabilities.filter(function (c) {
        return ['source-core', 'data-fabric', 'data-vault', 'infrastructure', 'vision-hub'].indexOf(c.key) > -1;
      }).map(function (c) {
        return '<div class="fv-row"><span class="fv-row-k">' + esc(c.label) + '</span>'
          + '<span class="fv-tag ' + (c.status === 'LIVE' ? 'fv-tag--measured' : 'fv-tag--future')
          + '">' + esc(c.status.replace(/_/g, ' ')) + '</span></div>';
      }).join('') + '</div>');

    body('<div class="fv-grid">' + cards.join('') + '</div>'
      + '<div style="height:14px"></div>' + '<div class="fv-grid fv-grid--wide">' + nerve + '</div>');
  }

  // ── LIVE ANALYSIS ─────────────────────────────────────────────────────────

  function secLive() {
    head('Live Analysis', 'The annotated frame, drawn from this session\'s own observations. '
      + 'Where calibration is NONE the metric readout is suppressed, not estimated.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var sm = s.summary;
    var frame = FV.frame;
    var rows = s.tracks.filter(function (t) { return t.frameNumber === frame; });
    if (!rows.length && s.tracks.length) {
      frame = s.tracks[0].frameNumber;
      FV.frame = frame;
      rows = s.tracks.filter(function (t) { return t.frameNumber === frame; });
    }
    var cal = s.calibration.filter(function (c) { return c.frameNumber === frame; })[0] || null;
    var ballRow = s.ball.filter(function (b) { return b.frameNumber === frame; })[0] || null;
    var evHere = s.events.filter(function (e) { return e.frameNumber === frame; });

    var W = sm.source.width || 1024;
    var H = sm.source.height || 576;
    var svg = ['<svg class="fv-pitch" viewBox="0 0 ' + W + ' ' + H + '" style="background:#0a0f1a">'];
    svg.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#0c1220"/>');
    rows.forEach(function (t) {
      var colour = t.role === 'GOALKEEPER' ? '#fbbf24' : t.role === 'REFEREE' ? '#ffffff'
        : t.role === 'UNKNOWN' ? '#8b5cf6' : (t.teamId === 'team_a' ? '#22d3ee' : '#34d399');
      if (FV.overlays.boxes) {
        svg.push('<rect x="' + t.box.x1 + '" y="' + t.box.y1 + '" width="' + (t.box.x2 - t.box.x1)
          + '" height="' + (t.box.y2 - t.box.y1) + '" fill="none" stroke="' + colour
          + '" stroke-width="2" rx="3"/>');
      }
      var label = [];
      if (FV.overlays.ids) label.push(t.identity);
      if (FV.overlays.team && t.teamId) label.push(t.teamId);
      if (FV.overlays.role) label.push(t.role);
      if (label.length) {
        svg.push('<text x="' + t.box.x1 + '" y="' + Math.max(12, t.box.y1 - 5)
          + '" fill="' + colour + '" font-size="12" font-family="monospace">'
          + esc(label.join(' ')) + '</text>');
      }
    });
    if (FV.overlays.ball && ballRow && ballRow.imageX !== null) {
      var bc = ballRow.state === 'OBSERVED' ? '#ffffff' : '#fbbf24';
      svg.push('<circle cx="' + ballRow.imageX + '" cy="' + ballRow.imageY + '" r="7" fill="none" stroke="'
        + bc + '" stroke-width="2"/>');
      svg.push('<text x="' + (ballRow.imageX + 10) + '" y="' + (ballRow.imageY - 8) + '" fill="' + bc
        + '" font-size="11" font-family="monospace">' + esc(ballRow.state) + '</text>');
    }
    svg.push('</svg>');

    var toggles = Object.keys(FV.overlays).map(function (k) {
      return '<button class="fv-chip' + (FV.overlays[k] ? ' fv-s-LIVE' : '') + '" data-fv-overlay="' + k
        + '" type="button"><span class="fv-dot"></span>' + esc(k) + '</button>';
    }).join('');

    var metricLine = cal && cal.chain !== 'none'
      ? '<span class="fv-tag fv-tag--' + (cal.chain === 'measured' ? 'measured' : 'propagated') + '">'
        + esc(cal.chain.toUpperCase()) + ' · ' + esc(cal.confidence) + ' · ±'
        + n(cal.expectedErrorM, 3) + ' m</span>'
      : '<span class="fv-tag fv-tag--withheld">CALIBRATION NONE — NO METRIC CLAIM</span>';

    var readout = '<div class="fv-rows">'
      + '<div class="fv-row"><span class="fv-row-k">frame</span><span class="fv-row-v">' + esc(frame) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">timestamp</span><span class="fv-row-v">'
        + n(rows.length ? rows[0].timestamp : null, 3) + ' s</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">session</span><span class="fv-row-v">' + esc(sm.sessionRef) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">source</span><span class="fv-row-v">' + esc(sm.source.displayName) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">source quality</span><span class="fv-row-v">'
        + esc(sm.source.qualityBand || '—') + ' · ' + n(sm.source.qualityScore, 2) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">video fps</span><span class="fv-row-v">' + n(sm.source.fps, 3) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">processing fps</span><span class="fv-row-v">' + n(sm.processingFps, 2) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">tracks in frame</span><span class="fv-row-v">' + rows.length + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">ball</span><span class="fv-row-v">'
        + (ballRow ? esc(ballRow.state) : '<span class="fv-none">—</span>') + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">events here</span><span class="fv-row-v">' + evHere.length + '</span></div>'
      + '</div>'
      + '<div style="margin-top:10px">' + metricLine + '</div>'
      + '<div class="fv-note">Provider ' + esc((sm.providers[0] || {}).provider || '—')
      + ' · pipeline ' + esc(sm.pipelineVersion || '—') + '</div>';

    var frames = [];
    var step = Math.max(1, Math.floor(sm.framesProcessed / 40));
    for (var f = 0; f < sm.framesProcessed; f += step) {
      frames.push('<button class="fv-chip' + (f === frame ? ' fv-s-LIVE' : '') + '" data-fv-seek="' + f
        + '" type="button">' + f + '</button>');
    }

    body('<div style="display:grid;grid-template-columns:minmax(0,2.1fr) minmax(260px,1fr);gap:14px">'
      + panel('Annotated feed', '<div class="fv-pitch-wrap">' + svg.join('') + '</div>'
        + '<div class="fv-rail" style="padding:10px 0 0;border:none;background:none">' + toggles + '</div>'
        + '<div class="fv-note">The original feed is the source video. This module draws the '
        + 'ANNOTATION layer from stored observations; it does not re-decode the video, and no '
        + 'box here was placed by hand.</div>',
        '<span class="fv-tag fv-tag--accent">FRAME ' + esc(frame) + '</span>')
      + panel('Readout', readout)
      + '</div>'
      + '<div style="height:14px"></div>'
      + panel('Seek', '<div class="fv-rail" style="padding:0;border:none;background:none">'
        + frames.join('') + '</div>'));
  }

  // ── SOURCES ───────────────────────────────────────────────────────────────

  function secSources() {
    head('Sources', 'Fourteen source types are named. One is implemented. The difference is '
      + 'drawn rather than hidden.');
    if (!FV.sources) { body('<div class="fv-empty fv-empty--withheld">Reading sources…</div>'); return; }
    if (FV.sources.ok === false) { body(empty('withheld', 'SOURCES UNAVAILABLE', FV.sources.error || '')); return; }

    var types = FV.sources.types.map(function (t) {
      var tag = t.implemented ? '<span class="fv-tag fv-tag--measured">IMPLEMENTED</span>'
        : '<span class="fv-tag fv-tag--future">NOT IMPLEMENTED</span>';
      var wait = t.waitingOn === 'NOTHING' ? ''
        : '<span class="fv-tag fv-tag--future">' + esc(t.waitingOn.replace(/_/g, ' ')) + '</span>';
      return '<tr><td><b style="color:var(--fv-tx)">' + esc(t.label) + '</b><br>'
        + '<span style="font-size:10.5px;color:var(--fv-tx-3)">' + esc(t.type) + '</span></td>'
        + '<td>' + tag + ' ' + wait + '</td>'
        + '<td style="max-width:44ch">' + esc(t.describes) + '</td></tr>';
    }).join('');

    var slots = FV.sources.slots.map(function (s) {
      return '<div class="fv-row"><span class="fv-row-k">' + esc(s.label)
        + ' <span style="font-size:10.5px;color:var(--fv-tx-3)">→ ' + esc(s.intendedType) + '</span></span>'
        + '<span class="fv-tag fv-tag--future">' + esc(s.waitingOn.replace(/_/g, ' ')) + '</span></div>';
    }).join('');

    var connected = FV.sources.connected.length
      ? FV.sources.connected.map(function (c) {
        return '<div class="fv-row"><span class="fv-row-k">' + esc(c.displayName)
          + ' <span style="font-size:10.5px;color:var(--fv-tx-3)">' + esc(c.sourceType) + '</span></span>'
          + '<span class="fv-row-v">' + esc(c.width) + '×' + esc(c.height) + ' · ' + n(c.fps, 2) + ' fps</span></div>';
      }).join('')
      : '<div class="fv-note">No source is attached. The sessions below were produced by the engine '
        + 'from recorded video; a live source would appear here.</div>';

    body('<div class="fv-grid fv-grid--wide">'
      + panel('Sources in use', '<div class="fv-rows">' + connected + '</div>')
      + panel('Future rig slots', '<div class="fv-rows">' + slots + '</div>',
        '<span class="fv-tag fv-tag--future">ALL EMPTY</span>')
      + '</div><div style="height:14px"></div>'
      + panel('Source type vocabulary',
        '<div class="fv-table-scroll"><table class="fv-table"><thead><tr>'
        + '<th>Type</th><th>State</th><th>What is actually behind it</th></tr></thead><tbody>'
        + types + '</tbody></table></div>'
        + '<div class="fv-note fv-note--loud">Camera manufacturer is metadata. Nothing in the Vision '
        + 'engine branches on brand — a Sony body is a video source with Sony on its label, and the '
        + 'day that stops being true is the day Familista Vision becomes a Sony product.</div>'));
  }

  // ── SESSIONS ──────────────────────────────────────────────────────────────

  function secSessions() {
    head('Sessions', 'Each row is one processed session. Opening one loads its own evidence; '
      + 'nothing here is aggregated across sessions.');
    if (!FV.sessions) { body('<div class="fv-empty fv-empty--withheld">Reading sessions…</div>'); return; }
    if (FV.sessions.ok === false) {
      body(empty('withheld', 'SESSIONS UNAVAILABLE',
        FV.sessions.reason || FV.sessions.error || 'the session store did not answer'));
      return;
    }
    if (!FV.sessions.sessions.length) {
      body(empty('absent', 'NO SESSIONS VISIBLE',
        'This account has access to no Vision session. A session with no declared club is '
        + 'platform-scoped and visible to the platform owner only.'));
      return;
    }
    var rows = FV.sessions.sessions.map(function (s) {
      return '<tr data-fv-open-session="' + esc(s.sessionRef) + '" style="cursor:pointer">'
        + '<td><b style="color:var(--fv-tx)">' + esc(s.sessionRef) + '</b><br>'
        + '<span style="font-size:10.5px;color:var(--fv-tx-3)">' + esc(s.sessionId) + '</span></td>'
        + '<td>' + esc(s.source.displayName) + '<br><span style="font-size:10.5px;color:var(--fv-tx-3)">'
        + esc(s.source.width) + '×' + esc(s.source.height) + ' · ' + n(s.source.fps, 2) + ' fps</span></td>'
        + '<td>' + esc(s.framesProcessed) + '</td>'
        + '<td>' + esc(s.observationsTotal) + '</td>'
        + '<td>' + pct(s.calibrationCoverage) + '</td>'
        + '<td>' + esc(s.ballStates.OBSERVED || 0) + ' / ' + esc(s.ballStates.PROPAGATED || 0) + '</td>'
        + '<td>' + (s.clubId ? esc(s.clubId) : '<span class="fv-tag fv-tag--withheld">PLATFORM</span>') + '</td>'
        + '</tr>';
    }).join('');
    body(panel('Sessions', '<div class="fv-table-scroll"><table class="fv-table"><thead><tr>'
      + '<th>Session</th><th>Source</th><th>Frames</th><th>Observations</th>'
      + '<th>Calibration</th><th>Ball obs/prop</th><th>Scope</th></tr></thead><tbody>'
      + rows + '</tbody></table></div>'
      + '<div class="fv-note">A session with no declared club is platform-scoped: the platform owner '
      + 'sees it and nobody else does. Ownership is declared beside the evidence, never guessed from '
      + 'a filename.</div>'));
  }

  // ── PLAYER TRACKING ───────────────────────────────────────────────────────

  function secTracking() {
    head('Player Tracking', 'Real tracks from this session. A pitch position appears only where '
      + 'calibration published one.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var caps = s.summary.capabilities;

    var byIdentity = {};
    s.tracks.forEach(function (t) {
      var r = byIdentity[t.identity] || (byIdentity[t.identity] = {
        identity: t.identity, trackId: t.trackId, team: t.teamId, role: t.role,
        obs: 0, withCoords: 0, conf: 0, first: t.frameNumber, last: t.frameNumber,
      });
      r.obs += 1;
      if (t.pitchXM !== null) r.withCoords += 1;
      if (t.classificationConfidence) r.conf = Math.max(r.conf, t.classificationConfidence);
      r.last = t.frameNumber;
    });
    var list = Object.keys(byIdentity).map(function (k) { return byIdentity[k]; })
      .sort(function (a, b) { return b.obs - a.obs; });

    var rows = list.map(function (r) {
      return '<tr><td><b style="color:var(--fv-tx)">' + esc(r.identity) + '</b></td>'
        + '<td>' + esc(r.trackId) + '</td>'
        + '<td>' + (r.team ? esc(r.team) : '<span class="fv-tag fv-tag--withheld">NONE</span>') + '</td>'
        + '<td>' + (r.role === 'UNKNOWN' ? '<span class="fv-tag fv-tag--withheld">UNKNOWN</span>' : esc(r.role)) + '</td>'
        + '<td>' + n(r.conf || null, 2) + '</td>'
        + '<td>' + esc(r.obs) + '</td>'
        + '<td>' + esc(r.withCoords) + '</td>'
        + '<td>' + esc(r.first) + '–' + esc(r.last) + '</td>'
        + '<td><button class="fv-chip" data-fv-seek="' + esc(r.first) + '" type="button">seek</button></td></tr>';
    }).join('');

    var pitch = caps.metricCoordinates ? pitchSvg(s, 'tracks')
      : empty('withheld', 'NO METRIC POSITIONS', caps.reasons.metricCoordinates || '');

    body('<div class="fv-grid fv-grid--wide">'
      + panel('Calibrated positions', pitch,
        '<span class="fv-tag fv-tag--measured">' + s.summary.observationsWithPitchCoords + ' POSITIONS</span>')
      + '</div><div style="height:14px"></div>'
      + panel('Identities', '<div class="fv-table-scroll"><table class="fv-table"><thead><tr>'
        + '<th>Identity</th><th>Track</th><th>Team</th><th>Role</th><th>Conf</th>'
        + '<th>Observations</th><th>With metric position</th><th>Frames</th><th></th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div class="fv-note">A trajectory is drawn only from positions the engine published. '
        + 'Gaps are left as gaps — nothing is interpolated across a frame where calibration was NONE.</div>'));
  }

  /** The pitch in METRES, Law 1. A dot's position is its own coordinate. */
  function pitchSvg(s, mode) {
    var L = 105, W = 68;
    var out = ['<svg class="fv-pitch" viewBox="-3 -3 ' + (L + 6) + ' ' + (W + 6) + '">'];
    out.push('<rect x="0" y="0" width="' + L + '" height="' + W + '" class="fv-pitch-line"/>');
    out.push('<line x1="' + (L / 2) + '" y1="0" x2="' + (L / 2) + '" y2="' + W + '" class="fv-pitch-line"/>');
    out.push('<circle cx="' + (L / 2) + '" cy="' + (W / 2) + '" r="9.15" class="fv-pitch-line"/>');
    out.push('<rect x="0" y="' + ((W - 40.32) / 2) + '" width="16.5" height="40.32" class="fv-pitch-line"/>');
    out.push('<rect x="' + (L - 16.5) + '" y="' + ((W - 40.32) / 2) + '" width="16.5" height="40.32" class="fv-pitch-line"/>');
    out.push('<rect x="0" y="' + ((W - 18.32) / 2) + '" width="5.5" height="18.32" class="fv-pitch-line"/>');
    out.push('<rect x="' + (L - 5.5) + '" y="' + ((W - 18.32) / 2) + '" width="5.5" height="18.32" class="fv-pitch-line"/>');

    if (mode === 'tracks') {
      s.tracks.forEach(function (t) {
        if (t.pitchXM === null || t.pitchYM === null) return;
        out.push('<circle cx="' + t.pitchXM + '" cy="' + t.pitchYM + '" r="0.5" class="'
          + (t.calibrationChain === 'measured' ? 'fv-dotm' : 'fv-dotp') + '" opacity="0.5"/>');
      });
    } else if (mode === 'ball') {
      s.ball.forEach(function (b) {
        if (b.pitchXM === null) return;
        out.push('<circle cx="' + b.pitchXM + '" cy="' + b.pitchYM + '" r="0.7" class="fv-dotball"/>');
      });
    }
    out.push('</svg>');
    return '<div class="fv-pitch-wrap">' + out.join('') + '</div>'
      + '<div class="fv-rail" style="padding:10px 0 0;border:none;background:none">'
      + '<span class="fv-chip fv-s-LIVE"><span class="fv-dot"></span>MEASURED anchor frame</span>'
      + '<span class="fv-chip fv-s-DEGRADED"><span class="fv-dot"></span>PROPAGATED from an anchor</span>'
      + '</div>';
  }

  // ── BALL ──────────────────────────────────────────────────────────────────

  function secBall() {
    head('Ball Tracking', 'OBSERVED and PROPAGATED are two different findings and are never merged.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var st = s.summary.ballStates;

    var counts = ['OBSERVED', 'PROPAGATED', 'UNKNOWN', 'NOT_AVAILABLE'].map(function (k) {
      var tag = k === 'OBSERVED' ? 'measured' : k === 'PROPAGATED' ? 'propagated' : 'withheld';
      return panel(k.replace(/_/g, ' '), metric(esc(st[k] || 0), 'frames',
        k === 'OBSERVED' ? 'the ball was directly detected'
          : k === 'PROPAGATED' ? 'carried through measured camera motion, not observed'
            : k === 'UNKNOWN' ? 'the ball could not be located'
              : 'no ball evidence was produced for these frames'),
        '<span class="fv-tag fv-tag--' + tag + '">' + esc(k.replace(/_/g, ' ')) + '</span>');
    }).join('');

    var rows = s.ball.filter(function (b) { return b.state === 'OBSERVED' || b.state === 'PROPAGATED'; })
      .slice(0, 400).map(function (b) {
        return '<tr><td>' + esc(b.frameNumber) + '</td><td>' + n(b.timestamp, 2) + '</td>'
          + '<td><span class="fv-tag fv-tag--' + (b.state === 'OBSERVED' ? 'measured' : 'propagated')
          + '">' + esc(b.state) + '</span></td>'
          + '<td>' + n(b.imageX, 0) + ', ' + n(b.imageY, 0) + '</td>'
          + '<td>' + (b.pitchXM === null ? '<span class="fv-none">—</span>'
            : n(b.pitchXM, 1) + ', ' + n(b.pitchYM, 1)) + '</td>'
          + '<td>' + n(b.trackingConfidence, 2) + '</td>'
          + '<td>' + n(b.detectionConfidence, 2) + '</td>'
          + '<td>' + n(b.framesSinceObservation, 0) + '</td>'
          + '<td>' + (b.nearestPlayer ? esc(b.nearestPlayer) : '<span class="fv-none">—</span>') + '</td>'
          + '<td>' + n(b.nearestDistanceM, 2) + '</td>'
          + '<td style="max-width:40ch;font-size:11px">' + esc(b.reason || '—') + '</td>'
          + '<td><button class="fv-chip" data-fv-seek="' + esc(b.frameNumber) + '" type="button">seek</button></td></tr>';
      }).join('');

    body('<div class="fv-grid">' + counts + '</div><div style="height:14px"></div>'
      + '<div class="fv-note fv-note--loud" style="margin-bottom:14px">PROXIMITY IS NOT POSSESSION. '
      + 'The nearest player and the distance below are geometry. Nothing in this table asserts a touch, '
      + 'a control or a possession, and the engine does not infer one from distance.</div>'
      + panel('Ball samples', '<div class="fv-table-scroll"><table class="fv-table"><thead><tr>'
        + '<th>Frame</th><th>t (s)</th><th>State</th><th>Image x,y</th><th>Pitch x,y (m)</th>'
        + '<th>Track conf</th><th>Det conf</th><th>Since obs</th><th>Nearest</th><th>Dist (m)</th><th>Why</th><th></th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>',
        '<span class="fv-tag fv-tag--withheld">FIRST 400 SHOWN</span>')
      + '<div style="height:14px"></div>'
      + (s.summary.calibratedBallFrames > 0
        ? panel('Ball on the pitch', pitchSvg(s, 'ball'),
          '<span class="fv-tag fv-tag--measured">' + s.summary.calibratedBallFrames + ' CALIBRATED</span>')
        : empty('withheld', 'NO CALIBRATED BALL POSITIONS',
          'The ball was located in image space but calibration published no pitch coordinate for '
          + 'those frames, so no metric ball position exists.')));
  }

  // ── PITCH CALIBRATION ─────────────────────────────────────────────────────

  function secCalibration() {
    head('Pitch Calibration', 'What was accepted, what was rejected, and where no metric claim '
      + 'may be made at all.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var sm = s.summary;
    var anchors = s.calibration.filter(function (c) { return c.isAnchor; });
    var none = s.calibration.filter(function (c) { return c.chain === 'none'; });
    var bands = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
    anchors.forEach(function (a) { bands[a.confidence] = (bands[a.confidence] || 0) + 1; });
    var errs = anchors.map(function (a) { return a.expectedErrorM; })
      .filter(function (e) { return e !== null; });

    var cards = [
      panel('Coverage', metric(pct(sm.calibrationCoverage), '',
        sm.calibrationMeasuredFrames + ' measured · ' + sm.calibrationPropagatedFrames + ' propagated frames')
        + '<div class="fv-bar"><i style="width:' + ((sm.calibrationCoverage || 0) * 100) + '%"></i></div>'),
      panel('Accepted anchors', metric(esc(anchors.length), '',
        'HIGH ' + bands.HIGH + ' · MEDIUM ' + bands.MEDIUM + ' · LOW ' + bands.LOW),
        '<span class="fv-tag fv-tag--measured">MEASURED</span>'),
      panel('Expected metric error', metric(
        errs.length ? n(Math.min.apply(null, errs), 3) + '–' + n(Math.max.apply(null, errs), 3)
          : '<span class="fv-none">—</span>', 'm',
        'cross-validated, not measured against ground truth')),
      panel('Anchor disagreement', metric(n(sm.anchorDisagreementMedianM, 3), 'm',
        'a fresh anchor against the propagated chain it replaced')),
      panel('Frames with NONE', metric(esc(none.length), 'frames',
        'no metric coordinate was published for these and none may be inferred'),
        '<span class="fv-tag fv-tag--withheld">WITHHELD</span>'),
      panel('Coordinates on pitch', metric(pct(sm.coordsOnPitchRate), '',
        sm.observationsWithPitchCoords + ' published positions, of which this fraction land inside '
        + 'the pitch rectangle')),
    ].join('');

    var rows = anchors.map(function (a) {
      return '<tr><td>' + esc(a.frameNumber) + '</td>'
        + '<td><span class="fv-tag fv-tag--' + (a.confidence === 'HIGH' ? 'measured'
          : a.confidence === 'NONE' ? 'withheld' : 'propagated') + '">' + esc(a.confidence) + '</span></td>'
        + '<td>' + n(a.expectedErrorM, 3) + '</td>'
        + '<td>' + n(a.score, 4) + '</td>'
        + '<td style="max-width:48ch;font-size:11px">' + (a.landmark ? esc(a.landmark)
          : '<span class="fv-none">—</span>') + '</td>'
        + '<td><button class="fv-chip" data-fv-seek="' + esc(a.frameNumber) + '" type="button">seek</button></td></tr>';
    }).join('');

    var guards = sm.guards || {};
    var guardRows = '<div class="fv-rows">'
      + '<div class="fv-row"><span class="fv-row-k">Speed-guard spans examined</span>'
        + '<span class="fv-row-v">' + n(guards.speedGuardSpans) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Spans withheld as physically impossible</span>'
        + '<span class="fv-row-v">' + n(guards.speedGuardSpansWithheld) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Frames whose coordinates were withheld</span>'
        + '<span class="fv-row-v">' + n(guards.speedGuardFramesWithheld) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Worst p90 implied speed</span>'
        + '<span class="fv-row-v">' + n(guards.speedGuardP90MsMax, 1) + ' m/s</span></div>'
      + '</div><div class="fv-note">The physical guard only ever WITHHOLDS. It never rescales or '
      + 'repairs a coordinate, because nothing in the system knows what the right scale would '
      + 'have been.</div>';

    body('<div class="fv-grid">' + cards + '</div><div style="height:14px"></div>'
      + '<div class="fv-grid fv-grid--wide">'
      + panel('Accepted anchors', (rows
        ? '<div class="fv-table-scroll"><table class="fv-table"><thead><tr><th>Frame</th>'
          + '<th>Band</th><th>Expected error (m)</th><th>Score</th><th>Landmark evidence</th><th></th>'
          + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : empty('withheld', 'NO ANCHOR ACCEPTED',
          'Every candidate failed the validity gate, so this session carries no metric geometry.'))
        + (rows ? '<div class="fv-note">Landmark evidence reads as an em dash because this '
          + 'engine schema records the landmark sentence on the calibration state rather than on '
          + 'each frame\'s provenance. An em dash here means the platform does not hold the '
          + 'figure — it does not mean the anchor had no evidence.</div>' : ''))
      + panel('Validation guards', guardRows)
      + '</div>');
  }

  // ── TEAMS & ROLES ─────────────────────────────────────────────────────────

  function secTeams() {
    head('Teams & Roles', 'No classification is forced. UNKNOWN is an answer and it is kept.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var teams = {};
    s.tracks.forEach(function (t) {
      var k = t.teamId || 'UNASSIGNED';
      (teams[k] || (teams[k] = { identities: {}, obs: 0 }));
      teams[k].identities[t.identity] = 1;
      teams[k].obs += 1;
    });
    var roleCount = {};
    s.tracks.forEach(function (t) { roleCount[t.role] = (roleCount[t.role] || 0) + 1; });

    var teamCards = Object.keys(teams).map(function (k) {
      return panel(k === 'UNASSIGNED' ? 'No team assigned' : k.toUpperCase(),
        metric(esc(Object.keys(teams[k].identities).length), 'identities',
          teams[k].obs + ' observations'),
        k === 'UNASSIGNED' ? '<span class="fv-tag fv-tag--withheld">UNKNOWN</span>' : '');
    }).join('');

    var roleCards = Object.keys(roleCount).sort().map(function (r) {
      return panel(r, metric(esc(roleCount[r]), 'observations',
        r === 'UNKNOWN' ? 'evidence was insufficient to decide; nothing was forced'
          : r === 'GOALKEEPER' ? 'decided on metric position, not on kit colour'
            : r === 'REFEREE' ? 'neither kit, not confined to a penalty area'
              : 'kit matched a team cluster'),
        r === 'UNKNOWN' ? '<span class="fv-tag fv-tag--withheld">UNKNOWN</span>' : '');
    }).join('');

    var rows = s.roles.map(function (r) {
      return '<tr><td><b style="color:var(--fv-tx)">' + esc(r.identity) + '</b></td>'
        + '<td>' + (r.role === 'UNKNOWN' ? '<span class="fv-tag fv-tag--withheld">UNKNOWN</span>'
          : esc(r.role)) + '</td>'
        + '<td>' + n(r.confidence, 2) + '</td>'
        + '<td>' + n(r.observations) + '</td>'
        + '<td style="max-width:60ch;font-size:11px">' + esc(r.reason || '—') + '</td></tr>';
    }).join('');

    body('<div class="fv-grid">' + teamCards + roleCards + '</div><div style="height:14px"></div>'
      + panel('Role evidence', rows
        ? '<div class="fv-table-scroll"><table class="fv-table"><thead><tr><th>Identity</th>'
          + '<th>Role</th><th>Confidence</th><th>Observations</th><th>Reason</th>'
          + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : empty('absent', 'NO ROLE EVIDENCE RECORDED',
          'This session produced no per-identity role reasoning.')));
  }

  // ── EVENTS ────────────────────────────────────────────────────────────────

  function secEvents() {
    head('Events', 'Only findings the validated engine emitted. Clicking one seeks to its frame.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    if (!s.events.length) {
      body(empty('withheld', 'NO EVENTS CONFIRMED',
        s.summary.capabilities.reasons.events
        || 'The engine confirmed no football event in this session.'));
      return;
    }
    var counts = {};
    s.events.forEach(function (e) {
      var k = e.type + ' · ' + e.state;
      counts[k] = (counts[k] || 0) + 1;
    });
    var cards = Object.keys(counts).map(function (k) {
      return panel(k, metric(esc(counts[k]), '', k.indexOf('PROXIMITY') === 0
        ? 'distance only. This asserts no touch and no possession.'
        : 'confirmed against ball evidence'),
        k.indexOf('PROXIMITY') === 0 ? '<span class="fv-tag fv-tag--withheld">NOT POSSESSION</span>'
          : '<span class="fv-tag fv-tag--measured">CONFIRMED</span>');
    }).join('');

    var rows = s.events.map(function (e) {
      return '<tr><td style="font-size:10.5px">' + esc(e.eventId) + '</td>'
        + '<td>' + esc(e.type) + '</td>'
        + '<td>' + esc(e.state) + '</td>'
        + '<td>' + esc(e.frameNumber) + '</td>'
        + '<td>' + n(e.timestamp, 2) + '</td>'
        + '<td>' + (e.trackIds.length ? esc(e.trackIds.join(', ')) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + (e.teamId ? esc(e.teamId) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + (e.ballState ? esc(e.ballState) : '<span class="fv-none">—</span>') + '</td>'
        + '<td>' + (e.pitchXM === null ? '<span class="fv-none">—</span>'
          : n(e.pitchXM, 1) + ', ' + n(e.pitchYM, 1)) + '</td>'
        + '<td>' + n(e.confidence, 2) + '</td>'
        + '<td><span class="fv-tag fv-tag--' + (e.origin === 'MEASURED' ? 'measured'
          : e.origin === 'PROPAGATED' ? 'propagated' : 'withheld') + '">' + esc(e.origin) + '</span></td>'
        + '<td style="max-width:40ch;font-size:11px">' + esc(e.reason || '—') + '</td>'
        + '<td><button class="fv-chip" data-fv-seek="' + esc(e.frameNumber) + '" type="button">seek</button></td>'
        + '</tr>';
    }).join('');

    body('<div class="fv-grid">' + cards + '</div><div style="height:14px"></div>'
      + panel('Events', '<div class="fv-table-scroll"><table class="fv-table"><thead><tr>'
        + '<th>Event</th><th>Type</th><th>State</th><th>Frame</th><th>t (s)</th><th>Tracks</th>'
        + '<th>Team</th><th>Ball</th><th>Pitch (m)</th><th>Conf</th><th>Origin</th><th>Reason</th><th></th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'));
  }

  // ── TACTICAL ──────────────────────────────────────────────────────────────

  function secTactical() {
    head('Tactical View', 'The architecture and the data contract exist. The evidence does not.');
    var caps = FV.session && FV.session.summary.capabilities;
    body(empty('future', 'TACTICAL INTELLIGENCE — PENDING VALIDATED EVIDENCE',
      (caps && caps.reasons.tactical)
      || 'Tactical intelligence is not implemented in the validated engine. No formation, team '
        + 'shape, zone, controlled space, passing lane, pressing, overload or transition result '
        + 'exists to display, and drawing one from position data alone would be a diagram of an '
        + 'assumption rather than a finding.')
      + '<div style="height:14px"></div>'
      + panel('What a tactical result would need', '<div class="fv-rows">'
        + '<div class="fv-row"><span class="fv-row-k">Sustained metric coverage across both teams</span>'
          + '<span class="fv-tag fv-tag--future">NOT MET</span></div>'
        + '<div class="fv-row"><span class="fv-row-k">Possession attribution beyond confirmed control</span>'
          + '<span class="fv-tag fv-tag--future">NOT IMPLEMENTED</span></div>'
        + '<div class="fv-row"><span class="fv-row-k">Human-verified ground truth to validate against</span>'
          + '<span class="fv-tag fv-tag--future">NONE EXISTS</span></div>'
        + '</div>'
        + '<div class="fv-note">The contract is in place — a tactical result would arrive as its own '
        + 'evidence type with its own confidence, through the same session API. Nothing about this '
        + 'screen would need rebuilding. What is missing is the finding, not the plumbing.</div>'));
  }

  // ── HEATMAPS ──────────────────────────────────────────────────────────────

  function secHeatmaps() {
    head('Heatmaps', 'Generated only from genuine calibrated history. Never decorative.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session;
    var caps = s.summary.capabilities;
    if (!caps.heatmaps) {
      body(empty('withheld', 'INSUFFICIENT CALIBRATED TRACKING DATA', caps.reasons.heatmaps || ''));
      return;
    }
    // A 21×14 grid over the pitch: five metres a cell. Counts, not a smoothed
    // field — a smoothed field invents density between two real observations.
    var CX = 21, CY = 14;
    var grid = [];
    for (var i = 0; i < CX * CY; i++) grid.push(0);
    var max = 0;
    s.tracks.forEach(function (t) {
      if (t.pitchXM === null || t.pitchYM === null) return;
      var cx = Math.min(CX - 1, Math.max(0, Math.floor(t.pitchXM / (105 / CX))));
      var cy = Math.min(CY - 1, Math.max(0, Math.floor(t.pitchYM / (68 / CY))));
      var idx = cy * CX + cx;
      grid[idx] += 1;
      if (grid[idx] > max) max = grid[idx];
    });
    var cells = [];
    for (var y = 0; y < CY; y++) {
      for (var x = 0; x < CX; x++) {
        var v = grid[y * CX + x];
        if (!v) continue;
        var a = Math.pow(v / max, 0.6);
        cells.push('<rect x="' + (x * (105 / CX)) + '" y="' + (y * (68 / CY)) + '" width="' + (105 / CX)
          + '" height="' + (68 / CY) + '" fill="rgba(34,211,238,' + a.toFixed(3) + ')"/>');
      }
    }
    var svg = '<svg class="fv-pitch" viewBox="-3 -3 111 74">' + cells.join('')
      + '<rect x="0" y="0" width="105" height="68" class="fv-pitch-line"/>'
      + '<line x1="52.5" y1="0" x2="52.5" y2="68" class="fv-pitch-line"/>'
      + '<circle cx="52.5" cy="34" r="9.15" class="fv-pitch-line"/>'
      + '<rect x="0" y="13.84" width="16.5" height="40.32" class="fv-pitch-line"/>'
      + '<rect x="88.5" y="13.84" width="16.5" height="40.32" class="fv-pitch-line"/></svg>';

    body(panel('Occupancy', '<div class="fv-pitch-wrap">' + svg + '</div>'
      + '<div class="fv-note">Built from ' + s.summary.observationsWithPitchCoords + ' calibrated '
      + 'positions, counted into five-metre cells. Nothing is smoothed and nothing is interpolated '
      + 'between observations, so an empty cell means no calibrated position landed there rather '
      + 'than low activity.</div>',
      '<span class="fv-tag fv-tag--measured">' + s.summary.observationsWithPitchCoords + ' POSITIONS</span>'));
  }

  // ── PHYSICAL METRICS ──────────────────────────────────────────────────────

  function secPhysical() {
    head('Physical Metrics', 'The contract exists. The validated measurement does not.');
    var g = FV.session && FV.session.summary.guards;
    body(empty('future', 'PHYSICAL METRICS — NOT YET VALIDATED',
      (FV.session && FV.session.summary.capabilities.reasons.physicalMetrics)
      || 'The engine measures implied speed only as a calibration guard, and it is deliberately '
        + 'not exposed as a player measurement.')
      + '<div style="height:14px"></div>'
      + '<div class="fv-grid">'
      + ['Speed', 'Acceleration', 'Distance', 'High-speed running', 'Sprints', 'Stamina / load']
        .map(function (k) {
          return panel(k, '<div class="fv-metric"><span class="fv-metric-v fv-none">—</span></div>'
            + '<div class="fv-metric-k">not calculated</div>',
            '<span class="fv-tag fv-tag--future">NOT YET VALIDATED</span>');
        }).join('')
      + '</div>'
      + (g ? '<div style="height:14px"></div>' + panel('What the engine does measure, and why it is not this',
        '<div class="fv-rows">'
        + '<div class="fv-row"><span class="fv-row-k">Worst p90 implied speed in a calibrated span</span>'
          + '<span class="fv-row-v">' + n(g.speedGuardP90MsMax, 1) + ' m/s</span></div>'
        + '<div class="fv-row"><span class="fv-row-k">Spans withheld as physically impossible</span>'
          + '<span class="fv-row-v">' + n(g.speedGuardSpansWithheld) + '</span></div>'
        + '</div>'
        + '<div class="fv-note fv-note--loud">This is a GUARD statistic. It exists to reject a '
        + 'calibration whose metres imply people outrunning the world record, and it is computed '
        + 'over a whole span rather than per player. Presenting it as a player\'s speed would be '
        + 'presenting a validation threshold as a performance measurement.</div>') : ''));
  }

  // ── TIMELINE ──────────────────────────────────────────────────────────────

  function secTimeline() {
    head('Timeline', 'The session as a strip of time, with the gaps drawn as gaps.');
    if (!FV.session) { body(needSession()); return; }
    if (!FV.timeline) { body('<div class="fv-empty fv-empty--withheld">Reading timeline…</div>'); return; }
    var tl = FV.timeline;
    var total = Math.max(1, tl.frames);

    function bandHtml(label, kinds, cls) {
      var spans = tl.spans.filter(function (s) { return kinds.indexOf(s.kind) > -1; })
        .map(function (s) {
          var left = (s.fromFrame / total) * 100;
          var width = Math.max(0.25, ((s.toFrame - s.fromFrame + 1) / total) * 100);
          var k = s.kind.indexOf('VALID') > -1 || s.kind.indexOf('OBSERVED') > -1
            ? (s.kind.indexOf('OBSERVED') > -1 ? 'obs' : 'valid')
            : s.kind.indexOf('PROPAGATED') > -1 ? 'prop'
              : s.kind.indexOf('GAP') > -1 ? 'gap' : 'none';
          return '<div class="fv-tl-span fv-tl-span--' + k + '" style="left:' + left + '%;width:'
            + width + '%" title="' + esc(s.kind + ' · frames ' + s.fromFrame + '–' + s.toFrame) + '"></div>';
        }).join('');
      return '<div class="fv-tl-band"><div class="fv-tl-label">' + esc(label) + '</div>'
        + '<div class="fv-tl-track">' + spans + '</div></div>';
    }

    function markHtml(label, kind, cls) {
      var marks = tl.marks.filter(function (m) { return m.kind === kind; })
        .map(function (m) {
          return '<div class="fv-tl-mark fv-tl-mark--' + cls + '" style="left:' + ((m.frame / total) * 100)
            + '%" title="' + esc(m.label + (m.detail ? ' — ' + m.detail : '')) + '" '
            + 'data-fv-seek="' + esc(m.frame) + '"></div>';
        }).join('');
      return '<div class="fv-tl-band"><div class="fv-tl-label">' + esc(label) + '</div>'
        + '<div class="fv-tl-track">' + marks + '</div></div>';
    }

    var legend = Object.keys(tl.legend).map(function (k) {
      return '<div class="fv-row"><span class="fv-row-k">' + esc(k.replace(/_/g, ' '))
        + '</span><span class="fv-row-v" style="font-size:11px;color:var(--fv-tx-3);text-align:left;max-width:56ch">'
        + esc(tl.legend[k]) + '</span></div>';
    }).join('');

    body(panel('Session timeline · ' + tl.durationSeconds + ' s · ' + tl.frames + ' frames',
      '<div class="fv-tl">'
      + bandHtml('Calibration', ['CALIBRATION_VALID', 'CALIBRATION_PROPAGATED', 'CALIBRATION_NONE'])
      + bandHtml('Ball', ['BALL_OBSERVED', 'BALL_PROPAGATED', 'BALL_GAP'])
      + markHtml('Anchors', 'CALIBRATION_ANCHOR', 'anchor')
      + markHtml('Shot cuts', 'SHOT_BOUNDARY', 'cut')
      + markHtml('Events', 'EVENT', 'event')
      + '</div>'
      + '<div class="fv-note">Click a mark to seek Live Analysis to that frame.</div>')
      + '<div style="height:14px"></div>'
      + panel('What each band means', '<div class="fv-rows">' + legend + '</div>'));
  }

  // ── REPORTS ───────────────────────────────────────────────────────────────

  function secReports() {
    head('Reports & Export', 'Every export carries the provenance needed to re-derive it.');
    if (!FV.session) { body(needSession()); return; }
    var s = FV.session.summary;
    var kinds = [
      ['session', 'Session JSON', 'the whole normalised session'],
      ['summary', 'Session summary', 'counts, coverage, providers and guards'],
      ['tracks', 'Tracking JSON', 'every observation with its calibration state'],
      ['ball', 'Ball JSON', 'every sample with OBSERVED/PROPAGATED preserved'],
      ['events', 'Events JSON', 'confirmed findings only'],
      ['calibration', 'Calibration JSON', 'per-frame verdicts and accepted anchors'],
      ['evidence', 'Intelligence evidence bundle', 'what Familista Intelligence may consume'],
      ['tracks-csv', 'Tracking CSV', 'withheld coordinates are empty cells, never zeros'],
    ].map(function (k) {
      return '<div class="fv-row"><span class="fv-row-k"><b style="color:var(--fv-tx)">' + esc(k[1])
        + '</b><br><span style="font-size:11px;color:var(--fv-tx-3)">' + esc(k[2]) + '</span></span>'
        + '<a class="fv-chip" href="' + API + '/sessions/' + encodeURIComponent(s.sessionRef)
        + '/export?kind=' + encodeURIComponent(k[0]) + '" download>download</a></div>';
    }).join('');

    var prov = '<div class="fv-rows">'
      + '<div class="fv-row"><span class="fv-row-k">Session id</span><span class="fv-row-v">' + esc(s.sessionId) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Source SHA-256</span><span class="fv-row-v" style="font-size:10.5px">'
        + esc((s.source.sha256 || '—').slice(0, 32)) + '…</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Pipeline</span><span class="fv-row-v">' + esc(s.pipelineVersion || '—') + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Generated</span><span class="fv-row-v">' + esc(s.generatedAt || '—') + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Processing target</span><span class="fv-row-v">' + esc(s.processingTarget) + '</span></div>'
      + '<div class="fv-row"><span class="fv-row-k">Club scope</span><span class="fv-row-v">'
        + (s.clubId ? esc(s.clubId) : '<span class="fv-tag fv-tag--withheld">PLATFORM</span>') + '</span></div>'
      + s.models.map(function (m) {
        return '<div class="fv-row"><span class="fv-row-k">' + esc(m.modelId) + '</span>'
          + '<span class="fv-row-v" style="font-size:10.5px">' + esc((m.checksumSha256 || '—').slice(0, 16))
          + '… · ' + esc(m.commercialUse) + '</span></div>';
      }).join('')
      + '</div>';

    body('<div class="fv-grid fv-grid--wide">'
      + panel('Exports', '<div class="fv-rows">' + kinds + '</div>')
      + panel('Provenance carried in every export', prov)
      + '</div>');
  }

  // ── DEVICE ────────────────────────────────────────────────────────────────

  function secDevice() {
    head('Device', 'What is actually running Vision. Readings this host does not have say so.');
    if (!FV.device) { body('<div class="fv-empty fv-empty--withheld">Reading device…</div>'); return; }
    if (FV.device.ok === false) { body(empty('withheld', 'DEVICE UNAVAILABLE', FV.device.error || '')); return; }
    var d = FV.device.device;
    var t = FV.device.telemetry;

    function reading(label, value, unit, caption) {
      return panel(label, metric(value, unit, caption));
    }
    function absent(label, spec) {
      var s = spec && spec.status ? spec.status : 'NOT_AVAILABLE';
      var why = spec && spec.reason ? spec.reason : 'not measured';
      return panel(label, '<div class="fv-metric"><span class="fv-metric-v fv-none">—</span></div>'
        + '<div class="fv-metric-k">' + esc(why) + '</div>',
        '<span class="fv-tag fv-tag--' + (s === 'NOT_IMPLEMENTED' ? 'future' : 'uninstrumented')
        + '">' + esc(s.replace(/_/g, ' ')) + '</span>');
    }
    var gb = function (v) { return v ? (v / 1073741824).toFixed(1) : null; };
    var telemetryIsAbsent = t && t.status;

    var cards = [
      panel('Device', '<div class="fv-metric"><span class="fv-metric-v" style="font-size:17px">'
        + esc(d.label) + '</span></div><div class="fv-metric-k">' + esc(d.deviceId) + '</div>',
        '<span class="fv-tag fv-tag--accent">' + esc(d.processingTarget) + '</span>'),
      panel('Vision Engine', metric(esc(d.status.replace(/_/g, ' ')), '',
        d.reason || 'the engine answered'),
        d.status === 'READY' || d.status === 'LIVE'
          ? '<span class="fv-tag fv-tag--measured">OK</span>'
          : '<span class="fv-tag fv-tag--future">' + esc(d.status.replace(/_/g, ' ')) + '</span>'),
    ];

    if (telemetryIsAbsent) {
      cards.push(panel('Host telemetry',
        '<div class="fv-metric"><span class="fv-metric-v fv-none">—</span></div>'
        + '<div class="fv-metric-k">' + esc(t.reason) + '</div>',
        '<span class="fv-tag fv-tag--future">' + esc(t.status.replace(/_/g, ' ')) + '</span>'));
    } else {
      cards.push(reading('CPU cores', n(t.cpuCores), '', 'load average 1m ' + n(t.loadAverage1m, 2)));
      cards.push(reading('Memory', n(gb(t.memoryTotalBytes), 1), 'GB',
        gb(t.memoryFreeBytes) + ' GB free'));
      cards.push(t.storageTotalBytes
        ? reading('Storage', n(gb(t.storageTotalBytes), 1), 'GB', gb(t.storageFreeBytes) + ' GB free')
        : absent('Storage', { status: 'NOT_AVAILABLE', reason: 'the host exposes no filesystem statistics' }));
      cards.push(reading('Uptime', n(Math.round((t.uptimeSeconds || 0) / 3600)), 'h', 'host uptime'));
      cards.push(absent('GPU', t.gpu));
      cards.push(absent('Temperature', t.temperatureCelsius));
      cards.push(absent('Battery', t.batteryPercent));
      cards.push(absent('Camera link', t.cameraLink));
    }

    var st = FV.status && FV.status.health;
    cards.push(panel('Active session',
      FV.session
        ? '<div class="fv-metric"><span class="fv-metric-v" style="font-size:15px">'
          + esc(FV.session.summary.sessionRef) + '</span></div><div class="fv-metric-k">'
          + esc(FV.session.summary.source.displayName) + '</div>'
        : '<div class="fv-metric"><span class="fv-metric-v fv-none">—</span></div>'
          + '<div class="fv-metric-k">no session open</div>'));
    if (st) {
      cards.push(panel('API', metric('LIVE', '', st.eventTypes + ' Vision event types registered'),
        '<span class="fv-tag fv-tag--measured">OK</span>'));
      cards.push(panel('Source Core link', metric('LIVE', '', 'registered on the Fabric source registry'),
        '<span class="fv-tag fv-tag--measured">OK</span>'));
      cards.push(panel('Data Vault link', metric('LIVE', '', 'session facts persist as platform events'),
        '<span class="fv-tag fv-tag--measured">OK</span>'));
    }

    body('<div class="fv-grid">' + cards.join('') + '</div>'
      + '<div style="height:14px"></div>'
      + panel('Future hardware target',
        '<div class="fv-rows">'
        + '<div class="fv-row"><span class="fv-row-k">FAMILISTA VISION HUB</span>'
          + '<span class="fv-tag fv-tag--future">NOT IMPLEMENTED</span></div>'
        + '<div class="fv-row"><span class="fv-row-k">Current processing target</span>'
          + '<span class="fv-row-v">' + esc(d.processingTarget) + '</span></div>'
        + '</div>'
        + '<div class="fv-note fv-note--loud">Selecting the VISION_HUB target today runs the entire '
        + 'platform against an adapter that refuses every call and says why. Nothing about the device '
        + 'is simulated — no invented temperature, no invented battery, no invented camera count. When '
        + 'the hardware exists, one adapter changes and this screen does not.</div>'));
  }

  // ── MODELS ────────────────────────────────────────────────────────────────

  function secModels() {
    head('Models & Providers', 'From the Model Registry that travelled with the result. '
      + 'No model path is written in this frontend.');
    if (!FV.models) { body('<div class="fv-empty fv-empty--withheld">Reading models…</div>'); return; }
    if (FV.models.ok === false) { body(empty('withheld', 'MODELS UNAVAILABLE', FV.models.error || '')); return; }
    if (!FV.models.models.length) {
      body(empty('absent', 'NO MODELS RECORDED',
        'No session visible to this account carries model provenance.'));
      return;
    }
    var rows = FV.models.models.map(function (m) {
      var cls = m.commercialUse === 'VERIFIED' ? 'measured'
        : m.commercialUse === 'UNKNOWN' ? 'unverified' : 'restricted';
      return '<tr><td><b style="color:var(--fv-tx)">' + esc(m.modelId) + '</b><br>'
        + '<span style="font-size:10.5px;color:var(--fv-tx-3)">' + esc(m.name || '') + '</span></td>'
        + '<td>' + esc(m.task || '—') + '</td>'
        + '<td>' + esc(m.version || '—') + '</td>'
        + '<td>' + esc(m.framework || '—') + '</td>'
        + '<td style="font-size:10.5px">' + esc(m.weights || '—') + '</td>'
        + '<td style="font-size:10.5px">' + esc((m.checksumSha256 || '—').slice(0, 16)) + '…</td>'
        + '<td style="font-size:11px">sw ' + esc(m.licenceSoftware || '—') + '<br>'
        + 'weights ' + esc(m.licenceWeights || '—') + '</td>'
        + '<td><span class="fv-tag fv-tag--' + cls + '">' + esc(m.commercialUse) + '</span><br>'
        + '<span style="font-size:10px;color:var(--fv-tx-3)">' + esc(m.licenceVerification || '') + '</span></td>'
        + '</tr>';
    }).join('');

    var provs = FV.models.providers.map(function (p) {
      return '<div class="fv-row"><span class="fv-row-k"><b style="color:var(--fv-tx)">'
        + esc(p.role) + '</b><br><span style="font-size:11px;color:var(--fv-tx-3)">'
        + esc(p.provider) + '</span></span>'
        + '<span class="fv-row-v" style="font-size:11px">' + esc(p.modelIds.join(', '))
        + (p.fusesDetectionAndTracking
          ? '<br><span class="fv-tag fv-tag--withheld">FUSES DETECTION + TRACKING</span>' : '')
        + '</span></div>';
    }).join('');

    body('<div class="fv-grid fv-grid--wide">'
      + panel('Providers by role', '<div class="fv-rows">' + provs + '</div>'
        + '<div class="fv-note">A role names what fills it. Swapping a model is configuration; '
        + 'nothing in this frontend names a checkpoint file.</div>')
      + '</div><div style="height:14px"></div>'
      + panel('Models', '<div class="fv-table-scroll"><table class="fv-table"><thead><tr>'
        + '<th>Model</th><th>Task</th><th>Version</th><th>Framework</th><th>Weights</th>'
        + '<th>Checksum</th><th>Licence</th><th>Commercial use</th></tr></thead><tbody>'
        + rows + '</tbody></table></div>'
        + '<div class="fv-note fv-note--loud">UNKNOWN is not a milder RESTRICTED. RESTRICTED means the '
        + 'terms were read and they say no. UNKNOWN means nobody has checked, which reads like the '
        + 'absence of a problem and is not.</div>'));
  }

  // ── INTEGRATIONS ──────────────────────────────────────────────────────────

  function secIntegrations() {
    head('Integrations', 'Where Vision sits in the Familista nervous system, and what it publishes.');
    if (!FV.integrations) { body('<div class="fv-empty fv-empty--withheld">Reading integrations…</div>'); return; }
    if (FV.integrations.ok === false) {
      body(empty('withheld', 'INTEGRATIONS UNAVAILABLE', FV.integrations.error || ''));
      return;
    }
    var flow = FV.integrations.flow.map(function (f, i) {
      return (i ? '<div class="fv-flow-arrow">↓</div>' : '')
        + '<div class="fv-flow-node"><span class="fv-flow-stage">' + esc(f.stage) + '</span>'
        + '<span class="fv-flow-name">' + esc(f.node) + '</span>'
        + '<span class="fv-flow-detail">' + esc(f.detail) + '</span>'
        + '<span class="fv-tag fv-tag--' + (f.status === 'LIVE' ? 'measured' : 'accent') + '">'
        + esc(f.status) + '</span></div>';
    }).join('');

    var events = FV.integrations.events.map(function (e) {
      return '<tr><td style="font-family:monospace;font-size:11px;color:var(--fv-tx)">' + esc(e.type) + '</td>'
        + '<td>v' + esc(e.schemaVersion) + '</td>'
        + '<td>' + (e.live ? '<span class="fv-tag fv-tag--measured">LIVE VIEW</span>'
          : '<span class="fv-tag fv-tag--withheld">DURABLE ONLY</span>') + '</td>'
        + '<td style="max-width:52ch">' + esc(e.describes) + '</td></tr>';
    }).join('');

    // Full width rather than a grid cell: the flow is a single vertical path
    // and squeezing it into a 360px column wraps every node's name onto three
    // lines to leave two thirds of the screen empty.
    body(panel('Nervous system', '<div class="fv-flow">' + flow + '</div>')
      + '<div style="height:14px"></div>'
      + panel('Vision events on the platform transport',
        '<div class="fv-table-scroll"><table class="fv-table"><thead><tr><th>Event type</th>'
        + '<th>Schema</th><th>Live board</th><th>What it says has happened</th></tr></thead><tbody>'
        + events + '</tbody></table></div>'
        + '<div class="fv-note">There is no Vision event bus. These names are registered on the '
        + 'Fabric\'s own registry, travel through the same outbox, and land in the same Data Vault as '
        + 'every other domain\'s facts. The three per-observation names are withheld from the LIVE '
        + 'board and are still fully durable — a ten-second clip holds four thousand observations, '
        + 'and putting them on a shared firehose would drown every other domain.</div>'));
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  function openSession(ref) {
    FV.sessionRef = ref;
    FV.session = null;
    FV.timeline = null;
    FV.frame = 0;
    FV.section = 'overview';
    refreshNav();
    renderSection();
    Promise.all([
      get('/sessions/' + encodeURIComponent(ref)),
      get('/sessions/' + encodeURIComponent(ref) + '/timeline'),
    ]).then(function (r) {
      FV.session = r[0] && r[0].ok ? r[0].session : null;
      FV.timeline = r[1] && r[1].ok ? r[1].timeline : null;
      if (FV.session && FV.session.tracks && FV.session.tracks.length) {
        FV.frame = FV.session.tracks[0].frameNumber;
      }
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
      FV.status = r[0];
      FV.sessions = r[1];
      FV.sources = r[2];
      FV.models = r[3];
      FV.device = r[4];
      FV.integrations = r[5];
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
  window.renderFamilistaVision = function (host) {
    if (!host) return;
    boot();
  };
  window.mountFamilistaVision = boot;
  window.teardownFamilistaVision = function () {
    FV.session = null; FV.timeline = null; FV.sessionRef = null;
  };
})();
