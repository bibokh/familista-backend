/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — DS-1b — the server, from the browser

   The one file in this room that talks to the API, and only to the platform
   owner's design routes: /api/v1/system/product-design (same origin, so the
   Content-Security-Policy's connect-src 'self' already allows it). It sends the
   session the way every owner room does — the cookie, or the stored bearer
   token — and never decides who may do what: the server does.

   It also remembers, in this browser, which saved design the draft in the
   editor belongs to and which revision it was based on (LINK_KEY), with a
   fingerprint of the text that revision had, so the room can tell "saved" from
   "unsaved changes" without asking the server. The draft itself stays where
   DS-1a keeps it; nothing here reads, moves or deletes it.

   No DOM. Loaded by public/app.js after pd-core.js and before product-design.js,
   and required directly by tests/product-design-server.unit.test.ts.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FamilistaProductDesignServer = factory(root);
}(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  var BASE = '/system/product-design';
  var LINK_KEY = 'familista_product_design_link_v1';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var ORIGINS = ['EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT'];

  function apiBase() { return root.FAM_CONFIG && root.FAM_CONFIG.API_BASE ? root.FAM_CONFIG.API_BASE : '/api/v1'; }
  function token() {
    try { return (root.State && root.State.token) || root.localStorage.getItem('familista_token') || ''; } catch (_) { return ''; }
  }
  function storage() { try { return root.localStorage || null; } catch (_) { return null; } }

  /**
   * One call. Always resolves, never rejects: { ok, status, code, data, message, errors }.
   * status 0 and code 'NETWORK' when the server could not be reached at all.
   */
  function call(method, path, body) {
    var headers = { Accept: 'application/json' };
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    var init = { method: method, headers: headers, credentials: 'include', cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return root.fetch(apiBase() + BASE + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        b = b && typeof b === 'object' ? b : {};
        return {
          ok: r.ok && b.success !== false, status: r.status, code: typeof b.code === 'string' ? b.code : null,
          data: b.data === undefined ? null : b.data, message: typeof b.message === 'string' ? b.message : '',
          errors: Array.isArray(b.errors) ? b.errors : [],
        };
      });
    }, function () {
      return { ok: false, status: 0, code: 'NETWORK', data: null, message: '', errors: [] };
    });
  }
  function id(projectId) { return encodeURIComponent(String(projectId)); }

  var api = {
    listProjects: function (state) { return call('GET', '/projects?state=' + (state === 'archived' ? 'archived' : 'active')); },
    createProject: function (document, origin) { return call('POST', '/projects', { document: document, origin: ORIGINS.indexOf(origin) !== -1 ? origin : 'EDITOR' }); },
    openProject: function (projectId) { return call('GET', '/projects/' + id(projectId)); },
    saveRevision: function (projectId, baseRevision, document) { return call('POST', '/projects/' + id(projectId) + '/revisions', { baseRevision: baseRevision, document: document }); },
    listRevisions: function (projectId) { return call('GET', '/projects/' + id(projectId) + '/revisions'); },
    // Read only: one saved version with its document, for the 3D comparison (DS-1c). Nothing is written.
    getRevision: function (projectId, number) { return call('GET', '/projects/' + id(projectId) + '/revisions/' + Number(number)); },
    restoreRevision: function (projectId, number, baseRevision) { return call('POST', '/projects/' + id(projectId) + '/revisions/' + Number(number) + '/restore', { baseRevision: baseRevision }); },
    archive: function (projectId) { return call('POST', '/projects/' + id(projectId) + '/archive', {}); },
    unarchive: function (projectId) { return call('POST', '/projects/' + id(projectId) + '/unarchive', {}); },
  };

  /** FNV-1a, 32 bits, over the text's UTF-16 code units: a fingerprint to tell two texts apart, not a security hash. */
  function fingerprint(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /** The saved design the editor's draft belongs to, or null. A malformed record is ignored, never trusted. */
  function readLink() {
    var s = storage();
    if (!s) return null;
    var raw = null;
    try { raw = s.getItem(LINK_KEY); } catch (_) { return null; }
    if (!raw) return null;
    var v = null;
    try { v = JSON.parse(raw); } catch (_) { return null; }
    if (!v || typeof v !== 'object' || typeof v.projectId !== 'string' || !UUID.test(v.projectId)) return null;
    if (typeof v.revision !== 'number' || v.revision < 1 || Math.floor(v.revision) !== v.revision || typeof v.fp !== 'string' || !/^[0-9a-f]{8}$/.test(v.fp)) return null;
    return { projectId: v.projectId, revision: v.revision, fp: v.fp };
  }
  function writeLink(link) {
    var s = storage();
    if (!s) return false;
    try { s.setItem(LINK_KEY, JSON.stringify({ projectId: link.projectId, revision: link.revision, fp: link.fp })); return true; } catch (_) { return false; }
  }
  function clearLink() {
    var s = storage();
    if (!s) return;
    try { s.removeItem(LINK_KEY); } catch (_) { /* storage unavailable: nothing to clear */ }
  }

  return Object.freeze({ BASE: BASE, LINK_KEY: LINK_KEY, ORIGINS: ORIGINS, api: api, fingerprint: fingerprint, readLink: readLink, writeLink: writeLink, clearLink: clearLink });
}));
