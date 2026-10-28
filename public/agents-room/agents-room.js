/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — THE AI AGENTS OPERATIONS ROOM

   EVERY AGENT THE PLATFORM HAS, WHAT EACH MAY DO, AND WHO ANSWERS FOR IT

   The Platform Owner's global room for the Agent Registry (src/platform/agents),
   outside every Club Workspace. Loaded on demand by public/app.js, only once
   /system/whoami names the platform owner, and reached from SYSTEM → AI Agent
   Control. It reads two owner-only endpoints and nothing else:

     GET /system/agents            the registry: its digest and counts, the
                                   invariants the server computes, every agent
     GET /system/agents/:agentId   one manifest in full

   READ-ONLY

   Nothing here starts, stops, changes or activates an agent, and nothing here
   ever will: a manifest changes in a reviewed pull request, and the kill switch
   stays in SYSTEM → AI Agent Control. This room shows the switch's state, as the
   registry endpoint reports it, and offers no way to move it.

   DISCOVERED, NOT LISTED

   Domains, scopes, lifecycles and agents are drawn from what the registry
   returns. A domain or an agent added to the registry appears here with no
   change to this file; a token this file has no label for is shown in readable
   form rather than dropped. Nothing assumes how many there are.

   HONEST

   A lifecycle is what a manifest declares, never observed activity: the
   registry reports no live state, no run count and no timing, so none is drawn.
   A measured zero is drawn as 0; what the registry does not send is drawn as "—".

   This room paints with the canonical --fam-* tokens (public/tokens/
   familista-tokens.css), in the owner context, and declares no token of its own.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var AR = {
    data: null,            // GET /system/agents
    error: null,
    detail: {},            // agent id → GET /system/agents/:agentId
    detailError: {},
    open: null,            // the agent in the inspector, or null
    opener: null,          // where focus returns when the inspector closes
    view: 'map',           // map | catalogue | workflows
    q: '', scope: 'all', domain: 'all', lifecycle: 'all',
    langOpen: false,
    refreshing: false,
    wf: null,              // GET /system/agents/orchestration: verified LAB evidence (AI-0.3)
    wfError: null,
    wfLoading: false,
    pub: null,             // GET /system/agents/publications: approved LAB executions, verified (AI-0.5)
    pubError: null,
    pubLoading: false,
    run: null,             // the LAB workflow drawn: a v1 run's id, or 'x:' + a publication's id
    task: null,            // the task whose decisions are shown
    traceAll: true,        // the trace shows every event, or only the chosen task's
  };

  // ── localisation ──────────────────────────────────────────────────────────
  //
  // This room's own three-language catalogue, behind `data-no-i18n` on the page
  // root, the boundary every owner room keeps. Ids, digests, tool keys, record
  // kinds and enum tokens are identifiers and are never translated.

  var AR_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var AR_DICT = {};
  var AR_LANG = 'en';
  var AR_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < AR_LOCALES.length; i++) if (AR_LOCALES[i][0] === tag) return AR_LOCALES[i];
    return AR_LOCALES[0];
  }
  function initialLocale() {
    try {
      var v = localStorage.getItem('familista_agents_room_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { AR_DICT = {}; return Promise.resolve(); }
    return fetch('/agents-room/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { AR_DICT = d || {}; })
      .catch(function () { AR_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    AR_LANG = l[0]; AR_DIR = l[2];
    try { localStorage.setItem('familista_agents_room_locale', AR_LANG); } catch (_) {}
    return loadDict(AR_LANG);
  }
  function hasKey(k) { return Object.prototype.hasOwnProperty.call(AR_DICT, k); }

  /** Every key asked for, so the test suite can prove the catalogues cover what the screen really says. */
  var AR_SEEN = {};

  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s) return s;
    AR_SEEN[s] = 1;
    if (AR_LANG === 'en') return s;
    return hasKey(s) ? AR_DICT[s] : s;
  }
  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var i = 0;
    return T(key).replace(/%d/g, function () { var v = args[i++]; return v == null ? '—' : num(v); });
  }
  /**
   * Text the server wrote: a manifest's title and purpose, an invariant's detail.
   * Its numbers become %d slots for the lookup, and a "Prefix: names" sentence is
   * looked up by its prefix, the names kept as they are. What the catalogue does
   * not hold is shown in the English it came in, marked as English, as HTML.
   */
  function TX(text) {
    var s = String(text == null ? '' : text);
    if (!s) return '';
    if (AR_LANG === 'en') return esc(s);
    var nums = [];
    var key = s.replace(/\d+/g, function (m) { nums.push(Number(m)); return '%d'; });
    var fill = function (t) { var i = 0; return t.replace(/%d/g, function () { return num(nums[i++]); }); };
    if (hasKey(key)) return esc(fill(AR_DICT[key]));
    var cut = s.indexOf(': ');
    if (cut > 0 && hasKey(s.slice(0, cut))) {
      return esc(AR_DICT[s.slice(0, cut)]) + ': <bdi dir="ltr" data-no-i18n>' + esc(s.slice(cut + 2)) + '</bdi>';
    }
    return '<span lang="en" dir="ltr">' + esc(s) + '</span>';
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** A count, localised — or an em dash. `0` is an answer; absence is not. */
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(AR_LANG); } catch (_) { return String(n); }
  }
  function code(v) { return '<code data-no-i18n>' + esc(v) + '</code>'; }
  function short(hash, n) { return hash ? String(hash).slice(0, n || 12) : '—'; }
  function has(v) { return v !== null && v !== undefined; }
  /** A token the vocabulary has no label for, made readable: NEW_DOMAIN → "New domain". */
  function humanize(token) {
    var s = String(token == null ? '' : token).replace(/[_.-]+/g, ' ').trim().toLowerCase();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
  }
  function label(map, token) {
    return Object.prototype.hasOwnProperty.call(map, token) ? T(map[token]) : humanize(token);
  }
  function keysOf(o) { return o && typeof o === 'object' ? Object.keys(o) : []; }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // Labels for the tokens the registry speaks in. A token missing from a map is
  // not an error: it is a domain, a role or a state added after this file, and
  // it is drawn humanised.

  var DOMAIN_LABEL = {
    CLUB_OPERATIONS: 'Club operations', TACTICS: 'Tactics', TRAINING: 'Training', MATCH_OPERATIONS: 'Match operations',
    MEDICAL: 'Medical', SCOUTING: 'Scouting', FINANCE: 'Finance', COMMUNICATIONS: 'Communications', DEVICES: 'Devices',
    DATA: 'Data', VISION: 'Vision', EDUCATION: 'Education', COMMERCE: 'Commerce', MEDIA: 'Media',
    PLATFORM_OPERATIONS: 'Platform operations',
  };
  var SCOPE_LABEL = { CLUB: 'Club', PLATFORM: 'Platform' };
  var SCOPE_MEANING = {
    CLUB: 'Acts inside one club’s tenancy.',
    PLATFORM: 'Acts on the platform, under the Platform Owner, never in a Club Workspace.',
  };
  var LIFECYCLE_LABEL = { DRAFT: 'Draft', LAB: 'LAB', RUNNING: 'Running', RETIRED: 'Retired' };
  var LIFECYCLE_MEANING = {
    DRAFT: 'Declared in a reviewed manifest. Not bound to anything the platform runs.',
    LAB: 'Declared for LAB work with synthetic data. Not bound to anything the platform runs.',
    RUNNING: 'Declared running: bound to an agent the platform already runs.',
    RETIRED: 'Declared retired.',
  };
  var ENV_LABEL = { PRODUCTION: 'Production', STAGING: 'Staging', LAB: 'LAB', PREVIEW: 'Preview' };
  var CLASS_LABEL = { PUBLIC: 'Public', INTERNAL: 'Internal', CONFIDENTIAL: 'Confidential', RESTRICTED: 'Restricted' };
  var RECORD_CLASS_LABEL = { OPERATIONAL: 'Operational', SCOUTING: 'Scouting', FINANCE: 'Finance', MEDICAL: 'Medical' };
  var RECORD_TYPE_LABEL = { alert: 'Alert', recommendation: 'Recommendation', report: 'Report', job: 'Job' };
  var EFFECT_LABEL = { READ: 'Reads', DRAFT: 'Drafts', WRITE: 'Writes', PROTECTED: 'Protected' };
  var AUTONOMY_LABEL = { OBSERVE: 'Observe', RECOMMEND: 'Recommend', PREPARE: 'Prepare', ACT: 'Act', APPROVE: 'Approve', PROTECTED: 'Protected' };
  var ROLE_LABEL = {
    PLATFORM_OWNER: 'Platform Owner', SUPER_ADMIN: 'Super admin', CLUB_ADMIN: 'Club admin', MANAGER: 'Manager',
    HEAD_COACH: 'Head coach', ASSISTANT_COACH: 'Assistant coach', COACH: 'Coach', ANALYST: 'Analyst',
    MEDICAL_STAFF: 'Medical staff', SCOUT: 'Scout', PLAYER: 'Player', PARENT: 'Parent',
  };
  var INVARIANT_LABEL = {
    'manifests-valid': 'Every manifest validates',
    'runtime-agents-described': 'Every running agent is described',
    'profiles-agree': 'Manifests agree with the egress profiles',
    'outputs-agree': 'Outputs agree with the read policy',
    'no-protected-tools': 'No agent holds a protected tool',
    'ceiling-approve': 'No autonomy ceiling above Approve',
    'platform-agents-no-personal-data': 'Platform agents touch no personal data',
    'nothing-activated': 'Nothing new is activated',
  };
  /** The data-class ladder, lowest first. A class this file does not know is placed after it. */
  var CLASS_ORDER = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

  // ── pieces ────────────────────────────────────────────────────────────────

  function chip(kind, text, title, extra) {
    return '<span class="ar-chip ar-chip--' + kind + (extra ? ' ' + extra : '') + '"'
      + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<span class="ar-dot" aria-hidden="true"></span>' + esc(text) + '</span>';
  }
  function lifecycleKind(lc) { return LIFECYCLE_LABEL[lc] ? lc.toLowerCase() : 'unknown'; }
  function lifecycleChip(lc) {
    return chip('lc-' + lifecycleKind(lc), label(LIFECYCLE_LABEL, lc), LIFECYCLE_MEANING[lc] ? T(LIFECYCLE_MEANING[lc]) : '', 'ar-chip--sm');
  }
  function panel(title, body, note, extra) {
    return '<section class="ar-panel' + (extra ? ' ' + extra : '') + '">'
      + '<div class="ar-panel-head"><h2 class="ar-panel-title">' + esc(T(title)) + '</h2>'
      + (note ? '<span class="ar-panel-note">' + note + '</span>' : '') + '</div>' + body + '</section>';
  }
  function kv(k, v) {
    return '<div class="ar-kv"><div class="ar-kv-k">' + esc(T(k)) + '</div><div class="ar-kv-v">' + v + '</div></div>';
  }
  function emptyState(title, why, extra) {
    return '<div class="ar-empty" role="status"><div class="ar-empty-mark" aria-hidden="true">—</div>'
      + '<div class="ar-empty-title">' + esc(T(title)) + '</div>'
      + (why ? '<div class="ar-empty-why">' + esc(why) + '</div>' : '') + (extra || '') + '</div>';
  }
  function skeleton(rows, cls) {
    var out = '';
    for (var i = 0; i < rows; i++) out += '<div class="ar-skel-row ar-skel-row--' + cls + '"></div>';
    return '<div class="ar-skel" role="status" aria-label="' + esc(T('Reading the registry…')) + '">' + out + '</div>';
  }

  // ── reading the registry ──────────────────────────────────────────────────

  function apiBase() {
    return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE) ? window.FAM_CONFIG.API_BASE : '/api/v1';
  }
  function token() {
    try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) { return ''; }
  }
  /** GET only. This room has no other verb to call. */
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, {
      method: 'GET',
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      credentials: 'include',
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open the AI Agents Operations Room.'));
      if (r.status === 404) throw new Error(T('The registry does not hold this agent.'));
      if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
      return r.json();
    }).then(function (b) { return (b && b.data) || b; });
  }

  /** The fields this screen cannot draw without. An absent field is reported, never drawn as empty. */
  var REQUIRED = {
    overview: ['environment', 'activation', 'killSwitch', 'registry', 'invariants', 'agents'],
    detail: ['agent', 'autonomyCeiling', 'tools', 'outputs', 'issues'],
    orchestration: ['state', 'notice', 'registry', 'agents', 'operations', 'runs'],
    publications: ['state', 'notice', 'rule', 'record', 'checks', 'unapproved', 'publications'],
  };
  function missingFields(payload, required) {
    return required.filter(function (k) { return !payload || payload[k] === undefined || payload[k] === null; });
  }
  function contractError(endpoint, missing) {
    return T('CONTRACT ERROR') + ' · ' + endpoint + ' · ' + T('the response did not carry:') + ' ' + missing.join(', ');
  }

  function loadOverview() {
    return api('/system/agents').then(function (d) {
      var missing = missingFields(d, REQUIRED.overview);
      if (!missing.length && !Array.isArray(d.agents)) missing = ['agents'];
      if (missing.length) { AR.data = null; AR.error = contractError('/system/agents', missing); return; }
      AR.data = {
        environment: d.environment, activation: d.activation, killSwitch: d.killSwitch,
        registry: d.registry, invariants: d.invariants || [], agents: d.agents,
      };
      AR.error = null;
    }).catch(function (e) { AR.data = null; AR.error = e.message; });
  }
  function loadDetail(id) {
    return api('/system/agents/' + encodeURIComponent(id)).then(function (x) {
      var missing = missingFields(x, REQUIRED.detail);
      if (missing.length) { AR.detailError[id] = contractError('/system/agents/:agentId', missing); return; }
      AR.detail[id] = { agent: x.agent, autonomyCeiling: x.autonomyCeiling, tools: x.tools, outputs: x.outputs, issues: x.issues };
      delete AR.detailError[id];
    }).catch(function (e) { AR.detailError[id] = e.message; });
  }

  // ── what the registry holds, as this screen needs it ──────────────────────

  function agents() { return (AR.data && AR.data.agents) || []; }
  function summaryOf(id) {
    var list = agents();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** Every domain the registry counts, then any an agent carries that it did not count, in the order the server gave. */
  function domains() {
    var reg = AR.data && AR.data.registry;
    var out = keysOf(reg && reg.byDomain);
    agents().forEach(function (a) { if (out.indexOf(a.domain) < 0) out.push(a.domain); });
    return out;
  }
  function tally(field, key) {
    var reg = AR.data && AR.data.registry;
    var byField = reg && reg[field];
    if (byField && typeof byField[key] === 'number') return byField[key];
    var n = 0;
    agents().forEach(function (a) {
      var v = field === 'byDomain' ? a.domain : field === 'byScope' ? a.scope : a.lifecycle;
      if (v === key) n++;
    });
    return n;
  }
  function scopes() {
    var out = keysOf(AR.data && AR.data.registry && AR.data.registry.byScope);
    agents().forEach(function (a) { if (out.indexOf(a.scope) < 0) out.push(a.scope); });
    return out;
  }
  function lifecycles() {
    var out = keysOf(AR.data && AR.data.registry && AR.data.registry.byLifecycle);
    agents().forEach(function (a) { if (out.indexOf(a.lifecycle) < 0) out.push(a.lifecycle); });
    return out;
  }
  function matches(a) {
    if (AR.scope !== 'all' && a.scope !== AR.scope) return false;
    if (AR.domain !== 'all' && a.domain !== AR.domain) return false;
    if (AR.lifecycle !== 'all' && a.lifecycle !== AR.lifecycle) return false;
    var q = AR.q.trim().toLowerCase();
    if (!q) return true;
    var hay = [a.id, a.title, T(a.title), a.domain, label(DOMAIN_LABEL, a.domain), label(SCOPE_LABEL, a.scope),
      label(LIFECYCLE_LABEL, a.lifecycle), a.supervisor, label(ROLE_LABEL, a.supervisor), a.runtimeAgent || ''].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function filtered() { return agents().filter(matches); }
  function invariantsHold() {
    var inv = (AR.data && AR.data.invariants) || [];
    return { total: inv.length, holding: inv.filter(function (i) { return i.holds === true; }).length };
  }

  // ── shell ─────────────────────────────────────────────────────────────────

  function languageSwitchHtml() {
    var active = localeOf(AR_LANG);
    return '<div class="ar-langs' + (AR.langOpen ? ' is-open' : '') + '">'
      + '<button class="ar-btn ar-lang-pick" type="button" data-ar-langs aria-haspopup="true" aria-expanded="' + (AR.langOpen ? 'true' : 'false') + '"'
      + ' aria-label="' + esc(active[1] + ' · ' + T('Operations Room language')) + '">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="ar-lang-ch" aria-hidden="true">⌄</span></button>'
      + '<div class="ar-lang-menu" role="group" aria-label="' + esc(T('Operations Room language')) + '">'
      + AR_LOCALES.map(function (l) {
        return '<button class="ar-lang' + (l[0] === AR_LANG ? ' is-on' : '') + '" type="button" data-ar-lang="' + l[0] + '" lang="' + l[0] + '"'
          + ' data-no-i18n aria-pressed="' + (l[0] === AR_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  function topHtml() {
    return '<header class="ar-top"><div class="ar-top-l">'
      + '<button class="ar-back" type="button" data-ar-back><span aria-hidden="true">←</span> ' + esc(T('SYSTEM · AI Agent Control')) + '</button>'
      + '<div class="ar-brand"><span class="ar-mark" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" focusable="false">'
      + '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8.5" stroke-dasharray="2 2.4"/><circle cx="12" cy="3.5" r="1.4"/><circle cx="19.4" cy="16.2" r="1.4"/><circle cx="4.6" cy="16.2" r="1.4"/></svg></span>'
      + '<div class="ar-brand-t"><div class="ar-eyebrow">' + esc(T('PLATFORM OWNER · GLOBAL')) + '</div>'
      + '<h1 class="ar-title">' + esc(T('AI Agents Operations Room')) + '</h1></div></div></div>'
      + '<div class="ar-top-r">' + chip('info', T('Read-only'), T('Nothing in this room starts, stops or changes an agent.'), 'ar-chip--sm')
      + languageSwitchHtml()
      + '<button class="ar-btn" type="button" data-ar-refresh' + (AR.refreshing ? ' disabled aria-busy="true"' : '') + '>'
      + esc(T(AR.refreshing ? 'Reading…' : 'Refresh')) + '</button></div></header>';
  }

  /** The integrity rail: what the registry says about itself, one fact per cell. */
  function railHtml() {
    if (!AR.data) {
      var cells = '';
      for (var i = 0; i < 5; i++) cells += '<div class="ar-cell ar-cell--skel"></div>';
      return '<section class="ar-rail" id="ar-rail" aria-label="' + esc(T('Registry integrity')) + '" aria-busy="' + (AR.error ? 'false' : 'true') + '">' + cells + '</section>';
    }
    var d = AR.data, reg = d.registry || {}, act = d.activation || {}, ks = d.killSwitch || {};
    var inv = invariantsHold();
    var allHold = inv.total > 0 && inv.holding === inv.total;
    var cell = function (k, v, sub, extra) {
      return '<div class="ar-cell' + (extra ? ' ' + extra : '') + '"><div class="ar-cell-k">' + esc(T(k)) + '</div>'
        + '<div class="ar-cell-v">' + v + '</div><div class="ar-cell-sub">' + (sub || '&nbsp;') + '</div></div>';
    };
    return '<section class="ar-rail" id="ar-rail" aria-label="' + esc(T('Registry integrity')) + '">'
      + cell('Registry digest', '<span class="ar-digest" title="' + esc(reg.digest || '') + '">' + code(short(reg.digest, 16)) + '</span>',
        esc(T('SHA-256 over every manifest, in any order')), 'ar-cell--digest')
      + cell('Agents described', '<span class="ar-big">' + esc(num(reg.agents)) + '</span>',
        esc(tf('%d domains · %d scopes', domains().length, scopes().length)))
      + cell('Governance', chip(allHold ? 'ok' : 'crit', allHold ? T('Every invariant holds') : tf('%d of %d invariants fail', inv.total - inv.holding, inv.total), '', 'ar-chip--sm'),
        esc(tf('%d of %d hold · computed on this read', inv.holding, inv.total)))
      + cell('Activation', chip(act.newAgentsActive === 0 ? 'none' : 'warn', act.newAgentsActive === 0 ? T('No new agent active') : tf('%d new agents active', act.newAgentsActive), '', 'ar-chip--sm'),
        esc(act.labRuntime === 'NOT_PRESENT' ? T('LAB runtime: not present') : T('LAB runtime: reported present')))
      + cell('Kill switch', chip(ks.engaged === true ? 'warn' : 'none', ks.engaged === true ? T('Engaged: autonomous actions stopped') : ks.engaged === false ? T('Not engaged') : '—', '', 'ar-chip--sm'),
        esc(T('State only. It is changed in SYSTEM → AI Agent Control.')))
      + cell('Environment', '<span class="ar-env">' + esc(label(ENV_LABEL, d.environment)) + '</span>', esc(T('As this server reports it')))
      + '</section>';
  }

  function toolbarHtml() {
    var opt = function (value, text, on) { return '<option value="' + esc(value) + '"' + (on ? ' selected' : '') + '>' + esc(text) + '</option>'; };
    var select = function (id, labelText, all, values, map, current) {
      return '<label class="ar-field"><span class="ar-sr">' + esc(T(labelText)) + '</span>'
        + '<select class="ar-input" id="' + id + '">' + opt('all', T(all), current === 'all')
        + values.map(function (v) { return opt(v, label(map, v), current === v); }).join('') + '</select></label>';
    };
    var tab = function (key, text) {
      var on = AR.view === key;
      return '<button class="ar-tab' + (on ? ' is-on' : '') + '" type="button" role="tab" id="ar-tab-' + key + '" data-ar-view="' + key + '"'
        + ' aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="ar-view" tabindex="' + (on ? '0' : '-1') + '">' + esc(T(text)) + '</button>';
    };
    return '<div class="ar-toolbar"><div class="ar-tabs" role="tablist" aria-label="' + esc(T('Views')) + '">'
      + tab('map', 'Registry map') + tab('catalogue', 'Catalogue') + tab('workflows', 'LAB workflows') + '</div>'
      + '<div class="ar-filters' + (AR.view === 'workflows' ? ' is-idle' : '') + '"' + (AR.view === 'workflows' ? ' aria-hidden="true"' : '') + '>'
      + '<label class="ar-field ar-field--q"><span class="ar-sr">' + esc(T('Search agents')) + '</span>'
      + '<input class="ar-input" id="ar-q" type="search" autocomplete="off" spellcheck="false" value="' + esc(AR.q) + '" placeholder="' + esc(T('Search agents, ids, domains…')) + '"></label>'
      + select('ar-scope', 'Scope', 'All scopes', scopes(), SCOPE_LABEL, AR.scope)
      + select('ar-domain', 'Domain', 'All domains', domains(), DOMAIN_LABEL, AR.domain)
      + select('ar-lifecycle', 'Lifecycle', 'All lifecycles', lifecycles(), LIFECYCLE_LABEL, AR.lifecycle)
      + '<span class="ar-count" id="ar-count" role="status">' + esc(countText()) + '</span>'
      + '</div></div>';
  }
  function countText() {
    if (AR.view === 'workflows') return AR.wf ? tf('LAB workflows: %d', wfRuns().length) : '';
    return tf('Showing %d of %d agents', filtered().length, agents().length);
  }

  // ── the registry map ──────────────────────────────────────────────────────
  //
  // One ring of sectors, one per domain the registry counts, sized 360/N so a
  // sixteenth domain is a sixteenth sector. An agent is a node inside its
  // domain's sector: club-scoped agents on the inner orbits, platform-scoped on
  // the outer one. A node's outline says its declared lifecycle. Nothing moves.

  var MAP_W = 1500, MAP_H = 1000;
  var R_CORE = 86, R_BAND_IN = 392, R_BAND_OUT = 426, R_LABEL = 450;
  var ORBIT_ROWS = { CLUB: [286, 240, 194, 148], PLATFORM: [344] };
  var ORBIT_OTHER = [316];

  function rad(d) { return d * Math.PI / 180; }
  function pt(r, d) { return { x: r * Math.cos(rad(d)), y: r * Math.sin(rad(d)) }; }
  function f1(n) { return String(Math.round(n * 10) / 10); }
  function sectorPath(r1, r2, a0, a1) {
    var lo = Math.min(a0, a1), hi = Math.max(a0, a1), large = hi - lo > 180 ? 1 : 0;
    var p1 = pt(r2, lo), p2 = pt(r2, hi), p3 = pt(r1, hi), p4 = pt(r1, lo);
    return 'M' + f1(p1.x) + ' ' + f1(p1.y) + 'A' + r2 + ' ' + r2 + ' 0 ' + large + ' 1 ' + f1(p2.x) + ' ' + f1(p2.y)
      + 'L' + f1(p3.x) + ' ' + f1(p3.y) + 'A' + r1 + ' ' + r1 + ' 0 ' + large + ' 0 ' + f1(p4.x) + ' ' + f1(p4.y) + 'Z';
  }
  /** Each sector's angles: the first centred at the top, then clockwise, mirrored for a right-to-left reader. */
  function sectorAngles(i, n) {
    var step = 360 / n;
    var mid = -90 + (AR_DIR === 'rtl' ? -1 : 1) * i * step;
    return { start: mid - step / 2, end: mid + step / 2, mid: mid, step: step };
  }
  /** Where each agent of one sector sits: rows of an orbit, filled inner-first, nodes shrinking only when a sector overflows. */
  function placeSector(list, sec) {
    var pad = Math.min(3, sec.step / 6);
    var lo = sec.start + pad, span = sec.step - 2 * pad;
    var byScope = {};
    list.forEach(function (a) { (byScope[a.scope] = byScope[a.scope] || []).push(a); });
    var placed = [];
    Object.keys(byScope).forEach(function (scope) {
      var rows = ORBIT_ROWS[scope] || ORBIT_OTHER;
      var items = byScope[scope];
      var cap = rows.map(function (r) { return Math.max(1, Math.floor(rad(span) * r / 40)); });
      var perRow = rows.map(function () { return []; });
      var k = 0;
      items.forEach(function (a) {
        while (k < rows.length - 1 && perRow[k].length >= cap[k]) k++;
        perRow[k].push(a);
      });
      perRow.forEach(function (row, ri) {
        var r = rows[ri];
        var size = Math.max(6, Math.min(16, (rad(span) * r / Math.max(1, row.length)) / 2 - 4));
        row.forEach(function (a, j) {
          var ang = lo + span * (j + 0.5) / row.length;
          var p = pt(r, ang);
          placed.push({ a: a, x: p.x, y: p.y, ang: ang, size: size });
        });
      });
    });
    return placed;
  }

  function nodeLabel(a) {
    return T(a.title) + ' · ' + a.id + ' · ' + label(DOMAIN_LABEL, a.domain) + ' · ' + label(SCOPE_LABEL, a.scope)
      + ' · ' + label(LIFECYCLE_LABEL, a.lifecycle);
  }

  function mapSvg() {
    var doms = domains();
    var n = Math.max(1, doms.length);
    var inv = invariantsHold();
    var core = inv.total > 0 && inv.holding === inv.total ? 'ok' : 'crit';
    var reg = (AR.data && AR.data.registry) || {};
    var out = '<svg class="ar-map" viewBox="' + (-MAP_W / 2) + ' ' + (-MAP_H / 2) + ' ' + MAP_W + ' ' + MAP_H + '" role="group"'
      + ' aria-labelledby="ar-map-title" direction="ltr" focusable="false">'
      + '<title id="ar-map-title">' + esc(T('Registry map: every domain as a sector, every agent as a node in its domain')) + '</title>';
    // Orbits: where club-scoped and platform-scoped agents sit.
    out += '<circle class="ar-orbit ar-orbit--club" r="' + ORBIT_ROWS.CLUB[0] + '"/>'
      + '<circle class="ar-orbit ar-orbit--platform" r="' + ORBIT_ROWS.PLATFORM[0] + '"/>';
    var nodes = '', spokes = '', sectors = '', labels = '';
    doms.forEach(function (dom, i) {
      var sec = sectorAngles(i, n);
      var count = tally('byDomain', dom);
      var gap = Math.min(0.9, sec.step / 8);
      var dim = AR.domain !== 'all' && AR.domain !== dom;
      sectors += '<path class="ar-sec' + (count > 0 ? ' ar-sec--held' : '') + (AR.domain === dom ? ' is-on' : '') + (dim ? ' is-dim' : '') + '"'
        + ' d="' + sectorPath(R_BAND_IN, R_BAND_OUT, sec.start + gap, sec.end - gap) + '" data-ar-sector="' + esc(dom) + '" aria-hidden="true"/>';
      var lp = pt(R_LABEL, sec.mid), c = Math.cos(rad(sec.mid)), s = Math.sin(rad(sec.mid));
      var anchor = c > 0.12 ? 'start' : c < -0.12 ? 'end' : 'middle';
      var dy = s < -0.8 ? -6 : s > 0.8 ? 18 : 6;
      labels += '<text class="ar-sec-t' + (count > 0 ? ' ar-sec-t--held' : '') + (dim ? ' is-dim' : '') + '" x="' + f1(lp.x) + '" y="' + f1(lp.y + dy) + '" text-anchor="' + anchor + '" aria-hidden="true">'
        + esc(label(DOMAIN_LABEL, dom)) + '<tspan class="ar-sec-n"> ' + esc(num(count)) + '</tspan></text>';
      var inDomain = agents().filter(function (a) { return a.domain === dom; });
      placeSector(inDomain, sec).forEach(function (p) {
        var a = p.a, on = matches(a), open = AR.open === a.id;
        var from = pt(R_CORE + 10, p.ang);
        spokes += '<line class="ar-spoke' + (on ? '' : ' is-dim') + (open ? ' is-open' : '') + '" x1="' + f1(from.x) + '" y1="' + f1(from.y) + '" x2="' + f1(p.x) + '" y2="' + f1(p.y) + '"/>';
        var lc = lifecycleKind(a.lifecycle);
        // Positioned by each circle's own centre, never by a transform on the group: a hovered, focusable
        // SVG group positioned by its transform attribute is hit-tested at the origin in Chromium, so the
        // node would slip out from under the pointer that hovers it.
        var at = ' cx="' + f1(p.x) + '" cy="' + f1(p.y) + '"';
        nodes += '<g class="ar-node ar-node--' + lc + (on ? '' : ' is-dim') + (open ? ' is-open' : '') + '"'
          + ' tabindex="0" role="button" data-ar-agent="' + esc(a.id) + '" aria-label="' + esc(nodeLabel(a)) + '">'
          + '<title>' + esc(nodeLabel(a)) + '</title>'
          + '<circle class="ar-node-halo"' + at + ' r="' + f1(p.size + 9) + '"/>'
          + '<circle class="ar-node-body"' + at + ' r="' + f1(p.size) + '"/>'
          + (lc === 'running' ? '<circle class="ar-node-core"' + at + ' r="' + f1(Math.max(2, p.size / 3)) + '"/>' : '')
          + '</g>';
      });
    });
    out += sectors + labels + spokes;
    out += '<circle class="ar-core-ring ar-core-ring--' + core + '" r="' + (R_CORE + 10) + '"/>'
      + '<circle class="ar-core" r="' + R_CORE + '"/>'
      + '<text class="ar-core-n" y="-4" text-anchor="middle">' + esc(num(reg.agents)) + '</text>'
      + '<text class="ar-core-l" y="26" text-anchor="middle">' + esc(T('AGENTS')) + '</text>'
      + '<text class="ar-core-d" y="50" text-anchor="middle" data-no-i18n>' + esc(short(reg.digest, 8)) + '</text>';
    out += nodes + '</svg>';
    return out;
  }

  function legendHtml() {
    var glyph = function (kind) {
      return '<svg class="ar-glyph" viewBox="-12 -12 24 24" width="18" height="18" aria-hidden="true" focusable="false"><g class="ar-node ar-node--' + kind + '">'
        + '<circle class="ar-node-body" r="8"/>' + (kind === 'running' ? '<circle class="ar-node-core" r="3"/>' : '') + '</g></svg>';
    };
    var items = lifecycles().map(function (lc) {
      return '<li class="ar-legend-i">' + glyph(lifecycleKind(lc)) + '<span>' + esc(label(LIFECYCLE_LABEL, lc)) + '</span>'
        + '<span class="ar-legend-n">' + esc(num(tally('byLifecycle', lc))) + '</span></li>';
    }).join('');
    return '<div class="ar-legend"><ul class="ar-legend-l" aria-label="' + esc(T('Lifecycle, as each manifest declares it')) + '">' + items + '</ul>'
      + '<p class="ar-legend-note">' + esc(T('Inner orbits: club scope. Outer orbit: platform scope. A lifecycle is what the manifest declares, not live activity.')) + '</p></div>';
  }

  function domainListHtml() {
    return '<ul class="ar-domains" aria-label="' + esc(T('Domains')) + '">' + domains().map(function (dom) {
      var on = AR.domain === dom, count = tally('byDomain', dom);
      return '<li><button class="ar-dom' + (on ? ' is-on' : '') + (count > 0 ? '' : ' ar-dom--empty') + '" type="button" data-ar-domain="' + esc(dom) + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<span>' + esc(label(DOMAIN_LABEL, dom)) + '</span><span class="ar-dom-n">' + esc(num(count)) + '</span></button></li>';
    }).join('') + '</ul>';
  }

  function mapViewHtml() {
    if (!agents().length) {
      return emptyState('The registry describes no agent', T('An agent appears here once its manifest is added to the registry in a reviewed pull request.'));
    }
    return '<div class="ar-map-wrap">' + mapSvg() + '</div>'
      + '<p class="ar-caption" id="ar-caption" aria-live="polite">' + esc(T('Choose an agent to inspect its manifest.')) + '</p>'
      + legendHtml() + domainListHtml();
  }

  // ── the catalogue ─────────────────────────────────────────────────────────

  function catalogueHtml() {
    var list = filtered();
    if (!agents().length) {
      return emptyState('The registry describes no agent', T('An agent appears here once its manifest is added to the registry in a reviewed pull request.'));
    }
    if (!list.length) {
      return emptyState('No agent matches these filters', T('Clear the search or choose another scope, domain or lifecycle.'),
        '<button class="ar-btn ar-btn--sm" type="button" data-ar-clear>' + esc(T('Clear filters')) + '</button>');
    }
    var th = function (t, cls) { return '<th scope="col"' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(T(t)) + '</th>'; };
    return '<div class="ar-table-wrap"><table class="ar-table"><caption class="ar-sr">' + esc(T('Every agent in the registry')) + '</caption><thead><tr>'
      + th('Agent') + th('Domain') + th('Scope') + th('Lifecycle') + th('Autonomy ceiling') + th('Data ceiling')
      + th('Tools', 'ar-num') + th('Outputs', 'ar-num') + th('Supervisor') + '</tr></thead><tbody>'
      + list.map(function (a) {
        var td = function (l, v, cls) { return '<td data-l="' + esc(T(l)) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td>'; };
        return '<tr class="ar-row' + (AR.open === a.id ? ' is-open' : '') + '" data-ar-agent="' + esc(a.id) + '">'
          + '<td class="ar-c-agent"><button class="ar-row-open" type="button" data-ar-agent="' + esc(a.id) + '">' + TX(a.title) + '</button>'
          + '<div class="ar-row-id">' + code(a.id) + ' <span class="ar-ver" data-no-i18n>v' + esc(a.version) + '</span></div></td>'
          + td('Domain', esc(label(DOMAIN_LABEL, a.domain)))
          + td('Scope', esc(label(SCOPE_LABEL, a.scope)))
          + td('Lifecycle', lifecycleChip(a.lifecycle))
          + td('Autonomy ceiling', esc(label(AUTONOMY_LABEL, a.autonomyCeiling)))
          + td('Data ceiling', esc(label(CLASS_LABEL, a.dataCeiling)))
          + td('Tools', esc(num(a.tools)), 'ar-num')
          + td('Outputs', esc(num(a.outputs)), 'ar-num')
          + td('Supervisor', esc(label(ROLE_LABEL, a.supervisor)))
          + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ── governance: the invariants, and what the registry is made of ──────────

  function bars(rows) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    return '<ul class="ar-bars">' + rows.map(function (r) {
      var w = Math.round((r.value / max) * 1000) / 10;
      return '<li class="ar-bar"><div class="ar-bar-l"><span>' + esc(r.label) + '</span><span class="ar-bar-n">' + esc(num(r.value)) + '</span></div>'
        + '<svg class="ar-bar-track" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
        + '<rect class="ar-bar-bg" width="100" height="4" rx="2"/><rect class="ar-bar-fill" width="' + w + '" height="4" rx="2"/></svg></li>';
    }).join('') + '</ul>';
  }

  function sideHtml() {
    if (!AR.data) return AR.error ? '' : skeleton(8, 'side');
    var inv = AR.data.invariants || [];
    var rows = inv.length ? '<ul class="ar-inv">' + inv.map(function (i) {
      var ok = i.holds === true;
      return '<li class="ar-inv-i ar-inv-i--' + (ok ? 'ok' : 'crit') + '">'
        + '<span class="ar-inv-mark" aria-hidden="true">' + (ok ? '✓' : '✕') + '</span>'
        + '<div class="ar-inv-b"><div class="ar-inv-t">' + esc(INVARIANT_LABEL[i.id] ? T(INVARIANT_LABEL[i.id]) : humanize(i.id))
        + ' <span class="ar-sr">' + esc(ok ? T('holds') : T('fails')) + '</span></div>'
        + (i.detail && i.detail !== INVARIANT_LABEL[i.id] ? '<div class="ar-inv-d">' + TX(i.detail) + '</div>' : '') + '</div></li>';
    }).join('') + '</ul>'
      : emptyState('No invariant was reported', T('The registry endpoint returned no invariant to show.'));
    var scopeRows = scopes().map(function (s) { return { label: label(SCOPE_LABEL, s), value: tally('byScope', s) }; });
    var lcRows = lifecycles().map(function (l) { return { label: label(LIFECYCLE_LABEL, l), value: tally('byLifecycle', l) }; });
    return panel('Governance', rows, esc(T('Computed by the server on every read')))
      + panel('Composition', '<div class="ar-sub">' + esc(T('By scope')) + '</div>' + bars(scopeRows)
        + '<div class="ar-sub">' + esc(T('By lifecycle')) + '</div>' + bars(lcRows))
      + panel('What this room shows', '<p class="ar-note">' + esc(T('Manifests and checks the server computes, and nothing else: no club, no person, no record. Lifecycles are declared, not observed; the registry reports no live activity, so none is drawn. An agent or a domain added to the registry appears here without a change to this room.')) + '</p>');
  }

  // ── one agent: its manifest, in full ──────────────────────────────────────

  function ladderHtml(m) {
    var reads = (m.data && m.data.reads) || [], writes = (m.data && m.data.writes) || [];
    var order = CLASS_ORDER.slice();
    reads.concat(writes).forEach(function (c) { if (order.indexOf(c) < 0) order.push(c); });
    return '<ol class="ar-ladder" aria-label="' + esc(T('Data classes, lowest first')) + '">' + order.map(function (c) {
      var r = reads.indexOf(c) >= 0, w = writes.indexOf(c) >= 0;
      return '<li class="ar-step' + (r || w ? ' is-held' : '') + '"><span class="ar-step-name">' + esc(label(CLASS_LABEL, c)) + '</span>'
        + '<span class="ar-step-marks">' + (r ? chip('neutral', T('Reads'), '', 'ar-chip--xs') : '') + (w ? chip('neutral', T('Writes'), '', 'ar-chip--xs') : '')
        + (!r && !w ? '<span class="ar-step-none" aria-label="' + esc(T('Not touched')) + '">—</span>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }

  function inspectorBodyHtml(id) {
    var sum = summaryOf(id);
    var d = AR.detail[id], err = AR.detailError[id];
    if (err) {
      return emptyState('This manifest could not be read', err,
        '<button class="ar-btn ar-btn--sm" type="button" data-ar-retry="' + esc(id) + '">' + esc(T('Try again')) + '</button>');
    }
    if (!d) return skeleton(6, 'insp');
    var m = d.agent || {};
    var tools = (d.tools || []).length ? '<table class="ar-mini"><caption class="ar-sr">' + esc(T('Tools')) + '</caption><thead><tr><th scope="col">' + esc(T('Tool')) + '</th><th scope="col">' + esc(T('Effect')) + '</th>'
      + '<th scope="col">' + esc(T('Minimum autonomy')) + '</th><th scope="col">' + esc(T('Data class')) + '</th></tr></thead><tbody>'
      + d.tools.map(function (t) {
        return '<tr><td>' + code(t.key) + '</td><td>' + chip(t.effect === 'PROTECTED' ? 'none' : 'neutral', label(EFFECT_LABEL, t.effect), '', 'ar-chip--xs') + '</td>'
          + '<td>' + esc(label(AUTONOMY_LABEL, t.minAutonomy)) + '</td><td>' + esc(label(CLASS_LABEL, t.classification)) + '</td></tr>';
      }).join('') + '</tbody></table>'
      : '<p class="ar-note">' + esc(T('This agent holds no tool.')) + '</p>';
    var outputs = (d.outputs || []).length ? '<ul class="ar-outs">' + d.outputs.map(function (o) {
      return '<li class="ar-out"><div class="ar-out-h"><span class="ar-out-type">' + esc(label(RECORD_TYPE_LABEL, o.type)) + '</span>' + code(o.kind) + '</div>'
        + '<div class="ar-out-row"><span class="ar-out-k">' + esc(T('Record classes')) + '</span><span class="ar-out-v">'
        + ((o.classes || []).length ? o.classes.map(function (c) { return chip('neutral', label(RECORD_CLASS_LABEL, c), '', 'ar-chip--xs'); }).join(' ') : '—') + '</span></div>'
        + '<div class="ar-out-row"><span class="ar-out-k">' + esc(T('Readable by')) + '</span><span class="ar-out-v">'
        + ((o.readableBy || []).length ? esc(o.readableBy.map(function (r) { return label(ROLE_LABEL, r); }).join(' · ')) : esc(T('No role'))) + '</span></div></li>';
    }).join('') + '</ul>'
      : '<p class="ar-note">' + esc(T('This agent writes no AI record.')) + '</p>';
    var issues = d.issues || [];
    var validation = issues.length
      ? '<ul class="ar-issues">' + issues.map(function (x) { return '<li>' + code(x.code) + ' <span lang="en" dir="ltr">' + esc(x.message) + '</span></li>'; }).join('') + '</ul>'
      : chip('ok', T('The manifest validates'), '', 'ar-chip--sm');
    return '<p class="ar-purpose">' + TX(m.purpose) + '</p>'
      + '<section class="ar-insp-sec"><h3 class="ar-insp-h">' + esc(T('Capability')) + '</h3>'
      + kv('Autonomy ceiling', esc(label(AUTONOMY_LABEL, d.autonomyCeiling)) + ' <span class="ar-hint">' + esc(T('Every action waits for a person at or below this level.')) + '</span>')
      + '<div class="ar-sub">' + esc(T('Data it reads and writes')) + '</div>' + ladderHtml(m)
      + '<div class="ar-sub">' + esc(tf('Tools · %d', (d.tools || []).length)) + '</div>' + tools + '</section>'
      + '<section class="ar-insp-sec"><h3 class="ar-insp-h">' + esc(tf('Outputs · %d', (d.outputs || []).length)) + '</h3>' + outputs + '</section>'
      + '<section class="ar-insp-sec"><h3 class="ar-insp-h">' + esc(T('Accountability')) + '</h3>'
      + kv('Supervisor', esc(label(ROLE_LABEL, m.supervisor)))
      + kv('Scope', esc(label(SCOPE_LABEL, m.scope)) + (SCOPE_MEANING[m.scope] ? ' <span class="ar-hint">' + esc(T(SCOPE_MEANING[m.scope])) + '</span>' : ''))
      + kv('Runtime binding', m.binding && m.binding.legacyAgent ? code(m.binding.legacyAgent) : esc(T('Not bound to a runtime agent')))
      + '</section>'
      + '<section class="ar-insp-sec"><h3 class="ar-insp-h">' + esc(T('Integrity')) + '</h3>'
      + kv('Version', code(m.version || (sum && sum.version) || '—'))
      + kv('Validation', validation)
      + '<div class="ar-sub">' + esc(T('Manifest digest')) + '</div><div class="ar-hash">' + code(m.digest || '—') + '</div></section>'
      + '<p class="ar-foot-note">' + esc(T('Read-only. This is the manifest as it was reviewed, not live telemetry.')) + '</p>';
  }

  function inspectorHtml() {
    var id = AR.open;
    if (!id) return '';
    var sum = summaryOf(id) || { id: id, title: id, domain: '', scope: '', lifecycle: '' };
    return '<header class="ar-insp-top"><div class="ar-insp-l"><div class="ar-eyebrow">' + esc(label(DOMAIN_LABEL, sum.domain) + ' · ' + label(SCOPE_LABEL, sum.scope)) + '</div>'
      + '<h2 class="ar-insp-title" id="ar-insp-title">' + TX(sum.title) + '</h2>'
      + '<div class="ar-insp-id">' + code(sum.id) + ' ' + lifecycleChip(sum.lifecycle) + '</div></div>'
      + '<button class="ar-btn ar-btn--icon" type="button" data-ar-close aria-label="' + esc(T('Close the manifest')) + '"><span aria-hidden="true">✕</span></button></header>'
      + '<div class="ar-insp-body" id="ar-insp-body" tabindex="0" role="region" aria-labelledby="ar-insp-title">' + inspectorBodyHtml(id) + '</div>';
  }

  // ── LAB workflows (AI-0.3) ────────────────────────────────────────────────
  //
  // The LAB Multi-Agent Orchestrator's published evidence, as the server verified
  // it: synthetic runs over the Agent Registry, never anything production ran.
  // Each run is drawn as its tasks, left to right in dependency order, each on
  // the agent routing chose, each edge the handoff it was. Everything drawn is a
  // field of the evidence; a task or an edge the evidence does not hold is not
  // drawn, and evidence the server did not verify is not drawn at all.

  var STATE_KIND = { SUCCEEDED: 'done', AWAITING_APPROVAL: 'approval', PENDING: 'waiting', REJECTED: 'rejected', FAILED: 'failed', SKIPPED: 'skipped', REFUSED: 'blocked', CANCELLED: 'cancelled' };
  var STATE_CHIP = { done: 'ok', approval: 'info', waiting: 'none', rejected: 'neutral', failed: 'crit', skipped: 'none', blocked: 'blocked', cancelled: 'warn' };
  var STATE_LABEL = {
    SUCCEEDED: 'Completed', AWAITING_APPROVAL: 'Pending approval', PENDING: 'Waiting', REJECTED: 'Rejected',
    FAILED: 'Failed', SKIPPED: 'Skipped', REFUSED: 'Blocked by governance', CANCELLED: 'Cancelled',
  };
  var STATE_MEANING = {
    SUCCEEDED: 'Ran in the Lab, and its output validated.',
    AWAITING_APPROVAL: 'An action that waits for a person to decide.',
    PENDING: 'Waits for something it consumes to be decided.',
    REJECTED: 'A person declined the action.',
    FAILED: 'Ran, or tried to, and produced no valid output.',
    SKIPPED: 'Something it consumes did not succeed, so it never ran.',
    REFUSED: 'A governance rule stopped it before it ran.',
    CANCELLED: 'The execution was stopped before this task finished, so it did not complete.',
  };
  var STATE_ORDER = ['SUCCEEDED', 'AWAITING_APPROVAL', 'PENDING', 'REJECTED', 'FAILED', 'SKIPPED', 'REFUSED', 'CANCELLED'];
  var OUTCOME_LABEL = {
    COMPLETED: 'Completed', PARTIAL: 'Partly completed', FAILED: 'Failed', AWAITING_APPROVAL: 'Awaiting approval', REFUSED: 'Refused',
    CANCELLED: 'Cancelled', HALTED: 'Halted',
  };
  var OUTCOME_CHIP = { COMPLETED: 'ok', PARTIAL: 'neutral', FAILED: 'crit', AWAITING_APPROVAL: 'info', REFUSED: 'blocked', CANCELLED: 'neutral', HALTED: 'warn' };
  var TRACE_LABEL = {
    PLAN_RECEIVED: 'Plan received', PLAN_REFUSED: 'Plan refused', PLAN_ACCEPTED: 'Plan accepted', TASK_ROUTED: 'Task routed',
    TASK_REFUSED: 'Task stopped', APPROVAL_REQUIRED: 'Approval required', APPROVAL_DECIDED: 'Approval decided',
    APPROVAL_DECISION_REFUSED: 'Decision refused', HANDOFF_ACCEPTED: 'Handoff accepted', HANDOFF_BLOCKED: 'Handoff blocked',
    TASK_SUCCEEDED: 'Task completed', TASK_FAILED: 'Task failed', TASK_SKIPPED: 'Task skipped', RUN_SETTLED: 'Run settled',
    RUN_HALTED: 'Run halted', RUN_CANCELLED: 'Run cancelled', TASK_CANCELLED: 'Task cancelled',
  };
  var CODE_LABEL = {
    AUTHORIZATION: 'Not authorized', KILL_SWITCH: 'Kill switch', CROSS_TENANT: 'Another club named', INPUT_TOO_LARGE: 'Input too large',
    INPUT_HEALTH_DATA: 'Health data outside a medical agent', INPUT_INVALID: 'Invalid input', HANDOFF_BLOCKED: 'Handoff blocked',
    OPERATION_FAILED: 'Operation failed', OUTPUT_INVALID: 'Invalid output', OUTPUT_TOO_LARGE: 'Output too large',
    OUTPUT_MISLABELLED: 'Health data in an output declared below Restricted', OUTPUT_ABOVE_CEILING: 'Output above what the agent may write',
    DEPENDENCY_NOT_SUCCEEDED: 'Something it consumes did not succeed', REJECTED_BY_APPROVER: 'Rejected by a person',
    CONTRACT_INVALID: 'Invalid plan', ENVIRONMENT_NOT_LAB: 'Outside the Lab', TASK_DUPLICATE: 'Duplicate task',
    DEPENDENCY_UNKNOWN: 'Unknown dependency', DEPENDENCY_SELF: 'Depends on itself', CYCLE: 'Dependency cycle',
    OPERATION_UNKNOWN: 'Unknown operation', HANDOFF_UNDECLARED: 'Undeclared exchange', REQUESTER_SCOPE: 'Requester outside the plan\'s scope',
    REQUESTER_CANNOT_READ: 'Requester may not read what it writes', NO_ELIGIBLE_AGENT: 'No eligible agent',
    APPROVAL_NOT_PENDING: 'Not waiting for a decision', APPROVER_ROLE: 'Not an approver role', APPROVER_CLUB: 'Approver of another club',
    SEGREGATION_OF_DUTIES: 'The requester may not decide', APPROVER_CANNOT_READ: 'Approver may not read the record',
    DECISION_INVALID: 'Invalid decision', NO_ELIGIBLE_APPROVER: 'No eligible approver',
    APPROVED: 'Approved', REJECTED: 'Rejected', COMPLETED: 'Completed', PARTIAL: 'Partly completed', FAILED: 'Failed',
    AWAITING_APPROVAL: 'Awaiting approval', REFUSED: 'Refused',
    EXECUTION_LIMIT: 'Execution limit reached', APPROVAL_CONTEXT_CHANGED: 'Security context changed', CANCELLED_BY_OPERATOR: 'Cancelled by an operator',
    SELF_APPROVAL: 'The submitter may not approve', SUBMIT: 'Submit', OPERATOR_UNKNOWN: 'Not a LAB operator', OPERATOR_ROLE_MISMATCH: 'Role not held',
    OPERATOR_NOT_PERMITTED: 'Operator not permitted', OPERATOR_SCOPE: 'Outside the operator\'s scope', CANCELLED: 'Cancelled', HALTED: 'Halted',
  };
  // AI-0.5: the execution log an approved publication carries, and the checks the server ran on it.
  var LOG_LABEL = {
    EXECUTION_SUBMITTED: 'Submitted', OPERATOR_AUTHORIZED: 'Operator authorized', PLAN_VALIDATED: 'Plan validated', AGENTS_ASSIGNED: 'Agents assigned',
    RUN_ADVANCED: 'Run advanced', DECISION_SUBMITTED: 'Decision submitted', DECISION_REFUSED: 'Decision refused', APPROVAL_INVALIDATED: 'Approvals invalidated',
    EXECUTION_CANCELLED: 'Execution cancelled', CANCEL_REFUSED: 'Cancellation refused', EXECUTION_HALTED: 'Execution halted',
  };
  /** Governance in the log: what it is drawn as. Everything else is the execution's own progress. */
  var LOG_KIND = {
    DECISION_SUBMITTED: 'info', DECISION_REFUSED: 'blocked', APPROVAL_INVALIDATED: 'blocked', CANCEL_REFUSED: 'blocked',
    EXECUTION_CANCELLED: 'neutral', EXECUTION_HALTED: 'warn',
  };
  var CHECK_LABEL = {
    version: 'Contract version', shape: 'Shape', integrity: 'Integrity', trace: 'Run trace', log: 'Execution log', coherence: 'Coherence',
    governance: 'Governance', synthetic: 'Synthetic data', identity: 'Identity', provenance: 'Provenance', approval: 'Approval record',
  };
  /** The commit a rehearsal names: none was measured, and the server refuses it outside the Lab's read-back. */
  var REHEARSAL_REVISION = '0000000000000000000000000000000000000000';

  function wfRuns() { return (AR.wf && AR.wf.runs) || []; }
  function pubRuns() { return (AR.pub && AR.pub.runs) || []; }
  function runOf(id) {
    var p = pubRuns(), list = wfRuns(), i;
    for (i = 0; i < p.length; i++) if (p[i].key === id) return p[i];
    for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function taskOf(run, id) { var list = (run && run.tasks) || []; for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  /** A publication carries its own operations and agents; a v1 run shares the evidence file's. */
  function operationOf(key, run) { var list = (run && run.operations) || (AR.wf && AR.wf.operations) || []; for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return null; }
  function evidenceAgent(id, run) { var list = (run && run.agents) || (AR.wf && AR.wf.agents) || []; for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function stateKind(s) { return STATE_KIND[s] || 'waiting'; }
  function stateChip(s, extra) { return chip(STATE_CHIP[stateKind(s)], label(STATE_LABEL, s), STATE_MEANING[s] ? T(STATE_MEANING[s]) : '', extra || 'ar-chip--sm'); }
  /** Server text inside SVG, where only plain text may go: the catalogue's words, or the English it came in. */
  function plainX(text) {
    var s = String(text == null ? '' : text);
    if (AR_LANG === 'en' || !s) return s;
    var nums = [];
    var key = s.replace(/\d+/g, function (m) { nums.push(Number(m)); return '%d'; });
    if (!hasKey(key)) return s;
    var i = 0;
    return AR_DICT[key].replace(/%d/g, function () { return num(nums[i++]); });
  }
  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  /** At most two lines of about n characters, broken between words; what is left over ends in an ellipsis. */
  function wrap2(s, n) {
    var words = String(s).split(/\s+/), lines = [''], i;
    for (i = 0; i < words.length; i++) {
      var w = words[i], cur = lines[lines.length - 1];
      if (!cur) lines[lines.length - 1] = w;
      else if ((cur + ' ' + w).length <= n) lines[lines.length - 1] = cur + ' ' + w;
      else if (lines.length < 2) lines.push(w);
      else { lines[1] = clip(lines[1] + ' ' + words.slice(i).join(' '), n); break; }
    }
    return lines.map(function (l) { return clip(l, n); });
  }
  function agentTitle(id) { var a = id ? summaryOf(id) : null; return a ? a.title : (id || '—'); }
  function technical(s) { return '<span class="ar-tech" lang="en" dir="ltr">' + esc(s) + '</span>'; }

  function loadOrchestration() {
    AR.wfLoading = true;
    return api('/system/agents/orchestration').then(function (d) {
      var missing = missingFields(d, REQUIRED.orchestration);
      if (!missing.length && !Array.isArray(d.runs)) missing = ['runs'];
      if (missing.length) { AR.wf = null; AR.wfError = contractError('/system/agents/orchestration', missing); return; }
      AR.wf = {
        state: d.state, reason: d.reason, notice: d.notice, evidenceDigest: d.evidenceDigest, registry: d.registry,
        agents: d.agents || [], operations: d.operations || [], runs: d.state === 'VERIFIED' ? d.runs : [],
      };
      AR.wfError = null;
    }).catch(function (e) { AR.wf = null; AR.wfError = e.message; }).then(function () { AR.wfLoading = false; });
  }
  /** AI-0.5: the LAB executions the Platform Owner approved for publication, as the server verified them. Nothing else is drawn. */
  function loadPublications() {
    AR.pubLoading = true;
    return api('/system/agents/publications').then(function (d) {
      var missing = missingFields(d, REQUIRED.publications);
      if (!missing.length && !Array.isArray(d.publications)) missing = ['publications'];
      if (missing.length) { AR.pub = null; AR.pubError = contractError('/system/agents/publications', missing); return; }
      AR.pub = {
        state: d.state, reason: d.reason, notice: d.notice, rule: d.rule, record: d.record, checks: d.checks || [], unapproved: d.unapproved || [],
        runs: d.state === 'VERIFIED' ? d.publications.map(asRun) : [],
      };
      AR.pubError = null;
    }).catch(function (e) { AR.pub = null; AR.pubError = e.message; }).then(function () { AR.pubLoading = false; });
  }
  /** A publication in the shape the workflow drawing reads; what only a publication has stays under `pub`. */
  function asRun(p) {
    var e = p.evidence, r = e.run;
    return {
      key: 'x:' + p.publicationId, id: r.digest, scenario: e.source.requestId, title: e.plan.title, planId: e.plan.id, scope: e.plan.scope,
      requestedByRole: e.plan.requestedByRole,
      steps: [{ kind: 'START' }].concat(e.decisions.map(function (d) { return { kind: 'DECISION', taskId: d.taskId, decision: d.decision, byRole: d.byRole, accepted: d.accepted }; })),
      outcome: r.outcome, refusal: r.refusal, order: r.order, tasks: r.tasks, trace: r.trace, operations: e.operations, agents: p.agents, pub: p,
    };
  }
  /** The first approved execution, else the first published workflow. */
  function pickRun() {
    if (runOf(AR.run)) return;
    var p = pubRuns(), w = wfRuns();
    AR.run = p.length ? p[0].key : w.length ? w[0].id : null;
    AR.task = null;
  }
  function runKey(r) { return r.key || r.id; }

  // The DAG: a column per dependency depth, rows centred, so the same run is always drawn the same way.
  var WF_W = 256, WF_H = 92, WF_COL = 320, WF_ROW = 116, WF_PAD = 28;
  function wfLayout(run) {
    var depth = {}, cols = [], pos = {};
    for (var i = 0; i < run.order.length; i++) {
      var t = taskOf(run, run.order[i]), d = 0;
      for (var j = 0; j < t.dependsOn.length; j++) d = Math.max(d, (depth[t.dependsOn[j]] || 0) + 1);
      depth[t.id] = d;
      (cols[d] = cols[d] || []).push(t.id);
    }
    var rows = 1;
    for (var c = 0; c < cols.length; c++) rows = Math.max(rows, cols[c].length);
    var W = WF_PAD * 2 + Math.max(0, cols.length - 1) * WF_COL + WF_W, H = WF_PAD * 2 + (rows - 1) * WF_ROW + WF_H;
    for (var k = 0; k < cols.length; k++) {
      var off = (rows - cols[k].length) * WF_ROW / 2;
      for (var r = 0; r < cols[k].length; r++) {
        var x = WF_PAD + k * WF_COL;
        pos[cols[k][r]] = { x: AR_DIR === 'rtl' ? W - x - WF_W : x, y: WF_PAD + off + r * WF_ROW };
      }
    }
    return { W: W, H: H, pos: pos };
  }
  /** A small glyph per state, drawn in the node's own coordinates, so it reads without colour too. */
  function glyph(kind, cx, cy) {
    var P = function (pts) { return pts.map(function (p) { return f1(cx + p[0]) + ',' + f1(cy + p[1]); }).join(' '); };
    switch (kind) {
      case 'done': return '<polyline class="ar-wf-g" points="' + P([[-5, 0], [-1.5, 4], [5, -4]]) + '"/>';
      case 'failed': return '<polyline class="ar-wf-g" points="' + P([[-4, -4], [4, 4]]) + '"/><polyline class="ar-wf-g" points="' + P([[4, -4], [-4, 4]]) + '"/>';
      case 'approval': return '<polygon class="ar-wf-g" points="' + P([[-4, -5], [4, -5], [-4, 5], [4, 5]]) + '"/>';
      case 'rejected': return '<circle class="ar-wf-g" cx="' + f1(cx) + '" cy="' + f1(cy) + '" r="5"/><polyline class="ar-wf-g" points="' + P([[-3.5, 3.5], [3.5, -3.5]]) + '"/>';
      case 'skipped': return '<polyline class="ar-wf-g" points="' + P([[-5, -4], [-1, 0], [-5, 4]]) + '"/><polyline class="ar-wf-g" points="' + P([[1, -4], [5, 0], [1, 4]]) + '"/>';
      case 'blocked': return '<polyline class="ar-wf-g ar-wf-g--bar" points="' + P([[-5, 0], [5, 0]]) + '"/>';
      case 'cancelled': return '<polygon class="ar-wf-g" points="' + P([[-4, -4], [4, -4], [4, 4], [-4, 4]]) + '"/>';
      default: return '<polyline class="ar-wf-g" points="' + P([[-5, 0], [5, 0]]) + '"/>';
    }
  }
  function wfSvg(run) {
    var L = wfLayout(run), edges = '', nodes = '', rtl = AR_DIR === 'rtl';
    for (var i = 0; i < run.tasks.length; i++) {
      var to = run.tasks[i];
      for (var j = 0; j < to.dependsOn.length; j++) {
        var from = to.dependsOn[j], a = L.pos[from], b = L.pos[to.id];
        if (!a || !b) continue;
        var got = null;
        for (var k = 0; k < to.inputs.length; k++) if (to.inputs[k].from === from) got = to.inputs[k].status;
        var kind = got === 'ACCEPTED' ? 'accepted' : got === 'BLOCKED' ? 'blocked' : 'unreached';
        var x1 = rtl ? a.x : a.x + WF_W, y1 = a.y + WF_H / 2, x2 = rtl ? b.x + WF_W : b.x, y2 = b.y + WF_H / 2, dx = (x2 - x1) / 2;
        var tip = rtl ? 9 : -9;
        edges += '<path class="ar-wf-edge ar-wf-edge--' + kind + '" d="M' + f1(x1) + ' ' + f1(y1) + ' C' + f1(x1 + dx) + ' ' + f1(y1) + ' ' + f1(x2 - dx) + ' ' + f1(y2) + ' ' + f1(x2 + tip) + ' ' + f1(y2) + '"/>'
          + '<polygon class="ar-wf-tip ar-wf-tip--' + kind + '" points="' + f1(x2) + ',' + f1(y2) + ' ' + f1(x2 + tip) + ',' + f1(y2 - 5) + ' ' + f1(x2 + tip) + ',' + f1(y2 + 5) + '"/>';
        if (kind === 'blocked') {
          var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          edges += '<circle class="ar-wf-stop" cx="' + f1(mx) + '" cy="' + f1(my) + '" r="9"/>' + glyph('failed', mx, my);
        }
      }
    }
    for (var n = 0; n < run.order.length; n++) {
      var t = taskOf(run, run.order[n]), p = L.pos[t.id], sk = stateKind(t.state), op = operationOf(t.operation, run);
      var sel = AR.task === t.id, start = rtl ? p.x + WF_W - 20 : p.x + 20, tx = rtl ? p.x + WF_W - 42 : p.x + 42, anchor = rtl ? 'end' : 'start';
      // Its name is the text it shows, in the order shown (WCAG 2.5.3): what was asked, by whom, where it stands.
      var name = plainX(op ? op.title : t.operation) + ' · ' + plainX(agentTitle(t.agent && t.agent.id)) + ' · ' + t.id + ' · ' + label(STATE_LABEL, t.state);
      nodes += '<g class="ar-wf-node ar-wf-node--' + sk + (sel ? ' is-selected' : '') + '" tabindex="0" role="button" data-ar-task="' + esc(t.id) + '" aria-pressed="' + (sel ? 'true' : 'false') + '" aria-label="' + esc(name) + '">'
        + '<title>' + esc(name) + '</title>'
        + '<rect class="ar-wf-box" x="' + f1(p.x) + '" y="' + f1(p.y) + '" width="' + WF_W + '" height="' + WF_H + '" rx="12"/>'
        + '<circle class="ar-wf-dot" cx="' + f1(start) + '" cy="' + f1(p.y + 22) + '" r="11"/>' + glyph(sk, start, p.y + 22)
        + wrap2(plainX(op ? op.title : t.operation), 27).map(function (line, li) {
          return '<text class="ar-wf-t1" x="' + f1(tx) + '" y="' + f1(p.y + 26 + li * 17) + '" text-anchor="' + anchor + '">' + esc(line) + '</text>';
        }).join(' ')
        // A space between the lines: drawn nowhere, it keeps the words apart where the node's text is read as one.
        + ' <text class="ar-wf-t2" x="' + f1(tx) + '" y="' + f1(p.y + 66) + '" text-anchor="' + anchor + '">' + esc(clip(plainX(agentTitle(t.agent && t.agent.id)) + ' · ' + t.id, 30)) + '</text>'
        + ' <text class="ar-wf-t3" x="' + f1(tx) + '" y="' + f1(p.y + 83) + '" text-anchor="' + anchor + '">' + esc(clip(label(STATE_LABEL, t.state), 30)) + '</text>'
        + '</g>';
    }
    return '<svg class="ar-wf-svg" viewBox="0 0 ' + L.W + ' ' + L.H + '" width="' + L.W + '" height="' + L.H + '" role="group" aria-label="' + esc(T('Tasks, in dependency order')) + '">'
      + '<g class="ar-wf-edges" aria-hidden="true">' + edges + '</g>' + nodes + '</svg>';
  }
  function wfLegendHtml() {
    var states = STATE_ORDER.map(function (s) { return '<li>' + stateChip(s, 'ar-chip--xs') + '</li>'; }).join('');
    var edge = function (kind, text) { return '<li class="ar-wf-key"><span class="ar-wf-key-line ar-wf-key-line--' + kind + '" aria-hidden="true"></span>' + esc(T(text)) + '</li>'; };
    return '<ul class="ar-wf-legend" aria-label="' + esc(T('Legend')) + '">' + states
      + edge('accepted', 'Handoff accepted') + edge('blocked', 'Handoff blocked') + edge('unreached', 'Not reached') + '</ul>';
  }
  function stripHtml() {
    var w = AR.wf;
    var reg = w.registry || {};
    return '<div class="ar-wf-strip" role="group" aria-label="' + esc(T('Evidence')) + '">'
      + chip('blocked', T('LAB evidence'), T('Produced by the LAB orchestrator, outside the production build.'))
      + chip('none', T('Synthetic data'), T('Invented clubs and people only.'))
      + chip('none', T('Never run in production'), T('This server reads the evidence and runs nothing.'))
      + chip('ok', T('Verified by the server'), T('Schema, file digest and every run\'s hash chain.'))
      + (reg.matches ? chip('ok', T('Routed over the current registry')) : chip('warn', T('Routed over an earlier registry'), T('The registry has changed since this evidence was produced.')))
      + '<span class="ar-wf-digest">' + esc(T('Evidence')) + ' ' + code(short(w.evidenceDigest, 16)) + '</span>'
      + '</div><p class="ar-wf-notice">' + TX(w.notice) + '</p>';
  }
  function runItemHtml(r) {
    var key = runKey(r), on = key === AR.run;
    var agentsIn = {};
    r.tasks.forEach(function (t) { if (t.agent) agentsIn[t.agent.id] = 1; });
    return '<li><button class="ar-wf-run' + (on ? ' is-on' : '') + '" type="button" data-ar-wf="' + esc(key) + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
      + '<span class="ar-wf-run-t">' + TX(r.title) + '</span>'
      + '<span class="ar-wf-run-m">' + chip(OUTCOME_CHIP[r.outcome] || 'neutral', label(OUTCOME_LABEL, r.outcome), '', 'ar-chip--xs')
      + '<span class="ar-wf-run-n">' + esc(tf('Tasks: %d · Agents: %d', r.tasks.length, keysOf(agentsIn).length)) + '</span></span>'
      + decisionLine(r) + (r.pub ? '<span class="ar-wf-run-d">' + esc(T('Approved in')) + ' ' + code(r.pub.reference) + '</span>' : '') + '</button></li>';
  }
  function groupNote(text, extra) { return '<p class="ar-wf-group-note">' + esc(T(text)) + (extra || '') + '</p>'; }
  /** AI-0.5: what the Platform Owner approved for publication, or why nothing is listed. */
  function pubGroupHtml() {
    var P = AR.pub, list = pubRuns(), body;
    if (AR.pubError && !P) body = groupNote('The approved executions could not be read', ' ' + technical(AR.pubError)) + '<button class="ar-btn ar-btn--sm" type="button" data-ar-pub-retry>' + esc(T('Try again')) + '</button>';
    else if (P.state !== 'VERIFIED') body = groupNote(P.state === 'NOT_GENERATED' ? 'No approval record is beside this server' : 'The approved executions did not verify, so none of them is shown', P.reason ? '<br>' + technical(P.reason) : '');
    else if (!list.length) body = groupNote('No LAB execution has been approved for publication yet.') + '<p class="ar-wf-group-note">' + TX(P.rule) + '</p>';
    else body = '<ul>' + list.map(runItemHtml).join('') + '</ul>';
    if (P && P.unapproved.length) {
      body += '<p class="ar-wf-group-note">' + chip('blocked', tf('Without approval: %d', P.unapproved.length), T('Dossier files beside the approval record that no entry approves. They are never read or shown.'), 'ar-chip--xs') + '</p>';
    }
    var n = P && P.state === 'VERIFIED' ? ' <span class="ar-wf-group-n">' + esc(num(list.length)) + '</span>' : '';
    return '<section class="ar-wf-group" aria-labelledby="ar-wf-g-pub"><h3 class="ar-wf-group-t" id="ar-wf-g-pub">' + esc(T('Approved LAB executions')) + n + '</h3>' + body + '</section>';
  }
  /** AI-0.3's published workflows; when there are none to list, one line says why (the main panel says the rest). */
  function wfGroupHtml(withRetry) {
    var W = AR.wf, body;
    if (AR.wfError && !W) body = groupNote('The LAB evidence could not be read', withRetry ? ' <button class="ar-btn ar-btn--sm" type="button" data-ar-wf-retry>' + esc(T('Try again')) + '</button>' : '');
    else if (W.state !== 'VERIFIED') body = groupNote(W.state === 'NOT_GENERATED' ? 'No LAB evidence has been published' : 'The LAB evidence did not verify, so none of it is shown');
    else if (!wfRuns().length) body = groupNote('The evidence holds no workflow');
    else body = '<ul>' + wfRuns().map(runItemHtml).join('') + '</ul>';
    return '<section class="ar-wf-group" aria-labelledby="ar-wf-g-lab"><h3 class="ar-wf-group-t" id="ar-wf-g-lab">' + esc(T('LAB workflows')) + '</h3>' + body + '</section>';
  }
  function runListHtml(withRetry) {
    return '<nav class="ar-wf-runs" aria-label="' + esc(T('LAB workflows')) + '">' + pubGroupHtml() + wfGroupHtml(withRetry) + '</nav>';
  }
  /** What a person decided in a run, in one line, so runs of the same plan are told apart. */
  function decisionLine(run) {
    var d = run.steps.filter(function (s) { return s.kind === 'DECISION'; });
    if (!d.length) return '';
    return '<span class="ar-wf-run-d">' + esc(d.map(function (s) {
      return label(ROLE_LABEL, s.byRole) + ': ' + label(CODE_LABEL, s.decision) + (s.accepted ? '' : ' (' + T('Refused') + ')');
    }).join(' · ')) + '</span>';
  }
  function stepsHtml(run) {
    return '<ol class="ar-wf-steps">' + run.steps.map(function (s) {
      if (s.kind === 'START') return '<li>' + esc(T('Started')) + '</li>';
      var what = label(ROLE_LABEL, s.byRole) + ': ' + label(CODE_LABEL, s.decision);
      return '<li>' + esc(what) + ' ' + code(s.taskId) + (s.accepted ? '' : ' ' + chip('blocked', T('Refused'), T('The run refused to take this decision.'), 'ar-chip--xs')) + '</li>';
    }).join('') + '</ol>';
  }
  function countsHtml(run) {
    var n = {};
    run.tasks.forEach(function (t) { n[t.state] = (n[t.state] || 0) + 1; });
    return '<ul class="ar-wf-counts">' + STATE_ORDER.filter(function (s) { return n[s]; }).map(function (s) {
      return '<li>' + stateChip(s, 'ar-chip--xs') + ' <b>' + esc(num(n[s])) + '</b></li>';
    }).join('') + '</ul>';
  }
  function taskDetailHtml(run) {
    var t = taskOf(run, AR.task);
    if (!t) return '<div class="ar-wf-pick">' + esc(T('Choose a task in the workflow to see what was decided for it.')) + '</div>';
    var op = operationOf(t.operation, run), ag = t.agent, ev = ag ? evidenceAgent(ag.id, run) : null;
    var agentCell = ag
      ? '<button class="ar-link" type="button" data-ar-agent="' + esc(ag.id) + '">' + TX(agentTitle(ag.id)) + '</button> ' + code(ag.id + '@' + ag.version)
        + (ev && !ev.current ? ' ' + chip('warn', ev.known ? T('Manifest changed since') : T('No longer in the registry'), '', 'ar-chip--xs') : '')
      : '—';
    var ranked = t.eligibleAgents.length
      ? '<ol class="ar-wf-ranked">' + t.eligibleAgents.map(function (id) { return '<li>' + code(id) + '</li>'; }).join('') + '</ol>' : '—';
    var inputs = t.dependsOn.length ? '<ul class="ar-wf-inputs">' + t.dependsOn.map(function (d) {
      var got = null;
      t.inputs.forEach(function (i) { if (i.from === d) got = i.status; });
      var k = got === 'ACCEPTED' ? 'ok' : got === 'BLOCKED' ? 'crit' : 'none';
      var tx = got === 'ACCEPTED' ? 'Handoff accepted' : got === 'BLOCKED' ? 'Handoff blocked' : 'Not reached';
      return '<li>' + code(d) + ' ' + chip(k, T(tx), '', 'ar-chip--xs') + '</li>';
    }).join('') + '</ul>' : esc(T('Consumes nothing'));
    var approval = '—';
    if (t.approval) {
      approval = t.approval.eligibleRoles.length
        ? esc(t.approval.eligibleRoles.map(function (r) { return label(ROLE_LABEL, r); }).join(', '))
        : esc(T('No approver role may read %s records').replace('%s', label(RECORD_CLASS_LABEL, t.recordClass)));
      if (t.approval.decision) approval += '<br>' + esc(label(CODE_LABEL, t.approval.decision) + ' · ' + label(ROLE_LABEL, t.approval.decidedByRole));
    }
    return '<header class="ar-wf-d-top"><div><div class="ar-eyebrow">' + esc(T('Task')) + ' ' + code(t.id) + '</div>'
      + '<h3 class="ar-wf-d-title">' + TX(op ? op.title : t.operation) + '</h3></div>' + stateChip(t.state, ' ') + '</header>'
      + '<p class="ar-wf-d-why">' + esc(T(STATE_MEANING[t.state] || '')) + '</p>'
      + (t.reason ? '<div class="ar-wf-reason">' + chip(STATE_CHIP[stateKind(t.state)], label(CODE_LABEL, t.reason.code), '', 'ar-chip--xs') + ' ' + technical(t.reason.message) + '</div>' : '')
      + '<div class="ar-kvs">'
      + kv('Operation', code(t.operation)) + kv('Tool', code(t.tool)) + kv('Agent', agentCell)
      + kv('Ranked by routing', ranked)
      + kv('Output class', t.dataClass ? esc(label(CLASS_LABEL, t.dataClass) + ' · ' + label(RECORD_CLASS_LABEL, t.recordClass)) : '—')
      + kv('Output digest', t.outputDigest ? code(short(t.outputDigest, 16)) : '—')
      + kv('Consumes', inputs) + kv('Approval', approval)
      + '</div>';
  }
  function traceHtml(run) {
    var only = !AR.traceAll && !!AR.task;
    var list = run.trace.filter(function (e) { return !only || e.taskId === AR.task; });
    var head = run.trace[run.trace.length - 1];
    var btn = function (all, text) {
      var on = AR.traceAll === all || (!AR.task && all);
      return '<button class="ar-seg-btn' + (on ? ' is-on' : '') + '" type="button" data-ar-trace="' + (all ? 'all' : 'task') + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (!all && !AR.task ? ' disabled' : '') + '>' + esc(T(text)) + '</button>';
    };
    return '<div class="ar-wf-tr-top"><h3 class="ar-wf-d-title">' + esc(T('Trace')) + '</h3>'
      + '<div class="ar-seg" role="group" aria-label="' + esc(T('Trace')) + '">' + btn(true, 'Every event') + btn(false, 'This task') + '</div></div>'
      + '<p class="ar-wf-chain">' + chip('ok', T('Hash chain verified by the server'), '', 'ar-chip--xs') + ' '
      + esc(tf('Events: %d', run.trace.length)) + ' · ' + esc(T('head')) + ' ' + code(short(head && head.hash, 16)) + '</p>'
      + '<ol class="ar-wf-events">' + list.map(function (e) {
        return '<li class="ar-wf-ev' + (AR.task && e.taskId === AR.task ? ' is-task' : '') + '">'
          + '<span class="ar-wf-ev-seq">' + esc(num(e.seq)) + '</span>'
          + '<span class="ar-wf-ev-main"><span class="ar-wf-ev-type">' + esc(label(TRACE_LABEL, e.type)) + '</span>'
          + (e.taskId ? ' ' + code(e.taskId) : '') + (e.agentId ? ' ' + code(e.agentId) : '')
          + (e.code ? ' ' + chip('neutral', label(CODE_LABEL, e.code), '', 'ar-chip--xs') : '')
          + '<span class="ar-wf-ev-detail">' + technical(e.detail) + '</span></span></li>';
      }).join('') + '</ol>';
  }
  /** No run to draw: why, as AI-0.3 said it. */
  function noRunHtml() {
    if (AR.wfError && !AR.wf) {
      return emptyState('The LAB evidence could not be read', AR.wfError, '<button class="ar-btn ar-btn--sm" type="button" data-ar-wf-retry>' + esc(T('Try again')) + '</button>');
    }
    if (AR.wf.state !== 'VERIFIED') {
      return emptyState(AR.wf.state === 'NOT_GENERATED' ? 'No LAB evidence has been published' : 'The LAB evidence did not verify, so none of it is shown',
        AR.wf.reason || '', '<p class="ar-wf-notice">' + esc(T('Evidence is published by the LAB orchestrator: FAMILISTA_ENV=LAB npm run lab:orchestrator:evidence.')) + '</p>');
    }
    return emptyState('The evidence holds no workflow', T('A workflow appears here once the LAB orchestrator publishes a run of it.'));
  }
  function workflowsHtml() {
    if ((!AR.wf && !AR.wfError) || (!AR.pub && !AR.pubError)) return '<div class="ar-skel-map" role="status" aria-label="' + esc(T('Reading the LAB evidence…')) + '"></div>';
    var run = runOf(AR.run);
    var strip = run && run.pub ? pubStripHtml(run) : AR.wf && AR.wf.state === 'VERIFIED' ? stripHtml() : '';
    return strip + '<div class="ar-wf-grid">' + runListHtml(!!run) + '<div class="ar-wf-main">' + (run ? runHtml(run) : noRunHtml()) + '</div></div>';
  }
  function runHtml(run) {
    var participants = {}, P = run.pub, E = P && P.evidence;
    run.tasks.forEach(function (t) { if (t.agent) participants[t.agent.id] = 1; });
    var eyebrow = P ? esc(T('Approved LAB execution')) + ' ' + code(P.publicationId) : esc(T('LAB workflow')) + ' ' + code(run.scenario);
    return '<header class="ar-wf-head"><div><div class="ar-eyebrow">' + eyebrow + '</div>'
      + '<h2 class="ar-wf-title">' + TX(run.title) + '</h2>'
      + '<div class="ar-wf-meta">' + chip(OUTCOME_CHIP[run.outcome] || 'neutral', label(OUTCOME_LABEL, run.outcome), '', 'ar-chip--sm')
      + '<span>' + esc(T('Requested by')) + ' ' + esc(label(ROLE_LABEL, run.requestedByRole)) + '</span>'
      + (run.scope.kind === 'CLUB' ? '<span>' + esc(T('Club')) + ' ' + code(run.scope.clubId) + '</span>' : '<span>' + esc(T('Platform')) + '</span>')
      + (E ? '<span>' + esc(tf('Steps: %d of %d', E.run.steps, E.limits.maxSteps)) + '</span>' : '')
      + '<span>' + esc(T('Run')) + ' ' + code(short(run.id, 16)) + '</span></div></div>' + stepsHtml(run) + '</header>'
      + (run.refusal ? '<div class="ar-wf-refused" role="note"><strong>' + esc(T('The plan was refused before anything was routed or ran')) + '</strong> '
        + chip('blocked', label(CODE_LABEL, run.refusal.code), '', 'ar-chip--xs') + ' ' + technical(run.refusal.message) + '</div>' : '')
      + (E ? stopHtml(E) : '')
      + (run.tasks.length ? countsHtml(run)
        + '<figure class="ar-wf-canvas">' + wfSvg(run) + '</figure>' + wfLegendHtml()
        + '<div class="ar-wf-agents"><span class="ar-kv-k">' + esc(T('Agents in this workflow')) + '</span> '
        + keysOf(participants).sort().map(function (id) { return '<button class="ar-chip ar-chip--neutral ar-chip--sm ar-chip-btn" type="button" data-ar-agent="' + esc(id) + '">' + TX(agentTitle(id)) + '</button>'; }).join(' ') + '</div>' : '')
      + '<div class="ar-wf-split"><section class="ar-wf-detail" id="ar-wf-detail" aria-live="polite">' + (run.tasks.length ? taskDetailHtml(run) : '') + '</section>'
      + '<section class="ar-wf-trace" id="ar-wf-trace">' + traceHtml(run) + '</section></div>'
      + (P ? '<div class="ar-wf-split"><section class="ar-wf-detail">' + governanceHtml(E) + '</section><section class="ar-wf-trace">' + logHtml(E) + '</section></div>' + verificationHtml(P) + provenanceHtml(P) : '');
  }

  // ── approved LAB executions (AI-0.5) ──────────────────────────────────────
  //
  // A publication is drawn as the workflow above draws a run, and then what only
  // an execution has: why it stopped, every governance decision its log records,
  // the log itself, and what the server checked before showing any of it. Its
  // approval is the Platform Owner's merge of the pull request it names; the
  // room says so, and claims nothing more.

  function pubStripHtml(run) {
    var P = run.pub;
    return '<div class="ar-wf-strip" role="group" aria-label="' + esc(T('Publication')) + '">'
      + chip('ok', T('Approved for publication'), T('Its approval is the Platform Owner\'s merge of the reviewed pull request it names. The server checks that the approval record lists it; it does not authenticate who merged.'))
      + chip('none', T('Synthetic data'), T('Invented clubs and people only.'))
      + chip('none', T('Never run in production'), T('This server reads the evidence and runs nothing.'))
      + chip('ok', T('Verified by the server'), T('Contract version, digest, both hash chains, coherence, governance and identity.'))
      + (P.registry.matches ? chip('ok', T('Routed over the current registry')) : chip('warn', T('Routed over an earlier registry'), T('The registry has changed since this evidence was produced.')))
      + '<span class="ar-wf-digest">' + esc(T('Dossier')) + ' ' + code(short(P.dossierDigest, 16)) + '</span>'
      + '</div><p class="ar-wf-notice">' + TX(AR.pub.notice) + '</p>';
  }
  /** An operator's cancellation or governance's halt: what stopped it, in its own words. */
  function stopHtml(E) {
    var s = E.run.stop;
    if (!s) return '';
    var halted = s.outcome === 'HALTED';
    return '<div class="ar-wf-refused ar-wf-stopped" role="note"><strong>' + esc(T(halted ? 'Halted by governance before it finished' : 'Cancelled by an operator before it finished')) + '</strong> '
      + chip(halted ? 'warn' : 'neutral', label(CODE_LABEL, s.code), '', 'ar-chip--xs') + ' ' + technical(s.message) + '</div>';
  }
  /** A decision the orchestrator refused is a refusal, however it reached the log. */
  function logKind(e) { return e.type === 'DECISION_SUBMITTED' && e.code === 'REFUSED' ? 'blocked' : LOG_KIND[e.type]; }
  function logLine(e) {
    return '<li class="ar-wf-ev"><span class="ar-wf-ev-seq">' + esc(num(e.seq)) + '</span>'
      + '<span class="ar-wf-ev-main"><span class="ar-wf-ev-type">' + esc(label(LOG_LABEL, e.type)) + '</span>'
      + (e.taskId ? ' ' + code(e.taskId) : '') + (e.code ? ' ' + chip(logKind(e) || 'neutral', label(CODE_LABEL, e.code), '', 'ar-chip--xs') : '')
      + '<span class="ar-wf-ev-detail">' + technical(e.detail) + '</span></span></li>';
  }
  /** Every approval decision, refusal, cancellation and halt the log records, in order. */
  function governanceHtml(E) {
    var gov = E.log.filter(function (e) { return logKind(e); });
    var passed = E.routing.reduce(function (n, r) { return n + r.passedOver.length; }, 0);
    return '<h3 class="ar-wf-d-title">' + esc(T('Approvals and governance')) + '</h3>'
      + '<p class="ar-wf-chain">' + esc(tf('Decisions: %d · Refused: %d', E.decisions.length, gov.filter(function (e) { return logKind(e) === 'blocked'; }).length))
      + ' · ' + esc(tf('Agents passed over by routing: %d', passed)) + '</p>'
      + (gov.length ? '<ol class="ar-wf-events">' + gov.map(logLine).join('') + '</ol>' : '<div class="ar-wf-pick">' + esc(T('No decision, refusal, cancellation or halt was recorded.')) + '</div>');
  }
  function logHtml(E) {
    var head = E.log[E.log.length - 1];
    return '<h3 class="ar-wf-d-title">' + esc(T('Execution log')) + '</h3>'
      + '<p class="ar-wf-chain">' + chip('ok', T('Hash chain verified by the server'), '', 'ar-chip--xs') + ' '
      + esc(tf('Events: %d', E.log.length)) + ' · ' + esc(T('head')) + ' ' + code(short(head && head.hash, 16)) + '</p>'
      + '<ol class="ar-wf-events">' + E.log.map(logLine).join('') + '</ol>';
  }
  function verificationHtml(P) {
    var E = P.evidence;
    var checks = '<ul class="ar-wf-checks">' + AR.pub.checks.map(function (c) {
      return '<li>' + chip('ok', label(CHECK_LABEL, c.id), '', 'ar-chip--xs') + ' <span>' + TX(c.detail) + '</span></li>';
    }).join('') + '</ul>';
    return '<section class="ar-wf-detail ar-wf-pub" aria-labelledby="ar-wf-pub-t"><h3 class="ar-wf-d-title" id="ar-wf-pub-t">' + esc(T('Verification and publication')) + '</h3>'
      + '<div class="ar-wf-pub-grid"><div>' + checks + '</div><div class="ar-kvs">'
      + kv('Approved in', code(P.reference)) + kv('Publication', code(P.publicationId)) + kv('Dossier digest', code(short(P.dossierDigest, 16)))
      + kv('Approval record', code(short(AR.pub.record.digest, 16))) + kv('Execution', code(E.source.executionId))
      + kv('LAB record', code(short(E.source.recordDigest, 16)))
      + kv('Submitted by (synthetic LAB operator, not an approver)', esc(label(ROLE_LABEL, E.operator.role)) + ' ' + code(E.operator.userId))
      + kv('Evidence contract', code(E.contract)) + '</div></div>'
      + '<p class="ar-wf-notice">' + TX(AR.pub.rule) + '</p></section>';
  }
  /**
   * What produced it: the reviewed definition and the commit it ran at, and how that is checked. The room
   * shows what the provenance record says and the rule that checks it; it claims no more than the rule.
   */
  function provenanceHtml(P) {
    var V = P.provenance;
    if (!V) return '';
    var rehearsal = V.source.revision === REHEARSAL_REVISION;
    var pkgs = V.source.packages.map(function (x) { return x.name + '@' + x.version; }).join(', ');
    return '<section class="ar-wf-detail ar-wf-pub ar-wf-prov" aria-labelledby="ar-wf-prov-t"><h3 class="ar-wf-d-title" id="ar-wf-prov-t">' + esc(T('Provenance and reproduction')) + '</h3>'
      + '<div class="ar-wf-strip" role="group" aria-label="' + esc(T('Provenance')) + '">'
      + (rehearsal
        ? chip('warn', T('Rehearsal: no commit was measured'), T('A rehearsal names no commit and no source. This server refuses it; it is drawn here only as a simulation.'))
        : chip('ok', T('Reproducible by deterministic replay'), T('The AI-0.4 record holds no clock and no random value, so running the definition again at this source gives this dossier, byte for byte, or a difference.'))
          + chip('none', T('Definition reviewed in the repository'), T('A file under lab/orchestrator/definitions: the synthetic request and every operator step, nothing else.')))
      + '</div>'
      + '<div class="ar-wf-pub-grid"><div class="ar-kvs">'
      // A rehearsal measured nothing: its digests, counts and commit are not figures, so they are shown as absent, not as zero.
      + kv('Definition', code(V.definition.name)) + kv('Definition file', code(V.definition.path))
      + kv('Definition digest', rehearsal ? '—' : code(short(V.definition.digest, 16)))
      + kv('Operator steps replayed', rehearsal ? '—' : esc(num(V.replay.steps)))
      + '</div><div class="ar-kvs">'
      + kv('Source commit', rehearsal ? esc(T('None (rehearsal)')) : code(short(V.source.revision, 12)))
      + kv('Source digest', rehearsal ? '—' : code(short(V.source.digest, 16))) + kv('Source files', rehearsal ? '—' : esc(num(V.source.files)))
      + kv('Packages', pkgs ? code(pkgs) : '—') + kv('Provenance digest', code(short(V.digest, 16))) + kv('Provenance contract', code(V.contract))
      + '</div></div>'
      + '<p class="ar-wf-notice">' + TX(V.statement) + '</p></section>';
  }
  /** A task chosen: its detail and the trace are redrawn, the canvas is not, so nothing on it moves. */
  function selectTask(host, id) {
    var run = runOf(AR.run);
    if (!run || !taskOf(run, id)) return;
    AR.task = AR.task === id ? null : id;
    var d = host.querySelector('#ar-wf-detail'), tr = host.querySelector('#ar-wf-trace');
    if (d) d.innerHTML = taskDetailHtml(run);
    if (tr) tr.innerHTML = traceHtml(run);
    var nodes = host.querySelectorAll('.ar-wf-node');
    for (var i = 0; i < nodes.length; i++) {
      var on = nodes[i].getAttribute('data-ar-task') === AR.task;
      nodes[i].classList.toggle('is-selected', on);
      nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  /** Read once. A failed read waits for the owner's "Try again" or Refresh, so a broken reply is never re-requested in a loop. */
  function openWorkflows(host) {
    var reads = [];
    if (!AR.wf && !AR.wfLoading && !AR.wfError) reads.push(loadOrchestration());
    if (!AR.pub && !AR.pubLoading && !AR.pubError) reads.push(loadPublications());
    if (!reads.length) return;
    Promise.all(reads).then(function () { pickRun(); if (AR.view === 'workflows') repaintView(host, false); });
  }

  // ── paint ─────────────────────────────────────────────────────────────────

  function viewHtml() {
    if (AR.error && !AR.data) {
      return emptyState('The registry could not be read', AR.error,
        '<button class="ar-btn ar-btn--sm" type="button" data-ar-refresh>' + esc(T('Try again')) + '</button>');
    }
    if (!AR.data) return '<div class="ar-skel-map" role="status" aria-label="' + esc(T('Reading the registry…')) + '"></div>';
    if (AR.view === 'workflows') return workflowsHtml();
    return AR.view === 'catalogue' ? catalogueHtml() : mapViewHtml();
  }

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', AR_DIR);
    host.setAttribute('lang', AR_LANG);
    host.innerHTML = '<div class="ar-shell">' + topHtml() + railHtml()
      + '<div class="ar-work"><main class="ar-main">' + (AR.data ? toolbarHtml() : '<div class="ar-toolbar ar-toolbar--skel"></div>')
      + '<div class="ar-view" id="ar-view" tabindex="0" role="' + (AR.data ? 'tabpanel' : 'region') + '"'
      + (AR.data ? ' aria-labelledby="ar-tab-' + AR.view + '"' : ' aria-label="' + esc(T('AI Agents Operations Room')) + '"') + '>' + viewHtml() + '</div></main>'
      + '<aside class="ar-side" id="ar-side" tabindex="0" aria-label="' + esc(T('Governance')) + '">' + sideHtml() + '</aside></div>'
      + '<div class="ar-scrim' + (AR.open ? ' is-open' : '') + '" data-ar-close></div>'
      + '<aside class="ar-insp" id="ar-insp" aria-hidden="true" inert></aside></div>';
  }

  /** A filter or a view changed: only the view and the count are replaced, so the search box keeps its focus and caret. */
  function repaintView(host, keepScroll) {
    var view = host.querySelector('#ar-view');
    if (!view) return paint(host);
    var y = keepScroll ? view.scrollTop : 0;
    view.innerHTML = viewHtml();
    view.setAttribute('aria-labelledby', 'ar-tab-' + AR.view);
    view.scrollTop = y;
    var count = host.querySelector('#ar-count');
    if (count) count.textContent = countText();
    // The filters belong to the agents; on the workflows they stand idle, in place, so the toolbar does not move.
    var filters = host.querySelector('.ar-filters');
    if (filters) {
      filters.classList.toggle('is-idle', AR.view === 'workflows');
      if (AR.view === 'workflows') filters.setAttribute('aria-hidden', 'true'); else filters.removeAttribute('aria-hidden');
    }
    if (AR.view === 'workflows') openWorkflows(host);
    var tabs = host.querySelectorAll('[data-ar-view]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-ar-view') === AR.view;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[i].setAttribute('tabindex', on ? '0' : '-1');
    }
  }
  function syncSelects(host) {
    var pairs = [['ar-scope', AR.scope], ['ar-domain', AR.domain], ['ar-lifecycle', AR.lifecycle], ['ar-q', AR.q]];
    for (var i = 0; i < pairs.length; i++) { var el = host.querySelector('#' + pairs[i][0]); if (el && el.value !== pairs[i][1]) el.value = pairs[i][1]; }
  }
  /**
   * The manifest arrived, or was asked for again: only the inspector's body is redrawn. Its header holds the
   * focused Close button, and replacing that would drop the focus out of the open dialog, where neither Tab
   * nor Escape would find it again.
   */
  function repaintInspector(host) {
    var box = host.querySelector('#ar-insp');
    if (!box) return;
    var body = box.querySelector('#ar-insp-body');
    if (!body || !AR.open) { box.innerHTML = inspectorHtml(); return; }
    var y = body.scrollTop;
    var held = body.contains(document.activeElement);
    body.innerHTML = inspectorBodyHtml(AR.open);
    body.scrollTop = y;
    if (held) { var close = box.querySelector('[data-ar-close]'); if (close) close.focus({ preventScroll: true }); }
  }

  // ── the inspector: a floating panel, so nothing under it moves ────────────

  function openAgent(host, id, opener) {
    if (!summaryOf(id)) return;
    AR.open = id;
    AR.opener = opener || null;
    var box = host.querySelector('#ar-insp'), scrim = host.querySelector('.ar-scrim');
    if (!box) return;
    box.innerHTML = inspectorHtml();
    box.classList.add('is-open');
    box.removeAttribute('aria-hidden');
    box.removeAttribute('inert');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'ar-insp-title');
    if (scrim) scrim.classList.add('is-open');
    markOpen(host);
    var close = box.querySelector('[data-ar-close]');
    if (close) close.focus({ preventScroll: true });
    if (!AR.detail[id]) {
      loadDetail(id).then(function () { if (AR.open === id) repaintInspector(host); });
    }
  }
  function closeAgent(host) {
    if (!AR.open) return;
    AR.open = null;
    var box = host.querySelector('#ar-insp'), scrim = host.querySelector('.ar-scrim');
    if (box) {
      box.classList.remove('is-open'); box.setAttribute('aria-hidden', 'true'); box.setAttribute('inert', '');
      box.removeAttribute('role'); box.removeAttribute('aria-modal'); box.removeAttribute('aria-labelledby');
    }
    if (scrim) scrim.classList.remove('is-open');
    markOpen(host);
    var back = AR.opener;
    AR.opener = null;
    // The element that opened it may have been redrawn since: find its successor by the agent it named.
    if (back && !host.contains(back) && back.getAttribute) back = host.querySelector('[data-ar-agent="' + back.getAttribute('data-ar-agent') + '"]');
    if (back && back.focus) back.focus({ preventScroll: true });
  }
  /** The open agent is marked where it is drawn, without redrawing what is drawn. */
  function markOpen(host) {
    var els = host.querySelectorAll('.ar-node, .ar-row');
    for (var i = 0; i < els.length; i++) els[i].classList.toggle('is-open', els[i].getAttribute('data-ar-agent') === AR.open);
  }
  function focusables(box) {
    return Array.prototype.filter.call(box.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])'), function (el) { return !el.disabled; });
  }

  function refresh(host) {
    if (AR.refreshing) return;
    AR.refreshing = true;
    AR.detail = {}; AR.detailError = {};
    AR.wf = null; AR.wfError = null;
    AR.pub = null; AR.pubError = null;
    var btn = host.querySelector('.ar-top [data-ar-refresh]');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = T('Reading…'); }
    loadOverview().then(function () {
      AR.refreshing = false;
      var open = AR.open;
      AR.open = null;
      paint(host);
      if (AR.view === 'workflows') openWorkflows(host);
      if (open && summaryOf(open)) openAgent(host, open, null);
    });
  }
  function closeLangs(host) {
    AR.langOpen = false;
    var box = host.querySelector('.ar-langs');
    if (box) box.classList.remove('is-open');
    var pick = host.querySelector('[data-ar-langs]');
    if (pick) pick.setAttribute('aria-expanded', 'false');
  }
  function caption(host, id) {
    var cap = host.querySelector('#ar-caption');
    var a = id ? summaryOf(id) : null;
    if (cap) cap.textContent = a ? nodeLabel(a) : T('Choose an agent to inspect its manifest.');
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__arBound) return;
    host.__arBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      // A click on the map is resolved where the pointer was released. A press and a release in the same
      // frame (a tap, a quick click) can be dispatched to the map itself rather than to the node under it.
      if (t.closest('.ar-map') && !t.closest('[data-ar-agent], [data-ar-sector]') && typeof document.elementFromPoint === 'function') {
        var under = document.elementFromPoint(ev.clientX, ev.clientY);
        if (under && under.closest && under.closest('.ar-map')) t = under;
      }
      if (t.closest('[data-ar-back]')) { try { window.navTo('system'); } catch (_) {} return; }

      if (t.closest('[data-ar-langs]')) {
        AR.langOpen = !AR.langOpen;
        var box = host.querySelector('.ar-langs');
        if (box) box.classList.toggle('is-open', AR.langOpen);
        t.closest('[data-ar-langs]').setAttribute('aria-expanded', AR.langOpen ? 'true' : 'false');
        return;
      }
      var lang = t.closest('[data-ar-lang]');
      if (lang) {
        AR.langOpen = false;
        setLocale(lang.getAttribute('data-ar-lang')).then(function () {
          var view = host.querySelector('#ar-view');
          var y = view ? view.scrollTop : 0;
          var open = AR.open;
          AR.open = null;
          paint(host);
          var again = host.querySelector('#ar-view');
          if (again) again.scrollTop = y;
          if (open) openAgent(host, open, null);
          var pick = host.querySelector('[data-ar-langs]');
          if (pick && !open) pick.focus({ preventScroll: true });
        });
        return;
      }
      if (AR.langOpen && !t.closest('.ar-langs')) closeLangs(host);

      if (t.closest('[data-ar-close]')) { closeAgent(host); return; }
      if (t.closest('[data-ar-refresh]')) { refresh(host); return; }
      var retry = t.closest('[data-ar-retry]');
      if (retry) {
        var rid = retry.getAttribute('data-ar-retry');
        delete AR.detailError[rid];
        repaintInspector(host);
        loadDetail(rid).then(function () { if (AR.open === rid) repaintInspector(host); });
        return;
      }
      var view = t.closest('[data-ar-view]');
      if (view) { AR.view = view.getAttribute('data-ar-view'); repaintView(host, false); return; }
      var runBtn = t.closest('[data-ar-wf]');
      if (runBtn) {
        var rid2 = runBtn.getAttribute('data-ar-wf');
        if (rid2 !== AR.run) { AR.run = rid2; AR.task = null; AR.traceAll = true; repaintView(host, true); }
        var again = host.querySelector('[data-ar-wf="' + rid2 + '"]');
        if (again) again.focus({ preventScroll: true });
        return;
      }
      var taskEl = t.closest('[data-ar-task]');
      if (taskEl) { selectTask(host, taskEl.getAttribute('data-ar-task')); return; }
      var tr = t.closest('[data-ar-trace]');
      if (tr && !tr.disabled) {
        AR.traceAll = tr.getAttribute('data-ar-trace') === 'all';
        var run0 = runOf(AR.run), box0 = host.querySelector('#ar-wf-trace');
        if (run0 && box0) box0.innerHTML = traceHtml(run0);
        var same0 = host.querySelector('[data-ar-trace="' + (AR.traceAll ? 'all' : 'task') + '"]');
        if (same0) same0.focus({ preventScroll: true });
        return;
      }
      if (t.closest('[data-ar-wf-retry]')) { AR.wfError = null; repaintView(host, false); openWorkflows(host); return; }
      if (t.closest('[data-ar-pub-retry]')) { AR.pubError = null; repaintView(host, false); openWorkflows(host); return; }
      var dom = t.closest('[data-ar-domain], [data-ar-sector]');
      if (dom) {
        var key = dom.getAttribute('data-ar-domain') || dom.getAttribute('data-ar-sector');
        AR.domain = AR.domain === key ? 'all' : key;
        syncSelects(host);
        repaintView(host, true);
        var same = host.querySelector('[data-ar-domain="' + key + '"]');
        if (same && dom.hasAttribute('data-ar-domain')) same.focus({ preventScroll: true });
        return;
      }
      if (t.closest('[data-ar-clear]')) {
        AR.q = ''; AR.scope = 'all'; AR.domain = 'all'; AR.lifecycle = 'all';
        syncSelects(host);
        repaintView(host, false);
        var q = host.querySelector('#ar-q');
        if (q) q.focus();
        return;
      }
      var agent = t.closest('[data-ar-agent]');
      if (agent && !t.closest('#ar-insp')) {
        var opener = agent.closest('.ar-row') ? agent.closest('.ar-row').querySelector('.ar-row-open') : agent;
        openAgent(host, agent.getAttribute('data-ar-agent'), opener);
      }
    });

    host.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t && t.id === 'ar-q') { AR.q = t.value; repaintView(host, true); }
    });
    host.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.id === 'ar-scope') AR.scope = t.value;
      else if (t.id === 'ar-domain') AR.domain = t.value;
      else if (t.id === 'ar-lifecycle') AR.lifecycle = t.value;
      else return;
      repaintView(host, true);
    });

    // The map names the agent under the pointer or the focus, in words, for every reader.
    host.addEventListener('focusin', function (ev) {
      var n = ev.target && ev.target.closest ? ev.target.closest('.ar-node') : null;
      if (n) caption(host, n.getAttribute('data-ar-agent'));
    });
    host.addEventListener('mouseover', function (ev) {
      var n = ev.target && ev.target.closest ? ev.target.closest('.ar-node') : null;
      if (n) caption(host, n.getAttribute('data-ar-agent'));
    });

    host.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if (ev.key === 'Escape') {
        if (AR.langOpen) { closeLangs(host); var pick = host.querySelector('[data-ar-langs]'); if (pick) pick.focus(); return; }
        if (AR.open) { ev.preventDefault(); closeAgent(host); return; }
      }
      // The open manifest keeps the focus inside it until it is closed.
      if (ev.key === 'Tab' && AR.open) {
        var box = host.querySelector('#ar-insp');
        var list = box ? focusables(box) : [];
        if (list.length) {
          var first = list[0], last = list[list.length - 1];
          if (!box.contains(document.activeElement)) { ev.preventDefault(); first.focus(); return; }
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); return; }
          if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); return; }
        }
      }
      if (!t || !t.closest) return;
      var node = t.closest('.ar-node');
      if (node) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openAgent(host, node.getAttribute('data-ar-agent'), node); return; }
        // Arrow keys move between the nodes, in the order the ring draws them.
        if (/^Arrow(Right|Left|Up|Down)$/.test(ev.key)) {
          var all = Array.prototype.slice.call(host.querySelectorAll('.ar-map .ar-node'));
          var at = all.indexOf(node);
          var fwd = ev.key === 'ArrowDown' || (ev.key === 'ArrowRight') !== (AR_DIR === 'rtl');
          if (ev.key === 'ArrowUp') fwd = false;
          var next = all[(at + (fwd ? 1 : -1) + all.length) % all.length];
          if (next) { ev.preventDefault(); next.focus(); }
          return;
        }
      }
      var task = t.closest('.ar-wf-node');
      if (task) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectTask(host, task.getAttribute('data-ar-task')); return; }
        if (/^Arrow(Right|Left|Up|Down)$/.test(ev.key)) {
          var tasks = Array.prototype.slice.call(host.querySelectorAll('.ar-wf-node'));
          var ti = tasks.indexOf(task);
          var fw = ev.key === 'ArrowDown' || (ev.key === 'ArrowRight') !== (AR_DIR === 'rtl');
          if (ev.key === 'ArrowUp') fw = false;
          var nt = tasks[(ti + (fw ? 1 : -1) + tasks.length) % tasks.length];
          if (nt) { ev.preventDefault(); nt.focus(); }
          return;
        }
      }
      var tab = t.closest('[data-ar-view]');
      if (tab && /^(ArrowRight|ArrowLeft|Home|End)$/.test(ev.key)) {
        var order = ['map', 'catalogue', 'workflows'];
        var rtl = AR_DIR === 'rtl';
        var at2 = order.indexOf(AR.view);
        var step = ev.key === 'ArrowRight' ? (rtl ? -1 : 1) : ev.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
        var nx = ev.key === 'Home' ? 0 : ev.key === 'End' ? order.length - 1 : (at2 + step + order.length) % order.length;
        ev.preventDefault();
        AR.view = order[nx];
        repaintView(host, false);
        var f = host.querySelector('#ar-tab-' + AR.view);
        if (f) f.focus();
      }
    });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaAgentsRoom = function (host) {
    // The navigation switch calls this with the root element; a call with none finds it.
    host = host || document.getElementById('ar-root');
    if (!host) return;
    bind(host);
    setLocale(initialLocale()).then(function () {
      paint(host);
      return loadOverview();
    }).then(function () { paint(host); });
  };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaAgentsRoomSeen = function () { return Object.keys(AR_SEEN).sort(); };
  window.__familistaAgentsRoomMissing = function () {
    return AR_LANG === 'en' ? [] : Object.keys(AR_SEEN).filter(function (k) { return !hasKey(k); }).sort();
  };

  window.teardownFamilistaAgentsRoom = function () {
    // No stream or timer of its own. The inspector, filters and language menu are
    // dropped so the room opens clean next time; the read registry is kept.
    AR.open = null; AR.opener = null; AR.view = 'map';
    AR.run = null; AR.task = null; AR.traceAll = true;
    AR.q = ''; AR.scope = 'all'; AR.domain = 'all'; AR.lifecycle = 'all';
    AR.langOpen = false; AR.refreshing = false;
  };
})();
