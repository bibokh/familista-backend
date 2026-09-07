// Familista — the teams one invitation grants.
//
// Its own module for one reason: both the invitation service and the mail
// service need it, and having the mail service import the invitation service —
// which already imports the mail service — makes a require cycle. A cycle that
// happens to work today because every use is inside a function body is still a
// cycle, and the next person to move a call to module scope finds out the hard
// way.

/**
 * Every team an invitation grants, the first one included.
 *
 * `teamId` and `additionalTeamIds` are one list split across two columns: the
 * first stayed where it was so that nothing already reading `teamId` changed
 * meaning when multi-team invitations arrived. Nowhere outside this file should
 * have to know that.
 *
 * An empty result means club-wide, which is the only thing "no team named" can
 * mean — it is never a default that stands in for a team the caller forgot.
 */
export function allTeamIds(row: { teamId: string | null; additionalTeamIds?: string[] | null }): string[] {
  const rest = Array.isArray(row.additionalTeamIds) ? row.additionalTeamIds : [];
  return row.teamId ? [row.teamId, ...rest] : [...rest];
}
