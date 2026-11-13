// Familista — Design Studio (DS-1a, DS-1b, DS-1c): browser proofs. DS-1c's 3D view is P16, in product-design-3d-proof.cjs.
//
// What Jest cannot see, proven in a real Chromium against the REAL compiled application served by the REAL app on a
// REAL PostgreSQL (DS-1b gave the room a backend, so nothing is stubbed): a database freshly migrated, owned by a role
// that is not a superuser, as in production, seeded with one club, the Platform Owner and a club coach, and dropped at
// the end. That only the Platform Owner ever loads the room,
// that it runs under the production Content-Security-Policy without a single violation, that its regions sit where the
// approved reference image puts them, that editing works by pointer and keyboard and undoes exactly, that the design
// check reacts, that a draft survives a reload and round-trips through export and import, that every unavailable control
// says why, that Arabic mirrors the chrome and never the garment, that it fits every width without moving what the
// reader did not move, and how fast it is.
//
//   npm run build
//   PRODUCT_DESIGN_DB_DATABASE_URL=postgresql://admin@host:5432/postgres node tools/components/product-design-browser-proof.cjs <output-dir>
//
//   PRODUCT_DESIGN_DB_DATABASE_URL   a PostgreSQL server the proof may create a role and a database on (required)
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
// The page's own origin, allowlisted as production allowlists its own: a browser sends Origin on a same-origin POST, and
// the CORS allowlist (src/app.ts) refuses one it does not know, which is the control the proof must not switch off.
process.env.FRONTEND_URL = 'http://127.0.0.1:47934';

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
// PROOF_ONLY=P16 runs only the DS-1c 3D sections (P16); unset, everything runs.
const want = (n) => !process.env.PROOF_ONLY || process.env.PROOF_ONLY.split(',').includes(n);
const roomWord = (code, en) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'))[en];

const OWNER = { id: 'u-owner', email: 'owner@familista.test', role: 'SUPER_ADMIN' };
const COACH = { id: 'u-coach', email: 'coach@familista.test', role: 'COACH' };
let CURRENT = OWNER; // eslint-disable-line no-unused-vars -- kept for open()'s signature; the database decides who is who

// ── the database: real PostgreSQL, created for this run and dropped after it ──────────────────────────────────────────
const ADMIN_URL = process.env.PRODUCT_DESIGN_DB_DATABASE_URL || '';
if (!ADMIN_URL) { console.error('PRODUCT_DESIGN_DB_DATABASE_URL must name a PostgreSQL server this proof may create a role and a database on'); process.exit(2); }
const { randomBytes } = require('crypto');
const { spawnSync } = require('child_process');
const TAG = randomBytes(4).toString('hex');
const DBROLE = `fam_pdp_${TAG}`, DBPASS = `pw_${randomBytes(12).toString('hex')}`, DBNAME = `fam_pdp_${TAG}`;
function urlFor(name, user, pass) { const u = new URL(ADMIN_URL); u.pathname = '/' + name; if (user) { u.username = user; u.password = pass || ''; } return u.toString(); }
const DB_URL = urlFor(DBNAME, DBROLE, DBPASS);
let admin = null, db = null, signToken = null;
async function prepareDatabase() {
  const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
  admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  await admin.$executeRawUnsafe(`CREATE ROLE "${DBROLE}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD '${DBPASS}'`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${DBNAME}" OWNER "${DBROLE}"`);
  const m = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL, DIRECT_URL: DB_URL }, encoding: 'utf8', timeout: 240000 });
  if (m.status !== 0) throw new Error('prisma migrate deploy failed: ' + m.stderr);
  db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
    await tx.club.create({ data: { id: 'club-1', name: 'Home FC', city: 'X' } });
    for (const u of [OWNER, COACH]) await tx.user.create({ data: { id: u.id, clubId: 'club-1', email: u.email, passwordHash: 'x', firstName: u === OWNER ? 'Owner' : 'Coach', lastName: 'Proof', role: u.role } });
  });
  // The application reads its database URL when it is first required, so it is required only now.
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  signToken = require(path.join(ROOT, 'dist/security/jwt-tokens')).signToken;
}
async function dropDatabase() {
  try { if (db) await db.$disconnect(); } catch (_) { /* already gone */ }
  try { await require(path.join(ROOT, 'dist/config/database')).prisma.$disconnect(); } catch (_) { /* never connected */ }
  if (!admin) return;
  try { await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`); await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${DBROLE}"`); } catch (_) { /* reported by the server's own log */ }
  try { await admin.$disconnect(); } catch (_) { /* nothing to close */ }
}

