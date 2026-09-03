// Match Center — the club's global match calendar and preparation hub.
//
// There is no route here that creates a fixture: the Match Center displays
// fixtures the competition engine owns, and displaying one is never a reason to
// copy it.
//
// The one write path is the reschedule workflow, and it does not write the
// fixture until a change has been accepted by the opponent and approved by the
// competition. Kickoff validation happens inside the service on every step, in
// the venue's own time zone — never on the client's say-so.
//
// Access is per TEAM, not per club. Reading a fixture takes access to one of its
// teams; changing one takes an assignment to manage that team. Both are checked
// in the service against identity/team-access.service.ts, so a team id typed
// into a URL by somebody who is not assigned to it is refused by the server
// whatever the interface did or did not show.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/match-center.controller';

const router = Router();
router.use(authenticate);

// Every team in the club, and what this caller may do with each. The First Team
// and every academy age group answer through the same shape.
router.get('/teams', ctrl.getTeamContexts);

// One team's fixtures, across every competition it plays in. `?teamId=` names
// the team; without it the answer is the First Team's, which is what this route
// meant before academy teams had a calendar of their own.
router.get('/calendar', ctrl.getCalendar);

// One fixture in full — both sides, both squads, lineups, timeline, statistics.
router.get('/fixtures/:fixtureId', ctrl.getFixture);

// The kickoff window this fixture is judged against, and the zone it is in.
router.get('/fixtures/:fixtureId/scheduling-policy', ctrl.getSchedulingPolicy);

// The reschedule workflow: the audit history, a new request, and a decision.
router.get('/fixtures/:fixtureId/change-requests', ctrl.listRequests);
router.post('/fixtures/:fixtureId/change-requests', ctrl.createRequest);
router.post('/change-requests/:requestId/action', ctrl.actOnRequest);

export default router;
