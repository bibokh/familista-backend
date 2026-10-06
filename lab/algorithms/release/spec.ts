// Familista — what a release declares before anything runs (Algorithms Step 5)
// ─────────────────────────────────────────────────────────────────────────────
// The release tool promotes a candidate (Step 4) into its approved source file
// only in a pull request the platform owner asked for, and only once the
// evidence binds. This file declares what it checks the promotion against:
//
//   · which dependant algorithms can be SIMULATED, and through which function.
//     A dependant whose own code calls the changed code (path CODE) must be;
//     one that only reads stored values (path DATA) cannot be, and says so.
//   · the properties a simulated dependant is held to — the Step 4 probes,
//     under the dependant's own titles.
//   · what the evaluation ENGINE is, for pinning. Its fingerprint covers every
//     module the evidence is computed with, and nothing it is computed ON: not
//     the code under test, not the candidates, not the approval records.
//
// The probes, shots and seeds are Step 4's, unchanged: a dependant is judged
// on exactly the shots the changed algorithm was.

import type { PropertyDecl } from '../spec';

/** How the release tool runs one dependant: the function that produces its output, and what that run exercises. */
export interface DependantSimulation {
  /** Called with the shot alone, in the approved and in the promoted module. */
  entry: string;
  /**
   * The changed declarations a call of `entry` with the shot alone reaches. A
   * dependant whose code reaches any other changed declaration is NOT
   * simulated by this, and a promotion that needs it is refused.
   */
  covers: readonly string[];
}

/**
 * Dependants the release tool can run, by registry key. xGOT without a target
 * point is min(1.6 × xG, 1): its one call into xG's code. With a target point
 * it reads only sigmoid and the goal's position — reached by a promotion only
 * if one of those changes, which `covers` then does not include.
 */
export const DEPENDANT_SIMULATIONS: Readonly<Record<string, DependantSimulation>> = {
  xgot: { entry: 'computeXGOT', covers: ['computeXG'] },
};

/**
 * The properties a simulated dependant is held to. xGOT's no-target form is
 * min(1.6 × xG, 1), so whatever xG keeps, it should keep — checked, not
 * assumed. The penalty-spot property is xG's own plausibility check and is not
 * claimed for xGOT.
 */
export const DEPENDANT_PROPERTIES: Readonly<Record<string, readonly PropertyDecl[]>> = {
  xgot: [
    // Only `range` generalises a Step 1 check (src/algorithms/scenarios.ts); the others have none, and say so.
    { id: 'range', title: 'Every xGOT is a number between 0 and 1', kind: 'RANDOM', stepOne: 'It stays a probability' },
    { id: 'closer-never-worse', title: 'Moving a shot straight towards the goal never lowers its xGOT', kind: 'RANDOM', stepOne: '' },
    { id: 'wider-view-never-worse', title: 'At the same distance, a wider view of the goal never lowers xGOT', kind: 'RANDOM', stepOne: '' },
    { id: 'header-never-above-foot', title: 'A header never has a higher xGOT than the same shot with the foot', kind: 'RANDOM', stepOne: '' },
    { id: 'deterministic', title: 'The same shot always gets the same xGOT', kind: 'RANDOM', stepOne: '' },
  ],
};

/**
 * The evaluation engine, for pinning: every module reachable from these entry
 * points — what the children compute, how the parent assembles and judges it,
 * and how a dossier and its promotion are derived — through runtime imports,
 * except the paths below.
 */
export const ENGINE_ENTRIES: readonly string[] = [
  'lab/algorithms/jobs.ts',
  'lab/algorithms/evidence.ts',
  'lab/algorithms/engine/judge.ts',
  'lab/algorithms/release/dossier.ts',
];

/**
 * Not the engine: the code under test (every registered algorithm's source is
 * added at run time), the candidates and archived versions it is run on, the
 * approval records, and the process plumbing that decides nothing.
 */
export const ENGINE_EXCLUDED: readonly RegExp[] = [
  /^lab\/algorithms\/candidates\//,
  /^lab\/algorithms\/archive\//,
  /^lab\/algorithms\/(runner|child|cli|release-cli)\.ts$/,
  /^src\/algorithms\/(registry|loop)\.ts$/,
];

/**
 * The directory a release job (jobs.ts) reads its three modules from: one the
 * parent created with fs.mkdtemp for that run and removes after it — never a
 * path the job names.
 */
export const RELEASE_DIR = /^familista-release-[A-Za-z0-9]{6}$/;
export const RELEASE_DIR_PREFIX = 'familista-release-';
export const RELEASE_FILES = { approved: 'approved.ts', candidate: 'candidate.ts', promoted: 'promoted.ts' } as const;

/** Where the release tool keeps the version a promotion replaced, for rollback and reproduction. */
export const ARCHIVE_DIR = 'lab/algorithms/archive';
/** Where approval dossiers are written (the server reads them from here, and from dist/). */
export const APPROVALS_DIR = 'src/algorithms/approvals';

/** The history note a promotion adds — one fixed sentence, translated in the room's catalogue. */
export const PROMOTION_NOTE = 'Change: a candidate promoted with the platform owner’s approval.';
