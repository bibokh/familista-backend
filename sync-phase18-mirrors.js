// sync-phase18-mirrors.js
// Applies Phase 18 (Predictive Intelligence) frontend changes to the 3 HTML mirrors.
// Run: node sync-phase18-mirrors.js
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const FILES = [
  path.join(ROOT, 'familista_v5.html'),
  path.join(ROOT, 'frontend', 'index.html'),
  path.join(ROOT, 'frontend', 'familista_v5.html'),
];

// Normalise line endings to LF for matching, then restore
function patch(filePath, label, fn) {
  let raw  = fs.readFileSync(filePath, 'utf8');
  const cr = raw.includes('\r\n');
  let src  = cr ? raw.replace(/\r\n/g, '\n') : raw;
  const patched = fn(src, label);
  if (patched === null) {
    console.error(`  ✗ ${label} — anchor not found`);
    return false;
  }
  const out = cr ? patched.replace(/\n/g, '\r\n') : patched;
  fs.writeFileSync(filePath, out, 'utf8');
  console.log(`  ✓ ${label}`);
  return true;
}

// ── Shared new code ─────────────────────────────────────────────────────────

const STATE_VAR_OLD = `let _intelSpatialDebounce  = null;  // Phase 17 — debounce for spatial panel patches`;
const STATE_VAR_NEW = `let _intelSpatialDebounce  = null;  // Phase 17 — debounce for spatial panel patches
let _intelPredictDebounce  = null;  // Phase 18 — debounce for prediction panel patches`;

// Bundle HTML: add intel-predictions div
const BUNDLE_HTML_OLD_A = `    <div id="intel-spatial"></div>
  </div>\`;

  // Phase 17 — render spatial panels into their dedicated container
  const _spatialEl = c.querySelector('#intel-spatial');
  if (_spatialEl && d.spatialAnalysis) _renderSpatialPanels(_spatialEl, d.spatialAnalysis, d);
}`;

const BUNDLE_HTML_NEW = `    <div id="intel-spatial"></div>
    <div id="intel-predictions"></div>
  </div>\`;

  // Phase 17 — render spatial panels into their dedicated container
  const _spatialEl = c.querySelector('#intel-spatial');
  if (_spatialEl && d.spatialAnalysis) _renderSpatialPanels(_spatialEl, d.spatialAnalysis, d);
  // Phase 18 — render prediction panels into their dedicated container
  const _predictEl = c.querySelector('#intel-predictions');
  if (_predictEl && d.predictions) _renderPredictionPanels(_predictEl, d.predictions, d);
}`;

// frontend/familista_v5.html has a minified _renderIntelligenceBundle — different anchor
// The minified version ends with: `Computed ${new Date(d.computedAt).toLocaleTimeString()}</div></div>\`;`
// followed by the closing bracket of the function
const BUNDLE_HTML_OLD_MINI_A = `Computed \${new Date(d.computedAt).toLocaleTimeString()}</div></div>\`;
}`;
const BUNDLE_HTML_NEW_MINI = `Computed \${new Date(d.computedAt).toLocaleTimeString()}</div><div id="intel-spatial"></div><div id="intel-predictions"></div></div>\`;
  // Phase 17 — render spatial panels into their dedicated container
  const _spatialEl = c.querySelector('#intel-spatial');
  if (_spatialEl && d.spatialAnalysis) _renderSpatialPanels(_spatialEl, d.spatialAnalysis, d);
  // Phase 18 — render prediction panels into their dedicated container
  const _predictEl = c.querySelector('#intel-predictions');
  if (_predictEl && d.predictions) _renderPredictionPanels(_predictEl, d.predictions, d);
}`;

