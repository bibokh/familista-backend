/*
 * Familista — Browser API Client
 *
 * Exposes `window.FamilistaAPI` with typed (well, documented) functions for
 * every engine. Dependency-free, ~10KB. Drop into <head> after the
 * white-label bootstrap script.
 *
 *   <script src="/whitelabel-bootstrap.client.js"></script>
 *   <script src="/familista-api-client.js"></script>
 *   <script>
 *     FamilistaAPI.setToken(localStorage.getItem('jwt'));
 *     const dash = await FamilistaAPI.executive.dashboard();
 *   </script>
 *
 * All methods return Promises that resolve to the parsed `data` field of the
 * API envelope, or throw an Error with the server message on non-2xx.
 */

(function () {
  'use strict';

  var BASE = (window.FAMILISTA_API_BASE || '/api/v1').replace(/\/$/, '');
  var token = null;

  function setToken(t) { token = t || null; }
  function getToken() { return token; }
  function setBase(url) { BASE = String(url || '/api/v1').replace(/\/$/, ''); }

  function buildUrl(path, query) {
    var url = BASE + path;
    if (query && typeof query === 'object') {
      var pairs = [];
      for (var k in query) {
        if (Object.prototype.hasOwnProperty.call(query, k) && query[k] !== undefined && query[k] !== null) {
          pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])));
        }
      }
      if (pairs.length) url += (url.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
    }
    return url;
  }

  function request(method, path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];

    var init = { method: method, headers: headers, credentials: 'include' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    return fetch(buildUrl(path, opts.query), init).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = { message: text }; }
        if (!res.ok) {
          var msg = (body && (body.message || body.error)) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
      });
    });
  }

  var get   = function (p, q)    { return request('GET',    p, { query: q }); };
  var post  = function (p, b, q) { return request('POST',   p, { body: b, query: q }); };
  var put   = function (p, b)    { return request('PUT',    p, { body: b }); };
  var patch = function (p, b)    { return request('PATCH',  p, { body: b }); };
  var del   = function (p)       { return request('DELETE', p); };

  // ─── White-label ──────────────────────────────────────────────────────
  var whitelabel = {
    resolve: function (host) { return get('/whitelabel/public/resolve', { host: host || window.location.hostname }); },
    myConfig: function () { return get('/whitelabel/'); },
    updateMyConfig: function (body) { return put('/whitelabel/', body); },
    resetMyConfig: function () { return post('/whitelabel/reset'); },
    domains: function () { return get('/whitelabel/domains'); },
    addDomain: function (body) { return post('/whitelabel/domains', body); },
    verifyDomain: function (id) { return post('/whitelabel/domains/' + id + '/verify'); },
    audit: function (limit) { return get('/whitelabel/audit', { limit: limit }); },
  };

  // ─── Super Admin Console ──────────────────────────────────────────────
  var admin = {
    // — White-label —
    listConfigs: function (q) { return get('/admin/whitelabel/configs', q); },
    getConfig: function (clubId) { return get('/admin/whitelabel/configs/' + clubId); },
    updateConfig: function (clubId, body) { return put('/admin/whitelabel/configs/' + clubId, body); },
    listPalettes: function (q) { return get('/admin/whitelabel/palettes', q); },
    applyPalette: function (clubId, body) { return post('/admin/whitelabel/configs/' + clubId + '/apply-palette', body); },
    listDomains: function (q) { return get('/admin/whitelabel/domains', q); },
    forceVerifyDomain: function (domainId, body) { return post('/admin/whitelabel/domains/' + domainId + '/verify', body); },
    listFeatureFlags: function () { return get('/admin/feature-flags'); },
    upsertFeatureFlag: function (body) { return put('/admin/feature-flags', body); },
    licenseMatrix: function (clubId) { return get('/admin/organizations/' + clubId + '/license'); },
    updateLimits: function (clubId, body) { return put('/admin/organizations/' + clubId + '/limits', body); },
    createOverride: function (clubId, body) { return post('/admin/organizations/' + clubId + '/overrides', body); },
    audit: function (q) { return get('/admin/audit', q); },

    // — Platform admin dashboard summaries —
    dashboard: {
      overview:      function (q) { return get('/admin/dashboard/overview', q); },
      engines:       function ()  { return get('/admin/dashboard/engines'); },
      subscriptions: function ()  { return get('/admin/dashboard/subscriptions'); },
      ai:            function ()  { return get('/admin/dashboard/ai'); },
      vision:        function ()  { return get('/admin/dashboard/vision'); },
      alerts:        function ()  { return get('/admin/dashboard/alerts'); },
    },

    // — Organizations / clubs / academies —
    orgs: {
      list:      function (q)  { return get('/admin/organizations', q); },
      get:       function (id) { return get('/admin/organizations/' + id); },
    },
    clubs: {
      list:      function (q)  { return get('/admin/clubs', q); },
      get:       function (id) { return get('/admin/clubs/' + id); },
    },
    academies: {
      list: function (q) { return get('/admin/academies', q); },
    },

    // — Users / coaches / managers —
    users: {
      list:        function (q)         { return get('/admin/users', q); },
      setActive:   function (id, body)  { return patch('/admin/users/' + id + '/active', body); },
    },
    coaches: {
      list: function (q) { return get('/admin/coaches', q); },
    },
    managers: {
      list: function (q) { return get('/admin/managers', q); },
    },

    // — Players —
    players: {
      list: function (q) { return get('/admin/players', q); },
    },

    // — Investors —
    investors: {
      list:      function (q)        { return get('/admin/investors', q); },
      setActive: function (id, body) { return patch('/admin/investors/' + id + '/active', body); },
    },

    // — Subscriptions / payments —
    subscriptions: {
      list: function (q) { return get('/admin/subscriptions', q); },
    },
    payments: {
      list: function (q) { return get('/admin/payments', q); },
    },

    // — Franchise units —
    franchiseUnits: {
      list:      function (q)        { return get('/admin/franchise-units', q); },
      setStatus: function (id, body) { return patch('/admin/franchise-units/' + id + '/status', body); },
    },

    // — AI / Vision engine surface —
    aiEngine: {
      models:    function (q) { return get('/admin/ai/models', q); },
      decisions: function (q) { return get('/admin/ai/decisions', q); },
    },
    visionEngine: {
      runs: function (q) { return get('/admin/vision/runs', q); },
    },

    // — Audit logs —
    auditLogs: {
      list: function (q) { return get('/admin/audit-logs', q); },
    },
  };

  // ─── Franchise ────────────────────────────────────────────────────────
  var franchise = {
    listUnits: function (q) { return get('/franchise/units', q); },
    getUnit: function (id) { return get('/franchise/units/' + id); },
    createUnit: function (body) { return post('/franchise/units', body); },
    unitTree: function (id, depth) { return get('/franchise/units/' + id + '/tree', { depth: depth }); },
    listTerritories: function (q) { return get('/franchise/territories', q); },
    territoryTree: function (rootId) { return get('/franchise/territories/tree', { rootId: rootId }); },
    expansionOpportunities: function (q) { return get('/franchise/territories/opportunities', q); },
    capTable: function (unitId) { return get('/franchise/units/' + unitId + '/cap-table'); },
    listRules: function (q) { return get('/franchise/split-rules', q); },
    recordDistribution: function (body) { return post('/franchise/distributions', body); },
    contracts: function (q) { return get('/franchise/contracts', q); },
    violations: function (q) { return get('/franchise/violations', q); },
    livePerformance: function (unitId, q) { return get('/franchise/units/' + unitId + '/performance', q); },
    networkHealth: function () { return get('/franchise/network/health'); },
  };

  // ─── Investor ─────────────────────────────────────────────────────────
  var investor = {
    myProfile: function () { return get('/investor/profiles/me'); },
    myDashboard: function () { return get('/investor/dashboard/me'); },
    portfolio: function (id) { return get('/investor/profiles/' + id + '/portfolio'); },
    listEntities: function (q) { return get('/investor/entities', q); },
    entity: function (id) { return get('/investor/entities/' + id); },
    capTable: function (entityId, asOf) { return get('/investor/entities/' + entityId + '/cap-table', { asOf: asOf }); },
    listRounds: function (q) { return get('/investor/rounds', q); },
    listInvestments: function (q) { return get('/investor/investments', q); },
    distributions: function (q) { return get('/investor/distributions', q); },
    statementPdfUrl: function (id, period) {
      return buildUrl('/investor/profiles/' + id + '/statement.pdf', { period: period });
    },
    capTablePdfUrl: function (entityId, asOf) {
      return buildUrl('/investor/entities/' + entityId + '/cap-table.pdf', { asOf: asOf });
    },
  };

  // ─── AI Decision Engine ───────────────────────────────────────────────
  function aiOpts(opts) { return opts || {}; }
  var ai = {
    listModels: function (q) { return get('/ai/models', q); },
    injuryRisk: function (playerId, opts) { return post('/ai/decisions/player/' + playerId + '/injury-risk', aiOpts(opts)); },
    talent: function (playerId, opts) { return post('/ai/decisions/player/' + playerId + '/talent', aiOpts(opts)); },
    fatigue: function (playerId, opts) { return post('/ai/decisions/player/' + playerId + '/fatigue', aiOpts(opts)); },
    growth: function (playerId, opts) { return post('/ai/decisions/player/' + playerId + '/growth', aiOpts(opts)); },
    transferRec: function (playerId, opts) { return post('/ai/decisions/player/' + playerId + '/transfer', aiOpts(opts)); },
    training: function (playerId, opts) { return post('/ai/decisions/player/' + playerId + '/training', aiOpts(opts)); },
    lineup: function (matchId, opts) { return post('/ai/decisions/lineup/' + matchId, aiOpts(opts)); },
    tactics: function (matchId, opts) { return post('/ai/decisions/coach/match/' + matchId + '/tactics', aiOpts(opts)); },
    opponent: function (matchId, opts) { return post('/ai/decisions/coach/match/' + matchId + '/opponent', aiOpts(opts)); },
    matchPrep: function (matchId, opts) { return post('/ai/decisions/coach/match/' + matchId + '/prep', aiOpts(opts)); },
    financialHealth: function (clubId, opts) { return post('/ai/decisions/club/' + clubId + '/financial-health', aiOpts(opts)); },
    sponsorship: function (clubId, opts) { return post('/ai/decisions/club/' + clubId + '/sponsorship', aiOpts(opts)); },
    salaryRisk: function (clubId, opts) { return post('/ai/decisions/club/' + clubId + '/salary-risk', aiOpts(opts)); },
    territoryRisk: function (unitId, opts) { return post('/ai/decisions/franchise/' + unitId + '/territory-risk', aiOpts(opts)); },
    regionalExpansion: function (unitId, opts) { return post('/ai/decisions/franchise/' + unitId + '/expansion', aiOpts(opts)); },
    ceoBrief: function (opts) { return post('/ai/decisions/executive/ceo-brief', aiOpts(opts)); },
    history: function (q) { return get('/ai/history', q); },
    decision: function (id) { return get('/ai/decisions/' + id); },
    submitFeedback: function (id, body) { return post('/ai/decisions/' + id + '/feedback', body); },
    recordOutcome: function (id, body) { return post('/ai/decisions/' + id + '/outcome', body); },
  };

  // ─── Vision Intelligence ──────────────────────────────────────────────
  var vision = {
    registerVideo: function (body) { return post('/vision/videos', body); },
    listVideos: function (q) { return get('/vision/videos', q); },
    startIngest: function (videoId, body) { return post('/vision/videos/' + videoId + '/ingest', body || {}); },
    analyses: function (q) { return get('/vision/analyses', q); },
    runAnalytics: function (analysisId, body) { return post('/vision/analyses/' + analysisId + '/analytics/run', body); },
    matchAnalytics: function (matchId, q) { return get('/vision/analytics', Object.assign({ matchId: matchId }, q || {})); },
    fusion: function (q) { return get('/vision/fusion', q); },
    runFusion: function (body) { return post('/vision/fusion/run', body); },
    clips: function (q) { return get('/vision/clips', q); },
    generateHighlights: function (body) { return post('/vision/clips/highlights', body); },
    scouting: function (q) { return get('/vision/scouting', q); },
    generateScouting: function (body) { return post('/vision/scouting', body); },
    liveSubscribe: function (matchId, onEvent, onError) {
      var url = buildUrl('/vision/live/' + matchId + '/stream');
      var es = new EventSource(url, { withCredentials: true });
      es.addEventListener('event', function (e) { try { onEvent(JSON.parse(e.data)); } catch (_) {} });
      es.addEventListener('stream-status', function (e) { try { onEvent(JSON.parse(e.data)); } catch (_) {} });
      es.onerror = function (e) { if (typeof onError === 'function') onError(e); };
      return es; // caller closes via es.close()
    },
  };

  // ─── Executive OS ─────────────────────────────────────────────────────
  var executive = {
    dashboard: function () { return get('/executive/dashboard'); },
    actions: function () { return get('/executive/actions'); },
    listWorkflows: function (q) { return get('/executive/workflows', q); },
    createWorkflow: function (body) { return post('/executive/workflows', body); },
    workflow: function (id) { return get('/executive/workflows/' + id); },
    transitionWorkflow: function (id, body) { return post('/executive/workflows/' + id + '/transition', body); },
    attest: function (id, body) { return post('/executive/workflows/' + id + '/attest', body); },
    runNextStep: function (id) { return post('/executive/workflows/' + id + '/run-next'); },
    listResolutions: function (q) { return get('/executive/resolutions', q); },
    createResolution: function (body) { return post('/executive/resolutions', body); },
    castVote: function (id, body) { return post('/executive/resolutions/' + id + '/vote', body); },
    sponsors: function (q) { return get('/executive/sponsors', q); },
    createSponsor: function (body) { return post('/executive/sponsors', body); },
    advanceSponsor: function (id, body) { return post('/executive/sponsors/' + id + '/stage', body); },
    risks: function (q) { return get('/executive/risks', q); },
    runRiskSweep: function () { return post('/executive/risks/sweep'); },
    generateForecast: function (body) { return post('/executive/forecasts', body); },
    listForecasts: function (q) { return get('/executive/forecasts', q); },
    listAssignments: function () { return get('/executive/assignments'); },
    upsertAssignment: function (body) { return put('/executive/assignments', body); },
  };

  window.FamilistaAPI = {
    setToken: setToken,
    getToken: getToken,
    setBase: setBase,
    raw: { get: get, post: post, put: put, patch: patch, delete: del, request: request },
    whitelabel: whitelabel,
    admin: admin,
    franchise: franchise,
    investor: investor,
    ai: ai,
    vision: vision,
    executive: executive,
  };
})();
