#!/usr/bin/env node
// Familista — the navigation walk, through real browser history
// ─────────────────────────────────────────────────────────────────────────────
// Run:  node scripts/fam-nav-check.js
//
// NAV telemetry was missing in production while POINTER was arriving. Two
// defects caused it, and only one of them was in the browser. This checks the
// browser half in a real browser: that a navigation through Familista's ACTUAL
// mechanism produces exactly two events naming the module that actually opened,
// that browser Back and Forward do the same, and that nothing multiplies.
//
// WHAT FAMILISTA ACTUALLY USES, AND WHY THIS HARNESS LOOKS LIKE IT DOES
//
// There is one funnel: `navTo(page, el, opts)`. It is called by the sidebar
// delegate (`data-nav`), by a hash deep link on boot, and by the `popstate`
// listener with `{fromPopState: true}` — and `navTo` itself is what calls
// `history.pushState({page}, '', '#' + page)`. So back and forward replay
// through the same function that pushed them. No framework router, no
// `hashchange` listener, no `location.href` assignment for in-app navigation.
//
// The harness below reproduces that funnel's ORDER exactly — clear `.active`,
// run both redirect guards, fire the telemetry hook, then activate the target —
// because the order is the thing under test: the hook used to fire before the
// guards, and the pointer/hover close used to happen while no page was active.
// The real `navTo` is 200 lines of club hydration this cannot host; what it
// cannot reproduce, `tests/fam-telemetry.unit.test.ts` pins statically against
// `public/app.js`.
//
// The telemetry file itself is the shipped one, unmodified. Nothing is sent
// anywhere: `FamilistaAnalytics.event` is replaced with a collector.

const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const PAGES = ['owner-home', 'clubs', 'club-home', 'squad', 'training', 'academy',
  // Allow-listed, but the capability guard sends it on to Club Home — the
  // second of the two redirects a reported page has to survive.
  'people-access',
  'match-center', 'system'];

