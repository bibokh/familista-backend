/**
 * Familista Neural Digital Twin — the owner-only, read-only architecture graph.
 *
 * Mounted at /system/neural-twin. Every handler is behind authenticate and
 * assertPlatformOwner, enforced here on the server; the room's own owner check
 * is convenience. GETs only, never cached. The graph describes the platform's
 * structure and its partial boundaries, so it is effectively a map of the
 * system: it holds repository paths and counts, and no address, credential,
 * environment value or club data (the composer's exposure rules refuse them).
 *
 *   GET /system/neural-twin   the whole graph, with the build commit
 *
 * One endpoint: the room reads the whole graph once (about 150 KB compressed)
 * and every node's detail is in it, so a per-node read would be surface nothing
 * uses.
 */
import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { loadTwinGraph, TwinGraphUnavailable } from '../platform/neural-twin/store';
import { config } from '../config';

const router = Router();
router.use(authenticate);

router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
});

function unavailable(res: Response, err: unknown): boolean {
  if (!(err instanceof TwinGraphUnavailable)) return false;
  res.status(503).json({ success: false, error: { code: 'TWIN_GRAPH_UNAVAILABLE', message: err.message } });
  return true;
}

router.get('/', (_req: Request, res: Response, next) => {
  try {
    const g = loadTwinGraph();
    res.json({ success: true, data: { ...g, commit: config.buildCommit ?? null } });
  } catch (err) { if (!unavailable(res, err)) next(err); }
});

export default router;
