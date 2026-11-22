'use strict';
// Familista Design Studio, M1a — P17: the product catalogue, in a real browser, on the compiled application and a real
// PostgreSQL, under the production CSP. Required by product-design-browser-proof.cjs, which owns the server, the
// database and the browser; run alone with PROOF_ONLY=P17.
//
// It proves that the catalogue offers exactly the released garments (templates/index.json) and nothing else; that a
// Planned product does nothing; that changing garment with unsaved work asks first, and Cancel changes nothing; that
// each released garment draws, has a starter design inside its safe areas, and paints in 3D; that a design saved on
// the server is opened again on its own garment; that an exported design is imported on its own garment; that the
// open garment survives a reload; and that all of it speaks German. No CSP violation and no page error throughout.
const fs = require('fs');
const path = require('path');

module.exports = async function p17(H) {
  const { open, M, check, OUT, ROOT, db } = H;
  const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/index.json'), 'utf8')).templates;
  const KEY = Object.fromEntries(INDEX.map((e) => [e.product, e.key]));
  const NAME = Object.fromEntries(INDEX.map((e) => [e.product, JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates', e.file), 'utf8')).name]));
  const RELEASED = INDEX.map((e) => e.product);

  const tiles = (pg) => pg.$$eval('#pd-root .pd-card', (bs) => bs.map((b) => ({
    id: b.getAttribute('data-pd-tile'), selectable: b.hasAttribute('data-pd-product'), current: b.getAttribute('aria-current') === 'true',
    planned: !!b.querySelector('.pd-chip'), label: b.querySelector('.pd-card-label').textContent.trim(),
  })));
  const onTemplate = (pg, key) => pg.waitForFunction((k) => { const m = window.__familistaProductDesignMetrics(); return !!m && m.template === k; }, key, { timeout: 30000 });
  const idle = (pg) => pg.waitForFunction(() => !window.__familistaProductDesignMetrics().server.busy, null, { timeout: 20000 });
  const docText = (pg) => pg.evaluate(() => localStorage.getItem('familista_product_design_draft_v1'));
  const confirmShown = (pg) => pg.$('#pd-dock [data-pd-act="confirm-go"]');
  /** Choose a released product; when the room asks (unsaved work), answer `answer`: 'go' or 'cancel'. */
  const choose = async (pg, product, answer) => {
    await pg.click(`#pd-root [data-pd-product="${product}"]`);
    await pg.waitForTimeout(300);
    if (await confirmShown(pg)) await pg.click(`#pd-dock [data-pd-act="confirm-${answer || 'go'}"]`);
  };
  /** The Projects panel, opened afresh so its list is read again from the server, and loaded. */
  const openProjects = async (pg) => {
    const isOpen = () => pg.evaluate(() => document.getElementById('pd-dock').getAttribute('data-open') === 'true');
    if (await isOpen()) { await pg.click('#pd-root .pd-actions [data-pd-act="projects"]'); await pg.waitForFunction(() => document.getElementById('pd-dock').getAttribute('data-open') === 'false'); }
    await pg.click('#pd-root .pd-actions [data-pd-act="projects"]');
    await pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics().server; return m.tab === 'projects' && m.list !== 'loading'; }, null, { timeout: 15000 });
  };
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design|vendor\/babylon/.test(c.src + c.uri)));

  const { ctx, page, log } = await open({ width: 1672, height: 941 }, 'en-GB');
  try {
    // ── the offer ──────────────────────────────────────────────────────────────────────────────────────────────────
    const t0 = await tiles(page);
    const available = t0.filter((t) => !t.planned).map((t) => t.id).sort();
    check('P17 the catalogue offers exactly the released garments (templates/index.json), the match shirt open; every other product is Planned',
      JSON.stringify(available) === JSON.stringify(RELEASED.slice().sort()) && t0.filter((t) => t.current).map((t) => t.id).join() === 'match-shirt'
        && t0.every((t) => t.planned === !RELEASED.includes(t.id)) && t0.filter((t) => t.planned).every((t) => !t.selectable),
      { available, planned: t0.filter((t) => t.planned).map((t) => t.id) });

    const before = await docText(page);
    // It is marked disabled for assistive technology; the click is forced, as a pointer would deliver it, to prove it does nothing.
    await page.click('#pd-root [data-pd-tile="polo"]', { force: true });
    await page.waitForTimeout(400);
    check('P17 a Planned product does nothing: the garment and the design are unchanged (Polo shirt)',
      (await M(page)).template === KEY['match-shirt'] && (await docText(page)) === before && !(await confirmShown(page)));

    // ── unsaved work is protected ──────────────────────────────────────────────────────────────────────────────────
    await page.click('#pd-root [data-pd-select="l3"]');
    await page.focus('#pd-root .pd-canvas');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500); // past the local autosave, so the draft holds the edit
    const edited = await docText(page);
    await page.click('#pd-root [data-pd-product="gk-shirt"]');
    await page.waitForTimeout(400);
    const asked = !!(await confirmShown(page));
    await page.click('#pd-dock [data-pd-act="confirm-cancel"]');
    await page.waitForTimeout(300);
    check('P17 changing garment with unsaved work asks first; Cancel keeps the garment and the edited design exactly',
      asked && (await M(page)).template === KEY['match-shirt'] && (await docText(page)) === edited, { asked });

    // ── each released garment ──────────────────────────────────────────────────────────────────────────────────────
    const seen = {};
    for (const product of ['gk-shirt', 'training-top', 't-shirt', 'match-shirt']) {
      await choose(page, product, 'go');
      await onTemplate(page, KEY[product]);
      await page.waitForTimeout(300);
      const m = await M(page);
      await page.click('#pd-root [data-pd-mode="3d"]');
      await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().three; return (t.state === 'ready' && t.engine && !t.engine.pending) || !!t.failed; }, null, { timeout: 90000 });
      const e = (await M(page)).three;
      seen[product] = { template: m.template, name: await page.inputValue('#pd-root .pd-docname'), findings: m.findings, three: e.state, vertices: e.engine && e.engine.vertices,
        current: (await tiles(page)).filter((t) => t.current).map((t) => t.id).join() };
      await page.click('#pd-root [data-pd-mode="2.5d"]');
      await page.waitForTimeout(300);
    }
    check('P17 each released garment opens with its own starter design (no finding), is the current tile, and paints in 3D',
      RELEASED.every((p) => seen[p].template === KEY[p] && seen[p].findings === 0 && seen[p].three === 'ready' && seen[p].current === p && seen[p].vertices > 0)
        && seen['gk-shirt'].name === NAME['gk-shirt'] && seen['match-shirt'].name === 'Home kit design', seen);
    check('P17 the long-sleeve garments are built with their long sleeves: more of the garment than the short-sleeve ones',
      seen['gk-shirt'].vertices > seen['match-shirt'].vertices && seen['training-top'].vertices > seen['t-shirt'].vertices, seen);

    // ── a saved design opens on its own garment ────────────────────────────────────────────────────────────────────
    await choose(page, 'gk-shirt', 'go');
    await onTemplate(page, KEY['gk-shirt']);
    await page.click('#pd-root .pd-actions [data-pd-act="save"]');
    await idle(page);
    const saved = await M(page);
    const pid = saved.server.projectId, savedDoc = await docText(page);
    await choose(page, 'match-shirt', 'go');
    await onTemplate(page, KEY['match-shirt']);
    await openProjects(page);
    await page.waitForSelector(`#pd-dock [data-pd-act="open-project"][data-pd-id="${pid}"]`, { timeout: 20000 });
    await page.click(`#pd-dock [data-pd-act="open-project"][data-pd-id="${pid}"]`);
    await onTemplate(page, KEY['gk-shirt']);
    await page.waitForTimeout(400);
    const row = pid ? await db.designProject.findUnique({ where: { id: pid } }) : null;
    check('P17 a goalkeeper shirt saved on the server opens again on the goalkeeper shirt, the same design, recorded under its template',
      !!pid && saved.server.state === 'saved' && (await docText(page)) === savedDoc && !!row && row.templateKey === KEY['gk-shirt'],
      { pid, state: saved.server.state, templateKey: row && row.templateKey });

    // ── comparing versions of a long-sleeve garment: the two garments stand apart ──────────────────────────────────
    await page.click('#pd-root [data-pd-mode="3d"]');
    await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().three; return t.state === 'ready' && t.engine && !t.engine.pending; }, null, { timeout: 90000 });
    await page.click('#pd-root [data-pd-act="compare3d"]');
    await page.waitForSelector('#pd-root [data-pd-act="compare-version"][data-pd-n="1"]', { timeout: 15000 });
    await page.click('#pd-root [data-pd-act="compare-version"][data-pd-n="1"]');
    await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().three; return !!t.compare && t.compare.state === 'ready'; }, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const span = await page.evaluate(() => {
      const P = window.__familistaProductDesignProject;
      // The hem's and the shoulders' corners and both cuffs, on each garment: where they fall across the canvas.
      const pts = [['front', 30, 740], ['front', 510, 740], ['front', 48, 44], ['front', 492, 44],
        ['sleeve-right', 110, 660], ['sleeve-right', 310, 660], ['sleeve-left', 110, 660], ['sleeve-left', 310, 660]];
      const xs = (which) => pts.map((q) => P(q[0], q[1], q[2], which)).filter(Boolean).map((r) => r.x);
      const a = xs(null), b = xs('compare');
      return { points: [a.length, b.length], current: [Math.min(...a), Math.max(...a)], compared: [Math.min(...b), Math.max(...b)] };
    });
    check('P17 comparing versions of a goalkeeper shirt (long sleeves): the two garments stand apart on the canvas, sleeves included',
      span.points[0] === 8 && span.points[1] === 8 && (span.current[1] < span.compared[0] || span.compared[1] < span.current[0]), span);
    await page.click('#pd-root [data-pd-act="compare3d"]');
    await page.click('#pd-root [data-pd-mode="2.5d"]');
    await page.waitForTimeout(400);

    // ── an exported design is imported on its own garment ──────────────────────────────────────────────────────────
    await choose(page, 'training-top', 'go');
    await onTemplate(page, KEY['training-top']);
    await page.fill('#pd-root .pd-docname', 'Training top export');
    await page.press('#pd-root .pd-docname', 'Enter');
    await page.waitForTimeout(600);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pd-root [data-pd-act="export"]')]);
    const file = path.join(OUT, 'p17-training-top.json');
    await download.saveAs(file);
    await choose(page, 't-shirt', 'go');
    await onTemplate(page, KEY['t-shirt']);
    await page.setInputFiles('#pd-root input[type="file"]', file);
    await onTemplate(page, KEY['training-top']);
    await page.waitForTimeout(400);
    check('P17 a design file of another garment is imported on that garment (a training top imported while the T-shirt was open)',
      (await page.inputValue('#pd-root .pd-docname')) === 'Training top export' && (await M(page)).template === KEY['training-top']);

    // ── the open garment survives a reload ─────────────────────────────────────────────────────────────────────────
    await page.reload();
    await page.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    check('P17 after a reload the room opens on the garment of the draft it keeps (the training top), not on the match shirt',
      (await M(page)).template === KEY['training-top'] && (await page.inputValue('#pd-root .pd-docname')) === 'Training top export');

    check('P17 no CSP violation and no page error, after everything above', (await csp(page)).length === 0 && log.errors.length === 0, { csp: await csp(page), errors: log.errors });
  } finally {
    await ctx.close();
  }

  // ── in German ────────────────────────────────────────────────────────────────────────────────────────────────────
  const { ctx: c2, page: de } = await open({ width: 1672, height: 941 }, 'de-DE');
  try {
    const labels = Object.fromEntries((await tiles(de)).map((t) => [t.id, t.label]));
    const note = await de.$eval('#pd-root .pd-lib-body > .pd-note', (n) => n.textContent.trim());
    await choose(de, 'gk-shirt', 'go');
    await onTemplate(de, KEY['gk-shirt']);
    const name = await de.inputValue('#pd-root .pd-docname');
    check('P17 de-DE: the released garments, the catalogue note and a new design’s name are in German',
      labels['gk-shirt'] === 'Torwarttrikot' && labels['training-top'] === 'Trainingsoberteil' && labels['t-shirt'] === 'T-Shirt'
        && /^Als „Geplant“ markierte Produkte/.test(note) && name === 'Torwarttrikot', { labels, note, name });
  } finally {
    await c2.close();
  }
};
