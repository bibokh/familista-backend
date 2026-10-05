// Familista — the lab's child-process entry point
// ─────────────────────────────────────────────────────────────────────────────
// Started only by runner.ts, never by the server: one job named on the command
// line, its report written to stdout as JSON lines. It does not exit early or
// install signal handlers — the parent's SIGKILL is the only stop it needs.

import { runJob } from './jobs';

runJob(process.argv[2] ?? '', (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
