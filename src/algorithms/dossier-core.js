// Familista — the digest that binds a human approval to its evidence
// ─────────────────────────────────────────────────────────────────────────────
// A CHANGE approval in src/algorithms/registry.ts names an approval dossier
// (src/algorithms/approvals/) and the SHA-256 of that dossier's content. This
// file is the ONE implementation of that digest, shared by the server
// (approval-dossier.ts), the lab's release tool (lab/algorithms/release/) and
// the Cybersecurity scan (scripts/security-discover.js), so the three can never
// disagree about what a dossier says.
//
// The digest is over canonical JSON: object keys sorted at every level, no
// whitespace, values as JSON writes them. Reformatting the file or reordering
// its keys is therefore not a change; changing any value is.
//
// Nothing here reads the environment, the clock or a database.
'use strict';

const crypto = require('crypto');

/** JSON with object keys sorted at every level: one byte string per value. */
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('a dossier holds finite numbers only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** SHA-256, hex, of a value's canonical JSON. */
const digestOf = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');

module.exports = { canonical, digestOf };
