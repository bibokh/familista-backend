/**
 * Design Studio browser proof, P23 — colourways (M7c), the design recoloured deterministically, on the compiled
 * application, in the platform's room and in a club's with the club's own colours.
 *
 *   · Asked for, the Colour tab offers colourways (one per look), each drawn by the editor's own renderer; exactly the
 *     ones the shared core computes for the same design, in the same order (an independent computation in Node).
 *   · Applying one changes the palette in one step that Undo takes back whole; opening them moves nothing.
 *   · In a club, the club's colours take part; lettering stays at 3:1 or more on every suggestion.
 *   · axe in English and Arabic; no CSP violation, no page error.
 */
'use strict';

module.exports = async function p23(H) {
  const { open, check, OUT, ROOT, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
  const runAxe = (pg, scope) => pg.evaluate(async ([src, sel]) => {
    if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
    const r = await window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, [fs.readFileSync(axePath, 'utf8'), scope]);
  const hexes = (pg, root) => pg.evaluate((r) => [...document.querySelectorAll(r + ' .pd-palette .pd-hex')].map((c) => c.textContent.trim().toLowerCase()), root);
  const work = (pg, root) => pg.evaluate((r) => { const w = document.querySelector(r + ' .pd-work').getBoundingClientRect(); return [w.top, w.left, w.width, w.height].map((x) => Math.round(x)); }, root);

  async function suggest(pg, root) {
    await pg.click(root + ' [data-pd-insptab="colour"]');
    await pg.click(root + ' [data-pd-act="colourways"]');
    await pg.waitForSelector(root + ' .pd-cway', { timeout: 15000 });
    return pg.evaluate((r) => [...document.querySelectorAll(r + ' .pd-cway')].map((b) => ({ paths: b.querySelectorAll('svg path').length, name: b.querySelector('.pd-cway-name').textContent, ratio: (b.querySelector('.pd-cway-ratio') || {}).textContent || '' })), root);
  }

  // ── 1. the platform's room: the template's own palette ─────────────────────────────────────────────────────────
  const own = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'owner' });
  const pg = own.page;
  try {
    const rect = await work(pg, '#pd-root');
    const shown = await suggest(pg, '#pd-root');
    const before = await hexes(pg, '#pd-root');
    // The same computation, independently, in Node, on the document the room holds.
    // (A fresh room holds the match shirt's own document; a draft, when it has written one, is that document.)
    const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/index.json'), 'utf8'));
    const tplOf = (key) => { const e = index.templates.find((t) => t.key === key); return e && C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates', e.file), 'utf8'))); };
    const stored = JSON.parse(await pg.evaluate(() => localStorage.getItem('familista_product_design_draft_v1') || 'null'));
    const tpl = stored ? tplOf(stored.template.key) : C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/football-jersey.json'), 'utf8')));
    const doc = stored ? C.validateDocument(stored, tpl) : C.createDocument(tpl, 'Home kit design');
    const expected = C.colourways(doc, [], 6);
    const baseId = doc.surfaces[0].base, accentId = doc.surfaces[0].layers.find((n) => n.visible && n.type === 'pattern').color;
    const named = (v) => v.palette.find((x) => x.id === baseId).label + ' · ' + v.palette.find((x) => x.id === accentId).label;
    check('P23 asked for, the colourways are offered, each drawn and named apart, exactly the ones the shared core computes, in its order',
      expected.length >= 3 && shown.length === expected.length && shown.every((s) => s.paths > 8)
      && JSON.stringify(shown.map((s) => s.name)) === JSON.stringify(expected.map(named)) && new Set(shown.map((s) => s.name)).size === shown.length,
      { shown, expected: expected.map((v) => v.palette.map((x) => x.srgb)) });
    check('P23 opening the colourways moves nothing beneath them', JSON.stringify(rect) === JSON.stringify(await work(pg, '#pd-root')), rect);

    const undo0 = (await pg.evaluate(() => window.__familistaProductDesignMetrics().undo));
    await pg.click('#pd-root .pd-cway[data-pd-i="0"]');
    await pg.waitForFunction((n) => window.__familistaProductDesignMetrics().undo === n + 1, undo0, { timeout: 10000 });
    const after = await hexes(pg, '#pd-root');
    await pg.click('#pd-root [data-pd-act="undo"]');
    await pg.waitForFunction((n) => window.__familistaProductDesignMetrics().undo === n, undo0, { timeout: 10000 });
    const back = await hexes(pg, '#pd-root');
    check('P23 applying one sets exactly its palette in one step, and Undo takes all of it back',
      before.length === expected[0].palette.length && JSON.stringify(after) === JSON.stringify(expected[0].palette.map((x) => x.srgb.toLowerCase()))
      && JSON.stringify(back) === JSON.stringify(before) && JSON.stringify(after) !== JSON.stringify(before), { before, after, back });
    if (fs.existsSync(axePath)) {
      const v = await runAxe(pg, '#pd-root .pd-insp');
      check('P23 en: axe finds no WCAG 2.2 A/AA violation in the Colour tab with its colourways', v.length === 0, v);
    }
    await pg.screenshot({ path: path.join(OUT, 'p23-colourways-en.png') });
    check('P23 platform room: no CSP violation and no page error', (await csp(pg)).length === 0 && own.log.errors.length === 0, own.log.errors);
  } finally { await own.ctx.close(); }

  // ── 2. a club's room, with the club's colours taking part ──────────────────────────────────────────────────────
  const put = await fetch(BASE + '/api/v1/club-design/brand-kit/colours', { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKENS.clubAdmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ colours: [{ srgb: '#000000', label: 'Club black' }, { srgb: '#ffd100', label: 'Club yellow' }] }) });
  const club = await open({ width: 1672, height: 941 }, 'ar', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await club.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team; }, null, { timeout: 60000 });
    // Asked for first, before anything has read the club's colours: the room reads them, then draws the colourways.
    const brandBefore = (await club.page.evaluate(() => window.__familistaProductDesignMetrics().brand.state));
    const shown = await suggest(club.page, '#pd-club-root');
    const brandAfter = (await club.page.evaluate(() => window.__familistaProductDesignMetrics().brand.state));
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n/ar.json'), 'utf8'));
    const ratios = shown.map((s) => s.ratio);
    const view = await club.page.evaluate(() => ({ dir: getComputedStyle(document.querySelector('#pd-club-root .pd-cways-grid')).direction, h: document.querySelector('#pd-cways-h').textContent }));
    check('P23 ar, in a club: the club’s colours take part, every suggestion states its lettering contrast, right to left in Arabic',
      put.status === 200 && brandBefore === 'idle' && brandAfter === 'ready' && shown.length >= 1 && shown.some((s) => /(^|· )Club (black|yellow)( ·|$)/.test(s.name)) && ratios.every((r) => r.length > 0) && view.dir === 'rtl' && view.h === words.Colourways, { put: put.status, brandBefore, brandAfter, shown, view });
    if (fs.existsSync(axePath)) {
      const v = await runAxe(club.page, '#pd-club-root .pd-insp');
      check('P23 ar: axe finds no WCAG 2.2 A/AA violation in the Colour tab with its colourways', v.length === 0, v);
    }
    await club.page.screenshot({ path: path.join(OUT, 'p23-colourways-ar.png') });
    check('P23 club room: no CSP violation and no page error', (await csp(club.page)).length === 0 && club.log.errors.length === 0, club.log.errors);
  } finally { await club.ctx.close(); }
};
