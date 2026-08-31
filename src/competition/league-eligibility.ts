// Familista League — who may play in it
// ─────────────────────────────────────────────────────────────────────────────
// One rule, in one place. Today it says "first teams only"; tomorrow it may say
// something else, and when it does this is the only file that changes. Nothing
// else in the platform — no controller, no screen, no query — is allowed to
// decide eligibility for itself, because a rule written in four places is a rule
// that will disagree with itself the first time one of them is edited.
//
// The rule is expressed twice on purpose, and the two must always agree:
//
//   isEligibleForFamilistaLeague(team)  for a team already in hand
//   eligibleTeamWhere()                 for asking the database for all of them
//
// They are tested against each other, so a change to one that is not made to the
// other fails rather than quietly letting an academy side into the league.

import { Prisma, TeamKind } from '@prisma/client';

/**
 * The kinds of team that count as a club's first team.
 *
 * `SENIOR` is the platform's name for it — see `enum TeamKind` in the schema,
 * where the academy sides are their own values (ACADEMY_U23 downwards) and are
 * therefore excluded by not being listed here rather than by being named.
 */
export const FIRST_TEAM_KINDS: TeamKind[] = [TeamKind.SENIOR];

export interface EligibilityInput {
  kind: TeamKind | string;
  isActive?: boolean;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** Why not, when not. A machine token, not a sentence to show a user. */
  reason: 'OK' | 'NOT_FIRST_TEAM' | 'INACTIVE';
}

/**
 * May this team play in the Familista League as the rules stand today?
 *
 * Kept as a verdict rather than a boolean so a caller can say *why* a team was
 * refused without re-deriving it — the Manage Teams screen shows the reason, and
 * a future eligibility rule (a licence, a minimum squad size, an age band) adds
 * a token here rather than a second check somewhere else.
 */
export function eligibilityOf(team: EligibilityInput): EligibilityVerdict {
  if (team.isActive === false) return { eligible: false, reason: 'INACTIVE' };
  if (!FIRST_TEAM_KINDS.includes(team.kind as TeamKind)) {
    return { eligible: false, reason: 'NOT_FIRST_TEAM' };
  }
  return { eligible: true, reason: 'OK' };
}

export function isEligibleForFamilistaLeague(team: EligibilityInput): boolean {
  return eligibilityOf(team).eligible;
}

/**
 * The same rule as a query, so "every eligible team" is one database question
 * rather than every team loaded and filtered in memory. Any future condition
 * added to `eligibilityOf` must be added here too; the tests hold the two
 * together.
 */
export function eligibleTeamWhere(): Prisma.TeamWhereInput {
  return { kind: { in: FIRST_TEAM_KINDS }, isActive: true };
}
