// Familista — Observability routes (Phase J). Mounted at /api/v1/observability.

import { Router } from 'express';
import * as ctrl from '../controllers/observability.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/metrics',                       authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listMetrics);
router.get('/devices/:deviceId/health',      ctrl.listDeviceHealth);
router.get('/matches/:matchId/integrity',    authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listIntegrity);
router.post('/matches/:matchId/integrity',   authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.checkIntegrity);
router.get('/snapshot',                       authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.snapshot);

export default router;
