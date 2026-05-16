// Familista — Vision Intelligence Engine
// File location: src/routes/vision-engine.routes.ts
//
// Mount under /api/v1/vision. Two auth modes:
//   • Authenticated routes use authenticate + attachVisionContext.
//   • Webhook routes use requireWebhookAuth(headerName, envName) — the
//     inference / clip workers carry a shared secret in the header configured
//     by env (VISION_WEBHOOK_TOKEN for inference, VISION_CLIP_WEBHOOK_TOKEN
//     for clip callbacks).

import { Router } from 'express';

import * as ctrl from '../controllers/vision-engine.controller';
import { authenticate } from '../middleware/auth.middleware';
import {
  attachVisionContext,
  requireVisionContext,
  requireWebhookAuth,
} from '../middleware/vision-access.middleware';

const router = Router();

// ── 10. Webhooks (registered before auth so workers can POST) ──────────────
router.post(
  '/webhooks/inference/:jobId',
  requireWebhookAuth('x-vision-inference-token', 'VISION_WEBHOOK_TOKEN'),
  ctrl.inferenceResultsWebhook,
);
router.post(
  '/webhooks/inference/:jobId/fail',
  requireWebhookAuth('x-vision-inference-token', 'VISION_WEBHOOK_TOKEN'),
  ctrl.ingestFailureWebhook,
);
router.post(
  '/webhooks/clip/:externalRenderId',
  requireWebhookAuth('x-vision-clip-token', 'VISION_CLIP_WEBHOOK_TOKEN'),
  ctrl.clipRenderWebhook,
);

// All remaining routes require a logged-in user.
router.use(authenticate, attachVisionContext, requireVisionContext);

// ── 1. Videos ──────────────────────────────────────────────────────────────
router.post('/videos', ctrl.registerVideo);
router.get('/videos', ctrl.listVideos);
router.get('/videos/:id', ctrl.getVideo);
router.patch('/videos/:id', ctrl.updateVideo);

// ── 2. Ingest ──────────────────────────────────────────────────────────────
router.post('/videos/:id/ingest', ctrl.startIngest);
router.get('/ingest/:jobId', ctrl.getIngestJob);
router.post('/ingest/:jobId/transition', ctrl.transitionIngest);

// ── 3. Analysis + tracks ───────────────────────────────────────────────────
router.get('/analyses', ctrl.listAnalyses);
router.get('/analyses/:id', ctrl.getAnalysis);
router.get('/analyses/:id/tracks', ctrl.listPlayerTracks);
router.get('/analyses/:id/tracks/summary', ctrl.playerTrackSummary);
router.get('/analyses/:id/ball-tracks', ctrl.listBallTracks);

// ── 4. Events ──────────────────────────────────────────────────────────────
router.get('/events', ctrl.listEvents);
router.get('/events/counts', ctrl.eventCounts);
router.get('/events/:id', ctrl.getEvent);
router.patch('/events/:id/override', ctrl.overrideEvent);

// ── 5. Analytics ───────────────────────────────────────────────────────────
router.post('/analyses/:id/analytics/run', ctrl.runAnalytics);
router.get('/analytics', ctrl.listAnalytics);
router.get('/matches/:matchId/analytics/:kind/latest', ctrl.getLatestMatchAnalytic);

// ── 6. Fusion ──────────────────────────────────────────────────────────────
router.post('/fusion/run', ctrl.runFusion);
router.get('/fusion', ctrl.listFusion);

// ── 7. Clips ───────────────────────────────────────────────────────────────
router.post('/clips', ctrl.requestClip);
router.post('/clips/highlights', ctrl.generateHighlights);
router.get('/clips', ctrl.listClips);
router.get('/clips/:id', ctrl.getClip);

// ── 8. Scouting ────────────────────────────────────────────────────────────
router.post('/scouting', ctrl.generateScouting);
router.get('/scouting', ctrl.listScouting);
router.get('/scouting/:id', ctrl.getScouting);

// ── 9. Live streams ────────────────────────────────────────────────────────
router.put('/live/:matchId', ctrl.upsertLiveStream);
router.post('/live/:matchId/status', ctrl.transitionLive);
router.post('/live/:matchId/events', ctrl.publishLiveEvent);
router.get('/live/:matchId/stream', ctrl.subscribeLive);
router.get('/live/:matchId/events', ctrl.listLiveEvents);
router.get('/live/:matchId', ctrl.getLiveStream);

// ── 11. Audit ──────────────────────────────────────────────────────────────
router.get('/audit', ctrl.searchAudit);
router.get('/audit/summary', ctrl.summarizeAudit);

export default router;