const results = [];
const pass = (name, detail) => { results.push('PASS'); console.log('PASS ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); };
const fail = (name, detail) => { results.push('FAIL'); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : '')); };
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));

(async () => {
  try { await prepareDatabase(); } catch (e) { console.log('FAIL the proof database could not be prepared :: ' + String(e && e.message || e).slice(0, 600)); await dropDatabase(); process.exit(1); }
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
  async function proof3d() { await require('./product-design-3d-proof.cjs')({ open, M, shot, live, boxOf, check, pass, fail, OUT, ROOT, BASE, db, roomWord }); }
  const boxOf = (pg, sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);

  try {
    ds1: { // eslint-disable-line no-labels -- PROOF_ONLY=P16 skips the DS-1a and DS-1b sections without reindenting them
    if (!want('DS1')) break ds1; // eslint-disable-line no-labels
    // ── P1 the owner opens it, under the production CSP, and it asks the server for nothing until a design is saved ─
    // The app shell writes inline style attributes that the policy refuses (pre-existing, outside every room): measured
    // on another owner room in this same session, the Design Studio may add none, and none may come from inside it.
    let shellCsp;
    { const b = await open({ width: 1672, height: 941 }, 'en-GB', { hash: '/#system-updates', wait: false }); await b.page.waitForTimeout(4000); shellCsp = (await b.page.evaluate(() => window.__csp)).length; await b.ctx.close(); }
    const t0 = Date.now();
    const { ctx, page, log } = await open({ width: 1672, height: 941 }, 'en-GB');
    const readyMs = Date.now() - t0;
    const roomRequests = log.requests.filter((r) => /product-design/.test(r.path));
    check('P1 the Platform Owner opens the Design Studio; it loads exactly its own seven static files (DS-1c: the garment and the 3D view, not the 3D engine), by GET, and calls no API', JSON.stringify(roomRequests.map((r) => r.method + ' ' + r.path).sort()) === JSON.stringify(['GET /product-design/pd-3d.js', 'GET /product-design/pd-core.js', 'GET /product-design/pd-garment.js', 'GET /product-design/pd-server.js', 'GET /product-design/product-design.css', 'GET /product-design/product-design.js', 'GET /product-design/templates/football-jersey.json']), roomRequests.map((r) => r.path));
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

    // ── P5 the draft: kept in this browser, across a reload, and through export and import ───────────────────────────
    await page.click('#pd-root [data-pd-act="save"]');
    await page.waitForFunction(() => !window.__familistaProductDesignMetrics().server.busy, null, { timeout: 15000 });
    const saved = await draft(page);
    const notice = await page.evaluate(() => document.querySelector('#pd-root .pd-local').textContent);
    check('P5 the screen says where the design is kept: saved designs on the server, the draft in this browser', /Familista server/.test(notice) && /this browser/.test(notice), notice);
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
    // DS-1c made 3D live where WebGL is (its unavailable state, without WebGL, is proven in P16); image export is still planned.
    for (const [sel, reason] of [['[data-pd-act="capture"]', 'Image export'], ['[data-pd-act="order"]', 'Ordering'], ['[data-pd-act="image"]', 'Uploading artwork'], ['[data-pd-act="proof"]', 'Production proofs']]) {
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
    const writes = during.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    check('P6 while it was edited, saved, exported and imported, the only writes were the Save button\'s, to the design routes', writes.length >= 1 && writes.every((r) => r.method === 'POST' && /^\/api\/v1\/system\/product-design\/projects(\/[0-9a-f-]{36}\/revisions)?$/.test(r.path)), writes.slice(0, 12));
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
          await p8.click('#pd-root .pd-actions [data-pd-act="projects"]');
          await p8.waitForFunction(() => window.__familistaProductDesignMetrics().server.list !== 'loading', null, { timeout: 15000 });
          await p8.waitForTimeout(300);
          const vd = await runAxe(p8);
          check(`P13 ${loc}: and none with the saved-designs panel open`, vd.length === 0, vd);
          await p8.keyboard.press('Escape');
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

    // ── P15 DS-1b: saved on the server — the DS-1a draft, saves, a conflict, versions, projects, failures ────────────
    {
      const rows = async () => ({
        projects: await db.designProject.count(), revisions: await db.designRevision.count(),
        audit: await db.platformAuditLog.count({ where: { action: { startsWith: 'design.' } } }),
      });
      const S = (pg) => pg.evaluate(() => window.__familistaProductDesignMetrics().server);
      const stateText = (pg) => pg.evaluate(() => document.querySelector('#pd-root .pd-savestate').textContent);
      const idle = (pg) => pg.waitForFunction(() => !window.__familistaProductDesignMetrics().server.busy, null, { timeout: 15000 });
      const docName = (pg) => pg.evaluate(() => document.querySelector('#pd-root .pd-docname').value);
      const edit = async (pg, steps) => {
        const c = await pg.evaluate(() => { const r = document.querySelector('#pd-root .pd-canvas [data-pd-node="l3"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await pg.mouse.click(c.x, c.y);
        for (let i = 0; i < (steps || 1); i++) await pg.keyboard.press('ArrowRight');
        await pg.waitForTimeout(1500); // past the local autosave
      };
      const rename = async (pg, name) => { await pg.fill('#pd-root .pd-docname', name); await pg.press('#pd-root .pd-docname', 'Enter'); await pg.waitForTimeout(1500); };
      const save = async (pg) => { await pg.click('#pd-root .pd-actions [data-pd-act="save"]'); await idle(pg); };
      const dock = (pg) => pg.waitForFunction(() => document.getElementById('pd-dock').getAttribute('data-open') === 'true');
      const openTab = async (pg, tab) => {
        const open = await pg.evaluate(() => document.getElementById('pd-dock').getAttribute('data-open') === 'true');
        if (!open) { await pg.click(`#pd-root .pd-actions [data-pd-act="${tab}"]`); await dock(pg); }
        else await pg.click(`#pd-dock [data-pd-docktab="${tab}"]`);
        await pg.waitForFunction((t) => { const m = window.__familistaProductDesignMetrics().server; return m.tab === t && (t === 'projects' ? m.list : m.versions) !== 'loading'; }, tab, { timeout: 15000 });
      };
      const start = await rows();

      // a. a draft DS-1a left in this browser becomes a saved design on its first save, and the draft stays where it was
      const { ctx: ca, page: a } = await open({ width: 1672, height: 941 }, 'en-GB');
      await rename(a, 'Browser draft kit');
      await a.reload({ waitUntil: 'load' });
      await a.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics());
      await a.waitForTimeout(400);
      let sa = await S(a);
      const before = await draft(a);
      check('P15 a draft kept in this browser, not on the server, says so and remembers where it came from', !sa.linked && sa.state === 'local' && sa.origin === 'BROWSER_DRAFT' && /Not on the Familista server yet/.test(await stateText(a)), { sa, text: await stateText(a) });
      await save(a);
      sa = await S(a);
      const p1 = await db.designProject.findFirst({ where: { id: sa.projectId || '' }, include: { revisions: true } });
      check('P15 its first save creates a project from it (origin BROWSER_DRAFT, revision 1, CREATE), and the draft in this browser is unchanged',
        sa.linked && sa.state === 'saved' && sa.revision === 1 && p1 && p1.origin === 'BROWSER_DRAFT' && p1.name === 'Browser draft kit' && p1.revisions.length === 1 && p1.revisions[0].kind === 'CREATE' && (await draft(a)) === before && /Saved · version 1/.test(await stateText(a)),
        { sa, origin: p1 && p1.origin, text: await stateText(a) });

      // b. an edit is an unsaved change until saved; Ctrl+S saves it as the next version
      await edit(a);
      check('P15 an edit after saving reads "Unsaved changes" until it is saved', (await S(a)).state === 'dirty' && /Unsaved changes/.test(await stateText(a)), await stateText(a));
      await a.keyboard.press('Control+s');
      await idle(a);
      check('P15 Ctrl+S saves it as version 2', (await S(a)).revision === 2 && (await db.designRevision.count({ where: { projectId: p1.id } })) === 2, await S(a));

      // c. a conflict: another session saves first; this one is refused, writes nothing, says so, and keeps its work
      const { ctx: cb, page: b } = await open({ width: 1672, height: 941 }, 'en-GB');
      await openTab(b, 'projects');
      await b.click(`#pd-dock [data-pd-act="open-project"][data-pd-id="${p1.id}"]`);
      await b.waitForFunction((id) => window.__familistaProductDesignMetrics().server.projectId === id, p1.id, { timeout: 15000 });
      // A different change from the one the first session is about to make: an identical one would be the same document,
      // which the server rightly answers as already saved rather than as a conflict.
      await edit(b, 3); await save(b);
      check('P15 a second session opens the same design from Projects and saves version 3', (await S(b)).revision === 3, await S(b));
      await edit(a);
      const preConflict = await rows();
      await save(a);
      sa = await S(a);
      const conflictShown = await a.evaluate(() => !!document.querySelector('#pd-dock[data-open="true"] .pd-dock-conflict'));
      check('P15 the first session\'s save on version 2 is refused: it says a newer version (3) is on the server, writes nothing, and keeps its changes',
        sa.state === 'conflict' && sa.conflict && sa.conflict.head === 3 && conflictShown && JSON.stringify(await rows()) === JSON.stringify(preConflict) && /newer version \(3\)/.test(await stateText(a)),
        { sa, conflictShown, text: await stateText(a) });
      await shot(a, 'ds1b-conflict');
      const v3 = await db.designRevision.findUnique({ where: { projectId_number: { projectId: p1.id, number: 3 } } });
      await a.click('#pd-dock [data-pd-act="conflict-keep"]');
      await idle(a);
      const v3after = await db.designRevision.findUnique({ where: { projectId_number: { projectId: p1.id, number: 3 } } });
      check('P15 "Save mine as version 4" saves it on top, and version 3 is still exactly what the other session saved',
        (await S(a)).revision === 4 && (await S(a)).state === 'saved' && v3after.sha256 === v3.sha256 && JSON.stringify(v3after.document) === JSON.stringify(v3.document), await S(a));
      await cb.close();

      // d. versions: listed newest first; restoring version 1 makes version 5 and changes none of 1–4
      await openTab(a, 'versions');
      const listed = await a.$$eval('#pd-dock .pd-dock-list .pd-dock-name', (els) => els.map((e) => e.textContent.trim()));
      check('P15 Versions lists every version, newest first', JSON.stringify(listed) === JSON.stringify(['Version 4', 'Version 3', 'Version 2', 'Version 1']), listed);
      const shas = (await db.designRevision.findMany({ where: { projectId: p1.id }, orderBy: { number: 'asc' } })).map((r) => r.sha256);
      await a.click('#pd-dock [data-pd-act="restore"][data-pd-n="1"]');
      await idle(a);
      await a.waitForTimeout(400);
      const revs = await db.designRevision.findMany({ where: { projectId: p1.id }, orderBy: { number: 'asc' } });
      check('P15 restoring version 1 makes version 5 (RESTORE, from 1), opens it in the editor, and versions 1–4 are untouched',
        (await S(a)).revision === 5 && revs.length === 5 && revs[4].kind === 'RESTORE' && revs[4].restoredFrom === 1 && revs[4].sha256 === revs[0].sha256
          && JSON.stringify(revs.slice(0, 4).map((r) => r.sha256)) === JSON.stringify(shas) && (await docName(a)) === 'Browser draft kit',
        { s: await S(a), kinds: revs.map((r) => r.kind) });

      // e. opening the panel moves nothing; it is fixed, scrolls inside itself, and Escape closes it back to its button
      const boxes = () => a.evaluate(() => [...document.querySelectorAll('#pd-root [data-ds-region]')].map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('data-ds-region'), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
      await a.keyboard.press('Escape');
      await a.waitForTimeout(300);
      const focusBack = await a.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-pd-act'));
      const closed = await boxes();
      await a.click('#pd-root .pd-actions [data-pd-act="projects"]');
      await dock(a);
      await a.waitForTimeout(400);
      const opened = await boxes();
      const geo = await a.evaluate(() => { const d = document.getElementById('pd-dock'), cs = getComputedStyle(d), b = d.querySelector('.pd-dock-body'); return { position: cs.position, overflowY: getComputedStyle(b).overflowY, gutter: getComputedStyle(b).scrollbarGutter, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      check('P15 Escape closes the panel and returns focus to the button that opened it', focusBack === 'versions', focusBack);
      check('P15 opening the panel moves nothing: every region keeps its box; the panel is fixed and scrolls inside itself', JSON.stringify(closed) === JSON.stringify(opened) && geo.position === 'fixed' && geo.overflowY === 'auto' && geo.gutter === 'stable' && geo.sideways <= 0, { geo, moved: closed.filter((b, i) => JSON.stringify(b) !== JSON.stringify(opened[i])) });
      await shot(a, 'ds1b-projects');

      // f. projects: a second design, unsaved-change protection, archive and return
      await a.waitForFunction(() => window.__familistaProductDesignMetrics().server.list === 'ready');
      await a.click('#pd-dock [data-pd-act="new-design"]');
      await a.waitForTimeout(400);
      check('P15 New design (nothing unsaved) starts a design that is not on the server yet', !(await S(a)).linked && (await S(a)).origin === 'EDITOR', await S(a));
      await rename(a, 'Away kit');
      await save(a);
      const p2 = (await S(a)).projectId;
      await edit(a);
      await openTab(a, 'projects');
      await a.click(`#pd-dock [data-pd-act="open-project"][data-pd-id="${p1.id}"]`);
      await a.waitForTimeout(300);
      const asked = await a.evaluate(() => !!document.querySelector('#pd-dock .pd-dock-confirm'));
      await a.click('#pd-dock [data-pd-act="confirm-cancel"]');
      await a.waitForTimeout(200);
      check('P15 opening another design with unsaved changes asks first; Cancel keeps the editor as it was', asked && (await S(a)).projectId === p2 && (await S(a)).state === 'dirty' && (await docName(a)) === 'Away kit', { asked, s: await S(a) });
      await a.click(`#pd-dock [data-pd-act="open-project"][data-pd-id="${p1.id}"]`);
      await a.waitForTimeout(200);
      await a.click('#pd-dock [data-pd-act="confirm-go"]');
      await a.waitForFunction((id) => window.__familistaProductDesignMetrics().server.projectId === id, p1.id, { timeout: 15000 });
      check('P15 "Replace it" opens the chosen design at its newest version', (await S(a)).revision === 5 && (await docName(a)) === 'Browser draft kit', await S(a));
      await openTab(a, 'projects');
      await a.click(`#pd-dock [data-pd-act="archive"][data-pd-id="${p2}"]`);
      await a.waitForTimeout(800);
      await a.click('#pd-dock [data-pd-filter="archived"]');
      await a.waitForFunction(() => window.__familistaProductDesignMetrics().server.list === 'ready');
      await a.waitForTimeout(200);
      const archivedNames = await a.$$eval('#pd-dock .pd-dock-list .pd-dock-name', (els) => els.map((e) => e.textContent.trim()));
      await a.click(`#pd-dock [data-pd-act="unarchive"][data-pd-id="${p2}"]`);
      await a.waitForTimeout(800);
      const p2row = await db.designProject.findUnique({ where: { id: p2 } });
      check('P15 Archive moves a design to Archived, keeping its versions; Return to list brings it back', JSON.stringify(archivedNames) === JSON.stringify(['Away kit']) && p2row.archivedAt === null, { archivedNames });

      // g. the server unreachable: nothing is lost, the screen says why; it saves once the server answers again
      await edit(a);
      await a.route(/\/api\/v1\/system\/product-design\//, (r) => r.abort());
      const preOffline = await rows();
      await save(a);
      const offline = (await stateText(a)) + ' / ' + (await a.evaluate(() => document.querySelector('#pd-root .pd-local').textContent));
      const local = JSON.parse(await draft(a));
      check('P15 with the server unreachable, Save says the draft is kept in this browser, writes nothing, and the draft holds the change',
        (await S(a)).state === 'error' && /^Not saved \/ Not saved: the Familista server could not be reached/.test(offline) && JSON.stringify(await rows()) === JSON.stringify(preOffline) && local.name === 'Browser draft kit', offline);
      await a.unroute(/\/api\/v1\/system\/product-design\//);
      await save(a);
      check('P15 and once it answers again, Save saves it as version 6', (await S(a)).revision === 6 && (await S(a)).state === 'saved', await S(a));

      // h. a reload: the editor knows which saved design it holds, and that nothing is unsaved
      await a.reload({ waitUntil: 'load' });
      await a.waitForFunction(() => window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics());
      await a.waitForTimeout(1200);
      check('P15 after a reload the editor still holds version 6, saved, with no conflict', (await S(a)).revision === 6 && (await S(a)).state === 'saved' && !(await S(a)).conflict, await S(a));
      await ca.close();

      // i. Arabic: the panel follows the room right to left, in Arabic
      {
        const { ctx: cr, page: r } = await open({ width: 1672, height: 941 }, 'ar');
        await openTab(r, 'projects');
        const ar = await r.evaluate(() => ({ dir: getComputedStyle(document.getElementById('pd-dock')).direction, title: document.getElementById('pd-dock-title').textContent.trim(), tabs: [...document.querySelectorAll('#pd-dock [role="tab"]')].map((t) => t.textContent.trim()) }));
        check('P15 Arabic: the panel reads right to left, in Arabic', ar.dir === 'rtl' && ar.title === roomWord('ar', 'Saved designs') && JSON.stringify(ar.tabs) === JSON.stringify([roomWord('ar', 'Projects'), roomWord('ar', 'Versions')]), ar);
        await shot(r, 'ds1b-projects-ar');
        await cr.close();
      }

      // j. a club coach is refused by the server itself, whatever the browser does
      {
        const { ctx: cc, page: c } = await open({ width: 1280, height: 800 }, 'en-GB', { as: 'coach', wait: false });
        await c.waitForTimeout(1500);
        const pre = await rows();
        const r = await c.evaluate(async () => {
          const list = await fetch('/api/v1/system/product-design/projects', { credentials: 'include' });
          const make = await fetch('/api/v1/system/product-design/projects', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: {}, origin: 'EDITOR' }) });
          return [list.status, make.status];
        });
        check('P15 a club coach calling the design routes directly is refused (403) by the server, and nothing is written', r[0] === 403 && r[1] === 403 && JSON.stringify(await rows()) === JSON.stringify(pre), r);
        await cc.close();
      }

      // k. the audit: every change wrote exactly one record, and no record holds the document
      const end = await rows();
      const records = await db.platformAuditLog.findMany({ where: { action: { startsWith: 'design.' } } });
      const toggles = records.filter((x) => /archived$/.test(x.action)).length;
      check('P15 every revision and every archive change wrote exactly one PlatformAuditLog record, and no record holds a design',
        end.audit - start.audit === (end.revisions - start.revisions) + toggles && toggles === 2 && records.every((x) => x.category === 'ASSET' && !JSON.stringify(x.metadata).includes('Browser draft kit')),
        { start, end, toggles });
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
    } // ds1
    if (want('P16')) await proof3d();
  } catch (e) {
    fail('proof crashed', String(e && e.stack || e).slice(0, 1200));
  } finally {
    await browser.close();
    server.close();
    await dropDatabase();
    const n = (s) => results.filter((r) => r === s).length;
    console.log(`SUMMARY ${n('PASS')} passed, ${n('FAIL')} failed, 0 skipped`);
    process.exit(n('FAIL') ? 1 : 0);
  }
})();