// _renderPredictionPanels function to insert
const RENDER_PREDICT_FN = `
// ── Phase 18 — Predictive Intelligence Visualization ──────────────────────────
function _renderPredictionPanels(el, pred, d) {
  if (!el || !pred) return;
  const CARD_STYLE = 'padding:12px;margin-bottom:12px;';
  const HDR = (t) => \`<div style="font-size:11px;font-weight:700;color:var(--tx-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">\${t}</div>\`;
  const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#22c55e' };
  const DIR_COLOR  = { HOME: '#22c55e', AWAY: '#ef4444', STABLE: '#94a3b8' };

  const gt      = pred.goalThreat;
  const pct     = Math.max(0, Math.min(100, gt.probability));
  const gtColor = pct >= 60 ? '#ef4444' : pct >= 35 ? '#f59e0b' : '#22c55e';
  const dash    = \`\${(pct * 125.7 / 100).toFixed(1)} 125.7\`;
  const threatColMap = { HOME: '#22c55e', AWAY: '#3b82f6', BALANCED: '#94a3b8' };
  const goalHTML = \`
  <div style="\${CARD_STYLE}background:var(--glass);">
    \${HDR('Goal Threat Meter')}
    <div style="display:flex;align-items:center;gap:16px;">
      <svg viewBox="0 0 60 60" width="72" height="72" style="flex-shrink:0;">
        <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="5"/>
        <circle cx="30" cy="30" r="20" fill="none" stroke="\${gtColor}" stroke-width="5"
          stroke-dasharray="\${dash}" stroke-dashoffset="0"
          transform="rotate(-90 30 30)" stroke-linecap="round"/>
        <text x="30" y="35" text-anchor="middle" font-size="10" font-weight="700" fill="\${gtColor}">\${pct}%</text>
      </svg>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;color:\${threatColMap[gt.threatSide]||'#94a3b8'};margin-bottom:4px;">
          \${gt.threatSide} · next \${gt.windowMin} min
        </div>
        \${gt.drivers.map(dr => \`<div style="font-size:11px;color:var(--tx-2);line-height:1.4;">→ \${dr}</div>\`).join('')}
      </div>
    </div>
  </div>\`;

  const mf       = pred.momentumForecast;
  const mfColor  = DIR_COLOR[mf.direction] || '#94a3b8';
  const confPct  = Math.round(mf.confidence * 100);
  const arrowSVG = mf.direction === 'HOME'
    ? '<path d="M4 16 L16 8 L28 16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    : mf.direction === 'AWAY'
      ? '<path d="M28 8 L16 16 L4 8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M2 12 L30 12" fill="none" stroke-linecap="round"/>';
  const momentumHTML = \`
  <div style="\${CARD_STYLE}background:var(--glass);">
    \${HDR('Momentum Forecast')}
    <div style="display:flex;align-items:center;gap:14px;">
      <svg viewBox="0 0 32 24" width="64" height="48" style="flex-shrink:0;">
        <g stroke="\${mfColor}" stroke-width="2.5">\${arrowSVG}</g>
      </svg>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:\${mfColor};margin-bottom:3px;">\${mf.direction}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <div style="height:4px;border-radius:2px;background:rgba(255,255,255,0.1);flex:1;overflow:hidden;">
            <div style="height:100%;width:\${confPct}%;background:\${mfColor};border-radius:2px;"></div>
          </div>
          <span style="font-size:10px;color:var(--tx-3);min-width:28px;">\${confPct}%</span>
        </div>
        <div style="font-size:11px;color:var(--tx-2);">\${mf.note}</div>
      </div>
    </div>
  </div>\`;

  const sc      = pred.shapeCollapse;
  const scColor = RISK_COLOR[sc.risk];
  const stabilityHTML = \`
  <div style="\${CARD_STYLE}background:var(--glass);">
    \${HDR('Tactical Stability')}
    <div style="display:flex;align-items:center;gap:16px;">
      <svg viewBox="0 0 60 60" width="60" height="60" style="flex-shrink:0;">
        <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="4"/>
        <circle cx="30" cy="30" r="20" fill="none" stroke="\${scColor}" stroke-width="4"
          stroke-dasharray="\${sc.score} 100" stroke-dashoffset="0"
          transform="rotate(-90 30 30)" stroke-linecap="round" pathLength="100"/>
        <text x="30" y="34" text-anchor="middle" font-size="7.5" font-weight="700" fill="\${scColor}">\${sc.risk}</text>
      </svg>
      <div style="flex:1;">
        \${sc.indicators.length > 0
          ? sc.indicators.map(ind => \`<div style="font-size:11px;color:var(--tx-2);line-height:1.5;">⚠ \${ind}</div>\`).join('')
          : '<div style="font-size:11px;color:#22c55e;">Shape intact — no anomalies detected.</div>'
        }
      </div>
    </div>
  </div>\`;

  const fr      = pred.fatigueRisk;
  const frColor = RISK_COLOR[fr.peakRisk];
  const fatigueHTML = \`
  <div style="\${CARD_STYLE}background:var(--glass);">
    \${HDR('Fatigue Risk Forecast')}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="font-size:13px;font-weight:700;color:\${frColor};">\${fr.peakRisk} RISK</span>
      <span style="font-size:11px;color:var(--tx-3);">\${fr.riskyCount} player(s)</span>
      \${fr.peakMinute != null ? \`<span style="font-size:11px;color:var(--tx-3);">Peak ~\${fr.peakMinute}'</span>\` : ''}
    </div>
    \${fr.riskPlayers.length > 0
      ? \`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;">
          \${fr.riskPlayers.slice(0, 4).map(p => {
            const pc = p.fatigueIndex >= 80 ? '#ef4444' : '#f59e0b';
            return \`<div style="padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.04);">
              <div style="font-size:11px;font-weight:600;color:var(--tx-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${p.name.split(' ').pop()}</div>
              <div style="font-size:10px;color:\${pc};">\${p.fatigueIndex}% · \${p.minutesPlayed}'</div>
            </div>\`;
          }).join('')}
        </div>\`
      : '<div style="font-size:11px;color:#22c55e;">No fatigue risk detected.</div>'
    }
  </div>\`;

  const ct       = pred.counterThreat;
  const ctColor  = RISK_COLOR[ct.level];
  const zoneXMap = { LEFT: 5, CENTER: 37, RIGHT: 68 };
  const zoneW    = 27;
  const zoneHL   = ct.likelyZone
    ? \`<rect x="\${zoneXMap[ct.likelyZone]}" y="1" width="\${zoneW}" height="38" rx="2" fill="\${ctColor}" fill-opacity="0.2" stroke="\${ctColor}" stroke-width="0.7"/>
       <text x="\${zoneXMap[ct.likelyZone] + zoneW / 2}" y="23" text-anchor="middle" font-size="7" fill="\${ctColor}" font-weight="700">\${ct.likelyZone}</text>\`
    : '';
  const counterHTML = \`
  <div style="\${CARD_STYLE}background:var(--glass);">
    \${HDR('Counterattack Alert')}
    <div style="display:flex;align-items:center;gap:14px;">
      <svg viewBox="0 0 100 40" width="100" height="40" style="flex-shrink:0;border-radius:3px;background:rgba(34,197,94,0.04);">
        <rect x="0" y="0" width="100" height="40" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="0.5"/>
        <line x1="50" y1="0" x2="50" y2="40" stroke="rgba(255,255,255,0.1)" stroke-width="0.5"/>
        \${zoneHL}
      </svg>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;color:\${ctColor};margin-bottom:4px;">\${ct.level}</div>
        <div style="font-size:11px;color:var(--tx-2);">\${ct.note}</div>
      </div>
    </div>
  </div>\`;

  const ps         = pred.possessionSwing;
  const trendColor = ps.trend === 'GAINING' ? '#22c55e' : ps.trend === 'LOSING' ? '#ef4444' : '#94a3b8';
  const trendIcon  = ps.trend === 'GAINING' ? '▲' : ps.trend === 'LOSING' ? '▼' : '→';
  const forecastX  = Math.max(10, Math.min(90, ps.forecastPct));
  const confPct2   = Math.round(ps.confidence * 100);
  const possessionHTML = \`
  <div style="\${CARD_STYLE}background:var(--glass);">
    \${HDR('Possession Swing Forecast')}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-size:20px;color:\${trendColor};">\${trendIcon}</span>
      <div>
        <span style="font-size:13px;font-weight:700;color:\${trendColor};">\${ps.trend}</span>
        <span style="font-size:11px;color:var(--tx-3);margin-left:6px;">conf \${confPct2}%</span>
      </div>
    </div>
    <div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx-3);margin-bottom:3px;">
        <span>Current \${ps.currentPct}%</span><span>Forecast \${ps.forecastPct}%</span>
      </div>
      <div style="height:8px;border-radius:4px;background:rgba(255,255,255,0.08);overflow:hidden;position:relative;">
        <div style="height:100%;width:\${ps.currentPct}%;background:rgba(148,163,184,0.35);border-radius:4px;"></div>
        <div style="position:absolute;top:0;height:100%;width:2px;background:\${trendColor};left:calc(\${forecastX}% - 1px);border-radius:1px;"></div>
      </div>
    </div>
  </div>\`;

  el.innerHTML = goalHTML + momentumHTML + stabilityHTML + fatigueHTML + counterHTML + possessionHTML;
}
`;

