/**
 * Familista System Updates — what the platform is running, how a change reaches
 * production, what changed recently, and what waits for the platform owner.
 *
 * Mounted at /system/updates. Every handler is behind authenticate and
 * assertPlatformOwner, enforced here on the server; the room's own owner check
 * is convenience. GETs only, never cached. Read-only: nothing here merges,
 * deploys, approves or changes anything, and no credential for GitHub or Render
 * exists on this server to do so.
 *
 *   GET /system/updates   the whole view (src/platform/system-updates/model.ts)
 */
import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { systemUpdates } from '../platform/system-updates/service';

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

router.get('/', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: systemUpdates() });
  } catch (err) { next(err); }
});

export default router;
