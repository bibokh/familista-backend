#!/usr/bin/env node
// Familista — Specimen Lab: browser proofs (Stage 3.2.3 M1, M2 / S1 zoom, M2 / S2 width, M2 / S3 comparison, M2 / S4 navigation,
// M3 / S1 room stability), Familista Design Studio, Slice 1a (sections 14 and 14a), and the AI Agents Operations Room (sections 16
// and 16a).
//
// The Lab claims four boundaries around a specimen and one around the server:
// events stop at the stage, fixed overlays stay in it, the application's
// translator leaves it alone, nothing it draws reaches the rest of the page,
// and it asks the server for nothing but three GETs. None of those can be proven
// in Jest, because Jest has no layout engine, no real event dispatch and no
// translator. This script proves each in a real Chromium, against the REAL
// compiled application served by the REAL app (only the database is stubbed), as
// a Platform Owner.
//
// It is a required CI job (the `browser-proof` jobs in .github/workflows/ci.yml).
// Its two tools, playwright-core and axe-core, are pinned in tools/components/
// package.json and installed by `npm ci --prefix tools/components`; nothing in the
// production package depends on them. It also needs a Chrome or Chromium to launch.
//
//   npm run build                                   (the compiled app in dist/)
//   npm ci --ignore-scripts --prefix tools/components
//   CHROMIUM=$(command -v google-chrome) \
//     node tools/components/lab-browser-proof.cjs <output-dir> [--axe]
//
//   PLAYWRIGHT_CORE   path of the playwright-core package (default: the pinned copy in tools/components)
//   CHROMIUM          path of a Chrome or Chromium executable (default: Playwright's own, which is not installed)
//   AXE_CORE          path of axe.min.js, for --axe (default: the pinned copy in tools/components)
//   PROOF_ONLY        run only these numbered sections, e.g. 6,7 (CI splits the proof in two this way)
//
// Every line is PASS or FAIL with the number behind it. The exit code is 1 if any
// proof fails. A proof that cannot be run says SKIP and why; it never says PASS.
//
// Each isolation proof is paired with a control that removes the thing being
// proved and shows the proof can see the difference, so a PASS is not a probe that
// would pass whatever the page did. That includes the focus, error and CSP proofs
// (section 7): their controls serve a lab.js with one behaviour switched off, or
// break the policy on purpose, and require the same measurement to turn red.
//
// Console errors and CSP violations are never filtered away. The application's own
// pre-existing inline-style violations (style-src-attr, raised by /app.js or by the
// page's own HTML) are counted and reported apart, because their number depends on
// how much of the application has painted. A violation is the Lab's if it was raised
// on an element inside .lab, by a Lab script (its sourceFile), or names a Lab file;
// any report that can be placed nowhere is "unexplained". Both of those must be zero.
'use strict';

process.env.NODE_ENV = 'production';
process.env.PORT = '47932';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(48);
process.env.DATABASE_URL = 'postgresql://stub:stub@stub/stub';

