// sync-phase13-frontend.js
// Applies Phase 13 (Tactical AI Engine) to all 3 HTML mirrors.
// Anchors are derived from the MIRROR files after Phase 12 was applied.
// Run from: familista-backend directory
// Usage: node sync-phase13-frontend.js

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

// ── Extract Tactical AI block from app.js ─────────────────────────────────────
// Between "// ── TACTICAL AI ENGINE (Phase 13)" and the Quantum comment
const taiMarker     = '\n// ── TACTICAL AI ENGINE (Phase 13) ─────────────────────────────────────────';
const quantumMarker = '\n// ══════════════════════════════════════════════════════════════\n// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER';
const taiStart      = srcNorm.indexOf(taiMarker);
const quantumStart  = srcNorm.indexOf(quantumMarker, taiStart);
if (taiStart === -1 || quantumStart === -1) {
  throw new Error('Cannot locate Tactical AI or Quantum marker in app.js — was Phase 13 applied to app.js?');
}
const taiBlock = srcNorm.slice(taiStart + 1, quantumStart);

// ── 1. State.tacticalAI ───────────────────────────────────────────────────────

const OLD_STATE = "  admin:        { quality: null, health: null, auditLog: null, tab: 'quality', _loading: false },\n};";
const NEW_STATE = "  admin:        { quality: null, health: null, auditLog: null, tab: 'quality', _loading: false },\n  tacticalAI:   { teamAnalysis: null, matchAnalysis: null, _loading: false, _tab: 'overview', _selectedMatchId: '' },\n};";

// ── 2. renderAllPages — add renderTacticalAIHTML() ────────────────────────────

const OLD_PAGES = "    ${renderAdminHTML()}\n  `;\n\n  // Init live pitch";
const NEW_PAGES = "    ${renderAdminHTML()}\n    ${renderTacticalAIHTML()}\n  `;\n\n  // Init live pitch";

// ── 3. navTo — titles map ─────────────────────────────────────────────────────

const OLD_TITLE = "club:'Club', settings:'Settings', 'tactical-os':'Tactical OS', admin:'Admin Center'";
const NEW_TITLE = "club:'Club', settings:'Settings', 'tactical-os':'Tactical OS', admin:'Admin Center', 'tactical-ai':'Tactical AI'";

// ── 4. navTo — lazy-load trigger ──────────────────────────────────────────────

const OLD_LOAD = "  if (page === 'admin')      loadAdminData();\n}";
const NEW_LOAD = "  if (page === 'admin')      loadAdminData();\n  if (page === 'tactical-ai') loadTacticalAIData();\n}";

// ── 5. Tactical AI page functions block ───────────────────────────────────────
// Insert before the double-newline + Quantum comment

const OLD_QUANTUM = '\n\n// ══════════════════════════════════════════════════════════════\n// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER\n// Proprietary System — Patent-Positioned — Investor-Ready\n// ══════════════════════════════════════════════════════════════';
const NEW_QUANTUM = '\n\n' + taiBlock + '\n\n// ══════════════════════════════════════════════════════════════\n// FAMILISTA QUANTUM FOOTBALL INTELLIGENCE LAYER\n// Proprietary System — Patent-Positioned — Investor-Ready\n// ══════════════════════════════════════════════════════════════';

// ── 6. Delegation cases ───────────────────────────────────────────────────────

const OLD_DELEG = "    case 'adminFixPlayer': openPlayerModal(el.dataset.id);                                             break;\n  }";
const NEW_DELEG = [
  "    case 'adminFixPlayer': openPlayerModal(el.dataset.id);                                             break;",
  "    // ── Tactical AI ──────────────────────────────────────────────────────────",
  "    case 'taiTab':          taiSwitchTab(el.dataset.tab);                                              break;",
  "    case 'taiRefresh':      loadTacticalAIData();                                                      break;",
  "    case 'taiSelectMatch':  taiSelectMatch(el.dataset.id);                                             break;",
  "  }",
].join('\n');

// ── 7. Sidebar nav item ───────────────────────────────────────────────────────
// Inserted after the admin nav item, before </nav>

const OLD_ADMIN_NAV = [
  "      <div class=\"nav-item\" onclick=\"navTo('admin',this)\" data-page=\"admin\" id=\"nav-admin\" style=\"display:none;\">",
  "        <svg class=\"nav-icon\" fill=\"currentColor\" viewBox=\"0 0 20 20\"><path fill-rule=\"evenodd\" d=\"M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 01-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 010-2h4a1 1 0 011 1v4a1 1 0 01-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-9 7a1 1 0 012 0v1.586l2.293-2.293a1 1 0 011.414 1.414L6.414 15H8a1 1 0 010 2H4a1 1 0 01-1-1v-4zm13-1a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 010-2h1.586l-2.293-2.293a1 1 0 011.414-1.414L15 13.586V12a1 1 0 011-1z\" clip-rule=\"evenodd\"/></svg>",
  "        <span class=\"nav-label\">Admin Center</span>",
  "      </div>",
  "    </nav>",
].join('\n');

const NEW_ADMIN_NAV = [
  "      <div class=\"nav-item\" onclick=\"navTo('admin',this)\" data-page=\"admin\" id=\"nav-admin\" style=\"display:none;\">",
  "        <svg class=\"nav-icon\" fill=\"currentColor\" viewBox=\"0 0 20 20\"><path fill-rule=\"evenodd\" d=\"M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 01-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 010-2h4a1 1 0 011 1v4a1 1 0 01-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-9 7a1 1 0 012 0v1.586l2.293-2.293a1 1 0 011.414 1.414L6.414 15H8a1 1 0 010 2H4a1 1 0 01-1-1v-4zm13-1a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 010-2h1.586l-2.293-2.293a1 1 0 011.414-1.414L15 13.586V12a1 1 0 011-1z\" clip-rule=\"evenodd\"/></svg>",
  "        <span class=\"nav-label\">Admin Center</span>",
  "      </div>",
  "      <div class=\"nav-item\" onclick=\"navTo('tactical-ai',this)\" data-page=\"tactical-ai\" id=\"nav-tactical-ai\">",
  "        <svg class=\"nav-icon\" fill=\"currentColor\" viewBox=\"0 0 20 20\"><path d=\"M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z\"/></svg>",
  "        <span class=\"nav-label\">Tactical AI</span>",
  "      </div>",
  "    </nav>",
].join('\n');

// ── Run ───────────────────────────────────────────────────────────────────────

const REPLACEMENTS = [
  ['state-tacticalAI',          OLD_STATE,       NEW_STATE      ],
  ['renderAllPages-tacticalAI', OLD_PAGES,       NEW_PAGES      ],
  ['navTo-tacticalAI-title',    OLD_TITLE,       NEW_TITLE      ],
  ['navTo-tacticalAI-load',     OLD_LOAD,        NEW_LOAD       ],
  ['tacticalAI-page-functions', OLD_QUANTUM,     NEW_QUANTUM    ],
  ['delegation-tacticalAI',     OLD_DELEG,       NEW_DELEG      ],
  ['sidebar-tacticalAI-nav',    OLD_ADMIN_NAV,   NEW_ADMIN_NAV  ],
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
console.log('Phase 13 frontend sync complete.');
