// Familista — releases: from a human approval to code running in production
// ─────────────────────────────────────────────────────────────────────────────
// Algorithms Step 5. Read-only. Two things live here:
//
// 1. THE BINDING CHECK. A CHANGE approval (registry.ts) promotes one candidate
//    to a new version. It is valid only when every link closes: the dossier it
//    names exists and hashes to the digest it records; the dossier is about
//    this algorithm, this candidate and this version; the fingerprint the
//    owner approved is the one the dossier's promotion produced; the version it
//    replaced is the baseline the evidence was judged against and sits before
//    it in the version history; the evidence passed, every method check
//    passed, and every dependant whose code calls the changed code was
//    simulated and broke nothing. Change any one of them and the binding says
//    which. The deployment gate (loop.ts) is untouched: it still decides on
//    version and fingerprint alone; this check is what CI and the room add.
//
// 2. THE RELEASE STATES. Between "approved" and "measured" are states this
//    server can see and states it cannot. It says which is which:
//
//      approved          the approval record in this build's registry      known here
//      built from        the commit this server was deployed from, when    known when the
//                        the platform reports it (RENDER_GIT_COMMIT)       platform says
//      deploy requested  the deploy workflow's run (hook accepted)         NOT known here
//      confirmed live    Render's own status for that deploy               NOT known here —
//                                                                          checked by a person
//      running code      this process's fingerprints, proven against the   known here
//                        approval through the build seal
//      measured          production telemetry, for algorithms that have    known here, or
//                        a production caller                               "not observable"
//
//    Nothing unknown is filled in. A state this server cannot see is reported
//    as unknown here, never inferred from the absence of an error — and the
//    absence of telemetry is never read as proof that code is unused.

import { ALGORITHMS, type AlgorithmDecl, type AlgorithmVersion, type ChangeApproval } from './registry';
import { readDossier, digestOf, type DossierRead, type ApprovalDossier, type DossierLimit } from './approval-dossier';
import { runtimeFingerprints, type RuntimeBasis, type RuntimeVerdict } from './runtime-fingerprint';
import { MONITORING_SPECS } from './monitoring-spec';

export type BindingReason =
  | 'DOSSIER_UNREADABLE'
  | 'DIGEST_MISMATCH'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'ALGORITHM_MISMATCH'
  | 'CANDIDATE_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'FINGERPRINT_MISMATCH'
  | 'BASELINE_MISMATCH'
  | 'BASELINE_NOT_IN_HISTORY'
  | 'VERSION_REUSED'
  | 'VERDICT_MISMATCH'
  | 'METHOD_CHECKS_NOT_PASSED'
  | 'CODE_DEPENDANT_NOT_SIMULATED'
  | 'CODE_DEPENDANT_BROKEN'
  | 'REFERENCE_NOT_A_PULL_REQUEST';

/** Every reason, in the order the check reports them. */
export const BINDING_REASONS: readonly BindingReason[] = [
  'DOSSIER_UNREADABLE', 'DIGEST_MISMATCH', 'EVIDENCE_DIGEST_MISMATCH', 'ALGORITHM_MISMATCH', 'CANDIDATE_MISMATCH',
  'VERSION_MISMATCH', 'FINGERPRINT_MISMATCH', 'BASELINE_MISMATCH', 'BASELINE_NOT_IN_HISTORY', 'VERSION_REUSED',
  'VERDICT_MISMATCH', 'METHOD_CHECKS_NOT_PASSED', 'CODE_DEPENDANT_NOT_SIMULATED', 'CODE_DEPENDANT_BROKEN',
  'REFERENCE_NOT_A_PULL_REQUEST',
];

/** `<owner>/<repo>#<number>` — the reviewed pull request that carried the approval. */
export const PULL_REQUEST_REFERENCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d{0,6}$/;

export interface DossierSummary {
  file: string;
  digest: string;
  candidate: string;
  baseline: { version: string; fingerprint: string };
  engine: { specVersion: number; fingerprint: string; commit: string | null };
  test: { verdict: 'PASSED'; agreement: 'AGREE' | 'DISAGREE'; methodChecks: { passed: number; total: number } };
  properties: { kept: number; fixed: number; broken: number; stillFailing: number };
  dependants: Array<{ key: string; path: 'CODE' | 'DATA'; simulated: boolean; broken: number }>;
  limits: DossierLimit[];
}

