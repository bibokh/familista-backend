// Cyber Defense, R1a — the transcode callback, for a worker only
// ─────────────────────────────────────────────────────────────────────────────
//   POST /internal/video/transcode-callback
//
// Outside the API, like the scheduled backup trigger: no session, no tenant.
// A user's token opens nothing here. The request is authenticated by an HMAC
// over the method, path, timestamp and the exact body (worker-callback.ts),
// and the endpoint answers 503 until VIDEO_WORKER_CALLBACK_SECRET is set. The
// service then refuses any storage key outside the asset's own folder, so even
// a valid worker cannot point one club's video at another club's files.

import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';
import { MAX_CALLBACK_BYTES, verifyWorkerCallback, workerCallbackSecret } from '../security/worker-callback';
import { handleTranscodeCallback, type TranscodeCallbackDto } from '../video/video-asset.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscodeCallbackDeps {
  secret: () => Buffer | null;
  nowSeconds: () => number;
  handle: (dto: TranscodeCallbackDto) => Promise<{ id: string; status: string }>;
}

/** HMAC over method, path, timestamp and raw body; fails closed when no secret is configured. */
export function requireWorkerCallback(deps: Pick<TranscodeCallbackDeps, 'secret' | 'nowSeconds'>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const secret = deps.secret();
    if (!secret) {
      res.status(503).json({ error: 'worker callback is not configured' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || Object.keys(req.query ?? {}).length > 0) {
      res.status(400).json({ error: 'expected a JSON body and no query' });
      return;
    }
    const verdict = verifyWorkerCallback(secret, {
      method: req.method,
      path: req.path,
      timestamp: req.get('x-worker-timestamp') ?? undefined,
      signature: req.get('x-worker-signature') ?? undefined,
      body: req.body,
    }, deps.nowSeconds());
    if (verdict !== 'ok') {
      logger.warn('[worker-callback] request refused', { reason: verdict, path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const str = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= max);

/** The body, as the fields the service accepts and nothing else. */
export function parseCallback(body: Buffer): TranscodeCallbackDto | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const allowed = new Set(['assetId', 'hlsManifestKey', 'thumbStorageKey', 'durationSec', 'widthPx', 'heightPx', 'errorMessage']);
  if (Object.keys(o).some((k) => !allowed.has(k))) return null;
  if (typeof o.assetId !== 'string' || !UUID.test(o.assetId)) return null;
  if (!str(o.hlsManifestKey, 512) || !str(o.thumbStorageKey, 512) || !str(o.errorMessage, 2000)) return null;
  if (!num(o.durationSec) || !num(o.widthPx) || !num(o.heightPx)) return null;
  return o as unknown as TranscodeCallbackDto;
}

export function transcodeCallbackHandler(deps: Pick<TranscodeCallbackDeps, 'handle'>): RequestHandler {
  return async (req: Request, res: Response) => {
    const dto = parseCallback(req.body as Buffer);
    if (!dto) {
      res.status(400).json({ error: 'invalid transcode callback' });
      return;
    }
    try {
      const asset = await deps.handle(dto);
      res.json({ id: asset.id, status: asset.status });
    } catch (err) {
      if (err instanceof AppError) {
        logger.warn('[worker-callback] transcode callback refused', { status: err.statusCode });
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error('[worker-callback] transcode callback failed', { err: (err as Error)?.message });
      res.status(500).json({ error: 'internal error' });
    }
  };
}

export function defaultTranscodeCallbackDeps(): TranscodeCallbackDeps {
  return {
    secret: () => workerCallbackSecret(process.env),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    handle: handleTranscodeCallback,
  };
}

/**
 * The chain app.ts mounts, before the global JSON parser so the signature is
 * checked over the exact bytes received. Rate limit first, then the HMAC.
 */
export function transcodeCallbackRoute(deps: TranscodeCallbackDeps = defaultTranscodeCallbackDeps()): RequestHandler[] {
  return [
    rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }),
    express.raw({ type: () => true, limit: MAX_CALLBACK_BYTES }),
    requireWorkerCallback(deps),
    transcodeCallbackHandler(deps),
  ];
}
