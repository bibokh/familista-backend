/* ─────────────────────────────────────────────────────────────────────────────
   Familista Design Studio — plans and billing (P5, P6), in three parts.

   The Plan & billing panel, in a club's or a creator's workspace: the plan the
   workspace is on and what it includes, the plans on offer with their prices,
   the invoices, and whether online payment is available at all. A paid plan
   is asked for, never charged here: its invoice stays open until a payment
   provider reports it paid, and with none configured the panel says so.

   The Production pack, a tab of the room's dock: the professional tools a
   plan opens, made on the server from the saved version — a print sheet with
   every view, and a tech pack (CSV or JSON) with every placement in mm.

   The Platform Owner's Plans & billing console: the plans (features, limits,
   price), every workspace's subscription and invoices, a plan granted with a
   note, an open invoice voided, lapsed subscriptions marked expired.

   Every rule is the server's; this view offers what the server accepts and
   says why when it does not. The room hands it its builders, words and
   clients; nothing here fetches, stores or styles by itself. A plan's name and
   description are the Owner's words, shown as typed and never translated.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignPlan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function L(text) { return text; }
  /** The features a plan can include, in the server's order (src/platform/commercial/features.ts), and what each is. */
  var FEATURES = ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing', 'pro_export', 'manufacturing_prep'];
  var CLUB_FEATURES = ['pro_export', 'manufacturing_prep'];
  var FEATURE = {
    team_kit: L('Team kit: rosters, collections and order sheets'),
    brand_studio: L('Brand kit: colours and logos'),
    reviews: L('Reviews and approvals of versions'),
    collaboration: L('Sharing designs with other creators'),
    manufacturing: L('Quotation requests through Familista'),
    pro_export: L('Print sheet: every view of a saved version'),
    manufacturing_prep: L('Tech pack: colours and placements in millimetres'),
  };
  var REFUSED = {
    'unknown-plan': L('This plan is no longer offered.'),
    'wrong-audience': L('This plan is not offered to this workspace.'),
    'already-on-plan': L('This workspace is already on this plan.'),
    'active-paid': L('A paid plan is active: cancel it first; it runs until the end of its period.'),
    'owner-grant': L('This plan was granted by the Platform Owner: only the Owner changes it.'),
    'nothing-to-cancel': L('There is no plan to cancel.'),
    'not-open': L('This invoice is no longer open.'),
    'bad-note': L('Write a note of 5 to 300 characters: it is kept in the audit.'),
    'bad-months': L('Choose between 1 and 36 months, or no end date.'),
    'unknown-tenant': L('Choose an active club or creator account.'),
  };
  var PLAN_INVALID = {
    'bad-key': L('The key is 2 to 40 lower-case letters, digits or hyphens, starting with a letter or digit.'),
    'bad-audience': L('Choose who the plan is for.'),
    'bad-features': L('Choose only features this audience can have.'),
    'bad-price': L('A price needs its currency (three letters, such as EUR) and how often it is billed.'),
    'bad-number': L('Limits are whole numbers; leave a limit empty for none.'),
    'bad-text': L('Names and descriptions are plain text.'),
    required: L('Give the plan a name.'),
  };
  var STATUS = { PENDING: L('Waiting for payment'), ACTIVE: L('Active'), CANCELED: L('Cancelled'), EXPIRED: L('Expired') };
  var INVOICE = { OPEN: L('Open'), PAID: L('Paid'), VOID: L('Void') };

  function problem(T, r, fallback) {
    if (r.status === 0) return T('The server could not be reached.');
    if (r.code === 'SUBSCRIPTION_REFUSED' && REFUSED[r.reason]) return T(REFUSED[r.reason]);
    if (r.code === 'PLAN_INVALID' && PLAN_INVALID[r.reason]) return T(PLAN_INVALID[r.reason]);
    if (r.code === 'PAYMENTS_NOT_CONFIGURED') return T('Online payment is not set up on this platform yet, so nothing can be paid or charged here.');
    if (r.code === 'PLAN_FEATURE_REQUIRED') return T('This is not included in this workspace’s plan.');
    if (r.status === 403) return T('Only a club administrator changes the club’s plan.');
    if (r.status === 409) return T('A plan with this key already exists.');
    return T(fallback);
  }
  /** A plan's price in the room's language: ctx.money formats an amount in minor units in its own currency's digits. */
  function price(ctx, p) {
    if (p.priceMinor === null || p.priceMinor === undefined || p.priceMinor === 0) return ctx.T('Free');
    var m = ctx.money(p.priceMinor, p.currency);
    return p.interval === 'YEAR' ? ctx.tf('%s per year', m) : ctx.tf('%s per month', m);
  }
  function field(h, label, input, hint) {
    return h('label', { class: 'pd-team-field pd-plan-field' }, [h('span', { class: 'pd-gate-label', text: label }), input, hint ? h('span', { class: 'pd-note', text: hint }) : null]);
  }
  function skeleton(h, n) {
    return h('ul', { class: 'pd-dock-list', 'aria-busy': 'true', 'aria-hidden': 'true' }, Array.from({ length: n }, function () {
      return h('li', { class: 'pd-dock-row is-skeleton' }, [h('span', { class: 'pd-dock-bar' }), h('span', { class: 'pd-dock-bar is-short' })]);
    }));
  }
  /** One floating panel's frame: its head, its scrolling body, its status line; focus and scroll kept across a repaint. */
  function frame(el, h, btn, icon, T, o) {
    var keep = el.querySelector('.pd-team-body'), scroll = keep ? keep.scrollTop : 0;
    var active = document.activeElement && el.contains(document.activeElement) ? document.activeElement.getAttribute(o.keyAttr) : null;
    while (el.firstChild) el.removeChild(el.firstChild);
    var close = { class: 'pd-icbtn', 'data-pd-act': o.prefix + '-close', 'aria-label': T('Close') }; close[o.keyAttr] = 'close';
    el.appendChild(h('div', { class: 'pd-dock-head pd-team-head' }, [h('h2', { class: 'pd-h2', id: o.titleId }, [icon('card', 16), h('span', { text: T(o.title) })]), btn(close, [icon('close')])]));
    var body = h('div', { class: 'pd-dock-body pd-team-body', tabindex: '0' }, o.kids);
    el.appendChild(body);
    var status = { class: 'pd-note pd-team-status', role: 'status', 'aria-live': 'polite', text: o.note }; status[o.statusAttr] = '';
    el.appendChild(h('p', status));
    body.scrollTop = scroll;
    if (active) { var back = el.querySelector('[' + o.keyAttr + '="' + active + '"]'); if (back) back.focus({ preventScroll: true }); }
  }

  // ── the workspace's Plan & billing panel ───────────────────────────────────

  /**
   * ctx: { h, btn, icon, T, tf, api (the workspace's client), host, date(iso), money(minor, currency), audience ('CLUB' | 'CREATOR'),
   * canChange() (false for a club manager), onToggle(open), onPlanChanged(entitlements) }
   */
  function panel(ctx) {
    var h = ctx.h, btn = ctx.btn, icon = ctx.icon, T = ctx.T, tf = ctx.tf, api = ctx.api;
    var st = { open: false, trigger: null, state: 'idle', data: null, busy: false, note: '', confirm: null, changed: false, seq: 0 };
    var el = h('section', { class: 'pd-team pd-plan', id: 'pd-plan', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pd-plan-title', 'data-open': 'false' });
    var K = 'data-pd-plan-key';
    function key(k, a) { a[K] = k; return a; }
    function say(text) { st.note = text; var n = el.querySelector('[data-pd-plan-status]'); if (n) n.textContent = text; }
    function render() { frame(el, h, btn, icon, T, { prefix: 'plan', keyAttr: K, statusAttr: 'data-pd-plan-status', titleId: 'pd-plan-title', title: L('Plan & billing'), note: st.note, kids: body() }); }
    function load() {
      var seq = ++st.seq;
      st.state = 'loading'; render();
      api.plan().then(function (r) {
        if (seq !== st.seq) return;
        if (r.ok && r.data) { st.data = r.data; st.state = 'ready'; } else { st.state = 'error'; st.note = problem(T, r, L('The plan could not be read.')); }
        render();
      });
    }
    function features() { return ctx.audience === 'CLUB' ? CLUB_FEATURES : FEATURES; }
    function body() {
      if (st.state === 'loading' || st.state === 'idle') return [skeleton(h, 4)];
      if (st.state === 'error') {
        return [h('div', { class: 'pd-dock-empty' }, [h('p', { text: T('The plan could not be read.') }),
          btn(key('retry', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'plan-retry' }), [h('span', { text: T('Try again') })])])];
      }
      var d = st.data;
      return [current(d), includes(d), st.changed ? changedNote() : null, offered(d), invoices(d), payments(d), cancel(d)];
    }
    function sourceLine(e, sub) {
      if (e.source === 'built-in') return T('Included with the studio');
      if (e.source === 'default-plan') return T('The plan every new workspace starts on');
      if (sub && sub.source === 'OWNER_GRANT') return sub.currentPeriodEnd ? tf('Granted by the Platform Owner until %s', ctx.date(sub.currentPeriodEnd)) : T('Granted by the Platform Owner, with no end date');
      if (sub && sub.cancelAtPeriodEnd && sub.currentPeriodEnd) return tf('Ends on %s; it is not renewed', ctx.date(sub.currentPeriodEnd));
      if (sub && sub.currentPeriodEnd) return tf('Paid until %s', ctx.date(sub.currentPeriodEnd));
      return T('Active');
    }
    function current(d) {
      var e = d.entitlements, sub = d.subscription && (d.subscription.status === 'ACTIVE' || d.subscription.status === 'PENDING') ? d.subscription : null;
      var pending = sub && sub.status === 'PENDING' ? sub : null, live = e.source === 'subscription' ? sub : null;
      return h('div', { class: 'pd-acct-card pd-plan-current' }, [
        h('p', { class: 'pd-dock-kicker', text: T('Your plan') }),
        e.plan ? h('p', { class: 'pd-acct-name', 'data-user-content': '', dir: 'auto', text: e.plan.name }) : h('p', { class: 'pd-acct-name', text: T('The studio as it ships') }),
        h('p', { class: 'pd-note', 'data-pd-plan-source': e.source, text: sourceLine(e, live) }),
        pending ? h('p', { class: 'pd-note pd-note--warn', 'data-pd-plan-pending': '' }, [icon('info', 14), h('span', { text: tf('%s waits for its invoice to be paid. Until then this workspace keeps its current plan.', pending.plan.name) })]) : null,
      ]);
    }
    function includes(d) {
      var e = d.entitlements;
      var rows = features().map(function (f) {
        var on = e.features.indexOf(f) !== -1;
        return h('li', { class: 'pd-plan-feature', 'data-pd-feature': f, 'data-included': on ? 'true' : 'false' }, [
          icon(on ? 'check' : 'minus', 14), h('span', { text: T(FEATURE[f]) }), h('span', { class: 'pd-sr', text: on ? T('Included') : T('Not included') }),
        ]);
      });
      var lim = e.limits, limits = [['projects', L('Designs')], ['collections', L('Collections')]].concat(ctx.audience === 'CREATOR' ? [['shares', L('People a design is shared with')]] : []);
      return h('div', { class: 'pd-acct-block' }, [
        h('h3', { class: 'pd-h3', text: T('What it includes') }),
        h('ul', { class: 'pd-plan-features', role: 'list' }, rows),
        h('dl', { class: 'pd-plan-limits' }, limits.map(function (l) {
          return h('div', { class: 'pd-plan-limit' }, [h('dt', { text: T(l[1]) }), h('dd', { 'data-pd-limit': l[0], text: lim[l[0]] === null ? T('No limit') : tf('Up to %d', lim[l[0]]) })]);
        })),
      ]);
    }
    function changedNote() {
      return h('div', { class: 'pd-acct-block' }, [h('p', { class: 'pd-note pd-note--info' }, [icon('info', 14), h('span', { text: T('The plan changed. Reopen the studio to see every part it now includes.') })]),
        btn(key('reopen', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'plan-reopen' }), [h('span', { text: T('Reopen the studio') })])]);
    }
    function offered(d) {
      var mine = d.entitlements.plan ? d.entitlements.plan.key : null, pendingKey = d.subscription && d.subscription.status === 'PENDING' ? d.subscription.plan.key : null;
      var can = ctx.canChange();
      if (!d.offered.length) return h('div', { class: 'pd-acct-block' }, [h('h3', { class: 'pd-h3', text: T('Plans') }), h('p', { class: 'pd-note', text: T('No plans are offered yet. The Platform Owner configures them.') })]);
      return h('div', { class: 'pd-acct-block' }, [
        h('h3', { class: 'pd-h3', text: T('Plans') }),
        can ? null : h('p', { class: 'pd-note', text: T('Only a club administrator changes the club’s plan.') }),
        h('ul', { class: 'pd-plan-offers', role: 'list' }, d.offered.map(function (p) {
          var isMine = p.key === mine, isPending = p.key === pendingKey, c = st.confirm && st.confirm.key === p.key;
          var list = features().filter(function (f) { return p.features.indexOf(f) !== -1; });
          return h('li', { class: 'pd-plan-offer' + (isMine ? ' is-current' : ''), 'data-pd-plan': p.key }, [
            h('div', { class: 'pd-plan-offer-head' }, [h('strong', { 'data-user-content': '', dir: 'auto', text: p.name }), h('span', { class: 'pd-plan-price', text: price(ctx, p) })]),
            p.description ? h('p', { class: 'pd-note', 'data-user-content': '', dir: 'auto', text: p.description }) : null,
            h('p', { class: 'pd-note', text: list.length ? list.map(function (f) { return T(FEATURE[f]); }).join(' · ') : T('None of the features above') }),
            isMine ? h('span', { class: 'pd-chip', text: T('Current plan') }) : isPending ? h('span', { class: 'pd-chip pd-chip--muted', text: T('Waiting for payment') })
              : !can ? null : c ? confirmChoice(p) : btn(key('choose-' + p.key, { class: 'pd-btn pd-btn--outline', 'data-pd-act': 'plan-choose', 'data-pd-plan-choose': p.key, 'aria-disabled': st.busy ? 'true' : null }), [
                h('span', { text: T('Choose this plan') }), h('span', { class: 'pd-sr', 'data-user-content': '', text: ' ' + p.name })]),
          ]);
        })),
      ]);
    }
    function confirmChoice(p) {
      var paid = p.priceMinor !== null && p.priceMinor !== 0;
      return h('div', { class: 'pd-plan-confirm' }, [
        h('p', { class: 'pd-note', text: paid ? tf('An invoice of %s is issued. Nothing is charged here: the plan starts when the invoice is paid.', ctx.money(p.priceMinor, p.currency)) : T('A free plan starts at once.') }),
        h('div', { class: 'pd-team-tools' }, [
          btn(key('confirm', { class: 'pd-btn pd-btn--primary', 'data-pd-act': 'plan-confirm', 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: paid ? T('Ask for this plan') : T('Start this plan') })]),
          btn(key('keep', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'plan-keep' }), [h('span', { text: T('Keep the current plan') })]),
        ]),
      ]);
    }
    function invoices(d) {
      var can = ctx.canChange(), payOk = d.payments && d.payments.configured;
      return h('div', { class: 'pd-acct-block' }, [
        h('h3', { class: 'pd-h3', text: T('Invoices') }),
        d.invoices.length ? h('ul', { class: 'pd-dock-list pd-plan-invoices', role: 'list' }, d.invoices.map(function (inv) {
          return h('li', { class: 'pd-dock-row', 'data-pd-invoice': inv.number }, [
            h('div', { class: 'pd-dock-text' }, [
              h('span', { class: 'pd-dock-name', dir: 'ltr', text: inv.number }),
              h('span', { class: 'pd-dock-kicker' }, [h('span', { text: ctx.date(inv.issuedAt) }), h('span', { text: ' · ' }), h('span', { text: ctx.money(inv.totalMinor, inv.currency) }),
                inv.taxMinor === null ? h('span', { text: ' · ' }) : null, inv.taxMinor === null ? h('span', { text: T('Tax not calculated') }) : null]),
            ]),
            h('div', { class: 'pd-dock-btns' }, [
              h('span', { class: 'pd-chip' + (inv.status === 'OPEN' ? ' pd-chip--muted' : ''), 'data-status': inv.status, text: T(INVOICE[inv.status] || INVOICE.OPEN) }),
              inv.status === 'OPEN' && can ? btn(key('pay-' + inv.number, { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'plan-pay', 'data-pd-id': inv.id,
                'aria-disabled': !payOk || st.busy ? 'true' : null, 'data-pd-why': payOk ? null : T('Online payment is not set up on this platform yet.') }), [h('span', { text: T('Pay online') })]) : null,
            ]),
          ]);
        })) : h('p', { class: 'pd-note', text: T('No invoices. A paid plan’s invoice appears here.') }),
      ]);
    }
    function payments(d) {
      if (d.payments && d.payments.configured) return null;
      return h('p', { class: 'pd-note pd-note--info', 'data-pd-payments': 'not-configured' }, [icon('info', 14),
        h('span', { text: T('Online payment is not set up on this platform yet. Nothing is charged: a paid plan waits for its invoice to be paid, or for the Platform Owner to activate it.') })]);
    }
    function cancel(d) {
      var sub = d.subscription;
      if (!ctx.canChange() || !sub || (sub.status !== 'ACTIVE' && sub.status !== 'PENDING') || sub.source === 'OWNER_GRANT' || sub.cancelAtPeriodEnd) return null;
      var paid = sub.status === 'ACTIVE' && sub.plan.priceMinor && sub.currentPeriodEnd;
      return h('div', { class: 'pd-acct-block' }, [
        h('h3', { class: 'pd-h3', text: T('Cancel the plan') }),
        h('p', { class: 'pd-note', text: sub.status === 'PENDING' ? T('The request ends now and its open invoice is voided.') : paid ? tf('The plan runs until %s and is not renewed.', ctx.date(sub.currentPeriodEnd)) : T('The plan ends now; the workspace returns to the default plan.') }),
        st.confirm && st.confirm.cancel ? h('div', { class: 'pd-team-tools' }, [
          btn(key('cancel-confirm', { class: 'pd-btn pd-btn--outline', 'data-pd-act': 'plan-cancel-confirm', 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: T('Cancel the plan') })]),
          btn(key('keep', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'plan-keep' }), [h('span', { text: T('Keep the current plan') })]),
        ]) : btn(key('cancel', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'plan-cancel' }), [h('span', { text: T('Cancel the plan…') })]),
      ]);
    }
    function settle(r, okText) {
      st.busy = false; st.confirm = null;
      if (r.ok && r.data) {
        var before = st.data ? st.data.entitlements.features.join() : '';
        st.data = r.data; st.state = 'ready';
        if (r.data.entitlements.features.join() !== before) { st.changed = true; ctx.onPlanChanged(r.data.entitlements); }
        say(okText);
      } else say(problem(T, r, L('The plan could not be changed.')));
      render();
    }
    function open(trigger) { st.open = true; st.trigger = trigger || null; el.setAttribute('data-open', 'true'); load(); ctx.onToggle(true); var f = el.querySelector('[data-pd-act="plan-close"]'); if (f) f.focus({ preventScroll: true }); }
    function close() {
      if (!st.open) return;
      st.open = false; st.confirm = null; el.setAttribute('data-open', 'false'); ctx.onToggle(false);
      var back = st.trigger && ctx.host.contains(st.trigger) ? st.trigger : null; st.trigger = null;
      if (back) back.focus({ preventScroll: true });
    }
    function onAction(act, t) {
      if (act.indexOf('plan') !== 0) return false;
      if (act === 'plan') { if (st.open) close(); else open(t); return true; }
      if (act === 'plan-close') { close(); return true; }
      if (act === 'plan-retry') { st.note = ''; load(); return true; }
      if (act === 'plan-reopen') { ctx.reopen(); return true; }
      if (act === 'plan-keep') { st.confirm = null; say(''); render(); return true; }
      if (st.busy || t.getAttribute('aria-disabled') === 'true') {
        var why = t.getAttribute('data-pd-why'); if (why) say(why);
        return true;
      }
      if (act === 'plan-choose') { st.confirm = { key: t.getAttribute('data-pd-plan-choose') }; render(); var c = el.querySelector('[' + K + '="confirm"]'); if (c) c.focus({ preventScroll: true }); return true; }
      if (act === 'plan-cancel') { st.confirm = { cancel: true }; render(); var cc = el.querySelector('[' + K + '="cancel-confirm"]'); if (cc) cc.focus({ preventScroll: true }); return true; }
      st.busy = true; render();
      if (act === 'plan-confirm' && st.confirm && st.confirm.key) {
        api.requestPlan(st.confirm.key).then(function (r) {
          var sub = r.ok && r.data && r.data.subscription;
          settle(r, sub && sub.status === 'PENDING' ? tf('Invoice %s is open. The plan starts when it is paid.', r.data.invoices[0] ? r.data.invoices[0].number : '') : T('The plan is active.'));
        });
      } else if (act === 'plan-cancel-confirm') {
        api.cancelPlan().then(function (r) { settle(r, r.ok && r.data && r.data.subscription && r.data.subscription.cancelAtPeriodEnd ? T('The plan ends with its period.') : T('The plan is cancelled.')); });
      } else if (act === 'plan-pay') {
        api.checkout(t.getAttribute('data-pd-id')).then(function (r) {
          st.busy = false;
          // A configured provider answers with its own page; the browser goes there, and the invoice is settled by its report.
          if (r.ok && r.data && /^https:\/\//.test(r.data.url)) { ctx.go(r.data.url); return; }
          say(problem(T, r, L('The payment could not be started.'))); render();
        });
      } else { st.busy = false; render(); }
      return true;
    }
    return {
      el: el, open: open, close: close, repaint: render, isOpen: function () { return st.open; }, onAction: onAction,
      metrics: function () {
        var d = st.data;
        return { open: st.open, state: st.state, busy: st.busy, note: st.note, changed: st.changed, source: d ? d.entitlements.source : null, plan: d && d.entitlements.plan ? d.entitlements.plan.key : null,
          features: d ? d.entitlements.features.slice() : null, subscription: d && d.subscription ? d.subscription.status : null, invoices: d ? d.invoices.map(function (i) { return i.status; }) : null,
          payments: d ? !!(d.payments && d.payments.configured) : null };
      },
    };
  }

  // ── the Production pack, a tab of the room's dock ──────────────────────────

  /**
   * ctx: { h, btn, icon, T, tf, api, say, link() ({ projectId, revision } of the saved design, or null), unsaved(),
   * features() (the workspace's plan features), sheet(exported) (the print sheet's SVG text, or null), download(blob, name),
   * fileName(name, revision, ext), render(), openPlan(trigger) }
   */
  function production(ctx) {
    var h = ctx.h, btn = ctx.btn, icon = ctx.icon, T = ctx.T, tf = ctx.tf;
    var st = { busy: null, done: null };
    function has(f) { var list = ctx.features(); return !!list && list.indexOf(f) !== -1; }
    function tool(o) {
      var on = has(o.feature);
      return h('div', { class: 'pd-acct-block pd-pp-tool', 'data-pd-tool': o.feature, 'data-included': on ? 'true' : 'false' }, [
        h('h3', { class: 'pd-h3' }, [icon(o.icon, 14), h('span', { text: T(o.title) })]),
        h('p', { class: 'pd-note', text: T(o.text) }),
        on ? h('div', { class: 'pd-team-tools' }, o.actions.map(function (a) {
          return btn({ class: 'pd-btn pd-btn--outline', 'data-pd-act': a[0], 'aria-disabled': st.busy ? 'true' : null }, [icon('export', 14), h('span', { text: T(a[1]) })]);
        })) : h('span', { class: 'pd-chip pd-chip--muted', text: T('Not in this workspace’s plan') }),
      ]);
    }
    function body() {
      var link = ctx.link();
      if (!link) return [h('div', { class: 'pd-dock-empty' }, [icon('versions', 20), h('p', { text: T('Save the design first: the production pack is made from a saved version.') })])];
      var locked = !has('pro_export') || !has('manufacturing_prep');
      return [
        h('p', { class: 'pd-note', text: ctx.unsaved() ? tf('Made from version %d, as saved. Changes since are not in it: save first to include them.', link.revision) : tf('Made from version %d, as saved.', link.revision) }),
        tool({ feature: 'pro_export', icon: 'eye', title: L('Print sheet'), text: L('Every view of the saved version on one sheet, an SVG file to print or send. Each export is recorded.'), actions: [['pp-sheet', L('Download the print sheet')]] }),
        tool({ feature: 'manufacturing_prep', icon: 'box', title: L('Tech pack'), text: L('The version’s colours, fonts and every placement in millimetres, for a maker: CSV for a spreadsheet, JSON for software.'), actions: [['pp-csv', L('Download CSV')], ['pp-json', L('Download JSON')]] }),
        locked ? h('div', { class: 'pd-acct-block' }, [h('p', { class: 'pd-note', text: T('These tools come with a plan that includes them.') }),
          ctx.openPlan ? btn({ class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'pp-plans' }, [icon('card', 14), h('span', { text: T('See the plans') })]) : null]) : null,
      ];
    }
    function finish(text) { st.busy = null; ctx.say(text); ctx.render(); }
    function onAction(act, t) {
      if (act.indexOf('pp-') !== 0) return false;
      if (act === 'pp-plans') { if (ctx.openPlan) ctx.openPlan(t); return true; }
      var link = ctx.link();
      if (!link || st.busy) return true;
      st.busy = act; ctx.render();
      if (act === 'pp-sheet') {
        ctx.api.proExport(link.projectId).then(function (r) {
          if (!r.ok || !r.data) { finish(problem(T, r, L('The print sheet could not be made.'))); return; }
          ctx.sheet(r.data.export).then(function (svg) {
            if (!svg) { finish(T('The print sheet could not be made.')); return; }
            ctx.download(new Blob([svg], { type: 'image/svg+xml' }), ctx.fileName(r.data.export.name, r.data.export.revision, 'svg'));
            finish(tf('The print sheet of version %d is downloaded.', r.data.export.revision));
          });
        });
      } else if (act === 'pp-csv' || act === 'pp-json') {
        var csv = act === 'pp-csv';
        ctx.api.techPack(link.projectId, csv ? 'csv' : 'json').then(function (r) {
          if (!r.ok || (csv ? !r.blob : !r.data)) { finish(problem(T, r, L('The tech pack could not be made.'))); return; }
          var blob = csv ? r.blob : new Blob([JSON.stringify(r.data.techPack, null, 2)], { type: 'application/json' });
          var rev = csv ? link.revision : r.data.techPack.design.revision;
          ctx.download(blob, ctx.fileName(csv ? ctx.name() : r.data.techPack.design.name, rev, csv ? 'csv' : 'json'));
          finish(tf('The tech pack of version %d is downloaded.', rev));
        });
      } else { st.busy = null; ctx.render(); }
      return true;
    }
    return { body: body, onAction: onAction, metrics: function () { return { busy: st.busy, proExport: has('pro_export'), mfgPrep: has('manufacturing_prep') }; } };
  }

  // ── the Platform Owner's Plans & billing console ───────────────────────────

  function emptyPlan() {
    return { id: null, key: '', audience: 'CREATOR', name: '', description: '', features: [], maxProjects: '', maxCollections: '', maxShares: '', price: '', currency: 'EUR', interval: 'MONTH', isDefault: false, active: true, sortOrder: '0' };
  }
  function formOf(p, digits) {
    var d = p.currency ? digits(p.currency) : 2;
    return { id: p.id, key: p.key, audience: p.audience, name: p.name, description: p.description || '', features: p.features.slice(),
      maxProjects: p.maxProjects === null ? '' : String(p.maxProjects), maxCollections: p.maxCollections === null ? '' : String(p.maxCollections), maxShares: p.maxShares === null ? '' : String(p.maxShares),
      price: p.priceMinor === null ? '' : (p.priceMinor / Math.pow(10, d)).toFixed(d), currency: p.currency || 'EUR', interval: p.interval || 'MONTH',
      isDefault: p.isDefault, active: p.active, sortOrder: String(p.sortOrder) };
  }
  /** The form as the server takes it; a price typed in major units becomes minor units in the currency's own digits. */
  function bodyOf(f, creating, digits) {
    var n = function (v) { var s = String(v).trim(); return s === '' ? null : /^\d+$/.test(s) ? Number(s) : NaN; };
    var cur = String(f.currency || '').trim().toUpperCase(), ps = String(f.price).trim().replace(',', '.');
    var minor = ps === '' ? null : /^\d+(\.\d+)?$/.test(ps) ? Math.round(Number(ps) * Math.pow(10, digits(cur))) : NaN;
    var b = { name: f.name, description: f.description || null, features: f.features.slice(), maxProjects: n(f.maxProjects), maxCollections: n(f.maxCollections),
      maxShares: f.audience === 'CREATOR' ? n(f.maxShares) : null, priceMinor: minor, currency: minor === null ? null : cur, interval: minor === null ? null : f.interval,
      isDefault: f.isDefault === true, active: f.active !== false, sortOrder: n(f.sortOrder) === null ? 0 : n(f.sortOrder) };
    if (creating) { b.key = f.key; b.audience = f.audience; }
    return b;
  }

  /**
   * ctx: { h, btn, icon, T, tf, api (the platform's client), host, date(iso), money(minor, currency), digits(currency), onToggle(open) }
   */
  function console_(ctx) {
    var h = ctx.h, btn = ctx.btn, icon = ctx.icon, T = ctx.T, tf = ctx.tf, api = ctx.api;
    var st = { open: false, trigger: null, tab: 'plans', state: 'idle', plans: null, billing: null, tenants: null, form: null, grant: null, ending: null, endNote: '', expire: null, busy: false, note: '', seq: 0 };
    var el = h('section', { class: 'pd-team pd-billing', id: 'pd-billing', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pd-billing-title', 'data-open': 'false' });
    var K = 'data-pd-bl-key';
    function key(k, a) { a[K] = k; return a; }
    function say(text) { st.note = text; var n = el.querySelector('[data-pd-bl-status]'); if (n) n.textContent = text; }
    function render() { frame(el, h, btn, icon, T, { prefix: 'bl', keyAttr: K, statusAttr: 'data-pd-bl-status', titleId: 'pd-billing-title', title: L('Plans & billing'), note: st.note, kids: [tabs()].concat(body()) }); }
    function tabs() {
      return h('div', { class: 'pd-tabs pd-team-tabs', role: 'tablist', 'aria-label': T('Plans & billing') }, [['plans', L('Plans')], ['billing', L('Subscriptions & invoices')]].map(function (t) {
        return btn(key('tab-' + t[0], { class: 'pd-tab', role: 'tab', 'data-pd-act': 'bl-tab-' + t[0], 'aria-selected': st.tab === t[0] ? 'true' : 'false', tabindex: st.tab === t[0] ? '0' : '-1', text: T(t[1]) }));
      }));
    }
    function load() {
      var seq = ++st.seq;
      st.state = 'loading'; render();
      Promise.all([api.plans(), api.billing()]).then(function (rs) {
        if (seq !== st.seq) return;
        if (rs[0].ok && rs[1].ok && rs[0].data && rs[1].data) { st.plans = rs[0].data.plans; st.billing = rs[1].data; st.state = 'ready'; }
        else { st.state = 'error'; st.note = problem(T, rs[0].ok ? rs[1] : rs[0], L('Plans and billing could not be read.')); }
        render();
      });
    }
    function inp(name, value, label, attrs) {
      var a = key('in-' + name, { class: 'pd-input', type: 'text', 'data-pd-bl-in': name, 'aria-label': label });
      for (var k in attrs || {}) a[k] = attrs[k];
      var i = h('input', a); i.value = value; return i;
    }
    function check(name, on, label) {
      var c = h('input', key('in-' + name, { type: 'checkbox', 'data-pd-bl-in': name })); c.checked = on;
      return h('label', { class: 'pd-team-check' }, [c, h('span', { text: label })]);
    }
    function select(name, value, label, options) {
      var s = h('select', key('in-' + name, { class: 'pd-input', 'data-pd-bl-in': name, 'aria-label': label }), options.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      s.value = value; return s;
    }
    function body() {
      if (st.state === 'loading' || st.state === 'idle') return [skeleton(h, 5)];
      if (st.state === 'error') return [h('div', { class: 'pd-dock-empty' }, [h('p', { text: T('Plans and billing could not be read.') }), btn(key('retry', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-retry' }), [h('span', { text: T('Try again') })])])];
      return st.tab === 'billing' ? billing() : plans();
    }
    function plans() {
      if (st.form) return [planForm()];
      var group = function (aud, title) {
        var list = st.plans.filter(function (p) { return p.audience === aud; });
        return h('div', { class: 'pd-acct-block' }, [
          h('h3', { class: 'pd-h3', text: T(title) }),
          list.length ? h('ul', { class: 'pd-dock-list', role: 'list' }, list.map(function (p) {
            return h('li', { class: 'pd-dock-row', 'data-pd-plan': p.key }, [
              h('div', { class: 'pd-dock-text' }, [
                h('span', { class: 'pd-dock-name', 'data-user-content': '', dir: 'auto', text: p.name }),
                h('span', { class: 'pd-dock-kicker' }, [h('span', { dir: 'ltr', text: p.key }), h('span', { text: ' · ' }), h('span', { text: price(ctx, p) }), h('span', { text: ' · ' }), h('span', { text: tf('Features: %d', p.features.length) })]),
              ]),
              h('div', { class: 'pd-dock-btns' }, [
                p.isDefault ? h('span', { class: 'pd-chip', text: T('Default') }) : null,
                p.active ? null : h('span', { class: 'pd-chip pd-chip--muted', text: T('Not offered') }),
                btn(key('edit-' + p.key, { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-edit', 'data-pd-id': p.id }), [h('span', { text: T('Edit') }), h('span', { class: 'pd-sr', 'data-user-content': '', text: ' ' + p.name })]),
              ]),
            ]);
          })) : h('p', { class: 'pd-note', text: T('No plans for this audience yet: every workspace has what the studio ships with.') }),
        ]);
      };
      return [
        h('p', { class: 'pd-note', text: T('A plan’s features are enforced on the server, route by route. Its price is shown to customers and invoiced; nothing is charged without a payment provider.') }),
        btn(key('new', { class: 'pd-btn pd-btn--primary', 'data-pd-act': 'bl-new' }), [h('span', { text: T('New plan') })]),
        group('CREATOR', L('Creator plans')), group('CLUB', L('Club plans')),
      ];
    }
    function planForm() {
      var f = st.form, creating = !f.id, allowed = f.audience === 'CLUB' ? CLUB_FEATURES : FEATURES;
      return h('div', { class: 'pd-acct-block pd-plan-form' }, [
        h('h3', { class: 'pd-h3', text: creating ? T('New plan') : T('Edit the plan') }),
        creating ? field(h, T('Key'), inp('key', f.key, T('Key'), { maxlength: '40', dir: 'ltr', autocomplete: 'off' }), T('Fixed once saved. Lower-case letters, digits and hyphens.')) : h('p', { class: 'pd-note', dir: 'ltr', text: f.key }),
        creating ? field(h, T('For'), select('audience', f.audience, T('For'), [['CREATOR', T('Creators')], ['CLUB', T('Clubs')]])) : null,
        field(h, T('Name'), inp('name', f.name, T('Name'), { maxlength: '60', dir: 'auto' })),
        field(h, T('Description, shown to customers'), inp('description', f.description, T('Description, shown to customers'), { maxlength: '400', dir: 'auto' })),
        h('fieldset', { class: 'pd-plan-fieldset' }, [h('legend', { class: 'pd-gate-label', text: T('Features') })].concat(allowed.map(function (x) { return check('feature-' + x, f.features.indexOf(x) !== -1, T(FEATURE[x])); }))),
        h('div', { class: 'pd-plan-grid' }, [
          field(h, T('Designs, at most'), inp('maxProjects', f.maxProjects, T('Designs, at most'), { inputmode: 'numeric', dir: 'ltr' }), T('Empty: no limit.')),
          field(h, T('Collections, at most'), inp('maxCollections', f.maxCollections, T('Collections, at most'), { inputmode: 'numeric', dir: 'ltr' }), T('Empty: no limit.')),
          f.audience === 'CREATOR' ? field(h, T('People shared with, at most'), inp('maxShares', f.maxShares, T('People shared with, at most'), { inputmode: 'numeric', dir: 'ltr' }), T('Empty: no limit.')) : null,
        ]),
        h('div', { class: 'pd-plan-grid' }, [
          field(h, T('Price'), inp('price', f.price, T('Price'), { inputmode: 'decimal', dir: 'ltr' }), T('Empty: a free plan.')),
          field(h, T('Currency'), inp('currency', f.currency, T('Currency'), { maxlength: '3', dir: 'ltr', autocomplete: 'off' })),
          field(h, T('Billed'), select('interval', f.interval, T('Billed'), [['MONTH', T('Every month')], ['YEAR', T('Every year')]])),
        ]),
        field(h, T('Order shown'), inp('sortOrder', f.sortOrder, T('Order shown'), { inputmode: 'numeric', dir: 'ltr' })),
        check('isDefault', f.isDefault, T('The plan every new workspace starts on')),
        check('active', f.active, T('Offered to customers')),
        h('div', { class: 'pd-team-tools' }, [
          btn(key('save', { class: 'pd-btn pd-btn--primary', 'data-pd-act': 'bl-save', 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: creating ? T('Create the plan') : T('Save the plan') })]),
          btn(key('cancel', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-cancel' }), [h('span', { text: T('Cancel') })]),
        ]),
      ]);
    }
    function tenantName(t) { return t.name || (t.kind === 'club' ? T('A club') : T('A creator')); }
    function billing() {
      var b = st.billing;
      return [
        h('p', { class: 'pd-note' + (b.payments.configured ? '' : ' pd-note--info'), 'data-pd-payments': b.payments.configured ? 'configured' : 'not-configured' }, [icon('info', 14),
          h('span', { text: b.payments.configured ? T('A payment provider is configured.') : T('No payment provider is configured: no invoice can be paid online and nothing is charged. A plan can be granted with a note.') })]),
        grantBlock(),
        h('div', { class: 'pd-acct-block' }, [
          h('h3', { class: 'pd-h3', text: T('Subscriptions') }),
          b.subscriptions.length ? h('ul', { class: 'pd-dock-list', role: 'list' }, b.subscriptions.map(function (s) {
            var live = s.status === 'ACTIVE' || s.status === 'PENDING';
            return h('li', { class: 'pd-dock-row', 'data-pd-sub': s.id }, [
              h('div', { class: 'pd-dock-text' }, [
                h('span', { class: 'pd-dock-name', 'data-user-content': '', dir: 'auto', text: tenantName(s.tenant) }),
                h('span', { class: 'pd-dock-kicker' }, [h('span', { text: s.tenant.kind === 'club' ? T('Club') : T('Creator') }), h('span', { text: ' · ' }), h('span', { 'data-user-content': '', dir: 'auto', text: s.plan.name }),
                  h('span', { text: ' · ' }), h('span', { text: s.source === 'OWNER_GRANT' ? T('Granted') : T('Requested') }),
                  s.currentPeriodEnd ? h('span', { text: ' · ' }) : null, s.currentPeriodEnd ? h('span', { text: tf('until %s', ctx.date(s.currentPeriodEnd)) }) : null]),
              ]),
              h('div', { class: 'pd-dock-btns' }, [
                h('span', { class: 'pd-chip' + (s.status === 'ACTIVE' ? '' : ' pd-chip--muted'), 'data-status': s.status, text: T(STATUS[s.status] || STATUS.ACTIVE) }),
                live && st.ending !== s.id ? btn(key('end-' + s.id, { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-end', 'data-pd-id': s.id }), [h('span', { text: T('End…') })]) : null,
              ]),
            ].concat(live && st.ending === s.id ? [endForm(s)] : []));
          })) : h('p', { class: 'pd-note', text: T('No subscriptions yet.') }),
        ]),
        h('div', { class: 'pd-acct-block' }, [
          h('h3', { class: 'pd-h3', text: T('Invoices') }),
          b.invoices.length ? h('ul', { class: 'pd-dock-list', role: 'list' }, b.invoices.map(function (inv) {
            return h('li', { class: 'pd-dock-row', 'data-pd-invoice': inv.number }, [
              h('div', { class: 'pd-dock-text' }, [
                h('span', { class: 'pd-dock-name', dir: 'ltr', text: inv.number }),
                h('span', { class: 'pd-dock-kicker' }, [h('span', { 'data-user-content': '', dir: 'auto', text: tenantName(inv.tenant) }), h('span', { text: ' · ' }), h('span', { text: ctx.date(inv.issuedAt) }), h('span', { text: ' · ' }), h('span', { text: ctx.money(inv.totalMinor, inv.currency) })]),
              ]),
              h('div', { class: 'pd-dock-btns' }, [
                h('span', { class: 'pd-chip' + (inv.status === 'OPEN' ? ' pd-chip--muted' : ''), 'data-status': inv.status, text: T(INVOICE[inv.status] || INVOICE.OPEN) }),
                inv.status === 'OPEN' ? btn(key('void-' + inv.number, { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-void', 'data-pd-id': inv.id, 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: T('Void') }), h('span', { class: 'pd-sr', dir: 'ltr', text: ' ' + inv.number })]) : null,
              ]),
            ]);
          })) : h('p', { class: 'pd-note', text: T('No invoices yet.') }),
        ]),
        h('div', { class: 'pd-acct-block' }, [
          h('h3', { class: 'pd-h3', text: T('Lapsed subscriptions') }),
          h('p', { class: 'pd-note', text: st.expire === null ? T('A subscription past its end date no longer counts. Marking it expired keeps the record tidy.') : tf('Past their end date: %d.', st.expire) }),
          st.expire ? btn(key('expire', { class: 'pd-btn pd-btn--outline', 'data-pd-act': 'bl-expire', 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: T('Mark them expired') })])
            : btn(key('expire-check', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-expire-check', 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: T('Find lapsed subscriptions') })]),
        ]),
      ];
    }
    function endForm(s) {
      return h('div', { class: 'pd-plan-confirm' }, [
        field(h, T('Why it ends (kept in the audit)'), inp('endNote', st.endNote, T('Why it ends (kept in the audit)'), { maxlength: '300', dir: 'auto' })),
        h('div', { class: 'pd-team-tools' }, [
          btn(key('end-confirm', { class: 'pd-btn pd-btn--outline', 'data-pd-act': 'bl-end-confirm', 'data-pd-id': s.id, 'aria-disabled': st.busy ? 'true' : null }), [h('span', { text: T('End it now') })]),
          btn(key('end-keep', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-end-keep' }), [h('span', { text: T('Keep it') })]),
        ]),
      ]);
    }
    function grantBlock() {
      var g = st.grant;
      if (!g) return h('div', { class: 'pd-acct-block' }, [btn(key('grant', { class: 'pd-btn pd-btn--outline', 'data-pd-act': 'bl-grant' }), [h('span', { text: T('Grant a plan…') })])]);
      var aud = g.tenantKind === 'club' ? 'CLUB' : 'CREATOR';
      var tenants = st.tenants ? st.tenants[g.tenantKind] : null;
      var plansFor = st.plans.filter(function (p) { return p.audience === aud && p.active; });
      return h('div', { class: 'pd-acct-block pd-plan-form' }, [
        h('h3', { class: 'pd-h3', text: T('Grant a plan') }),
        h('p', { class: 'pd-note', text: T('The plan is active at once, without an invoice; any current subscription of the workspace ends. Use it for pilots and agreements made outside the platform.') }),
        field(h, T('For'), select('tenantKind', g.tenantKind, T('For'), [['creator', T('A creator')], ['club', T('A club')]])),
        tenants === null ? h('p', { class: 'pd-note', text: T('Reading the workspaces…') })
          : tenants.length ? field(h, T('Workspace'), select('tenantId', g.tenantId, T('Workspace'), tenants.map(function (t) { return [t.id, t.name]; })))
            : h('p', { class: 'pd-note', text: T('No workspace of this kind yet.') }),
        plansFor.length ? field(h, T('Plan'), select('planKey', g.planKey, T('Plan'), plansFor.map(function (p) { return [p.key, p.name]; }))) : h('p', { class: 'pd-note', text: T('No plan offered to this audience: create one first.') }),
        field(h, T('Months'), inp('months', g.months, T('Months'), { inputmode: 'numeric', dir: 'ltr' }), T('1 to 36. Empty: no end date.')),
        field(h, T('Note, kept in the audit'), inp('note', g.note, T('Note, kept in the audit'), { maxlength: '300', dir: 'auto' })),
        h('div', { class: 'pd-team-tools' }, [
          btn(key('grant-save', { class: 'pd-btn pd-btn--primary', 'data-pd-act': 'bl-grant-save', 'aria-disabled': st.busy || !tenants || !tenants.length || !plansFor.length ? 'true' : null }), [h('span', { text: T('Grant the plan') })]),
          btn(key('grant-cancel', { class: 'pd-btn pd-btn--ghost', 'data-pd-act': 'bl-grant-cancel' }), [h('span', { text: T('Cancel') })]),
        ]),
      ]);
    }
    function grantDefaults() {
      var g = st.grant, aud = g.tenantKind === 'club' ? 'CLUB' : 'CREATOR', list = st.tenants ? st.tenants[g.tenantKind] : null;
      if (list && list.length && !list.some(function (t) { return t.id === g.tenantId; })) g.tenantId = list[0].id;
      var ps = st.plans.filter(function (p) { return p.audience === aud && p.active; });
      if (ps.length && !ps.some(function (p) { return p.key === g.planKey; })) g.planKey = ps[0].key;
    }
    function readTenants() {
      if (st.tenants) { grantDefaults(); return; }
      Promise.all([api.creators(), api.rollout()]).then(function (rs) {
        st.tenants = {
          creator: rs[0].ok && rs[0].data ? rs[0].data.creators.filter(function (c) { return c.status === 'ACTIVE'; }).map(function (c) { return { id: c.id, name: c.displayName || c.email || c.id }; }) : [],
          club: rs[1].ok && rs[1].data ? rs[1].data.clubs.map(function (c) { return { id: c.id, name: c.name }; }) : [],
        };
        if (st.grant) grantDefaults();
        render();
      });
    }
    function after(r, okText, reload) {
      st.busy = false;
      if (r.ok) { say(okText); if (reload) { load(); return; } } else say(problem(T, r, L('The change could not be made.')));
      render();
    }
    function open(tab, trigger) { st.tab = tab || st.tab; st.open = true; st.trigger = trigger || null; el.setAttribute('data-open', 'true'); load(); ctx.onToggle(true); var f = el.querySelector('[role="tab"][aria-selected="true"]'); if (f) f.focus({ preventScroll: true }); }
    function close() {
      if (!st.open) return;
      st.open = false; el.setAttribute('data-open', 'false'); ctx.onToggle(false);
      var back = st.trigger && ctx.host.contains(st.trigger) ? st.trigger : null; st.trigger = null;
      if (back) back.focus({ preventScroll: true });
    }
    function onAction(act, t) {
      if (act.indexOf('bl') !== 0) return false;
      if (act === 'bl') { if (st.open) close(); else open(t.getAttribute('data-pd-tab') || 'plans', t); return true; }
      if (act === 'bl-close') { close(); return true; }
      if (act === 'bl-retry') { st.note = ''; load(); return true; }
      if (act.indexOf('bl-tab-') === 0) { st.tab = act.slice(7); st.note = ''; render(); var tb = el.querySelector('[' + K + '="tab-' + st.tab + '"]'); if (tb) tb.focus(); return true; }
      if (act === 'bl-new') { st.form = emptyPlan(); say(''); render(); var k = el.querySelector('[' + K + '="in-key"]'); if (k) k.focus(); return true; }
      if (act === 'bl-edit') { var p = st.plans.filter(function (x) { return x.id === t.getAttribute('data-pd-id'); })[0]; if (p) { st.form = formOf(p, ctx.digits); say(''); render(); } return true; }
      if (act === 'bl-cancel') { st.form = null; render(); return true; }
      if (act === 'bl-grant') { st.grant = { tenantKind: 'creator', tenantId: '', planKey: '', months: '', note: '' }; readTenants(); render(); return true; }
      if (act === 'bl-grant-cancel') { st.grant = null; render(); return true; }
      if (act === 'bl-end') { st.ending = t.getAttribute('data-pd-id'); st.endNote = ''; render(); var en = el.querySelector('[' + K + '="in-endNote"]'); if (en) en.focus(); return true; }
      if (act === 'bl-end-keep') { st.ending = null; render(); return true; }
      if (st.busy || t.getAttribute('aria-disabled') === 'true') return true;
      st.busy = true; render();
      if (act === 'bl-save' && st.form) {
        var f = st.form, b = bodyOf(f, !f.id, ctx.digits);
        // A number that is not one would reach the server as null (no limit, a free plan): refused here, said why.
        if (typeof b.priceMinor === 'number' && isNaN(b.priceMinor)) { st.busy = false; say(T('Enter the price as a number, such as 9.90.')); render(); return true; }
        if ([b.maxProjects, b.maxCollections, b.maxShares, b.sortOrder].some(function (v) { return typeof v === 'number' && isNaN(v); })) { st.busy = false; say(T(PLAN_INVALID['bad-number'])); render(); return true; }
        (f.id ? api.savePlan(f.id, b) : api.createPlan(b)).then(function (r) { if (r.ok) st.form = null; after(r, f.id ? T('The plan is saved.') : T('The plan is created.'), r.ok); });
      } else if (act === 'bl-grant-save' && st.grant) {
        var g = st.grant;
        api.grantPlan({ tenantKind: g.tenantKind, tenantId: g.tenantId, planKey: g.planKey, months: String(g.months).trim() === '' ? null : Number(g.months), note: g.note })
          .then(function (r) { if (r.ok) st.grant = null; after(r, T('The plan is granted and active.'), r.ok); });
      } else if (act === 'bl-end-confirm') {
        api.endSubscription(t.getAttribute('data-pd-id'), st.endNote).then(function (r) { if (r.ok) st.ending = null; after(r, T('The subscription has ended.'), r.ok); });
      } else if (act === 'bl-void') {
        api.voidInvoice(t.getAttribute('data-pd-id')).then(function (r) { after(r, T('The invoice is void.'), r.ok); });
      } else if (act === 'bl-expire-check') {
        api.expireSubscriptions(true).then(function (r) { if (r.ok && r.data) st.expire = r.data.due; after(r, r.ok && r.data && !r.data.due ? T('No subscription is past its end date.') : '', false); });
      } else if (act === 'bl-expire') {
        api.expireSubscriptions(false).then(function (r) { var n = r.ok && r.data ? r.data.due : 0; if (r.ok) st.expire = null; after(r, tf('Marked expired: %d.', n), r.ok); });
      } else { st.busy = false; render(); }
      return true;
    }
    function onInput(ev) {
      var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-pd-bl-in');
      if (!k || !el.contains(t)) return false;
      if (k === 'endNote') { st.endNote = t.value; return true; }
      if (st.grant && ['tenantKind', 'tenantId', 'planKey', 'months', 'note'].indexOf(k) !== -1) {
        st.grant[k] = t.value;
        if (k === 'tenantKind') { st.grant.tenantId = ''; st.grant.planKey = ''; grantDefaults(); render(); }
        return true;
      }
      if (!st.form) return true;
      if (k.indexOf('feature-') === 0) {
        var x = k.slice(8), i = st.form.features.indexOf(x);
        if (t.checked && i === -1) st.form.features.push(x); else if (!t.checked && i !== -1) st.form.features.splice(i, 1);
        return true;
      }
      st.form[k] = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'audience') { var allow = st.form.audience === 'CLUB' ? CLUB_FEATURES : FEATURES; st.form.features = st.form.features.filter(function (f) { return allow.indexOf(f) !== -1; }); render(); }
      return true;
    }
    return {
      el: el, open: open, close: close, repaint: render, isOpen: function () { return st.open; }, onAction: onAction, onInput: onInput, onChange: onInput,
      metrics: function () {
        return { open: st.open, tab: st.tab, state: st.state, busy: st.busy, note: st.note, form: st.form ? (st.form.id ? 'edit' : 'new') : null, grant: !!st.grant,
          plans: st.plans ? st.plans.map(function (p) { return p.key; }) : null, subscriptions: st.billing ? st.billing.subscriptions.length : null,
          invoices: st.billing ? st.billing.invoices.map(function (i) { return i.status; }) : null, payments: st.billing ? st.billing.payments.configured : null };
      },
    };
  }

  return { FEATURES: FEATURES, CLUB_FEATURES: CLUB_FEATURES, panel: panel, production: production, console: console_, bodyOf: bodyOf };
});
