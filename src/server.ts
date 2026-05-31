// MUST be first: regenerates a stale Prisma Client BEFORE @prisma/client loads.
import './bootstrap-prisma';
import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { connectDatabase, disconnectDatabase } from './config/database';
import { logger } from './utils/logger';
// Phase C — realtime + workers
import { mountMatchWebSocket }       from './realtime/match-ws';
// Phase 16 — real-time intelligence broadcaster
import { startIntelBroadcaster, stopIntelBroadcaster } from './live-intelligence/intel-broadcaster';
import { startAIAgentWorker, stopAIAgentWorker }       from './workers/ai-agent.worker';
import { startAutomationScheduler, stopAutomationScheduler } from './workers/automation.worker';
import { startRetentionWorker, stopRetentionWorker } from './workers/retention.worker';
import { startNotificationDispatchWorker, stopNotificationDispatchWorker } from './workers/notification-dispatch.worker';
// Phase Q — stats aggregator (drains EventOutbox → rebuilds PlayerMatchStats + season rollup)
import { startStatsAggregatorWorker, stopStatsAggregatorWorker } from './workers/stats-aggregator.worker';
// Phase S.1 — video transcode (polls VideoTranscodeJob QUEUED → FFmpeg HLS → S3)
import { startVideoTranscodeWorker, stopVideoTranscodeWorker } from './workers/video-transcode.worker';

// ── Boot ──────────────────────────────────────────────────
// NOTE: The legacy GPS demo WebSocket (/ws/live) and its associated
// mock-data generator (generateSimulatedGpsUpdate / startGpsSimulator)
// have been removed.  Real-time GPS data enters via:
//   • POST /api/v1/sensor-ingest/:deviceId/packet  (device push)
//   • POST /api/v1/device-sessions/:id/packet      (device session ingest)
// Clients subscribe to live match state via /ws/match/:id (Phase C).

async function bootstrap() {
  await connectDatabase();

  const app    = createApp();
  const server = http.createServer(app);

  // ── Phase C: tenant-aware match WebSocket at /ws/match/:id ───────────
  mountMatchWebSocket(server);

  // ── Phase 16: intel broadcaster (subscribes to MatchChannel globally) ──
  startIntelBroadcaster();

  // ── Phase C: background workers ──────────────────────────────────────
  startAIAgentWorker();
  startAutomationScheduler();
  // ── Phase Q: stats aggregator (EventOutbox → PlayerMatchStats) ────────
  startStatsAggregatorWorker();
  // ── Phase S.1: video transcode (VideoTranscodeJob QUEUED → HLS) ───────
  startVideoTranscodeWorker();

  // ── Phase J: region presence + billing tier seed (idempotent, best-effort)
  try {
    const { ensureRegions, registerThisNode, startHeartbeat } = await import('./distributed/region.service');
    const { ensureDefaultTiers } = await import('./billing/plans.service');
    await ensureRegions();
    await registerThisNode();
    startHeartbeat();
    await ensureDefaultTiers();
  } catch (err) {
    logger.warn('[phase-j] region/billing bootstrap failed (swallowed)', { err: (err as Error).message });
  }

  server.listen(config.port, () => {
    logger.info(`🚀 Familista API running`, {
      port:     config.port,
      env:      config.env,
      version:  config.apiVersion,
      api:      `http://localhost:${config.port}/api/${config.apiVersion}`,
    });
  });

  // ── Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    // Stop workers BEFORE the HTTP server so in-flight loops finish cleanly.
    try {       stopIntelBroadcaster();      } catch (_) {}
    try { await stopAIAgentWorker();        } catch (_) {}
    try { await stopAutomationScheduler();  } catch (_) {}
    try {       stopRetentionWorker();      } catch (_) {}
    try {       stopNotificationDispatchWorker(); } catch (_) {}
    try {       stopStatsAggregatorWorker();  } catch (_) {}
    try {       stopVideoTranscodeWorker();   } catch (_) {}
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  // Winston JSON-serialises Error to {}. Print the real fields explicitly so
  // the cause is visible in Render logs.
  const e = err as { message?: string; stack?: string; name?: string; code?: string | number };
  logger.error('Bootstrap failed', {
    name:    e?.name,
    code:    e?.code,
    message: e?.message,
    stack:   e?.stack,
  });
  // Mirror to console so even if winston is misconfigured the error escapes.
  // eslint-disable-next-line no-console
  console.error('[bootstrap-failed]', err);
  process.exit(1);
});
