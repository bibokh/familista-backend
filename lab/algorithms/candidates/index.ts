// Familista — the candidate allow-list
// ─────────────────────────────────────────────────────────────────────────────
// Every candidate the lab will run, by id. Only this list decides which file a
// child process loads: a job names an id, never a path. It imports no
// candidate — reading it runs no candidate code — so the parent process can
// read it, fingerprint each file as text, and leave execution to the children.
//
// Adding a candidate is a reviewed change to this file and a new file beside
// it; lab/algorithms/README.md walks through it.

import type { CandidateAlgorithm } from '../spec';

export interface CandidateIndexEntry {
  id: string;
  algorithm: CandidateAlgorithm;
  /** A file in this directory. */
  file: string;
}

export const CANDIDATE_INDEX: readonly CandidateIndexEntry[] = [
  { id: 'xg-v1.1', algorithm: 'xg', file: 'xg-v1.1.ts' },
];
