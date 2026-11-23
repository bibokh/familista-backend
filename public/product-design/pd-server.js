/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — DS-1b — the server, from the browser

   The one file in this room that talks to the API, and only to the design
   routes of the workspace the room is open in: the platform owner's
   (/api/v1/system/product-design) or, in a club, the club's own
   (/api/v1/club-design, M2). Same origin, so the Content-Security-Policy's
   connect-src 'self' already allows it. It sends the session the way every
   room does — the cookie, or the stored bearer token — and never decides who
   may do what, or which club: the server does, from the session.

   It also remembers, in this browser, which saved design the draft in the
   editor belongs to and which revision it was based on (LINK_KEY), with a
   fingerprint of the text that revision had, so the room can tell "saved" from
   "unsaved changes" without asking the server. A club's record is kept apart
   from the platform's and from every other club's (its own key), so one
   browser used for both never links a draft to the wrong workspace. The draft
   itself stays where the editor keeps it; nothing here reads, moves or deletes it.

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
  var CLUB_BASE = '/club-design';
  var CLUB_ID = /^[A-Za-z0-9_-]{1,64}$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var ORIGINS = ['EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT'];

  function apiBase() { return root.FAM_CONFIG && root.FAM_CONFIG.API_BASE ? root.FAM_CONFIG.API_BASE : '/api/v1'; }
  function token() {
    try { return (root.State && root.State.token) || root.localStorage.getItem('familista_token') || ''; } catch (_) { return ''; }
  }
  function storage() { try { return root.localStorage || null; } catch (_) { return null; } }

  /** FNV-1a, 32 bits, over the text's UTF-16 code units: a fingerprint to tell two texts apart, not a security hash. */
  function fingerprint(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /** A client for one workspace's routes and its own record of the saved design the draft belongs to. */
  function client(base, linkKey) {
    /**
     * One call. Always resolves, never rejects: { ok, status, code, data, message, errors } (and `reason` when the
     * server gives one). status 0 and code 'NETWORK' when the server could not be reached at all. `opts.raw` sends a
     * file's bytes as they are, with their image type (a brand-kit logo); `opts.blob` reads the answer as bytes (its
     * image) into `blob`, never as anything to run.
     */
    function call(method, path, body, opts) {
      opts = opts || {};
      var headers = { Accept: opts.blob ? 'image/png' : 'application/json' };
      var t = token();
      if (t) headers.Authorization = 'Bearer ' + t;
      var init = { method: method, headers: headers, credentials: 'include', cache: 'no-store' };
      if (opts.raw) { headers['Content-Type'] = /^image\/(png|jpeg)$/.test(opts.raw.type) ? opts.raw.type : 'application/octet-stream'; init.body = opts.raw; }
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      return root.fetch(apiBase() + base + path, init).then(function (r) {
        if (opts.blob && r.ok) {
          return r.blob().then(function (b) { return { ok: true, status: r.status, code: null, data: null, blob: b, message: '', errors: [] }; },
            function () { return { ok: false, status: r.status, code: 'NETWORK', data: null, message: '', errors: [] }; });
        }
        return r.json().catch(function () { return {}; }).then(function (b) {
          b = b && typeof b === 'object' ? b : {};
          return {
            ok: r.ok && b.success !== false, status: r.status, code: typeof b.code === 'string' ? b.code : null,
            data: b.data === undefined ? null : b.data, message: typeof b.message === 'string' ? b.message : '',
            errors: Array.isArray(b.errors) ? b.errors : [], reason: typeof b.reason === 'string' ? b.reason : null,
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
    // A club's brand kit (M2c): only a club's client has one; the platform's routes serve none.
    if (base === CLUB_BASE) {
      api.brandKit = function (state) { return call('GET', '/brand-kit?state=' + (state === 'archived' ? 'archived' : 'active')); };
      api.saveBrandColours = function (colours) { return call('PUT', '/brand-kit/colours', { colours: colours }); };
      api.uploadBrandAsset = function (kind, name, file) {
        return call('POST', '/brand-kit/assets?kind=' + encodeURIComponent(String(kind)) + '&name=' + encodeURIComponent(String(name)), undefined, { raw: file });
      };
      api.brandAssetImage = function (assetId) { return call('GET', '/brand-kit/assets/' + id(assetId) + '/image', undefined, { blob: true }); };
      api.archiveBrandAsset = function (assetId) { return call('POST', '/brand-kit/assets/' + id(assetId) + '/archive', {}); };
      api.unarchiveBrandAsset = function (assetId) { return call('POST', '/brand-kit/assets/' + id(assetId) + '/unarchive', {}); };
    }

    /** The saved design the editor's draft belongs to, or null. A malformed record is ignored, never trusted. */
    function readLink() {
      var s = storage();
      if (!s) return null;
      var raw = null;
      try { raw = s.getItem(linkKey); } catch (_) { return null; }
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
      try { s.setItem(linkKey, JSON.stringify({ projectId: link.projectId, revision: link.revision, fp: link.fp })); return true; } catch (_) { return false; }
    }
    function clearLink() {
      var s = storage();
      if (!s) return;
      try { s.removeItem(linkKey); } catch (_) { /* storage unavailable: nothing to clear */ }
    }

    return Object.freeze({ BASE: base, LINK_KEY: linkKey, ORIGINS: ORIGINS, api: api, fingerprint: fingerprint, readLink: readLink, writeLink: writeLink, clearLink: clearLink });
  }

  var platform = client(BASE, LINK_KEY);
  /**
   * The client of the workspace the room is open in: { kind: 'PLATFORM' }, or { kind: 'CLUB', clubId } — the club the
   * session has open, which only names the record kept in this browser; the server serves the session's own club, never
   * one a request names. Anything else is refused (null), never guessed.
   */
  function forWorkspace(w) {
    if (!w || w.kind === 'PLATFORM') return platform;
    if (w.kind === 'CLUB' && typeof w.clubId === 'string' && CLUB_ID.test(w.clubId)) return client(CLUB_BASE, LINK_KEY + '_club_' + w.clubId);
    return null;
  }
  return Object.freeze({ BASE: platform.BASE, LINK_KEY: platform.LINK_KEY, ORIGINS: ORIGINS, api: platform.api, fingerprint: fingerprint,
    readLink: platform.readLink, writeLink: platform.writeLink, clearLink: platform.clearLink, CLUB_BASE: CLUB_BASE, forWorkspace: forWorkspace });
}));
