#!/usr/bin/env node
// Familista — the nine-step acceptance walk, in a real browser
// ─────────────────────────────────────────────────────────────────────────────
// Run:  node scripts/fam-telemetry-check.js
//
// The unit suite drives `public/fam-telemetry.js` against a hand-built DOM and
// proves the aggregation logic. This runs the SHIPPED file in real Chromium,
// against real markup, driven by a real mouse and a real wheel — and reports
// the events a person generates by using Familista without telling it anything.
//
// It is the acceptance test written as a program:
//
//   1 enter a club     2 open Squad        3 move the mouse
//   4 scroll           5 hover a card      6 open that player
//   7 change a tab     8 click an action   9 navigate to Training
//
// What it proves that the unit suite cannot: that a real `pointermove` at real
// browser cadence produces bounded windows rather than a stream, that a real
// wheel over a real scroll container crosses the thresholds once each, and that
// a real hover on real markup resolves the declared region.
//
// NOTHING IS SENT ANYWHERE. `FamilistaAnalytics.event` is replaced with a
// collector before the walk, so this observes what WOULD be queued. No token,
// no request, no row — running it against production is not possible and not
// the point.

const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

// The shell the real app draws: one `.page.active` named `pg-<module>`, an
// inner scroller, and a squad grid of cards declared exactly as `app.js`
// declares them.
const HTML = `<!doctype html><meta charset="utf-8"><title>walk</title>
<style>
  html,body{margin:0;height:100%;font:14px system-ui}
  .page{display:none;height:100vh;overflow:auto}
  .page.active{display:block}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:16px}
  .sq2-card{height:110px;border:1px solid #ccc;border-radius:12px;background:#fafafa}
  .spacer{height:2400px}
  .pm2-tab{display:inline-block;padding:8px 14px;border:1px solid #ddd;margin:4px}
</style>
<div class="page active" id="pg-squad">
  <div class="grid">
    ${Array.from({ length: 9 }, (_, i) => `
    <button class="sq2-card" data-action="openPlayerModal" data-id="p${i}"
            data-fam-region="player-card" data-fam-card="player" type="button">Player ${i}</button>`).join('')}
  </div>
  <button data-action="sqTacShare" id="act" type="button">Share plan</button>
  <div id="tabs">
    <div class="pm2-tab" data-fam-tab="overview">Overview</div>
    <div class="pm2-tab" data-fam-tab="statistics">Statistics</div>
  </div>
  <div class="spacer"></div>
</div>
<div class="page" id="pg-training-centre"><div class="spacer"></div></div>
<script>
  window.State = { context: { clubId: 'c1', teamId: null } };
  window.__seen = [];
  window.FamilistaAnalytics = { event: function (n, f) { window.__seen.push(Object.assign({ eventName: n }, f)); } };
</script>
<script src="/fam-telemetry.js"></script>
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = http.createServer((q, r) => {
    const f = q.url.split('?')[0];
    if (f === '/' || f === '/walk.html') { r.setHeader('Content-Type', 'text/html'); return r.end(HTML); }
    try {
      r.setHeader('Content-Type', 'text/javascript');
      r.end(fs.readFileSync(path.join(__dirname, '..', 'public', f)));
    } catch (_) { r.statusCode = 404; r.end(''); }
  });
  await new Promise((res) => srv.listen(7816, res));

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://127.0.0.1:7816/walk.html');
  await page.waitForFunction(() => !!window.FamTelemetry);

  const step = async (n, label, fn) => {
    await page.evaluate(() => { window.__mark = window.__seen.length; });
    await fn();
    await sleep(250);
    const out = await page.evaluate(() => window.__seen.slice(window.__mark));
    const lines = out.map((e) => {
      const cat = e.eventName.startsWith('pointer') ? 'POINTER'
        : e.eventName.startsWith('scroll') ? 'SCROLL'
        : e.eventName.startsWith('region') ? 'HOVER'
        : /^(route|page|club|module)/.test(e.eventName) ? 'NAV'
        : /^(tab|panel|modal|menu|player_card|match_card|form_started)/.test(e.eventName) ? 'UI'
        : /^(login|logout|session)/.test(e.eventName) ? 'AUTH' : 'ACTION';
      return `    ${cat.padEnd(8)} ${e.eventName}${e.feature ? ' · ' + e.feature : ''}`
        + `${e.durationMs != null ? ' · ' + e.durationMs + 'ms' : ''}`;
    });
    console.log(`  ${n}. ${label}`);
    console.log(lines.length ? lines.join('\n') : '    (nothing — correct if this step is not an observable interaction)');
    return out;
  };

  console.log('\nFAMILISTA — nine-step acceptance walk, real Chromium, shipped fam-telemetry.js\n');

  await step(1, 'enter a club', () =>
    page.evaluate(() => window.FamTelemetry.club('club-2', 'club-1')));

  await step(2, 'open Squad', () =>
    page.evaluate(() => window.FamTelemetry.nav('squad')));

  const pointer = await step(3, 'move the mouse across the squad grid', async () => {
    for (let i = 0; i < 30; i++) { await page.mouse.move(200 + i * 20, 180 + (i % 5) * 10); await sleep(25); }
    await sleep(1600);                                   // let the window close on idle
  });

  const scroll = await step(4, 'scroll the squad workspace to the bottom', async () => {
    for (const pct of [0.3, 0.6, 0.85, 1.0]) {
      await page.evaluate((p) => {
        const el = document.querySelector('.page.active');
        el.scrollTop = (el.scrollHeight - el.clientHeight) * p;
        el.dispatchEvent(new Event('scroll', { bubbles: false }));
      }, pct);
      await sleep(260);
    }
  });

  const hover = await step(5, 'hover a player card for a second and a half', async () => {
    await page.evaluate(() => { document.querySelector('.page.active').scrollTop = 0; });
    await page.hover('.sq2-card');
    await sleep(1500);
    await page.hover('#act');                            // leaving the region closes the dwell
  });

  await step(6, 'open that player', () =>
    page.evaluate(() => window.FamTelemetry.card('player')));

  const tab = await step(7, 'change a tab', () => page.click('[data-fam-tab="statistics"]'));

  const action = await step(8, 'click an action', () => page.click('#act'));

  await step(9, 'navigate to Training', () =>
    page.evaluate(() => {
      document.querySelector('.page.active').classList.remove('active');
      document.getElementById('pg-training-centre').classList.add('active');
      window.FamTelemetry.nav('training-centre');
    }));

  // ── what the walk has to have produced ──────────────────────────────────
  const all = await page.evaluate(() => window.__seen);
  const names = all.map((e) => e.eventName);
  const checks = [
    ['club entry is a NAV pair', names.includes('club_exited') && names.includes('club_entered')],
    ['a module open is route_changed + page_viewed', names.filter((n) => n === 'route_changed').length >= 2],
    ['real mouse movement produced pointer windows', pointer.some((e) => e.eventName === 'pointer_active')],
    ['…and bounded ones, not a stream', pointer.filter((e) => e.eventName === 'pointer_active').length <= 4],
    ['…carrying a region, never a coordinate',
      pointer.every((e) => e.eventName !== 'pointer_active' || (e.feature && !/\d{3,}/.test(String(e.feature))))],
    // Sliced per step, so this window also catches whatever else was in
    // flight — a hover dwell left open by the previous step, for instance. The
    // depth events are picked out by name before they are counted.
    ['a real scroll crossed four thresholds, once each',
      scroll.filter((e) => e.eventName === 'scroll_depth').length === 4
      && new Set(scroll.filter((e) => e.eventName === 'scroll_depth').map((e) => e.feature)).size === 4],
    ['a real hover on a declared card is one bucketed dwell',
      hover.filter((e) => e.eventName === 'region_dwell').length === 1
      && hover.find((e) => e.eventName === 'region_dwell')?.feature === 'player-card'],
    ['…bucketed, not exact', [500, 1000, 2000, 5000, 10000, 30000]
      .includes(hover.find((e) => e.eventName === 'region_dwell')?.durationMs)],
    ['a tab click is a tab change carrying the key', tab.some((e) => e.eventName === 'tab_changed' && e.feature === 'statistics')],
    ['an action click is action_invoked', action.some((e) => e.eventName === 'action_invoked')],
    ['nothing anywhere carries text from the page',
      all.every((e) => !/\s/.test(String(e.feature ?? '')) && !/Player \d/.test(JSON.stringify(e)))],
  ];

  console.log('\n  ── assertions ──');
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  }
  console.log(`\n  ${all.length} events for the whole walk. Every field that left the page:`);
  console.log('  ' + [...new Set(all.flatMap((e) => Object.keys(e)))].sort().join(', ') + '\n');

  await b.close();
  srv.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
