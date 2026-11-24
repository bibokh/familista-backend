/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — collections (M3b), in the Team panel.

   A collection gathers a club's saved designs as one kit (a season's home kit:
   shirt, shorts and socks), each with its role, and names the roster it is
   made for. Its order sheet is the server's count of that roster's sets per
   size for each design's garment form; it exports as a spreadsheet.

   The Team panel (pd-team.js) hosts this view as its second tab and hands it
   the room's builders, words and server client (shell); nothing here fetches,
   stores or styles by itself.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignCollections = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function L(text) { return text; }
  var ROLES = ['HOME', 'AWAY', 'THIRD', 'GOALKEEPER', 'TRAINING', 'OTHER'];
  var ROLE = { HOME: L('Home'), AWAY: L('Away'), THIRD: L('Third'), GOALKEEPER: L('Goalkeeper'), TRAINING: L('Training'), OTHER: L('Other') };
  var FORM = { top: L('Top'), shorts: L('Shorts'), socks: L('Socks') };
  var REFUSED = {
    'unknown-design': L('A design in the collection is not one of this club’s saved designs. Remove it and save again.'),
    'unknown-roster': L('The roster chosen is not one of this club’s. Choose another.'),
    'duplicate-design': L('A design is in the collection twice.'),
    'too-many-designs': L('A collection holds at most 12 designs.'),
    'bad-collection-name': L('Give the collection a name of at most 80 characters.'),
    'bad-season': L('A season label has at most 20 characters.'),
  };
  var ITEM_LIMIT = 12;

  function create(shell) {
    var h = shell.h, btn = shell.btn, icon = shell.icon, T = shell.T, tf = shell.tf, api = shell.api, R = shell.roster;
    var st = {
      list: { state: 'idle', items: [], archived: false, error: '', limit: 100 },
      cur: null,        // { id, version, name, season, rosterId, items, dirty, state }
      conflict: null,   // { version }
      projects: { state: 'idle', list: [] },
      rosters: { state: 'idle', list: [] },
      sheet: { state: 'idle', data: null },
      ask: null,        // M4: the request-for-quotation form, open: { note, neededBy }
      busy: false, seq: 0,
    };

    // ── loading ───────────────────────────────────────────────────────────
    function loadList() {
      var seq = ++st.seq, Lst = st.list;
      Lst.state = 'loading'; shell.render();
      api.listCollections(Lst.archived ? 'archived' : 'active').then(function (r) {
        if (seq !== st.seq) return;
        if (r.ok && r.data && Array.isArray(r.data.collections)) { Lst.items = r.data.collections; Lst.limit = r.data.limit; Lst.state = 'ready'; }
        else { Lst.state = 'error'; Lst.error = r.status === 0 ? T('The server could not be reached.') : T('The collections could not be loaded.'); }
        shell.render();
      });
    }
    function loadChoices() {
      st.projects.state = 'loading'; st.rosters.state = 'loading';
      api.listProjects('active').then(function (r) {
        st.projects = r.ok && r.data && Array.isArray(r.data.projects) ? { state: 'ready', list: r.data.projects } : { state: 'error', list: [] };
        shell.render();
      });
      api.listRosters('active').then(function (r) {
        st.rosters = r.ok && r.data && Array.isArray(r.data.rosters) ? { state: 'ready', list: r.data.rosters } : { state: 'error', list: [] };
        shell.render();
      });
    }
    function loadSheet() {
      var c = st.cur;
      st.sheet = { state: 'idle', data: null };
      if (!c || !c.id || c.dirty || !c.rosterId) return;
      st.sheet.state = 'loading';
      var seq = ++st.seq;
      api.orderSheet(c.id).then(function (r) {
        if (seq !== st.seq || st.cur !== c) return;
        st.sheet = r.ok && r.data && r.data.sheet ? { state: 'ready', data: r.data.sheet } : { state: 'error', data: null };
        shell.render();
      });
    }
    function fromView(v) {
      return {
        id: v.id, version: v.version, name: v.name, season: v.season || '', rosterId: v.rosterId || '', dirty: false, state: 'ready', archived: !!v.archivedAt,
        items: v.items.map(function (i) { return { projectId: i.projectId, role: i.role, name: i.name, templateKey: i.templateKey, form: i.form, archived: i.archived, revision: i.revision || null, approval: i.approval || null }; }),
      };
    }
    function open(id) {
      var seq = ++st.seq;
      st.cur = { id: id, state: 'loading', items: [], dirty: false }; st.conflict = null;
      shell.show('collection');
      loadChoices();
      api.openCollection(id).then(function (r) {
        if (seq !== st.seq || !st.cur) return;
        if (!r.ok || !r.data || !r.data.collection) { st.cur.state = 'error'; shell.render(); return; }
        st.cur = fromView(r.data.collection);
        loadSheet();
        shell.render();
      });
    }
    function startNew() {
      st.cur = { id: null, version: 0, name: T('Collection'), season: '', rosterId: '', items: [], dirty: true, state: 'ready' };
      st.conflict = null; st.sheet = { state: 'idle', data: null };
      var here = shell.currentProject();
      if (here) st.cur.items.push({ projectId: here.id, role: 'HOME', name: here.name, templateKey: here.templateKey, form: null, archived: false });
      shell.show('collection');
      loadChoices();
    }

    // ── changing ──────────────────────────────────────────────────────────
    function body() {
      var c = st.cur;
      return { name: String(c.name).replace(/\s+/g, ' ').trim(), season: String(c.season).trim() || null, rosterId: c.rosterId || null,
        items: c.items.map(function (i) { return { projectId: i.projectId, role: i.role }; }) };
    }
    function save(overVersion) {
      var c = st.cur;
      if (!c || st.busy || c.state !== 'ready') return;
      var b = body();
      if (!b.name) { shell.note(T('Give the collection a name of at most 80 characters.')); return; }
      st.busy = true; shell.note(T('Saving…'));
      (c.id ? api.saveCollection(c.id, overVersion || c.version, b) : api.createCollection(b)).then(function (r) {
        st.busy = false;
        if (st.cur !== c) return;
        if (r.ok && r.data && r.data.collection) {
          st.cur = fromView(r.data.collection); st.conflict = null;
          shell.note(tf('Saved. Designs: %d.', st.cur.items.length));
          loadSheet();
        } else if (r.code === 'COLLECTION_CONFLICT') { st.conflict = { version: r.data && r.data.version }; shell.note(''); }
        else if (r.code === 'COLLECTION_INVALID') shell.note(T(REFUSED[r.reason] || L('The server refused the collection as it is.')));
        else if (r.code === 'COLLECTION_LIMIT') shell.note(tf('A club keeps at most %d collections: archive one first.', st.list.limit || 100));
        else if (r.code === 'COLLECTION_ARCHIVED') shell.note(T('This collection is archived: return it to the list before saving it.'));
        else shell.note(r.status === 0 ? T('Not saved: the server could not be reached.') : T('The collection could not be saved.'));
        shell.render();
      });
    }
    function setArchived(id, archived) {
      if (st.busy) return;
      st.busy = true;
      (archived ? api.archiveCollection(id) : api.unarchiveCollection(id)).then(function (r) {
        st.busy = false;
        shell.note(r.ok ? (archived ? T('Collection archived.') : T('Collection returned to the list.'))
          : r.code === 'COLLECTION_LIMIT' ? tf('A club keeps at most %d collections: archive one first.', st.list.limit || 100) : T('The collection could not be changed.'));
        loadList();
      });
    }
    function erase(id) {
      if (st.busy) return;
      st.busy = true;
      api.deleteCollection(id).then(function (r) {
        st.busy = false;
        shell.note(r.ok ? T('Collection deleted. Its designs are kept.') : T('The collection could not be deleted.'));
        loadList();
      });
    }
    function touch() { st.cur.dirty = true; st.sheet = { state: 'idle', data: null }; }
    function addItem(p) {
      var c = st.cur;
      if (!c || !p || c.items.length >= ITEM_LIMIT || c.items.some(function (i) { return i.projectId === p.id; })) return;
      c.items.push({ projectId: p.id, role: c.items.length ? c.items[c.items.length - 1].role : 'HOME', name: p.name, templateKey: p.templateKey, form: null, archived: false });
      touch(); shell.render();
    }
    function exportSheet() {
      var s = st.sheet.data;
      if (!s) return;
      var rows = [];
      s.garments.forEach(function (g) {
        g.sizes.forEach(function (x) { rows.push([g.name, g.role.toLowerCase(), g.form || '', x.size, x.sets]); });
        if (g.unsized) rows.push([g.name, g.role.toLowerCase(), g.form || '', '', g.unsized]);
      });
      shell.download(R.toTable(['design', 'role', 'garment', 'size', 'sets'], rows, { delimiter: shell.delimiter() }),
        R.csvFileName(s.collection.name + (s.collection.season ? ' ' + s.collection.season : '') + ' order sheet'));
    }

    // ── drawing ───────────────────────────────────────────────────────────
    function listBody() {
      var Lst = st.list, out = [];
      if (Lst.state === 'idle') loadList();
      out.push(h('div', { class: 'pd-dock-bar-row' }, [
        h('div', { class: 'pd-tabs', role: 'group', 'aria-label': T('Collections') }, [
          btn({ class: 'pd-tab', 'data-pd-act': 'col-filter-active', 'data-pd-team-key': 'cf-active', 'aria-pressed': Lst.archived ? 'false' : 'true', text: T('Active') }),
          btn({ class: 'pd-tab', 'data-pd-act': 'col-filter-archived', 'data-pd-team-key': 'cf-archived', 'aria-pressed': Lst.archived ? 'true' : 'false', text: T('Archived') }),
        ]),
        Lst.archived ? null : btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'col-new', 'data-pd-team-key': 'col-new' }, [icon('plus', 14), h('span', { text: T('New collection') })]),
      ]));
      if (Lst.state === 'loading' || Lst.state === 'idle') {
        out.push(h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2].map(function () {
          return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]);
        })));
      } else if (Lst.state === 'error') {
        out.push(h('div', { class: 'pd-dock-alert', role: 'alert' }, [h('p', { class: 'pd-note', text: Lst.error }),
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-retry' }, [h('span', { text: T('Try again') })])]));
      } else if (!Lst.items.length) {
        out.push(h('p', { class: 'pd-empty', text: Lst.archived ? T('No archived collections.')
          : T('No collections yet. A collection gathers the club’s saved designs as one kit, a season’s home kit for instance, and counts a roster’s sizes for each.') }));
      } else {
        var list = h('ul', { class: 'pd-dock-list', role: 'list' });
        Lst.items.forEach(function (c) {
          list.appendChild(h('li', { class: 'pd-dock-row' }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-dock-name', 'data-user-content': '', text: c.season ? c.name + ' · ' + c.season : c.name }),
              h('span', { class: 'pd-dock-kicker', text: tf('Designs: %d · saved %s', c.items, shell.date(c.updatedAt)) }),
            ]),
            h('div', { class: 'pd-dock-btns' }, Lst.archived ? [
              btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-unarchive', 'data-pd-id': c.id, 'aria-label': tf('Return %s to the list', c.name) }, [h('span', { text: T('Return') })]),
              btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-delete', 'data-pd-id': c.id, 'data-pd-name': c.name, 'aria-label': tf('Delete %s', c.name) }, [icon('trash', 14), h('span', { text: T('Delete') })]),
            ] : [
              btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'col-open', 'data-pd-id': c.id, 'aria-label': tf('Open %s', c.name) }, [h('span', { text: T('Open') })]),
              btn({ class: 'pd-icbtn', 'data-pd-act': 'col-archive', 'data-pd-id': c.id, 'aria-label': tf('Archive %s', c.name), title: tf('Archive %s', c.name) }, [icon('trash', 14)]),
            ]),
          ]));
        });
        out.push(list);
      }
      return out;
    }
    function conflictBlock() {
      if (!st.conflict) return null;
      return h('div', { class: 'pd-dock-alert', role: 'alert' }, [
        h('p', { class: 'pd-note', text: T('Someone saved this collection after you opened it. Open their version, or save yours over it.') }),
        h('div', { class: 'pd-dock-btns' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-conflict-open' }, [h('span', { text: T('Open their version') })]),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'col-conflict-keep' }, [h('span', { text: T('Save mine over it') })]),
        ]),
      ]);
    }
    function editorBody() {
      var c = st.cur, out = [conflictBlock()];
      if (c.state === 'loading') return [h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2].map(function () { return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' })]); }))];
      if (c.state === 'error') return [h('div', { class: 'pd-dock-alert', role: 'alert' }, [h('p', { class: 'pd-note', text: T('The collection could not be opened.') }),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-back' }, [h('span', { text: T('Back to the collections') })])])];
      // Its name, its season and the roster it is for.
      var name = h('input', { class: 'pd-input', type: 'text', maxlength: '80', 'data-pd-col-field': 'name', 'data-pd-team-key': 'col-name', 'data-user-content': '', dir: 'auto', 'aria-label': T('Collection name') });
      name.value = c.name;
      var season = h('input', { class: 'pd-input', type: 'text', maxlength: '20', 'data-pd-col-field': 'season', 'data-pd-team-key': 'col-season', 'data-user-content': '', dir: 'auto', placeholder: '2026/27', 'aria-label': T('Season') });
      season.value = c.season;
      var roster = h('select', { class: 'pd-input', 'data-pd-col-field': 'rosterId', 'data-pd-team-key': 'col-roster', 'aria-label': T('Made for the roster') }, [h('option', { value: '', text: T('No roster') })]);
      st.rosters.list.forEach(function (r) { roster.appendChild(h('option', { value: r.id, 'data-user-content': '', text: r.name })); });
      if (c.rosterId && !st.rosters.list.some(function (r) { return r.id === c.rosterId; })) roster.appendChild(h('option', { value: c.rosterId, text: T('A roster no longer in the list') }));
      roster.value = c.rosterId || '';
      out.push(h('div', { class: 'pd-col-fields' }, [
        h('label', { class: 'pd-team-field pd-col-name' }, [h('span', { class: 'pd-dock-kicker', text: T('Collection name') }), name]),
        h('label', { class: 'pd-team-field pd-col-season' }, [h('span', { class: 'pd-dock-kicker', text: T('Season') }), season]),
        h('label', { class: 'pd-team-field pd-col-roster' }, [h('span', { class: 'pd-dock-kicker', text: T('Made for the roster') }), roster]),
      ]));
      // Its designs.
      out.push(h('h3', { class: 'pd-prop-sub', text: tf('Designs: %d of %d', c.items.length, ITEM_LIMIT) }));
      if (!c.items.length) out.push(h('p', { class: 'pd-empty', text: T('No designs yet. Add the club’s saved designs below: the shirt, the shorts and the socks of one kit.') }));
      else {
        var list = h('ul', { class: 'pd-dock-list pd-col-items', role: 'list' });
        c.items.forEach(function (it, i) {
          var role = h('select', { class: 'pd-input pd-col-role', 'data-pd-col-role': String(i), 'data-pd-team-key': 'col-role-' + i, 'aria-label': tf('Role of %s', it.name) });
          ROLES.forEach(function (k) { role.appendChild(h('option', { value: k, text: T(ROLE[k]) })); });
          role.value = it.role;
          list.appendChild(h('li', { class: 'pd-dock-row pd-col-item' }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-dock-name', 'data-user-content': '', text: it.name }),
              h('span', { class: 'pd-dock-kicker', text: [shell.productLabel(it.templateKey), it.archived ? T('Archived') : ''].filter(Boolean).join(' · ') }),
              // M7b: the club's decision on the design's newest version, where its plan includes reviews.
              shell.approvalChip && it.revision ? h('span', { class: 'pd-rv-line', 'data-pd-col-approval': it.approval ? it.approval.decision : 'none' }, [shell.approvalChip(it.approval), h('span', { class: 'pd-note', text: tf('version %d', it.revision) })]) : null,
            ]),
            h('div', { class: 'pd-dock-btns' }, [
              role,
              btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-open-design', 'data-pd-id': it.projectId, 'aria-label': tf('Open %s', it.name) }, [h('span', { text: T('Open') })]),
              btn({ class: 'pd-icbtn', 'data-pd-act': 'col-remove', 'data-pd-row': String(i), 'data-pd-team-key': 'col-rm-' + i, 'aria-label': tf('Remove %s from the collection', it.name), title: T('Remove from the collection') }, [icon('close', 14)]),
            ]),
          ]));
        });
        out.push(list);
      }
      // Adding: a saved design of the club's, or the one on screen.
      var full = c.items.length >= ITEM_LIMIT;
      var free = st.projects.list.filter(function (p) { return !c.items.some(function (i) { return i.projectId === p.id; }); });
      var pick = h('select', { class: 'pd-input', 'data-pd-col-pick': '', 'data-pd-team-key': 'col-pick', 'aria-label': T('A saved design to add') },
        [h('option', { value: '', text: st.projects.state === 'loading' ? T('Loading…') : free.length ? T('Choose a saved design') : T('No other saved design') })]
          .concat(free.map(function (p) { return h('option', { value: p.id, 'data-user-content': '', text: p.name + ' · ' + shell.productLabel(p.templateKey) }); })));
      var here = shell.currentProject();
      var hereFree = here && !c.items.some(function (i) { return i.projectId === here.id; });
      out.push(h('div', { class: 'pd-team-tools', role: 'group', 'aria-label': T('Add a design') }, [
        pick,
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-add', 'data-pd-team-key': 'col-add', 'aria-disabled': full || !free.length ? 'true' : null,
          'data-pd-why': full ? T('A collection holds at most 12 designs.') : !free.length ? T('No other saved design') : null }, [icon('plus', 14), h('span', { text: T('Add') })]),
        hereFree ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-add-here', 'data-pd-team-key': 'col-add-here', 'aria-disabled': full ? 'true' : null, 'data-pd-why': full ? T('A collection holds at most 12 designs.') : null }, [icon('shirt', 14), h('span', { text: T('Add the design on screen') })]) : null,
      ]));
      if (!here) out.push(h('p', { class: 'pd-note', text: T('Save the design on screen to add it to a collection.') }));
      out.push(sheetBlock());
      out.push(h('div', { class: 'pd-dock-btns pd-team-save' }, [
        h('span', { class: 'pd-dock-kicker', 'data-pd-col-dirty': '', text: c.dirty ? T('Unsaved changes') : (c.id ? T('Saved') : '') }),
        btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'col-save', 'data-pd-team-key': 'col-save', 'aria-disabled': st.busy ? 'true' : null, 'data-pd-why': st.busy ? T('Saving…') : null, 'aria-keyshortcuts': 'Control+S' }, [icon('save', 14), h('span', { text: T('Save collection') })]),
      ]));
      return out;
    }
    function sheetBlock() {
      var c = st.cur, s = st.sheet, kids = [h('h3', { class: 'pd-prop-sub', text: T('Order sheet') })];
      if (!c.rosterId) kids.push(h('p', { class: 'pd-empty', text: T('Choose the roster the collection is made for: the order sheet counts its sets per size for each design.') }));
      else if (c.dirty || !c.id) kids.push(h('p', { class: 'pd-note', text: T('Save the collection to count its order sheet.') }));
      else if (s.state === 'loading' || s.state === 'idle') kids.push(h('p', { class: 'pd-dock-row is-skeleton', 'aria-busy': 'true' }, [h('span', { class: 'pd-dock-bar' })]));
      else if (s.state === 'error') kids.push(h('p', { class: 'pd-note pd-note--warn', text: T('The order sheet could not be counted.') }));
      else {
        var d = s.data;
        kids.push(h('p', { class: 'pd-note', text: tf('For %s: entries %d · sets %d.', d.roster.name, d.roster.entries, d.roster.sets) }));
        var table = h('table', { class: 'pd-team-table pd-col-sheet' }, [h('thead', null, [h('tr', null, [
          h('th', { scope: 'col', text: T('Design') }), h('th', { scope: 'col', text: T('Garment') }), h('th', { scope: 'col', text: T('Sizes and sets') }),
        ])])]);
        var tb = h('tbody');
        d.garments.forEach(function (g) {
          var cell = h('td');
          if (!g.form) cell.appendChild(document.createTextNode(T('Not a released garment')));
          else if (!g.sizes.length && !g.unsized) cell.appendChild(document.createTextNode('—'));
          else {
            g.sizes.forEach(function (x, i) { if (i) cell.appendChild(document.createTextNode(' · ')); cell.appendChild(h('bdi', { dir: 'ltr', text: x.size + ' × ' + x.sets })); });
            if (g.unsized) { if (g.sizes.length) cell.appendChild(document.createTextNode(' · ')); cell.appendChild(h('span', { class: 'pd-col-unsized', text: tf('without a size: %d', g.unsized) })); }
          }
          tb.appendChild(h('tr', null, [
            h('th', { scope: 'row' }, [h('span', { 'data-user-content': '', text: g.name }), h('span', { class: 'pd-dock-kicker', text: ' · ' + T(ROLE[g.role]) })]),
            h('td', { text: g.form ? T(FORM[g.form]) : '—' }), cell,
          ]));
        });
        table.appendChild(tb);
        kids.push(h('div', { class: 'pd-team-scroll pd-col-sheet-wrap', role: 'region', 'aria-label': T('Order sheet'), tabindex: '0' }, [table]));
        if (d.garments.some(function (g) { return g.unsized; })) kids.push(h('p', { class: 'pd-note pd-note--warn', text: T('Some entries have no size for a garment: give them one in the roster before ordering.') }));
        var unsized = d.garments.some(function (g) { return g.unsized || !g.form; });
        kids.push(h('div', { class: 'pd-team-tools' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-export', 'data-pd-team-key': 'col-export' }, [icon('export', 14), h('span', { text: T('Export the order sheet') })]),
          shell.openRequest ? btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'col-ask', 'data-pd-team-key': 'col-ask', 'aria-expanded': st.ask ? 'true' : 'false',
            'aria-disabled': unsized ? 'true' : null, 'data-pd-why': unsized ? T('Give every entry a size for every garment before asking for a quotation.') : null }, [icon('factory', 14), h('span', { text: T('Request a quotation') })]) : null,
        ]));
        if (st.ask) kids.push(askForm());
        kids.push(h('p', { class: 'pd-note', text: T('Quantities only: no supplier has quoted for them, and nothing is ordered.') }));
      }
      return h('section', { class: 'pd-col-sheet-block', 'aria-label': T('Order sheet') }, kids);
    }

    /** M4: what the club adds to a request for quotation: a note for Familista and the date it needs the kit by. */
    function askForm() {
      var note = h('textarea', { class: 'pd-input pd-col-ask-note', rows: '3', maxlength: '1000', 'data-pd-col-ask': 'note', 'data-pd-team-key': 'col-ask-note', 'data-user-content': '', dir: 'auto', 'aria-label': T('A note for Familista (optional)') });
      note.value = st.ask.note;
      var min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      var date = h('input', { class: 'pd-input', type: 'date', min: min, 'data-pd-col-ask': 'neededBy', 'data-pd-team-key': 'col-ask-date', 'aria-label': T('Needed by (optional)') });
      date.value = st.ask.neededBy;
      // M7b: asking before every design is approved is allowed, and said.
      var items = st.cur ? st.cur.items : [], approved = items.filter(function (it) { return it.approval && it.approval.decision === 'APPROVED'; }).length;
      var unreviewed = shell.approvalChip && items.length && approved < items.length
        ? h('p', { class: 'pd-note pd-note--warn', 'data-pd-col-unapproved': String(items.length - approved) }, [icon('alert', 14), h('span', { text: tf('%d of %d designs are approved by a club administrator. You can still ask for a quotation; approve them in Review first if they should be final.', approved, items.length) })])
        : null;
      return h('div', { class: 'pd-dock-alert pd-col-ask', role: 'group', 'aria-label': T('Request a quotation') }, [
        h('p', { class: 'pd-note', text: T('Familista asks verified suppliers for quotations for exactly this collection and roster, as they are now, and publishes them in Requests. Nothing is ordered or charged until you accept one and Familista confirms it.') }),
        unreviewed,
        h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-dock-kicker', text: T('A note for Familista (optional)') }), note]),
        h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-dock-kicker', text: T('Needed by (optional)') }), date]),
        h('div', { class: 'pd-dock-btns' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'col-ask-cancel', 'data-pd-team-key': 'col-ask-cancel' }, [h('span', { text: T('Cancel') })]),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'col-ask-send', 'data-pd-team-key': 'col-ask-send', 'aria-disabled': st.busy ? 'true' : null, 'data-pd-why': st.busy ? T('Sending…') : null }, [h('span', { text: T('Send the request') })]),
        ]),
      ]);
    }
    var INCOMPLETE = {
      'no-roster': L('Choose the roster the kit is made for, and save the collection.'),
      unsized: L('Give every entry a size for every garment before asking for a quotation.'),
      'no-designs': L('Add the collection’s designs first.'),
      'not-released': L('A design is not of a released garment.'),
      'roster-archived': L('The roster is archived: return it to the list first.'),
      'empty-roster': L('The roster has no entries.'),
      'collection-archived': L('This collection is archived.'),
      'too-many-open': L('The club has too many open requests: close one first.'),
    };
    function sendAsk() {
      var c = st.cur;
      if (!c || !c.id || st.busy || !st.ask) return;
      st.busy = true; shell.note(T('Sending…'));
      api.submitRequest(c.id, { rosterId: c.rosterId || null, note: st.ask.note.trim() || null, neededBy: st.ask.neededBy || null }).then(function (r) {
        st.busy = false;
        if (r.ok && r.data && r.data.request) { st.ask = null; shell.note(T('Request sent to Familista.')); shell.openRequest(r.data.request.id); return; }
        if (r.code === 'REQUEST_INCOMPLETE' || r.code === 'REQUEST_LIMIT') shell.note(T(INCOMPLETE[r.reason] || L('The request cannot be sent as it is.')));
        else if (r.code === 'QUOTE_INVALID') shell.note(T('Choose a date from tomorrow on, or none.'));
        else shell.note(r.status === 0 ? T('Not sent: the server could not be reached.') : T('The request could not be sent.'));
        shell.render();
      });
    }

    // ── events ────────────────────────────────────────────────────────────
    function onAction(act, t) {
      if (act.indexOf('col-') !== 0) return false;
      var c = st.cur, i = Number(t.getAttribute('data-pd-row'));
      switch (act) {
        case 'col-retry': loadList(); return true;
        case 'col-filter-active': if (st.list.archived) { st.list.archived = false; loadList(); } return true;
        case 'col-filter-archived': if (!st.list.archived) { st.list.archived = true; loadList(); } return true;
        case 'col-new': startNew(); return true;
        case 'col-open': open(t.getAttribute('data-pd-id')); return true;
        case 'col-archive': setArchived(t.getAttribute('data-pd-id'), true); return true;
        case 'col-unarchive': setArchived(t.getAttribute('data-pd-id'), false); return true;
        case 'col-delete': {
          var id = t.getAttribute('data-pd-id');
          shell.confirm(tf('Delete %s? The collection goes; its designs are kept.', t.getAttribute('data-pd-name')), T('Delete'), function () { erase(id); });
          return true;
        }
        case 'col-conflict-open': if (c && c.id) open(c.id); return true;
        case 'col-conflict-keep': if (st.conflict && st.conflict.version) save(st.conflict.version); return true;
        case 'col-remove': if (c && c.items[i]) { c.items.splice(i, 1); touch(); shell.render(); } return true;
        case 'col-add': {
          var sel = t.parentNode && t.parentNode.querySelector('[data-pd-col-pick]'), pid = sel && sel.value;
          addItem(st.projects.list.filter(function (p) { return p.id === pid; })[0]);
          return true;
        }
        case 'col-add-here': addItem(shell.currentProject()); return true;
        case 'col-open-design': shell.openDesign(t.getAttribute('data-pd-id')); return true;
        case 'col-export': exportSheet(); return true;
        case 'col-ask': st.ask = st.ask ? null : { note: '', neededBy: '' }; shell.render(); return true;
        case 'col-ask-cancel': st.ask = null; shell.render(); return true;
        case 'col-ask-send': sendAsk(); return true;
        case 'col-save': save(); return true;
        default: return false;
      }
    }
    function onInput(ev) {
      var t = ev.target, c = st.cur;
      if (!c) return false;
      var f = t.getAttribute('data-pd-col-field'), r = t.getAttribute('data-pd-col-role');
      if (f) {
        c[f] = t.value; touch();
        if (f === 'rosterId') shell.render();
        else { var d = shell.el.querySelector('[data-pd-col-dirty]'); if (d) d.textContent = T('Unsaved changes'); }
        return true;
      }
      if (r !== null && c.items[Number(r)]) { c.items[Number(r)].role = t.value; touch(); shell.render(); return true; }
      var ask = t.getAttribute('data-pd-col-ask');
      if (ask && st.ask) { st.ask[ask] = t.value; return true; }
      return t.hasAttribute('data-pd-col-pick');
    }

    return {
      listBody: listBody, editorBody: editorBody, onAction: onAction, onInput: onInput, loadList: loadList,
      save: function () { save(); },
      dirty: function () { return !!(st.cur && st.cur.dirty && st.cur.state === 'ready'); },
      leave: function () { st.cur = null; st.conflict = null; st.ask = null; st.sheet = { state: 'idle', data: null }; },
      metrics: function () {
        return { list: st.list.state, collections: st.list.items.length, items: st.cur ? st.cur.items.length : 0, dirty: !!(st.cur && st.cur.dirty),
          conflict: !!st.conflict, sheet: st.sheet.state, garments: st.sheet.data ? st.sheet.data.garments.length : 0 };
      },
    };
  }

  return Object.freeze({ create: create });
});
