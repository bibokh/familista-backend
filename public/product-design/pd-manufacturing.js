/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — the Platform Owner's manufacturing console (M4),
   owner-brokered.

   A floating panel in the platform's room (position: fixed, opacity and
   transform only), opened from the side rail's Orders and Factories &
   suppliers. Two lists:
     Requests   every club's requests for quotation: review or refuse; record
                the quotation a verified supplier gave (its reference and how it
                was received), publish or discard it, withdraw a published one;
                confirm the order, record production, shipping and delivery;
                download the production sheet and each design as frozen.
     Suppliers  the factories the Owner works with: recorded as prospects,
                verified with a note of what was checked, suspended.
   Every rule is the server's; this panel shows what it says. Nothing here
   charges, pays or contacts anyone, and no supplier is shown that the Owner
   did not record.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignManufacturing = api;
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
  var ACTOR = { CLUB: L('The club'), OWNER: L('Familista'), SUPPLIER: L('Supplier') };
  var QSTATUS = { DRAFT: L('Draft'), PUBLISHED: L('Published'), ACCEPTED: L('Accepted'), SUPERSEDED: L('Set aside'), WITHDRAWN: L('Withdrawn') };
  var SSTATUS = { PROSPECT: L('Prospect'), VERIFIED: L('Verified'), SUSPENDED: L('Suspended') };
  var FORM = { top: L('Top'), shorts: L('Shorts'), socks: L('Socks') };
  // M8a: what the Owner releases to a club: the studio, and each of its parts.
  var REL_KEYS = [['studio', L('Club Design Studio')], ['teamKit', L('Team kit: rosters, collections and the order sheet')], ['brandKit', L('Brand kit: colours and logos')],
    ['manufacturing', L('Requests for quotation and orders')], ['reviews', L('Design reviews and approvals')]];
  var REL_TO = [['on', L('On for this club')], ['default', L('As the plan says')], ['off', L('Off for this club')]];
  // M7d: how a verified supplier fits a request, from what was recorded about it.
  var FIT = { fits: L('Fits'), incomplete: L('Not everything recorded'), 'does-not-fit': L('Does not fit') };
  var METHOD = { SUBLIMATION: L('Sublimation'), SCREEN_PRINT: L('Screen print'), EMBROIDERY: L('Embroidery'), HEAT_TRANSFER: L('Heat transfer') };
  // The Owner's steps, by the status they start from: [step, label, note required].
  var STEPS = {
    SUBMITTED: [['review', L('Take into review'), false], ['refuse', L('Refuse'), true]],
    IN_REVIEW: [['refuse', L('Refuse'), true]],
    ACCEPTED: [['order', L('Confirm the order'), true]],
    ORDERED: [['produce', L('Production started'), false]],
    IN_PRODUCTION: [['ship', L('Shipped'), false]],
    SHIPPED: [['deliver', L('Delivered'), false]],
  };
  var NOTE_HINT = {
    refuse: L('Why the request is refused: the club reads it.'),
    order: L('How the order was confirmed with the supplier, and how payment is settled outside the platform.'),
    ship: L('Carrier and tracking reference, if any: the club reads it.'),
  };
  // The currencies the server accepts (src/platform/manufacturing/money.ts).
  var CURRENCIES = ['AED', 'AUD', 'BDT', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'INR', 'JPY', 'KRW', 'MAD', 'MXN', 'NOK', 'PKR', 'PLN', 'QAR', 'RON', 'SAR', 'SEK', 'TRY', 'USD'];
  var REFUSED = {
    'wrong-status': L('That step is not possible at this stage of the request.'), moved: L('The request changed meanwhile. It has been reloaded.'),
    'note-required': L('This step needs a note.'), 'supplier-not-verified': L('Only a verified supplier’s quotation can be recorded or published.'),
    'bad-currency': L('Choose a currency from the list.'), 'bad-amount': L('Enter the amount the supplier quoted.'), 'bad-lead-time': L('Lead time: whole days from 1 to 365.'),
    'bad-valid-until': L('The quotation must still be valid: today or later.'), 'bad-reference': L('Enter the supplier’s own quotation reference.'),
    'bad-evidence': L('Say how the quotation was received: at least 10 characters.'), 'note-too-short': L('Say what was checked: at least 10 characters.'),
    'bad-country': L('Country: its two-letter ISO code, such as PT.'), 'bad-website': L('Website: an https:// address.'), 'bad-email': L('Contact: an e-mail address.'),
    required: L('A name is required.'), 'same-status': L('The supplier already has that status.'),
  };

  function money(minor, currency, lang) {
    try {
      var digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency }).resolvedOptions().maximumFractionDigits;
      return new Intl.NumberFormat(lang, { style: 'currency', currency: currency }).format(minor / Math.pow(10, digits));
    } catch (_) { return currency + ' ' + minor; }
  }
  /** An amount typed by the Owner ("1234.50", "1 234,50") in the currency's minor unit, or null. Never rounded silently. */
  function toMinor(text, currency) {
    var digits;
    try { digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency }).resolvedOptions().maximumFractionDigits; } catch (_) { return null; }
    var s = String(text || '').replace(/[\s\u00a0\u202f']/g, '');
    var m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
    if (!m || (m[2] && m[2].length > digits)) return null;
    var frac = (m[2] || '').padEnd(digits, '0');
    var n = Number(m[1] + frac);
    return Number.isSafeInteger(n) && n > 0 && n <= 2000000000 ? n : null;
  }
  function region(code, lang) { try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || code; } catch (_) { return code; } }
  function day(iso, lang) { try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)); } catch (_) { return String(iso).slice(0, 10); } }

  function create(ctx) {
    var h = ctx.h, btn = ctx.btn, icon = ctx.icon, T = ctx.T, tf = ctx.tf, api = ctx.api, R = ctx.roster;
    var st = {
      open: false, trigger: null, tab: 'requests', view: 'list', note: '', busy: false, seq: 0, filter: 'open',
      requests: { state: 'idle', items: [] }, suppliers: { state: 'idle', items: [] },
      cur: null,       // the request open: { id, state, data }
      fit: null,       // M7d: how each verified supplier fits it: { id, state, data }
      rel: { state: 'idle', data: null, cur: null, busy: false }, // M8a: the clubs and what is released to each
      sup: null,       // the supplier open: { id|null, fields, version, status }
      ask: null,       // a note asked for a step: { label, hint, min, run }
      quote: null,     // the quotation form: { supplierId, currency, amount, leadTimeDays, validUntil, supplierReference, evidence }
    };
    var el = h('section', { class: 'pd-team pd-mfg', id: 'pd-mfg', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pd-mfg-title', 'data-open': 'false' });

    function say(text) { st.note = text; var n = el.querySelector('[data-pd-mfg-status]'); if (n) n.textContent = text; }
    function refusal(r, fallback) {
      if (r.reason && REFUSED[r.reason]) return T(REFUSED[r.reason]);
      return r.status === 0 ? T('The server could not be reached.') : T(fallback);
    }

    // ── loading ───────────────────────────────────────────────────────────
    function loadRequests() {
      var seq = ++st.seq;
      st.requests.state = 'loading'; render();
      api.listRequests().then(function (r) {
        if (seq !== st.seq) return;
        st.requests = r.ok && r.data ? { state: 'ready', items: r.data.requests } : { state: 'error', items: [] };
        render();
      });
    }
    function loadSuppliers(then) {
      st.suppliers.state = 'loading'; render();
      api.listSuppliers().then(function (r) {
        st.suppliers = r.ok && r.data ? { state: 'ready', items: r.data.suppliers } : { state: 'error', items: [] };
        if (then) then(); render();
      });
    }
    function openRequest(id) {
      var seq = ++st.seq;
      st.view = 'request'; st.cur = { id: id, state: 'loading' }; st.ask = null; st.quote = null; st.note = '';
      render();
      if (st.suppliers.state !== 'ready') loadSuppliers();
      api.openRequest(id).then(function (r) {
        if (seq !== st.seq) return;
        st.cur = r.ok && r.data ? { id: id, state: 'ready', data: r.data.request } : { id: id, state: 'error' };
        render();
      });
      loadFit(id);
    }
    function loadFit(id) {
      if (!api.requestFit) return;
      st.fit = { id: id, state: 'loading', data: null };
      api.requestFit(id).then(function (r) {
        if (!st.fit || st.fit.id !== id) return;
        st.fit = r.ok && r.data ? { id: id, state: 'ready', data: r.data } : { id: id, state: 'error', data: null };
        if (st.view === 'request') render();
      });
    }
    /** M7d: the verified suppliers against the request, best first; each criterion as recorded, or "not recorded". */
    function fitBlock(lang) {
      var f = st.fit, out = [h('h3', { class: 'pd-prop-sub', id: 'pd-mfg-fit-h', text: T('Supplier fit') })];
      if (!f || f.state === 'loading') { out.push(h('p', { class: 'pd-dock-row is-skeleton', 'aria-busy': 'true' }, [h('span', { class: 'pd-dock-bar' })])); return out; }
      if (f.state === 'error') { out.push(h('p', { class: 'pd-note pd-note--warn', text: T('The supplier fit could not be worked out.') })); return out; }
      var d = f.data;
      if (!d.suppliers.length) { out.push(h('p', { class: 'pd-empty', text: T('No verified supplier yet. Record one in Factories & suppliers and verify it.') })); return out; }
      var NR = T('Not recorded');
      var tb = h('tbody');
      d.suppliers.forEach(function (x) {
        var fo = x.fit.forms, mi = x.fit.minimum, lt = x.fit.leadTime;
        var forms = fo.met === null ? NR : fo.met ? T('Makes them all') : tf('Does not make: %s', fo.missing.map(function (m) { return T(FORM[m]); }).join(', '));
        var minimum = mi.met === null ? NR : mi.met ? tf('From %d sets: met', mi.minOrderSets) : tf('From %d sets: not met', mi.minOrderSets);
        var lead = lt.met === null ? (lt.leadTimeDays === null ? NR : tf('%d days; no date needed by', lt.leadTimeDays))
          : lt.met ? tf('Ready by %s: in time', day(lt.readyBy, lang)) : tf('Ready by %s: too late', day(lt.readyBy, lang));
        tb.appendChild(h('tr', { 'data-pd-fit': x.fit.overall, 'data-pd-supplier': x.id }, [
          h('th', { scope: 'row' }, [h('span', { 'data-user-content': '', text: x.name }), h('span', { class: 'pd-dock-kicker', text: ' · ' + region(x.country, lang) })]),
          h('td', { 'data-met': String(fo.met), text: forms }), h('td', { 'data-met': String(mi.met), text: minimum }), h('td', { 'data-met': String(lt.met), text: lead }),
          h('td', null, [h('span', { class: 'pd-chip pd-fit-chip', 'data-fit': x.fit.overall, text: T(FIT[x.fit.overall]) })]),
          h('td', { class: 'pd-team-acts' }, [st.cur && st.cur.data && (st.cur.data.status === 'IN_REVIEW' || st.cur.data.status === 'QUOTED')
            ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-quote-from', 'data-pd-id': x.id, 'aria-label': tf('Record a quotation from %s', x.name) }, [h('span', { text: T('Record a quotation') })]) : null]),
        ]));
      });
      var table = h('table', { class: 'pd-team-table pd-col-sheet pd-fit-table', 'aria-labelledby': 'pd-mfg-fit-h' }, [h('thead', null, [h('tr', null, [
        h('th', { scope: 'col', text: T('Supplier') }), h('th', { scope: 'col', text: T('Garments') }), h('th', { scope: 'col', text: T('Minimum order') }), h('th', { scope: 'col', text: T('Lead time') }),
        h('th', { scope: 'col', text: T('Fit') }), h('th', { scope: 'col' }, [h('span', { class: 'pd-sr', text: T('Actions') })]),
      ])]), tb]);
      out.push(h('div', { class: 'pd-team-scroll pd-col-sheet-wrap', role: 'region', 'aria-labelledby': 'pd-mfg-fit-h', tabindex: '0' }, [table]));
      out.push(h('p', { class: 'pd-note', text: tf('From what was recorded about each verified supplier, against %d sets of this request, today. Decoration methods are not compared: a request does not name one.', d.sets) }));
      return out;
    }
    function landed(r, okText, fallback) {
      st.busy = false;
      if (r.ok && r.data && r.data.request) { st.cur = { id: r.data.request.id, state: 'ready', data: r.data.request }; st.ask = null; st.quote = null; say(okText); }
      else { say(refusal(r, fallback)); if (r.code === 'REQUEST_STEP_REFUSED' && r.reason === 'moved' && st.cur) { openRequest(st.cur.id); return; } }
      render();
    }
    function run(call, okText, fallback) {
      if (st.busy) return;
      st.busy = true; say(T('Sending…'));
      call().then(function (r) { landed(r, okText, fallback); });
    }

    // ── open, close ───────────────────────────────────────────────────────
    function open(tab, trigger) {
      if (tab && tab !== st.tab) { st.tab = tab; st.view = 'list'; }
      st.open = true; st.trigger = trigger || null;
      el.setAttribute('data-open', 'true');
      if (st.tab === 'requests' && st.requests.state !== 'ready') loadRequests();
      if (st.tab === 'suppliers' && st.suppliers.state !== 'ready') loadSuppliers();
      if (st.tab === 'releases' && st.rel.state !== 'ready') loadReleases();
      render();
      ctx.onToggle(true);
      var first = el.querySelector('[role="tab"][aria-selected="true"]') || el.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    }
    function close() {
      if (!st.open) return;
      st.open = false; el.setAttribute('data-open', 'false'); ctx.onToggle(false);
      var back = st.trigger && ctx.host.contains(st.trigger) ? st.trigger : null;
      st.trigger = null;
      if (back) back.focus({ preventScroll: true });
    }

    // ── files: the production sheet, a design as frozen ────────────────────
    function download(text, name, type) {
      var url = URL.createObjectURL(new Blob([text], { type: type }));
      var a = h('a', { href: url, download: name });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      ctx.say(tf('Exported %s.', name));
    }
    function productionSheet() {
      var r = st.cur.data, spec = r.spec;
      download(R.toCsv(spec.entries, { delimiter: ',' }), R.csvFileName(r.club.name + ' ' + spec.collection.name + ' production sheet'), 'text/csv;charset=utf-8');
    }
    function designFile(projectId) {
      var r = st.cur.data;
      api.specDesign(r.id, projectId).then(function (x) {
        if (!x.ok || !x.data) { say(T('The design could not be read.')); return; }
        var d = x.data.design, g = r.spec.garments.filter(function (y) { return y.projectId === projectId; })[0];
        download(JSON.stringify(d.document, null, 2), R.csvFileName((g ? g.name : 'design') + ' v' + d.revision).replace(/\.csv$/, '.json'), 'application/json');
      });
    }

    // ── drawing ───────────────────────────────────────────────────────────
    function chip(text, active) { return h('span', { class: 'pd-chip ' + (active ? 'pd-chip--accent' : 'pd-chip--muted'), text: text }); }
    function render() {
      var keep = el.querySelector('.pd-team-body'), scroll = keep ? keep.scrollTop : 0;
      var active = document.activeElement && el.contains(document.activeElement) ? document.activeElement.getAttribute('data-pd-mfg-key') : null;
      while (el.firstChild) el.removeChild(el.firstChild);
      var detail = st.view !== 'list';
      var head = h('div', { class: 'pd-dock-head pd-team-head' }, [
        detail ? btn({ class: 'pd-btn pd-btn--ghost pd-team-back', 'data-pd-act': 'mfg-back', 'data-pd-mfg-key': 'back' },
          [ctx.dirArrow('←'), h('span', { text: st.tab === 'suppliers' ? T('Suppliers') : st.tab === 'releases' ? T('Club releases') : T('Requests') })]) : null,
        h('h2', { class: 'pd-h2', id: 'pd-mfg-title' }, [icon('factory', 16), h('span', { text: st.view === 'request' ? T('Request for quotation') : st.view === 'supplier' ? T('Supplier') : st.view === 'club' ? T('Club release') : T('Manufacturing') })]),
        btn({ class: 'pd-icbtn', 'data-pd-act': 'mfg-close', 'data-pd-mfg-key': 'close', 'aria-label': T('Close') }, [icon('close')]),
      ]);
      var kids = [askBlock()];
      if (st.view === 'request') kids = kids.concat(requestBody());
      else if (st.view === 'supplier') kids = kids.concat(supplierBody());
      else if (st.view === 'club') kids = kids.concat(clubBody());
      else kids = kids.concat([tabs()], st.tab === 'suppliers' ? suppliersList() : st.tab === 'releases' ? releasesList() : requestsList());
      var body = h('div', { class: 'pd-dock-body pd-team-body', tabindex: '0' }, kids);
      el.appendChild(head); el.appendChild(body);
      el.appendChild(h('p', { class: 'pd-note pd-team-status', role: 'status', 'aria-live': 'polite', 'data-pd-mfg-status': '', text: st.note }));
      body.scrollTop = scroll;
      if (active) { var back = el.querySelector('[data-pd-mfg-key="' + active + '"]'); if (back) back.focus({ preventScroll: true }); }
    }
    function tabs() {
      return h('div', { class: 'pd-tabs pd-team-tabs', role: 'tablist', 'aria-label': T('Manufacturing') }, [['requests', L('Requests')], ['suppliers', L('Suppliers')]].concat(ctx.rollout ? [['releases', L('Club releases')]] : []).map(function (t) {
        return btn({ class: 'pd-tab', role: 'tab', 'data-pd-act': 'mfg-tab-' + t[0], 'data-pd-mfg-key': 'tab-' + t[0], 'aria-selected': st.tab === t[0] ? 'true' : 'false', tabindex: st.tab === t[0] ? '0' : '-1', text: T(t[1]) });
      }));
    }
    // ── M8a: club releases ────────────────────────────────────────────────
    function loadReleases() {
      if (!ctx.rollout) return;
      st.rel.state = 'loading'; render();
      ctx.rollout.rollout().then(function (r) {
        st.rel.state = r.ok && r.data ? 'ready' : 'error'; st.rel.data = r.ok ? r.data : null;
        render();
      });
    }
    function relClub(id) { return st.rel.data ? st.rel.data.clubs.filter(function (c) { return c.id === id; })[0] : null; }
    function included(on) { return h('span', { class: 'pd-chip pd-rel-chip', 'data-included': on ? 'true' : 'false', text: on ? T('Included') : T('Not included') }); }
    function releasesList() {
      var Rl = st.rel, out = [h('p', { class: 'pd-note', text: T('The Club Design Studio is off for every club until you release it here. Its parts follow it: each is on where the studio is, unless the club’s plan or your choice here says otherwise.') })];
      if (Rl.state === 'loading' || Rl.state === 'idle') { out.push(h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, [0, 1, 2].map(function () { return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' })]); }))); return out; }
      if (Rl.state === 'error') { out.push(h('div', { class: 'pd-dock-state', role: 'alert' }, [h('p', { class: 'pd-empty', text: T('The clubs could not be loaded.') }), btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-rel-retry', 'data-pd-mfg-key': 'rel-retry' }, [h('span', { text: T('Try again') })])])); return out; }
      if (!Rl.data.clubs.length) { out.push(h('p', { class: 'pd-empty', text: T('No club on the platform yet.') })); return out; }
      var ul = h('ul', { class: 'pd-dock-list', role: 'list' });
      Rl.data.clubs.forEach(function (c) {
        ul.appendChild(h('li', { class: 'pd-dock-row', 'data-pd-rel-club': c.id }, [
          h('div', { class: 'pd-dock-text' }, [
            h('span', { class: 'pd-dock-name', 'data-user-content': '', text: c.name }),
            h('span', { class: 'pd-dock-kicker' }, [T('Plan'), ' ', h('bdi', { 'data-user-content': '', text: c.plan }), ' · ', c.effective.studio ? T('Studio released') : T('Studio not released')]),
          ]),
          h('div', { class: 'pd-dock-btns' }, [btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'mfg-rel-open', 'data-pd-id': c.id, 'data-pd-mfg-key': 'rel-' + c.id, 'aria-label': tf('Manage %s', c.name) }, [h('span', { text: T('Manage') })])]),
        ]));
      });
      out.push(ul);
      if (Rl.data.truncated) out.push(h('p', { class: 'pd-note', text: tf('The first %d clubs, by name.', Rl.data.limit) }));
      return out;
    }
    function clubBody() {
      var c = relClub(st.rel.cur);
      if (!c) return [h('p', { class: 'pd-empty', text: T('This club is no longer on the platform.') })];
      var out = [h('div', { class: 'pd-dock-current' }, [h('div', { class: 'pd-dock-text' }, [
        h('span', { class: 'pd-dock-kicker', text: T('Club') }), h('strong', { class: 'pd-dock-name', 'data-user-content': '', text: c.name }),
        h('span', { class: 'pd-dock-kicker' }, [T('Plan'), ' ', h('bdi', { 'data-user-content': '', text: c.plan })]),
      ])])];
      REL_KEYS.forEach(function (k, i) {
        var gid = 'pd-rel-' + k[0];
        var group = h('div', { class: 'pd-rel-opts', role: 'radiogroup', 'aria-labelledby': gid });
        REL_TO.forEach(function (o) {
          var r = h('input', { type: 'radio', name: gid, value: o[0], 'data-pd-rel-key': k[0], 'data-pd-mfg-key': 'rel-' + k[0] + '-' + o[0], 'aria-disabled': st.rel.busy ? 'true' : null });
          r.checked = c.settings[k[0]] === o[0];
          group.appendChild(h('label', { class: 'pd-rel-opt' }, [r, h('span', { text: T(o[1]) })]));
        });
        out.push(h('section', { class: 'pd-rel-row' + (i ? ' is-part' : ''), 'data-pd-rel': k[0] }, [
          h('div', { class: 'pd-rel-head' }, [h('h3', { class: 'pd-dock-h', id: gid, text: T(k[1]) }), included(c.effective[k[0]])]),
          group,
        ]));
        if (!i && !c.effective.studio) out.push(h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: T('The studio is not released to this club, so none of its parts is included, whatever they are set to.') })]));
      });
      out.push(h('p', { class: 'pd-note', text: T('Each change applies at once and is recorded in the platform audit log with the club.') }));
      return out;
    }
    function setRelease(key, to) {
      var c = relClub(st.rel.cur);
      if (!c || st.rel.busy || c.settings[key] === to) return;
      var change = {}; change[key] = to;
      st.rel.busy = true; say(T('Sending…'));
      ctx.rollout.setRollout(c.id, change).then(function (r) {
        st.rel.busy = false;
        if (r.ok && r.data && r.data.club) { c.settings = r.data.club.settings; c.effective = r.data.club.effective; say(T('Saved. The club sees the change the next time it opens the studio.')); }
        else say(r.status === 404 ? T('This club is no longer on the platform.') : T('The change was not saved.'));
        render();
      });
    }
    function askBlock() {
      if (!st.ask) return null;
      var ta = h('textarea', { class: 'pd-input', rows: '3', maxlength: '1000', 'data-pd-mfg-note': '', 'data-pd-mfg-key': 'ask-note', dir: 'auto', 'aria-label': st.ask.label });
      ta.value = st.ask.value || '';
      return h('div', { class: 'pd-dock-alert', role: 'group', 'aria-label': st.ask.label }, [
        h('p', { class: 'pd-note', text: st.ask.hint || st.ask.label }), ta,
        h('div', { class: 'pd-dock-btns' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-ask-cancel', 'data-pd-mfg-key': 'ask-cancel' }, [h('span', { text: T('Cancel') })]),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'mfg-ask-go', 'data-pd-mfg-key': 'ask-go' }, [h('span', { text: st.ask.label })]),
        ]),
      ]);
    }
    function skeleton(n) { return h('ul', { class: 'pd-dock-list', 'aria-busy': 'true' }, Array.from({ length: n }, function () { return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]); })); }
    function requestsList() {
      var Rq = st.requests, out = [];
      var filter = h('div', { class: 'pd-tabs', role: 'group', 'aria-label': T('Requests') }, [
        btn({ class: 'pd-tab', 'data-pd-act': 'mfg-filter-open', 'data-pd-mfg-key': 'f-open', 'aria-pressed': st.filter === 'open' ? 'true' : 'false', text: T('Open') }),
        btn({ class: 'pd-tab', 'data-pd-act': 'mfg-filter-all', 'data-pd-mfg-key': 'f-all', 'aria-pressed': st.filter === 'all' ? 'true' : 'false', text: T('All') }),
      ]);
      out.push(h('div', { class: 'pd-dock-bar-row' }, [filter]));
      if (Rq.state !== 'ready') { out.push(Rq.state === 'error' ? h('p', { class: 'pd-note pd-note--warn', text: T('The requests could not be loaded.') }) : skeleton(3)); return out; }
      var items = Rq.items.filter(function (r) { return st.filter === 'all' || !FINAL[r.status]; });
      if (!items.length) { out.push(h('p', { class: 'pd-empty', text: st.filter === 'open' ? T('No open requests. A club’s request for quotation appears here when it is sent.') : T('No requests yet.') })); return out; }
      var list = h('ul', { class: 'pd-dock-list', role: 'list' });
      items.forEach(function (r) {
        list.appendChild(h('li', { class: 'pd-dock-row' }, [
          h('div', { class: 'pd-dock-text' }, [
            h('span', { class: 'pd-dock-name' }, [h('span', { 'data-user-content': '', text: r.club.name }), ' · ', h('span', { 'data-user-content': '', text: r.collection.name })]),
            h('span', { class: 'pd-dock-kicker', text: tf('Sets: %d · updated %s', r.sets, ctx.date(r.updatedAt)) }),
          ]),
          h('div', { class: 'pd-dock-btns' }, [chip(T(STATUS[r.status]), !FINAL[r.status]),
            btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'mfg-open-request', 'data-pd-id': r.id, 'aria-label': tf('Open the request of %s', r.club.name) }, [h('span', { text: T('Open') })])]),
        ]));
      });
      out.push(list);
      return out;
    }
    function requestBody() {
      var c = st.cur, lang = ctx.lang();
      if (!c || c.state === 'loading') return [skeleton(4)];
      if (c.state === 'error') return [h('p', { class: 'pd-note pd-note--warn', text: T('The request could not be opened.') })];
      var r = c.data, spec = r.spec, out = [];
      out.push(h('div', { class: 'pd-req-head' }, [
        h('div', { class: 'pd-dock-text' }, [
          h('span', { class: 'pd-dock-name' }, [h('span', { 'data-user-content': '', text: r.club.name }), ' · ', h('span', { 'data-user-content': '', text: spec.collection.name + (spec.collection.season ? ' · ' + spec.collection.season : '') })]),
          h('span', { class: 'pd-dock-kicker' }, [T('For the roster'), ' ', h('span', { 'data-user-content': '', text: spec.roster.name }), ' · ', tf('sets %d', spec.sets),
            r.neededBy ? ' · ' + tf('needed by %s', day(r.neededBy, lang)) : '']),
        ]),
        chip(T(STATUS[r.status]), !FINAL[r.status]),
      ]));
      if (r.clubNote) out.push(h('p', { class: 'pd-note pd-req-note', 'data-user-content': '', dir: 'auto', text: r.clubNote }));
      var steps = (STEPS[r.status] || []).map(function (s) {
        return btn({ class: 'pd-btn ' + (s[0] === 'refuse' ? 'pd-btn--ghost' : 'pd-btn--primary'), 'data-pd-act': 'mfg-step', 'data-pd-step': s[0], 'data-pd-mfg-key': 'step-' + s[0] }, [h('span', { text: T(s[1]) })]);
      });
      if (steps.length) out.push(h('div', { class: 'pd-team-tools', role: 'group', 'aria-label': T('Next steps') }, steps));
      // The specification, as frozen.
      var g = h('table', { class: 'pd-team-table pd-col-sheet' }, [h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: T('Design') }), h('th', { scope: 'col', text: T('Garment') }), h('th', { scope: 'col', text: T('Sizes and sets') }), h('th', { scope: 'col' }, [h('span', { class: 'pd-sr', text: T('Actions') })])])])]);
      var gb = h('tbody');
      spec.garments.forEach(function (x) {
        var cell = h('td');
        x.sizes.forEach(function (y, i) { if (i) cell.appendChild(document.createTextNode(' · ')); cell.appendChild(h('bdi', { dir: 'ltr', text: y.size + ' × ' + y.sets })); });
        // M7b: whether a club administrator approved the version asked for, as the club recorded it.
        gb.appendChild(h('tr', null, [h('th', { scope: 'row' }, [h('span', { 'data-user-content': '', text: x.name }), h('span', { class: 'pd-dock-kicker', text: ' · ' + tf('version %d', x.revision) }),
          ctx.approvalChip ? h('span', { class: 'pd-rv-cell', title: T('The club’s review of this version') }, [ctx.approvalChip(x.approval)]) : null]),
          h('td', { text: T(FORM[x.form]) }), cell,
          h('td', { class: 'pd-team-acts' }, [btn({ class: 'pd-icbtn', 'data-pd-act': 'mfg-design', 'data-pd-id': x.projectId, 'aria-label': tf('Download %s as submitted', x.name), title: T('Download the design as submitted') }, [icon('export', 14)])])]));
      });
      g.appendChild(gb);
      out.push(h('div', { class: 'pd-team-scroll pd-col-sheet-wrap', role: 'region', 'aria-label': T('Designs'), tabindex: '0' }, [g]));
      out.push(h('div', { class: 'pd-team-tools' }, [
        btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-sheet', 'data-pd-mfg-key': 'sheet' }, [icon('export', 14), h('span', { text: tf('Export the production sheet (%d entries)', spec.entries.length) })]),
      ]));
      out.push(h('p', { class: 'pd-note', text: T('The production sheet holds people’s names: share it only with the supplier making this order.') }));
      // M7d: while it is being sourced, how each verified supplier fits it.
      if (r.status === 'SUBMITTED' || r.status === 'IN_REVIEW' || r.status === 'QUOTED') out = out.concat(fitBlock(lang));
      // Quotations.
      out.push(h('h3', { class: 'pd-prop-sub', text: T('Quotations') }));
      if (!r.quotes.length) out.push(h('p', { class: 'pd-empty', text: T('No quotation recorded yet. Record one a verified supplier gave you.') }));
      else {
        var ql = h('ul', { class: 'pd-dock-list pd-req-quotes', role: 'list' });
        r.quotes.forEach(function (q) {
          var acts = [chip(T(QSTATUS[q.status]), q.status === 'PUBLISHED' || q.status === 'ACCEPTED')];
          if (q.status === 'DRAFT') {
            acts.push(btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'mfg-publish', 'data-pd-id': q.id }, [h('span', { text: T('Publish to the club') })]));
            acts.push(btn({ class: 'pd-icbtn', 'data-pd-act': 'mfg-discard', 'data-pd-id': q.id, 'aria-label': T('Discard the draft'), title: T('Discard the draft') }, [icon('trash', 14)]));
          }
          if (q.status === 'PUBLISHED' && r.status === 'QUOTED') acts.push(btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-withdraw', 'data-pd-id': q.id }, [h('span', { text: T('Withdraw') })]));
          ql.appendChild(h('li', { class: 'pd-dock-row pd-req-quote' }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-req-amount', text: money(q.totalMinor, q.currency, lang) }),
              h('span', { class: 'pd-dock-kicker' }, [h('span', { 'data-user-content': '', text: q.supplier.name }), ' · ' + region(q.supplier.country, lang) + ' · ' + tf('ref. %s', q.supplierReference)]),
              h('span', { class: 'pd-dock-kicker', text: tf('Made in %d days · valid until %s', q.leadTimeDays, day(q.validUntil, lang)) }),
              h('span', { class: 'pd-req-note', 'data-user-content': '', dir: 'auto', text: q.evidence }),
            ]),
            h('div', { class: 'pd-dock-btns' }, acts),
          ]));
        });
        out.push(ql);
      }
      if (r.status === 'IN_REVIEW' || r.status === 'QUOTED') out.push(st.quote ? quoteForm() : btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'mfg-quote-new', 'data-pd-mfg-key': 'quote-new' }, [icon('plus', 14), h('span', { text: T('Record a quotation') })]));
      // History.
      out.push(h('h3', { class: 'pd-prop-sub', text: T('History') }));
      var hist = h('ol', { class: 'pd-req-history' });
      r.events.forEach(function (e) {
        hist.appendChild(h('li', null, [h('span', { class: 'pd-req-dot', 'aria-hidden': 'true' }), h('div', { class: 'pd-dock-text' }, [
          h('span', { class: 'pd-req-event', text: T(ACTION[e.action] || e.action) }),
          h('span', { class: 'pd-dock-kicker', text: T(ACTOR[e.actorKind] || e.actorKind) + ' · ' + ctx.date(e.createdAt) }),
          e.note ? h('span', { class: 'pd-req-note', 'data-user-content': '', dir: 'auto', text: e.note }) : null,
        ])]));
      });
      out.push(hist);
      return out;
    }
    function field(label, input) { return h('label', { class: 'pd-team-field' }, [h('span', { class: 'pd-dock-kicker', text: label }), input]); }
    function input(attrs, value) { var i = h('input', attrs); i.value = value == null ? '' : String(value); return i; }
    function quoteForm() {
      var q = st.quote, verified = st.suppliers.items.filter(function (s) { return s.status === 'VERIFIED'; });
      var sup = h('select', { class: 'pd-input', 'data-pd-mfg-q': 'supplierId', 'data-pd-mfg-key': 'q-supplier', 'aria-label': T('Supplier') },
        [h('option', { value: '', text: verified.length ? T('Choose a verified supplier') : T('No verified supplier yet') })].concat(verified.map(function (s) { return h('option', { value: s.id, 'data-user-content': '', text: s.name }); })));
      sup.value = q.supplierId;
      var cur = h('select', { class: 'pd-input', 'data-pd-mfg-q': 'currency', 'data-pd-mfg-key': 'q-currency', 'aria-label': T('Currency') }, CURRENCIES.map(function (c) { return h('option', { value: c, text: c }); }));
      cur.value = q.currency;
      var min = new Date().toISOString().slice(0, 10);
      var evidence = h('textarea', { class: 'pd-input', rows: '2', maxlength: '500', 'data-pd-mfg-q': 'evidence', 'data-pd-mfg-key': 'q-evidence', dir: 'auto', 'aria-label': T('How it was received') });
      evidence.value = q.evidence;
      return h('div', { class: 'pd-dock-alert pd-mfg-quote', role: 'group', 'aria-label': T('Record a quotation') }, [
        h('p', { class: 'pd-note', text: T('Record exactly what a verified supplier quoted. It stays a draft, seen by you alone, until you publish it to the club.') }),
        h('div', { class: 'pd-col-fields' }, [
          field(T('Supplier'), sup), field(T('Currency'), cur),
          field(T('Total quoted'), input({ class: 'pd-input', type: 'text', inputmode: 'decimal', placeholder: '1234.50', 'data-pd-mfg-q': 'amount', 'data-pd-mfg-key': 'q-amount', 'aria-label': T('Total quoted') }, q.amount)),
          field(T('Lead time in days'), input({ class: 'pd-input', type: 'number', min: '1', max: '365', 'data-pd-mfg-q': 'leadTimeDays', 'data-pd-mfg-key': 'q-lead', 'aria-label': T('Lead time in days') }, q.leadTimeDays)),
          field(T('Valid until'), input({ class: 'pd-input', type: 'date', min: min, 'data-pd-mfg-q': 'validUntil', 'data-pd-mfg-key': 'q-valid', 'aria-label': T('Valid until') }, q.validUntil)),
          field(T('Supplier’s reference'), input({ class: 'pd-input', type: 'text', maxlength: '80', 'data-pd-mfg-q': 'supplierReference', 'data-pd-mfg-key': 'q-ref', 'aria-label': T('Supplier’s reference') }, q.supplierReference)),
        ]),
        field(T('How it was received'), evidence),
        h('div', { class: 'pd-dock-btns' }, [
          btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-quote-cancel', 'data-pd-mfg-key': 'q-cancel' }, [h('span', { text: T('Cancel') })]),
          btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'mfg-quote-save', 'data-pd-mfg-key': 'q-save' }, [h('span', { text: T('Record as draft') })]),
        ]),
      ]);
    }
    function suppliersList() {
      var S = st.suppliers, out = [];
      out.push(h('div', { class: 'pd-dock-bar-row' }, [h('span'), btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'mfg-supplier-new', 'data-pd-mfg-key': 'sup-new' }, [icon('plus', 14), h('span', { text: T('New supplier') })])]));
      if (S.state !== 'ready') { out.push(S.state === 'error' ? h('p', { class: 'pd-note pd-note--warn', text: T('The suppliers could not be loaded.') }) : skeleton(3)); return out; }
      if (!S.items.length) { out.push(h('p', { class: 'pd-empty', text: T('No suppliers yet. Record a factory you work with as a prospect, then verify it once you have checked it.') })); return out; }
      var list = h('ul', { class: 'pd-dock-list', role: 'list' });
      S.items.forEach(function (s) {
        list.appendChild(h('li', { class: 'pd-dock-row' }, [
          h('div', { class: 'pd-dock-text' }, [
            h('span', { class: 'pd-dock-name', 'data-user-content': '', text: s.name }),
            h('span', { class: 'pd-dock-kicker', text: [region(s.country, ctx.lang())].concat(s.forms.map(function (f) { return T(FORM[f]); }), s.methods.map(function (m) { return T(METHOD[m]); })).join(' · ') }),
          ]),
          h('div', { class: 'pd-dock-btns' }, [chip(T(SSTATUS[s.status]), s.status === 'VERIFIED'),
            btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'mfg-open-supplier', 'data-pd-id': s.id, 'aria-label': tf('Open %s', s.name) }, [h('span', { text: T('Open') })])]),
        ]));
      });
      out.push(list);
      return out;
    }
    function supplierBody() {
      var s = st.sup, f = s.fields, out = [];
      if (s.id) out.push(h('div', { class: 'pd-req-head' }, [h('span', { class: 'pd-dock-kicker', text: s.status === 'VERIFIED' && s.verificationNote ? tf('Verified: %s', s.verificationNote) : '' }), chip(T(SSTATUS[s.status]), s.status === 'VERIFIED')]));
      var checks = function (key, list, labels) {
        return h('div', { class: 'pd-mfg-checks', role: 'group', 'aria-label': key === 'forms' ? T('Garments it makes') : T('Methods it offers') }, list.map(function (v) {
          var c = h('input', { type: 'checkbox', 'data-pd-mfg-s-list': key, value: v });
          c.checked = f[key].indexOf(v) !== -1;
          return h('label', { class: 'pd-mfg-check' }, [c, h('span', { text: T(labels[v]) })]);
        }));
      };
      out.push(h('div', { class: 'pd-col-fields' }, [
        field(T('Name'), input({ class: 'pd-input', type: 'text', maxlength: '120', 'data-pd-mfg-s': 'name', 'data-pd-mfg-key': 's-name', 'data-user-content': '', dir: 'auto' }, f.name)),
        field(T('Country (ISO code)'), input({ class: 'pd-input', type: 'text', maxlength: '2', 'data-pd-mfg-s': 'country', 'data-pd-mfg-key': 's-country', autocapitalize: 'characters' }, f.country)),
        field(T('City'), input({ class: 'pd-input', type: 'text', maxlength: '80', 'data-pd-mfg-s': 'city', 'data-pd-mfg-key': 's-city', 'data-user-content': '', dir: 'auto' }, f.city)),
        field(T('Website'), input({ class: 'pd-input', type: 'url', maxlength: '200', 'data-pd-mfg-s': 'website', 'data-pd-mfg-key': 's-web', placeholder: 'https://' }, f.website)),
        field(T('Contact e-mail'), input({ class: 'pd-input', type: 'email', maxlength: '200', 'data-pd-mfg-s': 'contactEmail', 'data-pd-mfg-key': 's-email' }, f.contactEmail)),
        field(T('Lead time in days'), input({ class: 'pd-input', type: 'number', min: '1', max: '365', 'data-pd-mfg-s': 'leadTimeDays', 'data-pd-mfg-key': 's-lead' }, f.leadTimeDays)),
        field(T('Minimum order, in sets'), input({ class: 'pd-input', type: 'number', min: '1', 'data-pd-mfg-s': 'minOrderSets', 'data-pd-mfg-key': 's-moq' }, f.minOrderSets)),
      ]));
      out.push(h('h3', { class: 'pd-prop-sub', text: T('Garments it makes') }), checks('forms', ['top', 'shorts', 'socks'], FORM));
      out.push(h('h3', { class: 'pd-prop-sub', text: T('Methods it offers') }), checks('methods', ['SUBLIMATION', 'SCREEN_PRINT', 'EMBROIDERY', 'HEAT_TRANSFER'], METHOD));
      var acts = [];
      if (s.id && s.status !== 'VERIFIED') acts.push(btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': 'mfg-supplier-status', 'data-pd-status': 'VERIFIED' }, [icon('check', 14), h('span', { text: T('Verify') })]));
      if (s.id && s.status === 'VERIFIED') acts.push(btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-supplier-status', 'data-pd-status': 'SUSPENDED' }, [h('span', { text: T('Suspend') })]));
      if (s.id && s.status === 'SUSPENDED') acts.push(btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'mfg-supplier-status', 'data-pd-status': 'PROSPECT' }, [h('span', { text: T('Return to prospect') })]));
      out.push(h('div', { class: 'pd-dock-btns pd-team-save' }, [h('div', { class: 'pd-team-tools' }, acts),
        btn({ class: 'pd-btn pd-btn--primary', 'data-pd-act': 'mfg-supplier-save', 'data-pd-mfg-key': 's-save' }, [icon('save', 14), h('span', { text: s.id ? T('Save supplier') : T('Record as prospect') })])]));
      out.push(h('p', { class: 'pd-note', text: T('A supplier is a record only you see. A club sees a verified supplier’s name and country on a quotation, never its contact.') }));
      return out;
    }

    // ── events ────────────────────────────────────────────────────────────
    function supplierBodyOut() {
      var f = st.sup.fields, num = function (v) { return v === '' || v == null ? null : Number(v); };
      return { name: f.name, country: String(f.country || '').toUpperCase(), city: f.city || null, website: f.website || null, contactEmail: f.contactEmail || null,
        forms: f.forms, methods: f.methods, minOrderSets: num(f.minOrderSets), leadTimeDays: num(f.leadTimeDays) };
    }
    function saveSupplier() {
      var s = st.sup;
      if (st.busy) return;
      st.busy = true; say(T('Saving…'));
      (s.id ? api.saveSupplier(s.id, Object.assign(supplierBodyOut(), { version: s.version })) : api.createSupplier(supplierBodyOut())).then(function (r) {
        st.busy = false;
        if (r.ok && r.data && r.data.supplier) { fromSupplier(r.data.supplier); say(T('Supplier saved.')); st.suppliers.state = 'idle'; }
        else say(r.code === 'SUPPLIER_CONFLICT' ? T('The supplier changed meanwhile. Open it again.') : refusal(r, L('The supplier could not be saved.')));
        render();
      });
    }
    function fromSupplier(x) {
      st.sup = { id: x.id, version: x.version, status: x.status, verificationNote: x.verificationNote,
        fields: { name: x.name, country: x.country, city: x.city || '', website: x.website || '', contactEmail: x.contactEmail || '', forms: x.forms.slice(), methods: x.methods.slice(), minOrderSets: x.minOrderSets, leadTimeDays: x.leadTimeDays } };
    }
    function askNote(label, hint, then) { st.ask = { label: label, hint: hint, value: '', run: then }; render(); var n = el.querySelector('[data-pd-mfg-note]'); if (n) n.focus(); }
    function onAction(act, t) {
      if (act.indexOf('mfg-') !== 0) return false;
      var c = st.cur, r = c && c.data, id = t.getAttribute('data-pd-id');
      switch (act) {
        case 'mfg-close': close(); return true;
        case 'mfg-back': st.view = 'list'; st.cur = null; st.sup = null; st.ask = null; st.quote = null; st.note = ''; if (st.tab === 'requests') loadRequests(); else if (st.tab === 'releases') loadReleases(); else loadSuppliers(); return true;
        case 'mfg-tab-requests': if (st.tab !== 'requests') { st.tab = 'requests'; loadRequests(); ctx.onToggle(true); } return true;
        case 'mfg-tab-suppliers': if (st.tab !== 'suppliers') { st.tab = 'suppliers'; loadSuppliers(); ctx.onToggle(true); } return true;
        case 'mfg-tab-releases': if (st.tab !== 'releases' && ctx.rollout) { st.tab = 'releases'; loadReleases(); ctx.onToggle(true); } return true;
        case 'mfg-rel-retry': loadReleases(); return true;
        case 'mfg-rel-open': st.rel.cur = t.getAttribute('data-pd-id'); st.view = 'club'; st.note = ''; render(); { var f = el.querySelector('[data-pd-rel-key="studio"]:checked'); if (f) f.focus({ preventScroll: true }); } return true;
        case 'mfg-filter-open': st.filter = 'open'; render(); return true;
        case 'mfg-filter-all': st.filter = 'all'; render(); return true;
        case 'mfg-open-request': openRequest(id); return true;
        case 'mfg-ask-cancel': st.ask = null; render(); return true;
        case 'mfg-ask-go': { var a = st.ask, v = (el.querySelector('[data-pd-mfg-note]') || {}).value || ''; if (a) a.run(v.trim()); return true; }
        case 'mfg-step': {
          var step = t.getAttribute('data-pd-step'), def = (STEPS[r.status] || []).filter(function (s) { return s[0] === step; })[0];
          if (!def) return true;
          askNote(T(def[1]), NOTE_HINT[step] ? T(NOTE_HINT[step]) : T('A note for the club, if any.'), function (note) {
            if (def[2] && note.length < 3) { say(T('This step needs a note.')); return; }
            run(function () { return api.step(r.id, step, note); }, tf('%s: done.', T(def[1])), L('The step could not be taken.'));
          });
          return true;
        }
        case 'mfg-quote-new': case 'mfg-quote-from':
          st.quote = { supplierId: act === 'mfg-quote-from' ? t.getAttribute('data-pd-id') || '' : '', currency: 'EUR', amount: '', leadTimeDays: '', validUntil: '', supplierReference: '', evidence: '' };
          if (st.suppliers.state !== 'ready') loadSuppliers(); else render();
          return true;
        case 'mfg-quote-cancel': st.quote = null; render(); return true;
        case 'mfg-quote-save': {
          var q = st.quote, minor = toMinor(q.amount, q.currency);
          if (!q.supplierId) { say(T('Choose a verified supplier.')); return true; }
          if (minor === null) { say(T('Enter the amount the supplier quoted.')); return true; }
          run(function () {
            return api.recordQuote(r.id, { supplierId: q.supplierId, currency: q.currency, totalMinor: minor, lines: [], leadTimeDays: Number(q.leadTimeDays), validUntil: q.validUntil,
              supplierReference: q.supplierReference, evidence: q.evidence });
          }, T('Quotation recorded as a draft.'), L('The quotation could not be recorded.'));
          return true;
        }
        case 'mfg-publish': run(function () { return api.publishQuote(r.id, id); }, T('Quotation published to the club.'), L('The quotation could not be published.')); return true;
        case 'mfg-discard': run(function () { return api.discardDraft(r.id, id); }, T('Draft discarded.'), L('The draft could not be discarded.')); return true;
        case 'mfg-withdraw':
          askNote(T('Withdraw'), T('Why the quotation is withdrawn: the club reads it.'), function (note) {
            if (note.length < 3) { say(T('This step needs a note.')); return; }
            run(function () { return api.withdrawQuote(r.id, id, note); }, T('Quotation withdrawn.'), L('The quotation could not be withdrawn.'));
          });
          return true;
        case 'mfg-sheet': productionSheet(); return true;
        case 'mfg-design': designFile(id); return true;
        case 'mfg-supplier-new':
          st.view = 'supplier'; st.sup = { id: null, version: 0, status: 'PROSPECT', fields: { name: '', country: '', city: '', website: '', contactEmail: '', forms: [], methods: [], minOrderSets: null, leadTimeDays: null } };
          st.note = ''; render(); return true;
        case 'mfg-open-supplier':
          // Opened from the server, so a save names the supplier's current version.
          api.openSupplier(id).then(function (res) {
            if (res.ok && res.data && res.data.supplier) { fromSupplier(res.data.supplier); st.view = 'supplier'; st.note = ''; }
            else say(T('The suppliers could not be loaded.'));
            render();
          });
          return true;
        case 'mfg-supplier-save': saveSupplier(); return true;
        case 'mfg-supplier-status': {
          var to = t.getAttribute('data-pd-status'), sid = st.sup.id;
          var label = to === 'VERIFIED' ? T('Verify') : to === 'SUSPENDED' ? T('Suspend') : T('Return to prospect');
          askNote(label, to === 'VERIFIED' ? T('What you checked before verifying it (registration, samples, a visit): at least 10 characters.') : T('Why: a note kept in the audit history.'), function (note) {
            if (st.busy) return;
            st.busy = true; say(T('Saving…'));
            api.setSupplierStatus(sid, to, note).then(function (res) {
              st.busy = false;
              if (res.ok && res.data && res.data.supplier) { fromSupplier(res.data.supplier); st.ask = null; st.suppliers.state = 'idle'; say(tf('%s: done.', label)); }
              else say(refusal(res, L('The status could not be changed.')));
              render();
            });
          });
          return true;
        }
        default: return false;
      }
    }
    function onInput(ev) {
      var t = ev.target;
      if (!t || !el.contains(t)) return false;
      var k = t.getAttribute('data-pd-mfg-q');
      if (k && st.quote) { st.quote[k] = t.value; return true; }
      k = t.getAttribute('data-pd-mfg-s');
      if (k && st.sup) { st.sup.fields[k] = t.value; return true; }
      k = t.getAttribute('data-pd-mfg-s-list');
      if (k && st.sup) {
        var list = st.sup.fields[k], i = list.indexOf(t.value);
        if (t.checked && i === -1) list.push(t.value); else if (!t.checked && i !== -1) list.splice(i, 1);
        return true;
      }
      if (t.hasAttribute('data-pd-mfg-note') && st.ask) { st.ask.value = t.value; return true; }
      k = t.getAttribute('data-pd-rel-key');
      if (k && t.checked && ev.type === 'change') { setRelease(k, t.value); return true; }
      return true;
    }

    return {
      el: el, open: open, close: close, repaint: render,
      isOpen: function () { return st.open; },
      onAction: onAction, onInput: onInput, onChange: onInput,
      metrics: function () {
        return { open: st.open, tab: st.tab, view: st.view, requests: st.requests.items.length, suppliers: st.suppliers.items.length,
          status: st.cur && st.cur.data ? st.cur.data.status : null, quotes: st.cur && st.cur.data ? st.cur.data.quotes.length : 0,
          fit: st.fit ? st.fit.state : null, releases: st.rel.state, releaseBusy: st.rel.busy };
      },
    };
  }

  return Object.freeze({ create: create, toMinor: toMinor });
});
