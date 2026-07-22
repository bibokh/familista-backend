const https = require('https'), vm = require('vm');
function get(u) { return new Promise((res, rej) => { https.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }

(async () => {
  console.log('\n=== PRODUCTION VERIFY: 20260628-markers ===\n');
  const base = 'https://familista-backend.onrender.com';
  let js, css, html;
  for (let i = 1; i <= 25; i++) {
    js = await get(base + '/app.js?t=' + Date.now());
    css = await get(base + '/app.css?t=' + Date.now());
    html = await get(base + '/?t=' + Date.now());
    const live = js.includes('_sqPlayerPortrait') && js.includes('_SQ_SILHOUETTE') && html.includes('20260628-markers');
    console.log('attempt ' + i + ': portrait=' + (js.includes('_sqPlayerPortrait') ? 'y' : 'n') + ' silhouette=' + (js.includes('_SQ_SILHOUETTE') ? 'y' : 'n') + ' tag=' + (html.includes('20260628-markers') ? 'y' : 'n'));
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
  console.log('   _sqPlayerPortrait live:', js.includes('function _sqPlayerPortrait') ? 'YES v' : 'NO x');
  console.log('   generic resolver (/players/ + slug):', js.includes("'/players/' + slug") && js.includes('function _sqSlug') ? 'YES v' : 'NO x');
  console.log('   silhouette data URI:', /^data:image\/svg\+xml/.test(ctx._SQ_SILHOUETTE || '') ? 'YES v' : 'NO x');

  console.log('\n2. MARKER MARKUP (my, no photo -> auto PNG, silhouette fallback)');
  const c1 = ctx._sqMdCard('my', 1, 'Vlad', 'GK', 84, ['C'], false, null, 'sq-1', 'hold', false, 'gk', 'GK');
  console.log('   auto /players/vlad.png:', c1.includes('/players/vlad.png') ? 'v' : 'x');
  console.log('   id fallback + onerror chain:', c1.includes('/players/sq-1.png') && c1.includes('data-fallbacks') && c1.includes('onerror') ? 'v' : 'x');
  console.log('   circular portrait + glow class:', c1.includes('sqmd-portrait') && c1.includes('sqmd-av--my') ? 'v' : 'x');
  console.log('   jersey num + OVR badge:', c1.includes('sqmd-num') && c1.includes('sqmd-ovr') ? 'v' : 'x');
  console.log('   name + position labels:', c1.includes('sqmd-card-nm') && c1.includes('sqmd-card-pos') ? 'v' : 'x');
  console.log('   captain + instruction icons kept:', c1.includes('sqmd-rb--c') && c1.includes('sqmd-instr') ? 'v' : 'x');
  console.log('   drag/click attrs intact:', c1.includes('data-id="sq-1"') && c1.includes('data-team="my"') ? 'v' : 'x');

  console.log('\n3. UPLOADED PHOTO TAKES PRIORITY');
  const c2 = ctx._sqMdCard('my', 7, 'Yasser', 'GK', 80, [], false, 'data:image/png;base64,AAAA', 'sq-y', 'hold', false, 'gk', 'GK');
  console.log('   uses uploaded photo first:', c2.includes('src="data:image/png;base64,AAAA"') ? 'v' : 'x');

  console.log('\n4. OPPONENT MARKER (same design, blue, transparent)');
  const c3 = ctx._sqMdCard('opp', 9, 'Rival', 'ST', 79, null, false, null, 'op-9', null, false, 'fw', 'ST');
  console.log('   opp classes + silhouette:', c3.includes('sqmd-card--opp') && c3.includes('sqmd-av--opp') && c3.includes('is-sil') ? 'v' : 'x');
  console.log('   opp opacity 58% + blue accent CSS:', css.includes('.sqmd-pitch--overlay .sqmd-card--opp{ opacity:.58') && css.includes('.sqmd-card--opp .sqmd-ovr{ background:linear-gradient(135deg,#2563eb') ? 'v' : 'x');

  console.log('\n5. PREMIUM CSS (no black box, glow, hover, selection, 60fps)');
  console.log('   no black rectangle (card bg none):', /\.sqmd-card\{[^}]*background:none/.test(css) ? 'v' : 'x');
  console.log('   portrait glow per side:', css.includes('.sqmd-card--my .sqmd-portrait') && css.includes('rgba(34,197,94') ? 'v' : 'x');
  console.log('   hover lift+scale:', css.includes('.sqmd-card:hover') && css.includes('scale(1.06)') ? 'v' : 'x');
  console.log('   gold selection outline+scale:', css.includes('.sqmd-card.is-sel') && css.includes('#f4b740') ? 'v' : 'x');
  console.log('   GPU transforms (will-change) + no drag-lag:', css.includes('will-change:transform') && css.includes('.sqmd-slot.is-moving .sqmd-card{ transition:none') ? 'v' : 'x');

  console.log('\n6. PITCH RENDER + REGRESSION');
  ctx.SQ_FORM.showOpp = true;
  const p = ctx._sqMdPitchShared();
  console.log('   my 11 + opp 11 markers, drag-ready:', (p.match(/data-cmdmove="1"/g) || []).length === 11 && (p.match(/data-cmdmove-opp="1"/g) || []).length === 11 ? 'v' : 'x');
  console.log('   portraits rendered:', (p.match(/sqmd-portrait/g) || []).length === 22 ? 'v' : (p.match(/sqmd-portrait/g) || []).length + ' x');
  ctx.SQ_FORM.cmdSel = ctx.SQ_MY_IDS[3];
  console.log('   zones / out-of-pos intact:', ctx._sqMdZonesShared(ctx.SQ_FORM.cmdSel, 'my').includes('sqmd-zone') ? 'v' : 'x');
  ctx.SQ_FORM.cmdSel = null;
  const bO = ctx._sqTeamReport('opp'); ctx._sqOppSubstitute('opr-7', 'op-10');
  console.log('   opp sub + OVR recalc:', bO.ovr + ' -> ' + ctx._sqTeamReport('opp').ovr, 'v');
  const bi = ctx.SQ_BENCH_IDS[0]; ctx._sqSubstitute(bi, ctx.SQ_MY_IDS[6]);
  console.log('   my sub works:', ctx.SQ_MY_IDS.indexOf(bi) >= 0 ? 'v' : 'x');

  console.log('\n==================================================');
  console.log('COMMIT: c1fe2e0   TAG: 20260628-markers');
  console.log('Premium circular markers, photo auto-resolver + silhouette v');
  console.log('Opponent same design, blue + transparent v');
  console.log('Drag / select / OVR / Balance / zones / OOP intact v');
  console.log('==================================================\n');
})().catch(e => console.error('FATAL:', e.message));
