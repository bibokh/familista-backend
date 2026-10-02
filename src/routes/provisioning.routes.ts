// Familista — Manufacturing-grade provisioning routes (Phase J).
// Mounted at /api/v1/provisioning.

import { Router } from 'express';
import * as ctrl from '../controllers/provisioning.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requirePlatformAuthority } from '../middleware/platform-authority.middleware';

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

// Firmware manifests + OTA rollout. These rows belong to no club: a manifest,
// a release and its rollout percentage reach every club's devices of that
// model. Writing them is the platform's, never a club role's (Cyber Defense R11).
router.get('/firmware/manifests',          ctrl.listManifests);
router.post('/firmware/manifests',         requirePlatformAuthority, ctrl.publishManifest);
router.get('/firmware/releases',           ctrl.listReleases);
router.post('/firmware/releases',          requirePlatformAuthority, ctrl.createOTARelease);
router.post('/firmware/releases/:releaseId/advance', requirePlatformAuthority, ctrl.advanceRollout);

export default router;
