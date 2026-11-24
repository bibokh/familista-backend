/**
 * Design Studio browser proof, P21 — a design's review (M7b), in the Club Design Studio, on the compiled application with
 * a real PostgreSQL database under row-level security, in two real browsers: the club's administrator and a manager.
 *
 *   · The saved design in the editor is reviewed from the saved-designs panel's third tab; opening it moves nothing.
 *   · A manager comments on one surface of the garment, and is not offered the decision (the server refuses it too).
 *   · Typing a comment keeps the caret where it is: nothing is redrawn while the reader types.
 *   · The administrator resolves and reopens the comment, approves the version, then asks for changes, which needs a note.
 *   · Each decision is pinned to the version's own hash in the database; the collection shows the current one.
 *   · axe in English and Arabic; right to left in Arabic; no CSP violation, no page error.
 * Every comment and decision written here belongs to the proof's own throwaway database.
 */
'use strict';

module.exports = async function p21(H) {
  const { open, check, fail, OUT, ROOT, db, BASE, TOKENS } = H;
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
  const DOCK = '#pd-club-root .pd-dock';
  const RV = (pg) => pg.evaluate(() => window.__familistaProductDesignMetrics().review);
  const ready = (pg, extra) => pg.waitForFunction((x) => { const r = window.__familistaProductDesignMetrics().review; return !!r && r.state === 'ready' && !r.busy && (!x || Object.keys(x).every((k) => r[k] === x[k])); }, extra || null, { timeout: 20000 });

  // ── the club's design and a collection of it, saved through the club's own routes ─────────────────────────────────
  const shirt = (await call('clubAdmin', 'POST', '/api/v1/club-design/projects', { document: C.createDocument(tpl('football-jersey.json'), 'P21 review shirt'), origin: 'EDITOR' })).body.data.project.id;
  const kit = shirt && (await call('clubAdmin', 'POST', '/api/v1/club-design/collections', { name: 'P21 reviewed kit', items: [{ projectId: shirt, role: 'HOME' }] })).body.data.collection.id;
  if (!shirt || !kit) { fail('P21 the club’s design could not be prepared', { shirt, kit }); return; }

  /** Opens the club's room as `who`, the saved design in the editor and its Review tab. */
  async function reviewRoom(who, locale) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: who, hash: '/#club-design', wait: false });
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.review; }, null, { timeout: 60000 });
    await s.page.click('#pd-club-root .pd-actions [data-pd-act="projects"]');
    await s.page.waitForSelector(DOCK + ' [data-pd-act="open-project"][data-pd-id="' + shirt + '"]', { timeout: 15000 });
    await s.page.click(DOCK + ' [data-pd-act="open-project"][data-pd-id="' + shirt + '"]');
    await s.page.waitForFunction((id) => { const m = window.__familistaProductDesignMetrics(); return m.server && m.server.state === 'saved' && document.querySelector('#pd-club-root .pd-docname').value === 'P21 review shirt'; }, shirt, { timeout: 20000 });
    await s.page.click('#pd-club-root .pd-actions [data-pd-act="review"]');
    await ready(s.page);
    return s;
  }

  // ── 1. a manager comments on the back of the shirt, and is not offered the decision ────────────────────────────────
  const mgr = await reviewRoom('clubManager', 'en-GB');
  const mp = mgr.page;
  try {
    const offered = await mp.evaluate((sel) => ({ approve: !!document.querySelector(sel + ' [data-pd-act="rv-approve"]'), ask: !!document.querySelector(sel + ' [data-pd-act="rv-ask"]'),
      tab: (document.querySelector(sel + ' [data-pd-docktab="review"]') || {}).getAttribute && document.querySelector(sel + ' [data-pd-docktab="review"]').getAttribute('aria-selected'),
      chip: (document.querySelector(sel + ' .pd-rv-current .pd-rv-chip') || {}).getAttribute && document.querySelector(sel + ' .pd-rv-current .pd-rv-chip').getAttribute('data-decision') }), DOCK);
    const refused = await call('clubManager', 'POST', '/api/v1/club-design/projects/' + shirt + '/decisions', { revision: 1, decision: 'APPROVED' });
    check('P21 a manager opens the design’s Review tab, sees it not reviewed, and is not offered the decision (the server refuses it too)',
      offered.tab === 'true' && offered.chip === 'none' && !offered.approve && !offered.ask && refused.status === 403, { offered, refused: refused.status });

    await mp.selectOption(DOCK + ' [data-pd-rv="surface"]', 'back');
    const before = await mp.evaluate((sel) => { const a = document.querySelector(sel + ' [data-pd-rv="body"]'); return a.getBoundingClientRect().top; }, DOCK);
    await mp.click(DOCK + ' [data-pd-rv="body"]');
    await mp.keyboard.type('Make the number on the back taller', { delay: 5 });
    const typing = await mp.evaluate((sel) => { const a = document.querySelector(sel + ' [data-pd-rv="body"]'); return { same: document.activeElement === a, caret: a.selectionStart, length: a.value.length, top: a.getBoundingClientRect().top }; }, DOCK);
    check('P21 typing a comment redraws nothing: the field keeps focus, the caret and its place', typing.same && typing.caret === typing.length && typing.length === 34 && Math.abs(typing.top - before) < 0.5, { typing, before });
    await mp.click(DOCK + ' [data-pd-act="rv-comment"]');
    await ready(mp, { comments: 1, open: 1 });
    const row = await db.designReviewComment.findFirst({ where: { projectId: shirt }, select: { surface: true, revision: true, body: true, authorId: true } });
    const shown = await mp.evaluate((sel) => { const li = document.querySelector(sel + ' .pd-rv-comment'); return li ? { text: li.querySelector('.pd-req-note').textContent, user: li.querySelector('.pd-req-note').hasAttribute('data-user-content'), surface: li.querySelector('.pd-chip').textContent } : null; }, DOCK);
    check('P21 the comment is kept on version 1’s back, by the manager, and shown as written',
      !!row && row.surface === 'back' && row.revision === 1 && row.authorId === 'u-cmanager' && !!shown && shown.text === 'Make the number on the back taller' && shown.user && shown.surface === 'Back', { row, shown });
    check('P21 manager: no CSP violation and no page error', (await csp(mp)).length === 0 && mgr.log.errors.length === 0, mgr.log.errors);
  } finally { await mgr.ctx.close(); }

  // ── 2. the administrator resolves, reopens, approves, then asks for changes with a note ─────────────────────────────
  const adm = await reviewRoom('clubAdmin', 'en-GB');
  const ap = adm.page;
  try {
    const layout = await ap.evaluate(() => { const w = document.querySelector('#pd-club-root .pd-work').getBoundingClientRect(); return [w.top, w.left, w.width, w.height].map((x) => Math.round(x)); });
    await ap.click(DOCK + ' [data-pd-act="close-dock"]');
    const closed = await ap.evaluate(() => { const w = document.querySelector('#pd-club-root .pd-work').getBoundingClientRect(); return [w.top, w.left, w.width, w.height].map((x) => Math.round(x)); });
    check('P21 opening and closing the Review tab moves nothing beneath it', JSON.stringify(layout) === JSON.stringify(closed), { layout, closed });
    await ap.click('#pd-club-root .pd-actions [data-pd-act="review"]');
    await ready(ap, { comments: 1 });

    await ap.click(DOCK + ' [data-pd-act="rv-resolve"]');
    await ready(ap, { open: 0 });
    const emptyOpen = await ap.evaluate((sel) => (document.querySelector(sel + ' .pd-empty') || {}).textContent, DOCK);
    await ap.click(DOCK + ' [data-pd-act="rv-filter-resolved"]');
    await ap.waitForSelector(DOCK + ' .pd-rv-comment.is-resolved [data-pd-act="rv-reopen"]', { timeout: 10000 });
    await ap.click(DOCK + ' [data-pd-act="rv-reopen"]');
    await ready(ap, { open: 1 });
    check('P21 the administrator resolves the comment (the open list says every comment is resolved) and reopens it', emptyOpen === 'Every comment is resolved.', { emptyOpen });

    await ap.click(DOCK + ' [data-pd-act="rv-approve"]');
    await ready(ap, { current: 'APPROVED' });
    const [rev, appr] = await Promise.all([db.designRevision.findFirst({ where: { projectId: shirt, number: 1 }, select: { sha256: true } }),
      db.designApproval.findMany({ where: { projectId: shirt }, select: { decision: true, revision: true, sha256: true, decidedById: true } })]);
    const head = await ap.evaluate((sel) => ({ chip: document.querySelector(sel + ' .pd-rv-current .pd-rv-chip').getAttribute('data-decision'), approve: !!document.querySelector(sel + ' [data-pd-act="rv-approve"]'),
      colour: getComputedStyle(document.querySelector(sel + ' .pd-rv-current .pd-rv-chip')).borderTopColor }), DOCK);
    check('P21 the administrator approves version 1: one decision, pinned to its own hash; the panel says so and offers no second approval',
      appr.length === 1 && appr[0].decision === 'APPROVED' && appr[0].revision === 1 && appr[0].sha256 === rev.sha256 && appr[0].decidedById === 'u-cadmin' && head.chip === 'APPROVED' && !head.approve, { appr, head });

    await ap.click(DOCK + ' [data-pd-act="rv-ask"]');
    const focused = await ap.evaluate((sel) => document.activeElement === document.querySelector(sel + ' [data-pd-rv="note"]'), DOCK);
    await ap.click(DOCK + ' [data-pd-act="rv-ask-send"]');
    const refused = await ap.evaluate((sel) => (document.querySelector(sel + ' .pd-note--warn[role="alert"]') || {}).textContent, DOCK);
    const stillOne = await db.designApproval.count({ where: { projectId: shirt } });
    await ap.fill(DOCK + ' [data-pd-rv="note"]', 'The sponsor is too small');
    await ap.click(DOCK + ' [data-pd-act="rv-ask-send"]');
    await ready(ap, { current: 'CHANGES_REQUESTED' });
    const hist = await ap.evaluate((sel) => [...document.querySelectorAll(sel + ' [data-pd-rv-decision]')].map((li) => li.getAttribute('data-pd-rv-decision')), DOCK);
    check('P21 asking for changes needs a note (focused, refused without one, nothing written), then is kept and listed above the approval',
      focused && refused === 'Say what should change.' && stillOne === 1 && JSON.stringify(hist) === JSON.stringify(['CHANGES_REQUESTED', 'APPROVED']), { focused, refused, stillOne, hist });
    await ap.screenshot({ path: path.join(OUT, 'p21-review-en.png') });

    if (fs.existsSync(axePath)) {
      const v = await runAxe(ap, DOCK);
      check('P21 en: axe finds no WCAG 2.2 A/AA violation in the Review tab', v.length === 0, v);
    }

    // The collection shows the design's current decision.
    await ap.click(DOCK + ' [data-pd-act="close-dock"]');
    await ap.click('#pd-club-root [data-pd-act="team"]');
    await ap.click('#pd-club-root .pd-team [data-pd-act="team-tab-collections"]');
    await ap.waitForSelector('#pd-club-root .pd-team [data-pd-act="col-open"][data-pd-id="' + kit + '"]', { timeout: 15000 });
    await ap.click('#pd-club-root .pd-team [data-pd-act="col-open"][data-pd-id="' + kit + '"]');
    await ap.waitForSelector('#pd-club-root .pd-team [data-pd-col-approval]', { timeout: 15000 });
    const inKit = await ap.evaluate(() => document.querySelector('#pd-club-root .pd-team [data-pd-col-approval]').getAttribute('data-pd-col-approval'));
    check('P21 the collection shows the design’s current decision on its newest version', inKit === 'CHANGES_REQUESTED', { inKit });
    check('P21 administrator: no CSP violation and no page error', (await csp(ap)).length === 0 && adm.log.errors.length === 0, adm.log.errors);
  } finally { await adm.ctx.close(); }

  // ── 3. in Arabic, right to left ─────────────────────────────────────────────────────────────────────────────────
  const ar = await reviewRoom('clubAdmin', 'ar');
  try {
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n/ar.json'), 'utf8'));
    const view = await ar.page.evaluate((sel) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect();
      return { dir: getComputedStyle(el).direction, tab: document.querySelector(sel + ' [data-pd-docktab="review"]').textContent.trim(), chip: document.querySelector(sel + ' .pd-rv-current .pd-rv-chip').textContent,
        body: document.querySelector(sel + ' .pd-rv-comment .pd-req-note').textContent, inView: r.left >= 0 && r.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    }, DOCK);
    await ar.page.screenshot({ path: path.join(OUT, 'p21-review-ar.png') });
    check('P21 ar: the Review tab in Arabic, right to left; what people wrote stays as they wrote it',
      view.dir === 'rtl' && view.tab === words.Review && view.chip === words['Changes requested'] && view.body === 'Make the number on the back taller' && view.inView && !view.overflow, view);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(ar.page, DOCK);
      check('P21 ar: axe finds no WCAG 2.2 A/AA violation in the Review tab', v.length === 0, v);
    }
  } finally { await ar.ctx.close(); }

  // ── the action bar with Review in it, at the narrowest desktop width: every control in view, nothing overflowing ──
  for (const width of [1280, 1440]) {
    const s = await open({ width, height: 800 }, 'de-DE', { as: 'clubAdmin', hash: '/#club-design', wait: false });
    try {
      await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.review; }, null, { timeout: 60000 });
      const bar = await s.page.evaluate(() => {
        const b = document.querySelector('#pd-club-root .pd-actions'), r = b.getBoundingClientRect();
        const out = [...b.querySelectorAll('.pd-actions-start > button, .pd-actions-end button')].filter((x) => { const q = x.getBoundingClientRect(); return q.left < r.left - 0.5 || q.right > r.right + 0.5 || q.width < 24; }).map((x) => x.textContent.trim() || x.getAttribute('aria-label'));
        return { lang: document.querySelector('#pd-club-root').getAttribute('lang'), out, overflow: b.scrollWidth > b.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth + 1,
          review: (b.querySelector('[data-pd-act="review"]') || {}).textContent };
      });
      await s.page.screenshot({ path: path.join(OUT, 'p21-actions-' + width + '.png') });
      check('P21 ' + width + ' px, in German: the action bar keeps Review and every other control in view, and nothing overflows', /^de/.test(bar.lang) && bar.review === 'Prüfung' && !bar.out.length && !bar.overflow && !bar.page, bar);
    } finally { await s.ctx.close(); }
  }

  // ── M7b: reviews switched off for the club; the tab is not offered and the server refuses ───────────────────────
  await db.organizationLimits.update({ where: { clubId: 'club-1' }, data: { featuresDisabled: { push: 'club_design_reviews' } } });
  const off = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await off.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
    const view = await off.page.evaluate(() => ({ button: !!document.querySelector('#pd-club-root .pd-actions [data-pd-act="review"]'), review: window.__familistaProductDesignMetrics().review }));
    const r = await call('clubAdmin', 'GET', '/api/v1/club-design/projects/' + shirt + '/review');
    check('P21 M7b: with reviews off for the club, Review is not offered, the server refuses it, and the rest of the studio stays',
      !view.button && view.review === null && r.status === 403 && r.body.feature === 'club_design_reviews', { view, status: r.status, feature: r.body.feature });
  } finally {
    await off.ctx.close();
    const lim = await db.organizationLimits.findUnique({ where: { clubId: 'club-1' }, select: { featuresDisabled: true } });
    await db.organizationLimits.update({ where: { clubId: 'club-1' }, data: { featuresDisabled: lim.featuresDisabled.filter((f) => f !== 'club_design_reviews') } });
  }
};
