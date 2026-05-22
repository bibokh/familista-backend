// Familista — Predictive routes (Phase G)
// Mounted at /api/v1/predictive.

import { Router } from 'express';
import * as ctrl from '../controllers/predictive.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

// Read-only cross-match prediction log.
router.get('/predictions',              ctrl.listPredictionsCtl);

// Run all 4 predictors against a match. Persists Prediction rows unless body { "dryRun": true }.
router.post('/matches/:id/run',         authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), ctrl.runPredictors);

export default router;
