/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — invitation acceptance

   The page a person reaches from an invitation email, with no session, no club
   and possibly no account. Everything it does goes through endpoints that
   already existed and already enforce the rules:

     GET  /invitations/preview?token=…        what the link is for
     POST /invitations/accept-with-account    no account yet
     POST /auth/login  →  POST /invitations/accept    account already

   ── The handoff, and why it is a sign-in rather than a redirect with a session

   This page is served by the API host. Familista itself lives on a different
   origin. A session established here belongs to THIS origin: its cookies are
   scoped to this host, and a browser will not present them as a first-party
   session on the application's host — nor should it, and nor would Safari or
   Firefox even permit it as a third-party one. Handing a token across in a URL
   would work and is exactly what must not be done: a credential in a query
   string is in the history, in a screenshot, in the Referer of the next
   request and in every proxy log between here and there.

   So the person signs in, once, on the application, with the password they
   just chose. It is one extra step and it is the honest one.

   ── What this file will not do

     · decide anything. The club, the role and the address all come from the
       server's answer to the token. This page renders them; it never sends
       them back and never lets a person edit them.
     · keep the token. Read from the URL, held for the two requests that need
       it, never written to storage, and stripped from the address bar the
       moment the preview resolves.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var API = '/api/v1';
  var MIN_PASSWORD = 8;
  var root = document.getElementById('invite-root');

  // Held in a closure, not in storage. When this tab closes it is gone.
  var token = '';
  var preview = null;
  var busy = false;

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
          var err = new Error((body && (body.message || body.error)) || '');
          err.status = r.status;
          throw err;
        }
        return body && body.data != null ? body.data : body;
      });
    });
  }

  /**
   * What a person is told when something fails.
   *
   * A stack trace, a JSON blob or a database error is never shown. The server's
   * own sentences ARE shown when it wrote one for a person — "that invitation
   * has expired" is more use than "invalid link" — and anything else becomes a
   * plain sentence with a next step.
   */
  function humanError(err, fallback) {
    var message = err && err.message ? String(err.message) : '';
    if (!message || /^HTTP \d/.test(message) || /[{}[\]]|at .+:\d+:\d+/.test(message)) {
      return fallback;
    }
    return message;
  }

  function readToken() {
    try { return new URLSearchParams(window.location.search).get('token') || ''; }
    catch (_) { return ''; }
  }

  /**
   * Take the token out of the address bar.
   *
   * It has been read; leaving it there puts a single-use credential in the
   * history entry, in a screenshot of the tab, and in the Referer of anything
   * the page loads afterwards. The page keeps working because the value is
   * already in a variable.
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

  function expiryText() {
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' })
        .format(new Date(preview.expiresAt));
    } catch (_) {
      try { return new Date(preview.expiresAt).toLocaleString(); } catch (__) { return ''; }
    }
  }

  /** Where Familista actually lives. Told to us by the server, never guessed. */
  function appUrl() {
    return (preview && preview.appUrl) || '/';
  }

  function summaryHtml() {
    var expires = expiryText();
    return '<dl class="summary">'
      + '<div class="summary-row"><dt>Club</dt><dd>' + esc(preview.clubName) + '</dd></div>'
      + '<div class="summary-row"><dt>Role</dt><dd><span class="pill">' + esc(roleLabel(preview.role)) + '</span></dd></div>'
      + (preview.teamName ? '<div class="summary-row"><dt>Team</dt><dd>' + esc(preview.teamName) + '</dd></div>' : '')
      + '<div class="summary-row"><dt>Email</dt><dd>' + esc(preview.email) + '</dd></div>'
      + (expires ? '<div class="summary-row"><dt>Invitation expires</dt><dd class="muted">' + esc(expires) + '</dd></div>' : '')
      + '</dl>';
  }

  function alertHtml(kind, text) {
    return text ? '<div class="alert alert--' + kind + '" role="alert">' + esc(text) + '</div>' : '';
  }

  function busyButton(button, on, label) {
    busy = on;
    button.disabled = on;
    button.innerHTML = on
      ? '<span class="spinner" aria-hidden="true"></span>' + esc(label)
      : esc(label);
  }

  /** A reveal control, so nobody has to type a password they cannot see. */
  function bindReveal(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('.reveal'), function (btn) {
      btn.addEventListener('click', function () {
        var input = btn.parentNode.querySelector('input');
        var shown = input.type === 'text';
        input.type = shown ? 'password' : 'text';
        btn.textContent = shown ? 'Show' : 'Hide';
        btn.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      });
    });
  }

  // ── the two flows ─────────────────────────────────────────────────────────

  /** Somebody with no Familista account: name, password, done. */
  function renderCreateAccount(error) {
    root.innerHTML =
      '<h1>Accept your invitation</h1>'
      + '<p class="lede">Create your Familista account to join. It takes a moment, '
      + 'and you choose your own password.</p>'
      + summaryHtml()
      + alertHtml('error', error)
      + '<form id="create-form" novalidate>'
      + '<div class="pair">'
      + '<div class="field"><label for="firstName">First name</label>'
      + '<div class="control"><input id="firstName" name="firstName" autocomplete="given-name" '
      + 'autocapitalize="words" required></div></div>'
      + '<div class="field"><label for="lastName">Last name</label>'
      + '<div class="control"><input id="lastName" name="lastName" autocomplete="family-name" '
      + 'autocapitalize="words" required></div></div>'
      + '</div>'
      // The address is the invitation's, shown so the person knows which one
      // they are joining with, and not editable because it is not theirs to change.
      + '<div class="field"><label for="email">Email</label>'
      + '<div class="control"><input id="email" value="' + esc(preview.email) + '" readonly tabindex="-1" '
      + 'aria-describedby="email-hint"></div>'
      + '<p class="hint" id="email-hint">This invitation was written to this address.</p></div>'
      + '<div class="field"><label for="password">Create a password</label>'
      + '<div class="control"><input id="password" name="password" type="password" '
      + 'autocomplete="new-password" required aria-describedby="password-hint">'
      + '<button class="reveal" type="button" aria-label="Show password">Show</button></div>'
      + '<p class="hint" id="password-hint">At least ' + MIN_PASSWORD + ' characters.</p></div>'
      + '<div class="field"><label for="confirm">Confirm password</label>'
      + '<div class="control"><input id="confirm" name="confirm" type="password" '
      + 'autocomplete="new-password" required aria-describedby="confirm-hint">'
      + '<button class="reveal" type="button" aria-label="Show password">Show</button></div>'
      + '<p class="hint" id="confirm-hint"></p></div>'
      + '<button class="btn" type="submit" id="submit">Accept invitation &amp; create account</button>'
      + '</form>'
      + '<p class="note">You choose your own password. Nobody at the club and nobody at '
      + 'Familista can see it. Familista will never email you a password or ask you for one by reply.</p>';

    var form = document.getElementById('create-form');
    var password = document.getElementById('password');
    var confirm = document.getElementById('confirm');
    var confirmHint = document.getElementById('confirm-hint');
    var passwordHint = document.getElementById('password-hint');
    var submit = document.getElementById('submit');
    bindReveal(root);

    // Inline validation: says what is wrong while it is being fixed, rather
    // than after the form is sent.
    function validate(showEmpty) {
      var pw = password.value;
      var cf = confirm.value;
      var pwOk = pw.length >= MIN_PASSWORD;
      var matchOk = !!cf && pw === cf;

      if (pw || showEmpty) {
        password.classList.toggle('invalid', !pwOk);
        passwordHint.className = 'hint' + (pw ? (pwOk ? ' good' : ' bad') : '');
        passwordHint.textContent = !pw ? 'At least ' + MIN_PASSWORD + ' characters.'
          : pwOk ? 'Long enough.' : 'A little longer — at least ' + MIN_PASSWORD + ' characters.';
      }
      if (cf || showEmpty) {
        confirm.classList.toggle('invalid', !!cf && !matchOk);
        confirmHint.className = 'hint' + (cf ? (matchOk ? ' good' : ' bad') : '');
        confirmHint.textContent = !cf ? '' : matchOk ? 'The passwords match.' : 'The passwords do not match yet.';
      }
      return pwOk && matchOk
        && !!form.elements.firstName.value.trim()
        && !!form.elements.lastName.value.trim();
    }

    form.addEventListener('input', function () { validate(false); });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      // Two guards against a double submit: the flag, and the disabled button.
      // A double-tap on a phone fires before the button repaints.
      if (busy) return;
      if (!validate(true)) return;

      busyButton(submit, true, 'Accepting…');
      api('/invitations/accept-with-account', {
        method: 'POST',
        body: JSON.stringify({
          token: token,
          firstName: form.elements.firstName.value.trim(),
          lastName: form.elements.lastName.value.trim(),
          password: password.value,
        }),
      }).then(showAccepted).catch(function (err) {
        busy = false;
        if (err.status === 409) { renderSignIn(humanError(err, '')); return; }
        renderCreateAccount(humanError(err,
          'That did not work. Please check your details and try again.'));
      });
    });
  }

  /** Somebody who already has an account: sign in, then accept. */
  function renderSignIn(notice) {
    root.innerHTML =
      '<h1>You already have a Familista account</h1>'
      + '<p class="lede">Sign in with your existing password to accept this invitation. '
      + 'Your account is not changed — the club is added to it.</p>'
      + summaryHtml()
      + alertHtml('info', notice)
      + '<form id="signin-form" novalidate>'
      + '<div class="field"><label for="email">Email</label>'
      + '<div class="control"><input id="email" value="' + esc(preview.email) + '" readonly tabindex="-1"></div></div>'
      + '<div class="field"><label for="password">Password</label>'
      + '<div class="control"><input id="password" name="password" type="password" '
      + 'autocomplete="current-password" required>'
      + '<button class="reveal" type="button" aria-label="Show password">Show</button></div></div>'
      + '<button class="btn" type="submit" id="submit">Sign in &amp; accept invitation</button>'
      + '</form>'
      + '<p class="note">This is the password you already use for Familista. If you have '
      + 'forgotten it, reset it in Familista and open this link again — it stays valid until '
      + esc(expiryText()) + '.</p>';

    var form = document.getElementById('signin-form');
    var submit = document.getElementById('submit');
    bindReveal(root);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      var password = form.elements.password.value;
      if (!password) return;

      busyButton(submit, true, 'Accepting…');
      // Two steps, in order, through the endpoints that already exist: sign in
      // as themselves, then accept as themselves. The acceptance endpoint
      // checks that the signed-in address is the invited one, so a session for
      // somebody else cannot consume this invitation.
      api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: preview.email, password: password }),
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
        busy = false;
        renderSignIn(humanError(err, 'That password was not accepted. Please try again.'));
      });
    });
  }

  // ── the ending ────────────────────────────────────────────────────────────

  /**
   * Done — and then across to Familista.
   *
   * The button leaves for the application's own origin, where the person signs
   * in with what they just chose. No token travels in that URL: the session
   * this page established belongs to this host, and carrying a credential
   * across in a query string is precisely the thing not to do.
   */
  function showAccepted() {
    // The address travels in the FRAGMENT, never the query string. A fragment
    // is never sent to a server, never appears in a Referer header and never
    // reaches an access log — so Familista can fill the email field in without
    // the address being written down anywhere along the way. It is not a
    // credential, and no credential travels with it: the person still signs in
    // with the password they just chose.
    var target = appUrl() + '#email=' + encodeURIComponent(preview.email);
    root.innerHTML =
      '<div class="centre">'
      + '<div class="status-ico status-ico--ok" aria-hidden="true">✓</div>'
      + '<h1>Invitation accepted</h1>'
      + '<p>You are now <b>' + esc(roleLabel(preview.role)) + '</b> of '
      + '<b>' + esc(preview.clubName) + '</b>. This invitation has been used and its link no longer works.</p>'
      + '</div>'
      + '<div class="field" style="margin-top:20px"><label for="account-email">Sign in with this email</label>'
      + '<div class="copy-row"><input id="account-email" value="' + esc(preview.email) + '" readonly>'
      + '<button type="button" id="copy-email">Copy</button></div>'
      + '<p class="hint">…and the password you just created.</p></div>'
      + '<a class="btn" id="open-familista" href="' + esc(target) + '" '
      + 'style="text-decoration:none;margin-top:18px">Open Familista</a>'
      + '<p class="note">Familista opens on its own address, so you sign in there once. '
      + 'Your club and your role are already active and waiting.</p>';

    var copy = document.getElementById('copy-email');
    copy.addEventListener('click', function () {
      var input = document.getElementById('account-email');
      try { input.select(); document.execCommand('copy'); } catch (_) {}
      try { if (navigator.clipboard) navigator.clipboard.writeText(input.value); } catch (_) {}
      copy.textContent = 'Copied';
    });
  }

  /**
   * Every way this can fail, said plainly.
   *
   * A title, one sentence, and a next action that is actually available. Never
   * a status code, never a JSON body, never anything about the database.
   */
  function showProblem(opts) {
    root.innerHTML =
      '<div class="centre">'
      + '<div class="status-ico status-ico--' + (opts.tone || 'bad') + '" aria-hidden="true">'
      + esc(opts.icon || '!') + '</div>'
      + '<h1>' + esc(opts.title) + '</h1>'
      + '<p>' + esc(opts.detail) + '</p>'
      + '</div>'
      + (opts.retry
        ? '<button class="btn" type="button" id="retry">Try again</button>'
        : '')
      + (opts.appLink
        ? '<a class="btn btn--ghost" href="' + esc(appUrl()) + '" style="text-decoration:none">Go to Familista</a>'
        : '')
      + '<p class="note">' + esc(opts.note || 'If you think this is a mistake, ask the club to send a new invitation.') + '</p>';

    var retry = document.getElementById('retry');
    if (retry) retry.addEventListener('click', function () { location.reload(); });
  }

  /** The server's refusal, turned into a state a person can act on. */
  function showTokenProblem(err) {
    var message = humanError(err, '');
    if (/expired/i.test(message)) {
      showProblem({
        icon: '⏳', tone: 'warn', title: 'This invitation has expired',
        detail: 'Invitations are valid for a limited time and this one has passed it. '
          + 'The club can send you a new one.',
      });
      return;
    }
    if (/withdrawn|revoked/i.test(message)) {
      showProblem({
        icon: '⊘', tone: 'warn', title: 'This invitation was withdrawn',
        detail: 'The club cancelled this invitation, so the link no longer works. '
          + 'Contact them if you were expecting to join.',
      });
      return;
    }
    if (/already been used|already used/i.test(message)) {
      showProblem({
        icon: '✓', tone: 'ok', title: 'This invitation has already been used',
        detail: 'The account it created is ready. Sign in to Familista with the email and '
          + 'password you chose.',
        appLink: true,
        note: 'An invitation can only be used once, which is what keeps the link safe to send by email.',
      });
      return;
    }
    if (err && err.status === 404) {
      showProblem({
        icon: '⛨', title: 'This invitation could not be found',
        detail: 'The link may be incomplete or may have been typed by hand. Open it from your '
          + 'email again, or ask the club to resend it.',
      });
      return;
    }
    if (err && err.status >= 500) {
      showProblem({
        icon: '↻', tone: 'warn', title: 'Familista could not be reached',
        detail: 'Something went wrong at our end, not yours. The invitation is unaffected — '
          + 'please try again in a moment.',
        retry: true,
        note: 'If this keeps happening, ask the club to resend the invitation.',
      });
      return;
    }
    showProblem({
      icon: '⛨', title: 'This invitation cannot be used',
      detail: message || 'The link could not be checked. Open it from your email again, or ask '
        + 'the club to resend the invitation.',
      retry: !message,
    });
  }

  function start() {
    token = readToken();
    if (!token) {
      showProblem({
        icon: '⛨', title: 'This link is incomplete',
        detail: 'The address is missing its invitation code. Open the link from your email '
          + 'again — some mail apps shorten long addresses.',
      });
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
        showTokenProblem(err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
