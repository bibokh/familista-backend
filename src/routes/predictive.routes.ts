// Familista — Predictive routes (Phase G)
// Mounted at /api/v1/predictive.

import { Router } from 'express';
import * as ctrl from '../controllers/predictive.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';

const router = Router();
router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. A prediction is computed from a team's own match and player data.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

// Read-only cross-match prediction log.
router.get('/predictions',              ctrl.listPredictionsCtl);

// Run all 4 predictors against a match. Persists Prediction rows unless body { "dryRun": true }.
router.post('/matches/:id/run',         authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), ctrl.runPredictors);

export default router;
