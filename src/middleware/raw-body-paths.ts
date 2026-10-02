// Paths whose body is verified as received (Cyber Defense, R13)
// ─────────────────────────────────────────────────────────────────────────────
// A signature covers bytes, not a parsed object. For these paths the body is
// read raw here, before the global JSON and form parsers (app.ts) — which then
// leave it alone, because body-parser skips a body that has already been read
// — so the route's verifier sees exactly what the sender signed:
//
//   /api/v<n>/billing/webhook               Stripe-Signature (constructEvent)
//   /api/v<n>/vision/webhooks/…             the worker callback HMAC
//                                           (vision-access.middleware.ts)
//
// Nothing else may be added without a verifier on the route: a path listed
// here has no parsed body, so a handler that expects one fails closed.

import express, { type RequestHandler } from 'express';

const RAW_BODY_PATHS: ReadonlyArray<{ path: RegExp; limit: string }> = [
  { path: /^\/api\/v\d+\/billing\/webhook\/?$/, limit: '1mb' },
  { path: /^\/api\/v\d+\/vision\/webhooks\//, limit: '10mb' },
];

export function isRawBodyPath(path: string): boolean {
  return RAW_BODY_PATHS.some((p) => p.path.test(path));
}

/** Mounted before the global parsers: a signed webhook's body stays the bytes received. */
export function rawBodyForSignedWebhooks(): RequestHandler {
  const readers = RAW_BODY_PATHS.map((p) => ({ path: p.path, read: express.raw({ type: () => true, limit: p.limit }) }));
  return (req, res, next) => {
    const hit = readers.find((r) => r.path.test(req.path));
    return hit ? hit.read(req, res, next) : next();
  };
}
