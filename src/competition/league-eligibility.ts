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
  reason: 'OK' | 'NOT_FIRST_TEAM' | 'INACTIVE' | 'WRONG_AGE_GROUP';
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


// ─────────────────────────────────────────────────────────────────────────────
// Age groups
// ─────────────────────────────────────────────────────────────────────────────
//
// A competition is played by teams of one category, and the category is the
// competition's own `ageGroup` column rather than anything inferred from a
// name. Null means the first team's competition — the Familista League as it
// has always been — and a token like `U15` means the academy competition for
// that age group.
//
// The mapping between the token and the schema's TeamKind is written once,
// here, and derived from the enum rather than listed: `ACADEMY_U15` is the
// `U15` age group because its name says so. A new age group added to
// `enum TeamKind` therefore gets a league without a line of code changing.

/** `ACADEMY_U15` → `U15`. Anything that is not an academy kind → null. */
export function ageGroupOfKind(kind: TeamKind | string): string | null {
  const name = String(kind);
  if (!name.startsWith('ACADEMY_')) return null;
  const token = name.slice('ACADEMY_'.length);
  return /^U\d+$/.test(token) ? token : null;
}

/** `U15` → `[ACADEMY_U15]`. An unknown token maps to nothing, never to everything. */
export function kindsForAgeGroup(ageGroup: string): TeamKind[] {
  const token = String(ageGroup).trim().toUpperCase();
  return (Object.values(TeamKind) as TeamKind[]).filter((k) => ageGroupOfKind(k) === token);
}

/** Every age group the schema knows, oldest first. The order a screen lists them in. */
export function allAgeGroups(): string[] {
  const groups = (Object.values(TeamKind) as TeamKind[])
    .map((k) => ageGroupOfKind(k))
    .filter((g): g is string => !!g);
  return [...new Set(groups)].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
}

export interface CompetitionCategory {
  /** The competition's own age group. Null is the first team's competition. */
  ageGroup?: string | null;
}

/**
 * May this team play in THIS competition?
 *
 * The one rule, now asked of a competition rather than of the platform: a first
 * team's league takes first teams, and an age group's league takes that age
 * group. Never both, in either direction — a U14 side cannot enter the senior
 * league and a U18 side cannot enter the U14 one, and neither refusal is a
 * special case: each competition simply admits its own category.
 */
export function eligibilityFor(comp: CompetitionCategory, team: EligibilityInput): EligibilityVerdict {
  if (team.isActive === false) return { eligible: false, reason: 'INACTIVE' };
  const ageGroup = comp.ageGroup ? String(comp.ageGroup).trim().toUpperCase() : null;
  if (!ageGroup) return eligibilityOf(team);
  const kinds = kindsForAgeGroup(ageGroup);
  if (!kinds.includes(team.kind as TeamKind)) return { eligible: false, reason: 'WRONG_AGE_GROUP' };
  return { eligible: true, reason: 'OK' };
}

export function isEligibleFor(comp: CompetitionCategory, team: EligibilityInput): boolean {
  return eligibilityFor(comp, team).eligible;
}

/**
 * The same rule as a query. `eligibleTeamWhereFor(null)` is `eligibleTeamWhere()`
 * exactly — the first team's league is not a special case of the age-group
 * rule, it is the same rule with no age group — and the tests hold the pair
 * together the way they hold the original pair together.
 */
export function eligibleTeamWhereFor(ageGroup: string | null | undefined): Prisma.TeamWhereInput {
  if (!ageGroup) return eligibleTeamWhere();
  const kinds = kindsForAgeGroup(String(ageGroup).trim().toUpperCase());
  // An age group the schema does not know admits nobody. `in: []` matches no
  // row, which is the safe direction: an unknown token must never widen.
  return { kind: { in: kinds }, isActive: true };
}
