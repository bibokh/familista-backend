// The only door through which club data becomes training data (Cyber Defense, R8)
// ─────────────────────────────────────────────────────────────────────────────
// Familista trains nothing centrally today: federated learning computes its
// gradients at the club, and the decision engine is rule-based. This is the
// rule anything that does — a dataset export, a fine-tuning set, a feature
// store — must apply, and the rule federated learning already applies at
// submission (`federated.service.submitGradient` → `clubAiPolicy().trainingUse`):
//
//   1. CONSENT   a club's records are used only when the club has switched
//                `trainingUse` on. Off, or unreadable, means none of them.
//   2. CLASSES   every feature is labelled with its data class
//                (data-classes.ts). An unlabelled feature is RESTRICTED.
//   3. MINORS    a minor's RESTRICTED features are never used, consent or not.
//                (An unknown date of birth counts as a minor.) An adult's
//                RESTRICTED features are used only with the club's consent to
//                RESTRICTED egress as well.

import { clubAiPolicy } from './club-ai-policy';
import { classOf, isMinor, type DataClass } from './data-classes';

export interface TrainingRecord {
  clubId: string;
  /** The person the record is about, when it is about one. */
  subjectDateOfBirth?: Date | string | null;
  /** False for a record about a club, a match or money rather than a person. */
  subjectIsPerson?: boolean;
  features: Record<string, unknown>;
}

export interface TrainingRow { clubId: string; features: Record<string, unknown>; classes: DataClass[] }

export interface TrainingSelection {
  rows: TrainingRow[];
  /** Records left out because their club has not consented. */
  withoutConsent: number;
  /** Features withheld, by name, across all rows. */
  withheld: Record<string, number>;
}

export async function selectForTraining(records: ReadonlyArray<TrainingRecord>): Promise<TrainingSelection> {
  const rows: TrainingRow[] = [];
  const withheld: Record<string, number> = {};
  let withoutConsent = 0;
  const policies = new Map<string, Awaited<ReturnType<typeof clubAiPolicy>>>();

  for (const r of records) {
    if (!policies.has(r.clubId)) policies.set(r.clubId, await clubAiPolicy(r.clubId));
    const policy = policies.get(r.clubId)!;
    if (!policy.trainingUse) { withoutConsent += 1; continue; }

    // A record about a person is a minor's unless a date of birth says otherwise.
    const minor = r.subjectIsPerson === false ? false : isMinor(r.subjectDateOfBirth ?? null);
    const restrictedAllowed = policy.restrictedEgress && !minor;

    const features: Record<string, unknown> = {};
    const classes = new Set<DataClass>();
    for (const [k, v] of Object.entries(r.features)) {
      const c = classOf(k);
      if (c === 'RESTRICTED' && !restrictedAllowed) { withheld[k] = (withheld[k] ?? 0) + 1; continue; }
      features[k] = v;
      classes.add(c);
    }
    rows.push({ clubId: r.clubId, features, classes: [...classes] });
  }
  return { rows, withoutConsent, withheld };
}
