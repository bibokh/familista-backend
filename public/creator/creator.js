/* The Creator Studio's page (P3): it chooses the language, takes a link's one-time token out of the address before
   anything else can read it, and opens the Design Studio room in a creator's personal workspace. Everything else — who
   is signed in, the gate, the studio — is the room's (product-design.js) and the server's. */
(function () {
  'use strict';
  var links = { verify: null, reset: null };
  var hash = String(window.location.hash || '').replace(/^#/, '');
  var m = /^(verify|reset)=([A-Za-z0-9_-]{20,200})$/.exec(hash);
  if (m) links[m[1]] = m[2];
  if (hash && window.history && typeof window.history.replaceState === 'function') {
    // The token is spent from here on: it is not kept in the address, the history or a bookmark.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  var I = window.I18N;
  // The platform's language switch, for this page alone: remembered in this browser, as the platform remembers it.
  window.I18N_APPLY = { change: function (tag) { if (I) { I.cache(tag); return I.setLocale(tag); } return Promise.resolve(null); } };
  var tag = I ? (I.cached() || I.fromBrowser() || 'en-GB') : 'en-GB';
  (I ? I.setLocale(tag) : Promise.resolve()).then(open, open);
  function open() {
    var host = document.getElementById('pd-creator-root');
    if (host && typeof window.renderFamilistaProductDesign === 'function') {
      window.renderFamilistaProductDesign(host, { workspace: { kind: 'PERSONAL' }, links: links });
    }
  }
}());
