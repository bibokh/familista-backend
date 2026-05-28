// sync-phase12-frontend.js
// Applies Phase 12 (Admin Control Center) to all 3 HTML mirrors.
// Anchors are derived from the MIRROR files (which diverge from app.js).
// Run from: familista-backend directory
// Usage: node sync-phase12-frontend.js

'use strict';
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public', 'app.js');
const MIRRORS = [
  path.join(__dirname, 'familista_v5.html'),
  path.join(__dirname, 'frontend', 'familista_v5.html'),
  path.join(__dirname, 'frontend', 'index.html'),
];

const srcRaw  = fs.readFileSync(SRC, 'utf8');
const srcNorm = srcRaw.replace(/\r\n/g, '\n');

function toCRLF(str) { return str.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
function toLF(str)   { return str.replace(/\r\n/g, '\n'); }

function replaceInMirror(mirrorPath, replacements) {
  const raw    = fs.readFileSync(mirrorPath, 'utf8');
  const isCRLF = raw.includes('\r\n');
  let   result = toLF(raw);

  for (const [label, oldStr, newStr] of replacements) {
    const needle = toLF(oldStr);
    const pos    = result.indexOf(needle);
    if (pos === -1) {
      throw new Error(
        '[' + path.basename(mirrorPath) + '] Anchor not found for: ' + label +
        '\n  First 120 chars: ' + needle.slice(0, 120).replace(/\n/g, '↵')
      );
    }
    result = result.slice(0, pos) + toLF(newStr) + result.slice(pos + needle.length);
    console.log('  ✓ ' + label);
  }

  fs.writeFileSync(mirrorPath, isCRLF ? toCRLF(result) : result, 'utf8');
  console.log('  Saved ' + path.basename(mirrorPath) + ' (' + (isCRLF ? 'CRLF' : 'LF') + ')\n');
}

// ── Extract admin block from app.js ──────────────────────────────────────────
// Between "// ── ADMIN CONTROL CENTER (Phase 12)" and the Quantum comment
const adminMarker   = '\n// ── ADMIN CONTROL CENTER (Phase 12) ─────────────────────────────────────────';
const quantumMarker = '\n// ══════════════════════════════════════════════════════════════\n// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER';
const adminBlockStart = srcNorm.indexOf(adminMarker);
const quantumBlockStart = srcNorm.indexOf(quantumMarker, adminBlockStart);
if (adminBlockStart === -1 || quantumBlockStart === -1) {
  throw new Error('Cannot locate admin or quantum marker in app.js — was Phase 12 applied to app.js?');
}
// The block to inject: from after the leading \n to the quantum comment
const adminBlock = srcNorm.slice(adminBlockStart + 1, quantumBlockStart);

// ── 1. State.admin ────────────────────────────────────────────────────────────

const OLD_STATE = '  coldStartInFlight: false,\n};';
const NEW_STATE = '  coldStartInFlight: false,\n  admin:        { quality: null, health: null, auditLog: null, tab: \'quality\', _loading: false },\n};';

// ── 2. renderAllPages — add renderAdminHTML() ─────────────────────────────────

const OLD_PAGES = '    ${renderTacticalOSHTML()}\n  `;\n\n  // Init live pitch';
const NEW_PAGES = '    ${renderTacticalOSHTML()}\n    ${renderAdminHTML()}\n  `;\n\n  // Init live pitch';

// ── 3. navTo — titles map ─────────────────────────────────────────────────────

const OLD_TITLE = "    club:'Club', settings:'Settings', 'tactical-os':'Tactical OS'";
const NEW_TITLE = "    club:'Club', settings:'Settings', 'tactical-os':'Tactical OS', admin:'Admin Center'";

// ── 4. navTo — lazy-load trigger ──────────────────────────────────────────────

const OLD_LOAD = "  if (page === 'tactical-os') loadTacticalOS();\n}";
const NEW_LOAD = "  if (page === 'tactical-os') loadTacticalOS();\n  if (page === 'admin')      loadAdminData();\n}";

// ── 5. bootApp — show admin nav by role ──────────────────────────────────────
// Mirror ends bootApp with the welcome toast then closing brace immediately.

const OLD_BOOT = "  showToast(`Welcome back, ${State.user?.firstName}! ✅`, 'success');\n}\n\nasync function loadAllData()";
const NEW_BOOT = [
  "  showToast(`Welcome back, ${State.user?.firstName}! ✅`, 'success');",
  "",
  "  // Phase 12 — show Admin Center nav item only for CLUB_ADMIN / SUPER_ADMIN",
  "  var role = State.user?.role;",
  "  if (role === 'CLUB_ADMIN' || role === 'SUPER_ADMIN') {",
  "    var navAdmin = document.getElementById('nav-admin');",
  "    if (navAdmin) navAdmin.style.display = '';",
  "  }",
  "}",
  "",
  "async function loadAllData()",
].join('\n');

// ── 6. Admin page functions block (before Quantum comment) ────────────────────
// Mirror has \n\n\n before the Quantum comment (triple newline from close of prev block)

const OLD_QUANTUM = '\n\n// ══════════════════════════════════════════════════════════════\n// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER\n// Proprietary System — Patent-Positioned — Investor-Ready\n// ══════════════════════════════════════════════════════════════';
const NEW_QUANTUM = '\n\n' + adminBlock + '\n\n// ══════════════════════════════════════════════════════════════\n// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER\n// Proprietary System — Patent-Positioned — Investor-Ready\n// ══════════════════════════════════════════════════════════════';

// ── 7. Delegation cases ───────────────────────────────────────────────────────
// Mirror indents delegation cases with 4 spaces, switch-close with 2 spaces.

const OLD_DELEG = "    case 'quantumOpenPlayerModal': quantumOpenPlayerModal(el.dataset.id);           break;\n  }";
const NEW_DELEG = [
  "    case 'quantumOpenPlayerModal': quantumOpenPlayerModal(el.dataset.id);           break;",
  "    // ── Admin Control Center ─────────────────────────────────────────────────",
  "    case 'adminTab':     adminSwitchTab(el.dataset.tab);                                               break;",
  "    case 'adminRefresh': loadAdminData();                                                              break;",
  "    case 'adminFixPlayer': openPlayerModal(el.dataset.id);                                             break;",
  "  }",
].join('\n');

// ── 8. Sidebar nav item ───────────────────────────────────────────────────────

const OLD_SETTINGS_NAV = [
  "      <div class=\"nav-item\" onclick=\"navTo('settings',this)\" data-page=\"settings\">",
  "        <svg class=\"nav-icon\" fill=\"currentColor\" viewBox=\"0 0 20 20\"><path fill-rule=\"evenodd\" d=\"M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z\" clip-rule=\"evenodd\"/></svg>",
  "        <span class=\"nav-label\">Settings</span>",
  "      </div>",
  "    </nav>",
].join('\n');

const NEW_SETTINGS_NAV = [
  "      <div class=\"nav-item\" onclick=\"navTo('settings',this)\" data-page=\"settings\">",
  "        <svg class=\"nav-icon\" fill=\"currentColor\" viewBox=\"0 0 20 20\"><path fill-rule=\"evenodd\" d=\"M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z\" clip-rule=\"evenodd\"/></svg>",
  "        <span class=\"nav-label\">Settings</span>",
  "      </div>",
  "      <div class=\"nav-item\" onclick=\"navTo('admin',this)\" data-page=\"admin\" id=\"nav-admin\" style=\"display:none;\">",
  "        <svg class=\"nav-icon\" fill=\"currentColor\" viewBox=\"0 0 20 20\"><path fill-rule=\"evenodd\" d=\"M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 01-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 010-2h4a1 1 0 011 1v4a1 1 0 01-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-9 7a1 1 0 012 0v1.586l2.293-2.293a1 1 0 011.414 1.414L6.414 15H8a1 1 0 010 2H4a1 1 0 01-1-1v-4zm13-1a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 010-2h1.586l-2.293-2.293a1 1 0 011.414-1.414L15 13.586V12a1 1 0 011-1z\" clip-rule=\"evenodd\"/></svg>",
  "        <span class=\"nav-label\">Admin Center</span>",
  "      </div>",
  "    </nav>",
].join('\n');

// ── Run ───────────────────────────────────────────────────────────────────────

const REPLACEMENTS = [
  ['state-admin',           OLD_STATE,           NEW_STATE          ],
  ['renderAllPages-admin',  OLD_PAGES,           NEW_PAGES          ],
  ['navTo-admin-title',     OLD_TITLE,           NEW_TITLE          ],
  ['navTo-admin-load',      OLD_LOAD,            NEW_LOAD           ],
  ['bootApp-role-guard',    OLD_BOOT,            NEW_BOOT           ],
  ['admin-page-functions',  OLD_QUANTUM,         NEW_QUANTUM        ],
  ['delegation-admin',      OLD_DELEG,           NEW_DELEG          ],
  ['sidebar-admin-nav',     OLD_SETTINGS_NAV,    NEW_SETTINGS_NAV   ],
];

for (const mirrorPath of MIRRORS) {
  if (!fs.existsSync(mirrorPath)) { console.warn('SKIP (not found): ' + mirrorPath); continue; }
  console.log('Syncing: ' + path.basename(mirrorPath));
  try {
    replaceInMirror(mirrorPath, REPLACEMENTS);
  } catch (err) {
    console.error('ERROR: ' + err.message);
    process.exit(1);
  }
}
console.log('Phase 12 frontend sync complete.');
