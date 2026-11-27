/**
 * Design Studio browser proof, P25 — the privacy foundation (P1), on the compiled application with a real PostgreSQL
 * database, in the club's room and the Owner's.
 *
 *   · A roster with a child's size says it counts as including minors; the club can mark one too.
 *   · Asking for a quotation for such a roster: a club administrator is offered the guardian-consent attestation, a
 *     manager is told only an administrator can give it; without it the request keeps no names (the database says so).
 *   · A club administrator erases a person's name: found first, then erased from rosters and requests.
 *   · The Owner's console: no production sheet before the order is confirmed; the Privacy tab sets a retention rule,
 *     previews it and applies it, and says the platform's automatic retention is not switched on.
 *   · axe in English and Arabic; no CSP violation, no page error.
 */
'use strict';

module.exports = async function p25(H) {
  const { open, check, OUT, ROOT, db, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
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
  const TEAM = '#pd-club-root .pd-team', OWNP = '#pd-root .pd-mfg';
  const E = (o) => Object.assign({ name: 'PLAYER', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1 }, o || {});

  // ── the club's kit: a design, a youth roster, a collection made for it ───────────────────────────────────────────
  const shirt = (await call('clubAdmin', 'POST', '/api/v1/club-design/projects', { document: C.createDocument(tpl('football-jersey.json'), 'P25 youth shirt'), origin: 'EDITOR' })).body.data.project.id;
  const youth = (await call('clubAdmin', 'POST', '/api/v1/club-design/rosters', { name: 'P25 under 12', entries: [E({ name: 'LITTLE', number: 7, top: '140', shorts: '140' }), E({ name: 'SMALL', number: 8, top: '128', shorts: '128' })] })).body.data.roster.id;
  const kit = (await call('clubAdmin', 'POST', '/api/v1/club-design/collections', { name: 'P25 youth kit', rosterId: youth, items: [{ projectId: shirt, role: 'HOME' }] })).body.data.collection.id;

  async function teamRoom(who, locale) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: who, hash: '/#club-design', wait: false });
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
    await s.page.click('#pd-club-root [data-pd-act="team"]');
    await s.page.waitForFunction(() => window.__familistaProductDesignMetrics().team.list === 'ready', null, { timeout: 15000 });
    return s;
  }
  async function openKitAsk(pg) {
    await pg.click(TEAM + ' [data-pd-act="team-tab-collections"]');
    await pg.waitForSelector(TEAM + ' [data-pd-act="col-open"][data-pd-id="' + kit + '"]', { timeout: 15000 });
    await pg.click(TEAM + ' [data-pd-act="col-open"][data-pd-id="' + kit + '"]');
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().team.collections.sheet === 'ready', null, { timeout: 20000 });
    await pg.click(TEAM + ' [data-pd-act="col-ask"]');
    await pg.waitForSelector(TEAM + ' .pd-col-minors', { timeout: 10000 });
  }

  // ── 1. the club administrator: the roster's minors, the consent step, a request without names ────────────────────
  const adm = await teamRoom('clubAdmin', 'en-GB');
  const ap = adm.page;
  try {
    await ap.click(TEAM + ' [data-pd-act="team-open"][data-pd-id="' + youth + '"]');
    await ap.waitForSelector(TEAM + ' [data-pd-team-minors]', { timeout: 15000 });
    const roster = await ap.evaluate((sel) => ({ checked: document.querySelector(sel + ' [data-pd-team-minors]').checked, note: (document.querySelector(sel + ' [data-pd-team-minors-note]') || {}).textContent || '' }), TEAM);
    check('P25 a roster in children’s sizes says it counts as including minors, and what that means for its names',
      !roster.checked && /2 entries are in a children’s size/.test(roster.note) && /only if a club administrator confirms/.test(roster.note), roster);
    await ap.click(TEAM + ' [data-pd-act="team-back"]');
    await openKitAsk(ap);
    const offered = await ap.evaluate((sel) => ({ consent: !!document.querySelector(sel + ' [data-pd-col-ask="minorsConsent"]'), text: document.querySelector(sel + ' .pd-col-minors').textContent }), TEAM);
    await ap.click(TEAM + ' [data-pd-act="col-ask-send"]');
    await ap.waitForFunction(() => { const r = window.__familistaProductDesignMetrics().team; return r && r.view === 'request'; }, null, { timeout: 20000 }).catch(() => null);
    const sent = await db.manufacturingRequest.findFirst({ where: { collectionId: kit }, orderBy: { createdAt: 'desc' }, select: { id: true, minors: true, minorsConsentAt: true, persons: { select: { name: true, state: true } } } });
    check('P25 an administrator is offered the guardian-consent attestation; sent without it, the request keeps no name at all',
      offered.consent && /Without a guardian’s consent/.test(offered.text) && !!sent && sent.minors && !sent.minorsConsentAt && sent.persons.length === 2 && sent.persons.every((p) => p.name === null && p.state === 'WITHHELD'),
      { offered, sent });
    await ap.waitForSelector(TEAM + ' [data-pd-req-people]', { timeout: 15000 });
    const line = await ap.evaluate((sel) => document.querySelector(sel + ' [data-pd-req-people]').textContent, TEAM);
    check('P25 the club’s request says its names were withheld because they are minors’', /0 kept · 2 withheld · 0 erased/.test(line) && /their names were not sent/.test(line), line);

    // Erasing a person's name: found first, then erased.
    await ap.click(TEAM + ' [data-pd-act="team-back"]');
    await ap.waitForSelector(TEAM + ' [data-pd-act="team-tab-rosters"]', { timeout: 10000 });
    await ap.click(TEAM + ' [data-pd-act="team-tab-rosters"]');
    await ap.waitForSelector(TEAM + ' [data-pd-act="team-erase"]', { timeout: 15000 });
    await ap.click(TEAM + ' [data-pd-act="team-erase"]');
    await ap.fill(TEAM + ' [data-pd-team-erase-name]', 'little');
    await ap.click(TEAM + ' [data-pd-act="team-erase-preview"]');
    await ap.waitForSelector(TEAM + ' [data-pd-team-erase-preview]', { timeout: 10000 });
    const preview = await ap.evaluate((sel) => document.querySelector(sel + ' [data-pd-team-erase-preview]').textContent, TEAM);
    await ap.click(TEAM + ' [data-pd-act="team-erase-confirm"]');
    await ap.waitForSelector(TEAM + ' [data-pd-team-erase-done]', { timeout: 10000 });
    const left = await db.designRoster.findUnique({ where: { id: youth }, select: { entryCount: true, version: true } });
    check('P25 a club administrator finds a person’s name first, then erases it from the roster', /Found in 1 rosters \(1 entries\)/.test(preview) && left.entryCount === 1 && left.version === 2, { preview, left });
    if (fs.existsSync(axePath)) {
      const v = await runAxe(ap, TEAM);
      check('P25 en: axe finds no WCAG 2.2 A/AA violation in the Team panel’s privacy controls', v.length === 0, v);
    }
    check('P25 club administrator: no CSP violation and no page error', (await csp(ap)).length === 0 && adm.log.errors.length === 0, adm.log.errors);
  } finally { await adm.ctx.close(); }

  // ── 2. a manager: told only an administrator attests consent; offered no erasure ────────────────────────────────
  const mgr = await teamRoom('clubManager', 'ar');
  try {
    const noErase = await mgr.page.evaluate((sel) => !document.querySelector(sel + ' [data-pd-act="team-erase"]'), TEAM);
    await openKitAsk(mgr.page);
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n/ar.json'), 'utf8'));
    const view = await mgr.page.evaluate((sel) => ({ consent: !!document.querySelector(sel + ' [data-pd-col-ask="minorsConsent"]'), text: document.querySelector(sel + ' .pd-col-minors').textContent, dir: getComputedStyle(document.querySelector(sel)).direction }), TEAM);
    check('P25 ar: a manager is told only a club administrator confirms consent, and offered no erasure; right to left',
      noErase && !view.consent && view.text.includes(words['Only a club administrator can confirm that consent.']) && view.dir === 'rtl', view);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(mgr.page, TEAM);
      check('P25 ar: axe finds no WCAG 2.2 A/AA violation in the consent step', v.length === 0, v);
    }
  } finally { await mgr.ctx.close(); }

  // ── 3. the Owner: no sheet before the order; the Privacy tab ─────────────────────────────────────────────────────
  const own = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'owner', hash: '/#product-design', wait: false });
  const op = own.page;
  try {
    await op.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.mfg; }, null, { timeout: 60000 });
    const sent = await db.manufacturingRequest.findFirst({ where: { collectionId: kit }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    await op.click('#pd-root .pd-side [data-pd-act="mfg"][data-pd-tab="requests"]');
    await op.waitForSelector(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + sent.id + '"]', { timeout: 15000 });
    await op.click(OWNP + ' [data-pd-act="mfg-open-request"][data-pd-id="' + sent.id + '"]');
    await op.waitForSelector(OWNP + ' [data-pd-mfg-people]', { timeout: 15000 });
    const req = await op.evaluate((sel) => ({ sheet: !!document.querySelector(sel + ' [data-pd-act="mfg-sheet"]'), people: document.querySelector(sel + ' [data-pd-mfg-people]').textContent }), OWNP);
    const api = await call('owner', 'POST', '/api/v1/system/manufacturing/requests/' + sent.id + '/production-sheet');
    check('P25 the Owner is offered no production sheet before the order is confirmed with its supplier, and the server refuses it',
      !req.sheet && /2 withheld/.test(req.people) && api.status === 409 && api.body.code === 'SHEET_NOT_AVAILABLE', { req, status: api.status });

    await op.click(OWNP + ' [data-pd-act="mfg-back"]');
    await op.click(OWNP + ' [data-pd-act="mfg-tab-privacy"]');
    await op.waitForSelector(OWNP + ' [data-pd-ret="DesignReviewComment"]', { timeout: 15000 });
    const before = await op.evaluate((sel) => ({ chips: [...document.querySelectorAll(sel + ' [data-pd-ret] .pd-rel-chip')].map((c) => c.textContent), info: document.querySelector(sel + ' .pd-note--info').textContent }), OWNP);
    await op.fill(OWNP + ' [data-pd-ret-days="DesignReviewComment"]', '45');
    await op.click(OWNP + ' [data-pd-act="mfg-ret-save"][data-pd-id="DesignReviewComment"]');
    await op.waitForFunction((sel) => /After 45 days/.test(document.querySelector(sel + ' [data-pd-ret="DesignReviewComment"] .pd-rel-chip').textContent), OWNP, { timeout: 10000 });
    await op.click(OWNP + ' [data-pd-act="mfg-ret-preview"]');
    await op.waitForSelector(OWNP + ' [data-pd-ret-result="preview"]', { timeout: 10000 });
    await op.click(OWNP + ' [data-pd-act="mfg-ret-apply"]');
    await op.waitForSelector(OWNP + ' [data-pd-ret-result="applied"]', { timeout: 10000 });
    const rule = await db.dataRetentionPolicy.findFirst({ where: { clubId: null, entityType: 'DesignReviewComment' }, select: { retentionDays: true } });
    const applied = await db.platformAuditLog.count({ where: { action: 'privacy.retention.applied' } });
    check('P25 the Owner’s Privacy tab: no rule until set; set, previewed, applied and recorded; says automatic retention is off',
      JSON.stringify(before.chips) === JSON.stringify(['Not set', 'Not set']) && /not switched on/.test(before.info) && !!rule && rule.retentionDays === 45 && applied >= 1, { before, rule, applied });
    await call('owner', 'PUT', '/api/v1/system/product-design/privacy/retention', { kind: 'DesignReviewComment', days: null });
    await op.screenshot({ path: path.join(OUT, 'p25-privacy-owner.png') });
    if (fs.existsSync(axePath)) {
      const v = await runAxe(op, OWNP);
      check('P25 en: axe finds no WCAG 2.2 A/AA violation in the Owner’s Privacy tab', v.length === 0, v);
    }
    check('P25 Owner: no CSP violation and no page error', (await csp(op)).length === 0 && own.log.errors.length === 0, own.log.errors);
  } finally { await own.ctx.close(); }
};
