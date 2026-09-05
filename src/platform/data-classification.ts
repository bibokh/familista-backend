// What a piece of data is, before anyone asks who may see it
// ─────────────────────────────────────────────────────────────────────────────
// Authorization in Familista answers WHO + WHERE + WHAT + ACTION. This file is
// the WHAT: a classification every future policy decision can be expressed
// against, so that "may this person read this" never has to be decided by
// guessing what a field means.
//
//   PUBLIC        a result, a table, a fixture, a club's name and crest, the
//                 published parts of a player's profile. Visible to any signed
//                 in account — including one with no membership anywhere — and
//                 in time to the open web.
//   INTERNAL      how a team works: training, attendance, coaching notes,
//                 lineups, preparation. Private to the people on that team.
//   CONFIDENTIAL  contracts, salaries, valuations, staff matters. Private to
//                 the people a club has trusted with them.
//   RESTRICTED    medical detail, anything about a child beyond the public
//                 minimum, security material. The narrowest circle there is,
//                 and the one a policy engine must be able to refuse even to
//                 somebody who passes every other check.
//
// The classification does not grant anything. It is the input a grant is
// decided from — see identity/team-access.service.ts for the team boundary and
// platform/policy for the jurisdiction one.

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export const CLASSIFICATION_ORDER: DataClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

/** Is `a` at least as sensitive as `b`? */
export function atLeast(a: DataClassification, b: DataClassification): boolean {
  return CLASSIFICATION_ORDER.indexOf(a) >= CLASSIFICATION_ORDER.indexOf(b);
}

/**
 * The classification of the platform's resource families.
 *
 * A map rather than a decorator so it can be read by a policy engine, an audit
 * report and a test without loading the module that serves the resource. A
 * resource missing from this map is treated as INTERNAL: the safe direction for
 * a lookup to fail in is "more private than you thought", never less.
 */
export const RESOURCE_CLASSIFICATION: Readonly<Record<string, DataClassification>> = Object.freeze({
  'club.profile': 'PUBLIC',
  'club.crest': 'PUBLIC',
  'team.identity': 'PUBLIC',
  'competition.standings': 'PUBLIC',
  'competition.fixtures': 'PUBLIC',
  'competition.results': 'PUBLIC',
  'player.public-profile': 'PUBLIC',
  'staff.published-profile': 'PUBLIC',

  'squad.roster': 'INTERNAL',
  'training.session': 'INTERNAL',
  'training.attendance': 'INTERNAL',
  'tactics.lineup': 'INTERNAL',
  'tactics.formation': 'INTERNAL',
  'tactics.instructions': 'INTERNAL',
  'match.preparation': 'INTERNAL',
  'match.analysis': 'INTERNAL',
  'video.intelligence': 'INTERNAL',
  'analytics.team': 'INTERNAL',
  'notes.coaching': 'INTERNAL',

  'contract.player': 'CONFIDENTIAL',
  'contract.staff': 'CONFIDENTIAL',
  'finance.salary': 'CONFIDENTIAL',
  'transfer.valuation': 'CONFIDENTIAL',
  'notes.staff-matter': 'CONFIDENTIAL',

  'medical.record': 'RESTRICTED',
  'medical.injury-detail': 'RESTRICTED',
  'player.minor-detail': 'RESTRICTED',
  'player.guardian-contact': 'RESTRICTED',
  'security.credential': 'RESTRICTED',
  'security.audit-evidence': 'RESTRICTED',
});

export function classify(resource: string): DataClassification {
  return RESOURCE_CLASSIFICATION[resource] ?? 'INTERNAL';
}

/** The classifications a given access level may ever reach, before scope. */
export const LEVEL_CEILING: Readonly<Record<string, DataClassification>> = Object.freeze({
  // A viewer sees the public platform and nothing else, in any club.
  VIEWER: 'PUBLIC',
  // Staff reach their own team's operational data; CONFIDENTIAL and RESTRICTED
  // take more than being on the team, and are decided per resource.
  CLUB_STAFF: 'INTERNAL',
  CLUB_OWNER: 'CONFIDENTIAL',
  // Platform authority is not a key to a child's medical record: RESTRICTED
  // stays behind explicit governance, which is the point of having a ceiling.
  PLATFORM_OWNER: 'CONFIDENTIAL',
});

export function ceilingFor(level: string): DataClassification {
  return LEVEL_CEILING[level] ?? 'PUBLIC';
}

/**
 * The cheap first gate: is this classification even reachable by this level?
 *
 * Never the whole answer — team scope and jurisdiction still decide — but it is
 * the check that lets a route refuse before it queries, which is the difference
 * between protecting data and hiding it after loading it.
 */
export function levelMayReach(level: string, resource: string): boolean {
  const needed = classify(resource);
  const ceiling = ceilingFor(level);
  return !atLeast(needed, ceiling) || needed === ceiling;
}
