// Familista — Data Pulse, as an API
// ─────────────────────────────────────────────────────────────────────────────
// Four reads and a stream, all of them the platform owner's. The guard is
// `assertPlatformOwner`, the SAME function SYSTEM and the owner trace already
// use — there is no second authorization system here, and no club role reaches
// any of this however senior it is inside its club.
//
// The stream is Server-Sent Events over an ordinary authenticated request, read
// with `fetch` and a reader rather than `EventSource`, exactly as the owner
// trace does it: `EventSource` cannot set headers, so using it would force the
// token into a query string where every proxy between here and the browser
// writes it to a log. A panel that exists to make things visible must not be
// the thing that leaks.
//
// WHY SSE AND NOT A SOCKET
//
// The traffic is one-directional. The browser sends nothing after the request
// except a disconnect, so a duplex transport would buy a second protocol, a
// second reconnect story and a second auth path for no capability. SSE also
// reconnects on its own semantics and survives a proxy that only speaks HTTP.
// If this screen ever needs to send commands upstream, that is the moment to
// revisit it — not before.
//
// EVERYTHING HERE IS READ-ONLY
//
// There is no POST, no PUT, no DELETE and no route that emits an event. In
// particular there is no test-event endpoint: a button that manufactures fake
// activity is exactly what would make this screen untrustworthy, and if one is
// ever wanted it belongs behind a staging-only flag proposed on its own.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import {
  flushNow, onPulse, pulseMetrics, pulseTopology, recentFrames, startPulse,
  BUFFER_LIMIT, FLUSH_MS, SAMPLE_THRESHOLD,
  type PulseBatch,
} from '../fabric/pulse/pulse.service';
import { replayCounts, replayWindow, REPLAY_MAX, REPLAY_WINDOWS } from '../fabric/pulse/pulse-replay.service';

const router = Router();
router.use(authenticate);

/** Every route below, and the stream, pass through this and nothing else. */
router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    next();
  } catch (err) { next(err); }
});

/**
 * The map, and what is honestly connected to it.
 *
 * Served rather than hard-coded in the page so the interface cannot claim a
 * destination the server does not agree exists.
 */
router.get('/topology', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      ...pulseTopology(),
      limits: { bufferLimit: BUFFER_LIMIT, flushMs: FLUSH_MS, sampleThreshold: SAMPLE_THRESHOLD, replayMax: REPLAY_MAX },
      replayWindows: REPLAY_WINDOWS,
    },
  });
});

/** What is measurable now, plus the frames a client needs to catch up. */
router.get('/snapshot', (req: Request, res: Response) => {
  startPulse();
  const limit = Math.min(Number(req.query.limit) || 60, BUFFER_LIMIT);
  res.json({ success: true, data: { metrics: pulseMetrics(), frames: recentFrames(limit) } });
});

/**
 * REPLAY — the same frame shape, from the durable record.
 *
 * Reads the outbox once per request. There is no polling loop behind this: the
 * client asks when the owner picks a window, and not otherwise.
 */
router.get('/replay', async (req: Request, res: Response, next) => {
  try {
    const minutes = Number(req.query.minutes) || 5;
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const valid = (d: Date | null) => (d && !Number.isNaN(d.getTime()) ? d : null);

    const window = { minutes, from: valid(from), to: valid(to), limit: Number(req.query.limit) || REPLAY_MAX };
    const [result, counts] = await Promise.all([replayWindow(window), replayCounts(window)]);
    res.json({ success: true, data: { ...result, counts } });
  } catch (err) { next(err); }
});

const HEARTBEAT_MS = 25_000;

/**
 * The live stream. One `pulse` frame per batch, one `metrics` frame per tick.
 *
 * Batched by the pulse service rather than per event, so a burst of a thousand
 * events is one write to this socket instead of a thousand. Metrics ride the
 * same connection on a slower tick — a browser polling a metrics endpoint every
 * second would be exactly the aggressive database traffic the brief rules out,
 * and these numbers are already in memory.
 */
router.get('/stream', (req: Request, res: Response) => {
  startPulse();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let open = true;
  const send = (event: string, data: unknown): void => {
    if (!open) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { open = false; }
  };

  // `retry` tells the browser how long to wait before reconnecting, so the
  // reconnect policy lives with the server that knows its own load.
  try { res.write('retry: 3000\n\n'); } catch { open = false; }

  send('hello', {
    topology: pulseTopology(),
    metrics: pulseMetrics(),
    limits: { bufferLimit: BUFFER_LIMIT, flushMs: FLUSH_MS, sampleThreshold: SAMPLE_THRESHOLD },
  });
  // Catch the client up on what it missed, as one frame rather than a replay
  // storm of individual events.
  send('backlog', { frames: recentFrames(60) });

  const off = onPulse((batch: PulseBatch) => send('pulse', batch));

  const metricsTick = setInterval(() => send('metrics', pulseMetrics()), 1_000);
  const beat = setInterval(() => {
    if (!open) return;
    try { res.write(': keepalive\n\n'); } catch { open = false; }
  }, HEARTBEAT_MS);

  const stop = (): void => {
    open = false;
    clearInterval(metricsTick);
    clearInterval(beat);
    try { off(); } catch { /* already gone */ }
    try { res.end(); } catch { /* already gone */ }
  };

  req.on('close', stop);
  req.on('error', stop);
  res.on('close', stop);

  // Anything already buffered goes out now rather than on the next tick, so a
  // freshly opened panel is not blank for a quarter of a second.
  flushNow();
});

export default router;
