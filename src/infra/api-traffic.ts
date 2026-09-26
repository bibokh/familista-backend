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

import type { RequestHandler } from 'express';

/** How far back the window reaches. The rule states it, so it is exported. */
export const API_WINDOW_MINUTES = 5;

interface Bucket { minute: number; responses: number; serverErrors: number }

const buckets: Bucket[] = [];
let responsesSinceStart = 0;
let serverErrorsSinceStart = 0;
let lastResponseAt: string | null = null;

const minuteOf = (ms: number): number => Math.floor(ms / 60_000);

function prune(nowMinute: number): void {
  while (buckets.length && buckets[0].minute <= nowMinute - API_WINDOW_MINUTES) buckets.shift();
}

/** Count one completed API response. */
export function recordApiResponse(status: number, now: number = Date.now()): void {
  const minute = minuteOf(now);
  prune(minute);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.minute !== minute) {
    bucket = { minute, responses: 0, serverErrors: 0 };
    buckets.push(bucket);
  }
  const serverError = status >= 500;
  bucket.responses += 1;
  responsesSinceStart += 1;
  if (serverError) { bucket.serverErrors += 1; serverErrorsSinceStart += 1; }
  lastResponseAt = new Date(now).toISOString();
}

export interface ApiTraffic {
  windowMinutes: number;
  responses: number;
  serverErrors: number;
  responsesSinceStart: number;
  serverErrorsSinceStart: number;
  lastResponseAt: string | null;
}

/** What the router completed inside the window, and since the process started. */
export function apiTraffic(now: number = Date.now()): ApiTraffic {
  prune(minuteOf(now));
  let responses = 0;
  let serverErrors = 0;
  for (const b of buckets) { responses += b.responses; serverErrors += b.serverErrors; }
  return {
    windowMinutes: API_WINDOW_MINUTES,
    responses, serverErrors,
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
    try { recordApiResponse(res.statusCode); } catch (_) { /* counting never breaks a response */ }
  });
  next();
};

/** Clear the counters. Tests only. */
export function resetApiTraffic(): void {
  buckets.length = 0;
  responsesSinceStart = 0;
  serverErrorsSinceStart = 0;
  lastResponseAt = null;
}
