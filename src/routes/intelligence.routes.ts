// Familista — Intelligence Routes (Phase S.2)
// Target: src/routes/intelligence.routes.ts
// ─────────────────────────────────────────────────────────────────────────────
// Mount: /api/v1/phase-s/intelligence
//
// POST /jobs/match/:matchId/analysis        → triggerMatchAnalysis
// POST /jobs/teams/:teamId/tactical         → triggerTacticalAdvisor
// POST /jobs/recruitment                    → triggerRecruitmentAdvisor
// POST /jobs/teams/:teamId/training         → triggerTrainingPlanner
// POST /jobs/teams/:teamId/injury-risk      → triggerInjuryRiskScan
// GET  /jobs                                → listJobs  (?domain=&limit=)
// GET  /jobs/:jobId                         → getJob

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';
import * as C from '../controllers/intelligence.controller';

const router = Router();

router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. Every job here runs over one team's or one match's private data.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

// Trigger endpoints — return 202 immediately; frontend polls for completion
router.post('/jobs/match/:matchId/analysis',    C.triggerMatchAnalysis);
router.post('/jobs/teams/:teamId/tactical',     C.triggerTacticalAdvisor);
router.post('/jobs/recruitment',                C.triggerRecruitmentAdvisor);
router.post('/jobs/teams/:teamId/training',     C.triggerTrainingPlanner);
router.post('/jobs/teams/:teamId/injury-risk',  C.triggerInjuryRiskScan);

// Read endpoints
router.get('/jobs',           C.listJobs);
router.get('/jobs/:jobId',    C.getJob);

export default router;
