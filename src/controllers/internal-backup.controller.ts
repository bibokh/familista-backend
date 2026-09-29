// Cyber Defense, Step 10 — POST /internal/backups/run, GET /internal/backups/runs/:id
// ─────────────────────────────────────────────────────────────────────────────
// The scheduled backup's two doors, used by .github/workflows/backup.yml. They
// sit outside the API: no user session, no tenant, no body. Authentication is
// the HMAC in src/security/backup/backup-trigger.ts. Answers carry run state
// and nothing more — no bucket, object key, database, error text or stack.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { runnerConfigFromEnv } from '../security/backup/backup-config';
import { runBackup } from '../security/backup/backup-runner';
import { prismaRunStore, recordDbFor } from '../security/backup/backup-run-store';
import {
  startBackupRun, statusOf, triggerSecret, verifyTrigger, type BackupRunStore, type StartResult,
} from '../security/backup/backup-trigger';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface InternalBackupDeps {
  secret: () => Buffer | null;
  store: () => BackupRunStore;
  /** Starts the fixed runner. Throws only for configuration it cannot run with. */
  start: (store: BackupRunStore) => Promise<StartResult>;
  nowSeconds: () => number;
}

function hasBody(req: Request): boolean {
  const len = Number(req.headers['content-length'] ?? 0);
  return (Number.isFinite(len) && len > 0) || req.headers['transfer-encoding'] !== undefined;
}

/** HMAC over method, path and timestamp; fails closed when no secret is configured. */
export function requireBackupTrigger(deps: Pick<InternalBackupDeps, 'secret' | 'nowSeconds'>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const secret = deps.secret();
    if (!secret) {
      res.status(503).json({ error: 'backup trigger is not configured' });
      return;
    }
    if (hasBody(req) || Object.keys(req.query ?? {}).length > 0) {
      res.status(400).json({ error: 'this endpoint takes no parameters' });
      return;
    }
    const verdict = verifyTrigger(secret, {
      method: req.method,
      path: req.path,
      timestamp: req.get('x-backup-timestamp') ?? undefined,
      signature: req.get('x-backup-signature') ?? undefined,
    }, deps.nowSeconds());
    if (verdict !== 'ok') {
      logger.warn('[backup-trigger] request refused', { reason: verdict, path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export function runHandler(deps: InternalBackupDeps): RequestHandler {
  return async (_req, res) => {
    let result: StartResult;
    try {
      result = await deps.start(deps.store());
    } catch (err) {
      // Configuration errors name the setting, never its value; they stay in the log.
      logger.error('[backup-trigger] backup is not configured', { err: (err as Error).message });
      res.status(503).json({ error: 'backup is not configured' });
      return;
    }
    switch (result.kind) {
      case 'started': res.status(202).json({ id: result.id, state: 'running' }); return;
      case 'running': res.status(409).json({ id: result.id, state: 'running' }); return;
      case 'recent': res.status(429).json({ state: 'recent', lastSuccessAt: result.lastSuccessAt }); return;
      default: res.status(503).json({ error: 'backup could not start' });
    }
  };
}

export function statusHandler(deps: InternalBackupDeps): RequestHandler {
  return async (req, res) => {
    const id = String(req.params.id ?? '');
    const row = UUID.test(id) ? await deps.store().find(id).catch(() => null) : null;
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(200).json(statusOf(row, new Date(deps.nowSeconds() * 1000)));
  };
}

/** Production wiring: the service's own database, environment and runner. */
export function defaultInternalBackupDeps(): InternalBackupDeps {
  return {
    secret: () => triggerSecret(process.env),
    store: () => prismaRunStore(prisma),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    async start(store) {
      const cfg = runnerConfigFromEnv(process.env);
      return startBackupRun({
        store,
        run: (id) => runBackup(cfg, { db: recordDbFor(prisma, id) }),
        onBackgroundError: (err) => logger.error('[backup-trigger] backup failed', { err: (err as Error)?.message }),
      });
    },
  };
}

/**
 * The middleware chains app.ts mounts. Rate limits sit in front of the HMAC:
 * a handful of starts an hour, and enough polls for one run.
 */
export function internalBackupRoutes(deps: InternalBackupDeps = defaultInternalBackupDeps()): { run: RequestHandler[]; status: RequestHandler[] } {
  const auth = requireBackupTrigger(deps);
  const runLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });
  const statusLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 360, standardHeaders: true, legacyHeaders: false });
  return {
    run: [runLimiter, auth, runHandler(deps)],
    status: [statusLimiter, auth, statusHandler(deps)],
  };
}
