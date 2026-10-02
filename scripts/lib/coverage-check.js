// Cyber Defense, R5 — does the coverage map declare everything the code has?
// ─────────────────────────────────────────────────────────────────────────────
// Pure: the discovered components (from scripts/security-discover.js), the map
// (src/cyber-defense/coverage-map.json) and each control's status go in; the
// findings come out. Shared by the scanner and its fixture tests, so the rule
// the tests prove is the rule CI runs.

'use strict';

/**
 * @param {Record<string,string[]>} discovered  kind → component names found in the code
 * @param {{boundaries?:object, components?:object}} map
 * @param {Record<string,string>} controlStatus control id → PRESENT | PARTIAL | ABSENT
 * @param {(file:string)=>boolean} fileExists
 */
function checkCoverage(discovered, map, controlStatus, fileExists) {
  const rows = (map && map.boundaries) || {};
  const rowIds = new Set(Object.keys(rows));
  const declaredAll = (map && map.components) || {};
  const out = { unmapped: [], stale: [], badRow: [], rowProblems: [], counts: { C: 0, P: 0, U: 0 } };

  for (const [kind, names] of Object.entries(discovered)) {
    const declared = declaredAll[kind] || {};
    for (const n of names) {
      const r = declared[n];
      if (!Array.isArray(r) || r.length === 0) out.unmapped.push(`${kind}: ${n}`);
      else for (const id of r) if (!rowIds.has(String(id))) out.badRow.push(`${kind}: ${n} → row ${id}`);
    }
    for (const n of Object.keys(declared)) if (!names.includes(n)) out.stale.push(`${kind}: ${n}`);
  }
  for (const k of Object.keys(declaredAll)) if (!(k in discovered)) out.stale.push(`${k}: (unknown component kind)`);

  for (const [id, row] of Object.entries(rows)) {
    out.counts[row.coverage] = (out.counts[row.coverage] || 0) + 1;
    const ctl = row.controls || [];
    for (const c of ctl) if (!(c in controlStatus)) out.rowProblems.push(`row ${id}: unknown control ${c}`);
    if (row.coverage === 'C') {
      const pinned = (row.pinnedBy || []).filter(fileExists);
      if (!ctl.length && !pinned.length) out.rowProblems.push(`row ${id}: covered with no control and no pinning test`);
      for (const c of ctl) if (controlStatus[c] && controlStatus[c] !== 'PRESENT') out.rowProblems.push(`row ${id}: covered, but ${c} is ${controlStatus[c]}`);
      if ((row.pinnedBy || []).length !== pinned.length) out.rowProblems.push(`row ${id}: a pinning test does not exist`);
    } else if (row.coverage !== 'P' && row.coverage !== 'U') out.rowProblems.push(`row ${id}: coverage must be C, P or U`);
    else if (!row.reason || !row.plannedIn) out.rowProblems.push(`row ${id}: ${row.coverage} needs a reason and the batch that closes it`);
  }
  return out;
}

/** The ratchet: uncovered may only fall, and partial + uncovered together may only fall. */
function ratchetHolds(counts, ratchet) {
  return Number.isInteger(ratchet && ratchet.U) && Number.isInteger(ratchet && ratchet.P)
    && counts.U <= ratchet.U && counts.P + counts.U <= ratchet.P + ratchet.U;
}

module.exports = { checkCoverage, ratchetHolds };