export interface BindingCheck {
  state: 'NOT_APPLICABLE' | 'VALID' | 'INVALID';
  reasons: BindingReason[];
  dossier: DossierSummary | null;
}

const NOT_APPLICABLE: BindingCheck = { state: 'NOT_APPLICABLE', reasons: [], dossier: null };

function summaryOf(file: string, digest: string, d: ApprovalDossier): DossierSummary {
  const held = d.reproducible.results.heldOut.properties;
  const count = (o: string) => held.filter((p) => p.outcome === o).length;
  return {
    file, digest,
    candidate: d.candidate.id,
    baseline: { ...d.baseline },
    engine: { specVersion: d.engine.specVersion, fingerprint: d.engine.fingerprint, commit: d.engine.commit },
    test: { verdict: d.test.verdict, agreement: d.test.agreement, methodChecks: { ...d.test.methodChecks } },
    properties: { kept: count('KEPT'), fixed: count('FIXED'), broken: count('BROKEN'), stillFailing: count('STILL_FAILING') },
    dependants: d.reproducible.dependants.map((x) => ({
      key: x.key, path: x.path, simulated: x.simulated,
      broken: (x.properties ?? []).filter((p) => p.outcome === 'BROKEN').length,
    })),
    limits: [...d.limits],
  };
}

const indexOfVersion = (history: readonly AlgorithmVersion[], version: string) => history.findIndex((v) => v.version === version);

/**
 * Is this algorithm's approval bound, link by link, to the evidence it was
 * judged on? NOT_APPLICABLE for a baseline approval (it records code as it
 * already ran; there was no candidate) and for no approval at all.
 */
export function checkBinding(decl: AlgorithmDecl, read: (file: string) => DossierRead = readDossier): BindingCheck {
  const a = decl.approval;
  if (!a || a.kind !== 'CHANGE') return NOT_APPLICABLE;
  const c = a as ChangeApproval;
  const reasons = new Set<BindingReason>();
  if (!PULL_REQUEST_REFERENCE.test(c.reference)) reasons.add('REFERENCE_NOT_A_PULL_REQUEST');
  if (c.version !== decl.version) reasons.add('VERSION_MISMATCH');
  if (c.baseline.version === c.version) reasons.add('VERSION_REUSED');
  const at = indexOfVersion(decl.versions, c.version);
  const before = indexOfVersion(decl.versions, c.baseline.version);
  if (at < 0 || before < 0 || before >= at) reasons.add('BASELINE_NOT_IN_HISTORY');

  const r = read(c.dossier.file);
  if (r.state !== 'READY') {
    reasons.add('DOSSIER_UNREADABLE');
    return { state: 'INVALID', reasons: order(reasons), dossier: null };
  }
  const d = r.dossier;
  if (r.digest !== c.dossier.digest) reasons.add('DIGEST_MISMATCH');
  if (digestOf(d.reproducible) !== d.evidenceDigest) reasons.add('EVIDENCE_DIGEST_MISMATCH');
  if (d.algorithm !== decl.key) reasons.add('ALGORITHM_MISMATCH');
  if (d.candidate.id !== c.candidate || d.reproducible.declaration.id !== c.candidate) reasons.add('CANDIDATE_MISMATCH');
  if (d.candidate.version !== c.version || d.reproducible.declaration.version !== c.version) reasons.add('VERSION_MISMATCH');
  if (d.candidate.fingerprint !== c.fingerprint || d.promotion.promotedFingerprint !== c.fingerprint) reasons.add('FINGERPRINT_MISMATCH');
  if (d.baseline.version !== c.baseline.version || d.baseline.fingerprint !== c.baseline.fingerprint
    || d.reproducible.declaration.baseline.version !== c.baseline.version
    || d.reproducible.declaration.baseline.fingerprint !== c.baseline.fingerprint) reasons.add('BASELINE_MISMATCH');
  if (d.reproducible.verdict.test !== 'PASSED' || d.reproducible.verdict.agreement !== d.test.agreement) reasons.add('VERDICT_MISMATCH');
  const mc = d.reproducible.methodChecks;
  if (!mc.length || mc.some((m) => !m.passed) || d.test.methodChecks.passed !== mc.length || d.test.methodChecks.total !== mc.length) {
    reasons.add('METHOD_CHECKS_NOT_PASSED');
  }
  for (const dep of d.reproducible.dependants) {
    if (dep.path !== 'CODE') continue;
    if (!dep.simulated || !dep.properties || !dep.scenarios) { reasons.add('CODE_DEPENDANT_NOT_SIMULATED'); continue; }
    if (dep.properties.some((p) => p.outcome === 'BROKEN') || dep.scenarios.some((s) => s.invalid.candidate > s.invalid.approved)) {
      reasons.add('CODE_DEPENDANT_BROKEN');
    }
  }
  return { state: reasons.size ? 'INVALID' : 'VALID', reasons: order(reasons), dossier: summaryOf(c.dossier.file, r.digest, d) };
}

