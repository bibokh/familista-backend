// Familista — Vision Intelligence Engine
// Wiring patch + operational notes. Documentation, not runtime code.

/* ──────────────────────────────────────────────────────────────────────────── *
 *  1. routes/index.ts — mount the vision router
 * ──────────────────────────────────────────────────────────────────────────── */
// import visionRoutes from './vision-engine.routes';
// router.use('/vision', visionRoutes);

/* ──────────────────────────────────────────────────────────────────────────── *
 *  2. Schema fragment ordering
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Append fragments in this order:
 *    whitelabel → admin-whitelabel → franchise → investor → ai-engine → vision
 *
 *  No edits to existing models are required — vision uses soft string IDs
 *  for subjects so the audit trail outlives Player / Match / TrainingSession
 *  deletions. Run:
 *
 *    npx prisma migrate dev --name vision_engine
 *    npx prisma generate
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  3. Environment variables
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Inference adapter (default STUB — fully functional for development):
 *    VISION_INFERENCE_BACKEND   = STUB | INTERNAL_WORKER | STATS_PERFORM | HUDL
 *
 *  INTERNAL_WORKER additionally requires:
 *    VISION_WORKER_URL                 e.g. https://yolov8.familista.internal
 *    VISION_WORKER_CALLBACK_URL        e.g. https://api.familista.app/api/v1/vision/webhooks/inference
 *    VISION_WORKER_TOKEN               shared secret echoed by the worker
 *    VISION_WEBHOOK_TOKEN              shared secret required on inbound webhook calls
 *
 *  Clip adapter:
 *    VISION_CLIP_BACKEND        = STUB | FFMPEG_WORKER | AWS_MEDIA_CONVERT | MUX
 *    VISION_CLIP_WORKER_URL / _CALLBACK_URL / _TOKEN
 *    VISION_CLIP_WEBHOOK_TOKEN          shared secret on clip render callbacks
 *
 *  Fusion weights (operator-tunable):
 *    VISION_FUSION_DISTANCE_WEIGHT     default 0.5
 *    VISION_FUSION_TOPSPEED_WEIGHT     default 0.3
 *
 *  External providers (only if backend set to that name):
 *    STATS_PERFORM_API_KEY
 *    HUDL_API_KEY
 *    AWS_MEDIA_CONVERT_QUEUE_ARN
 *    MUX_TOKEN_ID / MUX_TOKEN_SECRET
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  4. Required NPM packages
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  No new runtime dependencies for the default STUB adapters. The vision
 *  engine uses the native `fetch` (Node 18+) for adapter outbound calls.
 *
 *  Optional, only if you switch to a real provider:
 *    @aws-sdk/client-mediaconvert   (AWS_MEDIA_CONVERT clip backend)
 *    @mux/mux-node                  (MUX clip backend)
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  5. Pipeline contract
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Stage flow for a VideoIngestJob (also written to AIDecision-style audit
 *  on every transition):
 *
 *    UPLOADED → DEMUXED → INFERRED → TRACKED → EVENTS_DETECTED
 *              → ANALYTICS_COMPUTED → FUSED → COMPLETED
 *
 *  Producer side (any worker / provider):
 *    • POST /api/v1/vision/videos                                   (auth)
 *    • POST /api/v1/vision/videos/:id/ingest                        (auth)
 *      ↳ engine calls InferenceAdapter.submitVideo() and returns the
 *        ingest job + analysis run. Adapter returns externalJobId.
 *
 *  Worker → engine webhook (shared secret):
 *    • POST /api/v1/vision/webhooks/inference/:jobId                (webhook)
 *      ↳ persists PlayerTrack[] + BallTrack[] + MatchEvent[], moves stage
 *        to EVENTS_DETECTED, marks the analysis run COMPLETED.
 *    • POST /api/v1/vision/webhooks/inference/:jobId/fail           (webhook)
 *
 *  Consumer side:
 *    • POST /api/v1/vision/analyses/:id/analytics/run               (auth)
 *      ↳ writes AnalyticsResult rows per kind; advances stage to
 *        ANALYTICS_COMPUTED.
 *    • POST /api/v1/vision/fusion/run                               (auth)
 *      ↳ reconciles PlayerTrack with PlayerGpsData → FusedPlayerSample;
 *        advances stage to FUSED.
 *
 *  Clip pipeline (independent):
 *    • POST /api/v1/vision/clips                                    (auth)
 *    • POST /api/v1/vision/clips/highlights                         (auth)
 *      ↳ calls ClipAdapter.submit() for each clip.
 *    • POST /api/v1/vision/webhooks/clip/:externalRenderId          (webhook)
 *      ↳ marks Clip rows READY / FAILED.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  6. Real-time SSE
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *    GET  /api/v1/vision/live/:matchId/stream     (SSE — sideline dashboards)
 *    PUT  /api/v1/vision/live/:matchId            (create / update stream)
 *    POST /api/v1/vision/live/:matchId/status     (IDLE | LIVE | PAUSED | ENDED)
 *    POST /api/v1/vision/live/:matchId/events     (publish a vision event)
 *    GET  /api/v1/vision/live/:matchId/events     (history)
 *
 *  Heartbeats every 15s, JSON-line `event: heartbeat`. Subscribers are
 *  in-memory; deploying behind a horizontal proxy requires sticky sessions
 *  or a Redis fan-out layer (a future enhancement — interface is already
 *  isolated to `broadcast()` inside vision-realtime.service.ts).
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  7. Governance contract
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Explainable + audit-safe by construction:
 *    • Every analysis run records modelProvider + modelVersion + confidence.
 *    • Every MatchEvent carries a confidence score and may be overridden;
 *      the override stores reason + overriddenBy + overriddenAt without
 *      destroying the AI-derived original.
 *    • Every AnalyticsResult carries its own confidence and the exact
 *      window it was computed over.
 *    • FusedPlayerSample records both inputs (vision + sensor), the fused
 *      output, a verdict, an agreement score, and conflict reasons.
 *    • VisionAudit captures every state change: ingest stage transitions,
 *      inference webhook ingest, override events, analytics runs, fusion
 *      runs, clip requests + render callbacks, scouting generation, live
 *      stream lifecycle, webhook auth rejections.
 *
 *  Human override path: PATCH /api/v1/vision/events/:id/override (with
 *  reason) gives coaches and analysts authority over any AI-derived event
 *  while preserving the AI lineage.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  8. Cross-engine integration map
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Vision reads from:
 *    • Match, Player, Club, TrainingSession (existing Familista models)
 *    • PlayerGpsData (existing) — fusion input
 *    • AIDecision (optional — coach tablet can blend AI recommendations
 *      with vision events on the sideline dashboard)
 *
 *  Vision writes to its own tables only — never mutates existing operational
 *  data. Acting on a vision insight (e.g. substituting a fatigued player)
 *  is always an explicit operator step through the existing domain APIs.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  9. CORS + body limits
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Inference webhooks can post large payloads (player tracks + events). The
 *  current `express.json({ limit: '2mb' })` in app.ts is too small for full
 *  match results — raise the limit specifically for the webhook routes:
 *
 *    app.use('/api/v1/vision/webhooks/inference', express.json({ limit: '32mb' }));
 *
 *  declared BEFORE `app.use('/api/v1', routes)` so the larger limit wins for
 *  that path.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  10. Background jobs (cron / scheduler)
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Optional polling loop for the INTERNAL_WORKER backend (when workers don't
 *  push callbacks reliably):
 *
 *    import { getInferenceAdapter } from './services/vision-inference.adapter';
 *    import { prisma } from './lib/prisma';
 *
 *    setInterval(async () => {
 *      const open = await prisma.videoIngestJob.findMany({
 *        where: { status: { in: ['QUEUED', 'RUNNING'] }, externalJobId: { not: null } },
 *        take: 50,
 *      });
 *      const adapter = getInferenceAdapter();
 *      for (const job of open) {
 *        try {
 *          const status = await adapter.pollStatus(job.externalJobId!);
 *          // Update progress / surface failures here.
 *          void status;
 *        } catch (e) { console.warn('poll failed', e); }
 *      }
 *    }, 5 * 60 * 1000);
 */
