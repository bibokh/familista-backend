// Familista — Phase M routes. Mounted at /api/v1/phase-m.

import { Router } from 'express';
import * as ctrl from '../controllers/phase-m.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantGuard } from '../middleware/tenant-guard.middleware';

const router = Router();
router.use(authenticate);
router.use(tenantGuard);

// Twins
router.post('/twins/organization',           authorize('CLUB_ADMIN','SUPER_ADMIN'),                                   ctrl.captureOrgTwin);
router.post('/twins/club',                    authorize('CLUB_ADMIN','SUPER_ADMIN'),                                   ctrl.captureClubTwin);
router.post('/twins/academy',                 authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),                       ctrl.captureAcademyTwin);
router.post('/twins/department',              authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),                       ctrl.captureDepartmentTwin);
router.post('/twins/staff',                   authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),                       ctrl.captureStaffTwin);
router.get('/twins',                          ctrl.listTwins);

// Executive agents + decisions
router.post('/executive/agents',              authorize('CLUB_ADMIN','SUPER_ADMIN'),                                   ctrl.registerExecutive);
router.get('/executive/agents',               ctrl.listExecutives);
router.post('/executive/decisions',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'),             ctrl.issueDecision);
router.get('/executive/decisions',            ctrl.listDecisions);

// Decision council
router.post('/councils',                                       authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),     ctrl.createCouncil);
router.post('/councils/:councilId/votes',                      authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF','SCOUT'), ctrl.submitVote);
router.post('/councils/:councilId/close',                      authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),     ctrl.closeCouncil);
router.get('/councils/:councilId',                             ctrl.getCouncil);

// Recruitment
router.post('/recruitment/targets',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.createTarget);
router.get('/recruitment/targets',            ctrl.listTargets);
router.post('/recruitment/reports',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.createScoutReport);
router.post('/recruitment/scores',            authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordRecruitmentScore);
router.post('/recruitment/transfer-probability', authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordTransferProbability);
router.post('/recruitment/projections',       authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordTalentProjection);

// Training engine
router.post('/training/optimization',         authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), ctrl.createOptPlan);
router.post('/training/recovery',             authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','MEDICAL_STAFF'),              ctrl.createRecovery);
router.post('/training/microcycle',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ASSISTANT_COACH'),            ctrl.createMicrocycle);
router.post('/training/season',               authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),                              ctrl.upsertSeasonPlan);
router.get('/training/plans',                 ctrl.listTrainingPlans);

// Economics
router.post('/economics/asset-value',         authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordAssetValue);
router.post('/economics/contract-risk',       authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'), ctrl.recordContractRisk);

// Scouting graph
router.post('/scouting/talent-graph',         authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','SCOUT'), ctrl.recordTalentGraph);
router.post('/scouting/scouts',               authorize('CLUB_ADMIN','SUPER_ADMIN'),                                ctrl.registerScout);
router.get('/scouting/scouts',                ctrl.listScouts);

// Marketplace
router.post('/marketplace/listings',          authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'), ctrl.createListing);
router.post('/marketplace/listings/:id/activate', authorize('CLUB_ADMIN','SUPER_ADMIN'),          ctrl.activateListing);
router.post('/marketplace/listings/:id/close',    authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'), ctrl.closeListing);
router.get('/marketplace/listings',           ctrl.listMarketplace);

// Knowledge engine
router.post('/knowledge/documents',           authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST','MEDICAL_STAFF'), ctrl.createKnowledgeDoc);
router.get('/knowledge/documents',            ctrl.listKnowledgeDocs);
router.post('/knowledge/tactical-patterns',   authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH'),                          ctrl.publishTacticalPattern);
router.post('/knowledge/medical',             authorize('CLUB_ADMIN','SUPER_ADMIN','MEDICAL_STAFF'),                       ctrl.publishMedicalNode);

// Snapshot
router.get('/snapshot',                       authorize('CLUB_ADMIN','SUPER_ADMIN','HEAD_COACH','ANALYST'), ctrl.phaseMSnapshot);

export default router;
