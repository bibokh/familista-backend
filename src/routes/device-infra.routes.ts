// Familista — Device Infrastructure routes (Phase F)
// Mounted at /api/v1/device-infra (NOT under /devices to avoid collision
// with the Phase B /devices/sessions/* routes).

import { Router } from 'express';
import * as ctrl from '../controllers/device-infra.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantParam } from '../middleware/tenant-guard.middleware';
import { requirePlatformAuthority } from '../middleware/platform-authority.middleware';

const router = Router();

// Public-ish: device activation (HMAC-signed body). NO user auth — the
// HMAC IS the auth, and we verify against the row's `hmacSecret`.
router.post('/devices/by-serial/:serial/activate', ctrl.activate);

router.use(authenticate);

// Device registry
router.get('/devices',                ctrl.list);
router.post('/devices',               authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.register);
router.get('/devices/:id',            tenantParam('device'), ctrl.getOne);
router.post('/devices/:id/retire',    tenantParam('device'), authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.retire);
router.post('/devices/:id/revoke',    tenantParam('device'), authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.revoke);

// Firmware (OTA)
router.get('/devices/:id/firmware',   tenantParam('device'), ctrl.fwCheck);
router.get('/firmware',               ctrl.fwList);
// Published firmware (version, sha256, download URL) is served to every club's
// devices of that model, so publishing it is the platform's alone (R11).
router.post('/firmware',              requirePlatformAuthority, ctrl.fwPublish);

// Calibration
router.get('/devices/:id/calibration',         tenantParam('device'), ctrl.calibrationGet);
router.get('/devices/:id/calibration/history', tenantParam('device'), ctrl.calibrationHistory);
router.post('/devices/:id/calibration',        tenantParam('device'), authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.calibrationApply);

export default router;
