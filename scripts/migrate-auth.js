/**
 * Transforms app.js.tmp: migrates from localStorage token storage to
 * HttpOnly cookie auth, preserving in-memory token for WebSocket/SSE use.
 */
const fs = require('fs');
// Normalize CRLF → LF so all string comparisons use \n only
let js = fs.readFileSync('public/app.js.tmp', 'utf8').replace(/\r\n/g, '\n');

let changes = 0;

function replace(from, to, label) {
  if (!js.includes(from)) { console.error('NOT FOUND:', label); return; }
  js = js.replace(from, to);
  changes++;
  console.log('OK:', label);
}

// ── 1. State object: remove refreshToken field ───────────────────────────────
replace(
  '  token:        null,\n  refreshToken: null,',
  '  token:        null,   // in-memory only — for WebSocket/SSE ?token= param',
  'State.refreshToken removal'
);

// ── 2. refreshTokens(): cookie-based, no localStorage ────────────────────────
replace(
  `  function refreshTokens() {
    if (!State.refreshToken) return Promise.resolve(false);
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
      try {
        const body = await rawFetch('POST', FAM_CONFIG.API_BASE + '/auth/refresh',
          { body: { refreshToken: State.refreshToken }, auth: false });
        const data = body && (body.data || body);
        const at   = data && (data.accessToken || (data.tokens && data.tokens.accessToken));
        const rt   = data && (data.refreshToken || (data.tokens && data.tokens.refreshToken));
        if (!at) return false;
        State.token        = at;
        if (rt) State.refreshToken = rt;
        localStorage.setItem('fam_token',   State.token);
        if (rt) localStorage.setItem('fam_refresh', State.refreshToken);
        return true;
      } catch (_) {
        return false;
      } finally {
        _refreshing = null;
      }
    })();
    return _refreshing;
  }`,
  `  function refreshTokens() {
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
  }`,
  'refreshTokens() cookie migration'
);

// ── 3. 401 auto-refresh: no longer gated on State.refreshToken ───────────────
replace(
  'if (err.status === 401 && !opts._refreshed && opts.auth !== false && State.refreshToken) {',
  'if (err.status === 401 && !opts._refreshed && opts.auth !== false) {',
  '401 refresh guard'
);

// ── 4. doLogin: remove localStorage writes, remove refreshToken ──────────────
replace(
  `    State.token        = at;
    State.refreshToken = rt || null;
    State.user         = user;

    localStorage.setItem('fam_token',   State.token);
    if (rt)   localStorage.setItem('fam_refresh', State.refreshToken);
    if (user) localStorage.setItem('fam_user',    JSON.stringify(State.user));`,
  `    State.token = at;   // in-memory for WS/SSE ?token= param
    State.user  = user;`,
  'doLogin localStorage removal'
);

// ── 5. doLogout: use cookie endpoint, remove localStorage ────────────────────
replace(
  `function doLogout() {
  if (State.refreshToken) {
    api('/auth/logout', { method: 'POST', body: { refreshToken: State.refreshToken } }).catch(() => {});
  }
  // Close any open match WebSocket on logout.
  if (typeof _matchModalWS !== 'undefined' && _matchModalWS) {
    try { _matchModalWS.close(); } catch (_) {}
    _matchModalWS = null;
  }

  State.token = State.refreshToken = State.user = null;
  localStorage.removeItem('fam_token');
  localStorage.removeItem('fam_refresh');
  localStorage.removeItem('fam_user');`,
  `function doLogout() {
  // POST to /auth/logout: server clears both HttpOnly cookies.
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  // Close any open match WebSocket on logout.
  if (typeof _matchModalWS !== 'undefined' && _matchModalWS) {
    try { _matchModalWS.close(); } catch (_) {}
    _matchModalWS = null;
  }
  State.token = null;
  State.user  = null;`,
  'doLogout cookie migration'
);

// ── 6. Replace tryAutoLogin with cookie-based session restore ────────────────
const oldAutoLogin = `// ── AUTO-LOGIN ──
async function tryAutoLogin() {
  const token   = localStorage.getItem('fam_token');
  const refresh = localStorage.getItem('fam_refresh');
  const user    = localStorage.getItem('fam_user');

  if (!token || !refresh || !user) return;

  try {
    // Verify token is still valid
    const res = await fetch(API_BASE + '/auth/me', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
      },
    });

    if (res.ok) {
      State.token        = token;
      State.refreshToken = refresh;
      State.user         = JSON.parse(user);
      console.log('[AutoLogin] Token valid, logging in...');
      bootApp();
    } else if (res.status === 401 && refresh) {
      // Try refresh
      console.log('[AutoLogin] Token expired, trying refresh...');
      const refreshRes = await fetch(API_BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.success) {
        State.token        = refreshData.data.accessToken;
        State.refreshToken = refreshData.data.refreshToken;
        State.user         = JSON.parse(user);
        localStorage.setItem('fam_token',   State.token);
        localStorage.setItem('fam_refresh', State.refreshToken);
        bootApp();
      } else {
        // Clear invalid tokens
        localStorage.clear();
      }
    } else {
      localStorage.clear();
    }
  } catch (err) {
    console.warn('[AutoLogin] Failed:', err.message);
    // Don't clear tokens on network error - might be temporary
  }
}`;

const newAutoLogin = `// ── COOKIE SESSION RESTORE ──
// The access_token HttpOnly cookie is sent automatically; the server validates
// it and returns the current user profile. No localStorage involved.
async function tryAutoLogin() {
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
        console.log('[AutoLogin] Cookie session valid:', user.email);
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
}`;

replace(oldAutoLogin, newAutoLogin, 'tryAutoLogin cookie migration');

// ── Verify no regressions ────────────────────────────────────────────────────
const issues = [];
if (js.includes("localStorage.setItem('fam_token'")) issues.push('fam_token localStorage.setItem still present');
if (js.includes("localStorage.setItem('fam_refresh'")) issues.push('fam_refresh localStorage.setItem still present');
if (js.includes('State.refreshToken = rt || null')) issues.push('refreshToken state assignment still present');
if (js.includes("if (!State.refreshToken)")) issues.push('refreshToken guard still present');

// Write final app.js
fs.writeFileSync('public/app.js', js, 'utf8');
fs.unlinkSync('public/app.js.tmp');

console.log('\nTotal changes applied:', changes);
if (issues.length) { console.error('ISSUES:', issues); process.exit(1); }
console.log('Verification: PASSED');
console.log('app.js lines:', js.split('\n').length);
