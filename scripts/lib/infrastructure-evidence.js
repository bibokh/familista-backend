// Infrastructure evidence — two decisions the infrastructure manifest takes from
// repository text, kept here as pure functions so a test can prove each one on
// fixtures as well as on the real repository.
// ─────────────────────────────────────────────────────────────────────────────
// Used by scripts/infrastructure-discover.js. No YAML parser and no dependency:
// the checks read a workflow the way a reviewer does.

'use strict';

/**
 * The workflow with YAML and shell comments removed, so a sentence ABOUT a
 * deploy hook never counts as a call TO one. A `#` starts a comment at the start
 * of a line, or after whitespace.
 */
function withoutComments(src) {
  return String(src || '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s#.*$/, ''))
    .join('\n');
}

/**
 * True when a workflow can move a Render service: it reads a Render deploy hook
 * from a GitHub secret into a variable, and POSTs to that variable.
 *
 * render.yaml sets `autoDeploy: false`, so this hook is the only automatic path
 * to production. A workflow that merely mentions the hook, reads the secret but
 * never calls it, or calls some other URL, does not deploy.
 */
function deploysViaRenderHook(src) {
  const code = withoutComments(src);
  const vars = [...code.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*secrets\.(RENDER_[A-Z0-9_]*DEPLOY_HOOK[A-Z0-9_]*)\s*\}\}\s*$/gm)]
    .map((m) => m[1]);
  return vars.some((v) => new RegExp(`curl\\b[^\\n]*-X\\s+POST[^\\n]*\\$(?:\\{${v}\\}|${v}(?![A-Z0-9_]))`).test(code));
}

/**
 * A district's status, from what the repository placed in it.
 *
 *   ACTIVE          at least one of its components is ACTIVE in this build
 *   <shared state>  none is ACTIVE and all share one state (e.g. NOT_CONFIGURED)
 *   FUTURE          it holds future plots and no component
 *   UNKNOWN         anything else — never a comfortable default
 *
 * Like a component's status, this is what the repository proves, not what is
 * running; runtime health is a separate layer.
 */
function districtStatus(componentStatuses, futureCount) {
  const states = (componentStatuses || []).filter(Boolean);
  if (states.includes('ACTIVE')) return 'ACTIVE';
  if (states.length) {
    const distinct = [...new Set(states)];
    return distinct.length === 1 ? distinct[0] : 'UNKNOWN';
  }
  return futureCount > 0 ? 'FUTURE' : 'UNKNOWN';
}

module.exports = { withoutComments, deploysViaRenderHook, districtStatus };
