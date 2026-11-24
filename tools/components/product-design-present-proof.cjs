/**
 * Design Studio browser proof, P22 — a collection's presentation sheet (M7b-2), in the Club Design Studio, on the
 * compiled application with a real PostgreSQL database.
 *
 *   · From a collection, the club opens its presentation: every design drawn in vectors from its saved version by the
 *     room's own renderer (two views each), with its garment, role, version and the club's decision; the sets per size.
 *   · Opening and closing it moves nothing beneath it; focus goes in, stays in, and comes back to the button pressed.
 *   · Only the club's own designs are fetched, and nothing is sent anywhere.
 *   · In print, only the sheet is shown, on A4 landscape pages: Chromium's own PDF of it is checked (pages, text).
 *   · axe in English and Arabic; right to left in Arabic; no CSP violation, no page error.
 */
'use strict';

module.exports = async function p22(H) {
  const { open, check, fail, OUT, ROOT, BASE, TOKENS } = H;
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
  const TEAM = '#pd-club-root .pd-team', SHEET = '#pd-club-root .pd-present';

  // ── the club's kit: a shirt (approved), shorts and socks, and the roster it is made for ───────────────────────────
  const save = async (file, name) => (await call('clubAdmin', 'POST', '/api/v1/club-design/projects', { document: C.createDocument(tpl(file), name), origin: 'EDITOR' })).body.data.project.id;
  const shirt = await save('football-jersey.json', 'P22 home shirt');
  const shorts = await save('shorts.json', 'P22 home shorts');
  const socks = await save('socks.json', 'P22 home socks');
  const E = (o) => Object.assign({ name: 'SMITH', number: 9, top: 'M', shorts: 'L', socks: '39-42', qty: 1 }, o || {});
  const roster = (await call('clubAdmin', 'POST', '/api/v1/club-design/rosters', { name: 'P22 first team', entries: [E(), E({ name: 'JONES', number: 4, top: 'L', qty: 2 })] })).body.data.roster.id;
  const kit = (await call('clubAdmin', 'POST', '/api/v1/club-design/collections', { name: 'P22 home kit', season: '2026/27', rosterId: roster,
    items: [{ projectId: shirt, role: 'HOME' }, { projectId: shorts, role: 'HOME' }, { projectId: socks, role: 'HOME' }] })).body.data.collection.id;
  const approved = await call('clubAdmin', 'POST', '/api/v1/club-design/projects/' + shirt + '/decisions', { revision: 1, decision: 'APPROVED' });
  if (!shirt || !shorts || !socks || !roster || !kit || approved.status !== 201) { fail('P22 the club’s kit could not be prepared', { shirt, shorts, socks, roster, kit, approved: approved.status }); return; }

  async function presentation(locale) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: 'clubAdmin', hash: '/#club-design', wait: false });
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.team && !!m.present; }, null, { timeout: 60000 });
    await s.page.click('#pd-club-root [data-pd-act="team"]');
    await s.page.click(TEAM + ' [data-pd-act="team-tab-collections"]');
    await s.page.waitForSelector(TEAM + ' [data-pd-act="col-open"][data-pd-id="' + kit + '"]', { timeout: 15000 });
    await s.page.click(TEAM + ' [data-pd-act="col-open"][data-pd-id="' + kit + '"]');
    await s.page.waitForFunction(() => window.__familistaProductDesignMetrics().team.collections.sheet === 'ready', null, { timeout: 20000 });
    return s;
  }
  const work = (pg) => pg.evaluate(() => { const w = document.querySelector('#pd-club-root .pd-work').getBoundingClientRect(); return [w.top, w.left, w.width, w.height].map((x) => Math.round(x)); });

  const en = await presentation('en-GB');
  const pg = en.page;
  try {
    const before = await work(pg);
    const sent = en.log.requests.length;
    await pg.click(TEAM + ' [data-pd-act="col-present"]');
    await pg.waitForFunction(() => { const p = window.__familistaProductDesignMetrics().present; return p.open && p.ready; }, null, { timeout: 30000 });
    const m = (await pg.evaluate(() => window.__familistaProductDesignMetrics().present));
    const view = await pg.evaluate((sel) => {
      const cards = [...document.querySelectorAll(sel + ' [data-pd-present-design]')];
      return { focus: document.activeElement && document.activeElement.getAttribute('data-pd-act'), cards: cards.map((c) => ({
        id: c.getAttribute('data-pd-present-design'), svgs: c.querySelectorAll('svg').length, paths: c.querySelectorAll('svg path').length, captions: [...c.querySelectorAll('figcaption')].map((f) => f.textContent),
        name: c.querySelector('.pd-present-name').textContent, chip: (c.querySelector('.pd-rv-chip') || { getAttribute: () => null }).getAttribute('data-decision') })),
        sizes: document.querySelectorAll(sel + ' .pd-present-table tbody tr').length, title: document.querySelector(sel + ' .pd-present-title').textContent };
    }, SHEET);
    const after = await work(pg);
    check('P22 the presentation draws every design of the collection from its saved version, two views each, with the club’s decision and the sets per size',
      m.designs === 3 && m.drawn === 3 && m.errors === 0 && view.cards.length === 3 && view.cards.every((c) => c.svgs === 2 && c.paths > 4)
      && JSON.stringify(view.cards.map((c) => c.captions)) === JSON.stringify([['Front', 'Back'], ['Front', 'Back'], ['Outer side', 'Inner side']])
      && JSON.stringify(view.cards.map((c) => c.chip)) === JSON.stringify(['APPROVED', 'none', 'none']) && view.sizes === 3 && view.title === 'P22 home kit · 2026/27', { m, view });
    const boxes = await pg.evaluate((sel) => [...document.querySelectorAll(sel + ' .pd-present-views')].map((v) => Math.round(v.getBoundingClientRect().height)), SHEET);
    check('P22 every garment’s views take the same box, a sock as a shirt', boxes.length === 3 && Math.max(...boxes) - Math.min(...boxes) <= 1 && boxes[0] > 100, boxes);
    check('P22 opening it moves nothing beneath it, and focus goes into it', JSON.stringify(before) === JSON.stringify(after) && view.focus === 'present-close', { before, after, focus: view.focus });
    const calls = en.log.requests.slice(sent).filter((r) => r.path.startsWith('/api/'));
    check('P22 it fetches the club’s own three designs and nothing else; nothing is sent', calls.length === 3 && calls.every((r) => r.method === 'GET' && /^\/api\/v1\/club-design\/projects\/[0-9a-f-]{36}$/.test(r.path)), calls);

    // Tab stays inside the sheet.
    const inside = [];
    for (let i = 0; i < 5; i++) { await pg.keyboard.press('Tab'); inside.push(await pg.evaluate((sel) => !!document.activeElement.closest(sel), SHEET)); }
    check('P22 Tab stays inside the presentation while it is open', inside.every(Boolean), inside);

    await pg.screenshot({ path: path.join(OUT, 'p22-present-en.png') });
    if (fs.existsSync(axePath)) {
      const v = await runAxe(pg, SHEET);
      check('P22 en: axe finds no WCAG 2.2 A/AA violation in the presentation', v.length === 0, v);
    }

    // In print: only the sheet; Chromium's own PDF of it.
    await pg.emulateMedia({ media: 'print' });
    const printed = await pg.evaluate((sel) => ({
      main: getComputedStyle(document.querySelector('#pd-club-root .pd-main')).display, team: getComputedStyle(document.querySelector('#pd-club-root .pd-team')).display,
      bar: getComputedStyle(document.querySelector(sel + ' .pd-present-bar')).display, sheet: getComputedStyle(document.querySelector(sel + ' .pd-present-sheet')).display,
      others: [...document.body.children].filter((n) => !n.querySelector('.pd-present') && getComputedStyle(n).display !== 'none').map((n) => n.tagName + '#' + n.id) }), SHEET);
    const pdf = await pg.pdf({ preferCSSPageSize: true, printBackground: true });
    await pg.emulateMedia({ media: 'screen' });
    fs.writeFileSync(path.join(OUT, 'p22-present.pdf'), pdf);
    const text = pdf.toString('latin1');
    const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
    check('P22 in print only the sheet is laid out, on A4 landscape pages, as a real PDF', printed.main === 'none' && printed.team === 'none' && printed.bar === 'none' && printed.sheet !== 'none' && printed.others.every((x) => /^(SCRIPT|STYLE|LINK|NOSCRIPT)/.test(x))
      && text.startsWith('%PDF-') && pages >= 1 && !!box && Math.round(Number(box[1])) === 842 && Math.round(Number(box[2])) === 595, { printed, pages, box: box && box.slice(1), bytes: pdf.length });

    // Escape closes it, and focus comes back to the button pressed.
    await pg.keyboard.press('Escape');
    const closed = await pg.evaluate(() => ({ open: window.__familistaProductDesignMetrics().present.open, back: document.activeElement && document.activeElement.getAttribute('data-pd-act'), printing: document.body.classList.contains('pd-presenting') }));
    check('P22 Escape closes it and focus returns to the button pressed', !closed.open && closed.back === 'col-present' && !closed.printing, closed);
    check('P22 no CSP violation and no page error', (await csp(pg)).length === 0 && en.log.errors.length === 0, en.log.errors);
  } finally { await en.ctx.close(); }

  // ── in Arabic, right to left ──────────────────────────────────────────────────────────────────────────────────
  const ar = await presentation('ar');
  try {
    await ar.page.click(TEAM + ' [data-pd-act="col-present"]');
    await ar.page.waitForFunction(() => { const p = window.__familistaProductDesignMetrics().present; return p.open && p.ready; }, null, { timeout: 30000 });
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n/ar.json'), 'utf8'));
    const view = await ar.page.evaluate((sel) => { const el = document.querySelector(sel + ' .pd-present-sheet'), r = el.getBoundingClientRect();
      return { dir: getComputedStyle(el).direction, title: document.querySelector('#pd-present-title').textContent.trim(), name: document.querySelector(sel + ' .pd-present-name').textContent, inView: r.left >= 0 && r.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 }; }, SHEET);
    await ar.page.screenshot({ path: path.join(OUT, 'p22-present-ar.png') });
    check('P22 ar: the presentation in Arabic, right to left; design names stay as written', view.dir === 'rtl' && view.title === words.Presentation && view.name === 'P22 home shirt' && view.inView && !view.overflow, view);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(ar.page, SHEET);
      check('P22 ar: axe finds no WCAG 2.2 A/AA violation in the presentation', v.length === 0, v);
    }
  } finally { await ar.ctx.close(); }
};
