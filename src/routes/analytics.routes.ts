import { Router } from 'express';
import * as ctrl from '../controllers/analytics.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/overview',          ctrl.getOverview);
router.get('/performance-trend', ctrl.getPerformanceTrend);
router.get('/gps-load',          ctrl.getGpsLoadTrend);

export default router;
