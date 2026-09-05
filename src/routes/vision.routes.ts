// Familista — Vision routes (Phase G)
// Mounted at /api/v1/vision.

import { Router } from 'express';
import * as ctrl from '../controllers/vision.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';

const router = Router();

// Frame ingest is HMAC-signed (the camera's hmacSecret IS the auth).
// No user JWT required — registered BEFORE `authenticate`.
router.post('/cameras/:id/frame', ctrl.ingestFrame);

router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. A camera, a frame and a match's video belong to the team that plays it.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

// Multi-sport directory (public to authenticated users).
router.get('/sports', ctrl.listSportAdapters);

// Cameras
router.get('/cameras',                ctrl.listCameras);
router.post('/cameras',               authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.registerCamera);
router.get('/cameras/:id',            ctrl.getCamera);
router.post('/cameras/:id/retire',    authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.retireCamera);

// Calibration
router.get('/cameras/:id/calibration', ctrl.getCalibration);
router.post('/cameras/:id/calibration', authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.applyCalibration);

// Frame log (read)
router.get('/matches/:id/frames', ctrl.listFrames);

export default router;
