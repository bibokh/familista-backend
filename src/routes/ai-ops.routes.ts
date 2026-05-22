// Familista — AI Operations routes (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// Global (cross-match) CRUD over alerts / recommendations / reports.
// Match-scoped reads also exist on /api/v1/matches/:id/{alerts,recommendations,reports}
// for convenience; the underlying service is the same.

import { Router } from 'express';
import * as ctrl from '../controllers/ai-ops.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

// ── Alerts ─────────────────────────────────────────────────────────────
router.get('/alerts',                ctrl.listAlerts);
router.post('/alerts',               authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), ctrl.createAlert);
router.post('/alerts/:id/ack',       ctrl.ackAlert);
router.post('/alerts/:id/resolve',   ctrl.resolveAlert);
router.post('/alerts/:id/mute',      authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.muteAlert);

// ── Recommendations ────────────────────────────────────────────────────
router.get('/recommendations',                  ctrl.listRecommendations);
router.post('/recommendations',                 authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), ctrl.createRecommendation);
router.post('/recommendations/:id/ack',         ctrl.ackRecommendation);

// ── Reports ────────────────────────────────────────────────────────────
router.get('/reports',           ctrl.listReports);
router.get('/reports/:id',       ctrl.getReport);
router.post('/reports',          authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.createReport);

// ── Phase F · Agent orchestration ──────────────────────────────────────
// Enqueue a job for a specific agent (deterministic handler runs first;
// LLM only fires if ANTHROPIC_API_KEY is set and the handler returns null).
router.post('/agents/:agent/run', authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), ctrl.runAgent);
router.get('/jobs/:id',           ctrl.getAgentJob);

// ── Phase F · Anomaly detector ─────────────────────────────────────────
router.get('/anomalies',                ctrl.scanAnomalies);
router.post('/anomalies/materialise',   authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.materialiseAnomalies);

export default router;
