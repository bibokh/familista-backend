'use strict';
var fs = require('fs');
var path = require('path');

var appJsPath = path.join(__dirname, 'public', 'app.js');
var src = fs.readFileSync(appJsPath, 'utf8');

// ─── Find the exact old transfer block to replace ────────────────────────────
var OLD_START = '// ══════════════════════════════════════════════════════════════════════════════\n// TRANSFER INTELLIGENCE — Phase Q';
var OLD_END   = '// END TRANSFER INTELLIGENCE\n// ══════════════════════════════════════════════════════════════════════════════';

var si = src.indexOf(OLD_START);
var ei = src.indexOf(OLD_END, si);
if (si < 0 || ei < 0) { console.error('Transfer section boundaries not found'); process.exit(1); }
ei += OLD_END.length;
// consume trailing newline if present
if (src[ei] === '\n') ei++;

var before = src.slice(0, si);
var after  = src.slice(ei);

// ─── New transfer section ─────────────────────────────────────────────────────
var NEW_SECTION = `// ══════════════════════════════════════════════════════════════════════════════
// TRANSFER INTELLIGENCE CENTER — Phase 9
// APIs (all under /api/v1/phase-q/transfer/):
//   GET  targets?limit=200           — active + archived targets
//   GET  pipeline                    — kanban board by stage
//   GET  reports?limit=100           — scouting reports
//   GET  contracts-expiring          — contracts expiring within 180d
//   GET  market-values/squad         — squad valuation summary
//   GET  intelligence/squad          — age/position/wage/valuation analysis
//   GET  intelligence/player/:id     — cross-module player profile
//   POST targets                     — add target
//   POST targets/:id/advance         — advance pipeline stage
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers (hoisted — available to stats/workload sections above) ─────────────

function _scoutPlayerName(playerId) {
  var p = (State.players || []).find(function(pl) { return pl.id === playerId; });
  return p ? (p.firstName + ' ' + p.lastName) : '';
}
function _scoutPlayerPos(playerId) {
  var p = (State.players || []).find(function(pl) { return pl.id === playerId; });
  return p ? (p.position || '') : '';
}

// ── State ────────────────────────────────────────────────────────────────────

// State.transfer is initialised in the global State object elsewhere.
// Keys used: targets, pipeline, reports, contracts, squadVal, squadIntel,
//            _loading, _tab, _search, _stageFilter, _recFilter, _playerIntel

// ── HTML Skeleton ─────────────────────────────────────────────────────────────

function renderTransferHTML() {
  return \`<div class="page" id="pg-transfer">
  <div class="ti-page">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--tx);">Transfer Intelligence Center</div>
        <div style="font-size:12px;color:var(--tx-3);" id="ti-sub">Loading…</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" data-action="tiRefresh">&#8635; Refresh</button>
        <button class="btn btn-primary btn-sm" data-action="tiOpenAddTarget">+ Add Target</button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="ti-tabs" style="display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="ti-tab active" id="titab-dashboard"  data-action="tiSwitchTab" data-tab="dashboard">Dashboard</button>
      <button class="ti-tab"        id="titab-targets"    data-action="tiSwitchTab" data-tab="targets">Targets</button>
      <button class="ti-tab"        id="titab-market"     data-action="tiSwitchTab" data-tab="market">Market Intel</button>
      <button class="ti-tab"        id="titab-contracts"  data-action="tiSwitchTab" data-tab="contracts">Contracts</button>
      <button class="ti-tab"        id="titab-pipeline"   data-action="tiSwitchTab" data-tab="pipeline">Pipeline</button>
      <button class="ti-tab"        id="titab-video"      data-action="tiSwitchTab" data-tab="video">Video+Analytics</button>
      <button class="ti-tab"        id="titab-compare"    data-action="tiSwitchTab" data-tab="compare">Compare</button>
    </div>

    <!-- Tab content -->
    <div id="ti-content"></div>

    <!-- Detail modal -->
    <div id="ti-detail-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;overflow-y:auto;">
      <div style="max-width:700px;margin:48px auto;background:var(--surface);border-radius:12px;padding:24px;position:relative;">
        <button data-action="tiCloseDetail" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--tx-2);">&#x2715;</button>
        <div id="ti-detail-name" style="font-size:16px;font-weight:700;color:var(--tx);margin-bottom:16px;"></div>
        <div id="ti-detail-body" style="color:var(--tx-2);font-size:13px;"></div>
      </div>
    </div>

    <!-- Add-target modal -->
    <div id="ti-add-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;overflow-y:auto;">
      <div style="max-width:500px;margin:48px auto;background:var(--surface);border-radius:12px;padding:24px;position:relative;">
        <button data-action="tiCloseAddTarget" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--tx-2);">&#x2715;</button>
        <div style="font-size:15px;font-weight:700;color:var(--tx);margin-bottom:16px;">Add Transfer Target</div>
        <form id="ti-add-form" data-form-submit="tiSubmitAddTarget">
          <div style="display:grid;gap:12px;">
            <div>
              <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Player *</label>
              <select id="tia-player" class="form-input" style="width:100%;" required>
                <option value="">— select player —</option>
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Current Club</label>
                <input id="tia-club" class="form-input" placeholder="e.g. Real Madrid" style="width:100%;">
              </div>
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Position</label>
                <input id="tia-pos" class="form-input" placeholder="e.g. CM" style="width:100%;">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Asking Price (M€)</label>
                <input id="tia-price" type="number" step="0.1" min="0" class="form-input" placeholder="0.0" style="width:100%;">
              </div>
              <div>
                <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Priority (0–100)</label>
                <input id="tia-priority" type="number" min="0" max="100" class="form-input" placeholder="50" style="width:100%;">
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Nationality</label>
              <input id="tia-nat" class="form-input" placeholder="e.g. Spanish" style="width:100%;">
            </div>
            <div>
              <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Notes</label>
              <textarea id="tia-notes" class="form-input" rows="2" style="width:100%;resize:vertical;"></textarea>
            </div>
            <div id="tia-error" style="display:none;color:var(--red);font-size:12px;"></div>
            <div style="display:flex;justify-content:flex-end;gap:8px;">
              <button type="button" data-action="tiCloseAddTarget" class="btn btn-ghost btn-sm">Cancel</button>
              <button type="submit" id="tia-submit" class="btn btn-primary btn-sm">Add to Pipeline</button>
            </div>
          </div>
        </form>
      </div>
    </div>

  </div>
</div>\`;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadTransferData() {
  if (State.transfer._loading) return;
  State.transfer._loading = true;

  const content = document.getElementById('ti-content');
  if (content) content.innerHTML = loadingHTML('Loading transfer data…');

  const [targRes, pipeRes, repRes, contrRes, valRes, sqRes] = await Promise.allSettled([
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
  State.transfer.squadIntel = (sqRes.status    === 'fulfilled' && sqRes.value)                          ? sqRes.value          : null;

  const active = State.transfer.targets.filter(function(t) { return !t.archivedAt; }).length;
  const subEl  = document.getElementById('ti-sub');
  if (subEl) subEl.textContent = active + ' active target' + (active !== 1 ? 's' : '') + ' \xb7 ' + State.transfer.reports.length + ' scout reports';

  State.transfer._loading = false;
  tiRenderTab();
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function tiSwitchTab(tab) {
  State.transfer._tab = tab;
  document.querySelectorAll('.ti-tab').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  tiRenderTab();
}

function tiRenderTab() {
  const el = document.getElementById('ti-content');
  if (!el) return;
  switch (State.transfer._tab) {
    case 'dashboard': el.innerHTML = _tiDashboard();      break;
    case 'targets':   el.innerHTML = _tiTargets();        break;
    case 'market':    el.innerHTML = _tiMarket();         break;
    case 'contracts': el.innerHTML = _tiContracts();      break;
    case 'pipeline':  el.innerHTML = _tiPipeline();       break;
    case 'video':     el.innerHTML = _tiVideoAnalytics(); break;
    case 'compare':   el.innerHTML = _tiCompare();        break;
    default:          el.innerHTML = _tiDashboard();
  }
}

// ── SCREEN 1: Dashboard ───────────────────────────────────────────────────────

function _tiDashboard() {
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
}

// ── SCREEN 2: Targets ─────────────────────────────────────────────────────────

function _tiTargets() {
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
}

// ── SCREEN 3: Market Intelligence ─────────────────────────────────────────────

function _tiMarket() {
  const si = State.transfer.squadIntel;
  if (!si) {
    return \`<div style="color:var(--tx-3);font-size:13px;padding:32px;text-align:center;">
      Squad intelligence not available. <button class="btn btn-ghost btn-xs" data-action="tiRefresh">Retry</button>
    </div>\`;
  }

  // Squad overview KPIs
  const wageBillM = (si.annualWageBillEur / 1_000_000).toFixed(1);
  const kpis = \`<div class="ti-kpi-row" style="margin-bottom:16px;">
    <div class="ti-kpi"><div class="ti-kpi-val">\${si.squadSize}</div><div class="ti-kpi-label">Squad Size</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">\${si.totalSquadValueMEur.toFixed(1)}M€</div><div class="ti-kpi-label">Total Squad Value</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val">\${wageBillM}M€</div><div class="ti-kpi-label">Annual Wage Bill</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:\${si.injuredCount > 3 ? 'var(--red)' : 'var(--amber)'}">\${si.injuredCount}</div><div class="ti-kpi-label">Injured</div></div>
    <div class="ti-kpi"><div class="ti-kpi-val" style="color:var(--red)">\${si.expiringContracts.length}</div><div class="ti-kpi-label">Contracts Expiring (1yr)</div></div>
  </div>\`;

  // Age distribution
  const ageBands = si.ageBands || {};
  const ageRows  = Object.entries(ageBands).map(function(entry) {
    var band = entry[0]; var cnt = entry[1];
    var pct = si.squadSize > 0 ? Math.round(cnt / si.squadSize * 100) : 0;
    return \`<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--tx-2);margin-bottom:3px;">
        <span>\${band}</span><span>\${cnt} players (\${pct}%)</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:\${pct}%;background:var(--accent);border-radius:3px;"></div>
      </div>
    </div>\`;
  }).join('');
  const ageCard = \`<div class="ti-card">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Age Distribution</div>
    \${ageRows}
  </div>\`;

  // Position distribution
  const posEntries = Object.entries(si.positionCounts || {});
  posEntries.sort(function(a, b) { return b[1] - a[1]; });
  const maxPos = posEntries.reduce(function(m, e) { return Math.max(m, e[1]); }, 0);
  const posRows = posEntries.map(function(entry) {
    var pos = entry[0]; var cnt = entry[1];
    var pct = maxPos > 0 ? Math.round(cnt / maxPos * 100) : 0;
    return \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <div style="width:80px;font-size:11px;color:var(--tx-2);text-align:right;flex-shrink:0;">\${pos}</div>
      <div style="flex:1;height:14px;background:var(--border);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:\${pct}%;background:var(--accent-2,#60a5fa);border-radius:3px;display:flex;align-items:center;padding-left:4px;">
          <span style="font-size:10px;font-weight:700;color:#fff;">\${cnt}</span>
        </div>
      </div>
    </div>\`;
  }).join('');
  const posCard = \`<div class="ti-card">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Position Counts</div>
    \${posRows || '<div style="color:var(--tx-3);font-size:12px;">No data.</div>'}
  </div>\`;

  // Top valuations
  const topVals = (si.valuations || []).slice(0,8).map(function(v) {
    var name = _esc(_scoutPlayerName(v.playerId));
    return \`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">
      <span style="color:var(--tx);">\${name || v.playerId.substring(0,10)+'…'}</span>
      <span style="font-weight:700;color:var(--green-l);">\${(v.latestValueMEur||0).toFixed(1)}M€</span>
    </div>\`;
  }).join('');
  const valCard = \`<div class="ti-card" style="margin-top:16px;">
    <div style="font-size:12px;font-weight:600;color:var(--tx-2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em;">Top Valued Players</div>
    \${topVals || '<div style="color:var(--tx-3);font-size:12px;">No valuations recorded.</div>'}
  </div>\`;

  return kpis + \`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">\${ageCard}\${posCard}</div>\` + valCard;
}

// ── SCREEN 4: Contract Center ─────────────────────────────────────────────────

function _tiContracts() {
  const T = State.transfer;
  const contracts = T.contracts.slice().sort(function(a, b) {
    return new Date(a.contractExpiry) - new Date(b.contractExpiry);
  });

  if (!contracts.length) return '<div style="color:var(--tx-3);font-size:13px;padding:20px;text-align:center;">No expiring contracts found (within 180 days).</div>';

  const today = new Date();
  const rows = contracts.map(function(c) {
    var name     = _esc(_scoutPlayerName(c.playerId));
    var expiry   = new Date(c.contractExpiry);
    var daysLeft = Math.floor((expiry - today) / 86400000);
    var urgColor = daysLeft < 60 ? 'var(--red)' : daysLeft < 120 ? 'var(--amber)' : 'var(--tx-2)';
    var expStr   = expiry.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'});
    var valStr   = c.contractValueEur ? '€' + (c.contractValueEur / 1000).toFixed(0) + 'k/yr' : '—';
    var clauseStr = c.releaseClauseEur ? '€' + (c.releaseClauseEur / 1_000_000).toFixed(1) + 'M' : '—';
    var agent    = _esc(c.agentName || '—');
    var status   = c.isAvailableForTransfer ? '<span style="color:var(--green-l);font-size:10px;font-weight:700;">AVAILABLE</span>' :
                   c.isExpiringSoon         ? '<span style="color:var(--amber);font-size:10px;font-weight:700;">EXPIRING SOON</span>' : '';
    return \`<tr>
      <td style="padding:8px 6px;font-size:13px;font-weight:600;color:var(--tx);">\${name || c.playerId.substring(0,8)+'…'}</td>
      <td style="padding:8px 6px;font-size:12px;color:\${urgColor};font-weight:700;">\${expStr}</td>
      <td style="padding:8px 6px;font-size:12px;color:\${urgColor};font-weight:700;">\${daysLeft}d</td>
      <td style="padding:8px 6px;font-size:12px;color:var(--tx-2);">\${valStr}</td>
      <td style="padding:8px 6px;font-size:12px;color:var(--tx-2);">\${clauseStr}</td>
      <td style="padding:8px 6px;font-size:12px;color:var(--tx-3);">\${agent}</td>
      <td style="padding:8px 6px;">\${status}</td>
    </tr>\`;
  }).join('');

  return \`<div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);">
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Player</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Expiry</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Days Left</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Value/yr</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Release Clause</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Agent</th>
          <th style="text-align:left;padding:6px;color:var(--tx-3);font-weight:600;">Status</th>
        </tr>
      </thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

// ── SCREEN 5: Pipeline (Kanban) ───────────────────────────────────────────────

function _tiPipeline() {
  const T      = State.transfer;
  const pipe   = T.pipeline;
  const STAGES = ['LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
  const STAGE_COLORS = { LONGLIST:'var(--tx-3)', SHORTLIST:'#60a5fa', APPROACH:'var(--amber)', NEGOTIATION:'var(--green-l)' };
  const NEXT_STAGE   = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION', NEGOTIATION:null };

  const cols = STAGES.map(function(stage) {
    var items  = (pipe[stage] || []);
    var color  = STAGE_COLORS[stage];
    var nextS  = NEXT_STAGE[stage];
    var cards  = items.length
      ? items.map(function(t) {
          var name  = _esc(_scoutPlayerName(t.playerId));
          var club  = _esc(t.currentClubName || '');
          var price = t.askingPriceMEur != null ? t.askingPriceMEur + 'M€' : '';
          var btns  = '';
          if (nextS) btns += \`<button class="btn btn-ghost btn-xs" data-action="tiAdvance" data-id="\${_esc(t.id)}" style="font-size:10px;">⇒ \${nextS.substring(0,3)}</button> \`;
          btns += \`<button class="btn btn-ghost btn-xs" data-action="tiReject" data-id="\${_esc(t.id)}" style="font-size:10px;color:var(--red);">Reject</button>\`;
          return \`<div style="background:var(--surface-2);border-radius:6px;padding:10px;margin-bottom:8px;border:1px solid var(--border);">
            <div style="font-size:12px;font-weight:700;color:var(--tx);margin-bottom:3px;">\${name || t.playerId.substring(0,8)+'…'}</div>
            \${club ? '<div style="font-size:10px;color:var(--tx-3);margin-bottom:3px;">' + club + '</div>' : ''}
            \${price ? '<div style="font-size:10px;color:var(--amber);">' + price + '</div>' : ''}
            <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">\${btns}</div>
          </div>\`;
        }).join('')
      : '<div style="color:var(--tx-3);font-size:11px;text-align:center;padding:16px;">Empty</div>';

    return \`<div style="flex:1;min-width:180px;">
      <div style="font-size:11px;font-weight:700;color:\${color};text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid \${color};">
        \${stage} <span style="font-weight:400;color:var(--tx-3);">(\${items.length})</span>
      </div>
      \${cards}
    </div>\`;
  }).join('');

  return \`<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;">\${cols}</div>\`;
}

// ── SCREEN 6: Video + Analytics ───────────────────────────────────────────────

function _tiVideoAnalytics() {
  const players = (State.players || []).slice().sort(function(a, b) {
    return (a.firstName + ' ' + a.lastName).localeCompare(b.firstName + ' ' + b.lastName);
  });
  const opts = players.map(function(p) {
    return \`<option value="\${_esc(p.id)}">\${_esc(p.firstName + ' ' + p.lastName)} (\${_esc(p.position || '?')})</option>\`;
  }).join('');

  const intel = State.transfer._playerIntel;

  var intelHTML = '';
  if (intel && !intel._loading) {
    // Scouting reports summary
    var reps     = (intel.reports && intel.reports.items) ? intel.reports.items : [];
    var avgScore = reps.length ? (reps.reduce(function(s, r) { return s + (r.compositeScore || 0); }, 0) / reps.length).toFixed(1) : null;
    var recounts = {};
    reps.forEach(function(r) { recounts[r.recommendation] = (recounts[r.recommendation] || 0) + 1; });
    var recStr = Object.entries(recounts).map(function(e) { return e[0] + ': ' + e[1]; }).join(', ');

    // Contract
    var ct = intel.contract;
    var ctHTML = ct
      ? \`<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Contract</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div style="color:var(--tx-2);">Expiry</div><div style="color:var(--tx);">\${new Date(ct.contractExpiry).toLocaleDateString('en-GB')}</div>
            <div style="color:var(--tx-2);">Annual Value</div><div style="color:var(--tx);">\${ct.contractValueEur ? '€' + (ct.contractValueEur/1000).toFixed(0) + 'k' : '—'}</div>
            <div style="color:var(--tx-2);">Release Clause</div><div style="color:var(--tx);">\${ct.releaseClauseEur ? '€' + (ct.releaseClauseEur/1e6).toFixed(1) + 'M' : '—'}</div>
            <div style="color:var(--tx-2);">Agent</div><div style="color:var(--tx);">\${_esc(ct.agentName || '—')}</div>
          </div>
          \${ct.isExpiringSoon ? '<div style="margin-top:8px;padding:6px;background:rgba(251,191,36,.15);border-radius:4px;font-size:11px;color:var(--amber);font-weight:600;">⚠ Expiring Soon</div>' : ''}
        </div>\`
      : '';

    // Medical
    var med = intel.medical;
    var medHTML = med
      ? \`<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Medical Profile</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div style="color:var(--tx-2);">Active Injuries</div>
            <div style="color:\${(med.injuries||[]).filter(function(i){return !i.returnDate;}).length > 0 ? 'var(--red)' : 'var(--green-l)'};">\${(med.injuries||[]).filter(function(i){return !i.returnDate;}).length}</div>
            <div style="color:var(--tx-2);">Injury History</div>
            <div style="color:var(--tx);">\${(med.injuries||[]).length} recorded</div>
          </div>
        </div>\`
      : '';

    // Video clips
    var clips = (intel.clips && intel.clips.items) ? intel.clips.items.slice(0,5) : [];
    var clipsHTML = clips.length
      ? \`<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Video Clips (\${intel.clips.total})</div>
          \${clips.map(function(cl) {
              return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">'
                + '<span style="color:var(--tx);">' + _esc(cl.title || 'Clip') + '</span>'
                + '<span style="color:var(--tx-3);">' + _esc(cl.clipType || '') + '</span>'
                + '</div>';
            }).join('')}
        </div>\`
      : '';

    // Market value history
    var mvHistory = (intel.marketHistory || []).slice(-6);
    var mvHTML = mvHistory.length
      ? \`<div class="ti-card" style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Market Value History</div>
          \${mvHistory.map(function(h) {
              return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">'
                + '<span style="color:var(--tx-2);">' + new Date(h.valuationDate).toLocaleDateString('en-GB', {month:'short',year:'2-digit'}) + '</span>'
                + '<span style="font-weight:700;color:var(--green-l);">' + (h.valueMEur||0).toFixed(2) + 'M€</span>'
                + '<span style="color:var(--tx-3);font-size:10px;">' + _esc(h.source||'') + '</span>'
                + '</div>';
            }).join('')}
        </div>\`
      : '';

    var scoutCard = \`<div class="ti-card">
      <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:8px;text-transform:uppercase;">Scouting Intelligence</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div class="ti-kpi" style="padding:8px;"><div class="ti-kpi-val">\${reps.length}</div><div class="ti-kpi-label">Reports</div></div>
        <div class="ti-kpi" style="padding:8px;"><div class="ti-kpi-val">\${avgScore || '—'}</div><div class="ti-kpi-label">Avg Score</div></div>
        <div class="ti-kpi" style="padding:8px;"><div class="ti-kpi-val" style="font-size:10px;">\${recStr || '—'}</div><div class="ti-kpi-label">Recommendations</div></div>
      </div>
    </div>\`;

    intelHTML = scoutCard + ctHTML + medHTML + mvHTML + clipsHTML;
  } else if (intel && intel._loading) {
    intelHTML = loadingHTML('Loading player intelligence…');
  }

  return \`<div style="margin-bottom:16px;">
    <label style="font-size:12px;color:var(--tx-2);display:block;margin-bottom:6px;">Select player for cross-module intelligence card:</label>
    <div style="display:flex;gap:8px;align-items:center;">
      <select id="ti-intel-player" class="form-input" style="flex:1;">
        <option value="">— select player —</option>
        \${opts}
      </select>
      <button class="btn btn-primary btn-sm" data-action="tiLoadPlayerIntel">Load Profile</button>
    </div>
  </div>
  \${intelHTML}\`;
}

// ── SCREEN 7: Advanced Compare ────────────────────────────────────────────────

function _tiCompare() {
  const T       = State.transfer;
  const players = (State.players || []).slice().sort(function(a, b) {
    return (a.firstName + ' ' + a.lastName).localeCompare(b.firstName + ' ' + b.lastName);
  });

  const makeOpts = function(selectedId) {
    return '<option value="">— select —</option>'
      + players.map(function(p) {
        return '<option value="' + _esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>'
          + _esc(p.firstName + ' ' + p.lastName) + ' (' + _esc(p.position || '?') + ')</option>';
      }).join('');
  };

  var controls = \`<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;margin-bottom:16px;">
    <div>
      <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Player A</label>
      <select id="ti-cmp-a" class="form-input" style="width:100%;">\${makeOpts(T._compareA)}</select>
    </div>
    <div>
      <label style="font-size:11px;color:var(--tx-3);display:block;margin-bottom:4px;">Player B</label>
      <select id="ti-cmp-b" class="form-input" style="width:100%;">\${makeOpts(T._compareB)}</select>
    </div>
    <button class="btn btn-primary btn-sm" data-action="tiRunCompare">Compare</button>
  </div>\`;

  const result = T._compareResult;
  if (!result) return controls + '<div style="color:var(--tx-3);font-size:13px;text-align:center;padding:24px 0;">Select two players and click Compare.</div>';

  const ATTRS = ['technical','physical','mental','tactical','potential'];

  const buildCol = function(label, reports, contracts, marketHistory) {
    var reps = reports ? reports.items || [] : [];
    var avgGrades = {};
    ATTRS.forEach(function(k) {
      var vals = reps.map(function(r) { return r[k]; }).filter(function(v) { return v != null; });
      avgGrades[k] = vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length : null;
    });
    var composite = reps.length ? (reps.reduce(function(s, r) { return s + (r.compositeScore || 0); }, 0) / reps.length).toFixed(1) : null;

    var bars = ATTRS.map(function(k) {
      var v = avgGrades[k];
      var pct = v != null ? Math.round(v / 10 * 100) : 0;
      var c   = v >= 8 ? 'var(--green-l)' : v >= 6 ? '#60a5fa' : v >= 4 ? 'var(--amber)' : 'var(--red)';
      return \`<div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
          <span style="color:var(--tx-2);">\${k}</span>
          <span style="color:var(--tx);font-weight:700;">\${v != null ? v.toFixed(1) : '—'}</span>
        </div>
        <div style="height:6px;background:var(--border);border-radius:3px;">
          <div style="height:100%;width:\${pct}%;background:\${c};border-radius:3px;transition:width .4s;"></div>
        </div>
      </div>\`;
    }).join('');

    var ct = contracts;
    var latestVal = marketHistory && marketHistory.length ? marketHistory[marketHistory.length - 1].valueMEur : null;

    return \`<div style="flex:1;">
      <div style="font-size:14px;font-weight:700;color:var(--tx);margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid var(--accent);">\${label}</div>
      <div class="ti-kpi-row" style="margin-bottom:16px;">
        <div class="ti-kpi"><div class="ti-kpi-val">\${reps.length}</div><div class="ti-kpi-label">Reports</div></div>
        <div class="ti-kpi"><div class="ti-kpi-val">\${composite || '—'}</div><div class="ti-kpi-label">Avg Score</div></div>
        <div class="ti-kpi"><div class="ti-kpi-val">\${latestVal != null ? latestVal.toFixed(1) + 'M€' : '—'}</div><div class="ti-kpi-label">Market Value</div></div>
      </div>
      \${bars}
      \${ct ? \`<div style="font-size:11px;color:var(--tx-3);margin-top:8px;">Contract until: \${new Date(ct.contractExpiry).toLocaleDateString('en-GB')} \${ct.isExpiringSoon ? '⚠ Expiring soon' : ''}</div>\` : ''}
    </div>\`;
  };

  const a = result.a; const b = result.b;
  const aCol = buildCol(_esc(_scoutPlayerName(a.playerId)), a.reports, a.contract, a.marketHistory);
  const bCol = buildCol(_esc(_scoutPlayerName(b.playerId)), b.reports, b.contract, b.marketHistory);

  return controls + \`<div style="display:flex;gap:24px;">\${aCol}\${bCol}</div>\`;
}

// ── Modal: Player Detail ──────────────────────────────────────────────────────

async function tiOpenDetail(targetId) {
  const modal    = document.getElementById('ti-detail-modal');
  const nameEl   = document.getElementById('ti-detail-name');
  const bodyEl   = document.getElementById('ti-detail-body');
  if (!modal || !bodyEl) return;

  const target = State.transfer.targets.find(function(t) { return t.id === targetId; });
  if (!target) return;

  const playerName = _scoutPlayerName(target.playerId);
  if (nameEl) nameEl.textContent = playerName || target.playerId;
  bodyEl.innerHTML = loadingHTML('Loading player intelligence…');
  modal.style.display = 'block';

  try {
    const intel = await FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + target.playerId);
    const reps       = intel.reports ? intel.reports.items || [] : [];
    const history    = intel.marketHistory || [];
    const contract   = intel.contract;

    // Stage tracker
    const STAGES = ['LONGLIST','SHORTLIST','APPROACH','NEGOTIATION'];
    const currentIdx = STAGES.indexOf(target.stage);
    const stageTrack = STAGES.map(function(s, i) {
      var done = i < currentIdx; var current = i === currentIdx;
      return \`<div style="display:flex;align-items:center;gap:4px;">
        <div style="width:10px;height:10px;border-radius:50%;background:\${current ? 'var(--accent)' : done ? 'var(--green-l)' : 'var(--border)'};flex-shrink:0;"></div>
        <span style="font-size:10px;color:\${current ? 'var(--accent)' : done ? 'var(--green-l)' : 'var(--tx-3)'};">\${s}</span>
        \${i < STAGES.length - 1 ? '<div style="flex:1;height:1px;background:var(--border);margin:0 4px;"></div>' : ''}
      </div>\`;
    }).join('');

    // Key stats grid
    var latestVal = history.length ? history[history.length - 1].valueMEur : null;
    var statsGrid = \`<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0;">
      <div class="ti-kpi"><div class="ti-kpi-val">\${target.askingPriceMEur != null ? target.askingPriceMEur + 'M€' : '—'}</div><div class="ti-kpi-label">Asking Price</div></div>
      <div class="ti-kpi"><div class="ti-kpi-val">\${latestVal != null ? latestVal.toFixed(1) + 'M€' : '—'}</div><div class="ti-kpi-label">Market Value</div></div>
      <div class="ti-kpi"><div class="ti-kpi-val">\${target.priorityScore != null ? target.priorityScore : '—'}</div><div class="ti-kpi-label">Priority</div></div>
    </div>\`;

    // Market history table
    var mvTable = history.length
      ? \`<div style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:6px;text-transform:uppercase;">Market Value History</div>
          \${history.slice(-5).map(function(h) {
            return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">'
              + '<span style="color:var(--tx-2);">' + new Date(h.valuationDate).toLocaleDateString('en-GB',{month:'short',year:'numeric'}) + '</span>'
              + '<span style="font-weight:700;color:var(--green-l);">' + (h.valueMEur||0).toFixed(2) + 'M€</span>'
              + '<span style="color:var(--tx-3);font-size:10px;">' + _esc(h.source||'') + '</span>'
              + '</div>';
          }).join('')}
        </div>\`
      : '';

    // Scouting reports
    var repsHTML = reps.length
      ? \`<div style="margin-top:12px;">
          <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:6px;text-transform:uppercase;">Scout Reports (\${reps.length})</div>
          \${reps.slice(0,5).map(function(r) {
            var gColor = (r.overallGrade||'').startsWith('A') ? 'var(--green-l)' : 'var(--amber)';
            return '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between;">'
              + '<span style="color:var(--tx);">' + new Date(r.observedAt).toLocaleDateString('en-GB') + ' • ' + _esc(r.recommendation||'') + '</span>'
              + '<span style="font-weight:700;color:' + gColor + ';">' + _esc((r.overallGrade||'').replace('_PLUS','+')) + ' / ' + (r.compositeScore||0).toFixed(1) + '</span>'
              + '</div>';
          }).join('')}
        </div>\`
      : '<div style="color:var(--tx-3);font-size:12px;margin-top:8px;">No scouting reports.</div>';

    // Contract block
    var ctBlock = '';
    if (contract) {
      ctBlock = \`<div style="margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--tx-3);margin-bottom:6px;text-transform:uppercase;">Contract</div>
        Expiry: <strong>\${new Date(contract.contractExpiry).toLocaleDateString('en-GB')}</strong>
        \${contract.isExpiringSoon ? ' <span style="color:var(--amber);">⚠ Expiring soon</span>' : ''}
        \${contract.agentName ? ' &bull; Agent: ' + _esc(contract.agentName) : ''}
      </div>\`;
    }

    // Pipeline advance buttons
    var advBtns = '';
    var nextStageMap = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION' };
    var nextS = nextStageMap[target.stage];
    if (nextS) advBtns = \`<button class="btn btn-primary btn-sm" data-action="tiAdvance" data-id="\${_esc(target.id)}" style="margin-top:12px;">⇒ Advance to \${nextS}</button> \`;
    advBtns += \`<button class="btn btn-ghost btn-sm" data-action="tiReject" data-id="\${_esc(target.id)}" style="margin-top:12px;color:var(--red);">Reject</button>\`;

    bodyEl.innerHTML = \`<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;">\${stageTrack}</div>\${statsGrid}\${mvTable}\${repsHTML}\${ctBlock}<div style="margin-top:12px;">\${advBtns}</div>\`;
  } catch (err) {
    bodyEl.innerHTML = '<div style="color:var(--red);font-size:13px;">Failed to load player intelligence.</div>';
  }
}

function tiCloseDetail() {
  const modal = document.getElementById('ti-detail-modal');
  if (modal) modal.style.display = 'none';
}

// ── Modal: Add Target ─────────────────────────────────────────────────────────

function tiOpenAddTarget() {
  const modal  = document.getElementById('ti-add-modal');
  const select = document.getElementById('tia-player');
  if (!modal) return;

  if (select) {
    select.innerHTML = '<option value="">— select player —</option>'
      + (State.players || []).map(function(p) {
        return '<option value="' + _esc(p.id) + '">'
          + _esc(p.firstName + ' ' + p.lastName) + ' (' + _esc(p.position || '?') + ')</option>';
      }).join('');
  }

  const errEl = document.getElementById('tia-error');
  if (errEl) errEl.style.display = 'none';
  modal.style.display = 'block';
}

function tiCloseAddTarget() {
  const modal = document.getElementById('ti-add-modal');
  if (modal) modal.style.display = 'none';
}

async function tiSubmitAddTarget(e) {
  if (e) e.preventDefault();
  const errEl     = document.getElementById('tia-error');
  const submitBtn = document.getElementById('tia-submit');
  const playerId  = document.getElementById('tia-player')?.value;
  if (!playerId) {
    if (errEl) { errEl.textContent = 'Please select a player.'; errEl.style.display = 'block'; }
    return;
  }
  const priceVal    = parseFloat(document.getElementById('tia-price')?.value);
  const priorityVal = parseInt(document.getElementById('tia-priority')?.value, 10);
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }

  const body = {
    playerId,
    currentClubName: document.getElementById('tia-club')?.value?.trim()     || undefined,
    position:        document.getElementById('tia-pos')?.value?.trim()       || undefined,
    nationality:     document.getElementById('tia-nat')?.value?.trim()       || undefined,
    askingPriceMEur: isNaN(priceVal)    ? undefined : priceVal,
    priorityScore:   isNaN(priorityVal) ? 50        : priorityVal,
    notes:           document.getElementById('tia-notes')?.value?.trim()     || undefined,
  };

  try {
    await FamilistaAPI.post('/phase-q/transfer/targets', body);
    tiCloseAddTarget();
    showToast(_scoutPlayerName(playerId) + ' added to pipeline', 'success');
    await loadTransferData();
  } catch (err) {
    if (errEl) { errEl.textContent = err?.userMessage || err?.message || 'Failed to add target.'; errEl.style.display = 'block'; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add to Pipeline'; }
  }
}

// ── Pipeline actions ──────────────────────────────────────────────────────────

async function tiAdvance(targetId) {
  const t = State.transfer.targets.find(function(x) { return x.id === targetId; });
  if (!t) return;
  const nextStage = { LONGLIST:'SHORTLIST', SHORTLIST:'APPROACH', APPROACH:'NEGOTIATION', NEGOTIATION:'SIGNED' }[t.stage];
  if (!nextStage) return;
  try {
    await FamilistaAPI.post('/phase-q/transfer/targets/' + targetId + '/advance', { stage: nextStage });
    showToast(_scoutPlayerName(t.playerId) + ' → ' + nextStage, 'success');
    await loadTransferData();
    tiCloseDetail();
  } catch (err) {
    showToast(err?.userMessage || 'Failed to advance stage', 'error');
  }
}

async function tiReject(targetId) {
  const t = State.transfer.targets.find(function(x) { return x.id === targetId; });
  if (!t || !confirm('Mark ' + _scoutPlayerName(t.playerId) + ' as REJECTED?')) return;
  try {
    await FamilistaAPI.post('/phase-q/transfer/targets/' + targetId + '/advance', { stage: 'REJECTED' });
    showToast(_scoutPlayerName(t.playerId) + ' rejected', 'success');
    await loadTransferData();
    tiCloseDetail();
  } catch (err) {
    showToast(err?.userMessage || 'Failed to reject', 'error');
  }
}

// ── Player Intelligence loader ────────────────────────────────────────────────

async function tiLoadPlayerIntel() {
  const sel = document.getElementById('ti-intel-player');
  if (!sel || !sel.value) { showToast('Select a player first', 'warning'); return; }
  const playerId = sel.value;

  State.transfer._playerIntel = { _loading: true, playerId };
  tiRenderTab();

  try {
    const intel = await FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + playerId);
    State.transfer._playerIntel = Object.assign({ _loading: false, playerId }, intel);
  } catch (err) {
    State.transfer._playerIntel = { _loading: false, playerId, _error: true };
  }
  tiRenderTab();
}

// ── Compare runner ────────────────────────────────────────────────────────────

async function tiRunCompare() {
  const aSel = document.getElementById('ti-cmp-a');
  const bSel = document.getElementById('ti-cmp-b');
  const aId  = aSel ? aSel.value : null;
  const bId  = bSel ? bSel.value : null;
  if (!aId || !bId || aId === bId) { showToast('Select two different players', 'warning'); return; }

  State.transfer._compareA      = aId;
  State.transfer._compareB      = bId;
  State.transfer._compareResult = null;

  try {
    const [iA, iB] = await Promise.all([
      FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + aId),
      FamilistaAPI.get('/phase-q/transfer/intelligence/player/' + bId),
    ]);
    State.transfer._compareResult = {
      a: { playerId: aId, reports: iA.reports, contract: iA.contract, marketHistory: iA.marketHistory },
      b: { playerId: bId, reports: iB.reports, contract: iB.contract, marketHistory: iB.marketHistory },
    };
  } catch (err) {
    showToast('Failed to load comparison data', 'error');
  }
  tiRenderTab();
}

// ══════════════════════════════════════════════════════════════════════════════
// END TRANSFER INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════════
`;

