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
  /** The team's own name — where a club writes its age band ("U8-U10"). */
  name?: string | null;
  /** The band as structured data, when the club recorded it that way. */
  ageMin?: number | null;
  ageMax?: number | null;
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
// Age bands
// ─────────────────────────────────────────────────────────────────────────────
//
// A competition is played by teams of one category, and the category is the
// competition's own `ageGroup` column rather than anything inferred from a
// name. Null means the first team's competition — the Familista League as it
// has always been — and a token like `U11-U13` or `U15` means the academy
// competition for THAT band.
//
// ── Why the band, and not the kind
//
// `TeamKind` carries one age: ACADEMY_U13, ACADEMY_U17. A club that runs
// U8-U10 and U11-U13 files BOTH of them under ACADEMY_U13, because the kind is
// chosen from the oldest age the band covers. Grouping by kind therefore puts
// two different teams of the same club in one competition — which is exactly
// the mis-grouping this rule exists to prevent. The band a club actually runs
// is the team's own identity, and that is what is read here.
//
// ── How a band is resolved, in order, and never by overlap
//
//   1. an explicit range in the team's NAME — "U8-U10", "U8 – U10", "FC X U11-U13"
//   2. `ageMin`/`ageMax` on the team row, when the club recorded them
//   3. a single age in the name — "U17"
//   4. the age its ACADEMY_U* kind names — the last resort, and the only one
//      that is inferred rather than recorded
//
// Matching between a team and a competition is STRING EQUALITY of the resolved
// band. There is no "<= age", no overlap, no nearest band: U8-U10 plays U8-U10
// and nothing else. Two clubs that describe the same band differently are two
// different bands, and the initializer says so rather than merging them.

/** Every kind that is an academy side. Derived from the schema, never listed. */
export const ACADEMY_KINDS: TeamKind[] = (Object.values(TeamKind) as TeamKind[])
  .filter((k) => String(k).startsWith('ACADEMY_'));

/** `ACADEMY_U15` → `U15`. Anything that is not an academy kind → null. */
export function ageGroupOfKind(kind: TeamKind | string): string | null {
  const name = String(kind);
  if (!name.startsWith('ACADEMY_')) return null;
  const token = name.slice('ACADEMY_'.length);
  return /^U\d+$/.test(token) ? token : null;
}

/** One spelling for one band: upper case, no spaces, a plain hyphen. */
export function normalizeBand(raw: string): string {
  return String(raw).trim().toUpperCase()
    .replace(/[\u2010-\u2015]/g, '-')   // every dash a keyboard does not have
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ');
}

/** A range written into a name: "U8-U10", "U8 – U10", "FC X — U11-U13". */
function bandFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const norm = normalizeBand(name);
  const range = norm.match(/U(\d{1,2})-U?(\d{1,2})/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo > 0 && hi > 0) return lo === hi ? `U${lo}` : `U${Math.min(lo, hi)}-U${Math.max(lo, hi)}`;
  }
  const single = norm.match(/(?:^|[^A-Z0-9])U(\d{1,2})(?![0-9-])/);
  return single ? `U${Number(single[1])}` : null;
}

/** How a team's band was decided. Reported so a mis-grouping is visible. */
export type BandSource = 'NAME_RANGE' | 'AGE_RANGE' | 'NAME_SINGLE' | 'KIND';

export interface ResolvedBand {
  band: string | null;
  source: BandSource | null;
}

/**
 * The age band this team plays in, and where that answer came from.
 *
 * Deterministic: the same row always resolves to the same token, and two rows
 * share a band only when their tokens are identical.
 */
export function resolveAgeBand(team: EligibilityInput): ResolvedBand {
  const fromName = bandFromName(team.name);
  if (fromName && /-/.test(fromName)) return { band: fromName, source: 'NAME_RANGE' };

  const lo = typeof team.ageMin === 'number' ? team.ageMin : null;
  const hi = typeof team.ageMax === 'number' ? team.ageMax : null;
  if (lo != null && hi != null && lo > 0 && hi > 0) {
    return { band: lo === hi ? `U${lo}` : `U${Math.min(lo, hi)}-U${Math.max(lo, hi)}`, source: 'AGE_RANGE' };
  }

  if (fromName) return { band: fromName, source: 'NAME_SINGLE' };

  const fromKind = ageGroupOfKind(team.kind);
  return fromKind ? { band: fromKind, source: 'KIND' } : { band: null, source: null };
}

/** The band alone, for a caller that does not need to explain it. */
export function ageBandOf(team: EligibilityInput): string | null {
  return resolveAgeBand(team).band;
}

/** Whether a team is an academy side at all — asked of the kind, as the schema says. */
export function isAcademyTeam(team: EligibilityInput): boolean {
  return ACADEMY_KINDS.includes(team.kind as TeamKind);
}

/**
 * Every academy team on the platform, as a query.
 *
 * Bands cannot be expressed in SQL — they are read off each row, from a name a
 * club typed or a range it recorded — so the query fetches the academy sides
 * and the band decides which of them belong together. There are tens of these
 * rows per platform, not millions.
 */
export function academyTeamWhere(): Prisma.TeamWhereInput {
  return { kind: { in: ACADEMY_KINDS }, isActive: true };
}

export interface CompetitionCategory {
  /** The competition's own age band. Null is the first team's competition. */
  ageGroup?: string | null;
}

/**
 * May this team play in THIS competition?
 *
 * The one rule, asked of a competition rather than of the platform: a first
 * team's league takes first teams, and a band's league takes exactly that band.
 * A SENIOR side is refused by every academy competition — it has no academy
 * kind, so it has no band to match with.
 */
export function eligibilityFor(comp: CompetitionCategory, team: EligibilityInput): EligibilityVerdict {
  if (team.isActive === false) return { eligible: false, reason: 'INACTIVE' };
  const band = comp.ageGroup ? normalizeBand(comp.ageGroup) : null;
  if (!band) return eligibilityOf(team);
  if (!isAcademyTeam(team)) return { eligible: false, reason: 'WRONG_AGE_GROUP' };
  const own = ageBandOf(team);
  if (!own || normalizeBand(own) !== band) return { eligible: false, reason: 'WRONG_AGE_GROUP' };
  return { eligible: true, reason: 'OK' };
}

export function isEligibleFor(comp: CompetitionCategory, team: EligibilityInput): boolean {
  return eligibilityFor(comp, team).eligible;
}

/**
 * The query side of the same rule.
 *
 * With no band it is the first team's rule, unchanged and shared with the First
 * Team's own run. With a band it narrows to the academy sides — the band itself
 * is applied to the rows that come back, by `eligibilityFor`, because a band is
 * not a column. `resolveEligibleTeams` in the bootstrap is the one place that
 * pairs the two, so no caller can accidentally use half the rule.
 */
export function eligibleTeamWhereFor(ageGroup: string | null | undefined): Prisma.TeamWhereInput {
  if (!ageGroup) return eligibleTeamWhere();
  return academyTeamWhere();
}
