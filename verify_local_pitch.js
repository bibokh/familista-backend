const fs = require('fs'), vm = require('vm');
const js = fs.readFileSync(require('path').join(__dirname, 'public', 'app.js'), 'utf8');
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
vm.runInContext(slice + '\ntry{_sqBuildBoard();}catch(e){console.log("build err",e.message)}', ctx);

function parse(pitch, attr) { const out = []; const re = new RegExp(attr + '[^>]*data-id="([^"]+)"[^>]*style="left:([0-9.]+)%;top:([0-9.]+)%"', 'g'); let m; while ((m = re.exec(pitch))) out.push({ id: m[1], L: +m[2], T: +m[3] }); return out; }

console.log('\n=== LOCAL PITCH LOGIC TEST ===\n');

// default showOpp should be false
console.log('1. DEFAULT STATE');
console.log('   SQ_FORM.showOpp default:', ctx.SQ_FORM.showOpp === false ? 'false v' : ctx.SQ_FORM.showOpp + ' x');

// --- SOLO (my team only) ---
ctx.SQ_FORM.showOpp = false;
let pitch = ctx._sqMdPitchShared();
let my = parse(pitch, 'data-cmdmove="1"');
let opp = parse(pitch, 'data-cmdmove-opp="1"');
console.log('\n2. SOLO MODE (My Team only, full pitch)');
console.log('   solo class:', pitch.includes('sqmd-pitch--solo') ? 'YES v' : 'NO x');
console.log('   My cards:', my.length === 11 ? '11 v' : my.length + ' x');
console.log('   Opp cards:', opp.length === 0 ? '0 v' : opp.length + ' x (should be 0)');
const gk = my.find(c => c.id === ctx.SQ_MY_IDS.find(id => ctx._sqP(id) && ctx._sqP(id).pos === 'GK')) || my.reduce((a, c) => c.L < a.L ? c : a, my[0]);
console.log('   My GK L: ' + gk.L.toFixed(1) + '% (near left goal, expect <20) ' + (gk.L < 20 ? 'v' : 'x') + '  T: ' + gk.T.toFixed(1) + '% (centered, 40-60) ' + (gk.T > 35 && gk.T < 65 ? 'v' : 'x'));
const myLr = [Math.min(...my.map(c => c.L)), Math.max(...my.map(c => c.L))];
const myTr = [Math.min(...my.map(c => c.T)), Math.max(...my.map(c => c.T))];
console.log('   My L range: ' + myLr[0].toFixed(0) + '-' + myLr[1].toFixed(0) + '% (depth spread, GK→attack) ' + (myLr[1] - myLr[0] > 40 ? 'v' : 'x'));
console.log('   My T range: ' + myTr[0].toFixed(0) + '-' + myTr[1].toFixed(0) + '% (full width touchline-touchline) ' + (myTr[1] - myTr[0] > 50 ? 'v' : 'x'));

// --- SHARED (both teams) ---
ctx.SQ_FORM.showOpp = true;
pitch = ctx._sqMdPitchShared();
my = parse(pitch, 'data-cmdmove="1"');
opp = parse(pitch, 'data-cmdmove-opp="1"');
console.log('\n3. SHARED MODE (both teams)');
console.log('   solo class absent:', !pitch.includes('sqmd-pitch--solo') ? 'YES v' : 'NO x');
console.log('   My cards:', my.length === 11 ? '11 v' : my.length + ' x');
console.log('   Opp cards:', opp.length === 11 ? '11 v' : opp.length + ' x');
const myL = [Math.min(...my.map(c => c.L)), Math.max(...my.map(c => c.L))];
const opL = [Math.min(...opp.map(c => c.L)), Math.max(...opp.map(c => c.L))];
console.log('   My L: ' + myL[0].toFixed(0) + '-' + myL[1].toFixed(0) + '% (LEFT half <50) ' + (myL[1] <= 50 ? 'v' : 'x'));
console.log('   Opp L: ' + opL[0].toFixed(0) + '-' + opL[1].toFixed(0) + '% (RIGHT half >50) ' + (opL[0] >= 50 ? 'v' : 'x'));
const myGK = my.reduce((a, c) => c.L < a.L ? c : a, my[0]);
const opGK = opp.reduce((a, c) => c.L > a.L ? c : a, opp[0]);
console.log('   My GK leftmost L: ' + myGK.L.toFixed(0) + '% (near left goal) ' + (myGK.L < 12 ? 'v' : 'x'));
console.log('   Opp GK rightmost L: ' + opGK.L.toFixed(0) + '% (near right goal) ' + (opGK.L > 88 ? 'v' : 'x'));
const myT = [Math.min(...my.map(c => c.T)), Math.max(...my.map(c => c.T))];
const opT = [Math.min(...opp.map(c => c.T)), Math.max(...opp.map(c => c.T))];
console.log('   My T width spread: ' + myT[0].toFixed(0) + '-' + myT[1].toFixed(0) + '% ' + (myT[1] - myT[0] > 50 ? 'v' : 'x'));
console.log('   Opp T width spread: ' + opT[0].toFixed(0) + '-' + opT[1].toFixed(0) + '% ' + (opT[1] - opT[0] > 50 ? 'v' : 'x'));

