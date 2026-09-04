import { Router } from 'express';
import * as ctrl from '../controllers/training.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import {
  requireAnyTeamPrivate,
  requireTeamManage,
  requireTeamManageForCreate,
  requireTrainingSessionAccess,
} from '../middleware/team-scope.middleware';

const router = Router();
router.use(authenticate);

// The training week — the plan, the attendance, the per-player performance — is
// private to the people who work on the club's teams, and now private per TEAM
// rather than per club: a TrainingSession carries the team whose week it is.
//
// Two gates, and they do different jobs:
//
//   · the floor — an ordinary club member, assigned to none of the club's
//     teams, is refused every route here. There is nothing on this router that
//     is public information.
//   · the session — every route addressed by :id is checked against the team
//     that session belongs to. Reading takes private sight of that team,
//     changing it takes an assignment to manage that team, and a session id
//     from another team's week is refused rather than answered.
//
// The list, the report and the form carry no id, and are narrowed inside the
// controller to the teams the caller works on — so a coach assigned to one team
// reads that team's week, never the club's whole calendar.
router.use(requireAnyTeamPrivate());
router.param('id', (req, res, next) => requireTrainingSessionAccess('id')(req, res, next));

router.get('/',                  ctrl.getSessions);
router.get('/form',              ctrl.getForm);
// Stage 2: PostgreSQL-only training reports (daily | weekly | monthly | season).
router.get('/reports',           ctrl.getReport);
// One-time CLUB_ADMIN Squad import + verification. Registered before the
// dynamic /:id routes so "admin" is never captured as an id. Self-disables
// after the first successful import (see controller).
router.post('/admin/import-squad', authorize('CLUB_ADMIN'), ctrl.seedSquadOnce);
router.post('/',                 authorize('CLUB_ADMIN','HEAD_COACH'), requireTeamManageForCreate(), ctrl.createSession);
// New clean Create-Session flow (POST /api/v1/training/sessions). Replaces
// the legacy POST / for the New Session button; the legacy route is kept
// only to avoid breaking any out-of-tree consumer.
router.post('/sessions',         authorize('CLUB_ADMIN','HEAD_COACH'), requireTeamManageForCreate(), ctrl.createNewSession);
router.get('/:id',               ctrl.getSession);
// The :id gate above authorises the session's CURRENT team; this one
// authorises the team a body may be moving it TO, so a session cannot be
// pushed into a team the caller does not manage.
router.put('/:id',               authorize('CLUB_ADMIN','HEAD_COACH'), requireTeamManage(), ctrl.updateSession);
router.patch('/:id',             authorize('CLUB_ADMIN','HEAD_COACH'), requireTeamManage(), ctrl.updateSession);
router.delete('/:id',            authorize('CLUB_ADMIN'),              ctrl.deleteSession);

// Training Attendance MVP — record per (session, player) with 4 marks.
router.get('/:id/attendance',    ctrl.getAttendance);
router.put('/:id/attendance',    authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.saveAttendance);

// Stage 2: per-player performance (ratings/participation) + session completion.
router.put('/:id/performance',   authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.savePerformance);
router.post('/:id/complete',     authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.completeSession);

export default router;
