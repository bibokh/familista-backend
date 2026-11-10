#!/usr/bin/env node
// Familista — Neural Digital Twin: browser proofs.
//
// The twin claims things Jest cannot see: that what it draws is the graph and nothing else, that no two nodes and no
// two labels collide, that a selection lights exactly its own relationships, that Back returns to the same view, that
// it follows the platform's language and direction, that it fits a phone, and that only the platform owner ever loads
// it. This script proves each in a real Chromium with WebGL, against the REAL compiled application served by the REAL
// app (only the database is stubbed).
//
// It runs inside the required `browser-proof` jobs of .github/workflows/ci.yml, after the Specimen Lab proof, with the
// same pinned tools (tools/components/package.json: playwright-core, axe-core) and the runner's own Chrome.
//
//   npm run build
//   npm ci --ignore-scripts --prefix tools/components
//   CHROMIUM=$(command -v google-chrome) node tools/components/twin-browser-proof.cjs <output-dir> [--axe]
//
//   PROOF_ONLY        run only these sections: T1 (exploring, languages, sizes, owner only), T2 (layout, relationships,
//                     path, Back, intensity, the full graph), T3 (axe, with --axe), T4 (the Platform Owner navigation
//                     and System Updates; its axe pass with --axe), T5 (the official languages: the switch, keyboard,
//                     persistence, direction, rooms following, every width; its axe pass with --axe), T6 (back points back
//                     and the primary action can be read and reached: the arrow's drawn direction, the button contrast, the
//                     Tab order and the focus ring, desktop and phone, every official language; its axe pass with --axe),
//                     T7 (the Analytics, Medical and Performance player views: tabs, player cards and Back through the
//                     delegation under the CSP, by mouse, touch and keyboard, repeatedly, every official language),
//                     T8 (the twin's Phase 2: impact checked against the served graph with an independent search, the
//                     evidence chains, highlight and isolate, the status lens, the 3D view by keyboard, timings, every
//                     official language on desktop and phone; its axe pass with --axe).
//                     All by default.
//   CHROMIUM, PLAYWRIGHT_CORE, AXE_CORE   as for lab-browser-proof.cjs
//
// Every line is PASS, FAIL or SKIP; the last is `SUMMARY n passed, n failed, n skipped`, and the exit code is 1 if
// anything failed. Proofs that could pass whatever the room did are paired with a negative control: a fabricated line
// is caught by the same mapping, a path with no route is reported as none, a club session is refused where the owner
// is served, and axe is shown to report a nameless button inside the room.
'use strict';

process.env.NODE_ENV = 'production';
process.env.PORT = '47933';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(48);
process.env.DATABASE_URL = 'postgresql://stub:stub@stub/stub';

const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
// The official languages, from the client registry (public/i18n/config.js) — the proof keeps no list of its own.
const OFFICIAL = [...fs.readFileSync(path.join(ROOT, 'public/i18n/config.js'), 'utf8').matchAll(/\{ tag: '([^']+)',\s*label: '[^']+',\s*dir: '(ltr|rtl)', official: (\d+) \}/g)]
  .sort((a, b) => Number(a[3]) - Number(b[3])).map((m) => ({ tag: m[1], code: m[1].toLowerCase().split('-')[0], dir: m[2] }));
