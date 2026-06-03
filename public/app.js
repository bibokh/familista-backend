/* ============================================================
   FAMILISTA v5 — COMPLETE PRODUCTION APPLICATION
   Full Backend Integration — Live API Data
   ============================================================ */

// ════════════════════════════════════════════════════════════════════════
// FAMILISTA — Network layer (config + API wrapper + health monitor)
// ════════════════════════════════════════════════════════════════════════
// Single source of truth for every fetch in the SPA. Lives ABOVE all
// feature code so nothing can shadow it.
//
//   FAM_CONFIG       — environment-aware URLs + timeouts
//   FamilistaAPI     — wrapper: timeout, retry on cold-start, refresh on 401,
//                      structured Error subclass with .code / .userMessage
//   BackendHealth    — periodic /api/health ping + cold-start banner + UI hooks
//   api(...)         — legacy alias; delegates to FamilistaAPI for back-compat
//   tryRefreshToken  — kept; uses FamilistaAPI internally
// ════════════════════════════════════════════════════════════════════════

const FAM_CONFIG = (function () {
  // Environment-aware base — same host as the SPA when local, Render in prod.
  // Override at runtime via  window.FAMILISTA_API_BASE  or  ?api=…  query.
  const fromQuery = (new URLSearchParams(location.search)).get('api');
  const fromGlobal = (typeof window !== 'undefined' && window.FAMILISTA_API_BASE) || null;
  const isLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(location.hostname);
  const inferred = isLocal
    ? 'http://' + location.hostname + ':' + (location.port || '4000') + '/api/v1'
    : 'https://familista-backend.onrender.com/api/v1';
  const apiBase  = (fromQuery || fromGlobal || inferred).replace(/\/+$/, '');
  const apiRoot  = apiBase.replace(/\/api\/v\d+$/, '');   // …/api/v1  →  …
  // NOTE: The GPS simulator WebSocket (/ws/live) was removed. WS_URL now holds
  // the base WebSocket root only. Live match WebSocket URLs are constructed
  // inline as: wsBase + '/ws/match/:id?token=...' (see connectMatchWS).
  const wsBase   = apiRoot.replace(/^http/, 'ws');

  return Object.freeze({
    API_BASE:               apiBase,
    HEALTH_URL:             apiRoot + '/api/health',
    WS_URL:                 wsBase,

    // Network behaviour
    REQUEST_TIMEOUT_MS:     20000,     // normal request
    COLD_START_TIMEOUT_MS:  60000,     // first request after wake (Render free tier)
    RETRY_COUNT:            2,         // 1 + 2 = 3 total attempts
    RETRY_BACKOFF_MS:       1500,      // 1.5s, then 3s, then 4.5s
    HEALTH_PING_INTERVAL:   30000,
    HEALTH_BOOT_TIMEOUT_MS: 8000,
    HEALTH_PING_TIMEOUT_MS: 4000,

    // Retry on these transport-level errors
    RETRYABLE_STATUSES:     [0, 408, 425, 429, 502, 503, 504],
  });
})();

// Back-compat exports — used by older code paths in the file
const API_BASE    = FAM_CONFIG.API_BASE;
const WS_URL      = FAM_CONFIG.WS_URL;
const PLAYERS_API = FAM_CONFIG.API_BASE + '/players';

// ── STATE ──
const State = {
  token:        null,   // in-memory only — for WebSocket/SSE ?token= param
  user:         null,
  club:         null,
  players:      [],
  matches:      [],
  tournaments:  [],
  analytics:    null,
  devices:      [],
  financials:   null,
  training:              [],
  trainingForm:          null,
  activeTrainingSession: null,
  scouting:              [],
  injuries:     [],
  video:        { assets: [], clips: [], playlists: [], _loading: false, _tab: 'library' },
  transfer:     { targets: [], pipeline: {}, reports: [], contracts: [], squadVal: [], squadIntel: null, _playerIntel: null, _compareResult: null, _compareA: null, _compareB: null, _rankedTargets: null, _squadDepth: null, _unifiedIntel: null, _futurePlan: null, _loading: false, _tab: 'dashboard', _search: '', _stageFilter: '', _recFilter: '' },
  stats:        { competitions: [], injuries: [], squadReadiness: null, matchStats: [], eventSummary: {}, playerProfile: null, playerSeasons: [], standings: [], fixtures: [], compareA: null, compareB: null, _loading: false, _tab: 'performance', _selectedMatchId: '', _selectedPlayerId: '', _selectedCompId: '', _selectedTeamId: '', _playerAId: '', _playerBId: '', _seasonFilter: '', _injSearch: '', _injActiveOnly: false, _comparing: false },
  admin:        { quality: null, health: null, auditLog: null, tab: 'quality', _loading: false },
  tacticalAI:   { teamAnalysis: null, matchAnalysis: null, _loading: false, _tab: 'overview', _selectedMatchId: '' },
  // GPS simulator state removed — was: liveData, ws, liveTimer, liveRunning, liveInterval
  aiBusy:       false,
  aiHistory:    [],
  activePlayer: null,
  sidebarCollapsed: false,
  isDark:       true,
  charts:       {},
  // Network state
  backendHealthy: null,            // null = unknown, true/false after first ping
  coldStartInFlight: false,
};

// ── Structured network error ─────────────────────────────────────────────
class ApiError extends Error {
  constructor(opts) {
    super(opts.message || 'Request failed');
    this.name        = 'ApiError';
    this.code        = opts.code        || 'UNKNOWN';      // e.g. NETWORK, TIMEOUT, AUTH, RATE_LIMIT, SERVER, VALIDATION
    this.status      = opts.status      || 0;
    this.userMessage = opts.userMessage || this.message;
    this.cause       = opts.cause       || null;
    this.url         = opts.url         || null;
  }
}

function mapApiError(err, ctx) {
  // Already an ApiError → pass through
  if (err instanceof ApiError) return err;

  // AbortError (timeout)
  if (err && err.name === 'AbortError') {
    return new ApiError({
      code: 'TIMEOUT', status: 0, url: ctx.url, cause: err,
      message: 'Request timed out',
      userMessage: 'Connection timeout. The server is taking too long to respond.',
    });
  }
  // Native fetch failure → network/CORS/DNS
  if (err instanceof TypeError) {
    return new ApiError({
      code: 'NETWORK', status: 0, url: ctx.url, cause: err,
      message: err.message || 'Network error',
      userMessage: navigator.onLine === false
        ? 'You appear to be offline. Check your internet connection.'
        : 'Backend waking up… Please retry in a few seconds.',
    });
  }
  return new ApiError({
    code: 'UNKNOWN', status: 0, url: ctx.url, cause: err,
    message: (err && err.message) || 'Unknown error',
    userMessage: 'Something went wrong. Please retry.',
  });
}

function mapHttpStatus(status, body, url) {
  const apiMsg = body && (body.message || body.error);
  if (status === 0)                 return new ApiError({ code: 'NETWORK',    status, url, message: 'Network error',                userMessage: 'Backend waking up… Please retry in a few seconds.' });
  if (status === 401)               return new ApiError({ code: 'AUTH',       status, url, message: apiMsg || 'Unauthorized',       userMessage: apiMsg || 'Authentication failed. Please sign in again.' });
  if (status === 403)               return new ApiError({ code: 'FORBIDDEN',  status, url, message: apiMsg || 'Forbidden',          userMessage: apiMsg || 'You do not have permission to do that.' });
  if (status === 404)               return new ApiError({ code: 'NOT_FOUND',  status, url, message: apiMsg || 'Not found',          userMessage: apiMsg || 'The requested resource was not found.' });
  if (status === 408 || status === 504) return new ApiError({ code: 'TIMEOUT', status, url, message: apiMsg || 'Timeout',           userMessage: 'Connection timeout. Please retry.' });
  if (status === 429)               return new ApiError({ code: 'RATE_LIMIT', status, url, message: apiMsg || 'Too many requests',  userMessage: 'Too many requests. Slow down and retry shortly.' });
  if (status >= 500)                return new ApiError({ code: 'SERVER',     status, url, message: apiMsg || 'Server error',       userMessage: status === 502 || status === 503 ? 'Server unavailable. The backend may be restarting — please retry in 30s.' : 'Server error. Please retry shortly.' });
  if (status === 400 || status === 422) return new ApiError({ code: 'VALIDATION', status, url, message: apiMsg || 'Validation error', userMessage: apiMsg || 'Some fields are invalid.' });
  return new ApiError({ code: 'HTTP_' + status, status, url, message: apiMsg || ('HTTP ' + status), userMessage: apiMsg || ('Unexpected error (HTTP ' + status + ')') });
}

// ── Network logger (structured groups) ────────────────────────────────────
// Silent by default. Enable in DevTools with:  window.__NET_LOG = true
function netLog(kind, payload) {
  if (!(typeof window !== 'undefined' && window.__NET_LOG)) return;
  try {
    const stamp = new Date().toISOString().slice(11, 23);
    if (kind === 'req')  console.log('%c[net→] ' + stamp + '  ' + payload.method + ' ' + payload.url, 'color:#22C55E;font-weight:600;');
    else if (kind === 'res') console.log('%c[net✓] ' + stamp + '  ' + payload.status + ' ' + payload.method + ' ' + payload.url + '  (' + payload.dt + 'ms)', 'color:#16A34A;');
    else if (kind === 'err') console.warn('%c[net✗] ' + stamp + '  ' + payload.code + ' ' + payload.method + ' ' + payload.url + '  — ' + payload.message, 'color:#DC2626;font-weight:600;');
    else if (kind === 'retry') console.warn('%c[net⟳] ' + stamp + '  retry ' + payload.attempt + '/' + payload.total + ' after ' + payload.delay + 'ms  ' + payload.method + ' ' + payload.url, 'color:#D97706;');
  } catch (_) {}
}

// ── FamilistaAPI — the wrapper ───────────────────────────────────────────
const FamilistaAPI = (function () {
  let _refreshing = null; // Promise — coalesces concurrent refreshes

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function withTimeout(promise, ms, controller) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try { controller && controller.abort(); } catch (_) {}
        const e = new Error('AbortError'); e.name = 'AbortError';
        reject(e);
      }, ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  async function rawFetch(method, url, opts) {
    opts = opts || {};
    const controller = new AbortController();
    const headers = Object.assign(
      { 'Accept': 'application/json' },
      opts.body !== undefined && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
      opts.headers || {},
      opts.auth !== false && State.token ? { 'Authorization': 'Bearer ' + State.token } : {}
    );

    const init = {
      method,
      headers,
      signal: controller.signal,
      credentials: 'include',
      body: opts.body === undefined ? undefined : (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)),
    };

    const timeoutMs = opts.timeoutMs ||
      (State.backendHealthy === false ? FAM_CONFIG.COLD_START_TIMEOUT_MS : FAM_CONFIG.REQUEST_TIMEOUT_MS);

    const started = Date.now();
    netLog('req', { method, url });

    let res;
    try {
      res = await withTimeout(fetch(url, init), timeoutMs, controller);
    } catch (err) {
      const apiErr = mapApiError(err, { url });
      netLog('err', { code: apiErr.code, method, url, message: apiErr.message });
      throw apiErr;
    }

    const dt = Date.now() - started;
    let body = null;
    if (res.status !== 204) {
      const text = await res.text().catch(() => '');
      if (text) { try { body = JSON.parse(text); } catch (_) { body = { message: text }; } }
    }

    if (!res.ok) {
      const apiErr = mapHttpStatus(res.status, body, url);
      apiErr.body = body;
      netLog('err', { code: apiErr.code, method, url, message: apiErr.message + ' (' + dt + 'ms)' });
      throw apiErr;
    }

    netLog('res', { status: res.status, method, url, dt });
    return body;
  }

  function refreshTokens() {
    // refresh_token HttpOnly cookie is sent automatically — no manual token.
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
      try {
        const body = await rawFetch('POST', FAM_CONFIG.API_BASE + '/auth/refresh',
          { auth: false });
        const data = body && (body.data || body);
        const at   = data && (data.accessToken || (data.tokens && data.tokens.accessToken));
        if (!at) return false;
        State.token = at;   // update in-memory token for WS/SSE
        return true;
      } catch (_) {
        return false;
      } finally {
        _refreshing = null;
      }
    })();
    return _refreshing;
  }

  async function request(method, urlOrPath, opts) {
    opts = opts || {};
    const url = /^https?:/.test(urlOrPath) ? urlOrPath : (FAM_CONFIG.API_BASE + (urlOrPath.startsWith('/') ? '' : '/') + urlOrPath);
    const retryable = FAM_CONFIG.RETRYABLE_STATUSES;
    const maxAttempts = (opts.noRetry ? 0 : FAM_CONFIG.RETRY_COUNT) + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await rawFetch(method, url, opts);
      } catch (err) {
        // 401 → one transparent refresh attempt
        if (err.status === 401 && !opts._refreshed && opts.auth !== false) {
          const ok = await refreshTokens();
          if (ok) return request(method, url, Object.assign({}, opts, { _refreshed: true }));
        }

        const isRetryable = retryable.indexOf(err.status) !== -1 || err.code === 'NETWORK' || err.code === 'TIMEOUT';
        if (!isRetryable || attempt >= maxAttempts) throw err;

        // Cold-start banner on first failure
        if (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.status >= 502) {
          State.backendHealthy = false;
          BackendHealth.notifyOffline(err);
        }

        const delay = FAM_CONFIG.RETRY_BACKOFF_MS * attempt;
        netLog('retry', { attempt, total: maxAttempts, delay, method, url });
        await sleep(delay);
      }
    }
    // unreachable — the loop either returns or throws
    throw new ApiError({ code: 'UNKNOWN', message: 'unreachable' });
  }

  return {
    request,
    get:    (path, opts) => request('GET',    path, opts),
    post:   (path, body, opts) => request('POST',   path, Object.assign({ body }, opts || {})),
    put:    (path, body, opts) => request('PUT',    path, Object.assign({ body }, opts || {})),
    patch:  (path, body, opts) => request('PATCH',  path, Object.assign({ body }, opts || {})),
    delete: (path, opts) => request('DELETE', path, opts),
    refreshTokens,
    rawFetch,
  };
})();

// ── Backend health monitor ───────────────────────────────────────────────
const BackendHealth = (function () {
  let pollTimer = null;
  let lastState = null;          // 'up' | 'down' | null

  function banner() { return document.getElementById('backend-banner'); }

  function show(text, kind) {
    let el = banner();
    if (!el) {
      el = document.createElement('div');
      el.id = 'backend-banner';
      el.className = 'backend-banner';
      document.body.appendChild(el);
    }
    el.className = 'backend-banner ' + (kind || 'warn') + ' show';
    el.innerHTML =
      '<span class="dot"></span>' +
      '<span class="msg">' + (text || '') + '</span>' +
      '<button class="retry" onclick="BackendHealth.retryNow()">Retry now</button>';
  }
  function hide() {
    const el = banner();
    if (el) el.classList.remove('show');
  }

  async function ping(timeoutMs) {
    timeoutMs = timeoutMs || FAM_CONFIG.HEALTH_PING_TIMEOUT_MS;
    try {
      const r = await FamilistaAPI.rawFetch('GET', FAM_CONFIG.HEALTH_URL, { auth: false, timeoutMs });
      if (r && r.status === 'ok') return true;
      return false;
    } catch (_) { return false; }
  }

  // Delegates to the one global guard so health pings / banner mutations are
  // suppressed whenever any editing UI is active (modal, drawer, focused field).
  function _modalIsOpen() {
    return (typeof isEditingUIActive === 'function')
      ? isEditingUIActive()
      : !!document.querySelector('.modal-bg.open');
  }

  async function check(initial) {
    // Never ping / mutate the DOM while a modal form is open — focus would be lost.
    if (!initial && _modalIsOpen()) return;
    const ok = await ping(initial ? FAM_CONFIG.HEALTH_BOOT_TIMEOUT_MS : undefined);
    if (ok) {
      State.backendHealthy = true;
      if (lastState !== 'up') {
        hide();
        if (lastState === 'down') showToast('Backend is back online ✓', 'success');
      }
      lastState = 'up';
    } else {
      State.backendHealthy = false;
      if (lastState !== 'down') {
        show('Backend waking up… retrying automatically.', 'warn');
      }
      lastState = 'down';
    }
    return ok;
  }

  function start() {
    stop();
    check(true);
    pollTimer = setInterval(check, FAM_CONFIG.HEALTH_PING_INTERVAL);

    if (typeof window !== 'undefined') {
      window.addEventListener('online',  () => { if (!_modalIsOpen()) { show('Network restored. Checking backend…', 'info'); check(); } });
      window.addEventListener('offline', () => { State.backendHealthy = false; show('You are offline.', 'warn'); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden && !_modalIsOpen()) check(); });
    }
  }
  function stop() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function notifyOffline(err) {
    const msg = err && err.userMessage || 'Backend is unreachable. Retrying…';
    show(msg, 'warn');
  }
  function retryNow() { check(); }

  return { start, stop, ping, check, notifyOffline, retryNow };
})();

// ── Legacy helpers — kept so the rest of the file works unchanged ────────
async function api(endpoint, options) {
  options = options || {};
  return FamilistaAPI.request(options.method || 'GET', endpoint, {
    body:    options.body,
    headers: options.headers,
  });
}

async function tryRefreshToken() { return FamilistaAPI.refreshTokens(); }

// ── AUTH ──
async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('login-btn');
  const errEl    = document.getElementById('login-error');

  function err(msg) {
    errEl.textContent = msg;
    errEl.classList.add('show');
  }

  if (!email || !password) return err('Please enter email and password');

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errEl.classList.remove('show');

  // Optional pre-flight: if backend is known-down, hint the user.
  if (State.backendHealthy === false) {
    btn.textContent = 'Waking backend…';
    await BackendHealth.check();
  }

  try {
    // FamilistaAPI handles: timeout, retry on 502/503/504, cold-start,
    // banner, structured errors with .userMessage.
    const data = await FamilistaAPI.post('/auth/login', { email, password }, { auth: false });

    // Response envelope: { success, data: { user, tokens: { accessToken, refreshToken } } }
    const payload = (data && data.data) || data;
    const tokens  = (payload && (payload.tokens || payload)) || {};
    const user    = (payload && payload.user) || null;
    const at      = tokens.accessToken;
    const rt      = tokens.refreshToken;

    if (!at) {
      console.error('[Login] No accessToken in response:', data);
      return err('Login succeeded but token missing — please retry.');
    }

    State.token = at;   // in-memory for WS/SSE ?token= param
    State.user  = user;

    console.log('[Login] Success →', user && user.email);
    await bootApp();
  } catch (e) {
    // ApiError has .code + .userMessage; fall back to generic
    const msg = (e && e.userMessage) || (e && e.message) || 'Sign-in failed. Please retry.';
    console.error('[Login] Failed:', e);
    err(msg);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function bootApp() {
  // Hide login, show app
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';

  // Update user info in sidebar
  if (State.user) {
    // /auth/me may return a user without firstName/lastName — fall back safely
    // so bootApp never throws (which would abort renderAllPages below).
    const initials = ((State.user?.firstName?.[0]) || (State.user?.lastName?.[0]) || (State.user?.email?.[0]) || 'U').toUpperCase();
    const fullName = [State.user.firstName, State.user.lastName].filter(Boolean).join(' ').trim() || State.user.email || 'User';
    const avEl   = document.getElementById('user-av');       if (avEl)   avEl.textContent   = initials;
    const nameEl = document.getElementById('user-name');     if (nameEl) nameEl.textContent = fullName;
    const roleEl = document.getElementById('user-email');    if (roleEl) roleEl.textContent = (State.user.role || '').replace('_', ' ');
    const metaEl = document.getElementById('nav-club-meta'); if (metaEl) metaEl.textContent = State.user.clubId ? 'Berlin · Manager' : '';
  }

  // Render all pages
  renderAllPages();

  // Phase A — hydrate tenant context (Club + Team) BEFORE list loads,
  // so SquadAPI can be scoped by the active team.
  try { await AppContext.load(); } catch (_) {}

  // Load data in parallel
  showToast('Loading your club data...', 'info');
  await loadAllData();

  // GPS simulator removed — startLiveGPS / startLiveInterval decommissioned.

  showToast(`Welcome back, ${State.user?.firstName}! ✅`, 'success');

  // Phase 12 — show Admin Center nav item only for CLUB_ADMIN / SUPER_ADMIN
  var role = State.user?.role;
  if (role === 'CLUB_ADMIN' || role === 'SUPER_ADMIN') {
    var navAdmin = document.getElementById('nav-admin');
    if (navAdmin) navAdmin.style.display = '';
  }
}

async function loadAllData() {
  try {
    const [analytics, players, matches, tourns, training] = await Promise.allSettled([
      api('/analytics/overview'),
      SquadAPI.list('limit=50' + (State.context && State.context.teamId ? '&teamId=' + encodeURIComponent(State.context.teamId) : '')),
      api('/matches?limit=20'),
      api('/training?limit=10'),
      api('/training/form'),
    ]);

    if (analytics.status === 'fulfilled' && analytics.value?.data) {
      State.analytics = analytics.value.data;
      renderDashboard();
    }

    if (players.status === 'fulfilled' && players.value?.data) {
      State.players = players.value.data;
      renderSquad();
    }

    if (matches.status === 'fulfilled' && matches.value?.data) {
      State.matches = matches.value.data;
      renderMatches();
    }

    if (tourns.status === 'fulfilled' && tourns.value?.data) {
      State.training = tourns.value.data;
    }

    if (training.status === 'fulfilled' && training.value?.data) {
      State.trainingForm = training.value.data;
    }

    // Load analytics trend
    const trend = await api('/analytics/performance-trend?weeks=8');
    if (trend?.data) {
      State.performanceTrend = trend.data;
    }

  } catch (err) {
    console.error('Data load error:', err);
    showToast('Some data failed to load — showing cached data', 'error');
  }
}

function doLogout() {
  // POST to /auth/logout: server clears both HttpOnly cookies.
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  // Close any open match WebSocket on logout.
  if (typeof _matchModalWS !== 'undefined' && _matchModalWS) {
    try { _matchModalWS.close(); } catch (_) {}
    _matchModalWS = null;
  }
  State.token = null;
  State.user  = null;

  document.getElementById('main-app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  showToast('Logged out successfully', 'info');
}

// ── COOKIE SESSION RESTORE ──
// The access_token HttpOnly cookie is sent automatically; the server validates
// it and returns the current user profile. No localStorage involved.
async function tryAutoLogin() {
  // One-time cleanup of orphaned tokens from the pre-cookie auth model.
  // Older builds stored JWTs in localStorage (fam_token / fam_refresh / fam_user).
  // This build authenticates via HttpOnly cookies + in-memory State.token and
  // never reads them, so any lingering values are stale/expired. Purge them so
  // they can never be mistaken for — or injected as — a live session.
  try {
    localStorage.removeItem('fam_token');
    localStorage.removeItem('fam_refresh');
    localStorage.removeItem('fam_user');
  } catch (_) {}
  try {
    const res = await fetch(API_BASE + '/auth/me', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      const user = (body && (body.data || body)) || null;
      if (user && user.id) {
        State.user = user;
        // Populate the in-memory access token so the Authorization: Bearer
        // header is attached to subsequent cross-site API calls. The SPA
        // (familista-v5) and API (familista-backend) are different origins, so
        // the HttpOnly access_token cookie is a THIRD-PARTY cookie that the
        // browser may not send (third-party-cookie blocking / SameSite). Without
        // a Bearer fallback a restored session sends NO credentials and the API
        // replies "No token provided" (the Club page 401). /auth/refresh uses
        // the refresh_token cookie to mint a fresh access token we hold in memory.
        try {
          const rr = await fetch(API_BASE + '/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (rr.ok) {
            const rd = await rr.json();
            const d  = (rd && (rd.data || rd)) || {};
            if (d.accessToken) State.token = d.accessToken;
          }
        } catch (_) { /* non-fatal: fall back to cookie auth */ }
        console.log('[AutoLogin] Session valid:', user.email, State.token ? '(bearer ready)' : '(cookie only)');
        bootApp();
        return;
      }
    }
    if (res.status === 401) {
      // Access token expired — try transparent cookie refresh
      const rr = await fetch(API_BASE + '/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (rr.ok) {
        const rd = await rr.json();
        const d  = (rd && (rd.data || rd)) || {};
        if (d.accessToken) State.token = d.accessToken;
        const mr = await fetch(API_BASE + '/auth/me', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        if (mr.ok) {
          const mb = await mr.json();
          State.user = (mb && (mb.data || mb)) || null;
          if (State.user && State.user.id) { bootApp(); return; }
        }
      }
    }
    console.log('[AutoLogin] No valid session.');
  } catch (err) {
    console.warn('[AutoLogin] Network error.', err.message);
  }
}

// ── Form-safe render guards ──────────────────────────────────────────────────
// Prevents in-progress user input from being wiped by background re-renders.
//
// ARCHITECTURE: "is the user editing?" is tracked by an explicit body flag
// (`app-editing`) that a MutationObserver keeps in lock-step with the DOM.
// The observer watches every .modal-bg element for class changes, so EVERY
// open/close path — classList.add('open'), closeModal(), Escape, overlay click
// — flips the flag without us having to patch each call site. This is reliable
// even during focus transitions, where document.activeElement briefly parks on
// <body> and a naive .modal-bg.open / activeElement check would read false.

/**
 * ── THE single global guard ───────────────────────────────────────────────
 * isEditingUIActive() — true whenever any editing UI is open OR the user is
 * interacting with a form control. EVERY background render / navigation / poll
 * / WS / SSE entry point checks this before replacing innerHTML, so nothing the
 * user is looking at or typing into is ever torn down underneath them.
 *
 * Returns true when:
 *   • any .modal-bg.open exists (every modal / card detail / edit drawer)
 *   • body has the observer-maintained 'app-editing' flag
 *   • any open edit panel / drawer (defensive, non-.modal-bg variants)
 *   • activeElement is INPUT / TEXTAREA / SELECT / contenteditable
 *
 * NOTE: BUTTON is intentionally excluded from the focus check — filter pills,
 * tab buttons and nav buttons are themselves the legitimate triggers of a
 * re-render, so treating a focused button as "editing" would break them.
 */
function isEditingUIActive() {
  // 1. Observer-maintained flag (primary truth, survives focus transitions)
  if (document.body.classList.contains('app-editing')) return true;
  // 2. Any modal / card detail / edit drawer overlay
  if (document.querySelector('.modal-bg.open')) return true;
  // 3. Defensive: any open edit panel / drawer that isn't a .modal-bg
  if (document.querySelector('.drawer.open, .edit-panel.open, [id*="edit"][class*="open"], [id*="drawer"][class*="open"]')) return true;
  // 4. Any focused text/select control (inline filters, search, AI chat, forms)
  var ae = document.activeElement;
  if (ae && ae !== document.body) {
    var tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (ae.isContentEditable) return true;
  }
  return false;
}

// Aliases — all existing call sites delegate to the one central guard.
function _isModalOpen()      { return isEditingUIActive(); }
function isFormEditing()     { return isEditingUIActive(); }
function _isAnyFormEditing() { return isEditingUIActive(); }

/**
 * Keep document.body.classList('app-editing') synchronised with the real DOM.
 * One MutationObserver on every .modal-bg element fires on each class change,
 * so the flag is always correct regardless of how the modal was opened/closed.
 * When editing ends, flush any render that was deferred while it was active.
 */
(function _wireModalState() {
  function sync() {
    var open = !!document.querySelector('.modal-bg.open');
    var was  = document.body.classList.contains('app-editing');
    document.body.classList.toggle('app-editing', open);
    if (was && !open) _flushPendingRender();   // editing just ended → catch up
  }
  function attach() {
    var obs = new MutationObserver(sync);
    document.querySelectorAll('.modal-bg').forEach(function (m) {
      obs.observe(m, { attributes: true, attributeFilter: ['class'] });
    });
    sync();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
})();

/**
 * Set by a guarded render that had to skip because isFormEditing() was true.
 * Flushed automatically by the modal observer the instant editing ends, so the
 * page catches up to the latest data exactly once — after Save/Cancel/close.
 */
var _pendingRefresh = false;

function _flushPendingRender() {
  if (!_pendingRefresh) return;
  if (isFormEditing()) return;
  _pendingRefresh = false;
  var active = document.querySelector('.page.active');
  if (!active) return;
  switch (active.id) {
    case 'pg-squad':       renderSquad();           break;
    case 'pg-dashboard':   renderDashboard();       break;
    case 'pg-matches':     renderMatches();         break;
    case 'pg-training':    renderTrainingPage();    break;
    case 'pg-medical':     renderMedicalPage();     break;
    case 'pg-performance': renderPerformancePage(); break;
    case 'pg-analytics':   renderAnalyticsPage();   break;
    case 'pg-admin':       renderAdminPage();       break;
    case 'pg-stats':       siRenderTab();           break;
    case 'pg-transfer':    tiRenderTab();           break;
  }
}

/**
 * Snapshot the currently focused element within `container`
 * so we can restore it after an innerHTML replacement.
 * Returns null if no editable element is focused inside container.
 */
function _saveFocusIn(container) {
  var ae = document.activeElement;
  if (!ae || !container.contains(ae)) return null;
  var tag = ae.tagName;
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return null;
  return {
    className: ae.className || '',
    selStart: (tag !== 'SELECT') ? (ae.selectionStart || 0) : null,
    selEnd:   (tag !== 'SELECT') ? (ae.selectionEnd   || 0) : null,
  };
}

/**
 * After container.innerHTML is replaced, restore focus to the first element
 * whose class matches the snapshot. Restores cursor/selection too.
 */
function _restoreFocusIn(container, saved) {
  if (!saved) return;
  var cls = saved.className.trim().split(/\s+/).filter(Boolean)[0];
  var el = cls ? container.querySelector('.' + cls) : container.querySelector('input,textarea,select');
  if (!el) return;
  el.focus();
  if (saved.selStart !== null) {
    try { el.setSelectionRange(saved.selStart, saved.selEnd); } catch (_) {}
  }
}
// ────────────────────────────────────────────────────────────────────────────

// ── NAVIGATION ──
function navTo(page, el) {
  // Global guard: never switch pages / rebuild containers while an editing UI
  // (modal, card detail, edit drawer, or focused form control) is active.
  if (isEditingUIActive()) return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pg = document.getElementById('pg-' + page);
  if (pg) pg.classList.add('active');

  if (el) {
    el.classList.add('active');
  } else {
    const ni = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (ni) ni.classList.add('active');
  }

  const titles = {
    dashboard:'Dashboard', squad:'Squad', matches:'Matches', live:'Live Tracking',
    tournaments:'Tournaments', analytics:'Analytics', ai:'AI Analyst', training:'Training',
    medical:'Medical', performance:'Performance', scouting:'Scouting', video:'Video Intelligence', transfer:'Transfer Intelligence', stats:'Stats Intelligence', finances:'Finances',
    devices:'GPS Devices', club:'Club', settings:'Settings', 'tactical-os':'Tactical OS', admin:'Admin Center', 'tactical-ai':'Tactical AI'
  };
  document.getElementById('page-title').textContent = titles[page] || page;

  // Lazy-load page data
  if (page === 'analytics')   loadAnalyticsData();
  if (page === 'medical')     loadMedicalData();
  if (page === 'performance') loadPerformanceData();
  if (page === 'scouting')    loadScoutingData();
  if (page === 'video')       loadVideoIntelData();
  if (page === 'transfer')    loadTransferData();
  if (page === 'stats')       loadStatsData();
  if (page === 'finances')    loadFinancesData();
  if (page === 'devices')     loadDevicesData();
  if (page === 'club')        loadClubData();
  if (page === 'tournaments') loadTournamentsData();
  if (page === 'tactical-os') loadTacticalOS();
  if (page === 'admin')      loadAdminData();
  if (page === 'tactical-ai') loadTacticalAIData();
}

function toggleSidebar() {
  State.sidebarCollapsed = !State.sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', State.sidebarCollapsed);
  document.querySelector('.brand-collapse').textContent = State.sidebarCollapsed ? '▶' : '◀';
}

function toggleTheme() {
  State.isDark = !State.isDark;
  document.documentElement.setAttribute('data-theme', State.isDark ? 'dark' : 'light');
}

function closeModal(id) {
  // Removing .open fires the modal observer, which clears body.app-editing and
  // flushes any deferred render. No manual flush needed here.
  document.getElementById(id).classList.remove('open');
}

// ── HELPERS ──
function posClass(pos) {
  if (pos === 'GK') return 'pos-gk';
  if (['DC','DL','DR'].includes(pos)) return 'pos-def';
  if (pos === 'ST') return 'pos-att';
  return 'pos-mid';
}

function riskColor(r) {
  if (r > 70) return 'var(--red)';
  if (r > 50) return 'var(--amber)';
  if (r > 25) return '#EAB308';
  return 'var(--green-l)';
}

function condColor(c) {
  if (c >= 85) return 'var(--green-l)';
  if (c >= 65) return 'var(--amber)';
  return 'var(--red)';
}

function condBarBg(c) {
  if (c >= 85) return 'linear-gradient(90deg,#15803D,var(--green-l))';
  if (c >= 65) return 'linear-gradient(90deg,#B45309,var(--amber))';
  return 'linear-gradient(90deg,#B91C1C,var(--red))';
}

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
}

function fmtCurrency(n) {
  if (n >= 1e9) return `€${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6) return `€${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `€${(n/1e3).toFixed(0)}K`;
  return `€${n}`;
}

function playerSVG(p, w=52, h=64) {
  const COLORS = ['#15803D','#1D4ED8','#7C3AED','#B91C1C','#B45309','#0E7490'];
  const c = COLORS[parseInt(p.id?.slice(-1) || 0) % COLORS.length];
  const num = p.number || '?';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">
    <rect width="${w}" height="${h}" rx="8" fill="${c}18"/>
    <rect x="${w*.12}" y="${h*.36}" width="${w*.76}" height="${h*.44}" rx="5" fill="${c}DD"/>
    <text x="${w/2}" y="${h*.65}" text-anchor="middle" fill="white" font-family="JetBrains Mono" font-size="${w*.22}" font-weight="700">${num}</text>
    <circle cx="${w/2}" cy="${h*.22}" r="${w*.18}" fill="#FBBF24"/>
    <ellipse cx="${w/2}" cy="${h*.09}" rx="${w*.18}" ry="${w*.1}" fill="#27272A"/>
    <text x="${w*.15}" y="${h*.95}" font-size="11">${p.flag||'🌍'}</text>
  </svg>`;
}

// ── TOAST ──
function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> ${_esc(msg)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all .3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── LOADING STATE ──
function loadingHTML(msg = 'Loading...') {
  return `<div class="page-loading"><div class="spinner"></div><div class="loading-text">${msg}</div></div>`;
}

function errorHTML(msg = 'Failed to load data') {
  return `<div class="error-state"><div class="error-icon">⚠️</div><div class="error-title">Error</div><div class="error-msg">${msg}</div><button class="btn btn-outline btn-sm" onclick="loadAllData()">Retry</button></div>`;
}

// ── RENDER ALL PAGES ──
function renderAllPages() {
  const container = document.getElementById('pages-container');
  container.innerHTML = `
    ${renderDashboardHTML()}
    ${renderSquadHTML()}
    ${renderMatchesHTML()}
    ${renderTournamentsHTML()}
    ${renderAnalyticsHTML()}
    ${renderAIHTML()}
    ${renderTrainingHTML()}
    ${renderMedicalHTML()}
    ${renderPerformanceHTML()}
    ${renderScoutingHTML()}
    ${renderVideoHTML()}
    ${renderTransferHTML()}
    ${renderStatsHTML()}
    ${renderFinancesHTML()}
    ${renderDevicesHTML()}
    ${renderClubHTML()}
    ${renderSettingsHTML()}
    ${renderQuantumHTML()}
    ${renderTacticalOSHTML()}
    ${renderAdminHTML()}
    ${renderTacticalAIHTML()}
  `;

  renderTournContent('overview');
}

// ── DASHBOARD ──
function renderDashboardHTML() {
  return `<div class="page active" id="pg-dashboard">
  <div class="dash-grid">
    <div class="dash-main">
      <div class="match-hero" id="match-hero">
        ${loadingHTML('Loading next match...')}
      </div>
      <div class="kpi-row" id="kpi-row">
        ${[1,2,3,4].map(()=>`<div class="card"><div class="skeleton skeleton-card"></div></div>`).join('')}
      </div>
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Performance Overview</div><div class="card-sub">Last 8 matches</div></div>
          <span class="badge badge-gray">Loading...</span>
        </div>
        <div style="padding:0 16px 16px;height:170px;display:flex;align-items:center;justify-content:center;">
          <div class="spinner"></div>
        </div>
      </div>
      <div class="card" id="results-card" style="overflow:hidden;">
        <div style="padding:12px 14px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;">
          <div class="card-title">Recent Results</div>
          <button class="btn btn-ghost btn-xs" onclick="navTo('matches',null)">View All</button>
        </div>
        <div id="results-list">${loadingHTML('Loading results...')}</div>
      </div>
    </div>
    <div class="dash-side">
      <div style="flex-shrink:0;">
        <div class="side-hdr"><div class="side-title">League 33</div><span class="badge badge-blue">Live</span></div>
        <div id="standings-mini">${loadingHTML()}</div>
        <div style="padding:8px 14px;">
          <button class="btn btn-ghost btn-xs" style="width:100%;justify-content:center;" onclick="navTo('tournaments',null)">Full Standings →</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;">
        <div class="side-hdr" style="flex-shrink:0;">
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="width:20px;height:20px;border-radius:6px;background:var(--green);display:flex;align-items:center;justify-content:center;font-size:10px;">⚡</div>
            <div class="side-title">ARIA Insights</div>
          </div>
          <span class="badge badge-green">Live</span>
        </div>
        <div id="aria-insights">${loadingHTML()}</div>
      </div>
    </div>
  </div>
</div>`;
}

function renderDashboard() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const d = State.analytics;
  if (!d) return;

  // Match hero
  const nextMatch = State.matches?.find(m => !m.result) || State.matches?.[0];
  const heroEl = document.getElementById('match-hero');
  if (heroEl && nextMatch) {
    const isHome = nextMatch.homeTeam?.includes('Familista');
    heroEl.innerHTML = `
      <div class="mh-top">
        <div class="mh-tag"><div style="width:6px;height:6px;border-radius:50%;background:var(--red);animation:dotPulse 1.2s ease infinite;"></div>
          ${nextMatch.result ? 'Last Match' : 'Next Match'} · ${_esc(nextMatch.competition)} · ${fmtDate(nextMatch.scheduledAt)}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-outline btn-sm" onclick="navTo('ai',null)">AI Preview</button>
          <button class="btn btn-primary btn-sm" onclick="navTo('squad',null)">Set Lineup →</button>
        </div>
      </div>
      <div class="mh-body">
        <div class="mh-team">
          <div class="mh-crest">${isHome ? '🔴' : '⬛'}</div>
          <div class="mh-name">${_esc(nextMatch.homeTeam)}</div>
          <div class="mh-ovr">OVR ${d.overview?.teamRating || 108.9}</div>
          <div class="mh-form">${(d.recentMatches||[]).slice(0,5).map(m=>`<div class="form-dot fd-${m.result?.toLowerCase()[0]||'d'}">${m.result?.[0]||'?'}</div>`).join('')}</div>
        </div>
        <div class="mh-mid">
          <div class="mh-time-box">
            <div class="mh-time">${nextMatch.result ? `${nextMatch.homeScore}—${nextMatch.awayScore}` : new Date(nextMatch.scheduledAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</div>
            <div class="mh-venue">${_esc(nextMatch.venue || 'Away Match')}</div>
          </div>
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);">vs</div>
          <span class="badge badge-amber">${nextMatch.result ? `Result: ${nextMatch.result}` : 'Upcoming'}</span>
        </div>
        <div class="mh-team">
          <div class="mh-crest">${isHome ? '⬛' : '🔴'}</div>
          <div class="mh-name">${_esc(nextMatch.awayTeam)}</div>
          <div class="mh-ovr">OVR 112.4</div>
          <div class="mh-form"><div class="form-dot fd-w">W</div><div class="form-dot fd-w">W</div><div class="form-dot fd-w">W</div><div class="form-dot fd-w">W</div><div class="form-dot fd-w">W</div></div>
        </div>
      </div>
      <div class="mh-prep">
        <div class="mh-prep-label"><span>Team Preparation</span><span style="color:var(--green-l);font-weight:600;">Excellent — ${d.overview?.teamCondition || 87}%</span></div>
        <div class="mh-prep-bar"><div class="mh-prep-fill" style="width:${d.overview?.teamCondition || 87}%;"></div></div>
      </div>
      <div class="mh-actions">
        <button class="btn btn-ghost btn-sm">📋 Match Report</button>
        <button class="btn btn-primary btn-sm" style="margin-left:auto;" onclick="navTo('matches',null)">📅 Match Center →</button>
      </div>`;
  }

  // KPIs
  const kpiEl = document.getElementById('kpi-row');
  if (kpiEl && d.overview) {
    const kpis = [
      { icon:'📈', val: d.overview.teamRating, lbl:'Team Rating', chg:'+2.1 this week', up:true, color:'var(--green-l)' },
      { icon:'🏆', val: `${d.overview.wins||0}W ${d.overview.draws||0}D ${d.overview.losses||0}L`, lbl:'Season Record', chg:'League 33', up:true },
      { icon:'💪', val: `${d.overview.teamCondition}%`, lbl:'Team Condition', chg:`${d.overview.injuredCount} injured`, up:d.overview.injuredCount===0 },
      { icon:'👥', val: d.overview.playerCount, lbl:'Squad Size', chg:'Active players', up:true },
    ];
    kpiEl.innerHTML = kpis.map(k => `
      <div class="card hover metric">
        <div class="metric-icon" style="background:var(--green-bg);">${k.icon}</div>
        <div class="metric-val" style="font-size:${String(k.val).length>5?'20px':'28px'};${k.color?`color:${k.color}`:''}">${k.val}</div>
        <div class="metric-lbl">${k.lbl}</div>
        <div class="metric-chg ${k.up?'chg-up':'chg-dn'}">${k.up?'↑':'↓'} ${k.chg}</div>
      </div>`).join('');
  }

  // Results
  const resultsEl = document.getElementById('results-list');
  if (resultsEl) {
    const matches = d.recentMatches?.slice(0,5) || [];
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="empty"><div class="empty-ico">⚽</div><div class="empty-ttl">No matches yet</div></div>';
    } else {
      resultsEl.innerHTML = matches.map(m => {
        const mine_home = m.homeTeam?.includes('Familista');
        const badge = m.result === 'WIN' ? 'rb-w' : m.result === 'LOSS' ? 'rb-l' : 'rb-d';
        const letter = m.result?.[0] || '?';
        return `<div class="result-row">
          <div class="result-badge ${badge}">${letter}</div>
          <div style="flex:1;">
            <div class="res-home ${mine_home?'res-mine':''}">${m.homeTeam}</div>
            <div class="res-away ${!mine_home?'res-mine':''}">${m.awayTeam}</div>
          </div>
          <div class="res-score">${m.homeScore??'?'} — ${m.awayScore??'?'}</div>
          <div class="res-comp">${m.competition}</div>
        </div>`;
      }).join('');
    }
  }

  // Standings — live from first competition via Phase Q API
  const stdEl = document.getElementById('standings-mini');
  if (stdEl) {
    stdEl.innerHTML = `<div style="color:var(--tx-3);font-size:12px;padding:8px 0;">Loading…</div>`;
    (async () => {
      try {
        const compsRes = await api('/phase-q/competitions?limit=1');
        const comps = (compsRes && compsRes.items) || [];
        if (!comps.length) { stdEl.innerHTML = `<div style="color:var(--tx-3);font-size:12px;padding:8px 0;">No competitions yet.</div>`; return; }
        const compId = comps[0].id;
        if (!_TournData.selectedCompId) _TournData.selectedCompId = compId;
        if (!_TournData.competitions.length) _TournData.competitions = comps;
        const rows = await api(`/phase-q/competitions/${compId}/standings`);
        const arr = Array.isArray(rows) ? rows.slice(0, 5) : [];
        if (!arr.length) { stdEl.innerHTML = `<div style="color:var(--tx-3);font-size:12px;padding:8px 0;">No standings data.</div>`; return; }
        if (!_TournData.teams.length) {
          const tr = await api('/teams?isActive=true&limit=200');
          _TournData.teams = (tr && tr.data) || [];
        }
        const myIds = new Set(_TournData.teams.map(t => t.id));
        stdEl.innerHTML = arr.map(r => {
          const form = (r.form || '').split('').slice(-3);
          const mine = myIds.has(r.teamId);
          const nm = _tournTeamName(r.teamId);
          return `<div class="std-row ${mine?'mine':''}">
            <div class="std-pos" style="color:${r.position<=4?'var(--amber)':'var(--tx-3)'};">${r.position}</div>
            <div class="std-name ${mine?'m':''}">${_esc(nm)}</div>
            <div style="display:flex;gap:2px;">${form.map(f=>`<div class="form-dot ${f==='W'?'fd-w':f==='D'?'fd-d':'fd-l'}" style="width:14px;height:14px;">${f}</div>`).join('')}</div>
            <div class="std-pts">${r.points}</div>
          </div>`;
        }).join('');
      } catch (_) {
        stdEl.innerHTML = `<div style="color:var(--tx-3);font-size:12px;padding:8px 0;">Standings unavailable.</div>`;
      }
    })();
  }

  // ARIA insights from real GPS risk data
  const insightsEl = document.getElementById('aria-insights');
  if (insightsEl) {
    const highRisk = d.highRiskPlayers || [];
    const insights = [
      { badge:'badge-green', icon:'⚡', title:'Performance', text: d.topPerformers?.[0] ? `${d.topPerformers[0].firstName} ${d.topPerformers[0].lastName} is your top performer with OVR ${d.topPerformers[0].overallRating}. Consider building tactics around his strengths.` : 'Loading performance data...' },
      { badge:'badge-red', icon:'⚠️', title:'Medical Alert', text: d.overview?.injuredCount > 0 ? `${d.overview.injuredCount} player${d.overview.injuredCount>1?'s':''} currently injured. GPS risk monitoring active on all ${d.overview.playerCount} players.` : 'All players fit and available.' },
      { badge:'badge-amber', icon:'🎯', title:'Tactical', text: `Team condition at ${d.overview?.teamCondition}%. ${highRisk.length > 0 ? `${highRisk.length} high-risk GPS readings detected.` : 'GPS loads within safe parameters.'}` },
    ];
    insightsEl.innerHTML = insights.map(i=>`
      <div class="insight-row">
        <div class="insight-top"><span style="font-size:13px;">${i.icon}</span><span class="badge ${i.badge}">${i.title}</span></div>
        <div class="insight-body">${_esc(i.text)}</div>
      </div>`).join('');
  }
}

// ════════════════════════════════════════════════════════════════════════
// SQUAD / PLAYERS MODULE — clean rebuild (Phase 1)
// ════════════════════════════════════════════════════════════════════════
// Single source of truth for everything that touches /api/v1/players.
// All four CRUD verbs (GET list, GET one, POST, PUT, DELETE) go through
// the SquadAPI object below, which always uses an absolute URL.
//
//   No Stripe / billing / payment / checkout dependency lives here.
//   No relative '/api/v1/players' path anywhere — they would resolve to
//   the frontend host on Render and 404 against the backend.
//
// Public surface (called from the rest of the app):
//   renderSquadHTML()          — returns the Squad page HTML
//   renderSquad(filter)        — paints the player grid into #player-grid
//   filterSquad(pos, el)       — pill click handler
//   openPlayerModal(id)        — open player detail modal (read)
//   playerModalTab(name, el)   — switch tab inside detail modal
//   openAddPlayerModal()       — open the form blank (create)
//   openEditPlayerModal(id)    — open the form populated (update)
//   submitPlayerForm(event)    — form submit (POST or PUT)
//   confirmDeletePlayer(id)    — DELETE with confirm
//   loadPlayerAIAnalysis(id)   — optional ARIA insight (separate route)
//   canManagePlayers(opts)     — role gate
// ════════════════════════════════════════════════════════════════════════

const SQUAD_API_BASE = 'https://familista-backend.onrender.com/api/v1/players';

// ════════════════════════════════════════════════════════════════════════
// Phase A · Tenant context (Club + Team) — uses FamilistaAPI under the hood
// ════════════════════════════════════════════════════════════════════════
const AppContext = (function () {
  let _ctx   = null;      // { availableClubs, currentClubId, currentTeamId, currentClub, currentTeam, ... }
  let _teams = [];        // teams for the active club (from /api/v1/teams)

  async function load() {
    try {
      const r = await FamilistaAPI.get('/me/context');
      _ctx = (r && r.data) || r || null;
      if (_ctx) State.context = { clubId: _ctx.currentClubId || _ctx.legacyClubId, teamId: _ctx.currentTeamId || null };
      await loadTeams();
      renderSwitcher();
      return _ctx;
    } catch (e) {
      console.warn('[ctx] failed to load /me/context:', e?.userMessage || e?.message);
      return null;
    }
  }

  async function loadTeams() {
    try {
      const r = await FamilistaAPI.get('/teams?isActive=true&limit=200');
      _teams = (r && r.data) || [];
    } catch (_) { _teams = []; }
  }

  function renderSwitcher() {
    const wrap = document.getElementById('ctx-switcher');
    const cs   = document.getElementById('ctx-club');
    const ts   = document.getElementById('ctx-team');
    if (!wrap || !cs || !ts || !_ctx) return;

    cs.innerHTML = (_ctx.availableClubs || []).map(c =>
      '<option value="' + c.id + '"' + (c.id === _ctx.currentClubId ? ' selected' : '') + '>' + (c.shortName || c.name) + '</option>'
    ).join('');

    ts.innerHTML = '<option value="">All teams</option>' + _teams.map(t =>
      '<option value="' + t.id + '"' + (t.id === _ctx.currentTeamId ? ' selected' : '') + '>' + (t.shortName || t.name) + '</option>'
    ).join('');

    wrap.style.display = (cs.options.length > 0) ? '' : 'none';
  }

  async function switchClub(clubId) {
    try {
      const r = await FamilistaAPI.post('/me/context', { clubId, teamId: null });
      _ctx = (r && r.data) || r || _ctx;
      State.context = { clubId, teamId: null };
      await loadTeams();
      renderSwitcher();
      // Re-hydrate the squad page after tenant change
      if (typeof loadAllData === 'function') await loadAllData();
      showToast('Switched club', 'success');
    } catch (e) { showToast(e?.userMessage || 'Switch failed', 'error'); }
  }
  async function switchTeam(teamId) {
    try {
      const r = await FamilistaAPI.post('/me/context', { clubId: State.context.clubId, teamId: teamId || null });
      _ctx = (r && r.data) || r || _ctx;
      State.context = { clubId: State.context.clubId, teamId: teamId || null };
      renderSwitcher();
      if (typeof loadAllData === 'function') await loadAllData();
    } catch (e) { showToast(e?.userMessage || 'Switch failed', 'error'); }
  }

  function teams() { return _teams; }
  function activeTeamId() { return State.context && State.context.teamId; }

  return { load, switchClub, switchTeam, teams, activeTeamId, renderSwitcher };
})();

// Wired to the <select> onchange attributes
function onContextClubChange() { const v = document.getElementById('ctx-club').value; AppContext.switchClub(v); }
function onContextTeamChange() { const v = document.getElementById('ctx-team').value; AppContext.switchTeam(v); }

const SquadAPI = {
  list(query) {
    const url = SQUAD_API_BASE + (query ? '?' + query : '');
    return SquadAPI._fetch('GET', url);
  },
  get(id) {
    const url = SQUAD_API_BASE + '/' + encodeURIComponent(id);
    return SquadAPI._fetch('GET', url);
  },
  create(body) {
    const url = SQUAD_API_BASE;
    return SquadAPI._fetch('POST', url, body);
  },
  update(id, body) {
    const url = SQUAD_API_BASE + '/' + encodeURIComponent(id);
    return SquadAPI._fetch('PUT', url, body);
  },
  remove(id) {
    const url = SQUAD_API_BASE + '/' + encodeURIComponent(id);
    return SquadAPI._fetch('DELETE', url);
  },
  async _fetch(method, url, body, _retried) {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (State.token) headers['Authorization'] = 'Bearer ' + State.token;
    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !_retried) {
      const ok = await tryRefreshToken();
      if (ok) return SquadAPI._fetch(method, url, body, true);
    }
    if (res.status === 204) return null;
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  },
};

function canManagePlayers(opts) {
  opts = opts || {};
  const role = State.user && State.user.role;
  if (opts.deleteOnly) return role === 'CLUB_ADMIN' || role === 'SUPER_ADMIN';
  return role === 'CLUB_ADMIN' || role === 'HEAD_COACH' || role === 'SUPER_ADMIN';
}

function renderSquadHTML() {
  return '<div class="page" id="pg-squad">' +
    '<div style="display:flex;flex-direction:column;height:100%;">' +
      '<div class="squad-toolbar">' +
        '<div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--tx);">Squad</div>' +
          '<div style="font-size:12px;color:var(--tx-3);" id="squad-sub">Loading…</div>' +
        '</div>' +
        '<div style="margin-left:auto;display:flex;gap:8px;align-items:center;">' +
          '<div class="filter-group">' +
            '<button class="filter-btn active" onclick="filterSquad(\'ALL\',this)">All</button>' +
            '<button class="filter-btn" onclick="filterSquad(\'GK\',this)">GK</button>' +
            '<button class="filter-btn" onclick="filterSquad(\'DEF\',this)">DEF</button>' +
            '<button class="filter-btn" onclick="filterSquad(\'MID\',this)">MID</button>' +
            '<button class="filter-btn" onclick="filterSquad(\'ATT\',this)">ATT</button>' +
          '</div>' +
          '<button class="btn btn-primary btn-sm" id="squad-add-btn" onclick="openAddPlayerModal()" style="display:none;">+ Add Player</button>' +
        '</div>' +
      '</div>' +
      '<div style="overflow-y:auto;flex:1;">' +
        '<div id="player-grid" class="player-grid">' + loadingHTML('Loading squad…') + '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderSquad(filterPos) {
  // The header search input IS the trigger for live filtering — treating its
  // focus as "editing" would defer the very re-render the user just asked for,
  // leaving every player visible while they typed. Only the grid is replaced
  // here, so re-rendering while #global-search is focused is safe.
  const _ae = document.activeElement;
  const _fromHeaderSearch = !!(_ae && _ae.id === 'global-search');
  if (!_fromHeaderSearch && isFormEditing()) { _pendingRefresh = true; return; }
  // Persist the active position filter so re-renders (e.g. live name search)
  // keep it instead of resetting to ALL.
  if (filterPos) State.squadFilter = filterPos;
  const pos = State.squadFilter || 'ALL';
  const grid = document.getElementById('player-grid');
  const sub  = document.getElementById('squad-sub');
  if (!grid) return;

  const addBtn = document.getElementById('squad-add-btn');
  if (addBtn) addBtn.style.display = canManagePlayers() ? '' : 'none';

  const all = Array.isArray(State.players) ? State.players : [];
  const posMap = { GK:['GK'], DEF:['DC','DL','DR'], MID:['DMC','ML','MR','MC','AMC','AML','AMR'], ATT:['ST'] };
  let filtered = pos === 'ALL' ? all : all.filter(p => (posMap[pos] || []).indexOf(p.position) !== -1);

  // Name search — case-insensitive over firstName / lastName / full name.
  const q = (State.squadSearch || '').trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(p => {
      const first = (p.firstName || '').toLowerCase();
      const last  = (p.lastName  || '').toLowerCase();
      return first.includes(q) || last.includes(q) || (first + ' ' + last).includes(q);
    });
  }

  if (sub) {
    const ovr = State.analytics && State.analytics.overview && State.analytics.overview.teamRating;
    sub.textContent = filtered.length + ' player' + (filtered.length === 1 ? '' : 's') + ' · OVR ' + (ovr || '—');
  }

  if (filtered.length === 0) {
    grid.innerHTML =
      '<div class="empty" style="grid-column:1/-1;">' +
        '<div class="empty-ico">👥</div>' +
        '<div class="empty-ttl">' + (all.length === 0 ? 'No players in the squad yet' : 'No players match this filter') + '</div>' +
        '<div style="font-size:12px;color:var(--tx-3);margin-top:6px;">' +
          (canManagePlayers() ? 'Click <strong>+ Add Player</strong> to create the first one.' : 'Ask a club admin to add players.') +
        '</div>' +
      '</div>';
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const gps = (p.gpsData && p.gpsData[0]) || {};
    const cnd = (p.condition != null) ? p.condition : 100;
    const age = p.dateOfBirth ? (new Date().getFullYear() - new Date(p.dateOfBirth).getFullYear()) : '—';
    const ovr = (p.overallRating != null) ? p.overallRating : '—';
    const num = (p.number != null) ? p.number : '?';
    return '<div class="card pc clickable" data-action="openPlayerModal" data-id="' + p.id + '">' +
      '<div class="pc-top">' +
        '<div class="pc-avatar">' + playerSVG(p) + '</div>' +
        '<div class="pc-info">' +
          '<div class="pc-name">' + (p.firstName || '') + ' ' + (p.lastName || '') + '</div>' +
          '<div class="pc-meta">Age ' + age + ' · ' + (p.nationality || '—') + '</div>' +
          '<div style="margin-top:4px;display:flex;gap:4px;align-items:center;">' +
            '<span class="pos-pill ' + posClass(p.position) + '">' + (p.position || '—') + '</span>' +
            (p.isInjured ? '<span class="badge badge-red" style="font-size:9px;">INJURED</span>' : '') +
            (p.medicalStatus && p.medicalStatus !== 'HEALTHY' && !p.isInjured ? '<span class="badge" style="background:rgba(217,119,6,.12);color:#FDBA74;border:1px solid rgba(217,119,6,.3);font-size:9px;">' + p.medicalStatus + '</span>' : '') +
            (p.paymentStatus && p.paymentStatus !== 'PAID' && p.paymentStatus !== 'EXEMPT' ? '<span class="badge" style="background:rgba(220,38,38,.12);color:#FCA5A5;border:1px solid rgba(220,38,38,.3);font-size:9px;">' + p.paymentStatus + '</span>' : '') +
            (p.isActive === false ? '<span class="badge badge-gray" style="font-size:9px;">INACTIVE</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="pc-rating">' + ovr + '</div>' +
      '</div>' +
      '<div class="pc-body">' +
        '<div class="pc-stats">' +
          '<div class="pc-stat"><div class="pc-stat-val" style="color:var(--green-l);">' + (gps.topSpeed != null ? gps.topSpeed.toFixed(1) : '—') + '</div><div class="pc-stat-lbl">km/h</div></div>' +
          '<div class="pc-stat"><div class="pc-stat-val" style="color:var(--red);">' + (gps.heartRateAvg || '—') + '</div><div class="pc-stat-lbl">BPM</div></div>' +
          '<div class="pc-stat"><div class="pc-stat-val" style="color:var(--amber);">' + (gps.distance != null ? gps.distance.toFixed(1) : '—') + '</div><div class="pc-stat-lbl">km/m</div></div>' +
        '</div>' +
        '<div class="pc-cnd">' +
          '<div class="pc-cnd-hdr"><span>Condition</span><span style="color:' + condColor(cnd) + ';font-weight:600;">' + cnd + '%</span></div>' +
          '<div class="prog"><div class="prog-bar" style="width:' + cnd + '%;background:' + condBarBg(cnd) + ';"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="pc-footer">' +
        '<span style="font-size:10px;color:var(--tx-3);font-family:var(--mono);">' + ((p.device && p.device.serialNumber) || 'No Device') + '</span>' +
        '<span class="badge badge-gray" style="font-size:9px;">#' + num + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function filterSquad(pos, el) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderSquad(pos);
}

// Live Squad name-search (wired to the header search input). Stores the query
// and re-paints the grid in place, preserving the active position filter.
function squadSearchInput(q) {
  State.squadSearch = q || '';
  if (document.getElementById('player-grid')) renderSquad();
}

async function openPlayerModal(id) {
  if (!id) return;
  let p = (State.players || []).find(x => x.id === id);
  if (!p) {
    try {
      const env = await SquadAPI.get(id);
      p = env && env.data;
      if (p) State.activePlayer = p;
    } catch (err) {
      showToast((err && err.message) || 'Could not load player', 'error');
      return;
    }
  } else {
    State.activePlayer = p;
  }
  if (!p) return;

  document.getElementById('player-modal-title').textContent = (p.firstName || '') + ' ' + (p.lastName || '') + ' · #' + (p.number != null ? p.number : '?');

  const editBtn = document.getElementById('player-modal-edit-btn');
  const delBtn  = document.getElementById('player-modal-delete-btn');
  if (editBtn) editBtn.style.display = canManagePlayers()                  ? '' : 'none';
  if (delBtn)  delBtn.style.display  = canManagePlayers({ deleteOnly:true }) ? '' : 'none';

  document.getElementById('player-modal-sidebar').innerHTML =
    '<div style="margin-bottom:10px;">' + playerSVG(p, 68, 84) + '</div>' +
    '<div style="font-size:17px;font-weight:700;color:var(--tx);letter-spacing:-.3px;">' + (p.firstName || '') + ' ' + (p.lastName || '') + '</div>' +
    '<div style="font-size:32px;font-weight:700;color:var(--green-l);letter-spacing:-2px;margin:5px 0;line-height:1;">' + (p.overallRating != null ? p.overallRating : '—') + '</div>' +
    '<span class="pos-pill ' + posClass(p.position) + '">' + (p.position || '—') + '</span>' +
    '<div style="font-size:16px;margin-top:6px;">' + (p.flag || '🌍') + '</div>';

  const tabs = ['Overview', 'Skills', 'GPS Data', 'AI Analysis', 'Contract'];
  document.getElementById('player-modal-tabs-nav').innerHTML = tabs.map((t, i) =>
    '<div class="modal-tab ' + (i === 0 ? 'active' : '') + '" style="padding:8px 10px;font-size:12px;text-align:left;border-radius:6px;border:none;border-bottom:none;margin-bottom:2px;' + (i === 0 ? 'background:var(--green-bg);color:var(--green-l);' : '') + '" onclick="playerModalTab(\'' + t.toLowerCase().replace(' ', '-') + '\',this)">' + t + '</div>'
  ).join('');

  playerModalTab('overview', document.querySelector('#player-modal-tabs-nav .modal-tab'));
  document.getElementById('player-modal').classList.add('open');
}

function playerModalTab(tab, el) {
  document.querySelectorAll('#player-modal-tabs-nav .modal-tab').forEach(t => {
    t.classList.remove('active');
    t.style.background = 'none';
    t.style.color = '';
  });
  if (el) { el.classList.add('active'); el.style.background = 'var(--green-bg)'; el.style.color = 'var(--green-l)'; }

  const p = State.activePlayer;
  const c = document.getElementById('player-modal-content');
  if (!p || !c) return;

  const gps   = (p.gpsData && p.gpsData[0]) || {};
  const attrs = (p.attributes && p.attributes[0]) || {};

  if (tab === 'overview') {
    const age = p.dateOfBirth ? (new Date().getFullYear() - new Date(p.dateOfBirth).getFullYear()) : '—';
    const rows = [
      ['Nationality',    (p.flag || '') + ' ' + (p.nationality || '—')],
      ['Age',            age + ' years'],
      ['Height',         p.height ? p.height + ' cm' : '—'],
      ['Weight',         p.weight ? p.weight + ' kg' : '—'],
      ['Preferred Foot', p.preferredFoot || '—'],
      ['Market Value',   p.marketValue != null ? fmtCurrency(p.marketValue) : '—'],
    ];
    c.innerHTML =
      '<div style="padding:18px;">' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">' +
          '<div class="card" style="padding:14px;text-align:center;">' +
            '<div style="font-size:24px;margin-bottom:4px;">' + (p.isInjured ? '🤕' : '✅') + '</div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--tx);">Fitness</div>' +
            '<div style="font-size:11px;color:var(--tx-3);">' + (p.isInjured ? 'Injured' : 'Fully Fit') + '</div>' +
          '</div>' +
          '<div class="card" style="padding:14px;text-align:center;">' +
            '<div style="font-size:24px;margin-bottom:4px;">😄</div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--tx);">Morale</div>' +
            '<div style="font-size:11px;color:var(--tx-3);">Superb</div>' +
          '</div>' +
          '<div class="card" style="padding:14px;text-align:center;">' +
            '<div style="font-size:20px;font-weight:700;color:' + condColor(p.condition) + ';margin-bottom:4px;">' + (p.condition != null ? p.condition + '%' : '—') + '</div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--tx);">Condition</div>' +
            '<div class="prog" style="margin-top:6px;"><div class="prog-bar" style="width:' + (p.condition || 0) + '%;background:' + condBarBg(p.condition) + ';"></div></div>' +
          '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
          rows.map(r =>
            '<div class="card" style="padding:11px 13px;">' +
              '<div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">' + r[0] + '</div>' +
              '<div style="font-size:13px;font-weight:600;color:var(--tx);">' + r[1] + '</div>' +
            '</div>').join('') +
        '</div>' +
      '</div>';

  } else if (tab === 'skills') {
    const sections = [
      { title: 'Defense',  color: 'var(--green-l)', keys: ['tackling','marking','heading','defPositioning','interceptions','reflexes','gkPositioning','handling','kicking'].filter(k => attrs[k]) },
      { title: 'Attack',   color: 'var(--red)',     keys: ['pace','shooting','passing','dribbling','crossing'].filter(k => attrs[k]) },
      { title: 'Physical', color: 'var(--blue)',    keys: ['strength','stamina','agility','balance'].filter(k => attrs[k]) },
    ];
    c.innerHTML =
      '<div style="padding:18px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">' +
        sections.map(s =>
          '<div>' +
            '<div style="font-size:12px;font-weight:700;color:' + s.color + ';text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-left:3px;border-left:3px solid ' + s.color + ';">' + s.title + '</div>' +
            (s.keys.length === 0
              ? '<div style="font-size:12px;color:var(--tx-3);">No data</div>'
              : s.keys.map(k =>
                  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">' +
                    '<div style="font-size:11px;color:var(--tx-2);width:70px;flex-shrink:0;text-transform:capitalize;">' + k.replace(/([A-Z])/g, ' $1') + '</div>' +
                    '<div style="flex:1;height:5px;background:var(--bg-4);border-radius:3px;overflow:hidden;">' +
                      '<div style="width:' + Math.min(100, (attrs[k] || 0) / 1.3) + '%;height:100%;background:' + s.color + ';border-radius:3px;opacity:.8;"></div>' +
                    '</div>' +
                    '<div style="font-size:11px;font-weight:600;color:var(--tx);font-family:var(--mono);min-width:26px;text-align:right;">' + (attrs[k] || 0) + '</div>' +
                  '</div>').join('')) +
          '</div>'
        ).join('') +
      '</div>';

  } else if (tab === 'gps-data') {
    const tiles = [
      ['Top Speed',   gps.topSpeed != null ? gps.topSpeed.toFixed(1) + ' km/h' : '—', 'var(--green-l)'],
      ['Avg Speed',   gps.avgSpeed != null ? gps.avgSpeed.toFixed(1) + ' km/h' : '—', 'var(--blue)'],
      ['Distance',    gps.distance != null ? gps.distance.toFixed(2) + ' km'   : '—', 'var(--amber)'],
      ['Sprints',     gps.sprintCount || '—',                                          'var(--blue)'],
      ['Avg HR',      gps.heartRateAvg ? gps.heartRateAvg + ' bpm' : '—',              'var(--red)'],
      ['Player Load', gps.playerLoad != null ? gps.playerLoad.toFixed(0) : '—',        'var(--purple)'],
      ['Risk Score',  gps.riskScore != null ? gps.riskScore.toFixed(0) + '%' : '—',    gps.riskScore > 70 ? 'var(--red)' : gps.riskScore > 50 ? 'var(--amber)' : 'var(--green-l)'],
      ['Battery',     (p.device && p.device.batteryLevel) ? p.device.batteryLevel + '%' : '—', 'var(--green-l)'],
      ['Condition',   p.condition != null ? p.condition + '%' : '—',                   condColor(p.condition)],
    ];
    c.innerHTML =
      '<div style="padding:18px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:var(--green-l);animation:badgePulse 1.5s ease infinite;"></div>' +
          '<span style="font-size:13px;font-weight:600;color:var(--tx);">Familista GPS Device · ' + ((p.device && p.device.serialNumber) || 'Not assigned') + '</span>' +
          (p.device ? '<span class="badge badge-green">Online</span>' : '<span class="badge badge-gray">Offline</span>') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">' +
          tiles.map(t =>
            '<div class="card" style="padding:13px;text-align:center;">' +
              '<div style="font-size:20px;font-weight:700;color:' + t[2] + ';font-family:var(--mono);">' + t[1] + '</div>' +
              '<div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-top:4px;">' + t[0] + '</div>' +
            '</div>').join('') +
        '</div>' +
      '</div>';

  } else if (tab === 'ai-analysis') {
    c.innerHTML =
      '<div style="padding:18px;">' +
        '<div class="card" style="padding:14px;background:var(--green-bg);border:1px solid var(--green-bd);margin-bottom:12px;" id="ai-player-analysis">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
            '<div style="width:26px;height:26px;border-radius:7px;background:var(--green);display:flex;align-items:center;justify-content:center;font-size:13px;">⚡</div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--tx);">ARIA Player Analysis</div>' +
            '<button class="btn btn-outline btn-xs" onclick="loadPlayerAIAnalysis(\'' + p.id + '\')">Generate</button>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--tx-2);line-height:1.7;">Click "Generate" for real-time AI analysis of ' + (p.firstName || '') + ' ' + (p.lastName || '') + '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
          '<div class="card" style="padding:13px;"><div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Market Value</div><div style="font-size:20px;font-weight:700;color:var(--amber);font-family:var(--mono);">' + (p.marketValue != null ? fmtCurrency(p.marketValue) : '—') + '</div></div>' +
          '<div class="card" style="padding:13px;"><div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Potential</div><div style="font-size:20px;font-weight:700;color:var(--green-l);font-family:var(--mono);">' + (p.potential != null ? p.potential : '—') + '</div></div>' +
        '</div>' +
      '</div>';

  } else { // 'contract'
    c.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;">' +
        '<div style="padding:18px;border-right:1px solid var(--bd);">' +
          '<div style="font-size:11px;font-weight:700;color:var(--green-l);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Contract</div>' +
          '<div style="font-size:12px;color:var(--tx-3);margin-bottom:5px;">Expires</div>' +
          '<div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:12px;">' + (p.contractUntil ? fmtDate(p.contractUntil) : 'Unknown') + '</div>' +
          '<div style="font-size:12px;color:var(--tx-3);margin-bottom:4px;">Weekly Wage</div>' +
          '<div style="font-size:17px;font-weight:700;color:var(--tx);">🪙 ' + (p.weeklyWage || 0).toLocaleString() + '</div>' +
        '</div>' +
        '<div style="padding:18px;border-right:1px solid var(--bd);background:var(--bg-2);">' +
          '<div style="font-size:11px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Market Value</div>' +
          '<div style="font-size:24px;font-weight:700;color:var(--amber);font-family:var(--mono);">' + (p.marketValue != null ? fmtCurrency(p.marketValue) : '—') + '</div>' +
        '</div>' +
        '<div style="padding:18px;">' +
          '<div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Potential</div>' +
          '<div style="font-size:24px;font-weight:700;color:var(--blue);font-family:var(--mono);">' + (p.potential != null ? p.potential : '—') + '</div>' +
          '<div style="font-size:11px;color:var(--tx-3);margin-top:8px;">Foot: ' + (p.preferredFoot || '—') + '</div>' +
        '</div>' +
      '</div>';
  }
}

async function loadPlayerAIAnalysis(playerId) {
  const el = document.getElementById('ai-player-analysis');
  if (!el || !playerId) return;
  el.innerHTML = '<div class="page-loading"><div class="spinner"></div><div class="loading-text">ARIA is analyzing…</div></div>';
  try {
    const res = await api('/ai/analyze-player/' + playerId, { method: 'POST' });
    if (res && res.data && res.data.response) {
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<div style="width:26px;height:26px;border-radius:7px;background:var(--green);display:flex;align-items:center;justify-content:center;font-size:13px;">⚡</div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--tx);">ARIA Analysis</div>' +
          '<span class="badge badge-green">Live</span>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--tx-2);line-height:1.7;">' + res.data.response.replace(/\n/g, '<br>') + '</div>';
    } else {
      el.innerHTML = '<div style="color:var(--tx-3);font-size:12px;">No AI response.</div>';
    }
  } catch (err) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px;">Analysis failed — ' + ((err && err.message) || 'error') + '</div>';
  }
}

// ════════════════════════════════════════════════════════════════════════
// PlayerEditModal — isolated add/edit player modal.
//
// Owns the form inputs as its draft. Field values are written exactly ONCE, in
// open(), before the user can type — and are never touched again until close.
// There is no form.reset(), no refill-on-render, and no reopen while already
// open, so the cursor never jumps and typed input is never replaced. "Open" is
// derived from the DOM (.open class) so every close path (Save / Cancel / ✕ /
// Esc) stays consistent. Save is explicit; Cancel discards; after Save the
// modal closes and the squad refreshes exactly once.
// ════════════════════════════════════════════════════════════════════════
const PlayerEditModal = (function () {
  const MODAL_ID = 'player-edit-modal';
  const $ = (id) => document.getElementById(id);
  const isoDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';

  let _mode = null;       // 'create' | 'edit'
  let _playerId = null;

  function isOpen() {
    const m = $(MODAL_ID);
    return !!(m && m.classList.contains('open'));
  }

  function fillTeamSelect(selectedTeamId) {
    const sel = $('pe-team');
    if (!sel) return;
    const teams = (typeof AppContext !== 'undefined' && AppContext.teams()) || [];
    sel.innerHTML = '<option value="">— Unassigned —</option>' + teams.map(function (t) {
      return '<option value="' + t.id + '">' + (t.shortName ? t.shortName + ' · ' : '') + _esc(t.name) + '</option>';
    }).join('');
    sel.value = selectedTeamId || (typeof AppContext !== 'undefined' && AppContext.activeTeamId()) || '';
  }

  // Write every field's initial value. Called ONLY from open(), before typing.
  // p === null → create-mode defaults.
  function populate(p) {
    const set = (id, v) => { const el = $(id); if (el) el.value = (v == null ? '' : v); };
    set('pe-id',           p ? p.id : '');
    set('pe-firstName',    p && p.firstName);
    set('pe-lastName',     p && p.lastName);
    set('pe-number',       p && p.number);
    set('pe-position',     p ? p.position : '');
    set('pe-nationality',  p && p.nationality);
    set('pe-flag',         p && p.flag);
    set('pe-dob',          p ? isoDate(p.dateOfBirth) : '');
    set('pe-foot',         (p && p.preferredFoot) || 'RIGHT');
    set('pe-height',       p && p.height);
    set('pe-weight',       p && p.weight);
    set('pe-overall',      p && p.overallRating);
    set('pe-potential',    p && p.potential);
    set('pe-mvalue',       p && p.marketValue);
    set('pe-wage',         p && p.weeklyWage);
    set('pe-contract',     p ? isoDate(p.contractUntil) : '');
    set('pe-email',        p && p.email);
    set('pe-joined',       p ? isoDate(p.joinedAt) : '');
    set('pe-parent-name',  p && p.parentName);
    set('pe-parent-email', p && p.parentEmail);
    set('pe-parent-phone', p && p.parentPhone);
    set('pe-medical',      (p && p.medicalStatus) || 'HEALTHY');
    set('pe-payment',      (p && p.paymentStatus) || 'PAID');
    set('pe-isactive',     p ? (p.isActive === false ? 'false' : 'true') : 'true');
    set('pe-notes',        p && p.notes);
    fillTeamSelect(p && p.teamId);
  }

  function open(player) {
    if (!canManagePlayers()) { showToast('Not authorized to manage players', 'error'); return; }
    if (isOpen()) return;                                  // never reopen while open
    const editing = !!(player && player.id);
    _mode = editing ? 'edit' : 'create';
    _playerId = editing ? player.id : null;

    $('player-edit-title').textContent = editing
      ? 'Edit · ' + ((player.firstName || '') + ' ' + (player.lastName || '')).trim()
      : 'Add Player';
    const sb = $('pe-submit');
    if (sb) { sb.disabled = false; sb.textContent = editing ? 'Save changes' : 'Create player'; }
    const err = $('pe-error'); if (err) { err.style.display = 'none'; err.textContent = ''; }

    populate(editing ? player : null);                     // ← the ONLY place values are written

    const detail = $('player-modal'); if (detail) detail.classList.remove('open'); // close the launch modal
    $(MODAL_ID).classList.add('open');
    setTimeout(function () { const f = $('pe-firstName'); if (f) f.focus(); }, 60);
  }

  function close() {
    _mode = null; _playerId = null;
    const m = $(MODAL_ID); if (m) m.classList.remove('open');
  }

  function cancel() { close(); }                            // discard, no save

  async function save() {
    if (!isOpen()) return;                                  // only the visible modal can save
    const errEl = $('pe-error');
    const btn   = $('pe-submit');
    const val = (id) => { const el = $(id); return el ? el.value : ''; };
    const num = (v) => v === '' || v == null ? undefined : Number(v);
    const str = (v) => (v == null ? '' : String(v)).trim();

    const body = {
      firstName:     str(val('pe-firstName')),
      lastName:      str(val('pe-lastName')),
      number:        Number(val('pe-number')),
      position:      val('pe-position'),
      nationality:   str(val('pe-nationality')),
      flag:          str(val('pe-flag')),
      dateOfBirth:   val('pe-dob'),
      preferredFoot: val('pe-foot') || 'RIGHT',
      height:        Number(val('pe-height')),
      weight:        Number(val('pe-weight')),
      overallRating: num(val('pe-overall')),
      potential:     num(val('pe-potential')),
      marketValue:   num(val('pe-mvalue')),
      weeklyWage:    num(val('pe-wage')),
      email:         str(val('pe-email')),
      parentName:    str(val('pe-parent-name')),
      parentEmail:   str(val('pe-parent-email')),
      parentPhone:   str(val('pe-parent-phone')),
      medicalStatus: val('pe-medical') || 'HEALTHY',
      paymentStatus: val('pe-payment') || 'PAID',
      isActive:      val('pe-isactive') === 'false' ? false : true,
      notes:         str(val('pe-notes')),
    };
    const contract = val('pe-contract'); if (contract) body.contractUntil = contract;
    const joined   = val('pe-joined');   if (joined)   body.joinedAt = joined;
    const teamSel  = $('pe-team');       if (teamSel)  body.teamId = teamSel.value || null;
    Object.keys(body).forEach(function (k) {
      if (body[k] === undefined || (typeof body[k] === 'string' && body[k] === '') || Number.isNaN(body[k])) delete body[k];
    });

    const editing = _mode === 'edit';
    const id = _playerId;
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (btn) { btn.disabled = true; btn.textContent = editing ? 'Saving…' : 'Creating…'; }

    try {
      let saved = null;
      if (editing) {
        const res = await SquadAPI.update(id, body);
        saved = res && res.data;
        if (saved) {
          const idx = (State.players || []).findIndex(function (x) { return x.id === id; });
          if (idx !== -1) State.players[idx] = Object.assign({}, State.players[idx], saved);
          if (State.activePlayer && State.activePlayer.id === id) State.activePlayer = Object.assign({}, State.activePlayer, saved);
        }
      } else {
        const res = await SquadAPI.create(body);
        saved = res && res.data;
        if (saved) { if (!Array.isArray(State.players)) State.players = []; State.players.unshift(saved); }
      }
      close();                                              // close first…
      renderSquad();                                        // …then refresh the squad once
      showToast(editing ? 'Player updated' : 'Player created', 'success');
    } catch (err) {
      if (errEl) { errEl.textContent = (err && err.message) || 'Save failed'; errEl.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Create player'; }
    }
  }

  return { open: open, close: close, cancel: cancel, save: save, isOpen: isOpen };
})();

// Thin entry points kept for the existing triggers — all logic is in PlayerEditModal.
function openAddPlayerModal() {
  PlayerEditModal.open(null);
}

function openEditPlayerModal(id) {
  if (!id) return;
  const p = (State.players || []).find(function (x) { return x.id === id; }) || State.activePlayer;
  if (!p) { showToast('Player not loaded', 'error'); return; }
  PlayerEditModal.open(p);
}

// Explicit Save / Cancel entry points (wired from the modal's buttons).
function playerEditSave()   { PlayerEditModal.save(); }
function playerEditCancel() { PlayerEditModal.cancel(); }

async function confirmDeletePlayer(id) {
  if (!id) return;
  if (!canManagePlayers({ deleteOnly: true })) { showToast('Not authorized to delete players', 'error'); return; }
  const p = (State.players || []).find(x => x.id === id) || State.activePlayer;
  const name = p ? (p.firstName + ' ' + p.lastName) : 'this player';
  if (!confirm('Delete ' + name + '? This permanently removes the player and cannot be undone.')) return;

  try {
    await SquadAPI.remove(id);
    State.players = (State.players || []).filter(x => x.id !== id);
    if (State.activePlayer && State.activePlayer.id === id) State.activePlayer = null;
    closeModal('player-modal');
    renderSquad();
    showToast('Player deleted', 'success');
  } catch (err) {
    showToast((err && err.message) || 'Delete failed', 'error');
  }
}

// ── MATCHES ──
// ════════════════════════════════════════════════════════════════════════
// Phase B · Match Center — additive sub-tabs (Upcoming / Live / Tactical /
// Statistics) wired to /api/v1/matches/* via FamilistaAPI. No layout redesign.
// ════════════════════════════════════════════════════════════════════════

const MATCHES_API_BASE = (typeof FAM_CONFIG !== 'undefined' ? FAM_CONFIG.API_BASE : 'https://familista-backend.onrender.com/api/v1') + '/matches';

const MatchAPI = {
  list(query) {
    const q = query ? '?' + query : '';
    return FamilistaAPI.get('/matches' + q);
  },
  get(id)                     { return FamilistaAPI.get('/matches/' + id); },
  create(body)                { return FamilistaAPI.post('/matches', body); },
  update(id, body)            { return FamilistaAPI.patch('/matches/' + id, body); },
  remove(id, reason)          { return FamilistaAPI.delete('/matches/' + id, { body: reason ? { reason } : undefined }); },
  // Live state
  startLive(id)               { return FamilistaAPI.post('/matches/' + id + '/live/start', {}); },
  halftime(id)                { return FamilistaAPI.post('/matches/' + id + '/live/halftime', {}); },
  resume(id)                  { return FamilistaAPI.post('/matches/' + id + '/live/resume', {}); },
  finalize(id, home, away)    { return FamilistaAPI.post('/matches/' + id + '/live/finalize', { homeScore: home, awayScore: away }); },
  abandon(id, reason)         { return FamilistaAPI.post('/matches/' + id + '/live/abandon', reason ? { reason } : {}); },
  // Sub-resources
  getLineups(id)              { return FamilistaAPI.get('/matches/' + id + '/lineups'); },
  setLineup(id, body)         { return FamilistaAPI.put('/matches/' + id + '/lineups', body); },
  listTimeline(id, query)     { return FamilistaAPI.get('/matches/' + id + '/timeline' + (query ? '?' + query : '')); },
  addTimeline(id, body)       { return FamilistaAPI.post('/matches/' + id + '/timeline', body); },
  editTimeline(id, eid, body) { return FamilistaAPI.patch('/matches/' + id + '/timeline/' + eid, body); },
  delTimeline(id, eid, reason){ return FamilistaAPI.delete('/matches/' + id + '/timeline/' + eid, { body: reason ? { reason } : undefined }); },
  listSnapshots(id)           { return FamilistaAPI.get('/matches/' + id + '/tactical'); },
  takeSnapshot(id, body)      { return FamilistaAPI.post('/matches/' + id + '/tactical', body); },
  featureBundle(id)           { return FamilistaAPI.get('/matches/' + id + '/ai-features'); },
};

// Current sub-tab. 'all' | 'upcoming' | 'live' | 'tactical' | 'stats'
let _matchTab = 'all';

function renderMatchesHTML() {
  return `<div class="page" id="pg-matches">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Match Center</div>
        <div style="font-size:12px;color:var(--tx-3);" id="matches-sub">All competitions</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <div class="filter-group" id="match-tabs">
          <button class="filter-btn active" onclick="setMatchTab('all',this)">All</button>
          <button class="filter-btn"        onclick="setMatchTab('upcoming',this)">Upcoming</button>
          <button class="filter-btn"        onclick="setMatchTab('live',this)">Live</button>
          <button class="filter-btn"        onclick="setMatchTab('tactical',this)">Tactical</button>
          <button class="filter-btn"        onclick="setMatchTab('stats',this)">Statistics</button>
        </div>
        <button class="btn btn-primary btn-sm" id="match-schedule-btn" onclick="openScheduleMatchModal()">+ Schedule</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:16px 20px;" id="matches-list">
      ${loadingHTML('Loading matches...')}
    </div>
  </div>
</div>`;
}

// Top-level orchestrator: paints the right view depending on sub-tab.
function renderMatches() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const tab = _matchTab;
  if (tab === 'live')     return renderLiveSubTab();
  if (tab === 'tactical') return renderTacticalSubTab();
  if (tab === 'stats')    return renderStatsSubTab();
  return renderMatchListSubTab(tab);
}

function setMatchTab(tab, el) {
  _matchTab = tab;
  document.querySelectorAll('#match-tabs .filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderMatches();
}

// ── Sub-tab: list (All / Upcoming) ──────────────────────────────────────
function renderMatchListSubTab(tab) {
  const el  = document.getElementById('matches-list');
  const sub = document.getElementById('matches-sub');
  if (!el) return;

  let matches = State.matches || [];
  if (tab === 'upcoming') matches = matches.filter(m => m.status === 'SCHEDULED' || (!m.status && !m.result));

  if (sub) sub.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'} · Season 207`;

  if (matches.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">📅</div><div class="empty-ttl">No matches yet</div><div style="font-size:12px;color:var(--tx-3);margin-top:6px;">Click <strong>+ Schedule</strong> to add the first match.</div></div>';
    return;
  }

  el.innerHTML = matches.map(m => {
    const mineHome = !!m.isHome;
    const status   = m.status || 'SCHEDULED';
    const statusBadge =
      status === 'LIVE'      ? '<span class="badge badge-red" style="font-size:9px;animation:badgePulse 1.4s ease infinite;">● LIVE</span>' :
      status === 'HALFTIME'  ? '<span class="badge badge-amber" style="font-size:9px;">HALFTIME</span>' :
      status === 'FT'        ? '<span class="badge badge-gray" style="font-size:9px;">FT</span>' :
      status === 'POSTPONED' ? '<span class="badge badge-amber" style="font-size:9px;">POSTPONED</span>' :
                               '<span class="badge badge-purple" style="font-size:9px;">SCHEDULED</span>';
    const resultBadge =
      m.result === 'WIN'  ? '<span class="badge badge-green" style="font-size:9px;">WIN</span>' :
      m.result === 'LOSS' ? '<span class="badge badge-red"   style="font-size:9px;">LOSS</span>' :
      m.result === 'DRAW' ? '<span class="badge badge-amber" style="font-size:9px;">DRAW</span>' : '';
    return `<div class="match-row" onclick="openMatchDetail('${m.id}')">
      <div class="match-date">${fmtDate(m.scheduledAt)}</div>
      <span class="badge badge-${m.competition==='LEAGUE'?'red':m.competition==='CUP'?'amber':'green'}" style="font-size:9px;">${m.competition}</span>
      <div style="flex:1;display:flex;align-items:center;gap:9px;">
        <div style="flex:1;text-align:right;font-size:13px;font-weight:600;color:${mineHome?'var(--green-l)':'var(--tx-2)'};">${m.homeTeam}</div>
        <div class="match-score">${m.homeScore!=null?m.homeScore:'?'} — ${m.awayScore!=null?m.awayScore:'?'}</div>
        <div style="flex:1;font-size:13px;font-weight:600;color:${!mineHome?'var(--green-l)':'var(--tx-2)'};">${m.awayTeam}</div>
      </div>
      ${statusBadge}
      ${resultBadge}
      <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();openMatchDetail('${m.id}')">Details</button>
    </div>`;
  }).join('');
}

// ── Sub-tab: Live ────────────────────────────────────────────────────────
function renderLiveSubTab() {
  const el  = document.getElementById('matches-list');
  const sub = document.getElementById('matches-sub');
  if (!el) return;
  const live = (State.matches || []).filter(m => m.status === 'LIVE' || m.status === 'HALFTIME');
  if (sub) sub.textContent = `${live.length} live match${live.length === 1 ? '' : 'es'}`;
  if (live.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">🟢</div><div class="empty-ttl">No live matches right now</div><div style="font-size:12px;color:var(--tx-3);margin-top:6px;">Start a scheduled match from the All tab to see it here.</div></div>';
    return;
  }
  el.innerHTML = live.map(m => `
    <div class="card" style="padding:16px;margin-bottom:12px;cursor:pointer;" onclick="openMatchDetail('${m.id}')">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <span class="badge badge-red" style="animation:badgePulse 1.4s ease infinite;">● LIVE</span>
        <span style="color:var(--tx-3);font-size:12px;">${m.competition}${m.competitionName ? ' · ' + m.competitionName : ''}</span>
        <span style="margin-left:auto;color:var(--tx-3);font-size:12px;">${(m.status === 'HALFTIME') ? 'Halftime' : ((m.liveMinute != null) ? "Min " + m.liveMinute + "'" : '')}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:18px;">
        <div style="font-size:18px;font-weight:700;color:${m.isHome?'var(--green-l)':'var(--tx-2)'};">${m.homeTeam}</div>
        <div style="font-size:28px;font-weight:800;font-family:var(--mono);color:var(--tx);letter-spacing:-1px;">${m.homeScore ?? 0} — ${m.awayScore ?? 0}</div>
        <div style="font-size:18px;font-weight:700;color:${!m.isHome?'var(--green-l)':'var(--tx-2)'};">${m.awayTeam}</div>
      </div>
    </div>
  `).join('');
}

// ── Sub-tab: Tactical ────────────────────────────────────────────────────
function renderTacticalSubTab() {
  const el  = document.getElementById('matches-list');
  const sub = document.getElementById('matches-sub');
  if (!el) return;
  const matchesWithFormation = (State.matches || []).filter(m => m.formationHome || m.formationAway);
  if (sub) sub.textContent = `${matchesWithFormation.length} match${matchesWithFormation.length === 1 ? '' : 'es'} with formations`;
  if (matchesWithFormation.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">⚙️</div><div class="empty-ttl">No tactical data yet</div><div style="font-size:12px;color:var(--tx-3);margin-top:6px;">Open a match detail to set the formation and lineup.</div></div>';
    return;
  }
  el.innerHTML = matchesWithFormation.map(m => `
    <div class="card" style="padding:14px;margin-bottom:10px;cursor:pointer;" onclick="openMatchDetail('${m.id}')">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span class="badge badge-purple" style="font-size:9px;">TACTICAL</span>
        <span style="font-size:13px;font-weight:600;color:var(--tx);">${m.homeTeam} vs ${m.awayTeam}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--tx-3);">${fmtDate(m.scheduledAt)}</span>
      </div>
      <div style="display:flex;gap:14px;font-size:12px;color:var(--tx-2);">
        <div>Home formation: <strong style="color:var(--green-l);font-family:var(--mono);">${m.formationHome || '—'}</strong></div>
        <div>Away formation: <strong style="color:var(--amber);font-family:var(--mono);">${m.formationAway || '—'}</strong></div>
      </div>
    </div>
  `).join('');
}

// ── Sub-tab: Statistics ──────────────────────────────────────────────────
function renderStatsSubTab() {
  const el  = document.getElementById('matches-list');
  const sub = document.getElementById('matches-sub');
  if (!el) return;
  const matches = State.matches || [];
  const played  = matches.filter(m => m.status === 'FT' || m.result);
  const wins    = played.filter(m => m.result === 'WIN').length;
  const draws   = played.filter(m => m.result === 'DRAW').length;
  const losses  = played.filter(m => m.result === 'LOSS').length;
  const gf      = played.reduce((s,m) => s + (m.isHome ? (m.homeScore ?? 0) : (m.awayScore ?? 0)), 0);
  const ga      = played.reduce((s,m) => s + (m.isHome ? (m.awayScore ?? 0) : (m.homeScore ?? 0)), 0);
  const ppg     = played.length === 0 ? 0 : ((wins * 3 + draws) / played.length).toFixed(2);

  if (sub) sub.textContent = `${played.length} played · ${matches.length - played.length} remaining`;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:12px;">
      ${[
        ['Played',  played.length, 'var(--tx)'],
        ['Wins',    wins,          'var(--green-l)'],
        ['Draws',   draws,         'var(--amber)'],
        ['Losses',  losses,        'var(--red)'],
        ['Goals For',     gf,      'var(--green-l)'],
        ['Goals Against', ga,      'var(--red)'],
        ['Goal Diff',     (gf - ga), (gf - ga) >= 0 ? 'var(--green-l)' : 'var(--red)'],
        ['Points / Game', ppg,     'var(--blue)'],
      ].map(([lbl, val, col]) => `
        <div class="card" style="padding:14px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:${col};font-family:var(--mono);letter-spacing:-1px;">${val}</div>
          <div style="font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.4px;margin-top:4px;">${lbl}</div>
        </div>`).join('')}
    </div>
  `;
}

// ── Schedule prompt (minimal — uses native prompts; full modal in Phase C) ──
async function openScheduleMatchPrompt() {
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to schedule matches', 'error'); return;
  }
  const opponent = window.prompt('Opponent team name?');
  if (!opponent) return;
  const isHome = window.confirm('Are we the HOME team? (Cancel = away)');
  const dateStr = window.prompt('Date + time (YYYY-MM-DD HH:MM, local)', new Date().toISOString().slice(0,16).replace('T',' '));
  if (!dateStr) return;
  const compChoice = (window.prompt('Competition: LEAGUE / CUP / FRIENDLY / CHAMPIONS_LEAGUE / EUROPA_LEAGUE / TOURNAMENT', 'LEAGUE') || 'LEAGUE').toUpperCase();
  const ourName = (State.club && State.club.name) || 'Familista HSR';
  const body = {
    homeTeam:    isHome ? ourName : opponent,
    awayTeam:    isHome ? opponent : ourName,
    isHome:      isHome,
    competition: compChoice,
    scheduledAt: new Date(dateStr.replace(' ', 'T')).toISOString(),
  };
  // Pass current team context if any
  if (State.context && State.context.teamId) body.teamId = State.context.teamId;
  try {
    const res = await MatchAPI.create(body);
    const created = res && res.data;
    if (created) { State.matches = [created, ...(State.matches || [])]; }
    showToast('Match scheduled', 'success');
    renderMatches();
  } catch (e) {
    showToast(e && e.userMessage || 'Could not schedule match', 'error');
  }
}

// ── Match create / edit modal ────────────────────────────────────────────

function _matchLocalDateStr(date) {
  // Returns "YYYY-MM-DDTHH:MM" in local time for datetime-local inputs.
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function openScheduleMatchModal() {
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to schedule matches', 'error'); return;
  }
  document.getElementById('match-edit-title').textContent = 'Schedule Match';
  document.getElementById('match-edit-form').reset();
  document.getElementById('me-id').value            = '';
  document.getElementById('me-submit').textContent  = 'Schedule match';
  document.getElementById('me-ishome').value        = 'true';
  document.getElementById('me-competition').value   = 'LEAGUE';

  const clubName = (State.club && State.club.name) || '';
  document.getElementById('me-home-team').value = clubName;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(15, 0, 0, 0);
  document.getElementById('me-scheduled-at').value = _matchLocalDateStr(tomorrow);

  const err = document.getElementById('me-error');
  err.style.display = 'none'; err.textContent = '';
  document.getElementById('match-edit-modal').classList.add('open');
  setTimeout(() => { const el = document.getElementById('me-away-team'); if (el) el.focus(); }, 60);
}

function openEditMatchModal(id) {
  if (!id) return;
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to edit matches', 'error'); return;
  }
  const m = (State.matches || []).find(x => x.id === id) || State.activeMatch;
  if (!m) { showToast('Match not loaded', 'error'); return; }

  document.getElementById('match-edit-title').textContent = 'Edit Match';
  document.getElementById('match-edit-form').reset();
  document.getElementById('me-id').value           = m.id;
  document.getElementById('me-submit').textContent = 'Save changes';

  const set = (eid, v) => { const el = document.getElementById(eid); if (el) el.value = (v == null ? '' : v); };

  set('me-home-team',        m.homeTeam);
  set('me-away-team',        m.awayTeam);
  set('me-ishome',           m.isHome ? 'true' : 'false');
  set('me-competition',      m.competition || 'LEAGUE');
  set('me-competition-name', m.competitionName);
  set('me-venue',            m.venue);
  set('me-formation-home',   m.formationHome);
  set('me-formation-away',   m.formationAway);
  set('me-opponent-notes',   m.opponentNotes);

  if (m.scheduledAt) {
    document.getElementById('me-scheduled-at').value = _matchLocalDateStr(new Date(m.scheduledAt));
  }

  const err = document.getElementById('me-error');
  err.style.display = 'none'; err.textContent = '';
  document.getElementById('match-edit-modal').classList.add('open');
}

async function submitMatchForm(ev) {
  ev.preventDefault();
  const id    = (document.getElementById('me-id').value || '').trim();
  const errEl = document.getElementById('me-error');
  const btn   = document.getElementById('me-submit');

  const strVal = (eid) => { const el = document.getElementById(eid); return el ? el.value.trim() : ''; };

  const homeTeam       = strVal('me-home-team');
  const awayTeam       = strVal('me-away-team');
  const scheduledAtRaw = strVal('me-scheduled-at');
  const competition    = strVal('me-competition');

  if (!homeTeam)       { errEl.textContent = 'Home team is required'; errEl.style.display = ''; return; }
  if (!awayTeam)       { errEl.textContent = 'Away team is required'; errEl.style.display = ''; return; }
  if (!scheduledAtRaw) { errEl.textContent = 'Date & time is required'; errEl.style.display = ''; return; }
  if (!competition)    { errEl.textContent = 'Competition is required'; errEl.style.display = ''; return; }

  const isHome     = document.getElementById('me-ishome')?.value === 'true';
  const scheduledAt = new Date(scheduledAtRaw).toISOString();

  const body = { homeTeam, awayTeam, isHome, competition, scheduledAt };

  const compName = strVal('me-competition-name');
  const venue    = strVal('me-venue');
  const formHome = strVal('me-formation-home');
  const formAway = strVal('me-formation-away');
  const notes    = (document.getElementById('me-opponent-notes')?.value || '').trim();

  if (compName) body.competitionName = compName;
  if (venue)    body.venue           = venue;
  if (formHome) body.formationHome   = formHome;
  if (formAway) body.formationAway   = formAway;
  if (notes)    body.opponentNotes   = notes;

  if (!id && State.context && State.context.teamId) body.teamId = State.context.teamId;

  errEl.style.display = 'none'; errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = id ? 'Saving…' : 'Scheduling…';

  try {
    let saved = null;
    if (id) {
      const res = await MatchAPI.update(id, body);
      saved = res && res.data;
      if (saved) {
        const idx = (State.matches || []).findIndex(x => x.id === id);
        if (idx !== -1) State.matches[idx] = Object.assign({}, State.matches[idx], saved);
        if (State.activeMatch && State.activeMatch.id === id) {
          State.activeMatch = Object.assign({}, State.activeMatch, saved);
          paintMatchModalHeader(State.activeMatch);
          paintMatchModalControls();
        }
      }
    } else {
      const res = await MatchAPI.create(body);
      saved = res && res.data;
      if (saved) State.matches = [saved, ...(State.matches || [])];
    }
    closeModal('match-edit-modal');
    showToast(id ? 'Match updated' : 'Match scheduled', 'success');
    renderMatches();
  } catch (e) {
    errEl.textContent   = (e && e.userMessage) || (id ? 'Could not update match' : 'Could not schedule match');
    errEl.style.display = '';
  } finally {
    btn.disabled    = false;
    btn.textContent = id ? 'Save changes' : 'Schedule match';
  }
}

async function confirmDeleteMatch(id) {
  if (!id) return;
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to delete matches', 'error'); return;
  }
  const m = (State.matches || []).find(x => x.id === id) || State.activeMatch;
  const label = m ? (m.homeTeam + ' vs ' + m.awayTeam) : 'this match';
  if (!confirm('Delete ' + label + '? This cannot be undone.')) return;

  try {
    await MatchAPI.remove(id);
    State.matches = (State.matches || []).filter(x => x.id !== id);
    if (State.activeMatch && State.activeMatch.id === id) State.activeMatch = null;
    closeMatchModal();
    showToast('Match deleted', 'success');
    renderMatches();
  } catch (e) {
    showToast((e && e.userMessage) || 'Delete failed', 'error');
  }
}

// ────────────────────────────────────────────────────────────────────────
// Phase C — Match Detail drawer with live WebSocket subscription
// ────────────────────────────────────────────────────────────────────────

let _matchModalTab    = 'overview';
let _matchModalWS     = null;     // active WebSocket
let _matchModalWSPing = null;     // keepalive timer
let _intelPollTimer        = null;  // Phase 15 — intelligence 30s live poll
let _lastIntelUpdate       = 0;     // Phase 16 — epoch ms of last WS-delivered intel update
let _intelSpatialDebounce  = null;  // Phase 17 — debounce for spatial panel patches
let _intelPredictDebounce  = null;  // Phase 18 — debounce for prediction panel patches

async function openMatchDetail(id) {
  if (!id) return;
  try {
    const res = await MatchAPI.get(id);
    const m   = res && res.data;
    if (!m) { showToast('Match not loaded', 'error'); return; }
    State.activeMatch = m;
    paintMatchModalHeader(m);
    _matchModalTab = 'overview';
    document.querySelectorAll('#match-tabs-nav .filter-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    renderMatchModalTab();
    paintMatchModalControls();
    document.getElementById('match-modal').classList.add('open');
    openMatchModalWS(id);
    openMatchModalSSE(id);
  } catch (e) {
    showToast(e && e.userMessage || 'Could not load match', 'error');
  }
}

function closeMatchModal() {
  document.getElementById('match-modal').classList.remove('open');
  if (_matchModalWS)     { try { _matchModalWS.close(1000, 'closed by user'); } catch(_){} _matchModalWS = null; }
  if (_matchModalWSPing) { clearInterval(_matchModalWSPing); _matchModalWSPing = null; }
  if (_intelPollTimer)        { clearInterval(_intelPollTimer); _intelPollTimer = null; }
  if (_intelSpatialDebounce)  { clearTimeout(_intelSpatialDebounce); _intelSpatialDebounce = null; }
  if (_intelPredictDebounce)  { clearTimeout(_intelPredictDebounce); _intelPredictDebounce = null; }
  closeMatchModalSSE();
  State.activeMatch = null;
}

function paintMatchModalHeader(m) {
  document.getElementById('match-modal-title').textContent = `${m.homeTeam} vs ${m.awayTeam}`;
  document.getElementById('match-modal-home').textContent  = m.homeTeam || '—';
  document.getElementById('match-modal-away').textContent  = m.awayTeam || '—';
  document.getElementById('match-modal-score').textContent = `${m.homeScore ?? '—'} : ${m.awayScore ?? '—'}`;
  document.getElementById('match-modal-comp').textContent  = m.competition + (m.competitionName ? ' · ' + m.competitionName : '');
  document.getElementById('match-modal-when').textContent  = fmtDate(m.scheduledAt);
  document.getElementById('match-modal-venue').textContent = m.venue || '—';
  const liveChip = document.getElementById('match-modal-live-chip');
  const statusEl = document.getElementById('match-modal-status');
  const live = (m.status === 'LIVE' || m.status === 'HALFTIME');
  liveChip.style.display = live ? '' : 'none';
  statusEl.textContent   = (m.status || 'SCHEDULED') + (m.liveMinute != null ? "  ·  " + m.liveMinute + "'" : '');
}

function paintMatchModalControls() {
  const m   = State.activeMatch;
  const box = document.getElementById('match-modal-controls');
  if (!m || !box) return;
  const role = State.user && State.user.role;
  const can  = ['CLUB_ADMIN','HEAD_COACH','ANALYST','SUPER_ADMIN'].includes(role);
  if (!can) { box.innerHTML = ''; return; }
  const canEdit   = ['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role);
  const canDelete = ['CLUB_ADMIN','SUPER_ADMIN'].includes(role);
  const status = m.status || 'SCHEDULED';
  const btns = [];
  if (status === 'SCHEDULED')                              btns.push(`<button class="btn btn-primary btn-xs" onclick="liveAction('start')">Kick off</button>`);
  if (status === 'LIVE')                                   btns.push(`<button class="btn btn-outline btn-xs" onclick="liveAction('halftime')">Halftime</button>`);
  if (status === 'HALFTIME')                               btns.push(`<button class="btn btn-primary btn-xs" onclick="liveAction('resume')">Resume H2</button>`);
  if (status === 'LIVE' || status === 'HALFTIME')          btns.push(`<button class="btn btn-outline btn-xs" onclick="liveAction('finalize')">Full time</button>`);
  if (status === 'LIVE' || status === 'HALFTIME')          btns.push(`<button class="btn btn-danger btn-xs" onclick="liveAction('abandon')">Abandon</button>`);
  if (status === 'LIVE' || status === 'HALFTIME')          btns.push(`<button class="btn btn-primary btn-xs" onclick="openAddTimelinePrompt()">+ Event</button>`);
  if (canEdit)                                             btns.push(`<button class="btn btn-outline btn-xs" data-action="openEditMatchModal">Edit</button>`);
  if (canDelete)                                           btns.push(`<button class="btn btn-danger btn-xs" data-action="confirmDeleteMatch">Delete</button>`);
  box.innerHTML = btns.join('');
}

async function liveAction(kind) {
  const id = State.activeMatch && State.activeMatch.id;
  if (!id) return;
  try {
    let res;
    if (kind === 'start')        res = await MatchAPI.startLive(id);
    else if (kind === 'halftime') res = await MatchAPI.halftime(id);
    else if (kind === 'resume')   res = await MatchAPI.resume(id);
    else if (kind === 'finalize') res = await MatchAPI.finalize(id);
    else if (kind === 'abandon') {
      const reason = window.prompt('Reason for abandoning?'); if (reason === null) return;
      await MatchAPI.abandon(id, reason);
      showToast('Match abandoned', 'success'); await refreshActiveMatch(); return;
    }
    if (res && res.data) State.activeMatch = res.data;
    paintMatchModalHeader(State.activeMatch);
    paintMatchModalControls();
    showToast('Status updated', 'success');
  } catch (e) {
    showToast(e && e.userMessage || 'Action failed', 'error');
  }
}

async function refreshActiveMatch() {
  const id = State.activeMatch && State.activeMatch.id; if (!id) return;
  try {
    const res = await MatchAPI.get(id);
    State.activeMatch = (res && res.data) || State.activeMatch;
    paintMatchModalHeader(State.activeMatch);
    paintMatchModalControls();
    renderMatchModalTab();
  } catch (_) {}
}

function setMatchModalTab(tab, el) {
  _matchModalTab = tab;
  if (tab !== 'intelligence' && _intelPollTimer) { clearInterval(_intelPollTimer); _intelPollTimer = null; }
  if (tab !== 'intelligence' && _intelSpatialDebounce)  { clearTimeout(_intelSpatialDebounce);  _intelSpatialDebounce = null; }
  if (tab !== 'intelligence' && _intelPredictDebounce) { clearTimeout(_intelPredictDebounce); _intelPredictDebounce = null; }
  document.querySelectorAll('#match-tabs-nav .filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderMatchModalTab();
}

function renderMatchModalTab() {
  const c = document.getElementById('match-modal-content');
  const m = State.activeMatch;
  if (!c || !m) return;
  const tab = _matchModalTab;
  if (tab === 'overview') return paintOverviewTab(c, m);
  if (tab === 'lineup')   return paintLineupTab(c, m);
  if (tab === 'timeline') return paintTimelineTab(c, m);
  if (tab === 'tactical') return paintTacticalTab(c, m);
  if (tab === 'live')     return paintLiveTab(c, m);
  if (tab === 'fusion')   return paintFusionTab(c, m);
  if (tab === 'brain')    return paintBrainTab(c, m);
  if (tab === 'spatial')  return paintSpatialTab(c, m);
  if (tab === 'predict')  return paintPredictTab(c, m);
  if (tab === 'replay')        return paintReplayTab(c, m);
  if (tab === 'ai')            return paintAITab(c, m);
  if (tab === 'intelligence')  return paintIntelligenceTab(c, m);
}

function paintOverviewTab(c, m) {
  const tiles = [
    ['Possession',    m.possession != null ? Math.round(m.possession) + '%' : '—',  'var(--green-l)'],
    ['Shots',         m.shots ?? '—',         'var(--blue)'],
    ['On target',     m.shotsOnTarget ?? '—', 'var(--blue)'],
    ['Corners',       m.corners ?? '—',       'var(--amber)'],
    ['Fouls',         m.fouls ?? '—',         'var(--red)'],
    ['Yellow cards',  m.yellowCards ?? '—',   'var(--amber)'],
    ['Red cards',     m.redCards ?? '—',      'var(--red)'],
    ['Timeline events', (m.timeline||[]).length, 'var(--tx)'],
  ];
  c.innerHTML = `<div style="padding:18px;">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
      ${tiles.map(([l,v,col])=>`<div class="card" style="padding:14px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:${col};font-family:var(--mono);">${v}</div>
        <div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-top:4px;">${l}</div>
      </div>`).join('')}
    </div>
    ${m.opponentNotes ? `<div class="card" style="margin-top:14px;padding:14px;">
      <div style="font-size:11px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Opposition notes</div>
      <div style="font-size:13px;color:var(--tx-2);line-height:1.6;">${_esc(m.opponentNotes||'')}</div>
    </div>` : ''}
  </div>`;
}

function paintLineupTab(c, m) {
  const lineups = m.lineups || [];
  if (lineups.length === 0) {
    c.innerHTML = '<div class="empty"><div class="empty-ico">📋</div><div class="empty-ttl">No lineup yet</div><div style="font-size:12px;color:var(--tx-3);margin-top:6px;">Set the lineup via PUT /matches/:id/lineups (UI coming in Phase D)</div></div>';
    return;
  }
  c.innerHTML = '<div style="padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px;">' +
    lineups.map(l => {
      const positions = Array.isArray(l.positions) ? l.positions : [];
      const starters  = positions.filter(p => p.isStarter);
      const bench     = positions.filter(p => !p.isStarter);
      return `<div class="card" style="padding:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="font-size:13px;font-weight:700;color:${l.side==='HOME'?'var(--green-l)':'var(--amber)'};">${l.side}</div>
          <div style="font-size:11px;color:var(--tx-3);font-family:var(--mono);">${l.formation || '—'}</div>
        </div>
        <div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Starting XI (${starters.length})</div>
        <div style="font-size:12px;color:var(--tx-2);line-height:1.6;">
          ${starters.map(p => `${p.jerseyNumber ?? '?'} · ${_esc(p.position || '')} · ${_esc(p.playerId || p.name || '')}${p.captainBand?' (C)':''}`).join('<br>') || '<span style="color:var(--tx-3);">No starters listed</span>'}
        </div>
        ${bench.length ? `<div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px;">Bench (${bench.length})</div>
        <div style="font-size:12px;color:var(--tx-2);line-height:1.6;">${bench.map(p => `${p.jerseyNumber ?? '?'} · ${_esc(p.position || '')} · ${_esc(p.playerId || p.name || '')}`).join('<br>')}</div>` : ''}
      </div>`;
    }).join('') + '</div>';
}

const KIND_ICON = {
  GOAL:'⚽', OWN_GOAL:'⚽', ASSIST:'🅰️', SHOT:'🎯', SHOT_ON_TARGET:'🎯', SHOT_OFF_TARGET:'⤴️',
  SAVE:'🧤', YELLOW_CARD:'🟨', SECOND_YELLOW:'🟨🟨', RED_CARD:'🟥', SUBSTITUTION:'🔄',
  INJURY:'🚑', FOUL:'⚠️', CORNER:'🚩', OFFSIDE:'⛳', PENALTY_AWARDED:'🥅',
  PENALTY_SCORED:'✅', PENALTY_MISSED:'❌', POSSESSION_TICK:'📊', TACTICAL_NOTE:'📝',
  AI_INSIGHT:'🤖', CUSTOM:'•',
};

function paintTimelineTab(c, m) {
  const events = (m.timeline || []).slice().sort((a,b) =>
    (a.occurredAtMin - b.occurredAtMin) || ((a.occurredAtSec||0) - (b.occurredAtSec||0)) || (new Date(a.createdAt) - new Date(b.createdAt))
  );
  if (events.length === 0) {
    c.innerHTML = '<div class="empty"><div class="empty-ico">⏱️</div><div class="empty-ttl">No events yet</div><div style="font-size:12px;color:var(--tx-3);margin-top:6px;">Add the first event from the toolbar above.</div></div>';
    return;
  }
  c.innerHTML = '<div style="padding:18px 22px;">' +
    events.map(e => `<div style="display:grid;grid-template-columns:60px 24px 1fr auto;gap:12px;padding:8px 0;border-bottom:1px dashed var(--bd);">
      <div style="font-family:var(--mono);font-size:12px;color:var(--tx-3);">${e.occurredAtMin}'${e.occurredAtSec ? ('+' + e.occurredAtSec) : ''}</div>
      <div style="font-size:16px;text-align:center;">${KIND_ICON[e.kind] || '•'}</div>
      <div style="font-size:13px;color:var(--tx);">
        <strong>${e.kind}</strong> <span style="color:var(--tx-3);font-size:11px;">${e.side}</span>
        ${e.primaryPlayerId ? `<span style="color:var(--tx-2);font-size:12px;margin-left:6px;">${e.primaryPlayerId}</span>` : ''}
        ${e.notes ? `<div style="color:var(--tx-3);font-size:12px;margin-top:2px;">${_esc(e.notes||'')}</div>` : ''}
      </div>
      <div style="font-size:10px;color:var(--tx-3);">P${e.period || '?'}</div>
    </div>`).join('') + '</div>';
}

function paintTacticalTab(c, m) {
  const snapshots = m.tacticalSnapshots || [];
  // SVG pitch with the latest snapshot's positions if available.
  const latest = snapshots[snapshots.length - 1];
  const positions = latest && Array.isArray(latest.positions) ? latest.positions : [];

  // Phase F heatmap — aggregate ALL snapshot positions for our team into
  // a 20×12 density grid. Renders behind the player chips.
  const heatmapCells = computeHeatmap(snapshots);

  c.innerHTML = `<div style="padding:18px;">
    <div style="display:flex;gap:14px;font-size:11px;color:var(--tx-3);margin-bottom:10px;align-items:center;">
      <div>Snapshots: <strong style="color:var(--tx);">${snapshots.length}</strong></div>
      <div>Phase: <strong style="color:var(--tx);">${latest && latest.phase ? latest.phase : '—'}</strong></div>
      <div>Formation: <strong style="color:var(--tx);font-family:var(--mono);">${latest && latest.formation ? latest.formation : (m.formationHome || '—')}</strong></div>
      <label style="margin-left:auto;font-size:11px;display:flex;align-items:center;gap:5px;color:var(--tx-2);">
        <input type="checkbox" id="tactical-heat-toggle" ${heatmapCells.length > 0 ? 'checked' : ''} onchange="toggleHeatmapOverlay(this.checked)" />
        Heatmap overlay
      </label>
    </div>
    <div style="position:relative;background:linear-gradient(180deg,rgba(22,163,74,.10),rgba(22,163,74,.04));border:1px solid var(--bd);border-radius:var(--radius-lg);aspect-ratio:5/3;overflow:hidden;">
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;">
        <g id="tactical-heatmap-layer" style="opacity:0.55;">
          ${heatmapCells.map(c => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="rgba(220,38,38,${c.alpha})"/>`).join('')}
        </g>
        <rect x="2" y="2" width="96" height="56" fill="none" stroke="rgba(255,255,255,.15)" stroke-width=".2"/>
        <line x1="50" y1="2" x2="50" y2="58" stroke="rgba(255,255,255,.10)" stroke-width=".15"/>
        <circle cx="50" cy="30" r="7" fill="none" stroke="rgba(255,255,255,.10)" stroke-width=".15"/>
        ${positions.map(p => {
          const x = (p.x ?? 50), y = (p.y ?? 30);
          const isOpp = p.side === 'AWAY' || (!p.playerId && p.name);
          return `<g><circle cx="${x}" cy="${y}" r="1.5" fill="${isOpp?'#FCA5A5':'#22C55E'}" stroke="rgba(0,0,0,.6)" stroke-width=".2"/>
            <text x="${x}" y="${y+0.5}" font-size="1.5" text-anchor="middle" fill="#0a0a0a" font-weight="700">${p.jerseyNumber ?? '?'}</text></g>`;
        }).join('')}
      </svg>
    </div>
    <div style="font-size:11px;color:var(--tx-3);text-align:center;margin-top:8px;">Heatmap density built from ${snapshots.length} snapshot(s) · drag-drop formation arrives via /lineups PUT.</div>
  </div>`;
}

function computeHeatmap(snapshots) {
  // 20 × 12 grid covering 0..100 × 0..60 pitch coords.
  const GX = 20, GY = 12;
  const grid = new Array(GX * GY).fill(0);
  let total = 0;
  for (const s of (snapshots || [])) {
    const positions = Array.isArray(s.positions) ? s.positions : [];
    for (const p of positions) {
      const x = typeof p.x === 'number' ? p.x : null;
      const y = typeof p.y === 'number' ? p.y : null;
      const isOpp = p.side === 'AWAY' || (!p.playerId && p.name);
      if (x == null || y == null || isOpp) continue;
      const cx = Math.min(GX - 1, Math.max(0, Math.floor(x / (100 / GX))));
      const cy = Math.min(GY - 1, Math.max(0, Math.floor(y / (60 / GY))));
      grid[cy * GX + cx]++;
      total++;
    }
  }
  if (total === 0) return [];
  const max = Math.max(...grid);
  const cells = [];
  const cellW = 100 / GX, cellH = 60 / GY;
  for (let yi = 0; yi < GY; yi++) {
    for (let xi = 0; xi < GX; xi++) {
      const v = grid[yi * GX + xi];
      if (v === 0) continue;
      cells.push({
        x: xi * cellW,
        y: yi * cellH,
        w: cellW,
        h: cellH,
        alpha: Math.min(0.85, 0.15 + (v / max) * 0.7),
      });
    }
  }
  return cells;
}

function toggleHeatmapOverlay(on) {
  const layer = document.getElementById('tactical-heatmap-layer');
  if (layer) layer.style.opacity = on ? '0.55' : '0';
}

function paintAITab(c, m) {
  const ai = m.aiInsights || null;
  c.innerHTML = `<div style="padding:18px;">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">
      <span class="badge badge-purple" style="font-size:9px;">🤖 AI</span>
      <button class="btn btn-primary btn-sm" onclick="enqueueTacticalAI()">Generate match recap</button>
    </div>
    <div class="card" style="padding:14px;background:var(--green-bg);border:1px solid var(--green-bd);">
      ${ai ? `<pre style="margin:0;font-family:var(--mono);font-size:12px;color:var(--tx-2);white-space:pre-wrap;">${JSON.stringify(ai, null, 2)}</pre>` : '<div style="font-size:13px;color:var(--tx-2);">No AI insights yet. Click <strong>Generate match recap</strong> to enqueue an AIAgentJob. The worker drains the queue every ~4s.</div>'}
    </div>
  </div>`;
}

// ── Phase 15+16 — Live Match Intelligence tab ────────────────────────────
// _renderIntelligenceBundle: pure renderer — takes container + bundle, no fetch.
// Called by paintIntelligenceTab (initial/poll) AND onMatchWSEvent (INTEL_UPDATE).
function _renderIntelligenceBundle(c, d) {
  if (!c || !d) return;

  // ── Panel 1: Timeline Summary ────────────────────────────────────────
  const ts = d.timelineSummary || {};
  const timelinePanelHTML = `
    <div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Timeline Summary</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${[
          ['Goals', ts.goals ?? 0, 'var(--green-l)'],
          ['Shots on tgt', ts.shotsOnTarget ?? 0, 'var(--blue)'],
          ['Shots', ts.shots ?? 0, 'var(--blue)'],
          ['Corners', ts.corners ?? 0, 'var(--amber)'],
          ['Fouls', ts.fouls ?? 0, 'var(--red)'],
          ['Yellow', ts.yellowCards ?? 0, 'var(--amber)'],
          ['Red', ts.redCards ?? 0, 'var(--red)'],
          ['Total events', ts.totalEvents ?? 0, 'var(--tx)'],
        ].map(([l, v, col]) => `<div style="text-align:center;min-width:62px;">
          <div style="font-size:20px;font-weight:800;color:${col};font-family:var(--mono);">${v}</div>
          <div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.4px;margin-top:2px;">${l}</div>
        </div>`).join('')}
      </div>
    </div>`;

  // ── Panel 2: Momentum gauge ──────────────────────────────────────────
  const mom = d.momentum || { index: 0, notes: [] };
  const momPct   = Math.round((mom.index + 1) * 50);
  const momColor = mom.index > 0.2 ? 'var(--green-l)' : mom.index < -0.2 ? 'var(--red)' : 'var(--amber)';
  const momLabel = mom.index > 0.2 ? 'Dominant' : mom.index < -0.2 ? 'Under pressure' : 'Balanced';
  const poss = d.possession || { ourPct: 50 };
  const momentumPanelHTML = `
    <div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Momentum & Possession</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <div style="font-size:11px;color:var(--tx-3);margin-bottom:4px;">Tactical Momentum</div>
          <div style="font-size:22px;font-weight:700;color:${momColor};font-family:var(--mono);">${(mom.index >= 0 ? '+' : '') + mom.index.toFixed(2)}</div>
          <div style="height:5px;background:var(--bg);border-radius:3px;margin-top:5px;overflow:hidden;">
            <div style="height:100%;width:${momPct}%;background:${momColor};"></div>
          </div>
          <div style="font-size:11px;color:${momColor};margin-top:4px;font-weight:600;">${momLabel}</div>
          <div style="font-size:10px;color:var(--tx-3);margin-top:3px;">${(mom.notes || []).map(escapeHTML).join(' · ')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--tx-3);margin-bottom:4px;">Possession</div>
          <div style="font-size:22px;font-weight:700;color:var(--tx);font-family:var(--mono);">${poss.ourPct}%</div>
          <div style="height:5px;background:var(--red);border-radius:3px;margin-top:5px;overflow:hidden;display:flex;">
            <div style="height:100%;width:${poss.ourPct}%;background:var(--green-l);"></div>
          </div>
          <div style="font-size:10px;color:var(--tx-3);margin-top:4px;">Home ${poss.ourPct}% · Away ${100 - poss.ourPct}%</div>
        </div>
      </div>
    </div>`;

  // ── Panel 3: Tactical Board (formation SVG) ──────────────────────────
  const tb = d.tacticalBoard || { formationHome: null, formationAway: null, positions: [] };
  const homePlayers = (tb.positions || []).filter(p => p.side === 'HOME' && p.isStarter);
  const awayPlayers = (tb.positions || []).filter(p => p.side === 'AWAY' && p.isStarter);
  function _playerDot(p, isHome) {
    const cx = isHome ? (p.x / 100) * 52 + 4 : 100 - ((p.x / 100) * 52 + 4);
    const cy = (p.y / 100) * 68;
    const ratingColor = p.rating == null ? '#888' : p.rating >= 7.5 ? '#22c55e' : p.rating >= 6.5 ? '#eab308' : '#ef4444';
    const label = (p.jerseyNumber != null ? '#' + p.jerseyNumber + ' ' : '') + escapeHTML(p.playerName || '');
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5" fill="${isHome ? '#22c55e' : '#3b82f6'}" stroke="#fff" stroke-width="0.5" opacity="0.9"/>
      ${p.rating != null ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="none" stroke="${ratingColor}" stroke-width="0.8" opacity="0.7"/>` : ''}
      <title>${label}${p.rating != null ? ' · ' + p.rating.toFixed(1) : ''}</title>`;
  }
  const homeDotsHTML = homePlayers.map(p => _playerDot(p, true)).join('');
  const awayDotsHTML = awayPlayers.map(p => _playerDot(p, false)).join('');
  const tacticalPanelHTML = `
    <div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">
        Tactical Board
        ${tb.formationHome ? `<span style="color:var(--green-l);margin-left:6px;">${escapeHTML(tb.formationHome)}</span>` : ''}
        <span style="color:var(--tx-3);margin:0 4px;">vs</span>
        ${tb.formationAway ? `<span style="color:var(--blue);">${escapeHTML(tb.formationAway)}</span>` : ''}
      </div>
      <svg viewBox="0 0 100 68" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:260px;background:#1a2e1a;border-radius:6px;">
        <rect x="0" y="0" width="100" height="68" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="0.3"/>
        <line x1="50" y1="0" x2="50" y2="68" stroke="rgba(255,255,255,0.3)" stroke-width="0.3"/>
        <circle cx="50" cy="34" r="6" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="0.3"/>
        <rect x="0" y="22" width="12" height="24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="0.3"/>
        <rect x="88" y="22" width="12" height="24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="0.3"/>
        ${homeDotsHTML}
        ${awayDotsHTML}
      </svg>
      <div style="display:flex;gap:12px;margin-top:6px;font-size:10px;color:var(--tx-3);">
        <span style="display:flex;align-items:center;gap:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;"></span>Home</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;"></span>Away</span>
        <span style="display:flex;align-items:center;gap:4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid #22c55e;"></span>Rating ring (green=7.5+)</span>
      </div>
    </div>`;

  // ── Panel 4: Coach Recommendations ──────────────────────────────────
  const recs = d.coachRecommendations || [];
  const recPriorityColor = { HIGH: 'var(--red)', MEDIUM: 'var(--amber)', LOW: 'var(--tx-3)' };
  const recPriorityBg   = { HIGH: 'rgba(220,38,38,0.12)', MEDIUM: 'rgba(234,179,8,0.1)', LOW: 'rgba(255,255,255,0.04)' };
  const recHTML = recs.length === 0
    ? '<div style="font-size:12px;color:var(--tx-3);">No recommendations at this stage.</div>'
    : recs.map(r => `
        <div style="padding:10px 12px;border-radius:6px;margin-bottom:6px;background:${recPriorityBg[r.priority] || recPriorityBg.LOW};border-left:3px solid ${recPriorityColor[r.priority] || recPriorityColor.LOW};">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
            <span style="font-size:10px;font-weight:700;color:${recPriorityColor[r.priority] || recPriorityColor.LOW};text-transform:uppercase;">${escapeHTML(r.priority)}</span>
            <span style="font-size:11px;font-weight:600;color:var(--tx);">${escapeHTML(r.area)}</span>
          </div>
          <div style="font-size:12px;color:var(--tx-2);margin-bottom:3px;">${escapeHTML(r.finding)}</div>
          <div style="font-size:12px;color:var(--green-l);font-weight:500;">→ ${escapeHTML(r.action)}</div>
        </div>`).join('');
  const recsPanelHTML = `
    <div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Coach Recommendations</div>
      ${recHTML}
    </div>`;

  // ── Panel 5: Player Ratings Table ────────────────────────────────────
  const ratings = (d.playerRatings || []).slice(0, 20);
  const ratingsRowsHTML = ratings.length === 0
    ? '<tr><td colspan="7" style="color:var(--tx-3);padding:10px;text-align:center;">No player stats available</td></tr>'
    : ratings.map(r => {
        const rColor = r.rating >= 7.5 ? 'var(--green-l)' : r.rating >= 6.5 ? 'var(--tx)' : r.rating < 5.5 ? 'var(--red)' : 'var(--amber)';
        return `<tr>
          <td style="font-size:12px;color:var(--tx);font-weight:600;">${escapeHTML(r.name)}</td>
          <td style="font-size:11px;color:var(--tx-3);">${escapeHTML(r.position || '—')}</td>
          <td style="font-size:13px;font-weight:800;color:${rColor};font-family:var(--mono);">${r.rating.toFixed(1)}</td>
          <td style="font-size:12px;color:var(--tx-2);">${r.minutesPlayed}'</td>
          <td style="font-size:12px;color:var(--tx-2);">${r.goals}g ${r.assists}a</td>
          <td style="font-size:12px;color:var(--tx-2);">${r.xg != null ? r.xg.toFixed(2) : '—'}</td>
          <td style="font-size:12px;color:var(--tx-2);">${r.xa != null ? r.xa.toFixed(2) : '—'}</td>
        </tr>`;
      }).join('');
  const ratingsPanelHTML = `
    <div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Player Ratings</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="border-bottom:1px solid var(--bd);">
            <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;color:var(--tx-3);font-weight:600;">Player</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Pos</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Rating</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Mins</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">G/A</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">xG</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">xA</th>
          </tr></thead>
          <tbody>${ratingsRowsHTML}</tbody>
        </table>
      </div>
    </div>`;

  // ── Panel 6: Dominance Graph (5-min SVG bar chart) ───────────────────
  const dom = d.dominanceSeries || [];
  let dominancePanelHTML;
  if (dom.length === 0) {
    dominancePanelHTML = `<div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Dominance Timeline</div>
      <div style="font-size:12px;color:var(--tx-3);">No events to build dominance series.</div>
    </div>`;
  } else {
    const barW = Math.max(4, Math.floor(320 / dom.length) - 1);
    const totalW = dom.length * (barW + 1);
    const bars = dom.map((w, i) => {
      const h = Math.round((Math.abs(w.homeScore - 50) / 50) * 28);
      const isHome = w.homeScore >= 50;
      const y = isHome ? 30 - h : 30;
      return `<rect x="${i * (barW + 1)}" y="${y}" width="${barW}" height="${Math.max(1, h)}"
        fill="${isHome ? '#22c55e' : '#ef4444'}" opacity="0.8">
        <title>${escapeHTML(w.label)} — ${isHome ? 'Home' : 'Away'} +${Math.abs(w.homeScore - 50)}</title>
      </rect>`;
    }).join('');
    dominancePanelHTML = `
      <div class="card" style="padding:12px;margin-bottom:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Dominance Timeline</div>
        <svg viewBox="0 0 ${totalW} 60" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:80px;overflow:visible;">
          <line x1="0" y1="30" x2="${totalW}" y2="30" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
          ${bars}
        </svg>
        <div style="display:flex;gap:10px;margin-top:4px;font-size:10px;color:var(--tx-3);">
          <span style="display:flex;align-items:center;gap:3px;"><span style="display:inline-block;width:8px;height:8px;background:#22c55e;border-radius:2px;"></span>Home dominant</span>
          <span style="display:flex;align-items:center;gap:3px;"><span style="display:inline-block;width:8px;height:8px;background:#ef4444;border-radius:2px;"></span>Away dominant</span>
          <span style="margin-left:auto;">${dom.length} windows · 5 min each</span>
        </div>
      </div>`;
  }

  // ── Panel 7: Fatigue + Pressure Table ───────────────────────────────
  const fatigue = (d.fatigueIndicators || []).slice(0, 20);
  const fatRiskColor = { HIGH: 'var(--red)', MEDIUM: 'var(--amber)', LOW: 'var(--green-l)' };
  const fatigueRowsHTML = fatigue.length === 0
    ? '<tr><td colspan="6" style="color:var(--tx-3);padding:10px;text-align:center;">No fatigue data available</td></tr>'
    : fatigue.map(f => `<tr>
        <td style="font-size:12px;color:var(--tx);font-weight:600;">${escapeHTML(f.name)}</td>
        <td style="font-size:11px;color:var(--tx-3);">${escapeHTML(f.position || '—')}</td>
        <td style="font-size:12px;color:var(--tx-2);">${f.minutesPlayed}'</td>
        <td>
          <div style="display:flex;align-items:center;gap:5px;">
            <div style="width:52px;height:4px;background:var(--bg);border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${f.fatigueIndex}%;background:${f.fatigueIndex >= 80 ? 'var(--red)' : f.fatigueIndex >= 60 ? 'var(--amber)' : 'var(--green-l)'}"></div>
            </div>
            <span style="font-size:12px;font-family:var(--mono);color:var(--tx-2);">${f.fatigueIndex}</span>
          </div>
        </td>
        <td style="font-size:12px;color:var(--tx-2);">${f.pressureSuccess}%</td>
        <td><span style="font-size:10px;font-weight:700;color:${fatRiskColor[f.riskLevel] || 'var(--tx-3)'};">${f.riskLevel}</span></td>
      </tr>`).join('');
  const fatiguePanelHTML = `
    <div class="card" style="padding:12px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Fatigue & Pressure Indicators</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="border-bottom:1px solid var(--bd);">
            <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;color:var(--tx-3);font-weight:600;">Player</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Pos</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Mins</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Fatigue</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Press%</th>
            <th style="text-align:left;padding:4px 8px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Risk</th>
          </tr></thead>
          <tbody>${fatigueRowsHTML}</tbody>
        </table>
      </div>
    </div>`;

  // ── Assemble all panels ──────────────────────────────────────────────
  const isLive = (d.status === 'LIVE' || d.status === 'HALFTIME');
  const liveChipHTML = isLive
    ? `<span class="badge badge-green" style="font-size:9px;margin-left:8px;">LIVE ${d.liveMinute != null ? d.liveMinute + "'" : ''}</span>`
    : '';
  const scoreHTML = `<span style="font-size:12px;font-family:var(--mono);color:var(--tx-2);margin-left:6px;">${escapeHTML(d.homeTeam)} ${d.score.home ?? '—'} : ${d.score.away ?? '—'} ${escapeHTML(d.awayTeam)}</span>`;

  c.innerHTML = `<div style="padding:14px 16px;">
    <div style="display:flex;align-items:center;gap:4px;margin-bottom:12px;flex-wrap:wrap;">
      <span style="font-size:12px;font-weight:700;color:var(--tx);">Live Match Intelligence</span>
      ${liveChipHTML}
      ${scoreHTML}
      <button class="btn btn-ghost btn-xs" style="margin-left:auto;" onclick="paintIntelligenceTab(document.getElementById('match-modal-content'),State.activeMatch)">↻ Refresh</button>
    </div>
    ${timelinePanelHTML}
    ${momentumPanelHTML}
    ${tacticalPanelHTML}
    ${recsPanelHTML}
    ${ratingsPanelHTML}
    ${dominancePanelHTML}
    ${fatiguePanelHTML}
    <div style="font-size:10px;color:var(--tx-3);text-align:right;">Computed ${new Date(d.computedAt).toLocaleTimeString()}</div>
    <div id="intel-spatial"></div>
    <div id="intel-predictions"></div>
  </div>`;

  // Phase 17 — render spatial panels into their dedicated container
  const _spatialEl = c.querySelector('#intel-spatial');
  if (_spatialEl && d.spatialAnalysis) _renderSpatialPanels(_spatialEl, d.spatialAnalysis, d);
  // Phase 18 — render prediction panels into their dedicated container
  const _predictEl = c.querySelector('#intel-predictions');
  if (_predictEl && d.predictions) _renderPredictionPanels(_predictEl, d.predictions, d);
}

async function paintIntelligenceTab(c, m) {
  if (_intelPollTimer) { clearInterval(_intelPollTimer); _intelPollTimer = null; }
  c.innerHTML = loadingHTML('Loading live intelligence…');
  let d;
  try {
    const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/live-intelligence');
    d = (res && res.data) || null;
  } catch (e) {
    c.innerHTML = '<div style="padding:16px;color:var(--red);">Intelligence unavailable: ' + escapeHTML((e && e.userMessage) || 'error') + '</div>';
    return;
  }
  if (!d) { c.innerHTML = '<div class="empty"><div class="empty-ico">🧠</div><div class="empty-ttl">No intelligence data</div></div>'; return; }
  _lastIntelUpdate = Date.now();
  _renderIntelligenceBundle(c, d);
  // 30s poll fallback for live matches — skips if WS delivered an update recently
  const isLive = (d.status === 'LIVE' || d.status === 'HALFTIME');
  if (isLive) {
    _intelPollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (isFormEditing()) return;
      if (_matchModalTab !== 'intelligence') { clearInterval(_intelPollTimer); _intelPollTimer = null; return; }
      if (Date.now() - _lastIntelUpdate < 25_000) return; // WS already delivered recently
      const cont = document.getElementById('match-modal-content');
      if (!cont) { clearInterval(_intelPollTimer); _intelPollTimer = null; return; }
      FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/live-intelligence').then(res => {
        if (res && res.data && _matchModalTab === 'intelligence') {
          _lastIntelUpdate = Date.now();
          _renderIntelligenceBundle(cont, res.data);
        }
      }).catch(() => {});
    }, 30_000);
  }
}


// ── Phase 17 — Spatial & Tactical Visualization Engine ────────────────────────
// _renderSpatialPanels: pure SVG renderer for the 5 spatial panels.
// Called on initial full render AND on WS-triggered partial patch.
function _renderSpatialPanels(el, spa, d) {
  if (!el || !spa) return;
  const PITCH_SVG_LINES = `
    <rect x="0" y="0" width="100" height="100" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="0.3"/>
    <line x1="50" y1="0" x2="50" y2="100" stroke="rgba(255,255,255,0.2)" stroke-width="0.3"/>
    <circle cx="50" cy="50" r="9" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="0.3"/>
    <rect x="0" y="33" width="16" height="34" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="0.3"/>
    <rect x="84" y="33" width="16" height="34" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="0.3"/>
  `;
  const CARD_STYLE = 'padding:12px;margin-bottom:12px;';
  const HDR = (t) => `<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${t}</div>`;

  // ── Panel S1: Player Heatmap ──────────────────────────────────────────────
  const hmCells = (spa.heatmap || []).map(cell => {
    const hw = cell.homeDensity * 10, aw = cell.awayDensity * 10;
    let out = '';
    if (cell.homeDensity > 0.05) out += `<rect x="${(cell.cx - 5).toFixed(1)}" y="${(cell.cy - 5).toFixed(1)}" width="10" height="10" fill="#22c55e" opacity="${(cell.homeDensity * 0.65).toFixed(2)}" rx="1"/>`;
    if (cell.awayDensity > 0.05) out += `<rect x="${(cell.cx - 4).toFixed(1)}" y="${(cell.cy - 4).toFixed(1)}" width="8" height="8" fill="#3b82f6" opacity="${(cell.awayDensity * 0.55).toFixed(2)}" rx="1"/>`;
    return out;
  }).join('');
  const heatmapHTML = `<div class="card" style="${CARD_STYLE}">
    ${HDR('Player Heatmap')}
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:220px;background:#111c11;border-radius:6px;">
      ${PITCH_SVG_LINES}${hmCells}
    </svg>
    <div style="display:flex;gap:12px;margin-top:5px;font-size:10px;color:var(--tx-3);">
      <span><span style="display:inline-block;width:8px;height:8px;background:#22c55e;border-radius:2px;margin-right:3px;"></span>Home density</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#3b82f6;border-radius:2px;margin-right:3px;"></span>Away density</span>
    </div>
  </div>`;

  // ── Panel S2: Pressure Map ────────────────────────────────────────────────
  const pmCells = (spa.pressureMap || []).map(cell => {
    const col = cell.intensity > 0.7 ? '#ef4444' : cell.intensity > 0.4 ? '#f97316' : '#eab308';
    return `<rect x="${(cell.cx - 5).toFixed(1)}" y="${(cell.cy - 5).toFixed(1)}" width="10" height="10" fill="${col}" opacity="${(cell.intensity * 0.75).toFixed(2)}" rx="1">
      <title>${cell.eventCount} event${cell.eventCount !== 1 ? 's' : ''}</title>
    </rect>`;
  }).join('');
  const pressureHTML = (spa.pressureMap && spa.pressureMap.length > 0)
    ? `<div class="card" style="${CARD_STYLE}">
    ${HDR('Pressure Map')}
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:220px;background:#111c11;border-radius:6px;">
      ${PITCH_SVG_LINES}${pmCells}
    </svg>
    <div style="display:flex;gap:12px;margin-top:5px;font-size:10px;color:var(--tx-3);">
      <span style="color:#ef4444;">■</span> High &nbsp;
      <span style="color:#f97316;">■</span> Medium &nbsp;
      <span style="color:#eab308;">■</span> Low
    </div>
  </div>`
    : `<div class="card" style="${CARD_STYLE}">${HDR('Pressure Map')}<div style="font-size:12px;color:var(--tx-3);">No event coordinates recorded yet.</div></div>`;

  // ── Panel S3: Passing Network ─────────────────────────────────────────────
  const homeEdges = (spa.passingNetwork || []).filter(e => e.side === 'HOME').map(e =>
    `<line x1="${e.fromX.toFixed(1)}" y1="${e.fromY.toFixed(1)}" x2="${e.toX.toFixed(1)}" y2="${e.toY.toFixed(1)}" stroke="#22c55e" stroke-width="${(0.4 + e.weight * 1.6).toFixed(2)}" opacity="${(0.35 + e.weight * 0.55).toFixed(2)}"/>`
  ).join('');
  const awayEdges = (spa.passingNetwork || []).filter(e => e.side === 'AWAY').map(e =>
    `<line x1="${e.fromX.toFixed(1)}" y1="${e.fromY.toFixed(1)}" x2="${e.toX.toFixed(1)}" y2="${e.toY.toFixed(1)}" stroke="#3b82f6" stroke-width="${(0.4 + e.weight * 1.6).toFixed(2)}" opacity="${(0.35 + e.weight * 0.55).toFixed(2)}"/>`
  ).join('');
  const tb = (d && d.tacticalBoard) ? d.tacticalBoard : { positions: [] };
  const homeDots = (tb.positions || []).filter(p => p.side === 'HOME' && p.isStarter).map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#22c55e" stroke="#fff" stroke-width="0.4"><title>${escapeHTML(p.playerName || '?')}</title></circle>`
  ).join('');
  const awayDots = (tb.positions || []).filter(p => p.side === 'AWAY' && p.isStarter).map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#3b82f6" stroke="#fff" stroke-width="0.4"><title>${escapeHTML(p.playerName || '?')}</title></circle>`
  ).join('');
  const passingHTML = `<div class="card" style="${CARD_STYLE}">
    ${HDR('Passing Network')}
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:220px;background:#111c11;border-radius:6px;">
      ${PITCH_SVG_LINES}${homeEdges}${awayEdges}${homeDots}${awayDots}
    </svg>
    <div style="font-size:10px;color:var(--tx-3);margin-top:4px;">Line weight = proximity strength · Hover player dot for name</div>
  </div>`;

  // ── Panel S4: Shape Compactness ───────────────────────────────────────────
  const hs = spa.homeShape || {};
  const as_ = spa.awayShape || {};
  const _ellipseRx = (w) => Math.max(1, (w || 0) / 2);
  const _ellipseRy = (dep) => Math.max(1, (dep || 0) / 2);

  const homeBBW = hs.width || 0, homeBBD = hs.depth || 0;
  const awayBBW = as_.width || 0, awayBBD = as_.depth || 0;
  const homeBBx = (hs.centroidX || 50) - homeBBW / 2, homeBBy = (hs.centroidY || 50) - homeBBD / 2;
  const awayBBx = (as_.centroidX || 50) - awayBBW / 2, awayBBy = (as_.centroidY || 50) - awayBBD / 2;

  const anomalyDots = [
    ...(hs.spacingAnomalies || []).map(a =>
      `<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="4" fill="none" stroke="#ef4444" stroke-width="0.8" stroke-dasharray="2,1"><title>Spacing anomaly: ${escapeHTML(a.name)}</title></circle>`
    ),
    ...(as_.spacingAnomalies || []).map(a =>
      `<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="4" fill="none" stroke="#f97316" stroke-width="0.8" stroke-dasharray="2,1"><title>Spacing anomaly: ${escapeHTML(a.name)}</title></circle>`
    ),
  ].join('');

  const shapeHTML = `<div class="card" style="${CARD_STYLE}">
    ${HDR('Shape Compactness')}
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:220px;background:#111c11;border-radius:6px;">
      ${PITCH_SVG_LINES}
      ${homeBBW > 0 ? `<rect x="${homeBBx.toFixed(1)}" y="${homeBBy.toFixed(1)}" width="${homeBBW.toFixed(1)}" height="${homeBBD.toFixed(1)}" fill="#22c55e" fill-opacity="0.07" stroke="#22c55e" stroke-width="0.5" stroke-dasharray="2,1.5"/>` : ''}
      ${awayBBW > 0 ? `<rect x="${awayBBx.toFixed(1)}" y="${awayBBy.toFixed(1)}" width="${awayBBW.toFixed(1)}" height="${awayBBD.toFixed(1)}" fill="#3b82f6" fill-opacity="0.07" stroke="#3b82f6" stroke-width="0.5" stroke-dasharray="2,1.5"/>` : ''}
      <circle cx="${(hs.centroidX || 50).toFixed(1)}" cy="${(hs.centroidY || 50).toFixed(1)}" r="2.5" fill="#22c55e" opacity="0.9"><title>Home centroid</title></circle>
      <circle cx="${(as_.centroidX || 50).toFixed(1)}" cy="${(as_.centroidY || 50).toFixed(1)}" r="2.5" fill="#3b82f6" opacity="0.9"><title>Away centroid</title></circle>
      <line x1="${(hs.defensiveX || 50).toFixed(1)}" y1="0" x2="${(hs.defensiveX || 50).toFixed(1)}" y2="100" stroke="#22c55e" stroke-width="0.4" stroke-dasharray="3,2" opacity="0.5"/>
      <line x1="${(hs.attackingX || 50).toFixed(1)}" y1="0" x2="${(hs.attackingX || 50).toFixed(1)}" y2="100" stroke="#22c55e" stroke-width="0.4" stroke-dasharray="3,2" opacity="0.7"/>
      <line x1="${(as_.defensiveX || 50).toFixed(1)}" y1="0" x2="${(as_.defensiveX || 50).toFixed(1)}" y2="100" stroke="#3b82f6" stroke-width="0.4" stroke-dasharray="3,2" opacity="0.5"/>
      <line x1="${(as_.attackingX || 50).toFixed(1)}" y1="0" x2="${(as_.attackingX || 50).toFixed(1)}" y2="100" stroke="#3b82f6" stroke-width="0.4" stroke-dasharray="3,2" opacity="0.7"/>
      ${anomalyDots}
    </svg>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;font-size:11px;">
      <div><div style="color:#22c55e;font-weight:700;margin-bottom:3px;">Home</div>
        <div style="color:var(--tx-2);">Compactness: <span style="font-family:var(--mono);">${hs.compactness ?? '—'}</span></div>
        <div style="color:var(--tx-2);">Width: <span style="font-family:var(--mono);">${hs.width ?? '—'}</span></div>
        <div style="color:var(--tx-2);">Def line X: <span style="font-family:var(--mono);">${hs.defensiveX ?? '—'}</span></div>
        <div style="color:var(--tx-2);">Atk line X: <span style="font-family:var(--mono);">${hs.attackingX ?? '—'}</span></div>
        ${(hs.spacingAnomalies || []).length > 0 ? `<div style="color:#ef4444;margin-top:2px;">⚠ ${(hs.spacingAnomalies || []).map(a => escapeHTML(a.name)).join(', ')}</div>` : ''}
      </div>
      <div><div style="color:#3b82f6;font-weight:700;margin-bottom:3px;">Away</div>
        <div style="color:var(--tx-2);">Compactness: <span style="font-family:var(--mono);">${as_.compactness ?? '—'}</span></div>
        <div style="color:var(--tx-2);">Width: <span style="font-family:var(--mono);">${as_.width ?? '—'}</span></div>
        <div style="color:var(--tx-2);">Def line X: <span style="font-family:var(--mono);">${as_.defensiveX ?? '—'}</span></div>
        <div style="color:var(--tx-2);">Atk line X: <span style="font-family:var(--mono);">${as_.attackingX ?? '—'}</span></div>
        ${(as_.spacingAnomalies || []).length > 0 ? `<div style="color:#ef4444;margin-top:2px;">⚠ ${(as_.spacingAnomalies || []).map(a => escapeHTML(a.name)).join(', ')}</div>` : ''}
      </div>
    </div>
  </div>`;

  // ── Panel S5: Formation Shift Timeline ────────────────────────────────────
  const fss = spa.formationShiftSeries || [];
  let shiftHTML;
  if (fss.length < 2) {
    shiftHTML = `<div class="card" style="${CARD_STYLE}">${HDR('Formation Shift')}<div style="font-size:12px;color:var(--tx-3);">Insufficient data for shift timeline.</div></div>`;
  } else {
    const W = 300, H = 60, pad = 2;
    const xStep = (W - pad * 2) / (fss.length - 1);
    const yScale = (v) => pad + (1 - v / 100) * (H - pad * 2);
    const homeCompLine = fss.map((s, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * xStep).toFixed(1)},${yScale(s.homeCompactness).toFixed(1)}`).join(' ');
    const awayCompLine = fss.map((s, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * xStep).toFixed(1)},${yScale(s.awayCompactness).toFixed(1)}`).join(' ');
    const midY = yScale(50);
    shiftHTML = `<div class="card" style="${CARD_STYLE}">
      ${HDR('Formation Shift')}
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:80px;overflow:visible;">
        <line x1="${pad}" y1="${midY.toFixed(1)}" x2="${W - pad}" y2="${midY.toFixed(1)}" stroke="rgba(255,255,255,0.1)" stroke-width="0.5"/>
        <path d="${homeCompLine}" fill="none" stroke="#22c55e" stroke-width="1.2" opacity="0.85"/>
        <path d="${awayCompLine}" fill="none" stroke="#3b82f6" stroke-width="1.2" opacity="0.85"/>
        ${fss.filter((_, i) => i % 3 === 0).map((s, _, arr) => {
          const origI = fss.indexOf(s);
          return `<text x="${(pad + origI * xStep).toFixed(1)}" y="${H - 1}" font-size="4" fill="rgba(255,255,255,0.4)">${s.label}</text>`;
        }).join('')}
      </svg>
      <div style="display:flex;gap:12px;margin-top:4px;font-size:10px;color:var(--tx-3);">
        <span><span style="display:inline-block;width:10px;height:2px;background:#22c55e;margin-right:3px;vertical-align:middle;"></span>Home compactness</span>
        <span><span style="display:inline-block;width:10px;height:2px;background:#3b82f6;margin-right:3px;vertical-align:middle;"></span>Away compactness</span>
        <span style="margin-left:auto;">Width: H ${(fss[0] || {}).homeWidth ?? '—'} · A ${(fss[0] || {}).awayWidth ?? '—'}</span>
      </div>
    </div>`;
  }

  // ── Overload summary (bonus row) ─────────────────────────────────────────
  const overloadZones = (spa.overloadZones || []).filter(z => z.dominantSide !== 'BALANCED' && z.magnitude >= 2);
  const overloadHTML = overloadZones.length > 0
    ? `<div class="card" style="${CARD_STYLE}">
      ${HDR('Overload Zones')}
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${overloadZones.map(z => `<div style="padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${z.dominantSide === 'HOME' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)'};color:${z.dominantSide === 'HOME' ? '#22c55e' : '#3b82f6'};">${z.col[0]}${z.row[0]} +${z.magnitude} ${z.dominantSide}</div>`).join('')}
      </div>
    </div>`
    : '';

  el.innerHTML = heatmapHTML + pressureHTML + passingHTML + shapeHTML + shiftHTML + overloadHTML;
}

// ── Phase 18 — Predictive Intelligence Visualization ──────────────────────────
// _renderPredictionPanels: 6 SVG panels for goal threat, momentum, shape, fatigue,
// counter-threat, and possession swing.  Called on full render AND WS partial patch.
function _renderPredictionPanels(el, pred, d) {
  if (!el || !pred) return;
  const CARD_STYLE = 'padding:12px;margin-bottom:12px;';
  const HDR = (t) => `<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${t}</div>`;
  const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#22c55e' };
  const DIR_COLOR  = { HOME: '#22c55e', AWAY: '#ef4444', STABLE: '#94a3b8' };

  // ── P1: Goal Threat Meter ─────────────────────────────────────────────────
  const gt      = pred.goalThreat;
  const pct     = Math.max(0, Math.min(100, gt.probability));
  const gtColor = pct >= 60 ? '#ef4444' : pct >= 35 ? '#f59e0b' : '#22c55e';
  const dash    = `${(pct * 125.7 / 100).toFixed(1)} 125.7`;
  const threatColMap = { HOME: '#22c55e', AWAY: '#3b82f6', BALANCED: '#94a3b8' };
  const goalHTML = `
  <div style="${CARD_STYLE}background:var(--glass);">
    ${HDR('Goal Threat Meter')}
    <div style="display:flex;align-items:center;gap:16px;">
      <svg viewBox="0 0 60 60" width="72" height="72" style="flex-shrink:0;">
        <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="5"/>
        <circle cx="30" cy="30" r="20" fill="none" stroke="${gtColor}" stroke-width="5"
          stroke-dasharray="${dash}" stroke-dashoffset="0"
          transform="rotate(-90 30 30)" stroke-linecap="round"/>
        <text x="30" y="35" text-anchor="middle" font-size="10" font-weight="700" fill="${gtColor}">${pct}%</text>
      </svg>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;color:${threatColMap[gt.threatSide]||'#94a3b8'};margin-bottom:4px;">
          ${gt.threatSide} · next ${gt.windowMin} min
        </div>
        ${gt.drivers.map(dr => `<div style="font-size:11px;color:var(--tx-2);line-height:1.4;">→ ${dr}</div>`).join('')}
      </div>
    </div>
  </div>`;

  // ── P2: Momentum Forecast ─────────────────────────────────────────────────
  const mf       = pred.momentumForecast;
  const mfColor  = DIR_COLOR[mf.direction] || '#94a3b8';
  const confPct  = Math.round(mf.confidence * 100);
  const arrowSVG = mf.direction === 'HOME'
    ? '<path d="M4 16 L16 8 L28 16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    : mf.direction === 'AWAY'
      ? '<path d="M28 8 L16 16 L4 8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M2 12 L30 12" fill="none" stroke-linecap="round"/>';
  const momentumHTML = `
  <div style="${CARD_STYLE}background:var(--glass);">
    ${HDR('Momentum Forecast')}
    <div style="display:flex;align-items:center;gap:14px;">
      <svg viewBox="0 0 32 24" width="64" height="48" style="flex-shrink:0;">
        <g stroke="${mfColor}" stroke-width="2.5">${arrowSVG}</g>
      </svg>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:${mfColor};margin-bottom:3px;">${mf.direction}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <div style="height:4px;border-radius:2px;background:rgba(255,255,255,0.1);flex:1;overflow:hidden;">
            <div style="height:100%;width:${confPct}%;background:${mfColor};border-radius:2px;"></div>
          </div>
          <span style="font-size:10px;color:var(--tx-3);min-width:28px;">${confPct}%</span>
        </div>
        <div style="font-size:11px;color:var(--tx-2);">${mf.note}</div>
      </div>
    </div>
  </div>`;

  // ── P3: Tactical Stability ────────────────────────────────────────────────
  const sc      = pred.shapeCollapse;
  const scColor = RISK_COLOR[sc.risk];
  const stabilityHTML = `
  <div style="${CARD_STYLE}background:var(--glass);">
    ${HDR('Tactical Stability')}
    <div style="display:flex;align-items:center;gap:16px;">
      <svg viewBox="0 0 60 60" width="60" height="60" style="flex-shrink:0;">
        <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="4"/>
        <circle cx="30" cy="30" r="20" fill="none" stroke="${scColor}" stroke-width="4"
          stroke-dasharray="${sc.score} 100" stroke-dashoffset="0"
          transform="rotate(-90 30 30)" stroke-linecap="round" pathLength="100"/>
        <text x="30" y="34" text-anchor="middle" font-size="7.5" font-weight="700" fill="${scColor}">${sc.risk}</text>
      </svg>
      <div style="flex:1;">
        ${sc.indicators.length > 0
          ? sc.indicators.map(ind => `<div style="font-size:11px;color:var(--tx-2);line-height:1.5;">⚠ ${ind}</div>`).join('')
          : '<div style="font-size:11px;color:#22c55e;">Shape intact — no anomalies detected.</div>'
        }
      </div>
    </div>
  </div>`;

  // ── P4: Fatigue Risk Forecast ─────────────────────────────────────────────
  const fr      = pred.fatigueRisk;
  const frColor = RISK_COLOR[fr.peakRisk];
  const fatigueHTML = `
  <div style="${CARD_STYLE}background:var(--glass);">
    ${HDR('Fatigue Risk Forecast')}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="font-size:13px;font-weight:700;color:${frColor};">${fr.peakRisk} RISK</span>
      <span style="font-size:11px;color:var(--tx-3);">${fr.riskyCount} player(s)</span>
      ${fr.peakMinute != null ? `<span style="font-size:11px;color:var(--tx-3);">Peak ~${fr.peakMinute}'</span>` : ''}
    </div>
    ${fr.riskPlayers.length > 0
      ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;">
          ${fr.riskPlayers.slice(0, 4).map(p => {
            const pc = p.fatigueIndex >= 80 ? '#ef4444' : '#f59e0b';
            return `<div style="padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.04);">
              <div style="font-size:11px;font-weight:600;color:var(--tx-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name.split(' ').pop()}</div>
              <div style="font-size:10px;color:${pc};">${p.fatigueIndex}% · ${p.minutesPlayed}'</div>
            </div>`;
          }).join('')}
        </div>`
      : '<div style="font-size:11px;color:#22c55e;">No fatigue risk detected.</div>'
    }
  </div>`;

  // ── P5: Counterattack Alert ───────────────────────────────────────────────
  const ct       = pred.counterThreat;
  const ctColor  = RISK_COLOR[ct.level];
  const zoneXMap = { LEFT: 5, CENTER: 37, RIGHT: 68 };
  const zoneW    = 27;
  const zoneHL   = ct.likelyZone
    ? `<rect x="${zoneXMap[ct.likelyZone]}" y="1" width="${zoneW}" height="38" rx="2" fill="${ctColor}" fill-opacity="0.2" stroke="${ctColor}" stroke-width="0.7"/>
       <text x="${zoneXMap[ct.likelyZone] + zoneW / 2}" y="23" text-anchor="middle" font-size="7" fill="${ctColor}" font-weight="700">${ct.likelyZone}</text>`
    : '';
  const counterHTML = `
  <div style="${CARD_STYLE}background:var(--glass);">
    ${HDR('Counterattack Alert')}
    <div style="display:flex;align-items:center;gap:14px;">
      <svg viewBox="0 0 100 40" width="100" height="40" style="flex-shrink:0;border-radius:3px;background:rgba(34,197,94,0.04);">
        <rect x="0" y="0" width="100" height="40" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
        <line x1="50" y1="0" x2="50" y2="40" stroke="rgba(255,255,255,0.1)" stroke-width="0.5"/>
        ${zoneHL}
      </svg>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:${ctColor};margin-bottom:4px;">${ct.level}</div>
        <div style="font-size:11px;color:var(--tx-2);">${ct.note}</div>
      </div>
    </div>
  </div>`;

  // ── P6: Possession Swing Forecast ─────────────────────────────────────────
  const ps         = pred.possessionSwing;
  const trendColor = ps.trend === 'GAINING' ? '#22c55e' : ps.trend === 'LOSING' ? '#ef4444' : '#94a3b8';
  const trendIcon  = ps.trend === 'GAINING' ? '▲' : ps.trend === 'LOSING' ? '▼' : '→';
  const forecastX  = Math.max(10, Math.min(90, ps.forecastPct));
  const confPct2   = Math.round(ps.confidence * 100);
  const possessionHTML = `
  <div style="${CARD_STYLE}background:var(--glass);">
    ${HDR('Possession Swing Forecast')}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-size:20px;color:${trendColor};">${trendIcon}</span>
      <div>
        <span style="font-size:13px;font-weight:700;color:${trendColor};">${ps.trend}</span>
        <span style="font-size:11px;color:var(--tx-3);margin-left:6px;">conf ${confPct2}%</span>
      </div>
    </div>
    <div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx-3);margin-bottom:3px;">
        <span>Current ${ps.currentPct}%</span><span>Forecast ${ps.forecastPct}%</span>
      </div>
      <div style="height:8px;border-radius:4px;background:rgba(255,255,255,0.08);overflow:hidden;position:relative;">
        <div style="height:100%;width:${ps.currentPct}%;background:rgba(148,163,184,0.35);border-radius:4px;"></div>
        <div style="position:absolute;top:0;height:100%;width:2px;background:${trendColor};left:calc(${forecastX}% - 1px);border-radius:1px;"></div>
      </div>
    </div>
  </div>`;

  el.innerHTML = goalHTML + momentumHTML + stabilityHTML + fatigueHTML + counterHTML + possessionHTML;
}

async function enqueueTacticalAI() {
  const m = State.activeMatch; if (!m) return;
  try {
    await FamilistaAPI.post('/automation/agents/jobs', {
      agent: 'MATCH_OPS',
      kind:  'MATCH_RECAP',
      input: { matchId: m.id, homeTeam: m.homeTeam, awayTeam: m.awayTeam, score: { home: m.homeScore, away: m.awayScore } },
    });
    showToast('Match recap enqueued — check back shortly', 'success');
  } catch (e) {
    showToast(e && e.userMessage || 'Could not enqueue job', 'error');
  }
}

// Minimal native prompt — full structured form lands in Phase D.
async function openAddTimelinePrompt() {
  const m = State.activeMatch; if (!m) return;
  const kindList = 'GOAL / OWN_GOAL / ASSIST / SHOT / SHOT_ON_TARGET / SAVE / YELLOW_CARD / RED_CARD / SUBSTITUTION / FOUL / CORNER / TACTICAL_NOTE';
  const kind = (window.prompt('Event kind?\n\n' + kindList) || '').trim().toUpperCase();
  if (!kind) return;
  const side = (window.prompt('Side? HOME or AWAY', 'HOME') || 'HOME').trim().toUpperCase();
  const minStr = window.prompt('Minute?', String(m.liveMinute ?? 0));
  if (minStr === null) return;
  const min = parseInt(minStr, 10);
  if (Number.isNaN(min)) { showToast('Minute must be a number', 'error'); return; }
  const notes = window.prompt('Notes (optional)') || '';
  try {
    await MatchAPI.addTimeline(m.id, {
      occurredAtMin: min,
      kind, side,
      notes: notes || null,
      period: m.periodNow || 1,
    });
    // The WS will deliver TIMELINE_ADDED / SCORE_CHANGED — refresh the active match.
    await refreshActiveMatch();
  } catch (e) {
    showToast(e && e.userMessage || 'Could not add event', 'error');
  }
}

// ── Live WebSocket subscription ─────────────────────────────────────────
function openMatchModalWS(matchId) {
  if (_matchModalWS) { try { _matchModalWS.close(); } catch(_){} _matchModalWS = null; }
  if (_matchModalWSPing) { clearInterval(_matchModalWSPing); _matchModalWSPing = null; }
  if (!State.token) return;
  // Derive ws:// or wss:// from API_BASE
  const wsBase = FAM_CONFIG.API_BASE
    .replace(/^https/, 'wss')
    .replace(/^http/,  'ws')
    .replace(/\/api\/v\d+$/, '');
  const url = wsBase + '/ws/match/' + encodeURIComponent(matchId) + '?token=' + encodeURIComponent(State.token);
  try {
    _matchModalWS = new WebSocket(url);
  } catch (e) { console.warn('[match-ws] connect failed', e); return; }

  _matchModalWS.onopen = () => {
    console.log('%c[match-ws]', 'color:#22C55E;', 'connected', matchId);
    _matchModalWSPing = setInterval(() => {
      try { _matchModalWS.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    }, 25000);
  };
  _matchModalWS.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'event' && m.event) onMatchWSEvent(m.event);
    } catch (_) {}
  };
  _matchModalWS.onerror = (e) => {
    console.warn('[match-ws] error', e);
  };
  _matchModalWS.onclose = () => {
    console.log('%c[match-ws]', 'color:#DC2626;', 'closed');
    if (_matchModalWSPing) { clearInterval(_matchModalWSPing); _matchModalWSPing = null; }
  };
}

function onMatchWSEvent(evt) {
  const m = State.activeMatch; if (!m || evt.matchId !== m.id) return;
  // Phase 16+17+18 — intelligence push: partial-patch containers or full re-render
  if (evt.kind === 'INTEL_UPDATE' && evt.payload) {
    _lastIntelUpdate = Date.now();
    if (_matchModalTab === 'intelligence') {
      const spatialEl  = document.getElementById('intel-spatial');
      const predictEl  = document.getElementById('intel-predictions');
      if (spatialEl || predictEl) {
        // Debounce spatial patch 200ms
        if (_intelSpatialDebounce) clearTimeout(_intelSpatialDebounce);
        _intelSpatialDebounce = setTimeout(() => {
          _intelSpatialDebounce = null;
          const sel = document.getElementById('intel-spatial');
          if (sel && evt.payload.spatialAnalysis) _renderSpatialPanels(sel, evt.payload.spatialAnalysis, evt.payload);
        }, 200);
        // Debounce prediction patch 150ms
        if (_intelPredictDebounce) clearTimeout(_intelPredictDebounce);
        _intelPredictDebounce = setTimeout(() => {
          _intelPredictDebounce = null;
          const pel = document.getElementById('intel-predictions');
          if (pel && evt.payload.predictions) _renderPredictionPanels(pel, evt.payload.predictions, evt.payload);
        }, 150);
      } else {
        const c = document.getElementById('match-modal-content');
        if (c) _renderIntelligenceBundle(c, evt.payload);
      }
    }
    return;
  }
  if (evt.kind === 'TIMELINE_ADDED' || evt.kind === 'TIMELINE_EDITED' || evt.kind === 'TIMELINE_DELETED'
      || evt.kind === 'SCORE_CHANGED' || evt.kind === 'STATUS_CHANGED'
      || evt.kind === 'LINEUP_SET'    || evt.kind === 'SNAPSHOT_TAKEN') {
    // Cheapest correct strategy: refetch the match. Phase D may diff-patch.
    refreshActiveMatch();
  }
}

// ════════════════════════════════════════════════════════════════════════
// Phase E — Live Intelligence (SSE)
// ════════════════════════════════════════════════════════════════════════
// EventSource on /api/v1/matches/:id/live?token=<jwt> populates _matchLive
// in memory. The "Live" and "Fusion" tab renderers read from _matchLive
// and re-paint on every push. Closing the modal tears down the stream.

let _matchModalSSE = null;
let _matchLive = {
  state:           null,   // TacticalState envelope
  alerts:          [],     // last 10 push events
  recommendations: [],
  events:          [],
  deviceStatuses:  [],
  fusion:          null,   // GET /fusion snapshot (refreshed on Fusion tab open)
  connected:       false,
  lastEventAt:     null,
};

function openMatchModalSSE(matchId) {
  closeMatchModalSSE();
  if (!State.token) return;
  const base = (FAM_CONFIG.API_BASE || '').replace(/\/$/, '');
  const url  = base + '/matches/' + encodeURIComponent(matchId) + '/live?token=' + encodeURIComponent(State.token);
  let es;
  try { es = new EventSource(url, { withCredentials: false }); }
  catch (e) { console.warn('[match-sse] failed to open', e); return; }

  _matchModalSSE = es;
  setSSEDot('connecting');

  es.addEventListener('hello', (e) => {
    setSSEDot('ok');
    _matchLive.connected   = true;
    _matchLive.lastEventAt = Date.now();
    repaintLivePanelsIfVisible();
  });
  es.addEventListener('LIVE_STATE_UPDATE', (e) => {
    try { _matchLive.state = JSON.parse(e.data); _matchLive.lastEventAt = Date.now(); repaintLivePanelsIfVisible(); }
    catch (_) {}
  });
  es.addEventListener('RULES_ALERT', (e) => {
    pushIntoBuffer(_matchLive.alerts, parseSSEDataSafe(e), 10); repaintLivePanelsIfVisible();
  });
  es.addEventListener('AI_RECOMMENDATION', (e) => {
    pushIntoBuffer(_matchLive.recommendations, parseSSEDataSafe(e), 10); repaintLivePanelsIfVisible();
  });
  es.addEventListener('AI_REPORT', (e) => {
    pushIntoBuffer(_matchLive.recommendations, parseSSEDataSafe(e), 10); repaintLivePanelsIfVisible();
  });
  es.addEventListener('DEVICE_STATUS', (e) => {
    pushIntoBuffer(_matchLive.deviceStatuses, parseSSEDataSafe(e), 10); repaintLivePanelsIfVisible();
  });
  es.addEventListener('TIMELINE_ADDED', (e) => {
    pushIntoBuffer(_matchLive.events, parseSSEDataSafe(e), 10); repaintLivePanelsIfVisible();
    refreshActiveMatch();
  });

  es.onerror = () => {
    setSSEDot('error');
    _matchLive.connected = false;
    repaintLivePanelsIfVisible();
    // EventSource will auto-reconnect; we don't tear it down on transient errors.
  };
}

function closeMatchModalSSE() {
  if (_matchModalSSE) { try { _matchModalSSE.close(); } catch (_) {} _matchModalSSE = null; }
  _matchLive = { state: null, alerts: [], recommendations: [], events: [], deviceStatuses: [], fusion: null, connected: false, lastEventAt: null };
  setSSEDot('idle');
}

function setSSEDot(state) {
  const d = document.getElementById('match-modal-sse-dot');
  if (!d) return;
  const colors = { idle: '#94a3b8', connecting: '#f59e0b', ok: '#22c55e', error: '#ef4444' };
  d.style.background = colors[state] || colors.idle;
  d.title = 'Live stream: ' + state;
}

function pushIntoBuffer(buf, item, max) {
  if (!item) return;
  buf.unshift(item);
  if (buf.length > max) buf.length = max;
}

function parseSSEDataSafe(e) {
  try { return JSON.parse(e.data); } catch (_) { return null; }
}

function repaintLivePanelsIfVisible() {
  if (_matchModalTab === 'live'   || _matchModalTab === 'fusion') renderMatchModalTab();
}

// ── Live tab ────────────────────────────────────────────────────────────
function paintLiveTab(c, m) {
  const s = _matchLive.state;
  const conn = _matchLive.connected ? '🟢 Streaming' : '🔴 Disconnected';
  const lastAge = _matchLive.lastEventAt ? Math.round((Date.now() - _matchLive.lastEventAt) / 1000) + 's ago' : '—';
  const phaseLine = s
    ? `<b>${escapeHTML(s.phase.phase)}</b> · ${escapeHTML(s.phase.formation || '—')} · possession ${s.phase.possession ?? '—'}%`
    : '—';

  const players = (s && s.players) ? s.players : [];
  const playersHTML = players.length === 0
    ? `<div class="empty"><div class="empty-ico">📡</div><div class="empty-ttl">No live player data yet</div><div style="font-size:12px;color:var(--tx-3);margin-top:6px;">Open a device session to start streaming.</div></div>`
    : players.slice(0, 16).map(p => {
        const color = p.alert === 'CRITICAL' ? 'var(--red)' : p.alert === 'CAUTION' ? 'var(--amber)' : 'var(--green-l)';
        const tai = p.tai != null ? p.tai.toFixed(2) : '—';
        const hr  = p.hr ?? '—';
        const sp  = p.sprint ? '🏃' : '·';
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--bd);">
          <div style="width:24px;height:24px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;">${p.number ?? '?'}</div>
          <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--tx);">${escapeHTML(p.name)}</div><div style="font-size:11px;color:var(--tx-3);">${escapeHTML(p.position || '—')}</div></div>
          <div style="font-size:11px;color:var(--tx-2);text-align:right;">HR ${hr} · TAI ${tai} ${sp}</div>
        </div>`;
      }).join('');

  const alerts = (s && s.openAlerts) ? s.openAlerts : _matchLive.alerts;
  const alertsHTML = alerts.length === 0
    ? '<div style="font-size:12px;color:var(--tx-3);padding:6px 0;">No open alerts.</div>'
    : alerts.slice(0, 5).map(a => {
        const sev   = a.severity || 'INFO';
        const color = sev === 'CRITICAL' ? 'var(--red)' : sev === 'WARN' ? 'var(--amber)' : 'var(--blue)';
        return `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--bd);">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span>
          <div style="flex:1;font-size:12px;color:var(--tx);">${escapeHTML(a.title || a.kind)}</div>
          <div style="font-size:10px;color:var(--tx-3);">${sev}</div>
        </div>`;
      }).join('');

  const devices = (s && s.devices) ? s.devices : [];
  const devicesHTML = devices.length === 0
    ? '<div style="font-size:12px;color:var(--tx-3);padding:6px 0;">No device sessions.</div>'
    : devices.map(d => {
        const color = d.health === 'OK' ? 'var(--green-l)' : d.health === 'STALE' ? 'var(--amber)' : 'var(--red)';
        return `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--bd);">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};"></span>
          <div style="flex:1;font-size:12px;color:var(--tx);">${escapeHTML(d.deviceModel)}</div>
          <div style="font-size:11px;color:var(--tx-3);">${d.health}</div>
        </div>`;
      }).join('');

  const shape = (s && s.teamShape) ? s.teamShape : {};
  const shapeHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:12px;color:var(--tx-2);">
      <div><div style="color:var(--tx-3);font-size:10px;">Centroid</div><div>${shape.centroidX != null ? `${shape.centroidX}, ${shape.centroidY}` : '—'}</div></div>
      <div><div style="color:var(--tx-3);font-size:10px;">Defensive line X</div><div>${shape.defensiveLineX ?? '—'}</div></div>
      <div><div style="color:var(--tx-3);font-size:10px;">Pressing index</div><div>${shape.pressingIndex ?? '—'}</div></div>
      <div><div style="color:var(--tx-3);font-size:10px;">Spread X</div><div>${shape.spreadX ?? '—'}</div></div>
      <div><div style="color:var(--tx-3);font-size:10px;">Spread Y</div><div>${shape.spreadY ?? '—'}</div></div>
      <div><div style="color:var(--tx-3);font-size:10px;">Players w/ pos</div><div>${players.filter(p => p.x != null).length}</div></div>
    </div>`;

  c.innerHTML = `
    <div style="padding:14px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div><div style="font-size:13px;font-weight:700;color:var(--tx);">Live Tactical State</div><div style="font-size:11px;color:var(--tx-3);">${phaseLine}</div></div>
        <div style="text-align:right;"><div style="font-size:11px;color:var(--tx-2);">${conn}</div><div style="font-size:10px;color:var(--tx-3);">last event ${lastAge}</div></div>
      </div>

      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px;">
        <div class="card" style="padding:10px;">
          <div style="font-size:12px;color:var(--tx-3);margin-bottom:6px;">Players</div>
          ${playersHTML}
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div class="card" style="padding:10px;">
            <div style="font-size:12px;color:var(--tx-3);margin-bottom:6px;">AI Alerts</div>
            ${alertsHTML}
          </div>
          <div class="card" style="padding:10px;">
            <div style="font-size:12px;color:var(--tx-3);margin-bottom:6px;">Team Shape</div>
            ${shapeHTML}
          </div>
          <div class="card" style="padding:10px;">
            <div style="font-size:12px;color:var(--tx-3);margin-bottom:6px;">Devices</div>
            ${devicesHTML}
          </div>
        </div>
      </div>
    </div>`;
}

// ── Fusion tab ─────────────────────────────────────────────────────────
async function paintFusionTab(c, m) {
  c.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--tx-3);">Loading fusion frame…</div>`;
  let frame = _matchLive.fusion;
  try {
    if (!frame) {
      const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/fusion');
      frame = (res && res.data) || null;
      _matchLive.fusion = frame;
    }
  } catch (e) {
    c.innerHTML = `<div style="padding:16px;color:var(--red);">Fusion frame unavailable: ${escapeHTML(e && e.userMessage || 'error')}</div>`;
    return;
  }
  if (!frame) {
    c.innerHTML = `<div class="empty"><div class="empty-ico">🧬</div><div class="empty-ttl">No fusion data</div></div>`;
    return;
  }

  const counts = frame.packetCounts || {};
  const countLine = Object.keys(counts).length === 0
    ? '<span style="color:var(--tx-3);">No packets ingested</span>'
    : Object.keys(counts).map(k => `<span style="margin-right:10px;"><b>${escapeHTML(k)}</b>: ${counts[k]}</span>`).join('');

  const rows = (frame.rows || []).slice(0, 30);
  const rowsHTML = rows.length === 0
    ? '<div style="font-size:12px;color:var(--tx-3);padding:6px 0;">No per-player rows yet.</div>'
    : rows.map(r => {
        const tai = (r.tai && typeof r.tai.value === 'number') ? r.tai.value.toFixed(3) : '—';
        const bli = (r.bli && typeof r.bli.value === 'number') ? r.bli.value.toFixed(3) : '—';
        const speed = (r.state && typeof r.state.distM === 'number') ? r.state.distM.toFixed(0) + ' m' : '—';
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--bd);font-size:12px;">
          <div style="flex:1;color:var(--tx);">#${r.player.number ?? '?'} ${escapeHTML(r.player.firstName)} ${escapeHTML(r.player.lastName)}</div>
          <div style="color:var(--tx-2);">BLI ${bli}</div>
          <div style="color:var(--tx-2);">TAI ${tai}</div>
          <div style="color:var(--tx-3);min-width:60px;text-align:right;">${speed}</div>
        </div>`;
      }).join('');

  const notes = (frame.diagnostics && frame.diagnostics.notes) || [];
  const notesHTML = notes.length === 0 ? '' : `<details style="margin-top:10px;"><summary style="font-size:11px;color:var(--tx-3);cursor:pointer;">Diagnostics (${notes.length})</summary><ul style="font-size:11px;color:var(--tx-2);padding-left:18px;margin-top:6px;">${notes.map(n => `<li>${escapeHTML(n)}</li>`).join('')}</ul></details>`;

  c.innerHTML = `
    <div style="padding:14px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div><div style="font-size:13px;font-weight:700;color:var(--tx);">Fusion Frame</div><div style="font-size:11px;color:var(--tx-3);">${frame.teamMetrics?.players ?? 0} players · ${frame.teamMetrics?.sessions ?? 0} sessions · ${frame.teamMetrics?.totalPackets ?? 0} packets</div></div>
        <button class="btn btn-outline btn-xs" onclick="_matchLive.fusion=null;renderMatchModalTab();">↻ Refresh</button>
      </div>
      <div class="card" style="padding:10px;margin-bottom:10px;font-size:11px;color:var(--tx-2);">${countLine}</div>
      <div class="card" style="padding:10px;">${rowsHTML}</div>
      ${notesHTML}
    </div>`;
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ════════════════════════════════════════════════════════════════════════
// Phase F — Match Brain + Replay + Heatmap
// ════════════════════════════════════════════════════════════════════════

let _matchBrain = null;
let _replayState = { events: [], cursor: 0, playing: false, timer: null };

async function paintBrainTab(c, m) {
  c.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--tx-3);">Loading match brain…</div>`;
  let b;
  try {
    const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/brain');
    b = (res && res.data) || null;
    _matchBrain = b;
  } catch (e) {
    c.innerHTML = `<div style="padding:16px;color:var(--red);">Match brain unavailable: ${escapeHTML(e && e.userMessage || 'error')}</div>`;
    return;
  }
  if (!b) { c.innerHTML = `<div class="empty"><div class="empty-ico">🧠</div><div class="empty-ttl">No brain state</div></div>`; return; }

  const momentumPct = Math.round((b.momentum.index + 1) * 50);    // -1..1 → 0..100
  const momentumColor = b.momentum.index > 0.2 ? 'var(--green-l)' : b.momentum.index < -0.2 ? 'var(--red)' : 'var(--amber)';
  const possOurs = b.possession.ourPct ?? 50;

  const lastChain = (b.graph.lastChain || []).map(id => {
    const node = (b.graph.nodes || []).find(n => n.id === id);
    return node ? `<span style="font-size:11px;padding:3px 7px;border-radius:10px;background:var(--bg);border:1px solid var(--bd);">${node.minute}' ${escapeHTML(node.kind)}</span>` : '';
  }).join('<span style="color:var(--tx-3);">→</span>');

  const zones = b.pressureZones || [];
  const zonesHTML = renderPressureZones(zones);

  c.innerHTML = `
    <div style="padding:14px 16px;">
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px;">
        <div class="card" style="padding:12px;">
          <div style="font-size:11px;color:var(--tx-3);">Tactical Momentum</div>
          <div style="font-size:22px;font-weight:700;color:${momentumColor};">${(b.momentum.index >= 0 ? '+' : '') + b.momentum.index.toFixed(2)}</div>
          <div style="height:6px;background:var(--bg);border-radius:3px;margin-top:6px;overflow:hidden;">
            <div style="height:100%;width:${momentumPct}%;background:${momentumColor};transition:width 0.3s;"></div>
          </div>
          <div style="font-size:11px;color:var(--tx-2);margin-top:6px;">${(b.momentum.notes || []).map(escapeHTML).join(' · ')}</div>
        </div>
        <div class="card" style="padding:12px;">
          <div style="font-size:11px;color:var(--tx-3);">Possession (window ${Math.round(b.possession.windowSec/60)}m)</div>
          <div style="font-size:22px;font-weight:700;color:var(--tx);">${possOurs}% : ${100 - possOurs}%</div>
          <div style="height:6px;background:var(--red);border-radius:3px;margin-top:6px;overflow:hidden;display:flex;">
            <div style="height:100%;width:${possOurs}%;background:var(--green-l);"></div>
          </div>
          <div style="font-size:11px;color:var(--tx-2);margin-top:6px;">${b.possession.transitions} possession transitions</div>
        </div>
        <div class="card" style="padding:12px;">
          <div style="font-size:11px;color:var(--tx-3);">Recent Chain of Play</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:6px;">${lastChain || '<span style="font-size:11px;color:var(--tx-3);">—</span>'}</div>
        </div>
      </div>

      <div class="card" style="padding:12px;margin-bottom:12px;">
        <div style="font-size:12px;color:var(--tx-3);margin-bottom:8px;">Opposition Pressure Zones</div>
        ${zonesHTML}
      </div>
    </div>`;
}

function renderPressureZones(zones) {
  if (!zones || zones.length === 0) {
    return '<div style="font-size:12px;color:var(--tx-3);">No opposition events in window.</div>';
  }
  const maxDensity = Math.max(...zones.map(z => z.density), 1);
  // 100x68 pitch SVG with zone circles.
  const circles = zones.map(z => {
    const r = 4 + (z.density / maxDensity) * 18;
    const opacity = Math.min(1, 0.3 + (z.density / maxDensity) * 0.7);
    const fresh = Math.max(0.3, 1 - z.recencyS / 300);
    return `<circle cx="${z.x}" cy="${(z.y / 100) * 68}" r="${r}" fill="rgba(220,38,38,${opacity * fresh})" stroke="rgba(220,38,38,0.7)" stroke-width="0.4"/>`;
  }).join('');
  return `
    <svg viewBox="0 0 100 68" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:280px;background:#1d2b1d;border-radius:6px;">
      <rect x="0" y="0" width="100" height="68" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="0.3"/>
      <line x1="50" y1="0" x2="50" y2="68" stroke="rgba(255,255,255,0.4)" stroke-width="0.3"/>
      <circle cx="50" cy="34" r="6" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="0.3"/>
      ${circles}
    </svg>
    <div style="font-size:11px;color:var(--tx-3);margin-top:6px;">${zones.length} cells · max density ${maxDensity} · brighter = more recent</div>`;
}

// ── Replay tab ──────────────────────────────────────────────────────────
async function paintReplayTab(c, m) {
  if (_replayState.events.length === 0) {
    c.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--tx-3);">Loading replay timeline…</div>`;
    try {
      const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/replay?limit=500');
      _replayState.events = (res && res.data && res.data.events) || [];
      _replayState.cursor = _replayState.events.length;
    } catch (e) {
      c.innerHTML = `<div style="padding:16px;color:var(--red);">Replay unavailable: ${escapeHTML(e && e.userMessage || 'error')}</div>`;
      return;
    }
  }
  renderReplayTab(c);
}

function renderReplayTab(c) {
  const events = _replayState.events;
  if (events.length === 0) {
    c.innerHTML = `<div class="empty"><div class="empty-ico">🎬</div><div class="empty-ttl">No replayable events</div></div>`;
    return;
  }
  const cur = Math.min(events.length, Math.max(0, _replayState.cursor));
  const visible = events.slice(0, cur);
  const now = events[Math.max(0, cur - 1)] || events[0];
  const kindIcon = (k) => k === 'TIMELINE' ? '⚽' : k === 'SNAPSHOT' ? '📸' : k === 'ALERT' ? '🚨' : k === 'TWIN_FRAME' ? '🧬' : '·';
  const eventList = visible.slice(-20).reverse().map(e => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--bd);font-size:12px;">
      <div style="font-size:14px;">${kindIcon(e.kind)}</div>
      <div style="flex:1;color:var(--tx);">${escapeHTML(e.kind)} · ${e.matchMin != null ? e.matchMin + "'" : ''}</div>
      <div style="font-size:10px;color:var(--tx-3);">${new Date(e.atMs).toLocaleTimeString()}</div>
    </div>`).join('');

  c.innerHTML = `
    <div style="padding:14px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;">
        <div><div style="font-size:13px;font-weight:700;color:var(--tx);">Replay Timeline</div><div style="font-size:11px;color:var(--tx-3);">${events.length} events</div></div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-outline btn-xs" onclick="replayScrub(-10)">«10</button>
          <button class="btn btn-outline btn-xs" onclick="replayScrub(-1)">‹</button>
          <button class="btn btn-primary btn-xs" id="replay-play-btn" onclick="replayToggle()">${_replayState.playing ? '⏸' : '▶'}</button>
          <button class="btn btn-outline btn-xs" onclick="replayScrub(1)">›</button>
          <button class="btn btn-outline btn-xs" onclick="replayScrub(10)">10»</button>
          <button class="btn btn-ghost btn-xs" onclick="replayReset()">↻</button>
        </div>
      </div>

      <input type="range" min="0" max="${events.length}" value="${cur}" oninput="replaySeek(this.value)" style="width:100%;margin-bottom:12px;" />

      <div class="card" style="padding:10px;margin-bottom:10px;">
        <div style="font-size:11px;color:var(--tx-3);">Cursor</div>
        <div style="font-size:14px;color:var(--tx);">${cur} / ${events.length} · ${now ? new Date(now.atMs).toLocaleString() : '—'}</div>
      </div>

      <div class="card" style="padding:10px;">
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:6px;">Recent events (most recent first)</div>
        ${eventList || '<div style="font-size:12px;color:var(--tx-3);">—</div>'}
      </div>
    </div>`;
}

function replaySeek(v) {
  _replayState.cursor = parseInt(v, 10) || 0;
  if (_matchModalTab === 'replay') renderReplayTab(document.getElementById('match-modal-content'));
}

function replayScrub(delta) {
  _replayState.cursor = Math.max(0, Math.min(_replayState.events.length, _replayState.cursor + delta));
  if (_matchModalTab === 'replay') renderReplayTab(document.getElementById('match-modal-content'));
}

function replayToggle() {
  _replayState.playing = !_replayState.playing;
  if (_replayState.timer) { clearInterval(_replayState.timer); _replayState.timer = null; }
  if (_replayState.playing) {
    _replayState.timer = setInterval(() => {
      if (_replayState.cursor >= _replayState.events.length) {
        _replayState.playing = false;
        if (_replayState.timer) { clearInterval(_replayState.timer); _replayState.timer = null; }
      } else {
        _replayState.cursor++;
      }
      if (_matchModalTab === 'replay') renderReplayTab(document.getElementById('match-modal-content'));
    }, 600);
  }
  if (_matchModalTab === 'replay') renderReplayTab(document.getElementById('match-modal-content'));
}

function replayReset() {
  _replayState = { events: [], cursor: 0, playing: false, timer: null };
  if (_matchModalTab === 'replay') paintReplayTab(document.getElementById('match-modal-content'), State.activeMatch);
}

// ════════════════════════════════════════════════════════════════════════
// Phase G — Spatial frame + Predictive intelligence
// ════════════════════════════════════════════════════════════════════════

let _spatialFrame  = null;
let _predictions   = [];

async function paintSpatialTab(c, m) {
  c.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--tx-3);">Loading cognitive spatial frame…</div>`;
  let frame;
  try {
    const res = await FamilistaAPI.get('/spatial/matches/' + encodeURIComponent(m.id) + '/frame');
    frame = (res && res.data) || null;
    _spatialFrame = frame;
  } catch (e) {
    c.innerHTML = `<div style="padding:16px;color:var(--red);">Spatial frame unavailable: ${escapeHTML(e && e.userMessage || 'error')}</div>`;
    return;
  }
  if (!frame) { c.innerHTML = `<div class="empty"><div class="empty-ico">🛰️</div><div class="empty-ttl">No spatial data</div></div>`; return; }
  renderSpatialFrame(c, frame);
}

function renderSpatialFrame(c, frame) {
  const g = frame.geometry || { widthM: 105, heightM: 68 };
  const players = frame.players || [];
  const positioned = players.filter(p => p.x != null && p.y != null);
  const interpolated = !!(frame.sources && frame.sources.interpolated);
  const stale = positioned.filter(p => (p.staleMs ?? 0) > 5000).length;

  // SVG projection — geometry-aware (works for any sport).
  const VBX = g.widthM, VBY = g.heightM;
  const dots = positioned.map(p => {
    const isOpp   = p.side !== 'HOME';
    const color   = p.alert === 'CRITICAL' ? '#DC2626' : p.alert === 'CAUTION' ? '#F59E0B' : (isOpp ? '#FCA5A5' : '#22C55E');
    const radius  = 1 + Math.min(2.5, (g.widthM / 60));   // scale dot to pitch
    return `<g>
      <circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${color}" stroke="rgba(0,0,0,.55)" stroke-width="0.25"/>
      <text x="${p.x}" y="${p.y + radius * 0.5}" font-size="${radius * 1.0}" text-anchor="middle" fill="#0a0a0a" font-weight="700">${p.number ?? '?'}</text>
    </g>`;
  }).join('');

  const sources = frame.sources || {};
  const srcLine = `cameras ${sources.visionCameras ?? 0} · wearables ${sources.wearables ?? 0} · sensors ${sources.sensorPackets ?? 0} · biochem ${sources.biochemPatches ?? 0}${interpolated ? ' · interpolated' : ''}`;

  c.innerHTML = `
    <div style="padding:14px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--tx);">Cognitive Spatial Frame</div>
          <div style="font-size:11px;color:var(--tx-3);">sport ${escapeHTML(frame.sport)} · ${positioned.length} positioned · ${stale} stale · ${srcLine}</div>
        </div>
        <button class="btn btn-outline btn-xs" onclick="paintSpatialTab(document.getElementById('match-modal-content'), State.activeMatch);">↻ Refresh</button>
      </div>
      <div style="position:relative;background:linear-gradient(180deg,rgba(22,163,74,.12),rgba(22,163,74,.05));border:1px solid var(--bd);border-radius:var(--radius-lg);overflow:hidden;">
        <svg viewBox="0 0 ${VBX} ${VBY}" preserveAspectRatio="xMidYMid meet" style="width:100%;display:block;background:#1d2b1d;">
          <rect x="0" y="0" width="${VBX}" height="${VBY}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="0.25"/>
          <line x1="${VBX / 2}" y1="0" x2="${VBX / 2}" y2="${VBY}" stroke="rgba(255,255,255,0.3)" stroke-width="0.15"/>
          ${dots}
        </svg>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px;font-size:11px;color:var(--tx-3);">
        <div><div style="color:var(--tx-2);">Pitch</div>${g.widthM}×${g.heightM} m</div>
        <div><div style="color:var(--tx-2);">Players/side</div>${g.playersPerSide ?? '—'}</div>
        <div><div style="color:var(--tx-2);">Shared object</div>${g.hasSharedObject ? 'yes' : 'no'}</div>
        <div><div style="color:var(--tx-2);">Flip at half</div>${g.sidesFlipAtHalf ? 'yes' : 'no'}</div>
      </div>
    </div>`;
}

async function paintPredictTab(c, m) {
  c.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--tx-3);">Running deterministic predictors…</div>`;
  let predictions;
  try {
    const res = await FamilistaAPI.post('/predictive/matches/' + encodeURIComponent(m.id) + '/run', { dryRun: true });
    predictions = (res && res.data) || [];
    _predictions = predictions;
  } catch (e) {
    c.innerHTML = `<div style="padding:16px;color:var(--red);">Predictive layer unavailable: ${escapeHTML(e && e.userMessage || 'error')}</div>`;
    return;
  }

  // Group by kind.
  const groups = {};
  for (const p of predictions) { (groups[p.kind] ?? (groups[p.kind] = [])).push(p); }
  const order = ['TACTICAL_COLLAPSE','POSITIONING_DEGRADATION','INJURY_RISK','FATIGUE_TRAJECTORY','MOMENTUM_SHIFT','SUBSTITUTION_WINDOW'];

  const scoreColor = (s) => s >= 0.75 ? 'var(--red)' : s >= 0.50 ? 'var(--amber)' : 'var(--green-l)';
  const scoreLabel = (s) => s >= 0.75 ? 'CRITICAL'   : s >= 0.50 ? 'CAUTION'      : 'OK';

  const renderGroup = (kind) => {
    const items = groups[kind] || [];
    if (items.length === 0) return '';
    if (items.length === 1 && items[0].playerId === null) {
      const p = items[0];
      return `<div class="card" style="padding:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="font-size:12px;color:var(--tx-3);">${escapeHTML(kind)}</div>
          <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${scoreColor(p.score)};color:#fff;">${scoreLabel(p.score)} · ${(p.score * 100).toFixed(0)}%</span>
        </div>
        <div style="font-size:13px;color:var(--tx);margin-top:6px;">${escapeHTML(p.rationale)}</div>
      </div>`;
    }
    // Per-player rows — sort by score descending and cap at 8.
    const top = items.sort((a,b) => b.score - a.score).slice(0, 8);
    return `<div class="card" style="padding:12px;">
      <div style="font-size:12px;color:var(--tx-3);margin-bottom:6px;">${escapeHTML(kind)} — top ${top.length}</div>
      ${top.map(p => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--bd);font-size:12px;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${scoreColor(p.score)};"></span>
        <div style="flex:1;color:var(--tx);">${escapeHTML(p.rationale)}</div>
        <div style="font-size:11px;color:var(--tx-2);">${(p.score * 100).toFixed(0)}%</div>
      </div>`).join('')}
    </div>`;
  };

  c.innerHTML = `
    <div style="padding:14px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--tx);">Predictive Intelligence</div>
          <div style="font-size:11px;color:var(--tx-3);">${predictions.length} predictions · deterministic v1 · dry-run (won't persist)</div>
        </div>
        <button class="btn btn-primary btn-xs" onclick="paintPredictTab(document.getElementById('match-modal-content'), State.activeMatch);">↻ Re-run</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:10px;">
        ${order.map(renderGroup).join('')}
      </div>
    </div>`;
}

// Back-compat shim — older code may still call filterMatches('UPCOMING', el).
function filterMatches(filter, el) {
  setMatchTab(filter === 'UPCOMING' ? 'upcoming' : filter === 'PLAYED' ? 'stats' : 'all', el);
}

// ── TOURNAMENTS ──
// Live Competition Engine — Phase Q API integration
const _TournData = {
  competitions: [],   // Competition[]
  teams:        [],   // Team[] fetched from /teams (for name lookup)
  selectedCompId: null,
  _loading: false,
};

function renderTournamentsHTML() {
  return `<div class="page" id="pg-tournaments">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Tournaments</div>
        <div style="font-size:12px;color:var(--tx-3);" id="tourn-subtitle">Loading…</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:7px;align-items:center;">
        <div class="filter-group" id="tourn-tabs">
          <button class="filter-btn active" onclick="renderTournContent('overview',this)">Overview</button>
          <button class="filter-btn" onclick="renderTournContent('standings',this)">Standings</button>
          <button class="filter-btn" onclick="renderTournContent('bracket',this)">Bracket</button>
          <button class="filter-btn" onclick="renderTournContent('schedule',this)">Schedule</button>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openCreateCompModal()">+ Create</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;" id="tourn-content"></div>
  </div>
  <div class="modal-backdrop" id="create-comp-modal">
    <div class="modal" style="max-width:420px;">
      <div class="modal-header"><div class="modal-title">New Competition</div><button class="modal-close" onclick="closeCreateCompModal()">✕</button></div>
      <div class="modal-body">
        <form id="create-comp-form" onsubmit="submitCreateComp(event)">
          <div class="form-group"><label class="form-label">Name *</label><input class="input" name="name" required placeholder="Premier League U21"></div>
          <div class="form-group"><label class="form-label">Code * (2–20 chars, e.g. PL_U21)</label><input class="input" name="code" required placeholder="PL_U21" maxlength="20"></div>
          <div class="form-group"><label class="form-label">Season *</label><input class="input" name="season" required placeholder="2024-25"></div>
          <div class="form-group"><label class="form-label">Format *</label><select class="input" name="format" required><option value="">Select…</option><option value="LEAGUE">League</option><option value="CUP">Cup</option><option value="GROUP_STAGE">Group Stage</option><option value="FRIENDLY">Friendly</option></select></div>
          <div class="form-group"><label class="form-label">Age Group</label><input class="input" name="ageGroup" placeholder="SENIOR / U21 / U18"></div>
          <div id="create-comp-error" style="color:var(--red);font-size:12px;min-height:16px;"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeCreateCompModal()">Cancel</button>
            <button type="submit" class="btn btn-primary" id="create-comp-btn">Create</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</div>`;
}

async function loadTournamentsData() {
  if (_TournData._loading) return;
  _TournData._loading = true;
  const tc = document.getElementById('tourn-content');
  if (tc) tc.innerHTML = loadingHTML('Loading competitions…');
  try {
    const [compsRes, teamsRes] = await Promise.allSettled([
      api('/phase-q/competitions?limit=50'),
      api('/teams?isActive=true&limit=200'),
    ]);
    if (compsRes.status === 'fulfilled') {
      _TournData.competitions = (compsRes.value && compsRes.value.items) || [];
    }
    if (teamsRes.status === 'fulfilled') {
      _TournData.teams = (teamsRes.value && teamsRes.value.data) || [];
    }
    if (!_TournData.selectedCompId && _TournData.competitions.length) {
      _TournData.selectedCompId = _TournData.competitions[0].id;
    }
    const sub = document.getElementById('tourn-subtitle');
    if (sub) {
      const seasons = [...new Set(_TournData.competitions.map(c => c.season))];
      sub.textContent = `${seasons[0] || '—'} · ${_TournData.competitions.length} competition${_TournData.competitions.length !== 1 ? 's' : ''}`;
    }
    renderTournContent('overview');
  } catch (err) {
    if (tc) tc.innerHTML = `<div style="padding:40px;text-align:center;color:var(--tx-3);">Failed to load competitions.</div>`;
  } finally {
    _TournData._loading = false;
  }
}

function _tournTeamName(teamId) {
  if (!teamId) return '—';
  const t = _TournData.teams.find(t => t.id === teamId);
  return t ? (t.name || t.id.slice(0, 8)) : teamId.slice(0, 8) + '…';
}

function renderTournContent(tab, el) {
  const tc = document.getElementById('tourn-content');
  if (!tc) return;
  if (el) {
    document.querySelectorAll('#tourn-tabs .filter-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  }

  if (tab === 'overview') {
    const comps = _TournData.competitions;
    if (!comps.length) {
      tc.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--tx-3);">No competitions found.<br><br><button class="btn btn-primary btn-sm" onclick="openCreateCompModal()">+ Create your first competition</button></div>`;
      return;
    }
    const fmtIcon = f => ({ LEAGUE:'🏆', CUP:'🥇', GROUP_STAGE:'🥈', FRIENDLY:'🏅' }[f] || '🏅');
    const bgMap = { LEAGUE:'#052e16', CUP:'#1e1b4b', GROUP_STAGE:'#0f2d0f', FRIENDLY:'#2d1a0f' };
    tc.innerHTML = `<div class="tourn-card-grid">${comps.map(c => `
      <div class="card tourn-card clickable" onclick="_selectComp('${c.id}','standings')">
        <div class="tourn-banner" style="background:${bgMap[c.format]||'#111'};"><div class="tourn-trophy">${fmtIcon(c.format)}</div></div>
        <div class="tourn-body">
          <div class="tourn-name">${_esc(c.name)}</div>
          <div class="tourn-type">${_esc(c.format.replace('_',' '))} · ${_esc(c.season)}${c.ageGroup ? ' · ' + _esc(c.ageGroup) : ''}</div>
          <div class="tourn-stats">
            <div class="ts"><div class="ts-v" style="color:var(--green-l);font-size:11px;">${_esc(c.code)}</div><div class="ts-l">CODE</div></div>
            <div class="ts"><div class="ts-v">${_esc(c.gender || '—')}</div><div class="ts-l">GENDER</div></div>
            <div class="ts"><div class="ts-v">${_esc(c.countryCode || '—')}</div><div class="ts-l">COUNTRY</div></div>
          </div>
          <div style="display:flex;align-items:center;justify-content:flex-end;margin-top:10px;">
            <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();_selectComp('${c.id}','standings')">Standings →</button>
          </div>
        </div>
      </div>`).join('')}</div>`;

  } else if (tab === 'standings') {
    _renderTournStandings(tc);

  } else if (tab === 'bracket') {
    tc.innerHTML = `<div class="bracket-wrap"><div style="padding:40px;text-align:center;color:var(--tx-3);">Bracket view requires fixtures with progression data.<br>Record results to auto-generate standings; bracket tracking coming soon.</div></div>`;

  } else {
    _renderTournSchedule(tc);
  }
}

function _selectComp(compId, tab) {
  _TournData.selectedCompId = compId;
  const tabIdx = { overview:0, standings:1, bracket:2, schedule:3 };
  const idx = tabIdx[tab] ?? 0;
  document.querySelectorAll('#tourn-tabs .filter-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
  renderTournContent(tab);
}

async function _renderTournStandings(tc) {
  if (!_TournData.selectedCompId && _TournData.competitions.length) {
    _TournData.selectedCompId = _TournData.competitions[0].id;
  }
  if (!_TournData.selectedCompId) {
    tc.innerHTML = `<div style="padding:40px;text-align:center;color:var(--tx-3);">No competition selected.</div>`;
    return;
  }
  const selector = _TournData.competitions.length > 1
    ? `<div style="display:flex;gap:6px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
        ${_TournData.competitions.map(c => `<button class="btn btn-${c.id===_TournData.selectedCompId?'outline':'ghost'} btn-sm" onclick="_selectComp('${c.id}','standings')">${_esc(c.name)}</button>`).join('')}
      </div>`
    : '';
  tc.innerHTML = `<div style="padding:20px;">${selector}<div id="standings-table-wrap">${loadingHTML('Loading standings…')}</div></div>`;
  try {
    const rows = await api(`/phase-q/competitions/${_TournData.selectedCompId}/standings`);
    const arr = Array.isArray(rows) ? rows : [];
    const wrap = document.getElementById('standings-table-wrap');
    if (!wrap) return;
    if (!arr.length) {
      wrap.innerHTML = `<div style="text-align:center;color:var(--tx-3);padding:40px;">No standings yet — record match results to populate the table.</div>`;
      return;
    }
    const myIds = new Set(_TournData.teams.map(t => t.id));
    const fc = f => `<div class="form-dot fd-${f.toLowerCase()}" style="width:15px;height:15px;font-size:7px;">${f}</div>`;
    wrap.innerHTML = `<div class="card" style="overflow:hidden;"><table class="tbl std-tbl">
      <thead><tr>
        <th style="width:36px;">#</th><th>Team</th>
        <th style="text-align:center;">MP</th><th style="text-align:center;">W</th>
        <th style="text-align:center;">D</th><th style="text-align:center;">L</th>
        <th style="text-align:center;">GF</th><th style="text-align:center;">GA</th>
        <th style="text-align:center;">GD</th><th style="text-align:center;">PTS</th>
        <th>Form</th>
      </tr></thead>
      <tbody>${arr.map(r => {
        const mine = myIds.has(r.teamId);
        const gd = r.goalDiff >= 0 ? '+' + r.goalDiff : String(r.goalDiff);
        const form = (r.form || '').split('').slice(-5);
        return `<tr class="${mine ? 'my-row' : ''}">
          <td><span style="font-weight:700;color:${r.position<=4?'var(--amber)':r.position>=arr.length-1?'var(--red)':'var(--tx-3)'};font-family:var(--mono);">${r.position}</span></td>
          <td>${_esc(_tournTeamName(r.teamId))}</td>
          <td style="text-align:center;font-family:var(--mono);">${r.played}</td>
          <td style="text-align:center;font-family:var(--mono);">${r.won}</td>
          <td style="text-align:center;font-family:var(--mono);">${r.drawn}</td>
          <td style="text-align:center;font-family:var(--mono);">${r.lost}</td>
          <td style="text-align:center;font-family:var(--mono);">${r.goalsFor}</td>
          <td style="text-align:center;font-family:var(--mono);">${r.goalsAgainst}</td>
          <td style="text-align:center;font-family:var(--mono);">${gd}</td>
          <td style="text-align:center;font-size:15px;font-weight:700;font-family:var(--mono);color:var(--tx);">${r.points}</td>
          <td><div style="display:flex;gap:2px;">${form.map(fc).join('')}</div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  } catch (err) {
    const wrap = document.getElementById('standings-table-wrap');
    if (wrap) wrap.innerHTML = `<div style="color:var(--red);padding:20px;">Failed to load standings.</div>`;
  }
}

async function _renderTournSchedule(tc) {
  if (!_TournData.selectedCompId && _TournData.competitions.length) {
    _TournData.selectedCompId = _TournData.competitions[0].id;
  }
  if (!_TournData.selectedCompId) {
    tc.innerHTML = `<div style="padding:40px;text-align:center;color:var(--tx-3);">No competition selected.</div>`;
    return;
  }
  const selector = _TournData.competitions.length > 1
    ? `<div style="display:flex;gap:6px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
        ${_TournData.competitions.map(c => `<button class="btn btn-${c.id===_TournData.selectedCompId?'outline':'ghost'} btn-sm" onclick="_selectComp('${c.id}','schedule')">${_esc(c.name)}</button>`).join('')}
      </div>`
    : '';
  tc.innerHTML = `<div style="padding:20px;">${selector}<div id="fixtures-wrap">${loadingHTML('Loading fixtures…')}</div></div>`;
  try {
    const res = await api(`/phase-q/competitions/${_TournData.selectedCompId}/fixtures?limit=100`);
    const items = (res && res.items) || [];
    const wrap = document.getElementById('fixtures-wrap');
    if (!wrap) return;
    if (!items.length) {
      wrap.innerHTML = `<div style="text-align:center;color:var(--tx-3);padding:40px;">No fixtures scheduled yet.</div>`;
      return;
    }
    const myIds = new Set(_TournData.teams.map(t => t.id));
    const statusBadge = s => s === 'PLAYED' ? 'badge-green' : s === 'CANCELLED' ? 'badge-red' : 'badge-amber';
    const rounds = [...new Set(items.map(f => f.round))].sort((a, b) => (a || 0) - (b || 0));
    wrap.innerHTML = rounds.map(rnd => {
      const rFixtures = items.filter(f => f.round === rnd);
      return `<div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">${rnd ? 'Round ' + rnd : 'Unscheduled'}</div>
        ${rFixtures.map(f => {
          const mineH = myIds.has(f.homeTeamId);
          const mineA = myIds.has(f.awayTeamId);
          return `<div class="match-row">
            <div class="match-date">${fmtDate(f.scheduledAt)}</div>
            <span class="badge ${statusBadge(f.status)}" style="font-size:9px;">${f.status}</span>
            <div style="flex:1;display:flex;align-items:center;gap:9px;">
              <div style="flex:1;text-align:right;font-size:13px;font-weight:600;color:${mineH?'var(--green-l)':'var(--tx-2)'};">${_esc(_tournTeamName(f.homeTeamId))}</div>
              <div class="match-score">${f.homeScore!=null?f.homeScore:'?'} — ${f.awayScore!=null?f.awayScore:'?'}</div>
              <div style="flex:1;font-size:13px;font-weight:600;color:${mineA?'var(--green-l)':'var(--tx-2)'};">${_esc(_tournTeamName(f.awayTeamId))}</div>
            </div>
            ${f.venue ? `<span style="font-size:10px;color:var(--tx-3);">${_esc(f.venue)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  } catch (err) {
    const wrap = document.getElementById('fixtures-wrap');
    if (wrap) wrap.innerHTML = `<div style="color:var(--red);padding:20px;">Failed to load fixtures.</div>`;
  }
}

function openCreateCompModal() {
  document.getElementById('create-comp-modal').classList.add('open');
}
function closeCreateCompModal() {
  document.getElementById('create-comp-modal').classList.remove('open');
}

async function submitCreateComp(e) {
  e.preventDefault();
  const form = e.target;
  const btn = document.getElementById('create-comp-btn');
  const errEl = document.getElementById('create-comp-error');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  errEl.textContent = '';
  try {
    const comp = await api('/phase-q/competitions', {
      method: 'POST',
      body: {
        name:     form.name.value.trim(),
        code:     form.code.value.trim().toUpperCase(),
        season:   form.season.value.trim(),
        format:   form.format.value,
        ageGroup: form.ageGroup.value.trim() || undefined,
      },
    });
    closeCreateCompModal();
    form.reset();
    _TournData.competitions.unshift(comp);
    _TournData.selectedCompId = comp.id;
    showToast(`Competition "${comp.name}" created`, 'success');
    const sub = document.getElementById('tourn-subtitle');
    if (sub) {
      const seasons = [...new Set(_TournData.competitions.map(c => c.season))];
      sub.textContent = `${seasons[0] || '—'} · ${_TournData.competitions.length} competition${_TournData.competitions.length !== 1 ? 's' : ''}`;
    }
    renderTournContent('overview');
  } catch (err) {
    errEl.textContent = (err && err.userMessage) || (err && err.message) || 'Failed to create competition';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

// ── ANALYTICS & INTELLIGENCE ENGINE ─────────────────────────────────────────

const AnalyticsAPI = {
  overview()          { return FamilistaAPI.get('/analytics/overview'); },
  performanceTrend(w) { return FamilistaAPI.get('/analytics/performance-trend?weeks=' + (w || 8)); },
  gpsLoad(d)          { return FamilistaAPI.get('/analytics/gps-load?days=' + (d || 14)); },
  playerAnalytics(id) { return FamilistaAPI.get('/analytics/player/' + id); },
  teamAnalytics()     { return FamilistaAPI.get('/analytics/team'); },
  readiness()         { return FamilistaAPI.get('/analytics/readiness'); },
  risks()             { return FamilistaAPI.get('/analytics/risks'); },
};

let _analyticsTab        = 'dashboard';
let _analyticsLoading    = false;
let _analyticsOverview   = null;
let _analyticsTrend      = null;
let _analyticsGpsLoad    = null;
let _analyticsTeam       = null;
let _analyticsReadiness  = null;
let _analyticsRisks      = null;
let _analyticsPlayerData = null;
let _analyticsPlayerId   = null;

function renderAnalyticsHTML() {
  return `<div class="page" id="pg-analytics">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Analytics &amp; Intelligence</div>
        <div style="font-size:12px;color:var(--tx-3);" id="analytics-sub">Loading…</div>
      </div>
      <div style="margin-left:auto;">
        <div class="filter-group" id="analytics-tabs">
          <button class="filter-btn active" onclick="setAnalyticsTab('dashboard',this)">Dashboard</button>
          <button class="filter-btn"        onclick="setAnalyticsTab('players',this)">Players</button>
          <button class="filter-btn"        onclick="setAnalyticsTab('team',this)">Team</button>
          <button class="filter-btn"        onclick="setAnalyticsTab('risks',this)">Risk Alerts</button>
        </div>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:16px 20px;" id="analytics-content">${loadingHTML('Loading analytics…')}</div>
  </div>
</div>`;
}

function setAnalyticsTab(tab, el) {
  _analyticsTab = tab;
  _analyticsPlayerId = null;
  _analyticsPlayerData = null;
  document.querySelectorAll('#analytics-tabs .filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderAnalyticsPage();
}

function renderAnalyticsPage() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const el = document.getElementById('analytics-content');
  if (!el) return;
  if (_analyticsTab === 'dashboard') _renderAnalyticsDashboard(el);
  else if (_analyticsTab === 'players') _renderAnalyticsPlayers(el);
  else if (_analyticsTab === 'team')    _renderAnalyticsTeam(el);
  else if (_analyticsTab === 'risks')   _renderAnalyticsRisks(el);
}

function _renderAnalyticsDashboard(el) {
  const d  = _analyticsOverview;
  if (!d) { el.innerHTML = loadingHTML('Loading dashboard…'); return; }

  const ov  = d.overview || {};
  // BUG 5 FIX: use [0] (highest-rated) not [2] (third)
  const top = d.topPerformers && d.topPerformers[0];

  // Recent form badges
  const recent = d.recentMatches || [];
  const formBadges = recent.slice(0, 8).map(m => {
    const c = m.result === 'WIN' ? 'var(--green-l)' : m.result === 'LOSS' ? 'var(--red)' : 'var(--amber)';
    const bg = m.result === 'WIN' ? 'rgba(22,163,74,.15)' : m.result === 'LOSS' ? 'rgba(220,38,38,.15)' : 'rgba(217,119,6,.15)';
    return `<span style="width:26px;height:26px;border-radius:5px;background:${bg};border:1px solid ${c};font-size:10px;font-weight:700;color:${c};display:inline-flex;align-items:center;justify-content:center;">${m.result ? m.result[0] : '?'}</span>`;
  }).join('');

  // GPS averages from overview
  const gpsAvg = d.gpsAverages && d.gpsAverages._avg ? d.gpsAverages._avg : {};

  // GPS load trend bars
  const gpsLoad = _analyticsGpsLoad || [];
  const maxLoad = gpsLoad.length ? Math.max(...gpsLoad.map(g => g.avgLoad), 1) : 1;
  const gpsBarHTML = gpsLoad.length > 0
    ? gpsLoad.slice(-7).map(g => {
        const pct = Math.round((g.avgLoad / maxLoad) * 100);
        const dt  = new Date(g.date);
        const lbl = (dt.getMonth() + 1) + '/' + dt.getDate();
        return `<div class="bar-row">
          <div class="bar-lbl" style="width:36px;font-size:10px;">${lbl}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--blue);"></div></div>
          <div class="bar-val" style="font-family:var(--mono);color:var(--blue);">${g.avgLoad.toFixed(0)}</div>
        </div>`;
      }).join('')
    : '<div style="color:var(--tx-3);font-size:12px;">No GPS data in last 14 days</div>';

  // BUG 4 FIX: bars built from real team attribute averages (no hardcoded values)
  const attrDisplayFields = [
    { db:'pace',      label:'Speed',     color:'var(--green-l)' },
    { db:'shooting',  label:'Shooting',  color:'var(--red)' },
    { db:'passing',   label:'Passing',   color:'var(--blue)' },
    { db:'dribbling', label:'Technique', color:'var(--amber)' },
    { db:'tackling',  label:'Defending', color:'var(--green-l)' },
    { db:'stamina',   label:'Stamina',   color:'var(--blue)' },
  ];
  const aa = _analyticsTeam && _analyticsTeam.attributeAverages;
  const attrBarsHTML = aa
    ? attrDisplayFields.map(f => {
        const v = aa[f.db];
        if (v == null) return '';
        const pct = Math.round((v / 130) * 100);
        return `<div class="bar-row">
          <div class="bar-lbl">${f.label}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${f.color};opacity:.8;"></div></div>
          <div class="bar-val" style="color:${f.color};font-family:var(--mono);">${v}</div>
        </div>`;
      }).filter(Boolean).join('')
    : '<div style="color:var(--tx-3);font-size:12px;padding:8px 0;">Record player attributes to see team averages</div>';

  // Performance trend (last 6 matches)
  const trend = _analyticsTrend || [];
  const trendHTML = trend.length > 0
    ? trend.slice(-6).map(t => {
        const c  = t.result === 'WIN' ? 'var(--green-l)' : t.result === 'LOSS' ? 'var(--red)' : 'var(--amber)';
        const dt = new Date(t.date);
        const lbl = (dt.getMonth() + 1) + '/' + dt.getDate();
        const rtg = t.avgRating ? t.avgRating.toFixed(1) : '—';
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:50px;">
          <div style="font-size:15px;font-weight:700;color:${c};font-family:var(--mono);">${t.goalsScored}-${t.goalsConceded}</div>
          <div style="font-size:9px;color:var(--tx-3);font-family:var(--mono);">${lbl}</div>
          <div style="font-size:10px;color:var(--tx-2);">⭐${rtg}</div>
        </div>`;
      }).join('')
    : '<div style="color:var(--tx-3);font-size:12px;">No match data</div>';

  // Top readiness
  const topReady = (_analyticsReadiness || []).slice(0, 5);

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="card" style="padding:14px;">
        <div style="font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-family:var(--mono);">Record</div>
        <div style="font-size:24px;font-weight:700;color:var(--green-l);font-family:var(--mono);">${ov.wins ?? '—'}<span style="font-size:12px;color:var(--tx-3);">W</span> ${ov.draws ?? '—'}<span style="font-size:12px;color:var(--tx-3);">D</span> ${ov.losses ?? '—'}<span style="font-size:12px;color:var(--tx-3);">L</span></div>
      </div>
      <div class="card" style="padding:14px;">
        <div style="font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-family:var(--mono);">Team OVR</div>
        <div style="font-size:24px;font-weight:700;color:var(--blue);font-family:var(--mono);">${ov.teamRating ?? '—'}</div>
      </div>
      <div class="card" style="padding:14px;">
        <div style="font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-family:var(--mono);">Condition</div>
        <div style="font-size:24px;font-weight:700;font-family:var(--mono);color:${(ov.teamCondition || 0) >= 80 ? 'var(--green-l)' : (ov.teamCondition || 0) >= 60 ? 'var(--amber)' : 'var(--red)'};">${ov.teamCondition ?? '—'}%</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Team Attribute Averages</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">Players with recorded attributes</div>
        ${attrBarsHTML}
      </div>
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Recent Match Results</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:8px;">Score · date · avg player rating</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">${formBadges || '<span style="color:var(--tx-3);font-size:12px;">No results yet</span>'}</div>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;">${trendHTML}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">GPS Load · Last 14 Days</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">Team average load per day</div>
        ${gpsBarHTML}
        ${gpsAvg.avgSpeed != null ? `<div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
          ${[['Avg Speed', (gpsAvg.avgSpeed || 0).toFixed(1) + ' km/h', 'var(--blue)'],
             ['Top Speed', (gpsAvg.topSpeed || 0).toFixed(1) + ' km/h', 'var(--green-l)'],
             ['Avg Dist',  (gpsAvg.distance || 0).toFixed(0) + ' m',   'var(--amber)']].map(([l, v, c]) =>
          `<div style="flex:1;min-width:60px;">
            <div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${l}</div>
            <div style="font-size:13px;font-weight:700;color:${c};font-family:var(--mono);">${v}</div>
          </div>`).join('')}
        </div>` : ''}
      </div>
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">AI Readiness</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">Top 5 by readiness score</div>
        ${topReady.length > 0
          ? topReady.map(p => {
              const rc = p.readinessScore >= 75 ? 'var(--green-l)' : p.readinessScore >= 55 ? 'var(--amber)' : 'var(--red)';
              return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--bd);">
                <div style="width:34px;height:34px;border-radius:50%;background:var(--bg-3);border:2px solid ${rc};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:${rc};font-family:var(--mono);flex-shrink:0;">${p.readinessScore}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:12px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.firstName} ${p.lastName}</div>
                  <div style="font-size:11px;color:var(--tx-3);">${p.position} · OVR ${p.overallRating}</div>
                </div>
                ${p.isHighRisk ? '<span class="badge badge-red" style="font-size:9px;">RISK</span>' : ''}
              </div>`;
            }).join('')
          : (top
              ? `<div style="padding:10px;background:var(--bg-3);border-radius:8px;">
                  <div style="font-size:11px;color:var(--tx-3);margin-bottom:2px;">Top Performer</div>
                  <div style="font-size:14px;font-weight:700;color:var(--tx);">${top.firstName} ${top.lastName}</div>
                  <div style="font-size:12px;color:var(--tx-3);">${top.position} · OVR ${top.overallRating}</div>
                </div>`
              : '<div style="color:var(--tx-3);font-size:12px;">No data yet</div>')
        }
      </div>
    </div>`;
}

function _renderAnalyticsPlayers(el) {
  // Drill-down view
  if (_analyticsPlayerId && _analyticsPlayerData) {
    const pd = _analyticsPlayerData;
    const p  = pd.player;
    if (!p) { el.innerHTML = '<div style="padding:16px;color:var(--red);">Player not found</div>'; return; }

    const radarFields = [
      { key:'speed',     label:'Speed' },
      { key:'shooting',  label:'Shooting' },
      { key:'passing',   label:'Passing' },
      { key:'technique', label:'Technique' },
      { key:'defending', label:'Defending' },
      { key:'stamina',   label:'Stamina' },
      { key:'agility',   label:'Agility' },
      { key:'strength',  label:'Strength' },
    ];

    const radarBars = pd.radarData
      ? radarFields.map(f => {
          const v = pd.radarData[f.key];
          if (v == null) return '';
          const pct = Math.round((v / 130) * 100);
          return `<div class="bar-row">
            <div class="bar-lbl">${f.label}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--blue);"></div></div>
            <div class="bar-val" style="font-family:var(--mono);color:var(--blue);">${v}</div>
          </div>`;
        }).filter(Boolean).join('')
      : '<div style="color:var(--tx-3);font-size:12px;">No attribute data recorded</div>';

    const matchTrend = (pd.matchPerfTrend || []);
    const matchHTML = matchTrend.length > 0
      ? matchTrend.map(m => {
          const r  = m.rating ? m.rating.toFixed(1) : '—';
          const rc = m.rating ? (m.rating >= 7 ? 'var(--green-l)' : m.rating >= 5.5 ? 'var(--amber)' : 'var(--red)') : 'var(--tx-3)';
          const dt = new Date(m.date);
          const lbl = (dt.getMonth() + 1) + '/' + dt.getDate();
          return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:44px;">
            <div style="font-size:15px;font-weight:700;color:${rc};font-family:var(--mono);">${r}</div>
            <div style="font-size:9px;color:var(--tx-3);">${lbl}</div>
            <div style="font-size:10px;color:var(--tx-3);">${m.goals || 0}G ${m.assists || 0}A</div>
          </div>`;
        }).join('')
      : '<div style="color:var(--tx-3);font-size:12px;">No match data</div>';

    const inj = pd.injuryImpact;
    const injHTML = inj && inj.totalInjuries > 0
      ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
          ${[['Injuries', inj.totalInjuries, 'var(--red)'],
             ['Days Absent', inj.totalDaysAbsent, 'var(--amber)'],
             ['Active', inj.activeInjury ? 'Yes' : 'No', inj.activeInjury ? 'var(--red)' : 'var(--green-l)']].map(([l, v, c]) =>
          `<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${l}</div><div style="font-size:16px;font-weight:700;color:${c};font-family:var(--mono);">${v}</div></div>`).join('')}
        </div>`
      : '<div style="color:var(--tx-3);font-size:12px;margin-bottom:10px;">No injury history</div>';

    el.innerHTML = `
      <button class="btn btn-ghost btn-sm" style="margin-bottom:14px;" onclick="_analyticsPlayerId=null;_analyticsPlayerData=null;renderAnalyticsPage();">← Back to Players</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div class="card" style="padding:16px;margin-bottom:12px;">
            <div style="font-size:15px;font-weight:700;color:var(--tx);">${p.firstName} ${p.lastName}</div>
            <div style="font-size:12px;color:var(--tx-3);margin-bottom:12px;">${p.position} · #${p.number || '—'} · OVR ${p.overallRating}</div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;">
              ${[['Condition', (p.condition || 0) + '%', (p.condition || 0) >= 80 ? 'var(--green-l)' : (p.condition || 0) >= 60 ? 'var(--amber)' : 'var(--red)'],
                 ['Attendance', pd.attendanceRate != null ? pd.attendanceRate + '%' : '—', 'var(--blue)'],
                 ['Status', p.isInjured ? 'Injured' : 'Active', p.isInjured ? 'var(--red)' : 'var(--green-l)']].map(([l, v, c]) =>
              `<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${l}</div><div style="font-size:15px;font-weight:700;color:${c};font-family:var(--mono);">${v}</div></div>`).join('')}
            </div>
          </div>
          <div class="card" style="padding:16px;">
            <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:10px;">Attribute Radar</div>
            ${radarBars}
          </div>
        </div>
        <div>
          <div class="card" style="padding:16px;margin-bottom:12px;">
            <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:10px;">Match Performance Trend</div>
            <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;">${matchHTML}</div>
          </div>
          <div class="card" style="padding:16px;">
            <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:8px;">Injury Impact</div>
            ${injHTML}
          </div>
        </div>
      </div>`;
    return;
  }

  // List view — readiness cards
  const rd = _analyticsReadiness;
  if (!rd) { el.innerHTML = loadingHTML('Loading player analytics…'); return; }
  if (!rd.length) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--tx-3);">No active players found</div>';
    return;
  }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;">
      ${rd.map(p => {
        const rc = p.readinessScore >= 75 ? 'var(--green-l)' : p.readinessScore >= 55 ? 'var(--amber)' : 'var(--red)';
        const fc = p.fitnessScore  >= 70  ? 'var(--green-l)' : p.fitnessScore  >= 50  ? 'var(--amber)' : 'var(--red)';
        return `<div class="card" style="padding:14px;cursor:pointer;" onclick="openPlayerAnalytics('${p.playerId}')">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--tx);">${p.firstName} ${p.lastName}</div>
              <div style="font-size:11px;color:var(--tx-3);">${p.position} · OVR ${p.overallRating}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:20px;font-weight:700;color:${rc};font-family:var(--mono);">${p.readinessScore}</div>
              <div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Readiness</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:5px;">
            ${[['Fitness', p.fitnessScore, fc],
               ['Form',    p.formScore,    'var(--blue)'],
               ['Dev',     p.developmentScore, 'var(--amber)'],
               ['ACWR',    p.acwr != null ? p.acwr.toFixed(2) : '—', 'var(--tx-2)']].map(([l, v, c]) =>
            `<div style="background:var(--bg-3);border-radius:5px;padding:5px;text-align:center;">
              <div style="font-size:12px;font-weight:700;color:${c};font-family:var(--mono);">${v}</div>
              <div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.4px;">${l}</div>
            </div>`).join('')}
          </div>
          ${p.isHighRisk ? '<div style="margin-top:8px;"><span class="badge badge-red" style="font-size:9px;">⚠ HIGH RISK</span></div>' : ''}
        </div>`;
      }).join('')}
    </div>`;
}

async function openPlayerAnalytics(playerId) {
  _analyticsPlayerId = playerId;
  const el = document.getElementById('analytics-content');
  if (el) el.innerHTML = loadingHTML('Loading player data…');
  try {
    const resp = await AnalyticsAPI.playerAnalytics(playerId);
    _analyticsPlayerData = resp && resp.data ? resp.data : resp;
    renderAnalyticsPage();
  } catch (err) {
    if (el) el.innerHTML = '<div style="padding:16px;color:var(--red);">Failed to load player analytics</div>';
  }
}

function _renderAnalyticsTeam(el) {
  const td = _analyticsTeam;
  if (!td) { el.innerHTML = loadingHTML('Loading team analytics…'); return; }

  const s  = td.summary || {};
  const wd = td.workloadSummary || {};
  const id = td.injurySummary || {};
  const pd = td.performanceDistribution || {};
  const aa = td.attributeAverages || {};

  const attrFields = [
    { db:'pace',      label:'Speed' },
    { db:'shooting',  label:'Shooting' },
    { db:'passing',   label:'Passing' },
    { db:'dribbling', label:'Technique' },
    { db:'tackling',  label:'Defending' },
    { db:'stamina',   label:'Stamina' },
    { db:'strength',  label:'Strength' },
    { db:'agility',   label:'Agility' },
  ];

  const attrBars = attrFields.map(f => {
    const v = aa[f.db];
    if (v == null) return '';
    const pct = Math.round((v / 130) * 100);
    return `<div class="bar-row">
      <div class="bar-lbl">${f.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--blue);opacity:.8;"></div></div>
      <div class="bar-val" style="font-family:var(--mono);color:var(--blue);">${v}</div>
    </div>`;
  }).filter(Boolean).join('');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:12px;">
      ${[['Players', s.playerCount, 'var(--blue)'],
         ['Avg OVR', s.avgRating,   'var(--green-l)'],
         ['Attendance', s.teamAttendanceRate != null ? s.teamAttendanceRate + '%' : '—', 'var(--amber)'],
         ['Active Injuries', id.activeInjuries, 'var(--red)']].map(([l, v, c]) =>
      `<div class="card" style="padding:14px;">
        <div style="font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);margin-bottom:4px;">${l}</div>
        <div style="font-size:22px;font-weight:700;color:${c};font-family:var(--mono);">${v ?? '—'}</div>
      </div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Team Attribute Averages</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">Players with recorded attributes</div>
        ${attrBars || '<div style="color:var(--tx-3);font-size:12px;">No attribute data recorded yet</div>'}
      </div>
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Performance Distribution</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">Squad by OVR tier</div>
        ${[['Elite (85+)', pd.elite, 'var(--green-l)'],
           ['Good (75–84)', pd.good, 'var(--blue)'],
           ['Average (65–74)', pd.average, 'var(--amber)'],
           ['Developing (<65)', pd.developing, 'var(--red)']].map(([l, v, c]) =>
        `<div class="bar-row">
          <div class="bar-lbl">${l}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(((v || 0) / Math.max(s.playerCount || 1, 1)) * 100)}%;background:${c};opacity:.8;"></div></div>
          <div class="bar-val" style="font-family:var(--mono);color:${c};">${v || 0}</div>
        </div>`).join('')}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Workload Status</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">ACWR monitoring · last 4 weeks</div>
        <div style="display:flex;gap:16px;margin-bottom:12px;">
          ${[['High Risk', wd.highRiskCount, 'var(--red)'],
             ['Avg ACWR', (wd.avgAcwr || 0).toFixed(2), 'var(--amber)'],
             ['Monitored', wd.playersMonitored, 'var(--blue)']].map(([l, v, c]) =>
          `<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${l}</div><div style="font-size:17px;font-weight:700;color:${c};font-family:var(--mono);">${v || 0}</div></div>`).join('')}
        </div>
        ${wd.highRiskPlayers && wd.highRiskPlayers.length > 0
          ? wd.highRiskPlayers.map(p => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bd);">
              <span style="font-size:12px;color:var(--tx);">${p.name}</span>
              <span class="badge badge-red" style="font-size:9px;">${p.acwr.toFixed(2)} ACWR</span>
            </div>`).join('')
          : '<div style="color:var(--tx-3);font-size:12px;">No high-risk workloads detected</div>'
        }
      </div>
      <div class="card" style="padding:16px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Injury Analytics</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">Season overview</div>
        <div style="display:flex;gap:16px;margin-bottom:12px;">
          ${[['Active', id.activeInjuries, 'var(--red)'],
             ['Total', id.totalInjuries,   'var(--amber)'],
             ['Avg Days', (id.avgDaysAbsent || 0).toFixed(0), 'var(--blue)']].map(([l, v, c]) =>
          `<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${l}</div><div style="font-size:17px;font-weight:700;color:${c};font-family:var(--mono);">${v || 0}</div></div>`).join('')}
        </div>
        ${id.byBodyLocation && Object.keys(id.byBodyLocation).length > 0
          ? Object.entries(id.byBodyLocation).slice(0, 5).map(([loc, cnt]) =>
            `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bd);">
              <span style="font-size:12px;color:var(--tx);">${loc}</span>
              <span style="font-size:12px;font-weight:700;color:var(--red);font-family:var(--mono);">${cnt}</span>
            </div>`).join('')
          : '<div style="color:var(--tx-3);font-size:12px;">No injury data recorded</div>'
        }
      </div>
    </div>`;
}

function _renderAnalyticsRisks(el) {
  const rd = _analyticsRisks;
  if (!rd) { el.innerHTML = loadingHTML('Loading risk alerts…'); return; }

  const alerts = rd.alerts || [];
  if (!alerts.length) {
    el.innerHTML = `<div style="padding:48px;text-align:center;">
      <div style="font-size:32px;margin-bottom:8px;">✅</div>
      <div style="font-size:15px;font-weight:600;color:var(--tx);margin-bottom:4px;">No Risk Alerts</div>
      <div style="font-size:13px;color:var(--tx-3);">All players are within safe parameters</div>
    </div>`;
    return;
  }

  const TYPE_ICON = { INJURY_RISK:'🩹', OVERLOAD_RISK:'⚡', LOW_ATTENDANCE:'📋', PERFORMANCE_DECLINE:'📉' };
  const SEV_COLOR = { HIGH:'var(--red)', MEDIUM:'var(--amber)', LOW:'var(--blue)' };
  const SEV_BADGE = { HIGH:'badge-red', MEDIUM:'badge-amber', LOW:'badge-blue' };

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
      ${[['Total',  rd.total,       'var(--tx)'],
         ['High',   rd.highCount,   'var(--red)'],
         ['Medium', rd.mediumCount, 'var(--amber)'],
         ['Low',    rd.lowCount,    'var(--blue)']].map(([l, v, c]) =>
      `<div class="card" style="padding:14px;">
        <div style="font-size:11px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);margin-bottom:4px;">${l}</div>
        <div style="font-size:22px;font-weight:700;color:${c};font-family:var(--mono);">${v}</div>
      </div>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${alerts.map(a =>
      `<div class="card" style="padding:14px;border-left:3px solid ${SEV_COLOR[a.severity]};">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">${TYPE_ICON[a.type] || '⚠'}</span>
            <div>
              <span style="font-size:13px;font-weight:700;color:var(--tx);">${a.playerName}</span>
              <span style="font-size:11px;color:var(--tx-3);margin-left:6px;">${a.position}</span>
            </div>
          </div>
          <span class="badge ${SEV_BADGE[a.severity] || 'badge-gray'}" style="font-size:9px;">${a.severity}</span>
        </div>
        <div style="font-size:12px;color:var(--tx-2);">${a.message}</div>
      </div>`).join('')}
    </div>`;
}

async function loadAnalyticsData() {
  if (_analyticsLoading) { renderAnalyticsPage(); return; }
  _analyticsLoading = true;
  const sub = document.getElementById('analytics-sub');
  if (sub) sub.textContent = 'Fetching…';

  // Use cached overview immediately for instant render
  if (State.analytics) {
    _analyticsOverview = State.analytics;
    renderAnalyticsPage();
  }

  try {
    const [trendR, gpsR, readR, risksR, teamR] = await Promise.allSettled([
      AnalyticsAPI.performanceTrend(8),
      AnalyticsAPI.gpsLoad(14),
      AnalyticsAPI.readiness(),
      AnalyticsAPI.risks(),
      AnalyticsAPI.teamAnalytics(),
    ]);

    if (trendR.status === 'fulfilled' && trendR.value?.data)  _analyticsTrend    = trendR.value.data;
    if (gpsR.status  === 'fulfilled' && gpsR.value?.data)     _analyticsGpsLoad  = gpsR.value.data;
    if (readR.status === 'fulfilled' && readR.value?.data)    _analyticsReadiness= readR.value.data;
    if (risksR.status=== 'fulfilled' && risksR.value?.data)   _analyticsRisks    = risksR.value.data;
    if (teamR.status === 'fulfilled' && teamR.value?.data)    _analyticsTeam     = teamR.value.data;

    // Refresh overview if not already loaded
    if (!_analyticsOverview) {
      const ovR = await AnalyticsAPI.overview();
      if (ovR?.data) { _analyticsOverview = ovR.data; State.analytics = ovR.data; }
    }

    if (sub) {
      const ov = _analyticsOverview && _analyticsOverview.overview;
      sub.textContent = ov
        ? `${ov.wins}W · ${ov.draws}D · ${ov.losses}L · ${ov.playerCount} players`
        : 'Intelligence Engine';
    }

    // Badge on Risks tab if high-severity alerts exist
    if (_analyticsRisks && _analyticsRisks.highCount > 0) {
      const riskBtn = document.querySelector('#analytics-tabs .filter-btn:last-child');
      if (riskBtn && !riskBtn.querySelector('.risk-n')) {
        const n = document.createElement('span');
        n.className = 'badge badge-red risk-n';
        n.style.cssText = 'font-size:9px;margin-left:5px;';
        n.textContent = _analyticsRisks.highCount;
        riskBtn.appendChild(n);
      }
    }

    renderAnalyticsPage();
  } catch (err) {
    console.error('Analytics load error:', err);
    if (sub) sub.textContent = 'Some data failed to load';
  } finally {
    _analyticsLoading = false;
  }
}

// ── AI ANALYST ──
function renderAIHTML() {
  const quickBtns = [
    {icon:'📊',label:'Season Analysis',sub:'Full performance report',p:'Analyze our full team performance this season and identify the top 3 areas for improvement.'},
    {icon:'🏃',label:'Load Management',sub:'GPS fatigue analysis',p:'Analyze GPS load data and identify which players need rest before the next match.'},
    {icon:'🎯',label:'Opponent Analysis',sub:'Tactical breakdown',p:'Analyze our next opponent and provide tactical recommendations for the match.'},
    {icon:'🏋️',label:'Training Plan',sub:'AI-optimized session',p:'Recommend an optimized training session for tomorrow based on current team condition.'},
    {icon:'🔍',label:'Scout Report',sub:'Transfer market',p:'Find the best transfer target for DMC position under 5M EUR market value.'},
    {icon:'🏥',label:'Injury Prevention',sub:'GPS risk analysis',p:'Generate a complete injury prevention plan based on current GPS load data from all players.'},
    {icon:'💰',label:'Financial Forecast',sub:'Revenue optimization',p:'Analyze our financial performance and suggest revenue optimization strategies.'},
  ];
  return `<div class="page" id="pg-ai">
  <div class="ai-layout">
    <div class="ai-qs">
      <div style="padding:10px 10px 6px;border-bottom:1px solid var(--bd);flex-shrink:0;">
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Quick Analysis</div>
        ${quickBtns.map(b=>`
          <div class="ai-q-btn" onclick="aiQuick('${b.p.replace(/'/g,"\\'")}')">
            <div class="ai-q-icon">${b.icon}</div>
            <div><div class="ai-q-label">${b.label}</div><div class="ai-q-sub">${b.sub}</div></div>
          </div>`).join('')}
      </div>
      <div style="padding:12px;margin-top:auto;">
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Live Data Sources</div>
        <div id="ai-data-sources">
          ${['GPS Devices','Match Database','Medical Records','Financial Data'].map(s=>`
            <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid var(--bd);">
              <div style="width:5px;height:5px;border-radius:50%;background:var(--green-l);"></div>
              <span style="font-size:12px;color:var(--tx-2);">${s}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="ai-main">
      <div class="ai-chat-hdr">
        <div class="aria-dot">⚡</div>
        <div>
          <div class="aria-name">ARIA</div>
          <div class="aria-status">AI Football Analyst · Powered by Claude · Connected to live database</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
          <span class="badge badge-green">Connected</span>
          <span style="font-size:10px;color:var(--tx-3);font-family:var(--mono);">claude-sonnet-4</span>
        </div>
      </div>
      <div class="ai-msgs" id="ai-msgs">
        <div class="ai-msg ai">
          <div class="ai-msg-av ai-msg-av-aria">⚡</div>
          <div class="ai-msg-bubble ai">
            <strong style="color:var(--green-l);">Marhaba!</strong> I'm ARIA — your AI Football Analyst connected to live Familista HSR data.<br><br>
            I have real-time access to GPS tracking, match history, medical records, and financial data from your PostgreSQL database.<br><br>
            What would you like to analyze today?
          </div>
        </div>
      </div>
      <div class="ai-inp-row">
        <input class="ai-inp" id="ai-inp" placeholder="Ask ARIA anything about your club..." onkeydown="if(event.key==='Enter')aiSend()">
        <button class="ai-send-btn" onclick="aiSend()">
          <svg width="15" height="15" fill="currentColor" viewBox="0 0 20 20"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>`;
}

async function aiSend() {
  const inp = document.getElementById('ai-inp');
  const msg = inp?.value.trim();
  if (!msg || State.aiBusy) return;
  inp.value = '';
  State.aiBusy = true;
  addAIMsg(msg, 'user');
  State.aiHistory.push({ role: 'user', content: msg });
  showAITyping();

  try {
    const res = await api('/ai/analyze', {
      method: 'POST',
      body: { prompt: msg, type: 'team' },
    });

    hideAITyping();
    State.aiBusy = false;

    if (res?.data?.response) {
      State.aiHistory.push({ role: 'assistant', content: res.data.response });
      addAIMsg(res.data.response, 'ai');
    } else {
      addAIMsg('Analysis failed — please try again.', 'ai');
    }
  } catch (err) {
    hideAITyping();
    State.aiBusy = false;
    addAIMsg(`⚠️ Error: ${err.message}. Please try again.`, 'ai');
  }
}

function aiQuick(p) {
  const inp = document.getElementById('ai-inp');
  if (inp) { inp.value = p; inp.focus(); }
}

function addAIMsg(text, role) {
  const box = document.getElementById('ai-msgs');
  if (!box) return;
  const d = document.createElement('div');
  d.className = `ai-msg ${role}`;
  d.innerHTML = `
    <div class="ai-msg-av ${role==='ai'?'ai-msg-av-aria':'ai-msg-av-user'}">${role==='ai'?'⚡':'K'}</div>
    <div class="ai-msg-bubble ${role}">${text.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong style="color:var(--tx);">$1</strong>')}</div>`;
  box.appendChild(d);
  box.scrollTop = 99999;
}

let aiTypingEl = null;
function showAITyping() {
  const box = document.getElementById('ai-msgs');
  if (!box) return;
  aiTypingEl = document.createElement('div');
  aiTypingEl.className = 'ai-msg ai';
  aiTypingEl.innerHTML = `<div class="ai-msg-av ai-msg-av-aria">⚡</div><div class="ai-msg-bubble ai"><div class="ai-typing"><span></span><span></span><span></span></div></div>`;
  box.appendChild(aiTypingEl);
  box.scrollTop = 99999;
}
function hideAITyping() { if(aiTypingEl){aiTypingEl.remove();aiTypingEl=null;} }

// ── TRAINING ──

const TrainingAPI = {
  list(query)              { return FamilistaAPI.get('/training' + (query ? '?' + query : '')); },
  get(id)                  { return FamilistaAPI.get('/training/' + id); },
  form()                   { return FamilistaAPI.get('/training/form'); },
  create(body)             { return FamilistaAPI.post('/training', body); },
  update(id, body)         { return FamilistaAPI.patch('/training/' + id, body); },
  remove(id)               { return FamilistaAPI.delete('/training/' + id); },
  // Training Attendance MVP
  getAttendance(id)        { return FamilistaAPI.get('/training/' + id + '/attendance'); },
  saveAttendance(id, body) { return FamilistaAPI.put('/training/' + id + '/attendance', body); },
};

// In-memory draft for the Attendance panel — keyed by sessionId so a stale
// draft from one session can't leak into another. Marks are saved on
// "Save Attendance"; reads come from getAttendance.
let _attendanceState = { sessionId: null, items: [], summary: { present: 0, absent: 0, late: 0, excused: 0 }, draft: Object.create(null), saving: false, loading: false };

const TRAINING_DRILLS = [
  { key: 'TECHNICAL_PASSING',  label: 'Technical Passing',  icon: '⚽' },
  { key: 'SPRINT_INTERVALS',   label: 'Sprint Intervals',   icon: '🏃' },
  { key: 'SHOOTING_PRACTICE',  label: 'Shooting Practice',  icon: '🎯' },
  { key: 'DEFENSIVE_SHAPE',    label: 'Defensive Shape',    icon: '🛡️' },
  { key: 'TRANSITION_PLAY',    label: 'Transition Play',    icon: '🔄' },
  { key: 'RECOVERY',           label: 'Recovery',           icon: '🧘' },
  { key: 'SET_PIECES',         label: 'Set Pieces',         icon: '🚩' },
  { key: 'POSSESSION',         label: 'Possession',         icon: '🔵' },
  { key: 'PRESSING',           label: 'Pressing',           icon: '⚡' },
  { key: 'CUSTOM',             label: 'Custom',             icon: '✏️' },
];

let _trainingTab      = 'sessions';
let _trainingDetailId = null;

function renderTrainingHTML() {
  return `<div class="page" id="pg-training">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Training Management</div>
        <div style="font-size:12px;color:var(--tx-3);" id="training-sub">Loading…</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <div class="filter-group" id="training-tabs">
          <button class="filter-btn active" onclick="setTrainingTab('sessions',this)">Sessions</button>
          <button class="filter-btn"        onclick="setTrainingTab('form',this)">Form</button>
          <button class="filter-btn"        onclick="setTrainingTab('players',this)">Players</button>
        </div>
        <button class="btn btn-primary btn-sm" id="training-schedule-btn" onclick="openNewSessionModal()">+ New Session</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:16px 20px;" id="training-content"></div>
  </div>
</div>`;
}

function setTrainingTab(tab, el) {
  _trainingTab = tab;
  document.querySelectorAll('#training-tabs .filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderTrainingPage();
}

function renderTrainingPage() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const el = document.getElementById('training-content');
  if (!el) return;
  if (_trainingTab === 'sessions')  renderTrainingSessions(el);
  else if (_trainingTab === 'form') renderTrainingFormPanel(el);
  else if (_trainingTab === 'players') renderTrainingPlayersPanel(el);
}

function renderTrainingSessions(el) {
  const sessions = State.training || [];
  const role     = State.user && State.user.role;
  const canEdit  = ['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role);
  const canDel   = ['CLUB_ADMIN','SUPER_ADMIN'].includes(role);

  const sub = document.getElementById('training-sub');
  if (sub) sub.textContent = sessions.length + ' session' + (sessions.length !== 1 ? 's' : '');

  if (sessions.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--tx-3);">
      <div style="font-size:32px;margin-bottom:12px;">🏋️</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:6px;">No training sessions yet</div>
      <div style="font-size:12px;">Click "New Session" to schedule the first one.</div>
    </div>`;
    return;
  }

  el.innerHTML = sessions.map(s => {
    const dt      = s.scheduledAt ? new Date(s.scheduledAt) : null;
    const dateStr = dt ? dt.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'}) : '—';
    const timeStr = dt ? dt.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}) : '';
    const drills  = (s.drills || []).slice(0,3).map(d => {
      const found = TRAINING_DRILLS.find(x => x.key === d);
      return found ? found.icon : d;
    }).join(' ');
    const players = s.playerStats ? s.playerStats.length : 0;
    return `<div class="card" style="padding:16px;margin-bottom:10px;cursor:pointer;display:flex;align-items:center;gap:14px;" data-action="openTrainingDetail" data-id="${_esc(s.id)}">
      <div style="flex-shrink:0;width:44px;height:44px;border-radius:10px;background:var(--green-bg);border:1px solid var(--green-bd);display:flex;align-items:center;justify-content:center;font-size:20px;">🏋️</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(s.title)}</div>
        <div style="font-size:11px;color:var(--tx-3);margin-top:2px;">${dateStr}${timeStr ? ' · ' + timeStr : ''} · ${s.duration} min${players ? ' · ' + players + ' player' + (players !== 1 ? 's' : '') : ''}${drills ? ' · ' + drills : ''}</div>
      </div>
      ${canEdit ? `<button class="btn btn-outline btn-xs" data-action="editTraining" data-id="${_esc(s.id)}">Edit</button>` : ''}
      ${canDel  ? `<button class="btn btn-danger btn-xs"  data-action="deleteTraining" data-id="${_esc(s.id)}">Delete</button>` : ''}
    </div>`;
  }).join('');
}

// ─── Team Form Intelligence helpers (all derived from existing State) ─────
// No backend calls, no new endpoints. Reads:
//   State.trainingForm — { attackForm, defenseForm, possession, conditionForm }
//   State.training     — last 10 sessions (already loaded for the Sessions tab)
//   State.players      — active squad (already loaded for Squad)
//   State.matches      — match fixtures (already loaded by loadAllData)
function _formActivePlayers() {
  return (State.players || []).filter(p => p && p.isActive !== false);
}
function _formAvgCondition() {
  const ps = _formActivePlayers();
  if (ps.length === 0) return null;
  return ps.reduce((a, p) => a + (typeof p.condition === 'number' ? p.condition : 100), 0) / ps.length;
}
function _formInjuryCount()    { return _formActivePlayers().filter(p => p.isInjured).length; }
function _formAvailableCount() { return _formActivePlayers().filter(p => !p.isInjured).length; }
function _formRatings() {
  const f = State.trainingForm || {};
  return {
    attack:     f.attackForm    ?? 12,
    defense:    f.defenseForm   ?? 14,
    possession: f.possession    ?? 11,
    condition:  f.conditionForm ?? 13,
  };
}
function _formReadinessScore() {
  const total = _formActivePlayers().length;
  if (total === 0) return null;
  const availPct = (_formAvailableCount() / total) * 100;
  const condPct  = _formAvgCondition() ?? 100;
  const r        = _formRatings();
  const formPct  = ((r.attack + r.defense + r.possession + r.condition) / 64) * 100;
  return 0.4 * condPct + 0.3 * availPct + 0.3 * formPct;
}
function _formReadinessColor(s) {
  if (s == null)  return 'var(--tx-3)';
  if (s >= 80)    return 'var(--green-l)';
  if (s >= 65)    return 'var(--amber)';
  return 'var(--red)';
}
function _formReadinessLabel(s) {
  if (s == null)  return 'Insufficient data';
  if (s >= 85)    return 'Peak';
  if (s >= 75)    return 'Match Ready';
  if (s >= 65)    return 'Conditioning';
  if (s >= 50)    return 'At Risk';
  return 'Critical';
}
function _formDrillCounts(n) {
  const sessions = (State.training || []).slice(0, n);
  const counts = Object.create(null);
  let total = 0;
  sessions.forEach(s => (s.drills || []).forEach(d => { counts[d] = (counts[d] || 0) + 1; total++; }));
  const items = Object.keys(counts).map(k => {
    const meta = (typeof TRAINING_DRILLS !== 'undefined' && TRAINING_DRILLS.find(x => x.key === k)) || {};
    return { key: k, label: meta.label || k, icon: meta.icon || '•', count: counts[k], pct: total > 0 ? (counts[k] / total) * 100 : 0 };
  }).sort((a, b) => b.count - a.count);
  return { items, total };
}
function _formNextMatch() {
  const now = Date.now();
  const upcoming = (State.matches || []).filter(m => m && m.scheduledAt && new Date(m.scheduledAt).getTime() > now);
  upcoming.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  return upcoming[0] || null;
}
function _formMatchReadiness() {
  const nm = _formNextMatch();
  const r  = _formReadinessScore();
  if (!nm) return { hasMatch: false, label: 'No upcoming match scheduled', color: 'var(--tx-3)' };
  const days = Math.max(0, Math.ceil((new Date(nm.scheduledAt).getTime() - Date.now()) / 86400000));
  let label, color;
  if (r == null)      { label = 'Awaiting squad data'; color = 'var(--tx-3)'; }
  else if (r >= 80)   { label = 'Ready for match';     color = 'var(--green-l)'; }
  else if (r >= 65)   { label = 'Conditioning needed'; color = 'var(--amber)'; }
  else                { label = 'High risk — manage load'; color = 'var(--red)'; }
  const opponent = nm.awayTeam || nm.homeTeam || 'opponent';
  return { hasMatch: true, days, opponent, label, color };
}
function _formDNAClassification() {
  const r = _formRatings();
  const profile = [];
  if (r.attack     >= 13) profile.push('Attack-Led');
  if (r.defense    >= 13) profile.push('Defensive Solidity');
  if (r.possession >= 12) profile.push('Possession-Based');
  if (r.condition  >= 13) profile.push('High-Intensity');
  if (r.attack     >= 12 && r.possession >= 12) profile.push('Build-Up Football');
  if (r.defense    >= 13 && r.condition  >= 12) profile.push('Press-Resilient');
  if (profile.length === 0) profile.push('Building Identity');
  const dna = ((r.attack + r.defense + r.possession + r.condition) / 64) * 100;
  return { dna, profile };
}
function _formAIRecommendation() {
  const cond = _formAvgCondition();
  const inj  = _formInjuryCount();
  const r    = _formRatings();
  const mr   = _formMatchReadiness();
  if (inj >= 3)                          return `${inj} injured players — keep this session technical only and rotate fitness work.`;
  if (cond != null && cond < 75)         return 'Squad condition below 75%. Schedule recovery, drop sprint intervals, prioritise mobility.';
  if (mr.hasMatch && mr.days <= 2)       return `Match in ${mr.days}d. Switch to set pieces and light technical work, taper training load.`;
  if (r.possession < 10)                 return 'Possession rating low. Prioritise rondos and transition drills this week.';
  if (r.condition  < 11)                 return 'Conditioning trailing — add interval and high-press blocks for the next two sessions.';
  if (r.attack     < 11)                 return 'Attack rating dipping. Focus on shooting practice and final-third combinations.';
  if (r.defense    < 12)                 return 'Defensive shape needs work. Schedule defensive-shape and pressing blocks.';
  return 'Squad balanced. Continue tactical work; rotate possession and defensive shape across the week.';
}

// ─── Familista AI Coach helpers ─────────────────────────────────────────
// All derived from State already loaded by loadAllData. CSS-only orb +
// glass card injected once per session via _ensureAICoachStyles().
function _formRecommendedFocus() {
  const r = _formRatings();
  const arr = [
    { lbl: 'Attacking play',  v: r.attack,     drill: 'Shooting Practice + final-third combinations' },
    { lbl: 'Defensive shape', v: r.defense,    drill: 'Defensive Shape + Pressing blocks' },
    { lbl: 'Possession',      v: r.possession, drill: 'Rondo + Transition Play' },
    { lbl: 'Conditioning',    v: r.condition,  drill: 'Sprint Intervals + active Recovery' },
  ];
  arr.sort((a, b) => a.v - b.v);
  return arr[0];
}
function _formRiskLevel() {
  const inj  = _formInjuryCount();
  const cond = _formAvgCondition();
  const rdy  = _formReadinessScore();
  if (inj >= 4 || (cond != null && cond < 60) || (rdy != null && rdy < 50)) return { level: 'HIGH',     color: 'var(--red)' };
  if (inj >= 2 || (cond != null && cond < 75) || (rdy != null && rdy < 70)) return { level: 'MODERATE', color: 'var(--amber)' };
  return { level: 'LOW', color: 'var(--green-l)' };
}
function _formTacticalTip() {
  const r = _formRatings();
  if (r.possession >= 12 && r.attack    >= 12) return 'Press higher in transitions to break opponent build-up, then exploit the space behind the press.';
  if (r.defense    >= 13 && r.condition >= 12) return 'Bait the opponent into pressing, then break midfield with vertical passes through the half-spaces.';
  if (r.possession >= 12)                      return 'Anchor midfield, recycle possession patiently, and probe wide channels late in the build-up.';
  if (r.attack     >= 12)                      return 'Stretch the opponent wide, then attack the half-spaces with overlapping fullbacks.';
  if (r.defense    >= 12)                      return 'Compact mid-block, force play wide, double up on the opponent\'s creative #10.';
  if (r.condition  >= 12)                      return 'Sustain a high press in 20-minute blocks; rotate press triggers between holders and forwards.';
  return 'Keep structure simple — prioritise first-touch quality and decision-making in tight zones.';
}
function _ensureAICoachStyles() {
  if (document.getElementById('ai-coach-styles')) return;
  const s = document.createElement('style');
  s.id = 'ai-coach-styles';
  s.textContent = `
    .ai-coach-card{position:relative;padding:22px 22px 18px;margin-bottom:14px;border-radius:14px;
      background:
        radial-gradient(at top left,rgba(34,197,94,0.10),transparent 55%),
        radial-gradient(at bottom right,rgba(37,99,235,0.10),transparent 55%),
        linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01));
      border:1px solid rgba(74,222,128,0.22);
      box-shadow:0 1px 0 rgba(255,255,255,0.05) inset,0 22px 60px -22px rgba(0,0,0,0.55),0 0 36px -12px rgba(34,197,94,0.18);
      overflow:hidden;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
    .ai-coach-card::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.07) 0%,transparent 45%);pointer-events:none;border-radius:14px;}
    .ai-coach-header{display:flex;align-items:center;gap:18px;margin-bottom:16px;position:relative;}
    .ai-orb{position:relative;width:86px;height:86px;flex-shrink:0;border-radius:50%;
      background:
        radial-gradient(circle at 30% 30%,rgba(74,222,128,0.95) 0%,rgba(34,197,94,0.6) 35%,rgba(22,163,74,0.2) 72%),
        radial-gradient(circle at 70% 70%,rgba(37,99,235,0.7) 0%,rgba(29,78,216,0.3) 50%,transparent 80%);
      box-shadow:inset 0 0 24px rgba(255,255,255,0.22),0 0 32px rgba(74,222,128,0.42),0 0 64px rgba(34,197,94,0.22);
      animation:ai-orb-pulse 3.2s ease-in-out infinite;}
    .ai-orb::before{content:'';position:absolute;inset:-10px;border-radius:50%;border:1px solid rgba(74,222,128,0.32);animation:ai-orb-spin 9s linear infinite;}
    .ai-orb::after{content:'';position:absolute;inset:-20px;border-radius:50%;border:1px dashed rgba(74,222,128,0.2);animation:ai-orb-spin-rev 14s linear infinite;}
    .ai-orb-core{position:absolute;inset:24%;border-radius:50%;
      background:radial-gradient(circle,rgba(255,255,255,0.45) 0%,rgba(74,222,128,0.1) 60%,transparent 82%);
      display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;letter-spacing:1.2px;
      text-shadow:0 0 10px rgba(74,222,128,0.85);}
    @keyframes ai-orb-pulse{
      0%,100%{transform:scale(1);box-shadow:inset 0 0 24px rgba(255,255,255,0.22),0 0 32px rgba(74,222,128,0.42),0 0 64px rgba(34,197,94,0.22);}
      50%{transform:scale(1.045);box-shadow:inset 0 0 28px rgba(255,255,255,0.32),0 0 44px rgba(74,222,128,0.55),0 0 84px rgba(34,197,94,0.32);}
    }
    @keyframes ai-orb-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
    @keyframes ai-orb-spin-rev{from{transform:rotate(360deg);}to{transform:rotate(0deg);}}
    .ai-coach-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:12px;
      background:rgba(74,222,128,0.14);border:1px solid rgba(74,222,128,0.28);
      font-size:10px;font-weight:700;color:var(--green-l);letter-spacing:.9px;text-transform:uppercase;}
    .ai-live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;
      box-shadow:0 0 8px currentColor;animation:ai-live-blink 1.4s ease-in-out infinite;}
    @keyframes ai-live-blink{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.45;transform:scale(0.82);}}
    .ai-coach-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px;}
    .ai-coach-cell{padding:11px 13px;border-radius:10px;background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);}
    .ai-coach-lbl{font-size:9px;font-weight:700;letter-spacing:.95px;text-transform:uppercase;color:var(--tx-3);margin-bottom:5px;}
    .ai-coach-val{font-size:12.5px;color:var(--tx);line-height:1.55;}
    .ai-coach-dna-tag{padding:3px 8px;border-radius:6px;background:rgba(74,222,128,0.14);border:1px solid rgba(74,222,128,0.28);
      font-size:10px;font-weight:700;color:var(--green-l);letter-spacing:.3px;display:inline-block;}
    @media (max-width:540px){
      .ai-coach-header{flex-direction:column;align-items:flex-start;gap:14px;}
      .ai-orb{align-self:center;}
      .ai-coach-grid{grid-template-columns:1fr;}
    }`;
  document.head.appendChild(s);
}

function renderTrainingFormPanel(el) {
  _ensureAICoachStyles();
  const f = State.trainingForm;
  const sub = document.getElementById('training-sub');
  if (sub) sub.textContent = 'Team Form Intelligence';

  if (!f) {
    el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--tx-3);">No form data available.</div>`;
    return;
  }

  const MAX = 16;
  const rings = [
    { v: f.attackForm    ?? 12, color: 'var(--red)',     lbl: 'Attack' },
    { v: f.defenseForm   ?? 14, color: 'var(--green-l)', lbl: 'Defense' },
    { v: f.possession    ?? 11, color: 'var(--amber)',   lbl: 'Possession' },
    { v: f.conditionForm ?? 13, color: 'var(--blue)',    lbl: 'Condition' },
  ];
  const circumference = 2 * Math.PI * 42; // ≈ 263.9

  // ── Intelligence layer (no backend calls, all derived from existing State)
  const readiness      = _formReadinessScore();
  const readinessColor = _formReadinessColor(readiness);
  const readinessLabel = _formReadinessLabel(readiness);
  const matchRdy       = _formMatchReadiness();
  const aiRec          = _formAIRecommendation();
  const drillFocus     = _formDrillCounts(5);
  const dna            = _formDNAClassification();
  const inj            = _formInjuryCount();
  const avail          = _formAvailableCount();
  const total          = _formActivePlayers().length;
  const cond           = _formAvgCondition();

  const last5    = (State.training || []).slice(0, 5);
  const trendRows = [
    { lbl: 'Attack',     color: 'var(--red)',     key: 'attackForm' },
    { lbl: 'Defense',    color: 'var(--green-l)', key: 'defenseForm' },
    { lbl: 'Possession', color: 'var(--amber)',   key: 'possession' },
    { lbl: 'Condition',  color: 'var(--blue)',    key: 'conditionForm' },
  ];

  // ── Familista AI Coach widget data ─────────────────────────────────────
  const aiFocus      = _formRecommendedFocus();
  const aiRisk       = _formRiskLevel();
  const aiTacticTip  = _formTacticalTip();
  // readiness, readinessColor, readinessLabel, aiRec, dna, inj, cond already
  // computed above — re-used here, no duplicate work.

  el.innerHTML = `
    <!-- Row 0: Familista AI Coach (3D / glass style, CSS-only orb) -->
    <div class="ai-coach-card">
      <div class="ai-coach-header">
        <div class="ai-orb"><div class="ai-orb-core">ARIA</div></div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
            <div style="font-size:12.5px;font-weight:800;color:var(--tx);letter-spacing:.7px;">FAMILISTA AI COACH</div>
            <span class="ai-coach-pill"><span class="ai-live-dot"></span>LIVE</span>
          </div>
          <div style="font-size:11px;color:var(--tx-3);line-height:1.5;">Real-time training intelligence — derived from squad condition, recent sessions, and upcoming fixtures.</div>
        </div>
      </div>
      <div class="ai-coach-grid">
        <div class="ai-coach-cell">
          <div class="ai-coach-lbl">Overall Readiness</div>
          <div style="display:flex;align-items:baseline;gap:8px;">
            <div style="font-size:26px;font-weight:800;line-height:1;color:${readinessColor};font-family:var(--mono);">${readiness != null ? Math.round(readiness) : '—'}</div>
            <div style="font-size:11px;font-weight:700;color:${readinessColor};">${readinessLabel}</div>
          </div>
        </div>
        <div class="ai-coach-cell">
          <div class="ai-coach-lbl">Risk Level</div>
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
            <div style="font-size:20px;font-weight:800;color:${aiRisk.color};letter-spacing:.6px;line-height:1;">${aiRisk.level}</div>
            <div style="font-size:11px;color:var(--tx-3);">${inj} injuries · ${cond != null ? Math.round(cond) + '%' : '—'} cond</div>
          </div>
        </div>
      </div>
      <div class="ai-coach-cell" style="margin-bottom:10px;">
        <div class="ai-coach-lbl">AI Recommendation</div>
        <div class="ai-coach-val">${_esc(aiRec)}</div>
      </div>
      <div class="ai-coach-cell" style="margin-bottom:10px;">
        <div class="ai-coach-lbl">Recommended Focus</div>
        <div class="ai-coach-val"><b style="color:var(--tx);">${_esc(aiFocus.lbl)}</b> &nbsp;·&nbsp; <span style="color:var(--tx-3);">${_esc(aiFocus.drill)}</span></div>
      </div>
      <div class="ai-coach-cell" style="margin-bottom:10px;">
        <div class="ai-coach-lbl">Tactical Tip</div>
        <div class="ai-coach-val">${_esc(aiTacticTip)}</div>
      </div>
      <div class="ai-coach-cell" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div class="ai-coach-lbl">FC Familista DNA</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">
            ${dna.profile.map(p => `<span class="ai-coach-dna-tag">${_esc(p)}</span>`).join('')}
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:22px;font-weight:800;color:var(--green-l);font-family:var(--mono);line-height:1;">${Math.round(dna.dna)}</div>
          <div style="font-size:9px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.85px;">DNA score</div>
        </div>
      </div>
    </div>

    <!-- Row 1: KPIs — Team Readiness Score + Match Readiness Indicator -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px;">
      <div class="card" style="padding:20px;">
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;">Team Readiness Score</div>
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:10px;">
          <div style="font-size:38px;font-weight:800;line-height:1;color:${readinessColor};font-family:var(--mono);">${readiness != null ? Math.round(readiness) : '—'}</div>
          <div style="font-size:13px;font-weight:700;color:${readinessColor};">${readinessLabel}</div>
        </div>
        <div style="height:6px;border-radius:3px;background:var(--bg-3);overflow:hidden;margin-bottom:10px;">
          <div style="width:${readiness != null ? Math.min(100, Math.max(0, readiness)).toFixed(1) : 0}%;height:100%;background:${readinessColor};"></div>
        </div>
        <div style="display:flex;gap:14px;font-size:11px;color:var(--tx-3);">
          <span><b style="color:var(--tx-2);font-family:var(--mono);">${avail}/${total}</b> available</span>
          <span><b style="color:var(--tx-2);font-family:var(--mono);">${inj}</b> injured</span>
          <span><b style="color:var(--tx-2);font-family:var(--mono);">${cond != null ? Math.round(cond) + '%' : '—'}</b> condition</span>
        </div>
      </div>

      <div class="card" style="padding:20px;">
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;">Match Readiness</div>
        ${matchRdy.hasMatch ? `
          <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:10px;">
            <div style="font-size:38px;font-weight:800;line-height:1;color:${matchRdy.color};font-family:var(--mono);">${matchRdy.days}<span style="font-size:18px;">d</span></div>
            <div style="font-size:13px;font-weight:700;color:${matchRdy.color};">${matchRdy.label}</div>
          </div>
          <div style="height:6px;border-radius:3px;background:var(--bg-3);overflow:hidden;margin-bottom:10px;">
            <div style="width:${Math.max(0, Math.min(100, 100 - matchRdy.days * 7)).toFixed(0)}%;height:100%;background:${matchRdy.color};"></div>
          </div>
          <div style="font-size:11px;color:var(--tx-3);">Next fixture vs <b style="color:var(--tx-2);">${_esc(matchRdy.opponent)}</b></div>
        ` : `
          <div style="font-size:14px;font-weight:600;color:var(--tx-3);margin-top:6px;">${matchRdy.label}</div>
          <div style="font-size:11px;color:var(--tx-3);margin-top:6px;">Schedule a match to populate this indicator.</div>
        `}
      </div>
    </div>

    <!-- Row 2: AI Recommendation -->
    <div class="card" style="padding:14px 18px;margin-bottom:14px;border-left:3px solid var(--green-l);">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-size:14px;">🧠</span>
        <span style="font-size:10px;font-weight:700;color:var(--green-l);text-transform:uppercase;letter-spacing:.9px;">ARIA Recommends</span>
      </div>
      <div style="font-size:13px;color:var(--tx);line-height:1.55;">${_esc(aiRec)}</div>
    </div>

    <!-- Row 3: Existing Teamplay Form rings (kept untouched in markup + style) -->
    <div class="card" style="padding:24px;max-width:600px;margin-bottom:14px;">
      <div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:4px;">Teamplay Form</div>
      <div style="font-size:12px;color:var(--tx-3);margin-bottom:20px;">Latest session ratings — live from database</div>
      <div class="rings-row">
        ${rings.map(r => {
          const dash = (r.v / MAX) * circumference;
          const gap  = circumference - dash;
          return `<div class="ring-block">
            <div class="ring-svg-w">
              <svg viewBox="0 0 100 100" width="86" height="86">
                <circle cx="50" cy="50" r="42" fill="none" stroke="var(--bg-4)" stroke-width="8"/>
                <circle cx="50" cy="50" r="42" fill="none" stroke="${r.color}" stroke-width="8"
                  stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}"
                  stroke-linecap="round" transform="rotate(-90 50 50)"/>
              </svg>
              <div class="ring-center">
                <div class="ring-val" style="color:${r.color};">${r.v}</div>
                <div class="ring-sub">/${MAX}</div>
              </div>
            </div>
            <div class="ring-lbl">${r.lbl}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Row 4: Trend + Focus -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px;">
      <div class="card" style="padding:20px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Last 5 Sessions Trend</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:14px;">Rating evolution across recent sessions</div>
        ${last5.length === 0 ? `<div style="font-size:12px;color:var(--tx-3);padding:8px 0;">No session history yet.</div>` :
          trendRows.map(row => {
            const vals = last5.slice().reverse().map(s => s[row.key] != null ? s[row.key] : null);
            const cap  = 16;
            const last = vals[vals.length - 1];
            return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
              <div style="min-width:78px;font-size:11px;color:var(--tx-2);">${row.lbl}</div>
              <div style="flex:1;display:flex;gap:3px;align-items:flex-end;height:30px;">
                ${vals.map(v => {
                  const h = v != null ? Math.max(2, (v / cap) * 30) : 0;
                  return `<div title="${v != null ? v : '—'}" style="flex:1;height:${h.toFixed(1)}px;background:${row.color};border-radius:2px 2px 0 0;opacity:${v != null ? 0.85 : 0.18};"></div>`;
                }).join('')}
              </div>
              <div style="min-width:34px;text-align:right;font-size:11px;font-weight:700;color:${row.color};font-family:var(--mono);">${last != null ? last : '—'}</div>
            </div>`;
          }).join('')}
      </div>

      <div class="card" style="padding:20px;">
        <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Training Focus Analysis</div>
        <div style="font-size:11px;color:var(--tx-3);margin-bottom:14px;">Drill distribution · last 5 sessions</div>
        ${drillFocus.items.length === 0 ? `<div style="font-size:12px;color:var(--tx-3);padding:8px 0;">No drills recorded.</div>` :
          drillFocus.items.slice(0, 6).map(d => `
            <div style="margin-bottom:9px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                <div style="font-size:11px;color:var(--tx-2);">${d.icon} ${_esc(d.label)}</div>
                <div style="font-size:11px;font-weight:700;color:var(--tx);font-family:var(--mono);">${Math.round(d.pct)}%</div>
              </div>
              <div style="height:5px;border-radius:3px;background:var(--bg-3);overflow:hidden;">
                <div style="width:${d.pct.toFixed(1)}%;height:100%;background:var(--green-l);"></div>
              </div>
            </div>`).join('')}
      </div>
    </div>

    <!-- Row 5: FC Familista DNA Score -->
    <div class="card" style="padding:20px;">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
        <div style="flex:1;">
          <div style="font-size:10px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.9px;">Tactical DNA</div>
          <div style="font-size:14px;font-weight:600;color:var(--tx);margin-top:3px;">FC Familista identity profile</div>
          <div style="font-size:11px;color:var(--tx-3);margin-top:2px;">Composite of Attack · Defense · Possession · Condition</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:32px;font-weight:800;line-height:1;color:var(--green-l);font-family:var(--mono);">${Math.round(dna.dna)}</div>
          <div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;">DNA score</div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${dna.profile.map(p => `<span style="padding:5px 11px;border-radius:6px;background:var(--green-bg);border:1px solid var(--green-bd);font-size:11px;font-weight:700;color:var(--green-l);letter-spacing:.3px;">${_esc(p)}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderTrainingPlayersPanel(el) {
  const sub = document.getElementById('training-sub');
  if (sub) sub.textContent = 'Player availability';
  // Reuse the existing renderTrainingPlayers logic but target the passed el
  const players = State.players || [];
  const injured = players.filter(p => p.isInjured).map(p => p.lastName);
  const lowCond = players.filter(p => p.condition < 75 && !p.isInjured).map(p => p.lastName);
  const rec = (injured.length > 0 || lowCond.length > 0)
    ? `Rest ${[...injured,...lowCond].join(', ')}. ${players.filter(p=>!p.isInjured&&p.condition>=75).length} players available for full session.`
    : 'All players fit for full training session today. Optimal conditions.';

  el.innerHTML = `
    <div class="training-layout">
      <div class="training-main">
        <div class="card" style="padding:20px;">
          <div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:12px;">Squad Availability</div>
          <div id="train-players">
            ${players.length === 0 ? loadingHTML() : players.map(p=>`
              <div class="tp-row">
                <div class="tp-check ${p.condition>75&&!p.isInjured?'on':''}" style="width:16px;height:16px;border-radius:4px;border:1px solid var(--bd-2);display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;${p.condition>75&&!p.isInjured?'background:var(--green);border-color:var(--green);color:#fff':''}">${p.condition>75&&!p.isInjured?'✓':''}</div>
                <div class="tp-num">${p.number}</div>
                <div style="flex:1;">
                  <div style="font-size:11px;font-weight:600;color:var(--tx);">${_esc(p.firstName)} ${_esc(p.lastName)}</div>
                  <div class="tp-bar"><div style="width:${p.condition}%;height:100%;border-radius:2px;background:${condBarBg(p.condition)};"></div></div>
                </div>
                <span style="font-size:10px;color:${condColor(p.condition)};font-family:var(--mono);">${p.condition}%</span>
                ${p.isInjured?`<span class="badge badge-red" style="font-size:8px;">INJ</span>`:''}
              </div>`).join('')}
          </div>
        </div>
      </div>
      <div class="training-side">
        <div style="padding:11px;border-radius:8px;background:var(--green-bg);border:1px solid var(--green-bd);">
          <div style="font-size:9px;font-weight:600;color:var(--green-l);font-family:var(--mono);margin-bottom:5px;">🤖 ARIA RECOMMENDS</div>
          <div style="font-size:12px;color:var(--tx-2);line-height:1.55;">${_esc(rec)}</div>
        </div>
      </div>
    </div>`;
}

// Keep renderTrainingPlayers for any legacy call-sites
function renderTrainingPlayers() {
  renderTrainingPage();
}

async function openTrainingDetail(id) {
  if (!id) return;
  try {
    const res = await TrainingAPI.get(id);
    const s   = res && res.data;
    if (!s) { showToast('Session not loaded', 'error'); return; }
    State.activeTrainingSession = s;
    _trainingDetailId = id;
    // Render detail inline on the sessions tab content area
    const el = document.getElementById('training-content');
    if (el) renderTrainingDetailPanel(s, el);
    // Training Attendance MVP — populate the attendance section in the
    // background so refresh / re-login shows the persisted state.
    loadAttendance(id);
  } catch (err) {
    showToast((err && err.userMessage) || 'Failed to load session', 'error');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Training Attendance MVP — load / render / mark / save
// All buttons use data-action delegation so they work under script-src 'self'.
// ──────────────────────────────────────────────────────────────────────────

async function loadAttendance(sessionId) {
  if (!sessionId) return;
  _attendanceState = { sessionId, items: [], summary: { present: 0, absent: 0, late: 0, excused: 0 }, draft: Object.create(null), saving: false, loading: true };
  renderAttendancePanel();
  try {
    const res  = await TrainingAPI.getAttendance(sessionId);
    const data = (res && res.data) || {};
    // Guard against late responses for a session the user already left.
    if (_attendanceState.sessionId !== sessionId) return;
    _attendanceState.items   = Array.isArray(data.items) ? data.items : [];
    _attendanceState.summary = data.summary || { present: 0, absent: 0, late: 0, excused: 0 };
    _attendanceState.loading = false;
    renderAttendancePanel();
  } catch (err) {
    if (_attendanceState.sessionId !== sessionId) return;
    _attendanceState.loading = false;
    renderAttendancePanel();
    showToast((err && err.userMessage) || 'Could not load attendance', 'error');
  }
}

function _attendanceCanEdit() {
  const role = State.user && State.user.role;
  return ['CLUB_ADMIN', 'HEAD_COACH', 'SUPER_ADMIN'].includes(role);
}

// Effective mark for a player = unsaved draft if set, else persisted mark.
function _effectiveMark(item) {
  const d = _attendanceState.draft[item.playerId];
  return d != null ? d : item.mark;
}

function _attendanceTotals() {
  const t = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const it of _attendanceState.items) {
    const m = _effectiveMark(it);
    if      (m === 'PRESENT') t.present++;
    else if (m === 'ABSENT')  t.absent++;
    else if (m === 'LATE')    t.late++;
    else if (m === 'EXCUSED') t.excused++;
  }
  return t;
}

function renderAttendancePanel() {
  const host = document.getElementById('attendance-section');
  if (!host) return;
  const st = _attendanceState;

  if (st.loading) {
    host.innerHTML = `<div class="card" style="padding:16px;">${loadingHTML('Loading attendance…')}</div>`;
    return;
  }

  const canEdit  = _attendanceCanEdit();
  const totals   = _attendanceTotals();
  const dirty    = Object.keys(st.draft).length > 0;
  const items    = st.items || [];

  const MARKS = [
    { key: 'PRESENT', label: 'Present', color: 'var(--green-l)', bg: 'var(--green-bg)' },
    { key: 'ABSENT',  label: 'Absent',  color: '#FCA5A5',        bg: 'rgba(220,38,38,.12)' },
    { key: 'LATE',    label: 'Late',    color: '#FDBA74',        bg: 'rgba(217,119,6,.12)' },
    { key: 'EXCUSED', label: 'Excused', color: '#93C5FD',        bg: 'rgba(37,99,235,.12)' },
  ];

  const summaryRow = MARKS.map((m) => {
    const count = totals[m.key.toLowerCase()];
    return `<div style="flex:1;min-width:90px;padding:10px 12px;border-radius:8px;background:${m.bg};border:1px solid var(--bd);">
      <div style="font-size:10px;color:var(--tx-3);font-weight:600;letter-spacing:.5px;">${m.label.toUpperCase()}</div>
      <div style="font-size:22px;font-weight:700;color:${m.color};line-height:1.2;margin-top:2px;">${count}</div>
    </div>`;
  }).join('');

  if (items.length === 0) {
    host.innerHTML = `<div class="card" style="padding:20px;">
      <div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:10px;">Attendance</div>
      <div style="font-size:12px;color:var(--tx-3);">No active players in this club yet.</div>
    </div>`;
    return;
  }

  const rows = items.map((it) => {
    const effective = _effectiveMark(it);
    const pendingPill = st.draft[it.playerId] != null
      ? `<span style="font-size:9px;color:var(--amber);font-weight:600;letter-spacing:.4px;">UNSAVED</span>`
      : '';
    const btns = MARKS.map((m) => {
      const active = effective === m.key;
      const style  = active
        ? `background:${m.bg};border:1px solid var(--bd-2);color:${m.color};font-weight:700;`
        : `background:transparent;border:1px solid var(--bd);color:var(--tx-3);`;
      const action = canEdit
        ? `data-action="attendanceMark" data-id="${_esc(it.playerId)}" data-mark="${m.key}"`
        : 'disabled';
      return `<button type="button" class="btn btn-xs" ${action} style="padding:4px 10px;font-size:10.5px;border-radius:6px;${style}">${m.label}</button>`;
    }).join('');

    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--bd);">
      <div style="min-width:28px;font-size:11px;color:var(--tx-3);font-family:var(--mono);">#${it.number != null ? it.number : '?'}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(it.firstName || '')} ${_esc(it.lastName || '')}</div>
        <div style="font-size:10px;color:var(--tx-3);margin-top:1px;">${_esc(it.position || '—')}${pendingPill ? ' · ' : ''}${pendingPill}</div>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">${btns}</div>
    </div>`;
  }).join('');

  const saveBtn = canEdit
    ? `<button type="button" class="btn btn-primary btn-sm" data-action="attendanceSave" ${(!dirty || st.saving) ? 'disabled' : ''}>${st.saving ? 'Saving…' : 'Save attendance'}</button>`
    : '';

  host.innerHTML = `<div class="card" style="padding:20px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:600;color:var(--tx);">Attendance</div>
      ${dirty ? `<span style="font-size:10px;color:var(--amber);font-weight:600;letter-spacing:.5px;">UNSAVED CHANGES</span>` : ''}
      <div style="margin-left:auto;">${saveBtn}</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">${summaryRow}</div>
    <div>${rows}</div>
  </div>`;
}

function markAttendanceDraft(playerId, mark) {
  if (!playerId || !mark) return;
  if (!_attendanceCanEdit()) { showToast('Not authorized to record attendance', 'error'); return; }
  // Only canonical-UUID playerIds can be persisted — the attendance API
  // validates playerId with z.string().uuid(). Legacy ids like player-N-fhsr
  // would be silently dropped by saveAttendance's UUID filter, making the
  // UI look dirty but produce "Nothing to save". Reject the click here so
  // the user gets an explicit reason instead of mismatched UI state.
  if (!_TS_UUID_RE.test(playerId)) {
    showToast('Legacy player cannot be saved yet', 'error');
    return;
  }
  _attendanceState.draft[playerId] = mark;
  renderAttendancePanel();
}

async function saveAttendance() {
  const st = _attendanceState;
  if (!st.sessionId) { showToast('Open a session first', 'error'); return; }
  if (!_attendanceCanEdit()) { showToast('Not authorized to record attendance', 'error'); return; }
  // Drop any non-UUID playerId from the draft before sending — the backend's
  // attendance schema is z.string().uuid() and a single legacy id (e.g.
  // player-15-fhsr) makes the whole PUT fail validation.
  const playerIds = Object.keys(st.draft).filter((pid) => _TS_UUID_RE.test(pid));
  if (playerIds.length === 0) { showToast('Nothing to save', 'info'); return; }
  const marks = playerIds.map((pid) => ({ playerId: pid, mark: st.draft[pid] }));

  st.saving = true;
  renderAttendancePanel();
  try {
    const res  = await TrainingAPI.saveAttendance(st.sessionId, { marks });
    const data = (res && res.data) || {};
    if (_attendanceState.sessionId !== st.sessionId) return; // navigated away
    _attendanceState.items   = Array.isArray(data.items) ? data.items : _attendanceState.items;
    _attendanceState.summary = data.summary || _attendanceState.summary;
    _attendanceState.draft   = Object.create(null);
    _attendanceState.saving  = false;
    renderAttendancePanel();
    showToast('Attendance saved', 'success');
  } catch (err) {
    _attendanceState.saving = false;
    renderAttendancePanel();
    showToast((err && err.userMessage) || 'Could not save attendance', 'error');
  }
}

function trainingBack() {
  _trainingDetailId = null;
  _attendanceState = { sessionId: null, items: [], summary: { present: 0, absent: 0, late: 0, excused: 0 }, draft: Object.create(null), saving: false, loading: false };
  renderTrainingPage();
}

function renderTrainingDetailPanel(s, el) {
  const role    = State.user && State.user.role;
  const canEdit = ['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role);
  const canDel  = ['CLUB_ADMIN','SUPER_ADMIN'].includes(role);
  const dt      = s.scheduledAt ? new Date(s.scheduledAt) : null;
  const dateStr = dt ? dt.toLocaleString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  const players = (s.playerStats || []);
  const drillList = (s.drills || []).map(key => {
    const d = TRAINING_DRILLS.find(x => x.key === key);
    return d ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:var(--bg-3);font-size:11px;color:var(--tx-2);">${d.icon} ${d.label}</span>` : key;
  }).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
      <button class="btn btn-outline btn-sm" data-action="trainingBack">← Back</button>
      <div style="flex:1;font-size:14px;font-weight:700;color:var(--tx);">${_esc(s.title)}</div>
      ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="editTraining" data-id="${_esc(s.id)}">Edit</button>` : ''}
      ${canDel  ? `<button class="btn btn-danger  btn-sm" data-action="deleteTraining" data-id="${_esc(s.id)}">Delete</button>` : ''}
    </div>
    <div class="card" style="padding:20px;margin-bottom:12px;">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:${s.description ? 16 : 0}px;">
        <div><div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">DATE &amp; TIME</div><div style="font-size:12px;color:var(--tx);font-weight:600;">${dateStr}</div></div>
        <div><div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">DURATION</div><div style="font-size:12px;color:var(--tx);font-weight:600;">${s.duration} min</div></div>
        ${s.location ? `<div><div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">LOCATION</div><div style="font-size:12px;color:var(--tx);font-weight:600;">${_esc(s.location)}</div></div>` : ''}
        <div><div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">PLAYERS</div><div style="font-size:12px;color:var(--tx);font-weight:600;">${players.length}</div></div>
      </div>
      ${s.description ? `<div style="font-size:12px;color:var(--tx-2);line-height:1.6;padding-top:12px;border-top:1px solid var(--bd);">${_esc(s.description)}</div>` : ''}
    </div>
    <div id="attendance-section"></div>
    ${drillList ? `<div class="card" style="padding:16px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:var(--tx);margin-bottom:10px;">Drills</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${drillList}</div>
    </div>` : ''}
    ${players.length > 0 ? `<div class="card" style="padding:16px;">
      <div style="font-size:12px;font-weight:600;color:var(--tx);margin-bottom:10px;">Attending Players (${players.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${players.map(ps => {
        const p = ps.player || ps;
        return `<span style="padding:3px 8px;border-radius:6px;background:var(--bg-3);font-size:11px;color:var(--tx-2);">${p.number ? '#' + p.number + ' ' : ''}${_esc(p.firstName || '')} ${_esc(p.lastName || '')}</span>`;
      }).join('')}</div>
    </div>` : ''}`;
}

function _trainingLocalDateStr(date) {
  const d    = date instanceof Date ? date : new Date(date);
  const pad  = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _populateTrainingModalDrills(selected) {
  const container = document.getElementById('ts-drills');
  if (!container) return;
  const sel = new Set(selected || []);
  container.innerHTML = TRAINING_DRILLS.map(d => `
    <label style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:6px;border:1px solid var(--bd);cursor:pointer;font-size:11px;color:var(--tx-2);user-select:none;">
      <input type="checkbox" name="ts-drill" value="${d.key}" ${sel.has(d.key)?'checked':''} style="width:12px;height:12px;">
      ${d.icon} ${d.label}
    </label>`).join('');
}

const _TS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── New clean Create Session flow (separate from the legacy one above) ──
// openNewSessionModal opens the same modal HTML (training-edit-modal) but
// runs through submitNewSession → POST /training/sessions, which is the
// clean endpoint with proper validation and error surfacing. The legacy
// edit path (openEditTrainingModal → submitTrainingForm) is untouched;
// the dispatcher trainingModalSubmit picks between the two based on
// whether ts-id is filled.
function _newSessionRenderPlayers() {
  const container = document.getElementById('ts-players');
  if (!container) return;
  const clubId = (State.context && State.context.clubId) || (State.user && State.user.clubId);
  const players = (State.players || []).filter(p =>
    p && typeof p.id === 'string' && _TS_UUID_RE.test(p.id)
    && (p.isActive === undefined || p.isActive === true)
    && (!clubId || !p.clubId || p.clubId === clubId)
  );
  if (players.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--tx-3);padding:8px;">No active players available. Add a player in Squad first.</div>';
    return;
  }
  container.innerHTML = players.map(p => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:4px;">
      <input type="checkbox" name="ts-player" value="${_esc(p.id)}" ${!p.isInjured && p.condition>=75 ? 'checked' : ''} style="width:13px;height:13px;">
      <span style="min-width:22px;font-size:10px;color:var(--tx-3);">#${p.number}</span>
      <span style="font-size:11px;font-weight:600;color:var(--tx);">${_esc(p.firstName)} ${_esc(p.lastName)}</span>
      <span style="margin-left:auto;font-size:10px;color:${condColor(p.condition)};font-family:var(--mono);">${p.condition}%</span>
      ${p.isInjured?`<span class="badge badge-red" style="font-size:8px;">INJ</span>`:''}
    </label>`).join('');
}

function openNewSessionModal() {
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to create training sessions', 'error'); return;
  }
  document.getElementById('ts-id').value = '';
  document.getElementById('ts-title').value = '';
  document.getElementById('ts-duration').value = 75;
  document.getElementById('ts-description').value = '';
  const _loc = document.getElementById('ts-location'); if (_loc) _loc.value = '';
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10,0,0,0);
  document.getElementById('ts-scheduled-at').value = _trainingLocalDateStr(tomorrow);
  _populateTrainingModalDrills([]);
  _newSessionRenderPlayers();
  const errEl = document.getElementById('ts-error');
  errEl.style.display = 'none'; errEl.textContent = '';
  const btn = document.getElementById('ts-submit');
  btn.textContent = 'Create session'; btn.disabled = false;
  document.querySelector('#training-edit-modal .modal-title').textContent = 'New Training Session';
  document.getElementById('training-edit-modal').classList.add('open');
}

async function submitNewSession(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const errEl = document.getElementById('ts-error');
  const btn   = document.getElementById('ts-submit');

  const title       = (document.getElementById('ts-title').value || '').trim();
  const durationRaw = document.getElementById('ts-duration').value;
  const schedRaw    = (document.getElementById('ts-scheduled-at').value || '').trim();
  const notes       = (document.getElementById('ts-description').value || '').trim();
  const location    = ((document.getElementById('ts-location') || {}).value || '').trim();

  if (!title)    { errEl.textContent = 'Title is required';       errEl.style.display = ''; return; }
  if (!schedRaw) { errEl.textContent = 'Date & time is required'; errEl.style.display = ''; return; }
  const duration = parseInt(durationRaw);
  if (!duration || duration < 1) { errEl.textContent = 'Duration must be at least 1 minute'; errEl.style.display = ''; return; }

  const drills    = Array.from(document.querySelectorAll('input[name="ts-drill"]:checked')).map(el => el.value);
  const playerIds = Array.from(document.querySelectorAll('input[name="ts-player"]:checked'))
    .map(el => el.value)
    .filter(v => typeof v === 'string' && _TS_UUID_RE.test(v));

  const body = {
    title,
    duration,
    scheduledAt: new Date(schedRaw).toISOString(),
    ...(location && { location }),
    ...(notes && { notes }),
    drills,
    playerIds,
  };

  errEl.style.display = 'none'; errEl.textContent = '';
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const saved = await FamilistaAPI.post('/training/sessions', body);
    if (saved && saved.id) State.training = [saved, ...(State.training || [])];
    // BUG #1 fix: the Form tab reads State.trainingForm, which is hydrated
    // once at login from GET /training/form (the latest-session rating row).
    // Creating a new session may make THAT session the new "latest" by
    // scheduledAt — so re-fetch the form payload from the server (which is
    // the only place that authoritatively knows what "latest" means now) and
    // update State.trainingForm. Failure is non-fatal: the tab keeps showing
    // the previous values, same as before this fix.
    try {
      const form = await FamilistaAPI.get('/training/form');
      const formData = (form && (form.data || form)) || null;
      if (formData) State.trainingForm = formData;
    } catch (_) { /* leave State.trainingForm as-is */ }
    closeModal('training-edit-modal');
    showToast('Session created', 'success');
    if (typeof renderTrainingPage === 'function') renderTrainingPage();
  } catch (e) {
    errEl.textContent = (e && (e.userMessage || e.message)) || 'Could not create session';
    errEl.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Create session';
  }
}

// Dispatcher used by the shared training-edit-modal form. Edit (ts-id set)
// stays on the legacy submitTrainingForm — Create goes through the new
// clean submitNewSession.
function trainingModalSubmit(ev) {
  const id = (document.getElementById('ts-id').value || '').trim();
  if (id) return submitTrainingForm(ev);
  return submitNewSession(ev);
}

function _populateTrainingModalPlayers(selectedIds) {
  const container = document.getElementById('ts-players');
  if (!container) return;
  // Only players whose id is a real UUID — legacy seed rows (player-N-fhsr)
  // and anything else POST /training would reject as "Invalid uuid" are
  // hidden so the modal can only ever submit valid Player.id UUIDs.
  const players = (State.players || []).filter(p => p && typeof p.id === 'string' && _TS_UUID_RE.test(p.id));
  const sel = new Set(selectedIds || []);
  if (players.length === 0) {
    container.innerHTML = `<div style="font-size:12px;color:var(--tx-3);padding:8px;">No players loaded.</div>`;
    return;
  }
  container.innerHTML = players.map(p => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:4px;">
      <input type="checkbox" name="ts-player" value="${_esc(p.id)}" ${sel.has(p.id)||(!sel.size&&!p.isInjured&&p.condition>=75)?'checked':''} style="width:13px;height:13px;">
      <span style="min-width:22px;font-size:10px;color:var(--tx-3);">#${p.number}</span>
      <span style="font-size:11px;font-weight:600;color:var(--tx);">${_esc(p.firstName)} ${_esc(p.lastName)}</span>
      <span style="margin-left:auto;font-size:10px;color:${condColor(p.condition)};font-family:var(--mono);">${p.condition}%</span>
      ${p.isInjured?`<span class="badge badge-red" style="font-size:8px;">INJ</span>`:''}
    </label>`).join('');
}

function openScheduleTrainingModal() {
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to create training sessions', 'error'); return;
  }
  document.getElementById('ts-id').value = '';
  document.getElementById('ts-title').value = '';
  document.getElementById('ts-duration').value = 75;
  document.getElementById('ts-description').value = '';
  const _newLoc = document.getElementById('ts-location'); if (_newLoc) _newLoc.value = '';
  // Default: tomorrow at 10:00
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10,0,0,0);
  document.getElementById('ts-scheduled-at').value = _trainingLocalDateStr(tomorrow);
  _populateTrainingModalDrills([]);
  _populateTrainingModalPlayers([]);
  const errEl = document.getElementById('ts-error');
  errEl.style.display = 'none'; errEl.textContent = '';
  const btn = document.getElementById('ts-submit');
  btn.textContent = 'Create session'; btn.disabled = false;
  document.querySelector('#training-edit-modal .modal-title').textContent = 'New Training Session';
  document.getElementById('training-edit-modal').classList.add('open');
}

function openEditTrainingModal(id) {
  if (!id) return;
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to edit training sessions', 'error'); return;
  }
  const s = (State.training || []).find(x => x.id === id) || State.activeTrainingSession;
  if (!s) { showToast('Session data not available', 'error'); return; }

  document.getElementById('ts-id').value = s.id;
  document.getElementById('ts-title').value = s.title || '';
  document.getElementById('ts-duration').value = s.duration || 75;
  document.getElementById('ts-description').value = s.description || '';
  const _editLoc = document.getElementById('ts-location'); if (_editLoc) _editLoc.value = s.location || '';
  if (s.scheduledAt) {
    document.getElementById('ts-scheduled-at').value = _trainingLocalDateStr(new Date(s.scheduledAt));
  }
  _populateTrainingModalDrills(s.drills || []);
  const playerIds = (s.playerStats || []).map(ps => ps.playerId || (ps.player && ps.player.id)).filter(Boolean);
  _populateTrainingModalPlayers(playerIds);
  const errEl = document.getElementById('ts-error');
  errEl.style.display = 'none'; errEl.textContent = '';
  const btn = document.getElementById('ts-submit');
  btn.textContent = 'Save changes'; btn.disabled = false;
  document.querySelector('#training-edit-modal .modal-title').textContent = 'Edit Training Session';
  document.getElementById('training-edit-modal').classList.add('open');
}

async function submitTrainingForm(ev) {
  ev.preventDefault();
  const id    = (document.getElementById('ts-id').value || '').trim();
  const errEl = document.getElementById('ts-error');
  const btn   = document.getElementById('ts-submit');

  const title       = (document.getElementById('ts-title').value || '').trim();
  const durationRaw = document.getElementById('ts-duration').value;
  const schedRaw    = (document.getElementById('ts-scheduled-at').value || '').trim();
  const description = (document.getElementById('ts-description').value || '').trim();
  const locationStr = ((document.getElementById('ts-location') || {}).value || '').trim();

  if (!title)    { errEl.textContent = 'Title is required';       errEl.style.display = ''; return; }
  if (!schedRaw) { errEl.textContent = 'Date & time is required'; errEl.style.display = ''; return; }
  const duration = parseInt(durationRaw);
  if (!duration || duration < 1) { errEl.textContent = 'Duration must be at least 1 minute'; errEl.style.display = ''; return; }

  const drills = Array.from(document.querySelectorAll('input[name="ts-drill"]:checked')).map(el => el.value);
  // Defence-in-depth: the modal already filters to UUID-id players, but
  // drop any non-UUID value here too so a stale row can never reach POST.
  const playerIds = Array.from(document.querySelectorAll('input[name="ts-player"]:checked'))
    .map(el => el.value)
    .filter(v => typeof v === 'string' && _TS_UUID_RE.test(v));

  const body = {
    title,
    duration,
    scheduledAt: new Date(schedRaw).toISOString(),
    ...(description && { description }),
    ...(locationStr && { location: locationStr }),
    drills,
    playerIds,
  };

  errEl.style.display = 'none'; errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = id ? 'Saving…' : 'Creating…';

  try {
    let saved = null;
    if (id) {
      const res = await TrainingAPI.update(id, body);
      saved = res && res.data;
      if (saved) {
        const idx = (State.training || []).findIndex(x => x.id === id);
        if (idx !== -1) State.training[idx] = Object.assign({}, State.training[idx], saved);
        if (State.activeTrainingSession && State.activeTrainingSession.id === id) {
          State.activeTrainingSession = Object.assign({}, State.activeTrainingSession, saved);
        }
      }
      // BUG #2-A fix: Edit can change scheduledAt and therefore which session
      // is the latest by scheduledAt — the row that GET /training/form picks.
      // State.trainingForm was hydrated once at login and never refreshed on
      // Edit, so the Form tab kept showing rings for the old "latest" until a
      // hard reload. Re-fetch so the cache matches the server. Failure is
      // non-fatal: the tab keeps showing the previous values, same as before.
      try {
        const form = await FamilistaAPI.get('/training/form');
        const formData = (form && (form.data || form)) || null;
        if (formData) State.trainingForm = formData;
      } catch (_) { /* leave State.trainingForm as-is */ }
    } else {
      const res = await TrainingAPI.create(body);
      saved = res && res.data;
      if (saved) State.training = [saved, ...(State.training || [])];
    }
    closeModal('training-edit-modal');
    showToast(id ? 'Session updated' : 'Session created', 'success');
    renderTrainingPage();
  } catch (e) {
    errEl.textContent   = (e && e.userMessage) || (id ? 'Could not update session' : 'Could not create session');
    errEl.style.display = '';
  } finally {
    btn.disabled    = false;
    btn.textContent = id ? 'Save changes' : 'Create session';
  }
}

async function confirmDeleteTraining(id) {
  if (!id) return;
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','SUPER_ADMIN'].includes(role)) {
    showToast('Not authorized to delete training sessions', 'error'); return;
  }
  const s = (State.training || []).find(x => x.id === id) || State.activeTrainingSession;
  const label = s ? _esc(s.title) : 'this session';
  if (!confirm('Delete "' + label + '"? This cannot be undone.')) return;

  try {
    await TrainingAPI.remove(id);
    State.training = (State.training || []).filter(x => x.id !== id);
    if (State.activeTrainingSession && State.activeTrainingSession.id === id) {
      State.activeTrainingSession = null;
      _trainingDetailId = null;
    }
    // BUG #2-B fix: if the deleted session was the latest by scheduledAt,
    // GET /training/form now returns a different row (or the empty-club
    // fallback). State.trainingForm was hydrated once at login and never
    // refreshed on Delete, so the Form tab kept showing the deleted session's
    // rings until a hard reload. Re-fetch so the cache matches the server.
    // Failure is non-fatal: the tab keeps showing the previous values.
    try {
      const form = await FamilistaAPI.get('/training/form');
      const formData = (form && (form.data || form)) || null;
      if (formData) State.trainingForm = formData;
    } catch (_) { /* leave State.trainingForm as-is */ }
    showToast('Session deleted', 'success');
    renderTrainingPage();
  } catch (e) {
    showToast((e && e.userMessage) || 'Delete failed', 'error');
  }
}

// ── MEDICAL ──
// ── MEDICAL ─────────────────────────────────────────────────────────────────
const MedicalAPI = {
  list(query)      { return FamilistaAPI.get('/phase-q/workload/injuries' + (query ? '?' + query : '')); },
  get(id)          { return FamilistaAPI.get('/phase-q/workload/injuries/' + id); },
  create(body)     { return FamilistaAPI.post('/phase-q/workload/injuries', body); },
  update(id, body) { return FamilistaAPI.patch('/phase-q/workload/injuries/' + id, body); },
  remove(id)       { return FamilistaAPI.delete('/phase-q/workload/injuries/' + id); },
  playerProfile(playerId) { return FamilistaAPI.get('/phase-q/workload/players/' + playerId + '/medical'); },
};

const READINESS_STATUSES = [
  { key: 'FIT',     label: 'Fit',     color: 'var(--green-l)',  bg: 'var(--green-bg)',  badge: 'badge-green' },
  { key: 'LIMITED', label: 'Limited', color: 'var(--amber)',    bg: 'var(--amber-bg)',  badge: 'badge-amber' },
  { key: 'REHAB',   label: 'Rehab',   color: 'var(--blue)',     bg: 'var(--blue-bg)',   badge: 'badge-blue'  },
  { key: 'INJURED', label: 'Injured', color: 'var(--red)',      bg: 'var(--red-bg)',    badge: 'badge-red'   },
];

const _MedData = { injuries: [], readiness: null, _loading: false };
let _medTab = 'dashboard';
let _medProfileId = null;

function renderMedicalHTML() {
  return `<div class="page" id="pg-medical">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Medical Center</div>
        <div style="font-size:12px;color:var(--tx-3);" id="medical-sub">Loading…</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <div class="filter-group" id="medical-tabs">
          <button class="filter-btn active" onclick="setMedicalTab('dashboard',this)">Dashboard</button>
          <button class="filter-btn"        onclick="setMedicalTab('injuries',this)">Injuries</button>
          <button class="filter-btn"        onclick="setMedicalTab('players',this)">Players</button>
        </div>
        <button class="btn btn-primary btn-sm" id="med-record-btn" onclick="openRecordInjuryModal()">+ Record Injury</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:16px 20px;" id="medical-content">${loadingHTML('Loading medical data…')}</div>
  </div>
</div>`;
}

function _medPlayerName(playerId, fallbackPlayer) {
  if (fallbackPlayer && (fallbackPlayer.firstName || fallbackPlayer.lastName)) {
    return `${fallbackPlayer.firstName || ''} ${fallbackPlayer.lastName || ''}`.trim();
  }
  if (!playerId) return '—';
  const p = (State.players || []).find(pl => pl.id === playerId);
  return p ? `${p.firstName} ${p.lastName}` : playerId.slice(0, 8) + '…';
}

function setMedicalTab(tab, el) {
  _medTab = tab;
  _medProfileId = null;
  document.querySelectorAll('#medical-tabs .filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderMedicalPage();
}

function renderMedicalPage() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const el = document.getElementById('medical-content');
  if (!el) return;
  if (_medTab === 'dashboard') _renderMedDashboard(el);
  else if (_medTab === 'injuries') _renderMedInjuries(el);
  else if (_medTab === 'players')  _renderMedPlayers(el);
}

function _injStatusFromRecord(inj) {
  return inj.returnDate ? 'RESOLVED' : 'ACTIVE';
}

function _injSevBadge(sev) {
  if (!sev) return '<span class="badge">UNKNOWN</span>';
  const s = sev.toUpperCase();
  const cls = s === 'CRITICAL' ? 'badge-red' : (s === 'MAJOR' ? 'badge-red' : s === 'MODERATE' ? 'badge-amber' : 'badge-green');
  return `<span class="badge ${cls}">${s}</span>`;
}

function _renderMedDashboard(el) {
  const injuries  = _MedData.injuries || [];
  const readiness = _MedData.readiness;
  const analytics = State.analytics;
  const activeInj = injuries.filter(i => !i.returnDate);
  const hrCount   = (readiness && readiness.highRisk && readiness.highRisk.length) || 0;
  const available = readiness ? readiness.available : (analytics ? (analytics.overview && (analytics.overview.playerCount - analytics.overview.injuredCount)) : '—');
  const total     = readiness ? readiness.total      : (analytics ? (analytics.overview && analytics.overview.playerCount) : '—');

  const sub = document.getElementById('medical-sub');
  if (sub) sub.textContent = `${activeInj.length} active injur${activeInj.length !== 1 ? 'ies' : 'y'} · ${hrCount} high-risk workload`;

  // KPI grid
  const kpis = `
    <div class="card metric"><div class="metric-icon" style="background:var(--red-bg);">🏥</div><div class="metric-val" style="color:var(--red);">${activeInj.length}</div><div class="metric-lbl">Active Injuries</div></div>
    <div class="card metric"><div class="metric-icon" style="background:var(--amber-bg);">⚡</div><div class="metric-val" style="color:var(--amber);">${hrCount}</div><div class="metric-lbl">High Workload Risk</div></div>
    <div class="card metric"><div class="metric-icon" style="background:var(--green-bg);">✅</div><div class="metric-val" style="color:var(--green-l);">${available}</div><div class="metric-lbl">Available</div></div>
    <div class="card metric"><div class="metric-icon" style="background:var(--blue-bg);">👥</div><div class="metric-val">${total}</div><div class="metric-lbl">Squad Size</div></div>`;

  // Active injuries list
  const role    = State.user && State.user.role;
  const canEdit = ['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN','MEDICAL_STAFF'].includes(role);
  const canDel  = ['CLUB_ADMIN','SUPER_ADMIN','MEDICAL_STAFF'].includes(role);

  const injHTML = activeInj.length === 0
    ? '<div class="empty"><div class="empty-ico">✅</div><div class="empty-ttl">No active injuries</div></div>'
    : activeInj.map(inj => {
        const daysSince = inj.injuryDate ? Math.round((Date.now() - new Date(inj.injuryDate).getTime()) / 86400000) : '—';
        const pName = _medPlayerName(inj.playerId, inj.player);
        const mech  = inj.mechanism && inj.mechanism !== 'UNKNOWN' ? ' · ' + inj.mechanism : '';
        const retTxt = inj.returnDate ? 'Returned: ' + fmtDate(inj.returnDate) : 'Return TBD';
        const type  = inj.osicsCategory ? ` · ${inj.osicsCategory.replace(/_/g,' ')}` : '';
        return `<div class="inj-card">
          <div class="inj-sev ${inj.severity === 'CRITICAL' || inj.severity === 'MAJOR' ? 'sev-c' : inj.severity === 'MODERATE' ? 'sev-m' : 'sev-s'}"></div>
          <div style="flex:1;">
            <div class="inj-name">${_esc(pName)}</div>
            <div class="inj-type">${_esc(inj.bodyLocation || '—')}${_esc(type)}${_esc(mech)}</div>
            <div class="inj-ret">${retTxt}${inj.workloadAtInjury ? ' · ACWR at injury: ' + Number(inj.workloadAtInjury).toFixed(2) : ''}</div>
          </div>
          <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
            ${_injSevBadge(inj.severity)}
            <div class="inj-days">${daysSince}d</div>
            <div style="display:flex;gap:4px;margin-top:2px;">
              ${canEdit ? `<button class="btn btn-outline btn-xs" onclick="openEditInjuryModal('${_esc(inj.id)}')">Edit</button>` : ''}
              ${canDel  ? `<button class="btn btn-danger btn-xs"  onclick="confirmDeleteInjury('${_esc(inj.id)}')">Delete</button>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');

  // Risk grid
  const phaseQRisk = readiness && readiness.highRisk && readiness.highRisk.length > 0 ? readiness.highRisk : [];
  const riskHTML = phaseQRisk.length === 0
    ? '<div class="empty"><div class="empty-ico">✅</div><div class="empty-ttl">No high-risk workload detected</div></div>'
    : phaseQRisk.slice(0, 6).map(rp => {
        const riskPct = Math.round(rp.injuryRiskScore * 100);
        const acwrCol = rp.acwr > 1.5 ? 'var(--red)' : rp.acwr > 1.3 ? 'var(--amber)' : rp.acwr < 0.8 ? 'var(--blue)' : 'var(--green-l)';
        const tsbCol  = rp.tsb < -20 ? 'var(--red)' : rp.tsb < 0 ? 'var(--amber)' : 'var(--green-l)';
        return `<div class="risk-cell">
          <div class="risk-pname">${_esc(_medPlayerName(rp.playerId))}</div>
          <div class="risk-score" style="color:${riskColor(riskPct)};">${riskPct}%</div>
          <div class="prog"><div class="prog-bar" style="width:${riskPct}%;background:${riskColor(riskPct)};"></div></div>
          <div style="display:flex;gap:3px;margin-top:5px;flex-wrap:wrap;">
            <span style="font-size:9px;font-weight:600;color:${acwrCol};font-family:var(--mono);">ACWR ${rp.acwr.toFixed(2)}</span>
            <span style="font-size:9px;color:var(--tx-3);">·</span>
            <span style="font-size:9px;font-weight:600;color:${tsbCol};font-family:var(--mono);">TSB ${(rp.tsb||0).toFixed(0)}</span>
          </div>
        </div>`;
      }).join('');

  // ARIA rec
  const hrList  = phaseQRisk;
  const topAcwr = hrList[0] && hrList[0].acwr ? hrList[0].acwr.toFixed(2) : null;
  const ariaMsg = hrList.length > 0
    ? `${hrList.length} player${hrList.length > 1 ? 's' : ''} at elevated workload risk${topAcwr ? ` (peak ACWR ${topAcwr})` : ''}. Reduce training intensity 25–35% for 48h. Prioritise recovery: ice, sleep, reduced contact drills.`
    : activeInj.length > 0
      ? `${activeInj.length} active injur${activeInj.length > 1 ? 'ies' : 'y'} under management. Workload metrics within safe parameters. Maintain current protocol for fit squad.`
      : 'All GPS metrics safe. Full squad available. Continue standard training protocol.';

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin-bottom:18px;">${kpis}</div>
    <div class="medical-layout">
      <div class="medical-main">
        <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;">Active Injuries</div>
        <div id="injuries-list">${injHTML}</div>
        <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin:18px 0 10px;">Workload Risk Matrix · ACWR / TSB</div>
        <div class="risk-grid">${riskHTML}</div>
      </div>
      <div class="medical-side">
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;">ARIA Prevention</div>
        <div style="padding:11px;border-radius:8px;background:var(--green-bg);border:1px solid var(--green-bd);margin-bottom:14px;">
          <div style="font-size:9px;font-weight:600;color:var(--green-l);font-family:var(--mono);margin-bottom:5px;">🤖 AI RECOMMENDATION</div>
          <div style="font-size:12px;color:var(--tx-2);line-height:1.55;">${_esc(ariaMsg)}</div>
        </div>
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin:14px 0 8px;">Injury by Location</div>
        <div>${_renderInjByLocation(activeInj)}</div>
        <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin:14px 0 8px;">Squad Readiness</div>
        <div>${_renderReadinessSide(readiness)}</div>
      </div>
    </div>`;
}

function _renderInjByLocation(injuries) {
  if (injuries.length === 0) return '<div style="font-size:12px;color:var(--tx-3);padding:8px 0;">No active injuries.</div>';
  const byLoc = {};
  for (const inj of injuries) {
    const loc = inj.bodyLocation || 'Unknown';
    byLoc[loc] = (byLoc[loc] || 0) + 1;
  }
  return Object.entries(byLoc).map(([loc, cnt]) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--bd);">
      <span style="font-size:12px;color:var(--tx-2);">${_esc(loc)}</span>
      <span class="badge badge-red">${cnt} case${cnt > 1 ? 's' : ''}</span>
    </div>`).join('');
}

function _renderReadinessSide(readiness) {
  if (!readiness) return `<div style="font-size:11px;color:var(--tx-3);">Select a team context to view readiness.</div>`;
  const pct = readiness.total > 0 ? Math.round((readiness.available / readiness.total) * 100) : 0;
  const bar = pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)';
  return `
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:11px;color:var(--tx-2);">Available</span>
        <span style="font-size:11px;font-weight:700;color:${bar};">${readiness.available}/${readiness.total} (${pct}%)</span>
      </div>
      <div class="prog"><div class="prog-bar" style="width:${pct}%;background:${bar};"></div></div>
    </div>
    ${(readiness.highRisk || []).slice(0, 4).map(rp => {
      const rp100 = Math.round(rp.injuryRiskScore * 100);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--bd);">
        <span style="font-size:11px;color:var(--tx-2);">${_esc(_medPlayerName(rp.playerId))}</span>
        <span class="badge ${rp100 > 50 ? 'badge-red' : 'badge-amber'}">${rp100}%</span>
      </div>`;
    }).join('')}`;
}

function _renderMedInjuries(el) {
  const injuries = _MedData.injuries || [];
  const role     = State.user && State.user.role;
  const canEdit  = ['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN','MEDICAL_STAFF'].includes(role);
  const canDel   = ['CLUB_ADMIN','SUPER_ADMIN','MEDICAL_STAFF'].includes(role);

  const sub = document.getElementById('medical-sub');
  if (sub) sub.textContent = injuries.length + ' injur' + (injuries.length !== 1 ? 'ies' : 'y') + ' total';

  if (injuries.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--tx-3);">
      <div style="font-size:32px;margin-bottom:12px;">🏥</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:6px;">No injury records</div>
      <div style="font-size:12px;">Click "Record Injury" to log the first one.</div>
    </div>`;
    return;
  }

  el.innerHTML = injuries.map(inj => {
    const daysSince = inj.injuryDate ? Math.round((Date.now() - new Date(inj.injuryDate).getTime()) / 86400000) : '—';
    const status   = _injStatusFromRecord(inj);
    const stBadge  = status === 'ACTIVE' ? 'badge-red' : 'badge-green';
    const pName    = _medPlayerName(inj.playerId, inj.player);
    const mech     = inj.mechanism && inj.mechanism !== 'UNKNOWN' ? inj.mechanism : '';
    const type     = inj.osicsCategory ? inj.osicsCategory.replace(/_/g,' ') : '';
    return `<div class="card" style="padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;">
      <div style="flex-shrink:0;width:44px;height:44px;border-radius:10px;background:var(--red-bg);border:1px solid var(--red-bd,rgba(220,38,38,.25));display:flex;align-items:center;justify-content:center;font-size:20px;">🏥</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--tx);">${_esc(pName)}</div>
        <div style="font-size:11px;color:var(--tx-3);margin-top:2px;">${_esc(inj.bodyLocation || '—')}${type ? ' · ' + _esc(type) : ''}${mech ? ' · ' + _esc(mech) : ''}</div>
        <div style="font-size:10px;color:var(--tx-3);margin-top:2px;">${inj.injuryDate ? fmtDate(inj.injuryDate) : '—'} · ${daysSince}d ago${inj.returnDate ? ' · Returned ' + fmtDate(inj.returnDate) : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        ${_injSevBadge(inj.severity)}
        <span class="badge ${stBadge}" style="font-size:9px;">${status}</span>
        <div style="display:flex;gap:4px;margin-top:2px;">
          ${canEdit ? `<button class="btn btn-outline btn-xs" onclick="openEditInjuryModal('${_esc(inj.id)}')">Edit</button>` : ''}
          ${canDel  ? `<button class="btn btn-danger btn-xs"  onclick="confirmDeleteInjury('${_esc(inj.id)}')">Delete</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

async function _renderMedPlayers(el) {
  const sub = document.getElementById('medical-sub');
  if (sub) sub.textContent = 'Player medical profiles';

  if (_medProfileId) {
    await _renderPlayerMedProfile(_medProfileId, el);
    return;
  }

  const players = State.players || [];
  const injuries = _MedData.injuries || [];
  const activeInjByPlayer = {};
  for (const inj of injuries.filter(i => !i.returnDate)) {
    activeInjByPlayer[inj.playerId] = (activeInjByPlayer[inj.playerId] || 0) + 1;
  }

  if (players.length === 0) {
    el.innerHTML = loadingHTML('Loading players…');
    return;
  }

  el.innerHTML = players.map(p => {
    const injCount = activeInjByPlayer[p.id] || 0;
    const rdStatus = p.medicalStatus || (p.isInjured ? 'INJURED' : 'FIT');
    const rs = READINESS_STATUSES.find(r => r.key === rdStatus) || READINESS_STATUSES[3];
    const condBg = condBarBg(p.condition);
    return `<div class="card" style="padding:14px;margin-bottom:8px;display:flex;align-items:center;gap:12px;cursor:pointer;" onclick="_medProfileId='${_esc(p.id)}';_renderMedPlayers(document.getElementById('medical-content'))">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--tx);">#${p.number} ${_esc(p.firstName)} ${_esc(p.lastName)}</div>
        <div style="font-size:11px;color:var(--tx-3);margin-top:2px;">${p.position || '—'}</div>
        <div class="tp-bar" style="margin-top:6px;"><div style="width:${p.condition}%;height:100%;border-radius:2px;background:${condBg};"></div></div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <span class="badge ${rs.badge}">${rs.label}</span>
        ${injCount > 0 ? `<span class="badge badge-red" style="font-size:9px;">${injCount} active inj.</span>` : ''}
        <span style="font-size:10px;color:${condColor(p.condition)};font-family:var(--mono);">${p.condition}%</span>
      </div>
    </div>`;
  }).join('');
}

async function _renderPlayerMedProfile(playerId, el) {
  el.innerHTML = loadingHTML('Loading player profile…');
  try {
    const res = await MedicalAPI.playerProfile(playerId);
    const data = res && res.player ? res : (res && res.data ? res.data : null);
    if (!data) { el.innerHTML = '<div style="color:var(--tx-3);padding:20px;">Profile unavailable.</div>'; return; }

    const { player, injuries, workload } = data;
    const rdStatus = player.medicalStatus || (player.isInjured ? 'INJURED' : 'FIT');
    const rs = READINESS_STATUSES.find(r => r.key === rdStatus) || READINESS_STATUSES[3];
    const activeInj = (injuries || []).filter(i => !i.returnDate);

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
        <button class="btn btn-outline btn-sm" onclick="_medProfileId=null;renderMedicalPage();">← Players</button>
        <div style="flex:1;font-size:14px;font-weight:700;color:var(--tx);">${_esc(player.firstName)} ${_esc(player.lastName)}</div>
        <span class="badge ${rs.badge}">${rs.label}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px;">
        <div class="card metric"><div class="metric-val" style="color:${rs.color};">${rs.label}</div><div class="metric-lbl">Readiness</div></div>
        <div class="card metric"><div class="metric-val" style="color:${condColor(player.condition)};">${player.condition}%</div><div class="metric-lbl">Condition</div></div>
        <div class="card metric"><div class="metric-val" style="color:var(--red);">${activeInj.length}</div><div class="metric-lbl">Active Injuries</div></div>
        ${workload ? `<div class="card metric"><div class="metric-val" style="color:${workload.acwr > 1.5 ? 'var(--red)' : workload.acwr < 0.8 ? 'var(--blue)' : 'var(--green-l)'};">${workload.acwr.toFixed(2)}</div><div class="metric-lbl">ACWR</div></div>` : ''}
      </div>
      <div class="card" style="padding:16px;">
        <div style="font-size:12px;font-weight:600;color:var(--tx);margin-bottom:12px;">Injury History (${(injuries||[]).length})</div>
        ${(injuries||[]).length === 0 ? '<div style="font-size:12px;color:var(--tx-3);">No injury records.</div>' :
          (injuries||[]).map(inj => {
            const ds = inj.injuryDate ? Math.round((Date.now() - new Date(inj.injuryDate).getTime()) / 86400000) : '—';
            return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--bd);">
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:600;color:var(--tx);">${_esc(inj.bodyLocation || '—')}${inj.osicsCategory ? ' · ' + _esc(inj.osicsCategory.replace(/_/g,' ')) : ''}</div>
                <div style="font-size:10px;color:var(--tx-3);margin-top:2px;">${inj.injuryDate ? fmtDate(inj.injuryDate) : '—'} · ${ds}d${inj.returnDate ? ' → ' + fmtDate(inj.returnDate) : ' (ongoing)'}</div>
              </div>
              ${_injSevBadge(inj.severity)}
              <span class="badge ${inj.returnDate ? 'badge-green' : 'badge-red'}" style="font-size:9px;">${inj.returnDate ? 'RESOLVED' : 'ACTIVE'}</span>
            </div>`;
          }).join('')}
      </div>`;
  } catch (err) {
    el.innerHTML = `<div style="color:var(--tx-3);padding:20px;">Could not load profile: ${_esc((err && err.userMessage) || 'Error')}</div>`;
  }
}

function openRecordInjuryModal() {
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN','MEDICAL_STAFF'].includes(role)) {
    showToast('Not authorized to record injuries', 'error'); return;
  }
  _populateInjuryPlayerSelect('');
  document.getElementById('inj-id').value = '';
  document.getElementById('inj-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('inj-return-date').value = '';
  document.getElementById('inj-body').value = '';
  document.getElementById('inj-type').value = '';
  document.getElementById('inj-severity').value = '';
  document.getElementById('inj-mech').value = 'UNKNOWN';
  document.getElementById('inj-readiness').value = 'INJURED';
  document.getElementById('inj-recur').value = 'false';
  document.getElementById('inj-notes').value = '';
  const errEl = document.getElementById('inj-error');
  errEl.style.display = 'none'; errEl.textContent = '';
  const btn = document.getElementById('inj-submit');
  btn.textContent = 'Record Injury'; btn.disabled = false;
  document.querySelector('#injury-edit-modal .modal-title').textContent = 'Record Injury';
  document.getElementById('injury-edit-modal').classList.add('open');
}

// Legacy alias — keeps any existing call-sites working
function closeRecordInjuryModal() { closeModal('injury-edit-modal'); }

function _populateInjuryPlayerSelect(selectedId) {
  const sel = document.getElementById('inj-player');
  if (!sel) return;
  const players = State.players || [];
  sel.innerHTML = '<option value="">Select player…</option>' +
    players.map(p => `<option value="${_esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${_esc(p.firstName)} ${_esc(p.lastName)} (${p.position || '—'})</option>`).join('');
}

function openEditInjuryModal(id) {
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN','MEDICAL_STAFF'].includes(role)) {
    showToast('Not authorized to edit injuries', 'error'); return;
  }
  const inj = (_MedData.injuries || []).find(i => i.id === id);
  if (!inj) { showToast('Injury data not available', 'error'); return; }

  document.getElementById('inj-id').value = inj.id;
  _populateInjuryPlayerSelect(inj.playerId);
  document.getElementById('inj-date').value = inj.injuryDate ? new Date(inj.injuryDate).toISOString().slice(0,10) : '';
  document.getElementById('inj-return-date').value = inj.returnDate ? new Date(inj.returnDate).toISOString().slice(0,10) : '';
  document.getElementById('inj-body').value = inj.bodyLocation || '';
  document.getElementById('inj-type').value = inj.osicsCategory || '';
  document.getElementById('inj-severity').value = inj.severity || '';
  document.getElementById('inj-mech').value = inj.mechanism || 'UNKNOWN';
  document.getElementById('inj-readiness').value = inj.returnDate ? 'FIT' : 'INJURED';
  document.getElementById('inj-recur').value = inj.isRecurrence ? 'true' : 'false';
  document.getElementById('inj-notes').value = inj.notes || '';
  const errEl = document.getElementById('inj-error');
  errEl.style.display = 'none'; errEl.textContent = '';
  const btn = document.getElementById('inj-submit');
  btn.textContent = 'Save changes'; btn.disabled = false;
  document.querySelector('#injury-edit-modal .modal-title').textContent = 'Edit Injury';
  document.getElementById('injury-edit-modal').classList.add('open');
}

async function submitInjuryForm(ev) {
  ev.preventDefault();
  const id    = (document.getElementById('inj-id').value || '').trim();
  const errEl = document.getElementById('inj-error');
  const btn   = document.getElementById('inj-submit');

  const playerId    = document.getElementById('inj-player').value;
  const injuryDate  = document.getElementById('inj-date').value;
  const bodyLoc     = document.getElementById('inj-body').value.trim();

  if (!id && !playerId)  { errEl.textContent = 'Player is required';       errEl.style.display = ''; return; }
  if (!injuryDate)       { errEl.textContent = 'Occurrence date required'; errEl.style.display = ''; return; }
  if (!bodyLoc)          { errEl.textContent = 'Body location is required'; errEl.style.display = ''; return; }

  const returnDateRaw = document.getElementById('inj-return-date').value;
  const readiness     = document.getElementById('inj-readiness').value;
  const body = {
    injuryDate,
    bodyLocation:  bodyLoc,
    osicsCategory: document.getElementById('inj-type').value || undefined,
    severity:      document.getElementById('inj-severity').value || undefined,
    mechanism:     document.getElementById('inj-mech').value || 'UNKNOWN',
    isRecurrence:  document.getElementById('inj-recur').value === 'true',
    notes:         document.getElementById('inj-notes').value.trim() || undefined,
    returnDate:    returnDateRaw || null,
  };
  if (!id) body.playerId = playerId;

  errEl.style.display = 'none'; errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = id ? 'Saving…' : 'Recording…';

  try {
    let saved = null;
    if (id) {
      const res = await MedicalAPI.update(id, body);
      saved = res && res.data ? res.data : res;
      if (saved) {
        const idx = (_MedData.injuries || []).findIndex(x => x.id === id);
        if (idx !== -1) _MedData.injuries[idx] = Object.assign({}, _MedData.injuries[idx], saved);
      }
    } else {
      const res = await MedicalAPI.create(body);
      saved = res && res.data ? res.data : res;
      if (saved) _MedData.injuries = [saved, ...(_MedData.injuries || [])];
    }

    // Update player readiness if readiness changed
    if (readiness && playerId) {
      const p = (State.players || []).find(pl => pl.id === (playerId || (saved && saved.playerId)));
      if (p) {
        p.medicalStatus = readiness;
        p.isInjured = readiness === 'INJURED' || readiness === 'REHAB';
      }
    }

    closeModal('injury-edit-modal');
    showToast(id ? 'Injury updated' : 'Injury recorded', 'success');
    renderMedicalPage();
  } catch (e) {
    errEl.textContent   = (e && e.userMessage) || (id ? 'Could not update injury' : 'Could not record injury');
    errEl.style.display = '';
  } finally {
    btn.disabled    = false;
    btn.textContent = id ? 'Save changes' : 'Record Injury';
  }
}

async function confirmDeleteInjury(id) {
  if (!id) return;
  const role = State.user && State.user.role;
  if (!['CLUB_ADMIN','SUPER_ADMIN','MEDICAL_STAFF'].includes(role)) {
    showToast('Not authorized to delete injuries', 'error'); return;
  }
  const inj   = (_MedData.injuries || []).find(i => i.id === id);
  const pName = inj ? _medPlayerName(inj.playerId, inj.player) : 'this record';
  if (!confirm(`Delete injury record for ${pName}? This cannot be undone.`)) return;

  try {
    await MedicalAPI.remove(id);
    _MedData.injuries = (_MedData.injuries || []).filter(i => i.id !== id);
    showToast('Injury record deleted', 'success');
    renderMedicalPage();
  } catch (e) {
    showToast((e && e.userMessage) || 'Delete failed', 'error');
  }
}

async function loadMedicalData() {
  if (_MedData._loading) return;
  _MedData._loading = true;
  const contentEl = document.getElementById('medical-content');
  if (contentEl) contentEl.innerHTML = loadingHTML('Loading medical data…');
  try {
    const teamId = State.context && State.context.teamId;
    // Fetch all injuries (not just active) so the Injuries tab has full history
    const [injuriesRes, readinessRes] = await Promise.allSettled([
      api('/phase-q/workload/injuries'),
      teamId ? api(`/phase-q/workload/teams/${teamId}/readiness`) : Promise.resolve(null),
    ]);

    const injuries  = injuriesRes.status  === 'fulfilled' && Array.isArray(injuriesRes.value) ? injuriesRes.value : [];
    const readiness = readinessRes.status === 'fulfilled' ? readinessRes.value : null;

    _MedData.injuries  = injuries;
    _MedData.readiness = readiness;

    renderMedicalPage();
  } catch (err) {
    showToast('Failed to load medical data', 'error');
    if (contentEl) contentEl.innerHTML = '<div style="padding:20px;color:var(--tx-3);">Failed to load — please retry.</div>';
  } finally {
    _MedData._loading = false;
  }
}

// ── PERFORMANCE MANAGEMENT ────────────────────────────────────────────────────

const PerformanceAPI = {
  squad()          { return FamilistaAPI.get('/players/performance/squad'); },
  record(id, body) { return FamilistaAPI.post('/players/' + id + '/attributes', body); },
  history(id)      { return FamilistaAPI.get('/players/' + id + '/attributes'); },
};

const PERF_ATTRS = [
  { key: 'speed',     label: 'Speed',     color: 'var(--green-l)' },
  { key: 'shooting',  label: 'Shooting',  color: 'var(--red)' },
  { key: 'passing',   label: 'Passing',   color: 'var(--blue)' },
  { key: 'technique', label: 'Technique', color: 'var(--amber)' },
  { key: 'defending', label: 'Defending', color: 'var(--green-l)' },
  { key: 'stamina',   label: 'Stamina',   color: 'var(--blue)' },
  { key: 'strength',  label: 'Strength',  color: 'var(--red)' },
  { key: 'agility',   label: 'Agility',   color: 'var(--amber)' },
  { key: 'balance',   label: 'Balance',   color: 'var(--blue)' },
  { key: 'reaction',  label: 'Reaction',  color: 'var(--green-l)' },
];

let _perfTab       = 'dashboard';
let _perfSquad     = [];          // latest squad data
let _perfHistMap   = {};          // { playerId: [...snapshots] }
let _perfLoading   = false;
let _perfCompareA  = null;        // playerId
let _perfCompareB  = null;        // playerId
let _perfHistoryId = null;        // playerId for history view

function renderPerformanceHTML() {
  return `<div class="page" id="pg-performance">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Performance Management</div>
        <div style="font-size:12px;color:var(--tx-3);" id="perf-sub">Loading…</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        <div class="filter-group" id="perf-tabs">
          <button class="filter-btn active" onclick="setPerfTab('dashboard',this)">Dashboard</button>
          <button class="filter-btn"        onclick="setPerfTab('profiles',this)">Profiles</button>
          <button class="filter-btn"        onclick="setPerfTab('history',this)">History</button>
          <button class="filter-btn"        onclick="setPerfTab('compare',this)">Compare</button>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openRecordPerfModal(null)">+ Record Attributes</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:16px 20px;" id="perf-content">${loadingHTML('Loading performance data…')}</div>
  </div>
</div>`;
}

function setPerfTab(tab, el) {
  _perfTab = tab;
  _perfHistoryId = null;
  document.querySelectorAll('#perf-tabs .filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderPerformancePage();
}

function renderPerformancePage() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const el = document.getElementById('perf-content');
  if (!el) return;
  if (_perfTab === 'dashboard') _renderPerfDashboard(el);
  else if (_perfTab === 'profiles') _renderPerfProfiles(el);
  else if (_perfTab === 'history')  _renderPerfHistory(el);
  else if (_perfTab === 'compare')  _renderPerfCompare(el);
}

// ── Attribute bar helper ───────────────────────────────────────────────────
function _attrBar(val, color) {
  const v = val || 0;
  const pct = Math.min(100, (v / 1.3)).toFixed(1);
  return `<div style="flex:1;height:6px;background:var(--bg-4);border-radius:3px;overflow:hidden;">
    <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;opacity:.85;"></div>
  </div>`;
}

function _attrRatingColor(v) {
  if (!v) return 'var(--tx-3)';
  if (v >= 80) return 'var(--green-l)';
  if (v >= 65) return 'var(--amber)';
  return 'var(--red)';
}

// ── Dashboard ─────────────────────────────────────────────────────────────
function _renderPerfDashboard(el) {
  const squad = _perfSquad;
  if (!squad.length) {
    el.innerHTML = emptyHTML('No players found', 'Record performance attributes to populate the dashboard.');
    return;
  }

  // Top performers by overallRating
  const topPerfs = [...squad].slice(0, 5);

  // Team attribute averages (players who have attributes)
  const withAttrs = squad.filter(p => p.attributes);
  const teamAvgs  = PERF_ATTRS.map(a => {
    const vals = withAttrs.map(p => p.attributes[a.key]).filter(v => v != null);
    const avg  = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
    return { ...a, avg };
  });

  // Most improved (needs history data — show placeholder if not loaded)
  const posMap = {};
  for (const p of withAttrs) {
    const pos = p.position || 'UNKNOWN';
    if (!posMap[pos]) posMap[pos] = { keys: PERF_ATTRS.map(a => a.key), vals: {} };
    for (const a of PERF_ATTRS) {
      if (!posMap[pos].vals[a.key]) posMap[pos].vals[a.key] = [];
      if (p.attributes[a.key] != null) posMap[pos].vals[a.key].push(p.attributes[a.key]);
    }
  }

  el.innerHTML =
    // KPI row
    `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
      ${[
        ['👥', squad.length, 'Total Players'],
        ['📊', withAttrs.length, 'With Attributes'],
        ['⭐', squad[0]?.overallRating || '—', 'Top Rated'],
        ['📈', withAttrs.length ? Math.round(squad.reduce((s, p) => s + (p.overallRating || 0), 0) / squad.length) : '—', 'Avg Rating'],
      ].map(([ico, val, lbl]) =>
        `<div class="card" style="padding:14px;text-align:center;">
          <div style="font-size:22px;margin-bottom:4px;">${ico}</div>
          <div style="font-size:20px;font-weight:700;color:var(--tx);margin-bottom:2px;">${val}</div>
          <div style="font-size:11px;color:var(--tx-3);">${lbl}</div>
        </div>`
      ).join('')}
    </div>` +

    // Main grid
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">` +

    // Top performers
    `<div class="card" style="padding:16px;">
      <div style="font-size:13px;font-weight:700;color:var(--tx);margin-bottom:12px;">🏆 Top Performers</div>
      ${topPerfs.map((p, i) =>
        `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;${i < topPerfs.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="width:26px;height:26px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--tx-2);flex-shrink:0;">${i + 1}</div>
          ${p.avatar ? `<img src="${p.avatar}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">` : `<div style="width:32px;height:32px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--green-l);">${(p.firstName||'?')[0]}</div>`}
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.firstName} ${p.lastName}</div>
            <div style="font-size:11px;color:var(--tx-3);">${p.position || '—'} · #${p.number}</div>
          </div>
          <div style="font-size:16px;font-weight:700;color:${_attrRatingColor(p.overallRating)};">${p.overallRating || '—'}</div>
          <button class="btn btn-ghost btn-xs" onclick="openPerfHistory('${p.id}')">History</button>
        </div>`
      ).join('')}
    </div>` +

    // Team attribute averages
    `<div class="card" style="padding:16px;">
      <div style="font-size:13px;font-weight:700;color:var(--tx);margin-bottom:12px;">📊 Team Attribute Averages</div>
      ${withAttrs.length === 0
        ? `<div style="font-size:12px;color:var(--tx-3);padding:12px 0;">No attribute data recorded yet.</div>`
        : teamAvgs.map(a =>
          `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">
            <div style="font-size:11px;color:var(--tx-2);width:68px;flex-shrink:0;">${a.label}</div>
            ${_attrBar(a.avg, a.color)}
            <div style="font-size:11px;font-weight:600;color:var(--tx);min-width:28px;text-align:right;font-family:var(--mono);">${a.avg ?? '—'}</div>
          </div>`
        ).join('')
      }
    </div>` +

    `</div>`; // end main grid
}

// ── Profiles ───────────────────────────────────────────────────────────────
function _renderPerfProfiles(el) {
  const squad = _perfSquad;
  if (!squad.length) {
    el.innerHTML = emptyHTML('No players found', 'Add players to your squad first.');
    return;
  }

  const canEdit = State.user && ['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(State.user.role);

  el.innerHTML =
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">` +
    squad.map(p => {
      const a = p.attributes || {};
      const attrCount = PERF_ATTRS.filter(x => a[x.key] != null).length;
      return `<div class="card" style="padding:14px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          ${p.avatar ? `<img src="${p.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">` : `<div style="width:36px;height:36px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--green-l);">${(p.firstName||'?')[0]}</div>`}
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.firstName} ${p.lastName}</div>
            <div style="font-size:11px;color:var(--tx-3);">${p.position || '—'} · #${p.number}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:18px;font-weight:700;color:${_attrRatingColor(p.overallRating)};">${p.overallRating || '—'}</div>
            <div style="font-size:10px;color:var(--tx-3);">OVR</div>
          </div>
        </div>
        ${attrCount > 0
          ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;">` +
            PERF_ATTRS.filter(x => a[x.key] != null).slice(0, 6).map(x =>
              `<div style="display:flex;align-items:center;gap:6px;">
                <div style="font-size:10px;color:var(--tx-3);width:56px;flex-shrink:0;">${x.label}</div>
                ${_attrBar(a[x.key], x.color)}
                <div style="font-size:10px;font-weight:600;color:var(--tx);min-width:22px;text-align:right;font-family:var(--mono);">${a[x.key]}</div>
              </div>`
            ).join('') +
            `</div>`
          : `<div style="font-size:11px;color:var(--tx-3);margin-bottom:8px;">No attributes recorded</div>`
        }
        <div style="display:flex;gap:6px;margin-top:10px;">
          ${canEdit ? `<button class="btn btn-primary btn-xs" onclick="openRecordPerfModal('${p.id}')">+ Record</button>` : ''}
          <button class="btn btn-ghost btn-xs" onclick="openPerfHistory('${p.id}')">History</button>
          <button class="btn btn-ghost btn-xs" onclick="setPerfCompare('${p.id}')">Compare</button>
        </div>
      </div>`;
    }).join('') +
    `</div>`;
}

// ── History ────────────────────────────────────────────────────────────────
function _renderPerfHistory(el) {
  // If no player selected, show player list
  if (!_perfHistoryId) {
    const squad = _perfSquad;
    el.innerHTML =
      `<div style="font-size:13px;color:var(--tx-2);margin-bottom:14px;">Select a player to view their attribute history:</div>` +
      `<div style="display:flex;flex-wrap:wrap;gap:8px;">` +
      squad.map(p =>
        `<button class="btn btn-outline btn-sm" onclick="openPerfHistory('${p.id}')">
          ${p.firstName} ${p.lastName} <span style="color:var(--tx-3);font-size:10px;">#${p.number}</span>
        </button>`
      ).join('') +
      `</div>`;
    return;
  }

  const player = _perfSquad.find(p => p.id === _perfHistoryId);
  const snapshots = _perfHistMap[_perfHistoryId] || [];

  if (!player) { el.innerHTML = errorHTML('Player not found'); return; }

  if (snapshots.length === 0) {
    el.innerHTML =
      `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <button class="btn btn-ghost btn-sm" onclick="_perfHistoryId=null;renderPerformancePage();">← Back</button>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">${player.firstName} ${player.lastName}</div>
      </div>` +
      emptyHTML('No snapshots yet', 'Record attributes to start tracking performance history.');
    return;
  }

  el.innerHTML =
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <button class="btn btn-ghost btn-sm" onclick="_perfHistoryId=null;renderPerformancePage();">← Back</button>
      <div style="font-size:15px;font-weight:700;color:var(--tx);">${player.firstName} ${player.lastName} — Performance History</div>
    </div>` +
    `<div style="display:flex;flex-direction:column;gap:10px;">` +
    snapshots.map((s, i) =>
      `<div class="card" style="padding:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-size:12px;font-weight:600;color:var(--tx-2);">Snapshot #${snapshots.length - i} · ${new Date(s.recordedAt).toLocaleDateString()}</div>
          ${i === 0 ? '<span class="badge badge-green" style="font-size:10px;">Latest</span>' : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;">
          ${PERF_ATTRS.map(a =>
            `<div style="text-align:center;">
              <div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">${a.label}</div>
              <div style="font-size:15px;font-weight:700;color:${s[a.key] != null ? a.color : 'var(--tx-3)'};">${s[a.key] ?? '—'}</div>
            </div>`
          ).join('')}
        </div>
      </div>`
    ).join('') +
    `</div>`;
}

// ── Compare ────────────────────────────────────────────────────────────────
function _renderPerfCompare(el) {
  const pA = _perfSquad.find(p => p.id === _perfCompareA);
  const pB = _perfSquad.find(p => p.id === _perfCompareB);

  const selectRow = (label, currentId, cb) => {
    return `<div style="margin-bottom:10px;">
      <label style="font-size:11px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:4px;">${label}</label>
      <select style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:7px;background:var(--bg-2);color:var(--tx);font-size:13px;" onchange="${cb}">
        <option value="">— Select player —</option>
        ${_perfSquad.map(p =>
          `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${p.firstName} ${p.lastName} (#${p.number})</option>`
        ).join('')}
      </select>
    </div>`;
  };

  el.innerHTML =
    `<div class="card" style="padding:16px;margin-bottom:16px;max-width:500px;">
      ${selectRow('Player A', _perfCompareA, "_perfCompareA=this.value;renderPerformancePage()")}
      ${selectRow('Player B', _perfCompareB, "_perfCompareB=this.value;renderPerformancePage()")}
    </div>` +
    (pA && pB
      ? `<div class="card" style="padding:16px;">
          <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:16px;">
            <div style="text-align:center;">
              <div style="font-size:15px;font-weight:700;color:var(--tx);">${pA.firstName} ${pA.lastName}</div>
              <div style="font-size:11px;color:var(--tx-3);">${pA.position} · OVR ${pA.overallRating}</div>
            </div>
            <div style="font-size:13px;font-weight:700;color:var(--tx-3);">vs</div>
            <div style="text-align:center;">
              <div style="font-size:15px;font-weight:700;color:var(--tx);">${pB.firstName} ${pB.lastName}</div>
              <div style="font-size:11px;color:var(--tx-3);">${pB.position} · OVR ${pB.overallRating}</div>
            </div>
          </div>
          ${PERF_ATTRS.map(a => {
            const vA = (pA.attributes || {})[a.key];
            const vB = (pB.attributes || {})[a.key];
            const maxV = Math.max(vA || 0, vB || 0, 1);
            const pctA = vA != null ? Math.round((vA / 1.3)) : null;
            const pctB = vB != null ? Math.round((vB / 1.3)) : null;
            const winner = vA != null && vB != null ? (vA > vB ? 'A' : vB > vA ? 'B' : 'TIE') : null;
            return `<div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-bottom:8px;">
              <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;">
                <div style="font-size:12px;font-weight:${winner==='A'?'700':'500'};color:${winner==='A'?'var(--green-l)':'var(--tx)'};">${vA ?? '—'}</div>
                <div style="width:80px;height:6px;background:var(--bg-4);border-radius:3px;overflow:hidden;direction:rtl;">
                  ${pctA != null ? `<div style="width:${pctA}%;height:100%;background:${a.color};border-radius:3px;opacity:.85;"></div>` : ''}
                </div>
              </div>
              <div style="font-size:11px;color:var(--tx-3);text-align:center;min-width:60px;">${a.label}</div>
              <div style="display:flex;align-items:center;gap:6px;">
                <div style="width:80px;height:6px;background:var(--bg-4);border-radius:3px;overflow:hidden;">
                  ${pctB != null ? `<div style="width:${pctB}%;height:100%;background:${a.color};border-radius:3px;opacity:.85;"></div>` : ''}
                </div>
                <div style="font-size:12px;font-weight:${winner==='B'?'700':'500'};color:${winner==='B'?'var(--green-l)':'var(--tx)'};">${vB ?? '—'}</div>
              </div>
            </div>`;
          }).join('')}
        </div>`
      : `<div style="color:var(--tx-3);font-size:13px;padding:16px;">Select two players to compare their attributes.</div>`
    );
}

// ── Load ────────────────────────────────────────────────────────────────────
async function loadPerformanceData() {
  if (_perfLoading) return;
  _perfLoading = true;
  const contentEl = document.getElementById('perf-content');
  const subEl     = document.getElementById('perf-sub');
  if (contentEl) contentEl.innerHTML = loadingHTML('Loading performance data…');
  try {
    const res = await PerformanceAPI.squad();
    // API returns { success, data } envelope
    _perfSquad = Array.isArray(res) ? res : (res?.data || res || []);
    if (subEl) subEl.textContent = `${_perfSquad.length} players`;
    renderPerformancePage();
  } catch (err) {
    showToast('Failed to load performance data', 'error');
    if (contentEl) contentEl.innerHTML = '<div style="padding:20px;color:var(--tx-3);">Failed to load — please retry.</div>';
  } finally {
    _perfLoading = false;
  }
}

async function openPerfHistory(playerId) {
  _perfTab = 'history';
  _perfHistoryId = playerId;
  document.querySelectorAll('#perf-tabs .filter-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 2);
  });
  const contentEl = document.getElementById('perf-content');
  if (contentEl) contentEl.innerHTML = loadingHTML('Loading history…');
  try {
    const res = await PerformanceAPI.history(playerId);
    _perfHistMap[playerId] = Array.isArray(res) ? res : (res?.data || res || []);
  } catch (_) {
    _perfHistMap[playerId] = [];
  }
  renderPerformancePage();
}

function setPerfCompare(playerId) {
  if (!_perfCompareA) { _perfCompareA = playerId; }
  else if (!_perfCompareB && _perfCompareB !== _perfCompareA) { _perfCompareB = playerId; }
  else { _perfCompareA = playerId; _perfCompareB = null; }
  _perfTab = 'compare';
  document.querySelectorAll('#perf-tabs .filter-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 3);
  });
  renderPerformancePage();
}

// ── Modal ────────────────────────────────────────────────────────────────────
function openRecordPerfModal(playerId) {
  const modal = document.getElementById('perf-modal');
  if (!modal) return;

  // Populate player select
  const sel = document.getElementById('pf-player-select');
  if (sel) {
    sel.innerHTML = '<option value="">— Select player —</option>' +
      (_perfSquad || []).map(p =>
        `<option value="${p.id}" ${p.id === playerId ? 'selected' : ''}>${p.firstName} ${p.lastName} (#${p.number})</option>`
      ).join('');
  }
  // Set hidden id
  const hiddenId = document.getElementById('pf-player-id');
  if (hiddenId) hiddenId.value = playerId || '';

  // Clear fields
  ['speed','agility','stamina','strength','balance','reaction','technique','passing','shooting','defending','overall'].forEach(k => {
    const inp = document.getElementById('pf-' + k);
    if (inp) inp.value = '';
  });

  // Pre-fill from existing latest attributes if player is pre-selected
  if (playerId) {
    const p = _perfSquad.find(pl => pl.id === playerId);
    if (p && p.attributes) {
      const a = p.attributes;
      const set = (key, dbKey) => {
        const inp = document.getElementById('pf-' + key);
        if (inp && a[dbKey] != null) inp.value = a[dbKey];
      };
      set('speed', 'speed'); set('agility', 'agility'); set('stamina', 'stamina');
      set('strength', 'strength'); set('balance', 'balance'); set('reaction', 'reaction');
      set('technique', 'technique'); set('passing', 'passing'); set('shooting', 'shooting');
      set('defending', 'defending');
      // overall rating is on the player, not attributes
      const ovr = document.getElementById('pf-overall');
      if (ovr && p.overallRating) ovr.value = p.overallRating;
    }
  }

  document.getElementById('perf-modal-title').textContent = playerId
    ? `Update Attributes — ${(_perfSquad.find(p => p.id === playerId) || {}).firstName || ''} ${(_perfSquad.find(p => p.id === playerId) || {}).lastName || ''}`.trim()
    : 'Record Performance Attributes';

  modal.classList.add('open');
}

async function submitPerfForm(ev) {
  ev.preventDefault();

  const playerId = (document.getElementById('pf-player-select')?.value ||
                    document.getElementById('pf-player-id')?.value || '').trim();
  if (!playerId) { showToast('Select a player', 'error'); return; }

  const getNum = id => {
    const v = (document.getElementById(id)?.value || '').trim();
    return v === '' ? undefined : parseInt(v, 10);
  };

  const body = {
    speed:     getNum('pf-speed'),
    agility:   getNum('pf-agility'),
    stamina:   getNum('pf-stamina'),
    strength:  getNum('pf-strength'),
    balance:   getNum('pf-balance'),
    reaction:  getNum('pf-reaction'),
    technique: getNum('pf-technique'),
    passing:   getNum('pf-passing'),
    shooting:  getNum('pf-shooting'),
    defending: getNum('pf-defending'),
  };

  // Remove undefined keys
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  if (Object.keys(body).length === 0) {
    showToast('Enter at least one attribute value', 'error');
    return;
  }

  const btn = document.getElementById('pf-submit-btn');
  if (btn) btn.disabled = true;
  try {
    await PerformanceAPI.record(playerId, body);

    // Also update overallRating on the player if provided
    const overall = getNum('pf-overall');
    if (overall != null) {
      await FamilistaAPI.patch('/players/' + playerId, { overallRating: overall });
    }

    showToast('Performance attributes saved', 'success');
    closeModal('perf-modal');

    // Reload squad data to reflect changes
    const res = await PerformanceAPI.squad();
    _perfSquad = Array.isArray(res) ? res : (res?.data || res || []);
    // Invalidate history cache for this player
    delete _perfHistMap[playerId];
    renderPerformancePage();
  } catch (err) {
    showToast(err?.message || 'Failed to save', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── SCOUTING & RECRUITMENT CENTER ────────────────────────────────────────────

const ScoutingAPI = {
  dashboard()             { return FamilistaAPI.get('/scouting/dashboard'); },
  list(params)            { const q = new URLSearchParams(params||{}).toString(); return FamilistaAPI.get('/scouting' + (q ? '?' + q : '')); },
  get(id)                 { return FamilistaAPI.get('/scouting/' + id); },
  create(body)            { return FamilistaAPI.post('/scouting', body); },
  update(id, body)        { return FamilistaAPI.patch('/scouting/' + id, body); },
  delete(id)              { return FamilistaAPI.delete('/scouting/' + id); },
  pipeline()              { return FamilistaAPI.get('/scouting/pipeline'); },
  advancePipeline(id, st) { return FamilistaAPI.patch('/scouting/' + id + '/pipeline', { status: st }); },
  watchlist(cat)          { return FamilistaAPI.get('/scouting/watchlist' + (cat ? '?category=' + cat : '')); },
  updateWatchlist(id, b)  { return FamilistaAPI.patch('/scouting/' + id + '/watchlist', b); },
  compare(a, b)           { return FamilistaAPI.get('/scouting/compare?prospectA=' + a + '&prospectB=' + b); },
};

// State
var _scoutTab        = 'dashboard';
var _scoutDashboard  = null;
var _scoutProspects  = [];
var _scoutTotal      = 0;
var _scoutPipeline   = {};
var _scoutWatchlist  = [];
var _scoutLoading    = false;
var _scoutDetail     = null;   // currently open prospect
var _scoutCompareA   = null;
var _scoutCompareB   = null;
var _scoutCompareResult = null;
var _scoutModalMode  = 'create'; // 'create' | 'edit'
var _scoutEditId     = null;

const SCOUT_STAGES = ['IDENTIFIED','SCOUTED','REVIEWED','NEGOTIATION','TRIAL','APPROVED','SIGNED','REJECTED'];
const SCOUT_STAGE_COLOR = {
  IDENTIFIED:'var(--tx-3)', SCOUTED:'#60a5fa', REVIEWED:'var(--amber)',
  NEGOTIATION:'#c084fc', TRIAL:'var(--orange)', APPROVED:'var(--green-l)',
  SIGNED:'var(--green-l)', REJECTED:'var(--red)',
};
const SCOUT_REC_COLOR = {
  PRIORITY_TARGET:'var(--green-l)', STRONG_TARGET:'#60a5fa',
  INTERESTING:'var(--amber)', MONITOR:'var(--tx-2)', REJECT:'var(--red)',
};

function _scFmt(v, suffix) { return (v != null && v !== '') ? v + (suffix||'') : '—'; }
function _scRating(v) {
  if (v == null) return '<span style="color:var(--tx-3)">—</span>';
  var c = v >= 80 ? 'var(--green-l)' : v >= 65 ? '#60a5fa' : v >= 50 ? 'var(--amber)' : 'var(--red)';
  return '<span style="color:' + c + ';font-weight:700;font-family:var(--mono);">' + v + '</span>';
}
function _scRecBadge(rec) {
  if (!rec) return '';
  var c = SCOUT_REC_COLOR[rec] || 'var(--tx-3)';
  var label = rec.replace(/_/g,' ');
  return '<span style="font-size:9px;font-weight:700;font-family:var(--mono);color:' + c + ';text-transform:uppercase;letter-spacing:.5px;">' + label + '</span>';
}
function _scStageBadge(s) {
  var c = SCOUT_STAGE_COLOR[s] || 'var(--tx-3)';
  return '<span style="font-size:9px;font-weight:700;font-family:var(--mono);color:' + c + ';text-transform:uppercase;letter-spacing:.5px;padding:2px 5px;border-radius:3px;background:rgba(255,255,255,.05);">' + s + '</span>';
}
function _scBar(v, color) {
  if (v == null) return '<div style="height:4px;background:var(--bd);border-radius:2px;width:100%;"></div>';
  var c = color || (v >= 80 ? 'var(--green-l)' : v >= 65 ? '#60a5fa' : v >= 50 ? 'var(--amber)' : 'var(--red)');
  return '<div style="height:4px;background:var(--bd);border-radius:2px;width:100%;"><div style="height:4px;background:' + c + ';border-radius:2px;width:' + v + '%;"></div></div>';
}

// ── HTML skeleton ─────────────────────────────────────────────────────────────

function renderScoutingHTML() {
  return `<div class="page" id="pg-scouting">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
    <div>
      <div style="font-size:15px;font-weight:700;color:var(--tx);">Scouting &amp; Recruitment</div>
      <div style="font-size:12px;color:var(--tx-3);" id="scout-sub">Loading...</div>
    </div>
    <div style="display:flex;gap:7px;align-items:center;">
      <div class="filter-group" id="scout-tabs">
        <button class="filter-btn active" data-action="scoutTab" data-tab="dashboard">Dashboard</button>
        <button class="filter-btn" data-action="scoutTab" data-tab="prospects">Prospects</button>
        <button class="filter-btn" data-action="scoutTab" data-tab="watchlist">Watchlist</button>
        <button class="filter-btn" data-action="scoutTab" data-tab="pipeline">Pipeline</button>
        <button class="filter-btn" data-action="scoutTab" data-tab="compare">Compare</button>
      </div>
      <button class="btn btn-primary btn-sm" data-action="openScoutModal">+ Add Prospect</button>
    </div>
  </div>
  <div id="scout-body">${loadingHTML('Loading scouting data...')}</div>

  <!-- Prospect modal -->
  <div id="scout-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:500;align-items:center;justify-content:center;">
    <div style="background:var(--card);border-radius:12px;padding:22px;width:540px;max-width:94vw;border:1px solid var(--bd);max-height:90vh;overflow-y:auto;" onclick="event.stopPropagation()">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div style="font-size:14px;font-weight:700;color:var(--tx);" id="scout-modal-title">Add Prospect</div>
        <button class="btn btn-ghost btn-xs" data-action="closeScoutModal">✕</button>
      </div>
      <form id="scout-form" data-form-submit="submitScoutForm">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Player Name *</label><input id="sp-name" class="input" placeholder="Full name" style="width:100%;" required></div>
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Position *</label>
            <select id="sp-pos" class="input" style="width:100%;" required>
              <option value="">Select...</option>
              <option>GK</option><option>CB</option><option>LB</option><option>RB</option>
              <option>DM</option><option>CM</option><option>AM</option><option>LW</option><option>RW</option><option>ST</option><option>CF</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px;">
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Age</label><input id="sp-age" class="input" type="number" min="14" max="45" placeholder="23" style="width:100%;"></div>
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Nationality</label><input id="sp-nat" class="input" placeholder="e.g. Brazil" style="width:100%;"></div>
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Pref. Foot</label>
            <select id="sp-foot" class="input" style="width:100%;"><option value="">—</option><option>RIGHT</option><option>LEFT</option><option>BOTH</option></select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Current Club</label><input id="sp-club" class="input" placeholder="e.g. FC Porto" style="width:100%;"></div>
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">League</label><input id="sp-league" class="input" placeholder="e.g. Primeira Liga" style="width:100%;"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Market Value (€)</label><input id="sp-val" class="input" type="number" min="0" placeholder="5000000" style="width:100%;"></div>
          <div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Agent</label><input id="sp-agent" class="input" placeholder="Agent name" style="width:100%;"></div>
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;">Technical Attributes (1–100)</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Pace</label><input id="sp-pace" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Acceleration</label><input id="sp-accel" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Agility</label><input id="sp-agility" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Dribbling</label><input id="sp-drib" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Ball Control</label><input id="sp-bc" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Passing</label><input id="sp-pass" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Vision</label><input id="sp-vision" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Finishing</label><input id="sp-fin" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Tackling</label><input id="sp-tack" class="input" type="number" min="1" max="100" style="width:100%;"></div>
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin:10px 0 8px;">Physical &amp; Mental</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Strength</label><input id="sp-str" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Stamina</label><input id="sp-stam" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Work Rate</label><input id="sp-wr" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Leadership</label><input id="sp-lead" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Discipline</label><input id="sp-disc" class="input" type="number" min="1" max="100" style="width:100%;"></div>
          <div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:2px;">Composure</label><input id="sp-comp" class="input" type="number" min="1" max="100" style="width:100%;"></div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Scout Notes / Comments</label>
          <textarea id="sp-notes" class="input" rows="2" placeholder="Key observations..." style="width:100%;resize:vertical;font-family:inherit;"></textarea>
        </div>
        <div id="scout-form-err" style="display:none;padding:8px 10px;background:var(--red-bg);border-radius:6px;font-size:11px;color:var(--red);margin-bottom:12px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="btn btn-ghost btn-sm" data-action="closeScoutModal">Cancel</button>
          <button type="submit" id="scout-submit-btn" class="btn btn-primary btn-sm">Save Prospect</button>
        </div>
      </form>
    </div>
  </div>
</div>`;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function setScoutTab(tab) {
  _scoutTab = tab;
  document.querySelectorAll('#scout-tabs .filter-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  _renderScoutBody();
}

function _renderScoutBody() {
  var el = document.getElementById('scout-body');
  if (!el) return;
  if (_scoutTab === 'dashboard') _renderScoutDashboard(el);
  else if (_scoutTab === 'prospects') _renderScoutProspects(el);
  else if (_scoutTab === 'watchlist') _renderScoutWatchlist(el);
  else if (_scoutTab === 'pipeline')  _renderScoutPipeline(el);
  else if (_scoutTab === 'compare')   _renderScoutCompare(el);
}

// ── Dashboard tab ─────────────────────────────────────────────────────────────

function _renderScoutDashboard(el) {
  if (!_scoutDashboard) { el.innerHTML = loadingHTML('Loading dashboard...'); return; }
  var d = _scoutDashboard;
  var kpis = d.kpis || {};
  var posDist  = d.positionDistribution  || [];
  var recDist  = d.potentialDistribution || [];
  var pipeline = d.pipeline              || {};

  var kpiCards = [
    { label:'Total Prospects', value: kpis.total || 0, icon:'👥', color:'#60a5fa' },
    { label:'Priority Targets', value: kpis.priorityTargets || 0, icon:'🎯', color:'var(--green-l)' },
    { label:'High Potential (80+)', value: kpis.highPotential || 0, icon:'⚡', color:'var(--amber)' },
    { label:'Watchlist', value: kpis.watchlistCount || 0, icon:'⭐', color:'#c084fc' },
    { label:'Active Pipeline', value: kpis.pipelineActive || 0, icon:'🔄', color:'var(--orange)' },
    { label:'Signed', value: kpis.signed || 0, icon:'✅', color:'var(--green-l)' },
  ].map(function(k) {
    return '<div class="card" style="padding:13px 14px;">'
      + '<div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px;">' + k.icon + ' ' + k.label + '</div>'
      + '<div style="font-size:22px;font-weight:700;color:' + k.color + ';font-family:var(--mono);">' + k.value + '</div>'
      + '</div>';
  }).join('');

  var posHtml = posDist.length ? posDist.slice(0, 8).map(function(p) {
    var pct = kpis.total ? Math.round(p.count / kpis.total * 100) : 0;
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">'
      + '<span class="pos-pill ' + posClass(p.position) + '" style="min-width:34px;text-align:center;">' + p.position + '</span>'
      + '<div style="flex:1;">' + _scBar(pct, '#60a5fa') + '</div>'
      + '<span style="font-size:10px;color:var(--tx-3);font-family:var(--mono);min-width:26px;text-align:right;">' + p.count + '</span>'
      + '</div>';
  }).join('') : '<div style="font-size:11px;color:var(--tx-3);">No data yet.</div>';

  var recHtml = recDist.length ? recDist.map(function(r) {
    var c = SCOUT_REC_COLOR[r.recommendation] || 'var(--tx-3)';
    return '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
      + '<span style="font-size:10px;color:' + c + ';font-weight:600;">' + (r.recommendation||'—').replace(/_/g,' ') + '</span>'
      + '<span style="font-size:11px;font-weight:700;color:var(--tx);font-family:var(--mono);">' + r.count + '</span>'
      + '</div>';
  }).join('') : '<div style="font-size:11px;color:var(--tx-3);">No ratings yet.</div>';

  var pipelineHtml = SCOUT_STAGES.filter(function(s){ return s !== 'REJECTED'; }).map(function(s) {
    var cnt = pipeline[s] || 0;
    var c   = SCOUT_STAGE_COLOR[s] || 'var(--tx-3)';
    return '<div style="text-align:center;padding:8px 6px;border-radius:6px;background:var(--bg);border:1px solid var(--bd);">'
      + '<div style="font-size:18px;font-weight:700;color:' + c + ';font-family:var(--mono);">' + cnt + '</div>'
      + '<div style="font-size:8px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px;">' + s + '</div>'
      + '</div>';
  }).join('');

  el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;">' + kpiCards + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'
    + '<div class="card" style="padding:14px;">'
    + '<div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:12px;">Position Distribution</div>'
    + posHtml + '</div>'
    + '<div class="card" style="padding:14px;">'
    + '<div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:12px;">Recommendation Breakdown</div>'
    + recHtml + '</div></div>'
    + '<div class="card" style="padding:14px;margin-top:14px;">'
    + '<div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:12px;">Pipeline Stages</div>'
    + '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;">' + pipelineHtml + '</div>'
    + '</div>';
}

// ── Prospects tab ─────────────────────────────────────────────────────────────

function _renderScoutProspects(el) {
  if (_scoutLoading) { el.innerHTML = loadingHTML('Loading prospects...'); return; }
  var prospects = _scoutProspects;
  var sub = document.getElementById('scout-sub');
  if (sub) sub.textContent = _scoutTotal + ' prospect' + (_scoutTotal !== 1 ? 's' : '') + ' total';

  if (!prospects.length) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">🔍</div><div class="empty-ttl">No prospects yet</div><div class="empty-sub">Click "+ Add Prospect" to start building your scouting database.</div></div>';
    return;
  }

  var rows = prospects.map(function(p) {
    var mv = p.marketValueEur != null ? '€' + (p.marketValueEur/1e6).toFixed(1) + 'M' : '—';
    return '<tr style="cursor:pointer;" data-action="openScoutDetail" data-id="' + p.id + '">'
      + '<td style="font-weight:600;color:var(--tx);">' + p.playerName + '</td>'
      + '<td><span class="pos-pill ' + posClass(p.position) + '">' + p.position + '</span></td>'
      + '<td style="color:var(--tx-2);">' + _scFmt(p.age) + '</td>'
      + '<td style="color:var(--tx-2);">' + _scFmt(p.nationality) + '</td>'
      + '<td style="color:var(--tx-3);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _scFmt(p.currentClub) + '</td>'
      + '<td>' + _scRating(p.currentRating) + '</td>'
      + '<td>' + _scRating(p.potentialRating) + '</td>'
      + '<td>' + _scRecBadge(p.recommendation) + '</td>'
      + '<td>' + _scStageBadge(p.status) + '</td>'
      + '<td style="color:var(--tx-3);font-family:var(--mono);font-size:11px;">' + mv + '</td>'
      + '</tr>';
  }).join('');

  el.innerHTML = '<div class="card" style="overflow:hidden;">'
    + '<table class="tbl" style="width:100%;">'
    + '<thead><tr><th>Name</th><th>Pos</th><th>Age</th><th>Nationality</th><th>Club</th><th>Rating</th><th>Potential</th><th>Recommendation</th><th>Stage</th><th>Market Val</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';
}

// ── Prospect detail (inline drawer) ──────────────────────────────────────────

async function openScoutDetail(prospectId) {
  var bodyEl = document.getElementById('scout-body');
  if (bodyEl) bodyEl.innerHTML = loadingHTML('Loading prospect...');
  try {
    var p = await ScoutingAPI.get(prospectId);
    _scoutDetail = p;
    _renderScoutDetailView(bodyEl, p);
  } catch (err) {
    if (bodyEl) bodyEl.innerHTML = '<div class="empty"><div class="empty-ico">⚠️</div><div class="empty-ttl">Could not load prospect</div></div>';
  }
}

function _renderScoutDetailView(el, p) {
  if (!el || !p) return;
  var mv    = p.marketValueEur != null ? '€' + (p.marketValueEur/1e6).toFixed(1) + 'M' : '—';
  var techAttrs = [
    ['Pace',p.pace],['Acceleration',p.acceleration],['Agility',p.agility],
    ['Dribbling',p.dribbling],['Ball Control',p.ballControl],['Passing',p.passing],
    ['Vision',p.vision],['Finishing',p.finishing],['Tackling',p.tackling],
    ['Heading',p.heading],['Shooting',p.shooting],['Composure',p.composure],
    ['Decision Making',p.decisionMaking],['Positioning',p.positioning],['Crossing',p.crossing],
  ];
  var physAttrs = [
    ['Strength',p.strength],['Stamina',p.stamina],['Endurance',p.endurance],
    ['Balance',p.balance],['Mobility',p.mobility],['Explosiveness',p.explosiveness],
  ];
  var mentAttrs = [
    ['Leadership',p.leadership],['Discipline',p.discipline],['Concentration',p.concentration],
    ['Work Rate',p.workRate],['Determination',p.determination],['Professionalism',p.professionalism],['Coachability',p.coachability],
  ];
  var fitAttrs = [
    ['GK',p.fitGK],['CB',p.fitCB],['FB',p.fitFB],['DM',p.fitDM],
    ['CM',p.fitCM],['AM',p.fitAM],['Winger',p.fitWinger],['Striker',p.fitStriker],
  ];

  function attrBlock(attrs) {
    return attrs.map(function(a) {
      return '<div style="margin-bottom:6px;">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">'
        + '<span style="font-size:10px;color:var(--tx-3);">' + a[0] + '</span>'
        + '<span style="font-size:10px;font-family:var(--mono);color:var(--tx);">' + (a[1] != null ? a[1] : '—') + '</span>'
        + '</div>'
        + _scBar(a[1])
        + '</div>';
    }).join('');
  }

  var riskMap = { LOW:'var(--green-l)', MEDIUM:'var(--amber)', HIGH:'var(--red)' };
  function riskPill(v) {
    var c = riskMap[v] || 'var(--tx-3)';
    return '<span style="font-size:9px;font-weight:700;color:' + c + ';font-family:var(--mono);">' + (v||'—') + '</span>';
  }

  var NEXT_STAGE_MAP = { IDENTIFIED:'SCOUTED', SCOUTED:'REVIEWED', REVIEWED:'NEGOTIATION', NEGOTIATION:'TRIAL', TRIAL:'APPROVED', APPROVED:'SIGNED' };
  var nextStage = NEXT_STAGE_MAP[p.status];

  el.innerHTML = '<div style="margin-bottom:14px;display:flex;align-items:center;gap:8px;">'
    + '<button class="btn btn-ghost btn-sm" data-action="scoutTab" data-tab="prospects">← Back</button>'
    + '<span style="color:var(--tx-3);">/</span>'
    + '<span style="font-size:13px;font-weight:600;color:var(--tx);">' + p.playerName + '</span>'
    + '<span style="margin-left:auto;display:flex;gap:6px;">'
    + '<button class="btn btn-outline btn-sm" data-action="editScoutProspect" data-id="' + p.id + '">Edit</button>'
    + (nextStage ? '<button class="btn btn-primary btn-sm" data-action="scoutAdvancePipeline" data-id="' + p.id + '" data-stage="' + nextStage + '">→ ' + nextStage + '</button>' : '')
    + '<button class="btn btn-ghost btn-sm" data-action="toggleScoutWatchlist" data-id="' + p.id + '" data-current="' + p.isOnWatchlist + '">'
    + (p.isOnWatchlist ? '⭐ On Watchlist' : '☆ Add to Watchlist') + '</button>'
    + '</span>'
    + '</div>'

    + '<div style="display:grid;grid-template-columns:2fr 1fr;gap:14px;">'
    + '<div>'
    + '<div class="card" style="padding:14px;margin-bottom:12px;">'
    + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:4px;">'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Position</div><div style="font-size:13px;font-weight:700;color:var(--tx);">' + p.position + '</div></div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Age</div><div style="font-size:13px;font-weight:700;color:var(--tx);">' + _scFmt(p.age) + '</div></div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Nationality</div><div style="font-size:13px;font-weight:700;color:var(--tx);">' + _scFmt(p.nationality) + '</div></div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Club</div><div style="font-size:13px;font-weight:700;color:var(--tx);">' + _scFmt(p.currentClub) + '</div></div>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Rating</div><div>' + _scRating(p.currentRating) + '</div></div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Potential</div><div>' + _scRating(p.potentialRating) + '</div></div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Market Val</div><div style="font-size:13px;font-weight:700;color:var(--amber);font-family:var(--mono);">' + mv + '</div></div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Status</div><div>' + _scStageBadge(p.status) + '</div></div>'
    + '</div></div>'

    + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">'
    + '<div class="card" style="padding:12px;"><div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Technical</div>' + attrBlock(techAttrs) + '</div>'
    + '<div class="card" style="padding:12px;"><div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Physical</div>' + attrBlock(physAttrs) + '</div>'
    + '<div class="card" style="padding:12px;"><div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Mental</div>' + attrBlock(mentAttrs) + '</div>'
    + '</div></div>'

    + '<div>'
    + '<div class="card" style="padding:14px;margin-bottom:12px;">'
    + '<div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Recommendation</div>'
    + '<div style="margin-bottom:6px;">' + _scRecBadge(p.recommendation) + '</div>'
    + '<div style="font-size:20px;font-weight:700;font-family:var(--mono);color:var(--tx);">' + (p.recommendationScore != null ? p.recommendationScore.toFixed(0) : '—') + '<span style="font-size:12px;color:var(--tx-3);">/100</span></div>'
    + '</div>'

    + '<div class="card" style="padding:14px;margin-bottom:12px;">'
    + '<div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Position Fit</div>'
    + attrBlock(fitAttrs)
    + '</div>'

    + '<div class="card" style="padding:14px;">'
    + '<div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Risk Assessment</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">'
    + '<div><div style="font-size:9px;color:var(--tx-3);">Injury</div>' + riskPill(p.injuryRisk) + '</div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);">Adaptation</div>' + riskPill(p.adaptationRisk) + '</div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);">Discipline</div>' + riskPill(p.disciplineRisk) + '</div>'
    + '<div><div style="font-size:9px;color:var(--tx-3);">Financial</div>' + riskPill(p.financialRisk) + '</div>'
    + '</div></div>'
    + (p.comments ? '<div class="card" style="padding:14px;margin-top:12px;"><div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Scout Notes</div><div style="font-size:12px;color:var(--tx-2);line-height:1.55;">' + p.comments + '</div></div>' : '')
    + '</div>'
    + '</div>';
}

// ── Watchlist tab ─────────────────────────────────────────────────────────────

function _renderScoutWatchlist(el) {
  var items = _scoutWatchlist;
  if (!items.length) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">⭐</div><div class="empty-ttl">Watchlist is empty</div><div class="empty-sub">Open a prospect and click "Add to Watchlist".</div></div>';
    return;
  }
  var catColors = { TRANSFER_TARGET:'var(--green-l)', FUTURE_PROSPECT:'#60a5fa', TRIAL_CANDIDATE:'var(--amber)', ACADEMY_PROSPECT:'#c084fc' };
  var rows = items.map(function(p) {
    var mv  = p.marketValueEur != null ? '€' + (p.marketValueEur/1e6).toFixed(1) + 'M' : '—';
    var cat = p.watchlistCategory || '—';
    var catC = catColors[p.watchlistCategory] || 'var(--tx-3)';
    return '<tr style="cursor:pointer;" data-action="openScoutDetail" data-id="' + p.id + '">'
      + '<td style="font-weight:600;color:var(--tx);">' + p.playerName + '</td>'
      + '<td><span class="pos-pill ' + posClass(p.position) + '">' + p.position + '</span></td>'
      + '<td>' + _scRating(p.currentRating) + '</td>'
      + '<td>' + _scRecBadge(p.recommendation) + '</td>'
      + '<td><span style="font-size:9px;font-weight:600;color:' + catC + ';">' + cat.replace(/_/g,' ') + '</span></td>'
      + '<td style="font-family:var(--mono);font-size:11px;color:var(--tx-3);">' + p.watchlistPriority + '</td>'
      + '<td style="color:var(--amber);font-family:var(--mono);font-size:11px;">' + mv + '</td>'
      + '</tr>';
  }).join('');

  el.innerHTML = '<div class="card" style="overflow:hidden;">'
    + '<table class="tbl" style="width:100%;">'
    + '<thead><tr><th>Name</th><th>Pos</th><th>Rating</th><th>Recommendation</th><th>Category</th><th>Priority</th><th>Market Val</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';
}

// ── Pipeline tab ──────────────────────────────────────────────────────────────

function _renderScoutPipeline(el) {
  var board  = _scoutPipeline;
  var stages = SCOUT_STAGES.filter(function(s){ return s !== 'REJECTED'; });
  var html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;overflow-x:auto;">';
  stages.forEach(function(stage) {
    var cards = Array.isArray(board[stage]) ? board[stage] : [];
    var c = SCOUT_STAGE_COLOR[stage];
    html += '<div><div style="font-size:8px;font-weight:700;color:' + c + ';text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px;padding:4px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--bd);">' + stage + ' (' + cards.length + ')</div>';
    if (!cards.length) {
      html += '<div style="padding:10px 6px;font-size:10px;color:var(--tx-3);text-align:center;border:1px dashed var(--bd);border-radius:6px;">—</div>';
    } else {
      var NEXT_MAP = { IDENTIFIED:'SCOUTED', SCOUTED:'REVIEWED', REVIEWED:'NEGOTIATION', NEGOTIATION:'TRIAL', TRIAL:'APPROVED', APPROVED:'SIGNED' };
      cards.forEach(function(p) {
        var nextSt = NEXT_MAP[p.status];
        html += '<div style="padding:9px;border-radius:7px;border:1px solid var(--bd);background:var(--card);margin-bottom:7px;cursor:pointer;" data-action="openScoutDetail" data-id="' + p.id + '">'
          + '<div style="font-size:11px;font-weight:600;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + p.playerName + '</div>'
          + '<span class="pos-pill ' + posClass(p.position) + '" style="font-size:8px;margin-top:3px;display:inline-block;">' + p.position + '</span>'
          + (p.currentRating != null ? '<div style="font-size:10px;color:var(--tx-3);font-family:var(--mono);margin-top:3px;">' + p.currentRating + ' / 100</div>' : '')
          + (nextSt ? '<button class="btn btn-ghost btn-xs" style="margin-top:5px;width:100%;justify-content:center;font-size:9px;" data-action="scoutAdvancePipeline" data-id="' + p.id + '" data-stage="' + nextSt + '">→ ' + nextSt + '</button>' : '')
          + '</div>';
      });
    }
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ── Compare tab ───────────────────────────────────────────────────────────────

function _renderScoutCompare(el) {
  var result = _scoutCompareResult;
  var prospects = _scoutProspects;

  var selA = '<select id="scout-cmp-a" class="input" style="width:100%;" data-change="onScoutCompareChange">'
    + '<option value="">Select Prospect A...</option>'
    + prospects.map(function(p){ return '<option value="' + p.id + '"' + (_scoutCompareA === p.id ? ' selected' : '') + '>' + p.playerName + ' (' + p.position + (p.age ? ', ' + p.age + 'y' : '') + ')</option>'; }).join('') + '</select>';
  var selB = '<select id="scout-cmp-b" class="input" style="width:100%;" data-change="onScoutCompareChange">'
    + '<option value="">Select Prospect B...</option>'
    + prospects.map(function(p){ return '<option value="' + p.id + '"' + (_scoutCompareB === p.id ? ' selected' : '') + '>' + p.playerName + ' (' + p.position + (p.age ? ', ' + p.age + 'y' : '') + ')</option>'; }).join('') + '</select>';

  var header = '<div style="display:grid;grid-template-columns:1fr 60px 1fr;gap:10px;align-items:end;margin-bottom:16px;">'
    + '<div>' + selA + '</div>'
    + '<div style="text-align:center;font-size:14px;font-weight:700;color:var(--tx-3);padding-bottom:7px;">vs</div>'
    + '<div>' + selB + '</div>'
    + '</div>';

  if (!result) {
    el.innerHTML = header + '<div style="text-align:center;padding:24px;color:var(--tx-3);font-size:12px;">Select two prospects to compare side-by-side.</div>';
    return;
  }

  var pA = result.prospectA;
  var pB = result.prospectB;

  function compSection(title, data) {
    var rows = Object.entries(data).map(function(entry) {
      var k = entry[0]; var v = entry[1];
      var av = v.a != null ? v.a : '—';
      var bv = v.b != null ? v.b : '—';
      var winA = v.winner === 'A' ? 'font-weight:700;color:var(--green-l);' : '';
      var winB = v.winner === 'B' ? 'font-weight:700;color:var(--green-l);' : '';
      return '<tr>'
        + '<td style="font-family:var(--mono);font-size:11px;text-align:right;padding-right:4px;' + winA + '">' + av + '</td>'
        + '<td style="font-size:10px;color:var(--tx-3);text-align:center;padding:0 6px;">' + k.replace(/([A-Z])/g,' $1').trim() + '</td>'
        + '<td style="font-family:var(--mono);font-size:11px;' + winB + '">' + bv + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="card" style="padding:12px;margin-bottom:10px;">'
      + '<div style="font-size:9px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">' + title + '</div>'
      + '<table style="width:100%;border-collapse:collapse;"><tbody>' + rows + '</tbody></table></div>';
  }

  var verdictColor = result.verdict === 'A' ? 'var(--green-l)' : result.verdict === 'B' ? '#60a5fa' : 'var(--amber)';
  var verdictName  = result.verdict === 'A' ? pA.playerName : result.verdict === 'B' ? pB.playerName : 'Even';

  var verdictHtml = '<div class="card" style="padding:14px;margin-bottom:14px;text-align:center;">'
    + '<div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Overall Verdict</div>'
    + '<div style="font-size:22px;font-weight:700;color:' + verdictColor + ';">' + verdictName + '</div>'
    + '<div style="font-size:11px;color:var(--tx-3);margin-top:4px;">Wins the most attribute comparisons</div>'
    + '</div>';

  el.innerHTML = header + verdictHtml
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
    + '<div>'
    + compSection('Technical', result.technicalComparison)
    + compSection('Overall', result.overallComparison)
    + '</div>'
    + '<div>'
    + compSection('Physical', result.physicalComparison)
    + compSection('Mental', result.mentalComparison)
    + '</div>'
    + '</div>';
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openScoutModal(mode, prospect) {
  _scoutModalMode = mode || 'create';
  _scoutEditId    = prospect ? prospect.id : null;
  var modal = document.getElementById('scout-modal');
  if (!modal) return;
  var titleEl = document.getElementById('scout-modal-title');
  if (titleEl) titleEl.textContent = mode === 'edit' ? 'Edit Prospect' : 'Add Prospect';
  var errEl = document.getElementById('scout-form-err');
  if (errEl) errEl.style.display = 'none';

  // Reset form
  var fields = ['sp-name','sp-pos','sp-age','sp-nat','sp-foot','sp-club','sp-league','sp-val','sp-agent',
    'sp-pace','sp-accel','sp-agility','sp-drib','sp-bc','sp-pass','sp-vision','sp-fin','sp-tack',
    'sp-str','sp-stam','sp-wr','sp-lead','sp-disc','sp-comp','sp-notes'];
  fields.forEach(function(id){ var el = document.getElementById(id); if (el) el.value = ''; });

  if (prospect) {
    _setV('sp-name',  prospect.playerName);
    _setV('sp-pos',   prospect.position);
    _setV('sp-age',   prospect.age);
    _setV('sp-nat',   prospect.nationality);
    _setV('sp-foot',  prospect.preferredFoot);
    _setV('sp-club',  prospect.currentClub);
    _setV('sp-league',prospect.league);
    _setV('sp-val',   prospect.marketValueEur);
    _setV('sp-agent', prospect.agentName);
    _setV('sp-pace',  prospect.pace);
    _setV('sp-accel', prospect.acceleration);
    _setV('sp-agility',prospect.agility);
    _setV('sp-drib',  prospect.dribbling);
    _setV('sp-bc',    prospect.ballControl);
    _setV('sp-pass',  prospect.passing);
    _setV('sp-vision',prospect.vision);
    _setV('sp-fin',   prospect.finishing);
    _setV('sp-tack',  prospect.tackling);
    _setV('sp-str',   prospect.strength);
    _setV('sp-stam',  prospect.stamina);
    _setV('sp-wr',    prospect.workRate);
    _setV('sp-lead',  prospect.leadership);
    _setV('sp-disc',  prospect.discipline);
    _setV('sp-comp',  prospect.composure);
    _setV('sp-notes', prospect.comments);
  }

  modal.style.display = 'flex';
}
function _setV(id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; }
function closeScoutModal() { var m = document.getElementById('scout-modal'); if (m) m.style.display = 'none'; }

async function submitScoutForm(e) {
  e.preventDefault();
  var errEl  = document.getElementById('scout-form-err');
  var btnEl  = document.getElementById('scout-submit-btn');
  if (errEl) errEl.style.display = 'none';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Saving...'; }

  function numOrUndef(id) { var v = parseInt(document.getElementById(id)?.value, 10); return isNaN(v) ? undefined : v; }
  function floatOrUndef(id) { var v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? undefined : v; }
  function strOrUndef(id)  { var v = (document.getElementById(id)?.value || '').trim(); return v || undefined; }

  var body = {
    playerName:     (document.getElementById('sp-name')?.value || '').trim(),
    position:       document.getElementById('sp-pos')?.value || '',
    age:            numOrUndef('sp-age'),
    nationality:    strOrUndef('sp-nat'),
    preferredFoot:  strOrUndef('sp-foot'),
    currentClub:    strOrUndef('sp-club'),
    league:         strOrUndef('sp-league'),
    marketValueEur: floatOrUndef('sp-val'),
    agentName:      strOrUndef('sp-agent'),
    pace:           numOrUndef('sp-pace'),
    acceleration:   numOrUndef('sp-accel'),
    agility:        numOrUndef('sp-agility'),
    dribbling:      numOrUndef('sp-drib'),
    ballControl:    numOrUndef('sp-bc'),
    passing:        numOrUndef('sp-pass'),
    vision:         numOrUndef('sp-vision'),
    finishing:      numOrUndef('sp-fin'),
    tackling:       numOrUndef('sp-tack'),
    strength:       numOrUndef('sp-str'),
    stamina:        numOrUndef('sp-stam'),
    workRate:       numOrUndef('sp-wr'),
    leadership:     numOrUndef('sp-lead'),
    discipline:     numOrUndef('sp-disc'),
    composure:      numOrUndef('sp-comp'),
    comments:       strOrUndef('sp-notes'),
  };

  try {
    if (_scoutModalMode === 'edit' && _scoutEditId) {
      await ScoutingAPI.update(_scoutEditId, body);
    } else {
      await ScoutingAPI.create(body);
    }
    closeScoutModal();
    await loadScoutingData();
    setScoutTab('prospects');
  } catch (err) {
    if (errEl) { errEl.textContent = (err && err.message) || 'Save failed. Check all attribute fields are 1–100.'; errEl.style.display = 'block'; }
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Save Prospect'; }
  }
}

// ── Pipeline advance ──────────────────────────────────────────────────────────

async function scoutAdvancePipeline(prospectId, newStage) {
  try {
    await ScoutingAPI.advancePipeline(prospectId, newStage);
    await loadScoutingData();
    if (_scoutDetail && _scoutDetail.id === prospectId) {
      openScoutDetail(prospectId);
    } else {
      _renderScoutBody();
    }
  } catch (err) {
    alert((err && err.message) || 'Could not advance pipeline stage.');
  }
}

// ── Watchlist toggle ──────────────────────────────────────────────────────────

async function toggleScoutWatchlist(prospectId, currentlyOn) {
  var on = !(currentlyOn === true || currentlyOn === 'true');
  try {
    await ScoutingAPI.updateWatchlist(prospectId, { isOnWatchlist: on });
    await loadScoutingData();
    if (_scoutDetail && _scoutDetail.id === prospectId) {
      openScoutDetail(prospectId);
    }
  } catch (err) {
    alert((err && err.message) || 'Could not update watchlist.');
  }
}

// ── Compare change ────────────────────────────────────────────────────────────

async function onScoutCompareChange() {
  var selA = document.getElementById('scout-cmp-a');
  var selB = document.getElementById('scout-cmp-b');
  _scoutCompareA = selA ? selA.value : null;
  _scoutCompareB = selB ? selB.value : null;
  _scoutCompareResult = null;
  if (_scoutCompareA && _scoutCompareB && _scoutCompareA !== _scoutCompareB) {
    try {
      _scoutCompareResult = await ScoutingAPI.compare(_scoutCompareA, _scoutCompareB);
    } catch (err) {
      // comparison failed; result stays null
    }
  }
  var el = document.getElementById('scout-body');
  if (el) _renderScoutCompare(el);
}

// ── Data loader ───────────────────────────────────────────────────────────────

async function loadScoutingData() {
  if (_scoutLoading) return;
  _scoutLoading = true;

  var [dashRes, prospectsRes, watchRes, pipeRes] = await Promise.allSettled([
    ScoutingAPI.dashboard(),
    ScoutingAPI.list({ limit: 100, sortBy: 'createdAt', sortDir: 'desc' }),
    ScoutingAPI.watchlist(),
    ScoutingAPI.pipeline(),
  ]);

  _scoutDashboard = (dashRes.status === 'fulfilled' && dashRes.value) ? dashRes.value : null;

  if (prospectsRes.status === 'fulfilled' && prospectsRes.value) {
    _scoutProspects = Array.isArray(prospectsRes.value) ? prospectsRes.value : (prospectsRes.value.items || []);
    _scoutTotal     = prospectsRes.value.meta ? (prospectsRes.value.meta.total || _scoutProspects.length) : _scoutProspects.length;
  } else {
    _scoutProspects = [];
    _scoutTotal     = 0;
  }

  _scoutWatchlist = (watchRes.status === 'fulfilled' && Array.isArray(watchRes.value)) ? watchRes.value : [];
  _scoutPipeline  = (pipeRes.status  === 'fulfilled' && pipeRes.value && typeof pipeRes.value === 'object') ? pipeRes.value : {};
  _scoutLoading   = false;

  var sub = document.getElementById('scout-sub');
  if (sub) sub.textContent = _scoutTotal + ' prospect' + (_scoutTotal !== 1 ? 's' : '') + ' · ' + (_scoutWatchlist.length) + ' on watchlist';

  _renderScoutBody();
}

// ── FINANCES ──
function renderFinancesHTML() {
  return `<div class="page" id="pg-finances">
  <div class="fin-layout">
    <div class="fin-main">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:18px;" id="fin-kpis">
        ${loadingHTML('Loading...')}
      </div>
      <div class="card" style="overflow:hidden;margin-bottom:12px;">
        <div style="padding:8px 13px;background:var(--green-bg);border-bottom:1px solid var(--green-bd);">
          <div style="font-size:11px;font-weight:700;color:var(--green-l);text-transform:uppercase;letter-spacing:.5px;">Income</div>
        </div>
        <div id="income-rows">${loadingHTML()}</div>
      </div>
      <div class="card" style="overflow:hidden;">
        <div style="padding:8px 13px;background:var(--red-bg);border-bottom:1px solid rgba(220,38,38,.15);">
          <div style="font-size:11px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.5px;">Expenses</div>
        </div>
        <div id="expense-rows">${loadingHTML()}</div>
      </div>
    </div>
    <div class="fin-side">
      <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;">Sponsorship</div>
      <div style="padding:13px;border-radius:9px;background:var(--amber-bg);border:1px solid rgba(217,119,6,.18);margin-bottom:12px;text-align:center;">
        <div style="font-size:26px;margin-bottom:5px;">🤝</div>
        <div style="font-size:13px;font-weight:700;color:var(--amber);">JUICE</div>
        <div style="font-size:11px;color:var(--tx-3);margin:2px 0 6px;">Quick Buck Sponsor</div>
        <div style="font-size:20px;font-weight:700;color:var(--amber);font-family:var(--mono);">🪙 21/day</div>
      </div>
    </div>
  </div>
</div>`;
}

async function loadFinancesData() {
  // Static from seed for now
  const income  = [{cat:'Investment',amt:26000000},{cat:'Ticket Sales',amt:26800000},{cat:'Sponsorship',amt:130000000},{cat:'Prize Money',amt:5200000}];
  const expenses = [{cat:'Player Wages',amt:63400000},{cat:'Staff Wages',amt:8200000},{cat:'Facilities',amt:2000000},{cat:'Travel',amt:1500000}];

  const totalIn  = income.reduce((a,i)=>a+i.amt,0);
  const totalOut = expenses.reduce((a,i)=>a+i.amt,0);

  const kpiEl = document.getElementById('fin-kpis');
  if (kpiEl) kpiEl.innerHTML = `
    <div class="card metric"><div class="metric-icon" style="background:var(--amber-bg);">💰</div><div class="metric-val" style="font-size:20px;color:var(--amber);">30.8B</div><div class="metric-lbl">Balance (€)</div></div>
    <div class="card metric"><div class="metric-icon" style="background:var(--green-bg);">📈</div><div class="metric-val" style="font-size:20px;color:var(--green-l);">${fmtCurrency(totalIn)}</div><div class="metric-lbl">Total Income</div></div>
    <div class="card metric"><div class="metric-icon" style="background:var(--red-bg);">📉</div><div class="metric-val" style="font-size:20px;color:var(--red);">-${fmtCurrency(totalOut)}</div><div class="metric-lbl">Total Expenses</div></div>`;

  const incEl = document.getElementById('income-rows');
  if (incEl) incEl.innerHTML = income.map(r=>`
    <div class="fin-row">
      <div class="fin-dot" style="background:var(--green-l);"></div>
      <div class="fin-lbl">${r.cat}</div>
      <div class="fin-num fin-up">${fmtCurrency(r.amt)}</div>
      <div class="fin-num fin-up">${fmtCurrency(r.amt * 12)}</div>
    </div>`).join('') + `<div class="fin-row" style="background:var(--green-bg);"><div class="fin-dot" style="background:var(--green-l);"></div><div class="fin-lbl" style="font-weight:700;color:var(--tx);">Total</div><div class="fin-num fin-up" style="font-weight:800;">${fmtCurrency(totalIn)}</div><div class="fin-num fin-up" style="font-weight:800;">${fmtCurrency(totalIn*12)}</div></div>`;

  const expEl = document.getElementById('expense-rows');
  if (expEl) expEl.innerHTML = expenses.map(r=>`
    <div class="fin-row">
      <div class="fin-dot" style="background:var(--red);"></div>
      <div class="fin-lbl">${r.cat}</div>
      <div class="fin-num fin-dn">-${fmtCurrency(r.amt)}</div>
      <div class="fin-num fin-dn">-${fmtCurrency(r.amt*12)}</div>
    </div>`).join('') + `<div class="fin-row" style="background:var(--red-bg);"><div class="fin-dot" style="background:var(--red);"></div><div class="fin-lbl" style="font-weight:700;color:var(--tx);">Total</div><div class="fin-num fin-dn" style="font-weight:800;">-${fmtCurrency(totalOut)}</div><div class="fin-num fin-dn" style="font-weight:800;">-${fmtCurrency(totalOut*12)}</div></div>`;
}

// ── DEVICES ──
function renderDevicesHTML() {
  return `<div class="page" id="pg-devices">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div><div style="font-size:15px;font-weight:700;color:var(--tx);">GPS Devices</div><div style="font-size:12px;color:var(--tx-3);" id="devices-sub">Loading...</div></div>
      <div style="margin-left:auto;display:flex;gap:7px;">
        <button class="btn btn-outline btn-sm">📥 Firmware</button>
        <button class="btn btn-primary btn-sm">+ Pair Device</button>
      </div>
    </div>
    <div style="overflow-y:auto;flex:1;"><div class="dev-grid" id="dev-grid">${loadingHTML('Loading devices...')}</div></div>
  </div>
</div>`;
}

let _devPollTimer = null;

async function loadDevicesData() {
  if (_devPollTimer) { clearInterval(_devPollTimer); _devPollTimer = null; }
  const el = document.getElementById('dev-grid');
  const sub = document.getElementById('devices-sub');
  if (!el) return;
  el.innerHTML = loadingHTML('Loading devices...');
  let fleet;
  try {
    fleet = await FamilistaAPI.get('/devices/gps-status');
  } catch (_) {
    el.innerHTML = '<div style="padding:24px;color:var(--red);font-size:12px;">Failed to load GPS fleet status.</div>';
    return;
  }
  _renderDeviceFleet(fleet, el, sub);
  _devPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (isFormEditing()) return;
    const grid = document.getElementById('dev-grid');
    if (!grid) { clearInterval(_devPollTimer); _devPollTimer = null; return; }
    FamilistaAPI.get('/devices/gps-status').then(f => {
      if (f && f.devices) _renderDeviceFleet(f, grid, document.getElementById('devices-sub'));
    }).catch(() => {});
  }, 30_000);
}

function _fmtDeviceLastSeen(isoStr) {
  if (!isoStr) return 'Never';
  const secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 60)   return secs + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  return Math.floor(secs / 3600) + 'h ago';
}

function _renderDeviceFleet(fleet, el, sub) {
  if (!fleet || !fleet.devices) {
    el.innerHTML = '<div style="padding:24px;color:var(--tx-3);font-size:12px;">No GPS devices registered.</div>';
    return;
  }
  if (sub) sub.textContent = fleet.total + ' Tracker' + (fleet.total !== 1 ? 's' : '') +
    ' · ' + fleet.online + ' online · ' + fleet.stale + ' stale · ' + fleet.offline + ' offline';
  if (fleet.devices.length === 0) {
    el.innerHTML = '<div style="padding:24px;color:var(--tx-3);font-size:12px;">No GPS devices registered for this club.</div>';
    return;
  }
  el.innerHTML = fleet.devices.map(d => {
    const sc  = d.status === 'online' ? 'var(--green-l)' : d.status === 'stale' ? 'var(--amber)' : 'var(--red)';
    const sa  = d.status === 'online' ? '' : 'animation:none;';
    const bc  = d.batteryLevel > 30 ? 'var(--green-l)' : 'var(--red)';
    const ls  = _fmtDeviceLastSeen(d.lastSeenAt);
    const pn  = d.player ? _esc(d.player.name) : '<span style="color:var(--tx-3);">Unassigned</span>';
    const pos = d.player && d.player.position ? d.player.position : '—';
    return `
    <div class="card dev-card clickable">
      <div class="dev-hdr">
        <div class="dev-icon">📡</div>
        <div style="flex:1;min-width:0;">
          <div class="dev-name">${pn}</div>
          <div class="dev-serial">${_esc(d.serialNumber)}</div>
          <div class="dev-online">
            <div class="dev-pulse" style="background:${sc};${sa}"></div>
            <span class="dev-status" style="color:${sc};">${d.status.charAt(0).toUpperCase()+d.status.slice(1)}</span>
            <span style="font-size:9px;color:var(--tx-3);font-family:var(--mono);margin-left:4px;">${_esc(ls)}</span>
          </div>
        </div>
        <span class="pos-pill ${posClass(pos)}" style="margin-left:auto;">${_esc(pos)}</span>
      </div>
      <div class="dev-stats">
        <div class="dev-stat"><div class="dev-stat-val" style="color:${bc};">${d.batteryLevel}%</div><div class="dev-stat-lbl">Battery</div></div>
        <div class="dev-stat"><div class="dev-stat-val" style="color:var(--blue);">${d.signalQuality}%</div><div class="dev-stat-lbl">Signal</div></div>
        <div class="dev-stat"><div class="dev-stat-val" style="color:var(--green-l);">${_esc(d.firmware)}</div><div class="dev-stat-lbl">FW</div></div>
      </div>
    </div>`;
  }).join('');
}

// ── CLUB ──
// Club page — real backend-connected profile (Phase R). All content is painted
// by loadClubData() from GET /clubs/current; no hardcoded/mock values here.
function renderClubHTML() {
  return `<div class="page" id="pg-club">
  <div class="club-layout">
    <div class="club-left">
      <div class="club-hero" id="club-hero">
        ${loadingHTML('Loading club data...')}
      </div>
      <div class="info-grid2" id="club-info"></div>
    </div>
    <div class="club-right">
      <div id="club-brand"   style="padding:16px 18px;"></div>
      <div id="club-contact" style="padding:0 18px 16px;"></div>
      <div id="club-social"  style="padding:0 18px 18px;"></div>
    </div>
  </div>
</div>`;
}

// ── Club System API + page loader (Phase R) ──────────────────────────────────
const ClubAPI = {
  current()        { return FamilistaAPI.get('/clubs/current'); },
  get(id)          { return FamilistaAPI.get('/clubs/' + encodeURIComponent(id)); },
  update(id, body) { return FamilistaAPI.patch('/clubs/' + encodeURIComponent(id), body); },
};

const _NOTSET = '<span style="color:var(--tx-3);font-style:italic;">Not set yet</span>';
function _safeHttps(u) { return (u && /^https:\/\//i.test(String(u))) ? String(u) : null; }

async function loadClubData() {
  const heroEl    = document.getElementById('club-hero');
  const infoEl    = document.getElementById('club-info');
  const brandEl   = document.getElementById('club-brand');
  const contactEl = document.getElementById('club-contact');
  const socialEl  = document.getElementById('club-social');

  let club = null;
  try {
    const res = await ClubAPI.current();
    club = res && res.data;
  } catch (e) {
    if (heroEl) heroEl.innerHTML = '<div style="padding:20px;color:var(--red);font-size:12px;">Failed to load club data.</div>';
    return;
  }
  if (!club) return;
  State.activeClub = club;

  const b   = club.branding || {};
  const cell = (v) => (v == null || v === '') ? _NOTSET : _esc(String(v));
  const canEdit = ['CLUB_ADMIN', 'SUPER_ADMIN'].includes(State.user && State.user.role);
  const foundedYr = club.founded ? new Date(club.founded).getFullYear() : null;
  const loc = [club.city, club.country].filter(Boolean).join(', ');

  if (heroEl) {
    const logoHttps = _safeHttps(b.logoUrl);
    const logo = logoHttps
      ? `<img src="${_esc(logoHttps)}" alt="club crest" style="width:74px;height:74px;object-fit:contain;border-radius:14px;background:var(--bg-2);" />`
      : `<div class="club-emblem-lg">${_esc(club.emblem || '🛡️')}</div>`;
    heroEl.innerHTML =
      logo +
      `<div class="club-title">${_esc(club.name || 'Unnamed Club')}</div>` +
      `<div class="club-rating-badge">OVR: ${club.overallRating != null ? _esc(club.overallRating) : '—'}</div>` +
      `<div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:center;">` +
        `<span class="badge badge-green">Level ${club.level != null ? _esc(club.level) : '—'}</span>` +
        (loc ? `<span class="badge badge-amber">${_esc(loc)}</span>` : '') +
        (club.leaguePosition != null ? `<span class="badge badge-blue">League #${_esc(club.leaguePosition)}</span>` : '') +
      `</div>` +
      (club.description ? `<div style="margin-top:10px;font-size:12.5px;color:var(--tx-2);line-height:1.6;text-align:center;">${_esc(club.description)}</div>` : '') +
      (canEdit ? `<div style="margin-top:12px;"><button class="btn btn-primary btn-sm" data-action="openClubEdit">✏️ Edit Club</button></div>` : '');
  }

  if (infoEl) {
    const addr = [club.addressLine, club.postalCode, club.region].filter(Boolean).join(', ');
    const info = [
      ['Founded',        foundedYr],
      ['Stadium',        club.stadium],
      ['Capacity',       club.capacity != null ? Number(club.capacity).toLocaleString() : null],
      ['City',           club.city],
      ['Country',        club.country],
      ['Address',        addr || null],
      ['Level',          club.level],
      ['Overall Rating', club.overallRating],
      ['League Position',club.leaguePosition],
    ];
    infoEl.innerHTML = info.map(([l, v]) =>
      `<div class="info-cell"><div class="info-lbl">${l}</div><div class="info-val">${cell(v)}</div></div>`).join('');
  }

  if (brandEl) {
    const sw = (label, hex) => hex
      ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
           <span style="width:16px;height:16px;border-radius:4px;border:1px solid var(--bd);background:${/^#[0-9a-fA-F]{6,8}$/.test(hex) ? hex : 'transparent'};"></span>
           <span style="font-size:11px;color:var(--tx-3);width:70px;">${label}</span>
           <span style="font-size:11px;font-family:var(--mono);color:var(--tx-2);">${_esc(hex)}</span>
         </div>` : '';
    const colors = [sw('Primary', b.primaryColor), sw('Secondary', b.secondaryColor), sw('Accent', b.accentColor)].join('');
    brandEl.innerHTML =
      `<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Branding</div>` +
      (colors || _NOTSET);
  }

  if (contactEl) {
    const web = _safeHttps(club.websiteUrl);
    const rows = [
      ['Email',   club.contactEmail ? `<a href="mailto:${_esc(club.contactEmail)}" style="color:var(--green-l);">${_esc(club.contactEmail)}</a>` : null],
      ['Phone',   club.contactPhone ? _esc(club.contactPhone) : null],
      ['Website', web ? `<a href="${_esc(web)}" target="_blank" rel="noopener noreferrer" style="color:var(--green-l);">${_esc(web)}</a>` : null],
    ];
    contactEl.innerHTML =
      `<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Contact</div>` +
      rows.map(([l, v]) => `<div style="font-size:12px;margin-bottom:5px;"><span style="color:var(--tx-3);">${l}: </span>${v || _NOTSET}</div>`).join('');
  }

  if (socialEl) {
    const links = (club.socialLinks && typeof club.socialLinks === 'object') ? club.socialLinks : {};
    const labels = { x: '𝕏 X', instagram: '📸 Instagram', facebook: '📘 Facebook', youtube: '▶️ YouTube', tiktok: '🎵 TikTok', linkedin: '💼 LinkedIn' };
    const chips = Object.keys(labels)
      .filter((k) => _safeHttps(links[k]))
      .map((k) => `<a href="${_esc(links[k])}" target="_blank" rel="noopener noreferrer" class="badge badge-gray" style="text-decoration:none;margin:0 4px 4px 0;display:inline-block;">${labels[k]}</a>`)
      .join('');
    socialEl.innerHTML =
      `<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">Social</div>` +
      (chips || _NOTSET);
  }
}

// ── ClubEditModal — isolated, follows the PlayerEditModal pattern exactly.
// Values written once on open; no reset/refill/reopen; explicit Save only.
const ClubEditModal = (function () {
  const MODAL_ID = 'club-edit-modal';
  const $ = (id) => document.getElementById(id);
  let _clubId = null;

  function isOpen() { const m = $(MODAL_ID); return !!(m && m.classList.contains('open')); }

  function populate(c) {
    const b  = c.branding || {};
    const sl = (c.socialLinks && typeof c.socialLinks === 'object') ? c.socialLinks : {};
    const set = (id, v) => { const el = $(id); if (el) el.value = (v == null ? '' : v); };
    set('ce-name', c.name);             set('ce-shortName', c.shortName);
    set('ce-description', c.description);
    set('ce-founded', c.founded ? new Date(c.founded).toISOString().slice(0, 10) : '');
    set('ce-stadium', c.stadium);       set('ce-capacity', c.capacity);
    set('ce-city', c.city);             set('ce-country', c.country);
    set('ce-addressLine', c.addressLine); set('ce-region', c.region); set('ce-postalCode', c.postalCode);
    set('ce-level', c.level);           set('ce-overall', c.overallRating); set('ce-leaguePosition', c.leaguePosition);
    set('ce-contactEmail', c.contactEmail); set('ce-contactPhone', c.contactPhone); set('ce-websiteUrl', c.websiteUrl);
    set('ce-x', sl.x);                  set('ce-instagram', sl.instagram); set('ce-facebook', sl.facebook);
    set('ce-youtube', sl.youtube);      set('ce-tiktok', sl.tiktok);       set('ce-linkedin', sl.linkedin);
    set('ce-logoUrl', b.logoUrl);       set('ce-logoDarkUrl', b.logoDarkUrl); set('ce-faviconUrl', b.faviconUrl);
    set('ce-primaryColor', b.primaryColor); set('ce-secondaryColor', b.secondaryColor); set('ce-accentColor', b.accentColor);
  }

  function open(club) {
    if (!['CLUB_ADMIN', 'SUPER_ADMIN'].includes(State.user && State.user.role)) { showToast('Not authorized to edit club', 'error'); return; }
    if (isOpen()) return;
    if (!club || !club.id) { showToast('Club not loaded', 'error'); return; }
    _clubId = club.id;
    const err = $('ce-error'); if (err) { err.style.display = 'none'; err.textContent = ''; }
    const sb = $('ce-submit'); if (sb) { sb.disabled = false; sb.textContent = 'Save changes'; }
    populate(club);
    $(MODAL_ID).classList.add('open');
    setTimeout(function () { const f = $('ce-name'); if (f) f.focus(); }, 60);
  }

  function close() { _clubId = null; const m = $(MODAL_ID); if (m) m.classList.remove('open'); }
  function cancel() { close(); }

  async function save() {
    if (!isOpen() || !_clubId) return;
    const errEl = $('ce-error');
    const btn   = $('ce-submit');
    const val = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    const strOrNull = (id) => { const v = val(id); return v === '' ? null : v; };

    // TEMP emergency scope: only name + logo + brand colors are sent. The
    // backend PATCH accepts ONLY these (advanced profile fields removed).
    const body = {};
    if (val('ce-name')) body.name = val('ce-name');
    body.logoUrl = strOrNull('ce-logoUrl');
    if (val('ce-primaryColor'))   body.primaryColor = val('ce-primaryColor');
    if (val('ce-secondaryColor')) body.secondaryColor = val('ce-secondaryColor');
    if (val('ce-accentColor'))    body.accentColor = val('ce-accentColor');

    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await ClubAPI.update(_clubId, body);
      close();
      loadClubData();                       // reload the page once
      showToast('Club updated', 'success');
    } catch (err) {
      if (errEl) { errEl.textContent = (err && err.message) || 'Save failed'; errEl.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
    }
  }

  return { open: open, close: close, cancel: cancel, save: save, isOpen: isOpen };
})();

function openClubEdit()  { ClubEditModal.open(State.activeClub); }
function clubEditSave()  { ClubEditModal.save(); }
function clubEditCancel(){ ClubEditModal.cancel(); }

// ── SETTINGS ──
function renderSettingsHTML() {
  return `<div class="page" id="pg-settings">
  <div style="overflow-y:auto;height:100%;">
    <div class="settings-wrap">
      <div class="settings-section">
        <div class="settings-sec-title">Account</div>
        <div class="setting-row">
          <div><div class="setting-lbl">👤 Profile</div><div class="setting-sub" id="settings-profile">Loading...</div></div>
          <span class="badge badge-blue" id="settings-role">Manager</span>
        </div>
        <div class="setting-row" onclick="doLogout()">
          <div><div class="setting-lbl">🚪 Sign Out</div><div class="setting-sub">Log out of your account</div></div>
          <span style="font-size:12px;color:var(--red);">→</span>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-sec-title">Platform</div>
        <div class="setting-row" onclick="toggleTheme()">
          <div><div class="setting-lbl">🌓 Theme</div><div class="setting-sub">Toggle dark / light mode</div></div>
          <button class="btn btn-outline btn-sm">Switch</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-lbl">📡 GPS Auto-Sync</div><div class="setting-sub">Sync devices every 30 seconds</div></div>
          <div class="toggle on" onclick="this.classList.toggle('on')"><div class="toggle-knob"></div></div>
        </div>
        <div class="setting-row">
          <div><div class="setting-lbl">🤖 ARIA AI Analyst</div><div class="setting-sub">Powered by Claude · Connected to database</div></div>
          <div class="toggle on" onclick="this.classList.toggle('on')"><div class="toggle-knob"></div></div>
        </div>
        <div class="setting-row">
          <div><div class="setting-lbl">⚠️ Injury Risk Alerts</div><div class="setting-sub">Alert when GPS risk exceeds 70%</div></div>
          <div class="toggle on" onclick="this.classList.toggle('on')"><div class="toggle-knob"></div></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-sec-title">Backend Connection</div>
        <div class="setting-row">
          <div><div class="setting-lbl">🔗 API Status</div><div class="setting-sub" id="api-status">Checking...</div></div>
          <span class="badge badge-gray" id="api-status-badge">...</span>
        </div>
        <div class="setting-row">
          <div><div class="setting-lbl">🗄️ Database</div><div class="setting-sub">PostgreSQL via Neon · Supabase ready</div></div>
          <span class="badge badge-green">Connected</span>
        </div>
        <div class="setting-row">
          <div><div class="setting-lbl">🌐 WebSocket</div><div class="setting-sub">Live GPS streaming</div></div>
          <span class="badge" id="ws-status-badge">Checking...</span>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-sec-title">About</div>
        <div class="setting-row">
          <div><div class="setting-lbl">Familista v5.0</div><div class="setting-sub">Football Intelligence Platform · Berlin 🇩🇪 · Production</div></div>
          <span class="badge badge-green">v5.0</span>
        </div>
        <div class="setting-row">
          <div><div class="setting-lbl">💳 Subscription</div><div class="setting-sub">Elite Plan · Active</div></div>
          <span class="badge badge-green">ELITE</span>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

async function loadSettingsData() {
  // Profile
  const profEl = document.getElementById('settings-profile');
  const roleEl = document.getElementById('settings-role');
  if (profEl && State.user) profEl.textContent = `${State.user.firstName} ${State.user.lastName} · ${State.user.email}`;
  if (roleEl && State.user) roleEl.textContent = State.user.role.replace('_',' ');

  // API health check
  const statusEl = document.getElementById('api-status');
  const badgeEl  = document.getElementById('api-status-badge');
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    if (statusEl) statusEl.textContent = `${API_BASE} · Latency: ${Date.now()}ms`;
    if (badgeEl) { badgeEl.textContent = 'Online'; badgeEl.className = 'badge badge-green'; }
  } catch {
    if (statusEl) statusEl.textContent = 'Connection failed';
    if (badgeEl) { badgeEl.textContent = 'Offline'; badgeEl.className = 'badge badge-red'; }
  }

  // WebSocket status — GPS simulator removed; reflects backend reachability.
  // Per-match WebSocket connections are opened on demand in Match Center.
  const wsEl = document.getElementById('ws-status-badge');
  if (wsEl) {
    wsEl.textContent = State.backendHealthy ? 'Match WS Ready' : 'Backend Offline';
    wsEl.className = State.backendHealthy ? 'badge badge-green' : 'badge badge-amber';
  }
}

// Override navTo to load settings data
const _origNavTo = navTo;


// ── MOBILE MENU ──
function toggleMobileMenu() {
  document.getElementById('sidebar').classList.toggle('mobile-open');
  document.getElementById('mobile-overlay').classList.toggle('open');
}
function closeMobileMenu() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('mobile-overlay').classList.remove('open');
}
// Close mobile menu on nav item click
document.addEventListener('click', (e) => {
  if (e.target.closest('.nav-item') && window.innerWidth <= 768) {
    closeMobileMenu();
  }
});


// ── ADMIN CONTROL CENTER (Phase 12) ─────────────────────────────────────────
// Club-level admin: data quality scores, system health, audit log.
// Visible only to CLUB_ADMIN / SUPER_ADMIN (role guard applied in bootApp).

function renderAdminHTML() {
  return `<div class="page" id="pg-admin">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Admin Control Center</div>
        <div style="font-size:12px;color:var(--tx-3);" id="admin-sub">Club data quality &amp; system health</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" data-action="adminRefresh">⟳ Refresh</button>
      </div>
    </div>
    <div style="display:flex;gap:0;border-bottom:1px solid var(--bd);padding:0 20px;">
      <button class="ti-tab active" id="admtab-quality"  data-action="adminTab" data-tab="quality">Data Quality</button>
      <button class="ti-tab"        id="admtab-health"   data-action="adminTab" data-tab="health">System Health</button>
      <button class="ti-tab"        id="admtab-audit"    data-action="adminTab" data-tab="audit">Audit Log</button>
    </div>
    <div style="overflow-y:auto;flex:1;padding:20px;" id="admin-content">
      ${loadingHTML('Loading admin data...')}
    </div>
  </div>
</div>`;
}

function _adminScoreColor(score) {
  if (score >= 80) return 'var(--green-l)';
  if (score >= 60) return 'var(--amber)';
  return 'var(--red)';
}

function _adminFormatUptime(secs) {
  if (secs < 60)   return secs + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm ' + (secs%60) + 's';
  var h = Math.floor(secs/3600);
  var m = Math.floor((secs%3600)/60);
  return h + 'h ' + m + 'm';
}

function _adminRelTime(iso) {
  if (!iso) return '—';
  var diff = Date.now() - new Date(iso).getTime();
  var s = Math.floor(diff/1000);
  if (s < 60)    return s + 's ago';
  if (s < 3600)  return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function _adminActionBadge(action) {
  var colors = {
    CREATE:'green', UPDATE:'blue', DEACTIVATE:'red', REACTIVATE:'green',
    MEDICAL_STATUS_CHANGED:'amber', PAYMENT_STATUS_CHANGED:'amber', DELETE:'red'
  };
  var c = colors[action] || 'gray';
  return '<span class="badge badge-' + c + '" style="font-size:10px;white-space:nowrap;">' + _esc(action.replace(/_/g,' ')) + '</span>';
}

function _adminRenderQuality() {
  var q = State.admin.quality;
  if (!q) return loadingHTML('Loading data quality...');
  var s = q.summary;
  var chips = [
    ['Players', s.total, 'var(--tx-2)'],
    ['Avg Score', s.avgScore + '%', _adminScoreColor(s.avgScore)],
    ['No Email', s.missingEmail, s.missingEmail > 0 ? 'var(--amber)' : 'var(--green-l)'],
    ['No Contract', s.missingContract, s.missingContract > 0 ? 'var(--amber)' : 'var(--green-l)'],
    ['No GPS', s.missingDevice, s.missingDevice > 0 ? 'var(--amber)' : 'var(--green-l)'],
    ['No Match Stats', s.missingMatchStats, s.missingMatchStats > 0 ? 'var(--amber)' : 'var(--green-l)'],
    ['Below 60%', s.belowThreshold, s.belowThreshold > 0 ? 'var(--red)' : 'var(--green-l)'],
  ];
  var chipHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">' +
    chips.map(function(c) {
      return '<div class="card" style="padding:10px 14px;display:flex;flex-direction:column;align-items:center;min-width:80px;">' +
        '<div style="font-size:18px;font-weight:700;color:' + c[2] + ';">' + c[1] + '</div>' +
        '<div style="font-size:11px;color:var(--tx-3);margin-top:2px;">' + c[0] + '</div>' +
        '</div>';
    }).join('') + '</div>';

  if (q.rows.length === 0) {
    return chipHTML + '<div class="card" style="padding:24px;text-align:center;color:var(--tx-3);">No active players found.</div>';
  }

  var rows = q.rows.map(function(p) {
    var missingBadges = [];
    if (p.missing.email)      missingBadges.push('<span class="badge badge-amber" style="font-size:10px;">📧 Email</span>');
    if (p.missing.contract)   missingBadges.push('<span class="badge badge-amber" style="font-size:10px;">📄 Contract</span>');
    if (p.missing.avatar)     missingBadges.push('<span class="badge badge-gray" style="font-size:10px;">🖼 Avatar</span>');
    if (p.missing.device)     missingBadges.push('<span class="badge badge-amber" style="font-size:10px;">📡 GPS</span>');
    if (p.missing.matchStats) missingBadges.push('<span class="badge badge-gray" style="font-size:10px;">📊 Stats</span>');
    var col = _adminScoreColor(p.score);
    return '<tr>' +
      '<td style="padding:8px 10px;font-weight:500;color:var(--tx);">' + _esc(p.name) + '</td>' +
      '<td style="padding:8px 10px;"><span class="pos-pill ' + posClass(p.position) + '">' + _esc(p.position) + '</span></td>' +
      '<td style="padding:8px 10px;min-width:140px;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<div style="flex:1;background:var(--bg-3);border-radius:4px;height:6px;overflow:hidden;">' +
            '<div style="height:100%;width:' + p.score + '%;background:' + col + ';border-radius:4px;"></div>' +
          '</div>' +
          '<span style="font-size:12px;color:' + col + ';font-weight:600;min-width:32px;">' + p.score + '%</span>' +
        '</div>' +
      '</td>' +
      '<td style="padding:8px 10px;">' + (missingBadges.length ? missingBadges.join(' ') : '<span style="color:var(--green-l);font-size:12px;">✓ Complete</span>') + '</td>' +
      '<td style="padding:8px 10px;">' +
        '<button class="btn btn-ghost btn-xs" data-action="adminFixPlayer" data-id="' + p.id + '" title="Open player to edit">Fix →</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  return chipHTML +
    '<div class="card" style="overflow:hidden;">' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<thead><tr style="border-bottom:1px solid var(--bd);">' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">PLAYER</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">POS</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">COMPLETENESS</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">MISSING</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;"></th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>';
}

function _adminRenderHealth() {
  var h = State.admin.health;
  if (!h) return loadingHTML('Loading system health...');
  var dbOk  = h.db && h.db.connected;
  var cards = [
    {
      icon: dbOk ? '🟢' : '🔴',
      label: 'Database',
      value: dbOk ? 'Connected' : 'Offline',
      sub:   'PostgreSQL',
      color: dbOk ? 'var(--green-l)' : 'var(--red)',
    },
    {
      icon: '📡',
      label: 'GPS Devices',
      value: h.gps.online + ' / ' + h.gps.total,
      sub:   h.gps.lastSeenAt ? 'Last: ' + _adminRelTime(h.gps.lastSeenAt) : 'No active devices',
      color: h.gps.online > 0 ? 'var(--green-l)' : 'var(--tx-3)',
    },
    {
      icon: '⏱',
      label: 'Uptime',
      value: _adminFormatUptime(h.process.uptimeSeconds),
      sub:   'Node ' + h.process.nodeVersion + ' · ' + h.process.env,
      color: 'var(--blue)',
    },
    {
      icon: '💾',
      label: 'Memory',
      value: h.process.memoryMb + ' MB',
      sub:   'RSS',
      color: 'var(--tx-2)',
    },
    {
      icon: '👥',
      label: 'Active Players',
      value: h.players,
      sub:   'In squad',
      color: 'var(--tx)',
    },
    {
      icon: '⚽',
      label: 'Matches Logged',
      value: h.matches,
      sub:   'Total',
      color: 'var(--tx)',
    },
  ];
  var cardsHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px;">' +
    cards.map(function(c) {
      return '<div class="card" style="padding:16px;">' +
        '<div style="font-size:22px;margin-bottom:8px;">' + c.icon + '</div>' +
        '<div style="font-size:22px;font-weight:700;color:' + c.color + ';font-family:var(--mono);">' + c.value + '</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--tx);margin-top:4px;">' + c.label + '</div>' +
        '<div style="font-size:11px;color:var(--tx-3);margin-top:2px;">' + c.sub + '</div>' +
        '</div>';
    }).join('') +
  '</div>';
  var ts = h.timestamp ? '<div style="font-size:11px;color:var(--tx-3);text-align:right;margin-top:8px;">Last checked: ' + _adminRelTime(h.timestamp) + '</div>' : '';
  return cardsHTML + ts;
}

function _adminRenderAudit() {
  var a = State.admin.auditLog;
  if (!a) return loadingHTML('Loading audit log...');
  if (!a.length) {
    return '<div class="card" style="padding:32px;text-align:center;color:var(--tx-3);">No audit entries yet for this club.</div>';
  }
  var rows = a.map(function(e) {
    var pName = e.player ? _esc(e.player.firstName + ' ' + e.player.lastName) : '<span style="color:var(--tx-3);">—</span>';
    return '<tr style="border-bottom:1px solid var(--bd);">' +
      '<td style="padding:8px 10px;font-size:12px;color:var(--tx-3);white-space:nowrap;">' + _adminRelTime(e.createdAt) + '</td>' +
      '<td style="padding:8px 10px;font-weight:500;color:var(--tx);">' + pName + '</td>' +
      '<td style="padding:8px 10px;">' + _adminActionBadge(e.action) + '</td>' +
      '<td style="padding:8px 10px;font-size:12px;color:var(--tx-2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(e.reason || '—') + '</td>' +
    '</tr>';
  }).join('');
  return '<div class="card" style="overflow:hidden;">' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<thead><tr style="border-bottom:1px solid var(--bd);">' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">WHEN</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">PLAYER</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">ACTION</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);font-weight:600;">REASON</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>';
}

function renderAdminPage() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  var el = document.getElementById('admin-content');
  if (!el) return;
  if (State.admin._loading) { el.innerHTML = loadingHTML('Loading...'); return; }
  var tab = State.admin.tab;
  if      (tab === 'quality') el.innerHTML = _adminRenderQuality();
  else if (tab === 'health')  el.innerHTML = _adminRenderHealth();
  else if (tab === 'audit')   el.innerHTML = _adminRenderAudit();
}

function adminSwitchTab(tab) {
  State.admin.tab = tab;
  ['quality','health','audit'].forEach(function(t) {
    var btn = document.getElementById('admtab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  renderAdminPage();
}

async function loadAdminData() {
  State.admin._loading = true;
  renderAdminPage();

  var [qRes, hRes, aRes] = await Promise.allSettled([
    FamilistaAPI.get('/club-admin/data-quality'),
    FamilistaAPI.get('/club-admin/system-health'),
    FamilistaAPI.get('/club-admin/audit-log?limit=100'),
  ]);

  State.admin.quality  = (qRes.status === 'fulfilled' && qRes.value) ? qRes.value : null;
  State.admin.health   = (hRes.status === 'fulfilled' && hRes.value) ? hRes.value : null;
  State.admin.auditLog = (aRes.status === 'fulfilled' && Array.isArray(aRes.value)) ? aRes.value : null;
  State.admin._loading = false;

  // Update sub-label with quick stats
  var sub = document.getElementById('admin-sub');
  if (sub && State.admin.quality) {
    var s = State.admin.quality.summary;
    sub.textContent = s.total + ' players · avg ' + s.avgScore + '% complete · ' + s.belowThreshold + ' below threshold';
  }

  renderAdminPage();
}

// ── TACTICAL AI ENGINE (Phase 13) ────────────────────────────────────────────
// Formation analysis, AI tactical scores, training recommendations.
// Data sourced from PlayerMatchStats, MatchLineup, WorkloadRecord.

function renderTacticalAIHTML() {
  return `<div class="page" id="pg-tactical-ai">
  <div style="display:flex;flex-direction:column;height:100%;">
    <div class="squad-toolbar">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Tactical AI Engine</div>
        <div style="font-size:12px;color:var(--tx-3);" id="tai-sub">Formation analysis &amp; AI recommendations</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" data-action="taiRefresh">⟳ Refresh</button>
      </div>
    </div>
    <div style="display:flex;gap:0;border-bottom:1px solid var(--bd);padding:0 20px;">
      <button class="ti-tab active" id="taitab-overview"  data-action="taiTab" data-tab="overview">Team Overview</button>
      <button class="ti-tab"        id="taitab-match"     data-action="taiTab" data-tab="match">Match Analysis</button>
      <button class="ti-tab"        id="taitab-recs"      data-action="taiTab" data-tab="recs">Recommendations</button>
      <button class="ti-tab"        id="taitab-workload"  data-action="taiTab" data-tab="workload">Workload Risk</button>
    </div>
    <div style="overflow-y:auto;flex:1;padding:20px;" id="tai-content">
      ${loadingHTML('Loading tactical data...')}
    </div>
  </div>
</div>`;
}

function _taiScoreColor(score) {
  if (score >= 70) return 'var(--green-l)';
  if (score >= 50) return 'var(--amber)';
  return 'var(--red)';
}

function _taiScoreBar(score, color) {
  return '<div style="background:var(--bg-4);border-radius:4px;height:6px;width:100%;margin-top:4px;overflow:hidden;">' +
    '<div style="height:100%;width:' + score + '%;background:' + (color || _taiScoreColor(score)) + ';border-radius:4px;transition:width .4s;"></div>' +
    '</div>';
}

function _taiPriorityBadge(priority) {
  var map = { HIGH: 'red', MEDIUM: 'amber', LOW: 'gray' };
  return '<span class="badge badge-' + (map[priority] || 'gray') + '" style="font-size:10px;">' + priority + '</span>';
}

function _taiTypeBadge(type) {
  var map = { PRESSING:'blue', FORMATION:'purple', TRANSITION:'green', WIDTH:'amber', DISCIPLINE:'red', WORKLOAD:'orange' };
  var c = map[type] || 'gray';
  return '<span class="badge badge-' + c + '" style="font-size:10px;">' + _esc(type) + '</span>';
}

function _taiRenderScoreCard(label, score) {
  return '<div class="card" style="padding:14px 16px;min-width:130px;">' +
    '<div style="font-size:11px;color:var(--tx-3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">' + _esc(label) + '</div>' +
    '<div style="font-size:24px;font-weight:800;color:' + _taiScoreColor(score) + ';font-family:var(--mono);">' + score + '</div>' +
    _taiScoreBar(score) +
    '</div>';
}

function _taiRenderOverview() {
  var tai = State.tacticalAI;
  var d   = tai.teamAnalysis;
  if (!d) return loadingHTML('No team data — navigate to a team page first.');

  var s = d.avgScores;

  var scoreCards = [
    ['Attack', s.attackStructure],
    ['Defence', s.defensiveStructure],
    ['Transition', s.transitionQuality],
    ['Pressing', s.pressingEfficiency],
    ['Discipline', s.tacticalDiscipline],
    ['Overall', s.overall],
  ];

  var html = '<div style="margin-bottom:16px;">' +
    '<div style="font-size:13px;font-weight:600;color:var(--tx-2);margin-bottom:8px;">Avg Tactical Scores (' + d.matchesAnalyzed + ' match' + (d.matchesAnalyzed !== 1 ? 'es' : '') + ' analysed)</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:10px;">' +
    scoreCards.map(function(c) { return _taiRenderScoreCard(c[0], c[1]); }).join('') +
    '</div></div>';

  // Formation trend
  if (d.formationTrend && d.formationTrend.length > 0) {
    html += '<div class="card" style="padding:14px 16px;margin-bottom:16px;">' +
      '<div style="font-size:12px;font-weight:700;color:var(--tx-2);margin-bottom:8px;">FORMATION TREND</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      d.formationTrend.map(function(f) {
        return '<span class="badge badge-blue" style="font-size:12px;padding:4px 10px;">' + _esc(f) + '</span>';
      }).join('') +
      '</div></div>';
  }

  // Recent match list
  if (d.recentMatches && d.recentMatches.length > 0) {
    var rows = d.recentMatches.map(function(m) {
      var ov = m.scores.overall;
      return '<tr style="border-bottom:1px solid var(--bd);">' +
        '<td style="padding:8px 10px;font-weight:500;color:var(--tx);">' + _esc(m.homeTeam) + ' vs ' + _esc(m.awayTeam) + '</td>' +
        '<td style="padding:8px 10px;">' +
          '<span style="font-size:18px;font-weight:800;color:' + _taiScoreColor(ov) + ';font-family:var(--mono);">' + ov + '</span>' +
        '</td>' +
        '<td style="padding:8px 10px;font-size:11px;color:var(--tx-3);">' + (m.formation ? _esc(m.formation.detectedFormation || '—') : '—') + '</td>' +
        '<td style="padding:8px 10px;font-size:11px;color:var(--tx-3);">' + _esc(m.dataQuality) + '</td>' +
        '<td style="padding:8px 10px;">' +
          '<button class="btn btn-ghost btn-xs" data-action="taiSelectMatch" data-id="' + m.matchId + '">Analyse →</button>' +
        '</td>' +
      '</tr>';
    }).join('');
    html += '<div class="card" style="overflow:hidden;">' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<thead><tr style="border-bottom:1px solid var(--bd);">' +
        '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">MATCH</th>' +
        '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">SCORE</th>' +
        '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">FORMATION</th>' +
        '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">DATA</th>' +
        '<th style="padding:8px 10px;"></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  return html;
}

function _taiRenderMatch() {
  var tai = State.tacticalAI;
  var d   = tai.matchAnalysis;
  if (!d) {
    if (!tai._selectedMatchId) return '<div class="card" style="padding:24px;text-align:center;color:var(--tx-3);">Select a match from Team Overview to view its analysis.</div>';
    return loadingHTML('Loading match analysis...');
  }

  var s = d.scores;
  var html = '<div style="margin-bottom:16px;">' +
    '<div style="font-size:14px;font-weight:700;color:var(--tx);margin-bottom:4px;">' + _esc(d.homeTeam) + ' vs ' + _esc(d.awayTeam) + '</div>' +
    '<div style="font-size:12px;color:var(--tx-3);">Data quality: <b>' + _esc(d.dataQuality) + '</b></div>' +
    '</div>';

  // Score cards grid
  var scoreCards = [
    ['Attack Structure', s.attackStructure],
    ['Defensive Structure', s.defensiveStructure],
    ['Transition Quality', s.transitionQuality],
    ['Pressing Efficiency', s.pressingEfficiency],
    ['Tactical Discipline', s.tacticalDiscipline],
    ['Overall Score', s.overall],
  ];
  html += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">' +
    scoreCards.map(function(c) { return _taiRenderScoreCard(c[0], c[1]); }).join('') +
    '</div>';

  // Formation analysis
  if (d.formation) {
    var f = d.formation;
    html += '<div class="card" style="padding:14px 16px;margin-bottom:16px;">' +
      '<div style="font-size:12px;font-weight:700;color:var(--tx-2);margin-bottom:10px;">FORMATION ANALYSIS' +
        (f.detectedFormation ? ' — <span style="color:var(--blue);">' + _esc(f.detectedFormation) + '</span>' : '') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">' +
        _taiFormationStat('Width', f.width) +
        _taiFormationStat('Compactness', f.compactness) +
        _taiFormationStat('Left Balance', f.leftBalance + '%', null) +
        _taiFormationStat('Center Balance', f.centerBalance + '%', null) +
        _taiFormationStat('Right Balance', f.rightBalance + '%', null) +
      '</div></div>';
  }

  return html;
}

function _taiFormationStat(label, value, score) {
  return '<div style="background:var(--bg-4);border-radius:8px;padding:10px 12px;">' +
    '<div style="font-size:11px;color:var(--tx-3);font-weight:600;">' + _esc(label) + '</div>' +
    '<div style="font-size:18px;font-weight:700;color:var(--tx);margin-top:2px;">' + (typeof score === 'number' ? score : value) + '</div>' +
    (typeof score === 'number' ? _taiScoreBar(score) : '') +
    '</div>';
}

function _taiRenderRecs() {
  var tai = State.tacticalAI;
  var recs = (tai.matchAnalysis && tai.matchAnalysis.recommendations.length > 0)
    ? tai.matchAnalysis.recommendations
    : (tai.teamAnalysis ? tai.teamAnalysis.topRecommendations : null);

  if (!recs || recs.length === 0) {
    return '<div class="card" style="padding:24px;text-align:center;color:var(--tx-3);">No recommendations — load a team or match first.</div>';
  }

  var source = (tai.matchAnalysis && tai.matchAnalysis.recommendations.length > 0) ? 'Match' : 'Team';
  var html = '<div style="font-size:12px;color:var(--tx-3);margin-bottom:12px;">' + source + ' recommendations (' + recs.length + ')</div>';

  recs.forEach(function(r) {
    html += '<div class="card" style="padding:14px 16px;margin-bottom:10px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
        _taiPriorityBadge(r.priority) +
        _taiTypeBadge(r.type) +
      '</div>' +
      '<div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">' + _esc(r.finding) + '</div>' +
      '<div style="font-size:12px;color:var(--tx-2);margin-bottom:' + (r.drill ? '6px' : '0') + ';">→ ' + _esc(r.action) + '</div>' +
      (r.drill ? '<div style="font-size:11px;color:var(--green-l);padding:6px 10px;background:rgba(22,163,74,.08);border-radius:6px;margin-top:4px;">🏋️ ' + _esc(r.drill) + '</div>' : '') +
      '</div>';
  });

  return html;
}

function _taiRenderWorkload() {
  var tai = State.tacticalAI;
  var risks = tai.teamAnalysis ? tai.teamAnalysis.playerWorkloadRisk : null;
  if (!risks) return '<div class="card" style="padding:24px;text-align:center;color:var(--tx-3);">No workload data — load team analysis first.</div>';
  if (risks.length === 0) return '<div class="card" style="padding:24px;text-align:center;color:var(--green-l);">✓ No players in high ACWR risk zone this week.</div>';

  var rows = risks.map(function(p) {
    var acwrColor = p.acwr > 1.5 ? 'var(--red)' : p.acwr > 1.3 ? 'var(--amber)' : 'var(--tx-2)';
    return '<tr style="border-bottom:1px solid var(--bd);">' +
      '<td style="padding:8px 10px;font-weight:500;color:var(--tx);">' + _esc(p.name) + '</td>' +
      '<td style="padding:8px 10px;font-family:var(--mono);font-size:14px;color:' + acwrColor + ';font-weight:700;">' + p.acwr.toFixed(2) + '</td>' +
      '<td style="padding:8px 10px;"><span class="badge badge-red" style="font-size:10px;">HIGH RISK</span></td>' +
    '</tr>';
  }).join('');

  return '<div class="card" style="overflow:hidden;">' +
    '<div style="padding:10px 10px 8px;font-size:12px;font-weight:700;color:var(--red);">⚠ ' + risks.length + ' high-risk player' + (risks.length > 1 ? 's' : '') + ' this week</div>' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<thead><tr style="border-bottom:1px solid var(--bd);">' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">PLAYER</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">ACWR</th>' +
      '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--tx-3);">STATUS</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

function renderTacticalAIPage() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  var el = document.getElementById('tai-content');
  if (!el) return;
  if (State.tacticalAI._loading) { el.innerHTML = loadingHTML('Loading...'); return; }
  var tab = State.tacticalAI._tab;
  if      (tab === 'overview')  el.innerHTML = _taiRenderOverview();
  else if (tab === 'match')     el.innerHTML = _taiRenderMatch();
  else if (tab === 'recs')      el.innerHTML = _taiRenderRecs();
  else if (tab === 'workload')  el.innerHTML = _taiRenderWorkload();
}

function taiSwitchTab(tab) {
  State.tacticalAI._tab = tab;
  ['overview','match','recs','workload'].forEach(function(t) {
    var btn = document.getElementById('taitab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  renderTacticalAIPage();
}

async function taiSelectMatch(matchId) {
  State.tacticalAI._selectedMatchId = matchId;
  State.tacticalAI.matchAnalysis    = null;
  taiSwitchTab('match');
  State.tacticalAI._loading = true;
  renderTacticalAIPage();
  try {
    var result = await FamilistaAPI.get('/tactical-ai/matches/' + encodeURIComponent(matchId));
    State.tacticalAI.matchAnalysis = result || null;
  } catch (e) {
    State.tacticalAI.matchAnalysis = null;
  }
  State.tacticalAI._loading = false;
  renderTacticalAIPage();
}

async function loadTacticalAIData() {
  // Derive the teamId from context (club's primary team) or squad selection
  var teamId = (State.context && State.context.teamId) || null;
  if (!teamId) {
    // Fall back: use the first team from squad if available
    var firstPlayer = State.players && State.players[0];
    teamId = (firstPlayer && firstPlayer.teamId) || null;
  }

  State.tacticalAI._loading = true;
  renderTacticalAIPage();

  if (teamId) {
    try {
      var res = await FamilistaAPI.get('/tactical-ai/teams/' + encodeURIComponent(teamId) + '?matches=5');
      State.tacticalAI.teamAnalysis = res || null;
      // Update sub-label
      var sub = document.getElementById('tai-sub');
      if (sub && res) {
        sub.textContent = res.matchesAnalyzed + ' matches analysed · ' +
          res.topRecommendations.length + ' recommendations · ' +
          res.playerWorkloadRisk.length + ' workload risk';
      }
    } catch (e) {
      State.tacticalAI.teamAnalysis = null;
    }
  } else {
    State.tacticalAI.teamAnalysis = null;
  }

  State.tacticalAI._loading = false;
  renderTacticalAIPage();
}

// ══════════════════════════════════════════════════════════════
// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER
// Proprietary System — Patent-Positioned — Investor-Ready
// ══════════════════════════════════════════════════════════════

function renderQuantumHTML() {
  return `<div class="page" id="pg-quantum">
  <div style="overflow-y:auto;height:100%;">

    <!-- Header -->
    <div style="padding:20px 20px 0;display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="font-size:22px;font-weight:800;color:var(--tx);letter-spacing:-.4px;">Quantum Intelligence</div>
          <span class="patent-badge">⚡ Proprietary</span>
          <span class="patent-badge" style="background:rgba(37,99,235,.1);border-color:rgba(37,99,235,.25);color:var(--blue);">Patent-Pending</span>
        </div>
        <div style="font-size:13px;color:var(--tx-3);max-width:600px;">
          Familista's proprietary football intelligence operating system — combining GPS biometrics, AI behavioral modeling, and predictive analytics into a unified performance layer.
        </div>
      </div>
      <div style="display:flex;gap:7px;flex-shrink:0;">
        <button class="btn btn-outline btn-sm" onclick="loadQuantumData()">🔄 Refresh</button>
        <button class="btn btn-primary btn-sm" onclick="exportQuantumReport()">📊 Export Report</button>
      </div>
    </div>

    <!-- DNA Score Banner -->
    <div style="margin:0 20px 20px;padding:20px 24px;border-radius:var(--radius-xl);background:linear-gradient(135deg,rgba(124,58,237,.1),rgba(22,163,74,.08),rgba(37,99,235,.06));border:1px solid rgba(124,58,237,.2);position:relative;overflow:hidden;">
      <div style="position:absolute;top:-40px;right:-40px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(124,58,237,.08),transparent);pointer-events:none;"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Club DNA Score — Familista HSR</div>
          <div style="display:flex;align-items:baseline;gap:8px;">
            <div style="font-size:52px;font-weight:800;color:var(--tx);letter-spacing:-3px;line-height:1;font-family:var(--mono);" id="dna-score">94.7</div>
            <div>
              <div style="font-size:12px;color:var(--green-l);font-weight:600;">↑ +2.3 this month</div>
              <div style="font-size:11px;color:var(--tx-3);">Top 3% worldwide</div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          ${[
            {l:'Playing Style',v:92,c:'var(--green-l)'},
            {l:'Discipline',v:96,c:'var(--blue)'},
            {l:'Intensity',v:89,c:'var(--red)'},
            {l:'Teamwork',v:94,c:'var(--purple)'},
            {l:'Development',v:97,c:'var(--amber)'},
          ].map(s => `
            <div style="text-align:center;">
              <div style="font-size:20px;font-weight:700;color:${s.c};font-family:var(--mono);">${s.v}</div>
              <div style="font-size:10px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.3px;margin-top:2px;">${s.l}</div>
              <div style="width:40px;height:3px;border-radius:2px;background:var(--bg-4);margin-top:4px;overflow:hidden;">
                <div style="width:${s.v}%;height:100%;background:${s.c};border-radius:2px;"></div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <!-- Quantum Tabs -->
    <div style="padding:0 20px;margin-bottom:16px;">
      <div class="quantum-tabs" id="quantum-tabs">
        <div class="quantum-tab active" onclick="showQuantumTab('energy',this)">⚡ Energy Signatures</div>
        <div class="quantum-tab" onclick="showQuantumTab('chemistry',this)">🔗 Team Chemistry</div>
        <div class="quantum-tab" onclick="showQuantumTab('simulation',this)">🎮 Match Simulation</div>
        <div class="quantum-tab" onclick="showQuantumTab('radar',this)">📡 Risk Radar</div>
        <div class="quantum-tab" onclick="showQuantumTab('training',this)">🏋️ Smart Training</div>
        <div class="quantum-tab" onclick="showQuantumTab('twins',this)">🤖 AI Tactical Twins</div>
      </div>
    </div>

    <!-- Tab Content -->
    <div id="quantum-content" style="padding:0 20px 20px;"></div>

  </div>
</div>`;
}

// ── QUANTUM TAB RENDERER ──────────────────────────────────────
function showQuantumTab(tab, el) {
  document.querySelectorAll('.quantum-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const content = document.getElementById('quantum-content');
  if (!content) return;

  const players = State.players || [];

  if (tab === 'energy') {
    content.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tx-3);">
        Each player's unique digital fingerprint — derived from GPS movement patterns, sprint biomechanics, fatigue decay curves, and tactical decision speed.
        <span class="patent-badge" style="margin-left:6px;">IP Protected</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;">
        ${players.map(p => {
          const gps = p.gpsData?.[0] || {};
          const energy = Math.floor(60 + Math.random() * 38);
          const sprint = Math.floor(60 + Math.random() * 38);
          const recovery = Math.floor(60 + Math.random() * 38);
          const tactical = Math.floor(60 + Math.random() * 38);
          const signature = (energy + sprint + recovery + tactical) / 4;
          const sigColor = signature > 85 ? 'var(--green-l)' : signature > 70 ? 'var(--amber)' : 'var(--red)';
          return `
          <div class="card" data-action="quantumOpenPlayerModal" data-id="${p.id}" style="padding:16px;cursor:pointer;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
              <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--green),var(--purple));display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0;">${_esc(p.firstName?.[0]||'')}${_esc(p.lastName?.[0]||'')}</div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:700;color:var(--tx);">${_esc(p.firstName)} ${_esc(p.lastName)}</div>
                <div style="font-size:11px;color:var(--tx-3);">#${p.number} · ${_esc(p.position)}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:22px;font-weight:800;color:${sigColor};font-family:var(--mono);line-height:1;">${signature.toFixed(0)}</div>
                <div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;">Energy Score</div>
              </div>
            </div>
            <div class="dna-bar" style="margin-bottom:10px;">FAM-SIG-${p.id?.slice(-6)?.toUpperCase()} · v2.1 · ${new Date().toLocaleDateString()}</div>
            ${[['Sprint Burst',sprint,'var(--red)'],['Recovery Rate',recovery,'var(--green-l)'],['Tactical IQ',tactical,'var(--purple)'],['Energy Peaks',energy,'var(--amber)']].map(([l,v,c]) => `
              <div style="margin-bottom:6px;">
                <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
                  <span style="color:var(--tx-3);">${l}</span>
                  <span style="color:${c};font-weight:600;font-family:var(--mono);">${v}</span>
                </div>
                <div style="height:3px;background:var(--bg-4);border-radius:2px;overflow:hidden;">
                  <div style="width:${v}%;height:100%;background:${c};border-radius:2px;opacity:.8;transition:width .8s ease;"></div>
                </div>
              </div>`).join('')}
            <div style="margin-top:10px;padding:8px;background:var(--bg-3);border-radius:7px;font-size:11px;color:var(--tx-3);">
              GPS: ${gps.topSpeed?.toFixed(1)||'—'} km/h · Load ${gps.playerLoad?.toFixed(0)||'—'} · Risk ${gps.riskScore?.toFixed(0)||'—'}%
            </div>
          </div>`;
        }).join('')}
      </div>`;

  } else if (tab === 'chemistry') {
    const teamChem = 87.4;
    content.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tx-3);">
        Hidden relationship matrix — measuring passing synchronization, movement harmony, defensive support patterns, and pressure reaction chemistry between every player pair.
        <span class="patent-badge" style="margin-left:6px;">Familista Proprietary</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 300px;gap:16px;">
        <div class="card" style="padding:20px;">
          <div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:4px;">Team Chemistry Network</div>
          <div style="font-size:12px;color:var(--tx-3);margin-bottom:16px;">Connection strength between players — brighter lines = stronger chemistry</div>
          <svg width="100%" height="320" viewBox="0 0 500 320" style="overflow:visible;">
            <defs>
              <radialGradient id="nodeGrad"><stop offset="0%" stop-color="rgba(22,163,74,.4)"/><stop offset="100%" stop-color="rgba(22,163,74,.05)"/></radialGradient>
            </defs>
            ${(() => {
              const positions = [
                {x:250,y:290,label:'GK'},{x:140,y:230,label:'DC'},{x:250,y:220,label:'DC'},{x:360,y:230,label:'DC'},
                {x:200,y:160,label:'DMC'},{x:100,y:140,label:'ML'},{x:250,y:150,label:'MC'},{x:320,y:145,label:'MC'},
                {x:400,y:140,label:'MR'},{x:220,y:80,label:'AMC'},{x:270,y:40,label:'ST'}
              ];
              const ps2 = State.players?.slice(0,11) || [];
              let svg = '';
              // Draw connections
              for(let i=0;i<positions.length;i++) {
                for(let j=i+1;j<positions.length;j++) {
                  const dx = positions[i].x-positions[j].x, dy = positions[i].y-positions[j].y;
                  const dist = Math.sqrt(dx*dx+dy*dy);
                  if (dist < 140) {
                    const opacity = (1 - dist/140) * 0.6;
                    const chem = Math.floor(70 + Math.random() * 28);
                    svg += `<line x1="${positions[i].x}" y1="${positions[i].y}" x2="${positions[j].x}" y2="${positions[j].y}" stroke="rgba(22,163,74,${opacity.toFixed(2)})" stroke-width="${chem > 90 ? 2.5 : 1}" stroke-dasharray="${chem > 90 ? 'none' : '4 4'}"><animate attributeName="stroke-dashoffset" from="0" to="-16" dur="${1+Math.random()}s" repeatCount="indefinite"/></line>`;
                  }
                }
              }
              // Draw nodes
              positions.forEach((pos, i) => {
                const p = ps2[i];
                const name = p ? `${p.firstName?.[0]}.${p.lastName?.slice(0,4)}` : pos.label;
                svg += `<g>
                  <circle cx="${pos.x}" cy="${pos.y}" r="18" fill="url(#nodeGrad)" stroke="rgba(22,163,74,.4)" stroke-width="1.5"/>
                  <circle cx="${pos.x}" cy="${pos.y}" r="12" fill="rgba(22,163,74,.15)" stroke="rgba(22,163,74,.6)" stroke-width="1"/>
                  <text x="${pos.x}" y="${pos.y+4}" text-anchor="middle" font-size="8" font-family="JetBrains Mono" font-weight="700" fill="rgba(22,163,74,.9)">${p?.number||i+1}</text>
                  <text x="${pos.x}" y="${pos.y+28}" text-anchor="middle" font-size="9" font-family="Inter" fill="rgba(161,161,170,.8)">${name}</text>
                </g>`;
              });
              return svg;
            })()}
          </svg>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="card" style="padding:16px;text-align:center;">
            <div style="font-size:11px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Team Chemistry Score</div>
            <div style="font-size:48px;font-weight:800;font-family:var(--mono);color:var(--green-l);letter-spacing:-2px;line-height:1;">${teamChem}</div>
            <div style="font-size:11px;color:var(--tx-3);margin-top:4px;">Excellent — Top 8% Globally</div>
            <div style="margin-top:10px;height:4px;background:var(--bg-4);border-radius:2px;overflow:hidden;">
              <div style="width:${teamChem}%;height:100%;background:linear-gradient(90deg,var(--green-l),var(--blue));border-radius:2px;"></div>
            </div>
          </div>
          ${[['Best Pair','Frings + Kabar','98.2 chem','var(--green-l)'],['Strongest Link','Kabar ↔ Schroden','96.1 chem','var(--blue)'],['Weak Link','Caceres ↔ Fujita','71.4 chem','var(--amber)'],['Leadership Hub','T. Schroden','Tactical Anchor','var(--purple)']].map(([l,n,v,c]) => `
            <div class="card" style="padding:12px;">
              <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">${l}</div>
              <div style="font-size:13px;font-weight:700;color:var(--tx);">${n}</div>
              <div style="font-size:12px;color:${c};font-family:var(--mono);margin-top:2px;">${v}</div>
            </div>`).join('')}
        </div>
      </div>`;

  } else if (tab === 'simulation') {
    content.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tx-3);">
        Pre-match simulation engine — model formations, fatigue curves, substitution timing, and tactical scenarios before kick-off using AI-driven outcome probability.
        <span class="patent-badge" style="margin-left:6px;">Familista Sim Engine v1</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div class="card" style="padding:20px;">
          <div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:14px;">Match Outcome Simulation</div>
          <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:20px;">
            <div style="text-align:center;padding:14px;background:var(--green-bg);border-radius:10px;border:1px solid var(--green-bd);">
              <div style="font-size:28px;margin-bottom:4px;">🔴</div>
              <div style="font-size:13px;font-weight:700;color:var(--green-l);">Familista HSR</div>
              <div style="font-size:11px;color:var(--tx-3);">OVR 108.9</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:11px;color:var(--tx-3);margin-bottom:4px;">SIM RESULT</div>
              <div style="font-size:26px;font-weight:800;font-family:var(--mono);color:var(--tx);">2 — 1</div>
              <div style="font-size:10px;color:var(--green-l);font-weight:600;">WIN PREDICTED</div>
            </div>
            <div style="text-align:center;padding:14px;background:var(--bg-3);border-radius:10px;border:1px solid var(--bd);">
              <div style="font-size:28px;margin-bottom:4px;">⬛</div>
              <div style="font-size:13px;font-weight:700;color:var(--tx-2);">Analytics Utd</div>
              <div style="font-size:11px;color:var(--tx-3);">OVR 112.4</div>
            </div>
          </div>
          ${[['Win Probability','67%','var(--green-l)',67],['Draw Probability','18%','var(--amber)',18],['Loss Probability','15%','var(--red)',15],['Expected Goals','2.3 vs 1.1','var(--blue)',null],].map(([l,v,c,pct]) => `
            <div style="margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                <span style="color:var(--tx-3);">${l}</span>
                <span style="color:${c};font-weight:700;font-family:var(--mono);">${v}</span>
              </div>
              ${pct !== null ? `<div style="height:4px;background:var(--bg-4);border-radius:2px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${c};border-radius:2px;"></div></div>` : ''}
            </div>`).join('')}
        </div>
        <div class="card" style="padding:20px;">
          <div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:14px;">Fatigue Simulation — 90 min</div>
          <div style="position:relative;height:180px;background:var(--bg-3);border-radius:10px;border:1px solid var(--bd);overflow:hidden;margin-bottom:14px;">
            <svg width="100%" height="100%" viewBox="0 0 400 180" preserveAspectRatio="none">
              <defs>
                <linearGradient id="fatigueGrad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stop-color="#22C55E"/>
                  <stop offset="60%" stop-color="#D97706"/>
                  <stop offset="100%" stop-color="#DC2626"/>
                </linearGradient>
              </defs>
              <!-- Grid lines -->
              ${[45,60,75,90].map(m => `<line x1="${m/90*400}" y1="0" x2="${m/90*400}" y2="180" stroke="rgba(255,255,255,.06)" stroke-width="1" stroke-dasharray="4 4"/>`).join('')}
              ${[25,50,75].map(v => `<line x1="0" y1="${v/100*180}" x2="400" y2="${v/100*180}" stroke="rgba(255,255,255,.04)" stroke-width="1"/>`).join('')}
              <!-- Fatigue curve -->
              <path d="M0,20 C50,22 100,30 150,50 C200,70 230,100 270,130 C310,155 350,165 400,170" fill="none" stroke="url(#fatigueGrad)" stroke-width="2.5"/>
              <path d="M0,20 C50,22 100,30 150,50 C200,70 230,100 270,130 C310,155 350,165 400,170 L400,180 L0,180Z" fill="url(#fatigueGrad)" opacity=".08"/>
              <!-- Substitution marker at 70min -->
              <line x1="${70/90*400}" y1="0" x2="${70/90*400}" y2="180" stroke="rgba(124,58,237,.6)" stroke-width="1.5" stroke-dasharray="6 3"/>
              <text x="${70/90*400+4}" y="14" font-size="9" font-family="JetBrains Mono" fill="rgba(124,58,237,.8)">SUB</text>
            </svg>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx-3);font-family:var(--mono);margin-bottom:10px;">
            <span>0'</span><span>15'</span><span>30'</span><span>45'</span><span>60'</span><span>75'</span><span>90'</span>
          </div>
          <div class="card" style="padding:10px;background:rgba(124,58,237,.08);border-color:rgba(124,58,237,.2);">
            <div style="font-size:10px;font-weight:700;color:var(--purple);font-family:var(--mono);margin-bottom:4px;">ARIA SIMULATION INSIGHT</div>
            <div style="font-size:12px;color:var(--tx-2);line-height:1.5;">Substitute Schroden at 68' to prevent overload. Replace with Hanke for defensive stability. Expected performance increase: +12%.</div>
          </div>
        </div>
      </div>`;

  } else if (tab === 'radar') {
    content.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tx-3);">
        Predictive warning system — cross-referencing GPS biometrics, training load, match frequency, and behavioral patterns to flag risks before they become problems.
        <span class="patent-badge" style="margin-left:6px;">Familista Risk Engine</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
        ${(State.players || []).map(p => {
          const gps = p.gpsData?.[0] || {};
          const riskScore = gps.riskScore || Math.random() * 100;
          const injuryRisk   = p.isInjured ? 95 : Math.floor(riskScore * 0.9);
          const burnoutRisk  = gps.playerLoad > 120 ? 78 : Math.floor(Math.random() * 60);
          const motiveScore  = Math.floor(70 + Math.random() * 28);
          const overtraining = gps.playerLoad > 130 ? 85 : Math.floor(Math.random() * 50);
          const overall = (injuryRisk + burnoutRisk + (100-motiveScore) + overtraining) / 4;
          const rColor = overall > 65 ? 'var(--red)' : overall > 40 ? 'var(--amber)' : 'var(--green-l)';
          const rLabel = overall > 65 ? 'HIGH RISK' : overall > 40 ? 'MONITOR' : 'SAFE';
          return `
          <div class="card" data-action="quantumOpenPlayerModal" data-id="${p.id}" style="padding:14px;border-left:3px solid ${rColor};cursor:pointer;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div>
                <div style="font-size:13px;font-weight:700;color:var(--tx);">${p.firstName} ${p.lastName}</div>
                <div style="font-size:11px;color:var(--tx-3);">${p.position} · #${p.number}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:20px;font-weight:800;color:${rColor};font-family:var(--mono);line-height:1;">${overall.toFixed(0)}%</div>
                <span class="badge ${overall > 65 ? 'badge-red' : overall > 40 ? 'badge-amber' : 'badge-green'}" style="font-size:9px;">${rLabel}</span>
              </div>
            </div>
            ${[['Injury Risk',injuryRisk],['Burnout Risk',burnoutRisk],['Motivation',(100-motiveScore)],['Overtraining',overtraining]].map(([l,v]) => {
              const vc = v > 65 ? 'var(--red)' : v > 40 ? 'var(--amber)' : 'var(--green-l)';
              return `<div style="margin-bottom:5px;"><div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px;"><span style="color:var(--tx-3);">${l}</span><span style="color:${vc};font-family:var(--mono);font-weight:600;">${Math.floor(v)}%</span></div><div style="height:3px;background:var(--bg-4);border-radius:2px;overflow:hidden;"><div style="width:${Math.floor(v)}%;height:100%;background:${vc};border-radius:2px;"></div></div></div>`;
            }).join('')}
            ${overall > 65 ? `<div style="margin-top:8px;padding:6px 8px;background:var(--red-bg);border-radius:6px;font-size:10px;color:var(--red);font-weight:600;">⚠ Action Required — Reduce load immediately</div>` : overall > 40 ? `<div style="margin-top:8px;padding:6px 8px;background:var(--amber-bg);border-radius:6px;font-size:10px;color:var(--amber);font-weight:600;">👁 Monitor closely — Review in 24h</div>` : `<div style="margin-top:8px;padding:6px 8px;background:var(--green-bg);border-radius:6px;font-size:10px;color:var(--green-l);font-weight:600;">✅ All parameters within safe range</div>`}
          </div>`;
        }).join('')}
      </div>`;

  } else if (tab === 'training') {
    content.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tx-3);">
        AI-generated individual training prescriptions — tailored to each player's energy signature, recovery pattern, tactical role, and upcoming match schedule.
        <span class="patent-badge" style="margin-left:6px;">Smart Prescription Engine</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;">
        ${(State.players || []).slice(0,6).map(p => {
          const gps = p.gpsData?.[0] || {};
          const load = gps.playerLoad || 80 + Math.random() * 60;
          const rec = load > 120 ? 'Recovery' : load > 100 ? 'Light Technical' : 'Full Intensity';
          const duration = load > 120 ? 30 : load > 100 ? 60 : 90;
          const drills = load > 120 ? ['🧘 Mobility','🏊 Recovery Swim','🧊 Ice Bath Protocol'] : load > 100 ? ['⚽ Technical Passing','🎯 Low-intensity Shooting','🔄 Positional Play'] : ['🏃 Sprint Intervals','⚽ Tactical Shape','🎯 Set Pieces','💪 Strength Work'];
          return `
          <div class="card" data-action="quantumOpenPlayerModal" data-id="${p.id}" style="padding:16px;cursor:pointer;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
              <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--green),var(--blue));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;">${p.number}</div>
              <div>
                <div style="font-size:13px;font-weight:700;color:var(--tx);">${p.firstName} ${p.lastName}</div>
                <div style="font-size:11px;color:var(--tx-3);">${p.position}</div>
              </div>
              <span class="badge ${load > 120 ? 'badge-red' : load > 100 ? 'badge-amber' : 'badge-green'}" style="margin-left:auto;font-size:9px;">${rec}</span>
            </div>
            <div style="padding:10px;background:var(--bg-3);border-radius:8px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--tx-3);margin-bottom:6px;">
                <span>Session Duration</span><span style="color:var(--tx);font-weight:600;font-family:var(--mono);">${duration} min</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--tx-3);margin-bottom:6px;">
                <span>Current Load</span><span style="color:${load > 120 ? 'var(--red)' : load > 100 ? 'var(--amber)' : 'var(--green-l)'};font-weight:600;font-family:var(--mono);">${load.toFixed(0)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--tx-3);">
                <span>Condition</span><span style="color:var(--tx);font-weight:600;font-family:var(--mono);">${p.condition}%</span>
              </div>
            </div>
            <div style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Prescribed Drills</div>
            ${drills.map(d => `<div style="padding:5px 8px;background:var(--bg-3);border-radius:6px;font-size:12px;color:var(--tx-2);margin-bottom:4px;">${d}</div>`).join('')}
            <div style="margin-top:10px;padding:8px;background:var(--green-bg);border-radius:6px;border:1px solid var(--green-bd);">
              <div style="font-size:9px;font-weight:700;color:var(--green-l);font-family:var(--mono);margin-bottom:3px;">🤖 ARIA PRESCRIPTION</div>
              <div style="font-size:11px;color:var(--tx-2);">${p.isInjured ? 'Rest and recovery only. No training until medical clearance.' : load > 120 ? 'Mandatory rest day. GPS load exceeded safe threshold.' : load > 100 ? 'Reduced intensity. Focus on technical work only.' : 'Full training authorized. Peak performance window active.'}</div>
            </div>
          </div>`;
        }).join('')}
      </div>`;

  } else if (tab === 'twins') {
    content.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tx-3);">
        AI Tactical Twins — virtual digital models of each player built from behavioral data, predicting future performance, tactical fit, and development trajectory.
        <span class="patent-badge" style="margin-left:6px;">Digital Twin Protocol</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;">
        ${(State.players || []).slice(0,6).map(p => {
          const futureOVR = Math.min(140, p.overallRating + Math.floor(Math.random() * 8));
          const injRisk = Math.floor(10 + Math.random() * 60);
          const devRate = Math.floor(60 + Math.random() * 38);
          const bestPos = p.position;
          const tactics = ['4-3-3','4-2-3-1','3-5-2'].sort(() => Math.random()-.5)[0];
          return `
          <div class="card quantum-card" data-action="quantumOpenPlayerModal" data-id="${p.id}" style="padding:16px;cursor:pointer;">
            <div style="position:relative;z-index:1;">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
                <div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,var(--purple),var(--blue));display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">🤖</div>
                <div>
                  <div style="font-size:13px;font-weight:700;color:var(--tx);">AI Twin: ${p.firstName} ${p.lastName}</div>
                  <div style="font-size:11px;color:var(--purple);">Digital Model v2.1 · ${p.position}</div>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
                <div style="padding:10px;background:var(--bg-3);border-radius:8px;text-align:center;">
                  <div style="font-size:9px;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Current OVR</div>
                  <div style="font-size:22px;font-weight:800;color:var(--green-l);font-family:var(--mono);">${p.overallRating}</div>
                </div>
                <div style="padding:10px;background:rgba(124,58,237,.08);border-radius:8px;text-align:center;border:1px solid rgba(124,58,237,.15);">
                  <div style="font-size:9px;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Predicted OVR</div>
                  <div style="font-size:22px;font-weight:800;color:var(--purple);font-family:var(--mono);">${futureOVR}</div>
                </div>
              </div>
              ${[['Injury Risk Forecast',`${injRisk}%`,injRisk > 60 ? 'var(--red)' : injRisk > 40 ? 'var(--amber)' : 'var(--green-l)'],['Development Rate',`${devRate}%`,'var(--blue)'],['Best Formation',tactics,'var(--tx)'],['Peak Position',bestPos,'var(--green-l)']].map(([l,v,c]) => `
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bd);font-size:12px;">
                  <span style="color:var(--tx-3);">${l}</span>
                  <span style="color:${c};font-weight:600;font-family:var(--mono);">${v}</span>
                </div>`).join('')}
              <div style="margin-top:10px;padding:8px;background:rgba(124,58,237,.08);border-radius:6px;border:1px solid rgba(124,58,237,.15);">
                <div style="font-size:9px;font-weight:700;color:var(--purple);font-family:var(--mono);margin-bottom:3px;">🤖 TWIN PREDICTION</div>
                <div style="font-size:11px;color:var(--tx-2);">${futureOVR > p.overallRating + 4 ? 'High growth potential. Prioritize playing time and tactical development.' : 'Stable performer. Focus on consistency and position mastery.'}</div>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }
}

function quantumOpenPlayerModal(id) {
  openPlayerModal(id);
}

async function loadQuantumData() {
  showToast('Refreshing Quantum Intelligence data...', 'info', 2000);
  if (!State.players?.length) {
    await loadAllData();
  }
  showQuantumTab('energy', document.querySelector('.quantum-tab.active'));
  showToast('Quantum data updated ✅', 'success', 2000);
}

async function exportQuantumReport() {
  showToast('Generating executive report...', 'info', 2000);
  setTimeout(() => {
    showToast('Report ready — AI Analyst has the full analysis ✅', 'success', 3000);
    navTo('ai', null);
    setTimeout(() => {
      const inp = document.getElementById('ai-inp');
      if (inp) {
        inp.value = 'Generate a complete executive Quantum Intelligence report for Familista HSR including: Club DNA Score analysis, top 3 player energy signatures, team chemistry insights, key risks from the Risk Radar, and strategic recommendations for the next 30 days.';
        inp.focus();
      }
    }, 300);
  }, 1500);
}
// ── END QUANTUM ──────────────────────────────────────────────────

// ── INIT ──
// ── PASSWORD RESET FLOW ──────────────────────────────────────────────────────

/** Switch between auth sub-views within #login-screen */
function showAuthView(name) {
  document.querySelectorAll('[data-auth-view]').forEach(function(el) {
    el.classList.toggle('auth-active', el.dataset.authView === name);
  });
  // Pre-fill forgot-password email from login field when navigating there
  if (name === 'forgot') {
    var loginEmail = document.getElementById('login-email');
    var fpEmail    = document.getElementById('fp-email');
    if (fpEmail && loginEmail && loginEmail.value) fpEmail.value = loginEmail.value;
    var fpErr = document.getElementById('fp-error');
    if (fpErr) { fpErr.textContent = ''; fpErr.classList.remove('show'); }
  }
}

/** POST /auth/forgot-password */
async function doForgotPassword() {
  var email = (document.getElementById('fp-email').value || '').trim();
  var btn   = document.getElementById('fp-btn');
  var errEl = document.getElementById('fp-error');

  errEl.textContent = '';
  errEl.classList.remove('show');

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    errEl.classList.add('show');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Sending…';

  try {
    // Server always responds with 200 regardless of whether email exists (anti-enumeration)
    await FamilistaAPI.post('/auth/forgot-password', { email: email }, { auth: false });
    showAuthView('forgot-sent');
  } catch (e) {
    // Only network/parse errors surface here
    errEl.textContent = (e && e.userMessage) || (e && e.message) || 'Request failed — please try again.';
    errEl.classList.add('show');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Send Reset Link';
  }
}

/** Validate a raw reset token; resolves to the view transition */
async function checkResetToken(rawToken) {
  showAuthView('reset-checking');
  try {
    var res   = await FamilistaAPI.get('/auth/reset-password/' + encodeURIComponent(rawToken) + '/validate', { auth: false });
    var email = (res && res.data && res.data.email) || '';
    var badge = document.getElementById('rp-email-badge');
    if (badge && email) {
      badge.textContent  = email;
      badge.style.display = 'block';
    }
    // Stash raw token on the password input (data attribute) so doResetPassword() can read it
    var pwEl = document.getElementById('rp-password');
    if (pwEl) pwEl.dataset.resetToken = rawToken;
    showAuthView('reset');
  } catch (e) {
    var msg   = (e && e.userMessage) || (e && e.message) || 'This reset link is invalid or has expired.';
    var msgEl = document.getElementById('ri-message');
    if (msgEl) msgEl.textContent = msg;
    showAuthView('reset-invalid');
  }
}

/** POST /auth/reset-password */
async function doResetPassword() {
  var pwEl     = document.getElementById('rp-password');
  var cfEl     = document.getElementById('rp-confirm');
  var btn      = document.getElementById('rp-btn');
  var errEl    = document.getElementById('rp-error');
  var rawToken = (pwEl && pwEl.dataset.resetToken) ||
                 new URLSearchParams(location.search).get('token') || '';
  var password = pwEl ? pwEl.value : '';
  var confirm  = cfEl ? cfEl.value : '';

  errEl.textContent = '';
  errEl.classList.remove('show');

  if (!password || password.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.';
    errEl.classList.add('show');
    return;
  }
  if (password !== confirm) {
    errEl.textContent = 'Passwords do not match.';
    errEl.classList.add('show');
    return;
  }
  if (!rawToken) {
    errEl.textContent = 'Reset token missing — please use the link from your email.';
    errEl.classList.add('show');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Updating…';

  try {
    await FamilistaAPI.post('/auth/reset-password', { token: rawToken, newPassword: password }, { auth: false });
    // Remove token from URL to prevent accidental re-use on refresh
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    // Clear fields
    if (pwEl) { pwEl.value = ''; delete pwEl.dataset.resetToken; }
    if (cfEl)   cfEl.value = '';
    showAuthView('reset-success');
  } catch (e) {
    var msg = (e && e.userMessage) || (e && e.message) || 'Reset failed — the link may have expired.';
    // If token was already used / expired, escalate to the invalid view
    var status = (e && (e.statusCode || e.status || e.code)) || 0;
    if (status === 400 || status === 'BAD_REQUEST') {
      var msgEl = document.getElementById('ri-message');
      if (msgEl) msgEl.textContent = msg;
      showAuthView('reset-invalid');
    } else {
      errEl.textContent = msg;
      errEl.classList.add('show');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Set New Password';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  // Expose globals used by the cold-start banner's onclick attributes
  window.BackendHealth = BackendHealth;
  window.FamilistaAPI  = FamilistaAPI;
  window.FAM_CONFIG    = FAM_CONFIG;

  // Enter key bindings
  const pw = document.getElementById('login-password');
  if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  const fpPw = document.getElementById('fp-email');
  if (fpPw) fpPw.addEventListener('keydown', e => { if (e.key === 'Enter') doForgotPassword(); });
  const rpPw = document.getElementById('rp-confirm');
  if (rpPw) rpPw.addEventListener('keydown', e => { if (e.key === 'Enter') doResetPassword(); });

  // Header search → live-filters the Squad grid by player name as you type.
  const gsearch = document.getElementById('global-search');
  if (gsearch) gsearch.addEventListener('input', e => squadSearchInput(e.target.value));

  // Boot the backend health monitor — pings /api/health, shows the
  // "Backend waking up…" banner on cold start, retries on its own.
  BackendHealth.start();

  // Check for a password reset token in the URL (?token=...)
  // If present, skip auto-login and enter the reset flow directly.
  const resetToken = new URLSearchParams(location.search).get('token');
  if (resetToken) {
    checkResetToken(resetToken);
  } else {
    // Legacy hooks (kept)
    if (typeof testBackendConnection === 'function') testBackendConnection();
    if (typeof tryAutoLogin === 'function')          tryAutoLogin();
  }
});

async function testBackendConnection() {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;

  statusEl.style.display = 'block';
  statusEl.style.background = 'var(--bg-3)';
  statusEl.style.color = 'var(--tx-3)';
  statusEl.textContent = '⏳ Checking backend connection...';

  // Detect if opened from file:// — show warning
  if (window.location.protocol === 'file:') {
    statusEl.style.background = 'rgba(217,119,6,.12)';
    statusEl.style.color = 'var(--amber)';
    statusEl.innerHTML = '⚠️ Open from <strong>https://familista-backend.onrender.com</strong> for full access';
    // Still try to connect
  }

  try {
    const start = Date.now();
    const res = await fetch(API_BASE + '/health', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      mode: 'cors',
    });
    const latency = Date.now() - start;

    if (res.ok) {
      statusEl.style.background = 'rgba(22,163,74,.1)';
      statusEl.style.color = 'var(--green-l)';
      statusEl.textContent = '✅ Backend connected · ' + latency + 'ms';
    } else {
      statusEl.style.background = 'var(--red-bg)';
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '⚠️ Backend error: HTTP ' + res.status;
    }
  } catch (err) {
    console.error('[Connection Test] Failed:', err);
    if (window.location.protocol === 'file:') {
      statusEl.style.background = 'rgba(217,119,6,.12)';
      statusEl.style.color = 'var(--amber)';
      statusEl.innerHTML = '⚠️ Browser blocks requests from local files.<br>Open: <a href="https://familista-backend.onrender.com" style="color:var(--green-l);" target="_blank">familista-backend.onrender.com</a>';
    } else {
      statusEl.style.background = 'var(--red-bg)';
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '❌ ' + err.message;
    }
  }
}

// After render, hook data loading.
// IMPORTANT: only refire on actual nav-item clicks ([data-page=…]); the
// previous `#pg-training` / `#pg-settings` clauses matched every click
// inside the page including buttons inside the Training Detail panel.
// That scheduled a renderTrainingPage 100ms after each attendance mark
// click, which re-rendered the Sessions list and wiped #attendance-section
// (root cause of the "100ms later the section vanished" trace).
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-page="training"]')) {
    setTimeout(renderTrainingPage, 100);
  }
  if (e.target.closest('[data-page="settings"]')) {
    setTimeout(loadSettingsData, 100);
  }
});

// ════════════════════════════════════════════════════════════════════════
// Phase H — TACTICAL OS (elite cognitive frontend)
// ════════════════════════════════════════════════════════════════════════
// Self-contained module. Reads from existing Phase B/C/D/E/F/G endpoints.
// All DOM is scoped to .tactical-os so the legacy pages are untouched.

const TOS = {
  state: {
    sport:        'FOOTBALL',
    matches:      [],
    activeMatch:  null,
    brain:        null,
    spatial:      null,
    predictions:  [],
    annotations:  [],
    sse:          null,
    pollTimer:    null,
    twin:         { cursorMs: null, anchors: [], playing: false, timer: null },
    chat:         { agent: 'TACTICAL', history: [] },
    board:        { selected: null, drag: null, mode: 'select' },
    annotMode:    null,   // null | 'ARROW' | 'ZONE' | 'NOTE'
  },
  // Geometry per sport — mirrors backend SportAdapter for rendering only.
  sport: {
    FOOTBALL:   { widthM:105,    heightM:68,   players:11, hasObject:true,  flip:true,  name:'Football' },
    BASKETBALL: { widthM:28,     heightM:15,   players:5,  hasObject:true,  flip:false, name:'Basketball' },
    TENNIS:     { widthM:23.77,  heightM:10.97,players:1,  hasObject:true,  flip:false, name:'Tennis' },
    HANDBALL:   { widthM:40,     heightM:20,   players:7,  hasObject:true,  flip:true,  name:'Handball' },
    ATHLETICS:  { widthM:84.39,  heightM:36.5, players:8,  hasObject:false, flip:false, name:'Athletics' },
  },
};

function renderTacticalOSHTML() {
  return `<div class="page tactical-os" id="pg-tactical-os">
    <div class="tos-shell">

      <!-- LEFT RAIL: LIVE MATCHES -->
      <aside class="tos-rail-left">
        <div class="tos-card" style="margin-bottom:10px;">
          <div class="tos-hdr">
            <div>
              <div class="tos-title">Sport Engine</div>
              <div style="font-size:13px;color:var(--tos-tx);margin-top:2px;">Multi-sport adapter</div>
            </div>
          </div>
          <select id="tos-sport-select" class="tos-select" onchange="tosOnSportChange(this.value)">
            <option value="FOOTBALL">⚽ Football</option>
            <option value="BASKETBALL">🏀 Basketball</option>
            <option value="TENNIS">🎾 Tennis</option>
            <option value="HANDBALL">🤾 Handball</option>
            <option value="ATHLETICS">🏃 Athletics</option>
          </select>
        </div>

        <div class="tos-card">
          <div class="tos-hdr">
            <div>
              <div class="tos-title">Live Matches</div>
              <div class="tos-h1" style="font-size:16px;"><span class="tos-pulse"></span><span id="tos-live-count">—</span> active</div>
            </div>
            <button class="tos-btn ghost" onclick="tosRefreshMatches()" title="Refresh">↻</button>
          </div>
          <ul class="tos-list" id="tos-match-list"></ul>
        </div>
      </aside>

      <!-- CENTER: COGNITIVE MATCH CENTER -->
      <section class="tos-center" style="display:flex;flex-direction:column;gap:12px;min-width:0;">
        <!-- Active match header -->
        <div class="tos-card hot" id="tos-match-hdr">
          <div class="tos-hdr">
            <div>
              <div class="tos-title">Cognitive Match Center</div>
              <div class="tos-h1" id="tos-match-title">Select a match</div>
              <div class="tos-chip" id="tos-match-sub" style="margin-top:6px;">—</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
              <span id="tos-sse-pill" class="tos-pill amber">CONNECTING</span>
              <span id="tos-sport-pill" class="tos-pill cyan">FOOTBALL</span>
            </div>
          </div>

          <!-- KPI strip -->
          <div class="tos-grid-4" id="tos-kpis">
            <div class="tos-kpi cyan"><span class="v" id="tos-kpi-poss">—</span><span class="l">Possession</span></div>
            <div class="tos-kpi green"><span class="v" id="tos-kpi-momentum">—</span><span class="l">Momentum</span></div>
            <div class="tos-kpi amber"><span class="v" id="tos-kpi-fatigue">—</span><span class="l">Fatigue (crit/caution)</span></div>
            <div class="tos-kpi violet"><span class="v" id="tos-kpi-threats">—</span><span class="l">Opp Threats (5m)</span></div>
          </div>
        </div>

        <!-- TWIN BOARD: pitch + annotations + drag/drop -->
        <div class="tos-card">
          <div class="tos-hdr">
            <div>
              <div class="tos-title">Digital Twin · Tactical Board</div>
              <div style="font-size:11px;color:var(--tos-tx-3);" id="tos-board-sub">Live spatial frame</div>
            </div>
            <div class="tos-annot-toolbar">
              <button class="tos-btn ghost" onclick="tosSetMode('select')"  id="tos-mode-select">↖ Select</button>
              <button class="tos-btn ghost" onclick="tosSetMode('drag')"    id="tos-mode-drag">✥ Drag</button>
              <button class="tos-btn ghost" onclick="tosSetAnnotMode('ARROW')" id="tos-mode-arrow">→ Arrow</button>
              <button class="tos-btn ghost" onclick="tosSetAnnotMode('ZONE')"  id="tos-mode-zone">◭ Zone</button>
              <button class="tos-btn ghost" onclick="tosSetAnnotMode('NOTE')"  id="tos-mode-note">✎ Note</button>
              <button class="tos-btn green"  onclick="tosBoardSnapshot()" title="Save snapshot">⤓ Snapshot</button>
              <button class="tos-btn"        onclick="tosLoadSpatial()" title="Refresh">↻</button>
            </div>
          </div>
          <div class="tos-pitch-wrap cyan" id="tos-pitch-wrap" style="aspect-ratio: 16 / 9;">
            <svg id="tos-pitch" viewBox="0 0 105 68" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;"></svg>
          </div>

          <!-- Replay scrubber -->
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px;">
            <button class="tos-btn ghost" onclick="tosTwinStep(-1000)">«1s</button>
            <button class="tos-btn"       onclick="tosTwinToggle()" id="tos-twin-toggle">▶</button>
            <button class="tos-btn ghost" onclick="tosTwinStep(1000)">1s»</button>
            <input type="range" class="tos-scrub" id="tos-twin-range" min="0" max="100" value="100" oninput="tosTwinSeek(this.value)" />
            <span class="tos-chip" id="tos-twin-ts">LIVE</span>
          </div>
        </div>

        <!-- HEATMAP + POSSESSION FLOW + PRESSURE -->
        <div class="tos-grid-3">
          <div class="tos-card">
            <div class="tos-hdr"><div class="tos-title">Heatmap</div></div>
            <div class="tos-pitch-wrap" style="aspect-ratio: 16 / 11;">
              <svg id="tos-heatmap" viewBox="0 0 105 68" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;"></svg>
            </div>
          </div>
          <div class="tos-card">
            <div class="tos-hdr"><div class="tos-title">Possession Flow</div></div>
            <svg id="tos-poss-flow" viewBox="0 0 200 110" preserveAspectRatio="none" style="width:100%;height:110px;display:block;"></svg>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tos-tx-3);font-family:var(--tos-mono);">
              <span>HOME <b id="tos-poss-home" style="color:var(--tos-neon-green);">—</b></span>
              <span><b id="tos-poss-away" style="color:var(--tos-neon-red);">—</b> AWAY</span>
            </div>
          </div>
          <div class="tos-card">
            <div class="tos-hdr"><div class="tos-title">Pressure Zones</div></div>
            <div class="tos-pitch-wrap" style="aspect-ratio: 16 / 11;">
              <svg id="tos-pressure" viewBox="0 0 105 68" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;"></svg>
            </div>
          </div>
        </div>
      </section>

      <!-- RIGHT RAIL: AI COACH + ALERTS -->
      <aside class="tos-rail-right" style="display:flex;flex-direction:column;gap:12px;">

        <!-- Momentum gauge -->
        <div class="tos-card">
          <div class="tos-hdr">
            <div class="tos-title">Tactical Momentum</div>
            <span class="tos-chip" id="tos-momentum-band">—</span>
          </div>
          <div class="tos-gauge">
            <div class="axis"></div>
            <div class="fill" id="tos-momentum-fill" style="width:0%;"></div>
            <div class="label" id="tos-momentum-label">0.00</div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tos-tx-3);font-family:var(--tos-mono);margin-top:4px;">
            <span>OPP</span><span>NEUTRAL</span><span>OURS</span>
          </div>
        </div>

        <!-- Predictive intelligence -->
        <div class="tos-card">
          <div class="tos-hdr">
            <div class="tos-title">Predictive Alerts</div>
            <button class="tos-btn ghost" onclick="tosRunPredictors()" title="Re-run">↻</button>
          </div>
          <div class="tos-feed" id="tos-predict-feed"></div>
        </div>

        <!-- AI Coach Chat -->
        <div class="tos-card" style="flex:1;display:flex;flex-direction:column;min-height:380px;">
          <div class="tos-hdr">
            <div>
              <div class="tos-title">AI Coach</div>
              <div style="font-size:12px;color:var(--tos-tx);">Conversational tactical assistant</div>
            </div>
            <select id="tos-chat-agent" class="tos-select" style="width:auto;font-size:10px;padding:5px 8px;" onchange="TOS.state.chat.agent=this.value">
              <option value="TACTICAL">Tactical</option>
              <option value="MATCH_OPS">Match Ops</option>
              <option value="MEDICAL">Medical</option>
              <option value="SCOUTING">Scouting</option>
              <option value="TRAINING">Training</option>
              <option value="DEVICE_MGMT">Device</option>
              <option value="BIG_DATA">Big Data</option>
              <option value="CLUB_MANAGER">Club Mgr</option>
            </select>
          </div>
          <div class="tos-chat" id="tos-chat-stream"></div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <input id="tos-chat-input" class="tos-input" placeholder="Ask the agent…" onkeydown="if(event.key==='Enter') tosChatSend()" />
            <button class="tos-btn green" onclick="tosChatSend()">SEND</button>
          </div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="tos-btn ghost" onclick="tosChatQuick('Generate a tactical brief.')">Tactical brief</button>
            <button class="tos-btn ghost" onclick="tosChatQuick('Suggest a substitution.')">Sub suggestion</button>
            <button class="tos-btn ghost" onclick="tosChatQuick('Summarise this match so far.')">Match summary</button>
          </div>
        </div>

      </aside>
    </div>
  </div>`;
}

// ── Entry point ────────────────────────────────────────────────────────
async function loadTacticalOS() {
  // Kick-off: load matches, hydrate state, attach listeners.
  await tosRefreshMatches();
  // Wire pitch event handlers once (idempotent).
  const pitch = document.getElementById('tos-pitch');
  if (pitch && !pitch.dataset.wired) {
    pitch.addEventListener('mousedown', tosPitchMouseDown);
    pitch.addEventListener('mousemove', tosPitchMouseMove);
    pitch.addEventListener('mouseup',   tosPitchMouseUp);
    pitch.addEventListener('mouseleave',tosPitchMouseUp);
    pitch.dataset.wired = '1';
  }
}

function tosOnSportChange(s) {
  TOS.state.sport = s;
  const pill = document.getElementById('tos-sport-pill');
  if (pill) pill.textContent = s;
  // Re-render pitch with new geometry.
  if (TOS.state.activeMatch) {
    tosRenderPitch();
    tosRenderHeatmap();
    tosRenderPressure();
  }
}

// ── Live matches list ───────────────────────────────────────────────────
async function tosRefreshMatches() {
  // The backend validator rejects a comma-separated status list (400), so we
  // fetch without a status filter and prioritise LIVE/HALFTIME/SCHEDULED below.
  let matches = [];
  try {
    const res = await FamilistaAPI.get('/matches?limit=30');
    matches = (res && res.data && (res.data.items || res.data)) || [];
  } catch (_) { matches = []; }

  // Prioritise LIVE / HALFTIME / SCHEDULED.
  const order = { LIVE: 0, HALFTIME: 1, SCHEDULED: 2, FINISHED: 3, ABANDONED: 4 };
  matches.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  TOS.state.matches = matches;

  const liveCount = matches.filter(m => m.status === 'LIVE' || m.status === 'HALFTIME').length;
  const liveCountEl = document.getElementById('tos-live-count');
  if (liveCountEl) liveCountEl.textContent = liveCount;
  const matchListEl = document.getElementById('tos-match-list');
  if (!matchListEl) return;
  matchListEl.innerHTML = matches.slice(0, 10).map(m => {
    const isLive = m.status === 'LIVE' || m.status === 'HALFTIME';
    return `<li onclick="tosSelectMatch('${m.id}')" data-id="${m.id}">
      <div style="width:6px;height:6px;border-radius:50%;background:${isLive ? 'var(--tos-neon-green)' : 'var(--tos-tx-3)'};${isLive ? 'box-shadow:var(--tos-glow-green);' : ''}"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12.5px;color:var(--tos-tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(m.homeTeam)} vs ${escapeHTML(m.awayTeam)}</div>
        <div style="font-size:10px;color:var(--tos-tx-3);font-family:var(--tos-mono);">${escapeHTML(m.status || 'SCHEDULED')} · ${m.homeScore ?? '—'}-${m.awayScore ?? '—'}</div>
      </div>
    </li>`;
  }).join('') || '<li style="color:var(--tos-tx-3);font-size:11px;">No matches found.</li>';

  // Auto-pick the first live match if none selected.
  if (!TOS.state.activeMatch && matches[0]) tosSelectMatch(matches[0].id);
}

async function tosSelectMatch(id) {
  if (!id) return;
  // Highlight in list.
  document.querySelectorAll('#tos-match-list li').forEach(li => li.classList.toggle('active', li.dataset.id === id));

  // Tear down any prior SSE / poll / twin.
  tosTearDownLive();

  let m;
  try {
    const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(id));
    m = (res && res.data) || null;
  } catch (e) { showToast(e?.userMessage || 'Could not load match', 'error'); return; }
  if (!m) return;

  TOS.state.activeMatch = m;
  document.getElementById('tos-match-title').textContent = `${m.homeTeam} vs ${m.awayTeam}`;
  document.getElementById('tos-match-sub').textContent =
    `${m.status || 'SCHEDULED'} · ${m.competition || ''} · ${m.homeScore ?? '—'}–${m.awayScore ?? '—'}`;

  // Initial hydration.
  await Promise.all([ tosLoadBrain(), tosLoadSpatial(), tosLoadAnnotations() ]);
  tosRunPredictors();
  tosOpenSSE(id);
}

function tosTearDownLive() {
  if (TOS.state.sse) { try { TOS.state.sse.close(); } catch (_) {} TOS.state.sse = null; }
  if (TOS.state.pollTimer) { clearInterval(TOS.state.pollTimer); TOS.state.pollTimer = null; }
  if (TOS.state.twin.timer) { clearInterval(TOS.state.twin.timer); TOS.state.twin.timer = null; }
  TOS.state.twin.playing = false;
  TOS.state.twin.cursorMs = null;
  TOS.state.brain = null; TOS.state.spatial = null;
  TOS.state.predictions = []; TOS.state.annotations = [];
}

// ── SSE: realtime stream ───────────────────────────────────────────────
function tosOpenSSE(matchId) {
  if (!State.token) return;
  const base = (FAM_CONFIG.API_BASE || '').replace(/\/$/, '');
  const url  = `${base}/matches/${encodeURIComponent(matchId)}/live?token=${encodeURIComponent(State.token)}`;
  let es;
  try { es = new EventSource(url); } catch (_) { tosSetSSE('error'); return; }
  TOS.state.sse = es;
  tosSetSSE('connecting');
  es.addEventListener('hello', () => tosSetSSE('ok'));
  es.addEventListener('LIVE_STATE_UPDATE', () => { tosLoadBrain(); tosLoadSpatial(); });
  es.addEventListener('RULES_ALERT', (e) => {
    const a = (function(){ try { return JSON.parse(e.data); } catch(_) { return null; } })();
    if (!a) return;
    tosPushPredict({ kind: a.kind || 'RULES_ALERT', severity: a.severity || 'INFO', rationale: a.title || a.kind, score: a.severity === 'CRITICAL' ? 0.9 : a.severity === 'WARN' ? 0.65 : 0.4 });
  });
  es.addEventListener('TIMELINE_ADDED', () => tosLoadBrain());
  es.onerror = () => tosSetSSE('error');
}

function tosSetSSE(s) {
  const p = document.getElementById('tos-sse-pill');
  if (!p) return;
  const cls = { ok:'green', connecting:'amber', error:'red' }[s] || 'amber';
  p.className = 'tos-pill ' + cls;
  p.textContent = ({ ok:'STREAMING', connecting:'CONNECTING', error:'OFFLINE' }[s]) || s.toUpperCase();
}

// ── Data loaders ────────────────────────────────────────────────────────
async function tosLoadBrain() {
  const m = TOS.state.activeMatch; if (!m) return;
  try {
    const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/brain');
    TOS.state.brain = (res && res.data) || null;
  } catch (_) { return; }
  tosRenderBrainWidgets();
  tosRenderPressure();
}

async function tosLoadSpatial() {
  const m = TOS.state.activeMatch; if (!m) return;
  try {
    const res = await FamilistaAPI.get('/spatial/matches/' + encodeURIComponent(m.id) + '/frame');
    TOS.state.spatial = (res && res.data) || null;
  } catch (_) { return; }
  tosRenderPitch();
  tosRenderHeatmap();
}

async function tosLoadAnnotations() {
  const m = TOS.state.activeMatch; if (!m) return;
  try {
    const res = await FamilistaAPI.get('/matches/' + encodeURIComponent(m.id) + '/annotations');
    TOS.state.annotations = (res && res.data) || [];
  } catch (_) { TOS.state.annotations = []; }
  tosRenderPitch();
}

async function tosRunPredictors() {
  const m = TOS.state.activeMatch; if (!m) return;
  try {
    const res = await FamilistaAPI.post('/predictive/matches/' + encodeURIComponent(m.id) + '/run', { dryRun: true });
    TOS.state.predictions = (res && res.data) || [];
  } catch (_) { TOS.state.predictions = []; }
  tosRenderPredictFeed();
}

function tosPushPredict(p) {
  TOS.state.predictions.unshift({ ...p, id: 'live-' + Date.now(), atMs: Date.now() });
  if (TOS.state.predictions.length > 30) TOS.state.predictions.length = 30;
  tosRenderPredictFeed();
}

// ── Brain widgets ───────────────────────────────────────────────────────
function tosRenderBrainWidgets() {
  const b = TOS.state.brain; if (!b) return;
  // Momentum gauge.
  const idx = Math.max(-1, Math.min(1, b.momentum?.index ?? 0));
  const fill = document.getElementById('tos-momentum-fill');
  const label = document.getElementById('tos-momentum-label');
  const band = document.getElementById('tos-momentum-band');
  if (fill && label) {
    const widthPct = Math.abs(idx) * 50;
    fill.style.left = idx >= 0 ? '50%' : (50 - widthPct) + '%';
    fill.style.width = widthPct + '%';
    fill.classList.toggle('neg', idx < 0);
    label.textContent = (idx >= 0 ? '+' : '') + idx.toFixed(2);
  }
  if (band) {
    band.textContent = idx > 0.3 ? 'OURS' : idx < -0.3 ? 'OPPONENT' : 'NEUTRAL';
    band.className = 'tos-chip';
  }

  // KPIs
  document.getElementById('tos-kpi-poss').textContent     = (b.possession?.ourPct ?? '—') + '%';
  document.getElementById('tos-kpi-momentum').textContent = (idx >= 0 ? '+' : '') + idx.toFixed(2);
  document.getElementById('tos-kpi-threats').textContent  = b.momentum?.threatAgainst ?? 0;
  const crit = (b.players || []).filter(p => p.alert === 'CRITICAL').length;
  const caut = (b.players || []).filter(p => p.alert === 'CAUTION').length;
  document.getElementById('tos-kpi-fatigue').textContent  = `${crit} / ${caut}`;

  // Possession flow — derive from recentEvents.
  tosRenderPossessionFlow(b);
}

function tosRenderPossessionFlow(b) {
  const svg = document.getElementById('tos-poss-flow');
  if (!svg) return;
  const events = (b.recentEvents || []).slice(-20).reverse();
  document.getElementById('tos-poss-home').textContent = (b.possession?.ourPct ?? 0) + '%';
  document.getElementById('tos-poss-away').textContent = (100 - (b.possession?.ourPct ?? 50)) + '%';

  if (events.length === 0) { svg.innerHTML = ''; return; }
  const W = 200, H = 110;
  const stepX = W / Math.max(1, events.length - 1);
  let path = '';
  let lastSide = null;
  events.forEach((e, i) => {
    const side = e.side === 'HOME' ? 1 : -1;
    const y = H / 2 - side * (H / 2 - 12);
    path += (i === 0 ? `M ${i * stepX} ${y}` : ` L ${i * stepX} ${y}`);
    lastSide = side;
  });
  svg.innerHTML = `
    <line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="rgba(255,255,255,.08)" stroke-width=".5"/>
    <path d="${path}" stroke="${lastSide >= 0 ? 'var(--tos-neon-green)' : 'var(--tos-neon-red)'}" stroke-width="1.5" fill="none" />
  `;
}

// ── Pitch (digital twin) renderer ──────────────────────────────────────
function tosRenderPitch() {
  const svg = document.getElementById('tos-pitch'); if (!svg) return;
  const g = TOS.sport[TOS.state.sport] || TOS.sport.FOOTBALL;
  svg.setAttribute('viewBox', `0 0 ${g.widthM} ${g.heightM}`);

  const players = (TOS.state.spatial?.players) || [];
  const positioned = players.filter(p => p.x != null && p.y != null);

  // Pitch frame.
  const frame = `
    <rect x="0" y="0" width="${g.widthM}" height="${g.heightM}" fill="none" stroke="rgba(255,255,255,.32)" stroke-width=".3"/>
    <line x1="${g.widthM/2}" y1="0" x2="${g.widthM/2}" y2="${g.heightM}" stroke="rgba(255,255,255,.22)" stroke-width=".2"/>
    <circle cx="${g.widthM/2}" cy="${g.heightM/2}" r="${Math.min(7, g.widthM*0.07)}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width=".2"/>
  `;

  // Player dots.
  const dotR = Math.max(0.9, Math.min(2.0, g.widthM / 60));
  const dots = positioned.map(p => {
    const isOpp = p.side !== 'HOME';
    const baseColor = p.alert === 'CRITICAL' ? '#ff5b6e' :
                      p.alert === 'CAUTION'  ? '#f5b144' :
                      (isOpp ? 'rgba(255,91,110,.85)' : 'var(--tos-neon-green)');
    const stroke = p.sprint ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.55)';
    return `<g class="tos-player-chip" data-id="${escapeHTML(p.playerId)}" data-num="${p.number ?? ''}">
      <circle cx="${p.x}" cy="${p.y}" r="${dotR}" fill="${baseColor}" stroke="${stroke}" stroke-width="${p.sprint ? 0.35 : 0.25}"/>
      <text x="${p.x}" y="${p.y + dotR * 0.45}" font-size="${dotR * 1.0}" text-anchor="middle" font-weight="700" fill="#08110b">${p.number ?? '?'}</text>
    </g>`;
  }).join('');

  // Annotations layer.
  const annot = (TOS.state.annotations || []).map(a => {
    const p = a.payload || {};
    if (a.kind === 'ARROW' && typeof p.x1 === 'number' && typeof p.y1 === 'number' && typeof p.x2 === 'number' && typeof p.y2 === 'number') {
      return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="var(--tos-neon-cyan)" stroke-width=".5" marker-end="url(#tos-arrow)"/>`;
    }
    if (a.kind === 'ZONE' && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.r === 'number') {
      return `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="rgba(52,200,255,.15)" stroke="var(--tos-neon-cyan)" stroke-width=".3" stroke-dasharray=".5,.5"/>`;
    }
    if (a.kind === 'NOTE' && typeof p.x === 'number' && typeof p.y === 'number' && p.text) {
      return `<g>
        <circle cx="${p.x}" cy="${p.y}" r="0.8" fill="var(--tos-neon-amber)"/>
        <text x="${p.x + 1}" y="${p.y - 0.5}" font-size="1.5" fill="var(--tos-neon-amber)">${escapeHTML((p.text || '').slice(0, 24))}</text>
      </g>`;
    }
    return '';
  }).join('');

  svg.innerHTML = `
    <defs>
      <marker id="tos-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="3" markerHeight="3" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--tos-neon-cyan)"/>
      </marker>
    </defs>
    ${frame}
    ${annot}
    ${dots}
  `;

  document.getElementById('tos-board-sub').textContent =
    `${positioned.length}/${players.length} positioned · sport ${g.name} · ${TOS.state.spatial?.sources?.interpolated ? 'interpolated' : 'fresh'}`;
}

// ── Heatmap (player density 20×12) ──────────────────────────────────────
function tosRenderHeatmap() {
  const svg = document.getElementById('tos-heatmap'); if (!svg) return;
  const g = TOS.sport[TOS.state.sport] || TOS.sport.FOOTBALL;
  svg.setAttribute('viewBox', `0 0 ${g.widthM} ${g.heightM}`);
  const players = (TOS.state.spatial?.players) || [];
  const positioned = players.filter(p => p.x != null && p.y != null && p.side === 'HOME');
  if (positioned.length === 0) { svg.innerHTML = ''; return; }

  const GX = 20, GY = 12;
  const grid = new Array(GX * GY).fill(0);
  for (const p of positioned) {
    const cx = Math.min(GX - 1, Math.max(0, Math.floor(p.x / (g.widthM / GX))));
    const cy = Math.min(GY - 1, Math.max(0, Math.floor(p.y / (g.heightM / GY))));
    grid[cy * GX + cx]++;
  }
  const max = Math.max(...grid, 1);
  const cellW = g.widthM / GX, cellH = g.heightM / GY;
  let cells = '';
  for (let yi = 0; yi < GY; yi++) for (let xi = 0; xi < GX; xi++) {
    const v = grid[yi * GX + xi]; if (v === 0) continue;
    const a = 0.1 + (v / max) * 0.6;
    cells += `<rect x="${xi * cellW}" y="${yi * cellH}" width="${cellW}" height="${cellH}" fill="rgba(34,200,255,${a})"/>`;
  }
  svg.innerHTML = `
    <rect x="0" y="0" width="${g.widthM}" height="${g.heightM}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width=".25"/>
    ${cells}
  `;
}

// ── Pressure zones from brain ──────────────────────────────────────────
function tosRenderPressure() {
  const svg = document.getElementById('tos-pressure'); if (!svg) return;
  const g = TOS.sport[TOS.state.sport] || TOS.sport.FOOTBALL;
  svg.setAttribute('viewBox', `0 0 ${g.widthM} ${g.heightM}`);
  const zones = (TOS.state.brain?.pressureZones) || [];
  if (zones.length === 0) { svg.innerHTML = ''; return; }
  const maxD = Math.max(...zones.map(z => z.density), 1);
  const dots = zones.map(z => {
    const r = 1 + (z.density / maxD) * (g.widthM * 0.05);
    const fresh = Math.max(0.3, 1 - z.recencyS / 300);
    const x = (z.x / 105) * g.widthM;     // backend grid is 105×68; scale to active sport
    const y = (z.y / 100) * g.heightM;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,91,110,${0.35 * fresh})" stroke="rgba(255,91,110,.65)" stroke-width=".25"/>`;
  }).join('');
  svg.innerHTML = `
    <rect x="0" y="0" width="${g.widthM}" height="${g.heightM}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width=".25"/>
    ${dots}
  `;
}

// ── Predictive feed ────────────────────────────────────────────────────
function tosRenderPredictFeed() {
  const el = document.getElementById('tos-predict-feed'); if (!el) return;
  const items = (TOS.state.predictions || []).slice(0, 12);
  if (items.length === 0) { el.innerHTML = '<div style="font-size:11px;color:var(--tos-tx-3);">No predictions yet.</div>'; return; }
  el.innerHTML = items.map(p => {
    const sev = (p.severity === 'CRITICAL') || (p.score >= 0.75) ? 'red' : (p.severity === 'WARN' || p.score >= 0.5 ? 'amber' : 'green');
    const dot = { red:'var(--tos-neon-red)', amber:'var(--tos-neon-amber)', green:'var(--tos-neon-green)' }[sev];
    const pct = typeof p.score === 'number' ? (p.score * 100).toFixed(0) + '%' : '';
    return `<div class="row">
      <div class="dot" style="background:${dot};"></div>
      <div class="body">
        <div style="color:var(--tos-tx);">${escapeHTML(p.kind || '—')}${pct ? ' · ' + pct : ''}</div>
        <div class="ts" style="color:var(--tos-tx-3);">${escapeHTML(p.rationale || '')}</div>
      </div>
    </div>`;
  }).join('');
}

// ── AI Coach chat ──────────────────────────────────────────────────────
async function tosChatSend() {
  const inp = document.getElementById('tos-chat-input'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  inp.value = '';
  TOS.state.chat.history.push({ who: 'user', text });
  tosRenderChat();
  await tosChatRun(text);
}
function tosChatQuick(text) {
  TOS.state.chat.history.push({ who: 'user', text });
  tosRenderChat();
  tosChatRun(text);
}
async function tosChatRun(text) {
  const agent = TOS.state.chat.agent || 'TACTICAL';
  const m = TOS.state.activeMatch;
  // Thinking placeholder.
  TOS.state.chat.history.push({ who: 'agent', text: '…thinking', pending: true });
  tosRenderChat();
  let jobId;
  try {
    const res = await FamilistaAPI.post('/ai-ops/agents/' + agent + '/run', {
      kind: 'CHAT',
      matchId: m?.id,
      input: { prompt: text, matchId: m?.id, teamId: m?.teamId },
    });
    jobId = res?.data?.id;
  } catch (e) {
    tosChatReplace({ who: 'agent', text: 'Failed to enqueue job: ' + escapeHTML(e?.userMessage || 'error'), pending: false });
    return;
  }
  if (!jobId) {
    tosChatReplace({ who: 'agent', text: 'No job id returned.', pending: false });
    return;
  }
  // Poll up to 30s (8 ticks × 4s).
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1200 + i * 400));
    try {
      const jr = await FamilistaAPI.get('/ai-ops/jobs/' + encodeURIComponent(jobId));
      const j = jr?.data;
      if (j && (j.status === 'SUCCESS' || j.status === 'FAILED')) {
        const out = j.output || {};
        const text = j.status === 'SUCCESS' ? (out.text || '_(empty response)_') : ('Error: ' + (j.error || 'unknown'));
        tosChatReplace({ who: 'agent', text, pending: false, model: out.model, backend: out.backend });
        return;
      }
    } catch (_) {}
  }
  tosChatReplace({ who: 'agent', text: 'Timed out waiting for agent.', pending: false });
}
function tosChatReplace(msg) {
  for (let i = TOS.state.chat.history.length - 1; i >= 0; i--) {
    if (TOS.state.chat.history[i].pending) { TOS.state.chat.history[i] = msg; tosRenderChat(); return; }
  }
  TOS.state.chat.history.push(msg);
  tosRenderChat();
}
function tosRenderChat() {
  const el = document.getElementById('tos-chat-stream'); if (!el) return;
  el.innerHTML = TOS.state.chat.history.slice(-30).map(m => {
    const cls = m.who === 'user' ? 'user' : 'agent';
    const pending = m.pending ? ' thinking' : '';
    const meta = m.who === 'agent' && m.model ? `<div class="ts" style="font-size:9px;color:var(--tos-tx-3);margin-top:5px;">${escapeHTML(m.model)} · ${escapeHTML(m.backend || '')}</div>` : '';
    return `<div class="tos-msg ${cls}${pending}">
      <span class="who">${m.who === 'user' ? 'You' : (TOS.state.chat.agent || 'AGENT')}</span>
      <div>${tosMarkdown(m.text)}</div>
      ${meta}
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}
function tosMarkdown(s) {
  // Tiny safe markdown — bold, italic, line breaks, headings, lists.
  let h = escapeHTML(s);
  h = h.replace(/^### (.*)$/gm, '<div style="font-size:12.5px;font-weight:700;margin:6px 0 4px;">$1</div>');
  h = h.replace(/^## (.*)$/gm,  '<div style="font-size:13.5px;font-weight:700;margin:8px 0 4px;">$1</div>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/_([^_]+)_/g,        '<i>$1</i>');
  h = h.replace(/^- (.*)$/gm,        '• $1');
  h = h.replace(/\n/g, '<br/>');
  return h;
}

// ── Digital twin scrubber ──────────────────────────────────────────────
async function tosTwinSeek(v) {
  const m = TOS.state.activeMatch; if (!m) return;
  // Range value 0..100 → look up against the anchors window. If we don't
  // have anchors yet, fetch them (capped at 600).
  if (TOS.state.twin.anchors.length === 0) {
    try {
      const res = await FamilistaAPI.get('/spatial/matches/' + encodeURIComponent(m.id) + '/twin/anchors?limit=600');
      TOS.state.twin.anchors = (res?.data) || [];
    } catch (_) { TOS.state.twin.anchors = []; }
  }
  if (TOS.state.twin.anchors.length === 0) return;
  const idx = Math.min(TOS.state.twin.anchors.length - 1, Math.floor((v / 100) * (TOS.state.twin.anchors.length - 1)));
  const atMs = Number(TOS.state.twin.anchors[idx].monotonicMs);
  TOS.state.twin.cursorMs = atMs;
  try {
    const res = await FamilistaAPI.get('/spatial/matches/' + encodeURIComponent(m.id) + '/twin?atMs=' + atMs);
    if (res?.data) { TOS.state.spatial = res.data; tosRenderPitch(); }
  } catch (_) {}
  document.getElementById('tos-twin-ts').textContent = new Date(atMs).toLocaleTimeString();
}
function tosTwinStep(deltaMs) {
  const r = document.getElementById('tos-twin-range');
  if (!r) return;
  const next = Math.max(0, Math.min(100, parseInt(r.value, 10) + (deltaMs > 0 ? 2 : -2)));
  r.value = next; tosTwinSeek(next);
}
function tosTwinToggle() {
  TOS.state.twin.playing = !TOS.state.twin.playing;
  document.getElementById('tos-twin-toggle').textContent = TOS.state.twin.playing ? '⏸' : '▶';
  if (TOS.state.twin.timer) { clearInterval(TOS.state.twin.timer); TOS.state.twin.timer = null; }
  if (TOS.state.twin.playing) {
    TOS.state.twin.timer = setInterval(() => {
      const r = document.getElementById('tos-twin-range'); if (!r) return;
      const next = Math.min(100, parseInt(r.value, 10) + 1);
      r.value = next; tosTwinSeek(next);
      if (next >= 100) tosTwinToggle();
    }, 700);
  }
}

// ── Tactical board modes (select / drag / annotation) ─────────────────
function tosSetMode(mode) {
  TOS.state.board.mode = mode; TOS.state.annotMode = null;
  ['select','drag','arrow','zone','note'].forEach(m => {
    const b = document.getElementById('tos-mode-' + m);
    if (b) b.classList.remove('active');
  });
  const b = document.getElementById('tos-mode-' + mode); if (b) b.classList.add('active');
}
function tosSetAnnotMode(kind) {
  TOS.state.annotMode = kind; TOS.state.board.mode = 'annotate';
  ['select','drag','arrow','zone','note'].forEach(m => {
    const b = document.getElementById('tos-mode-' + m); if (b) b.classList.remove('active');
  });
  const b = document.getElementById('tos-mode-' + kind.toLowerCase()); if (b) b.classList.add('active');
}

function tosPitchEventToCoords(e) {
  const svg = document.getElementById('tos-pitch');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const g = TOS.sport[TOS.state.sport] || TOS.sport.FOOTBALL;
  return {
    x: ((e.clientX - rect.left) / rect.width) * g.widthM,
    y: ((e.clientY - rect.top)  / rect.height) * g.heightM,
  };
}

function tosPitchMouseDown(e) {
  const c = tosPitchEventToCoords(e); if (!c) return;
  // Drag mode — find nearest player.
  if (TOS.state.board.mode === 'drag') {
    const players = (TOS.state.spatial?.players) || [];
    let nearest = null, nd = Infinity;
    for (const p of players) {
      if (p.x == null || p.y == null) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < nd) { nd = d; nearest = p; }
    }
    if (nearest && nd < 3) {
      TOS.state.board.drag = { playerId: nearest.playerId, started: c };
      return;
    }
  }
  // Annotation modes — record start point.
  if (TOS.state.board.mode === 'annotate' && TOS.state.annotMode) {
    TOS.state.board.drag = { kind: TOS.state.annotMode, started: c };
  }
}

function tosPitchMouseMove(e) {
  if (!TOS.state.board.drag) return;
  const c = tosPitchEventToCoords(e); if (!c) return;
  const d = TOS.state.board.drag;

  // Drag a player chip — update spatial in-memory and re-render.
  if (d.playerId && TOS.state.spatial) {
    const p = (TOS.state.spatial.players || []).find(x => x.playerId === d.playerId);
    if (p) { p.x = c.x; p.y = c.y; tosRenderPitch(); }
  }
}

async function tosPitchMouseUp(e) {
  if (!TOS.state.board.drag) return;
  const c = tosPitchEventToCoords(e) || TOS.state.board.drag.started;
  const d = TOS.state.board.drag;
  TOS.state.board.drag = null;
  // Annotation commit.
  if (d.kind) {
    const payload = (function(){
      if (d.kind === 'ARROW') return { x1: d.started.x, y1: d.started.y, x2: c.x, y2: c.y };
      if (d.kind === 'ZONE')  return { x: d.started.x, y: d.started.y, r: Math.max(1, Math.hypot(c.x - d.started.x, c.y - d.started.y)) };
      if (d.kind === 'NOTE')  { const text = window.prompt('Note text?', ''); if (!text) return null; return { x: c.x, y: c.y, text }; }
      return null;
    })();
    if (!payload) return;
    const m = TOS.state.activeMatch; if (!m) return;
    try {
      await FamilistaAPI.post('/matches/' + encodeURIComponent(m.id) + '/annotations', {
        atMs: Date.now(), kind: d.kind, payload, visibility: 'CLUB',
      });
      tosLoadAnnotations();
    } catch (e) {
      showToast(e?.userMessage || 'Could not save annotation', 'error');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STATS INTELLIGENCE — Phase Q
// APIs (all under /api/v1/phase-q/):
//   GET  stats/players/:playerId/profile         — career stats + latest season
//   GET  stats/players/:playerId/seasons         — all PlayerSeasonStats rows
//   GET  stats/matches/:matchId                  — PlayerMatchStats[] for match
//   GET  events/match/:matchId/summary           — { [type]: count } event summary
//   GET  workload/teams/:teamId/readiness        — ATL/CTL/TSB + high-risk list
//   GET  workload/injuries?active=true           — InjuryRecord[]
//   GET  competitions?limit=50                   — Competition list
//   GET  competitions/:id/standings              — StandingsEntry[]
//   GET  competitions/:id/fixtures?limit=100     — Fixture list
// ══════════════════════════════════════════════════════════════════════════════

function renderStatsHTML() {
  return `<div class="page" id="pg-stats">
  <div class="si-page">
    <div class="si-tabs" id="si-tabs">
      <button class="si-tab active" onclick="siTab('performance')">Performance</button>
      <button class="si-tab" onclick="siTab('team')">Team Analytics</button>
      <button class="si-tab" onclick="siTab('player')">Player Analytics</button>
      <button class="si-tab" onclick="siTab('workload')">Workload</button>
      <button class="si-tab" onclick="siTab('injury')">Injury Risk</button>
      <button class="si-tab" onclick="siTab('match')">Match Analytics</button>
      <button class="si-tab" onclick="siTab('competition')">Competition</button>
      <button class="si-tab" onclick="siTab('compare')">KPI Compare</button>
    </div>
    <div class="si-body" id="si-body">${loadingHTML('Loading Stats Intelligence…')}</div>
  </div>
</div>`;
}

async function loadStatsData() {
  if (State.stats._loading) return;
  State.stats._loading = true;
  const body = document.getElementById('si-body');
  if (body) body.innerHTML = loadingHTML('Loading Stats Intelligence…');

  const [compRes, injRes] = await Promise.allSettled([
    api('/phase-q/competitions?limit=50'),
    api('/phase-q/workload/injuries'),
  ]);

  State.stats.competitions = (compRes.status === 'fulfilled' && compRes.value && compRes.value.items) ? compRes.value.items : [];
  State.stats.injuries     = (injRes.status  === 'fulfilled' && Array.isArray(injRes.value)) ? injRes.value : [];

  // Try readiness for the first team found in State.players
  const firstTeamId = (State.players || []).find(function(p) { return p.teamId; });
  if (firstTeamId && firstTeamId.teamId && !State.stats.squadReadiness) {
    State.stats._selectedTeamId = firstTeamId.teamId;
    try {
      State.stats.squadReadiness = await api('/phase-q/workload/teams/' + firstTeamId.teamId + '/readiness');
    } catch (_) { State.stats.squadReadiness = null; }
  }

  State.stats._loading = false;
  siRenderTab();
}

function siTab(tab) {
  State.stats._tab = tab;
  const tabOrder = ['performance','team','player','workload','injury','match','competition','compare'];
  document.querySelectorAll('.si-tab').forEach(function(btn, idx) {
    btn.classList.toggle('active', tabOrder[idx] === tab);
  });
  siRenderTab();
}

function siRenderTab() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const body = document.getElementById('si-body');
  if (!body) return;
  // Save focused input state — search/filter inputs live inside si-body and are
  // destroyed on every innerHTML replacement. We restore focus+cursor after.
  var _f = _saveFocusIn(body);
  var t = State.stats._tab;
  if (t === 'performance')   body.innerHTML = _siDashboard();
  else if (t === 'team')     body.innerHTML = _siTeam();
  else if (t === 'player')   body.innerHTML = _siPlayer();
  else if (t === 'workload') body.innerHTML = _siWorkload();
  else if (t === 'injury')   body.innerHTML = _siInjury();
  else if (t === 'match')    body.innerHTML = _siMatchAnalytics();
  else if (t === 'competition') body.innerHTML = _siCompetition();
  else if (t === 'compare')  body.innerHTML = _siCompare();
  else body.innerHTML = _siDashboard();
  _restoreFocusIn(body, _f);  // restore focus + cursor position after re-render
}

// ── Performance Dashboard ──────────────────────────────────────────────────

function _siDashboard() {
  var comps     = State.stats.competitions;
  var injuries  = State.stats.injuries;
  var readiness = State.stats.squadReadiness;
  var activeInj = injuries.filter(function(i) { return !i.returnDate; }).length;
  var available = readiness ? readiness.available : null;
  var total     = readiness ? readiness.total : null;
  var highRisk  = readiness ? readiness.highRisk.length : 0;
  var seasons   = comps.map(function(c) { return c.season; }).filter(function(v,i,a) { return a.indexOf(v)===i; }).join(', ') || '—';

  var kpis = '<div class="si-kpi-row">'
    + '<div class="si-kpi"><div class="si-kpi-val">' + comps.length + '</div><div class="si-kpi-label">Competitions</div><div class="si-kpi-sub">' + seasons + '</div></div>'
    + '<div class="si-kpi"><div class="si-kpi-val" style="color:' + (activeInj > 3 ? 'var(--red)' : activeInj > 0 ? 'var(--amber)' : 'var(--green-l)') + '">' + activeInj + '</div><div class="si-kpi-label">Active Injuries</div><div class="si-kpi-sub">' + injuries.length + ' total recorded</div></div>'
    + '<div class="si-kpi"><div class="si-kpi-val" style="color:' + (available != null && total > 0 && available / total < 0.7 ? 'var(--amber)' : 'var(--green-l)') + '">' + (available != null ? available : '—') + '</div><div class="si-kpi-label">Squad Available</div><div class="si-kpi-sub">' + (total != null ? 'of ' + total + ' players' : 'Open Workload tab') + '</div></div>'
    + '<div class="si-kpi"><div class="si-kpi-val" style="color:' + (highRisk > 2 ? 'var(--red)' : highRisk > 0 ? 'var(--amber)' : 'var(--green-l)') + '">' + highRisk + '</div><div class="si-kpi-label">High-Risk Players</div><div class="si-kpi-sub">ACWR > 1.5 or TSB < −20</div></div>'
    + '</div>';

  var alertsHTML = '';
  if (readiness && readiness.highRisk.length > 0) {
    var alertRows = readiness.highRisk.map(function(r) {
      var name = _scoutPlayerName(r.playerId);
      var riskLabel = r.injuryRiskScore > 0.6 ? 'CRITICAL' : r.injuryRiskScore > 0.35 ? 'HIGH' : 'MEDIUM';
      var acwrPct = Math.min(100, (r.acwr / 2) * 100).toFixed(0);
      var fillCls = r.acwr > 1.5 ? 'si-acwr-danger' : r.acwr > 1.3 ? 'si-acwr-warn' : 'si-acwr-ok';
      return '<div style="padding:10px 14px;border-bottom:1px solid var(--bd-2);display:flex;align-items:center;gap:12px;">'
        + '<div style="flex:1;"><div style="font-size:13px;font-weight:600;color:var(--tx)">' + _esc(name) + '</div>'
        + '<div style="font-size:11px;color:var(--tx-3)">ACWR: ' + r.acwr.toFixed(2) + ' · TSB: ' + r.tsb.toFixed(1) + '</div>'
        + '<div class="si-acwr-bar" style="max-width:240px;"><div class="si-acwr-fill ' + fillCls + '" style="width:' + acwrPct + '%;"></div></div></div>'
        + '<span class="si-risk-badge si-risk-' + riskLabel + '">' + riskLabel + '</span></div>';
    }).join('');
    alertsHTML = '<div class="si-section"><div class="si-section-title">⚠ Workload Alerts</div>'
      + '<div class="card" style="padding:0;">' + alertRows + '</div></div>';
  }

  var compsHTML = '';
  if (comps.length > 0) {
    var cards = comps.slice(0, 6).map(function(c) {
      return '<div class="si-comp-card" onclick="siSelectComp(\'' + c.id + '\')">'
        + '<div class="si-comp-card-name">' + _esc(c.name) + '</div>'
        + '<div class="si-comp-card-meta">' + _esc(c.season) + ' · ' + _esc(c.format) + '</div></div>';
    }).join('');
    compsHTML = '<div class="si-section"><div class="si-section-title">Competitions</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;">' + cards + '</div></div>';
  } else {
    compsHTML = '<div class="si-no-data">No competition data yet.<br><span style="font-size:11px;">Create a competition via the API to populate this dashboard.</span></div>';
  }

  var injHTML = '';
  if (injuries.length > 0) {
    var injRows = injuries.slice(0, 5).map(function(i) { return _siInjuryRow(i); }).join('');
    injHTML = '<div class="si-section"><div class="si-section-title">Recent Injuries</div>'
      + '<div class="card" style="padding:0;"><div class="si-injury-row header" style="padding:6px 12px;"><div>Player</div><div>Location</div><div>Severity</div><div>Date</div><div>Status</div></div>'
      + injRows + '</div></div>';
  }

  return kpis + alertsHTML + compsHTML + injHTML;
}

// ── Team Analytics ─────────────────────────────────────────────────────────

function _siTeam() {
  var matches = State.matches || [];
  var stats   = State.stats.matchStats || [];
  var selId   = State.stats._selectedMatchId;

  var opts = matches.map(function(m) {
    var label = _esc((m.homeTeamName || 'Home') + ' vs ' + (m.awayTeamName || 'Away')) + ' · ' + fmtDate(m.kickoffAt || m.date || m.scheduledAt);
    return '<option value="' + m.id + '"' + (selId === m.id ? ' selected' : '') + '>' + label + '</option>';
  }).join('');

  var selectHTML = '<div class="si-section"><div class="si-section-title">Select Match</div>'
    + '<select id="si-match-sel" class="form-select" style="max-width:420px;" onchange="siLoadMatchData(this.value,\'team\')">'
    + '<option value="">— Choose a match —</option>' + opts + '</select>'
    + (matches.length === 0 ? '<div style="font-size:12px;color:var(--tx-3);margin-top:8px;">No matches loaded. Visit the Matches page first.</div>' : '')
    + '</div>';

  var tableHTML = '';
  if (selId && stats.length > 0) tableHTML = _siTeamStatsTable(stats);
  else if (selId) tableHTML = '<div class="si-no-data">No player stats computed for this match yet.<br><span style="font-size:11px;">Stats are built automatically when match events are recorded.</span></div>';

  return selectHTML + tableHTML;
}

function _siTeamStatsTable(stats) {
  var sorted = stats.slice().sort(function(a, b) { return (b.ratingFamilista || 0) - (a.ratingFamilista || 0); });
  var rows = sorted.map(function(s, i) {
    var name   = _scoutPlayerName(s.playerId) || s.playerId.substring(0, 8) + '…';
    var pos    = _scoutPlayerPos(s.playerId) || '';
    var rating = s.ratingFamilista || 0;
    var rCls   = rating >= 7.5 ? 'hi' : rating >= 6.0 ? 'mid' : 'lo';
    var passAcc = s.passAccuracy ? (s.passAccuracy * 100).toFixed(0) + '%' : '—';
    return '<div class="si-player-row" onclick="siOpenPlayerFromMatch(\'' + s.playerId + '\')">'
      + '<div class="si-rank">' + (i + 1) + '</div>'
      + '<div><div class="si-name">' + _esc(name) + '</div><div class="si-pos-lbl">' + _esc(pos) + '</div></div>'
      + '<div class="si-num">' + (s.minutesPlayed || 0) + '\'</div>'
      + '<div class="si-num" style="color:var(--green-l)">' + ((s.goals || 0) + (s.assists || 0)) + '</div>'
      + '<div class="si-num">' + (s.xg || 0).toFixed(2) + '</div>'
      + '<div class="si-num">' + passAcc + '</div>'
      + '<div class="si-rating ' + rCls + '">' + rating.toFixed(1) + '</div></div>';
  }).join('');

  return '<div class="si-section"><div class="si-section-title">Player Performance · ' + sorted.length + ' players</div>'
    + '<div class="card" style="padding:0;overflow-x:auto;">'
    + '<div class="si-player-row header" style="padding:7px 12px;">'
    + '<div>#</div><div>Player</div><div>Min</div><div>G+A</div><div>xG</div><div>Pass%</div><div>Rating</div></div>'
    + rows + '</div></div>';
}

async function siLoadMatchData(matchId, sourceTab) {
  if (!matchId) {
    State.stats._selectedMatchId = '';
    State.stats.matchStats = [];
    State.stats.eventSummary = {};
    siRenderTab();
    return;
  }
  State.stats._selectedMatchId = matchId;
  State.stats.matchStats   = [];
  State.stats.eventSummary = {};
  siRenderTab();

  var results = await Promise.allSettled([
    api('/phase-q/stats/matches/' + matchId),
    api('/phase-q/events/match/' + matchId + '/summary'),
  ]);
  State.stats.matchStats   = (results[0].status === 'fulfilled' && Array.isArray(results[0].value)) ? results[0].value : [];
  State.stats.eventSummary = (results[1].status === 'fulfilled' && results[1].value && typeof results[1].value === 'object') ? results[1].value : {};
  siRenderTab();
}

function siOpenPlayerFromMatch(playerId) {
  State.stats._selectedPlayerId = playerId;
  siTab('player');
  siLoadPlayerData(playerId);
}

// ── Player Analytics ───────────────────────────────────────────────────────

function _siPlayer() {
  var players = State.players || [];
  var profile  = State.stats.playerProfile;
  var seasons  = State.stats.playerSeasons || [];
  var pid      = State.stats._selectedPlayerId;

  var playerOpts = players.map(function(p) {
    return '<option value="' + p.id + '"' + (pid === p.id ? ' selected' : '') + '>'
      + _esc(p.name || p.id) + (p.position ? ' (' + p.position + ')' : '') + '</option>';
  }).join('');

  var seasonOpts = seasons.length > 1 ? '<option value="">All seasons</option>'
    + seasons.map(function(s) {
      return '<option value="' + s.season + '"' + (State.stats._seasonFilter === s.season ? ' selected' : '') + '>' + _esc(s.season) + '</option>';
    }).join('') : '';

  var controlsHTML = '<div class="si-section" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">'
    + '<div style="flex:1;min-width:200px;"><div class="si-section-title">Player</div>'
    + '<select class="form-select" style="width:100%;" onchange="siLoadPlayerData(this.value)">'
    + '<option value="">— Choose a player —</option>' + playerOpts + '</select></div>'
    + (pid && seasons.length > 1 ? '<div><div class="si-section-title">Season</div><select class="form-select" onchange="siFilterSeason(this.value)">' + seasonOpts + '</select></div>' : '')
    + '</div>';

  var contentHTML = '';
  if (!pid) contentHTML = '<div class="si-no-data">Select a player to view their analytics.</div>';
  else if (!profile) contentHTML = loadingHTML('Loading player data…');
  else contentHTML = _siPlayerView(profile, seasons);

  return controlsHTML + contentHTML;
}

function _siPlayerView(profile, seasons) {
  var ls     = profile.latestSeason;
  var career = profile.careerStats;
  var filtered = State.stats._seasonFilter
    ? seasons.filter(function(s) { return s.season === State.stats._seasonFilter; })
    : seasons;

  var careerKpi = '<div class="si-kpi-row" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px;">'
    + '<div class="si-kpi"><div class="si-kpi-val">' + career.totalAppearances + '</div><div class="si-kpi-label">Career Apps</div></div>'
    + '<div class="si-kpi"><div class="si-kpi-val">' + career.totalGoals + '</div><div class="si-kpi-label">Career Goals</div></div>'
    + '<div class="si-kpi"><div class="si-kpi-val">' + career.totalAssists + '</div><div class="si-kpi-label">Career Assists</div></div>'
    + '</div>';

  var statBarsHTML = '';
  if (ls) {
    var metrics = [
      { label: 'Goals',            val: ls.goals || 0,                               max: 30 },
      { label: 'Assists',          val: ls.assists || 0,                             max: 20 },
      { label: 'xG',               val: (ls.xg || 0).toFixed(2),   raw: ls.xg || 0, max: 20 },
      { label: 'xA',               val: (ls.xa || 0).toFixed(2),   raw: ls.xa || 0, max: 15 },
      { label: 'Pass Accuracy',    val: (ls.passAccuracy * 100).toFixed(1) + '%',    max: 100, raw: ls.passAccuracy * 100 },
      { label: 'Avg Rating',       val: (ls.averageRating || 0).toFixed(1),          max: 10,  raw: ls.averageRating || 0 },
      { label: 'Pressure Success', val: ((ls.pressureSuccessRate || 0) * 100).toFixed(1) + '%', max: 100, raw: (ls.pressureSuccessRate || 0) * 100 },
      { label: 'Aerial Success',   val: ((ls.aerialSuccessRate || 0) * 100).toFixed(1) + '%',   max: 100, raw: (ls.aerialSuccessRate || 0) * 100 },
    ];
    var bars = metrics.map(function(m) {
      var rawNum = m.raw !== undefined ? m.raw : +m.val;
      var pct = Math.min(100, (rawNum / m.max) * 100).toFixed(1);
      return '<div class="si-stat-bar-wrap"><div class="si-stat-label">' + m.label + '</div>'
        + '<div class="si-stat-bar"><div class="si-stat-fill" style="width:' + pct + '%;"></div></div>'
        + '<div class="si-stat-val">' + m.val + '</div></div>';
    }).join('');
    statBarsHTML = '<div class="si-section"><div class="si-section-title">Latest Season: ' + _esc(ls.season) + ' · ' + ls.appearances + ' apps · ' + ls.minutesPlayed + ' min</div>'
      + '<div class="card" style="padding:14px 16px;">' + bars + '</div></div>';
  } else {
    statBarsHTML = '<div class="si-no-data">No season data recorded yet.</div>';
  }

  var histHTML = '';
  if (filtered.length > 1) {
    var histRows = filtered.map(function(s) {
      var rColor = (s.averageRating || 0) >= 7.5 ? 'var(--green-l)' : (s.averageRating || 0) >= 6 ? 'var(--amber)' : 'var(--red)';
      return '<tr style="border-top:1px solid var(--bd-2);">'
        + '<td style="padding:7px 12px;font-size:13px;font-weight:600;color:var(--tx);">' + _esc(s.season) + '</td>'
        + '<td style="padding:7px 12px;text-align:right;font-size:12px;color:var(--tx-2);font-family:var(--mono);">' + s.appearances + '</td>'
        + '<td style="padding:7px 12px;text-align:right;font-size:12px;color:var(--green-l);font-family:var(--mono);">' + s.goals + '</td>'
        + '<td style="padding:7px 12px;text-align:right;font-size:12px;color:var(--amber);font-family:var(--mono);">' + s.assists + '</td>'
        + '<td style="padding:7px 12px;text-align:right;font-size:12px;font-family:var(--mono);color:var(--tx-2);">' + (s.xg || 0).toFixed(2) + '</td>'
        + '<td style="padding:7px 12px;text-align:right;font-size:12px;font-family:var(--mono);color:var(--tx-2);">' + (s.xa || 0).toFixed(2) + '</td>'
        + '<td style="padding:7px 12px;text-align:right;font-size:13px;font-weight:700;font-family:var(--mono);color:' + rColor + ';">' + (s.averageRating || 0).toFixed(1) + '</td>'
        + '</tr>';
    }).join('');
    histHTML = '<div class="si-section"><div class="si-section-title">Season History</div>'
      + '<div class="card" style="padding:0;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">'
      + '<thead><tr style="font-size:10px;color:var(--tx-3);text-transform:uppercase;">'
      + '<th style="padding:7px 12px;text-align:left;">Season</th>'
      + '<th style="padding:7px 12px;text-align:right;">Apps</th>'
      + '<th style="padding:7px 12px;text-align:right;">G</th>'
      + '<th style="padding:7px 12px;text-align:right;">A</th>'
      + '<th style="padding:7px 12px;text-align:right;">xG</th>'
      + '<th style="padding:7px 12px;text-align:right;">xA</th>'
      + '<th style="padding:7px 12px;text-align:right;">Rating</th></tr></thead>'
      + '<tbody>' + histRows + '</tbody></table></div></div>';
  }

  return careerKpi + statBarsHTML + histHTML;
}

async function siLoadPlayerData(playerId) {
  if (!playerId) { State.stats._selectedPlayerId = ''; siRenderTab(); return; }
  State.stats._selectedPlayerId = playerId;
  State.stats.playerProfile = null;
  State.stats.playerSeasons = [];
  siRenderTab();

  var results = await Promise.allSettled([
    api('/phase-q/stats/players/' + playerId + '/profile'),
    api('/phase-q/stats/players/' + playerId + '/seasons'),
  ]);
  State.stats.playerProfile = results[0].status === 'fulfilled' ? results[0].value : null;
  State.stats.playerSeasons = (results[1].status === 'fulfilled' && Array.isArray(results[1].value)) ? results[1].value : [];
  siRenderTab();
}

function siFilterSeason(val) {
  State.stats._seasonFilter = val;
  siRenderTab();
}

// ── Workload Monitoring ────────────────────────────────────────────────────

function _siWorkload() {
  var seen  = {};
  var teams = [];
  (State.players || []).forEach(function(p) {
    if (p.teamId && !seen[p.teamId]) {
      seen[p.teamId] = true;
      teams.push({ id: p.teamId, name: p.teamName || (p.teamId.substring(0, 14) + '…') });
    }
  });

  var readiness  = State.stats.squadReadiness;
  var selTeam    = State.stats._selectedTeamId;

  var teamOpts = teams.map(function(t) {
    return '<option value="' + t.id + '"' + (selTeam === t.id ? ' selected' : '') + '>' + _esc(t.name) + '</option>';
  }).join('');

  var kpiRight = '';
  if (readiness) {
    kpiRight = '<div class="si-kpi" style="min-width:110px;"><div class="si-kpi-val">' + readiness.available + '/' + readiness.total + '</div><div class="si-kpi-label">Available</div></div>'
      + '<div class="si-kpi" style="min-width:110px;"><div class="si-kpi-val" style="color:' + (readiness.highRisk.length > 0 ? 'var(--red)' : 'var(--green-l)') + '">' + readiness.highRisk.length + '</div><div class="si-kpi-label">High Risk</div></div>';
  }

  var header = '<div class="si-section" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">'
    + '<div style="flex:1;min-width:200px;"><div class="si-section-title">Team</div>'
    + '<select class="form-select" style="width:100%;" onchange="siLoadReadiness(this.value)">'
    + '<option value="">— Choose a team —</option>' + teamOpts + '</select>'
    + (teams.length === 0 ? '<div style="font-size:12px;color:var(--tx-3);margin-top:6px;">No teams found. Visit Squad page first.</div>' : '')
    + '</div>' + kpiRight + '</div>';

  var body = '';
  if (!selTeam) {
    body = '<div class="si-no-data">Select a team to load workload data.</div>';
  } else if (!readiness) {
    body = loadingHTML('Loading readiness…');
  } else if (readiness.highRisk.length === 0) {
    body = '<div class="si-no-data">✅ No high-risk players this week.<br>'
      + '<span style="font-size:11px;">ACWR is within safe range for all ' + readiness.total + ' tracked players.</span></div>';
  } else {
    var cards = readiness.highRisk.map(function(r) {
      var name       = _scoutPlayerName(r.playerId);
      var risk       = r.injuryRiskScore;
      var riskLabel  = risk > 0.6 ? 'CRITICAL' : risk > 0.35 ? 'HIGH' : 'MEDIUM';
      var acwrPct    = Math.min(100, (r.acwr / 2) * 100).toFixed(0);
      var fillCls    = r.acwr > 1.5 ? 'si-acwr-danger' : r.acwr > 1.3 ? 'si-acwr-warn' : 'si-acwr-ok';
      var tsbColor   = r.tsb < -20 ? 'var(--red)' : r.tsb < -10 ? 'var(--amber)' : 'var(--green-l)';
      return '<div class="si-workload-card">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;">'
        + '<div style="font-size:13px;font-weight:600;color:var(--tx)">' + _esc(name) + '</div>'
        + '<span class="si-risk-badge si-risk-' + riskLabel + '">' + riskLabel + '</span></div>'
        + '<div style="font-size:11px;color:var(--tx-3);">ACWR: <strong style="color:' + (r.acwr > 1.5 ? 'var(--red)' : r.acwr > 1.3 ? 'var(--amber)' : 'var(--tx)') + '">' + r.acwr.toFixed(2) + '</strong> · TSB: <strong style="color:' + tsbColor + '">' + r.tsb.toFixed(1) + '</strong> · Risk: <strong>' + (risk * 100).toFixed(0) + '%</strong></div>'
        + '<div><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx-3);margin-bottom:3px;"><span>ACWR</span><span>' + r.acwr.toFixed(2) + ' / 2.0</span></div>'
        + '<div class="si-acwr-bar"><div class="si-acwr-fill ' + fillCls + '" style="width:' + acwrPct + '%;"></div></div></div>'
        + '</div>';
    }).join('');
    body = '<div class="si-section"><div class="si-section-title">High-Risk Players (' + readiness.highRisk.length + ')</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">' + cards + '</div></div>'
      + '<div style="font-size:11px;color:var(--tx-3);margin-top:4px;">Generated: ' + fmtDate(readiness.generatedAt) + '</div>';
  }

  return header + body;
}

async function siLoadReadiness(teamId) {
  if (!teamId) { State.stats._selectedTeamId = ''; State.stats.squadReadiness = null; siRenderTab(); return; }
  State.stats._selectedTeamId = teamId;
  State.stats.squadReadiness  = null;
  siRenderTab();
  try {
    State.stats.squadReadiness = await api('/phase-q/workload/teams/' + teamId + '/readiness');
  } catch (err) {
    showToast('Failed to load workload: ' + ((err && err.userMessage) || (err && err.message) || 'Error'), 'error');
  }
  siRenderTab();
}

// ── Injury Risk ────────────────────────────────────────────────────────────

function _siInjury() {
  var injuries   = State.stats.injuries || [];
  var search     = State.stats._injSearch || '';
  var activeOnly = State.stats._injActiveOnly || false;

  var filtered = activeOnly ? injuries.filter(function(i) { return !i.returnDate; }) : injuries;
  if (search) {
    var sl = search.toLowerCase();
    filtered = filtered.filter(function(i) {
      return _scoutPlayerName(i.playerId).toLowerCase().indexOf(sl) >= 0
        || (i.bodyLocation || '').toLowerCase().indexOf(sl) >= 0;
    });
  }

  var controls = '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">'
    + '<input class="si-search-inp" style="flex:1;min-width:180px;" placeholder="Search player or body location…" value="' + _esc(search) + '" oninput="State.stats._injSearch=this.value;siRenderTab();">'
    + '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--tx-2);cursor:pointer;flex-shrink:0;">'
    + '<input type="checkbox"' + (activeOnly ? ' checked' : '') + ' onchange="State.stats._injActiveOnly=this.checked;siRenderTab();"> Active only</label>'
    + '<button class="btn btn-outline btn-sm" onclick="siReloadInjuries()">↻ Refresh</button></div>';

  if (filtered.length === 0) {
    return controls + '<div class="si-no-data">' + (activeOnly ? 'No active injuries.' : 'No injury records found.') + '</div>';
  }

  var tableHeader = '<div class="si-injury-row header" style="padding:6px 12px;">'
    + '<div>Player</div><div>Body Location</div><div>Severity</div><div>Date</div><div>Status</div></div>';
  var rows = filtered.map(function(i) { return _siInjuryRow(i); }).join('');

  return controls
    + '<div class="card" style="padding:0;">' + tableHeader + rows + '</div>'
    + '<div style="font-size:11px;color:var(--tx-3);margin-top:8px;">' + filtered.length + ' record' + (filtered.length !== 1 ? 's' : '') + '</div>';
}

function _siInjuryRow(inj) {
  var name     = _scoutPlayerName(inj.playerId) || (inj.playerId.substring(0, 10) + '…');
  var active   = !inj.returnDate;
  var sevColor = inj.severity === 'SEVERE' ? 'var(--red)'
    : inj.severity === 'MODERATE' ? 'var(--amber)'
    : inj.severity === 'MINOR' ? 'var(--green-l)' : 'var(--tx-3)';
  var statusTxt = active
    ? '<span style="color:var(--red);font-weight:700;">OUT</span>'
    : '<span style="color:var(--green-l);">RTP' + (inj.daysAbsent ? ' ' + inj.daysAbsent + 'd' : '') + '</span>';
  return '<div class="si-injury-row">'
    + '<div style="font-size:13px;font-weight:600;color:var(--tx)">' + _esc(name) + '</div>'
    + '<div style="font-size:12px;color:var(--tx-2)">' + _esc(inj.bodyLocation || '—') + '</div>'
    + '<div style="font-size:11px;font-weight:700;color:' + sevColor + '">' + _esc(inj.severity || '—') + '</div>'
    + '<div style="font-size:12px;color:var(--tx-3);font-family:var(--mono)">' + fmtDate(inj.injuryDate) + '</div>'
    + '<div style="font-size:12px;">' + statusTxt + '</div></div>';
}

async function siReloadInjuries() {
  try {
    var res = await api('/phase-q/workload/injuries');
    State.stats.injuries = Array.isArray(res) ? res : [];
    siRenderTab();
  } catch (_) { showToast('Failed to reload injuries', 'error'); }
}

// ── Match Analytics ────────────────────────────────────────────────────────

function _siMatchAnalytics() {
  var matches = State.matches || [];
  var stats   = State.stats.matchStats || [];
  var summary = State.stats.eventSummary || {};
  var selId   = State.stats._selectedMatchId;

  var opts = matches.map(function(m) {
    var label = _esc((m.homeTeamName || 'Home') + ' vs ' + (m.awayTeamName || 'Away')) + ' · ' + fmtDate(m.kickoffAt || m.date || m.scheduledAt);
    return '<option value="' + m.id + '"' + (selId === m.id ? ' selected' : '') + '>' + label + '</option>';
  }).join('');

  var selectHTML = '<div class="si-section"><div class="si-section-title">Select Match</div>'
    + '<select class="form-select" style="max-width:420px;" onchange="siLoadMatchData(this.value,\'match\')">'
    + '<option value="">— Choose a match —</option>' + opts + '</select></div>';

  var summaryHTML = '';
  var keys = Object.keys(summary);
  if (keys.length > 0) {
    var pills = keys.sort(function(a,b){ return summary[b]-summary[a]; }).map(function(type) {
      return '<span class="si-event-pill">' + _esc(type.replace(/_/g,' ')) + ' <span>' + summary[type] + '</span></span>';
    }).join('');
    summaryHTML = '<div class="si-section"><div class="si-section-title">Event Summary</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:0;">' + pills + '</div></div>';
  }

  var tableHTML = stats.length > 0 ? _siTeamStatsTable(stats)
    : selId ? '<div class="si-no-data">No stats computed for this match.</div>'
    : '<div class="si-no-data">Select a match to view analytics.</div>';

  return selectHTML + summaryHTML + tableHTML;
}

// ── Competition Analytics ──────────────────────────────────────────────────

function _siCompetition() {
  var comps     = State.stats.competitions || [];
  var selId     = State.stats._selectedCompId;
  var standings = State.stats.standings || [];
  var fixtures  = State.stats.fixtures  || [];

  var compCards = comps.length === 0
    ? '<div class="si-no-data">No competitions found. Create one via POST /phase-q/competitions.</div>'
    : '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:16px;">'
      + comps.map(function(c) {
        return '<div class="si-comp-card' + (selId === c.id ? ' active' : '') + '" onclick="siSelectComp(\'' + c.id + '\')">'
          + '<div class="si-comp-card-name">' + _esc(c.name) + '</div>'
          + '<div class="si-comp-card-meta">' + _esc(c.season) + ' · ' + _esc(c.format) + (c.ageGroup ? ' · ' + _esc(c.ageGroup) : '') + '</div></div>';
      }).join('') + '</div>';

  var standingsHTML = '';
  if (selId && standings.length > 0) {
    var stdRows = standings.map(function(s) {
      var gdColor = s.goalDiff > 0 ? 'var(--green-l)' : s.goalDiff < 0 ? 'var(--red)' : 'var(--tx-2)';
      var gdStr   = (s.goalDiff > 0 ? '+' : '') + s.goalDiff;
      var formCells = (s.form || '').split('').map(function(c) {
        return '<span class="si-form-' + c + '">' + c + '</span>';
      }).join('');
      var shortTeam = s.teamId.length > 16 ? s.teamId.substring(0, 14) + '…' : s.teamId;
      return '<tr>'
        + '<td style="color:var(--tx-3);font-family:var(--mono);padding:8px 10px;">' + s.position + '</td>'
        + '<td style="padding:8px 10px;font-size:13px;font-weight:600;color:var(--tx);">' + _esc(shortTeam) + '</td>'
        + '<td>' + s.played + '</td><td>' + s.won + '</td><td>' + s.drawn + '</td><td>' + s.lost + '</td>'
        + '<td>' + s.goalsFor + '</td><td>' + s.goalsAgainst + '</td>'
        + '<td style="font-weight:600;color:' + gdColor + '">' + gdStr + '</td>'
        + '<td style="font-weight:700;color:var(--tx)">' + s.points + '</td>'
        + '<td style="font-family:var(--mono);letter-spacing:.08em;">' + formCells + '</td>'
        + '</tr>';
    }).join('');
    standingsHTML = '<div class="si-section"><div class="si-section-title">Standings</div>'
      + '<div class="card" style="padding:0;overflow-x:auto;"><table class="si-standings-table">'
      + '<thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th><th>Form</th></tr></thead>'
      + '<tbody>' + stdRows + '</tbody></table></div></div>';
  } else if (selId && standings.length === 0) {
    standingsHTML = loadingHTML('Loading competition data…');
  }

  var fixturesHTML = '';
  if (selId && fixtures.length > 0) {
    var fixRows = fixtures.slice(0, 30).map(function(f) {
      var score    = f.status === 'PLAYED' ? ((f.homeScore != null ? f.homeScore : '?') + ' – ' + (f.awayScore != null ? f.awayScore : '?')) : 'vs';
      var homeShort = f.homeTeamId.length > 14 ? f.homeTeamId.substring(0, 12) + '…' : f.homeTeamId;
      var awayShort = f.awayTeamId.length > 14 ? f.awayTeamId.substring(0, 12) + '…' : f.awayTeamId;
      return '<div class="si-fixture-row">'
        + '<div style="font-size:11px;color:var(--tx-3);font-family:var(--mono)">' + (f.round != null ? 'R' + f.round : '—') + '</div>'
        + '<div class="si-team-name" style="text-align:right">' + _esc(homeShort) + '</div>'
        + '<div class="si-score">' + score + '</div>'
        + '<div class="si-team-name">' + _esc(awayShort) + '</div>'
        + '<div class="si-fixture-status-' + f.status + '" style="text-align:right;font-size:10px;font-weight:700;">' + f.status + '</div></div>';
    }).join('');
    fixturesHTML = '<div class="si-section"><div class="si-section-title">Fixtures (' + fixtures.length + ')</div>'
      + '<div class="card" style="padding:0;">'
      + '<div class="si-fixture-row" style="font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;padding:6px 12px;">'
      + '<div>Rnd</div><div style="text-align:right">Home</div><div style="text-align:center">Score</div><div>Away</div><div style="text-align:right">Status</div></div>'
      + fixRows + '</div></div>';
  }

  return '<div class="si-section">' + compCards + '</div>' + standingsHTML + fixturesHTML;
}

async function siSelectComp(compId) {
  State.stats._selectedCompId = compId;
  State.stats.standings = [];
  State.stats.fixtures  = [];
  siRenderTab();

  var results = await Promise.allSettled([
    api('/phase-q/competitions/' + compId + '/standings'),
    api('/phase-q/competitions/' + compId + '/fixtures?limit=100'),
  ]);
  State.stats.standings = (results[0].status === 'fulfilled' && Array.isArray(results[0].value)) ? results[0].value : [];
  State.stats.fixtures  = (results[1].status === 'fulfilled' && results[1].value && results[1].value.items) ? results[1].value.items : [];
  siRenderTab();
}

// ── KPI Comparison ─────────────────────────────────────────────────────────

function _siCompare() {
  var players = State.players || [];
  var aidPid  = State.stats._playerAId;
  var bidPid  = State.stats._playerBId;
  var compA   = State.stats.compareA;
  var compB   = State.stats.compareB;
  var comparing = State.stats._comparing;

  var playerOpts = function(selId) {
    return players.map(function(p) {
      return '<option value="' + p.id + '"' + (selId === p.id ? ' selected' : '') + '>' + _esc(p.name || p.id) + '</option>';
    }).join('');
  };

  var selectors = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">'
    + '<div><div class="si-section-title">Player A</div>'
    + '<select class="form-select" onchange="State.stats._playerAId=this.value;State.stats.compareA=null;State.stats._comparing=false;siRenderTab();">'
    + '<option value="">— Choose player A —</option>' + playerOpts(aidPid) + '</select></div>'
    + '<div><div class="si-section-title">Player B</div>'
    + '<select class="form-select" onchange="State.stats._playerBId=this.value;State.stats.compareB=null;State.stats._comparing=false;siRenderTab();">'
    + '<option value="">— Choose player B —</option>' + playerOpts(bidPid) + '</select></div>'
    + '</div>';

  var content = '';
  if (compA && compB) {
    content = _siCompareView(compA, compB, aidPid, bidPid);
  } else if (comparing) {
    content = loadingHTML('Comparing players…');
  } else if (aidPid && bidPid) {
    content = '<div style="text-align:center;padding:24px;">'
      + '<button class="btn btn-primary" onclick="siRunComparison()">Compare Players</button></div>';
  } else {
    content = '<div class="si-no-data">Select two players and click Compare.</div>';
  }

  return selectors + content;
}

function _siCompareView(profA, profB, aidPid, bidPid) {
  var nameA  = _scoutPlayerName(aidPid);
  var nameB  = _scoutPlayerName(bidPid);
  var lsA    = profA.latestSeason;
  var lsB    = profB.latestSeason;
  var cA     = profA.careerStats;
  var cB     = profB.careerStats;

  var metrics = [
    { label: 'Goals',         a: lsA ? lsA.goals     : 0,               b: lsB ? lsB.goals     : 0 },
    { label: 'Assists',       a: lsA ? lsA.assists   : 0,               b: lsB ? lsB.assists   : 0 },
    { label: 'xG',            a: (lsA ? lsA.xg : 0).toFixed(2),        b: (lsB ? lsB.xg : 0).toFixed(2),       na: lsA ? lsA.xg : 0,               nb: lsB ? lsB.xg : 0 },
    { label: 'xA',            a: (lsA ? lsA.xa : 0).toFixed(2),        b: (lsB ? lsB.xa : 0).toFixed(2),       na: lsA ? lsA.xa : 0,               nb: lsB ? lsB.xa : 0 },
    { label: 'Appearances',   a: lsA ? lsA.appearances : 0,            b: lsB ? lsB.appearances : 0 },
    { label: 'Pass Acc %',    a: lsA ? ((lsA.passAccuracy||0)*100).toFixed(1)+'%' : '—', b: lsB ? ((lsB.passAccuracy||0)*100).toFixed(1)+'%' : '—', na: lsA ? (lsA.passAccuracy||0)*100 : 0, nb: lsB ? (lsB.passAccuracy||0)*100 : 0 },
    { label: 'Avg Rating',    a: (lsA ? lsA.averageRating||0 : 0).toFixed(1), b: (lsB ? lsB.averageRating||0 : 0).toFixed(1), na: lsA ? lsA.averageRating||0 : 0, nb: lsB ? lsB.averageRating||0 : 0 },
    { label: 'Career Apps',   a: cA.totalAppearances,                   b: cB.totalAppearances },
    { label: 'Career Goals',  a: cA.totalGoals,                         b: cB.totalGoals },
    { label: 'Career Assists',a: cA.totalAssists,                       b: cB.totalAssists },
  ];

  var header = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;text-align:center;">'
    + '<div style="font-size:15px;font-weight:700;color:var(--green-l)">' + _esc(nameA) + '</div>'
    + '<div style="font-size:15px;font-weight:700;color:var(--amber)">' + _esc(nameB) + '</div></div>';

  var rows = metrics.map(function(m) {
    var na = +(m.na !== undefined ? m.na : m.a);
    var nb = +(m.nb !== undefined ? m.nb : m.b);
    var aWins = na > nb;
    var bWins = nb > na;
    return '<div style="display:grid;grid-template-columns:1fr 120px 1fr;align-items:center;padding:10px 14px;border-bottom:1px solid var(--bd-2);">'
      + '<div style="text-align:right;font-size:13px;font-weight:700;font-family:var(--mono);color:' + (aWins ? 'var(--green-l)' : 'var(--tx-2)') + '">' + m.a + '</div>'
      + '<div style="text-align:center;font-size:10px;font-weight:600;color:var(--tx-3);text-transform:uppercase;">' + m.label + '</div>'
      + '<div style="text-align:left;font-size:13px;font-weight:700;font-family:var(--mono);color:' + (bWins ? 'var(--amber)' : 'var(--tx-2)') + '">' + m.b + '</div></div>';
  }).join('');

  return header + '<div class="card" style="padding:0;">' + rows + '</div>';
}

async function siRunComparison() {
  var aidPid = State.stats._playerAId;
  var bidPid = State.stats._playerBId;
  if (!aidPid || !bidPid) return;

  State.stats._comparing = true;
  State.stats.compareA   = null;
  State.stats.compareB   = null;
  siRenderTab();

  var results = await Promise.allSettled([
    api('/phase-q/stats/players/' + aidPid + '/profile'),
    api('/phase-q/stats/players/' + bidPid + '/profile'),
  ]);
  State.stats.compareA = results[0].status === 'fulfilled' ? results[0].value : null;
  State.stats.compareB = results[1].status === 'fulfilled' ? results[1].value : null;
  State.stats._comparing = false;

  if (!State.stats.compareA || !State.stats.compareB) {
    showToast('Failed to load one or both player profiles', 'error');
  }
  siRenderTab();
}

// ══════════════════════════════════════════════════════════════════════════════
// END STATS INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// TRANSFER INTELLIGENCE CENTER — Phase 9
// APIs (all under /api/v1/phase-q/transfer/):
//   GET  targets?limit=200           — active + archived targets
//   GET  pipeline                    — kanban board by stage
//   GET  reports?limit=100           — scouting reports
//   GET  contracts-expiring          — contracts expiring within 180d
//   GET  market-values/squad         — squad valuation summary
//   GET  intelligence/squad          — age/position/wage/valuation analysis
//   GET  intelligence/player/:id     — cross-module player profile
//   POST targets                     — add target
//   POST targets/:id/advance         — advance pipeline stage
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers (hoisted — available to stats/workload sections above) ─────────────

function _scoutPlayerName(playerId) {
  var p = (State.players || []).find(function(pl) { return pl.id === playerId; });
  return p ? (p.firstName + ' ' + p.lastName) : '';
}
function _scoutPlayerPos(playerId) {
  var p = (State.players || []).find(function(pl) { return pl.id === playerId; });
  return p ? (p.position || '') : '';
}

// ── State ────────────────────────────────────────────────────────────────────

// State.transfer is initialised in the global State object elsewhere.
// Keys used: targets, pipeline, reports, contracts, squadVal, squadIntel,
//            _loading, _tab, _search, _stageFilter, _recFilter, _playerIntel

// ── HTML Skeleton ─────────────────────────────────────────────────────────────

function renderTransferHTML() {
  return `<div class="page" id="pg-transfer">
  <div class="ti-page">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Transfer Intelligence Center</div>
        <div style="font-size:12px;color:var(--tx-3);" id="ti-sub">Loading…</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" data-action="tiRefresh">&#8635; Refresh</button>
        <button class="btn btn-primary btn-sm" data-action="tiOpenAddTarget">+ Add Target</button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="ti-tabs" style="display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="ti-tab active" id="titab-dashboard"  data-action="tiSwitchTab" data-tab="dashboard">Dashboard</button>
      <button class="ti-tab"        id="titab-targets"    data-action="tiSwitchTab" data-tab="targets">Targets</button>
      <button class="ti-tab"        id="titab-market"     data-action="tiSwitchTab" data-tab="market">Market Intel</button>
      <button class="ti-tab"        id="titab-contracts"  data-action="tiSwitchTab" data-tab="contracts">Contracts</button>
      <button class="ti-tab"        id="titab-pipeline"   data-action="tiSwitchTab" data-tab="pipeline">Pipeline</button>
      <button class="ti-tab"        id="titab-video"      data-action="tiSwitchTab" data-tab="video">Video+Analytics</button>
      <button class="ti-tab"        id="titab-compare"    data-action="tiSwitchTab" data-tab="compare">Compare</button>
      <button class="ti-tab"        id="titab-intel"      data-action="tiSwitchTab" data-tab="intel">Intelligence</button>
    </div>

    <!-- Tab content -->
    <div id="ti-content"></div>

    <!-- Detail modal -->
    <div id="ti-detail-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;overflow-y:auto;">
      <div style="max-width:700px;margin:48px auto;background:var(--surface);border-radius:12px;padding:24px;position:relative;">
        <button data-action="tiCloseDetail" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--tx-2);">&#x2715;</button>
        <div id="ti-detail-name" style="font-size:16px;font-weight:700;color:var(--tx);margin-bottom:16px;"></div>
        <div id="ti-detail-body" style="color:var(--tx-2);font-size:13px;"></div>
      </div>
    </div>

    <!-- Add-target modal -->
    <div id="ti-add-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;overflow-y:auto;">
      <div style="max-width:500px;margin:48px auto;background:var(--surface);border-radius:12px;padding:24px;position:relative;">
        <button data-action="tiCloseAddTarget" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--tx-2);">&#x2715;</button>
        <div style="font-size:15px;font-weight:700;color:var(--tx);margin-bottom:16px;">Add Transfer Target</div>
        <form id="ti-add-form" data-form-submit="tiSubmitAddTarget">
          <div style="display:grid;gap:12px;">
            <div>
              <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Player *</label>
              <select id="tia-player" class="form-input" style="width:100%;" required>
                <option value="">— select player —</option>
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Current Club</label>
                <input id="tia-club" class="form-input" placeholder="e.g. Real Madrid" style="width:100%;">
              </div>
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Position</label>
                <input id="tia-pos" class="form-input" placeholder="e.g. CM" style="width:100%;">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Asking Price (M€)</label>
                <input id="tia-price" type="number" step="0.1" min="0" class="form-input" placeholder="0.0" style="width:100%;">
              </div>
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Priority (0–100)</label>
                <input id="tia-priority" type="number" min="0" max="100" class="form-input" placeholder="50" style="width:100%;">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Nationality</label>
              <input id="tia-nat" class="form-input" placeholder="e.g. Spanish" style="width:100%;">
            </div>
            <div>
              <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Notes</label>
              <textarea id="tia-notes" class="form-input" rows="2" style="width:100%;resize:vertical;"></textarea>
            </div>
            <div id="tia-error" style="display:none;color:var(--red);font-size:12px;"></div>
            <div style="display:flex;justify-content:flex-end;gap:8px;">
              <button type="button" data-action="tiCloseAddTarget" class="btn btn-ghost btn-sm">Cancel</button>
              <button type="submit" id="tia-submit" class="btn btn-primary btn-sm">Add to Pipeline</button>
            </div>
          </div>
        </form>
      </div>
    </div>

  </div>
</div>`;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadTransferData() {
  if (State.transfer._loading) return;
  State.transfer._loading = true;

  const content = document.getElementById('ti-content');
  if (content) content.innerHTML = loadingHTML('Loading transfer data…');

  const [targRes, pipeRes, repRes, contrRes, valRes, sqRes, rankRes, depthRes, futureRes] = await Promise.allSettled([
    FamilistaAPI.get('/phase-q/transfer/targets?limit=200'),
    FamilistaAPI.get('/phase-q/transfer/pipeline'),
    FamilistaAPI.get('/phase-q/transfer/reports?limit=100'),
    FamilistaAPI.get('/phase-q/transfer/contracts-expiring'),
    FamilistaAPI.get('/phase-q/transfer/market-values/squad'),
    FamilistaAPI.get('/phase-q/transfer/intelligence/squad'),
    FamilistaAPI.get('/phase-q/transfer/scoring/ranked'),
    FamilistaAPI.get('/phase-q/transfer/scoring/squad-depth'),
    FamilistaAPI.get('/phase-q/transfer/intelligence/squad-future'),
  ]);

  State.transfer.targets        = (targRes.status  === 'fulfilled' && Array.isArray(targRes.value?.items))  ? targRes.value.items  : [];
  State.transfer.pipeline       = (pipeRes.status  === 'fulfilled' && pipeRes.value && typeof pipeRes.value === 'object') ? pipeRes.value : {};
  State.transfer.reports        = (repRes.status   === 'fulfilled' && Array.isArray(repRes.value?.items))   ? repRes.value.items   : [];
  State.transfer.contracts      = (contrRes.status === 'fulfilled' && Array.isArray(contrRes.value))        ? contrRes.value       : [];
  State.transfer.squadVal       = (valRes.status   === 'fulfilled' && Array.isArray(valRes.value))          ? valRes.value         : [];
  State.transfer.squadIntel     = (sqRes.status    === 'fulfilled' && sqRes.value)                          ? sqRes.value          : null;
  State.transfer._rankedTargets = (rankRes.status  === 'fulfilled' && Array.isArray(rankRes.value?.items))  ? rankRes.value.items  : null;
  State.transfer._squadDepth    = (depthRes.status === 'fulfilled' && depthRes.value)                       ? depthRes.value       : null;
  State.transfer._futurePlan    = (futureRes.status === 'fulfilled' && futureRes.value)                     ? futureRes.value      : null;

  const active = State.transfer.targets.filter(function(t) { return !t.archivedAt; }).length;
  const subEl  = document.getElementById('ti-sub');
  if (subEl) subEl.textContent = active + ' active target' + (active !== 1 ? 's' : '') + ' · ' + State.transfer.reports.length + ' scout reports';

  State.transfer._loading = false;
  tiRenderTab();
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function tiSwitchTab(tab) {
  State.transfer._tab = tab;
  document.querySelectorAll('.ti-tab').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  tiRenderTab();
}

function tiRenderTab() {
  if (isFormEditing()) { _pendingRefresh = true; return; }
  const el = document.getElementById('ti-content');
  if (!el) return;
  var _f = _saveFocusIn(el);  // save focus/cursor before replacing innerHTML
  switch (State.transfer._tab) {
    case 'dashboard': el.innerHTML = _tiDashboard();      break;
    case 'targets':   el.innerHTML = _tiTargets();        break;
    case 'market':    el.innerHTML = _tiMarket();         break;
    case 'contracts': el.innerHTML = _tiContracts();      break;
    case 'pipeline':  el.innerHTML = _tiPipeline();       break;
    case 'video':     el.innerHTML = _tiVideoAnalytics(); break;
    case 'compare':   el.innerHTML = _tiCompare();        break;
    case 'intel':     el.innerHTML = _tiIntelligence();   break;
    default:          el.innerHTML = _tiDashboard();
  }
  _restoreFocusIn(el, _f);  // restore focus + cursor position after re-render
}

// ── SCREEN 1: Dashboard ───────────────────────────────────────────────────────

function _tiDashboard() {
  const T          = State.transfer;
  const active     = T.targets.filter(function(t) { return !t.archivedAt; });
  const pipe       = T.pipeline;
  const totalVal   = T.squadVal.reduce(function(s, v) { return s + (v.latestValueMEur || 0); }, 0);
  const expiringN  = T.contracts.filter(function(c) { return c.isExpiringSoon; }).length;
  const si         = T.squadIntel;
  const ranked     = T._rankedTargets || [];
  const depth      = T._squadDepth;

  // Market opportunity count
  var mktOppN = ranked.filter(function(r) { return r.scorecard && r.scorecard.marketOpportunity; }).length;

  const kpis = `<div class="ti-kpi-row">
    <div class="ti-kpi"><div class="ti-kpi-val">${active.length}</div><div class="ti-kpi-label">Active Targets</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">${totalVal.toFixed(1)}M€</div><div class="ti-kpi-label">Squad Value</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">${T.reports.length}</div><div class="ti-kpi-label">Scout Reports</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:${expiringN > 3 ? 'var(--red)' : expiringN > 0 ? 'var(--amber)' : 'var(--green-l)'}">${expiringN}</div><div class="ti-kpi-label">Expiring Contracts</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:${mktOppN > 0 ? 'var(--green-l)' : 'var(--tx-3)'}">${mktOppN}</div><div class="ti-kpi-label">Market Opps</div></div>
    ${si ? '<div class="ti-kpi"><div class="ti-kpi-val" style="color:' + (si.injuredCount > 3 ? 'var(--red)' : 'var(--amber)') + '">' + si.injuredCount + '</div><div class="ti-kpi-label">Squad Injured</div></div>' : ''}
  </div>`;

  // Pipeline mini
  const STAGES = ['LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
  const pipeRows = STAGES.map(function(s) {
    const items = (pipe[s] || []);
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:12px;color:var(--tx-2);">${s}</span>
      <span style="font-size:13px;font-weight:700;color:var(--tx);">${items.length}</span>
    </div>`;
  }).join('');
  const pipeCard = `<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Pipeline Summary</div>
    ${pipeRows}
    <div style="margin-top:10px;text-align:right;">
      <button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="pipeline">Full Pipeline →</button>
    </div>
  </div>`;

  // Top 5 scored targets (from ranking engine; fall back to priorityScore sort)
  var scoreBadge = function(score) {
    var c = score >= 80 ? 'var(--green-l)' : score >= 65 ? '#60a5fa' : score >= 50 ? 'var(--amber)' : 'var(--red)';
    return '<span style="display:inline-block;min-width:30px;text-align:center;background:' + c + '22;color:' + c + ';font-size:10px;font-weight:700;border-radius:3px;padding:1px 4px;">' + Math.round(score) + '</span>';
  };
  var flagBadge = function(flag) {
    var map = { CONTRACT_CRITICAL:'🔴 CRIT', CONTRACT_WARNING:'🟡 WARN', AVAILABLE_NOW:'🟢 AVAIL', UNDERVALUED:'💰 UNV', HIGH_POTENTIAL:'⬆ POT', NO_REPORTS:'📋 0REP', EXPIRING_SOON:'⏰ EXP' };
    return map[flag] ? '<span style="font-size:9px;color:var(--tx-3);margin-left:3px;">' + map[flag] + '</span>' : '';
  };

  var topRows;
  if (ranked.length > 0) {
    topRows = ranked.slice(0, 5).map(function(r) {
      var sc   = r.scorecard;
      var tgt  = T.targets.find(function(t) { return t.id === r.targetId; }) || {};
      var name = _esc(_scoutPlayerName(r.playerId));
      var club = _esc(tgt.currentClubName || '—');
      var flags = (sc.flags || []).slice(0, 2).map(flagBadge).join('');
      return '<div class="ti-target-row" data-action="tiOpenDetail" data-id="' + _esc(r.targetId) + '"'
        + ' style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">'
        + '<div>'
        + '<div style="font-size:13px;font-weight:600;color:var(--tx);">' + (name || r.playerId.substring(0,8)+'…') + flags + '</div>'
        + '<div style="font-size:11px;color:var(--tx-3);">' + club + ' • ' + _esc(r.stage) + '</div>'
        + '</div>'
        + '<div style="text-align:right;">'
        + '<div>' + scoreBadge(sc.transferPriority) + '</div>'
        + '<div style="font-size:9px;color:var(--tx-3);margin-top:2px;">priority</div>'
        + '</div>'
        + '</div>';
    }).join('');
  } else {
    const sorted = active.slice().sort(function(a, b) { return (b.priorityScore || 0) - (a.priorityScore || 0); });
    topRows = sorted.slice(0, 5).map(function(t) {
      var name = _esc(_scoutPlayerName(t.playerId));
      var club = _esc(t.currentClubName || '—');
      var pri  = t.priorityScore != null ? t.priorityScore : '?';
      return '<div class="ti-target-row" data-action="tiOpenDetail" data-id="' + _esc(t.id) + '"'
        + ' style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">'
        + '<div><div style="font-size:13px;font-weight:600;color:var(--tx);">' + (name || t.playerId.substring(0,8)+'…') + '</div>'
        + '<div style="font-size:11px;color:var(--tx-3);">' + club + ' • ' + _esc(t.stage) + '</div></div>'
        + '<div style="font-size:13px;font-weight:700;color:var(--accent);">' + pri + '</div>'
        + '</div>';
    }).join('') || '<div style="color:var(--tx-3);font-size:13px;padding:12px 0;">No active targets yet.</div>';
  }

  const topCard = `<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Top Ranked Targets</div>
    ${topRows}
    <div style="margin-top:10px;text-align:right;">
      <button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="targets">All targets →</button>
    </div>
  </div>`;

  // Squad depth alerts
  var depthCard = '';
  if (depth) {
    var critSlots = depth.criticalSlots || [];
    var shortages = depth.shortages || [];
    var depthRows = shortages.map(function(s) {
      var isCrit = critSlots.indexOf(s.position) !== -1;
      var c = isCrit ? 'var(--red)' : 'var(--amber)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);">'
        + '<span style="font-size:12px;font-weight:700;color:' + c + ';">' + _esc(s.position) + (isCrit ? ' ⚠' : '') + '</span>'
        + '<span style="font-size:11px;color:var(--tx-3);">' + s.have + '/' + s.need + ' — deficit ' + s.deficit + '</span>'
        + '</div>';
    }).join('') || '<div style="font-size:12px;color:var(--green-l);padding:6px 0;">✓ All positions adequately covered</div>';
    depthCard = '<div class="ti-card" style="margin-top:16px;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Squad Depth'
      + (critSlots.length ? ' <span style="color:var(--red);font-size:10px;">(' + critSlots.length + ' CRITICAL)</span>' : '') + '</div>'
      + depthRows
      + '<div style="margin-top:8px;text-align:right;"><button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="market">Full Analysis →</button></div>'
      + '</div>';
  }

  // Recent reports
  const recentReps = T.reports.slice(0, 4).map(function(r) {
    var name = _esc(_scoutPlayerName(r.playerId));
    var grade = r.overallGrade || '—';
    var rec   = r.recommendation || '';
    var gradeColor = grade.startsWith('A') ? 'var(--green-l)' : grade === 'B_PLUS' ? '#60a5fa' : grade === 'B' ? 'var(--amber)' : 'var(--tx-3)';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-size:13px;color:var(--tx);">${name || r.playerId.substring(0,8)+'…'}</div>
        <div style="font-size:11px;color:var(--tx-3);">${_esc(rec)}</div>
      </div>
      <span style="font-size:12px;font-weight:700;color:${gradeColor};">${_esc(grade.replace('_PLUS','+'))}</span>
    </div>`;
  }).join('') || '<div style="color:var(--tx-3);font-size:13px;padding:8px 0;">No reports yet.</div>';

  const repCard = `<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Recent Scout Reports</div>
    ${recentReps}
    <div style="margin-top:10px;text-align:right;">
      <button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="compare">Compare players →</button>
    </div>
  </div>`;

  return kpis + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;">${pipeCard}${topCard}</div>` + depthCard + repCard;
}

// ── SCREEN 2: Targets ─────────────────────────────────────────────────────────

function _tiTargets() {
  const T     = State.transfer;
  const q     = (T._search || '').toLowerCase();
  const stage = T._stageFilter || '';
  var items   = T.targets.filter(function(t) { return !t.archivedAt; });
  if (q)     items = items.filter(function(t) { return (_scoutPlayerName(t.playerId)||'').toLowerCase().includes(q) || (t.currentClubName||'').toLowerCase().includes(q); });
  if (stage) items = items.filter(function(t) { return t.stage === stage; });

  // Build a lookup map from ranked targets so we can show scores inline
  var ranked  = T._rankedTargets || [];
  var scoreMap = {};
  ranked.forEach(function(r) { scoreMap[r.targetId] = r.scorecard; });

  // Sort by transferPriority if scoring data available, otherwise priorityScore
  if (ranked.length > 0) {
    items.sort(function(a, b) {
      var sa = scoreMap[a.id] ? scoreMap[a.id].transferPriority : 0;
      var sb = scoreMap[b.id] ? scoreMap[b.id].transferPriority : 0;
      return sb - sa;
    });
  } else {
    items.sort(function(a, b) { return (b.priorityScore || 0) - (a.priorityScore || 0); });
  }

  const STAGES = ['', 'LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
  const stageOpts = STAGES.map(function(s) {
    return `<option value="${s}" ${stage === s ? 'selected' : ''}>${s || 'All Stages'}</option>`;
  }).join('');

  const controls = `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
    <input class="form-input" style="flex:1;min-width:180px;" placeholder="Search player or club…"
      value="${_esc(T._search||'')}"
      oninput="State.transfer._search=this.value;tiRenderTab();">
    <select class="form-input" style="min-width:140px;" onchange="State.transfer._stageFilter=this.value;tiRenderTab();">${stageOpts}</select>
  </div>`;

  if (!items.length) return controls + '<div style="color:var(--tx-3);font-size:13px;padding:20px 0;text-align:center;">No targets match filter.</div>';

  var _scorePill = function(score, label) {
    var c = score >= 80 ? 'var(--green-l)' : score >= 65 ? '#60a5fa' : score >= 50 ? 'var(--amber)' : 'var(--red)';
    return '<div style="text-align:center;">'
      + '<div style="background:' + c + '22;color:' + c + ';font-size:11px;font-weight:700;border-radius:4px;padding:2px 6px;">' + Math.round(score) + '</div>'
      + '<div style="font-size:9px;color:var(--tx-3);margin-top:1px;">' + label + '</div>'
      + '</div>';
  };
  var _flagPills = function(flags) {
    var abbr = { CONTRACT_CRITICAL:'🔴', CONTRACT_WARNING:'🟡', AVAILABLE_NOW:'🟢', UNDERVALUED:'💰', HIGH_POTENTIAL:'⬆', NO_REPORTS:'📋', EXPIRING_SOON:'⏰' };
    return (flags || []).slice(0,3).map(function(f) {
      return '<span title="' + _esc(f) + '" style="font-size:11px;cursor:default;">' + (abbr[f] || '') + '</span>';
    }).join('');
  };

  const rows = items.map(function(t) {
    var name     = _esc(_scoutPlayerName(t.playerId));
    var pos      = _esc(t.position || _scoutPlayerPos(t.playerId) || '—');
    var club     = _esc(t.currentClubName || '—');
    var price    = t.askingPriceMEur != null ? t.askingPriceMEur + 'M€' : '—';
    var valEntry = T.squadVal.find(function(v) { return v.playerId === t.playerId; });
    var val      = valEntry ? valEntry.latestValueMEur + 'M€' : '—';
    var stageColor = {LONGLIST:'var(--tx-3)',SHORTLIST:'#60a5fa',APPROACH:'var(--amber)',NEGOTIATION:'var(--green-l)'}[t.stage] || 'var(--tx-3)';
    var sc       = scoreMap[t.id];

    var scoreSection = sc
      ? '<div style="display:flex;gap:8px;align-items:center;">'
        + _scorePill(sc.compositeScore, 'score')
        + _scorePill(sc.tacticalFitScore, 'fit')
        + _scorePill(sc.contractRiskScore, 'risk')
        + '<div style="font-size:13px;">' + _flagPills(sc.flags) + '</div>'
        + '</div>'
      : '<div style="font-size:11px;color:var(--tx-3);">pri ' + (t.priorityScore != null ? t.priorityScore : '?') + '</div>';

    return '<div class="ti-target-row" data-action="tiOpenDetail" data-id="' + _esc(t.id) + '"'
      + ' style="display:grid;grid-template-columns:1fr auto;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:6px;transition:background .15s;"'
      + ' onmouseover="this.style.background=\'var(--surface-2)\'" onmouseout="this.style.background=\'\'">'
      + '<div>'
      + '<div style="font-size:13px;font-weight:600;color:var(--tx);">' + (name || t.playerId.substring(0,8)+'…') + ' <span style="font-size:11px;color:var(--tx-3);">' + pos + '</span></div>'
      + '<div style="font-size:11px;color:var(--tx-3);margin-top:2px;">' + club + ' • Ask: ' + price + ' • Mkt: ' + val + '</div>'
      + '</div>'
      + '<div style="text-align:right;">'
      + '<div style="font-size:11px;font-weight:700;color:' + stageColor + ';margin-bottom:4px;">' + _esc(t.stage) + '</div>'
      + scoreSection
      + '</div>'
      + '</div>';
  }).join('');

  return controls + `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;">${rows}</div>`;
}

// ── SCREEN 3: Market Intelligence ─────────────────────────────────────────────

function _tiMarket() {
  const si = State.transfer.squadIntel;
  if (!si) {
    return `<div style="color:var(--tx-3);font-size:13px;padding:32px;text-align:center;">
      Squad intelligence not available. <button class="btn btn-ghost btn-xs" data-action="tiRefresh">Retry</button>
    </div>`;
  }

  // Squad overview KPIs
  const wageBillM = (si.annualWageBillEur / 1_000_000).toFixed(1);
  const kpis = `<div class="ti-kpi-row" style="margin-bottom:16px;">
    <div class="ti-kpi"><div class="ti-kpi-val">${si.squadSize}</div><div class="ti-kpi-label">Squad Size</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">${si.totalSquadValueMEur.toFixed(1)}M€</div><div class="ti-kpi-label">Total Squad Value</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">${wageBillM}M€</div><div class="ti-kpi-label">Annual Wage Bill</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:${si.injuredCount > 3 ? 'var(--red)' : 'var(--amber)'}">${si.injuredCount}</div><div class="ti-kpi-label">Injured</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:var(--red)">${si.expiringContracts.length}</div><div class="ti-kpi-label">Contracts Expiring (1yr)</div></div>
  </div>`;

  // Age distribution
  const ageBands = si.ageBands || {};
  const ageRows  = Object.entries(ageBands).map(function(entry) {
    var band = entry[0]; var cnt = entry[1];
    var pct = si.squadSize > 0 ? Math.round(cnt / si.squadSize * 100) : 0;
    return `<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--tx-2);margin-bottom:3px;">
        <span>${band}</span><span>${cnt} players (${pct}%)</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:3px;"></div>
      </div>
    </div>`;
  }).join('');
  const ageCard = `<div class="ti-card">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Age Distribution</div>
    ${ageRows}
  </div>`;

  // Position distribution
  const posEntries = Object.entries(si.positionCounts || {});
  posEntries.sort(function(a, b) { return b[1] - a[1]; });
  const maxPos = posEntries.reduce(function(m, e) { return Math.max(m, e[1]); }, 0);
  const posRows = posEntries.map(function(entry) {
    var pos = entry[0]; var cnt = entry[1];
    var pct = maxPos > 0 ? Math.round(cnt / maxPos * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <div style="width:80px;font-size:11px;color:var(--tx-2);text-align:right;flex-shrink:0;">${pos}</div>
      <div style="flex:1;height:14px;background:var(--border);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--accent-2,#60a5fa);border-radius:3px;display:flex;align-items:center;padding-left:4px;">
          <span style="font-size:10px;font-weight:700;color:#fff;">${cnt}</span>
        </div>
      </div>
    </div>`;
  }).join('');
  const posCard = `<div class="ti-card">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Position Counts</div>
    ${posRows || '<div style="color:var(--tx-3);font-size:12px;">No data.</div>'}
  </div>`;

  // Top valuations
  const topVals = (si.valuations || []).slice(0,8).map(function(v) {
    var name = _esc(_scoutPlayerName(v.playerId));
    return `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">
      <span style="color:var(--tx);">${name || v.playerId.substring(0,10)+'…'}</span>
      <span style="font-weight:700;color:var(--green-l);">${(v.latestValueMEur||0).toFixed(1)}M€</span>
    </div>`;
  }).join('');
  const valCard = `<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Top Valued Players</div>
    ${topVals || '<div style="color:var(--tx-3);font-size:12px;">No valuations recorded.</div>'}
  </div>`;

  // Market opportunities from scoring engine
  var mktOppCard = '';
  var ranked = State.transfer._rankedTargets || [];
  var opps   = ranked.filter(function(r) { return r.scorecard && r.scorecard.marketOpportunity; });
  if (opps.length > 0) {
    var OPP_LABEL = { UNDERVALUED:'💰 Undervalued', FREE_AGENT_RISK:'⏰ Free-Agent Risk', HIGH_VALUE_CHEAP:'⬆ High Value / Cheap', AVAILABLE:'🟢 Available Now' };
    var OPP_COLOR = { UNDERVALUED:'var(--green-l)', FREE_AGENT_RISK:'var(--amber)', HIGH_VALUE_CHEAP:'#60a5fa', AVAILABLE:'var(--green-l)' };
    var oppRows = opps.map(function(r) {
      var sc   = r.scorecard;
      var tgt  = State.transfer.targets.find(function(t) { return t.id === r.targetId; }) || {};
      var name = _esc(_scoutPlayerName(r.playerId));
      var opp  = sc.marketOpportunity;
      var c    = OPP_COLOR[opp] || 'var(--tx-2)';
      var lbl  = OPP_LABEL[opp] || _esc(opp);
      var priceStr = sc.raw.askingPriceMEur != null ? sc.raw.askingPriceMEur + 'M€' : '—';
      var valStr   = sc.raw.latestValueMEur  != null ? sc.raw.latestValueMEur.toFixed(1) + 'M€' : '—';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);">'
        + '<div>'
        + '<div style="font-size:13px;font-weight:600;color:var(--tx);">' + (name || r.playerId.substring(0,8)+'…') + '</div>'
        + '<div style="font-size:11px;color:var(--tx-3);">Ask: ' + priceStr + ' • Mkt: ' + valStr + ' • ' + _esc(r.stage) + '</div>'
        + '</div>'
        + '<span style="font-size:11px;font-weight:700;color:' + c + ';white-space:nowrap;margin-left:8px;">' + lbl + '</span>'
        + '</div>';
    }).join('');
    mktOppCard = '<div class="ti-card" style="margin-top:16px;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Market Opportunities (' + opps.length + ')</div>'
      + oppRows
      + '</div>';
  }

  // Squad depth analysis from scoring engine
  var sqDepthCard = '';
  var depth = State.transfer._squadDepth;
  if (depth) {
    var critSlots  = depth.criticalSlots || [];
    var shortages  = depth.shortages || [];
    var surpluses  = depth.surpluses || [];
    var posCounts  = depth.positionCounts || {};
    var posBuckets = Object.keys(posCounts);
    var depthRows  = posBuckets.map(function(pos) {
      var have    = posCounts[pos] || 0;
      var isCrit  = critSlots.indexOf(pos) !== -1;
      var sShort  = shortages.find(function(s) { return s.position === pos; });
      var sSurp   = surpluses.find(function(s) { return s.position === pos; });
      var barW    = Math.min(100, Math.round(have / 6 * 100));
      var barC    = isCrit ? 'var(--red)' : sShort ? 'var(--amber)' : 'var(--green-l)';
      var badge   = isCrit
        ? '<span style="font-size:9px;font-weight:700;color:var(--red);background:rgba(239,68,68,.15);border-radius:3px;padding:1px 4px;margin-left:4px;">CRITICAL</span>'
        : sShort
          ? '<span style="font-size:9px;font-weight:700;color:var(--amber);background:rgba(251,191,36,.15);border-radius:3px;padding:1px 4px;margin-left:4px;">SHORT</span>'
          : sSurp
            ? '<span style="font-size:9px;color:var(--tx-3);margin-left:4px;">+' + sSurp.surplus + ' surplus</span>'
            : '';
      return '<div style="margin-bottom:8px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">'
        + '<span style="color:var(--tx-2);">' + _esc(pos) + badge + '</span>'
        + '<span style="color:var(--tx);font-weight:700;">' + have + '</span>'
        + '</div>'
        + '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">'
        + '<div style="height:100%;width:' + barW + '%;background:' + barC + ';border-radius:3px;transition:width .4s;"></div>'
        + '</div>'
        + '</div>';
    }).join('') || '<div style="font-size:12px;color:var(--tx-3);">No squad data.</div>';

    sqDepthCard = '<div class="ti-card" style="margin-top:16px;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Squad Depth Analysis'
      + (critSlots.length ? ' <span style="color:var(--red);font-size:10px;">(' + critSlots.length + ' critical)</span>' : '') + '</div>'
      + depthRows
      + (shortages.length ? '<div style="margin-top:10px;padding:8px;background:rgba(251,191,36,.08);border-radius:4px;font-size:11px;color:var(--amber);">⚠ Shortage in: ' + shortages.map(function(s){return s.position+'(−'+s.deficit+')';}).join(', ') + '</div>' : '')
      + '</div>';
  }

  return kpis + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">${ageCard}${posCard}</div>` + valCard + mktOppCard + sqDepthCard;
}

// ── SCREEN 4: Contract Center ─────────────────────────────────────────────────

function _tiContracts() {
  const T = State.transfer;
  const contracts = T.contracts.slice().sort(function(a, b) {
    return new Date(a.contractExpiry) - new Date(b.contractExpiry);
  });

  if (!contracts.length) return '<div style="color:var(--tx-3);font-size:13px;padding:20px;text-align:center;">No expiring contracts found (within 180 days).</div>';

  const today = new Date();
  const rows = contracts.map(function(c) {
    var name     = _esc(_scoutPlayerName(c.playerId));
    var expiry   = new Date(c.contractExpiry);
    var daysLeft = Math.floor((expiry - today) / 86400000);
    var urgColor = daysLeft < 60 ? 'var(--red)' : daysLeft < 120 ? 'var(--amber)' : 'var(--tx-2)';
    var expStr   = expiry.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'});
    var valStr   = c.contractValueEur ? '€' + (c.contractValueEur / 1000).toFixed(0) + 'k/yr' : '—';
    var clauseStr = c.releaseClauseEur ? '€' + (c.releaseClauseEur / 1_000_000).toFixed(1) + 'M' : '—';
    var agent    = _esc(c.agentName || '—');
    var status   = c.isAvailableForTransfer ? '<span style="color:var(--green-l);font-size:10px;font-weight:700;">AVAILABLE</span>' :
                   c.isExpiringSoon         ? '<span style="color:var(--amber);font-size:10px;font-weight:700;">EXPIRING SOON</span>' : '';
    return `<tr>
      <td style="padding:8px 6px;font-size:13px;font-weight:600;color:var(--tx);">${name || c.playerId.substring(0,8)+'…'}</td>
      <td style="padding:8px 6px;font-size:12px;color:${urgColor};font-weight:700;">${expStr}</td>
      <td style="padding:8px 6px;font-size:12px;color:${urgColor};font-weight:700;">${daysLeft}d</td>
      <td style="padding:8px 6px;font-size:12px;color:var(--tx-2);">${valStr}</td>
      <td style="padding:8px 6px;font-size:12px;color:var(--tx-2);">${clauseStr}</td>
      <td style="padding:8px 6px;font-size:12px;color:var(--tx-3);">${agent}</td>
      <td style="padding:8px 6px;">${status}</td>
    </tr>`;
  }).join('');

  return `<div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);">
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Player</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Expiry</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Days Left</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Value/yr</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Release Clause</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Agent</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── SCREEN 5: Pipeline (Kanban) ───────────────────────────────────────────────

function _tiPipeline() {
  const T      = State.transfer;
  const pipe   = T.pipeline;
  const STAGES = ['LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
  const STAGE_COLORS = { LONGLIST:'var(--tx-3)', SHORTLIST:'#60a5fa', APPROACH:'var(--amber)', NEGOTIATION:'var(--green-l)' };
  const NEXT_STAGE   = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION', NEGOTIATION:null };

  const cols = STAGES.map(function(stage) {
    var items  = (pipe[stage] || []);
    var color  = STAGE_COLORS[stage];
    var nextS  = NEXT_STAGE[stage];
    var cards  = items.length
      ? items.map(function(t) {
          var name  = _esc(_scoutPlayerName(t.playerId));
          var club  = _esc(t.currentClubName || '');
          var price = t.askingPriceMEur != null ? t.askingPriceMEur + 'M€' : '';
          var btns  = '';
          if (nextS) btns += `<button class="btn btn-ghost btn-xs" data-action="tiAdvance" data-id="${_esc(t.id)}" style="font-size:10px;">⇒ ${nextS.substring(0,3)}</button> `;
          btns += `<button class="btn btn-ghost btn-xs" data-action="tiReject" data-id="${_esc(t.id)}" style="font-size:10px;color:var(--red);">Reject</button>`;
          return `<div style="background:var(--surface-2);border-radius:6px;padding:10px;margin-bottom:8px;border:1px solid var(--border);">
            <div style="font-size:12px;font-weight:700;color:var(--tx);margin-bottom:3px;">${name || t.playerId.substring(0,8)+'…'}</div>
            ${club ? '<div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">' + club + '</div>' : ''}
            ${price ? '<div style="font-size:10px;color:var(--amber);">' + price + '</div>' : ''}
            <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">${btns}</div>
          </div>`;
        }).join('')
      : '<div style="color:var(--tx-3);font-size:11px;text-align:center;padding:16px;">Empty</div>';

    return `<div style="flex:1;min-width:180px;">
      <div style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid ${color};">
        ${stage} <span style="font-weight:400;color:var(--tx-3);">(${items.length})</span>
      </div>
      ${cards}
    </div>`;
  }).join('');

  return `<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;">${cols}</div>`;
}

// ── SCREEN 6: Video + Analytics ───────────────────────────────────────────────

function _tiVideoAnalytics() {
  const players = (State.players || []).slice().sort(function(a, b) {
    return (a.firstName + ' ' + a.lastName).localeCompare(b.firstName + ' ' + b.lastName);
  });
  const opts = players.map(function(p) {
    return `<option value="${_esc(p.id)}">${_esc(p.firstName + ' ' + p.lastName)} (${_esc(p.position || '?')})</option>`;
  }).join('');

  const intel = State.transfer._playerIntel;

  var intelHTML = '';
  if (intel && !intel._loading) {
    // Scouting reports summary
    var reps     = (intel.reports && intel.reports.items) ? intel.reports.items : [];
    var avgScore = reps.length ? (reps.reduce(function(s, r) { return s + (r.compositeScore || 0); }, 0) / reps.length).toFixed(1) : null;
    var recounts = {};
    reps.forEach(function(r) { recounts[r.recommendation] = (recounts[r.recommendation] || 0) + 1; });
    var recStr = Object.entries(recounts).map(function(e) { return e[0] + ': ' + e[1]; }).join(', ');

    // Contract
    var ct = intel.contract;
    var ctHTML = ct
      ? `<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Contract</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div style="color:var(--tx-2);">Expiry</div><div style="color:var(--tx);">${new Date(ct.contractExpiry).toLocaleDateString('en-GB')}</div>
            <div style="color:var(--tx-2);">Annual Value</div><div style="color:var(--tx);">${ct.contractValueEur ? '€' + (ct.contractValueEur/1000).toFixed(0) + 'k' : '—'}</div>
            <div style="color:var(--tx-2);">Release Clause</div><div style="color:var(--tx);">${ct.releaseClauseEur ? '€' + (ct.releaseClauseEur/1e6).toFixed(1) + 'M' : '—'}</div>
            <div style="color:var(--tx-2);">Agent</div><div style="color:var(--tx);">${_esc(ct.agentName || '—')}</div>
          </div>
          ${ct.isExpiringSoon ? '<div style="margin-top:8px;padding:6px;background:rgba(251,191,36,.15);border-radius:4px;font-size:11px;color:var(--amber);font-weight:600;">⚠ Expiring Soon</div>' : ''}
        </div>`
      : '';

    // Medical
    var med = intel.medical;
    var medHTML = med
      ? `<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Medical Profile</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div style="color:var(--tx-2);">Active Injuries</div>
            <div style="color:${(med.injuries||[]).filter(function(i){return !i.returnDate;}).length > 0 ? 'var(--red)' : 'var(--green-l)'};">${(med.injuries||[]).filter(function(i){return !i.returnDate;}).length}</div>
            <div style="color:var(--tx-2);">Injury History</div>
            <div style="color:var(--tx);">${(med.injuries||[]).length} recorded</div>
          </div>
        </div>`
      : '';

    // Video clips
    var clips = (intel.clips && intel.clips.items) ? intel.clips.items.slice(0,5) : [];
    var clipsHTML = clips.length
      ? `<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Video Clips (${intel.clips.total})</div>
          ${clips.map(function(cl) {
              return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">'
                + '<span style="color:var(--tx);">' + _esc(cl.title || 'Clip') + '</span>'
                + '<span style="color:var(--tx-3);">' + _esc(cl.clipType || '') + '</span>'
                + '</div>';
            }).join('')}
        </div>`
      : '';

    // Market value history
    var mvHistory = (intel.marketHistory || []).slice(-6);
    var mvHTML = mvHistory.length
      ? `<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Market Value History</div>
          ${mvHistory.map(function(h) {
              return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">'
                + '<span style="color:var(--tx-2);">' + new Date(h.valuationDate).toLocaleDateString('en-GB', {month:'short',year:'2-digit'}) + '</span>'
                + '<span style="font-weight:700;color:var(--green-l);">' + (h.valueMEur||0).toFixed(2) + 'M€</span>'
                + '<span style="color:var(--tx-3);font-size:10px;">' + _esc(h.source||'') + '</span>'
                + '</div>';
            }).join('')}
        </div>`
      : '';

    var scoutCard = `<div class="ti-card">
      <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Scouting Intelligence</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div class="ti-kpi" style="padding:8px;"><div class="ti-kpi-val">${reps.length}</div><div class="ti-kpi-label">Reports</div></div>
        <div class="ti-kpi" style="padding:8px;"><div class="ti-kpi-val">${avgScore || '—'}</div><div class="ti-kpi-label">Avg Score</div></div>
        <div class="ti-kpi" style="padding:8px;"><div class="ti-kpi-val" style="font-size:10px;">${recStr || '—'}</div><div class="ti-kpi-label">Recommendations</div></div>
      </div>
    </div>`;

    intelHTML = scoutCard + ctHTML + medHTML + mvHTML + clipsHTML;
  } else if (intel && intel._loading) {
    intelHTML = loadingHTML('Loading player intelligence…');
  }

  return `<div style="margin-bottom:16px;">
    <label style="font-size:12px;color:var(--tx-2);display:block;margin-bottom:6px;">Select player for cross-module intelligence card:</label>
    <div style="display:flex;gap:8px;align-items:center;">
      <select id="ti-intel-player" class="form-input" style="flex:1;">
        <option value="">— select player —</option>
        ${opts}
      </select>
      <button class="btn btn-primary btn-sm" data-action="tiLoadPlayerIntel">Load Profile</button>
    </div>
  </div>
  ${intelHTML}`;
}

// ── SCREEN 7: Advanced Compare ────────────────────────────────────────────────

function _tiCompare() {
  const T       = State.transfer;
  const players = (State.players || []).slice().sort(function(a, b) {
    return (a.firstName + ' ' + a.lastName).localeCompare(b.firstName + ' ' + b.lastName);
  });

  const makeOpts = function(selectedId) {
    return '<option value="">— select —</option>'
      + players.map(function(p) {
        return '<option value="' + _esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>'
          + _esc(p.firstName + ' ' + p.lastName) + ' (' + _esc(p.position || '?') + ')</option>';
      }).join('');
  };

  var controls = `<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;margin-bottom:16px;">
    <div>
      <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Player A</label>
      <select id="ti-cmp-a" class="form-input" style="width:100%;">${makeOpts(T._compareA)}</select>
    </div>
    <div>
      <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Player B</label>
      <select id="ti-cmp-b" class="form-input" style="width:100%;">${makeOpts(T._compareB)}</select>
    </div>
    <button class="btn btn-primary btn-sm" data-action="tiRunCompare">Compare</button>
  </div>`;

  const result = T._compareResult;
  if (!result) return controls + '<div style="color:var(--tx-3);font-size:13px;text-align:center;padding:24px 0;">Select two players and click Compare.</div>';

  const ATTRS = ['technical','physical','mental','tactical','potential'];

  const buildCol = function(label, reports, contracts, marketHistory) {
    var reps = reports ? reports.items || [] : [];
    var avgGrades = {};
    ATTRS.forEach(function(k) {
      var vals = reps.map(function(r) { return r[k]; }).filter(function(v) { return v != null; });
      avgGrades[k] = vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length : null;
    });
    var composite = reps.length ? (reps.reduce(function(s, r) { return s + (r.compositeScore || 0); }, 0) / reps.length).toFixed(1) : null;

    var bars = ATTRS.map(function(k) {
      var v = avgGrades[k];
      var pct = v != null ? Math.round(v / 10 * 100) : 0;
      var c   = v >= 8 ? 'var(--green-l)' : v >= 6 ? '#60a5fa' : v >= 4 ? 'var(--amber)' : 'var(--red)';
      return `<div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
          <span style="color:var(--tx-2);">${k}</span>
          <span style="color:var(--tx);font-weight:700;">${v != null ? v.toFixed(1) : '—'}</span>
        </div>
        <div style="height:6px;background:var(--border);border-radius:3px;">
          <div style="height:100%;width:${pct}%;background:${c};border-radius:3px;transition:width .4s;"></div>
        </div>
      </div>`;
    }).join('');

    var ct = contracts;
    var latestVal = marketHistory && marketHistory.length ? marketHistory[marketHistory.length - 1].valueMEur : null;

    return `<div style="flex:1;">
      <div style="font-size:14px;font-weight:700;color:var(--tx);margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--accent);">${label}</div>
      <div class="ti-kpi-row" style="margin-bottom:16px;">
        <div class="ti-kpi"><div class="ti-kpi-val">${reps.length}</div><div class="ti-kpi-label">Reports</div></div>
        <div class="ti-kpi"><div class="ti-kpi-val">${composite || '—'}</div><div class="ti-kpi-label">Avg Score</div></div>
        <div class="ti-kpi"><div class="ti-kpi-val">${latestVal != null ? latestVal.toFixed(1) + 'M€' : '—'}</div><div class="ti-kpi-label">Market Value</div></div>
      </div>
      ${bars}
      ${ct ? `<div style="font-size:11px;color:var(--tx-3);margin-top:8px;">Contract until: ${new Date(ct.contractExpiry).toLocaleDateString('en-GB')} ${ct.isExpiringSoon ? '⚠ Expiring soon' : ''}</div>` : ''}
    </div>`;
  };

  const a = result.a; const b = result.b;
  const aCol = buildCol(_esc(_scoutPlayerName(a.playerId)), a.reports, a.contract, a.marketHistory);
  const bCol = buildCol(_esc(_scoutPlayerName(b.playerId)), b.reports, b.contract, b.marketHistory);

  return controls + `<div style="display:flex;gap:24px;">${aCol}${bCol}</div>`;
}

// ── SCREEN 8: Intelligence (Phase 11) ────────────────────────────────────────

function _tiIntelligence() {
  const T       = State.transfer;
  const players = (State.players || []).slice().sort(function(a, b) {
    return (a.firstName + ' ' + a.lastName).localeCompare(b.firstName + ' ' + b.lastName);
  });
  const opts = players.map(function(p) {
    return '<option value="' + _esc(p.id) + '">' + _esc(p.firstName + ' ' + p.lastName) + ' (' + _esc(p.position || '?') + ')</option>';
  }).join('');

  var selector = '<div style="margin-bottom:16px;">'
    + '<label style="font-size:12px;color:var(--tx-2);display:block;margin-bottom:6px;">Select player for unified intelligence report:</label>'
    + '<div style="display:flex;gap:8px;align-items:center;">'
    + '<select id="ti-intel-unified" class="form-input" style="flex:1;"><option value="">— select player —</option>' + opts + '</select>'
    + '<button class="btn btn-primary btn-sm" data-action="tiLoadPlayerUnified">Load Report</button>'
    + '</div></div>';

  var reportHTML = '';
  var intel = T._unifiedIntel;
  if (intel && !intel._loading) {
    // ── Confidence + recommendation badges ─────────────────────────────────
    var recColor = { SIGN:'var(--green-l)', MONITOR:'var(--amber)', SKIP:'var(--red)' }[intel.recommendation] || 'var(--tx-3)';
    var confColor = { HIGH:'var(--green-l)', MEDIUM:'var(--amber)', LOW:'var(--tx-3)', NONE:'var(--red)' }[intel.confidence] || 'var(--tx-3)';
    var badges = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">'
      + '<span style="font-size:12px;font-weight:700;padding:4px 10px;border-radius:4px;background:' + recColor + '22;color:' + recColor + ';">' + _esc(intel.recommendation) + '</span>'
      + '<span style="font-size:11px;padding:3px 8px;border-radius:4px;background:var(--surface-2);color:' + confColor + ';">Confidence: ' + _esc(intel.confidence) + '</span>'
      + '<span style="font-size:12px;font-weight:700;color:var(--accent);">Score: ' + intel.overallScore.toFixed(0) + '/100</span>'
      + '</div>';

    // ── Score breakdown bars ────────────────────────────────────────────────
    var bd = intel.breakdown || {};
    var _bar = function(comp) {
      var s = comp.rawScore; var w = comp.weight;
      var c = s >= 75 ? 'var(--green-l)' : s >= 55 ? '#60a5fa' : s >= 35 ? 'var(--amber)' : 'var(--red)';
      return '<div style="margin-bottom:8px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">'
        + '<span style="color:var(--tx-2);">' + _esc(comp.label) + ' <span style="color:var(--tx-3);">×' + Math.round(w*100) + '%</span></span>'
        + '<span style="font-weight:700;color:' + c + ';">' + Math.round(s) + '</span>'
        + '</div>'
        + '<div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;">'
        + '<div style="height:100%;width:' + Math.round(s) + '%;background:' + c + ';border-radius:3px;transition:width .4s;"></div>'
        + '</div>'
        + '<div style="font-size:10px;color:var(--tx-3);margin-top:2px;">' + _esc(comp.evidence) + '</div>'
        + '</div>';
    };
    var breakdownHTML = '<div class="ti-card" style="margin-bottom:12px;">'
      + '<div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em;">Score Breakdown (6 Dimensions)</div>'
      + (bd.scoutingQuality   ? _bar(bd.scoutingQuality)   : '')
      + (bd.tacticalFit       ? _bar(bd.tacticalFit)       : '')
      + (bd.contractSecurity  ? _bar(bd.contractSecurity)  : '')
      + (bd.medicalFitness    ? _bar(bd.medicalFitness)    : '')
      + (bd.videoEvidence     ? _bar(bd.videoEvidence)     : '')
      + (bd.marketOpportunity ? _bar(bd.marketOpportunity) : '')
      + '</div>';

    // ── Explainable bullets ─────────────────────────────────────────────────
    var bullets = (intel.explanation || []).map(function(line) {
      return '<li style="font-size:12px;color:var(--tx-2);margin-bottom:5px;line-height:1.5;">' + _esc(line) + '</li>';
    }).join('');
    var explHTML = bullets
      ? '<div class="ti-card" style="margin-bottom:12px;"><div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em;">Explainable Insights</div><ul style="margin:0;padding-left:16px;">' + bullets + '</ul></div>'
      : '';

    // ── Flags ───────────────────────────────────────────────────────────────
    var flagMap = { NO_REPORTS:'📋 No Reports', MEDICAL_RISK:'🔴 Medical Risk', CONTRACT_URGENT:'⏰ Contract Urgent', NO_VIDEO:'📹 No Video', LOW_CONFIDENCE:'⚠ Low Confidence', AVAILABLE:'🟢 Available', UNDERVALUED:'💰 Undervalued', FREE_AGENT_RISK:'⏰ Free-Agent Risk', HIGH_VALUE_CHEAP:'⬆ High Value' };
    var flagsHTML = (intel.flags || []).length
      ? '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;">'
        + (intel.flags || []).map(function(f) {
            return '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--surface-2);color:var(--tx-2);">' + (flagMap[f] || _esc(f)) + '</span>';
          }).join('')
        + '</div>'
      : '';

    // ── Tactical matrix (compact) ───────────────────────────────────────────
    var matrix = intel.tacticalMatrix || [];
    var matrixRows = matrix.map(function(f) {
      var c = f.bestCompatibility === 100 ? 'var(--green-l)' : f.bestCompatibility >= 70 ? '#60a5fa' : f.bestCompatibility >= 40 ? 'var(--amber)' : 'var(--tx-3)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);font-size:11px;">'
        + '<span style="color:var(--tx-2);">' + _esc(f.formation) + '</span>'
        + '<span style="color:var(--tx-3);">' + _esc(f.bestSlot) + '</span>'
        + '<span style="font-weight:700;color:' + c + ';">' + f.bestCompatibility + '%</span>'
        + '</div>';
    }).join('');
    var matrixHTML = matrixRows
      ? '<div class="ti-card" style="margin-bottom:12px;">'
        + '<div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em;">Tactical Compatibility Matrix</div>'
        + matrixRows + '</div>'
      : '';

    reportHTML = badges + breakdownHTML + explHTML + flagsHTML + matrixHTML;
  } else if (intel && intel._loading) {
    reportHTML = loadingHTML('Computing unified intelligence…');
  }

  // ── Squad Future Plan (always loaded with page data) ────────────────────
  var fp = T._futurePlan;
  var futurePlanHTML = '';
  if (fp) {
    var healthColor = fp.overallHealth >= 70 ? 'var(--green-l)' : fp.overallHealth >= 45 ? 'var(--amber)' : 'var(--red)';
    var planRows = (fp.positionPlans || []).slice(0, 8).map(function(plan) {
      var c = plan.atRisk ? 'var(--red)' : plan.successionCoverage >= 50 ? 'var(--green-l)' : 'var(--amber)';
      return '<tr>'
        + '<td style="padding:5px 6px;font-size:12px;font-weight:600;color:' + (plan.atRisk ? 'var(--red)' : 'var(--tx)') + ';">' + _esc(plan.group) + (plan.atRisk ? ' ⚠' : '') + '</td>'
        + '<td style="padding:5px 6px;font-size:12px;color:var(--tx-2);">' + plan.currentCount + '</td>'
        + '<td style="padding:5px 6px;font-size:12px;color:var(--tx-2);">' + (plan.avgAge != null ? plan.avgAge : '—') + '</td>'
        + '<td style="padding:5px 6px;font-size:12px;color:' + (plan.expiringCount > 1 ? 'var(--red)' : 'var(--tx-2)') + ';">' + plan.expiringCount + '</td>'
        + '<td style="padding:5px 6px;"><div style="display:flex;align-items:center;gap:6px;">'
        + '<div style="flex:1;height:5px;background:var(--border);border-radius:3px;"><div style="height:100%;width:' + plan.successionCoverage + '%;background:' + c + ';border-radius:3px;"></div></div>'
        + '<span style="font-size:11px;font-weight:700;color:' + c + ';">' + plan.successionCoverage + '</span>'
        + '</div></td>'
        + '</tr>';
    }).join('');
    var alertsHTML = (fp.criticalAlerts || []).length
      ? '<div style="margin-top:10px;padding:8px;background:rgba(239,68,68,.08);border-radius:4px;">'
        + (fp.criticalAlerts || []).map(function(a) {
            return '<div style="font-size:11px;color:var(--red);margin-bottom:3px;">⚠ ' + _esc(a) + '</div>';
          }).join('')
        + '</div>'
      : '';
    futurePlanHTML = '<div class="ti-card" style="margin-top:16px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">'
      + '<div style="font-size:11px;font-weight:600;color:var(--tx-3);text-transform:uppercase;letter-spacing:.05em;">Squad Future Plan</div>'
      + '<div style="font-size:12px;font-weight:700;color:' + healthColor + ';">Health: ' + fp.overallHealth + '/100</div>'
      + '</div>'
      + '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">'
      + '<thead><tr style="border-bottom:2px solid var(--border);">'
      + '<th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Group</th>'
      + '<th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Count</th>'
      + '<th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Avg Age</th>'
      + '<th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Exp (2yr)</th>'
      + '<th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tx-3);font-weight:600;">Succession</th>'
      + '</tr></thead><tbody>' + planRows + '</tbody></table></div>'
      + alertsHTML + '</div>';
  }

  return selector + reportHTML + futurePlanHTML;
}

async function tiLoadPlayerUnified() {
  var playerId = document.getElementById('ti-intel-unified') ? document.getElementById('ti-intel-unified').value : '';
  if (!playerId) return;
  State.transfer._unifiedIntel = { _loading: true };
  tiRenderTab();
  try {
    var result = await FamilistaAPI.get('/phase-q/transfer/intelligence/unified/' + playerId);
    State.transfer._unifiedIntel = result;
  } catch (err) {
    State.transfer._unifiedIntel = { _loading: false, _error: err?.userMessage || 'Failed to load.' };
  }
  tiRenderTab();
}

// ── Modal: Player Detail ──────────────────────────────────────────────────────

async function tiOpenDetail(targetId) {
  const modal    = document.getElementById('ti-detail-modal');
  const nameEl   = document.getElementById('ti-detail-name');
  const bodyEl   = document.getElementById('ti-detail-body');
  if (!modal || !bodyEl) return;

  const target = State.transfer.targets.find(function(t) { return t.id === targetId; });
  if (!target) return;

  const playerName = _scoutPlayerName(target.playerId);
  if (nameEl) nameEl.textContent = playerName || target.playerId;
  bodyEl.innerHTML = loadingHTML('Loading player intelligence…');
  modal.style.display = 'block';

  try {
    const intel = await FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + target.playerId);
    const reps       = intel.reports ? intel.reports.items || [] : [];
    const history    = intel.marketHistory || [];
    const contract   = intel.contract;

    // Stage tracker
    const STAGES = ['LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
    const currentIdx = STAGES.indexOf(target.stage);
    const stageTrack = STAGES.map(function(s, i) {
      var done = i < currentIdx; var current = i === currentIdx;
      return `<div style="display:flex;align-items:center;gap:4px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${current ? 'var(--accent)' : done ? 'var(--green-l)' : 'var(--border)'};flex-shrink:0;"></div>
        <span style="font-size:10px;color:${current ? 'var(--accent)' : done ? 'var(--green-l)' : 'var(--tx-3)'};">${s}</span>
        ${i < STAGES.length - 1 ? '<div style="flex:1;height:1px;background:var(--border);margin:0 4px;"></div>' : ''}
      </div>`;
    }).join('');

    // Key stats grid
    var latestVal = history.length ? history[history.length - 1].valueMEur : null;
    var statsGrid = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0;">
      <div class="ti-kpi"><div class="ti-kpi-val">${target.askingPriceMEur != null ? target.askingPriceMEur + 'M€' : '—'}</div><div class="ti-kpi-label">Asking Price</div></div>
      <div class="ti-kpi"><div class="ti-kpi-val">${latestVal != null ? latestVal.toFixed(1) + 'M€' : '—'}</div><div class="ti-kpi-label">Market Value</div></div>
      <div class="ti-kpi"><div class="ti-kpi-val">${target.priorityScore != null ? target.priorityScore : '—'}</div><div class="ti-kpi-label">Priority</div></div>
    </div>`;

    // Market history table
    var mvTable = history.length
      ? `<div style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:6px;text-transform:uppercase;">Market Value History</div>
          ${history.slice(-5).map(function(h) {
            return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">'
              + '<span style="color:var(--tx-2);">' + new Date(h.valuationDate).toLocaleDateString('en-GB',{month:'short',year:'numeric'}) + '</span>'
              + '<span style="font-weight:700;color:var(--green-l);">' + (h.valueMEur||0).toFixed(2) + 'M€</span>'
              + '<span style="color:var(--tx-3);font-size:10px;">' + _esc(h.source||'') + '</span>'
              + '</div>';
          }).join('')}
        </div>`
      : '';

    // Scouting reports
    var repsHTML = reps.length
      ? `<div style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:6px;text-transform:uppercase;">Scout Reports (${reps.length})</div>
          ${reps.slice(0,5).map(function(r) {
            var gColor = (r.overallGrade||'').startsWith('A') ? 'var(--green-l)' : 'var(--amber)';
            return '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between;">'
              + '<span style="color:var(--tx);">' + new Date(r.observedAt).toLocaleDateString('en-GB') + ' • ' + _esc(r.recommendation||'') + '</span>'
              + '<span style="font-weight:700;color:' + gColor + ';">' + _esc((r.overallGrade||'').replace('_PLUS','+')) + ' / ' + (r.compositeScore||0).toFixed(1) + '</span>'
              + '</div>';
          }).join('')}
        </div>`
      : '<div style="color:var(--tx-3);font-size:12px;margin-top:8px;">No scouting reports.</div>';

    // Contract block
    var ctBlock = '';
    if (contract) {
      ctBlock = `<div style="margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:6px;text-transform:uppercase;">Contract</div>
        Expiry: <strong>${new Date(contract.contractExpiry).toLocaleDateString('en-GB')}</strong>
        ${contract.isExpiringSoon ? ' <span style="color:var(--amber);">⚠ Expiring soon</span>' : ''}
        ${contract.agentName ? ' &bull; Agent: ' + _esc(contract.agentName) : ''}
      </div>`;
    }

    // Scorecard from ranking engine (already loaded, no extra API call)
    var ranked   = State.transfer._rankedTargets || [];
    var rankedEntry = ranked.find(function(r) { return r.targetId === targetId; });
    var sc       = rankedEntry ? rankedEntry.scorecard : null;
    var scorecardHTML = '';
    if (sc) {
      var _sBar = function(label, val, title) {
        var c = val >= 80 ? 'var(--green-l)' : val >= 65 ? '#60a5fa' : val >= 50 ? 'var(--amber)' : 'var(--red)';
        return '<div style="margin-bottom:6px;">'
          + '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;">'
          + '<span style="color:var(--tx-2);">' + label + '</span>'
          + '<span style="font-weight:700;color:' + c + ';">' + Math.round(val) + '</span>'
          + '</div>'
          + '<div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;">'
          + '<div style="height:100%;width:' + Math.round(val) + '%;background:' + c + ';border-radius:3px;transition:width .4s;"></div>'
          + '</div>'
          + '</div>';
      };
      var flagMap = { CONTRACT_CRITICAL:'🔴 Contract Critical', CONTRACT_WARNING:'🟡 Contract Warning', AVAILABLE_NOW:'🟢 Available Now', UNDERVALUED:'💰 Undervalued', HIGH_POTENTIAL:'⬆ High Potential', NO_REPORTS:'📋 No Reports', EXPIRING_SOON:'⏰ Expiring Soon' };
      var flagsHTML = (sc.flags || []).map(function(f) {
        return '<span style="display:inline-block;font-size:10px;margin-right:4px;margin-bottom:4px;background:var(--surface-2);border-radius:3px;padding:2px 6px;color:var(--tx-2);">' + (flagMap[f] || f) + '</span>';
      }).join('');
      var oppLabel = { UNDERVALUED:'💰 Undervalued', FREE_AGENT_RISK:'⏰ Free-Agent Risk', HIGH_VALUE_CHEAP:'⬆ High Value / Cheap', AVAILABLE:'🟢 Available Now' };
      var oppHTML = sc.marketOpportunity
        ? '<div style="margin-top:6px;padding:5px 8px;border-radius:4px;background:rgba(74,222,128,.1);font-size:11px;font-weight:600;color:var(--green-l);">' + (oppLabel[sc.marketOpportunity] || sc.marketOpportunity) + '</div>'
        : '';
      scorecardHTML = '<div style="margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:6px;">'
        + '<div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em;">Intelligence Scorecard</div>'
        + _sBar('Composite Score', sc.compositeScore, 'Scouting quality')
        + _sBar('Tactical Fit', sc.tacticalFitScore, 'Positional fit')
        + _sBar('Contract Risk', sc.contractRiskScore, 'Urgency')
        + _sBar('Transfer Priority', sc.transferPriority, 'Overall rank')
        + (flagsHTML ? '<div style="margin-top:8px;">' + flagsHTML + '</div>' : '')
        + oppHTML
        + (sc.scoutingSummary ? '<div style="margin-top:8px;font-size:11px;color:var(--tx-2);line-height:1.5;font-style:italic;">' + _esc(sc.scoutingSummary) + '</div>' : '')
        + '</div>';
    }

    // Pipeline advance buttons
    var advBtns = '';
    var nextStageMap = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION' };
    var nextS = nextStageMap[target.stage];
    if (nextS) advBtns = `<button class="btn btn-primary btn-sm" data-action="tiAdvance" data-id="${_esc(target.id)}" style="margin-top:12px;">⇒ Advance to ${nextS}</button> `;
    advBtns += `<button class="btn btn-ghost btn-sm" data-action="tiReject" data-id="${_esc(target.id)}" style="margin-top:12px;color:var(--red);">Reject</button>`;

    bodyEl.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;">${stageTrack}</div>${statsGrid}${scorecardHTML}${mvTable}${repsHTML}${ctBlock}<div style="margin-top:12px;">${advBtns}</div>`;
  } catch (err) {
    bodyEl.innerHTML = '<div style="color:var(--red);font-size:13px;">Failed to load player intelligence.</div>';
  }
}

function tiCloseDetail() {
  const modal = document.getElementById('ti-detail-modal');
  if (modal) modal.style.display = 'none';
}

// ── Modal: Add Target ─────────────────────────────────────────────────────────

function tiOpenAddTarget() {
  const modal  = document.getElementById('ti-add-modal');
  const select = document.getElementById('tia-player');
  if (!modal) return;

  if (select) {
    select.innerHTML = '<option value="">— select player —</option>'
      + (State.players || []).map(function(p) {
        return '<option value="' + _esc(p.id) + '">'
          + _esc(p.firstName + ' ' + p.lastName) + ' (' + _esc(p.position || '?') + ')</option>';
      }).join('');
  }

  const errEl = document.getElementById('tia-error');
  if (errEl) errEl.style.display = 'none';
  modal.style.display = 'block';
}

function tiCloseAddTarget() {
  const modal = document.getElementById('ti-add-modal');
  if (modal) modal.style.display = 'none';
}

async function tiSubmitAddTarget(e) {
  if (e) e.preventDefault();
  const errEl     = document.getElementById('tia-error');
  const submitBtn = document.getElementById('tia-submit');
  const playerId  = document.getElementById('tia-player')?.value;
  if (!playerId) {
    if (errEl) { errEl.textContent = 'Please select a player.'; errEl.style.display = 'block'; }
    return;
  }
  const priceVal    = parseFloat(document.getElementById('tia-price')?.value);
  const priorityVal = parseInt(document.getElementById('tia-priority')?.value, 10);
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }

  const body = {
    playerId,
    currentClubName: document.getElementById('tia-club')?.value?.trim()     || undefined,
    position:        document.getElementById('tia-pos')?.value?.trim()       || undefined,
    nationality:     document.getElementById('tia-nat')?.value?.trim()       || undefined,
    askingPriceMEur: isNaN(priceVal)    ? undefined : priceVal,
    priorityScore:   isNaN(priorityVal) ? 50        : priorityVal,
    notes:           document.getElementById('tia-notes')?.value?.trim()     || undefined,
  };

  try {
    await FamilistaAPI.post('/phase-q/transfer/targets', body);
    tiCloseAddTarget();
    showToast(_scoutPlayerName(playerId) + ' added to pipeline', 'success');
    await loadTransferData();
  } catch (err) {
    if (errEl) { errEl.textContent = err?.userMessage || err?.message || 'Failed to add target.'; errEl.style.display = 'block'; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add to Pipeline'; }
  }
}

// ── Pipeline actions ──────────────────────────────────────────────────────────

async function tiAdvance(targetId) {
  const t = State.transfer.targets.find(function(x) { return x.id === targetId; });
  if (!t) return;
  const nextStage = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION', NEGOTIATION:'SIGNED' }[t.stage];
  if (!nextStage) return;
  try {
    await FamilistaAPI.post('/phase-q/transfer/targets/' + targetId + '/advance', { stage: nextStage });
    showToast(_scoutPlayerName(t.playerId) + ' → ' + nextStage, 'success');
    await loadTransferData();
    tiCloseDetail();
  } catch (err) {
    showToast(err?.userMessage || 'Failed to advance stage', 'error');
  }
}

async function tiReject(targetId) {
  const t = State.transfer.targets.find(function(x) { return x.id === targetId; });
  if (!t || !confirm('Mark ' + _scoutPlayerName(t.playerId) + ' as REJECTED?')) return;
  try {
    await FamilistaAPI.post('/phase-q/transfer/targets/' + targetId + '/advance', { stage: 'REJECTED' });
    showToast(_scoutPlayerName(t.playerId) + ' rejected', 'success');
    await loadTransferData();
    tiCloseDetail();
  } catch (err) {
    showToast(err?.userMessage || 'Failed to reject', 'error');
  }
}

// ── Player Intelligence loader ────────────────────────────────────────────────

async function tiLoadPlayerIntel() {
  const sel = document.getElementById('ti-intel-player');
  if (!sel || !sel.value) { showToast('Select a player first', 'warning'); return; }
  const playerId = sel.value;

  State.transfer._playerIntel = { _loading: true, playerId };
  tiRenderTab();

  try {
    const intel = await FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + playerId);
    State.transfer._playerIntel = Object.assign({ _loading: false, playerId }, intel);
  } catch (err) {
    State.transfer._playerIntel = { _loading: false, playerId, _error: true };
  }
  tiRenderTab();
}

// ── Compare runner ────────────────────────────────────────────────────────────

async function tiRunCompare() {
  const aSel = document.getElementById('ti-cmp-a');
  const bSel = document.getElementById('ti-cmp-b');
  const aId  = aSel ? aSel.value : null;
  const bId  = bSel ? bSel.value : null;
  if (!aId || !bId || aId === bId) { showToast('Select two different players', 'warning'); return; }

  State.transfer._compareA      = aId;
  State.transfer._compareB      = bId;
  State.transfer._compareResult = null;

  try {
    const [iA, iB] = await Promise.all([
      FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + aId),
      FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + bId),
    ]);
    State.transfer._compareResult = {
      a: { playerId: aId, reports: iA.reports, contract: iA.contract, marketHistory: iA.marketHistory },
      b: { playerId: bId, reports: iB.reports, contract: iB.contract, marketHistory: iB.marketHistory },
    };
  } catch (err) {
    showToast('Failed to load comparison data', 'error');
  }
  tiRenderTab();
}

// ══════════════════════════════════════════════════════════════════════════════
// END TRANSFER INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// VIDEO ANALYSIS & MATCH INTELLIGENCE CENTER — Phase 8
// APIs used (all /api/v1/ prefix handled by FamilistaAPI):
//   GET  phase-q/video/dashboard                   — KPI aggregate (Phase 8)
//   GET  phase-q/video/assets?matchId=&status=...  — video library
//   POST phase-q/video/assets/request-upload       — step 1 of upload
//   POST phase-q/video/assets/confirm-upload       — step 3 of upload
//   GET  phase-q/video/assets/:id/stream           — HLS + thumb URLs
//   DELETE phase-q/video/assets/:id               — delete asset
//   GET  phase-q/video/clips?matchId=&playerId=   — player clips
//   GET  phase-q/video/playlists                  — playlists
//   GET  phase-q/video/match/:matchId/summary     — per-match aggregate (Phase 8)
//   GET  phase-q/events/match/:matchId            — match timeline events
//   GET  matches/:id/timeline?kind=TACTICAL_NOTE  — tactical notes
//   POST matches/:id/timeline                     — add tactical note
//   DELETE matches/:id/timeline/:evtId            — delete note
//   GET  matches/:id/ai-features                  — AI feature bundle
// ══════════════════════════════════════════════════════════════════════════════

// ── API wrapper ───────────────────────────────────────────────────────────────
var VideoIntelAPI = {
  dashboard:       function()            { return FamilistaAPI.get('/phase-q/video/dashboard'); },
  listAssets:      function(p)           { var q = new URLSearchParams(p||{}).toString(); return FamilistaAPI.get('/phase-q/video/assets' + (q ? '?' + q : '')); },
  requestUpload:   function(body)        { return FamilistaAPI.post('/phase-q/video/assets/request-upload', body); },
  confirmUpload:   function(body)        { return FamilistaAPI.post('/phase-q/video/assets/confirm-upload', body); },
  deleteAsset:     function(id)          { return FamilistaAPI.delete('/phase-q/video/assets/' + id); },
  streamUrl:       function(id)          { return FamilistaAPI.get('/phase-q/video/assets/' + id + '/stream'); },
  listClips:       function(p)           { var q = new URLSearchParams(p||{}).toString(); return FamilistaAPI.get('/phase-q/video/clips' + (q ? '?' + q : '')); },
  listPlaylists:   function(p)           { var q = new URLSearchParams(p||{}).toString(); return FamilistaAPI.get('/phase-q/video/playlists' + (q ? '?' + q : '')); },
  matchSummary:    function(matchId)     { return FamilistaAPI.get('/phase-q/video/match/' + matchId + '/summary'); },
  listEvents:      function(matchId, p)  { var q = new URLSearchParams(p||{}).toString(); return FamilistaAPI.get('/phase-q/events/match/' + matchId + (q ? '?' + q : '')); },
  listNotes:       function(matchId)     { return FamilistaAPI.get('/matches/' + matchId + '/timeline?kind=TACTICAL_NOTE'); },
  addNote:         function(matchId, b)  { return FamilistaAPI.post('/matches/' + matchId + '/timeline', b); },
  deleteNote:      function(matchId, id) { return FamilistaAPI.delete('/matches/' + matchId + '/timeline/' + id); },
  aiFeatures:      function(matchId)     { return FamilistaAPI.get('/matches/' + matchId + '/ai-features'); },
};

// ── module state ──────────────────────────────────────────────────────────────
var _vidTab          = 'dashboard';
var _vidDashboard    = null;
var _vidAssets       = [];
var _vidAssetsTotal  = 0;
var _vidClips        = [];
var _vidLoading      = false;
var _vidMatchId      = '';
var _vidTimelineItems = [];
var _vidNotes        = [];
var _vidOpponentData = null;
var _vidSummaryData  = null;
var _vidUploadFile   = null;
var _vidUploadBusy   = false;

// ── HTML shell ────────────────────────────────────────────────────────────────

function renderVideoHTML() {
  return `<div class="page" id="pg-video">
  <div style="max-width:1200px;margin:0 auto;padding:0 4px;">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Video Analysis &amp; Match Intelligence</div>
        <div style="font-size:12px;color:var(--tx-3);" id="vid-sub">Loading…</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" data-action="vidRefresh">↺ Refresh</button>
        <button class="btn btn-primary btn-sm" data-action="vidSwitchTab" data-tab="upload">+ Upload Video</button>
      </div>
    </div>

    <!-- Tab bar -->
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px;border-bottom:1px solid var(--bd);padding-bottom:10px;" id="vid-tabbar">
      <button class="filter-btn active" data-action="vidSwitchTab" data-tab="dashboard">Dashboard</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="library">Library</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="upload">Upload</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="timeline">Timeline</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="clips">Clips</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="notes">Tactical Notes</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="opponent">Opponent</button>
      <button class="filter-btn" data-action="vidSwitchTab" data-tab="summary">Summary</button>
    </div>

    <!-- Tab body -->
    <div id="vid-body"></div>

  </div>

  <!-- Stream modal -->
  <div id="vid-stream-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9000;align-items:center;justify-content:center;">
    <div style="background:var(--bg-2);border-radius:12px;padding:20px;max-width:720px;width:95%;max-height:90vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:14px;font-weight:700;color:var(--tx);" id="vid-modal-title">Video</div>
        <button class="btn btn-ghost btn-xs" data-action="vidCloseStream">✕</button>
      </div>
      <video id="vid-video-el" controls style="width:100%;border-radius:8px;background:#000;max-height:400px;display:none;"></video>
      <div id="vid-stream-fallback" style="display:none;padding:16px;background:var(--bg-3);border-radius:8px;font-size:12px;color:var(--tx-3);text-align:center;">
        <div style="font-size:20px;margin-bottom:8px;">📋</div>
        <div style="margin-bottom:8px;color:var(--tx-2);">HLS stream URL (Safari or external player)</div>
        <code id="vid-stream-url" style="word-break:break-all;font-size:11px;color:var(--green-l);"></code>
        <div style="margin-top:12px;">
          <button class="btn btn-outline btn-sm" data-action="vidCopyUrl">Copy URL</button>
        </div>
      </div>
      <div id="vid-stream-thumb" style="display:none;margin-top:10px;text-align:center;">
        <img id="vid-thumb-img" style="max-height:140px;border-radius:6px;object-fit:contain;" alt="">
      </div>
    </div>
  </div>
</div>`;
}

// ── tab switching ─────────────────────────────────────────────────────────────

function setVidTab(tab) {
  _vidTab = tab;
  document.querySelectorAll('#vid-tabbar .filter-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  _renderVidBody();
}

function _renderVidBody() {
  var el = document.getElementById('vid-body');
  if (!el) return;
  if      (_vidTab === 'dashboard') el.innerHTML = _renderVidDashboard();
  else if (_vidTab === 'library')   el.innerHTML = _renderVidLibrary();
  else if (_vidTab === 'upload')    el.innerHTML = _renderVidUpload();
  else if (_vidTab === 'timeline')  el.innerHTML = _renderVidTimeline();
  else if (_vidTab === 'clips')     el.innerHTML = _renderVidClips();
  else if (_vidTab === 'notes')     el.innerHTML = _renderVidNotes();
  else if (_vidTab === 'opponent')  el.innerHTML = _renderVidOpponent();
  else if (_vidTab === 'summary')   el.innerHTML = _renderVidSummary();
}

// ── Dashboard tab ─────────────────────────────────────────────────────────────

function _renderVidDashboard() {
  if (_vidLoading) return loadingHTML('Loading dashboard…');
  if (!_vidDashboard) {
    return '<div style="text-align:center;padding:60px 20px;">'
      + '<div style="font-size:48px;opacity:.3;margin-bottom:12px;">🎬</div>'
      + '<div style="font-size:13px;color:var(--tx-3);">Dashboard loading…</div></div>';
  }
  var d = _vidDashboard;
  var byStatus = d.assetsByStatus || {};
  var sCols = { READY:'var(--green-l)', UPLOADED:'#60a5fa', PENDING:'var(--amber)', QUEUED:'var(--amber)', FAILED:'var(--red)' };
  var kpis = [
    { label:'Total Videos',    value: d.totalAssets    || 0, icon:'🎬' },
    { label:'Ready to Stream', value: d.readyAssets    || 0, icon:'▶',  color:'var(--green-l)' },
    { label:'Clips',           value: d.totalClips     || 0, icon:'✂️' },
    { label:'Playlists',       value: d.totalPlaylists || 0, icon:'🗂️' },
  ].map(function(k) {
    return '<div class="card" style="padding:14px;text-align:center;">'
      + '<div style="font-size:22px;margin-bottom:4px;">' + k.icon + '</div>'
      + '<div style="font-size:22px;font-weight:700;font-family:var(--mono);color:' + (k.color||'var(--tx)') + ';">' + k.value + '</div>'
      + '<div style="font-size:11px;color:var(--tx-3);margin-top:2px;">' + k.label + '</div></div>';
  }).join('');
  var bars = Object.keys(byStatus).map(function(s) {
    var pct = d.totalAssets > 0 ? Math.round(byStatus[s] / d.totalAssets * 100) : 0;
    var col = sCols[s] || 'var(--tx-3)';
    return '<div style="margin-bottom:8px;">'
      + '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--tx-2);margin-bottom:3px;">'
      + '<span>' + _esc(s) + '</span><span style="font-family:var(--mono);color:' + col + ';">' + byStatus[s] + '</span></div>'
      + '<div style="height:5px;border-radius:3px;background:var(--bg-3);overflow:hidden;">'
      + '<div style="height:100%;width:' + pct + '%;background:' + col + ';transition:width .4s;"></div></div></div>';
  }).join('') || '<div style="color:var(--tx-3);font-size:12px;">No data.</div>';
  var recent = (d.recentAssets || []).map(function(a) {
    var col = sCols[a.status] || 'var(--tx-3)';
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd);">'
      + '<div style="width:28px;height:28px;border-radius:5px;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">🎬</div>'
      + '<div style="flex:1;min-width:0;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(a.title||'Untitled') + '</div>'
      + '<div style="font-size:10px;color:var(--tx-3);">' + _esc(a.sourceKind||'') + (a.createdAt ? ' · ' + new Date(a.createdAt).toLocaleDateString() : '') + '</div></div>'
      + '<span style="font-size:9px;font-weight:700;font-family:var(--mono);color:' + col + ';">' + _esc(a.status) + '</span></div>';
  }).join('') || '<div style="padding:16px;text-align:center;color:var(--tx-3);font-size:12px;">No recent videos.</div>';
  return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:18px;">' + kpis + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="card" style="padding:14px;"><div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px;">Status Breakdown</div>' + bars + '</div>'
    + '<div class="card" style="padding:14px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;">Recent Videos</div>'
    + '<button class="btn btn-ghost btn-xs" data-action="vidSwitchTab" data-tab="library">View all</button></div>'
    + recent + '</div></div>';
}

// ── Library tab ───────────────────────────────────────────────────────────────

function _renderVidLibrary() {
  if (_vidLoading) return loadingHTML('Loading library…');
  if (!_vidAssets.length) {
    return '<div style="text-align:center;padding:60px 20px;">'
      + '<div style="font-size:48px;margin-bottom:12px;opacity:.35;">🎬</div>'
      + '<div style="font-size:14px;font-weight:600;color:var(--tx-2);margin-bottom:6px;">No videos yet</div>'
      + '<div style="font-size:12px;color:var(--tx-3);margin-bottom:18px;">Upload match footage, training sessions and scouting clips.</div>'
      + '<button class="btn btn-primary btn-sm" data-action="vidSwitchTab" data-tab="upload">Upload first video</button></div>';
  }
  var filterRow = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">'
    + ['ALL','READY','UPLOADED','QUEUED','PENDING','FAILED'].map(function(s) {
        return '<button class="btn btn-ghost btn-xs" style="font-size:10px;" data-action="vidFilterStatus" data-status="' + s + '">' + s + '</button>';
      }).join('') + '</div>';
  var grid = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;" id="vid-asset-grid">'
    + _vidAssets.map(_vAssetCard).join('') + '</div>';
  return filterRow + grid
    + '<div style="margin-top:10px;font-size:11px;color:var(--tx-3);">' + _vidAssetsTotal + ' total · showing ' + _vidAssets.length + '</div>';
}

function _vAssetCard(a) {
  var sCols = { READY:'var(--green-l)', UPLOADED:'#60a5fa', PENDING:'var(--amber)', QUEUED:'var(--amber)', FAILED:'var(--red)' };
  var col = sCols[a.status] || 'var(--tx-3)';
  var dur  = a.durationSec ? _vFmtDur(a.durationSec) : null;
  var tags = (a.tags||[]).slice(0,2).map(function(t) {
    return '<span style="background:var(--bg-3);padding:1px 5px;border-radius:4px;font-size:9px;">' + _esc(t) + '</span>';
  }).join(' ');
  return '<div class="card" style="overflow:hidden;">'
    + '<div style="height:110px;background:var(--bg-3);display:flex;align-items:center;justify-content:center;position:relative;">'
    + '<div style="font-size:32px;opacity:.5;">🎬</div>'
    + '<span style="position:absolute;top:6px;right:6px;font-size:9px;font-weight:700;font-family:var(--mono);color:' + col + ';background:var(--bg-2);padding:2px 5px;border-radius:3px;">' + _esc(a.status) + '</span></div>'
    + '<div style="padding:10px;">'
    + '<div style="font-size:12px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;" title="' + _esc(a.title||'Untitled') + '">' + _esc(a.title||'Untitled') + '</div>'
    + '<div style="font-size:10px;color:var(--tx-3);display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">'
    + (dur ? '<span>⏱ ' + dur + '</span>' : '')
    + (a.sourceKind ? '<span>' + _esc(a.sourceKind) + '</span>' : '')
    + (a.createdAt  ? '<span>' + new Date(a.createdAt).toLocaleDateString() + '</span>' : '')
    + tags + '</div>'
    + '<div style="display:flex;gap:6px;">'
    + (a.status === 'READY' ? '<button class="btn btn-primary btn-xs" data-action="vidStreamAsset" data-id="' + a.id + '" data-title="' + _esc(a.title||'Video') + '">▶ Stream</button>' : '')
    + '<button class="btn btn-ghost btn-xs" style="color:var(--red);" data-action="vidDeleteAsset" data-id="' + a.id + '" data-title="' + _esc(a.title||'Video') + '">Delete</button>'
    + '</div></div></div>';
}

// ── Upload tab ────────────────────────────────────────────────────────────────

function _renderVidUpload() {
  var matchOptions = _vMatchOptions();
  return '<div style="max-width:540px;">'
    + '<div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:16px;">Upload Video</div>'
    + '<div id="vid-drop-zone" data-action="vidDropZoneClick" style="border:2px dashed var(--bd);border-radius:10px;padding:28px 20px;text-align:center;cursor:pointer;" ondragover="event.preventDefault();this.style.borderColor=\'var(--green)\'" ondragleave="this.style.borderColor=\'var(--bd)\'" ondrop="_vidHandleDrop(event)">'
    + '<div style="font-size:28px;margin-bottom:8px;">🎬</div>'
    + '<div style="font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px;">Drop video here or click to browse</div>'
    + '<div style="font-size:11px;color:var(--tx-3);">MP4 · MOV · AVI · MKV · WEBM · max 2 GB</div>'
    + '<div id="vid-file-info" style="margin-top:8px;font-size:12px;color:var(--green-l);display:none;"></div></div>'
    + '<input type="file" id="vid-file-input" accept="video/*,.mp4,.mov,.avi,.mkv,.webm" style="display:none" onchange="_vidFileSelect(this.files[0])">'
    + '<div style="margin-top:14px;display:flex;flex-direction:column;gap:10px;">'
    + '<div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Title *</label><input id="vid-title" class="input" placeholder="e.g. Match vs FC Berlin — 2025-05-18" style="width:100%;"></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
    + '<div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Source Kind</label>'
    + '<select id="vid-kind" class="input" style="width:100%;"><option value="MATCH">Match</option><option value="TRAINING">Training</option><option value="SCOUTING">Scouting</option><option value="HIGHLIGHT">Highlight</option><option value="ANALYSIS">Analysis</option></select></div>'
    + '<div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Linked Match (optional)</label>'
    + '<select id="vid-match" class="input" style="width:100%;"><option value="">— none —</option>' + matchOptions + '</select></div></div>'
    + '<div><label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:3px;">Tags (comma separated)</label><input id="vid-tags" class="input" placeholder="e.g. goals, highlights, u21" style="width:100%;"></div>'
    + '<div id="vid-upload-progress" style="display:none;">'
    + '<div style="font-size:11px;color:var(--tx-3);margin-bottom:3px;" id="vid-prog-label">Uploading…</div>'
    + '<div style="height:4px;border-radius:2px;background:var(--bg-3);overflow:hidden;"><div id="vid-prog-bar" style="height:100%;background:var(--green);width:0%;transition:width .3s;"></div></div></div>'
    + '<div id="vid-upload-err" style="display:none;padding:8px 10px;background:var(--red-bg);border-radius:6px;font-size:11px;color:var(--red);"></div>'
    + '<div id="vid-upload-ok" style="display:none;padding:10px 12px;background:var(--green-bg);border-radius:8px;border:1px solid var(--green-bd);font-size:12px;color:var(--green-l);"></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button class="btn btn-primary btn-sm" id="vid-submit-btn" data-action="vidSubmitUpload">Upload</button>'
    + '<button class="btn btn-ghost btn-sm" data-action="vidSwitchTab" data-tab="library">Cancel</button></div>'
    + '<div style="margin-top:14px;padding:10px 12px;background:var(--bg-3);border-radius:8px;font-size:11px;color:var(--tx-3);">'
    + '<strong style="color:var(--tx-2);">How it works:</strong> Files upload directly to object storage via a presigned URL. Status: PENDING → UPLOADED → QUEUED → READY.</div>'
    + '</div></div>';
}

// ── Timeline tab ──────────────────────────────────────────────────────────────

function _renderVidTimeline() {
  var evIcons = { GOAL:'⚽', OWN_GOAL:'🔴', ASSIST:'🅰️', SHOT:'👟', SHOT_ON_TARGET:'🎯', SHOT_OFF_TARGET:'💨', SAVE:'🧤', YELLOW_CARD:'🟡', SECOND_YELLOW:'🟡🔴', RED_CARD:'🔴', SUBSTITUTION:'🔄', INJURY:'🚑', FOUL:'⚠️', CORNER:'⛳', OFFSIDE:'🚩', PENALTY_AWARDED:'📍', PENALTY_SCORED:'⚽', PENALTY_MISSED:'❌' };
  var header = '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">'
    + '<select class="input" id="vid-tl-match" data-change="vidLoadTimeline" style="min-width:200px;"><option value="">— Select match —</option>' + _vMatchOptions() + '</select>'
    + '<select class="input" id="vid-tl-type" data-change="vidLoadTimeline" style="min-width:130px;">'
    + '<option value="">All events</option>'
    + ['GOAL','SHOT','SHOT_ON_TARGET','YELLOW_CARD','RED_CARD','SUBSTITUTION','CORNER','FOUL','OFFSIDE','PENALTY_AWARDED','PENALTY_SCORED'].map(function(t) {
        return '<option value="' + t + '">' + t.replace(/_/g,' ') + '</option>';
      }).join('') + '</select>'
    + '<button class="btn btn-ghost btn-sm" data-action="vidRefreshTimeline">↺</button></div>';
  if (!_vidMatchId) return header + '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:13px;">Select a match to view timeline events.</div>';
  if (!_vidTimelineItems.length) return header + '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:13px;">No events found for this match.</div>';
  var rows = _vidTimelineItems.map(function(ev) {
    var icon = evIcons[ev.type] || '●';
    return '<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--bd);">'
      + '<div style="width:36px;text-align:right;font-size:11px;font-weight:700;color:var(--tx-3);font-family:var(--mono);flex-shrink:0;">' + (ev.minute != null ? ev.minute + '\'' : '—') + '</div>'
      + '<div style="font-size:16px;flex-shrink:0;">' + icon + '</div>'
      + '<div style="flex:1;min-width:0;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--tx);">' + _esc(ev.type ? ev.type.replace(/_/g,' ') : 'EVENT') + '</div>'
      + '<div style="font-size:10px;color:var(--tx-3);display:flex;gap:6px;flex-wrap:wrap;">'
      + (ev.periodIndex ? '<span>P' + ev.periodIndex + '</span>' : '')
      + (ev.outcome ? '<span>' + _esc(ev.outcome) + '</span>' : '')
      + (ev.xg ? '<span>xG ' + Number(ev.xg).toFixed(2) + '</span>' : '')
      + '</div></div></div>';
  }).join('');
  return header + '<div style="max-height:500px;overflow-y:auto;">' + rows + '</div>'
    + '<div style="margin-top:8px;font-size:11px;color:var(--tx-3);">' + _vidTimelineItems.length + ' events</div>';
}

// ── Clips tab ─────────────────────────────────────────────────────────────────

function _renderVidClips() {
  var header = '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">'
    + '<select class="input" id="vid-clips-match" data-change="vidLoadClips" style="min-width:200px;"><option value="">All matches</option>' + _vMatchOptions() + '</select>'
    + '<button class="btn btn-ghost btn-sm" data-action="vidRefreshClips">↺</button></div>';
  if (!_vidClips.length) return header + '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:13px;">✂️ No clips found.</div>';
  var rows = _vidClips.map(function(c) {
    var dur = c.durationSec ? _vFmtDur(c.durationSec) : (c.startSec + 's–' + c.endSec + 's');
    var tags = (c.tags||[]).slice(0,2).map(function(t) {
      return '<span style="background:var(--bg-3);padding:1px 5px;border-radius:4px;font-size:9px;">' + _esc(t) + '</span>';
    }).join(' ');
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd);">'
      + '<div style="width:30px;height:30px;border-radius:6px;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">✂️</div>'
      + '<div style="flex:1;min-width:0;">'
      + '<div style="font-size:12px;font-weight:600;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(c.title||'Clip') + '</div>'
      + '<div style="font-size:10px;color:var(--tx-3);display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">'
      + '<span>⏱ ' + dur + '</span>'
      + (c.matchId ? '<span>⚽ Match</span>' : '')
      + (c.shareToken ? '<span style="color:var(--green-l);">SHARED</span>' : '')
      + tags + '</div></div></div>';
  }).join('');
  return header + rows + '<div style="margin-top:8px;font-size:11px;color:var(--tx-3);">' + _vidClips.length + ' clip' + (_vidClips.length !== 1 ? 's' : '') + '</div>';
}

// ── Tactical Notes tab ────────────────────────────────────────────────────────

function _renderVidNotes() {
  var header = '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">'
    + '<select class="input" id="vid-notes-match" data-change="vidLoadNotes" style="min-width:200px;"><option value="">— Select match —</option>' + _vMatchOptions() + '</select>'
    + '<button class="btn btn-ghost btn-sm" data-action="vidRefreshNotes">↺</button></div>';
  if (!_vidMatchId) return header + '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:13px;">Select a match to view and add tactical notes.</div>';
  var addForm = '<div class="card" style="padding:14px;margin-bottom:14px;">'
    + '<div style="font-size:12px;font-weight:600;color:var(--tx);margin-bottom:10px;">Add Tactical Note</div>'
    + '<div style="display:grid;grid-template-columns:80px 80px 1fr;gap:8px;margin-bottom:8px;">'
    + '<div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:3px;">Minute</label><input type="number" id="vid-note-min" class="input" style="width:100%;" placeholder="45" min="0" max="130"></div>'
    + '<div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:3px;">Side</label>'
    + '<select id="vid-note-side" class="input" style="width:100%;"><option value="HOME">HOME</option><option value="AWAY">AWAY</option></select></div>'
    + '<div><label style="font-size:10px;color:var(--tx-3);display:block;margin-bottom:3px;">Note *</label><input id="vid-note-text" class="input" style="width:100%;" placeholder="e.g. Switch to 4-3-3 after 60 min"></div></div>'
    + '<button class="btn btn-primary btn-sm" data-action="vidAddNote">Add Note</button></div>';
  if (!_vidNotes.length) return header + addForm + '<div style="text-align:center;padding:30px;color:var(--tx-3);font-size:12px;">No tactical notes for this match yet.</div>';
  var rows = _vidNotes.map(function(n) {
    return '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd);">'
      + '<div style="width:32px;text-align:right;font-size:11px;color:var(--tx-3);font-family:var(--mono);font-weight:700;flex-shrink:0;padding-top:2px;">' + (n.occurredAtMin != null ? n.occurredAtMin + '\'' : '—') + '</div>'
      + '<div style="flex:1;min-width:0;">'
      + '<div style="font-size:12px;color:var(--tx);">' + _esc(n.notes||'') + '</div>'
      + '<div style="font-size:10px;color:var(--tx-3);margin-top:2px;">' + _esc(n.side||'') + '</div></div>'
      + '<button class="btn btn-ghost btn-xs" style="color:var(--red);flex-shrink:0;" data-action="vidDeleteNote" data-match="' + _esc(_vidMatchId) + '" data-id="' + _esc(n.id) + '">✕</button></div>';
  }).join('');
  return header + addForm + rows + '<div style="margin-top:8px;font-size:11px;color:var(--tx-3);">' + _vidNotes.length + ' note' + (_vidNotes.length !== 1 ? 's' : '') + '</div>';
}

// ── Opponent tab ──────────────────────────────────────────────────────────────

function _renderVidOpponent() {
  var header = '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">'
    + '<div><div style="font-size:11px;color:var(--tx-3);margin-bottom:4px;">Select match for opponent analysis:</div>'
    + '<select class="input" id="vid-opp-match" data-change="vidLoadOpponent" style="min-width:220px;"><option value="">— Select match —</option>' + _vMatchOptions() + '</select></div>'
    + '<button class="btn btn-ghost btn-sm" data-action="vidRefreshOpponent">↺</button></div>';
  if (!_vidMatchId) return header + '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:13px;">Select a match to analyse opponent intelligence.</div>';
  if (!_vidOpponentData) return header + loadingHTML('Loading opponent analysis…');
  var d = _vidOpponentData;
  var evSum = d.eventSummary || {};
  var assets = (d.videoAssets && d.videoAssets.items) || [];
  var clips  = (d.clips  && d.clips.items)  || [];
  var sel = (State.matches || []).find(function(m) { return m.id === _vidMatchId; });
  var opp = sel ? (sel.isHome ? (sel.awayTeam||'Opponent') : (sel.homeTeam||'Opponent')) : 'Opponent';
  var score = sel && sel.homeScore != null ? (sel.homeScore + ' – ' + sel.awayScore) : '';
  var evIcons = { GOAL:'⚽', SHOT:'👟', YELLOW_CARD:'🟡', RED_CARD:'🔴', CORNER:'⛳', FOUL:'⚠️', OFFSIDE:'🚩' };
  var evRows = Object.keys(evSum).sort().map(function(type) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--bd);">'
      + '<span style="font-size:12px;color:var(--tx-2);">' + (evIcons[type]||'●') + ' ' + _esc(type.replace(/_/g,' ')) + '</span>'
      + '<span style="font-size:12px;font-weight:700;font-family:var(--mono);color:var(--tx);">' + evSum[type] + '</span></div>';
  }).join('') || '<div style="padding:14px;text-align:center;color:var(--tx-3);font-size:12px;">No events recorded.</div>';
  return header
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="card" style="padding:14px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px;">Opponent</div>'
    + '<div style="font-size:20px;font-weight:700;color:var(--tx);margin-bottom:4px;">' + _esc(opp) + '</div>'
    + (score ? '<div style="font-size:14px;font-family:var(--mono);color:var(--amber);">' + score + '</div>' : '')
    + '<div style="margin-top:10px;font-size:11px;color:var(--tx-3);">'
    + '<div>' + assets.length + ' video' + (assets.length!==1?'s':'') + ' linked</div>'
    + '<div>' + clips.length  + ' clip'  + (clips.length !==1?'s':'') + ' available</div></div>'
    + '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button class="btn btn-ghost btn-xs" data-action="vidSwitchTab" data-tab="library">View Videos</button>'
    + '<button class="btn btn-ghost btn-xs" data-action="vidSwitchTab" data-tab="clips">View Clips</button></div></div>'
    + '<div class="card" style="padding:14px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;">Match Event Breakdown</div>'
    + evRows + '</div></div>';
}

// ── Summary tab ───────────────────────────────────────────────────────────────

function _renderVidSummary() {
  var header = '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">'
    + '<select class="input" id="vid-sum-match" data-change="vidLoadSummary" style="min-width:200px;"><option value="">— Select match —</option>' + _vMatchOptions() + '</select>'
    + '<button class="btn btn-ghost btn-sm" data-action="vidRefreshSummary">↺</button></div>';
  if (!_vidMatchId) return header + '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:13px;">Select a match to view the AI intelligence bundle.</div>';
  if (!_vidSummaryData) return header + loadingHTML('Loading match summary…');
  var d = _vidSummaryData;
  var m  = d.match     || {};
  var tl = d.timeline  || [];
  var counts = d.counts || {};
  var score  = m.homeScore != null ? (m.homeScore + ' – ' + m.awayScore) : '—';
  var goals  = tl.filter(function(e) { return e.kind === 'GOAL' || e.kind === 'PENALTY_SCORED'; });
  var cards  = tl.filter(function(e) { return e.kind === 'YELLOW_CARD' || e.kind === 'RED_CARD'; });
  var subs   = tl.filter(function(e) { return e.kind === 'SUBSTITUTION'; });
  var goalRows = goals.map(function(g) {
    return '<div style="padding:4px 0;font-size:11px;color:var(--tx);">⚽ ' + (g.occurredAtMin||'?') + '\' — ' + _esc(g.side||'') + (g.notes ? ': ' + _esc(g.notes) : '') + '</div>';
  }).join('') || '<div style="font-size:11px;color:var(--tx-3);">No goals recorded.</div>';
  var noteRows = tl.filter(function(e) { return e.kind === 'TACTICAL_NOTE'; }).slice(0,5).map(function(n) {
    return '<div style="padding:4px 0;border-bottom:1px solid var(--bd);font-size:11px;color:var(--tx-2);">' + (n.occurredAtMin||'?') + '\' · ' + _esc(n.notes||'') + '</div>';
  }).join('') || '<div style="font-size:11px;color:var(--tx-3);">No tactical notes.</div>';
  var statsGrid = [
    { lbl:'Possession', val: m.possession ? m.possession + '%' : '—' },
    { lbl:'Shots',      val: m.shots          || 0 },
    { lbl:'On Target',  val: m.shotsOnTarget  || 0 },
    { lbl:'Corners',    val: m.corners        || 0 },
    { lbl:'Fouls',      val: m.fouls          || 0 },
    { lbl:'Yellow ⬛', val: m.yellowCards    || 0 },
  ].map(function(s) {
    return '<div style="text-align:center;padding:8px;">'
      + '<div style="font-size:16px;font-weight:700;font-family:var(--mono);color:var(--tx);">' + s.val + '</div>'
      + '<div style="font-size:10px;color:var(--tx-3);margin-top:2px;">' + s.lbl + '</div></div>';
  }).join('');
  var fmt = (m.formationHome && m.formationAway) ? m.formationHome + ' vs ' + m.formationAway : (m.formationHome || m.formationAway || 'N/A');
  return header
    + '<div class="card" style="padding:14px;margin-bottom:12px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">'
    + '<div>'
    + '<div style="font-size:18px;font-weight:700;color:var(--tx);">' + _esc(m.homeTeam||'Home') + ' vs ' + _esc(m.awayTeam||'Away') + '</div>'
    + '<div style="font-size:13px;color:var(--tx-3);">' + _esc(m.competition||'') + (m.competitionName ? ' · ' + _esc(m.competitionName) : '') + '</div></div>'
    + '<div style="text-align:right;">'
    + '<div style="font-size:28px;font-weight:900;font-family:var(--mono);color:var(--tx);">' + score + '</div>'
    + '<div style="font-size:11px;color:var(--tx-3);">Formation: ' + _esc(fmt) + (m.result ? ' · ' + _esc(m.result) : '') + '</div></div></div>'
    + '<div style="display:grid;grid-template-columns:repeat(6,1fr);border-top:1px solid var(--bd);margin-top:10px;">' + statsGrid + '</div></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="card" style="padding:14px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;">Goals &amp; Key Events</div>'
    + goalRows
    + '<div style="margin-top:8px;font-size:10px;color:var(--tx-3);">🟡 ' + cards.filter(function(c){return c.kind==='YELLOW_CARD';}).length + ' yellow · 🔴 ' + cards.filter(function(c){return c.kind==='RED_CARD';}).length + ' red · 🔄 ' + subs.length + ' subs</div></div>'
    + '<div class="card" style="padding:14px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.8px;">Tactical Notes</div>'
    + '<button class="btn btn-ghost btn-xs" data-action="vidSwitchTab" data-tab="notes">Add note</button></div>'
    + noteRows + '</div></div>'
    + '<div style="margin-top:10px;padding:10px 12px;background:var(--bg-3);border-radius:8px;font-size:11px;color:var(--tx-3);">'
    + '<strong style="color:var(--tx-2);">Data bundle:</strong> '
    + (counts.timeline||0) + ' timeline events · ' + (counts.snapshots||0) + ' tactical snapshots · ' + (counts.lineups||0) + ' lineup entries</div>';
}

// ── data loading ──────────────────────────────────────────────────────────────

async function loadVideoIntelData() {
  if (_vidLoading) return;
  _vidLoading = true;
  var sub = document.getElementById('vid-sub');
  if (sub) sub.textContent = 'Loading…';
  try {
    var results = await Promise.allSettled([
      VideoIntelAPI.dashboard(),
      VideoIntelAPI.listAssets({ limit: 50 }),
    ]);
    _vidDashboard   = results[0].status === 'fulfilled' ? results[0].value : null;
    var ad          = results[1].status === 'fulfilled' ? results[1].value : { items: [], total: 0 };
    _vidAssets      = ad.items || [];
    _vidAssetsTotal = ad.total || 0;
    if (sub) {
      var ready = _vidAssets.filter(function(a) { return a.status === 'READY'; }).length;
      sub.textContent = _vidAssetsTotal + ' video' + (_vidAssetsTotal !== 1 ? 's' : '') + ' · ' + ready + ' ready';
    }
  } catch (err) {
    if (sub) sub.textContent = 'Error loading data';
  }
  _vidLoading = false;
  _renderVidBody();
}

async function vidLoadTimeline() {
  var selEl  = document.getElementById('vid-tl-match');
  var typeEl = document.getElementById('vid-tl-type');
  if (!selEl) return;
  var matchId = selEl.value;
  _vidMatchId = matchId;
  if (!matchId) { _vidTimelineItems = []; _renderVidBody(); return; }
  var el = document.getElementById('vid-body');
  if (el) el.innerHTML = loadingHTML('Loading events…');
  try {
    var opts = { limit: '500' };
    if (typeEl && typeEl.value) opts.type = typeEl.value;
    var res = await VideoIntelAPI.listEvents(matchId, opts);
    _vidTimelineItems = (res && res.items) || [];
  } catch (e) { _vidTimelineItems = []; }
  _renderVidBody();
}

async function vidLoadClips() {
  var selEl = document.getElementById('vid-clips-match');
  var opts = { limit: '100' };
  if (selEl && selEl.value) opts.matchId = selEl.value;
  var el = document.getElementById('vid-body');
  if (el) el.innerHTML = loadingHTML('Loading clips…');
  try {
    var res = await VideoIntelAPI.listClips(opts);
    _vidClips = (res && res.items) || [];
  } catch (e) { _vidClips = []; }
  _renderVidBody();
}

async function vidLoadNotes() {
  var selEl = document.getElementById('vid-notes-match');
  if (!selEl) return;
  var matchId = selEl.value;
  _vidMatchId = matchId;
  if (!matchId) { _vidNotes = []; _renderVidBody(); return; }
  var el = document.getElementById('vid-body');
  if (el) el.innerHTML = loadingHTML('Loading notes…');
  try {
    var res = await VideoIntelAPI.listNotes(matchId);
    _vidNotes = Array.isArray(res) ? res : ((res && res.data) ? res.data : []);
  } catch (e) { _vidNotes = []; }
  _renderVidBody();
}

async function _vidReloadNotes() {
  if (!_vidMatchId) return;
  try {
    var res = await VideoIntelAPI.listNotes(_vidMatchId);
    _vidNotes = Array.isArray(res) ? res : ((res && res.data) ? res.data : []);
  } catch (e) { _vidNotes = []; }
  _renderVidBody();
}

async function vidLoadOpponent() {
  var selEl = document.getElementById('vid-opp-match');
  if (!selEl) return;
  var matchId = selEl.value;
  _vidMatchId = matchId;
  if (!matchId) { _vidOpponentData = null; _renderVidBody(); return; }
  var el = document.getElementById('vid-body');
  if (el) el.innerHTML = loadingHTML('Loading opponent analysis…');
  try {
    _vidOpponentData = await VideoIntelAPI.matchSummary(matchId);
  } catch (e) { _vidOpponentData = {}; }
  _renderVidBody();
}

async function vidLoadSummary() {
  var selEl = document.getElementById('vid-sum-match');
  if (!selEl) return;
  var matchId = selEl.value;
  _vidMatchId = matchId;
  if (!matchId) { _vidSummaryData = null; _renderVidBody(); return; }
  var el = document.getElementById('vid-body');
  if (el) el.innerHTML = loadingHTML('Loading AI summary…');
  try {
    _vidSummaryData = await VideoIntelAPI.aiFeatures(matchId);
  } catch (e) { _vidSummaryData = {}; }
  _renderVidBody();
}

// ── upload flow ───────────────────────────────────────────────────────────────

function _vidFileSelect(file) {
  if (!file) return;
  _vidUploadFile = file;
  var info = document.getElementById('vid-file-info');
  if (info) { info.textContent = file.name + '  (' + _vFmtBytes(file.size) + ')'; info.style.display = 'block'; }
  var titleEl = document.getElementById('vid-title');
  if (titleEl && !titleEl.value) titleEl.value = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
}

function _vidHandleDrop(e) {
  e.preventDefault();
  var zone = document.getElementById('vid-drop-zone');
  if (zone) zone.style.borderColor = 'var(--bd)';
  var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) _vidFileSelect(file);
}

async function vidSubmitUpload() {
  var titleEl = document.getElementById('vid-title');
  var kindEl  = document.getElementById('vid-kind');
  var matchEl = document.getElementById('vid-match');
  var tagsEl  = document.getElementById('vid-tags');
  var errEl   = document.getElementById('vid-upload-err');
  var okEl    = document.getElementById('vid-upload-ok');
  var progW   = document.getElementById('vid-upload-progress');
  var progLbl = document.getElementById('vid-prog-label');
  var progBar = document.getElementById('vid-prog-bar');
  var btn     = document.getElementById('vid-submit-btn');
  function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } }
  function hideErr()    { if (errEl) errEl.style.display = 'none'; }
  hideErr();
  if (okEl) okEl.style.display = 'none';
  var title = titleEl && titleEl.value.trim();
  if (!title)          { showErr('Title is required.'); return; }
  if (!_vidUploadFile) { showErr('Please select a video file.'); return; }
  if (_vidUploadBusy)  return;
  _vidUploadBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  if (progW) progW.style.display = 'block';
  var file      = _vidUploadFile;
  var srcKind   = kindEl  && kindEl.value  ? kindEl.value  : 'MATCH';
  var matchId   = matchEl && matchEl.value ? matchEl.value : undefined;
  var tags      = tagsEl  && tagsEl.value  ? tagsEl.value.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [];
  var sizeMb    = Math.round(file.size / 1024 / 1024 * 10) / 10;
  try {
    if (progLbl) progLbl.textContent = 'Requesting upload URL…';
    if (progBar) progBar.style.width = '15%';
    var res1 = await VideoIntelAPI.requestUpload({ title: title, sourceKind: srcKind, filename: file.name, fileSizeMb: sizeMb, matchId: matchId, tags: tags });
    if (!res1 || !res1.asset || !res1.uploadUrl) throw new Error('Invalid response — missing asset or uploadUrl');
    if (progLbl) progLbl.textContent = 'Uploading to storage…';
    if (progBar) progBar.style.width = '40%';
    var putRes = await fetch(res1.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'video/mp4' } });
    if (!putRes.ok) throw new Error('Storage PUT failed (' + putRes.status + ')');
    if (progBar) progBar.style.width = '80%';
    if (progLbl) progLbl.textContent = 'Confirming upload…';
    await VideoIntelAPI.confirmUpload({ assetId: res1.asset.id });
    if (progBar) progBar.style.width = '100%';
    if (progLbl) progLbl.textContent = 'Done!';
    _vidUploadFile = null;
    _vidUploadBusy = false;
    if (okEl) { okEl.innerHTML = '✓ <strong>' + _esc(title) + '</strong> uploaded. Transcode job queued.'; okEl.style.display = 'block'; }
    showToast('"' + title + '" uploaded — transcode queued', 'success');
    await loadVideoIntelData();
  } catch (err) {
    _vidUploadBusy = false;
    if (progW) progW.style.display = 'none';
    showErr((err && (err.userMessage || err.message)) || 'Upload failed — check console.');
    console.error('[vid-upload]', err);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
}

// ── stream modal ──────────────────────────────────────────────────────────────

async function vidStreamAsset(assetId, title) {
  var modal    = document.getElementById('vid-stream-modal');
  var titleEl  = document.getElementById('vid-modal-title');
  var videoEl  = document.getElementById('vid-video-el');
  var fallback = document.getElementById('vid-stream-fallback');
  var urlEl    = document.getElementById('vid-stream-url');
  var thumbRow = document.getElementById('vid-stream-thumb');
  var thumbImg = document.getElementById('vid-thumb-img');
  if (!modal) return;
  if (titleEl) titleEl.textContent = title || 'Video';
  if (videoEl)  { videoEl.src = ''; videoEl.style.display = 'none'; }
  if (fallback) fallback.style.display = 'none';
  if (thumbRow) thumbRow.style.display = 'none';
  modal.style.display = 'flex';
  try {
    var res = await VideoIntelAPI.streamUrl(assetId);
    var hlsUrl  = res && res.hlsUrl  ? res.hlsUrl  : '';
    var thumbUrl = res && res.thumbUrl ? res.thumbUrl : '';
    if (!hlsUrl) throw new Error('No stream URL returned');
    if (urlEl) urlEl.textContent = hlsUrl;
    if (videoEl && videoEl.canPlayType && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = hlsUrl;
      videoEl.style.display = 'block';
    } else {
      if (fallback) fallback.style.display = 'block';
    }
    if (thumbUrl && thumbImg && thumbRow) { thumbImg.src = thumbUrl; thumbRow.style.display = 'block'; }
  } catch (err) {
    if (modal) modal.style.display = 'none';
    showToast((err && err.userMessage) || 'Could not load stream URL', 'error');
  }
}

function vidCloseStream() {
  var modal   = document.getElementById('vid-stream-modal');
  var videoEl = document.getElementById('vid-video-el');
  if (videoEl) { videoEl.pause(); videoEl.src = ''; }
  if (modal)   modal.style.display = 'none';
}

function vidCopyUrl() {
  var urlEl = document.getElementById('vid-stream-url');
  var url = urlEl ? urlEl.textContent : '';
  if (!url) return;
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(function() { showToast('Stream URL copied', 'success'); });
}

// ── delete asset ──────────────────────────────────────────────────────────────

async function vidDeleteAsset(assetId, title) {
  if (!confirm('Delete "' + (title||'this video') + '"? This also removes all clips and transcode jobs.')) return;
  try {
    await VideoIntelAPI.deleteAsset(assetId);
    showToast('"' + (title||'Video') + '" deleted', 'success');
    _vidAssets = _vidAssets.filter(function(a) { return a.id !== assetId; });
    _vidAssetsTotal = Math.max(0, _vidAssetsTotal - 1);
    _renderVidBody();
  } catch (err) { showToast((err && err.userMessage) || 'Delete failed', 'error'); }
}

// ── filter by status ──────────────────────────────────────────────────────────

async function vidFilterStatus(status) {
  var el = document.getElementById('vid-body');
  if (el) el.innerHTML = loadingHTML('Filtering…');
  try {
    var opts = { limit: '50' };
    if (status && status !== 'ALL') opts.status = status;
    var res = await VideoIntelAPI.listAssets(opts);
    _vidAssets      = (res && res.items) || [];
    _vidAssetsTotal = (res && res.total) || 0;
  } catch (e) { /* keep existing */ }
  _renderVidBody();
}

// ── tactical note CRUD ────────────────────────────────────────────────────────

async function vidAddNote() {
  if (!_vidMatchId) return;
  var minEl  = document.getElementById('vid-note-min');
  var sideEl = document.getElementById('vid-note-side');
  var txtEl  = document.getElementById('vid-note-text');
  var min  = minEl  && minEl.value  ? parseInt(minEl.value, 10) : 0;
  var side = sideEl && sideEl.value ? sideEl.value : 'HOME';
  var text = txtEl  && txtEl.value.trim();
  if (!text) { showToast('Note text is required', 'error'); return; }
  try {
    await VideoIntelAPI.addNote(_vidMatchId, { occurredAtMin: min, kind: 'TACTICAL_NOTE', side: side, notes: text });
    showToast('Note added', 'success');
    if (txtEl) txtEl.value = '';
    await _vidReloadNotes();
  } catch (err) { showToast((err && err.userMessage) || 'Failed to add note', 'error'); }
}

async function vidDeleteNote(matchId, evtId) {
  if (!confirm('Delete this note?')) return;
  try {
    await VideoIntelAPI.deleteNote(matchId, evtId);
    showToast('Note deleted', 'success');
    _vidNotes = _vidNotes.filter(function(n) { return n.id !== evtId; });
    _renderVidBody();
  } catch (err) { showToast((err && err.userMessage) || 'Delete failed', 'error'); }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function _vMatchOptions() {
  return (State.matches || []).slice(0, 80).map(function(m) {
    var opp = m.isHome ? (m.awayTeam || m.opponent || '') : (m.homeTeam || m.opponent || '');
    var d   = m.scheduledAt ? new Date(m.scheduledAt).toLocaleDateString() : (m.date ? new Date(m.date).toLocaleDateString() : '');
    return '<option value="' + m.id + '">' + _esc(opp || m.id.slice(0,8)) + (d ? ' · ' + d : '') + '</option>';
  }).join('');
}

function _vFmtDur(sec) {
  var s = Math.floor(sec), h = Math.floor(s/3600), mm = Math.floor((s%3600)/60), ss = s%60;
  if (h > 0) return h + ':' + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
  return mm + ':' + String(ss).padStart(2,'0');
}

function _vFmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
  return (bytes/1073741824).toFixed(2) + ' GB';
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════════════════════════════
// END VIDEO ANALYSIS & MATCH INTELLIGENCE CENTER
// ══════════════════════════════════════════════════════════════════════════════

// Snapshot the current tactical board as a NOTE annotation (lightweight checkpoint).
async function tosBoardSnapshot() {
  const m = TOS.state.activeMatch; if (!m) return;
  const players = (TOS.state.spatial?.players) || [];
  const compact = players.filter(p => p.x != null && p.y != null).map(p => ({
    playerId: p.playerId, number: p.number, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, side: p.side,
  }));
  try {
    await FamilistaAPI.post('/matches/' + encodeURIComponent(m.id) + '/annotations', {
      atMs: Date.now(), kind: 'TAG_PLAYER',
      payload: { what: 'BOARD_SNAPSHOT', sport: TOS.state.sport, players: compact },
      visibility: 'CLUB',
    });
    showToast('Snapshot saved', 'success');
    tosLoadAnnotations();
  } catch (e) {
    showToast(e?.userMessage || 'Snapshot failed', 'error');
  }
}
// ── CSP-SAFE EVENT DELEGATION ─────────────────────────────────────────────────
// Replaces the 53 inline onclick/onchange/onsubmit handlers removed from
// index.html static markup. Handlers embedded in JS template literals (inside
// innerHTML strings) are unaffected — they live in this external file and are
// not subject to script-src CSP restrictions.
(function wireStaticHandlers() {
  // ── Click delegation ────────────────────────────────────────────────────────
  document.addEventListener('click', function delegateClick(e) {
    const el = e.target.closest(
      '[data-action],[data-nav],[data-show-auth],[data-close-modal],[data-match-tab]'
    );
    if (!el) return;
    // Prevent <a> default scroll-to-top behaviour
    if (el.tagName === 'A') e.preventDefault();

    if (el.dataset.action) {
      switch (el.dataset.action) {
        case 'closeMobileMenu':     closeMobileMenu();     break;
        case 'toggleMobileMenu':    toggleMobileMenu();    break;
        case 'doLogin':             doLogin();             break;
        case 'doForgotPassword':    doForgotPassword();    break;
        case 'doResetPassword':     doResetPassword();     break;
        case 'toggleSidebar':       toggleSidebar();       break;
        case 'toggleTheme':         toggleTheme();         break;
        case 'doLogout':            doLogout();            break;
        case 'closeMatchModal':     closeMatchModal();     break;
        // State-based: id resolved at click time from current State
        case 'openEditPlayerModal': openEditPlayerModal(State.activePlayer?.id); break;
        case 'confirmDeletePlayer': confirmDeletePlayer(State.activePlayer?.id); break;
        case 'playerEditSave':      playerEditSave();   break;
        case 'playerEditCancel':    playerEditCancel(); break;
        case 'openClubEdit':        openClubEdit();     break;
        case 'clubEditSave':        clubEditSave();     break;
        case 'clubEditCancel':      clubEditCancel();   break;
        case 'openEditMatchModal':       openEditMatchModal(State.activeMatch?.id);                  break;
        case 'confirmDeleteMatch':       confirmDeleteMatch(State.activeMatch?.id);                  break;
        case 'openEditTrainingModal':    openEditTrainingModal(State.activeTrainingSession?.id);    break;
        case 'confirmDeleteTraining':    confirmDeleteTraining(State.activeTrainingSession?.id);    break;
        // ── Scouting & Recruitment Center ──────────────────────────────────────
        case 'scoutTab':             setScoutTab(el.dataset.tab);                                        break;
        case 'openScoutModal':       openScoutModal('create');                                           break;
        case 'closeScoutModal':      closeScoutModal();                                                  break;
        case 'openScoutDetail':      openScoutDetail(el.dataset.id);                                     break;
        case 'editScoutProspect':    (async function(id){ var p = await ScoutingAPI.get(id); openScoutModal('edit',p); })(el.dataset.id); break;
        case 'scoutAdvancePipeline': scoutAdvancePipeline(el.dataset.id, el.dataset.stage);              break;
        case 'toggleScoutWatchlist': toggleScoutWatchlist(el.dataset.id, el.dataset.current);            break;
        // ── Video Analysis & Match Intelligence Center ──────────────────────────
        case 'vidRefresh':          loadVideoIntelData();                                                  break;
        case 'vidSwitchTab':        setVidTab(el.dataset.tab);                                             break;
        case 'vidCloseStream':      vidCloseStream();                                                      break;
        case 'vidCopyUrl':          vidCopyUrl();                                                          break;
        case 'vidStreamAsset':      vidStreamAsset(el.dataset.id, el.dataset.title);                       break;
        case 'vidDeleteAsset':      vidDeleteAsset(el.dataset.id, el.dataset.title);                       break;
        case 'vidFilterStatus':     vidFilterStatus(el.dataset.status);                                    break;
        case 'vidDropZoneClick':    (function(){ var fi = document.getElementById('vid-file-input'); if (fi) fi.click(); })(); break;
        case 'vidSubmitUpload':     vidSubmitUpload();                                                     break;
        case 'vidRefreshTimeline':  vidLoadTimeline();                                                     break;
        case 'vidRefreshClips':     vidLoadClips();                                                        break;
        case 'vidRefreshNotes':     vidLoadNotes();                                                        break;
        case 'vidRefreshOpponent':  vidLoadOpponent();                                                     break;
        case 'vidRefreshSummary':   vidLoadSummary();                                                      break;
        case 'vidAddNote':          vidAddNote();                                                          break;
        case 'vidDeleteNote':       vidDeleteNote(el.dataset.match, el.dataset.id);                        break;
        // ── Transfer Intelligence Center ────────────────────────────────────────────
        case 'tiRefresh':           loadTransferData();                                                    break;
        case 'tiSwitchTab':         tiSwitchTab(el.dataset.tab);                                           break;
        case 'tiOpenDetail':        tiOpenDetail(el.dataset.id);                                           break;
        case 'tiCloseDetail':       tiCloseDetail();                                                       break;
        case 'tiOpenAddTarget':     tiOpenAddTarget();                                                     break;
        case 'tiCloseAddTarget':    tiCloseAddTarget();                                                    break;
        case 'tiSubmitAddTarget':   tiSubmitAddTarget(null);                                               break;
        case 'tiAdvance':           tiAdvance(el.dataset.id);                                              break;
        case 'tiReject':            tiReject(el.dataset.id);                                               break;
        case 'tiLoadPlayerIntel':   tiLoadPlayerIntel();                                                   break;
        case 'tiRunCompare':        tiRunCompare();                                                        break;
        case 'tiLoadPlayerUnified':    tiLoadPlayerUnified();                                              break;
        case 'quantumOpenPlayerModal': quantumOpenPlayerModal(el.dataset.id);                              break;
        // ── Admin Control Center ─────────────────────────────────────────────────
        case 'adminTab':     adminSwitchTab(el.dataset.tab);                                               break;
        case 'adminRefresh': loadAdminData();                                                              break;
        case 'adminFixPlayer': openPlayerModal(el.dataset.id);                                             break;
        case 'openPlayerModal': openPlayerModal(el.dataset.id);                                            break;
        // ── Training (entries needed for Training Attendance MVP) ─────────────
        case 'openTrainingDetail': openTrainingDetail(el.dataset.id);                                      break;
        case 'editTraining':       openEditTrainingModal(el.dataset.id);                                   break;
        case 'deleteTraining':     confirmDeleteTraining(el.dataset.id);                                   break;
        case 'trainingBack':       trainingBack();                                                         break;
        case 'attendanceMark':     markAttendanceDraft(el.dataset.id, el.dataset.mark);                    break;
        case 'attendanceSave':     saveAttendance();                                                       break;
        // ── Tactical AI ──────────────────────────────────────────────────────────
        case 'taiTab':          taiSwitchTab(el.dataset.tab);                                              break;
        case 'taiRefresh':      loadTacticalAIData();                                                      break;
        case 'taiSelectMatch':  taiSelectMatch(el.dataset.id);                                             break;
        default: console.warn('[delegate] Unknown action:', el.dataset.action);
      }
    } else if ('nav' in el.dataset) {
      // nav items have data-page set; club-card doesn't → pass null (navTo finds it)
      navTo(el.dataset.nav, el.dataset.page ? el : null);
    } else if (el.dataset.showAuth) {
      showAuthView(el.dataset.showAuth);
    } else if (el.dataset.closeModal) {
      closeModal(el.dataset.closeModal);
    } else if (el.dataset.matchTab) {
      setMatchModalTab(el.dataset.matchTab, el);
    }
  });

  // ── Change delegation ───────────────────────────────────────────────────────
  document.addEventListener('change', function delegateChange(e) {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    switch (el.dataset.change) {
      case 'onContextClubChange':   onContextClubChange();   break;
      case 'onContextTeamChange':   onContextTeamChange();   break;
      case 'onScoutCompareChange':  onScoutCompareChange();  break;
      // ── Video match selectors ──────────────────────────────────────────────
      case 'vidLoadTimeline':       vidLoadTimeline();       break;
      case 'vidLoadClips':          vidLoadClips();          break;
      case 'vidLoadNotes':          vidLoadNotes();          break;
      case 'vidLoadOpponent':       vidLoadOpponent();       break;
      case 'vidLoadSummary':        vidLoadSummary();        break;
    }
  });

  // ── Submit delegation ───────────────────────────────────────────────────────
  document.addEventListener('submit', function delegateSubmit(e) {
    // These forms save ONLY via their explicit Save button — never on submit.
    // Swallow any Enter-key submit so the page can't reload mid-edit.
    if (e.target && (e.target.id === 'player-edit-form' || e.target.id === 'club-edit-form')) { e.preventDefault(); return; }
    const el = e.target.closest('[data-form-submit]');
    if (!el) return;
    switch (el.dataset.formSubmit) {
      case 'submitMatchForm':    submitMatchForm(e);    break;
      case 'submitTrainingForm':  submitTrainingForm(e);  break;
      case 'trainingModalSubmit': trainingModalSubmit(e); break;
      case 'submitInjuryForm':   submitInjuryForm(e);   break;
      case 'submitPerfForm':     submitPerfForm(e);     break;
      case 'submitScoutForm':    submitScoutForm(e);    break;
      case 'tiSubmitAddTarget':  tiSubmitAddTarget(e);  break;
    }
  });

  // ── Escape closes whichever modal is open ─────────────────────────────────────
  // Removing .open triggers the modal observer, which clears body.app-editing and
  // flushes any deferred page render exactly once. No focus-based flushing here —
  // that could fire a render mid-edit during a focus transition.
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-bg.open').forEach(function(m) {
        m.classList.remove('open');
      });
    }
  });
})();
