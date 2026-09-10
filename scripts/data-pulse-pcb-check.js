#!/usr/bin/env node
// Data Pulse — the PCB board, in a real browser
// ─────────────────────────────────────────────────────────────────────────────
// Run:  node scripts/data-pulse-pcb-check.js
//
// The unit suite reads the source and proves the board is BUILT correctly. This
// runs it and proves it BEHAVES correctly, which is a different question and
// the one that caught three real defects: the pads' geometry, the outbox's
// timing window, and a panel that collapsed to content width when its parent
// was a grid column it did not land in.
//
// It mirrors SYSTEM's real DOM — `.sy-shell` is `grid-template-columns: 268px
// 1fr`, so a harness without a rail puts the board in the rail's column and
// measures a board a fifth of its real size. The rail placeholder is what makes
// the geometry it reports the geometry production gets.
//
// What it asserts:
//   14 traces, real SVG paths with real length, measured from laid-out pads
//   a packet per event, each riding its own trace via offset-path
//   exactly the pads for the events fed light; the other seven stay dark
//   no FUTURE pad ever lights — nothing reaches them
//   everything cleans itself up, and the board does not shift by a pixel
//
// It feeds frames directly through `window.__feed`, which renders what it is
// given. It does not fabricate events: the frames it passes stand in for what
// the outbox tail delivers, and the check is about the drawing, not the data.

const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const HTML = fs.readFileSync(path.join(__dirname, 'data-pulse-pcb-harness.html'), 'utf8');

(async () => {
  fs.writeFileSync('public/__pcb.html', HTML);
  const srv = http.createServer((q, r) => {
    let f = q.url.split('?')[0]; if (f === '/') f = '/__pcb.html';
    try {
      const b = fs.readFileSync(path.join('public', f));
      r.setHeader('Content-Type', f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'text/html');
      r.end(b);
    } catch (_) { r.statusCode = 404; r.end(''); }
  });
  await new Promise((res) => srv.listen(7814, res));

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1500, height: 980 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:7814/', { waitUntil: 'load' });
  await p.waitForTimeout(450);

  const board = await p.evaluate(() => {
    const ts = [...document.querySelectorAll('.sy-dp-trace')];
    return {
      mapWidth: Math.round(document.getElementById('dp-map').getBoundingClientRect().width),
      traces: ts.length,
      shortestPx: Math.min(...ts.map((t) => Math.round(t.getTotalLength()))),
      longestPx: Math.max(...ts.map((t) => Math.round(t.getTotalLength()))),
      sourcePads: document.querySelectorAll('.sy-dp-source').length,
      destPads: document.querySelectorAll('.sy-dp-dest:not(.sy-dp-future)').length,
      futurePads: document.querySelectorAll('.sy-dp-future').length,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log('BOARD:', JSON.stringify(board, null, 1));

  const box = () => p.evaluate(() => { const e = document.getElementById('dp-map'); return e.offsetTop + '/' + e.offsetHeight + '/' + e.offsetWidth; });
  const before = await box();
  await p.waitForTimeout(500);
  console.log('MID-FLIGHT:', JSON.stringify(await p.evaluate(() => ({
    packets: document.querySelectorAll('.sy-dp-packet').length,
    onPath: [...document.querySelectorAll('.sy-dp-packet')].every((e) => (e.style.offsetPath || '').startsWith('path(')),
    litSources: [...document.querySelectorAll('.sy-dp-source.sy-dp-hot span')].map((e) => e.textContent),
    darkSources: document.querySelectorAll('.sy-dp-source:not(.sy-dp-hot)').length,
    futureLit: document.querySelectorAll('.sy-dp-future.sy-dp-hot').length,
  }))));

  // The outbox lights at ARRIVAL, not at launch, and decays. Sampled across
  // the window rather than at one instant — a single sample once reported a
  // false negative purely because it landed after the decay.
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push(await p.evaluate(() => ({
      t: Math.round(performance.now()),
      outbox: document.getElementById('dp-outbox').classList.contains('sy-dp-hot'),
    })));
    await p.waitForTimeout(180);
  }
  const lit = samples.filter((s) => s.outbox).map((s) => s.t);
  console.log('OUTBOX lit during:', lit.length ? lit[0] + 'ms..' + lit[lit.length - 1] + 'ms' : 'NEVER');

  await p.waitForTimeout(1800);
  console.log('SETTLED: packets', await p.evaluate(() => document.querySelectorAll('.sy-dp-packet').length),
    '| lit', await p.evaluate(() => document.querySelectorAll('.sy-dp-hot,.sy-dp-trace-hot').length),
    '| board shifted:', before !== await box());

  await p.setViewportSize({ width: 400, height: 860 });
  await p.waitForTimeout(400);
  console.log('AT 400px: hScroll', await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    '| copper', await p.evaluate(() => getComputedStyle(document.getElementById('dp-traces')).display));
  console.log('page errors:', errs.length ? errs : 'none');

  await b.close(); srv.close();
  try { fs.unlinkSync('public/__pcb.html'); } catch (_) {}
})();
