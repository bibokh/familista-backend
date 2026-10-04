// Familista — the Algorithms room API
// ─────────────────────────────────────────────────────────────────────────────
// Two reads, both the platform owner's, behind the SAME guard as SYSTEM,
// CYBERSECURITY, the Data Vault, Infrastructure City and Source Core. No club
// role reaches it however senior it is inside its club.
//
// There is no write, on purpose. Algorithms are READ/ANALYZE-ONLY in Step 1: a
// change to an algorithm is a change to reviewed code, approved by the
// platform owner in the pull request that carries it (src/algorithms/
// registry.ts records the approval) and released by the CI-gated deploy —
// never by a request to this API.
//
//   GET /system/algorithms         the room: the loop, the domains, every
//                                  algorithm's stage, gate and evaluation
//   GET /system/algorithms/:key    one algorithm in full: inputs, outputs,
//                                  source, fingerprint, approval, scenarios
//
// WHAT THESE RETURN
//
// Registry metadata, source fingerprints and the results of synthetic
// scenarios run in this process. Never a player, club, match or sensor record,
// an environment value, a user or a row id.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { algorithmsOverview, algorithmDetail } from '../algorithms/algorithms.service';
import { AppError, NotFoundError } from '../utils/errors';

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

/** The room: everything the overview, the loop and the registry draw. */
router.get('/', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: algorithmsOverview() });
  } catch (err) { next(err); }
});

/** One algorithm in full. The key is a registry key, never a row id. */
router.get('/:key', (req: Request, res: Response, next) => {
  try {
    const found = algorithmDetail(String(req.params.key));
    if (found.state === 'UNKNOWN_ALGORITHM') throw new NotFoundError('Algorithm');
    // The fingerprints are missing beside the server: an algorithm cannot be
    // described without them, and "not found" would be the wrong answer.
    if (found.state === 'NOT_GENERATED') throw new AppError('Algorithm evidence is not available on this server', 503);
    res.json({ success: true, data: found.detail });
  } catch (err) { next(err); }
});

export default router;
