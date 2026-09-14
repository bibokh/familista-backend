// Familista — Data Pulse, as an API
// ─────────────────────────────────────────────────────────────────────────────
// Five reads and a stream, all of them the platform owner's. The guard is
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
  flushNow, ingestFrames, onPulse, pulseMetrics, pulseTopology, recentFrames, startPulse,
  BUFFER_LIMIT, FLUSH_MS, SAMPLE_THRESHOLD,
  type PulseBatch,
} from '../fabric/pulse/pulse.service';
import { replayCounts, replayWindow, REPLAY_MAX, REPLAY_WINDOWS } from '../fabric/pulse/pulse-replay.service';
import {
  formatCursor, latestCursor, parseCursor, tailStep,
  TAIL_BATCH, TAIL_INTERVAL_MS, type OutboxCursor,
} from '../fabric/pulse/outbox-tail.service';
import {
  activeCounts, formatTelemetryCursor, latestTelemetryCursor, parseTelemetryCursor,
  telemetryStep, TELEMETRY_BATCH, type TelemetryCursor,
} from '../fabric/pulse/telemetry-tail.service';
import { ecosystemFootprint } from '../fabric/pulse/ecosystem.service';

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

/**
 * THE FOOTPRINT — where Familista actually is, as opposed to how fast it is.
 *
 * Counts of clubs, people and the countries clubs record, plus the country
 * centroids the board plots them at. Cached for a minute inside the service,
 * because an owner watching a live board must not be a load on the database
 * and a club is not created twice a second.
 */
router.get('/ecosystem', async (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: await ecosystemFootprint() });
  } catch (err) { next(err); }
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
router.get('/stream', async (req: Request, res: Response) => {
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

  /**
   * Where this connection starts reading.
   *
   * A `cursor` from the client means "resume": the browser reconnected and is
   * telling us the last pair it actually rendered, so nothing between is lost
   * and nothing already drawn is repeated. Without one, the cursor is seeded at
   * the NEWEST existing row — Live means "after I started watching", and a
   * screen that animated ten minutes of history on open would be lying about
   * what is happening now. Those rows are Replay's job and remain there.
   */
  let cursor: OutboxCursor | null = parseCursor(String(req.query.cursor ?? ''));
  let uiCursor: TelemetryCursor | null = parseTelemetryCursor(String(req.query.uiCursor ?? ''));
  let seeded = false;
  try {
    if (!cursor) { cursor = await latestCursor(); seeded = true; }
  } catch {
    // The seed failed; the tail will simply find nothing until it succeeds.
    cursor = null;
  }
  try {
    // Seeded independently. Telemetry and domain events arrive at wildly
    // different rates, and one cursor for both would make a quiet afternoon of
    // domain activity hold back a busy afternoon of people using the product.
    if (!uiCursor) uiCursor = await latestTelemetryCursor();
  } catch { uiCursor = null; }

  send('hello', {
    topology: pulseTopology(),
    metrics: pulseMetrics(),
    cursor: formatCursor(cursor),
    uiCursor: formatTelemetryCursor(uiCursor),
    resumed: !seeded && cursor !== null,
    // The windows the replay endpoint will honour. Sent with the topology so
    // the board's time control offers what the server actually serves rather
    // than a list the client keeps its own copy of.
    replayWindows: REPLAY_WINDOWS,
    limits: {
      bufferLimit: BUFFER_LIMIT, flushMs: FLUSH_MS, sampleThreshold: SAMPLE_THRESHOLD,
      tailBatch: TAIL_BATCH, tailIntervalMs: TAIL_INTERVAL_MS, telemetryBatch: TELEMETRY_BATCH,
    },
  });
  // What this instance has already buffered, as one frame rather than a storm.
  send('backlog', { frames: recentFrames(60) });

  const off = onPulse((batch: PulseBatch) => send('pulse', batch));

  /**
   * One tail poll. Reads the outbox, feeds the buffer, advances the cursor.
   *
   * The cursor advances only as far as rows were actually read, and it travels
   * to the client on every batch so a reconnect can resume from what the
   * browser rendered rather than from what this instance last read.
   *
   * When a poll returns a full batch there is more waiting, so the next poll is
   * immediate rather than a second later — a backlog drains at the speed of the
   * database instead of two hundred rows per second.
   */
  let polling = false;

  /**
   * One poll of BOTH tails, merged.
   *
   * The two sources are read independently — each has its own cursor and its
   * own failure — and their frames are merged by time before being handed to
   * the buffer. Merging at display rather than at storage is what lets a
   * durable fact and a sampled signal share a board without sharing a table.
   *
   * A frame from either source that arrives out of order relative to the other
   * is still ordered correctly here, because the merge sorts on `occurredAt`
   * across both pages rather than concatenating them.
   */
  const poll = async (): Promise<void> => {
    if (!open || polling) return;
    polling = true;
    try {
      const [domain, telemetry] = await Promise.all([
        tailStep(cursor, TAIL_BATCH),
        telemetryStep(uiCursor, TELEMETRY_BATCH),
      ]);
      cursor = domain.cursor;
      uiCursor = telemetry.cursor;

      const merged = [...domain.frames, ...telemetry.frames]
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

      if (merged.length) {
        const fresh = ingestFrames(merged);
        if (fresh.length) {
          send('cursor', {
            cursor: formatCursor(cursor),
            uiCursor: formatTelemetryCursor(uiCursor),
          });
          flushNow();
        }
      }
      // Either tail having more waiting means drain now rather than in a
      // second: a backlog should clear at the speed of the database.
      if ((domain.more || telemetry.more) && open) { polling = false; void poll(); return; }
    } finally {
      polling = false;
    }
  };

  const tailTick = setInterval(() => { void poll(); }, TAIL_INTERVAL_MS);
  /**
   * Metrics on the open connection, and the active counts on a slower one.
   *
   * The in-memory numbers are free and go out every second. "Active users" and
   * "active sessions" are a database read, so they run every ten — often enough
   * to be live, rarely enough that watching the board is not itself a load.
   */
  const metricsTick = setInterval(() => send('metrics', pulseMetrics()), 1_000);
  const sendActive = async (): Promise<void> => {
    if (!open) return;
    try { send('active', await activeCounts()); } catch { /* a missing count is not fatal */ }
  };
  void sendActive();
  const activeTick = setInterval(() => { void sendActive(); }, 10_000);
  const beat = setInterval(() => {
    if (!open) return;
    try { res.write(': keepalive\n\n'); } catch { open = false; }
  }, HEARTBEAT_MS);

  const stop = (): void => {
    open = false;
    clearInterval(tailTick);
    clearInterval(metricsTick);
    clearInterval(activeTick);
    clearInterval(beat);
    try { off(); } catch { /* already gone */ }
    try { res.end(); } catch { /* already gone */ }
  };

  req.on('close', stop);
  req.on('error', stop);
  res.on('close', stop);

  // Anything already buffered goes out now rather than on the next tick.
  flushNow();
});

export default router;
