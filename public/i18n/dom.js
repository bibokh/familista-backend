// Familista — translating the interface itself
// ─────────────────────────────────────────────────────────────────────────────
// The key-per-call-site layer next door (i18n.js + apply.js) is the right shape
// for markup you are writing today: `t('navigation.squad')`, or a `data-i18n`
// attribute. It is also, on its own, incapable of translating this application.
//
// app.js is sixty-two thousand lines that build their markup as strings and
// assign it with innerHTML, and it carries just under seven thousand distinct
// pieces of user-visible English. Migrating those one at a time means seven
// thousand edits inside string concatenation — the change that already broke
// nine tab labels by swallowing a `>` — and it fixes nothing written tomorrow.
// The screenshots that prompted this are exactly that failure: navigation
// translated because someone had reached those call sites, and the Training
// Centre did not because nobody had reached those yet.
//
// So the key here is the English text itself.
//
// This is the gettext model, and its properties are the ones this problem
// needs. A catalogue maps the English a reader would see to the translation of
// it. Any string not in the catalogue renders as the English it already was, so
// a miss is invisible rather than a raw key on a button. Nothing has to be
// migrated for a screen to translate, and a screen written next year translates
// without its author knowing this file exists.
//
// ── What it will not touch, and how it knows
//
// A club is called what it is called. So are players, coaches, emails, uploaded
// filenames and anything a person typed. The rule that keeps those safe is
// structural rather than a list of guesses:
//
//     the catalogue is built from string literals in the source
//
// A player's name is not a literal in app.js, so it cannot be in the catalogue,
// so it cannot be translated — no heuristic, no name detector, nothing to tune.
// On top of that, containers that hold user content are marked and skipped
// outright, which also stops the rare genuine collision (a club named "Live").
//
// ── Numbers
//
// "13 players" is not in the catalogue and never could be. The digits are
// replaced with a placeholder before lookup, so the catalogue holds "%d
// players" once and answers for every count, and the original numbers are put
// back — localised — in the order they appeared. Languages whose plural rules
// differ can hold several forms; see `plural` below.
//
// ── Keeping up with re-renders
//
// Every screen here paints by replacing innerHTML, at unpredictable times. A
// MutationObserver catches each of those and translates what appeared, batched
// into one animation frame so a burst of thirty renders costs one pass.
//
// ── Changing language without a reload
//
// Each translated node remembers the English it came from. Switching language
// restores those originals and translates again, so nothing needs to re-render
// and no screen state is lost. Nodes that have since left the document are
// dropped on the way past, which is what keeps that bookkeeping bounded.

