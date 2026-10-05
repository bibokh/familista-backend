// A fixture allow-list: the lab children load it only when a test names it
// through LAB_CANDIDATE_INDEX, and only from under tests/fixtures/lab/.

import type { CandidateIndexEntry } from '../../../../lab/algorithms/candidates';

export const CANDIDATE_INDEX: readonly CandidateIndexEntry[] = [
  { id: 'hang-v9.9', algorithm: 'xg', file: 'hang-v9.9.ts' },
];
