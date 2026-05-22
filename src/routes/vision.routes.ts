// Familista — Vision routes (Phase G)
// Mounted at /api/v1/vision.

import { Router } from 'express';
import * as ctrl from '../controllers/vision.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Frame ingest is HMAC-signed (the camera's hmacSecret IS the auth).
// No user JWT required — registered BEFORE `authenticate`.
router.post('/cameras/:id/frame', ctrl.ingestFrame);

router.use(authenticate);

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
