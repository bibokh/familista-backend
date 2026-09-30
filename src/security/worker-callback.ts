// Cyber Defense, R1a — callbacks from a worker, not from a user
// ─────────────────────────────────────────────────────────────────────────────
// A transcode result says which storage keys an asset now plays from. Whoever
// can send one can repoint a club's video, so it must come from the worker and
// from nothing else — never from a user session, whichever club it belongs to.
//
//   authentication   HMAC-SHA256(secret, METHOD \n PATH \n TIMESTAMP \n
//                    SHA256(raw body)), hex, compared in constant time; the
//                    timestamp must be within five minutes of the server's
//                    clock. The signature covers the exact bytes received, so
//                    a signed body cannot be edited. The secret never travels.
//   closed           without VIDEO_WORKER_CALLBACK_SECRET (32+ characters)
//                    nothing is accepted. The transcode worker runs in-process
//                    and calls the service directly; this door exists only for
//                    an external worker, and stays shut until one is set up.
//
// The same scheme as the scheduled backup trigger (backup-trigger.ts), with
// the body added to what is signed because this request carries one.

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { MIN_SECRET_LENGTH, TRIGGER_WINDOW_SECONDS } from './backup/backup-trigger';

export const TRANSCODE_CALLBACK_PATH = '/internal/video/transcode-callback';
/** Largest body accepted: a callback is a handful of short fields. */
export const MAX_CALLBACK_BYTES = 16 * 1024;

/** The callback secret, or null — which closes the endpoint — when unset or too short. */
export function workerCallbackSecret(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = (env.VIDEO_WORKER_CALLBACK_SECRET ?? '').trim();
  return raw.length >= MIN_SECRET_LENGTH ? Buffer.from(raw, 'utf8') : null;
}

/** The string that is signed: method, path, timestamp and the body's SHA-256, one per line. */
export function callbackSigningInput(method: string, path: string, timestamp: string, body: Buffer): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

export function signWorkerCallback(secret: Buffer | string, method: string, path: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', secret).update(callbackSigningInput(method, path, timestamp, body)).digest('hex');
}

export type CallbackVerdict = 'ok' | 'unauthenticated' | 'stale';

export function verifyWorkerCallback(
  secret: Buffer,
  req: { method: string; path: string; timestamp?: string; signature?: string; body: Buffer },
  nowSeconds: number,
): CallbackVerdict {
  const ts = req.timestamp ?? '';
  const sig = req.signature ?? '';
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return 'unauthenticated';
  const expected = Buffer.from(signWorkerCallback(secret, req.method, req.path, ts, req.body), 'hex');
  const given = Buffer.from(sig, 'hex');
  const match = given.length === expected.length && timingSafeEqual(given, expected);
  if (!match) return 'unauthenticated';
  if (Math.abs(nowSeconds - Number(ts)) > TRIGGER_WINDOW_SECONDS) return 'stale';
  return 'ok';
}
