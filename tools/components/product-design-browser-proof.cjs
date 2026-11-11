// Familista — Design Studio (DS-1a): browser proofs.
//
// What Jest cannot see, proven in a real Chromium against the REAL compiled application served by the REAL app (only
// the database is stubbed, exactly as twin-browser-proof.cjs does): that only the Platform Owner ever loads the room,
// that it runs under the production Content-Security-Policy without a single violation, that its regions sit where the
// approved reference image puts them, that editing works by pointer and keyboard and undoes exactly, that the design
// check reacts, that a draft survives a reload and round-trips through export and import, that every unavailable control
// says why, that Arabic mirrors the chrome and never the garment, that it fits every width without moving what the
// reader did not move, and how fast it is.
//
//   npm run build
//   node tools/components/product-design-browser-proof.cjs <output-dir>
//
//   PLAYWRIGHT_CORE   the Playwright module to load (default: playwright-core; a session with `playwright` installed may
//                     pass PLAYWRIGHT_CORE=playwright)
//   CHROMIUM          a Chrome or Chromium binary (default: the module's own)
//
// Every line is PASS, FAIL or SKIP; the last is `SUMMARY n passed, n failed, n skipped`, and the exit code is 1 if
// anything failed. Checks that could pass whatever the room did are paired with a negative control: a club coach is
// refused where the owner is served, and a design moved off the printable area is reported where the starting one is not.
// It also writes the screenshots and a side-by-side review sheet against the approved reference to <output-dir>.
process.env.NODE_ENV = 'production';
process.env.PORT = '47934';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(48);
process.env.DATABASE_URL = 'postgresql://stub:stub@stub/stub';

const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node tools/components/product-design-browser-proof.cjs <output-dir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const REGIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/design-studio/reference-regions.json'), 'utf8'));
const REFERENCE = path.join(ROOT, 'docs/design-studio', REGIONS.reference);
const roomWord = (code, en) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'))[en];

const OWNER = { id: 'u-owner', email: 'owner@familista.test', role: 'SUPER_ADMIN', clubId: null, isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: { isActive: true } };
const COACH = { id: 'u-coach', email: 'coach@familista.test', role: 'COACH', clubId: 'club-1', isActive: true, currentClubId: 'club-1', currentTeamId: null, tokenVersion: 0, platformAdmin: null };
const USERS = { [OWNER.id]: OWNER, [COACH.id]: COACH };
let CURRENT = OWNER;
const who = (args) => (args && args.where && USERS[args.where.id]) || CURRENT;
const dbProxy = new Proxy({}, {
  get(_t, k) {
    if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
    if (k === '$transaction') return async (f) => (Array.isArray(f) ? [] : f({}));
    if (k === '$connect' || k === '$disconnect') return async () => {};
    if (k === 'user') return { findFirst: async (a) => who(a), findUnique: async (a) => who(a), count: async () => 1 };
    return new Proxy({}, { get: (_x, op) => async () => (op === 'count' ? 0 : op === 'findFirst' || op === 'findUnique' ? null : []) });
  },
});
require.cache[require.resolve(path.join(ROOT, 'dist/config/database'))] = { exports: { prisma: dbProxy, connectDatabase: async () => true, disconnectDatabase: async () => true } };
const { signToken } = require(path.join(ROOT, 'dist/security/jwt-tokens'));

const results = [];
const pass = (name, detail) => { results.push('PASS'); console.log('PASS ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); };
const fail = (name, detail) => { results.push('FAIL'); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : '')); };
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));