/** A room's word in a language, read from the room's own catalogue: what the page must show. */
const roomWord = (room, code, en) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', room, 'i18n', code + '.json'), 'utf8'))[en];
const OUT = process.argv[2];
const WANT_AXE = process.argv.includes('--axe');
const want = (n) => !process.env.PROOF_ONLY || process.env.PROOF_ONLY.split(',').includes(n);
if (!OUT) { console.error('usage: node tools/components/twin-browser-proof.cjs <output-dir> [--axe]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
// The browser's own copy of a CSP violation (counted from securitypolicyviolation below) and a failed network load are notices.
const NOTICE = /Failed to load resource|Refused to (apply|connect)|(Applying inline style|Connecting to '[^']*') violates the following Content Security Policy directive/;

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
const pass = (name, detail) => { results.push(['PASS', name]); console.log('PASS ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const fail = (name, detail) => { results.push(['FAIL', name]); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 800) : '')); };
const skip = (name, why) => { results.push(['SKIP', name]); console.log('SKIP ' + name + ' :: ' + why); };
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));
// The graph the server serves is the one the build wrote (scripts/neural-twin-build.js). The room must show all of it,
// whatever size the architecture has grown to, and it may never be smaller than the graph approved in Phase 1.
const BUILT = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/platform/neural-twin/generated/neural-graph.json'), 'utf8'));
const GN = BUILT.nodes.length, GE = BUILT.edges.length;
const PHASE1 = { nodes: 921, edges: 3656 };

(async () => {
  const mod = require(path.join(ROOT, 'dist/app'));
  const app = (mod.createApp || mod.default || mod.app)();
  const server = http.createServer(app);
  await new Promise((ok) => server.listen(47933, '127.0.0.1', ok));
  const BASE = 'http://127.0.0.1:47933';
  // WebGL in a headless Chrome with no GPU: the software renderer, as in a browser on a machine whose GPU is blocked.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const TOKENS = { owner: signToken('access', { sub: OWNER.id, role: OWNER.role }, { expiresIn: '60m' }), coach: signToken('access', { sub: COACH.id, role: COACH.role }, { expiresIn: '60m' }) };

  /** A fresh context as `as` (owner, coach or nobody), with the platform language `locale`, opened at the twin. */
  async function open(viewport, locale, opts) {
    opts = opts || {};
    const as = opts.as || 'owner';
    CURRENT = as === 'coach' ? COACH : OWNER;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr || 1, isMobile: !!opts.mobile, hasTouch: !!opts.mobile, reducedMotion: opts.reduce ? 'reduce' : 'no-preference' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    if (TOKENS[as]) await ctx.addCookies([{ name: 'access_token', value: TOKENS[as], domain: '127.0.0.1', path: '/', httpOnly: true }]);
    await ctx.addInitScript((l) => {
      try { if (l && !sessionStorage.getItem('__seeded')) { localStorage.setItem('familista.locale', l); sessionStorage.setItem('__seeded', '1'); } localStorage.setItem('familista_token', ''); } catch (_) { /* private mode */ }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ d: e.violatedDirective, uri: String(e.blockedURI).slice(0, 80), src: String(e.sourceFile || '').slice(-60) }));
    }, locale || null);
    const page = await ctx.newPage();
    const log = { errors: [], notices: [], requests: [] };
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') (NOTICE.test(m.text()) ? log.notices : log.errors).push(m.text().slice(0, 200)); });
    page.on('request', (r) => log.requests.push(new URL(r.url()).pathname));
    if (opts.before) await opts.before(ctx, page);
    await page.goto(BASE + (opts.hash || '/#neural-twin'), { waitUntil: 'load' });
    if (opts.wait !== false) {
      await page.waitForFunction(() => window.__familistaTwinMetrics && window.__familistaTwinMetrics().state === 'ready' && window.__familistaTwinMetrics().webgl, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
    }
    return { ctx, page, log };
  }
  const M = (pg) => pg.evaluate(() => window.__familistaTwinMetrics());
  const settle = async (pg) => { await pg.waitForFunction(() => !window.__familistaTwinMetrics().moving, null, { timeout: 20000 }); await pg.waitForTimeout(250); };
  const shot = (pg, name) => pg.screenshot({ path: path.join(OUT, 'twin-' + name + '.png') });
  const roomCsp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => /neural-twin|vendor\/babylon/.test(String(c.src) + String(c.uri))).length);
  /** Every pair of shown labels whose boxes overlap, read from the page itself. */
  const labelOverlaps = (pg) => pg.evaluate(() => {
    const r = [...document.querySelectorAll('#nt-labels .nt-label')].filter((e) => !e.hidden).map((e) => ({ id: e.getAttribute('data-nt-label') || e.getAttribute('data-nt-zone'), b: e.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i].b, b = r[j].b;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(r[i].id + ' x ' + r[j].id);
    }
    return { shown: r.length, bad };
  });
  /** The served graph, read with the page's own session, and every drawn line mapped back to the edges it stands for. */
  const integrity = (pg) => pg.evaluate(async () => {
    const g = (await (await fetch('/api/v1/system/neural-twin', { credentials: 'include' })).json()).data;
    const parent = {}; g.nodes.forEach((n) => { parent[n.id] = n.parent; });
    const isUnder = (anc, id) => { let c = id; while (c) { if (c === anc) return true; c = parent[c]; } return false; };
    const drawn = window.__familistaTwinDrawn(), m = window.__familistaTwinMetrics(), bad = [];
    for (const d of drawn) {
      const real = g.edges.filter((e) => e.kind === d.kind && isUnder(d.from, e.from) && isUnder(d.to, e.to) && !isUnder(d.from, e.to) && !isUnder(d.to, e.from));
      if (!real.length || real.length < d.n) bad.push(d);
    }
    // negative control: a fabricated line between two systems with no such edge is caught by the same mapping
    const fake = { from: 'system:frontend', to: 'system:testing', kind: 'DEPENDS_ON' };
    const caught = g.edges.filter((e) => e.kind === fake.kind && isUnder(fake.from, e.from) && isUnder(fake.to, e.to)).length === 0;
    return { drawn: drawn.length, lifted: m.lifted, badCount: bad.length, bad: bad.slice(0, 5), caught, cut: m.cut, nodes: g.nodes.length, edges: g.edges.length };
  });
  /** No two siblings' footprints overlap, and every child sits inside its parent's, as the room laid them out. */
  const layoutCheck = (pg) => pg.evaluate(async () => {
    const g = (await (await fetch('/api/v1/system/neural-twin', { credentials: 'include' })).json()).data;
    const parent = {}; g.nodes.forEach((n) => { parent[n.id] = n.parent || '(root)'; });
    const L = window.__familistaTwinLayout(), groups = {}, bad = [], outside = [];
    Object.keys(L.pos).forEach((id) => { (groups[parent[id]] = groups[parent[id]] || []).push(id); });
    Object.values(groups).forEach((ids) => { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = L.pos[ids[i]], b = L.pos[ids[j]];
      if (Math.hypot(a[0] - b[0], a[2] - b[2]) < L.bubble[ids[i]] + L.bubble[ids[j]] - 1e-6) bad.push(ids[i] + ' x ' + ids[j]);
    } });
    Object.keys(L.pos).forEach((id) => { const p = parent[id]; if (p !== '(root)' && L.pos[p] && Math.hypot(L.pos[id][0] - L.pos[p][0], L.pos[id][2] - L.pos[p][2]) + L.bubble[id] > L.bubble[p] + 1e-6) outside.push(id); });
    return { nodes: Object.keys(L.pos).length, badCount: bad.length, bad: bad.slice(0, 4), outside: outside.slice(0, 4) };
  });
  /** Frames drawn over `n` animation frames while the pointer moves over the canvas. */
  const drawWhileMoving = (pg, n) => pg.evaluate(async (n) => {
    const t0 = performance.now(), f0 = window.__familistaTwinMetrics().frames, cv = document.getElementById('nt-canvas'), r = cv.getBoundingClientRect();
    for (let i = 0; i < n; i++) { cv.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10 + i, clientY: r.top + 10, bubbles: true })); await new Promise((x) => requestAnimationFrame(x)); }
    const m = window.__familistaTwinMetrics();
    return { ms: Math.round(performance.now() - t0), frames: m.frames - f0, visible: m.visible, meshes: m.enabledMeshes, vertices: m.vertices, coarse: m.coarse, lifted: m.lifted, drawn: m.drawnEdges, cut: m.cut, drawCalls: m.drawCalls, layoutMs: m.layoutMs };
  }, n);

  // ══ T1. exploring the twin; its languages and sizes; the platform owner only ══════════════════════════════════════
  if (want('T1')) {
    {
      const { ctx, page, log } = await open({ width: 1920, height: 1080 }, 'en-GB');
      let m = await M(page);
      check('twin load: ready with WebGL, 20 systems shown, nothing selected', m.state === 'ready' && m.webgl && m.visible === 20 && !m.selected, { state: m.state, webgl: m.webgl, visible: m.visible });
      check('twin graph: the build-time graph, every node and edge of it, and no smaller than the Phase 1 graph of 921 and 3,656', m.nodes === GN && m.edges === GE && GN >= PHASE1.nodes && GE >= PHASE1.edges, { nodes: m.nodes, edges: m.edges, built: [GN, GE] });
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.documentElement.scrollHeight, document.documentElement.clientHeight]);
      check('twin layout: the workspace fills the screen without page scroll', sw[0] <= sw[1] && sw[2] <= sw[3] + 1, sw);

      await page.click('[data-nt-select="system:devices"]');
      await settle(page);
      m = await M(page);
      const insp = await page.textContent('#nt-inspector');
      check('twin explorer: selecting Devices & Edge selects it, and the inspector names it with its evidence', m.selected === 'system:devices' && /Devices & Edge/.test(insp) && /infrastructure-manifest\.json/.test(insp), { sel: m.selected });

      await page.fill('#nt-q', 'src/vision');
      await page.waitForTimeout(300);
      const hits = await page.$$eval('#nt-tree [data-nt-select]', (b) => b.map((x) => x.getAttribute('data-nt-select')));
      check('twin search: "src/vision" finds the module', hits.includes('module:vision'), hits.slice(0, 6));
      await page.click('#nt-tree [data-nt-select="module:vision"]');
      await page.fill('#nt-q', '');
      await settle(page);
      m = await M(page);
      check('twin explorer: selecting Vision reveals its system (Devices & Edge opened) and selects it', m.selected === 'module:vision' && m.expanded.includes('system:devices'), m.expanded);
      const visInsp = await page.textContent('#nt-inspector');
      check('twin inspector: Vision shows its placement evidence (camera-ingest) and its connections', /camera-ingest/.test(visInsp) && /Imports|Imported by/.test(visInsp), visInsp.slice(0, 200));
      await page.click('#nt-inspector [data-nt-toggle="module:vision"]');
      await settle(page);
      m = await M(page);
      const files = await page.$$eval('#nt-tree [data-nt-select^="file:src/vision/"]', (b) => b.map((x) => x.getAttribute('data-nt-select')));
      check('twin enter: opening Vision reveals its 10 real files from the repository', m.expanded.includes('module:vision') && files.length === 10, files.length);
      await page.click('#nt-tree [data-nt-select="file:src/vision/vision-ingest.service.ts"]');
      await settle(page);
      const fileInsp = await page.textContent('#nt-inspector');
      m = await M(page);
      check('twin inspector: a Vision file shows its path, connections with file:line evidence, and its classification',
        m.selected === 'file:src/vision/vision-ingest.service.ts' && /src\/vision\/vision-ingest\.service\.ts:\d+/.test(fileInsp) && /Implemented|Partial/.test(fileInsp) && /Implements|Implemented by/.test(fileInsp), fileInsp.slice(0, 240));
      await shot(page, 'vision-file');

      // the scene itself: pick a node with the pointer, then double-click to enter
      const target = 'system:ai';
      await page.click('[data-nt-action="reset"]');
      await settle(page);
      const pt = await page.evaluate((id) => window.__familistaTwinScreenOf(id), target);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(700);
      m = await M(page);
      check('twin pointer: clicking a system in the 3D scene selects it', m.selected === target, { pt, sel: m.selected });
      const pt2 = await page.evaluate((id) => window.__familistaTwinScreenOf(id), target);
      await page.mouse.dblclick(pt2.x, pt2.y);
      await settle(page);
      m = await M(page);
      check('twin pointer: double-clicking enters it (opens it and the camera moves in)', m.expanded.includes(target) && m.visible > 20, { expanded: m.expanded, visible: m.visible });

      const before = await page.evaluate(() => window.__familistaTwinScreenOf('system:database'));
      await page.mouse.move(960, 600); await page.mouse.down(); await page.mouse.move(1160, 640, { steps: 8 }); await page.mouse.up();
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => window.__familistaTwinScreenOf('system:database'));
      check('twin camera: dragging rotates the scene', Math.abs(after.x - before.x) + Math.abs(after.y - before.y) > 20, { before, after });
      await page.mouse.move(960, 600); await page.mouse.wheel(0, -600); await page.waitForTimeout(700);
      const zoomed = await page.evaluate(() => window.__familistaTwinScreenOf('system:database'));
      check('twin camera: the wheel zooms', Math.abs(zoomed.x - after.x) + Math.abs(zoomed.y - after.y) > 10, { after, zoomed });

      await page.click('[data-nt-action="expand-all"]');
      await settle(page);
      const allOpen = await M(page);
      await page.click('[data-nt-edge="IMPORTS"]');
      await settle(page);
      const noImports = await M(page);
      check('twin filters: turning Imports off removes those relationships from the scene', !noImports.edgeKinds.includes('IMPORTS') && noImports.lifted < allOpen.lifted, { before: allOpen.lifted, after: noImports.lifted });
      await page.click('[data-nt-edge="IMPORTS"]');
      await page.click('[data-nt-kind="module"]');
      await settle(page);
      const noModules = await M(page);
      check('twin filters: hiding Code modules hides them (and what is inside them)', !noModules.kinds.includes('module') && noModules.visible < allOpen.visible, { before: allOpen.visible, after: noModules.visible });
      await page.click('[data-nt-kind="module"]');
      await page.selectOption('#nt-system', 'system:security');
      await settle(page);
      const onlySec = await M(page);
      check('twin filters: choosing one system shows only that system', onlySec.system === 'system:security' && onlySec.visible > 1 && onlySec.visible < allOpen.visible, { visible: onlySec.visible });
      await page.selectOption('#nt-system', '');
      await page.click('[data-nt-action="collapse-all"]');
      await settle(page);
      m = await M(page);
      check('twin: Close all returns to the twenty systems', m.visible === 20, m.visible);

      await page.click('[data-nt-select="system:database"]');
      await settle(page);
      await page.focus('#nt-canvas');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      m = await M(page);
      check('twin keyboard: Escape clears the selection', !m.selected, m.selected);
      await page.focus('#nt-q');
      let reached = false;
      for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!(document.activeElement && document.activeElement.matches('#nt-tree [data-nt-select]'))); }
      check('twin keyboard: Tab reaches the outline', reached);
      await page.keyboard.press('Enter');
      await settle(page);
      m = await M(page);
      check('twin keyboard: Enter on an outline row selects it', !!m.selected, m.selected);

      await page.click('[data-nt-action="expand-all"]');
      await settle(page);
      const perf = await drawWhileMoving(page, 30);
      check('twin performance: every system open, the scene keeps drawing (frames per 30 animation frames)', perf.frames >= 20, perf);
      await page.waitForTimeout(2200);
      const idle0 = (await M(page)).frames; await page.waitForTimeout(1500); const idle1 = (await M(page)).frames;
      check('twin performance: an idle scene stops drawing', idle1 - idle0 <= 2, { idleFrames: idle1 - idle0 });
      check('twin: no page error and no CSP violation from the room through every step', log.errors.length === 0 && (await roomCsp(page)) === 0, { errors: log.errors.slice(0, 3) });

      await page.evaluate(() => window.navTo('owner-home', null));
      await page.waitForTimeout(1200);
      const left = await page.evaluate(() => ({ canvas: !!document.getElementById('nt-canvas'), cls: document.body.classList.contains('nt-twin-open'), m: window.__familistaTwinMetrics() }));
      check('twin leave: no canvas, the shell returns, the engine is released', !left.canvas && !left.cls && left.m.meshes === 0 && left.m.state === 'idle', { canvas: left.canvas, cls: left.cls, meshes: left.m.meshes, state: left.m.state });
      await page.evaluate(() => window.navTo('neural-twin', null));
      await page.waitForFunction(() => window.__familistaTwinMetrics().state === 'ready' && window.__familistaTwinMetrics().webgl, null, { timeout: 30000 });
      m = await M(page);
      check('twin return: coming back draws the room again', m.state === 'ready' && m.webgl && m.visible === 20, { state: m.state, visible: m.visible });
      await ctx.close();
    }

    // Every official language but English: the room follows the platform's, in the registry's direction, in its own words.
    for (const [loc, code, dir] of OFFICIAL.filter((l) => l.code !== 'en').map((l) => [l.tag, l.code, l.dir])) {
      const { ctx, page, log } = await open({ width: 1920, height: 1080 }, loc);
      const m = await M(page);
      const info = await page.evaluate(() => ({ dir: document.getElementById('nt-root').getAttribute('dir'), title: document.querySelector('.nt-title').textContent, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      const wantL = { dir, title: roomWord('neural-twin', code, 'Neural Digital Twin') };
      check('twin ' + loc + ': the room follows the platform language (' + wantL.dir + ') and is translated', m.lang === code && info.dir === wantL.dir && info.title === wantL.title && wantL.title !== 'Neural Digital Twin' && info.sw <= info.cw, info);
      await page.fill('#nt-q', 'src/vision');
      await page.click('#nt-tree [data-nt-select="module:vision"]');
      await page.fill('#nt-q', '');
      await settle(page);
      const names = await page.$$eval('.nt-insp-t bdi', (b) => b.map((x) => x.textContent));
      check('twin ' + loc + ': names stay as the repository writes them (src/vision is not translated)', names.includes('src/vision'), names);
      check('twin ' + loc + ': no page error, no room CSP violation', log.errors.length === 0 && (await roomCsp(page)) === 0, log.errors.slice(0, 2));
      if (loc === 'ar') {
        await page.click('[data-nt-lang="en"]');
        await page.waitForFunction(() => window.__familistaTwinMetrics().lang === 'en', null, { timeout: 10000 });
        await page.waitForTimeout(600);
        const after = await M(page);
        const d2 = await page.evaluate(() => document.getElementById('nt-root').getAttribute('dir'));
        check('twin language switch: changes the platform language and keeps the scene and the selection', d2 === 'ltr' && after.selected === 'module:vision' && after.webgl, { dir: d2, sel: after.selected });
      }
      await ctx.close();
    }

    for (const [w, hgt, loc] of [[768, 1024, 'en-GB'], [390, 844, 'en-GB'], [390, 844, 'ar']]) {
      const { ctx, page, log } = await open({ width: w, height: hgt }, loc, { mobile: w < 700, dpr: w < 700 ? 2 : 1 });
      const geo = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, stage: document.querySelector('.nt-stage').getBoundingClientRect().height, insp: document.querySelector('.nt-inspector').getBoundingClientRect().top }));
      check('twin ' + w + 'x' + hgt + ' ' + loc + ': no sideways scroll; the scene, then the inspector, stack and the page scrolls', geo.sw <= geo.cw && geo.stage >= 280 && geo.insp >= geo.stage, geo);
      const lo = await labelOverlaps(page);
      check('twin ' + w + 'x' + hgt + ' ' + loc + ': no page error, no room CSP violation, no two labels overlapping', log.errors.length === 0 && (await roomCsp(page)) === 0 && lo.bad.length === 0, { errors: log.errors.slice(0, 2), bad: lo.bad.slice(0, 2) });
      await ctx.close();
    }

    // A deep link under real latency. Startup lands on Owner Home over the route and the deep-link repair navigates
    // back; that navigation abandons startup's reads still in flight (/me/context, /teams). A cancellation is not a
    // timeout: no "Connection timeout" banner, the backend not marked down. The control holds one read past the
    // client's 20 s timeout and requires the banner, so a client that stopped warning altogether would fail here.
    {
      const banner = (pg) => pg.evaluate(() => { const b = document.getElementById('backend-banner'); return b && b.classList.contains('show') ? (b.querySelector('.msg') || b).textContent : null; });
      const slow = (ms, only) => async (ctx) => ctx.route(only || /\/api\/v1\/(?!system\/neural-twin|health)/, async (r) => { await new Promise((x) => setTimeout(x, ms)); try { await r.continue(); } catch (_) { /* the page went away */ } });
      const lag = await open({ width: 1440, height: 900 }, 'en-GB', { before: slow(400) });
      await lag.page.waitForTimeout(5000);
      const st = await lag.page.evaluate(() => ({ healthy: window.State && window.State.backendHealthy, twin: window.__familistaTwinMetrics().state }));
      const b1 = await banner(lag.page);
      check('twin deep link at 400 ms API latency: the startup re-route raises no false "Connection timeout", and the backend stays healthy', b1 === null && st.healthy === true && st.twin === 'ready' && lag.log.errors.length === 0, { banner: b1, state: st, errors: lag.log.errors.slice(0, 2) });
      await lag.ctx.close();
      const hung = await open({ width: 1440, height: 900 }, 'en-GB', { before: slow(26000, /\/api\/v1\/teams\b/) });
      await hung.page.waitForFunction(() => { const b = document.getElementById('backend-banner'); return !!(b && b.classList.contains('show')); }, null, { timeout: 30000 }).catch(() => {});
      const b2 = await banner(hung.page);
      check('twin deep link (control): a read the server does not answer within the 20 s timeout still raises the timeout banner', /Connection timeout/.test(b2 || ''), { banner: b2 });
      await hung.ctx.close();
    }

    // the platform owner only: a club session is refused by the server and never loads the room's code
    {
      const owner = await open({ width: 1280, height: 800 }, 'en-GB');
      const st = await owner.page.evaluate(async () => (await fetch('/api/v1/system/neural-twin', { credentials: 'include' })).status);
      check('twin owner only (control): the platform owner is answered 200 for the graph and the room loads its code', st === 200 && owner.log.requests.some((p) => p === '/neural-twin/neural-twin.js'), { status: st });
      await owner.ctx.close();
      const coach = await open({ width: 1280, height: 800 }, 'en-GB', { as: 'coach', wait: false });
      await coach.page.waitForTimeout(4000);
      const cs = await coach.page.evaluate(async () => (await fetch('/api/v1/system/neural-twin', { credentials: 'include' })).status);
      const loaded = coach.log.requests.filter((p) => /\/neural-twin\/|\/vendor\/babylon/.test(p));
      const drawn = await coach.page.evaluate(() => !!document.getElementById('nt-canvas'));
      check('twin owner only: a club coach is answered 403 for the graph, and never fetches the room, its layout or Babylon', cs === 403 && loaded.length === 0 && !drawn, { status: cs, loaded, drawn });
      await coach.ctx.close();
      const nobody = await open({ width: 1280, height: 800 }, 'en-GB', { as: 'nobody', wait: false });
      await nobody.page.waitForTimeout(2500);
      const ns = await nobody.page.evaluate(async () => (await fetch('/api/v1/system/neural-twin', { credentials: 'include' })).status);
      check('twin owner only: without a session the graph is answered 401', ns === 401, { status: ns });
      await nobody.ctx.close();
    }
  }

  // ══ T2. layout, relationships, path, Back, intensity, motion and the full graph ═══════════════════════════════════
  if (want('T2')) {
    const { ctx, page, log } = await open({ width: 1920, height: 1080 }, 'en-GB');
    let m = await M(page);
    check('twin overview: 20 systems in 6 zones (5 compass zones and the unplaced one, kept apart)', m.visible === 20 && m.zones.length === 6 && m.zones.includes('unplaced'), m.zones);
    let lo = await labelOverlaps(page);
    check('twin overview: no two shown labels overlap', lo.bad.length === 0 && lo.shown >= 15, lo);
    let ig = await integrity(page);
    check('twin overview: every drawn line maps back to real graph edges (and a fabricated one is caught)', ig.badCount === 0 && ig.drawn === m.lifted && ig.caught, ig);
    let lc = await layoutCheck(page);
    check('twin overview: no two nodes collide, and each sits inside its parent', lc.badCount === 0 && lc.outside.length === 0 && lc.nodes === 20, lc);
    await shot(page, 'overview');

    await page.click('[data-nt-select="system:devices"]');
    await settle(page);
    await page.click('#nt-inspector [data-nt-toggle="system:devices"]');
    await settle(page);
    m = await M(page);
    // the room records the move it scheduled: read that, not a sample of a 460 ms animation on a software renderer
    check('twin expand: opening a system unfolds its six children out of it in a timed move, then rests', m.lastMove.unfold === 6 && m.lastMove.ms === 460 && m.moving === false && m.expanded.includes('system:devices') && m.platforms >= 1, { lastMove: m.lastMove, platforms: m.platforms });

    await page.click('#nt-tree [data-nt-select="module:vision"]');
    await settle(page);
    m = await M(page);
    const drawnSel = await page.evaluate(() => window.__familistaTwinDrawn().filter((d) => d.from === 'module:vision' || d.to === 'module:vision'));
    check('twin selection: every incoming and outgoing relationship of the selection is drawn and highlighted, each with an arrowhead',
      m.highlighted.out + m.highlighted.inc === drawnSel.length && m.arrows === drawnSel.length && m.highlighted.out > 0 && m.highlighted.inc > 0, { hi: m.highlighted, drawn: drawnSel.length, arrows: m.arrows });
    const labelState = await page.evaluate(() => {
      const ls = [...document.querySelectorAll('#nt-labels .nt-label[data-nt-label]')];
      return { sel: ls.filter((e) => e.classList.contains('is-sel')).map((e) => e.getAttribute('data-nt-label')), near: ls.filter((e) => e.classList.contains('is-near')).length, dim: ls.filter((e) => e.classList.contains('is-dim')).length };
    });
    check('twin selection: the node is marked, its neighbours lit, everything else dimmed', labelState.sel.join() === 'module:vision' && labelState.near > 0 && labelState.dim > 0 && m.near > 0, { labelState, near: m.near });
    const insp = await page.textContent('#nt-inspector');
    check('twin selection: the inspector states the drawn counts', insp.includes(m.highlighted.inc + ' incoming and ' + m.highlighted.out + ' outgoing'), insp.slice(0, 160));
    lo = await labelOverlaps(page);
    check('twin selection: no two shown labels overlap', lo.bad.length === 0, lo);
    await shot(page, 'vision-selected');

    const camBefore = (await M(page)).camera, histBefore = m.history;
    await page.click('#nt-inspector [data-nt-toggle="module:vision"]');
    await settle(page);
    m = await M(page);
    check('twin enter: Vision opens on its own platform, its 10 files shown', m.expanded.includes('module:vision') && m.visible >= 36 && m.history === histBefore + 1, { visible: m.visible, history: m.history });
    ig = await integrity(page);
    check('twin Vision expanded: every drawn line maps back to real graph edges', ig.badCount === 0, ig);
    lo = await labelOverlaps(page);
    check('twin Vision expanded: no two shown labels overlap', lo.bad.length === 0, lo);
    await shot(page, 'vision-expanded');
    await page.click('[data-nt-action="history-back"]');
    await settle(page);
    m = await M(page);
    const camAfter = m.camera, dCam = Math.abs(camAfter.r - camBefore.r) + Math.abs(camAfter.a - camBefore.a) + Math.abs(camAfter.b - camBefore.b) + camAfter.t.reduce((s, v, i) => s + Math.abs(v - camBefore.t[i]), 0);
    check('twin Back: returns to the previous level, selection and camera exactly where they were', !m.expanded.includes('module:vision') && m.selected === 'module:vision' && dCam < 1e-3, { dCam, sel: m.selected });
    await page.focus('#nt-canvas');
    const h0 = m.history;
    await page.keyboard.press('Backspace');
    await settle(page);
    m = await M(page);
    check('twin Back: Backspace on the scene goes back one more step', m.history === h0 - 1, { before: h0, after: m.history });

    await page.click('#nt-tree [data-nt-select="module:vision"]');
    await settle(page);
    await page.click('#nt-tree [data-nt-select="system:database"]', { modifiers: ['Shift'] });
    await settle(page);
    m = await M(page);
    const pathOk = await page.evaluate(() => {
      const m = window.__familistaTwinMetrics(), d = window.__familistaTwinDrawn();
      if (!m.path) return { ok: false };
      const ns = m.path.nodes, steps = [];
      for (let i = 1; i < ns.length; i++) steps.push(d.some((e) => e.from === ns[i - 1] && e.to === ns[i]));
      return { ok: steps.every(Boolean), nodes: ns, reversed: m.path.reversed };
    });
    const pathInsp = await page.textContent('#nt-inspector');
    check('twin path: Shift-click traces a directed path, every step a drawn relationship, listed in the inspector', pathOk.ok && m.pathTo === 'system:database' && /Path \((\d+ steps|1 step)\)/.test(pathInsp) && pathOk.nodes[0] === 'module:vision', pathOk);
    await page.click('#nt-tree [data-nt-select="system:ai"]', { modifiers: ['Shift'] });
    await settle(page);
    const planned = await page.evaluate(() => [...document.querySelectorAll('#nt-tree [data-nt-select^="planned:"]')].map((b) => b.getAttribute('data-nt-select'))[0]);
    await page.click('#nt-tree [data-nt-select="module:vision"]');
    await settle(page);
    if (planned) await page.click('#nt-tree [data-nt-select="' + planned + '"]', { modifiers: ['Shift'] });
    await settle(page);
    m = await M(page);
    const none = await page.textContent('#nt-inspector');
    check('twin path (control): with no recorded route, the room says so and draws none', !!planned && m.path === null && m.pathTo === planned && /No directed path/.test(none), { planned, path: m.path });
    await page.keyboard.press('Escape');
    await settle(page);

    await page.click('#nt-tree [data-nt-select="module:vision"]');
    await settle(page);
    m = await M(page);
    const hiN = m.highlighted.out + m.highlighted.inc;
    await page.click('[data-nt-action="focus-only"]');
    await page.waitForTimeout(400);
    let m2 = await M(page);
    check('twin Selection only: just the selection\'s own relationships stay drawn', m2.focusOnly && m2.drawnEdges === hiN, { drawn: m2.drawnEdges, hiN });
    await page.click('[data-nt-action="focus-only"]');
    await page.$eval('#nt-intensity', (el) => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(400);
    m2 = await M(page);
    check('twin Connections at 0: the rest fade out; the selection\'s own stay', m2.intensity === 0 && m2.drawnEdges === hiN, { drawn: m2.drawnEdges });
    await page.$eval('#nt-intensity', (el) => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(400);
    m2 = await M(page);
    check('twin Connections at full: every lifted relationship is drawn again', m2.drawnEdges === m2.lifted - m2.cut && m2.intensity > 1.6, { drawn: m2.drawnEdges, lifted: m2.lifted });
    await page.$eval('#nt-intensity', (el) => { el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.keyboard.press('Escape');

    await page.click('[data-nt-action="expand-all"]');
    await settle(page);
    for (let round = 0; round < 6; round++) {
      const ids = await page.$$eval('#nt-tree [data-nt-toggle][aria-expanded="false"]', (b) => b.map((x) => x.getAttribute('data-nt-toggle')));
      if (!ids.length) break;
      await page.evaluate((list) => { list.forEach((id) => { const b = document.querySelector('#nt-tree [data-nt-toggle="' + id + '"]'); if (b) b.click(); }); }, ids);
      await settle(page);
    }
    m = await M(page);
    check('twin full graph: every node of the graph on screen', m.visible === GN, { visible: m.visible, built: GN });
    await page.click('[data-nt-action="reset"]');
    await settle(page);
    ig = await integrity(page);
    check('twin full graph: every drawn line maps back to real graph edges', ig.badCount === 0, ig);
    lc = await layoutCheck(page);
    check('twin full graph: no two nodes of the graph collide, and each sits inside its parent', lc.badCount === 0 && lc.outside.length === 0 && lc.nodes === GN, lc);
    lo = await labelOverlaps(page);
    check('twin full graph: no two shown labels overlap', lo.bad.length === 0, { shown: lo.shown, bad: lo.bad.slice(0, 4) });
    const perf = await drawWhileMoving(page, 60);
    check('twin full graph: the scene keeps drawing while the camera moves (60 animation frames)', perf.frames >= 40, perf);
    await page.waitForTimeout(2200);
    const i0 = (await M(page)).frames; await page.waitForTimeout(1500); const i1 = (await M(page)).frames;
    check('twin full graph: an idle scene stops drawing', i1 - i0 <= 2, { idle: i1 - i0 });
    await shot(page, 'full-graph');
    check('twin T2: no page error and no room CSP violation through every step', log.errors.length === 0 && (await roomCsp(page)) === 0, log.errors.slice(0, 3));
    await ctx.close();

    {
      const r = await open({ width: 1440, height: 900 }, 'en-GB', { reduce: true });
      await r.page.click('[data-nt-select="system:ai"]');
      const mm = await M(r.page);
      check('twin reduced motion: selecting moves the camera and the layout at once, with no animation', mm.moving === false && mm.expanded.length === 0, { moving: mm.moving });
      await r.page.click('#nt-inspector [data-nt-toggle="system:ai"]');
      const m3 = await M(r.page);
      check('twin reduced motion: opening a system places its children at once (no move scheduled)', m3.moving === false && m3.lastMove.nodes === 0 && m3.expanded.includes('system:ai'), { moving: m3.moving, lastMove: m3.lastMove });
      await r.ctx.close();
    }

    for (const [loc, zone] of [['de-DE', 'Zone Nord'], ['ar', 'المنطقة الشمالية']]) {
      const r = await open({ width: 1920, height: 1080 }, loc);
      const zones = await r.page.$$eval('#nt-labels [data-nt-zone]', (z) => z.map((x) => x.textContent));
      const back = await r.page.$eval('[data-nt-action="history-back"]', (b) => b.textContent.trim());
      const l2 = await labelOverlaps(r.page);
      check('twin ' + loc + ': zone names, Back and the connection controls are translated; labels do not overlap', zones.includes(zone) && !/^← Back$/.test(back) && l2.bad.length === 0, { zones, back, bad: l2.bad.slice(0, 2) });
      await r.page.fill('#nt-q', 'src/vision');
      await r.page.click('#nt-tree [data-nt-select="module:vision"]');
      await r.page.fill('#nt-q', '');
      await settle(r.page);
      await shot(r.page, 'vision-selected-' + loc);
      check('twin ' + loc + ': no page error, no room CSP violation', r.log.errors.length === 0 && (await roomCsp(r.page)) === 0, r.log.errors.slice(0, 2));
      await r.ctx.close();
    }
  }

  // ══ T3. accessibility: axe on the twin, English and Arabic, with a control (--axe) ═════════════════════════════════
  if (want('T3') && WANT_AXE) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (!fs.existsSync(axePath)) skip('twin accessibility: axe in en and ar', 'axe-core is not installed (' + axePath + ')');
    else {
      const src = fs.readFileSync(axePath, 'utf8');
      const runAxe = (pg) => pg.evaluate(async (src) => {
        if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
        const r = await window.axe.run({ include: ['#pg-neural-twin'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
      }, src);
      for (const loc of ['en-GB', 'ar']) {
        const { ctx, page, log } = await open({ width: 1440, height: 900 }, loc);
        const v0 = await runAxe(page);
        await page.fill('#nt-q', 'src/vision');
        await page.click('#nt-tree [data-nt-select="module:vision"]');
        await page.fill('#nt-q', '');
        await settle(page);
        const v1 = await runAxe(page);
        check('twin accessibility ' + loc + ': 0 axe violations (WCAG 2.2 A/AA) in the overview and with a selection open, no console error', v0.length === 0 && v1.length === 0 && log.errors.length === 0, { overview: v0, selected: v1, errors: log.errors.slice(0, 2) });
        if (loc === 'en-GB') {
          await page.evaluate(() => { const b = document.createElement('button'); b.className = 'nt-tool'; document.querySelector('.nt-tools').appendChild(b); });
          const broken = (await runAxe(page)).map((v) => v.id);
          check('twin accessibility (control): a button with no name inside the room is reported by the same axe run', broken.includes('button-name'), broken);
        }
        await ctx.close();
      }
    }
  }

  // ══ T4. the Platform Owner navigation, and System Updates beside the twin ═══════════════════════════════════════════
  // Two permanent destinations outside every Club Workspace, drawn from one list (public/app.js, OWNER_NAV) in Owner
  // Control's top bar (the phone header beneath 769px) and at the head of both rooms, each marking the open room.
  // System Updates shows only what the server read; this proves the room against the release record the build wrote.
  if (want('T4')) {
    const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/platform/system-updates/generated/release-record.json'), 'utf8'));
    const U = (pg) => pg.evaluate(() => (window.__familistaUpdatesMetrics ? window.__familistaUpdatesMetrics() : null));
    const roomReady = (pg) => pg.waitForFunction(() => window.__familistaUpdatesMetrics && window.__familistaUpdatesMetrics().state === 'ready', null, { timeout: 30000 });
    const twinReady = (pg) => pg.waitForFunction(() => window.__familistaTwinMetrics && window.__familistaTwinMetrics().state === 'ready', null, { timeout: 60000 });
    const navState = (pg, sel) => pg.evaluate((sel) => {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
      const nav = document.querySelector(sel);
      return { shown: vis(nav), names: nav ? [...nav.querySelectorAll('[data-owner-nav]')].map((b) => b.textContent.trim()) : [],
        current: nav ? [...nav.querySelectorAll('[aria-current="page"]')].map((b) => b.getAttribute('data-owner-nav')) : [],
        label: nav ? nav.getAttribute('aria-label') : null, sizes: nav ? [...nav.querySelectorAll('[data-owner-nav]')].filter(vis).map((b) => [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]) : [] };
    }, sel);
    const overflowX = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const box = (pg, sel) => pg.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }, sel);
    const ownerHome = (pg) => pg.waitForFunction(() => { const n = document.getElementById('owner-nav'); return n && !n.hidden && n.querySelectorAll('[data-owner-nav]').length === 2; }, null, { timeout: 30000 });

    // A. Owner Control's top bar, the room, the round trip through both rooms, and back
    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en-GB', { hash: '/#owner-home', wait: false });
      await ownerHome(page);
      await page.waitForTimeout(600);
      let n = await navState(page, '#owner-nav');
      const fits = await page.evaluate(() => { const h = document.querySelector('header.topbar'), nv = document.getElementById('owner-nav'), a = h.getBoundingClientRect(), b = nv.getBoundingClientRect(); return { inside: b.top >= a.top && b.bottom <= a.bottom && b.right <= a.right, headerOverflow: h.scrollWidth - h.clientWidth }; });
      check('owner nav: Owner Control\'s top bar holds the two destinations, named, none current, inside the bar', n.shown && n.names.join('|') === 'Neural Digital Twin|System Updates' && n.current.length === 0 && n.label === 'Platform owner' && fits.inside && fits.headerOverflow <= 0, { n, fits });
      // revealing it moves nothing: the page's name and the page beneath keep their place with the group hidden or shown
      const place = () => Promise.all([box(page, '.topbar-brand'), box(page, '#pages-container'), box(page, 'header.topbar')]);
      const shownAt = await place();
      await page.evaluate(() => { document.getElementById('owner-nav').hidden = true; });
      const hiddenAt = await place();
      await page.evaluate(() => { document.getElementById('owner-nav').hidden = false; });
      check('owner nav: revealing it moves nothing — the page\'s name, the top bar and the page below keep their place', JSON.stringify(shownAt) === JSON.stringify(hiddenAt), { shownAt, hiddenAt });
      await shot(page, 'owner-nav-topbar');

      await page.click('#owner-nav [data-owner-nav="system-updates"]');
      await roomReady(page);
      await page.waitForTimeout(300);
      n = await navState(page, '.su-ownernav');
      const shell = await page.evaluate(() => ({ active: (document.querySelector('.page.active') || {}).id, open: document.body.classList.contains('su-room-open'), topbar: getComputedStyle(document.querySelector('header.topbar')).display, hash: location.hash }));
      check('owner nav: System Updates opens its room, which takes the screen and marks itself the open destination', shell.active === 'pg-system-updates' && shell.open && shell.topbar === 'none' && shell.hash === '#system-updates' && n.shown && n.current.join() === 'system-updates', { shell, n });
      const u = await U(page);
      const facts = await page.$$eval('.su-ev', (e) => e.map((x) => x.textContent.trim()));
      const want = RECORD.deployPath.state === 'RECORDED' ? RECORD.deployPath.facts.map((f) => f.evidence.path + ':' + f.evidence.line) : [];
      const offs = await page.$$eval('.su-badge--off', (e) => e.map((x) => x.textContent.trim()));
      check('system updates: what it shows is the build record\'s — every deployment fact with its line, every recorded commit — and CI, the host and pull requests say not connected',
        u.record === 'PRESENT' && u.facts === want.length && want.length > 0 && JSON.stringify(facts) === JSON.stringify(want) && u.changes === (RECORD.history.items || []).length && u.ci === 'NOT_CONNECTED' && u.provider === 'NOT_CONNECTED' && offs.filter((t) => t === 'Not connected').length === 3,
        { u, facts, want, offs });
      const running = await page.$$eval('.su-panel--running .su-fact', (e) => e.map((x) => [x.querySelector('.su-fact-k').textContent.trim(), x.querySelector('.su-fact-v').textContent.trim()]));
      check('system updates: unknown is said, never invented — off Render the deployed commit and the branch read "Unknown", the built commit is the record\'s',
        running[0][1] === 'Unknown' && running[1][1] === 'Unknown' && running[2][1] === RECORD.commit.slice(0, 7), running);
      const before = await Promise.all([box(page, '.su-top'), box(page, '.su-panel--running'), box(page, '.su-panel--approvals')]);
      await page.click('[data-su-action="reload"]');
      await page.waitForFunction(() => document.getElementById('su-grid').getAttribute('aria-busy') === 'false' && window.__familistaUpdatesMetrics().state === 'ready', null, { timeout: 20000 });
      const after = await Promise.all([box(page, '.su-top'), box(page, '.su-panel--running'), box(page, '.su-panel--approvals')]);
      check('system updates: Refresh reads again and repaints the body only — nothing moves', JSON.stringify(before) === JSON.stringify(after), { before, after });
      await shot(page, 'system-updates');

      await page.focus('.su-ownernav [data-owner-nav="neural-twin"]');
      await page.keyboard.press('Enter');
      await twinReady(page);
      n = await navState(page, '.nt-ownernav');
      const twin = await page.evaluate(() => ({ active: (document.querySelector('.page.active') || {}).id, updatesOpen: document.body.classList.contains('su-room-open') }));
      check('owner nav: from System Updates to the twin by keyboard, and the twin marks itself the open destination', twin.active === 'pg-neural-twin' && !twin.updatesOpen && n.shown && n.current.join() === 'neural-twin' && n.names.join('|') === 'Neural Digital Twin|System Updates', { twin, n });
      await page.click('.nt-ownernav [data-owner-nav="system-updates"]');
      await roomReady(page);
      n = await navState(page, '.su-ownernav');
      check('owner nav: and back, from the twin\'s own head', (await page.evaluate(() => (document.querySelector('.page.active') || {}).id)) === 'pg-system-updates' && n.current.join() === 'system-updates', n);
      await page.click('[data-su-action="back"]');
      await ownerHome(page);
      await page.waitForTimeout(300);
      n = await navState(page, '#owner-nav');
      check('owner nav: "Owner Control" leads home, the room is let go, and the top bar\'s copy marks nothing current', (await page.evaluate(() => (document.querySelector('.page.active') || {}).id + '|' + document.body.classList.contains('su-room-open') + '|' + document.getElementById('su-root').innerHTML.length)) === 'pg-owner-home|false|0' && n.shown && n.current.length === 0, n);
      // never inside a Club Workspace: the shell's own area switch hides it, and the home area shows it again (the control)
      await page.evaluate(() => window._setArea('club'));
      const inClub = (await navState(page, '#owner-nav')).shown;
      await page.evaluate(() => window._setArea('home'));
      const atHome = (await navState(page, '#owner-nav')).shown;
      check('owner nav: never inside a Club Workspace (and shown again on Owner Control, the control)', !inClub && atHome, { inClub, atHome });
      check('owner nav: the round trip raised no console error', log.errors.length === 0, log.errors.slice(0, 3));
      const status = await page.evaluate(async () => (await fetch('/api/v1/system/updates', { credentials: 'include' })).status);
      check('system updates owner only (control): the owner is answered 200', status === 200, status);
      await ctx.close();
    }

    // B. a club account, and no session at all
    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en-GB', { as: 'coach', hash: '/#system-updates', wait: false });
      await page.waitForTimeout(4000);
      const st = await page.evaluate(async () => ({
        nav: [...document.querySelectorAll('.owner-nav')].map((n) => [n.hidden, n.querySelectorAll('[data-owner-nav]').length]),
        room: (document.getElementById('su-root') || { innerHTML: '' }).innerHTML.length, open: document.body.classList.contains('su-room-open'),
        api: (await fetch('/api/v1/system/updates', { credentials: 'include' })).status,
      }));
      const loaded = log.requests.filter((r) => /^\/system-updates\//.test(r));
      check('owner nav: a club account is shown no owner navigation, and #system-updates loads none of the room', st.nav.every(([h, c]) => h && c === 0) && st.room === 0 && !st.open && loaded.length === 0, { st, loaded });
      check('system updates owner only: a club coach is answered 403', st.api === 403, st.api);
      await ctx.close();
      const anon = await new Promise((ok) => http.get(BASE + '/api/v1/system/updates', (r) => { r.resume(); ok(r.statusCode); }).on('error', () => ok(0)));
      check('without a session /system/updates is answered 401', anon === 401, anon);
    }

    // C. in every official language but English: the top bar's words come from the platform catalogue, the room's from its
    // own; Arabic is right to left. German and Arabic are spelled out here; French and Spanish are read from their files.
    const SPELLED = { 'de-DE': { twin: 'Neuronaler Digitaler Zwilling', updates: 'Systemaktualisierungen', label: 'Plattformeigentümer', dir: 'ltr', head: 'Läuft jetzt' },
      ar: { twin: 'التوأم الرقمي العصبي', updates: 'تحديثات النظام', label: 'مالك المنصة', dir: 'rtl', head: 'قيد التشغيل الآن' } };
    const fromFiles = (l) => ({ twin: roomWord('system-updates', l.code, 'Neural Digital Twin'), updates: roomWord('system-updates', l.code, 'System Updates'),
      label: roomWord('system-updates', l.code, 'Platform owner'), dir: l.dir, head: roomWord('system-updates', l.code, 'Running now') });
    for (const [loc, want] of OFFICIAL.filter((l) => l.code !== 'en').map((l) => [l.tag, SPELLED[l.tag] || fromFiles(l)])) {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, loc, { hash: '/#owner-home', wait: false });
      await ownerHome(page);
      await page.waitForFunction((w) => [...document.querySelectorAll('#owner-nav [data-owner-nav]')].map((b) => b.textContent.trim()).join('|') === w, want.twin + '|' + want.updates, { timeout: 15000 }).catch(() => {});
      const top = await navState(page, '#owner-nav');
      await page.click('#owner-nav [data-owner-nav="system-updates"]');
      await roomReady(page);
      await page.waitForTimeout(400);
      const room = await page.evaluate(() => {
        const r = document.getElementById('su-root');
        return { dir: r.getAttribute('dir'), lang: r.getAttribute('lang'), title: r.querySelector('.su-title').textContent.trim(), head: r.querySelector('.su-panel--running .su-h').textContent.trim(),
          nav: [...r.querySelectorAll('.su-ownernav [data-owner-nav]')].map((b) => b.textContent.trim()), navLabel: r.querySelector('.su-ownernav').getAttribute('aria-label') };
      });
      // no English left: no sentence of the room's English catalogue (three words or more) appears in its text
      const english = await page.evaluate(async () => {
        const en = await (await fetch('/system-updates/i18n/en.json')).json();
        // the room's own words only: commit messages, hashes and paths are data, kept as written (bdi, code)
        const r = document.getElementById('su-root').cloneNode(true); r.querySelectorAll('bdi, code').forEach((e) => e.remove());
        const text = r.textContent;
        return Object.keys(en).filter((k) => k.split(' ').length >= 3 && !/%d/.test(k) && text.includes(k));
      });
      check('owner nav and system updates in ' + loc + ': the top bar, the room and its navigation speak the language' + (loc === 'ar' ? ', right to left' : '') + ', with no English sentence left',
        top.names.join('|') === want.twin + '|' + want.updates && top.label === want.label && room.dir === want.dir && room.title === want.updates && room.head === want.head
          && room.nav.join('|') === want.twin + '|' + want.updates && room.navLabel === want.label && english.length === 0 && log.errors.length === 0,
        { top: top.names, label: top.label, room, english: english.slice(0, 4), errors: log.errors.slice(0, 2) });
      if (loc === 'ar') {
        await shot(page, 'system-updates-ar');
        // the control: the same detector, on the English room, finds the English it looks for
        await page.click('[data-su-lang="en"]');
        await page.waitForFunction(() => document.getElementById('su-root').getAttribute('lang') === 'en', null, { timeout: 10000 });
        await page.waitForTimeout(300);
        const found = await page.evaluate(async () => { const en = await (await fetch('/system-updates/i18n/en.json')).json(); const r = document.getElementById('su-root').cloneNode(true); r.querySelectorAll('bdi, code').forEach((e) => e.remove()); const t = r.textContent; return Object.keys(en).filter((k) => k.split(' ').length >= 3 && !/%d/.test(k) && t.includes(k)).length; });
        check('system updates language (control): the same detector finds the English sentences in the English room', found >= 10, found);
      }
      await ctx.close();
    }

    // D. sizes: a tablet (icons, named), a phone (the phone header holds it; the page's name is not squeezed), the room on a phone
    {
      const { ctx, page } = await open({ width: 1024, height: 768 }, 'en-GB', { hash: '/#owner-home', wait: false });
      await ownerHome(page);
      await page.waitForTimeout(400);
      const n = await navState(page, '#owner-nav');
      const named = await page.$$eval('#owner-nav [data-owner-nav]', (b) => b.map((x) => { const l = x.querySelector('.owner-nav-label'); return [l.textContent.trim(), getComputedStyle(l).position, x.getAttribute('title')]; }));
      check('owner nav on a tablet: icons that keep their names (as text for assistive technology, and as a tooltip), at least 24px, nothing overflows',
        n.shown && n.sizes.every(([w, h]) => w >= 24 && h >= 24) && named.every(([t, pos, title]) => t && pos === 'absolute' && title === t) && (await overflowX(page)) <= 0, { n, named });
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, 'en-GB', { hash: '/#owner-home', wait: false, mobile: true });
      await page.waitForFunction(() => { const n = document.getElementById('owner-nav-compact'); return n && !n.hidden && n.querySelectorAll('[data-owner-nav]').length === 2; }, null, { timeout: 30000 });
      await page.waitForTimeout(500);
      const c = await navState(page, '#owner-nav-compact'), t = await navState(page, '#owner-nav');
      // The page's name keeps exactly the room it has without the navigation: its box is measured with the phone copy
      // shown and hidden. (Whether the name fits at all depends on the font the browser has; that is not this change's.)
      const title = await page.evaluate(() => {
        const e = document.getElementById('page-title'), n = document.getElementById('owner-nav-compact'), m = document.getElementById('mobile-header');
        const read = () => ({ w: Math.round(e.getBoundingClientRect().width * 10) / 10, clipped: e.scrollWidth > e.clientWidth + 1 });
        const withNav = read(); n.hidden = true; const without = read(); n.hidden = false;
        return { text: e.textContent.trim(), withNav, without, headerOverflow: m.scrollWidth - m.clientWidth };
      });
      check('owner nav on a phone: the phone header holds it, at least 24px a target, the top bar\'s copy steps aside, and the page\'s name keeps the room it has without it',
        c.shown && !t.shown && c.sizes.length === 2 && c.sizes.every(([w, h]) => w >= 24 && h >= 24)
          && title.withNav.w === title.without.w && title.withNav.clipped === title.without.clipped && title.headerOverflow <= 0 && (await overflowX(page)) <= 0, { c, t, title });
      await shot(page, 'owner-nav-phone');
      await page.click('#owner-nav-compact [data-owner-nav="system-updates"]');
      await roomReady(page);
      await page.waitForTimeout(400);
      const cols = await page.$$eval('.su-panel', (p) => [...new Set(p.map((x) => Math.round(x.getBoundingClientRect().left)))].length);
      check('system updates on a phone: one column, no sideways scroll, the page scrolls as a page', cols === 1 && (await overflowX(page)) <= 0 && (await page.evaluate(() => getComputedStyle(document.body).overflow)) !== 'hidden', { cols });
      await shot(page, 'system-updates-phone');
      await ctx.close();
    }

    // E. accessibility: axe on the room (English and Arabic) and on Owner Control's top bar, with a control (--axe)
    if (WANT_AXE) {
      const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
      if (!fs.existsSync(axePath)) skip('system updates accessibility: axe in en and ar', 'axe-core is not installed (' + axePath + ')');
      else {
        const src = fs.readFileSync(axePath, 'utf8');
        const runAxe = (pg, scope) => pg.evaluate(async ([src, scope]) => {
          if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
          const r = await window.axe.run({ include: [scope] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
        }, [src, scope]);
        for (const loc of ['en-GB', 'ar']) {
          const { ctx, page, log } = await open({ width: 1440, height: 900 }, loc, { hash: '/#owner-home', wait: false });
          await ownerHome(page);
          await page.waitForTimeout(500);
          const vTop = await runAxe(page, '#owner-nav');
          await page.click('#owner-nav [data-owner-nav="system-updates"]');
          await roomReady(page);
          await page.waitForTimeout(400);
          const vRoom = await runAxe(page, '#pg-system-updates');
          check('system updates accessibility ' + loc + ': 0 axe violations (WCAG 2.2 A/AA) in the room and in the top bar\'s owner navigation, no console error', vTop.length === 0 && vRoom.length === 0 && log.errors.length === 0, { top: vTop, room: vRoom, errors: log.errors.slice(0, 2) });
          if (loc === 'en-GB') {
            await page.evaluate(() => { const b = document.createElement('button'); b.className = 'su-btn'; document.querySelector('.su-top-r').appendChild(b); });
            const broken = (await runAxe(page, '#pg-system-updates')).map((v) => v.id);
            check('system updates accessibility (control): a button with no name inside the room is reported by the same axe run', broken.includes('button-name'), broken);
          }
          await ctx.close();
        }
      }
    }
  }

  // ══ T5. the official languages: the top bar's switch, in every one of them ═════════════════════════════════════════
  // One button per official language, in the registry's order, each named in its own language; pressed with the mouse,
  // Enter or Space; the page changes language in place (no reload: a marker set on the window survives), keeps it across
  // navigation and a reload, turns right to left for Arabic and back, and the rooms follow it — including when a room's own
  // button is the one pressed. At every width from a desktop to a phone the five buttons fit, inside the top bar, with no
  // sideways scroll. Screenshots of Owner Control, the twin and System Updates are taken in French and Spanish.
  if (want('T5')) {
    const CAT = (tag) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/catalogue', tag + '.json'), 'utf8'));
    const LABEL = Object.fromEntries([...fs.readFileSync(path.join(ROOT, 'public/i18n/config.js'), 'utf8').matchAll(/\{ tag: '([^']+)',\s*label: '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const ownerHome = (pg) => pg.waitForFunction(() => { const g = document.getElementById('lang-switch'); return g && !g.hidden && g.querySelectorAll('[data-locale]').length > 0; }, null, { timeout: 30000 });
    const sw = (pg) => pg.evaluate(() => {
      const g = document.getElementById('lang-switch');
      const b = [...g.querySelectorAll('[data-locale]')];
      const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
      return { shown: vis(g), codes: b.map((x) => x.textContent.trim()), tags: b.map((x) => x.getAttribute('data-locale')), langs: b.map((x) => x.getAttribute('lang')),
        names: b.map((x) => x.getAttribute('aria-label')), pressed: b.filter((x) => x.getAttribute('aria-pressed') === 'true').map((x) => x.getAttribute('data-locale')),
        html: { lang: document.documentElement.getAttribute('lang'), dir: document.documentElement.getAttribute('dir') }, stored: localStorage.getItem('familista.locale'),
        marker: window.__t5marker === 1, focus: document.activeElement && document.activeElement.getAttribute('data-locale') };
    });
    const ownerNames = (pg) => pg.evaluate(() => [...document.querySelectorAll('#owner-nav [data-owner-nav]')].map((b) => b.textContent.trim()).join('|'));
    const inForce = (pg, tag) => pg.waitForFunction((t) => document.documentElement.getAttribute('lang') === t, tag, { timeout: 15000 }).then(() => true, () => false);
    const OFF = OFFICIAL.map((l) => l.tag);
    const fr = OFFICIAL.find((l) => l.code === 'fr'), es = OFFICIAL.find((l) => l.code === 'es'), ar = OFFICIAL.find((l) => l.code === 'ar');

    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en-GB', { hash: '/#owner-home', wait: false });
      await ownerHome(page);
      await page.evaluate(() => { window.__t5marker = 1; });
      let st = await sw(page);
      check('languages: the top bar offers one button per official language, in the registry\'s order, each named in its own language',
        st.shown && st.tags.join() === OFF.join() && st.codes.join() === OFFICIAL.map((l) => l.code.toUpperCase()).join()
          && st.langs.join() === OFFICIAL.map((l) => l.code).join() && st.names.join('|') === OFFICIAL.map((l) => l.code.toUpperCase() + ' · ' + LABEL[l.tag]).join('|')
          && st.pressed.join() === 'en-GB', st);

      // the keyboard: Tab reaches the button, Enter presses it, the focus stays where the reader is
      await page.focus('#lang-switch [data-locale="' + fr.tag + '"]');
      await page.keyboard.press('Enter');
      const frOn = await inForce(page, fr.tag);
      await page.waitForTimeout(500);
      st = await sw(page);
      const frWords = CAT(fr.tag);
      const names = await ownerNames(page);
      check('languages: Enter on FR puts French in force in place — no reload, left to right, the choice remembered, the focus kept, the top bar in French',
        frOn && st.marker && st.html.dir === 'ltr' && st.pressed.join() === fr.tag && st.stored === fr.tag && st.focus === fr.tag
          && names === frWords['Neural Digital Twin'] + '|' + frWords['System Updates'] && log.errors.length === 0, { st, names });
      await shot(page, 'languages-owner-control-fr');

      // across navigation, and across a reload
      await page.evaluate(() => window.navTo('clubs', null));
      await page.waitForTimeout(800);
      await page.evaluate(() => window.navTo('owner-home', null));
      await ownerHome(page);
      st = await sw(page);
      check('languages: French stays in force through Clubs and back to Owner Control, without a reload', st.marker && st.html.lang === fr.tag && st.pressed.join() === fr.tag, st);
      await page.reload({ waitUntil: 'load' });
      await ownerHome(page);
      const reloaded = await inForce(page, fr.tag);
      st = await sw(page);
      check('languages: and after a reload the page opens in French, its button pressed', reloaded && st.html.lang === fr.tag && st.pressed.join() === fr.tag, st);

      // Arabic turns the page right to left; Space on ES turns it back
      await page.click('#lang-switch [data-locale="' + ar.tag + '"]');
      const arOn = await inForce(page, ar.tag);
      st = await sw(page);
      const arOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check('languages: AR turns the page right to left, the switch still in the registry\'s order, nothing sideways', arOn && st.html.dir === 'rtl' && st.tags.join() === OFF.join() && arOverflow <= 0, { st, arOverflow });
      await page.focus('#lang-switch [data-locale="' + es.tag + '"]');
      await page.keyboard.press('Space');
      const esOn = await inForce(page, es.tag);
      await page.waitForTimeout(500);
      st = await sw(page);
      const esWords = CAT(es.tag);
      check('languages: Space on ES puts Spanish in force, left to right again, the top bar in Spanish',
        esOn && st.html.dir === 'ltr' && st.pressed.join() === es.tag && (await ownerNames(page)) === esWords['Neural Digital Twin'] + '|' + esWords['System Updates'], st);
      await shot(page, 'languages-owner-control-es');

      // the rooms follow the platform, and a room's own button moves the platform
      await page.click('#owner-nav [data-owner-nav="system-updates"]');
      await page.waitForFunction(() => window.__familistaUpdatesMetrics && window.__familistaUpdatesMetrics().state === 'ready', null, { timeout: 30000 });
      await page.waitForTimeout(400);
      let room = await page.evaluate(() => { const r = document.getElementById('su-root'); return { lang: r.getAttribute('lang'), dir: r.getAttribute('dir'), title: r.querySelector('.su-title').textContent.trim() }; });
      check('languages: System Updates opens in the platform\'s Spanish', room.lang === 'es' && room.dir === 'ltr' && room.title === roomWord('system-updates', 'es', 'System Updates'), room);
      await shot(page, 'languages-system-updates-es');
      await page.click('[data-su-lang="fr"]');
      const moved = await inForce(page, fr.tag);
      await page.waitForTimeout(400);
      room = await page.evaluate(() => { const r = document.getElementById('su-root'); return { lang: r.getAttribute('lang'), title: r.querySelector('.su-title').textContent.trim(), stored: localStorage.getItem('familista.locale') }; });
      check('languages: the room\'s own FR moves the platform to French, and the room follows', moved && room.lang === 'fr' && room.stored === fr.tag && room.title === roomWord('system-updates', 'fr', 'System Updates'), room);
      await shot(page, 'languages-system-updates-fr');
      await page.evaluate(() => window.navTo('owner-home', null));
      await ownerHome(page);
      st = await sw(page);
      check('languages: back on Owner Control the top bar says French is in force', st.pressed.join() === fr.tag && st.html.lang === fr.tag, st);
      check('languages: no page error through every change', log.errors.length === 0, log.errors.slice(0, 3));
      await ctx.close();
    }

    // every official language in turn, through the switch: direction, pressed state, the stored choice and the top bar's
    // words follow each press; then each one survives a reload on its own
    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en-GB', { hash: '/#owner-home', wait: false });
      await ownerHome(page);
      await page.evaluate(() => { window.__t5marker = 1; });
      const seen = [];
      for (const l of [...OFFICIAL.slice(1), OFFICIAL[0]]) {
        await page.click('#lang-switch [data-locale="' + l.tag + '"]');
        const on = await inForce(page, l.tag);
        await page.waitForTimeout(400);
        const st = await sw(page);
        const words = CAT(l.tag);
        const want = l.code === 'en' ? 'Neural Digital Twin|System Updates' : words['Neural Digital Twin'] + '|' + words['System Updates'];
        const names = await ownerNames(page);
        seen.push({ tag: l.tag, ok: on && st.marker && st.html.dir === l.dir && st.pressed.join() === l.tag && st.stored === l.tag && names === want, dir: st.html.dir, names });
      }
      check('languages: each official language in turn through the switch — in force in place, its direction, its button pressed, remembered, the top bar in its words',
        seen.length === OFFICIAL.length && seen.every((x) => x.ok) && log.errors.length === 0, seen);
      for (const l of OFFICIAL) {
        await page.evaluate((t) => window.I18N_APPLY.change(t), l.tag);
        await inForce(page, l.tag);
        await page.reload({ waitUntil: 'load' });
        await ownerHome(page);
        const back = await inForce(page, l.tag);
        const st = await sw(page);
        check('languages: ' + l.tag + ' survives a reload — the page opens in it, ' + l.dir + ', its button pressed', back && st.html.dir === l.dir && st.pressed.join() === l.tag, { html: st.html, pressed: st.pressed });
      }
      await ctx.close();
    }

    // the twin, in French and Spanish
    for (const l of [fr, es]) {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, l.tag);
      const m = await M(page);
      const title = await page.evaluate(() => document.querySelector('.nt-title').textContent.trim());
      check('languages: the Neural Digital Twin opens in ' + l.tag, m.lang === l.code && title === roomWord('neural-twin', l.code, 'Neural Digital Twin') && log.errors.length === 0, { lang: m.lang, title });
      await shot(page, 'languages-neural-twin-' + l.code);
      await ctx.close();
    }

    // every width: the five buttons fit, inside the top bar, large enough to press, with no sideways scroll
    for (const [w, h, mobile] of [[1440, 900, false], [1280, 800, false], [1024, 768, false], [768, 1024, true], [390, 844, true]]) {
      for (const l of [fr, ar]) {
        const { ctx, page, log } = await open({ width: w, height: h }, l.tag, { hash: '/#owner-home', wait: false, mobile, dpr: mobile ? 2 : 1 });
        await ownerHome(page);
        await page.waitForTimeout(500);
        const measure = () => page.evaluate(() => {
          const g = document.getElementById('lang-switch'), bar = document.querySelector('header.topbar');
          const gb = g.getBoundingClientRect(), hb = bar.getBoundingClientRect();
          const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.5; };
          const all = [...g.querySelectorAll('[data-locale]')];
          const btns = all.filter(vis).map((b) => b.getBoundingClientRect());
          const t = g.querySelector('.lang-switch-toggle');
          const title = document.querySelector('.topbar-brand') || document.querySelector('header.topbar h1');
          return { n: btns.length, inView: btns.every((r) => r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight && r.width >= 24 && r.height >= 24),
            inBar: gb.top >= hb.top - 0.5 && gb.bottom <= hb.bottom + 0.5, overlap: btns.some((r, i) => btns.some((q, j) => j > i && r.left < q.right - 0.5 && q.left < r.right - 0.5 && r.top < q.bottom - 0.5 && q.top < r.bottom - 0.5)),
            pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, barX: bar.scrollWidth - bar.clientWidth,
            toggle: t && vis(t) ? { text: t.textContent, expanded: t.getAttribute('aria-expanded') } : null,
            menu: (() => { const m = g.querySelector('.lang-switch-menu'); if (!m) return null; const cs = getComputedStyle(m); return { open: g.classList.contains('is-open'), opacity: cs.opacity, visibility: cs.visibility, position: cs.position }; })(),
            focus: document.activeElement && (document.activeElement.getAttribute('data-locale') || document.activeElement.className),
            boxes: JSON.stringify([bar, title, document.getElementById('pages-container')].map((e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })) };
        });
        const fit = await measure();
        if (w > 560) {
          check('languages ' + w + '×' + h + ' ' + l.tag + ': five buttons in view, at least 24px, none overlapping, inside the top bar, no sideways scroll',
            fit.n === OFFICIAL.length && !fit.toggle && fit.inView && fit.inBar && !fit.overlap && fit.pageX <= 0 && fit.barX <= 0 && log.errors.length === 0, fit);
        } else {
          // the phone: one button, showing the language in force, which opens the five as a floating row
          const titleRoom = await page.evaluate(() => { const e = document.querySelector('.topbar-brand'); const g = document.getElementById('lang-switch'); const a = e ? e.getBoundingClientRect().width : 0; g.hidden = true; const b = e ? e.getBoundingClientRect().width : 0; g.hidden = false; return { shown: Math.round(a), hidden: Math.round(b) }; });
          check('languages ' + w + '×' + h + ' ' + l.tag + ': on a phone one button stands for the row, showing the language in force, and leaves the page\'s name its room',
            fit.n === 0 && fit.toggle && fit.toggle.text === l.code.toUpperCase() && fit.toggle.expanded === 'false' && fit.inBar && fit.pageX <= 0 && fit.barX <= 0 && titleRoom.shown >= titleRoom.hidden - 64, { fit, titleRoom });
          await shot(page, 'languages-phone-' + l.code);
          const menuIs = (shown) => page.waitForFunction((want) => { const m = document.querySelector('#lang-switch .lang-switch-menu'); const cs = m && getComputedStyle(m); return !!cs && (want ? cs.visibility === 'visible' && Number(cs.opacity) === 1 : cs.visibility === 'hidden'); }, shown, { timeout: 3000 }).then(() => true, () => false);
          await page.focus('#lang-switch .lang-switch-toggle');
          await page.keyboard.press('Enter');
          await menuIs(true);
          const open = await measure();
          check('languages ' + w + '×' + h + ' ' + l.tag + ': Enter opens the five in a floating row, in view, at least 24px, none overlapping, the focus on the language in force — and nothing beneath moves',
            open.n === OFFICIAL.length && open.inView && !open.overlap && open.toggle.expanded === 'true' && open.focus === l.tag && open.boxes === fit.boxes && open.pageX <= 0, { open, before: fit.boxes });
          await shot(page, 'languages-phone-open-' + l.code);
          await page.keyboard.press('Escape');
          const closed = await menuIs(false);
          const shut = await measure();
          check('languages ' + w + '×' + h + ' ' + l.tag + ': Escape closes it and gives the focus back to its button', closed && shut.n === 0 && shut.toggle.expanded === 'false' && /lang-switch-toggle/.test(shut.focus || ''), shut);
          if (l === fr) {
            await page.click('#lang-switch .lang-switch-toggle');
            await menuIs(true);
            await page.click('#lang-switch [data-locale="' + es.tag + '"]');
            const esPhone = await inForce(page, es.tag);
            await menuIs(false);
            const after = await measure();
            check('languages ' + w + '×' + h + ': choosing ES in the floating row puts Spanish in force and closes the row', esPhone && after.n === 0 && after.toggle && after.toggle.text === 'ES' && after.toggle.expanded === 'false', after);
          }
        }
        await ctx.close();
      }
    }

    // accessibility: axe on the switch in French and Arabic, with a control
    if (WANT_AXE) {
      const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
      if (!fs.existsSync(axePath)) skip('languages accessibility: axe on the switch', 'axe-core is not installed (' + axePath + ')');
      else {
        const src = fs.readFileSync(axePath, 'utf8');
        const runAxe = (pg) => pg.evaluate(async (src) => {
          if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
          const r = await window.axe.run({ include: ['#lang-switch'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
        }, src);
        for (const l of [fr, ar]) {
          const { ctx, page } = await open({ width: 1440, height: 900 }, l.tag, { hash: '/#owner-home', wait: false });
          await ownerHome(page);
          await page.waitForTimeout(400);
          const v = await runAxe(page);
          check('languages accessibility ' + l.tag + ': 0 axe violations (WCAG 2.2 A/AA) on the switch', v.length === 0, v);
          if (l === fr) {
            await page.evaluate(() => { const b = document.querySelector('#lang-switch [data-locale]'); b.textContent = ''; b.removeAttribute('aria-label'); b.removeAttribute('title'); });
            const broken = (await runAxe(page)).map((x) => x.id);
            check('languages accessibility (control): a switch button stripped of its name is reported by the same run', broken.includes('button-name'), broken);
          }
          await ctx.close();
        }
      }
    }
  }

  // T6 — back points back, and the primary action can be read and reached, in every official language, on a desktop and a
  // phone. The arrow is measured as drawn (its glyph's direction times the horizontal scale of everything between it and the
  // control), the contrast from the computed colours, the ring from the computed outline while the keyboard has the focus.
  if (want('T6')) {
    const WIDTHS = [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone', mobile: true }];
    const pointing = (pg, sel) => pg.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0);
      if (!el) return null;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, ch = null;
      while ((n = w.nextNode())) { const m = n.data.match(/[←‹«→›»]/); if (m) { ch = m[0]; break; } }
      // an arrow drawn as an icon (the top bar's back button) is drawn pointing left
      const icon = ch ? null : el.querySelector('svg.fam-dir-ic');
      if (!ch && !icon) return { text: el.textContent.trim(), points: 'none' };
      let sx = icon || /[←‹«]/.test(ch) ? -1 : 1;
      for (let e = icon || n.parentElement; e && e !== el.parentElement; e = e.parentElement) {
        const t = getComputedStyle(e).transform;
        if (t && t !== 'none' && parseFloat(t.slice(t.indexOf('(') + 1)) < 0) sx = -sx;
      }
      return { text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60), points: sx < 0 ? 'left' : 'right' };
    }, sel);
    // The WCAG contrast of an element's label against each colour its background is painted with.
    const contrastOf = (pg, sel) => pg.evaluate((sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rgb = (s) => (s.match(/rgba?\(([^)]+)\)/g) || []).map((x) => x.replace(/rgba?\(|\)/g, '').split(',').map(Number)).filter((a) => a.length < 4 || a[3] > 0);
      const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
      const fg = rgb(cs.color)[0];
      const bgs = cs.backgroundImage && cs.backgroundImage !== 'none' ? rgb(cs.backgroundImage) : rgb(cs.backgroundColor);
      return { fg: cs.color, bg: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor, min: Math.min(...bgs.map((b) => ratio(fg, b))) };
    }, sel);
    const focusInfo = (pg) => pg.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const cs = getComputedStyle(a);
      return { id: a.id || null, cls: a.className || null, auth: a.getAttribute('data-show-auth'), visible: a.matches(':focus-visible'),
        outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor };
    });
    // Every transition on an element (the focused one when `sel` is null) has run: what is read is what stays on screen.
    const settled = (pg, sel) => pg.waitForFunction((sel) => {
      const e = sel ? document.querySelector(sel) : document.activeElement;
      return !!e && e.getAnimations().every((a) => a.playState !== 'running' && a.playState !== 'pending');
    }, sel, { timeout: 5000, polling: 50 }).then(() => pg.waitForTimeout(50), () => {});
    const ringOk = (f) => !!f && f.visible && /^solid (2|3)px rgb\(22, 163, 74\)$/.test(f.outline);
    const tabTo = async (pg, match, max) => {
      const seen = [];
      for (let i = 0; i < (max || 14); i++) {
        await pg.keyboard.press('Tab');
        const f = await focusInfo(pg);
        seen.push(f ? (f.id || f.auth || String(f.cls).split(' ')[0]) : 'body');
        // The button eases its outline in (transition: all .15s): measured once the element's own transitions have finished.
        if (f && match(f)) { await settled(pg, null); return { f: await focusInfo(pg), seen }; }
      }
      return { f: null, seen };
    };
    const view = (pg) => pg.evaluate(() => { const v = document.querySelector('[data-auth-view].auth-active'); return v ? v.dataset.authView : null; });
    const overflow = (pg) => pg.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    const signedOut = (vp, tag, before) => open(vp, tag, { as: 'nobody', hash: '/', wait: false, mobile: vp.mobile, before })
      .then(async (o) => { await o.page.waitForSelector('#login-btn', { timeout: 30000 }); await o.page.waitForFunction((t) => document.documentElement.lang === t, tag, { timeout: 15000 }); await o.page.waitForTimeout(400); return o; });
    const asOwner = (vp, tag, hash, sel, before) => open(vp, tag, { hash, wait: false, mobile: vp.mobile, before })
      .then(async (o) => { await o.page.waitForSelector(sel, { timeout: 30000 }); await o.page.waitForFunction((t) => document.documentElement.lang === t, tag, { timeout: 15000 }); await o.page.waitForTimeout(500); return o; });

    for (const l of OFFICIAL) {
      const back = l.dir === 'rtl' ? 'right' : 'left';
      for (const vp of WIDTHS) {
        const at = l.tag + ' ' + vp.name;
        // the sign-in screen, as a visitor
        {
          const { ctx, page, log } = await signedOut(vp, l.tag);
          await settled(page, '#login-btn');
          const c = await contrastOf(page, '#login-btn');
          check('back & contrast ' + at + ': the sign-in button\'s label reaches 4.5:1 (' + (c && c.min) + ':1)', !!c && c.min >= 4.5, c);
          let ok = true; const detail = {};
          if (vp.name === 'desktop') {
            await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
            const toBtn = await tabTo(page, (f) => f.id === 'login-btn');
            const toForgot = await tabTo(page, (f) => f.auth === 'forgot', 4);
            detail.order = toBtn.seen.concat(toForgot.seen); detail.ring = toBtn.f && toBtn.f.outline;
            ok = ringOk(toBtn.f) && ringOk(toForgot.f) && detail.order.indexOf('login-email') >= 0 && detail.order.indexOf('login-email') < detail.order.indexOf('login-password')
              && detail.order.indexOf('login-password') < detail.order.indexOf('login-btn');
            check('back & contrast ' + at + ': Tab reaches email, password, the button and "forgotten password" in that order, each with a 2px green ring', ok, detail);
            const hash0 = await page.evaluate(() => location.hash);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(400);
            const toBack = await tabTo(page, (f) => f.auth === 'login', 6);
            const arrow = await pointing(page, '[data-auth-view="forgot"] a.auth-link[data-show-auth="login"]');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(400);
            const after = { forgotOpened: true, back: arrow, ring: toBack.f && toBack.f.outline, view: await view(page), hash: await page.evaluate(() => location.hash) };
            check('back & contrast ' + at + ': Enter opens "forgotten password"; its back link points ' + back + ', has the ring, and Enter returns to sign-in without changing the address',
              !!arrow && arrow.points === back && ringOk(toBack.f) && after.view === 'login' && after.hash === hash0, after);
          } else {
            await page.click('[data-show-auth="forgot"]');
            await page.waitForTimeout(400);
            const arrow = await pointing(page, '[data-auth-view="forgot"] a.auth-link[data-show-auth="login"]');
            const over = await overflow(page);
            const btn = await page.evaluate(() => { const r = document.getElementById('fp-btn').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), innerWidth]; });
            check('back & contrast ' + at + ': the back link points ' + back + ', nothing scrolls sideways, the button fits the screen', !!arrow && arrow.points === back && over <= 0 && btn[0] >= 0 && btn[1] <= btn[2], { arrow, over, btn });
          }
          if (log.errors.length) fail('back & contrast ' + at + ': page errors on the sign-in screen', log.errors);
          await ctx.close();
        }
        // Owner Control → Clubs: the back button to Owner Home
        {
          const { ctx, page, log } = await asOwner(vp, l.tag, '/#clubs', '.cp-back');
          const arrow = await pointing(page, '.cp-back');
          const over = await overflow(page);
          const r = await page.evaluate(() => { const b = document.querySelector('.cp-back').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), innerWidth]; });
          // it sits where reading starts: the left half to a left-to-right reader, the right half to a right-to-left one
          const startSide = l.dir === 'rtl' ? (r[0] + r[1]) / 2 > r[2] / 2 : (r[0] + r[1]) / 2 < r[2] / 2;
          check('back & contrast ' + at + ': Clubs → "' + (arrow && arrow.text) + '" points ' + back + ', sits on the screen at the side reading starts', !!arrow && arrow.points === back && r[0] >= 0 && r[1] <= r[2] && over <= 0 && startSide, { arrow, r, over });
          // the club workspace pages' shared back button (Training, Academy), drawn by the application's own _famBackBtn()
          // on this page: the same markup and the same stylesheet, without a club's data
          await page.evaluate(() => { const h = document.createElement('div'); h.id = 't6-fam'; h.style.cssText = 'position:relative;height:56px'; h.innerHTML = window._famBackBtn(); document.querySelector('#main-content, main, .content, body').prepend(h); });
          const fam = await pointing(page, '#t6-fam .fam-back');
          const fr = await page.evaluate(() => { const b = document.querySelector('#t6-fam .fam-back').getBoundingClientRect(), h = document.getElementById('t6-fam').getBoundingClientRect(); return [Math.round(b.left - h.left), Math.round(h.right - b.right)]; });
          const famStart = l.dir === 'rtl' ? fr[1] < fr[0] : fr[0] < fr[1];
          check('back & contrast ' + at + ': the club pages\' back button (_famBackBtn) points ' + back + ' and sits at the side reading starts', !!fam && fam.points === back && famStart, { fam, gaps: fr });
          // the club top bar's back button, which the shell shows on club pages only (body.area-home hides it): shown here, in
          // place, to be measured, then hidden again
          const area = await page.evaluate(() => { const had = document.body.classList.contains('area-home'); document.body.classList.remove('area-home'); document.getElementById('topbar-back').style.display = 'inline-flex'; return had; });
          const top = await pointing(page, '#topbar-back');
          await page.evaluate((had) => { if (had) document.body.classList.add('area-home'); document.getElementById('topbar-back').style.display = 'none'; }, area);
          check('back & contrast ' + at + ': the club top bar\'s back button points ' + back, !!top && top.points === back, top);
          if (vp.name === 'desktop') {
            // the primary button wherever the platform draws one: measured at rest and under the pointer
            await page.evaluate(() => { const b = document.createElement('button'); b.className = 'btn btn-primary'; b.id = 't6-primary'; b.textContent = 'Save'; b.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999'; document.body.appendChild(b); });
            const rest = await contrastOf(page, '#t6-primary');
            await page.hover('#t6-primary');
            await page.waitForTimeout(300);
            const hover = await contrastOf(page, '#t6-primary');
            check('back & contrast ' + at + ': .btn-primary\'s label reaches 4.5:1 on every colour of its fill, at rest and under the pointer (' + (rest && rest.min) + ' / ' + (hover && hover.min) + ')',
              !!rest && !!hover && rest.min >= 4.5 && hover.min >= 4.5, { rest, hover });
          }
          if (log.errors.length) fail('back & contrast ' + at + ': page errors as the platform owner', log.errors);
          await ctx.close();
        }
      }
    }

    // controls: each measurement is shown to see the fault it guards against
    {
      const ar = OFFICIAL.find((x) => x.dir === 'rtl');
      if (!ar) skip('back & contrast (control)', 'no right-to-left official language in the registry');
      else {
        const css = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
        const serve = (body, type, pathname) => async (ctx) => ctx.route((u) => new URL(u).pathname === pathname, (r) => r.fulfill({ contentType: type, body }));
        const noRule = css.replace('.fam-dir-ic:dir(rtl){ transform:scaleX(-1); }', '');
        if (noRule === css) throw new Error('T6 control: the mirroring rule was not found in app.css');
        let o = await asOwner(WIDTHS[0], ar.tag, '/#clubs', '.cp-back', serve(noRule, 'text/css', '/app.css'));
        const a = await pointing(o.page, '.cp-back');
        check('back & contrast (control): without the right-to-left rule, the same measurement sees Arabic "back" pointing left', !!a && a.points === 'left', a);
        await o.ctx.close();
        const oldGreen = css.replace('background:var(--green-700);color:#fff;border:none;', 'background:var(--green);color:#fff;border:none;');
        if (oldGreen === css) throw new Error('T6 control: the sign-in button fill was not found in app.css');
        o = await signedOut(WIDTHS[0], 'en-GB', serve(oldGreen, 'text/css', '/app.css'));
        const c = await contrastOf(o.page, '#login-btn');
        check('back & contrast (control): with the old fill (--green), the same measurement reads ' + (c && c.min) + ':1, below 4.5', !!c && c.min < 4.5, c);
        if (WANT_AXE) {
          const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
          const v = await o.page.evaluate(async (src) => { if (!window.axe) (0, eval)(src); const r = await window.axe.run({ include: ['#login-screen'] }, { runOnly: { type: 'rule', values: ['color-contrast'] } }); return r.violations.map((x) => x.id); }, fs.readFileSync(axePath, 'utf8')); // eslint-disable-line no-eval
          check('back & contrast accessibility (control): axe reports the old fill as color-contrast', v.includes('color-contrast'), v);
        }
        await o.ctx.close();
        const html = (await (await fetch(BASE + '/')).text());
        const noHref = html.replace('<a class="auth-link" href="#" data-show-auth="forgot">', '<a class="auth-link" data-show-auth="forgot">');
        if (noHref === html) throw new Error('T6 control: the forgotten-password link was not found in index.html');
        o = await signedOut(WIDTHS[0], 'en-GB', serve(noHref, 'text/html; charset=utf-8', '/'));
        await o.page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
        const reach = await tabTo(o.page, (f) => f.auth === 'forgot', 10);
        check('back & contrast (control): a link without href is never reached by Tab — the same walk passes it by', reach.f === null, reach.seen);
        await o.ctx.close();
      }
    }

    // axe on the sign-in and forgotten-password screens, every official language: nothing at WCAG 2.2 A/AA, contrast included
    if (WANT_AXE) {
      const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
      if (!fs.existsSync(axePath)) skip('back & contrast accessibility: axe on the sign-in screens', 'axe-core is not installed (' + axePath + ')');
      else {
        const src = fs.readFileSync(axePath, 'utf8');
        for (const l of OFFICIAL) {
          const { ctx, page } = await signedOut(WIDTHS[0], l.tag);
          const run = () => page.evaluate(async (src) => {
            if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
            const r = await window.axe.run({ include: ['#login-screen'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
            return r.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
          }, src);
          const signIn = await run();
          await page.click('[data-show-auth="forgot"]');
          await page.waitForTimeout(400);
          const forgot = await run();
          check('back & contrast accessibility ' + l.tag + ': 0 axe violations (WCAG 2.2 A/AA) on sign-in and on "forgotten password"', signIn.length === 0 && forgot.length === 0, { signIn, forgot });
          await ctx.close();
        }
      }
    }
  }

  // T7 — the Analytics, Medical and Performance player views: their tabs, player cards and back buttons, which were inline
  // handlers the CSP refused, now go through the delegation. Each screen's own template is mounted directly (navTo's
  // separation guard keeps these legacy screens off its allow-list, as its comment says internal callers do), its list is
  // seeded from fixtures shaped like the API's (/players/performance/squad), and the one request its player view makes is
  // answered from a fixture. Everything else is real: the page, the server's CSP, the clicks, keys and taps.
  if (want('T7')) {
    const PLAYERS = [
      { id: 't7-p1', firstName: 'Alex', lastName: 'Rowe', number: 9, position: 'ST', overallRating: 118 },
      { id: 't7-p2', firstName: 'Sami', lastName: 'Haddad', number: 4, position: 'CB', overallRating: 112 },
      { id: 't7-p3', firstName: 'Lena', lastName: 'Voss', number: 8, position: 'CM', overallRating: 121 },
    ].map((p) => ({ ...p, avatar: null, isInjured: false, condition: 88, attributes: { id: p.id + '-a', playerId: p.id, recordedAt: '2026-11-01T10:00:00.000Z', speed: 120, agility: 118, stamina: 115, strength: 100, balance: 110, reaction: null, technique: null, passing: 117, shooting: 112, defending: 98 } }));
    const READINESS = PLAYERS.map((p) => ({ playerId: p.id, firstName: p.firstName, lastName: p.lastName, number: p.number, position: p.position, overallRating: p.overallRating,
      readinessScore: 82, fitnessScore: 80, formScore: 76, developmentScore: 70, acwr: 1.1, condition: 'GOOD', isHighRisk: false, isInjured: false }));
    const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: body }) });
    // Each inline-handler report, with the element it was made for. The page keeps other inline handlers outside what
    // T7 exercises (tracked by tests/csp-inline-handlers.unit.test.ts), and a browser may report one as soon as it is
    // drawn, not only when it runs; so a report counts against T7 when its element lies in a region T7 exercises.
    const T7_REGIONS = '#perf-content,#analytics-content,#medical-content,#analytics-tabs,#medical-tabs';
    const fixtures = async (ctx) => {
      await ctx.addInitScript((regions) => {
        window.__t7csp = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          if (e.violatedDirective !== 'script-src-attr') return;
          const t = e.target, el = t && t.nodeType === 1 ? t : null;
          window.__t7csp.push({ mine: !!(el && el.closest(regions)), what: el ? el.outerHTML.slice(0, 90) : String(t && t.nodeName) });
        });
      }, T7_REGIONS);
      await ctx.route(/\/api\/v1\/analytics\/player\/([^/?]+)/, (r) => { const p = PLAYERS.find((x) => r.request().url().includes(x.id)) || PLAYERS[0];
        return r.fulfill(json({ player: p, radarData: { speed: 80, shooting: 74, passing: 77, technique: 72, defending: 60, stamina: 79, agility: 78, strength: 66 }, matchPerfTrend: [], attendanceRate: 92, injuryImpact: { totalInjuries: 0, totalDaysAbsent: 0, activeInjury: false } })); });
      // shaped as getPlayerMedicalProfile returns it (src/workload/workload-science.service.ts): workload is an object or null
      await ctx.route(/\/api\/v1\/phase-q\/workload\/players\/([^/?]+)\/medical/, (r) => { const p = PLAYERS.find((x) => r.request().url().includes(x.id)) || PLAYERS[0];
        return r.fulfill(json({ player: { id: p.id, firstName: p.firstName, lastName: p.lastName, medicalStatus: 'FIT', isInjured: false, condition: p.condition }, injuries: [], workload: { acwr: 1.1, isHighRisk: false, injuryRiskScore: 18 } })); });
      await ctx.route(/\/api\/v1\/players\/([^/?]+)\/attributes/, (r) => r.fulfill(json([])));
    };
    const SCREENS = [
      { name: 'Performance', page: 'performance', render: 'renderPerformancePage', tab: null,
        opener: '#perf-content [data-action="perfOpenHistory"]', back: '#perf-content [data-action="perfBackToList"]' },
      { name: 'Analytics', page: 'analytics', render: 'renderAnalyticsPage', tab: '#analytics-tabs [data-action="analyticsTab"][data-tab="players"]',
        opener: '#analytics-content [data-action="analyticsOpenPlayer"]', back: '#analytics-content [data-action="analyticsBackToList"]' },
      { name: 'Medical', page: 'medical', render: 'renderMedicalPage', tab: '#medical-tabs [data-action="medicalTab"][data-tab="players"]',
        opener: '#medical-content [data-action="medOpenProfile"]', back: '#medical-content [data-action="medBackToList"]' },
    ];
    const mount = (pg, page) => pg.evaluate(([page, players, readiness]) => {
      // The screen's own template, in a host of its own: as a `.page` the shell's own page switching (which keeps Owner
      // Home the active page) would hide it again; out of that set, nothing but the screen's own code draws it.
      const tpl = { analytics: renderAnalyticsHTML, medical: renderMedicalHTML, performance: renderPerformanceHTML }[page];
      let el = document.getElementById('pg-' + page);
      if (!el) {
        const host = document.createElement('div'); host.id = 't7-host-' + page; host.style.cssText = 'position:fixed;inset:0;z-index:99990;overflow:auto;background:var(--bg)';
        host.innerHTML = tpl(); document.body.appendChild(host); el = document.getElementById('pg-' + page); el.classList.remove('page');
      }
      document.querySelectorAll('[id^="t7-host-"]').forEach((h) => { h.style.display = h.id === 't7-host-' + page ? 'block' : 'none'; });
      if (page === 'performance') { _perfSquad = players; _perfTab = 'dashboard'; _perfHistoryId = null; renderPerformancePage(); }
      if (page === 'analytics') { _analyticsReadiness = readiness; _analyticsTab = 'dashboard'; _analyticsPlayerId = null; renderAnalyticsPage(); }
      if (page === 'medical') { State.players = players; _MedData.injuries = []; _medTab = 'dashboard'; _medProfileId = null; renderMedicalPage(); }
    }, [page, PLAYERS, READINESS]);
    const shown = (pg, sel) => pg.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length > 0), sel);
    const until = (pg, sel, on, ms) => pg.waitForFunction(([sel, on]) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length > 0) === on, [sel, on], { timeout: ms || 8000 }).then(() => true, () => false);
    // A locator, not a handle: the page may be drawn again under the pointer, and a locator finds the element anew.
    const press = async (pg, phone, sel) => { const loc = pg.locator(sel).first(); if (phone) await loc.tap({ timeout: 10000 }); else await loc.click({ timeout: 10000 }); return true; };
    const cspAttr = (pg) => pg.evaluate(() => { const all = window.__t7csp || []; const mine = all.filter((r) => r.mine);
      return { mine: mine.length, mineWhat: mine.slice(0, 3).map((r) => r.what), elsewhere: all.length - mine.length, elsewhereWhat: all.filter((r) => !r.mine).slice(0, 6).map((r) => r.what) }; });
    // The browser's console copy of an inline-handler report is counted, with its element, by cspAttr; any other console error stays an error.
    const errorsOf = (log) => log.errors.filter((m) => !/inline event handler violates the following Content Security Policy directive 'script-src-attr/.test(m));
    const arrowOf = (pg, sel) => pg.evaluate((sel) => {
      const b = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0); const ic = b && b.querySelector('.fam-dir-ic'); if (!ic) return null;
      const m = getComputedStyle(ic).transform; const flipped = !!m && m !== 'none' && parseFloat(m.slice(m.indexOf('(') + 1)) < 0;
      return (ic.textContent.trim() === '←') !== flipped ? 'left' : 'right';
    }, sel);
    const asOwnerShell = (vp, tag, before) => open(vp, tag, { hash: '/#owner-home', wait: false, mobile: vp.mobile, before })
      .then(async (o) => { await o.page.waitForSelector('#pages-container', { timeout: 30000 }); await o.page.waitForFunction((t) => document.documentElement.lang === t, tag, { timeout: 15000 }); await o.page.waitForTimeout(600); return o; });
    const WIDTHS = [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone', mobile: true }];

    for (const l of OFFICIAL) {
      const backDir = l.dir === 'rtl' ? 'right' : 'left';
      for (const vp of WIDTHS) {
        const at = l.tag + ' ' + vp.name, phone = !!vp.mobile;
        const { ctx, page, log } = await asOwnerShell(vp, l.tag, fixtures);
        for (const s of SCREENS) {
          await mount(page, s.page);
          let listed = true;
          if (s.tab) { await press(page, phone, s.tab); listed = await until(page, s.opener, true, 6000); }
          // three round trips: each Back draws the page once and adds no history entry; the arrow points back
          const h0 = await page.evaluate(() => history.length);
          await page.evaluate((fn) => { const f = window[fn]; window.__renders = 0; window[fn] = function () { window.__renders++; return f.apply(this, arguments); }; }, s.render);
          const per = [];
          let arrow = null;
          for (let i = 0; i < 3 && listed; i++) {
            await press(page, phone, s.opener);
            if (!(await until(page, s.back, true, 10000))) { per.push('no view'); break; }
            if (i === 0) arrow = await arrowOf(page, s.back);
            const r0 = await page.evaluate(() => window.__renders);
            await press(page, phone, s.back);
            per.push(await page.evaluate((r0) => window.__renders - r0, r0));
            await until(page, s.back, false, 8000);
          }
          const h1 = await page.evaluate(() => history.length);
          check(`player views ${at}: ${s.name}${s.tab ? ' — the Players tab lists,' : ''} a player opens and Back returns, three times, one redraw each [${per}], no history entry; Back points ${backDir}`,
            listed && per.length === 3 && per.every((n) => n === 1) && h1 === h0 && arrow === backDir, { listed, per, h0, h1, arrow });
          if (!phone) {
            // the keyboard: Tab reaches the opener (with the ring); Enter opens, Enter on Back closes; Space both ways
            await page.evaluate(() => { const h = [...document.querySelectorAll('[id^="t7-host-"]')].find((x) => x.style.display !== 'none'); const a = h.querySelector('.filter-btn.active') || h; if (!a.hasAttribute('tabindex') && a.tagName !== 'BUTTON') a.setAttribute('tabindex', '-1'); a.focus(); });
            let reached = null;
            for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate((sel) => { const a = document.activeElement; return a && a.matches(sel) ? { visible: a.matches(':focus-visible'), ring: getComputedStyle(a).outlineStyle } : null; }, s.opener); if (reached) break; }
            await page.keyboard.press('Enter'); const kOpen = await until(page, s.back, true, 10000);
            await page.focus(s.back); await page.keyboard.press('Enter'); const kClose = await until(page, s.back, false, 8000);
            await page.focus(s.opener); await page.keyboard.press(' '); const sOpen = await until(page, s.back, true, 10000);
            await page.focus(s.back); await page.keyboard.press(' '); const sClose = await until(page, s.back, false, 8000);
            check(`player views ${at}: ${s.name} by keyboard — Tab reaches the opener with a visible ring; Enter opens, Enter on Back closes; Space both ways`,
              !!reached && reached.visible && reached.ring !== 'none' && kOpen && kClose && sOpen && sClose, { reached, kOpen, kClose, sOpen, sClose });
          }
        }
        const reports = await cspAttr(page), errors = errorsOf(log);
        check(`player views ${at}: no inline-handler CSP report from the tabs, cards or Back buttons; no page error`, reports.mine === 0 && errors.length === 0, { reports, errors });
        if (!phone && (l.dir === 'rtl' || l.tag === 'en-GB')) { await mount(page, 'performance'); await press(page, false, SCREENS[0].opener); await until(page, SCREENS[0].back, true, 10000); await shot(page, 'player-views-performance-' + l.tag); }
        await ctx.close();
      }
    }

    // controls: put back what was removed, and the same measurements see it fail
    {
      const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
      const serve = (body) => async (ctx) => { await fixtures(ctx); await ctx.route(/\/app\.js(\?|$)/, (r) => r.fulfill({ contentType: 'application/javascript', body })); };
      const inline = app.replace('type="button" data-action="perfBackToList">${_dirArrow()} Back</button>', 'onclick="_perfHistoryId=null;renderPerformancePage();">${_dirArrow()} Back</button>');
      if (inline === app) throw new Error('T7 control: the Performance back button was not found in app.js');
      let o = await asOwnerShell(WIDTHS[0], 'en-GB', serve(inline));
      await mount(o.page, 'performance'); await press(o.page, false, SCREENS[0].opener); await until(o.page, '#perf-content [onclick^="_perfHistoryId=null"]', true, 10000);
      await press(o.page, false, '#perf-content [onclick^="_perfHistoryId=null"]'); await o.page.waitForTimeout(800);
      const stuck = await shown(o.page, '#perf-content [onclick^="_perfHistoryId=null"]'), refused = await cspAttr(o.page);
      const named = refused.mineWhat.some((w) => w.includes('onclick="_perfHistoryId=null'));
      check('player views (control): the old inline Back handler, put back, does nothing under the CSP and is reported', stuck && refused.mine > 0 && named, { stuck, refused });
      await o.ctx.close();
      const noKeys = app.replace(/document\.addEventListener\('keydown', function delegateKey\(e\) \{[\s\S]*?\n  \}\);/, '');
      if (noKeys === app) throw new Error('T7 control: the key delegate was not found in app.js');
      o = await asOwnerShell(WIDTHS[0], 'en-GB', serve(noKeys));
      await mount(o.page, 'medical'); await press(o.page, false, SCREENS[2].tab); await until(o.page, SCREENS[2].opener, true, 6000);
      await o.page.focus(SCREENS[2].opener); await o.page.keyboard.press('Enter');
      const opened = await until(o.page, SCREENS[2].back, true, 3000);
      check('player views (control): without the key delegate, Enter on a player card opens nothing', !opened, { opened });
      await o.ctx.close();
    }
  }

  // T8 — Phase 2: architecture intelligence. The impact of a node (what depends on it, what it depends on), each answer
  // with the chain of evidence that reached it; highlight and isolate in the scene; the status lens; the 3D view by
  // keyboard. Every answer the room shows is checked against the served graph with a search written here, not the room's.
  if (want('T8')) {
    const ORIGIN = 'file:src/platform/neural-twin/model.ts', ROUTER = 'api:neural-twin.routes';
    const DEPK = ['IMPORTS', 'DATA', 'DEPENDS_ON', 'INFRA', 'IMPLEMENTED_BY', 'USES_TOOLS'];
    const served = (pg) => pg.evaluate(async () => (await (await fetch('/api/v1/system/neural-twin', { credentials: 'include' })).json()).data);
    const kidsOf = (g) => { const k = {}; g.nodes.forEach((n) => { if (n.parent) (k[n.parent] = k[n.parent] || []).push(n.id); }); return k; };
    const subtreeOf = (g, id) => { const k = kidsOf(g), out = [], st = [id]; while (st.length) { const x = st.pop(); out.push(x); st.push(...(k[x] || [])); } return out; };
    // the fewest steps to every node, level by level over every edge: independent of the room's search
    const steps = (g, origins, dir, depth) => {
      const start = new Set(origins), dist = {}; let front = new Set(origins), d = 0;
      while (front.size && (!depth || d < depth)) {
        d += 1; const next = new Set();
        for (const e of g.edges) { if (!DEPK.includes(e.kind)) continue; const a = dir === 'up' ? e.to : e.from, b = dir === 'up' ? e.from : e.to; if (front.has(a) && !start.has(b) && dist[b] === undefined) { dist[b] = d; next.add(b); } }
        front = next;
      }
      return dist;
    };
    const sameSteps = (room, ind) => { const a = Object.keys(room.reached).sort(), b = Object.keys(ind).sort(); return a.length === b.length && a.every((x, i) => x === b[i] && room.reached[x].depth === ind[x]); };
    const impactOf = (pg) => pg.evaluate(() => window.__familistaTwinImpact());
    const chainShown = (pg, id) => pg.evaluate((id) => {
      const li = [...document.querySelectorAll('#nt-impact [data-nt-why]')].find((b) => b.getAttribute('data-nt-why') === id);
      const ol = li && li.closest('li').querySelector('.nt-chain');
      return ol ? { nodes: [...ol.querySelectorAll(':scope > li > .nt-link')].map((b) => b.getAttribute('data-nt-select')), ev: [...ol.querySelectorAll('.nt-ev-inline')].map((c) => c.textContent) } : null;
    }, id);
    // a shown chain is valid when each consecutive pair is joined by a followed graph edge whose evidence is the one shown
    const chainOk = (g, ch, dir) => !!ch && ch.nodes.length >= 2 && ch.nodes.slice(1).every((to, i) => {
      const from = ch.nodes[i];
      const e = g.edges.find((x) => DEPK.includes(x.kind) && (dir === 'up' ? x.to === from && x.from === to : x.from === from && x.to === to));
      return !!e && ch.ev[i] === e.evidence[0].p + (e.evidence[0].l ? ':' + e.evidence[0].l : '');
    });
    const pick = async (pg, id, q) => { await pg.fill('#nt-q', q); await pg.click('#nt-tree [data-nt-select="' + id + '"]'); await settle(pg); };
    const AXE_SRC = WANT_AXE ? fs.readFileSync(process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js'), 'utf8') : '';

    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en-GB');
      const g = await served(page);
      await pick(page, ORIGIN, 'model.ts');
      let r = await impactOf(page);
      const ind3 = steps(g, [ORIGIN], 'up', 3);
      check('impact: what depends on a file, 3 steps — the room\'s answer is the served graph\'s, node for node and step for step (an independent search agrees)',
        !!r && r.dir === 'up' && r.depth === 3 && r.ids.length > 0 && sameSteps(r, ind3), { reached: r && r.ids.length, independent: Object.keys(ind3).length });
      const groups = await page.evaluate(() => [...document.querySelectorAll('#nt-impact [data-nt-impact-kind]')].map((el) => [el.getAttribute('data-nt-impact-kind'), Number((el.querySelector('.nt-chip-n') || {}).textContent)]));
      check('impact: the panel lists every node reached, grouped by kind, API routers first', groups.reduce((n, x) => n + x[1], 0) === r.ids.length && groups[0][0] === 'api', groups);
      await page.click('#nt-impact [data-nt-why="' + ROUTER + '"]');
      const ch = await chainShown(page, ROUTER);
      const ownerBadge = await page.evaluate((id) => { const b = [...document.querySelectorAll('#nt-impact [data-nt-why]')].find((x) => x.getAttribute('data-nt-why') === id); return !!(b && b.closest('li').querySelector('.nt-badge--owner')); }, ROUTER);
      check('impact: "Why" shows the chain from the file to the owner-only router, every hop a real edge with the evidence it cites', chainOk(g, ch, 'up') && ch.nodes[0] === ORIGIN && ch.nodes[ch.nodes.length - 1] === ROUTER && ownerBadge, { ch, ownerBadge });
      // (control) the same check catches a chain with a hop the graph does not have
      const forged = ch ? { nodes: [ch.nodes[0], 'file:src/server.ts', ...ch.nodes.slice(2)], ev: ch.ev } : null;
      check('impact (control): a chain with a fabricated hop fails the same check', !chainOk(g, forged, 'up'), forged);

      // keyboard: the controls are buttons; Enter and Space work, and focus stays on the control that was used
      const STORE = 'file:src/platform/neural-twin/store.ts';
      await pick(page, STORE, 'store.ts');
      await page.focus('#nt-impact [data-nt-impact-dir="down"]'); await page.keyboard.press('Enter'); await settle(page);
      const kb1 = await page.evaluate(() => ({ pressed: document.querySelector('#nt-impact [data-nt-impact-dir="down"]').getAttribute('aria-pressed'), focused: document.activeElement && document.activeElement.getAttribute('data-nt-impact-dir'), ring: getComputedStyle(document.activeElement).outlineStyle }));
      await page.focus('#nt-impact [data-nt-impact-depth="0"]'); await page.keyboard.press(' '); await settle(page);
      r = await impactOf(page);
      const indAllDown = steps(g, [STORE], 'down', 0);
      check('impact by keyboard: Enter turns it to "what it depends on", Space takes every step; focus stays on the control, with its ring; the answer matches, and holds what store.ts imports, never what imports it',
        kb1.pressed === 'true' && kb1.focused === 'down' && kb1.ring !== 'none' && r.dir === 'down' && r.depth === 0 && !r.limited && r.ids.length > 10 && sameSteps(r, indAllDown) && r.ids.includes(ORIGIN) && !r.ids.includes(ROUTER), { kb1, reached: r.ids.length, limited: r.limited });
      await pick(page, ORIGIN, 'model.ts');

      // highlight, then isolate: what the scene shows is the impact and nothing else
      await page.click('#nt-impact [data-nt-impact-dir="up"]'); await page.click('#nt-impact [data-nt-impact-depth="3"]'); await settle(page);
      const before = (await M(page)).expanded;
      await page.click('#nt-impact [data-nt-impact-scene="highlight"]'); await settle(page);
      let m = await M(page), ig = await integrity(page);
      check('impact highlighted: what it reached is marked in the scene and its chains are drawn as highlighted lines, each a real edge', m.impact.scene === 'highlight' && m.impact.near > 0 && m.impact.lines > 0 && ig.badCount === 0 && ig.caught, { impact: m.impact, ig: { bad: ig.badCount, drawn: ig.drawn } });
      const t0 = Date.now();
      await page.click('#nt-impact [data-nt-impact-scene="isolate"]'); await settle(page);
      const isoMs = Date.now() - t0;
      m = await M(page);
      r = await impactOf(page);
      const keep = new Set(); const parent = {}; g.nodes.forEach((n) => { parent[n.id] = n.parent; });
      const markUp = (id) => { let c = id; while (c) { keep.add(c); c = parent[c]; } };
      subtreeOf(g, ORIGIN).forEach(markUp); r.ids.forEach(markUp);
      const shownIds = Object.keys((await page.evaluate(() => window.__familistaTwinLayout())).pos);
      check(`impact isolated: the scene holds the file, what depends on it and what contains them, and nothing else; every node reached is itself drawn (${shownIds.length} shown)`,
        shownIds.length > 0 && shownIds.every((id) => keep.has(id)) && r.ids.every((id) => shownIds.includes(id)) && shownIds.includes(ORIGIN), { shown: shownIds.length, keep: keep.size, outside: shownIds.filter((id) => !keep.has(id)).slice(0, 4) });
      const lc = await layoutCheck(page);
      check('impact isolated: no two nodes collide, and each sits inside its parent', lc.badCount === 0 && lc.outside.length === 0, lc);
      await shot(page, 'p2-isolate-en-GB');
      await page.click('#nt-impact [data-nt-impact-scene="off"]'); await settle(page);
      m = await M(page);
      check('impact: leaving isolation gives the reader back the systems and modules they had open', JSON.stringify(m.expanded) === JSON.stringify(before), { before, after: m.expanded });

      // the status lens: a status switched off is not drawn; switched on, it is again
      const unreached = g.nodes.find((n) => n.facts && n.facts.reachableFromEntry === false && !n.facts.dormantRouter && n.kind === 'file');
      await pick(page, unreached.id, unreached.label);
      const shownBefore = Object.keys((await page.evaluate(() => window.__familistaTwinLayout())).pos).includes(unreached.id);
      const statusText = await page.evaluate(() => (document.querySelector('#nt-inspector .nt-dl .nt-status') || {}).textContent);
      await page.click('[data-nt-status="unreached"]'); await settle(page);
      const shownOff = Object.keys((await page.evaluate(() => window.__familistaTwinLayout())).pos).includes(unreached.id);
      await page.click('[data-nt-status="unreached"]'); await settle(page);
      const shownOn = Object.keys((await page.evaluate(() => window.__familistaTwinLayout())).pos).includes(unreached.id);
      check('status: a file nothing reaches is marked "Not reached"; switching that status off hides it, on shows it again', shownBefore && statusText === 'Not reached' && !shownOff && shownOn, { id: unreached.id, statusText, shownBefore, shownOff, shownOn });
      const tally = await page.evaluate(async () => { const m = window.__familistaTwinMetrics(); return m.statuses; });
      check('status: all six statuses are switched on again, and none is "experimental" or "deprecated"', JSON.stringify(tally) === JSON.stringify(['dormant', 'implemented', 'partial', 'planned', 'unreached', 'unverified']), tally);

      // the 3D view by keyboard: arrows turn and tilt, + zooms, Home returns to the overview
      await page.focus('#nt-canvas');
      const c0 = (await M(page)).camera;
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('+');
      const c1 = (await M(page)).camera;
      check('the 3D view by keyboard: the left arrow turns it, the up arrow tilts it, + zooms in', Math.abs((c0.a - c1.a) - Math.PI / 24) < 1e-6 && c1.b < c0.b && c1.r < c0.r, { c0, c1 });

      // timings, on a software renderer: the largest impact in the graph, and isolating it
      await pick(page, 'file:src/utils/errors.ts', 'errors.ts');
      await page.click('#nt-impact [data-nt-impact-depth="0"]'); await settle(page);
      m = await M(page);
      const big = await impactOf(page);
      check(`performance: the impact of src/utils/errors.ts, every step (${big.ids.length} nodes), computed in ${m.impact.ms} ms (budget 50 ms)`, m.impact.ms != null && m.impact.ms <= 50 && big.ids.length > 100, m.impact);
      check(`performance: isolating an impact and redrawing the scene took ${isoMs} ms (budget 3000 ms on a software renderer)`, isoMs <= 3000, { isoMs });
      check('impact: no page error and no CSP violation from the room through every step', log.errors.length === 0 && (await roomCsp(page)) === 0, log.errors.slice(0, 3));
      if (WANT_AXE) {
        await pick(page, ORIGIN, 'model.ts');
        await page.click('#nt-impact [data-nt-why="' + ROUTER + '"]');
        const v = await page.evaluate(async (src) => { if (!window.axe) (0, eval)(src); const res = await window.axe.run(document.getElementById('nt-inspector'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] }); return res.violations.map((x) => x.id + ' ×' + x.nodes.length); }, AXE_SRC);
        check('impact accessibility: 0 axe violations (WCAG 2.2 A/AA) in the inspector with the impact and a chain open', v.length === 0, v);
      }
      await ctx.close();
    }

    // (control) the panel reads the graph: remove the edge that reached the router, and the router is no longer at step 2
    {
      const tamper = async (ctx) => {
        await ctx.route(/\/api\/v1\/system\/neural-twin$/, async (route) => {
          const res = await route.fetch(); const body = await res.json();
          body.data.edges = body.data.edges.filter((e) => !(e.kind === 'IMPORTS' && e.from === ROUTER && e.to === 'file:src/platform/neural-twin/store.ts'));
          route.fulfill({ response: res, body: JSON.stringify(body) });
        });
      };
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en-GB', { before: tamper });
      await pick(page, ORIGIN, 'model.ts');
      const r = await impactOf(page);
      check('impact (control): with the store → router import removed from the served graph, the router is not reached at step 2', !(r.reached[ROUTER] && r.reached[ROUTER].depth === 2), { router: r.reached[ROUTER] || null });
      await ctx.close();
    }

    // every official language, desktop and phone: the panel in the reader's language and direction, nothing off-screen
    for (const l of OFFICIAL) {
      const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/neural-twin/i18n/' + l.tag.slice(0, 2) + '.json'), 'utf8'));
      for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone', mobile: true }]) {
        const { ctx, page, log } = await open({ width: vp.width, height: vp.height }, l.tag, { mobile: vp.mobile });
        await pick(page, ORIGIN, 'model.ts');
        await page.click('#nt-impact [data-nt-why="' + ROUTER + '"]');
        const st = await page.evaluate(() => {
          const sec = document.getElementById('nt-impact'), title = document.getElementById('nt-impact-t');
          const segs = [...sec.querySelectorAll('.nt-seg')].map((x) => x.getBoundingClientRect()), vw = innerWidth;
          return { dir: document.documentElement.dir || getComputedStyle(sec).direction, cssDir: getComputedStyle(sec).direction, title: title && title.textContent, why: (sec.querySelector('[data-nt-why]') || {}).textContent,
            over: document.scrollingElement.scrollWidth - vw, segsInside: segs.every((b) => b.left >= -1 && b.right <= vw + 1), evLtr: [...sec.querySelectorAll('.nt-chain code')].every((c) => c.getAttribute('dir') === 'ltr') };
        });
        check(`impact ${l.tag} ${vp.name}: the panel speaks the reader's language ("${st.title}"), runs ${l.dir}, its controls fit, nothing scrolls sideways, paths stay left to right`,
          st.title === cat['Impact'] && st.why === cat['Why'] && st.cssDir === l.dir && st.segsInside && st.over <= 0 && st.evLtr && log.errors.length === 0, st);
        if (l.tag === 'ar' || l.tag === 'en-GB') await shot(page, 'p2-impact-' + l.tag + '-' + vp.name);
        await ctx.close();
      }
    }
  }

  await browser.close();
  server.close();
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`SUMMARY ${results.filter((r) => r[0] === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r[0] === 'SKIP').length} skipped`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log('SUMMARY 0 passed, 1 failed, 0 skipped'); process.exit(1); });
