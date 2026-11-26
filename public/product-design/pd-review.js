/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — a design's review (M7b), in the saved-designs
   panel of a club's studio.

   The club's managers and administrators comment on the saved design in the
   editor, on the whole garment or on one of its surfaces, and resolve what has
   been dealt with. A club administrator, and nobody else, approves the newest
   saved version or asks for changes to it, saying what to change. A decision
   belongs to one version: saving a new version leaves it unreviewed. Every
   rule is the server's; this view only offers what the server will accept and
   says why when it does not.

   The room hosts this view as the panel's third tab and hands it its builders,
   words and server client (shell); nothing here fetches, stores or styles by
   itself. What people wrote is shown as they wrote it and never translated.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignReview = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function L(text) { return text; }
  var DECISION = { APPROVED: L('Approved'), CHANGES_REQUESTED: L('Changes requested') };
  var INVALID = {
    required: L('Write something first.'),
    'bad-text': L('The text is longer than 1,000 characters or holds characters that cannot be kept.'),
    'unknown-revision': L('That version of the design is not on the server.'),
    'unknown-surface': L('That part of the garment is not on this design.'),
    'too-many-comments': L('This design has as many comments as it can keep.'),
  };
  var LIMIT = 1000;
  /** P4: what a collaborator may do with a shared design, and why a share was refused. */
  var ROLE = { VIEW: L('Can see'), COMMENT: L('Can comment') };
  var SHARE_REFUSED = {
    'bad-email': L('Enter a valid email address.'), 'no-creator': L('No creator account uses this address.'), self: L('This is your own address.'),
    exists: L('This design is already shared with this creator.'), 'bad-role': L('Choose what they may do.'),
  };

  function create(shell) {
    var h = shell.h, btn = shell.btn, icon = shell.icon, T = shell.T, tf = shell.tf, api = shell.api;
    var st = {
      state: 'idle', projectId: null, data: null, error: '', notice: '', seq: 0, busy: false, filter: 'open',
      draft: { surface: '', body: '' },
      ask: null,       // { note } while a club administrator writes what to change
      // P4: in a creator's workspace, who the saved design is shared with.
      sh: { state: 'idle', items: [], limit: 0, email: '', role: 'COMMENT', busy: false, note: '' },
    };
    function sharing() { return !!api.listShares && (!shell.canShare || shell.canShare()); }

    /** Who decides on a version: a club's administrator, or the creator on their own designs (P3). */
    function admin() { return shell.role() === 'CLUB_ADMIN' || shell.role() === 'CREATOR'; }
    function problem(r) {
      if (r.status === 0) return T('The server could not be reached.');
      if (r.code === 'REVIEW_INVALID' && INVALID[r.reason]) return T(INVALID[r.reason]);
      if (r.code === 'REVIEW_STALE') return tf('This design has a newer version (%d). The review has been reloaded.', r.data && r.data.headRevision || 0);
      if (r.code === 'DESIGN_FEATURE_NOT_ENABLED') return T('Design reviews are not included in your club’s plan.');
      if (r.status === 403) return T('Only a club administrator approves a design or asks for changes to it.');
      if (r.status === 404) return T('This design is no longer on the server.');
      return T('The server did not accept this.');
    }

    /** The review of the saved design in the editor; nothing to load when the editor's design is not on the server. */
    function load() {
      var link = shell.link(), seq = ++st.seq;
      if (!link) { st.state = 'none'; st.projectId = null; st.data = null; shell.render(); return; }
      if (st.projectId !== link.projectId) { st.data = null; st.draft = { surface: '', body: '' }; st.ask = null; }
      st.projectId = link.projectId; st.state = st.data ? 'refresh' : 'loading'; st.error = '';
      shell.render();
      api.readReview(link.projectId).then(function (r) {
        if (seq !== st.seq) return;
        if (r.ok && r.data && r.data.review) { st.data = r.data.review; st.state = 'ready'; }
        else { st.state = 'error'; st.error = problem(r); }
        shell.render();
      });
      if (sharing()) loadShares(link.projectId, seq);
    }
    function loadShares(projectId, seq) {
      st.sh.state = st.sh.state === 'ready' ? 'refresh' : 'loading';
      api.listShares(projectId).then(function (r) {
        if (seq !== st.seq) return;
        if (r.ok && r.data) { st.sh.items = r.data.shares; st.sh.limit = r.data.limit; st.sh.state = 'ready'; } else st.sh.state = 'error';
        shell.render();
      });
    }
    function share() {
      var e = st.sh.email.trim();
      if (st.sh.busy || !st.projectId) return;
      if (!e) { st.sh.note = T(SHARE_REFUSED['bad-email']); shell.render(); focus('share-email'); return; }
      st.sh.busy = true; st.sh.note = ''; shell.render();
      api.shareDesign(st.projectId, e, st.sh.role).then(function (r) {
        st.sh.busy = false;
        if (r.ok && r.data && r.data.share) { st.sh.items = st.sh.items.concat([r.data.share]); st.sh.email = ''; shell.say(T('Shared.')); }
        else st.sh.note = r.code === 'SHARE_REFUSED' && r.reason === 'limit' ? tf('A design is shared with at most %d creators.', st.sh.limit || 20)
          : r.code === 'SHARE_REFUSED' && SHARE_REFUSED[r.reason] ? T(SHARE_REFUSED[r.reason]) : r.status === 0 ? T('The server could not be reached.') : T('The server did not accept this.');
        shell.render();
        focus('share-email');
      });
    }
    function unshare(shareId) {
      if (st.sh.busy || !st.projectId) return;
      st.sh.busy = true; shell.render();
      api.revokeShare(st.projectId, shareId).then(function (r) {
        st.sh.busy = false;
        if (r.ok) { st.sh.items = st.sh.items.filter(function (x) { return x.id !== shareId; }); shell.say(T('Sharing stopped.')); }
        else st.sh.note = r.status === 0 ? T('The server could not be reached.') : T('The server did not accept this.');
        shell.render();
        focus('share-email');
      });
    }
    function after(r, done) {
      st.busy = false;
      if (r.ok) { if (done) done(); load(); return; }
      shell.say(tf('Not saved: %s', problem(r)));
      if (r.code === 'REVIEW_STALE') { st.ask = null; load(); return; }
      st.notice = problem(r);
      shell.render();
    }
    function comment() {
      var d = st.data, text = st.draft.body.trim();
      if (!d || st.busy) return;
      if (!text) { st.notice = T(INVALID.required); shell.render(); focus('body'); return; }
      st.busy = true; st.notice = ''; shell.render();
      api.commentOnDesign(st.projectId, { revision: d.headRevision, surface: st.draft.surface || null, body: text }).then(function (r) {
        after(r, function () { st.draft.body = ''; shell.say(T('Comment added.')); });
      });
    }
    function setResolved(id, resolved) {
      if (st.busy) return;
      st.busy = true; st.notice = ''; shell.render();
      (resolved ? api.resolveComment(st.projectId, id) : api.reopenComment(st.projectId, id)).then(function (r) {
        after(r, function () { shell.say(resolved ? T('Comment resolved.') : T('Comment reopened.')); });
      });
    }
    function decide(decision) {
      var d = st.data;
      if (!d || st.busy || !admin()) return;
      var note = decision === 'CHANGES_REQUESTED' ? (st.ask ? st.ask.note.trim() : '') : null;
      if (decision === 'CHANGES_REQUESTED' && !note) { st.notice = T('Say what should change.'); shell.render(); focus('note'); return; }
      st.busy = true; st.notice = ''; shell.render();
      api.decideOnDesign(st.projectId, { revision: d.headRevision, decision: decision, note: note }).then(function (r) {
        after(r, function () {
          st.ask = null;
          shell.say(decision === 'APPROVED' ? tf('Version %d approved.', d.headRevision) : tf('Changes requested to version %d.', d.headRevision));
        });
      });
    }
    function focus(key) {
      var n = shell.host().querySelector('[data-pd-rv="' + key + '"]');
      if (n) n.focus({ preventScroll: false });
    }

    // ── what the panel shows ─────────────────────────────────────────────
    function surfaceName(id) { return id ? shell.surfaceLabel(id) : T('Whole garment'); }
    function skeleton() {
      return h('ul', { class: 'pd-dock-list', 'aria-busy': 'true', 'aria-hidden': 'true' }, [0, 1, 2].map(function () {
        return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]);
      }));
    }
    function head(d) {
      var link = shell.link(), cur = d.current;
      var behind = link && (link.revision !== d.headRevision || shell.unsaved());
      return h('div', { class: 'pd-dock-current pd-rv-current', 'data-pd-rv-current': cur ? cur.decision : 'none' }, [
        h('div', { class: 'pd-dock-text' }, [
          h('span', { class: 'pd-dock-kicker', text: tf('Version %d', d.headRevision) }),
          h('div', { class: 'pd-rv-line' }, [shell.approvalChip(cur), cur ? h('span', { class: 'pd-note' }, [
            cur.by ? h('span', { 'data-user-content': '', text: cur.by }) : null, cur.by ? h('span', { text: ' · ' }) : null, h('span', { text: shell.date(cur.at) }),
          ]) : null]),
          behind ? h('span', { class: 'pd-note', text: tf('The review is of version %d as saved, not of the unsaved changes in the editor.', d.headRevision) }) : null,
        ]),
      ]);
    }
    /** P4: who sees the saved design, and what they may do; the owner adds and removes collaborators here. */
    function shareBlock() {
      var S = st.sh;
      var email = h('input', { class: 'pd-input', type: 'email', dir: 'ltr', autocomplete: 'off', 'data-pd-rv': 'share-email', 'data-pd-rv-key': 'share-email', 'aria-label': T('Creator’s email address'), placeholder: T('Creator’s email address') });
      email.value = S.email;
      var role = h('select', { class: 'pd-input pd-rv-role', 'data-pd-rv': 'share-role', 'aria-label': T('They may') },
        ['COMMENT', 'VIEW'].map(function (k) { return h('option', { value: k, text: T(ROLE[k]) }); }));
      role.value = S.role;
      var list = S.state === 'loading' ? skeleton() : !S.items.length
        ? h('p', { class: 'pd-empty', text: T('Not shared. Share it with another creator to show it, or to ask for their notes.') })
        : h('ul', { class: 'pd-dock-list pd-rv-shares', role: 'list' }, S.items.map(function (x) {
          var name = x.grantee.displayName || x.grantee.email || '';
          return h('li', { class: 'pd-dock-row', 'data-pd-rv-share': x.id }, [
            h('span', { class: 'pd-dock-main' }, [h('span', { class: 'pd-dock-name', 'data-user-content': '', dir: 'auto', text: name }),
              x.grantee.email ? h('span', { class: 'pd-dock-kicker', 'data-user-content': '', dir: 'ltr', text: x.grantee.email }) : null]),
            h('span', { class: 'pd-chip pd-chip--muted', 'data-role': x.role, text: T(ROLE[x.role]) }),
            btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'rv-unshare', 'data-pd-id': x.id, 'aria-disabled': S.busy ? 'true' : null },
              [h('span', { text: T('Stop sharing') }), h('span', { class: 'pd-sr', 'data-user-content': '', text: ' ' + name })]),
          ]);
        }));
      return h('section', { class: 'pd-rv-share', 'aria-labelledby': 'pd-rv-share-h' }, [
        h('h3', { class: 'pd-dock-h', id: 'pd-rv-share-h', text: T('Shared with') }),
        S.state === 'error' ? h('p', { class: 'pd-note pd-note--warn', text: T('Who this design is shared with could not be loaded.') }) : list,
        h('div', { class: 'pd-rv-share-add', role: 'group', 'aria-label': T('Share with a creator') }, [
          email, role,
          btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'rv-share', 'aria-disabled': S.busy ? 'true' : null }, [icon('people', 14), h('span', { text: T('Share') })]),
        ]),
        h('p', { class: 'pd-note', role: 'status', 'data-pd-rv-share-note': '', text: S.note || T('They need a Familista creator account with this address. You alone change the design, resolve notes and approve versions.') }),
      ]);
    }
    function decisionBlock(d) {
      if (!admin()) return h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: T('A club administrator approves a version or asks for changes to it. Comments help them decide.') })]);
      if (st.ask) {
        var note = h('textarea', { class: 'pd-input', rows: '3', maxlength: String(LIMIT), 'data-pd-rv': 'note', 'data-user-content': '', dir: 'auto', 'aria-label': T('What should change') });
        note.value = st.ask.note;
        return h('div', { class: 'pd-dock-alert pd-rv-ask', role: 'group', 'aria-label': T('Request changes') }, [
          h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-dock-kicker', text: T('What should change') }), note]),
          h('div', { class: 'pd-dock-btns' }, [
            btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'rv-ask-cancel' }, [h('span', { text: T('Cancel') })]),
            btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'rv-ask-send', 'aria-disabled': st.busy ? 'true' : null }, [h('span', { text: tf('Request changes to version %d', d.headRevision) })]),
          ]),
        ]);
      }
      var approved = d.current && d.current.decision === 'APPROVED';
      return h('div', { class: 'pd-dock-btns pd-rv-decide' }, [
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'rv-ask' }, [icon('pencil', 14), h('span', { text: T('Request changes') })]),
        approved ? null : btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'rv-approve', 'aria-disabled': st.busy ? 'true' : null }, [icon('check', 14), h('span', { text: tf('Approve version %d', d.headRevision) })]),
      ]);
    }
    function composer(d) {
      var sel = h('select', { class: 'pd-input pd-rv-surface', 'data-pd-rv': 'surface', 'aria-label': T('About') });
      sel.appendChild(h('option', { value: '', text: T('Whole garment') }));
      d.surfaces.forEach(function (s) { sel.appendChild(h('option', { value: s, text: shell.surfaceLabel(s) })); });
      sel.value = d.surfaces.indexOf(st.draft.surface) >= 0 ? st.draft.surface : '';
      var body = h('textarea', { class: 'pd-input', rows: '3', maxlength: String(LIMIT), 'data-pd-rv': 'body', 'data-user-content': '', dir: 'auto', 'aria-label': T('Comment') });
      body.value = st.draft.body;
      return h('div', { class: 'pd-rv-compose', role: 'group', 'aria-label': tf('Comment on version %d', d.headRevision) }, [
        h('span', { class: 'pd-dock-kicker', text: tf('Comment on version %d', d.headRevision) }),
        h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-sr', text: T('About') }), sel]),
        h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-sr', text: T('Comment') }), body]),
        h('div', { class: 'pd-dock-btns' }, [btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'rv-comment', 'aria-disabled': st.busy ? 'true' : null }, [h('span', { text: T('Add comment') })])]),
      ]);
    }
    function commentRow(c, d) {
      var older = c.revision !== d.headRevision;
      return h('li', { class: 'pd-rv-comment' + (c.resolvedAt ? ' is-resolved' : ''), 'data-pd-rv-comment': c.id }, [
        h('div', { class: 'pd-rv-meta' }, [
          h('span', { class: 'pd-chip pd-chip--muted', text: surfaceName(c.surface) }),
          h('span', { class: 'pd-note' + (older ? ' pd-rv-older' : ''), text: tf('Version %d', c.revision) }),
          c.by ? h('span', { class: 'pd-note', 'data-user-content': '', text: c.by }) : null,
          h('span', { class: 'pd-note', text: shell.date(c.createdAt) }),
        ]),
        h('p', { class: 'pd-req-note', 'data-user-content': '', dir: 'auto', text: c.body }),
        h('div', { class: 'pd-dock-btns' }, [c.resolvedAt
          ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'rv-reopen', 'data-pd-id': c.id }, [h('span', { text: T('Reopen') })])
          : btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'rv-resolve', 'data-pd-id': c.id }, [icon('check', 14), h('span', { text: T('Resolve') })])]),
      ]);
    }
    function comments(d) {
      var open = d.comments.filter(function (c) { return !c.resolvedAt; }), done = d.comments.length - open.length;
      var shown = st.filter === 'open' ? open : d.comments.filter(function (c) { return !!c.resolvedAt; });
      var out = [h('div', { class: 'pd-dock-bar-row' }, [
        h('h3', { class: 'pd-dock-h', text: T('Comments') }),
        h('div', { class: 'pd-tabs', role: 'group', 'aria-label': T('Show') }, [
          btn({ class: 'pd-tab', 'data-pd-act': 'rv-filter-open', 'aria-pressed': st.filter === 'open' ? 'true' : 'false', text: tf('Open (%d)', open.length) }),
          btn({ class: 'pd-tab', 'data-pd-act': 'rv-filter-resolved', 'aria-pressed': st.filter === 'resolved' ? 'true' : 'false', text: tf('Resolved (%d)', done) }),
        ]),
      ])];
      if (!shown.length) out.push(h('p', { class: 'pd-empty', text: st.filter === 'open'
        ? (d.comments.length ? T('Every comment is resolved.') : T('No comments yet. Comment on the whole garment or on one part of it.'))
        : T('No resolved comments.') }));
      else out.push(h('ul', { class: 'pd-dock-list pd-rv-list', role: 'list' }, shown.map(function (c) { return commentRow(c, d); })));
      return out;
    }
    function history(d) {
      if (!d.decisions.length) return [];
      return [h('h3', { class: 'pd-dock-h', text: T('Decisions') }), h('ol', { class: 'pd-req-history', role: 'list' }, d.decisions.map(function (x) {
        return h('li', { 'data-pd-rv-decision': x.decision }, [h('span', { class: 'pd-req-dot', 'aria-hidden': 'true' }), h('div', { class: 'pd-dock-text' }, [
          h('span', { class: 'pd-req-event', text: tf('Version %d', x.revision) + ' · ' + T(DECISION[x.decision]) }),
          h('span', { class: 'pd-note' }, [x.by ? h('span', { 'data-user-content': '', text: x.by }) : null, x.by ? h('span', { text: ' · ' }) : null, h('span', { text: shell.date(x.createdAt) })]),
          x.note ? h('p', { class: 'pd-req-note', 'data-user-content': '', dir: 'auto', text: x.note }) : null,
        ])]);
      }))];
    }
    function body() {
      if (st.state === 'none' || !shell.link()) {
        return [h('div', { class: 'pd-dock-state' }, [
          h('p', { class: 'pd-empty', text: T('Save the design to review it. A review belongs to a saved version, so everyone comments on the same design.') }),
          btn({ class: 'pd-btn pd-btn--ghost pd-btn--accent', 'data-pd-act': 'save' }, [icon('save', 14), h('span', { text: T('Save design') })]),
        ])];
      }
      if (st.state === 'error' && !st.data) {
        return [h('div', { class: 'pd-dock-state', role: 'alert' }, [h('p', { class: 'pd-empty', text: st.error }), btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'rv-retry' }, [h('span', { text: T('Try again') })])])];
      }
      if (!st.data) return [skeleton()];
      var d = st.data;
      return [head(d), st.notice ? h('p', { class: 'pd-note pd-note--warn', role: 'alert' }, [icon('alert', 14), h('span', { text: st.notice })]) : null,
        sharing() ? shareBlock() : null, decisionBlock(d), composer(d)].concat(comments(d), history(d));
    }

    // ── the room's events, handed on ──────────────────────────────────────
    function onAction(act, t) {
      switch (act) {
        case 'rv-retry': load(); return true;
        case 'rv-comment': comment(); return true;
        case 'rv-resolve': setResolved(t.getAttribute('data-pd-id'), true); return true;
        case 'rv-reopen': setResolved(t.getAttribute('data-pd-id'), false); return true;
        case 'rv-approve': decide('APPROVED'); return true;
        case 'rv-ask': st.ask = { note: '' }; st.notice = ''; shell.render(); focus('note'); return true;
        case 'rv-ask-cancel': st.ask = null; st.notice = ''; shell.render(); return true;
        case 'rv-ask-send': decide('CHANGES_REQUESTED'); return true;
        case 'rv-filter-open': case 'rv-filter-resolved': st.filter = act === 'rv-filter-open' ? 'open' : 'resolved'; shell.render(); return true;
        case 'rv-share': share(); return true;
        case 'rv-unshare': unshare(t.getAttribute('data-pd-id')); return true;
        default: return false;
      }
    }
    /** Typing changes what is kept, never the panel: nothing is redrawn, so the caret stays where it is. */
    function onInput(ev) {
      var k = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-pd-rv');
      if (!k) return false;
      if (k === 'body') st.draft.body = ev.target.value;
      else if (k === 'surface') st.draft.surface = ev.target.value;
      else if (k === 'note' && st.ask) st.ask.note = ev.target.value;
      else if (k === 'share-email') st.sh.email = ev.target.value;
      else if (k === 'share-role') st.sh.role = ev.target.value === 'VIEW' ? 'VIEW' : 'COMMENT';
      return true;
    }
    function metrics() {
      var d = st.data;
      return { state: st.state, busy: st.busy, head: d ? d.headRevision : null, current: d && d.current ? d.current.decision : null,
        comments: d ? d.comments.length : null, open: d ? d.comments.filter(function (c) { return !c.resolvedAt; }).length : null, filter: st.filter,
        shares: sharing() ? { state: st.sh.state, count: st.sh.items.length, busy: st.sh.busy, note: st.sh.note } : null };
    }
    /** The saved design changed (another opened, a version saved): what was shown belongs to another version. */
    function invalidate() { st.seq++; st.data = null; st.state = 'idle'; st.ask = null; st.notice = ''; st.sh = { state: 'idle', items: [], limit: 0, email: '', role: 'COMMENT', busy: false, note: '' }; }

    return { load: load, body: body, onAction: onAction, onInput: onInput, metrics: metrics, invalidate: invalidate };
  }

  return { create: create, DECISION: DECISION };
});
