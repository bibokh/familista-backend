/*
 * Familista — Admin Control Center · App + Router + Auth
 * File: public/familista-admin-app.js
 *
 * Responsibilities:
 *   1. Detect token in localStorage, drive login screen when absent.
 *   2. Validate the JWT against the live backend by hitting
 *      /admin/dashboard/overview — a 401/403 reveals the user is not a
 *      platform admin and forces re-login. A 2xx caches role + capabilities.
 *   3. Drive hash-based routing across the 14 admin pages.
 *   4. Filter nav items based on the caller's capability set.
 *
 * Production-grade only — no demo data, no mocks.
 */
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────
  var TOKEN_KEY    = 'familista.admin.token';
  var IDENTITY_KEY = 'familista.admin.identity';

  // ── Role → capability matrix (mirrors backend admin-rbac.middleware.ts)
  var ROLE_CAPS = {
    PLATFORM_OWNER: ALL_CAPS(),
    PLATFORM_ADMIN: [
      'branding:read','branding:write','asset:upload','asset:delete','palette:read','palette:write',
      'domain:read','domain:write','domain:force-verify',
      'org:read','org:write','org:suspend','org:restore','limits:write',
      'billing:read','billing:override','license:read','license:write',
      'feature-flag:read','feature-flag:write','impersonate:start','impersonate:end',
      'audit:read','platform-admin:read',
      'dashboard:read','players:read','coaches:read','managers:read',
      'investor-profile:read','investor-profile:write',
      'franchise-unit:read','franchise-unit:write',
      'subscription:read','payment:read','payment:adjust',
      'ai-engine:read','vision-engine:read',
    ],
    PLATFORM_SUPPORT: [
      'branding:read','branding:write','asset:upload','palette:read',
      'domain:read','domain:write','org:read','license:read',
      'feature-flag:read','impersonate:start','impersonate:end',
      'audit:read','platform-admin:read',
      'dashboard:read','players:read','coaches:read','managers:read',
      'investor-profile:read','franchise-unit:read','subscription:read',
      'payment:read','ai-engine:read','vision-engine:read',
    ],
    PLATFORM_BILLING: [
      'org:read','billing:read','billing:override','license:read','license:write','limits:write',
      'feature-flag:read','audit:read','platform-admin:read',
      'dashboard:read','subscription:read','payment:read','payment:adjust','franchise-unit:read',
    ],
    PLATFORM_READ_ONLY: ALL_CAPS().filter(function (c) { return c.indexOf(':read') !== -1; }),
  };
  function ALL_CAPS() {
    return [
      'branding:read','branding:write','asset:upload','asset:delete','palette:read','palette:write',
      'domain:read','domain:write','domain:force-verify',
      'org:read','org:write','org:suspend','org:restore','limits:write',
      'billing:read','billing:override','license:read','license:write',
      'feature-flag:read','feature-flag:write','impersonate:start','impersonate:end',
      'audit:read','platform-admin:read','platform-admin:write',
      'dashboard:read','players:read','coaches:read','managers:read',
      'investor-profile:read','investor-profile:write','franchise-unit:read','franchise-unit:write',
      'subscription:read','payment:read','payment:adjust','ai-engine:read','vision-engine:read',
    ];
  }

  // ── Identity state ────────────────────────────────────────────────────
  var identity = null;     // { token, email, name, role, caps:Set, adminId, userId }

  function loadStoredIdentity() {
    try {
      var raw = localStorage.getItem(IDENTITY_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !p.role) return null;
      p.caps = new Set(ROLE_CAPS[p.role] || []);
      return p;
    } catch (_) { return null; }
  }

  function storeIdentity(id) {
    var clone = { token: id.token, email: id.email, name: id.name, role: id.role, adminId: id.adminId, userId: id.userId };
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(clone));
    localStorage.setItem(TOKEN_KEY, id.token);
  }
  function clearIdentity() {
    localStorage.removeItem(IDENTITY_KEY);
    localStorage.removeItem(TOKEN_KEY);
    identity = null;
  }

  function hasCap(cap) {
    return !!(identity && identity.caps && identity.caps.has(cap));
  }

  window.AdminAuth = {
    hasCap: hasCap,
    current: function () { return identity; },
  };

  // ── Backend probe — confirms the JWT corresponds to an active PlatformAdmin
  function probeBackend() {
    return window.FamilistaAPI.admin.dashboard.overview({ window: '24h' }).then(function () {
      return { ok: true };
    }).catch(function (err) {
      return { ok: false, status: err.status, message: err.message };
    });
  }

  // ── Login flow ────────────────────────────────────────────────────────
  // The login endpoint shape depends on the existing auth system. We try the
  // two most common variants used in this codebase: /auth/login and /login.
  // Either way, the response must contain a token field.
  function attemptLogin(email, password) {
    var body = { email: email, password: password };
    return window.FamilistaAPI.raw.request('POST', '/auth/login', { body: body })
      .catch(function (err) {
        if (err.status === 404 || err.status === 405) {
          return window.FamilistaAPI.raw.request('POST', '/login', { body: body });
        }
        throw err;
      })
      .then(function (res) {
        // Server may return either the data directly or an envelope.
        var data = res && res.data ? res.data : res;
        var token = data && (data.token || data.accessToken || (data.tokens && data.tokens.access));
        var user  = data && (data.user || data);
        if (!token) throw new Error('Login response missing token');
        return { token: token, user: user };
      });
  }

  function showLogin(errMsg) {
    document.getElementById('app-view').classList.add('hidden');
    var login = document.getElementById('login-view');
    login.classList.remove('hidden');
    var err = document.getElementById('login-err');
    if (errMsg) { err.textContent = errMsg; err.classList.remove('hidden'); }
    else err.classList.add('hidden');
  }
  function hideLogin() {
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');
  }

  function wireLogin() {
    var form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = document.getElementById('login-email').value.trim();
      var password = document.getElementById('login-password').value;
      if (!email || !password) return;
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      attemptLogin(email, password).then(function (out) {
        window.FamilistaAPI.setToken(out.token);
        // Probe to confirm platform-admin status
        return probeBackend().then(function (p) {
          if (!p.ok) {
            window.FamilistaAPI.setToken(null);
            throw new Error(p.status === 403 ? 'Not authorised — platform admin only' : (p.message || 'Login failed'));
          }
          // Resolve role from /admin/whitelabel/configs is overkill —
          // accept role hint from user payload, fall back to a safe default.
          var role = (out.user && (out.user.platformRole || (out.user.platformAdmin && out.user.platformAdmin.role))) || 'PLATFORM_READ_ONLY';
          identity = {
            token:   out.token,
            email:   (out.user && out.user.email)     || email,
            name:    [(out.user && out.user.firstName) || '', (out.user && out.user.lastName) || ''].join(' ').trim() || email,
            role:    role,
            adminId: out.user && out.user.platformAdmin && out.user.platformAdmin.id || null,
            userId:  out.user && out.user.id || null,
            caps:    new Set(ROLE_CAPS[role] || []),
          };
          storeIdentity(identity);
          boot();
        });
      }).catch(function (err) {
        showLogin(err.message || 'Sign-in failed');
        btn.disabled = false; btn.textContent = 'Sign in';
      });
    });
  }

  function wireLogout() {
    var btn = document.getElementById('logout-btn');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', function () {
        clearIdentity();
        window.FamilistaAPI.setToken(null);
        showLogin();
        window.location.hash = '#/overview';
      });
    }
  }

  // ── Router ────────────────────────────────────────────────────────────
  var TITLES = {
    'overview':        'Dashboard',
    'alerts':          'Alerts',
    'organizations':   'Organizations',
    'clubs':           'Clubs',
    'academies':       'Academies',
    'players':         'Players',
    'coaches':         'Coaches',
    'managers':        'Managers',
    'investors':       'Investors',
    'subscriptions':   'Subscriptions',
    'payments':        'Payments',
    'franchise-units': 'Franchise Units',
    'ai-engine':       'AI Engine',
    'vision-engine':   'Vision Engine',
    'audit-logs':      'Audit Logs',
  };

  function currentRoute() {
    var hash = window.location.hash || '';
    var path = hash.replace(/^#\/?/, '').split('?')[0];
    return path || 'overview';
  }

  function renderRoute() {
    var route = currentRoute();
    if (!TITLES[route]) route = 'overview';
    var render = window.AdminPages[route];
    if (!render) return;

    // Capability gate: lock the nav link, redirect to overview if user lands here directly.
    var link = document.querySelector('.nav-link[data-route="' + route + '"]');
    if (link && link.dataset.cap && !hasCap(link.dataset.cap)) {
      window.location.hash = '#/overview';
      return;
    }

    // Active nav
    var links = document.querySelectorAll('.nav-link');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('active', links[i].getAttribute('data-route') === route);
    }
    document.getElementById('crumb-now').textContent = TITLES[route] || 'Dashboard';

    var content = document.getElementById('content');
    try { render(content); }
    catch (err) {
      content.innerHTML = '';
      content.appendChild(window.AdminUI.el('div', { class: 'alert crit' }, ['Render error: ' + (err.message || err) ]));
    }
  }

  function wireNav() {
    var links = document.querySelectorAll('.nav-link');
    for (var i = 0; i < links.length; i++) {
      (function (link) {
        var route = link.getAttribute('data-route');
        var needCap = link.getAttribute('data-cap');
        if (needCap && !hasCap(needCap)) {
          link.classList.add('disabled');
          link.addEventListener('click', function (ev) { ev.preventDefault(); window.AdminUI.toast('Capability required: ' + needCap, 'err'); });
        } else {
          link.addEventListener('click', function (ev) { ev.preventDefault(); window.location.hash = '#/' + route; });
        }
      }(links[i]));
    }
    window.addEventListener('hashchange', renderRoute);
  }

  function paintActor() {
    document.getElementById('actor-role').textContent = identity ? identity.role : '—';
    document.getElementById('actor-who').textContent  = identity ? (identity.name || identity.email) : '—';
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  function boot() {
    paintActor();
    wireNav();
    wireLogout();
    hideLogin();
    if (!window.location.hash) window.location.hash = '#/overview';
    renderRoute();
  }

  function init() {
    // 1. Wire login form (always)
    wireLogin();

    // 2. Try to restore identity
    var stored = loadStoredIdentity();
    var token = localStorage.getItem(TOKEN_KEY);
    if (!stored || !token) {
      showLogin();
      return;
    }
    identity = stored;
    window.FamilistaAPI.setToken(token);

    // 3. Probe to confirm token still valid + admin still active.
    probeBackend().then(function (p) {
      if (p.ok) {
        boot();
      } else {
        clearIdentity();
        showLogin(p.status === 401 ? 'Session expired — sign in again' : null);
      }
    });
  }

  // Wait for the deferred scripts (API client + UI + pages) to be ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
