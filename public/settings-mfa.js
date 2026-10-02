// Settings · Account · Two-step sign-in (Cyber Defense, Steps 6 and 7)
// ─────────────────────────────────────────────────────────────────────────────
// The platform owner enrols an authenticator app, keeps a set of single-use
// recovery codes, replaces them, and can turn two-step sign-in off — each change
// confirmed with a real code. Step 7 adds the switch that requires a code at
// every sign-in: switched on only with a working app code AND a working recovery
// code, so nobody locks themselves out with a phone or codes never tested.
//
// One card inside the existing Settings › Account panel, on the Settings card
// vocabulary (set-card, set-field, btn, badge). Everything happens in place:
// no navigation, no modal. Shown to the platform owner and — R7 — to club and
// platform administrators; for anyone else the card stays hidden and nothing
// is requested. When the platform requires two-step sign-in of administrators
// and one has not enrolled, the same card is mounted on the sign-in screen
// (`mountRequired`), since that session can do nothing else.
//
// WHAT NEVER PERSISTS IN THE BROWSER
//
// The setup key and the recovery codes live in this module's memory while they
// are on screen and are dropped as soon as the reader moves on. Nothing is
// written to localStorage or sessionStorage.

(function () {
  'use strict';

  var S = {
    status: null,      // the server's answer to GET /auth/mfa
    setup: null,       // { base32, otpauth } between enrol and confirm
    codes: null,       // recovery codes on screen, once
    mode: null,        // 'disable' | 'regen' | 'enforce' | 'unenforce' while asking for a code
    busy: false,
    note: null,        // { key, kind }
    loaded: false,
  };

  function tr(key, vars) {
    return (typeof window.t === 'function') ? window.t('settings.mfa.' + key, vars) : key;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var required = false;  // mounted on the sign-in screen's setup view (R7)
  function card() { return document.getElementById(required ? 'auth-mfa-card' : 'set-mfa-card'); }
  function resetState() {
    S.status = null; S.setup = null; S.codes = null; S.mode = null;
    S.busy = false; S.note = null; S.loaded = false;
  }
  function isAdmin() {
    var u = window.State && window.State.user;
    return !!(u && (u.role === 'SUPER_ADMIN' || u.role === 'CLUB_ADMIN'));
  }
  function group(s, n) { return (String(s).match(new RegExp('.{1,' + n + '}', 'g')) || []).join(' '); }
  function codeShown(c) { return (String(c).match(/.{1,4}/g) || []).join('-'); }
  function when(iso) {
    if (!iso) return '—';
    try {
      var loc = (window.I18N && I18N.locale && I18N.locale()) || undefined;
      return new Intl.DateTimeFormat(loc, { dateStyle: 'medium' }).format(new Date(iso));
    } catch (_) { return String(iso).slice(0, 10); }
  }

  async function call(method, path, body) {
    var res = await FamilistaAPI.request(method, path, { body: body });
    return (res && res.data !== undefined) ? res.data : res;
  }

  /** A failure, as one of the card's own sentences. Never the raw server text. */
  function noteFor(err) {
    var st = err && (err.status || (err.response && err.response.status));
    if (st === 400) return { key: 'badCode', kind: 'is-warn' };
    if (st === 403) return { key: 'required', kind: 'is-warn' };
    if (st === 429) return { key: 'tooMany', kind: 'is-warn' };
    if (st === 503) return { key: 'unavailable', kind: 'is-warn' };
    return { key: 'failed', kind: 'is-warn' };
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  function chip(st) {
    if (st && st.enrolled) return '<span class="badge badge-green">' + esc(tr('on')) + '</span>';
    if (st && st.pending) return '<span class="badge badge-amber">' + esc(tr('pending')) + '</span>';
    return '<span class="badge badge-gray">' + esc(tr('off')) + '</span>';
  }

  function codeForm(action, labelKey, helpKey, submitKey) {
    return '<form class="set-mfa-form" data-mfa-form="' + action + '" novalidate>'
      + (helpKey ? '<p class="set-field-help">' + esc(tr(helpKey)) + '</p>' : '')
      + '<label class="set-field-l" for="set-mfa-code">' + esc(tr(labelKey)) + '</label>'
      + '<div class="set-mfa-row">'
      + '<input class="set-mfa-input" id="set-mfa-code" name="code" autocomplete="one-time-code" inputmode="'
      + (action === 'disable' || action === 'unenforce' ? 'text' : 'numeric') + '" maxlength="32" spellcheck="false" data-no-i18n>'
      + '<button class="btn btn-primary btn-sm" type="submit"' + (S.busy ? ' disabled' : '') + '>' + esc(tr(submitKey)) + '</button>'
      + '<button class="btn btn-outline btn-sm" type="button" data-mfa="cancel">' + esc(tr('cancel')) + '</button>'
      + '</div></form>';
  }

  /** Switching enforcement on: an app code and one recovery code, both checked. */
  function enforceForm() {
    return '<form class="set-mfa-form" data-mfa-form="enforce" novalidate>'
      + '<p class="set-field-help">' + esc(tr('enforceHelp')) + '</p>'
      + '<label class="set-field-l" for="set-mfa-code">' + esc(tr('appCode')) + '</label>'
      + '<div class="set-mfa-row">'
      + '<input class="set-mfa-input" id="set-mfa-code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" spellcheck="false" data-no-i18n>'
      + '</div>'
      + '<label class="set-field-l" for="set-mfa-recovery">' + esc(tr('recoveryCode')) + '</label>'
      + '<div class="set-mfa-row">'
      + '<input class="set-mfa-input" id="set-mfa-recovery" name="recoveryCode" autocomplete="off" inputmode="text" maxlength="32" spellcheck="false" data-no-i18n>'
      + '<button class="btn btn-primary btn-sm" type="submit"' + (S.busy ? ' disabled' : '') + '>' + esc(tr('enforce')) + '</button>'
      + '<button class="btn btn-outline btn-sm" type="button" data-mfa="cancel">' + esc(tr('cancel')) + '</button>'
      + '</div></form>';
  }

  /** One line under the intro: whether sign-in asks for a code, in plain words. */
  function enforceLine(st) {
    if (!st || !st.configured || !st.enrolled) return '';
    return '<p class="set-field-help set-mfa-enforce' + (st.enforced ? ' is-on' : '') + '">'
      + (st.enforced ? esc(tr('enforcedOn')) : esc(tr('enforcedOff'))) + '</p>';
  }

  function body() {
    var st = S.status;
    if (!S.loaded) return '<div class="set-mfa-skel" aria-hidden="true"></div>';
    if (!st) return '<p class="set-field-help">' + esc(tr('loadFailed')) + '</p>';
    if (!st.configured) {
      return '<div class="set-mfa-empty"><p class="set-field-help">' + esc(tr('unavailable')) + '</p></div>';
    }

    // Recovery codes on screen: nothing else competes with them.
    if (S.codes) {
      return '<div class="set-mfa-codes-wrap">'
        + '<div class="set-field-l">' + esc(tr('recoveryTitle')) + '</div>'
        + '<p class="set-field-help">' + esc(tr('recoveryHelp')) + '</p>'
        + '<ol class="set-mfa-codes" data-no-i18n>' + S.codes.map(function (c) {
          return '<li><code>' + esc(codeShown(c)) + '</code></li>';
        }).join('') + '</ol>'
        + '<div class="set-mfa-row">'
        + '<button class="btn btn-outline btn-sm" type="button" data-mfa="copy-codes">' + esc(tr('copy')) + '</button>'
        + '<button class="btn btn-outline btn-sm" type="button" data-mfa="download-codes">' + esc(tr('download')) + '</button>'
        + '<button class="btn btn-primary btn-sm" type="button" data-mfa="codes-saved">' + esc(tr('saved')) + '</button>'
        + '</div></div>';
    }

    // Between enrol and confirm.
    if (S.setup) {
      return '<div class="set-mfa-step">'
        + '<div class="set-field-l">' + esc(tr('step1')) + '</div>'
        + '<div class="set-mfa-key" data-no-i18n><code>' + esc(group(S.setup.base32, 4)) + '</code></div>'
        + '<div class="set-mfa-row">'
        + '<button class="btn btn-outline btn-sm" type="button" data-mfa="copy-key">' + esc(tr('copy')) + '</button>'
        + '<a class="btn btn-outline btn-sm" href="' + esc(S.setup.otpauth) + '">' + esc(tr('openApp')) + '</a>'
        + '</div></div>'
        + '<div class="set-mfa-step">'
        + codeForm('confirm', 'step2', null, 'confirm')
        + '</div>';
    }

    if (!st.enrolled) {
      return '<div class="set-mfa-row">'
        + '<button class="btn btn-primary btn-sm" type="button" data-mfa="enroll"' + (S.busy ? ' disabled' : '') + '>'
        + esc(tr('setUp')) + '</button></div>';
    }

    // Enrolled.
    var html = '<dl class="set-mfa-facts">'
      + '<div><dt>' + esc(tr('since')) + '</dt><dd>' + esc(when(st.enabledAt)) + '</dd></div>'
      + '<div><dt>' + esc(tr('remaining')) + '</dt><dd>' + esc(String(st.recoveryCodesRemaining)) + '</dd></div>'
      + '</dl>';
    if (S.mode === 'regen') return html + codeForm('regen', 'code', 'newCodesHelp', 'newCodes');
    if (S.mode === 'disable') return html + codeForm('disable', 'code', 'turnOffHelp', 'turnOff');
    if (S.mode === 'enforce') return html + enforceForm();
    if (S.mode === 'unenforce') return html + codeForm('unenforce', 'code', 'unenforceHelp', 'unenforce');
    // At least two recovery codes: one is spent proving they work, one is left.
    var canEnforce = st.recoveryCodesRemaining >= 2;
    return html + (!st.enforced && !canEnforce ? '<p class="set-field-help">' + esc(tr('needCodes')) + '</p>' : '')
      + '<div class="set-mfa-row">'
      + (st.enforced
        ? '<button class="btn btn-outline btn-sm" type="button" data-mfa="mode-unenforce">' + esc(tr('unenforce')) + '</button>'
        : '<button class="btn btn-primary btn-sm" type="button" data-mfa="mode-enforce"' + (canEnforce ? '' : ' disabled') + '>' + esc(tr('enforce')) + '</button>')
      + '<button class="btn btn-outline btn-sm" type="button" data-mfa="mode-regen">' + esc(tr('newCodes')) + '</button>'
      + '<button class="btn btn-outline btn-sm set-mfa-danger" type="button" data-mfa="mode-disable">' + esc(tr('turnOff')) + '</button>'
      + '</div>';
  }

  function render() {
    var el = card();
    if (!el) return;
    el.innerHTML = '<div class="set-card-hd set-mfa-hd"><span>' + esc(tr('title')) + '</span>'
      + (S.loaded && S.status && S.status.configured ? chip(S.status) : '') + '</div>'
      + '<p class="set-field-help">' + esc(tr('intro')) + '</p>'
      + (S.loaded ? enforceLine(S.status) : '')
      + '<div class="set-mfa-body">' + body() + '</div>'
      + '<p class="set-field-note' + (S.note ? ' ' + S.note.kind : '') + '" role="status" aria-live="polite">'
      + (S.note ? esc(tr(S.note.key)) : '') + '</p>';
    var input = el.querySelector('#set-mfa-code');
    if (input && (S.mode || S.setup) && document.activeElement !== input) {
      try { input.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async function load() {
    try { S.status = await call('GET', '/auth/mfa'); }
    catch (_) { S.status = null; }
    S.loaded = true;
    render();
  }

  async function run(fn) {
    if (S.busy) return;
    S.busy = true; S.note = null; render();
    try { await fn(); }
    catch (err) { S.note = noteFor(err); }
    finally { S.busy = false; render(); }
  }

  function copy(text) {
    var done = function () { S.note = { key: 'copied', kind: 'is-ok' }; render(); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    } catch (_) {}
  }

  function download(codes) {
    try {
      var blob = new Blob([codes.map(codeShown).join('\n') + '\n'], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'familista-recovery-codes.txt';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    } catch (_) {}
  }

  function onClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-mfa]') : null;
    if (!b || !card() || !card().contains(b)) return;
    var a = b.getAttribute('data-mfa');
    if (a === 'enroll') {
      run(async function () { S.setup = await call('POST', '/auth/mfa/enroll'); S.codes = null; });
    } else if (a === 'cancel') {
      S.mode = null; S.setup = null; S.note = null; render();
    } else if (a === 'mode-regen' || a === 'mode-disable' || a === 'mode-enforce' || a === 'mode-unenforce') {
      S.mode = a.slice(5); S.note = null; render();
    } else if (a === 'copy-key' && S.setup) {
      copy(S.setup.base32);
    } else if (a === 'copy-codes' && S.codes) {
      copy(S.codes.map(codeShown).join('\n'));
    } else if (a === 'download-codes' && S.codes) {
      download(S.codes);
    } else if (a === 'codes-saved') {
      S.codes = null; S.note = null; render();
    }
  }

  function onSubmit(ev) {
    var f = ev.target;
    if (!f || !f.getAttribute || !card() || !card().contains(f)) return;
    var action = f.getAttribute('data-mfa-form');
    if (!action) return;
    ev.preventDefault();
    var code = String((f.elements.code && f.elements.code.value) || '').trim();
    var recoveryCode = String((f.elements.recoveryCode && f.elements.recoveryCode.value) || '').trim();
    if (!code || (action === 'enforce' && !recoveryCode)) { S.note = { key: 'badCode', kind: 'is-warn' }; render(); return; }
    run(async function () {
      if (action === 'confirm') {
        var c = await call('POST', '/auth/mfa/confirm', { code: code });
        S.setup = null; S.codes = c.recoveryCodes || null;
      } else if (action === 'regen') {
        var r = await call('POST', '/auth/mfa/recovery-codes', { code: code });
        S.mode = null; S.codes = r.recoveryCodes || null;
      } else if (action === 'disable') {
        await call('POST', '/auth/mfa/disable', { code: code });
        S.mode = null; S.note = { key: 'turnedOff', kind: 'is-ok' };
      } else if (action === 'enforce') {
        await call('POST', '/auth/mfa/enforcement', { enabled: true, code: code, recoveryCode: recoveryCode });
        S.mode = null; S.note = { key: 'enforcedNow', kind: 'is-ok' };
      } else if (action === 'unenforce') {
        await call('POST', '/auth/mfa/enforcement', { enabled: false, code: code });
        S.mode = null; S.note = { key: 'unenforcedNow', kind: 'is-ok' };
      }
      S.status = await call('GET', '/auth/mfa');
    });
  }

  /**
   * Show the card to the platform owner or an administrator and load its
   * state. Called when the Settings page is drawn; for anyone else the card
   * stays hidden.
   */
  function mount() {
    var el = card();
    if (!el || el.getAttribute('data-mfa-mounted') === '1') return;
    var isOwner = typeof window._isPlatformOwner === 'function' ? window._isPlatformOwner() : Promise.resolve(false);
    Promise.resolve(isOwner).then(function (yes) {
      if (!(yes || isAdmin()) || !card()) return;
      el.setAttribute('data-mfa-mounted', '1');
      el.hidden = false;
      render();
      load();
    }).catch(function () {});
  }

  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  // The card is built from bundle strings, so it is redrawn — in place, state
  // kept — whenever the language loads or changes.
  try { if (window.I18N && I18N.onChange) I18N.onChange(function () { if (card() && !card().hidden) render(); }); } catch (_) {}

  /** R7: the sign-in screen's required setup. The session can do nothing else. */
  function mountRequired() {
    required = true;
    resetState();
    var el = card();
    if (!el) return;
    el.hidden = false;
    render();
    load();
  }
  function unmountRequired() {
    var el = card();
    if (el) { el.hidden = true; el.innerHTML = ''; }
    required = false;
    resetState();
  }

  window.SettingsMfa = { mount: mount, render: render, mountRequired: mountRequired, unmountRequired: unmountRequired };
})();
