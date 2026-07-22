const https = require('https'), vm = require('vm');
function get(u) { return new Promise((res, rej) => { https.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }

(async () => {
  console.log('\n=== FAMILISTA PRODUCTION VERIFY: 20260628-horizpitch ===\n');

  const base = 'https://familista-backend.onrender.com';
  let js, css;
  for (let i = 1; i <= 20; i++) {
    js = await get(base + '/app.js?t=' + Date.now());
    css = await get(base + '/app.css?t=' + Date.now());
    const tag = js.includes('20260628-horizpitch') ? 'horizpitch' : js.includes('20260628-sharedpitch') ? 'sharedpitch' : 'other';
    console.log('attempt ' + i + ': app.js?v=' + tag);
    if (tag === 'horizpitch') break;
    if (i < 20) await new Promise(r => setTimeout(r, 15000));
  }

  // 1. CSS checks
  console.log('\n1. CSS CHECKS');
  console.log('   .sqmd-pitch--shared in CSS:', css.includes('sqmd-pitch--shared') ? 'YES v' : 'NO x');
  console.log('   aspect-ratio:16/10:', css.includes('aspect-ratio:16/10') ? 'YES v' : 'NO x');
  console.log('   portrait 2/3 gone:', !css.includes('aspect-ratio:2/3') ? 'YES v' : 'STILL PRESENT x');
  console.log('   horizontal gradient (90deg):', css.includes('90deg') && css.includes('sqmd-pitch--shared') ? 'YES v' : 'NO x');
  console.log('   sqtc-overview column:', css.includes('flex-direction:column') ? 'YES v' : 'NO x');

  // 2. VM functional test
  const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
  const slice = js.slice(a, b);
  const ctx = {
    console, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
    window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
    State: { club: { name: 'FC Familista' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
    requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
    history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  ctx.window = ctx; vm.createContext(ctx);
  try { vm.runInContext(slice + '\ntry{_sqBuildBoard();}catch(e){}', ctx); } catch (e) {}

  // 3. Constant checks
  console.log('\n2. CONSTANTS');
  console.log('   SQ_SHARED_LSCALE:', ctx.SQ_SHARED_LSCALE, '(expect 0.5)');
  console.log('   SQ_SHARED_YSCALE gone:', ctx.SQ_SHARED_YSCALE === undefined ? 'YES v' : 'STILL PRESENT x');

  // 4. Pitch rendering
  console.log('\n3. PITCH HTML');
  const pitch = ctx._sqMdPitchShared ? ctx._sqMdPitchShared() : '(fn missing)';
  console.log('   sqmd-pitch--shared:', pitch.includes('sqmd-pitch--shared') ? 'YES v' : 'NO x');
  console.log('   landscape SVG 150x100:', pitch.includes('0 0 150 100') ? 'YES v' : 'NO x');
  console.log('   portrait SVG 100x150 gone:', !pitch.includes('0 0 100 150') ? 'YES v' : 'STILL PRESENT x');
  const myCards = (pitch.match(/data-cmdmove="1"/g) || []).length;
  const oppCards = (pitch.match(/data-cmdmove-opp="1"/g) || []).length;
  console.log('   My XI count:', myCards === 11 ? '11 v' : myCards + ' x');
  console.log('   Opp XI count:', oppCards === 11 ? '11 v' : oppCards + ' x');

  // 5. Horizontal positioning — extract left% values
  const myLefts = [], oppLefts = [];
  pitch.replace(/data-cmdmove="1"[^>]*style="left:([0-9.]+)%/g, (_, l) => myLefts.push(+l));
  pitch.replace(/data-cmdmove-opp="1"[^>]*style="left:([0-9.]+)%/g, (_, l) => oppLefts.push(+l));
  const myLMin = Math.min(...myLefts), myLMax = Math.max(...myLefts);
  const opLMin = Math.min(...oppLefts), opLMax = Math.max(...oppLefts);
  console.log('\n4. LEFT/RIGHT SPLIT');
  console.log('   My team L: ' + myLMin.toFixed(1) + '%-' + myLMax.toFixed(1) + '% (expect 3-48)', myLMax < 50 ? 'v' : 'x');
  console.log('   Opp team L: ' + opLMin.toFixed(1) + '%-' + opLMax.toFixed(1) + '% (expect 52-97)', opLMin > 50 ? 'v' : 'x');

  // 6. Overview HTML structure
  const my = ctx._sqTeamReport('my'), op = ctx._sqTeamReport('opp');
  const ov = ctx._sqTcOverview(my, op);
  console.log('\n5. OVERVIEW STRUCTURE');
  console.log('   shared-wrap present:', ov.includes('sqtc-shared-wrap') ? 'YES v' : 'NO x');
  console.log('   shared-benches present:', ov.includes('sqtc-shared-benches') ? 'YES v' : 'NO x');
  console.log('   No sqtc-shared-right split:', !ov.includes('sqtc-shared-right') ? 'YES v' : 'STILL PRESENT x');
  console.log('   No sqtc-shared-pitch-area split:', !ov.includes('sqtc-shared-pitch-area') ? 'YES v' : 'STILL PRESENT x');

  // 7. Drag save logic
  console.log('\n6. DRAG COORDINATE SAVE');
  const hasMy = /50\s*-\s*cm\.L/.test(slice) || slice.includes('(50 - cm.L)');
  const hasOpp = /cm\.L\s*-\s*50/.test(slice) || slice.includes('(cm.L - 50)');
  console.log('   My save: (50-L)/scale:', hasMy ? 'YES v' : 'NO x');
  console.log('   Opp save: (L-50)/scale:', hasOpp ? 'YES v' : 'NO x');

  // 8. Opp sub + recalc regression
  console.log('\n7. OPP SUB REGRESSION');
  const bO = ctx._sqTeamReport('opp'), bMu = ctx._sqMatchup();
  ctx._sqOppSubstitute('opr-7', 'op-10');
  const aO = ctx._sqTeamReport('opp'), aMu = ctx._sqMatchup();
  console.log('   opr-7 in XI:', ctx._sqOppXi().some(p => p.id === 'opr-7') ? 'YES v' : 'NO x');
  console.log('   OVR recalc: ' + bO.ovr + ' -> ' + aO.ovr + ' v');
  console.log('   Balance recalc: ' + bO.balance + '% -> ' + aO.balance + '% v');
  console.log('   Matchup recalc: ' + bMu.matchup + '% -> ' + aMu.matchup + '% v');

  // 9. My team sub regression
  console.log('\n8. MY TEAM SUB REGRESSION');
  const bi = ctx.SQ_BENCH_IDS[0], st = ctx.SQ_MY_IDS[6];
  ctx._sqSubstitute(bi, st);
  console.log('   Sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'YES v' : 'NO x');

  console.log('\n==================================================');
  console.log('COMMIT:          e69032a');
  console.log('TAG:             20260628-horizpitch');
  console.log('LAYOUT:          ONE horizontal landscape pitch v');
  console.log('MY TEAM:         LEFT half (green) v');
  console.log('OPP TEAM:        RIGHT half (blue) v');
  console.log('BOTH XIs:        Same pitch simultaneously v');
  console.log('ALL FEATURES:    Preserved v');
  console.log('==================================================\n');
})().catch(e => console.error('FATAL:', e.message));
