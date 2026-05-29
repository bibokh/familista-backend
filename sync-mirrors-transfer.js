'use strict';
var fs   = require('fs');
var path = require('path');

// ─── Extract transfer section from app.js ────────────────────────────────────
var appSrc = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
var TI_START = '// ══════════════════════════════════════════════════════════════════════════════\n// TRANSFER INTELLIGENCE CENTER — Phase 9';
var TI_END   = '// END TRANSFER INTELLIGENCE\n// ══════════════════════════════════════════════════════════════════════════════';
var tiStart  = appSrc.indexOf(TI_START);
var tiEnd    = appSrc.indexOf(TI_END, tiStart) + TI_END.length;
if (tiStart < 0 || tiEnd < TI_END.length) { console.error('Cannot extract transfer section from app.js'); process.exit(1); }
var TRANSFER_JS = appSrc.slice(tiStart, tiEnd);

var MIRRORS = [
  'familista_v5.html',
  'frontend/familista_v5.html',
  'frontend/index.html',
];

MIRRORS.forEach(function(relPath) {
  var filePath = path.join(__dirname, relPath);
  var src = fs.readFileSync(filePath, 'utf8');
  var nl  = src.includes('\r\n') ? '\r\n' : '\n';

  // ── 1. Add renderTransferHTML() to page render list ──────────────────────
  var RENDER_BEFORE = '    ${renderVideoHTML()}' + nl + '    ${renderFinancesHTML()}';
  var RENDER_AFTER  = '    ${renderVideoHTML()}' + nl + '    ${renderTransferHTML()}' + nl + '    ${renderFinancesHTML()}';
  if (src.indexOf(RENDER_BEFORE) < 0) { console.error(relPath + ': render list anchor not found'); return; }
  src = src.replace(RENDER_BEFORE, RENDER_AFTER);

  // ── 2. Add transfer title to navTo titles object ──────────────────────────
  var TITLE_BEFORE = "video:'Video Intelligence', finances:'Finances'";
  var TITLE_AFTER  = "video:'Video Intelligence', transfer:'Transfer Intelligence', finances:'Finances'";
  if (src.indexOf(TITLE_BEFORE) < 0) { console.error(relPath + ': navTo titles anchor not found'); return; }
  src = src.replace(TITLE_BEFORE, TITLE_AFTER);

  // ── 3. Add loadTransferData() to page load handler ───────────────────────
  var LOAD_BEFORE = "  if (page === 'video')       loadVideoIntelData();";
  var LOAD_AFTER  = "  if (page === 'video')       loadVideoIntelData();" + nl + "  if (page === 'transfer')    loadTransferData();";
  if (src.indexOf(LOAD_BEFORE) < 0) { console.error(relPath + ': loadVideoIntelData anchor not found'); return; }
  src = src.replace(LOAD_BEFORE, LOAD_AFTER);

  // ── 4. Add Transfer nav item after Video nav item ─────────────────────────
  var NAV_VIDEO_BLOCK = '      <div class="nav-item" onclick="navTo(\'video\',this)" data-page="video">';
  var navVidIdx = src.indexOf(NAV_VIDEO_BLOCK);
  if (navVidIdx < 0) { console.error(relPath + ': video nav item not found'); return; }
  // Find the end of the video nav-item block (next </div> followed by nl)
  var closingDiv = src.indexOf('</div>', navVidIdx);
  // Find the next </div> after the span
  closingDiv = src.indexOf('</div>', closingDiv + 1);
  var insertAfterNav = closingDiv + 6; // after </div>
  var TRANSFER_NAV = nl +
    '      <div class="nav-item" onclick="navTo(\'transfer\',this)" data-page="transfer">' + nl +
    '        <svg class="nav-icon" fill="currentColor" viewBox="0 0 20 20"><path d="M8 5a1 1 0 000 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z"/></svg>' + nl +
    '        <span class="nav-label">Transfer Intel</span>' + nl +
    '      </div>';
  // Check if already inserted
  if (src.indexOf('data-page="transfer"') >= 0) {
    console.log(relPath + ': transfer nav already present — skipping nav insertion');
  } else {
    src = src.slice(0, insertAfterNav) + TRANSFER_NAV + src.slice(insertAfterNav);
  }

  // ── 5. Insert transfer JS section before // ── FINANCES ── ────────────────
  var FINANCES_ANCHOR = '// ── FINANCES ──';
  if (src.indexOf(FINANCES_ANCHOR) < 0) { console.error(relPath + ': FINANCES anchor not found'); return; }
  // Check not already inserted
  if (src.indexOf('TRANSFER INTELLIGENCE CENTER') >= 0) {
    console.log(relPath + ': transfer section already present — skipping JS insertion');
  } else {
    // Convert app.js LF to mirror CRLF if needed
    var transferJSConverted = nl === '\r\n' ? TRANSFER_JS.replace(/\n/g, '\r\n') : TRANSFER_JS;
    src = src.replace(FINANCES_ANCHOR, transferJSConverted + nl + nl + FINANCES_ANCHOR);
  }

  // ── 6. Add transfer delegation handlers before </script> ─────────────────
  var SCRIPT_CLOSE = '</script>' + nl + '</body>' + nl + '</html>';
  if (src.indexOf(SCRIPT_CLOSE) < 0) { console.error(relPath + ': </script> close not found'); return; }
  if (src.indexOf('case \'tiRefresh\'') >= 0) {
    console.log(relPath + ': transfer delegation already present — skipping');
  } else {
    var DELEGATION = nl +
      '// ── Transfer Intelligence Center delegation ──────────────────────────────────' + nl +
      'document.addEventListener(\'click\', function(e) {' + nl +
      '  var el = e.target.closest(\'[data-action]\');' + nl +
      '  if (!el) return;' + nl +
      '  switch (el.dataset.action) {' + nl +
      '    case \'tiRefresh\':          loadTransferData();                              break;' + nl +
      '    case \'tiSwitchTab\':         tiSwitchTab(el.dataset.tab);                    break;' + nl +
      '    case \'tiOpenDetail\':        tiOpenDetail(el.dataset.id);                    break;' + nl +
      '    case \'tiCloseDetail\':       tiCloseDetail();                                break;' + nl +
      '    case \'tiOpenAddTarget\':     tiOpenAddTarget();                              break;' + nl +
      '    case \'tiCloseAddTarget\':    tiCloseAddTarget();                             break;' + nl +
      '    case \'tiSubmitAddTarget\':   tiSubmitAddTarget(null);                        break;' + nl +
      '    case \'tiAdvance\':           tiAdvance(el.dataset.id);                       break;' + nl +
      '    case \'tiReject\':            tiReject(el.dataset.id);                        break;' + nl +
      '    case \'tiLoadPlayerIntel\':   tiLoadPlayerIntel();                            break;' + nl +
      '    case \'tiRunCompare\':        tiRunCompare();                                 break;' + nl +
      '  }' + nl +
      '});' + nl +
      'document.addEventListener(\'submit\', function(e) {' + nl +
      '  var el = e.target.closest(\'[data-form-submit="tiSubmitAddTarget"]\');' + nl +
      '  if (el) tiSubmitAddTarget(e);' + nl +
      '});' + nl;

    src = src.replace(SCRIPT_CLOSE, DELEGATION + SCRIPT_CLOSE);
  }

  fs.writeFileSync(filePath, src);
  console.log(relPath + ' — updated OK (' + src.split('\n').length + ' lines)');
});