// ─── Inject wireStaticHandlers transfer cases ────────────────────────────────
var WIRE_BEFORE = `        case 'vidDeleteNote':       vidDeleteNote(el.dataset.match, el.dataset.id);                        break;
        default: console.warn('[delegate] Unknown action:', el.dataset.action);`;
var WIRE_AFTER  = `        case 'vidDeleteNote':       vidDeleteNote(el.dataset.match, el.dataset.id);                        break;
        // ── Transfer Intelligence Center ────────────────────────────────────────────
        case 'tiRefresh':           loadTransferData();                                                    break;
        case 'tiSwitchTab':         tiSwitchTab(el.dataset.tab);                                           break;
        case 'tiOpenDetail':        tiOpenDetail(el.dataset.id);                                           break;
        case 'tiCloseDetail':       tiCloseDetail();                                                       break;
        case 'tiOpenAddTarget':     tiOpenAddTarget();                                                     break;
        case 'tiCloseAddTarget':    tiCloseAddTarget();                                                    break;
        case 'tiSubmitAddTarget':   tiSubmitAddTarget(null);                                               break;
        case 'tiAdvance':           tiAdvance(el.dataset.id);                                              break;
        case 'tiReject':            tiReject(el.dataset.id);                                               break;
        case 'tiLoadPlayerIntel':   tiLoadPlayerIntel();                                                   break;
        case 'tiRunCompare':        tiRunCompare();                                                        break;
        default: console.warn('[delegate] Unknown action:', el.dataset.action);`;

