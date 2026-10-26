// Body shape guard — bounds every parsed request body before any validator walks it
// ─────────────────────────────────────────────────────────────────────────────
// Zod 3 (GHSA-mrhx-c7xc-m3w5, CVE-2023-54404; fixed only in zod 4.6.6) validates
// every element of an array or record and keeps an issue for each one that
// fails, with no cap and no early stop, even when the schema declares .max():
// the length is checked, and then every element is parsed anyway. The JSON
// parser accepts 2 MB, which is a million-element array, and validating one
// such body allocated about 290 MB (measured, zod 3.25.76).
//
// This guard runs right after the body parsers and before every route, so no
// schema ever sees a body larger than the platform accepts. It walks the parsed
// body iteratively (a deep body cannot overflow the stack) and refuses it, 413,
// at the first limit crossed. Under these limits the worst a schema can
// allocate is bounded by maxValues issues, the same order as parsing the body.
//
// The limits are several times the largest legitimate body the platform
// receives (provisioning: 1,000 serials; a device batch: 500 packets of about
// fifteen values each, docs/fusion-protocol.md), never tuned to one route.
//
// Not covered here, and why: query strings are already bounded by qs (1,000
// parameters) inside Node's 16 KB header limit; form bodies are refused by the
// urlencoded parser past 1,000 parameters; signed raw-body paths (webhooks,
// worker callbacks) arrive as a Buffer and are verified before they are parsed.

import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export const BODY_SHAPE_LIMITS = Object.freeze({
  /** Nesting, counted from the body itself as 1. */
  maxDepth: 32,
  /** Items in any one array. */
  maxArrayLength: 5_000,
  /** Keys in any one object. */
  maxObjectKeys: 1_000,
  /** Every value in the body, containers and leaves alike. */
  maxValues: 50_000,
});

export type BodyShapeLimits = typeof BODY_SHAPE_LIMITS;
export type BodyShapeBreach = 'depth' | 'array' | 'keys' | 'values';

const MESSAGE: Record<BodyShapeBreach, string> = {
  depth: 'The request body is nested too deeply.',
  array: 'The request body holds a list longer than any request accepts.',
  keys: 'The request body holds an object with more fields than any request accepts.',
  values: 'The request body holds more values than any request accepts.',
};

/** The first limit a parsed body crosses, or null. Never recursive, never reads a value twice. */
export function bodyShapeBreach(body: unknown, limits: BodyShapeLimits = BODY_SHAPE_LIMITS): BodyShapeBreach | null {
  if (body === null || typeof body !== 'object') return null;
  const stack: Array<{ v: object; depth: number }> = [{ v: body as object, depth: 1 }];
  let values = 1;
  const visit = (c: unknown, depth: number) => { if (c !== null && typeof c === 'object') stack.push({ v: c, depth }); };
  while (stack.length > 0) {
    const { v, depth } = stack.pop() as { v: object; depth: number };
    if (depth > limits.maxDepth) return 'depth';
    if (Array.isArray(v)) {
      if (v.length > limits.maxArrayLength) return 'array';
      values += v.length;
      if (values > limits.maxValues) return 'values';
      for (let i = 0; i < v.length; i++) visit(v[i], depth + 1);
      continue;
    }
    // Counted as they are read and refused at the first key past the limit. V8 still enumerates an object's keys
    // once: for the largest object a 2 MB body can hold, 56 ms against the 137 ms JSON.parse took to build it.
    let keys = 0;
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (++keys > limits.maxObjectKeys) return 'keys';
      if (++values > limits.maxValues) return 'values';
      visit((v as Record<string, unknown>)[k], depth + 1);
    }
  }
  return null;
}

/** Refuses, 413, a parsed body that crosses a limit; leaves a raw (Buffer) body to its own verifier. */
export function bodyShapeGuard(limits: BodyShapeLimits = BODY_SHAPE_LIMITS): RequestHandler {
  return (req, _res, next) => {
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || ArrayBuffer.isView(body)) return next();
    const breach = bodyShapeBreach(body, limits);
    if (!breach) return next();
    logger.warn('[body-shape-guard] request body refused before validation', { path: req.path, method: req.method, breach });
    return next(new AppError(MESSAGE[breach], 413));
  };
}
