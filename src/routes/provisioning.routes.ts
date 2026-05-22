// Familista — Manufacturing-grade provisioning routes (Phase J).
// Mounted at /api/v1/provisioning.

import { Router } from 'express';
import * as ctrl from '../controllers/provisioning.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

// Batch management — factory operators / club admins only.
router.get('/batches',                     authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.listBatches);
router.post('/batches',                    authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.createBatch);
router.get('/batches/:id',                 authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.getBatch);
router.post('/batches/:id/materialise',    authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.materialiseBatch);

// Certificates.
router.post('/certificates',               authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.issueCert);
router.post('/certificates/:certId/revoke', authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.revokeCert);
router.get('/devices/:deviceId/certificates', authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listCertsForDevice);

// Firmware manifests + OTA rollout.
router.get('/firmware/manifests',          ctrl.listManifests);
router.post('/firmware/manifests',         authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishManifest);
router.get('/firmware/releases',           ctrl.listReleases);
router.post('/firmware/releases',          authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.createOTARelease);
router.post('/firmware/releases/:releaseId/advance', authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.advanceRollout);

export default router;
