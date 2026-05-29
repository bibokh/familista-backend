/**
 * Transforms public/index.html:
 * 1. Replaces <style>...</style> with <link rel="stylesheet" href="/app.css">
 * 2. Replaces <script>...</script> with <script src="/app.js" defer></script>
 * 3. Replaces 53 inline event handlers with data-* attributes (strict CSP)
 */
const fs = require('fs');

// Normalize CRLF → LF
let html = fs.readFileSync('public/index.html', 'utf8').replace(/\r\n/g, '\n');

let changes = 0;
function replace(from, to, label) {
  if (!html.includes(from)) { console.error('NOT FOUND:', label); return; }
  html = html.replace(from, to);
  changes++;
  console.log('OK:', label);
}

// ── 1. Replace <style>...</style> with external link ──────────────────────────
const styleStart = '<style>\n/* ============================================================\n   FAMILISTA v5 — PRODUCTION — Full Backend Integration\n   ============================================================ */';
const styleTagEnd = '</style>\n</head>';
const styleStartIdx = html.indexOf(styleStart);
const styleEndIdx   = html.indexOf(styleTagEnd);
if (styleStartIdx === -1) { console.error('NOT FOUND: <style> block start'); process.exit(1); }
if (styleEndIdx   === -1) { console.error('NOT FOUND: </style></head>');     process.exit(1); }
html = html.slice(0, styleStartIdx)
  + '<link rel="stylesheet" href="/app.css">\n</head>'
  + html.slice(styleEndIdx + styleTagEnd.length);
console.log('OK: <style> → <link rel="stylesheet" href="/app.css">');
changes++;

// ── 2. Replace <script>...</script> with external src ─────────────────────────
const scriptOpen  = '\n<script>\n/* ============================================================\n   FAMILISTA v5 — COMPLETE PRODUCTION APPLICATION\n   Full Backend Integration — Live API Data\n   ============================================================ */';
const scriptClose = '\n</script>\n</body>\n</html>';
const scriptStartIdx = html.indexOf(scriptOpen);
const scriptEndIdx   = html.lastIndexOf(scriptClose);
if (scriptStartIdx === -1) { console.error('NOT FOUND: <script> block start'); process.exit(1); }
if (scriptEndIdx   === -1) { console.error('NOT FOUND: </script></body>');     process.exit(1); }
html = html.slice(0, scriptStartIdx)
  + '\n<script src="/app.js" defer></script>\n</body>\n</html>'
  + html.slice(scriptEndIdx + scriptClose.length);
console.log('OK: <script> → <script src="/app.js" defer>');
changes++;

// ── 3. Inline handlers → data-* attributes ────────────────────────────────────

// Mobile overlay / header
replace(
  'class="mobile-overlay" id="mobile-overlay" onclick="closeMobileMenu()"',
  'class="mobile-overlay" id="mobile-overlay" data-action="closeMobileMenu"',
  'mobile-overlay closeMobileMenu'
);
replace(
  'class="mobile-menu-btn" onclick="toggleMobileMenu()"',
  'class="mobile-menu-btn" data-action="toggleMobileMenu"',
  'mobile-menu-btn toggleMobileMenu'
);

// Auth buttons
replace(
  'class="login-btn" id="login-btn" onclick="doLogin()"',
  'class="login-btn" id="login-btn" data-action="doLogin"',
  'login-btn doLogin'
);
replace(
  'class="login-btn" id="fp-btn" onclick="doForgotPassword()"',
  'class="login-btn" id="fp-btn" data-action="doForgotPassword"',
  'fp-btn doForgotPassword'
);
replace(
  'class="login-btn" id="rp-btn" onclick="doResetPassword()"',
  'class="login-btn" id="rp-btn" data-action="doResetPassword"',
  'rp-btn doResetPassword'
);
replace(
  'class="login-btn" onclick="showAuthView(\'forgot\')"',
  'class="login-btn" data-show-auth="forgot"',
  'login-btn showAuthView(forgot)'
);
replace(
  'class="login-btn" onclick="showAuthView(\'login\')"',
  'class="login-btn" data-show-auth="login"',
  'login-btn showAuthView(login)'
);

