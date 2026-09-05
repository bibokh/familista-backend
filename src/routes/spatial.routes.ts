// Familista — Spatial routes (Phase G)
// Mounted at /api/v1/spatial.

import { Router } from 'express';
import * as ctrl from '../controllers/spatial.controller';
import { authenticate } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';

const router = Router();
router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. Spatial intelligence is computed from a team's own tracking data.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

// Real-time cognitive spatial frame for a match.
router.get('/matches/:id/frame',         ctrl.getSpatialFrame);

// Digital-twin replay at an arbitrary timestamp.
router.get('/matches/:id/twin',          ctrl.getTwinAt);

// Persisted anchor frames for client-side scrubbing.
router.get('/matches/:id/twin/anchors',  ctrl.getTwinAnchors);

export default router;
