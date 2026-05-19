import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createApp } from './app';
import { config } from './config';
import { connectDatabase, disconnectDatabase } from './config/database';
import { logger } from './utils/logger';

// ── GPS Live Tracking via WebSocket ──────────────────────

interface LiveClient {
  ws: WebSocket;
  clubId: string;
}

const liveClients = new Map<string, LiveClient>();

function startGpsSimulator(wss: WebSocketServer) {
  // Broadcast simulated GPS updates to connected clients every second
  setInterval(() => {
    liveClients.forEach(({ ws, clubId }) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const update = {
        type: 'GPS_UPDATE',
        clubId,
        timestamp: new Date().toISOString(),
        players: generateSimulatedGpsUpdate(),
      };

      ws.send(JSON.stringify(update));
    });
  }, 1000);
}

function generateSimulatedGpsUpdate() {
  // In production this comes from real GPS devices via MQTT/API
  return Array.from({ length: 11 }, (_, i) => ({
    playerId: `player-${i + 1}`,
    number: i + 1,
    speed:      Math.max(0, Math.min(35, 15 + (Math.random() - 0.5) * 10)),
    heartRate:  Math.floor(130 + Math.random() * 60),
    distance:   parseFloat((8 + Math.random() * 5).toFixed(2)),
    riskScore:  parseFloat((Math.random() * 100).toFixed(1)),
    x: parseFloat((100 + Math.random() * 400).toFixed(1)),
    y: parseFloat((50  + Math.random() * 280).toFixed(1)),
  }));
}

// ── Boot ──────────────────────────────────────────────────

async function bootstrap() {
  await connectDatabase();

  const app    = createApp();
  const server = http.createServer(app);

  // WebSocket server for live GPS
  const wss = new WebSocketServer({ server, path: '/ws/live' });

  wss.on('connection', (ws, req) => {
    // Expect: /ws/live?clubId=xxx&token=yyy
    const url     = new URL(req.url ?? '', `http://localhost`);
    const clubId  = url.searchParams.get('clubId') ?? 'unknown';
    const clientId = `${clubId}-${Date.now()}`;

    liveClients.set(clientId, { ws, clubId });
    logger.info('WebSocket client connected', { clubId, total: liveClients.size });

    ws.on('close', () => {
      liveClients.delete(clientId);
      logger.info('WebSocket client disconnected', { clubId, total: liveClients.size });
    });

    ws.on('error', (err) => {
      logger.warn('WebSocket error', { clubId, err: err.message });
      liveClients.delete(clientId);
    });
  });

  startGpsSimulator(wss);

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
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
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
