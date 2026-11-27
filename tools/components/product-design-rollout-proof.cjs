/**
 * Design Studio browser proof, P24 — the Platform Owner's club releases (M8a), on the compiled application with a real
 * PostgreSQL database: the release made in the Owner's console is the one a club's session then gets.
 *
 *   · The console's Club releases tab lists every club with whether the studio is released to it.
 *   · The Owner withdraws one part from a club with a native radio choice: the change applies at once, is audited, and
 *     the club's own room no longer offers that part (and its server refuses it).
 *   · Set back to "as the plan says", the part returns; the database holds exactly the overrides chosen.
 *   · Focus stays on the choice made; axe in English and Arabic; no CSP violation, no page error.
 */
'use strict';

module.exports = async function p24(H) {
  const { open, check, OUT, ROOT, db, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
  const runAxe = (pg, scope) => pg.evaluate(async ([src, sel]) => {
    if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
    const r = await window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, [fs.readFileSync(axePath, 'utf8'), scope]);
  const OWNP = '#pd-root .pd-mfg';
  const call = (who, method, url) => fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + TOKENS[who], Accept: 'application/json' } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const limits = async () => db.organizationLimits.findUnique({ where: { clubId: 'club-1' }, select: { featuresEnabled: true, featuresDisabled: true } });
  // The club's own design, saved through the club's routes, so this section stands on its own.
  const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
  const tpl = C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/football-jersey.json'), 'utf8')));
  const saved = await fetch(BASE + '/api/v1/club-design/projects', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKENS.clubAdmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: C.createDocument(tpl, 'P24 release shirt'), origin: 'EDITOR' }) }).then((r) => r.json());
  const design = saved && saved.data && saved.data.project ? saved.data.project.id : null;

  async function releases(locale) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: 'owner', hash: '/#product-design', wait: false });
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.mfg; }, null, { timeout: 60000 });
    await s.page.click('#pd-root .pd-side [data-pd-act="mfg"][data-pd-tab="releases"]');
    await s.page.waitForFunction(() => window.__familistaProductDesignMetrics().mfg.releases === 'ready', null, { timeout: 20000 });
    return s;
  }

  const own = await releases('en-GB');
  const pg = own.page;
  try {
    const list = await pg.evaluate((sel) => [...document.querySelectorAll(sel + ' [data-pd-rel-club]')].map((li) => ({ id: li.getAttribute('data-pd-rel-club'), text: li.querySelector('.pd-dock-kicker').textContent })), OWNP);
    const home = list.find((c) => c.id === 'club-1');
    check('P24 the Owner’s Club releases tab lists every club with whether the studio is released to it',
      list.length >= 2 && !!home && /Studio released/.test(home.text) && list.some((c) => c.id === 'club-2'), list);

    await pg.click(OWNP + ' [data-pd-act="mfg-rel-open"][data-pd-id="club-1"]');
    await pg.waitForSelector(OWNP + ' [data-pd-rel-key="reviews"]', { timeout: 10000 });
    const before = await limits();
    await pg.check(OWNP + ' [data-pd-rel-key="reviews"][value="off"]');
    await pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics().mfg; return !m.releaseBusy; }, null, { timeout: 10000 });
    await pg.waitForFunction((sel) => { const c = document.querySelector(sel + ' [data-pd-rel="reviews"] .pd-rel-chip'); return c && c.getAttribute('data-included') === 'false'; }, OWNP, { timeout: 10000 });
    const focus = await pg.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-pd-mfg-key'));
    const after = await limits();
    const audit = await db.platformAuditLog.findFirst({ where: { action: 'design.rollout.changed', resourceId: 'club-1' }, orderBy: { createdAt: 'desc' }, select: { metadata: true } });
    check('P24 withdrawing one part from a club applies at once, keeps focus on the choice made, is audited, and touches nothing else',
      after.featuresDisabled.includes('club_design_reviews') && JSON.stringify(after.featuresEnabled) === JSON.stringify(before.featuresEnabled) && focus === 'rel-reviews-off'
      && !!audit && audit.metadata.changed.length === 1 && ['key', 'from', 'to'].map((k) => audit.metadata.changed[0][k]).join() === 'club_design_reviews,default,off', { before, after, focus, audit: audit && audit.metadata });

    // The club's own session: the part is not offered, and the server refuses it.
    const club = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false });
    try {
      await club.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
      const offered = await club.page.evaluate(() => ({ button: !!document.querySelector('#pd-club-root .pd-actions [data-pd-act="review"]'), review: window.__familistaProductDesignMetrics().review }));
      const r = await call('clubAdmin', 'GET', '/api/v1/club-design/requests');
      const refused = design ? await call('clubAdmin', 'GET', '/api/v1/club-design/projects/' + design + '/review') : { status: 0, body: {} };
      check('P24 the club’s own room then offers no review, and the server refuses it; the rest of the studio stays',
        !offered.button && offered.review === null && refused.status === 403 && refused.body.feature === 'club_design_reviews' && r.status === 200, { offered, refused: refused.status, other: r.status });
    } finally { await club.ctx.close(); }

    // Back to "as the plan says": the override is gone, the part returns.
    await pg.check(OWNP + ' [data-pd-rel-key="reviews"][value="default"]');
    await pg.waitForFunction((sel) => { const c = document.querySelector(sel + ' [data-pd-rel="reviews"] .pd-rel-chip'); return c && c.getAttribute('data-included') === 'true'; }, OWNP, { timeout: 10000 });
    const back = await limits();
    check('P24 set back to “as the plan says”, the override is gone and the part is included again',
      !back.featuresDisabled.includes('club_design_reviews') && !back.featuresEnabled.includes('club_design_reviews') && back.featuresEnabled.includes('club_design_studio'), back);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(pg, OWNP);
      check('P24 en: axe finds no WCAG 2.2 A/AA violation in a club’s release', v.length === 0, v);
    }
    await pg.screenshot({ path: path.join(OUT, 'p24-releases-en.png') });
    check('P24 no CSP violation and no page error', (await csp(pg)).length === 0 && own.log.errors.length === 0, own.log.errors);
  } finally { await own.ctx.close(); }

  const ar = await releases('ar');
  try {
    await ar.page.click(OWNP + ' [data-pd-act="mfg-rel-open"][data-pd-id="club-1"]');
    await ar.page.waitForSelector(OWNP + ' [data-pd-rel-key="studio"]', { timeout: 10000 });
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n/ar.json'), 'utf8'));
    const view = await ar.page.evaluate((sel) => { const el = document.querySelector(sel), r = el.getBoundingClientRect();
      return { dir: getComputedStyle(el).direction, opt: document.querySelector(sel + ' [data-pd-rel="studio"] .pd-rel-opt span').textContent, inView: r.left >= 0 && r.right <= innerWidth }; }, OWNP);
    await ar.page.screenshot({ path: path.join(OUT, 'p24-releases-ar.png') });
    check('P24 ar: a club’s release in Arabic, right to left', view.dir === 'rtl' && view.opt === words['On for this club'] && view.inView, view);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(ar.page, OWNP);
      check('P24 ar: axe finds no WCAG 2.2 A/AA violation in a club’s release', v.length === 0, v);
    }
  } finally { await ar.ctx.close(); }
};
