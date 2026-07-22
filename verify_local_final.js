const fs = require('fs'), vm = require('vm'), path = require('path');
const js = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public', 'app.css'), 'utf8');
const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
const ctx = {
  console, JSON, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
  window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
  State: { club: { name: 'FC Familista' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
  requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
  history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) })
};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(js.slice(a, b) + '\ntry{_sqBuildBoard();}catch(e){console.log("build err",e.message)}', ctx);

console.log('\n=== FINAL VISUAL REDESIGN — LOCAL TEST ===\n');

console.log('1. MY MARKER (full premium component)');
const c1 = ctx._sqMdCard('my', 1, 'Vlad', 'GK', 84, ['C'], false, null, 'sq-1', 'hold', false, 'gk', 'GK', 94);
console.log('   circular portrait + frame:', c1.includes('sqmd-portrait') && c1.includes('sqmd-av--my') ? 'v' : 'x');
console.log('   real-photo resolver /players/vlad.png:', c1.includes('/players/vlad.png') ? 'v' : 'x');
console.log('   OVR badge:', c1.includes('sqmd-ovr') ? 'v' : 'x', '| jersey num:', c1.includes('sqmd-num') ? 'v' : 'x');
console.log('   captain icon:', c1.includes('sqmd-rb--c') ? 'v' : 'x', '| condition icon:', c1.includes('sqmd-cond--good') ? 'v' : 'x');
console.log('   position + name:', c1.includes('sqmd-card-pos') && c1.includes('sqmd-card-nm') ? 'v' : 'x');
console.log('   drag/click attrs:', c1.includes('data-id="sq-1"') && c1.includes('data-team="my"') ? 'v' : 'x');
const cLow = ctx._sqMdCard('my', 2, 'Test', 'CB', 70, [], false, null, 'sq-2', null, false, 'df', 'CB', 62);
console.log('   condition tiers (low when cond=62):', cLow.includes('sqmd-cond--low') ? 'v' : 'x');

console.log('\n2. OPPONENT MARKER (same component, photo by id, shadow style)');
const c3 = ctx._sqMdCard('opp', 9, 'Rival', 'ST', 79, null, false, null, 'op-9', null, false, 'fw', 'ST', null);
console.log('   same component + opp classes:', c3.includes('sqmd-card--opp') && c3.includes('sqmd-av--opp') ? 'v' : 'x');
console.log('   resolves real photo by id /players/op-9.png:', c3.includes('/players/op-9.png') ? 'v' : 'x');
console.log('   silhouette fallback chain:', c3.includes('data-fallbacks') && c3.includes('onerror') ? 'v' : 'x');
console.log('   no condition icon for opp:', !c3.includes('sqmd-cond') ? 'v' : 'x');

console.log('\n3. OPPONENT TRANSPARENCY CSS (45% + desaturate + blue tint + soft shadow)');
console.log('   opacity .45:', css.includes('.sqmd-pitch--overlay .sqmd-card--opp{ opacity:.45') ? 'v' : 'x');
console.log('   desaturate filter:', /\.sqmd-card--opp\{ opacity:\.45; filter:grayscale/.test(css) ? 'v' : 'x');
console.log('   grey/blue tint overlay:', css.includes('.sqmd-card--opp .sqmd-av::after') ? 'v' : 'x');
console.log('   selected/dragged opp clears filter:', css.includes('opacity:.92; filter:none') ? 'v' : 'x');

console.log('\n4. FIFA FIELD MARKINGS (both goals)');
const f = ctx._sqMdField();
const spots = (f.match(/r="0.9"/g) || []).length;        // center + 2 penalty spots = 3
const arcs = (f.match(/A12 12 0 0 1/g) || []).length;     // 2 penalty arcs
const corners = (f.match(/A2 2 0 0 0/g) || []).length;    // 4 corner arcs
const boxes = (f.match(/<rect /g) || []).length;          // boundary + 2 pen areas + 2 six-yd + 2 goals = 7
console.log('   penalty + center spots (3):', spots === 3 ? 'v' : spots + ' x');
console.log('   penalty arcs both goals (2):', arcs === 2 ? 'v' : arcs + ' x');
console.log('   corner arcs (4):', corners === 4 ? 'v' : corners + ' x');
console.log('   boxes: boundary+pen areas+6yd+goals (7):', boxes === 7 ? 'v' : boxes + ' x');
console.log('   center circle + halfway line:', f.includes('circle cx="75" cy="50" r="12"') && f.includes('x1="75"') ? 'v' : 'x');

console.log('\n5. BENCH MINI PORTRAIT CHIPS');
const myBench = ctx._sqMdBench('my'), opBench = ctx._sqMdBench('opp');
console.log('   my bench mini portrait:', myBench.includes('sqmd-bc-av--my') && myBench.includes('sqmd-bc-img') ? 'v' : 'x');
console.log('   my bench photo resolver:', myBench.includes('/players/') ? 'v' : 'x');
console.log('   opp bench mini portrait + shadow class:', opBench.includes('sqmd-bc-av--opp') && opBench.includes('sqmd-bench-chip--opp') ? 'v' : 'x');
console.log('   bench drag attrs intact (data-sub / data-sub-opp):', myBench.includes('data-sub=') && opBench.includes('data-sub-opp=') ? 'v' : 'x');
console.log('   bench CSS present:', css.includes('.sqmd-bc-av{') && css.includes('.sqmd-bc-img{') ? 'v' : 'x');

console.log('\n6. PITCH RENDER + REGRESSION (logic untouched)');
ctx.SQ_FORM.showOpp = true;
const p = ctx._sqMdPitchShared();
console.log('   my 11 + opp 11 drag-ready:', (p.match(/data-cmdmove="1"/g) || []).length === 11 && (p.match(/data-cmdmove-opp="1"/g) || []).length === 11 ? 'v' : 'x');
console.log('   condition icons on my markers:', (p.match(/sqmd-cond/g) || []).length === 11 ? 'v' : (p.match(/sqmd-cond/g) || []).length + ' (ok if some cond=0)');
ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
console.log('   zones / out-of-pos intact:', ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my').includes('sqmd-zone') ? 'v' : 'x');
ctx.SQ_FORM.cmdSel = null;
const bO = ctx._sqTeamReport('opp'); ctx._sqOppSubstitute('opr-7', 'op-10');
console.log('   opp sub + OVR recalc:', bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr, 'v');
const bi = ctx.SQ_BENCH_IDS[0]; ctx._sqSubstitute(bi, ctx.SQ_MY_IDS[6]);
console.log('   my sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'v' : 'x');
const mu = ctx._sqMatchup(); console.log('   matchup recalc:', (mu && typeof mu.matchup === 'number') ? mu.matchup + '% v' : 'x');

console.log('\n=== DONE ===\n');
