import { Router } from 'express';
import * as ctrl from '../controllers/analytics.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

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
