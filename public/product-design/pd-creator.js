/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — the Creator Studio's own parts (P3): the way into a
   creator's account, and the account itself.

   The gate: sign in, open an account with a Platform Owner's invitation, ask
   for a password reset, set a new password and confirm an address from the
   links those emails carry. One card, one screen: switching between them moves
   nothing beneath.

   The account panel: a floating panel over the studio, like the Team panel:
   the creator's name and language, the address and whether it is confirmed,
   the password, a copy of all their data, and deleting the account.

   Every rule is the server's; this view only offers what the server accepts
   and says why when it does not. The room hands it its builders, words and
   clients; nothing here fetches, stores or styles by itself. A name a person
   typed is shown as they typed it and never translated.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignCreator = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function L(text) { return text; }
  /** Why the server refused a form, by the reason it gave. */
  var INVALID = {
    'bad-email': L('Enter a valid email address.'),
    'bad-name': L('Enter your name: up to 60 characters.'),
    'password-short': L('Use at least 10 characters for the password.'),
    'password-long': L('This password is too long: use at most 72 bytes.'),
    'password-is-email': L('The password cannot be your email address.'),
    'age-not-confirmed': L('Confirm your age to open an account.'),
    'bad-locale': L('Choose one of the languages offered.'),
  };
  var MIN_PASSWORD = 10;

  function refused(T, r, fallback) {
    if (r.status === 0) return T('The server could not be reached.');
    if (r.code === 'CREATOR_INVALID' && INVALID[r.reason]) return T(INVALID[r.reason]);
    if (r.code === 'CREATOR_INVITE_REFUSED') return r.reason === 'expired' ? T('This invitation has expired. Ask the Platform Owner for a new one.') : T('This invitation code is not valid for this address.');
    if (r.code === 'CREATOR_EMAIL_TAKEN') return T('An account already uses this email address. Sign in instead.');
    if (r.code === 'CREATOR_LINK_REFUSED') return T('This link has already been used or has expired. Ask for a new one.');
    if (r.status === 429) return T('Too many attempts. Wait a few minutes and try again.');
    return T(fallback);
  }
  function field(h, label, input, hint) {
    return h('label', { class: 'pd-team-field pd-gate-field' }, [h('span', { class: 'pd-gate-label', text: label }), input, hint ? h('span', { class: 'pd-note', text: hint }) : null]);
  }

  // ── the gate ──────────────────────────────────────────────────────────────

  /**
   * shell: { h, btn, icon, T, tf, brand(subtitle), langs(), onLang(code), auth (the sign-in client), links: { verify, reset } (tokens from the address,
   * already removed from it), onSignedIn(creator), deleted (true when the account was just deleted) }
   */
  function gate(shell) {
    var h = shell.h, btn = shell.btn, icon = shell.icon, T = shell.T, tf = shell.tf, auth = shell.auth;
    var st = {
      view: shell.links && shell.links.reset ? 'reset' : 'signin', busy: false, note: '', error: '',
      terms: { minimumAge: 18, email: null }, verified: null,
      f: { email: '', password: '', inviteCode: '', displayName: '', age: false, newPassword: '' },
    };
    if (shell.deleted) st.note = T('Your account was deleted. Thank you for designing with Familista.');
    var el = h('div', { class: 'pd-gate', 'data-pd-gate': '' });

    function render() {
      var active = document.activeElement && el.contains(document.activeElement) ? document.activeElement.getAttribute('data-pd-gate-key') : null;
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(h('header', { class: 'pd-gate-top' }, [
        shell.brand(T('Creator Studio')),
        shell.langs(),
      ]));
      el.appendChild(h('main', { class: 'pd-gate-main' }, [card(), aside()]));
      if (active) { var back = el.querySelector('[data-pd-gate-key="' + active + '"]'); if (back) back.focus({ preventScroll: true }); }
    }
    function card() {
      var kids = [h('h1', { class: 'pd-gate-title', id: 'pd-gate-title', text: title() })];
      if (st.view === 'signin' || st.view === 'signup') {
        kids.push(h('div', { class: 'pd-tabs pd-gate-tabs', role: 'tablist', 'aria-label': T('Creator account') }, [['signin', L('Sign in')], ['signup', L('Create account')]].map(function (t) {
          return btn({ class: 'pd-tab', role: 'tab', 'data-pd-act': 'gate-' + t[0], 'data-pd-gate-key': 'tab-' + t[0], 'aria-selected': st.view === t[0] ? 'true' : 'false', tabindex: st.view === t[0] ? '0' : '-1', text: T(t[1]) });
        })));
      }
      if (st.verified) kids.push(h('p', { class: 'pd-note pd-note--info', role: 'status' }, [icon('check', 14), h('span', { text: st.verified === 'ok' ? T('Your email address is confirmed. Sign in to continue.') : T('This confirmation link has already been used or has expired. Sign in and send a new one from Account.') })]));
      kids.push(form());
      kids.push(h('p', { class: 'pd-note pd-gate-error', role: 'alert', 'data-pd-gate-error': '', text: st.error }));
      kids.push(h('p', { class: 'pd-note pd-gate-status', role: 'status', 'aria-live': 'polite', 'data-pd-gate-status': '', text: st.note }));
      return h('section', { class: 'pd-gate-card', 'aria-labelledby': 'pd-gate-title' }, kids);
    }
    function title() {
      return st.view === 'signup' ? T('Open your Creator Studio') : st.view === 'forgot' ? T('Reset your password') : st.view === 'reset' ? T('Choose a new password') : T('Sign in to the Creator Studio');
    }
    function input(name, type, value, label, attrs) {
      var a = { class: 'pd-input', type: type, name: name, 'data-pd-gate-in': name, 'data-pd-gate-key': 'in-' + name, 'aria-label': label };
      for (var k in attrs || {}) a[k] = attrs[k];
      var i = h('input', a); i.value = value; return i;
    }
    function submit(act, label) {
      return btn({ class: 'pd-btn pd-btn--primary pd-gate-submit', type: 'submit', 'data-pd-gate-key': 'submit', 'aria-disabled': st.busy ? 'true' : null }, [h('span', { text: st.busy ? T('One moment…') : label })]);
    }
    function form() {
      var f = st.f, kids;
      if (st.view === 'signup') {
        var age = h('input', { type: 'checkbox', 'data-pd-gate-in': 'age', 'data-pd-gate-key': 'in-age' }); age.checked = f.age;
        kids = [
          field(h, T('Invitation code'), input('inviteCode', 'text', f.inviteCode, T('Invitation code'), { autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: '40', placeholder: 'FAM-XXXX-XXXX-XXXX-XXXX', dir: 'ltr' }),
            T('The Creator Studio opens by invitation while it is in its first release. The Platform Owner sends the codes.')),
          field(h, T('Your name'), input('displayName', 'text', f.displayName, T('Your name'), { autocomplete: 'name', maxlength: '60' })),
          field(h, T('Email address'), input('email', 'email', f.email, T('Email address'), { autocomplete: 'email', dir: 'ltr' })),
          field(h, T('Password'), input('password', 'password', f.password, T('Password'), { autocomplete: 'new-password', minlength: String(MIN_PASSWORD) }), tf('At least %d characters.', MIN_PASSWORD)),
          h('label', { class: 'pd-team-check' }, [age, h('span', { text: tf('I am at least %d years old.', st.terms.minimumAge) })]),
          h('p', { class: 'pd-note', text: T('Familista keeps no date of birth: only that you confirmed your age.') }),
          submit('signup', T('Create account')),
        ];
      } else if (st.view === 'forgot') {
        kids = [
          h('p', { class: 'pd-note', text: T('Enter the address of your account. If it has one, a link to choose a new password is sent to it.') }),
          field(h, T('Email address'), input('email', 'email', f.email, T('Email address'), { autocomplete: 'email', dir: 'ltr' })),
          submit('forgot', T('Send the link')),
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'gate-signin', 'data-pd-gate-key': 'back' }, [shell.dirArrow('←'), h('span', { text: T('Back to sign in') })]),
        ];
      } else if (st.view === 'reset') {
        kids = [
          field(h, T('New password'), input('newPassword', 'password', f.newPassword, T('New password'), { autocomplete: 'new-password', minlength: String(MIN_PASSWORD) }), tf('At least %d characters.', MIN_PASSWORD)),
          submit('reset', T('Set the new password')),
        ];
      } else {
        kids = [
          field(h, T('Email address'), input('email', 'email', f.email, T('Email address'), { autocomplete: 'username', dir: 'ltr' })),
          field(h, T('Password'), input('password', 'password', f.password, T('Password'), { autocomplete: 'current-password' })),
          submit('signin', T('Sign in')),
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'gate-forgot', 'data-pd-gate-key': 'forgot' }, [h('span', { text: T('Forgot your password?') })]),
        ];
      }
      if (st.terms.email === false && (st.view === 'signup' || st.view === 'forgot')) {
        kids.splice(0, 0, h('p', { class: 'pd-note pd-note--warn' }, [icon('info', 14), h('span', { text: T('This platform cannot send email yet. Confirming your address and resetting a password by email will work once the Platform Owner configures it.') })]));
      }
      return h('form', { class: 'pd-gate-form', 'data-pd-gate-form': st.view, novalidate: '' }, kids);
    }
    function aside() {
      var items = [
        [L('The full Design Studio'), L('Kits, goalkeeper shirts, training tops, shorts and socks, in 2D and 3D.')],
        [L('Every version kept'), L('Each save is a version you can open, compare and restore.')],
        [L('Team kits'), L('Rosters with names, numbers and sizes, and collections that count every size.')],
        [L('Quotations through Familista'), L('Ask for a non-binding quotation from verified suppliers. Nothing is charged here.')],
      ];
      return h('aside', { class: 'pd-gate-aside', 'aria-label': T('What the Creator Studio does') }, [
        h('p', { class: 'pd-dock-kicker', text: T('Creator Studio') }),
        h('h2', { class: 'pd-h2', text: T('Design on your own account') }),
        h('ul', { class: 'pd-gate-list', role: 'list' }, items.map(function (it) {
          return h('li', null, [icon('check', 16), h('span', null, [h('strong', { text: T(it[0]) }), h('span', { text: T(it[1]) })])]);
        })),
        h('p', { class: 'pd-note', text: T('Your designs are yours: no club and no other creator can see them.') }),
      ]);
    }
    function sayStatus(text) { st.note = text; var n = el.querySelector('[data-pd-gate-status]'); if (n) n.textContent = text; }
    function fail(text) { st.error = text; var n = el.querySelector('[data-pd-gate-error]'); if (n) n.textContent = text; }

    function go(view) { if (st.busy) return; st.view = view; st.error = ''; st.note = ''; render(); var first = el.querySelector('[data-pd-gate-in]'); if (first) first.focus({ preventScroll: true }); }
    function run(promise, done) {
      st.busy = true; st.error = ''; render();
      promise.then(function (r) { st.busy = false; done(r); render(); });
    }
    function onSubmit(ev) {
      ev.preventDefault();
      if (st.busy) return;
      var f = st.f;
      if (st.view === 'signin') {
        run(auth.login(f.email, f.password), function (r) {
          if (r.ok && r.data) { f.password = ''; shell.onSignedIn(r.data.creator); return; }
          st.error = r.status === 401 ? T('The email address or password is not correct.') : r.status === 403 ? T('This account is suspended. Contact the Platform Owner.') : refused(T, r, L('Not signed in.'));
        });
      } else if (st.view === 'signup') {
        if (!f.age) { fail(T(INVALID['age-not-confirmed'])); return; }
        run(auth.register({ inviteCode: f.inviteCode, email: f.email, password: f.password, displayName: f.displayName, locale: shell.locale(), ageConfirmed: f.age }), function (r) {
          if (r.ok && r.data) { f.password = ''; shell.onSignedIn(r.data.creator, r.data.verification); return; }
          st.error = refused(T, r, L('The account could not be opened.'));
        });
      } else if (st.view === 'forgot') {
        run(auth.forgotPassword(f.email), function (r) {
          if (r.ok) { st.note = T('If an account uses this address, a link to choose a new password is on its way.'); return; }
          st.error = refused(T, r, L('The link could not be sent.'));
        });
      } else if (st.view === 'reset') {
        run(auth.resetPassword(shell.links.reset, f.newPassword), function (r) {
          if (r.ok) { f.newPassword = ''; shell.links.reset = null; st.view = 'signin'; st.note = T('Your new password is set. Sign in with it.'); return; }
          st.error = refused(T, r, L('The password could not be changed.'));
        });
      }
    }
    function onInput(ev) {
      var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-pd-gate-in');
      if (!k) return;
      st.f[k] = t.type === 'checkbox' ? t.checked : t.value;
    }
    function onClick(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-pd-act], [data-pd-lang]') : null;
      if (!t || !el.contains(t)) return;
      if (t.hasAttribute('data-pd-lang')) { shell.onLang(t.getAttribute('data-pd-lang')); return; }
      var a = t.getAttribute('data-pd-act');
      if (a === 'gate-signin') go('signin');
      else if (a === 'gate-signup') go('signup');
      else if (a === 'gate-forgot') go('forgot');
    }
    function onKey(ev) {
      var t = ev.target;
      if (!t || t.getAttribute('role') !== 'tab' || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
      ev.preventDefault();
      go(st.view === 'signin' ? 'signup' : 'signin');
      var tab = el.querySelector('[data-pd-gate-key="tab-' + st.view + '"]'); if (tab) tab.focus();
    }
    el.addEventListener('submit', onSubmit);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);

    function start() {
      render();
      auth.terms().then(function (r) { if (r.ok && r.data) { st.terms = { minimumAge: r.data.minimumAge, email: r.data.email }; render(); } });
      if (shell.links && shell.links.verify) {
        var token = shell.links.verify; shell.links.verify = null;
        auth.verifyEmail(token).then(function (r) { st.verified = r.ok ? 'ok' : 'used'; render(); });
      }
    }
    return {
      el: el, start: start, repaint: render,
      metrics: function () { return { view: st.view, busy: st.busy, error: st.error, note: st.note, verified: st.verified, minimumAge: st.terms.minimumAge, email: st.terms.email }; },
    };
  }

  // ── the account panel ─────────────────────────────────────────────────────

  /**
   * ctx: { h, btn, icon, T, tf, api (the creator's client), host, dirArrow, date, me() (the account as last read),
   * setMe(creator), languages (the room's [code, label] list), signOut(), onDeleted(), onToggle() }
   */
  function account(ctx) {
    var h = ctx.h, btn = ctx.btn, icon = ctx.icon, T = ctx.T, tf = ctx.tf, api = ctx.api;
    var st = { open: false, trigger: null, tab: 'profile', busy: false, note: '', mail: null,
      f: { displayName: '', currentPassword: '', newPassword: '', deletePassword: '', deleteConfirm: false } };
    var el = h('section', { class: 'pd-team pd-acct', id: 'pd-acct', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pd-acct-title', 'data-open': 'false' });

    function say(text) { st.note = text; var n = el.querySelector('[data-pd-acct-status]'); if (n) n.textContent = text; }
    function render() {
      var keep = el.querySelector('.pd-team-body'), scroll = keep ? keep.scrollTop : 0;
      var active = document.activeElement && el.contains(document.activeElement) ? document.activeElement.getAttribute('data-pd-acct-key') : null;
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(h('div', { class: 'pd-dock-head pd-team-head' }, [
        h('h2', { class: 'pd-h2', id: 'pd-acct-title' }, [icon('people', 16), h('span', { text: T('Account') })]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'acct-close', 'data-pd-acct-key': 'close', 'aria-label': T('Close') }, [icon('close')]),
      ]));
      var kids = [tabs()].concat(st.tab === 'security' ? security() : st.tab === 'data' ? data() : profile());
      var body = h('div', { class: 'pd-dock-body pd-team-body', tabindex: '0' }, kids);
      el.appendChild(body);
      el.appendChild(h('p', { class: 'pd-note pd-team-status', role: 'status', 'aria-live': 'polite', 'data-pd-acct-status': '', text: st.note }));
      body.scrollTop = scroll;
      if (active) { var back = el.querySelector('[data-pd-acct-key="' + active + '"]'); if (back) back.focus({ preventScroll: true }); }
    }
    function tabs() {
      return h('div', { class: 'pd-tabs pd-team-tabs', role: 'tablist', 'aria-label': T('Account') }, [['profile', L('Profile')], ['security', L('Password')], ['data', L('Your data')]].map(function (t) {
        return btn({ class: 'pd-tab', role: 'tab', 'data-pd-act': 'acct-tab-' + t[0], 'data-pd-acct-key': 'tab-' + t[0], 'aria-selected': st.tab === t[0] ? 'true' : 'false', tabindex: st.tab === t[0] ? '0' : '-1', text: T(t[1]) });
      }));
    }
    function inp(name, type, value, label, attrs) {
      var a = { class: 'pd-input', type: type, 'data-pd-acct-in': name, 'data-pd-acct-key': 'in-' + name, 'aria-label': label };
      for (var k in attrs || {}) a[k] = attrs[k];
      var i = h('input', a); i.value = value; return i;
    }
    function busyAttr() { return st.busy ? 'true' : null; }
    function profile() {
      var me = ctx.me() || {};
      if (!st.f.displayName) st.f.displayName = me.displayName || '';
      var lang = h('select', { class: 'pd-input', 'data-pd-acct-in': 'locale', 'data-pd-acct-key': 'in-locale', 'aria-label': T('Language of emails') },
        ctx.languages.map(function (l) { return h('option', { value: l[3], text: l[1] }); }));
      lang.value = me.locale || 'en-GB';
      var verified = !!me.emailVerified;
      return [
        h('div', { class: 'pd-acct-card' }, [
          h('p', { class: 'pd-dock-kicker', text: T('Signed in as') }),
          h('p', { class: 'pd-acct-name', 'data-user-content': '', dir: 'auto', text: me.displayName || '' }),
          h('p', { class: 'pd-acct-mail', 'data-user-content': '', dir: 'ltr', text: me.email || '' }),
          h('p', { class: 'pd-acct-state' }, [h('span', { class: 'pd-chip' + (verified ? '' : ' pd-chip--muted'), 'data-verified': verified ? 'true' : 'false', text: verified ? T('Address confirmed') : T('Address not confirmed') })]),
        ]),
        verified ? null : h('div', { class: 'pd-acct-block' }, [
          h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: T('Confirm your address to ask Familista for quotations. The link is in the email sent when you opened the account.') })]),
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'acct-resend', 'data-pd-acct-key': 'resend', 'aria-disabled': busyAttr() }, [icon('link', 14), h('span', { text: T('Send the link again') })]),
          st.mail ? h('p', { class: 'pd-note' + (st.mail.sent ? '' : ' pd-note--warn'), 'data-pd-acct-mail': st.mail.sent ? 'sent' : st.mail.configured ? 'failed' : 'not-configured',
            text: st.mail.sent ? T('The link is on its way. It works once, for 48 hours.') : st.mail.configured ? T('The email could not be sent. Try again later.') : T('This platform cannot send email yet. The Platform Owner can confirm your address meanwhile.') }) : null,
        ]),
        h('div', { class: 'pd-acct-block' }, [
          h('h3', { class: 'pd-h3', text: T('Profile') }),
          field(h, T('Your name'), inp('displayName', 'text', st.f.displayName, T('Your name'), { maxlength: '60', autocomplete: 'name' })),
          field(h, T('Language of emails'), lang, T('Emails from Familista are written in this language. The studio follows the language you choose at the top.')),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'acct-save', 'data-pd-acct-key': 'save', 'aria-disabled': busyAttr() }, [h('span', { text: T('Save profile') })]),
        ]),
        h('div', { class: 'pd-acct-block' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'acct-signout', 'data-pd-acct-key': 'signout' }, [icon('export', 14), h('span', { text: T('Sign out') })]),
        ]),
      ];
    }
    function security() {
      return [h('div', { class: 'pd-acct-block' }, [
        h('h3', { class: 'pd-h3', text: T('Change the password') }),
        h('p', { class: 'pd-note', text: T('Every other device you are signed in on is signed out; this one stays signed in.') }),
        field(h, T('Current password'), inp('currentPassword', 'password', st.f.currentPassword, T('Current password'), { autocomplete: 'current-password' })),
        field(h, T('New password'), inp('newPassword', 'password', st.f.newPassword, T('New password'), { autocomplete: 'new-password', minlength: String(MIN_PASSWORD) }), tf('At least %d characters.', MIN_PASSWORD)),
        btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'acct-password', 'data-pd-acct-key': 'password', 'aria-disabled': busyAttr() }, [h('span', { text: T('Change the password') })]),
      ])];
    }
    function data() {
      var confirm = h('input', { type: 'checkbox', 'data-pd-acct-in': 'deleteConfirm', 'data-pd-acct-key': 'in-deleteConfirm' }); confirm.checked = st.f.deleteConfirm;
      return [
        h('div', { class: 'pd-acct-block' }, [
          h('h3', { class: 'pd-h3', text: T('A copy of your data') }),
          h('p', { class: 'pd-note', text: T('One file with your account, every design at its newest version, your rosters, collections, brand kit and quotation requests.') }),
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'acct-export', 'data-pd-acct-key': 'export', 'aria-disabled': busyAttr() }, [icon('export', 14), h('span', { text: T('Download a copy') })]),
        ]),
        h('div', { class: 'pd-acct-block pd-acct-danger' }, [
          h('h3', { class: 'pd-h3', text: T('Delete the account') }),
          h('p', { class: 'pd-note', text: T('Deletes your designs, rosters, collections and brand kit, and every name a request kept. Open requests are cancelled. Requests already closed stay without any name, as the record of what was asked. This cannot be undone.') }),
          h('p', { class: 'pd-note', text: T('While an order is with its maker, the account cannot be deleted: the order still needs its sizes until it is delivered or closed.') }),
          field(h, T('Password'), inp('deletePassword', 'password', st.f.deletePassword, T('Password'), { autocomplete: 'current-password' })),
          h('label', { class: 'pd-team-check' }, [confirm, h('span', { text: T('I understand that my account and designs are deleted for good.') })]),
          btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'acct-delete', 'data-pd-acct-key': 'delete', 'aria-disabled': st.busy || !st.f.deleteConfirm ? 'true' : null,
            'data-pd-why': st.f.deleteConfirm ? null : T('Tick the box first.') }, [h('span', { text: T('Delete the account') })]),
        ]),
      ];
    }

    function open(tab, trigger) { st.tab = tab || st.tab; st.open = true; st.trigger = trigger || null; el.setAttribute('data-open', 'true'); render(); ctx.onToggle(true); var f = el.querySelector('[role="tab"][aria-selected="true"]'); if (f) f.focus({ preventScroll: true }); }
    function close() {
      if (!st.open) return;
      st.open = false; el.setAttribute('data-open', 'false'); ctx.onToggle(false);
      var back = st.trigger && ctx.host.contains(st.trigger) ? st.trigger : null; st.trigger = null;
      if (back) back.focus({ preventScroll: true });
    }
    function done(text) { st.busy = false; say(text); render(); }
    function onAction(act, t) {
      if (act.indexOf('acct') !== 0) return false;
      if (act === 'acct') { if (st.open) close(); else open('profile', t); return true; }
      if (act === 'acct-close') { close(); return true; }
      if (act.indexOf('acct-tab-') === 0) { st.tab = act.slice(9); st.note = ''; render(); var tb = el.querySelector('[data-pd-acct-key="tab-' + st.tab + '"]'); if (tb) tb.focus(); return true; }
      if (st.busy) return true;
      if (act === 'acct-signout') { ctx.signOut(); return true; }
      st.busy = true; render();
      if (act === 'acct-save') {
        var loc = el.querySelector('[data-pd-acct-in="locale"]');
        api.updateProfile({ displayName: st.f.displayName, locale: loc ? loc.value : undefined }).then(function (r) {
          if (r.ok && r.data) { ctx.setMe(r.data.creator); done(T('Profile saved.')); } else done(refused(T, r, L('The profile could not be saved.')));
        });
      } else if (act === 'acct-resend') {
        api.resendVerification().then(function (r) {
          if (r.ok && r.data && r.data.alreadyVerified) { var me = ctx.me(); if (me) { me.emailVerified = true; ctx.setMe(me); } done(T('Your address is already confirmed.')); return; }
          st.mail = r.ok && r.data ? r.data.email : null; done(r.ok ? '' : refused(T, r, L('The link could not be sent.')));
        });
      } else if (act === 'acct-password') {
        api.changePassword(st.f.currentPassword, st.f.newPassword).then(function (r) {
          if (r.ok) { st.f.currentPassword = ''; st.f.newPassword = ''; done(T('Password changed. Other devices are signed out.')); return; }
          done(r.status === 401 ? T('The current password is not correct.') : refused(T, r, L('The password could not be changed.')));
        });
      } else if (act === 'acct-export') {
        api.exportData().then(function (r) {
          if (!r.ok || !r.data) { done(refused(T, r, L('The copy could not be made.'))); return; }
          var url = URL.createObjectURL(new Blob([JSON.stringify(r.data.export, null, 2)], { type: 'application/json' }));
          var a = h('a', { href: url, download: 'familista-creator-export-' + r.data.export.exportedAt.slice(0, 10) + '.json' });
          ctx.host.appendChild(a); a.click(); a.parentNode.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 0);
          done(T('Your copy is downloaded.'));
        });
      } else if (act === 'acct-delete') {
        api.deleteAccount(st.f.deletePassword).then(function (r) {
          if (r.ok) { st.busy = false; ctx.onDeleted(); return; }
          if (r.code === 'CREATOR_DELETION_REFUSED') { done(tf('Orders still with their maker: %d. The account can be deleted once they are delivered or closed.', r.data && r.data.orders || 1)); return; }
          done(r.status === 401 ? T('The password is not correct.') : refused(T, r, L('The account could not be deleted.')));
        });
      } else { st.busy = false; render(); }
      return true;
    }
    function onInput(ev) {
      var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-pd-acct-in');
      if (!k || !el.contains(t)) return false;
      if (k === 'locale') return true;
      st.f[k] = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'deleteConfirm') render();
      return true;
    }
    return {
      el: el, open: open, close: close, repaint: render, isOpen: function () { return st.open; },
      onAction: onAction, onInput: onInput, onChange: onInput,
      metrics: function () { return { open: st.open, tab: st.tab, busy: st.busy, note: st.note, mail: st.mail ? (st.mail.sent ? 'sent' : st.mail.configured ? 'failed' : 'not-configured') : null }; },
    };
  }

  return { gate: gate, account: account, INVALID: INVALID };
});
