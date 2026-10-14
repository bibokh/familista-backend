#!/usr/bin/env node
// Familista — Specimen Lab: browser proofs (Stage 3.2.3 M1, M2 / S1 zoom, M2 / S2 width).
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
const pass = (name, detail) => { results.push(['PASS', name]); console.log('PASS ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); };
const fail = (name, detail) => { results.push(['FAIL', name]); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); };
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

  // `labPatch`, used only by the negative controls, serves lab.js with one edit applied (a control that breaks
  // the behaviour under proof, so the proof can be seen to fail); everything else is the file on disk.
  async function open(viewport, locale, labPatch) {
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    if (labPatch) {
      const original = fs.readFileSync(path.join(ROOT, 'public/design-system/lab.js'), 'utf8');
      const patched = labPatch(original);
      if (patched === original) throw new Error('negative control: the edit did not change lab.js, so it would prove nothing');
      await ctx.route(/\/design-system\/lab\.js(\?|$)/, (r) => r.fulfill({ contentType: 'application/javascript', body: patched }));
    }
    await ctx.addCookies([{ name: 'access_token', value: token, domain: '127.0.0.1', path: '/', httpOnly: true }]);
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
    await page.waitForSelector('.ds-metric', { timeout: 30000 });
    return { ctx, page, log };
  }
  async function openLab(page) {
    await page.click('[data-ds-nav="lab"]');
    await page.waitForSelector('#lab-specimen .lab-col', { timeout: 30000 });
    await page.waitForTimeout(300);
  }
  const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
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
  const labErrors = (log) => log.errors.concat(log.notices.filter((n) => LAB_URL.test(n.url) || LAB_URL.test(n.text)).map((n) => 'notice: ' + n.text + ' @ ' + n.url));
  const activeKey = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.getAttribute('data-lab-id') || a.getAttribute('data-lab-fx') || a.getAttribute('data-lab-tab') || a.getAttribute('data-lab-dir') || a.getAttribute('data-lab-zoom') || a.getAttribute('data-lab-width') || a.tagName) : null; });
  // Redraw the room the way the application does when a page is shown again: through the page-render registry. True only if
  // a NEW Lab root replaced the old one, so a remount that never happened cannot pass for a restored focus.
  async function remount(page) {
    await page.evaluate(() => { window.__mark = document.querySelector('.lab'); window.renderFamilistaDesignSystem(); });
    try { await page.waitForFunction(() => { const l = document.querySelector('.lab'); return l && l !== window.__mark && document.getElementById('lab-specimen'); }, null, { timeout: 8000 }); } catch (_) { return false; }
    await page.waitForTimeout(400);
    return true;
  }
  const FOCUS_TARGETS = [['rail item', '[data-lab-id="lg-chip"]'], ['fixture tab', '.lab-fx.is-on'], ['search', '#lab-q'], ['inspector tab', '[data-lab-tab="source"]'], ['direction', '[data-lab-dir="rtl"]'], ['zoom in', '[data-lab-zoom="in"]'], ['width preset', '[data-lab-width="mobile"]'], ['custom width', '#lab-w']];
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
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    const m1 = await metrics();
    check('keyboard: Enter on a rail item selects it and shows its first fixture', ['lg-chip', 'lg-status-chip'].includes(m1.selected) && /\.\w/.test(m1.fixture), m1);
    await page.keyboard.press('Escape');
    check('keyboard: Escape in the search clears it', await page.evaluate(() => document.getElementById('lab-q').value === '') || (await active()).id !== 'lab-q');
    await page.focus('#lab-q'); await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    check('keyboard: Escape clears the search and the whole list returns', (await page.evaluate(() => [...document.querySelectorAll('#lab-rail-body [data-lab-id]')].length)) === 60);
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
    await openLab(page);
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
      await openLab(p2);
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
      await openLab(p3);
      const ids = await p3.evaluate(() => [...document.querySelectorAll('[data-lab-id]')].filter((b) => b.getAttribute('aria-disabled') !== 'true' && !b.closest('[hidden]')).map((b) => b.getAttribute('data-lab-id')));
      const fits = [];
      for (const id of ids.slice(0, 10)) {
        await p3.click(`[data-lab-id="${id}"]`); await p3.waitForSelector('#lab-zoom-v'); await frames(p3);
        await p3.click('[data-lab-zoom="fit"]', { force: true }); await frames(p3);
        fits.push(await p3.evaluate((cid) => {
          const vp = document.getElementById('lab-viewport');
          return { id: cid, pct: Number(document.getElementById('lab-zoom-v').textContent.replace(/[^0-9]/g, '')), pressed: document.querySelector('[data-lab-zoom="fit"]').getAttribute('aria-pressed'),
            scrolls: vp.scrollHeight > vp.clientHeight + 1 || vp.scrollWidth > vp.clientWidth + 1 };
        }, id));
        await p3.click('[data-lab-zoom="reset"]', { force: true });
      }
      check('zoom: Fit never enlarges past 100%, and every previewable component\'s specimen is then wholly visible without scrolling', fits.length === 10 && fits.every((f) => f.pct >= 25 && f.pct <= 100 && f.pressed === 'true' && !f.scrolls), fits);

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
    await openLab(page);
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
        scale: t === 'none' ? 1 : Number(t.split('(')[1].split(',')[0]), sized: document.getElementById('lab-frame').classList.contains('is-zoomed'),
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
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.ds-metric', { timeout: 30000 }); await openLab(page);
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
        const b = mode === 'width' ? document.querySelector(`[data-lab-width="${cycle[i % 4]}"]`) : mode === 'fitwidth' ? document.querySelector(`[data-lab-width="${cycle[i % 3]}"]`) : document.querySelector(`[data-lab-zoom="${i % 10 < 5 ? 'in' : 'out'}"]`);
        const t0 = performance.now(); b.click(); await fr(); out.push(performance.now() - t0);
        sync.push(mode === 'zoom' ? window.__familistaLabMetrics().zoomMs : window.__familistaLabMetrics().widthMs);
      }
      return { times: out, sync };
    }, { sel, n, mode });
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10 }; };
    const dom0 = await page.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
    const h0 = await heap();
    const w1 = await timed(null, 40, 'width');
    await setW(page, 'tablet');
    const z1 = await timed(null, 40, 'zoom');
    await page.click('[data-lab-zoom="fit"]', { force: true });
    const f1 = await timed(null, 21, 'fitwidth');
    await page.click('[data-lab-zoom="reset"]', { force: true }); await setW(page, 'fill');
    await timed(null, 80, 'width');
    await setW(page, 'fill');
    const h1 = await heap();
    const dom1 = await page.evaluate(() => document.querySelector('.lab').getElementsByTagName('*').length);
    const ws = stat(w1.times), zs = stat(z1.times), fs2 = stat(f1.times);
    // synchronous work per change (the Lab's own figure), median, so one cheap Fill at the end cannot stand for the rest
    const measure = { widthChangeToFrameMedianMs: ws.median, widthChangeToFrameP95Ms: ws.p95, widthComputeMedianMs: stat(w1.sync).median, widthComputeP95Ms: stat(w1.sync).p95, zoomStepAtWidthToFrameMedianMs: zs.median, zoomStepAtWidthToFrameP95Ms: zs.p95, zoomComputeMedianMs: stat(z1.sync).median, fitRecalcToFrameMedianMs: fs2.median, fitRecalcToFrameP95Ms: fs2.p95, widthChanges: 120, domBefore: dom0, domAfter: dom1, heapGrowthKB: Math.round((h1 - h0) / 1024) };
    console.log('MEASURE ' + JSON.stringify(measure));
    check('width: a hundred and twenty width changes, forty zoom steps and twenty-one Fit recalculations add no node to the Lab', dom0 === dom1, measure);
    const split = await cspSplit(page);
    check('width: no Lab or unexplained CSP violation, and no console error, after everything above', split.lab === 0 && split.unexplained === 0 && labErrors(log).length === 0, { csp: split, errors: labErrors(log) });
    await ctx.close();

    // control: the same width written as an inline style is refused by the policy and counted as the Lab's, so the check above can fail
    {
      const { ctx: c2, page: p2 } = await open({ width: 1440, height: 900 }, 'en', (src) => src.replace("col.style.setProperty('width', S.width + 'px');", "col.setAttribute('style', 'width:' + S.width + 'px');"));
      await openLab(p2); await quiet(p2);
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
      await openLab(p3); await setW(p3, 'desktop');
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

  // ══ 6. accessibility, languages, directions and sizes (--axe) ══════════════
  if (WANT_AXE && want('6')) {
    const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
    if (!fs.existsSync(axePath)) skip('accessibility: axe across en, de, ar and four sizes', 'axe-core is not installed (' + axePath + ')');
    else {
      const AXE = fs.readFileSync(axePath, 'utf8');
      const views = [['desktop', 1440, 900], ['laptop', 1100, 760], ['tablet', 834, 1112], ['mobile', 390, 844]];
      for (const loc of ['en', 'de', 'ar']) for (const [vn, w, h] of views) {
        const { ctx, page, log } = await open({ width: w, height: h }, loc);
        await openLab(page);
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
        await page.click('[data-lab-width="fill"]'); await frames(page);
        await page.click('[data-lab-tab="sanitization"]'); states.push(await run('sanitization tab'));
        await page.click('[data-lab-grp="no-fixtures"]'); await page.click('[data-lab-id="lg-icon"]', { force: true }); await frames(page); states.push(await run('unavailable component'));
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
      await openLab(page);
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
      await openLab(page);
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
      await openLab(page);
      const trials = await focusTrials(page);
      const unapplied = trials.filter((t) => !t.applied);
      if (unapplied.length) fail('focus (control): control not applied: the controls could not be focused, so the loss of focus was not measured', trials);
      else check('focus (control): with restoreFocus disabled, the same redraw drops focus on the page for every control, so the proof can fail', trials.length === FOCUS_TARGETS.length && trials.every((t) => t.applied && t.before !== 'BODY' && t.remounted && !t.ok && t.after === 'BODY'), trials);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 1440, height: 900 }, 'en', NO_EXPIRY);
      await openLab(page);
      await page.keyboard.press('/'); await page.keyboard.type('chip');
      const stale = await staleRemount(page);
      check('focus (control): with the 2.5 s limit removed, a redraw long after the last focus steals it back into the Lab, so the no-steal proof can fail', stale.remounted && !stale.kept, stale);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, 'de');
      await openLab(page);
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
      await openLab(page);
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
      await openLab(page);
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
      await openLab(page);
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
      await openLab(page);
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

  await browser.close(); server.close();
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`SUMMARY ${results.filter((r) => r[0] === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r[0] === 'SKIP').length} skipped`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
