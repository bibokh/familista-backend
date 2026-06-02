import { Router } from 'express';
import * as ctrl from '../controllers/training.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/',                  ctrl.getSessions);
router.get('/form',              ctrl.getForm);
router.post('/',                 authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createSession);
// New clean Create-Session flow (POST /api/v1/training/sessions). Replaces
// the legacy POST / for the New Session button; the legacy route is kept
// only to avoid breaking any out-of-tree consumer.
router.post('/sessions',         authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createNewSession);
router.get('/:id',               ctrl.getSession);
router.put('/:id',               authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updateSession);
router.patch('/:id',             authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updateSession);
router.delete('/:id',            authorize('CLUB_ADMIN'),              ctrl.deleteSession);

// Training Attendance MVP — record per (session, player) with 4 marks.
router.get('/:id/attendance',    ctrl.getAttendance);
router.put('/:id/attendance',    authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.saveAttendance);

export default router;
