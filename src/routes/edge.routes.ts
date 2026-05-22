// Familista — Edge compute routes (Phase J). Mounted at /api/v1/edge.

import { Router } from 'express';
import * as ctrl from '../controllers/edge.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);
router.use(tenantGuard);

router.get('/nodes',                       ctrl.list);
router.post('/nodes',                      authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.register);
router.get('/nodes/:id',                   ctrl.getOne);
router.post('/nodes/:id/retire',           authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.retire);
router.post('/nodes/:id/sync-window',      authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordSync);
router.post('/nodes/:id/buffer',           authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordBuffer);
router.post('/nodes/:id/inference',        authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordInference);

export default router;
