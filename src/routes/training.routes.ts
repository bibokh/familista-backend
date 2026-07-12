import { Router } from 'express';
import * as ctrl from '../controllers/training.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/',                  ctrl.getSessions);
router.get('/form',              ctrl.getForm);
// Stage 2: PostgreSQL-only training reports (daily | weekly | monthly | season).
router.get('/reports',           ctrl.getReport);
// One-time CLUB_ADMIN Squad import + verification. Registered before the
// dynamic /:id routes so "admin" is never captured as an id. Self-disables
// after the first successful import (see controller).
router.post('/admin/import-squad', authorize('CLUB_ADMIN'), ctrl.seedSquadOnce);
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

// Stage 2: per-player performance (ratings/participation) + session completion.
router.put('/:id/performance',   authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.savePerformance);
router.post('/:id/complete',     authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.completeSession);

export default router;
