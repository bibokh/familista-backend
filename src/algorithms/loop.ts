// Familista — the Continuous Intelligence Loop
// ─────────────────────────────────────────────────────────────────────────────
// Every algorithm the platform runs moves around one loop:
//
//   Observe → Learn → Propose → Simulate → Test → Human Approval → Deploy
//           → Measure → Learn → …
//
// This file is the loop and nothing else: its stages, the only transitions
// allowed between them, and the gate in front of Deploy. It is pure — no
// database, no clock, no I/O — so the rule can be tested exhaustively and
// cannot be weakened by a caller that forgets to check something.
//
// THE RULE THIS FILE EXISTS FOR
//
// Nothing reaches Deploy without a human approval that names the EXACT version
// and the EXACT source fingerprint being deployed. An approval of v1.2 does not
// approve v1.3; an approval of a fingerprint does not approve the file after
// one more edit. And in Step 1 the platform deploys nothing by itself: Deploy
// means "merged to main through a reviewed pull request and released by the
// CI-gated deploy workflow", the same path as every other change. There is no
// code path here, or anywhere in src/algorithms, that changes a running
// algorithm.

export const LOOP_STAGES = [
  'OBSERVE', 'LEARN', 'PROPOSE', 'SIMULATE', 'TEST', 'HUMAN_APPROVAL', 'DEPLOY', 'MEASURE',
] as const;
export type LoopStage = typeof LOOP_STAGES[number];

/**
 * Forward edges of the loop, plus the two ways back that a real review needs:
 * a failed simulation or test, or a refused approval, returns the proposal to
 * PROPOSE. MEASURE closes the loop into LEARN. Nothing else is an edge — in
 * particular nothing jumps to DEPLOY except HUMAN_APPROVAL.
 */
export const LOOP_EDGES: Readonly<Record<LoopStage, readonly LoopStage[]>> = {
  OBSERVE:        ['LEARN'],
  LEARN:          ['PROPOSE'],
  PROPOSE:        ['SIMULATE'],
  SIMULATE:       ['TEST', 'PROPOSE'],
  TEST:           ['HUMAN_APPROVAL', 'PROPOSE'],
  HUMAN_APPROVAL: ['DEPLOY', 'PROPOSE'],
  DEPLOY:         ['MEASURE'],
  MEASURE:        ['LEARN'],
};

/** How an algorithm is allowed to act. Step 1 admits exactly one value. */
export const ALGORITHM_MODES = ['READ_ANALYZE'] as const;
export type AlgorithmMode = typeof ALGORITHM_MODES[number];

/** A human approval, as recorded in the reviewed registry. */
export interface ApprovalRecord {
  /** The version approved — must equal the version being deployed. */
  version: string;
  /** SHA-256 of the source file at approval — must equal the code being deployed. */
  fingerprint: string;
  /** Who approved, as a role. Never a person's name or address. */
  approvedBy: 'PLATFORM_OWNER';
  /** Where the approval is recorded: the reviewed pull request or commit that carried it. */
  reference: string;
  /** ISO date of the approval. */
  approvedAt: string;
}

export interface GateInput {
  version: string;
  /** The fingerprint of the source as it is now; null when it cannot be read. */
  fingerprint: string | null;
  approval: ApprovalRecord | null;
  /** Simulation and evaluation outcome; 'NOT_SIMULATED' is allowed but recorded. */
  evaluation: 'PASS' | 'FAIL' | 'NOT_SIMULATED';
  mode: string;
}

export type GateVerdict =
  | 'APPROVED'
  | 'NO_APPROVAL'
  | 'VERSION_NOT_APPROVED'
  | 'CHANGED_SINCE_APPROVAL'
  | 'FINGERPRINT_UNAVAILABLE'
  | 'EVALUATION_FAILED'
  | 'MODE_NOT_ALLOWED';

const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * May this exact algorithm version be in production?
 *
 * Checked in order of how fundamental the refusal is: an action mode outside
 * read/analyze is refused before anything else is looked at, because no
 * approval can make it allowed in Step 1.
 */
export function deploymentGate(g: GateInput): GateVerdict {
  if (!(ALGORITHM_MODES as readonly string[]).includes(g.mode)) return 'MODE_NOT_ALLOWED';
  if (!g.approval) return 'NO_APPROVAL';
  if (g.approval.approvedBy !== 'PLATFORM_OWNER' || !g.approval.reference.trim()) return 'NO_APPROVAL';
  if (!FINGERPRINT.test(g.approval.fingerprint)) return 'NO_APPROVAL';
  if (g.approval.version !== g.version) return 'VERSION_NOT_APPROVED';
  if (!g.fingerprint) return 'FINGERPRINT_UNAVAILABLE';
  if (g.approval.fingerprint !== g.fingerprint) return 'CHANGED_SINCE_APPROVAL';
  if (g.evaluation === 'FAIL') return 'EVALUATION_FAILED';
  return 'APPROVED';
}

/**
 * Is `to` a legal next stage from `from`? Entering DEPLOY additionally needs
 * the gate to say APPROVED; there is no argument that skips it.
 */
export function canAdvance(from: LoopStage, to: LoopStage, gate: GateVerdict | null): boolean {
  if (!LOOP_EDGES[from].includes(to)) return false;
  if (to === 'DEPLOY') return gate === 'APPROVED';
  return true;
}

/**
 * Where an algorithm stands on the loop, derived from evidence rather than
 * stored — so the answer cannot drift from the code.
 *
 *   approved, unchanged, evaluation not failing → MEASURE (it is live and being measured)
 *   evaluation failing                          → TEST (it failed its own checks)
 *   changed since approval / new version        → HUMAN_APPROVAL (waiting for a person)
 *   never approved                              → OBSERVE (inventoried, not yet governed)
 */
export function stageOf(verdict: GateVerdict): LoopStage {
  switch (verdict) {
    case 'APPROVED': return 'MEASURE';
    case 'EVALUATION_FAILED': return 'TEST';
    case 'CHANGED_SINCE_APPROVAL':
    case 'VERSION_NOT_APPROVED':
    case 'FINGERPRINT_UNAVAILABLE': return 'HUMAN_APPROVAL';
    case 'NO_APPROVAL':
    case 'MODE_NOT_ALLOWED': return 'OBSERVE';
  }
}
