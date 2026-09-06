/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — invitation acceptance

   The page a person reaches from an invitation email, with no session, no club
   and possibly no account. Everything it does goes through endpoints that
   already existed and already enforce the rules:

     GET  /invitations/preview?token=…        what the link is for
     POST /invitations/accept-with-account    no account yet
     POST /auth/login  →  POST /invitations/accept    account already

   What this file deliberately does NOT do:

     · decide anything. The club, the role and the address all come from the
       server's answer to the token. This page renders them; it never sends
       them back and never lets a person edit them.
     · keep the token. It is read from the URL, held for the two requests that
       need it, and never written to localStorage, sessionStorage, a cookie or
       a log.
     · leak it onward. The token is stripped from the address bar the moment
       the preview resolves, so it is not in the history entry, not in a
       screenshot of the tab, and not in the Referer of anything loaded after.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var API = '/api/v1';
  var root = document.getElementById('invite-root');

  // Held in a closure, not in storage. When this tab closes it is gone.
  var token = '';
  var preview = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    return fetch(API + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) {
          var err = new Error((body && (body.message || body.error)) || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return body && body.data != null ? body.data : body;
      });
    });
  }

  function readToken() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get('token') || '';
    } catch (_) { return ''; }
  }

  /**
   * Take the token out of the address bar.
   *
   * It has been read; leaving it there puts a single-use credential in the
   * history entry, in the tab title bar of a screenshot, and in the Referer of
   * anything the page loads afterwards. The page keeps working because the
   * value is already in a variable.
   */
  function scrubUrl() {
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (_) {}
  }

  var ROLE_LABELS = {
    CLUB_OWNER: 'President', CLUB_ADMIN: 'Club administrator', HEAD_COACH: 'Head coach',
    ASSISTANT_COACH: 'Assistant coach', ANALYST: 'Analyst', SCOUT: 'Scout',
    MEDICAL_STAFF: 'Medical staff', PARENT: 'Parent', PLAYER: 'Player',
  };
  function roleLabel(role) {
    return ROLE_LABELS[role] || String(role || '').replace(/_/g, ' ').toLowerCase();
  }

  function factsHtml() {
    var expires = '';
    try { expires = new Date(preview.expiresAt).toLocaleString(); } catch (_) {}
    return '<div class="facts">'
      + '<div class="fact"><span>Club</span><b>' + esc(preview.clubName) + '</b></div>'
      + '<div class="fact"><span>Role</span><b>' + esc(roleLabel(preview.role)) + '</b></div>'
      + (preview.teamName ? '<div class="fact"><span>Team</span><b>' + esc(preview.teamName) + '</b></div>' : '')
      + '<div class="fact"><span>Email</span><b>' + esc(preview.email) + '</b></div>'
      + (expires ? '<div class="fact"><span>Expires</span><b>' + esc(expires) + '</b></div>' : '')
      + '</div>';
  }

  function showError(title, detail, permanent) {
    root.innerHTML = '<div class="centre">'
      + '<div class="ico ico--bad">⛨</div>'
      + '<h1>' + esc(title) + '</h1>'
      + '<p>' + esc(detail) + '</p>'
      + (permanent ? '' : '<button class="link" type="button" onclick="location.reload()">Try again</button>')
      + '</div>';
  }

  function showAccepted() {
    root.innerHTML = '<div class="centre">'
      + '<div class="ico ico--ok">✓</div>'
      + '<h1>You\'re in</h1>'
      + '<p>You have joined <b>' + esc(preview.clubName) + '</b> as '
      + esc(roleLabel(preview.role)) + '. This invitation has now been used and its link no longer works.</p>'
      + '<button type="button" onclick="location.href=\'/\'">Open Familista</button>'
      + '</div>';
  }

  function message(kind, text) {
    return '<div class="msg msg--' + kind + '">' + esc(text) + '</div>';
  }

  /** Somebody with no account: name, password, done. */
  function renderCreateAccount(error) {
    root.innerHTML =
      '<h1>Accept your invitation</h1>'
      + '<p>Create your Familista account to join. You choose your own password — '
      + 'nobody at the club and nobody at Familista can see it.</p>'
      + factsHtml()
      + (error ? message('error', error) : '')
      + '<form id="create-form" novalidate>'
      + '<div class="row">'
      + '<label><span>First name</span><input name="firstName" autocomplete="given-name" required></label>'
      + '<label><span>Last name</span><input name="lastName" autocomplete="family-name" required></label>'
      + '</div>'
      // The address is the invitation's, shown so the person knows which one
      // they are joining with, and not editable because it is not theirs to change.
      + '<label><span>Email</span><input value="' + esc(preview.email) + '" readonly tabindex="-1"></label>'
      + '<label><span>Choose a password</span>'
      + '<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>'
      + '<button type="submit">Accept and create my account</button>'
      + '</form>'
      + '<p class="note">At least 8 characters. Familista will never email you a password '
      + 'or ask you for one by reply.</p>';

    document.getElementById('create-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var form = ev.target;
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Accepting…';

      api('/invitations/accept-with-account', {
        method: 'POST',
        body: JSON.stringify({
          token: token,
          firstName: form.elements.firstName.value.trim(),
          lastName: form.elements.lastName.value.trim(),
          password: form.elements.password.value,
        }),
      }).then(showAccepted).catch(function (err) {
        renderCreateAccount(err.message || 'That did not work. Please try again.');
      });
    });
  }

  /** Somebody who already has an account: sign in, then accept. */
  function renderSignIn(error) {
    root.innerHTML =
      '<h1>Accept your invitation</h1>'
      + '<p>You already have a Familista account for this address. Sign in with your '
      + 'own password to accept.</p>'
      + factsHtml()
      + (error ? message('error', error) : '')
      + '<form id="signin-form" novalidate>'
      + '<label><span>Email</span><input value="' + esc(preview.email) + '" readonly tabindex="-1"></label>'
      + '<label><span>Password</span>'
      + '<input name="password" type="password" autocomplete="current-password" required></label>'
      + '<button type="submit">Sign in and accept</button>'
      + '</form>'
      + '<p class="note">This is your existing password. If you have forgotten it, '
      + '<a href="/reset-password" style="color:var(--accent)">reset it</a> and come back to this link.</p>';

    document.getElementById('signin-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var form = ev.target;
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Accepting…';

      // Two steps, in order, through the endpoints that already exist: sign in
      // as themselves, then accept as themselves. The acceptance endpoint
      // checks that the signed-in address is the invited one, so a session for
      // somebody else cannot consume this invitation.
      api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: preview.email, password: form.elements.password.value }),
      }).then(function (out) {
        var bearer = out && out.tokens && out.tokens.accessToken;
        return api('/invitations/accept', {
          method: 'POST',
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            bearer ? { Authorization: 'Bearer ' + bearer } : {},
          ),
          body: JSON.stringify({ token: token }),
        });
      }).then(showAccepted).catch(function (err) {
        renderSignIn(err.message || 'That did not work. Please try again.');
      });
    });
  }

  function start() {
    token = readToken();
    if (!token) {
      showError('This link is incomplete',
        'The address is missing its invitation token. Open the link from your email again, '
        + 'or ask the club to resend the invitation.', true);
      return;
    }

    api('/invitations/preview?token=' + encodeURIComponent(token))
      .then(function (data) {
        preview = data;
        // Read once, then out of the address bar.
        scrubUrl();
        if (preview.accountExists) renderSignIn(); else renderCreateAccount();
      })
      .catch(function (err) {
        scrubUrl();
        // The server already says which of expired / withdrawn / already used
        // it is, in words a person can act on. It is shown as it came rather
        // than flattened into "invalid link".
        var permanent = err.status === 400 || err.status === 404;
        showError('This invitation cannot be used',
          err.message || 'The link could not be checked. Ask the club to resend the invitation.',
          permanent);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