// WS handler replacement (same in non-minified mirrors)
const WS_OLD = `  // Phase 16+17 — intelligence push: partial-patch spatial if container exists
  if (evt.kind === 'INTEL_UPDATE' && evt.payload) {
    _lastIntelUpdate = Date.now();
    if (_matchModalTab === 'intelligence') {
      const spatialEl = document.getElementById('intel-spatial');
      if (spatialEl && evt.payload.spatialAnalysis) {
        // Debounce spatial-only patch 200ms to prevent burst re-renders
        if (_intelSpatialDebounce) clearTimeout(_intelSpatialDebounce);
        _intelSpatialDebounce = setTimeout(() => {
          _intelSpatialDebounce = null;
          const el = document.getElementById('intel-spatial');
          if (el) _renderSpatialPanels(el, evt.payload.spatialAnalysis, evt.payload);
        }, 200);
      } else {
        const c = document.getElementById('match-modal-content');
        if (c) _renderIntelligenceBundle(c, evt.payload);
      }
    }
    return;
  }`;

const WS_NEW = `  // Phase 16+17+18 — intelligence push: partial-patch containers or full re-render
  if (evt.kind === 'INTEL_UPDATE' && evt.payload) {
    _lastIntelUpdate = Date.now();
    if (_matchModalTab === 'intelligence') {
      const spatialEl  = document.getElementById('intel-spatial');
      const predictEl  = document.getElementById('intel-predictions');
      if (spatialEl || predictEl) {
        if (_intelSpatialDebounce) clearTimeout(_intelSpatialDebounce);
        _intelSpatialDebounce = setTimeout(() => {
          _intelSpatialDebounce = null;
          const sel = document.getElementById('intel-spatial');
          if (sel && evt.payload.spatialAnalysis) _renderSpatialPanels(sel, evt.payload.spatialAnalysis, evt.payload);
        }, 200);
        if (_intelPredictDebounce) clearTimeout(_intelPredictDebounce);
        _intelPredictDebounce = setTimeout(() => {
          _intelPredictDebounce = null;
          const pel = document.getElementById('intel-predictions');
          if (pel && evt.payload.predictions) _renderPredictionPanels(pel, evt.payload.predictions, evt.payload);
        }, 150);
      } else {
        const c = document.getElementById('match-modal-content');
        if (c) _renderIntelligenceBundle(c, evt.payload);
      }
    }
    return;
  }`;

