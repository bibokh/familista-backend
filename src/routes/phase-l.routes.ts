// Familista — Phase L bundled routes. Mounted at /api/v1/phase-l.

import { Router } from 'express';
import * as ctrl from '../controllers/phase-l.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';
import { tenantParam } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);

// Team scope. Federated cognition runs over one team's own matches and players.
// The same access service the Squad, Training, the Match Center and the
// Familista League use: a team, player or match id from another team or
// another club is refused with 403 before the handler runs.
guardTeamScopedRouter(router);

// Hardware
router.post('/hardware/sessions',                       authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.createHwSession);
router.get('/hardware/sessions',                        ctrl.listHwSessions);
router.post('/hardware/sessions/:id/steps',             tenantParam('hardwareProvisioningSession'), authorize('CLUB_ADMIN','SUPER_ADMIN'), ctrl.recordHwStep);
router.post('/hardware/capabilities',                   authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishCapability);
router.post('/hardware/trust-anchors',                  authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishTrustAnchor);

// Attestation
router.post('/security/attestation',                    ctrl.recordAttestation);

// Federated
router.post('/federated/privacy-boundary',              authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishBoundary);
router.post('/federated/jobs',                          authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.createFedJob);
router.get('/federated/jobs',                           ctrl.listFedJobs);
router.post('/federated/jobs/:jobId/gradient',          authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.submitGradient);
router.post('/federated/jobs/:jobId/aggregate',         authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.aggregateRound);
router.post('/federated/trust',                         ctrl.publishFedTrust);  // platform owner only (checked in the service)

// Coaching agents
router.post('/coaching/agents',                         authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.registerCoach);
router.get('/coaching/agents',                          ctrl.listCoaches);
router.post('/coaching/recommendations',                authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), ctrl.issueRecommendation);
router.get('/coaching/recommendations',                 ctrl.listRecommendations);

// Twin simulation
router.post('/simulation/sessions',                     authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.createSim);
router.get('/simulation/sessions',                      ctrl.listSims);
router.post('/simulation/sessions/:sessionId/branches', tenantParam('twinSimulationSession', 'sessionId'), authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.createBranch);
router.post('/simulation/sessions/:sessionId/state',    tenantParam('twinSimulationSession', 'sessionId'), authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordSimState);

// Cognitive game graph
router.post('/cognitive/graph',                          authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordGameGraph);
router.get('/cognitive/matches/:matchId/graph',          ctrl.listGameGraphs);

// Biochem
router.post('/biochem/signals',                          authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.recordBiochemSignal);

// Sport catalog
router.post('/catalog/plugins',                          authorize('SUPER_ADMIN','CLUB_ADMIN'), ctrl.publishPlugin);
router.get('/catalog/plugins',                           ctrl.listPlugins);

// Quantum (research-only) + snapshot
router.get('/quantum/posture',                           ctrl.quantumPosture);
router.get('/snapshot',                                  authorize('SUPER_ADMIN','CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.phaseLSnapshot);

export default router;
