// Cyber Defense, Step 9 — the checks a GitHub Actions workflow must pass.
// ─────────────────────────────────────────────────────────────────────────────
// Pure text checks, shared by scripts/security-discover.js (which records the
// result as posture controls) and by the tests (which prove each check catches
// the pattern it exists for). No YAML parser: the checks read the workflow the
// way a reviewer does, and they must not depend on a transitive package.

'use strict';

/**
 * True when a `${{ }}` expression is expanded inside a `run:` script — the
 * pattern that turns an attacker-influenced value (a dispatch input, a branch
 * name, a PR title) into shell code. Values belong in `env:` and are read as
 * variables. Comment lines are ignored.
 */
function expressionInScript(src) {
  const lines = String(src || '').split('\n');
  let inRun = false;
  let runIndent = -1;
  for (const line of lines) {
    const indent = line.search(/\S/);
    if (inRun && indent !== -1 && indent <= runIndent) inRun = false;
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (m) {
      if (/\$\{\{/.test(m[2])) return true;
      inRun = /^[|>]/.test(m[2]);
      runIndent = m[1].length;
      continue;
    }
    if (inRun && /\$\{\{/.test(line) && !/^\s*#/.test(line)) return true;
  }
  return false;
}

/** `permissions: contents: read` at the top, and no write scope anywhere. */
function leastPrivilege(src) {
  const s = String(src || '');
  return /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(s) && !/:\s*write\b/.test(s);
}

/** Every `uses:` reference, with whether it is pinned to a full commit SHA. */
function actionRefs(src) {
  return [...String(src || '').matchAll(/uses:\s*([^\s#]+)/g)].map((m) => ({
    ref: m[1],
    pinned: /@[0-9a-f]{40}$/.test(m[1]),
  }));
}

module.exports = { expressionInScript, leastPrivilege, actionRefs };
