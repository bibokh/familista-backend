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
  // ── Step 1: build the Express app + HTTP server (sync, cheap). ─────────
  // Everything below this point that's heavy/slow runs AFTER listen() so
  // Render's port-scanner (≈90 s timeout) sees an open socket immediately.
  const app    = createApp();
  const server = http.createServer(app);

  // Mount tenant-aware match WebSocket BEFORE listen so /ws/match/:id is
  // wired up to the same HTTP server the moment we start accepting.
  mountMatchWebSocket(server);

  // ── Step 2: OPEN THE PORT FIRST. ───────────────────────────────────────
  // Bind to 0.0.0.0 explicitly so Render's port scanner can see it.
  // We do NOT await connectDatabase or any worker start before this —
  // earlier ordering blocked listen() behind ~4 awaited Postgres calls,
  // causing "Port scan timeout reached / No open ports detected" on cold
  // boot and leaving the previous deploy as the active build.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => {
      server.off('error', reject);
      logger.info(`🚀 Familista API listening (warmup running in background)`, {
        port:     config.port,
        host:     '0.0.0.0',
        env:      config.env,
        version:  config.apiVersion,
        api:      `http://localhost:${config.port}/api/${config.apiVersion}`,
      });
      // eslint-disable-next-line no-console
      console.log(`[boot] HTTP server listening on 0.0.0.0:${config.port}`);
      resolve();
    });
  });

  // ── Step 3: background warmup — DB, workers, Phase J seed. ─────────────
  // Failures here do NOT take the server down. /api/v1/health still
  // responds, and Render's scanner has already passed. Routes that need
  // DB will return 503 until connectDatabase resolves; Prisma also
  // lazy-connects on first query, so most reads/writes will work even
  // before this block completes.
  (async () => {
    try {
      await connectDatabase();
      // eslint-disable-next-line no-console
      console.log('[boot] database connected');
    } catch (err) {
      logger.error('[boot] connectDatabase failed (server still serving)', {
        err: (err as Error).message,
      });
    }

    // Each worker start runs in its own try/catch so a single failure
    // can't prevent the others from coming up.
    const safeStart = (label: string, fn: () => void) => {
      try { fn(); } catch (err) {
        logger.error(`[boot] ${label} failed (swallowed)`, { err: (err as Error).message });
      }
    };
    safeStart('startIntelBroadcaster',      () => startIntelBroadcaster());
    safeStart('startAIAgentWorker',         () => startAIAgentWorker());
    safeStart('startAutomationScheduler',   () => startAutomationScheduler());
    safeStart('startStatsAggregatorWorker', () => startStatsAggregatorWorker());
    safeStart('startVideoTranscodeWorker',  () => startVideoTranscodeWorker());

    // Phase J: region presence + billing tier seed (idempotent, best-effort)
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
    // eslint-disable-next-line no-console
    console.log('[boot] warmup complete');
  })().catch((err) => {
    // Defence in depth — even the outer wrapper rejection must not crash
    // the live server.
    logger.error('[boot] warmup orchestrator threw', { err: (err as Error).message });
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
