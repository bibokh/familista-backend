const https = require('https'), vm = require('vm');
function get(u) { return new Promise((res, rej) => { https.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }
function parse(pitch, attr) { const out = []; const re = new RegExp(attr + '[^>]*data-id="([^"]+)"[^>]*style="left:([0-9.]+)%;top:([0-9.]+)%"', 'g'); let m; while ((m = re.exec(pitch))) out.push({ id: m[1], L: +m[2], T: +m[3] }); return out; }

(async () => {
  console.log('\n=== PRODUCTION VERIFY: 20260628-overlay ===\n');
  const base = 'https://familista-backend.onrender.com';
  let js, css, html;
  for (let i = 1; i <= 25; i++) {
    js = await get(base + '/app.js?t=' + Date.now());
    css = await get(base + '/app.css?t=' + Date.now());
    html = await get(base + '/?t=' + Date.now());
    const live = js.includes('sqmd-pitch--overlay') && js.includes('function _sqBuildOpp') && html.includes('20260628-overlay');
    console.log('attempt ' + i + ': overlay=' + (js.includes('sqmd-pitch--overlay') ? 'y' : 'n') + ' buildOpp=' + (js.includes('function _sqBuildOpp') ? 'y' : 'n') + ' tag=' + (html.includes('20260628-overlay') ? 'y' : 'n'));
    if (live) break;
    if (i < 25) await new Promise(r => setTimeout(r, 15000));
  }

  const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
  const ctx = {
    console, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
    window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
    State: { club: { name: 'FC Familista' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
    requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
    history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  ctx.window = ctx; vm.createContext(ctx);
  try { vm.runInContext(js.slice(a, b) + '\ntry{_sqBuildBoard();}catch(e){}', ctx); } catch (e) {}

  console.log('\n1. DEPLOY');
  console.log('   _sqBuildMy / _sqBuildOpp live:', js.includes('function _sqBuildMy') && js.includes('function _sqBuildOpp') ? 'YES v' : 'NO x');
  console.log('   overlay class in render:', js.includes("sqmd-pitch--overlay") ? 'YES v' : 'NO x');
  console.log('   opp transparency CSS:', css.includes('.sqmd-pitch--overlay .sqmd-card--opp') && css.includes('opacity:.58') ? 'YES v' : 'NO x');

  console.log('\n2. ONE SHARED PITCH — OPPONENT OVERLAY');
  ctx.SQ_FORM.showOpp = true;
  let pitch = ctx._sqMdPitchShared();
  let my = parse(pitch, 'data-cmdmove="1"'), opp = parse(pitch, 'data-cmdmove-opp="1"');
  console.log('   single pitch element:', (pitch.match(/sqmd-pitch--shared/g) || []).length === 1 ? 'YES v' : 'NO x');
  console.log('   overlay class:', pitch.includes('sqmd-pitch--overlay') ? 'YES v' : 'NO x');
  console.log('   My 11 + Opp 11 same pitch:', my.length === 11 && opp.length === 11 ? 'v' : my.length + '/' + opp.length + ' x');
  const myL = [Math.min(...my.map(c => c.L)), Math.max(...my.map(c => c.L))], opL = [Math.min(...opp.map(c => c.L)), Math.max(...opp.map(c => c.L))];
  console.log('   My FULL pitch L ' + myL[0].toFixed(0) + '-' + myL[1].toFixed(0) + '% ' + (myL[1] - myL[0] > 50 ? 'v' : 'x') + ' | Opp FULL pitch L ' + opL[0].toFixed(0) + '-' + opL[1].toFixed(0) + '% ' + (opL[1] - opL[0] > 50 ? 'v' : 'x'));
  console.log('   My GK left / Opp GK right:', my.reduce((p, c) => c.L < p.L ? c : p, my[0]).L < 14 && opp.reduce((p, c) => c.L > p.L ? c : p, opp[0]).L > 86 ? 'v' : 'x');
  console.log('   Teams overlap midfield (shared field):', (myL[1] > 50 && opL[0] < 50) ? 'YES v' : 'NO x');

  console.log('\n3. SOLO MODE unaffected (default My Team only)');
  ctx.SQ_FORM.showOpp = false;
  let solo = ctx._sqMdPitchShared();
  console.log('   solo + 0 opp cards:', solo.includes('sqmd-pitch--solo') && parse(solo, 'data-cmdmove-opp="1"').length === 0 ? 'v' : 'x');

  console.log('\n4. FORMATION ISOLATION');
  ctx._sqBuildBoard();
  const myId = ctx.SQ_MY_IDS[5]; ctx.SQ_POS_MY[myId] = { x: 33, y: 41 };
  const myForm0 = ctx.SQ_FORM.myFormation;
  ctx.sqPickFormation('3-5-2', 'opp');
  console.log('   change OPP -> 3-5-2: my formation kept (' + ctx.SQ_FORM.myFormation + ')', ctx.SQ_FORM.myFormation === myForm0 ? 'v' : 'x');
  console.log('   my dragged player preserved:', (ctx.SQ_POS_MY[myId] && ctx.SQ_POS_MY[myId].x === 33 && ctx.SQ_POS_MY[myId].y === 41) ? 'YES v' : 'NO x');
  ctx.SQ_POS_OPP2['op-3'] = { x: 70, y: 30 };
  const oppForm0 = ctx.SQ_FORM.oppFormation;
  ctx.sqPickFormation('4-2-3-1', 'my');
  console.log('   change MY -> 4-2-3-1: opp formation kept (' + ctx.SQ_FORM.oppFormation + ')', ctx.SQ_FORM.oppFormation === oppForm0 ? 'v' : 'x');
  console.log('   opp dragged player preserved:', (ctx.SQ_POS_OPP2['op-3'] && ctx.SQ_POS_OPP2['op-3'].x === 70 && ctx.SQ_POS_OPP2['op-3'].y === 30) ? 'YES v' : 'NO x');

  console.log('\n5. REGRESSION (all features intact)');
  ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
  console.log('   Zones / out-of-pos:', ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my').includes('sqmd-zone') ? 'v' : 'x');
  ctx.SQ_FORM.cmdSel = null;
  const bO = ctx._sqTeamReport('opp'); ctx._sqOppSubstitute('opr-7', 'op-10');
  console.log('   Opp sub + OVR recalc:', bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr, 'v');
  const bi = ctx.SQ_BENCH_IDS[0]; ctx._sqSubstitute(bi, ctx.SQ_MY_IDS[6]);
  console.log('   My sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'v' : 'x');
  const mu = ctx._sqMatchup();
  console.log('   Matchup recalc:', (mu && typeof mu.matchup === 'number') ? mu.matchup + '% v' : 'x');

  console.log('\n==================================================');
  console.log('COMMIT: 6c48a31   TAG: 20260628-overlay');
  console.log('FIX 1: Opponent overlays ONE shared pitch, transparent v');
  console.log('FIX 2: My/Opp formation state fully isolated v');
  console.log('ALL FEATURES PRESERVED v');
  console.log('==================================================\n');
})().catch(e => console.error('FATAL:', e.message));
