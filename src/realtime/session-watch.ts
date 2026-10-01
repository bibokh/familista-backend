// Cyber Defense, R1c — an open stream is held to the same session rule as a request
// ─────────────────────────────────────────────────────────────────────────────
// A WebSocket or an event stream is authenticated when it opens and then stays
// open for as long as the browser tab does. Ending a session server-side —
// revoking the membership it was acting under, deactivating the account — used
// to stop the next request but not the stream already open, which kept
// delivering live club data to a person the platform had just shut out.
//
// Every realtime connection registers here with the session it was opened
// under. It is re-checked against the same rule `authenticate` applies:
//
//   at once      when that person's identity is dropped (forgetIdentity, which
//                every process hears — revocation, deactivation, a club
//                switch), so an ended session loses its streams within moments;
//   on a timer   every REALTIME_SESSION_RECHECK_MS (default 60 s), as the
//                backstop for a change made where nothing announced it (a
//                direct database edit, a process that missed the broadcast).
//
// A connection whose session no longer holds is closed by its own close
// function: code 4401 on a WebSocket, the end of the response on a stream.

import type { Request, Response } from 'express';
import { onIdentityForgotten, sessionStillValid } from '../middleware/auth.middleware';
import { logger } from '../utils/logger';

export interface WatchedSession {
  userId: string;
  tokenVersion: number | null;
  /** Closes the connection. Called at most once. */
  close: (reason: 'session-ended') => void;
  /** For the log line only. */
  channel: string;
}

const RECHECK_MS = Math.max(5_000, parseInt(process.env.REALTIME_SESSION_RECHECK_MS ?? '60000', 10) || 60_000);

let nextId = 1;
const watched = new Map<number, WatchedSession>();
let timer: ReturnType<typeof setInterval> | null = null;
let checking: Promise<number> | null = null;

/** Registers an open connection. Returns the function that forgets it again (call it on close). */
export function watchSession(entry: WatchedSession): () => void {
  const id = nextId++;
  watched.set(id, entry);
  ensureTimer();
  return () => {
    watched.delete(id);
    if (watched.size === 0) stopTimer();
  };
}

/**
 * Ends an event stream for good: flushes what was written, then destroys the
 * connection, so every handler's own teardown ('close' on the request or the
 * response) runs, and the browser's automatic reconnect meets `authenticate`
 * — which refuses the ended session.
 */
export function endStream(res: Response): void {
  try {
    if (res.writableEnded) { res.destroy(); return; }
    res.end(() => { try { res.destroy(); } catch { /* already gone */ } });
  } catch { /* already gone */ }
}

/**
 * Registers the event stream a request authenticated by `authenticate` has
 * opened, closing the response when the session ends. Unregisters itself when
 * the response closes.
 */
export function watchRequestSession(req: Request, res: Response, channel: string): void {
  const user = (req as Request & { user?: { id?: string } }).user;
  if (!user?.id) return;
  const tokenVersion = (req as Request & { sessionTokenVersion?: number | null }).sessionTokenVersion ?? null;
  const unwatch = watchSession({
    userId: user.id, tokenVersion, channel,
    close: () => endStream(res),
  });
  res.on('close', unwatch);
}

/**
 * Re-checks the watched connections — all of them, or one person's — and
 * closes each whose session no longer holds. Resolves to how many it closed.
 */
export async function recheckSessions(userId?: string | null): Promise<number> {
  const targets = [...watched.entries()].filter(([, w]) => !userId || w.userId === userId);
  let closed = 0;
  // One identity read per person, however many connections they hold.
  const verdicts = new Map<string, Promise<boolean>>();
  for (const [id, w] of targets) {
    const key = `${w.userId}:${w.tokenVersion ?? 'none'}`;
    if (!verdicts.has(key)) {
      verdicts.set(key, sessionStillValid(w.userId, w.tokenVersion).catch(() => true));
    }
    // A failed lookup keeps the connection: a database blip must not drop
    // every live stream. The next check decides.
    if (await verdicts.get(key)) continue;
    if (!watched.has(id)) continue;
    watched.delete(id);
    closed += 1;
    logger.info('[realtime] session ended, closing connection', { channel: w.channel, userId: w.userId });
    try { w.close('session-ended'); } catch { /* already closed */ }
  }
  if (watched.size === 0) stopTimer();
  return closed;
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (checking) return;
    checking = recheckSessions().finally(() => { checking = null; });
  }, RECHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// A dropped identity is the signal that something about this person changed.
// Their streams are re-checked right away rather than on the next tick.
onIdentityForgotten((userId) => {
  if (watched.size === 0) return;
  void recheckSessions(userId).catch(() => undefined);
});

/** Tests and diagnostics: how many connections are being watched. */
export function watchedSessionCount(): number { return watched.size; }
