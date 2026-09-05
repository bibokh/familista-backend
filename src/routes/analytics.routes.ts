import { Router } from 'express';
import * as ctrl from '../controllers/analytics.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';

const router = Router();
router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. Per-player analytics is that player's team's private performance data.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

// ── Existing endpoints ─────────────────────────────────────────────────────
router.get('/overview',          ctrl.getOverview);
router.get('/performance-trend', ctrl.getPerformanceTrend);
router.get('/gps-load',          ctrl.getGpsLoadTrend);

// ── New endpoints ──────────────────────────────────────────────────────────
// Player drill-down analytics (any authenticated club member)
router.get('/player/:playerId',  ctrl.getPlayerAnalytics);

// Team analytics (coaches, analysts, admins)
router.get(
  '/team',
  authorize('CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST'),
  ctrl.getTeamAnalytics,
);

// AI readiness scores (coaches and admins)
router.get(
  '/readiness',
  authorize('CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST'),
  ctrl.getReadinessScores,
);

// Risk alerts (coaches and admins only)
router.get(
  '/risks',
  authorize('CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST'),
  ctrl.getRiskAlerts,
);

export default router;