// Auth <a> links — each has unique surrounding context
replace(
  '<a class="auth-link" onclick="showAuthView(\'forgot\')">Forgot your password?</a>',
  '<a class="auth-link" data-show-auth="forgot">Forgot your password?</a>',
  'auth-link showAuthView(forgot)'
);
// There are 4 "← Back to sign in" links on different auth views
replace(
  '<div data-auth-view="forgot">\n      <div class="auth-title">Reset your password</div>\n      <div class="auth-sub">Enter your account email and we\'ll send you a reset link. It expires in 1 hour.</div>\n      <div class="login-error" id="fp-error"></div>\n      <label class="login-label">Email address</label>\n      <input class="login-input" id="fp-email" type="email" placeholder="you@club.com">\n      <button class="login-btn" id="fp-btn" data-action="doForgotPassword">Send Reset Link</button>\n      <div class="auth-link-center">\n        <a class="auth-link" onclick="showAuthView(\'login\')">← Back to sign in</a>',
  '<div data-auth-view="forgot">\n      <div class="auth-title">Reset your password</div>\n      <div class="auth-sub">Enter your account email and we\'ll send you a reset link. It expires in 1 hour.</div>\n      <div class="login-error" id="fp-error"></div>\n      <label class="login-label">Email address</label>\n      <input class="login-input" id="fp-email" type="email" placeholder="you@club.com">\n      <button class="login-btn" id="fp-btn" data-action="doForgotPassword">Send Reset Link</button>\n      <div class="auth-link-center">\n        <a class="auth-link" data-show-auth="login">← Back to sign in</a>',
  'forgot-view back-to-login link'
);
replace(
  '<div data-auth-view="forgot-sent">\n      <div class="auth-checking-wrap">\n        <div class="auth-icon-lg">📧</div>\n        <div class="auth-title">Check your inbox</div>\n        <div class="auth-sub" style="margin-top:8px;">If that email is registered you\'ll receive a reset link shortly. Check your spam folder if it doesn\'t arrive.</div>\n      </div>\n      <div class="auth-link-center">\n        <a class="auth-link" onclick="showAuthView(\'login\')">← Back to sign in</a>',
  '<div data-auth-view="forgot-sent">\n      <div class="auth-checking-wrap">\n        <div class="auth-icon-lg">📧</div>\n        <div class="auth-title">Check your inbox</div>\n        <div class="auth-sub" style="margin-top:8px;">If that email is registered you\'ll receive a reset link shortly. Check your spam folder if it doesn\'t arrive.</div>\n      </div>\n      <div class="auth-link-center">\n        <a class="auth-link" data-show-auth="login">← Back to sign in</a>',
  'forgot-sent-view back-to-login link'
);
replace(
  '<button class="login-btn" data-show-auth="forgot">Request a New Link</button>\n      <div class="auth-link-center">\n        <a class="auth-link" onclick="showAuthView(\'login\')">← Back to sign in</a>',
  '<button class="login-btn" data-show-auth="forgot">Request a New Link</button>\n      <div class="auth-link-center">\n        <a class="auth-link" data-show-auth="login">← Back to sign in</a>',
  'reset-invalid-view back-to-login link'
);

// Sidebar brand (toggleSidebar)
replace(
  'class="brand" onclick="toggleSidebar()"',
  'class="brand" data-action="toggleSidebar"',
  'brand toggleSidebar'
);

// Club card nav (navTo club, null)
replace(
  'class="club-card" onclick="navTo(\'club\',null)"',
  'class="club-card" data-nav="club"',
  'club-card navTo(club,null)'
);

// Nav items — replace onclick with data-nav (each is unique by page name)
const navItems = [
  'dashboard', 'tactical-os', 'squad', 'training', 'matches',
  'tournaments', 'analytics', 'medical', 'scouting', 'video',
  'transfer', 'stats', 'ai', 'quantum', 'finances', 'devices',
  'club', 'settings'
];
for (const page of navItems) {
  // nav items pass `this`
  replace(
    `onclick="navTo('${page}',this)"`,
    `data-nav="${page}"`,
    `nav-item navTo(${page},this)`
  );
}
// quantum uses no-this form in one place — covered above; verify club nav-item
// club card (navTo club null) already handled above

