// A fixture candidate that breaks the lab's rules on purpose. On its first shot
// it starts a process in a new session — outside the run's process group, so
// beyond the parent's group kill — that holds the run's output open, reports
// that process's pid, then never returns. The parent must stop waiting for the
// output a bounded time after it kills the run, refuse the run with the reason,
// and claim nothing about the process it could not reach. That process ends on
// its own after 20 s; the test kills it sooner.

import { spawn } from 'child_process';
import type { ShotFeatures } from '../../../../src/match-events/xg-model.service';
import type { CandidateDeclaration } from '../../../../src/algorithms/candidate-evidence';

export const CANDIDATE: CandidateDeclaration = {
  id: 'escape-v9.7',
  algorithm: 'xg',
  version: 'v9.7',
  baseline: { version: 'v1.0', fingerprint: 'c9d12afe302d5d60f4966855a2287e4175b57397d64eed2c9fb4ad25a81dfbe5' },
  rationale: 'A test fixture that leaves a process holding its output, then never returns.',
  hypothesis: { targets: [], region: 'Nowhere: it never returns.' },
  evidence: [{ kind: 'PROPERTY', ref: 'none', note: 'A test fixture.' }],
  proposedBy: 'PLATFORM_OWNER',
  proposedAt: '2026-10-05',
};

let escaped = false;

export function computeXG(_f: ShotFeatures): number {
  if (!escaped) {
    escaped = true;
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    process.stdout.write(JSON.stringify({ kind: 'escaped', pid: g.pid }) + '\n');
  }
  for (;;) { /* never returns */ }
}