const order = (s: Set<BindingReason>) => BINDING_REASONS.filter((x) => s.has(x));

// ── the release states, as this server can see them ─────────────────────────

export interface AlgorithmRelease {
  key: string;
  name: string;
  version: string;
  approval: { kind: 'BASELINE' | 'CHANGE'; version: string; fingerprint: string; reference: string; approvedAt: string } | null;
  binding: BindingCheck;
  /** The code this process runs, proven against the approval (Step 2's runtime fingerprint). */
  runtime: { verdict: RuntimeVerdict; basis: RuntimeBasis };
  /** Production telemetry exists only for an algorithm a request, worker or job calls. */
  production: 'MEASURED' | 'NOT_OBSERVABLE';
  history: AlgorithmVersion[];
}

export interface AlgorithmReleases {
  /** The commit this server was deployed from, as the platform reports it; null when it does not. */
  build: { commit: string | null };
  /** States this server cannot see. Fixed values: they are never inferred. */
  deploy: { requested: 'NOT_KNOWN_HERE'; live: 'NOT_KNOWN_HERE' };
  algorithms: AlgorithmRelease[];
  totals: {
    registered: number; baseline: number; change: number;
    bindingValid: number; bindingInvalid: number; runtimeMatch: number; measured: number;
  };
}

/** Full 40-character hex, or nothing: a partial or decorated value is not a commit. */
export const COMMIT = /^[0-9a-f]{40}$/;

export function algorithmReleases(buildCommit: string | null): AlgorithmReleases {
  const rt = runtimeFingerprints();
  const byKey = new Map(rt.list.map((f) => [f.key, f]));
  const instrumented = new Set(MONITORING_SPECS.filter((s) => s.instrumented).map((s) => s.key));
  const algorithms = ALGORITHMS.map((decl): AlgorithmRelease => {
    const f = byKey.get(decl.key);
    const a = decl.approval;
    return {
      key: decl.key, name: decl.name, version: decl.version,
      approval: a ? { kind: a.kind, version: a.version, fingerprint: a.fingerprint, reference: a.reference, approvedAt: a.approvedAt } : null,
      binding: checkBinding(decl),
      runtime: { verdict: f ? f.verdict : 'UNVERIFIED', basis: rt.basis },
      production: instrumented.has(decl.key) ? 'MEASURED' : 'NOT_OBSERVABLE',
      history: decl.versions.map((v) => ({ ...v })),
    };
  });
  return {
    build: { commit: buildCommit && COMMIT.test(buildCommit) ? buildCommit : null },
    deploy: { requested: 'NOT_KNOWN_HERE', live: 'NOT_KNOWN_HERE' },
    algorithms,
    totals: {
      registered: algorithms.length,
      baseline: algorithms.filter((x) => x.approval?.kind === 'BASELINE').length,
      change: algorithms.filter((x) => x.approval?.kind === 'CHANGE').length,
      bindingValid: algorithms.filter((x) => x.binding.state === 'VALID').length,
      bindingInvalid: algorithms.filter((x) => x.binding.state === 'INVALID').length,
      runtimeMatch: algorithms.filter((x) => x.runtime.verdict === 'MATCH').length,
      measured: algorithms.filter((x) => x.production === 'MEASURED').length,
    },
  };
}