// ─── Also fix form submit delegation ────────────────────────────────────────
var FORM_BEFORE = `      case 'submitScoutForm':    submitScoutForm(e);    break;`;
var FORM_AFTER  = `      case 'submitScoutForm':    submitScoutForm(e);    break;
      case 'tiSubmitAddTarget':  tiSubmitAddTarget(e);  break;`;

// ─── Apply all changes ────────────────────────────────────────────────────────
var result = before + NEW_SECTION + after;

if (result.indexOf(WIRE_BEFORE) < 0)  { console.error('wireStaticHandlers insertion point not found'); process.exit(1); }
result = result.replace(WIRE_BEFORE, WIRE_AFTER);

if (result.indexOf(FORM_BEFORE) < 0)  { console.error('form submit insertion point not found'); process.exit(1); }
result = result.replace(FORM_BEFORE, FORM_AFTER);

// ─── Also initialise new State.transfer keys ─────────────────────────────────
var STATE_BEFORE = `transfer:   { targets: [], pipeline: {}, reports: [], contracts: [], squadVal: [], _loading: false, _tab: 'dashboard', _search: '', _stageFilter: '', _recFilter: '' },`;
if (result.indexOf(STATE_BEFORE) >= 0) {
  result = result.replace(
    STATE_BEFORE,
    `transfer:   { targets: [], pipeline: {}, reports: [], contracts: [], squadVal: [], squadIntel: null, _playerIntel: null, _compareResult: null, _compareA: null, _compareB: null, _loading: false, _tab: 'dashboard', _search: '', _stageFilter: '', _recFilter: '' },`
  );
}

fs.writeFileSync(appJsPath, result);
console.log('app.js updated OK — lines:', result.split('\n').length);
