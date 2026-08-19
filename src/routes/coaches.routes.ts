// Familista — the current technical staff directory
// ─────────────────────────────────────────────────────────────────────────────
// Its own module and its own routes. It is not the staff market and it is not a
// view of it: this answers "who is working where, right now", read from the
// teams and memberships the platform already holds, and it is where a club runs
// its own technical staff — hiring, moving between its teams, and releasing.
//
// It shares one thing with the market, deliberately — the person. The same
// canonical staff profile is opened from either, because a coach is one person
// with one record whichever screen he is looked at from.

import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/coaches.controller';

const router = Router();
router.use(authenticate);

// Changing a club's own staff is a club-operator action, the same tier the
// market takes for a recruitment decision.
const STAFF_ROLES = ['SUPER_ADMIN', 'CLUB_ADMIN', 'MANAGER', 'HEAD_COACH'] as const;
const staffGuard = authorize(...STAFF_ROLES);

// Every current team and its technical staff. Reading, so any authenticated
// club may do it — the same tier that may read the market.
// Read by drilling in: the clubs, then one club's teams, then one team's
// staff. Nothing loads the level below the one being looked at.
router.get('/clubs',                    ctrl.clubs);
router.get('/clubs/:clubId/teams',      ctrl.clubTeams);
router.get('/teams/:teamId/staff',      ctrl.teamStaff);
router.get('/directory',                ctrl.directory);

// ── running the club's own staff ────────────────────────────────────────────
router.post('/staff',                          staffGuard, ctrl.addStaff);
router.post('/staff/:staffUserId/move',        staffGuard, ctrl.moveStaff);
router.post('/staff/:staffUserId/release',     staffGuard, ctrl.releaseStaff);

// ── the record it keeps about them ──────────────────────────────────────────
router.put('/staff/:staffUserId/career',                staffGuard, ctrl.saveCareer);
router.delete('/staff/:staffUserId/career/:entryId',    staffGuard, ctrl.removeCareer);
router.put('/staff/:staffUserId/achievements',          staffGuard, ctrl.saveTrophy);
router.delete('/staff/:staffUserId/achievements/:trophyId', staffGuard, ctrl.removeTrophy);

// ── sample staff, while the platform is being built ─────────────────────────
// Fills only teams that have nobody in them, marks everything it makes, and
// removes exactly what it made. It is never automatic.
router.post('/demo-staff',   staffGuard, ctrl.seedDemo);
router.delete('/demo-staff', staffGuard, ctrl.clearDemo);

export default router;