(async () => {
  const mod = require(path.join(ROOT, 'dist/app'));
  const app = (mod.createApp || mod.default || mod.app)();
  const server = http.createServer(app);
  await new Promise((ok) => server.listen(47934, '127.0.0.1', ok));
  const BASE = 'http://127.0.0.1:47934';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--no-sandbox'] });
  const TOKENS = { owner: signToken('access', { sub: OWNER.id, role: OWNER.role }, { expiresIn: '60m' }), coach: signToken('access', { sub: COACH.id, role: COACH.role }, { expiresIn: '60m' }) };

  async function open(viewport, locale, opts) {
    opts = opts || {};
    const as = opts.as || 'owner';
    CURRENT = as === 'coach' ? COACH : OWNER;
    const ctx = opts.ctx || await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.addCookies([{ name: 'access_token', value: TOKENS[as], domain: '127.0.0.1', path: '/', httpOnly: true }]);
    if (!opts.ctx) {
      await ctx.addInitScript((l) => {
        try { if (l && !sessionStorage.getItem('__seeded')) { localStorage.setItem('familista.locale', l); sessionStorage.setItem('__seeded', '1'); } localStorage.setItem('familista_token', ''); } catch (_) { /* private mode */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ d: e.violatedDirective, uri: String(e.blockedURI).slice(0, 80), src: String(e.sourceFile || '').slice(-60), line: e.lineNumber, sample: String(e.sample || '').slice(0, 60), inRoom: !!(e.target && e.target.closest && e.target.closest('#pd-root')) }));
      }, locale || null);
    }
    const page = await ctx.newPage();
    const log = { errors: [], requests: [] };
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) log.errors.push(m.text().slice(0, 200)); });
    page.on('request', (r) => log.requests.push({ path: new URL(r.url()).pathname, method: r.method() }));
    await page.goto(BASE + (opts.hash || '/#product-design'), { waitUntil: 'load' });
    if (opts.wait !== false) {
      await page.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(), null, { timeout: 30000 });
      await page.waitForTimeout(500);
    }
    return { ctx, page, log };
  }
  const M = (pg) => pg.evaluate(() => window.__familistaProductDesignMetrics());
  const shot = (pg, name) => pg.screenshot({ path: path.join(OUT, 'pd-' + name + '.png') });
  const draft = (pg) => pg.evaluate(() => localStorage.getItem('familista_product_design_draft_v1'));
  const live = (pg) => pg.evaluate(() => (document.querySelector('#pd-root .pd-sr[role="status"]') || {}).textContent || '');
  const boxOf = (pg, sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);

  try {
    // ── P1 the owner opens it, under the production CSP, and it asks the server for nothing ─────────────────────────
    // The app shell writes inline style attributes that the policy refuses (pre-existing, outside every room): measured
    // on another owner room in this same session, the Design Studio may add none, and none may come from inside it.
    let shellCsp;
    { const b = await open({ width: 1672, height: 941 }, 'en-GB', { hash: '/#system-updates', wait: false }); await b.page.waitForTimeout(4000); shellCsp = (await b.page.evaluate(() => window.__csp)).length; await b.ctx.close(); }
    const t0 = Date.now();
    const { ctx, page, log } = await open({ width: 1672, height: 941 }, 'en-GB');
    const readyMs = Date.now() - t0;
    const roomRequests = log.requests.filter((r) => /product-design/.test(r.path));
    check('P1 the Platform Owner opens the Design Studio; it loads exactly its own four static files, by GET', JSON.stringify(roomRequests.map((r) => r.method + ' ' + r.path).sort()) === JSON.stringify(['GET /product-design/pd-core.js', 'GET /product-design/product-design.css', 'GET /product-design/product-design.js', 'GET /product-design/templates/football-jersey.json']), roomRequests.map((r) => r.path));
    await page.waitForTimeout(3500);
    const csp = await page.evaluate(() => window.__csp);
    const inRoom = csp.filter((c) => c.inRoom || /product-design/.test(c.src + c.uri));
    check('P1 no Content-Security-Policy violation from the room, and none added to the app shell’s own (measured on System Updates)', inRoom.length === 0 && csp.length <= shellCsp, { inRoom: inRoom.length, total: csp.length, shell: shellCsp });
    check('P1 no page error', log.errors.length === 0, log.errors);
    const atReady = log.requests.length;

    // ── P2 regions against the approved reference, at its own size ───────────────────────────────────────────────────
    await shot(page, 'en-1672');
    await page.click('#pd-root [data-pd-mode="2d"]'); await page.waitForTimeout(200); await shot(page, 'en-1672-2d');
    await page.click('#pd-root [data-pd-mode="2.5d"]'); await page.waitForTimeout(200);
    const measured = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-ds-region]')].map((e) => {
      const r = e.getBoundingClientRect(); return [e.getAttribute('data-ds-region'), [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]];
    })));
    const rows = [];
    for (const [id, ref] of Object.entries(REGIONS.regions)) {
      const got = measured[id];
      const tol = (dim) => Math.max(REGIONS.tolerance.px, dim * REGIONS.tolerance.percent / 100);
      const edges = got ? [got[0] - ref.box[0], got[1] - ref.box[1], (got[0] + got[2]) - (ref.box[0] + ref.box[2]), (got[1] + got[3]) - (ref.box[1] + ref.box[3])] : null;
      const ok = !!edges && Math.abs(edges[0]) <= tol(ref.box[2]) && Math.abs(edges[2]) <= tol(ref.box[2]) && Math.abs(edges[1]) <= tol(ref.box[3]) && Math.abs(edges[3]) <= tol(ref.box[3]);
      rows.push({ id, name: ref.name, ref: ref.box, got, edges, ok });
    }
    fs.writeFileSync(path.join(OUT, 'pd-regions.json'), JSON.stringify(rows, null, 2));
    for (const r of rows) check(`P2 ${r.id} ${r.name} is where the approved reference puts it (each edge within ±16 px / 2 %)`, r.ok, { ref: r.ref, got: r.got, edgeDelta: r.edges });

    // ── P2 nothing overflows its panel at the reference size, in any official language (translations run longer) ─────
    // Every desktop width: at 1280 and 1024 the bottom cards keep their size in a strip that scrolls sideways, and the
    // action bar takes a second line, so nothing is squeezed out of sight; the strip must then be reachable by keyboard.
    for (const [w, h] of [[1672, 941], [1280, 800], [1024, 768]]) for (const loc of ['en-GB', 'de-DE', 'ar', 'fr-FR', 'es-ES']) {
      const o = await open({ width: w, height: h }, loc);
      await o.page.waitForTimeout(500);
      const over = await o.page.evaluate(() => {
        const q = (sel) => [...document.querySelectorAll('#pd-root ' + sel)];
        const bad = [];
        for (const e of q(':is(.pd-prod, .pd-foot-card, .pd-head, .pd-actions, .pd-sup, .pd-sup .pd-chip, .pd-ctx, .pd-tab, .pd-side-btn, .pd-flow-step, .pd-flow-label, .pd-integ)')) {
          if (!e.getClientRects().length) continue;
          const dh = e.scrollHeight - e.clientHeight, dw = e.scrollWidth - e.clientWidth;
          if (dh > 1 || dw > 1) bad.push(e.className.split(' ')[0] + ' ' + dw + '×' + dh + ' ' + (e.textContent || '').trim().slice(0, 16));
        }
        const foot = document.querySelector('#pd-root .pd-foot');
        if (foot.scrollWidth > foot.clientWidth + 1 && (foot.getAttribute('tabindex') !== '0' || !foot.getAttribute('aria-label'))) bad.push('the scrolling bottom strip cannot be reached by keyboard');
        return bad;
      });
      check(`P2 ${w} ${loc}: nothing overflows its panel (product column, header, action bar, bottom cards, steps, tabs, sidebar)`, over.length === 0, over);
      await o.ctx.close();
    }

    // ── P3 the palette: the module accent is the Design Studio's own token, not a status colour ──────────────────────
    const colours = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('pg-product-design'));
      const btn = getComputedStyle(document.querySelector('.pd-btn--primary'));
      return { accent: s.getPropertyValue('--fam-module-accent').trim(), accent2: s.getPropertyValue('--fam-module-accent-2').trim(), unverified: s.getPropertyValue('--fam-status-unverified').trim(), canvas: s.getPropertyValue('--fam-surface-canvas').trim(), primary: btn.backgroundImage.slice(0, 40) };
    });
    check('P3 the module accent resolves to violet-500 and blue-500, apart from the unverified status violet', /8b5cf6/i.test(colours.accent) && /3b82f6/i.test(colours.accent2) && /a78bfa/i.test(colours.unverified), colours);
    check('P3 the primary action is the accent gradient, on the dark navy canvas', /gradient/.test(colours.primary) && colours.canvas.length > 0, colours);

    // ── P4 editing: pointer, keyboard, undo, add, delete, design check ───────────────────────────────────────────────
    await page.click('#pd-root [data-pd-act="save"]');
    const crest = await page.evaluate(() => { const r = document.querySelector('#pd-root .pd-canvas [data-pd-node="l3"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(crest.x, crest.y);
    let m = await M(page);
    check('P4 a click on the crest selects it', m.selected && m.selected.id === 'l3', m.selected);
    const before = JSON.parse(await page.evaluate(() => localStorage.getItem('familista_product_design_draft_v1') || 'null') || 'null');
    const z = m.camera.z;
    await page.mouse.move(crest.x, crest.y); await page.mouse.down(); await page.mouse.move(crest.x - 30, crest.y + 20, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(1500);
    const afterDrag = JSON.parse(await draft(page));
    const crestAfter = afterDrag.surfaces[0].layers.find((l) => l.id === 'l3');
    check('P4 a drag moves it by the pointer distance at the zoom, in millimetres, as one undo step', Math.abs(crestAfter.x - (376 - 30 / z)) < 1 && Math.abs(crestAfter.y - (200 + 20 / z)) < 1 && (await M(page)).undo === 1, { x: crestAfter.x, y: crestAfter.y, z });
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('.');
    await page.waitForTimeout(1500);
    const k = JSON.parse(await draft(page)).surfaces[0].layers.find((l) => l.id === 'l3');
    check('P4 keys: an arrow moves 1 mm, Shift and an arrow 10 mm, full stop rotates 1°', Math.abs(k.x - crestAfter.x - 1) < 0.01 && Math.abs(k.y - crestAfter.y - 10) < 0.01 && k.r === 1, { x: k.x, y: k.y, r: k.r });
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
    await page.waitForTimeout(1500);
    const undone = JSON.parse(await draft(page));
    check('P4 undo returns the design to the bytes it started from', JSON.stringify(undone) === JSON.stringify(before), (await M(page)).undo);
    await page.click('#pd-root [data-pd-act="add-text"]');
    m = await M(page);
    const added = m.selected && m.selected.id;
    await page.fill('#pd-root .pd-props [data-pd-field="text"]', 'فاميليستا 2026');
    await page.waitForTimeout(1400);
    const withText = JSON.parse(await draft(page)).surfaces[0].layers.find((l) => l.id === added);
    check('P4 a text element is added and takes Arabic text, rendered as text', withText && withText.text === 'فاميليستا 2026' && await page.evaluate((id) => document.querySelector('#pd-root .pd-canvas [data-pd-node="' + id + '"] text').textContent, added) === 'فاميليستا 2026', withText);
    await page.fill('#pd-root .pd-props [data-pd-field="text"]', 'FAMILISTA FOOTBALL CLUB OFFICIAL 2026');
    await page.waitForTimeout(300);
    const fitted = await page.evaluate((id) => { const t = document.querySelector('#pd-root .pd-canvas [data-pd-node="' + id + '"] text'); return { len: t.getAttribute('textLength'), adj: t.getAttribute('lengthAdjust'), drawn: t.getComputedTextLength() }; }, added);
    check('P4 lettering longer than its box is condensed into it (220 mm), never overflowing', fitted.len === '220' && fitted.adj === 'spacingAndGlyphs' && Math.abs(fitted.drawn - 220) < 0.5, fitted);
    await page.focus('#pd-root .pd-canvas'); await page.keyboard.press('Delete');
    await page.waitForTimeout(400);
    check('P4 Delete removes it, and says Undo brings it back', !(await page.evaluate((id) => !!document.querySelector('#pd-root .pd-canvas [data-pd-node="' + id + '"]'), added)) && /Undo/.test(await live(page)), await live(page));
    const checkOk = await page.getAttribute('#pd-root .pd-checkline', 'data-state');
    await page.mouse.click(crest.x, crest.y);
    await page.fill('#pd-root .pd-props [data-pd-field="x"]', '640'); await page.press('#pd-root .pd-props [data-pd-field="x"]', 'Tab');
    await page.waitForTimeout(300);
    const checkBad = await page.getAttribute('#pd-root .pd-checkline', 'data-state');
    check('P4 the design check: clean as started; a crest moved off the shirt is reported (negative control)', checkOk === 'ok' && checkBad === 'blocker', { checkOk, checkBad });
    await page.keyboard.press('Control+z'); await page.waitForTimeout(300);

    // ── P5 the draft: this browser only, across a reload, and through export and import ──────────────────────────────
    await page.click('#pd-root [data-pd-act="save"]');
    const saved = await draft(page);
    const notice = await page.evaluate(() => document.querySelector('#pd-root .pd-local').textContent);
    check('P5 the screen says drafts are saved only in this browser', /saved only in this browser/.test(notice), notice);
    const beforeReload = log.requests.length;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics());
    await page.waitForTimeout(400);
    const afterReload = log.requests.length;
    check('P5 a reload reopens the same draft, byte for byte', (await draft(page)) === saved, (await M(page)).saveState);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pd-root [data-pd-act="export"]')]);
    const exported = fs.readFileSync(await download.path(), 'utf8');
    check('P5 export writes the validated document under a safe file name', exported === saved && /\.familista-product-design\.json$/.test(download.suggestedFilename()), download.suggestedFilename());
    const changed = JSON.parse(exported); changed.name = 'Imported kit';
    const file = path.join(OUT, 'import.familista-product-design.json');
    fs.writeFileSync(file, JSON.stringify(changed));
    await page.setInputFiles('#pd-root input[type="file"]', file);
    await page.waitForTimeout(600);
    check('P5 import replaces the design with a validated file', JSON.parse(await draft(page)).name === 'Imported kit', await live(page));
    fs.writeFileSync(file, '{"format":"familista.studio.document","version":1}');
    await page.setInputFiles('#pd-root input[type="file"]', file);
    await page.waitForTimeout(600);
    check('P5 an Interface Studio file (or any other) is refused and changes nothing', JSON.parse(await draft(page)).name === 'Imported kit' && /Not imported/.test(await live(page)), await live(page));

    // ── P6 every unavailable control says why when it is used, and changes nothing ───────────────────────────────────
    for (const [sel, reason] of [['[data-pd-mode="3d"]', '3D'], ['[data-pd-act="order"]', 'Ordering'], ['[data-pd-act="versions"]', 'versions'], ['[data-pd-act="image"]', 'Uploading artwork'], ['[data-pd-act="proof"]', 'Production proofs']]) {
      const sBefore = await draft(page);
      // aria-disabled, not disabled: a person can still press it and hear why (Playwright needs `force` to do the same).
      await page.click('#pd-root ' + sel, { force: true });
      await page.waitForTimeout(150);
      const said = await live(page);
      check(`P6 ${sel} is unavailable and says why`, (await page.getAttribute('#pd-root ' + sel, 'aria-disabled')) === 'true' && said.includes(reason) && (await draft(page)) === sBefore, said);
    }
    const metrics = await M(page);
    // Two windows in which only the room acts: editing (from ready to the reload the proof itself makes), then export,
    // import and the unavailable controls (from the reloaded room being ready to here). The shell's own page load is not in either.
    const during = log.requests.slice(atReady, beforeReload).concat(log.requests.slice(afterReload));
    check('P6 while it was edited, saved, exported and imported, nothing was written to the server (no request but GET)', during.filter((r) => r.method !== 'GET' && r.method !== 'HEAD').length === 0, during.filter((r) => /\/api\//.test(r.path)).slice(0, 12));
    await ctx.close();

    // ── P7 Arabic: the chrome mirrors, the garment does not ──────────────────────────────────────────────────────────
    {
      const { ctx: c2, page: p2, log: l2 } = await open({ width: 1672, height: 941 }, 'ar');
      await shot(p2, 'ar-1672');
      const ar = await p2.evaluate(() => {
        const root = document.getElementById('pd-root'), side = root.querySelector('.pd-side').getBoundingClientRect(), canvas = root.querySelector('.pd-canvas');
        const crestBox = canvas.querySelector('[data-pd-node="l3"]').getBoundingClientRect(), cb = canvas.getBoundingClientRect();
        const arrow = getComputedStyle(root.querySelector('.pd-strip-nav .fam-dir-ic')).transform;
        return { dir: root.getAttribute('dir'), lang: root.getAttribute('lang'), sideX: side.x, canvasDir: canvas.getAttribute('dir'), crestRight: crestBox.x + crestBox.width / 2 > cb.x + cb.width / 2, arrow, title: root.querySelector('.pd-title h1').textContent, front: root.querySelector('[data-pd-view="front"] .pd-view-label').textContent };
      });
      check('P7 Arabic: the room is right to left and the sidebar is on the right', ar.dir === 'rtl' && ar.lang === 'ar' && ar.sideX > 1400, ar);
      check('P7 Arabic: the garment is not mirrored — the crest on the wearer’s left chest stays on the viewer’s right', ar.canvasDir === 'ltr' && ar.crestRight, ar);
      check('P7 Arabic: a paging arrow turns, and the room speaks its catalogue', /matrix\(-1/.test(ar.arrow) && ar.front === roomWord('ar', 'Front') && ar.title === 'Design Studio', ar);
      check('P7 Arabic: no CSP violation from the room, no page error', (await p2.evaluate(() => window.__csp.filter((c) => c.inRoom).length)) === 0 && l2.errors.length === 0, l2.errors);
      await c2.close();
      const { ctx: c2b, page: p2b } = await open({ width: 390, height: 844 }, 'ar', { mobile: true });
      await shot(p2b, 'ar-390');
      const lay = await p2b.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dir: document.getElementById('pd-root').getAttribute('dir'), canvas: document.querySelector('#pd-root .pd-canvas').getAttribute('dir') }));
      check('P7 Arabic on a phone (390): right to left, the garment left to right, no sideways scroll', lay.dir === 'rtl' && lay.canvas === 'ltr' && lay.sw <= lay.iw + 1, lay);
      await c2b.close();
    }

    // ── P8 every width: the layout adapts and never scrolls sideways; small screens return to normal scrolling ───────
    for (const [w, h, mobile] of [[1280, 800, false], [1024, 768, false], [768, 1024, true], [390, 844, true]]) {
      const { ctx: c3, page: p3, log: l3 } = await open({ width: w, height: h }, 'en-GB', { mobile });
      await shot(p3, 'en-' + w);
      const lay = await p3.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight, ih: window.innerHeight,
        tabbar: getComputedStyle(document.querySelector('#pd-root .pd-tabbar')).display, lib: getComputedStyle(document.querySelector('#pd-root .pd-lib')).visibility }));
      check(`P8 ${w}×${h}: no sideways scroll`, lay.sw <= lay.iw + 1, lay);
      if (w <= 980) {
        check(`P8 ${w}: normal scrolling, the panel bar is shown and the sheets are closed`, lay.sh > lay.ih && lay.tabbar !== 'none' && lay.lib === 'hidden', lay);
        const canvasBefore = await boxOf(p3, '#pd-root .pd-canvas');
        await p3.click('#pd-root [data-pd-panel="library"]');
        await p3.waitForTimeout(450);
        const open1 = await p3.evaluate(() => getComputedStyle(document.querySelector('#pd-root .pd-lib')).visibility);
        const canvasAfter = await boxOf(p3, '#pd-root .pd-canvas');
        check(`P8 ${w}: the library opens as a sheet over the page, and nothing under it moves`, open1 === 'visible' && JSON.stringify(canvasBefore) === JSON.stringify(canvasAfter), { canvasBefore, canvasAfter });
      } else if (w <= 1279) {
        const canvasBefore = await boxOf(p3, '#pd-root .pd-canvas');
        await p3.click('#pd-root [data-pd-act="elements"]');
        await p3.waitForTimeout(450);
        const canvasAfter = await boxOf(p3, '#pd-root .pd-canvas');
        check(`P8 ${w}: the library opens as a drawer, and the canvas does not move`, (await p3.evaluate(() => getComputedStyle(document.querySelector('#pd-root .pd-lib')).visibility)) === 'visible' && JSON.stringify(canvasBefore) === JSON.stringify(canvasAfter), { canvasBefore, canvasAfter });
      } else {
        check(`P8 ${w}: the sidebar is an icon rail and the product column folds into the inspector`, (await boxOf(p3, '#pd-root .pd-side')).w <= 64 && (await p3.evaluate(() => getComputedStyle(document.querySelector('#pd-root .pd-prod')).display)) === 'none');
      }
      check(`P8 ${w}: no page error`, l3.errors.length === 0, l3.errors);
      await c3.close();
    }

    // ── P9 nothing moves that the reader did not move ────────────────────────────────────────────────────────────────
    {
      const { ctx: c4, page: p4 } = await open({ width: 1672, height: 941 }, 'en-GB');
      const before4 = await boxOf(p4, '#pd-root .pd-canvas');
      for (const t of ['colour', 'material', 'sizes', 'design']) { await p4.click(`#pd-root [data-pd-insptab="${t}"]`); await p4.waitForTimeout(120); }
      await p4.click('#pd-root [data-pd-libtab="elements"]'); await p4.click('#pd-root [data-pd-acc]').catch(() => {});
      await p4.click('#pd-root [data-pd-libtab="products"]'); await p4.click('#pd-root [data-pd-acc="everyday"]');
      const after4 = await boxOf(p4, '#pd-root .pd-canvas');
      check('P9 switching inspector tabs, library tabs and opening a section move the canvas by not one pixel', JSON.stringify(before4) === JSON.stringify(after4), { before4, after4 });
      // A review sheet: the approved reference beside the room, for a person to judge.
      const ref = 'data:image/webp;base64,' + fs.readFileSync(REFERENCE).toString('base64');
      const mine = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'pd-en-1672.png')).toString('base64');
      const sheet = await browser.newPage({ viewport: { width: 1672, height: 941 * 2 + 60 } });
      await sheet.setContent(`<body style="margin:0;background:#111;color:#ddd;font:14px sans-serif"><div style="padding:6px 10px">Approved reference (top) — DS-1a, English, 1672 × 941 (bottom)</div><img src="${ref}" width="1672" height="941" style="display:block"><img src="${mine}" width="1672" height="941" style="display:block;margin-top:30px"></body>`);
      await sheet.screenshot({ path: path.join(OUT, 'pd-review-sheet.png'), fullPage: true });
      await sheet.close();
      await c4.close();
    }

    // ── P10 a club coach never loads it (negative control) ───────────────────────────────────────────────────────────
    {
      const { ctx: c5, page: p5, log: l5 } = await open({ width: 1280, height: 800 }, 'en-GB', { as: 'coach', wait: false });
      await p5.waitForTimeout(2500);
      const loaded = l5.requests.filter((r) => /product-design/.test(r.path));
      const has = await p5.evaluate(() => typeof window.__familistaProductDesignMetrics);
      check('P10 a club coach who opens #product-design downloads nothing of it, and no room is drawn', loaded.length === 0 && has === 'undefined', { loaded, has });
      await c5.close();
    }

    // ── P11 the Platform Owner navigation shows it in the other rooms ────────────────────────────────────────────────
    {
      const { ctx: c6, page: p6 } = await open({ width: 1672, height: 941 }, 'en-GB', { hash: '/#system-updates', wait: false });
      await p6.waitForSelector('#su-root .su-ownernav [data-owner-nav="product-design"]', { timeout: 30000 });
      await p6.click('#su-root .su-ownernav [data-owner-nav="product-design"]');
      await p6.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(), null, { timeout: 30000 });
      check('P11 System Updates shows Design Studio in the Platform Owner navigation, and it opens the room', true);
      await c6.close();
    }

    // ── P13 accessibility: axe (WCAG 2.2 AA) on the room, English and Arabic, with an element selected; and a control ──
    {
      const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
      if (!fs.existsSync(axePath)) fail('P13 axe-core is not installed (npm ci --ignore-scripts --prefix tools/components)');
      else {
        const src = fs.readFileSync(axePath, 'utf8');
        const runAxe = (pg) => pg.evaluate(async (src) => {
          if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
          const r = await window.axe.run({ include: ['#pg-product-design'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
        }, src);
        for (const loc of ['en-GB', 'ar']) {
          const { ctx: c8, page: p8 } = await open({ width: 1672, height: 941 }, loc);
          const c = await p8.evaluate(() => { const r = document.querySelector('#pd-root .pd-canvas [data-pd-node="l3"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
          await p8.mouse.click(c.x, c.y);
          await p8.waitForTimeout(200);
          const v = await runAxe(p8);
          check(`P13 ${loc}: axe finds no WCAG 2.2 A/AA violation in the room, with the properties form open`, v.length === 0, v);
          if (loc === 'en-GB') {
            await p8.evaluate(() => { const b = document.createElement('button'); b.className = 'pd-axe-control'; document.querySelector('#pd-root .pd-props').appendChild(b); });
            const v2 = await runAxe(p8);
            check('P13 control: a nameless button put into the room is reported by axe (button-name)', v2.some((x) => x.id === 'button-name'), v2.map((x) => x.id));
          }
          await c8.close();
        }
      }
    }

    // ── P14 the Interface Studio is untouched and still works beside it ──────────────────────────────────────────────
    {
      const { ctx: c9, page: p9, log: l9 } = await open({ width: 1440, height: 900 }, 'en-GB', { hash: '/#design-studio', wait: false });
      await p9.waitForFunction(() => window.__familistaStudioMetrics && window.__familistaStudioMetrics(), null, { timeout: 30000 });
      const st = await p9.evaluate(() => ({ m: window.__familistaStudioMetrics(), title: (document.querySelector('#st-root .st-title') || {}).textContent, pd: typeof window.__familistaProductDesignMetrics }));
      check('P14 the Interface Studio (#design-studio) opens and draws as before, with its own title, loading none of the Design Studio', st.m && st.m.mounts >= 1 && st.title === 'Design Studio' && st.pd === 'undefined' && !l9.requests.some((r) => /product-design/.test(r.path)), st);
      // The Interface Studio's own draft, written by the Interface Studio itself, must come through the Design Studio untouched.
      await p9.evaluate(() => window.teardownFamilistaDesignStudio && window.teardownFamilistaDesignStudio());
      const isBefore = await p9.evaluate(() => { const k = 'familista_design_studio_document'; if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ format: 'familista.studio.document', version: 1, name: 'Interface draft', frames: [] })); return localStorage.getItem(k); });
      await p9.evaluate(() => { location.hash = '#product-design'; });
      await p9.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(), null, { timeout: 30000 });
      await p9.click('#pd-root [data-pd-act="save"]');
      const after = await p9.evaluate(() => ({ is: localStorage.getItem('familista_design_studio_document'), keys: Object.keys(localStorage).filter((k) => /design/.test(k)).sort() }));
      const allowed = ['familista_design_studio_document', 'familista_design_studio_document_unreadable', 'familista_product_design_draft_v1', 'familista_product_design_draft_v1_unreadable'];
      check('P14 each studio keeps its own draft: the Design Studio writes its own key and leaves the Interface Studio’s byte for byte', after.is === isBefore && after.keys.includes('familista_product_design_draft_v1') && after.keys.every((k) => allowed.includes(k)), after.keys);
      await c9.close();
    }

    // ── P12 timings, measured, not claimed ───────────────────────────────────────────────────────────────────────────
    check('P12 time to an editable room ≤ 2.5 s on this machine (navigation to ready, served locally)', readyMs <= 2500, { readyMs });
    {
      // Warm: twenty keyboard edits in an open room, each a committed change and a full repaint of the canvas.
      const { ctx: c7, page: p7 } = await open({ width: 1672, height: 941 }, 'en-GB');
      const c = await p7.evaluate(() => { const r = document.querySelector('#pd-root .pd-canvas [data-pd-node="l3"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await p7.mouse.click(c.x, c.y);
      const e0 = (await M(p7)).edits;
      for (let i = 0; i < 20; i++) { await p7.keyboard.press('ArrowRight'); await p7.waitForTimeout(30); }
      const m7 = await M(p7);
      check('P12 a committed edit updates the canvas in ≤ 16 ms (median of 20 keyboard edits, warm)', m7.edits - e0 >= 20 && m7.editMsMedian <= 16, { median: m7.editMsMedian, p95: m7.editMsP95, edits: m7.edits - e0, layerPaints: m7.layerPaints });
      await p7.click('#pd-root [data-pd-view="back"]');
      for (let i = 0; i < 6; i++) { await p7.click('#pd-root [data-pd-view="' + (i % 2 ? 'back' : 'front') + '"]'); await p7.waitForTimeout(60); }
      const full = await M(p7);
      check('P12 a full repaint (switching views) ≤ 50 ms (median, warm)', full.renderMsMedian <= 50, { median: full.renderMsMedian, max: full.renderMsMax, renders: full.renders });
      await c7.close();
    }
  } catch (e) {
    fail('proof crashed', String(e && e.stack || e).slice(0, 1200));
  } finally {
    await browser.close();
    server.close();
    const n = (s) => results.filter((r) => r === s).length;
    console.log(`SUMMARY ${n('PASS')} passed, ${n('FAIL')} failed, 0 skipped`);
    process.exit(n('FAIL') ? 1 : 0);
  }
})();
