// Familista — Phase N routes. Mounted at /api/v1/phase-n.

import { Router } from 'express';
import * as ctrl from '../controllers/phase-n.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);
router.use(tenantGuard);

// Knowledge graph
router.post('/kg/nodes',            authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'), ctrl.createNode);
router.get('/kg/nodes',             ctrl.listNodes);
router.post('/kg/edges',            authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'), ctrl.createEdge);
router.get('/kg/edges',             ctrl.listEdges);
router.post('/kg/anchor',           authorize('CLUB_ADMIN','SUPER_ADMIN'),                       ctrl.anchorGraph);
router.get('/kg/anchors',           ctrl.listAnchors);
router.get('/kg/anchors/:anchorId/verify', ctrl.verifyAnchor);

// Reasoning layer
router.post('/reasoning/rules',     authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'), ctrl.publishRule);
router.get('/reasoning/rules',      ctrl.listRules);
router.post('/reasoning/run',       authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.runReason);
router.get('/reasoning/traces',     ctrl.listTraces);

// Universal athlete identity
router.post('/identity/athletes',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.registerAthlete);
router.post('/identity/links',              authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.linkPlayer);
router.post('/identity/performance',        authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.recordPerformance);
router.post('/identity/medical',            authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','MEDICAL_STAFF'),   ctrl.recordMedical);
router.post('/identity/transfers',          authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.recordTransfer);

// Global scouting
router.post('/scouting/nodes',              authorize('CLUB_ADMIN','SUPER_ADMIN'),                                ctrl.registerScoutingNode);
router.get('/scouting/nodes',               ctrl.listScoutingNodes);
router.post('/scouting/discoveries',        authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordDiscovery);
router.get('/scouting/discoveries',         ctrl.listDiscoveries);
router.post('/scouting/rankings',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordRanking);
router.get('/scouting/rankings',            ctrl.listRankings);
router.post('/scouting/evaluations',        authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordEvaluation);

// Market intelligence
router.post('/market/transfer-prediction',  authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.recordMarketTransfer);
router.post('/market/contract',             authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.recordContractIntel);
router.post('/market/academy-forecast',     authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.recordAcademyForecast);

// Trust score
router.post('/trust/update',                authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.updateTrust);
router.get('/trust',                        ctrl.listTrust);

// Snapshot
router.get('/snapshot',                     authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),         ctrl.phaseNSnapshot);

export default router;
