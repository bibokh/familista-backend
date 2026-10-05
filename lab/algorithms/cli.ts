// Familista — the lab's command line
// ─────────────────────────────────────────────────────────────────────────────
//   npm run algorithms:candidates           regenerate the candidate evidence
//   npm run algorithms:candidates:check     fail if the committed evidence is stale
//
// Every job runs in its own child process (runner.ts). If this process is
// interrupted, its children's process groups are killed on the way out.

import { buildEvidence, deterministicView, firstDifference, readCommittedEvidence, writeEvidence, EVIDENCE_FILE } from './evidence';
import { killActiveChildren } from './runner';

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { killActiveChildren(); process.exit(130); });
}
process.on('exit', () => killActiveChildren());

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const { evidence, children } = await buildEvidence();
  for (const { job, outcome } of children) {
    process.stdout.write(`${job.padEnd(24)} ${outcome.state.padEnd(13)} ${Math.round(outcome.wallMs)} ms\n`);
  }
  for (const c of evidence.candidates) process.stdout.write(`${c.id.padEnd(24)} Test ${c.verdict.test} ${c.verdict.reasons.join(' ')}\n`);
  if (!check) {
    writeEvidence(evidence);
    process.stdout.write(`wrote ${EVIDENCE_FILE}\n`);
    return;
  }
  let committed: unknown;
  try { committed = readCommittedEvidence(); } catch { committed = null; }
  const diff = firstDifference(deterministicView(committed), deterministicView(evidence));
  if (diff) {
    process.stderr.write(`candidate evidence is stale at ${diff}: run npm run algorithms:candidates and commit the result\n`);
    process.exitCode = 1;
  } else process.stdout.write('candidate evidence is current\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
