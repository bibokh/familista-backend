// Familista League — the competition between clubs on the platform.
//
// Read-only, and authenticated. A league table is competitive information about
// every participant, so any signed-in club may read it; nothing here can change
// a fixture, a result or a table. Editing the league stays where it already
// was — the competition engine — where a competition with no owning club is
// editable by SUPER_ADMIN alone.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/familista-league.controller';

const router = Router();
router.use(authenticate);

// The league, its season, its rules, and which teams are the reader's own.
router.get('/overview', ctrl.getOverview);

// The table, with each row's configured zone attached.
router.get('/standings', ctrl.getStandings);

// One round of fixtures, plus the round index so the client can page through
// them without a second call. Omitting ?round= gives the current round.
router.get('/matches', ctrl.getMatches);

// Goals, rating and assists across this league's matches only.
router.get('/leaderboards', ctrl.getLeaderboards);

// One participating team's league record.
router.get('/teams/:teamId', ctrl.getTeamRecord);

export default router;
