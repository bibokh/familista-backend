// Familista — the Test verdict, from held-out evidence only
// ─────────────────────────────────────────────────────────────────────────────
// Runs in the PARENT process, on results the parent has already validated —
// never inside the child that ran the candidate. In order:
//
//   UNAVAILABLE   the run did not complete, the comparison method failed its
//                 own checks, or there are no results
//   FAILED        on held-out probes the candidate broke a property the
//                 approved version keeps, did not fix a property it declared it
//                 would fix, or produced invalid outputs the approved version
//                 does not
//   INCONCLUSIVE  the versions differ, but a random property's held-out probes
//                 reached the changed region fewer than LAB_RULES.minRegionProbes
//                 times — a pass there would say little
//   PASSED        otherwise
//
// Score brackets and sample-size estimates never enter: synthetic outcomes
// cannot say which version is right. A property both versions break is not
// the candidate's doing; it is reported (SHARED_FAILURE) and decides nothing.
// Development results are compared with held-out ones only to say whether they
// agree.

import type {
  CandidateDeclaration, LabMethodCheck, LabPhaseResult, LabRun, LabVerdict,
} from '../../../src/algorithms/candidate-evidence';

export interface JudgeInput {
  run: LabRun;
  methodChecks: readonly LabMethodCheck[];
  declaration: CandidateDeclaration | null;
  results: { development: LabPhaseResult; heldOut: LabPhaseResult } | null;
}

export function judge(input: JudgeInput): LabVerdict {
  const { run, methodChecks, declaration, results } = input;
  if (run.state !== 'COMPLETED') return { test: 'UNAVAILABLE', reasons: [`RUN_${run.state}`, ...run.reasons], agreement: null };
  if (!methodChecks.length || methodChecks.some((m) => !m.passed)) return { test: 'UNAVAILABLE', reasons: ['METHOD_CHECKS_FAILED'], agreement: null };
  if (!results || !declaration) return { test: 'UNAVAILABLE', reasons: ['NO_RESULTS'], agreement: null };

  const held = results.heldOut;
  const outcome = new Map(held.properties.map((p) => [p.id, p]));
  const failed: string[] = [];
  for (const p of held.properties) if (p.outcome === 'BROKEN') failed.push(`BROKEN:${p.id}`);
  for (const t of declaration.hypothesis.targets) if (outcome.get(t)?.outcome !== 'FIXED') failed.push(`TARGET_NOT_FIXED:${t}`);
  if (held.scenarios.some((s) => s.invalid.candidate > s.invalid.approved)) failed.push('NEW_INVALID_OUTPUTS');
  const shared = held.properties.filter((p) => p.outcome === 'STILL_FAILING').map((p) => `SHARED_FAILURE:${p.id}`);
  const agreement = agreementOf(results.development, held);

  if (failed.length) return { test: 'FAILED', reasons: [...failed, ...shared], agreement };
  const differs = held.scenarios.some((s) => s.divergence.changed > 0) || held.properties.some((p) => p.inRegion > 0);
  const uncovered = differs ? held.properties.filter((p) => !p.covered).map((p) => `NOT_COVERED:${p.id}`) : [];
  if (uncovered.length) return { test: 'INCONCLUSIVE', reasons: [...uncovered, ...shared], agreement };
  return { test: 'PASSED', reasons: shared, agreement };
}

/** Do development and held-out probes give every property the same outcome? */
export function agreementOf(dev: LabPhaseResult, held: LabPhaseResult): 'AGREE' | 'DISAGREE' {
  const d = new Map(dev.properties.map((p) => [p.id, p.outcome]));
  return held.properties.every((p) => d.get(p.id) === p.outcome) ? 'AGREE' : 'DISAGREE';
}