const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2];
const WANT_AXE = process.argv.includes('--axe');
// PROOF_ONLY=2b,3 runs only those numbered sections (all of them by default).
const want = (n) => !process.env.PROOF_ONLY || process.env.PROOF_ONLY.split(',').includes(n);
if (!OUT) { console.error('usage: node tools/components/lab-browser-proof.cjs <output-dir> [--axe]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

// Console messages that are NOTICES, not errors: the browser's own copy of a CSP violation the event-based accounting below
// already counts and sorts (securitypolicyviolation), and a failed network load, which is kept with its URL. Chrome words the
// two CSP ones differently from version to version (141: "Refused to apply inline style…", "Refused to connect…"; 154:
// "Applying inline style violates…", "Connecting to '…' violates…"), so both wordings are listed. Anything else a browser says
// about a CSP violation, an inline script or a script load for instance, is NOT listed here and stays an error.
const NOTICE = /Failed to load resource|Refused to (apply|connect)|(Applying inline style|Connecting to '[^']*') violates the following Content Security Policy directive/;

// The database is the one thing replaced: every query answers "nothing".
const OWNER = { id: 'u-owner', email: 'owner@familista.test', role: 'SUPER_ADMIN', clubId: null, isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: { isActive: true } };
const COACH = { id: 'u-coach', email: 'coach@familista.test', role: 'COACH', clubId: 'club-1', isActive: true, currentClubId: 'club-1', currentTeamId: null, tokenVersion: 0, platformAdmin: null };
let CURRENT = OWNER;
const dbProxy = new Proxy({}, {
  get(_t, k) {
    if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
    if (k === '$transaction') return async (f) => (Array.isArray(f) ? [] : f({}));
    if (k === '$connect' || k === '$disconnect') return async () => {};
    if (k === 'user') return { findFirst: async () => CURRENT, findUnique: async () => CURRENT, count: async () => 1 };
    return new Proxy({}, { get: (_x, op) => async () => (op === 'count' ? 0 : op === 'findFirst' || op === 'findUnique' ? null : []) });
  },
});
require.cache[require.resolve(path.join(ROOT, 'dist/config/database'))] = { exports: { prisma: dbProxy, connectDatabase: async () => true, disconnectDatabase: async () => true } };
const { signToken } = require(path.join(ROOT, 'dist/security/jwt-tokens'));

const results = [];
// Every time the Lab is mounted on a page (a new .lab root), by the application or by a proof, as milliseconds since the epoch,
// recorded from the page through a binding (see open()). `LAB_EXPECTED` counts the mounts a proof caused on purpose (remount(),
// roomRedraw()); `LAB_READY` is when settleRoom() found the room quiet. A FAIL prints the history of the page under test, so a
// failure that coincides with the application remounting the Lab says so instead of leaving it to be guessed.
const LAB_MOUNTS = new Map(), LAB_EXPECTED = new Map(), LAB_READY = new Map();
let LAB_PAGE = null;
const mountNote = () => {
  if (!LAB_PAGE) return;
  const all = LAB_MOUNTS.get(LAB_PAGE) || [], ready = LAB_READY.get(LAB_PAGE), after = ready ? all.filter((t) => t > ready) : [];
  const byProof = LAB_EXPECTED.get(LAB_PAGE) || 0;
  console.log('NOTE lab mounts on the page under test: ' + all.length + ' in all' + (ready ? ', ' + after.length + ' after it was settled (' + byProof + ' of them by a proof on purpose), at +' + after.map((t) => t - ready).join(', +') + ' ms' : ', and it was never settled'));
};
const pass = (name, detail) => { results.push(['PASS', name]); console.log('PASS ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); };
const fail = (name, detail) => { results.push(['FAIL', name]); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); mountNote(); };
const skip = (name, why) => { results.push(['SKIP', name]); console.log('SKIP ' + name + ' :: ' + why); };
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));

(async () => {
  const mod = require(path.join(ROOT, 'dist/app'));
  const app = (mod.createApp || mod.default || mod.app)();
  const server = http.createServer(app);
  await new Promise((ok) => server.listen(47932, '127.0.0.1', ok));
  const BASE = 'http://127.0.0.1:47932';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--no-sandbox'] });
  const token = signToken('access', { sub: OWNER.id, role: OWNER.role }, { expiresIn: '60m' });

  // `labPatch` and `opts.appPatch`, used only by the negative controls, serve lab.js or app.js with one edit applied (a control
  // that breaks the behaviour under proof, so the proof can be seen to fail); everything else is the file on disk. `opts.wait`
  // false returns as soon as the page has loaded, for a control whose room is expected never to draw.
  async function open(viewport, locale, labPatch, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const patch = async (file, url, fn) => {
      const original = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
      const patched = fn(original);
      if (patched === original) throw new Error('negative control: the edit did not change ' + file + ', so it would prove nothing');
      await ctx.route(url, (r) => r.fulfill({ contentType: 'application/javascript', body: patched }));
    };
    if (labPatch) await patch('design-system/lab.js', /\/design-system\/lab\.js(\?|$)/, labPatch);
    if (opts.appPatch) await patch('app.js', /\/app\.js(\?|$)/, opts.appPatch);
    await ctx.addCookies([{ name: 'access_token', value: token, domain: '127.0.0.1', path: '/', httpOnly: true }]);
    await ctx.exposeBinding('__famProofLabMounted', (src) => { const a = LAB_MOUNTS.get(src.page) || []; a.push(Date.now()); LAB_MOUNTS.set(src.page, a); });
    await ctx.addInitScript(() => {
      // A Lab mount writes a new .lab root into its host; that one added element is all this looks for. Each mount also says
      // which room render it answered (__proofLabForRender), for settleRoom.
      window.__proofRenders = 0; window.__proofRenderAt = 0; window.__proofLabMountAt = 0; window.__proofLabForRender = 0;
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('lab')) {
          window.__proofLabMountAt = performance.now(); window.__proofLabForRender = window.__proofRenders;
          try { window.__famProofLabMounted(); } catch (_) { /* binding gone with the page */ }
        }
      }).observe(document, { childList: true, subtree: true });
      // Count the room's renders (the page-render registry, a navigation and remount() all call it by this name): whatever
      // design-system.js assigns here is called exactly as before, with its own arguments and `this`, and only counted.
      let render;
      Object.defineProperty(window, 'renderFamilistaDesignSystem', { configurable: true, enumerable: true,
        get() { return render; },
        set(fn) { render = typeof fn !== 'function' ? fn : function () { window.__proofRenders++; window.__proofRenderAt = performance.now(); return fn.apply(this, arguments); }; } });
    });
    await ctx.addInitScript((l) => {
      try { if (l) localStorage.setItem('familista_design_system_locale', l); } catch (_) { /* private mode */ }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ d: e.violatedDirective, uri: String(e.blockedURI).slice(0, 80), inLab: !!(e.target && e.target.closest && e.target.closest('.lab')), src: String(e.sourceFile || '').replace(location.origin, '').slice(0, 80) }));
    }, locale || null);
    const page = await ctx.newPage();
    // `errors` holds every page error and every console error that is not a network or CSP notice. Those two notices
    // are kept too, in `notices` with the URL they name, never dropped: a notice that names a Lab file is a Lab error.
    const log = { errors: [], notices: [], requests: [] };
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (NOTICE.test(m.text())) log.notices.push({ text: m.text().slice(0, 200), url: String((m.location() && m.location().url) || '').slice(0, 200) });
      else log.errors.push('console: ' + m.text().slice(0, 200));
    });
    page.on('request', (r) => log.requests.push([r.method(), new URL(r.url()).pathname + new URL(r.url()).search, new URL(r.url()).origin]));
    await page.goto(BASE + '/#design-system', { waitUntil: 'load' });
    if (opts.wait !== false) await page.waitForSelector('.ds-metric', { timeout: 30000 });
    return { ctx, page, log };
  }
  async function openLab(page, opts) {
    LAB_PAGE = page;
    await page.click('[data-ds-nav="lab"]');
    await page.waitForSelector('#lab-specimen .lab-col', { timeout: 30000 });
    await page.waitForTimeout(300);
    if (opts && opts.settle) await settleRoom(page);
  }
  // Until M3 / S1 the application repainted the Design System room when its start-up data landed (app.js AppContext.load →
  // _famDataChanged, twice at start-up → the page-render registry → renderFamilistaDesignSystem), and each repaint mounted the Lab
  // again under the M2 sections' clicks (M2 CI: section 10's Swap announcement on #107, section 8's zoom button on #108). The room
  // is no longer among the club-data pages and section 12 proves it is left alone; settleRoom stays as the guard it always was, so
  // a regression shows up as section 12 failing rather than as these sections flaking.
  // settleRoom waits until that is over, from the application's own signals, not from a quiet interval: the page's network has
  // gone idle (so /me/context has answered), the data version has not moved for SETTLE_STABLE_MS, and the latest room render is
  // that old and has mounted the Lab. It asserts nothing and changes nothing; the Lab must still be there after it, and a room that
  // has not settled by SETTLE_MAX_MS is an error that fails the run, never a pass.
  const SETTLE_STABLE_MS = 1000, SETTLE_MAX_MS = 15000, SETTLE = { settle: true };
  async function settleRoom(page) {
    const t0 = Date.now();
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) { /* a page that polls never idles: the signals below decide */ }
    try {
      await page.waitForFunction((stable) => {
        const now = performance.now(), v = window._FAM_DATA_VERSION;
        if (window.__proofVer !== v) { window.__proofVer = v; window.__proofVerAt = now; }
        return now - window.__proofVerAt >= stable && now - window.__proofRenderAt >= stable && window.__proofLabForRender === window.__proofRenders && !!document.querySelector('#lab-specimen .lab-col');
      }, SETTLE_STABLE_MS, { timeout: SETTLE_MAX_MS, polling: 100 });
    } catch (_) {
      const st = await page.evaluate(() => ({ version: window._FAM_DATA_VERSION, renders: window.__proofRenders, labMountedForRender: window.__proofLabForRender, lab: !!document.querySelector('#lab-specimen .lab-col') }));
      throw new Error('settle: the room had not settled ' + SETTLE_MAX_MS + ' ms after the Lab first drew: ' + JSON.stringify(st) + ', Lab mounts ' + (LAB_MOUNTS.get(page) || []).length);
    }
    LAB_READY.set(page, Date.now());
    const st = await page.evaluate(() => ({ version: window._FAM_DATA_VERSION, renders: window.__proofRenders }));
    console.log('NOTE settle: room settled ' + (Date.now() - t0) + ' ms after the Lab first drew (data version ' + st.version + ', room renders ' + st.renders + ', Lab mounts ' + (LAB_MOUNTS.get(page) || []).length + ')');
  }
  const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // M3/S3.2: one line per measurement the budget report reads (tools/components/budget-report.cjs, which decides each status;
  // an id it does not know fails it). Each is written from samples a loop has already taken: nothing here runs inside a loop.
  const emitMetric = (id, fields) => console.log('METRIC ' + JSON.stringify({ id, ...fields }));
  const maxOf = (a) => Math.round(Math.max(...a) * 10) / 10;
  // The frame interval, measured on the page after its loops have finished: the median of twenty gaps between idle frames.
  const frameInterval = (page) => page.evaluate(() => new Promise((resolve) => {
    const t = [];
    const step = (now) => { t.push(now); if (t.length <= 20) requestAnimationFrame(step); else { const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); resolve(Math.round(d[10] * 100) / 100); } };
    requestAnimationFrame(step);
  }));
  const frameCounts = (samples, interval) => { const out = {}; for (const v of samples) { const f = Math.max(1, Math.round(v / interval)); out[f] = (out[f] || 0) + 1; } return out; };
  const blur = (pg) => pg.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  const inside = (a, b, tol = 1) => !!a && !!b && a[0] >= b[0] - tol && a[1] >= b[1] - tol && a[2] <= b[2] + tol && a[3] <= b[3] + tol;

  // ── what counts as the Lab's fault ───────────────────────────────────────────
  // Every CSP violation the page reported is sorted, and none is discarded. Two facts place a report, and either is enough:
  // the element it was raised on is inside .lab, or the script that raised it is a Lab file (`sourceFile`). The second matters
  // because Chromium reports against the document, not the element, once the element has been removed, and the Lab redraws
  // itself by removing nodes; the application's own 99 such reports all carry /app.js as their source.
  //   lab          the Lab's: raised on a Lab element, by a Lab script, or naming a Lab file. Must be zero.
  //   application  style-src-attr raised by a first-party script that is not a Lab file, or by the page's own HTML as it is parsed
  //                (source "/"). Pre-existing; reported, never compared, because its number depends on how much of the
  //                application has painted.
  //   axeProbe     see below.
  //   unexplained  everything else: another directive, or a report no script or element can be placed. Must be zero.
  //
  // `axeProbe` exists for one thing: axe-core, while it runs, fetches the page's cross-origin web-font stylesheet to read its
  // rules, and the page's connect-src refuses it. That is the measuring tool being refused, not the Lab and not the application.
  // It counts only if it arrives inside an axe.run window AND is a connect-src violation for that exact stylesheet; the same
  // violation outside an axe run, or any other connect-src violation, is unexplained.
  //
  // `from` limits the sorting to the reports that arrived at or after that index of the page's list. Only the negative controls
  // use it, to measure what one injection caused against a baseline taken immediately before it, so the application's own
  // late painting, which keeps adding application reports for seconds after the page is quiet, cannot move a control's count.
  const cspSplit = (page, from = 0) => page.evaluate((from) => {
    const ranges = window.__axeRanges || [];
    const v = (window.__csp || []).map((c, i) => ({ c, i })).filter((x) => x.i >= from);
    const LAB = /design-system\/lab/;
    const lab = (c) => c.inLab || LAB.test(c.uri) || LAB.test(c.src);
    const app = (c) => !lab(c) && c.d === 'style-src-attr' && /^\//.test(c.src);
    const probe = (c, i) => !lab(c) && c.d === 'connect-src' && /^https:\/\/fonts\.googleapis\.com\/css/.test(c.uri) && ranges.some((r) => i >= r[0] && i < r[1]);
    const unexplained = v.filter(({ c, i }) => !lab(c) && !app(c) && !probe(c, i)).map((x) => x.c);
    return { total: v.length, lab: v.filter((x) => lab(x.c)).length, application: v.filter((x) => app(x.c)).length, axeProbe: v.filter((x) => probe(x.c, x.i)).length, unexplained: unexplained.length, unexplainedDirectives: [...new Set(unexplained.map((c) => c.d + (c.src ? ' @' + c.src : ' (no source)')))] };
  }, from);
  // The number of reports so far: the baseline for one injection.
  const cspMark = (page) => page.evaluate(() => (window.__csp || []).length);
  // Wait until the application has stopped painting (no new violation for 800 ms), so a before/after comparison measures only
  // what the control did. The application's late paint can also remount the Lab, which would detach what a control injected.
  async function quiet(page) {
    let last = -1;
    for (let i = 0; i < 20; i++) { const n = await page.evaluate(() => (window.__csp || []).length); if (n === last) return n; last = n; await page.waitForTimeout(800); }
    return last;
  }
  // The room can be redrawn under a probe by the application's own late painting (the same remount the focus proofs exercise on
  // purpose). A probe waits for the room and the Lab to be there, and is retried at most twice if the page was replaced under it.
  // Every retry is counted and reported with the result; a probe that still fails after that throws, it is never swallowed.
  const settled = (page) => page.waitForFunction(() => document.getElementById('ds-body') && document.querySelector('.lab') && document.querySelector('.lab #lab-rail-body'), null, { timeout: 15000 }).then(() => page.waitForTimeout(300));
  async function steady(page, fn) {
    for (let attempt = 0; ; attempt++) {
      await settled(page);
      try { const out = await fn(); return { out, retries: attempt }; } catch (e) { if (attempt >= 2 || !/Cannot read properties of null|Execution context was destroyed|Target (page|closed)/.test(String(e))) throw e; }
    }
  }
  // A page error, a console error, or a network/CSP notice that names a Lab file.
  const LAB_URL = /design-system\/lab|components\/preview|design-system\/components/;
  // Who made a request. The application keeps refreshing its own data in the background while the reader works in the Lab, so a
  // "nothing was fetched" proof cannot count every request in its window. Every request is placed instead, from the browser's own
  // record of the script stack that started it (async parents included): it is the Lab's if it is for a Lab endpoint OR any frame
  // that started it is a Lab file, whatever the path; otherwise it is the application's. A Lab request to any URL is caught.
  const LAB_FILE = /\/design-system\/lab(-view|-sanitize)?\.js/;
  async function netWatch(pg) {
    const cdp = await pg.context().newCDPSession(pg);
    const seen = [];
    cdp.on('Network.requestWillBeSent', (e) => {
      const frames = [];
      for (let st = e.initiator && e.initiator.stack; st; st = st.parent) for (const f of st.callFrames || []) frames.push(f.url);
      let path = e.request.url;
      try { const u = new URL(e.request.url); path = u.origin === BASE ? u.pathname + u.search : e.request.url; } catch (_) { /* keep the raw url */ }
      seen.push({ method: e.request.method, path, lab: LAB_URL.test(path) || frames.some((u) => LAB_FILE.test(u)), by: [...new Set(frames.map((u) => u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]))].slice(0, 3) });
    });
    await cdp.send('Network.enable'); await cdp.send('Debugger.enable'); await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
    return { seen, stop: () => cdp.detach() };
  }
  const labErrors = (log) => log.errors.concat(log.notices.filter((n) => LAB_URL.test(n.url) || LAB_URL.test(n.text)).map((n) => 'notice: ' + n.text + ' @ ' + n.url));
  const activeKey = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.getAttribute('data-lab-id') || a.getAttribute('data-lab-fx') || a.getAttribute('data-lab-tab') || a.getAttribute('data-lab-dir') || a.getAttribute('data-lab-zoom') || a.getAttribute('data-lab-width') || a.getAttribute('data-lab-mode') || a.getAttribute('data-lab-nav') || a.tagName) : null; });
  // Redraw the room the way the application does when a page is shown again: through the page-render registry. True only if
  // a NEW Lab root replaced the old one, so a remount that never happened cannot pass for a restored focus.
  async function remount(page) {
    LAB_EXPECTED.set(page, (LAB_EXPECTED.get(page) || 0) + 1);
    await page.evaluate(() => { window.__mark = document.querySelector('.lab'); window.renderFamilistaDesignSystem(); });
    try { await page.waitForFunction(() => { const l = document.querySelector('.lab'); return l && l !== window.__mark && document.getElementById('lab-specimen'); }, null, { timeout: 8000 }); } catch (_) { return false; }
    await page.waitForTimeout(400);
    return true;
  }
  // Redraw the room as a navigation, a Refresh or a language switch does (they all go through this renderer), and record every
  // write into a live region from that moment on. Null if no NEW Lab root replaced the old one.
  const liveRecord = () => {
    window.__liveWrites = [];
    window.__liveMo = new MutationObserver((ms) => ms.forEach((m) => { if (m.target && m.target.id === 'lab-live') window.__liveWrites.push(m.target.textContent); }));
    window.__liveMo.observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  async function roomRedraw(page) {
    LAB_EXPECTED.set(page, (LAB_EXPECTED.get(page) || 0) + 1);
    await page.evaluate(liveRecord);
    await page.evaluate(() => { window.__mark = document.querySelector('.lab'); window.renderFamilistaDesignSystem(); });
    try { await page.waitForFunction(() => { const l = document.querySelector('.lab'); return l && l !== window.__mark && document.getElementById('lab-specimen'); }, null, { timeout: 8000 }); } catch (_) { return null; }
    await page.waitForTimeout(600);
    return page.evaluate(() => { window.__liveMo.disconnect(); return { live: document.getElementById('lab-live').textContent, writes: window.__liveWrites.slice() }; });
  }
  // What background club data does to the room (app.js _famDataChanged), which since M3 / S1 is nothing: the room draws no club
  // data. Records the live region's writes from that moment, and whether the Lab root and the room shell are the same elements
  // afterwards (`same`) and how many room renders it caused.
  async function dataChange(page, settleMs = 600, recording = false) {
    if (!recording) await page.evaluate(liveRecord);
    await page.evaluate(() => {
      window.__mark = document.querySelector('.lab'); window.__markShell = document.querySelector('.ds-shell'); window.__markRenders = window.__proofRenders;
      window._famDataChanged();
    });
    await page.waitForTimeout(settleMs);
    return page.evaluate(() => { window.__liveMo.disconnect(); return { same: document.querySelector('.lab') === window.__mark && document.querySelector('.ds-shell') === window.__markShell, renders: window.__proofRenders - window.__markRenders, live: (document.getElementById('lab-live') || {}).textContent, writes: window.__liveWrites.slice() }; });
  }
  const FOCUS_TARGETS = [['rail item', '[data-lab-id="lg-chip"]'], ['fixture tab', '.lab-fx.is-on'], ['search', '#lab-q'], ['inspector tab', '[data-lab-tab="source"]'], ['direction', '[data-lab-dir="rtl"]'], ['zoom in', '[data-lab-zoom="in"]'], ['width preset', '[data-lab-width="mobile"]'], ['custom width', '#lab-w'], ['view', '[data-lab-mode="compare"]'], ['navigation', '[data-lab-nav="component-next"]']];
  // Focus each target in turn, remount, and say where focus went. Never reads the Lab's own state: only the page.
  // Give `sel` focus and confirm it holds it: the application's late repaint can take focus away between the call and the check.
  // At most one retry, after the room has settled. Returns how many retries it took (0 or 1), or -1 if focus could not be held,
  // in which case nothing may be measured: BODY before and BODY after is not evidence of anything.
  async function holdFocus(page, sel) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await settled(page);
      try { await page.focus(sel); } catch (_) { continue; }
      if (await page.evaluate((q) => !!document.activeElement && document.activeElement.matches(q), sel)) return attempt;
    }
    return -1;
  }
  async function focusTrials(page) {
    await page.keyboard.press('/'); await page.keyboard.type('chip'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await frames(page);
    const trials = [];
    for (const [label, sel] of FOCUS_TARGETS) {
      if (!(await page.$(sel))) { trials.push({ label, applied: false, ok: false, why: 'control not applied: target not found' }); continue; }
      const held = await holdFocus(page, sel);
      if (held < 0) { trials.push({ label, applied: false, ok: false, why: 'control not applied: the target could not be given focus, so there was no focus to lose' }); continue; }
      const before = await activeKey(page);
      const remounted = await remount(page);
      const after = await activeKey(page);
      trials.push({ label, applied: true, retried: held, before, after, remounted, ok: remounted && before === after });
      if (label === 'direction') await page.evaluate(() => { const b = document.querySelector('[data-lab-dir="ltr"]'); if (b) b.click(); });
    }
    return trials;
  }
  // A remount long after the last focus is a visit: focus must not be pulled to a control the reader left 2.5 s ago.
  async function staleRemount(page) {
    await page.focus('#lab-q'); await page.waitForTimeout(3000);
    await page.evaluate(() => document.activeElement.blur());
    const remounted = await remount(page);
    const key = await activeKey(page);
    const inLab = await page.evaluate(() => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.lab')));
    return { remounted, key, kept: remounted && !inLab };
  }

  // ══ 1. the server boundary ═════════════════════════════════════════════════
  if (want('1')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 });
    const before = log.requests.filter(([, p]) => /design-system\/lab|components\/preview/.test(p)).length;
    check('lazy: nothing of the Lab is requested before its section opens', before === 0, { requests: before });
    const mark = log.requests.length;
    await openLab(page);
    const after = log.requests.slice(mark).filter(([, p]) => !/^\/(i18n|tokens)\//.test(p));
    const lab = after.filter(([, p]) => /design-system\/lab|components\/preview|design-system\/components$/.test(p));
    check('lazy: opening the Lab fetches its own stylesheet, sanitizer, view maths, script and exactly three GETs', lab.length === 7 && lab.every(([m]) => m === 'GET'), lab.map((x) => x[0] + ' ' + x[1]));
    check('lazy: the production app is not loaded again', !after.some(([, p]) => /^\/app\.(js|css)/.test(p)), { appRequests: after.filter(([, p]) => /^\/app\./.test(p)).length });
    const foreign = log.requests.filter((x) => x[2] !== BASE && !/^https:\/\/fonts\.(googleapis|gstatic)\.com$/.test(x[2]));
    check('no request leaves the origin (the application\'s own web-font links aside; the test aborts them)', foreign.length === 0, { foreign });
    check('no request is anything but a GET for the Lab', after.filter(([, p]) => /preview|components/.test(p)).every(([m]) => m === 'GET'));

    // CSP: the response header is the existing one, and nothing violated it.
    const csp = await page.evaluate(() => fetch('/', { credentials: 'same-origin' }).then((r) => r.headers.get('content-security-policy')));
    check('csp: the existing policy is served unchanged: frames forbidden, no inline script or style', !!csp && /frame-src 'none'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && !/'unsafe-(inline|eval)'/.test(csp.replace(/style-src[^;]*/, '')) && !/style-src[^;]*'unsafe-inline'/.test(csp), csp);
    const violations = await page.evaluate(() => window.__csp);
    check('csp: no violation comes from the Lab (the application\'s own pre-existing inline styles are counted apart)', violations.filter((v) => v.inLab || !/^style-src-attr$/.test(v.d)).length === 0, { fromLab: violations.filter((v) => v.inLab).length, otherThanApplicationInlineStyle: violations.filter((v) => !/^style-src-attr$/.test(v.d)).length, applicationInlineStyle: violations.filter((v) => /^style-src-attr$/.test(v.d) && !v.inLab).length });
    check('csp: no page error and no console error', log.errors.length === 0, log.errors);
    check('no iframe, frame, object or embed exists anywhere in the page', await page.evaluate(() => document.querySelectorAll('iframe,frame,object,embed').length === 0));
    await ctx.close();
  }

  // ══ 2. the stage boundaries ════════════════════════════════════════════════
  if (want('2')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 });
    const modalBefore = await page.evaluate(() => document.querySelectorAll('[aria-modal]').length);
    await openLab(page);

    // the overlay fixture
    await page.click('[data-lab-id="lg-float"]');
    await page.waitForSelector('#lab-specimen .lg-float-bg', { timeout: 15000 });
    await page.waitForTimeout(200);

    // ── layout: a position:fixed overlay is anchored to, and clipped by, the stage
    const geo = await page.evaluate(() => {
      const spec = document.getElementById('lab-specimen').getBoundingClientRect();
      const bg = document.querySelector('#lab-specimen .lg-float-bg');
      const r = bg.getBoundingClientRect();
      const cs = getComputedStyle(bg);
      return { position: cs.position, zIndex: cs.zIndex, spec: [spec.left, spec.top, spec.right, spec.bottom].map(Math.round), bg: [r.left, r.top, r.right, r.bottom].map(Math.round), viewport: [innerWidth, innerHeight], contain: getComputedStyle(document.getElementById('lab-specimen')).contain };
    });
    const inside = geo.bg[0] >= geo.spec[0] - 1 && geo.bg[1] >= geo.spec[1] - 1 && geo.bg[2] <= geo.spec[2] + 1 && geo.bg[3] <= geo.spec[3] + 1;
    check('layout: the lg-float overlay really is position:fixed with z-index 2400', geo.position === 'fixed' && geo.zIndex === '2400', geo);
    check('layout: that overlay is anchored to the stage and lies inside it', inside, geo);
    const covers = await page.evaluate(() => {
      const probes = ['#lab-rail-body', '.ds-nav, .ds-rail, [data-ds-nav="overview"]', '#lab-insp', '[data-ds-nav="components"]'];
      return probes.map((sel) => { const el = document.querySelector(sel); if (!el) return [sel, 'missing']; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 24)); return [sel, !!top && (el === top || el.contains(top))]; });
    });
    check('layout: the overlay does not cover the rail, the inspector or the room navigation', covers.every(([, ok]) => ok === true), covers);
    // control: take the containment away and the same overlay covers the whole window
    const control = await page.evaluate(() => {
      // Both walls go: the specimen's own and, since M2 / S1, the viewport around it.
      const walls = [document.getElementById('lab-specimen'), document.getElementById('lab-viewport')].filter(Boolean);
      const keep = walls.map((w) => [w.style.getPropertyValue('contain'), w.style.getPropertyValue('isolation')]);
      for (const w of walls) { w.style.setProperty('contain', 'none'); w.style.setProperty('isolation', 'auto'); }
      const r = document.querySelector('#lab-specimen .lg-float-bg').getBoundingClientRect();
      const out = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
      walls.forEach((w, n) => {
        for (const [k, prop] of [[0, 'contain'], [1, 'isolation']]) { if (keep[n][k]) w.style.setProperty(prop, keep[n][k]); else w.style.removeProperty(prop); }
      });
      return { without: out, viewport: [innerWidth, innerHeight], walls: walls.length };
    });
    check('layout (control): without containment (the specimen\'s and the viewport\'s) the same overlay fills the whole window', control.walls === 2 && control.without[0] <= 0 && control.without[1] <= 0 && control.without[2] >= control.viewport[0] - 24 && control.without[3] >= control.viewport[1] - 2, control);
    await page.screenshot({ path: path.join(OUT, 'proof-overlay-contained.png') });

    // ── events: nothing that starts in the specimen reaches a document-level handler
    const TYPES = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'contextmenu', 'focusin', 'focusout'];
    await page.evaluate((types) => {
      window.__seen = { inside: {}, outside: {} };
      const spec = document.getElementById('lab-specimen');
      const rec = (e) => { const k = spec.contains(e.target) ? 'inside' : 'outside'; window.__seen[k][e.type] = (window.__seen[k][e.type] || 0) + 1; };
      for (const t of types) { document.addEventListener(t, rec); window.addEventListener(t, rec); document.documentElement.addEventListener(t, rec); document.body.addEventListener(t, rec); }
    }, TYPES);
    // control: an ordinary click outside the specimen IS seen by those listeners
    await page.click('[data-lab-tab="source"]');
    const seenOutside = await page.evaluate(() => window.__seen.outside.click || 0);
    check('events (control): a click outside the specimen reaches document, html and body listeners', seenOutside >= 3, { clicks: seenOutside });
    // real input, aimed at the specimen
    const target = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return b ? [b.x + b.width / 2, b.y + b.height / 2] : null; };
    const closeBtn = await target('#lab-specimen .lg-float-x');
    const dialog = await target('#lab-specimen .lg-float');
    const backdrop = await page.evaluate(() => { const r = document.getElementById('lab-specimen').getBoundingClientRect(); return [r.left + 24, r.top + 24]; });
    for (const p of [closeBtn, dialog, backdrop]) { if (!p) continue; await page.mouse.move(p[0], p[1]); await page.mouse.down(); await page.mouse.up(); await page.mouse.click(p[0], p[1], { button: 'right' }); await page.mouse.dblclick(p[0], p[1]); }
    await page.focus('#lab-specimen .lg-float-x');                    // programmatic focus: a specimen button is out of the tab order, not unfocusable
    for (const k of ['Enter', 'Space', 'Escape', 'ArrowDown', 'a']) await page.keyboard.press(k);
    const seen = await page.evaluate(() => window.__seen);
    check('events: no document, window, html or body listener sees anything that started inside the specimen', Object.keys(seen.inside).length === 0, seen.inside);
    // injected control: a hostile element carrying the attribute production listens for, clicked for real
    const hostile = await page.evaluate(() => {
      const spec = document.getElementById('lab-specimen');
      const el = document.createElement('button');
      el.setAttribute('data-action', 'closeFloat'); el.setAttribute('data-nav', 'x'); el.setAttribute('data-close-modal', 'x'); el.textContent = 'hostile';
      spec.querySelector('.lab-col').appendChild(el);
      return true;
    });
    const hb = await target('#lab-specimen button[data-action="closeFloat"]');
    if (hostile && hb) { await page.mouse.click(hb[0], hb[1]); await page.keyboard.press('Escape'); }
    const seen2 = await page.evaluate(() => window.__seen.inside);
    check('events: even an element carrying data-action, clicked for real, never reaches a document-level handler', Object.keys(seen2).length === 0, seen2);
    check('events: the room is still where it was (no production handler closed, opened or navigated anything)', await page.evaluate(() => location.hash === '#design-system' && !!document.querySelector('#lab-specimen .lg-float-bg') && !document.querySelector('body > .lg-float-bg')));
    await page.evaluate(() => document.querySelector('#lab-specimen button[data-action="closeFloat"]')?.remove());

    // ── what the sanitizer removed is really gone from the page
    const dom = await page.evaluate(() => {
      const spec = document.getElementById('lab-specimen');
      const all = [...spec.querySelectorAll('*')];
      const attrs = new Set(); all.forEach((e) => [...e.attributes].forEach((a) => attrs.add(a.name)));
      return {
        dataAction: spec.querySelectorAll('[data-action]').length, ariaModal: document.querySelectorAll('[aria-modal]').length, ariaModalInside: spec.querySelectorAll('[aria-modal]').length, role: [...spec.querySelectorAll('[role]')].map((e) => e.getAttribute('role')), i18nAria: spec.querySelectorAll('[data-i18n-aria]').length,
        eventAttrs: [...attrs].filter((n) => /^on/i.test(n)), scripts: spec.querySelectorAll('script,style,link,iframe,object,embed,form,a,input,textarea,select').length,
        buttons: [...spec.querySelectorAll('button')].map((b) => b.getAttribute('tabindex')),
        styleAttrsOutsideCssom: all.filter((e) => e.hasAttribute('style') && !e.hasAttribute('data-mc-width') && !e.hasAttribute('data-lg-size')).length,
        attrs: [...attrs].sort(),
      };
    });
    check('sanitizer: no data-action, data-i18n-aria or aria-modal in the specimen, and the page has no more aria-modal than before the Lab opened', dom.dataAction === 0 && dom.ariaModalInside === 0 && dom.i18nAria === 0 && dom.ariaModal === modalBefore, { ...dom, modalBefore });
    check('sanitizer: no event attribute, script, style, link, frame, form, anchor or input in the specimen', dom.eventAttrs.length === 0 && dom.scripts === 0, dom);
    check('sanitizer: every button in the specimen is out of the tab order', dom.buttons.length > 0 && dom.buttons.every((t) => t === '-1'), dom.buttons);

    // ── keyboard: Tab never walks into the specimen
    await page.focus('.lab-fx.is-on');
    const path_ = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); path_.push(await page.evaluate(() => { const a = document.activeElement; return [a.tagName, !!a.closest('#lab-specimen')]; })); }
    check('keyboard: six Tab presses from the fixture strip never land inside the specimen', path_.every(([, inSpec]) => inSpec === false), path_);

    // ── translation: the application's translator leaves the specimen exactly as recorded
    // The application translates in two ways: a catalogue pass that swaps any text node whose English is
    // a catalogue key (I18N_DOM), and a bundle pass over data-i18n* attributes (I18N_APPLY). The first is
    // kept out by data-no-i18n on the stage; the second can never find anything, because the sanitizer
    // admits no data-i18n* attribute at all.
    const tr = await page.evaluate(async () => {
      if (!window.I18N_DOM) return { skipped: 'the application translator is not on this page' };
      const cat = await fetch('/i18n/catalogue/de-DE.json').then((r) => r.json());
      const key = Object.keys(cat).find((k) => /^[A-Z][a-z]{4,12}$/.test(k) && typeof cat[k] === 'string' && cat[k] !== k && cat[k].indexOf('%') < 0);
      if (!key) return { skipped: 'no suitable catalogue key in de-DE' };
      const tag = await window.I18N_DOM.setLocale('de-DE');
      const spec = document.querySelector('#lab-specimen .lab-col');
      const inside = document.createElement('span'); inside.textContent = key; spec.appendChild(inside);
      const outside = document.createElement('span'); outside.textContent = key; document.body.appendChild(outside);   // outside the room, where the translator does work
      window.I18N_DOM.translateTree(document.body);
      await new Promise((r) => setTimeout(r, 400));
      const out = { locale: tag, key, expected: cat[key], inside: inside.textContent, outside: outside.textContent };
      inside.remove(); outside.remove();
      await window.I18N_DOM.setLocale('en-GB');
      return out;
    });
    if (tr.skipped) skip('i18n: the application translator leaves the specimen as recorded', tr.skipped);
    else if (tr.outside === tr.key) skip('i18n: the application translator leaves the specimen as recorded', 'inconclusive: the control did not translate the same text outside the stage (' + JSON.stringify(tr) + ')');
    else check('i18n: the catalogue pass translated the same text outside the stage and left it alone inside it', tr.inside === tr.key && tr.outside === tr.expected, tr);
    check('i18n: no data-i18n, data-i18n-title, data-i18n-placeholder or data-i18n-aria exists in the specimen, so the bundle pass has nothing to find', await page.evaluate(() => document.querySelectorAll('#lab-specimen [data-i18n],#lab-specimen [data-i18n-title],#lab-specimen [data-i18n-placeholder],#lab-specimen [data-i18n-aria]').length === 0));

    // ── nothing it draws reaches the rest of the page
    await page.click('[data-lab-id="lg-versus"]'); await page.waitForSelector('#lab-specimen .lg-vs-row'); await frames(page);
    const outsideLg = () => page.evaluate(() => [...document.querySelectorAll('[class*="lg-"],[data-lg-size],[data-mc-width]')].filter((e) => !e.closest('#lab-specimen')).length);
    const base = await outsideLg();
    await page.click('[data-lab-id="lg-float"]'); await page.waitForSelector('#lab-specimen .lg-float-bg'); await frames(page);
    const sheets = await page.evaluate(() => ({ styleSheets: document.styleSheets.length, adopted: (document.adoptedStyleSheets || []).length, headChildren: document.head.children.length, bodyClass: document.body.className, htmlAttrs: [...document.documentElement.attributes].map((a) => a.name + '=' + a.value).sort().join(' ') }));
    await page.click('[data-lab-id="lg-panel"]'); await page.waitForSelector('#lab-specimen .lg-panel'); await frames(page);
    const sheets2 = await page.evaluate(() => ({ styleSheets: document.styleSheets.length, adopted: (document.adoptedStyleSheets || []).length, headChildren: document.head.children.length, bodyClass: document.body.className, htmlAttrs: [...document.documentElement.attributes].map((a) => a.name + '=' + a.value).sort().join(' ') }));
    check('isolation: switching fixtures adds no stylesheet, no style element, no adopted sheet, and changes no class or attribute of html or body', JSON.stringify(sheets) === JSON.stringify(sheets2), { first: sheets, second: sheets2 });
    check('isolation: no production lg-* node, data-lg-size or data-mc-width exists outside the stage', (await outsideLg()) === base, { before: base, after: await outsideLg() });
    await page.click('[data-lab-id="lg-versus"]'); await page.waitForSelector('#lab-specimen .lg-vs-row'); await frames(page);
    const bars = await page.evaluate(() => [...document.querySelectorAll('#lab-specimen [data-mc-width]')].map((e) => [e.getAttribute('data-mc-width'), e.style.width]));
    check('rendering: bar widths are applied through the CSSOM and match their data attribute', bars.length > 0 && bars.every(([a, b]) => a === b), bars.slice(0, 4));

    await page.screenshot({ path: path.join(OUT, 'proof-versus.png') });
    const v2 = await page.evaluate(() => window.__csp);
    check('csp: still no violation from the Lab after every interaction above', v2.filter((v) => v.inLab || !/^style-src-attr$/.test(v.d)).length === 0, { fromLab: v2.filter((v) => v.inLab).length, other: v2.filter((v) => !/^style-src-attr$/.test(v.d)).length });
    check('no page error after every interaction above', log.errors.length === 0, log.errors);
    await ctx.close();
  }

  // ══ 2b. the keyboard, with real key presses ═══════════════════════════════
  if (want('2b')) {
    const { ctx, page } = await open({ width: 1440, height: 900 });
    await openLab(page);
    const active = () => page.evaluate(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id, lab: a.getAttribute('data-lab-id') || a.getAttribute('data-lab-grp') || a.getAttribute('data-lab-fx') || a.getAttribute('data-lab-tab') || a.getAttribute('data-lab-dir') } : null; });
    const metrics = () => page.evaluate(() => window.__familistaLabMetrics());
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/');
    check('keyboard: "/" focuses the search from anywhere in the Lab', (await active()).id === 'lab-q');
    await page.keyboard.type('chip'); await page.waitForTimeout(150);
    const shown = await page.evaluate(() => [...document.querySelectorAll('#lab-rail-body [data-lab-id]')].filter((b) => !b.closest('ul').hidden).map((b) => b.getAttribute('data-lab-id')));
    check('keyboard: typing narrows the rail to what matches', shown.includes('lg-chip') && shown.includes('lg-status-chip') && !shown.includes('lg-crest'), shown);
    await page.keyboard.press('ArrowDown');
    const a1 = await active();
    check('keyboard: ArrowDown from the search lands on the rail', !!a1.lab, a1);
    await page.keyboard.press('ArrowDown');
    // The component Enter must select is the one focus is on now: a previewable component among those the search left, as the
    // manifest says, not a name written here.
    const a2 = await active();
    const previewable = await page.evaluate(async () => (await window.__familistaDesignSystemKit.api('/system/design-system/components/preview')).availability.filter((x) => x.state === 'preview').map((x) => x.id));
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    const m1 = await metrics();
    check('keyboard: Enter on a rail item selects it and shows its first fixture', !!a2.lab && shown.includes(a2.lab) && previewable.includes(a2.lab) && m1.selected === a2.lab && /\.\w/.test(m1.fixture), { focused: a2.lab, selected: m1.selected, fixture: m1.fixture });
    await page.keyboard.press('Escape');
    check('keyboard: Escape in the search clears it', await page.evaluate(() => document.getElementById('lab-q').value === '') || (await active()).id !== 'lab-q');
    await page.focus('#lab-q'); await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    const registered = await page.evaluate(async () => (await window.__familistaDesignSystemKit.api('/system/design-system/components/preview')).availability.length);
    check('keyboard: Escape clears the search and the whole list returns', (await page.evaluate(() => [...document.querySelectorAll('#lab-rail-body [data-lab-id]')].length)) === registered);
    await page.click('[data-lab-id="lg-status-chip"]'); await page.waitForSelector('#lab-specimen .lg-chip'); 
    const ids = await page.evaluate(() => [...document.querySelectorAll('.lab-fx')].map((b) => b.getAttribute('data-lab-fx')));
    await page.focus('.lab-fx.is-on');
    await page.keyboard.press('ArrowRight'); const f2 = (await metrics()).fixture;
    await page.keyboard.press('End'); const fEnd = (await metrics()).fixture;
    await page.keyboard.press('Home'); const fHome = (await metrics()).fixture;
    check('keyboard: ArrowRight, End and Home move through the fixtures, and focus follows', f2 === ids[1] && fEnd === ids[ids.length - 1] && fHome === ids[0], { f2, fEnd, fHome, count: ids.length });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press(']'); const fNext = (await metrics()).fixture;
    await page.keyboard.press('['); const fPrev = (await metrics()).fixture;
    check('keyboard: "]" and "[" step through the fixtures from anywhere outside a text field', fNext === ids[1] && fPrev === ids[0], { fNext, fPrev });
    const live = await page.evaluate(() => document.getElementById('lab-live').textContent);
    check('a11y: the fixture change is announced in a polite live region', /Fixture \d+ of \d+/.test(live), live);
    // inspector tabs
    await page.focus('#lab-itab-provenance'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('End');
    check('keyboard: the inspector tabs answer ArrowRight and End', (await page.evaluate(() => document.querySelector('#lab-insp [role="tab"][aria-selected="true"]').getAttribute('data-lab-tab'))) === 'variants');
    // visible focus, from the keyboard (:focus-visible)
    const rings = [];
    for (const sel of ['#lab-q', '#lab-rail-body [tabindex="0"]', '.lab-fx.is-on', '#lab-itab-variants', '[data-lab-dir="ltr"]']) {
      await page.focus(sel); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      rings.push([sel, await page.evaluate(() => { const a = document.activeElement; const c = getComputedStyle(a); return [c.outlineStyle, c.outlineWidth, a.matches(':focus-visible')]; })]);
    }
    check('a11y: every control reached with the keyboard shows a visible focus ring', rings.every(([, [style, w, fv]]) => fv && style !== 'none' && parseFloat(w) >= 2), rings);
    // reduced motion
    const rm = await page.evaluate(() => [...document.querySelectorAll('.lab-fx,.lab-tab,.lab-item')].slice(0, 6).map((e) => getComputedStyle(e).transitionDuration));
    check('a11y: with prefers-reduced-motion the Lab animates nothing', rm.every((d) => /^0s(, 0s)*$/.test(d)), rm);
    await ctx.close();
  }

  // ══ 3. a hostile fixture, drawn by the real client ═════════════════════════
  if (want('3')) {
    const { ctx, page } = await open({ width: 1440, height: 900 });
    await page.route('**/api/v1/system/design-system/components/preview?id=lg-chip', async (route) => {
      const resp = await route.fetch(); const body = await resp.json();
      const f = body.data.component.fixtures[0];
      f.html = '<span class="lg-chip"><span>x</span><img src="https://example.invalid/p.png"><b onclick="window.__pwned=1">y</b></span>';
      await route.fulfill({ response: resp, json: body });
    });
    await openLab(page);
    await page.click('[data-lab-id="lg-chip"]');
    await page.waitForSelector('#lab-refuse:not([hidden])', { timeout: 15000 });
    const r = await page.evaluate(() => ({ nodes: document.getElementById('lab-specimen').getElementsByTagName('*').length, pwned: window.__pwned === 1, refusal: document.getElementById('lab-refuse').textContent.slice(0, 140) }));
    check('fail closed: a fixture the browser refuses draws nothing, runs nothing and says why', r.nodes === 0 && !r.pwned && /browser/.test(r.refusal), r);
    await ctx.close();
  }

  // ══ 4. measurement ═════════════════════════════════════════════════════════
  if (want('4')) {
    const { ctx, page } = await open({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      window.__cls = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__cls.push({ v: e.value, nodes: (e.sources || []).map((s) => s.node && s.node.nodeType === 1 ? !!s.node.closest('.lab') : null) }))).observe({ type: 'layout-shift', buffered: true }); } catch (_) { /* not supported */ }
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.ds-metric', { timeout: 30000 });
    const t0 = Date.now();
    await page.click('[data-ds-nav="lab"]');
    await page.waitForSelector('#lab-specimen .lab-col'); await frames(page);
    const openMs = Date.now() - t0;
    const client = await ctx.newCDPSession(page);
    await client.send('Performance.enable');
    const metric = async (name) => (await client.send('Performance.getMetrics')).metrics.find((m) => m.name === name).value;
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-lab-id]:not([aria-disabled])')].map((b) => b.getAttribute('data-lab-id')));
    const times = []; const nodeCounts = [];
    const labNodes = () => page.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
    await page.click(`[data-lab-id="${ids[0]}"]`); await frames(page);
    const domBefore = await labNodes();
    await client.send('HeapProfiler.enable'); await client.send('HeapProfiler.collectGarbage');
    const heap0 = await metric('JSHeapUsedSize');
    for (let pass = 0; pass < 3; pass++) {
      for (const id of ids) {
        await page.click(`[data-lab-id="${id}"]`);
        await page.waitForFunction((i) => window.__familistaLabMetrics().selected === i && document.querySelector('#lab-specimen') && window.__familistaLabMetrics().fixture, id);
        const n = await page.evaluate(() => document.querySelectorAll('.lab-fx').length);
        for (let i = 0; i < n; i++) {
          const ms = await page.evaluate((idx) => new Promise((resolve) => {
            const b = document.querySelectorAll('.lab-fx')[idx]; const a = performance.now(); b.click();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve([performance.now() - a, document.getElementById('lab-specimen').getElementsByTagName('*').length])));
          }), i);
          times.push(ms[0]); nodeCounts.push(ms[1]);
        }
      }
    }
    await client.send('HeapProfiler.collectGarbage');
    const heap1 = await metric('JSHeapUsedSize');
    await page.click(`[data-lab-id="${ids[0]}"]`); await frames(page);
    await page.click('.lab-fx >> nth=0'); await frames(page);
    const domAfter = await labNodes();
    const cls = await page.evaluate(() => window.__cls);
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)] * 10) / 10; };
    const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10; };
    const labShift = cls.filter((e) => e.nodes.some((x) => x === true)).reduce((s, e) => s + e.v, 0);
    console.log('MEASURE ' + JSON.stringify({
      openToPaintMs: openMs, fixturesSwitched: times.length, switchToFrameMedianMs: med(times), switchToFrameP95Ms: p95(times), switchToFrameMaxMs: Math.round(Math.max(...times)),
      specimenNodesMax: Math.max(...nodeCounts), domBefore, domAfter, heapGrowthKB: Math.round((heap1 - heap0) / 1024), layoutShiftInLab: labShift, layoutShiftEntries: cls.length,
      labMetrics: await page.evaluate(() => window.__familistaLabMetrics()),
    }));
    check('stability: after switching through every fixture three times the Lab holds exactly as many nodes as before', domAfter === domBefore, { domBefore, domAfter });
    check('stability: no layout shift in the Lab while switching component and fixture', labShift === 0, { labShift, entries: cls.length });
    await ctx.close();
  }

  // ══ 5. the server's side of the same boundary ══════════════════════════════
  if (want('5')) {
    const get = (p, tok) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: 47932, path: p, method: 'GET', headers: tok ? { authorization: 'Bearer ' + tok } : {} }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve([res.statusCode, b, res.headers])); });
      req.end();
    });
    const coach = signToken('access', { sub: COACH.id, role: COACH.role }, { expiresIn: '10m' });
    CURRENT = COACH;
    const [s1] = await get('/api/v1/system/design-system/components/preview');
    const [s2, b2] = await get('/api/v1/system/design-system/components/preview?id=lg-chip', coach);
    CURRENT = OWNER;
    const [s3, b3, h3] = await get('/api/v1/system/design-system/components/preview?id=lg-chip', token);
    check('api: unauthenticated is 401, a club role is 403 and sees no fixture, the owner is 200 and not cacheable', s1 === 401 && s2 === 403 && !/lg-chip\./.test(b2) && s3 === 200 && h3['cache-control'] === 'no-store', { s1, s2, s3 });
    check('api: the manifest is not a public file', (await get('/design-system/design-system-previews.json'))[0] !== 200 && (await get('/generated/design-system-previews.json'))[0] !== 200);
    void b3;
  }

  // ══ 8. zoom (M2 / S1): the stage's walls hold at every scale ═════════════════
  // The specimen is scaled with a transform. A transform is a containing block of its own, so it should not let a fixed
  // overlay out; that is a claim, and so is "nothing outside the stage moves". Each is measured at 25%, 50% and 200%.
  if (want('8')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
    await openLab(page, SETTLE);
    await page.click('[data-lab-id="lg-float"]');
    await page.waitForSelector('#lab-specimen .lg-float-bg'); await frames(page);
    const zoomTo = async (pct) => {
      await page.click('[data-lab-zoom="reset"]', { force: true });
      const dir = pct < 100 ? 'out' : 'in';
      for (let n = 0; n < 12 && Number((await page.textContent('#lab-zoom-v')).replace(/[^0-9]/g, '')) !== pct; n++) await page.click(`[data-lab-zoom="${dir}"]`, { force: true });
      await frames(page);
      return Number((await page.textContent('#lab-zoom-v')).replace(/[^0-9]/g, ''));
    };
    const geom = () => page.evaluate(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const spec = document.getElementById('lab-specimen');
      const m = getComputedStyle(spec).transform;
      return {
        viewport: r(document.getElementById('lab-viewport')), frame: r(document.getElementById('lab-frame')), canvas: r(spec),
        overlay: r(document.querySelector('#lab-specimen .lg-float-bg')), dialog: r(document.querySelector('#lab-specimen .lg-float')),
        rail: r(document.querySelector('.lab-rail')), insp: r(document.getElementById('lab-insp')), plate: r(document.getElementById('lab-plate')),
        tools: r(document.querySelector('.lab-tools')), transform: m, scale: m === 'none' ? 1 : Number(m.split('(')[1].split(',')[0]),
      };
    });
    const at100 = await geom();
    check('zoom: at 100% nothing is transformed, so the unzoomed stage is exactly the M1 stage', at100.transform === 'none' && inside(at100.overlay, at100.canvas), at100);

    for (const pct of [25, 50, 200]) {
      const got = await zoomTo(pct);
      const g = await geom();
      // whatever is larger than the stage is clipped by it: just outside each edge of the viewport, inside the overlay's own
      // (unclipped) rectangle, the element on screen is never part of the specimen
      const clip = await page.evaluate(() => {
        const vp = document.getElementById('lab-viewport').getBoundingClientRect(), spec = document.getElementById('lab-specimen');
        const pts = [[vp.right + 6, vp.top + 30], [vp.left + 30, vp.bottom + 6], [vp.right + 6, vp.bottom + 6], [vp.left - 6, vp.top + 30], [vp.left + 30, vp.top - 6]];
        return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return [Math.round(x), Math.round(y), !!e && spec.contains(e)]; });
      });
      const hits = await page.evaluate(() => [...document.querySelectorAll('[data-lab-zoom], [data-lab-dir]')].map((b) => {
        const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return [b.getAttribute('data-lab-zoom') || b.getAttribute('data-lab-dir'), !!e && (e === b || b.contains(e))];
      }));
      check(`zoom ${pct}%: the specimen is scaled to ${pct}%, its fixed overlay stays inside the scaled canvas, and ${pct < 100 ? 'inside the stage\'s viewport' : 'whatever reaches past the viewport is clipped by it'}`,
        got === pct && Math.abs(g.scale - pct / 100) < 0.005 && inside(g.overlay, g.canvas) && (pct < 100 ? inside(g.overlay, g.viewport) : true) && clip.every((c) => !c[2]), { got, clip, ...g });
      check(`zoom ${pct}%: the overlay covers no tool: every zoom and direction button is the element under its own centre`, hits.length === 6 && hits.every((h) => h[1]), hits);
      check(`zoom ${pct}%: nothing outside the stage moved: the rail, the inspector, the tools and the plate are where they were at 100%`,
        JSON.stringify([g.rail, g.insp, g.tools, g.plate]) === JSON.stringify([at100.rail, at100.insp, at100.tools, at100.plate]), { now: [g.rail, g.insp, g.tools, g.plate], at100: [at100.rail, at100.insp, at100.tools, at100.plate] });
    }

    // control: take away both walls and the transform, at 50%, and the same overlay covers the window
    await zoomTo(50);
    const escaped = await page.evaluate(() => {
      const vp = document.getElementById('lab-viewport'), spec = document.getElementById('lab-specimen'), fr = document.getElementById('lab-frame');
      for (const el of [vp, spec, fr]) { el.style.setProperty('contain', 'none'); el.style.setProperty('isolation', 'auto'); el.style.setProperty('overflow', 'visible'); }
      spec.style.setProperty('transform', 'none');
      const b = document.querySelector('#lab-specimen .lg-float-bg').getBoundingClientRect();
      return { overlay: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], window: [innerWidth, innerHeight] };
    });
    check('zoom (control): with the containment and the transform removed, the same overlay at 50% fills the whole window', escaped.overlay[0] <= 0 && escaped.overlay[1] <= 0 && escaped.overlay[2] >= escaped.window[0] - 24 && escaped.overlay[3] >= escaped.window[1] - 2, escaped);
    await ctx.close();

    // events at 25% and 200%, in a fresh page
    {
      const { ctx: c2, page: p2, log: log2 } = await open({ width: 1440, height: 900 }, 'en');
      await openLab(p2, SETTLE);
      await p2.click('[data-lab-id="lg-float"]'); await p2.waitForSelector('#lab-specimen .lg-float-bg');
      await p2.evaluate((types) => {
        window.__seen = { inside: {}, outside: {} };
        const rec = (e) => { const spec = document.getElementById('lab-specimen'); const k = spec && spec.contains(e.target) ? 'inside' : 'outside'; window.__seen[k][e.type] = (window.__seen[k][e.type] || 0) + 1; };
        for (const t of types) { document.addEventListener(t, rec); window.addEventListener(t, rec); document.body.addEventListener(t, rec); }
      }, ['click', 'mousedown', 'pointerdown', 'mouseup', 'pointerup', 'dblclick', 'contextmenu', 'keydown', 'keyup']);
      const results = [];
      for (const dir of ['out', 'in']) {
        await p2.click('[data-lab-zoom="reset"]', { force: true });
        for (let n = 0; n < (dir === 'out' ? 7 : 5); n++) await p2.click(`[data-lab-zoom="${dir}"]`, { force: true });
        await frames(p2);
        const pct = (await p2.textContent('#lab-zoom-v')).trim();
        for (const sel of ['#lab-specimen .lg-float-x', '#lab-specimen .lg-float']) {
          const b = await p2.locator(sel).first().boundingBox();
          if (!b) continue;
          const x = b.x + Math.min(b.width / 2, 8), y = b.y + Math.min(b.height / 2, 8);
          await p2.mouse.click(x, y); await p2.mouse.dblclick(x, y); await p2.mouse.click(x, y, { button: 'right' });
        }
        await p2.focus('#lab-specimen .lg-float-x');
        for (const k of ['Enter', 'Escape', 'Minus', 'Equal', 'Digit0']) await p2.keyboard.press(k);
        results.push([pct, (await p2.textContent('#lab-zoom-v')).trim()]);
      }
      const seen = await p2.evaluate(() => window.__seen);
      check('zoom: at 25% and 200% nothing that starts inside the scaled specimen reaches a document, window or body listener, and a zoom key pressed inside the specimen stays inside it',
        Object.keys(seen.inside).length === 0 && results.every(([a, b]) => a === b), { inside: seen.inside, zoomKeptWhileFocusInside: results });
      await p2.click('[data-lab-zoom="reset"]', { force: true });
      const outside = await p2.evaluate(() => window.__seen.outside.click || 0);
      check('zoom (control): a click on a zoom button, outside the specimen, is seen by those listeners', outside >= 3, { clicks: outside });

      // keys: plain keys zoom; with Ctrl, Cmd or Alt they are the browser's and are not touched
      await blur(p2);
      const read = async () => (await p2.textContent('#lab-zoom-v')).trim();
      await p2.keyboard.press('Equal'); const k1 = await read();
      await p2.keyboard.press('Minus'); const k2 = await read();
      await p2.keyboard.press('Minus'); const k3 = await read();
      await p2.keyboard.press('Digit0'); const k4 = await read();
      const browserKeys = await p2.evaluate(() => {
        const out = [];
        for (const mod of ['ctrlKey', 'metaKey', 'altKey']) for (const key of ['=', '-', '0', '+']) {
          const e = new KeyboardEvent('keydown', { key, [mod]: true, bubbles: true, cancelable: true });
          document.body.dispatchEvent(e);
          out.push([mod, key, e.defaultPrevented, document.getElementById('lab-zoom-v').textContent.trim()]);
        }
        return out;
      });
      check('zoom: "=", "-" and "0" zoom in, out and back to 100% from the keyboard', k1 === '110%' && k2 === '100%' && k3 === '90%' && k4 === '100%', [k1, k2, k3, k4]);
      check('zoom: with Ctrl, Cmd or Alt the same keys are left to the browser: not prevented, and the stage does not zoom', browserKeys.every((b) => b[2] === false && b[3] === '100%'), browserKeys);
      await p2.focus('#lab-q'); await p2.keyboard.press('Equal'); await p2.keyboard.press('Digit0');
      const typed = await p2.evaluate(() => [document.getElementById('lab-q').value, document.getElementById('lab-zoom-v').textContent.trim()]);
      check('zoom: typing "=" or "0" in the search types it, and does not zoom', typed[0] === '=0' && typed[1] === '100%', typed);
      await p2.fill('#lab-q', ''); await blur(p2);
      for (let n = 0; n < 12; n++) await p2.keyboard.press('Minus');
      const floor = await p2.evaluate(() => [document.getElementById('lab-zoom-v').textContent.trim(), document.querySelector('[data-lab-zoom="out"]').getAttribute('aria-disabled'), document.activeElement === document.body]);
      check('zoom: the floor is 25%, Zoom out says it is disabled there, and nothing lost focus on the way', floor[0] === '25%' && floor[1] === 'true', floor);
      const split = await cspSplit(p2);
      check('zoom: no Lab or unexplained CSP violation, and no console error, after every zoom above', split.lab === 0 && split.unexplained === 0 && labErrors(log2).length === 0, { csp: split, errors: labErrors(log2) });
      await c2.close();
    }

    // fit: every previewable component, never above 100%, and the whole specimen visible without scrolling
    {
      const { ctx: c3, page: p3, log: log3 } = await open({ width: 1100, height: 760 }, 'en');
      await openLab(p3, SETTLE);
      const ids = await p3.evaluate(() => [...document.querySelectorAll('[data-lab-id]')].filter((b) => b.getAttribute('aria-disabled') !== 'true' && !b.closest('[hidden]')).map((b) => b.getAttribute('data-lab-id')));
      const fits = [];
      for (const id of ids) {
        await p3.click(`[data-lab-id="${id}"]`); await p3.waitForSelector('#lab-zoom-v'); await frames(p3);
        await p3.click('[data-lab-zoom="fit"]', { force: true }); await frames(p3);
        fits.push(await p3.evaluate((cid) => {
          const vp = document.getElementById('lab-viewport');
          return { id: cid, pct: Number(document.getElementById('lab-zoom-v').textContent.replace(/[^0-9]/g, '')), pressed: document.querySelector('[data-lab-zoom="fit"]').getAttribute('aria-pressed'),
            scrolls: vp.scrollHeight > vp.clientHeight + 1 || vp.scrollWidth > vp.clientWidth + 1 };
        }, id));
        await p3.click('[data-lab-zoom="reset"]', { force: true });
      }
      check('zoom: Fit never enlarges past 100%, and every previewable component\'s specimen is then wholly visible without scrolling', ids.length > 0 && fits.length === ids.length && fits.every((f) => f.pct >= 25 && f.pct <= 100 && f.pressed === 'true' && !f.scrolls), fits);

      // right to left: the canvas scales from its inline-start edge, so it stays aligned to that edge
      await p3.click('[data-lab-id="lg-chip"]'); await frames(p3);
      const edge = async () => p3.evaluate(() => { const f = document.getElementById('lab-frame').getBoundingClientRect(), c = document.getElementById('lab-specimen').getBoundingClientRect(); return { left: Math.round(c.left - f.left), right: Math.round(f.right - c.right), origin: getComputedStyle(document.getElementById('lab-specimen')).transformOrigin }; });
      await p3.click('[data-lab-zoom="out"]', { force: true }); await p3.click('[data-lab-zoom="out"]', { force: true }); await p3.click('[data-lab-zoom="out"]', { force: true }); await frames(p3);
      const ltr = await edge();
      await p3.click('[data-lab-dir="rtl"]'); await frames(p3);
      const rtlEdge = await edge();
      check('zoom: the transform origin follows the stage direction: left-aligned in LTR, right-aligned in RTL', Math.abs(ltr.left) <= 1 && Math.abs(rtlEdge.right) <= 1 && /^0px 0px/.test(ltr.origin) && !/^0px 0px/.test(rtlEdge.origin), { ltr, rtl: rtlEdge });

      // stability and cost: 40 steps, no node added, and the time from the click to the next frame
      const dom0 = await p3.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
      const times = await p3.evaluate(async () => {
        const out = []; const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (let n = 0; n < 40; n++) {
          const b = document.querySelector(`[data-lab-zoom="${n % 10 < 5 ? 'in' : 'out'}"]`);
          const t0 = performance.now(); b.click(); await fr(); out.push(performance.now() - t0);
        }
        return out;
      });
      const dom1 = await p3.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
      const sorted = [...times].sort((a, b) => a - b);
      const measure = { zoomStepToFrameMedianMs: Math.round(sorted[20] * 10) / 10, zoomStepToFrameP95Ms: Math.round(sorted[37] * 10) / 10, zoomComputeMs: await p3.evaluate(() => window.__familistaLabMetrics().zoomMs), domBefore: dom0, domAfter: dom1 };
      console.log('MEASURE ' + JSON.stringify(measure));
      check('zoom: forty zoom steps add no node to the Lab', dom0 === dom1, measure);
      const split3 = await cspSplit(p3);
      check('zoom: still no Lab or unexplained CSP violation and no console error after Fit, direction and forty steps', split3.lab === 0 && split3.unexplained === 0 && labErrors(log3).length === 0, { csp: split3, errors: labErrors(log3) });
      await c3.close();
    }
  }

  // ══ 9. width (M2 / S2): a container width, laid out inside the same walls ════
  // A width sets the component's content container (.lab-col); the canvas grows to hold it and the zoom path lays it out.
  // Claims: the container is exactly that wide, the overlay stays in the canvas and the viewport clips the rest, nothing outside
  // the stage moves, the zoom is kept and Fit is worked out again, the overflow figure agrees with an independent measurement,
  // input is read strictly, the keys stay where they belong, and nothing of it costs a CSP report. Each has a control.
  if (want('9')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
    await openLab(page, SETTLE);
    await page.click('[data-lab-id="lg-float"]');
    await page.waitForSelector('#lab-specimen .lg-float-bg'); await frames(page);
    const W = { desktop: 1280, tablet: 834, mobile: 390 };
    const setW = async (pg, k) => { await pg.click(`[data-lab-width="${k}"]`); await frames(pg); };
    const pct = async (pg) => Number((await pg.textContent('#lab-zoom-v')).replace(/[^0-9]/g, ''));
    const stage = (pg) => pg.evaluate(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const spec = document.getElementById('lab-specimen'), col = spec.querySelector('.lab-col'), cs = getComputedStyle(spec);
      const t = cs.transform;
      return {
        colW: col ? col.offsetWidth : null, pad: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), canvasW: spec.offsetWidth,
        viewport: r(document.getElementById('lab-viewport')), frame: r(document.getElementById('lab-frame')), canvas: r(spec), overlay: r(spec.querySelector('.lg-float-bg')),
        rail: r(document.querySelector('.lab-rail')), insp: r(document.getElementById('lab-insp')), plate: r(document.getElementById('lab-plate')), tools: r(document.querySelector('.lab-tools')), wbar: r(document.getElementById('lab-wbar')),
        scale: t === 'none' ? 1 : Number(t.split('(')[1].split(',')[0]), sized: ['is-zoomed', 'is-sized'].some((c) => document.getElementById('lab-frame').classList.contains(c)),
        colStyle: col ? col.getAttribute('style') : null, dim: document.getElementById('lab-wdim').textContent, ov: document.getElementById('lab-ov').textContent,
        note: getComputedStyle(document.getElementById('lab-wnote')).visibility, live: document.getElementById('lab-live').textContent,
        pressed: [...document.querySelectorAll('[data-lab-width]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-lab-width')),
      };
    });
    const outsideIsClipped = (pg) => pg.evaluate(() => {
      const vp = document.getElementById('lab-viewport').getBoundingClientRect(), spec = document.getElementById('lab-specimen');
      return [[vp.right + 6, vp.top + 30], [vp.left + 30, vp.bottom + 6], [vp.right + 6, vp.bottom + 6], [vp.left - 6, vp.top + 30], [vp.left + 30, vp.top - 6]]
        .every(([x, y]) => { const e = document.elementFromPoint(x, y); return !(e && spec.contains(e)); });
    });
    const toolsHit = (pg) => pg.evaluate(() => [...document.querySelectorAll('[data-lab-zoom], [data-lab-dir], [data-lab-width], #lab-w')].map((b) => {
      const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return [b.getAttribute('data-lab-zoom') || b.getAttribute('data-lab-dir') || b.getAttribute('data-lab-width') || b.id, !!e && (e === b || b.contains(e) || (b.id === 'lab-w' && e.closest('.lab-wc') === b.closest('.lab-wc')))];
    }));
    // shifts of anything in the Lab that is not inside the stage's viewport: the specimen itself may move, because the reader moved it
    await page.evaluate(() => { window.__cls9 = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__cls9.push({ v: e.value, outside: (e.sources || []).some((s) => s.node && s.node.nodeType === 1 && s.node.closest('.lab') && !s.node.closest('#lab-viewport')) }))).observe({ type: 'layout-shift' }); });

    const fill = await stage(page);
    check('width: Fill is the S1 stage: no container width, no frame size, no transform, nothing measured, and the width readouts laid out but hidden',
      fill.colStyle === null && !fill.sized && fill.scale === 1 && fill.note === 'hidden' && fill.pressed.join() === 'fill' && fill.dim === '—' && fill.ov === '—', fill);
    for (const k of ['desktop', 'tablet', 'mobile']) {
      await setW(page, k);
      const g = await stage(page);
      const hits = await toolsHit(page);
      const clipped = await outsideIsClipped(page);
      check(`width ${k} (${W[k]} px): the content container is exactly ${W[k]} px, the canvas is that plus its own padding, the frame holds it at 100%, and the overlay stays in the canvas, clipped by the viewport`,
        g.colW === W[k] && Math.abs(g.canvasW - (W[k] + g.pad)) <= 1 && g.sized && g.scale === 1 && inside(g.overlay, g.canvas) && clipped && g.note === 'visible' && g.pressed.join() === k && g.dim.startsWith(W[k].toLocaleString('en') + ' ×') && g.live === `Width ${W[k].toLocaleString('en')} px`,
        { colW: g.colW, canvasW: g.canvasW, pad: g.pad, frame: g.frame, canvas: g.canvas, overlay: g.overlay, viewport: g.viewport, clipped, dim: g.dim, live: g.live });
      check(`width ${k}: no tool is covered, and the rail, the inspector, the tools, the plate and the readouts are where they were at Fill`,
        hits.every((h) => h[1]) && JSON.stringify([g.rail, g.insp, g.tools, g.plate, g.wbar]) === JSON.stringify([fill.rail, fill.insp, fill.tools, fill.plate, fill.wbar]), { hits: hits.filter((h) => !h[1]), now: [g.rail, g.insp, g.tools, g.plate, g.wbar], fill: [fill.rail, fill.insp, fill.tools, fill.plate, fill.wbar] });
    }
    await setW(page, 'fill');
    const back = await stage(page);
    const shifts = await page.evaluate(() => window.__cls9);
    check('width: back at Fill the stage is the S1 stage again, and no layout shift outside the stage happened on the way', (back.colStyle === '' || back.colStyle === null) && !back.sized && back.scale === 1 && shifts.filter((x) => x.outside).length === 0,
      { colStyle: back.colStyle, sized: back.sized, shiftsOutside: shifts.filter((x) => x.outside), shiftsInsideStage: shifts.filter((x) => !x.outside).length });

    // zoom and width: the zoom is kept, Fit is never turned on by a width, and Fit is worked out again when it is on
    await page.click('[data-lab-zoom="out"]', { force: true }); await page.click('[data-lab-zoom="out"]', { force: true }); await frames(page);
    const z0 = await pct(page);
    const kept = [];
    for (const k of ['desktop', 'mobile', 'tablet']) { await setW(page, k); const g = await stage(page); kept.push([k, await pct(page), g.colW, Math.abs(g.scale - z0 / 100) < 0.005, Math.abs((g.frame[2] - g.frame[0]) - Math.ceil((W[k] + g.pad) * z0 / 100)) <= 1]); }
    const fitOff = await page.getAttribute('[data-lab-zoom="fit"]', 'aria-pressed');
    check(`width + zoom: switching width keeps the zoom (${z0}%), the container keeps its width under the transform, the frame is the scaled canvas, and Fit stays off`, z0 === 80 && kept.every((x) => x[1] === z0 && x[2] === W[x[0]] && x[3] && x[4]) && fitOff === 'false', kept);
    const fitAt = async (k) => {
      await setW(page, k);
      return page.evaluate(() => { const vp = document.getElementById('lab-viewport'); return { pct: Number(document.getElementById('lab-zoom-v').textContent.replace(/[^0-9]/g, '')), pressed: document.querySelector('[data-lab-zoom="fit"]').getAttribute('aria-pressed'), scrolls: vp.scrollWidth > vp.clientWidth + 1 || vp.scrollHeight > vp.clientHeight + 1, vpW: vp.clientWidth, colW: document.querySelector('#lab-specimen .lab-col').offsetWidth }; });
    };
    await setW(page, 'desktop');
    await page.click('[data-lab-zoom="fit"]', { force: true }); await frames(page);
    const fits = [['desktop', await fitAt('desktop')], ['mobile', await fitAt('mobile')], ['tablet', await fitAt('tablet')]];
    check('width + Fit: with Fit on, every width change works Fit out again: never above 100%, the whole canvas visible without scrolling, the container still at its width',
      fits.every(([k, f]) => f.pressed === 'true' && f.pct >= 25 && f.pct <= 100 && !f.scrolls && f.colW === W[k]) && fits[0][1].pct < fits[1][1].pct, fits);
    await page.click('[data-lab-zoom="reset"]', { force: true }); await frames(page);
    const afterReset = await stage(page);
    check('width + Reset: Reset returns the zoom to 100% and leaves the width alone', (await pct(page)) === 100 && afterReset.colW === W.tablet && afterReset.sized, { pct: await pct(page), colW: afterReset.colW });

    // 1600 px at 200%: far larger than the stage, and still clipped by it
    await page.fill('#lab-w', '1600'); await page.press('#lab-w', 'Enter'); await frames(page);
    for (let n = 0; n < 6; n++) await page.click('[data-lab-zoom="in"]', { force: true });
    await frames(page);
    const big = await stage(page);
    const bigHits = await toolsHit(page);
    check('width 1600 px at 200%: the overlay stays in the canvas, everything past the viewport is clipped, and no tool is covered', (await pct(page)) === 200 && big.colW === 1600 && inside(big.overlay, big.canvas) && (await outsideIsClipped(page)) && bigHits.every((h) => h[1]),
      { pct: await pct(page), colW: big.colW, canvas: big.canvas, viewport: big.viewport, covered: bigHits.filter((h) => !h[1]) });

    // control: take the walls and the transform away at the Mobile width, and the same overlay covers the window
    await page.click('[data-lab-zoom="reset"]', { force: true }); await setW(page, 'mobile');
    const escaped = await page.evaluate(() => {
      const vp = document.getElementById('lab-viewport'), spec = document.getElementById('lab-specimen'), fr = document.getElementById('lab-frame');
      for (const el of [vp, spec, fr]) { el.style.setProperty('contain', 'none'); el.style.setProperty('isolation', 'auto'); el.style.setProperty('overflow', 'visible'); }
      const b = spec.querySelector('.lg-float-bg').getBoundingClientRect();
      const out = { overlay: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], window: [innerWidth, innerHeight] };
      for (const el of [vp, spec, fr]) { el.style.removeProperty('contain'); el.style.removeProperty('isolation'); el.style.removeProperty('overflow'); }
      return out;
    });
    check('width (control): with the containment removed at the Mobile width, the same overlay fills the whole window', escaped.overlay[0] <= 0 && escaped.overlay[1] <= 0 && escaped.overlay[2] >= escaped.window[0] - 24 && escaped.overlay[3] >= escaped.window[1] - 2, escaped);

    // right to left: the same width, aligned to the other edge, scaled from it
    await page.click('[data-lab-zoom="out"]', { force: true }); await page.click('[data-lab-zoom="out"]', { force: true }); await page.click('[data-lab-zoom="out"]', { force: true });
    const edge = () => page.evaluate(() => { const f = document.getElementById('lab-frame').getBoundingClientRect(), c = document.getElementById('lab-specimen').getBoundingClientRect(); return { left: Math.round(c.left - f.left), right: Math.round(f.right - c.right), colW: document.querySelector('#lab-specimen .lab-col').offsetWidth, ov: document.getElementById('lab-ov').textContent, origin: getComputedStyle(document.getElementById('lab-specimen')).transformOrigin }; });
    const ltrEdge = await edge();
    await page.click('[data-lab-dir="rtl"]'); await frames(page);
    const rtlEdge = await edge();
    check('width in RTL: the container keeps its width, the canvas is scaled from its right edge, and the overflow figure is the same as in LTR',
      ltrEdge.colW === W.mobile && rtlEdge.colW === W.mobile && Math.abs(ltrEdge.left) <= 1 && Math.abs(rtlEdge.right) <= 1 && /^0px 0px/.test(ltrEdge.origin) && !/^0px 0px/.test(rtlEdge.origin) && ltrEdge.ov === rtlEdge.ov, { ltr: ltrEdge, rtl: rtlEdge });
    await page.click('[data-lab-dir="ltr"]'); await page.click('[data-lab-zoom="reset"]', { force: true }); await frames(page);

    // overflow, measured independently: the furthest edge of every element and every line of text inside the container,
    // fixed-position layers and whatever an element clips left out, against the container's own edge
    const independent = () => page.evaluate(() => {
      const col = document.querySelector('#lab-specimen .lab-col'); if (!col) return null;
      const rtl = getComputedStyle(col).direction === 'rtl', cb = col.getBoundingClientRect();
      let reach = 0;
      const take = (b) => { if (b.width || b.height) reach = Math.max(reach, rtl ? cb.left - b.left : b.right - cb.right); };
      const visit = (el) => {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || (pos === 'absolute' && !col.contains(el.offsetParent))) return;   // laid out against the canvas, not the container
        take(el.getBoundingClientRect());
        const clips = el !== col && getComputedStyle(el).overflowX !== 'visible';
        if (clips) return;
        for (const n of el.childNodes) {
          if (n.nodeType === 1) visit(n);
          else if (n.nodeType === 3 && n.textContent.trim()) { const rg = document.createRange(); rg.selectNodeContents(n); for (const b of rg.getClientRects()) take(b); }
        }
      };
      for (const c of col.children) visit(c);
      return Math.max(0, Math.round(reach));
    });
    const lab = () => page.evaluate(() => window.__familistaLabMetrics().overflowPx);
    const ovRows = [];
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-lab-id]')].filter((b) => b.getAttribute('aria-disabled') !== 'true' && !b.closest('[hidden]')).map((b) => b.getAttribute('data-lab-id')).slice(0, 10));
    await page.fill('#lab-w', '320'); await page.press('#lab-w', 'Enter'); await frames(page);
    for (const id of ids) {
      await page.click(`[data-lab-id="${id}"]`); await page.waitForSelector('#lab-specimen .lab-col', { state: 'attached' }); await frames(page);
      const fx = await page.evaluate(() => [...document.querySelectorAll('.lab-fx')].map((b) => b.getAttribute('data-lab-fx')));
      for (const f of fx) {
        await page.click(`[data-lab-fx="${f}"]`); await frames(page);
        const [a, b, t] = [await lab(), await independent(), (await page.textContent('#lab-ov')).trim()];
        ovRows.push({ f, lab: a, independent: b, text: t });
      }
    }
    const disagree = ovRows.filter((r) => r.independent !== null && (r.lab === null || Math.abs(r.lab - (r.independent > 1 ? r.independent : 0)) > 1));
    const wordsRight = ovRows.every((r) => r.lab === null ? r.text === '—' : r.lab === 0 ? r.text === 'No horizontal overflow' : r.text === `Content overflows by ${r.lab.toLocaleString('en')} px`);
    check(`width overflow: at 320 px, for all ${ovRows.length} fixtures, the Lab's overflow figure agrees with an independent measurement of every element and line of text, and is worded as measured (0 as "No horizontal overflow", nothing measured as "—")`,
      ovRows.length >= 60 && disagree.length === 0 && wordsRight, { fixtures: ovRows.length, overflowing: ovRows.filter((r) => r.lab > 0).map((r) => [r.f, r.lab]), disagree: disagree.slice(0, 5), empty: ovRows.filter((r) => r.lab === null).map((r) => r.f) });

    // control: genuinely wide content is caught, in both directions, and gone again once it is removed
    await page.click('[data-lab-id="lg-chip"]'); await page.waitForSelector('#lab-specimen .lab-col', { state: 'attached' }); await setW(page, 'mobile');
    const probe = async (dir) => {
      await page.click(`[data-lab-dir="${dir}"]`); await frames(page);
      await page.evaluate(() => { const d = document.createElement('div'); d.id = 'proof-wide'; d.style.setProperty('width', '900px'); d.style.setProperty('height', '4px'); document.querySelector('#lab-specimen .lab-col').appendChild(d); });
      await setW(page, 'mobile');
      const withWide = { lab: await lab(), independent: await independent(), text: (await page.textContent('#lab-ov')).trim(), edge: await page.evaluate(() => document.getElementById('lab-ov').classList.contains('is-over')), live: await page.textContent('#lab-live') };
      await page.evaluate(() => document.getElementById('proof-wide').remove());
      await setW(page, 'mobile');
      return { dir, withWide, without: { lab: await lab(), text: (await page.textContent('#lab-ov')).trim() } };
    };
    const probes = [await probe('ltr'), await probe('rtl')];
    await page.click('[data-lab-dir="ltr"]');
    check('width overflow (control): a 900 px block in a 390 px container reads "Content overflows by 510 px", in LTR and in RTL, marked and announced, and reads 0 again once it is gone',
      probes.every((p) => p.withWide.lab === 510 && Math.abs(p.withWide.independent - 510) <= 1 && p.withWide.text === 'Content overflows by 510 px' && p.withWide.edge && /Content overflows by 510 px/.test(p.withWide.live) && p.without.lab === 0 && p.without.text === 'No horizontal overflow'), probes);

    // input: read strictly from the real field, with real keys
    const typeWidth = async (txt, key = 'Enter') => {
      await page.click('#lab-w', { clickCount: 3 }); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
      if (txt) await page.keyboard.type(txt);
      await page.keyboard.press(key); await frames(page);
      return { width: await page.evaluate(() => window.__familistaLabMetrics().width), field: await page.inputValue('#lab-w'), live: await page.textContent('#lab-live') };
    };
    await setW(page, 'tablet');
    const inputs = [];
    inputs.push(['500', await typeWidth('500')]);
    inputs.push(['100', await typeWidth('100')]);
    inputs.push(['5000', await typeWidth('5000')]);
    for (const bad of ['1e3', '-400', '', 'abc']) inputs.push([bad, await typeWidth(bad)]);
    inputs.push(['700 Escape', await typeWidth('700', 'Escape')]);
    inputs.push(['777 Tab', await typeWidth('777', 'Tab')]);
    const [i500, i100, i5000, ...rest] = inputs.map((x) => x[1]);
    const range = `320 to ${(1600).toLocaleString('en')} px`, between = `between 320 and ${(1600).toLocaleString('en')} px`;
    const badOnes = rest.slice(0, 4), esc = rest[4], tab = rest[5];
    check('width input: a number is applied, one below 320 or above 1600 is held at the limit and the reader is told, anything else is refused and the field goes back, Escape abandons, leaving the field applies',
      i500.width === 500 && i100.width === 320 && i100.field === '320' && i100.live.includes('Kept within ' + range) && i5000.width === 1600 && i5000.field === '1600'
        && badOnes.every((b) => b.width === 1600 && b.field === '1600' && b.live === 'Enter a width ' + between) && esc.width === 1600 && esc.field === '1600' && tab.width === 777, inputs);

    // keys: what is typed in the field stays in it; a preset is a button, reached and pressed from the keyboard
    const fx0 = await page.evaluate(() => window.__familistaLabMetrics().fixture);
    await page.focus('#lab-w');
    for (const k of ['Digit0', 'Minus', 'Equal', 'KeyF', 'BracketLeft', 'BracketRight', 'Slash']) await page.keyboard.press(k);
    const after = await page.evaluate(() => ({ zoom: document.getElementById('lab-zoom-v').textContent.trim(), fixture: window.__familistaLabMetrics().fixture, active: document.activeElement.id }));
    await page.focus('[data-lab-width="mobile"]'); await page.keyboard.press('Tab');
    const tabbed = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
    const back2 = await page.evaluate(() => document.activeElement.getAttribute('data-lab-width'));
    await page.keyboard.press('Enter'); await frames(page);
    const viaEnter = await page.evaluate(() => window.__familistaLabMetrics().width);
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Space'); await frames(page);
    const viaSpace = await page.evaluate(() => window.__familistaLabMetrics().width);
    check('width keys: zoom, fixture and search keys typed in the field do nothing else; the presets and the field are in the tab order and a preset answers Enter and Space',
      after.zoom === '100%' && after.fixture === fx0 && after.active === 'lab-w' && tabbed === 'lab-w' && back2 === 'tablet' && viaEnter === 834 && viaSpace === 1280, { after, tabbed, back2, viaEnter, viaSpace });

    // the viewport rules a component records are marked against the width, from their text, and never run
    await page.click('[data-lab-id="lg-metric"]'); await page.waitForSelector('#lab-mq'); await setW(page, 'mobile');
    const mqMobile = await page.evaluate(() => [...document.querySelectorAll('#lab-mq [data-lab-mq]')].map((e) => e.textContent));
    await setW(page, 'tablet');
    const mqTablet = await page.evaluate(() => [...document.querySelectorAll('#lab-mq [data-lab-mq]')].map((e) => e.textContent));
    await setW(page, 'fill');
    const mqFill = await page.evaluate(() => [...document.querySelectorAll('#lab-mq [data-lab-mq]')].map((e) => [e.textContent, getComputedStyle(e).display]));
    check('width: lg-metric\'s recorded @media (max-width:760px) reads "would apply … not simulated" at 390 px, "would not apply" at 834 px, and nothing at Fill',
      mqMobile.join() === 'Would apply in a 390 px window — not simulated' && mqTablet.join() === 'Would not apply in a 834 px window' && mqFill.length === 1 && mqFill[0][0] === '' && mqFill[0][1] === 'none', { mqMobile, mqTablet, mqFill });

    // kept across a component, a remount; not kept across a reload
    await setW(page, 'tablet'); await page.click('[data-lab-id="lg-chip"]'); await page.waitForSelector('#lab-specimen .lab-col', { state: 'attached' }); await frames(page);
    const kept1 = await page.evaluate(() => document.querySelector('#lab-specimen .lab-col').offsetWidth);
    const remounted = await remount(page); await frames(page);
    const kept2 = await page.evaluate(() => [document.querySelector('#lab-specimen .lab-col').offsetWidth, document.querySelector('[data-lab-width="tablet"]').getAttribute('aria-pressed'), document.getElementById('lab-w').value]);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ds-metric', { timeout: 30000 }); await openLab(page, SETTLE);
    const reloaded = await page.evaluate(() => [window.__familistaLabMetrics().width, document.querySelector('[data-lab-width="fill"]').getAttribute('aria-pressed')]);
    check('width: kept across a component change and a remount of the room, and not kept across a reload (it is never stored)', kept1 === 834 && remounted && kept2[0] === 834 && kept2[1] === 'true' && kept2[2] === '834' && reloaded[0] === null && reloaded[1] === 'true', { kept1, remounted, kept2, reloaded });

    // events: nothing that starts inside the specimen at a width reaches the page; a click on a width button does
    await page.click('[data-lab-id="lg-float"]'); await page.waitForSelector('#lab-specimen .lg-float-bg'); await setW(page, 'mobile');
    await page.evaluate((types) => {
      window.__seen9 = { inside: {}, outside: {} };
      const rec = (e) => { const spec = document.getElementById('lab-specimen'); const k = spec && spec.contains(e.target) ? 'inside' : 'outside'; window.__seen9[k][e.type] = (window.__seen9[k][e.type] || 0) + 1; };
      for (const t of types) { document.addEventListener(t, rec); window.addEventListener(t, rec); document.body.addEventListener(t, rec); }
    }, ['click', 'mousedown', 'pointerdown', 'mouseup', 'pointerup', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'input', 'change']);
    for (const sel of ['#lab-specimen .lg-float-x', '#lab-specimen .lg-float']) {
      const b = await page.locator(sel).first().boundingBox();
      if (!b) continue;
      const x = b.x + Math.min(b.width / 2, 8), y = b.y + Math.min(b.height / 2, 8);
      await page.mouse.click(x, y); await page.mouse.dblclick(x, y); await page.mouse.click(x, y, { button: 'right' });
    }
    await page.focus('#lab-specimen .lg-float-x');
    for (const k of ['Enter', 'Escape', 'Digit0', 'Equal']) await page.keyboard.press(k);
    await setW(page, 'tablet');
    const seen9 = await page.evaluate(() => window.__seen9);
    check('width: at a set width nothing that starts inside the specimen reaches a document, window or body listener', Object.keys(seen9.inside).length === 0, { inside: seen9.inside });
    check('width (control): a click on a width button, outside the specimen, is seen by those listeners', (seen9.outside.click || 0) >= 1, { outside: seen9.outside });

    // cost: width changes, Fit worked out again, and zoom steps at a set width; DOM and memory
    const client = await ctx.newCDPSession(page);
    await client.send('Performance.enable'); await client.send('HeapProfiler.enable');
    const heap = async () => { await client.send('HeapProfiler.collectGarbage'); return (await client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value; };
    const timed = (sel, n, mode) => page.evaluate(async ({ sel, n, mode }) => {
      const out = [], sync = []; const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cycle = ['desktop', 'tablet', 'mobile', 'fill'];
      for (let i = 0; i < n; i++) {
        const b = mode === 'width' || mode === 'readouts' ? document.querySelector(`[data-lab-width="${cycle[i % 4]}"]`) : mode === 'fitwidth' ? document.querySelector(`[data-lab-width="${cycle[i % 3]}"]`) : document.querySelector(`[data-lab-zoom="${i % 10 < 5 ? 'in' : 'out'}"]`);
        const t0 = performance.now(); b.click(); await fr();
        // 'readouts': one frame more, so the readouts (read after the stage's layout and written in the next frame) are laid out too
        if (mode === 'readouts') await new Promise((r) => requestAnimationFrame(r));
        out.push(performance.now() - t0);
        sync.push(mode === 'zoom' ? window.__familistaLabMetrics().zoomMs : window.__familistaLabMetrics().widthMs);
      }
      return { times: out, sync };
    }, { sel, n, mode });
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10 }; };
    const dom0 = await page.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
    const h0 = await heap();
    const w1 = await timed(null, 40, 'width');
    const r1 = await timed(null, 40, 'readouts');
    await setW(page, 'tablet');
    const z1 = await timed(null, 40, 'zoom');
    await page.click('[data-lab-zoom="fit"]', { force: true });
    const f1 = await timed(null, 21, 'fitwidth');
    await page.click('[data-lab-zoom="reset"]', { force: true }); await setW(page, 'fill');
    await timed(null, 80, 'width');
    await setW(page, 'fill');
    const h1 = await heap();
    const dom1 = await page.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
    const ws = stat(w1.times), zs = stat(z1.times), fs2 = stat(f1.times), rs = stat(r1.times);
    // synchronous work per change (the Lab's own figure), median, so one cheap Fill at the end cannot stand for the rest
    const measure = { widthChangeToFrameMedianMs: ws.median, widthChangeToFrameP95Ms: ws.p95, widthComputeMedianMs: stat(w1.sync).median, widthComputeP95Ms: stat(w1.sync).p95, widthChangeToReadoutsMedianMs: rs.median, widthChangeToReadoutsP95Ms: rs.p95, zoomStepAtWidthToFrameMedianMs: zs.median, zoomStepAtWidthToFrameP95Ms: zs.p95, zoomComputeMedianMs: stat(z1.sync).median, fitRecalcToFrameMedianMs: fs2.median, fitRecalcToFrameP95Ms: fs2.p95, widthChanges: 160, domBefore: dom0, domAfter: dom1, heapGrowthKB: Math.round((h1 - h0) / 1024) };
    console.log('MEASURE ' + JSON.stringify(measure));
    check('width: a hundred and sixty width changes, forty zoom steps and twenty-one Fit recalculations add no node to the Lab', dom0 === dom1, measure);
    const split = await cspSplit(page);
    check('width: no Lab or unexplained CSP violation, and no console error, after everything above', split.lab === 0 && split.unexplained === 0 && labErrors(log).length === 0, { csp: split, errors: labErrors(log) });
    await ctx.close();

    // control: the same width written as an inline style is refused by the policy and counted as the Lab's, so the check above can fail
    {
      const { ctx: c2, page: p2 } = await open({ width: 1440, height: 900 }, 'en', (src) => src.replace("col.style.setProperty('width', S.width + 'px');", "col.setAttribute('style', 'width:' + S.width + 'px');"));
      await openLab(p2, SETTLE); await quiet(p2);
      const from = await cspMark(p2);
      await setW(p2, 'mobile'); await p2.waitForTimeout(300);
      const win = await cspSplit(p2, from);
      check('width (control): a lab.js that writes the width as a style attribute is refused by the unchanged policy and counted as the Lab\'s violation', win.lab >= 1, win);
      await c2.close();
    }

    // sizes and languages: the escape hatch, a phone, and Arabic
    const sizes = [];
    for (const [loc, w, h] of [['en', 980, 760], ['de', 560, 900], ['en', 390, 844], ['ar', 1440, 900]]) {
      const { ctx: c3, page: p3, log: log3 } = await open({ width: w, height: h }, loc);
      await openLab(p3, SETTLE); await setW(p3, 'desktop');
      sizes.push(await p3.evaluate(([loc, w]) => {
        const doc = document.documentElement, b = document.getElementById('ds-body');
        const ctrls = [...document.querySelectorAll('[data-lab-width], #lab-w')];
        const visible = ctrls.every((c) => { c.scrollIntoView({ block: 'center', inline: 'center' }); const r = c.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && !!e && (e === c || c.contains(e) || e.closest('.lab-wc') === c.closest('.lab-wc')); });
        return { loc, w, pageOverflowX: doc.scrollWidth > doc.clientWidth + 1 || (b && b.scrollWidth > b.clientWidth + 1), visible, note: document.getElementById('lab-wnote').textContent, fill: document.querySelector('[data-lab-width="fill"]').getAttribute('aria-label'), colW: document.querySelector('#lab-specimen .lab-col').offsetWidth, dir: document.getElementById('ds-root').dir };
      }, [loc, w]));
      sizes[sizes.length - 1].labErrors = labErrors(log3).length;
      await c3.close();
    }
    const ar = sizes.find((x) => x.loc === 'ar'), de = sizes.find((x) => x.loc === 'de');
    check('width: at 980, 560 and 390 px windows and in Arabic, the width controls are reachable, the page never scrolls sideways, the container is still 1280 px, and the disclosure is in the reader\'s language',
      sizes.every((x) => !x.pageOverflowX && x.visible && x.colW === 1280 && x.labErrors === 0) && ar.dir === 'rtl' && /محاكاة/.test(ar.note) && /[؀-ۿ]/.test(ar.fill) && /Simulation/i.test(de.note), sizes);
  }

  // ══ 10. comparison (M2 / S3): two panes, each inside its own walls ═══════════
  // Preview B is the same stage as A with every id suffixed "-b". Claims: B draws exactly what A would for the same fixture,
  // each pane is contained and isolated on its own and from the other, the toolbar is shared (one zoom, one width, Fit at the
  // smaller scale), B is removed node for node when comparison ends, nothing is fetched, and the layout follows the stage's
  // width. Each has a control where one applies.
  if (want('10')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
    await openLab(page, SETTLE);
    await page.click('[data-lab-id="lg-float"]');
    await page.waitForSelector('#lab-specimen .lg-float-bg'); await frames(page);
    const mode = async (pg, m) => { await pg.click(`[data-lab-mode="${m}"]`); await frames(pg); };
    const markup = (pg, p) => pg.evaluate((x) => { const c = document.querySelector('#lab-specimen' + x + ' .lab-col'); return c ? c.innerHTML : null; }, p === 'b' ? '-b' : '');
    const labNodes = (pg) => pg.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
    const r4 = (b) => [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)];
    const geo = (pg) => pg.evaluate(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const one = (x) => {
        const spec = document.getElementById('lab-specimen' + x), t = spec ? getComputedStyle(spec).transform : 'none';
        return { pane: r(document.getElementById(x ? 'lab-pane-b' : 'lab-pane-a')), viewport: r(document.getElementById('lab-viewport' + x)), canvas: r(spec), overlay: r(spec && spec.querySelector('.lg-float-bg')),
          scale: t === 'none' ? 1 : Number(t.split('(')[1].split(',')[0]), colW: spec && spec.querySelector('.lab-col') ? spec.querySelector('.lab-col').offsetWidth : null,
          contain: spec ? getComputedStyle(spec).contain : null, vpContain: document.getElementById('lab-viewport' + x) ? getComputedStyle(document.getElementById('lab-viewport' + x)).contain : null,
          isolation: spec ? getComputedStyle(spec).isolation : null, origin: spec ? getComputedStyle(spec).transformOrigin : null, dir: spec ? spec.getAttribute('dir') : null };
      };
      return { a: one(''), b: one('-b'), rail: r(document.querySelector('.lab-rail')), insp: r(document.getElementById('lab-insp')), tools: r(document.querySelector('.lab-tools')) };
    });
    // Whether anything of one pane's specimen is visible inside the other pane's viewport: a 7 × 7 grid of points over that
    // viewport, each asked what is on screen there. A box that reaches past its own viewport but is clipped by it never shows.
    const shows = (pg, from, over) => pg.evaluate(([from, over]) => {
      const vp = document.getElementById('lab-viewport' + over).getBoundingClientRect(), spec = document.getElementById('lab-specimen' + from);
      const hits = [];
      for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) { const x = vp.left + vp.width * i / 8, y = vp.top + vp.height * j / 8, e = document.elementFromPoint(x, y); if (e && spec.contains(e)) hits.push([Math.round(x), Math.round(y)]); }
      return hits.length;
    }, [from, over]);
    const outsideClipped = (pg, x) => pg.evaluate((x) => {
      const vp = document.getElementById('lab-viewport' + x).getBoundingClientRect(), spec = document.getElementById('lab-specimen' + x);
      return [[vp.right + 3, vp.top + 20], [vp.left + 20, vp.bottom + 3], [vp.left - 3, vp.top + 20], [vp.left + 20, vp.top - 3]].every(([px, py]) => { const e = document.elementFromPoint(px, py); return !(e && spec.contains(e)); });
    }, x);

    // single: exactly the S2 stage, nothing of B
    const single0 = await page.evaluate(() => ({ b: document.querySelectorAll('.lab [id$="-b"], .lab .lab-cmp, .lab [data-lab-swap]').length, plate: document.getElementById('lab-plate').getAttribute('role'), parent: document.getElementById('lab-viewport').parentElement.id }));
    const nodes0 = await labNodes(page);
    const aSingle = await markup(page, 'a');
    check('compare: single preview is the S2 stage: no Preview B node, the plate is the strip\'s tab panel and holds the viewport itself', single0.b === 0 && single0.plate === 'tabpanel' && single0.parent === 'lab-plate', single0);

    // open comparison: B shows the next fixture, drawn exactly as A would draw it; nothing fetched; every id unique
    const net = await netWatch(page);
    const fx = await page.evaluate(() => [...document.querySelectorAll('.lab-fx')].map((b) => b.getAttribute('data-lab-fx')));
    await mode(page, 'compare');
    const opened = await page.evaluate(() => ({ b: document.getElementById('lab-fx-b').value, a: window.__familistaLabMetrics().fixture, cur: document.querySelector('.lab-fx.is-on').getAttribute('data-lab-fx'),
      ids: [...document.querySelectorAll('[id]')].map((e) => e.id), live: document.getElementById('lab-live').textContent }));
    const dupes = opened.ids.filter((x, i) => opened.ids.indexOf(x) !== i);
    const aCmp = await markup(page, 'a'), bCmp = await markup(page, 'b');
    await page.click(`[data-lab-fx="${fx[1]}"]`); await frames(page);
    const aFx1 = await markup(page, 'a');
    await page.click(`[data-lab-fx="${fx[0]}"]`); await frames(page);
    check('compare: Preview B opens on the fixture after A\'s, drawn node for node as A draws that same fixture, A unchanged, every id in the page unique',
      opened.a === fx[0] && opened.b === fx[1] && opened.cur === fx[0] && aCmp === aSingle && bCmp === aFx1 && bCmp !== aCmp && dupes.length === 0 && opened.live === 'Compare side by side', { opened: { a: opened.a, b: opened.b, cur: opened.cur }, dupes, sameA: aCmp === aSingle, bAsA: bCmp === aFx1 });
    const walls = await geo(page);
    check('compare: each pane has every wall: layout and paint containment and isolation on its canvas, strict containment on its viewport',
      ['a', 'b'].every((p) => /layout/.test(walls[p].contain) && /paint/.test(walls[p].contain) && walls[p].isolation === 'isolate' && /strict|size layout paint/.test(walls[p].vpContain)), { a: [walls.a.contain, walls.a.vpContain, walls.a.isolation], b: [walls.b.contain, walls.b.vpContain, walls.b.isolation] });

    // B on its own; Swap; nothing fetched by any of it
    const aBefore = await markup(page, 'a');
    await page.selectOption('#lab-fx-b', fx[3]); await frames(page);
    const afterPick = { a: await markup(page, 'a'), b: await markup(page, 'b'), cur: await page.getAttribute('.lab-fx.is-on', 'data-lab-fx'), m: await page.evaluate(() => window.__familistaLabMetrics()) };
    await page.click('[data-lab-fx="' + fx[3] + '"]'); await frames(page);
    const aFx3 = await markup(page, 'a');
    await page.click('[data-lab-fx="' + fx[0] + '"]'); await frames(page);
    check('compare: choosing Preview B\'s fixture changes B alone: A\'s markup, the strip and A\'s fixture stay as they were',
      afterPick.a === aBefore && afterPick.b === aFx3 && afterPick.cur === fx[0] && afterPick.m.fixture === fx[0] && afterPick.m.fixtureB === fx[3], { cur: afterPick.cur, fixture: afterPick.m.fixture, fixtureB: afterPick.m.fixtureB });
    const bBefore = await markup(page, 'b');
    await page.click('[data-lab-swap]'); await frames(page);
    const sw = { a: await markup(page, 'a'), b: await markup(page, 'b'), cur: await page.getAttribute('.lab-fx.is-on', 'data-lab-fx'), sel: await page.inputValue('#lab-fx-b'), live: await page.textContent('#lab-live') };
    check('compare: Swap exchanges the two panes, the strip following A and the selector following B', sw.a === bBefore && sw.b === aBefore && sw.cur === fx[3] && sw.sel === fx[0] && sw.live === 'Preview A and Preview B swapped', { cur: sw.cur, sel: sw.sel, live: sw.live });
    await page.click('[data-lab-swap]'); await frames(page);
    await frames(page); await net.stop();
    const fetched = net.seen.filter((x) => x.lab);
    check('compare: opening comparison, choosing B\'s fixture and swapping make no request from the Lab (to a Lab endpoint or, from a Lab script, to any URL); the application\'s own background requests are counted apart',
      fetched.length === 0, { lab: fetched, application: net.seen.length - fetched.length });

    // Swap, then at once a redraw of the room (a navigation, a Refresh or a language switch all redraw it): the announcement must
    // reach the new live region, once.
    await page.click('[data-lab-swap]');
    const swapRedraw = await roomRedraw(page);
    const swapState = await page.evaluate(() => [window.__familistaLabMetrics().fixture, window.__familistaLabMetrics().fixtureB]);
    check('compare announce: Swap followed at once by a redraw of the room still announces "Preview A and Preview B swapped" in the new live region, written once, and the panes stay swapped',
      !!swapRedraw && swapRedraw.live === 'Preview A and Preview B swapped' && swapRedraw.writes.filter((w) => w).length === 1 && swapState[0] === fx[3] && swapState[1] === fx[0], { redraw: swapRedraw, state: swapState });
    await page.click('[data-lab-swap]'); await frames(page);
    await page.waitForTimeout(2700);
    const staleRedraw = await roomRedraw(page);
    check('compare announce (control): the same redraw 2.7 s after Swap writes nothing into the new live region: an old announcement is not repeated',
      !!staleRedraw && staleRedraw.live === '' && staleRedraw.writes.filter((w) => w).length === 0, { redraw: staleRedraw });
    // Swap, then at once the change background club data makes. The room draws no club data, so it is left exactly as it was:
    // the announcement is written once, from the click, into the live region the reader's screen reader is already watching.
    await page.evaluate(liveRecord);
    await page.click('[data-lab-swap]');
    const swapData = await dataChange(page, 600, true);
    const dataState = await page.evaluate(() => [window.__familistaLabMetrics().fixture, window.__familistaLabMetrics().fixtureB]);
    check('compare announce: Swap followed at once by a club-data change leaves the room alone (the same Lab and room elements, no room render), "Preview A and Preview B swapped" is written once into the same live region, and the panes stay swapped',
      swapData.same && swapData.renders === 0 && swapData.live === 'Preview A and Preview B swapped' && swapData.writes.filter((w) => w).length === 1 && dataState[0] === fx[3] && dataState[1] === fx[0], { change: swapData, state: dataState });
    await page.click('[data-lab-swap]'); await frames(page);

    // containment: each overlay in its own canvas, never over the other pane, clipped by its own viewport, at every scale and width
    const zoomTo = async (pct) => { await page.click('[data-lab-zoom="reset"]', { force: true }); const dir = pct < 100 ? 'out' : 'in'; for (let n = 0; n < 12 && Number((await page.textContent('#lab-zoom-v')).replace(/[^0-9]/g, '')) !== pct; n++) await page.click(`[data-lab-zoom="${dir}"]`, { force: true }); await frames(page); };
    const cont = [];
    for (const w of ['fill', 'mobile', 'desktop']) {
      await page.click(`[data-lab-width="${w}"]`); await frames(page);
      for (const pct of [25, 100, 200]) {
        await zoomTo(pct);
        const g = await geo(page);
        cont.push({ w, pct, aIn: inside(g.a.overlay, g.a.canvas), bIn: inside(g.b.overlay, g.b.canvas), aNotB: (await shows(page, '', '-b')) === 0, bNotA: (await shows(page, '-b', '')) === 0,
          aClip: await outsideClipped(page, ''), bClip: await outsideClipped(page, '-b'), scales: [g.a.scale, g.b.scale] });
      }
    }
    await zoomTo(100); await page.click('[data-lab-width="fill"]'); await frames(page);
    check('compare: at Fill, Mobile and Desktop and at 25%, 100% and 200%, each pane\'s fixed overlay stays inside its own canvas, never reaches the other pane, and is clipped by its own viewport; both panes share the scale',
      cont.length === 9 && cont.every((c) => c.aIn && c.bIn && c.aNotB && c.bNotA && c.aClip && c.bClip && Math.abs(c.scales[0] - c.scales[1]) < 0.005 && Math.abs(c.scales[0] - c.pct / 100) < 0.005), cont.filter((c) => !(c.aIn && c.bIn && c.aNotB && c.bNotA && c.aClip && c.bClip)));
    const escaped = await page.evaluate(() => {
      const els = ['lab-viewport-b', 'lab-specimen-b', 'lab-frame-b'].map((i) => document.getElementById(i));
      for (const el of els) { el.style.setProperty('contain', 'none'); el.style.setProperty('isolation', 'auto'); el.style.setProperty('overflow', 'visible'); }
      const b = document.querySelector('#lab-specimen-b .lg-float-bg').getBoundingClientRect();
      const out = { overlay: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], window: [innerWidth, innerHeight] };
      for (const el of els) { el.style.removeProperty('contain'); el.style.removeProperty('isolation'); el.style.removeProperty('overflow'); }
      return out;
    });
    check('compare (control): with Preview B\'s walls removed, its overlay fills the whole window, over Preview A too', escaped.overlay[0] <= 0 && escaped.overlay[1] <= 0 && escaped.overlay[2] >= escaped.window[0] - 24 && escaped.overlay[3] >= escaped.window[1] - 2, escaped);

    // events: nothing that starts in one pane reaches the other pane or the page
    await page.evaluate((types) => {
      window.__seen10 = { page: {}, inA: {}, inB: {} };
      const where = (e) => { const a = document.getElementById('lab-specimen'), b = document.getElementById('lab-specimen-b'); return a && a.contains(e.target) ? 'A' : b && b.contains(e.target) ? 'B' : 'out'; };
      const rec = (bucket) => (e) => { const k = bucket + ':' + where(e); window.__seen10.page[k] = (window.__seen10.page[k] || 0) + 1; };
      for (const t of types) { document.addEventListener(t, rec('doc')); window.addEventListener(t, rec('win')); document.body.addEventListener(t, rec('body')); }
      // each pane's own frame listens too: an event from the other pane must never arrive there
      for (const [id, k] of [['lab-frame', 'inA'], ['lab-frame-b', 'inB']]) for (const t of types) document.getElementById(id).addEventListener(t, (e) => { window.__seen10[k][t + ':' + where(e)] = (window.__seen10[k][t + ':' + where(e)] || 0) + 1; });
    }, ['click', 'mousedown', 'pointerdown', 'mouseup', 'pointerup', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'input', 'change']);
    for (const x of ['', '-b']) for (const sel of [`#lab-specimen${x} .lg-float-x`, `#lab-specimen${x} .lg-float`]) {
      const b = await page.locator(sel).first().boundingBox();
      if (!b) continue;
      const px = b.x + Math.min(b.width / 2, 8), py = b.y + Math.min(b.height / 2, 8);
      await page.mouse.click(px, py); await page.mouse.dblclick(px, py); await page.mouse.click(px, py, { button: 'right' });
    }
    for (const x of ['', '-b']) { await page.focus(`#lab-specimen${x} .lg-float-x`); for (const k of ['Enter', 'Escape', 'Digit0', 'BracketRight']) await page.keyboard.press(k); }
    await page.click('[data-lab-swap]'); await page.click('[data-lab-swap]'); await frames(page);
    const seen = await page.evaluate(() => window.__seen10);
    const fromPanes = Object.keys(seen.page).filter((k) => !/:out$/.test(k));
    const crossed = Object.keys(seen.inA).filter((k) => /:B$/.test(k)).concat(Object.keys(seen.inB).filter((k) => /:A$/.test(k)));
    const ownFrame = Object.keys(seen.inA).filter((k) => /:A$/.test(k)).concat(Object.keys(seen.inB).filter((k) => /:B$/.test(k)));
    check('compare: nothing that starts inside either pane reaches the other pane or a document, window or body listener', fromPanes.length === 0 && crossed.length === 0 && ownFrame.length === 0, { fromPanes, crossed, ownFrame });
    check('compare (control): a click on Swap, outside both panes, is seen by those listeners', (seen.page['doc:out'] || 0) >= 1, { out: seen.page['doc:out'] || 0 });

    // shared toolbar: one zoom, one width, Fit at the smaller scale
    await page.click('[data-lab-width="desktop"]'); await frames(page);
    const fitEach = await page.evaluate(() => ['', '-b'].map((x) => {
      const vp = document.getElementById('lab-viewport' + x), spec = document.getElementById('lab-specimen' + x), col = spec.querySelector('.lab-col'), cs = getComputedStyle(spec);
      const w = col.offsetWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), h = col.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return Math.max(0.25, Math.floor(Math.min(1, vp.clientWidth / w, vp.clientHeight / h) * 100 + 1e-6) / 100);
    }));
    await page.click('[data-lab-zoom="fit"]', { force: true }); await frames(page);
    const fitG = await geo(page);
    const fitScroll = await page.evaluate(() => ['', '-b'].map((x) => { const vp = document.getElementById('lab-viewport' + x); return vp.scrollWidth > vp.clientWidth + 1 || vp.scrollHeight > vp.clientHeight + 1; }));
    check('compare + Fit: both panes take the smaller of their two fit scales, and neither scrolls', Math.abs(fitG.a.scale - Math.min(...fitEach)) < 0.005 && Math.abs(fitG.b.scale - Math.min(...fitEach)) < 0.005 && fitScroll.every((x) => !x), { each: fitEach, scales: [fitG.a.scale, fitG.b.scale], fitScroll });
    await page.click('[data-lab-zoom="reset"]', { force: true });
    await page.click('#lab-w', { clickCount: 3 }); await page.keyboard.type('777'); await page.keyboard.press('Enter'); await frames(page);
    const w777 = await geo(page);
    await page.click('[data-lab-dir="rtl"]'); await page.click('[data-lab-zoom="out"]', { force: true }); await frames(page);
    const rtlG = await geo(page);
    await page.click('[data-lab-dir="ltr"]'); await page.click('[data-lab-zoom="reset"]', { force: true }); await frames(page);
    check('compare: one custom width (777 px) reaches both containers, and in RTL both canvases scale from their right edge',
      w777.a.colW === 777 && w777.b.colW === 777 && rtlG.a.dir === 'rtl' && rtlG.b.dir === 'rtl' && !/^0px 0px/.test(rtlG.a.origin) && !/^0px 0px/.test(rtlG.b.origin), { colW: [w777.a.colW, w777.b.colW], origin: [rtlG.a.origin, rtlG.b.origin] });

    // overflow per pane, against a wide block in B only
    await page.click('[data-lab-width="mobile"]'); await frames(page);
    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'proof-wide-b'; d.style.setProperty('width', '900px'); d.style.setProperty('height', '4px'); document.querySelector('#lab-specimen-b .lab-col').appendChild(d); });
    await page.click('[data-lab-width="mobile"]'); await frames(page);
    const ovr = await page.evaluate(() => ({ a: document.getElementById('lab-ov').textContent, b: document.getElementById('lab-ov-b').textContent, m: window.__familistaLabMetrics(), live: document.getElementById('lab-live').textContent }));
    await page.evaluate(() => document.getElementById('proof-wide-b').remove());
    await page.click('[data-lab-width="mobile"]'); await frames(page);
    const ovr2 = await page.evaluate(() => ({ b: document.getElementById('lab-ov-b').textContent, m: window.__familistaLabMetrics() }));
    check('compare overflow: a 900 px block in Preview B alone reads 510 px there, 0 in Preview A, is announced as B\'s, and reads 0 once removed',
      ovr.m.overflowPxB === 510 && ovr.m.overflowPx === 0 && ovr.b === 'Content overflows by 510 px' && ovr.a === 'No horizontal overflow' && /Preview B: Content overflows by 510 px/.test(ovr.live) && ovr2.m.overflowPxB === 0 && ovr2.b === 'No horizontal overflow', { a: ovr.a, b: ovr.b, live: ovr.live, after: ovr2.b });
    await page.click('[data-lab-width="fill"]'); await frames(page);

    // keyboard and focus
    await page.focus('#lab-fx-b');
    const fx0 = await page.evaluate(() => [window.__familistaLabMetrics().fixture, window.__familistaLabMetrics().fixtureB, document.getElementById('lab-zoom-v').textContent.trim()]);
    for (const k of ['Digit0', 'Minus', 'BracketRight', 'Slash']) await page.keyboard.press(k);
    await page.keyboard.press('ArrowDown'); await frames(page);
    const kb = await page.evaluate(() => [window.__familistaLabMetrics().fixture, window.__familistaLabMetrics().fixtureB, document.getElementById('lab-zoom-v').textContent.trim(), document.activeElement.id]);
    await page.focus('[data-lab-mode="compare"]'); await page.keyboard.press('Tab');
    const tab1 = await page.evaluate(() => document.activeElement.getAttribute('data-lab-mode') || document.activeElement.id || document.activeElement.className);
    check('compare keys: keys typed on Preview B\'s selector zoom nothing and step nothing; ArrowDown changes B only; the View buttons are in the tab order',
      kb[0] === fx0[0] && kb[2] === fx0[2] && kb[1] !== fx0[1] && kb[3] === 'lab-fx-b' && !!tab1, { before: fx0, after: kb, tab1 });
    const restores = [];
    for (const sel of ['#lab-fx-b', '[data-lab-swap]', '[data-lab-mode="compare"]']) {
      await page.focus(sel);
      const ok = await remount(page);
      restores.push([sel, ok, await page.evaluate((q) => !!document.activeElement && document.activeElement.matches(q), sel)]);
    }
    check('compare focus: after the room redraws the Lab, focus is back on Preview B\'s selector, on Swap and on the View button', restores.every((x) => x[1] && x[2]), restores);

    // the layout follows the stage's own width: stacked here (the stage is under 720 px wide)
    const stack = await geo(page);
    check('compare layout: on a stage under 720 px wide the panes are stacked, B under A, both as wide as the stage', stack.b.pane[1] >= stack.a.pane[3] - 1 && Math.abs(stack.a.pane[0] - stack.b.pane[0]) <= 1 && Math.abs(stack.a.pane[2] - stack.b.pane[2]) <= 1, { a: stack.a.pane, b: stack.b.pane });

    // cost: opening comparison, B's fixture, and the shared tools in comparison; DOM and memory over 40 toggles
    const client = await ctx.newCDPSession(page);
    await client.send('Performance.enable'); await client.send('HeapProfiler.enable');
    const heap = async () => { await client.send('HeapProfiler.collectGarbage'); return (await client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value; };
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10 }; };
    await mode(page, 'single');
    const nodesSingle = await labNodes(page);
    const hasB = await page.evaluate(() => document.querySelectorAll('.lab [id$="-b"], .lab .lab-cmp').length);
    const h0 = await heap();
    const toggles = await page.evaluate(async () => {
      const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const open = [], close = [], sync = [];
      for (let i = 0; i < 40; i++) {
        let t0 = performance.now(); document.querySelector('[data-lab-mode="compare"]').click(); await fr(); open.push(performance.now() - t0); sync.push(window.__familistaLabMetrics().modeMs);
        t0 = performance.now(); document.querySelector('[data-lab-mode="single"]').click(); await fr(); close.push(performance.now() - t0);
      }
      return { open, close, sync };
    });
    const h1 = await heap();
    const nodesAfter = await labNodes(page);
    const hasBAfter = await page.evaluate(() => document.querySelectorAll('.lab [id$="-b"], .lab .lab-cmp').length);
    await mode(page, 'compare');
    const timed = (kind, n) => page.evaluate(async ({ kind, n }) => {
      const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = [], sync = [], sel = document.getElementById('lab-fx-b'), opts = [...sel.options].map((o) => o.value), cyc = ['desktop', 'tablet', 'mobile', 'fill'];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        if (kind === 'b') { sel.value = opts[(i + 2) % opts.length]; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        else if (kind === 'zoom') document.querySelector(`[data-lab-zoom="${i % 10 < 5 ? 'in' : 'out'}"]`).click();
        else if (kind === 'width') document.querySelector(`[data-lab-width="${cyc[i % 4]}"]`).click();
        else if (kind === 'fit') document.querySelector(`[data-lab-width="${cyc[i % 3]}"]`).click();
        await fr();
        out.push(performance.now() - t0);
        const m = window.__familistaLabMetrics(); sync.push(kind === 'b' ? m.switchBMs : kind === 'zoom' ? m.zoomMs : m.widthMs);
      }
      return { out, sync };
    }, { kind, n });
    const tb = await timed('b', 30);
    const tz = await timed('zoom', 40);
    const tw = await timed('width', 40);
    const tr = await page.evaluate(async () => {
      const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), cyc = ['desktop', 'tablet', 'mobile'], out = [];
      for (let i = 0; i < 30; i++) { const t0 = performance.now(); document.querySelector(`[data-lab-width="${cyc[i % 3]}"]`).click(); await fr(); await new Promise((r) => requestAnimationFrame(r)); out.push(performance.now() - t0); }
      return out;
    });
    await page.click('[data-lab-zoom="fit"]', { force: true });
    const tf2 = await timed('fit', 21);
    await page.click('[data-lab-zoom="reset"]', { force: true }); await page.click('[data-lab-width="fill"]'); await frames(page);
    const so = stat(toggles.open), sc = stat(toggles.close);
    const measure = { compareOpenToFrameMedianMs: so.median, compareOpenToFrameP95Ms: so.p95, compareOpenSyncMedianMs: stat(toggles.sync).median, compareCloseToFrameMedianMs: sc.median,
      fixtureBToFrameMedianMs: stat(tb.out).median, fixtureBToFrameP95Ms: stat(tb.out).p95, fixtureBSyncMedianMs: stat(tb.sync).median,
      zoomInCompareToFrameMedianMs: stat(tz.out).median, zoomInCompareToFrameP95Ms: stat(tz.out).p95, zoomInCompareSyncMedianMs: stat(tz.sync).median,
      widthInCompareToFrameMedianMs: stat(tw.out).median, widthInCompareToFrameP95Ms: stat(tw.out).p95, widthInCompareSyncMedianMs: stat(tw.sync).median, widthReadoutsInCompareMedianMs: stat(tr).median,
      fitInCompareToFrameMedianMs: stat(tf2.out).median, fitInCompareToFrameP95Ms: stat(tf2.out).p95,
      toggles: 40, labNodesSingle: nodesSingle, labNodesAfterToggles: nodesAfter, heapGrowthKB: Math.round((h1 - h0) / 1024) };
    console.log('MEASURE ' + JSON.stringify(measure));
    // M3/S3.2 D6: this Compare figure is diagnostic. Its samples are not the budget block's, and the 100 ms budget does not apply.
    {
      const interval = await frameInterval(page);
      const browser = toggles.open.map((v, i) => v - toggles.sync[i]);
      emitMetric('diag.compare.open.s10.p95', { value: so.p95, unit: 'ms', n: toggles.open.length, max: maxOf(toggles.open) });
      emitMetric('diag.compare.open.s10.median', { value: so.median, unit: 'ms', n: toggles.open.length });
      emitMetric('diag.compare.open.s10.app.median', { value: stat(toggles.sync).median, unit: 'ms', n: toggles.sync.length });
      emitMetric('diag.compare.open.s10.browser.median', { value: stat(browser).median, unit: 'ms', n: browser.length });
      emitMetric('diag.compare.open.s10.frames', { unit: 'frames', interval, n: toggles.open.length, distribution: frameCounts(toggles.open, interval) });
    }
    check('compare: forty times into comparison and back leave the Lab with exactly the nodes of single preview and no Preview B node', nodesAfter === nodesSingle && hasB === 0 && hasBAfter === 0 && single0.b === 0, { ...measure, nodesAtOpen: nodes0, hasB, hasBAfter });
    const split = await cspSplit(page);
    check('compare: no Lab or unexplained CSP violation, and no console error, after everything above', split.lab === 0 && split.unexplained === 0 && labErrors(log).length === 0, { csp: split, errors: labErrors(log) });
    await ctx.close();

    // control: a width written as a style attribute is refused in both panes and counted as the Lab's, once for each
    {
      const { ctx: c2, page: p2 } = await open({ width: 1440, height: 900 }, 'en', (src) => src.replace("col.style.setProperty('width', S.width + 'px');", "col.setAttribute('style', 'width:' + S.width + 'px');"));
      await openLab(p2, SETTLE); await mode(p2, 'compare'); await quiet(p2);
      const from = await cspMark(p2);
      await p2.click('[data-lab-width="mobile"]'); await frames(p2); await p2.waitForTimeout(300);
      const win = await cspSplit(p2, from);
      check('compare (control): a lab.js that writes the width as a style attribute is refused in both panes and counted as the Lab\'s, at least once for each', win.lab >= 2, win);
      await c2.close();
    }

    // control: the same watch, on a lab.js that makes two extra requests when comparison opens: one to a Lab endpoint, and one from
    // the Lab's own code to an application path. Both must be caught, the second by who started it, not by where it went.
    {
      const { ctx: c4, page: p4 } = await open({ width: 1440, height: 900 }, 'en', (src) => src.replace('    S.compare = want;\n', "    S.compare = want;\n    if (want) { K.api('/system/design-system/components/preview?id=' + encodeURIComponent(S.sel) + '&proof-control=1').catch(function () {}); fetch('/api/v1/teams?proof-control=1').catch(function () {}); }\n"));
      await openLab(p4, SETTLE);
      const n4 = await netWatch(p4);
      await mode(p4, 'compare'); await p4.waitForTimeout(500);
      await n4.stop();
      const caught = n4.seen.filter((x) => x.lab).map((x) => x.path);
      check('compare (control): a lab.js that makes two extra requests when comparison opens is caught twice, the Lab endpoint by its path and the application path by the Lab script that started it',
        caught.some((x) => /components\/preview\?id=.*proof-control=1/.test(x)) && caught.some((x) => /^\/api\/v1\/teams\?proof-control=1$/.test(x)), { caught });
      await c4.close();
    }

    // sizes and languages: side by side on a wide stage, stacked in the escape hatch and on a phone, in Arabic too
    const sizes = [];
    for (const [loc, w, h] of [['en', 1920, 1080], ['de', 980, 760], ['ar', 390, 844]]) {
      const { ctx: c3, page: p3, log: log3 } = await open({ width: w, height: h }, loc);
      await openLab(p3, SETTLE); await mode(p3, 'compare');
      sizes.push(await p3.evaluate(([loc, w]) => {
        const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
        const a = r(document.getElementById('lab-pane-a')), b = r(document.getElementById('lab-pane-b')), plate = document.getElementById('lab-plate').clientWidth;
        const doc = document.documentElement, body = document.getElementById('ds-body');
        const ctrls = [...document.querySelectorAll('[data-lab-mode], #lab-fx-b, [data-lab-swap]')];
        const reach = ctrls.every((c) => { c.scrollIntoView({ block: 'center', inline: 'center' }); const q = c.getBoundingClientRect(); const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return q.width > 0 && !!e && (e === c || c.contains(e) || (c.id === 'lab-fx-b' && e.closest('.lab-fxb'))); });
        return { loc, w, plate, side: Math.abs(a[1] - b[1]) <= 1 && b[0] >= a[2] - 1, stacked: b[1] >= a[3] - 1, pageOverflowX: doc.scrollWidth > doc.clientWidth + 1 || (body && body.scrollWidth > body.clientWidth + 1), reach,
          labelB: document.getElementById('lab-pane-b-t').textContent, dir: document.getElementById('ds-root').dir, ok: !!document.querySelector('#lab-specimen-b .lab-col') };
      }, [loc, w]));
      sizes[sizes.length - 1].labErrors = labErrors(log3).length;
      await c3.close();
    }
    const [wide, hatch, phone] = sizes;
    check('compare layout: side by side wherever the stage is at least 720 px wide (a wide window, the 980 px escape hatch), stacked where it is not (a phone), never a sideways page scroll, every control reachable, and in the reader\'s language',
      wide.plate >= 720 && phone.plate < 720 && sizes.every((x) => (x.plate >= 720 ? x.side && !x.stacked : x.stacked && !x.side) && !x.pageOverflowX && x.reach && x.ok && x.labErrors === 0) && hatch.labelB === 'Vorschau B' && phone.labelB === 'المعاينة B' && phone.dir === 'rtl', sizes);
  }

  // ══ 11. navigation (M2 / S4) ═══════════════════════════════════════════════
  // Previous and next component (the rail's order, search included, the unavailable ones too) and previous and next fixture
  // (Preview A only), from the bench header's buttons and from "[" "]" "{" "}". Each key proof has its control beside it: the
  // same key pressed with a modifier the browser keeps, typed into a field, or started inside the specimen, does nothing.
  if (want('11')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
    await openLab(page, SETTLE);
    const st = (pg) => pg.evaluate(() => {
      const m = window.__familistaLabMetrics(), a = document.activeElement, t = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
      const cur = document.querySelector('#lab-rail-body .lab-item[aria-current="true"]'), on = document.querySelector('#lab-strip .lab-fx.is-on');
      return { sel: m.selected, fx: m.fixture, fxB: m.fixtureB, compare: m.compare, zoom: m.zoom, fit: m.fit, width: m.width, c: t('lab-nav-c'), f: t('lab-nav-f'), live: t('lab-live'),
        active: a ? (a.getAttribute('data-lab-nav') || a.getAttribute('data-lab-fx') || a.id || a.tagName) : null, na: !!document.querySelector('#lab-bench .lab-plate--na'),
        current: cur ? cur.getAttribute('data-lab-id') : null, strip: [...document.querySelectorAll('#lab-strip [data-lab-fx]')].map((b) => b.getAttribute('data-lab-fx')), stripOn: on ? on.getAttribute('data-lab-fx') : null,
        off: [...document.querySelectorAll('[data-lab-nav]')].map((b) => b.getAttribute('aria-disabled')) };
    });
    const railIds = (pg) => pg.evaluate(() => [...document.querySelectorAll('#lab-rail-body [data-lab-id]')].map((b) => b.getAttribute('data-lab-id')));
    // A component step has landed when the Lab shows that component with its fixtures read, or its unavailable panel.
    const landed = (pg, id) => pg.waitForFunction((id) => window.__familistaLabMetrics().selected === id && !document.querySelector('#lab-bench .lab-wait')
      && !!(document.querySelector('#lab-bench .lab-plate--na') || document.querySelector('#lab-specimen .lab-col, #lab-void:not([hidden]), #lab-refuse:not([hidden])')), id, { timeout: 10000 }).then(() => frames(pg));
    const labNodes = (pg) => pg.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);

    // the header
    const rail0 = await railIds(page), s0 = await st(page), n = rail0.length, at0 = rail0.indexOf(s0.sel);
    const head = await page.evaluate(() => ({ inHeader: !!document.querySelector('#lab-navrow:not([hidden]) > .lab-nav') && !!(document.getElementById('lab-navrow').compareDocumentPosition(document.querySelector('.lab-bench-h')) & Node.DOCUMENT_POSITION_FOLLOWING), inTools: !!document.querySelector('.lab-tools [data-lab-nav]'),
      buttons: [...document.querySelectorAll('[data-lab-nav]')].map((b) => [b.tagName, b.getAttribute('type'), b.getAttribute('data-lab-nav'), b.getAttribute('aria-label'), b.getAttribute('aria-keyshortcuts')]) }));
    check('nav: the bench\'s own row above the name, not the tools row, holds Previous and Next component and fixture as real buttons with a name and a shortcut each, reading "Component n of m" from the rail and "Fixture n of m" from the strip',
      head.inHeader && !head.inTools && JSON.stringify(head.buttons) === JSON.stringify([['BUTTON', 'button', 'component-prev', 'Previous component', '{'], ['BUTTON', 'button', 'component-next', 'Next component', '}'], ['BUTTON', 'button', 'fixture-prev', 'Previous fixture', '['], ['BUTTON', 'button', 'fixture-next', 'Next fixture', ']']])
      && at0 >= 0 && s0.c === `Component ${at0 + 1} of ${n}` && s0.f === `Fixture ${s0.strip.indexOf(s0.fx) + 1} of ${s0.strip.length}` && s0.off[0] === 'false' && s0.off[1] === 'false', { head, c: s0.c, f: s0.f, sel: s0.sel, n });

    // Next, all the way round
    // Whether a step redrew the Next button is asked of each step on its own; a step during which the application's own late
    // repaint remounted the whole Lab (a new .lab root) cannot answer it, and is counted apart instead of being passed.
    const seq = [];
    for (let i = 1; i <= n; i++) {
      const want = rail0[(at0 + i) % n];
      await page.evaluate(() => { window.__cnb = document.querySelector('[data-lab-nav="component-next"]'); window.__labRoot = document.querySelector('.lab'); });
      await page.click('[data-lab-nav="component-next"]'); await landed(page, want);
      const s = await st(page), kept = await page.evaluate(() => document.querySelector('.lab') !== window.__labRoot ? null : document.querySelector('[data-lab-nav="component-next"]') === window.__cnb);
      seq.push({ want, sel: s.sel, cur: s.current, na: s.na, c: s.c, active: s.active, live: s.live, kept });
    }
    const naSeen = seq.filter((x) => x.na).length, remounted = seq.filter((x) => x.kept === null).length, redrawn = seq.filter((x) => x.kept === false).length;
    const bad = seq.filter((x, i) => !(x.sel === x.want && x.cur === x.want && x.c === `Component ${(at0 + i + 1) % n + 1} of ${n}` && x.active === 'component-next'));
    check('nav component: Next walks the rail\'s order and wraps back to the start; the components that cannot be previewed are visited and show their own unavailable panel; the rail marks each, the readout counts it, and focus stays on the same Next button, never redrawn',
      bad.length === 0 && seq[n - 1].sel === s0.sel && naSeen > 0 && naSeen < n && redrawn === 0 && remounted < n / 2, { n, naSeen, redrawn, remountedByTheApplication: remounted, bad: bad.slice(0, 3) });
    await page.click('[data-lab-nav="component-prev"]'); await landed(page, rail0[(at0 - 1 + n) % n]);
    const sPrev = await st(page);
    await page.click('[data-lab-nav="component-next"]'); await landed(page, s0.sel);
    const said = seq.map((x) => x.live).concat(sPrev.live);
    check('nav component: Previous goes back one, from the first to the last, and every step is announced as "Component n of m: name · Fixture 1 of k" or "· Not previewable"',
      sPrev.sel === rail0[(at0 - 1 + n) % n] && sPrev.active === 'component-prev' && said.every((x) => /^Component \d+ of \d+: .+ · (Fixture 1 of \d+|Not previewable)$/.test(x)), { prev: sPrev.sel, live: said.filter((x) => !/^Component \d+ of \d+: .+ · (Fixture 1 of \d+|Not previewable)$/.test(x)).slice(0, 3) });

    // the search decides the order
    await page.fill('#lab-q', 'chip'); await frames(page);
    const railQ = await railIds(page), sq = await st(page), atQ = railQ.indexOf(sq.sel);
    const qseq = [];
    for (let i = 0; i < railQ.length; i++) {
      const want = railQ[atQ < 0 ? i : (atQ + i + 1) % railQ.length];
      await page.click('[data-lab-nav="component-next"]'); await landed(page, want);
      const s = await st(page); qseq.push([want, s.sel, s.c]);
    }
    check('nav search: with "chip" typed, Next steps through the components the rail shows for it and no other, wrapping, and the readout counts those; where the current one is not among them the readout says "—" and Next starts at the first',
      railQ.length >= 2 && railQ.length < n && sq.c === (atQ < 0 ? '—' : `Component ${atQ + 1} of ${railQ.length}`) && qseq.every(([w, s, c]) => w === s && c === `Component ${railQ.indexOf(s) + 1} of ${railQ.length}`), { railQ, before: sq.c, qseq });
    await page.fill('#lab-q', 'versus'); await frames(page);
    const railV = await railIds(page), sv = await st(page);
    await page.click('[data-lab-nav="component-next"]'); await landed(page, railV[0]);
    const sv2 = await st(page);
    check('nav search: with one match, Next reaches it, the readout reads "Component 1 of 1", and both component buttons then say they are disabled',
      railV.length === 1 && sv.c === '—' && sv.off[0] === 'false' && sv2.sel === railV[0] && sv2.c === 'Component 1 of 1' && sv2.off[0] === 'true' && sv2.off[1] === 'true', { railV, before: [sv.c, sv.off], after: [sv2.sel, sv2.c, sv2.off] });
    await page.fill('#lab-q', ''); await frames(page);

    // fixtures: Preview A, the strip and the readout, nothing redrawn
    await page.click('[data-lab-id="lg-status-chip"]'); await landed(page, 'lg-status-chip');
    const sf = await st(page), k = sf.strip.length, f0 = sf.strip.indexOf(sf.fx);
    await page.evaluate(() => { window.__hdr = document.querySelector('.lab-bench-h'); window.__fnb = document.querySelector('[data-lab-nav="fixture-next"]'); });
    const fseq = [];
    for (let i = 1; i <= k; i++) { await page.click('[data-lab-nav="fixture-next"]'); await frames(page); fseq.push(await st(page)); }
    const kept = await page.evaluate(() => document.querySelector('.lab-bench-h') === window.__hdr && document.querySelector('[data-lab-nav="fixture-next"]') === window.__fnb);
    await page.click('[data-lab-nav="fixture-prev"]'); await frames(page);
    const fprev = await st(page);
    const fbad = fseq.filter((s, i) => { const j = (f0 + i + 1) % k; return !(s.fx === sf.strip[j] && s.stripOn === s.fx && s.f === `Fixture ${j + 1} of ${k}` && /^Fixture \d+ of \d+: /.test(s.live) && s.active === 'fixture-next' && s.sel === 'lg-status-chip'); });
    check('nav fixture: Next fixture steps Preview A through the strip in order and wraps; the strip, the readout and the announcement follow, focus stays on the button, the header is not redrawn; Previous wraps from the first to the last',
      k >= 3 && fbad.length === 0 && kept && fseq[k - 1].fx === sf.fx && fprev.fx === sf.strip[(f0 - 1 + k) % k] && fprev.active === 'fixture-prev', { k, fbad: fbad.slice(0, 2), kept, prev: fprev.fx });

    // keys
    await blur(page);
    const kpress = async (key) => { await page.keyboard.press(key); await frames(page); return st(page); };
    const kb0 = await st(page), kR = await kpress(']'), kL = await kpress('[');
    await page.keyboard.press('}'); await landed(page, rail0[(rail0.indexOf('lg-status-chip') + 1) % n]);
    const kN = await st(page);
    await page.keyboard.press('{'); await landed(page, 'lg-status-chip');
    const kP = await st(page);
    await page.focus('.lab-fx.is-on'); await page.keyboard.press('}'); await landed(page, kN.sel);
    const kT = await st(page);
    await page.keyboard.press('{'); await landed(page, 'lg-status-chip');
    check('nav keys: "]" and "[" step the fixtures, "}" and "{" the components, without moving focus; a "}" pressed on a fixture tab leaves focus on the new component\'s current fixture tab',
      kR.fx === kb0.strip[(kb0.strip.indexOf(kb0.fx) + 1) % kb0.strip.length] && kL.fx === kb0.fx && kN.sel !== 'lg-status-chip' && kP.sel === 'lg-status-chip' && kR.active === 'BODY' && kN.active === 'BODY' && kT.sel === kN.sel && kT.active === kT.stripOn && !!kT.stripOn,
      { fx: [kb0.fx, kR.fx, kL.fx], sel: [kN.sel, kP.sel], active: [kR.active, kN.active, kT.active, kT.stripOn] });

    await blur(page);
    await page.evaluate(() => { window.__kd = []; document.addEventListener('keydown', (e) => window.__kd.push([e.key, e.defaultPrevented])); });
    const m0 = await st(page);
    for (const key of ['Control+BracketRight', 'Alt+BracketRight', 'Meta+BracketRight', 'Control+Alt+BracketRight', 'Control+Shift+BracketRight', 'Alt+Shift+BracketRight', 'Meta+Shift+BracketLeft']) await page.keyboard.press(key);
    await frames(page);
    const m1 = await st(page), kd = await page.evaluate(() => window.__kd);
    // A Ctrl+Alt the browser itself reports as AltGr is how a German layout on Windows types "]": that one is the character.
    const altgr = await page.evaluate(() => { const e = new KeyboardEvent('keydown', { key: ']', code: 'Digit9', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return [e.getModifierState('AltGraph'), e.defaultPrevented]; });
    await frames(page);
    const m2 = await st(page);
    const plain = await page.evaluate(() => { const e = new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return [e.getModifierState('AltGraph'), e.defaultPrevented]; });
    await frames(page);
    const m3 = await st(page);
    check('nav keys (control): with Ctrl, Alt, Cmd or Ctrl+Alt the same keys are left to the browser: not prevented, and nothing steps; a Ctrl+Alt "]" the browser reports as AltGr steps, one it does not report so does not',
      m1.fx === m0.fx && m1.sel === m0.sel && kd.length >= 7 && kd.every((x) => x[1] === false) && altgr[0] === true && altgr[1] === true && m2.fx !== m0.fx && plain[0] === false && plain[1] === false && m3.fx === m2.fx,
      { fx: [m0.fx, m1.fx, m2.fx, m3.fx], kd, altgr, plain });
    await page.focus('#lab-q'); await page.keyboard.type('[]{}'); await frames(page);
    const ty = await st(page), tyv = await page.inputValue('#lab-q');
    await page.fill('#lab-q', ''); await frames(page);
    check('nav keys: "[", "]", "{" and "}" typed into the search are typed, and step nothing', tyv === '[]{}' && ty.fx === m3.fx && ty.sel === m3.sel, { typed: tyv, fx: [m3.fx, ty.fx] });

    // layouts that type no Latin bracket: the physical key is read, and only for a non-Latin character
    await blur(page);
    const cdp = await ctx.newCDPSession(page);
    const raw = async (key, code, vk, shift) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, unmodifiedText: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
      await frames(page); return st(page);
    };
    const a0 = await st(page);
    const aR = await raw('د', 'BracketRight', 221), aL = await raw('ج', 'BracketLeft', 219), aDe = await raw('ü', 'BracketLeft', 219);
    const aF = await raw('ب', 'KeyF', 70);
    await page.keyboard.press('0'); await frames(page);
    const aRu = await raw('Ъ', 'BracketRight', 221, true); await landed(page, rail0[(rail0.indexOf('lg-status-chip') + 1) % n]);
    const aRu2 = await st(page);
    await page.click('[data-lab-id="lg-status-chip"]'); await landed(page, 'lg-status-chip');
    check('nav keys: on an Arabic layout the bracket keys (د, ج) step the fixtures and the F key (ب) fits the stage; a Russian Shift+Ъ steps the components; a German ü on the same key does nothing',
      aR.fx === a0.strip[(a0.strip.indexOf(a0.fx) + 1) % a0.strip.length] && aL.fx === a0.fx && aDe.fx === a0.fx && aF.fit === true && aRu2.sel !== 'lg-status-chip' && aRu.sel !== undefined,
      { fx: [a0.fx, aR.fx, aL.fx, aDe.fx], fit: aF.fit, ru: aRu2.sel });
    await cdp.detach();

    // Single and Compare
    await page.click(`[data-lab-id="${rail0[0]}"]`); await landed(page, rail0[0]);
    await page.click('[data-lab-mode="compare"]'); await frames(page);
    await page.click('[data-lab-zoom="out"]'); await page.click('[data-lab-zoom="out"]'); await page.click('[data-lab-width="mobile"]'); await frames(page);
    const c0 = await st(page);
    await page.click('[data-lab-nav="component-next"]'); await landed(page, rail0[1]);
    const c1 = await st(page);
    const hasB = await page.evaluate(() => !!document.querySelector('#lab-specimen-b .lab-col'));
    check('nav compare: Next component changes both previews, Preview A to the new component\'s first fixture and Preview B to the one after it (the S3 rule), says both, and keeps the zoom and the width',
      c1.compare && hasB && c1.sel === rail0[1] && c1.fx === c1.strip[0] && c1.fxB === c1.strip[1 % c1.strip.length] && c1.zoom === c0.zoom && c0.zoom < 1 && c1.width === 390 && c1.fit === c0.fit
      && new RegExp('^Component 2 of ' + n + ': .+ · Fixture 1 of \\d+ · Preview B: .+$').test(c1.live), { c0: [c0.zoom, c0.width], c1: [c1.sel, c1.fx, c1.fxB, c1.zoom, c1.width, c1.live] });
    await page.click('[data-lab-nav="fixture-next"]'); await frames(page);
    const c2 = await st(page);
    await page.click('[data-lab-swap]'); await frames(page);
    const c3 = await st(page);
    await page.focus('#lab-fx-b'); await page.keyboard.press('}'); await page.keyboard.press(']'); await frames(page);
    const c4 = await st(page);
    check('nav compare: Next fixture moves Preview A only; Swap still exchanges the panes and the readout follows Preview A; "}" and "]" on Preview B\'s selector step nothing',
      c2.fx === c1.strip[1] && c2.fxB === c1.fxB && c2.f === `Fixture 2 of ${c1.strip.length}` && c3.fx === c2.fxB && c3.fxB === c2.fx && c3.f === `Fixture ${c3.strip.indexOf(c3.fx) + 1} of ${c3.strip.length}` && c4.sel === c3.sel && c4.fx === c3.fx,
      { a: [c1.fx, c2.fx, c3.fx, c4.fx], b: [c1.fxB, c2.fxB, c3.fxB], f: [c2.f, c3.f] });
    await page.click('[data-lab-zoom="reset"]'); await page.click('[data-lab-width="fill"]'); await page.click('[data-lab-mode="single"]'); await frames(page);

    // focus after the room redraws, and the stage's own boundary
    const rest = [];
    for (const act of ['component-next', 'fixture-prev']) { await page.focus(`[data-lab-nav="${act}"]`); const ok = await remount(page); rest.push([act, ok, (await st(page)).active]); }
    check('nav focus: after the room redraws the Lab, focus is back on the navigation button that had it', rest.every((x) => x[1] && x[0] === x[2]), rest);
    const iso = await page.evaluate(() => {
      const fx = () => window.__familistaLabMetrics().fixture, before = fx(), el = document.querySelector('#lab-specimen .lab-col').firstElementChild || document.querySelector('#lab-specimen .lab-col');
      const e1 = new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true, composed: true }); el.dispatchEvent(e1);
      const mid = fx();
      const e2 = new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true }); document.body.dispatchEvent(e2);
      return { before, mid, after: fx(), inside: e1.defaultPrevented, outside: e2.defaultPrevented };
    });
    check('nav isolation: a "]" that starts inside the specimen never reaches the Lab\'s navigation; (control) the same key outside it steps', iso.mid === iso.before && !iso.inside && iso.after !== iso.before && iso.outside, iso);

    // stability and cost: 200 cached steps
    const client = await ctx.newCDPSession(page);
    await client.send('Performance.enable'); await client.send('HeapProfiler.enable');
    const heap = async () => { await client.send('HeapProfiler.collectGarbage'); return (await client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value; };
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10 }; };
    await page.click('[data-lab-id="lg-status-chip"]'); await landed(page, 'lg-status-chip'); await blur(page);
    const dom0 = await labNodes(page), h0 = await heap(), sStart = await st(page);
    const runs = await page.evaluate(async ({ n, k }) => {
      window.__clsNav = []; const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__clsNav.push({ v: e.value, outside: (e.sources || []).some((s) => s.node && s.node.nodeType === 1 && s.node.closest('.lab') && !s.node.closest('#lab-plate')) }))); po.observe({ type: 'layout-shift' });
      const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { comp: [], compSync: [], fix: [], fixSync: [] };
      for (let i = 0; i < n * Math.ceil(100 / n); i++) { const t0 = performance.now(); document.querySelector('[data-lab-nav="component-next"]').click(); await fr(); out.comp.push(performance.now() - t0); out.compSync.push(window.__familistaLabMetrics().switchMs); }
      for (let i = 0; i < k * Math.ceil(100 / k); i++) { const t0 = performance.now(); document.querySelector('[data-lab-nav="fixture-next"]').click(); await fr(); out.fix.push(performance.now() - t0); out.fixSync.push(window.__familistaLabMetrics().switchMs); }
      po.disconnect(); return out;
    }, { n, k });
    const h1 = await heap(), dom1 = await labNodes(page), sEnd = await st(page);
    const shifts = await page.evaluate(() => window.__clsNav.filter((e) => e.outside).length);
    const measure = { componentSteps: runs.comp.length, componentNavToFrameMedianMs: stat(runs.comp).median, componentNavToFrameP95Ms: stat(runs.comp).p95, componentNavSyncMedianMs: stat(runs.compSync).median, componentNavSyncP95Ms: stat(runs.compSync).p95,
      fixtureSteps: runs.fix.length, fixtureNavToFrameMedianMs: stat(runs.fix).median, fixtureNavToFrameP95Ms: stat(runs.fix).p95, fixtureNavSyncMedianMs: stat(runs.fixSync).median, fixtureNavSyncP95Ms: stat(runs.fixSync).p95,
      domBefore: dom0, domAfter: dom1, heapGrowthKB: Math.round((h1 - h0) / 1024), layoutShiftsOutsideStage: shifts };
    console.log('MEASURE ' + JSON.stringify(measure));
    // M3/S3.2 D1: component navigation is the official navigation measurement; fixture navigation and the split are diagnostic.
    {
      const sc = stat(runs.comp), sf = stat(runs.fix), interval = await frameInterval(page);
      const browser = runs.comp.map((v, i) => v - runs.compSync[i]);
      emitMetric('nav.component.median', { value: sc.median, unit: 'ms', n: runs.comp.length, max: maxOf(runs.comp) });
      emitMetric('nav.component.p95', { value: sc.p95, unit: 'ms', n: runs.comp.length, max: maxOf(runs.comp) });
      emitMetric('diag.nav.component.app.median', { value: stat(runs.compSync).median, unit: 'ms', n: runs.compSync.length });
      emitMetric('diag.nav.component.browser.median', { value: stat(browser).median, unit: 'ms', n: browser.length });
      emitMetric('diag.nav.component.frames', { unit: 'frames', interval, n: runs.comp.length, distribution: frameCounts(runs.comp, interval) });
      emitMetric('diag.nav.fixture.median', { value: sf.median, unit: 'ms', n: runs.fix.length });
      emitMetric('diag.nav.fixture.p95', { value: sf.p95, unit: 'ms', n: runs.fix.length, max: maxOf(runs.fix) });
    }
    check('nav stability: over 200 cached steps (components round the rail, fixtures round the strip) the Lab ends with exactly its nodes, back where it started, and nothing outside the stage shifted',
      runs.comp.length + runs.fix.length >= 200 && dom1 === dom0 && sEnd.sel === sStart.sel && sEnd.fx === sStart.fx && shifts === 0, measure);
    const split = await cspSplit(page);
    check('nav: no Lab or unexplained CSP violation, and no console error, after everything above', split.lab === 0 && split.unexplained === 0 && labErrors(log).length === 0, { csp: split, errors: labErrors(log) });
    await ctx.close();

    // German and Arabic: the names, the readouts, and arrows that point the way the page reads
    const langs = [];
    for (const loc of ['de', 'ar']) {
      const { ctx: c5, page: p5, log: l5 } = await open({ width: 1440, height: 900 }, loc);
      await openLab(p5, SETTLE);
      langs.push(await p5.evaluate((loc) => {
        const b = (a) => document.querySelector(`[data-lab-nav="${a}"]`), x = (a) => b(a).getBoundingClientRect().left;
        return { loc, labels: ['component-prev', 'component-next', 'fixture-prev', 'fixture-next'].map((a) => b(a).getAttribute('aria-label')), c: document.getElementById('lab-nav-c').textContent, f: document.getElementById('lab-nav-f').textContent,
          glyph: b('component-prev').textContent, prevRight: x('component-prev') > x('component-next'), dir: getComputedStyle(document.querySelector('.lab')).direction };
      }, loc));
      langs[langs.length - 1].labErrors = labErrors(l5).length;
      await c5.close();
    }
    const [de, ar] = langs;
    check('nav languages: German and Arabic name every button and readout in the reader\'s language; in Arabic "previous" points right and stands on the right, in German it points left and stands on the left',
      JSON.stringify(de.labels) === JSON.stringify(['Vorherige Komponente', 'Nächste Komponente', 'Vorheriger Musterfall', 'Nächster Musterfall']) && /^Komponente \S+ von \S+$/.test(de.c) && /^Musterfall \S+ von \S+$/.test(de.f) && de.glyph === '‹' && !de.prevRight && de.dir === 'ltr'
      && ar.labels.every((l) => /[؀-ۿ]/.test(l)) && /^المكوّن /.test(ar.c) && /^النموذج /.test(ar.f) && ar.glyph === '›' && ar.prevRight && ar.dir === 'rtl' && de.labErrors === 0 && ar.labErrors === 0, langs);
  }

  // ══ 6. accessibility, languages, directions and sizes (--axe) ══════════════
  if (WANT_AXE && want('6')) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (!fs.existsSync(axePath)) skip('accessibility: axe across en, de, ar and four sizes', 'axe-core is not installed (' + axePath + ')');
    else {
      const AXE = fs.readFileSync(axePath, 'utf8');
      const views = [['desktop', 1440, 900], ['laptop', 1100, 760], ['tablet', 834, 1112], ['mobile', 390, 844]];
      for (const loc of ['en', 'de', 'ar']) for (const [vn, w, h] of views) {
        const { ctx, page, log } = await open({ width: w, height: h }, loc);
        await openLab(page, SETTLE);
        let axeRetries = 0;
        const run = async (label) => { const r = await steady(page, () => axeOnce(label)); axeRetries += r.retries; return r.out; };
        const axeOnce = (label) => page.evaluate(async (src) => {
          if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
          const from = (window.__csp || []).length;
          const r = await window.axe.run({ include: ['#pg-design-system'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
          await new Promise((done) => setTimeout(done, 150));          // let the policy's own reports for this run arrive
          (window.__axeRanges = window.__axeRanges || []).push([from, (window.__csp || []).length]);
          const b = document.getElementById('ds-body');
          return { violations: r.violations.map((v) => v.id + ':' + v.nodes.length + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join('|')), overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, bodyOverflow: b.scrollWidth > b.clientWidth + 1, missing: window.__familistaDesignSystemMissing ? window.__familistaDesignSystemMissing() : [], dir: document.getElementById('ds-root').dir };
        }, AXE).then((x) => ({ label, ...x }));
        const states = [await run('first fixture')];
        await page.click('[data-lab-id="lg-float"]'); await page.waitForSelector('#lab-specimen .lg-float-bg'); await frames(page);
        if (loc === 'ar') { await page.click('[data-lab-dir="rtl"]'); }
        states.push(await run('overlay fixture'));
        await page.click('[data-lab-zoom="out"]', { force: true }); await page.click('[data-lab-zoom="out"]', { force: true }); await frames(page);
        states.push(await run('overlay fixture, zoomed to 80%'));
        await page.click('[data-lab-zoom="reset"]', { force: true });
        await page.click('[data-lab-width="mobile"]'); await frames(page);
        states.push(await run('overlay fixture, at the Mobile width'));
        await page.click('[data-lab-mode="compare"]'); await page.waitForSelector('#lab-specimen-b .lab-col', { state: 'attached' }); await frames(page);
        states.push(await run('comparison, at the Mobile width'));
        await page.click('[data-lab-mode="single"]'); await frames(page);
        await page.click('[data-lab-width="fill"]'); await frames(page);
        await page.click('[data-lab-tab="sanitization"]'); states.push(await run('sanitization tab'));
        // An unavailable component, the first the rail lists, whichever it is: opened through its group if the group is closed.
        const na = await page.evaluate(() => {
          const b = document.querySelector('#lab-rail-body [data-lab-id][aria-disabled="true"]'); if (!b) return null;
          const g = b.closest('.lab-grp'), gb = g ? g.querySelector('[data-lab-grp]') : null;
          return { id: b.getAttribute('data-lab-id'), grp: gb ? gb.getAttribute('data-lab-grp') : null, open: gb ? gb.getAttribute('aria-expanded') === 'true' : true };
        });
        if (na && na.grp && !na.open) await page.click(`[data-lab-grp="${na.grp}"]`);
        if (na) { await page.click(`[data-lab-id="${na.id}"]`, { force: true }); await frames(page); states.push(await run('unavailable component ' + na.id)); }
        else states.push({ label: 'unavailable component', violations: ['no unavailable component is listed, so this state was not checked'], missing: [] });
        await page.screenshot({ path: path.join(OUT, `axe-${loc}-${vn}.png`) });
        const v = states.flatMap((s) => s.violations.map((x) => s.label + ': ' + x));
        const missing = [...new Set(states.flatMap((s) => s.missing))];
        const ovf = states.some((s) => s.overflowX || s.bodyOverflow);
        const errs = labErrors(log);
        const split = await cspSplit(page);
        check(`accessibility ${loc} ${vn}: 0 axe violations (WCAG 2.2 A/AA rules), no horizontal overflow, nothing untranslated, no console error, no Lab or unexplained CSP violation`, v.length === 0 && !ovf && missing.length === 0 && (loc !== 'ar' || states[0].dir === 'rtl') && errs.length === 0 && split.lab === 0 && split.unexplained === 0, { violations: v, overflow: ovf, missing, dir: states[0].dir, errors: errs, csp: split, probeRetries: axeRetries });
        await ctx.close();
      }
    }
  }

  // ══ 6b. the accessibility check can fail (--axe) ═══════════════════════════
  if (WANT_AXE && want('6')) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (fs.existsSync(axePath)) {
      const AXE = fs.readFileSync(axePath, 'utf8');
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en');
      await openLab(page, SETTLE);
      // Break what is protected: a control with no accessible name, and a name that does not match its visible label.
      const broken = await page.evaluate(async (src) => {
        if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
        const host = document.querySelector('.lab');
        const b = document.createElement('button'); b.type = 'button'; host.appendChild(b);
        const from = (window.__csp || []).length;
        const r = await window.axe.run({ include: ['#pg-design-system'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        await new Promise((done) => setTimeout(done, 150));
        (window.__axeRanges = window.__axeRanges || []).push([from, (window.__csp || []).length]);
        return r.violations.map((v) => v.id);
      }, AXE);
      check('accessibility (control): a button with no name inside the Lab is reported by the same axe run, so a clean result means something', broken.includes('button-name'), broken);
      const probeSplit = await cspSplit(page);
      check('csp: the only violation an axe run causes is its own fetch of the web-font stylesheet, attributed to the tool; none to the Lab, none unexplained', probeSplit.axeProbe >= 1 && probeSplit.lab === 0 && probeSplit.unexplained === 0, probeSplit);
      await ctx.close();
    }
  }

  // ══ 7. focus, errors and CSP in a real browser, in every view ═══════════════
  // Not axe: this needs no accessibility engine, so it runs by default. It is what keeps the Lab usable by keyboard when
  // the room redraws under it, and what attributes every console error and CSP violation to its owner.
  if (want('7')) {
    // Horizontal overflow of the page, the room body or the Lab; strings the room's catalogue has no entry for (always empty in
    // English, where the key is the text, so that part of the proof means something only in de and ar); and the room's direction.
    const viewProbe = (page) => page.evaluate(() => {
      const b = document.getElementById('ds-body'); const lab = document.querySelector('.lab');
      return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1 || (lab ? lab.scrollWidth > lab.clientWidth + 1 : false), missing: window.__familistaDesignSystemMissing ? window.__familistaDesignSystemMissing() : ['no catalogue probe'], dir: document.getElementById('ds-root').dir };
    });
    const NO_RESTORE = (src) => src.replace('function restoreFocus() {', 'function restoreFocus() { return;');
    const NO_EXPIRY = (src) => src.replace('var FOCUS_MS = 2500;', 'var FOCUS_MS = 1e12;');
    for (const loc of ['en', 'de', 'ar']) for (const [vn, w, h] of [['desktop', 1440, 900], ['laptop', 1100, 760], ['tablet', 834, 1112], ['mobile', 390, 844]]) {
      const { ctx, page, log } = await open({ width: w, height: h }, loc);
      await openLab(page, SETTLE);
      let retries = 0;
      const probe = async () => { const r = await steady(page, () => viewProbe(page)); retries += r.retries; return r.out; };
      const trials = await focusTrials(page);
      const stale = await staleRemount(page);
      const st = await probe();
      const errs = labErrors(log);
      const split = await cspSplit(page);
      check(`focus ${loc} ${vn}: focus returns to the same control after the room redraws the Lab (every control: rail, fixture, search, inspector, direction, zoom), is not pulled back after 2.5 s, and the view has no overflow, no untranslated text, no console error, no Lab or unexplained CSP violation`,
        trials.every((t) => t.ok) && stale.kept && !st.overflow && st.missing.length === 0 && errs.length === 0 && split.lab === 0 && split.unexplained === 0 && ((loc === 'ar') === (st.dir === 'rtl')),
        { trials, stale, overflow: st.overflow, missing: st.missing, dir: st.dir, errors: errs, csp: split, probeRetries: retries });
      await ctx.close();
    }

    // Controls: each breaks the behaviour a proof above protects and shows the same measurement turning red.
    {
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en', NO_RESTORE);
      await openLab(page, SETTLE);
      const trials = await focusTrials(page);
      const unapplied = trials.filter((t) => !t.applied);
      if (unapplied.length) fail('focus (control): control not applied: the controls could not be focused, so the loss of focus was not measured', trials);
      else check('focus (control): with restoreFocus disabled, the same redraw drops focus on the page for every control, so the proof can fail', trials.length === FOCUS_TARGETS.length && trials.every((t) => t.applied && t.before !== 'BODY' && t.remounted && !t.ok && t.after === 'BODY'), trials);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en', NO_EXPIRY);
      await openLab(page, SETTLE);
      await page.keyboard.press('/'); await page.keyboard.type('chip');
      const stale = await staleRemount(page);
      check('focus (control): with the 2.5 s limit removed, a redraw long after the last focus steals it back into the Lab, so the no-steal proof can fail', stale.remounted && !stale.kept, stale);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, 'de');
      await openLab(page, SETTLE);
      const clean = await viewProbe(page);
      await page.evaluate(() => {
        window.__familistaDesignSystemKit.T('A string the German catalogue does not have');                                   // an untranslated string
        const wide = document.createElement('div'); wide.style.setProperty('width', '3000px'); wide.style.setProperty('height', '4px'); document.querySelector('.lab').appendChild(wide);   // a Lab that overflows
      });
      const broken = await viewProbe(page);
      check('view (control): an untranslated string and a 3000px-wide element inside the Lab are each reported by the same probe the views use, so a clean view means something',
        !clean.overflow && clean.missing.length === 0 && broken.overflow && broken.missing.includes('A string the German catalogue does not have'), { clean, broken });
      await ctx.close();
    }
    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
      await openLab(page, SETTLE);
      const mark = log.errors.length;
      await page.evaluate(() => {
        console.error('lab-control-console-error');
        setTimeout(() => { throw new Error('lab-control-page-error'); }, 0);
        const s = document.createElement('script'); s.src = '/design-system/lab-control-missing.js'; document.head.appendChild(s);
      });
      await page.waitForTimeout(600);
      const fresh = labErrors(log).slice(0);
      check('errors (control): a console error, a page error and a failed load of a Lab file are each attributed to the Lab, so the error proof can fail',
        fresh.some((e) => /lab-control-console-error/.test(e)) && fresh.some((e) => /lab-control-page-error/.test(e)) && fresh.some((e) => /lab-control-missing/.test(e)) && log.errors.length >= mark + 2, fresh);
      // a notice that does NOT name a Lab file stays out of the Lab's count but is kept, not dropped
      check('errors: network and CSP notices are kept with their URL, never discarded, and only those naming a Lab file count against the Lab', log.notices.length >= 1 && log.notices.every((n) => typeof n.url === 'string'), { notices: log.notices.length, forLab: log.notices.filter((n) => LAB_URL.test(n.url) || LAB_URL.test(n.text)).length });
      await ctx.close();
    }
    {
      // 1. By element: a violation raised on a node that is inside the Lab, from a script that says nothing about the Lab.
      // Measured from a baseline taken immediately before the injection, so the application's late painting cannot move it. The
      // injected Lab node must still be in the Lab afterwards: if the room redrew the Lab under it the report may have been filed
      // against the document, nothing was measured, and the injection is repeated once. A node that stayed and was not counted
      // is a failure of the classifier, and is never retried.
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en');
      await openLab(page, SETTLE);
      const attempts = [];
      for (let n = 0; n < 2; n++) {
        await quiet(page);
        const from = await cspMark(page);
        await page.evaluate(() => {
          const inLab = document.createElement('div'); inLab.setAttribute('style', 'color:red'); document.querySelector('.lab').appendChild(inLab); window.__ctlLab = inLab;
          const sc = document.createElement('script'); sc.textContent = 'window.__ran = 1'; document.head.appendChild(sc);                       // inline script: blocked, and not the Lab's
          fetch('https://fonts.googleapis.com/css2?family=Inter').catch(() => {});                                                              // the axe-probe URL, but outside any axe run
          const gone = document.createElement('div'); document.body.appendChild(gone); gone.setAttribute('style', 'color:red'); gone.remove();  // raised, then the node removed: no element, no source
        });
        await quiet(page);
        const win = await cspSplit(page, from);
        const stayed = await page.evaluate(() => !!(window.__ctlLab && window.__ctlLab.isConnected && window.__ctlLab.closest('.lab')));
        attempts.push({ from, stayed, win });
        if (stayed) break;
      }
      const last = attempts[attempts.length - 1];
      const ran = await page.evaluate(() => window.__ran === 1);
      if (!last.stayed) fail('csp (control): control not applied: the Lab was redrawn under the injected node twice, so nothing was measured', { attempts });
      else check('csp (control): an inline style on a Lab element is counted as the Lab\'s (exactly once); an inline script, the axe-probe URL fetched outside an axe run and a report with no element and no source are unexplained; the policy still stops the script',
        last.win.lab === 1 && last.win.axeProbe === 0 && last.win.unexplained >= 3 && !ran, { attempts, scriptRan: ran });
      await ctx.close();
    }
    {
      // 2. By source: a Lab script writes an inline style and removes the node in the same task, so Chromium reports it against the
      // document. Only the script that raised it says whose it is.
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en', (src) => src.replace('function mount(host, kit) {', "function mount(host, kit) { (function () { var q = document.createElement('div'); document.body.appendChild(q); q.setAttribute('style', 'color:red'); q.remove(); })();"));
      await openLab(page, SETTLE);
      await quiet(page);
      const split = await cspSplit(page);
      const entry = await page.evaluate(() => (window.__csp || []).filter((c) => /design-system\/lab\.js/.test(c.src)).map((c) => ({ d: c.d, inLab: c.inLab, src: c.src })));
      check('csp (control): an inline style written by lab.js and removed in the same task is still counted as the Lab\'s, by its source file, though the element is gone', split.lab >= 1 && entry.length >= 1 && entry.every((e) => !e.inLab), { split, entry });
      await ctx.close();
    }
    {
      // 3. By source, the other way: a first-party script that is not a Lab file is the application's, not the Lab's. Measured from a
      // baseline taken immediately before the injection: the application's own late painting adds application reports of its own
      // for seconds after the page is quiet, so the control looks for the ONE report whose source is the injected script, and
      // requires that nothing else in the window is the Lab's or unexplained. Extra application reports are expected and counted;
      // an extra Lab or unexplained report is not, and fails.
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en');
      await ctx.route(/\/app-control\.js$/, (r) => r.fulfill({ contentType: 'application/javascript', body: "var d = document.createElement('div'); document.body.appendChild(d); d.setAttribute('style', 'color:red'); d.remove();" }));
      await openLab(page, SETTLE);
      await quiet(page);
      const from = await cspMark(page);
      await page.evaluate(() => { const s = document.createElement('script'); s.src = '/app-control.js'; document.head.appendChild(s); });
      await quiet(page);
      const win = await cspSplit(page, from);
      const own = await page.evaluate((f) => (window.__csp || []).slice(f).filter((c) => c.src === '/app-control.js').map((c) => ({ d: c.d, inLab: c.inLab })), from);
      check('csp (control): the same write from a first-party script that is not a Lab file is counted as the application\'s (one report from that script) and adds nothing to the Lab\'s or the unexplained count',
        own.length === 1 && own[0].d === 'style-src-attr' && !own[0].inLab && win.application >= 1 && win.lab === 0 && win.unexplained === 0, { win, own });
      await ctx.close();
    }
  }

  // ══ 12. the room under background data (M3 / S1) ═══════════════════════════
  // The Design System room draws no club data. Until M3 / S1 it was listed with the pages that do (app.js _FAM_PAGE_RENDER), so
  // every club-data change redrew it and mounted the Lab again under the reader: a click pressed before the redraw and released
  // after it landed on a replaced element and was lost, the bench scrolled back to the top, and the room read its overview again.
  // The room was also drawn on entry only when the data had moved since its last draw, so coming back to it unchanged left the Lab
  // its teardown had unbound on screen, deaf to the pointer. These proofs hold the room still under club data, and hold every
  // redraw that must still happen: the first entry, every later entry, Refresh, the room's language, its sections, and a page whose
  // room is missing. Each control serves app.js or lab.js with the fix taken out and requires the same measurement to turn red.
  if (want('12')) {
    const CLUB_READ = /^\/api\/v1\/(analytics|players|matches|training|transfer-market)(\/|\?|$)/;
    const mounts = (pg) => (LAB_MOUNTS.get(pg) || []).length;
    const renders = (pg) => pg.evaluate(() => window.__proofRenders);
    const fromRoom = (seen) => seen.filter((x) => x.by.some((u) => /^\/design-system\//.test(u)));
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10, n: s.length }; };
    const SCROLLERS = ['#ds-body', '#lab-rail-body', '.lab-bench', '#lab-insp'];
    const view = (pg) => pg.evaluate((sc) => {
      const m = window.__familistaLabMetrics();
      return { sel: m.selected, fixture: m.fixture, fixtureB: m.fixtureB, zoom: m.zoom, fit: m.fit, width: m.width, compare: m.compare, dir: m.dir, q: document.getElementById('lab-q').value,
        scroll: sc.map((q) => { const e = document.querySelector(q); return e ? e.scrollTop : null; }), live: document.getElementById('lab-live').textContent };
    }, SCROLLERS);
    const selects = (pg, id) => pg.waitForFunction((i) => window.__familistaLabMetrics().selected === i, id, { timeout: 1500 }).then(() => true, () => false);
    // A click pressed on a rail item, a club-data change, then the release: did the press land? `target` is a component id.
    async function splitClick(pg, target) {
      const b = await pg.evaluate((t) => { const e = document.querySelector(`[data-lab-id="${t}"]`); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, target);
      await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await pg.mouse.down();
      await pg.evaluate(() => window._famDataChanged());
      await pg.waitForTimeout(150);
      await pg.mouse.up();
      return selects(pg, target);
    }
    // The listeners on `document`, from the browser's own record: the Lab adds three keyboard listeners there on each mount and
    // must take them away on the next, so the number stays put however often the room is redrawn.
    async function docListeners(pg) {
      const cdp = await pg.context().newCDPSession(pg);
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      await cdp.detach();
      return listeners.length;
    }
    // A control whose edit cannot be applied (the code it removes is not there) is a FAIL that says so, never a crash or a pass.
    async function control(name, fn) {
      try { await fn(); } catch (e) { fail(name + ': control not applied: ' + String(e.message || e).split('\n')[0]); }
    }

    // start-up: one draw, one Lab mount per opening, no club data
    {
      const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
      LAB_PAGE = page;
      await page.click('[data-ds-nav="lab"]');
      await page.waitForSelector('#lab-specimen .lab-col', { timeout: 30000 });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) { /* the counts below decide */ }
      await page.waitForTimeout(3000);
      const r = await renders(page), m = mounts(page);
      const club = log.requests.filter((x) => x[2] === BASE && CLUB_READ.test(x[1]));
      check('room start-up: a deep link into the Design System draws the room once and mounts the Lab once when it is opened, and the club data the room never reads is not read',
        r === 1 && m === 1 && club.length === 0, { renders: r, labMounts: m, clubReads: club.map((x) => x[0] + ' ' + x[1]) });
      await ctx.close();
    }

    const { ctx, page, log } = await open({ width: 1100, height: 700 }, 'en');
    await openLab(page, SETTLE);
    await page.click('[data-lab-id="lg-chip"]');
    await page.waitForFunction(() => window.__familistaLabMetrics().selected === 'lg-chip' && window.__familistaLabMetrics().fixture);
    const fx = await page.evaluate(() => [...document.querySelectorAll('.lab-fx')].map((b) => b.getAttribute('data-lab-fx')));
    await page.click(`[data-lab-fx="${fx[1]}"]`); await frames(page);
    await page.click('[data-lab-mode="compare"]'); await frames(page);
    await page.click('[data-lab-zoom="in"]', { force: true }); await page.click('[data-lab-zoom="in"]', { force: true }); await frames(page);

    // one club-data change: nothing in the room moves
    {
      const scrolled = await page.evaluate((sc) => sc.map((q) => { const e = document.querySelector(q); if (!e || e.scrollHeight - e.clientHeight < 8) return 0; e.scrollTop = Math.min(40, e.scrollHeight - e.clientHeight); return e.scrollTop; }), SCROLLERS);
      await page.focus('[data-lab-zoom="in"]');
      await page.evaluate(() => { window.__mkFocus = document.activeElement; window.__mkSpec = document.getElementById('lab-specimen'); });
      const before = await view(page);
      const net = await netWatch(page);
      const ch = await dataChange(page, 1000);
      await net.stop();
      const after = await view(page);
      const kept = await page.evaluate(() => ({ focus: document.activeElement === window.__mkFocus && window.__mkFocus !== document.body, specimen: document.getElementById('lab-specimen') === window.__mkSpec }));
      const own = fromRoom(net.seen);
      if (!(scrolled[1] > 0 && scrolled[2] > 0)) fail('room data change: control not applied: the rail and the bench could not be scrolled, so a lost scroll position could not be seen', { scrolled });
      else check('room data change: a club-data change leaves the room alone: the same room, Lab and specimen elements, no room render, no request from the room or the Lab, nothing written to the live region, focus on the same element, and every scroll position, the selection, both fixtures, Compare, zoom, width, Fit, direction and search exactly as they were',
        ch.same && ch.renders === 0 && ch.writes.length === 0 && kept.focus && kept.specimen && own.length === 0 && JSON.stringify(after) === JSON.stringify(before), { change: ch, kept, roomRequests: own.map((x) => x.method + ' ' + x.path), scrolled, before, after });
    }
    // what a club-data change costs the main thread while the room is open: from the call to the next task, so a redraw scheduled
    // as a promise is counted with it. The next task is a MessageChannel message, not a timer: nested timers are clamped to 4 ms,
    // which would be measured instead of the room.
    {
      const cost = await page.evaluate(async () => {
        const ch = new MessageChannel(), next = () => new Promise((r) => { ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
        const out = [];
        for (let i = 0; i < 43; i++) { const t0 = performance.now(); window._famDataChanged(); await next(); out.push(performance.now() - t0); await new Promise((r) => setTimeout(r, 40)); }
        return out.slice(3);
      });
      await page.waitForTimeout(800);
      const s = stat(cost);
      console.log('MEASURE ' + JSON.stringify({ dataChangeToNextTaskMedianMs: s.median, dataChangeToNextTaskP95Ms: s.p95, runs: s.n }));
      // Gated on the median: one slow run on a busy machine (a garbage collection, another task) is the p95 of 40 runs, and it is
      // reported. The redraw this replaces cost a median of hundreds of milliseconds, so the margin is not the threshold's.
      check('room data change: a club-data change costs the open room a median of at most 2 ms of main-thread work to the next task (40 runs after 3 warm-ups; p95 reported)', s.n === 40 && s.median <= 2, s);
    }
    // a click pressed before a club-data change and released after it
    {
      const lost = [];
      for (let i = 0; i < 10; i++) { const target = i % 2 ? 'lg-chip' : 'lg-metric'; if (!(await splitClick(page, target))) lost.push(target); }
      check('room data change: ten clicks, each pressed before a club-data change and released after it, all land: the component under the pointer is selected every time', lost.length === 0, { lost, trials: 10 });
    }
    // leaving a club's data behind (a club switch resets every page version) and redrawing the brand
    {
      const out = await page.evaluate(async () => {
        const lab = document.querySelector('.lab'), r0 = window.__proofRenders;
        window._famResetPageVersions(); window._famDataChanged();
        try { window.hydrateTopbarBrand('design-system'); } catch (_) { /* not every build has it */ }
        await new Promise((r) => setTimeout(r, 800));
        return { same: document.querySelector('.lab') === lab, renders: window.__proofRenders - r0 };
      });
      check('room data change: dropping the club\'s data (page versions reset, as a club switch does) and redrawing the brand change nothing in the room', out.same && out.renders === 0, out);
    }
    // the search: the field being typed in keeps its focus, text and caret, and the list stays filtered
    {
      await page.click('#lab-q'); await page.keyboard.type('ch');
      await page.evaluate(() => { const q = document.getElementById('lab-q'); q.setSelectionRange(1, 1); window.__mkFocus = q; });
      const ids = () => page.evaluate(() => [...document.querySelectorAll('[data-lab-id]')].map((b) => b.getAttribute('data-lab-id')).join());
      const ids0 = await ids();
      const ch = await dataChange(page, 800);
      const q = await page.evaluate(() => { const e = document.getElementById('lab-q'); return { focus: document.activeElement === window.__mkFocus, value: e.value, caret: e.selectionStart }; });
      const ids1 = await ids();
      check('room data change: while the reader types in the Lab search, a club-data change keeps the same focused field, its text, its caret and the filtered list',
        ch.same && ch.renders === 0 && q.focus && q.value === 'ch' && q.caret === 1 && ids1 === ids0, { change: ch, search: q, filtered: ids0 === ids1 });
      await page.fill('#lab-q', ''); await frames(page);
      await page.click('[data-lab-id="lg-chip"]'); await selects(page, 'lg-chip');
    }
    // twenty changes, then Compare and Swap
    {
      if (!(await page.evaluate(() => window.__familistaLabMetrics().compare))) { await page.click('[data-lab-mode="compare"]'); await frames(page); }
      const m0 = mounts(page);
      for (let i = 0; i < 20; i++) await page.evaluate(() => window._famDataChanged());
      await page.waitForTimeout(600);
      await page.evaluate(liveRecord);
      const pre = await page.evaluate(() => [window.__familistaLabMetrics().fixture, window.__familistaLabMetrics().fixtureB]);
      await page.click('[data-lab-swap]'); await page.waitForTimeout(600);
      const post = await page.evaluate(() => [window.__familistaLabMetrics().fixture, window.__familistaLabMetrics().fixtureB]);
      const writes = await page.evaluate(() => { window.__liveMo.disconnect(); return window.__liveWrites.filter((w) => w); });
      await page.click('[data-lab-mode="single"]'); await frames(page);
      const leftB = await page.evaluate(() => document.querySelectorAll('.lab [id$="-b"], .lab .lab-cmp, .lab [data-lab-swap]').length);
      check('room data change: after twenty club-data changes Compare still works: the Lab was never mounted again, Swap exchanges the panes and is announced once, and Single removes every Preview B node',
        mounts(page) === m0 && pre[0] !== pre[1] && post[0] === pre[1] && post[1] === pre[0] && writes.length === 1 && writes[0] === 'Preview A and Preview B swapped' && leftB === 0, { mounts: [m0, mounts(page)], pre, post, writes, leftB });
    }
    // growth: fifty changes, then ten deliberate redraws
    {
      const client = await ctx.newCDPSession(page);
      await client.send('Performance.enable'); await client.send('HeapProfiler.enable');
      const heap = async () => { await client.send('HeapProfiler.collectGarbage'); return (await client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value; };
      const nodes = () => page.evaluate(() => ({ all: document.getElementsByTagName('*').length, labs: document.querySelectorAll('.lab').length }));
      const n0 = await nodes(), h0 = await heap();
      for (let i = 0; i < 50; i++) await page.evaluate(() => window._famDataChanged());
      await page.waitForTimeout(800);
      const n1 = await nodes(), h1 = await heap();
      await client.detach();
      check('room growth: fifty club-data changes add no node to the page, leave exactly one Lab, and grow the heap by at most 256 KB after garbage collection',
        n1.all === n0.all && n1.labs === 1 && h1 - h0 <= 256 * 1024, { nodes: [n0, n1], heapGrowthKB: Math.round((h1 - h0) / 1024) });
      const l0 = await docListeners(page);
      let redrawn = 0;
      for (let i = 0; i < 10; i++) if (await roomRedraw(page)) redrawn++;
      const l1 = await docListeners(page);
      check('room growth: ten deliberate redraws of the room mount the Lab ten times and leave exactly as many listeners on the document as before', redrawn === 10 && l1 === l0, { redrawn, listeners: [l0, l1] });
    }

    // the redraws that must still happen
    {
      const net = await netWatch(page);
      const mk0 = mounts(page);
      const keep = await page.evaluate(() => { const m = window.__familistaLabMetrics(); return JSON.stringify([m.zoom, m.compare, m.width, m.dir]); });
      await page.click('[data-ds-refresh]');
      await page.waitForFunction(() => { const b = document.querySelector('[data-ds-refresh]'); return b && !b.disabled && document.querySelector('#lab-specimen .lab-col'); }, null, { timeout: 15000 });
      await page.waitForTimeout(600);
      await net.stop();
      const reads = fromRoom(net.seen).filter((x) => x.path === '/api/v1/system/design-system');
      const kept = await page.evaluate(() => { const m = window.__familistaLabMetrics(); return JSON.stringify([m.zoom, m.compare, m.width, m.dir]); });
      const answers = await page.click('[data-lab-id="lg-metric"]').then(() => selects(page, 'lg-metric'));
      check('room refresh: Refresh still reads the room again (one overview read, from the room), mounts the Lab again, keeps zoom, Compare, width and direction, and the Lab answers the pointer',
        reads.length === 1 && mounts(page) > mk0 && kept === keep && answers, { overviewReads: reads.length, mounts: [mk0, mounts(page)], keep, kept, answers });
    }
    {
      const before = await view(page);
      const mk0 = mounts(page);
      const pick = async (l) => { await page.click('[data-ds-langs]'); await page.click(`[data-ds-lang="${l}"]`); await page.waitForFunction((x) => document.getElementById('ds-root').getAttribute('lang') === x && document.querySelector('#lab-specimen .lab-col'), l, { timeout: 15000 }); await page.waitForTimeout(600); };
      await pick('de');
      const de = await view(page), deDir = await page.getAttribute('#ds-root', 'lang');
      await pick('en');
      const en = await view(page);
      const same = (a) => a.sel === before.sel && a.fixture === before.fixture && a.fixtureB === before.fixtureB && a.compare === before.compare && a.zoom === before.zoom;
      check('room language: switching the room to German and back redraws it in that language each time and mounts the Lab again with its selection, fixtures, Compare and zoom kept',
        deDir === 'de' && mounts(page) >= mk0 + 2 && same(de) && same(en), { mounts: [mk0, mounts(page)], before, de, en });
    }
    {
      await page.click('[data-ds-nav="components"]'); await page.waitForSelector('#cl-host .cl', { timeout: 15000 });
      await page.click('[data-ds-nav="lab"]'); await page.waitForSelector('#lab-specimen .lab-col', { timeout: 15000 }); await frames(page);
      const z0 = await page.textContent('#lab-zoom-v'); await page.click('[data-lab-zoom="out"]', { force: true }); await frames(page);
      const z1 = await page.textContent('#lab-zoom-v');
      check('room sections: going to Components and back to the Specimen Lab mounts a Lab that answers the pointer', z1 !== z0, { zoom: [z0, z1] });
    }
    {
      const where = () => page.evaluate(() => ({ active: (document.querySelector('.page.active') || {}).id, shellClass: document.body.classList.contains('ds-design-open'), shell: !!document.querySelector('#ds-root .ds-shell'),
        section: (document.querySelector('.ds-rail [aria-current="page"]') || { getAttribute: () => null }).getAttribute('data-ds-nav'), lab: !!document.querySelector('.lab') }));
      const r0 = await renders(page);
      await page.evaluate(() => window.navTo('owner-home')); await page.waitForTimeout(600);
      const away = await where();
      await page.evaluate(() => window.navTo('design-system')); await page.waitForTimeout(1200);
      const back = await where(), r1 = await renders(page);
      let answers = false, z = null;
      if (!back.lab) {
        await page.click('[data-ds-nav="lab"]'); await page.waitForSelector('#lab-specimen .lab-col', { timeout: 15000 }); await frames(page);
      }
      const z0 = await page.textContent('#lab-zoom-v'); await page.click('[data-lab-zoom="in"]', { force: true }); await frames(page);
      z = [z0, await page.textContent('#lab-zoom-v')]; answers = z[0] !== z[1];
      check('room re-entry: leaving for Owner Home and coming back with no data change draws the room once and opens it clean on Overview, with no Lab left on screen, and the Lab opened from there answers the pointer',
        away.active === 'pg-owner-home' && !away.shellClass && back.active === 'pg-design-system' && back.shellClass && back.shell && r1 - r0 === 1 && back.section === 'overview' && !back.lab && answers, { away, back, renders: r1 - r0, zoom: z });
      const r2 = await renders(page), lab = await page.evaluate(() => { window.__mk = document.querySelector('.lab'); return !!window.__mk; });
      await page.evaluate(() => window.navTo('design-system')); await page.waitForTimeout(800);
      const again = await page.evaluate(() => document.querySelector('.lab') === window.__mk);
      check('room navigation: routing to the room while it is already open (a deep link applied again) draws nothing and keeps the Lab', lab && again && (await renders(page)) === r2, { again, renders: (await renders(page)) - r2 });
      const r3 = await renders(page);
      await page.evaluate(() => window.navTo('algorithms')); await page.waitForTimeout(800);
      const algo = await where();
      await page.evaluate(() => window.navTo('design-system')); await page.waitForTimeout(1200);
      const ds = await where();
      check('room navigation: Design System → Algorithms → Design System lands on each room, the Design System shell class follows, and the room is drawn once on the way back',
        algo.active === 'pg-algorithms' && !algo.shellClass && ds.active === 'pg-design-system' && ds.shellClass && ds.shell && (await renders(page)) - r3 === 1, { algo, ds, renders: (await renders(page)) - r3 });
      // The page rebuilt under the reader, as a start-up rebuild of the page shells does: a new, empty root in the same page.
      await page.evaluate(() => { document.getElementById('pg-design-system').innerHTML = '<div id="ds-root"></div>'; });
      await page.evaluate(() => window.navTo('design-system')); await page.waitForTimeout(1200);
      const refilled = await where();
      check('room navigation: a room page rebuilt under the reader (a new, empty root) is drawn again when it is routed to, though the reader never left it', refilled.active === 'pg-design-system' && refilled.shell, refilled);
    }
    {
      const split = await cspSplit(page);
      check('room: no console error and no Lab or unexplained CSP violation through every step above', labErrors(log).length === 0 && split.lab === 0 && split.unexplained === 0, { errors: labErrors(log), csp: split });
    }
    await ctx.close();

    // budgets: opening Compare and Fit's recalculation, 40 runs each after 3 warm-ups, input to the second frame
    {
      const { ctx: pc, page: pp } = await open({ width: 1440, height: 900 }, 'en');
      await openLab(pp, SETTLE);
      await pp.click('[data-lab-id="lg-float"]'); await pp.waitForSelector('#lab-specimen .lg-float-bg'); await frames(pp);
      const cmp = await pp.evaluate(async () => {
        const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), out = [];
        for (let i = 0; i < 43; i++) { const t0 = performance.now(); document.querySelector('[data-lab-mode="compare"]').click(); await fr(); out.push(performance.now() - t0); document.querySelector('[data-lab-mode="single"]').click(); await fr(); }
        return out.slice(3);
      });
      await pp.click('[data-lab-mode="compare"]'); await frames(pp);
      await pp.click('[data-lab-zoom="fit"]', { force: true }); await frames(pp);
      const fit = await pp.evaluate(async () => {
        const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), cyc = ['desktop', 'tablet', 'mobile'], out = [];
        for (let i = 0; i < 43; i++) { const t0 = performance.now(); document.querySelector(`[data-lab-width="${cyc[i % 3]}"]`).click(); await fr(); out.push(performance.now() - t0); }
        return { out: out.slice(3), fit: window.__familistaLabMetrics().fit };
      });
      const sc = stat(cmp), sf = stat(fit.out);
      console.log('MEASURE ' + JSON.stringify({ compareOpenToFrameMedianMs: sc.median, compareOpenToFrameP95Ms: sc.p95, fitRecalcInCompareToFrameMedianMs: sf.median, fitRecalcInCompareToFrameP95Ms: sf.p95, runs: sc.n, warmUps: 3 }));
      // Wall-clock time depends on the machine (a local run measured these two to three times CI's figures), so the owner's budget
      // is reported against, not gated on: a result over it is a finding for the owner, never a red build and never a reason to
      // optimise something else in the same change. What is gated is that the measurement was taken as specified.
      const budget = (name, s) => console.log('BUDGET ' + name + ': p95 ' + s.p95 + ' ms against 100 ms, ' + (s.p95 <= 100 ? 'within' : 'OVER') + ' (median ' + s.median + ' ms, ' + s.n + ' runs after 3 warm-ups)');
      budget('compare open', sc); budget('fit recalculation in compare', sf);
      // M3/S3.2: the official Compare and Fit figures, from these samples alone (D7: the same estimator, with n and the maximum).
      {
        const interval = await frameInterval(pp);
        emitMetric('compare.open.p95', { value: sc.p95, unit: 'ms', n: sc.n, max: maxOf(cmp) });
        emitMetric('fit.recalc.p95', { value: sf.p95, unit: 'ms', n: sf.n, max: maxOf(fit.out) });
        emitMetric('diag.compare.open.frames', { unit: 'frames', interval, n: cmp.length, distribution: frameCounts(cmp, interval) });
        emitMetric('diag.fit.recalc.frames', { unit: 'frames', interval, n: fit.out.length, distribution: frameCounts(fit.out, interval) });
      }
      check('performance: Compare opening and Fit recalculation were each measured 40 times after 3 warm-ups, Fit staying on throughout, and reported against the 100 ms p95 budget', sc.n === 40 && sf.n === 40 && fit.fit === true, { compare: sc, fit: { ...sf, on: fit.fit } });
      await pc.close();
    }

    // controls
    const RESTORE_REGISTRY = (src) => src.replace("  'algorithms':                  ['renderFamilistaAlgorithms'],\n", "  'algorithms':                  ['renderFamilistaAlgorithms'],\n  'design-system':               ['renderFamilistaDesignSystem'],\n");
    const NO_ENTRY_HOOK = (src) => src.replace("if (page === 'design-system' && typeof window.renderFamilistaDesignSystem === 'function'", "if (false && typeof window.renderFamilistaDesignSystem === 'function'");
    const NO_DOM_GUARD = (src) => src.replace("(_leaving !== 'pg-design-system' || !_dsRoot.__famDrawn)", "_leaving !== 'pg-design-system'");
    const NO_UNBIND = (src) => src.replace('    unbind();\n    R.host = host;', '    R.host = host;');
    await control('room (control): club-data registry restored', async () => {
      const { ctx: c, page: p } = await open({ width: 1100, height: 700 }, 'en', null, { appPatch: RESTORE_REGISTRY });
      await openLab(p, SETTLE);
      const ch = await dataChange(p, 1000);
      await p.click('[data-lab-id="lg-chip"]'); await selects(p, 'lg-chip');
      const landed = await splitClick(p, 'lg-metric');
      check('room (control): with the Design System put back among the club-data pages, a club-data change redraws the room and mounts the Lab again, and a click split by one is lost, so the proofs above can fail',
        !ch.same && ch.renders === 1 && !landed, { change: ch, landed });
      await c.close();
    });
    await control('room (control): entry hook removed', async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en', null, { appPatch: NO_ENTRY_HOOK, wait: false });
      await p.waitForTimeout(6000);
      const st = await p.evaluate(() => ({ active: (document.querySelector('.page.active') || {}).id, shell: !!document.querySelector('#ds-root .ds-shell'), renders: window.__proofRenders }));
      check('room (control): with the entry hook removed, a deep link reaches the Design System page and nothing draws it, so the start-up and re-entry proofs can fail', st.active === 'pg-design-system' && !st.shell && st.renders === 0, st);
      await c.close();
    });
    await control('room (control): DOM guard removed', async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en', null, { appPatch: NO_DOM_GUARD });
      await p.waitForTimeout(1500);
      await p.evaluate(() => { document.getElementById('pg-design-system').innerHTML = '<div id="ds-root"></div>'; });
      await p.evaluate(() => window.navTo('design-system')); await p.waitForTimeout(1200);
      const st = await p.evaluate(() => ({ active: (document.querySelector('.page.active') || {}).id, shell: !!document.querySelector('#ds-root .ds-shell') }));
      check('room (control): with the entry hook asking only whether the reader came from another page, a room page rebuilt under the reader stays empty, so the rebuilt-room proof can fail', st.active === 'pg-design-system' && !st.shell, st);
      await c.close();
    });
    await control('room (control): Lab listener cleanup removed', async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en', NO_UNBIND);
      await openLab(p, SETTLE);
      const l0 = await docListeners(p);
      let redrawn = 0;
      for (let i = 0; i < 10; i++) if (await roomRedraw(p)) redrawn++;
      const l1 = await docListeners(p);
      check('room (control): with the Lab\'s listener cleanup removed, ten redraws leave more listeners on the document, so the growth proof can fail', redrawn === 10 && l1 > l0, { redrawn, listeners: [l0, l1] });
      await c.close();
    });
  }

  // ══ 13. every previewable component, discovered (M3 / S2.0) ════════════════
  // The sections above prove the Lab's walls on the components they name. This one proves them on every component the
  // server says is previewable, and finds them in the server's own index, never in a list here: a component added to the
  // manifest is checked the day it is added, and one the Lab enables without the manifest (or the other way round) fails.
  // For each: every fixture's served markup hashes to the sha256 the manifest recorded; what the Lab draws has the element
  // count and exactly the classes the manifest recorded for it, in Single and in Compare, and in RTL; cycling every fixture
  // twice leaves the Lab as large as it was; and nothing that starts in the specimen reaches a document-level listener, no
  // specimen element is in the tab order, no CSP violation is the Lab's, and the Lab asks for nothing but that component's
  // fixtures. Then application memory over three warm passes, measured by heap category (see memoryOf).
  // Each control serves a tampered response or a lab.js with one thing broken and requires the matching proof to fail.
  const TYPES13 = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'contextmenu', 'focusin', 'focusout'];
  // The server's index and every previewable component's fixtures, as the Lab reads them, beside the rail's enabled items.
  const manifestOf = (pg) => pg.evaluate(async () => {
    const K = window.__familistaDesignSystemKit;
    const idx = await K.api('/system/design-system/components/preview');
    const ids = idx.availability.filter((a) => a.state === 'preview').map((a) => a.id);
    const details = {};
    for (const id of ids) {
      const d = await K.api('/system/design-system/components/preview?id=' + encodeURIComponent(id));
      details[id] = d.component.fixtures.map((f) => ({ id: f.id, html: f.html, sha256: f.sha256, elements: f.elements, classes: f.classes.map((c) => c.name).sort() }));
    }
    const rail = [...document.querySelectorAll('#lab-rail-body [data-lab-id]')].filter((b) => b.getAttribute('aria-disabled') !== 'true').map((b) => b.getAttribute('data-lab-id'));
    return { ids, previewable: idx.coverage ? idx.coverage.previewable : null, registered: idx.availability.length, details, rail };
  });
  const selectComponent = async (pg, id) => {
    await pg.evaluate((i) => document.querySelector(`[data-lab-id="${i}"]`).click(), id);
    await pg.waitForFunction((i) => window.__familistaLabMetrics().selected === i && !!window.__familistaLabMetrics().fixture, id, { timeout: 15000 });
    await frames(pg);
  };
  const selectFixture = (pg, fid) => pg.evaluate((f) => new Promise((done) => {
    const b = [...document.querySelectorAll('.lab-fx')].find((x) => x.getAttribute('data-lab-fx') === f);
    if (!b) { done(false); return; }
    b.click(); requestAnimationFrame(() => requestAnimationFrame(() => done(window.__familistaLabMetrics().fixture === f)));
  }), fid);
  // What one pane drew, beside what the manifest recorded for the fixture it says it drew.
  const drawnAgainst = (pg, sfx, fx) => pg.evaluate(async ({ sfx, fx }) => {
    const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const spec = document.getElementById('lab-specimen' + sfx), col = spec ? spec.querySelector('.lab-col') : null;
    const cls = new Set(); if (col) col.querySelectorAll('[class]').forEach((e) => e.classList.forEach((c) => cls.add(c)));
    const sha = await hex(fx.html), elements = col ? col.getElementsByTagName('*').length : 0, classes = [...cls].sort();
    const problems = [];
    if (sha !== fx.sha256) problems.push('served markup hashes to ' + sha.slice(0, 12) + ', the manifest recorded ' + fx.sha256.slice(0, 12));
    if (elements !== fx.elements) problems.push('drew ' + elements + ' elements, the manifest recorded ' + fx.elements);
    if (JSON.stringify(classes) !== JSON.stringify(fx.classes)) problems.push('drew classes [' + classes.join(' ') + '], the manifest recorded [' + fx.classes.join(' ') + ']');
    const refuse = document.getElementById('lab-refuse' + sfx);
    if (refuse && !refuse.hidden) problems.push('the browser refused it: ' + refuse.textContent.trim().slice(0, 120));
    return { fixture: fx.id, ok: problems.length === 0, problems };
  }, { sfx, fx });
  const labNodes13 = (pg) => pg.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
  // Single (every fixture, twice, the Lab no larger after), Compare (B drawn as recorded, gone after), RTL.
  async function rendering(pg, id, fixtures) {
    const problems = [];
    await selectComponent(pg, id);
    let base = null;
    for (let round = 0; round < 2; round++) {
      for (const fx of fixtures) {
        if (!(await selectFixture(pg, fx.id))) { problems.push(fx.id + ': could not be selected'); continue; }
        if (base === null) base = await labNodes13(pg);
        if (round === 0) { const d = await drawnAgainst(pg, '', fx); if (!d.ok) problems.push(fx.id + ': ' + d.problems.join('; ')); }
      }
    }
    if (fixtures.length) { await selectFixture(pg, fixtures[0].id); const after = await labNodes13(pg); if (after !== base) problems.push('the Lab held ' + base + ' nodes at the first fixture and ' + after + ' after cycling every fixture twice'); }
    await pg.evaluate(() => document.querySelector('[data-lab-mode="compare"]').click());
    await pg.waitForFunction(() => !!document.getElementById('lab-specimen-b') && !!document.getElementById('lab-fx-b'), null, { timeout: 8000 }).catch(() => problems.push('Compare did not open'));
    await frames(pg);
    const bId = await pg.evaluate(() => (document.getElementById('lab-fx-b') || {}).value);
    const bFx = fixtures.find((f) => f.id === bId);
    if (!bFx) problems.push('Preview B names ' + bId + ', not a fixture of ' + id);
    else { const d = await drawnAgainst(pg, '-b', bFx); if (!d.ok) problems.push('Preview B ' + bFx.id + ': ' + d.problems.join('; ')); }
    await pg.evaluate(() => document.querySelector('[data-lab-mode="single"]').click()); await frames(pg);
    const leftB = await pg.evaluate(() => document.querySelectorAll('.lab [id$="-b"], .lab .lab-cmp').length);
    if (leftB) problems.push(leftB + ' Preview B nodes left after returning to Single');
    await pg.evaluate(() => document.querySelector('[data-lab-dir="rtl"]').click()); await frames(pg);
    const rtl = await pg.evaluate(() => ({ dir: (document.getElementById('lab-specimen') || {}).getAttribute ? document.getElementById('lab-specimen').getAttribute('dir') : null, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
    if (rtl.dir !== 'rtl' || rtl.overflow) problems.push('RTL: specimen dir ' + rtl.dir + (rtl.overflow ? ', the page scrolls sideways' : ''));
    const curId = await pg.evaluate(() => window.__familistaLabMetrics().fixture);
    const cur = fixtures.find((f) => f.id === curId);
    if (cur) { const d = await drawnAgainst(pg, '', cur); if (!d.ok) problems.push('RTL: ' + d.problems.join('; ')); } else if (fixtures.length) problems.push('RTL: the Lab shows ' + curId + ', not a fixture of ' + id);
    await pg.evaluate(() => document.querySelector('[data-lab-dir="ltr"]').click()); await frames(pg);
    return { id, fixtures: fixtures.length, ok: problems.length === 0, problems };
  }
  const installRecorder = (pg) => pg.evaluate((types) => {
    window.__seen13 = { inside: 0, outside: 0, types: {} };
    const rec = (e) => { const spec = document.getElementById('lab-specimen'), specB = document.getElementById('lab-specimen-b'); const inside = (spec && spec.contains(e.target)) || (specB && specB.contains(e.target)); if (inside) { window.__seen13.inside++; window.__seen13.types[e.type] = (window.__seen13.types[e.type] || 0) + 1; } else window.__seen13.outside++; };
    for (const t of types) { document.addEventListener(t, rec); window.addEventListener(t, rec); document.documentElement.addEventListener(t, rec); document.body.addEventListener(t, rec); }
  }, TYPES13);
  // Events, focus, CSP and network, for one component, every fixture.
  async function isolation(pg, id, fixtures) {
    const problems = [];
    const from = await cspMark(pg);
    const net = await netWatch(pg);
    await pg.evaluate(() => { window.__seen13.inside = 0; window.__seen13.types = {}; });
    await selectComponent(pg, id);
    for (const fx of fixtures) {
      if (!(await selectFixture(pg, fx.id))) { problems.push(fx.id + ': could not be selected'); continue; }
      const pts = await pg.evaluate(() => {
        const spec = document.getElementById('lab-specimen'), vp = document.getElementById('lab-viewport');
        const box = (vp || spec).getBoundingClientRect(), out = [[box.left + box.width / 2, box.top + box.height / 2], [box.left + 12, box.top + 12]];
        spec.querySelectorAll('button').forEach((b) => { const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; if (r.width && r.height && x > box.left && x < box.right && y > box.top && y < box.bottom) out.push([x, y]); });
        return out;
      });
      for (const [x, y] of pts) { await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.up(); await pg.mouse.click(x, y, { button: 'right' }); }
      const focusedOne = await pg.evaluate(() => { const b = document.querySelector('#lab-specimen button'); if (!b) return false; b.focus(); return document.activeElement === b; });
      if (focusedOne) for (const k of ['Enter', 'Space', 'Escape', 'a']) await pg.keyboard.press(k);
      const tabbable = await pg.evaluate(() => [...document.querySelectorAll('#lab-specimen *')].filter((e) => e.tabIndex >= 0 && (e.matches('a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable="true"],summary,iframe') || e.isContentEditable)).map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')));
      if (tabbable.length) problems.push(fx.id + ': ' + tabbable.length + ' specimen element(s) in the tab order: ' + tabbable.slice(0, 3).join(', '));
      await pg.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    }
    await frames(pg); await net.stop();
    const seen = await pg.evaluate(() => ({ inside: window.__seen13.inside, types: window.__seen13.types }));
    if (seen.inside) problems.push(seen.inside + ' event(s) that started in the specimen reached a document, window, html or body listener: ' + JSON.stringify(seen.types));
    const still = await pg.evaluate((i) => location.hash === '#design-system' && window.__familistaLabMetrics().selected === i, id);
    if (!still) problems.push('the room moved: a production handler ran');
    const want = '/api/v1/system/design-system/components/preview?id=' + encodeURIComponent(id);
    const lab = net.seen.filter((x) => x.lab);
    const stray = lab.filter((x) => !(x.method === 'GET' && x.path === want));
    if (stray.length || lab.length > 1) problems.push('the Lab asked for ' + JSON.stringify(lab.map((x) => x.method + ' ' + x.path)) + '; only ' + want + ', at most once, is allowed');
    const split = await cspSplit(pg, from);
    if (split.lab || split.unexplained) problems.push('CSP: ' + split.lab + ' Lab and ' + split.unexplained + ' unexplained violation(s): ' + split.unexplainedDirectives.join(', '));
    return { id, ok: problems.length === 0, problems, labRequests: lab.length, eventsOutsideSeen: (await pg.evaluate(() => window.__seen13.outside)) > 0 };
  }
  // Application memory, by heap category, from a heap snapshot taken after two forced collections. V8's compiled code (code
  // space) and the browser's own buffers (the performance timeline fills to its caps, then stops) are reported apart and never
  // counted against the Lab: measured in M3 / S2.0, they are about 95% of what JSHeapUsedSize gains over the first passes, while
  // JavaScript objects, strings and DOM stay within a few kilobytes. Application = JavaScript objects, arrays, closures, strings,
  // numbers, regexps and DOM nodes. Listeners are counted on window and on the document and everything under it.
  async function memoryOf(pg) {
    const cdp = await pg.context().newCDPSession(pg);
    await cdp.send('HeapProfiler.enable'); await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
    const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value;
    const parts = []; const onChunk = (e) => parts.push(e.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    const s = JSON.parse(parts.join('')); parts.length = 0;
    const m = s.snapshot.meta, f = m.node_fields, nf = f.length, types = m.node_types[0];
    const iT = f.indexOf('type'), iN = f.indexOf('name'), iS = f.indexOf('self_size'), iD = f.indexOf('detachedness');
    const APP = { object: 1, closure: 1, array: 1, string: 1, 'concatenated string': 1, 'sliced string': 1, number: 1, regexp: 1, bigint: 1, symbol: 1 };
    const DOM = /^(Detached )?(HTML\w*Element|SVG\w*Element|Text|Comment|DocumentFragment|Attr|NodeList|HTMLCollection|DOMTokenList|NamedNodeMap|CSSStyleDeclaration)\b/;
    const out = { code: 0, app: 0, browser: 0, detached: 0 };
    for (let i = 0; i < s.nodes.length; i += nf) {
      const t = types[s.nodes[i + iT]], name = s.strings[s.nodes[i + iN]], size = s.nodes[i + iS];
      if (iD >= 0 && s.nodes[i + iD] === 2) out.detached++;
      if (t === 'code') out.code += size;
      else if (APP[t] || (t === 'native' && DOM.test(name))) out.app += size;
      else out.browser += size;
    }
    // Listeners where a Lab leak would land: window, document, <html>, <body>, and everything under the Lab's root. Not the
    // whole document tree: listing listeners there makes Chrome compile the application's own inline onerror attributes,
    // which the policy refuses (script-src-attr), so the measurement would itself raise violations.
    const count = async (expression, depth) => { const { result } = await cdp.send('Runtime.evaluate', { expression }); if (!result.objectId) return 0; const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth }); await cdp.send('Runtime.releaseObject', { objectId: result.objectId }); return listeners.length; };
    out.listeners = (await count('window', 0)) + (await count('document', 0)) + (await count('document.documentElement', 0)) + (await count('document.body', 0)) + (await count("document.querySelector('.lab')", -1));
    out.heap = heap;
    out.domNodes = await pg.evaluate(() => document.getElementsByTagName('*').length);
    await cdp.detach();
    return out;
  }
  const memDelta = (a, b) => ({ appKB: Math.round((b.app - a.app) / 102.4) / 10, codeKB: Math.round((b.code - a.code) / 102.4) / 10, browserKB: Math.round((b.browser - a.browser) / 102.4) / 10, totalHeapKB: Math.round((b.heap - a.heap) / 102.4) / 10, listeners: b.listeners - a.listeners, detached: b.detached - a.detached, domNodes: b.domNodes - a.domNodes });
  const passAll = async (pg, man) => { for (const id of man.ids) { await selectComponent(pg, id); for (const fx of man.details[id]) await selectFixture(pg, fx.id); } };
  const APP_MEMORY_BUDGET_KB = 32;

  if (want('13')) {
    const { ctx, page, log } = await open({ width: 1440, height: 900 }, 'en');
    await openLab(page, SETTLE);
    LAB_PAGE = page;
    const man = await manifestOf(page);
    const same = man.ids.length > 0 && man.ids.length === man.previewable && JSON.stringify([...man.ids].sort()) === JSON.stringify([...man.rail].sort());
    check('every component: the components the server\'s index calls previewable are exactly the ones the Lab enables, and each has its fixtures', same && man.ids.every((id) => man.details[id].length > 0),
      { previewable: man.previewable, registered: man.registered, ids: man.ids, rail: man.rail, fixtures: Object.fromEntries(man.ids.map((id) => [id, man.details[id].length])) });
    await installRecorder(page);
    for (const id of man.ids) {
      const r = await rendering(page, id, man.details[id]);
      check(`component ${id}: every fixture's served markup hashes to the recorded sha256 and is drawn with the recorded element count and classes, in Single, in Compare and in RTL, and cycling its fixtures twice leaves the Lab as large as it was`, r.ok, r);
      const s = await isolation(page, id, man.details[id]);
      check(`component ${id}: nothing that starts in its specimen reaches a document-level listener or moves the room, no specimen element is in the tab order, no CSP violation is the Lab's, and the Lab asks for nothing but its fixtures`, s.ok && s.eventsOutsideSeen, s);
    }
    // Application memory: one pass unmeasured (compiled code, caches and the browser's buffers warm up), then three measured.
    await passAll(page, man);
    const m0 = await memoryOf(page);
    for (let k = 0; k < 3; k++) await passAll(page, man);
    const m1 = await memoryOf(page);
    const d = memDelta(m0, m1);
    // M3/S3.2: the official memory and resource figures; the check below still enforces them, unchanged.
    emitMetric('mem.app.growth', { value: d.appKB, unit: 'KB' });
    emitMetric('mem.listeners.growth', { value: d.listeners, unit: 'count' });
    emitMetric('mem.detached.growth', { value: d.detached, unit: 'count' });
    emitMetric('dom.growth', { value: d.domNodes, unit: 'count' });
    console.log('MEASURE ' + JSON.stringify({ section: 13, passes: 3, switchesPerPass: man.ids.reduce((n, id) => n + man.details[id].length, 0), ...d, budgetKB: APP_MEMORY_BUDGET_KB, listenersAfter: m1.listeners, detachedAfter: m1.detached }));
    check(`every component: three warm passes over every fixture grow application memory (JavaScript objects, strings and DOM) by at most ${APP_MEMORY_BUDGET_KB} KB, and leave no new listener and no new detached node (compiled code and browser buffers are reported apart)`,
      d.appKB <= APP_MEMORY_BUDGET_KB && d.listeners === 0 && d.detached <= 0, d);
    const split = await cspSplit(page);
    check('every component: no console error and no Lab or unexplained CSP violation through all of the above', labErrors(log).length === 0 && split.lab === 0 && split.unexplained === 0, { errors: labErrors(log), csp: split });
    await ctx.close();

    // ── controls ─────────────────────────────────────────────────────────────
    const target = man.ids[Math.min(1, man.ids.length - 1)];
    const control13 = async (name, fn) => { try { await fn(); } catch (e) { fail(name + ': control not applied: ' + String(e.message || e).split('\n')[0]); } };
    const tamperRoute = async (c, id, edit) => {
      await c.route(new RegExp('/api/v1/system/design-system/components/preview\\?id=' + id.replace(/[-.]/g, '\\$&') + '$'), async (route) => {
        const res = await route.fetch(); const body = await res.json();
        const fx = body.data.component.fixtures[0];
        edit(fx);
        await route.fulfill({ response: res, json: body });
      });
    };
    await control13('component (control): tampered markup', async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en');
      let changed = false;
      await tamperRoute(c, target, (fx) => { const m = />([A-Za-z])/.exec(fx.html); if (m) { fx.html = fx.html.slice(0, m.index + 1) + (m[1] === 'Z' ? 'Y' : 'Z') + fx.html.slice(m.index + 2); changed = true; } });
      await openLab(p, SETTLE);
      const mm = await manifestOf(p);
      if (!changed) throw new Error('the first fixture of ' + target + ' has no text to change');
      const r = await rendering(p, target, mm.details[target]);
      check('component (control): markup changed in transit with its recorded sha256 left alone is caught by the hash check, so the integrity proof can fail', !r.ok && r.problems.some((x) => /hashes to/.test(x)), r);
      await c.close();
    });
    await control13('component (control): unowned class', async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en');
      const crypto = require('crypto');
      await tamperRoute(c, target, (fx) => { fx.html = fx.html.replace('class="', 'class="lab-proof-unowned '); fx.sha256 = crypto.createHash('sha256').update(fx.html).digest('hex'); });
      await openLab(p, SETTLE);
      const mm = await manifestOf(p);
      const r = await rendering(p, target, mm.details[target]);
      check('component (control): a class the manifest does not record, with the hash recomputed so integrity passes, is refused by the browser and drawn as nothing, so the provenance proof can fail', !r.ok && r.problems.some((x) => /refused it|drew 0 elements/.test(x)) && !r.problems.some((x) => /hashes to/.test(x)), r);
      await c.close();
    });
    const isolationControl = async (name, patch, expect, label) => control13(name, async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en', patch);
      await openLab(p, SETTLE);
      const mm = await manifestOf(p);
      await installRecorder(p);
      const s = await isolation(p, target, mm.details[target]);
      check(label, !s.ok && s.problems.some((x) => expect.test(x)), s);
      await c.close();
    });
    await isolationControl('component (control): event boundary removed', (src) => src.replace('BOUNDARY.forEach(function (type) { spec.addEventListener(type, stopAtBoundary); });', 'void BOUNDARY;'),
      /reached a document, window, html or body listener/, 'component (control): with the stage\'s event boundary removed, clicks and keys in the specimen reach document-level listeners, so the event proof can fail');
    await isolationControl('component (control): unexpected request', (src) => src.replace('  function checkFixture(f) {\n', "  function checkFixture(f) {\n    fetch('/api/v1/teams?proof-control=13').catch(function () {});\n"),
      /the Lab asked for/, 'component (control): a lab.js that makes a request when it draws a fixture is caught, so the network proof can fail');
    await isolationControl('component (control): inline style', (src) => src.replace('    spec.appendChild(col);\n', "    spec.appendChild(col);\n    col.setAttribute('style', 'outline:0');\n"),
      /CSP: [1-9]/, 'component (control): a lab.js that writes a style attribute on the specimen is refused by the unchanged policy and counted as the Lab\'s, so the CSP proof can fail');
    await control13('component (control): specimen not cleared', async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en', (src) => src.replace('    while (spec.firstChild) spec.removeChild(spec.firstChild);\n    var res = checkFixture(f);', '    var res = checkFixture(f);'));
      await openLab(p, SETTLE);
      const mm = await manifestOf(p);
      const r = await rendering(p, target, mm.details[target]);
      check('component (control): a lab.js that draws each fixture without clearing the last grows the Lab, so the DOM-stability proof can fail', !r.ok && r.problems.some((x) => /after cycling every fixture twice/.test(x)), r);
      await c.close();
    });
    const memoryControl = async (name, patch, label, pass, passes) => control13(name, async () => {
      const { ctx: c, page: p } = await open({ width: 1440, height: 900 }, 'en', patch);
      await openLab(p, SETTLE);
      const mm = await manifestOf(p);
      await passAll(p, mm);
      const a = await memoryOf(p);
      for (let k = 0; k < passes; k++) await passAll(p, mm);
      const b = await memoryOf(p);
      const dd = memDelta(a, b);
      console.log('MEASURE ' + JSON.stringify({ section: '13 control', name, passes, ...dd }));
      check(label, pass(dd), dd);
      await c.close();
    });
    await memoryControl('component (control): a listener per draw', (src) => src.replace('    spec.appendChild(col);\n', "    spec.appendChild(col);\n    document.addEventListener('pointermove', function () {});\n"),
      'component (control): a lab.js that adds a document listener on every draw is caught by the listener count after a single pass, so the listener proof can fail', (dd) => dd.listeners > 0, 1);
    await memoryControl('component (control): retained specimens', (src) => src.replace('    spec.appendChild(col);\n', "    spec.appendChild(col);\n    (window.__proofRetained = window.__proofRetained || []).push(col.cloneNode(true), f.html + ' ' + Math.random());\n"),
      `component (control): a lab.js that keeps every drawn specimen and its markup grows application memory past ${APP_MEMORY_BUDGET_KB} KB and leaves detached nodes over the same three warm passes the proof measures, so the memory proof can fail on either`, (dd) => dd.appKB > APP_MEMORY_BUDGET_KB && dd.detached > 0, 3);
  }

  // ══ 13a. every previewable component, under axe (--axe) ═══════════════════════
  // The same discovery as section 13. axe (WCAG 2.2 A/AA) on the stage alone, for every fixture of every component, in English,
  // and again in Arabic with the specimen right to left. A violation is reported as found: never filtered, never skipped.
  if (WANT_AXE && want('13a')) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (!fs.existsSync(axePath)) skip('every component under axe', 'axe-core is not installed (' + axePath + ')');
    else {
      const AXE = fs.readFileSync(axePath, 'utf8');
      const axeStage = (pg) => pg.evaluate(async (src) => {
        if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
        const from = (window.__csp || []).length;
        const r = await window.axe.run({ include: ['#lab-specimen'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        await new Promise((done) => setTimeout(done, 150));
        (window.__axeRanges = window.__axeRanges || []).push([from, (window.__csp || []).length]);
        return r.violations.map((v) => v.id + ':' + v.nodes.length + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join('|'));
      }, AXE);
      for (const loc of ['en', 'ar']) {
        const { ctx, page, log } = await open({ width: 1440, height: 900 }, loc);
        await openLab(page, SETTLE);
        const man = await manifestOf(page);
        if (loc === 'en') check('every component under axe: the components the server\'s index calls previewable are exactly the ones the Lab enables', man.ids.length > 0 && man.ids.length === man.previewable && JSON.stringify([...man.ids].sort()) === JSON.stringify([...man.rail].sort()), { ids: man.ids, rail: man.rail });
        for (const id of man.ids) {
          await selectComponent(page, id);
          if (loc === 'ar') { await page.evaluate(() => document.querySelector('[data-lab-dir="rtl"]').click()); await frames(page); }
          const found = [];
          let dir = null;
          for (const fx of man.details[id]) {
            if (!(await selectFixture(page, fx.id))) { found.push(fx.id + ': could not be selected'); continue; }
            if (dir === null) dir = await page.evaluate(() => document.getElementById('lab-specimen').getAttribute('dir'));
            for (const v of await axeStage(page)) found.push(fx.id + ': ' + v);
          }
          if (loc === 'ar') await page.evaluate(() => document.querySelector('[data-lab-dir="ltr"]').click());
          check(loc === 'en' ? `component ${id} under axe: 0 violations (WCAG 2.2 A/AA) on the stage, for every one of its ${man.details[id].length} fixtures, in English`
            : `component ${id} under axe, Arabic and right to left: the specimen is drawn right to left and has 0 violations (WCAG 2.2 A/AA) on the stage, for every one of its ${man.details[id].length} fixtures`,
            found.length === 0 && (loc === 'en' || dir === 'rtl'), { violations: found, dir });
        }
        const split = await cspSplit(page);
        check(`every component under axe (${loc}): no console error and no Lab or unexplained CSP violation (axe's own font fetch is counted apart)`, labErrors(log).length === 0 && split.lab === 0 && split.unexplained === 0, split);
        if (loc === 'en') {
          // control: the same stage-scoped run sees a button with no name placed in the specimen
          const broken = await page.evaluate(() => { const col = document.querySelector('#lab-specimen .lab-col'); const b = document.createElement('button'); b.type = 'button'; col.appendChild(b); return !!b.isConnected; });
          const v = broken ? await axeStage(page) : [];
          check('every component under axe (control): a button with no name placed in the specimen is reported by the same stage-scoped run, so a clean result means something', v.some((x) => /^button-name:/.test(x)), v);
        }
        await ctx.close();
      }
    }
  }

  // ══ 14. Familista Design Studio (Slice 1a): a product of its own, and an editor that does exactly what the pointer did ══
  // The Studio is not a section of Design System Control: it is its own page at #design-studio, loaded on demand for the
  // platform owner only. These proofs drive it with the real mouse and keyboard, read every result back from the design the
  // Studio saves in this browser (Ctrl+S writes it synchronously), and look inside each frame's own document. A frame is an
  // about:blank iframe sandboxed with allow-same-origin only; its CSP violations are caught by a listener attached to its
  // document the moment it appears (a violation is reported as a task, after the frame is in the page), and a control proves
  // that listener sees one.
  const ST_KEY = 'familista_design_studio_document';
  // Chrome's own message when a sandboxed frame refuses a script: the frames have no allow-scripts, so the proof harness's
  // init scripts (which Playwright tries to run in every frame) and the proofs' own probes are refused in each of them. That
  // is the sandbox doing its job. It is counted and reported apart, never as an error and never dropped.
  const SANDBOX_REFUSAL = /^Blocked script execution in 'about:blank' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;
  async function openStudio(viewport, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', acceptDownloads: true });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    if (opts.studioPatch) {
      const original = fs.readFileSync(path.join(ROOT, 'public/design-studio/studio.js'), 'utf8');
      const patched = opts.studioPatch(original);
      if (patched === original) throw new Error('negative control: the edit did not change studio.js, so it would prove nothing');
      await ctx.route(/\/design-studio\/studio\.js(\?|$)/, (r) => r.fulfill({ contentType: 'application/javascript', body: patched }));
    }
    if (!opts.anonymous) await ctx.addCookies([{ name: 'access_token', value: token, domain: '127.0.0.1', path: '/', httpOnly: true }]);
    await ctx.addInitScript((pre) => {
      window.__csp = [];
      const note = (inFrame) => (e) => {
        let src = '';
        try { src = e.sourceFile ? new URL(e.sourceFile).pathname : ''; } catch (_) { src = String(e.sourceFile || ''); }
        window.__csp.push({ d: e.violatedDirective, uri: String(e.blockedURI).slice(0, 120), src, inFrame,
          inStudio: !inFrame && !!(e.target && e.target.closest && e.target.closest('#pg-design-studio')) });
      };
      document.addEventListener('securitypolicyviolation', note(false));
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const found = n.tagName === 'IFRAME' ? [n] : (n.querySelectorAll ? [...n.querySelectorAll('iframe')] : []);
          for (const f of found) {
            if (f.__stWatched || !f.closest('.st-frame')) continue;
            f.__stWatched = true;
            try { f.contentDocument.addEventListener('securitypolicyviolation', note(true)); } catch (_) { window.__csp.push({ d: 'unwatchable-frame', uri: '', src: '', inFrame: true }); }
          }
        }
      }).observe(document, { childList: true, subtree: true });
      // Seed storage once per context (sessionStorage survives a reload; the seed must not).
      try {
        if (pre && !sessionStorage.getItem('__stSeeded')) {
          sessionStorage.setItem('__stSeeded', '1');
          if (pre.locale) localStorage.setItem('familista_design_studio_locale', pre.locale);
        }
      } catch (_) { /* private mode */ }
    }, { locale: opts.locale || null });
    const page = await ctx.newPage();
    const log = { errors: [], notices: [], requests: [], sandbox: 0 };
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (SANDBOX_REFUSAL.test(m.text())) { log.sandbox++; return; }
      if (NOTICE.test(m.text())) log.notices.push({ text: m.text().slice(0, 200), url: String((m.location() && m.location().url) || '').slice(0, 200) });
      else log.errors.push('console: ' + m.text().slice(0, 200));
    });
    page.on('request', (r) => { const u = new URL(r.url()); log.requests.push({ m: r.method(), p: u.pathname, q: u.search, o: u.origin, body: r.postData() || '' }); });
    await page.goto(BASE + (opts.hash || '/#design-studio'), { waitUntil: 'load' });
    if (opts.wait !== false) await page.waitForSelector('.st-canvas', { timeout: 30000 });
    return { ctx, page, log };
  }
  // A CSP report is the Studio's if it was raised inside the Studio's page, inside one of its frames, by one of its files, or
  // names one of them. The application's own inline-style reports (style-src-attr from a first-party script or the page's
  // HTML) are counted apart, as the Lab's proofs count them. Anything else is unexplained.
  const stCsp = (page) => page.evaluate(() => {
    const v = window.__csp || [];
    const studio = (c) => c.inStudio || c.inFrame || /design-studio\//.test(c.src) || /design-studio\//.test(c.uri);
    const app = (c) => !studio(c) && c.d === 'style-src-attr' && /^\//.test(c.src);
    const unexplained = v.filter((c) => !studio(c) && !app(c));
    return { total: v.length, studio: v.filter(studio).length, studioDirectives: [...new Set(v.filter(studio).map((c) => c.d + (c.inFrame ? ' (frame)' : '')))],
      application: v.filter(app).length, unexplained: unexplained.length, unexplainedDirectives: [...new Set(unexplained.map((c) => c.d + ' @' + (c.src || '(no source)')))] };
  });
  const stState = (page) => page.evaluate(() => window.__familistaStudioMetrics && window.__familistaStudioMetrics());
  async function stSaved(page) {
    await page.keyboard.press('Control+s');
    return page.evaluate((k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, ST_KEY);
  }
  const stDoc = async (page) => { const s = await stSaved(page); return s ? JSON.parse(s) : null; };
  async function stScreen(page, wx, wy) {
    const b = await page.locator('.st-canvas').boundingBox();
    const m = await stState(page);
    return { x: b.x + m.camera.x + wx * m.camera.z, y: b.y + m.camera.y + wy * m.camera.z };
  }
  async function stDrag(page, a, b, mods) {
    for (const k of mods || []) await page.keyboard.down(k);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    for (const k of (mods || []).slice().reverse()) await page.keyboard.up(k);
  }
  const stFind = (doc, id) => { for (const f of (doc && doc.frames) || []) { if (f.id === id) return f; for (const c of f.children) if (c.id === id) return c; } return null; };
  const stGeom = (n) => (n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null);
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Every frame's document, as the page holds it.
  const stFrames = (page) => page.evaluate(() => [...document.querySelectorAll('.st-frame > iframe')].map((f) => {
    const d = f.contentDocument, w = f.contentWindow;
    return { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), url: d && d.URL, scripts: d ? d.querySelectorAll('script').length : -1,
      pointer: getComputedStyle(f).pointerEvents, width: f.offsetWidth, narrow: w ? w.matchMedia('(max-width: 980px)').matches : null,
      onAttrs: d ? [...d.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length : -1,
      tags: d ? [...new Set([...d.body.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()))].sort() : [] };
  }));
  // Wait for the Studio's next announcement after `before` (or give up after `ms` and return what is there).
  async function stHeard(page, before, ms) {
    try { await page.waitForFunction((b) => { const m = window.__familistaStudioMetrics && window.__familistaStudioMetrics(); return m && m.announced !== b; }, before, { timeout: ms || 3000, polling: 50 }); } catch (_) { /* reported below */ }
    return (await stState(page)).announced;
  }
  async function stImport(page, name, text) {
    const before = (await stState(page)).announced;
    await page.setInputFiles('.st-shell input[type="file"]', { name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    return stHeard(page, before, 3000);
  }
  const STUDIO_FILES = ['/design-studio/studio.css', '/design-studio/studio-core.js', '/design-studio/studio.js'];
  // Can a script run in a frame? The probe is a same-origin script file (the Studio's own core, which defines a global), so the
  // page's policy (script-src 'self') allows it and only the frame's sandbox can stop it. An inline probe would prove nothing:
  // the policy refuses inline scripts with or without the sandbox.
  const stFrameScript = (page) => page.evaluate(async () => {
    const f = document.querySelector('.st-frame iframe'), d = f.contentDocument;
    const s = d.createElement('script');
    s.src = '/design-studio/studio-core.js?proof=sandbox';
    d.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 400));
    const ran = typeof f.contentWindow.FamilistaStudioCore === 'object';
    s.remove();
    return ran;
  });

  if (want('14')) {
    // ── entry: its own page, for the platform owner only ──
    const { ctx, page, log } = await openStudio({ width: 1440, height: 900 });
    const entry = await page.evaluate(() => {
      const side = document.querySelector('.sidebar');
      return { studio: !!document.querySelector('#pg-design-studio.active'), dsOpen: !!document.querySelector('#pg-design-system.active'),
        bodyClass: document.body.classList.contains('st-studio-open'), sidebarHidden: !side || getComputedStyle(side).display === 'none',
        empty: !!document.querySelector('.st-empty') && !document.querySelector('.st-empty').hidden, boundary: document.getElementById('pg-design-studio').hasAttribute('data-no-i18n'),
        context: document.getElementById('pg-design-studio').getAttribute('data-fam-context'), dsRender: typeof window.renderFamilistaDesignSystem };
    });
    const dsAssets = log.requests.filter((r) => r.o === BASE && r.p.startsWith('/design-system/'));
    check('studio entry: the platform owner reaches Familista Design Studio at #design-studio, a page of its own: Design System Control is not open and none of its files was fetched, the shell is the Studio\'s, and the empty canvas says what to do',
      entry.studio && !entry.dsOpen && entry.bodyClass && entry.sidebarHidden && entry.empty && entry.boundary && entry.context === 'owner' && dsAssets.length === 0 && entry.dsRender === 'undefined', { entry, dsAssets: dsAssets.map((r) => r.p) });
    const own = log.requests.filter((r) => r.o === BASE && r.p.startsWith('/design-studio/'));
    const versions = [...new Set(own.map((r) => r.q))];
    check('studio entry: it fetched exactly its own three files, under one version, and nothing else of its own',
      sameJson(own.map((r) => r.p).sort(), STUDIO_FILES.slice().sort()) && versions.length === 1 && /^\?v=[\w.-]+$/.test(versions[0]), { own: own.map((r) => r.p + r.q) });

    // ── drawing: a frame, then a rectangle and a text inside it, exactly where the pointer went ──
    const box = await page.locator('.st-canvas').boundingBox();
    const m0 = await stState(page);
    const fx = Math.round(box.width / 2 - m0.camera.x) - 180, fy = Math.round(box.height / 2 - m0.camera.y) - 240;
    await page.keyboard.press('f');
    await stDrag(page, await stScreen(page, fx, fy), await stScreen(page, fx + 360, fy + 480));
    let doc = await stDoc(page);
    const fr = await stFrames(page);
    check('draw: the Frame tool draws a frame exactly where the pointer went, as an about:blank document of its own, sandboxed with allow-same-origin only, holding no script and taking no pointer',
      doc && doc.frames.length === 1 && sameJson(stGeom(doc.frames[0]), { x: fx, y: fy, w: 360, h: 480 }) && fr.length === 1 && fr[0].sandbox === 'allow-same-origin' && fr[0].src === null
        && fr[0].url === 'about:blank' && fr[0].scripts === 0 && fr[0].pointer === 'none', { frame: doc && stGeom(doc.frames[0]), want: { x: fx, y: fy, w: 360, h: 480 }, fr });
    const FID = doc.frames[0].id;
    await page.keyboard.press('r');
    await stDrag(page, await stScreen(page, fx + 80, fy + 190), await stScreen(page, fx + 280, fy + 290));
    await page.keyboard.press('t');
    const tp = await stScreen(page, fx + 80, fy + 330);
    await page.mouse.click(tp.x, tp.y);
    await page.waitForSelector('.st-textedit:not([hidden])', { timeout: 5000 });
    await page.keyboard.type('Squad overview');
    await page.keyboard.press('Escape');
    doc = await stDoc(page);
    const kids = doc.frames[0].children;
    const RID = kids[0] && kids[0].id, TID = kids[1] && kids[1].id;
    const drawn = await page.evaluate(([fid, rid, tid]) => {
      const f = document.querySelector('[data-st-frame="' + fid + '"] iframe').contentDocument;
      const r = f.querySelector('[data-st-id="' + rid + '"]'), t = f.querySelector('[data-st-id="' + tid + '"]');
      return { r: r && [r.offsetLeft, r.offsetTop, r.offsetWidth, r.offsetHeight], t: t && t.textContent, tBox: t && [t.offsetLeft, t.offsetTop, t.offsetWidth, t.offsetHeight] };
    }, [FID, RID, TID]);
    check('draw: the Rectangle and Text tools draw inside the frame, at frame coordinates, and the frame\'s own document lays them out at exactly those pixels; typed text is the text',
      kids.length === 2 && kids[0].type === 'rect' && sameJson(stGeom(kids[0]), { x: 80, y: 190, w: 200, h: 100 }) && kids[1].type === 'text' && sameJson(stGeom(kids[1]), { x: 80, y: 330, w: 200, h: 48 })
        && kids[1].text === 'Squad overview' && sameJson(drawn.r, [80, 190, 200, 100]) && drawn.t === 'Squad overview' && sameJson(drawn.tBox, [80, 330, 200, 48]), { kids: kids.map((k) => [k.id, k.type, stGeom(k), k.text]), drawn });

    // ── moving under zoom: a screen drag is the canvas distance at the current zoom, in whole pixels ──
    const zoomTo = async (z) => {
      await page.keyboard.press('Control+0');
      const key = z < 1 ? 'Control+-' : 'Control+=';
      for (let i = 0; i < 12 && (await stState(page)).camera.z !== z; i++) await page.keyboard.press(key);
      return (await stState(page)).camera.z;
    };
    for (const z of [0.5, 1, 2]) {
      const got = await zoomTo(z);
      const c = await stScreen(page, fx + 180, fy + 240);
      await stDrag(page, c, { x: c.x + 100, y: c.y + 50 });
      const moved = stGeom(stFind(await stDoc(page), RID));
      await page.keyboard.press('Control+z');
      const back = stGeom(stFind(await stDoc(page), RID));
      const want = { x: 80 + Math.round(100 / z), y: 190 + Math.round(50 / z), w: 200, h: 100 };
      check(`move at ${z * 100}%: a 100 × 50 screen-pixel drag moves the rectangle ${Math.round(100 / z)} × ${Math.round(50 / z)} canvas pixels, and one undo puts it back`,
        got === z && sameJson(moved, want) && sameJson(back, { x: 80, y: 190, w: 200, h: 100 }), { zoom: got, moved, want, back });
    }

    // ── resizing: each of the eight handles, Shift keeps the proportions, Alt resizes from the centre ──
    await zoomTo(1);
    const rc = await stScreen(page, fx + 180, fy + 240);
    await page.mouse.click(rc.x, rc.y);
    const G0 = { x: 80, y: 190, w: 200, h: 100 };
    const WANT = { nw: { x: 100, y: 200, w: 180, h: 90 }, n: { x: 80, y: 200, w: 200, h: 90 }, ne: { x: 80, y: 200, w: 220, h: 90 }, e: { x: 80, y: 190, w: 220, h: 100 },
      se: { x: 80, y: 190, w: 220, h: 110 }, s: { x: 80, y: 190, w: 200, h: 110 }, sw: { x: 100, y: 190, w: 180, h: 110 }, w: { x: 100, y: 190, w: 180, h: 100 } };
    const handleDrag = async (h, mods) => {
      const hb = await page.locator('.st-h-' + h).boundingBox();
      const a = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
      await stDrag(page, a, { x: a.x + 20, y: a.y + 10 }, mods);
      const g = stGeom(stFind(await stDoc(page), RID));
      await page.keyboard.press('Control+z');
      return g;
    };
    const resized = {};
    for (const h of Object.keys(WANT)) resized[h] = await handleDrag(h);
    const after = stGeom(stFind(await stDoc(page), RID));
    check('resize: each of the eight handles moves only its own edges by the drag (20 × 10 px at 100%), the opposite edges stay put, and undo restores the rectangle every time',
      Object.keys(WANT).every((h) => sameJson(resized[h], WANT[h])) && sameJson(after, G0), { resized, after });
    const ratio = await handleDrag('se', ['Shift']);
    check('resize: Shift on a corner keeps the proportions (200 × 100 dragged 20 px wide becomes 220 × 110)', sameJson(ratio, { x: 80, y: 190, w: 220, h: 110 }), ratio);
    const centred = await handleDrag('e', ['Alt']);
    check('resize: Alt resizes from the centre (the right edge dragged 20 px makes it 40 px wider, 20 px on each side)', sameJson(centred, { x: 60, y: 190, w: 240, h: 100 }), centred);

    // ── the keyboard: move, resize, walk, leave, duplicate, delete ──
    await page.focus('.st-canvas');
    const step = async (key) => { await page.keyboard.press(key); return stGeom(stFind(await stDoc(page), RID)); };
    const k1 = await step('ArrowRight'), k2 = await step('Shift+ArrowDown'), k3 = await step('Alt+ArrowRight');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    const k4 = stGeom(stFind(await stDoc(page), RID));
    check('keyboard: an arrow moves the selection 1 px, Shift and an arrow 10 px, Alt and an arrow resizes it, each one undo step',
      sameJson(k1, { x: 81, y: 190, w: 200, h: 100 }) && sameJson(k2, { x: 81, y: 200, w: 200, h: 100 }) && sameJson(k3, { x: 81, y: 200, w: 201, h: 100 }) && sameJson(k4, G0), { k1, k2, k3, k4 });
    await page.keyboard.press('Tab');
    const t1 = (await stState(page)).selected;
    await page.keyboard.press('Shift+Tab');
    const t2 = (await stState(page)).selected;
    await page.keyboard.press('Escape');
    const t3 = (await stState(page)).selected;
    const focusBefore = await page.evaluate(() => document.activeElement && document.activeElement.className);
    await page.keyboard.press('Tab');
    const focusAfter = await page.evaluate(() => document.activeElement && document.activeElement.className);
    check('keyboard: Tab and Shift+Tab walk the elements while one is selected, Escape clears the selection, and Tab then leaves the canvas (no keyboard trap)',
      t1 === TID && t2 === RID && t3 === null && /st-canvas/.test(focusBefore) && !/st-canvas/.test(String(focusAfter)), { t1, t2, t3, focusBefore, focusAfter });
    await page.mouse.click(rc.x, rc.y);
    await page.keyboard.press('Control+d');
    const dup = (await stState(page)).selected;
    const dDoc = await stDoc(page);
    await page.keyboard.press('Delete');
    const gone = !stFind(await stDoc(page), dup);
    await page.keyboard.press('Control+z');
    const backDup = !!stFind(await stDoc(page), dup);
    await page.keyboard.press('Control+z');
    const undupped = !stFind(await stDoc(page), dup);
    check('keyboard: Ctrl+D duplicates beside the original (10 px down and right) under a new id, Delete removes it, and each undoes',
      dup && dup !== RID && sameJson(stGeom(stFind(dDoc, dup)), { x: 90, y: 200, w: 200, h: 100 }) && gone && backDup && undupped, { dup, copy: stGeom(stFind(dDoc, dup)), gone, backDup, undupped });

    // ── token styling: what the panel chooses reaches the frame as a var(--fam-*) reference and resolves to the token ──
    await page.mouse.click(rc.x, rc.y);
    await page.selectOption('.st-panel [data-st-prop="fill"]', 'status-info');
    await page.selectOption('.st-panel [data-st-prop="radius"]', 'radius-xl');
    const tc = await stScreen(page, fx + 180, fy + 354);
    await page.mouse.click(tc.x, tc.y);
    await page.selectOption('.st-panel [data-st-prop="style"]', 'title');
    await page.selectOption('.st-panel [data-st-prop="color"]', 'brand-accent');
    const tok = await page.evaluate(([fid, rid, tid]) => {
      const d = document.querySelector('[data-st-frame="' + fid + '"] iframe').contentDocument, w = d.defaultView;
      const r = d.querySelector('[data-st-id="' + rid + '"]'), t = d.querySelector('[data-st-id="' + tid + '"]');
      const probe = d.createElement('div');
      d.body.appendChild(probe);
      const resolve = (prop, v) => { probe.style.setProperty(prop, v); const out = w.getComputedStyle(probe)[prop.replace(/-(\w)/g, (_, c) => c.toUpperCase())]; probe.style.removeProperty(prop); return out; };
      const out = {
        rBg: r.style.getPropertyValue('background'), rRad: r.style.getPropertyValue('border-radius'), tSize: t.style.getPropertyValue('font-size'), tColor: t.style.getPropertyValue('color'),
        rBgC: w.getComputedStyle(r).backgroundColor, rBgT: resolve('background-color', 'var(--fam-status-info)'),
        rRadC: w.getComputedStyle(r).borderTopLeftRadius, rRadT: resolve('border-top-left-radius', 'var(--fam-radius-xl)'),
        tSizeC: w.getComputedStyle(t).fontSize, tSizeT: resolve('font-size', 'var(--fam-font-size-2xl)'),
        tColorC: w.getComputedStyle(t).color, tColorT: resolve('color', 'var(--fam-brand-accent)'),
      };
      probe.remove();
      return out;
    }, [FID, RID, TID]);
    check('tokens: a fill, a corner radius, a text style and a colour chosen in the panel reach the frame as var(--fam-*) references and resolve there to the token\'s own value',
      tok.rBg === 'var(--fam-status-info)' && tok.rRad === 'var(--fam-radius-xl)' && tok.tSize === 'var(--fam-font-size-2xl)' && tok.tColor === 'var(--fam-brand-accent)'
        && tok.rBgC === tok.rBgT && tok.rRadC === tok.rRadT && tok.tSizeC === tok.tSizeT && tok.tColorC === tok.tColorT && tok.rBgT !== 'rgba(0, 0, 0, 0)', tok);

    // ── the inspector gives the keyboard back: Enter commits and returns to the canvas, Escape restores the value first ──
    await page.mouse.click(rc.x, rc.y);
    await page.fill('.st-panel [data-st-prop="name"]', 'Match card');
    await page.press('.st-panel [data-st-prop="name"]', 'Enter');
    const afterEnter = await page.evaluate(() => document.activeElement && document.activeElement.className);
    const renamed = stFind(await stDoc(page), RID).name;
    await page.keyboard.press('r');
    const toolAfter = (await stState(page)).tool;
    await page.keyboard.press('v');
    await page.fill('.st-panel [data-st-prop="x"]', '999');
    await page.press('.st-panel [data-st-prop="x"]', 'Escape');
    const xField = await page.inputValue('.st-panel [data-st-prop="x"]');
    const afterEscape = await page.evaluate(() => document.activeElement && document.activeElement.className);
    const xKept = stFind(await stDoc(page), RID).x;
    await page.keyboard.press('Control+z');
    check('inspector: Enter commits a field and gives the keyboard back to the canvas, so the next key is a shortcut, not typing; Escape puts the value back first',
      renamed === 'Match card' && /st-canvas/.test(afterEnter) && toolAfter === 'rect' && xField === '80' && xKept === 80 && /st-canvas/.test(afterEscape) && stFind(await stDoc(page), RID).name !== 'Match card',
      { renamed, afterEnter, toolAfter, xField, xKept, afterEscape });

    // ── a drawing tool draws even where a frame's name sits: names and handles answer to the Select tool only ──
    const framesBefore = (await stDoc(page)).frames.length;
    const lab0 = await stScreen(page, fx + 10, fy - 6);
    await page.keyboard.press('f');
    await stDrag(page, lab0, { x: lab0.x + 120, y: lab0.y - 100 });
    const drawnOver = await stDoc(page);
    const firstStill = sameJson(stGeom(drawnOver.frames[0]), { x: fx, y: fy, w: 360, h: 480 });
    await page.keyboard.press('Control+z');
    check('draw: with the Frame tool, a press on an existing frame\'s name draws a new frame and leaves the existing one where it was',
      drawnOver.frames.length === framesBefore + 1 && firstStill && (await stDoc(page)).frames.length === framesBefore, { frames: [framesBefore, drawnOver.frames.length], firstStill });

    // ── frames: media queries answer to the frame's own width, and no script runs inside one ──
    const fl = await stScreen(page, fx + 10, fy - 6);
    await page.mouse.click(fl.x, fl.y);
    const narrowFirst = (await stFrames(page))[0].narrow;
    await page.fill('.st-panel [data-st-prop="w"]', '1280');
    await page.press('.st-panel [data-st-prop="w"]', 'Enter');
    await page.focus('.st-canvas');
    const wide = (await stFrames(page))[0];
    await page.keyboard.press('Control+z');
    const narrowAgain = (await stFrames(page))[0];
    const ran = await stFrameScript(page);
    check('frames: a media query inside a frame answers to the frame\'s own width (max-width 980px holds at 360 px, not at 1280 px), and a script placed in a frame does not run',
      narrowFirst === true && wide.width === 1280 && wide.narrow === false && narrowAgain.narrow === true && ran === false, { narrowFirst, wide: [wide.width, wide.narrow], narrowAgain: [narrowAgain.width, narrowAgain.narrow], ran });

    // ── import: markup is text, CSS is refused, a polluted or oversized or broken file changes nothing ──
    const valid = (over) => JSON.stringify(Object.assign({ format: 'familista.studio.document', version: 1, name: 'Imported design', frames: [
      { id: 'frame-1', type: 'frame', name: 'Imported frame', x: 0, y: 0, w: 360, h: 480, fill: 'surface-base', children: [
        { id: 'rect-1', type: 'rect', name: 'Card', x: 20, y: 20, w: 120, h: 80, fill: 'surface-raised', radius: 'radius-md' },
        { id: 'text-1', type: 'text', name: 'Heading', x: 20, y: 120, w: 200, h: 40, text: 'Hello', style: 'heading', color: 'text-primary' }] }] }, over || {}));
    const before = await stSaved(page);
    const xss = JSON.parse(valid());
    xss.name = '<script>window.__stPwned=1</script>';
    xss.frames[0].name = '<img src=x onerror="window.__stPwned=2">';
    xss.frames[0].children[0].name = '"><svg onload="window.__stPwned=3">';
    xss.frames[0].children[1].text = '<img src=x onerror="window.__stPwned=4"><script>window.__stPwned=5</script>';
    const saidXss = await stImport(page, 'xss.json', JSON.stringify(xss));
    await page.waitForTimeout(300);
    const inert = await page.evaluate(() => {
      const fd = document.querySelector('.st-frame iframe').contentDocument;
      const t = fd.querySelector('.st-text');
      const studio = document.getElementById('pg-design-studio');
      return { pwned: window.__stPwned === undefined ? null : window.__stPwned, text: t && t.textContent, label: (document.querySelector('.st-flabel') || {}).textContent,
        name: document.querySelector('.st-docname').value, frameTags: [...new Set([...fd.body.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()))].sort(),
        studioInjected: studio.querySelectorAll('img, script, svg[onload]').length, onAttrs: [...studio.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length };
    });
    check('xss: names and text full of markup are imported as text: nothing runs, no element is created from them in the page or in a frame, and they read back exactly as typed',
      /Imported/.test(saidXss) && inert.pwned === null && inert.text === xss.frames[0].children[1].text && inert.label === xss.frames[0].name && inert.name === xss.name
        && sameJson(inert.frameTags, ['div']) && inert.studioInjected === 0 && inert.onAttrs === 0, { said: saidXss, inert });
    await page.focus('.st-canvas');
    await page.keyboard.press('Control+z');
    const restored = await stSaved(page);
    const cssBad = JSON.parse(valid());
    cssBad.frames[0].children[0].fill = 'surface-raised; background-image: url(https://evil.test/x.png)';
    const saidCss = await stImport(page, 'css.json', JSON.stringify(cssBad));
    const evil = log.requests.filter((r) => /evil\.test/.test(r.o + r.p));
    const afterCss = await stSaved(page);
    check('css injection: a colour that is not a token name (here one carrying a url()) refuses the whole file, changes nothing and fetches nothing',
      /Not imported/.test(saidCss) && evil.length === 0 && afterCss === restored && restored === before, { said: saidCss, evil: evil.length, unchanged: afterCss === restored, undoneImport: restored === before });
    const polluted = '{"__proto__":{"stPolluted":true},' + valid().slice(1);
    const saidProto = await stImport(page, 'proto.json', polluted);
    const protoClean = await page.evaluate(() => ({}).stPolluted === undefined && Object.prototype.stPolluted === undefined);
    const saidBig = await stImport(page, 'big.json', ' '.repeat(1048577));
    const saidBroken = await stImport(page, 'broken.json', '{"format": "familista.studio.document", ');
    const saidUnknown = await stImport(page, 'unknown.json', valid({ extra: true }));
    const afterBad = await stSaved(page);
    check('import: a file with a __proto__ key, one over 1 MB, one that is not JSON and one with an unknown field are each refused with their reason, pollute nothing and change nothing',
      /Not imported/.test(saidProto) && protoClean && /larger than 1 MB/.test(saidBig) && /not valid JSON/.test(saidBroken) && /field the Studio does not know/.test(saidUnknown) && afterBad === before,
      { saidProto, protoClean, saidBig, saidBroken, saidUnknown, unchanged: afterBad === before });
    const saidOk = await stImport(page, 'ok.json', valid());
    const imported = await stDoc(page);
    await page.focus('.st-canvas');
    await page.keyboard.press('Control+z');
    const undone = await stSaved(page);
    check('import: a valid file replaces the design in one undoable step', /Imported Imported design: 1 frames, 2 elements/.test(saidOk) && imported.name === 'Imported design' && imported.frames[0].children.length === 2 && undone === before, { saidOk, undone: undone === before });

    // ── export: the file is the saved design, byte for byte ──
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('[data-st-act="export"]')]);
    const exported = fs.readFileSync(await dl.path(), 'utf8');
    const savedNow = await stSaved(page);
    check('export: the downloaded file is the design exactly as saved, under a safe file name, and it imports back unchanged',
      exported === savedNow && /^[a-z0-9-]+\.familista-design\.json$/.test(dl.suggestedFilename()) && /Imported/.test(await stImport(page, dl.suggestedFilename(), exported)) && (await stSaved(page)) === savedNow,
      { name: dl.suggestedFilename(), bytes: exported.length });

    // ── the design never leaves this browser; nothing of the Studio's is an error or a CSP violation ──
    const leaks = log.requests.filter((r) => r.body.includes('Squad overview') || (r.m !== 'GET' && /design/i.test(r.p)));
    const ownFiles = [...new Set(log.requests.filter((r) => r.o === BASE && r.p.startsWith('/design-studio/')).map((r) => r.p))].sort();
    check('privacy: the design never leaves the browser: no request carries its content, the Studio writes nothing to the server, and it fetched only its own files and its frames\' stylesheet',
      leaks.length === 0 && sameJson(ownFiles, ['/design-studio/studio-core.js', '/design-studio/studio-frame.css', '/design-studio/studio.css', '/design-studio/studio.js']), { leaks: leaks.map((r) => r.m + ' ' + r.p), ownFiles });
    const split = await stCsp(page);
    check('csp: across everything above, the Studio raised no CSP violation, in the page or in any frame, nothing is unexplained, and no script error was logged (the application\'s own inline-style reports are counted apart)',
      split.studio === 0 && split.unexplained === 0 && log.errors.length === 0, { split, errors: log.errors.slice(0, 5), sandboxRefusals: log.sandbox });
    const ms = await stState(page);
    console.log('MEASURE ' + JSON.stringify({ section: 14, name: 'studio pointer work', moves: ms.moves, moveMsMedian: ms.moveMsMedian, moveMsP95: ms.moveMsP95, moveMsMax: ms.moveMsMax, commits: ms.commits, nodePaints: ms.nodePaints }));
    await ctx.close();

    // ── a club role, and nobody signed in: the Studio never opens and none of its files is fetched ──
    CURRENT = COACH;
    const coach = await openStudio({ width: 1440, height: 900 }, { wait: false });
    await coach.page.waitForTimeout(2500);
    const coachSaw = await coach.page.evaluate(() => ({ open: !!document.querySelector('#pg-design-studio.active'), render: typeof window.renderFamilistaDesignStudio, canvas: !!document.querySelector('.st-canvas') }));
    const coachFiles = coach.log.requests.filter((r) => r.p.startsWith('/design-studio/')).map((r) => r.p);
    await coach.ctx.close();
    CURRENT = OWNER;
    const anon = await openStudio({ width: 1440, height: 900 }, { wait: false, anonymous: true });
    await anon.page.waitForTimeout(2500);
    const anonSaw = await anon.page.evaluate(() => ({ open: !!document.querySelector('#pg-design-studio.active'), render: typeof window.renderFamilistaDesignStudio }));
    const anonFiles = anon.log.requests.filter((r) => r.p.startsWith('/design-studio/')).map((r) => r.p);
    await anon.ctx.close();
    check('access: a club role who types #design-studio is sent away and nobody signed in reaches it either: the Studio never opens and none of its files is fetched',
      !coachSaw.open && coachSaw.render === 'undefined' && !coachSaw.canvas && coachFiles.length === 0 && !anonSaw.open && anonSaw.render === 'undefined' && anonFiles.length === 0,
      { coachSaw, coachFiles, anonSaw, anonFiles });

    // ── every operation undoes to the empty design and redoes to the same bytes; the design survives a reload ──
    const u = await openStudio({ width: 1440, height: 900 });
    const p2 = u.page;
    const empty = await stSaved(p2);
    const b2 = await p2.locator('.st-canvas').boundingBox();
    const s0 = await stState(p2);
    const gx = Math.round(b2.width / 2 - s0.camera.x) - 180, gy = Math.round(b2.height / 2 - s0.camera.y) - 240;
    await p2.keyboard.press('f');
    await stDrag(p2, await stScreen(p2, gx, gy), await stScreen(p2, gx + 360, gy + 480));
    await p2.keyboard.press('r');
    await stDrag(p2, await stScreen(p2, gx + 40, gy + 40), await stScreen(p2, gx + 200, gy + 140));
    await p2.keyboard.press('t');
    const tq = await stScreen(p2, gx + 40, gy + 200);
    await p2.mouse.click(tq.x, tq.y);
    await p2.waitForSelector('.st-textedit:not([hidden])');
    await p2.keyboard.type('Training load');
    await p2.keyboard.press('Escape');
    const rq = await stScreen(p2, gx + 120, gy + 90);
    await stDrag(p2, rq, { x: rq.x + 30, y: rq.y + 20 });
    const hse = await p2.locator('.st-h-se').boundingBox();
    await stDrag(p2, { x: hse.x + hse.width / 2, y: hse.y + hse.height / 2 }, { x: hse.x + hse.width / 2 + 25, y: hse.y + hse.height / 2 + 15 });
    await p2.selectOption('.st-panel [data-st-prop="fill"]', 'brand-accent');
    await p2.focus('.st-canvas');
    await p2.keyboard.press('Control+d');
    await p2.keyboard.press('Delete');
    await p2.fill('.st-docname', 'Training board');
    await p2.press('.st-docname', 'Enter');
    await p2.focus('.st-canvas');
    const final = await stSaved(p2);
    const steps = (await stState(p2)).undo;
    for (let i = 0; i < steps; i++) await p2.keyboard.press('Control+z');
    const undoneAll = await stSaved(p2);
    for (let i = 0; i < steps; i++) await p2.keyboard.press('Control+Shift+z');
    const redoneAll = await stSaved(p2);
    check(`history: ${steps} operations (draw, type, move, resize, restyle, duplicate, delete, rename) undo back to the empty design and redo to the same bytes`,
      steps >= 10 && undoneAll === empty && redoneAll === final, { steps, undoneToEmpty: undoneAll === empty, redoneToFinal: redoneAll === final });
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForSelector('.st-canvas', { timeout: 30000 });
    const reopenedSaid = await stHeard(p2, '', 3000);
    const reopened = await stSaved(p2);
    const reFrames = await stFrames(p2);
    check('save: a reload reopens the design saved in this browser, byte for byte, drawn again in its frames, and says so',
      reopened === final && reFrames.length === 1 && /Opened Training board/.test(reopenedSaid), { same: reopened === final, frames: reFrames.length, said: reopenedSaid });
    await p2.evaluate((k) => localStorage.setItem(k, '{"format": "not a design"'), ST_KEY);
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForSelector('.st-canvas', { timeout: 30000 });
    const corruptSaid = await stHeard(p2, '', 3000);
    const kept = await p2.evaluate(() => localStorage.getItem('familista_design_studio_document_unreadable'));
    const fresh = JSON.parse(await stSaved(p2));
    check('save: an unreadable saved design is never opened: a new design starts, the unreadable copy is kept aside, and the reader is told',
      fresh.frames.length === 0 && kept === '{"format": "not a design"' && /could not be read/.test(corruptSaid), { frames: fresh.frames.length, kept, said: corruptSaid });
    await p2.keyboard.press('f');
    await p2.focus('.st-canvas');
    await p2.keyboard.press('Enter');
    await p2.keyboard.press('Shift+ArrowLeft');
    await p2.waitForTimeout(150);
    const live = await p2.evaluate(() => { const l = document.getElementById('st-live'); return { role: l.getAttribute('role'), polite: l.getAttribute('aria-live'), text: l.textContent }; });
    check('announcements: an operation is announced in a polite status region by name and number (a frame nudged 10 px says where it went)',
      live.role === 'status' && live.polite === 'polite' && /^Frame 1 moved to -?\d+, -?\d+$/.test(live.text), live);
    const uSplit = await stCsp(p2);
    check('csp: the history, reload and recovery run raised no Studio CSP violation and no script error', uSplit.studio === 0 && uSplit.unexplained === 0 && u.log.errors.length === 0, { split: uSplit, errors: u.log.errors.slice(0, 5), sandboxRefusals: u.log.sandbox });
    await u.ctx.close();

    // ── Arabic: the room is right to left, the canvas is not, and a drag is still exact ──
    const a = await openStudio({ width: 1440, height: 900 }, { locale: 'ar' });
    const ar = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/design-studio/i18n/ar.json'), 'utf8'));
    const ba = await a.page.locator('.st-canvas').boundingBox();
    const sa = await stState(a.page);
    const ax = Math.round(ba.width / 2 - sa.camera.x) - 180, ay = Math.round(ba.height / 2 - sa.camera.y) - 240;
    await a.page.keyboard.press('f');
    await stDrag(a.page, await stScreen(a.page, ax, ay), await stScreen(a.page, ax + 360, ay + 480));
    const before30 = stGeom((await stDoc(a.page)).frames[0]);
    const lab = await stScreen(a.page, ax + 10, ay - 6);
    await stDrag(a.page, lab, { x: lab.x + 30, y: lab.y });
    const after30 = stGeom((await stDoc(a.page)).frames[0]);
    const rtl = await a.page.evaluate(() => ({ dir: document.getElementById('st-root').getAttribute('dir'), lang: document.getElementById('st-root').getAttribute('lang'),
      canvas: document.querySelector('.st-canvas').getAttribute('dir'), title: document.querySelector('.st-title').textContent, frameLabel: (document.querySelector('.st-flabel') || {}).textContent,
      panelLeft: document.querySelector('.st-panel').getBoundingClientRect().left < document.querySelector('.st-canvas').getBoundingClientRect().left }));
    const arSplit = await stCsp(a.page);
    check('arabic: the Studio speaks Arabic right to left with the panel on the left, the canvas keeps left-to-right coordinates, a 30 px drag of a frame\'s name moves it 30 px, and nothing is a CSP violation',
      rtl.dir === 'rtl' && rtl.lang === 'ar' && rtl.canvas === 'ltr' && rtl.title === ar['Design Studio'] && rtl.frameLabel === ar['Frame'] + ' 1' && rtl.panelLeft
        && after30.x === before30.x + 30 && after30.y === before30.y && arSplit.studio === 0 && arSplit.unexplained === 0 && a.log.errors.length === 0, { rtl, before30, after30, split: arSplit, errors: a.log.errors.slice(0, 5), sandboxRefusals: a.log.sandbox });
    await a.ctx.close();

    // ── small windows: the escape hatch gives a normal page that scrolls down, never sideways ──
    const small = [];
    for (const vp of [{ width: 900, height: 700 }, { width: 390, height: 844 }]) {
      const s = await openStudio(vp);
      small.push(await s.page.evaluate(() => {
        const se = document.scrollingElement;
        return { w: innerWidth, sideways: se.scrollWidth > innerWidth + 1, scrolls: se.scrollHeight > innerHeight, canvasH: Math.round(document.querySelector('.st-canvas').getBoundingClientRect().height),
          panelBelow: document.querySelector('.st-panel').getBoundingClientRect().top >= document.querySelector('.st-canvas').getBoundingClientRect().bottom - 1 };
      }));
      await s.ctx.close();
    }
    check('responsive: at 900 × 700 and at 390 × 844 the Studio becomes a normal scrolling page (canvas at least 420 px tall, the panel below it) and never scrolls sideways',
      small.every((s) => !s.sideways && s.scrolls && s.canvasH >= 420 && s.panelBelow), small);

    // ── resources: entering and leaving, with work done each time, leaves nothing behind ──
    const r = await openStudio({ width: 1440, height: 900 }, { hash: '/#owner-home', wait: false });
    await r.page.waitForFunction(() => typeof window.navTo === 'function' && document.querySelector('.page.active'), null, { timeout: 30000 });
    await r.page.waitForTimeout(1500);
    const cdp = await r.ctx.newCDPSession(r.page);
    await cdp.send('HeapProfiler.enable');
    const listeners = async () => {
      let n = 0;
      for (const expr of ['window', 'document']) {
        const o = await cdp.send('Runtime.evaluate', { expression: expr });
        n += (await cdp.send('DOMDebugger.getEventListeners', { objectId: o.result.objectId })).listeners.length;
      }
      return n;
    };
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
    const cycle = async () => {
      const t0 = Date.now();
      await r.page.evaluate(() => window.navTo('design-studio'));
      await r.page.waitForSelector('.st-canvas', { timeout: 30000 });
      const openMs = Date.now() - t0;
      await r.page.keyboard.press('f');
      await r.page.focus('.st-canvas');
      await r.page.keyboard.press('Enter');
      for (let i = 0; i < 25; i++) await r.page.keyboard.press('ArrowRight');
      for (let i = 0; i < 25; i++) await r.page.keyboard.press('Control+z');
      await r.page.evaluate(() => window.navTo('owner-home'));
      await r.page.waitForFunction(() => !document.querySelector('.st-canvas'), null, { timeout: 10000 });
      return openMs;
    };
    await cycle();                                         // one unmeasured pass: the application's own first-entry work
    const l0 = await listeners(), h0 = await heap();
    const opens = [];
    for (let i = 0; i < 3; i++) opens.push(await cycle());
    const l1 = await listeners(), h1 = await heap();
    const left = await r.page.evaluate(() => ({ frames: document.querySelectorAll('.st-frame, iframe.st-frame-doc').length, rootKids: (document.getElementById('st-root') || { childElementCount: -1 }).childElementCount, bodyClass: document.body.classList.contains('st-studio-open') }));
    console.log('MEASURE ' + JSON.stringify({ section: 14, name: 'studio enter and leave', cycles: 3, opsPerCycle: 51, openMs: opens, listenersBefore: l0, listenersAfter: l1, heapGrowthKB: Math.round((h1 - h0) / 102.4) / 10 }));
    check('resources: three more entries and exits, 51 operations each, leave no listener on window or document, no frame and no Studio node behind (one unmeasured pass first)',
      l1 === l0 && left.frames === 0 && left.rootKids === 0 && !left.bodyClass, { listeners: [l0, l1], left });
    await r.ctx.close();

    // ── controls: each detector above can fail ──
    const c1 = await openStudio({ width: 1440, height: 900 }, { studioPatch: (s) => s.replace("E.empty = h('div', { class: 'st-empty' }", "E.empty = h('div', { class: 'st-empty', style: 'outline: 1px solid red' }") });
    await c1.page.waitForTimeout(400);
    const c1Split = await stCsp(c1.page);
    check('csp (control): a studio.js that writes one inline style attribute in the Studio\'s page is caught as the Studio\'s violation, so a clean count means something',
      c1Split.studio >= 1, c1Split);
    await c1.ctx.close();
    const c2 = await openStudio({ width: 1440, height: 900 }, { studioPatch: (s) => s.replace("el.className = 'st-el st-' + n.type;", "el.className = 'st-el st-' + n.type; el.setAttribute('style', 'outline: 1px solid red');") });
    await c2.page.keyboard.press('f');
    await c2.page.focus('.st-canvas');
    await c2.page.keyboard.press('Enter');
    await c2.page.keyboard.press('r');
    await c2.page.keyboard.press('Enter');
    await c2.page.waitForTimeout(400);
    const c2Split = await stCsp(c2.page);
    check('csp (control): a studio.js that writes an inline style attribute inside a frame is caught, so frames inherit the page\'s policy and their reports are seen',
      c2Split.studio >= 1 && c2Split.studioDirectives.some((d) => /\(frame\)/.test(d)), c2Split);
    await c2.ctx.close();
    const c3 = await openStudio({ width: 1440, height: 900 }, { studioPatch: (s) => s.replace("sandbox: 'allow-same-origin'", "sandbox: 'allow-same-origin allow-scripts'") });
    await c3.page.keyboard.press('f');
    await c3.page.focus('.st-canvas');
    await c3.page.keyboard.press('Enter');
    const c3f = await stFrames(c3.page);
    const c3ran = await stFrameScript(c3.page);
    check('frames (control): a studio.js that also allows scripts in a frame fails the sandbox check above, and the same injected script then runs, so both proofs can fail',
      c3f.length === 1 && c3f[0].sandbox !== 'allow-same-origin' && c3ran === true, { frames: c3f, ran: c3ran });
    await c3.ctx.close();
  }

  if (WANT_AXE && want('14a')) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (!fs.existsSync(axePath)) skip('studio under axe', 'axe-core is not installed (' + axePath + ')');
    else {
      const AXE = fs.readFileSync(axePath, 'utf8');
      const axeStudio = (pg) => pg.evaluate(async (src) => {
        if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
        const r = await window.axe.run({ include: ['#pg-design-studio'], exclude: [['.st-frame-doc']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        return r.violations.map((v) => v.id + ':' + v.nodes.length + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join('|'));
      }, AXE);
      for (const loc of ['en', 'ar']) {
        const s = await openStudio({ width: 1440, height: 900 }, { locale: loc });
        const found = { empty: await axeStudio(s.page) };
        await s.page.keyboard.press('f');
        await s.page.focus('.st-canvas');
        await s.page.keyboard.press('Enter');
        await s.page.keyboard.press('r');
        await s.page.keyboard.press('Enter');
        found.selected = await axeStudio(s.page);
        check(`studio under axe (${loc}): the empty Studio and the Studio with a rectangle selected and its properties open have 0 violations (WCAG 2.2 A/AA)`,
          found.empty.length === 0 && found.selected.length === 0, found);
        if (loc === 'en') {
          await s.page.evaluate(() => { const b = document.createElement('button'); b.type = 'button'; document.querySelector('.st-bar .st-group').appendChild(b); });
          const v = await axeStudio(s.page);
          check('studio under axe (control): a button with no name placed in the tool bar is reported by the same run, so a clean result means something', v.some((x) => /^button-name/.test(x)), v);
        }
        await s.ctx.close();
      }
    }
  }

  // ══ 15. the translator keeps nothing that has left the page ═════════════════
  // public/i18n/dom.js remembers the English of every node it translates, so that a change of language can put it back. Every
  // screen here paints by replacing its markup, so the nodes it remembers leave the page all the time. Held strongly, each of
  // them keeps alive the whole tree it was part of: in any session not in en-GB (en-GB translates nothing, so remembers
  // nothing), one Owner Home of old cards, about 280 nodes, stayed in memory for every visit to Owner Home.
  //
  // Chrome's "detached" label cannot be used to see that: it marks a node detached only while the node still has a JavaScript
  // wrapper, and most of a discarded tree has none. So detached nodes are counted from the heap graph (domRetention), in real
  // sessions whose language is read back from the page, over three measured cycles of the two ways a reader leaves Owner Home
  // and returns: through Clubs, and through Design System Control (a room loaded on demand that takes the shell and tears
  // itself down on the way out). No Playwright element handle is held: every wait returns true or false and is disposed, and
  // every navigation is the application's own navTo.
  // The control serves a dom.js whose bookkeeping holds nodes strongly again and requires the same counts to turn red. The
  // contract checks hold the translator to what it already did: text and attributes, inserted or rewritten later, removed and
  // put back, through a change of language and back to English, behind the same public API.
  if (want('15')) {
    CURRENT = OWNER;
    const HOME_CARDS = () => document.querySelectorAll('#owner-home-content .oh-card').length >= 9;
    // The page's requests in flight, so a measurement is taken with no status line still on its way into a card.
    const quietNet = async (pg, net) => {
      for (let i = 0; i < 60; i++) {
        if (net.n <= 0) { await pg.waitForTimeout(200); if (net.n <= 0) return; } else await pg.waitForTimeout(100);
      }
    };
    async function openHome(tag, domPatch) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: tag });
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      if (domPatch) {
        const original = fs.readFileSync(path.join(ROOT, 'public/i18n/dom.js'), 'utf8');
        const patched = domPatch(original);
        if (patched === original) throw new Error('negative control: the edit did not change i18n/dom.js, so it would prove nothing');
        await ctx.route(/\/i18n\/dom\.js(\?|$)/, (r) => r.fulfill({ contentType: 'application/javascript', body: patched }));
      }
      await ctx.addCookies([{ name: 'access_token', value: token, domain: '127.0.0.1', path: '/', httpOnly: true }]);
      // The language is chosen the way a returning reader's is: from the cache the application itself keeps (public/i18n/i18n.js).
      await ctx.addInitScript((t) => { try { localStorage.setItem('familista.locale', t); } catch (_) { /* private mode */ } }, tag);
      const page = await ctx.newPage();
      const net = { n: 0 };
      page.on('request', () => net.n++); page.on('requestfinished', () => net.n--); page.on('requestfailed', () => net.n--);
      await page.goto(BASE + '/#owner-home', { waitUntil: 'load' });
      await (await page.waitForFunction(HOME_CARDS, null, { timeout: 30000 })).dispose();
      await quietNet(page, net); await frames(page);
      return { ctx, page, net };
    }
    const visit = async (pg, net, to, ready) => {
      await pg.evaluate((p) => window.navTo(p), to);
      await (await pg.waitForFunction(ready, null, { timeout: 30000 })).dispose();
      await quietNet(pg, net); await frames(pg);
    };
    const ROUTES = {
      'Owner Home → Clubs → Owner Home': async (pg, net) => {
        await visit(pg, net, 'clubs', () => { const a = document.querySelector('.page.active'); return !!a && a.id === 'pg-clubs'; });
        await visit(pg, net, 'owner-home', HOME_CARDS);
      },
      'Owner Home → Design System Control → Owner Home': async (pg, net) => {
        await visit(pg, net, 'design-system', () => !!document.querySelector('#pg-design-system.active .ds-metric'));
        await visit(pg, net, 'owner-home', HOME_CARDS);
      },
    };

    // A heap snapshot after the same two forced collections memoryOf uses, read as a graph. A DOM node is a native object that
    // names a node and has an edge to a document. It is attached if a document reaches it through DOM-tree edges, and detached
    // if none does, or if Chrome labels it so (which it never does for a node a document reaches). `held` is how many detached
    // nodes the translator's own bookkeeping reaches: window.I18N_DOM.start's closure, its `tracked` and `trackedAttr`, their
    // tables, then the DOM tree, never a weak edge. `holders` groups detached nodes by the last steps of their shortest
    // retaining path from the heap's root, so a failure names what keeps them.
    async function domRetention(pg) {
      const cdp = await pg.context().newCDPSession(pg);
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
      const parts = []; const onChunk = (e) => parts.push(e.chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await cdp.detach();
      const s = JSON.parse(parts.join('')); parts.length = 0;
      const m = s.snapshot.meta, nf = m.node_fields.length, ef = m.edge_fields.length, nT = m.node_types[0], eT = m.edge_types[0];
      const iT = m.node_fields.indexOf('type'), iN = m.node_fields.indexOf('name'), iE = m.node_fields.indexOf('edge_count'), iD = m.node_fields.indexOf('detachedness');
      const N = s.nodes.length / nf, first = new Uint32Array(N + 1);
      for (let i = 0, e = 0; i < N; i++) { first[i] = e; e += s.nodes[i * nf + iE] * ef; }
      first[N] = s.edges.length;
      const name = (o) => s.strings[s.nodes[o * nf + iN]], native = (o) => nT[s.nodes[o * nf + iT]] === 'native';
      const ELEMENT = eT.indexOf('element'), HIDDEN = eT.indexOf('hidden'), WEAK = eT.indexOf('weak');
      const CONTEXT = eT.indexOf('context'), PROPERTY = eT.indexOf('property'), INTERNAL = eT.indexOf('internal');
      const edgeName = (e) => (s.edges[e] === ELEMENT || s.edges[e] === HIDDEN ? String(s.edges[e + 1]) : s.strings[s.edges[e + 1]]);
      const to = (e) => s.edges[e + 2] / nf;
      const DOC = /^(Detached )?(HTML|XML)?Document\b|^#document|^<#document/;
      const NODE = /^(Detached )?(<[a-zA-Z#!]|Text$|Comment$|CDATASection$|DocumentFragment$|ShadowRoot$|DocumentType$|(HTML|SVG|MathML)\w*Element$)/;
      const isDoc = new Uint8Array(N), isNode = new Uint8Array(N);
      for (let o = 0; o < N; o++) if (native(o) && DOC.test(name(o))) isDoc[o] = 1;
      for (let o = 0; o < N; o++) {
        if (!native(o) || isDoc[o] || !NODE.test(name(o))) continue;
        for (let e = first[o]; e < first[o + 1]; e += ef) if (s.edges[e] === ELEMENT && isDoc[to(e)]) { isNode[o] = 1; break; }
      }
      const attached = new Uint8Array(N), q = [];
      for (let o = 0; o < N; o++) if (isDoc[o]) { attached[o] = 1; q.push(o); }
      while (q.length) {
        const o = q.pop();
        for (let e = first[o]; e < first[o + 1]; e += ef) if (s.edges[e] === ELEMENT && isNode[to(e)] && !attached[to(e)]) { attached[to(e)] = 1; q.push(to(e)); }
      }
      const detached = new Uint8Array(N);
      let documents = 0, domNodes = 0, count = 0, labelled = 0;
      for (let o = 0; o < N; o++) {
        if (isDoc[o]) documents++;
        if (!isNode[o]) continue;
        domNodes++;
        const lab = iD >= 0 && s.nodes[o * nf + iD] === 2;
        if (lab) labelled++;
        if (!attached[o] || lab) { detached[o] = 1; count++; }
      }
      const step = (o, type, n) => { for (let e = first[o]; e < first[o + 1]; e += ef) if (s.edges[e] === type && edgeName(e) === n) return to(e); return -1; };
      let maps = [];
      for (let o = 0; o < N && !maps.length; o++) {
        if (native(o) || !/^Window\b/.test(name(o))) continue;
        const api = step(o, PROPERTY, 'I18N_DOM'), start = api < 0 ? -1 : step(api, PROPERTY, 'start'), scope = start < 0 ? -1 : step(start, INTERNAL, 'context');
        if (scope >= 0) maps = ['tracked', 'trackedAttr'].map((v) => step(scope, CONTEXT, v)).filter((x) => x >= 0);
      }
      const seen = new Uint8Array(N), stack = [];
      for (const mp of maps) {
        const table = step(mp, INTERNAL, 'table');
        if (table >= 0) for (let e = first[table]; e < first[table + 1]; e += ef) if (s.edges[e] !== WEAK && isNode[to(e)] && !seen[to(e)]) { seen[to(e)] = 1; stack.push(to(e)); }
      }
      let held = 0;
      while (stack.length) {
        const o = stack.pop();
        if (!detached[o]) continue;
        held++;
        for (let e = first[o]; e < first[o + 1]; e += ef) if (s.edges[e] === ELEMENT && isNode[to(e)] && !seen[to(e)]) { seen[to(e)] = 1; stack.push(to(e)); }
      }
      const parent = new Int32Array(N).fill(-1), via = new Int32Array(N).fill(-1), bq = new Uint32Array(N);
      let h = 0, t = 0; parent[0] = 0; bq[t++] = 0;
      while (h < t) {
        const o = bq[h++];
        for (let e = first[o]; e < first[o + 1]; e += ef) { if (s.edges[e] === WEAK || parent[to(e)] !== -1) continue; parent[to(e)] = o; via[to(e)] = e; bq[t++] = to(e); }
      }
      const label = (o) => { const n = edgeName(via[o]); return eT[s.edges[via[o]]] + ':' + (/^\d+$/.test(n) ? '#' : n.slice(0, 32)) + ' > ' + name(o).replace(/\s+/g, ' ').slice(0, 48); };
      const holders = {};
      for (let o = 0; o < N; o++) {
        if (!detached[o]) continue;
        let sig = '(no strong path from the root)';
        if (parent[o] !== -1) {
          const p = []; for (let x = o, g = 0; x !== 0 && g < 400; x = parent[x], g++) p.push(x);
          p.reverse();
          const k = p.findIndex((x) => detached[x]);
          sig = p.slice(Math.max(0, k - 3), k + 1).map(label).join('  |  ');
        }
        holders[sig] = (holders[sig] || 0) + 1;
      }
      return { documents, domNodes, detached: count, labelledDetached: labelled, held, bookkeeping: maps.length, holders };
    }
    const growing = (a, b) => Object.entries(b.holders).map(([k, n]) => [n - (a.holders[k] || 0), k]).filter(([d]) => d > 0).sort((x, y) => y[0] - x[0]).slice(0, 3);
    const brief = (r) => ({ documents: r.documents, domNodes: r.domNodes, detached: r.detached, labelledDetached: r.labelledDetached, held: r.held, bookkeeping: r.bookkeeping });
    async function retention(tag, route, domPatch) {
      const { ctx, page, net } = await openHome(tag, domPatch);
      const lang = await page.evaluate(() => {
        const st = window.I18N_DOM ? window.I18N_DOM.stats() : null;
        return { application: window.I18N ? window.I18N.locale() : null, translator: window.I18N_DOM ? window.I18N_DOM.locale() : null, entries: st ? st.entries : -1, tracked: st ? st.tracked : -1 };
      });
      await ROUTES[route](page, net);                         // one unmeasured cycle, as the official memory gate does
      const before = await domRetention(page);
      for (let i = 0; i < 3; i++) await ROUTES[route](page, net);
      const after = await domRetention(page);
      return { ctx, page, lang, before, after, growth: after.detached - before.detached, documentGrowth: after.documents - before.documents };
    }

    let contractsPage = null, contractsCtx = null;
    for (const [tag, route] of [['de-DE', 'Owner Home → Clubs → Owner Home'], ['de-DE', 'Owner Home → Design System Control → Owner Home'], ['en-US', 'Owner Home → Clubs → Owner Home'], ['en-GB', 'Owner Home → Clubs → Owner Home']]) {
      const r = await retention(tag, route);
      const base = tag === 'en-GB';
      const id = `translator memory (${tag}, ${route})`;
      check(`${id}: the page is in ${tag} by the application's account and the translator's, and the translator ${base ? 'has nothing to translate' : 'is translating it'}`,
        r.lang.application === tag && r.lang.translator === tag && (base ? r.lang.entries === 0 && r.lang.tracked === 0 : r.lang.entries > 0 && r.lang.tracked > 0), r.lang);
      check(`${id}: over three measured cycles no DOM node that left the page stays in memory, and no document is added (counted from the heap graph, not from Chrome's label)`,
        r.growth <= 0 && r.documentGrowth <= 0, { growth: r.growth, perCycle: Math.round(r.growth / 3), documentGrowth: r.documentGrowth, before: brief(r.before), after: brief(r.after), growingHolders: growing(r.before, r.after) });
      check(`${id}: the translator's bookkeeping holds no node that has left the page`, r.after.bookkeeping === 2 && r.after.held === 0, { before: r.before.held, after: r.after.held, bookkeepingFound: r.after.bookkeeping });
      if (!contractsPage && tag === 'de-DE') { contractsPage = r.page; contractsCtx = r.ctx; } else await r.ctx.close();
    }

    // control: the same measurement of a dom.js that remembers translated nodes strongly again
    try {
      const c = await retention('de-DE', 'Owner Home → Clubs → Owner Home', (src) => src.replace(/new WeakMap\(\)/g, 'new Map()'));
      check('translator memory (control): a dom.js whose bookkeeping holds translated nodes strongly again keeps old Owner Home trees in memory, and the same counts see it',
        c.growth > 0 && c.after.held > 0, { growth: c.growth, perCycle: Math.round(c.growth / 3), before: brief(c.before), after: brief(c.after), growingHolders: growing(c.before, c.after) });
      await c.ctx.close();
    } catch (e) { fail('translator memory (control): a dom.js whose bookkeeping holds translated nodes strongly again keeps old Owner Home trees in memory, and the same counts see it', String(e && e.message || e)); }

    // The translator's contracts, on the de-DE page measured above: three catalogue words that de-DE and fr-FR translate
    // differently, in text, in a title and in an aria-label, inserted after start, rewritten in place, removed and put back.
    const k = await contractsPage.evaluate(async () => {
      const D = window.I18N_DOM;
      const two = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const de = await D.load('de-DE'), fr = await D.load('fr-FR');
      const keys = Object.keys(de).filter((x) => /^[A-Z][a-z]{4,12}$/.test(x) && typeof de[x] === 'string' && typeof fr[x] === 'string'
        && de[x] !== x && fr[x] !== x && de[x] !== fr[x] && de[x].indexOf('%') < 0 && fr[x].indexOf('%') < 0 && !(de[x] in de) && !(fr[x] in fr)).slice(0, 3);
      if (keys.length < 3) return { skipped: 'fewer than three suitable catalogue words in de-DE and fr-FR' };
      const [K1, K2, K3] = keys;
      const box = document.createElement('div'); box.id = 'proof-i18n-contracts';
      const text = document.createElement('span'); text.textContent = K1;
      const button = document.createElement('button'); button.type = 'button'; button.title = K1; button.setAttribute('aria-label', K2); button.textContent = K3;
      const rewritten = document.createElement('span'); rewritten.textContent = '—';      // not prose: left alone until rewritten
      const moved = document.createElement('span'); moved.textContent = K2;
      const user = document.createElement('span'); user.setAttribute('data-no-i18n', ''); user.textContent = K1;
      box.append(text, button, rewritten, moved, user);
      const read = () => ({ text: text.textContent, title: button.title, aria: button.getAttribute('aria-label'), button: button.textContent, rewritten: rewritten.textContent, moved: moved.textContent, user: user.textContent });
      document.body.appendChild(box); await two(); await two();
      const inserted = read();
      rewritten.firstChild.nodeValue = K3; await two(); await two();
      const afterRewrite = rewritten.textContent;
      moved.remove(); await two(); box.appendChild(moved); await two(); await two();
      const afterReinsert = moved.textContent;
      const scan = D.scan(box).map((x) => x.text + ' | ' + x.where + ' | ' + x.translated).sort();
      const stats = D.stats(), api = Object.keys(D).sort();
      await D.setLocale('fr-FR'); await two();
      const french = read();
      await D.setLocale('en-GB'); await two();
      const english = read();
      await D.setLocale('de-DE'); await two();
      const again = read();
      box.remove();
      return { keys, de: [de[K1], de[K2], de[K3]], fr: [fr[K1], fr[K2], fr[K3]], inserted, afterRewrite, afterReinsert, scan, stats, api, french, english, again };
    });
    const tc = 'translation contracts (de-DE, then fr-FR, en-GB and de-DE again)';
    if (k.skipped) skip(tc, k.skipped);
    else {
      const [K1, K2, K3] = k.keys, [d1, d2, d3] = k.de, [f1, f2, f3] = k.fr;
      const all = (o, a, b, c) => o.text === a && o.title === a && o.aria === b && o.button === c && o.user === K1;
      check(`${tc}: text, a title and an aria-label inserted after start are translated, and a data-no-i18n subtree is not`, all(k.inserted, d1, d2, d3) && k.inserted.moved === d2, { keys: k.keys, got: k.inserted });
      check(`${tc}: a text node rewritten in place with catalogue English is translated (the observer's characterData path)`, k.afterRewrite === d3, { want: d3, got: k.afterRewrite });
      check(`${tc}: a translated node removed and put back is still translated`, k.afterReinsert === d2, { want: d2, got: k.afterReinsert });
      check(`${tc}: scan reports the English each node was built from, flagged translated`, JSON.stringify(k.scan) === JSON.stringify([K1 + ' | text | true', K2 + ' | aria-label | true', K3 + ' | text | true'].sort()), k.scan);
      check(`${tc}: switching to fr-FR translates every node again from its English, text and attributes, the rewritten and the re-inserted node included`, all(k.french, f1, f2, f3) && k.french.rewritten === f3 && k.french.moved === f2, k.french);
      check(`${tc}: switching to en-GB restores every original, text and attributes`, all(k.english, K1, K2, K3) && k.english.rewritten === K3 && k.english.moved === K2, k.english);
      check(`${tc}: switching back to de-DE translates the restored English again`, all(k.again, d1, d2, d3) && k.again.rewritten === d3 && k.again.moved === d2, k.again);
      check(`${tc}: the public API is the same ten functions, and stats() the same six fields`,
        JSON.stringify(k.api) === JSON.stringify(['disable', 'enable', 'load', 'locale', 'missing', 'scan', 'setLocale', 'start', 'stats', 'translateTree'])
        && JSON.stringify(Object.keys(k.stats).sort()) === JSON.stringify(['entries', 'locale', 'missing', 'passes', 'replaced', 'tracked'])
        && typeof k.stats.tracked === 'number' && k.stats.tracked > 0 && k.stats.locale === 'de-DE', { api: k.api, stats: k.stats });
    }
    await contractsCtx.close();
  }

  // ══ 16. The AI Agents Operations Room: discovered, read-only, owner-only, and still where it was drawn ═══════════
  // The platform owner's room for the Agent Registry, at #agents-room, loaded on demand for the owner only and reached from
  // SYSTEM → AI Agent Control. These proofs read the room against the server's own registry response, add a domain and an
  // agent to that response to show the room discovers rather than lists, drive it with the real mouse and keyboard, and
  // watch every request it makes. Each is paired with a control that breaks the property on purpose (a patched room
  // script) and must turn the same measurement red.
  const AR_FILES = ['/agents-room/agents-room.css', '/agents-room/agents-room.js'];
  async function openRoom(viewport, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    if (opts.roomPatch) {
      const original = fs.readFileSync(path.join(ROOT, 'public/agents-room/agents-room.js'), 'utf8');
      const patched = opts.roomPatch(original);
      if (patched === original) throw new Error('negative control: the edit did not change agents-room.js, so it would prove nothing');
      await ctx.route(/\/agents-room\/agents-room\.js(\?|$)/, (r) => r.fulfill({ contentType: 'application/javascript', body: patched }));
    }
    // The registry's own answer, extended or failed on purpose; /system/agents/:agentId is never touched.
    if (opts.overview || opts.fail) {
      await ctx.route(/\/api\/v1\/system\/agents(\?|$)/, async (r) => {
        if (opts.fail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"proof"}' });
        const res = await r.fetch();
        const body = await res.json();
        body.data = opts.overview(body.data);
        return r.fulfill({ response: res, json: body });
      });
    }
    if (!opts.anonymous) await ctx.addCookies([{ name: 'access_token', value: opts.token || token, domain: '127.0.0.1', path: '/', httpOnly: true }]);
    await ctx.addInitScript((pre) => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        let src = '';
        try { src = e.sourceFile ? new URL(e.sourceFile).pathname : ''; } catch (_) { src = String(e.sourceFile || ''); }
        window.__csp.push({ d: e.violatedDirective, uri: String(e.blockedURI).slice(0, 120), src,
          inRoom: !!(e.target && e.target.closest && e.target.closest('#pg-agents-room')) });
      });
      try {
        if (pre && !sessionStorage.getItem('__arSeeded')) {
          sessionStorage.setItem('__arSeeded', '1');
          if (pre.locale) localStorage.setItem('familista_agents_room_locale', pre.locale);
        }
      } catch (_) { /* private mode */ }
    }, { locale: opts.locale || null });
    const page = await ctx.newPage();
    const log = { errors: [], notices: [], requests: [] };
    page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (NOTICE.test(m.text())) log.notices.push({ text: m.text().slice(0, 200), url: String((m.location() && m.location().url) || '').slice(0, 200) });
      else log.errors.push('console: ' + m.text().slice(0, 200));
    });
    page.on('request', (r) => { const u = new URL(r.url()); log.requests.push({ m: r.method(), p: u.pathname, q: u.search, o: u.origin }); });
    await page.goto(BASE + (opts.hash || '/#agents-room'), { waitUntil: 'load' });
    if (opts.wait !== false) await page.waitForSelector(opts.waitFor || '.ar-map', { timeout: 30000 });
    return { ctx, page, log };
  }
  // A CSP report is the room's if it was raised inside the room's page or by one of its files, or names one. The application's
  // own inline-style reports (style-src-attr from a first-party script or the page's HTML) are counted apart; anything else is
  // unexplained.
  const arCsp = (page) => page.evaluate(() => {
    const v = window.__csp || [];
    const room = (c) => c.inRoom || /agents-room\//.test(c.src) || /agents-room\//.test(c.uri);
    const app = (c) => !room(c) && c.d === 'style-src-attr' && /^\//.test(c.src);
    return { total: v.length, room: v.filter(room).length, application: v.filter(app).length,
      unexplained: v.filter((c) => !room(c) && !app(c)).map((c) => c.d + ' @' + (c.src || '(no source)')) };
  });
  // The registry exactly as the server answers it to this owner, read beside the room.
  const registryOf = (page) => page.evaluate(() => fetch('/api/v1/system/agents', { credentials: 'include', cache: 'no-store' }).then((r) => r.json()).then((b) => b.data));
  const drawn = (page) => page.evaluate(() => ({
    nodes: [...document.querySelectorAll('.ar-map .ar-node')].map((n) => n.getAttribute('data-ar-agent')),
    sectors: [...document.querySelectorAll('.ar-map .ar-sec')].map((n) => n.getAttribute('data-ar-sector')),
    chips: [...document.querySelectorAll('.ar-dom')].map((n) => n.getAttribute('data-ar-domain')),
  }));
  // Where each node is drawn, and whether a pointer held still on its centre keeps it there and keeps hitting it.
  async function hoverHold(page) {
    const at = await page.evaluate(() => [...document.querySelectorAll('.ar-map .ar-node')].map((n) => {
      const r = n.querySelector('.ar-node-body').getBoundingClientRect();
      return { id: n.getAttribute('data-ar-agent'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
    const slipped = [];
    for (const n of at) {
      await page.mouse.move(n.x, n.y);
      // Every frame for eight frames: a node that slips out from under the pointer and back is caught in either phase.
      const seen = await page.evaluate(async (p) => {
        const bad = [];
        for (let k = 0; k < 8; k++) {
          await new Promise((r) => requestAnimationFrame(() => r()));
          const hit = document.elementFromPoint(p.x, p.y);
          const owner = hit && hit.closest ? hit.closest('[data-ar-agent]') : null;
          const r = document.querySelector('.ar-map .ar-node[data-ar-agent="' + p.id + '"] .ar-node-body').getBoundingClientRect();
          const dx = Math.round(r.left + r.width / 2 - p.x), dy = Math.round(r.top + r.height / 2 - p.y);
          const id = owner && owner.getAttribute('data-ar-agent');
          if (id !== p.id || dx !== 0 || dy !== 0) bad.push({ frame: k, hit: id, dx, dy });
        }
        return bad;
      }, n);
      if (seen.length) slipped.push({ id: n.id, frames: seen.length, first: seen[0] });
    }
    await page.mouse.move(2, 2);
    return { nodes: at.length, slipped };
  }
  const rectsOf = (page) => page.evaluate(() => ['.ar-top', '.ar-rail', '.ar-toolbar', '.ar-map', '.ar-side'].map((s) => {
    const el = document.querySelector(s);
    if (!el) return s + ' (not drawn)';
    const r = el.getBoundingClientRect();
    return s + ' ' + [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',');
  }));
  // The room's own API traffic, and anything at all that is not a read.
  const roomTraffic = (log) => ({
    room: log.requests.filter((r) => r.o === BASE && r.p.startsWith('/api/v1/system/agents')).map((r) => r.m + ' ' + r.p),
    writes: log.requests.filter((r) => r.o === BASE && r.p.startsWith('/api/v1/system/') && r.m !== 'GET').map((r) => r.m + ' ' + r.p),
  });

  if (want('16')) {
    // ── entry: its own page, for the platform owner only, and only its own two files ──
    const { ctx, page, log } = await openRoom({ width: 1440, height: 900 });
    const entry = await page.evaluate(() => {
      const side = document.querySelector('.sidebar');
      const pg = document.getElementById('pg-agents-room');
      return { open: !!document.querySelector('#pg-agents-room.active'), bodyClass: document.body.classList.contains('ar-agents-open'),
        sidebarHidden: !side || getComputedStyle(side).display === 'none', boundary: pg.hasAttribute('data-no-i18n'), context: pg.getAttribute('data-fam-context'),
        clubShell: !!document.querySelector('#pg-agents-room .club-shell, #pg-agents-room [data-club-workspace]') };
    });
    const own = log.requests.filter((r) => r.o === BASE && r.p.startsWith('/agents-room/') && !r.p.includes('/i18n/'));
    const versions = [...new Set(own.map((r) => r.q))];
    check('agents room entry: the platform owner reaches the AI Agents Operations Room at #agents-room, a page of its own in the owner context, outside the club shell, and it fetched exactly its own two files under one version',
      entry.open && entry.bodyClass && entry.sidebarHidden && entry.boundary && entry.context === 'owner' && !entry.clubShell
        && sameJson(own.map((r) => r.p).sort(), AR_FILES) && versions.length === 1 && /^\?v=[\w.-]+$/.test(versions[0]), { entry, own: own.map((r) => r.p + r.q) });

    // ── discovered: every agent and every domain the server reports, drawn, and nothing else ──
    const reg = await registryOf(page);
    const d0 = await drawn(page);
    const ids = reg.agents.map((a) => a.id).sort();
    check('agents room discovery: every agent the registry reports is a node, every domain it counts is a sector and a chip, in the order it gave, and nothing is drawn that it did not report',
      sameJson(d0.nodes.slice().sort(), ids) && sameJson(d0.sectors, Object.keys(reg.registry.byDomain)) && sameJson(d0.chips, Object.keys(reg.registry.byDomain)) && ids.length > 0,
      { agents: ids.length, nodes: d0.nodes.length, domains: Object.keys(reg.registry.byDomain).length, sectors: d0.sectors.length });

    // ── the real mouse: a node held under the pointer stays there, and a click opens its manifest ──
    const hover = await hoverHold(page);
    check('agents room pointer: a pointer held on each node keeps hitting that node, and the node does not move under it',
      hover.nodes === ids.length && hover.slipped.length === 0, hover);
    const rects0 = await rectsOf(page);
    await page.evaluate(() => { window.__arMap = document.querySelector('.ar-map'); });
    const target = await page.evaluate(() => { const r = document.querySelector('.ar-map .ar-node[data-ar-agent="club.medical"] .ar-node-body').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.click(target[0], target[1]);
    await page.waitForSelector('.ar-insp.is-open .ar-ladder', { timeout: 15000 });
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => {
      const box = document.querySelector('.ar-insp');
      const r = box.getBoundingClientRect();
      return { title: document.getElementById('ar-insp-title').textContent, role: box.getAttribute('role'), modal: box.getAttribute('aria-modal'),
        focus: !!(document.activeElement && box.contains(document.activeElement)), right: document.documentElement.clientWidth - r.right <= 8 && r.left > document.documentElement.clientWidth / 2, fixed: getComputedStyle(box).position,
        sameMap: window.__arMap === document.querySelector('.ar-map'), tools: box.querySelectorAll('.ar-mini tbody tr').length };
    });
    const rects1 = await rectsOf(page);
    check('agents room inspector: a real click on a node opens its manifest in a floating dialog at the inline end, with the focus inside it',
      opened.title === 'Medical' && opened.role === 'dialog' && opened.modal === 'true' && opened.focus && opened.right && opened.fixed === 'fixed' && opened.tools > 0, opened);
    check('agents room stability: opening the manifest moved nothing under it and redrew nothing under it (the same map element, the same rectangles)',
      opened.sameMap && sameJson(rects0, rects1), { sameMap: opened.sameMap, before: rects0, after: rects1 });

    // ── the keyboard: the focus stays in the open manifest, Escape closes it and returns the focus to the node ──
    const ring = [];
    for (let k = 0; k < 14; k++) {
      await page.keyboard.press('Tab');
      ring.push(await page.evaluate(() => !!document.activeElement && document.querySelector('.ar-insp').contains(document.activeElement)));
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const closed = await page.evaluate(() => ({ open: document.querySelector('.ar-insp').classList.contains('is-open'), hidden: document.querySelector('.ar-insp').getAttribute('aria-hidden'),
      back: document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-ar-agent') }));
    await page.focus('.ar-map .ar-node[data-ar-agent="club.tactical"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ar-insp.is-open', { timeout: 10000 });
    const byKey = await page.evaluate(() => document.getElementById('ar-insp-title').textContent);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('agents room keyboard: Tab never leaves the open manifest, Escape closes it and gives the focus back to the node, and Enter on a focused node opens it',
      ring.every(Boolean) && !closed.open && closed.hidden === 'true' && closed.back === 'club.medical' && byKey === 'Tactical', { ring, closed, byKey });

    // ── filters and views: a filter repaints the view, never the shell ──
    const shell0 = (await rectsOf(page)).filter((r) => !r.startsWith('.ar-map'));
    await page.selectOption('#ar-domain', 'MEDICAL');
    await page.waitForTimeout(150);
    const dim = await page.evaluate(() => ({ lit: [...document.querySelectorAll('.ar-map .ar-node:not(.is-dim)')].map((n) => n.getAttribute('data-ar-agent')),
      count: document.getElementById('ar-count').textContent, on: [...document.querySelectorAll('.ar-sec.is-on')].map((s) => s.getAttribute('data-ar-sector')) }));
    await page.click('#ar-tab-catalogue');
    await page.waitForSelector('.ar-table', { timeout: 5000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll('.ar-table tbody tr')].map((r) => r.getAttribute('data-ar-agent')));
    const shell1 = (await rectsOf(page)).filter((r) => !r.startsWith('.ar-map'));
    await page.click('.ar-row-open[data-ar-agent="club.medical"]');
    await page.waitForSelector('.ar-insp.is-open .ar-ladder', { timeout: 10000 });
    const fromRow = await page.evaluate(() => document.getElementById('ar-insp-title').textContent);
    await page.keyboard.press('Escape');
    check('agents room filters: choosing a domain lights only its agents and its sector, the catalogue lists exactly them and opens each one, and the shell around the view did not move',
      sameJson(dim.lit, ['club.medical']) && sameJson(dim.on, ['MEDICAL']) && /\b1\b/.test(dim.count) && sameJson(rows, ['club.medical']) && fromRow === 'Medical'
        && shell0.length === 4 && sameJson(shell0.filter((r) => !r.startsWith('.ar-toolbar')), shell1.filter((r) => !r.startsWith('.ar-toolbar'))),
      { dim, rows, fromRow, shell0, shell1 });

    // ── read-only, and clean ──
    const t1 = roomTraffic(log);
    const split = await arCsp(page);
    check('agents room read-only: everything the room asked the server for was a GET of /system/agents or one manifest under it, nothing was written anywhere under /system, and the kill switch was never called',
      t1.room.length >= 3 && t1.room.every((r) => /^GET \/api\/v1\/system\/agents(\/[\w.-]+)?$/.test(r)) && t1.writes.length === 0 && !t1.room.some((r) => /kill-switch/.test(r)), t1);
    check('agents room csp: the room raised no CSP violation, nothing is unexplained, and no script error was logged (the application\'s own inline-style reports are counted apart)',
      split.room === 0 && split.unexplained.length === 0 && log.errors.length === 0, { split, errors: log.errors.slice(0, 5) });
    await ctx.close();

    // ── control: a node positioned by a transform on its group slips out from under the pointer that hovers it ──
    const c1 = await openRoom({ width: 1440, height: 900 }, {
      roomPatch: (src) => src.replace("var at = ' cx=\"' + f1(p.x) + '\" cy=\"' + f1(p.y) + '\"';", "var at = '';")
        .replace("nodes += '<g class=\"ar-node ar-node--' + lc + (on ? '' : ' is-dim') + (open ? ' is-open' : '') + '\"'",
          "nodes += '<g class=\"ar-node ar-node--' + lc + (on ? '' : ' is-dim') + (open ? ' is-open' : '') + '\" transform=\"translate(' + f1(p.x) + ' ' + f1(p.y) + ')\"'"),
    });
    const ch = await hoverHold(c1.page);
    check('agents room pointer (control): the same nodes positioned by a transform on their group fail the hover proof above, so it can fail', ch.slipped.length > 0, { slipped: ch.slipped.length, of: ch.nodes });
    await c1.ctx.close();

    // ── control: an inspector that redraws the room as it opens fails the stability proof above ──
    const c2 = await openRoom({ width: 1440, height: 900 }, { roomPatch: (src) => src.replace('    AR.open = id;\n    AR.opener = opener || null;\n', '    AR.open = id;\n    AR.opener = opener || null;\n    paint(host);\n') });
    await c2.page.evaluate(() => { window.__arMap = document.querySelector('.ar-map'); });
    await c2.page.focus('.ar-map .ar-node[data-ar-agent="club.medical"]');
    await c2.page.keyboard.press('Enter');
    await c2.page.waitForTimeout(400);
    const c2same = await c2.page.evaluate(() => window.__arMap === document.querySelector('.ar-map'));
    check('agents room stability (control): a room that redraws itself when a manifest opens fails the same-map proof above, so it can fail', c2same === false, { sameMap: c2same });
    await c2.ctx.close();

    // ── discovered, not listed: a domain and an agent the registry adds appear with no change to the room ──
    const synthetic = (data) => {
      const d = JSON.parse(JSON.stringify(data));
      d.registry.byDomain.SPACE_OPERATIONS = 1;
      d.registry.agents += 1;
      d.registry.byScope.PLATFORM = (d.registry.byScope.PLATFORM || 0) + 1;
      d.registry.byLifecycle.LAB = (d.registry.byLifecycle.LAB || 0) + 1;
      d.agents.push(Object.assign({}, d.agents[0], { id: 'platform.synthetic-proof', title: 'Synthetic proof agent', domain: 'SPACE_OPERATIONS', scope: 'PLATFORM', lifecycle: 'LAB', runtimeAgent: null }));
      return d;
    };
    const g = await openRoom({ width: 1440, height: 900 }, { overview: synthetic });
    const d1 = await drawn(g.page);
    const placed = await g.page.evaluate(() => {
      const n = document.querySelector('.ar-map .ar-node[data-ar-agent="platform.synthetic-proof"]');
      const c = n && n.querySelector('.ar-node-body');
      return n ? { cls: n.getAttribute('class'), r: Math.round(Math.hypot(+c.getAttribute('cx'), +c.getAttribute('cy'))), chip: (document.querySelector('.ar-dom[data-ar-domain="SPACE_OPERATIONS"]') || {}).textContent } : null;
    });
    check('agents room discovery: a domain and a LAB platform agent added to the registry\'s answer appear as a sixteenth sector, a chip and a node on the platform orbit, drawn as LAB, with no change to the room',
      d1.sectors.length === d0.sectors.length + 1 && d1.nodes.length === d0.nodes.length + 1 && placed && /ar-node--lab/.test(placed.cls) && placed.r === 344 && /Space operations/.test(placed.chip || ''),
      { sectors: d1.sectors.length, nodes: d1.nodes.length, placed });
    await g.ctx.close();

    // ── a registry that does not answer is said, with a way to ask again ──
    const f = await openRoom({ width: 1440, height: 900 }, { fail: true, waitFor: '.ar-empty' });
    const failed = await f.page.evaluate(() => ({ text: document.querySelector('.ar-view').textContent, retry: !!document.querySelector('.ar-view [data-ar-refresh]'), nodes: document.querySelectorAll('.ar-node').length }));
    check('agents room error: when the registry does not answer, the room says it could not be read and offers to try again, and draws no agent',
      /The registry could not be read/.test(failed.text) && /HTTP 500/.test(failed.text) && failed.retry && failed.nodes === 0, failed);
    await f.ctx.close();

    // ── three languages: every string the room drew has a German and an Arabic entry, and Arabic runs right to left ──
    const langs = {};
    for (const loc of ['de', 'ar']) {
      const s = await openRoom({ width: 1440, height: 900 }, { locale: loc });
      await s.page.click('#ar-tab-catalogue');
      await s.page.waitForSelector('.ar-table', { timeout: 5000 });
      await s.page.click('.ar-row-open[data-ar-agent="club.finance"]');
      await s.page.waitForSelector('.ar-insp.is-open .ar-ladder', { timeout: 10000 });
      await s.page.waitForTimeout(300);
      langs[loc] = await s.page.evaluate(() => {
        const r = document.querySelector('.ar-insp').getBoundingClientRect();
        return { dir: document.getElementById('ar-root').getAttribute('dir'), lang: document.getElementById('ar-root').getAttribute('lang'),
          // At the inline end: flush (within the app shell's own few-pixel inset) with that edge, and wholly in that half.
          missing: window.__familistaAgentsRoomMissing(), left: r.left <= 8 && r.right < document.documentElement.clientWidth / 2,
          right: document.documentElement.clientWidth - r.right <= 8 && r.left > document.documentElement.clientWidth / 2, title: document.getElementById('ar-insp-title').textContent };
      });
      await s.ctx.close();
    }
    check('agents room languages: in German and in Arabic every string the room drew (map, catalogue, a manifest) is in its catalogue, Arabic runs right to left and its manifest opens at the inline end, the left edge',
      langs.de.missing.length === 0 && langs.ar.missing.length === 0 && langs.de.dir === 'ltr' && langs.ar.dir === 'rtl' && langs.ar.lang === 'ar'
        && langs.ar.left && !langs.ar.right && langs.de.right && !langs.de.left && langs.de.title === 'Finanzen' && langs.ar.title === 'المالية', langs);
    const cl = await openRoom({ width: 1440, height: 900 }, { locale: 'de', roomPatch: (src) => src.replace("chip('info', T('Read-only')", "chip('info', T('Read-only (an untranslated proof string)')") });
    const clMissing = await cl.page.evaluate(() => window.__familistaAgentsRoomMissing());
    check('agents room languages (control): a string the catalogue does not hold is reported missing by the same check, so it can fail', sameJson(clMissing, ['Read-only (an untranslated proof string)']), clMissing);
    await cl.ctx.close();

    // ── a phone: no horizontal scroll, and the domains are reachable without the map ──
    const m = await openRoom({ width: 390, height: 844 });
    const phone = await m.page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      chips: document.querySelectorAll('.ar-dom').length, labels: getComputedStyle(document.querySelector('.ar-sec-t')).display }));
    await m.page.click('.ar-dom[data-ar-domain="FINANCE"]');
    const tapped = await m.page.evaluate(() => [...document.querySelectorAll('.ar-map .ar-node:not(.is-dim)')].map((n) => n.getAttribute('data-ar-agent')));
    check('agents room phone: at 390 px the page does not scroll sideways, the ring gives its labels to the domain list, and a domain chosen there filters the map',
      phone.overflow <= 0 && phone.chips === d0.chips.length && phone.labels === 'none' && sameJson(tapped, ['club.finance']), { phone, tapped });
    await m.ctx.close();

    // ── a club role, and nobody signed in: the room never opens and none of its files is fetched ──
    // The coach signs in with a token of its own: the server keeps a verified identity for a few seconds by user id, so the
    // owner's token would still be answered as the owner it was just verified as.
    CURRENT = COACH;
    const coach = await openRoom({ width: 1440, height: 900 }, { wait: false, token: signToken('access', { sub: COACH.id, role: COACH.role }, { expiresIn: '60m' }) });
    await coach.page.waitForTimeout(2500);
    const coachSaw = await coach.page.evaluate(() => ({ open: !!document.querySelector('#pg-agents-room.active'), render: typeof window.renderFamilistaAgentsRoom, map: !!document.querySelector('.ar-map') }));
    const coachFiles = coach.log.requests.filter((r) => r.p.startsWith('/agents-room/')).map((r) => r.p);
    const coachApi = coach.log.requests.filter((r) => r.p.startsWith('/api/v1/system/agents')).map((r) => r.p);
    // And the server itself, asked directly by the coach's session: the room's guard is the server's, not the page's.
    const coachAsked = await coach.page.evaluate(() => Promise.all(['/api/v1/system/agents', '/api/v1/system/agents/club.medical'].map((u) => fetch(u, { credentials: 'include' }).then((r) => r.status))));
    await coach.ctx.close();
    CURRENT = OWNER;
    const anon = await openRoom({ width: 1440, height: 900 }, { wait: false, anonymous: true });
    await anon.page.waitForTimeout(2500);
    const anonSaw = await anon.page.evaluate(() => ({ open: !!document.querySelector('#pg-agents-room.active'), render: typeof window.renderFamilistaAgentsRoom }));
    const anonFiles = anon.log.requests.filter((r) => r.p.startsWith('/agents-room/')).map((r) => r.p);
    await anon.ctx.close();
    check('agents room access: a club role who types #agents-room is sent away and nobody signed in reaches it either: the room never opens and none of its files is fetched, and the server answers the coach 403 on both endpoints',
      !coachSaw.open && coachSaw.render === 'undefined' && !coachSaw.map && coachFiles.length === 0 && coachApi.length === 0 && sameJson(coachAsked, [403, 403])
        && !anonSaw.open && anonSaw.render === 'undefined' && anonFiles.length === 0,
      { coachSaw, coachFiles, coachApi, coachAsked, anonSaw, anonFiles });

    // ── SYSTEM → AI Agent Control is the way in ──
    const sy = await openRoom({ width: 1440, height: 900 }, { hash: '/#system', wait: false });
    await sy.page.waitForSelector('.sy-shell', { timeout: 30000 });
    await sy.page.evaluate(() => { const b = document.querySelector('[data-sy-go="agents"]'); if (b) b.click(); });
    await sy.page.waitForSelector('[data-sy-room="agents-room"]', { timeout: 15000 });
    await sy.page.click('[data-sy-room="agents-room"]');
    await sy.page.waitForSelector('#pg-agents-room.active .ar-map', { timeout: 30000 });
    const via = await sy.page.evaluate(() => location.hash);
    check('agents room entry: SYSTEM → AI Agent Control carries an Operations Room panel whose button opens the room', via === '#agents-room', { via });
    await sy.ctx.close();
  }

  if (WANT_AXE && want('16a')) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (!fs.existsSync(axePath)) skip('agents room under axe', 'axe-core is not installed (' + axePath + ')');
    else {
      const AXE = fs.readFileSync(axePath, 'utf8');
      const axeRoom = (pg) => pg.evaluate(async (src) => {
        if (!window.axe) (0, eval)(src);        // eslint-disable-line no-eval -- this script's own tool, never the page's code
        const r = await window.axe.run({ include: ['#pg-agents-room'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        return r.violations.map((v) => v.id + ':' + v.nodes.length + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join('|'));
      }, AXE);
      for (const loc of ['en', 'ar']) {
        const s = await openRoom({ width: 1440, height: 900 }, { locale: loc });
        const found = { map: await axeRoom(s.page) };
        await s.page.focus('.ar-map .ar-node[data-ar-agent="club.scouting"]');
        await s.page.keyboard.press('Enter');
        await s.page.waitForSelector('.ar-insp.is-open .ar-ladder', { timeout: 10000 });
        await s.page.waitForTimeout(300);
        found.manifest = await axeRoom(s.page);
        await s.page.keyboard.press('Escape');
        await s.page.click('#ar-tab-catalogue');
        await s.page.waitForSelector('.ar-table', { timeout: 5000 });
        found.catalogue = await axeRoom(s.page);
        check(`agents room under axe (${loc}): the map, an open manifest and the catalogue have 0 violations (WCAG 2.2 A/AA)`,
          found.map.length === 0 && found.manifest.length === 0 && found.catalogue.length === 0, found);
        if (loc === 'en') {
          await s.page.evaluate(() => { const b = document.createElement('button'); b.type = 'button'; document.querySelector('.ar-top-r').appendChild(b); });
          const v = await axeRoom(s.page);
          check('agents room under axe (control): a button with no name placed in the top bar is reported by the same run, so a clean result means something', v.some((x) => /^button-name/.test(x)), v);
        }
        await s.ctx.close();
      }
    }
  }

  await browser.close(); server.close();
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`SUMMARY ${results.filter((r) => r[0] === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r[0] === 'SKIP').length} skipped`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
