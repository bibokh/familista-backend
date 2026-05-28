// sync-phase14-frontend.js
// Applies Phase 14 (GPS Fleet Status) to all 3 HTML mirrors.
// Replaces the fake loadDevicesData() with the real API-backed implementation.
// Run from: familista-backend directory
// Usage: node sync-phase14-frontend.js

'use strict';
const fs   = require('fs');
const path = require('path');

const MIRRORS = [
  path.join(__dirname, 'familista_v5.html'),
  path.join(__dirname, 'frontend', 'familista_v5.html'),
  path.join(__dirname, 'frontend', 'index.html'),
];

function toCRLF(str) { return str.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
function toLF(str)   { return str.replace(/\r\n/g, '\n'); }

// ── Old function (mirrors have no _esc() calls) ───────────────────────────────

const OLD_DEVICES_FN = [
  'async function loadDevicesData() {',
  '  const el = document.getElementById(\'dev-grid\');',
  '  const sub = document.getElementById(\'devices-sub\');',
  '  if (!el) return;',
  '',
  '  const players = State.players || [];',
  '  const online = players.filter(p => p.device?.isOnline !== false).length;',
  '',
  '  if (sub) sub.textContent = `${players.length} Familista Trackers · ${online} active · FW v1.2`;',
  '',
  '  if (players.length === 0) { el.innerHTML = loadingHTML(); return; }',
  '',
  '  el.innerHTML = players.map((p,i) => `',
  '    <div class="card dev-card clickable">',
  '      <div class="dev-hdr">',
  '        <div class="dev-icon">📡</div>',
  '        <div>',
  '          <div class="dev-name">${p.firstName} ${p.lastName}</div>',
  '          <div class="dev-serial">${p.device?.serialNumber || `FAM-${p.id.slice(-6).toUpperCase()}-2025`}</div>',
  '          <div class="dev-online"><div class="dev-pulse"></div><span class="dev-status">Online</span></div>',
  '        </div>',
  '        <span class="pos-pill ${posClass(p.position)}" style="margin-left:auto;">${p.position}</span>',
  '      </div>',
  '      <div class="dev-stats">',
  '        <div class="dev-stat"><div class="dev-stat-val" style="color:${(p.device?.batteryLevel||85)>30?\'var(--green-l)\":\'var(--red)\';};">${p.device?.batteryLevel||Math.max(20,88-i*2)}%</div><div class="dev-stat-lbl">Battery</div></div>',
  '        <div class="dev-stat"><div class="dev-stat-val" style="color:var(--blue);">${p.device?.signalQuality||100}%</div><div class="dev-stat-lbl">Signal</div></div>',
  '        <div class="dev-stat"><div class="dev-stat-val" style="color:var(--green-l);">${p.device?.firmware||\'v1.2\'}</div><div class="dev-stat-lbl">FW</div></div>',
  '      </div>',
  '    </div>`).join(\'\');',
  '}',
].join('\n');

// ── New function block (mirrors use same template as app.js but no _esc) ──────

const NEW_DEVICES_FN = [
  'let _devPollTimer = null;',
  '',
  'async function loadDevicesData() {',
  '  if (_devPollTimer) { clearInterval(_devPollTimer); _devPollTimer = null; }',
  '  const el = document.getElementById(\'dev-grid\');',
  '  const sub = document.getElementById(\'devices-sub\');',
  '  if (!el) return;',
  '  el.innerHTML = loadingHTML(\'Loading devices...\');',
  '  let fleet;',
  '  try {',
  '    fleet = await FamilistaAPI.get(\'/devices/gps-status\');',
  '  } catch (_) {',
  "    el.innerHTML = '<div style=\"padding:24px;color:var(--red);font-size:12px;\">Failed to load GPS fleet status.</div>';",
  '    return;',
  '  }',
  '  _renderDeviceFleet(fleet, el, sub);',
  '  _devPollTimer = setInterval(() => {',
  "    if (document.visibilityState !== 'visible') return;",
  "    const grid = document.getElementById('dev-grid');",
  '    if (!grid) { clearInterval(_devPollTimer); _devPollTimer = null; return; }',
  "    FamilistaAPI.get('/devices/gps-status').then(f => {",
  '      if (f && f.devices) _renderDeviceFleet(f, grid, document.getElementById(\'devices-sub\'));',
  '    }).catch(() => {});',
  '  }, 30_000);',
  '}',
  '',
  'function _fmtDeviceLastSeen(isoStr) {',
  '  if (!isoStr) return \'Never\';',
  '  const secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);',
  '  if (secs < 60)   return secs + \'s ago\';',
  '  if (secs < 3600) return Math.floor(secs / 60) + \'m ago\';',
  '  return Math.floor(secs / 3600) + \'h ago\';',
  '}',
  '',
  'function _renderDeviceFleet(fleet, el, sub) {',
  "  if (!fleet || !fleet.devices) {",
  "    el.innerHTML = '<div style=\"padding:24px;color:var(--tx-3);font-size:12px;\">No GPS devices registered.</div>';",
  '    return;',
  '  }',
  "  if (sub) sub.textContent = fleet.total + ' Tracker' + (fleet.total !== 1 ? 's' : '') +",
  "    ' · ' + fleet.online + ' online · ' + fleet.stale + ' stale · ' + fleet.offline + ' offline';",
  '  if (fleet.devices.length === 0) {',
  "    el.innerHTML = '<div style=\"padding:24px;color:var(--tx-3);font-size:12px;\">No GPS devices registered for this club.</div>';",
  '    return;',
  '  }',
  '  el.innerHTML = fleet.devices.map(d => {',
  "    const sc  = d.status === 'online' ? 'var(--green-l)' : d.status === 'stale' ? 'var(--amber)' : 'var(--red)';",
  "    const sa  = d.status === 'online' ? '' : 'animation:none;';",
  "    const bc  = d.batteryLevel > 30 ? 'var(--green-l)' : 'var(--red)';",
  '    const ls  = _fmtDeviceLastSeen(d.lastSeenAt);',
  "    const pn  = d.player ? d.player.name : '<span style=\"color:var(--tx-3);\">Unassigned</span>';",
  "    const pos = d.player && d.player.position ? d.player.position : '—';",
  '    return `',
  '    <div class="card dev-card clickable">',
  '      <div class="dev-hdr">',
  '        <div class="dev-icon">📡</div>',
  '        <div style="flex:1;min-width:0;">',
  '          <div class="dev-name">${pn}</div>',
  '          <div class="dev-serial">${d.serialNumber}</div>',
  '          <div class="dev-online">',
  '            <div class="dev-pulse" style="background:${sc};${sa}"></div>',
  '            <span class="dev-status" style="color:${sc};">${d.status.charAt(0).toUpperCase()+d.status.slice(1)}</span>',
  '            <span style="font-size:9px;color:var(--tx-3);font-family:var(--mono);margin-left:4px;">${ls}</span>',
  '          </div>',
  '        </div>',
  '        <span class="pos-pill ${posClass(pos)}" style="margin-left:auto;">${pos}</span>',
  '      </div>',
  '      <div class="dev-stats">',
  '        <div class="dev-stat"><div class="dev-stat-val" style="color:${bc};">${d.batteryLevel}%</div><div class="dev-stat-lbl">Battery</div></div>',
  '        <div class="dev-stat"><div class="dev-stat-val" style="color:var(--blue);">${d.signalQuality}%</div><div class="dev-stat-lbl">Signal</div></div>',
  '        <div class="dev-stat"><div class="dev-stat-val" style="color:var(--green-l);">${d.firmware}</div><div class="dev-stat-lbl">FW</div></div>',
  '      </div>',
  '    </div>`;',
  '  }).join(\'\');',
  '}',
].join('\n');

// ── Run ───────────────────────────────────────────────────────────────────────

for (const mirrorPath of MIRRORS) {
  if (!fs.existsSync(mirrorPath)) { console.warn('SKIP (not found): ' + mirrorPath); continue; }
  console.log('Patching: ' + path.basename(mirrorPath));

  const raw    = fs.readFileSync(mirrorPath, 'utf8');
  const isCRLF = raw.includes('\r\n');
  let   result = toLF(raw);

  const needle = toLF(OLD_DEVICES_FN);
  const pos    = result.indexOf(needle);
  if (pos === -1) {
    throw new Error(
      '[' + path.basename(mirrorPath) + '] Anchor not found for: loadDevicesData\n' +
      '  First 120 chars: ' + needle.slice(0, 120).replace(/\n/g, '↵'),
    );
  }

  result = result.slice(0, pos) + toLF(NEW_DEVICES_FN) + result.slice(pos + needle.length);
  console.log('  ✓ loadDevicesData → gps-status fleet');

  fs.writeFileSync(mirrorPath, isCRLF ? toCRLF(result) : result, 'utf8');
  console.log('  Saved ' + path.basename(mirrorPath) + ' (' + (isCRLF ? 'CRLF' : 'LF') + ')\n');
}

console.log('Phase 14 frontend sync complete.');
