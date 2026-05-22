// Familista — Distributed infrastructure routes (Phase J)
// Mounted at /api/v1/distributed.

import { Router } from 'express';
import * as ctrl from '../controllers/distributed.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/regions',          ctrl.listRegions);
router.get('/regions/health',   authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.snapshotHealth);
router.get('/whoami',           ctrl.whoami);
router.get('/region/resolve',   ctrl.resolveForClub);

export default router;
