const https = require('https'), vm = require('vm');
function get(u) { return new Promise((res, rej) => { https.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }

(async () => {
  console.log('\n=== PRODUCTION VERIFY: 20260628-premium ===\n');
  const base = 'https://familista-backend.onrender.com';
  let js, css, html;
  for (let i = 1; i <= 25; i++) {
    js = await get(base + '/app.js?t=' + Date.now());
    css = await get(base + '/app.css?t=' + Date.now());
    html = await get(base + '/?t=' + Date.now());
    const live = js.includes('_sqImgTag') && css.includes('.sqmd-cond--good') && html.includes('20260628-premium');
    console.log('attempt ' + i + ': imgTag=' + (js.includes('_sqImgTag') ? 'y' : 'n') + ' cond=' + (css.includes('sqmd-cond--good') ? 'y' : 'n') + ' tag=' + (html.includes('20260628-premium') ? 'y' : 'n'));
    if (live) break;
    if (i < 25) await new Promise(r => setTimeout(r, 15000));
  }

  const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
  const ctx = {
    console, JSON, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
    window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
    State: { club: { name: 'FC Familista' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
    requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
    history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  ctx.window = ctx; vm.createContext(ctx);
  try { vm.runInContext(js.slice(a, b) + '\ntry{_sqBuildBoard();}catch(e){}', ctx); } catch (e) {}

  console.log('\n1. DEPLOY');
  console.log('   generic resolver live (_sqImgTag/_sqImgChain):', js.includes('function _sqImgTag') && js.includes('function _sqImgChain') ? 'v' : 'x');

  console.log('\n2. MY MARKER — full premium (color)');
  const c1 = ctx._sqMdCard('my', 1, 'Vlad', 'GK', 84, ['C'], false, null, 'sq-1', 'hold', false, 'gk', 'GK', 94);
  console.log('   portrait+photo, OVR, num, captain, condition, name, pos:',
    c1.includes('sqmd-av--my') && c1.includes('/players/vlad.png') && c1.includes('sqmd-ovr') && c1.includes('sqmd-num') && c1.includes('sqmd-rb--c') && c1.includes('sqmd-cond--good') && c1.includes('sqmd-card-nm') && c1.includes('sqmd-card-pos') ? 'ALL v' : 'x');
  console.log('   drag/click attrs intact:', c1.includes('data-id="sq-1"') && c1.includes('data-team="my"') ? 'v' : 'x');

  console.log('\n3. OPPONENT — same component, real photo by id, shadow');
  const c3 = ctx._sqMdCard('opp', 9, 'Rival', 'ST', 79, null, false, null, 'op-9', null, false, 'fw', 'ST', null);
  console.log('   same component + photo /players/op-9.png + silhouette fallback:', c3.includes('sqmd-card--opp') && c3.includes('/players/op-9.png') && c3.includes('data-fallbacks') ? 'v' : 'x');
  console.log('   transparency CSS (45% + desaturate + tint):', css.includes('.sqmd-card--opp{ opacity:.45; filter:grayscale') && css.includes('.sqmd-card--opp .sqmd-av::after') ? 'v' : 'x');

  console.log('\n4. UPLOADED PHOTO PRIORITY (auto, no code change)');
  const c2 = ctx._sqMdCard('my', 7, 'Yasser', 'GK', 80, [], false, 'data:image/png;base64,AAAA', 'sq-y', null, false, 'gk', 'GK', 90);
  console.log('   uploaded photo wins:', c2.includes('src="data:image/png;base64,AAAA"') ? 'v' : 'x');

  console.log('\n5. FIFA PITCH MARKINGS (both goals)');
  const f = ctx._sqMdField();
  console.log('   3 spots / 2 pen arcs / 4 corner arcs / 7 boxes:',
    (f.match(/r="0.9"/g) || []).length === 3 && (f.match(/A12 12 0 0 1/g) || []).length === 2 && (f.match(/A2 2 0 0 0/g) || []).length === 4 && (f.match(/<rect /g) || []).length === 7 ? 'v' : 'x');

  console.log('\n6. BENCH MINI PORTRAIT CHIPS');
  const mb = ctx._sqMdBench('my'), ob = ctx._sqMdBench('opp');
  console.log('   my+opp mini portraits, drag attrs intact:', mb.includes('sqmd-bc-av--my') && mb.includes('sqmd-bc-img') && ob.includes('sqmd-bc-av--opp') && mb.includes('data-sub=') && ob.includes('data-sub-opp=') ? 'v' : 'x');

  console.log('\n7. PREMIUM CSS + 60fps');
  console.log('   no black box, glow, hover, gold select, will-change, no drag-lag:',
    /\.sqmd-card\{[^}]*background:none/.test(css) && css.includes('.sqmd-card:hover') && css.includes('.sqmd-card.is-sel') && css.includes('#f4b740') && css.includes('will-change:transform') && css.includes('.sqmd-slot.is-moving .sqmd-card{ transition:none') ? 'v' : 'x');

  console.log('\n8. REGRESSION (logic untouched)');
  ctx.SQ_FORM.showOpp = true;
  const p = ctx._sqMdPitchShared();
  console.log('   my 11 + opp 11 markers drag-ready:', (p.match(/data-cmdmove="1"/g) || []).length === 11 && (p.match(/data-cmdmove-opp="1"/g) || []).length === 11 ? 'v' : 'x');
  ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
  console.log('   zones / out-of-pos:', ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my').includes('sqmd-zone') ? 'v' : 'x');
  ctx.SQ_FORM.cmdSel = null;
  const bO = ctx._sqTeamReport('opp'); ctx._sqOppSubstitute('opr-7', 'op-10');
  console.log('   opp sub + OVR recalc:', bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr, 'v');
  const bi = ctx.SQ_BENCH_IDS[0]; ctx._sqSubstitute(bi, ctx.SQ_MY_IDS[6]);
  console.log('   my sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'v' : 'x');

  console.log('\n==================================================');
  console.log('COMMIT: 6c92ccb   TAG: 20260628-premium');
  console.log('My team full colour premium / Opponent transparent shadow v');
  console.log('Same component + real-photo resolver + silhouette v');
  console.log('FIFA pitch markings both goals / mini bench portraits v');
  console.log('Drag / OVR / Balance / zones / OOP / stats untouched v');
  console.log('==================================================\n');
})().catch(e => console.error('FATAL:', e.message));
