// Match Center — the club's global match calendar and preparation hub.
//
// Every route is scoped to the caller's own club by the service, which asks the
// club's FIRST TEAM ids and refuses a fixture neither of them is in. There is no
// route here that creates a fixture: the Match Center displays fixtures the
// competition engine owns, and displaying one is never a reason to copy it.
//
// The one write path is the reschedule workflow, and it does not write the
// fixture until a change has been accepted by the opponent and approved by the
// competition. Kickoff validation happens inside the service on every step, in
// the venue's own time zone — never on the client's say-so.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/match-center.controller';

const router = Router();
router.use(authenticate);

// Every first-team fixture the club has, across every competition it plays in.
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
