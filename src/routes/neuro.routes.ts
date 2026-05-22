// Familista — Phase K routes. Mounted at /api/v1/neuro.

import { Router } from 'express';
import * as ctrl from '../controllers/neuro.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();

// HMAC-anchored event batch ingest — no JWT (the camera HMAC is the auth).
router.post('/streams/:id/event-batch', ctrl.ingestEventBatch);

router.use(authenticate);
router.use(tenantGuard);

// Event streams
router.post('/streams',                  authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.openStream);
router.get('/streams',                   ctrl.listStreams);
router.post('/streams/:id/close',        authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.closeStream);
router.get('/streams/:id/batches',       ctrl.listBatches);
router.post('/streams/sync',             authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.registerSync);

// Camera rigs
router.post('/rigs',                                authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.createRig);
router.get('/rigs',                                 ctrl.listRigs);
router.get('/rigs/:id',                             ctrl.getRig);
router.post('/rigs/:id/members',                    authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.addRigMember);
router.delete('/rigs/:id/members/:memberId',        authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.removeRigMember);
router.post('/rigs/:id/sync-sessions',              authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.startSyncSession);
router.post('/rigs/sync-sessions/:sessionId/observations', authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordObservation);

// Edge vision runtime
router.post('/runtimes',                       authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.provisionRuntime);
router.get('/runtimes',                        ctrl.listRuntimes);
router.post('/runtimes/:id/inference',         authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordInference);
router.post('/runtimes/:id/health',            ctrl.recordRuntimeHealth);

// Edge model manifests + versions
router.post('/models/manifests',               authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishManifest);
router.post('/models/versions',                authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishModelVersion);

// Tactical detectors
router.post('/matches/:id/detect/:kind',       authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH'), ctrl.runTacticalDetector);

// Biomechanical patches
router.post('/biomech/:deviceId/packet',       ctrl.ingestBiomech);
router.get('/biomech',                          ctrl.listBiomech);

// Neuromorphic metric snapshot (pure-function utility)
router.post('/metrics/snapshot',               ctrl.metricsSnapshot);

export default router;
