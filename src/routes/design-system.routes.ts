// Familista — the Design System Control room API
// ─────────────────────────────────────────────────────────────────────────────
// Reads only, all the platform owner's, behind the SAME guard as SYSTEM,
// CYBERSECURITY, the Data Vault, Infrastructure City, Source Core and
// Algorithms. No club role reaches it however senior it is inside its club.
//
// There is no write, on purpose. The design system changes by a reviewed change
// to tools/tokens/, approved in the pull request that carries it and released
// by the CI-gated deploy — never by a request to this API.
//
//   GET /system/design-system          the room: provenance, the measured and
//                                      recorded overview, the layers, and what
//                                      the platform does not keep
//   GET /system/design-system/tokens   every token (declared and resolved), the
//                                      layers, and the contrast of every pair
//
// WHAT THESE RETURN
//
// A manifest generated from the repository (tools/tokens/): token names and
// values, the layer structure, computed contrast ratios and counts, each with
// the file it came from. Never a user, club, player, request, environment
// value or row id.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { designSystemOverview, designSystemTokens } from '../design-system/design-system.service';

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

/** The room. */
router.get('/', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: designSystemOverview() });
  } catch (err) { next(err); }
});

/** The Design Tokens tab. */
router.get('/tokens', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: designSystemTokens() });
  } catch (err) { next(err); }
});

export default router;
