// The API router's own outcome counts — the signal behind the API Router building
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// The infrastructure manifest has always said the API Router reports through a
// health signal called `api`, and nothing ever produced one: the building was
// drawn grey in the city and UNKNOWN in the topology for want of a measurement.
// This is that measurement, and it is the smallest one that answers the
// operator's question — "is the API answering, and is it answering with
// errors?" — from responses the router actually completed.
//
// WHAT IT KEEPS
//
// Per-minute buckets of completed responses and of 5xx responses, for the last
// few minutes, plus two since-start totals. Bounded memory (one small object per
// minute in the window), no route, no user, no path, no status code other than
// "was it a server error". Process-scoped, like every other counter the health
// layer reads, and reset by a restart.
//
// WHAT IT DOES NOT DO
//
// It does not derive a per-second figure, and it does not sample: every
// completed response through the API mount is counted, once, when it finishes.

import type { RequestHandler, Response } from 'express';
import { onError } from '../middleware/request-id.middleware';

/** How far back the window reaches. The rule states it, so it is exported. */
export const API_WINDOW_MINUTES = 5;

interface Bucket { minute: number; responses: number; serverErrors: number; unhandledErrors: number; unhardened: number }

const buckets: Bucket[] = [];
let responsesSinceStart = 0;
let serverErrorsSinceStart = 0;
let unhandledSinceStart = 0;
let unhardenedSinceStart = 0;
let lastResponseAt: string | null = null;

const minuteOf = (ms: number): number => Math.floor(ms / 60_000);

function prune(nowMinute: number): void {
  while (buckets.length && buckets[0].minute <= nowMinute - API_WINDOW_MINUTES) buckets.shift();
}

function bucketAt(now: number): Bucket {
  const minute = minuteOf(now);
  prune(minute);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.minute !== minute) {
    bucket = { minute, responses: 0, serverErrors: 0, unhandledErrors: 0, unhardened: 0 };
    buckets.push(bucket);
  }
  return bucket;
}

/**
 * Count one completed API response.
 *
 * `hardened` is whether the response left carrying the header set HTTP
 * hardening puts on every response (`X-Content-Type-Options: nosniff`, set by
 * helmet ahead of this mount). A response without it is a response the
 * hardening layer did not reach.
 */
export function recordApiResponse(status: number, now: number = Date.now(), hardened = true): void {
  const bucket = bucketAt(now);
  const serverError = status >= 500;
  if (!hardened) { bucket.unhardened += 1; unhardenedSinceStart += 1; }
  bucket.responses += 1;
  responsesSinceStart += 1;
  if (serverError) { bucket.serverErrors += 1; serverErrorsSinceStart += 1; }
  lastResponseAt = new Date(now).toISOString();
}

/**
 * An exception a route or service threw that reached the error reporter with a
 * server-side status. This is the application-services layer failing, as
 * opposed to a handler deliberately answering 503.
 */
export function recordUnhandledError(status: number, now: number = Date.now()): void {
  if (status < 500) return;
  bucketAt(now).unhandledErrors += 1;
  unhandledSinceStart += 1;
}

// Every error frame the platform's error reporter produces reaches this, so the
// service layer's failures are counted where they are already reported.
onError((frame) => { try { recordUnhandledError(frame.status); } catch (_) { /* never */ } });

export interface ApiTraffic {
  windowMinutes: number;
  responses: number;
  serverErrors: number;
  unhandledErrors: number;
  unhardened: number;
  unhandledSinceStart: number;
  unhardenedSinceStart: number;
  responsesSinceStart: number;
  serverErrorsSinceStart: number;
  lastResponseAt: string | null;
}

/** What the router completed inside the window, and since the process started. */
export function apiTraffic(now: number = Date.now()): ApiTraffic {
  prune(minuteOf(now));
  let responses = 0;
  let serverErrors = 0;
  let unhandledErrors = 0;
  let unhardened = 0;
  for (const b of buckets) {
    responses += b.responses; serverErrors += b.serverErrors;
    unhandledErrors += b.unhandledErrors; unhardened += b.unhardened;
  }
  return {
    windowMinutes: API_WINDOW_MINUTES,
    responses, serverErrors, unhandledErrors, unhardened,
    unhandledSinceStart, unhardenedSinceStart,
    responsesSinceStart, serverErrorsSinceStart,
    lastResponseAt,
  };
}

/**
 * Mounted on the API prefix, ahead of the router. Counts on `finish`, which is
 * the response actually leaving; a client that hangs up first is not a server
 * error and is not counted as one. Never stands between a request and its
 * handler.
 */
export const apiTrafficMeter: RequestHandler = (_req, res, next) => {
  res.on('finish', () => {
    try { recordApiResponse(res.statusCode, Date.now(), isHardened(res)); } catch (_) { /* counting never breaks a response */ }
  });
  next();
};

function isHardened(res: Response): boolean {
  return String(res.getHeader('x-content-type-options') ?? '').toLowerCase() === 'nosniff';
}

/** Clear the counters. Tests only. */
export function resetApiTraffic(): void {
  buckets.length = 0;
  responsesSinceStart = 0;
  serverErrorsSinceStart = 0;
  unhandledSinceStart = 0;
  unhardenedSinceStart = 0;
  lastResponseAt = null;
}
