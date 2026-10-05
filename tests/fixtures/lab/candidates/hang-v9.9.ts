// A fixture candidate whose computeXG never returns. It declares itself first,
// as every candidate does, then hangs on its first shot: the parent must kill
// it at the time limit and still record what was proposed.

import type { ShotFeatures } from '../../../../src/match-events/xg-model.service';
import type { CandidateDeclaration } from '../../../../src/algorithms/candidate-evidence';

export const CANDIDATE: CandidateDeclaration = {
  id: 'hang-v9.9',
  algorithm: 'xg',
  version: 'v9.9',
  baseline: { version: 'v1.0', fingerprint: 'c9d12afe302d5d60f4966855a2287e4175b57397d64eed2c9fb4ad25a81dfbe5' },
  rationale: 'A test fixture that never returns.',
  hypothesis: { targets: [], region: 'Nowhere: it never returns.' },
  evidence: [{ kind: 'PROPERTY', ref: 'none', note: 'A test fixture.' }],
  proposedBy: 'PLATFORM_OWNER',
  proposedAt: '2026-10-05',
};

export function computeXG(_f: ShotFeatures): number {
  for (;;) { /* never returns */ }
}
