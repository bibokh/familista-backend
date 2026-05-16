// Familista — Executive OS · Integration Layer
// File location: src/routes/executive.routes.ts
//
// Mount under /api/v1/executive. Every endpoint runs:
//   authenticate → attachExecutiveContext → requireExecutiveContext
// Per-endpoint role gates (CEO/CFO/Board/etc.) are enforced inside handlers
// via requireRoles / requireBoardRole / requireExecutiveLeadership.

import { Router } from 'express';

import * as ctrl from '../controllers/executive.controller';
import { authenticate } from '../middleware/auth.middleware';
import {
  attachExecutiveContext,
  requireExecutiveContext,
  requireBoardRole,
  requireExecutiveLeadership,
} from '../middleware/executive-access.middleware';

const router = Router();

router.use(authenticate, attachExecutiveContext, requireExecutiveContext);

// ── 1. Dashboard ───────────────────────────────────────────────────────────
router.get('/dashboard', ctrl.getDashboard);
router.get('/actions', ctrl.getKnownActions);

// ── 2. Executive RBAC ──────────────────────────────────────────────────────
router.get('/assignments', ctrl.listAssignments);
router.put('/assignments', ctrl.upsertAssignment);
router.delete('/assignments/:userId', ctrl.deactivateAssignment);

// ── 3. Workflows ───────────────────────────────────────────────────────────
router.get('/workflows', ctrl.listWorkflows);
router.post('/workflows', ctrl.createWorkflow);
router.get('/workflows/:id', ctrl.getWorkflow);
router.post('/workflows/:id/transition', ctrl.transitionWorkflow);
router.post('/workflows/:id/attest', ctrl.attestWorkflow);
router.post('/workflows/:id/run-next', ctrl.runNextStep);
router.patch('/steps/:stepId', ctrl.markStepComplete);

// ── 4. Board ───────────────────────────────────────────────────────────────
router.get('/resolutions', ctrl.listResolutions);
router.post('/resolutions', requireBoardRole, ctrl.createResolution);
router.get('/resolutions/:id', ctrl.getResolution);
router.post('/resolutions/:id/transition', requireBoardRole, ctrl.transitionResolution);
router.post('/resolutions/:id/vote', requireBoardRole, ctrl.castVote);
router.post('/resolutions/:id/tally', requireBoardRole, ctrl.tallyResolution);

// ── 5. Sponsor pipeline ────────────────────────────────────────────────────
router.get('/sponsors', ctrl.listSponsors);
router.post('/sponsors', ctrl.createSponsor);
router.get('/sponsors/:id', ctrl.getSponsor);
router.patch('/sponsors/:id', ctrl.updateSponsor);
router.post('/sponsors/:id/stage', ctrl.transitionSponsorStage);

// ── 6. Forecast ────────────────────────────────────────────────────────────
router.post('/forecasts', requireExecutiveLeadership, ctrl.generateForecast);
router.get('/forecasts', ctrl.listForecasts);

// ── 7. Risk ────────────────────────────────────────────────────────────────
router.get('/risks', ctrl.listAlerts);
router.post('/risks', ctrl.upsertAlert);
router.get('/risks/:id', ctrl.getAlert);
router.patch('/risks/:id', ctrl.updateAlert);
router.post('/risks/sweep', ctrl.runRiskSweep);

// ── 8. Audit ───────────────────────────────────────────────────────────────
router.get('/audit', ctrl.searchAudit);
router.get('/audit/summary', ctrl.summarizeAudit);

export default router;
