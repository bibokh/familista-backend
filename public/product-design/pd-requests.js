/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — the club's requests for quotation (M4), in the
   Team panel.

   Owner-brokered: a club asks for a quotation for a collection and a roster;
   Familista (the Platform Owner) obtains quotations from verified suppliers
   and publishes them here; the club accepts one, declines or cancels; Familista
   confirms the order with the supplier and records production, shipping and
   delivery, which the club may confirm. Every step is the server's, which says
   what is possible; nothing here charges or pays anything.

   The Team panel (pd-team.js) hosts this view as its third tab and hands it
   the room's builders, words and server client (shell).
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignRequests = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function L(text) { return text; }
  var STATUS = {
    SUBMITTED: L('Submitted'), IN_REVIEW: L('In review'), QUOTED: L('Quoted'), ACCEPTED: L('Accepted'), ORDERED: L('Ordered'),
    IN_PRODUCTION: L('In production'), SHIPPED: L('Shipped'), DELIVERED: L('Delivered'), CANCELLED: L('Cancelled'), DECLINED: L('Declined'), REFUSED: L('Refused'),
  };
  var FINAL = { DELIVERED: true, CANCELLED: true, DECLINED: true, REFUSED: true };
  var ACTION = {
    submit: L('Request submitted'), review: L('Taken into review'), refuse: L('Refused by Familista'), quote: L('Quotation published'),
    withdraw: L('Quotation withdrawn'), cancel: L('Cancelled by the club'), decline: L('Quotations declined'), accept: L('Quotation accepted'),
    order: L('Order confirmed with the supplier'), produce: L('Production started'), ship: L('Shipped'), deliver: L('Delivered'),
  };
  var ACTOR = { CLUB: L('Your club'), OWNER: L('Familista'), SUPPLIER: L('Supplier') };
  var QUOTE = { PUBLISHED: L('Open'), ACCEPTED: L('Accepted'), SUPERSEDED: L('Set aside') };
  var FORM = { top: L('Top'), shorts: L('Shorts'), socks: L('Socks') };
  var REFUSED = {
    'wrong-status': L('That step is not possible at this stage of the request.'),
    moved: L('The request changed meanwhile. It has been reloaded.'),
    'quote-expired': L('This quotation is no longer valid. Ask Familista for a new one.'),
    'supplier-not-verified': L('This supplier is no longer verified, so its quotation cannot be accepted.'),
  };

  /** An amount in the currency's minor unit, in the viewer's language: the exponent is the currency's own. */
  function money(minor, currency, lang) {
    try {
      var digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency }).resolvedOptions().maximumFractionDigits;
      return new Intl.NumberFormat(lang, { style: 'currency', currency: currency }).format(minor / Math.pow(10, digits));
    } catch (_) { return currency + ' ' + minor; }
  }
  function region(code, lang) {
    try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || code; } catch (_) { return code; }
  }
  function day(iso, lang) {
    try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)); } catch (_) { return String(iso).slice(0, 10); }
  }

  function create(shell) {
    var h = shell.h, btn = shell.btn, icon = shell.icon, T = shell.T, tf = shell.tf, api = shell.api;
    var st = { list: { state: 'idle', items: [], error: '' }, cur: null, busy: false, seq: 0 };

    function loadList() {
      var seq = ++st.seq;
      st.list.state = 'loading'; shell.render();
      api.listRequests().then(function (r) {
        if (seq !== st.seq) return;
        if (r.ok && r.data && Array.isArray(r.data.requests)) { st.list.items = r.data.requests; st.list.state = 'ready'; }
        else { st.list.state = 'error'; st.list.error = r.status === 0 ? T('The server could not be reached.') : T('The requests could not be loaded.'); }
        shell.render();
      });
    }
    function open(id) {
      var seq = ++st.seq;
      st.cur = { id: id, state: 'loading' };
      shell.show('request');
      api.openRequest(id).then(function (r) {
        if (seq !== st.seq) return;
        st.cur = r.ok && r.data && r.data.request ? { id: id, state: 'ready', data: r.data.request } : { id: id, state: 'error' };
        shell.render();
      });
    }
    function done(r, okText) {
      st.busy = false;
      if (r.ok && r.data && r.data.request) { st.cur = { id: r.data.request.id, state: 'ready', data: r.data.request }; shell.note(okText); }
      else if (r.code === 'REQUEST_STEP_REFUSED') { shell.note(T(REFUSED[r.reason] || REFUSED['wrong-status'])); if (st.cur) open(st.cur.id); return; }
      else shell.note(r.status === 0 ? T('Not sent: the server could not be reached.') : T('The request could not be changed.'));
      shell.render();
    }
    function act(call, okText) {
      if (st.busy) return;
      st.busy = true; shell.note(T('Sending…'));
      call().then(function (r) { done(r, okText); });
    }

    // ── drawing ───────────────────────────────────────────────────────────
    function statusChip(s) {
      return h('span', { class: 'pd-chip ' + (FINAL[s] ? 'pd-chip--muted' : 'pd-chip--accent'), 'data-pd-req-status': s, text: T(STATUS[s] || s) });
    }
    function listBody() {
      var Lst = st.list, out = [];
      if (Lst.state === 'idle') loadList();
      out.push(h('p', { class: 'pd-note', text: T('Familista obtains quotations from verified suppliers for a collection and a roster, and follows the order to delivery. Ask for one from a collection’s order sheet.') }));
      if (Lst.state === 'loading' || Lst.state === 'idle') {
        out.push(h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2].map(function () { return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]); })));
      } else if (Lst.state === 'error') {
        out.push(h('div', { class: 'pd-dock-alert', role: 'alert' }, [h('p', { class: 'pd-note', text: Lst.error }), btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'req-retry' }, [h('span', { text: T('Try again') })])]));
      } else if (!Lst.items.length) {
        out.push(h('p', { class: 'pd-empty', text: T('No requests yet. Open a collection, choose its roster and ask for a quotation from its order sheet.') }));
      } else {
        var list = h('ul', { class: 'pd-dock-list', role: 'list' });
        Lst.items.forEach(function (r) {
          var name = r.collection.season ? r.collection.name + ' · ' + r.collection.season : r.collection.name;
          list.appendChild(h('li', { class: 'pd-dock-row' }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-dock-name', 'data-user-content': '', text: name }),
              h('span', { class: 'pd-dock-kicker', text: tf('Sets: %d · updated %s', r.sets, shell.date(r.updatedAt)) }),
            ]),
            h('div', { class: 'pd-dock-btns' }, [statusChip(r.status),
              btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'req-open', 'data-pd-id': r.id, 'aria-label': tf('Open the request for %s', name) }, [h('span', { text: T('Open') })])]),
          ]));
        });
        out.push(list);
      }
      return out;
    }
    function detailBody() {
      var c = st.cur;
      if (!c || c.state === 'loading') return [h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2].map(function () { return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' })]); }))];
      if (c.state === 'error') return [h('div', { class: 'pd-dock-alert', role: 'alert' }, [h('p', { class: 'pd-note', text: T('The request could not be opened.') }),
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'team-back' }, [h('span', { text: T('Back to the requests') })])])];
      var r = c.data, spec = r.spec, lang = shell.lang(), out = [];
      out.push(h('div', { class: 'pd-req-head' }, [
        h('div', { class: 'pd-dock-text' }, [
          h('span', { class: 'pd-dock-name', 'data-user-content': '', text: spec.collection.season ? spec.collection.name + ' · ' + spec.collection.season : spec.collection.name }),
          h('span', { class: 'pd-dock-kicker' }, [T('For the roster'), ' ', h('span', { 'data-user-content': '', text: spec.roster.name }), ' · ', tf('sets %d', spec.sets)]),
        ]),
        statusChip(r.status),
      ]));
      // What the club asked for.
      var table = h('table', { class: 'pd-team-table pd-col-sheet' }, [h('thead', null, [h('tr', null, [
        h('th', { scope: 'col', text: T('Design') }), h('th', { scope: 'col', text: T('Garment') }), h('th', { scope: 'col', text: T('Sizes and sets') }),
      ])])]);
      var tb = h('tbody');
      spec.garments.forEach(function (g) {
        var cell = h('td');
        g.sizes.forEach(function (x, i) { if (i) cell.appendChild(document.createTextNode(' · ')); cell.appendChild(h('bdi', { dir: 'ltr', text: x.size + ' × ' + x.sets })); });
        tb.appendChild(h('tr', null, [h('th', { scope: 'row' }, [h('span', { 'data-user-content': '', text: g.name }), h('span', { class: 'pd-dock-kicker', text: ' · ' + tf('version %d', g.revision) }),
          shell.approvalChip ? h('span', { class: 'pd-rv-cell' }, [shell.approvalChip(g.approval)]) : null]),
          h('td', { text: T(FORM[g.form]) }), cell]));
      });
      table.appendChild(tb);
      out.push(h('div', { class: 'pd-team-scroll pd-col-sheet-wrap', role: 'region', 'aria-label': T('What was asked for'), tabindex: '0' }, [table]));
      if (r.neededBy) out.push(h('p', { class: 'pd-note', text: tf('Needed by %s.', day(r.neededBy, lang)) }));
      // Quotations.
      out.push(h('h3', { class: 'pd-prop-sub', text: T('Quotations') }));
      if (!r.quotes.length) {
        out.push(h('p', { class: 'pd-empty', text: FINAL[r.status] ? T('No quotation was published for this request.')
          : T('No quotation yet. Familista asks verified suppliers and publishes their quotations here.') }));
      } else {
        var ql = h('ul', { class: 'pd-dock-list pd-req-quotes', role: 'list' });
        r.quotes.forEach(function (q) {
          var accept = r.status === 'QUOTED' && q.status === 'PUBLISHED';
          ql.appendChild(h('li', { class: 'pd-dock-row pd-req-quote', 'data-pd-quote': q.id }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-req-amount', text: money(q.totalMinor, q.currency, lang) }),
              h('span', { class: 'pd-dock-kicker' }, [h('span', { 'data-user-content': '', text: q.supplier.name }), ' · ' + region(q.supplier.country, lang) + ' · ' + T('Verified by Familista')]),
              h('span', { class: 'pd-dock-kicker', text: tf('Made in %d days · valid until %s', q.leadTimeDays, day(q.validUntil, lang)) }),
            ]),
            h('div', { class: 'pd-dock-btns' }, [
              h('span', { class: 'pd-chip ' + (q.status === 'SUPERSEDED' ? 'pd-chip--muted' : 'pd-chip--accent'), text: T(QUOTE[q.status] || q.status) }),
              accept ? btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'req-accept', 'data-pd-id': q.id, 'aria-label': tf('Accept the quotation of %s', money(q.totalMinor, q.currency, lang)) }, [h('span', { text: T('Accept') })]) : null,
            ]),
          ]));
        });
        out.push(ql);
      }
      // The club's own steps.
      var steps = [];
      if (r.status === 'QUOTED') steps.push(btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'req-decline' }, [h('span', { text: T('Decline the quotations') })]));
      if (r.status === 'SUBMITTED' || r.status === 'IN_REVIEW' || r.status === 'QUOTED') steps.push(btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'req-cancel' }, [h('span', { text: T('Cancel the request') })]));
      if (r.status === 'SHIPPED') steps.push(btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'req-delivered' }, [icon('check', 14), h('span', { text: T('Confirm delivery') })]));
      if (steps.length) out.push(h('div', { class: 'pd-team-tools', role: 'group', 'aria-label': T('Your steps') }, steps));
      if (r.status === 'ACCEPTED' || r.status === 'ORDERED' || r.status === 'IN_PRODUCTION') {
        out.push(h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: T('Nothing is charged on the platform: Familista confirms the order and its payment with the supplier, and records each step here.') })]));
      }
      // The history.
      out.push(h('h3', { class: 'pd-prop-sub', text: T('History') }));
      var hist = h('ol', { class: 'pd-req-history' });
      r.events.forEach(function (e) {
        hist.appendChild(h('li', null, [
          h('span', { class: 'pd-req-dot', 'aria-hidden': 'true' }),
          h('div', { class: 'pd-dock-text' }, [
            h('span', { class: 'pd-req-event', text: T(ACTION[e.action] || e.action) }),
            h('span', { class: 'pd-dock-kicker', text: T(ACTOR[e.actorKind] || e.actorKind) + ' · ' + shell.date(e.createdAt) }),
            e.note ? h('span', { class: 'pd-req-note', 'data-user-content': '', dir: 'auto', text: e.note }) : null,
          ]),
        ]));
      });
      out.push(hist);
      return out;
    }

    function onAction(act, t) {
      if (act.indexOf('req-') !== 0) return false;
      var c = st.cur, r = c && c.data;
      switch (act) {
        case 'req-retry': loadList(); return true;
        case 'req-open': open(t.getAttribute('data-pd-id')); return true;
        case 'req-accept': {
          var qid = t.getAttribute('data-pd-id');
          shell.confirm(T('Accept this quotation? The others are set aside. Nothing is charged: Familista confirms the order with the supplier.'), T('Accept'),
            function () { act0(function () { return api.acceptQuote(r.id, qid); }, T('Quotation accepted. Familista will confirm the order with the supplier.')); });
          return true;
        }
        case 'req-decline':
          shell.confirm(T('Decline every quotation? The request closes.'), T('Decline the quotations'),
            function () { act0(function () { return api.declineQuotes(r.id); }, T('Quotations declined.')); });
          return true;
        case 'req-cancel':
          shell.confirm(T('Cancel this request? Familista stops working on it.'), T('Cancel the request'),
            function () { act0(function () { return api.cancelRequest(r.id); }, T('Request cancelled.')); });
          return true;
        case 'req-delivered': act0(function () { return api.confirmDelivery(r.id); }, T('Delivery confirmed. Thank you.')); return true;
        default: return false;
      }
    }
    function act0(call, okText) { act(call, okText); }

    return {
      listBody: listBody, detailBody: detailBody, onAction: onAction, loadList: loadList, open: open,
      leave: function () { st.cur = null; },
      metrics: function () { return { list: st.list.state, requests: st.list.items.length, status: st.cur && st.cur.data ? st.cur.data.status : null, quotes: st.cur && st.cur.data ? st.cur.data.quotes.length : 0 }; },
    };
  }

  return Object.freeze({ create: create, money: money });
});
