// sync-phase11-frontend.js
// Applies Phase 11 (Unified Intelligence) frontend changes from public/app.js to all 3 HTML mirrors.
// Run from: familista-backend directory
// Usage: node sync-phase11-frontend.js

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
const srcNorm = srcRaw.replace(/\r\n/g, '\n');   // always LF for searching

// ── Helpers ──────────────────────────────────────────────────────────────────

function toCRLF(str) { return str.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
function toLF(str)   { return str.replace(/\r\n/g, '\n'); }

function sliceByMarkers(src, startStr, endStr, includeEnd) {
  const s = src.indexOf(startStr);
  if (s === -1) throw new Error('Start marker not found: ' + JSON.stringify(startStr.slice(0, 80)));
  const e = src.indexOf(endStr, s + startStr.length);
  if (e === -1) throw new Error('End marker not found: ' + JSON.stringify(endStr.slice(0, 80)));
  return src.slice(s, includeEnd ? e + endStr.length : e);
}

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

// ── 1. Tab button — add "Intelligence" after "Compare" ────────────────────────

const OLD_TAB = [
  '      <button class="ti-tab"        id="titab-compare"    data-action="tiSwitchTab" data-tab="compare">Compare</button>',
  '    </div>',
].join('\n');

const NEW_TAB = [
  '      <button class="ti-tab"        id="titab-compare"    data-action="tiSwitchTab" data-tab="compare">Compare</button>',
  '      <button class="ti-tab"        id="titab-intel"      data-action="tiSwitchTab" data-tab="intel">Intelligence</button>',
  '    </div>',
].join('\n');

// ── 2. loadTransferData — extend from 8 to 9 parallel fetches ────────────────

// The Phase 10 block as it exists in the mirrors right now
const OLD_FETCH = [
  "  const [targRes, pipeRes, repRes, contrRes, valRes, sqRes, rankRes, depthRes] = await Promise.allSettled([",
  "    FamilistaAPI.get('/phase-q/transfer/targets?limit=200'),",
  "    FamilistaAPI.get('/phase-q/transfer/pipeline'),",
  "    FamilistaAPI.get('/phase-q/transfer/reports?limit=100'),",
  "    FamilistaAPI.get('/phase-q/transfer/contracts-expiring'),",
  "    FamilistaAPI.get('/phase-q/transfer/market-values/squad'),",
  "    FamilistaAPI.get('/phase-q/transfer/intelligence/squad'),",
  "    FamilistaAPI.get('/phase-q/transfer/scoring/ranked'),",
  "    FamilistaAPI.get('/phase-q/transfer/scoring/squad-depth'),",
  "  ]);",
  "",
  "  State.transfer.targets        = (targRes.status  === 'fulfilled' && Array.isArray(targRes.value?.items))  ? targRes.value.items  : [];",
  "  State.transfer.pipeline       = (pipeRes.status  === 'fulfilled' && pipeRes.value && typeof pipeRes.value === 'object') ? pipeRes.value : {};",
  "  State.transfer.reports        = (repRes.status   === 'fulfilled' && Array.isArray(repRes.value?.items))   ? repRes.value.items   : [];",
  "  State.transfer.contracts      = (contrRes.status === 'fulfilled' && Array.isArray(contrRes.value))        ? contrRes.value       : [];",
  "  State.transfer.squadVal       = (valRes.status   === 'fulfilled' && Array.isArray(valRes.value))          ? valRes.value         : [];",
  "  State.transfer.squadIntel     = (sqRes.status    === 'fulfilled' && sqRes.value)                          ? sqRes.value          : null;",
  "  State.transfer._rankedTargets = (rankRes.status  === 'fulfilled' && Array.isArray(rankRes.value?.items))  ? rankRes.value.items  : null;",
  "  State.transfer._squadDepth    = (depthRes.status === 'fulfilled' && depthRes.value)                       ? depthRes.value       : null;",
].join('\n');

// Extract the Phase 11 block from app.js (already there)
const NEW_FETCH = sliceByMarkers(srcNorm,
  "  const [targRes, pipeRes, repRes, contrRes, valRes, sqRes, rankRes, depthRes, futureRes] = await Promise.allSettled([",
  "  State.transfer._futurePlan    = (futureRes.status === 'fulfilled' && futureRes.value)                     ? futureRes.value      : null;",
  true   // include end marker
);

// ── 3. tiRenderTab — add 'intel' case ────────────────────────────────────────

const OLD_SWITCH = [
  "    case 'compare':   el.innerHTML = _tiCompare();        break;",
  "    default:          el.innerHTML = _tiDashboard();",
].join('\n');

const NEW_SWITCH = [
  "    case 'compare':   el.innerHTML = _tiCompare();        break;",
  "    case 'intel':     el.innerHTML = _tiIntelligence();   break;",
  "    default:          el.innerHTML = _tiDashboard();",
].join('\n');

// ── 4. Insert _tiIntelligence + tiLoadPlayerUnified before Modal comment ──────

// Extract the Phase 11 functions block from app.js (between SCREEN 8 comment and Modal comment)
const screen8Marker = '\n// ── SCREEN 8: Intelligence (Phase 11) ──';
const modalMarker   = '\n// ── Modal: Player Detail ──';
const s8pos = srcNorm.indexOf(screen8Marker);
const mdpos = srcNorm.indexOf(modalMarker, s8pos);
if (s8pos === -1 || mdpos === -1) throw new Error('Could not locate SCREEN 8 or Modal comment in app.js');
const intelligenceBlock = srcNorm.slice(s8pos + 1, mdpos).trimEnd();

// Get exact Modal comment line from app.js (same in all 3 mirrors)
const modalLineEnd = srcNorm.indexOf('\n', mdpos + 1);
const MODAL_COMMENT = srcNorm.slice(mdpos + 1, modalLineEnd);

// OLD: end of _tiCompare + blank line + Modal comment header (as in mirrors)
// Uses Array.join to avoid backtick/interpolation issues in the source code
const OLD_MODAL = [
  '  return controls + `<div style="display:flex;gap:24px;">${aCol}${bCol}</div>`;',
  '}',
  '',
  MODAL_COMMENT,
].join('\n');

const NEW_MODAL = [
  '  return controls + `<div style="display:flex;gap:24px;">${aCol}${bCol}</div>`;',
  '}',
  '',
  intelligenceBlock,
  '',
  MODAL_COMMENT,
].join('\n');

// ── 5. Delegation — add tiLoadPlayerUnified case (using mirror's 4-space indent) ──

const OLD_DELEGATION = [
  "    case 'tiLoadPlayerIntel':   tiLoadPlayerIntel();                            break;",
  "    case 'tiRunCompare':        tiRunCompare();                                 break;",
  "  }",
].join('\n');

const NEW_DELEGATION = [
  "    case 'tiLoadPlayerIntel':   tiLoadPlayerIntel();                            break;",
  "    case 'tiRunCompare':        tiRunCompare();                                 break;",
  "    case 'tiLoadPlayerUnified': tiLoadPlayerUnified();                         break;",
  "  }",
].join('\n');

// ── Run ───────────────────────────────────────────────────────────────────────

const REPLACEMENTS = [
  ['tab-intel-button',          OLD_TAB,        NEW_TAB       ],
  ['loadTransferData-9-fetches', OLD_FETCH,      NEW_FETCH     ],
  ['tiRenderTab-intel-case',    OLD_SWITCH,     NEW_SWITCH    ],
  ['_tiIntelligence-functions', OLD_MODAL,      NEW_MODAL     ],
  ['delegation-tiLoadUnified',  OLD_DELEGATION, NEW_DELEGATION],
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
console.log('Phase 11 frontend sync complete.');
