#!/usr/bin/env node
// Analytics maintenance — summarise finished days, then apply retention
// ─────────────────────────────────────────────────────────────────────────────
//   node dist/scripts/analytics-maintenance.js [--days=7] [--no-sweep]
//
// Two jobs, in one place, run on every boot.
//
//   ROLL UP   yesterday and the days before it, so the dashboard reads a
//             summary rather than counting raw events. Idempotent: every row
//             is upserted on (day, environment, metric, dimension), so
//             re-running a day corrects it and never doubles it. Today is
//             deliberately skipped — it is not over, and a partial day written
//             as a final figure is a wrong figure that looks final.
//   SWEEP     delete raw events past their retention, keeping the rollups.
//             The policy is configurable and is never "forever".
//
// Safe to run at any time, safe to run twice, and it never fails a boot: an
// error is printed and the process exits 0, because the API starting matters
// more than yesterday's summary being current.

import { rollupRecent, sweepRetention } from '../platform/analytics/rollup';
import { analyticsEnvironment } from '../platform/analytics/service';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

async function main(): Promise<void> {
  const environment = analyticsEnvironment();
  const days = Number(arg('days') ?? 7);

  console.log('');
  console.log('== analytics maintenance ==');
  console.log(`   environment                  ${environment}`);

  const rolled = await rollupRecent(environment, { maxDays: Number.isFinite(days) ? days : 7 });
  const rows = rolled.reduce((n, r) => n + r.rowsWritten, 0);
  console.log(`   days summarised              ${rolled.length} (${rows} metric rows)`);

  if (process.argv.includes('--no-sweep')) {
    console.log('   retention sweep              skipped (--no-sweep)');
    return;
  }
  const swept = await sweepRetention();
  console.log(`   raw retention                ${swept.policy.rawDays} days (${swept.policy.source.raw})`);
  console.log(`   rollup retention             ${Math.max(swept.policy.rollupDays, swept.policy.rawDays)} days (${swept.policy.source.rollup})`);
  console.log(`   raw events deleted           ${swept.rawDeleted}`);
  console.log(`   rollup rows deleted          ${swept.rollupDeleted}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Never fatal. A stale summary is not a reason to keep the API down.
    console.log(`   (analytics maintenance skipped: ${err instanceof Error ? err.message : String(err)})`);
    process.exit(0);
  });
