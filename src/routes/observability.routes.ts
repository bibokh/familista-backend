// Familista — Observability routes (Phase J). Mounted at /api/v1/observability.

import { Router } from 'express';
import * as ctrl from '../controllers/observability.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';

const router = Router();
router.use(authenticate);

// Team scope. A match's telemetry belongs to the team that played it.
// The same access service the Squad, Training, the Match Center and the
// Familista League use: a team, player or match id from another team or
// another club is refused with 403 before the handler runs.
guardTeamScopedRouter(router);

router.get('/metrics',                       authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listMetrics);
router.get('/devices/:deviceId/health',      ctrl.listDeviceHealth);
router.get('/matches/:matchId/integrity',    authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.listIntegrity);
router.post('/matches/:matchId/integrity',   authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.checkIntegrity);
router.get('/snapshot',                       authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.snapshot);

export default router;