const HTML = `<!doctype html><meta charset="utf-8"><title>nav walk</title>
<style>html,body{margin:0;height:100%;font:14px system-ui}.page{display:none;height:100vh;overflow:auto}.page.active{display:block}.sp{height:2000px}</style>
${PAGES.map((p, i) => `<div class="page${i === 0 ? ' active' : ''}" id="pg-${p}"><h1>${p}</h1><div class="sp"></div></div>`).join('\n')}
<script>
  window.State = { context: { clubId: 'club-1', teamId: 'team-1' } };
  window.__seen = [];
  window.FamilistaAnalytics = {
    event: function (n, f) { window.__seen.push(Object.assign({ eventName: n }, f)); },
    // The one copy of the club-workspace list, as analytics.js holds it.
    isClubModule: function (k) {
      return ['club-home','squad','training','training-centre','academy','academy-team',
              'video-intelligence','transfers','coach-market','coaches','familista-league',
              'match-center','people-access','settings'].indexOf(String(k || '')) >= 0;
    },
  };

  var ALLOWED = {};
  ${JSON.stringify(PAGES)}.forEach(function (p) { ALLOWED[p] = 1; });

  // navTo, in the order app.js runs it.
  window.navTo = function (page, el, opts) {
    opts = opts || {};
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    if (!opts.fromPopState && window.history && window.history.pushState) {
      var cur = window.history.state;
      if (!cur || cur.page !== page) window.history.pushState({ page: page }, '', '#' + page);
    }
    if (!ALLOWED[page]) page = 'owner-home';                 // redirect guard one
    if (page === 'people-access') page = 'club-home';        // redirect guard two
    // The hook, after both guards and before the activation.
    try {
      if (window.FamilistaAnalytics) window.FamilistaAnalytics.event;
      if (window.FamTelemetry) window.FamTelemetry.nav(page);
    } catch (_) {}
    var pg = document.getElementById('pg-' + page);
    if (pg) pg.classList.add('active');
  };

  window.addEventListener('popstate', function (e) {
    var page = (e && e.state && e.state.page) || (location.hash || '').replace(/^#/, '') || 'owner-home';
    try { window.navTo(page, null, { fromPopState: true }); } catch (_) {}
  });
</script>
<script src="/fam-telemetry.js"></script>
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = http.createServer((q, r) => {
    const f = q.url.split('?')[0];
    if (f === '/' || f === '/nav.html') { r.setHeader('Content-Type', 'text/html'); return r.end(HTML); }
    try {
      r.setHeader('Content-Type', 'text/javascript');
      r.end(fs.readFileSync(path.join(__dirname, '..', 'public', f)));
    } catch (_) { r.statusCode = 404; r.end(''); }
  });
  await new Promise((res) => srv.listen(7818, res));

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://127.0.0.1:7818/nav.html');
  await page.waitForFunction(() => !!window.FamTelemetry);

  console.log('\nFAMILISTA — navigation walk, real Chromium history, shipped fam-telemetry.js\n');

  const WALK = ['club-home', 'squad', 'training', 'academy', 'match-center'];
  const seenFor = async (fn) => {
    await page.evaluate(() => { window.__mark = window.__seen.length; });
    await fn();
    await sleep(120);
    return page.evaluate(() => window.__seen.slice(window.__mark));
  };

  console.log('  forward walk');
  const walked = [];
  for (const p of WALK) {
    const out = await seenFor(() => page.evaluate((x) => window.navTo(x), p));
    walked.push({ p, out });
    console.log(`    NAV      ${p.padEnd(14)} ${out.map((e) => e.eventName).join(' + ') || '(nothing)'}`
      + `   club=${out[0] ? (out[0].clubId || 'none') : '-'}`);
  }

  console.log('  browser Back ×2, then Forward ×2 (real history, real popstate)');
  const back1 = await seenFor(() => page.goBack());
  const back2 = await seenFor(() => page.goBack());
  const fwd1 = await seenFor(() => page.goForward());
  const fwd2 = await seenFor(() => page.goForward());
  for (const [label, out] of [['back', back1], ['back', back2], ['forward', fwd1], ['forward', fwd2]]) {
    console.log(`    ${label.padEnd(8)} ${(out[0] ? out[0].module : '-').padEnd(14)}`
      + ` ${out.map((e) => e.eventName).join(' + ') || '(nothing)'}`);
  }

  console.log('  a blocked page, and a page a guard redirects');
  const blocked = await seenFor(() => page.evaluate(() => window.navTo('secret-lab')));
  const redirected = await seenFor(() => page.evaluate(() => window.navTo('people-access')));

  console.log('  SYSTEM, from inside a club');
  const toSystem = await seenFor(() => page.evaluate(() => window.navTo('system')));

  const all = await page.evaluate(() => window.__seen);
  const checks = [
    ['every step emits exactly route_changed + page_viewed',
      walked.every((w) => w.out.map((e) => e.eventName).join(',') === 'route_changed,page_viewed')],
    ['…naming the module it landed on', walked.every((w) => w.out.every((e) => e.module === w.p))],
    ['…and no navigation multiplies', walked.every((w) => w.out.length === 2)],
    ['Back is a navigation, reported like any other',
      back1.length === 2 && back2.length === 2 && back1[0].module === 'academy' && back2[0].module === 'training'],
    ['Forward likewise',
      fwd1.length === 2 && fwd2.length === 2 && fwd1[0].module === 'academy' && fwd2[0].module === 'match-center'],
    ['a blocked page reports where it LANDED, not what was asked for',
      blocked.length === 2 && blocked[0].module === 'owner-home'],
    ['a redirected page likewise',
      redirected.length === 2 && redirected[0].module === 'club-home'],
    ['a club workspace carries its tenant',
      walked.every((w) => w.out.every((e) => e.clubId === 'club-1'))],
    ['SYSTEM carries none', toSystem.every((e) => !e.clubId && !e.teamId)],
    ['nothing carries text from the page',
      all.every((e) => !/\s/.test(String(e.feature ?? '')))],
  ];

  console.log('\n  ── assertions ──');
  let failed = 0;
  for (const [label, ok] of checks) { if (!ok) failed++; console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`); }
  console.log(`\n  ${all.length} events for the whole walk.\n`);

  await b.close();
  srv.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
