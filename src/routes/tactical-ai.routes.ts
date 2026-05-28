// src/routes/tactical-ai.routes.ts
// Phase 13 — Tactical AI Engine routes
// Mounted at /api/v1/tactical-ai

import { Router }       from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as ctrl        from '../controllers/tactical-ai.controller';

const router = Router();
router.use(authenticate);

// GET /api/v1/tactical-ai/matches/:matchId
// Full tactical analysis for a single match (formation, 5-dimension scores, recommendations).
router.get('/matches/:matchId', ctrl.getMatchAnalysis);

// GET /api/v1/tactical-ai/teams/:teamId?matches=5
// Aggregated tactical summary across last N matches (avg scores, formation trend, workload risk).
router.get('/teams/:teamId', ctrl.getTeamAnalysis);

export default router;