const CLOSE_OLD = `  if (_intelSpatialDebounce)  { clearTimeout(_intelSpatialDebounce); _intelSpatialDebounce = null; }
  closeMatchModalSSE();`;
const CLOSE_NEW = `  if (_intelSpatialDebounce)  { clearTimeout(_intelSpatialDebounce); _intelSpatialDebounce = null; }
  if (_intelPredictDebounce)  { clearTimeout(_intelPredictDebounce); _intelPredictDebounce = null; }
  closeMatchModalSSE();`;

const TAB_OLD = `  if (tab !== 'intelligence' && _intelSpatialDebounce) { clearTimeout(_intelSpatialDebounce); _intelSpatialDebounce = null; }`;
const TAB_NEW = `  if (tab !== 'intelligence' && _intelSpatialDebounce)  { clearTimeout(_intelSpatialDebounce);  _intelSpatialDebounce = null; }
  if (tab !== 'intelligence' && _intelPredictDebounce) { clearTimeout(_intelPredictDebounce); _intelPredictDebounce = null; }`;

// Where to insert _renderPredictionPanels — after _renderSpatialPanels closing brace
// Anchor: the unique el.innerHTML assignment at the end of _renderSpatialPanels
const SPATIAL_END_ANCHOR = `el.innerHTML = heatmapHTML + pressureHTML + passingHTML + shapeHTML + shiftHTML + overloadHTML;
}`;
const SPATIAL_END_WITH_PREDICT = `el.innerHTML = heatmapHTML + pressureHTML + passingHTML + shapeHTML + shiftHTML + overloadHTML;
}
${RENDER_PREDICT_FN}`;