(function (root) {
  var CFG = root.FAMILISTA_I18N_CONFIG || {};
  var CAT_PATH = CFG.CATALOGUE_PATH || '/i18n/catalogue/';
  var FALLBACK = CFG.DEFAULT_LOCALE || 'en-GB';

  var catalogues = {};      // tag -> { english -> translation }
  var inflight = {};
  var active = null;        // the catalogue in force, or null for English
  var activeTag = FALLBACK;
  var misses = Object.create(null);
  var enabled = true;
  var passes = 0, replaced = 0;

  var isDev = (function () {
    try {
      return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(root.location.hostname)
        || /(^|\.)local$/.test(root.location.hostname);
    } catch (_) { return false; }
  })();

  // ── what is never prose ────────────────────────────────────────────────────
  // Script and style are code. SVG and canvas are drawings — an SVG <text> is a
  // label on a pitch diagram and is handled by the same catalogue only when it
  // opts in. textarea and code hold what somebody typed.
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, CANVAS: 1, CODE: 1, PRE: 1, TEXTAREA: 1,
    NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, PATH: 1, DEFS: 1,
  };

  // Containers whose text belongs to the user or to the data, not to Familista.
  // A club's name, a player's name, an email address, an uploaded filename, a
  // typed note. Marked once here rather than guessed at per string.
  var USER_CONTENT = [
    '[data-no-i18n]', '[data-user-content]', '[contenteditable]',
    // Club, team and person names, wherever they are shown.
    '.club-ident-name', '.cp-card-name', '.chd-hero-name', '.hero-club-name',
    '.club-name', '.club-meta', '#nav-club-name', '#nav-club-meta',
    // The club selector lists club names and is skipped whole. The team
    // selector is not: "All teams", "First Team" and the age groups are
    // interface text, and a club's own custom team name is not in any
    // catalogue, so it passes through untouched anyway.
    '#ctx-club', '#topbar-club-name', '#page-subtitle',
    '.sqlu-name', '.sq-plm-name', '.sqmd-nm', '.trn-name', '.co-cc-id b',
    // The places a footballer's or a coach's name is actually printed, found by
    // walking the running interface rather than guessed at.
    '.sqlu-id-nm', '.sqmd-card-nm', '.sqfp-name', '.sqtc-spc-nm', '.sqcw-sp-meta b',
    '.at-ident-chip b', '.ac-tcard-coach-txt b', '.at-head-txt i',
    '.cx-strip-name', '.st-card-name', '.co-staff-name', '.trn-av',
    '.st-name', '.tf-pp-name', '.mcx-key-name', '.mcx-danger-n', '.mcx-pt-n',
    '.at-ident-crest', '.ac-tcard-badge', '.at-head-crest', '.ac-tcard-crest',
    '.team-club-badge', '.hf-name', '.mcx-hero-name', '.mcx-opp-name', '.sqcc-tm-id b',
    // The signed-in person, and the product's own name and version.
    '.user-name', '.user-email', '#user-name', '#user-email', '.user-av',
    '.brand-name', '.brand-version', '.logo-text',
  ].join(',');

  // Position codes are conventional in every language and are left alone.
  var POSITIONS = /^(GK|CB|LB|RB|LWB|RWB|WB|FB|DM|CM|AM|LM|RM|MC|MR|ML|LW|RW|ST|CF|CAM|CDM|DL|DC|DR|AMC|AML|AMR|SW|XI)$/;

  // Names that are the same in every language: the product, its assistant, and
  // the football bodies whose acronyms are not translated.
  // "FOS Core" and the rest of the FOS module names are product names, and a
  // club's name is the club's, not ours — the brief is explicit that club
  // names are never translated, whether they arrive from the database or are
  // written into the markup as the reference tenant.
  var BRAND = /^(Familista|ARIA|FIFA|UEFA|VAR|GPS|xG|xA|OVR|API|FOS|FOS Core|FC Familista)$/i;
  // Short capitals are initials on an avatar or a shirt — except the handful
  // that are genuine interface words and do differ by language (AI is KI in
  // German, IA in French and Spanish).
  var SHORT_WORDS = /^(AI|OK|ID)$/;

  // The attributes a person actually reads.
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];

  // A run of digits, with the separators a formatted number carries inside it.
  var NUM = /\d+(?:[.,\u00A0\u202F]\d+)*/g;
  // The slot a number leaves behind: a control character, so it can never
  // occur in real interface text and never has to be escaped in a pattern.
  var SLOT = '\u0000';

  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  /** Is this worth looking up at all? Cheap rejections, in cost order. */
  function translatable(s) {
    if (!s) return false;
    if (s.length < 2 || s.length > 400) return false;
    if (!/[A-Za-z]/.test(s)) return false;            // digits, punctuation, emoji
    if (POSITIONS.test(s)) return false;
    if (BRAND.test(s)) return false;
    // Two- and three-letter capitals are initials on an avatar, a shirt or a
    // tactical code — never prose, and translating them would be nonsense.
    if (/^[A-Z]{2,3}$/.test(s) && !SHORT_WORDS.test(s)) return false;
    if (/^v\d/.test(s)) return false;                  // a version string
    if (/^[\w.+-]+@[\w.-]+$/.test(s)) return false;   // an email address
    // Technical strings a person may see on an admin screen but which are not
    // prose and must never be translated: an API route, a page slug or other
    // code identifier, a backend enum constant, and anything carrying a
    // comparison operator (an internal rule written out, not a sentence).
    if (/^\/[a-z0-9]/i.test(s)) return false;                    // /api/v1/…
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(s)) return false;       // fos-core, coach-market
    if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s)) return false;  // HEAD_COACH, READY_NOW
    if (/[<>]=?\s*\d|\d\s*[<>]=?/.test(s)) return false;      // fatigue >= 80
    if (/^\w+\.\w+$/.test(s)) return false;                    // window.error
    if (/^(https?:|\/\/|data:|blob:)/.test(s)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false;  // a uuid
    return true;
  }

  function inSkippedElement(node) {
    for (var el = node; el; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      var tag = el.tagName;
      if (!tag) continue;
      if (SKIP_TAGS[tag.toUpperCase()]) return true;
      if (el.matches && el.matches(USER_CONTENT)) return true;
    }
    return false;
  }

  // ── the lookup ─────────────────────────────────────────────────────────────
  // Exact first. Then, for anything carrying digits, the same string with its
  // numbers replaced by a slot — which is how one catalogue entry answers for
  // every count. The numbers go back in the order they came out, formatted for
  // the locale so Arabic gets Arabic-Indic digits where that is the convention.
  function localiseNumber(raw) {
    if (!root.I18N || !root.I18N.fmtNumber) return raw;
    var n = Number(String(raw).replace(/[,  ]/g, ''));
    if (!isFinite(n)) return raw;
    // Only whole, unformatted counts are re-formatted; anything already
    // punctuated is the renderer's own formatting and is left as it is.
    if (!/^\d+$/.test(raw)) return raw;
    return root.I18N.fmtNumber(n);
  }

  // The same words appear in a catalogue-worth of casings — "Players",
  // "PLAYERS", "First team", "First Team" — and holding an entry for each is
  // both wasteful and a standing source of misses, because a screen only has to
  // capitalise differently to fall out of the catalogue. So a miss is retried
  // case-insensitively and the answer is re-cased to match what was asked for.
  var lowerIndex = null;
  function lowerLookup(s) {
    if (!lowerIndex) {
      lowerIndex = Object.create(null);
      for (var k in active) {
        var lk = k.toLowerCase();
        if (lowerIndex[lk] == null) lowerIndex[lk] = active[k];
      }
    }
    return lowerIndex[s.toLowerCase()];
  }
  // ALL CAPS in this interface is a styling decision — a section heading — and
  // it has to survive translation. Title case and sentence case are left alone,
  // because capitalisation rules differ by language and guessing at them does
  // more harm than good.
  function recase(source, translated) {
    if (source === source.toUpperCase() && source !== source.toLowerCase()) {
      return translated.toUpperCase();
    }
    return translated;
  }

  function translate(text) {
    if (!active) return null;
    var s = norm(text);
    if (!translatable(s)) return null;

    var hit = active[s];
    if (hit != null) return hit;
    var loose = lowerLookup(s);
    if (loose != null) return recase(s, loose);

    if (/\d/.test(s)) {
      var nums = s.match(NUM) || [];
      var shape = s.replace(NUM, SLOT);
      // The plural entry is consulted first: a language that needs several
      // forms has supplied them deliberately, and the single form is what a
      // language without that need supplies instead.
      var form = null;
      if (nums.length === 1) {
        // Plural forms, when a language needs them: "%d player" / "%d players"
        // are held as one entry whose value is an array indexed by the locale's
        // own plural category.
        form = active[shape + '|plural'];
        if (form != null) form = plural(form, Number(String(nums[0]).replace(/\D/g, '')));
      }
      if (form == null) form = active[shape];
      if (form == null) {
        var looseShape = lowerLookup(shape);
        if (looseShape != null) form = recase(shape, looseShape);
      }
      if (form != null) {
        var i = 0;
        return String(form).replace(new RegExp(SLOT, 'g'), function () {
          return localiseNumber(nums[i++] != null ? nums[i - 1] : '');
        });
      }
      noteMiss(shape);
      return null;
    }

    noteMiss(s);
    return null;
  }

  // A value stored as "one||other" (or "zero||one||few||many||other") is picked
  // by the locale's own plural category rather than by an English-shaped
  // n === 1 test.
  // A catalogue value may carry several forms separated by "||", listed in the
  // canonical CLDR order of the categories THAT LANGUAGE actually uses — two for
  // German, four for Polish, six for Arabic. Which one applies is decided by
  // Intl.PluralRules for the active locale, never by an English-shaped n === 1,
  // and the index is taken within that language's own categories: Polish has no
  // "zero" and no "two", so its four forms are one|few|many|other and nothing
  // else would line up.
  var CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
  var catsCache = {};
  function categories(tag) {
    if (catsCache[tag]) return catsCache[tag];
    var used;
    try {
      var got = new Intl.PluralRules(tag).resolvedOptions().pluralCategories || ['other'];
      used = CLDR_ORDER.filter(function (c) { return got.indexOf(c) >= 0; });
    } catch (_) { used = ['one', 'other']; }
    catsCache[tag] = used;
    return used;
  }
  function plural(spec, n) {
    var forms = String(spec).split('||');
    if (forms.length === 1) return forms[0];
    var cat;
    try { cat = new Intl.PluralRules(activeTag).select(n); } catch (_) { cat = n === 1 ? 'one' : 'other'; }
    var idx = categories(activeTag).indexOf(cat);
    if (idx < 0 || idx >= forms.length) return forms[forms.length - 1];
    return forms[idx];
  }

  function noteMiss(s) {
    if (misses[s]) return;
    misses[s] = 1;
    if (isDev) { try { console.warn('[i18n] no translation for:', JSON.stringify(s), '(' + activeTag + ')'); } catch (_) {} }
  }

  // ── remembering the English ────────────────────────────────────────────────
  // Keyed by the node, so a language change restores and re-translates without
  // asking any screen to re-render. Disconnected entries are dropped on the way
  // past, which bounds it without a second sweep.
  var tracked = new Map();     // node -> original English (text nodes)
  var trackedAttr = new Map(); // element -> { attr: originalEnglish }

  function applyText(node) {
    var out = translate(node.nodeValue);
    if (out == null) return;
    if (!tracked.has(node)) tracked.set(node, node.nodeValue);
    // Leading and trailing whitespace is layout, not language.
    var lead = (node.nodeValue.match(/^\s*/) || [''])[0];
    var tail = (node.nodeValue.match(/\s*$/) || [''])[0];
    node.nodeValue = lead + out + tail;
    replaced++;
  }

  function applyAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      var out = translate(v);
      if (out == null) continue;
      var store = trackedAttr.get(el);
      if (!store) { store = {}; trackedAttr.set(el, store); }
      if (store[a] == null) store[a] = v;
      el.setAttribute(a, out);
      replaced++;
    }
  }

  /** Translate everything under `rootNode` that has not already been done. */
  function translateTree(rootNode) {
    if (!enabled || !active || !rootNode) return;
    var doc = root.document;
    if (!doc || !doc.createTreeWalker) return;

    if (rootNode.nodeType === 3) {
      if (!inSkippedElement(rootNode)) applyText(rootNode);
      return;
    }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9) return;
    if (rootNode.nodeType === 1 && inSkippedElement(rootNode)) return;

    if (rootNode.nodeType === 1) applyAttrs(rootNode);

    var walker = doc.createTreeWalker(rootNode, 1 | 4 /* ELEMENT | TEXT */, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          var tag = n.tagName && n.tagName.toUpperCase();
          if (tag && SKIP_TAGS[tag]) return 2 /* REJECT — skips the subtree */;
          if (n.matches && n.matches(USER_CONTENT)) return 2;
          return 1;
        }
        return n.nodeValue && /\S/.test(n.nodeValue) ? 1 : 3;
      },
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) applyAttrs(n);
      else applyText(n);
    }
    passes++;
  }

  /** Put every tracked node back to the English it was built with. */
  function restoreAll() {
    tracked.forEach(function (orig, node) {
      if (!node.isConnected) { tracked.delete(node); return; }
      node.nodeValue = orig;
    });
    trackedAttr.forEach(function (store, el) {
      if (!el.isConnected) { trackedAttr.delete(el); return; }
      for (var a in store) if (store[a] != null) el.setAttribute(a, store[a]);
    });
    tracked = new Map();
    trackedAttr = new Map();
  }

  // ── keeping up with renders ────────────────────────────────────────────────
  var observer = null;
  var queued = [];
  var frame = 0;

  function flush() {
    frame = 0;
    var batch = queued; queued = [];
    if (!active) return;
    // The observer is stopped while we write, or our own edits would come
    // straight back to us as mutations.
    var was = observer;
    if (was) was.disconnect();
    try {
      for (var i = 0; i < batch.length; i++) {
        if (batch[i] && batch[i].isConnected) translateTree(batch[i]);
      }
    } finally { if (was) observe(); }
  }

  function schedule(node) {
    queued.push(node);
    if (frame) return;
    frame = (root.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(flush);
  }

  function observe() {
    if (!observer || !root.document || !root.document.body) return;
    observer.observe(root.document.body, { childList: true, subtree: true, characterData: true, attributes: false });
  }

  function start() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') { schedule(r.target); continue; }
        for (var j = 0; j < r.addedNodes.length; j++) schedule(r.addedNodes[j]);
      }
    });
    observe();
  }

  function load(tag) {
    if (!tag || tag === FALLBACK) return Promise.resolve(null);
    if (catalogues[tag]) return Promise.resolve(catalogues[tag]);
    if (inflight[tag]) return inflight[tag];
    inflight[tag] = fetch(CAT_PATH + tag + '.json', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { catalogues[tag] = j || {}; delete inflight[tag]; return catalogues[tag]; })
      .catch(function () { catalogues[tag] = {}; delete inflight[tag]; return catalogues[tag]; });
    return inflight[tag];
  }

  /**
   * Put a locale in force across the whole document. English restores the
   * originals and stops there — English is what the markup already says.
   */
  function setLocale(tag) {
    activeTag = tag || FALLBACK;
    misses = Object.create(null);
    return load(activeTag).then(function (cat) {
      if (observer) observer.disconnect();
      try {
        restoreAll();
        active = (cat && Object.keys(cat).length) ? cat : null;
        lowerIndex = null;
        if (active) translateTree(root.document.body);
      } finally { observe(); }
      return activeTag;
    });
  }

  /**
   * Every string on screen right now that this layer considers user-visible.
   *
   * The audit and the verification harness both read the interface through
   * this rather than through a regular expression of their own, so "what counts
   * as a user-visible string" is defined once, here, and a change to the skip
   * rules cannot leave the audit measuring something else.
   */
  function scan(rootNode) {
    var doc = root.document;
    var out = [];
    var seen = Object.create(null);
    var host = rootNode || doc.body;
    if (!host) return out;
    // Reported against the ENGLISH the node was built from, and flagged with
    // whether the catalogue actually answered for it. Without that flag the
    // audit cannot tell a translated screen from an untranslated one, because
    // both report the same English key.
    var take = function (raw, where, isTranslated) {
      var s = norm(raw);
      if (!translatable(s)) return;
      var key = /\d/.test(s) ? s.replace(NUM, SLOT) : s;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ text: key, where: where, translated: !!isTranslated });
    };
    var walker = doc.createTreeWalker(host, 1 | 4, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          var tag = n.tagName && n.tagName.toUpperCase();
          if (tag && SKIP_TAGS[tag]) return 2;
          if (n.matches && n.matches(USER_CONTENT)) return 2;
          // Only what a reader can actually see.
          if (n.offsetParent === null && n.tagName !== 'BODY'
              && getComputedStyle(n).display === 'none') return 2;
          return 1;
        }
        return n.nodeValue && /\S/.test(n.nodeValue) ? 1 : 3;
      },
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) {
        var store = trackedAttr.get(n);
        for (var i = 0; i < ATTRS.length; i++) {
          if (!n.hasAttribute || !n.hasAttribute(ATTRS[i])) continue;
          var was = store && store[ATTRS[i]] != null;
          take(was ? store[ATTRS[i]] : n.getAttribute(ATTRS[i]), ATTRS[i], was);
        }
      } else {
        // What is on screen now is the translated text when a locale is in
        // force; the English it came from is what the catalogue is keyed by,
        // and being tracked at all is what says it was translated.
        var done = tracked.has(n);
        take(done ? tracked.get(n) : n.nodeValue, 'text', done);
      }
    }
    return out;
  }

  root.I18N_DOM = {
    start: start,
    scan: scan,
    setLocale: setLocale,
    translateTree: function (n) { translateTree(n || root.document.body); },
    load: load,
    locale: function () { return activeTag; },
    /** Strings seen on screen that the catalogue could not answer for. */
    missing: function () { return Object.keys(misses); },
    stats: function () {
      return {
        locale: activeTag, passes: passes, replaced: replaced,
        entries: active ? Object.keys(active).length : 0,
        tracked: tracked.size, missing: Object.keys(misses).length,
      };
    },
    /** For the extractor and the audit, which need the untranslated document. */
    disable: function () { enabled = false; },
    enable: function () { enabled = true; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
