# Team access — what is whose

A Familista club is not one flat permission space. It is a First Team and a set
of other teams — academy age groups today, a reserve side, a women's side or a
second team tomorrow — and each of them is a team in its own right with its own
squad, its own week, its own fixtures and its own staff.

This document is the audit that decided where the boundary runs. It classifies
every module the platform exposes and records, for each one, what enforces it.
It is written to be checked: every claim below points at code, and the
authorization rules it describes are pinned by
`tests/academy-league-and-team-permissions.unit.test.ts` and
`tests/team-scope-platform.unit.test.ts`.

## The four classes

| Class | Meaning | Who |
|---|---|---|
| **A — club-wide public** | The club's shell: that a team exists, its name, its age group, its crest, who is responsible for it, public results and standings. | Every active member of the club. |
| **B — team-scoped private** | A team's operational work: squad, player records, lineup, formation, tactics, training, preparation, analysis, medical availability. | Assigned to that team, or club-wide staff. |
| **C — team-scoped manageable** | Changing any of B. | An assignment to manage that team (`TEAM_MANAGING_ROLES`), or club-wide management. |
| **D — club administration** | Rows that belong to the club rather than to a team, and the club's own settings. | Club owner / club admin / platform admin. |

The single source of these decisions is `src/identity/team-access.service.ts`.
It answers three questions about one person and one team — `canView` (A),
`canViewPrivate` (B) and `canManage` (C) — plus `hasClubWideManageAuthority`
(D). Nothing else in the platform decides access for itself; screens read the
same answers and use them to choose what to draw, never as the enforcement.

## The audit

| Module | Class | Owning column | Enforced by |
|---|---|---|---|
| Home / club shell, club structure, team cards | A | — | `listTeamContexts` returns every team with its own access verdict |
| Team identity (`GET /teams/:id`) | A read / C write | `Team.clubId` | `requireTeamRowAccess` |
| Squad, player list and search | B | `Player.teamId` | `privateTeamScope` → `getPlayers({ teamScope })` |
| Player profile, personal data, attributes, audit | B read / C write | `Player.teamId` | `requirePlayerTeamAccess` (`router.param('id')`) |
| Player statistics, season stats, profile (Phase Q) | B | `Player.teamId` | `requirePlayerTeamAccess('playerId')` |
| Player medical profile, workload, injuries, load & fatigue | B | `Player.teamId` | `requirePlayerTeamAccess('playerId')` |
| Squad readiness dashboard | B | `Team.id` in the URL | `requireTeamPrivate({ required: true })` |
| Transfer intelligence, market values, contracts (per player) | B read / C write | `Player.teamId` | `requirePlayerTeamAccess('playerId')` |
| Training sessions — list, open, create, edit, delete | B / C | `TrainingSession.teamId` | `requireTrainingSessionAccess`, `requireTeamManageForCreate`, `requireTeamManage`, and `trainingTeamWhere` inside every read |
| Training attendance, performance, completion | B / C | via the session's team | same gate; the roster is the session's team's squad |
| Training reports and the form ring | B | via the session's team | `getTrainingReport` / `getTrainingForm` take the caller's scope |
| Match calendar (club matches) | B | `Match.teamId` | `privateTeamScope` → `getMatches({ teamScope })` |
| One match, its lineup, events, live control | B read / C write | `Match.teamId` | `requireMatchTeamAccess` (`router.param('id')`) |
| Match Center — calendar, fixture workspace, preparation | B | the fixture's two teams | `resolveTeamScope` → `assertCanViewTeamPrivate`; `fixtureAccess` |
| Match Center — reschedule request and decision | C | the fixture's teams | `assertCanManageTeam` inside the service |
| Familista League — table, fixtures, leaderboards | A (competition) | `Competition.id` | a competition is read by its participants; a team-scoped request checks the team |
| Familista League — administration for a team | C + D | `Competition.ageGroup` | `assertLeagueAdmin` + `access.canViewPrivate` |
| Academy workspace (any age group) | B | `Team.id` | the workspace is not drawn without `canViewPrivate`; every module inside carries the team |
| Video intelligence, private analytics | B | via player / match | the player and match gates above |
| Club settings, membership administration | D | `Club.id` | existing club-admin authorization |
| Transfer market, scouting between clubs | A across clubs | — | unchanged: cross-club projections already strip private columns |

## What changed to make the table true

- `TrainingSession` gained a `teamId` (migration
  `20260904090000_training_session_team`). It is nullable because sessions
  recorded before teams owned them cannot all be attributed honestly; see
  **Migration** below.
- `Player`, `Match`, `Membership` and `Competition` already carried the column
  the rule needed. What they lacked was a rule that read it, which is what
  `team-access.service.ts` and `team-scope.middleware.ts` now are.

## Migration

The backfill assigns a session to a team **only when the data already says so**:

1. every player in the session's squad belongs to the same team, and none of
   them is teamless; or
2. the club has exactly one team, so there is nowhere else the session could
   belong.

Anything else keeps a null team on purpose. Those rows are legacy club
sessions: readable by anybody who works on one of the club's teams — they are
nobody else's team's week — and changeable only by somebody who administers the
club's teams as a whole. A club administrator adopts one by naming a team,
which is an ordinary update and takes an assignment to manage the team named.

Nothing is deleted, nothing is rewritten, and no session is moved from one team
to another. Both `UPDATE` statements only ever fill a `NULL`.

## The rule, for whatever is added next

    RESOURCE  → TEAM      the row carries the team it belongs to
    USER      → TEAM      the membership carries the team it was granted for
    ACTION    → CLASS     read the shell, read the work, or change the work

A new team — a second team, a women's side, another age group — needs no
authorization code: it is a `Team` row, and everything above already reads it.
A new module needs one line: the gate for the column its rows carry.
