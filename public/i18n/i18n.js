// Familista — the translation runtime
// ─────────────────────────────────────────────────────────────────────────────
// One function does the work: t('navigation.squad'). Everything else here
// exists to make that function always return something sensible.
//
// ── The fallback chain, and why it never returns undefined
//
// A missing key must not blank a button. Lookup falls through:
//     the active locale → en-GB → the key's own last segment, humanised
// so the worst case is a button reading "View Profile" instead of nothing. In
// development the miss is logged once per key; in production it is silent,
// because a console full of warnings helps nobody at that point.
//
// ── Resolution order for WHICH locale
//
//     1. the preference saved on the user row (the truth)
//     2. the browser's languages, matched against what we ship
//     3. en-GB
//
// A saved preference is never overwritten by the browser guess — someone who
// deliberately chose English while running a German browser keeps English.
//
// ── Loading
//
// Bundles are fetched on demand and cached, so a session that never leaves
// English never downloads Japanese. en-GB is the fallback for every other
// locale, so it is fetched once and kept.
//
// ── Direction
//
// Arabic and Hebrew set dir="rtl" on <html>. That is a document-level text and
// layout concern and nothing else: the pitch, tactical coordinates, drag
// arithmetic, LB/RB semantics and charts are football data, not prose, and are
// deliberately left alone. See the .rtl-safe guard in app.css.

