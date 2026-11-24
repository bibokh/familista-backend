/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — the Team panel (M3): a club's team rosters, in the
   club's own workspace.

   A floating panel (position: fixed, opacity and transform only), so opening it
   moves nothing beneath it; its body scrolls inside itself. It lists the club's
   rosters and edits one: the name to print, the number, a size per garment form
   and the sets, one row per entry. A spreadsheet is read in the browser by the
   roster core (pd-roster.js) and shown before anything changes; the server
   validates what is saved with the same core. Choosing a row previews that name
   and number on the garment, in 2D, 2.5D and 3D: the design itself never keeps
   them.

   The room hands this module its own builders, words and server client (ctx);
   nothing here fetches, stores or styles by itself.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignTeam = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Marks a word for the room's catalogue; T() translates it where it is shown. */
  function L(text) { return text; }

  var COLUMN = { name: L('Name'), number: L('Number'), top: L('Top'), shorts: L('Shorts'), socks: L('Socks'), qty: L('Sets') };
  var PROBLEM = {
    'bad-name': L('Name: letters of any alphabet, spaces, apostrophes, full stops and hyphens, starting with a letter'),
    'bad-number': L('Number: a whole number from 0 to 99, or empty'),
    'bad-qty': L('Sets: a whole number from 1 to 10'),
    'empty-entry': L('The row is empty'),
  };
  var FILE_PROBLEM = {
    'no-header': L('The file is empty: it needs a header row naming its columns.'),
    'missing-column': L('The file has no “name” or “number” column. Use the column names of the blank template.'),
    'unterminated-quote': L('A quotation mark is never closed, so the file cannot be read.'),
    'too-large': L('The file is larger than 64 KB.'),
    'not-text': L('The file could not be read as text.'),
  };
  var FIT_WARN = 0.75;

  function create(ctx) {
    var R = ctx.roster, api = ctx.api, h = ctx.h, btn = ctx.btn, icon = ctx.icon, T = ctx.T, tf = ctx.tf;
    var st = {
      open: false, view: 'list', tab: 'rosters', trigger: null, seq: 0, busy: false, note: '', delimiter: ',',
      list: { state: 'idle', rosters: [], archived: false, error: '' },
      cur: null,       // { id, version, name, rows, dirty, state }
      pending: null,   // { kind: 'csv' | 'squad', label, result }
      confirm: null,   // { text, go, run }
      conflict: null,  // { version }
      preview: null,   // index into cur.rows
    };
    var el = h('section', { class: 'pd-team', id: 'pd-team', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pd-team-title', 'data-open': 'false' });
    var file = h('input', { class: 'pd-sr', type: 'file', accept: '.csv,text/csv', tabindex: '-1', 'aria-hidden': 'true', 'data-pd-team-file': '' });
    // M3b: the club's collections, the panel's second tab (pd-collections.js), when the room loaded it.
    var CO = ctx.collections ? ctx.collections.create({
      h: h, btn: btn, icon: icon, T: T, tf: tf, api: api, roster: R, el: el, date: ctx.date,
      render: function () { render(); },
      note: function (text) { st.note = text; var n = el.querySelector('[data-pd-team-status]'); if (n) n.textContent = text; },
      show: function (view) { st.view = view; st.note = ''; render(); },
      confirm: function (text, go, run) { st.confirm = { text: text, go: go, run: run }; render(); },
      download: function (text, name) { download(text, name); },
      delimiter: function () { return st.delimiter; },
      currentProject: ctx.currentProject, openDesign: ctx.openDesign, productLabel: ctx.productLabel,
      // M4: a request for quotation sent from a collection's order sheet opens in the Requests tab.
      openRequest: function (id) { st.tab = 'requests'; if (RQ) RQ.open(id); },
    }) : null;
    // M4: the club's requests for quotation, the panel's third tab (pd-requests.js), when the room loaded it.
    var RQ = ctx.requests ? ctx.requests.create({
      h: h, btn: btn, icon: icon, T: T, tf: tf, api: api, date: ctx.date, lang: ctx.lang,
      render: function () { render(); },
      note: function (text) { st.note = text; var n = el.querySelector('[data-pd-team-status]'); if (n) n.textContent = text; },
      show: function (view) { st.view = view; st.note = ''; render(); },
      confirm: function (text, go, run) { st.confirm = { text: text, go: go, run: run }; render(); },
    }) : null;

    // ── rows: what the inputs hold, and what they amount to ────────────────
    function toRow(e) {
      return { name: e.name, number: e.number === null ? '' : String(e.number), top: e.top || '', shorts: e.shorts || '', socks: e.socks || '', qty: String(e.qty) };
    }
    function blank(r) { return !String(r.name).trim() && !String(r.number).trim() && !r.top && !r.shorts && !r.socks; }
    /** Each row read by the core: an entry, or its problems. Blank rows are left out, as a spreadsheet leaves them. */
    function readRows(rows) {
      var entries = [], problems = [], index = [];
      rows.forEach(function (r, i) {
        if (blank(r)) return;
        var out = R.readEntry(r, false);
        if (out.problems) out.problems.forEach(function (p) { problems.push({ row: i, column: p.column, code: p.code }); });
        else { entries.push(out.entry); index.push(i); }
      });
      return { entries: entries, problems: problems, index: index };
    }
    function problemText(p) {
      if (p.code === 'name-too-long') return tf('Name: at most %d characters', R.LIMITS.name);
      if (p.code === 'bad-size') return tf('%s: choose a size from the list', T(COLUMN[p.column] || ''));
      return T(PROBLEM[p.code] || L('The row cannot be kept as it is'));
    }
    function fileProblemText(p) {
      if (p.code === 'duplicate-column') return tf('The file names the column “%s” twice.', p.column);
      if (p.code === 'too-many-rows') return tf('The file has more than %d rows.', R.LIMITS.entries);
      if (FILE_PROBLEM[p.code]) return T(FILE_PROBLEM[p.code]);
      return tf('Row %d · %s', p.row, problemText(p));
    }
    function previewEntry() {
      var c = st.cur;
      if (!c || st.preview === null || !c.rows[st.preview]) return null;
      var out = R.readEntry(c.rows[st.preview], false);
      return out.entry ? { name: out.entry.name, number: out.entry.number } : null;
    }
    function pushPreview() { ctx.onPreview(previewEntry()); }
    function setPreview(i) { st.preview = i; pushPreview(); render(); }

    // ── opening, closing and the list ───────────────────────────────────────
    function open(trigger) {
      st.open = true; st.trigger = trigger || null;
      el.setAttribute('data-open', 'true');
      if (st.view === 'list' && st.tab === 'rosters' && (st.list.state === 'idle' || st.list.state === 'error')) loadList();
      render();
      ctx.onToggle(true);
      var first = el.querySelector('[data-pd-team-focus]') || el.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    }
    function close() {
      if (!st.open) return;
      st.open = false;
      el.setAttribute('data-open', 'false');
      ctx.onToggle(false);
      var back = st.trigger && ctx.host.contains(st.trigger) ? st.trigger : null;
      st.trigger = null;
      if (back) back.focus({ preventScroll: true });
    }
    function loadList() {
      var seq = ++st.seq, L0 = st.list;
      L0.state = 'loading'; render();
      api.listRosters(L0.archived ? 'archived' : 'active').then(function (r) {
        if (seq !== st.seq) return;
        if (r.ok && r.data && Array.isArray(r.data.rosters)) { L0.rosters = r.data.rosters; L0.limit = r.data.limit; L0.state = 'ready'; }
        else { L0.state = 'error'; L0.error = r.status === 0 ? T('The server could not be reached.') : T('The rosters could not be loaded.'); }
        render();
      });
    }
    function guard(text, run) {
      if ((st.view === 'roster' && st.cur && st.cur.dirty) || (st.view === 'collection' && CO && CO.dirty())) { st.confirm = { text: text, run: run }; render(); return; }
      run();
    }
    function toList() {
      var from = st.view;
      st.view = 'list'; st.cur = null; st.pending = null; st.conflict = null; st.confirm = null; st.note = '';
      if (st.preview !== null) { st.preview = null; pushPreview(); }
      if (from === 'collection' && CO) { CO.leave(); CO.loadList(); } else if (from === 'request' && RQ) { RQ.leave(); RQ.loadList(); } else loadList();
    }
    function startNew() {
      st.cur = { id: null, version: 0, name: T('Team roster'), rows: [toRow(R.blankEntry())], dirty: true, state: 'ready' };
      st.view = 'roster'; st.pending = null; st.conflict = null; st.note = '';
      if (st.preview !== null) { st.preview = null; pushPreview(); }
      render(); focusField(0, 'name');
    }
    function openRoster(id) {
      var seq = ++st.seq;
      st.view = 'roster'; st.cur = { id: id, version: 0, name: '', rows: [], dirty: false, state: 'loading' }; st.pending = null; st.conflict = null; st.note = '';
      if (st.preview !== null) { st.preview = null; pushPreview(); }
      render();
      api.openRoster(id).then(function (r) {
        if (seq !== st.seq || !st.cur) return;
        if (!r.ok || !r.data || !r.data.roster) { st.cur.state = 'error'; render(); return; }
        var ro = r.data.roster;
        st.cur = { id: ro.id, version: ro.version, name: ro.name, rows: ro.entries.map(toRow), dirty: false, state: 'ready', archived: !!ro.archivedAt };
        render();
      });
    }
    function setArchived(id, archived) {
      if (st.busy) return;
      st.busy = true;
      (archived ? api.archiveRoster(id) : api.unarchiveRoster(id)).then(function (r) {
        st.busy = false;
        st.note = r.ok ? (archived ? T('Roster archived.') : T('Roster returned to the list.'))
          : r.code === 'ROSTER_LIMIT' ? tf('A club keeps at most %d rosters: archive one first.', st.list.limit || 100) : T('The roster could not be changed.');
        loadList();
      });
    }
    function erase(id) {
      if (st.busy) return;
      st.busy = true;
      api.deleteRoster(id).then(function (r) {
        st.busy = false; st.confirm = null;
        st.note = r.ok ? T('Roster deleted for good.') : T('The roster could not be deleted.');
        loadList();
      });
    }

    // ── saving ──────────────────────────────────────────────────────────────
    function save(overVersion) {
      var c = st.cur;
      if (!c || st.busy || c.state !== 'ready') return;
      var read = readRows(c.rows);
      if (read.problems.length) { st.note = T('Some rows cannot be kept yet: fix the ones marked, then save.'); render(); focusField(read.problems[0].row, read.problems[0].column || 'name'); return; }
      var name = String(c.name).replace(/\s+/g, ' ').trim();
      if (!name) { st.note = T('Give the roster a name before saving it.'); render(); var n = el.querySelector('[data-pd-team-rname]'); if (n) n.focus(); return; }
      st.busy = true; st.note = T('Saving…'); render();
      var call = c.id ? api.saveRoster(c.id, overVersion || c.version, name, read.entries) : api.createRoster(name, read.entries);
      call.then(function (r) {
        st.busy = false;
        if (st.cur !== c) return;
        if (r.ok && r.data && r.data.roster) {
          var ro = r.data.roster;
          c.id = ro.id; c.version = ro.version; c.name = ro.name; c.rows = ro.entries.map(toRow); c.dirty = false; st.conflict = null;
          if (st.preview !== null && st.preview >= c.rows.length) st.preview = null;
          pushPreview();
          st.note = tf('Saved. Entries: %d · sets: %d.', ro.entries.length, R.summary(ro.entries).sets);
        } else if (r.code === 'ROSTER_CONFLICT') {
          st.conflict = { version: r.data && r.data.version }; st.note = '';
        } else if (r.code === 'ROSTER_INVALID') {
          st.note = T('The server refused the roster as it is. Check the rows marked and try again.');
        } else if (r.code === 'ROSTER_LIMIT') {
          st.note = tf('A club keeps at most %d rosters: archive one first.', 100);
        } else if (r.code === 'ROSTER_ARCHIVED') {
          st.note = T('This roster is archived: return it to the list before saving it.');
        } else st.note = r.status === 0 ? T('Not saved: the server could not be reached.') : T('The roster could not be saved.');
        render();
      });
    }

    // ── files and the squad ─────────────────────────────────────────────────
    function download(text, name) {
      var url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      var a = h('a', { href: url, download: name });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      ctx.say(tf('Exported %s.', name));
    }
    function exportCsv() {
      var c = st.cur;
      if (!c) return;
      var read = readRows(c.rows);
      if (read.problems.length) { st.note = T('Some rows cannot be kept yet: fix the ones marked, then export.'); render(); return; }
      download(R.toCsv(read.entries, { delimiter: st.delimiter }), R.csvFileName(c.name));
    }
    function readFile(f) {
      if (!f) return;
      file.value = '';
      if (f.size > R.LIMITS.csvBytes) { st.pending = { kind: 'csv', label: f.name, result: { entries: [], problems: [{ row: 0, code: 'too-large' }], ignored: [] } }; render(); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(fr.result)); } catch (_) { text = null; }
        if (text === null) { st.pending = { kind: 'csv', label: f.name, result: { entries: [], problems: [], ignored: [], encoding: true } }; render(); return; }
        st.pending = { kind: 'csv', label: f.name, result: R.parseCsv(text) };
        render();
      };
      fr.onerror = function () { st.pending = { kind: 'csv', label: f.name, result: { entries: [], problems: [{ row: 0, code: 'not-text' }], ignored: [] } }; render(); };
      fr.readAsArrayBuffer(f);
    }
    function fromSquad() {
      if (st.busy) return;
      st.busy = true; st.note = T('Reading the squad…'); render();
      api.squadNames().then(function (r) {
        st.busy = false; st.note = '';
        if (!r.ok || !r.data || !Array.isArray(r.data.players)) { st.note = T('The squad could not be read.'); render(); return; }
        var entries = [], skipped = [];
        r.data.players.forEach(function (p) {
          var out = R.readEntry({ name: p.name, number: p.number === null ? '' : String(p.number) }, true);
          if (out.entry) entries.push(out.entry); else skipped.push({ name: p.name, code: out.problems[0].code, column: out.problems[0].column });
        });
        st.pending = { kind: 'squad', label: T('the squad'), result: { entries: entries, problems: [], ignored: [], skipped: skipped } };
        render();
      });
    }
    function applyPending(mode) {
      var c = st.cur, p = st.pending;
      if (!c || !p || !p.result.entries.length) return;
      var kept = c.rows.filter(function (r) { return !blank(r); });
      if (mode === 'append' && kept.length + p.result.entries.length > R.LIMITS.entries) return;
      c.rows = (mode === 'append' ? kept : []).concat(p.result.entries.map(toRow));
      c.dirty = true; st.pending = null;
      if (st.preview !== null) { st.preview = null; pushPreview(); }
      st.note = mode === 'append' ? tf('Entries added: %d. Save the roster to keep them.', p.result.entries.length)
        : tf('Entries in the roster now: %d. Save it to keep them.', p.result.entries.length);
      render();
    }

    // ── drawing ─────────────────────────────────────────────────────────────
    function focusField(row, col) {
      var f = el.querySelector('[data-pd-team-row="' + row + '"][data-pd-team-col="' + col + '"]');
      if (f) f.focus();
    }
    function render() {
      var keep = el.querySelector('.pd-team-body'), scroll = keep ? keep.scrollTop : 0;
      var active = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
      var focusKey = active ? (active.getAttribute('data-pd-team-row') !== null ? 'r' + active.getAttribute('data-pd-team-row') + ':' + active.getAttribute('data-pd-team-col') : active.getAttribute('data-pd-team-key')) : null;
      while (el.firstChild) el.removeChild(el.firstChild);
      var roster = st.view === 'roster' && st.cur, collection = st.view === 'collection' && CO, requestView = st.view === 'request' && RQ;
      var head = h('div', { class: 'pd-dock-head pd-team-head' }, [
        roster || collection || requestView ? btn({ class: 'pd-btn pd-btn--ghost pd-team-back', 'data-pd-act': 'team-back', 'data-pd-team-key': 'back', 'data-pd-team-focus': '' },
          [ctx.dirArrow('←'), h('span', { text: requestView ? T('Requests') : collection ? T('Collections') : T('Rosters') })]) : null,
        h('h2', { class: 'pd-h2', id: 'pd-team-title' }, [icon('people', 16), h('span', { text: requestView ? T('Request for quotation') : collection ? T('Collection') : roster ? T('Team roster') : T('Team') })]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'team-close', 'data-pd-team-key': 'close', 'aria-label': T('Close') }, [icon('close')]),
      ]);
      var body = h('div', { class: 'pd-dock-body pd-team-body', tabindex: '0' }, [confirmBlock(), conflictBlock()]
        .concat(roster ? rosterBody() : collection ? CO.editorBody() : requestView ? RQ.detailBody()
          : [tabsBlock()].concat(st.tab === 'collections' && CO ? CO.listBody() : st.tab === 'requests' && RQ ? RQ.listBody() : listBody())));
      var status = h('p', { class: 'pd-note pd-team-status', role: 'status', 'aria-live': 'polite', 'data-pd-team-status': '', text: st.note });
      el.appendChild(head); el.appendChild(body); el.appendChild(status); el.appendChild(file);
      body.scrollTop = scroll;
      if (focusKey) {
        var back = focusKey.charAt(0) === 'r' ? el.querySelector('[data-pd-team-row="' + focusKey.slice(1).split(':')[0] + '"][data-pd-team-col="' + focusKey.split(':')[1] + '"]')
          : el.querySelector('[data-pd-team-key="' + focusKey + '"]');
        if (back) back.focus({ preventScroll: true });
      }
    }
    function confirmBlock() {
      if (!st.confirm) return null;
      return h('div', { class: 'pd-dock-alert', role: 'alert' }, [
        h('p', { class: 'pd-note', text: st.confirm.text }),
        h('div', { class: 'pd-dock-btns' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-confirm-cancel', 'data-pd-team-key': 'confirm-cancel' }, [h('span', { text: T('Keep editing') })]),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'team-confirm-go', 'data-pd-team-key': 'confirm-go' }, [h('span', { text: st.confirm.go || T('Discard changes') })]),
        ]),
      ]);
    }
    function conflictBlock() {
      if (!st.conflict) return null;
      return h('div', { class: 'pd-dock-alert', role: 'alert' }, [
        h('p', { class: 'pd-note', text: T('Someone saved this roster after you opened it. Open their version, or save yours over it.') }),
        h('div', { class: 'pd-dock-btns' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-conflict-open' }, [h('span', { text: T('Open their version') })]),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'team-conflict-keep' }, [h('span', { text: T('Save mine over it') })]),
        ]),
      ]);
    }
    /** The panel's two lists: the club's rosters, and its collections (M3b). */
    function tabsBlock() {
      if (!CO) return null;
      var tabs = [['rosters', L('Rosters')], ['collections', L('Collections')]].concat(RQ ? [['requests', L('Requests')]] : []);
      return h('div', { class: 'pd-tabs pd-team-tabs', role: 'tablist', 'aria-label': T('Team') }, tabs.map(function (t) {
        return btn({ class: 'pd-tab', role: 'tab', 'data-pd-act': 'team-tab-' + t[0], 'data-pd-team-key': 'tab-' + t[0], 'aria-selected': st.tab === t[0] ? 'true' : 'false', tabindex: st.tab === t[0] ? '0' : '-1', text: T(t[1]) });
      }));
    }
    function listBody() {
      var L0 = st.list, out = [];
      var filters = h('div', { class: 'pd-tabs', role: 'group', 'aria-label': T('Rosters') }, [
        btn({ class: 'pd-tab', 'data-pd-act': 'team-filter-active', 'data-pd-team-key': 'f-active', 'aria-pressed': L0.archived ? 'false' : 'true', text: T('Active') }),
        btn({ class: 'pd-tab', 'data-pd-act': 'team-filter-archived', 'data-pd-team-key': 'f-archived', 'aria-pressed': L0.archived ? 'true' : 'false', text: T('Archived') }),
      ]);
      out.push(h('div', { class: 'pd-dock-bar-row' }, [filters,
        L0.archived ? null : btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'team-new', 'data-pd-team-key': 'new', 'data-pd-team-focus': '' }, [icon('plus', 14), h('span', { text: T('New roster') })])]));
      if (L0.state === 'loading' || L0.state === 'idle') {
        out.push(h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2].map(function () {
          return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]);
        })));
      } else if (L0.state === 'error') {
        out.push(h('div', { class: 'pd-dock-alert', role: 'alert' }, [h('p', { class: 'pd-note', text: L0.error }),
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-retry' }, [h('span', { text: T('Try again') })])]));
      } else if (!L0.rosters.length) {
        out.push(h('p', { class: 'pd-empty', text: L0.archived ? T('No archived rosters.')
          : T('No team rosters yet. A roster holds the names, numbers and sizes a kit is made for: start one, import a spreadsheet or begin from the squad.') }));
      } else {
        var list = h('ul', { class: 'pd-dock-list', role: 'list' });
        L0.rosters.forEach(function (ro) {
          list.appendChild(h('li', { class: 'pd-dock-row' }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-dock-name', 'data-user-content': '', text: ro.name }),
              h('span', { class: 'pd-dock-kicker', text: tf('Entries: %d · saved %s', ro.entryCount, ctx.date(ro.updatedAt)) }),
            ]),
            h('div', { class: 'pd-dock-btns' }, L0.archived ? [
              btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-unarchive', 'data-pd-id': ro.id, 'aria-label': tf('Return %s to the list', ro.name) }, [h('span', { text: T('Return') })]),
              btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-delete', 'data-pd-id': ro.id, 'data-pd-name': ro.name, 'aria-label': tf('Delete %s for good', ro.name) }, [icon('trash', 14), h('span', { text: T('Delete') })]),
            ] : [
              btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'team-open', 'data-pd-id': ro.id, 'aria-label': tf('Open %s', ro.name) }, [h('span', { text: T('Open') })]),
              btn({ class: 'pd-icbtn', 'data-pd-act': 'team-archive', 'data-pd-id': ro.id, 'aria-label': tf('Archive %s', ro.name), title: tf('Archive %s', ro.name) }, [icon('trash', 14)]),
            ]),
          ]));
        });
        out.push(list);
      }
      out.push(h('p', { class: 'pd-note', text: T('Rosters hold names of people: only this club’s administrators and managers see them, and a design never keeps them.') }));
      return out;
    }
    function sizeSelect(form, value, i) {
      var sel = h('select', { class: 'pd-input pd-team-in', 'data-pd-team-row': String(i), 'data-pd-team-col': form, 'aria-label': tf('%s size, row %d', T(COLUMN[form]), i + 1) });
      sel.appendChild(h('option', { value: '', text: '—' }));
      if (form === 'socks') R.SIZES.socks.forEach(function (s) { sel.appendChild(h('option', { value: s, text: s })); });
      else {
        var youth = h('optgroup', { label: T('Youth, by height (cm)') }), adult = h('optgroup', { label: T('Adult') });
        R.SIZES[form].forEach(function (s) { (/^\d/.test(s) ? youth : adult).appendChild(h('option', { value: s, text: s })); });
        sel.appendChild(youth); sel.appendChild(adult);
      }
      sel.value = value || '';
      return sel;
    }
    function rosterBody() {
      var c = st.cur, out = [];
      if (c.state === 'loading') return [h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2, 3].map(function () { return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' })]); }))];
      if (c.state === 'error') return [h('div', { class: 'pd-dock-alert', role: 'alert' }, [h('p', { class: 'pd-note', text: T('The roster could not be opened.') }),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-back' }, [h('span', { text: T('Back to the rosters') })])])];
      var read = readRows(c.rows), bad = {};
      read.problems.forEach(function (p) { bad[p.row + ':' + (p.column || 'name')] = p; });
      // The name, and what can be done to the roster as a whole.
      var nameIn = h('input', { class: 'pd-input', type: 'text', maxlength: String(R.LIMITS.rosterName), 'data-pd-team-rname': '', 'data-pd-team-key': 'rname', 'data-user-content': '', dir: 'auto', 'aria-label': T('Roster name') });
      nameIn.value = c.name;
      out.push(h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-dock-kicker', text: T('Roster name') }), nameIn]));
      var delim = h('select', { class: 'pd-input pd-team-delim', 'data-pd-team-delim': '', 'data-pd-team-key': 'delim', 'aria-label': T('Separator for the exported file') }, [
        h('option', { value: ',', text: T('Comma') }), h('option', { value: ';', text: T('Semicolon (spreadsheets in many European languages)') }),
      ]);
      delim.value = st.delimiter;
      out.push(h('div', { class: 'pd-team-tools', role: 'group', 'aria-label': T('Roster') }, [
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-add-row', 'data-pd-team-key': 'add' }, [icon('plus', 14), h('span', { text: T('Add a row') })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-import', 'data-pd-team-key': 'import' }, [icon('import', 14), h('span', { text: T('Import a spreadsheet') })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-squad', 'data-pd-team-key': 'squad', 'aria-disabled': st.busy ? 'true' : null, 'data-pd-why': st.busy ? T('Reading the squad…') : null }, [icon('people', 14), h('span', { text: T('Start from the squad') })]),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-export', 'data-pd-team-key': 'export' }, [icon('export', 14), h('span', { text: T('Export') })]),
        delim,
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-template', 'data-pd-team-key': 'template' }, [h('span', { text: T('Blank template') })]),
      ]));
      if (st.pending) out.push(pendingBlock(c));
      // The rows.
      var table = h('table', { class: 'pd-team-table' });
      var hr = h('tr', null, [h('th', { scope: 'col', class: 'pd-team-n', text: '#' })]);
      ['name', 'number', 'top', 'shorts', 'socks', 'qty'].forEach(function (k) { hr.appendChild(h('th', { scope: 'col', text: T(COLUMN[k]) })); });
      hr.appendChild(h('th', { scope: 'col' }, [h('span', { class: 'pd-sr', text: T('Actions') })]));
      table.appendChild(h('thead', null, [hr]));
      var tb = h('tbody');
      c.rows.forEach(function (r, i) {
        function cellIn(col, attrs) {
          var p = bad[i + ':' + col];
          var a = { class: 'pd-input pd-team-in', type: 'text', 'data-pd-team-row': String(i), 'data-pd-team-col': col, 'aria-invalid': p ? 'true' : null, title: p ? problemText(p) : null };
          for (var k in attrs) a[k] = attrs[k];
          var input = h('input', a);
          input.value = r[col];
          return h('td', null, [input]);
        }
        var previewing = st.preview === i;
        var tr = h('tr', { class: previewing ? 'is-preview' : null, 'data-pd-team-tr': String(i) }, [
          h('th', { scope: 'row', class: 'pd-team-n', text: String(i + 1) }),
          cellIn('name', { maxlength: String(R.LIMITS.name), dir: 'auto', 'data-user-content': '', 'aria-label': tf('Name, row %d', i + 1) }),
          cellIn('number', { inputmode: 'numeric', maxlength: '2', class: 'pd-input pd-team-in pd-team-num', 'aria-label': tf('Number, row %d', i + 1) }),
        ]);
        ['top', 'shorts', 'socks'].forEach(function (f) {
          var sel = sizeSelect(f, r[f], i), p = bad[i + ':' + f];
          if (p) { sel.setAttribute('aria-invalid', 'true'); sel.setAttribute('title', problemText(p)); }
          tr.appendChild(h('td', null, [sel]));
        });
        tr.appendChild(cellIn('qty', { inputmode: 'numeric', maxlength: '2', class: 'pd-input pd-team-in pd-team-num', 'aria-label': tf('Sets, row %d', i + 1) }));
        tr.appendChild(h('td', { class: 'pd-team-acts' }, [
          btn({ class: 'pd-icbtn', 'data-pd-act': 'team-preview', 'data-pd-row': String(i), 'data-pd-team-key': 'pv' + i, 'aria-pressed': previewing ? 'true' : 'false', 'aria-label': tf('Preview row %d on the garment', i + 1), title: T('Preview on the garment') }, [icon('eye', 14)]),
          btn({ class: 'pd-icbtn', 'data-pd-act': 'team-remove-row', 'data-pd-row': String(i), 'data-pd-team-key': 'rm' + i, 'aria-label': tf('Remove row %d', i + 1), title: T('Remove the row') }, [icon('trash', 14)]),
        ]));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      out.push(h('div', { class: 'pd-team-scroll', role: 'region', 'aria-label': T('Entries'), tabindex: '0' }, [table]));
      if (!c.rows.length) out.push(h('p', { class: 'pd-empty', text: T('No entries yet. Add a row, import a spreadsheet or start from the squad.') }));
      out.push(checksBlock(read));
      out.push(summaryBlock(read.entries));
      out.push(h('div', { class: 'pd-dock-btns pd-team-save' }, [
        h('span', { class: 'pd-dock-kicker', 'data-pd-team-dirty': '', text: c.dirty ? T('Unsaved changes') : (c.id ? T('Saved') : '') }),
        btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'team-save', 'data-pd-team-key': 'save', 'aria-disabled': st.busy ? 'true' : null, 'data-pd-why': st.busy ? T('Saving…') : null, 'aria-keyshortcuts': 'Control+S' }, [icon('save', 14), h('span', { text: T('Save roster') })]),
      ]));
      return out;
    }
    function pendingBlock(c) {
      var p = st.pending, res = p.result, kids = [];
      var kept = c.rows.filter(function (r) { return !blank(r); }).length;
      if (res.encoding) kids.push(h('p', { class: 'pd-note pd-note--warn', text: T('The file is not UTF-8 text. In the spreadsheet, save it as “CSV UTF-8” and import it again.') }));
      else if (res.problems.length) {
        kids.push(h('p', { class: 'pd-note pd-note--warn', text: tf('%s cannot be imported as it is: nothing has been changed.', p.label) }));
        kids.push(h('ul', { class: 'pd-team-problems' }, res.problems.slice(0, 10).map(function (q) { return h('li', { text: fileProblemText(q) }); })));
        if (res.problems.length > 10) kids.push(h('p', { class: 'pd-note', text: tf('Further problems: %d.', res.problems.length - 10) }));
      } else if (!res.entries.length) {
        kids.push(h('p', { class: 'pd-note pd-note--info', text: tf('%s holds no entries.', p.label) }));
      } else {
        kids.push(h('p', { class: 'pd-note pd-note--info', text: tf('Entries read from %s: %d.', p.label, res.entries.length) }));
        if (res.ignored && res.ignored.length) kids.push(h('p', { class: 'pd-note', text: tf('Columns not read: %s. A roster keeps only names, numbers, sizes and sets.', res.ignored.join(', ')) }));
        if (res.skipped && res.skipped.length) {
          kids.push(h('p', { class: 'pd-note pd-note--warn', text: tf('Players left out because their surname cannot be printed as it is: %d. Add them by hand.', res.skipped.length) }));
          kids.push(h('ul', { class: 'pd-team-problems' }, res.skipped.slice(0, 10).map(function (s) { return h('li', { 'data-user-content': '', text: s.name }); })));
        }
      }
      var canAppend = res.entries.length && kept + res.entries.length <= R.LIMITS.entries;
      kids.push(h('div', { class: 'pd-dock-btns' }, [
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-import-cancel', 'data-pd-team-key': 'imp-cancel' }, [h('span', { text: T('Cancel') })]),
        res.entries.length && kept ? btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'team-import-append', 'data-pd-team-key': 'imp-append', 'aria-disabled': canAppend ? null : 'true',
          'data-pd-why': canAppend ? null : tf('A roster holds at most %d entries.', R.LIMITS.entries) }, [h('span', { text: tf('Add to the current entries (%d)', kept) })]) : null,
        res.entries.length ? btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'team-import-replace', 'data-pd-team-key': 'imp-replace' }, [h('span', { text: kept ? tf('Replace the current entries (%d)', kept) : T('Use these entries') })]) : null,
      ]));
      return h('div', { class: 'pd-dock-alert pd-team-pending', role: 'status' }, kids);
    }
    function checksBlock(read) {
      var items = [];
      read.problems.forEach(function (p) { items.push(h('li', { class: 'is-error' }, [icon('alert', 14), h('span', { text: tf('Row %d · %s', p.row + 1, problemText(p)) })])); });
      R.duplicateNumbers(read.entries).forEach(function (d) {
        items.push(h('li', null, [icon('info', 14), h('span', { text: tf('Number %d is on more than one row (%d).', d.number, d.entries.length) })]));
      });
      read.entries.forEach(function (e, j) {
        if (!e.name) return;
        var fit = ctx.nameFit(e.name);
        if (fit !== null && fit < FIT_WARN) items.push(h('li', null, [icon('info', 14), h('span', { text: tf('Row %d · the name is condensed to %s of its width to fit the name box.', read.index[j] + 1, ctx.percent(fit)) })]));
      });
      if (!items.length) return h('p', { class: 'pd-note pd-team-checks', text: read.entries.length ? T('Every row can be kept.') : '' });
      return h('ul', { class: 'pd-team-checks', 'aria-label': T('Checks') }, items);
    }
    function summaryBlock(entries) {
      var s = R.summary(entries), rows = [];
      R.FORMS.forEach(function (f) {
        // Size labels read left to right in every language; the words around them follow the page.
        var parts = s.sizes[f].map(function (x) { return h('bdi', { dir: 'ltr', text: x.size + ' × ' + x.sets }); });
        if (s.unsized[f]) parts.push(h('span', { text: tf('without a size: %d', s.unsized[f]) }));
        var dd = h('dd');
        if (!parts.length) dd.appendChild(document.createTextNode('—'));
        parts.forEach(function (p, i) { if (i) dd.appendChild(document.createTextNode(' · ')); dd.appendChild(p); });
        rows.push(h('div', { class: 'pd-team-sum-row' }, [h('dt', { text: T(COLUMN[f]) }), dd]));
      });
      return h('section', { class: 'pd-team-sum', 'aria-label': T('Sizes and sets') }, [
        h('h3', { class: 'pd-prop-sub', text: tf('Entries: %d · sets: %d', s.entries, s.sets) }),
        h('dl', null, rows),
      ]);
    }

    // ── events ──────────────────────────────────────────────────────────────
    function onAction(act, t) {
      if (CO && act.indexOf('col-') === 0) return CO.onAction(act, t);
      if (RQ && act.indexOf('req-') === 0) return RQ.onAction(act, t);
      if (act.indexOf('team-') !== 0) return false;
      var c = st.cur, i = Number(t.getAttribute('data-pd-row'));
      switch (act) {
        case 'team-close': close(); return true;
        case 'team-tab-rosters': if (st.tab !== 'rosters') { st.tab = 'rosters'; st.note = ''; loadList(); } return true;
        case 'team-tab-collections': if (st.tab !== 'collections' && CO) { st.tab = 'collections'; st.note = ''; CO.loadList(); } return true;
        case 'team-tab-requests': if (st.tab !== 'requests' && RQ) { st.tab = 'requests'; st.note = ''; RQ.loadList(); } return true;
        case 'team-retry': loadList(); return true;
        case 'team-filter-active': if (st.list.archived) { st.list.archived = false; loadList(); } return true;
        case 'team-filter-archived': if (!st.list.archived) { st.list.archived = true; loadList(); } return true;
        case 'team-new': startNew(); return true;
        case 'team-open': openRoster(t.getAttribute('data-pd-id')); return true;
        case 'team-archive': setArchived(t.getAttribute('data-pd-id'), true); return true;
        case 'team-unarchive': setArchived(t.getAttribute('data-pd-id'), false); return true;
        case 'team-delete': {
          var id = t.getAttribute('data-pd-id');
          st.confirm = { text: tf('Delete %s for good? Its names, numbers and sizes are erased and cannot be recovered.', t.getAttribute('data-pd-name')), go: T('Delete for good'), run: function () { erase(id); } };
          render(); return true;
        }
        case 'team-back': guard(st.view === 'collection' ? T('Leave this collection? Its unsaved changes are lost.') : T('Leave this roster? Its unsaved changes are lost.'), toList); return true;
        case 'team-confirm-cancel': st.confirm = null; render(); return true;
        case 'team-confirm-go': { var k = st.confirm; st.confirm = null; if (k) k.run(); else render(); return true; }
        case 'team-conflict-open': if (c && c.id) openRoster(c.id); return true;
        case 'team-conflict-keep': if (st.conflict && st.conflict.version) save(st.conflict.version); return true;
        case 'team-add-row':
          if (!c) return true;
          if (c.rows.length >= R.LIMITS.entries) { st.note = tf('A roster holds at most %d entries.', R.LIMITS.entries); render(); return true; }
          c.rows.push(toRow(R.blankEntry())); c.dirty = true; render(); focusField(c.rows.length - 1, 'name'); return true;
        case 'team-remove-row':
          if (!c || !c.rows[i]) return true;
          c.rows.splice(i, 1); c.dirty = true;
          if (st.preview === i) { st.preview = null; pushPreview(); } else if (st.preview !== null && st.preview > i) st.preview--;
          render(); return true;
        case 'team-preview': setPreview(st.preview === i ? null : i); return true;
        case 'team-import': file.click(); return true;
        case 'team-squad': fromSquad(); return true;
        case 'team-import-cancel': st.pending = null; render(); return true;
        case 'team-import-replace': applyPending('replace'); return true;
        case 'team-import-append': applyPending('append'); return true;
        case 'team-export': exportCsv(); return true;
        case 'team-template': download(R.toCsv([], { delimiter: st.delimiter }), 'team-roster-template.csv'); return true;
        case 'team-save': save(); return true;
        default: return false;
      }
    }
    /** An edit in the panel. True when it was the panel's. Only the checks and the preview repaint while typing. */
    function onInput(ev) {
      var t = ev.target, c = st.cur;
      if (!t || !el.contains(t)) return false;
      if (st.view === 'collection' && CO && CO.onInput(ev)) return true;
      if (t.hasAttribute('data-pd-team-rname')) { if (c) { c.name = t.value; c.dirty = true; refresh(); } return true; }
      if (t.hasAttribute('data-pd-team-delim')) { st.delimiter = t.value === ';' ? ';' : ','; return true; }
      var row = t.getAttribute('data-pd-team-row'), col = t.getAttribute('data-pd-team-col');
      if (row === null || !c || !c.rows[Number(row)]) return true;
      c.rows[Number(row)][col] = t.value; c.dirty = true;
      if (st.preview === Number(row)) pushPreview();
      refresh();
      return true;
    }
    /**
     * After an edit: the marks on the cells, the checks, the summary and the unsaved state, in place. The table itself is
     * not rebuilt, so the cell being typed in, and the one about to be clicked, stay where they are.
     */
    function refresh() {
      var c = st.cur;
      if (!c || st.view !== 'roster' || c.state !== 'ready') return;
      var read = readRows(c.rows), bad = {};
      read.problems.forEach(function (p) { bad[p.row + ':' + (p.column || 'name')] = p; });
      var cells = el.querySelectorAll('[data-pd-team-row]');
      for (var i = 0; i < cells.length; i++) {
        var p = bad[cells[i].getAttribute('data-pd-team-row') + ':' + cells[i].getAttribute('data-pd-team-col')];
        if (p) { cells[i].setAttribute('aria-invalid', 'true'); cells[i].setAttribute('title', problemText(p)); }
        else { cells[i].removeAttribute('aria-invalid'); cells[i].removeAttribute('title'); }
      }
      var checks = el.querySelector('.pd-team-checks'), sum = el.querySelector('.pd-team-sum'), dirty = el.querySelector('[data-pd-team-dirty]');
      if (checks) checks.parentNode.replaceChild(checksBlock(read), checks);
      if (sum) sum.parentNode.replaceChild(summaryBlock(read.entries), sum);
      if (dirty) dirty.textContent = c.dirty ? T('Unsaved changes') : (c.id ? T('Saved') : '');
    }
    function onChange(ev) {
      var t = ev.target;
      if (!t || !el.contains(t)) return false;
      if (t === file) { readFile(t.files && t.files[0]); return true; }
      return onInput(ev);
    }
    /** Ctrl+S inside the panel saves the roster, not the design. */
    function onSaveKey(ev) {
      if (!st.open || !el.contains(ev.target)) return false;
      if (st.view === 'collection' && CO) { CO.save(); return true; }
      if (!st.cur || st.view !== 'roster') return false;
      save(); return true;
    }

    return {
      el: el,
      open: open, close: close, repaint: render,
      /** Open the panel on one of its lists (the club's side rail opens its requests). */
      openTab: function (tab, trigger) {
        if (tab === 'requests' && !RQ) return;
        var go = function () {
          if (st.view !== 'list' || st.tab !== tab) {
            if (CO) CO.leave(); if (RQ) RQ.leave();
            st.view = 'list'; st.tab = tab; st.cur = null; st.pending = null; st.note = '';
            if (st.preview !== null) { st.preview = null; pushPreview(); }
            if (tab === 'requests') RQ.loadList(); else if (tab === 'collections' && CO) CO.loadList(); else loadList();
          } else render();
        };
        if (!st.open) open(trigger);
        guard(st.view === 'collection' ? T('Leave this collection? Its unsaved changes are lost.') : T('Leave this roster? Its unsaved changes are lost.'), go);
      },
      isOpen: function () { return st.open; },
      onAction: onAction, onInput: onInput, onChange: onChange, onSaveKey: onSaveKey,
      stopPreview: function () { if (st.preview !== null) { st.preview = null; pushPreview(); render(); } },
      metrics: function () {
        return { open: st.open, view: st.view, list: st.list.state, rosters: st.list.rosters.length, rows: st.cur ? st.cur.rows.length : 0,
          dirty: !!(st.cur && st.cur.dirty), preview: st.preview, pending: st.pending ? st.pending.kind : null, conflict: !!st.conflict,
          tab: st.tab, collections: CO ? CO.metrics() : null, requests: RQ ? RQ.metrics() : null };
      },
    };
  }

  return Object.freeze({ create: create });
});
