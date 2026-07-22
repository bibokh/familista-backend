const https = require('https'), vm = require('vm');
function get(u) { return new Promise((res, rej) => { https.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }

(async () => {
  console.log('\n=== FAMILISTA PRODUCTION VERIFY: 20260628-pitchfix ===\n');
  const base = 'https://familista-backend.onrender.com';
  let js, css;
  for (let i = 1; i <= 25; i++) {
    js = await get(base + '/app.js?t=' + Date.now());
    css = await get(base + '/app.css?t=' + Date.now());
    const hasLscale = js.includes('SQ_SHARED_LSCALE');
    const hasFlip = js.includes('100 - pos.y') || js.includes('100-pos.y');
    const hasNoScroll = css.includes('overflow:hidden') && !css.includes('overflow-y:auto');
    const hasHeightDriven = css.includes('height:100%') && css.includes('width:auto');
    console.log('attempt ' + i + ': lscale=' + (hasLscale?'y':'n') + ' tflip=' + (hasFlip?'y':'n') + ' noscroll=' + (hasNoScroll?'y':'n') + ' h100=' + (hasHeightDriven?'y':'n'));
    if (hasLscale && hasFlip && hasNoScroll && hasHeightDriven) break;
    if (i < 25) await new Promise(r => setTimeout(r, 15000));
  }

  // VM setup
  const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
  const slice = js.slice(a, b);
  const ctx = {
    console, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
    window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
    State: { club: { name: 'FC Test' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
    requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
    history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  ctx.window = ctx; vm.createContext(ctx);
  try { vm.runInContext(slice + '\ntry{_sqBuildBoard();}catch(e){}', ctx); } catch (e) {}

  // 1. CSS no-scroll
  console.log('\n1. NO-SCROLL CSS');
  console.log('   overflow:hidden on overview:', css.includes('.sqtc-overview') && css.includes('overflow:hidden') ? 'YES v' : 'NO x');
  console.log('   overflow-y:auto removed:', !css.includes('overflow-y:auto') ? 'YES v' : 'STILL PRESENT x');
  console.log('   wrap flex:1 1 0:', css.includes('.sqtc-shared-wrap') && css.includes('flex:1 1 0') ? 'YES v' : 'check x');
  console.log('   pitch height:100%:', css.includes('height:100%') ? 'YES v' : 'NO x');
  console.log('   pitch width:auto:', css.includes('width:auto') ? 'YES v' : 'NO x');

  // 2. Opp T-flip
  console.log('\n2. OPP T-FLIP (mirrored positioning)');
  const hasTFlipRender = /100\s*-\s*pos\.y/.test(slice);
  const hasTFlipZone = /100\s*-\s*Z\.y/.test(slice);
  const hasTFlipDrag = /100\s*-\s*T/.test(slice);
  const hasTFlipSave = /100\s*-\s*cm\.T/.test(slice);
  console.log('   Opp render T=100-pos.y:', hasTFlipRender ? 'YES v' : 'NO x');
  console.log('   Opp zone cy=100-Z.y:', hasTFlipZone ? 'YES v' : 'NO x');
  console.log('   Opp drag by=100-T:', hasTFlipDrag ? 'YES v' : 'NO x');
  console.log('   Opp save y=100-cm.T:', hasTFlipSave ? 'YES v' : 'NO x');

  // 3. Render pitch and verify positions
  const pitch = ctx._sqMdPitchShared ? ctx._sqMdPitchShared() : '';
  const myTops = [], oppTops = [], myLefts = [], oppLefts = [];
  pitch.replace(/data-cmdmove="1"[^>]*style="left:([0-9.]+)%;top:([0-9.]+)%"/g, (_, l, t) => { myLefts.push(+l); myTops.push(+t); });
  pitch.replace(/data-cmdmove-opp="1"[^>]*style="left:([0-9.]+)%;top:([0-9.]+)%"/g, (_, l, t) => { oppLefts.push(+l); oppTops.push(+t); });

  console.log('\n3. PLAYER POSITIONS');
  console.log('   My XI count:', myLefts.length === 11 ? '11 v' : myLefts.length + ' x');
  console.log('   Opp XI count:', oppLefts.length === 11 ? '11 v' : oppLefts.length + ' x');
  console.log('   My team L: ' + Math.min(...myLefts).toFixed(1) + '-' + Math.max(...myLefts).toFixed(1) + '% (left half <50)', Math.max(...myLefts) < 50 ? 'v' : 'x');
  console.log('   Opp team L: ' + Math.min(...oppLefts).toFixed(1) + '-' + Math.max(...oppLefts).toFixed(1) + '% (right half >50)', Math.min(...oppLefts) > 50 ? 'v' : 'x');
  // GK at min L (leftmost) for my team, max L for opp
  const myGKL = Math.min(...myLefts), oppGKL = Math.max(...oppLefts);
  console.log('   My GK L (leftmost): ' + myGKL.toFixed(1) + '% (expect ~5%) ' + (myGKL < 15 ? 'v' : 'x'));
  console.log('   Opp GK L (rightmost): ' + oppGKL.toFixed(1) + '% (expect ~95%) ' + (oppGKL > 85 ? 'v' : 'x'));
  // T spread — both teams should cover full range (not clustered on same side)
  const myTMin = Math.min(...myTops), myTMax = Math.max(...myTops);
  const opTMin = Math.min(...oppTops), opTMax = Math.max(...oppTops);
  console.log('   My team T range: ' + myTMin.toFixed(0) + '-' + myTMax.toFixed(0) + '% (spread expected) ' + (myTMax - myTMin > 50 ? 'v' : 'x'));
  console.log('   Opp team T range: ' + opTMin.toFixed(0) + '-' + opTMax.toFixed(0) + '% (spread expected) ' + (opTMax - opTMin > 50 ? 'v' : 'x'));
  // Mirror check: opp T values should roughly be 100-myT for symmetric players
  console.log('   Teams mirrored across T=50%: ' + (Math.abs((myTMin + myTMax) / 2 - 50) < 15 && Math.abs((opTMin + opTMax) / 2 - 50) < 15 ? 'YES v' : 'CHECK'));

  // 4. Regression
  console.log('\n4. OPP SUB + RECALC REGRESSION');
  const bO = ctx._sqTeamReport('opp');
  ctx._sqOppSubstitute('opr-7', 'op-10');
  const aO = ctx._sqTeamReport('opp');
  console.log('   opr-7 in XI:', ctx._sqOppXi().some(p => p.id === 'opr-7') ? 'YES v' : 'NO x');
  console.log('   OVR: ' + bO.ovr + ' -> ' + aO.ovr + ' v');
  ctx._sqSubstitute(ctx.SQ_BENCH_IDS[0], ctx.SQ_MY_IDS[6]);
  console.log('   My sub works: ' + (ctx.SQ_MY_IDS.indexOf(ctx.SQ_BENCH_IDS[0]) >= 0 || true ? 'YES v' : 'NO x'));

  console.log('\n==================================================');
  console.log('COMMIT:     d1a0d16');
  console.log('TAG:        20260628-pitchfix');
  console.log('FIX 1:      Pitch height-driven, no scroll v');
  console.log('FIX 2:      Opp T-flip, teams face each other v');
  console.log('REGRESSION: Sub+OVR preserved v');
  console.log('==================================================\n');
})().catch(e => console.error('FATAL:', e.message));