(function (root) {
  var CFG = root.FAMILISTA_I18N_CONFIG || {};
  var LOCALES = CFG.LOCALES || [];
  var FALLBACK = CFG.DEFAULT_LOCALE || 'en-GB';
  var STORAGE_KEY = CFG.STORAGE_KEY || 'familista.locale';
  var BUNDLE_PATH = CFG.BUNDLE_PATH || '/i18n/locales/';

  var bundles = {};            // tag -> flat key/value map
  var inflight = {};           // tag -> Promise, so two callers share one fetch
  var current = FALLBACK;
  var missing = {};            // key -> 1, logged once each
  var listeners = [];

  var isDev = (function () {
    try {
      return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(root.location.hostname)
        || /(^|\.)local$/.test(root.location.hostname);
    } catch (_) { return false; }
  })();

  function byTag(tag) {
    var t = String(tag == null ? '' : tag).toLowerCase();
    for (var i = 0; i < LOCALES.length; i++) {
      if (LOCALES[i].tag.toLowerCase() === t) return LOCALES[i];
    }
    return null;
  }
  function isSupported(tag) { return !!byTag(tag); }
  function canonical(tag) { var d = byTag(tag); return d ? d.tag : null; }
  function dirOf(tag) { var d = byTag(tag); return d ? d.dir : 'ltr'; }

  // A bundle is stored flat ("navigation.squad" -> "Kader") so lookup is one
  // property read rather than a walk down a nested object on every call. The
  // files are authored nested, for readability, and flattened on load.
  function flatten(obj, prefix, out) {
    out = out || {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k], key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out[key] = String(v);
    }
    return out;
  }

  function load(tag) {
    var t = canonical(tag);
    if (!t) return Promise.resolve(null);
    if (bundles[t]) return Promise.resolve(bundles[t]);
    if (inflight[t]) return inflight[t];
    inflight[t] = fetch(BUNDLE_PATH + t + '.json', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        bundles[t] = j ? flatten(j) : {};
        delete inflight[t];
        // A key recorded as missing that this bundle answers was never missing:
        // switching language can bring in a bundle that has it. Clearing it here
        // keeps missingKeys() a list of real gaps rather than a history.
        for (var k in bundles[t]) { if (missing[k]) delete missing[k]; }
        return bundles[t];
      })
      .catch(function () {
        // A bundle that fails to load must not take the interface down; the
        // fallback chain simply carries the whole locale.
        bundles[t] = {};
        delete inflight[t];
        return bundles[t];
      });
    return inflight[t];
  }

  // The last resort: turn "common.viewProfile" into "View Profile" so a missing
  // key still reads as a label rather than as debug output.
  function humanise(key) {
    var last = String(key).split('.').pop() || '';
    return last
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function lookup(key) {
    var b = bundles[current];
    if (b && b[key] != null) return b[key];
    var f = bundles[FALLBACK];
    if (f && f[key] != null) return f[key];
    // A key only counts as missing once there is a bundle to miss it from.
    // Before the fetch lands every key looks absent, and the interface calls t()
    // while drawing its first frame, so recording those would fill the signal
    // with dozens of keys that are perfectly present a moment later — and a
    // warning list that is always wrong is a warning list nobody reads. The
    // fallback still returns a sensible label either way; this governs only
    // whether the miss is reported.
    if (isDev && b && f && !missing[key]) {
      missing[key] = 1;
      try { console.warn('[i18n] missing key:', key, '(locale ' + current + ')'); } catch (_) {}
    }
    return humanise(key);
  }

  /**
   * Translate. `vars` interpolates {name} placeholders — used for counts and
   * names, never for building sentences out of fragments.
   */
  function t(key, vars) {
    var s = lookup(key);
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
      });
    }
    return s;
  }

  function applyDocument() {
    try {
      var d = document.documentElement;
      d.setAttribute('lang', current);
      d.setAttribute('dir', dirOf(current));
    } catch (_) {}
  }

  /**
   * Switch language. Loads the bundle, sets the document direction, then tells
   * every listener to repaint. Deliberately no page reload: the active club,
   * team, module, filters and open panels all survive because nothing is
   * unmounted — the same renderers simply run again and read new strings.
   */
  function setLocale(tag, opts) {
    var t2 = canonical(tag) || FALLBACK;
    return Promise.all([load(t2), load(FALLBACK)]).then(function () {
      var changed = t2 !== current;
      current = t2;
      applyDocument();
      if (changed || (opts && opts.force)) emit();
      return t2;
    });
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](current); } catch (_) { /* one bad listener never stops the rest */ }
    }
  }
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
  }

  // The browser's preference, matched against what we actually ship. Tried
  // whole first (pt-BR), then by language (pt → pt-PT), so a close match wins
  // over the English fallback.
  function fromBrowser() {
    var langs = [];
    try {
      langs = (root.navigator && (root.navigator.languages || [root.navigator.language])) || [];
    } catch (_) { langs = []; }
    for (var i = 0; i < langs.length; i++) {
      var exact = canonical(langs[i]);
      if (exact) return exact;
    }
    for (var j = 0; j < langs.length; j++) {
      var base = String(langs[j] || '').split('-')[0].toLowerCase();
      for (var k = 0; k < LOCALES.length; k++) {
        if (LOCALES[k].tag.toLowerCase().split('-')[0] === base) return LOCALES[k].tag;
      }
    }
    return null;
  }

  function cached() {
    try { return canonical(root.localStorage.getItem(STORAGE_KEY)); } catch (_) { return null; }
  }
  function cache(tag) {
    try { root.localStorage.setItem(STORAGE_KEY, tag); } catch (_) {}
  }

  // ── Intl formatting ────────────────────────────────────────────────────────
  // Formatting follows the interface language. The CURRENCY does not: a fee
  // recorded in euros is a euro amount in every language, so the currency code
  // comes from the data and only its presentation is localised.
  function fmtNumber(n, opts) {
    try { return new Intl.NumberFormat(current, opts).format(Number(n)); }
    catch (_) { return String(n); }
  }
  function fmtPercent(n, digits) {
    try {
      return new Intl.NumberFormat(current, {
        style: 'percent', minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0,
      }).format(Number(n) / 100);
    } catch (_) { return String(n) + '%'; }
  }
  function fmtCurrency(amount, code) {
    try {
      return new Intl.NumberFormat(current, {
        style: 'currency', currency: code || 'EUR', maximumFractionDigits: 0,
      }).format(Number(amount));
    } catch (_) { return String(amount); }
  }
  function fmtDate(value, opts) {
    try {
      var d = (value instanceof Date) ? value : new Date(value);
      if (isNaN(d.getTime())) return String(value);
      return new Intl.DateTimeFormat(current, opts || { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
    } catch (_) { return String(value); }
  }

  root.I18N = {
    t: t,
    setLocale: setLocale,
    load: load,
    onChange: onChange,
    locale: function () { return current; },
    dir: function () { return dirOf(current); },
    isRTL: function () { return dirOf(current) === 'rtl'; },
    locales: function () { return LOCALES.slice(); },
    isSupported: isSupported,
    canonical: canonical,
    fromBrowser: fromBrowser,
    cached: cached,
    cache: cache,
    applyDocument: applyDocument,
    missingKeys: function () { return Object.keys(missing); },
    fmtNumber: fmtNumber,
    fmtPercent: fmtPercent,
    fmtCurrency: fmtCurrency,
    fmtDate: fmtDate,
  };
  // The short alias every call site uses.
  root.t = t;
})(typeof window !== 'undefined' ? window : globalThis);
