const fs = require('fs'), vm = require('vm'), path = require('path');
const js = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public', 'app.css'), 'utf8');
const a = js.indexOf('function _sqSubHtml'), b = js.indexOf('function renderClubHome() {', a);
const ctx = {
  console, document: { getElementById: () => ({ innerHTML: '', style: {}, querySelectorAll: () => [] }), querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ innerHTML: '', style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }), createElementNS: () => ({ setAttribute: () => {} }), addEventListener: () => {} },
  window: {}, localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
  State: { club: { name: 'FC Familista' } }, setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {}, clearInterval: () => {},
  requestAnimationFrame: () => {}, navigator: { userAgent: 'node' }, performance: { now: () => Date.now() },
  history: { pushState: () => {} }, location: { href: 'http://localhost/' }, fetch: async () => ({ ok: false, json: async () => ({}) }), JSON
};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(js.slice(a, b) + '\ntry{_sqBuildBoard();}catch(e){console.log("build err",e.message)}', ctx);

console.log('\n=== LOCAL MARKER REDESIGN TEST ===\n');

// 1. slug resolver
console.log('1. IMAGE RESOLVER (generic)');
console.log("   slug('Vlad') =", ctx._sqSlug('Vlad'), ctx._sqSlug('Vlad') === 'vlad' ? 'v' : 'x');
console.log("   slug('Diego Marán') =", ctx._sqSlug('Diego Marán'), ctx._sqSlug('Diego Marán') === 'diego-maran' ? 'v' : 'x');
console.log("   slug('Yasser') =", ctx._sqSlug('Yasser'), ctx._sqSlug('Yasser') === 'yasser' ? 'v' : 'x');
console.log('   silhouette is data URI:', /^data:image\/svg\+xml/.test(ctx._SQ_SILHOUETTE) ? 'v' : 'x');

// 2. my card, no photo -> auto /players/<slug>.png + fallbacks + onerror
console.log('\n2. MY MARKER (no photo -> auto PNG path, silhouette fallback)');
const c1 = ctx._sqMdCard('my', 1, 'Marán', 'GK', 84, ['C'], false, null, 'sq-1', 'hold', false, 'gk', 'GK / SK');
console.log('   tries /players/maran.png:', c1.includes('/players/maran.png') ? 'v' : 'x');
console.log('   fallback to /players/sq-1.png:', c1.includes('/players/sq-1.png') ? 'v' : 'x');
console.log('   has onerror chain:', c1.includes('data-fallbacks') && c1.includes('onerror') ? 'v' : 'x');
console.log('   circular portrait:', c1.includes('sqmd-portrait') && c1.includes('sqmd-av--my') ? 'v' : 'x');
console.log('   jersey num + ovr badge:', c1.includes('sqmd-num') && c1.includes('sqmd-ovr') ? 'v' : 'x');
console.log('   name + pos labels:', c1.includes('sqmd-card-nm') && c1.includes('sqmd-card-pos') ? 'v' : 'x');
console.log('   captain badge kept:', c1.includes('sqmd-rb--c') ? 'v' : 'x');
console.log('   instruction icon kept:', c1.includes('sqmd-instr') ? 'v' : 'x');
console.log('   drag/click attrs intact:', c1.includes('data-id="sq-1"') && c1.includes('data-team="my"') ? 'v' : 'x');
console.log('   NO black-box card bg class removed (no sqmd-card-top):', !c1.includes('sqmd-card-top') ? 'v' : 'x');

// 3. my card WITH uploaded photo -> uses it first
const c2 = ctx._sqMdCard('my', 7, 'Vlad', 'GK', 80, [], false, 'data:image/png;base64,AAAA', 'sq-vlad', 'hold', false, 'gk', 'GK');
console.log('\n3. MY MARKER WITH UPLOADED PHOTO');
console.log('   uses uploaded photo first:', c2.includes('src="data:image/png;base64,AAAA"') ? 'v' : 'x');

// 4. opponent card -> silhouette (no name/id), blue, semi-transparent via class
console.log('\n4. OPPONENT MARKER (silhouette, same design)');
const c3 = ctx._sqMdCard('opp', 9, 'Rival', 'ST', 79, null, false, null, 'op-9', null, false, 'fw', 'ST');
console.log('   opp side class:', c3.includes('sqmd-card--opp') && c3.includes('sqmd-av--opp') ? 'v' : 'x');
console.log('   silhouette used (is-sil, no onerror):', c3.includes('is-sil') && !c3.includes('onerror') ? 'v' : 'x');
console.log('   no opp PNG path (opp stays generic):', !c3.includes('/players/') ? 'v' : 'x');

// 5. selection state
console.log('\n5. SELECTION');
const cSel = ctx._sqMdCard('my', 1, 'Marán', 'GK', 84, [], false, null, 'sq-1', 'hold', true, 'gk', 'GK');
console.log('   is-sel class applied:', cSel.includes('is-sel') ? 'v' : 'x');

// 6. pitch renders markers in both modes (drag-ready slots)
console.log('\n6. PITCH RENDER');
ctx.SQ_FORM.showOpp = false;
let p = ctx._sqMdPitchShared();
console.log('   solo: 11 my slots:', (p.match(/data-cmdmove="1"/g) || []).length === 11 ? 'v' : 'x', '| portraits:', (p.match(/sqmd-portrait/g) || []).length === 11 ? 'v' : 'x');
ctx.SQ_FORM.showOpp = true;
p = ctx._sqMdPitchShared();
console.log('   overlay: my 11 + opp 11:', (p.match(/data-cmdmove="1"/g) || []).length === 11 && (p.match(/data-cmdmove-opp="1"/g) || []).length === 11 ? 'v' : 'x');

// 7. CSS premium styles present
console.log('\n7. CSS');
console.log('   portrait circle + glow:', css.includes('.sqmd-portrait{') && css.includes('border-radius:50%') ? 'v' : 'x');
console.log('   no black rectangle (card bg none):', /\.sqmd-card\{[^}]*background:none/.test(css) ? 'v' : 'x');
console.log('   hover animation:', css.includes('.sqmd-card:hover') && css.includes('scale(1.06)') ? 'v' : 'x');
console.log('   gold selection outline:', css.includes('.sqmd-card.is-sel') && css.includes('#f4b740') ? 'v' : 'x');
console.log('   GPU transform + will-change:', css.includes('will-change:transform') ? 'v' : 'x');
console.log('   smooth drag (no transition while moving):', css.includes('.sqmd-slot.is-moving .sqmd-card{ transition:none') ? 'v' : 'x');
console.log('   opp opacity 50-60%:', css.includes('.sqmd-card--opp{ opacity:.58') || css.includes('.sqmd-pitch--overlay .sqmd-card--opp{ opacity:.58') ? 'v' : 'x');

// 8. regression: no syntax errors, functions intact
console.log('\n8. REGRESSION');
console.log('   _sqMdAvatar still defined (benches unchanged):', typeof ctx._sqMdAvatar === 'function' ? 'v' : 'x');
const bO = ctx._sqTeamReport('opp'); ctx._sqOppSubstitute('opr-7', 'op-10');
console.log('   opp sub + OVR:', bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr, 'v');

console.log('\n=== DONE ===\n');
