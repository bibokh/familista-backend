// sync-scoring-viz.js
// Applies Phase 10 scoring-visualization changes from public/app.js to all 3 HTML mirrors.
// Run from: familista-backend directory
// Usage: node sync-scoring-viz.js

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public', 'app.js');
const MIRRORS = [
  path.join(__dirname, 'familista_v5.html'),
  path.join(__dirname, 'frontend', 'familista_v5.html'),
  path.join(__dirname, 'frontend', 'index.html'),
];

const srcRaw = fs.readFileSync(SRC, 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractBlock(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('Start marker not found: ' + JSON.stringify(startMarker.substring(0, 60)));
  const e = src.indexOf(endMarker, s + startMarker.length);
  if (e === -1) throw new Error('End marker not found after start: ' + JSON.stringify(endMarker.substring(0, 60)));
  return src.slice(s, e + endMarker.length);
}

function toCRLF(str) { return str.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
function toLF(str)   { return str.replace(/\r\n/g, '\n'); }

function replaceInMirror(mirrorPath, replacements) {
  let raw = fs.readFileSync(mirrorPath, 'utf8');
  const isCRLF = raw.includes('\r\n');
  const normalised = toLF(raw);

  let result = normalised;
  for (const [oldStr, newStr] of replacements) {
    const old_lf = toLF(oldStr);
    if (result.indexOf(old_lf) === -1) {
      throw new Error('Replacement anchor not found in ' + path.basename(mirrorPath) + ':\n' + old_lf.substring(0, 120));
    }
    result = result.replace(old_lf, toLF(newStr));
    console.log('  ✓ Replaced: ' + old_lf.substring(0, 80).trim() + '…');
  }

  const final = isCRLF ? toCRLF(result) : result;
  fs.writeFileSync(mirrorPath, final, 'utf8');
  console.log('  Saved ' + path.basename(mirrorPath) + ' (' + (isCRLF ? 'CRLF' : 'LF') + ')');
}

// ── Extract NEW blocks from app.js ───────────────────────────────────────────

// 1. loadTransferData — fetch block + state assignment block
const newFetchBlock = extractBlock(srcRaw,
  '  const [targRes, pipeRes, repRes, contrRes, valRes, sqRes, rankRes, depthRes] = await Promise.allSettled([',
  '  State.transfer._squadDepth    = (depthRes.status === \'fulfilled\' && depthRes.value)                       ? depthRes.value       : null;'
);

const oldFetchBlock =
  `  const [targRes, pipeRes, repRes, contrRes, valRes, sqRes] = await Promise.allSettled([
    FamilistaAPI.get('/phase-q/transfer/targets?limit=200'),
    FamilistaAPI.get('/phase-q/transfer/pipeline'),
    FamilistaAPI.get('/phase-q/transfer/reports?limit=100'),
    FamilistaAPI.get('/phase-q/transfer/contracts-expiring'),
    FamilistaAPI.get('/phase-q/transfer/market-values/squad'),
    FamilistaAPI.get('/phase-q/transfer/intelligence/squad'),
  ]);

  State.transfer.targets    = (targRes.status  === 'fulfilled' && Array.isArray(targRes.value?.items))  ? targRes.value.items  : [];
  State.transfer.pipeline   = (pipeRes.status  === 'fulfilled' && pipeRes.value && typeof pipeRes.value === 'object') ? pipeRes.value : {};
  State.transfer.reports    = (repRes.status   === 'fulfilled' && Array.isArray(repRes.value?.items))   ? repRes.value.items   : [];
  State.transfer.contracts  = (contrRes.status === 'fulfilled' && Array.isArray(contrRes.value))        ? contrRes.value       : [];
  State.transfer.squadVal   = (valRes.status   === 'fulfilled' && Array.isArray(valRes.value))          ? valRes.value         : [];
  State.transfer.squadIntel = (sqRes.status    === 'fulfilled' && sqRes.value)                          ? sqRes.value          : null;`;

// 2. _tiDashboard — full function
const newDashboard = extractBlock(srcRaw,
  'function _tiDashboard() {',
  '\n}\n\n// ── SCREEN 2: Targets'
).replace('\n// ── SCREEN 2: Targets', '');

const oldDashboardStart = 'function _tiDashboard() {\n  const T          = State.transfer;\n  const active     = T.targets.filter(function(t) { return !t.archivedAt; });';
const oldDashboardEnd   = '  return kpis + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;">${pipeCard}${topCard}</div>` + repCard;\n}';
const oldDashboard = extractBlock(srcRaw.replace(
  // we already have the NEW version — rebuild the old anchor from original pattern
  // Actually we can't extract old from already-edited src. We embed it literally here.
  '', ''
), '', '') || null; // skip this approach — embed old directly below

// 3. _tiTargets — full function
const newTargets = extractBlock(srcRaw,
  'function _tiTargets() {',
  '\n}\n\n// ── SCREEN 3: Market Intelligence'
).replace('\n// ── SCREEN 3: Market Intelligence', '');

// 4. _tiMarket — last line of function
const newMarketReturn = extractBlock(srcRaw,
  "  return kpis + `<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:16px;\">${ageCard}${posCard}</div>` + valCard + mktOppCard + sqDepthCard;",
  '\n}\n\n// ── SCREEN 4: Contract Center'
).replace('\n// ── SCREEN 4: Contract Center', '');

const oldMarketReturn = `  return kpis + \`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">\${ageCard}\${posCard}</div>\` + valCard;
}`;

// 5. tiOpenDetail scorecard + bodyEl.innerHTML
const newDetailInner = extractBlock(srcRaw,
  '    // Scorecard from ranking engine (already loaded, no extra API call)',
  '    bodyEl.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;">${stageTrack}</div>${statsGrid}${scorecardHTML}${mvTable}${repsHTML}${ctBlock}<div style="margin-top:12px;">${advBtns}</div>`;'
);

const oldDetailInner =
  `    // Pipeline advance buttons
    var advBtns = '';
    var nextStageMap = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION' };
    var nextS = nextStageMap[target.stage];
    if (nextS) advBtns = \`<button class="btn btn-primary btn-sm" data-action="tiAdvance" data-id="\${_esc(target.id)}" style="margin-top:12px;">⇒ Advance to \${nextS}</button> \`;
    advBtns += \`<button class="btn btn-ghost btn-sm" data-action="tiReject" data-id="\${_esc(target.id)}" style="margin-top:12px;color:var(--red);">Reject</button>\`;

    bodyEl.innerHTML = \`<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;">\${stageTrack}</div>\${statsGrid}\${mvTable}\${repsHTML}\${ctBlock}<div style="margin-top:12px;">\${advBtns}</div>\`;`;

// ── Also need old _tiDashboard and _tiTargets literally ───────────────────────

const oldDashboardLiteral =
`function _tiDashboard() {
  const T          = State.transfer;
  const active     = T.targets.filter(function(t) { return !t.archivedAt; });
  const pipe       = T.pipeline;
  const totalVal   = T.squadVal.reduce(function(s, v) { return s + (v.latestValueMEur || 0); }, 0);
  const expiringN  = T.contracts.filter(function(c) { return c.isExpiringSoon; }).length;
  const si         = T.squadIntel;

  const kpis = \`<div class="ti-kpi-row">
    <div class="ti-kpi"><div class="ti-kpi-val">\${active.length}</div><div class="ti-kpi-label">Active Targets</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">\${totalVal.toFixed(1)}M€</div><div class="ti-kpi-label">Squad Value</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">\${T.reports.length}</div><div class="ti-kpi-label">Scout Reports</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:\${expiringN > 3 ? 'var(--red)' : expiringN > 0 ? 'var(--amber)' : 'var(--green-l)'}">\${expiringN}</div><div class="ti-kpi-label">Expiring Contracts</div></div>
    \${si ? '<div class="ti-kpi"><div class="ti-kpi-val" style="color:' + (si.injuredCount > 3 ? 'var(--red)' : 'var(--amber)') + '">' + si.injuredCount + '</div><div class="ti-kpi-label">Squad Injured</div></div>' : ''}
  </div>\`;

  // Pipeline mini
  const STAGES = ['LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
  const pipeRows = STAGES.map(function(s) {
    const items = (pipe[s] || []);
    return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:12px;color:var(--tx-2);">\${s}</span>
      <span style="font-size:13px;font-weight:700;color:var(--tx);">\${items.length}</span>
    </div>\`;
  }).join('');
  const pipeCard = \`<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Pipeline Summary</div>
    \${pipeRows}
    <div style="margin-top:10px;text-align:right;">
      <button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="pipeline">Full Pipeline →</button>
    </div>
  </div>\`;

  // Top 5 priority targets
  const sorted = active.slice().sort(function(a, b) { return (b.priorityScore || 0) - (a.priorityScore || 0); });
  const topRows = sorted.slice(0, 5).map(function(t) {
    var name = _esc(_scoutPlayerName(t.playerId));
    var club = _esc(t.currentClubName || '—');
    var pri  = t.priorityScore != null ? t.priorityScore : '?';
    return \`<div class="ti-target-row" data-action="tiOpenDetail" data-id="\${_esc(t.id)}"
      style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--tx);">\${name || t.playerId.substring(0,8)+'…'}</div>
        <div style="font-size:11px;color:var(--tx-3);">\${club} • \${_esc(t.stage)}</div>
      </div>
      <div style="font-size:13px;font-weight:700;color:var(--accent);">\${pri}</div>
    </div>\`;
  }).join('') || '<div style="color:var(--tx-3);font-size:13px;padding:12px 0;">No active targets yet.</div>';

  const topCard = \`<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Top Priority Targets</div>
    \${topRows}
    <div style="margin-top:10px;text-align:right;">
      <button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="targets">All targets →</button>
    </div>
  </div>\`;

  // Recent reports
  const recentReps = T.reports.slice(0, 4).map(function(r) {
    var name = _esc(_scoutPlayerName(r.playerId));
    var grade = r.overallGrade || '—';
    var rec   = r.recommendation || '';
    var gradeColor = grade.startsWith('A') ? 'var(--green-l)' : grade === 'B_PLUS' ? '#60a5fa' : grade === 'B' ? 'var(--amber)' : 'var(--tx-3)';
    return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-size:13px;color:var(--tx);">\${name || r.playerId.substring(0,8)+'…'}</div>
        <div style="font-size:11px;color:var(--tx-3);">\${_esc(rec)}</div>
      </div>
      <span style="font-size:12px;font-weight:700;color:\${gradeColor};">\${_esc(grade.replace('_PLUS','+'))}</span>
    </div>\`;
  }).join('') || '<div style="color:var(--tx-3);font-size:13px;padding:8px 0;">No reports yet.</div>';

  const repCard = \`<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Recent Scout Reports</div>
    \${recentReps}
    <div style="margin-top:10px;text-align:right;">
      <button class="btn btn-ghost btn-xs" data-action="tiSwitchTab" data-tab="compare">Compare players →</button>
    </div>
  </div>\`;

  return kpis + \`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;">\${pipeCard}\${topCard}</div>\` + repCard;
}`;

const oldTargetsLiteral =
`function _tiTargets() {
  const T     = State.transfer;
  const q     = (T._search || '').toLowerCase();
  const stage = T._stageFilter || '';
  var items   = T.targets.filter(function(t) { return !t.archivedAt; });
  if (q)     items = items.filter(function(t) { return (_scoutPlayerName(t.playerId)||'').toLowerCase().includes(q) || (t.currentClubName||'').toLowerCase().includes(q); });
  if (stage) items = items.filter(function(t) { return t.stage === stage; });
  items.sort(function(a, b) { return (b.priorityScore || 0) - (a.priorityScore || 0); });

  const STAGES = ['', 'LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
  const stageOpts = STAGES.map(function(s) {
    return \`<option value="\${s}" \${stage === s ? 'selected' : ''}>\${s || 'All Stages'}</option>\`;
  }).join('');

  const controls = \`<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
    <input class="form-input" style="flex:1;min-width:180px;" placeholder="Search player or club…"
      value="\${_esc(T._search||'')}"
      oninput="State.transfer._search=this.value;tiRenderTab();">
    <select class="form-input" style="min-width:140px;" onchange="State.transfer._stageFilter=this.value;tiRenderTab();">\${stageOpts}</select>
  </div>\`;

  if (!items.length) return controls + '<div style="color:var(--tx-3);font-size:13px;padding:20px 0;text-align:center;">No targets match filter.</div>';

  const rows = items.map(function(t) {
    var name    = _esc(_scoutPlayerName(t.playerId));
    var pos     = _esc(t.position || _scoutPlayerPos(t.playerId) || '—');
    var club    = _esc(t.currentClubName || '—');
    var price   = t.askingPriceMEur != null ? t.askingPriceMEur + 'M€' : '—';
    var valEntry = T.squadVal.find(function(v) { return v.playerId === t.playerId; });
    var val     = valEntry ? valEntry.latestValueMEur + 'M€' : '—';
    var pri     = t.priorityScore != null ? t.priorityScore : '?';
    var stageColor = {LONGLIST:'var(--tx-3)',SHORTLIST:'#60a5fa',APPROACH:'var(--amber)',NEGOTIATION:'var(--green-l)'}[t.stage] || 'var(--tx-3)';
    return \`<div class="ti-target-row" data-action="tiOpenDetail" data-id="\${_esc(t.id)}"
      style="display:grid;grid-template-columns:1fr auto;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:6px;transition:background .15s;"
      onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background=''">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--tx);">\${name || t.playerId.substring(0,8)+'…'} <span style="font-size:11px;color:var(--tx-3);">\${pos}</span></div>
        <div style="font-size:11px;color:var(--tx-3);margin-top:2px;">\${club} • Ask: \${price} • Mkt: \${val}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:11px;font-weight:700;color:\${stageColor};margin-bottom:3px;">\${_esc(t.stage)}</div>
        <div style="font-size:11px;color:var(--tx-3);">pri \${pri}</div>
      </div>
    </div>\`;
  }).join('');

  return controls + \`<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;">\${rows}</div>\`;
}`;

// ── Build final new strings from app.js by extracting complete functions ──────

const newDashboardFull = extractBlock(srcRaw,
  'function _tiDashboard() {\n  const T          = State.transfer;\n  const active     = T.targets.filter',
  "\n  return kpis + `<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:4px;\">${pipeCard}${topCard}</div>` + depthCard + repCard;\n}"
);

const newTargetsFull = extractBlock(srcRaw,
  'function _tiTargets() {\n  const T     = State.transfer;\n  const q     = (T._search || \'\').toLowerCase();',
  "\n  return controls + `<div style=\"border:1px solid var(--border);border-radius:8px;overflow:hidden;\">${rows}</div>`;\n}"
);

const newMarketReturnLine =
  `  return kpis + \`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">\${ageCard}\${posCard}</div>\` + valCard + mktOppCard + sqDepthCard;\n}`;

// ── Apply all replacements to each mirror ─────────────────────────────────────

const REPLACEMENTS = [
  // 1. loadTransferData fetch block
  [oldFetchBlock, newFetchBlock],

  // 2. _tiDashboard full function
  [oldDashboardLiteral, newDashboardFull],

  // 3. _tiTargets full function
  [oldTargetsLiteral, newTargetsFull],

  // 4. _tiMarket last line + closing brace
  [
    `  return kpis + \`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">\${ageCard}\${posCard}</div>\` + valCard;\n}`,
    newMarketReturnLine
  ],

  // 5. tiOpenDetail scorecard + bodyEl.innerHTML
  [oldDetailInner, newDetailInner],
];

let errors = 0;
for (const mirrorPath of MIRRORS) {
  console.log('\nProcessing: ' + path.basename(mirrorPath));
  try {
    replaceInMirror(mirrorPath, REPLACEMENTS);
    console.log('  ✅ Done');
  } catch (err) {
    console.error('  ❌ ERROR: ' + err.message);
    errors++;
  }
}

console.log('\n' + (errors === 0 ? '✅ All mirrors synced OK' : '❌ ' + errors + ' mirror(s) failed'));
process.exit(errors > 0 ? 1 : 0);
