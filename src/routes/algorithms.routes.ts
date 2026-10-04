// Familista — the Algorithms room API
// ─────────────────────────────────────────────────────────────────────────────
// Two reads, both the platform owner's, behind the SAME guard as SYSTEM,
// CYBERSECURITY, the Data Vault, Infrastructure City and Source Core. No club
// role reaches it however senior it is inside its club.
//
// There is no write, on purpose. Algorithms are READ/ANALYZE-ONLY: a change to
// an algorithm is a change to reviewed code, approved by the platform owner in
// the pull request that carries it (src/algorithms/registry.ts records the
// approval) and released by the CI-gated deploy — never by a request to this
// API. Production monitoring (Step 2) only reads: a finding is evidence for a
// person, and nothing here retrains, tunes, rolls back or switches off
// anything.
//
//   GET /system/algorithms                  the room: the loop, the domains,
//                                           every algorithm's stage, gate and
//                                           evaluation
//   GET /system/algorithms/monitoring       production monitoring: coverage,
//                                           states, runs, failures, latency,
//                                           the code running, the store
//   GET /system/algorithms/:key             one algorithm in full: inputs,
//                                           outputs, source, fingerprint,
//                                           approval, scenarios
//   GET /system/algorithms/:key/monitoring  one algorithm in production:
//                                           checks, findings, distribution,
//                                           latency, workflows, fingerprints
//
// WHAT THESE RETURN
//
// Registry metadata, fingerprints, the results of synthetic scenarios run in
// this process, and aggregate production telemetry — counts, histograms and
// timestamps. Never a player, club, match or sensor record, an environment
// value, a user, a request or a row id.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { algorithmsOverview, algorithmDetail } from '../algorithms/algorithms.service';
import { algorithmsMonitoring, algorithmMonitoring } from '../algorithms/monitoring';
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

/**
 * Production monitoring of every algorithm. Declared before `/:key`, so the
 * word is never read as an algorithm key.
 */
router.get('/monitoring', async (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: await algorithmsMonitoring() });
  } catch (err) { next(err); }
});

/** One algorithm in production. The key is a registry key, never a row id. */
router.get('/:key/monitoring', async (req: Request, res: Response, next) => {
  try {
    const found = await algorithmMonitoring(String(req.params.key));
    if (found.state === 'UNKNOWN_ALGORITHM') throw new NotFoundError('Algorithm');
    res.json({ success: true, data: found.detail });
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
