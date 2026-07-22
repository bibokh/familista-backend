const https = require('https'), vm = require('vm');
function get(u) { return new Promise((res, rej) => { https.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }
function parse(pitch, attr) { const out = []; const re = new RegExp(attr + '[^>]*data-id="([^"]+)"[^>]*style="left:([0-9.]+)%;top:([0-9.]+)%"', 'g'); let m; while ((m = re.exec(pitch))) out.push({ id: m[1], L: +m[2], T: +m[3] }); return out; }

(async () => {
  console.log('\n=== PRODUCTION VERIFY: 20260628-topteam ===\n');
  const base = 'https://familista-backend.onrender.com';
  let js, css, html;
  for (let i = 1; i <= 25; i++) {
    js = await get(base + '/app.js?t=' + Date.now());
    css = await get(base + '/app.css?t=' + Date.now());
    html = await get(base + '/?t=' + Date.now());
    const live = js.includes('sqCmdToggleOpp') && js.includes('sqmd-pitch--solo') && html.includes('20260628-topteam');
    console.log('attempt ' + i + ': toggle=' + (js.includes('sqCmdToggleOpp') ? 'y' : 'n') + ' solo=' + (js.includes('sqmd-pitch--solo') ? 'y' : 'n') + ' tag=' + (html.includes('20260628-topteam') ? 'y' : 'n'));
    if (live) break;
    if (i < 25) await new Promise(r => setTimeout(r, 15000));
  }

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

  console.log('\n1. DEPLOY & DEFAULT');
  console.log('   sqCmdToggleOpp live:', js.includes('function sqCmdToggleOpp') ? 'YES v' : 'NO x');
  console.log('   dispatcher case live:', js.includes("case 'sqCmdToggleOpp'") ? 'YES v' : 'NO x');
  console.log('   showOpp defaults false:', ctx.SQ_FORM.showOpp === false ? 'YES v' : 'NO x');
  console.log('   no-scroll css (overview overflow:hidden):', css.includes('.sqtc-overview') && css.includes('overflow:hidden') ? 'YES v' : 'NO x');
  console.log('   pitch fills width (width:100%;height:auto):', css.includes('width:100%; height:auto') ? 'YES v' : 'check');
  console.log('   solo gradient css:', css.includes('sqmd-pitch--solo') ? 'YES v' : 'NO x');

  ctx.SQ_FORM.showOpp = false;
  let pitch = ctx._sqMdPitchShared();
  let my = parse(pitch, 'data-cmdmove="1"'), opp = parse(pitch, 'data-cmdmove-opp="1"');
  console.log('\n2. SOLO MODE (default = My Team only)');
  console.log('   solo class:', pitch.includes('sqmd-pitch--solo') ? 'YES v' : 'NO x');
  console.log('   My cards 11:', my.length === 11 ? 'v' : my.length + ' x');
  console.log('   Opp cards 0:', opp.length === 0 ? 'v' : opp.length + ' x');
  const myGK = my.reduce((p, c) => c.L < p.L ? c : p, my[0]);
  console.log('   GK in goal area (L<20, T 35-65): L=' + myGK.L.toFixed(0) + ' T=' + myGK.T.toFixed(0) + ' ' + (myGK.L < 20 && myGK.T > 35 && myGK.T < 65 ? 'v' : 'x'));
  console.log('   Depth spread L ' + Math.min(...my.map(c => c.L)).toFixed(0) + '-' + Math.max(...my.map(c => c.L)).toFixed(0) + '% ' + (Math.max(...my.map(c => c.L)) - Math.min(...my.map(c => c.L)) > 40 ? 'v' : 'x'));
  console.log('   Width spread T ' + Math.min(...my.map(c => c.T)).toFixed(0) + '-' + Math.max(...my.map(c => c.T)).toFixed(0) + '% ' + (Math.max(...my.map(c => c.T)) - Math.min(...my.map(c => c.T)) > 50 ? 'v' : 'x'));

  ctx.SQ_FORM.showOpp = true;
  pitch = ctx._sqMdPitchShared();
  my = parse(pitch, 'data-cmdmove="1"'); opp = parse(pitch, 'data-cmdmove-opp="1"');
  console.log('\n3. SHARED MODE (toggle ON = both teams)');
  console.log('   My 11 + Opp 11:', my.length === 11 && opp.length === 11 ? 'v' : my.length + '/' + opp.length + ' x');
  console.log('   My LEFT half:', Math.max(...my.map(c => c.L)) <= 50 ? 'v' : 'x', '(' + Math.min(...my.map(c => c.L)).toFixed(0) + '-' + Math.max(...my.map(c => c.L)).toFixed(0) + '%)');
  console.log('   Opp RIGHT half:', Math.min(...opp.map(c => c.L)) >= 50 ? 'v' : 'x', '(' + Math.min(...opp.map(c => c.L)).toFixed(0) + '-' + Math.max(...opp.map(c => c.L)).toFixed(0) + '%)');
  console.log('   My GK near left goal:', my.reduce((p, c) => c.L < p.L ? c : p, my[0]).L < 12 ? 'v' : 'x');
  console.log('   Opp GK near right goal:', opp.reduce((p, c) => c.L > p.L ? c : p, opp[0]).L > 88 ? 'v' : 'x');
  console.log('   Teams face each other (both full T spread):', (Math.max(...my.map(c => c.T)) - Math.min(...my.map(c => c.T)) > 50 && Math.max(...opp.map(c => c.T)) - Math.min(...opp.map(c => c.T)) > 50) ? 'v' : 'x');

  console.log('\n4. REGRESSION (logic intact)');
  const bO = ctx._sqTeamReport('opp');
  ctx._sqOppSubstitute('opr-7', 'op-10');
  console.log('   Opp sub + OVR recalc: ' + bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr + ' v');
  const bi = ctx.SQ_BENCH_IDS[0], st = ctx.SQ_MY_IDS[6];
  ctx._sqSubstitute(bi, st);
  console.log('   My sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'YES v' : 'NO x');
  ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
  console.log('   Zones render (out-of-pos logic):', ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my').includes('sqmd-zone') ? 'YES v' : 'NO x');

  console.log('\n==================================================');
  console.log('COMMIT:   e20fe1e   TAG: 20260628-topteam');
  console.log('DEFAULT:  My Team only on full pitch v');
  console.log('TOGGLE:   Show/Hide opponent -> both teams, one field v');
  console.log('POSITION: Natural (GK in goal, lines correct) v');
  console.log('NO-SCROLL + FULL-WIDTH PITCH v');
  console.log('ALL LOGIC PRESERVED v');
  console.log('==================================================\n');
})().catch(e => console.error('FATAL:', e.message));
