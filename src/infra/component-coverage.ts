// Cyber Defense coverage per Infrastructure City component (R5)
// ─────────────────────────────────────────────────────────────────────────────
// Each building in the city answers one more question: which trust boundaries
// govern it, and how well Cyber Defense covers them. The answer is read from
// src/cyber-defense/coverage-map.json — the same reviewed map the posture test
// checks against the code — and never computed here, so the city cannot show a
// state the posture test has not agreed with.
//
// A component's state is the WEAKEST of its rows: a building that sits on one
// uncovered boundary is uncovered, however many others are covered.
//
// Row numbers and states only. Row names and reasons are review prose kept in
// the map; the city shows where to look, not the audit itself.

import fs from 'fs';
import path from 'path';

export type CoverageState = 'C' | 'P' | 'U';

export interface ComponentCoverage {
  state: CoverageState;
  rows: Array<{ id: number; coverage: CoverageState }>;
}

interface CoverageMapFile {
  boundaries?: Record<string, { coverage?: string }>;
  components?: { infrastructureComponents?: Record<string, number[]> };
}

const RANK: Record<CoverageState, number> = { U: 0, P: 1, C: 2 };

function candidatePaths(): string[] {
  // dist/infra in a built server (copy-runtime-assets puts the map in
  // dist/cyber-defense), src/infra under ts-node.
  return [
    path.join(__dirname, '..', 'cyber-defense', 'coverage-map.json'),
    path.join(__dirname, '..', '..', 'src', 'cyber-defense', 'coverage-map.json'),
  ];
}

let cached: Record<string, ComponentCoverage> | null = null;

/** Coverage for every mapped component, keyed by component id. Empty when the map cannot be read. */
export function componentCoverage(): Record<string, ComponentCoverage> {
  if (cached) return cached;
  let map: CoverageMapFile | null = null;
  for (const p of candidatePaths()) {
    try { map = JSON.parse(fs.readFileSync(p, 'utf8')) as CoverageMapFile; break; } catch { /* next */ }
  }
  const out: Record<string, ComponentCoverage> = {};
  const rows = map?.boundaries ?? {};
  for (const [id, rowIds] of Object.entries(map?.components?.infrastructureComponents ?? {})) {
    const resolved = rowIds
      .map((n) => ({ id: n, coverage: rows[String(n)]?.coverage as CoverageState | undefined }))
      .filter((r): r is { id: number; coverage: CoverageState } => r.coverage === 'C' || r.coverage === 'P' || r.coverage === 'U')
      .sort((a, b) => a.id - b.id);
    if (!resolved.length) continue;
    const state = resolved.reduce<CoverageState>((w, r) => (RANK[r.coverage] < RANK[w] ? r.coverage : w), 'C');
    out[id] = { state, rows: resolved };
  }
  cached = out;
  return out;
}

/** Tests only. */
export function resetComponentCoverage(): void { cached = null; }
