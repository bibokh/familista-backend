/**
 * Design Studio browser proof, P20 — manufacturing (M4), owner-brokered, end to end in two real browsers: the club's
 * administrator in the Club Design Studio and the Platform Owner in the platform's room, on the compiled application
 * with a real PostgreSQL database under row-level security.
 *
 *   · The club asks for a quotation from a collection's order sheet; the request keeps a frozen specification.
 *   · The Owner finds no supplier until recording one (none is seeded), records it as a prospect and verifies it with
 *     a note; reviews the request, records the quotation (a test record, marked as such), publishes it.
 *   · The club sees the quotation (supplier, country, amount in its currency) and accepts it; nothing is charged.
 *   · The Owner confirms the order (a note is required: refused without one), records production and shipping; the club
 *     confirms delivery; the history is whole on both sides.
 *   · The Owner exports the production sheet and a design as frozen; the club cannot reach the console; axe in English and
 *     Arabic; no CSP violation, no page error.
 * Every supplier, quotation and reference written here is a test record in the proof's own throwaway database.
 */
'use strict';

module.exports = async function p20(H) {
  const { open, M, check, fail, OUT, ROOT, db, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
  const R = require(path.join(ROOT, 'public/product-design/pd-roster.js'));
  const tpl = (f) => C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates', f), 'utf8')));
  const call = (who, method, url, body) => fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + TOKENS[who], 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
  const runAxe = (pg, scope) => pg.evaluate(async ([src, sel]) => {
    if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
    const r = await window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, [fs.readFileSync(axePath, 'utf8'), scope]);
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const CLUBP = '#pd-club-root .pd-team', OWNP = '#pd-root .pd-mfg';
  const status = async () => (await db.manufacturingRequest.findFirst({ where: { clubId: 'club-1' }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } })) || {};

  // ── the club's kit, saved through the club's own routes ──────────────────────────────────────────────────────────
  const E = (o) => Object.assign({ name: 'SMITH', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1 }, o || {});
  const shirt = (await call('clubAdmin', 'POST', '/api/v1/club-design/projects', { document: C.createDocument(tpl('football-jersey.json'), 'P20 home shirt'), origin: 'EDITOR' })).body.data.project.id;
  const shorts = (await call('clubAdmin', 'POST', '/api/v1/club-design/projects', { document: C.createDocument(tpl('shorts.json'), 'P20 home shorts'), origin: 'EDITOR' })).body.data.project.id;
  const rosterEntries = [E(), E({ name: 'JONES', number: 4, top: 'L', qty: 2 }), E({ name: 'ARAB', number: 10, top: 'S', shorts: 'S' })];
  const roster = (await call('clubAdmin', 'POST', '/api/v1/club-design/rosters', { name: 'P20 first team', entries: rosterEntries })).body.data.roster.id;
  const kit = (await call('clubAdmin', 'POST', '/api/v1/club-design/collections', { name: 'P20 home kit', season: '2026/27', rosterId: roster, items: [{ projectId: shirt, role: 'HOME' }, { projectId: shorts, role: 'HOME' }] })).body.data.collection.id;
  if (!shirt || !shorts || !roster || !kit) { fail('P20 the club’s kit could not be prepared', { shirt, shorts, roster, kit }); return; }

  const club = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  const owner = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'owner', hash: '/#product-design', wait: false });
  const cp = club.page, op = owner.page;
  try {
    await cp.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
    await op.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.mfg; }, null, { timeout: 60000 });

    // ── 1. the club asks for a quotation from the collection's order sheet ─────────────────────────────────────────
    await cp.click('#pd-club-root [data-pd-act="team"]');
    await cp.click(CLUBP + ' [data-pd-act="team-tab-collections"]');
    await cp.waitForSelector(CLUBP + ' [data-pd-act="col-open"][data-pd-id="' + kit + '"]', { timeout: 15000 });
    await cp.click(CLUBP + ' [data-pd-act="col-open"][data-pd-id="' + kit + '"]');
    await cp.waitForFunction(() => window.__familistaProductDesignMetrics().team.collections.sheet === 'ready', null, { timeout: 20000 });
    await cp.click(CLUBP + ' [data-pd-act="col-ask"]');
    await cp.fill(CLUBP + ' [data-pd-col-ask="note"]', 'For the first home game of the season');
    await cp.fill(CLUBP + ' [data-pd-col-ask="neededBy"]', inDays(60));
    await cp.click(CLUBP + ' [data-pd-act="col-ask-send"]');
    await cp.waitForFunction(() => { const r = window.__familistaProductDesignMetrics().team.requests; return r && r.status === 'SUBMITTED'; }, null, { timeout: 20000 });
    const req = await db.manufacturingRequest.findFirst({ where: { clubId: 'club-1', collectionId: kit }, select: { id: true, status: true, spec: true, setsTotal: true, clubNote: true } });
    const empty = await cp.evaluate((sel) => (document.querySelector(sel + ' .pd-empty') || {}).textContent || '', CLUBP);
    check('P20 the club asks for a quotation from the order sheet: the request keeps the collection’s designs at their revisions and the roster’s sizes, and waits for Familista',
      !!req && req.status === 'SUBMITTED' && req.setsTotal === 4 && req.spec.garments.length === 2 && req.spec.garments.every((g) => /^[0-9a-f]{64}$/.test(g.sha256))
        && req.clubNote === 'For the first home game of the season' && /No quotation yet/.test(empty), { status: req && req.status, sets: req && req.setsTotal, empty });

    // ── 2. the Owner: no supplier until recorded; a prospect, then verified ────────────────────────────────────────
    await op.click('#pd-root [data-pd-act="mfg"][data-pd-tab="suppliers"]');
    await op.waitForFunction(() => { const m = window.__familistaProductDesignMetrics().mfg; return m.open && m.tab === 'suppliers'; }, null, { timeout: 10000 });
    await op.waitForSelector(OWNP + ' .pd-empty', { timeout: 15000 });
    const none = await op.evaluate((sel) => ({ empty: document.querySelector(sel + ' .pd-empty').textContent, rows: document.querySelectorAll(sel + ' .pd-dock-list .pd-dock-row:not(.is-skeleton)').length }), OWNP);
    check('P20 the Owner’s console opens from the side rail and lists no supplier until one is recorded: none is seeded or shown as a partner',
      none.rows === 0 && /No suppliers yet/.test(none.empty) && (await db.manufacturingSupplier.count()) === 0, none);
    await op.click(OWNP + ' [data-pd-act="mfg-supplier-new"]');
    await op.fill(OWNP + ' [data-pd-mfg-s="name"]', 'P20 Factory (test record)');
    await op.fill(OWNP + ' [data-pd-mfg-s="country"]', 'pt');
    await op.check(OWNP + ' [data-pd-mfg-s-list="forms"][value="top"]');
    await op.check(OWNP + ' [data-pd-mfg-s-list="forms"][value="shorts"]');
    await op.check(OWNP + ' [data-pd-mfg-s-list="methods"][value="SUBLIMATION"]');
    await op.click(OWNP + ' [data-pd-act="mfg-supplier-save"]');
    await op.waitForFunction((sel) => !!document.querySelector(sel + ' [data-pd-act="mfg-supplier-status"][data-pd-status="VERIFIED"]'), OWNP, { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-supplier-status"][data-pd-status="VERIFIED"]');
    await op.fill(OWNP + ' [data-pd-mfg-note]', 'short');
    await op.click(OWNP + ' [data-pd-act="mfg-ask-go"]');
    await op.waitForTimeout(400);
    const tooShort = await op.evaluate((sel) => document.querySelector(sel + ' [data-pd-mfg-status]').textContent, OWNP);
    await op.fill(OWNP + ' [data-pd-mfg-note]', 'Business registration and sample garments checked (test record)');
    await op.click(OWNP + ' [data-pd-act="mfg-ask-go"]');
    await op.waitForFunction((sel) => !document.querySelector(sel + ' [data-pd-mfg-note]'), OWNP, { timeout: 15000 });
    const sup = await db.manufacturingSupplier.findFirst({ select: { id: true, status: true, country: true, forms: true, methods: true, verificationNote: true } });
    check('P20 the Owner records a supplier as a prospect and verifies it only with a note of what was checked (a short note is refused)',
      !!sup && sup.status === 'VERIFIED' && sup.country === 'PT' && sup.forms.join() === 'top,shorts' && sup.methods.join() === 'SUBLIMATION' && /at least 10 characters/.test(tooShort), { sup, tooShort });

    // ── 3. the Owner reviews the request and records, then publishes, the quotation ────────────────────────────────
    await op.click(OWNP + ' [data-pd-act="mfg-back"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-tab-requests"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-tab-requests"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + req.id + '"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + req.id + '"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-step"][data-pd-step="review"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-step"][data-pd-step="review"]');
    await op.click(OWNP + ' [data-pd-act="mfg-ask-go"]');
    await op.waitForFunction(() => window.__familistaProductDesignMetrics().mfg.status === 'IN_REVIEW', null, { timeout: 15000 });
    // M7d: how the verified supplier fits the request, from what was recorded: both garments made, no minimum and no
    // lead time recorded, so the fit is incomplete; the quotation is recorded from its row, the supplier already chosen.
    await op.waitForFunction(() => window.__familistaProductDesignMetrics().mfg.fit === 'ready', null, { timeout: 15000 });
    const fit = await op.evaluate(([sel, id]) => {
      const row = document.querySelector(sel + ' tr[data-pd-supplier="' + id + '"]');
      return row ? { overall: row.getAttribute('data-pd-fit'), cells: [...row.querySelectorAll('td[data-met]')].map((td) => [td.getAttribute('data-met'), td.textContent]),
        chip: row.querySelector('.pd-fit-chip').textContent, rows: document.querySelectorAll(sel + ' .pd-fit-table tbody tr').length } : null;
    }, [OWNP, sup.id]);
    const api = await call('owner', 'GET', '/api/v1/system/manufacturing/requests/' + req.id + '/fit');
    check('P20 M7d: the console shows how the verified supplier fits the request, from what was recorded only; what was not recorded says so',
      !!fit && fit.rows === 1 && fit.overall === 'incomplete' && fit.chip === 'Not everything recorded'
      && JSON.stringify(fit.cells) === JSON.stringify([['true', 'Makes them all'], ['null', 'Not recorded'], ['null', 'Not recorded']])
      && api.status === 200 && api.body.data.suppliers[0].fit.overall === 'incomplete', { fit, api: api.body.data && api.body.data.suppliers });
    await op.click(OWNP + ' [data-pd-act="mfg-quote-from"][data-pd-id="' + sup.id + '"]');
    await op.waitForFunction((id) => !!document.querySelector('#pd-root .pd-mfg [data-pd-mfg-q="supplierId"] option[value="' + id + '"]'), sup.id, { timeout: 15000 });
    check('P20 M7d: recorded from the fit row, the quotation form has that supplier chosen', (await op.inputValue(OWNP + ' [data-pd-mfg-q="supplierId"]')) === sup.id);
    await op.selectOption(OWNP + ' [data-pd-mfg-q="supplierId"]', sup.id);
    await op.selectOption(OWNP + ' [data-pd-mfg-q="currency"]', 'EUR');
    await op.fill(OWNP + ' [data-pd-mfg-q="amount"]', '1234.50');
    await op.fill(OWNP + ' [data-pd-mfg-q="leadTimeDays"]', '28');
    await op.fill(OWNP + ' [data-pd-mfg-q="validUntil"]', inDays(14));
    await op.fill(OWNP + ' [data-pd-mfg-q="supplierReference"]', 'P20-TEST-1');
    await op.fill(OWNP + ' [data-pd-mfg-q="evidence"]', 'Test record written by the browser proof');
    await op.click(OWNP + ' [data-pd-act="mfg-quote-save"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-publish"]', { timeout: 15000 });
    const draftSeen = await call('clubAdmin', 'GET', '/api/v1/club-design/requests/' + req.id);
    await op.click(OWNP + ' [data-pd-act="mfg-publish"]');
    await op.waitForFunction(() => window.__familistaProductDesignMetrics().mfg.status === 'QUOTED', null, { timeout: 15000 });
    await op.screenshot({ path: path.join(OUT, 'p20-owner-request.png') });
    const quote = await db.manufacturingQuote.findFirst({ where: { requestId: req.id }, select: { id: true, status: true, currency: true, totalMinor: true, supplierReference: true } });
    check('P20 the Owner reviews the request and records the quotation as a draft the club does not see, then publishes it: EUR 1,234.50 as 123450 minor units',
      !!quote && quote.status === 'PUBLISHED' && quote.currency === 'EUR' && quote.totalMinor === 123450 && draftSeen.body.data.request.quotes.length === 0, { quote, draftSeen: draftSeen.body.data.request.quotes.length });

    // ── 4. the club sees it, and accepts it; nothing is charged ────────────────────────────────────────────────────
    await cp.click(CLUBP + ' [data-pd-act="team-back"]');
    await cp.click(CLUBP + ' [data-pd-act="team-tab-requests"]').catch(() => null);
    await cp.waitForSelector(CLUBP + ' [data-pd-act="req-open"][data-pd-id="' + req.id + '"]', { timeout: 15000 });
    await cp.click(CLUBP + ' [data-pd-act="req-open"][data-pd-id="' + req.id + '"]');
    await cp.waitForSelector(CLUBP + ' [data-pd-act="req-accept"]', { timeout: 15000 });
    const card = await cp.evaluate((sel) => document.querySelector(sel + ' .pd-req-quote').textContent, CLUBP);
    await cp.screenshot({ path: path.join(OUT, 'p20-club-quotation.png') });
    await cp.click(CLUBP + ' [data-pd-act="req-accept"]');
    await cp.click(CLUBP + ' [data-pd-act="team-confirm-go"]');
    await cp.waitForFunction(() => window.__familistaProductDesignMetrics().team.requests.status === 'ACCEPTED', null, { timeout: 15000 });
    const payments = await db.operationsPayment.count();
    check('P20 the club sees the published quotation (amount, supplier, country, verified; never its reference or evidence) and accepts it; nothing is charged',
      /€1,234\.50/.test(card) && /P20 Factory \(test record\)/.test(card) && /Portugal/.test(card) && /Verified by Familista/.test(card) && !/P20-TEST-1|Test record written/.test(card)
        && (await status()).status === 'ACCEPTED' && payments === 0, { card, payments });

    // ── 5. the Owner confirms the order (a note is required), production, shipping ─────────────────────────────────
    await op.click(OWNP + ' [data-pd-act="mfg-back"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + req.id + '"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + req.id + '"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-step"][data-pd-step="order"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-step"][data-pd-step="order"]');
    await op.click(OWNP + ' [data-pd-act="mfg-ask-go"]');
    await op.waitForTimeout(300);
    const noNote = { msg: await op.evaluate((sel) => document.querySelector(sel + ' [data-pd-mfg-status]').textContent, OWNP), status: (await status()).status };
    await op.fill(OWNP + ' [data-pd-mfg-note]', 'Confirmed with the supplier by e-mail (test record); payment settled outside the platform');
    await op.click(OWNP + ' [data-pd-act="mfg-ask-go"]');
    await op.waitForFunction(() => window.__familistaProductDesignMetrics().mfg.status === 'ORDERED', null, { timeout: 15000 });
    for (const [step, to, note] of [['produce', 'IN_PRODUCTION', ''], ['ship', 'SHIPPED', 'Carrier reference P20 (test record)']]) {
      await op.click(OWNP + ' [data-pd-act="mfg-step"][data-pd-step="' + step + '"]');
      if (note) await op.fill(OWNP + ' [data-pd-mfg-note]', note);
      await op.click(OWNP + ' [data-pd-act="mfg-ask-go"]');
      await op.waitForFunction((t) => window.__familistaProductDesignMetrics().mfg.status === t, to, { timeout: 15000 });
    }
    check('P20 the Owner confirms the order only with a note (refused without one, nothing changed), then records production and shipping',
      /needs a note/.test(noNote.msg) && noNote.status === 'ACCEPTED' && (await status()).status === 'SHIPPED', noNote);

    // ── 6. the club confirms delivery; the history is whole on both sides ──────────────────────────────────────────
    await cp.click(CLUBP + ' [data-pd-act="team-back"]');
    await cp.waitForSelector(CLUBP + ' [data-pd-act="req-open"][data-pd-id="' + req.id + '"]', { timeout: 15000 });
    await cp.click(CLUBP + ' [data-pd-act="req-open"][data-pd-id="' + req.id + '"]');
    await cp.waitForSelector(CLUBP + ' [data-pd-act="req-delivered"]', { timeout: 15000 });
    await cp.click(CLUBP + ' [data-pd-act="req-delivered"]');
    await cp.waitForFunction(() => window.__familistaProductDesignMetrics().team.requests.status === 'DELIVERED', null, { timeout: 15000 });
    const history = await cp.evaluate((sel) => [...document.querySelectorAll(sel + ' .pd-req-history .pd-req-event')].map((e) => e.textContent), CLUBP);
    const events = await db.manufacturingRequestEvent.findMany({ where: { requestId: req.id }, orderBy: { createdAt: 'asc' }, select: { action: true, actorKind: true } });
    await cp.screenshot({ path: path.join(OUT, 'p20-club-delivered.png') });
    check('P20 the club confirms delivery, and its history shows every step, in order, as the database records it',
      events.map((e) => e.action).join() === 'submit,review,quote,accept,order,produce,ship,deliver'
        && JSON.stringify(history) === JSON.stringify(['Request submitted', 'Taken into review', 'Quotation published', 'Quotation accepted', 'Order confirmed with the supplier', 'Production started', 'Shipped', 'Delivered']),
      { history, events: events.map((e) => e.action + ':' + e.actorKind) });

    // ── 7. production files: the sheet and a design as frozen ────────────────────────────────────────────────────
    await op.click(OWNP + ' [data-pd-act="mfg-back"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-filter-all"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-filter-all"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + req.id + '"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + req.id + '"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-sheet"]', { timeout: 15000 });
    const [sheet] = await Promise.all([op.waitForEvent('download', { timeout: 15000 }), op.click(OWNP + ' [data-pd-act="mfg-sheet"]')]);
    const sheetRows = R.parseCsv(fs.readFileSync(await sheet.path(), 'utf8'));
    const regions = await op.evaluate((sel) => [...document.querySelectorAll(sel + ' .pd-team-scroll')].map((r) => r.clientHeight), OWNP);
    check('P20 the console’s tables keep their height in a long request: a region that scrolls is never squeezed to nothing (it was, before the fix)',
      regions.length >= 1 && regions.every((hgt) => hgt > 40), regions);
    // Centred in its scroll region first: scrolled to the region's top edge, the row would sit under the table's sticky header.
    await op.$eval(OWNP + ' [data-pd-act="mfg-design"][data-pd-id="' + shirt + '"]', (b) => b.scrollIntoView({ block: 'center', inline: 'center' }));
    const [design] = await Promise.all([op.waitForEvent('download', { timeout: 15000 }), op.click(OWNP + ' [data-pd-act="mfg-design"][data-pd-id="' + shirt + '"]')]);
    const doc = JSON.parse(fs.readFileSync(await design.path(), 'utf8'));
    // P1: the sheet is the server's, from the frozen entries and the names kept apart; every export is recorded.
    const exported = await db.platformAuditLog.findMany({ where: { resourceId: req.id, action: { in: ['manufacturing.sheet.exported', 'manufacturing.design.exported'] } }, select: { action: true, metadata: true } });
    check('P20 the Owner exports the production sheet (the roster as submitted) and a design exactly as submitted, each export recorded',
      sheetRows.problems.length === 0 && JSON.stringify(sheetRows.entries) === JSON.stringify(R.validateEntries(rosterEntries)) && doc.name === 'P20 home shirt' && doc.format === 'familista.product-design'
      && exported.some((x) => x.action === 'manufacturing.sheet.exported' && x.metadata.entries === 3) && exported.some((x) => x.action === 'manufacturing.design.exported'),
      { entries: sheetRows.entries.length, file: design.suggestedFilename(), exported: exported.map((x) => x.action) });

    // ── 8. the console is the Owner's alone; another club reaches none of it ───────────────────────────────────────
    const asClub = await call('clubAdmin', 'GET', '/api/v1/system/manufacturing/requests');
    const asOther = await call('otherAdmin', 'GET', '/api/v1/club-design/requests/' + req.id);
    const offered = await cp.evaluate(() => !!document.querySelector('#pd-club-root [data-pd-act="mfg"]'));
    check('P20 the club is not offered the console and the server refuses it; another club’s administrator is refused the request (negative controls)',
      asClub.status === 403 && (asOther.status === 403 || asOther.status === 404) && !offered, { asClub: asClub.status, asOther: asOther.status, offered });

    if (fs.existsSync(axePath)) {
      const v1 = await runAxe(op, '#pg-product-design');
      check('P20 en-GB: axe finds no WCAG 2.2 A/AA violation in the Owner’s console with a request open', v1.length === 0, v1);
      const v2 = await runAxe(cp, '#pg-club-design');
      check('P20 en-GB: axe finds no WCAG 2.2 A/AA violation in the club’s request', v2.length === 0, v2);
    } else fail('P20 axe-core is not installed (npm ci --ignore-scripts --prefix tools/components)');
    check('P20 no CSP violation and no page error, in either room', (await csp(cp)).length === 0 && (await csp(op)).length === 0 && club.log.errors.length === 0 && owner.log.errors.length === 0,
      { club: club.log.errors, owner: owner.log.errors });
  } finally {
    await club.ctx.close();
    await owner.ctx.close();
  }

  // ── in Arabic, right to left: the club's request ───────────────────────────────────────────────────────────────
  const ar = await open({ width: 1672, height: 941 }, 'ar', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await ar.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
    await ar.page.click('#pd-club-root .pd-side [data-pd-act="team-requests"]');
    await ar.page.waitForSelector(CLUBP + ' [data-pd-act="req-open"]', { timeout: 15000 });
    await ar.page.click(CLUBP + ' [data-pd-act="req-open"]');
    await ar.page.waitForSelector(CLUBP + ' .pd-req-history', { timeout: 15000 });
    const view = await ar.page.evaluate((sel) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect();
      return { dir: getComputedStyle(el).direction, title: el.querySelector('#pd-team-title').textContent.trim(), chip: (el.querySelector('[data-pd-req-status]') || {}).textContent,
        amount: (el.querySelector('.pd-req-amount') || {}).textContent, inView: r.left >= 0 && r.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    }, CLUBP);
    await ar.page.screenshot({ path: path.join(OUT, 'p20-club-ar.png') });
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n/ar.json'), 'utf8'));
    check('P20 ar: the club opens its order from the side rail, right to left, in Arabic, the amount in its currency',
      view.dir === 'rtl' && view.title === words['Request for quotation'] && view.chip === words.Delivered && /1[,٬.]?234|١٬?٢٣٤/.test(view.amount || '') && view.inView && !view.overflow, view);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(ar.page, '#pg-club-design');
      check('P20 ar: axe finds no WCAG 2.2 A/AA violation in the club’s request', v.length === 0, v);
    }
  } finally { await ar.ctx.close(); }

  // ── M7a: manufacturing restricted to another plan; the club is told why, and the server refuses ─────────────────
  await db.featureFlag.create({ data: { key: 'club_design_manufacturing', name: 'Club Design Studio: manufacturing requests', defaultEnabled: false, enabledForPlans: ['PRO'] } });
  const gated = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await gated.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
    await gated.page.click('#pd-club-root [data-pd-act="team"]');
    await gated.page.waitForFunction(() => window.__familistaProductDesignMetrics().team.list === 'ready', null, { timeout: 15000 });
    const view = await gated.page.evaluate(() => {
      const orders = [...document.querySelectorAll('#pd-club-root .pd-side .pd-side-btn')].filter((b) => b.getAttribute('data-pd-reason') === 'not-in-plan');
      return { ordersPlanned: orders.length, requestsTab: !!document.querySelector('#pd-club-root .pd-team [data-pd-act="team-tab-requests"]'),
        collectionsTab: !!document.querySelector('#pd-club-root .pd-team [data-pd-act="team-tab-collections"]') };
    });
    const r = await call('clubAdmin', 'GET', '/api/v1/club-design/requests');
    check('P20 M7a: with manufacturing restricted to another plan, the club is not offered Orders or Requests (and is told why), the server refuses it, and the rest of the studio stays',
      view.ordersPlanned === 1 && !view.requestsTab && view.collectionsTab && r.status === 403 && r.body.code === 'DESIGN_FEATURE_NOT_ENABLED' && r.body.feature === 'club_design_manufacturing', { view, status: r.status, code: r.body.code });
  } finally {
    await gated.ctx.close();
    await db.featureFlag.delete({ where: { key: 'club_design_manufacturing' } });
  }
};
