/**
 * Design Studio browser proof, P19 — the Team panel (M3), in a real browser on the compiled application with a real
 * PostgreSQL database under row-level security, the application sending its context as production does.
 *
 *   · In the club's workspace the Team panel opens over the room and moves nothing beneath it.
 *   · A roster starts from the squad (the club's active players, surname and number), takes a spreadsheet (semicolon,
 *     BOM, a column that is not the roster's, which is never read), and refuses a bad file and a file that is not UTF-8
 *     without changing anything (the negative controls).
 *   · It saves in the club's own row, audited in counts; a row previewed shows its name and number on the garment while the
 *     design keeps its placeholders; it exports a spreadsheet that reads back the same; it reopens after a reload; a save
 *     racing another person's is caught and resolved.
 *   · Arabic, right to left; a phone's width; axe (WCAG 2.2 A/AA) with the panel open; no CSP violation, no page error.
 */
'use strict';

module.exports = async function p19(H) {
  const { open, M, check, fail, OUT, ROOT, db, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const R = require(path.join(ROOT, 'public/product-design/pd-roster.js'));
  const roomWord = (code, en) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'))[en];
  const ready = (pg) => pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'CLUB' && !!m.team; }, null, { timeout: 60000 });
  const T = (pg) => pg.evaluate(() => window.__familistaProductDesignMetrics().team);
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const rects = (pg) => pg.evaluate(() => ['.pd-canvas', '.pd-actions', '.pd-lib', '.pd-insp'].map((s) => { const r = document.querySelector('#pd-club-root ' + s).getBoundingClientRect(); return [s, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
  const panel = '#pd-club-root .pd-team';
  const waitList = (pg) => pg.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().team; return t.list === 'ready' || t.list === 'error'; }, null, { timeout: 30000 });
  const putRoster = (id, body) => fetch(BASE + '/api/v1/club-design/rosters/' + id, { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKENS.clubAdmin, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
  const runAxe = (pg) => pg.evaluate(async (src) => {
    if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
    const r = await window.axe.run({ include: ['#pg-club-design'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, fs.readFileSync(axePath, 'utf8'));
  let rosterId = null;

  const { ctx, page, log } = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await ready(page);
    await page.waitForTimeout(500);
    // ── opening it moves nothing ─────────────────────────────────────────────────────────────────────────────────────
    const before = await rects(page);
    await page.click('#pd-club-root [data-pd-act="team"]');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#pd-club-root .pd-team')).opacity === '1', null, { timeout: 5000 });
    await waitList(page);
    const after = await rects(page);
    const shown = await page.evaluate((sel) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect();
      const stage = document.querySelector('#pd-club-root .pd-stage').getBoundingClientRect();
      return { position: getComputedStyle(el).position, open: el.getAttribute('data-open'), expanded: document.querySelector('#pd-club-root [data-pd-act="team"]').getAttribute('aria-expanded'),
        empty: (el.querySelector('.pd-empty') || {}).textContent || '', inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        // the garment and its views stay in sight beside the panel, so a previewed row can be seen while choosing it
        besideStage: r.left >= stage.right, left: Math.round(r.left), stageRight: Math.round(stage.right) };
    }, panel);
    check('P19 the Team panel opens beside the garment and moves nothing beneath it; with no roster yet it says what would fill it',
      JSON.stringify(before) === JSON.stringify(after) && shown.position === 'fixed' && shown.open === 'true' && shown.expanded === 'true' && shown.inView && shown.besideStage && /No team rosters yet/.test(shown.empty),
      { before, after, shown });

    // ── the squad, then a spreadsheet ────────────────────────────────────────────────────────────────────────────────
    await page.click(panel + ' [data-pd-act="team-new"]');
    await page.click(panel + ' [data-pd-act="team-squad"]');
    await page.waitForSelector(panel + ' .pd-team-pending', { timeout: 15000 });
    const squad = await page.evaluate((sel) => ({ text: document.querySelector(sel + ' .pd-team-pending').textContent, skipped: [...document.querySelectorAll(sel + ' .pd-team-problems li')].map((li) => li.textContent) }), panel);
    await page.click(panel + ' [data-pd-act="team-import-replace"]');
    const fromSquad = await page.evaluate((sel) => [...document.querySelectorAll(sel + ' tbody tr')].map((tr) => [tr.querySelector('[data-pd-team-col="name"]').value, tr.querySelector('[data-pd-team-col="number"]').value]), panel);
    check('P19 a roster starts from the squad: the club’s active players, surname and number, the one whose surname cannot be printed left out and named',
      JSON.stringify(fromSquad) === JSON.stringify([['Okafor', '4'], ['Ødegaard', '8'], ['Smith', '9']]) && squad.skipped.join() === 'Silva 2' && /: 3\./.test(squad.text),
      { fromSquad, squad });

    const csv = Buffer.from('﻿Name;Shirt number;Shirt size;Shorts;Sock size;Qty;Email\r\nVAN DIJK;5;XL;L;43–46;1;vd@example.org\r\n"O\'NEIL";10;m;M;39-42;2;on@example.org\r\n', 'utf8');
    await page.setInputFiles(panel + ' [data-pd-team-file]', { name: 'away-signings.csv', mimeType: 'text/csv', buffer: csv });
    await page.waitForSelector(panel + ' .pd-team-pending', { timeout: 15000 });
    const pending = await page.evaluate((sel) => document.querySelector(sel + ' .pd-team-pending').textContent, panel);
    await page.click(panel + ' [data-pd-act="team-import-append"]');
    const rows = await page.evaluate((sel) => document.querySelectorAll(sel + ' tbody tr').length, panel);
    check('P19 a spreadsheet is read in the browser and shown before anything changes: semicolons, a BOM, sizes as people write them; its e-mail column is named and never read',
      rows === 5 && /away-signings\.csv: 2/.test(pending) && /Email/.test(pending) && !(await page.evaluate((sel) => document.querySelector(sel).textContent.includes('example.org'), panel)), { rows, pending });

    const bad = Buffer.from('name,number\n=cmd|calc,1O\n', 'utf8');
    await page.setInputFiles(panel + ' [data-pd-team-file]', { name: 'bad.csv', mimeType: 'text/csv', buffer: bad });
    await page.waitForSelector(panel + ' .pd-team-pending', { timeout: 15000 });
    const refused = await page.evaluate((sel) => ({ text: document.querySelector(sel + ' .pd-team-pending').textContent, apply: !!document.querySelector(sel + ' [data-pd-act="team-import-replace"]'), rows: document.querySelectorAll(sel + ' tbody tr').length }), panel);
    await page.click(panel + ' [data-pd-act="team-import-cancel"]');
    const latin1 = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4d, 0xdc, 0x4c, 0x4c, 0x45, 0x52, 0x0a]); // "name\nMÜLLER\n" in Windows-1252
    await page.setInputFiles(panel + ' [data-pd-team-file]', { name: 'legacy.csv', mimeType: 'text/csv', buffer: latin1 });
    await page.waitForSelector(panel + ' .pd-team-pending', { timeout: 15000 });
    const legacy = await page.evaluate((sel) => document.querySelector(sel + ' .pd-team-pending').textContent, panel);
    await page.click(panel + ' [data-pd-act="team-import-cancel"]');
    check('P19 negative controls: a file with rows it cannot keep, and one that is not UTF-8, are refused in the room’s words, and the roster is unchanged',
      /cannot be imported as it is/.test(refused.text) && /Row 2/.test(refused.text) && !refused.apply && refused.rows === 5 && /not UTF-8/.test(legacy)
        && (await page.evaluate((sel) => document.querySelectorAll(sel + ' tbody tr').length, panel)) === 5, { refused, legacy });

    // ── saved in the club's own row, audited in counts ───────────────────────────────────────────────────────────────
    await page.fill(panel + ' [data-pd-team-rname]', 'First team 2026/27');
    await page.click(panel + ' [data-pd-act="team-save"]');
    await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().team; return !t.dirty; }, null, { timeout: 15000 });
    const row = await db.designRoster.findFirst({ where: { name: 'First team 2026/27' }, select: { id: true, clubId: true, entries: true, entryCount: true, version: true } });
    rosterId = row && row.id;
    const audit = rosterId ? await db.platformAuditLog.findMany({ where: { resourceId: rosterId }, select: { action: true, metadata: true, message: true, clubId: true } }) : [];
    check('P19 the roster is saved in the club’s own row, as the core keeps it, and audited in counts with no name in it',
      !!row && row.clubId === 'club-1' && row.entryCount === 5 && row.version === 1 && row.entries[3].name === 'VAN DIJK' && row.entries[3].socks === '43-46' && row.entries[4].top === 'M'
        && audit.length === 1 && audit[0].action === 'design.roster.created' && audit[0].clubId === 'club-1' && !/Smith|VAN DIJK|NEIL/.test(JSON.stringify(audit)),
      { row: row && { clubId: row.clubId, n: row.entryCount, v: row.version }, audit: audit.map((a) => a.action) });

    // ── a row previewed on the garment; the design keeps its placeholders ────────────────────────────────────────────
    await page.click('#pd-club-root [data-pd-view="back"]');
    await page.click(panel + ' [data-pd-act="team-preview"][data-pd-row="3"]');
    await page.waitForFunction(() => !!window.__familistaProductDesignMetrics().preview, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const pv = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('#pd-club-root .pd-canvas svg text')].map((t) => t.textContent);
      const draft = Object.keys(localStorage).filter((k) => /product_design_draft/.test(k)).map((k) => localStorage.getItem(k)).join('');
      const tag = document.querySelector('#pd-club-root .pd-preview-tag');
      return { texts, tag: tag.hidden ? null : tag.textContent, draftHasName: draft.includes('VAN DIJK'), m: window.__familistaProductDesignMetrics().preview };
    });
    await page.screenshot({ path: path.join(OUT, 'p19-team-preview.png') });
    check('P19 a previewed row shows its name and number on the garment, the canvas says so, and the design itself keeps only its placeholders',
      pv.texts.includes('VAN DIJK') && pv.texts.includes('5') && !!pv.tag && /VAN DIJK/.test(pv.tag) && !pv.draftHasName && pv.m.name === 'VAN DIJK' && pv.m.number === 5, pv);
    await page.click('#pd-club-root [data-pd-mode="3d"]');
    await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().three; return (t.state === 'ready' && t.engine && !t.engine.pending) || !!t.failed; }, null, { timeout: 90000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'p19-team-preview-3d.png') });
    const three = (await M(page)).three;
    check('P19 the previewed name and number reach the 3D garment', three.state === 'ready' && !three.failed, { state: three.state, failed: three.failed });
    await page.click('#pd-club-root [data-pd-mode="2.5d"]');
    await page.click('#pd-club-root [data-pd-act="team-stop-preview"]');
    await page.waitForTimeout(200);
    const stopped = await page.evaluate(() => ({ texts: [...document.querySelectorAll('#pd-club-root .pd-canvas svg text')].map((t) => t.textContent), preview: window.__familistaProductDesignMetrics().preview }));
    check('P19 stopping the preview brings back the placeholders', stopped.preview === null && stopped.texts.includes('10') && !stopped.texts.includes('VAN DIJK'), stopped);

    // ── export: a spreadsheet that reads back the same ───────────────────────────────────────────────────────────────
    await page.selectOption(panel + ' [data-pd-team-delim]', ';');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(panel + ' [data-pd-act="team-export"]')]);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    const back = R.parseCsv(text);
    check('P19 the export is a spreadsheet (BOM, the chosen separator, CRLF) that reads back exactly as saved, named after the roster',
      dl.suggestedFilename() === 'First-team-2026-27.csv' && text.charCodeAt(0) === 0xfeff && back.delimiter === ';' && /\r\n/.test(text) && back.problems.length === 0
        // PostgreSQL's jsonb keeps an object's keys in its own order; the core's form is the one to compare.
        && JSON.stringify(back.entries) === JSON.stringify(R.validateEntries(row.entries)), { file: dl.suggestedFilename(), problems: back.problems, n: back.entries.length });

    // ── a save racing another person's ──────────────────────────────────────────────────────────────────────────────
    const other = await putRoster(rosterId, { name: 'First team 2026/27', entries: row.entries.slice(0, 4), version: 1 });
    await page.fill(panel + ' [data-pd-team-row="0"][data-pd-team-col="name"]', 'OKAFOR');
    await page.click(panel + ' [data-pd-act="team-save"]');
    await page.waitForSelector(panel + ' [data-pd-act="team-conflict-keep"]', { timeout: 15000 });
    await page.click(panel + ' [data-pd-act="team-conflict-keep"]');
    await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().team; return !t.dirty && !t.conflict; }, null, { timeout: 15000 });
    const kept = await db.designRoster.findUnique({ where: { id: rosterId }, select: { version: true, entryCount: true, entries: true } });
    check('P19 a save racing another person’s is caught, not lost: the room says so, and saving over it is a choice that lands as a new version',
      other.status === 200 && other.body.data.roster.version === 2 && kept.version === 3 && kept.entryCount === 5 && kept.entries[0].name === 'OKAFOR', { other: other.status, kept: kept && { v: kept.version, n: kept.entryCount } });

    if (fs.existsSync(axePath)) {
      const v = await runAxe(page);
      check('P19 en-GB: axe finds no WCAG 2.2 A/AA violation in the club’s room with a roster open', v.length === 0, v);
    } else fail('P19 axe-core is not installed (npm ci --ignore-scripts --prefix tools/components)');
    check('P19 no CSP violation and no page error with the Team panel', (await csp(page)).length === 0 && log.errors.length === 0, { csp: await csp(page), errors: log.errors });
  } finally {
    await ctx.close();
  }

  // ── it reopens after a reload, in Arabic, right to left ──────────────────────────────────────────────────────────────
  const { ctx: c2, page: ar, log: arLog } = await open({ width: 1672, height: 941 }, 'ar', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await ready(ar);
    await ar.click('#pd-club-root [data-pd-act="team"]');
    await waitList(ar);
    await ar.click(panel + ' [data-pd-act="team-open"]');
    await ar.waitForSelector(panel + ' tbody tr', { timeout: 15000 });
    const view = await ar.evaluate((sel) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect(), host = document.getElementById('pd-club-root');
      return { dir: getComputedStyle(el).direction, rows: el.querySelectorAll('tbody tr').length, title: el.querySelector('#pd-team-title').textContent.trim(),
        back: getComputedStyle(el.querySelector('.pd-team-back .fam-dir-ic')).transform, inView: r.left >= 0 && r.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1,
        name: el.querySelector('[data-pd-team-rname]').value, lang: host.getAttribute('lang') };
    }, panel);
    await ar.screenshot({ path: path.join(OUT, 'p19-team-ar.png') });
    check('P19 ar: the saved roster reopens after a reload, right to left, in Arabic, its back arrow mirrored and its name the club’s own',
      view.rows === 5 && view.dir === 'rtl' && view.lang === 'ar' && view.title === roomWord('ar', 'Team roster') && view.back !== 'none' && view.inView && !view.overflow && view.name === 'First team 2026/27', view);
    if (fs.existsSync(axePath)) {
      const v = await runAxe(ar);
      check('P19 ar: axe finds no WCAG 2.2 A/AA violation with the Team panel open', v.length === 0, v);
    }
    check('P19 ar: no page error', arLog.errors.length === 0, arLog.errors);
  } finally { await c2.close(); }

  // ── a phone's width: a sheet over the page; the table scrolls inside itself ─────────────────────────────────────────
  const { ctx: c3, page: ph } = await open({ width: 390, height: 844 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false, mobile: true });
  try {
    await ready(ph);
    await ph.click('#pd-club-root [data-pd-act="team"]');
    await waitList(ph);
    await ph.click(panel + ' [data-pd-act="team-open"]');
    await ph.waitForSelector(panel + ' tbody tr', { timeout: 15000 });
    await ph.waitForTimeout(400);
    const sheet = await ph.evaluate((sel) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect(), sc = el.querySelector('.pd-team-scroll');
      return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), top: Math.round(r.top), vw: innerWidth, vh: innerHeight,
        scrolls: sc.scrollWidth > sc.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    }, panel);
    await ph.screenshot({ path: path.join(OUT, 'p19-team-phone.png') });
    check('P19 at a phone’s width the panel is a sheet inside the screen, its table scrolling inside itself, the page never sideways',
      sheet.left >= 0 && sheet.right <= sheet.vw && sheet.bottom <= sheet.vh && sheet.top >= 0 && sheet.scrolls && !sheet.pageOverflow, sheet);
  } finally { await c3.close(); }

  // ── M3b: a collection of the club's designs, and its order sheet ────────────────────────────────────────────────────
  let collectionId = null;
  const { ctx: c5, page: co, log: coLog } = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await ready(co);
    // The design on screen, saved; and the club's shorts, saved by another session.
    await co.click('#pd-club-root [data-pd-act="save"]');
    await co.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && !s.busy && s.linked; }, null, { timeout: 30000 });
    const C = require(path.join(ROOT, 'public/product-design/pd-core.js'));
    const shortsTpl = C.validateTemplate(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/shorts.json'), 'utf8')));
    const made = await fetch(BASE + '/api/v1/club-design/projects', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKENS.clubAdmin, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ document: C.createDocument(shortsTpl, 'Home shorts 26/27'), origin: 'EDITOR' }) }).then((r) => r.json());
    const shortsId = made && made.data && made.data.project.id;

    const before = await rects(co);
    await co.click('#pd-club-root [data-pd-act="team"]');
    await waitList(co);
    await co.click(panel + ' [data-pd-act="team-tab-collections"]');
    await co.waitForFunction(() => { const c = window.__familistaProductDesignMetrics().team.collections; return c && c.list === 'ready'; }, null, { timeout: 15000 });
    const empty = await co.evaluate((sel) => (document.querySelector(sel + ' .pd-empty') || {}).textContent || '', panel);
    const after = await rects(co);
    check('P19 the Collections tab opens in the same panel, moving nothing, and with none yet says what one is for',
      JSON.stringify(before) === JSON.stringify(after) && /No collections yet/.test(empty), { empty });

    await co.click(panel + ' [data-pd-act="col-new"]');
    await co.waitForFunction((id) => !!document.querySelector('#pd-club-root .pd-team [data-pd-col-pick] option[value="' + id + '"]'), shortsId, { timeout: 15000 });
    await co.selectOption(panel + ' [data-pd-col-pick]', shortsId);
    await co.click(panel + ' [data-pd-act="col-add"]');
    await co.fill(panel + ' [data-pd-col-field="name"]', 'Home kit');
    await co.fill(panel + ' [data-pd-col-field="season"]', '2026/27');
    const rosterRow = await db.designRoster.findFirst({ where: { name: 'First team 2026/27' }, select: { id: true } });
    await co.waitForFunction(() => document.querySelectorAll('#pd-club-root .pd-team [data-pd-col-field="rosterId"] option').length > 1, null, { timeout: 15000 });
    await co.selectOption(panel + ' [data-pd-col-field="rosterId"]', rosterRow.id);
    await co.click(panel + ' [data-pd-act="col-save"]');
    await co.waitForFunction(() => { const c = window.__familistaProductDesignMetrics().team.collections; return c && !c.dirty && c.sheet === 'ready'; }, null, { timeout: 20000 });
    const row = await db.designCollection.findFirst({ where: { name: 'Home kit' }, select: { id: true, clubId: true, season: true, rosterId: true, items: { orderBy: { position: 'asc' }, select: { projectId: true, role: true } } } });
    collectionId = row && row.id;
    const linked = (await M(co)).server.projectId;
    check('P19 a collection gathers the design on screen and a saved one, for a roster, saved in the club’s own rows',
      !!row && row.clubId === 'club-1' && row.season === '2026/27' && row.rosterId === rosterRow.id
        && JSON.stringify(row.items.map((i) => i.projectId)) === JSON.stringify([linked, shortsId]) && row.items.every((i) => i.role === 'HOME'), row);

    const sheet = await co.evaluate((sel) => [...document.querySelectorAll(sel + ' .pd-col-sheet tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())), panel);
    await co.screenshot({ path: path.join(OUT, 'p19-collection.png') });
    check('P19 its order sheet counts the roster’s sets per size for each garment, and names the sets with no size',
      sheet.length === 2 && /Top/.test(sheet[0][1]) && sheet[0][2] === 'M × 2 · XL × 1 · without a size: 3' && /Shorts/.test(sheet[1][1]) && sheet[1][2] === 'M × 2 · L × 1 · without a size: 3', sheet);

    const [dl] = await Promise.all([co.waitForEvent('download', { timeout: 15000 }), co.click(panel + ' [data-pd-act="col-export"]')]);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
    check('P19 the order sheet exports as a spreadsheet: one line per garment and size, the unsized counted apart',
      text.charCodeAt(0) === 0xfeff && lines[0] === 'design,role,garment,size,sets' && lines.length === 7
        && lines.includes('Home shorts 26/27,home,shorts,L,1') && lines.includes('Home shorts 26/27,home,shorts,,3') && /order-sheet\.csv$/.test(dl.suggestedFilename()),
      { file: dl.suggestedFilename(), lines });

    // Opening a design from the collection brings it onto the canvas.
    await co.click(panel + ' [data-pd-act="col-open-design"][data-pd-id="' + shortsId + '"]');
    await co.waitForFunction(() => window.__familistaProductDesignMetrics().template === 'shorts.classic', null, { timeout: 30000 });
    check('P19 a design opens from its collection onto the canvas', (await M(co)).server.projectId === shortsId, { template: (await M(co)).template });
    if (fs.existsSync(axePath)) {
      const isOpen = await co.evaluate((sel) => document.querySelector(sel).getAttribute('data-open') === 'true', panel);
      if (!isOpen) await co.click('#pd-club-root [data-pd-act="team"]');
      const v = await runAxe(co);
      check('P19 en-GB: axe finds no WCAG 2.2 A/AA violation with a collection open', v.length === 0, v);
    }
    check('P19 no CSP violation and no page error with collections', (await csp(co)).length === 0 && coLog.errors.length === 0, { csp: await csp(co), errors: coLog.errors });
  } finally { await c5.close(); }

  // ── another club reaches none of it ─────────────────────────────────────────────────────────────────────────────────
  const r = await fetch(BASE + '/api/v1/club-design/rosters/' + rosterId, { headers: { Authorization: 'Bearer ' + TOKENS.otherAdmin, Accept: 'application/json' } });
  check('P19 another club’s administrator is refused the roster by the server (negative control)', r.status === 403 || r.status === 404, { status: r.status });
  const rc = await fetch(BASE + '/api/v1/club-design/collections/' + collectionId + '/order-sheet', { headers: { Authorization: 'Bearer ' + TOKENS.otherAdmin, Accept: 'application/json' } });
  check('P19 another club’s administrator is refused the collection’s order sheet by the server (negative control)', !!collectionId && (rc.status === 403 || rc.status === 404), { status: rc.status });
};
