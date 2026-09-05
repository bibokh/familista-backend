/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA SYSTEM — Platform Command & Control Center

   The platform owner's product. Not the club's: nothing in this file renders a
   squad, a fixture or a training session, and nothing in the club workspace
   renders a platform control. The two worlds share a codebase and no screens.

   Three rules this module keeps, and they are the reason it exists:

     1. Real or explicitly absent. A number the platform measures is shown; a
        number nothing measures renders as "—" with the reason underneath. There
        is no third option, and no placeholder that could be mistaken for truth.
     2. No dead controls. Every button either performs a real change through a
        real endpoint, or is disabled and labelled with why. A greyed control
        with a reason is information; an enabled control that does nothing is a
        lie the operator only discovers in an incident.
     3. The server decides. Every read and every action is authorised by the
        platform, and the interface merely reflects the answer. Hiding a button
        is a courtesy; /api/v1/system refuses a club owner whatever is drawn.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var SY = {
    module: 'overview',
    loading: false,
    who: null,
    overview: null,
    signals: null,
    capabilities: null,
    intelligence: null,
    innovation: null,
    clubs: null,
    people: null,
    security: null,
    audit: null,
    error: null,
    search: '',
  };

  // ── plumbing ──────────────────────────────────────────────────────────────
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) {
    return typeof n === 'number' ? n.toLocaleString() : '—';
  }
  /** A metric is { value, unavailable }. Absent is never rendered as zero. */
  function metric(m) {
    if (!m || m.value == null) {
      return { text: '—', none: true, why: (m && m.unavailable) || 'Not instrumented yet.' };
    }
    return { text: num(m.value), none: false, why: '' };
  }
  function api(path, opts) {
    var base = (typeof FAM_CONFIG !== 'undefined' && FAM_CONFIG.API_BASE)
      ? FAM_CONFIG.API_BASE : '/api/v1';
    var token = '';
    try { token = (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) {}
    return fetch(base + path, Object.assign({
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
      ),
      credentials: 'include',
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error((body && (body.message || body.error)) || ('HTTP ' + r.status));
        return body.data != null ? body.data : body;
      });
    });
  }

  // ── the module list, mirroring the server's ───────────────────────────────
  // Icons and grouping are the interface's; readiness comes from the server, so
  // a module that stops being instrumented says so here without an edit.
  var MODULES = [
    ['overview', 'Overview', '◎', 'COMMAND'],
    ['clubs', 'Clubs Management', '⬢', 'COMMAND'],
    ['people', 'People & Access', '⚇', 'COMMAND'],
    ['platform-analytics', 'Platform Analytics', '◫', 'INSIGHT'],
    ['product-analytics', 'Product Analytics', '◪', 'INSIGHT'],
    ['infrastructure', 'Infrastructure', '▤', 'PLATFORM'],
    ['health', 'Platform Health', '♥', 'PLATFORM'],
    ['security', 'Security Center', '⛨', 'PLATFORM'],
    ['audit', 'Audit Center', '☰', 'PLATFORM'],
    ['intelligence', 'Familista Intelligence', '✦', 'INTELLIGENCE'],
    ['agents', 'AI Agent Control', '⌬', 'INTELLIGENCE'],
    ['models', 'Model Management', '⚗', 'INTELLIGENCE'],
    ['governance', 'Global Governance', '⚖', 'GOVERNANCE'],
    ['approvals', 'Approval Center', '✓', 'GOVERNANCE'],
    ['data-archive', 'Data & Archive', '⛁', 'CONTINUITY'],
    ['backup', 'Backup & Recovery', '↻', 'CONTINUITY'],
    ['lab', 'Innovation Lab', '⚛', 'INNOVATION'],
    ['experiments', 'Experiments', '⚖', 'INNOVATION'],
    ['flags', 'Feature Flags', '⚑', 'INNOVATION'],
    ['releases', 'Release Management', '⇪', 'INNOVATION'],
    ['automation', 'Automation', '⚙', 'PLATFORM'],
    ['notifications', 'Notifications', '◔', 'PLATFORM'],
    ['integrations', 'Integrations', '⇄', 'PLATFORM'],
    ['settings', 'Platform Settings', '⚙', 'PLATFORM'],
  ];
  var GROUP_ORDER = ['COMMAND', 'INSIGHT', 'INTELLIGENCE', 'GOVERNANCE', 'PLATFORM', 'CONTINUITY', 'INNOVATION'];
  var GROUP_LABEL = {
    COMMAND: 'Command', INSIGHT: 'Insight', INTELLIGENCE: 'Intelligence',
    GOVERNANCE: 'Governance', PLATFORM: 'Platform', CONTINUITY: 'Continuity', INNOVATION: 'Innovation',
  };

  function readinessOf(key) {
    var list = (SY.overview && SY.overview.modules) || (SY.modules || []);
    var hit = list.filter(function (m) { return m.key === key; })[0];
    return hit || null;
  }

  // ── shell ─────────────────────────────────────────────────────────────────
  function railHtml() {
    var groups = GROUP_ORDER.map(function (g) {
      var items = MODULES.filter(function (m) { return m[3] === g; });
      if (!items.length) return '';
      return '<div class="sy-nav-group">' + esc(GROUP_LABEL[g]) + '</div>'
        + items.map(function (m) {
          var r = readinessOf(m[0]);
          var tag = '';
          if (r && r.readiness === 'PARTIAL') tag = '<span class="sy-nav-tag sy-nav-tag--partial">partial</span>';
          if (r && r.readiness === 'NOT_INSTRUMENTED') tag = '<span class="sy-nav-tag sy-nav-tag--none">no data</span>';
          return '<button class="sy-nav-item' + (SY.module === m[0] ? ' is-on' : '') + '" type="button"'
            + ' data-sy-go="' + esc(m[0]) + '">'
            + '<span class="sy-nav-ic">' + m[2] + '</span><span>' + esc(m[1]) + '</span>' + tag
            + '</button>';
        }).join('');
    }).join('');

    return '<aside class="sy-rail">'
      + '<div class="sy-brand"><div class="sy-brand-mark">F</div>'
      + '<div class="sy-brand-txt"><b>FAMILISTA</b><span>Football connects the world</span></div></div>'
      + '<button class="sy-back" type="button" data-sy-home>← Back to Home</button>'
      + '<div class="sy-ident"><div class="sy-ident-ic">⚙</div>'
      + '<div><b>SYSTEM</b><span>Platform &amp; Infrastructure</span></div></div>'
      + '<nav class="sy-nav">' + groups + '</nav>'
      + '</aside>';
  }

  function topHtml() {
    var who = SY.who || {};
    var name = '';
    try {
      var u = window.State && window.State.user;
      name = u ? ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email : '';
    } catch (_) {}
    var initial = (name || 'F').charAt(0).toUpperCase();
    // SYSTEM states platform authority and nothing else. A club role is not an
    // authority on this screen — a club owner reaches none of SYSTEM — so the
    // labels a club shell would draw ("Club Owner", "Club Staff") are never
    // drawn here. Either the account owns the platform or it does not.
    var level = who.isPlatformOwner ? 'Platform Owner' : 'No platform authority';
    var signals = (SY.signals || []).length;

    return '<header class="sy-top">'
      + '<div class="sy-search"><span>⌕</span>'
      + '<input type="search" placeholder="Search anything in System…" value="' + esc(SY.search) + '" data-sy-search>'
      + '<span class="sy-kbd">⌘K</span></div>'
      + '<div class="sy-top-actions">'
      + '<button class="sy-icon-btn" type="button" data-sy-go="notifications" title="Signals">◔'
      + (signals ? '<span class="sy-badge">' + signals + '</span>' : '') + '</button>'
      + '<button class="sy-icon-btn" type="button" data-sy-go="governance" title="Governance">⚖</button>'
      + '<button class="sy-icon-btn" type="button" data-sy-go="settings" title="Platform settings">⚙</button>'
      + '<div class="sy-user"><div class="sy-user-av">' + esc(initial) + '</div>'
      + '<div><b data-user-content>' + esc(name || 'Familista') + '</b><span>' + esc(level) + '</span></div></div>'
      + '</div></header>';
  }

  // ── overview ──────────────────────────────────────────────────────────────
  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? 'Good Morning' : h < 18 ? 'Good Afternoon' : 'Good Evening';
  }

  function kpiHtml(icon, label, m, note) {
    var v = metric(m);
    return '<div class="sy-kpi"><div class="sy-kpi-h"><span class="sy-kpi-ic">' + icon + '</span>'
      + '<span>' + esc(label) + '</span></div>'
      + '<b class="' + (v.none ? 'is-none' : '') + '">' + esc(v.text) + '</b>'
      + '<i>' + esc(v.none ? v.why : (note || '')) + '</i></div>';
  }

  function overviewHtml() {
    var o = SY.overview;
    if (!o) return skeleton();
    var name = '';
    try { var u = window.State && window.State.user; name = (u && u.firstName) || ''; } catch (_) {}

    var ownerless = (o.access && o.access.clubsWithoutOwner && o.access.clubsWithoutOwner.value) || 0;
    var healthy = ownerless === 0;
    var now = new Date();

    var kpis = [
      kpiHtml('⬢', 'Total Clubs', o.clubs.total, 'Every club on the platform'),
      kpiHtml('◉', 'Active Clubs', o.clubs.active, 'At least one active membership'),
      kpiHtml('⚇', 'Total Users', o.people.users, 'Accounts on Familista'),
      kpiHtml('◔', 'Active Today', o.activity.activeToday, 'Signed in within 24 hours'),
      kpiHtml('♛', 'Presidents', o.people.owners, 'Active club-owner memberships'),
      kpiHtml('⚒', 'Staff', o.people.staff, 'Active non-owner memberships'),
      kpiHtml('⚽', 'Players', o.players.total, 'Active player records'),
    ].join('');

    // Users by role, from real membership counts. Viewers are accounts with no
    // membership anywhere — a real number, not a residual guess.
    var owners = (o.people.owners && o.people.owners.value) || 0;
    var staff = (o.people.staff && o.people.staff.value) || 0;
    var viewers = (o.people.viewers && o.people.viewers.value) || 0;
    var totalRoles = owners + staff + viewers;
    var roleRow = function (label, value, colour) {
      var pct = totalRoles ? Math.round((value / totalRoles) * 100) : 0;
      return '<div class="sy-legend-row"><i style="background:' + colour + '"></i>'
        + '<span>' + esc(label) + '</span><b>' + num(value) + (totalRoles ? ' (' + pct + '%)' : '') + '</b></div>';
    };

    var caps = SY.capabilities;
    var capStrip = caps
      ? '<span class="sy-chip sy-chip--live">' + caps.summary.LIVE + ' live</span> '
        + '<span class="sy-chip sy-chip--partial">' + caps.summary.PARTIAL + ' partial</span> '
        + '<span class="sy-chip sy-chip--none">' + caps.summary.NOT_AVAILABLE + ' not available</span>'
      : '';

    return '<div class="sy-crumb">SYSTEM / OVERVIEW</div>'
      + '<div class="sy-hero"><div class="sy-hero-txt">'
      + '<h1>' + esc(greeting()) + ', <em data-user-content>' + esc(name || 'Owner') + '</em></h1>'
      + '<p>Here\'s what\'s happening across Familista today.</p></div>'
      + '<div class="sy-hero-side">'
      + '<div class="sy-clock">' + esc(now.toDateString()) + '<br>' + esc(now.toLocaleTimeString()) + '</div>'
      + '<div class="sy-status"><span class="sy-dot ' + (healthy ? 'sy-dot--ok' : 'sy-dot--warn') + '"></span>'
      + '<div class="sy-status-txt"><span>Platform status</span><b>' + (healthy ? 'Healthy' : 'Attention') + '</b>'
      + '<i>' + esc(o.modules.length) + ' modules · ' + esc(o.generatedAt.slice(11, 19)) + ' UTC</i></div>'
      + '<button class="sy-btn" type="button" data-sy-go="agents">Open Command Center →</button></div>'
      + '</div></div>'

      + '<div class="sy-kpis">' + kpis + '</div>'

      + '<div class="sy-grid sy-grid--3">'
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Platform Activity</h2><span>last 24 hours</span></div>'
      + (o.activity.sessionsToday.value == null
        ? emptyState('Session analytics are not instrumented', o.activity.sessionsToday.unavailable
          + ' Sign-ins are counted above and are real; an activity curve would need the event stream.')
        : '')
      + '</section>'
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Top Used Modules</h2><span>last 30 days</span></div>'
      + (o.activity.topModules.value == null
        ? emptyState('Feature usage is not instrumented', o.activity.topModules.unavailable)
        : '')
      + '</section>'
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Users by Role</h2></div>'
      + '<div class="sy-legend">'
      + roleRow('Presidents', owners, 'var(--sy-violet)')
      + roleRow('Staff', staff, 'var(--sy-ok)')
      + roleRow('Viewers — no membership', viewers, 'var(--sy-accent)')
      + '</div></section>'
      + '</div>'

      + '<section class="sy-panel"><div class="sy-panel-h"><h2>What\'s happening now?</h2><span>' + capStrip + '</span></div>'
      + signalsHtml() + '</section>'

      + '<div class="sy-cards">'
      + cardHtml('clubs', '⬢', 'Clubs', 'Inspect every club', 'rgba(59,130,246,.16)')
      + cardHtml('people', '⚇', 'People & Access', 'Identity, memberships, invitations', 'rgba(167,139,250,.16)')
      + cardHtml('intelligence', '✦', 'Intelligence', 'Gateway, models, agents', 'rgba(248,113,113,.14)')
      + cardHtml('governance', '⚖', 'Governance', 'Policy, consent, retention', 'rgba(251,191,36,.14)')
      + cardHtml('lab', '⚛', 'Innovation Lab', 'Test privately', 'rgba(34,211,238,.14)')
      + cardHtml('audit', '☰', 'Audit Center', 'Who changed what', 'rgba(52,211,153,.14)')
      + '</div>';
  }

  function cardHtml(key, icon, title, sub, bg) {
    return '<button class="sy-card" type="button" data-sy-go="' + esc(key) + '">'
      + '<span class="sy-card-ic" style="background:' + bg + '">' + icon + '</span>'
      + '<b>' + esc(title) + '</b><span>' + esc(sub) + '</span>'
      + '<span class="sy-card-cta">Open →</span></button>';
  }

  function signalsHtml() {
    var list = SY.signals;
    if (!list) return skeleton(80);
    if (!list.length) {
      return emptyState('Nothing needs attention',
        'No club is without an owner, no invitation is about to lapse and autonomous AI actions are running normally.');
    }
    var icon = { INFO: '◔', ATTENTION: '⚠', WARNING: '⛨' };
    return '<div class="sy-signals">' + list.map(function (s) {
      var tone = s.severity.toLowerCase();
      return '<button class="sy-signal" type="button" data-sy-go="' + esc(s.module) + '">'
        + '<div class="sy-signal-h"><span class="sy-signal-ic sy-signal-ic--' + tone + '">' + (icon[s.severity] || '◔') + '</span>'
        + '<b>' + esc(s.title) + '</b></div><p>' + esc(s.detail) + '</p></button>';
    }).join('') + '</div>';
  }

  function emptyState(title, detail) {
    return '<div class="sy-empty"><b>' + esc(title) + '</b><span>' + esc(detail || '') + '</span></div>';
  }
  function skeleton(h) {
    return '<div class="sy-skel" style="height:' + (h || 140) + 'px"></div>';
  }

  // ── module pages ──────────────────────────────────────────────────────────
  function capabilityTable(moduleKey) {
    var caps = SY.capabilities;
    if (!caps) return skeleton(90);
    var rows = caps.capabilities.filter(function (c) { return c.module === moduleKey; });
    if (!rows.length) return '';
    return '<section class="sy-panel"><div class="sy-panel-h"><h2>Controls</h2>'
      + '<span>what this module can actually do</span></div><div class="sy-table-wrap"><table class="sy-table">'
      + '<thead><tr><th>Action</th><th>Status</th><th>Risk</th><th>Detail</th></tr></thead><tbody>'
      + rows.map(function (c) {
        var chip = c.status === 'LIVE' ? 'live' : c.status === 'PARTIAL' ? 'partial' : 'none';
        return '<tr><td><b>' + esc(c.label) + '</b></td>'
          + '<td><span class="sy-chip sy-chip--' + chip + '">' + esc(c.status.replace('_', ' ')) + '</span></td>'
          + '<td><span class="sy-chip sy-chip--' + c.risk.toLowerCase() + '">' + esc(c.risk) + '</span></td>'
          + '<td>' + esc(c.note) + (c.endpoint ? ' <code style="opacity:.6">' + esc(c.endpoint) + '</code>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function moduleHeader(key) {
    var m = MODULES.filter(function (x) { return x[0] === key; })[0] || [key, key, '◎'];
    var r = readinessOf(key);
    var chip = r ? (r.readiness === 'LIVE' ? 'live' : r.readiness === 'PARTIAL' ? 'partial' : 'none') : 'none';
    return '<div class="sy-crumb">SYSTEM / ' + esc(m[1].toUpperCase()) + '</div>'
      + '<div class="sy-hero"><div class="sy-hero-txt"><h1>' + esc(m[1]) + '</h1>'
      + '<p>' + esc((r && r.backing) || '') + '</p></div>'
      + '<div class="sy-hero-side">'
      + (r ? '<span class="sy-chip sy-chip--' + chip + '">' + esc(r.readiness.replace('_', ' ')) + '</span>' : '')
      + '</div></div>';
  }

  function clubsHtml() {
    if (!SY.clubs) return moduleHeader('clubs') + skeleton();
    var rows = SY.clubs.length
      ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr>'
        + '<th>Club</th><th>Teams</th><th>Players</th><th>Memberships</th><th>Ownership</th></tr></thead><tbody>'
        + SY.clubs.map(function (c) {
          return '<tr><td><b data-user-content>' + esc(c.name) + '</b></td>'
            + '<td>' + num(c.teams) + '</td><td>' + num(c.players) + '</td><td>' + num(c.activeMemberships) + '</td>'
            + '<td>' + (c.hasOwner
              ? '<span class="sy-chip sy-chip--live">owner active</span>'
              : '<span class="sy-chip sy-chip--protected">no owner</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('No clubs yet', 'A club appears here as soon as one exists.');
    return moduleHeader('clubs')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Every club</h2>'
      + '<span>' + SY.clubs.length + ' total</span></div>' + rows + '</section>'
      + capabilityTable('clubs');
  }

  function peopleHtml() {
    if (!SY.people) return moduleHeader('people') + skeleton();
    var q = SY.search.toLowerCase();
    var list = SY.people.filter(function (p) {
      return !q || (p.name + ' ' + p.email).toLowerCase().indexOf(q) >= 0;
    });
    var rows = list.length
      ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr>'
        + '<th>Person</th><th>Account role</th><th>Memberships</th><th>Last sign-in</th></tr></thead><tbody>'
        + list.map(function (p) {
          var mem = p.memberships.length
            ? p.memberships.map(function (m) {
              return '<span class="sy-chip sy-chip--sensitive">' + esc(m.role) + (m.teamId ? ' · team' : ' · club-wide') + '</span>';
            }).join(' ')
            : '<span class="sy-chip sy-chip--none">viewer — no membership</span>';
          return '<tr><td><b data-user-content>' + esc(p.name) + '</b><br><span style="opacity:.6" data-user-content>'
            + esc(p.email) + '</span></td>'
            + '<td>' + esc(p.accountRole) + '</td><td>' + mem + '</td>'
            + '<td>' + esc(p.lastLoginAt ? String(p.lastLoginAt).slice(0, 10) : 'never') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('Nobody matches', 'Try a different search.');
    return moduleHeader('people')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>People</h2>'
      + '<span>' + list.length + ' of ' + SY.people.length + ' · no credential is ever read</span></div>'
      + rows + '</section>' + capabilityTable('people');
  }

  function agentsHtml() {
    var i = SY.intelligence;
    if (!i) return moduleHeader('agents') + skeleton();
    var ks = i.killSwitch || {};
    var jobs = i.jobs;
    return moduleHeader('agents')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Global AI action kill switch</h2>'
      + '<span class="sy-chip sy-chip--critical">CRITICAL</span></div>'
      + '<p style="margin:0 0 14px;font-size:12px;color:var(--sy-tx-2)">'
      + (ks.engaged
        ? 'Autonomous actions are <b>stopped</b>' + (ks.reason ? ' — ' + esc(ks.reason) : '')
          + '. Reading and recommending continue, and Familista is up.'
        : 'Autonomous actions are running. Engaging the switch stops every agent action platform-wide; '
          + 'reading and recommending continue and the platform stays up.')
      + '</p>'
      + (ks.engaged
        ? '<button class="sy-btn" type="button" data-sy-kill="release">Resume autonomous actions</button>'
        : '<button class="sy-btn sy-btn--danger" type="button" data-sy-kill="engage">Stop autonomous actions</button>')
      + '</section>'
      + '<div class="sy-grid sy-grid--2">'
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Agent work</h2><span>recorded jobs</span></div>'
      + (jobs
        ? '<div class="sy-legend">'
          + '<div class="sy-legend-row"><i style="background:var(--sy-tx-3)"></i><span>Pending</span><b>' + num(jobs.pending) + '</b></div>'
          + '<div class="sy-legend-row"><i style="background:var(--sy-accent)"></i><span>Running</span><b>' + num(jobs.running) + '</b></div>'
          + '<div class="sy-legend-row"><i style="background:var(--sy-ok)"></i><span>Succeeded</span><b>' + num(jobs.succeeded) + '</b></div>'
          + '<div class="sy-legend-row"><i style="background:var(--sy-danger)"></i><span>Failed</span><b>' + num(jobs.failed) + '</b></div>'
          + '</div>'
        : emptyState('No agent job history', i.unavailable || 'Nothing has run yet.'))
      + '</section>'
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Tool registry</h2><span>' + i.tools.length + ' tools</span></div>'
      + '<div class="sy-table-wrap"><table class="sy-table"><thead><tr><th>Tool</th><th>Effect</th><th>Min autonomy</th><th>Ceiling</th></tr></thead><tbody>'
      + i.tools.map(function (t) {
        var chip = t.effect === 'PROTECTED' ? 'protected' : t.effect === 'WRITE' ? 'critical' : 'safe';
        return '<tr><td><b>' + esc(t.key) + '</b></td>'
          + '<td><span class="sy-chip sy-chip--' + chip + '">' + esc(t.effect) + '</span></td>'
          + '<td>' + t.minAutonomy + '</td><td>' + esc(t.classification) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>'
      + '</div>'
      + capabilityTable('agents');
  }

  function flagsHtml() {
    var inn = SY.innovation;
    if (!inn) return moduleHeader('flags') + skeleton();
    var rows = inn.flags.length
      ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr>'
        + '<th>Flag</th><th>Audience</th><th>Environments</th><th>State</th><th></th></tr></thead><tbody>'
        + inn.flags.map(function (f) {
          return '<tr><td><b>' + esc(f.key) + '</b></td>'
            + '<td><span class="sy-chip sy-chip--sensitive">' + esc(f.audience.replace(/_/g, ' ')) + '</span>'
            + (f.audience === 'PERCENTAGE_ROLLOUT' ? ' ' + (f.percentage || 0) + '%' : '') + '</td>'
            + '<td>' + esc((f.environments || []).join(', ')) + '</td>'
            + '<td>' + (f.enabled ? '<span class="sy-chip sy-chip--live">on</span>' : '<span class="sy-chip sy-chip--none">off</span>') + '</td>'
            + '<td><button class="sy-btn sy-btn--ghost" type="button" data-sy-flag="' + esc(f.key) + '"'
            + ' data-sy-enabled="' + (f.enabled ? '0' : '1') + '" data-sy-audience="' + esc(f.audience) + '">'
            + (f.enabled ? 'Disable' : 'Enable') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('No flags defined in this process',
        'A flag is defined by the platform owner and is OFF for everybody until an audience is chosen. '
        + 'Flags declared in code appear here once the process that defines them has started.');
    return moduleHeader('flags')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Feature flags</h2>'
      + '<span>environment: ' + esc(inn.environment) + '</span></div>' + rows + '</section>'
      + capabilityTable('flags');
  }

  function experimentsHtml() {
    var inn = SY.innovation;
    if (!inn) return moduleHeader('experiments') + skeleton();
    var rows = inn.experiments.length
      ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr>'
        + '<th>Experiment</th><th>Environment</th><th>Status</th><th>Hypothesis</th><th></th></tr></thead><tbody>'
        + inn.experiments.map(function (e) {
          var next = e.status === 'DRAFT' ? 'RUNNING' : e.status === 'RUNNING' ? 'PAUSED' : e.status === 'PAUSED' ? 'RUNNING' : '';
          return '<tr><td><b>' + esc(e.title) + '</b></td><td>' + esc(e.environment) + '</td>'
            + '<td><span class="sy-chip sy-chip--sensitive">' + esc(e.status) + '</span></td>'
            + '<td>' + esc(e.hypothesis || '—') + '</td>'
            + '<td>' + (next
              ? '<button class="sy-btn sy-btn--ghost" type="button" data-sy-exp="' + esc(e.id) + '" data-sy-status="' + next + '">'
                + esc(next === 'RUNNING' ? 'Start' : 'Pause') + '</button>'
              : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('No experiments registered',
        'An experiment records a hypothesis, its metrics and its decision — and outlives the feature, '
        + 'so a rejected idea keeps the reason it was rejected.');
    return moduleHeader('experiments')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Experiments</h2>'
      + '<span>environment: ' + esc(inn.environment) + '</span></div>' + rows + '</section>'
      + capabilityTable('experiments');
  }

  function labHtml() {
    var inn = SY.innovation;
    return moduleHeader('lab')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Private development</h2>'
      + '<span>' + esc((inn && inn.environment) || '') + '</span></div>'
      + '<p style="margin:0;font-size:12.5px;color:var(--sy-tx-2);line-height:1.6">'
      + 'A feature is hidden until somebody targets it. A flag scoped to <b>LAB</b> does not exist in production — '
      + 'not for a president, not for staff, not for a normal user, and not for you. A flag scoped to '
      + '<b>OWNER_ONLY</b> in production reaches the platform owner and nobody else. There is no path where '
      + 'forgetting to configure something turns a feature on.'
      + '</p></section>'
      + '<div class="sy-cards">'
      + cardHtml('flags', '⚑', 'Feature Flags', 'Target owner, users, clubs, percentage', 'rgba(34,211,238,.14)')
      + cardHtml('experiments', '⚖', 'Experiments', 'Hypothesis, metrics, decision', 'rgba(167,139,250,.16)')
      + cardHtml('releases', '⇪', 'Release Management', 'Stages and canary', 'rgba(59,130,246,.16)')
      + '</div>'
      + capabilityTable('lab');
  }

  function securityHtml() {
    if (!SY.security) return moduleHeader('security') + skeleton();
    var ev = SY.security.events || [];
    return moduleHeader('security')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Security events</h2><span>' + ev.length + ' most recent</span></div>'
      + (ev.length
        ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr><th>Kind</th><th>Severity</th><th>Club</th><th>When</th></tr></thead><tbody>'
          + ev.map(function (e) {
            var chip = e.severity === 'CRITICAL' ? 'protected' : e.severity === 'HIGH' ? 'critical' : 'safe';
            return '<tr><td><b>' + esc(e.kind) + '</b></td>'
              + '<td><span class="sy-chip sy-chip--' + chip + '">' + esc(e.severity) + '</span></td>'
              + '<td>' + esc(e.clubId || '—') + '</td><td>' + esc(String(e.createdAt).slice(0, 19).replace('T', ' ')) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : emptyState('No security events recorded', 'Tenant mismatches, failed logins and suspicious payloads appear here.'))
      + '</section>' + capabilityTable('security');
  }

  function auditHtml() {
    if (!SY.audit) return moduleHeader('audit') + skeleton();
    var rows = SY.audit.rows || [];
    return moduleHeader('audit')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Audit trail</h2><span>' + rows.length + ' most recent</span></div>'
      + (rows.length
        ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr><th>Action</th><th>Club</th><th>Actor</th><th>Reason</th><th>When</th></tr></thead><tbody>'
          + rows.map(function (r) {
            return '<tr><td><b>' + esc(r.action) + '</b></td><td>' + esc(r.clubId || '—') + '</td>'
              + '<td>' + esc(r.actorUserId || 'system') + '</td><td>' + esc(r.reason || '—') + '</td>'
              + '<td>' + esc(String(r.createdAt).slice(0, 19).replace('T', ' ')) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : emptyState('Nothing audited yet', 'Membership and invitation changes appear here with actor, before and after.'))
      + '</section>' + capabilityTable('audit');
  }

  /** Any module with no page of its own: its readiness, its controls, honestly. */
  function genericHtml(key) {
    var r = readinessOf(key);
    return moduleHeader(key)
      + (r && r.readiness === 'NOT_INSTRUMENTED'
        ? '<section class="sy-panel">' + emptyState('Not instrumented yet', r.backing) + '</section>'
        : '')
      + (capabilityTable(key) || (r && r.readiness !== 'NOT_INSTRUMENTED'
        ? '<section class="sy-panel">' + emptyState('No controls yet', (r && r.backing) || '') + '</section>' : ''));
  }

  function contentHtml() {
    // Said once, plainly, before any module is drawn: an account without
    // platform authority sees why, not an empty dashboard. The server refuses
    // every SYSTEM read regardless — this is the explanation, not the guard.
    if (SY.who && SY.who.isPlatformOwner === false) {
      return '<section class="sy-panel">'
        + emptyState('SYSTEM is the platform owner\'s',
            'This account holds no platform authority. Owning or administering a club does not grant it: '
            + 'platform ownership is assigned separately, at the platform level.')
        + '</section>';
    }
    if (SY.error) {
      return '<section class="sy-panel">' + emptyState('SYSTEM is the platform owner\'s', SY.error) + '</section>';
    }
    switch (SY.module) {
      case 'overview': return overviewHtml();
      case 'clubs': return clubsHtml();
      case 'people': return peopleHtml();
      case 'agents': case 'intelligence': case 'models': return agentsHtml();
      case 'flags': return flagsHtml();
      case 'experiments': return experimentsHtml();
      case 'lab': return labHtml();
      case 'security': return securityHtml();
      case 'audit': return auditHtml();
      default: return genericHtml(SY.module);
    }
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function load(module) {
    var jobs = [];
    if (!SY.who) jobs.push(api('/system/whoami').then(function (d) { SY.who = d; }));
    if (!SY.capabilities) jobs.push(api('/system/capabilities').then(function (d) { SY.capabilities = d; }));
    if (module === 'overview' && !SY.overview) {
      jobs.push(api('/system/overview').then(function (d) { SY.overview = d; }));
      jobs.push(api('/system/signals').then(function (d) { SY.signals = d.signals; }));
    }
    if (module === 'clubs' && !SY.clubs) jobs.push(api('/system/clubs').then(function (d) { SY.clubs = d.clubs; }));
    if (module === 'people' && !SY.people) jobs.push(api('/system/people').then(function (d) { SY.people = d.people; }));
    if ((module === 'agents' || module === 'intelligence' || module === 'models') && !SY.intelligence) {
      jobs.push(api('/system/intelligence').then(function (d) { SY.intelligence = d; }));
    }
    if ((module === 'flags' || module === 'experiments' || module === 'lab') && !SY.innovation) {
      jobs.push(api('/system/innovation').then(function (d) { SY.innovation = d; }));
    }
    if (module === 'security' && !SY.security) jobs.push(api('/system/security').then(function (d) { SY.security = d; }));
    if (module === 'audit' && !SY.audit) jobs.push(api('/system/audit').then(function (d) { SY.audit = d; }));

    if (!jobs.length) return Promise.resolve();
    return Promise.all(jobs).catch(function (e) {
      SY.error = (e && e.message) || 'This area is refused to accounts that do not own the platform.';
    });
  }

  // ── render ────────────────────────────────────────────────────────────────
  function paint(host) {
    host.innerHTML = '<div class="sy-shell">' + railHtml()
      + '<div class="sy-main">' + topHtml()
      + '<div class="sy-body" id="sy-body">' + contentHtml() + '</div></div></div>';
    try { if (window.I18N && window.I18N.translateDom) window.I18N.translateDom(host); } catch (_) {}
  }

  function go(host, module) {
    SY.module = module;
    SY.error = null;
    paint(host);
    load(module).then(function () { paint(host); });
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function confirmCritical(message) {
    // A critical action asks once, in words that say what it does. It is
    // deliberately not a styled dialog yet: a real confirmation the browser
    // draws is better than a pretty one that a click can slip past.
    return window.confirm(message);
  }

  function bind(host) {
    if (host.__syBound) return;
    host.__syBound = true;

    host.addEventListener('click', function (ev) {
      var go_ = ev.target.closest('[data-sy-go]');
      if (go_) { ev.preventDefault(); go(host, go_.getAttribute('data-sy-go')); return; }

      var home = ev.target.closest('[data-sy-home]');
      if (home) { ev.preventDefault(); try { navTo('owner-home'); } catch (_) {} return; }

      var kill = ev.target.closest('[data-sy-kill]');
      if (kill) {
        ev.preventDefault();
        var engage = kill.getAttribute('data-sy-kill') === 'engage';
        var reason = '';
        if (engage) {
          reason = window.prompt('Why are autonomous AI actions being stopped?\n\n'
            + 'The reason is shown to anyone who finds an agent refused, and is recorded.') || '';
          if (!reason.trim()) return;
        } else if (!confirmCritical('Resume autonomous AI actions across the platform?')) { return; }
        kill.disabled = true;
        api('/system/agents/kill-switch', {
          method: 'POST', body: JSON.stringify({ engage: engage, reason: reason.trim() }),
        }).then(function (d) { SY.intelligence = d; paint(host); })
          .catch(function (e) { window.alert(e.message); kill.disabled = false; });
        return;
      }

      var flag = ev.target.closest('[data-sy-flag]');
      if (flag) {
        ev.preventDefault();
        var key = flag.getAttribute('data-sy-flag');
        var enabled = flag.getAttribute('data-sy-enabled') === '1';
        if (enabled && !confirmCritical('Enable "' + key + '"?\n\nIt reaches its configured audience immediately.')) return;
        flag.disabled = true;
        api('/system/flags/' + encodeURIComponent(key), {
          method: 'POST',
          body: JSON.stringify({ enabled: enabled, audience: flag.getAttribute('data-sy-audience') || 'OWNER_ONLY' }),
        }).then(function () { SY.innovation = null; go(host, SY.module); })
          .catch(function (e) { window.alert(e.message); flag.disabled = false; });
        return;
      }

      var exp = ev.target.closest('[data-sy-exp]');
      if (exp) {
        ev.preventDefault();
        exp.disabled = true;
        api('/system/experiments/' + encodeURIComponent(exp.getAttribute('data-sy-exp')) + '/decide', {
          method: 'POST', body: JSON.stringify({ status: exp.getAttribute('data-sy-status') }),
        }).then(function () { SY.innovation = null; go(host, SY.module); })
          .catch(function (e) { window.alert(e.message); exp.disabled = false; });
      }
    });

    host.addEventListener('input', function (ev) {
      var search = ev.target.closest('[data-sy-search]');
      if (!search) return;
      SY.search = search.value;
      // Repaint the body only: retyping must not rebuild the rail or steal focus.
      var body = host.querySelector('#sy-body');
      if (body) body.innerHTML = contentHtml();
    });
  }

  /** Mount point. app.js calls this with the page's host element. */
  window.renderFamilistaSystem = function (host) {
    host = host || document.getElementById('sy-root');
    if (!host) return;
    bind(host);
    paint(host);
    load(SY.module).then(function () { paint(host); });
  };
}());
