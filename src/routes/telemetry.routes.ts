// Product analytics ingestion
// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/v1/telemetry, and separate from /analytics — which is a
// club's own football analytics and has nothing to do with product usage.
//
// Writes only. Nothing here reads analytics back: every read is a cross-club
// question and lives on the SYSTEM router, where the platform-owner guard is.

import { Router } from 'express';
import * as ctrl from '../controllers/telemetry.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);
router.post('/events', ctrl.ingest);

export default router;
