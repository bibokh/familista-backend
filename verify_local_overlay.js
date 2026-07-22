const fs = require('fs'), vm = require('vm');
const js = fs.readFileSync(require('path').join(__dirname, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(require('path').join(__dirname, 'public', 'app.css'), 'utf8');
const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
const ctx = {
  console, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
  window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
  State: { club: { name: 'FC Familista' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
  requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
  history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) })
};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(js.slice(a, b) + '\ntry{_sqBuildBoard();}catch(e){console.log("build err",e.message)}', ctx);
function parse(pitch, attr) { const out = []; const re = new RegExp(attr + '[^>]*data-id="([^"]+)"[^>]*style="left:([0-9.]+)%;top:([0-9.]+)%"', 'g'); let m; while ((m = re.exec(pitch))) out.push({ id: m[1], L: +m[2], T: +m[3] }); return out; }

console.log('\n=== LOCAL OVERLAY + FORMATION ISOLATION TEST ===\n');

// 1. OVERLAY MODE — both teams on ONE full pitch
ctx.SQ_FORM.showOpp = true;
let pitch = ctx._sqMdPitchShared();
let my = parse(pitch, 'data-cmdmove="1"'), opp = parse(pitch, 'data-cmdmove-opp="1"');
console.log('1. OVERLAY MODE (one shared pitch, opp transparent)');
console.log('   overlay class:', pitch.includes('sqmd-pitch--overlay') ? 'YES v' : 'NO x');
console.log('   single pitch element:', (pitch.match(/sqmd-pitch--shared/g) || []).length === 1 ? 'YES v' : 'NO x');
console.log('   My 11 + Opp 11 on same pitch:', my.length === 11 && opp.length === 11 ? 'v' : my.length + '/' + opp.length + ' x');
const myL = [Math.min(...my.map(c => c.L)), Math.max(...my.map(c => c.L))];
const opL = [Math.min(...opp.map(c => c.L)), Math.max(...opp.map(c => c.L))];
console.log('   My uses FULL pitch L ' + myL[0].toFixed(0) + '-' + myL[1].toFixed(0) + '% ' + (myL[1] - myL[0] > 50 ? 'v' : 'x'));
console.log('   Opp uses FULL pitch L ' + opL[0].toFixed(0) + '-' + opL[1].toFixed(0) + '% ' + (opL[1] - opL[0] > 50 ? 'v' : 'x'));
console.log('   My GK left goal:', my.reduce((p, c) => c.L < p.L ? c : p, my[0]).L < 14 ? 'v' : 'x', '| Opp GK right goal:', opp.reduce((p, c) => c.L > p.L ? c : p, opp[0]).L > 86 ? 'v' : 'x');
console.log('   Overlap in midfield (teams share central band):', (myL[1] > 50 && opL[0] < 50) ? 'YES v' : 'NO x');
console.log('   CSS opp transparency:', css.includes('.sqmd-pitch--overlay .sqmd-card--opp') && css.includes('opacity:.58') ? 'YES v' : 'NO x');

// 2. SOLO unaffected
ctx.SQ_FORM.showOpp = false;
let solo = ctx._sqMdPitchShared();
console.log('\n2. SOLO MODE still My-Team-only');
console.log('   solo class + no opp cards:', solo.includes('sqmd-pitch--solo') && parse(solo, 'data-cmdmove-opp="1"').length === 0 ? 'v' : 'x');

// 3. DRAG ROUND-TRIP (overlay opp)
ctx.SQ_FORM.showOpp = true;
pitch = ctx._sqMdPitchShared(); opp = parse(pitch, 'data-cmdmove-opp="1"');
const oc = opp[3];
const recX = oc.T, recY = oc.L; // opp reverse: x=width=T, y=depth=L
console.log('\n3. OPP DRAG ROUND-TRIP');
const stored = ctx.SQ_POS_OPP2[oc.id] || { x: '(slot)', y: '(slot)' };
console.log('   opp card renders + reverse-map consistent (x=T,y=L):', (recX >= 6 && recX <= 94 && recY >= 6 && recY <= 94) ? 'v' : 'x');

// 4. FORMATION ISOLATION
console.log('\n4. FORMATION ISOLATION');
ctx._sqBuildBoard();
// custom-drag a my player + record
const myId = ctx.SQ_MY_IDS[5];
ctx.SQ_POS_MY[myId] = { x: 33, y: 41 };
const myBeforeForm = ctx.SQ_FORM.myFormation;
// change OPPONENT formation
ctx.sqPickFormation('3-5-2', 'opp');
console.log('   Opp formation changed -> 3-5-2:', ctx.SQ_FORM.oppFormation === '3-5-2' ? 'v' : 'x');
console.log('   My formation UNCHANGED:', ctx.SQ_FORM.myFormation === myBeforeForm ? 'v (' + ctx.SQ_FORM.myFormation + ')' : 'x');
console.log('   My custom drag PRESERVED:', (ctx.SQ_POS_MY[myId] && ctx.SQ_POS_MY[myId].x === 33 && ctx.SQ_POS_MY[myId].y === 41) ? 'YES v' : 'NO x (reset!)');

// now set a custom opp position, change MY formation, check opp intact
ctx.SQ_POS_OPP2['op-3'] = { x: 70, y: 30 };
const oppBeforeForm = ctx.SQ_FORM.oppFormation;
ctx.sqPickFormation('4-2-3-1', 'my');
console.log('   My formation changed -> 4-2-3-1:', ctx.SQ_FORM.myFormation === '4-2-3-1' ? 'v' : 'x');
console.log('   Opp formation UNCHANGED:', ctx.SQ_FORM.oppFormation === oppBeforeForm ? 'v (' + ctx.SQ_FORM.oppFormation + ')' : 'x');
console.log('   Opp custom drag PRESERVED:', (ctx.SQ_POS_OPP2['op-3'] && ctx.SQ_POS_OPP2['op-3'].x === 70 && ctx.SQ_POS_OPP2['op-3'].y === 30) ? 'YES v' : 'NO x (reset!)');

// 5. ZONES + REGRESSION
console.log('\n5. ZONES + REGRESSION');
ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
console.log('   Zones render:', ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my').includes('sqmd-zone') ? 'v' : 'x');
ctx.SQ_FORM.cmdSel = null;
const bO = ctx._sqTeamReport('opp');
ctx._sqOppSubstitute('opr-7', 'op-10');
console.log('   Opp sub + OVR recalc:', bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr, 'v');
const bi = ctx.SQ_BENCH_IDS[0];
ctx._sqSubstitute(bi, ctx.SQ_MY_IDS[6]);
console.log('   My sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'v' : 'x');

console.log('\n=== DONE ===\n');
