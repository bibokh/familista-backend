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
//   GET /system/design-system/graph    the Visual Explorer: its three views, with
//                                      sources and counts (no nodes)
//   GET /system/design-system/graph?view=<id>
//                                      one view: every node and edge, each with
//                                      its source and how it is known
//   GET /system/design-system/components   the Components Library index: the
//                                      taxonomy, the coverage and one summary per
//                                      registered component
//   GET /system/design-system/components?id=<id>
//                                      one component, with every inspector section
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
import {
  designSystemOverview, designSystemTokens, designSystemGraphIndex, designSystemGraphView, isGraphViewId,
  designSystemComponentsIndex, designSystemComponent, isComponentId,
} from '../design-system/design-system.service';
import { BadRequestError, NotFoundError } from '../utils/errors';

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

/**
 * The Visual Explorer. `view` is looked up in a fixed list, never interpolated
 * into a path or a query: a value that is not one of the three view ids is a
 * 404, and anything that is not a single string is a 400.
 */
router.get('/graph', (req: Request, res: Response, next) => {
  try {
    const keys = Object.keys(req.query);
    if (keys.some((k) => k !== 'view')) throw new BadRequestError('Only ?view=<id> is accepted');
    const view = req.query.view;
    if (view === undefined) { res.json({ success: true, data: designSystemGraphIndex() }); return; }
    if (typeof view !== 'string') throw new BadRequestError('view must be a single value');
    if (!isGraphViewId(view)) throw new NotFoundError('View');
    res.json({ success: true, data: designSystemGraphView(view) });
  } catch (err) { next(err); }
});

/**
 * The Components Library. `id` is looked up in the registry's own list, never
 * interpolated into a path or a query: an id that is not registered is a 404,
 * and anything that is not a single `id` string is a 400.
 */
router.get('/components', (req: Request, res: Response, next) => {
  try {
    const keys = Object.keys(req.query);
    if (keys.some((k) => k !== 'id')) throw new BadRequestError('Only ?id=<id> is accepted');
    const id = req.query.id;
    if (id === undefined) { res.json({ success: true, data: designSystemComponentsIndex() }); return; }
    if (typeof id !== 'string') throw new BadRequestError('id must be a single value');
    if (!isComponentId(id)) throw new NotFoundError('Component');
    res.json({ success: true, data: designSystemComponent(id) });
  } catch (err) { next(err); }
});

export default router;
