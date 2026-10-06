// Familista — is every approval in this tree what it says it is?
// ─────────────────────────────────────────────────────────────────────────────
// For every registered algorithm, the deployment gate (loop.ts) on the code as
// it is now and its Step 1 evaluation. For every CHANGE approval, also: the
// binding to its dossier (src/algorithms/release.ts), the archive a rollback
// and a reproduction need, and — while the engine is the one the dossier
// pinned — a re-run of its evidence. Every dossier and archive must belong to
// an approval: one that none names is an orphan, and fails.
//
// `deep` adds Learning (Step 3): every synthetic method check passes and the
// real-world lane stays disabled. The rehearsal runs it after a promotion.
//
// It reads the tree it lives in — the registry it imports and the files beside
// it are one tree — and writes nothing there; reproduction runs its jobs in
// child processes, from a temporary directory.

import * as fs from 'fs';
import * as path from 'path';
import { readDossier } from '../../../src/algorithms/approval-dossier';
import { algorithmsLearning } from '../../../src/algorithms/learning';
import { deploymentGate, type GateVerdict } from '../../../src/algorithms/loop';
import { checkBinding, type BindingReason } from '../../../src/algorithms/release';
import { ALGORITHMS, type ChangeApproval } from '../../../src/algorithms/registry';
import { evaluate } from '../../../src/algorithms/scenarios';
import { LAB_ROOT } from '../runner';
import { archivedCandidates, readArchive } from './archive';
import { reproduceDossier, type Reproduction } from './dossier';
import { enginePin, type EnginePin } from './engine';
import { fingerprintOf } from './source';
import { APPROVALS_DIR } from './spec';

export interface AlgorithmCheck {
  key: string;
  version: string;
  approval: 'BASELINE' | 'CHANGE' | 'NONE';
  evaluation: 'PASS' | 'FAIL' | 'NOT_SIMULATED';
  gate: GateVerdict;
  binding: { state: 'NOT_APPLICABLE' | 'VALID' | 'INVALID'; reasons: BindingReason[] };
  archive: 'CONSISTENT' | 'MISSING' | 'INCONSISTENT' | null;
  reproduction: Reproduction | null;
}

export interface VerifyReport {
  ok: boolean;
  engine: EnginePin;
  algorithms: AlgorithmCheck[];
  /** Dossiers and archives no approval names. */
  orphans: string[];
  learning: { methodChecks: { passed: number; total: number }; complete: boolean; realWorld: string } | null;
}

export interface VerifyOptions { reproduce?: boolean; deep?: boolean }

export async function verifyReleases(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const root = LAB_ROOT;
  const engine = enginePin(root);
  const algorithms: AlgorithmCheck[] = [];
  for (const decl of ALGORITHMS) {
    const fingerprint = fingerprintOf(fs.readFileSync(path.join(root, decl.source.file), 'utf8'), decl.source.symbols);
    const evaluation = evaluate(decl.key).state;
    const gate = deploymentGate({ version: decl.version, fingerprint, approval: decl.approval, evaluation, mode: decl.mode });
    const binding = checkBinding(decl, (f) => readDossier(f, path.join(root, APPROVALS_DIR)));
    const check: AlgorithmCheck = {
      key: decl.key, version: decl.version, approval: decl.approval ? decl.approval.kind : 'NONE', evaluation, gate,
      binding: { state: binding.state, reasons: binding.reasons }, archive: null, reproduction: null,
    };
    if (decl.approval?.kind === 'CHANGE') {
      const a = decl.approval as ChangeApproval;
      const archive = readArchive(root, a.candidate);
      check.archive = archive.state !== 'READY' ? (archive.state === 'MISSING' ? 'MISSING' : 'INCONSISTENT')
        : archive.meta.algorithm === decl.key && archive.meta.dossier.file === a.dossier.file && archive.meta.dossier.digest === a.dossier.digest
          && archive.meta.promoted.fingerprint === a.fingerprint && archive.meta.promoted.version === a.version
          && archive.meta.approved.fingerprint === a.baseline.fingerprint && archive.meta.approved.version === a.baseline.version
          ? 'CONSISTENT' : 'INCONSISTENT';
      const d = readDossier(a.dossier.file, path.join(root, APPROVALS_DIR));
      if (opts.reproduce !== false && d.state === 'READY' && binding.state === 'VALID' && check.archive === 'CONSISTENT') {
        check.reproduction = await reproduceDossier(root, d.dossier, engine);
      }
    }
    algorithms.push(check);
  }

  const changes = ALGORITHMS.map((a) => a.approval).filter((a): a is ChangeApproval => a?.kind === 'CHANGE');
  const dir = path.join(root, APPROVALS_DIR);
  const dossiers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => `${APPROVALS_DIR}/${n}`) : [];
  const orphans = [
    ...dossiers.filter((f) => !changes.some((c) => c.dossier.file === f)),
    ...archivedCandidates(root).filter((id) => !changes.some((c) => c.candidate === id)).map((id) => `lab/algorithms/archive/${id}`),
  ];

  let learning: VerifyReport['learning'] = null;
  if (opts.deep) {
    const overview = await algorithmsLearning();
    const runs = overview.algorithms.map((a) => a.synthetic).filter((s): s is NonNullable<typeof s> => s !== null);
    learning = {
      methodChecks: { passed: runs.reduce((n, r) => n + r.methodChecks.passed, 0), total: runs.reduce((n, r) => n + r.methodChecks.total, 0) },
      complete: runs.length > 0 && runs.every((r) => r.state === 'COMPLETE'),
      realWorld: overview.realWorld.state,
    };
  }

  const ok = algorithms.every((a) => a.gate === 'APPROVED' && a.binding.state !== 'INVALID'
    && (a.approval !== 'CHANGE' || (a.archive === 'CONSISTENT' && (a.reproduction === null ? opts.reproduce === false : a.reproduction.state === 'REPRODUCED' || a.reproduction.state === 'PINNED'))))
    && orphans.length === 0
    && (!learning || (learning.complete && learning.methodChecks.passed === learning.methodChecks.total && learning.realWorld === 'DISABLED'));
  return { ok, engine, algorithms, orphans, learning };
}
