// Familista — AI Decision Engine
// File location: src/routes/ai-engine.routes.ts
//
// Mount under /api/v1/ai. Each decision endpoint persists an auditable
// AIDecision row by default; pass { persist: false } in the body to run a
// transient (preview) decision without writing.

import { Router } from 'express';

import * as ctrl from '../controllers/ai-engine.controller';
import { authenticate } from '../middleware/auth.middleware';
import { attachAIContext, requireAIContext } from '../middleware/ai-access.middleware';

const router = Router();

router.use(authenticate, attachAIContext, requireAIContext);

// ── 1. Model registry ──────────────────────────────────────────────────────
router.get('/models', ctrl.listModels);
router.post('/models', ctrl.createModel);
router.get('/models/:id', ctrl.getModel);
router.patch('/models/:id', ctrl.updateModel);
router.post('/models/:id/activate', ctrl.activateModel);
router.post('/models/:id/deprecate', ctrl.deprecateModel);
router.get('/models/:modelId/feedback-stats', ctrl.modelFeedbackStats);

// ── 2. Player decisions ────────────────────────────────────────────────────
router.post('/decisions/player/:playerId/injury-risk', ctrl.predictInjuryRisk);
router.post('/decisions/player/:playerId/growth', ctrl.analyzePlayerGrowth);
router.post('/decisions/player/:playerId/talent', ctrl.detectTalent);
router.post('/decisions/player/:playerId/fatigue', ctrl.predictFatigue);
router.post('/decisions/player/:playerId/transfer', ctrl.recommendTransfer);
router.post('/decisions/player/:playerId/training', ctrl.optimizeTraining);
router.post('/decisions/lineup/:matchId', ctrl.recommendLineup);

// ── 3. Coach decisions ─────────────────────────────────────────────────────
router.post('/decisions/coach/match/:matchId/tactics', ctrl.recommendTactics);
router.post('/decisions/coach/match/:matchId/formation', ctrl.optimizeFormation);
router.post('/decisions/coach/match/:matchId/opponent', ctrl.analyzeOpponent);
router.post('/decisions/coach/match/:matchId/prep', ctrl.prepareMatch);
router.post('/decisions/coach/match/:matchId/substitution', ctrl.recommendSubstitution);
router.post('/decisions/coach/club/:clubId/training-plan', ctrl.generateTrainingPlan);

// ── 4. Club decisions ──────────────────────────────────────────────────────
router.post('/decisions/club/:clubId/financial-health', ctrl.predictFinancialHealth);
router.post('/decisions/club/:clubId/budget', ctrl.optimizeBudget);
router.post('/decisions/club/:clubId/salary-risk', ctrl.alertSalaryRisk);
router.post('/decisions/club/:clubId/sponsorship', ctrl.recommendSponsorship);
router.post('/decisions/club/:clubId/transfer-market', ctrl.supportTransferMarket);

// ── 5. Franchise decisions ─────────────────────────────────────────────────
router.post('/decisions/franchise/:unitId/expansion', ctrl.recommendRegionalExpansion);
router.post('/decisions/franchise/:unitId/academy-profit', ctrl.predictAcademyProfitability);
router.post('/decisions/franchise/:unitId/territory-risk', ctrl.analyzeTerritoryRisk);
router.post('/decisions/franchise/:unitId/operator-performance', ctrl.scoreOperatorPerf);
router.post('/decisions/franchise/:unitId/investment-score', ctrl.scoreFranchiseInvestmentOpportunity);

// ── 6. Investor decisions ──────────────────────────────────────────────────
router.post('/decisions/investor/:investorId/roi', ctrl.predictInvestorRoi);
router.post('/decisions/investor/:investorId/risk', ctrl.scoreInvestmentRisk);
router.post('/decisions/investor/:investorId/allocation', ctrl.optimizeCapitalAllocation);
router.post('/decisions/entity/:entityId/valuation', ctrl.suggestValuation);
router.post('/decisions/entity/:entityId/acquisition', ctrl.recommendAcquisition);

// ── 7. Executive decisions ─────────────────────────────────────────────────
router.post('/decisions/executive/ceo-brief', ctrl.generateCeoDashboard);
router.post('/decisions/executive/board-strategy', ctrl.generateBoardStrategy);
router.post('/decisions/executive/expansion-rank', ctrl.rankExpansionOpportunities);
router.post('/decisions/executive/market-entry', ctrl.predictMarketEntry);
router.post('/decisions/executive/acquisition-target/:entityId', ctrl.evaluateAcquisitionTarget);

// ── 8. History ─────────────────────────────────────────────────────────────
router.get('/history', ctrl.searchHistory);
router.get('/history/summary', ctrl.summarizeHistory);
router.get('/decisions/:id', ctrl.getDecision);

// ── 9. Review + feedback + outcomes ────────────────────────────────────────
router.post('/decisions/:id/review', ctrl.reviewDecisionHandler);
router.post('/decisions/:id/feedback', ctrl.submitFeedback);
router.post('/decisions/:id/outcome', ctrl.recordOutcome);
router.get('/decisions/:id/feedback', ctrl.listFeedback);

// ── 10. Audit ──────────────────────────────────────────────────────────────
router.get('/audit', ctrl.searchAudit);
router.get('/audit/summary', ctrl.summarizeAudit);

// ── 11. Bootstrap ──────────────────────────────────────────────────────────
router.post('/bootstrap/seed-models', ctrl.seedModels);

export default router;
