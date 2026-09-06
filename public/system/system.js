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
    clubSetup: null,
    people: null,
    security: null,
    audit: null,
    approvals: null,
    error: null,
    search: '',
    drawer: null,
    created: null,
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
  // ── SYSTEM localisation — three languages, and only three ────────────────
  //
  // SYSTEM is the platform owner's workspace, not the platform. It is read by
  // one small group of people, so it carries English, German and Arabic and
  // nothing else — a deliberate boundary, kept in its own catalogue under
  // /system/i18n/ so that SYSTEM strings never enter the platform's 31-locale
  // catalogue and the club product's translations are never touched by
  // anything here.
  //
  // The mechanism is the house one: the English on screen IS the key, and a
  // run of digits becomes a %d slot so "3 clubs without a president" and
  // "17 clubs without a president" are one entry. A key with no translation
  // falls through to the English, which is a gap rather than a break.
  var SY_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var SY_DICT = {};
  var SY_LANG = 'en';
  var SY_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < SY_LOCALES.length; i++) if (SY_LOCALES[i][0] === tag) return SY_LOCALES[i];
    return SY_LOCALES[0];
  }

  function storedSystemLocale() {
    var tag = '';
    try { tag = localStorage.getItem('familista_system_locale') || ''; } catch (_) {}
    if (tag && localeOf(tag)[0] === tag) return tag;
    // No stored choice: honour the browser only when it asks for one of ours.
    var nav = '';
    try { nav = (navigator.language || '').slice(0, 2).toLowerCase(); } catch (_) {}
    return (nav === 'de' || nav === 'ar') ? nav : 'en';
  }

  /** The dictionary, fetched once per language and kept for the session. */
  var SY_DICT_CACHE = {};
  function loadSystemDict(tag) {
    if (tag === 'en') { SY_DICT = {}; return Promise.resolve({}); }
    if (SY_DICT_CACHE[tag]) { SY_DICT = SY_DICT_CACHE[tag]; return Promise.resolve(SY_DICT); }
    return fetch('/system/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (d) { SY_DICT_CACHE[tag] = d || {}; SY_DICT = SY_DICT_CACHE[tag]; return SY_DICT; });
  }

  function setSystemLocale(tag) {
    var loc = localeOf(tag);
    SY_LANG = loc[0];
    SY_DIR = loc[2];
    try { localStorage.setItem('familista_system_locale', SY_LANG); } catch (_) {}
    return loadSystemDict(SY_LANG);
  }

  /** One string, translated. Used for text JavaScript speaks — prompts, alerts. */
  function T(text) {
    if (SY_LANG === 'en') return text;
    var key = String(text == null ? '' : text);
    if (SY_DICT[key]) return SY_DICT[key];
    // Try the slotted form: digits become %d, and come back in order.
    var digits = [];
    var slotted = key.replace(/\d[\d,.]*/g, function (m) { digits.push(m); return '%d'; });
    var hit = SY_DICT[slotted];
    if (!hit) return key;
    var n = 0;
    return hit.replace(/%d/g, function () { return digits[n++] != null ? digits[n - 1] : '%d'; });
  }

  /**
   * Translate what has just been painted, and nothing else.
   *
   * Walks only inside the SYSTEM host, skips anything a person typed
   * (data-user-content), anything that is not language (data-no-i18n), and
   * never touches a script or style node. A club screen is not reachable from
   * here, by construction.
   */
  function syTranslate(root) {
    if (!root || SY_LANG === 'en') return;
    var skip = function (el) {
      for (var n = el; n && n !== root.parentNode; n = n.parentNode) {
        if (n.nodeType !== 1) continue;
        if (n.hasAttribute('data-user-content') || n.hasAttribute('data-no-i18n')) return true;
        var tag = n.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE') return true;
      }
      return false;
    };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var raw = node.nodeValue;
      if (!raw || !/\S/.test(raw) || !node.parentNode || skip(node.parentNode)) continue;
      var trimmed = raw.trim();
      var out = T(trimmed);
      if (out !== trimmed) node.nodeValue = raw.replace(trimmed, out);
    }
    var attrs = ['placeholder', 'title', 'aria-label'];
    var all = root.querySelectorAll('[placeholder],[title],[aria-label]');
    for (var j = 0; j < all.length; j++) {
      if (skip(all[j])) continue;
      for (var k = 0; k < attrs.length; k++) {
        var v = all[j].getAttribute(attrs[k]);
        if (v && v.trim()) all[j].setAttribute(attrs[k], T(v.trim()));
      }
    }
  }

  function languageSwitchHtml() {
    return '<div class="sy-langs" role="group" aria-label="SYSTEM language">'
      + SY_LOCALES.map(function (l) {
        return '<button class="sy-lang' + (l[0] === SY_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-sy-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === SY_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('') + '</div>';
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
      + languageSwitchHtml()
      + '<div class="sy-user"><div class="sy-user-av">' + esc(initial) + '</div>'
      + '<div><b data-user-content>' + esc(name || 'Familista') + '</b><span>' + esc(level) + '</span></div></div>'
      + '</div></header>';
  }

  // ── overview ──────────────────────────────────────────────────────────────
  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? 'Good Morning' : h < 18 ? 'Good Afternoon' : 'Good Evening';
  }

  // ── metrics ───────────────────────────────────────────────────────────────
  // Every figure carries where it came from. LIVE is one aggregate over one
  // table; DERIVED is a real count under a definition somebody chose; an
  // absent one renders as "—" and says what would measure it. The badge is
  // not decoration — an operator acting on "Active Today" needs to know it
  // counts sign-ins rather than live sessions before they act.
  function sourceChip(m) {
    if (!m || !m.source) return '';
    var label = m.source === 'NOT_INSTRUMENTED' ? 'no data' : m.source.toLowerCase();
    var cls = m.source === 'LIVE' ? 'live' : m.source === 'DERIVED' ? 'derived' : 'none';
    return '<span class="sy-src sy-src--' + cls + '" title="' + esc(m.how || '') + '">' + esc(label) + '</span>';
  }

  function kpiHtml(icon, label, m, note, go) {
    var v = metric(m);
    var tag = go ? 'button' : 'div';
    var attrs = go ? ' type="button" data-sy-go="' + esc(go) + '"' : '';
    return '<' + tag + ' class="sy-kpi' + (go ? ' is-live' : '') + '"' + attrs + '>'
      + '<div class="sy-kpi-h"><span class="sy-kpi-ic">' + icon + '</span>'
      + '<span>' + esc(label) + '</span>' + sourceChip(m) + '</div>'
      + '<b class="' + (v.none ? 'is-none' : '') + '">' + esc(v.text) + '</b>'
      + '<i>' + esc(v.none ? v.why : (note || (m && m.how) || '')) + '</i>'
      + (go ? '<span class="sy-kpi-go">→</span>' : '')
      + '</' + tag + '>';
  }

  // ── quick actions ─────────────────────────────────────────────────────────
  // The command area. Each entry names a real action or is disabled with the
  // reason it is not available — there is no third kind. `act` is either a
  // module to open (navigation is a real action) or a handler below.
  var QUICK_ACTIONS = [
    ['＋', 'Create Club', 'LIVE', 'create-club',
      'Creates the club with no owner and invites the president you name. You are never made its owner.'],
    ['✉', 'Invite President', 'LIVE', 'go:clubs',
      'A president is invited as part of creating a club, and re-invited from that club\'s setup panel.'],
    ['⚇', 'Manage People & Access', 'LIVE', 'go:people', 'Identity, memberships and invitations across every club.'],
    ['⬢', 'Clubs Management', 'LIVE', 'go:clubs', 'Every club, with what the platform can count about it.'],
    ['⚛', 'New Experiment', 'LIVE', 'new-experiment', 'Registers an experiment in this environment.'],
    ['⚑', 'Feature Flags', 'LIVE', 'go:flags', 'Enable, disable and target a flag. Takes effect immediately.'],
    ['⌬', 'Open AI Control', 'LIVE', 'go:agents', 'Agents, tools, autonomy and the global kill switch.'],
    ['✓', 'Pending Approvals', 'LIVE', 'go:approvals', 'High-risk agent actions waiting for a person.'],
    ['⛨', 'Security Center', 'LIVE', 'go:security', 'Access denials, sign-in failures and suspicious payloads.'],
    ['⚗', 'Innovation Lab', 'LIVE', 'go:lab', 'Test privately before anybody else sees it.'],
    ['⇪', 'Release Control', 'NOT_AVAILABLE', null,
      'Releases are deployed by the hosting platform. Familista has no promote or roll-back hook yet.'],
  ];

  function quickActionsHtml() {
    return '<section class="sy-panel sy-command">'
      + '<div class="sy-panel-h"><h2>Quick Actions</h2><span>every control here performs a real change</span></div>'
      + '<div class="sy-qa">' + QUICK_ACTIONS.map(function (a) {
        var live = a[2] === 'LIVE';
        return '<button class="sy-qa-btn' + (live ? '' : ' is-off') + '" type="button"'
          + (live ? ' data-sy-act="' + esc(a[3]) + '"' : ' disabled')
          + ' title="' + esc(a[4]) + '">'
          + '<span class="sy-qa-ic">' + a[0] + '</span>'
          + '<span class="sy-qa-txt"><b>' + esc(a[1]) + '</b>'
          + '<i class="sy-chip sy-chip--' + (live ? 'live' : 'none') + '">' + esc(live ? 'LIVE' : 'NOT AVAILABLE') + '</i></span>'
          + '</button>';
      }).join('') + '</div></section>';
  }

  // ── control widgets ───────────────────────────────────────────────────────
  // Compact operational state, each with the control that changes it. The
  // kill switch is a real switch: it is never drawn as decoration.
  function widgetsHtml(o) {
    var caps = SY.capabilities || {};
    var ks = caps.killSwitch || { engaged: false, reason: null };
    var env = o.environment || (caps.environment || 'PREVIEW');
    var envs = ['PRODUCTION', 'STAGING', 'LAB', 'PREVIEW'];

    var ai = '<div class="sy-widget"><div class="sy-widget-h"><b>Autonomous AI Actions</b>'
      + '<span class="sy-chip sy-chip--' + (ks.engaged ? 'none' : 'live') + '">' + (ks.engaged ? 'STOPPED' : 'RUNNING') + '</span></div>'
      + '<p>' + esc(ks.engaged ? (ks.reason || 'The kill switch is engaged. Reading and recommending continue.')
        : 'Agents may act within their autonomy level. Reading and recommending are never stopped.') + '</p>'
      + '<button class="sy-btn ' + (ks.engaged ? 'sy-btn--ok' : 'sy-btn--danger') + '" type="button"'
      + ' data-sy-kill="' + (ks.engaged ? 'release' : 'engage') + '">'
      + (ks.engaged ? 'Resume autonomous actions' : 'Stop autonomous actions') + '</button></div>';

    var envW = '<div class="sy-widget"><div class="sy-widget-h"><b>Environment</b></div>'
      + '<div class="sy-envs">' + envs.map(function (e) {
        return '<span class="sy-env' + (e === env ? ' is-on' : '') + '">' + esc(e) + '</span>';
      }).join('') + '</div>'
      + '<p>Flags, experiments and agent autonomy are evaluated against this environment.</p></div>';

    var wcount = function (title, m, note, go, cta) {
      var v = metric(m);
      return '<div class="sy-widget"><div class="sy-widget-h"><b>' + esc(title) + '</b>' + sourceChip(m) + '</div>'
        + '<div class="sy-widget-n' + (v.none ? ' is-none' : '') + '">' + esc(v.text) + '</div>'
        + '<p>' + esc(v.none ? v.why : note) + '</p>'
        + (go ? '<button class="sy-btn" type="button" data-sy-go="' + esc(go) + '">' + esc(cta) + '</button>' : '')
        + '</div>';
    };

    return '<div class="sy-widgets">' + ai + envW
      + wcount('Experiments running', o.innovation.experimentsRunning, 'Registered in this instance and in the RUNNING state.', 'experiments', 'Open experiments')
      + wcount('Feature flags on', o.innovation.flagsOn, 'Enabled and reaching this environment right now.', 'flags', 'Open flags')
      + wcount('Pending approvals', o.governance.pendingApprovals, 'High-risk agent actions queued for a person.', 'approvals', 'Review')
      + wcount('Security alerts · 24h', o.security.alertsToday, 'Severity WARN or CRITICAL.', 'security', 'Inspect')
      + '</div>';
  }

  /** An analytics panel with nothing behind it yet — and no invented curve. */
  function pendingAnalytics(title, span, m, module) {
    return '<section class="sy-panel"><div class="sy-panel-h"><h2>' + esc(title) + '</h2><span>' + esc(span) + '</span></div>'
      + '<div class="sy-pending">'
      + '<div class="sy-pending-bars">'
      + '<i></i><i></i><i></i><i></i><i></i><i></i><i></i>'
      + '</div>'
      + '<b>Analytics instrumentation pending</b>'
      + '<span>' + esc((m && m.unavailable) || 'No event stream is connected yet.')
      + ' Nothing is estimated here — an invented curve is worse than an empty panel.</span>'
      + '<button class="sy-btn" type="button" data-sy-go="' + esc(module) + '">Configure Analytics</button>'
      + '</div></section>';
  }

  // ── the create-club drawer ────────────────────────────────────────────────
  // A drawer rather than a page: creating a club is a platform action, and the
  // platform owner never leaves SYSTEM to perform it. It is `position: fixed`
  // and animates on opacity and transform only, so opening it moves nothing
  // underneath.
  function createClubDrawerHtml() {
    var field = function (name, label, type, required, hint) {
      return '<label class="sy-field"><span>' + esc(label) + (required ? ' *' : '') + '</span>'
        + '<input type="' + type + '" name="' + name + '"' + (required ? ' required' : '')
        + (hint ? ' placeholder="' + esc(hint) + '"' : '') + '></label>';
    };
    return '<div class="sy-scrim" data-sy-close></div>'
      + '<aside class="sy-drawer" role="dialog" aria-modal="true" aria-label="Create club">'
      + '<header class="sy-drawer-h"><div><b>Create Club</b>'
      + '<span>The club is created with no owner. You are not made its president.</span></div>'
      + '<button class="sy-icon-btn" type="button" data-sy-close aria-label="Close">✕</button></header>'
      + '<form class="sy-drawer-b" data-sy-create-club>'
      + '<div class="sy-fieldset"><h3>Club</h3>'
      + field('name', 'Club name', 'text', true, '')
      + field('shortName', 'Display / short name', 'text', false, '')
      + field('country', 'Country', 'text', false, 'Germany')
      + field('city', 'City', 'text', true, '')
      + field('timezone', 'Time zone', 'text', false, 'Europe/Berlin')
      + field('defaultLocale', 'Default locale', 'text', false, 'de-DE')
      + field('contactEmail', 'Contact email', 'email', false, '')
      + field('websiteUrl', 'Website', 'url', false, '')
      + '</div>'
      + '<div class="sy-fieldset"><h3>President</h3>'
      + '<p class="sy-note">They receive an invitation and set their own password. You will never see it, '
      + 'and you are not asked to create one.</p>'
      + field('firstName', 'First name', 'text', true, '')
      + field('lastName', 'Last name', 'text', true, '')
      + field('email', 'Email', 'email', true, '')
      + '</div>'
      + '<div class="sy-drawer-f">'
      + '<button class="sy-btn sy-btn--ghost" type="button" data-sy-close>Cancel</button>'
      + '<button class="sy-btn" type="submit">Create club and invite president</button>'
      + '</div></form></aside>';
  }

  /** What the platform owner sees the moment a club is created. */
  function createdClubHtml(result) {
    var link = '';
    try {
      link = result.token
        ? (window.location.origin + '/invite?token=' + encodeURIComponent(result.token))
        : '';
    } catch (_) {}
    return '<div class="sy-scrim" data-sy-close></div>'
      + '<aside class="sy-drawer" role="dialog" aria-modal="true" aria-label="Club created">'
      + '<header class="sy-drawer-h"><div><b>Club created</b>'
      + '<span data-user-content>' + esc(result.setup && result.setup.name) + '</span></div>'
      + '<button class="sy-icon-btn" type="button" data-sy-close aria-label="Close">✕</button></header>'
      + '<div class="sy-drawer-b">'
      + setupSteps(result.setup)
      + '<div class="sy-fieldset"><h3>Delivery</h3>'
      + '<p class="sy-note"><span class="sy-chip sy-chip--partial">PARTIAL — EMAIL PROVIDER NOT CONNECTED</span></p>'
      + '<p class="sy-note">' + esc(result.delivery && result.delivery.detail) + '</p>'
      + (link
        ? '<label class="sy-field"><span>Invitation link — shown once</span>'
          + '<input type="text" readonly value="' + esc(link) + '" data-sy-link data-no-i18n></label>'
          + '<div class="sy-row-btns"><button class="sy-btn" type="button" data-sy-copy>Copy link</button></div>'
        : '')
      + '</div>'
      + '<div class="sy-drawer-f">'
      + '<button class="sy-btn" type="button" data-sy-close>Done</button>'
      + '</div></div></aside>';
  }

  function overviewHtml() {
    var o = SY.overview;
    if (!o) return skeleton();
    var name = '';
    try { var u = window.State && window.State.user; name = (u && u.firstName) || ''; } catch (_) {}

    var ownerless = (o.clubs.withoutOwner && o.clubs.withoutOwner.value) || 0;
    var healthy = ownerless === 0;
    var now = new Date();

    var kpis = [
      kpiHtml('⬢', 'Total Clubs', o.clubs.total, null, 'clubs'),
      kpiHtml('◉', 'Active Clubs', o.clubs.active, null, 'clubs'),
      kpiHtml('⚇', 'Total Users', o.people.users, null, 'people'),
      kpiHtml('◔', 'Active Today', o.activity.activeToday, null, 'people'),
      kpiHtml('♛', 'Presidents', o.people.owners, null, 'people'),
      kpiHtml('⚒', 'Staff', o.people.staff, null, 'people'),
      kpiHtml('⚽', 'Players', o.players.total, null, 'clubs'),
      kpiHtml('⚿', 'Memberships', o.access.activeMemberships, null, 'people'),
      kpiHtml('✉', 'Pending Invitations', o.access.pendingInvitations, null, 'people'),
      kpiHtml('⊘', 'Suspended Memberships', o.access.suspendedMemberships, null, 'people'),
      kpiHtml('✓', 'Pending Approvals', o.governance.pendingApprovals, null, 'approvals'),
      kpiHtml('⛨', 'Security Alerts · 7d', o.security.alertsThisWeek, null, 'security'),
    ].join('');

    // Users by role, from real membership counts. Every category is a counted
    // number; the percentage is arithmetic on those numbers and nothing else.
    var owners = (o.people.owners && o.people.owners.value) || 0;
    var staff = (o.people.staff && o.people.staff.value) || 0;
    var viewers = (o.people.viewers && o.people.viewers.value) || 0;
    var admins = (o.people.platformAdmins && o.people.platformAdmins.value) || 0;
    var totalRoles = owners + staff + viewers + admins;
    var roleRow = function (label, value, colour, how) {
      var pct = totalRoles ? Math.round((value / totalRoles) * 100) : 0;
      var w = totalRoles ? Math.max(2, Math.round((value / totalRoles) * 100)) : 0;
      return '<div class="sy-legend-row" title="' + esc(how) + '"><i style="background:' + colour + '"></i>'
        + '<span>' + esc(label) + '</span>'
        + '<span class="sy-legend-bar"><b style="width:' + w + '%;background:' + colour + '"></b></span>'
        + '<b>' + num(value) + (totalRoles ? ' (' + pct + '%)' : '') + '</b></div>';
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
      + '<div class="sy-clock" data-no-i18n>' + esc(now.toDateString()) + '<br>' + esc(now.toLocaleTimeString()) + '</div>'
      + '<div class="sy-status"><span class="sy-dot ' + (healthy ? 'sy-dot--ok' : 'sy-dot--warn') + '"></span>'
      + '<div class="sy-status-txt"><span>Platform status</span><b>' + (healthy ? 'Healthy' : 'Attention') + '</b>'
      + '<i data-no-i18n>' + esc(o.environment) + ' · ' + esc(o.generatedAt.slice(11, 19)) + ' UTC</i></div>'
      + '<button class="sy-btn" type="button" data-sy-go="agents">Open Command Center →</button></div>'
      + '</div></div>'

      + quickActionsHtml()

      + '<div class="sy-kpis">' + kpis + '</div>'

      + widgetsHtml(o)

      + '<div class="sy-grid sy-grid--3">'
      + pendingAnalytics('Platform Activity', 'last 24 hours', o.activity.sessionsToday, 'platform-analytics')
      + pendingAnalytics('Top Used Modules', 'last 30 days', o.activity.topModules, 'product-analytics')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Users by Role</h2><span>counted, not sampled</span></div>'
      + '<div class="sy-legend">'
      + roleRow('Platform Owners & Admins', admins, 'var(--sy-cyan)', 'COUNT(PlatformAdmin) where isActive')
      + roleRow('Presidents', owners, 'var(--sy-violet)', 'Active memberships with role CLUB_OWNER')
      + roleRow('Staff', staff, 'var(--sy-ok)', 'Active memberships with any other role')
      + roleRow('Normal Users — no membership', viewers, 'var(--sy-accent)', 'Active accounts with no active membership anywhere')
      + '</div>'
      + '<button class="sy-btn" type="button" data-sy-go="people">Open People &amp; Access</button>'
      + '</section>'
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
        'No club is without a president, no invitation is about to lapse, no approval is queued and autonomous AI actions are running normally.');
    }
    var icon = { INFO: '◔', ATTENTION: '⚠', WARNING: '⛨' };
    return '<div class="sy-signals">' + list.map(function (s) {
      var tone = s.severity.toLowerCase();
      // Every signal names what the reader does about it, and the button goes
      // there. A feed with no way to act on any row is a worry list.
      return '<div class="sy-signal sy-signal--' + tone + '">'
        + '<div class="sy-signal-h"><span class="sy-signal-ic sy-signal-ic--' + tone + '">' + (icon[s.severity] || '◔') + '</span>'
        + '<b>' + esc(s.title) + '</b></div><p>' + esc(s.detail) + '</p>'
        + '<button class="sy-btn sy-btn--sm" type="button" data-sy-go="' + esc(s.module) + '">'
        + esc(s.action || 'Open') + ' →</button></div>';
    }).join('') + '</div>';
  }

  function approvalsHtml() {
    var a = SY.approvals;
    if (!a) return moduleHeader('approvals') + skeleton(120);
    if (a.unavailable) {
      return moduleHeader('approvals')
        + '<section class="sy-panel">' + emptyState('Approval queue unavailable', a.unavailable) + '</section>'
        + capabilityTable('approvals');
    }
    if (!a.requests.length) {
      return moduleHeader('approvals')
        + '<section class="sy-panel">' + emptyState('Nothing is waiting for approval',
          'No high-risk agent action is queued. Requests appear here the moment an agent asks for one.') + '</section>'
        + capabilityTable('approvals');
    }
    return moduleHeader('approvals')
      + '<section class="sy-panel"><div class="sy-panel-h"><h2>Waiting for a person</h2>'
      + '<span>' + a.requests.length + ' request(s)</span></div>'
      + '<div class="sy-table-wrap"><table class="sy-table">'
      + '<thead><tr><th>Agent</th><th>Kind</th><th>Club</th><th>Requested</th><th>Expires</th></tr></thead><tbody>'
      + a.requests.map(function (r) {
        return '<tr><td><b>' + esc(r.agent) + '</b></td><td>' + esc(r.kind) + '</td>'
          + '<td data-user-content>' + esc(r.clubId) + '</td>'
          + '<td data-no-i18n>' + esc(String(r.createdAt).slice(0, 16).replace('T', ' ')) + '</td>'
          + '<td data-no-i18n>' + esc(String(r.expiresAt).slice(0, 16).replace('T', ' ')) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>'
      + capabilityTable('approvals');
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

  // ── club onboarding ───────────────────────────────────────────────────────
  // A club is created here and owned by somebody else. The four steps below
  // are the whole of it, and none of them is ticked because the previous one
  // was: each reads a fact the server checked.
  function setupSteps(setup) {
    if (!setup) return '';
    var st = setup.steps || {};
    var step = function (label, done, note) {
      return '<div class="sy-step' + (done ? ' is-done' : '') + '">'
        + '<span class="sy-step-tick">' + (done ? '✓' : '○') + '</span>'
        + '<span class="sy-step-txt"><b>' + esc(label) + '</b>'
        + '<i>' + esc(done ? 'Done' : (note || 'Pending')) + '</i></span></div>';
    };
    return '<div class="sy-steps">'
      + step('Club created', !!st.clubCreated, '')
      + step('President invited', !!st.presidentInvited, 'No invitation is out')
      + step('President accepted', !!st.presidentAccepted, 'The invited person has not accepted yet')
      + step('Club activation', !!st.clubActivated, 'A club activates when it has an active president')
      + '</div>';
  }

  /** The president panel for one club: pending controls, or the active person. */
  function presidentPanel(setup) {
    if (!setup) return '';
    var p = setup.president || {};
    var head = '<div class="sy-panel-h"><h2>President</h2>'
      + '<span class="sy-chip sy-chip--' + (p.state === 'ACTIVE' ? 'live' : p.state === 'INVITED' ? 'partial' : 'none') + '">'
      + esc(p.state === 'ACTIVE' ? 'ACTIVE' : p.state === 'INVITED' ? 'INVITATION PENDING' : 'NO PRESIDENT') + '</span></div>';

    if (p.state === 'ACTIVE') {
      return '<section class="sy-panel">' + head
        + '<div class="sy-pres"><b data-user-content>' + esc(p.name || p.email || '') + '</b>'
        + '<span data-user-content>' + esc(p.email || '') + '</span></div>'
        + '<p class="sy-note">This club has a president. Replacing an active president removes somebody\'s '
        + 'authority over their own club, so it is not a SYSTEM control — the club\'s own last-owner '
        + 'protection is the only path.</p>'
        + '<div class="sy-row-btns">'
        + '<button class="sy-btn" type="button" data-sy-go="people">Inspect president</button>'
        + '<button class="sy-btn sy-btn--ghost" type="button" data-sy-go="people">View membership</button>'
        + '<button class="sy-btn sy-btn--ghost" type="button" data-sy-go="audit">View audit</button>'
        + '</div></section>';
    }

    if (p.state === 'INVITED') {
      return '<section class="sy-panel">' + head
        + '<div class="sy-pres"><b data-user-content>' + esc(p.email || '') + '</b>'
        + '<span>Invitation pending' + (p.invitationExpiresAt
          ? ' · expires <span data-no-i18n>' + esc(String(p.invitationExpiresAt).slice(0, 10)) + '</span>' : '') + '</span></div>'
        + '<p class="sy-note">No mail provider is connected, so nothing was emailed. The link is shown once when '
        + 'it is minted; resending mints a new one and retires the old.</p>'
        + '<div class="sy-row-btns">'
        + '<button class="sy-btn" type="button" data-sy-act="president-resend:' + esc(setup.clubId) + '">Resend invite</button>'
        + '<button class="sy-btn sy-btn--danger" type="button" data-sy-act="president-revoke:' + esc(setup.clubId) + '">Revoke invite</button>'
        + '<button class="sy-btn sy-btn--ghost" type="button" data-sy-act="president-replace:' + esc(setup.clubId) + '">Replace president invite</button>'
        + '</div></section>';
    }

    return '<section class="sy-panel">' + head
      + emptyState('No president has been invited',
        'This club cannot be run by anybody until a president accepts. It stays PENDING_SETUP until then.')
      + '<div class="sy-row-btns">'
      + '<button class="sy-btn" type="button" data-sy-act="president-replace:' + esc(setup.clubId) + '">Invite a president</button>'
      + '</div></section>';
  }

  function lifecycleChip(life) {
    var cls = life === 'ACTIVE' ? 'live' : life === 'PRESIDENT_INVITED' ? 'partial' : 'none';
    var label = life === 'ACTIVE' ? 'ACTIVE'
      : life === 'PRESIDENT_INVITED' ? 'PRESIDENT INVITED' : 'PENDING SETUP';
    return '<span class="sy-chip sy-chip--' + cls + '">' + esc(label) + '</span>';
  }

  function clubsHtml() {
    if (!SY.clubs) return moduleHeader('clubs') + skeleton();

    // The club the reader opened, if any: its setup state and its president.
    var open = SY.clubSetup
      ? '<section class="sy-panel"><div class="sy-panel-h"><h2>Setup</h2>'
        + '<span data-user-content>' + esc(SY.clubSetup.name) + '</span></div>'
        + setupSteps(SY.clubSetup)
        + (SY.clubSetup.blocking ? '<p class="sy-note">' + esc(SY.clubSetup.blocking) + '</p>' : '')
        + '</section>' + presidentPanel(SY.clubSetup)
      : '';

    var rows = SY.clubs.length
      ? '<div class="sy-table-wrap"><table class="sy-table"><thead><tr>'
        + '<th>Club</th><th>Lifecycle</th><th>Teams</th><th>Players</th><th>Memberships</th><th>Ownership</th><th></th></tr></thead><tbody>'
        + SY.clubs.map(function (c) {
          return '<tr><td><b data-user-content>' + esc(c.name) + '</b>'
            + (c.pendingPresidentEmail
              ? '<br><span style="opacity:.6" data-user-content>' + esc(c.pendingPresidentEmail) + '</span>' : '')
            + '</td>'
            + '<td>' + lifecycleChip(c.lifecycle) + '</td>'
            + '<td>' + num(c.teams) + '</td><td>' + num(c.players) + '</td><td>' + num(c.activeMemberships) + '</td>'
            + '<td>' + (c.hasOwner
              ? '<span class="sy-chip sy-chip--live">president active</span>'
              : '<span class="sy-chip sy-chip--protected">no president</span>') + '</td>'
            + '<td><button class="sy-btn sy-btn--sm" type="button" data-sy-act="club-setup:' + esc(c.id) + '">Open setup</button></td>'
            + '</tr>';
        }).join('') + '</tbody></table></div>'
      : emptyState('No clubs yet', 'A club appears here as soon as one exists.');

    return moduleHeader('clubs')
      + '<section class="sy-panel sy-command"><div class="sy-panel-h"><h2>Bring a club onto Familista</h2>'
      + '<span>the platform owner never becomes the club owner</span></div>'
      + '<p class="sy-note">A club is created with no owner and stays PENDING_SETUP until the person you name '
      + 'accepts their invitation and signs in with a password only they know. You are not made its president, '
      + 'not even temporarily.</p>'
      + '<div class="sy-row-btns"><button class="sy-btn" type="button" data-sy-act="create-club">＋ Create Club</button></div>'
      + '</section>'
      + open
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
        ? '<span>Autonomous actions are stopped. Reading and recommending continue, and Familista is up.</span>'
          + (ks.reason ? '<span data-user-content> — ' + esc(ks.reason) + '</span>' : '')
        : '<span>Autonomous actions are running. Engaging the switch stops every agent action platform-wide; '
          + 'reading and recommending continue and the platform stays up.</span>')
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
      case 'approvals': return approvalsHtml();
      case 'security': return securityHtml();
      case 'audit': return auditHtml();
      default: return genericHtml(SY.module);
    }
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function load(module) {
    // Whoami decides WHICH screen is drawn, so it is settled before anything
    // else is requested. A refused account then asks the server for nothing
    // else at all — not the overview, not the capabilities, not the signals.
    if (!SY.who) {
      return api('/system/whoami')
        .then(function (d) { SY.who = d; })
        .catch(function (e) {
          SY.error = (e && e.message) || 'SYSTEM could not confirm this account\'s authority.';
        })
        .then(function () {
          if (SY.who && SY.who.isPlatformOwner === false) return;
          return load(module);
        });
    }

    var jobs = [];
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
    if (module === 'approvals' && !SY.approvals) jobs.push(api('/system/approvals').then(function (d) { SY.approvals = d; }));
    if (module === 'security' && !SY.security) jobs.push(api('/system/security').then(function (d) { SY.security = d; }));
    if (module === 'audit' && !SY.audit) jobs.push(api('/system/audit').then(function (d) { SY.audit = d; }));

    if (!jobs.length) return Promise.resolve();
    return Promise.all(jobs).catch(function (e) {
      SY.error = (e && e.message) || 'This area is refused to accounts that do not own the platform.';
    });
  }

  // ── render ────────────────────────────────────────────────────────────────
  /**
   * The refusal, drawn as its own screen.
   *
   * Not the command centre with an empty middle: an account without platform
   * authority must not be shown a rail full of modules it cannot open, a search
   * box that searches nothing and a top bar that implies a workspace. It gets
   * one page that says what its account is, what is missing, and the way back.
   *
   * The server refuses every SYSTEM read regardless. This is the honest face of
   * that refusal, not the enforcement of it.
   */
  function deniedHtml() {
    var who = SY.who || {};
    var d = who.platformAuthority || {};
    var row = function (label, value, ok) {
      return '<div class="sy-diag-row"><span>' + esc(label) + '</span>'
        + '<b class="' + (ok === true ? 'is-ok' : ok === false ? 'is-no' : '') + '" data-no-i18n>'
        + esc(value) + '</b></div>';
    };
    return '<div class="sy-denied">'
      + '<div class="sy-denied-card">'
      + '<div class="sy-denied-ic">⛨</div>'
      + '<h1>SYSTEM is the platform owner\'s</h1>'
      + '<p>This account holds no platform authority. Owning or administering a club never grants it — '
      + 'platform ownership is a separate assignment, made at the platform level.</p>'
      + '<div class="sy-diag">'
      + row('Access level', String(who.level || 'VIEWER'), false)
      + row('Account role', String(d.accountRole || '—'), !!d.accountRoleGrants)
      + row('Platform assignment', String(d.platformAdminRow || 'NONE'), d.platformAdminRow === 'ACTIVE')
      + '</div>'
      + (d.remedy ? '<p class="sy-denied-fix">' + esc(d.remedy) + '</p>' : '')
      + '<button class="sy-btn" type="button" data-sy-home>← Back to Home</button>'
      + '</div></div>';
  }

  function drawerHtml() {
    if (SY.drawer === 'create-club') return createClubDrawerHtml();
    if (SY.drawer === 'created' && SY.created) return createdClubHtml(SY.created);
    return '';
  }

  function paint(host) {
    // Refused accounts never see the shell. Drawn before anything else so that
    // no rail, no module list and no search box is ever built for somebody who
    // cannot use one.
    if (SY.who && SY.who.isPlatformOwner === false) {
      host.innerHTML = '<div class="sy-shell sy-shell--denied" dir="' + SY_DIR + '" lang="' + SY_LANG + '">'
        + deniedHtml() + '</div>';
      try { syTranslate(host); } catch (_) {}
      try { document.documentElement.setAttribute('data-sy-dir', SY_DIR); } catch (_) {}
      return;
    }
    host.innerHTML = '<div class="sy-shell" dir="' + SY_DIR + '" lang="' + SY_LANG + '">' + railHtml()
      + '<div class="sy-main">' + topHtml()
      + '<div class="sy-body" id="sy-body">' + contentHtml() + '</div></div>'
      + drawerHtml() + '</div>';
    // SYSTEM translates itself, from its own three-language catalogue. The
    // platform's 31-locale catalogue is deliberately NOT applied here: the two
    // are separate products and separate string sets, and neither may reach
    // into the other's.
    try { syTranslate(host); } catch (_) {}
    try { document.documentElement.setAttribute('data-sy-dir', SY_DIR); } catch (_) {}
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

      // Quick actions. "go:<module>" is navigation, which is a real action;
      // anything else is a handler that performs a real change below.
      var act = ev.target.closest('[data-sy-act]');
      if (act) {
        ev.preventDefault();
        var key = act.getAttribute('data-sy-act') || '';
        if (key.indexOf('go:') === 0) { go(host, key.slice(3)); return; }
        if (key === 'create-club') { SY.drawer = 'create-club'; paint(host); return; }

        // ── the president's pending invitation ─────────────────────────────
        // Every one of these performs a real change through a real endpoint,
        // and every one refuses on the server if the club already has an
        // active president — the button is a convenience, not the guard.
        if (key.indexOf('club-setup:') === 0) {
          SY.clubSetup = null;
          paint(host);
          api('/system/clubs/' + encodeURIComponent(key.slice(11)) + '/setup')
            .then(function (d) { SY.clubSetup = d; paint(host); })
            .catch(function (e) { window.alert(e.message); });
          return;
        }
        if (key.indexOf('president-resend:') === 0) {
          var rid = key.slice(17);
          if (!confirmCritical(T('Send a new invitation link?') + '\n\n'
            + T('The current link stops working immediately.'))) return;
          act.disabled = true;
          api('/system/clubs/' + encodeURIComponent(rid) + '/president/resend', { method: 'POST', body: '{}' })
            .then(function (d) {
              SY.created = { setup: null, token: d.token, delivery: d.delivery };
              return api('/system/clubs/' + encodeURIComponent(rid) + '/setup');
            })
            .then(function (setup) {
              SY.clubSetup = setup;
              SY.created.setup = setup;
              SY.drawer = 'created';
              SY.clubs = null;
              paint(host);
            })
            .catch(function (e) { window.alert(e.message); act.disabled = false; });
          return;
        }
        if (key.indexOf('president-revoke:') === 0) {
          var vid = key.slice(17);
          if (!confirmCritical(T('Withdraw this invitation?') + '\n\n'
            + T('The link stops working immediately and the club returns to PENDING_SETUP.'))) return;
          var why = window.prompt(T('Why is the invitation being withdrawn? (recorded)')) || '';
          act.disabled = true;
          api('/system/clubs/' + encodeURIComponent(vid) + '/president/revoke', {
            method: 'POST', body: JSON.stringify({ reason: why.trim() || undefined }),
          }).then(function (setup) { SY.clubSetup = setup; SY.clubs = null; go(host, 'clubs'); })
            .catch(function (e) { window.alert(e.message); act.disabled = false; });
          return;
        }
        if (key.indexOf('president-replace:') === 0) {
          var pid = key.slice(18);
          var first = window.prompt(T("The new president's first name")) || '';
          if (!first.trim()) return;
          var last = window.prompt(T("The new president's last name")) || '';
          if (!last.trim()) return;
          var mail = window.prompt(T("The new president's email address")) || '';
          if (!mail.trim()) return;
          act.disabled = true;
          api('/system/clubs/' + encodeURIComponent(pid) + '/president/replace', {
            method: 'POST',
            body: JSON.stringify({ president: { firstName: first.trim(), lastName: last.trim(), email: mail.trim() } }),
          }).then(function (d) {
            SY.created = d; SY.clubSetup = d.setup; SY.drawer = 'created'; SY.clubs = null;
            paint(host);
          }).catch(function (e) { window.alert(e.message); act.disabled = false; });
          return;
        }
        if (key === 'new-experiment') {
          var title = window.prompt(T('Name the experiment. It is registered in this environment and starts as a draft.')) || '';
          if (!title.trim()) return;
          var hypothesis = window.prompt(T('What do you expect to happen? (optional)')) || '';
          act.disabled = true;
          api('/system/experiments', {
            method: 'POST',
            body: JSON.stringify({ title: title.trim(), hypothesis: hypothesis.trim() }),
          }).then(function () {
            SY.innovation = null; SY.overview = null; SY.signals = null;
            go(host, 'experiments');
          }).catch(function (e) { window.alert(e.message); act.disabled = false; });
        }
        return;
      }

      var close = ev.target.closest('[data-sy-close]');
      if (close) {
        ev.preventDefault();
        SY.drawer = null; SY.created = null;
        // The list is stale after a creation, so it is refetched rather than
        // patched: the server is the only thing that knows what exists.
        if (SY.module === 'clubs' && !SY.clubs) { go(host, 'clubs'); } else { paint(host); }
        return;
      }

      var copy = ev.target.closest('[data-sy-copy]');
      if (copy) {
        ev.preventDefault();
        var input = host.querySelector('[data-sy-link]');
        if (!input) return;
        input.select();
        try { document.execCommand('copy'); } catch (_) {}
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(input.value);
        } catch (_) {}
        copy.textContent = T('Copied');
        return;
      }

      var lang = ev.target.closest('[data-sy-lang]');
      if (lang) {
        ev.preventDefault();
        setSystemLocale(lang.getAttribute('data-sy-lang'));
        paint(host);
        return;
      }

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

    host.addEventListener('submit', function (ev) {
      var form = ev.target.closest('[data-sy-create-club]');
      if (!form) return;
      ev.preventDefault();
      var value = function (n) { var el = form.elements[n]; return el && el.value ? el.value.trim() : ''; };
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      api('/system/clubs', {
        method: 'POST',
        body: JSON.stringify({
          name: value('name'),
          shortName: value('shortName'),
          country: value('country'),
          city: value('city'),
          timezone: value('timezone'),
          defaultLocale: value('defaultLocale'),
          contactEmail: value('contactEmail'),
          websiteUrl: value('websiteUrl'),
          president: {
            firstName: value('firstName'),
            lastName: value('lastName'),
            email: value('email'),
          },
        }),
      }).then(function (d) {
        SY.created = d;
        SY.clubSetup = d.setup;
        SY.drawer = 'created';
        SY.clubs = null;
        SY.overview = null;
        SY.signals = null;
        paint(host);
      }).catch(function (e) {
        window.alert(e.message);
        if (btn) btn.disabled = false;
      });
    });

    host.addEventListener('input', function (ev) {
      var search = ev.target.closest('[data-sy-search]');
      if (!search) return;
      SY.search = search.value;
      // Repaint the body only: retyping must not rebuild the rail or steal focus.
      var body = host.querySelector('#sy-body');
      if (body) { body.innerHTML = contentHtml(); try { syTranslate(body); } catch (_) {} }
    });
  }

  /** Mount point. app.js calls this with the page's host element. */
  window.renderFamilistaSystem = function (host) {
    host = host || document.getElementById('sy-root');
    if (!host) return;
    bind(host);
    // The language is settled before the first paint, so a German or Arabic
    // owner never sees a flash of English.
    setSystemLocale(storedSystemLocale()).then(function () {
      paint(host);
      return load(SY.module);
    }).then(function () { paint(host); });
  };
}());
