// Familista — the Cybersecurity Command Center API
// ─────────────────────────────────────────────────────────────────────────────
// Two reads, both the platform owner's, behind the SAME guard as SYSTEM, the
// Data Vault, Infrastructure City and Source Core. No club role reaches any of
// it however senior it is inside its club, and there is no write: the Command
// Center shows the security architecture, it does not change it. RLS mode,
// enforcement, MFA requirements and alerting are changed where they always
// were — in reviewed code and the hosting provider's settings — never here.
//
//   GET /system/cybersecurity                   the whole Command Center:
//                                               posture, domains, areas,
//                                               lifecycle, coverage, RLS, events
//   GET /system/cybersecurity/domains/:domain   one domain in full: every
//                                               control and its evidence, every
//                                               trust boundary, latest events
//
// WHAT THESE RETURN
//
// Evidence METADATA (control statuses, the files that prove them, coverage
// rows) and aggregated TELEMETRY (counts and instants). What never travels: an
// environment value, a connection string, a key or token, an IP address, a
// user, club or row id, a query, or anything a user typed.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { commandCenterOverview, commandCenterDomain } from '../cyber-defense/control-plane/control-plane.service';
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

/** The Command Center: everything the overview, the map and the cards draw. */
router.get('/', async (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: await commandCenterOverview() });
  } catch (err) { next(err); }
});

/** One security domain in full. The name is a registry key, never a row id. */
router.get('/domains/:domain', async (req: Request, res: Response, next) => {
  try {
    const found = await commandCenterDomain(String(req.params.domain));
    if (found.state === 'UNKNOWN_DOMAIN') throw new NotFoundError('Security domain');
    // The evidence files are missing beside the server: a domain cannot be
    // described without them, and saying "not found" would be the wrong answer.
    if (found.state === 'NOT_GENERATED') throw new AppError('Security evidence is not available on this server', 503);
    res.json({ success: true, data: found.detail });
  } catch (err) { next(err); }
});

export default router;