// Sidebar footer buttons
replace(
  'class="footer-btn" onclick="toggleTheme()" title="Toggle theme"',
  'class="footer-btn" data-action="toggleTheme" title="Toggle theme"',
  'footer-btn toggleTheme'
);
replace(
  'class="footer-btn" onclick="doLogout()" title="Logout"',
  'class="footer-btn" data-action="doLogout" title="Logout"',
  'footer-btn doLogout'
);

// Context switcher (onchange)
replace(
  'class="ctx-select" id="ctx-club"  onchange="onContextClubChange()"',
  'class="ctx-select" id="ctx-club"  data-change="onContextClubChange"',
  'ctx-club onchange'
);
replace(
  'class="ctx-select" id="ctx-team"  onchange="onContextTeamChange()"',
  'class="ctx-select" id="ctx-team"  data-change="onContextTeamChange"',
  'ctx-team onchange'
);

// Player modal buttons (State.activePlayer?.id — resolved at call time)
replace(
  'onclick="openEditPlayerModal(State.activePlayer?.id)"',
  'data-action="openEditPlayerModal"',
  'player-modal-edit-btn'
);
replace(
  'onclick="confirmDeletePlayer(State.activePlayer?.id)"',
  'data-action="confirmDeletePlayer"',
  'player-modal-delete-btn'
);

// Modal close buttons
replace(
  'class="modal-close" onclick="closeModal(\'player-modal\')"',
  'class="modal-close" data-close-modal="player-modal"',
  'modal-close player-modal'
);
replace(
  'class="modal-close" onclick="closeModal(\'player-edit-modal\')"',
  'class="modal-close" data-close-modal="player-edit-modal"',
  'modal-close player-edit-modal (header)'
);
replace(
  'class="btn btn-outline btn-sm" onclick="closeModal(\'player-edit-modal\')"',
  'class="btn btn-outline btn-sm" data-close-modal="player-edit-modal"',
  'modal-close player-edit-modal (cancel btn)'
);

// Player edit form submit
replace(
  'id="player-edit-form" onsubmit="submitPlayerForm(event)"',
  'id="player-edit-form" data-form-submit="submitPlayerForm"',
  'player-edit-form onsubmit'
);

// Match modal close
replace(
  'class="modal-close" onclick="closeMatchModal()"',
  'class="modal-close" data-action="closeMatchModal"',
  'match-modal close'
);

// Match modal tabs
const matchTabs = [
  'overview','lineup','timeline','tactical','live','fusion',
  'brain','spatial','predict','replay','ai'
];
for (const tab of matchTabs) {
  replace(
    `onclick="setMatchModalTab('${tab}',this)"`,
    `data-match-tab="${tab}"`,
    `match-tab ${tab}`
  );
}

// ── Verify no inline handlers remain in static HTML ───────────────────────────
// Check only the static HTML section (before <script src=)
const staticHtmlEnd = html.indexOf('\n<script src="/app.js" defer>');
const staticPart = staticHtmlEnd > 0 ? html.slice(0, staticHtmlEnd) : html;
const remaining = (staticPart.match(/\s(onclick|onchange|onsubmit|oninput)=/gi) || []);
if (remaining.length > 0) {
  console.error('\nREMAINING INLINE HANDLERS IN STATIC HTML:', remaining.length);
  // Show context
  const lines = staticPart.split('\n');
  lines.forEach((line, i) => {
    if (/\s(onclick|onchange|onsubmit|oninput)=/.test(line)) {
      console.error(`  Line ${i+1}: ${line.trim().slice(0,100)}`);
    }
  });
  process.exit(1);
}

// Write transformed index.html
fs.writeFileSync('public/index.html', html, 'utf8');
console.log(`\nTotal changes: ${changes}`);
console.log('Verification: PASSED (0 inline handlers in static HTML)');
console.log('index.html lines:', html.split('\n').length);
