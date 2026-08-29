// Familista — connecting the translation runtime to the running interface
// ─────────────────────────────────────────────────────────────────────────────
// Two mechanisms, deliberately only two, because the alternative is a language
// check at every call site.
//
//   1. DECLARATIVE, for markup that already exists: an element carrying
//      data-i18n="navigation.squad" has its text replaced. Attributes get
//      data-i18n-placeholder / -title / -aria. Static HTML needs no JavaScript
//      of its own and cannot forget to re-translate.
//
//   2. IMPERATIVE, for markup built by a renderer: the renderer calls t() while
//      building its string, and registers with I18N.onChange so it runs again
//      when the language changes.
//
// ── Why no reload
//
// Changing language re-runs renderers; it does not remount the app. The active
// club, team, page, filters and open panels are all held in ordinary JavaScript
// state that nothing here touches, so they survive by not being disturbed. That
// is also why the language change cannot lose a half-filled form.

(function (root) {
  var API_PATH = '/me/settings';

  /**
   * Re-translate every element in `scope` that declares a key. Safe to call as
   * often as you like: it is idempotent and reads from the DOM each time, so
   * markup rendered after the last language change is picked up too.
   */
  function translateDOM(scope) {
    var el = scope || document;
    if (!el || !el.querySelectorAll) return;
    var t = root.I18N.t;
    el.querySelectorAll('[data-i18n]').forEach(function (n) {
      var k = n.getAttribute('data-i18n'); if (k) n.textContent = t(k);
    });
    el.querySelectorAll('[data-i18n-placeholder]').forEach(function (n) {
      var k = n.getAttribute('data-i18n-placeholder'); if (k) n.setAttribute('placeholder', t(k));
    });
    el.querySelectorAll('[data-i18n-title]').forEach(function (n) {
      var k = n.getAttribute('data-i18n-title'); if (k) n.setAttribute('title', t(k));
    });
    el.querySelectorAll('[data-i18n-aria]').forEach(function (n) {
      var k = n.getAttribute('data-i18n-aria'); if (k) n.setAttribute('aria-label', t(k));
    });
  }

  // Renderers that must run again on a language change. Kept as plain functions
  // so a module can register without knowing anything about the i18n internals.
  var repainters = [];
  function registerRepaint(fn) { if (typeof fn === 'function') repainters.push(fn); }
  function repaintAll() {
    translateDOM(document);
    for (var i = 0; i < repainters.length; i++) {
      try { repainters[i](); } catch (_) { /* one screen failing never blocks the rest */ }
    }
    // …and then the third mechanism, which is the one that reaches the other
    // sixty-two thousand lines. The two above only translate what somebody
    // remembered to mark; this one translates the document.
    try { if (root.I18N_DOM) root.I18N_DOM.translateTree(document.body); } catch (_) {}
  }

  /**
   * Put a locale in force everywhere: keys, then the document itself.
   *
   * The order matters. The declarative pass rewrites marked elements from their
   * keys, and the document pass then translates whatever is left — so a screen
   * that was migrated keeps its curated wording and a screen that was not still
   * ends up in the reader's language.
   */
  function applyEverywhere(tag) {
    var p = (root.I18N_DOM ? root.I18N_DOM.setLocale(tag) : Promise.resolve(tag));
    return p.then(function () { repaintAll(); return tag; });
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  // The server row is the truth; localStorage is a cache that makes the FIRST
  // paint correct instead of flashing English. Resolution:
  //     saved preference → browser locale → en-GB
  // and a null from the server means "never chosen", which is why it does not
  // overwrite anything.

  // Two API objects exist in this app: the standalone client exposes its verbs
  // under `.raw`, and app.js defines its own with the verbs at the top level
  // and assigns it over `window.FamilistaAPI`. Whichever is installed when this
  // runs, take the verbs from it — looking only under `.raw` meant every save
  // silently did nothing once app.js had loaded.
  function raw() {
    var A = root.FamilistaAPI;
    if (!A) return null;
    if (typeof A.patch === 'function' && typeof A.get === 'function') return A;
    if (A.raw && typeof A.raw.patch === 'function') return A.raw;
    return null;
  }
  function apiGet() {
    var r = raw();
    if (!r) return Promise.resolve(null);
    return r.get(API_PATH).then(function (res) {
      return (res && res.data) ? res.data : null;
    }).catch(function () { return null; });   // signed out, offline — cache carries it
  }
  function apiSave(tag) {
    var r = raw();
    if (!r) return Promise.reject(new Error('no api client'));
    return r.patch(API_PATH, { locale: tag });
  }

  /**
   * Settle the language for this session. Called at boot and again after
   * sign-in, because the second call is the first time there is a user to ask.
   */
  function boot() {
    var I = root.I18N;
    // Paint immediately from the cache so there is no English flash, then
    // reconcile with the server.
    var first = I.cached() || I.fromBrowser() || I.canonical('en-GB');
    // The observer has to be watching before the first render, or everything
    // painted between boot and the first language change is missed.
    try { if (root.I18N_DOM) root.I18N_DOM.start(); } catch (_) {}
    return I.setLocale(first, { force: true }).then(function () {
      return applyEverywhere(first);
    }).then(function () {
      return apiGet();
    }).then(function (data) {
      if (!data) return I.locale();
      if (data.locale && I.canonical(data.locale) && data.locale !== I.locale()) {
        // The server knows better than the browser guess.
        return I.setLocale(data.locale).then(function (tag) {
          I.cache(tag); return applyEverywhere(tag);
        });
      }
      if (data.locale) I.cache(data.locale);
      return I.locale();
    }).catch(function () { return root.I18N.locale(); });
  }

  /**
   * Change language: apply locally first so the interface responds instantly,
   * then persist. A failed save leaves the choice applied for this session and
   * says so — it does not silently revert the interface the user just changed.
   */
  function change(tag) {
    var I = root.I18N;
    var t2 = I.canonical(tag);
    if (!t2) return Promise.resolve(null);
    return I.setLocale(t2).then(function () {
      I.cache(t2);
      return applyEverywhere(t2);
    }).then(function () {
      return apiSave(t2).then(
        function () { return { locale: t2, saved: true }; },
        function () { return { locale: t2, saved: false }; }
      );
    });
  }

  root.I18N_APPLY = {
    translateDOM: translateDOM,
    registerRepaint: registerRepaint,
    repaintAll: repaintAll,
    applyEverywhere: applyEverywhere,
    boot: boot,
    change: change,
  };
})(typeof window !== 'undefined' ? window : globalThis);
