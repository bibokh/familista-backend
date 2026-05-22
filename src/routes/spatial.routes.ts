// Familista — Spatial routes (Phase G)
// Mounted at /api/v1/spatial.

import { Router } from 'express';
import * as ctrl from '../controllers/spatial.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

// Real-time cognitive spatial frame for a match.
router.get('/matches/:id/frame',         ctrl.getSpatialFrame);

// Digital-twin replay at an arbitrary timestamp.
router.get('/matches/:id/twin',          ctrl.getTwinAt);

// Persisted anchor frames for client-side scrubbing.
router.get('/matches/:id/twin/anchors',  ctrl.getTwinAnchors);

export default router;
