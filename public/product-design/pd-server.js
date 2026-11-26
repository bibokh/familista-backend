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
  // M4: the Platform Owner's manufacturing console (owner-brokered). The server refuses it to anyone else.
  var MFG_BASE = '/system/manufacturing';
  // P3: a creator's own workspace (Creator Studio). Its session is the creator's cookie alone: a club's token is never sent.
  var CREATOR_BASE = '/creator';
  var CREATOR_AUTH = '/creator/auth';
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
    var creator = base === CREATOR_BASE || base === CREATOR_AUTH;
    /**
     * One call. Always resolves, never rejects: { ok, status, code, data, message, errors } (and `reason` when the
     * server gives one). status 0 and code 'NETWORK' when the server could not be reached at all. `opts.raw` sends a
     * file's bytes as they are, with their image type (a brand-kit logo); `opts.blob` reads the answer as bytes (its
     * image) into `blob`, never as anything to run.
     */
    function call(method, path, body, opts) {
      opts = opts || {};
      var headers = { Accept: opts.blob ? (opts.accept === 'text/csv' ? 'text/csv' : 'image/png') : 'application/json' };
      var t = creator ? '' : token();
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

    // P3: a creator's access token lives fifteen minutes; on a 401 the session is renewed once (the refresh cookie) and
    // the call made again. The sign-in calls themselves are never retried.
    if (base === CREATOR_BASE) {
      var once = call, renewing = null;
      call = function (method, path, body, opts) {
        return once(method, path, body, opts).then(function (r) {
          if (r.status !== 401) return r;
          renewing = renewing || renew().then(function (x) { renewing = null; return x; });
          return renewing.then(function (ok) { return ok ? once(method, path, body, opts) : r; });
        });
      };
    }
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
    // M8a: the Platform Owner's rollout control: which clubs the Club Design Studio and its parts are released to. Only
    // the platform's client has it; the server refuses it to anyone but the Owner.
    if (base === BASE) {
      // P1: the retention of the personal data the studio keeps; none is set until the Owner sets it.
      api.retention = function () { return call('GET', '/privacy/retention'); };
      api.setRetention = function (kind, days) { return call('PUT', '/privacy/retention', { kind: String(kind), days: days === null ? null : Number(days) }); };
      api.applyRetention = function (dryRun) { return call('POST', '/privacy/retention/apply', { dryRun: dryRun !== false }); };
      api.rollout = function () { return call('GET', '/rollout'); };
      // P2: the Creator Studio's accounts. An invitation's code comes back once, from the call that issues it.
      api.creators = function () { return call('GET', '/creators'); };
      api.creatorInvites = function () { return call('GET', '/creators/invites'); };
      api.createCreatorInvite = function (opts) {
        var o = opts || {};
        return call('POST', '/creators/invites', { email: o.email ? String(o.email) : null, note: o.note ? String(o.note) : null, maxUses: Number(o.maxUses) || 1, days: Number(o.days) || 14 });
      };
      api.revokeCreatorInvite = function (inviteId) { return call('POST', '/creators/invites/' + id(inviteId) + '/revoke', {}); };
      // P3: the Owner's hand on an account: an address confirmed by other means, a suspension, a reinstatement; each with a note.
      api.verifyCreatorEmail = function (creatorId, note) { return call('POST', '/creators/' + id(creatorId) + '/verify-email', { note: String(note || '') }); };
      api.suspendCreator = function (creatorId, note) { return call('POST', '/creators/' + id(creatorId) + '/suspend', { note: String(note || '') }); };
      api.reinstateCreator = function (creatorId, note) { return call('POST', '/creators/' + id(creatorId) + '/reinstate', { note: String(note || '') }); };
      // P5/P6: the plans the Owner configures, and every tenant's subscriptions and invoices. Nothing here charges anyone:
      // a plan granted by the Owner carries a note, and an invoice is settled only by a payment provider's event.
      api.plans = function () { return call('GET', '/plans'); };
      api.createPlan = function (p) { return call('POST', '/plans', p); };
      api.savePlan = function (planId, p) { return call('PUT', '/plans/' + id(planId), p); };
      api.billing = function () { return call('GET', '/billing'); };
      api.grantPlan = function (g) {
        return call('POST', '/billing/grant', { tenantKind: g.tenantKind === 'club' ? 'club' : 'creator', tenantId: String(g.tenantId || ''), planKey: String(g.planKey || ''),
          months: g.months === null || g.months === undefined || g.months === '' ? null : Number(g.months), note: String(g.note || '') });
      };
      api.endSubscription = function (subscriptionId, note) { return call('POST', '/billing/subscriptions/' + id(subscriptionId) + '/end', { note: String(note || '') }); };
      api.voidInvoice = function (invoiceId) { return call('POST', '/billing/invoices/' + id(invoiceId) + '/void', {}); };
      api.expireSubscriptions = function (dryRun) { return call('POST', '/billing/expire', { dryRun: dryRun !== false }); };
      api.setRollout = function (clubId, changes) {
        if (!CLUB_ID.test(String(clubId))) return Promise.resolve({ ok: false, status: 0, code: 'BAD_CLUB', data: null, message: '', errors: [] });
        return call('PUT', '/rollout/' + encodeURIComponent(clubId), changes);
      };
    }
    // A club's brand kit (M2c), and a creator's (P3): the platform's routes serve none.
    if (base === CLUB_BASE || base === CREATOR_BASE) {
      api.brandKit = function (state) { return call('GET', '/brand-kit?state=' + (state === 'archived' ? 'archived' : 'active')); };
      api.saveBrandColours = function (colours) { return call('PUT', '/brand-kit/colours', { colours: colours }); };
      api.uploadBrandAsset = function (kind, name, file) {
        return call('POST', '/brand-kit/assets?kind=' + encodeURIComponent(String(kind)) + '&name=' + encodeURIComponent(String(name)), undefined, { raw: file });
      };
      api.brandAssetImage = function (assetId) { return call('GET', '/brand-kit/assets/' + id(assetId) + '/image', undefined, { blob: true }); };
      api.archiveBrandAsset = function (assetId) { return call('POST', '/brand-kit/assets/' + id(assetId) + '/archive', {}); };
      api.unarchiveBrandAsset = function (assetId) { return call('POST', '/brand-kit/assets/' + id(assetId) + '/unarchive', {}); };
      // The club's team rosters (M3) and its squad's names, to start one from.
      api.listRosters = function (state) { return call('GET', '/rosters?state=' + (state === 'archived' ? 'archived' : 'active')); };
      api.createRoster = function (name, entries, includesMinors) { return call('POST', '/rosters', { name: name, entries: entries || [], includesMinors: includesMinors === true }); };
      api.openRoster = function (rosterId) { return call('GET', '/rosters/' + id(rosterId)); };
      api.saveRoster = function (rosterId, version, name, entries, includesMinors) {
        var body = { name: name, entries: entries, version: version };
        if (typeof includesMinors === 'boolean') body.includesMinors = includesMinors;
        return call('PUT', '/rosters/' + id(rosterId), body);
      };
      api.archiveRoster = function (rosterId) { return call('POST', '/rosters/' + id(rosterId) + '/archive', {}); };
      api.unarchiveRoster = function (rosterId) { return call('POST', '/rosters/' + id(rosterId) + '/unarchive', {}); };
      api.deleteRoster = function (rosterId) { return call('DELETE', '/rosters/' + id(rosterId)); };
      // A club's squad: a creator has no players to start a roster from.
      if (base === CLUB_BASE) api.squadNames = function () { return call('GET', '/squad-names'); };
      // The club's collections (M3b): its designs as one kit, and the order sheet a roster makes of it.
      api.listCollections = function (state) { return call('GET', '/collections?state=' + (state === 'archived' ? 'archived' : 'active')); };
      api.createCollection = function (c) { return call('POST', '/collections', { name: c.name, season: c.season, rosterId: c.rosterId, items: c.items }); };
      api.openCollection = function (collectionId) { return call('GET', '/collections/' + id(collectionId)); };
      api.saveCollection = function (collectionId, version, c) {
        return call('PUT', '/collections/' + id(collectionId), { name: c.name, season: c.season, rosterId: c.rosterId, items: c.items, version: version });
      };
      api.archiveCollection = function (collectionId) { return call('POST', '/collections/' + id(collectionId) + '/archive', {}); };
      api.unarchiveCollection = function (collectionId) { return call('POST', '/collections/' + id(collectionId) + '/unarchive', {}); };
      api.deleteCollection = function (collectionId) { return call('DELETE', '/collections/' + id(collectionId)); };
      api.orderSheet = function (collectionId, rosterId) {
        return call('GET', '/collections/' + id(collectionId) + '/order-sheet' + (rosterId ? '?rosterId=' + id(rosterId) : ''));
      };
      // Manufacturing (M4, owner-brokered): the club's requests for quotation, the quotations published to it, its steps.
      api.submitRequest = function (collectionId, r) {
        return call('POST', '/collections/' + id(collectionId) + '/requests', { rosterId: r.rosterId || null, note: r.note || null, neededBy: r.neededBy || null, minorsConsent: r.minorsConsent === true });
      };
      api.listRequests = function () { return call('GET', '/requests'); };
      api.openRequest = function (requestId) { return call('GET', '/requests/' + id(requestId)); };
      api.cancelRequest = function (requestId, note) { return call('POST', '/requests/' + id(requestId) + '/cancel', { note: note || null }); };
      api.declineQuotes = function (requestId, note) { return call('POST', '/requests/' + id(requestId) + '/decline', { note: note || null }); };
      api.confirmDelivery = function (requestId, note) { return call('POST', '/requests/' + id(requestId) + '/delivered', { note: note || null }); };
      // P1: a club administrator erases a person's name from the club's design data; previewed unless confirmed.
      if (base === CLUB_BASE) api.erasePerson = function (name, confirm) { return call('POST', '/privacy/erase-person', { name: String(name || ''), confirm: confirm === true }); };
      api.acceptQuote = function (requestId, quoteId) { return call('POST', '/requests/' + id(requestId) + '/quotes/' + id(quoteId) + '/accept', {}); };
      // Reviews (M7b): comments on a saved version, and a club administrator's decision on the newest one.
      api.readReview = function (projectId) { return call('GET', '/projects/' + id(projectId) + '/review'); };
      api.commentOnDesign = function (projectId, c) { return call('POST', '/projects/' + id(projectId) + '/comments', { revision: c.revision, surface: c.surface || null, body: c.body }); };
      api.resolveComment = function (projectId, commentId) { return call('POST', '/projects/' + id(projectId) + '/comments/' + id(commentId) + '/resolve', {}); };
      api.reopenComment = function (projectId, commentId) { return call('POST', '/projects/' + id(projectId) + '/comments/' + id(commentId) + '/reopen', {}); };
      api.decideOnDesign = function (projectId, d) { return call('POST', '/projects/' + id(projectId) + '/decisions', { revision: d.revision, decision: d.decision, note: d.note || null }); };
      // P5: the tenant's own plan, what it includes, and its invoices; the professional tools a plan opens. P6: an open
      // invoice is paid through the payment provider only — with none configured, checkout answers so and charges nothing.
      api.plan = function () { return call('GET', '/plan'); };
      api.requestPlan = function (planKey) { return call('POST', '/plan/request', { planKey: String(planKey || '') }); };
      api.cancelPlan = function () { return call('POST', '/plan/cancel', {}); };
      api.checkout = function (invoiceId) { return call('POST', '/billing/invoices/' + id(invoiceId) + '/checkout', {}); };
      api.techPack = function (projectId, format) {
        return format === 'csv' ? call('GET', '/projects/' + id(projectId) + '/tech-pack?format=csv', undefined, { blob: true, accept: 'text/csv' }) : call('GET', '/projects/' + id(projectId) + '/tech-pack');
      };
      api.proExport = function (projectId) { return call('POST', '/projects/' + id(projectId) + '/exports', {}); };
    }

    // P3: a creator's account, in the creator's own workspace: the profile, the password, the address, the data.
    if (base === CREATOR_BASE) {
      api.me = function () { return call('GET', '/me'); };
      api.updateProfile = function (p) { var b = {}; if (p.displayName !== undefined) b.displayName = String(p.displayName); if (p.locale !== undefined) b.locale = String(p.locale); return call('PATCH', '/me', b); };
      api.changePassword = function (currentPassword, newPassword) { return call('POST', '/me/password', { currentPassword: String(currentPassword || ''), newPassword: String(newPassword || '') }); };
      api.resendVerification = function () { return call('POST', '/me/verification', {}); };
      api.exportData = function () { return call('GET', '/me/export'); };
      api.deleteAccount = function (password) { return call('POST', '/me/delete', { password: String(password || '') }); };
      // P4: sharing a design with another creator (to see it, or to comment too), and the designs shared with this one.
      api.listShares = function (projectId) { return call('GET', '/projects/' + id(projectId) + '/shares'); };
      api.shareDesign = function (projectId, email, role) { return call('POST', '/projects/' + id(projectId) + '/shares', { email: String(email || ''), role: role === 'COMMENT' ? 'COMMENT' : 'VIEW' }); };
      api.revokeShare = function (projectId, shareId) { return call('POST', '/projects/' + id(projectId) + '/shares/' + id(shareId) + '/revoke', {}); };
      api.sharedWithMe = function () { return call('GET', '/shared'); };
      api.openShared = function (projectId) { return call('GET', '/shared/' + id(projectId)); };
      api.readSharedReview = function (projectId) { return call('GET', '/shared/' + id(projectId) + '/review'); };
      api.commentOnShared = function (projectId, c) { return call('POST', '/shared/' + id(projectId) + '/comments', { revision: c.revision, surface: c.surface || null, body: c.body }); };
    }
    // P3: the way into a creator's account, before any session. Never retried, never carrying a club's token.
    if (base === CREATOR_AUTH) {
      api = {
        terms: function () { return call('GET', '/terms'); },
        register: function (r) {
          return call('POST', '/register', { inviteCode: String(r.inviteCode || ''), email: String(r.email || ''), password: String(r.password || ''),
            displayName: String(r.displayName || ''), locale: r.locale ? String(r.locale) : undefined, ageConfirmed: r.ageConfirmed === true });
        },
        login: function (email, password) { return call('POST', '/login', { email: String(email || ''), password: String(password || '') }); },
        refresh: function () { return call('POST', '/refresh', {}); },
        logout: function () { return call('POST', '/logout', {}); },
        verifyEmail: function (t) { return call('POST', '/verify-email', { token: String(t || '') }); },
        forgotPassword: function (email) { return call('POST', '/forgot-password', { email: String(email || '') }); },
        resetPassword: function (t, password) { return call('POST', '/reset-password', { token: String(t || ''), password: String(password || '') }); },
      };
    }

    // The Platform Owner's manufacturing console (M4): suppliers, every club's requests, quotations and order steps.
    if (base === MFG_BASE) {
      var q = function (v) { return encodeURIComponent(String(v)); };
      api = {
        listSuppliers: function () { return call('GET', '/suppliers'); },
        createSupplier: function (s) { return call('POST', '/suppliers', s); },
        openSupplier: function (supplierId) { return call('GET', '/suppliers/' + id(supplierId)); },
        saveSupplier: function (supplierId, s) { return call('PUT', '/suppliers/' + id(supplierId), s); },
        setSupplierStatus: function (supplierId, status, note) { return call('POST', '/suppliers/' + id(supplierId) + '/status', { status: status, note: note }); },
        listRequests: function (status) { return call('GET', '/requests' + (status ? '?status=' + q(status) : '')); },
        openRequest: function (requestId) { return call('GET', '/requests/' + id(requestId)); },
        step: function (requestId, step, note) {
          var path = { review: 'review', refuse: 'refuse', order: 'order', produce: 'production', ship: 'shipped', deliver: 'delivered' }[step];
          return path ? call('POST', '/requests/' + id(requestId) + '/' + path, { note: note || null }) : Promise.resolve({ ok: false, status: 0, code: 'BAD_STEP', data: null, message: '', errors: [] });
        },
        recordQuote: function (requestId, quote) { return call('POST', '/requests/' + id(requestId) + '/quotes', quote); },
        publishQuote: function (requestId, quoteId) { return call('POST', '/requests/' + id(requestId) + '/quotes/' + id(quoteId) + '/publish', {}); },
        withdrawQuote: function (requestId, quoteId, note) { return call('POST', '/requests/' + id(requestId) + '/quotes/' + id(quoteId) + '/withdraw', { note: note }); },
        discardDraft: function (requestId, quoteId) { return call('DELETE', '/requests/' + id(requestId) + '/quotes/' + id(quoteId)); },
        specDesign: function (requestId, projectId) { return call('GET', '/requests/' + id(requestId) + '/designs/' + id(projectId)); },
        // M7d: how each verified supplier fits the request, from what was recorded about it.
        requestFit: function (requestId) { return call('GET', '/requests/' + id(requestId) + '/fit'); },
        // P1: the production sheet, once the order is confirmed with its supplier; a closed request's names, erased.
        productionSheet: function (requestId) { return call('POST', '/requests/' + id(requestId) + '/production-sheet', {}); },
        eraseNames: function (requestId, note) { return call('POST', '/requests/' + id(requestId) + '/erase-names', { note: String(note || '') }); },
      };
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

  var creatorAuth = null;
  /** P3: the creator's sign-in client, made once. */
  function creator() { if (!creatorAuth) creatorAuth = client(CREATOR_AUTH, LINK_KEY + '_creator_auth').api; return creatorAuth; }
  /** Renew the creator's session with its refresh cookie: true when a new access cookie came back. */
  function renew() { return creator().refresh().then(function (r) { return !!r.ok; }); }
  /** P3: who is signed in to the Creator Studio, if anyone (the session renewed once when it has lapsed). */
  function creatorMe() { return client(CREATOR_BASE, LINK_KEY + '_creator_probe').api.me(); }
  var platform = client(BASE, LINK_KEY);
  /**
   * The client of the workspace the room is open in: { kind: 'PLATFORM' }, or { kind: 'CLUB', clubId } — the club the
   * session has open, which only names the record kept in this browser; the server serves the session's own club, never
   * one a request names. Anything else is refused (null), never guessed.
   */
  function forWorkspace(w) {
    if (!w || w.kind === 'PLATFORM') return platform;
    if (w.kind === 'CLUB' && typeof w.clubId === 'string' && CLUB_ID.test(w.clubId)) return client(CLUB_BASE, LINK_KEY + '_club_' + w.clubId);
    // P3: a creator's own workspace; the id only names the record kept in this browser, the server serves the session's.
    if (w.kind === 'PERSONAL' && typeof w.creatorId === 'string' && UUID.test(w.creatorId)) return client(CREATOR_BASE, LINK_KEY + '_creator_' + w.creatorId);
    return null;
  }
  var mfg = null;
  /** The Platform Owner's manufacturing console's client (M4), made once. */
  function manufacturing() { if (!mfg) mfg = client(MFG_BASE, LINK_KEY + '_manufacturing').api; return mfg; }
  return Object.freeze({ BASE: platform.BASE, LINK_KEY: platform.LINK_KEY, ORIGINS: ORIGINS, api: platform.api, fingerprint: fingerprint,
    readLink: platform.readLink, writeLink: platform.writeLink, clearLink: platform.clearLink, CLUB_BASE: CLUB_BASE, forWorkspace: forWorkspace,
    CREATOR_BASE: CREATOR_BASE, creator: creator, creatorMe: creatorMe,
    MFG_BASE: MFG_BASE, manufacturing: manufacturing });
}));
