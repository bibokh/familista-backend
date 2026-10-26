// Familista — the orchestrator's LAB runner
// ─────────────────────────────────────────────────────────────────────────────
//   FAMILISTA_ENV=LAB npm run lab:orchestrator          every scenario, summarised
//   FAMILISTA_ENV=LAB npm run lab:orchestrator -- --trace   and each run's full trace
//
// Runs the synthetic scenarios (scenarios.ts) over the platform's real Agent
// Registry. The process must say it is the Lab; anywhere else the orchestrator
// refuses every plan, and this prints that refusal.

import '../../src/config/zod'; // zod 4 with zod 3's messages, as the server has them, before anything validates
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import { decideApproval, startRun, type PlanRun } from './engine';
import { labOperations } from './operations';
import { approveLiveChange, liveAdjustment, matchPreparation, medicalBoundary, partialFailure } from './scenarios';

const ctx = { registry: platformAgentRegistry(), operations: labOperations() };
const showTrace = process.argv.includes('--trace');

function print(name: string, run: PlanRun): void {
  process.stdout.write(`\n${name}  ${run.outcome}  digest ${run.digest.slice(0, 16)}  registry ${run.registryDigest.slice(0, 16)}\n`);
  if (run.refusal) process.stdout.write(`  refused ${run.refusal.code}: ${run.refusal.message}\n`);
  for (const t of run.tasks) {
    const why = t.reason ? `  ${t.reason.code}: ${t.reason.message}` : t.approval && !t.approval.decision ? `  approvers: ${t.approval.eligibleRoles.join(', ') || 'none may read it'}` : '';
    process.stdout.write(`  ${t.id.padEnd(16)} ${t.state.padEnd(18)} ${(t.agent?.id ?? '-').padEnd(18)} ${t.operation}${why}\n`);
  }
  if (showTrace) for (const e of run.trace) process.stdout.write(`    ${String(e.seq).padStart(3)} ${e.type.padEnd(26)} ${(e.taskId ?? '').padEnd(15)} ${e.code ?? ''} ${e.detail}\n`);
}

print('match-preparation', startRun(matchPreparation(), ctx));
const waiting = startRun(liveAdjustment(), ctx);
print('live-adjustment (before the decision)', waiting);
print('live-adjustment (approved by the club admin)', decideApproval(waiting, approveLiveChange(), ctx));
print('medical-boundary', startRun(medicalBoundary(), ctx));
print('partial-failure', startRun(partialFailure(), ctx));
