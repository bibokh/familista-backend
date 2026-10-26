// Familista — publish the orchestrator's LAB evidence
// ─────────────────────────────────────────────────────────────────────────────
//   FAMILISTA_ENV=LAB npm run lab:orchestrator:evidence            write it
//   FAMILISTA_ENV=LAB npm run lab:orchestrator:evidence -- --check  fail if the committed file is stale
//
// Writes src/platform/agents/generated/orchestration-evidence.json (evidence.ts).
// Outside the Lab it refuses and writes nothing.

import '../../src/config/zod'; // zod 4 with zod 3's messages, as the server has them, before anything validates
import { buildEvidence, EVIDENCE_FILE, readCommittedEvidence, serialise, writeEvidence } from './evidence';

try {
  const evidence = buildEvidence();
  const fresh = serialise(evidence);
  for (const r of evidence.runs) {
    process.stdout.write(`${r.scenario.padEnd(28)} ${r.outcome.padEnd(18)} ${String(r.tasks.length).padStart(2)} tasks  ${String(r.trace.length).padStart(3)} events  ${r.id.slice(0, 16)}\n`);
  }
  if (process.argv.includes('--check')) {
    if (readCommittedEvidence() !== fresh) {
      process.stderr.write(`${EVIDENCE_FILE} is stale: run FAMILISTA_ENV=LAB npm run lab:orchestrator:evidence\n`);
      process.exit(1);
    }
    process.stdout.write(`current: ${EVIDENCE_FILE} (digest ${evidence.digest.slice(0, 16)})\n`);
  } else {
    writeEvidence(evidence);
    process.stdout.write(`wrote ${EVIDENCE_FILE} (digest ${evidence.digest.slice(0, 16)})\n`);
  }
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
