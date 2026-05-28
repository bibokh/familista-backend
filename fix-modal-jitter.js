// fix-modal-jitter.js
// Fixes player card click jitter in Squad + Quantum Intelligence.
//
// Root causes:
//  1. backdrop-filter:blur on display:none→flex forces GPU layer creation on every open → page shake
//  2. transform:translateY(-1px) on .card.clickable:hover snaps on backdrop repaint → card jitter
//
// Fixes:
//  1. Replace display:none/flex toggle with opacity+visibility toggle (layer pre-created, no reflow)
//  2. Remove translateY(-1px) from .card.clickable:hover (keep border + shadow hover feedback)
//
// CSS-only change. No JS, no backend, no schema.

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

// ── Fix 1: modal-bg — replace display-based toggle with opacity+visibility ───
// Old: display:none on base; display:flex on .open
// New: always display:flex but visibility:hidden/opacity:0; .open makes it visible
// This keeps the backdrop-filter compositor layer alive so no GPU re-promotion on open.

const OLD_MODAL_CSS =
  '.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;align-items:center;justify-content:center;backdrop-filter:blur(6px);}\n' +
  '.modal-bg.open{display:flex;}';

const NEW_MODAL_CSS =
  '.modal-bg{visibility:hidden;opacity:0;pointer-events:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:opacity .15s ease,visibility .15s ease;}\n' +
  '.modal-bg.open{visibility:visible;opacity:1;pointer-events:auto;}';

// ── Fix 2: card.clickable — remove transform so card does not lift on hover ───
// The translateY(-1px) causes a snap-back when the backdrop-filter layer fires.

const OLD_CARD_CSS =
  '.card.clickable:hover{border-color:var(--bd-2);transform:translateY(-1px);box-shadow:var(--shadow-lg);}';

const NEW_CARD_CSS =
  '.card.clickable:hover{border-color:var(--bd-2);box-shadow:var(--shadow-lg);}';

const REPLACEMENTS = [
  ['modal-bg visibility fix', OLD_MODAL_CSS, NEW_MODAL_CSS],
  ['card.clickable no-transform', OLD_CARD_CSS, NEW_CARD_CSS],
];

for (const mirrorPath of MIRRORS) {
  if (!fs.existsSync(mirrorPath)) { console.warn('SKIP (not found): ' + mirrorPath); continue; }
  console.log('Patching: ' + path.basename(mirrorPath));

  const raw    = fs.readFileSync(mirrorPath, 'utf8');
  const isCRLF = raw.includes('\r\n');
  let   result = toLF(raw);

  for (const [label, oldStr, newStr] of REPLACEMENTS) {
    const needle = toLF(oldStr);
    const pos    = result.indexOf(needle);
    if (pos === -1) {
      throw new Error('[' + path.basename(mirrorPath) + '] Anchor not found for: ' + label +
        '\n  Looking for: ' + needle.slice(0, 100).replace(/\n/g, '↵'));
    }
    result = result.slice(0, pos) + toLF(newStr) + result.slice(pos + needle.length);
    console.log('  ✓ ' + label);
  }

  fs.writeFileSync(mirrorPath, isCRLF ? toCRLF(result) : result, 'utf8');
  console.log('  Saved (' + (isCRLF ? 'CRLF' : 'LF') + ')\n');
}

console.log('Jitter fix applied to all mirrors.');