// --- Drag round-trip (shared my) ---
console.log('\n4. DRAG ROUND-TRIP (coordinate stability)');
const testId = ctx.SQ_MY_IDS[5];
const before = Object.assign({}, ctx.SQ_POS_MY[testId]);
// forward: render gives L,T; reverse should reproduce x,y
const card = my.find(c => c.id === testId);
// reverse-map shared my: x = T(width), y = 100 - L/LSCALE
const recoveredY = 100 - card.L / ctx.SQ_SHARED_LSCALE;
const recoveredX = card.T;
console.log('   Stored x(width)=' + before.x + ' recovered≈' + recoveredX.toFixed(0) + ' ' + (Math.abs(recoveredX - Math.max(6, Math.min(94, before.x))) < 2 ? 'v' : 'x'));
console.log('   Stored y(depth)=' + before.y + ' recovered≈' + recoveredY.toFixed(0) + ' ' + (Math.abs(recoveredY - before.y) < 3 ? 'v' : 'x'));

// --- Zone rect both modes ---
console.log('\n5. ZONE RECTS');
ctx.SQ_FORM.showOpp = false; ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
let z1 = ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my');
console.log('   Solo zones render:', z1.includes('sqmd-zone') ? 'YES v' : 'NO x');
ctx.SQ_FORM.showOpp = true;
let z2 = ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my');
console.log('   Shared zones render:', z2.includes('sqmd-zone') ? 'YES v' : 'NO x');
const zleft = (z2.match(/left:([0-9.]+)%/g) || []).map(s => +s.match(/[0-9.]+/)[0]);
console.log('   Shared my zone lefts all <55%: ' + (zleft.every(l => l < 55) ? 'v' : 'x') + ' (' + zleft.map(l => l.toFixed(0)).join(',') + ')');

// --- Regression: subs + OVR ---
console.log('\n6. REGRESSION');
ctx.SQ_FORM.cmdSel = null;
const bO = ctx._sqTeamReport('opp');
ctx._sqOppSubstitute('opr-7', 'op-10');
const aO = ctx._sqTeamReport('opp');
console.log('   Opp sub opr-7 in XI:', ctx._sqOppXi().some(p => p.id === 'opr-7') ? 'YES v' : 'NO x');
console.log('   Opp OVR recalc: ' + bO.ovr + ' -> ' + aO.ovr + ' ' + (typeof aO.ovr === 'number' ? 'v' : 'x'));
ctx._sqSubstitute(ctx.SQ_BENCH_IDS[0], ctx.SQ_MY_IDS[6]);
console.log('   My sub works:', ctx.SQ_MY_IDS.indexOf(ctx.SQ_BENCH_IDS[0]) >= 0 ? 'YES v' : 'NO x');

// --- Toggle function ---
console.log('\n7. TOGGLE FUNCTION');
console.log('   sqCmdToggleOpp defined:', typeof ctx.sqCmdToggleOpp === 'function' ? 'YES v' : 'NO x');

console.log('\n=== LOCAL TEST DONE ===\n');
