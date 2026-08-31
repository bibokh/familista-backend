// Familista League — the competition between clubs on the platform.
//
// Reading is open to every signed-in club: a league table is competitive
// information about all of its participants, and a club may see the competition
// it plays in — including the record of a match it played against somebody else.
//
// Writing is not. Everything below the administration line changes who is in the
// league or when they play, and a league owned by no club has no club
// administrator: only a platform administrator may do it. The rule is enforced
// twice on purpose — `authorize` here, and `assertLeagueAdmin` inside the
// service — so a route mounted without its middleware still refuses.
//
// Note what is *not* here: no endpoint records a league result. A result reaches
// the table by the match being finished in the Match Centre, which is the only
// place a match is played.

import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { UserRole } from '@prisma/client';
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

// Per-team totals over completed league matches — record, home/away split, and
// whatever the Match Centre actually recorded beyond that.
router.get('/team-stats', ctrl.getTeamStats);

// One league match in full: both sides, the Match it is played as, its lineups,
// timeline, player statistics and what analysis exists. This is what the Match
// Centre opens when a fixture is clicked.
router.get('/fixtures/:fixtureId/match', ctrl.getMatchDetail);

// ── Administration ───────────────────────────────────────────────────────────

// Whether the caller may manage the league, and the current participants when
// they may. Readable by anyone: the answer for a normal club is simply "no",
// which is what lets the screen leave the control out rather than show one that
// fails when pressed.
router.get('/manage', ctrl.getManageContext);

router.get('/manage/eligible-teams', authorize(UserRole.SUPER_ADMIN), ctrl.getEligibleTeams);
router.post('/manage/participants', authorize(UserRole.SUPER_ADMIN), ctrl.addParticipant);
router.delete('/manage/participants/:teamId', authorize(UserRole.SUPER_ADMIN), ctrl.removeParticipant);
router.post('/manage/schedule', authorize(UserRole.SUPER_ADMIN), ctrl.rebuildSchedule);
router.patch('/manage/fixtures/:fixtureId', authorize(UserRole.SUPER_ADMIN), ctrl.rescheduleFixture);

export default router;
