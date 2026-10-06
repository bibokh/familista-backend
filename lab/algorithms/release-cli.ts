// Familista — the release tool's command line (Algorithms Step 5)
// ─────────────────────────────────────────────────────────────────────────────
//   npm run algorithms:release -- plan <candidate>
//       Could the platform owner approve this candidate, and what would the
//       approval be bound to? Writes nothing.
//   npm run algorithms:release -- apply <candidate> --reference <owner>/<repo>#<pr> [--date yyyy-mm-dd]
//       Write the promotion into this tree, for the pull request named. Commits
//       nothing; the approval takes effect only when that pull request merges.
//   npm run algorithms:release -- rollback <candidate>
//       Undo a promotion whose archive is in this tree, exactly.
//   npm run algorithms:release -- verify [--deep] [--no-reproduce]
//       Every gate, binding, archive and reproduction in this tree.
//   npm run algorithms:release -- rehearse <candidate> [--keep]
//       plan → apply → verify → rollback → verify in a temporary copy.
//   npm run algorithms:release -- engine
//       The evaluation engine's pin, as a dossier would record it now.
//
// Add --json for one JSON document on stdout. The exit code is 0 only when the
// command did what it was asked: a refused plan exits 1. Every job runs in its
// own child process (runner.ts); an interrupted command kills them on the way
// out.

import { LAB_ROOT, killActiveChildren } from './runner';
import { planRelease, type ReleasePlan } from './release/dossier';
import { enginePin } from './release/engine';
import { rehearse } from './release/rehearsal';
import { ReleaseRefusal } from './release/source';
import { verifyReleases } from './release/verify';
import { applyRelease, rollbackRelease } from './release/workspace';

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { killActiveChildren(); process.exit(130); });
}
process.on('exit', () => killActiveChildren());

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? '' : null; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--reference', '--date'].includes(argv[i - 1])));

function print(value: unknown, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

/** A plan as printed: everything but the three source texts. */
const shown = (p: ReleasePlan) => ({ ...p, texts: undefined });

function describePlan(p: ReleasePlan): string {
  const lines = [`${p.candidate}: ${p.state}${p.refusals.length ? ` — ${p.refusals.join(', ')}` : ''}`];
  for (const r of p.runs) lines.push(`  ${r.job.padEnd(24)} ${r.state.padEnd(13)} ${Math.round(r.wallMs)} ms`);
  for (const d of p.dependants) lines.push(`  dependant ${d.key.padEnd(14)} ${d.path}${d.calls.length ? ` (calls ${d.calls.join(', ')})` : ''}${d.simulated ? ', simulated' : ''}`);
  if (p.dossier) {
    lines.push(`  ${p.dossier.baseline.version} → ${p.dossier.candidate.version}  fingerprint ${p.dossier.candidate.fingerprint}`);
    lines.push(`  dossier digest ${p.digest}`);
    lines.push(`  engine ${p.dossier.engine.fingerprint} (spec v${p.dossier.engine.specVersion}, ${p.dossier.engine.files.length} modules, commit ${p.dossier.engine.commit ?? 'none'})`);
    lines.push(`  limits: ${p.dossier.limits.join(', ')}`);
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const [command, id] = positional;
  switch (command) {
    case 'plan': {
      if (!id) throw new Error('plan <candidate>');
      const p = await planRelease(id);
      print(shown(p), describePlan(p));
      return p.state === 'READY' ? 0 : 1;
    }
    case 'apply': {
      if (!id) throw new Error('apply <candidate> --reference <owner>/<repo>#<pr>');
      const reference = option('--reference') ?? '';
      const approvedAt = option('--date') ?? new Date().toISOString().slice(0, 10);
      const p = await planRelease(id);
      if (p.state !== 'READY') { print({ applied: false, plan: shown(p) }, describePlan(p)); return 1; }
      const written = applyRelease(p, { reference, approvedAt });
      print({ applied: true, digest: p.digest, ...written }, `${describePlan(p)}\n  wrote ${written.written.join(', ')}\n  removed ${written.removed.join(', ')}\n  regenerated ${written.regenerated.join(', ')}`);
      return 0;
    }
    case 'rollback': {
      if (!id) throw new Error('rollback <candidate>');
      const done = rollbackRelease(id);
      print({ rolledBack: true, ...done }, `${id}: rolled back\n  wrote ${done.written.join(', ')}\n  removed ${done.removed.join(', ')}`);
      return 0;
    }
    case 'verify': {
      const v = await verifyReleases({ deep: flag('--deep'), reproduce: !flag('--no-reproduce') });
      const lines = v.algorithms.map((a) => `  ${a.key.padEnd(20)} ${a.version.padEnd(6)} ${a.approval.padEnd(9)} gate ${a.gate.padEnd(22)} binding ${a.binding.state}${a.binding.reasons.length ? ` (${a.binding.reasons.join(', ')})` : ''}${a.reproduction ? `  evidence ${a.reproduction.state}` : ''}`);
      if (v.orphans.length) lines.push(`  orphans: ${v.orphans.join(', ')}`);
      if (v.learning) lines.push(`  learning: method checks ${v.learning.methodChecks.passed}/${v.learning.methodChecks.total}, real-world ${v.learning.realWorld}`);
      print(v, `${v.ok ? 'OK' : 'FAILED'}\n${lines.join('\n')}`);
      return v.ok ? 0 : 1;
    }
    case 'rehearse': {
      if (!id) throw new Error('rehearse <candidate>');
      const r = await rehearse(id, { keep: flag('--keep') });
      const lines = r.steps.map((s) => `  ${s.ok ? 'ok  ' : 'FAIL'} ${s.step.padEnd(36)} ${s.ms} ms`);
      lines.push(`  repository untouched: ${r.repositoryUntouched}`);
      if (r.leftovers.length) lines.push(`  left over after rollback: ${r.leftovers.join(', ')}`);
      if (r.workspace) lines.push(`  copy kept at ${r.workspace}`);
      print(r, `${r.ok ? 'REHEARSED' : 'FAILED'} ${id}\n${lines.join('\n')}`);
      return r.ok ? 0 : 1;
    }
    case 'engine': {
      const pin = enginePin(LAB_ROOT);
      print(pin, `engine ${pin.fingerprint}\nspec v${pin.specVersion}, commit ${pin.commit ?? 'none'}\n${pin.files.map((f) => `  ${f}`).join('\n')}`);
      return 0;
    }
    default:
      throw new Error('usage: plan | apply | rollback | verify | rehearse | engine');
  }
}

main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
  if (err instanceof ReleaseRefusal) {
    print({ refused: err.code }, `refused: ${err.code}`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 2;
});
