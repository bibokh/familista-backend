// src/routes/tactical-ai.routes.ts
// Phase 13 — Tactical AI Engine routes
// Mounted at /api/v1/tactical-ai

import { Router }       from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';
import * as ctrl        from '../controllers/tactical-ai.controller';

const router = Router();
router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. Tactical analysis of a team or a match is match preparation.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

// GET /api/v1/tactical-ai/matches/:matchId
// Full tactical analysis for a single match (formation, 5-dimension scores, recommendations).
router.get('/matches/:matchId', ctrl.getMatchAnalysis);

// GET /api/v1/tactical-ai/teams/:teamId?matches=5
// Aggregated tactical summary across last N matches (avg scores, formation trend, workload risk).
router.get('/teams/:teamId', ctrl.getTeamAnalysis);

export default router;
