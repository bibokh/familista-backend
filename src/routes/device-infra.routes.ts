// Familista — Device Infrastructure routes (Phase F)
// Mounted at /api/v1/device-infra (NOT under /devices to avoid collision
// with the Phase B /devices/sessions/* routes).

import { Router } from 'express';
import * as ctrl from '../controllers/device-infra.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// Public-ish: device activation (HMAC-signed body). NO user auth — the
// HMAC IS the auth, and we verify against the row's `hmacSecret`.
router.post('/devices/by-serial/:serial/activate', ctrl.activate);

router.use(authenticate);

// Device registry
router.get('/devices',                ctrl.list);
router.post('/devices',               authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.register);
router.get('/devices/:id',            ctrl.getOne);
router.post('/devices/:id/retire',    authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.retire);
router.post('/devices/:id/revoke',    authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.revoke);

// Firmware (OTA)
router.get('/devices/:id/firmware',   ctrl.fwCheck);
router.get('/firmware',               ctrl.fwList);
router.post('/firmware',              authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.fwPublish);

// Calibration
router.get('/devices/:id/calibration',         ctrl.calibrationGet);
router.get('/devices/:id/calibration/history', ctrl.calibrationHistory);
router.post('/devices/:id/calibration',        authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.calibrationApply);

export default router;