// ── Apply per file ──────────────────────────────────────────────────────────

for (const filePath of FILES) {
  const name = path.relative(ROOT, filePath);
  console.log(`\nPatching: ${name}`);
  let ok = true;

  // 1. State variable
  if (!patch(filePath, '1/6 state var', (src) => {
    if (src.includes('_intelPredictDebounce')) return src; // already patched
    if (!src.includes(STATE_VAR_OLD)) return null;
    return src.replace(STATE_VAR_OLD, STATE_VAR_NEW);
  })) ok = false;

  // 2. Bundle HTML (with minified fallback for frontend/familista_v5.html)
  if (!patch(filePath, '2/6 bundle HTML', (src) => {
    if (src.includes('intel-predictions')) return src; // already patched
    if (src.includes(BUNDLE_HTML_OLD_A)) {
      return src.replace(BUNDLE_HTML_OLD_A, BUNDLE_HTML_NEW);
    }
    // Minified mirror: check if it already has intel-spatial injected (from Phase 17 mini patch)
    // and just needs intel-predictions added
    if (src.includes('intel-spatial') && src.includes(BUNDLE_HTML_OLD_MINI_A)) {
      return src.replace(BUNDLE_HTML_OLD_MINI_A, BUNDLE_HTML_NEW_MINI);
    }
    // Minified mirror without the full intel-spatial div yet — look for just the computedAt footer
    const miniAlt = `Computed \${new Date(d.computedAt).toLocaleTimeString()}</div></div>\`;\n}`;
    if (src.includes(miniAlt)) {
      return src.replace(miniAlt, BUNDLE_HTML_NEW_MINI);
    }
    return null;
  })) ok = false;

  // 3. Add _renderPredictionPanels after _renderSpatialPanels
  if (!patch(filePath, '3/6 _renderPredictionPanels', (src) => {
    if (src.includes('_renderPredictionPanels')) return src; // already patched
    if (!src.includes(SPATIAL_END_ANCHOR)) return null;
    return src.replace(SPATIAL_END_ANCHOR, SPATIAL_END_WITH_PREDICT);
  })) ok = false;

  // 4. WS handler
  if (!patch(filePath, '4/6 WS handler', (src) => {
    if (src.includes('_intelPredictDebounce') && src.includes('INTEL_UPDATE')) {
      // Already has predict debounce in WS handler
      return src;
    }
    if (!src.includes(WS_OLD)) return null;
    return src.replace(WS_OLD, WS_NEW);
  })) ok = false;

  // 5. closeMatchModal
  if (!patch(filePath, '5/6 closeMatchModal', (src) => {
    if (src.includes(CLOSE_NEW)) return src; // already patched
    if (!src.includes(CLOSE_OLD)) return null;
    return src.replace(CLOSE_OLD, CLOSE_NEW);
  })) ok = false;

  // 6. setMatchModalTab
  if (!patch(filePath, '6/6 setMatchModalTab', (src) => {
    if (src.includes(TAB_NEW)) return src; // already patched
    if (!src.includes(TAB_OLD)) return null;
    return src.replace(TAB_OLD, TAB_NEW);
  })) ok = false;

  console.log(ok ? `  → ${name} fully patched` : `  → ${name} had errors`);
}

console.log('\nDone.');
